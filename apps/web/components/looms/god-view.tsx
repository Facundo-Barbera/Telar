"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Boxes,
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
  type LucideIcon,
} from "lucide-react";
import type { CriticFinding, CriticVerdict, GateResult, Loom, SubGoal } from "@telar/core";
import type {
  AssertionOutcome,
  DecisionKind,
  DecisionLogEntry,
  GodView,
  Operator,
  Orchestrator,
  Plan,
  PlanNode,
  PlanNodeState,
  RationaleView,
  RepairOutcome,
  RepairRoundView,
  RepairView,
  Step,
  VerifyReport,
  VerifyStep,
  VerifyView,
} from "./godview";
import { StatusBadge } from "./status";
import { AcceptancePanel, DoneConfirmation } from "./acceptance-panel";
import {
  EvidenceImage,
  screenshots,
  textEvidence,
  VerifierReportCard,
} from "./verifier-report-card";
import { AssertionRow, useSpecBundle } from "./spec-bundle";
import { fmtDuration } from "./utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatTab } from "@/components/looms/chat-tab";
import { ConsolidationBranch } from "@/components/looms/consolidation-branch";
import { cn } from "@/lib/utils";
import { fmtAgo, fmtCost, shortId } from "@/lib/format";

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

// The orchestrator is the centerpiece: ONE card that stacks the live loop +
// governor (LoopGovernor), the plan-as-living-map (PlanGraph), and the
// click-to-explain decision timeline (DecisionTimeline).
function OrchestratorPanel({
  orchestrator,
  log,
}: {
  orchestrator: Orchestrator;
  log: DecisionLogEntry[];
}) {
  const hasPlan = orchestrator.plan.nodes.length > 0;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <LoopGovernor orchestrator={orchestrator} />
        {hasPlan && (
          <>
            <Separator />
            <PlanGraph plan={orchestrator.plan} />
          </>
        )}
        <Separator />
        <DecisionTimeline log={log} />
      </CardContent>
    </Card>
  );
}

// The panel header: identity + the plan→schedule→observe→decide loop, the
// concurrency governor, and the live tick. (Formerly OrchestratorBar's body,
// verbatim — it no longer owns a Card; OrchestratorPanel does.)
function LoopGovernor({ orchestrator }: { orchestrator: Orchestrator }) {
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
    <div className="flex flex-col gap-3">
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
    </div>
  );
}

// The plan as a living map: one row per subgoal, its dot colored by live state
// (pulsing while active), deps named, and the weaver's shaping rationale.
const ACTIVE_PLAN_STATES: readonly PlanNodeState[] = ["preparing", "running", "verifying"];
const isActivePlanState = (s: PlanNodeState) => ACTIVE_PLAN_STATES.includes(s);

// State → dot color, within the file's semantics (emerald=done, amber=needs-you,
// destructive=failed, muted=idle/skipped, foreground=active-neutral).
const PLAN_DOT: Record<PlanNodeState, string> = {
  done: "bg-emerald-500",
  ready: "bg-amber-500",
  "needs-review": "bg-amber-500",
  blocked: "bg-amber-500",
  preparing: "bg-foreground",
  running: "bg-foreground",
  verifying: "bg-foreground",
  failed: "bg-destructive",
  halted: "bg-destructive",
  skipped: "bg-muted-foreground/30",
  pending: "bg-muted-foreground/30",
  queued: "bg-muted-foreground/30",
  scoping: "bg-muted-foreground/30",
  "charter-review": "bg-muted-foreground/30",
};

function planStateLabel(s: PlanNodeState): string {
  switch (s) {
    case "pending":
      return "pending";
    case "running":
    case "preparing":
      return "building";
    case "verifying":
      return "verifying";
    case "ready":
      return "awaiting you";
    case "done":
      return "done";
    case "needs-review":
      return "needs review";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "halted":
      return "halted";
    case "skipped":
      return "skipped";
    default:
      return String(s);
  }
}

function PlanNodeRow({ node }: { node: PlanNode }) {
  const active = isActivePlanState(node.state);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            PLAN_DOT[node.state] ?? "bg-muted-foreground/30",
            active && "animate-pulse",
          )}
        />
        <span className="truncate text-sm text-foreground/90">{node.title}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{node.id}</span>
        {!node.required && (
          <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal">
            optional
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {planStateLabel(node.state)}
        </span>
      </div>
      {node.dependsOn.length > 0 && (
        <span className="pl-4 text-[11px] text-muted-foreground">
          waits on {node.dependsOn.join(", ")}
        </span>
      )}
    </li>
  );
}

function PlanGraph({ plan }: { plan: Plan }) {
  if (plan.nodes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Plan</span>
        <span className="text-xs text-muted-foreground/60">
          {plan.singleThread ? "weave of one" : `${plan.nodes.length} subgoals`}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {plan.nodes.map((n) => (
          <PlanNodeRow key={n.id} node={n} />
        ))}
      </ul>
      {plan.rationale && (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          {plan.singleThread ? plan.rationale : `Why this shape: ${plan.rationale}`}
        </p>
      )}
    </div>
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
  observe: { Icon: Eye, className: "text-muted-foreground" },
};

// The decision timeline — the orchestrator's moves, newest first, each row
// click-to-explain when it carries a rationale.
function DecisionTimeline({ log }: { log: DecisionLogEntry[] }) {
  // godview.ts derives the log oldest-to-newest; show newest first so the
  // latest move is visible without scrolling.
  const entries = useMemo(() => [...log].reverse(), [log]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Decisions</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          newest first · click to explain
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No decisions yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e, i) => (
            <DecisionRow key={`${e.ts}-${i}`} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionRow({ e }: { e: DecisionLogEntry }) {
  const [open, setOpen] = useState(false);
  const { Icon, className } = LOG_ICON[e.kind];
  const hasDetail =
    !!e.rationale &&
    ((e.rationale.ranked?.length ?? 0) > 0 ||
      !!e.rationale.fanout ||
      !!e.rationale.budget ||
      !!e.rationale.rejected);

  const body = (
    <div className="flex items-start gap-2">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} />
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{e.title}</span>
        {e.detail ? ` ${e.detail}` : ""}
      </span>
      {hasDetail && (
        <ChevronDown
          className={cn("mt-0.5 size-3 text-muted-foreground/50", open && "rotate-180")}
        />
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground/60">{fmtAgo(e.ts)}</span>
    </div>
  );

  if (!hasDetail) return <li>{body}</li>;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {body}
      </button>
      {open && <RationaleDetail r={e.rationale!} />}
    </li>
  );
}

// HONEST-DATA HELPERS: Infinity serializes to null over JSON/SSE, and
// isFinite(null) === true — so guard on both typeof and isFinite, and tolerate
// the runtime null the TS types don't admit. Never render "null"/"Infinity".
function fmtCap(n: number | null | undefined): string {
  return typeof n === "number" && isFinite(n) ? String(n) : "∞";
}
function fmtBudgetLeft(v: number | null | undefined): string {
  return typeof v === "number" && isFinite(v) ? fmtCost(v) : "uncapped";
}
function fmtWallClock(ms: number | null | undefined): string | null {
  if (typeof ms !== "number") return null;
  if (ms <= 0) return "0s left";
  return `${fmtDuration(ms)} left`;
}

const BINDING_EXPLANATION: Record<string, string> = {
  pieces: "all ready pieces fit the pool + budget",
  pool: "the agent pool was the binding limit",
  budget: "the cost budget was the binding limit",
  "pool-exhausted": "the pool was full — nothing could start",
};

// The WHY behind a decision, indented under its row.
function RationaleDetail({ r }: { r: RationaleView }) {
  const wall = r.budget ? fmtWallClock(r.budget.wallClockRemainingMs) : null;
  return (
    <div className="mt-1.5 flex flex-col gap-2 border-l-2 border-border pl-3 text-[11px] text-muted-foreground">
      {r.ranked && r.ranked.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground/70">Priority (critical-path first)</span>
          <div className="flex flex-wrap gap-1">
            {r.ranked.map((x, i) => (
              <span
                key={x.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono",
                  i === 0 && "text-foreground",
                )}
              >
                {x.id} · unblocks {x.score}
              </span>
            ))}
          </div>
        </div>
      )}

      {r.fanout && (
        <p>
          <span className="font-medium text-foreground/70">Fan-out:</span> scheduled{" "}
          {r.fanout.chosen} of {r.fanout.pieces} ready —{" "}
          {BINDING_EXPLANATION[r.fanout.binding] ?? String(r.fanout.binding)}.{" "}
          <span className="text-muted-foreground/60">
            (pool room {fmtCap(r.fanout.capByPool)}, budget room {fmtCap(r.fanout.capByBudget)})
          </span>
        </p>
      )}

      {r.budget && (
        <p className="flex flex-wrap gap-x-1 tabular-nums">
          <span className="font-medium text-foreground/70">Budget:</span>
          <span>
            {fmtCost(r.budget.spentUsd)} spent · {r.budget.inFlight} in flight ·{" "}
            {fmtBudgetLeft(r.budget.budgetLeftUsd)} left{wall ? ` · ${wall}` : ""}
          </span>
        </p>
      )}

      {r.rejected && (
        <p className="flex items-start gap-1 text-amber-600 dark:text-amber-400">
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          <span>Proposed decision was rejected ({r.rejected}) → held instead.</span>
        </p>
      )}
    </div>
  );
}

// MOAT INTEGRITY (woven root): the weave can't be signed off while any child
// Thread is still unresolved (working or awaiting the owner). This note names
// what's left and points the owner at the child cards below, which open each
// Thread's drawer where it can be resolved. It renders only when there IS
// something unresolved — so its presence is exactly the reason the root
// override-Accept is suppressed.
function WovenAcceptanceGate({
  unresolved,
  onGoToThreads,
}: {
  unresolved: Loom[];
  onGoToThreads?: () => void;
}) {
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
          Open each flagged Thread in the Threads tab to resolve it — the root
          becomes acceptable only once every Thread lands. Accepting here can
          never blanket-override an unresolved Thread.
        </p>
        {onGoToThreads && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onGoToThreads}
            className="h-auto self-start px-2 py-1 text-xs"
          >
            Go to Threads
            <ChevronRight />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RightRail({
  loom,
  threads,
  woven,
  acceptedBy,
  onIntervened,
  onGoToThreads,
}: {
  loom: Loom;
  threads: Loom[];
  woven: boolean;
  acceptedBy?: string;
  onIntervened?: (loom: Loom) => void;
  onGoToThreads?: () => void;
}) {
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
      {unresolved.length > 0 && (
        <WovenAcceptanceGate unresolved={unresolved} onGoToThreads={onGoToThreads} />
      )}
      <AcceptancePanel
        loom={loom}
        onAccepted={onIntervened}
        allowAccept={unresolved.length === 0}
      />
      <DoneConfirmation loom={loom} by={acceptedBy} />

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
// A calm placeholder for tabs whose surface lands in a later phase.
// ---------------------------------------------------------------------------

function ComingSoon({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Card className="border-dashed bg-muted/20">
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon className="size-5 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <p className="max-w-sm text-xs leading-relaxed text-balance text-muted-foreground">
          {description}
        </p>
        <span className="mt-1 rounded-full bg-muted px-2 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
          coming soon
        </span>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Verify tab (M1) — the INDEPENDENT verdict surface. Renders the contract, the
// gate run, the critic panel (must-clear vs advisory, findings + evidence), the
// live verifier process, and the legacy report — for the root integration verify
// AND each Thread. Every state is honest: "not verified yet" and "no executable
// check ran" are first-class, never a fabricated pass or invented evidence.
// ---------------------------------------------------------------------------

const OUTCOME_BADGE: Record<
  AssertionOutcome,
  { label: string; className: string; Icon: LucideIcon }
> = {
  pass: {
    label: "passed",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  fail: {
    label: "failed",
    className: "bg-destructive/15 text-destructive",
    Icon: CircleX,
  },
  flaky: {
    label: "flaky",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    Icon: CircleAlert,
  },
  skip: {
    label: "no executable check ran",
    className: "bg-muted text-muted-foreground",
    Icon: CircleAlert,
  },
  pending: {
    label: "not verified yet",
    className: "bg-muted text-muted-foreground",
    Icon: Clock,
  },
};

function VerdictBadge({ verdict }: { verdict: AssertionOutcome }) {
  const b = OUTCOME_BADGE[verdict];
  return (
    <Badge className={cn("gap-1 font-mono text-[10px]", b.className)}>
      <b.Icon className="size-3" />
      {b.label}
    </Badge>
  );
}

const FINDING_SEVERITY: Record<CriticFinding["severity"], string> = {
  blocker: "bg-destructive/15 text-destructive",
  major: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  minor: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  nit: "bg-muted text-muted-foreground",
};

// A single critic finding — same fields as a DesignFinding minus `category`, so
// rendered with its own compact row (reusing EvidenceImage for screenshots).
function CriticFindingRow({ loomId, finding }: { loomId: string; finding: CriticFinding }) {
  const shots = screenshots(finding.evidence);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex items-start gap-2 text-sm">
        <Badge className={cn("mt-px shrink-0 font-mono text-[10px]", FINDING_SEVERITY[finding.severity])}>
          {finding.severity}
        </Badge>
        <span className="leading-snug font-medium">{finding.title}</span>
      </div>
      <p className="pl-1 text-xs text-muted-foreground">{finding.detail}</p>
      {finding.recommendation && (
        <p className="pl-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Fix:</span> {finding.recommendation}
        </p>
      )}
      {shots.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {shots.map((e, i) => (
            <EvidenceImage key={e.path ?? i} loomId={loomId} evidence={e} />
          ))}
        </div>
      )}
    </div>
  );
}

// One critic lens's verdict: pass/fail + must-clear/advisory + summary, its
// findings and evidence expandable. A blocker lens that DIDN'T clear reads red.
function CriticVerdictRow({ loomId, critic }: { loomId: string; critic: CriticVerdict }) {
  const [open, setOpen] = useState(false);
  const shots = screenshots(critic.evidence);
  const texts = textEvidence(critic.evidence);
  const hasDetail = critic.findings.length > 0 || shots.length > 0 || texts.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-1.5">
        {critic.ok ? (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="text-sm font-medium">{critic.lens}</span>
        <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
          {critic.class}
        </Badge>
        <Badge
          className={cn(
            "font-mono text-[10px]",
            critic.blocker
              ? "bg-destructive/15 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {critic.blocker ? "must clear" : "advisory"}
        </Badge>
      </div>
      {critic.summary && <p className="pl-1 text-xs text-muted-foreground">{critic.summary}</p>}

      {shots.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {shots.map((e, i) => (
            <EvidenceImage key={e.path ?? i} loomId={loomId} evidence={e} />
          ))}
        </div>
      )}

      {hasDetail && critic.findings.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            <span>
              {critic.findings.length} finding{critic.findings.length === 1 ? "" : "s"}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 pt-1">
            {critic.findings.map((f, i) => (
              <CriticFindingRow key={`${f.title}-${i}`} loomId={loomId} finding={f} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {texts.length > 0 && (
        <div className="flex flex-col gap-2">
          {texts.map((e, i) => (
            <div key={e.path ?? i} className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {e.kind}
                {e.label ? ` · ${e.label}` : ""}
              </span>
              <pre className="max-h-40 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
                {e.text ?? e.path}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GateRunRow({ gate }: { gate: GateResult }) {
  const [open, setOpen] = useState(false);
  const hasOutput = gate.output.trim().length > 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex items-center gap-2">
        {gate.ok ? (
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <X className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="font-mono text-xs">{gate.name}</span>
        <Badge
          className={cn(
            "font-mono text-[10px]",
            gate.ok
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {gate.timedOut ? "timed out" : gate.ok ? "pass" : "fail"}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
          {gate.exitCode != null ? `exit ${gate.exitCode}` : ""} · {fmtDuration(gate.durationMs)}
        </span>
      </div>
      {hasOutput && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            <span>Output</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            <pre className="max-h-56 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
              {gate.output}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// The live verifier/critic process — snapshot → act → observe, in the order it
// happened. Click any step to expand its input/output. Empty ⇒ not rendered.
function ProcessTimeline({ steps }: { steps: VerifyStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        Process timeline
        <span className="text-muted-foreground/60">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <ol className="flex flex-col gap-1 border-l-2 border-border pl-3">
          {steps.map((s, i) => (
            <ProcessStepRow key={i} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ProcessStepRow({ step }: { step: VerifyStep }) {
  if (step.k === "sized") {
    return (
      <li className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/70">panel sized →</span>
        {step.sized.length === 0 ? (
          <span>no lenses</span>
        ) : (
          step.sized.map((l) => (
            <Badge key={l.lens} variant="outline" className="font-mono text-[10px]">
              {l.lens}
              {l.blocker ? " ·must" : ""}
            </Badge>
          ))
        )}
      </li>
    );
  }
  if (step.k === "critic-start") {
    return (
      <li className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
        <span className="font-medium text-foreground/70">{step.lens}</span>
        <span>started</span>
        {step.blocker && (
          <Badge className="bg-destructive/15 font-mono text-[9px] text-destructive">must clear</Badge>
        )}
      </li>
    );
  }
  if (step.k === "text") {
    return (
      <li className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-[10px] text-muted-foreground/60">{step.who}</span>
        <span className="leading-snug">{step.text}</span>
      </li>
    );
  }
  // tool / observation — an expandable single-line row.
  return <ProcessIORow step={step} />;
}

function ProcessIORow({ step }: { step: Extract<VerifyStep, { k: "tool" | "observation" }> }) {
  const [open, setOpen] = useState(false);
  const label = step.k === "tool" ? step.name : step.kind;
  const body = step.k === "tool" ? step.input : step.output;
  const verb = step.k === "tool" ? "calls" : "saw";
  return (
    <li className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => body && setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-md text-left text-[11px] text-muted-foreground",
          body && "transition-colors hover:text-foreground",
        )}
      >
        <span className="font-mono text-[10px] text-muted-foreground/60">{step.who}</span>
        <span>{verb}</span>
        <span className="font-mono text-foreground/70">{label}</span>
        {body && (
          <ChevronRight className={cn("size-3 text-muted-foreground/50", open && "rotate-90")} />
        )}
      </button>
      {open && body && (
        <pre className="ml-2 max-h-40 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground ring-1 ring-border">
          {body}
        </pre>
      )}
    </li>
  );
}

// The Verification Contract, client-fetched from the Spec Bundle (it lives there,
// not on the loom/events). Split into must-clear vs advisory. A synthesized
// contract is honestly labeled.
function VerifyContract({ loomId }: { loomId: string }) {
  const { bundle, loaded } = useSpecBundle(loomId, true);
  const assertions = bundle?.contract?.assertions ?? [];
  if (!loaded || assertions.length === 0) return null;
  const synthesized = bundle?.contract?.synthesized === true;
  const blockers = assertions.filter((a) => a.blocker);
  const advisory = assertions.filter((a) => !a.blocker);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Verification contract
          </span>
          <span className="text-xs text-muted-foreground/60">
            {assertions.length} assertion{assertions.length === 1 ? "" : "s"}
          </span>
          {synthesized && (
            <Badge variant="secondary" className="font-normal" title="Auto-derived from this loom's acceptance criteria / prompt">
              synthesized
            </Badge>
          )}
        </div>
        {synthesized && (
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            No contract was authored, so this yardstick was auto-derived from the loom&apos;s
            acceptance criteria (prose, judged live by the critic panel).
          </p>
        )}
        {blockers.length > 0 && (
          <div className="flex flex-col gap-2">
            {blockers.map((a) => (
              <AssertionRow key={a.id} loomId={loomId} assertion={a} />
            ))}
          </div>
        )}
        {advisory.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">Advisory</span>
            {advisory.map((a) => (
              <AssertionRow key={a.id} loomId={loomId} assertion={a} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// A "why this verdict" line for a skip — honest about whether promotion is held.
function skipNote(report: VerifyReport): string {
  if (report.verdict !== "skip") return "";
  return report.panelRequired
    ? "No independent evidence was captured — promotion is held (this contract requires a passing panel)."
    : "No executable check ran (no live target / no evidence). This is a promotable skip, judged as the legacy path would.";
}

function VerifyReportBlock({
  report,
  moatNote,
  defaultOpen,
}: {
  report: VerifyReport;
  moatNote?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const critics = report.critics;
  const mustClear = critics.filter((c) => c.blocker);
  const advisory = critics.filter((c) => !c.blocker);
  const isIntegration = report.scope === "integration";
  const note = skipNote(report);

  const hasBody =
    report.gates.length > 0 ||
    critics.length > 0 ||
    !!report.legacy ||
    report.steps.length > 0 ||
    !!report.builderVerdict;

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      {hasBody ? (
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground/60", !open && "-rotate-90")} />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
        {isIntegration ? "integration" : "thread"}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{report.title}</span>
      <VerdictBadge verdict={report.verdict} />
    </div>
  );

  return (
    <Card className={cn(isIntegration && "border-l-2 border-l-primary/40")}>
      <CardContent className="flex flex-col gap-4">
        {hasBody ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {header}
          </button>
        ) : (
          header
        )}

        {report.reason && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Why:</span> {report.reason}
          </p>
        )}
        {note && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{note}</span>
          </p>
        )}
        {isIntegration && moatNote && (
          <div className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>{moatNote}</span>
          </div>
        )}
        {report.url && (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">
            drove {report.url}
          </p>
        )}

        {open && hasBody && (
          <div className="flex flex-col gap-4">
            {report.gates.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Gate run ({report.gates.length})
                  </span>
                  {report.gates.map((g) => (
                    <GateRunRow key={g.name} gate={g} />
                  ))}
                </div>
              </>
            )}

            {critics.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Critic panel ({critics.length})
                  </span>
                  {mustClear.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground/80">
                        Must clear
                      </span>
                      {mustClear.map((c, i) => (
                        <CriticVerdictRow key={`${c.lens}-${i}`} loomId={report.id} critic={c} />
                      ))}
                    </div>
                  )}
                  {advisory.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground/80">
                        Advisory
                      </span>
                      {advisory.map((c, i) => (
                        <CriticVerdictRow key={`${c.lens}-${i}`} loomId={report.id} critic={c} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {report.steps.length > 0 && (
              <>
                <Separator />
                <ProcessTimeline steps={report.steps} />
              </>
            )}

            {report.legacy && (
              <>
                <Separator />
                <VerifierReportCard loomId={report.id} report={report.legacy} />
              </>
            )}

            {report.builderVerdict && (
              <>
                <Separator />
                <div className="flex flex-col gap-1 rounded-lg border border-dashed bg-muted/10 p-2.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Eye className="size-3.5" />
                    Builder&apos;s self-report (not the verdict)
                  </span>
                  <p className="text-xs text-muted-foreground">{report.builderVerdict.summary}</p>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Auto-repair loop (M4) — read-only history of the bounded convergence loop.
// Honest by construction: outcome is read off the loom's settled state (the
// derivation never invents a verdict), and the two exits it can show are the
// only two the loop has — converged→ready or escalated→needs-review. Never done.
// ---------------------------------------------------------------------------

const REPAIR_OUTCOME: Record<
  RepairOutcome,
  { label: string; className: string; Icon: LucideIcon; spin?: boolean }
> = {
  converged: {
    label: "converged → ready",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  escalated: {
    label: "escalated → needs-review",
    className: "bg-destructive/15 text-destructive",
    Icon: CircleX,
  },
  "in-progress": {
    label: "repairing…",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    Icon: Loader2,
    spin: true,
  },
};

function IdChip({ id, tone }: { id: string; tone: "good" | "bad" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset",
        tone === "good"
          ? "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive ring-destructive/20",
      )}
    >
      {id}
    </span>
  );
}

function RepairRoundRow({ round }: { round: RepairRoundView }) {
  const v = (["pass", "fail", "flaky", "skip"].includes(round.verification)
    ? round.verification
    : "skip") as AssertionOutcome;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">round {round.n}</span>
        <VerdictBadge verdict={v} />
        <span className="text-[11px] text-muted-foreground/70">
          {round.failing.length} failing
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">
          {fmtCost(round.costUsd)} · {fmtDuration(round.durationMs)}
        </span>
      </div>
      {round.fixed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-1">
          <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="mr-0.5 text-[10px] text-muted-foreground">cleared</span>
          {round.fixed.map((id) => (
            <IdChip key={id} id={id} tone="good" />
          ))}
        </div>
      )}
      {round.regressed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-1">
          <CircleAlert className="size-3 shrink-0 text-destructive" />
          <span className="mr-0.5 text-[10px] text-muted-foreground">regressed</span>
          {round.regressed.map((id) => (
            <IdChip key={id} id={id} tone="bad" />
          ))}
        </div>
      )}
      {round.failing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-1">
          <span className="mr-0.5 text-[10px] text-muted-foreground">still failing</span>
          {round.failing.map((id) => (
            <IdChip key={id} id={id} tone="bad" />
          ))}
        </div>
      )}
    </div>
  );
}

function RepairHistoryPanel({ repair }: { repair: RepairView }) {
  const { rounds, outcome, reason, totalCostUsd } = repair;
  const b = REPAIR_OUTCOME[outcome];
  return (
    <Card className="border-l-2 border-l-primary/40">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Auto-repair loop
          </span>
          <span className="text-xs text-muted-foreground/60">
            {rounds.length} round{rounds.length === 1 ? "" : "s"}
          </span>
          <Badge className={cn("ml-auto gap-1 font-mono text-[10px]", b.className)}>
            <b.Icon className={cn("size-3", b.spin && "animate-spin")} />
            {b.label}
          </Badge>
        </div>

        {reason && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Why:</span> {reason}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {rounds.map((r) => (
            <RepairRoundRow key={r.n} round={r} />
          ))}
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            Repair runs against a frozen snapshot the agent can&apos;t touch. The loop is bounded —
            it converges to <span className="font-medium text-foreground/80">ready</span> (awaiting
            your accept) or escalates to{" "}
            <span className="font-medium text-foreground/80">needs-review</span>, never done.
          </span>
          <span className="shrink-0 tabular-nums">{fmtCost(totalCostUsd)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function VerifyPanel({ view, loom }: { view: VerifyView; loom: Loom }) {
  const { root, threads } = view;
  const nothingYet =
    !root && threads.every((t) => t.verdict === "pending" && t.source === "none" && t.steps.length === 0);

  return (
    <div className="flex flex-col gap-4">
      <VerifyContract loomId={loom.id} />
      <ConsolidationBranch loom={loom} />
      {view.repair && <RepairHistoryPanel repair={view.repair} />}

      {nothingYet ? (
        <ComingSoon
          icon={ShieldCheck}
          title="Not verified yet"
          description="Once the verifier runs, every check it ran — the gate results, the critic panel with what it saw in the running app, and why it passed or held — will appear here."
        />
      ) : (
        <>
          {root && <VerifyReportBlock report={root} moatNote={view.moatNote} defaultOpen />}
          {threads.length > 1 && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs font-medium text-muted-foreground">Per-thread verifies</span>
              <span className="text-xs text-muted-foreground/60">{threads.length} threads</span>
            </div>
          )}
          {threads.map((t) => (
            <VerifyReportBlock key={t.id} report={t} defaultOpen={!root && threads.length === 1} />
          ))}
        </>
      )}
    </div>
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
  const [tab, setTab] = useState("orchestrator");
  // Mount the Chat tab lazily on first open, then keep it mounted (keepMounted
  // below) so a live steering turn keeps streaming while the user is on another
  // tab. Base UI hides an inactive kept-mounted panel via `hidden` — CSS-hidden,
  // not unmounted — so the SessionView never tears its stream down on a switch.
  const [chatOpened, setChatOpened] = useState(false);
  useEffect(() => {
    if (tab === "chat") setChatOpened(true);
  }, [tab]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4">
      {/* One two-column workspace: a tabbed cockpit on the left (orchestrator /
          threads / verify / chat), a persistent rail (intervention / done +
          log) on the right that stays reachable on every tab. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList variant="line">
            <TabsTrigger value="orchestrator">
              <Workflow />
              Orchestrator
            </TabsTrigger>
            <TabsTrigger value="threads">
              <Boxes />
              Threads
              <span className="text-xs text-muted-foreground tabular-nums">
                {view.operators.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="verify">
              <ShieldCheck />
              Verify
            </TabsTrigger>
            <TabsTrigger value="chat">
              <MessageSquare />
              Chat
            </TabsTrigger>
          </TabsList>

          <TabsContent value="orchestrator" className="flex flex-col gap-4 pt-2">
            <CharterStrip loom={loom} onViewSpec={onViewSpec} />
            <OrchestratorPanel orchestrator={view.orchestrator} log={view.decisionLog} />
          </TabsContent>

          <TabsContent value="threads" className="pt-2">
            <Weave
              operators={view.operators}
              loom={loom}
              threads={threads}
              onOpenOperator={onOpenOperator}
            />
          </TabsContent>

          <TabsContent value="verify" className="pt-2">
            <VerifyPanel view={view.verify} loom={loom} />
          </TabsContent>

          <TabsContent value="chat" className="pt-2" keepMounted>
            {chatOpened && <ChatTab loom={loom} />}
          </TabsContent>
        </Tabs>

        <RightRail
          loom={loom}
          threads={threads}
          woven={view.woven}
          acceptedBy={acceptedBy}
          onIntervened={onIntervened}
          onGoToThreads={() => setTab("threads")}
        />
      </div>

      <Moat />
    </div>
  );
}
