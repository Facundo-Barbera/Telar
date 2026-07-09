import { describe, expect, test } from "bun:test";
import { decide, type Decision, type Verification } from "../src/executor";
import type { Verdict } from "../src/schemas";

const okVerdict: Verdict = { ok: true, summary: "done", files_touched: [], blocker: null };
const badVerdict: Verdict = { ok: false, summary: "nope", files_touched: [], blocker: "boom" };

type Input = Parameters<typeof decide>[0];

// Deterministic input builder — sensible defaults, override per case.
function run(over: Partial<Input>): Decision {
  return decide({
    gatesConfigured: true,
    gatesOk: true,
    verdict: okVerdict,
    verification: "skip",
    n: 1,
    maxAttempts: 3,
    flakyUsed: 0,
    maxFlaky: 2,
    ...over,
  });
}

describe("decide — gated + gatesOk + verdict.ok (Verifier gates promotion)", () => {
  test("verification pass -> done", () => {
    expect(run({ verification: "pass" })).toEqual({ action: "done" });
  });

  test("verification skip -> done (deterministic gates carry it)", () => {
    expect(run({ verification: "skip" })).toEqual({ action: "done" });
  });

  test("verification fail with n < maxAttempts -> retry", () => {
    expect(run({ verification: "fail", n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
  });

  test("verification fail at n == maxAttempts -> needs-review", () => {
    expect(run({ verification: "fail", n: 3, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "verification failed",
    });
  });

  test("flaky within budget and retryable -> retry", () => {
    expect(run({ verification: "flaky", flakyUsed: 0, maxFlaky: 2, n: 1, maxAttempts: 3 })).toEqual({
      action: "retry",
    });
  });

  test("flaky over budget -> needs-review", () => {
    expect(run({ verification: "flaky", flakyUsed: 2, maxFlaky: 2, n: 1, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "verification flaky",
    });
  });

  test("flaky within budget but not retryable (n == maxAttempts) -> needs-review", () => {
    expect(run({ verification: "flaky", flakyUsed: 0, maxFlaky: 2, n: 3, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "verification flaky",
    });
  });
});

describe("decide — panelRequired (§4 Layer 3: a bundle loom's panel IS the gate)", () => {
  test("panelRequired absent (legacy/no-contract) -> skip still carries gates to done, unchanged", () => {
    expect(run({ verification: "skip" })).toEqual({ action: "done" });
  });

  test("panelRequired=false explicitly -> same as absent, skip carries gates to done", () => {
    expect(run({ verification: "skip", panelRequired: false })).toEqual({ action: "done" });
  });

  test("panelRequired=true -> skip never promotes even with gates green + agent ok; retries while budget remains", () => {
    expect(run({ verification: "skip", panelRequired: true, n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
  });

  test("panelRequired=true -> needs-review once attempts are exhausted", () => {
    expect(run({ verification: "skip", panelRequired: true, n: 3, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "panel verification required but did not run",
    });
  });

  test("panelRequired=true has no effect once verification actually 'pass'es", () => {
    expect(run({ verification: "pass", panelRequired: true })).toEqual({ action: "done" });
  });

  test("panelRequired=true does not change the fail/flaky branches (already never promote on skip)", () => {
    expect(run({ verification: "fail", panelRequired: true, n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
    expect(
      run({ verification: "flaky", panelRequired: true, flakyUsed: 0, maxFlaky: 2, n: 1, maxAttempts: 3 }),
    ).toEqual({ action: "retry" });
  });
});

describe("decide — NO-GATES + verdict.ok (Verifier IS the gate)", () => {
  const noGates = { gatesConfigured: false, gatesOk: true, verdict: okVerdict };

  test("verification pass -> DONE (the M2 promote)", () => {
    expect(run({ ...noGates, verification: "pass" })).toEqual({ action: "done" });
  });

  test("verification skip -> needs-review (pre-M2 behavior preserved)", () => {
    expect(run({ ...noGates, verification: "skip" })).toEqual({ action: "needs-review" });
  });

  test("verification fail with n < maxAttempts -> retry", () => {
    expect(run({ ...noGates, verification: "fail", n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
  });

  test("verification fail at n == maxAttempts -> needs-review", () => {
    expect(run({ ...noGates, verification: "fail", n: 3, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "verification failed",
    });
  });

  test("flaky within budget -> retry", () => {
    expect(run({ ...noGates, verification: "flaky", flakyUsed: 0, maxFlaky: 2 })).toEqual({ action: "retry" });
  });

  test("flaky over budget -> needs-review", () => {
    expect(run({ ...noGates, verification: "flaky", flakyUsed: 2, maxFlaky: 2 })).toEqual({
      action: "needs-review",
      error: "verification flaky",
    });
  });
});

describe("decide — unchanged branches (verdict not ok / null)", () => {
  test("gated + gatesOk + verdict not ok -> needs-review with blocker", () => {
    expect(run({ verdict: badVerdict })).toEqual({ action: "needs-review", error: "boom" });
  });

  test("gated + gatesOk + verdict not ok, null blocker -> needs-review, undefined error", () => {
    expect(run({ verdict: { ...badVerdict, blocker: null } })).toEqual({
      action: "needs-review",
      error: undefined,
    });
  });

  test("gated + gatesOk + verdict null, retryable -> retry", () => {
    expect(run({ verdict: null, n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
  });

  test("gated + gatesOk + verdict null, exhausted -> needs-review", () => {
    expect(run({ verdict: null, n: 3, maxAttempts: 3 })).toEqual({
      action: "needs-review",
      error: "gates pass but agent never confirmed",
    });
  });

  test("gates fail, retryable -> retry", () => {
    expect(run({ gatesConfigured: true, gatesOk: false, n: 1, maxAttempts: 3 })).toEqual({ action: "retry" });
  });

  test("gates fail, exhausted -> failed", () => {
    expect(run({ gatesConfigured: true, gatesOk: false, n: 3, maxAttempts: 3 })).toEqual({ action: "failed" });
  });

  test("no-gates + verdict not ok, retryable -> retry", () => {
    expect(run({ gatesConfigured: false, gatesOk: true, verdict: badVerdict, n: 1, maxAttempts: 3 })).toEqual({
      action: "retry",
    });
  });

  test("no-gates + verdict not ok, exhausted -> failed", () => {
    expect(run({ gatesConfigured: false, gatesOk: true, verdict: badVerdict, n: 3, maxAttempts: 3 })).toEqual({
      action: "failed",
    });
  });

  test("no-gates + verdict null, retryable -> retry", () => {
    expect(run({ gatesConfigured: false, gatesOk: true, verdict: null, n: 1, maxAttempts: 3 })).toEqual({
      action: "retry",
    });
  });

  test("no-gates + verdict null, exhausted -> failed", () => {
    expect(run({ gatesConfigured: false, gatesOk: true, verdict: null, n: 3, maxAttempts: 3 })).toEqual({
      action: "failed",
    });
  });
});

// Regression guard: with verification "skip" the outcome must be byte-identical
// to the pre-M2 decision across every reachable state (the M2 file-header claim).
describe("decide — regression guard: verification 'skip' == pre-M2 decision", () => {
  // Pre-M2 (verification informational only) decision table.
  function preM2(i: Omit<Input, "verification">): Decision {
    const canRetry = i.n < i.maxAttempts;
    if (i.gatesConfigured && i.gatesOk) {
      if (i.verdict?.ok) return { action: "done" };
      if (i.verdict) return { action: "needs-review", error: i.verdict.blocker ?? undefined };
      return canRetry
        ? { action: "retry" }
        : { action: "needs-review", error: "gates pass but agent never confirmed" };
    }
    if (!i.gatesConfigured) {
      if (i.verdict?.ok) return { action: "needs-review" };
      return canRetry ? { action: "retry" } : { action: "failed" };
    }
    return canRetry ? { action: "retry" } : { action: "failed" };
  }

  const verdicts: (Verdict | null)[] = [okVerdict, badVerdict, { ...badVerdict, blocker: null }, null];
  let cases = 0;
  for (const gatesConfigured of [true, false]) {
    for (const gatesOk of [true, false]) {
      for (const verdict of verdicts) {
        for (const n of [1, 3]) {
          const base = { gatesConfigured, gatesOk, verdict, n, maxAttempts: 3, flakyUsed: 0, maxFlaky: 2 };
          test(`skip matches pre-M2: gc=${gatesConfigured} gok=${gatesOk} v=${verdict?.ok ?? "null"} n=${n}`, () => {
            expect(decide({ ...base, verification: "skip" })).toEqual(preM2(base));
          });
          cases++;
        }
      }
    }
  }
  test("regression matrix covered every combination", () => {
    expect(cases).toBe(32);
  });
});
