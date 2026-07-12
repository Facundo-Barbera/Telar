// M4 — the convergence guards: a PURE decision function that decides whether a
// bounded auto-repair loop may iterate again. This is the safety core of the
// milestone. It is a pure function of INTEGERS (round counts), an injected
// clock + budget snapshot, and STABLE assertion-id sets — NEVER of an LLM
// verdict. The model only authors a repair diff; this function alone decides
// whether to keep going. That is what makes auto-repair provably unable to run
// away. No I/O, no Date.now inside (the caller passes nowMs in).
import { type BudgetState, budgetLeftUsd, fanoutClamp, withinWallClock } from "./budget";

// One observed integration-verify round of the auto-repair loop. history[0] is
// the initial verify; each later entry follows one dispatched repair. Recorded
// on the root loom (looms.ts repairHistory) so the guard is trivially fakeable
// and never re-parses gate output.
export type RepairRound = {
  n: number; // 1-based round index (history[i].n === i + 1)
  failingIds: string[]; // F_n: assertion ids that were fail|flaky this round
  passingIds: string[]; // assertion ids that passed this round
  verification: string; // "pass" | "fail" | "flaky" | "skip"
  costUsd: number; // spend attributed to this round's repair (0 for the initial verify)
  startedAt: number;
  endedAt: number;
};

export type RepairCaps = {
  // Max repair DISPATCHES allowed (mirrors executor maxAttempts=3). Clamped to
  // >= 1. The loop escalates once this many repairs have been attempted.
  maxRepairIterations: number;
  // Per-repair cost estimate for the budget-headroom check (Guard 2).
  estCostPerRepair: number;
};

export type RepairDecision =
  | { action: "repair" }
  | { action: "converged" }
  | { action: "escalate"; reason: string };

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

// The five guards, in the normative evaluation order (Guard 0, 4, 3, 1, 2).
// Every branch is a pure integer / set / arithmetic test over injected state;
// none reads model output. TERMINATION: the loop runs at most
// min(maxRepairIterations, |F_0|, floor(budgetLeft/estCostPerRepair)) productive
// rounds — strict-shrink caps at |F_0| (Guard 3), the counter caps at
// maxRepairIterations (Guard 1), budget caps by spend (Guard 2), and any
// regression halts immediately (Guard 4). Provably terminating.
export function decideRepairContinuation(
  history: RepairRound[], // oldest→newest; last is the just-observed verify
  budget: BudgetState,
  nowMs: number,
  caps: RepairCaps,
): RepairDecision {
  if (history.length === 0) {
    // No verify observed yet — nothing to decide against. The caller always
    // records the initial verify before asking; treat an empty history as
    // "run the first repair" only if it ever happens, but here it is inert.
    return { action: "repair" };
  }

  const maxIter = Math.max(1, caps.maxRepairIterations);
  const last = history.length - 1;
  const R = history[last]!;
  const Fn = new Set(R.failingIds);

  // Guard 0 — success. No failing assertions this round ⇒ converged (the loop's
  // only promote-eligible exit; the caller lands the loom "ready", never "done").
  if (Fn.size === 0) return { action: "converged" };

  // Guard 4 — Regression (checked BEFORE consuming iteration/budget). Any
  // assertion that was green in ANY prior round is red again now ⇒ the repairs
  // are oscillating (fix A breaks B, fix B breaks A). Escalate IMMEDIATELY; do
  // not consume an iteration. Deterministic set intersection over stable ids.
  const everGreen = new Set<string>();
  for (let i = 0; i < last; i++) for (const id of history[i]!.passingIds) everGreen.add(id);
  const regressed = [...Fn].filter((id) => everGreen.has(id));
  if (regressed.length > 0) {
    return { action: "escalate", reason: `regression: ${uniqSorted(regressed).join(", ")}` };
  }

  // Guard 3 — Progress / strict shrink. From the second round on, the failing
  // set must STRICTLY shrink: F_n ⊆ F_{n-1} AND |F_n| < |F_{n-1}|. A plateau
  // (same set) or a count-preserving id swap is no progress ⇒ escalate. This
  // alone bounds productive iterations to <= |F_0|.
  if (last >= 1) {
    const Fprev = new Set(history[last - 1]!.failingIds);
    const subset = [...Fn].every((id) => Fprev.has(id));
    const strictlySmaller = Fn.size < Fprev.size;
    if (!(subset && strictlySmaller)) {
      return { action: "escalate", reason: "no progress" };
    }
  }

  // Guard 1 — Max-iterations backstop. repairsDone = rounds after the initial
  // verify. Once we have already dispatched maxRepairIterations repairs, stop —
  // even if F somehow keeps shrinking below the Guard-3 bound. A bare integer
  // compare. (Escalates at round maxRepairIterations + 1.)
  const repairsDone = history.length - 1;
  if (repairsDone >= maxIter) {
    return { action: "escalate", reason: "max repair iterations" };
  }

  // Guard 2 — Budget (budget.ts primitives, verbatim). Any of: not enough USD
  // headroom for one more repair; wall-clock exhausted; or the agent pool has
  // no room. Estimated per-repair cost doubles as the per-agent cost for the
  // pool clamp.
  if (budgetLeftUsd(budget) < caps.estCostPerRepair) {
    return { action: "escalate", reason: "budget exhausted" };
  }
  if (!withinWallClock(budget, nowMs)) {
    return { action: "escalate", reason: "wall-clock budget exhausted" };
  }
  const clamp = fanoutClamp(1, {
    maxAgents: budget.maxAgents,
    inFlight: budget.inFlight,
    budgetLeftUsd: budgetLeftUsd(budget),
    estCostPerAgent: caps.estCostPerRepair,
  });
  if (clamp.chosen === 0) {
    return { action: "escalate", reason: "agent pool exhausted" };
  }

  // Otherwise — one more bounded repair round.
  return { action: "repair" };
}
