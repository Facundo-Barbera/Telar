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

  test("a non-green step (ok:false) halts the DAG — the dependent never runs, loom returned as-is", async () => {
    const seen: string[] = [];
    const runStep = async (s: Step): Promise<StepResult> => {
      seen.push(s.id);
      return { id: s.id, ok: s.id !== "A", state: s.id === "A" ? "failed" : "ready" };
    };
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A"), step("B", ["A"])] } });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(seen).toEqual(["A"]); // B never scheduled
    expect(out).toBe(loom); // runner returns the same loom object; never writes its state
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
