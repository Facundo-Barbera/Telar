// M11 finding 8 — blocked propagation as an awaiting-human PAUSE, not a failure.
// Ground truth (run #3, loom_mriuu8la_lrtwxx / child loom_mrjgch8b_g9r7g4): a child
// PARKED `blocked` via the breaker ("Unfixable gate after 2 attempts …"), but the
// step runner's BLOCKER 1 coerced "blocked"→"failed", the weave rolled up failed,
// and the awaiting-human question was swallowed. These tests pin the four seams of
// the fix so the ask propagates root-ward and the human can answer it:
//   (A) runThreadWorkflow — a parked step returns the loom `blocked`, NOT failed
//       (with a provenance guard so a forged blocked still fails closed);
//   (B) rollupWeave — a required blocked child rolls up `blocked` (failed still wins);
//   (C) runWeave — the root lifts the child's blockedReason/Question + lane-escalation
//       and does NOT run integration verify;
//   (D) tick — a settled blocked required thread yields an honest parking escalate;
//   (F) recovery sweep — a blocked root and a blocked child are both left untouched.
// These tests exercise the pure/seam functions directly (no flag needed), the same
// way m9-thread-workflow.test.ts drives runThreadWorkflow with an injected runStep.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// runWeave now appends a loom-owned line to the usage ledger as each child
// settles, so this suite MUST hold its own state root — unpinned it would
// write into the developer's real ~/.telar (weave.test.ts idiom).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-blocked-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
import type { Loom } from "../src/looms";
import type { StepResult } from "../src/executor";
import type { Charter, ProjectManifest, Step, SubGoal } from "../src/schemas";
import type { LedgerView, ThreadView } from "../src/tick";

const { runThreadWorkflow } = await import("../src/executor");
const { rollupWeave, runWeave } = await import("../src/weave");
const { tick, MEDIATION_BUDGET } = await import("../src/tick");
const { sweep, reconcileState } = await import("../src/runner/recover");

// ── shared fakes (mirror m9-thread-workflow / weave test builders) ──────────────
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
function subGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: overrides.id ?? "s1",
    title: "title",
    detail: "detail",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...overrides,
  };
}

// ── (A) runThreadWorkflow — a parked step is a PAUSE, not a step failure ─────────
describe("(A) runThreadWorkflow: a step that parks the loom `blocked` returns blocked, not failed", () => {
  test("a delegate that parks the SAME loom object (loom.state==='blocked') → out stays blocked; workflow-step-blocked emitted", async () => {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A")] } });
    // Model the built-in delegateToExecuteLoom breaker park: it mutates the SAME
    // loom object to `blocked` with the answerable question, then reports ok:false.
    const runStep = async (s: Step): Promise<StepResult> => {
      loom.state = "blocked";
      loom.blockedReason = "Unfixable gate after 2 attempts: test-suite-green failed byte-identically";
      loom.blockedQuestion = "what command proves this package is green?";
      return { id: s.id, ok: false, state: "blocked" };
    };
    const out = await runThreadWorkflow(loom, noManifest, { runStep, onEvent: (e) => events.push(e) });
    expect(out).toBe(loom); // same object handed back
    expect(out.state).toBe("blocked"); // NOT coerced to failed (run #3's swallow)
    expect(out.blockedQuestion).toBe("what command proves this package is green?");
    expect(events.some((e) => e.type === "workflow-step-blocked" && e.stepId === "A")).toBe(true);
    // The park is a PAUSE — the fail-close error/state events must NOT fire.
    expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(false);
  });

  test("PROVENANCE GUARD: a FORGED {ok:false,state:'blocked'} that did NOT park the loom falls through to fail-closed", async () => {
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A")] } });
    // An injected runStep claims blocked but leaves loom.state === "queued" (never
    // parked). The loom.state==="blocked" conjunct must reject it → fail closed.
    const runStep = async (s: Step): Promise<StepResult> => ({ id: s.id, ok: false, state: "blocked" });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out.state).toBe("failed"); // forged blocked cannot masquerade as a real park
  });

  test("narrow scoping preserved: a non-blocked failure (state:'failed') still coerces the loom failed", async () => {
    const loom = fakeLoom({ workflow: { version: 1, steps: [step("A")] } });
    const runStep = async (s: Step): Promise<StepResult> => ({ id: s.id, ok: false, state: "failed" });
    const out = await runThreadWorkflow(loom, noManifest, { runStep });
    expect(out.state).toBe("failed");
    expect(out.error).toBe(`step "A" failed: terminated non-green (state "failed")`);
  });
});

// ── (B) rollupWeave — a required blocked child rolls up blocked; failed still wins ─
describe("(B) rollupWeave: blocked propagates, failed dominates, blocked beats not-done", () => {
  test("a required blocked child → {state:'blocked'} (not needs-review)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "blocked" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("blocked");
    expect(r.error).toBe("s2: blocked");
  });

  test("failed + blocked siblings → failed WINS (a genuinely failed child still fails the weave), error enumerates BOTH (Cut 0 FIX 1: never a single-id short-circuit)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "failed" }),
      fakeLoom({ subGoalId: "s2", state: "blocked" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("failed");
    expect(r.error).toBe("s1: failed; s2: blocked");
  });

  test("done + blocked → blocked (NOT ready): a parked required child is not complete", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "blocked" }),
    ];
    expect(rollupWeave(children, decomposition).state).toBe("blocked");
  });

  test("a NON-required blocked child while every required is done → ready (unchanged §A)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "blocked" }),
    ];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "ready" });
  });
});

// ── (C) runWeave — the root LIFTS the child's question + escalation, skips verify ─
describe("(C) runWeave: a blocked child lifts blockedReason/Question onto the root", () => {
  test("root lands blocked carrying the child's question + lane-escalation(childId,subGoalId); integration verify does NOT run", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let verifyCalls = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "blocked";
        child.blockedReason = "Unfixable gate after 2 attempts";
        child.blockedQuestion = "what command proves this package is green?";
        return child;
      },
      // Gated on r.state==='ready' — a blocked rollup must SKIP it (nothing to verify).
      runIntegrationVerify: async () => {
        verifyCalls++;
        return { verification: "pass", gatesOk: true };
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.state).toBe("blocked");
    expect(result.blockedReason).toBe("Unfixable gate after 2 attempts");
    expect(result.blockedQuestion).toBe("what command proves this package is green?");
    const esc = events.find((e) => e.type === "lane-escalation");
    expect(esc).toBeTruthy();
    expect(esc!.by).toBe("telar");
    expect(esc!.subGoalId).toBe("s1");
    expect(typeof esc!.childId).toBe("string");
    // INFORMATIONAL integration verify is a ready-only step — never run for a park.
    expect(verifyCalls).toBe(0);
    // rollup event still fires with the blocked state.
    expect(events.some((e) => e.type === "weave-rollup" && e.state === "blocked")).toBe(true);
  });
});

// ── (D) tick — a settled blocked required thread is MEDIATED, then parks ─────────
// B2 (§22-24,§62): a blocked required thread is no longer an IMMEDIATE
// human-park escalate — the orchestrator re-derives it first, and only escalates
// the awaiting-human park once mediation is exhausted (the final valve, §73-74).
describe("(D) tick: a required blocked thread mediates first, then parks awaiting-human", () => {
  function view(threads: ThreadView[], decomposition: SubGoal[]): LedgerView {
    const charter: Charter = {
      objective: "o",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
      decomposition,
      version: 1,
    };
    return {
      charter,
      threads,
      inFlight: threads.filter((t) => t.runnerInFlight).length,
      budget: { maxAgents: 12, inFlight: 0, spentUsd: 0, startedAtMs: 0 },
      decisionLogTail: [],
      nowMs: 1000,
    };
  }

  test("settled blocked required thread (attempts 0) → repair (mediate before any park)", () => {
    const decomposition = [subGoal({ id: "s1" })];
    const threads: ThreadView[] = [{ id: "c1", subGoalId: "s1", state: "blocked", runnerInFlight: false }];
    const { decision, rationale } = tick(view(threads, decomposition));
    expect(decision.action).toBe("repair");
    expect((decision as { threadId: string }).threadId).toBe("c1");
    expect(rationale.summary).toContain("mediating s1 (blocked)");
  });

  test("settled blocked required thread whose mediation is EXHAUSTED → escalate '… awaiting human — parking'", () => {
    const decomposition = [subGoal({ id: "s1" })];
    const threads: ThreadView[] = [
      { id: "c1", subGoalId: "s1", state: "blocked", runnerInFlight: false, mediationAttempts: MEDIATION_BUDGET },
    ];
    const { decision, rationale } = tick(view(threads, decomposition));
    expect(decision.action).toBe("escalate");
    expect((decision as { reason: string }).reason).toBe("s1 awaiting human — parking");
    expect(rationale.summary).toContain("parked blocked");
  });

  test("failed is surfaced before blocked in tick (a failed required thread mediates first)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const threads: ThreadView[] = [
      { id: "c1", subGoalId: "s1", state: "failed", runnerInFlight: false },
      { id: "c2", subGoalId: "s2", state: "blocked", runnerInFlight: false },
    ];
    const { decision } = tick(view(threads, decomposition));
    expect(decision.action).toBe("repair");
    expect((decision as { threadId: string }).threadId).toBe("c1"); // the failed thread first
  });
});

// ── (F) recovery sweep — blocked root AND blocked child both left untouched ──────
describe("(F) recovery: a blocked root and a blocked child both survive a boot sweep", () => {
  test("reconcileState('blocked') === 'leave' — awaiting a human by design, never reaped", () => {
    expect(reconcileState("blocked")).toBe("leave");
  });

  test("sweep leaves a blocked ROOT and a blocked CHILD untouched (no resume/queued/halt applied)", () => {
    const root = fakeLoom({ state: "blocked" });
    const child = fakeLoom({ state: "blocked", parentLoomId: root.id, subGoalId: "s1" });
    const touched: string[] = [];
    const applied = sweep([root, child], () => false /* nothing live */, {
      resume: (l) => touched.push(`resume:${l.id}`),
      queued: (l) => touched.push(`queued:${l.id}`),
      halt: (l) => touched.push(`halt:${l.id}`),
    });
    // Root: reconcileState → "leave" (no-op). Child: parentLoomId → skipped.
    expect(applied).toEqual([]);
    expect(touched).toEqual([]);
    // Neither loom was mutated off `blocked`.
    expect(root.state).toBe("blocked");
    expect(child.state).toBe("blocked");
  });

  test("control: sweep still recovers a stranded in-flight ROOT (guards the scoping above)", () => {
    const running = fakeLoom({ state: "running" });
    const halted: string[] = [];
    const applied = sweep([running], () => false, {
      resume: () => {},
      queued: () => {},
      halt: (l) => halted.push(l.id),
    });
    expect(applied.map((a) => a.action)).toEqual(["halt"]); // running → halt (resumable)
    expect(halted).toEqual([running.id]);
  });
});
