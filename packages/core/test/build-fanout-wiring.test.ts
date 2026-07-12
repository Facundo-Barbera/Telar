import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecuteOpts } from "../src/executor";
import type { BuildPiece } from "../src/build-fanout";

// No live model anywhere: the dispatch-seam tests inject runLoomFn (executeLoom
// never runs) and splitBuildFn; the end-to-end tests drive the REAL executeLoom
// against a temp git repo with an injected `run` (fake builders) and a loom
// whose verification promotably skips (no contract, no target).

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fanout-wiring-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterEach(() => {
  // The fan-out flags are process-global env — never let them leak into the
  // other test files (byte-identity/isolation-off tests depend on them absent).
  delete process.env.TELAR_BUILD_FANOUT;
  delete process.env.TELAR_ISOLATE_WORKTREES;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { startLoom } = await import("../src/dispatcher");
const { executeLoom } = await import("../src/executor");
const { createLoom, getLoom } = await import("../src/looms");
const { createProject, getProject } = await import("../src/manifest");

let projectSeq = 0;

// A plain (non-git) project — enough for the dispatch-seam capture tests, where
// executeLoom is faked so no worktree/git is ever touched.
function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fanout-wiring-proj-"));
  const name = `fanout-wiring-${projectSeq++}`;
  createProject(root, { name });
  return name;
}

// A real temp git repo project — for the end-to-end fan-out (worktrees + merge).
function makeGitProject(): { name: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fanout-e2e-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Telar Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "a.txt"), "original a\n");
  fs.writeFileSync(path.join(root, "b.txt"), "original b\n");
  execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  const name = `fanout-e2e-${projectSeq++}`;
  // A trivial always-green gate so a builder-green + verification-skip attempt
  // is promotable (decide's gated skip → done), letting a ROOT loom reach the
  // 'ready' milestone the MOAT test asserts — without any live model.
  createProject(root, { name, gates: [{ name: "noop", run: "true" }] });
  return { name, root };
}

const twoDisjoint: BuildPiece[] = [
  { id: "s1", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
  { id: "s2", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
];

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
}

// A fake builder for the end-to-end path: writes its piece's single allowed
// file (parsed out of the real prompt makePieceBuilder built) into the piece
// worktree cwd, and returns a green Verdict.
const fileFromPrompt = (prompt: string): string => {
  const m = prompt.match(/modify files under: (.+?)\. Do not touch/);
  return m ? m[1]!.split(",")[0]!.trim() : "unknown.txt";
};

const worktreeCount = (root: string): number =>
  execFileSync("git", ["worktree", "list"], { cwd: root }).toString().trim().split("\n").filter(Boolean).length;

// Drive startLoom's FAST PATH (acceptanceCriteria present -> weave-of-one) and
// capture the ExecuteOpts the (faked) child runner receives.
async function captureChildOpts(cfg: {
  fanoutFlag: boolean;
  splitBuildFn: () => Promise<BuildPiece[]>;
}): Promise<{ opts: ExecuteOpts; splitCalls: number }> {
  const name = makeProject();
  if (cfg.fanoutFlag) {
    process.env.TELAR_BUILD_FANOUT = "1";
    process.env.TELAR_ISOLATE_WORKTREES = "1";
  }
  let captured: ExecuteOpts | null = null;
  let splitCalls = 0;
  const fakeRunChild = async (child: any, _m: any, opts: ExecuteOpts) => {
    captured = opts;
    child.state = "done";
    return child;
  };
  startLoom(
    { project: name, kind: "custom", title: "t", prompt: "build a and b", acceptanceCriteria: ["works"] },
    {
      accounts: {},
      splitBuildFn: (async () => {
        splitCalls++;
        return cfg.splitBuildFn();
      }) as any,
      runLoomFn: fakeRunChild as any,
    },
  );
  await waitFor(() => captured !== null);
  if (!captured) throw new Error("child runner was never invoked");
  return { opts: captured, splitCalls };
}

describe("build fan-out wiring — dispatch→executor seam (fakes, no live model)", () => {
  test("flag OFF: byte-identical — splitBuild is never called and no buildFanout opt is set", async () => {
    const { opts, splitCalls } = await captureChildOpts({
      fanoutFlag: false,
      splitBuildFn: async () => twoDisjoint,
    });
    expect(splitCalls).toBe(0); // planner never even consulted flag-off
    expect(opts.buildFanout).toBeUndefined(); // single-builder path
  });

  test("flag ON + >=2 disjoint pieces: executeLoom receives a populated buildFanout", async () => {
    const { opts, splitCalls } = await captureChildOpts({
      fanoutFlag: true,
      splitBuildFn: async () => twoDisjoint,
    });
    expect(splitCalls).toBe(1);
    expect(opts.buildFanout).toBeDefined();
    expect(opts.buildFanout!.pieces.length).toBe(2);
    expect(opts.buildFanout!.baseRef).toBe("HEAD");
    expect(opts.buildFanout!.pieces.map((p) => p.id).sort()).toEqual(["s1", "s2"]);
  });

  test("flag ON but planner returns [] (no disjoint partition): REFUSED honestly — single builder, no crash", async () => {
    const { opts, splitCalls } = await captureChildOpts({
      fanoutFlag: true,
      splitBuildFn: async () => [], // splitBuild collapses non-disjoint/<2 to []
    });
    expect(splitCalls).toBe(1);
    expect(opts.buildFanout).toBeUndefined(); // downgraded to single builder
  });

  test("flag ON but the planner THROWS: caught → single builder (a fan-out never crashes a runnable thread)", async () => {
    const { opts } = await captureChildOpts({
      fanoutFlag: true,
      splitBuildFn: async () => {
        throw new Error("planner boom");
      },
    });
    expect(opts.buildFanout).toBeUndefined(); // fell through to single builder
  });

  test("the roster is always threaded into the child opts (default {} — no preset applied)", async () => {
    const { opts } = await captureChildOpts({ fanoutFlag: false, splitBuildFn: async () => twoDisjoint });
    expect(opts.roster).toBeDefined();
    expect(opts.roster).toEqual({});
  });
});

describe("build fan-out end-to-end — real executeLoom + temp git repo (fake builders)", () => {
  test("MOAT + merged-verifies-same: a green N-builder ROOT attempt merges disjointly, verifies ONCE, lands 'ready' (never 'done')", async () => {
    const { name, root } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    // No contract, no acceptanceCriteria/target ⇒ verification promotably skips
    // (the SAME path a single builder would take) — keeps the test model-free.

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, {
      buildFanout: { pieces: twoDisjoint, baseRef: "HEAD" },
      run: (async (prompt: string, o: any) => {
        const f = fileFromPrompt(prompt);
        fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
        return { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
      }) as any,
      onEvent: (ev) => events.push(ev),
      onState: () => {},
    });

    // MOAT: a completed ROOT loom lands 'ready' (awaiting the human acceptLoom
    // click) — more builders never make it self-accept to 'done'.
    expect(result.state).toBe("ready");
    // Exactly one attempt ⇒ the merged tree went through the SAME single
    // per-attempt gate+verify+decide path a single builder uses.
    expect(loom.attempts.length).toBe(1);
    expect(events.filter((e) => e.type === "verdict").length).toBe(1);
    // The fan-out actually ran N builders and merged both files onto the root.
    expect(events.some((e) => e.type === "fanout" && e.pieces === 2)).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("built a.txt\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("built b.txt\n");
    // No worktree leaks.
    expect(worktreeCount(root)).toBe(1);
  });

  test("ENFORCEMENT: overlapping pieces handed DIRECTLY to executeLoom are refused — never a silent green merge, no worktree leak", async () => {
    const { name, root } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    const overlapping: BuildPiece[] = [
      { id: "s1", title: "A", prompt: "do A", allowedPaths: ["src"] },
      { id: "s2", title: "B", prompt: "do B", allowedPaths: ["src/sub"] },
    ];
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let builderRan = false;

    // runBuildFanout hard-throws on overlap BEFORE any worktree; executeLoom's
    // top-level catch turns that into a 'failed' loom — never a resolved 'ready'
    // /'done'. The moat holds even against a hostile hand-built buildFanout opt
    // that bypasses the dispatcher's disjoint pre-check.
    const result = await executeLoom(loom, manifest, {
      buildFanout: { pieces: overlapping, baseRef: "HEAD" },
      run: (async () => {
        builderRan = true;
        return { ok: true, summary: "", files_touched: [], blocker: null };
      }) as any,
      onEvent: (ev) => events.push(ev),
      onState: () => {},
    });

    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("ready");
    expect(result.state).not.toBe("done");
    expect(events.some((e) => e.type === "error" && /disjoint/i.test(String(e.message)))).toBe(true);
    // Refused before any worktree/builder — no corruption, no leak.
    expect(builderRan).toBe(false);
    expect(worktreeCount(root)).toBe(1);
  });
});
