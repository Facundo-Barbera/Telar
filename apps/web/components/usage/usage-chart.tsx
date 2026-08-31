"use client";

/**
 * The usage chart — one 2px line plus a 12%-opacity area per provider, every
 * series measured FROM THE SAME ZERO BASELINE (never stacked: stacking would
 * imply one provider always rides on the other). Hand-rolled SVG like the
 * t3 code original; the geometry lives in a `preserveAspectRatio="none"` box
 * and ALL TEXT LIVES OUTSIDE IT in ordinary HTML, so nothing distorts.
 *
 * Colors are chart-local custom properties, validated (dataviz six checks,
 * both modes) rather than eyeballed — see usage-page.tsx where they are
 * declared. Identity is never color-alone: the legend pairs each dot with its
 * label, and the page's breakdown table is the table view.
 */

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type ChartSeries = {
  key: string;
  label: string;
  /** CSS color — a `var(--…)` the page declared and validated. */
  color: string;
  values: number[];
};

const W = 960;
const H = 260;
const PAD_TOP = 8;

/** 1/2/5 × 10ⁿ ceiling — the peak must land on the scale, never be clipped. */
function niceMax(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10]) {
    if (peak <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

export function UsageChart({
  series,
  labels,
  format,
}: {
  series: ChartSeries[];
  /** One short label per index; first, middle and last are shown. */
  labels: string[];
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number>();
  const plotRef = useRef<HTMLDivElement>(null);

  const count = labels.length;
  const peak = Math.max(0, ...series.flatMap((entry) => entry.values));
  const max = niceMax(peak);
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => f * max);

  const x = (index: number): number => (count > 1 ? (index / (count - 1)) * W : W / 2);
  const y = (value: number): number => H - ((H - PAD_TOP) * value) / max;

  const paths = useMemo(
    () =>
      series.map((entry) => {
        const line = entry.values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
        const area = `${line}L${x(entry.values.length - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`;
        return { ...entry, line, area };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry depends only on these
    [series, count, max],
  );

  const onMove = (event: React.MouseEvent) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || count === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {/* Y labels beside the plot, not inside the distorting viewBox. */}
        <div className="relative w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${(y(tick) / H) * 100}%` }}>
              {format(tick)}
            </span>
          ))}
        </div>
        <div ref={plotRef} className="relative h-56 min-w-0 flex-1" onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full">
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={W} y1={y(tick)} y2={y(tick)} className="stroke-border/50" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {/* All fills first, then all strokes, so no area washes a line. */}
            {paths.map((entry) => (
              <path key={`${entry.key}-a`} d={entry.area} fill={entry.color} opacity={0.12} />
            ))}
            {paths.map((entry) => (
              <path key={entry.key} d={entry.line} fill="none" stroke={entry.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))}
            {hover !== undefined && (
              <line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={H} className="stroke-foreground/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {/* ≥8px hover markers, HTML so they stay round under the stretch. */}
          {hover !== undefined &&
            paths.map((entry) => (
              <span
                key={entry.key}
                className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
                style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(entry.values[hover] ?? 0) / H) * 100}%`, backgroundColor: entry.color }}
              />
            ))}
          {hover !== undefined && (
            <div
              className={cn(
                "pointer-events-none absolute z-10 min-w-32 -translate-y-full rounded-lg border border-border bg-popover p-2 text-xs shadow-md",
                hover > count / 2 ? "-translate-x-full" : "",
              )}
              style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(peak) / H) * 100}%` }}
            >
              <p className="mb-1 font-medium text-foreground">{labels[hover]}</p>
              {paths.map((entry) => (
                <p key={entry.key} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  <span className="flex-1">{entry.label}</span>
                  <span className="tabular-nums text-foreground">{format(entry.values[hover] ?? 0)}</span>
                </p>
              ))}
              <p className="mt-1 flex items-center gap-1.5 border-t border-border/60 pt-1 text-muted-foreground">
                <span className="flex-1">Total</span>
                <span className="tabular-nums text-foreground">{format(paths.reduce((sum, entry) => sum + (entry.values[hover ?? 0] ?? 0), 0))}</span>
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="ml-14 flex justify-between text-[10px] text-muted-foreground">
        <span>{labels[0]}</span>
        <span>{labels[Math.floor((count - 1) / 2)]}</span>
        <span>{labels[count - 1]}</span>
      </div>
      {/* The legend — identity by dot + label, never color alone. */}
      <div className="ml-14 flex items-center gap-4 text-xs text-muted-foreground">
        {series.map((entry) => (
          <span key={entry.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
