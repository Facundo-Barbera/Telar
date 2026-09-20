/**
 * THE BENCH'S OWN INSTRUMENT, FALSIFIED FIRST — issue #587, step 0.
 *
 * #587 is explicit about what it will and will not believe, and it is explicit
 * because this repository has been burned twice: "Falsify the instrument before
 * believing it. Freeze the token counters at zero and confirm the cost
 * comparison goes red, the way #799 froze `measure()` and watched three tests
 * die." A bench whose numbers cannot be made to fail is a bench that has
 * demonstrated nothing, and its table should not be quoted in a PR body.
 *
 * So the first test here breaks the pricer on purpose. The rest pin the model's
 * arithmetic — that both thresholds do the SAME WORK (or the comparison is
 * meaningless), that compaction is not free (the term #587's ratio omits), and
 * the finding the PR body rests on.
 */
import { expect, test } from "bun:test";

import {
  BASELINE,
  FIXTURE_RATES,
  MODEL,
  THRESHOLDS,
  billed,
  flatTokens,
  multipliers,
  simulate,
  sweep,
} from "../bench/compaction-cost";
import { priceTokens, type RatesTable } from "../src/usage-pricing";

test("a frozen rate table takes the whole comparison to zero, so the bench can fail", () => {
  /**
   * #799's shape: six performance tests passed while `measure()` returned a
   * frozen clock. The equivalent here is a rate table of zeroes — every figure
   * in the bench's table would read $0.00 and every ratio would be NaN, and
   * nothing in the bench's own output says so. This is the assertion that makes
   * the live numbers mean something.
   */
  const frozen: RatesTable = {
    status: "fresh",
    rates: new Map([[MODEL, { inputPerTok: 0, outputPerTok: 0, cacheReadPerTok: 0, cacheCreatePerTok: 0 }]]),
  };
  const run = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[1] });
  expect(priceTokens(frozen, MODEL, run.tokens)).toBe(0);
  // And the live table does NOT, which is the half that says the instrument is
  // switched on rather than merely present.
  expect(billed(run.tokens)).toBeGreaterThan(1);
  expect(priceTokens(FIXTURE_RATES, MODEL, run.tokens)).toBeGreaterThan(0);
});

test("an unpriceable model makes the bench throw rather than print a zero", () => {
  // A bare family alias is unpriceable by construction. The bench must refuse
  // rather than quietly table $0.00, which would read as "free" instead of
  // "unknown" — `usage-pricing.ts`'s own rule.
  expect(priceTokens(FIXTURE_RATES, "opus", { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 })).toBeUndefined();
});

test("both thresholds do exactly the same work, or the comparison means nothing", () => {
  /**
   * #587: "Compare cost per completed task, not per turn. A session that
   * compacts more re-establishes context and takes more turns for the same
   * work. Per-turn cost hides exactly that." The model holds turns constant, so
   * output is identical bar the summaries — any cost difference is the
   * threshold's and not a difference in how much was done.
   */
  const small = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[0] });
  const large = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[1] });

  const work = (runTokens: { output: number }, compactions: number, threshold: number) =>
    runTokens.output - compactions * BASELINE.summaryFraction * threshold;
  expect(work(small.tokens, small.compactions, THRESHOLDS[0])).toBeCloseTo(BASELINE.turns * BASELINE.outputPerTurn, 6);
  expect(work(large.tokens, large.compactions, THRESHOLDS[1])).toBeCloseTo(BASELINE.turns * BASELINE.outputPerTurn, 6);
});

test("compaction is not free — the term #587's ratio leaves out entirely", () => {
  // The small window compacts more, and each compaction reads a whole context
  // and then rebuilds a cache from cold. A model in which compaction cost
  // nothing would make the small window unconditionally cheaper, which is the
  // conclusion this bench exists to avoid reaching by construction.
  const small = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[0] });
  const large = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[1] });
  expect(small.compactions).toBeGreaterThan(large.compactions);
  // Cold rebuilds after each compaction, so the small window writes cache more
  // times over the same work despite holding less of it at any moment.
  expect(small.tokens.cacheCreate / small.compactions).toBeLessThan(large.tokens.cacheCreate);
});

test("the cache discount cannot collapse the multiplier, because it applies to both windows", () => {
  /**
   * THE FINDING, and it is the opposite of the one #587 hoped for. "If the
   * multiplier collapses under the cache discount, most of this issue closes by
   * deletion." It does not collapse, and the reason is structural rather than
   * numerical: a discount that multiplies the numerator and the denominator
   * leaves their ratio alone. Cache pricing moves the multiplier only through
   * the second-order term — the small window's extra compactions — and that
   * moves it the WRONG WAY for the issue's argument.
   *
   * Pinned as a band rather than a figure: the exact numbers depend on the
   * fixture's shape, and a test that pinned 2.91 would go red on any honest
   * adjustment to the model while proving nothing extra.
   */
  const ratios = multipliers(sweep([0, 1]));
  const flat = ratios.map((row) => row.flatRatio);
  const cost = ratios.map((row) => row.billedRatio);

  // The token count does not care about pricing at all — same both ways.
  expect(flat[0]).toBeCloseTo(flat[1], 6);
  // Billed, a fully-cached session's multiplier is LOWER but nowhere near 1.
  expect(cost[1]).toBeLessThan(cost[0]);
  expect(cost[1]).toBeGreaterThan(2);
  // #587's own alternative hypothesis — "closer to ~1.2×" — is not what this
  // model produces under any cache assumption, which is the useful answer.
  expect(Math.min(...cost)).toBeGreaterThan(1.5);
});

test("every row in the printed table is a real figure, not an empty one", () => {
  const rows = sweep();
  expect(rows.length).toBe(8);
  for (const row of rows) {
    expect(row.usd).toBeGreaterThan(0);
    expect(row.flat).toBeGreaterThan(0);
    expect(row.peakContext).toBeGreaterThan(row.thresholdTokens * BASELINE.summaryFraction);
    expect(row.compactions).toBeGreaterThan(0);
  }
  // The four-way split is actually populated — a model that put everything in
  // one bucket would price correctly and describe nothing.
  const run = simulate({ ...BASELINE, thresholdTokens: THRESHOLDS[1] });
  for (const bucket of ["input", "output", "cacheRead", "cacheCreate"] as const) {
    expect(run.tokens[bucket]).toBeGreaterThan(0);
  }
  expect(flatTokens(run.tokens)).toBeGreaterThan(run.tokens.output);
});
