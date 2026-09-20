/**
 * WHAT A LONG SESSION ACTUALLY COSTS, IN BILLED TOKENS — issue #587, step 0.
 *
 * #587 reads a measured sawtooth peaking at 700–740k against a 200k baseline
 * and calls it "~3.5× the spend". 700/200 = 3.5 exactly, which is a ratio of
 * CONTEXT SIZES, and it prices every token in the window the same. This
 * repository's own pricing function does not: `priceTokens` bills `cacheRead`
 * at the provider's discounted rate and `cacheCreate` at its own, and a
 * long-lived session is precisely the case where most of a 700k prompt is a
 * cache read. The issue is explicit that its figures are list-price equivalents
 * used as a proxy; this prices the same shape through `priceTokens` instead.
 *
 * ── THE ANSWER THIS IS ALLOWED TO GIVE ─────────────────────────────────────
 * "If the multiplier collapses under the cache discount, most of this issue
 * closes by deletion — which is the outcome worth wanting." So this bench is
 * built to be able to say that, and the table below is the acceptance
 * criterion #587 names: its table, restated in billed tokens.
 *
 * ── THIS IS A MODEL, AND SAYING SO IS THE POINT ────────────────────────────
 * It is NOT a measurement of anyone's sessions, and it must never become one:
 * "Built and asserted on a fixture; pointed at real transcripts only with the
 * owner's say-so." Nothing here reads `~/.claude`, `~/.codex`, the live store
 * or a journal. What it does is take the ONE number nobody has established —
 * how much of each prompt is a cache read — and sweep it, so the reader can see
 * which conclusions survive which assumption rather than being handed one
 * figure to trust.
 *
 * That unestablished number is the whole ballgame, and #587 says so under what
 * it could not establish: "Whether the weekly limit meters cache reads at the
 * discounted weight. This decides whether the multiplier is ~3.5× or closer to
 * ~1.2×, and therefore whether this issue is worth a PR at all."
 *
 * ── WHAT WOULD MAKE THIS LIE ───────────────────────────────────────────────
 * A pricing function that returns zero, or a model in which the two thresholds
 * do the same work. Both are checked in `test/compaction-cost.test.ts` — one of
 * them by freezing the rate table to all-zero and asserting the comparison goes
 * red, which is this repository's own rule after six performance tests passed
 * while measuring a frozen clock.
 *
 * Run: `bun run --cwd apps/engine bench:compaction`
 */
import { priceTokens, type RatesTable } from "../src/usage-pricing";

/**
 * LIST PRICE AS RATIOS OF THE INPUT RATE, which is what makes this a fixture
 * rather than a forecast. Anthropic's published shape for the Claude 5 family:
 * output 5×, a cache READ a tenth, a 5-minute cache WRITE 1.25×, and — the one
 * `priceTokens` takes separately — a 1-hour cache write at 2×.
 *
 * The absolute input rate is deliberately a round 1e-5/token so every figure
 * below reads as "dollars at this rate"; only the RATIOS between the four
 * buckets change the answer, and those are the published ones.
 */
export const FIXTURE_RATES: RatesTable = {
  status: "fresh",
  rates: new Map([["claude-opus-5", { inputPerTok: 1e-5, outputPerTok: 5e-5, cacheReadPerTok: 1e-6, cacheCreatePerTok: 1.25e-5 }]]),
};

export const MODEL = "claude-opus-5";

/** One turn's four buckets, the split `usage.ts` already parses per record. */
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheCreate: number };

export type SessionShape = {
  /** Compaction fires when the context reaches this. */
  thresholdTokens: number;
  /** Turns of work to do — the SAME for every threshold, which is the point. */
  turns: number;
  /** What one turn adds to the context: the reply plus whatever it read. */
  growthPerTurn: number;
  /** Fresh user text per turn. Small, and it is the only uncached input. */
  freshInputPerTurn: number;
  /** Tokens generated per turn. */
  outputPerTurn: number;
  /**
   * The fraction of an already-seen prompt that bills as a cache READ rather
   * than being re-sent as input. 1.0 is a perfectly warm prefix; 0.0 is a
   * session with no caching at all, which is the arithmetic #587's 3.5×
   * implicitly assumes.
   */
  cacheHitRate: number;
  /** The context a compaction leaves behind, as a fraction of the threshold. */
  summaryFraction: number;
};

export const BASELINE: Omit<SessionShape, "thresholdTokens"> = {
  turns: 400,
  // 1,750 tokens of context per turn: a reply plus the file reads and command
  // output around it. Chosen so that 400 turns of work crosses a 200k window
  // several times and a 750k window once — the shape of #587's sawtooth.
  growthPerTurn: 1_750,
  freshInputPerTurn: 150,
  outputPerTurn: 600,
  cacheHitRate: 1,
  summaryFraction: 0.12,
};

/**
 * ONE SESSION'S BILLED TOKENS, bucket by bucket.
 *
 * The model, stated so it can be argued with:
 *
 *   - A turn sends the whole context. The part the provider has already seen
 *     bills as `cacheRead` (×`cacheHitRate`) or as plain `input` otherwise;
 *     the part added since the last write bills as `cacheCreate`; the user's
 *     new text bills as `input`.
 *   - A COMPACTION IS NOT FREE and is the term #587's ratio omits entirely.
 *     The summarisation call reads the whole context — one more full prompt —
 *     and the turn after it re-creates the cache over the summary from cold.
 *     A scheme that compacts more often pays this more often, which is exactly
 *     the cost a "smaller window is cheaper" argument has to clear.
 *   - Work is held constant across thresholds. Comparing cost per TURN would
 *     hide the thing #587 warns about — "a session that compacts more
 *     re-establishes context and takes more turns for the same work" — so this
 *     runs the same `turns` either way and any extra cost is the threshold's.
 */
export function simulate(shape: SessionShape): { tokens: TurnTokens; compactions: number; peakContext: number } {
  const tokens: TurnTokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let context = shape.summaryFraction * shape.thresholdTokens;
  let cached = 0;
  let compactions = 0;
  let peakContext = context;

  for (let turn = 0; turn < shape.turns; turn += 1) {
    const seen = Math.min(cached, context);
    const unseen = Math.max(0, context - seen);
    tokens.cacheRead += seen * shape.cacheHitRate;
    tokens.input += seen * (1 - shape.cacheHitRate) + shape.freshInputPerTurn;
    tokens.cacheCreate += unseen;
    tokens.output += shape.outputPerTurn;

    context += shape.growthPerTurn;
    cached = context;
    peakContext = Math.max(peakContext, context);

    if (context >= shape.thresholdTokens) {
      compactions += 1;
      // The summarisation call reads the whole context once more.
      tokens.cacheRead += context * shape.cacheHitRate;
      tokens.input += context * (1 - shape.cacheHitRate);
      tokens.output += shape.summaryFraction * shape.thresholdTokens;
      // And the next turn starts from a cold cache over the summary.
      context = shape.summaryFraction * shape.thresholdTokens;
      cached = 0;
    }
  }
  return { tokens, compactions, peakContext };
}

/** Billed dollars for a simulated session, through the repository's own pricer. */
export function billed(tokens: TurnTokens): number {
  const cost = priceTokens(FIXTURE_RATES, MODEL, tokens);
  if (cost === undefined) throw new Error("the fixture rate table does not price its own model — the bench is not wired up");
  return cost;
}

/** Every token the window moved, priced the flat way #587's 3.5× implies. */
export function flatTokens(tokens: TurnTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
}

/** The two thresholds #587 is about: the 200k window it wants back, and today's. */
export const THRESHOLDS = [200_000, 750_000];

export type Row = {
  thresholdTokens: number;
  cacheHitRate: number;
  compactions: number;
  peakContext: number;
  flat: number;
  usd: number;
};

export function sweep(hitRates: number[] = [0, 0.5, 0.9, 1]): Row[] {
  const rows: Row[] = [];
  for (const cacheHitRate of hitRates) {
    for (const thresholdTokens of THRESHOLDS) {
      const run = simulate({ ...BASELINE, cacheHitRate, thresholdTokens });
      rows.push({
        thresholdTokens,
        cacheHitRate,
        compactions: run.compactions,
        peakContext: run.peakContext,
        flat: flatTokens(run.tokens),
        usd: billed(run.tokens),
      });
    }
  }
  return rows;
}

/** The multiplier #587 states as ~3.5×, per cache-hit assumption. */
export function multipliers(rows: Row[]): { cacheHitRate: number; flatRatio: number; billedRatio: number }[] {
  const out: { cacheHitRate: number; flatRatio: number; billedRatio: number }[] = [];
  for (const rate of [...new Set(rows.map((row) => row.cacheHitRate))]) {
    const small = rows.find((row) => row.cacheHitRate === rate && row.thresholdTokens === THRESHOLDS[0]);
    const large = rows.find((row) => row.cacheHitRate === rate && row.thresholdTokens === THRESHOLDS[1]);
    if (!small || !large) continue;
    out.push({ cacheHitRate: rate, flatRatio: large.flat / small.flat, billedRatio: large.usd / small.usd });
  }
  return out;
}

if (import.meta.main) {
  const rows = sweep();
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

  console.log(`#587 restated in billed tokens — ${BASELINE.turns} turns of identical work, priced through priceTokens()\n`);
  console.log("cache-read share | threshold | compactions | peak context |  all tokens |     billed");
  console.log("-----------------|-----------|-------------|--------------|-------------|-----------");
  for (const row of rows) {
    console.log(
      `${String(Math.round(row.cacheHitRate * 100)).padStart(15)}% | ${fmt(row.thresholdTokens).padStart(9)} | ` +
        `${String(row.compactions).padStart(11)} | ${fmt(row.peakContext).padStart(12)} | ${fmt(row.flat).padStart(11)} | ` +
        `$${row.usd.toFixed(2).padStart(9)}`,
    );
  }

  console.log("\nthe multiplier #587 states as ~3.5×:\n");
  console.log("cache-read share | by token count | by billed cost");
  console.log("-----------------|----------------|---------------");
  for (const row of multipliers(rows)) {
    console.log(
      `${String(Math.round(row.cacheHitRate * 100)).padStart(15)}% | ${`${row.flatRatio.toFixed(2)}×`.padStart(14)} | ` +
        `${`${row.billedRatio.toFixed(2)}×`.padStart(14)}`,
    );
  }
  console.log(
    "\nThe left column is #587's arithmetic; the right is this repository's pricer. They\n" +
      "diverge because a big window's extra tokens are almost all CACHE READS, billed at a\n" +
      "tenth — and because the small window pays for many more compactions, each of which\n" +
      "reads a whole context and then rebuilds a cache from cold.\n\n" +
      "WHICH ROW IS REAL IS NOT ESTABLISHED HERE and cannot be, from a fixture: it depends\n" +
      "on whether the weekly limit meters a cache read at the discounted weight. #587 names\n" +
      "that as the open question that decides whether it is worth a PR at all.",
  );
}
