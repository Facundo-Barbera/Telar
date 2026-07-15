// M3 — executeLoom-level worktree lifecycle. Isolation is UNCONDITIONAL: over a
// REAL tmp git repo with a FAKE agent (mocked engine) that writes a file into
// its cwd, executeLoom creates a worktree before the build, writes land in it
// (not the shared root), and NO worktree leaks on success / failure /
// needs-review / abort; a fold failure RETAINS the worktree's work as a branch.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecuteOpts } from "../src/executor";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-wtlife-home-"));
process.env.TELAR_HOME = home;

// A mutable builder impl each test sets; injected via opts.run (no engine
// module mock — that would leak process-globally). cwd is captured so we can
// assert which tree the builder ran in.
let capturedCwd: string | null = null;
let builderImpl: (cwd: string) => Promise<unknown> = async (cwd) => {
  fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
  return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
};
const fakeRun = (async (p: unknown, o: { cwd: string }) => {
  // The per-thread planner runs unconditionally; when this builder-shaped fake
  // is handed the read-only planner call, DEGRADE it to the template (return an
  // invalid workflow) rather than run the builder into manifest.root — so the
  // build under test runs only in the isolated worktree.
  if (/planning pass|step-graph/.test(String(p))) return { version: 1, steps: [] } as never;
  capturedCwd = o.cwd;
  return builderImpl(o.cwd);
}) as unknown as ExecuteOpts["run"];
const runOpts = (extra: Partial<ExecuteOpts> = {}): ExecuteOpts => ({
  run: fakeRun,
  onState: saveLoom,
  onEvent: () => {},
  ...extra,
});

import { executeLoom } from "../src/executor";
import { reconcileStuckLooms } from "../src/dispatcher";
import { createLoom, getLoom, saveLoom } from "../src/looms";
import { createProject } from "../src/manifest";
import { createConsolidationBranch, defaultGitRunner, resolveBaseSha } from "../src/vcs";
import { ProjectManifest } from "../src/schemas";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;
let projN = 0;
let projectName: string;

beforeEach(() => {
  process.env.TELAR_HOME = home;
  capturedCwd = null;
  builderImpl = async (cwd) => {
    fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
    return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
  };
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-wtlife-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  projN++;
  projectName = `wtlife-${projN}`;
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

// Build a manifest for executeLoom. One passing gate ("true") lets a child
// reach "done" (verify is "skip" for a plain loom). Isolation is unconditional,
// so no manifest field toggles it.
function manifestFor(gates = [{ name: "g", run: "true" }]) {
  const base = ProjectManifest.parse({ name: projectName, root: repo });
  return { ...base, gates };
}

const worktreeCount = () =>
  git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

// A persisted ROOT with a pinned base + review branch, and a persisted CHILD
// pointing at it. Returns the child.
function makeRootAndChild(withBranch = true) {
  const baseSha = resolveBaseSha(defaultGitRunner, repo, "main")!;
  const root = createLoom({ project: projectName, kind: "custom", title: "root", prompt: "x", account: "personal" });
  root.baseSha = baseSha;
  root.consolidationBranch = `telar/${root.id}`;
  if (withBranch) createConsolidationBranch(defaultGitRunner, repo, root.consolidationBranch, baseSha);
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

describe("worktree isolation (unconditional)", () => {
  test("worktree created before build; writes land in the worktree, not manifest.root; persisted before build", async () => {
    const { child } = makeRootAndChild();
    let worktreeAtBuildTime: string | undefined;
    builderImpl = async (cwd) => {
      // At build time the loom.worktree was persisted (crash-reclaimable).
      worktreeAtBuildTime = getLoom(child.id)?.worktree;
      fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
      return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
    };
    const res = await executeLoom(child, manifestFor(), runOpts());

    expect(res.state).toBe("done");
    expect(capturedCwd).not.toBe(repo);
    expect(path.basename(capturedCwd!).startsWith("telar-wt-")).toBe(true);
    expect(worktreeAtBuildTime).toBe(capturedCwd!); // persisted BEFORE the build ran
    // The builder wrote into the worktree, never the shared root.
    expect(fs.existsSync(path.join(repo, "out.txt"))).toBe(false);
  });

  test("no leak on SUCCESS: worktree removed, dir gone, loom.worktree cleared; work folded onto the branch", async () => {
    const { root, child } = makeRootAndChild();
    const res = await executeLoom(child, manifestFor(), runOpts());
    expect(res.state).toBe("done");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
    // The child's work is on the review branch (folded before removal).
    const branchFiles = git(repo, ["ls-tree", "-r", "--name-only", root.consolidationBranch!]).trim().split("\n");
    expect(branchFiles).toContain("out.txt");
  });

  test("no leak on FAILURE: a throwing builder -> failed, worktree removed", async () => {
    const { child } = makeRootAndChild();
    builderImpl = async () => {
      throw new Error("builder boom");
    };
    const res = await executeLoom(child, manifestFor(), runOpts());
    expect(res.state).toBe("failed");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
  });

  test("no leak on ESCALATE (a child never parks human-gated — L5): worktree removed AND its edits recoverable as a branch", async () => {
    const { child } = makeRootAndChild();
    // No gates -> gatesConfigured false; verify skip; no contract -> the child can't
    // promote. L5: a CHILD never lands needs-review — it ESCALATES (parks blocked).
    // The builder wrote out.txt into the worktree — that diff must survive.
    const res = await executeLoom(child, manifestFor([]), runOpts());
    expect(res.state).toBe("blocked");
    expect(res.worktree).toBeUndefined(); // dir reclaimed
    expect(worktreeCount()).toBe(1);
    // The uncommitted edits were snapshotted onto a durable recovery branch.
    const rec = res as typeof res & { recoveryBranch?: string };
    expect(rec.recoveryBranch).toBe(`telar/${child.parentLoomId}-wip-${child.id}`);
    const branchFiles = git(repo, ["ls-tree", "-r", "--name-only", rec.recoveryBranch!]).trim().split("\n");
    expect(branchFiles).toContain("out.txt");
  });

  test("no leak on ABORT: builder aborts mid-build -> halted, worktree removed", async () => {
    const { child } = makeRootAndChild();
    const abort = new AbortController();
    builderImpl = async (cwd) => {
      abort.abort(); // cancel arrives while the builder runs
      fs.writeFileSync(path.join(cwd, "out.txt"), "partial\n");
      return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
    };
    const res = await executeLoom(child, manifestFor(), runOpts({ abort }));
    expect(res.state).toBe("halted");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
  });

  test("FOLD FAILURE: snapshot-then-remove — dir reclaimed, work recoverable as a branch, survives reconcile", async () => {
    // Root has a consolidationBranch but the branch was never created, so the
    // fold's transient-worktree checkout of that ref fails. The un-consolidated
    // work must NOT be destroyed: it is snapshotted onto a recovery branch and
    // the dir is then removed (no leak, no lost work).
    const { child } = makeRootAndChild(false);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(child, manifestFor(), runOpts({ onEvent: (e) => events.push(e) }));

    expect(res.state).toBe("done");
    expect(events.some((e) => e.type === "consolidate-failed")).toBe(true);
    // The worktree dir is ALWAYS reclaimed now (work preserved as a branch).
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1); // main only
    // The child's un-folded work survives on a durable recovery branch.
    const rec = res as typeof res & { recoveryBranch?: string };
    const branch = `telar/${child.parentLoomId}-wip-${child.id}`;
    expect(rec.recoveryBranch).toBe(branch);
    expect(git(repo, ["ls-tree", "-r", "--name-only", branch]).trim().split("\n")).toContain("out.txt");

    // A simulated reconcile pass (the boot reaper) must NOT destroy the branch:
    // loom.worktree is cleared, so the reaper never touches it, and reapers
    // never delete branches.
    reconcileStuckLooms(() => false);
    expect(git(repo, ["rev-parse", "--verify", branch]).trim()).toBeTruthy();
  });

  test("REMOVE FAILURE is not silently swallowed: a genuinely-stuck worktree (e.g. a lingering held handle) flags worktreeRetained instead of being reported as reclaimed", async () => {
    // A LOCKED worktree is a real, realistic trigger: `git worktree remove
    // --force` (single force) refuses to remove a locked worktree — exactly
    // the shape of failure a lingering process/background command holding a
    // file handle inside the worktree would cause. defaultGitRunner never
    // throws on this (it returns a non-zero-status GitRunResult), so before
    // the fix this failure was completely unobserved.
    const { child } = makeRootAndChild();
    let wtPath: string | undefined;
    builderImpl = async (cwd) => {
      wtPath = cwd;
      fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
      execFileSync("git", ["worktree", "lock", cwd], { cwd: repo });
      return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
    };
    try {
      const res = await executeLoom(child, manifestFor(), runOpts());

      // The build/fold itself is unaffected — only cleanup fails.
      expect(res.state).toBe("done");
      // The genuinely-failed remove MUST be flagged, not silently swallowed.
      expect((res as typeof res & { worktreeRetained?: boolean }).worktreeRetained).toBe(true);
      // loom.worktree stays pointed at the surviving dir (never cleared on a
      // failed remove) so the boot reaper can find and preserve it.
      expect(res.worktree).toBe(wtPath);
      expect(fs.existsSync(wtPath!)).toBe(true);
      expect(worktreeCount()).toBe(2); // main + the stuck worktree, still registered

      // The boot reaper must PRESERVE (never reap) a dir flagged worktreeRetained.
      reconcileStuckLooms(() => false);
      expect(fs.existsSync(wtPath!)).toBe(true);
      expect(worktreeCount()).toBe(2);
    } finally {
      // Unlock so afterEach's own force-remove sweep can actually clear it.
      if (wtPath) {
        try {
          execFileSync("git", ["worktree", "unlock", wtPath], { cwd: repo });
        } catch {}
      }
    }
  });
});
