"use client";
// PROPOSED FINAL — the ACTIVE dashboard, loom-aware (session verdict: don't
// replace the current home, work around it). Same skeleton as production
// app/page.tsx: KPI hero, two-column command deck, 3px rails, panels. The
// grafts: "Needs you" splits into deliveries (judged in place — accept /
// boomerang) and parked questions; "Running now" rows carry the act + live
// evidence age (the window, ambient); done-today receipt; hot projects
// carry their map drift note; recent sessions stay first-class — looms are
// born there.
import { useState } from "react";
import {
  ActivityIcon,
  CircleCheckIcon,
  FolderGit2Icon,
  GaugeIcon,
  LayersIcon,
  MessagesSquareIcon,
  TriangleAlertIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FLEET, REGION_META } from "./fixtures";
import { FauxShell, PHASE, PhaseChip, ProjectTag } from "./shared";

const READY = FLEET.find((l) => l.id === "payments-retry")!;
const BLOCKED = FLEET.find((l) => l.id === "csv-export-sunset")!;
const RUNNING = FLEET.filter(
  (l) => !["payments-retry", "csv-export-sunset"].includes(l.id),
);

const SESSIONS = [
  { title: "Discuss build strategy and phases", project: "telar", ago: "12m" },
  { title: "New loom: search filters", project: "novarix", ago: "1h" },
  { title: "Fix flaky supabase boot", project: "ozom-gv", ago: "3h" },
];

const HOT = [
  { name: "ozom", note: REGION_META.ozom.note, looms: 2 },
  { name: "novarix", note: REGION_META.novarix.note, looms: 2, drifting: true },
  { name: "aurora", note: REGION_META.aurora.note, looms: 1 },
];

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  tint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5", tint ?? "text-muted-foreground")} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/35" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  count,
  tint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("size-3.5", tint ?? "text-muted-foreground")} />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</h2>
        {count !== undefined && (
          <span className="font-mono text-[10px] text-muted-foreground/60">{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

// GRAFT 1a — the ready delivery, judged in place: the UX 3 shelf row,
// compressed to the dashboard's row grammar (rail + title + claim + verdict).
function DeliveryRow() {
  const [state, setState] = useState<"idle" | "accepted" | "boomeranged">("idle");
  return (
    <div className="relative py-2.5 pl-3.5 pr-3">
      <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full bg-emerald-600 dark:bg-emerald-400" />
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{READY.title}</span>
        <ProjectTag name={READY.project} />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
          release grade
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{READY.claim}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
        {READY.proof} · risk: {READY.risk}
      </p>
      <div className="mt-2">
        {state === "idle" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setState("accepted")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/40 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              <CircleCheckIcon className="size-3" />
              Accept
            </button>
            <button
              type="button"
              onClick={() => setState("boomeranged")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Undo2Icon className="size-3" />
              Boomerang
            </button>
            <span className="font-mono text-[9px] text-muted-foreground/50">
              or open the card for the full dossier
            </span>
          </div>
        )}
        {state === "accepted" && (
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <CircleCheckIcon className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            accepted · landing queued — silent unless it knocks · 1 map note → drift ledger
          </p>
        )}
        {state === "boomeranged" && (
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Undo2Icon className="size-3 shrink-0" />
            boomeranged — tell it what to finish in its card; branch and recipe kept
          </p>
        )}
      </div>
    </div>
  );
}

// GRAFT 1b — the parked question, verbatim, answer-resumes-it.
function QuestionRow() {
  return (
    <div className="relative py-2.5 pl-3.5 pr-3">
      <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full bg-amber-600 dark:bg-amber-400" />
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{BLOCKED.title}</span>
        <ProjectTag name={BLOCKED.project} />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
          parked since 08:31
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-foreground/85">“{BLOCKED.question}”</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
        answering resumes the loom — everything else about it is parked, not lost
      </p>
    </div>
  );
}

// GRAFT 2 — running rows keep the production grammar (rail, title, project,
// cost) and gain the act + the window's evidence age.
function RunningRow({ id }: { id: string }) {
  const loom = FLEET.find((l) => l.id === id)!;
  const p = PHASE[loom.phase];
  return (
    <div className="relative flex items-center gap-3 py-2 pl-3.5 pr-3">
      <span
        aria-hidden
        className={cn("absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full", p.rail)}
      />
      <PhaseChip phase={loom.phase} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{loom.title}</span>
          <ProjectTag name={loom.project} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{loom.activity}</p>
      </div>
      {loom.evidence && (
        <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/60 sm:block">
          ev {loom.evidence.age}
        </span>
      )}
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {loom.spend}
      </span>
    </div>
  );
}

export function HomeCurrentDemo() {
  return (
    <FauxShell>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-6 py-6">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Dashboard</h1>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              Thursday · 7 looms · 3 sessions
            </span>
            <button
              type="button"
              className="ml-auto rounded-lg border border-foreground/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              New session
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              icon={ActivityIcon}
              label="Running now"
              value="5"
              sub="looms in flight"
              tint="text-sky-400"
            />
            <StatTile
              icon={TriangleAlertIcon}
              label="Needs you"
              value="2"
              sub="1 delivery · 1 question"
              tint="text-amber-400"
            />
            <StatTile
              icon={LayersIcon}
              label="Threads weaving"
              value="9"
              sub="across woven looms"
              tint="text-indigo-300"
            />
            <StatTile
              icon={GaugeIcon}
              label="Spend today"
              value="$18.20"
              sub="across today's looms"
            />
            <div className="col-span-2 flex flex-col justify-center gap-2 rounded-xl border border-border bg-card px-3.5 py-3 sm:col-span-1">
              <Meter label="Session · 5h" pct={62} />
              <Meter label="Weekly" pct={41} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-4">
              <Panel icon={TriangleAlertIcon} title="Needs you" count={2} tint="text-amber-400">
                <div className="divide-y divide-border">
                  <DeliveryRow />
                  <QuestionRow />
                </div>
              </Panel>

              <Panel icon={ActivityIcon} title="Running now" count={5} tint="text-sky-400">
                <div className="divide-y divide-border">
                  {RUNNING.map((l) => (
                    <RunningRow key={l.id} id={l.id} />
                  ))}
                </div>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel icon={MessagesSquareIcon} title="Recent sessions" count={3}>
                <div className="divide-y divide-border">
                  {SESSIONS.map((s) => (
                    <div key={s.title} className="flex items-center gap-2.5 px-3 py-2">
                      <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{s.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {s.project}
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{s.ago}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel icon={CircleCheckIcon} title="Done today" count={1}>
                <div className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span className="truncate text-sm">Onboarding copy pass</span>
                    <ProjectTag name="aurora" />
                  </div>
                  <p className="mt-1 pl-5.5 font-mono text-[10px] text-muted-foreground/60">
                    accepted 08:12 · landed silently · like it was never here
                  </p>
                </div>
              </Panel>

              <Panel icon={FolderGit2Icon} title="Hot projects">
                <div className="divide-y divide-border">
                  {HOT.map((p) => (
                    <div key={p.name} className="flex items-center gap-2.5 px-3 py-2">
                      <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm">{p.name}</span>
                          {p.drifting && (
                            <span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                              <span className="text-amber-600 dark:text-amber-400">drifting</span>
                            </span>
                          )}
                        </div>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                          {p.note}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                        {p.looms} looms
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </FauxShell>
  );
}
