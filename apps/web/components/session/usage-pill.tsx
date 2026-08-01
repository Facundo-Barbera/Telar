"use client";

import { Badge } from "@/components/ui/badge";
import type { PlanSnapshot } from "@/lib/store";
import { usedWindows } from "@/lib/plan-window";

// Threshold colouring shared with the sidebar meters: amber past 70%, red past
// 90% — so a nearly-exhausted window reads at a glance.
function pctClass(p: number | null | undefined): string {
  if (p == null) return "text-muted-foreground";
  if (p >= 90) return "text-destructive";
  if (p >= 70) return "text-amber-500";
  return "text-foreground";
}

const fmtReset = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString() : "—";

// Compact workspace-level view of the active account's limit windows. Renders
// one segment per window the provider ACTUALLY reports rather than a fixed
// 5h·wk pair: Claude reports both, and Codex has reported weekly alone since
// July 2026. A window that doesn't exist gets no segment — not a "—".
export function UsagePill({ snap }: { snap: PlanSnapshot | null }) {
  const rows = usedWindows(snap);
  if (!rows.length) return null;

  return (
    <Badge
      variant="outline"
      className="gap-1.5 font-mono text-xs"
      title={rows
        .map(
          (r) =>
            `${r.label} · ${r.window.utilization}% used, resets ${fmtReset(r.window.resets_at)}`,
        )
        .join("\n")}
    >
      {rows.map((r, i) => (
        <span key={r.key} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted-foreground/50">·</span>}
          <span>
            {r.short} <span className={pctClass(r.window.utilization)}>{r.window.utilization}%</span>
          </span>
        </span>
      ))}
    </Badge>
  );
}
