"use client";

// LANE: ultra (NEW) — round 26 "Session — Ultra runs". Renders EXACTLY the
// frozen UI CONTRACT (§6 of docs/plans/ultra-harness.md): the composer Ultra
// chip, the in-transcript RUN BLOCK (header + budget meter + phase groups +
// per-agent rows + interleaved narrator log), the SubagentRail inspector
// (per-agent transcript / script view / budget meter), the terminal states
// (completed result / stopped+resume / failed+resume), and the live-run dock
// bubble. Fixtures only — a setInterval fake of /api/ultra/[id]/events, no SDK.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  BoxesIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDollarSignIcon,
  CircleXIcon,
  CpuIcon,
  FileCode2Icon,
  GaugeIcon,
  GitCommitHorizontalIcon,
  LoaderIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/lib/format";
import { Segmented, Shimmer, StageFrame } from "./ui";
import {
  AGENTS,
  FINAL_RESULT,
  LOG_LINES,
  PHASES,
  RUN_ARGS,
  RUN_META,
  SCENARIOS,
  SCRIPT_SOURCE,
  type AgentDef,
  type AgentState,
  type JsonRecord,
  type Provider,
  type RunState,
  type Scenario,
} from "./fixtures";

type ScenarioKey = "completed" | "stopped" | "failed";

const usd = (n: number) => `$${n.toFixed(2)}`;

/* ------------------------------------------------------------ derive helpers */

// The run's terminal is "reached" once the clock hits the (possibly
// user-shortened) end. Before that the run is LIVE.
function agentStateAt(a: AgentDef, clock: number, scn: Scenario): AgentState {
  const eff = Math.min(clock, scn.endClock);
  const frozen = clock >= scn.endClock && scn.terminal !== "completed";
  let state: AgentState;
  if (eff < a.startAt) state = "queued";
  else if (a.retry && eff >= a.retry.failAt && eff < a.retry.retryAt)
    state = "retrying";
  else if (eff >= a.endAt) state = a.endState;
  else state = "running";
  // A cut run (stopped/failed) interrupts anything still in flight.
  if (frozen && (state === "running" || state === "retrying")) state = "stopped";
  return state;
}

function snippetAt(a: AgentDef, clock: number, scn: Scenario, st: AgentState): string {
  if (st === "queued") return "queued";
  if (st === "retrying") return a.retry?.error ?? "re-spawning…";
  if (st === "done") return a.snippets[a.snippets.length - 1]?.text ?? "done";
  if (st === "stopped") return "interrupted — partial work journaled";
  const eff = Math.min(clock, scn.endClock);
  let text = a.snippets[0]?.text ?? "";
  for (const s of a.snippets) if (s.at <= eff) text = s.text;
  return text;
}

interface LifecycleEvent {
  at: number;
  kind: "log" | "spawn" | "done" | "fail" | "retry";
  text: string;
}

function lifecycleUpTo(clock: number, scn: Scenario): LifecycleEvent[] {
  const cap = Math.min(clock, scn.endClock);
  const evs: LifecycleEvent[] = [];
  for (const l of LOG_LINES) evs.push({ at: l.at, kind: "log", text: l.text });
  for (const a of AGENTS) {
    evs.push({ at: a.startAt, kind: "spawn", text: `spawned ${a.label}` });
    if (a.retry) {
      evs.push({ at: a.retry.failAt, kind: "fail", text: `${a.label} returned null` });
      evs.push({ at: a.retry.retryAt, kind: "retry", text: `${a.label} re-spawned (1/2)` });
    }
    evs.push({
      at: a.endAt,
      kind: a.endState === "failed" ? "fail" : "done",
      text: `${a.label} ${a.endState}`,
    });
  }
  return evs
    .filter((e) => e.at <= cap)
    .sort((x, y) => x.at - y.at);
}

/* -------------------------------------------------------------- small pieces */

const STATE_STYLE: Record<
  RunState,
  { label: string; cls: string; icon: LucideIcon }
> = {
  running: {
    label: "running",
    cls: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    icon: ActivityIcon,
  },
  completed: {
    label: "completed",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    icon: CircleCheckIcon,
  },
  stopped: {
    label: "stopped",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    icon: SquareIcon,
  },
  failed: {
    label: "failed",
    cls: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: CircleXIcon,
  },
};

function StatePill({ state }: { state: RunState }) {
  const s = STATE_STYLE[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.cls,
      )}
    >
      <s.icon className={cn("size-3", state === "running" && "animate-pulse")} />
      {s.label}
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

function BudgetMeter({
  provider,
  spent,
  reserved,
  total,
  tokens,
}: {
  provider: Provider;
  spent: number;
  reserved: number;
  total: number;
  tokens: number;
}) {
  if (provider === "codex") {
    // §3 carve-out: the USD ceiling is BLOCKED on Codex until the driver's
    // tokens×price table (Open Q4) lands. Token count is informational only —
    // there is no token-only USD path, so no ceiling bar is shown.
    return (
      <div className="flex min-w-0 items-center gap-2">
        <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs tabular-nums">{fmtTokens(tokens)} tok</span>
        <span
          className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
          title="codex-app-server exposes tokens only; USD reservation is blocked on the codex-driver price table (Open Q4)."
        >
          USD ceiling blocked · Codex
        </span>
      </div>
    );
  }
  const pct = Math.min(100, (spent / total) * 100);
  const resPct = Math.min(100 - pct, (reserved / total) * 100);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <CircleDollarSignIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
        <div className="flex h-full">
          <div className="h-full bg-emerald-400" style={{ width: `${pct}%` }} />
          {/* reserved-but-unsettled headroom (reservation-based admission) */}
          <div className="h-full bg-sky-400/40" style={{ width: `${resPct}%` }} />
        </div>
      </div>
      <span className="font-mono text-xs tabular-nums text-foreground">
        {usd(spent)}
        <span className="text-muted-foreground"> / {usd(total)}</span>
      </span>
      {reserved > 0 && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-sky-300/80">
          +{usd(reserved)} reserved
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- agent row */

function AgentRow({
  a,
  state,
  snippet,
  tokens,
  cost,
  provider,
  selected,
  onOpen,
}: {
  a: AgentDef;
  state: AgentState;
  snippet: string;
  tokens: number;
  cost: number;
  provider: Provider;
  selected: boolean;
  onOpen: () => void;
}) {
  const dim = state === "queued";
  const isFail = state === "failed";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted/50",
        dim && "opacity-45",
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_DOT[state])} />
      <span className="w-24 shrink-0 truncate font-mono text-xs">{a.label}</span>
      <span
        className={cn(
          "w-16 shrink-0 text-[11px]",
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
      {/* live activity snippet — running rows carry the masked shimmer */}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {state === "running" || state === "retrying" ? (
          <Shimmer className="max-w-full truncate align-bottom">{snippet}</Shimmer>
        ) : isFail ? (
          <span className="text-destructive/80">{snippet}</span>
        ) : (
          snippet
        )}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {fmtTokens(tokens)}t
      </span>
      {provider === "claude" && (
        <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {cost > 0 ? `$${cost.toFixed(2)}` : "—"}
        </span>
      )}
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
    </button>
  );
}

/* --------------------------------------------------------------- phase group */

function PhaseGroup({
  title,
  kind,
  active,
  rows,
  open,
  onToggle,
}: {
  title: string;
  kind: "sequential" | "parallel";
  active: boolean;
  rows: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  const count = Array.isArray(rows) ? rows.length : 0;
  return (
    <section className={cn(!active && "opacity-45")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          {title}
        </span>
        <span className="rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
          {kind === "parallel" ? `∥ ${count}` : "seq"}
        </span>
        {!active && (
          <span className="text-[10px] text-muted-foreground/70">pending</span>
        )}
      </button>
      {open && active && <div className="space-y-0.5 pb-1 pl-3">{rows}</div>}
    </section>
  );
}

/* --------------------------------------------------------------- json block */

function JsonBlock({ value }: { value: JsonRecord }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/* ================================================================= the demo */

export function SessionUltraDemo() {
  const [clock, setClock] = useState(SCENARIOS.completed.endClock);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.5);
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>("completed");
  const [stopClock, setStopClock] = useState<number | null>(null);
  const [provider, setProvider] = useState<Provider>("claude");

  const [blockCollapsed, setBlockCollapsed] = useState(false);
  const [openPhases, setOpenPhases] = useState<Record<string, boolean>>({
    recon: true,
    lanes: true,
    gate: true,
    commit: true,
  });
  const [railOpen, setRailOpen] = useState(true);
  const [railTab, setRailTab] = useState<"agent" | "script" | "budget">("agent");
  const [selectedAgent, setSelectedAgent] = useState<string>("lane-tests");
  const [resultOpen, setResultOpen] = useState(true);
  const [ultraArmed, setUltraArmed] = useState(false);

  // Effective scenario — Stop shortens `stopped` to the moment the user hit it.
  const scn: Scenario = useMemo(() => {
    const base = SCENARIOS[scenarioKey];
    if (scenarioKey === "stopped" && stopClock != null)
      return { ...base, endClock: stopClock };
    return base;
  }, [scenarioKey, stopClock]);

  const terminalReached = clock >= scn.endClock;
  const runState: RunState = terminalReached ? scn.terminal : "running";
  const isLive = !terminalReached;

  // The fake EventSource: advance the virtual clock while playing.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setClock((c) => {
        const next = c + 120 * speed;
        if (next >= scn.endClock) {
          setPlaying(false);
          return scn.endClock;
        }
        return next;
      });
    }, 90);
    return () => clearInterval(id);
  }, [playing, speed, scn.endClock]);

  // Contract: default expanded while running, auto-collapsed on terminal.
  useEffect(() => {
    setBlockCollapsed(terminalReached);
  }, [terminalReached]);

  const derived = useMemo(() => {
    const map = new Map<string, AgentState>();
    let spent = 0;
    let reserved = 0;
    let tokens = 0;
    let started = 0;
    for (const a of AGENTS) {
      const st = agentStateAt(a, clock, scn);
      map.set(a.id, st);
      if (st !== "queued") started += 1;
      if (st === "done") {
        spent += a.costUsd;
        tokens += a.tokensIn + a.tokensOut;
      }
      if (st === "running" || st === "retrying") reserved += a.reservedUsd;
    }
    return { map, spent, reserved, tokens, started };
  }, [clock, scn]);

  const perPhaseSpend = useMemo(() => {
    return PHASES.map((p) => {
      let s = 0;
      for (const a of AGENTS)
        if (a.phaseId === p.id && derived.map.get(a.id) === "done") s += a.costUsd;
      return { id: p.id, title: p.title, spent: s };
    });
  }, [derived.map]);

  const events = useMemo(() => lifecycleUpTo(clock, scn), [clock, scn]);

  // Dock visibility — show while the run is LIVE and the block scrolls off.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const [blockInView, setBlockInView] = useState(true);
  useEffect(() => {
    const root = scrollRef.current;
    const target = blockRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      ([e]) => setBlockInView(e.isIntersecting),
      { root, threshold: 0.05 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, []);

  const codexFailBlocked = provider === "codex";

  function selectScenario(key: ScenarioKey) {
    if (key === "failed" && codexFailBlocked) return;
    setScenarioKey(key);
    setStopClock(null);
    setPlaying(false);
    setClock(SCENARIOS[key].endClock);
  }
  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (clock >= scn.endClock) setClock(0);
    setPlaying(true);
  }
  function restart() {
    setStopClock(null);
    setClock(0);
    setPlaying(true);
  }
  function stopRun() {
    // The one live control that acts on the run: Stop → the AbortController.
    setPlaying(false);
    setScenarioKey("stopped");
    setStopClock(clock);
  }
  function openAgent(id: string) {
    setSelectedAgent(id);
    setRailTab("agent");
    setRailOpen(true);
  }

  const selected = AGENTS.find((a) => a.id === selectedAgent) ?? AGENTS[0];

  /* ------------------------------------------------------------- controls */
  const controls = (
    <>
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={togglePlay}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          {playing ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          {playing ? "Pause" : clock >= scn.endClock ? "Replay" : "Play"}
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
      <span className="text-[11px] text-muted-foreground">ending</span>
      <div className="inline-flex items-center gap-1">
        {(["completed", "stopped", "failed"] as ScenarioKey[]).map((k) => {
          const on = scenarioKey === k;
          const blocked = k === "failed" && codexFailBlocked;
          return (
            <button
              key={k}
              type="button"
              disabled={blocked}
              onClick={() => selectScenario(k)}
              title={
                blocked
                  ? "No budget failure on Codex — USD ceiling is blocked (Q4)"
                  : undefined
              }
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                blocked && "cursor-not-allowed opacity-40",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {k}
            </button>
          );
        })}
      </div>
      <Segmented<Provider>
        value={provider}
        onChange={(p) => {
          setProvider(p);
          if (p === "codex" && scenarioKey === "failed") selectScenario("completed");
        }}
        options={[
          {
            value: "claude",
            label: (
              <span className="flex items-center gap-1">
                <SparklesIcon className="size-3" /> Claude
              </span>
            ),
          },
          {
            value: "codex",
            label: (
              <span className="flex items-center gap-1">
                <BoxesIcon className="size-3" /> Codex
              </span>
            ),
          },
        ]}
      />
    </>
  );

  /* ------------------------------------------------------------- run block */
  const runHeader = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <button
        type="button"
        onClick={() => setBlockCollapsed((c) => !c)}
        className="flex min-w-0 items-center gap-1.5"
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            !blockCollapsed && "rotate-90",
          )}
        />
        <WorkflowIcon className="size-4 shrink-0 text-indigo-400" />
        <span className="truncate text-sm font-semibold">{RUN_META.name}</span>
      </button>
      <StatePill state={runState} />
      <div className="min-w-0 flex-1" />
      <BudgetMeter
        provider={provider}
        spent={derived.spent}
        reserved={isLive ? derived.reserved : 0}
        total={scn.budgetUsd}
        tokens={derived.tokens}
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {derived.started}/{AGENTS.length} agents
      </span>
      {isLive && (
        <button
          type="button"
          onClick={stopRun}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20"
        >
          <SquareIcon className="size-3" /> Stop
        </button>
      )}
    </div>
  );

  const runBlock = (
    <div
      ref={blockRef}
      className="overflow-hidden rounded-xl border border-indigo-500/25 bg-card"
    >
      <div className="border-b border-border bg-indigo-500/[0.03] px-3 py-2">
        {runHeader}
        {blockCollapsed && (
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            {RUN_META.description} · {AGENTS.length} agents ·{" "}
            {provider === "claude" ? usd(derived.spent) : `${fmtTokens(derived.tokens)} tok`}
          </p>
        )}
      </div>

      {!blockCollapsed && (
        <div className="grid gap-2 p-2 md:grid-cols-[1fr_minmax(0,15rem)]">
          {/* phase groups + rows */}
          <div className="space-y-1">
            {PHASES.map((p) => {
              const phaseAgents = AGENTS.filter((a) => a.phaseId === p.id);
              const active = clock >= p.activateAt;
              return (
                <PhaseGroup
                  key={p.id}
                  title={p.title}
                  kind={p.kind}
                  active={active}
                  open={openPhases[p.id]}
                  onToggle={() =>
                    setOpenPhases((o) => ({ ...o, [p.id]: !o[p.id] }))
                  }
                  rows={phaseAgents.map((a) => {
                    const st = derived.map.get(a.id) ?? "queued";
                    const eff = Math.min(clock, scn.endClock);
                    const tk =
                      st === "done"
                        ? a.tokensIn + a.tokensOut
                        : st === "queued"
                          ? 0
                          : Math.round(
                              (a.tokensIn + a.tokensOut) *
                                Math.min(1, (eff - a.startAt) / (a.endAt - a.startAt)),
                            );
                    return (
                      <AgentRow
                        key={a.id}
                        a={a}
                        state={st}
                        snippet={snippetAt(a, clock, scn, st)}
                        tokens={Math.max(0, tk)}
                        cost={st === "done" ? a.costUsd : 0}
                        provider={provider}
                        selected={selectedAgent === a.id && railOpen}
                        onOpen={() => openAgent(a.id)}
                      />
                    );
                  })}
                />
              );
            })}
          </div>

          {/* interleaved narrator log() + agent-row state changes */}
          <div className="rounded-lg border border-border bg-muted/30 p-2">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <ActivityIcon className="size-3" /> lifecycle log
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {events.length === 0 && (
                <p className="text-[11px] text-muted-foreground/60">— press Play —</p>
              )}
              {events.map((e, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-baseline gap-1.5 text-[11px]",
                    e.kind === "log"
                      ? "text-foreground"
                      : "text-muted-foreground/70",
                  )}
                >
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
                    {e.kind === "log"
                      ? "›"
                      : e.kind === "done"
                        ? "✓"
                        : e.kind === "fail"
                          ? "✕"
                          : e.kind === "retry"
                            ? "↻"
                            : "+"}
                  </span>
                  <span className="min-w-0 truncate">{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /* --------------------------------------------------------- terminal block */
  const terminalBlock = (() => {
    if (runState === "completed") {
      return (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04]">
          <button
            type="button"
            onClick={() => setResultOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-2"
          >
            <ChevronRightIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                resultOpen && "rotate-90",
              )}
            />
            <CircleCheckIcon className="size-4 text-emerald-400" />
            <span className="text-xs font-semibold">Result</span>
            <span className="text-[11px] text-muted-foreground">
              returned to the main agent
            </span>
          </button>
          {resultOpen && (
            <div className="px-3 pb-3">
              <JsonBlock value={FINAL_RESULT} />
            </div>
          )}
        </div>
      );
    }
    if (runState === "stopped") {
      return (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2.5">
          <SquareIcon className="size-4 shrink-0 text-amber-400" />
          <span className="text-xs font-medium text-amber-200">Stopped by you</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            partial journal kept · {derived.started} agents journaled, in-flight interrupted
          </span>
          <button
            type="button"
            onClick={restart}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-muted"
          >
            <RotateCcwIcon className="size-3" /> Resume
          </button>
        </div>
      );
    }
    // failed
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.05] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
          <span className="text-xs font-medium text-destructive">
            failed · budget
          </span>
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={restart}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-muted"
          >
            <RotateCcwIcon className="size-3" /> Resume (edit budget)
          </button>
        </div>
        <p className="mt-1 pl-6 font-mono text-[11px] leading-relaxed text-destructive/80">
          {scn.error}
        </p>
      </div>
    );
  })();

  /* ------------------------------------------------------------------- rail */
  const rail = railOpen ? (
    <aside className="flex w-[19rem] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        <WorkflowIcon className="size-3.5 shrink-0 text-indigo-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {RUN_META.name}
        </span>
        {isLive && (
          <button
            type="button"
            onClick={stopRun}
            title="Stop the run"
            className="rounded border border-destructive/40 bg-destructive/10 p-1 text-destructive hover:bg-destructive/20"
          >
            <SquareIcon className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setRailOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </button>
      </div>
      {/* rail tabs */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {(
          [
            { k: "agent", label: "Agent", icon: CpuIcon },
            { k: "script", label: "Script", icon: FileCode2Icon },
            { k: "budget", label: "Budget", icon: GaugeIcon },
          ] as const
        ).map((t) => (
          <button
            key={t.k}
            type="button"
            onClick={() => setRailTab(t.k)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
              railTab === t.k
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="size-3" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {railTab === "agent" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  AGENT_DOT[derived.map.get(selected.id) ?? "queued"],
                )}
              />
              <span className="font-mono text-xs">{selected.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {derived.map.get(selected.id) ?? "queued"}
              </span>
              {provider === "claude" && (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  ${selected.costUsd.toFixed(2)}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {selected.transcript.map((s, i) => (
                <div key={i} className="text-[11px]">
                  {s.kind === "text" && (
                    <p className="text-muted-foreground">{s.text}</p>
                  )}
                  {s.kind === "tool" && (
                    <div className="rounded border border-border bg-muted/40 px-2 py-1 font-mono">
                      <span className="text-indigo-300">{s.tool}</span>{" "}
                      <span className="text-muted-foreground">{s.input}</span>
                    </div>
                  )}
                  {s.kind === "tool-result" && (
                    <p className="pl-2 font-mono text-muted-foreground/70">
                      → {s.text}
                    </p>
                  )}
                  {s.kind === "result" && (
                    <div>
                      <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase text-emerald-400">
                        <CheckIcon className="size-3" /> emit_result
                      </div>
                      <JsonBlock value={s.json} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {railTab === "script" && (
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                meta
              </div>
              <JsonBlock value={{ ...RUN_META, args: RUN_ARGS }} />
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                source (read-only)
              </div>
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[10px] leading-relaxed">
                {SCRIPT_SOURCE}
              </pre>
            </div>
          </div>
        )}

        {railTab === "budget" && (
          <div className="space-y-3">
            {provider === "codex" ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
                USD ceiling is blocked on Codex — codex-app-server exposes token
                counts only; the tokens×price table is codex-driver Open Q4.
                Token spend so far: {fmtTokens(derived.tokens)}.
              </p>
            ) : (
              <div className="text-xs">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-muted-foreground">total spent</span>
                  <span className="font-mono tabular-nums">
                    {usd(derived.spent)} / {usd(scn.budgetUsd)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-emerald-400"
                    style={{
                      width: `${Math.min(100, (derived.spent / scn.budgetUsd) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                spend per phase
              </div>
              <div className="space-y-1.5">
                {perPhaseSpend.map((p) => (
                  <div key={p.id} className="text-[11px]">
                    <div className="flex items-baseline justify-between">
                      <span>{p.title}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {provider === "claude" ? usd(p.spent) : "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-indigo-400/70"
                        style={{
                          width: `${
                            provider === "claude"
                              ? Math.min(100, (p.spent / scn.budgetUsd) * 100 * 2)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  ) : (
    <button
      type="button"
      onClick={() => setRailOpen(true)}
      title="Open run inspector"
      className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-2 text-muted-foreground hover:text-foreground"
    >
      <PanelRightOpenIcon className="size-4" />
      <span className="[writing-mode:vertical-rl] text-[10px] font-medium">
        inspector
      </span>
    </button>
  );

  /* ----------------------------------------------------------------- render */
  return (
    <StageFrame controls={() => controls}>
      {() => (
        <div className="flex h-full">
          {/* the chat session transcript */}
          <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-3 px-4 py-4">
              {/* session header */}
              <div className="flex items-center gap-2 border-b border-border pb-2">
                <span className="text-sm font-semibold">Quick wins on telar-core</span>
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {provider === "claude" ? "claude · opus-4.8" : "codex · gpt-5.1"}
                </span>
                <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CpuIcon className="size-3" />
                  same harness, both providers
                </span>
              </div>

              {/* user message with the ultra annotation */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-muted/40 px-3 py-2">
                  <div className="mb-1 flex items-center justify-end gap-1">
                    <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                      <SparklesIcon className="size-2.5" /> ultra:true
                    </span>
                  </div>
                  <p className="text-sm">
                    ultra: knock out the quick-wins batch — recon the core, then fix
                    types, tests &amp; docs in parallel, gate it, and commit.
                  </p>
                </div>
              </div>

              {/* assistant intro */}
              <div className="max-w-[92%] text-sm">
                <p className="text-muted-foreground">
                  On it — the message is Ultra-annotated, so I&apos;ll author a run
                  and hand you the result.
                </p>
              </div>

              {/* THE RUN BLOCK */}
              {runBlock}

              {/* terminal state block (under the run block) */}
              {terminalReached && terminalBlock}

              {/* assistant summarizes the structured result back in chat */}
              {runState === "completed" && (
                <div className="max-w-[92%] space-y-1 text-sm">
                  <p>
                    Done. Recon mapped 2 modules (12 type errors + 3 flaky tests);
                    all three lanes landed — <b>types</b> 12 fixes/4 files,{" "}
                    <b>tests</b> 3 flakes fixed (one lane returned null once and was
                    re-spawned), <b>docs</b> 2 files. Gate green (tsc + 148 tests),
                    committed <code className="font-mono text-xs">4f2a1c9</code>{" "}
                    (not pushed).
                  </p>
                  <p className="text-muted-foreground">
                    {provider === "claude"
                      ? `Spend ${usd(FINAL_RESULT.spentUsd as number)} across 8 agents — folded into this turn's usage.`
                      : `${fmtTokens(derived.tokens)} tokens across 8 agents (USD ceiling blocked on Codex).`}
                  </p>
                </div>
              )}
              {runState === "stopped" && (
                <div className="max-w-[92%] text-sm text-muted-foreground">
                  Stopped the run — recon + 2 lanes are journaled. Say the word and I
                  can resume from the prefix (no completed work repaid).
                </div>
              )}
              {runState === "failed" && (
                <div className="max-w-[92%] text-sm text-muted-foreground">
                  The run hit the ${scn.budgetUsd.toFixed(2)} ceiling mid-lanes and
                  unwound. Bump the budget and I&apos;ll resume from the journal.
                </div>
              )}

              {/* composer with the ONLY new composer control: the Ultra chip */}
              <div className="sticky bottom-0 mt-2 rounded-xl border border-border bg-card p-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUltraArmed((a) => !a)}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors",
                      ultraArmed
                        ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-300 shadow-[0_0_0_1px] shadow-indigo-500/30"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                    title="Annotate the next message ultra:true"
                  >
                    <SparklesIcon className={cn("size-3", ultraArmed && "animate-pulse")} />
                    Ultra
                  </button>
                  <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground/70">
                    {ultraArmed
                      ? "next message → ultra:true (the tool may run a batch)"
                      : "Message the agent…"}
                  </div>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    ⏎
                  </span>
                </div>
              </div>
            </div>

            {/* dock bubble — one per live run, appears when it scrolls off */}
            {isLive && !blockInView && (
              <button
                type="button"
                onClick={() => {
                  blockRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                  setRailOpen(true);
                }}
                className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-full border border-indigo-500/40 bg-card px-3 py-2 shadow-lg"
              >
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/60" />
                  <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
                </span>
                <span className="text-xs font-medium">{RUN_META.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {provider === "claude" ? usd(derived.spent) : `${fmtTokens(derived.tokens)}t`}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    stopRun();
                  }}
                  className="ml-0.5 inline-flex items-center rounded border border-destructive/40 bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive"
                >
                  <SquareIcon className="size-2.5" />
                </span>
              </button>
            )}
          </div>

          {/* the SubagentRail inspector, keyed to the run */}
          {rail}
        </div>
      )}
    </StageFrame>
  );
}
