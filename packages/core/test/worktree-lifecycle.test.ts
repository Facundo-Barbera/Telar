// M3 — executeLoom-level worktree lifecycle. Drives executeLoom with a FAKE
// agent (mocked engine) that writes a file into its cwd, over a REAL tmp git
// repo, and asserts: flag-off is byte-identical (no worktree, builder cwd ===
// manifest.root); flag-on creates a worktree before the build, writes land in
// it (not the shared root), and NO worktree leaks on success / failure /
// needs-review / abort; a fold failure RETAINS the worktree.
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
const fakeRun = (async (_p: unknown, o: { cwd: string }) => {
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

// Build a manifest for executeLoom. `isolate` flips the M3 flag; one passing
// gate ("true") lets a child reach "done" (verify is "skip" for a plain loom).
function manifestFor(isolate: boolean, gates = [{ name: "g", run: "true" }]) {
  const base = ProjectManifest.parse({ name: projectName, root: repo });
  return { ...base, isolateWorktrees: isolate, gates };
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

describe("flag OFF (behavior-preserving)", () => {
  test("no worktree created; builder cwd === manifest.root; loom.worktree unset", async () => {
    const { child } = makeRootAndChild();
    const res = await executeLoom(child, manifestFor(false), runOpts());
    expect(res.state).toBe("done");
    expect(capturedCwd).toBe(repo); // built in the shared root
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1); // only the main worktree
    expect(fs.existsSync(path.join(repo, "out.txt"))).toBe(true); // wrote into the shared tree
  });
});

describe("flag ON", () => {
  test("worktree created before build; writes land in the worktree, not manifest.root; persisted before build", async () => {
    const { child } = makeRootAndChild();
    let worktreeAtBuildTime: string | undefined;
    builderImpl = async (cwd) => {
      // At build time the loom.worktree was persisted (crash-reclaimable).
      worktreeAtBuildTime = getLoom(child.id)?.worktree;
      fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
      return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
    };
    const res = await executeLoom(child, manifestFor(true), runOpts());

    expect(res.state).toBe("done");
    expect(capturedCwd).not.toBe(repo);
    expect(path.basename(capturedCwd!).startsWith("telar-wt-")).toBe(true);
    expect(worktreeAtBuildTime).toBe(capturedCwd!); // persisted BEFORE the build ran
    // The builder wrote into the worktree, never the shared root.
    expect(fs.existsSync(path.join(repo, "out.txt"))).toBe(false);
  });

  test("no leak on SUCCESS: worktree removed, dir gone, loom.worktree cleared; work folded onto the branch", async () => {
    const { root, child } = makeRootAndChild();
    const res = await executeLoom(child, manifestFor(true), runOpts());
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
    const res = await executeLoom(child, manifestFor(true), runOpts());
    expect(res.state).toBe("failed");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
  });

  test("no leak on NEEDS-REVIEW: (no gates, nothing verified) worktree removed", async () => {
    const { child } = makeRootAndChild();
    // No gates -> gatesConfigured false; verify skip; child lands needs-review.
    const res = await executeLoom(child, manifestFor(true, []), runOpts());
    expect(res.state).toBe("needs-review");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
  });

  test("no leak on ABORT: builder aborts mid-build -> halted, worktree removed", async () => {
    const { child } = makeRootAndChild();
    const abort = new AbortController();
    builderImpl = async (cwd) => {
      abort.abort(); // cancel arrives while the builder runs
      fs.writeFileSync(path.join(cwd, "out.txt"), "partial\n");
      return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
    };
    const res = await executeLoom(child, manifestFor(true), runOpts({ abort }));
    expect(res.state).toBe("halted");
    expect(res.worktree).toBeUndefined();
    expect(worktreeCount()).toBe(1);
  });

  test("FOLD FAILURE: fold throws -> worktree RETAINED + consolidate-failed event (work not destroyed)", async () => {
    // Root has a consolidationBranch but the branch was never created, so the
    // fold's transient-worktree checkout of that ref fails.
    const { child } = makeRootAndChild(false);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(child, manifestFor(true), runOpts({ onEvent: (e) => events.push(e) }));

    expect(res.state).toBe("done");
    expect(events.some((e) => e.type === "consolidate-failed")).toBe(true);
    // The worktree is intentionally NOT removed — the work survives for the reaper/human.
    expect(res.worktree).toBeTruthy();
    expect(worktreeCount()).toBe(2); // main + the retained child worktree
  });
});
