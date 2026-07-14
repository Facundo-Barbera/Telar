// The weaver's control loop (docs/loom-orchestrator.md §6). PURE
// deterministic scheduler: tick and validateDecision take a curated
// LedgerView and return/validate a Decision — no I/O, no agent calls, no
// Date.now (the caller passes `nowMs` in). This is where the moat lives in
// the tick path: validateDecision makes "finish-loom" illegal unless every
// required subgoal's thread is state === "done".
import type { Charter, SubGoal, WorkUnitState } from "./schemas";
import {
  type BudgetState,
  type FanoutClamp,
  type PriorityRank,
  budgetLeftUsd,
  fanoutClamp,
  prioritizeScored,
  withinWallClock,
} from "./budget";

export type ThreadView = {
  id: string;
  subGoalId: string;
  state: WorkUnitState;
  latestVerdict?: string;
  // Terminality signal for the escalate path: true iff a live runner still
  // owns this thread (its runChild promise is unsettled). A `state:"failed"`
  // with runnerInFlight === true is mid-retry (transient), not a dead loom.
  // Absent ⟹ terminal (back-compat: reads identical to today).
  runnerInFlight?: boolean;
  // B2 (§22-24,§62) — orchestrator-mediation attempts ALREADY spent re-deriving
  // this settled thread. tick emits `repair` (mediation) while this is <
  // MEDIATION_BUDGET, then escalates to the human park (the final valve, §73-74).
  // Absent ⟹ 0 (an unmediated thread; back-compat reads identical to today).
  mediationAttempts?: number;
};

export type Decision =
  | { action: "schedule"; subGoalIds: string[]; agents: number }
  // B2 (§22-24,§62) — the orchestrator-mediation directive: re-derive / reassign
  // a settled non-done required thread. tick emits this while the thread's
  // mediationAttempts < MEDIATION_BUDGET (runWeave handles it, then escalates
  // once the budget is spent — the human park is the final valve).
  | { action: "repair"; threadId: string }
  | { action: "escalate"; threadId?: string; reason: string }
  | { action: "finish-loom" }
  | { action: "hold" }
  // Intra-thread Build fan-out (docs/loom-orchestrator.md §7, "Inner" axis):
  // a single thread's Build splits into `pieces` worktree-isolated builders.
  // Decided at build time (executor.ts), not by tick() itself in this phase —
  // the type + validateDecision exist now for M7.5/UI to schedule against.
  | { action: "fanout"; threadId: string; pieces: number; agents: number };

export type LedgerView = {
  charter: Charter;
  threads: ThreadView[];
  inFlight: number;
  budget: BudgetState;
  decisionLogTail: Decision[];
  nowMs: number;
};

// The budget/clock the decision was made against — a snapshot of view.budget +
// view.nowMs, atomic-consistent with the Decision tick produced.
export type BudgetSnapshot = {
  spentUsd: number;
  inFlight: number;
  maxCostUsd?: number;
  budgetLeftUsd: number; // Infinity when uncapped (serializes to null on persist)
  wallClockRemainingMs: number | null; // null when no wall-clock cap
};

// LOCKED FORK B: the WHY behind a Decision, as honest DETERMINISTIC scheduler-
// policy inputs (real numbers) — never model reasoning, never narrated prose.
// Purely COMPUTED from the LedgerView (tick stays pure); the loop contributes
// only `rejected` (validateDecision's dropped reason), since validation runs
// after tick returns.
export type Rationale = {
  summary: string; // one-line policy statement built from the numbers below
  budget: BudgetSnapshot; // (c) always present
  ranked?: PriorityRank[]; // (a) critical-path scores, when readiness was evaluated
  fanout?: FanoutClamp; // (b) the fan-out clamp + binding term, on schedule
  rejected?: string; // (d) validateDecision reason, folded in by runWeave on downgrade
};

// B2 — the settled non-done required-thread states the orchestrator may MEDIATE
// (re-derive / reassign) before parking to the human (§62). `blocked` is
// included (B2): a lane-unviable / breaker park first earns a bounded
// reassign/re-derive attempt rather than going straight to the human. Shared by
// validateDecision (repair validity) and tick (the mediate-vs-park choice).
const REPAIRABLE_STATES: WorkUnitState[] = ["needs-review", "failed", "blocked"];

// B2 — the per-thread orchestrator-mediation budget: how many times the weaver
// re-derives/reassigns a settled non-done required thread BEFORE it parks to the
// human. Small + bounded (mirrors the builder maxAttempts) so a genuine
// dead-end converges to the human park instead of looping forever (§73-74).
// DISTINCT from the root ALL-verify repair-guard budget (repair-guard.ts): that
// bounds the integration-repair loop over assertion ids; this bounds thread
// reassignment. Each mediation strictly increments a thread's mediationAttempts,
// so termination is a bare integer bound.
export const MEDIATION_BUDGET = 2;

// PURE kernel: ids not yet started, whose every dependsOn is completed. Both the
// loom weaver (readySubGoals) and the thread-workflow runner call this ONE
// predicate — the fractal "ready" walk is defined exactly once.
export function readyItems<T extends { id: string; dependsOn: string[] }>(
  items: T[],
  started: (id: string) => boolean,
  completed: (id: string) => boolean,
): string[] {
  return items.filter((it) => !started(it.id)).filter((it) => it.dependsOn.every(completed)).map((it) => it.id);
}

// Subgoals with no thread yet, whose every dependsOn id maps to a "done" thread.
export function readySubGoals(view: LedgerView): string[] {
  const m = new Map<string, ThreadView>();
  for (const t of view.threads) m.set(t.subGoalId, t);
  return readyItems(view.charter.decomposition, (id) => m.has(id), (id) => m.get(id)?.state === "done");
}

export function validateDecision(d: Decision, view: LedgerView): { ok: boolean; reason?: string } {
  const threadBySubGoal = new Map<string, ThreadView>();
  for (const t of view.threads) threadBySubGoal.set(t.subGoalId, t);

  if (d.action === "finish-loom") {
    const required = view.charter.decomposition.filter((sg) => sg.required);
    const notDone = required.find((sg) => threadBySubGoal.get(sg.id)?.state !== "done");
    if (notDone) return { ok: false, reason: `${notDone.id}: not done` };
    return { ok: true };
  }

  if (d.action === "schedule") {
    if (d.agents < 1) return { ok: false, reason: "agents must be >= 1" };
    const poolRoom = view.budget.maxAgents - view.inFlight;
    if (d.agents > poolRoom) return { ok: false, reason: "schedule would exceed the agent pool" };
    // POOL CAP: it's subGoalIds.length threads that actually get spawned —
    // guard that directly too, not just the (normally-matching) agents count.
    if (d.subGoalIds.length > poolRoom) return { ok: false, reason: "schedule would exceed the agent pool" };
    const ready = new Set(readySubGoals(view));
    for (const id of d.subGoalIds) {
      if (threadBySubGoal.has(id)) return { ok: false, reason: `${id}: already threaded` };
      if (!ready.has(id)) return { ok: false, reason: `${id}: not ready` };
    }
    return { ok: true };
  }

  if (d.action === "fanout") {
    if (d.agents < 1) return { ok: false, reason: "agents must be >= 1" };
    const poolRoom = view.budget.maxAgents - view.inFlight;
    if (d.agents > poolRoom) return { ok: false, reason: "fanout would exceed the agent pool" };
    return { ok: true };
  }

  if (d.action === "repair") {
    const thread = view.threads.find((t) => t.id === d.threadId);
    if (!thread) return { ok: false, reason: "unknown thread" };
    if (!REPAIRABLE_STATES.includes(thread.state)) return { ok: false, reason: `${thread.state}: not repairable` };
    return { ok: true };
  }

  // escalate / hold: always valid — the safe fallback.
  return { ok: true };
}

export const EST_COST_PER_AGENT = 0.5;

// Pure: the budget/clock snapshot (rationale piece c), read straight off the
// view so it is atomic-consistent with the decision produced this tick.
function budgetSnapshot(view: LedgerView): BudgetSnapshot {
  const b = view.budget;
  return {
    spentUsd: b.spentUsd,
    inFlight: view.inFlight,
    maxCostUsd: b.maxCostUsd,
    budgetLeftUsd: budgetLeftUsd(b),
    wallClockRemainingMs:
      b.maxWallClockHours == null ? null : b.maxWallClockHours * 3600_000 - (view.nowMs - b.startedAtMs),
  };
}

export type TickResult = { decision: Decision; rationale: Rationale };

export function tick(view: LedgerView): TickResult {
  const { charter, budget } = view;
  const snapshot = budgetSnapshot(view);

  if (!withinWallClock(budget, view.nowMs)) {
    return {
      decision: { action: "escalate", reason: "wall-clock budget exhausted" },
      rationale: { summary: "wall-clock budget exhausted — escalating", budget: snapshot },
    };
  }

  const threadBySubGoal = new Map<string, ThreadView>();
  for (const t of view.threads) threadBySubGoal.set(t.subGoalId, t);

  const required = charter.decomposition.filter((sg) => sg.required);
  if (required.every((sg) => threadBySubGoal.get(sg.id)?.state === "done")) {
    return {
      decision: { action: "finish-loom" },
      rationale: { summary: "every required subgoal is done — finishing the weave", budget: snapshot },
    };
  }

  // B2 (§22-24,§62) — THE ORCHESTRATOR-MEDIATION RUNG. A required subgoal whose
  // thread SETTLED (no live runner) in a non-done state — `failed`, `blocked`
  // (breaker / pre-flight lane-unviable park), or `needs-review` — is a
  // CORRECTION OPPORTUNITY, not an automatic human escalate. While the thread's
  // per-thread mediation budget remains, emit a `repair` directive: runWeave
  // re-derives / reassigns the thread (a fresh bounded attempt at the subgoal).
  // Only once mediation is GENUINELY EXHAUSTED (mediationAttempts reached
  // MEDIATION_BUDGET) does the human-first park fire — and it still fires (the
  // parks stay the final valve, §73-74). BOUNDED BY CONSTRUCTION: runWeave
  // increments mediationAttempts on every repair, so this can iterate at most
  // MEDIATION_BUDGET times per thread before the escalate below is forced. A
  // mid-retry failure (runnerInFlight true) is excluded — it still owns a runner,
  // so it falls through to hold/schedule ("keep sampling"), unchanged.
  //
  // Ordering: `failed` is checked before `blocked`/`needs-review` so a genuinely
  // failed required thread is the one surfaced first (mirrors the pre-B2
  // failedRequired preemption). The escalate REASON is preserved verbatim per
  // state so the decision stream / rollup read exactly as before once mediation
  // is spent (`… failed`, `… awaiting human — parking`).
  const mediable =
    required.find((sg) => {
      const t = threadBySubGoal.get(sg.id);
      return t?.state === "failed" && t.runnerInFlight !== true;
    }) ??
    required.find((sg) => {
      const t = threadBySubGoal.get(sg.id);
      return t !== undefined && t.runnerInFlight !== true && REPAIRABLE_STATES.includes(t.state);
    });
  if (mediable) {
    const t = threadBySubGoal.get(mediable.id)!;
    const attempts = t.mediationAttempts ?? 0;
    if (attempts < MEDIATION_BUDGET) {
      return {
        decision: { action: "repair", threadId: t.id },
        rationale: {
          summary: `mediating ${mediable.id} (${t.state}) — attempt ${attempts + 1}/${MEDIATION_BUDGET} before any human park`,
          budget: snapshot,
        },
      };
    }
    // Mediation EXHAUSTED — the human-first park now fires (the final valve). The
    // reason is state-specific and byte-identical to the pre-B2 escalate strings:
    // a `blocked` thread parks awaiting a human answer; anything else escalates as
    // failed. runWeave breaks on escalate, then rollupWeave is authoritative and
    // lifts a blocked child's answerable question up to the root.
    const reason =
      t.state === "blocked" ? `${mediable.id} awaiting human — parking` : `${mediable.id} failed`;
    const summary =
      t.state === "blocked"
        ? `required subgoal ${mediable.id} parked blocked — mediation exhausted, awaiting human`
        : `required subgoal ${mediable.id} ${t.state} — mediation exhausted, escalating`;
    return {
      decision: { action: "escalate", threadId: t.id, reason },
      rationale: { summary, budget: snapshot },
    };
  }

  const ranked = prioritizeScored(readySubGoals(view), charter.decomposition);
  const ready = ranked.map((r) => r.id);
  const poolRoom = budget.maxAgents - view.inFlight;
  if (ready.length > 0 && poolRoom > 0) {
    const fanout = fanoutClamp(ready.length, {
      maxAgents: budget.maxAgents,
      inFlight: view.inFlight,
      budgetLeftUsd: budgetLeftUsd(budget),
      estCostPerAgent: EST_COST_PER_AGENT,
    });
    if (fanout.chosen >= 1) {
      const head = ranked[0];
      const bind =
        fanout.binding === "pieces"
          ? "all ready pieces fit the pool + budget"
          : fanout.binding === "pool"
            ? "the agent pool is the binding limit"
            : "the cost budget is the binding limit";
      const lead = head ? `${head.id} first (unblocks ${head.score} downstream)` : "no ranked head";
      return {
        decision: { action: "schedule", subGoalIds: ready.slice(0, fanout.chosen), agents: fanout.chosen },
        rationale: {
          summary: `schedule ${fanout.chosen} — ${lead}; ${bind}`,
          budget: snapshot,
          ranked,
          fanout,
        },
      };
    }
  }

  if (view.inFlight > 0) {
    return {
      decision: { action: "hold" },
      rationale: { summary: "holding — waiting on in-flight threads before the next move", budget: snapshot, ranked },
    };
  }

  // Distinguish genuinely blocked (no ready work at all) from ready work
  // existing but the pool having no room for it (e.g. a misconfigured
  // maxAgents:0 charter) — same "nothing to schedule, nothing in flight"
  // shape, but a different root cause worth surfacing accurately.
  if (ready.length > 0) {
    return {
      decision: { action: "escalate", reason: "ready threads exist but the agent pool has no room (maxAgents budget exhausted)" },
      rationale: { summary: "ready work exists but the agent pool has no room — escalating", budget: snapshot, ranked },
    };
  }

  return {
    decision: { action: "escalate", reason: "no ready threads and none in flight (blocked)" },
    rationale: { summary: "no ready threads and none in flight — blocked, escalating", budget: snapshot, ranked },
  };
}
