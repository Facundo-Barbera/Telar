"use client";

// A deliberately provider-neutral context readout. Claude and Codex expose
// different levels of accounting detail, but the workspace only needs one
// stable operational answer: how full is this conversation's context window?
// Rich provider snapshots remain persisted for correctness and future use;
// this surface intentionally does not turn them into harness-specific UI.

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fmtTokens } from "@/lib/format";

function harnessName(provider?: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "The harness";
}

function compactTokens(value: number): string {
  return fmtTokens(value).replace(/\.0(?=[km]$)/, "");
}

export function ContextPill({
  used,
  windowTokens,
  provider,
  unknown = false,
  onCompact,
  compacting = false,
  compactDisabled = false,
}: {
  used: number;
  windowTokens?: number;
  provider?: string;
  /** The context was just compacted and the harness reported no new size, so
   *  every number we hold describes a context that no longer exists (issue
   *  #25 — Codex's `compact_end` carries no token counts). SAYING SO IS THE
   *  POINT: the alternative is a stale percentage that reads as current, and
   *  a guess would be worse than either. Cleared by the next turn, which
   *  measures for real. */
  unknown?: boolean;
  /** Absent ⇒ no Compact action. The pill stays a pure readout wherever a
   *  caller has nothing to offer (the demo gallery, a read-only surface). */
  onCompact?: () => void;
  compacting?: boolean;
  /** A turn is in flight — compaction is refused server-side while one runs,
   *  so the control says so rather than offering a request that would fail. */
  compactDisabled?: boolean;
}) {
  const usedPct = unknown
    ? null
    : windowTokens
      ? Math.min(100, Math.max(0, (used / windowTokens) * 100))
      : null;
  const readout = unknown
    ? windowTokens
      ? `— / ${compactTokens(windowTokens)}`
      : "—"
    : windowTokens
      ? `${usedPct?.toFixed(1)}% · ${compactTokens(used)}/${compactTokens(windowTokens)}`
      : compactTokens(used);

  return (
    <Popover>
      <PopoverTrigger
        render={(props) => (
          <button
            type="button"
            {...props}
            className="relative flex size-8 items-center justify-center rounded-full text-[9px] font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={`Context window${
              unknown
                ? ", size unknown since the last compaction"
                : usedPct === null
                  ? ""
                  : ` ${usedPct.toFixed(1)}% used`
            }`}
            title="View context window"
          >
            <svg className="absolute inset-0 size-8 -rotate-90" viewBox="0 0 32 32" aria-hidden>
              <circle
                cx="16"
                cy="16"
                r="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="text-border"
              />
              <circle
                cx="16"
                cy="16"
                r="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 11}
                strokeDashoffset={(2 * Math.PI * 11) * (1 - (usedPct ?? 0) / 100)}
                className="text-primary"
              />
            </svg>
            <span>
              {unknown
                ? "—"
                : usedPct === null
                  ? used >= 1000
                    ? `${Math.round(used / 1000)}k`
                    : used
                  : `${Math.round(usedPct)}%`}
            </span>
          </button>
        )}
      />
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-auto gap-0 bg-transparent p-0 shadow-none ring-0"
      >
        <div className="w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-lg">
          <div className="flex items-center justify-between gap-4">
            <span className="whitespace-nowrap text-sm font-medium">Context Window</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {readout}
            </span>
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-muted-foreground/70 transition-[width] duration-300"
              style={{ width: `${usedPct ?? 0}%` }}
            />
          </div>

          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total processed</span>
            <span className="font-mono font-medium">
              {unknown ? "—" : compactTokens(used)}
            </span>
          </div>

          {unknown && (
            <p className="mt-3 max-w-56 text-sm leading-snug text-muted-foreground">
              Compacted — {harnessName(provider)} did not report the new size.
              The next turn will measure it.
            </p>
          )}

          <p className="mt-5 max-w-56 text-sm leading-snug text-muted-foreground">
            {harnessName(provider)} automatically compacts its context when needed.
          </p>

          {/* COMPACT LIVES HERE, not loose in the composer row. It used to be a
              bare icon button beside the send control, where it had no context:
              a fold glyph among model and mode pickers, next to a percentage
              that never explained what it had to do with it.
              This popover is already about the context window and already ends
              with the sentence about compaction — so the manual action belongs
              directly under the automatic one it overrides. The reading is now
              "here is how full it is, here is what happens on its own, here is
              how to do it now", which is one thought instead of three. */}
          {onCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={compacting || compactDisabled}
              className="mt-3 w-full rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
            >
              {compacting ? "Compacting…" : "Compact now"}
            </button>
          )}
          {onCompact && compactDisabled && !compacting && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Available once the current turn finishes.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
