import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// THE state badge — one color language shared by looms, the dashboard, and
// project surfaces. preparing/running/verifying animate (work in flight);
// done reads as default/primary; ready emerald (verified, awaiting owner
// accept — a CTA, distinct from done/verifying); failed destructive;
// needs-review amber; blocked orange (paused on a human, distinct from
// needs-review); queued outline; halted/skipped muted.
const STYLES: Record<
  WorkUnitState,
  { label: string; dot: string; className: string; pulse: boolean }
> = {
  queued: {
    label: "queued",
    dot: "bg-muted-foreground/50",
    className: "border-border bg-transparent text-muted-foreground",
    pulse: false,
  },
  scoping: {
    label: "scoping",
    dot: "bg-sky-400",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    pulse: true,
  },
  "charter-review": {
    label: "charter review",
    dot: "bg-amber-400",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    pulse: false,
  },
  preparing: {
    label: "preparing",
    dot: "bg-sky-400",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    pulse: true,
  },
  running: {
    label: "running",
    dot: "bg-sky-400",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    pulse: true,
  },
  verifying: {
    label: "verifying",
    dot: "bg-violet-400",
    className: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    pulse: true,
  },
  ready: {
    label: "ready",
    dot: "bg-emerald-400",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    pulse: false,
  },
  done: {
    label: "done",
    dot: "bg-primary-foreground/70",
    className: "border-transparent bg-primary text-primary-foreground",
    pulse: false,
  },
  "needs-review": {
    label: "needs review",
    dot: "bg-amber-400",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    pulse: false,
  },
  blocked: {
    label: "blocked",
    dot: "bg-orange-400",
    className: "border-orange-500/40 bg-orange-500/10 text-orange-300",
    pulse: false,
  },
  failed: {
    label: "failed",
    dot: "bg-destructive",
    className: "border-transparent bg-destructive/10 text-destructive",
    pulse: false,
  },
  halted: {
    label: "halted",
    dot: "bg-muted-foreground/50",
    className: "border-border bg-muted text-muted-foreground",
    pulse: false,
  },
  skipped: {
    label: "skipped",
    dot: "bg-muted-foreground/40",
    className: "border-border bg-muted text-muted-foreground",
    pulse: false,
  },
};

export function StateBadge({
  state,
  className,
}: {
  state: WorkUnitState;
  className?: string;
}) {
  const s = STYLES[state];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", s.className, className)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          s.dot,
          s.pulse && "animate-pulse",
        )}
      />
      {s.label}
    </Badge>
  );
}
