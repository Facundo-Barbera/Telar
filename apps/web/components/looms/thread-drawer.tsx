"use client";

// LANE: loom — CONCERN 6.1: the 3-LEVEL THREAD DRAWER, wired to REAL loom /
// thread / transcript data. Replaces the flat two-tab AgentViewDrawer with a
// navigable stack:
//   L1 overview   → status, glance stats, repair ladder, agent roster, the
//                   owner's intervention panel (accept/steer/reject/resume)
//   L2 anatomy    → the derived step timeline, the deterministic gate run, the
//                   mediation / repair ladder, files touched, the agent list
//   L2 agent      → one lane's identity + a gateway to its transcript
//   L3 transcript → the full agent turns via the shared session-style rows
// A breadcrumb sits between levels, Esc pops one level (closes at the root), and
// a copyable deep-link chip gives the level state a wayfinding feel. Every field
// is DERIVED from the real Operator / Loom — where a source doesn't exist
// (per-agent spend, live mediation trigger/action prose) the UI degrades
// honestly rather than fabricating it.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Command,
  Copy,
  DollarSign,
  Eye,
  FilePen,
  FilePlus,
  FlaskConical,
  Layers,
  ListTree,
  Loader2,
  Play,
  RotateCcw,
  Timer,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type { CriticVerdict, GateResult, Loom } from "@telar/core";
import type { Operator, RosterEntry, Step } from "./godview";
import { deriveRepair } from "./godview";
import { AcceptancePanel } from "./acceptance-panel";
import { StatusBadge, statusVisual, TONE_ICON } from "./status";
import { ScriptEntry } from "./agent-view";
import { fmtDuration, sumCost } from "./utils";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fmtCost, shortId } from "@/lib/format";

// ---------------------------------------------------------------------------
// Navigation stack — each pushed frame is a breadcrumb crumb; Esc pops.
// ---------------------------------------------------------------------------

type Frame =
  | { kind: "overview" }
  | { kind: "anatomy" }
  | { kind: "agent"; agentKey: string }
  | { kind: "transcript"; agentKey: string };

const LEVEL: Record<Frame["kind"], 1 | 2 | 3> = {
  overview: 1,
  anatomy: 2,
  agent: 2,
  transcript: 3,
};

function crumbLabel(frame: Frame, op: Operator): string {
  switch (frame.kind) {
    case "overview":
      return shortId(op.id);
    case "anatomy":
      return "anatomy";
    case "agent":
      return op.roster.find((r) => r.key === frame.agentKey)?.label ?? "agent";
    case "transcript":
      return "transcript";
  }
}

// ---------------------------------------------------------------------------
// Presentational primitives — ported from the approved demo visual language
// (lib/demo-gallery/loom/ui.tsx) into production, adapted to the real types.
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = "muted",
  sub,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "ok" | "warn" | "danger" | "active";
  sub?: string;
  onClick?: () => void;
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "danger"
          ? "text-destructive"
          : "text-foreground";
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-left",
        onClick && "group transition-colors hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className={cn("text-lg font-semibold tabular-nums", toneClass)}>{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground/70">{sub}</span>}
    </Wrapper>
  );
}

const STEP_ICON: Record<Step["state"], React.ReactNode> = {
  done: <Check className="size-3 text-emerald-600 dark:text-emerald-400" />,
  active: <Loader2 className="size-3 animate-spin text-foreground" />,
  failed: <CircleX className="size-3 text-destructive" />,
  idle: <Clock className="size-3 text-muted-foreground/50" />,
};

function StepTimeline({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing has run on this thread yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={`${s.name}-${i}`} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border bg-card",
                  s.state === "failed"
                    ? "border-destructive/50"
                    : s.state === "active"
                      ? "border-foreground/40"
                      : s.state === "done"
                        ? "border-emerald-500/40"
                        : "border-border",
                )}
              >
                {STEP_ICON[s.state]}
              </span>
              {!last && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className={cn("flex min-w-0 flex-col", last ? "pb-0" : "pb-3")}>
              <span
                className={cn(
                  "text-sm",
                  s.state === "idle" ? "text-muted-foreground/70" : "font-medium text-foreground",
                  s.state === "failed" && "text-destructive",
                )}
              >
                {s.name}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// A deterministic gate result — collapsible command output, real GateResult.
function GateRow({ gate }: { gate: GateResult }) {
  const [open, setOpen] = useState(false);
  const hasOutput = gate.output.trim().length > 0;
  return (
    <div
      className={cn(
        "rounded-lg border",
        gate.ok ? "border-border" : "border-destructive/40 bg-destructive/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={() => hasOutput && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {gate.ok ? (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="font-mono text-xs font-medium">{gate.name}</span>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {gate.timedOut ? "timed out" : gate.exitCode != null ? `exit ${gate.exitCode}` : ""}
          {" · "}
          {fmtDuration(gate.durationMs)}
        </span>
        {hasOutput && (
          <ChevronRight
            className={cn(
              "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && hasOutput && (
        <div className="px-3 pb-2">
          <pre className="max-h-56 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
            {gate.output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── the mediation / repair ladder — the doctrine's escalation chain, honest ──
type MediationLevel = "thread" | "orchestrator" | "human";
type Rung = {
  level: MediationLevel;
  title: string;
  detail: string;
  fixed?: string[];
  stillFailing?: string[];
  costUsd?: number;
};

const MED_META: Record<MediationLevel, { Icon: typeof RotateCcw; chip: string; rail: string }> = {
  thread: { Icon: RotateCcw, chip: "text-muted-foreground", rail: "bg-foreground/30" },
  orchestrator: { Icon: Workflow, chip: "text-amber-600 dark:text-amber-400", rail: "bg-amber-500/60" },
  human: { Icon: Users, chip: "text-destructive", rail: "bg-destructive/60" },
};

// The escalation chain from real data: repairHistory rounds when the loom
// captured one (root/single loom), else synthesized from the operator's repair
// count + settled state (a woven child, whose repairHistory lives at the root).
function deriveMediation(op: Operator, loom: Loom | null | undefined): Rung[] {
  const rungs: Rung[] = [];
  const repair = loom ? deriveRepair(loom) : null;
  if (repair) {
    for (const r of repair.rounds) {
      rungs.push({
        level: "thread",
        title: `Repair round ${r.n}`,
        detail: `verify ${r.verification} · ${r.failing.length} failing`,
        fixed: r.fixed,
        stillFailing: r.failing,
        costUsd: r.costUsd || undefined,
      });
    }
    if (repair.outcome === "escalated") {
      rungs.push({
        level: "human",
        title: "Escalated to you",
        detail: repair.reason ?? "a convergence guard tripped — needs review",
      });
    }
    return rungs;
  }
  for (let k = 1; k <= op.repairs; k++) {
    rungs.push({
      level: "thread",
      title: `Thread inner loop · repair ${k}`,
      detail: "verify failed — the failing criterion + a repro were handed back to the builder",
    });
  }
  if (op.state === "needs-review")
    rungs.push({
      level: "human",
      title: "Escalated to you",
      detail: op.error ?? "couldn't be independently verified — no executable check ran",
    });
  else if (op.state === "blocked")
    rungs.push({
      level: "human",
      title: "Parked for your decision",
      detail: op.error ?? "the orchestrator won't guess this one — answer it to resume",
    });
  else if (op.state === "failed")
    rungs.push({
      level: "human",
      title: "Dead-ended",
      detail: op.error ?? "the repair loop couldn't land this thread",
    });
  return rungs;
}

function MediationLadder({ rungs }: { rungs: Rung[] }) {
  if (rungs.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        No repairs needed — this thread verified on the first pass.
      </p>
    );
  }
  return (
    <ol className="flex flex-col">
      {rungs.map((r, i) => {
        const meta = MED_META[r.level];
        const last = i === rungs.length - 1;
        return (
          <li key={i} className="flex gap-3">
            <div className="flex flex-col items-center pt-1">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border bg-card",
                  r.level === "human"
                    ? "border-destructive/50"
                    : r.level === "orchestrator"
                      ? "border-amber-500/50"
                      : "border-border",
                )}
              >
                <meta.Icon className={cn("size-3", meta.chip)} />
              </span>
              {!last && <span className={cn("w-px flex-1", meta.rail)} />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 pb-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[10px] text-muted-foreground/60">#{i + 1}</span>
                <span className={cn("text-xs font-medium", meta.chip)}>{r.title}</span>
                {r.costUsd != null && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
                    +{fmtCost(r.costUsd)}
                  </span>
                )}
              </div>
              <p className="text-xs text-foreground/80">{r.detail}</p>
              {r.fixed && r.fixed.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
                  {r.fixed.map((f) => (
                    <span key={f} className="font-mono text-muted-foreground">
                      {f}
                    </span>
                  ))}
                </div>
              )}
              {r.stillFailing && r.stillFailing.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {r.stillFailing.map((f) => (
                    <div key={f} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <CircleX className="mt-0.5 size-3 shrink-0 text-destructive/70" />
                      <span className="font-mono">{f}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── per-lane display meta, drawn from the real Operator (roster is data-light) ──
type RosterMeta = {
  isCritic: boolean;
  now: string;
  statusLabel: string;
  dot: string;
  text: string;
};

function rosterMeta(entry: RosterEntry, op: Operator): RosterMeta {
  if (entry.role === "critic") {
    const idx = Number(entry.key.replace("critic-", ""));
    const c: CriticVerdict | undefined = op.critics[idx];
    const ok = c?.ok ?? false;
    return {
      isCritic: true,
      now: c?.summary ?? "critic verdict",
      statusLabel: ok ? "passed" : c?.blocker ? "blocking" : "advisory",
      dot: ok ? "bg-emerald-500" : c?.blocker ? "bg-destructive" : "bg-amber-500",
      text: ok
        ? "text-emerald-600 dark:text-emerald-400"
        : c?.blocker
          ? "text-destructive"
          : "text-amber-600 dark:text-amber-400",
    };
  }
  if (entry.key === "op") {
    return {
      isCritic: false,
      now: op.summary ?? op.status.label,
      statusLabel: op.status.label,
      dot: op.active ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50",
      text: "text-muted-foreground",
    };
  }
  const sub = op.subAgents.find((s) => s.id === entry.key);
  return {
    isCritic: false,
    now: sub?.now ?? "",
    statusLabel: entry.done ? "merged" : "live",
    dot: entry.done ? "bg-muted-foreground/50" : "bg-emerald-500 animate-pulse",
    text: "text-muted-foreground",
  };
}

function AgentRow({
  entry,
  op,
  cta,
  onOpen,
}: {
  entry: RosterEntry;
  op: Operator;
  cta: string;
  onOpen: () => void;
}) {
  const m = rosterMeta(entry, op);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
        {m.isCritic ? (
          <FlaskConical className="size-3.5 text-muted-foreground" />
        ) : (
          <Play className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.label}</span>
          <span className="flex shrink-0 items-center gap-1">
            <span className={cn("size-1.5 rounded-full", m.dot)} />
            <span className={cn("text-[10px]", m.text)}>{m.statusLabel}</span>
          </span>
        </div>
        {m.now && <span className="truncate text-xs text-muted-foreground">{m.now}</span>}
        {entry.sessionId && (
          <span className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
            session {shortId(entry.sessionId)}
          </span>
        )}
      </div>
      <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/60 transition-colors group-hover:text-primary">
        {cta} <ArrowUpRight className="size-3" />
      </span>
    </button>
  );
}

function NowLine({ icon: Icon, children }: { icon: typeof CircleAlert; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-foreground/80">{children}</span>
    </div>
  );
}

function DeepLinkChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(path).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title={`Copy deep link ${path}`}
      className="inline-flex max-w-full items-center gap-1 rounded font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <span className="truncate">{path}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The "what's happening now" one-liner + its icon (honest per state).
// ---------------------------------------------------------------------------

function nowLine(op: Operator): string {
  switch (op.status.kind) {
    case "done":
      return "Done — verified against its story and promoted.";
    case "block":
      return op.state === "needs-review"
        ? "Couldn't independently verify this — no executable check ran. Review the deliverable, then accept (an override), steer it, or send it back from the panel below."
        : "Paused on a decision the orchestrator won't guess — answer it from the panel below. The rest of the weave keeps running around it.";
    case "repair":
      if (op.state === "failed")
        return "Dead-ended — the loop couldn't land this thread. Resume it to retry, or send it back with feedback from the panel below.";
      if (op.state === "halted")
        return "Stopped — this thread was halted and isn't running.";
      return "Builder resumed with the failing criterion + a repro. Reworking against the contract.";
    case "verify":
      return op.state === "ready"
        ? "Verified by an independent panel — awaiting your acceptance."
        : "Verifying — the critic panel is driving the live product.";
    case "run": {
      const live = op.subAgents.filter((s) => !s.done).length;
      return live > 0
        ? `${live} builder${live === 1 ? "" : "s"} weaving in parallel — isolated worktrees, merged on green.`
        : "Building against the spec.";
    }
    default:
      return "Scheduled — not started yet.";
  }
}

function nowIcon(op: Operator): typeof Play {
  switch (op.status.kind) {
    case "block":
      return op.state === "needs-review" ? Eye : CircleAlert;
    case "repair":
      return op.state === "failed" ? CircleX : RotateCcw;
    case "verify":
      return FlaskConical;
    case "done":
      return CircleCheck;
    default:
      return Play;
  }
}

// ---------------------------------------------------------------------------
// The WHY it stalled — the loom's own error line + the specific blockers.
// ---------------------------------------------------------------------------

function ReasonBanner({ op }: { op: Operator }) {
  if (op.state !== "failed" && op.state !== "needs-review") return null;
  const { gates, critics, verdictBlocker } = op.failing;
  const hasDetail = gates.length > 0 || critics.length > 0 || !!verdictBlocker;
  if (!op.error && !hasDetail) return null;
  const isReview = op.state === "needs-review";
  const headline =
    op.error ?? (isReview ? "Couldn't be independently verified." : "This thread failed.");

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2.5",
        isReview
          ? "border-amber-500/40 bg-amber-500/[0.05]"
          : "border-destructive/40 bg-destructive/[0.05]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {isReview ? (
          <Eye className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        )}
        <span
          className={cn(
            "text-xs font-medium tracking-wide uppercase",
            isReview ? "text-amber-600 dark:text-amber-400" : "text-destructive",
          )}
        >
          {isReview ? "Why it can't be verified" : "Failure reason"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground/80">{headline}</p>
      {hasDetail && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {gates.map((name) => (
            <li key={`gate-${name}`} className="flex items-start gap-1.5">
              <CircleX className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>
                gate <span className="font-mono text-[11px] text-foreground/70">{name}</span> failed
              </span>
            </li>
          ))}
          {critics.map((lens) => (
            <li key={`critic-${lens}`} className="flex items-start gap-1.5">
              <CircleX className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>
                blocker lens{" "}
                <span className="font-mono text-[11px] text-foreground/70">{lens}</span> did not clear
              </span>
            </li>
          ))}
          {verdictBlocker && (
            <li className="flex items-start gap-1.5">
              <CircleAlert className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>builder flagged: {verdictBlocker}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// L1 — overview.
// ---------------------------------------------------------------------------

function Overview({
  op,
  loom,
  gates,
  rungs,
  onIntervened,
  go,
}: {
  op: Operator;
  loom: Loom | null | undefined;
  gates: GateResult[];
  rungs: Rung[];
  onIntervened?: () => void;
  go: (f: Frame) => void;
}) {
  const stepsDone = op.steps.filter((s) => s.state === "done").length;
  const gatesOk = gates.filter((g) => g.ok).length;
  const escalated = op.state === "failed" || op.state === "needs-review";

  return (
    <div className="flex flex-col gap-4">
      <ReasonBanner op={op} />

      <NowLine icon={nowIcon(op)}>{nowLine(op)}</NowLine>

      {op.summary && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Summary</SectionLabel>
          <div className="text-sm leading-relaxed">
            <MessageResponse>{op.summary}</MessageResponse>
          </div>
        </div>
      )}

      {/* Glance stats — every tile drills into the L2 anatomy. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Steps"
          value={`${stepsDone}/${op.steps.length}`}
          tone="active"
          sub="done"
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile
          label="Gates"
          value={`${gatesOk}/${gates.length}`}
          tone={gates.length === 0 ? "muted" : gatesOk === gates.length ? "ok" : "danger"}
          sub={gates.length === 0 ? "none" : gatesOk === gates.length ? "green" : "red"}
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile
          label="Repairs"
          value={op.repairs}
          tone={op.repairs === 0 ? "muted" : escalated ? "danger" : "warn"}
          sub={op.repairs === 0 ? "clean" : "ladder"}
          onClick={() => go({ kind: "anatomy" })}
        />
        <StatTile
          label="Agents"
          value={op.roster.length}
          tone="muted"
          sub="lanes"
          onClick={() => go({ kind: "anatomy" })}
        />
      </div>

      {/* Repair / mediation summary — condensed, drills into the anatomy. */}
      {rungs.length > 0 && (
        <button
          type="button"
          onClick={() => go({ kind: "anatomy" })}
          className="group flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
          <div className="flex items-center gap-2">
            <ListTree className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Mediation ladder</span>
            <span className="text-[11px] text-muted-foreground/70">
              {rungs.length} rung{rungs.length === 1 ? "" : "s"}
            </span>
            <span className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground/60 group-hover:text-primary">
              open <ChevronRight className="size-3" />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {rungs.map((r, i) => (
              <Fragment key={i}>
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
                {i < rungs.length - 1 && (
                  <ChevronRight className="size-3 text-muted-foreground/40" />
                )}
              </Fragment>
            ))}
          </div>
        </button>
      )}

      {/* The owner's move on THIS thread — self-gates on loom.state, renders
          only in an owner-actionable state (ready/needs-review/blocked/failed).
          Only a ROOT is human-accepted; a child Thread (parentLoomId set) is
          consumed by the weave rollup (L5 accept-lock corollary), never
          accepted here. */}
      {loom && !loom.parentLoomId && <AcceptancePanel loom={loom} onAccepted={onIntervened} />}

      {/* Agent roster — each opens its focused L2 lane. */}
      {op.roster.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            <Users className="size-3.5" />
            Agents · {op.roster.length}
            <span className="font-normal text-muted-foreground/60">— select a lane</span>
          </SectionLabel>
          <div className="flex flex-col gap-1.5">
            {op.roster.map((entry) => (
              <AgentRow
                key={entry.key}
                entry={entry}
                op={op}
                cta="open"
                onOpen={() => go({ kind: "agent", agentKey: entry.key })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// L2 — anatomy.
// ---------------------------------------------------------------------------

function Anatomy({
  op,
  gates,
  rungs,
  go,
}: {
  op: Operator;
  gates: GateResult[];
  rungs: Rung[];
  go: (f: Frame) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <SectionLabel>
          <ListTree className="size-3.5" />
          Steps — what the operator actually did
        </SectionLabel>
        <StepTimeline steps={op.steps} />
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <SectionLabel>
          <Command className="size-3.5" />
          Deterministic gates
        </SectionLabel>
        {gates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No gates ran on this thread.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {gates.map((g) => (
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
        <MediationLadder rungs={rungs} />
      </div>

      {op.files.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>Files touched</SectionLabel>
            <div className="flex flex-col gap-1">
              {op.files.map((f, i) => (
                <div
                  key={`${f.path}-${i}`}
                  className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
                >
                  {f.op === "add" ? (
                    <FilePlus className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <FilePen className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{f.path}</span>
                  {f.stat && <span className="shrink-0 text-muted-foreground/60">{f.stat}</span>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {op.roster.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>
              <Users className="size-3.5" />
              Agents — open a transcript
            </SectionLabel>
            <div className="flex flex-col gap-1.5">
              {op.roster.map((entry) => (
                <AgentRow
                  key={entry.key}
                  entry={entry}
                  op={op}
                  cta="transcript"
                  onOpen={() => go({ kind: "transcript", agentKey: entry.key })}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// L2 — one agent lane's identity + a gateway to its transcript.
// ---------------------------------------------------------------------------

function AgentIdentity({ entry }: { entry: RosterEntry }) {
  const isCritic = entry.role === "critic";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-medium">
        {isCritic ? <FlaskConical className="size-3" /> : <Play className="size-3" />}
        {isCritic ? "critic" : "builder"}
      </span>
      {entry.sessionId && (
        <span className="font-mono text-[11px] text-muted-foreground">
          session {shortId(entry.sessionId)}
        </span>
      )}
      {!isCritic && (
        <Badge variant="secondary" className="text-[10px]">
          {entry.done === true ? "merged" : "live"}
        </Badge>
      )}
    </div>
  );
}

function AgentDetail({
  op,
  agentKey,
  go,
}: {
  op: Operator;
  agentKey: string;
  go: (f: Frame) => void;
}) {
  const entry = op.roster.find((r) => r.key === agentKey);
  if (!entry) return null;
  const m = rosterMeta(entry, op);
  return (
    <div className="flex flex-col gap-4">
      <AgentIdentity entry={entry} />
      <NowLine icon={entry.role === "critic" ? FlaskConical : Play}>{m.now}</NowLine>

      <button
        type="button"
        onClick={() => go({ kind: "transcript", agentKey })}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-muted/60"
      >
        <ListTree className="size-4" />
        Open full transcript
        <ChevronRight className="size-4" />
      </button>

      <p className="text-[11px] text-muted-foreground/70">
        {entry.role === "critic"
          ? "read-only critic · different account · no Write / Edit / Bash"
          : "builder · Write · Edit · Bash · resumable session"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// L3 — the full transcript, via the shared session-style rows.
// ---------------------------------------------------------------------------

function TranscriptFrame({ op, agentKey }: { op: Operator; agentKey: string }) {
  const entry = op.roster.find((r) => r.key === agentKey);
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({});
  if (!entry) return null;
  return (
    <div className="flex flex-col gap-4">
      <AgentIdentity entry={entry} />
      <Separator />
      {!entry.transcript.available ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          Transcript not captured yet — {entry.transcript.reason}
        </p>
      ) : entry.transcript.entries.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0" />
          No steps recorded on this session yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {entry.transcript.entries.map((e, i) => (
            <ScriptEntry
              key={i}
              e={e}
              open={!!openRows[i]}
              onToggle={() => setOpenRows((o) => ({ ...o, [i]: !o[i] }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer shell.
// ---------------------------------------------------------------------------

export function ThreadDrawer({
  operator,
  loom,
  onIntervened,
  onClose,
}: {
  operator: Operator | null;
  // The RAW loom behind the open operator (root for a single loom, else the
  // child Thread) — powers the in-drawer intervention panel + the real gate run
  // and repair history. onIntervened fires after an accept/steer/reject/resume.
  loom?: Loom | null;
  onIntervened?: () => void;
  onClose: () => void;
}) {
  const open = operator !== null;

  // Cache the last non-null operator + loom so content stays put during close.
  const opCache = useRef<Operator | null>(operator);
  if (operator) opCache.current = operator;
  const op = operator ?? opCache.current;

  const loomCache = useRef<Loom | null>(loom ?? null);
  if (loom) loomCache.current = loom;
  const drawerLoom = loom ?? loomCache.current;

  const [stack, setStack] = useState<Frame[]>([{ kind: "overview" }]);
  const stackRef = useRef(stack);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);

  // Reset to L1 whenever a different operator opens.
  const openedId = operator?.id;
  useEffect(() => {
    if (openedId) setStack([{ kind: "overview" }]);
  }, [openedId]);

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

  const gates = useMemo<GateResult[]>(
    () => drawerLoom?.attempts.at(-1)?.gates ?? [],
    [drawerLoom],
  );
  const rungs = useMemo(() => (op ? deriveMediation(op, drawerLoom) : []), [op, drawerLoom]);

  if (!op) return null;

  const top = stack[stack.length - 1];
  const latest = drawerLoom?.attempts.at(-1);
  const elapsedMs =
    latest?.endedAt != null && latest.startedAt != null
      ? latest.endedAt - latest.startedAt
      : null;
  const deepLink = `${drawerLoom?.project ?? "loom"}/looms/${shortId(op.id)}${
    stack.length > 1
      ? "#" +
        stack
          .slice(1)
          .map((f) => (f.kind === "agent" || f.kind === "transcript" ? `${f.kind}:${f.agentKey}` : f.kind))
          .join("/")
      : ""
  }`;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        // Esc pops one level; only closes at the root. Backdrop / X close fully.
        if (details.reason === "escape-key" && stackRef.current.length > 1) {
          details.cancel();
          pop();
          return;
        }
        onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-xl"
      >
        {/* header: identity + status + close */}
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{op.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground/70">{shortId(op.id)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] text-muted-foreground/60">
                {drawerLoom && (
                  <span className="flex items-center gap-1">
                    <DollarSign className="size-3" />
                    {fmtCost(sumCost(drawerLoom.attempts)).replace("$", "")}
                  </span>
                )}
                {elapsedMs != null && (
                  <span className="flex items-center gap-1">
                    <Timer className="size-3" />
                    {fmtDuration(elapsedMs)}
                  </span>
                )}
              </div>
            </div>
            <StatusBadge kind={op.status.kind} state={op.state} active={op.active} label={op.status.label} />
            <button
              type="button"
              onClick={onClose}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close drawer"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* breadcrumb + level pips */}
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
                  <Fragment key={i}>
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
                      <span className="max-w-[140px] truncate">{crumbLabel(f, op)}</span>
                    </button>
                    {!isLast && <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />}
                  </Fragment>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
            <Layers className="size-3 shrink-0" />
            <DeepLinkChip path={deepLink} />
            <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
              <kbd className="rounded border border-border bg-muted px-1 font-mono">esc</kbd>
              back
            </span>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {top.kind === "overview" && (
            <Overview
              op={op}
              loom={drawerLoom}
              gates={gates}
              rungs={rungs}
              onIntervened={onIntervened}
              go={go}
            />
          )}
          {top.kind === "anatomy" && <Anatomy op={op} gates={gates} rungs={rungs} go={go} />}
          {top.kind === "agent" && <AgentDetail op={op} agentKey={top.agentKey} go={go} />}
          {top.kind === "transcript" && <TranscriptFrame op={op} agentKey={top.agentKey} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
