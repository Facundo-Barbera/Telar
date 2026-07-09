"use client";

import Link from "next/link";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import type { Loom, SubGoal, WorkUnitState } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StateBadge } from "@/components/common/state-badge";
import { fmtCost } from "@/lib/format";
import { sumCost } from "./utils";

// The SAME 5-color vocabulary StateBadge owns (sky=running/preparing,
// violet=verifying, primary=done, amber=needs-review, destructive=failed,
// muted=everything else) — kept as a thin local variant, not a new palette,
// so the thread rail and the StateBadge dot never drift apart.
function railClass(state: WorkUnitState): string {
  switch (state) {
    case "preparing":
    case "running":
      return "bg-sky-400";
    case "verifying":
      return "bg-violet-400";
    case "done":
      return "bg-primary";
    case "needs-review":
      return "bg-amber-400";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function dependsMissing(sg: SubGoal, childBySubGoal: Map<string, Loom>): string[] {
  return sg.dependsOn.filter((dep) => childBySubGoal.get(dep)?.state !== "done");
}

function ThreadRow({
  subGoal,
  child,
  childBySubGoal,
}: {
  subGoal: SubGoal;
  child: Loom | undefined;
  childBySubGoal: Map<string, Loom>;
}) {
  const missingDeps = dependsMissing(subGoal, childBySubGoal);
  const blocked = missingDeps.length > 0;
  const hasDeps = subGoal.dependsOn.length > 0;
  const latestAttempt = child?.attempts[child.attempts.length - 1];
  const report = latestAttempt?.verifierReport;
  const showError =
    child?.error && (child.state === "failed" || child.state === "needs-review");

  const row = (
    <Card size="sm" className="relative overflow-hidden">
      <span
        className={cn(
          "absolute top-0 bottom-0 left-0 w-[3px]",
          railClass(child?.state ?? "queued"),
        )}
      />
      <CardContent className="flex flex-col gap-2 pl-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-heading text-sm font-medium">{subGoal.title}</span>
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {subGoal.id}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {child ? (
              <StateBadge state={child.state} />
            ) : (
              <Badge
                variant="outline"
                className="max-w-[220px] font-mono text-[10px] text-muted-foreground"
              >
                <span className="truncate">
                  {blocked ? `blocked on ${missingDeps.join(", ")}` : "ready — not yet scheduled"}
                </span>
              </Badge>
            )}
            {child && (
              <Link
                href={`/looms/${child.id}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`Open thread ${subGoal.id}`}
              >
                <ArrowRightIcon className="size-3.5" />
              </Link>
            )}
          </div>
        </div>

        {report && (
          <div className="flex items-start gap-2 text-xs">
            <Badge
              className={cn(
                "shrink-0 font-mono text-[10px]",
                report.ok
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {report.ok ? "pass" : "fail"}
            </Badge>
            {report.summary && (
              <span className="min-w-0 truncate text-muted-foreground">
                {report.summary}
              </span>
            )}
          </div>
        )}

        {child && (
          <div className="font-mono text-xs text-muted-foreground">
            {fmtCost(sumCost(child.attempts))}
          </div>
        )}

        {showError && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              child!.state === "failed"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300",
            )}
          >
            <TriangleAlertIcon className="mt-px size-4 shrink-0" />
            <span className="leading-snug">{child!.error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!hasDeps) return row;

  return (
    <div className="ml-6 rounded-bl-md border-b border-l border-muted-foreground/20 py-2 pl-3">
      {row}
      {blocked && (
        <p className="mt-1.5 pl-1 text-[11px] text-muted-foreground">
          waits on {missingDeps.join(", ")}
        </p>
      )}
    </div>
  );
}

// Joins the Charter's decomposition (source of truth for ordering, titles,
// dependsOn) against the epic's spawned child Looms by subGoalId. Documented
// assumption: authors declare dependencies before dependents in
// `decomposition` — a true topological sort is out of scope.
//
// A child's subGoalId can outlive the decomposition entry it was spawned
// from (the Charter is versioned and a subGoal may be edited/removed after
// the child was already running under an older revision). Rather than let
// that child silently vanish from the list while still counting toward
// "threads in flight", synthesize a minimal stand-in SubGoal for it so it
// still gets a row.
export function ThreadTree({
  decomposition,
  children,
  epicId,
}: {
  decomposition: SubGoal[];
  children: Loom[];
  epicId: string;
}) {
  void epicId; // not needed for row links (each links to its own child.id) — kept for signature parity

  const childBySubGoal = new Map<string, Loom>();
  for (const c of children) {
    if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
  }

  const knownIds = new Set(decomposition.map((sg) => sg.id));
  const orphanRows: SubGoal[] = children
    .filter((c) => c.subGoalId && !knownIds.has(c.subGoalId))
    .map(
      (c): SubGoal => ({
        id: c.subGoalId!,
        title: c.title,
        detail: "spawned under a prior charter revision — no longer in the current decomposition",
        proofStrategy: "custom",
        acceptanceCriteria: [],
        dependsOn: [],
        required: false,
        status: "active",
      }),
    );

  return (
    <div className="flex flex-col gap-2">
      {[...decomposition, ...orphanRows].map((sg) => (
        <ThreadRow
          key={sg.id}
          subGoal={sg}
          child={childBySubGoal.get(sg.id)}
          childBySubGoal={childBySubGoal}
        />
      ))}
    </div>
  );
}
