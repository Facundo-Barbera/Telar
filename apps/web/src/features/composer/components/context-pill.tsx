"use client";

import { useState } from "react";
import { Minimize2Icon } from "lucide-react";
import type { ProviderDriverKind, UsageSnapshot } from "@telar/engine-client";
import { fmtTokens } from "@/ui/format";
import { PROVIDER_LABEL } from "@/features/providers";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Button } from "@/ui/button";

function compactTokens(value: number): string {
  return fmtTokens(value).replace(/\.0(?=[kM]$)/, "");
}

const RING_RADIUS = 11;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** How full the context is. An unknown figure shows a dash rather than disappearing or reading 0%. */
export function ContextPill({
  usage,
  driver,
  onCompact,
  compactDisabled,
  compactReason,
}: {
  usage?: UsageSnapshot;
  driver?: ProviderDriverKind;
  /** Adds a Compact button; the caller decides which provider gets one. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  compactReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  const unknown = used === undefined;
  const usedPct = used === undefined || max === undefined || max <= 0 ? null : Math.min(100, Math.max(0, (used / max) * 100));
  const critical = usedPct !== null && usedPct > 90;

  const readout = unknown
    ? max
      ? `— / ${compactTokens(max)}`
      : "—"
    : usedPct === null
      ? compactTokens(used)
      : `${usedPct.toFixed(1)}% · ${compactTokens(used)}/${compactTokens(max!)}`;
  const harness = driver ? PROVIDER_LABEL[driver] : "The harness";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="relative flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={`Context window${unknown ? ", size not reported" : usedPct === null ? "" : ` ${usedPct.toFixed(1)}% used`}`}
            title="Context window"
          />
        }
      >
        <svg className="absolute inset-0 size-8 -rotate-90" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-border" />
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - (usedPct ?? 0) / 100)}
            className={critical ? "text-destructive" : "text-primary"}
          />
        </svg>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-auto gap-0 bg-transparent p-0 shadow-none ring-0">
        <div className="w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-3">
          <div className="flex items-center justify-between gap-4">
            <span className="whitespace-nowrap text-sm font-medium">Context Window</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{readout}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-muted-foreground/70 transition-[width] duration-300" style={{ width: `${usedPct ?? 0}%` }} />
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total processed</span>
            <span className="font-mono font-medium">{unknown ? "—" : compactTokens(used)}</span>
          </div>
          {unknown && <p className="mt-3 max-w-56 text-sm leading-snug text-muted-foreground">{harness} does not report context size yet.</p>}
          <p className="mt-5 max-w-56 text-sm leading-snug text-muted-foreground">{harness} compacts automatically when needed.</p>
          {onCompact && (
            <button
              type="button"
              disabled={compactDisabled}
              title={compactDisabled ? compactReason : "Summarise the conversation to free space"}
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Minimize2Icon className="size-3.5" />
              Compact now
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function BackgroundPresence({ count, onStop, onView }: { count: number; onStop: () => void; onView?: () => void }) {
  if (count === 0) return null;
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border bg-card/60 px-2.5 py-1.5">
      <span className="flex items-center gap-2 text-2xs font-medium text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        {count} {count === 1 ? "task" : "tasks"} still working
      </span>
      <span className="flex items-center gap-1.5">
        {onView && (
          <Button type="button" size="xs" variant="outline" onClick={onView} title="Show running tasks in Processes" aria-label="Show running tasks in Processes">
            View
          </Button>
        )}
        <Button type="button" size="xs" variant="outline" onClick={onStop}>
          Stop
        </Button>
      </span>
    </div>
  );
}
