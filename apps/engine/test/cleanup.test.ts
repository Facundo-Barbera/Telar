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
  expect(planWorktreeCleanup(sessions, { ...DEFAULT_CLEANUP_POLICY, archived: true, merged: true }, now)).toEqual([
    { sessionId: "old", reason: "merged" },
    { sessionId: "fresh", reason: "merged" },
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

test("merged: a branch whose commits are in the default branch is released; one that did nothing is not", async () => {
  const { store, root, checkout, branch } = await setup();
  store.cleanup.setPolicy({ merged: true });
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(true);

  fs.writeFileSync(path.join(checkout, "feature.txt"), "shipped\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "feature");
  git(checkout, "push", "-q", "origin", branch);
  git(root, "fetch", "-q", "origin");
  git(root, "push", "-q", "origin", `refs/remotes/origin/${branch}:refs/heads/main`);
  git(root, "fetch", "-q", "origin");
  await store.runCleanup();
  expect(fs.existsSync(checkout)).toBe(false);
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
