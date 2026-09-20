import type { ProviderDriverKind, TokenUsage, UsageBucket, UsageReport } from "@telar/engine-client";

/**
 * The usage page's fold — everything derivable from a `UsageReport`, derived
 * once here so the page renders figures and never arithmetic. Pure and
 * exported for tests.
 *
 * COST: the provider's own figure when it reports one, else the engine
 * prices tokens from the LiteLLM rate table (usage-pricing.ts) — cache reads
 * at the API's 0.1× rate, cache writes at 1.25× (2× for 1h TTL). A model
 * with no known rate renders as absent (`priced: false`) rather than $0.00
 * — a zero would claim the work was free.
 */

export type UsageTotals = {
  tokens: TokenUsage;
  processed: number;
  costUsd: number;
  /** True when every counted turn carried a provider cost figure. */
  priced: boolean;
  turns: number;
};

export type ProviderSlice = UsageTotals & { driver: ProviderDriverKind; share: number };
export type ModelSlice = UsageTotals & { driver: ProviderDriverKind; model: string; share: number };
export type PeriodSlice = {
  period: string;
  byDriver: Partial<Record<ProviderDriverKind, UsageTotals>>;
  total: UsageTotals;
};

export type UsageFold = {
  total: UsageTotals;
  providers: ProviderSlice[];
  models: ModelSlice[];
  /** Every period in the window, EMPTY ONES INCLUDED — a chart that skips
   *  quiet days draws a lie about the busy ones. Ascending. */
  periods: PeriodSlice[];
  sessions: number;
};

/**
 * Every provider a usage row can name.
 *
 * `telar` WAS A FOURTH until #531 removed the driver. The Agent still spends
 * tokens, and this report does not yet count them — it folds per-SESSION usage,
 * and the Agent has no session. Counting it is a separate question from
 * removing the driver, and answering it here would have meant inventing a row
 * shape nothing writes.
 */
export const DRIVERS: ProviderDriverKind[] = ["claude", "codex", "opencode"];
export const DRIVER_LABEL: Record<ProviderDriverKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

const zeroTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const zeroTotals = (): UsageTotals => ({ tokens: zeroTokens(), processed: 0, costUsd: 0, priced: true, turns: 0 });

export function processedTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
}

function fold(into: UsageTotals, bucket: UsageBucket): void {
  into.tokens.input += bucket.tokens.input;
  into.tokens.output += bucket.tokens.output;
  into.tokens.cacheRead += bucket.tokens.cacheRead;
  into.tokens.cacheCreate += bucket.tokens.cacheCreate;
  into.processed += processedTokens(bucket.tokens);
  into.costUsd += bucket.costUsd;
  into.priced = into.priced && bucket.priced;
  into.turns += bucket.turns;
}

/** Every period the window contains, in order — days as `YYYY-MM-DD` in the
 *  report's zone, hours as epoch-ms strings, matching the buckets' own keys. */
export function windowPeriods(report: UsageReport): string[] {
  const out: string[] = [];
  if (report.resolution === "hour") {
    const HOUR = 3_600_000;
    for (let at = Math.floor(report.sinceMs / HOUR) * HOUR; at < report.untilMs; at += HOUR) out.push(String(at));
    return out;
  }
  const format = (at: number): string => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: report.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    } catch {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    }
  };
  // Stepped in 24h hops from mid-window-day so a DST hour cannot skip or
  // repeat a date; dedupe guards the repeat case anyway.
  let previous = "";
  for (let at = report.sinceMs; at < report.untilMs + 86_400_000; at += 86_400_000) {
    const day = format(Math.min(at, report.untilMs));
    if (day !== previous) out.push(day);
    previous = day;
    if (at >= report.untilMs) break;
  }
  return out;
}

export function foldUsage(report: UsageReport): UsageFold {
  const total = zeroTotals();
  const byProvider = new Map<ProviderDriverKind, UsageTotals>();
  const byModel = new Map<string, ModelSlice>();
  const byPeriod = new Map<string, PeriodSlice>();
  for (const period of windowPeriods(report)) byPeriod.set(period, { period, byDriver: {}, total: zeroTotals() });

  for (const bucket of report.buckets) {
    fold(total, bucket);

    const provider = byProvider.get(bucket.driver) ?? zeroTotals();
    fold(provider, bucket);
    byProvider.set(bucket.driver, provider);

    const modelKey = `${bucket.driver}\0${bucket.model}`;
    const model = byModel.get(modelKey) ?? { ...zeroTotals(), driver: bucket.driver, model: bucket.model, share: 0 };
    fold(model, bucket);
    byModel.set(modelKey, model);

    // A bucket outside the enumerated window (clock skew, zone drift) still
    // counts in totals; it just has no column to land in.
    const period = byPeriod.get(bucket.period);
    if (period) {
      const driver = period.byDriver[bucket.driver] ?? zeroTotals();
      fold(driver, bucket);
      period.byDriver[bucket.driver] = driver;
      fold(period.total, bucket);
    }
  }

  // Shares are of PROCESSED TOKENS, not cost — cost is absent for a whole
  // provider (Codex), and a share of a figure missing half its terms would
  // always read 100% Claude.
  const share = (slice: UsageTotals): number => (total.processed > 0 ? slice.processed / total.processed : 0);

  return {
    total,
    providers: DRIVERS.flatMap((driver) => {
      const slice = byProvider.get(driver);
      return slice && (slice.processed > 0 || slice.turns > 0) ? [{ ...slice, driver, share: share(slice) }] : [];
    }),
    models: [...byModel.values()]
      .map((slice) => ({ ...slice, share: share(slice) }))
      .sort((left, right) => right.processed - left.processed),
    periods: [...byPeriod.values()],
    sessions: report.sessions,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Compact token figure: `12.3K`, `4.56M` — three significant figures. */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `${scaled.toPrecision(3)}${suffix}`;
    }
  }
  return String(value);
}

export function formatShare(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** "Aug 7" from a day key, "3 PM" from an hour key. */
export function formatPeriodShort(period: string, resolution: "day" | "hour"): string {
  if (resolution === "hour") {
    const at = Number(period);
    return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(at) : period;
  }
  const [year, month, day] = period.split("-").map(Number);
  if (!year || !month || !day) return period;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(year, month - 1, day));
}
