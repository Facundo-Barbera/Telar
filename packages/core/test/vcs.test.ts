// M3 — the promoted VCS/worktree substrate. Every test drives a REAL throwaway
// tmp git repo (git init + a commit), operates, asserts, and fs-removes the tmp
// dir in a finally — never the telar repo or ~/.telar.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWorktree,
  defaultGitRunner,
  mergeDisjoint,
  removeWorktree,
  resolveBaseSha,
  withWorktreeLock,
} from "../src/vcs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "orig a\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "orig b\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => {
  // Force-remove any leaked worktree registrations, then the dir tree.
  try {
    for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice("worktree ".length).trim();
      if (path.basename(p).startsWith("telar-wt-")) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", p], { cwd: repo });
          fs.rmSync(p, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
  fs.rmSync(repo, { recursive: true, force: true });
});

const worktreeCount = () =>
  git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

describe("addWorktree", () => {
  test("creates a detached checkout at the given SHA and lists it", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "l1");
    try {
      expect(fs.existsSync(path.join(wt, "a.txt"))).toBe(true);
      expect(worktreeCount()).toBe(2);
      // detached: HEAD in the worktree points at the SHA, not a branch.
      expect(git(wt, ["rev-parse", "HEAD"]).trim()).toBe(sha);
      expect(path.basename(wt).startsWith("telar-wt-")).toBe(true);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
    }
  });

  test("deterministic monotonic counter -> unique paths", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const w1 = addWorktree(defaultGitRunner, repo, sha, "x");
    const w2 = addWorktree(defaultGitRunner, repo, sha, "x");
    try {
      expect(w1).not.toBe(w2);
    } finally {
      removeWorktree(defaultGitRunner, repo, w1);
      removeWorktree(defaultGitRunner, repo, w2);
    }
  });
});

describe("removeWorktree", () => {
  test("removes the dir AND the registration (prune)", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "l2");
    expect(worktreeCount()).toBe(2);
    removeWorktree(defaultGitRunner, repo, wt);
    expect(worktreeCount()).toBe(1);
    expect(fs.existsSync(wt)).toBe(false);
  });

  test("double-remove is a no-op, never throws", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "l3");
    removeWorktree(defaultGitRunner, repo, wt);
    expect(() => removeWorktree(defaultGitRunner, repo, wt)).not.toThrow();
    expect(worktreeCount()).toBe(1);
  });
});

describe("resolveBaseSha", () => {
  test("returns the SHA of baseBranch", () => {
    const sha = git(repo, ["rev-parse", "main"]).trim();
    expect(resolveBaseSha(defaultGitRunner, repo, "main")).toBe(sha);
  });

  test("null on a missing ref", () => {
    expect(resolveBaseSha(defaultGitRunner, repo, "nope-branch")).toBeNull();
  });

  test("null on a non-repo path", () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-notrepo-"));
    try {
      expect(resolveBaseSha(defaultGitRunner, notRepo, "main")).toBeNull();
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe("withWorktreeLock serializes", () => {
  test("N concurrent addWorktree calls all succeed with distinct paths, no lock error, order preserved", async () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const order: number[] = [];
    const promises = [0, 1, 2, 3, 4].map((i) =>
      withWorktreeLock(() => {
        order.push(i);
        return addWorktree(defaultGitRunner, repo, sha, `c${i}`);
      }),
    );
    const wts = await Promise.all(promises);
    try {
      expect(new Set(wts).size).toBe(5); // all distinct
      expect(order).toEqual([0, 1, 2, 3, 4]); // serialized in submission order
      expect(worktreeCount()).toBe(6); // main + 5
    } finally {
      for (const wt of wts) removeWorktree(defaultGitRunner, repo, wt);
    }
  });
});

describe("mergeDisjoint", () => {
  test("copies only allowed-path files into an arbitrary destination, records stray", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "m1");
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-dest-"));
    try {
      fs.writeFileSync(path.join(wt, "a.txt"), "changed a\n");
      fs.writeFileSync(path.join(wt, "stray.txt"), "not allowed\n");
      const res = mergeDisjoint(defaultGitRunner, wt, dest, ["a.txt"]);
      expect(res.merged).toEqual(["a.txt"]);
      expect(res.stray).toEqual(["stray.txt"]);
      expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("changed a\n");
      expect(fs.existsSync(path.join(dest, "stray.txt"))).toBe(false);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  test("handles renames and non-ASCII filenames (quotepath off)", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "m2");
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-dest2-"));
    try {
      // rename a.txt -> renamed.txt inside the worktree
      git(wt, ["mv", "a.txt", "renamed.txt"]);
      // a non-ASCII new file
      fs.writeFileSync(path.join(wt, "café.txt"), "accented\n");
      const res = mergeDisjoint(defaultGitRunner, wt, dest, ["renamed.txt", "café.txt"]);
      expect(res.merged.sort()).toEqual(["café.txt", "renamed.txt"]);
      expect(fs.existsSync(path.join(dest, "renamed.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(dest, "café.txt"), "utf8")).toBe("accented\n");
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
