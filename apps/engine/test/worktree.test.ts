/**
 * Stage 7 — worktree sessions.
 *
 * The property under test is the precondition for running several detached
 * sessions on one project: each gets a checkout of its own, and the work it
 * produces survives the session ending.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";
import { createSessionWorktree, defaultGitRunner, removeSessionWorktree, WorktreeError, type GitRunner } from "../src/worktree";

const roots: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository with one commit, so `HEAD` resolves. */
function repo(): string {
  const root = tmp("telar-vnext-wt-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

test("a worktree session gets its own checkout on a named branch", () => {
  const projectRoot = repo();
  const vnextRoot = tmp("telar-vnext-wt-state-");
  const cut = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "session_one" });

  expect(fs.existsSync(path.join(cut.path, "README.md"))).toBe(true);
  expect(cut.branch).toBe("telar/session_one");
  // ON A BRANCH, NOT DETACHED. A detached worktree's commits become
  // unreachable the moment it is removed, and a detached session's whole
  // output is its commits.
  const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cut.path, encoding: "utf8" }).trim();
  expect(head).toBe("telar/session_one");
  // Inside the engine's own root, never a sibling of core's `worktrees`.
  expect(cut.path.startsWith(path.join(vnextRoot, "worktrees"))).toBe(true);
});

test("two sessions on one project get separate checkouts", () => {
  // The whole point: N detached sessions must not fight over one working copy.
  const projectRoot = repo();
  const vnextRoot = tmp("telar-vnext-wt-state-");
  const first = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" });
  const second = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "two" });
  expect(first.path).not.toBe(second.path);
  expect(first.branch).not.toBe(second.branch);

  fs.writeFileSync(path.join(first.path, "only-in-one.txt"), "x");
  expect(fs.existsSync(path.join(second.path, "only-in-one.txt"))).toBe(false);
});

test("a non-git project is refused with an actionable message rather than a git error", () => {
  const projectRoot = tmp("telar-vnext-wt-plain-");
  const vnextRoot = tmp("telar-vnext-wt-state-");
  expect(() => createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" })).toThrow(WorktreeError);
  expect(() => createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" })).toThrow(/envMode "local"/);
});

test("recreating a session's worktree after a reap succeeds instead of failing on the branch name", () => {
  // `-B` rather than `-b`. With `-b`, a session whose worktree was reaped could
  // never be recreated: the branch still exists and git refuses.
  const projectRoot = repo();
  const vnextRoot = tmp("telar-vnext-wt-state-");
  const first = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" });
  expect(removeSessionWorktree(defaultGitRunner, projectRoot, first.path)).toBe(true);
  const again = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" });
  expect(fs.existsSync(again.path)).toBe(true);
});

test("removal reports whether the directory is ACTUALLY gone", () => {
  // The caller's only reliable signal: a failed `git worktree remove` comes
  // back as a non-zero status rather than an exception, and the trailing
  // prune would otherwise hide it.
  const projectRoot = repo();
  const vnextRoot = tmp("telar-vnext-wt-state-");
  const cut = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "one" });
  expect(removeSessionWorktree(defaultGitRunner, projectRoot, cut.path)).toBe(true);

  const deaf: GitRunner = () => ({ status: 1, stdout: "", stderr: "nope" });
  const stubborn = createSessionWorktree(defaultGitRunner, { vnextRoot, projectRoot, sessionId: "two" });
  expect(removeSessionWorktree(deaf, projectRoot, stubborn.path)).toBe(false);
});

test("a session created with envMode worktree records its branch and base", () => {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-vnext-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });

  expect(session.envMode).toBe("worktree");
  expect(session.workspace).toMatchObject({ mode: "worktree", branch: "telar/session_one" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");
  expect(session.workspace.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(fs.existsSync(session.workspace.path)).toBe(true);

  // The claim hands the worker the SESSION's checkout, not the project root —
  // otherwise the isolation is cosmetic.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")?.projectRoot).toBe(session.workspace.path);
});

test("a failed worktree cut leaves no half-created session behind", () => {
  // The worktree is cut BEFORE the session document is written, so there is
  // nothing to repair on read.
  const store = new EngineStore(tmp("telar-vnext-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: tmp("telar-vnext-wt-plain-") });
  expect(() => store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" })).toThrow(WorktreeError);
  expect(() => store.getSession("session_one")).toThrow(EngineStateError);
});

test("archiving frees the checkout and KEEPS the branch", () => {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-vnext-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  if (session.workspace.mode !== "worktree") throw new Error("expected a worktree workspace");

  // Work the session produced.
  execFileSync("git", ["commit", "-qm", "session work", "--allow-empty"], { cwd: session.workspace.path });

  const archived = store.archiveSession("session_one");
  expect(archived.state).toBe("archived");
  expect(fs.existsSync(session.workspace.path)).toBe(false);
  // THE BRANCH SURVIVES. A detached run whose output vanished when it finished
  // would be worse than one that never ran.
  const branches = execFileSync("git", ["branch", "--list", "telar/session_one"], { cwd: projectRoot, encoding: "utf8" });
  expect(branches.trim()).toContain("telar/session_one");
  expect(store.readEvents("session_one").at(-1)?.type).toBe("session.archived");
});

test("archiving refuses while a turn is in flight", () => {
  // Pulling the checkout out from under a live provider process is how a
  // half-written file becomes a corrupt commit.
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-vnext-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  store.createSession({ id: "session_one", projectId: "project_one", envMode: "worktree" });
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.archiveSession("session_one")).toThrow(/active turn/);

  store.stopTurn("session_one", "run_one");
  expect(store.archiveSession("session_one").state).toBe("archived");
});

test("archiving is idempotent", () => {
  const store = new EngineStore(tmp("telar-vnext-wt-engine-"), () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.archiveSession("session_one").state).toBe("archived");
  expect(store.readEvents("session_one").filter((event) => event.type === "session.archived")).toHaveLength(1);
});
