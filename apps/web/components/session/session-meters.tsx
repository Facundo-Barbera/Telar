"use client";

// The session heartbeat bar's cost + context pills, each with an anchored,
// zero-reflow hover breakdown (hover previews, click pins).
//
// POSITIONING (round-4): both cards float `position:fixed` with coordinates
// measured from the pill's getBoundingClientRect on open, recomputed on
// scroll/resize, CLAMPED into the viewport with an 8px margin, and flipped above
// the pill when there's no room below (see lib/use-anchored-overlay.ts). This
// fixes the live bug where the CTX card spilled past the right viewport edge and
// slid under the sub-agent rail. Opening a card never reflows the bar.
//
// CONTENT (Claude Code /context anatomy): a header row ("Context window" +
// "<used> / <window> (<pct>%)"), a slim segmented usage bar, then legend rows —
// each a colored swatch + label + right-aligned tokens + right-aligned percent.
//
// DATA HONESTY: Telar assembles the session itself, but per-category window
// attribution (system prompt / individual tool + MCP definitions / skills /
// memory files) is NOT reported by the SDK or tracked server-side, so those are
// NOT invented as separate rows. What IS real, client-side:
//   · used = the latest turn's prompt size (input + cache), SDK-reported.
//   · Messages (~) = a chars/4 estimate of the transcript actually sent, so it
//     is derived from a REAL source (tilde marks it an estimate). Clamped to
//     `used`. Omitted entirely when no transcript estimate is supplied.
//   · System + tools (~) = used − messages estimate: the real remainder of the
//     prompt (system prompt + tool/MCP defs + memory + cache overhead), shown as
//     ONE honest combined bucket rather than fabricated per-category splits.
//   · Free space = window − used, real and derived.
//   · The lifetime input/output/cache split lands as dash-percent informational
//     rows — they're cumulative totals, not current-window share, so "—" percent
//     is the honest value.
// No transform on any ancestor of these fixed overlays; bg-card + colors via
// class utilities so the cards re-theme legibly.

import { useState } from "react";
import { GaugeIcon, UserRoundIcon, WorkflowIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtCost, fmtTokens } from "@/lib/format";
import type { SpendReadout } from "@/lib/spend-readout";
import { useAnchoredOverlay } from "@/lib/use-anchored-overlay";
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

// ── shared legend row (same anatomy across both cards) ──────────────────────
function LegendRow({
  swatch,
  label,
  value,
  pct,
  muted,
}: {
  swatch?: string; // tailwind bg-* for the color square; omit for a plain row
  label: string;
  value: string; // right-aligned token/cost figure
  pct?: string | null; // right-aligned percent, or "—" for informational rows
  muted?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50",
        muted && "text-muted-foreground",
      )}
    >
      {swatch !== undefined ? (
        <span className={cn("size-2.5 shrink-0 rounded-sm", swatch)} />
      ) : (
        <span className="size-2.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px]">{value}</span>
      {pct !== undefined && (
        <span className="w-10 shrink-0 text-right font-mono text-[9px] text-muted-foreground/60">
          {pct ?? "—"}
        </span>
      )}
    </li>
  );
}

// Story 4.1 / AC6 — the pill renders a READOUT, not a bare USD number. The unit
// is decided by lib/spend-readout.ts from the session's provider, because the
// ledger record carries no UNIT SELECTOR (AD-18): every row holds a cost number
// AND token counts side by side, and nothing on it chooses between them. (Said
// precisely on purpose — the loose form, "the record carries no currency or
// unit", is contradicted by `UsageEntry.costUsd` and was corrected in
// schemas.ts and usage-ledger.ts by this same story.) This component only prints
// what the projection already decided. Before 4.1 it took `total: number`, and a
// Codex session was HIDDEN at the call site rather than shown in its own
// language — see spend-readout.ts's header for the measurement.
/** WHAT THE LEDGER CAN ACTUALLY ANSWER, and nothing beyond it. `UsageEntry`
 *  carries `ownerKind` — `"session"` or `"ultra"` — so "this session's own
 *  turns" and "each Ultra run this session launched" are genuinely attributable
 *  and the two sets are disjoint (`usage-ledger.ts`). What is NOT attributable
 *  is main-thread versus sub-agent: the SDK reports cost once per TURN, and a
 *  turn that spawned six sub-agents reports one figure for all seven. So this
 *  type has no `subagentUsd` field — inventing one would mean splitting a
 *  number the engine never split, which is the fabrication NOT SOURCED ⇒ NOT
 *  RENDERED exists to prevent. */
export type SpendBreakdown = {
  /** Total minus the Ultra runs below — this session's own turns, main thread
   *  and its sub-agents together. */
  sessionUsd: number;
  /** One row per Ultra run this session launched, newest first. */
  runs: readonly { runId: string; name: string; usd: number }[];
};

export function CostPill({
  readout,
  breakdown,
}: {
  readout: SpendReadout;
  breakdown?: SpendBreakdown;
}) {
  const { open, pinned, bind, toggle } = usePinnableHover();
  const { anchorRef, floatRef, style, ready } = useAnchoredOverlay<
    HTMLDivElement,
    HTMLDivElement
  >(open, "end");

  return (
    <div
      ref={anchorRef}
      className="relative inline-flex items-center leading-none"
      {...bind}
    >
      <button
        type="button"
        onClick={toggle}
        className="flex items-center"
        aria-expanded={open}
        title={pinned ? "Click to unpin" : `${readout.title} · hover to preview, click to pin`}
      >
        <Badge
          variant="outline"
          className={cn(
            "cursor-pointer gap-1.5 font-mono text-xs hover:bg-muted",
            pinned && "ring-1 ring-ring",
          )}
        >
          {readout.text}
        </Badge>
      </button>
      {open && (
        <div
          ref={floatRef}
          style={style}
          className={cn("z-50 transition-opacity", ready ? "opacity-100" : "opacity-0")}
        >
          <div className="w-72 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
            <div className="mb-1.5 flex items-center justify-between px-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {readout.unit === "tokens" ? "Token breakdown" : "Cost breakdown"}
              </span>
              <span className="font-mono text-xs font-semibold">{readout.text}</span>
            </div>
            {/* THE BREAKDOWN IS BY OWNER, because owner is what the ledger
                records. Absent breakdown (or a Codex session, which has no
                Ultra surface and no USD at all) falls back to the single total
                — the honest answer when there is nothing to decompose. */}
            {readout.unit === "usd" && breakdown ? (
              <ul className="space-y-0.5">
                <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                  <UserRoundIcon className="size-2.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">This session's turns</span>
                  <span className="shrink-0 font-mono text-[11px]">
                    {fmtCost(breakdown.sessionUsd)}
                  </span>
                </li>
                {breakdown.runs.map((r) => (
                  <li
                    key={r.runId}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <WorkflowIcon className="size-2.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{r.name}</span>
                    <span className="shrink-0 font-mono text-[11px]">{fmtCost(r.usd)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-0.5">
                <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                  <UserRoundIcon className="size-2.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Everything this session spent</span>
                  <span className="shrink-0 font-mono text-[11px]">{readout.text}</span>
                </li>
              </ul>
            )}
            {/* SAID PLAINLY, because the obvious next question is "which part of
                that was the sub-agents": the engine never answers it. Cost
                arrives once per turn, and a turn that spawned six sub-agents
                reports one figure for all seven — so the split does not exist to
                be shown, rather than existing and being withheld. */}
            <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/70">
              a turn&apos;s sub-agents bill with the turn — they have no separate figure
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
  messagesEst,
}: {
  used: number;
  windowTokens?: number;
  lifetime: { input: number; output: number; cacheRead: number; cacheCreate: number };
  // Tilde estimate (chars/4) of the transcript actually sent — a REAL source for
  // the Messages bucket. Omit to drop the per-bucket split entirely.
  messagesEst?: number;
}) {
  const { open, pinned, bind, toggle } = usePinnableHover();
  const { anchorRef, floatRef, style, ready } = useAnchoredOverlay<
    HTMLDivElement,
    HTMLDivElement
  >(open, "end");

  const usedPct = windowTokens ? Math.min(100, (used / windowTokens) * 100) : null;
  const freeTok = windowTokens ? Math.max(0, windowTokens - used) : null;
  const winPct = (tok: number) =>
    windowTokens ? `${((tok / windowTokens) * 100).toFixed(1)}%` : null;

  // Honest split of the used window: Messages (real estimate, clamped to used)
  // and the real remainder (system prompt + tool/MCP defs + memory + cache
  // overhead) as one combined bucket — never fabricated per-category rows.
  const messagesTok =
    messagesEst != null ? Math.max(0, Math.min(messagesEst, used)) : null;
  const systemTok = messagesTok != null ? Math.max(0, used - messagesTok) : null;

  return (
    <div
      ref={anchorRef}
      className="relative inline-flex items-center leading-none"
      {...bind}
    >
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
        <div
          ref={floatRef}
          style={style}
          className={cn("z-50 transition-opacity", ready ? "opacity-100" : "opacity-0")}
        >
          <div className="w-80 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
            {/* header: used / window (pct%) */}
            <div className="mb-2 flex items-center justify-between px-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Context window
              </span>
              <span className="font-mono text-xs font-semibold">
                {fmtTokens(used)}
                {windowTokens ? (
                  <span className="text-muted-foreground/70">
                    {" "}
                    / {fmtTokens(windowTokens)}
                    {usedPct !== null && ` (${usedPct.toFixed(0)}%)`}
                  </span>
                ) : null}
              </span>
            </div>

            {/* slim segmented usage bar: Messages · System+tools · free track */}
            {windowTokens && (
              <div className="px-1.5">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  {messagesTok != null ? (
                    <>
                      <div
                        className="h-full bg-foreground/80"
                        style={{ width: `${(messagesTok / windowTokens) * 100}%` }}
                      />
                      <div
                        className="h-full bg-foreground/45"
                        style={{ width: `${((systemTok ?? 0) / windowTokens) * 100}%` }}
                      />
                    </>
                  ) : (
                    <div
                      className="h-full bg-foreground/80"
                      style={{ width: `${Math.max(2, usedPct ?? 0)}%` }}
                    />
                  )}
                </div>
                {usedPct !== null && (
                  <div className="mt-1 text-[9px] text-muted-foreground/70">
                    {usedPct.toFixed(1)}% of the window used
                  </div>
                )}
              </div>
            )}

            {/* legend: real window buckets, then the derived free-space row */}
            <ul className="mt-2 space-y-0.5">
              {messagesTok != null && (
                <LegendRow
                  swatch="bg-foreground/80"
                  label="Messages ~"
                  value={fmtTokens(messagesTok)}
                  pct={winPct(messagesTok)}
                />
              )}
              {systemTok != null && (
                <LegendRow
                  swatch="bg-foreground/45"
                  label="System + tools ~"
                  value={fmtTokens(systemTok)}
                  pct={winPct(systemTok)}
                />
              )}
              {messagesTok == null && (
                <LegendRow
                  swatch="bg-foreground/80"
                  label="In use"
                  value={fmtTokens(used)}
                  pct={winPct(used)}
                />
              )}
              {freeTok != null && (
                <LegendRow
                  swatch="border border-border bg-muted"
                  label="Free space"
                  value={fmtTokens(freeTok)}
                  pct={winPct(freeTok)}
                  muted
                />
              )}
            </ul>

            {/* dash-percent informational rows: lifetime totals, not window
                share — so the percent column is honestly "—". */}
            <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
              {([
                ["Input", lifetime.input],
                ["Output", lifetime.output],
                ["Cache read", lifetime.cacheRead],
                ["Cache write", lifetime.cacheCreate],
              ] as const).map(([label, tok]) => (
                <LegendRow key={label} label={`${label} · lifetime`} value={fmtTokens(tok)} pct={null} muted />
              ))}
            </ul>

            <div className="mt-1.5 border-t border-border px-1.5 pt-1.5 text-[10px] text-muted-foreground/70">
              per-category window attribution lands when the SDK reports it
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
