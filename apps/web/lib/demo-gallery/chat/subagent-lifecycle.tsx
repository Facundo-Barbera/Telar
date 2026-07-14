"use client";

// 1.1 — Sub-agent task lifecycle.
// CURRENT: agent-tabs.tsx renders a persistent chip/tab per spawn keyed by
// parent_tool_use_id; a finished spawn keeps its tab forever (only the dot
// dims), so a long session accretes dead chips that crowd the live one.
// REDESIGN: a chip is present only while the task is ALIVE. On completion it
// gracefully collapses out of the active row and folds into a single
// "N done" pill (expand for the full history) — nothing is lost, but the
// active row only ever shows what is actually running.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
// Lane-local shimmer: the production one washes out on light panels (see note
// in ./shimmer). Swap back to @/components/ai-elements/shimmer once that ships.
import { Shimmer } from "./shimmer";
import { cn } from "@/lib/utils";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

type TaskStatus = "running" | "done" | "error";
type Task = {
  id: string;
  label: string;
  tool: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  leaving?: boolean;
};

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

function StatusMark({ status }: { status: TaskStatus }) {
  if (status === "running")
    return (
      <Shimmer as="span" className="text-[10px] leading-none">
        ●
      </Shimmer>
    );
  if (status === "error") return <TriangleAlertIcon className="size-3 text-destructive" />;
  return <CheckIcon className="size-3 text-primary" />;
}

// One compact active chip. `leaving` drives a pure CSS transition (opacity +
// max-width + translate) — never a keyframe fade of a positioned layer, per
// the WebKit 26 note in the app.
function TaskChip({ task, now }: { task: Task; now: number }) {
  const elapsed = (task.finishedAt ?? now) - task.startedAt;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs transition-all duration-300 ease-out",
        task.status === "error" && "border-destructive/40 bg-destructive/10",
        task.leaving ? "max-w-0 -translate-y-1 border-transparent px-0 opacity-0" : "max-w-xs opacity-100",
      )}
    >
      <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {task.status === "running" ? (
        <Shimmer as="span" className="max-w-40 truncate">
          {task.label}
        </Shimmer>
      ) : (
        <span className="max-w-40 truncate font-medium">{task.label}</span>
      )}
      <span className="font-mono text-[10px] text-muted-foreground/70">{fmtDur(elapsed)}</span>
      <StatusMark status={task.status} />
    </div>
  );
}

// The folded-history pill: "3 done · 1 failed", expands to the full list.
function CompletedPill({ history }: { history: Task[] }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  const failed = history.filter((t) => t.status === "error").length;
  const done = history.length - failed;
  return (
    <div className="inline-flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        <CheckIcon className="size-3 text-primary" />
        <span className="font-medium text-foreground">{done} done</span>
        {failed > 0 && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="font-medium text-destructive">{failed} failed</span>
          </>
        )}
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="mt-1.5 w-64 space-y-0.5 rounded-lg border border-border bg-card p-1.5">
          {history.map((t) => (
            <li key={t.id} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs">
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SEED: Omit<Task, "startedAt" | "status">[] = [
  { id: "a1", label: "Audit auth middleware", tool: "explore" },
  { id: "a2", label: "Port tests to vitest", tool: "general" },
  { id: "a3", label: "Draft migration plan", tool: "plan" },
];

function LifecycleSim() {
  const [now, setNow] = useState(() => Date.now());
  const [active, setActive] = useState<Task[]>([]);
  const [history, setHistory] = useState<Task[]>([]);
  const seedIdx = useRef(0);
  const uid = useRef(0);

  // ticking clock for live elapsed
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const spawn = useCallback(() => {
    const s = SEED[seedIdx.current % SEED.length];
    seedIdx.current += 1;
    uid.current += 1;
    setActive((cur) => [
      ...cur,
      { ...s, id: `${s.id}-${uid.current}`, status: "running", startedAt: Date.now() },
    ]);
  }, []);

  // resolve the oldest running task, then gracefully evict it into history
  const resolve = useCallback((outcome: TaskStatus) => {
    setActive((cur) => {
      const idx = cur.findIndex((t) => t.status === "running");
      if (idx === -1) return cur;
      const next = [...cur];
      next[idx] = { ...next[idx], status: outcome, finishedAt: Date.now() };
      const evictId = next[idx].id;
      // mark leaving on the next frame so the transition runs from the
      // resolved (not running) visual, then move to history after it settles.
      setTimeout(() => {
        setActive((c) => c.map((t) => (t.id === evictId ? { ...t, leaving: true } : t)));
        setTimeout(() => {
          setActive((c) => {
            const gone = c.find((t) => t.id === evictId);
            if (gone) setHistory((h) => [{ ...gone, leaving: false }, ...h]);
            return c.filter((t) => t.id !== evictId);
          });
        }, 320);
      }, 650);
      return next;
    });
  }, []);

  // autoplay: keep ~2 tasks in flight, resolve on a cadence
  useEffect(() => {
    spawn();
    const t = setTimeout(() => spawn(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = active.filter((t) => t.status === "running").length;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={spawn}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Spawn task
        </button>
        <button
          type="button"
          disabled={running === 0}
          onClick={() => resolve("done")}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          Complete oldest
        </button>
        <button
          type="button"
          disabled={running === 0}
          onClick={() => resolve("error")}
          className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
        >
          Fail oldest
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          {running} running · {history.length} archived
        </span>
      </div>

      <Caption>Active row — only live tasks</Caption>
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {active.length === 0 && history.length === 0 && (
          <span className="text-xs text-muted-foreground/60">no tasks yet — spawn one</span>
        )}
        {active.map((t) => (
          <TaskChip key={t.id} task={t} now={now} />
        ))}
        <CompletedPill history={history} />
      </div>
    </div>
  );
}

// Static lifecycle reference so the three states read side by side.
function StateStrip() {
  const now = Date.now();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TaskChip
        task={{ id: "s1", label: "Running: crawl repo", tool: "explore", status: "running", startedAt: now - 8000 }}
        now={now}
      />
      <TaskChip
        task={{ id: "s2", label: "Done: build spec", tool: "plan", status: "done", startedAt: now - 42000, finishedAt: now }}
        now={now}
      />
      <TaskChip
        task={{ id: "s3", label: "Failed: flaky suite", tool: "general", status: "error", startedAt: now - 15000, finishedAt: now }}
        now={now}
      />
    </div>
  );
}

// ── Variant B: relocate to a docked tray (the alternative the user weighed)
// Chips never sit in the message flow at all; a single header affordance holds
// them, with a live count. Keeps the transcript totally clean but hides the
// running work one click deep — shown so the tradeoff is visible next to the
// preferred graceful-dismiss.
function TrayVariant() {
  const [open, setOpen] = useState(true);
  const now = Date.now();
  const items: Task[] = [
    { id: "t1", label: "Crawl repo", tool: "explore", status: "running", startedAt: now - 8000 },
    { id: "t2", label: "Port tests", tool: "general", status: "running", startedAt: now - 3000 },
    { id: "t3", label: "Build spec", tool: "plan", status: "done", startedAt: now - 42000, finishedAt: now },
    { id: "t4", label: "Flaky suite", tool: "general", status: "error", startedAt: now - 15000, finishedAt: now },
  ];
  const running = items.filter((t) => t.status === "running").length;
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Session header</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
        >
          <BotIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Tasks</span>
          {running > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 font-mono text-[10px] text-foreground">
              {running}
            </span>
          )}
          <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <ul className="space-y-0.5 p-2">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
              <StatusMark status={t.status} />
              {t.status === "running" ? (
                <Shimmer as="span" className="min-w-0 flex-1 truncate">
                  {t.label}
                </Shimmer>
              ) : (
                <span className={cn("min-w-0 flex-1 truncate", t.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                  {t.label}
                </span>
              )}
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                {fmtDur((t.finishedAt ?? now) - t.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SubagentTrayVariantDemo() {
  return (
    <DemoShell>
      <Section
        title="Docked tasks tray (alternative)"
        note="Chips leave the transcript entirely and live behind a header affordance with a live count. Cleaner flow, but running work is one click away — contrast with the graceful-dismiss take."
      >
        <ThemePair>
          <TrayVariant />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}

export function SubagentLifecycleDemo() {
  return (
    <DemoShell>
      <Section
        title="Live lifecycle"
        note="Spawn tasks, then complete or fail the oldest — watch it collapse out of the active row and fold into the history pill. Click the pill to expand."
      >
        <LifecycleSim />
      </Section>
      <Section title="The three states" note="Active chips are compact — tool label, live elapsed, status mark.">
        <ThemePair>
          <StateStrip />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
