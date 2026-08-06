"use client";

// 1.1C — the sub-agents SIDEBAR RAIL (replaces the old top tab strip).
// A right-hand rail beside the conversation column lists a session's sub-agents
// as rich cards: a status mark, task title, a live current-activity line while
// running, and a step count. Running + failed cards sit up top (failures pinned,
// destructive-tinted, demanding attention); completed cards settle into a
// compact "Done" history section, still one click to their transcript. The rail
// collapses to an icon-only edge carrying a count + status dots. A pinned "Main"
// anchor at the very top is always one click back to the main conversation.
//
// Ported from lib/demo-gallery/chat/subagent-sidebar.tsx and adapted to REAL
// session data: per-sub-agent timestamps and cost do not exist in the transcript
// (see the production-wiring recon), so the demo's live-elapsed clock and cost
// line are replaced by the real, available step count. StatusMark reuses the
// existing agent-tabs StatusDot vocabulary via the WebKit-safe Shimmer.

import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CompassIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { CheckIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

export type RailStatus = "running" | "done" | "error";

const NOOP = () => {};

// A sub-agent as the rail models it, derived from an AgentBucket in session-view.
// `steps` is the bucket's part count (the real, available signal); `activity` is
// the current tool preview while running.
export type RailAgent = {
  id: string;
  label: string;
  tool: string;
  status: RailStatus;
  steps: number;
  activity?: string;
};

// Shared status glyph — Shimmer dot while running (WebKit-safe busy treatment),
// a destructive alert when failed, a primary check when done.
export function StatusMark({ status }: { status: RailStatus }) {
  if (status === "running")
    return (
      <Shimmer as="span" className="text-[10px] leading-none">
        ●
      </Shimmer>
    );
  if (status === "error") return <TriangleAlertIcon className="size-3 text-destructive" />;
  return <CheckIcon className="size-3 text-primary" />;
}

const TOOL_GLYPH: Record<string, typeof CompassIcon> = {
  explore: CompassIcon,
  "general-purpose": SparklesIcon,
  general: SparklesIcon,
  plan: ListChecksIcon,
};

// One rich card in the live section. Spawns in (mount collapsed → rAF expand).
function SubagentCard({
  card,
  active,
  onSelect,
}: {
  card: RailAgent;
  active: boolean;
  onSelect: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const running = card.status === "running";
  const failed = card.status === "error";
  const Glyph = TOOL_GLYPH[card.tool] ?? SparklesIcon;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        // Collapsing geometry is a pure transition, never a keyframe fade of a
        // positioned layer (WebKit 26.x).
        "block w-full overflow-hidden rounded-lg border text-left transition-all duration-300 ease-out",
        active ? "border-ring bg-muted/60" : "border-border bg-card hover:bg-muted/40",
        failed && "border-destructive/50 bg-destructive/10",
        !entered && "max-h-0 -translate-y-1 border-transparent opacity-0",
        entered && "mb-2 max-h-32 opacity-100",
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
            {card.steps} step{card.steps === 1 ? "" : "s"}
          </span>
          <StatusMark status={card.status} />
        </div>
        <div className="flex items-center gap-1.5 pl-5 text-[11px]">
          {running && card.activity ? (
            <Shimmer as="span" className="min-w-0 flex-1 truncate">
              {card.activity}
            </Shimmer>
          ) : failed ? (
            <span className="min-w-0 flex-1 truncate text-destructive/80">
              failed — needs your eyes
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
              {card.tool}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// One compact row in the history section — a settled completion, one click to
// its transcript.
function HistoryRow({
  card,
  active,
  onSelect,
}: {
  card: RailAgent;
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
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
        {card.steps} step{card.steps === 1 ? "" : "s"}
      </span>
    </button>
  );
}

function EdgeDots({
  running,
  failed,
  done,
  // Story 4.2 — the Workflows count on the collapsed edge. A FOURTH OPTIONAL
  // PROP WITH A DEFAULT, never a fourth required one: `SubagentRail` has TWO
  // consumers and the second is the demo gallery's `conversation-full`
  // configuration, which passes today's seven props and will never pass this
  // one. Defaulted to 0 so the collapsed rail renders the exact same dot
  // vocabulary it renders today when nobody supplies it.
  //
  // DELIBERATELY NOT FOLDED INTO `running`. That number is
  // `agents.filter(c => c.status === "running").length` — the SUB-AGENT figure
  // this edge already publishes — and adding runs to it would make the edge lie
  // about both.
  workflows = 0,
}: {
  running: number;
  failed: number;
  done: number;
  workflows?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {workflows > 0 && (
        <span className="inline-flex items-center gap-0.5" title="Ultra runs">
          <WorkflowIcon className="size-3 text-muted-foreground" />
          <span className="font-mono text-[10px] text-muted-foreground">{workflows}</span>
        </span>
      )}
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

// The pinned anchor row — always one click back to Main. Highlighted ("Here")
// when Main is the active view; a return chevron otherwise. Carries the pending-
// permission attention shield (a permission is always answered on Main).
function MainRow({
  active,
  onSelect,
  label,
  needsAttention,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
  needsAttention?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-ring bg-muted/60 text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      {needsAttention ? (
        <ShieldAlertIcon className="size-4 shrink-0 text-destructive" />
      ) : (
        <MessagesSquareIcon
          className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
      {active ? (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary">
          Here
        </span>
      ) : (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
      )}
    </button>
  );
}

// A slim breadcrumb pinned above a sub-agent transcript: names the agent you are
// viewing, makes the exit visible, and binds Escape while mounted. Three ways
// back to Main — the "Main" crumb, the highlighted Main anchor, and Esc. No
// programmatic .focus() anywhere (WebKit 26.x).
export function SubagentBanner({
  label,
  status,
  onBack,
}: {
  label: string;
  status: RailStatus;
  onBack: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to main conversation"
        className="-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3.5" />
        Main
      </button>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
      <StatusMark status={status} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        Viewing {label}
      </span>
      <kbd className="hidden shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground/60 sm:inline">
        Esc
      </kbd>
    </div>
  );
}

// The whole rail. A pinned Main anchor at the top; live section (running +
// pinned failures) then a compact "Done" history section. Collapsed: a narrow
// icon edge with a Main button plus the count + status dots.
export function SubagentRail({
  agents,
  activeId,
  onSelect,
  collapsed = false,
  onToggle = NOOP,
  sessionLabel = "Main conversation",
  mainNeedsAttention,
  // Story 4.2 — THE WORKFLOWS SECTION AS A SLOT, NOT A WRAPPER.
  // `ui-contract.md` §3 says "The existing sub-agent rail GAINS a Workflows
  // section" — inside, sharing this rail's border, its collapse behaviour and
  // its scroll column. Rendering a sibling in the shell's `rail` slot instead
  // would give two bordered columns and a Workflows section that vanishes when
  // the rail collapses.
  //
  // BOTH PROPS ARE OPTIONAL AND BOTH RENDER IDENTICALLY TO TODAY WHEN ABSENT.
  // This component has two consumers — `session-view.tsx` and the demo
  // gallery's `conversation-full` configuration — and story 4.2 is fenced out
  // of the gallery, so the gallery must keep passing seven props and getting
  // exactly what it gets now.
  workflows,
  // THE SECOND COUNT, and it can drift. `workflowCount` is the TOTAL number of
  // runs — the same number `ultra-rail.tsx`'s header prints at its far right —
  // because the collapsed edge and the expanded header are one claim shown
  // twice. This rail cannot derive it: `workflows` arrives PRE-RENDERED and no
  // component can count a ReactNode, so the caller supplies it and nothing
  // structural keeps the two honest. If the Workflows section ever splits live
  // runs from a "Done · N" group and its header starts meaning "live only",
  // this number and the empty state below are the other two readers that must
  // move with it.
  workflowCount,
  surface = "rail",
}: {
  agents: RailAgent[];
  activeId: string;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  sessionLabel?: string;
  mainNeedsAttention?: boolean;
  workflows?: ReactNode;
  workflowCount?: number;
  /** `panel` embeds this index in the unified workspace dock. The historical
   *  `rail` shape remains available to the demo gallery. */
  surface?: "rail" | "panel";
}) {
  const live = agents.filter((c) => c.status !== "done");
  const history = agents.filter((c) => c.status === "done");
  const running = agents.filter((c) => c.status === "running").length;
  const failed = live.filter((c) => c.status === "error").length;
  const done = history.length;

  if (surface === "rail" && collapsed) {
    const mainActive = activeId === "main";
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
        <button
          type="button"
          onClick={() => onSelect("main")}
          aria-label="Back to main conversation"
          aria-current={mainActive ? "true" : undefined}
          className={cn(
            "rounded-md p-1 transition-colors",
            mainNeedsAttention
              ? "text-destructive hover:bg-muted"
              : mainActive
                ? "bg-muted text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {mainNeedsAttention ? (
            <ShieldAlertIcon className="size-4" />
          ) : (
            <MessagesSquareIcon className="size-4" />
          )}
        </button>
        <EdgeDots running={running} failed={failed} done={done} workflows={workflowCount} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col",
        surface === "panel"
          ? "h-full w-full min-w-0 bg-background"
          : "w-60 border-l border-border",
      )}
    >
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
        {surface === "rail" && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sub-agents rail"
            className="ml-auto rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelRightCloseIcon className="size-4" />
          </button>
        )}
      </div>

      {/* THE ORDER OF THIS PANEL IS ITS ORDER OF IMPORTANCE, top to bottom: the
          conversation you are in, the runs working for it, the agents, then
          what is already finished.

          MAIN IS FIRST. It used to sit BELOW the Workflows section, reasoned as
          "a run the user is watching stays put while the sub-agent list scrolls
          beneath it" — but both are pinned above the scroll area, so that goal
          never depended on the order of the two. What the old order actually
          did was bury the way back to the conversation under however many runs
          existed: with ten of them, "Main" was the eleventh thing in a panel
          whose whole purpose is getting back to the first. */}
      <div className="border-b border-border p-2">
        <MainRow
          active={activeId === "main"}
          onSelect={() => onSelect("main")}
          label={sessionLabel}
          needsAttention={mainNeedsAttention}
        />
      </div>

      {/* Story 4.2's Workflows section. Absent ⇒ nothing renders and the rail
          is byte-identical to what it was. */}
      {workflows}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* The third reader of `workflowCount` (see its declaration): the
            "nothing yet" copy is only true while NO run exists, live or not. */}
        {live.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/60">
            {surface === "panel" && history.length === 0 && (workflowCount ?? 0) === 0
              ? "Sub-agents and Ultras will appear here as they work."
              : "No sub-agents running."}
          </p>
        ) : (
          live.map((c) => (
            <SubagentCard
              key={c.id}
              card={c}
              active={activeId === c.id}
              onSelect={() => onSelect(c.id)}
            />
          ))
        )}

        {history.length > 0 && (
          <div className="mt-1 border-t border-border pt-2">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Done · {history.length}
            </div>
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
