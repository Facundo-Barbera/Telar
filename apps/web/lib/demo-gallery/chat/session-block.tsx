"use client";

// 1.1 IN CONTEXT — a production-anatomy session excerpt.
// The two 1.1 sub-agent treatments (graceful-dismiss chips + folded pill, and
// the docked tray) were previously judged as isolated widgets. Here they run
// inside a REAL agent turn: a user bubble, streamed thinking (1.3), a run of
// tool steps (TOOL_ICONS), sub-agents that spawn MID-TURN and complete one by
// one — each dismissing per the chosen treatment — then the turn closes with
// final assistant text + the aggregate cost pill (1.6). A replay button
// restarts the scripted timeline; a variant switch swaps the treatment in
// place so A and B are compared within the same conversation.
//
// Reuse-first: the chips/pill/tray come straight from subagent-lifecycle, the
// thinking block from thinking-stream, the cost pill from session-cost — this
// file only orchestrates the scripted timeline and lays the pieces out with
// real session-view spacing (Message/MessageContent grammar: user bubble
// right-aligned in bg-secondary, assistant full-width plain text).

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcwIcon, UserRoundIcon, WrenchIcon } from "lucide-react";
import { TOOL_ICONS } from "@/components/session/tool-step";
import { fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Shimmer } from "./shimmer";
import {
  CompletedPill,
  DockedTray,
  StatusMark,
  TaskChip,
  fmtDur,
  type Task,
} from "./subagent-lifecycle";
import { ThinkingBlock, type Thinking } from "./thinking-stream";
import { DemoShell, LIGHT_VARS, Section } from "./_shared";

type Variant = "dismiss" | "tray";

type ToolStep = {
  id: string;
  tool: string;
  target: string;
  startedAt: number;
  finishedAt?: number;
};

// Local extension: `dismissed` marks a task whose leaving animation has settled,
// so the graceful-dismiss render can keep a leaving chip in the active row
// (collapsing) until the transition ends, then fold it into the pill.
type TurnTask = Task & { dismissed?: boolean };

type Phase = "idle" | "thinking" | "working" | "done";

const THINKING_TEXT =
  "The cost total only sums the main agent's usage, so sub-agent spend is dropped. I'll fan out the audit and the test port, then fold every bucket's usage into the total before formatting.";

// The scripted turn: sub-agents spawn while tools run, then resolve one by one.
// Times are ms from the moment thinking finishes (the working phase begins).
const TASK_SEED = [
  { id: "s1", label: "Audit auth middleware", tool: "explore" },
  { id: "s2", label: "Port tests to vitest", tool: "general" },
  { id: "s3", label: "Draft migration plan", tool: "plan" },
] as const;

// ── Theme toggle: one full-width panel, dark by default or re-themed to light
// by injecting the light token set (values from _shared LIGHT_VARS). The wrapper
// re-declares bg + text color so the whole subtree resolves through the tokens
// in either theme (lane rule: theme-panel wrappers own their color).
function ThemePanel({
  theme,
  children,
}: {
  theme: "dark" | "light";
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-border bg-background p-4 text-foreground sm:p-6"
      style={theme === "light" ? LIGHT_VARS : undefined}
    >
      {children}
    </div>
  );
}

// A compact tool step row — icon (TOOL_ICONS) + name + mono target + live
// duration / status mark. Mirrors the session transcript's tool grammar without
// the heavy expand chrome, so it reads as a real step inside the turn.
function ToolStepRow({ step, now }: { step: ToolStep; now: number }) {
  const Icon = TOOL_ICONS[step.tool] ?? WrenchIcon;
  const running = step.finishedAt === undefined;
  const elapsed = (step.finishedAt ?? now) - step.startedAt;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-2.5 py-1.5 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-foreground">
        {step.tool === "Bash" ? "Running" : "Using"} {step.tool}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {running ? (
          <Shimmer as="span" className="font-mono text-[11px]">
            {step.target}
          </Shimmer>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">{step.target}</span>
        )}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
        {fmtDur(elapsed)}
      </span>
      {running ? (
        <StatusMark status="running" />
      ) : (
        <StatusMark status="done" />
      )}
    </div>
  );
}

// The scripted session excerpt. `variant` decides where sub-agent tasks render
// (inline graceful-dismiss row vs docked tray); the timeline that drives task
// state is identical, so switching variants compares only the treatment.
function SessionExcerpt({ variant, runKey }: { variant: Variant; runKey: number }) {
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<Phase>("idle");
  const [thinking, setThinking] = useState<Thinking>({ text: "", done: false });
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [tasks, setTasks] = useState<TurnTask[]>([]);
  const [finalText, setFinalText] = useState(false);
  const [showCost, setShowCost] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((fn: () => void, at: number) => {
    timers.current.push(setTimeout(fn, at));
  }, []);
  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // live elapsed clock while the turn runs
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const finishStep = useCallback((id: string) => {
    setSteps((cur) => cur.map((s) => (s.id === id ? { ...s, finishedAt: Date.now() } : s)));
  }, []);

  const addStep = useCallback((id: string, tool: string, target: string) => {
    setSteps((cur) => [...cur, { id, tool, target, startedAt: Date.now() }]);
  }, []);

  const spawn = useCallback((seed: (typeof TASK_SEED)[number]) => {
    setTasks((cur) => [
      ...cur,
      { ...seed, status: "running", startedAt: Date.now() },
    ]);
  }, []);

  // Resolve a task, then (graceful-dismiss treatment) let it settle at its
  // resolved visual, animate it out (leaving → CSS collapse), and finally fold
  // it into history (dismissed). The tray treatment ignores these flags and
  // just shows the new status in place — same state, different render.
  const resolve = useCallback(
    (id: string, outcome: "done" | "error") => {
      setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, status: outcome, finishedAt: Date.now() } : t)));
      later(() => {
        setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        later(() => {
          setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, dismissed: true } : t)));
        }, 320);
      }, 650);
    },
    [later],
  );

  // ── the whole scripted timeline, restarted on play/replay
  const play = useCallback(() => {
    clearAll();
    setPhase("thinking");
    setThinking({ text: "", done: false });
    setSteps([]);
    setTasks([]);
    setFinalText(false);
    setShowCost(false);

    // 1. stream thinking token-by-token, then collapse to a Thought row
    const words = THINKING_TEXT.split(" ");
    const startThink = Date.now();
    const streamEvery = 45;
    words.forEach((_, i) => {
      later(() => {
        setThinking({ text: words.slice(0, i + 1).join(" "), done: false });
      }, i * streamEvery);
    });
    const thinkEnd = words.length * streamEvery;
    later(() => {
      setThinking({ text: THINKING_TEXT, done: true, durationMs: Date.now() - startThink });
      setPhase("working");
    }, thinkEnd);

    // 2. the working phase — tools + mid-turn sub-agents, offsets from thinkEnd
    const w = (ms: number) => thinkEnd + ms;
    later(() => addStep("t1", "Read", "packages/core/src/session-cost.ts"), w(200));
    later(() => spawn(TASK_SEED[0]), w(500)); // audit spawns mid-turn
    later(() => {
      finishStep("t1");
      addStep("t2", "Grep", "parentOf( · packages/core/src");
    }, w(1500));
    later(() => spawn(TASK_SEED[1]), w(1900)); // test-port spawns alongside
    later(() => resolve("s1", "done"), w(3000)); // first sub-agent completes → dismisses
    later(() => {
      finishStep("t2");
      addStep("t3", "Edit", "session-cost.ts · fold sub-agent usage");
    }, w(3400));
    later(() => spawn(TASK_SEED[2]), w(3900));
    later(() => resolve("s2", "done"), w(4800));
    later(() => {
      finishStep("t3");
      addStep("t4", "Bash", "bun test packages/core");
    }, w(5600));
    later(() => resolve("s3", "done"), w(6400));
    later(() => finishStep("t4"), w(7400));
    later(() => {
      setFinalText(true);
      setPhase("done");
    }, w(7900));
    later(() => setShowCost(true), w(8300));
  }, [clearAll, later, addStep, spawn, resolve, finishStep]);

  // autoplay on mount and whenever the replay button bumps runKey
  useEffect(() => {
    play();
    return clearAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // graceful-dismiss split: a task stays in the active row (running, or resolved
  // and animating out) until its collapse settles (dismissed), then it belongs
  // to the folded history pill.
  const activeRow = tasks.filter((t) => !t.dismissed);
  const history = tasks.filter((t) => t.dismissed);
  const runningCount = tasks.filter((t) => t.status === "running").length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {/* Docked tray lives in the session header (variant B only) */}
      {variant === "tray" && (
        <DockedTray items={tasks} headerLabel="Session" now={now} />
      )}

      {/* User message — right-aligned bubble (Message/MessageContent grammar) */}
      <div className="flex flex-col gap-1">
        <div className="ml-auto max-w-[80%] rounded-lg bg-secondary px-4 py-3 text-sm text-foreground">
          Fix the failing cost test — the session total is dropping every sub-agent&apos;s spend.
        </div>
      </div>

      {/* Assistant turn — full width, plain text, stacked parts */}
      <div className="flex flex-col gap-2 text-sm text-foreground">
        {/* thinking (1.3) */}
        {phase !== "idle" && thinking.text.trim() !== "" && (
          <ThinkingBlock part={thinking} />
        )}
        {phase === "thinking" && thinking.text.trim() === "" && (
          <Shimmer className="text-sm">Thinking…</Shimmer>
        )}

        {/* tool steps */}
        {steps.map((s) => (
          <ToolStepRow key={s.id} step={s} now={now} />
        ))}

        {/* sub-agent tasks — graceful-dismiss treatment (variant A), inline in
            the turn beside the tool steps: a live chip while running, collapsing
            into the folded "N done" pill on completion */}
        {variant === "dismiss" && (activeRow.length > 0 || history.length > 0) && (
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            {activeRow.map((t) => (
              <TaskChip key={t.id} task={t} now={now} />
            ))}
            <CompletedPill history={history} />
          </div>
        )}

        {/* final assistant text */}
        {finalText && (
          <p className="leading-relaxed">
            Fixed. The total now folds every sub-agent&apos;s usage into the sum before formatting —
            the {runningCount === 0 ? "three" : runningCount} spawned audits confirmed the buckets, and{" "}
            <span className="font-mono text-xs">bun test packages/core</span> is green.
          </p>
        )}

        {/* cost pill (1.6) — the aggregate, main + every sub-agent */}
        {showCost && (
          <div className="mt-1 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-xs text-foreground">
              <UserRoundIcon className="size-3 text-muted-foreground" />
              {fmtCost(0.536)}
              <span className="text-[10px] text-muted-foreground/70">main + 3</span>
            </span>
            <span className="text-[10px] text-muted-foreground/60">turn complete</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionBlockDemo() {
  const [variant, setVariant] = useState<Variant>("dismiss");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [runKey, setRunKey] = useState(0);

  return (
    <DemoShell>
      <Section
        title="1.1 in a real session"
        note="The two sub-agent treatments, judged in context: a full agent turn — streamed thinking, tool steps, and sub-agents spawning mid-turn that complete and dismiss per the treatment — then final text and the aggregate cost pill. Replay restarts the timeline; switch the treatment to compare A and B in the same conversation."
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* variant switch: A graceful dismiss / B docked tray */}
          <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setVariant("dismiss")}
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors",
                variant === "dismiss"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              A · graceful dismiss
            </button>
            <button
              type="button"
              onClick={() => setVariant("tray")}
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors",
                variant === "tray"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              B · docked tray
            </button>
          </div>

          {/* replay */}
          <button
            type="button"
            onClick={() => setRunKey((k) => k + 1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcwIcon className="size-3.5" />
            Replay
          </button>

          {/* theme toggle — a full-width session block reads better as one panel
              than a cramped side-by-side pair, so both themes share a toggle */}
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {theme === "dark" ? "Dark" : "Light"} theme
          </button>
        </div>

        <ThemePanel theme={theme}>
          {/* keying on variant+runKey remounts the excerpt so a switch or replay
              re-runs the scripted timeline cleanly from the top */}
          <SessionExcerpt key={`${variant}-${runKey}`} variant={variant} runKey={runKey} />
        </ThemePanel>
      </Section>
    </DemoShell>
  );
}
