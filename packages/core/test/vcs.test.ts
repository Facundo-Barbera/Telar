// M3 — the promoted VCS/worktree substrate. Every test drives a REAL throwaway
// tmp git repo (git init + a commit), operates, asserts, and fs-removes the tmp
// dir in a finally — never the telar repo or ~/.telar.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWorktree,
  createConsolidationBranch,
  defaultGitRunner,
  foldThreadIntoBranch,
  mergeDisjoint,
  reapOrphanWorktrees,
  removeWorktree,
  resolveBaseSha,
  snapshotWorktreeToBranch,
  withWorktreeLock,
} from "../src/vcs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

// addWorktree mints worktree DIRECTORIES under manifest.ts's telarDir(), never
// os.tmpdir() (see vcs.ts header) — so, like every other suite, pin TELAR_HOME
// to a throwaway dir up front and never let a test mint under a real ~/.telar.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-home-"));
process.env.TELAR_HOME = home;

let repo: string;

beforeEach(() => {
  // bun test runs all files in one process — re-pin before every test.
  process.env.TELAR_HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "orig a\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "orig b\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
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

  test("mints under TELAR_HOME/worktrees (the durable engine home), never bare os.tmpdir() — macOS wipes /tmp and would destroy an in-flight loom's worktree + session resumability", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "durable1");
    try {
      expect(path.dirname(wt)).toBe(path.join(home, "worktrees"));
      expect(wt.startsWith(home)).toBe(true);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
    }
  });

  test("honors a TELAR_HOME override at call time (mint root is not cached)", () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-other-home-"));
    const prev = process.env.TELAR_HOME;
    try {
      process.env.TELAR_HOME = otherHome;
      const sha = git(repo, ["rev-parse", "HEAD"]).trim();
      const wt = addWorktree(defaultGitRunner, repo, sha, "override1");
      try {
        expect(path.dirname(wt)).toBe(path.join(otherHome, "worktrees"));
      } finally {
        removeWorktree(defaultGitRunner, repo, wt);
      }
    } finally {
      process.env.TELAR_HOME = prev;
      fs.rmSync(otherHome, { recursive: true, force: true });
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

  test("returns true iff the dir is actually gone afterward — a genuinely-successful removal", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "l2b");
    expect(removeWorktree(defaultGitRunner, repo, wt)).toBe(true);
  });

  test("returns false when the underlying remove genuinely fails (dir survives on disk) — the caller's ONLY failure signal, since defaultGitRunner never throws", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "l2c");
    // A fake runner that reports failure (non-zero status, like a real `git
    // worktree remove --force` failure) for the remove/prune calls but never
    // throws — exactly what defaultGitRunner does on a real git failure. The
    // dir is deliberately left on disk (nothing deletes it) to simulate the
    // stuck-worktree case (e.g. a lingering process still holding a handle).
    const failingRunner = (root: string, args: string[]) => {
      if (args[0] === "worktree" && (args[1] === "remove" || args[1] === "prune")) {
        return { status: 1, stdout: "", stderr: "fatal: unable to remove" };
      }
      return defaultGitRunner(root, args);
    };
    expect(removeWorktree(failingRunner, repo, wt)).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
    // Cleanup for real so afterEach's sweep doesn't need to.
    removeWorktree(defaultGitRunner, repo, wt);
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

  test("merges files created in a PREVIOUSLY-UNTRACKED directory, not a false stray from a collapsed dir entry", () => {
    // Regression for the live-run bug: default `git status --porcelain`
    // COLLAPSES a fully-untracked directory to a single "?? src/" entry instead
    // of listing "?? src/token-bucket.ts". That "src/" never matched a
    // file-level allowedPath, so a greenfield write was both dropped from the
    // merge and false-flagged stray. --untracked-files=all lists each file so it
    // is attributed to its allowedPath — while a real out-of-lane sibling in the
    // SAME new dir is still, distinctly, caught as stray (fail-closed intact).
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "m3");
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vcs-dest3-"));
    try {
      fs.mkdirSync(path.join(wt, "src"));
      fs.mkdirSync(path.join(wt, "test"));
      fs.writeFileSync(path.join(wt, "src", "token-bucket.ts"), "tb\n");
      fs.writeFileSync(path.join(wt, "test", "token-bucket.test.ts"), "tb test\n");
      // A genuine out-of-lane SIBLING inside the same brand-new src/ directory.
      fs.writeFileSync(path.join(wt, "src", "rogue.ts"), "rogue\n");

      const res = mergeDisjoint(defaultGitRunner, wt, dest, [
        "src/token-bucket.ts",
        "test/token-bucket.test.ts",
      ]);

      expect(res.merged.sort()).toEqual(["src/token-bucket.ts", "test/token-bucket.test.ts"]);
      expect(res.stray).toEqual(["src/rogue.ts"]); // real stray still detected
      expect(fs.readFileSync(path.join(dest, "src", "token-bucket.ts"), "utf8")).toBe("tb\n");
      expect(fs.readFileSync(path.join(dest, "test", "token-bucket.test.ts"), "utf8")).toBe("tb test\n");
      expect(fs.existsSync(path.join(dest, "src", "rogue.ts"))).toBe(false); // stray never copied
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

describe("foldThreadIntoBranch", () => {
  test("folds a thread's allowed-path change onto the consolidation branch (transient self-removes)", async () => {
    const sha = resolveBaseSha(defaultGitRunner, repo, "main")!;
    createConsolidationBranch(defaultGitRunner, repo, "telar/root", sha);
    const thread = addWorktree(defaultGitRunner, repo, sha, "thread");
    try {
      fs.writeFileSync(path.join(thread, "a.txt"), "thread work\n");
      const res = await foldThreadIntoBranch(
        defaultGitRunner,
        repo,
        "telar/root",
        thread,
        ["a.txt"],
        "feat: fold thread",
        sha,
      );
      expect(res.merged).toEqual(["a.txt"]);
      // The branch now carries the folded commit...
      const log = git(repo, ["log", "--format=%s", "telar/root"]).trim().split("\n");
      expect(log[0]).toBe("feat: fold thread");
      // ...and the transient `telar-wt-fold-*` worktree removed itself in its finally.
      expect(worktreeCount()).toBe(2); // main + thread only
      expect(
        git(repo, ["worktree", "list"]).includes("telar-wt-fold-"),
      ).toBe(false);
    } finally {
      removeWorktree(defaultGitRunner, repo, thread);
    }
  });
});

describe("snapshotWorktreeToBranch", () => {
  test("commits a worktree's WIP onto a durable recovery branch that survives worktree removal", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "child1");
    const branch = "telar/root-wip-child1";
    try {
      fs.writeFileSync(path.join(wt, "a.txt"), "child work\n");
      fs.writeFileSync(path.join(wt, "new.txt"), "brand new\n");
      const snapped = snapshotWorktreeToBranch(defaultGitRunner, wt, branch);
      expect(snapped).toBe(true);
      // The branch carries the WIP as a real commit — recoverable after removal.
      removeWorktree(defaultGitRunner, repo, wt);
      const files = git(repo, ["ls-tree", "-r", "--name-only", branch]).trim().split("\n");
      expect(files).toContain("a.txt");
      expect(files).toContain("new.txt");
      // The branch tip's a.txt reflects the child's edit, not the base.
      expect(git(repo, ["show", `${branch}:a.txt`])).toBe("child work\n");
    } finally {
      git(repo, ["branch", "-D", branch]);
    }
  });

  test("returns false and creates NO branch when the worktree is clean", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, sha, "clean1");
    try {
      const snapped = snapshotWorktreeToBranch(defaultGitRunner, wt, "telar/should-not-exist");
      expect(snapped).toBe(false);
      // No branch was created (rev-parse --verify exits non-zero on a missing ref).
      expect(defaultGitRunner(repo, ["rev-parse", "--verify", "--quiet", "telar/should-not-exist"]).status).not.toBe(0);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
    }
  });
});

describe("reapOrphanWorktrees reclaims unrecorded frozen/fold orphans", () => {
  // A killed process mid-verify (`telar-wt-frozen-*`) or mid-fold
  // (`telar-wt-fold-*`) leaves a telar-wt-* dir recorded on NO loom. The
  // reconcile reaper, now run per registered project root, force-removes those
  // orphans while preserving a LIVE checkout and never deleting the branch.
  test("force-removes telar-wt-frozen-* and telar-wt-fold-* orphans, keeps live + branch", () => {
    const sha = resolveBaseSha(defaultGitRunner, repo, "main")!;
    createConsolidationBranch(defaultGitRunner, repo, "telar/root", sha);

    const frozen = addWorktree(defaultGitRunner, repo, sha, "frozen-verify123");
    const fold = addWorktree(defaultGitRunner, repo, sha, "fold-telar/root");
    const live = addWorktree(defaultGitRunner, repo, sha, "running");
    expect(worktreeCount()).toBe(4); // main + frozen + fold + live

    // Only the live checkout is in the live set -> both orphans are reaped.
    reapOrphanWorktrees(defaultGitRunner, repo, [live]);

    expect(fs.existsSync(frozen)).toBe(false);
    expect(fs.existsSync(fold)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(worktreeCount()).toBe(2); // main + live only
    // The consolidation branch survives — branch GC is the human's call.
    expect(git(repo, ["rev-parse", "--verify", "telar/root"]).trim()).toBeTruthy();
  });

  test("reaps a legacy telar-wt-* orphan registered OUTSIDE the new mint root (a pre-migration loom's os.tmpdir() worktree still reclaims fine)", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]).trim();
    // Simulate a worktree minted before the TELAR_HOME/worktrees migration:
    // registered straight under os.tmpdir(), not under the new mint root.
    const legacyDir = path.join(os.tmpdir(), "telar-wt-legacy-orphan-1");
    defaultGitRunner(repo, ["worktree", "add", "--detach", legacyDir, sha]);
    try {
      expect(fs.existsSync(legacyDir)).toBe(true);
      reapOrphanWorktrees(defaultGitRunner, repo, []); // nothing live
      expect(fs.existsSync(legacyDir)).toBe(false);
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
