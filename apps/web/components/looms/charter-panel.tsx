"use client";

import { useState } from "react";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import type { Charter } from "@telar/core";
import { isWoven } from "@/components/looms/utils";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fmtCost } from "@/lib/format";

// A charter's `Why this decomposition` rationale, closed by default so a long
// LLM-authored paragraph doesn't dominate the panel — same collapsible idiom
// AttemptCard's GateRow uses for gate output.
function RationaleCollapsible({ rationale }: { rationale: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span>Why this decomposition</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="max-w-[70ch] pt-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          {rationale}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PathChips({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
        {label}
      </span>
      {paths.map((p) => (
        <Badge key={p} variant="outline" className="max-w-[220px] font-mono text-[10px]">
          <span className="truncate">{p}</span>
        </Badge>
      ))}
    </div>
  );
}

export function CharterPanel({
  charter,
  className,
}: {
  charter?: Charter;
  className?: string;
}) {
  const [open, setOpen] = useState(true);

  if (!charter) {
    return (
      <Card className={cn("border-l-2 border-l-primary/40", className)}>
        <CardContent className="flex items-center gap-2">
          <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            Charter
          </span>
          <span className="text-sm text-muted-foreground">
            No charter recorded for this loom.
          </span>
        </CardContent>
      </Card>
    );
  }

  const { budget, scope } = charter;

  return (
    <Card className={cn("border-l-2 border-l-primary/40", className)}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-(--card-spacing) py-(--card-spacing) text-left transition-colors hover:bg-muted/30">
          <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            Charter
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {charter.approvedBy ?? "not yet approved"}
          </span>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            v{charter.version}
          </Badge>
          <ChevronRightIcon
            className={cn(
              "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3 pt-0">
            <p className="max-w-[70ch] text-sm leading-relaxed">{charter.objective}</p>

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {charter.proofStrategy}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {isWoven(charter) ? "woven" : "single"}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-mono text-[10px]">
                {budget.maxCostUsd !== undefined
                  ? `≤ ${fmtCost(budget.maxCostUsd)}`
                  : "≤ no cap"}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {budget.maxWallClockHours !== undefined
                  ? `≤ ${budget.maxWallClockHours}h`
                  : "no cap"}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                ≤ {budget.maxParallelThreads} threads
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                ≤ {budget.maxAgents} agents
              </Badge>
            </div>

            {(scope.allowedPaths.length > 0 ||
              scope.forbiddenPaths.length > 0 ||
              scope.notes) && (
              <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
                <PathChips label="allowed" paths={scope.allowedPaths} />
                <PathChips label="forbidden" paths={scope.forbiddenPaths} />
                {scope.notes && (
                  <p className="text-xs text-muted-foreground">{scope.notes}</p>
                )}
              </div>
            )}

            {charter.rationale && (
              <RationaleCollapsible rationale={charter.rationale} />
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
