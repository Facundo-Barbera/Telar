"use client";

// extra — A /context-style window breakdown, opened from the CTX pill.
// CURRENT: the heartbeat bar's CTX pill shows a bare token count (e.g.
// "CTX 58.2k") with no sense of what is filling the window or how close the
// session is to autocompaction. REDESIGN (mirrors Claude Code's /context):
// hovering the pill floats an anchored, zero-reflow overlay that segments the
// context window into its parts — system prompt, system tools, MCP tools,
// memory/CLAUDE.md, messages, thinking, and free space — with token counts,
// window-share percentages, total-used vs window size, and an autocompact
// marker showing how much room is left before compaction. Click pins it open.
//
// Interaction grammar is identical to the 1.6 cost hover in session-cost.tsx
// (same lane): absolutely-positioned overlay, hover to preview, click to pin.
//
// COLOR: segments are painted in `--foreground` at descending opacities, never
// hardcoded dark-tuned colors. Because the base hue is the theme's own
// foreground, every band re-themes with the panel — light-on-dark in the dark
// shell, dark-on-light in a ThemePair light island — so all seven read in both
// themes (the shimmer-washout lesson: derive from tokens that flip, never bake
// a fixed color). Free space is `--muted`, the empty-track token.

import { useState } from "react";
import { GaugeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DemoShell, Section, ThemePair } from "./_shared";

const WINDOW = 200_000; // total context window
const AUTOCOMPACT = 160_000; // compaction kicks in here (80% of the window)

type CtxCategory = {
  id: string;
  label: string;
  tokens: number;
  swatch: string; // token-derived, theme-flipping fill
};

// Plausible + summing exactly: the six categories total 58,200 tokens, which is
// the "58.2k" the bare pill shows today. Free space is derived, never authored.
const CATEGORIES: CtxCategory[] = [
  { id: "system", label: "System prompt", tokens: 3_100, swatch: "bg-foreground/90" },
  { id: "tools", label: "System tools", tokens: 12_400, swatch: "bg-foreground/70" },
  { id: "mcp", label: "MCP tools", tokens: 18_700, swatch: "bg-foreground/55" },
  { id: "memory", label: "Memory · CLAUDE.md", tokens: 6_500, swatch: "bg-foreground/40" },
  { id: "messages", label: "Messages", tokens: 14_200, swatch: "bg-foreground/80" },
  { id: "thinking", label: "Thinking", tokens: 3_300, swatch: "bg-foreground/25" },
];

const used = (c: CtxCategory[]) => c.reduce((s, x) => s + x.tokens, 0);
const pct = (tok: number) => (tok / WINDOW) * 100;
const fmtPct = (tok: number) => `${pct(tok).toFixed(1)}%`;

// The floating breakdown card. text-card-foreground is explicit (same reason as
// the cost card): un-classed rows otherwise inherit the dark shell's near-white
// `color`, which vanishes on a LIGHT panel — binding to the card token re-themes
// the text legibly in both directions.
export function ContextBreakdown({
  categories = CATEGORIES,
  className,
}: {
  categories?: CtxCategory[];
  className?: string;
}) {
  const usedTok = used(categories);
  const freeTok = WINDOW - usedTok;
  const untilCompact = Math.max(0, AUTOCOMPACT - usedTok);
  const compactPct = (AUTOCOMPACT / WINDOW) * 100;

  return (
    <div
      className={cn(
        "w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Context window
        </span>
        <span className="font-mono text-xs font-semibold">
          {fmtTokens(usedTok)}
          <span className="text-muted-foreground/70"> / {fmtTokens(WINDOW)}</span>
        </span>
      </div>

      {/* Segmented usage bar: used categories left-to-right, free-space track to
          the right, with an absolute autocompact marker overlaid on top. */}
      <div className="px-1.5">
        <div className="relative">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {categories.map((c) => (
              <div
                key={c.id}
                className={cn("h-full", c.swatch)}
                style={{ width: `${pct(c.tokens)}%` }}
                title={`${c.label} · ${fmtTokens(c.tokens)} (${fmtPct(c.tokens)})`}
              />
            ))}
          </div>
          {/* autocompact threshold — a thin marker line at its window position */}
          <div
            className="pointer-events-none absolute -top-0.5 h-3.5 w-px bg-destructive"
            style={{ left: `${compactPct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[9px] text-muted-foreground/70">
          <span>{fmtPct(usedTok)} used</span>
          <span
            className="font-mono text-destructive/80"
            style={{ marginRight: `${100 - compactPct}%` }}
          >
            ▲ autocompact {fmtTokens(AUTOCOMPACT)}
          </span>
        </div>
      </div>

      {/* Legend: one row per category, then the derived free-space row. */}
      <ul className="mt-2 space-y-0.5">
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50"
          >
            <span className={cn("size-2.5 shrink-0 rounded-sm", c.swatch)} />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="shrink-0 font-mono text-[11px]">{fmtTokens(c.tokens)}</span>
            <span className="w-10 shrink-0 text-right font-mono text-[9px] text-muted-foreground/60">
              {fmtPct(c.tokens)}
            </span>
          </li>
        ))}
        <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
          <span className="size-2.5 shrink-0 rounded-sm border border-border bg-muted" />
          <span className="min-w-0 flex-1 truncate">Free space</span>
          <span className="shrink-0 font-mono text-[11px]">{fmtTokens(freeTok)}</span>
          <span className="w-10 shrink-0 text-right font-mono text-[9px] text-muted-foreground/60">
            {fmtPct(freeTok)}
          </span>
        </li>
      </ul>

      <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono text-foreground">{fmtTokens(untilCompact)}</span> until
        autocompact · old pill showed a bare{" "}
        <span className="font-mono">{fmtTokens(usedTok)}</span> with none of this.
      </div>
    </div>
  );
}

// The CTX pill as it sits in the heartbeat bar. Breakdown opens on HOVER as an
// absolutely-positioned overlay anchored to the pill — out of flow, so the bar
// never reflows when it appears. Click pins it open (and unpins). Same grammar
// as the sibling cost pill so the two hovers live together in one bar.
export function ContextPill({ categories = CATEGORIES }: { categories?: CtxCategory[] }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const usedTok = used(categories);

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        className="self-start"
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
          CTX {fmtTokens(usedTok)}
        </Badge>
      </button>

      {/* absolute → zero layout reflow; anchored to the pill's left edge so the
          wide card doesn't shove past the bar's right side */}
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1.5">
          <ContextBreakdown categories={categories} />
        </div>
      )}
    </div>
  );
}

export function SessionContextDemo() {
  return (
    <DemoShell>
      <Section
        title="CTX pill → /context breakdown"
        note="Hover the CTX pill to float the window breakdown as an anchored, zero-reflow overlay (click to pin) — the same interaction the cost pill uses, so the two live together in the bar."
      >
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-1.5">
          <Badge variant="outline" className="gap-1.5 font-mono text-xs">
            anthropic · sonnet
          </Badge>
          <div className="ml-auto">
            <ContextPill />
          </div>
        </div>
      </Section>

      <Section
        title="The breakdown, pinned open"
        note="Segmented usage bar + legend: system prompt, system tools, MCP tools, memory/CLAUDE.md, messages, thinking — each with tokens and window-share — plus free space, total used vs 200k, and the autocompact marker with room remaining. Segments read in both themes because every band is --foreground at a distinct opacity, so it flips with the panel."
      >
        <ThemePair className="items-start">
          <ContextBreakdown />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
