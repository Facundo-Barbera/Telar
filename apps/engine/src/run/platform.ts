/**
 * THE TWO THINGS ABOUT A PROCESS TREE THAT ARE NOT THE SAME ON EVERY OPERATING
 * SYSTEM — how you stop one, and whether you may ask if it is gone.
 *
 * The manager's whole singleton argument rests on a question it asks the kernel:
 * `bun run dev &` exits 0 with a server still alive behind it, so every exit is
 * followed by "is the GROUP gone?", and a group with survivors keeps the
 * project's slot rather than reporting a clean exit. On POSIX that question is
 * `kill(-pid, 0)`. Windows has no process group to signal and no such question
 * to ask, so the two platforms do not merely differ in syntax: one of them
 * cannot answer at all.
 *
 * SO THE ANSWER TYPE HAS THREE VALUES AND NOT TWO. `unanswerable` is a real
 * answer, distinct from `gone`, and the manager treats it the way it treats
 * survivors: the run becomes `unknown` and KEEPS THE SLOT. That is deliberately
 * the pessimistic direction — a dev server we cannot account for is exactly the
 * thing the singleton exists to stop colliding with. A platform that cannot
 * answer must say so; it must never say `gone` because it would like to.
 *
 * WHAT THAT COSTS ON WINDOWS, SAID PLAINLY. A run that ends by itself settles
 * `unknown` there, because nothing short of a Job Object can enumerate the tree
 * a shell left behind, and a Job Object needs native code this milestone does
 * not have. A run stopped THROUGH TELAR settles cleanly, because `taskkill /T
 * /F` reporting success is itself the evidence the tree is gone — see
 * `windowsProcessGroup`. Windows is not packaged today (`apps/desktop` builds
 * mac only); this file exists so that when it is, the seam is already here and
 * already tested from a Mac.
 */

import { spawnSync } from "node:child_process";

/** How a signal actually reaches a pid. Injected so a test can make one fail. */
export type RunKill = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * What is left of a process tree.
 *
 *   alive         something in it answered
 *   gone          nothing is left, and we know that
 *   unanswerable  THIS PLATFORM CANNOT BE ASKED. Never a synonym for `gone`.
 */
export type GroupLiveness = "alive" | "gone" | "unanswerable";

export type RunProcessGroup = {
  /**
   * Spawn the shell as its own group leader? POSIX: yes, so one signal reaches
   * the `bun`/`node`/`vite` descendants a bare `kill(pid)` would strand.
   * Windows: there is nothing to lead, and `detached` there only means "new
   * console", which is not what we want for a captured-output run.
   */
  readonly detached: boolean;
  /**
   * Stop the whole tree led by `pid`. `force` is the second, impolite attempt.
   * Throws the way `process.kill` does — in particular with `code: "ESRCH"`
   * when there was nothing left to stop, which the manager reads as success.
   *
   * `signal` REPLACES THE POLITE ONE, NEVER THE FORCEFUL ONE. A dev server that
   * traps SIGTERM to drain connections needs SIGINT — Ctrl-C semantics — and
   * #890 lets a caller ask for it. The escalation stays SIGKILL whatever was
   * asked for: a stop that cannot be refused is the point of having a second
   * attempt at all.
   */
  stop(pid: number, force: boolean, signal?: NodeJS.Signals): void;
  /** Is anything still alive in the tree led by `pid`? */
  liveness(pid: number): GroupLiveness;
};

/**
 * One signal to a negative pid reaches every descendant, and signal `0` asks
 * without touching anything. Both go through the injected `kill` so a test can
 * make a stale pid behave like one.
 */
export function posixProcessGroup(kill: RunKill): RunProcessGroup {
  return {
    detached: true,
    stop(pid, force, signal) {
      kill(-pid, force ? "SIGKILL" : (signal ?? "SIGTERM"));
    },
    liveness(pid) {
      try {
        kill(-pid, 0);
        return "alive";
      } catch (error) {
        // ESRCH is the only answer that means "gone". EPERM means it exists and
        // is not ours, which is still very much alive.
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive";
      }
    },
  };
}

/** What `taskkill` reported. Injected so the win32 path is testable from a Mac. */
export type RunTaskkill = (args: readonly string[]) => { status: number | null; stderr: string };

/**
 * `taskkill` says this when the pid is not there. It is the one non-zero exit
 * that means the caller got what it wanted.
 */
const TASKKILL_NOT_FOUND = 128;

/**
 * Windows, where stopping a tree is a command rather than a signal.
 *
 * `/T` IS THE ENTIRE POINT. Without it — and `child.kill()` is without it —
 * terminating a shell leaves every server it started running, which is the
 * orphaning bug this file exists to close.
 *
 * THE POLITE ATTEMPT IS ALLOWED TO ACHIEVE NOTHING. `taskkill` without `/F`
 * posts `WM_CLOSE`, and a console process with no window to close refuses with
 * a non-zero exit. That is not a failure worth marking a run `unknown` over: it
 * is the ordinary case, and the forceful pass is already queued behind the
 * grace period. So only a failing `/F` is reported as a failure.
 *
 * A FORCEFUL KILL THAT SUCCEEDED IS EVIDENCE, AND IT IS THE ONLY EVIDENCE THIS
 * PLATFORM PRODUCES. `taskkill /T /F` exiting 0 means the tree was terminated,
 * so `liveness` may answer `gone` for that pid — and only for that pid. Every
 * other pid stays `unanswerable`, because nothing here enumerates a tree.
 *
 * A REQUESTED SIGNAL IS IGNORED HERE, AND SAYING SO IS BETTER THAN PRETENDING.
 * `taskkill` posts `WM_CLOSE` or terminates; there is no SIGINT to send and no
 * handler on the other side to receive one. A caller that asked for one gets
 * this platform's polite attempt, which is the nearest true thing.
 */
export function windowsProcessGroup(taskkill: RunTaskkill = systemTaskkill): RunProcessGroup {
  /**
   * Pids this group force-terminated successfully. Bounded because a manager
   * outlives many runs and a set that only grows is a leak, however slow; the
   * oldest entry being forgotten costs an `unanswerable` where a `gone` was
   * available, which is the safe direction.
   */
  const terminated = new Set<number>();
  const remember = (pid: number) => {
    if (terminated.size >= 256) terminated.delete(terminated.values().next().value!);
    terminated.add(pid);
  };
  return {
    detached: false,
    stop(pid, force) {
      const result = taskkill(force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"]);
      if (result.status === 0) {
        if (force) remember(pid);
        return;
      }
      if (result.status === TASKKILL_NOT_FOUND) {
        const gone = new Error(`there is no process ${pid} to stop`) as NodeJS.ErrnoException;
        gone.code = "ESRCH";
        throw gone;
      }
      // See the header: a polite taskkill failing is the normal case for a
      // console process, and the forceful pass follows it anyway.
      if (!force) return;
      throw new Error(`taskkill could not stop the process tree led by ${pid}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
    },
    liveness(pid) {
      return terminated.has(pid) ? "gone" : "unanswerable";
    },
  };
}

const systemTaskkill: RunTaskkill = (args) => {
  const result = spawnSync("taskkill", [...args], { encoding: "utf8", windowsHide: true });
  // A `taskkill` that could not be launched at all is not "the tree is gone":
  // report it as a failure so the caller marks the run unknown rather than
  // freeing a slot on the strength of a missing binary.
  if (result.error) return { status: 1, stderr: result.error.message };
  return { status: result.status, stderr: result.stderr ?? "" };
};

/** The group implementation this platform gets, with POSIX as the default. */
export function processGroupFor(platform: NodeJS.Platform, kill: RunKill): RunProcessGroup {
  return platform === "win32" ? windowsProcessGroup() : posixProcessGroup(kill);
}
