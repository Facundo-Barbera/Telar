"use client";

/**
 * A SUB-HEADING INSIDE A SETTINGS GROUP — what `PanelHeader` was, minus the
 * panel.
 *
 * WHY IT EXISTS AT ALL. The appearance pane is stacked `SettingsGroup` cards
 * now (#399), like every other settings pane, and a card inside a card is the
 * one shape the group grammar cannot absorb — so the studio's tools lost their
 * `Panel` wrappers. Most of what those wrappers carried was the card itself and
 * went with it. What did NOT go is the one line of information their headers
 * were actually for: the Colour group holds a palette AND a library, and the
 * palette header is what NAMES the palette ("Palette · light · Ember") rather
 * than leaving sixteen anonymous colour rows.
 *
 * So this is that line, at the same weight `PanelHeader` drew it — the
 * machine's mono-uppercase register — sitting as an ordinary child of the
 * group's card. The group's own caption is the human sentence above the card;
 * this is a label WITHIN it, which is why the two do not compete.
 *
 * `tone="attention"` is the one state a strip reports: the half in front of you
 * matches no saved theme, which is the whole signal for "this is new work".
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function GroupStrip({
  label,
  count,
  tone = "none",
  actions,
}: {
  label: string;
  /** Rendered even at 0 — an empty library is information. Omit where a count
   *  would be meaningless rather than zero. */
  count?: number;
  tone?: "none" | "attention";
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 py-2 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
      <span className={cn("min-w-0 truncate", tone === "attention" && "text-warning")}>{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  );
}
