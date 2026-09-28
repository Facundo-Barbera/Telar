/**
 * SETTINGS → STORAGE'S AUTOMATIC CLEANUP — `cleanup.ts` and `runCleanup`.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CLEANUP_POLICY } from "@telar/engine-client";
import { isRotated, planWorktreeCleanup, sweepLogs } from "../src/cleanup";
import { EngineStore } from "../src/state";
import { until } from "./wait";
import { worktreeReady } from "./worktree-ready";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the plan asks only what the switches ask, and never twice for a released checkout", () => {
  const now = 40 * DAY;
  const sessions = [
    { sessionId: "old", archived: false, released: false, lastActiveAt: 0 },
    { sessionId: "fresh", archived: false, released: false, lastActiveAt: 39 * DAY },
    { sessionId: "archived", archived: true, released: false, lastActiveAt: 0 },
    { sessionId: "gone", archived: false, released: true, lastActiveAt: 0 },
  ];
  expect(planWorktreeCleanup(sessions, DEFAULT_CLEANUP_POLICY, now)).toEqual([]);
  expect(planWorktreeCleanup(sessions, { ...DEFAULT_CLEANUP_POLICY, inactiveDays: 30 }, now)).toEqual([{ sessionId: "old", reason: "inactive" }]);
  expect(planWorktreeCleanup(sessions, { ...DEFAULT_CLEANUP_POLICY, archived: true, unchanged: true }, now)).toEqual([
    { sessionId: "old", reason: "unchanged" },
    { sessionId: "fresh", reason: "unchanged" },
    { sessionId: "archived", reason: "archived" },
  ]);
});

test("only rotated logs and the given setup logs older than the window are deleted", async () => {
  const directory = tmp("telar-cleanup-logs-");
  const now = Date.now();
  const old = (now - 40 * DAY) / 1000;
  for (const name of ["worker.jsonl", "worker.jsonl.1", "engine.log.2.gz", "notes.txt"]) {
    fs.writeFileSync(path.join(directory, name), "x".repeat(10));
    fs.utimesSync(path.join(directory, name), old, old);
  }
  fs.writeFileSync(path.join(directory, "fresh.log.1"), "new");
  const setupLog = path.join(directory, "setup.log");
  fs.writeFileSync(setupLog, "done");
  fs.utimesSync(setupLog, old, old);

  expect(isRotated("worker.jsonl")).toBe(false);
  const swept = await sweepLogs({ logDirectories: [directory], setupLogs: [setupLog], days: 30, now });
  expect(swept.count).toBe(3);
  expect(fs.readdirSync(directory).sort()).toEqual(["fresh.log.1", "notes.txt", "worker.jsonl"]);
});

async function setup() {
  const origin = tmp("telar-cleanup-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const root = tmp("telar-cleanup-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@telar.local");
  git(root, "config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  let now = Date.now();
  const home = tmp("telar-cleanup-home-");
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, () => now);
  store.registerProject({ id: "project_one", name: "One", root });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_one");
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree");
  const checkout = session.workspace.path;
  git(checkout, "config", "user.email", "test@telar.local");
  git(checkout, "config", "user.name", "Telar Test");
  return { store, root, checkout, branch: session.workspace.branch, advance: (ms: number) => (now += ms) };
}

test("with every switch off, a sweep touches nothing and records an empty result", async () => {
  const { store, checkout, advance } = await setup();
  advance(60 * DAY);
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  expect(store.cleanup.last()).toMatchObject({ released: 0, logs: 0, freedBytes: 0 });
});

test("an inactive session's checkout is released past the window, and the branch survives", async () => {
  const { store, root, checkout, branch, advance } = await setup();
  git(checkout, "push", "-q", "origin", branch);
  store.cleanup.setPolicy({ inactiveDays: 7 });
  advance(3 * DAY);
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  advance(5 * DAY);
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(false);
  expect(git(root, "branch", "--list", branch)).toContain(branch);
  expect(store.cleanup.last()).toMatchObject({ released: 1 });
  const session = store.getSession("session_one");
  expect(session.workspace.mode === "worktree" && session.workspace.released?.reason).toBe("inactive");
});

test("the fixed rules hold whatever the switches say: uncommitted work is skipped", async () => {
  const { store, checkout, advance } = await setup();
  fs.writeFileSync(path.join(checkout, "README.md"), "edited\n");
  store.cleanup.setPolicy({ inactiveDays: 3 });
  advance(10 * DAY);
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  expect(store.cleanup.last()).toMatchObject({ released: 0, skipped: 1 });
});

test("unchanged: an idle session with no commits beyond the default branch is released; one with work is not", async () => {
  const withWork = await setup();
  fs.writeFileSync(path.join(withWork.checkout, "feature.txt"), "work\n");
  git(withWork.checkout, "add", "-A");
  git(withWork.checkout, "commit", "-qm", "feature");
  git(withWork.checkout, "push", "-q", "origin", withWork.branch);
  withWork.store.cleanup.setPolicy({ unchanged: true });
  await withWork.store.runCleanup();
  expect(fs.existsSync(withWork.checkout)).toBe(true);

  const empty = await setup();
  empty.store.cleanup.setPolicy({ unchanged: true });
  await empty.store.runCleanup();
  expect(fs.existsSync(empty.checkout)).toBe(false);
  const session = empty.store.getSession("session_one");
  expect(session.workspace.mode === "worktree" && session.workspace.released?.reason).toBe("unchanged");
});

test("unchanged never releases a session that is not idle", async () => {
  const { store, checkout } = await setup();
  store.submitTurn("session_one", { runId: "run_busy", input: "working" });
  store.cleanup.setPolicy({ unchanged: true });
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  expect(store.cleanup.last()).toMatchObject({ released: 0, skipped: 1 });
});

/** A turn that backgrounds one task and ends, leaving the task in `state`. */
function backgroundTask(store: EngineStore, state: "running" | "waiting", options: { ambient?: boolean } = {}) {
  store.submitTurn("session_one", { runId: "run_bg", input: "Watch the build" });
  const claimed = store.claimNextTurn("worker_one")!;
  const token = claimed.turn.claim!.token;
  store.markRunning("session_one", "run_bg", token);
  store.ingestObservations("session_one", "run_bg", token, [
    { kind: "task.started", task: { id: "task_bg", providerTaskId: "bg1", kind: "background", backgrounded: true, state, title: "Tail the log", ...options } },
  ]);
  store.completeTurn("session_one", "run_bg", token, { text: "Watching" });
}

test("live background work: the sweep leaves a monitoring session's checkout alone, and the reaper counts it live", async () => {
  const { store, checkout, advance } = await setup();
  backgroundTask(store, "running");
  expect(store.getSession("session_one").activity).toBe("monitoring");
  store.cleanup.setPolicy({ unchanged: true, inactiveDays: 7 });
  advance(30 * DAY);
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  expect(store.cleanup.last()).toMatchObject({ released: 0 });
  // Even archived: a shell running in there is using its `node_modules`.
  store.archiveSession("session_one");
  expect(store.reapableWorktrees()).toEqual([expect.objectContaining({ sessionId: "session_one", archived: true, live: true })]);
});

test("paused or ambient background tasks are not live work: the sweep and the reaper may take the checkout", async () => {
  for (const [state, ambient] of [["waiting", false], ["running", true]] as const) {
    const { store, checkout } = await setup();
    backgroundTask(store, state, ambient ? { ambient } : {});
    expect(store.getSession("session_one").activity).toBe("idle");
    expect(store.reapableWorktrees()).toEqual([expect.objectContaining({ sessionId: "session_one", live: false })]);
    store.cleanup.setPolicy({ unchanged: true });
    await store.runCleanup();
    expect(fs.existsSync(checkout), `${state}${ambient ? " ambient" : ""}`).toBe(false);
  }
});

test("an open terminal: the unchanged sweep skips the session's checkout, and the reaper counts it live (#883)", async () => {
  const { store, checkout } = await setup();
  store.attachTerminals({ openCount: (sessionId) => (sessionId === "session_one" ? 1 : 0), openSessions: () => ["session_one"], closeSession: async () => 1 });
  store.cleanup.setPolicy({ unchanged: true });
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);
  expect(store.cleanup.last()).toMatchObject({ released: 0, skipped: 1 });
  expect(store.reapableWorktrees()).toEqual([expect.objectContaining({ sessionId: "session_one", live: true })]);
});

test("archiving keeps the checkout unless the switch is on", async () => {
  const off = await setup();
  off.store.archiveSession("session_one");
  expect(fs.existsSync(off.checkout)).toBe(true);

  const on = await setup();
  on.store.cleanup.setPolicy({ archived: true });
  on.store.archiveSession("session_one");
  await until("the checkout is gone", () => !fs.existsSync(on.checkout));
});

test("a policy outside the offered choices is refused", () => {
  const home = tmp("telar-cleanup-policy-");
  const store = new EngineStore(home, () => 1);
  expect(store.cleanup.setPolicy({ inactiveDays: 5 })).toBeUndefined();
  expect(store.cleanup.setPolicy({ logsDays: 30 })).toEqual({ ...DEFAULT_CLEANUP_POLICY, logsDays: 30 });
});
