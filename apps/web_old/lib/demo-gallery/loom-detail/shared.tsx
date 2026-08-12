// LANE: loom-detail (UX brainstorm 2026-07-23) — shared chrome for the three
// navigation proposals. Same tone law as everywhere: hue on icons only,
// neutral outlines, spinners for active work. The shell is a detail page
// (breadcrumb, meta), NOT the app frame — the debate is inside the page.
import {
  CircleCheckIcon,
  ClockIcon,
  FlaskConicalIcon,
  HammerIcon,
  Loader2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Actor, AssertState, NodeState } from "./fixtures";

export const NODE_VISUAL: Record<
  NodeState,
  { Icon: LucideIcon; icon: string; spin?: boolean; label: string }
> = {
  done: {
    Icon: CircleCheckIcon,
    icon: "text-emerald-600 dark:text-emerald-400",
    label: "done",
  },
  build: { Icon: HammerIcon, icon: "text-foreground", spin: true, label: "building" },
  verify: { Icon: FlaskConicalIcon, icon: "text-foreground", spin: true, label: "verifying" },
  wait: { Icon: ClockIcon, icon: "text-muted-foreground/60", label: "waiting" },
};

export const ASSERT_VISUAL: Record<
  AssertState,
  { Icon: LucideIcon; icon: string; spin?: boolean }
> = {
  pass: { Icon: CircleCheckIcon, icon: "text-emerald-600 dark:text-emerald-400" },
  running: { Icon: FlaskConicalIcon, icon: "text-foreground", spin: true },
  pending: { Icon: ClockIcon, icon: "text-muted-foreground/50" },
};

export function StateIcon({
  visual,
  className,
}: {
  visual: { Icon: LucideIcon; icon: string; spin?: boolean };
  className?: string;
}) {
  return visual.spin ? (
    <Loader2Icon className={cn("animate-spin text-foreground", className)} />
  ) : (
    <visual.Icon className={cn(visual.icon, className)} />
  );
}

// Actor tags for the timeline / ledgers — mono, no hue: WHO did something is
// provenance, not state.
export function ActorTag({ actor }: { actor: Actor }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1 py-0.5 font-mono text-[9px]",
        actor === "you"
          ? "border-foreground/30 text-foreground"
          : "border-border/60 text-muted-foreground/70",
      )}
    >
      {actor}
    </span>
  );
}

