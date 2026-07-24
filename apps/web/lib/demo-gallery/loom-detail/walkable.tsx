"use client";

// LANE: loom-detail (UX brainstorm 2026-07-23) — FINAL DESIGN, baseline
// variant (ozom, nothing needs you). Renders entirely from the shared
// cockpit kit (./cockpit.tsx) so both variants are ONE design: tabs = rooms,
// drills = teams / conductor / lab / sessions, breadcrumb + back walk out.
import { useState } from "react";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  LockIcon,
  MessagesSquareIcon,
  ServerIcon,
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
} from "./cockpit";
import type { CockpitThread } from "./cockpit";
import { GateGraph } from "../prep-gate/shared";
import {
  CONTRACT,
  GRAPH_EDITS,
  LAB_META,
  LAB_SERVICES,
  LOOM,
  MEDIATION,
  PREP_DAG,
  THREADS,
} from "./fixtures";
import { ActorTag, NODE_VISUAL, StateIcon } from "./shared";
import { ThreadBody } from "./thread";
import { OrchestratorBody } from "./orchestrator";
import { IntakeSessionBody, SteeringSessionBody } from "./session";
import type { SteerTurn } from "./session";

type Act = "prepare" | "execute" | "judge";
type Drill =
  | null
  | { kind: "thread"; id: string }
  | { kind: "orch" }
  | { kind: "lab" }
  | { kind: "session"; id: "intake" | "steering" };

const STEERING: SteerTurn[] = [
  { from: "you", t: "09:08", text: "How is the mobile nav coming — anything risky?" },
  {
    from: "agent",
    t: "09:08",
    text: "Lane B is at 11/11 after one selector-drift retry; the focus trap on the blocked dialog is the last piece. A5 is verifying in the lab. Nothing on the board needs you.",
  },
];

const EXEC_THREADS: CockpitThread[] = THREADS.map((t) => ({
  id: t.id,
  state: t.state,
  activity: t.activity,
  evidenceAge: t.evidence?.age,
}));

const passCount = CONTRACT.filter((a) => a.state === "pass").length;

function PrepareRoom({ onOpenSession }: { onOpenSession: () => void }) {
  return (
    <Room>
      <p className="text-sm leading-relaxed text-foreground/90">{LOOM.goal}</p>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
        <LockIcon className="size-3.5 text-muted-foreground/60" />
        <span className="text-xs text-muted-foreground">gate passed 07:24</span>
        <span className="ml-auto cursor-default rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-foreground/25">
          Reopen — modify on the go
        </span>
      </div>

      {/* the same DAG map as the gate room (UX 4), frozen as the receipt */}
      <div className="h-[420px]">
        <GateGraph
          nodes={PREP_DAG.nodes}
          edges={PREP_DAG.edges}
          gateState="sealed"
          gateSub="accepted 07:24 · the receipt"
          onNode={(id) => {
            if (id === "opening") onOpenSession();
          }}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Your edits before lock
        </p>
        <div className="mt-2 space-y-1.5">
          {GRAPH_EDITS.map((e) => (
            <p key={e} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <ActorTag actor="you" />
              <span className="min-w-0">{e}</span>
            </p>
          ))}
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
      <p className="text-sm leading-relaxed text-foreground/90">{LOOM.goal}</p>

      <ConductorCard
        watching="watching 2 lanes · merges on green · last mediation 08:41 (rung 1)"
        statusLine="last beat 1m ago · flatline threshold 12m · escalations to you today: 0"
        onOpen={onOrch}
      />

      <ThreadGroup threads={EXEC_THREADS} onThread={onThread} />

      <div className="rounded-lg border border-dashed border-border px-3 py-2">
        <p className="font-mono text-[10px] text-muted-foreground">{MEDIATION}</p>
      </div>
    </Room>
  );
}

function JudgeRoom() {
  return (
    <Room>
      <p className="text-sm text-foreground/90">{passCount}/9 assertions green.</p>

      <ContractGroups groups={[{ asserts: CONTRACT }]} />

      <div className="rounded-lg bg-muted/20 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          A5 is running in the lab now; A6–A7 wait on the checkout gate and the nav
          landing; A9 waits on the runbook.
        </p>
      </div>
    </Room>
  );
}

// A thread the demo hasn't staffed with a full team view — honest stub.
function ThreadStub({ id }: { id: string }) {
  const t = THREADS.find((th) => th.id === id)!;
  const v = NODE_VISUAL[t.state];
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="max-w-sm space-y-2 rounded-xl border border-dashed border-border p-6 text-center">
        <div className="flex items-center justify-center gap-2">
          <StateIcon visual={v} className="size-4" />
          <span className="font-mono text-sm font-medium">{t.id}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t.activity}</p>
        <p className="font-mono text-[9px] text-muted-foreground/50">
          demo: only ui-client-nav is fully staffed — open it from Execute
        </p>
      </div>
    </div>
  );
}

export function LoomWalkableDemo() {
  const [act, setAct] = useState<Act>("execute");
  const [drill, setDrill] = useState<Drill>(null);
  const [showWindow, setShowWindow] = useState(false);
  const [showChats, setShowChats] = useState(false);

  const openSession = (id: "intake" | "steering") => {
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
          <span>{LOOM.project}</span>
          <span className="text-muted-foreground/40">/</span>
          <button
            type="button"
            onClick={() => setDrill(null)}
            className={cn(drill ? "hover:underline" : "text-foreground")}
          >
            {LOOM.id}
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
                {drill.id === "intake" ? "prepare / conversation" : "steering"}
              </span>
            </>
          )}
        </nav>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          started {LOOM.started} · {LOOM.spend} of {LOOM.budget} · {LOOM.subgoalsDone}/
          {LOOM.subgoalsTotal} subgoals
        </span>

        {/* loom verbs — park / kill, always in reach */}
        <LoomVerbs />

        {/* the WINDOW — always-on pull observability: the warm lane's live URL */}
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
            <AppWindowIcon className="size-3" /> window · :4310
          </button>
          {showWindow && (
            <div className="absolute right-0 top-9 z-20 w-80 space-y-2 rounded-xl border border-border bg-card p-3 shadow-md">
              <div className="flex aspect-video flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2">
                <div className="h-2 w-2/3 rounded-sm bg-muted-foreground/20" />
                <div className="h-2 w-1/2 rounded-sm bg-muted-foreground/15" />
                <div className="mt-auto flex gap-1.5">
                  <div className="h-5 flex-1 rounded-sm bg-muted-foreground/10" />
                  <div className="h-5 w-1/3 rounded-sm bg-muted-foreground/20" />
                </div>
              </div>
              <p className="font-mono text-[10px] text-foreground/85">
                {LAB_META.window.url} · warm lane
              </p>
              <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
                {LAB_META.window.note}
              </p>
              <div className="pt-0.5">
                <span className="cursor-default rounded-md border border-foreground/20 bg-foreground px-2.5 py-1 text-[11px] text-background">
                  Open in browser
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

        {/* every conversation this loom holds, one menu */}
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
            <MessagesSquareIcon className="size-3" /> chats · 2
          </button>
          {showChats && (
            <div className="absolute right-0 top-9 z-20 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-md">
              <button
                type="button"
                onClick={() => openSession("steering")}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
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
                  closed 07:24 · intake
                </span>
              </button>
            </div>
          )}
        </span>
      </header>

      <div className="flex shrink-0 items-end gap-6 border-b border-border px-6 pt-3">
        <ActTab
          label="Prepare"
          meta="locked 07:22"
          locked
          active={act === "prepare"}
          onClick={() => goRoom("prepare")}
        />
        <ActTab
          label="Execute"
          meta="2 live · 1 waiting"
          active={act === "execute"}
          onClick={() => goRoom("execute")}
        />
        <ActTab
          label="Judge"
          meta={`${passCount}/9 lit`}
          active={act === "judge"}
          onClick={() => goRoom("judge")}
        />
      </div>

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

      {drill?.kind === "thread" && drill.id === "ui-client-nav" ? (
        <ThreadBody />
      ) : drill?.kind === "thread" ? (
        <ThreadStub id={drill.id} />
      ) : drill?.kind === "orch" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OrchestratorBody />
        </div>
      ) : drill?.kind === "lab" ? (
        <LabRoom services={LAB_SERVICES} metaLines={[LAB_META.lease, LAB_META.carry]} />
      ) : drill?.kind === "session" ? (
        drill.id === "intake" ? (
          <IntakeSessionBody />
        ) : (
          <SteeringSessionBody turns={STEERING} />
        )
      ) : act === "prepare" ? (
        <PrepareRoom onOpenSession={() => setDrill({ kind: "session", id: "intake" })} />
      ) : act === "judge" ? (
        <JudgeRoom />
      ) : (
        <ExecuteRoom
          onThread={(id) => setDrill({ kind: "thread", id })}
          onOrch={() => setDrill({ kind: "orch" })}
        />
      )}
    </div>
  );
}
