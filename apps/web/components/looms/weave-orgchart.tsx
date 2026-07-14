"use client";

// LANE: loom — CONCERN 6, the structural WEAVE section: the decomposition as an
// ORG-CHART. Instead of a flat operator-card list, this makes the shape spatial:
//   orchestrator (the weaver + its loop + the live tick + a verify roll-up)
//     └─ spine ─┬─ thread node ── agent chips (fan-out builders + critics), live
//               ├─ thread node …   status-dotted; a repair/mediation depth badge
//               └─ …               and "waits on" dependency labels
// A live activity timeline (the orchestrator's decisions) rides alongside.
// Clicking any thread node opens its 3-level drawer. Every node is colored off
// the REAL derived GodView — nothing is fabricated; a single loom renders as the
// honest weave-of-one.
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Eye,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import type { Loom, SubGoal } from "@telar/core";
import type {
  AssertionOutcome,
  DecisionKind,
  DecisionLogEntry,
  GodView,
  Operator,
  Orchestrator,
} from "./godview";
import { StatusBadge } from "./status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtAgo, shortId } from "@/lib/format";

const LOOP: Orchestrator["loopStage"][] = ["plan", "schedule", "observe", "decide"];

// ── one agent lane, as a live-dotted chip ──
type Chip = { key: string; isCritic: boolean; label: string; dot: string; title: string };

function chipsFor(op: Operator): Chip[] {
  const chips: Chip[] = [];
  if (op.subAgents.length > 0) {
    for (const s of op.subAgents) {
      chips.push({
        key: s.id,
        isCritic: false,
        label: shortId(s.id),
        dot: s.done ? "bg-muted-foreground/40" : "bg-emerald-500 animate-pulse",
        title: s.now,
      });
    }
  } else {
    const dot =
      op.status.kind === "run" && op.active
        ? "bg-emerald-500 animate-pulse"
        : op.status.kind === "done"
          ? "bg-emerald-500"
          : op.status.kind === "repair"
            ? op.state === "failed"
              ? "bg-destructive"
              : "bg-amber-500"
            : op.status.kind === "block"
              ? "bg-amber-500"
              : op.active
                ? "bg-emerald-500 animate-pulse"
                : "bg-muted-foreground/40";
    chips.push({ key: "op", isCritic: false, label: "builder", dot, title: op.status.label });
  }
  for (const c of op.critics) {
    chips.push({
      key: `critic-${c.lens}`,
      isCritic: true,
      label: c.lens,
      dot: c.ok ? "bg-emerald-500" : c.blocker ? "bg-destructive" : "bg-amber-500",
      title: c.summary || (c.ok ? "cleared" : "flagged"),
    });
  }
  return chips;
}

function AgentChip({ chip }: { chip: Chip }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
      title={chip.title}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", chip.dot)} />
      {chip.isCritic ? (
        <FlaskConical className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <Play className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="max-w-[130px] truncate text-muted-foreground">{chip.label}</span>
    </span>
  );
}

// The mediation-depth badge — thread inner loop → orchestrator → you. Derived
// from the operator's real repair count + settled state (per-thread trigger/
// action prose isn't captured; the depth + who-it-reached is).
function LadderBadge({ op }: { op: Operator }) {
  const escalated = op.state === "needs-review" || op.state === "blocked" || op.state === "failed";
  if (op.repairs === 0 && !escalated) return null;
  const reachedHuman = escalated;
  const Icon = reachedHuman ? Users : RotateCcw;
  const count = op.repairs || 1;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        reachedHuman ? "text-destructive" : "text-muted-foreground",
      )}
      title={reachedHuman ? "Mediation reached: you" : "Repaired inside the thread loop"}
    >
      <Icon className="size-3" />
      {op.repairs > 0 ? `${count} repair${count === 1 ? "" : "s"}` : "escalated"}
    </Badge>
  );
}

function ThreadNode({
  op,
  waitsOn,
  onOpen,
}: {
  op: Operator;
  waitsOn: string[];
  onOpen: () => void;
}) {
  const chips = chipsFor(op);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors",
        "border-border hover:border-primary/40 hover:bg-muted/30",
        waitsOn.length > 0 && "border-l-2 border-l-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{op.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">{shortId(op.id)}</span>
          </div>
          {waitsOn.length > 0 && (
            <span className="text-[10px] text-muted-foreground/70">waits on {waitsOn.join(", ")}</span>
          )}
        </div>
        <StatusBadge kind={op.status.kind} state={op.state} active={op.active} label={op.status.label} />
      </div>

      {/* agent lane */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-border pt-2">
        <span className="text-[10px] text-muted-foreground/50">agents</span>
        <ChevronRight className="size-3 text-muted-foreground/30" />
        {chips.map((c) => (
          <AgentChip key={c.key} chip={c} />
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <LadderBadge op={op} />
          <span className="hidden items-center gap-0.5 text-[10px] text-muted-foreground/60 sm:flex">
            open <ChevronRight className="size-3" />
          </span>
        </span>
      </div>
    </button>
  );
}

// ── the verification roll-up on the orchestrator node — a verification-hero
// element composed only where it fits: the integration verdict when one exists. ──
const VERIFY_META: Record<AssertionOutcome, { label: string; className: string; Icon: typeof Check }> = {
  pass: { label: "verify green", className: "text-emerald-600 dark:text-emerald-400", Icon: CircleCheck },
  fail: { label: "verify red", className: "text-destructive", Icon: CircleX },
  flaky: { label: "verify flaky", className: "text-amber-600 dark:text-amber-400", Icon: CircleAlert },
  skip: { label: "no independent check", className: "text-muted-foreground", Icon: CircleAlert },
  pending: { label: "not verified yet", className: "text-muted-foreground", Icon: ShieldCheck },
};

function VerifyRollup({ view }: { view: GodView }) {
  const verdict = view.verify.root?.verdict;
  if (!verdict) return null;
  const m = VERIFY_META[verdict];
  return (
    <span className={cn("flex items-center gap-1.5", m.className)} title="Integration verify — the whole weave">
      <m.Icon className="size-3.5 shrink-0" />
      <span>{m.label}</span>
    </span>
  );
}

function OrchestratorNode({ view }: { view: GodView }) {
  const { orchestrator, operators } = view;
  const active = operators.filter((o) => o.active).length;
  const done = operators.filter((o) => o.status.kind === "done").length;
  const needsYou = operators.filter((o) => o.status.kind === "block").length;

  return (
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
                  s === orchestrator.loopStage
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
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                active > 0 ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="tabular-nums text-foreground">{active} active</span>
          </span>
          <span className="text-muted-foreground">{done} done</span>
          {needsYou > 0 && (
            <span className="text-amber-600 dark:text-amber-400">{needsYou} needs you</span>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {active > 0 ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
          )}
          <span>
            <span className="font-medium text-foreground/70">Tick:</span> {orchestrator.tick}
          </span>
        </span>
        <span className="ml-auto">
          <VerifyRollup view={view} />
        </span>
      </div>
    </div>
  );
}

const ACT_META: Record<DecisionKind, { Icon: typeof Check; className: string }> = {
  plan: { Icon: Workflow, className: "text-muted-foreground" },
  ok: { Icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { Icon: CircleX, className: "text-destructive" },
  block: { Icon: CircleAlert, className: "text-amber-600 dark:text-amber-400" },
  info: { Icon: RotateCcw, className: "text-amber-600 dark:text-amber-400" },
  observe: { Icon: Eye, className: "text-muted-foreground" },
};

function ActivityTimeline({ log }: { log: DecisionLogEntry[] }) {
  // godview derives the log oldest→newest; show newest first, most recent 12.
  const items = [...log].reverse().slice(0, 12);
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No decisions yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {items.map((a, i) => {
        const meta = ACT_META[a.kind];
        const last = i === items.length - 1;
        return (
          <li key={`${a.ts}-${i}`} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                <meta.Icon className={cn("size-3", meta.className)} />
              </span>
              {!last && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 pb-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground/90">{a.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/50">
                  {fmtAgo(a.ts)}
                </span>
              </div>
              {a.detail && <span className="text-[11px] text-muted-foreground">{a.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Layout-only dependency derivation: map each operator (= a child thread) to any
// dep whose thread hasn't reached "done" yet. Single looms have no threads → no
// deps. Guarded against a missing charter / empty threads.
function deriveWaitsOn(loom: Loom, threads: Loom[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const decomposition: SubGoal[] = loom.charter?.decomposition ?? [];
  if (decomposition.length === 0 || threads.length === 0) return out;
  const bySubGoal = new Map<string, Loom>();
  for (const t of threads) if (t.subGoalId) bySubGoal.set(t.subGoalId, t);
  for (const t of threads) {
    const sg = decomposition.find((d) => d.id === t.subGoalId);
    const waitsOn = (sg?.dependsOn ?? [])
      .filter((dep) => bySubGoal.get(dep)?.state !== "done")
      .map((dep) => {
        const depThread = bySubGoal.get(dep);
        const depSg = decomposition.find((d) => d.id === dep);
        return depThread ? shortId(depThread.id) : (depSg?.title ?? dep);
      });
    out.set(t.id, waitsOn);
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

export function WeaveOrgChart({
  view,
  loom,
  threads,
  onOpenOperator,
}: {
  view: GodView;
  loom: Loom;
  threads: Loom[];
  onOpenOperator: (id: string) => void;
}) {
  const { operators } = view;
  const waits = deriveWaitsOn(loom, threads);

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">The weave</span>
            <span className="text-xs text-muted-foreground/60">{summarize(operators)}</span>
          </div>
          <p className="text-xs text-muted-foreground/70">
            Orchestrator → threads → agents — select a thread to open its drawer.
          </p>
        </div>

        <OrchestratorNode view={view} />

        {operators.length === 0 ? (
          <p className="text-xs text-muted-foreground">No operators weaving yet.</p>
        ) : (
          <>
            <div className="flex justify-center">
              <ArrowDown className="size-4 text-muted-foreground/40" />
            </div>
            <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-border/60 pl-4">
              {operators.map((op) => (
                <div key={op.id} className="relative">
                  <span className="absolute -left-4 top-6 h-px w-4 bg-border/60" />
                  <ThreadNode
                    op={op}
                    waitsOn={waits.get(op.id) ?? []}
                    onOpen={() => onOpenOperator(op.id)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* activity timeline */}
      <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <Workflow className="size-3.5" />
          Activity
        </h2>
        <div className="rounded-xl border border-border bg-card p-3.5">
          <ActivityTimeline log={view.decisionLog} />
        </div>
      </aside>
    </div>
  );
}
