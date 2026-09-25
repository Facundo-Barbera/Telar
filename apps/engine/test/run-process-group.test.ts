/**
 * THE WINDOWS BRANCH, EXERCISED FROM A MAC — which is the only reason the
 * platform and the process group are injected rather than read off
 * `process.platform`.
 *
 * A branch nobody runs is a branch nobody has written. Windows is not packaged
 * today, so every claim here is made the only way it honestly can be from this
 * machine: `processGroupFor` is asserted directly for `win32`, the Windows
 * group is driven with a fake `taskkill`, and that same real Windows group is
 * then put inside a real `RunManager` running the pipe fallback.
 *
 * NO LIVENESS HERE ANY MORE. This file used to pin how an unanswerable group
 * kept a project's slot `unknown`; "Run = a new terminal" removed the slot and
 * the question with it. What is left is how a tree is STOPPED, and the one
 * look a close takes when its leader exits (`emptied`).
 *
 * WHAT THIS FILE CANNOT CLAIM, STATED RATHER THAN IMPLIED: none of it proves
 * `taskkill /T` reaches a grandchild on a real Windows box. It proves that
 * Telar asks for that, and that everything on this side of the system call
 * does what it says.
 *
 * Nothing this file starts outlives it: every run is a `sh` command in a
 * `mkdtemp` worktree, managers are shut down after each test, and the one test
 * that deliberately spawns a NON-detached child kills it through the fake
 * `taskkill`, because a child with no group of its own cannot be cleaned up by
 * one.
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

test("the POSIX group leads its own process group and signals all of it", () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const group = posixProcessGroup((pid, signal) => void sent.push([pid, signal]));

  expect(group.detached).toBe(true);
  group.stop(77, false);
  group.stop(77, true);
  group.stop(77, false, "SIGINT");
  expect(sent).toEqual([
    [-77, "SIGTERM"],
    [-77, "SIGKILL"],
    [-77, "SIGINT"],
  ]);
});

test("a close's one look: ESRCH is the only answer that means the group is empty", () => {
  expect(
    posixProcessGroup(() => {
      throw errno("ESRCH");
    }).emptied(5),
  ).toBe(true);
  // EPERM is a group that exists and is not ours — not empty.
  expect(
    posixProcessGroup(() => {
      throw errno("EPERM");
    }).emptied(5),
  ).toBe(false);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  expect(posixProcessGroup((pid, signal) => void sent.push([pid, signal])).emptied(5)).toBe(false);
  // It is asked with signal 0, which delivers nothing.
  expect(sent).toEqual([[-5, 0]]);
});

/**
 * `liveness` IS NOT A RUN'S QUESTION ANY MORE, but the engine suite's own
 * wrapper (`scripts/test-engine-bounded.mjs`) asks it about the test runner's
 * group after the runner exits — the check that catches a test leaving a
 * process behind. It stays three-valued, and it stays honest.
 */
test("the group can still say what is left of a tree, for the suite's own leak check", () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  expect(posixProcessGroup((pid, signal) => void sent.push([pid, signal])).liveness(77)).toBe("alive");
  expect(sent).toEqual([[-77, 0]]);
  expect(
    posixProcessGroup(() => {
      throw errno("ESRCH");
    }).liveness(5),
  ).toBe("gone");
  // EPERM is a group that exists and is not ours — alive, never gone.
  expect(
    posixProcessGroup(() => {
      throw errno("EPERM");
    }).liveness(5),
  ).toBe("alive");

  // Windows cannot be asked until a forceful taskkill says otherwise, and never
  // about a pid it did not kill.
  const group = windowsProcessGroup(fakeTaskkill(() => ({ status: 0 })).run);
  expect(group.liveness(4242)).toBe("unanswerable");
  group.stop(4242, false);
  expect(group.liveness(4242)).toBe("unanswerable");
  group.stop(4242, true);
  expect(group.liveness(4242)).toBe("gone");
  expect(group.liveness(4243)).toBe("unanswerable");
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
  // Nothing here enumerates a tree, so a close always takes the forceful pass.
  expect(group.emptied(4242)).toBe(false);
});

test("taskkill's not-found exit is reported as ESRCH, which a close reads as 'already stopped'", () => {
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
});

// ── the manager, driven by a Windows-shaped group ──────────────────────────

test("the group decides whether a child leads one, and closing under the Windows group takes the forceful pass", async () => {
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

  // THE OBSERVABLE DIFFERENCE. A detached child leads a group whose id is its
  // pid, so `kill(-pid, 0)` succeeds; this one was spawned with `detached:
  // false` because the injected group says so.
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

  // And a default manager, same command, does lead one.
  const posix = runManager();
  const detached = await posix.start(input(worktree(), config("exec sleep 30")));
  expect(() => process.kill(-detached.pid!, 0)).not.toThrow();
  await posix.close(detached.terminalId, "person");

  const closed = await manager.close(run.terminalId, "person");
  expect(closed.status).toBe("closed");
  expect(closed.closedBy).toBe("person");
  // The polite attempt happened and was allowed to fail; the forceful one did
  // the work — which is the whole reason `/F` is a second call and not the first.
  expect(taskkill.calls.map((call) => call.join(" "))).toEqual([`/PID ${pid} /T`, `/PID ${pid} /T /F`]);
}, 15_000);

test("a run that ends by itself is simply exited — nothing is asked, nothing is signalled, nothing is held", async () => {
  /**
   * THE CASE THAT USED TO HOLD A SLOT. On a platform that cannot enumerate a
   * tree, an ordinary exit went `unknown` and blocked the project until a
   * person released it. Now it is the exit it was.
   */
  let asked = 0;
  const taskkill = fakeTaskkill(() => ({ status: 0 }));
  const group = windowsProcessGroup(taskkill.run);
  const manager = runManager({
    processGroup: {
      ...group,
      emptied: (pid) => {
        asked += 1;
        return group.emptied(pid);
      },
    },
  });
  const tree = worktree();
  const run = await manager.start(input(tree, config("echo done")));
  expect(await until(() => manager.run(run.terminalId).status !== "running")).toBe(true);

  expect(manager.run(run.terminalId).status).toBe("exited");
  expect(taskkill.calls).toEqual([]);
  expect(asked).toBe(0);
  const next = await manager.start(input(tree, config("echo again")));
  expect(next.status).toBe("running");
}, 15_000);
