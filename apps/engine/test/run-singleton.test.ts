/**
 * The rules that make a shared deployment safe: one per project, ownership we
 * can vouch for, and a readiness claim that is actually about our process.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import type { RunConfiguration } from "../src/run/types";

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


const config = (command: string, extra: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_test",
  projectId: "proj_1",
  name: "fixture",
  command,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const input = (tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput => ({
  projectId: "proj_1",
  config: cfg,
  worktreePath: tree,
  ...extra,
});

async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("two sessions pressing play at the same moment produce ONE deployment", async () => {
  const manager = runManager();
  const tree = worktree();

  // Launched together, in the same tick, from two different conversations.
  const results = await Promise.allSettled([
    manager.start(input(tree, config("sleep 30"), { sessionId: "sess_a" })),
    manager.start(input(tree, config("sleep 30"), { sessionId: "sess_b" })),
  ]);

  const started = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  expect(started).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect((refused[0] as PromiseRejectedResult).reason.code).toBe("conflict");
  expect(manager.history("proj_1").filter((run) => run.status !== "failed" && run.status !== "exited")).toHaveLength(1);

  await manager.stop(manager.activeRun("proj_1")!.runId);
}, 15_000);

test("the same run is visible from either session, with the worktree it really used", async () => {
  const manager = runManager();
  const theirTree = worktree();
  const started = await manager.start(input(theirTree, config("sleep 30"), { sessionId: "sess_a" }));

  // A second session reads the project, not its own conversation.
  const seen = manager.activeRun("proj_1")!;
  expect(seen.runId).toBe(started.runId);
  expect(seen.worktreePath).toBe(theirTree);
  expect(seen.startedBySessionId).toBe("sess_a");

  await manager.stop(started.runId);
}, 15_000);

test("a project with a different project's run is unaffected — the slot is per project", async () => {
  const manager = runManager();
  const tree = worktree();
  const first = await manager.start(input(tree, config("sleep 30")));
  const second = await manager.start({ ...input(tree, config("sleep 30")), projectId: "proj_2" });

  expect(manager.activeRun("proj_1")?.runId).toBe(first.runId);
  expect(manager.activeRun("proj_2")?.runId).toBe(second.runId);

  await manager.stop(first.runId);
  await manager.stop(second.runId);
}, 15_000);

test("a run we cannot signal goes unknown, keeps the slot, and is never signalled again", async () => {
  let attempts = 0;
  const manager = runManager({
    kill: () => {
      attempts += 1;
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
  });
  const tree = worktree();
  const run = await manager.start(input(tree, config("sleep 30")));

  await expect(manager.stop(run.runId)).rejects.toThrow(/lost contact/);
  expect(manager.run(run.runId).status).toBe("unknown");
  expect(attempts).toBe(1);

  // The slot is still held: a project whose port may still be taken must not
  // quietly accept a second deployment.
  await expect(manager.start(input(tree, config("sleep 30")))).rejects.toThrow(/lost contact/);
  // And a second stop does not fire another signal into the dark.
  await expect(manager.stop(run.runId)).rejects.toThrow(/lost contact/);
  expect(attempts).toBe(1);

  // Releasing is the explicit way out, and it kills nothing.
  const released = manager.release(run.runId);
  expect(released.status).toBe("unknown");
  expect(attempts).toBe(1);
  const next = await manager.start(input(tree, config("sleep 30")));
  expect(manager.activeRun("proj_1")?.runId).toBe(next.runId);

  // This manager's kill can never reach anything, so tidy up both fixtures
  // directly rather than leaving `sleep 30` behind after the file.
  for (const id of [run.runId, next.runId]) {
    const pid = manager.run(id).pid;
    if (!pid) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}, 15_000);

test("a healthy run cannot be released — releasing is only for the ones we lost", async () => {
  const manager = runManager();
  const run = await manager.start(input(worktree(), config("sleep 30")));
  expect(() => manager.release(run.runId)).toThrow(/only a run Telar has lost contact with/);
  await manager.stop(run.runId);
}, 15_000);

test("readiness is only claimed when the URL was silent before this run started", async () => {
  let answers = false;
  const manager = runManager({ probe: async () => ({ answered: answers, serving: answers }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("sleep 30", { readinessUrl: "http://localhost:65001" })));

  expect(manager.run(run.runId).readiness.kind).toBe("pending");
  expect(manager.run(run.runId).status).toBe("running");

  answers = true;
  expect(await until(() => manager.run(run.runId).status === "ready")).toBe(true);
  expect(manager.run(run.runId).readiness.kind).toBe("ready");

  await manager.stop(run.runId);
}, 15_000);

test("a URL that was ALREADY answering can never make this run ready", async () => {
  // Somebody else's server is on that port. A 200 afterwards proves nothing
  // about the process we just started, so the run says so instead of lying.
  const manager = runManager({ probe: async () => ({ answered: true, serving: true }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("sleep 30", { readinessUrl: "http://localhost:65002" })));

  expect(manager.run(run.runId).readiness.kind).toBe("unattributable");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(manager.run(run.runId).status).toBe("running");
  expect(manager.run(run.runId).readiness.kind).toBe("unattributable");

  await manager.stop(run.runId);
}, 15_000);

test("a run without a readiness check never claims ready, however long it lives", async () => {
  const manager = runManager({ probe: async () => ({ answered: true, serving: true }), readyPollMs: 20 });
  const run = await manager.start(input(worktree(), config("sleep 30")));
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(manager.run(run.runId).status).toBe("running");
  expect(manager.run(run.runId).readiness).toEqual({ kind: "none" });

  await manager.stop(run.runId);
}, 15_000);

test("output is a bounded window, and what it dropped is reported rather than hidden", async () => {
  const manager = runManager();
  const run = await manager.start(input(worktree(), config("i=0; while [ $i -lt 2500 ]; do echo line-$i; i=$((i+1)); done")));

  expect(await until(() => manager.run(run.runId).status === "exited", 20_000)).toBe(true);
  const output = manager.output(run.runId);
  expect(output.lines.length).toBeLessThanOrEqual(2000);
  expect(output.dropped).toBeGreaterThan(0);
  expect(output.lines.at(-1)?.text).toBe("line-2499");
  expect(output.cursor).toBe(output.dropped + output.lines.length);

  // A cursor from a previous read returns only what is newer.
  expect(manager.output(run.runId, output.cursor).lines).toHaveLength(0);
}, 30_000);
