// M4 — exhaustive table tests for the pure convergence guards. These prove the
// auto-repair loop can NEVER run away: every continuation is a pure function of
// integers / injected clock+budget / stable assertion-id sets, never an LLM
// verdict. No I/O, no TELAR_HOME needed.
import { describe, expect, test } from "bun:test";
import { decideRepairContinuation, type RepairCaps, type RepairRound } from "../src/repair-guard";
import type { BudgetState } from "../src/budget";

function round(
  n: number,
  failing: string[],
  passing: string[] = [],
  verification = failing.length ? "fail" : "pass",
): RepairRound {
  return { n, failingIds: failing, passingIds: passing, verification, costUsd: 0, startedAt: 0, endedAt: 0 };
}

function budget(overrides: Partial<BudgetState> = {}): BudgetState {
  return { maxAgents: 12, inFlight: 0, spentUsd: 0, startedAtMs: 0, ...overrides };
}

const CAPS: RepairCaps = { maxRepairIterations: 3, estCostPerRepair: 0.5 };
const NOW = 1000;

describe("decideRepairContinuation — the five guards", () => {
  test("Guard 0: no failing assertions -> converged (lands ready, never done)", () => {
    const d = decideRepairContinuation([round(1, [], ["a", "b"], "pass")], budget(), NOW, CAPS);
    expect(d).toEqual({ action: "converged" });
  });

  test("Guard 0: a skip round with no failing ids -> converged", () => {
    const d = decideRepairContinuation([round(1, [], [], "skip")], budget(), NOW, CAPS);
    expect(d).toEqual({ action: "converged" });
  });

  test("A.1 plateau -> escalate 'no progress' (no spin on a stuck repair)", () => {
    const history = [round(1, ["a", "b"]), round(2, ["a", "b"])];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "no progress",
    });
  });

  test("A.2 count-preserving id swap -> escalate 'no progress' (id-churn spinner)", () => {
    const history = [round(1, ["a"]), round(2, ["b"])];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "no progress",
    });
  });

  test("A.3 iteration backstop: ever-shrinking but pathological -> escalate at round N+1", () => {
    const caps: RepairCaps = { maxRepairIterations: 2, estCostPerRepair: 0.5 };
    // round 2 (one repair done) still iterates:
    expect(decideRepairContinuation([round(1, ["a", "b", "c", "d"]), round(2, ["a", "b", "c"])], budget(), NOW, caps)).toEqual({
      action: "repair",
    });
    // round 3 (two repairs done == maxRepairIterations) -> backstop fires:
    const history = [round(1, ["a", "b", "c", "d"]), round(2, ["a", "b", "c"]), round(3, ["a", "b"])];
    expect(decideRepairContinuation(history, budget(), NOW, caps)).toEqual({
      action: "escalate",
      reason: "max repair iterations",
    });
  });

  test("A.4 budget USD: not enough headroom for one more repair -> escalate 'budget exhausted'", () => {
    const d = decideRepairContinuation([round(1, ["a"])], budget({ maxCostUsd: 1, spentUsd: 0.95 }), NOW, {
      maxRepairIterations: 3,
      estCostPerRepair: 0.1,
    });
    expect(d).toEqual({ action: "escalate", reason: "budget exhausted" });
  });

  test("A.5 wall-clock exhausted -> escalate 'wall-clock budget exhausted'", () => {
    const d = decideRepairContinuation(
      [round(1, ["a"])],
      budget({ startedAtMs: 0, maxWallClockHours: 1 }),
      2 * 3600_000,
      { maxRepairIterations: 3, estCostPerRepair: 0.01 },
    );
    expect(d).toEqual({ action: "escalate", reason: "wall-clock budget exhausted" });
  });

  test("A.6 agent pool exhausted (capByPool <= 0) -> escalate 'agent pool exhausted'", () => {
    const d = decideRepairContinuation([round(1, ["a"])], budget({ maxAgents: 1, inFlight: 1 }), NOW, CAPS);
    expect(d).toEqual({ action: "escalate", reason: "agent pool exhausted" });
  });

  test("A.7 regression -> IMMEDIATE escalate, does NOT consume an iteration (oscillation proof)", () => {
    // round 1: a fails, b passes. round 2: fix flipped — b now fails, a passes.
    const history = [round(1, ["a"], ["b"]), round(2, ["b"], ["a"])];
    const d = decideRepairContinuation(history, budget(), NOW, CAPS);
    expect(d).toEqual({ action: "escalate", reason: "regression: b" });
    // Only one repair happened (history.length 2) — nowhere near the cap of 3.
    expect(history.length - 1).toBeLessThan(CAPS.maxRepairIterations);
  });

  test("A.7b regression reason lists sorted ids", () => {
    const history = [round(1, ["x"], ["b", "a", "c"]), round(2, ["a", "c"], ["x"])];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "regression: a, c",
    });
  });

  test("A.8 converging: shrink each step then empty -> repair, repair, converged (reaches ready)", () => {
    const r1 = round(1, ["a", "b"]);
    expect(decideRepairContinuation([r1], budget(), NOW, CAPS)).toEqual({ action: "repair" });
    const r2 = round(2, ["a"], ["b"]);
    expect(decideRepairContinuation([r1, r2], budget(), NOW, CAPS)).toEqual({ action: "repair" });
    const r3 = round(3, [], ["a", "b"], "pass");
    expect(decideRepairContinuation([r1, r2, r3], budget(), NOW, CAPS)).toEqual({ action: "converged" });
  });

  test("guard ORDER: regression beats no-progress beats iteration beats budget", () => {
    // A round that is simultaneously a regression AND a plateau AND over-budget
    // AND over-iteration must report the regression (Guard 4 is evaluated first).
    const caps: RepairCaps = { maxRepairIterations: 1, estCostPerRepair: 100 };
    const history = [round(1, ["a"], ["b"]), round(2, ["a", "b"])]; // b regressed; not shrinking
    const d = decideRepairContinuation(history, budget({ maxCostUsd: 0.01, spentUsd: 0.01 }), NOW, caps);
    expect(d).toEqual({ action: "escalate", reason: "regression: b" });
  });

  test("maxRepairIterations clamps to >= 1", () => {
    // With a 0/negative cap, one repair is still allowed to be attempted (clamp),
    // but the backstop fires immediately afterward.
    const caps: RepairCaps = { maxRepairIterations: 0, estCostPerRepair: 0.5 };
    // history of just the initial verify (repairsDone 0) -> clamp makes maxIter 1,
    // 0 < 1 so a repair is permitted.
    expect(decideRepairContinuation([round(1, ["a"])], budget(), NOW, caps)).toEqual({ action: "repair" });
    // after one repair (repairsDone 1 >= clamped 1) -> backstop.
    expect(decideRepairContinuation([round(1, ["a", "b"]), round(2, ["a"])], budget(), NOW, caps)).toEqual({
      action: "escalate",
      reason: "max repair iterations",
    });
  });
});
