/**
 * Model rates, for records whose transcript reports no cost.
 *
 * THE PROVIDER'S OWN FIGURE ALWAYS WINS — this table only prices records that
 * carried none (Codex never reports cost; Claude's transcripts omit it on
 * subscription plans). Rates come from LiteLLM's public table, the same
 * source t3 code and ccusage use, cached on disk for a day so the usage page
 * works offline and never blocks on the network for more than one cold read.
 *
 * A model the table does not know stays UNPRICED: its tokens count, its cost
 * reads as absent. Guessing a price would put a made-up number on a page
 * whose whole job is honesty. Bare family aliases (`opus`, `haiku`, …) are
 * unpriceable by construction — they are ambiguous across generations.
 */

import fs from "node:fs";
import type { TokenUsage } from "@telar/engine-client";

export const LITELLM_RATES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_TTL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;

export type ModelRate = {
  inputPerTok: number;
  outputPerTok: number;
  cacheReadPerTok?: number;
  cacheCreatePerTok?: number;
};

export type RatesTable = {
  status: "fresh" | "cached" | "unavailable";
  rates: Map<string, ModelRate>;
};

/** `anthropic/claude-opus-5` and `claude-opus-5` are the same row. */
export function normalizeModelName(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable", "default"]);

function parseRates(payload: unknown): Map<string, ModelRate> {
  const rates = new Map<string, ModelRate>();
  if (typeof payload !== "object" || payload === null) return rates;
  for (const [name, entry] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const num = (key: string): number | undefined => (typeof row[key] === "number" && row[key] >= 0 ? (row[key] as number) : undefined);
    const input = num("input_cost_per_token");
    const output = num("output_cost_per_token");
    // Half a price silently under-reports; a row missing either side is out.
    if (input === undefined || output === undefined) continue;
    const cacheRead = num("cache_read_input_token_cost");
    const cacheCreate = num("cache_creation_input_token_cost");
    const candidate: ModelRate = {
      inputPerTok: input,
      outputPerTok: output,
      ...(cacheRead !== undefined ? { cacheReadPerTok: cacheRead } : {}),
      ...(cacheCreate !== undefined ? { cacheCreatePerTok: cacheCreate } : {}),
    };
    /**
     * SEVERAL ROWS NORMALIZE TO ONE NAME — `claude-fable-5` and
     * `anthropic/claude-fable-5` are both in the table, and the prefixed one
     * omits the cache rates. Last-wins let that row SHADOW the complete one,
     * and every cache read then fell back to the full input rate: measured on
     * this machine as a week of Claude use priced 7× high. The most complete
     * row wins instead; ties keep the first seen.
     */
    const existing = rates.get(normalizeModelName(name));
    const fields = (rate: ModelRate): number => (rate.cacheReadPerTok !== undefined ? 1 : 0) + (rate.cacheCreatePerTok !== undefined ? 1 : 0);
    if (existing && fields(existing) >= fields(candidate)) continue;
    rates.set(normalizeModelName(name), candidate);
  }
  return rates;
}

/**
 * The table, from memory → disk → network, in that order of cheapness. The
 * network is touched at most once per TTL; every failure degrades to the last
 * snapshot on disk, and to "unavailable" (all models unpriced, page still
 * renders) only when there has never been one.
 */
let memo: { at: number; table: RatesTable } | undefined;

export async function loadRates(
  cachePath: string,
  fetcher: (url: string) => Promise<unknown> = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`rates fetch failed: ${response.status}`);
    return response.json();
  },
): Promise<RatesTable> {
  const now = Date.now();
  if (memo && now - memo.at < RATES_TTL_MS) return memo.table;

  let disk: { fetchedAt?: number; payload?: unknown } | undefined;
  try {
    disk = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { fetchedAt?: number; payload?: unknown };
  } catch {
    // No snapshot yet.
  }
  if (typeof disk?.fetchedAt === "number" && now - disk.fetchedAt < RATES_TTL_MS) {
    const table: RatesTable = { status: "cached", rates: parseRates(disk.payload) };
    memo = { at: now, table };
    return table;
  }

  try {
    const payload = await fetcher(LITELLM_RATES_URL);
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, payload }));
    } catch {
      // A read-only state dir costs persistence, not the answer.
    }
    const table: RatesTable = { status: "fresh", rates: parseRates(payload) };
    memo = { at: now, table };
    return table;
  } catch {
    const table: RatesTable = disk?.payload !== undefined ? { status: "cached", rates: parseRates(disk.payload) } : { status: "unavailable", rates: new Map() };
    // A failed fetch is NOT memoised for the full TTL — retry on the next
    // read, but not in a tight loop.
    memo = { at: now - RATES_TTL_MS + 5 * 60_000, table };
    return table;
  }
}

/** Test seam: forget the in-memory table. */
export function resetRatesMemo(): void {
  memo = undefined;
}

/** The cost of one record's tokens at the table's base tier, or undefined
 *  when the model is unknown or unpriceable. Missing cache rates fall back to
 *  the plain input rate — cached tokens were never free. */
export function priceTokens(rates: RatesTable, model: string, tokens: TokenUsage): number | undefined {
  const name = normalizeModelName(model);
  if (UNPRICEABLE.has(name)) return undefined;
  const rate = rates.rates.get(name);
  if (!rate) return undefined;
  return (
    tokens.input * rate.inputPerTok +
    tokens.output * rate.outputPerTok +
    tokens.cacheRead * (rate.cacheReadPerTok ?? rate.inputPerTok) +
    tokens.cacheCreate * (rate.cacheCreatePerTok ?? rate.inputPerTok)
  );
}
