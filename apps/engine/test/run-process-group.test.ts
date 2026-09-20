/**
 * THE WINDOWS BRANCH, EXERCISED FROM A MAC — which is the only reason the
 * platform and the process group are injected rather than read off
 * `process.platform`.
 *
 * A branch nobody runs is a branch nobody has written. Windows is not packaged
 * today, so every claim here is made the only way it honestly can be from this
 * machine: `processGroupFor` is asserted directly for `win32`, the Windows
 * group is driven with a fake `taskkill`, and that same real Windows group is
 * then put inside a real `RunManager` so the manager's own
 * unanswerable-group path runs against a real child process.
 *
 * WHAT THIS FILE CANNOT CLAIM, STATED RATHER THAN IMPLIED: none of it proves
 * `taskkill /T` reaches a grandchild on a real Windows box. It proves that
 * Telar asks for that, and that everything on this side of the system call
 * does what it says.
 *
 * Nothing this file starts outlives it: every run is a `sh` command in a
 * `mkdtemp` worktree, managers are shut down after each test, and the one test
 * that deliberately spawns a NON-detached child kills it by pid in the test
 * itself, because a child with no group of its own cannot be cleaned up by one.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { posixProcessGroup, processGroupFor, type RunTaskkill, windowsProcessGroup } from "../src/run/platform";
import type { RunConfiguration } from "../src/run/types";

const managers: RunManager[] = [];
const tempDirs: string[] = [];

const track = (dir: string): string => (tempDirs.push(dir), dir);
const worktree = () => track(fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-group-")));

function runManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(command: string, extra: Partial<RunConfiguration> = {}): RunConfiguration {
  return { id: "runcfg_test", projectId: "proj_1", name: "fixture", command, createdAt: 1, updatedAt: 1, ...extra };
}

function input(tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput {
  return { projectId: "proj_1", config: cfg, worktreePath: tree, sessionId: "sess_a", ...extra };
}

/** Matches this file's own ceiling; see `run-manager.test.ts` for why. */
async function until(predicate: () => boolean, ms = 6_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

// ── the POSIX group ────────────────────────────────────────────────────────

test("the POSIX group leads its own process group and asks about it with signal 0", () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const group = posixProcessGroup((pid, signal) => void sent.push([pid, signal]));

  expect(group.detached).toBe(true);
  group.stop(77, false);
  group.stop(77, true);
  expect(sent).toEqual([
    [-77, "SIGTERM"],
    [-77, "SIGKILL"],
  ]);

  expect(group.liveness(77)).toBe("alive");
  expect(sent.at(-1)).toEqual([-77, 0]);
});

test("ESRCH is the only POSIX answer that means gone — EPERM is a group that exists and is not ours", () => {
  expect(
    posixProcessGroup(() => {
      throw errno("ESRCH");
    }).liveness(5),
  ).toBe("gone");
  expect(
    posixProcessGroup(() => {
      throw errno("EPERM");
    }).liveness(5),
  ).toBe("alive");
});

// ── the Windows group ──────────────────────────────────────────────────────

/** A `taskkill` that records its argv and answers however the test wants. */
function fakeTaskkill(answer: (args: readonly string[]) => { status: number | null; stderr?: string }) {
  const calls: string[][] = [];
  const run: RunTaskkill = (args) => {
    calls.push([...args]);
    const result = answer(args);
    return { status: result.status, stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

test("Windows stops a tree with taskkill /T — the flag without which a shell's children are orphaned", () => {
  const taskkill = fakeTaskkill(() => ({ status: 0 }));
  const group = windowsProcessGroup(taskkill.run);

  expect(group.detached).toBe(false);
  group.stop(4242, false);
  group.stop(4242, true);
  expect(taskkill.calls).toEqual([
    ["/PID", "4242", "/T"],
    ["/PID", "4242", "/T", "/F"],
  ]);
});

test("a Windows tree is unanswerable until a forceful taskkill says otherwise, and never for a pid it did not kill", () => {
  const taskkill = fakeTaskkill(() => ({ status: 0 }));
  const group = windowsProcessGroup(taskkill.run);

  expect(group.liveness(4242)).toBe("unanswerable");
  // A polite taskkill is not evidence: it may have posted WM_CLOSE to nothing.
  group.stop(4242, false);
  expect(group.liveness(4242)).toBe("unanswerable");
  // A forceful one that exited 0 is.
  group.stop(4242, true);
  expect(group.liveness(4242)).toBe("gone");
  expect(group.liveness(4243)).toBe("unanswerable");
});

test("taskkill's not-found exit is reported as ESRCH, which the manager reads as 'already stopped'", () => {
  const group = windowsProcessGroup(fakeTaskkill(() => ({ status: 128 })).run);
  expect(() => group.stop(9, true)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

test("a polite taskkill that fails is the ordinary console-process case and is not an error; a forceful one that fails is", () => {
  const group = windowsProcessGroup(fakeTaskkill(() => ({ status: 1, stderr: "can only be terminated forcefully" })).run);
  expect(() => group.stop(9, false)).not.toThrow();
  expect(() => group.stop(9, true)).toThrow(/taskkill could not stop the process tree led by 9/);
});

test("the platform picks the group, and win32 picks the one that does not lead a process group", () => {
  const noop = () => {};
  expect(processGroupFor("win32", noop).detached).toBe(false);
  expect(processGroupFor("darwin", noop).detached).toBe(true);
  expect(processGroupFor("linux", noop).detached).toBe(true);
  // The win32 one answers the group question the only honest way it can.
  expect(processGroupFor("win32", noop).liveness(1)).toBe("unanswerable");
  // And the POSIX one really does ask, through the injected kill.
  let asked = 0;
  processGroupFor("linux", () => void (asked += 1)).liveness(1);
  expect(asked).toBe(1);
});

// ── the manager, driven by a Windows-shaped group ──────────────────────────

test("the group decides whether a child leads one: under the Windows group the child has no group of its own", async () => {
  const taskkill = fakeTaskkill((args) => {
    const pid = Number(args[args.indexOf("/PID") + 1]);
    if (!args.includes("/F")) return { status: 1, stderr: "can only be terminated forcefully" };
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    return { status: 0 };
  });
  const manager = runManager({ processGroup: windowsProcessGroup(taskkill.run), stopGraceMs: 200 });
  // `exec` so the shell BECOMES the sleep rather than fathering one: a
  // non-detached child cannot be cleaned up by group, so there must be one pid.
  const run = await manager.start(input(worktree(), config("exec sleep 30")));
  const pid = run.pid!;
  expect(pid).toBeGreaterThan(0);

  // THE OBSERVABLE DIFFERENCE, AND IT IS NOT A STRING BOTH STATES EMIT. A
  // detached child leads a group whose id is its pid, so `kill(-pid, 0)`
  // succeeds; this one was spawned with `detached: false` because the injected
  // group says so, and `-pid` is therefore not a process group at all.
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

  // And a default manager, same command, does lead one.
  const posix = runManager();
  const detached = await posix.start(input(worktree(), config("exec sleep 30")));
  expect(() => process.kill(-detached.pid!, 0)).not.toThrow();
  await posix.stop(detached.runId);

  const stopped = await manager.stop(run.runId);
  expect(stopped.status).toBe("exited");
  // The polite attempt happened and was allowed to fail; the forceful one did
  // the work — which is the whole reason `/F` is a second call and not the first.
  expect(taskkill.calls.map((call) => call.join(" "))).toEqual([`/PID ${pid} /T`, `/PID ${pid} /T /F`]);
}, 15_000);

test("a run that ends by itself where the group cannot be asked goes unknown and KEEPS the slot", async () => {
  const taskkill = fakeTaskkill(() => ({ status: 0 }));
  const manager = runManager({ processGroup: windowsProcessGroup(taskkill.run) });
  const tree = worktree();

  // Exits on its own, so nothing is left behind by this test whatever happens.
  const run = await manager.start(input(tree, config("echo done")));
  expect(await until(() => manager.run(run.runId).status !== "running")).toBe(true);

  const settled = manager.run(run.runId);
  expect(settled.status).toBe("unknown");
  expect(settled.error).toMatch(/cannot ask whether the processes it started went with it/);
  // Nothing was signalled on the way: an exit is not a reason to shoot.
  expect(taskkill.calls).toEqual([]);

  // The slot is the point. A platform that cannot account for a dev server must
  // not hand the next launch a port that may still be taken.
  await expect(manager.start(input(tree, config("echo again")))).rejects.toThrow(/lost contact/);
  manager.release(run.runId);
  const next = await manager.start(input(tree, config("echo again")));
  expect(manager.activeRun("proj_1")?.runId).toBe(next.runId);
  expect(await until(() => manager.run(next.runId).status !== "running")).toBe(true);
  manager.release(next.runId);
}, 15_000);

test("an unanswerable group is not polled for the drain window — a question nobody can answer is asked once", async () => {
  let asked = 0;
  const manager = runManager({
    processGroup: {
      detached: false,
      stop: () => {},
      liveness: () => {
        asked += 1;
        return "unanswerable";
      },
    },
    // A drain window long enough that polling it would be many calls, not one.
    groupDrainMs: 5_000,
  });
  const run = await manager.start(input(worktree(), config("echo done")));
  expect(await until(() => manager.run(run.runId).status === "unknown")).toBe(true);
  /**
   * THE COUNT IS THE PROOF, NOT THE CLOCK. An elapsed-time assertion would say
   * the same thing and would also fail on a loaded machine for a reason that
   * has nothing to do with this code; one call is a number the polling
   * behaviour cannot produce, at any speed.
   */
  expect(asked).toBe(1);
  manager.release(run.runId);
}, 15_000);
