/**
 * HOW A PROCESS TREE IS STOPPED, WHICH IS NOT THE SAME ON EVERY OPERATING
 * SYSTEM — for the pipe fallback, the one launcher whose processes the engine
 * holds itself. (On the desktop the host holds the terminal and does its own
 * closing; see `apps/desktop/terminal-host.js`.)
 *
 * THIS FILE USED TO ANSWER A SECOND QUESTION, AND NO LONGER DOES. Every exit
 * was followed by "is the GROUP gone?" — `kill(-pid, 0)` on POSIX, nothing on
 * Windows — and survivors kept a project's one deployment slot as `unknown`.
 * "Run = a new terminal" removed the slot and took liveness tracking with it:
 * a terminal owns its process, closing it ends the tree, and nothing asks the
 * kernel about a group outside a close. `emptied` is the one question a run
 * still asks, and it is part of closing. `liveness` stays for the engine
 * suite's own wrapper, which asks it about the test runner — see its note.
 *
 * Windows is not packaged today (`apps/desktop` builds mac only); the branch
 * exists so that when it is, the seam is already here and already tested from
 * a Mac.
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
   * when there was nothing left to stop, which a caller reads as success.
   *
   * `signal` REPLACES THE POLITE ONE, NEVER THE FORCEFUL ONE. A dev server that
   * traps SIGTERM to drain connections needs SIGINT — Ctrl-C semantics — and
   * #890 lets a caller ask for it. The escalation stays SIGKILL whatever was
   * asked for.
   */
  stop(pid: number, force: boolean, signal?: NodeJS.Signals): void;
  /**
   * IS THE GROUP ALREADY EMPTY? Asked ONCE, inside a close, at the moment the
   * leader exits — the same single look the desktop host takes — so a close
   * can finish early without ever signalling a group id it has seen go empty.
   * Never asked on a timer, and never asked outside a close. `false` when the
   * platform cannot tell, which only costs a forceful pass that finds nothing.
   */
  emptied(pid: number): boolean;
  /**
   * IS ANYTHING STILL ALIVE IN THE TREE? NOT ASKED BY RUNS. The run manager
   * stopped asking this with "Run = a new terminal"; its one caller is the
   * engine suite's own wrapper (`scripts/test-engine-bounded.mjs`), which asks
   * once after the test runner exits whether a test left something in its
   * group — a question about the test runner, not about anybody's terminal.
   * Three-valued on purpose: a platform that cannot be asked says so.
   */
  liveness(pid: number): GroupLiveness;
};

/** One signal to a negative pid reaches every descendant. */
export function posixProcessGroup(kill: RunKill): RunProcessGroup {
  const liveness = (pid: number): GroupLiveness => {
    try {
      kill(-pid, 0);
      return "alive";
    } catch (error) {
      // ESRCH is the only answer that means gone. EPERM means it exists and is
      // not ours, which is still very much alive.
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive";
    }
  };
  return {
    detached: true,
    stop(pid, force, signal) {
      kill(-pid, force ? "SIGKILL" : (signal ?? "SIGTERM"));
    },
    emptied: (pid) => liveness(pid) === "gone",
    liveness,
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
 * terminating a shell leaves every server it started running.
 *
 * THE POLITE ATTEMPT IS ALLOWED TO ACHIEVE NOTHING. `taskkill` without `/F`
 * posts `WM_CLOSE`, and a console process with no window to close refuses with
 * a non-zero exit. That is the ordinary case, and the forceful pass is already
 * queued behind the grace period, so only a failing `/F` is reported.
 *
 * A REQUESTED SIGNAL IS IGNORED HERE, AND SAYING SO IS BETTER THAN PRETENDING.
 * There is no SIGINT to send and no handler on the other side to receive one.
 */
export function windowsProcessGroup(taskkill: RunTaskkill = systemTaskkill): RunProcessGroup {
  /**
   * Pids this group force-terminated successfully: `taskkill /T /F` exiting 0
   * is the only evidence this platform produces that a tree is gone. Bounded,
   * because a set that only grows is a leak however slow; forgetting the oldest
   * costs an `unanswerable` where a `gone` was available — the safe direction.
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
      // See above: a polite taskkill failing is the normal case for a console
      // process, and the forceful pass follows it anyway.
      if (!force) return;
      throw new Error(`taskkill could not stop the process tree led by ${pid}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
    },
    // Nothing here enumerates a tree, so the forceful pass always runs; on a
    // tree already gone it is a not-found, which reads as done.
    emptied: () => false,
    liveness: (pid) => (terminated.has(pid) ? "gone" : "unanswerable"),
  };
}

const systemTaskkill: RunTaskkill = (args) => {
  const result = spawnSync("taskkill", [...args], { encoding: "utf8", windowsHide: true });
  // A `taskkill` that could not be launched at all is a failure, not "the tree
  // is gone".
  if (result.error) return { status: 1, stderr: result.error.message };
  return { status: result.status, stderr: result.stderr ?? "" };
};

/** The group implementation this platform gets, with POSIX as the default. */
export function processGroupFor(platform: NodeJS.Platform, kill: RunKill): RunProcessGroup {
  return platform === "win32" ? windowsProcessGroup() : posixProcessGroup(kill);
}
