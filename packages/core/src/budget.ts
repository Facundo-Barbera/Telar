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
  chosen: number; // the final n actually returned
  binding: "pieces" | "pool" | "budget" | "pool-exhausted"; // the term that set `chosen`
};

// agents(phase) = clamp(independentPieces, 1, min(maxAgents - inFlight, floor(budgetLeftUsd / estCostPerAgent)))
// — except the pool being full (capByPool <= 0) forces 0: no room to start anything.
export function fanoutClamp(
  independentPieces: number,
  args: { maxAgents: number; inFlight: number; budgetLeftUsd: number; estCostPerAgent: number },
): FanoutClamp {
  const pieces = Math.max(1, independentPieces);
  const capByPool = args.maxAgents - args.inFlight;
  const capByBudget =
    args.estCostPerAgent > 0 && isFinite(args.budgetLeftUsd)
      ? Math.floor(args.budgetLeftUsd / args.estCostPerAgent)
      : Infinity;
  const cap = Math.min(capByPool, capByBudget);
  if (cap <= 0) return { pieces, capByPool, capByBudget, chosen: 0, binding: "pool-exhausted" };
  const chosen = Math.min(pieces, cap);
  // Demand (pieces) binds when it fits under both caps; otherwise the smaller cap.
  const binding = chosen === pieces ? "pieces" : capByPool <= capByBudget ? "pool" : "budget";
  return { pieces, capByPool, capByBudget, chosen, binding };
}

export function fanoutSize(
  independentPieces: number,
  args: { maxAgents: number; inFlight: number; budgetLeftUsd: number; estCostPerAgent: number },
): number {
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
