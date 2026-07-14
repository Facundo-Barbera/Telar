"use client";

// LANE: ultra (NEW) — round 26 v2. Renders §6 v2 (FROZEN) of
// docs/plans/ultra-harness.md: Ultra runs as SIDE QUESTS inside a real chat
// session. Session-window chrome (header · transcript · composer · the existing
// sub-agent RAIL) wraps compact, fixed-height run ANCHORS in the transcript; the
// rail gains a WORKFLOWS section — run cards, phase groups, per-agent rows
// (label · state · model·effort chip · masked-shimmer snippet · tokens/cost), a
// fixed-height narrator log() window, and a read-only Script tab. The story runs
// ≥2 runs concurrently plus 1 completed, shows the agent LAUNCHING, a
// model-validation REJECTION → re-author, the agent STOPPING one run by tool
// call, and REACTING to a completion. No budget UI anywhere — spend readouts
// only. Play/Pause/Restart/speed replay on virtual time. Fixtures only: a fake
// EventSource (setInterval over a virtual clock), no SDK; no Date.now on any
// SSR-reachable path.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CpuIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  MessagesSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/lib/format";
import { Segmented, Shimmer, StageFrame } from "./ui";
import {
  REJECTION,
  RUNS,
  SESSION_END,
  runEnd,
  type AgentDef,
  type AgentState,
  type JsonRecord,
  type RunDef,
  type RunState,
} from "./fixtures";

const usd = (n: number) => `$${n.toFixed(2)}`;

/* ------------------------------------------------------------ derive helpers */

function agentStateAt(
  a: AgentDef,
  localClock: number,
  localEnd: number,
  terminal: RunState,
): AgentState {
  const eff = Math.min(localClock, localEnd);
  const frozen = localClock >= localEnd && terminal !== "completed";
  let state: AgentState;
  if (eff < a.startAt) state = "queued";
  else if (a.retry && eff >= a.retry.failAt && eff < a.retry.retryAt) state = "retrying";
  else if (eff >= a.endAt) state = a.endState;
  else state = "running";
  if (frozen && (state === "running" || state === "retrying")) state = "stopped";
  return state;
}

function snippetAt(a: AgentDef, localClock: number, localEnd: number, st: AgentState): string {
  if (st === "queued") return "queued";
  if (st === "retrying") return a.retry?.error ?? "re-spawning…";
  if (st === "done") return a.snippets[a.snippets.length - 1]?.text ?? "done";
  if (st === "stopped") return "interrupted — partial work journaled";
  const eff = Math.min(localClock, localEnd);
  let text = a.snippets[0]?.text ?? "";
  for (const s of a.snippets) if (s.at <= eff) text = s.text;
  return text;
}

interface LifeEvent {
  at: number;
  kind: "log" | "spawn" | "done" | "fail" | "retry";
  text: string;
}

function lifecycleUpTo(run: RunDef, localCap: number): LifeEvent[] {
  const evs: LifeEvent[] = [];
  for (const l of run.log) evs.push({ at: l.at, kind: "log", text: l.text });
  for (const a of run.agents) {
    evs.push({ at: a.startAt, kind: "spawn", text: `spawned ${a.label}` });
    if (a.retry) {
      evs.push({ at: a.retry.failAt, kind: "fail", text: `${a.label} returned null` });
      evs.push({ at: a.retry.retryAt, kind: "retry", text: `${a.label} re-spawned (1/2)` });
    }
    evs.push({ at: a.endAt, kind: a.endState === "failed" ? "fail" : "done", text: `${a.label} ${a.endState}` });
  }
  return evs.filter((e) => e.at <= localCap).sort((x, y) => x.at - y.at);
}

interface RunDerived {
  state: RunState;
  live: boolean;
  localEnd: number;
  agentState: Map<number, AgentState>;
  spendUsd: number;
  tokens: number;
  done: number;
  total: number;
  progress: number;
}

function deriveRun(run: RunDef, clock: number, effStop: number | null): RunDerived {
  const { end, terminal } = runEnd(run, effStop);
  const localEnd = end - run.launchAt;
  const localClock = clock - run.launchAt;
  const state: RunState = clock >= end ? terminal : "running";
  const live = state === "running";
  const agentState = new Map<number, AgentState>();
  let spendUsd = 0;
  let tokens = 0;
  let done = 0;
  for (const a of run.agents) {
    const st = agentStateAt(a, localClock, localEnd, terminal);
    agentState.set(a.ordinal, st);
    if (st === "done") {
      spendUsd += a.costUsd;
      tokens += a.tokensIn + a.tokensOut;
      done += 1;
    }
  }
  const progress = localEnd > 0 ? Math.min(1, Math.max(0, localClock / localEnd)) : 0;
  return { state, live, localEnd, agentState, spendUsd, tokens, done, total: run.agents.length, progress };
}

function agentTokensAt(a: AgentDef, st: AgentState, localClock: number, localEnd: number): number {
  if (st === "done") return a.tokensIn + a.tokensOut;
  if (st === "queued") return 0;
  const eff = Math.min(localClock, localEnd);
  const frac = Math.min(1, Math.max(0, (eff - a.startAt) / (a.endAt - a.startAt)));
  return Math.max(0, Math.round((a.tokensIn + a.tokensOut) * frac));
}

/* -------------------------------------------------------------- small pieces */

const STATE_STYLE: Record<RunState, { cls: string; icon: LucideIcon }> = {
  running: { cls: "border-sky-500/30 bg-sky-500/10 text-sky-300", icon: ActivityIcon },
  completed: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", icon: CircleCheckIcon },
  stopped: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-300", icon: SquareIcon },
  failed: { cls: "border-destructive/40 bg-destructive/10 text-destructive", icon: TriangleAlertIcon },
};

function StatePill({ state }: { state: RunState }) {
  const s = STATE_STYLE[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize",
        s.cls,
      )}
    >
      <s.icon className={cn("size-2.5", state === "running" && "animate-pulse")} />
      {state}
    </span>
  );
}

const AGENT_DOT: Record<AgentState, string> = {
  queued: "bg-muted-foreground/40",
  running: "bg-sky-400",
  retrying: "bg-amber-400",
  done: "bg-emerald-400",
  failed: "bg-destructive",
  stopped: "bg-amber-400/70",
};

function ModelChip({ model, effort }: { model: string; effort: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] leading-none text-muted-foreground">
      {model}·{effort}
    </span>
  );
}

// The narrator log() window — a FIXED height, scrolling, never reflows (§6.3).
function NarratorLog({ events }: { events: LifeEvent[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // post-mount auto-scroll — never contributes to first render
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div className="rounded-md border border-border bg-muted/30">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ActivityIcon className="size-2.5" /> narrator
      </div>
      <div ref={ref} className="h-28 space-y-0.5 overflow-y-auto px-2 py-1.5">
        {events.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/50">— no output yet —</p>
        ) : (
          events.map((e, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
              <span
                className={cn(
                  "shrink-0",
                  e.kind === "log" && "text-indigo-400",
                  e.kind === "done" && "text-emerald-400",
                  e.kind === "fail" && "text-destructive",
                  e.kind === "retry" && "text-amber-400",
                  e.kind === "spawn" && "text-muted-foreground/50",
                )}
              >
                {e.kind === "log" ? "›" : e.kind === "done" ? "✓" : e.kind === "fail" ? "✕" : e.kind === "retry" ? "↻" : "+"}
              </span>
              <span
                className={cn(
                  "min-w-0 truncate",
                  e.kind === "log" ? "text-foreground" : "text-muted-foreground/70",
                )}
              >
                {e.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- agent row */

function AgentRow({
  a,
  state,
  snippet,
  tokens,
  selected,
  onOpen,
}: {
  a: AgentDef;
  state: AgentState;
  snippet: string;
  tokens: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const isFail = state === "failed";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/50",
        state === "queued" && "opacity-45",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_DOT[state])} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{a.label}</span>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            state === "running" && "text-sky-300",
            state === "retrying" && "text-amber-300",
            state === "done" && "text-emerald-300",
            state === "stopped" && "text-amber-300/80",
            isFail && "text-destructive",
            state === "queued" && "text-muted-foreground",
          )}
        >
          {state}
        </span>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground" />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-3">
        <ModelChip model={a.model} effort={a.effort} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {state === "running" || state === "retrying" ? (
            <Shimmer className="max-w-full truncate align-bottom">{snippet}</Shimmer>
          ) : isFail ? (
            <span className="text-destructive/80">{snippet}</span>
          ) : (
            snippet
          )}
        </span>
        <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
          {fmtTokens(tokens)}t
        </span>
        {state === "done" && (
          <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
            {usd(a.costUsd)}
          </span>
        )}
      </div>
    </button>
  );
}

/* --------------------------------------------------------------- phase group */

function PhaseGroup({
  title,
  kind,
  active,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  kind: "sequential" | "parallel";
  active: boolean;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={cn(!active && "opacity-45")}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 px-1 py-1 text-left">
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wide">{title}</span>
        <span className="shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
          {kind === "parallel" ? `∥ ${count}` : "seq"}
        </span>
        {!active && <span className="shrink-0 text-[9px] text-muted-foreground/70">pending</span>}
      </button>
      {open && active && <div className="space-y-0.5 pb-1 pl-2">{children}</div>}
    </section>
  );
}

/* --------------------------------------------------------------- json block */

function JsonBlock({ value }: { value: JsonRecord }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/* --------------------------------------------------------------- tool card */

function ToolCard({
  name,
  arg,
  ok,
  result,
}: {
  name: string;
  arg: string;
  ok: boolean;
  result: string;
}) {
  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2.5 py-1.5">
        <WorkflowIcon className={cn("size-3.5 shrink-0", ok ? "text-indigo-400" : "text-destructive")} />
        <span className="shrink-0 font-mono text-[11px] font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{arg}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11px]">
        <span className={cn("shrink-0", ok ? "text-emerald-400" : "text-destructive")}>{ok ? "→" : "✕"}</span>
        <span className={cn("min-w-0 truncate", ok ? "text-muted-foreground" : "text-destructive/90")}>{result}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the anchor */

// ONE compact, FIXED-HEIGHT tool-style row per run (§6.2). While running it
// never grows or reflows; its only permitted height change is a one-time
// collapse to a one-liner on reaching a terminal state (§6.7). Clicking focuses
// the run in the rail.
function RunAnchor({
  run,
  d,
  focused,
  onFocus,
  onResume,
}: {
  run: RunDef;
  d: RunDerived;
  focused: boolean;
  onFocus: () => void;
  onResume: () => void;
}) {
  const terminal = !d.live;
  return (
    <button
      type="button"
      onClick={onFocus}
      className={cn(
        "block w-full max-w-[92%] overflow-hidden rounded-lg border bg-card text-left transition-colors",
        focused ? "border-indigo-500/50 ring-1 ring-indigo-500/30" : "border-indigo-500/25 hover:border-indigo-500/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <WorkflowIcon className="size-3.5 shrink-0 text-indigo-400" />
        <span className="min-w-0 truncate text-xs font-semibold">{run.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{run.id}</span>
        <StatePill state={d.state} />
        <div className="min-w-0 flex-1" />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {d.done}/{d.total}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground">{usd(d.spendUsd)}</span>
        {terminal && d.state !== "completed" && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onResume();
            }}
            className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted"
          >
            <RotateCcwIcon className="size-2.5" /> Resume
          </span>
        )}
      </div>
      {/* running: fixed-height detail line + progress sliver. terminal: this
          block is dropped — the single permitted collapse to the one-liner. */}
      {!terminal && (
        <div className="px-2.5 pb-1.5">
          <p className="mb-1 truncate text-[11px] text-muted-foreground">{run.blurb}</p>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-indigo-400/80 transition-[width]" style={{ width: `${d.progress * 100}%` }} />
          </div>
        </div>
      )}
      {terminal && d.state === "completed" && (
        <div className="px-2.5 pb-1.5">
          <p className="truncate text-[11px] text-muted-foreground">
            {run.blurb} · result in the rail →
          </p>
        </div>
      )}
    </button>
  );
}

/* ================================================================= the demo */

type RailSel =
  | { kind: "main" }
  | { kind: "run"; runId: string; tab: "flow" | "script" }
  | { kind: "agent"; runId: string; ordinal: number };

export function SessionUltraDemo() {
  const [clock, setClock] = useState(SESSION_END);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.5);
  const [sel, setSel] = useState<RailSel>({ kind: "run", runId: "ultra_a1c", tab: "flow" });
  const [railOpen, setRailOpen] = useState(true);
  const [openPhases, setOpenPhases] = useState<Record<string, boolean>>({});
  const [manualStop, setManualStop] = useState<Record<string, number>>({});
  const [resumed, setResumed] = useState<Record<string, boolean>>({});
  const [ultraArmed, setUltraArmed] = useState(false);

  // The fake EventSource: advance the virtual session clock while playing.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setClock((c) => {
        const next = c + 130 * speed;
        if (next >= SESSION_END) {
          setPlaying(false);
          return SESSION_END;
        }
        return next;
      });
    }, 90);
    return () => clearInterval(id);
  }, [playing, speed]);

  const effStop = (run: RunDef): number | null =>
    resumed[run.id] ? null : manualStop[run.id] ?? run.stopAt;

  const derived = useMemo(() => {
    const m = new Map<string, RunDerived>();
    for (const run of RUNS) m.set(run.id, deriveRun(run, clock, effStop(run)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, manualStop, resumed]);

  const launched = RUNS.filter((r) => clock >= r.launchAt);
  const liveRuns = launched.filter((r) => derived.get(r.id)!.live);

  /* --------------------------------------------------------------- actions */
  function togglePlay() {
    if (playing) return setPlaying(false);
    if (clock >= SESSION_END) resetTo(0);
    setPlaying(true);
  }
  function resetTo(t: number) {
    setManualStop({});
    setResumed({});
    setClock(t);
  }
  function restart() {
    resetTo(0);
    setPlaying(true);
  }
  function stopRun(runId: string) {
    setPlaying(false);
    setManualStop((m) => ({ ...m, [runId]: clock }));
  }
  function resumeRun(runId: string) {
    setResumed((r) => ({ ...r, [runId]: true }));
    setManualStop((m) => {
      const { [runId]: _drop, ...rest } = m;
      return rest;
    });
  }
  function focusRun(runId: string) {
    setSel({ kind: "run", runId, tab: "flow" });
    setRailOpen(true);
  }
  function phaseKey(runId: string, phaseId: string) {
    return `${runId}:${phaseId}`;
  }

  /* -------------------------------------------------------------- controls */
  const controls = (
    <>
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={togglePlay}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {playing ? "Pause" : clock >= SESSION_END ? "Replay" : "Play"}
        </button>
        <button
          type="button"
          onClick={restart}
          title="Restart"
          className="inline-flex items-center rounded-md border border-border bg-card p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RotateCcwIcon className="size-3.5" />
        </button>
      </div>
      <Segmented<`${number}`>
        value={`${speed}` as `${number}`}
        onChange={(v) => setSpeed(Number(v))}
        options={[
          { value: "1", label: "1×" },
          { value: "1.5", label: "1.5×" },
          { value: "3", label: "3×" },
        ]}
      />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        t={Math.round(clock / 100) / 10}s
      </span>
    </>
  );

  /* ---------------------------------------------------------- rail: agent view */
  function agentView(run: RunDef, ordinal: number) {
    const a = run.agents.find((x) => x.ordinal === ordinal)!;
    const st = derived.get(run.id)!.agentState.get(ordinal) ?? "queued";
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setSel({ kind: "run", runId: run.id, tab: "flow" })}
            className="-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeftIcon className="size-3" /> {run.name}
          </button>
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
          <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_DOT[st])} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{a.label}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ModelChip model={a.model} effort={a.effort} />
            <span className="text-[10px] text-muted-foreground">{st}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {fmtTokens(a.tokensIn + a.tokensOut)}t · {usd(a.costUsd)}
            </span>
          </div>
          {a.transcript.map((s, i) => (
            <div key={i} className="text-[11px]">
              {s.kind === "text" && <p className="text-muted-foreground">{s.text}</p>}
              {s.kind === "tool" && (
                <div className="rounded border border-border bg-muted/40 px-2 py-1 font-mono">
                  <span className="text-indigo-300">{s.tool}</span> <span className="text-muted-foreground">{s.input}</span>
                </div>
              )}
              {s.kind === "tool-result" && <p className="pl-2 font-mono text-muted-foreground/70">→ {s.text}</p>}
              {s.kind === "result" && (
                <div>
                  <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase text-emerald-400">
                    <CircleCheckIcon className="size-2.5" /> emit_result
                  </div>
                  <JsonBlock value={s.json} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------------- rail: run view */
  function runView(run: RunDef, tab: "flow" | "script") {
    const d = derived.get(run.id)!;
    const localCap = Math.min(clock - run.launchAt, d.localEnd);
    const events = lifecycleUpTo(run, localCap);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* run card header — name · state · spend · Stop/Resume (§6.3) */}
        <div className="border-b border-border px-2.5 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSel({ kind: "main" })}
              title="All workflows"
              className="-ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <WorkflowIcon className="size-3.5 shrink-0 text-indigo-400" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{run.name}</span>
            <StatePill state={d.state} />
          </div>
          <div className="mt-1 flex items-center gap-2 pl-5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {d.done}/{d.total} agents · {usd(d.spendUsd)} · {fmtTokens(d.tokens)}t
            </span>
            <div className="ml-auto flex items-center gap-1">
              {d.live ? (
                <button
                  type="button"
                  onClick={() => stopRun(run.id)}
                  className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/20"
                >
                  <SquareIcon className="size-2.5" /> Stop
                </button>
              ) : d.state !== "completed" ? (
                <button
                  type="button"
                  onClick={() => resumeRun(run.id)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted"
                >
                  <RotateCcwIcon className="size-2.5" /> Resume
                </button>
              ) : null}
            </div>
          </div>
        </div>
        {/* tabs */}
        <div className="flex items-center gap-1 border-b border-border px-2 py-1">
          {(
            [
              { k: "flow", label: "Workflow", icon: WorkflowIcon },
              { k: "script", label: "Script", icon: FileCode2Icon },
            ] as const
          ).map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setSel({ kind: "run", runId: run.id, tab: t.k })}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                tab === t.k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-3" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "flow" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {run.phases.map((p) => {
                const phaseAgents = run.agents.filter((a) => a.phaseId === p.id);
                const active = clock - run.launchAt >= p.activateAt;
                const key = phaseKey(run.id, p.id);
                const open = openPhases[key] ?? true;
                return (
                  <PhaseGroup
                    key={p.id}
                    title={p.title}
                    kind={p.kind}
                    active={active}
                    count={phaseAgents.length}
                    open={open}
                    onToggle={() => setOpenPhases((o) => ({ ...o, [key]: !open }))}
                  >
                    {phaseAgents.map((a) => {
                      const st = d.agentState.get(a.ordinal) ?? "queued";
                      return (
                        <AgentRow
                          key={a.ordinal}
                          a={a}
                          state={st}
                          snippet={snippetAt(a, clock - run.launchAt, d.localEnd, st)}
                          tokens={agentTokensAt(a, st, clock - run.launchAt, d.localEnd)}
                          selected={sel.kind === "agent" && sel.runId === run.id && sel.ordinal === a.ordinal}
                          onOpen={() => setSel({ kind: "agent", runId: run.id, ordinal: a.ordinal })}
                        />
                      );
                    })}
                  </PhaseGroup>
                );
              })}
            </div>
            {/* fixed-height narrator log window — never shifts layout */}
            <div className="shrink-0 border-t border-border p-2">
              <NarratorLog events={events} />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
            <a
              href="#authoring-reference"
              onClick={(e) => e.preventDefault()}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileCode2Icon className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Ultra authoring reference</span>
              <ExternalLinkIcon className="size-3 shrink-0" />
            </a>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
              {run.script}
            </pre>
          </div>
        )}
      </div>
    );
  }

  /* ------------------------------------------------------- rail: workflows list */
  function workflowsList() {
    return (
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        <div className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Workflows · {launched.length}
        </div>
        {launched.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/60">No runs launched yet.</p>
        )}
        {launched.map((run) => {
          const d = derived.get(run.id)!;
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => focusRun(run.id)}
              className="block w-full rounded-lg border border-border bg-card px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <WorkflowIcon className={cn("size-3.5 shrink-0", d.live ? "text-indigo-400" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{run.name}</span>
                <StatePill state={d.state} />
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-5">
                {d.live && (
                  <Shimmer className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {run.blurb}
                  </Shimmer>
                )}
                {!d.live && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">{run.blurb}</span>
                )}
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
                  {d.done}/{d.total}
                </span>
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">{usd(d.spendUsd)}</span>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  /* --------------------------------------------------------------------- rail */
  const runningCount = liveRuns.length;
  const rail = railOpen ? (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Sub-agents</span>
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 font-mono text-[10px] text-foreground">
            <Shimmer className="text-[9px] leading-none">●</Shimmer>
            {runningCount}
          </span>
        )}
        <button
          type="button"
          onClick={() => setRailOpen(false)}
          aria-label="Collapse rail"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>
      {/* pinned Main anchor — never scrolls with the content */}
      <div className="border-b border-border p-2">
        <button
          type="button"
          onClick={() => setSel({ kind: "main" })}
          aria-current={sel.kind === "main" ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
            sel.kind === "main"
              ? "border-ring bg-muted/60 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground",
          )}
        >
          <MessagesSquareIcon className={cn("size-4 shrink-0", sel.kind === "main" ? "text-primary" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">Quick wins on telar-core</span>
          {sel.kind === "main" ? (
            <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-primary">Here</span>
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
          )}
        </button>
      </div>

      {sel.kind === "main"
        ? workflowsList()
        : sel.kind === "agent"
          ? agentView(RUNS.find((r) => r.id === sel.runId)!, sel.ordinal)
          : runView(RUNS.find((r) => r.id === sel.runId)!, sel.tab)}
    </aside>
  ) : (
    <button
      type="button"
      onClick={() => setRailOpen(true)}
      aria-label="Open sub-agents rail"
      className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-border bg-card py-3 text-muted-foreground hover:text-foreground"
    >
      <PanelRightOpenIcon className="size-4" />
      {runningCount > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Shimmer className="text-[10px] leading-none">●</Shimmer>
          <span className="font-mono text-[10px]">{runningCount}</span>
        </span>
      )}
      <span className="[writing-mode:vertical-rl] text-[10px] font-medium">workflows</span>
    </button>
  );

  /* ----------------------------------------------------------------- render */
  const aReached = clock >= runEnd(RUNS[0], null).end;
  const totalLiveSpend = liveRuns.reduce((s, r) => s + derived.get(r.id)!.spendUsd, 0);

  return (
    <StageFrame controls={() => controls}>
      {() => (
        <div className="flex h-full">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
                {/* session header */}
                <div className="flex items-center gap-2 border-b border-border pb-2">
                  <span className="min-w-0 truncate text-sm font-semibold">Quick wins on telar-core</span>
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    claude · opus-4.8
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <CpuIcon className="size-3" /> ultra side quests
                  </span>
                </div>

                {/* user message — ultra-annotated */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-muted/40 px-3 py-2">
                    <div className="mb-1 flex items-center justify-end">
                      <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                        <SparklesIcon className="size-2.5" /> ultra:true
                      </span>
                    </div>
                    <p className="text-sm">
                      ultra: knock out the quick-wins batch — recon the core, fix types, tests &amp; docs in parallel,
                      gate it, and commit.
                    </p>
                  </div>
                </div>

                <div className="max-w-[92%] text-sm text-muted-foreground">
                  The message is Ultra-annotated — authoring a run.
                </div>

                {/* model-validation REJECTION → re-author (§6.5) */}
                {clock >= 200 && (
                  <>
                    <ToolCard
                      name="ultra"
                      arg="{ script, args:{ batch:'quick-wins' } }"
                      ok={false}
                      result={`${REJECTION.error} — ${REJECTION.detail} (line ${REJECTION.line})`}
                    />
                    <div className="max-w-[92%] text-sm text-muted-foreground">
                      Right — every <code className="font-mono text-xs">agent()</code> must name its model. Re-authoring
                      with <code className="font-mono text-xs">model·effort</code> pins.
                    </div>
                  </>
                )}

                {/* launch A */}
                {clock >= 600 && (
                  <>
                    <ToolCard name="ultra" arg="{ script(fixed), args:{ batch:'quick-wins' } }" ok result="{ runId: 'ultra_a1c' }" />
                    {(() => {
                      const run = RUNS[0];
                      const d = derived.get(run.id)!;
                      return (
                        <RunAnchor
                          run={run}
                          d={d}
                          focused={sel.kind !== "main" && sel.runId === run.id}
                          onFocus={() => focusRun(run.id)}
                          onResume={() => resumeRun(run.id)}
                        />
                      );
                    })()}
                    <div className="max-w-[92%] text-sm text-muted-foreground">
                      Launched — it detaches and runs in the background; I&apos;ll summarize when it lands. Keep talking.
                    </div>
                  </>
                )}

                {/* continue the conversation while A runs → launch B */}
                {clock >= 1600 && (
                  <>
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-muted/40 px-3 py-2 text-sm">
                        while that runs — are the docs stale anywhere?
                      </div>
                    </div>
                    <div className="max-w-[92%] text-sm text-muted-foreground">
                      I&apos;ll sweep them in parallel too — loop-until-dry, no ceiling.
                    </div>
                  </>
                )}
                {clock >= 2200 && (
                  <>
                    <ToolCard name="ultra" arg="{ script, args:{ scope:'docs/**' } }" ok result="{ runId: 'ultra_b2d' }" />
                    {(() => {
                      const run = RUNS[1];
                      const d = derived.get(run.id)!;
                      return (
                        <RunAnchor
                          run={run}
                          d={d}
                          focused={sel.kind !== "main" && sel.runId === run.id}
                          onFocus={() => focusRun(run.id)}
                          onResume={() => resumeRun(run.id)}
                        />
                      );
                    })()}
                  </>
                )}

                {/* launch C */}
                {clock >= 3000 && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-muted/40 px-3 py-2 text-sm">
                      and the flaky tests have been annoying me — triage those too.
                    </div>
                  </div>
                )}
                {clock >= 3400 && (
                  <>
                    <ToolCard name="ultra" arg="{ script, args:{ suites:['journal','abort'] } }" ok result="{ runId: 'ultra_c3f' }" />
                    {(() => {
                      const run = RUNS[2];
                      const d = derived.get(run.id)!;
                      return (
                        <RunAnchor
                          run={run}
                          d={d}
                          focused={sel.kind !== "main" && sel.runId === run.id}
                          onFocus={() => focusRun(run.id)}
                          onResume={() => resumeRun(run.id)}
                        />
                      );
                    })()}
                    <div className="max-w-[92%] text-sm text-muted-foreground">
                      Three runs live now — watch them in the rail. All keyed by <code className="font-mono text-xs">runId</code>.
                    </div>
                  </>
                )}

                {/* react to A's completion event by summarizing (§6.5) */}
                {aReached && (
                  <>
                    <ToolCard name="event" arg="ultra_a1c → completed" ok result="{ state:'completed', result:{…} }" />
                    <div className="max-w-[92%] space-y-1 text-sm">
                      <p>
                        <b>Quick-wins batch</b> landed. Recon mapped 2 modules (12 type errors + 3 flaky tests); all three
                        lanes shipped — <b>types</b> 12/4 files, <b>tests</b> 3 flakes fixed (one lane returned null once and
                        was re-spawned by validate-and-retry), <b>docs</b> 2 files. Gate green, committed{" "}
                        <code className="font-mono text-xs">4f2a1c9</code> (not pushed).
                      </p>
                      <p className="text-muted-foreground">
                        Spend {usd(1.95)} across 8 agents — folded into this turn&apos;s usage. Full result is on the run&apos;s
                        rail card.
                      </p>
                    </div>
                  </>
                )}

                {/* agent STOPS run C by tool call (§6.5) */}
                {clock >= 10800 && (
                  <>
                    <div className="max-w-[92%] text-sm text-muted-foreground">
                      The triage run overlaps the tests lane that just landed — stopping it to save the spend.
                    </div>
                    <ToolCard name="ultra_stop" arg="{ runId:'ultra_c3f' }" ok result="{ state:'stopped', journalKept:true }" />
                  </>
                )}

                {/* composer + dock live in a sticky footer so neither overlaps */}
                <div className="sticky bottom-0 -mx-4 space-y-2 bg-background/80 px-4 pb-1 pt-2 backdrop-blur">
                  {liveRuns.length > 0 && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => focusRun(liveRuns[0].id)}
                        className="inline-flex items-center gap-2 rounded-full border border-indigo-500/40 bg-card px-3 py-1.5 shadow-sm"
                      >
                        <span className="relative flex size-2 shrink-0">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/60" />
                          <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
                        </span>
                        <span className="text-[11px] font-medium">
                          {liveRuns.length === 1 ? liveRuns[0].name : `${liveRuns.length} runs live`}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          running · {usd(totalLiveSpend)}
                        </span>
                      </button>
                    </div>
                  )}
                  <div className="rounded-xl border border-border bg-card p-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setUltraArmed((a) => !a)}
                        title="Arm ultra on the next message"
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors",
                          ultraArmed
                            ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-300"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <SparklesIcon className={cn("size-3", ultraArmed && "animate-pulse")} />
                        Ultra
                      </button>
                      <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground/70">
                        {ultraArmed ? "next message → ultra:true (arms the tool — no ceiling to set)" : "Message the agent…"}
                      </div>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">⏎</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {rail}
        </div>
      )}
    </StageFrame>
  );
}
