"use client";

// LANE: loom — shared presentational primitives for the redesigned Loom view +
// Thread drawer. These speak the exact production visual language: they reuse
// the live StatusBadge, the session-style ToolStepRow, and the same markdown
// renderer, so a reviewer judges the STRUCTURE, not a divergent skin.
import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  FilePen,
  FilePlus,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  User,
  Workflow,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ToolStepRow } from "@/components/session/tool-step";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  DemoAgent,
  DemoFile,
  DemoGate,
  DemoMediation,
  DemoScriptEntry,
  DemoStep,
  MediationLevel,
} from "./fixtures";

// ── section label, matching the drawer's muted tone ──
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

// ── a small stat tile for the L1 glance row ──
export function StatTile({
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
          : tone === "active"
            ? "text-foreground"
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
      {onClick && (
        <span className="mt-0.5 flex items-center gap-0.5 text-[10px] text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">
          open <ChevronRight className="size-2.5" />
        </span>
      )}
    </Wrapper>
  );
}

// ── the step timeline — the operator's actual moves, in order ──
const STEP_ICON: Record<DemoStep["state"], React.ReactNode> = {
  done: <Check className="size-3 text-emerald-600 dark:text-emerald-400" />,
  active: <Loader2 className="size-3 animate-spin text-foreground" />,
  failed: <CircleX className="size-3 text-destructive" />,
  idle: <Clock className="size-3 text-muted-foreground/50" />,
};

export function StepTimeline({ steps, dense }: { steps: DemoStep[]; dense?: boolean }) {
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
            <div className={cn("flex min-w-0 flex-col", last ? "pb-0" : dense ? "pb-2" : "pb-3")}>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-sm",
                    s.state === "idle" ? "text-muted-foreground/70" : "font-medium text-foreground",
                    s.state === "failed" && "text-destructive",
                  )}
                >
                  {s.name}
                </span>
                {s.at && s.at !== "—" && (
                  <span className="font-mono text-[10px] text-muted-foreground/60">{s.at}</span>
                )}
              </div>
              {s.detail && <span className="text-xs text-muted-foreground">{s.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── a gate result row — collapsible command + output ──
export function GateRow({ gate }: { gate: DemoGate }) {
  const [open, setOpen] = useState(false);
  const running = gate.ok === null;
  return (
    <div
      className={cn(
        "rounded-lg border",
        gate.ok === false ? "border-destructive/40 bg-destructive/[0.04]" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : gate.ok ? (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="font-mono text-xs font-medium">{gate.name}</span>
        {gate.durationMs != null && (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {(gate.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {gate.detail && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{gate.detail}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="px-3 pb-2">
          <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-[11px] text-muted-foreground ring-1 ring-border">
            $ {gate.command}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── the mediation ladder — the doctrine's escalation chain made visible ──
const MED_META: Record<
  MediationLevel,
  { Icon: typeof Workflow; label: string; rail: string; chip: string }
> = {
  thread: {
    Icon: RotateCcw,
    label: "Thread inner loop",
    rail: "bg-foreground/30",
    chip: "text-muted-foreground",
  },
  orchestrator: {
    Icon: Workflow,
    label: "Orchestrator mediation",
    rail: "bg-amber-500/60",
    chip: "text-amber-600 dark:text-amber-400",
  },
  human: {
    Icon: User,
    label: "Escalated to you",
    rail: "bg-destructive/60",
    chip: "text-destructive",
  },
};

const OUTCOME_BADGE: Record<
  DemoMediation["outcome"],
  { label: string; className: string }
> = {
  repaired: { label: "repaired", className: "text-emerald-600 dark:text-emerald-400" },
  regressed: { label: "still red", className: "text-amber-600 dark:text-amber-400" },
  escalated: { label: "escalated", className: "text-destructive" },
  pending: { label: "in flight", className: "text-muted-foreground" },
  accepted: { label: "accepted", className: "text-emerald-600 dark:text-emerald-400" },
};

export function MediationLadder({ rungs }: { rungs: DemoMediation[] }) {
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
        const outcome = OUTCOME_BADGE[r.outcome];
        return (
          <li key={r.n} className="flex gap-3">
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
                <span className="font-mono text-[10px] text-muted-foreground/60">#{r.n}</span>
                <span className={cn("text-xs font-medium", meta.chip)}>{r.actor}</span>
                <Badge variant="outline" className={cn("gap-1 font-normal", outcome.className)}>
                  {outcome.label}
                </Badge>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">{r.at}</span>
              </div>
              <p className="text-xs text-foreground/80">
                <span className="text-muted-foreground">trigger — </span>
                {r.trigger}
              </p>
              <p className="text-xs text-foreground/80">
                <span className="text-muted-foreground">did — </span>
                {r.action}
              </p>
              {r.fixed && r.fixed.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
                  {r.fixed.map((f) => (
                    <span key={f} className="text-muted-foreground">
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
                      {f}
                    </div>
                  ))}
                </div>
              )}
              {r.costUsd != null && (
                <span className="font-mono text-[10px] text-muted-foreground/50">
                  +${r.costUsd.toFixed(2)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── agent roster row — a builder/critic lane, click to drill in ──
const AGENT_STATUS: Record<
  DemoAgent["status"],
  { label: string; dot: string; text: string }
> = {
  live: { label: "live", dot: "bg-emerald-500 animate-pulse", text: "text-foreground" },
  merged: { label: "merged", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  passed: { label: "passed", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "failed", dot: "bg-destructive", text: "text-destructive" },
  blocking: { label: "blocking", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  queued: { label: "queued", dot: "bg-muted-foreground/30", text: "text-muted-foreground/70" },
};

export function AgentRow({
  agent,
  onOpen,
  cta = "transcript",
}: {
  agent: DemoAgent;
  onOpen: () => void;
  cta?: string;
}) {
  const s = AGENT_STATUS[agent.status];
  const isCritic = agent.role === "critic";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
        {isCritic ? (
          <FlaskConical className="size-3.5 text-muted-foreground" />
        ) : (
          <Play className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.label}</span>
          <span className="flex shrink-0 items-center gap-1">
            <span className={cn("size-1.5 rounded-full", s.dot)} />
            <span className={cn("text-[10px]", s.text)}>{s.label}</span>
          </span>
        </div>
        <span className="truncate text-xs text-muted-foreground">{agent.now}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-muted-foreground/60">
          {agent.model && <span>{agent.model}</span>}
          {agent.turns != null && <span>{agent.turns} turns</span>}
          {agent.costUsd != null && <span>${agent.costUsd.toFixed(2)}</span>}
          {agent.account && <span>{agent.account}</span>}
        </div>
      </div>
      <span className="mt-1 flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/60 transition-colors group-hover:text-primary">
        {cta} <ArrowUpRight className="size-3" />
      </span>
    </button>
  );
}

// ── the L3 transcript viewer — session-style, tool rows collapsible ──
function ScriptRow({
  e,
  open,
  onToggle,
}: {
  e: DemoScriptEntry;
  open: boolean;
  onToggle: () => void;
}) {
  switch (e.k) {
    case "say":
      return (
        <div className="text-sm leading-relaxed">
          <MessageResponse>{e.text}</MessageResponse>
        </div>
      );
    case "tool":
      return (
        <ToolStepRow
          part={{ type: "tool", name: e.name, input: e.input, output: e.output, isError: e.isError }}
          running={false}
          open={open}
          onToggle={onToggle}
        />
      );
    case "pw":
      return null; // pw folded into note/res below — kept exhaustive by the res/note cases
    case "res":
      return (
        <p className="flex items-center gap-1.5 text-xs">
          {e.ok ? (
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CircleX className="size-3.5 shrink-0 text-destructive" />
          )}
          <span className="text-muted-foreground">{e.text}</span>
        </p>
      );
    case "note":
      return (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
          {e.text}
        </p>
      );
    case "verdict":
      return (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-md border px-3 py-2.5 leading-relaxed",
            e.ok
              ? "border-emerald-500/30 bg-emerald-500/[0.05]"
              : "border-destructive/40 bg-destructive/[0.05]",
          )}
        >
          <div className="flex items-center gap-1.5 text-xs">
            {e.ok ? (
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CircleX className="size-3.5 shrink-0 text-destructive" />
            )}
            <span
              className={cn(
                "font-medium",
                e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
              )}
            >
              {e.ok ? "PASS" : "FAIL"}
            </span>
          </div>
          {e.text && (
            <div className="text-sm leading-relaxed">
              <MessageResponse>{e.text}</MessageResponse>
            </div>
          )}
        </div>
      );
    case "meta":
      return <p className="text-[11px] text-muted-foreground/70">{e.text}</p>;
    default:
      return null;
  }
}

// The "pw" (Playwright drive) row rendered inline — a distinct visual for a
// critic's live drive step vs. a builder's tool call.
function PwRow({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Play className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}

export function TranscriptView({ entries }: { entries: DemoScriptEntry[] }) {
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({});
  if (entries.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        No steps recorded on this session yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {entries.map((e, i) =>
        e.k === "pw" ? (
          <PwRow key={i} text={e.text} />
        ) : (
          <ScriptRow
            key={i}
            e={e}
            open={!!openRows[i]}
            onToggle={() => setOpenRows((o) => ({ ...o, [i]: !o[i] }))}
          />
        ),
      )}
    </div>
  );
}

// ── files-touched list ──
export function FilesTouched({ files }: { files: DemoFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {files.map((f, i) => (
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
  );
}

// A tiny inline status glyph reused by the org-chart / rows.
export function NowLine({ icon: Icon, children }: { icon?: typeof CircleAlert; children: React.ReactNode }) {
  const I = Icon ?? CircleAlert;
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
      <I className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-foreground/80">{children}</span>
    </div>
  );
}

// Copyable deep-link chip — gives the drawer a deep-linkable, wayfinding feel.
export function DeepLinkChip({ path }: { path: string }) {
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
