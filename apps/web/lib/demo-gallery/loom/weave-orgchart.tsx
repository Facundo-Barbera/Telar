"use client";

// LANE: loom — CONCERN 6, Variant A: the weave as an ORG-CHART.
// The current cockpit hides the shape of the weave behind tabs + a flat card
// list. This makes the decomposition spatial: orchestrator → threads → agents,
// each node live-colored by status, dependency edges named, and the mediation
// depth badged on every thread that repaired. Selecting a thread lights up its
// dependency chain. A live activity timeline rides alongside.
import { useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  CircleX,
  Eye,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  User,
  Workflow,
} from "lucide-react";
import { StatusBadge } from "@/components/looms/status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DEMO_THREADS,
  WEAVE_ACTIVITY,
  WEAVE_OBJECTIVE,
  WEAVE_PLAN,
  WEAVE_PROJECT,
  WEAVE_TITLE,
  threadById,
  type DemoAgent,
  type DemoThread,
  type WeaveActivity,
} from "./fixtures";

const LOOP = ["plan", "schedule", "observe", "decide"] as const;

function AgentChip({ agent }: { agent: DemoAgent }) {
  const isCritic = agent.role === "critic";
  const dot =
    agent.status === "live"
      ? "bg-emerald-500 animate-pulse"
      : agent.status === "passed" || agent.status === "merged"
        ? "bg-emerald-500"
        : agent.status === "failed"
          ? "bg-destructive"
          : agent.status === "blocking"
            ? "bg-amber-500"
            : "bg-muted-foreground/40";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
      title={agent.now}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {isCritic ? (
        <FlaskConical className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <Play className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="max-w-[130px] truncate text-muted-foreground">
        {agent.lens ?? agent.label.replace(/^(Builder|Thread) · /, "").replace("Thread operator", "operator")}
      </span>
    </span>
  );
}

// The mediation depth badge — thread inner-loop → orchestrator → you.
function LadderBadge({ thread }: { thread: DemoThread }) {
  if (thread.mediation.length === 0) return null;
  const top = thread.mediation[thread.mediation.length - 1].level;
  const Icon = top === "human" ? User : top === "orchestrator" ? Workflow : RotateCcw;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        top === "human"
          ? "text-destructive"
          : top === "orchestrator"
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
      )}
      title={`Mediation reached: ${top}`}
    >
      <Icon className="size-3" />
      {thread.mediation.length} repair{thread.mediation.length === 1 ? "" : "s"}
    </Badge>
  );
}

function ThreadNode({
  thread,
  selected,
  related,
  onSelect,
}: {
  thread: DemoThread;
  selected: boolean;
  related: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-all",
        selected
          ? "border-primary/60 ring-1 ring-primary/40"
          : related
            ? "border-primary/30"
            : "border-border hover:border-primary/30 hover:bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{thread.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">{thread.subGoalId}</span>
          </div>
          {thread.dependsOn.length > 0 && (
            <span className="text-[10px] text-muted-foreground/70">
              waits on {thread.dependsOn.join(", ")}
            </span>
          )}
        </div>
        <StatusBadge kind={thread.statusKind} state={thread.state} active={thread.active} label={thread.statusLabel} />
      </div>

      {/* agent lane */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-border pt-2">
        <span className="text-[10px] text-muted-foreground/50">agents</span>
        <ChevronRight className="size-3 text-muted-foreground/30" />
        {thread.agents.map((a) => (
          <AgentChip key={a.id} agent={a} />
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <LadderBadge thread={thread} />
        </div>
      </div>
    </button>
  );
}

const ACT_META: Record<
  WeaveActivity["kind"],
  { Icon: typeof Check; className: string }
> = {
  plan: { Icon: Workflow, className: "text-muted-foreground" },
  ok: { Icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { Icon: CircleX, className: "text-destructive" },
  block: { Icon: CircleAlert, className: "text-amber-600 dark:text-amber-400" },
  info: { Icon: RotateCcw, className: "text-amber-600 dark:text-amber-400" },
  observe: { Icon: Eye, className: "text-muted-foreground" },
};

export function ActivityTimeline({ items }: { items: WeaveActivity[] }) {
  return (
    <ol className="flex flex-col">
      {items.map((a, i) => {
        const meta = ACT_META[a.kind];
        const last = i === items.length - 1;
        return (
          <li key={i} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                <meta.Icon className={cn("size-3", meta.className)} />
              </span>
              {!last && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 pb-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground/90">{a.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground/50">{a.at}</span>
              </div>
              {a.detail && <span className="text-[11px] text-muted-foreground">{a.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function WeaveOrgChart() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? threadById(selectedId) : null;

  // Which threads are in the selected thread's dependency chain (deps + dependents).
  const relatedIds = new Set<string>();
  if (selected) {
    const node = WEAVE_PLAN.find((n) => n.threadId === selected.id);
    if (node) {
      for (const dep of node.dependsOn) {
        const t = WEAVE_PLAN.find((n) => n.id === dep);
        if (t) relatedIds.add(t.threadId);
      }
      for (const n of WEAVE_PLAN) {
        if (n.dependsOn.includes(node.id)) relatedIds.add(n.threadId);
      }
    }
  }

  const active = DEMO_THREADS.filter((t) => t.active).length;
  const done = DEMO_THREADS.filter((t) => t.statusKind === "done").length;
  const needsYou = DEMO_THREADS.filter((t) => t.statusKind === "block").length;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{WEAVE_TITLE}</h1>
          <span className="font-mono text-xs text-muted-foreground/60">{WEAVE_PROJECT}</span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{WEAVE_OBJECTIVE}</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* Orchestrator node */}
          <div className="rounded-xl border border-border bg-card p-3.5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Workflow className="size-4" />
                </span>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm font-medium">Orchestrator</span>
                  <span className="text-xs text-muted-foreground">weaver · owns the loop</span>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs">
                {LOOP.map((s, i) => (
                  <span key={s} className="flex items-center gap-1">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5",
                        s === "observe" ? "bg-foreground/10 font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {s}
                    </span>
                    {i < LOOP.length - 1 ? (
                      <ChevronRight className="size-3 text-muted-foreground/50" />
                    ) : (
                      <RefreshCw className="size-3 text-muted-foreground/50" />
                    )}
                  </span>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  <span className="tabular-nums text-foreground">{active} active</span>
                </span>
                <span className="text-muted-foreground">{done} done</span>
                {needsYou > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">{needsYou} needs you</span>
                )}
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span>
                <span className="font-medium text-foreground/70">Tick:</span> escalated s3 to you — a11y
                keyboard-nav couldn&apos;t be independently proven after 2 thread repairs + 1 mediation.
              </span>
            </div>
          </div>

          {/* spine → threads */}
          <div className="flex justify-center">
            <ArrowDown className="size-4 text-muted-foreground/40" />
          </div>

          <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border/60 pl-4">
            {DEMO_THREADS.map((t) => (
              <div key={t.id} className="relative">
                <span className="absolute -left-4 top-6 h-px w-4 bg-border/60" />
                <ThreadNode
                  thread={t}
                  selected={selectedId === t.id}
                  related={relatedIds.has(t.id)}
                  onSelect={() => setSelectedId((cur) => (cur === t.id ? null : t.id))}
                />
              </div>
            ))}
          </div>

          {selected && (
            <p className="px-1 text-[11px] text-muted-foreground/70">
              Highlighting <span className="font-medium text-foreground/80">{selected.subGoalId}</span>&apos;s
              dependency chain — click again to clear.
            </p>
          )}
        </div>

        {/* activity timeline */}
        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Activity
          </h2>
          <div className="rounded-xl border border-border bg-card p-3.5">
            <ActivityTimeline items={WEAVE_ACTIVITY} />
          </div>
        </aside>
      </div>
    </div>
  );
}
