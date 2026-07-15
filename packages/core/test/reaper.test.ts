// M3 — crash-orphan reclamation. A killed process can't run its finally, so a
// registered worktree leaks. reapOrphanWorktrees prunes stale registrations and
// force-removes any telar-wt-* worktree not in the live set, while PRESERVING a
// live loom's worktree and NEVER deleting the consolidation branch.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, createConsolidationBranch, defaultGitRunner, reapOrphanWorktrees, resolveBaseSha } from "../src/vcs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

// addWorktree now mints under TELAR_HOME/worktrees (vcs.ts) — pin it to a
// throwaway dir so this suite never mints under a real ~/.telar.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reaper-home-"));
process.env.TELAR_HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

let repo: string;

beforeEach(() => {
  process.env.TELAR_HOME = home; // bun test runs all files in one process — re-pin
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reaper-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => {
  try {
    for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice("worktree ".length).trim();
      if (path.basename(p).startsWith("telar-wt-")) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", p], { cwd: repo });
        } catch {}
      }
    }
  } catch {}
  fs.rmSync(repo, { recursive: true, force: true });
});

const worktreeCount = () =>
  git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

describe("reapOrphanWorktrees", () => {
  test("removes an orphan, preserves a live worktree, leaves the branch alone", () => {
    const sha = resolveBaseSha(defaultGitRunner, repo, "main")!;
    createConsolidationBranch(defaultGitRunner, repo, "telar/root1", sha);

    const orphan = addWorktree(defaultGitRunner, repo, sha, "crashed");
    const live = addWorktree(defaultGitRunner, repo, sha, "running");
    expect(worktreeCount()).toBe(3); // main + orphan + live

    // liveWorktreePaths only names the live one -> the orphan is reclaimed.
    reapOrphanWorktrees(defaultGitRunner, repo, [live]);

    expect(fs.existsSync(orphan)).toBe(false); // orphan dir gone
    expect(fs.existsSync(live)).toBe(true); // live checkout preserved
    expect(worktreeCount()).toBe(2); // main + live only

    // The consolidation branch is NOT reaped — branch GC is the human's call.
    expect(git(repo, ["rev-parse", "--verify", "telar/root1"]).trim()).toBeTruthy();
  });

  test("is a no-op on a non-git path (never throws)", () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reaper-notrepo-"));
    try {
      expect(() => reapOrphanWorktrees(defaultGitRunner, notRepo, [])).not.toThrow();
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
