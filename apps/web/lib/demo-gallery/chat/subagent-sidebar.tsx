"use client";

// 1.1 · Variant C — the sub-agents SIDEBAR.
// Instead of a top tab STRIP (variants A/B), a right-hand rail sits beside the
// conversation column and lists the session's sub-agents as RICH ANIMATED
// CARDS — the informative chip content, roomier: status mark, task title, live
// elapsed, a current-activity line, and cost when done.
//   · running cards sit up top with the full animation vocabulary (spawn-in,
//     shimmering activity line, live elapsed counting up);
//   · failed cards DEMAND ATTENTION — pinned up top, destructive border + tint;
//   · completed cards settle into a compact history section lower in the rail
//     (no clutter, still one click to the transcript).
// The rail is collapsible: an icon-only edge when collapsed, carrying a count
// and status dots so the run's shape is legible even folded away.
//
// SubagentCard / SubagentRail are exported so the in-context session block
// (chat-session-block, variant C) docks the EXACT same rail beside its real
// conversation — the rail is judged as the real thing, not a re-implementation.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRightIcon,
  CompassIcon,
  ListChecksIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SparklesIcon,
} from "lucide-react";
import { fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Shimmer } from "./shimmer";
import { StatusMark, fmtDur, type TaskStatus } from "./subagent-lifecycle";
import { Caption, DemoShell, Section, ThemePair } from "./_shared";

// A sub-agent as the rail models it — the Task shape plus the two roomier
// fields a card affords over a tab: a current-activity line while it runs, and
// the cost once it finishes.
export type AgentCard = {
  id: string;
  label: string;
  tool: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  activity?: string; // current activity line while running
  costUsd?: number; // shown once done
  // `leaving` runs the settle→collapse of a just-completed card before it
  // rehomes into the compact history section (`archived`). Failed cards get
  // neither — they stay pinned in the live section.
  leaving?: boolean;
  archived?: boolean;
};

const TOOL_GLYPH: Record<string, typeof CompassIcon> = {
  explore: CompassIcon,
  general: SparklesIcon,
  plan: ListChecksIcon,
};

// One rich card in the live section. Spawns in (mount collapsed → rAF expand),
// shimmers its activity line and counts its elapsed up while running, flashes a
// primary check beat on completion, then collapses out (leaving) to rehome into
// the history section. Failed cards tint destructive and stay put.
export function SubagentCard({
  card,
  active,
  now,
  onSelect,
}: {
  card: AgentCard;
  active: boolean;
  now: number;
  onSelect: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const running = card.status === "running";
  const justDone = card.status === "done";
  const failed = card.status === "error";
  const elapsed = (card.finishedAt ?? now) - card.startedAt;
  const Glyph = TOOL_GLYPH[card.tool] ?? SparklesIcon;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        // collapsing geometry (max-height + margin + opacity + translate) is a
        // pure transition — never a keyframe fade of a positioned layer.
        "block w-full overflow-hidden rounded-lg border text-left transition-all duration-300 ease-out",
        active ? "border-ring bg-muted/60" : "border-border bg-card hover:bg-muted/40",
        failed && "border-destructive/50 bg-destructive/10",
        justDone && "border-primary/40 bg-primary/10",
        (!entered || card.leaving) && "max-h-0 -translate-y-1 border-transparent opacity-0",
        entered && !card.leaving && "mb-2 max-h-32 opacity-100",
      )}
    >
      <div className="flex flex-col gap-1 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <Glyph
            className={cn(
              "size-3.5 shrink-0",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs font-medium",
              failed ? "text-destructive" : "text-foreground",
            )}
          >
            {card.label}
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {fmtDur(elapsed)}
          </span>
          <StatusMark status={card.status} />
        </div>
        {/* second line — the roomier informative touch a tab can't carry */}
        <div className="flex items-center gap-1.5 pl-5 text-[11px]">
          {running && card.activity ? (
            <Shimmer as="span" className="min-w-0 flex-1 truncate">
              {card.activity}
            </Shimmer>
          ) : failed ? (
            <span className="min-w-0 flex-1 truncate text-destructive/80">
              failed — needs your eyes
            </span>
          ) : justDone ? (
            <span className="min-w-0 flex-1 truncate text-primary/80">done</span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
              {card.tool}
            </span>
          )}
          {card.costUsd !== undefined && justDone && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {fmtCost(card.costUsd)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// One compact row in the history section — a settled completion, still one
// click to its transcript. Mirrors the strip's CompletedRows grammar so the
// two treatments read as the same system.
function HistoryRow({
  card,
  active,
  onSelect,
}: {
  card: AgentCard;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60",
        active && "bg-muted",
      )}
    >
      <StatusMark status={card.status} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          card.status === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {card.label}
      </span>
      {card.costUsd !== undefined && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
          {fmtCost(card.costUsd)}
        </span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
        {fmtDur((card.finishedAt ?? 0) - card.startedAt)}
      </span>
    </button>
  );
}

// A status dot for the collapsed edge — running pulses (shimmer), failed is a
// solid destructive, done is muted.
function EdgeDots({ running, failed, done }: { running: number; failed: number; done: number }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {running > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Shimmer as="span" className="text-[10px] leading-none">
            ●
          </Shimmer>
          <span className="font-mono text-[10px] text-muted-foreground">{running}</span>
        </span>
      )}
      {failed > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <span className="text-[10px] leading-none text-destructive">●</span>
          <span className="font-mono text-[10px] text-destructive">{failed}</span>
        </span>
      )}
      {done > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <span className="text-[10px] leading-none text-muted-foreground/50">●</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">{done}</span>
        </span>
      )}
    </div>
  );
}

// The whole rail. Owns one live clock (so every card's elapsed counts up in
// lock-step) and a collapse toggle. Live section: running + failed(pinned)
// cards. History section: archived completions as compact rows. Collapsed: a
// narrow icon edge with the count + status dots.
export function SubagentRail({
  cards,
  activeId,
  onSelect,
  collapsed,
  onToggle,
}: {
  cards: AgentCard[];
  activeId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const live = cards.filter((c) => !c.archived); // running + failed(pinned) + leaving
  const history = cards.filter((c) => c.archived);
  const running = cards.filter((c) => c.status === "running").length;
  const failed = live.filter((c) => c.status === "error").length;
  const done = history.length;

  if (collapsed) {
    return (
      <div className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-border py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sub-agents rail"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpenIcon className="size-4" />
        </button>
        <EdgeDots running={running} failed={failed} done={done} />
      </div>
    );
  }

  return (
    <div className="flex w-60 shrink-0 flex-col border-l border-border">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Sub-agents
        </span>
        {running > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 font-mono text-[10px] text-foreground">
            <Shimmer as="span" className="text-[9px] leading-none">
              ●
            </Shimmer>
            {running}
          </span>
        )}
        {failed > 0 && (
          <span className="rounded-full bg-destructive/15 px-1.5 font-mono text-[10px] text-destructive">
            {failed} failed
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sub-agents rail"
          className="ml-auto rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* live section — running (rich, full choreography) + pinned failures */}
        {live.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/60">
            No sub-agents running.
          </p>
        ) : (
          live.map((c) => (
            <SubagentCard
              key={c.id}
              card={c}
              active={activeId === c.id}
              now={now}
              onSelect={() => onSelect(c.id)}
            />
          ))
        )}

        {/* history section — settled completions, compact, one click away */}
        {history.length > 0 && (
          <div className="mt-1 border-t border-border pt-2">
            <Caption>Done · {history.length}</Caption>
            <div className="space-y-0.5">
              {history.map((c) => (
                <HistoryRow
                  key={c.id}
                  card={c}
                  active={activeId === c.id}
                  onSelect={() => onSelect(c.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Scripted rail sim — the rail beside a stubbed conversation column, on the
// same spawn/complete/fail timeline the strip sims use (autoplays; Replay
// restarts; the buttons drive it manually). Same choreography, so C is judged
// against A/B on equal footing.
const SEED: Array<{ id: string; label: string; tool: string; activity: string; costUsd: number }> = [
  { id: "a1", label: "Audit auth middleware", tool: "explore", activity: "Reading middleware/auth.ts…", costUsd: 0.031 },
  { id: "a2", label: "Port tests to vitest", tool: "general", activity: "Rewriting suite/session.test…", costUsd: 0.052 },
  { id: "a3", label: "Draft migration plan", tool: "plan", activity: "Sketching the cut sequence…", costUsd: 0.024 },
];

function RailSim() {
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [activeId, setActiveId] = useState("main");
  const [collapsed, setCollapsed] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const seedIdx = useRef(0);
  const uid = useRef(0);
  const cardsRef = useRef<AgentCard[]>([]);
  cardsRef.current = cards;

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
    setCards((cur) => [
      ...cur,
      {
        id: `${s.id}-${uid.current}`,
        label: s.label,
        tool: s.tool,
        activity: s.activity,
        costUsd: s.costUsd,
        status: "running",
        startedAt: Date.now(),
      },
    ]);
  }, []);

  // done: settle beat (check flashes) → collapse (leaving) → archive into
  // history. error: flip to error and STAY pinned in the live section.
  const resolve = useCallback(
    (id: string, outcome: "done" | "error") => {
      setCards((cur) => cur.map((c) => (c.id === id ? { ...c, status: outcome, finishedAt: Date.now() } : c)));
      if (outcome === "done") {
        later(() => setCards((cur) => cur.map((c) => (c.id === id ? { ...c, leaving: true } : c))), 650);
        later(
          () => setCards((cur) => cur.map((c) => (c.id === id ? { ...c, leaving: false, archived: true } : c))),
          970,
        );
      }
    },
    [later],
  );

  const resolveOldest = useCallback(
    (outcome: "done" | "error") => {
      const first = cardsRef.current.find((c) => c.status === "running");
      if (first) resolve(first.id, outcome);
    },
    [resolve],
  );

  const play = useCallback(() => {
    clearAll();
    setCards([]);
    setActiveId("main");
    seedIdx.current = 0;
    uid.current = 0;
    later(() => spawn(), 300);
    later(() => spawn(), 1000);
    later(() => spawn(), 1800);
    later(() => resolveOldest("done"), 3200); // first completes → archives
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

  const running = cards.filter((c) => c.status === "running").length;
  const failed = cards.filter((c) => c.status === "error" && !c.archived).length;
  const done = cards.filter((c) => c.archived).length;
  const activeCard = cards.find((c) => c.id === activeId);

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
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {collapsed ? "Expand rail" : "Collapse rail"}
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          {running} running · {failed} failed · {done} done
        </span>
      </div>

      {/* the rail beside a stubbed conversation column — real anatomy */}
      <div className="flex min-h-64 items-stretch">
        <div className="min-w-0 flex-1 p-4 text-xs text-muted-foreground">
          {activeId === "main" ? (
            <p>
              <span className="font-medium text-foreground">Conversation</span> — the main
              thread. Sub-agents live in the rail on the right as rich cards: running up
              top with a live activity line and elapsed, completed folded into the compact
              Done section, failed pinned for your eyes. Click any card to open its
              transcript here.
            </p>
          ) : activeCard ? (
            <p>
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <StatusMark status={activeCard.status} />
                {activeCard.label}
              </span>{" "}
              —{" "}
              {activeCard.status === "running"
                ? "still working; watch it live in the rail."
                : activeCard.status === "error"
                  ? "failed — pinned in the rail so it keeps your eyes."
                  : "completed; reached in one click from the Done section, transcript intact."}{" "}
              <button
                type="button"
                onClick={() => setActiveId("main")}
                className="text-primary underline-offset-2 hover:underline"
              >
                Back to conversation
              </button>
            </p>
          ) : (
            <p>select a card</p>
          )}
        </div>
        <SubagentRail
          cards={cards}
          activeId={activeId}
          onSelect={setActiveId}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
        />
      </div>
    </div>
  );
}

// A static reference rail for the light/dark ThemePair: two running cards, a
// pinned failure, and two settled completions in the Done section.
function StaticRail() {
  const now = Date.now();
  const [activeId, setActiveId] = useState("r1");
  const cards: AgentCard[] = [
    { id: "r1", label: "Audit auth middleware", tool: "explore", activity: "Reading middleware/auth.ts…", status: "running", startedAt: now - 8000 },
    { id: "r2", label: "Port tests to vitest", tool: "general", activity: "Rewriting suite/session.test…", status: "running", startedAt: now - 3000 },
    { id: "f1", label: "Verify P3 Track B", tool: "general", status: "error", startedAt: now - 15000, finishedAt: now },
    { id: "d1", label: "Draft migration plan", tool: "plan", status: "done", startedAt: now - 42000, finishedAt: now, costUsd: 0.024, archived: true },
    { id: "d2", label: "Reconcile PD-scope", tool: "plan", status: "done", startedAt: now - 30000, finishedAt: now, costUsd: 0.041, archived: true },
  ];
  return (
    <div className="flex h-72 overflow-hidden rounded-lg border border-border">
      <div className="min-w-0 flex-1 p-3 text-[11px] text-muted-foreground/70">
        Conversation column. 2 running cards · 1 pinned failure · 2 in the Done section.
      </div>
      <SubagentRail cards={cards} activeId={activeId} onSelect={setActiveId} collapsed={false} onToggle={() => {}} />
    </div>
  );
}

export function SubagentSidebarDemo() {
  return (
    <DemoShell>
      <Section
        title="Session sub-agents rail"
        note="A right-hand rail beside the conversation: sub-agents as rich animated cards. Running up top — spawn-in, a shimmering activity line, live elapsed; failed pinned in destructive; completed settle into the compact Done section, one click from their transcript. Collapse the rail to an icon edge with count + status dots. Replay restarts the timeline; the buttons drive it."
      >
        <RailSim />
      </Section>
      <Section
        title="The rail states"
        note="Running cards, a pinned failure, and the folded Done section — side by side in both themes."
      >
        <ThemePair>
          <StaticRail />
        </ThemePair>
      </Section>
    </DemoShell>
  );
}
