import type { ProviderDriverKind, TokenUsage, UsageBucket, UsageReport } from "@telar/engine-client";

type UsageTotals = {
  tokens: TokenUsage;
  processed: number;
  costUsd: number;
  priced: boolean;
  turns: number;
};

type ProviderSlice = UsageTotals & { driver: ProviderDriverKind; share: number };
type ModelSlice = UsageTotals & { driver: ProviderDriverKind; model: string; share: number };
type PeriodSlice = {
  period: string;
  byDriver: Partial<Record<ProviderDriverKind, UsageTotals>>;
  total: UsageTotals;
};

export type UsageFold = {
  total: UsageTotals;
  providers: ProviderSlice[];
  models: ModelSlice[];
  /** Every period in the window, empty ones included, ascending. */
  periods: PeriodSlice[];
  sessions: number;
};

const DRIVERS: ProviderDriverKind[] = ["claude", "codex", "opencode"];
export const DRIVER_LABEL: Record<ProviderDriverKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

const zeroTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const zeroTotals = (): UsageTotals => ({ tokens: zeroTokens(), processed: 0, costUsd: 0, priced: true, turns: 0 });

function processedTokens(tokens: TokenUsage): number {
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
  // 24h hops can repeat a date across DST; the dedupe drops the repeat.
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

    const period = byPeriod.get(bucket.period);
    if (period) {
      const driver = period.byDriver[bucket.driver] ?? zeroTotals();
      fold(driver, bucket);
      period.byDriver[bucket.driver] = driver;
      fold(period.total, bucket);
    }
  }

  // Shares are of processed tokens: cost is absent for whole providers.
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

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

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

export function formatPeriodShort(period: string, resolution: "day" | "hour"): string {
  if (resolution === "hour") {
    const at = Number(period);
    return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(at) : period;
  }
  const [year, month, day] = period.split("-").map(Number);
  if (!year || !month || !day) return period;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(year, month - 1, day));
}
