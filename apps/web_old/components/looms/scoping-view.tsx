"use client";

import { useState } from "react";
import { GitBranchIcon, LayersIcon, SparklesIcon } from "lucide-react";
import type { LoomEvent } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { eventsToTranscript } from "./godview";
import { ScriptEntry } from "./agent-view";
import { useSpecBundle } from "./spec-bundle";

// ---------------------------------------------------------------------------
// (B) Workstreams preview — a read-ahead of how the approved contract will
// decompose. Fetches the Spec Bundle and partitions the contract's assertions
// by subGoalId EXACTLY like planWeaveFromBundle (scoping.ts): a trimmed,
// non-"ALL" label mints a workstream; everything else is cross-cutting. Honest
// no-op when there is no contract (the raw-prompt path has nothing to preview).
// ---------------------------------------------------------------------------

export function WorkstreamsPreview({ loomId }: { loomId: string }) {
  const { bundle } = useSpecBundle(loomId, true);
  const assertions = bundle?.contract?.assertions ?? [];
  if (!bundle?.contract || assertions.length === 0) return null;

  const bySubGoal = new Map<string, number>();
  let crossCutting = 0;
  for (const a of assertions) {
    const key = a.subGoalId?.trim();
    if (!key || key === "ALL") {
      crossCutting++;
      continue;
    }
    bySubGoal.set(key, (bySubGoal.get(key) ?? 0) + 1);
  }

  const workstreams = [...bySubGoal.entries()];
  if (workstreams.length === 0 && crossCutting === 0) return null;

  return (
    <Card size="sm" className="border-l-2 border-l-primary/40">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-0">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          Planned workstreams
        </span>
        {workstreams.length > 0 && (
          <Badge variant="outline" className="ml-auto font-mono text-[10px]">
            {workstreams.length} thread{workstreams.length === 1 ? "" : "s"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {workstreams.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            The contract carries no per-workstream labels yet — the planner will
            decide the decomposition.
          </p>
        ) : (
          workstreams.map(([id, count]) => (
            <div
              key={id}
              className="flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 ring-1 ring-border"
            >
              <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-xs">{id}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {count} assertion{count === 1 ? "" : "s"}
              </span>
            </div>
          ))
        )}
        {crossCutting > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5">
            <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              cross-cutting
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {crossCutting} assertion{crossCutting === 1 ? "" : "s"} · every thread
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (D) Live scoping feed — the weave-planner's actual work, so a scoping loom
// shows progress instead of a bare spinner. Reuses the same event→transcript
// derivation and row renderer as the agent-view drawer, over the operator lane
// (no pieceId) of the root loom's feed. Grows as SSE events arrive; graceful
// empty state before the planner's first turn.
// ---------------------------------------------------------------------------

export function ScopingFeed({ events }: { events: LoomEvent[] }) {
  const entries = eventsToTranscript(events);
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({});

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        Planner activity
      </div>
      {entries.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground/70">
          Waiting for the planner to start…
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-1">
          {entries.map((e, i) => (
            <ScriptEntry
              key={i}
              e={e}
              open={!!openRows[i]}
              onToggle={() => setOpenRows((o) => ({ ...o, [i]: !o[i] }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
