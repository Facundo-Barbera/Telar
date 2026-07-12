// M5 — reconcileStuckLooms now takes an injectable liveness oracle (default =
// in-process activeLoomIds). Proves: (1) the default path is byte-identical to
// today (stranded in-flight → failed); (2) a loom the injected oracle judges
// LIVE (a runner owns it via a fresh lease / /active) is NEVER touched — the
// cross-process guard that stops recovery from stranding a live-runner loom;
// (3) the M3 worktree reaper honors the SAME oracle — a live-runner loom's
// worktree is never reaped even though the WEB process's activeLoomIds() is
// empty, while a dead orphan IS reclaimed.
// MOAT: recovery only ever writes `failed` (resumable), never `done`.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, defaultGitRunner, removeWorktree, resolveBaseSha } from "../src/vcs";
import type { WorkUnitState } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m5-reconcile-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const { reconcileStuckLooms } = await import("../src/dispatcher");
const { createLoom, getLoom, saveLoom } = await import("../src/looms");
const { createProject } = await import("../src/manifest");

function seed(state: WorkUnitState): string {
  const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
  loom.state = state;
  saveLoom(loom);
  return loom.id;
}

describe("reconcileStuckLooms with injectable liveness", () => {
  test("default liveness: a stranded in-flight loom → failed (byte-identical)", () => {
    const id = seed("running");
    reconcileStuckLooms(); // default in-process oracle: not live
    expect(getLoom(id)!.state).toBe("failed");
  });

  test("a loom the injected oracle judges LIVE is NOT touched (no strand, no auto-complete)", () => {
    const live = seed("running");
    const dead = seed("verifying");
    const reconciled = reconcileStuckLooms((id) => id === live); // cross-process: `live` is owned by a runner
    expect(getLoom(live)!.state).toBe("running"); // untouched — a runner owns it
    expect(getLoom(dead)!.state).toBe("failed"); // stranded → resumable
    expect(reconciled.some((r) => r.id === live)).toBe(false);
    // MOAT: nothing was auto-completed.
    expect(getLoom(live)!.state).not.toBe("done");
    expect(getLoom(dead)!.state).not.toBe("done");
  });
});

describe("reconcileStuckLooms worktree reaper honors the injected liveness oracle", () => {
  function initRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m5-reaper-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
    g(["init", "-b", "main"]);
    g(["config", "user.email", "t@t.com"]);
    g(["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
    g(["add", "-A"]);
    g(["commit", "-m", "initial"]);
    return repo;
  }

  test("oracle LIVE preserves the worktree; oracle DEAD reaps the orphan", () => {
    const repo = initRepo();
    const manifest = createProject(repo, { name: "reaper-proj" });
    const sha = resolveBaseSha(defaultGitRunner, repo, "main")!;

    // Two ROOT looms in the project, each owning a real telar-wt-* worktree. Both
    // are terminal ("done") so the stuck sweep leaves them untouched — only the
    // reaper acts, isolating exactly the behavior under test.
    const mkLoom = () => {
      const l = createLoom({ project: manifest.name, kind: "custom", title: "t", prompt: "x", account: "personal" });
      l.state = "done";
      l.worktree = addWorktree(defaultGitRunner, repo, sha, l.id);
      saveLoom(l);
      return l;
    };
    const liveLoom = mkLoom();
    const deadLoom = mkLoom();
    const wtLive = liveLoom.worktree!;
    const wtDead = deadLoom.worktree!;
    expect(fs.existsSync(wtLive)).toBe(true);
    expect(fs.existsSync(wtDead)).toBe(true);

    try {
      // ONE injected oracle governs the reaper: liveLoom LIVE (a runner owns it),
      // deadLoom DEAD. Flag-on this is exactly the case activeLoomIds() gets wrong
      // (the WEB process's active map is empty), so a runner-owned worktree would
      // be wrongly reaped if the reaper bypassed the oracle.
      reconcileStuckLooms((id) => id === liveLoom.id);

      // LIVE loom: worktree preserved on disk AND its field intact — never reaped.
      expect(fs.existsSync(wtLive)).toBe(true);
      expect(getLoom(liveLoom.id)!.worktree).toBe(wtLive);

      // DEAD loom: orphan worktree removed AND its field cleared — reclaimed.
      expect(fs.existsSync(wtDead)).toBe(false);
      expect(getLoom(deadLoom.id)!.worktree).toBeUndefined();
    } finally {
      try {
        removeWorktree(defaultGitRunner, repo, wtLive);
      } catch {}
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
