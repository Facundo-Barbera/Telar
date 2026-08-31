"use client";

/**
 * USAGE — what this engine's sessions spent, over time.
 *
 * t3 code's usage page on Telar's own data: hero figure + per-provider rail
 * beside the chart, a totals row, and a Model/Period breakdown that doubles
 * as the chart's table view. One deliberate difference from the donor: the
 * data comes from the ENGINE'S JOURNALS (one read, already normalized), not
 * from scanning provider transcript directories — and cost is only ever the
 * provider's own figure. Claude reports one per turn; Codex reports none, so
 * Codex cost renders as "—", never as a lying $0.00, and shares are of
 * processed tokens for the same reason.
 *
 * The two series colors are chart-local custom properties validated with the
 * dataviz six-check palette validator against both surfaces (light `#436ed1`
 * / `#a84d95` on white, dark `#6990e2` / `#ca549d` on `#161616`; worst-pair
 * CVD ΔE 10.0 light / 10.8 dark). They deliberately do NOT reuse
 * `--chart-1/2`: the dark steps of those tokens sit above the validated
 * lightness band on this surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCwIcon } from "lucide-react";
import type { UsageReport } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Segmented } from "@/components/settings/settings-shell";
import { UsageChart, type ChartSeries } from "@/components/usage/usage-chart";
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

const SERIES_COLOR: Record<string, string> = { claude: "var(--usage-claude)", codex: "var(--usage-codex)" };

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
  const [report, setReport] = useState<UsageReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const window = WINDOWS.find((entry) => entry.key === windowKey)!;
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
      setReport(usage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine did not answer.");
    } finally {
      setLoading(false);
    }
  }, [windowKey]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const fold: UsageFold | undefined = useMemo(() => (report ? foldUsage(report) : undefined), [report]);
  const resolution = report?.resolution ?? "day";

  // The cost chart draws only providers that actually price their turns; a
  // flat zero line for Codex would read as "ran and cost nothing".
  const chartSeries: ChartSeries[] = useMemo(() => {
    if (!fold) return [];
    return fold.providers
      .filter((provider) => metric === "tokens" || provider.priced)
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
    <div className="usage-viz flex h-full min-h-0 flex-col">
      {/* Chart-local series colors, both modes — see the header comment. */}
      <style>{`.usage-viz{--usage-claude:#436ed1;--usage-codex:#a84d95}.dark .usage-viz{--usage-claude:#6990e2;--usage-codex:#ca549d}`}</style>
      <PageHeader
        title="Usage"
        description={error ?? (unpricedProvider && metric === "cost" ? `${DRIVER_LABEL[unpricedProvider.driver]} reports no cost figures.` : undefined)}
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
            <Segmented<WindowKey> value={windowKey} onChange={setWindowKey} options={WINDOWS.map(({ key, label }) => ({ value: key, label }))} />
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <RotateCwIcon />}
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-5">
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
                        <span className="w-20 text-right tabular-nums">
                          {metric === "cost" ? (provider.priced ? formatUsd(provider.costUsd) : "—") : formatTokens(provider.processed)}
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
                  <Tile label="Turns" value={String(fold.total.turns)} />
                </div>
              </section>

              <Breakdown fold={fold} metric={metric} resolution={resolution} />
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
                  <td className={num}>{model.priced ? formatUsd(model.costUsd) : "—"}</td>
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
                          {slice
                            ? metric === "cost"
                              ? slice.priced
                                ? formatUsd(slice.costUsd)
                                : "—"
                              : formatTokens(slice.processed)
                            : ""}
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
