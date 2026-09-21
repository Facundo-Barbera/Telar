"use client";

/**
 * USAGE — what this engine's sessions spent, over time.
 *
 * t3 code's usage page, architecture included: the engine scans the provider
 * CLIs' OWN transcripts (`~/.claude/projects`, `~/.codex/sessions`), so the
 * page counts everything this machine ran — inside Telar or not — with the
 * real model on every record. Cost is the transcript's own figure where one
 * exists, the LiteLLM rate table's base tier where it doesn't, and ABSENT
 * (a dash, never $0.00) for models neither knows; shares are of processed
 * tokens so a missing rate cannot skew them.
 *
 * THE TWO SERIES COLOURS ARE --chart-1 AND --chart-2, and that is a change of
 * mind this note owes an explanation for. They used to be four hexes injected
 * in a chart-local <style>, picked with the dataviz validator against two
 * NAMED surfaces — white and `#161616`. That validation was sound and it is
 * also exactly the problem: `#161616` is Telar's dark canvas and nobody else's.
 * The moment a reader wears Ember or something they built, the chart is two
 * fixed sRGB values sitting on a surface they were never checked against, and
 * unlike every other colour in the app they cannot move with it.
 *
 * The chart tokens are the app's answer to the same question, already: five
 * hues at one lightness, 72 degrees apart so no pair collapses under any CVD,
 * with a dark step tuned on the dark spine. --chart-1 (264) and --chart-2 (336)
 * are the same two families the hexes were — a blue and a magenta — and they
 * re-tune themselves for whatever canvas they land on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCwIcon } from "lucide-react";
import type { UsageReport } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Segmented } from "@/components/settings/settings-shell";
import { UsageChart, type ChartSeries } from "@/components/usage/usage-chart";
import { UsageLimitsSection } from "@/components/usage/usage-limits";
import {
  DRIVER_LABEL,
  foldUsage,
  formatPeriodShort,
  formatShare,
  formatTokens,
  formatUsd,
  type UsageFold,
} from "@/lib/usage-report";
import { cn } from "@/lib/utils";

const api = createEngineApi();

type Metric = "cost" | "tokens";
type WindowKey = "24h" | "7d" | "30d" | "90d";
const WINDOWS: { key: WindowKey; label: string; ms: number; resolution: "day" | "hour" }[] = [
  { key: "24h", label: "24h", ms: 24 * 3_600_000, resolution: "hour" },
  { key: "7d", label: "7d", ms: 7 * 86_400_000, resolution: "day" },
  { key: "30d", label: "30d", ms: 30 * 86_400_000, resolution: "day" },
  { key: "90d", label: "90d", ms: 90 * 86_400_000, resolution: "day" },
];

const SERIES_COLOR: Record<string, string> = { claude: "var(--chart-1)", codex: "var(--chart-2)" };

function Dot({ driver }: { driver: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: SERIES_COLOR[driver] }} />;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function UsagePage() {
  const [metric, setMetric] = useState<Metric>("cost");
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");
  const [result, setResult] = useState<{ window: WindowKey; report: UsageReport }>();
  const report = result?.window === windowKey ? result.report : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Stale-while-revalidate per window: switching filters shows the last
  // report for that window INSTANTLY and refreshes behind it — the engine's
  // transcript rescan must never gate a button press.
  const cache = useRef(new Map<WindowKey, UsageReport>());
  const request = useRef(0);

  const load = useCallback(async () => {
    const generation = ++request.current;
    const window = WINDOWS.find((entry) => entry.key === windowKey)!;
    const cached = cache.current.get(windowKey);
    if (cached) setResult({ window: windowKey, report: cached });
    const untilMs = Date.now();
    setLoading(true);
    setError(undefined);
    try {
      const { usage } = await api.usage({
        sinceMs: untilMs - window.ms,
        untilMs,
        resolution: window.resolution,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const previous = cache.current.get(windowKey);
      if (!previous || usage.readAt >= previous.readAt) cache.current.set(windowKey, usage);
      if (generation === request.current) setResult({ window: windowKey, report: usage });
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : "The engine did not answer.");
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, [windowKey]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(task);
      request.current += 1;
    };
  }, [load]);

  const fold: UsageFold | undefined = useMemo(() => (report ? foldUsage(report) : undefined), [report]);
  const resolution = report?.resolution ?? "day";

  // The cost chart draws only providers that actually price their turns; a
  // flat zero line for Codex would read as "ran and cost nothing".
  const chartSeries: ChartSeries[] = useMemo(() => {
    if (!fold) return [];
    return fold.providers
      .filter((provider) => metric === "tokens" || provider.costUsd > 0)
      .map((provider) => ({
        key: provider.driver,
        label: DRIVER_LABEL[provider.driver],
        color: SERIES_COLOR[provider.driver]!,
        values: fold.periods.map((period) => {
          const slice = period.byDriver[provider.driver];
          return slice ? (metric === "cost" ? slice.costUsd : slice.processed) : 0;
        }),
      }));
  }, [fold, metric]);

  const periodLabels = useMemo(() => (fold ? fold.periods.map((period) => formatPeriodShort(period.period, resolution)) : []), [fold, resolution]);
  const format = metric === "cost" ? formatUsd : formatTokens;
  const unpricedProvider = fold?.providers.find((provider) => !provider.priced);
  const empty = fold !== undefined && fold.total.turns === 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden md:rounded-xl md:ring-1 md:ring-sidebar-border">
      <PageHeader
        title="Usage"
        actions={
          <div className="flex items-center gap-2">
            <Segmented<Metric>
              value={metric}
              onChange={setMetric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "tokens", label: "Tokens" },
              ]}
            />
            <Segmented<WindowKey>
              value={windowKey}
              onChange={(key) => {
                if (key === windowKey) return;
                request.current += 1;
                setWindowKey(key);
                const cached = cache.current.get(key);
                setResult(cached ? { window: key, report: cached } : undefined);
                setError(undefined);
                setLoading(true);
              }}
              options={WINDOWS.map(({ key, label }) => ({ value: key, label }))}
            />
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <RotateCwIcon />}
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-5">
          {/* CAPACITY BEFORE SPEND. What is left decides whether the next turn
              runs; what was spent is history. The section draws nothing at all
              unless a hub is configured, so the page below is unchanged for
              everybody who has not set one up — and it sits OUTSIDE the
              `fold && !empty` gate deliberately: a machine that ran nothing
              locally can still be pooling accounts that are nearly out. */}
          <UsageLimitsSection />
          {/* These two used to ride in the header's subtitle. The subtitle is
              gone (it crowded the title), but an engine that could not answer
              and a model with no known rate are both things a person reading
              a cost figure needs to be told, so they moved into the flow. */}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!error && unpricedProvider && metric === "cost" && (
            <p className="text-sm text-muted-foreground">Some models have no known rate; their cost is not counted.</p>
          )}
          {!report && loading && <p role="status" className="text-sm text-muted-foreground">Loading usage history…</p>}
          {empty && <p className="text-sm text-muted-foreground">No activity in this window.</p>}

          {fold && !empty && (
            <>
              {/* Hero: the headline figure and its per-provider split, beside
                  the chart. */}
              <section className="grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-4xl font-semibold tabular-nums">
                      {metric === "cost" ? formatUsd(fold.total.costUsd) : formatTokens(fold.total.processed)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fold.sessions} session{fold.sessions === 1 ? "" : "s"}
                      {metric === "cost" ? " · API estimate" : ""}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {fold.providers.map((provider) => (
                      <div key={provider.driver} className="flex items-center gap-2 text-sm">
                        <Dot driver={provider.driver} />
                        <span className="min-w-0 flex-1 truncate">{DRIVER_LABEL[provider.driver]}</span>
                        <span className="tabular-nums text-muted-foreground">{formatShare(provider.share)}</span>
                        {/* A partially-priced figure is a FLOOR and still worth
                            showing; the dash is only for "no cost known at all". */}
                        <span className="w-20 text-right tabular-nums">
                          {metric === "cost" ? (provider.costUsd > 0 ? formatUsd(provider.costUsd) : "—") : formatTokens(provider.processed)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {resolution === "hour" ? "Hourly" : "Daily"} {metric === "cost" ? "cost" : "processed tokens"}
                  </p>
                  <UsageChart series={chartSeries} labels={periodLabels} format={format} />
                </div>
              </section>

              {/* Totals — the four-way token split plus the turn count. */}
              <section>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Totals</p>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                  <Tile label="Processed tokens" value={formatTokens(fold.total.processed)} />
                  <Tile label="Uncached input" value={formatTokens(fold.total.tokens.input)} />
                  <Tile label="Cached input" value={formatTokens(fold.total.tokens.cacheRead)} />
                  <Tile label="Output" value={formatTokens(fold.total.tokens.output)} />
                  <Tile label="Requests" value={formatTokens(fold.total.turns)} />
                </div>
              </section>

              <Breakdown fold={fold} metric={metric} resolution={resolution} />

              {/* WHERE THE NUMBERS CAME FROM — a missing install must read as
                  "not scanned", never as "spent nothing". */}
              {report && (
                <p className="text-xs text-muted-foreground">
                  {report.sources
                    .map((source) =>
                      source.status === "ok"
                        ? `${DRIVER_LABEL[source.provider]}: ${source.sessions} session${source.sessions === 1 ? "" : "s"} scanned`
                        : `${DRIVER_LABEL[source.provider]}: no transcripts at ${source.path}`,
                    )
                    .join(" · ")}
                  {report.pricing === "unavailable" ? " · Rate table unreachable — unreported costs are not counted." : ""}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Breakdown({ fold, metric, resolution }: { fold: UsageFold; metric: Metric; resolution: "day" | "hour" }) {
  const [view, setView] = useState<"model" | "period">("model");
  const cell = "px-2 py-1.5";
  const num = cn(cell, "text-right tabular-nums");

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Breakdown</p>
        <Segmented<"model" | "period">
          value={view}
          onChange={setView}
          options={[
            { value: "model", label: "Model" },
            { value: "period", label: resolution === "hour" ? "Hour" : "Day" },
          ]}
        />
      </div>
      <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
        {view === "model" ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th className={cn(cell, "font-medium")}>Model</th>
                <th className={cn(num, "font-medium")}>Cost</th>
                <th className={cn(num, "font-medium")}>Share</th>
                <th className={cn(num, "font-medium")}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {fold.models.map((model) => (
                <tr key={`${model.driver}-${model.model}`} className="border-b border-border/40 last:border-0">
                  <td className={cell}>
                    <span className="flex items-center gap-2">
                      <Dot driver={model.driver} />
                      <span className="truncate font-mono text-xs">{model.model}</span>
                    </span>
                  </td>
                  <td className={num}>{model.costUsd > 0 ? formatUsd(model.costUsd) : "—"}</td>
                  <td className={num}>{formatShare(model.share)}</td>
                  <td className={num}>{formatTokens(model.processed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th className={cn(cell, "font-medium")}>{resolution === "hour" ? "Hour" : "Day"}</th>
                {fold.providers.map((provider) => (
                  <th key={provider.driver} className={cn(num, "font-medium")}>
                    {DRIVER_LABEL[provider.driver]}
                  </th>
                ))}
                <th className={cn(num, "font-medium")}>Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest first — the row you came to read is the top one. */}
              {fold.periods
                .filter((period) => period.total.turns > 0)
                .toReversed()
                .map((period) => (
                  <tr key={period.period} className="border-b border-border/40 last:border-0">
                    <td className={cell}>{formatPeriodShort(period.period, resolution)}</td>
                    {fold.providers.map((provider) => {
                      const slice = period.byDriver[provider.driver];
                      return (
                        <td key={provider.driver} className={num}>
                          {slice ? (metric === "cost" ? (slice.costUsd > 0 ? formatUsd(slice.costUsd) : "—") : formatTokens(slice.processed)) : ""}
                        </td>
                      );
                    })}
                    {/* A partially-priced total shows what WAS priced; a total
                        with no cost figure at all shows the dash, not $0.00. */}
                    <td className={num}>
                      {metric === "cost" ? (period.total.costUsd > 0 ? formatUsd(period.total.costUsd) : "—") : formatTokens(period.total.processed)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
