"use client";

import type { LucideIcon } from "lucide-react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  FlaskConical,
  Hammer,
  Loader2,
  RotateCcw,
} from "lucide-react";
import type { WorkUnitState } from "@telar/core";
import type { GodStatusKind } from "./godview";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The one place the weave cards and the agent-view drawer agree on how a
// status renders — so the two never drift. Color is a quiet state signal here,
// never a highlighter: only the icon (and, for a real failure, the label)
// carries a hue; the badge itself stays a neutral outline, matching the
// session view's calm register.

export type Tone = "done" | "attention" | "danger" | "active" | "muted";

// Spelled with the shared state tokens (--success / --warning), NOT raw ramps:
// components/session/ultra-anchor.tsx's ULTRA_TONE_CLASS declares itself a copy
// of this map, and the two are live on adjacent surfaces, so a ramp here is a
// two-palette bug there. The tokens carry their own dark-mode value, which is
// why the `dark:` fork this pairing used to need is gone.
export const TONE_ICON: Record<Tone, string> = {
  done: "text-success",
  attention: "text-warning",
  danger: "text-destructive",
  active: "text-foreground",
  muted: "text-muted-foreground",
};

export type StatusVisual = { Icon: LucideIcon; tone: Tone; spinning: boolean };

// god-status to a lucide icon + tone + spin. GodStatusKind alone is ambiguous for
// two kinds — "verify" is both live-verifying and verified-awaiting-you, and
// "block" is both a real parked question and couldn't-prove-it — so the finer
// WorkUnitState disambiguates. Active build/verify get a neutral spinner, never
// a saturated hue.
export function statusVisual(
  kind: GodStatusKind,
  state: WorkUnitState,
  active: boolean,
): StatusVisual {
  switch (kind) {
    case "done":
      return { Icon: CircleCheck, tone: "done", spinning: false };
    case "run":
      return { Icon: Hammer, tone: "active", spinning: active };
    case "verify":
      return state === "ready"
        ? { Icon: FlaskConical, tone: "done", spinning: false } // verified, awaiting you
        : { Icon: FlaskConical, tone: "active", spinning: active }; // panel driving now
    case "repair":
      return state === "failed" || state === "halted"
        ? { Icon: CircleX, tone: "danger", spinning: false } // terminal failure/halt
        : { Icon: RotateCcw, tone: "danger", spinning: active }; // live repair loop
    case "block":
      return state === "needs-review"
        ? { Icon: Eye, tone: "attention", spinning: false } // couldn't prove — review
        : { Icon: CircleAlert, tone: "attention", spinning: false }; // parked question
    case "wait":
    default:
      return { Icon: Clock, tone: "muted", spinning: false };
  }
}

export function StatusBadge({
  kind,
  state,
  active,
  label,
  className,
}: {
  kind: GodStatusKind;
  state: WorkUnitState;
  active: boolean;
  label: string;
  className?: string;
}) {
  const { Icon, tone, spinning } = statusVisual(kind, state, active);
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", className)}>
      {spinning ? (
        <Loader2 className={cn("animate-spin", TONE_ICON.active)} />
      ) : (
        <Icon className={TONE_ICON[tone]} />
      )}
      <span className={cn(tone === "danger" && "text-destructive")}>{label}</span>
    </Badge>
  );
}
