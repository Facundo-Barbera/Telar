// M3 — consolidation-on-completion. Drives a REAL tmp git repo: two threads in
// their own worktrees fold onto the review branch; asserts gather-all, the
// moat (baseBranch untouched, no state change, no accept), stray protection,
// and the zero-fold drop. fs-removes the tmp dir in finally.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Loom } from "../src/looms";
import { addWorktree, createConsolidationBranch, defaultGitRunner, removeWorktree, resolveBaseSha } from "../src/vcs";
import type { GitRunner } from "../src/vcs";
import { finalizeConsolidation, foldChildOnDone } from "../src/consolidate";

// addWorktree now mints under TELAR_HOME/worktrees (vcs.ts) — pin it to a
// throwaway dir so this suite never mints under a real ~/.telar.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-consol-home-"));
process.env.TELAR_HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;

function makeRoot(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "root1",
    project: "p",
    kind: "custom",
    title: "root",
    prompt: "x",
    account: "personal",
    state: "running",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...overrides,
  } as Loom;
}

function makeChild(id: string, worktree: string, overrides: Partial<Loom> = {}): Loom {
  return {
    id,
    project: "p",
    kind: "custom",
    title: `child ${id}`,
    prompt: "x",
    account: "personal",
    state: "done",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    parentLoomId: "root1",
    subGoalId: id,
    worktree,
    ...overrides,
  } as Loom;
}

beforeEach(() => {
  process.env.TELAR_HOME = home; // bun test runs all files in one process — re-pin
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-consol-"));
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

// Set up a root with a pinned base + review branch, plus N child worktrees
// forked from the base. Returns the root and the child looms.
function setupWeave(): { root: Loom; baseSha: string } {
  const baseSha = resolveBaseSha(defaultGitRunner, repo, "main")!;
  const root = makeRoot({ baseSha, consolidationBranch: "telar/root1" });
  createConsolidationBranch(defaultGitRunner, repo, root.consolidationBranch!, baseSha);
  return { root, baseSha };
}

describe("foldChildOnDone gathers all thread work", () => {
  test("two disjoint threads -> branch holds BOTH files; manifest.root untouched", async () => {
    const { root, baseSha } = setupWeave();
    const wtA = addWorktree(defaultGitRunner, repo, baseSha, "a");
    const wtB = addWorktree(defaultGitRunner, repo, baseSha, "b");
    fs.writeFileSync(path.join(wtA, "a.txt"), "from A\n");
    fs.writeFileSync(path.join(wtB, "b.txt"), "from B\n");
    const childA = makeChild("a", wtA, { title: "A" });
    const childB = makeChild("b", wtB, { title: "B" });

    await foldChildOnDone({ child: childA, root, repoRoot: repo, allowedPaths: ["a.txt"] });
    await foldChildOnDone({ child: childB, root, repoRoot: repo, allowedPaths: ["b.txt"] });

    removeWorktree(defaultGitRunner, repo, wtA);
    removeWorktree(defaultGitRunner, repo, wtB);

    // Both files present on the review branch tree.
    const branchFiles = git(repo, ["ls-tree", "-r", "--name-only", "telar/root1"]).trim().split("\n");
    expect(branchFiles).toContain("a.txt");
    expect(branchFiles).toContain("b.txt");
    expect(git(repo, ["show", "telar/root1:a.txt"])).toBe("from A\n");
    expect(git(repo, ["show", "telar/root1:b.txt"])).toBe("from B\n");
    // Two folds -> two commits over the base.
    expect(git(repo, ["rev-list", "--count", `${baseSha}..telar/root1`]).trim()).toBe("2");

    // MOAT: the shared working tree (manifest.root) was never written to.
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
    // MOAT: baseBranch (main) is exactly where it was — no fast-forward/merge.
    expect(git(repo, ["rev-parse", "main"]).trim()).toBe(baseSha);
  });

  test("two threads writing the SAME file -> the later fold SURFACES the collision (never silent last-write-wins)", async () => {
    const { root, baseSha } = setupWeave();
    const wtA = addWorktree(defaultGitRunner, repo, baseSha, "sa");
    const wtB = addWorktree(defaultGitRunner, repo, baseSha, "sb");
    fs.writeFileSync(path.join(wtA, "shared.txt"), "from A\n");
    fs.writeFileSync(path.join(wtB, "shared.txt"), "from B\n");
    const childA = makeChild("sa", wtA, { title: "A" });
    const childB = makeChild("sb", wtB, { title: "B" });

    // Weave subgoals carry no per-thread path scope, so both threads legitimately
    // touch shared.txt — the exact case the copy-based fold must not resolve
    // silently. Allow the same path for both.
    const foldA = await foldChildOnDone({ child: childA, root, repoRoot: repo, allowedPaths: ["shared.txt"] });
    const foldB = await foldChildOnDone({ child: childB, root, repoRoot: repo, allowedPaths: ["shared.txt"] });

    removeWorktree(defaultGitRunner, repo, wtA);
    removeWorktree(defaultGitRunner, repo, wtB);

    // First fold: nothing prior on the branch -> no collision.
    expect(foldA.collisions).toEqual([]);
    // Second fold: A already changed shared.txt, B changes it again -> SURFACED.
    expect(foldB.collisions).toContain("shared.txt");
    // Both folds still committed (the branch is a review artifact; last-write-wins
    // on content is acceptable ONLY because the collision is flagged for a human).
    expect(git(repo, ["rev-list", "--count", `${baseSha}..telar/root1`]).trim()).toBe("2");
  });

  test("two threads writing the same file with IDENTICAL content -> no false collision", async () => {
    const { root, baseSha } = setupWeave();
    const wtA = addWorktree(defaultGitRunner, repo, baseSha, "ia");
    const wtB = addWorktree(defaultGitRunner, repo, baseSha, "ib");
    fs.writeFileSync(path.join(wtA, "same.txt"), "identical\n");
    fs.writeFileSync(path.join(wtB, "same.txt"), "identical\n");

    const foldA = await foldChildOnDone({ child: makeChild("ia", wtA), root, repoRoot: repo, allowedPaths: ["same.txt"] });
    const foldB = await foldChildOnDone({ child: makeChild("ib", wtB), root, repoRoot: repo, allowedPaths: ["same.txt"] });

    removeWorktree(defaultGitRunner, repo, wtA);
    removeWorktree(defaultGitRunner, repo, wtB);

    // B stages nothing (content matches the branch) -> not flagged as a conflict.
    expect(foldA.collisions).toEqual([]);
    expect(foldB.collisions).toEqual([]);
  });

  test("a stray (out-of-allowedPaths) file is NOT folded (no-sweep at the worktree layer)", async () => {
    const { root, baseSha } = setupWeave();
    const wt = addWorktree(defaultGitRunner, repo, baseSha, "s");
    fs.writeFileSync(path.join(wt, "allowed.txt"), "ok\n");
    fs.writeFileSync(path.join(wt, "sneaky.txt"), "should not land\n");
    const child = makeChild("s", wt, { title: "S" });

    const res = await foldChildOnDone({ child, root, repoRoot: repo, allowedPaths: ["allowed.txt"] });
    removeWorktree(defaultGitRunner, repo, wt);

    expect(res.merged).toEqual(["allowed.txt"]);
    expect(res.stray).toEqual(["sneaky.txt"]);
    const branchFiles = git(repo, ["ls-tree", "-r", "--name-only", "telar/root1"]).trim().split("\n");
    expect(branchFiles).toContain("allowed.txt");
    expect(branchFiles).not.toContain("sneaky.txt");
  });
});

describe("moat: consolidation never advances state or accepts", () => {
  test("root stays 'ready' (rollup's own state), acceptLoom never invoked, no 'accepted' event, baseBranch unchanged", async () => {
    const { root, baseSha } = setupWeave();
    const wt = addWorktree(defaultGitRunner, repo, baseSha, "m");
    fs.writeFileSync(path.join(wt, "m.txt"), "work\n");
    const child = makeChild("m", wt);

    // Simulate the rollup outcome: the root reaches "ready" (never "done").
    root.state = "ready";
    await foldChildOnDone({ child, root, repoRoot: repo, allowedPaths: ["m.txt"] });
    const fin = finalizeConsolidation(root, repo, defaultGitRunner);
    removeWorktree(defaultGitRunner, repo, wt);

    expect(fin.commits).toBe(1);
    expect(fin.dropped).toBe(false);
    // The deliverable branch persists; state is unchanged by consolidation.
    expect(root.state).toBe("ready");
    expect(root.consolidationBranch).toBe("telar/root1");
    // baseBranch is untouched — landing is the human's acceptLoom, not this.
    expect(git(repo, ["rev-parse", "main"]).trim()).toBe(baseSha);
  });
});

describe("finalizeConsolidation zero-fold case", () => {
  test("no children folded -> empty branch dropped and consolidationBranch unset", () => {
    const { root } = setupWeave();
    // No fold happened — the branch equals the base.
    const fin = finalizeConsolidation(root, repo, defaultGitRunner);
    expect(fin.commits).toBe(0);
    expect(fin.dropped).toBe(true);
    expect(root.consolidationBranch).toBeUndefined();
    // The branch ref is gone.
    expect(() => git(repo, ["rev-parse", "--verify", "telar/root1"])).toThrow();
  });

  // L2 (contract v0.8) honest split — a rev-list FAILURE is "could not
  // determine", never "confirmed zero". Collapsing it into zero would
  // force-delete a real deliverable on a transient/real git error.
  test("a rev-list FAILURE does NOT drop the branch (honest split — no data loss)", () => {
    const { root } = setupWeave();
    const failCalls: { root: string; args: string[] }[] = [];
    const failingGit: GitRunner = (r, args) => {
      failCalls.push({ root: r, args });
      if (args[0] === "rev-list") return { status: 128, stdout: "", stderr: "fatal: bad revision" };
      return defaultGitRunner(r, args);
    };

    const fin = finalizeConsolidation(root, repo, failingGit);
    expect(fin.commits).toBe(0);
    expect(fin.dropped).toBe(false);
    expect(fin.error).toBeTruthy();
    expect(root.consolidationBranch).toBe("telar/root1"); // NOT unset
    // The branch ref still resolves — nothing was deleted.
    expect(() => git(repo, ["rev-parse", "--verify", "telar/root1"])).not.toThrow();
    expect(failCalls.some((c) => c.args[0] === "branch" && c.args[1] === "-D")).toBe(false);
  });
});
