// The concurrency/spend budget for the weaver's control loop
// (docs/loom-orchestrator.md §7). PURE — no I/O, no Date.now: callers pass
// `now`/state in. This is the shared agent pool that fanoutSize/tick/
// validateDecision gate concurrency against via Charter.budget.maxAgents.
// NOTE: Charter.budget.maxParallelThreads (schemas.ts) is not read anywhere
// in this module or tick.ts/weave.ts — maxAgents is the only axis actually
// enforced today.
import type { SubGoal } from "./schemas";

export type BudgetState = {
  maxAgents: number;
  inFlight: number;
  spentUsd: number;
  startedAtMs: number;
  maxCostUsd?: number;
  maxWallClockHours?: number;
};

// The shared concurrency pool default — mirrors schemas.ts Budget.maxAgents
// (:367). Exported so callers that default an absent budget.maxAgents (the
// M9.2 step-wave clamp / CF1 in executor.ts, dispatcher.ts's rootRepairBudget)
// reference this instead of re-deriving the literal 12. Kept in sync with the
// Zod default by the cross-reference comment at schemas.ts:367.
//
// This is a PER-LOOM clamp, NOT a process ceiling. The real process-wide limit
// on concurrent agent() calls is admission.ts's (TELAR_MAX_AGENTS, default 4),
// so a charter asking for 12 does not get 12 in flight. Pass `processCeiling`
// to fanoutClamp when the caller wants the clamp to say so.
export const DEFAULT_MAX_AGENTS = 12;

export function budgetLeftUsd(b: BudgetState): number {
  return b.maxCostUsd == null ? Infinity : Math.max(0, b.maxCostUsd - b.spentUsd);
}

// The fan-out clamp, broken down: the three candidate terms of the min() plus
// which one was binding (docs/loom-orchestrator.md §7). This is the honest
// scheduler-policy input the rationale surfaces — pure, derived only from args.
export type FanoutClamp = {
  pieces: number; // max(1, independentPieces) — the demand side
  capByPool: number; // maxAgents - inFlight
  capByBudget: number; // floor(budgetLeftUsd / estCostPerAgent), or Infinity when uncapped
  // The process-wide admission ceiling (admission.ts), or Infinity when the
  // caller does not supply one. Without this term a Charter promising
  // maxAgents: 12 reports a fan-out of 12 while the process admits far fewer —
  // the scheduler's own rationale then misstates what will actually run.
  capByProcess: number;
  chosen: number; // the final n actually returned
  binding: "pieces" | "pool" | "budget" | "process" | "pool-exhausted"; // the term that set `chosen`
};

export type FanoutArgs = {
  maxAgents: number;
  inFlight: number;
  budgetLeftUsd: number;
  estCostPerAgent: number;
  // OPTIONAL so every existing call site keeps byte-identical behavior
  // (NFR-RF-9); pass admissionCeiling() to make the clamp reflect what the
  // process will actually admit.
  processCeiling?: number;
};

// agents(phase) = clamp(independentPieces, 1, min(maxAgents - inFlight, floor(budgetLeftUsd / estCostPerAgent), processCeiling))
// — except the pool being full (capByPool <= 0) forces 0: no room to start anything.
export function fanoutClamp(independentPieces: number, args: FanoutArgs): FanoutClamp {
  const pieces = Math.max(1, independentPieces);
  const capByPool = args.maxAgents - args.inFlight;
  const capByBudget =
    args.estCostPerAgent > 0 && isFinite(args.budgetLeftUsd)
      ? Math.floor(args.budgetLeftUsd / args.estCostPerAgent)
      : Infinity;
  const capByProcess = args.processCeiling ?? Infinity;
  const cap = Math.min(capByPool, capByBudget, capByProcess);
  if (cap <= 0)
    return { pieces, capByPool, capByBudget, capByProcess, chosen: 0, binding: "pool-exhausted" };
  const chosen = Math.min(pieces, cap);
  // Demand (pieces) binds when it fits under every cap; otherwise the smallest
  // cap, tie-broken pool -> budget -> process. That order is load-bearing: with
  // no processCeiling supplied capByProcess is Infinity and can never be the
  // min, so a call site that passes nothing reports exactly what it reported
  // before this term existed.
  const binding =
    chosen === pieces
      ? "pieces"
      : capByPool === cap
        ? "pool"
        : capByBudget === cap
          ? "budget"
          : capByProcess === cap
            ? "process"
            : // Unreachable for any real input — `cap` IS one of the three terms,
              // so one of the comparisons above must match. It is reachable for a
              // NaN cap (maxAgents and inFlight both Infinity, say), where every
              // comparison is false because NaN !== NaN. AC10 requires the
              // no-processCeiling answer to stay byte-identical to the formula
              // before this term existed, and that formula's final else was
              // "budget" — so this one is too. The label is meaningless for a NaN
              // clamp either way; what matters is that adding the process term
              // did not silently move it.
              "budget";
  return { pieces, capByPool, capByBudget, capByProcess, chosen, binding };
}

export function fanoutSize(independentPieces: number, args: FanoutArgs): number {
  return fanoutClamp(independentPieces, args).chosen;
}

export function withinWallClock(b: BudgetState, nowMs: number): boolean {
  return b.maxWallClockHours == null ? true : nowMs - b.startedAtMs < b.maxWallClockHours * 3600_000;
}

// A ready subgoal paired with its critical-path score: how many other subgoals
// transitively depend on it (= how much downstream work scheduling it unblocks).
export type PriorityRank = { id: string; score: number };

// Critical-path-first (docs/loom-orchestrator.md §7 open decision #8): rank a
// ready subgoal by how many other subgoals transitively depend on it (unblocks
// the most work first), descending; ties broken by id ascending for
// determinism across ticks (decisionLogTail consistency depends on this).
// Returns the {id, score} pairs — the raw material for the scheduler rationale
// ("s3 first because it unblocks 4 downstream"). `prioritize` drops the scores.
// Parameter is the structural minimum ({id, dependsOn}) — the same one
// altitude-down shape readyItems (tick.ts) uses — so callers ranking non-
// SubGoal nodes (e.g. executor.ts's Step DAG) pass real values with no cast.
export function prioritizeScored(readyIds: string[], decomposition: Array<{ id: string; dependsOn: string[] }>): PriorityRank[] {
  // dependents[x] = ids that directly dependOn x
  const dependents = new Map<string, string[]>();
  for (const sg of decomposition) {
    for (const dep of sg.dependsOn) {
      const list = dependents.get(dep);
      if (list) list.push(sg.id);
      else dependents.set(dep, [sg.id]);
    }
  }

  function transitiveDependentCount(id: string): number {
    const seen = new Set<string>();
    const stack = [...(dependents.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of dependents.get(cur) ?? []) stack.push(next);
    }
    return seen.size;
  }

  const scored = readyIds.map((id) => ({ id, score: transitiveDependentCount(id) }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

export function prioritize(readyIds: string[], decomposition: SubGoal[]): string[] {
  return prioritizeScored(readyIds, decomposition).map((s) => s.id);
}
