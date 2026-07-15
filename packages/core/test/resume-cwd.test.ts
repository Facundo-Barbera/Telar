// Pins the resume/cwd fix (executor.ts file header, "RESUME/CWD"): the SDK
// keys a resumable session by the cwd it was born in, not the sessionId
// alone. A CHILD thread mints a fresh worktree tmpdir on every executeLoom()
// call, so a naive "always resume loom.attempts[last].sessionId" retry was
// resuming from a DIFFERENT cwd than the session's birth cwd and the SDK
// threw "No conversation found with session ID: ...".
//
// Three things pinned here, mirroring the fix's three parts:
//  1. reuse:      the previous session's recorded cwd still exists on disk ->
//                 executeLoom reuses that SAME directory (no new worktree
//                 minted) and resumes the same sessionId.
//  2. fresh:      the recorded cwd is gone -> a fresh worktree is minted and
//                 NO resume is passed (never a cwd mismatch in the first
//                 place).
//  3. fail-open:  even when the cwd check said resume should be safe, if the
//                 SDK still throws its "No conversation found" error, the
//                 attempt falls back to a brand-new session in the same cwd
//                 instead of that raw error becoming the thread's result.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecuteOpts } from "../src/executor";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-home-"));
process.env.TELAR_HOME = home;

type Call = { cwd: string; resume?: string };
let calls: Call[] = [];
let sessionCounter = 0;
// Set true to make the NEXT resume-carrying call throw the SDK's exact
// resume-miss error once, then clear itself (simulates part 3's residual
// runtime failure even though the cwd check said resume was safe).
let failNextResume = false;
// A mutable per-test builder for the (non-throwing) success path.
let builderImpl: (cwd: string) => Promise<unknown> = async (cwd) => {
  fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
  return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
};
const fakeRun = (async (p: unknown, o: { cwd: string; resume?: string; onEvent?: (e: any) => void }) => {
  // Degrade the read-only workflow planner to the deterministic template so
  // the build under test only ever runs in the isolated worktree (same
  // convention as worktree-lifecycle.test.ts).
  if (/planning pass|step-graph/.test(String(p))) return { version: 1, steps: [] } as never;
  calls.push({ cwd: o.cwd, resume: o.resume });
  if (o.resume && failNextResume) {
    failNextResume = false; // only the one resume attempt fails
    throw new Error(`No conversation found with session ID: ${o.resume}`);
  }
  sessionCounter++;
  o.onEvent?.({ type: "session", sessionId: `sess-${sessionCounter}` });
  return builderImpl(o.cwd);
}) as unknown as ExecuteOpts["run"];
const runOpts = (extra: Partial<ExecuteOpts> = {}): ExecuteOpts => ({
  run: fakeRun,
  onState: saveLoom,
  onEvent: () => {},
  ...extra,
});

import { executeLoom, isSessionNotFoundError } from "../src/executor";
import { createLoom, saveLoom } from "../src/looms";
import { createProject } from "../src/manifest";
import { createConsolidationBranch, defaultGitRunner, resolveBaseSha } from "../src/vcs";
import { ProjectManifest } from "../src/schemas";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;
let projN = 0;
let projectName: string;
const orphanDirs: string[] = [];

beforeEach(() => {
  process.env.TELAR_HOME = home;
  calls = [];
  sessionCounter = 0;
  failNextResume = false;
  builderImpl = async (cwd) => {
    fs.writeFileSync(path.join(cwd, "out.txt"), "built\n");
    return { ok: true, summary: "done", files_touched: ["out.txt"], blocker: null };
  };
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  projN++;
  projectName = `resume-cwd-${projN}`;
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
  for (const d of orphanDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function manifestFor(gates = [{ name: "g", run: "true" }]) {
  const base = ProjectManifest.parse({ name: projectName, root: repo });
  return { ...base, gates };
}

const worktreeCount = () => git(repo, ["worktree", "list"]).trim().split("\n").filter(Boolean).length;

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
  return { root, child };
}

describe("isSessionNotFoundError (pure predicate)", () => {
  test("matches the SDK's exact resume-miss text, case-insensitively", () => {
    expect(isSessionNotFoundError(new Error("No conversation found with session ID: abc-123"))).toBe(true);
    expect(isSessionNotFoundError(new Error("no conversation found to continue"))).toBe(true);
  });
  test("does not match an unrelated error or a non-Error value", () => {
    expect(isSessionNotFoundError(new Error("ECONNRESET"))).toBe(false);
    expect(isSessionNotFoundError("No conversation found with session ID: abc")).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
  });
});

describe("resume/cwd fix — worktree reuse + resume gating", () => {
  test("reuse: the prior session's recorded cwd still exists AND worktreeRetained is set -> executeLoom reuses it (no new worktree minted) and resumes the same sessionId", async () => {
    const { child } = makeRootAndChild();
    const priorCwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-prior-"));
    orphanDirs.push(priorCwd);
    child.attempts.push({
      n: 1,
      role: "dev",
      model: "sonnet",
      startedAt: Date.now(),
      endedAt: Date.now(),
      sessionId: "sess-prior",
      cwd: priorCwd,
      verdict: { ok: false, summary: "partial", files_touched: [], blocker: "not done yet" },
    });
    // Reuse requires the EXPLICIT retention signal a real crashed/failed
    // reclaim would have left behind (executor.ts finally block), not bare
    // directory existence — see the "stale dir, no flag" test below.
    child.worktreeRetained = true;
    saveLoom(child);

    const before = worktreeCount();
    const res = await executeLoom(child, manifestFor(), runOpts());

    expect(res.state).toBe("done");
    // No NEW git worktree was registered — the prior directory was reused.
    expect(worktreeCount()).toBe(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.cwd).toBe(priorCwd);
    expect(calls[0]!.resume).toBe("sess-prior");
  });

  test("bare directory existence WITHOUT worktreeRetained is NOT reused: a fresh worktree is minted and the stale dir is left untouched", async () => {
    const { child } = makeRootAndChild();
    // Simulates the confirmed bug's trigger: a prior worktree dir that is
    // still on disk (e.g. a swallowed `git worktree remove --force` failure)
    // but was never flagged as retained — it must NOT be trusted as a live,
    // consolidated worktree just because fs.existsSync says so.
    const staleCwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-stale-"));
    orphanDirs.push(staleCwd);
    fs.writeFileSync(path.join(staleCwd, "sentinel.txt"), "leftover\n");
    child.attempts.push({
      n: 1,
      role: "dev",
      model: "sonnet",
      startedAt: Date.now(),
      endedAt: Date.now(),
      sessionId: "sess-prior",
      cwd: staleCwd,
      verdict: { ok: false, summary: "partial", files_touched: [], blocker: "not done yet" },
    });
    // worktreeRetained deliberately left unset.
    saveLoom(child);

    const res = await executeLoom(child, manifestFor(), runOpts());

    expect(res.state).toBe("done");
    expect(calls.length).toBeGreaterThan(0);
    // A FRESH worktree was minted — the stale dir was never reused.
    expect(calls[0]!.cwd).not.toBe(staleCwd);
    expect(path.basename(calls[0]!.cwd).startsWith("telar-wt-")).toBe(true);
    // The mismatched-cwd session is never resumed — the SDK never sees it.
    expect(calls[0]!.resume).toBeUndefined();
    // The stale dir itself is left alone (untouched, unregistered) — this
    // test only asserts telar never TRUSTS it, not that it reaps it.
    expect(fs.existsSync(path.join(staleCwd, "sentinel.txt"))).toBe(true);
  });

  test("fresh: the prior session's recorded cwd is GONE -> a fresh worktree is minted and resume is withheld", async () => {
    const { child } = makeRootAndChild();
    const goneCwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-gone-"));
    fs.rmSync(goneCwd, { recursive: true, force: true }); // gone before executeLoom ever runs
    child.attempts.push({
      n: 1,
      role: "dev",
      model: "sonnet",
      startedAt: Date.now(),
      endedAt: Date.now(),
      sessionId: "sess-prior",
      cwd: goneCwd,
      verdict: { ok: false, summary: "partial", files_touched: [], blocker: "not done yet" },
    });
    saveLoom(child);

    const res = await executeLoom(child, manifestFor(), runOpts());

    expect(res.state).toBe("done");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.cwd).not.toBe(goneCwd);
    expect(path.basename(calls[0]!.cwd).startsWith("telar-wt-")).toBe(true);
    // The mismatched-cwd session is never resumed — the SDK never sees it.
    expect(calls[0]!.resume).toBeUndefined();
  });

  test("first-ever attempt (no prior attempts at all) is unaffected: fresh worktree, no resume", async () => {
    const { child } = makeRootAndChild();
    const res = await executeLoom(child, manifestFor(), runOpts());
    expect(res.state).toBe("done");
    expect(calls[0]!.resume).toBeUndefined();
    expect(path.basename(calls[0]!.cwd).startsWith("telar-wt-")).toBe(true);
  });

  test("fail-open: the SDK still throws 'No conversation found' despite a cwd match -> falls back to a fresh session, never surfaces the raw error", async () => {
    const { child } = makeRootAndChild();
    const priorCwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-resume-cwd-prior2-"));
    orphanDirs.push(priorCwd);
    child.attempts.push({
      n: 1,
      role: "dev",
      model: "sonnet",
      startedAt: Date.now(),
      endedAt: Date.now(),
      sessionId: "sess-prior",
      cwd: priorCwd,
      verdict: { ok: false, summary: "partial", files_touched: [], blocker: "not done yet" },
    });
    child.worktreeRetained = true; // required for reuse — see reuse test above
    saveLoom(child);
    failNextResume = true;

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(child, manifestFor(), runOpts({ onEvent: (e) => events.push(e) }));

    expect(res.state).toBe("done");
    // The raw SDK error text never becomes the thread's terminal result: no
    // `error` event, and the loom never demotes to `failed` over it (a
    // "resume-fallback" diagnostic breadcrumb carrying the SDK's text is
    // fine — that is NOT the thread's result).
    expect(res.error ?? "").not.toContain("No conversation found");
    expect(events.some((e) => e.type === "error")).toBe(false);
    // Both the failed resume attempt AND the fresh fallback are observable.
    expect(calls.length).toBe(2);
    expect(calls[0]!.resume).toBe("sess-prior");
    expect(calls[1]!.resume).toBeUndefined();
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd); // same cwd, just no resume
    expect(events.some((e) => e.type === "resume-fallback")).toBe(true);
  });
});
