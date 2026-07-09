// The concurrency/spend budget for an orchestrator's control loop
// (docs/loom-orchestrator.md §7). PURE — no I/O, no Date.now: callers pass
// `now`/state in. This is the shared agent pool that fanoutSize/tick/
// validateDecision gate concurrency against via Charter.budget.maxAgents.
// NOTE: Charter.budget.maxParallelThreads (schemas.ts) is not read anywhere
// in this module or tick.ts/epic.ts — maxAgents is the only axis actually
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

export function budgetLeftUsd(b: BudgetState): number {
  return b.maxCostUsd == null ? Infinity : Math.max(0, b.maxCostUsd - b.spentUsd);
}

// agents(phase) = clamp(independentPieces, 1, min(maxAgents - inFlight, floor(budgetLeftUsd / estCostPerAgent)))
// — except the pool being full (capByPool <= 0) forces 0: no room to start anything.
export function fanoutSize(
  independentPieces: number,
  args: { maxAgents: number; inFlight: number; budgetLeftUsd: number; estCostPerAgent: number },
): number {
  const capByPool = args.maxAgents - args.inFlight;
  const capByBudget =
    args.estCostPerAgent > 0 && isFinite(args.budgetLeftUsd)
      ? Math.floor(args.budgetLeftUsd / args.estCostPerAgent)
      : Infinity;
  const cap = Math.min(capByPool, capByBudget);
  if (cap <= 0) return 0;
  return Math.min(Math.max(1, independentPieces), cap);
}

export function withinWallClock(b: BudgetState, nowMs: number): boolean {
  return b.maxWallClockHours == null ? true : nowMs - b.startedAtMs < b.maxWallClockHours * 3600_000;
}

// Critical-path-first (docs/loom-orchestrator.md §7 open decision #8): rank a
// ready subgoal by how many other subgoals transitively depend on it (unblocks
// the most work first), descending; ties broken by id ascending for
// determinism across ticks (decisionLogTail consistency depends on this).
export function prioritize(readyIds: string[], decomposition: SubGoal[]): string[] {
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
  return scored.map((s) => s.id);
}
