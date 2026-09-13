"use client";

/**
 * The activity lane.
 *
 * REBUILT ON THE PORTED DESIGN SYSTEM. An earlier version of this file drew the
 * same information with hand-written bespoke CSS and hand-drawn SVG paths,
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

import { createContext, useContext, useMemo, useState } from "react";
import {
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  HourglassIcon,
  Minimize2Icon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { Item, RateLimitType, TurnFailureCode } from "@telar/engine-client";
import { isToolItem, itemLabel, itemText, toolOutput, type JournalItem, type JournalTask, type JournalTurn } from "@/lib/engine/journal";
import { fmtTokens } from "@/lib/format";
import { CONSULT_TALLY_LABEL, foldHarnessRows, harnessConsult } from "@/lib/harness-paths";
import { toolInputSummary } from "@/lib/tool-input-summary";
import { attachmentUrl } from "@/lib/ds";
import { fileReference } from "@/lib/drag-reference";
import { MessageMenu, MessageResponse } from "@/components/ui/message";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Shimmer } from "@/components/ui/shimmer";
import { CODE_SURFACE_FRAME, CODE_SURFACE_LINES, CODE_SURFACE_TEXT, CodeSurface, CopyButton, foldLines } from "@/components/ui/code-surface";
import { Badge } from "@/components/ui/badge";
// The ONE definition of what a message looks like — shared with the cockpit so
// a message sent mid-run and one sent idle cannot drift apart.
import { AgentMessageBubble, ConversationMessage, type OpenTab } from "@/components/session/conversation-message";
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
 *  character in half and render a broken glyph right at the boundary.
 *
 *  A TOOL CALL'S ARGUMENT IS ITS INPUT, not its name: falling back to the label
 *  here is what made a row say "ds_scratch ds_scratch", the tool's name twice
 *  where its first line of code belonged (#354). Empty is a legitimate answer —
 *  a call with no readable input is a row that says the tool's name once. */
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
            : item.detail.type === "mcp_tool_call" || item.detail.type === "dynamic_tool_call" || item.detail.type === "browser_action"
              ? toolInputSummary(item.detail.call.input) ?? ""
              : itemLabel(item);
  const flat = raw.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > 80 ? `${points.slice(0, 80).join("")}…` : flat;
}

const failed = (item: JournalItem) => item.status === "failed";
const running = (item: JournalItem) => item.status === "inProgress";

const ROW = "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs";

/**
 * THE GESTURES A TRANSCRIPT ROW CAN OFFER THAT IT CANNOT PERFORM ITSELF.
 *
 * All of them belong to the cockpit — it owns the draft and it owns the panel —
 * and all are threaded rather than reached for, exactly as `onOpenAgent` and
 * `onOpenTab` already are. Absent means the item is not rendered; nothing here
 * falls back to a second route.
 */
export type RowGestures = {
  /** Put text into the message being written — `insertIntoComposer` in the
   *  cockpit. A quote and a file reference both land through it. */
  onInsert?: (text: string) => void;
  /** Open a path in the Editor — the cockpit's own `showPanelTab`, which reads
   *  a file-shaped id and routes it there. */
  onOpenFile?: (path: string) => void;
  /** Open a path in a NEW Editor tab (#322), so a file the agent touched can be
   *  read beside whatever the Editor already holds. */
  onOpenFileInNewTab?: (path: string) => void;
};

/**
 * THE SESSION'S OWN CHECKOUT, for the one rule that has to know what is outside
 * it (see `lib/harness-paths.ts`).
 *
 * A CONTEXT RATHER THAN A PROP because it is not the transcript's business and
 * every row would have to carry it: the path is a fact about the session, the
 * same for every turn on screen, and threading it through four components to
 * reach one predicate would put it in the signature of things that never use
 * it. Unset is a legitimate state — the harness-root test still holds on its
 * own, it is merely less guarded.
 */
const WorkspaceContext = createContext<string | undefined>(undefined);

export function TranscriptWorkspace({ path, children }: { path?: string; children: React.ReactNode }) {
  return <WorkspaceContext.Provider value={path}>{children}</WorkspaceContext.Provider>;
}

/** The path a row is ABOUT, when it is about one. */
function rowPath(item: JournalItem): string | undefined {
  if (item.detail.type === "file_change") return item.detail.change.path;
  if (item.detail.type === "file_read") return item.detail.read.path;
  return undefined;
}

/** A diff is SOURCE: read as written, never wrapped, cut at 24 lines like any
 *  other tool body — copy still writes the whole patch. */
function DiffBody({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, total } = expanded ? { shown: diff, total: diff.split("\n").length } : foldLines(diff);
  return (
    <div className={cn("relative pr-8", CODE_SURFACE_FRAME)}>
      <CopyButton text={diff} className="absolute top-1 right-1 z-10 bg-muted/60" />
      <pre className={cn("overflow-x-auto px-2.5 py-2", CODE_SURFACE_TEXT)}>
        {shown.split("\n").map((line, index) => {
          // `---`/`+++`/`@@` are the file header, not a removed and an added
          // line. Tested first, or every diff opens with one of each.
          const header = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@");
          return (
            <span
              key={index}
              className={cn(
                "block",
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
      {total > CODE_SURFACE_LINES && (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex w-full items-center border-t border-border/70 px-2.5 py-1 text-left text-[0.6875rem] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show all · ${total} lines`}
        </button>
      )}
    </div>
  );
}

function ToolRow({ item, onInsert, onOpenFile, onOpenFileInNewTab }: { item: JournalItem } & RowGestures) {
  const [open, setOpen] = useState(false);
  const change = item.detail.type === "file_change" ? item.detail.change : undefined;
  const output = toolOutput(item);
  const body = change?.unifiedDiff ?? output;
  const label = actionLabel(item);
  const isError = failed(item);
  const RowIcon = TOOL_ICON[item.detail.type] ?? WrenchIcon;
  const command = item.detail.type === "command_execution" ? item.detail.command.command : undefined;
  const path = rowPath(item);
  // A row about nothing copyable gets no menu at all, rather than an empty
  // popup that opens and offers you the choice of nothing.
  const hasMenu = Boolean(command || body || path);
  // Nothing readable about the input: the row is the verb, once, rather than
  // the verb followed by an empty mono slot.
  const argument = preview(item);

  const row = (
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
            {argument ? `${label} · ${argument}` : label}
          </Shimmer>
        ) : (
          <>
            <RowIcon className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
            <span className={cn("shrink-0", isError && "text-destructive")}>{label}</span>
            {argument && <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{argument}</span>}
          </>
        )}
        {change && (change.linesAdded || change.linesRemoved) ? (
          <span className="shrink-0 font-mono text-[0.625rem]">
            {change.linesAdded ? <span className="text-success">+{change.linesAdded}</span> : null}
            {change.linesAdded && change.linesRemoved ? " " : null}
            {change.linesRemoved ? <span className="text-destructive">−{change.linesRemoved}</span> : null}
          </span>
        ) : null}
        {item.status === "declined" && (
          <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[0.5625rem]">
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
          {change?.unifiedDiff ? <DiffBody diff={change.unifiedDiff} /> : <CodeSurface text={output ?? ""} wrap />}
        </div>
      )}
    </div>
  );
  if (!hasMenu) return row;

  /**
   * THE ROW'S MENU IS ABOUT WHAT THE ROW IS ABOUT. A command row offers the
   * command; a file row offers the file — its path, its reference, and the one
   * thing the row cannot do by itself, which is open it.
   *
   * NOTHING HERE IS A VERB. A transcript is a record, and a menu on a record
   * that could re-run a command or undo an edit would be offering to change
   * what happened. "Retry from here" is the item this list is missing on
   * purpose: there is no engine route for it, and faking one by re-submitting
   * the prompt would write a NEW turn while reading as a correction to an old
   * one.
   */
  return (
    <ContextMenu>
      <ContextMenuTrigger>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        {command && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(command)}>Copy command</ContextMenuItem>}
        {body && (
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(body)}>
            {change?.unifiedDiff ? "Copy patch" : "Copy output"}
          </ContextMenuItem>
        )}
        {path && (command || body) && <ContextMenuSeparator />}
        {path && onOpenFile && <ContextMenuItem onClick={() => onOpenFile(path)}>Open file in the Editor</ContextMenuItem>}
        {/* …or in an Editor of its own, so this file can be read beside the one
            already open rather than replacing it (#322). */}
        {path && onOpenFileInNewTab && (
          <ContextMenuItem onClick={() => onOpenFileInNewTab(path)}>Open in a new panel tab</ContextMenuItem>
        )}
        {path && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(path)}>Copy path</ContextMenuItem>}
        {path && onInsert && <ContextMenuItem onClick={() => onInsert(fileReference(path).text)}>Insert as reference</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
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
          <Shimmer as="span" className="text-[0.6875rem] font-medium">
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
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/30 p-2 text-[0.6875rem] whitespace-pre-wrap italic text-muted-foreground">
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
        <span className="font-mono text-[0.625rem] text-muted-foreground/70">
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
 * A SUB-AGENT IS A TOOL CALL — a fancier one — AT THE PLACE IT WAS SPAWNED.
 *
 * Before this the spawn item (`detail.type === "task"`) rendered nothing, and
 * the agent appeared as a CHIP appended to the tail of whichever fold was
 * current: at the bottom while the turn worked, then at the top of the tally
 * once it settled. It floated, detached from the moment the agent reached for
 * it — which is the one thing a chat history is for. T3 Code draws the same
 * thing where it belongs: one anchored row per spawn, in stream order, whose
 * status is derived live from the task rows, and which never folds while the
 * agent it names is still out (its own `deriveTurnFolds` rule).
 *
 * So this is the `Task` tool call's row, and it reads like `ToolRow`: an icon,
 * a verb, the title, then what a tool row cannot say — the agent's live state,
 * its tokens, and a "▸ Open" into the Agents panel. Expanding it shows the
 * agent's RESPONSE (its `resultText`) once it has one; its step-by-step work
 * stays on the panel, for the reason the chip's comment gave: a fan-out of
 * twenty-nine tool calls addressed to nobody must not bury the conversation.
 */
function AgentRow({ item, task, onOpen, onInsert }: { item: JournalItem; task: JournalTask | undefined; onOpen?: (taskId: string) => void } & Pick<RowGestures, "onInsert">) {
  const [open, setOpen] = useState(false);
  const state = task?.state ?? (item.status === "inProgress" ? "running" : item.status === "failed" ? "failed" : "completed");
  const live = state === "running" || state === "pending" || state === "waiting";
  const isError = state === "failed";
  const label = task?.title ?? item.title ?? task?.role ?? "Sub-agent";
  const role = task?.role;
  const body = task?.resultText ?? task?.failure;
  const tokens = task?.usage ? task.usage.tokens.input + task.usage.tokens.output : undefined;
  const status = AGENT_STATE[state];
  const taskId = item.detail.type === "task" ? item.detail.taskId : task?.id;

  const row = (
    <div className={cn("rounded-md", isError && "bg-destructive/10")}>
      <div className={cn(ROW, "gap-2")}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          disabled={!body}
          aria-expanded={body ? open : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <BotIcon className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
          {live ? (
            <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
              {`${live && state === "running" ? "Running" : "Kicked off"}${role ? ` ${role}` : " agent"} · ${label}`}
            </Shimmer>
          ) : (
            <>
              <span className={cn("shrink-0", isError && "text-destructive")}>{`Ran${role ? ` ${role}` : " agent"}`}</span>
              <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{label}</span>
            </>
          )}
          {body && (
            <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          )}
        </button>
        <span className={cn("shrink-0 font-mono text-[0.625rem] tabular-nums", isError ? "text-destructive" : "text-muted-foreground")}>
          {status}
          {tokens ? ` · ${fmtTokens(tokens)}` : ""}
        </span>
        {onOpen && taskId && (
          <button
            type="button"
            onClick={() => onOpen(taskId)}
            title="Open in the Agents panel"
            className="shrink-0 rounded px-1 text-[0.625rem] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Open ▸
          </button>
        )}
      </div>
      {open && body && (
        <div className="ml-3 border-l border-border/70 py-1 pr-1.5 pl-3">
          {task?.failure ? (
            <p className="text-xs text-destructive">{task.failure}</p>
          ) : (
            <MessageResponse>{body}</MessageResponse>
          )}
        </div>
      )}
    </div>
  );

  /**
   * THE AGENT ROW'S MENU IS THE MESSAGE MENU PLUS THE VERB ONLY IT HAS.
   *
   * What the agent SAID is a message like any other — copyable, quotable — and
   * "Open in the Agents panel" is the row's own `Open ▸` button under another
   * name, offered here only where that button is offered, which is exactly
   * where `onOpen` and a `taskId` both exist.
   *
   * An agent that has not answered yet has nothing to copy; `MessageMenu`
   * renders its child bare in that case, so a live fan-out's rows keep their
   * ordinary right-click rather than opening a menu of one disabled row.
   */
  const jump =
    onOpen && taskId ? <ContextMenuItem onClick={() => onOpen(taskId)}>Open in the Agents panel</ContextMenuItem> : undefined;
  if (!body && !jump) return row;
  if (!body && jump) {
    return (
      <ContextMenu>
        <ContextMenuTrigger>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-auto">{jump}</ContextMenuContent>
      </ContextMenu>
    );
  }
  return (
    <MessageMenu text={body ?? ""} {...(onInsert ? { onQuote: onInsert } : {})} {...(jump ? { items: jump } : {})}>
      {row}
    </MessageMenu>
  );
}

/** The agent row's state word — the same six the Agents panel uses. */
const AGENT_STATE: Record<JournalTask["state"], string> = {
  pending: "queued",
  running: "running",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A spawn's own row. `task` is the live row the spawn opened, looked up by
 *  the handle's `taskId`; absent while the task event has not arrived yet. */
export function isAgentItem(item: JournalItem): boolean {
  return item.detail.type === "task";
}

/**
 * A compaction is a SEAM in the conversation, not a tool call: the provider
 * squeezed its own memory, and this row is why the agent may suddenly know
 * less than it did a message ago. Which is exactly why it must render — the
 * generic fallback drew the bare string "context_compaction", and before that
 * the Claude driver dropped the message entirely and the seam was invisible.
 */
function CompactionRow({ item }: { item: JournalItem }) {
  const detail = item.detail.type === "context_compaction" ? item.detail : undefined;
  const label = running(item) ? "Compacting context…" : item.status === "failed" ? "Compaction failed" : "Compacted context";
  const reclaimed =
    detail?.preTokens !== undefined && detail?.postTokens !== undefined
      ? `${fmtTokens(detail.preTokens)} → ${fmtTokens(detail.postTokens)}`
      : undefined;
  return (
    <p className={cn(ROW, item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
      <Minimize2Icon className="size-3.5 shrink-0" />
      {running(item) ? (
        <Shimmer as="span" className="min-w-0 flex-1 truncate">
          {label}
        </Shimmer>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {detail?.reason === "auto" && <span className="shrink-0 text-[0.625rem] opacity-70">automatic</span>}
      {reclaimed && <span className="shrink-0 font-mono text-[0.625rem] tabular-nums">{reclaimed}</span>}
    </p>
  );
}

/**
 * THE PROVIDER MADE THE TURN WAIT — a retry after a failed request, or a rate
 * limit. Rendered as a seam like a compaction rather than as a tool call,
 * because that is what it is: the reason the session went quiet, and the one
 * thing that distinguishes a provider backoff from the agent thinking. It
 * shimmers while the wait is open and settles when the stream speaks again.
 *
 * A rate limit is drawn in the destructive colour only when it was REJECTED —
 * a warning is information, and colouring it as a failure would make a session
 * that is working fine read as broken.
 */
function ProviderWaitRow({ item }: { item: JournalItem }) {
  const detail = item.detail.type === "provider_wait" ? item.detail.wait : undefined;
  const rejected = detail?.limitStatus === "rejected";
  const resets =
    detail?.resetsAt === undefined ? undefined : new Date(detail.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <p className={cn(ROW, rejected ? "text-destructive" : "text-muted-foreground")}>
      <HourglassIcon className="size-3.5 shrink-0" />
      {running(item) ? (
        <Shimmer as="span" className="min-w-0 flex-1 truncate">
          {itemLabel(item)}
        </Shimmer>
      ) : (
        <span className="min-w-0 flex-1 truncate">{itemLabel(item)}</span>
      )}
      {resets && <span className="shrink-0 text-[0.625rem] opacity-70">resets {resets}</span>}
    </p>
  );
}

/**
 * A wake from ANOTHER SESSION — the engine wrote it because a peer this one
 * subscribed to did something. The verb names the happening; the label names
 * the peer by its id's tail, since the wake text itself carries the title on
 * expand.
 *
 * HERE RATHER THAN IN THE COCKPIT because both surfaces name a wake and only
 * one import direction exists (cockpit → transcript): a wake that lands while
 * the session is idle is a turn header there, and the same wake landing
 * mid-turn is a row here. Two spellings of "Session finished a turn" would be
 * the bug this file already fixed, reintroduced in words.
 */
export function sessionWakeLabel(reason: NonNullable<JournalTurn["wakeReason"]>): { verb: string; Icon: typeof BotIcon } {
  switch (reason.kind) {
    case "turn_completed":
      return { verb: "Session finished a turn", Icon: BotIcon };
    case "turn_failed":
      return { verb: "Session failed a turn", Icon: BotIcon };
    case "turn_stopped":
      return { verb: "Session was stopped", Icon: BotIcon };
    case "request_opened":
      return { verb: "Session asked a question", Icon: BotIcon };
  }
}

/**
 * A WAKE THAT LANDED MID-TURN. Collapsed to its verb and the peer's id, the
 * text behind a disclosure — the same shape the cockpit gives a wake that
 * arrived while the session was idle, because it is the same happening. It is
 * emphatically NOT the person's bubble: the human typed none of it.
 */
function SteeredWakeRow({ item, reason }: { item: JournalItem; reason: NonNullable<JournalTurn["wakeReason"]> }) {
  const [open, setOpen] = useState(false);
  const { verb, Icon } = sessionWakeLabel(reason);
  const body = itemText(item).trim();
  return (
    <div className="py-0.5" aria-label="Wake from another session">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs"
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{verb}</span>
        <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{`session …${reason.sessionId.slice(-6)}`}</span>
        {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {open && body && <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-1.5 pb-1 text-xs text-muted-foreground">{body}</p>}
    </div>
  );
}

/**
 * A MESSAGE SENT INTO A RUNNING TURN — and it is drawn as a message, not as a
 * thing that happened during one.
 *
 * IT USED TO HAVE ITS OWN BUBBLE: narrower, differently padded, a smaller type
 * scale, its attachment chips a size down from the ones on the identical
 * message sent a second earlier while the agent was idle. Nothing about being
 * delivered mid-run makes it a different kind of object to the person who
 * typed it, and the difference read as one. It now renders through
 * `ConversationMessage`, the same component the turn's own message uses.
 *
 * WHAT STAYS DIFFERENT IS AUTHORSHIP, and only where it already was: a peer
 * agent's words and an engine wake are not the person's, and each is drawn the
 * way that same origin is drawn when it arrives idle. There is no badge, no
 * compact variant and no card earned merely by arriving mid-run.
 */
function SteeredMessageRow({ item, onOpenTab, onInsert }: { item: JournalItem; onOpenTab?: OpenTab } & Pick<RowGestures, "onInsert">) {
  const attachments = item.detail.type === "user_message" ? item.detail.attachments : undefined;
  const sender = item.detail.type === "user_message" ? item.detail.sender : undefined;
  const notice = item.detail.type === "user_message" ? item.detail.notice : undefined;
  const wakeReason = item.detail.type === "user_message" ? item.detail.wakeReason : undefined;
  // A WAKE IS NOBODY'S BUBBLE. The engine wrote it because a subscribed
  // session did something; the person did not type it and no agent sent it.
  // The same happening queues as its own turn when the recipient is idle and
  // the cockpit draws THAT as a wake row — this is the mid-turn twin of it,
  // so the two read as one kind of thing however the wake happened to land.
  // Keyed on the structured stamp, never on the `[wake: …]` text.
  if (wakeReason) return <SteeredWakeRow item={item} reason={wakeReason} />;
  // AN AGENT'S WORDS ARE NOT THE PERSON'S BUBBLE — the same dashed, labelled
  // shape the cockpit gives an agent-sent turn, so the two read alike.
  if (sender) return <AgentMessageBubble text={itemText(item)} sender={sender} {...(notice ? { notice } : {})} {...(attachments ? { attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />;
  // A PERSON'S MESSAGE IS NOT MARKDOWN. It is the draft they typed, chips and
  // all, so "Copy as Markdown" would offer the same string a second time under
  // a name that claims something about it which is not true.
  return (
    <MessageMenu text={itemText(item)} markdown={false} {...(onInsert ? { onQuote: onInsert } : {})}>
      <ConversationMessage text={itemText(item)} {...(attachments ? { attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />
    </MessageMenu>
  );
}

/**
 * A FIGURE, WHERE IT WAS DRAWN. Bounded in height so a run that plots ten
 * things stays a transcript rather than a poster; the Plots surface has them
 * large. The bytes come from the attachment route — nothing is inlined.
 */
function PlotRow({ item, attachmentId }: { item: JournalItem; attachmentId: string }) {
  return (
    <figure className="my-1 max-w-md overflow-hidden rounded-md border border-border bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={attachmentUrl(item.sessionId, attachmentId)} alt={itemLabel(item)} className="block max-h-72 w-full object-contain" loading="lazy" />
      <figcaption className="border-t border-border bg-background px-2 py-0.5 text-[0.625rem] text-muted-foreground">{itemLabel(item)}</figcaption>
    </figure>
  );
}

export function TranscriptItem({ item, tasks, onOpenAgent, onOpenTab, onInsert, onOpenFile, onOpenFileInNewTab }: {
  item: JournalItem;
  tasks?: readonly JournalTask[];
  onOpenAgent?: (taskId: string) => void;
  /** So a message steered into a running turn opens its references exactly
   *  as the same message sent idle does. */
  onOpenTab?: OpenTab;
} & RowGestures) {
  const gestures = { ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  if (item.detail.type === "task") {
    const taskId = item.detail.taskId;
    const task = tasks?.find((candidate) => candidate.id === taskId);
    // A backgrounded SHELL spawned as a task is the `Ran command` row already
    // beside it; only a delegate (or a warp run) earns an agent row.
    if (task && !transcriptTasks([task]).length) return null;
    return <AgentRow item={item} task={task} {...(onOpenAgent ? { onOpen: onOpenAgent } : {})} {...(onInsert ? { onInsert } : {})} />;
  }
  if (item.detail.type === "plan") return <PlanRow item={item} />;
  if (item.detail.type === "reasoning") return <ReasoningRow item={item} />;
  if (item.detail.type === "context_compaction") return <CompactionRow item={item} />;
  if (item.detail.type === "provider_wait") return <ProviderWaitRow item={item} />;
  if (item.detail.type === "user_message") return <SteeredMessageRow item={item} {...(onOpenTab ? { onOpenTab } : {})} {...(onInsert ? { onInsert } : {})} />;
  if (item.plotAttachmentId) return <PlotRow item={item} attachmentId={item.plotAttachmentId} />;
  if (isToolItem(item)) return <ToolRow item={item} {...gestures} />;
  if (item.detail.type === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-1.5 py-1 text-xs text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
        {item.detail.error.message}
      </p>
    );
  }
  if (item.detail.type === "assistant_message") {
    // NO MENU WHILE IT IS STILL BEING WRITTEN. Copying or quoting half a
    // sentence gives you half a sentence, and the reader cannot tell from the
    // clipboard that the rest arrived a moment later.
    const text = itemText(item);
    if (running(item)) return <MessageResponse streaming>{text}</MessageResponse>;
    return (
      <MessageMenu text={text} {...(onInsert ? { onQuote: onInsert } : {})}>
        <MessageResponse>{text}</MessageResponse>
      </MessageMenu>
    );
  }
  // Forward compatibility: an unrecognised row is still a row. A silently
  // missing one is worse than an unstyled one.
  return <p className="px-1.5 text-xs text-muted-foreground">{itemLabel(item)}</p>;
}

/** `Ran command ×12 · Read file ×2`, in FIRST-APPEARANCE order — that preserves
 *  the shape of the turn: what the agent reached for first stays first.
 *
 *  A ROW THE LIST FOLDED IS TALLIED AS WHAT THE FOLD CALLS IT. Otherwise the
 *  summary re-states the noise the fold just removed — "Read file ×3 · Ran
 *  command" over a line that says the harness consulted a skill (#354). */
export function tallyParts(items: readonly JournalItem[], workspace?: string): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const action = harnessConsult(item, workspace)
      ? CONSULT_TALLY_LABEL
      : item.detail.type === "reasoning"
        ? "Thought"
        : item.detail.type === "task"
          ? "Ran agent"
          : actionLabel(item);
    const label = /^Reconnecting(?:\.{3}|…)\s*\d+\/\d+$/i.test(action.trim()) ? "Reconnect attempt" : action;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

/**
 * Rows that will actually PAINT.
 *
 * A reasoning block the provider opened and never filled renders nothing, and
 * counting it produced the visible lie "6 steps" above five rows. The tally and
 * the list must be derived from the same set.
 *
 * A `task` ITEM IS THE SPAWN ITSELF — the tool call that started a sub-agent —
 * and it IS a row now (`AgentRow`), so it counts, unless it names a background
 * shell that `transcriptTasks` would drop.
 */
function renderable(items: JournalItem[], tasks: readonly JournalTask[] = []): JournalItem[] {
  return items.filter((item) => {
    if (item.detail.type === "task") {
      const taskId = item.detail.taskId;
      const task = tasks.find((candidate) => candidate.id === taskId);
      return !task || transcriptTasks([task]).length > 0;
    }
    return item.detail.type === "reasoning" ? itemText(item).trim().length > 0 : true;
  });
}

/**
 * A SPAWN ROW NEVER FOLDS WHILE ITS AGENT IS OUT — T3 Code's rule, kept for
 * the same reason: a still-running fleet hidden behind "12 steps" is invisible
 * exactly when the human most wants to see it. A settled run is cut around
 * its live spawns; each cut is tallied on its own and the spawn rows stand
 * between them, in place.
 */
export function cutAroundLiveAgents(items: JournalItem[], tasks: readonly JournalTask[]): Array<{ kind: "run"; items: JournalItem[] } | { kind: "agent"; item: JournalItem }> {
  const out: Array<{ kind: "run"; items: JournalItem[] } | { kind: "agent"; item: JournalItem }> = [];
  for (const item of items) {
    const taskId = item.detail.type === "task" ? item.detail.taskId : undefined;
    const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : undefined;
    const liveAgent = task !== undefined && (task.state === "running" || task.state === "pending" || task.state === "waiting");
    if (liveAgent) {
      out.push({ kind: "agent", item });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "run") last.items.push(item);
    else out.push({ kind: "run", items: [item] });
  }
  return out;
}

/**
 * The tasks the CONVERSATION shows, which is not every task in the turn.
 *
 * A BACKGROUNDED SHELL IS NOT A DELEGATE, and drawing it as one was a hole this
 * file kept open after `Task.kind` was introduced: the Processes tab took the
 * split, `turnActivity` below took the split, and the chips did not — so a
 * `bun run verify` came back as a bot-icon row titled with the command and
 * "0 steps", which reads as a sub-agent that never reported. It reported fine.
 * It has no steps because a background shell produces no journal items; its
 * output streams to the turn that started it.
 *
 * DROPPED RATHER THAN RESTYLED, and nothing is lost by dropping it: the tool
 * call that backgrounded the shell is already an ordinary `Ran command` row in
 * this same turn. The chip was a second, worse telling of a thing the
 * transcript had already said, and the live process belongs on the Processes
 * tab, where it can be watched and stopped.
 *
 * A WARP RUN SURVIVES THE FILTER. Its own row is `background` — it outlives its
 * turn — but it carries warp linkage, and it is the row that says a fan-out
 * happened at all. Dropping it would leave its agents as loose chips under no
 * heading. This is the same "kind split happens AFTER the warp fold" rule
 * `splitRoster` states in right-panel.tsx, applied to a flat list.
 */
export function transcriptTasks(tasks: readonly JournalTask[]): JournalTask[] {
  return tasks.filter((task) => task.kind !== "background" || Boolean(task.warp));
}

/**
 * A live turn, cut at its SEAMS.
 *
 * Prose, a steer, a plan and a compaction are rows the reader is meant to see
 * as they land; everything between two of them is a run of work. Before this,
 * a live turn had ONE window over everything before its last narration and
 * dumped every tool call after that narration as a flat row — so a turn that
 * said one sentence mid-way then ran twenty commands stacked twenty rows, and
 * only folded them when it finished. The fold now happens as the turn works:
 * a run is compacted to its tally the moment the agent moves past it, and only
 * the run still being written keeps the rolling window. A settled turn is
 * still one fold (see `SessionTurn`); this is the same tally, applied earlier.
 */
export type ActivitySegment = { kind: "run"; items: JournalItem[] } | { kind: "row"; item: JournalItem };

// A provider wait is a seam for the same reason a compaction is: it explains
// something the reader can otherwise only experience as the session hanging,
// and folding it into a run tally ("18 steps · Ran command ×12") would hide the
// one row that says why nothing happened for four minutes.
const SEAM = new Set<Item["detail"]["type"]>(["assistant_message", "user_message", "plan", "context_compaction", "provider_wait"]);

/**
 * A TURN, CUT INTO RESPONSES AT ITS MESSAGE BOUNDARIES. A message sent into a
 * running turn is a boundary in the conversation, not an event inside the
 * work: what the agent does next is a response TO it.
 *
 * A live turn already seamed on `user_message`; a settled one folded every
 * item into one `ActivityGroup` inside the assistant's lane, so the message
 * vanished into "N steps" when the turn ended and, unfolded, sat nested in the
 * assistant's own bubble. Live and reload disagreed about whether it existed.
 *
 * The first response has no boundary — its cause is the turn's prompt, drawn
 * above. Same rule as T3 Code's timeline (pinned 1d1bf504,
 * `MessagesTimeline.logic.ts:503-531`), applied explicitly because Telar keeps
 * messages as items inside a turn rather than as free rows.
 */
export type TurnResponse = { boundary?: JournalItem; items: JournalItem[] };

export function splitAtMessageBoundaries(items: readonly JournalItem[]): TurnResponse[] {
  const responses: TurnResponse[] = [{ items: [] }];
  for (const item of items) {
    if (item.detail.type === "user_message") responses.push({ boundary: item, items: [] });
    else responses.at(-1)!.items.push(item);
  }
  // A turn whose only message is its own prompt is one response, and renders
  // exactly as it always did.
  return responses.length > 1 && responses[0]!.items.length === 0 ? responses.slice(1) : responses;
}

/**
 * THE ORDER THE TURN IS EMITTED IN — a boundary, then the work it introduced,
 * for every response. `SessionTurn` renders exactly this sequence, so a test
 * over it is a test of the assembly and not merely of the splitter's shape.
 *
 * The distinction matters: the splitter can group correctly while the renderer
 * still emits the parts in the wrong order, which is precisely the bug review
 * caught — work drawn above the message that caused it, for every steer but
 * the last.
 */
export function turnRenderOrder(items: readonly JournalItem[]): Array<{ kind: "boundary"; item: JournalItem } | { kind: "work"; items: JournalItem[] }> {
  return splitAtMessageBoundaries(items).flatMap((response) => [
    ...(response.boundary ? [{ kind: "boundary" as const, item: response.boundary }] : []),
    ...(response.items.length > 0 ? [{ kind: "work" as const, items: response.items }] : []),
  ]);
}

export function segmentActivity(items: readonly JournalItem[]): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  for (const item of items) {
    if (SEAM.has(item.detail.type)) {
      segments.push({ kind: "row", item });
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === "run") last.items.push(item);
    else segments.push({ kind: "run", items: [item] });
  }
  return segments;
}

/**
 * ONE RESPONSE'S WORK, CUT AT ITS SEAMS — the only way any response is drawn,
 * live or already closed by a steer.
 *
 * `liveTail` says whether the LAST run is still being appended to (a rolling
 * window) or is finished (a tally). It does NOT decide whether prose is
 * visible: an assistant message is a seam at every scale, so it is a row here
 * whether the turn is running or over.
 *
 * A RESPONSE CLOSED BY A STEER STILL GOES THROUGH THIS. Rendering those items
 * as one `ActivityGroup` instead was the regression: the assistant's live
 * prose, which had not finished streaming when the person typed, was swept
 * into the fold above their message and went on streaming inside a collapsed
 * step — text presented as a tool call, still growing where nobody could read
 * it. The seam rule is what keeps prose prose, so every response uses it.
 */
export function LiveActivity({
  items,
  tasks,
  liveTail = true,
  onOpenAgent,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
}: {
  items: JournalItem[];
  tasks: JournalTask[];
  liveTail?: boolean;
  onOpenAgent?: (taskId: string) => void;
} & RowGestures) {
  const segments = segmentActivity(items);
  const tail = liveTail ? segments.length - 1 : -1;
  const open = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "row" ? (
          <TranscriptItem key={segment.item.id} item={segment.item} tasks={tasks} {...open} />
        ) : (
          // Keyed by the run's FIRST item so the fold's open state survives
          // rows appending to it, and so a run that just settled keeps the
          // same element when its neighbour opens.
          <ActivityGroup key={segment.items[0]!.id} items={segment.items} tasks={tasks} live={index === tail} {...open} />
        ),
      )}
    </>
  );
}

/**
 * A run of activity rows: a rolling window while live, a tally once settled.
 * Both are the same sentence at two scales, so the grammar is learned once.
 *
 * SPAWN ROWS ARE ROWS IN THE RUN, at the place the agent was reached for —
 * no longer chips hung off the tail. While the run is live they ride the
 * window like any step; once it settles, a spawn whose agent is STILL OUT is
 * never folded (`cutAroundLiveAgents`), so a fleet in flight stays visible.
 */
export function ActivityGroup({
  items,
  live,
  tasks,
  onOpenAgent,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
}: {
  items: JournalItem[];
  live: boolean;
  tasks: JournalTask[];
  onOpenAgent?: (taskId: string) => void;
} & RowGestures) {
  const rows = useMemo(() => renderable(items, tasks), [items, tasks]);
  const open = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  if (rows.length === 0) return null;
  if (live) return <LiveRun rows={rows} tasks={tasks} {...open} />;
  const cuts = cutAroundLiveAgents(rows, tasks);
  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
      {cuts.map((cut) =>
        cut.kind === "agent" ? (
          <TranscriptItem key={cut.item.id} item={cut.item} tasks={tasks} {...open} />
        ) : (
          <SettledRun key={cut.items[0]!.id} rows={cut.items} tasks={tasks} {...open} />
        ),
      )}
    </div>
  );
}

/**
 * How many of these rows actually failed — not whether any did.
 *
 * A COLLAPSED RUN USED TO GO ENTIRELY RED on one failure: the chevron, the step
 * count and the tally all turned destructive, so "10 steps" where two commands
 * failed read exactly like ten that did. The summary was answering "did
 * anything go wrong" in the place a reader looks to find out how much (#206).
 *
 * A FAILED SUB-AGENT COUNTS, because its row is the only trace of it here; the
 * work it failed at is inside the agent, not in this run.
 */
export function failedCount(rows: readonly JournalItem[], tasks: readonly JournalTask[]): number {
  return rows.filter(
    (item) =>
      failed(item) ||
      (item.detail.type === "task" && tasks.find((task) => task.id === (item.detail as { taskId: string }).taskId)?.state === "failed"),
  ).length;
}

/**
 * The failed tally beside a neutral step count.
 *
 * SEPARATELY STYLED, AND ONLY THAT. The count of what went wrong is the
 * destructive part; the count of what happened is not. Hidden while the run is
 * open because every failed row is then on screen saying so itself — this is
 * the fold's summary of what it is covering up, not a second error report.
 */
function FailedCount({ count, hidden }: { count: number; hidden: boolean }) {
  if (hidden || count === 0) return null;
  return (
    <>
      <span className="shrink-0 text-muted-foreground/50">·</span>
      <span className="flex shrink-0 items-center gap-1 text-destructive">
        <TriangleAlertIcon className="size-3 shrink-0" />
        {count} failed
      </span>
    </>
  );
}

/**
 * THE HARNESS CONSULTING ITSELF, as one line (#354).
 *
 * Shaped like every other collapsed row — chevron, muted, expandable — because
 * it is not a different KIND of thing, it is the same rows at a scale that
 * matches how much they matter. The count rides the line so the fold never
 * hides how much it is covering, and pressing it gives back the ordinary rows,
 * paths and all.
 */
function HarnessConsultRow({ label, items, tasks, ...gestures }: { label: string; items: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md">
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className={cn(ROW, "text-muted-foreground hover:bg-muted/60")}>
        <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {items.length > 1 && <span className="shrink-0 text-muted-foreground/60">{items.length} steps</span>}
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-border/70 py-1 pl-3">
          {items.map((item) => (
            <TranscriptItem key={item.id} item={item} tasks={tasks} {...gestures} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A list of rows, with the harness's own errands folded out of the way.
 *
 * THE ONE PLACE ROWS BECOME ELEMENTS in a run, live or settled, so the two
 * cannot disagree about what a turn contained — a fold that applied only to
 * history would make a live turn look busier than the same turn a second later.
 */
function TranscriptRows({ rows, tasks, ...gestures }: { rows: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const workspace = useContext(WorkspaceContext);
  const segments = useMemo(() => foldHarnessRows(rows, workspace), [rows, workspace]);
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "consult" ? (
          <HarnessConsultRow key={segment.items[0]!.id} label={segment.label} items={segment.items} tasks={tasks} {...gestures} />
        ) : (
          segment.items.map((item) => <TranscriptItem key={item.id} item={item} tasks={tasks} {...gestures} />)
        ),
      )}
    </>
  );
}

function LiveRun({ rows, tasks, onOpenAgent, onInsert, onOpenFile, onOpenFileInNewTab }: { rows: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const [open, setOpen] = useState(false);
  // Only the rows the fold is HIDING can carry a surprise; the one on screen
  // reports itself. Same rule as the settled run, applied to its own window.
  const failures = failedCount(rows.slice(0, -1), tasks);
  const hidden = Math.max(0, rows.length - 1);
  const shown = open ? rows : rows.slice(-1);
  const pass = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
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
          <span className="shrink-0">
            {open ? "Show fewer steps" : `+${hidden} earlier step${hidden === 1 ? "" : "s"}`}
          </span>
          <FailedCount count={failures} hidden={open} />
        </button>
      )}
      <TranscriptRows rows={shown} tasks={tasks} {...pass} />
    </div>
  );
}

function SettledRun({ rows, tasks, onOpenAgent, onInsert, onOpenFile, onOpenFileInNewTab }: { rows: JournalItem[]; tasks: JournalTask[]; onOpenAgent?: (taskId: string) => void } & RowGestures) {
  const [open, setOpen] = useState(false);
  const workspace = useContext(WorkspaceContext);
  const failures = failedCount(rows, tasks);
  const pass = { ...(onOpenAgent ? { onOpenAgent } : {}), ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  return (
    <>
      {/* THE SUMMARY WRAPS RATHER THAN TRUNCATING (#354). At panel width a
          busy turn ended "· Ran command ×4 · …" with the ellipsis eating the
          part a reader actually scans for — what the agent DID — while the
          generic head of the list survived. Two lines is the whole budget: a
          fold that grows without limit stops being a fold. `items-start` keeps
          the chevron and the step count on the first line rather than centring
          them against a two-line block. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((c) => !c)}
        className={cn(ROW, "items-start text-muted-foreground hover:bg-muted/50")}
      >
        <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">
          {rows.length} step{rows.length === 1 ? "" : "s"}
        </span>
        <FailedCount count={failures} hidden={open} />
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="line-clamp-2 min-w-0 text-muted-foreground/80">{tallyParts(rows, workspace).join(" · ")}</span>
      </button>
      {open && (
        <div className="ml-2 flex flex-col gap-0.5 border-l border-border/70 pl-2">
          <TranscriptRows rows={rows} tasks={tasks} {...pass} />
        </div>
      )}
    </>
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
          "flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-center font-mono text-[0.5625rem]",
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

/**
 * HOW A TURN'S FAILURE READS — and the one failure that is not a fault.
 *
 * Every failure used to be the same attention marker holding the provider's
 * sentence, which is right for a crash and wrong for a usage limit. A limit is
 * a WAIT WITH A KNOWN END: the useful fact is the time it lifts, the session is
 * not broken, and there is something to do about it. So `rate_limited` gets the
 * reset time, an hourglass rather than a warning triangle, and the muted colour
 * a `provider_wait` row already uses — colouring it destructive would make a
 * session that is merely waiting read as one that is damaged.
 *
 * RESUME NOW IS OFFERED EVEN WHEN THE ENGINE WILL DO IT ANYWAY. The person may
 * know something the reset time does not — another login came free, the proxy
 * moved account — and the engine deliberately does not check the clock.
 */
export function TurnFailureRow({
  failure,
  code,
  resumeAt,
  limitType,
  onResume,
  resuming,
}: {
  failure: string;
  code?: TurnFailureCode;
  resumeAt?: number;
  limitType?: RateLimitType;
  onResume?: () => void;
  resuming?: boolean;
}) {
  // A limit with no reset time cannot promise one, so it falls back to the
  // ordinary marker rather than rendering "resets at Invalid Date".
  if (code !== "rate_limited" || resumeAt === undefined) return <Marker attention>{failure}</Marker>;
  const resets = new Date(resumeAt);
  const sameDay = resets.toDateString() === new Date().toDateString();
  const at = sameDay
    ? resets.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : resets.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  // `other` names nothing a person can act on, so it earns no parenthetical —
  // the same rule `titleForProviderWait` follows in the engine.
  const limit = limitType && limitType !== "other" ? `${limitType.replaceAll("_", " ")} ` : "";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-xs text-muted-foreground">
      <HourglassIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Waiting for the {limit}limit to reset at {at}
      </span>
      {onResume && (
        <button
          type="button"
          disabled={resuming}
          onClick={onResume}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          {resuming ? "Resuming…" : "Resume now"}
        </button>
      )}
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
export function WorkingIndicator({
  label,
  startedAt,
  lastActivityAt,
  delegated,
  now,
}: {
  label: string;
  startedAt?: number;
  /** When anything last happened on this turn. Absent means nothing has yet. */
  lastActivityAt?: number;
  /** Sub-agents are carrying this turn. A quiet main loop is then the CORRECT
   *  state rather than a stalled one. */
  delegated?: boolean;
  now: number;
}) {
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  /**
   * SILENCE IS A GAP SINCE THE LAST THING THAT HAPPENED, not the age of the
   * turn. This compared `elapsed` against the threshold, so every turn over
   * twenty seconds announced "no output 43s" beside forty-three seconds of
   * visible output — the readout that is supposed to distinguish slow from stuck
   * fired on both, which makes it noise the moment a turn is interesting.
   */
  const quiet = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : elapsed;
  // A fan-out mid-flight is the loudest thing in the session; the main loop is
  // silent because it is waiting on purpose, which is not a warning.
  const silent = !delegated && quiet >= SILENCE_THRESHOLD;

  return (
    <div className={cn("flex items-center gap-2 text-[0.6875rem] text-muted-foreground/70", silent && "text-warning/80")}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full motion-safe:animate-pulse", silent ? "bg-warning" : "bg-muted-foreground/50")}
      />
      <Shimmer as="span" className={cn("text-[0.6875rem]", silent && "text-warning/80")}>
        {label}
      </Shimmer>
      <span className="shrink-0 font-mono tabular-nums">{formatElapsed(elapsed)}</span>
      {/* A run that has said nothing for 20s is the case a detached session most
          needs surfaced — it is the difference between slow and stuck. */}
      {silent && <span className="shrink-0 font-mono tabular-nums text-warning">· no output {formatElapsed(quiet)}</span>}
    </div>
  );
}

/**
 * WHAT THE TURN IS DOING, in the reader's terms rather than the loop's.
 *
 * "Thinking" was a lie with four sub-agents mid-sweep: the main loop IS idle,
 * and saying so describes the machinery instead of the work. What is happening
 * is that four agents are out searching, which the reader can see in the chips
 * directly above and could not see in the one line that claimed to summarise it.
 */
export function turnActivity(turn: Pick<JournalTurn, "items" | "tasks">): { label: string; delegated: boolean } {
  // A compaction outranks everything: while it runs the provider is not
  // working on the task, it is squeezing its memory, and "Thinking" over a
  // long silence is exactly the read this line exists to prevent.
  if (turn.items.some((item) => item.detail?.type === "context_compaction" && item.status === "inProgress")) {
    return { label: "Compacting context", delegated: false };
  }
  const live = turn.tasks.filter((task) => task.state === "running" || task.state === "pending" || task.state === "waiting");
  const agents = live.filter((task) => task.kind !== "background").length;
  if (agents > 0) return { label: `${agents} sub-agent${agents === 1 ? "" : "s"} working`, delegated: true };
  // Background work does not speak for the turn: a watch loop running does not
  // mean the main loop is doing anything, and it outlives the turn anyway.
  if (turn.items.some((item) => item.status === "inProgress")) return { label: "Working", delegated: false };
  return { label: "Thinking", delegated: false };
}
