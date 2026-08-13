"use client";

/**
 * The activity lane.
 *
 * REBUILT ON THE PORTED DESIGN SYSTEM. An earlier version of this file drew the
 * same information with hand-written `.vnext-*` CSS and hand-drawn SVG paths,
 * which is why the cockpit read as a different product: the shapes were roughly
 * right and every colour, weight, radius and icon was an approximation. Nothing
 * here invents a token or a glyph — colours come from the palette in globals.css
 * and icons from lucide, the same two sources the rest of Telar draws from.
 *
 * FOUR RULES, each of which a rebuild breaks first:
 *
 * 1. A TOOL ROW IS A ROW, NOT A CARD. Muted 12px text on transparent, with a
 *    hairline for nesting. Boxing each call turns a forty-step turn into a stack
 *    of containers.
 * 2. A LIVE TURN SHOWS ONE STEP, behind `+N earlier steps`. An agent running
 *    forty commands must not push the composer off the screen.
 * 3. A SETTLED TURN FOLDS ITS WORK behind `16 steps · Ran command ×12`. History
 *    reads as conclusions.
 * 4. ERRORS SURVIVE COLLAPSE. A fold hiding a failure carries the failure's
 *    colour, or a turn that failed and then said something reassuring reads as
 *    clean history.
 *
 * The one deliberate DIVERGENCE from the frozen app: it had no diff renderer at
 * all — an edit expanded to escaped JSON — and the engine now produces real
 * unified patches, so we render them.
 */

import { useMemo, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { Item } from "@telar/engine-client";
import { isToolItem, itemLabel, itemText, toolOutput, type JournalItem, type JournalTask } from "@/lib/vnext/journal";
import { MessageResponse } from "@/components/ui/message";
import { Shimmer } from "@/components/ui/shimmer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Deliberately small and literal. The lane is meant to be uniform and boring:
 *  an icon per tool would turn a long turn into a sticker album. The icon says
 *  WHICH KIND of thing happened; the mono preview beside it says what. */
const TOOL_ICON: Partial<Record<Item["detail"]["type"], typeof WrenchIcon>> = {
  command_execution: TerminalIcon,
  file_read: FileTextIcon,
  file_change: PencilIcon,
  web_search: SearchIcon,
  browser_action: GlobeIcon,
  mcp_tool_call: WrenchIcon,
  dynamic_tool_call: WrenchIcon,
};

/** The verb a row leads with. Past tense: the transcript is a record. */
function actionLabel(item: JournalItem): string {
  switch (item.detail.type) {
    case "command_execution":
      return "Ran command";
    case "file_read":
      return "Read file";
    case "file_change":
      return item.detail.change.kind === "create"
        ? "Created file"
        : item.detail.change.kind === "delete"
          ? "Deleted file"
          : "Edited file";
    case "web_search":
      return "Searched web";
    case "browser_action":
      return "Browsed";
    /**
     * NARRATION, not `assistant_message`. Prose that lands before the turn's
     * final answer folds into the activity group with the work it narrates, and
     * `itemLabel` has nothing better to say about it than the contract's own
     * enum — so a settled fan-out tallied as "assistant_message ×4", which is
     * the wire leaking into a sentence a person reads.
     */
    case "assistant_message":
      return "Said";
    default:
      return itemLabel(item);
  }
}

/** The salient argument, collapsed to one line and clipped. Never the payload.
 *  Split on CODE POINTS, not UTF-16 units — a plain slice can cut an astral
 *  character in half and render a broken glyph right at the boundary. */
function preview(item: JournalItem): string {
  const raw =
    item.detail.type === "command_execution"
      ? item.detail.command.command
      : item.detail.type === "file_read"
        ? item.detail.read.path
        : item.detail.type === "file_change"
          ? item.detail.change.path
          : item.detail.type === "web_search"
            ? item.detail.query
            : itemLabel(item);
  const flat = raw.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > 80 ? `${points.slice(0, 80).join("")}…` : flat;
}

const failed = (item: JournalItem) => item.status === "failed";
const running = (item: JournalItem) => item.status === "inProgress";

const ROW = "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs";

function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, index) => {
        // `---`/`+++`/`@@` are the file header, not a removed and an added
        // line. Tested first, or every diff opens with one of each.
        const header = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@");
        return (
          <span
            key={index}
            className={cn(
              "block whitespace-pre-wrap break-words",
              header
                ? "text-muted-foreground/70"
                : line.startsWith("+")
                  ? "bg-success/10 text-success"
                  : line.startsWith("-")
                    ? "bg-destructive/10 text-destructive"
                    : "text-muted-foreground",
            )}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function ToolRow({ item }: { item: JournalItem }) {
  const [open, setOpen] = useState(false);
  const change = item.detail.type === "file_change" ? item.detail.change : undefined;
  const output = toolOutput(item);
  const body = change?.unifiedDiff ?? output;
  const label = actionLabel(item);
  const isError = failed(item);
  const RowIcon = TOOL_ICON[item.detail.type] ?? WrenchIcon;

  return (
    <div className={cn("rounded-md", isError && "bg-destructive/10")}>
      <button
        type="button"
        className={cn(ROW, body && "hover:bg-muted/60")}
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {running(item) ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
            {`${label} · ${preview(item)}`}
          </Shimmer>
        ) : (
          <>
            <RowIcon className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
            <span className={cn("shrink-0", isError && "text-destructive")}>{label}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{preview(item)}</span>
          </>
        )}
        {change && (change.linesAdded || change.linesRemoved) ? (
          <span className="shrink-0 font-mono text-[10px]">
            {change.linesAdded ? <span className="text-success">+{change.linesAdded}</span> : null}
            {change.linesAdded && change.linesRemoved ? " " : null}
            {change.linesRemoved ? <span className="text-destructive">−{change.linesRemoved}</span> : null}
          </span>
        ) : null}
        {item.status === "declined" && (
          <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
            declined
          </Badge>
        )}
        {body && (
          <ChevronRightIcon
            className={cn("ml-auto size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && body && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border/70 py-1 pr-1.5 pl-3">
          {change?.unifiedDiff ? (
            <DiffBody diff={change.unifiedDiff} />
          ) : (
            <pre className="max-h-60 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Extended thinking. Italic, hairline-indented, quiet — never a card. */
function ReasoningRow({ item }: { item: JournalItem }) {
  const [open, setOpen] = useState(false);
  const text = itemText(item);
  if (!text.trim()) return null;

  if (running(item)) {
    return (
      <div className="py-1 text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-[11px] font-medium">
            Thinking
          </Shimmer>
        </div>
        <p className="ml-5 border-l border-border/70 pl-3 text-xs leading-relaxed whitespace-pre-wrap italic">
          {text}
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-muted-foreground/70 align-middle" />
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md">
      <button type="button" aria-expanded={open} onClick={() => setOpen((c) => !c)} className={cn(ROW, "text-muted-foreground hover:bg-muted/60")}>
        <span aria-hidden className="shrink-0">
          ✻
        </span>
        <span className="min-w-0 flex-1 truncate italic">Thought</span>
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/30 p-2 text-[11px] whitespace-pre-wrap italic text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}

/** A to-do list is never collapsed: the point of one is to be glanceable. */
function PlanRow({ item }: { item: JournalItem }) {
  if (item.detail.type !== "plan") return null;
  const steps = item.detail.plan.steps;
  const done = steps.filter((step) => step.status === "completed").length;

  return (
    <div className="rounded-md px-1.5 py-1">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5" />
        To-dos
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {done}/{steps.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed">
            <span className="mt-[3px] shrink-0">
              {step.status === "completed" ? (
                <CheckIcon className="size-3 text-primary" />
              ) : step.status === "inProgress" ? (
                /* NEUTRAL. Work in flight gets a neutral spinner, never a
                   saturated hue: --warning means "a person has to move" and
                   --info would swap one saturated colour for another. The
                   MOTION is the liveness signal. */
                <Loader2Icon className="size-3 animate-spin text-foreground" />
              ) : (
                <CircleIcon className="size-3 text-muted-foreground/40" />
              )}
            </span>
            <span
              className={cn(
                step.status === "completed" && "text-muted-foreground line-through",
                step.status === "inProgress" && "font-medium text-foreground",
                step.status === "pending" && "text-muted-foreground",
              )}
            >
              {step.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A SUB-AGENT IS ONE ROW HERE, AND ITS WORK IS SOMEWHERE ELSE.
 *
 * This used to expand its whole lane inline, open by default while running —
 * and a fan-out is precisely when that is unaffordable: two agents at sixteen
 * and thirteen steps buried the conversation under twenty-nine tool calls that
 * were never addressed to the reader. The thing you actually wanted, "what did
 * the main thread do next", was pushed off the bottom of the screen by work the
 * main thread had DELEGATED so it would not have to think about it.
 *
 * So this is the donor's agent chip (`AgentStepRow` in the frozen cockpit),
 * which says the same thing about it: "the raw input/output detail a normal tool
 * row would expand inline lives in the subagent's own tab instead, so there is
 * nothing to expand here." The chip is still in the transcript because WHERE a
 * fan-out happened is part of the story; what it did is a different surface.
 *
 * PRESSING IT OPENS THE AGENTS PANEL on this task. Where the donor switched a
 * tab strip above the conversation, this cockpit already has a panel with a tab
 * per surface, and a sub-agent is one — so the gesture is the same one every
 * other "go and look at that" in this app makes.
 */
function AgentChip({ task, onOpen }: { task: JournalTask; onOpen?: (taskId: string) => void }) {
  const live = task.state === "running" || task.state === "pending" || task.state === "waiting";
  const label = task.title ?? task.role ?? "Sub-agent";
  const isError = task.state === "failed";

  return (
    <button
      type="button"
      onClick={() => onOpen?.(task.id)}
      title={onOpen ? "Open in the Agents panel" : undefined}
      className={cn(ROW, "w-full text-left hover:bg-muted/60", isError && "bg-destructive/10")}
    >
      <BotIcon className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
      {live ? (
        <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
          {label}
        </Shimmer>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate font-medium", isError && "text-destructive")}>{label}</span>
      )}
      {/* Counted from the rows this agent PRODUCED, which is the only honest
          number available while it is still working. */}
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {task.items.length} step{task.items.length === 1 ? "" : "s"}
      </span>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function TranscriptItem({ item }: { item: JournalItem }) {
  if (item.detail.type === "task") return null;
  if (item.detail.type === "plan") return <PlanRow item={item} />;
  if (item.detail.type === "reasoning") return <ReasoningRow item={item} />;
  if (isToolItem(item)) return <ToolRow item={item} />;
  if (item.detail.type === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-1.5 py-1 text-xs text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
        {item.detail.error.message}
      </p>
    );
  }
  if (item.detail.type === "assistant_message") {
    return <MessageResponse streaming={running(item)}>{itemText(item)}</MessageResponse>;
  }
  // Forward compatibility: an unrecognised row is still a row. A silently
  // missing one is worse than an unstyled one.
  return <p className="px-1.5 text-xs text-muted-foreground">{itemLabel(item)}</p>;
}

/** `Ran command ×12 · Read file ×2`, in FIRST-APPEARANCE order — that preserves
 *  the shape of the turn: what the agent reached for first stays first. */
function tally(items: JournalItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = item.detail.type === "reasoning" ? "Thought" : actionLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(" · ");
}

/**
 * Rows that will actually PAINT.
 *
 * A reasoning block the provider opened and never filled renders nothing, and
 * counting it produced the visible lie "6 steps" above five rows. The tally and
 * the list must be derived from the same set.
 *
 * A `task` ITEM IS THE SPAWN ITSELF — the tool call that started a sub-agent —
 * and `TranscriptItem` has always returned null for it, because the agent it
 * started is already on screen as its own chip. Counting it left the same lie in
 * a worse place: a fan-out of four read as "8 steps · Map repo structure and
 * stack · Explore frontend app code · …", a tally naming four things that were
 * not rows and would never open.
 */
function renderable(items: JournalItem[]): JournalItem[] {
  return items.filter((item) =>
    item.detail.type === "task" ? false : item.detail.type === "reasoning" ? itemText(item).trim().length > 0 : true,
  );
}

/**
 * A run of activity rows: a rolling window while live, a tally once settled.
 * Both are the same sentence at two scales, so the grammar is learned once.
 */
export function ActivityGroup({
  items,
  live,
  tasks,
  onOpenAgent,
}: {
  items: JournalItem[];
  live: boolean;
  tasks: JournalTask[];
  onOpenAgent?: (taskId: string) => void;
}) {
  const anyFailed = useMemo(() => items.some(failed) || tasks.some((task) => task.state === "failed"), [items, tasks]);
  const [open, setOpen] = useState(false);
  const rows = renderable(items);
  if (rows.length === 0 && tasks.length === 0) return null;

  // Sub-agents are never hidden by the window: THAT a fan-out happened is part
  // of the conversation even when what it did is on another surface.
  const agents = tasks.map((task) => <AgentChip key={task.id} task={task} {...(onOpenAgent ? { onOpen: onOpenAgent } : {})} />);

  if (live) {
    const hidden = Math.max(0, rows.length - 1);
    const shown = open ? rows : rows.slice(-1);
    return (
      <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
        {hidden > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((c) => !c)}
            className={cn(ROW, "text-muted-foreground hover:bg-muted/50")}
          >
            <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            {/* A step that failed while scrolled out of the window must not be
                swallowed by the very mechanism that hid it. */}
            {!open && anyFailed && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" />}
            <span className={cn("shrink-0", !open && anyFailed && "text-destructive")}>
              {open ? "Show fewer steps" : `+${hidden} earlier step${hidden === 1 ? "" : "s"}`}
            </span>
          </button>
        )}
        {shown.map((item) => (
          <TranscriptItem key={item.id} item={item} />
        ))}
        {agents}
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((c) => !c)}
        className={cn(ROW, "text-muted-foreground hover:bg-muted/50", !open && anyFailed && "text-destructive")}
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {!open && anyFailed && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" />}
        <span className="shrink-0">
          {rows.length} step{rows.length === 1 ? "" : "s"}
        </span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="min-w-0 truncate text-muted-foreground/80">{tally(rows)}</span>
      </button>
      {open && (
        <div className="ml-2 flex flex-col gap-0.5 border-l border-border/70 pl-2">
          {rows.map((item) => (
            <TranscriptItem key={item.id} item={item} />
          ))}
        </div>
      )}
      {agents}
    </div>
  );
}

/**
 * A system event: dashed mono pill between two hairlines.
 *
 * STATE, NEVER PROSE. A marker says what HAPPENED, in a terse machine voice, as
 * a clause — "session detached", "provider changed · codex". It is never a
 * sentence addressed to the user. If the copy would read naturally after "Hi —",
 * it belongs in a turn, not here.
 *
 * There is no danger variant on purpose: a marker reports state, and a real
 * failure is a turn's business, not a divider's.
 */
export function Marker({ children, attention }: { children: React.ReactNode; attention?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-border" />
      <span
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-center font-mono text-[9px]",
          attention ? "border-warning/40 text-warning" : "border-border text-muted-foreground",
        )}
      >
        {attention && <TriangleAlertIcon className="size-3" />}
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Seconds of silence before the indicator flips to its long-silence state. */
const SILENCE_THRESHOLD = 20;

const formatElapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

/**
 * The tail of a live turn.
 *
 * NO BORDER, NO CARD, NO BACKGROUND — a status LINE at the same 11px muted
 * weight as a tool row's metadata. A bordered card gives a transient affordance
 * the visual weight of a permanent one, which is most of why a finished turn and
 * a running turn used to look equally loud.
 *
 * It deliberately does NOT name the running tool: the activity lane directly
 * above already renders that step, shimmering, with the same label. What is left
 * is the part nothing else carries — that the turn is alive, how long it has been
 * at it, and whether it has gone quiet.
 */
export function WorkingIndicator({ label, startedAt, now }: { label: string; startedAt?: number; now: number }) {
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const silent = elapsed >= SILENCE_THRESHOLD;

  return (
    <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground/70", silent && "text-warning/80")}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full motion-safe:animate-pulse", silent ? "bg-warning" : "bg-muted-foreground/50")}
      />
      <Shimmer as="span" className={cn("text-[11px]", silent && "text-warning/80")}>
        {label}
      </Shimmer>
      <span className="shrink-0 font-mono tabular-nums">{formatElapsed(elapsed)}</span>
      {/* A run that has said nothing for 20s is the case a detached session most
          needs surfaced — it is the difference between slow and stuck. */}
      {silent && <span className="shrink-0 font-mono tabular-nums text-warning">· no output {formatElapsed(elapsed)}</span>}
    </div>
  );
}
