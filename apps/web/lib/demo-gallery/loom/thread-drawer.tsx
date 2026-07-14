"use client";

// LANE: loom — CONCERN 6.1 (the round's single most important item).
// Replaces the single-level agent-view Sheet with a 2–3 LEVEL thread drawer:
//   L1 overview  → status, glance stats, mediation summary, agent roster
//   L2 anatomy   → full step timeline, gate results, the mediation ladder
//   L2 agent     → one lane's steps + identity, gateway to its transcript
//   L3 transcript→ full agent turns + collapsible tool calls (session-style)
// Breadcrumb between levels, Esc backs out one level (closes at root), and a
// copyable deep-link chip gives the wayfinding a deep-linkable feel. Fully
// interactive against the lane's fixture threads + real transcripts.
import { useCallback, useEffect, useRef, useState } from "react";
import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock,
  Command,
  DollarSign,
  Eye,
  FlaskConical,
  Layers,
  ListTree,
  Play,
  RotateCcw,
  Timer,
  Users,
  X,
} from "lucide-react";
import { StatusBadge } from "@/components/looms/status";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  DEMO_THREADS,
  WEAVE_OBJECTIVE,
  WEAVE_PROJECT,
  WEAVE_TITLE,
  threadById,
  type DemoAgent,
  type DemoThread,
} from "./fixtures";
import {
  AgentRow,
  DeepLinkChip,
  FilesTouched,
  GateRow,
  MediationLadder,
  NowLine,
  SectionLabel,
  StatTile,
  StepTimeline,
  TranscriptView,
} from "./ui";

// ---------------------------------------------------------------------------
// Navigation stack — each pushed frame is a breadcrumb crumb; Esc pops.
// ---------------------------------------------------------------------------

type Frame =
  | { kind: "overview" }
  | { kind: "anatomy" }
  | { kind: "agent"; agentId: string }
  | { kind: "transcript"; agentId: string };

const LEVEL: Record<Frame["kind"], 1 | 2 | 3> = {
  overview: 1,
  anatomy: 2,
  agent: 2,
  transcript: 3,
};

function crumbLabel(frame: Frame, thread: DemoThread): string {
  switch (frame.kind) {
    case "overview":
      return thread.subGoalId;
    case "anatomy":
      return "anatomy";
    case "agent":
      return thread.agents.find((a) => a.id === frame.agentId)?.label ?? "agent";
    case "transcript":
      return "transcript";
  }
}

function agentOf(thread: DemoThread, id: string): DemoAgent | undefined {
  return thread.agents.find((a) => a.id === id);
}

// The synthetic deep link the breadcrumb reflects — makes level state feel
// addressable even though the demo never touches the router.
function deepLink(thread: DemoThread, stack: Frame[]): string {
  const tail = stack
    .slice(1)
    .map((f) =>
      f.kind === "agent" || f.kind === "transcript" ? `${f.kind}:${f.agentId}` : f.kind,
    )
    .join("/");
  return `${WEAVE_PROJECT}/loom/${thread.id}${tail ? "#" + tail : ""}`;
}

// ---------------------------------------------------------------------------
// Level bodies.
// ---------------------------------------------------------------------------

function ReasonBanner({ thread }: { thread: DemoThread }) {
  if (thread.state !== "failed" && thread.state !== "needs-review") return null;
  const isReview = thread.state === "needs-review";
  const Icon = isReview ? Eye : CircleX;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-3 py-2.5",
        isReview
          ? "border-amber-500/40 bg-amber-500/[0.05]"
          : "border-destructive/40 bg-destructive/[0.05]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            isReview ? "text-amber-600 dark:text-amber-400" : "text-destructive",
          )}
        />
        <span
          className={cn(
            "text-xs font-medium tracking-wide uppercase",
            isReview ? "text-amber-600 dark:text-amber-400" : "text-destructive",
          )}
        >
          {isReview ? "Why it can't be verified" : "Failure reason"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground/80">{thread.now}</p>
    </div>
  );
}

function Overview({ thread, go }: { thread: DemoThread; go: (f: Frame) => void }) {
  const stepsDone = thread.steps.filter((s) => s.state === "done").length;
  const gatesOk = thread.gates.filter((g) => g.ok === true).length;
  const gatesRan = thread.gates.filter((g) => g.ok !== null).length;
  const nowIcon =
    thread.statusKind === "block"
      ? thread.state === "needs-review"
        ? Eye
        : CircleAlert
      : thread.statusKind === "repair"
        ? RotateCcw
        : thread.statusKind === "verify"
          ? FlaskConical
          : Play;

  return (
    <div className="flex flex-col gap-4">
      <ReasonBanner thread={thread} />

      <NowLine icon={nowIcon}>{thread.now}</NowLine>

      {thread.summary && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Summary</SectionLabel>
          <p className="text-sm leading-relaxed text-foreground/90">{thread.summary}</p>
        </div>
      )}

      {/* Glance stats — every tile drills into the L2 anatomy. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Steps"
          value={`${stepsDone}/${thread.steps.length}`}
          tone="active"
          sub="done"
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile
          label="Gates"
          value={`${gatesOk}/${thread.gates.length}`}
          tone={gatesRan < thread.gates.length ? "active" : gatesOk === thread.gates.length ? "ok" : "danger"}
          sub={gatesRan < thread.gates.length ? "running" : "green"}
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile
          label="Repairs"
          value={thread.mediation.length}
          tone={thread.mediation.length === 0 ? "muted" : thread.state === "failed" || thread.state === "needs-review" ? "danger" : "warn"}
          sub={thread.mediation.length === 0 ? "clean" : "ladder"}
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile label="Agents" value={thread.agents.length} tone="muted" sub="lanes" onClick={() => go({ kind: "anatomy" })} />
      </div>

      {/* Mediation summary — the escalation chain, condensed, with a drill-in. */}
      {thread.mediation.length > 0 && (
        <button
          type="button"
          onClick={() => go({ kind: "anatomy" })}
          className="group flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
          <div className="flex items-center gap-2">
            <ListTree className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Mediation ladder</span>
            <span className="text-[11px] text-muted-foreground/70">
              {thread.mediation.length} rung{thread.mediation.length === 1 ? "" : "s"}
            </span>
            <span className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground/60 group-hover:text-primary">
              open <ChevronRight className="size-3" />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {thread.mediation.map((r, i) => (
              <React.Fragment key={r.n}>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px]",
                    r.level === "human"
                      ? "bg-destructive/10 text-destructive"
                      : r.level === "orchestrator"
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {r.level === "human" ? "you" : r.level === "orchestrator" ? "orchestrator" : "thread"}
                </span>
                {i < thread.mediation.length - 1 && (
                  <ChevronRight className="size-3 text-muted-foreground/40" />
                )}
              </React.Fragment>
            ))}
          </div>
        </button>
      )}

      {/* Agent roster — each opens its focused L2 lane. */}
      <div className="flex flex-col gap-2">
        <SectionLabel>
          <Users className="size-3.5" />
          Agents · {thread.agents.length}
          <span className="font-normal text-muted-foreground/60">— select a lane</span>
        </SectionLabel>
        <div className="flex flex-col gap-1.5">
          {thread.agents.map((a) => (
            <AgentRow key={a.id} agent={a} cta="open" onOpen={() => go({ kind: "agent", agentId: a.id })} />
          ))}
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground/70">
        <FlaskConical className="mt-0.5 size-3 shrink-0" />
        {thread.verifyNote}
      </p>
    </div>
  );
}

function Anatomy({ thread, go }: { thread: DemoThread; go: (f: Frame) => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <SectionLabel>
          <ListTree className="size-3.5" />
          Steps — what the operator actually did
        </SectionLabel>
        <StepTimeline steps={thread.steps} />
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <SectionLabel>
          <Command className="size-3.5" />
          Deterministic gates
        </SectionLabel>
        {thread.gates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No gates ran on this thread.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {thread.gates.map((g) => (
              <GateRow key={g.name} gate={g} />
            ))}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-2.5">
        <SectionLabel>
          <RotateCcw className="size-3.5" />
          Mediation ladder — who repaired what before escalating
        </SectionLabel>
        <MediationLadder rungs={thread.mediation} />
      </div>

      {thread.files.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>Files touched</SectionLabel>
            <FilesTouched files={thread.files} />
          </div>
        </>
      )}

      <Separator />

      <div className="flex flex-col gap-2">
        <SectionLabel>
          <Users className="size-3.5" />
          Agents — open a transcript
        </SectionLabel>
        <div className="flex flex-col gap-1.5">
          {thread.agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              cta="transcript"
              onOpen={() => go({ kind: "transcript", agentId: a.id })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentIdentity({ agent }: { agent: DemoAgent }) {
  const isCritic = agent.role === "critic";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-medium">
        {isCritic ? <FlaskConical className="size-3" /> : <Play className="size-3" />}
        {isCritic ? "critic" : "builder"}
      </span>
      {agent.lens && <span className="font-mono text-[11px] text-muted-foreground">{agent.lens}</span>}
      {agent.blocker != null && (
        <Badge variant={agent.blocker ? "destructive" : "secondary"} className="text-[10px]">
          {agent.blocker ? "must-clear" : "advisory"}
        </Badge>
      )}
      {agent.sessionId && (
        <span className="font-mono text-[11px] text-muted-foreground">session {agent.sessionId.slice(-6)}</span>
      )}
    </div>
  );
}

function AgentDetail({
  thread,
  agentId,
  go,
}: {
  thread: DemoThread;
  agentId: string;
  go: (f: Frame) => void;
}) {
  const agent = agentOf(thread, agentId);
  if (!agent) return null;
  return (
    <div className="flex flex-col gap-4">
      <AgentIdentity agent={agent} />
      <NowLine icon={agent.role === "critic" ? FlaskConical : Play}>{agent.now}</NowLine>

      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Model" value={<span className="text-sm">{agent.model ?? "—"}</span>} tone="muted" />
        <StatTile label="Turns" value={agent.turns ?? "—"} tone="muted" />
        <StatTile label="Cost" value={agent.costUsd != null ? `$${agent.costUsd.toFixed(2)}` : "—"} tone="muted" />
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionLabel>
          <ListTree className="size-3.5" />
          Lane steps
        </SectionLabel>
        <StepTimeline steps={agent.steps} dense />
      </div>

      <button
        type="button"
        onClick={() => go({ kind: "transcript", agentId })}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-muted/60"
      >
        <ListTree className="size-4" />
        Open full transcript
        <ChevronRight className="size-4" />
      </button>

      {agent.account && (
        <p className="text-[11px] text-muted-foreground/70">
          {agent.role === "critic"
            ? `read-only critic · ${agent.account} · no Write / Edit / Bash`
            : agent.account}
        </p>
      )}
    </div>
  );
}

function TranscriptFrame({ thread, agentId }: { thread: DemoThread; agentId: string }) {
  const agent = agentOf(thread, agentId);
  if (!agent) return null;
  return (
    <div className="flex flex-col gap-4">
      <AgentIdentity agent={agent} />
      <p className="text-[11px] text-muted-foreground/70">
        {agent.role === "critic"
          ? "read-only critic · different account · no Write / Edit / Bash"
          : "builder · Write · Edit · Bash · resumable session"}
      </p>
      <Separator />
      <TranscriptView entries={agent.transcript} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer shell.
// ---------------------------------------------------------------------------

function Drawer({
  thread,
  onClose,
}: {
  thread: DemoThread | null;
  onClose: () => void;
}) {
  const open = thread !== null;
  const cache = useRef<DemoThread | null>(thread);
  if (thread) cache.current = thread;
  const t = thread ?? cache.current;

  const [stack, setStack] = useState<Frame[]>([{ kind: "overview" }]);

  // Reset to L1 whenever a different thread opens.
  const openId = thread?.id;
  useEffect(() => {
    if (openId) setStack([{ kind: "overview" }]);
  }, [openId]);

  const go = useCallback((f: Frame) => setStack((s) => [...s, f]), []);
  const pop = useCallback(() => {
    setStack((s) => {
      if (s.length <= 1) {
        onClose();
        return s;
      }
      return s.slice(0, -1);
    });
  }, [onClose]);
  const truncate = useCallback((i: number) => setStack((s) => s.slice(0, i + 1)), []);

  // Esc backs out one level (closes at root). Does not collide with the stage
  // pager (which listens for j/k only).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        pop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pop]);

  const top = stack[stack.length - 1];

  return (
    <>
      {/* backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {/* panel */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl transition-transform duration-300",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {t && (
          <>
            {/* header: identity + status + close */}
            <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{t.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t.subGoalId}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] text-muted-foreground/60">
                    <span className="flex items-center gap-1">
                      <DollarSign className="size-3" />
                      {t.costUsd.toFixed(2)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Timer className="size-3" />
                      {t.elapsed}
                    </span>
                  </div>
                </div>
                <StatusBadge kind={t.statusKind} state={t.state} active={t.active} label={t.statusLabel} />
                <button
                  type="button"
                  onClick={onClose}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Close drawer"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* breadcrumb + level pips + deep link */}
              <div className="flex items-center gap-1.5">
                {stack.length > 1 && (
                  <button
                    type="button"
                    onClick={pop}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Back one level"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                )}
                <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                  {stack.map((f, i) => {
                    const isLast = i === stack.length - 1;
                    return (
                      <React.Fragment key={i}>
                        <button
                          type="button"
                          disabled={isLast}
                          onClick={() => truncate(i)}
                          className={cn(
                            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
                            isLast
                              ? "font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <span className="rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
                            L{LEVEL[f.kind]}
                          </span>
                          <span className="max-w-[140px] truncate">{crumbLabel(f, t)}</span>
                        </button>
                        {!isLast && <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />}
                      </React.Fragment>
                    );
                  })}
                </nav>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Layers className="size-3 shrink-0" />
                <DeepLinkChip path={deepLink(t, stack)} />
                <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
                  <kbd className="rounded border border-border bg-muted px-1 font-mono">esc</kbd>
                  back
                </span>
              </div>
            </div>

            {/* body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {top.kind === "overview" && <Overview thread={t} go={go} />}
              {top.kind === "anatomy" && <Anatomy thread={t} go={go} />}
              {top.kind === "agent" && <AgentDetail thread={t} agentId={top.agentId} go={go} />}
              {top.kind === "transcript" && <TranscriptFrame thread={t} agentId={top.agentId} />}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Outer surface — the weave, one card per thread; click to open the drawer.
// ---------------------------------------------------------------------------

function ThreadCard({ thread, onOpen }: { thread: DemoThread; onOpen: () => void }) {
  const gatesOk = thread.gates.filter((g) => g.ok === true).length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{thread.title}</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">{thread.subGoalId}</span>
        </div>
        <StatusBadge kind={thread.statusKind} state={thread.state} active={thread.active} label={thread.statusLabel} />
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{thread.now}</p>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
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
            {thread.mediation.length} repair{thread.mediation.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="rounded bg-muted px-1.5 py-0.5">{thread.agents.length} agents</span>
        <span className="rounded bg-muted px-1.5 py-0.5">${thread.costUsd.toFixed(2)}</span>
        <span className="ml-auto flex items-center gap-0.5 text-muted-foreground/50 group-hover:text-primary">
          open <ChevronRight className="size-3" />
        </span>
      </div>
    </button>
  );
}

export function ThreadDrawerDemo() {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? threadById(openId) ?? null : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-5 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{WEAVE_TITLE}</h1>
          <span className="font-mono text-xs text-muted-foreground/60">{WEAVE_PROJECT}</span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{WEAVE_OBJECTIVE}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <Clock className="size-3.5" />
          Open any thread to walk its 2–3 level drawer — overview → anatomy / agent → transcript. Try the
          escalated <span className="font-medium text-foreground/80">Saved filters</span> thread for the full
          mediation ladder.
        </p>
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {DEMO_THREADS.map((t) => (
          <ThreadCard key={t.id} thread={t} onOpen={() => setOpenId(t.id)} />
        ))}
      </div>

      <Drawer thread={open} onClose={() => setOpenId(null)} />
    </div>
  );
}
