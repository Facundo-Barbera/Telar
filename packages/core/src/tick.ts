// The weaver's control loop (docs/loom-orchestrator.md §6). PURE
// deterministic scheduler: tick and validateDecision take a curated
// LedgerView and return/validate a Decision — no I/O, no agent calls, no
// Date.now (the caller passes `nowMs` in). This is where the moat lives in
// the tick path: validateDecision makes "finish-loom" illegal unless every
// required subgoal's thread is state === "done".
import type { Charter, SubGoal, WorkUnitState } from "./schemas";
import { type BudgetState, budgetLeftUsd, fanoutSize, prioritize, withinWallClock } from "./budget";

export type ThreadView = {
  id: string;
  subGoalId: string;
  state: WorkUnitState;
  latestVerdict?: string;
};

export type Decision =
  | { action: "schedule"; subGoalIds: string[]; agents: number }
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

const REPAIRABLE_STATES: WorkUnitState[] = ["needs-review", "failed"];

// Subgoals with no thread yet, whose every dependsOn id maps to a "done" thread.
export function readySubGoals(view: LedgerView): string[] {
  const threadBySubGoal = new Map<string, ThreadView>();
  for (const t of view.threads) threadBySubGoal.set(t.subGoalId, t);

  return view.charter.decomposition
    .filter((sg) => !threadBySubGoal.has(sg.id))
    .filter((sg) => sg.dependsOn.every((dep) => threadBySubGoal.get(dep)?.state === "done"))
    .map((sg) => sg.id);
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

export function tick(view: LedgerView): Decision {
  const { charter, budget } = view;

  if (!withinWallClock(budget, view.nowMs)) {
    return { action: "escalate", reason: "wall-clock budget exhausted" };
  }

  const threadBySubGoal = new Map<string, ThreadView>();
  for (const t of view.threads) threadBySubGoal.set(t.subGoalId, t);

  const required = charter.decomposition.filter((sg) => sg.required);
  if (required.every((sg) => threadBySubGoal.get(sg.id)?.state === "done")) {
    return { action: "finish-loom" };
  }

  const failedRequired = required.find((sg) => threadBySubGoal.get(sg.id)?.state === "failed");
  if (failedRequired) {
    return { action: "escalate", reason: `${failedRequired.id} failed` };
  }

  const ready = prioritize(readySubGoals(view), charter.decomposition);
  const poolRoom = budget.maxAgents - view.inFlight;
  if (ready.length > 0 && poolRoom > 0) {
    const n = fanoutSize(ready.length, {
      maxAgents: budget.maxAgents,
      inFlight: view.inFlight,
      budgetLeftUsd: budgetLeftUsd(budget),
      estCostPerAgent: EST_COST_PER_AGENT,
    });
    if (n >= 1) {
      return { action: "schedule", subGoalIds: ready.slice(0, n), agents: n };
    }
  }

  if (view.inFlight > 0) {
    return { action: "hold" };
  }

  // Distinguish genuinely blocked (no ready work at all) from ready work
  // existing but the pool having no room for it (e.g. a misconfigured
  // maxAgents:0 charter) — same "nothing to schedule, nothing in flight"
  // shape, but a different root cause worth surfacing accurately.
  if (ready.length > 0) {
    return { action: "escalate", reason: "ready threads exist but the agent pool has no room (maxAgents budget exhausted)" };
  }

  return { action: "escalate", reason: "no ready threads and none in flight (blocked)" };
}
