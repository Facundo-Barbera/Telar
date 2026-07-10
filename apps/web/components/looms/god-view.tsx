"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import type { Loom, SubGoal } from "@telar/core";
import type {
  DecisionKind,
  DecisionLogEntry,
  GodView,
  Operator,
  Orchestrator,
  Step,
} from "./godview";
import { StatusBadge } from "./status";
import { AcceptancePanel, DoneConfirmation } from "./acceptance-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { fmtAgo, shortId } from "@/lib/format";

// The unified god-view frame for every non-scoping loom, re-skinned onto the
// app's native shadcn language (bg-card / muted-foreground / neutral badges —
// exactly like the session view): a charter card, an orchestrator card, THE
// WEAVE of operator cards, a right rail (the owner's intervention panel + the
// orchestrator log), and the moat. Layout is Tailwind + shadcn primitives; the
// only data source is deriveGodView (godview.ts). A single loom is a weave of
// one operator; a woven loom shows one card per child thread.

const PROOF_LABEL: Record<string, string> = {
  quickfix: "quickfix",
  "bmad-story": "bmad story",
  "verifier-criteria": "criteria",
  custom: "custom",
};

// ---------------------------------------------------------------------------
// Charter card — objective + a few chips + View spec / Revise.
// ---------------------------------------------------------------------------

function CharterStrip({ loom, onViewSpec }: { loom: Loom; onViewSpec: () => void }) {
  const charter = loom.charter;
  const objective = charter?.objective || loom.prompt || loom.title;

  const scopePaths = charter?.scope?.allowedPaths ?? [];
  const budget = charter?.budget;
  const budgetBits: string[] = [];
  if (budget?.maxCostUsd != null) budgetBits.push(`≤ $${budget.maxCostUsd}`);
  if (budget?.maxWallClockHours != null) budgetBits.push(`≤ ${budget.maxWallClockHours}h`);

  const hasChips = !!charter && (!!charter.proofStrategy || scopePaths.length > 0 || budgetBits.length > 0);

  // A 4KB objective must not swallow the page: keep it clamped to ~11 lines and
  // only offer the toggle once the collapsed text actually clips.
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const objectiveRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = objectiveRef.current;
    if (!el || expanded) return; // measure against the collapsed clamp only
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [objective, expanded]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Charter
          </span>
          {charter?.approvedBy && (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="size-3.5" />
              approved by {charter.approvedBy}
              {charter.version ? ` · v${charter.version}` : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onViewSpec}>
              View spec
              <ArrowUpRight />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="Charter revision — coming soon"
            >
              Revise
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <p
            ref={objectiveRef}
            className={cn(
              "text-sm leading-relaxed whitespace-pre-wrap text-foreground/90",
              expanded ? "max-h-[28rem] overflow-y-auto" : "max-h-[15rem] overflow-hidden",
            )}
          >
            {objective}
          </p>
          {overflows && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              className="h-auto self-start px-2 py-1 text-xs text-muted-foreground"
            >
              {expanded ? "Show less" : "Show more"}
              <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
            </Button>
          )}
        </div>

        {hasChips && (
          <div className="flex flex-wrap gap-1.5">
            {charter!.proofStrategy && (
              <Badge variant="secondary" className="font-normal">
                proof · {PROOF_LABEL[charter!.proofStrategy] ?? charter!.proofStrategy}
              </Badge>
            )}
            {scopePaths.length > 0 && (
              <Badge variant="secondary" className="max-w-full font-normal">
                <span className="truncate">scope · {scopePaths.slice(0, 2).join(" · ")}</span>
              </Badge>
            )}
            {budgetBits.length > 0 && (
              <Badge variant="secondary" className="font-normal">
                budget · {budgetBits.join(" · ")}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator card — the loop, the live tick, the concurrency governor.
// ---------------------------------------------------------------------------

const LOOP: Orchestrator["loopStage"][] = ["plan", "schedule", "observe", "decide"];

function OrchestratorBar({ orchestrator }: { orchestrator: Orchestrator }) {
  const { loopStage, tick, governor } = orchestrator;
  const { inFlight, max } = governor;
  const pct = max && max > 0 ? Math.min(100, (inFlight / max) * 100) : 0;

  // Truthful live count — never an invented denominator. "idle" when nothing is
  // in flight (a parked loom reads honestly); "N / max active" + a meter only
  // when the charter declared a real cap.
  const governorLabel =
    inFlight === 0
      ? "idle"
      : max != null
        ? `${inFlight} / ${max} active`
        : `${inFlight} agent${inFlight === 1 ? "" : "s"} active`;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Workflow className="size-4" />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium">Orchestrator</span>
              <span className="text-xs text-muted-foreground">
                weaver · fresh context · owns the loop
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs">
            {LOOP.map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    s === loopStage
                      ? "bg-foreground/10 font-medium text-foreground"
                      : "text-muted-foreground",
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

          <div className="ml-auto flex min-w-[130px] flex-col gap-1.5">
            <span
              className={cn(
                "text-xs tabular-nums",
                inFlight === 0 ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {governorLabel}
            </span>
            {max != null && <Progress value={pct} />}
          </div>
        </div>

        <Separator />

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              inFlight === 0 ? "bg-muted-foreground/40" : "bg-emerald-500",
            )}
          />
          <span>
            <span className="font-medium text-foreground/70">Tick:</span> {tick}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The weave — one operator card per thread.
// ---------------------------------------------------------------------------

type DepInfo = { hasDeps: boolean; waitsOn: string[] };

// Layout-only dependency derivation (godview.ts's Operator omits the graph):
// map each operator (= a child thread) to its subgoal's dependsOn, and list any
// dep whose thread hasn't reached "done" yet. Single looms have no threads, so
// no deps. Guarded against a missing charter / empty threads.
function deriveDeps(loom: Loom, threads: Loom[]): Map<string, DepInfo> {
  const out = new Map<string, DepInfo>();
  const decomposition: SubGoal[] = loom.charter?.decomposition ?? [];
  if (decomposition.length === 0 || threads.length === 0) return out;

  const bySubGoal = new Map<string, Loom>();
  for (const t of threads) if (t.subGoalId) bySubGoal.set(t.subGoalId, t);

  for (const t of threads) {
    const sg = decomposition.find((d) => d.id === t.subGoalId);
    const dependsOn = sg?.dependsOn ?? [];
    const waitsOn = dependsOn
      .filter((dep) => bySubGoal.get(dep)?.state !== "done")
      .map((dep) => {
        const depThread = bySubGoal.get(dep);
        const depSg = decomposition.find((d) => d.id === dep);
        return depThread ? shortId(depThread.id) : (depSg?.title ?? dep);
      });
    out.set(t.id, { hasDeps: dependsOn.length > 0, waitsOn });
  }
  return out;
}

function summarize(operators: Operator[]): string {
  const total = operators.length;
  const done = operators.filter((o) => o.status.kind === "done").length;
  const weaving = operators.filter((o) => o.active).length;
  const waiting = operators.filter((o) => o.status.kind === "wait").length;
  const needsYou = operators.filter((o) => o.status.kind === "block").length;
  const bits = [`${total} thread${total === 1 ? "" : "s"}`];
  if (done) bits.push(`${done} done`);
  if (weaving) bits.push(`${weaving} weaving`);
  if (waiting) bits.push(`${waiting} waiting`);
  if (needsYou) bits.push(`${needsYou} needs you`);
  return bits.join(" · ");
}

// One derived step as a calm chip — one quiet signal, not a highlighter.
// `fanCount` only decorates a live Build with its parallel-builder count.
function StageCell({ step, fanCount }: { step: Step; fanCount: number }) {
  const { state } = step;
  const label =
    step.name === "Build" && state === "active" && fanCount > 0
      ? `Build ×${fanCount}`
      : step.name;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px]",
        state === "failed"
          ? "text-destructive"
          : state === "active"
            ? "text-foreground"
            : state === "done"
              ? "text-muted-foreground"
              : "text-muted-foreground/60",
      )}
    >
      {state === "done" && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
      {state === "active" && <Loader2 className="size-3 animate-spin" />}
      {state === "failed" && <X className="size-3 text-destructive" />}
      {label}
    </span>
  );
}

function OperatorNote({ op, dep }: { op: Operator; dep: DepInfo | undefined }) {
  const kind = op.status.kind;

  // needs-review and blocked both wear the "block" pill but mean opposite
  // things: couldn't-prove vs. a real parked question. Keep the copy honest.
  if (kind === "block") {
    const isReview = op.state === "needs-review";
    const Icon = isReview ? Eye : CircleAlert;
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {isReview
            ? "Couldn't independently verify — no executable check ran. Review it and decide from the panel."
            : "Parked for a decision the orchestrator won't guess — answer it in the panel to resume; the weave keeps running around it."}
        </span>
      </p>
    );
  }
  if (kind === "repair" && op.repairs > 0) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span>
          Verify failed — the failing criterion + repro were handed back to the builder (attempt{" "}
          {op.repairs + 1}).
        </span>
      </p>
    );
  }
  if (kind === "wait" && dep?.waitsOn.length) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Clock className="mt-0.5 size-3.5 shrink-0" />
        <span>Waits on {dep.waitsOn.join(", ")} — scheduled the moment they pass.</span>
      </p>
    );
  }
  if (kind === "done") {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>Verified against its story and promoted.</span>
      </p>
    );
  }
  return null;
}

function OperatorCard({
  op,
  dep,
  onOpen,
}: {
  op: Operator;
  dep: DepInfo | undefined;
  onOpen: (id: string) => void;
}) {
  const kind = op.status.kind;
  const fanCount = op.subAgents.length;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onOpen(op.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(op.id);
        }
      }}
      className={cn(
        "cursor-pointer transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        dep?.hasDeps && "border-l-2 border-l-border",
      )}
    >
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{op.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{shortId(op.id)}</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-0.5 text-xs text-muted-foreground sm:flex">
              open agent
              <ChevronRight className="size-3" />
            </span>
            <StatusBadge kind={kind} state={op.state} active={op.active} label={op.status.label} />
          </div>
        </div>

        {op.steps.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {op.steps.map((s, i) => (
              <span key={`${s.name}-${i}`} className="flex items-center gap-1">
                <StageCell step={s} fanCount={fanCount} />
                {i < op.steps.length - 1 && (
                  <ChevronRight className="size-3 text-muted-foreground/40" />
                )}
              </span>
            ))}
          </div>
        )}

        {fanCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Fanned out</span>
            <ChevronRight className="size-3" />
            {op.subAgents.map((s) => (
              <Badge key={s.id} variant="outline" className="gap-1 font-normal">
                {s.done ? (
                  <Check className="text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Loader2 className="animate-spin" />
                )}
                {s.name}
              </Badge>
            ))}
          </div>
        )}

        <OperatorNote op={op} dep={dep} />
      </CardContent>
    </Card>
  );
}

function Weave({
  operators,
  loom,
  threads,
  onOpenOperator,
}: {
  operators: Operator[];
  loom: Loom;
  threads: Loom[];
  onOpenOperator: (id: string) => void;
}) {
  const deps = useMemo(() => deriveDeps(loom, threads), [loom, threads]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">The weave</span>
          <span className="text-xs text-muted-foreground/60">{summarize(operators)}</span>
        </div>
        <Separator />
        <p className="text-xs text-muted-foreground/70">
          Operators the orchestrator is weaving — select one to open its agent view.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {operators.length === 0 ? (
          <p className="text-xs text-muted-foreground">No operators weaving yet.</p>
        ) : (
          operators.map((op) => (
            <OperatorCard key={op.id} op={op} dep={deps.get(op.id)} onOpen={onOpenOperator} />
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Right rail — the owner's intervention panel + the orchestrator log.
// ---------------------------------------------------------------------------

const LOG_ICON: Record<DecisionKind, { Icon: typeof Check; className: string }> = {
  ok: { Icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { Icon: CircleX, className: "text-destructive" },
  block: { Icon: CircleAlert, className: "text-amber-600 dark:text-amber-400" },
  plan: { Icon: Workflow, className: "text-muted-foreground" },
  info: { Icon: ChevronRight, className: "text-muted-foreground" },
};

function LogRow({ e }: { e: DecisionLogEntry }) {
  const { Icon, className } = LOG_ICON[e.kind];
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} />
      <span className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground/80">{e.title}</span>
        {e.detail ? ` ${e.detail}` : ""}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/60">{fmtAgo(e.ts)}</span>
    </li>
  );
}

// MOAT INTEGRITY (woven root): the weave can't be signed off while any child
// Thread is still unresolved (working or awaiting the owner). This note names
// what's left and points the owner at the child cards below, which open each
// Thread's drawer where it can be resolved. It renders only when there IS
// something unresolved — so its presence is exactly the reason the root
// override-Accept is suppressed.
function WovenAcceptanceGate({ unresolved }: { unresolved: Loom[] }) {
  // "awaiting you" is ONLY the states the owner can actually resolve from a
  // Thread's drawer panel (AcceptancePanel gates on exactly these). `halted` is
  // deliberately excluded: it's a stopped/dead-ended Thread with no panel action
  // and core resumeLoom/rejectLoom reject it — so it must not be sold as
  // actionable. It's reported separately as "stopped" so the count stays honest
  // (it's still why the root can't be accepted) without overpromising a move.
  const needsYou = unresolved.filter(
    (t) => t.state === "needs-review" || t.state === "blocked" || t.state === "failed",
  ).length;
  const halted = unresolved.filter((t) => t.state === "halted").length;
  const weaving = unresolved.length - needsYou - halted;

  const parts: ReactNode[] = [];
  if (needsYou > 0)
    parts.push(
      <span key="needs" className="font-medium text-foreground/80">
        {needsYou} Thread{needsYou === 1 ? "" : "s"} awaiting you
      </span>,
    );
  if (weaving > 0)
    parts.push(
      <span key="weaving">
        {weaving} Thread{weaving === 1 ? "" : "s"} still weaving
      </span>,
    );
  if (halted > 0)
    parts.push(
      <span key="halted">
        {halted} Thread{halted === 1 ? "" : "s"} stopped
      </span>,
    );

  return (
    <Card className="border-l-2 border-l-amber-500/60 bg-amber-500/[0.04]">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
            The weave can&apos;t be accepted yet
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {parts.map((node, i) => (
            <span key={i}>
              {i > 0 ? ", " : ""}
              {node}
            </span>
          ))}
          {parts.length > 0 ? ". " : ""}
          Open each flagged Thread in the weave below to resolve it — the root
          becomes acceptable only once every Thread lands. Accepting here can
          never blanket-override an unresolved Thread.
        </p>
      </CardContent>
    </Card>
  );
}

function RightRail({
  log,
  loom,
  threads,
  woven,
  acceptedBy,
  onIntervened,
}: {
  log: DecisionLogEntry[];
  loom: Loom;
  threads: Loom[];
  woven: boolean;
  acceptedBy?: string;
  onIntervened?: (loom: Loom) => void;
}) {
  // godview.ts derives the log oldest-to-newest; the rail shows newest first so
  // the latest move is visible without scrolling.
  const entries = useMemo(() => [...log].reverse(), [log]);
  const sessionId = loom.charter?.scopingSessionId;

  // A woven root's unresolved children: anything not settled-good (done/ready/
  // skipped). While any remain, the root override-Accept is suppressed and the
  // gate note explains why. A single loom has no threads — always empty.
  const unresolved = useMemo(
    () =>
      woven
        ? threads.filter(
            (t) => t.state !== "done" && t.state !== "ready" && t.state !== "skipped",
          )
        : [],
    [woven, threads],
  );

  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
      {/* Primary panel: the owner's move. Both self-gate by loom.state, so
          mounting them unconditionally is safe — AcceptancePanel renders for
          ready/needs-review/blocked/failed, DoneConfirmation only for done.
          `allowAccept` is false while a woven root has unresolved Threads, so
          the override-Accept can't blanket-promote the weave; steer/reject/
          resume stay, and the gate note above says what's outstanding. */}
      {unresolved.length > 0 && <WovenAcceptanceGate unresolved={unresolved} />}
      <AcceptancePanel
        loom={loom}
        onAccepted={onIntervened}
        allowAccept={unresolved.length === 0}
      />
      <DoneConfirmation loom={loom} by={acceptedBy} />

      <Card>
        <CardContent className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Orchestrator log</span>
            <span className="ml-auto text-[10px] text-muted-foreground/60">weaver</span>
          </div>
          <Separator />
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No decisions yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((e, i) => (
                <LogRow key={`${e.ts}-${i}`} e={e} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {sessionId && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <MessageSquare className="size-3.5 shrink-0" />
          Launched from session {shortId(sessionId)}
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The moat.
// ---------------------------------------------------------------------------

function Moat() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>
        <span className="font-medium text-foreground/80">
          The weave can&apos;t come off the loom on its own.
        </span>{" "}
        Promotion to done needs a passing{" "}
        <span className="font-medium text-foreground/80">independent</span> verify — no thread, the
        orchestrator, or a chat marks itself done.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The unified frame.
// ---------------------------------------------------------------------------

export function LoomGodView({
  view,
  loom,
  threads,
  onOpenOperator,
  onViewSpec,
  onIntervened,
  acceptedBy,
}: {
  view: GodView;
  loom: Loom;
  threads: Loom[];
  onOpenOperator: (id: string) => void;
  onViewSpec: () => void;
  // Propagates a re-dispatched loom up after an accept/steer/reject so the page
  // reflects the new state immediately (it also polls, but this is instant).
  onIntervened?: (loom: Loom) => void;
  acceptedBy?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4">
      {/* One two-column workspace: the orchestrator + weave flow on the left,
          a persistent rail (intervention / done + log) on the right spanning
          the whole height — not a stack of full-width cards. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <CharterStrip loom={loom} onViewSpec={onViewSpec} />
          <OrchestratorBar orchestrator={view.orchestrator} />
          <Weave
            operators={view.operators}
            loom={loom}
            threads={threads}
            onOpenOperator={onOpenOperator}
          />
        </div>
        <RightRail
          log={view.decisionLog}
          loom={loom}
          threads={threads}
          woven={view.woven}
          acceptedBy={acceptedBy}
          onIntervened={onIntervened}
        />
      </div>

      <Moat />
    </div>
  );
}
