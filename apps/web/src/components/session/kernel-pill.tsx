"use client";

import type { KernelState } from "@/lib/ds";
import { cn } from "@/lib/utils";

/** On the theme's own state tokens: `--success` for a live kernel, `--warning`
 *  while it moves, `--destructive` when it died. See globals.css. */
const TONE: Record<KernelState, string> = {
  none: "bg-muted text-muted-foreground",
  starting: "bg-warning/15 text-warning",
  idle: "bg-success/15 text-success",
  busy: "bg-primary/15 text-primary",
  restarting: "bg-warning/15 text-warning",
  dead: "bg-destructive/15 text-destructive",
};

export function KernelPill({ state }: { state: KernelState }) {
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-4xs font-medium uppercase tracking-wide", TONE[state])} title={`kernel ${state}`}>
      {state === "none" ? "no kernel" : state}
    </span>
  );
}
