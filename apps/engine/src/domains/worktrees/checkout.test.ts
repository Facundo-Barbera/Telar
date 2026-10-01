import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GIT_ADMISSION_MS, DEFAULT_GIT_TIMEOUT_MS, type AsyncGitRunner } from "../../platform/git/runner";
import { createSessionWorktreeAsync, lockSessionWorktree, removeSessionWorktreeAsync, repairWorktree, WORKTREE_TREE_TIMEOUT_MS, WORKTREE_ADMISSION_MS, worktreeLockReason } from "./index";
import { tmp, removeTmp, worktreeFixtures, repo } from "../../../test/worktree-fixtures";

afterEach(removeTmp);
const { poolGit, cutWorktree } = worktreeFixtures();

test("every session worktree is locked the moment it exists, on any disk", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // Not "the lock command was issued" — what git itself says about the tree.
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
  const record = listed.split("\n\n").find((block) => block.includes(cut.path));
  expect(record).toBeDefined();
  expect(record).toContain("locked");
  // The reason is what a person meets in `git worktree list` and in gh's
  // refusal, so it has to name the session rather than the volume.
  expect(record).toContain("archived or deleted");
});

test("the lock reason names the volume only when there is one", () => {
  expect(worktreeLockReason("/Users/someone/Telar/engine/worktrees/x", "darwin")).not.toContain("removable volume");
  expect(worktreeLockReason("/Users/someone/Telar/engine/worktrees/x", "darwin")).toContain("A Telar session is working in this worktree");
  expect(worktreeLockReason("/Volumes/Drive/worktrees/x", "darwin")).toContain("removable volume");
});

test("gh's own worktree removal cannot take a live session's checkout", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  fs.writeFileSync(path.join(cut.path, "half-finished.txt"), "the work that is not committed yet\n");

  const attempt = (...args: string[]): number => {
    try {
      execFileSync("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  expect(attempt("worktree", "remove", "--", cut.path)).not.toBe(0);
  expect(attempt("worktree", "remove", "--force", "--", cut.path)).not.toBe(0);
  expect(fs.existsSync(path.join(cut.path, "half-finished.txt"))).toBe(true);

  // And the registration survives a prune, which is the half that cannot be
  // recovered once it is gone.
  execFileSync("git", ["worktree", "prune"], { cwd: projectRoot });
  expect(execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" })).toContain(path.basename(cut.path));
});

test("a lock does not get in the way of the session's own work", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  // The point of the worktree is that a session can commit in it. A guard that
  // bought safety by breaking that would not be worth having.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: cut.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(cut.path, "work.txt"), "done\n");
  git("add", "-A");
  git("-c", "user.email=test@telar.local", "-c", "user.name=Telar Test", "commit", "-qm", "work");
  expect(git("log", "--oneline", "-1")).toContain("work");
  // `repair` is lock-transparent too, which is what keeps #630's store move
  // working now that every worktree is locked rather than only some.
  expect(await repairWorktree(poolGit, projectRoot, cut.path)).toBe(true);
});

test("an already-locked worktree is not a failure to lock again", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  // The cut already locked it; the startup backfill locks every live worktree
  // on every boot, so the second call is the ordinary case rather than an edge.
  await lockSessionWorktree(poolGit, projectRoot, cut.path);
  expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" })).toContain("locked");
  // And it still comes apart on the one path that is allowed to take it.
  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, cut.path, "available")).toBe(true);
});

test("a locked worktree is still removable, because teardown unlocks first", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });
  // The cut locks it — every worktree since #641, not only the ones on a drive —
  // and git refuses `worktree remove` on a locked tree. So this is the state
  // teardown always meets, rather than the unusual one it used to be.
  expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" })).toContain("locked");

  expect(await removeSessionWorktreeAsync(poolGit, projectRoot, cut.path, "available")).toBe(true);
  expect(fs.existsSync(cut.path)).toBe(false);
});

test("repair re-points git at a worktree that moved, which a byte copy never does", async () => {
  const projectRoot = repo();
  const engineRoot = tmp("telar-wt-state-");
  const moved = tmp("telar-wt-moved-");
  const cut = await cutWorktree({ engineRoot, projectRoot, sessionId: "one" });

  const destination = path.join(moved, path.basename(cut.path));
  fs.cpSync(cut.path, destination, { recursive: true });
  fs.rmSync(cut.path, { recursive: true, force: true });
  expect(execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" })).toContain(cut.path);

  expect(await repairWorktree(poolGit, projectRoot, destination)).toBe(true);
  const listed = execFileSync("git", ["worktree", "list"], { cwd: projectRoot, encoding: "utf8" });
  expect(listed).toContain(destination);
  expect(listed).not.toContain(`${cut.path} `);
});

test("a worktree cut or removal is given its own deadline, not a read's", () => {
  expect(WORKTREE_TREE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_GIT_TIMEOUT_MS);
  expect(WORKTREE_TREE_TIMEOUT_MS).toBe(300_000);
  // And a starved cut may wait longer than a starved read, because the callers
  // ahead of it may each legitimately hold a slot for a cut's whole budget.
  expect(WORKTREE_ADMISSION_MS).toBeGreaterThan(WORKTREE_TREE_TIMEOUT_MS);
  expect(DEFAULT_GIT_ADMISSION_MS).toBeGreaterThan(DEFAULT_GIT_TIMEOUT_MS);
});

test("createSessionWorktreeAsync passes the worktree deadline down to git", async () => {
  const calls: Array<{ args: string[]; options?: { timeoutMs?: number } }> = [];
  const recording: AsyncGitRunner = async (_cwd, args, options) => {
    calls.push({ args, ...(options ? { options } : {}) });
    return { status: 0, stdout: "", stderr: "" };
  };
  const engineRoot = tmp("telar-cut-deadline-engine-");
  const projectRoot = tmp("telar-cut-deadline-project-");
  await createSessionWorktreeAsync(recording, {
    engineRoot,
    projectRoot,
    plan: { path: path.join(engineRoot, "cut"), branch: "telar/deadline", named: false },
    baseSha: "base000",
  });
  const add = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  expect(add).toBeDefined();
  expect(add!.options?.timeoutMs).toBe(WORKTREE_TREE_TIMEOUT_MS);
});

test("removing a session worktree gives git the tree deadline", async () => {
  const calls: Array<{ args: string[]; options?: { timeoutMs?: number } }> = [];
  const recording: AsyncGitRunner = async (_cwd, args, options) => {
    calls.push({ args, ...(options ? { options } : {}) });
    return { status: 0, stdout: "", stderr: "" };
  };
  const worktree = path.join(tmp("telar-remove-deadline-"), "cut");
  await removeSessionWorktreeAsync(recording, tmp("telar-remove-deadline-project-"), worktree);
  const remove = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "remove");
  expect(remove?.options?.timeoutMs).toBe(WORKTREE_TREE_TIMEOUT_MS);
});
