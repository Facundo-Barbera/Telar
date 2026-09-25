/**
 * A DIFF WITH A RIGHT-HAND SIDE — issue #741, at the store.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Every comparison this engine could express was one ref against the WORKING
 * TREE. A turn is a RANGE — where the repository stood when it started, where
 * it stood when it ended — and the answer to it must not move when somebody
 * saves a file afterwards. That is the property under test here, and it is the
 * reason the fixture writes to the disk AFTER the range has closed.
 *
 * A FILE OF ITS OWN, for `diff-base.test.ts`'s reason: a real worktree and real
 * commits are the most expensive thing a test in this suite can do.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { worktreeReady } from "./worktree-ready";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const engineHome = (prefix: string): string => {
  const directory = tmp(prefix);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repo(): string {
  const root = tmp("telar-741-range-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

test("a range answers about two commits, and the working tree cannot change it (#741)", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-741-range-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_cut");

  const workspace = store.getSession("session_cut").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  const checkout = workspace.path;
  const sha = (...args: string[]): string => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();

  const before = sha("rev-parse", "HEAD");
  fs.writeFileSync(path.join(checkout, "inside.ts"), "export const a = 1;\n");
  await store.commitSessionWork("session_cut", "inside the range");
  const after = sha("rev-parse", "HEAD");
  expect(after).not.toBe(before);

  // ...and then the world moves on, which is exactly what a range must ignore.
  fs.writeFileSync(path.join(checkout, "outside.ts"), "export const b = 2;\n");
  await store.commitSessionWork("session_cut", "after the range closed");
  fs.writeFileSync(path.join(checkout, "dirty.ts"), "export const c = 3;\n");

  const ranged = await store.sessionDiffAsync("session_cut", { base: before, to: after });
  expect(ranged.files.map((file) => file.path)).toEqual(["inside.ts"]);
  // THE ASSERTION THAT IS NOT VACUOUS: the same session read WITHOUT a right
  // hand side sees all three, so "one file" is a property of the range rather
  // than of the fixture.
  const open = await store.sessionDiffAsync("session_cut", { base: before });
  expect(open.files.map((file) => file.path).sort()).toEqual(["dirty.ts", "inside.ts", "outside.ts"]);
});

test("an untracked file is in no commit, so it is in no range (#741)", async () => {
  /**
   * THE LINE THIS TEST EXISTS FOR. The review's file list is three reads and
   * one of them is `status --porcelain -uall`. Carrying it into a range would
   * put a file nobody has committed — possibly written long after the turn
   * ended — under a heading that says what that turn did. #690's defect by a
   * third door.
   */
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-741-range-untracked-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_cut");

  const workspace = store.getSession("session_cut").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  const checkout = workspace.path;
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(checkout, "committed.ts"), "export const a = 1;\n");
  await store.commitSessionWork("session_cut", "one commit");
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(checkout, "never-committed.ts"), "export const d = 4;\n");

  const ranged = await store.sessionDiffAsync("session_cut", { base: before, to: after });
  expect(ranged.files.map((file) => file.path)).toEqual(["committed.ts"]);
  // ...and the absence is not a read that failed, which would put a warning
  // band over an answer that is complete.
  expect(ranged.filesIncomplete).toBeUndefined();

  // The negative: without the range, the untracked file is exactly what the
  // working-tree read is FOR.
  const open = await store.sessionDiffAsync("session_cut", { base: null });
  expect(open.files.map((file) => file.path)).toEqual(["never-committed.ts"]);
});

test("a row's patch over a range is the range's patch (#741)", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-741-range-patch-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await worktreeReady(store, "session_cut");

  const workspace = store.getSession("session_cut").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  const checkout = workspace.path;
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(checkout, "moving.ts"), "export const inRange = 1;\n");
  await store.commitSessionWork("session_cut", "in range");
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();

  // Changed again afterwards, on the disk. A patch read against the working
  // tree would show this; the range must not.
  fs.writeFileSync(path.join(checkout, "moving.ts"), "export const afterwards = 99;\n");

  const ranged = await store.sessionFilePatchAsync("session_cut", "moving.ts", { base: before, to: after });
  expect(ranged.patch).toContain("+export const inRange = 1;");
  expect(ranged.patch).not.toContain("afterwards");

  const open = await store.sessionFilePatchAsync("session_cut", "moving.ts", { base: before });
  expect(open.patch).toContain("afterwards");
});
