/**
 * WHAT A DIFF IS COMPARED AGAINST — issue #694's scope selector, at the store.
 *
 * A FILE OF ITS OWN, and that is not filing tidiness. This cuts a worktree and
 * makes a commit, which is the most expensive thing a test in this suite can
 * do; `worktree.test.ts` — where it started — also holds the git POOL tests,
 * whose budgets are 250ms and 50ms of wall clock. Adding this beside them made
 * `async git pool expires queued reads` fail under the full `verify` gate and
 * pass when the engine suite ran alone: a test correct in isolation, wrong in
 * composition, which is the same shape as the bug it was written to cover.
 * The pool tests own that file's timing; this owns its own.
 *
 * THE THREE STATES OF `base` ARE THE POINT. A request that sends NO base means
 * "use the one on file", so "show me the working tree" has to be expressible as
 * something else — `null` — or the surface's new default would quietly return
 * the session's own comparison and look entirely plausible doing it. That is
 * #690's bug arriving by a different door, which is what makes this worth a
 * checkout and a commit rather than a fixture.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

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

/** A throwaway repository with one commit, so `HEAD` resolves. */
function repo(): string {
  const root = tmp("telar-diff-base-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

/** Wait for the background cut — the row is what a client reads. */
async function settled(store: EngineStore, sessionId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (store.getSession(sessionId).preparation?.state !== "preparing") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`worktree for ${sessionId} never finished preparing`);
}

test("a diff can be asked for a base other than the session's own, or for none at all (#694)", async () => {
  const projectRoot = repo();
  const store = new EngineStore(engineHome("telar-diff-base-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_cut", projectId: "project_one", envMode: "worktree" });
  await settled(store, "session_cut");

  const workspace = store.getSession("session_cut").workspace;
  if (workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  const checkout = workspace.path;

  // A commit the session made, so `base…worktree` and `HEAD…worktree` differ:
  // the first contains this file and the second does not.
  fs.writeFileSync(path.join(checkout, "committed.ts"), "export const a = 1;\n");
  store.commitSessionWork("session_cut", "add a file");
  // ...and something uncommitted, which both comparisons must see.
  fs.writeFileSync(path.join(checkout, "dirty.ts"), "export const b = 2;\n");

  // ABSENT keeps the recorded base — what every caller meant before this
  // existed, and still gets without asking.
  const own = await store.sessionDiffAsync("session_cut");
  expect(own.files.map((entry) => entry.path).sort()).toEqual(["committed.ts", "dirty.ts"]);
  expect(own.base).toBeDefined();

  // `null` DROPS IT: the working tree only. The new default, and the question
  // whose honest answer is the same in a shared checkout.
  const tree = await store.sessionDiffAsync("session_cut", { base: null });
  expect(tree.files.map((entry) => entry.path)).toEqual(["dirty.ts"]);
  expect(tree.base).toBeUndefined();

  // A NAMED BASE replaces the recorded one. Asking for HEAD happens to be the
  // same comparison as dropping it — which is exactly why `null` is not
  // spelled "HEAD" on the wire: a reader who chooses HEAD deliberately must
  // still be distinguishable from one who chose no base at all.
  expect((await store.sessionDiffAsync("session_cut", { base: "HEAD" })).files.map((entry) => entry.path)).toEqual(["dirty.ts"]);

  // THE ROW'S PATCH FOLLOWS THE SAME BASE, so a file cannot show hunks from a
  // comparison the list above it did not make.
  expect((await store.sessionFilePatchAsync("session_cut", "committed.ts")).patch).toContain("export const a = 1;");
  expect((await store.sessionFilePatchAsync("session_cut", "committed.ts", { base: null })).patch).toBe("");
});
