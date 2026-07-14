"use client";

// LANE: loom — EXTRA: the weave-wide mediation ledger.
// The doctrine says threads are their own inner loops that escalate to the
// orchestrator only when exhausted, and the orchestrator mediates before it ever
// pings the human. Today that chain is invisible — you see a thread go red, then
// a needs-review, with no account of who tried what. This surfaces the whole
// escalation ladder across the weave, so a human arriving at a needs-review can
// see exactly how far the autonomy climbed before it stopped.
import {
  RotateCcw,
  User,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/looms/status";
import { DEMO_THREADS, WEAVE_PROJECT, WEAVE_TITLE, type DemoThread } from "./fixtures";
import { MediationLadder } from "./ui";

function LevelKey({
  icon: Icon,
  title,
  desc,
  className,
}: {
  icon: typeof RotateCcw;
  title: string;
  desc: string;
  className: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
      <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted")}>
        <Icon className={cn("size-3.5", className)} />
      </span>
      <div className="flex flex-col">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-[11px] text-muted-foreground">{desc}</span>
      </div>
    </div>
  );
}

function LedgerCard({ thread }: { thread: DemoThread }) {
  const rounds = thread.mediation.length;
  const reachedHuman = thread.mediation.some((r) => r.level === "human");
  const reachedOrch = thread.mediation.some((r) => r.level === "orchestrator");
  const spent = thread.mediation.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{thread.title}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">{thread.subGoalId}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {rounds} rung{rounds === 1 ? "" : "s"} · climbed to{" "}
            <span
              className={cn(
                "font-medium",
                reachedHuman
                  ? "text-destructive"
                  : reachedOrch
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-foreground/80",
              )}
            >
              {reachedHuman ? "you" : reachedOrch ? "orchestrator" : "thread loop"}
            </span>
            {spent > 0 && <span className="font-mono text-muted-foreground/60"> · ${spent.toFixed(2)}</span>}
          </span>
        </div>
        <StatusBadge kind={thread.statusKind} state={thread.state} active={thread.active} label={thread.statusLabel} />
      </div>
      <div className="mt-3 border-t border-border pt-3">
        <MediationLadder rungs={thread.mediation} />
      </div>
    </div>
  );
}

export function MediationLedger() {
  const repaired = DEMO_THREADS.filter((t) => t.mediation.length > 0);
  const totalRounds = repaired.reduce((n, t) => n + t.mediation.length, 0);
  const escalatedToHuman = repaired.filter((t) => t.mediation.some((r) => r.level === "human")).length;
  const mediatedByOrch = repaired.filter((t) => t.mediation.some((r) => r.level === "orchestrator")).length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <header className="mb-4 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Mediation ledger</h1>
          <span className="font-mono text-xs text-muted-foreground/60">
            {WEAVE_PROJECT} · {WEAVE_TITLE}
          </span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every repair the weave attempted, and how far up the escalation ladder it climbed before it stopped —
          so arriving at a needs-review, you can see exactly what the autonomy already tried.
        </p>
      </header>

      {/* the three rungs of the ladder, explained */}
      <div className="grid gap-2 sm:grid-cols-3">
        <LevelKey
          icon={RotateCcw}
          title="Thread inner loop"
          desc="The thread repairs itself against the failing criterion + a repro, bounded."
          className="text-muted-foreground"
        />
        <LevelKey
          icon={Workflow}
          title="Orchestrator"
          desc="On exhaustion, the orchestrator mediates — re-scopes and re-hands the work."
          className="text-amber-600 dark:text-amber-400"
        />
        <LevelKey
          icon={User}
          title="You"
          desc="Only when mediation is exhausted does it escalate — never a fabricated green."
          className="text-destructive"
        />
      </div>

      {/* summary line */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground tabular-nums">{totalRounds}</span> repair rounds across{" "}
          <span className="font-medium text-foreground tabular-nums">{repaired.length}</span> threads
        </span>
        <span>
          <span className="font-medium text-amber-600 tabular-nums dark:text-amber-400">{mediatedByOrch}</span>{" "}
          reached orchestrator mediation
        </span>
        <span>
          <span className="font-medium text-destructive tabular-nums">{escalatedToHuman}</span> escalated to you
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {repaired.map((t) => (
          <LedgerCard key={t.id} thread={t} />
        ))}
      </div>
    </div>
  );
}
