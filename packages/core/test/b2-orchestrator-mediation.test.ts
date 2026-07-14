// B2 — THE ORCHESTRATOR-MEDIATION RUNG (docs/PRINCIPLES.md §22-24,§62,§73-74;
// docs/deflag-cut-plan.md PHASE B2). Before B2 a thread escalation went STRAIGHT
// to the human: a settled non-done required child (failed / blocked /
// needs-review) parked the root awaiting a human. §22-24 require the orchestrator
// to MEDIATE FIRST — re-derive / reassign the thread — and reach the human ONLY
// when corrections are genuinely exhausted. These tests pin the three invariants
// the rung must hold:
//   (1) MEDIATION IS ATTEMPTED before any human park (tick emits `repair`;
//       runWeave re-derives via the spawnChild/runChild reassignment seam).
//   (2) IT IS BOUNDED — a thread that never recovers mediates at most
//       MEDIATION_BUDGET times, then parks; it cannot loop forever.
//   (3) A GENUINE DEAD-END STILL PARKS carrying the child's answerable question
//       (the human parks remain the final valve).
// The pure tick decisions are asserted in orchestrator.test.ts /
// m11-blocked-propagation.test.ts; here we drive the runWeave loop end-to-end
// with fakes (no disk / agents), the way orchestrator.test.ts does.
import { describe, expect, test } from "bun:test";
import type { Loom } from "../src/looms";
import type { Charter, SubGoal } from "../src/schemas";
import { MEDIATION_BUDGET, tick, validateDecision, type LedgerView, type ThreadView } from "../src/tick";
import { runWeave } from "../src/weave";

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
function charter(decomposition: SubGoal[]): Charter {
  return {
    objective: "obj",
    proofStrategy: "custom",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: { maxParallelThreads: 3, maxAgents: 12 },
    decomposition,
    version: 1,
  };
}
function ledgerView(threads: ThreadView[], decomposition: SubGoal[]): LedgerView {
  return {
    charter: charter(decomposition),
    threads,
    inFlight: threads.filter((t) => t.runnerInFlight).length,
    budget: { maxAgents: 12, inFlight: 0, spentUsd: 0, startedAtMs: 0 },
    decisionLogTail: [],
    nowMs: 1000,
  };
}

// ── (1) MEDIATION BEFORE ANY HUMAN PARK ─────────────────────────────────────────
describe("(1) B2: the orchestrator mediates a settled non-done thread before parking", () => {
  test("tick emits `repair` (not escalate) for a settled needs-review required thread with budget left", () => {
    const decomposition = [subGoal({ id: "s1" })];
    const threads: ThreadView[] = [{ id: "c1", subGoalId: "s1", state: "needs-review", runnerInFlight: false }];
    const { decision } = tick(ledgerView(threads, decomposition));
    expect(decision.action).toBe("repair");
    if (decision.action === "repair") expect(decision.threadId).toBe("c1");
  });

  test("validateDecision accepts a `repair` for a BLOCKED thread (B2 extends the repairable states)", () => {
    const decomposition = [subGoal({ id: "s1" })];
    const threads: ThreadView[] = [{ id: "c1", subGoalId: "s1", state: "blocked", runnerInFlight: false }];
    const r = validateDecision({ action: "repair", threadId: "c1" }, ledgerView(threads, decomposition));
    expect(r.ok).toBe(true);
  });

  test("runWeave: a child that first settles needs-review then DONE after one mediation → root ready; mediation ran BEFORE any park", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let attempt = 0;
    const result = await runWeave(root, decomposition, {
      // Each fresh reassignment is a new child; the FIRST run settles
      // needs-review, the reassigned re-derivation converges done.
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        attempt++;
        child.state = attempt === 1 ? "needs-review" : "done";
        return child;
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.state).toBe("ready"); // the weave recovered without a human
    // A mediate event fired for s1 (attempt 1) BEFORE any escalate/park.
    const mediate = events.find((e) => e.type === "mediate");
    expect(mediate).toBeTruthy();
    expect(mediate!.subGoalId).toBe("s1");
    expect(mediate!.attempt).toBe(1);
    expect(mediate!.priorState).toBe("needs-review");
    const mediateResult = events.find((e) => e.type === "mediate-result");
    expect(mediateResult!.state).toBe("done");
    // No human-facing park fields set — the loom converged autonomously.
    expect(result.blockedQuestion).toBeUndefined();
  });

  test("runWeave: the injected `mediateThread` dep (richer re-derive) is used when present", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    let mediateCalls = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "failed"), child),
      // The richer mediation leg repairs the thread to done in one shot.
      mediateThread: async (child) => {
        mediateCalls++;
        child.state = "done";
        return child;
      },
    });
    expect(mediateCalls).toBe(1); // consulted once, converged
    expect(result.state).toBe("ready");
  });
});

// ── (2) BOUNDEDNESS — a never-recovering thread cannot loop forever ──────────────
describe("(2) B2: mediation is BOUNDED — a thread that never recovers mediates at most MEDIATION_BUDGET times", () => {
  test("runWeave: a child that ALWAYS settles blocked → exactly MEDIATION_BUDGET mediations, then the root parks blocked", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let runs = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        runs++;
        child.state = "blocked";
        child.blockedReason = "Unfixable gate after 2 attempts";
        child.blockedQuestion = "what command proves this package is green?";
        return child;
      },
      onEvent: (e) => events.push(e),
    });
    // The final valve: the root parks blocked carrying the child's question.
    expect(result.state).toBe("blocked");
    expect(result.blockedQuestion).toBe("what command proves this package is green?");
    // BOUNDED: one initial run + exactly MEDIATION_BUDGET mediations.
    const mediations = events.filter((e) => e.type === "mediate");
    expect(mediations.length).toBe(MEDIATION_BUDGET);
    expect(runs).toBe(1 + MEDIATION_BUDGET);
    // The mediation attempt numbers are the strictly-increasing 1..BUDGET.
    expect(mediations.map((m) => m.attempt)).toEqual(
      Array.from({ length: MEDIATION_BUDGET }, (_, i) => i + 1),
    );
  });

  test("runWeave: a child that ALWAYS fails → bounded mediation, then the root ends failed/needs-review (never spins, never done)", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    const decisions: string[] = [];
    let runs = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((runs++, child.state = "failed"), child),
      onEvent: (e) => {
        if (e.type === "decision") decisions.push((e.decision as { action: string }).action);
      },
    });
    expect(["failed", "needs-review"]).toContain(result.state);
    expect(runs).toBe(1 + MEDIATION_BUDGET); // bounded
    // The decision stream mediated (repair) before it ever escalated.
    const firstRepair = decisions.indexOf("repair");
    const firstEscalate = decisions.indexOf("escalate");
    expect(firstRepair).toBeGreaterThanOrEqual(0);
    expect(firstEscalate).toBeGreaterThan(firstRepair);
    // MOAT: the weave never promoted to done, never emitted finish-loom.
    expect(decisions).not.toContain("finish-loom");
  });
});

// ── (3) A GENUINE DEAD-END STILL PARKS WITH THE QUESTION ─────────────────────────
describe("(3) B2: a genuine dead-end still parks the human with the answerable question", () => {
  test("runWeave: an always-blocked child lifts blockedReason/Question + lane-escalation onto the root; integration verify never runs", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let verifyCalls = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "blocked";
        child.blockedReason = "lane unviable: no verification target";
        child.blockedQuestion = "how should this deliverable be verified?";
        return child;
      },
      runIntegrationVerify: async () => {
        verifyCalls++;
        return { verification: "pass", gatesOk: true };
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.state).toBe("blocked");
    expect(result.blockedReason).toBe("lane unviable: no verification target");
    expect(result.blockedQuestion).toBe("how should this deliverable be verified?");
    // The parking escalation carries the originating child/subgoal for the cockpit.
    const esc = events.find((e) => e.type === "lane-escalation");
    expect(esc).toBeTruthy();
    expect(esc!.subGoalId).toBe("s1");
    // A blocked park never runs the ready-only integration verify.
    expect(verifyCalls).toBe(0);
  });

  test("runWeave: mediation that RECOVERS a blocked child converges to ready — the park is reached only when correction genuinely fails", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ charter: charter(decomposition) });
    let attempt = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        attempt++;
        // Blocked on the first pass (e.g. a lane came up late), recovered on the
        // reassignment — so the human is never reached.
        child.state = attempt === 1 ? "blocked" : "done";
        return child;
      },
    });
    expect(result.state).toBe("ready");
    expect(result.blockedQuestion).toBeUndefined();
  });
});
