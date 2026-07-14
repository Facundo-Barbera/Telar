"use client";

// LANE: loom — EXTRA: parallel-lane transcript compare.
// A fanned-out thread splits its work across builders in isolated worktrees,
// merged on green. Today you can only inspect one lane's transcript at a time.
// This shows the parallel builders side by side under the operator that merged
// them — the "isolated worktrees, merged on green" story made legible in one view.
import { GitMerge, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { threadById, type DemoAgent } from "./fixtures";
import { TranscriptView } from "./ui";

function LaneColumn({ agent }: { agent: DemoAgent }) {
  const dot =
    agent.status === "live"
      ? "bg-emerald-500 animate-pulse"
      : "bg-emerald-500";
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <Play className="size-3.5 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium">{agent.label}</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {agent.model} · {agent.turns} turns · ${agent.costUsd?.toFixed(2)}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <span className={cn("size-1.5 rounded-full", dot)} />
          <span className="text-[10px] text-muted-foreground">{agent.status}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TranscriptView entries={agent.transcript} />
      </div>
    </div>
  );
}

export function AgentCompare() {
  const thread = threadById("th_csv_export");
  if (!thread) return null;
  const operator = thread.agents.find((a) => a.id === "op");
  const lanes = thread.agents.filter((a) => a.id.startsWith("piece_"));

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6">
      <header className="mb-4 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{thread.title}</h1>
          <span className="font-mono text-xs text-muted-foreground/60">fan-out ×{lanes.length}</span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{thread.objective}</p>
      </header>

      {/* operator merge strip */}
      {operator && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-border bg-muted/20 px-3.5 py-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <GitMerge className="size-4 text-muted-foreground" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Thread operator</span>
            <span className="text-xs text-muted-foreground">{operator.now}</span>
            <span className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
              {operator.model} · {operator.turns} turns · ${operator.costUsd?.toFixed(2)} · merges both lanes on
              green
            </span>
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
        {lanes.map((a) => (
          <LaneColumn key={a.id} agent={a} />
        ))}
      </div>
    </div>
  );
}
