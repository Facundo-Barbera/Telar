import type { WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// THE state badge — one color language shared by looms, the dashboard, and
// project surfaces. preparing/running/verifying animate (work in flight);
// done reads as default/primary; ready success (verified, awaiting owner
// accept — a CTA, distinct from done/verifying); failed destructive;
// needs-review/charter-review warning; blocked ALSO warning (paused on a
// human, folded in per globals.css — amber/orange are indistinguishable at
// this lightness); queued outline; halted/skipped muted.
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
    dot: "bg-info",
    className: "border-info/30 bg-info/10 text-info",
    pulse: true,
  },
  "charter-review": {
    label: "charter review",
    dot: "bg-warning",
    className: "border-warning/40 bg-warning/10 text-warning",
    pulse: false,
  },
  preparing: {
    label: "preparing",
    dot: "bg-info",
    className: "border-info/30 bg-info/10 text-info",
    pulse: true,
  },
  running: {
    label: "running",
    dot: "bg-info",
    className: "border-info/30 bg-info/10 text-info",
    pulse: true,
  },
  verifying: {
    label: "verifying",
    dot: "bg-verify",
    className: "border-verify/30 bg-verify/10 text-verify",
    pulse: true,
  },
  ready: {
    label: "ready",
    dot: "bg-success",
    className: "border-success/40 bg-success/10 text-success",
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
    dot: "bg-warning",
    className: "border-warning/40 bg-warning/10 text-warning",
    pulse: false,
  },
  blocked: {
    label: "blocked",
    dot: "bg-warning",
    className: "border-warning/40 bg-warning/10 text-warning",
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
