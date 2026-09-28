import fs from "node:fs";
import type { TokenUsage } from "@telar/engine-client";

const LITELLM_RATES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_TTL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;

type ModelRate = {
  inputPerTok: number;
  outputPerTok: number;
  cacheReadPerTok?: number;
  cacheCreatePerTok?: number;
};

export type RatesTable = {
  status: "fresh" | "cached" | "unavailable";
  rates: Map<string, ModelRate>;
};

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
    if (input === undefined || output === undefined) continue;
    const cacheRead = num("cache_read_input_token_cost");
    const cacheCreate = num("cache_creation_input_token_cost");
    const candidate: ModelRate = {
      inputPerTok: input,
      outputPerTok: output,
      ...(cacheRead !== undefined ? { cacheReadPerTok: cacheRead } : {}),
      ...(cacheCreate !== undefined ? { cacheCreatePerTok: cacheCreate } : {}),
    };
    // Prefixed and bare rows normalize to one name and the prefixed one may omit cache rates; the most complete row wins.
    const existing = rates.get(normalizeModelName(name));
    const fields = (rate: ModelRate): number => (rate.cacheReadPerTok !== undefined ? 1 : 0) + (rate.cacheCreatePerTok !== undefined ? 1 : 0);
    if (existing && fields(existing) >= fields(candidate)) continue;
    rates.set(normalizeModelName(name), candidate);
  }
  return rates;
}

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
  } catch {}
  if (typeof disk?.fetchedAt === "number" && now - disk.fetchedAt < RATES_TTL_MS) {
    const table: RatesTable = { status: "cached", rates: parseRates(disk.payload) };
    memo = { at: now, table };
    return table;
  }

  try {
    const payload = await fetcher(LITELLM_RATES_URL);
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, payload }));
    } catch {}
    const table: RatesTable = { status: "fresh", rates: parseRates(payload) };
    memo = { at: now, table };
    return table;
  } catch {
    const table: RatesTable = disk?.payload !== undefined ? { status: "cached", rates: parseRates(disk.payload) } : { status: "unavailable", rates: new Map() };
    memo = { at: now - RATES_TTL_MS + 5 * 60_000, table };
    return table;
  }
}

export function resetRatesMemo(): void {
  memo = undefined;
}

/** `cacheCreate1h` is the part of `tokens.cacheCreate` written with the 1-hour TTL, billed at 2× input. */
export function priceTokens(rates: RatesTable, model: string, tokens: TokenUsage, options: { cacheCreate1h?: number } = {}): number | undefined {
  const name = normalizeModelName(model);
  if (UNPRICEABLE.has(name)) return undefined;
  const rate = rates.rates.get(name);
  if (!rate) return undefined;
  const oneHour = Math.min(tokens.cacheCreate, Math.max(0, options.cacheCreate1h ?? 0));
  return (
    tokens.input * rate.inputPerTok +
    tokens.output * rate.outputPerTok +
    tokens.cacheRead * (rate.cacheReadPerTok ?? rate.inputPerTok) +
    (tokens.cacheCreate - oneHour) * (rate.cacheCreatePerTok ?? rate.inputPerTok) +
    oneHour * 2 * rate.inputPerTok
  );
}
