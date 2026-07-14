"use client";

// The session heartbeat bar's cost + context pills, each with an anchored,
// zero-reflow hover breakdown (hover previews, click pins) — same grammar as the
// 1.6 / /context demos (lib/demo-gallery/chat/session-cost.tsx + session-context
// .tsx). Adapted to REAL data (production-wiring recon, data-availability):
//   · Per-sub-agent cost DOES NOT EXIST — the transcript carries one running
//     aggregate. So the cost hover shows the real grand total plus a single
//     reserved "Main + all sub-agents" row, never fabricated per-agent splits.
//   · Context CATEGORY breakdown DOES NOT EXIST — only the latest-turn prompt
//     size. So the CTX hover shows the real used/window figures + the real
//     lifetime token split, with the per-category bars as a reserved slot.
// No transform on any ancestor of these absolute overlays; bg-card +
// text-card-foreground are explicit so the cards re-theme legibly.

import { useState } from "react";
import { GaugeIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtCost, fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

function usePinnableHover() {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  return {
    open: hovered || pinned,
    pinned,
    bind: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
    toggle: () => setPinned((v) => !v),
  };
}

export function CostPill({ total }: { total: number }) {
  const { open, pinned, bind, toggle } = usePinnableHover();

  return (
    <div className="relative inline-flex items-center leading-none" {...bind}>
      <button
        type="button"
        onClick={toggle}
        className="flex items-center"
        aria-expanded={open}
        title={pinned ? "Click to unpin" : "Hover to preview · click to pin"}
      >
        <Badge
          variant="outline"
          className={cn(
            "cursor-pointer gap-1.5 font-mono text-xs hover:bg-muted",
            pinned && "ring-1 ring-ring",
          )}
        >
          {fmtCost(total)}
        </Badge>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5">
          <div className="w-72 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
            <div className="mb-1.5 flex items-center justify-between px-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Cost breakdown
              </span>
              <span className="font-mono text-xs font-semibold">{fmtCost(total)}</span>
            </div>
            <ul className="space-y-0.5">
              <li className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs">
                <UserRoundIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Main + all sub-agents</span>
                <span className="shrink-0 font-mono text-[11px]">{fmtCost(total)}</span>
              </li>
            </ul>
            {/* The transcript carries one aggregate cost — per-sub-agent spend
                isn't attributed yet. Reserved for that split once instrumented. */}
            <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/70">
              per-sub-agent breakdown lands when spend is attributed
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContextPill({
  used,
  windowTokens,
  lifetime,
}: {
  used: number;
  windowTokens?: number;
  lifetime: { input: number; output: number; cacheRead: number; cacheCreate: number };
}) {
  const { open, pinned, bind, toggle } = usePinnableHover();
  const usedPct = windowTokens ? Math.min(100, (used / windowTokens) * 100) : null;

  return (
    <div className="relative inline-flex items-center leading-none" {...bind}>
      <button
        type="button"
        onClick={toggle}
        className="flex items-center"
        aria-expanded={open}
        title={pinned ? "Click to unpin" : "Hover to preview · click to pin"}
      >
        <Badge
          variant="outline"
          className={cn(
            "cursor-pointer gap-1.5 font-mono text-xs hover:bg-muted",
            pinned && "ring-1 ring-ring",
          )}
        >
          <GaugeIcon className="size-3 text-muted-foreground" />
          CTX {fmtTokens(used)}
        </Badge>
      </button>
      {open && (
        // Anchored left so the wide card doesn't shove past the bar's right edge.
        <div className="absolute left-0 top-full z-20 mt-1.5">
          <div className="w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
            <div className="mb-2 flex items-center justify-between px-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Context window
              </span>
              <span className="font-mono text-xs font-semibold">
                {fmtTokens(used)}
                {windowTokens ? (
                  <span className="text-muted-foreground/70"> / {fmtTokens(windowTokens)}</span>
                ) : null}
              </span>
            </div>

            {usedPct !== null && (
              <div className="px-1.5">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-foreground/80" style={{ width: `${Math.max(2, usedPct)}%` }} />
                </div>
                <div className="mt-1 text-[9px] text-muted-foreground/70">
                  {usedPct.toFixed(1)}% of the window used
                </div>
              </div>
            )}

            {/* Real lifetime token split (the aggregate the bar never showed). */}
            <ul className="mt-2 space-y-0.5">
              {[
                ["Input", lifetime.input],
                ["Output", lifetime.output],
                ["Cache read", lifetime.cacheRead],
                ["Cache write", lifetime.cacheCreate],
              ].map(([label, tok]) => (
                <li
                  key={label as string}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
                  <span className="shrink-0 font-mono text-[11px]">{fmtTokens(tok as number)}</span>
                </li>
              ))}
            </ul>

            {/* Per-category window breakdown (system/tools/MCP/messages/thinking)
                isn't instrumented yet — reserved for it once it lands. */}
            <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/70">
              per-category window breakdown lands when instrumented
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
