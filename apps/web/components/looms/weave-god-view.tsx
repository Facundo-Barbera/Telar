"use client";

import { useEffect, useState } from "react";
import { WorkflowIcon } from "lucide-react";
import type { Loom, LoomEvent, SubGoal } from "@telar/core";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/common/empty-state";
import { CharterPanel } from "./charter-panel";
import { ThreadTree } from "./thread-tree";
import { DecisionLog } from "./decision-log";
import { isActive, isTerminal } from "./utils";

const STATE_LABEL: Record<string, string> = {
  done: "done",
  running: "running",
  blocked: "blocked",
  ready: "ready",
  "needs-review": "needs review",
  failed: "failed",
  halted: "halted",
};
const STATE_ORDER = ["done", "running", "blocked", "ready", "needs-review", "failed", "halted"];

// Counts every thread that will actually get a row in ThreadTree — the
// current decomposition PLUS any child whose subGoalId has fallen out of it
// (spawned under a prior charter revision) — so this header total never
// undercounts what "Threads in flight" (computed from the raw `threads`
// array) already includes.
function summarize(decomposition: SubGoal[], threads: Loom[]) {
  const childBySubGoal = new Map<string, Loom>();
  for (const t of threads) {
    if (t.subGoalId) childBySubGoal.set(t.subGoalId, t);
  }
  const knownIds = new Set(decomposition.map((sg) => sg.id));
  const orphanIds = [...childBySubGoal.keys()].filter((id) => !knownIds.has(id));
  const allIds = [...decomposition.map((sg) => sg.id), ...orphanIds];
  const counts: Record<string, number> = {};
  for (const id of allIds) {
    const sg = decomposition.find((d) => d.id === id);
    const child = childBySubGoal.get(id);
    let bucket: string;
    if (!child) {
      // Only decomposition entries can lack a child (orphans are derived
      // from childBySubGoal, so they always have one) — sg is defined here.
      const blocked = (sg?.dependsOn ?? []).some(
        (dep) => childBySubGoal.get(dep)?.state !== "done",
      );
      bucket = blocked ? "blocked" : "ready";
    } else if (child.state === "done") {
      bucket = "done";
    } else if (child.state === "failed") {
      bucket = "failed";
    } else if (child.state === "needs-review") {
      bucket = "needs-review";
    } else if (child.state === "halted" || child.state === "skipped") {
      bucket = "halted";
    } else {
      bucket = "running";
    }
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return { total: allIds.length, counts };
}

export function WeaveGodView({ loom, feed }: { loom: Loom; feed: LoomEvent[] }) {
  const [threads, setThreads] = useState<Loom[]>([]);

  // listChildLooms does a full listLooms() directory scan, so poll deliberately
  // coarser than the 400ms events-route poll — and only while the weave is live.
  useEffect(() => {
    let cancelled = false;
    const fetchThreads = () => {
      fetch(`/api/looms/${loom.id}/threads`)
        .then((res) => res.json())
        .then((data: { threads: Loom[] }) => {
          if (!cancelled) setThreads(data.threads);
        })
        .catch(() => {
          /* transient — next poll (or the terminal fetch) recovers */
        });
    };
    fetchThreads();
    if (isTerminal(loom.state)) return;
    const timer = setInterval(fetchThreads, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loom.id, loom.state]);

  const decomposition = loom.charter?.decomposition ?? [];
  const { total, counts } = summarize(decomposition, threads);
  const summaryText = STATE_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${STATE_LABEL[k]}`)
    .join(" · ");

  const activeThreadCount = threads.filter((t) => isActive(t.state)).length;
  const maxParallelThreads = Math.max(1, loom.charter?.budget.maxParallelThreads ?? 1);
  const progressValue = Math.min(100, (activeThreadCount / maxParallelThreads) * 100);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <CharterPanel charter={loom.charter} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2 px-1">
            <h2 className="font-heading text-sm font-medium">The weave</h2>
            {total > 0 && (
              <span className="font-mono text-xs text-muted-foreground">
                {total} thread{total === 1 ? "" : "s"}
                {summaryText && ` · ${summaryText}`}
              </span>
            )}
          </div>

          {total === 0 ? (
            <EmptyState icon={WorkflowIcon} title="No threads spawned yet." />
          ) : (
            // `children` here is the weave's spawned child Looms (data), not a JSX children slot.
            // eslint-disable-next-line react/no-children-prop
            <ThreadTree decomposition={decomposition} children={threads} weaveId={loom.id} />
          )}
        </section>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-0 lg:self-start">
          <Card size="sm">
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  Threads in flight
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {activeThreadCount} / {maxParallelThreads}
                </span>
              </div>
              <Progress value={progressValue} />
            </CardContent>
          </Card>

          <section className="flex flex-col gap-3">
            <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Decision log
            </h2>
            <Card size="sm" className="min-w-0">
              <CardContent className="min-w-0">
                <DecisionLog events={feed} />
              </CardContent>
            </Card>
          </section>
        </aside>
      </div>
    </div>
  );
}
