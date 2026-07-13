// M11.5 (finding 5) — the cancel-path worktree-recovery fix. A builder that
// COMMITTED its attempt work inside its detached-HEAD isolated worktree leaves a
// CLEAN tree but an ADVANCED HEAD. Pre-fix, snapshotWorktreeToBranch returned
// false on the clean tree -> no recovery branch -> the executor finally's
// removeWorktree destroyed the committed-but-unreferenced commits. The fix pins
// the recovery branch straight at HEAD when it has diverged from the pinned base.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecuteOpts } from "../src/executor";
import { executeLoom } from "../src/executor";
import { createLoom, saveLoom } from "../src/looms";
import { createProject } from "../src/manifest";
import { createConsolidationBranch, defaultGitRunner, resolveBaseSha, snapshotWorktreeToBranch, addWorktree, removeWorktree } from "../src/vcs";
import { ProjectManifest } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-cancel-home-"));
process.env.TELAR_HOME = home;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;
let projN = 0;
let projectName: string;

beforeEach(() => {
  process.env.TELAR_HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-cancel-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  projN++;
  projectName = `m11cancel-${projN}`;
  createProject(repo, { name: projectName });
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

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const worktreeCount = () => git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

function manifestFor() {
  const base = ProjectManifest.parse({ name: projectName, root: repo });
  // No gates -> the abort short-circuits before gates anyway; kept minimal.
  // Isolation is unconditional, so no manifest field toggles it.
  return { ...base, gates: [] };
}

function makeRootAndChild() {
  const baseSha = resolveBaseSha(defaultGitRunner, repo, "main")!;
  const root = createLoom({ project: projectName, kind: "custom", title: "root", prompt: "x", account: "personal" });
  root.baseSha = baseSha;
  root.consolidationBranch = `telar/${root.id}`;
  createConsolidationBranch(defaultGitRunner, repo, root.consolidationBranch, baseSha);
  saveLoom(root);
  const child = createLoom({
    project: projectName,
    kind: "custom",
    title: "child",
    prompt: "x",
    account: "personal",
    parentLoomId: root.id,
    subGoalId: "s1",
  });
  saveLoom(child);
  return { root, child, baseSha };
}

// --- the vcs.ts primitive, unit-level ------------------------------------------

describe("snapshotWorktreeToBranch — committed-clean-HEAD recovery (finding 5)", () => {
  test("clean tree with a COMMITTED HEAD past base + baseSha -> pins the recovery branch at HEAD", () => {
    const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, baseSha, "committed1");
    const branch = "telar/root-wip-committed1";
    try {
      fs.writeFileSync(path.join(wt, "built.txt"), "committed work\n");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "--no-verify", "-m", "builder commit inside detached worktree"]);
      // Tree is now CLEAN but HEAD advanced.
      expect(git(wt, ["status", "--porcelain"]).trim()).toBe("");
      const head = git(wt, ["rev-parse", "HEAD"]).trim();
      expect(head).not.toBe(baseSha);

      const snapped = snapshotWorktreeToBranch(defaultGitRunner, wt, branch, baseSha);
      expect(snapped).toBe(true);
      removeWorktree(defaultGitRunner, repo, wt);
      // The committed work survives on the recovery branch (recoverable post-removal).
      expect(git(repo, ["rev-parse", "--verify", "--quiet", branch]).trim()).toBe(head);
      const files = git(repo, ["ls-tree", "-r", "--name-only", branch]).trim().split("\n");
      expect(files).toContain("built.txt");
    } finally {
      try { git(repo, ["branch", "-D", branch]); } catch {}
    }
  });

  test("clean tree AT base (HEAD===baseSha) -> still returns false, creates NO branch", () => {
    const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, baseSha, "atbase1");
    try {
      const snapped = snapshotWorktreeToBranch(defaultGitRunner, wt, "telar/should-not-exist", baseSha);
      expect(snapped).toBe(false);
      expect(defaultGitRunner(repo, ["rev-parse", "--verify", "--quiet", "telar/should-not-exist"]).status).not.toBe(0);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
    }
  });

  test("clean tree, NO baseSha given -> legacy contract preserved (false, no branch)", () => {
    const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = addWorktree(defaultGitRunner, repo, baseSha, "nobase1");
    try {
      fs.writeFileSync(path.join(wt, "x.txt"), "y\n");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "--no-verify", "-m", "committed"]);
      // Even with an advanced HEAD, omitting baseSha keeps the old "clean -> false".
      const snapped = snapshotWorktreeToBranch(defaultGitRunner, wt, "telar/legacy-none");
      expect(snapped).toBe(false);
      expect(defaultGitRunner(repo, ["rev-parse", "--verify", "--quiet", "telar/legacy-none"]).status).not.toBe(0);
    } finally {
      removeWorktree(defaultGitRunner, repo, wt);
    }
  });
});

// --- the full executeLoom cancel/abort path ------------------------------------

describe("executeLoom cancel path preserves committed work (finding 5)", () => {
  test("builder COMMITS inside its worktree then aborts -> halted, dir reclaimed, work on a recovery branch", async () => {
    const { child } = makeRootAndChild();
    const abort = new AbortController();
    // The builder commits its work inside the detached worktree, THEN cancel
    // arrives — leaving a clean tree with an advanced HEAD (the finding's bug).
    const run = (async (p: unknown, o: { cwd: string }) => {
      // The unconditional per-thread planner call must DEGRADE to the template
      // (invalid workflow) — never run the commit-then-abort builder body, which
      // would abort during planning and commit into manifest.root.
      if (/planning pass|step-graph/.test(String(p))) return { version: 1, steps: [] } as never;
      fs.writeFileSync(path.join(o.cwd, "built.txt"), "committed attempt work\n");
      git(o.cwd, ["add", "-A"]);
      git(o.cwd, ["commit", "--no-verify", "-m", "attempt work"]);
      abort.abort();
      return { ok: true, summary: "done", files_touched: ["built.txt"], blocker: null };
    }) as unknown as ExecuteOpts["run"];

    const res = await executeLoom(child, manifestFor(), { run, onState: saveLoom, onEvent: () => {}, abort });

    expect(res.state).toBe("halted");
    // No leaked worktree dir (M8's promise on the cancel path).
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1); // only the main worktree
    // The committed work was preserved on a durable recovery branch.
    const rec = res as typeof res & { recoveryBranch?: string };
    expect(rec.recoveryBranch).toBe(`telar/${child.parentLoomId}-wip-${child.id}`);
    const files = git(repo, ["ls-tree", "-r", "--name-only", rec.recoveryBranch!]).trim().split("\n");
    expect(files).toContain("built.txt");
    expect(git(repo, ["show", `${rec.recoveryBranch}:built.txt`])).toBe("committed attempt work\n");
  });
});
