"use client";

// LANE: loom-detail (UX brainstorm 2026-07-23) — FINAL DESIGN, at-scale
// variant (novarix, heavy load + one live escalation). Renders from the same
// shared cockpit kit as the baseline (./cockpit.tsx): identical tabs,
// conductor card, thread rows, contract rows, prep nodes and lab rows — the
// only differences are data, workstream group labels (a label from the
// interference analysis, never a role: sub-orchestration is per thread), and
// the amber escalation path.
import { useState } from "react";
import {
  ActivityIcon,
  AppWindowIcon,
  ArrowLeftIcon,
  CircleAlertIcon,
  GitMergeIcon,
  LockIcon,
  MessagesSquareIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ActTab,
  ConductorCard,
  ContractGroups,
  LabRoom,
  LoomVerbs,
  Room,
  ThreadGroup,
  cockpitVisual,
} from "./cockpit";
import { GateGraph } from "../prep-gate/shared";
import {
  CONTRACT2,
  DECISIONS2,
  DEGRADED2,
  HEARTBEAT2,
  LAB_META2,
  LAB_SERVICES2,
  LADDER2,
  LOOM2,
  MERGE_QUEUE2,
  PASS2,
  PREP_DAG2,
  PREP_EDITS2,
  RATE_LANES,
  RATE_RECOMPILES,
  RATE_RUNGS,
  RATE_SPINE,
  ROOT_ORCH,
  TOTAL2,
  WORKSTREAMS,
} from "./fixtures-scale";
import type { ScaleLane } from "./fixtures-scale";
import { ASSERT_VISUAL, ActorTag, NODE_VISUAL, StateIcon } from "./shared";
import { EscalationSessionBody, SteeringSessionBody } from "./session";
import type { SteerTurn } from "./session";

type Act = "prepare" | "execute" | "judge";
type Drill =
  | null
  | { kind: "thread"; id: string }
  | { kind: "orch" }
  | { kind: "lab" }
  | { kind: "session"; id: "intake" | "steering" | "escalation" };

const STEERING2: SteerTurn[] = [
  {
    from: "you",
    t: "09:15",
    text: "Where are we on the backfill, and is tax going to block the accept?",
  },
  {
    from: "agent",
    who: "orchestrator",
    t: "09:15",
    text: "Backfill is replaying month 9 of 14, throttled to 2 lanes under the semaphore. Tax-adapter is on its last repair attempt — if it exhausts, I knock. R6 already passed in synthetic mode, so tax does not block the accept.",
  },
];

function PrepareRoom() {
  return (
    <Room>
      <p className="text-sm leading-relaxed text-foreground/90">{LOOM2.goal}</p>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
        <LockIcon className="size-3.5 text-muted-foreground/60" />
        <span className="text-xs text-muted-foreground">gate passed 06:44</span>
        <span className="ml-auto cursor-default rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-foreground/25">
          Reopen — modify on the go
        </span>
      </div>

      {/* the same DAG map as the gate room (UX 4), frozen as the receipt —
          the heavy end: five sessions blooming from the opening */}
      <div className="h-[420px]">
        <GateGraph
          nodes={PREP_DAG2.nodes}
          edges={PREP_DAG2.edges}
          gateState="sealed"
          gateSub="accepted 06:44 · the receipt"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Your edits before lock
          </p>
          <div className="mt-2 space-y-1.5">
            {PREP_EDITS2.map((e) => (
              <p key={e} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <ActorTag actor="you" />
                <span className="min-w-0">{e}</span>
              </p>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-dashed border-amber-600/40 p-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            <TriangleAlertIcon className="size-3 text-amber-600 dark:text-amber-400" />
            Reality manifest
          </p>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {DEGRADED2}
          </p>
        </div>
      </div>
    </Room>
  );
}

function ExecuteRoom({
  onThread,
  onOrch,
}: {
  onThread: (id: string) => void;
  onOrch: () => void;
}) {
  return (
    <Room>
      <p className="text-sm leading-relaxed text-foreground/90">{LOOM2.goal}</p>

      <ConductorCard
        watching={ROOT_ORCH.watching}
        statusLine={`last beat ${ROOT_ORCH.beat} · flatline threshold ${ROOT_ORCH.flatline} · ${ROOT_ORCH.mediations} mediations today · escalations to you today: 1`}
        onOpen={onOrch}
      />

      {WORKSTREAMS.map((ws) => (
        <ThreadGroup key={ws.id} label={ws.id} threads={ws.threads} onThread={onThread} />
      ))}
    </Room>
  );
}

function JudgeRoom() {
  return (
    <Room>
      <p className="text-sm text-foreground/90">
        {PASS2}/{TOTAL2} assertions green.
      </p>

      <ContractGroups
        groups={CONTRACT2.map((g) => ({ label: g.group, asserts: g.asserts }))}
      />

      <div className="rounded-lg bg-muted/20 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          R6 passed in the declared synthetic mode.
        </p>
      </div>
    </Room>
  );
}

// ---- The 5-lane thread. Same card sizes as the rest of the cockpit; the
// lane grid goes 3-across.
function RatesEngineThread() {
  const laneBox = (lane: ScaleLane) => (
    <div
      key={lane.name}
      className={cn(
        "space-y-2 rounded-xl border border-dashed border-border p-2.5",
        lane.state === "wait" && "opacity-60",
      )}
    >
      <p className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground/60">
        <StateIcon visual={NODE_VISUAL[lane.state]} className="size-3" />
        {lane.name} · {lane.wt}
      </p>
      {lane.nodes.map((n) => (
        <div
          key={n.id}
          className={cn(
            "min-w-0 rounded-xl border border-border bg-card p-2.5",
            n.state === "wait" && "opacity-60",
          )}
        >
          <div className="flex items-center gap-2">
            <StateIcon visual={NODE_VISUAL[n.state]} className="size-3.5 shrink-0" />
            <span className="truncate text-xs font-medium">{n.title}</span>
          </div>
          <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">{n.id}</p>
        </div>
      ))}
    </div>
  );

  const spineCard = (n: { id: string; title: string; state: "done" | "wait" }) => (
    <div
      key={n.id}
      className={cn(
        "min-w-0 rounded-xl border border-border bg-card p-2.5",
        n.state === "wait" && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <StateIcon visual={NODE_VISUAL[n.state]} className="size-3.5 shrink-0" />
        <span className="truncate text-xs font-medium">{n.title}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground/60">{n.id}</p>
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl gap-6 px-6 py-6">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Compiled flow · v3
            </h2>
            <span className="font-mono text-[9px] text-muted-foreground/50">
              team of 7 · 5 builder lanes
            </span>
          </div>

          {RATE_SPINE.top.map(spineCard)}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {RATE_LANES.map(laneBox)}
          </div>

          {RATE_SPINE.tail.map(spineCard)}

          <div className="space-y-1.5">
            {RATE_RECOMPILES.map((r) => (
              <div
                key={r}
                className={cn(
                  "rounded-lg border border-dashed px-3 py-2",
                  r.includes("EXHAUSTED") ? "border-amber-600/40" : "border-border",
                )}
              >
                <div className="flex items-start gap-2">
                  <ActorTag actor="orchestrator" />
                  <p className="min-w-0 font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {r}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="w-64 shrink-0 space-y-4">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Rungs
            </h2>
            <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
              {RATE_RUNGS.map((r, i) => {
                const v =
                  r.state === "pass"
                    ? ASSERT_VISUAL.pass
                    : r.state === "run"
                      ? ASSERT_VISUAL.running
                      : ASSERT_VISUAL.pending;
                return (
                  <div
                    key={r.label}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2",
                      i > 0 && "border-t border-border/60",
                      r.state === "queued" && "opacity-50",
                    )}
                  >
                    <StateIcon visual={v} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                      {r.label}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                      {r.age}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// The conductor's seat — same panels as the baseline, heavier data.
function RootConductor() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Progress heartbeat
          </h2>
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
              <ActivityIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs text-foreground/90">
                last beat {ROOT_ORCH.beat} · flatline threshold {ROOT_ORCH.flatline}
              </span>
            </div>
            <div className="space-y-1.5 pt-2.5">
              {HEARTBEAT2.map((b) => (
                <div key={b.time + b.text} className="flex items-baseline gap-2.5">
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                    {b.time}
                  </span>
                  <span className="min-w-0 truncate text-xs text-foreground/85">{b.text}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Decision log
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {DECISIONS2.map((d, i) => (
              <div
                key={d.time}
                className={cn("flex items-baseline gap-2.5 px-3 py-2", i > 0 && "border-t border-border/60")}
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {d.time}
                </span>
                <span className="min-w-0 text-xs leading-relaxed text-foreground/85">{d.text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Loom-branch merge queue
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {MERGE_QUEUE2.map((m, i) => (
              <div
                key={m.id}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2",
                  i > 0 && "border-t border-border/60",
                  m.state.startsWith("held") && "opacity-60",
                )}
              >
                <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                <span className="font-mono text-xs text-foreground/90">{m.id}</span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">{m.state}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Escalation ladder
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {LADDER2.map((l, i) => (
              <div
                key={l.rung}
                className={cn("flex items-center gap-3 px-3 py-2.5", i > 0 && "border-t border-border/60")}
              >
                <span className="w-20 shrink-0 font-mono text-[10px] text-foreground/80">{l.rung}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px]",
                    l.count === 0 ? "text-muted-foreground/50" : "text-foreground",
                  )}
                >
                  ×{l.count} today
                </span>
                <span className="min-w-0 truncate text-[10px] text-muted-foreground">{l.note}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ThreadStub({ id }: { id: string }) {
  const t = WORKSTREAMS.flatMap((s) => s.threads).find((th) => th.id === id)!;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="max-w-sm space-y-2 rounded-xl border border-dashed border-border p-6 text-center">
        <div className="flex items-center justify-center gap-2">
          <StateIcon visual={cockpitVisual(t.state)} className="size-4" />
          <span className="font-mono text-sm font-medium">{t.id}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t.activity}</p>
        <p className="font-mono text-[9px] text-muted-foreground/50">
          demo: only rates-engine is fully staffed — open it from Execute
        </p>
      </div>
    </div>
  );
}

export function LoomScaleDemo() {
  const [act, setAct] = useState<Act>("execute");
  const [drill, setDrill] = useState<Drill>(null);
  const [showWindow, setShowWindow] = useState(false);
  const [showChats, setShowChats] = useState(false);

  const openSession = (id: "intake" | "steering" | "escalation") => {
    setDrill({ kind: "session", id });
    setShowChats(false);
  };

  const goRoom = (a: Act) => {
    setAct(a);
    setDrill(null);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
        <nav className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <span>{LOOM2.project}</span>
          <span className="text-muted-foreground/40">/</span>
          <button
            type="button"
            onClick={() => setDrill(null)}
            className={cn(drill ? "hover:underline" : "text-foreground")}
          >
            {LOOM2.id}
          </button>
          {drill?.kind === "thread" && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-foreground">threads / {drill.id}</span>
            </>
          )}
          {drill?.kind === "orch" && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-foreground">orchestrator</span>
            </>
          )}
          {drill?.kind === "lab" && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-foreground">lab</span>
            </>
          )}
          {drill?.kind === "session" && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-foreground">
                {drill.id === "intake"
                  ? "prepare / conversation"
                  : drill.id === "escalation"
                    ? "tax-adapter / question"
                    : "steering"}
              </span>
            </>
          )}
        </nav>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          started {LOOM2.started} · {LOOM2.spend} of {LOOM2.budget} · {LOOM2.subgoalsDone}/
          {LOOM2.subgoalsTotal} subgoals
        </span>

        {/* loom verbs — park / kill, always in reach */}
        <LoomVerbs />

        {/* the WINDOW on a heavy project: on-demand — opening it borrows the
            stack under the fleet semaphore, releases on close. */}
        <span className="relative">
          <button
            type="button"
            onClick={() => setShowWindow((s) => !s)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
              showWindow
                ? "border-foreground/30 bg-muted/40 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/40",
            )}
          >
            <AppWindowIcon className="size-3" /> window · on-demand
          </button>
          {showWindow && (
            <div className="absolute right-0 top-9 z-20 w-80 space-y-2 rounded-xl border border-border bg-card p-3 shadow-md">
              <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-border bg-muted/20">
                <span className="font-mono text-[10px] text-muted-foreground/50">
                  stack parked — no lane running
                </span>
              </div>
              <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
                {LAB_META2.window.note}
              </p>
              <p className="font-mono text-[9px] text-muted-foreground/60">
                {LAB_META2.semaphore}
              </p>
              <div className="pt-0.5">
                <span className="cursor-default rounded-md border border-foreground/20 bg-foreground px-2.5 py-1 text-[11px] text-background">
                  Borrow &amp; open
                </span>
              </div>
            </div>
          )}
        </span>

        <button
          type="button"
          onClick={() => setDrill({ kind: "lab" })}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
            drill?.kind === "lab"
              ? "border-foreground/30 bg-muted/40 text-foreground"
              : "border-border text-muted-foreground hover:bg-muted/40",
          )}
        >
          <ServerIcon className="size-3" /> lab
        </button>

        <span className="relative">
          <button
            type="button"
            onClick={() => setShowChats((s) => !s)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
              showChats || drill?.kind === "session"
                ? "border-foreground/30 bg-muted/40 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/40",
            )}
          >
            <MessagesSquareIcon className="size-3 text-amber-600 dark:text-amber-400" />{" "}
            chats · 3
          </button>
          {showChats && (
            <div className="absolute right-0 top-9 z-20 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-md">
              <button
                type="button"
                onClick={() => openSession("escalation")}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
              >
                <CircleAlertIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-xs font-medium">Tax rounding question</span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                  needs you · 09:21
                </span>
              </button>
              <button
                type="button"
                onClick={() => openSession("steering")}
                className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-left hover:bg-muted/40"
              >
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
                  <span className="relative inline-flex size-2 rounded-full bg-foreground/70" />
                </span>
                <span className="text-xs font-medium">Steering thread</span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                  open · orchestrator
                </span>
              </button>
              <button
                type="button"
                onClick={() => openSession("intake")}
                className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-left hover:bg-muted/40"
              >
                <LockIcon className="size-3 shrink-0 text-muted-foreground/50" />
                <span className="text-xs font-medium">Opening conversation</span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">
                  closed 06:44 · intake
                </span>
              </button>
            </div>
          )}
        </span>
      </header>

      <div className="flex shrink-0 items-end gap-6 border-b border-border px-6 pt-3">
        <ActTab
          label="Prepare"
          meta="locked 06:40"
          locked
          active={act === "prepare"}
          onClick={() => goRoom("prepare")}
        />
        <ActTab
          label="Execute"
          meta="5 live · 1 needs you · 11 threads"
          active={act === "execute"}
          onClick={() => goRoom("execute")}
        />
        <ActTab
          label="Judge"
          meta={`${PASS2}/${TOTAL2} lit`}
          active={act === "judge"}
          onClick={() => goRoom("judge")}
        />
        <span className="ml-auto pb-2.5 font-mono text-[10px] text-muted-foreground/50">
          {LOOM2.title}
        </span>
      </div>

      {/* the attention strip — the ONE loud thing, visible from every room
          until answered. */}
      {!(drill?.kind === "session" && drill.id === "escalation") && (
        <button
          type="button"
          onClick={() => openSession("escalation")}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-6 py-2 text-left hover:bg-muted/40"
        >
          <CircleAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-xs text-foreground/90">
            tax-adapter — question for you · parked 09:21
          </span>
          <span className="ml-auto rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            Answer
          </span>
        </button>
      )}

      {drill && (
        <div className="flex shrink-0 items-center border-b border-border px-6 py-1.5">
          <button
            type="button"
            onClick={() => setDrill(null)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] text-muted-foreground hover:bg-muted/40"
          >
            <ArrowLeftIcon className="size-3" />
            {drill.kind === "lab" || drill.kind === "session" ? "back" : "back to Execute"}
          </button>
        </div>
      )}

      {drill?.kind === "thread" && drill.id === "rates-engine" ? (
        <RatesEngineThread />
      ) : drill?.kind === "thread" ? (
        <ThreadStub id={drill.id} />
      ) : drill?.kind === "orch" ? (
        <RootConductor />
      ) : drill?.kind === "lab" ? (
        <LabRoom
          topLine={LAB_META2.semaphore}
          services={LAB_SERVICES2}
          metaLines={[LAB_META2.lease, LAB_META2.carry]}
        />
      ) : drill?.kind === "session" ? (
        drill.id === "steering" ? (
          <SteeringSessionBody turns={STEERING2} />
        ) : drill.id === "escalation" ? (
          <EscalationSessionBody />
        ) : (
          <SteeringSessionBody
            turns={[]}
            note="conversation closed at the gate 06:44"
            placeholder="Reopen the conversation — modify on the go…"
          />
        )
      ) : act === "prepare" ? (
        <PrepareRoom />
      ) : act === "judge" ? (
        <JudgeRoom />
      ) : (
        <ExecuteRoom
          onThread={(id) =>
            id === "tax-adapter"
              ? openSession("escalation")
              : setDrill({ kind: "thread", id })
          }
          onOrch={() => setDrill({ kind: "orch" })}
        />
      )}
    </div>
  );
}
