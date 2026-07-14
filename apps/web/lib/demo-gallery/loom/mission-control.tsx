"use client";

// LANE: loom — CONCERN 6, Variant B: mission control.
// Structurally opposite to the org-chart: this leads with the ONE gate the
// doctrine keeps — the deterministic verification of the composed whole — as a
// hero, then status-dense thread rows (one line each, expandable in place), then
// the activity timeline. The moat note is front-and-centre: nothing here can
// write `done`; only a human accept can.
import { useState } from "react";
import {
  Check,
  ChevronDown,
  Command,
  DollarSign,
  Eye,
  FlaskConical,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Timer,
  Users,
} from "lucide-react";
import { StatusBadge } from "@/components/looms/status";
import { cn } from "@/lib/utils";
import {
  DEMO_THREADS,
  WEAVE_ACTIVITY,
  WEAVE_OBJECTIVE,
  WEAVE_PROJECT,
  WEAVE_TITLE,
  type DemoThread,
} from "./fixtures";
import { GateRow, MediationLadder, SectionLabel, StepTimeline } from "./ui";
import { ActivityTimeline } from "./weave-orgchart";

const SEG_COLOR: Record<string, string> = {
  done: "bg-emerald-500",
  verify: "bg-sky-500",
  run: "bg-foreground",
  block: "bg-amber-500",
  repair: "bg-destructive",
  wait: "bg-muted-foreground/40",
};

function VerificationHero() {
  const total = DEMO_THREADS.length;
  const verdicted = DEMO_THREADS.filter((t) =>
    ["done", "needs-review", "failed"].includes(t.state),
  ).length;
  const gatesGreen = DEMO_THREADS.reduce(
    (n, t) => n + t.gates.filter((g) => g.ok === true).length,
    0,
  );
  const gatesTotal = DEMO_THREADS.reduce((n, t) => n + t.gates.length, 0);
  const critics = DEMO_THREADS.flatMap((t) => t.agents.filter((a) => a.role === "critic"));
  const criticsCleared = critics.filter((a) => a.status === "passed").length;
  const repairs = DEMO_THREADS.reduce((n, t) => n + t.mediation.length, 0);
  const totalCost = DEMO_THREADS.reduce((n, t) => n + t.costUsd, 0);

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15">
            <ShieldCheck className="size-5 text-amber-600 dark:text-amber-400" />
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-semibold">Awaiting your review</span>
            <span className="text-sm text-muted-foreground">
              {verdicted} of {total} threads reached a verdict · 1 needs you · 1 dead-ended
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
          <DollarSign className="size-3.5" />
          {totalCost.toFixed(2)} spent
        </div>
      </div>

      {/* segmented progress of the whole weave */}
      <div className="mt-4 flex flex-col gap-1.5">
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          {DEMO_THREADS.map((t) => (
            <div
              key={t.id}
              className={cn("flex-1", SEG_COLOR[t.statusKind] ?? "bg-muted", t.active && "animate-pulse")}
              title={`${t.title} · ${t.statusLabel}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <Legend color="bg-emerald-500" label="promoted" />
          <Legend color="bg-sky-500" label="verifying" />
          <Legend color="bg-foreground" label="building" />
          <Legend color="bg-amber-500" label="needs you" />
          <Legend color="bg-destructive" label="failed" />
        </div>
      </div>

      {/* verification breakdown */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HeroStat icon={Command} label="Gates green" value={`${gatesGreen}/${gatesTotal}`} />
        <HeroStat icon={FlaskConical} label="Critics cleared" value={`${criticsCleared}/${critics.length}`} />
        <HeroStat icon={RotateCcw} label="Repairs spent" value={repairs} tone="warn" />
        <HeroStat icon={Users} label="Threads" value={total} />
      </div>

      <p className="mt-3 flex items-start gap-1.5 border-t border-amber-500/20 pt-3 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        A green verify lands the weave in <span className="font-medium text-foreground/80">ready</span> — never
        done. A red integration verdict demotes it to needs-review. Nothing here can mark itself done; only your
        accept writes <span className="font-medium text-foreground/80">done</span>.
      </p>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("size-2 rounded-full", color)} />
      {label}
    </span>
  );
}

function HeroStat({
  icon: Icon,
  label,
  value,
  tone = "muted",
}: {
  icon: typeof Command;
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "warn";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2">
      <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3" />
        {label}
      </span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DenseRow({ thread }: { thread: DemoThread }) {
  const [open, setOpen] = useState(false);
  const gatesOk = thread.gates.filter((g) => g.ok === true).length;
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{thread.title}</span>
          <span className="hidden font-mono text-[10px] text-muted-foreground/60 sm:inline">
            {thread.subGoalId}
          </span>
        </div>
        {/* dense inline signal chips */}
        <div className="hidden shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70 md:flex">
          <span className="rounded bg-muted px-1.5 py-0.5">
            {gatesOk}/{thread.gates.length} gates
          </span>
          {thread.mediation.length > 0 && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                thread.state === "failed" || thread.state === "needs-review"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
              )}
            >
              {thread.mediation.length} rep
            </span>
          )}
          <span className="flex items-center gap-0.5">
            <DollarSign className="size-2.5" />
            {thread.costUsd.toFixed(2)}
          </span>
          <span className="flex items-center gap-0.5">
            <Timer className="size-2.5" />
            {thread.elapsed}
          </span>
        </div>
        <StatusBadge kind={thread.statusKind} state={thread.state} active={thread.active} label={thread.statusLabel} />
      </button>

      {open && (
        <div className="grid gap-4 border-t border-border px-3 py-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <SectionLabel>
              <Command className="size-3.5" />
              Steps
            </SectionLabel>
            <StepTimeline steps={thread.steps} dense />
            {thread.gates.length > 0 && (
              <div className="mt-1 flex flex-col gap-1.5">
                {thread.gates.map((g) => (
                  <GateRow key={g.name} gate={g} />
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <SectionLabel>
              <RotateCcw className="size-3.5" />
              Mediation ladder
            </SectionLabel>
            <MediationLadder rungs={thread.mediation} />
          </div>
        </div>
      )}
    </div>
  );
}

export function MissionControl() {
  const needsYou = DEMO_THREADS.filter((t) => t.statusKind === "block").length;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="mb-4 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{WEAVE_TITLE}</h1>
          <span className="font-mono text-xs text-muted-foreground/60">{WEAVE_PROJECT}</span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{WEAVE_OBJECTIVE}</p>
      </header>

      <VerificationHero />

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">The weave</h2>
            <span className="text-xs text-muted-foreground/60">
              {DEMO_THREADS.length} threads
              {needsYou > 0 && ` · ${needsYou} needs you`}
            </span>
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/50">
              <ChevronDown className="size-3" />
              expand a row
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {DEMO_THREADS.map((t) => (
              <DenseRow key={t.id} thread={t} />
            ))}
          </div>
        </section>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Activity</h2>
          <div className="rounded-xl border border-border bg-card p-3.5">
            <ActivityTimeline items={WEAVE_ACTIVITY} />
          </div>
        </aside>
      </div>
    </div>
  );
}
