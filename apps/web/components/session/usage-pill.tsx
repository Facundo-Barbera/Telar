"use client";

import { Badge } from "@/components/ui/badge";
import type { PlanSnapshot } from "@/lib/store";

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

// Compact workspace-level view of the active account's 5-hour and weekly limits.
// Same fiveHour/sevenDay model for Claude and Codex, so this renders both.
export function UsagePill({ snap }: { snap: PlanSnapshot | null }) {
  if (!snap || (!snap.fiveHour && !snap.sevenDay)) return null;
  const five = snap.fiveHour?.utilization ?? null;
  const week = snap.sevenDay?.utilization ?? null;

  return (
    <Badge
      variant="outline"
      className="gap-1.5 font-mono text-xs"
      title={`5h · ${five ?? "—"}% used, resets ${fmtReset(snap.fiveHour?.resets_at)}\nweekly · ${week ?? "—"}% used, resets ${fmtReset(snap.sevenDay?.resets_at)}`}
    >
      {five != null && (
        <span>
          5h <span className={pctClass(five)}>{five}%</span>
        </span>
      )}
      {five != null && week != null && <span className="text-muted-foreground/50">·</span>}
      {week != null && (
        <span>
          wk <span className={pctClass(week)}>{week}%</span>
        </span>
      )}
    </Badge>
  );
}
