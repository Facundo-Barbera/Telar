// M8 worktree reaper — reconcile enumeration gap fix. reconcileStuckLooms now
// runs reapOrphanWorktrees for EVERY registered project root (listProjects()),
// not only roots that currently own a worktree-bearing loom. That closes the
// leak where a killed process mid-verify (`telar-wt-frozen-*`) or mid-fold
// (`telar-wt-fold-*`) left a telar-wt-* dir recorded on NO loom, so the old
// loom-derived enumeration never visited that project's root. Every test drives
// a REAL throwaway tmp git repo + a fresh TELAR_HOME registry.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { reconcileStuckLooms } = await import("../src/dispatcher");
const { createLoom, getLoom, saveLoom } = await import("../src/looms");
const { createProject } = await import("../src/manifest");
const { addWorktree, resolveBaseSha, defaultGitRunner } = await import("../src/vcs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

const repos: string[] = [];
const homes: string[] = [];

// A fresh TELAR_HOME registry + a fresh real git repo registered as a project,
// so each test's registry contains exactly one project and reconcile sees only
// this test's looms.
function freshProject(name: string): { root: string; sha: string } {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reaper-disp-home-"));
  homes.push(h);
  process.env.TELAR_HOME = h;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reaper-disp-repo-"));
  repos.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.com"]);
  git(root, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial"]);
  createProject(root, { name });
  const sha = resolveBaseSha(defaultGitRunner, root, "main")!;
  return { root, sha };
}

const worktreeCount = (root: string) =>
  git(root, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

afterAll(() => {
  for (const root of repos) {
    try {
      for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const p = line.slice("worktree ".length).trim();
        if (path.basename(p).startsWith("telar-wt-")) {
          try {
            execFileSync("git", ["worktree", "remove", "--force", p], { cwd: root });
          } catch {}
        }
      }
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

describe("reconcileStuckLooms reaps unrecorded orphans per registered project root", () => {
  test("a frozen/fold orphan under a project with NO worktree-bearing loom is reaped (enumeration from listProjects)", () => {
    const { root, sha } = freshProject("reaper-p1");
    // Two unrecorded orphans — the exact shape a killed frozen-verify / fold
    // process leaves — recorded on NO loom. Under the OLD loom-derived
    // enumeration this project's root was never visited, so these leaked.
    const frozen = addWorktree(defaultGitRunner, root, sha, "frozen-verify1");
    const fold = addWorktree(defaultGitRunner, root, sha, "fold-telar/reaper-p1");
    expect(worktreeCount(root)).toBe(3); // main + frozen + fold

    // No live looms at all — reconcile still enumerates the registered root.
    reconcileStuckLooms(() => false);

    expect(fs.existsSync(frozen)).toBe(false);
    expect(fs.existsSync(fold)).toBe(false);
    expect(worktreeCount(root)).toBe(1); // main only
  });

  test("flag-off shape: a project with NO telar-wt-* dirs is a byte-identical no-op (no throw, count unchanged)", () => {
    const { root } = freshProject("reaper-p2");
    expect(worktreeCount(root)).toBe(1);

    expect(() => reconcileStuckLooms(() => false)).not.toThrow();

    expect(worktreeCount(root)).toBe(1); // untouched — the reaper only ever touches telar-wt-* dirs
  });

  test("a LIVE loom's worktree is never reaped; l.worktree is cleared only on reclaimed looms", () => {
    const { root, sha } = freshProject("reaper-p3");
    const liveWt = addWorktree(defaultGitRunner, root, sha, "live");
    const deadWt = addWorktree(defaultGitRunner, root, sha, "dead");

    const liveLoom = createLoom({ project: "reaper-p3", kind: "custom", title: "live", prompt: "x", account: "personal" });
    liveLoom.state = "ready"; // untouched by the stuck sweep; the reaper is what we exercise
    liveLoom.worktree = liveWt;
    saveLoom(liveLoom);

    const deadLoom = createLoom({ project: "reaper-p3", kind: "custom", title: "dead", prompt: "x", account: "personal" });
    deadLoom.state = "ready";
    deadLoom.worktree = deadWt;
    saveLoom(deadLoom);

    // liveness true ONLY for liveLoom -> deadLoom is reclaimed, liveLoom preserved.
    reconcileStuckLooms((id) => id === liveLoom.id);

    // Live checkout + its loom.worktree survive.
    expect(fs.existsSync(liveWt)).toBe(true);
    expect(getLoom(liveLoom.id)!.worktree).toBe(liveWt);
    // Dead checkout force-removed AND its loom.worktree cleared (reclaimed).
    expect(fs.existsSync(deadWt)).toBe(false);
    expect(getLoom(deadLoom.id)!.worktree).toBeUndefined();
  });

  test("a NON-live loom carrying the durable worktreeRetained flag is PRESERVED, not reaped", () => {
    const { root, sha } = freshProject("reaper-p4");
    const retainedWt = addWorktree(defaultGitRunner, root, sha, "retained");

    // Executor cleanup set this when a WIP snapshot FAILED and the dir is the
    // only surviving copy of the work — it is NOT a crash orphan.
    const loom = createLoom({ project: "reaper-p4", kind: "custom", title: "retained", prompt: "x", account: "personal" });
    loom.state = "done";
    loom.worktree = retainedWt;
    (loom as typeof loom & { worktreeRetained?: boolean }).worktreeRetained = true;
    saveLoom(loom);

    // No live looms — but the retained flag must still shield this worktree.
    reconcileStuckLooms(() => false);

    expect(fs.existsSync(retainedWt)).toBe(true); // dir preserved
    expect(getLoom(loom.id)!.worktree).toBe(retainedWt); // record NOT cleared
  });
});
