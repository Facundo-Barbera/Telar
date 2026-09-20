/**
 * WHAT THE SESSION FEED SAVES THE PUSH WORKER — issue #586.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TRAP THIS IS WRITTEN AGAINST is asserting that the worker still works
 * after the change. It did before. What has to be shown is the COST, and a
 * correctness test cannot see a cost at all: "turn the feed off" and "turn the
 * poll off" both leave a converged worker.
 *
 * SO THE ASSERTION IS A COUNT OF UNCONDITIONAL PASSES over a stretch of
 * simulated time, computed from the REAL constants the worker schedules with
 * rather than from numbers restated here. The OFF case is asserted first, on
 * the investigation's instruction: a saving measured only in the new state is
 * a saving nobody has shown.
 * ────────────────────────────────────────────────────────────────────────────
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { passesOver, pollDelay } from "./worker";

describe("the cadence the feed buys (#586)", () => {
  test("WITHOUT the feed, ten minutes costs sixty wide passes", () => {
    // The state this worker has been in since #584: a ten-second tick asking
    // `liveSessionsMatching` whether anything happened, and almost always
    // being told no.
    expect(pollDelay(false)).toBe(10_000);
    expect(passesOver(10, false)).toBe(60);
    expect(passesOver(60, false)).toBe(360);
  });

  test("WITH the feed, the same ten minutes costs ONE", () => {
    // The timer stops being the mechanism and becomes the safety net: the only
    // unconditional pass left is the reconcile.
    expect(pollDelay(true)).toBe(600_000);
    expect(passesOver(10, true)).toBe(1);
    expect(passesOver(60, true)).toBe(6);
  });

  test("the reconcile is NOT removed, which is what makes the feed safe to trust", () => {
    /**
     * THE HALF A SAVING LIKE THIS USUALLY GETS WRONG. If the feed were the
     * only mechanism, a dropped connection would be a worker that never woke
     * again — and the failure would be silent, because nothing is supposed to
     * happen most of the time anyway.
     *
     * A frame is never the record, so the unconditional pass still comes
     * round: over an hour the connected worker makes six of them, not none.
     */
    expect(passesOver(60, true)).toBeGreaterThan(0);
    // ...and it is genuinely cheaper, or the change bought nothing.
    expect(passesOver(60, true)).toBeLessThan(passesOver(60, false));
  });
});
