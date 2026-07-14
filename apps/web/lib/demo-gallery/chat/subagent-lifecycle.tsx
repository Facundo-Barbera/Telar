"use client";

// 1.1 — Sub-agent TABS (the agent-tab strip at the top of a session).
// CURRENT: components/session/agent-tabs.tsx renders one tab per spawn keyed by
// parent_tool_use_id; a finished spawn keeps its tab FOREVER (only its dot
// dims), so a long session accretes dead tabs — "Main | Verify P3 Track A |
// Verify P3 Track B | Reconcile PD-scope | …" — that crowd the live ones.
// REDESIGN: tabs are navigation, not ephemera, so nothing is ever lost — but a
// COMPLETED sub-agent shouldn't occupy the strip. On completion its tab
// gracefully dismisses; every completed transcript stays one click away behind
// a strip-end affordance. Failed sub-agents stay PINNED as tabs (failure needs
// eyes). Two strip-end treatments are offered:
//   A · graceful dismiss  — the tab collapses into an expandable "N done" pill
//   B · overflow tray      — completed tabs collect into an overflow popover
//
// These primitives (Task, fmtDur, StatusMark, SubagentTab, CompletedPill,
// OverflowTray, SubagentTabStrip) are exported so the in-context session block
// (chat-session-block) drives the EXACT same strip — the treatment is judged as
// the real thing, not a re-implementation.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
// Lane-local shimmer: the production one washes out on light panels (see note
// in ./shimmer). Swap back to @/components/ai-elements/shimmer once that ships.
import { Shimmer } from "./shimmer";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

export type TaskStatus = "running" | "done" | "error";
export type Task = {
  id: string;
  label: string;
  tool: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  // `leaving` drives the collapse transition of a just-completed tab; once it
  // settles, `dismissed` moves the task out of the strip and into the strip-end
  // affordance (pill / tray). Failed tasks never get either flag — they stay
  // pinned as tabs.
  leaving?: boolean;
  dismissed?: boolean;
};

export const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

// The tab's leading status glyph. Reused on the tab, the main-thread agent
// chip, and the strip-end list rows so "still working / done / failed" reads
// identically everywhere. Deliberately NOT a keyframe opacity fade — WebKit
// 26.x crashes on those for positioned layers; Shimmer animates a
// background-position gradient behind clipped text instead.
export function StatusMark({ status }: { status: TaskStatus }) {
  if (status === "running")
    return (
      <Shimmer as="span" className="text-[10px] leading-none">
        ●
      </Shimmer>
    );
  if (status === "error") return <TriangleAlertIcon className="size-3 text-destructive" />;
  return <CheckIcon className="size-3 text-primary" />;
}

// One tab in the strip. Anatomy mirrors production agent-tabs.tsx exactly —
// status glyph + truncated task title, `bg-muted text-foreground` when active,
// muted with a hover wash otherwise, `role="tab"` + roving `tabIndex` for
// arrow-key switching. The only addition is `leaving`: a pure CSS collapse
// (max-width + translate + opacity, never a keyframe fade of a positioned
// layer) so a completed tab folds out of the strip before it rehomes into the
// strip-end affordance. A failed tab is tinted destructive and never leaves.
export function SubagentTab({
  task,
  active,
  onSelect,
  onKeyDown,
}: {
  task: Task;
  active: boolean;
  onSelect: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md px-2 py-1 font-medium transition-all duration-300 ease-out",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        task.status === "error" && !active && "text-destructive",
        task.leaving && "pointer-events-none max-w-0 -translate-y-1 gap-0 px-0 opacity-0",
      )}
    >
      <StatusMark status={task.status} />
      <span className="max-w-40 truncate">{task.label}</span>
    </button>
  );
}

// The always-present Main tab (with an optional attention shield — a pending
// permission is always answered on Main, so it's badged there).
function MainTab({
  active,
  needsAttention,
  onSelect,
  onKeyDown,
}: {
  active: boolean;
  needsAttention?: boolean;
  onSelect: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {needsAttention && <ShieldAlertIcon className="size-3 shrink-0 text-destructive" />}
      Main
    </button>
  );
}

// The clickable list of completed sub-agents shared by both strip-end
// treatments — each row navigates (onSelect) to that sub-agent's transcript, so
// a dismissed tab is never more than one click away.
function CompletedRows({
  history,
  activeId,
  onSelect,
}: {
  history: Task[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {history.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60",
              activeId === t.id && "bg-muted",
            )}
          >
            <StatusMark status={t.status} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                t.status === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t.label}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {fmtDur((t.finishedAt ?? 0) - t.startedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Variant A · the strip-end "N done" pill. A completed tab collapses into this
// count; clicking re-lists the completed sub-agents (CompletedRows) as clickable
// navigation. The dropdown is absolutely positioned (never fixed — WebKit 26.x)
// so opening it never reflows the strip or its scroll.
export function CompletedPill({
  history,
  activeId,
  onSelect,
}: {
  history: Task[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        <CheckIcon className="size-3 text-primary" />
        <span className="font-medium text-foreground">{history.length} done</span>
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-card p-1.5 shadow-md">
          <CompletedRows history={history} activeId={activeId} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

// Variant B · the strip-end overflow tray. Completed tabs collect behind a
// compact overflow control with a live count; the popover lists them
// (CompletedRows) as clickable navigation. Same escape-the-scroll absolute
// popover as the pill.
export function OverflowTray({
  history,
  activeId,
  onSelect,
}: {
  history: Task[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label={`${history.length} completed sub-agents`}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontalIcon className="size-3.5" />
        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-foreground">
          {history.length}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-card p-1.5 shadow-md">
          <div className="mb-1 px-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Completed sub-agents
          </div>
          <CompletedRows history={history} activeId={activeId} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

// The whole strip. Left: a scrollable tablist (Main + live/failed tabs). Right:
// the chosen strip-end treatment holding the dismissed-but-navigable completed
// sub-agents. The scroll clip lives ONLY on the tablist, so the affordance's
// absolute popover escapes cleanly (overflow-x:auto would otherwise clip a
// dropdown vertically too). `tasks` is the single source — running + failed
// tasks render as tabs, `dismissed` done tasks feed the affordance — exactly
// how the real strip would derive from one transcript.
export function SubagentTabStrip({
  tasks,
  activeId,
  onSelect,
  treatment,
  mainNeedsAttention,
}: {
  tasks: Task[];
  activeId: string;
  onSelect: (id: string) => void;
  treatment: "dismiss" | "tray";
  mainNeedsAttention?: boolean;
}) {
  const stripTabs = tasks.filter((t) => !t.dismissed); // running + failed(pinned) + leaving
  const history = tasks.filter((t) => t.dismissed);
  const order = ["main", ...stripTabs.filter((t) => !t.leaving).map((t) => t.id)];

  // Arrow-left/right moves the SELECTED tab (activeId), never DOM focus —
  // WebKit 26.x crashes on programmatic .focus(); browsers focus a clicked tab
  // on their own. Derived from activeId (not the button the key landed on) so
  // each press advances relative to what's actually shown selected.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = order.indexOf(activeId);
    if (i === -1) return;
    const next = e.key === "ArrowRight" ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
    onSelect(order[next]);
  };

  return (
    <div className="flex items-stretch border-b border-border text-xs">
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1">
        <MainTab
          active={activeId === "main"}
          needsAttention={mainNeedsAttention}
          onSelect={() => onSelect("main")}
          onKeyDown={handleKeyDown}
        />
        {stripTabs.map((t) => (
          <SubagentTab
            key={t.id}
            task={t}
            active={activeId === t.id}
            onSelect={() => onSelect(t.id)}
            onKeyDown={handleKeyDown}
          />
        ))}
      </div>
      {history.length > 0 && (
        <div className="flex shrink-0 items-center border-l border-border px-2">
          {treatment === "dismiss" ? (
            <CompletedPill history={history} activeId={activeId} onSelect={onSelect} />
          ) : (
            <OverflowTray history={history} activeId={activeId} onSelect={onSelect} />
          )}
        </div>
      )}
    </div>
  );
}

// ── The interactive strip sim, shared by both isolated 1.1 entries. Scripted
// spawn/complete/fail timeline (autoplays, Replay restarts) plus manual
// controls so a reviewer can drive it. `treatment` is the only difference
// between the two entries — the timeline is identical.
const SEED: Array<{ id: string; label: string; tool: string }> = [
  { id: "a1", label: "Verify Conciliación P6", tool: "explore" },
  { id: "a2", label: "Verify P3 Track A report", tool: "general" },
  { id: "a3", label: "Reconcile PD-scope", tool: "plan" },
];

function StripSim({ treatment }: { treatment: "dismiss" | "tray" }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeId, setActiveId] = useState("main");
  const [runKey, setRunKey] = useState(0);
  const seedIdx = useRef(0);
  const uid = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((fn: () => void, at: number) => {
    timers.current.push(setTimeout(fn, at));
  }, []);
  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const spawn = useCallback(() => {
    const s = SEED[seedIdx.current % SEED.length];
    seedIdx.current += 1;
    uid.current += 1;
    setTasks((cur) => [
      ...cur,
      { id: `${s.id}-${uid.current}`, label: s.label, tool: s.tool, status: "running", startedAt: Date.now() },
    ]);
  }, []);

  // Resolve one task. A "done" tab settles at its resolved visual, collapses
  // (leaving), then rehomes into the strip-end affordance (dismissed). A failed
  // tab just flips to error and STAYS pinned in the strip.
  const resolve = useCallback(
    (id: string, outcome: "done" | "error") => {
      setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, status: outcome, finishedAt: Date.now() } : t)));
      if (outcome === "done") {
        later(() => setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 650);
        later(
          () => setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: false, dismissed: true } : t))),
          970,
        );
      }
    },
    [later],
  );

  const resolveOldest = useCallback(
    (outcome: "done" | "error") => {
      const first = tasksRef.current.find((t) => t.status === "running");
      if (first) resolve(first.id, outcome);
    },
    [resolve],
  );

  const play = useCallback(() => {
    clearAll();
    setTasks([]);
    setActiveId("main");
    seedIdx.current = 0;
    uid.current = 0;
    later(() => spawn(), 300);
    later(() => spawn(), 1000);
    later(() => spawn(), 1800);
    later(() => resolveOldest("done"), 3200); // first completes → dismisses
    later(() => resolveOldest("error"), 4400); // one fails → stays pinned
    later(() => spawn(), 5200);
    later(() => resolveOldest("done"), 6400);
    later(() => resolveOldest("done"), 7600);
  }, [clearAll, later, spawn, resolveOldest]);

  useEffect(() => {
    play();
    return clearAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  const running = tasks.filter((t) => t.status === "running").length;
  const done = tasks.filter((t) => t.dismissed).length;
  const failed = tasks.filter((t) => t.status === "error").length;
  const activeTask = tasks.find((t) => t.id === activeId);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/40">
      {/* driver controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setRunKey((k) => k + 1)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Replay
        </button>
        <button
          type="button"
          onClick={spawn}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Spawn
        </button>
        <button
          type="button"
          disabled={running === 0}
          onClick={() => resolveOldest("done")}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          Complete oldest
        </button>
        <button
          type="button"
          disabled={running === 0}
          onClick={() => resolveOldest("error")}
          className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
        >
          Fail oldest
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          {running} running · {failed} failed · {done} done
        </span>
      </div>

      {/* the strip — production anatomy */}
      <SubagentTabStrip tasks={tasks} activeId={activeId} onSelect={setActiveId} treatment={treatment} />

      {/* active-tab body — proves switching + that a dismissed transcript is
          still reachable from the pill/tray */}
      <div className="min-h-24 p-4 text-xs text-muted-foreground">
        {activeId === "main" ? (
          <p>
            <span className="font-medium text-foreground">Main thread</span> — orchestrating the run.
            Running sub-agents show as live tabs; completed ones fold into the{" "}
            {treatment === "dismiss" ? "“N done” pill" : "overflow tray"} at the strip end, one click
            from their transcript. Failed ones stay pinned.
          </p>
        ) : activeTask ? (
          <p>
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <StatusMark status={activeTask.status} />
              {activeTask.label}
            </span>{" "}
            —{" "}
            {activeTask.status === "running"
              ? "still working; switchable live."
              : activeTask.status === "error"
                ? "failed — pinned in the strip so it keeps your eyes."
                : "completed; reached from the strip-end affordance, transcript intact."}
          </p>
        ) : (
          <p>select a tab</p>
        )}
      </div>
    </div>
  );
}

// A static reference strip for the light/dark ThemePair: a live tab, a pinned
// failure, and two dismissed-into-the-affordance completions.
function StaticStrip({ treatment }: { treatment: "dismiss" | "tray" }) {
  const now = Date.now();
  const [activeId, setActiveId] = useState("r1");
  const tasks: Task[] = [
    { id: "r1", label: "Verify QF groundwork", tool: "explore", status: "running", startedAt: now - 8000 },
    { id: "f1", label: "Verify P3 Track B cockpit", tool: "general", status: "error", startedAt: now - 15000, finishedAt: now },
    { id: "d1", label: "Verify Conciliación P6", tool: "plan", status: "done", startedAt: now - 42000, finishedAt: now, dismissed: true },
    { id: "d2", label: "Reconcile PD-scope", tool: "plan", status: "done", startedAt: now - 30000, finishedAt: now, dismissed: true },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <SubagentTabStrip tasks={tasks} activeId={activeId} onSelect={setActiveId} treatment={treatment} />
      <div className="px-3 py-2 text-[11px] text-muted-foreground/70">
        1 running tab · 1 pinned failure · 2 dismissed →{" "}
        {treatment === "dismiss" ? "“2 done” pill" : "overflow tray"}
      </div>
    </div>
  );
}

export function SubagentLifecycleDemo() {
  return (
    <DemoShell>
      <Section
        title="Graceful dismiss"
        note="Watch the tab strip: sub-agents spawn as live tabs, then a completed one collapses out and folds into an expandable “N done” pill at the strip end — click it to re-list the finished sub-agents and jump to any transcript. Failed sub-agents stay pinned. Replay restarts the timeline; the buttons drive it manually."
      >
        <StripSim treatment="dismiss" />
      </Section>
      <Section title="The tab states" note="A live tab, a pinned failure, and the folded “N done” pill — side by side in both themes.">
        <ThemePair>
          <StaticStrip treatment="dismiss" />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}

export function SubagentTrayVariantDemo() {
  return (
    <DemoShell>
      <Section
        title="Overflow tray"
        note="Same strip, alternative strip-end treatment: completed sub-agents collect into an overflow tray with a live count instead of a labelled pill — the popover lists them as clickable navigation. Failed sub-agents stay pinned in the strip. Contrast with the graceful-dismiss “N done” pill."
      >
        <StripSim treatment="tray" />
      </Section>
      <Section title="The tab states" note="A live tab, a pinned failure, and the strip-end overflow tray — side by side in both themes.">
        <ThemePair>
          <StaticStrip treatment="tray" />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
