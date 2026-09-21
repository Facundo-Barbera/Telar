/**
 * Real processes, in temp directories, and nothing of the user's is touched:
 * every fixture here is a `sh` command in a `mkdtemp` worktree, and every
 * process this file starts is stopped by the assertion that follows it.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import type { RunConfiguration, RunEnvVar } from "../src/run/types";

const worktree = () => track(fs.mkdtempSync(path.join(os.tmpdir(), "telar-run-tree-")));

const track = (dir: string): string => (tempDirs.push(dir), dir);
/**
 * NOTHING THIS FILE STARTS OUTLIVES IT, and nothing it writes stays on disk.
 * Every run here is a real process in a real temp directory: a test that fails
 * midway used to leave a `sleep` holding a process group and a directory in
 * `/tmp`, so the next reader of a failure was also debugging the litter from
 * the last one. Managers are shut down after each test and the directories go
 * at the end — after, not during, because a manager still draining a group
 * needs its cwd to exist.
 */
const managers: RunManager[] = [];
const tempDirs: string[] = [];

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
  return {
    id: "runcfg_test",
    projectId: "proj_1",
    name: "fixture",
    command,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function input(tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput {
  return { projectId: "proj_1", config: cfg, worktreePath: tree, sessionId: "sess_a", ...extra };
}

/**
 * THE BUDGET MUST FIT UNDER THIS FILE'S OWN CEILING (#706).
 *
 * It was 15 s, while three tests below cap themselves at 10 s and five more at
 * 15 s. A wait that outlives the ceiling it runs under cannot fail cleanly:
 * bun kills the test first, the assertion resolves into a dead test, and the
 * run reports `this test timed out` with the real reason — a predicate that
 * never came true — thrown away as an unhandled error between tests. That is
 * what #706 was seeing, and it reproduced on two of three full-suite runs.
 *
 * Six seconds is not a number picked to make this pass; it is what every
 * sibling already uses — `run-durability` and `run-integration` are both 6 s,
 * `run-singleton` 4 s — against the same kind of child process. This file was
 * the outlier.
 */
async function until(predicate: () => boolean, ms = 6_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a watcher is told every transition, with the whole view and who holds the slot", async () => {
  /**
   * #890: the cockpit stopped polling `/run/status`, so every state a person
   * can see has to ARRIVE. Two properties are worth pinning. The frame carries
   * the WHOLE view, because there is no journal to page back to. And `active`
   * is the engine's own answer rather than something a reader guesses from the
   * status — a released run stays `unknown` with the slot free, so a reader
   * that inferred "not terminal, therefore deployed" would show a ghost.
   */
  const manager = runManager();
  const seen: Array<{ status: string; active: boolean; runId: string }> = [];
  const stop = manager.watch((event) => {
    expect(event.type).toBe("run.status");
    expect(event.projectId).toBe("proj_1");
    seen.push({ status: event.run.status, active: event.active, runId: event.run.runId });
  });

  const tree = worktree();
  const started = await manager.start(input(tree, config("exit 0")));
  expect(await until(() => seen.some((frame) => frame.status === "exited"))).toBe(true);

  // `starting` is announced too: the slot is held from that moment, and a
  // surface that waited for `running` would show nothing across the spawn.
  expect(seen[0]).toEqual({ status: "starting", active: true, runId: started.runId });
  const last = seen[seen.length - 1]!;
  expect(last.status).toBe("exited");
  // The slot is free the moment the run is terminal, and the frame says so.
  expect(last.active).toBe(false);

  // Unsubscribing is real: a panel that closed must stop costing transitions.
  stop();
  const before = seen.length;
  await manager.start(input(tree, config("exit 0", { id: "runcfg_two" })));
  expect(seen.length).toBe(before);
});

test("a run lands in the configured directory with the configured environment, and its output is kept after it exits", async () => {
  const tree = worktree();
  fs.mkdirSync(path.join(tree, "apps", "web"), { recursive: true });
  const manager = runManager();

  const started = await manager.start(
    input(tree, config('pwd; echo "greeting=$GREETING"', { cwd: "apps/web", env: [{ key: "GREETING", value: "hello" }] })),
  );
  expect(started.cwd).toBe(path.join(tree, "apps", "web"));
  expect(started.worktreePath).toBe(tree);
  expect(started.startedBySessionId).toBe("sess_a");

  expect(await until(() => manager.run(started.runId).status === "exited")).toBe(true);
  const finished = manager.run(started.runId);
  expect(finished.exitCode).toBe(0);

  // Output survives the process: reading it is most of the point of a run.
  const output = manager.output(started.runId);
  const text = output.lines.map((line) => line.text).join("\n");
  expect(text).toContain("greeting=hello");
  expect(fs.realpathSync(text.split("\n")[0]!)).toBe(fs.realpathSync(path.join(tree, "apps", "web")));
  expect(output.cursor).toBe(output.lines.length);
}, 10_000);

test("a non-zero exit is a failure, with the code kept", async () => {
  const manager = runManager();
  const run = await manager.start(input(worktree(), config("echo nope >&2; exit 3")));
  expect(await until(() => manager.run(run.runId).status === "failed")).toBe(true);
  const finished = manager.run(run.runId);
  expect(finished.exitCode).toBe(3);
  expect(manager.output(run.runId).lines.some((line) => line.stream === "stderr" && line.text === "nope")).toBe(true);
}, 10_000);

test("a secret env value reaches the process but never the captured output or the view", async () => {
  const manager = runManager();
  const secret: RunEnvVar = { key: "TOKEN", value: "sk_live_do_not_print", secret: true };
  const run = await manager.start(input(worktree(), config('echo "token is $TOKEN"', { env: [secret] })));

  expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
  const text = manager.output(run.runId).lines.map((line) => line.text).join("\n");
  expect(text).toContain("token is «redacted»");
  expect(text).not.toContain("sk_live_do_not_print");
  expect(JSON.stringify(manager.run(run.runId))).not.toContain("sk_live_do_not_print");
}, 10_000);

test("a working directory outside the worktree, or one that does not exist, is refused before anything spawns", async () => {
  const manager = runManager();
  const tree = worktree();
  await expect(manager.start(input(tree, config("ls", { cwd: "../.." })))).rejects.toThrow(/outside the worktree/);
  await expect(manager.start(input(tree, config("ls", { cwd: "nope" })))).rejects.toThrow(/no directory/);
  // A refused start leaves no reservation behind.
  expect(manager.activeRun("proj_1")).toBeUndefined();
});

test("stop takes the whole process group, so a background child does not survive it", async () => {
  const tree = worktree();
  const manager = runManager();
  const run = await manager.start(input(tree, config("sleep 30 & echo $! > child.pid; wait")));

  const pidFile = path.join(tree, "child.pid");
  expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0)).toBe(true);
  const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  expect(alive(childPid)).toBe(true);

  const stopped = await manager.stop(run.runId);
  expect(["exited", "failed"]).toContain(stopped.status);
  expect(await until(() => !alive(childPid))).toBe(true);
  // The slot is free again once the run is genuinely over.
  expect(manager.activeRun("proj_1")).toBeUndefined();
}, 15_000);

test("a shell that ignores SIGTERM and keeps working is killed outright, and the run still ends", async () => {
  const manager = runManager({ stopGraceMs: 500 });
  // The trap survives the group's SIGTERM and the loop restarts its sleep, so
  // only the escalation to SIGKILL can end this one.
  const run = await manager.start(input(worktree(), config("trap '' TERM; echo trapped; while :; do sleep 1; done")));
  // Wait for the trap to actually be installed — signalling before that would
  // test the default disposition instead of the escalation.
  expect(await until(() => manager.output(run.runId).lines.some((line) => line.text === "trapped"))).toBe(true);

  const before = Date.now();
  const stopped = await manager.stop(run.runId);
  expect(Date.now() - before).toBeGreaterThanOrEqual(500);
  expect(["exited", "failed"]).toContain(stopped.status);
  expect(stopped.signal).toBe("SIGKILL");
  expect(manager.activeRun("proj_1")).toBeUndefined();
}, 15_000);

test("restart replaces the process but keeps the recipe, the worktree and the slot", async () => {
  const tree = worktree();
  const manager = runManager();
  const first = await manager.start(input(tree, config("sleep 30")));
  const second = await manager.restart(first.runId);

  expect(second.runId).not.toBe(first.runId);
  expect(second.command).toBe("sleep 30");
  expect(second.worktreePath).toBe(tree);
  expect(manager.activeRun("proj_1")?.runId).toBe(second.runId);
  expect(["exited", "failed"]).toContain(manager.run(first.runId).status);

  await manager.stop(second.runId);
}, 15_000);

test("nothing slips into the slot while a restart is between stop and start", async () => {
  const tree = worktree();
  const manager = runManager();
  const first = await manager.start(input(tree, config("sleep 30")));

  const restarting = manager.restart(first.runId);
  // Synchronously after restart begins, the project is mid-transition.
  await expect(manager.start(input(tree, config("sleep 30")))).rejects.toThrow(/being replaced/);
  const second = await restarting;

  expect(manager.activeRun("proj_1")?.runId).toBe(second.runId);
  await manager.stop(second.runId);
}, 15_000);

test("replace is the deliberate takeover: it stops the live run and launches on this worktree", async () => {
  const manager = runManager();
  const theirs = worktree();
  const mine = worktree();
  const first = await manager.start(input(theirs, config("sleep 30")));

  // Plain start refuses and names what is running and from where.
  await expect(manager.start(input(mine, config("sleep 30")))).rejects.toThrow(new RegExp(theirs.replace(/[/\\]/g, "\\$&")));

  const second = await manager.replace(input(mine, config("sleep 30")));
  expect(second.worktreePath).toBe(mine);
  expect(["exited", "failed"]).toContain(manager.run(first.runId).status);
  await manager.stop(second.runId);
}, 15_000);

test("shutdown stops what it started rather than leaving orphans no daemon could adopt", async () => {
  const manager = runManager();
  const run = await manager.start(input(worktree(), config("sleep 30")));
  const pid = manager.run(run.runId).pid!;
  expect(alive(pid)).toBe(true);

  await manager.shutdown();
  expect(await until(() => !alive(pid))).toBe(true);
  expect(manager.activeRun("proj_1")).toBeUndefined();
}, 15_000);
