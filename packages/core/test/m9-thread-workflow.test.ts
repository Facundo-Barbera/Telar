// M9.1 — thread-as-workflow (flag-gated, default OFF). Proves:
//  (a) flag helper + refactor kernel + flag-OFF path is unchanged (runner
//      unreachable, no workflow-* events, real executeLoom still reaches ready);
//  (b) flag-ON with the DEFAULT template reproduces today's outcome on the same
//      fixture (same terminal state / attempts / verdict), going THROUGH the
//      runner (one workflow-wave stepIds:["build"]) and never writing "done";
//  (c) a hand-built 2(+1)-step DAG runs in dependency order (a dep completes
//      before its dependent starts; independent steps overlap);
//  (d) independent steps in a wave run CONCURRENTLY (Promise.all, not a
//      sequential for-await) — the runner's within-wave parallel primitive that
//      M9.2 fans agents out over.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuildPiece } from "../src/build-fanout";
import type { ExecuteOpts, StepResult, WorkflowStepCtx } from "../src/executor";
import type { Loom } from "../src/looms";
import type { ProjectManifest, Step, ThreadWorkflow } from "../src/schemas";

const { executeLoom, runThreadWorkflow } = await import("../src/executor");
const { threadWorkflowEnabled } = await import("../src/runner/flag");
const { readyItems, readySubGoals } = await import("../src/tick");
const { createLoom } = await import("../src/looms");
const { createProject, getProject } = await import("../src/manifest");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m9-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterEach(() => {
  // Process-global flags — never let them leak into the byte-identity /
  // isolation-off suites (mirrors build-fanout-wiring.test.ts:19-24).
  delete process.env.TELAR_THREAD_WORKFLOW;
  delete process.env.TELAR_BUILD_FANOUT;
  delete process.env.TELAR_ISOLATE_WORKTREES;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

let projectSeq = 0;

// The canonical "drive the REAL executeLoom to 'ready' hermetically" fixture
// (copied from build-fanout-wiring.test.ts): temp git repo + trivial always-green
// gate so a no-contract/no-target loom is promotable with no live model.
function makeGitProject(): { name: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m9-e2e-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Telar Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "a.txt"), "original a\n");
  fs.writeFileSync(path.join(root, "b.txt"), "original b\n");
  execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  const name = `m9-e2e-${projectSeq++}`;
  createProject(root, { name, gates: [{ name: "noop", run: "true" }] });
  return { name, root };
}

const twoDisjoint: BuildPiece[] = [
  { id: "s1", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
  { id: "s2", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
];

// Fake builder: writes its piece's single allowed file (parsed from the real
// prompt makePieceBuilder built) into the worktree cwd, returns a green Verdict.
const fileFromPrompt = (prompt: string): string => {
  const m = prompt.match(/modify files under: (.+?)\. Do not touch/);
  return m ? m[1]!.split(",")[0]!.trim() : "unknown.txt";
};
const fakeBuilder = (async (prompt: string, o: any) => {
  const f = fileFromPrompt(prompt);
  fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
  return { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
}) as any;

// Run the real executeLoom over the git fixture with the fake fan-out builder;
// return the resolved loom + captured events. Identical opts across flag on/off
// so (a) is a true control for (b).
async function driveToReady(name: string, opts: Partial<ExecuteOpts> = {}) {
  const manifest = getProject(name).manifest;
  const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const result = await executeLoom(loom, manifest, {
    buildFanout: { pieces: twoDisjoint, baseRef: "HEAD" },
    run: fakeBuilder,
    onEvent: (ev) => events.push(ev),
    onState: () => {},
    ...opts,
  });
  return { loom, result, events };
}

let loomSeq = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  loomSeq++;
  return {
    id: `L${loomSeq}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...overrides,
  };
}
const step = (id: string, dependsOn: string[] = [], over: Partial<Step> = {}): Step => ({
  id,
  goal: id,
  kind: "research",
  agents: [],
  partition: "free",
  dependsOn,
  ...over,
});
const noManifest = {} as unknown as ProjectManifest;

// ── (a) flag helper + refactor kernel + flag-OFF byte-identity ───────────────
describe("(a) flag helper + readyItems kernel + flag-OFF path unchanged", () => {
  test("threadWorkflowEnabled: false by default; honors manifest flag + env override", () => {
    delete process.env.TELAR_THREAD_WORKFLOW;
    expect(threadWorkflowEnabled({})).toBe(false);
    expect(threadWorkflowEnabled({ threadWorkflow: false })).toBe(false);
    expect(threadWorkflowEnabled({ threadWorkflow: true })).toBe(true);
    process.env.TELAR_THREAD_WORKFLOW = "1";
    expect(threadWorkflowEnabled({})).toBe(true);
  });

  test("readyItems kernel: ids not-started whose every dependsOn is completed, in order", () => {
    const items = [
      { id: "a", dependsOn: [] as string[] },
      { id: "b", dependsOn: ["a"] },
    ];
    // Nothing done yet ⇒ only the depless 'a' is ready.
    expect(readyItems(items, () => false, () => false)).toEqual(["a"]);
    // 'a' done ⇒ 'b' unblocks; 'a' already started ⇒ excluded.
    expect(readyItems(items, (id) => id === "a", (id) => id === "a")).toEqual(["b"]);
    // input order preserved.
    expect(readyItems([{ id: "b", dependsOn: [] }, { id: "a", dependsOn: [] }], () => false, () => false)).toEqual(["b", "a"]);
  });

  test("readySubGoals is still a live export (thin adapter over readyItems)", () => {
    // The refactor kept readySubGoals; its output-identity on real LedgerViews is
    // pinned by orchestrator.test.ts:643-659 (still green in the suite run).
    expect(typeof readySubGoals).toBe("function");
  });

  test("flag OFF: the real executeLoom reaches 'ready' and emits NO workflow-* events (runner unreachable)", async () => {
    const { name } = makeGitProject();
    const { result, events } = await driveToReady(name); // env unset ⇒ flag off
    expect(result.state).toBe("ready");
    expect(events.some((e) => e.type === "workflow-wave")).toBe(false);
    expect(events.some((e) => e.type === "workflow-step")).toBe(false);
  });
});

// ── (b) flag-ON default template reproduces today ────────────────────────────
describe("(b) flag-ON + default template === today (via the runner)", () => {
  test("same terminal 'ready' / one attempt / one green verdict as the flag-off control, THROUGH the runner, never 'done'", async () => {
    // Control (flag off).
    const ctrl = await driveToReady(makeGitProject().name);

    // Flag on (env), same fixture + same opts.
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const on = await driveToReady(makeGitProject().name);

    // Behaviorally identical outcome.
    expect(on.result.state).toBe(ctrl.result.state);
    expect(on.result.state).toBe("ready");
    expect(on.loom.attempts.length).toBe(ctrl.loom.attempts.length);
    expect(on.loom.attempts.length).toBe(1);
    expect(on.events.filter((e) => e.type === "verdict").length).toBe(ctrl.events.filter((e) => e.type === "verdict").length);
    expect(on.events.filter((e) => e.type === "verdict").length).toBe(1);

    // Went through the runner: exactly one wave delegating the single "build" step.
    const waves = on.events.filter((e) => e.type === "workflow-wave");
    expect(waves.length).toBe(1);
    expect(waves[0]!.stepIds).toEqual(["build"]);
    const stepEvents = on.events.filter((e) => e.type === "workflow-step");
    expect(stepEvents.length).toBe(1);
    expect(stepEvents[0]!.stepId).toBe("build");
    // Moat: the runner never self-accepts to 'done'; the delegated executeLoom set 'ready'.
    expect(on.result.state).not.toBe("done");
    // Control took the OLD path (no workflow events) — proving the seam is what diverged.
    expect(ctrl.events.some((e) => e.type === "workflow-wave")).toBe(false);
  });
});

// ── (c) DAG runs in dependency order ─────────────────────────────────────────
describe("(c) step DAG executes in dependency order", () => {
  test("B(dependsOn A) never starts until A is recorded done; independent A & C overlap", async () => {
    const order: string[] = [];
    const runStep = async (s: Step): Promise<StepResult> => {
      order.push(`${s.id}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${s.id}:end`);
      return { id: s.id, ok: true, state: "ready" };
    };
    const workflow: ThreadWorkflow = {
      version: 1,
      steps: [step("A"), step("B", ["A"]), step("C")],
    };
    const loom = fakeLoom({ workflow });
    await runThreadWorkflow(loom, noManifest, { runStep });

    // Dependency edge: A fully done before B starts.
    expect(order.indexOf("A:end")).toBeLessThan(order.indexOf("B:start"));
    // Independent A & C run in the same first wave: both start before either ends.
    const firstEnd = Math.min(order.indexOf("A:end"), order.indexOf("C:end"));
    expect(order.indexOf("A:start")).toBeLessThan(firstEnd);
    expect(order.indexOf("C:start")).toBeLessThan(firstEnd);
    // B is strictly last (its whole span is after A:end).
    expect(order).toEqual(expect.arrayContaining(["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]));
    expect(order.indexOf("B:start")).toBeGreaterThan(order.indexOf("C:end"));
  });

  test("a non-green step (ok:false) halts the DAG — the dependent never runs, loom fails closed", async () => {
    const seen: string[] = [];
    const runStep = async (s: Step): Promise<StepResult> => {
      seen.push(s.id);
      return { id: s.id, ok: s.id !== "A", state: s.id === "A" ? "failed" : "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A"), step("B", ["A"])] } });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(seen).toEqual(["A"]); // B never scheduled
    expect(out).toBe(loom); // runner returns the same loom object
    expect(out.state).toBe("failed"); // BLOCKER 1: the non-green step fails the loom closed
  });

  // ── FIX 1: unschedulable DAG fails closed instead of returning pre-execution loom ──
  test("dependsOn CYCLE (A<->B): no step is ever schedulable — runner fails closed, not silently returns the queued loom", async () => {
    const seen: string[] = [];
    const runStep = async (s: Step): Promise<StepResult> => {
      seen.push(s.id);
      return { id: s.id, ok: true, state: "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A", ["B"]), step("B", ["A"])] } });
    expect(loom.state).toBe("queued"); // pre-execution baseline the bug would silently return
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(seen).toEqual([]); // neither step ever became ready
    expect(out).toBe(loom);
    expect(out.state).toBe("failed"); // NOT left as "queued"
    expect(out.error).toBe("unschedulable step DAG: dependsOn cycle or unreachable dependency");
  });

  test("unreachable dependency (B dependsOn a nonexistent step): A completes, B can never schedule — fails closed", async () => {
    const seen: string[] = [];
    const runStep = async (s: Step): Promise<StepResult> => {
      seen.push(s.id);
      return { id: s.id, ok: true, state: "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A"), step("B", ["missing"])] } });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(seen).toEqual(["A"]); // A ran; B never became ready
    expect(out).toBe(loom);
    expect(out.state).toBe("failed");
    expect(out.error).toBe("unschedulable step DAG: dependsOn cycle or unreachable dependency");
  });

  test("idempotent: does NOT clobber a terminal failure a delegated step already wrote before getting stuck", async () => {
    const runStep = async (s: Step): Promise<StepResult> => {
      if (s.id === "A") {
        // Simulate a delegated executeLoom that already recorded its own
        // terminal failure as a side effect (as the real defaultRunStep's
        // executeLoom call does via loom.state/loom.error) — reported ok so
        // the runner still tries to schedule the (unreachable) next step.
        loom.state = "needs-review";
        loom.error = "verification flaky";
      }
      return { id: s.id, ok: true, state: "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A"), step("B", ["missing"])] } });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out).toBe(loom);
    // The fail-closed guard must NOT overwrite the already-terminal state/error.
    expect(out.state).toBe("needs-review");
    expect(out.error).toBe("verification flaky");
  });
});

// ── (d) independent steps in a wave run concurrently ─────────────────────────
describe("(d) within-wave steps run in PARALLEL (Promise.all, not sequential)", () => {
  test("two independent steps both enter before either completes (a barrier that deadlocks under a sequential for-await)", async () => {
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const runStep = async (s: Step): Promise<StepResult> => {
      entered++;
      if (entered === 2) release(); // only unblocks once BOTH have entered
      await barrier;
      return { id: s.id, ok: true, state: "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("g1"), step("g2")] } });

    // If the runner awaited each step sequentially, g2 would never enter, the
    // barrier would never release, and this would hang → race gives a clean fail.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock: steps ran sequentially, not in parallel")), 1000));
    await Promise.race([runThreadWorkflow(loom, noManifest, { runStep }), timeout]);
    expect(entered).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M9.2 — the general per-step fan-out primitive + CF1 clamp + CF2 verifier guard.
// (a) disjoint-writer 2-agent merge; (b) stray write fails the step closed;
// (c) two independent built-in free steps overlap in parallel; (d) the pool-slice
// clamp bounds total concurrency (wave × agents-per-step); (e) CF2 refuses a green
// writing step with no verifier proof; (f) a free step fans out with NO partition/
// merge. Tests (a)/(b)/(f... actually f is direct) that need the REAL executeLoom
// go through the flag-routed executeLoom; the rest drive runThreadWorkflow directly.
// ═════════════════════════════════════════════════════════════════════════════

// A builder that WRITES OUTSIDE its allowedPaths for the a.txt piece (a stray the
// disjoint merge must drop, failing the step closed) and builds normally otherwise.
const strayBuilder = (async (prompt: string, o: any) => {
  const f = fileFromPrompt(prompt);
  if (f === "a.txt") {
    fs.writeFileSync(path.join(o.cwd, "c.txt"), "stray\n"); // outside ["a.txt"]
    return { ok: true, summary: "wrote stray c.txt", files_touched: ["c.txt"], blocker: null };
  }
  fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
  return { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
}) as any;

// The two disjoint-writer agents used by the writing-fanout tests — same shape as
// twoDisjoint (BuildPiece), proving AgentSpec is a field-for-field superset.
const twoDisjointAgents = [
  { id: "s1", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
  { id: "s2", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
];

// ── (a) writing fan-out: 2 disjoint-writer agents merge non-overlapping edits ──
describe("(a) disjoint-writer step fans out, merges disjointly, verifies ONCE, lands 'ready'", () => {
  test("both agents' non-overlapping files land on the root; one fanout(pieces:2); workflow-step ready; never 'done'", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name, root } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    loom.workflow = {
      version: 1,
      steps: [
        { id: "build", goal: "g", kind: "build", partition: "disjoint-writer", agents: twoDisjointAgents, dependsOn: [] },
      ],
    };
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, {
      run: fakeBuilder,
      onEvent: (ev) => events.push(ev),
      onState: () => {},
    });

    // MOAT: a completed ROOT loom lands 'ready' (awaiting the human acceptLoom) — never self-accepts to 'done'.
    expect(result.state).toBe("ready");
    expect(result.state).not.toBe("done");
    // The fan-out actually ran N builders (via the M6 seam) and merged BOTH files onto the root.
    expect(events.some((e) => e.type === "fanout" && e.pieces === 2)).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("built a.txt\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("built b.txt\n");
    // Exactly one attempt ⇒ the merged tree went through the SAME single gate+verify+decide path.
    expect(loom.attempts.length).toBe(1);
    // Went through the runner: one workflow-step for "build" reporting ready.
    const stepEvents = events.filter((e) => e.type === "workflow-step");
    expect(stepEvents.length).toBe(1);
    expect(stepEvents[0]!.stepId).toBe("build");
    expect(stepEvents[0]!.state).toBe("ready");
  });
});

// ── (b) stray write outside allowedPaths FAILS the step closed ────────────────
describe("(b) a stray write outside a disjoint-writer agent's allowedPaths fails the step closed", () => {
  test("mergeDisjoint drops the stray ⇒ runBuildFanout.ok=false ⇒ no promotion; blocker names the stray; c.txt never lands on root", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name, root } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    loom.workflow = {
      version: 1,
      steps: [
        { id: "build", goal: "g", kind: "build", partition: "disjoint-writer", agents: twoDisjointAgents, dependsOn: [] },
      ],
    };
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, {
      run: strayBuilder,
      onEvent: (ev) => events.push(ev),
      onState: () => {},
    });

    // Fail closed — a lossy (stray-dropping) merge is NEVER promoted.
    expect(result.state).not.toBe("ready");
    expect(result.state).not.toBe("done");
    // The blocker surfaced on the combined verdict names the dropped stray.
    expect(
      events.some((e) => e.type === "verdict" && /stray files outside allowedPaths/.test(String((e.verdict as any)?.blocker))),
    ).toBe(true);
    // The out-of-lane write was dropped by the merge — it never reaches the real repo root.
    expect(fs.existsSync(path.join(root, "c.txt"))).toBe(false);
  });
});

// ── (c) two independent built-in FREE steps run concurrently ──────────────────
describe("(c) two independent free steps run in PARALLEL through the built-in step executor", () => {
  test("both agents enter before either returns (a barrier that deadlocks under a sequential wave)", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    // Injected AGENT (opts.run), not opts.runStep — so the wave runs through the
    // real defaultRunStep → runFreeStepFanout free path, not a stub.
    const run = (async () => {
      entered++;
      if (entered === 2) release(); // unblocks only once BOTH agents have entered
      await barrier;
      return { ok: true, summary: "", files_touched: [], blocker: null };
    }) as any;
    const loom = fakeLoom({
      workflow: {
        version: 1,
        steps: [
          { id: "g1", goal: "g1", kind: "research", partition: "free", agents: [{ id: "a1", title: "A1", prompt: "look", allowedPaths: [] }], dependsOn: [] },
          { id: "g2", goal: "g2", kind: "research", partition: "free", agents: [{ id: "a2", title: "A2", prompt: "look", allowedPaths: [] }], dependsOn: [] },
        ],
      },
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock: free steps ran sequentially, not in parallel")), 1000));
    await Promise.race([runThreadWorkflow(loom, noManifest, { run }), timeout]);
    expect(entered).toBe(2);
  });
});

// ── (d) the pool-slice clamp bounds total concurrency (wave × agents-per-step) ─
describe("(d) per-step clamp keeps total concurrency <= the shared pool", () => {
  test("maxAgents:6, 3 free steps × 4 agents each — observed max concurrent agents <= 6 (never 3×4=12)", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    let inFlight = 0;
    let maxObserved = 0;
    const run = (async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, summary: "", files_touched: [], blocker: null };
    }) as any;
    const agents = (n: string) => [0, 1, 2, 3].map((i) => ({ id: `${n}-${i}`, title: `${n}${i}`, prompt: "look", allowedPaths: [] }));
    const loom = fakeLoom({
      // charter budget caps the shared pool at 6 (CF1 real cap would be 12 without it).
      charter: { budget: { maxAgents: 6 } } as any,
      workflow: {
        version: 1,
        steps: [
          { id: "g1", goal: "g1", kind: "research", partition: "free", agents: agents("g1"), dependsOn: [] },
          { id: "g2", goal: "g2", kind: "research", partition: "free", agents: agents("g2"), dependsOn: [] },
          { id: "g3", goal: "g3", kind: "research", partition: "free", agents: agents("g3"), dependsOn: [] },
        ],
      },
    });
    await runThreadWorkflow(loom, noManifest, { run });
    // wave = fanoutSize(3, {maxAgents:6}) = 3 steps; perStepClamp = floor(6/3) = 2 agents/step ⇒ 3×2 = 6.
    expect(maxObserved).toBeLessThanOrEqual(6);
    expect(maxObserved).toBeGreaterThan(0);
  });
});

// ── (e) CF2 — a green WRITING step with no verifier proof is refused ──────────
describe("(e) CF2 verifier guard: an injected runStep cannot promote a WRITING loom to green without proof", () => {
  test("build step reporting {ok:true,state:'ready'} with no verifier/panel/gates proof ⇒ fail closed", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const runStep = async (s: Step): Promise<StepResult> => ({ id: s.id, ok: true, state: "ready" });
    const loom = fakeLoom({
      workflow: { version: 1, steps: [{ id: "w", goal: "g", kind: "build", partition: "disjoint-writer", agents: [], dependsOn: [] }] },
    });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out).toBe(loom);
    expect(out.state).toBe("failed");
    expect(out.error).toMatch(/reported green without verifier proof/);
  });

  test("CONTROL: the SAME proofless green result for a NON-WRITING (research) step is exempt and passes", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const runStep = async (s: Step): Promise<StepResult> => ({ id: s.id, ok: true, state: "ready" });
    const loom = fakeLoom({
      workflow: { version: 1, steps: [{ id: "r", goal: "g", kind: "research", partition: "free", agents: [], dependsOn: [] }] },
    });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out.state).not.toBe("failed");
    expect(out.error).toBeNull(); // CF2 never fired — the loom was left untouched
  });
});

// ── (f) a non-writing FREE step fans out with NO partition/merge ──────────────
describe("(f) free fan-out skips the disjoint-writer machinery entirely", () => {
  test("a 'design' step with OVERLAPPING allowedPaths fans both agents out ok — no piecesAreDisjoint gate, no fanout/merge", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    let calls = 0;
    const run = (async () => {
      calls++;
      return { ok: true, summary: "", files_touched: [], blocker: null };
    }) as any;
    const loom = fakeLoom({
      workflow: {
        version: 1,
        steps: [
          {
            id: "d",
            goal: "g",
            kind: "design",
            partition: "free",
            // OVERLAPPING paths — would be rejected by piecesAreDisjoint on the writing path.
            agents: [
              { id: "a1", title: "A1", prompt: "design x", allowedPaths: ["a.txt"] },
              { id: "a2", title: "A2", prompt: "design y", allowedPaths: ["a.txt"] },
            ],
            dependsOn: [],
          },
        ],
      },
    });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const out = await runThreadWorkflow(loom, noManifest, { run, onEvent: (ev) => events.push(ev) });

    // Both agents fanned out despite overlap — the disjoint-writer gate never runs for a free step.
    expect(calls).toBe(2);
    // No writing-path artifacts: no fan-out merge, no combined verdict.
    expect(events.some((e) => e.type === "fanout")).toBe(false);
    expect(events.some((e) => e.type === "verdict")).toBe(false);
    // The step reached the free-step 'ready' scheduling signal; the loom itself is never promoted here.
    const stepEvents = events.filter((e) => e.type === "workflow-step");
    expect(stepEvents.length).toBe(1);
    expect(stepEvents[0]!.stepId).toBe("d");
    expect(stepEvents[0]!.state).toBe("ready");
    expect(out.state).not.toBe("failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M9.2 fail-open blockers — the two moat holes closed here:
//  (B1) a LATER failing step must fail the LOOM closed even after an EARLIER step
//       already went green (else the earlier green is handed back as a false green);
//  (B2) CF2 trusts a writing-step green's proof by PROVENANCE (the built-in path
//       fills it from executeLoom's real verifier), NEVER a custom executor's own
//       self-reported proof fields.
// ═════════════════════════════════════════════════════════════════════════════

// A disjoint-writer "early" build step (mirrors (a)) that drives the REAL
// executeLoom to 'ready' — the green loom.state a later failure must not mask.
const disjointGreenStep = (id: string, dependsOn: string[] = []): Step => ({
  id,
  goal: "g",
  kind: "build",
  partition: "disjoint-writer",
  agents: twoDisjointAgents,
  dependsOn,
});

describe("BLOCKER 1 — a later failing step fails the loom CLOSED (no false-green from an earlier green step)", () => {
  test("writing partition-overlap failure AFTER an earlier disjoint-writer green ⇒ loom ends 'failed', not 'ready'", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    loom.workflow = {
      version: 1,
      steps: [
        disjointGreenStep("early"),
        // late: disjoint-writer with OVERLAPPING allowedPaths ⇒ defaultRunStep's
        // piecesAreDisjoint gate returns {ok:false,state:"failed"} WITHOUT ever
        // re-entering executeLoom, so loom.state stays "ready" from `early`.
        {
          id: "late",
          goal: "g",
          kind: "build",
          partition: "disjoint-writer",
          dependsOn: ["early"],
          agents: [
            { id: "x", title: "X", prompt: "x", allowedPaths: ["a.txt"] },
            { id: "y", title: "Y", prompt: "y", allowedPaths: ["a.txt"] }, // overlaps x
          ],
        },
      ],
    };
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, { run: fakeBuilder, onEvent: (ev) => events.push(ev), onState: () => {} });

    const stepEvents = events.filter((e) => e.type === "workflow-step");
    // `early` genuinely went green FIRST (so the masking bug would apply)…
    expect(stepEvents.find((e) => e.stepId === "early")?.state).toBe("ready");
    // …but the later overlap failure fails the whole loom CLOSED — never green.
    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("ready");
    expect(result.state).not.toBe("done");
    expect(result.error).toMatch(/step "late" failed/);
  });

  test("failing free `check` step AFTER an earlier disjoint-writer green ⇒ loom ends 'failed', not 'ready'", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    loom.workflow = {
      version: 1,
      steps: [
        disjointGreenStep("early"),
        {
          id: "gate",
          goal: "g",
          kind: "check",
          partition: "free",
          dependsOn: ["early"],
          agents: [{ id: "c", title: "Check", prompt: "verify the build", allowedPaths: [] }],
        },
      ],
    };
    // ONE injected agent for BOTH roles: the disjoint-writer builders (their
    // prompt carries "modify files under") write + pass; the free check agent fails.
    const run = (async (prompt: string, o: any) => {
      if (/modify files under/.test(prompt)) {
        const f = fileFromPrompt(prompt);
        fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
        return { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
      }
      return { ok: false, summary: "check failed", files_touched: [], blocker: "the check found a problem" };
    }) as any;
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, { run, onEvent: (ev) => events.push(ev), onState: () => {} });

    const stepEvents = events.filter((e) => e.type === "workflow-step");
    expect(stepEvents.find((e) => e.stepId === "early")?.state).toBe("ready"); // early went green
    expect(stepEvents.find((e) => e.stepId === "gate")?.state).toBe("failed"); // check reported failed (loom untouched)
    // BLOCKER 1: the free-step failure fails the loom CLOSED instead of leaving "ready".
    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("ready");
    expect(result.error).toMatch(/step "gate" failed/);
  });
});

describe("BLOCKER 2 — CF2 trusts a writing green by PROVENANCE (built-in), never a custom executor's self-report", () => {
  test("injected runStep's WRITING green with a FABRICATED verifierReport is REFUSED (fail closed, not promoted)", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    // A custom executor forges a truthy proof field — presence alone would have
    // promoted the loom under the old check. Provenance must refuse it.
    const runStep = async (s: Step): Promise<StepResult> => ({ id: s.id, ok: true, state: "ready", verifierReport: {} as any });
    const loom = fakeLoom({
      workflow: { version: 1, steps: [{ id: "w", goal: "g", kind: "build", partition: "disjoint-writer", agents: [], dependsOn: [] }] },
    });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out).toBe(loom);
    expect(out.state).toBe("failed"); // NOT promoted on a self-reported proof
    expect(out.state).not.toBe("ready");
    expect(out.error).toMatch(/custom step executor cannot self-certify/);
  });

  test("CONTROL: the built-in default path's GENUINE writing green (real executeLoom verifier) is still ACCEPTED", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    loom.workflow = { version: 1, steps: [disjointGreenStep("build")] };
    const result = await executeLoom(loom, manifest, { run: fakeBuilder, onState: () => {} });
    // usedBuiltinExecutor + a real gates/verifier proof ⇒ CF2 accepts the green.
    expect(result.state).toBe("ready");
    expect(result.state).not.toBe("failed");
    expect(result.error).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M9.2 deeper moat holes (adversarial re-verification):
//  (HOLE A) SIDE-CHANNEL GREEN — a step executor gets ctx.loom by REFERENCE and
//    can set ctx.loom.state="ready" directly, then return a StepResult that dodges
//    every per-step guard (e.g. {ok:true,state:"skipped"}). The FINAL PROVENANCE
//    GATE fails any terminal-green loom closed unless a TRUSTED writing-step green
//    (built-in executor + real executeLoom proof) was produced this run.
//  (HOLE B) SHARED-LOOM CONCURRENCY RACE — two independent built-in WRITING steps
//    in one wave calling executeLoom(ctx.loom,…) concurrently let a failing step's
//    delegate read a sibling's success (false green). Built-in writing-delegate
//    steps are SERIALIZED within a wave so each read reflects only its own step.
// ═════════════════════════════════════════════════════════════════════════════

describe("HOLE A — FINAL PROVENANCE GATE: a side-channel loom green with no trusted writing step fails closed", () => {
  test("injected runStep MUTATES ctx.loom.state='ready' and returns {ok:true,state:'skipped'} (dodges CF2) ⇒ loom ends FAILED", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const loom = fakeLoom({
      workflow: { version: 1, steps: [{ id: "w", goal: "g", kind: "build", partition: "disjoint-writer", agents: [], dependsOn: [] }] },
    });
    // The proven PoC: side-channel the shared loom green, then return a StepResult
    // that dodges every per-step guard — !res.ok is false (BLOCKER 1 skips),
    // state:"skipped" makes terminalGreen false (CF2 never evaluates).
    const runStep = async (s: Step): Promise<StepResult> => {
      loom.state = "ready";
      return { id: s.id, ok: true, state: "skipped" };
    };
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out).toBe(loom);
    expect(out.state).toBe("failed"); // the final provenance gate caught the side-channel green
    expect(out.state).not.toBe("ready");
    expect(out.state).not.toBe("done");
    expect(out.error).toMatch(/without a verifier-backed writing step/);
  });

  test("injected runStep returns {ok:true,state:'ready',verifierReport:{}} (forged proof) even with a side-channel ⇒ FAILED", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const loom = fakeLoom({
      workflow: { version: 1, steps: [{ id: "w", goal: "g", kind: "build", partition: "disjoint-writer", agents: [], dependsOn: [] }] },
    });
    // A forged proof on an injected executor's writing-green: CF2 refuses it by
    // provenance (a custom executor can never self-certify); the side-channel green
    // it also leaves would additionally trip the final gate. Either way: fail closed.
    const runStep = async (s: Step): Promise<StepResult> => {
      loom.state = "ready";
      return { id: s.id, ok: true, state: "ready", verifierReport: {} as any };
    };
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out).toBe(loom);
    expect(out.state).toBe("failed");
    expect(out.state).not.toBe("ready");
    expect(out.state).not.toBe("done");
    expect(out.error).toMatch(/self-certify|without a verifier-backed writing step/);
  });
});

describe("HOLE B — built-in writing-delegate steps in one wave are SERIALIZED (no shared-loom race)", () => {
  test("two independent kind:'build' steps (A fails, B succeeds): loom ends FAILED and the two executeLoom delegates never overlap", async () => {
    process.env.TELAR_THREAD_WORKFLOW = "1";
    const { name } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "build a and b", account: manifest.account });
    // Two INDEPENDENT (dependsOn:[]) disjoint-writer build steps land in the SAME
    // wave; each delegates to executeLoom on the SHARED loom. Distinguished by a
    // "STEPA"/"STEPB" marker carried in the piece prompt.
    const stepAAgents = [
      { id: "a1", title: "A1", prompt: "STEPA edit a", allowedPaths: ["a.txt"] },
      { id: "a2", title: "A2", prompt: "STEPA edit b", allowedPaths: ["b.txt"] },
    ];
    const stepBAgents = [
      { id: "b1", title: "B1", prompt: "STEPB edit a", allowedPaths: ["a.txt"] },
      { id: "b2", title: "B2", prompt: "STEPB edit b", allowedPaths: ["b.txt"] },
    ];
    loom.workflow = {
      version: 1,
      steps: [
        { id: "A", goal: "g", kind: "build", partition: "disjoint-writer", agents: stepAAgents, dependsOn: [] },
        { id: "B", goal: "g", kind: "build", partition: "disjoint-writer", agents: stepBAgents, dependsOn: [] },
      ],
    };

    // Step-granularity overlap detector: a MULTISET of active step-groups (both
    // pieces of the SAME step legitimately overlap ⇒ one distinct group). If the
    // two executeLoom delegates ran concurrently, BOTH groups would be active at
    // once ⇒ maxDistinctGroups === 2. Serialized ⇒ it never exceeds 1.
    const groupCounts: Record<string, number> = { A: 0, B: 0 };
    const groupsRun = new Set<string>();
    let maxDistinctGroups = 0;
    const distinctActive = () => (groupCounts.A > 0 ? 1 : 0) + (groupCounts.B > 0 ? 1 : 0);
    const raceBuilder = (async (prompt: string, o: any) => {
      const g = /STEPA/.test(prompt) ? "A" : "B";
      groupsRun.add(g);
      groupCounts[g]!++;
      maxDistinctGroups = Math.max(maxDistinctGroups, distinctActive());
      await new Promise((r) => setTimeout(r, 15)); // widen the overlap window
      const f = fileFromPrompt(prompt);
      let result: any;
      if (g === "A") {
        // Step A fails: its pieces report a non-green verdict ⇒ runBuildFanout.ok=false.
        result = { ok: false, summary: "step A failed", files_touched: [], blocker: "step A intentional failure" };
      } else {
        // Step B genuinely succeeds — the real green whose loom.state a race could
        // let A's delegate read as its own.
        fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
        result = { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
      }
      groupCounts[g]!--;
      return result;
    }) as any;

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await executeLoom(loom, manifest, {
      run: raceBuilder,
      maxAttempts: 1,
      onEvent: (ev) => events.push(ev),
      onState: () => {},
    });

    // Both delegates genuinely ran (B's success was real and COULD have masked A).
    expect(groupsRun.has("A")).toBe(true);
    expect(groupsRun.has("B")).toBe(true);
    // Serialized: the two executeLoom-delegating steps never overlapped.
    expect(maxDistinctGroups).toBe(1);
    // A's failure is NEVER masked by B's success — the loom fails closed.
    expect(result.state).toBe("failed");
    expect(result.state).not.toBe("ready");
    expect(result.state).not.toBe("done");
    expect(result.error).toMatch(/step "A" failed/);
  });
});
