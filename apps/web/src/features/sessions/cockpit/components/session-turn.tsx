"use client";

import { Fragment, memo, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, Minimize2Icon, ShieldCheckIcon } from "lucide-react";
import type { EngineRequest, RequestDecision, Turn } from "@telar/engine-client";
import { isActiveTurn, isCompacting, itemText, type JournalItem, type JournalTask, type JournalTurn } from "@/platform/engine";
import {
  ActivityGroup,
  LiveActivity,
  Marker,
  NotificationRow,
  sessionWakeLabel,
  splitAtMessageBoundaries,
  TranscriptItem,
  turnActivity,
  TurnFailureRow,
  WorkingIndicator,
  withoutOpeningNotification,
  AgentMessageBubble,
  ConversationMessage,
} from "@/features/transcript";
import type { PanelTab } from "@/features/panel";
import { cn } from "@/ui/utils";
import { ApprovalCard } from "../../components/approval-card";
import { Message, MessageContent, MessageMenu, MessageResponse } from "@/ui/message";
import { CodeSurface } from "@/ui/code-surface";
import { describeTurnState, wakeUpLabel } from "../model";

function WakeUpRow({ turn, roster, onOpen }: { turn: JournalTurn; roster: readonly JournalTask[]; onOpen?: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const namedTask = turn.askedBy ?? turn.wokenBy;
  const task = namedTask ? roster.find((candidate) => candidate.id === namedTask) : undefined;
  const { verb, Icon } = turn.decidedForBackgroundWork
    ? { verb: task ? "Decided a tool call for" : "Decided a tool call for background work", Icon: ShieldCheckIcon }
    : turn.wakeReason
      ? sessionWakeLabel(turn.wakeReason)
      : wakeUpLabel(task);
  const label = turn.wakeReason
    ? `session …${turn.wakeReason.sessionId.slice(-6)}`
    : (task?.title ?? (task ? undefined : namedTask ? `task ${namedTask.slice(-6)}` : undefined));
  const body = turn.prompt.trim();
  return (
    <div className="rounded-md">
      <div className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          disabled={!body}
          aria-expanded={body ? open : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0">{verb}</span>
          {label && <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{label}</span>}
          {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
        {onOpen && task && (
          <button
            type="button"
            onClick={() => onOpen(task.id)}
            title={task.kind === "background" ? "Open in the Processes panel" : "Open in the Agents panel"}
            className="shrink-0 rounded px-1 text-3xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Open ▸
          </button>
        )}
      </div>
      {open && body && (
        <div className="ml-3 border-l border-border/70 py-1 pr-1.5 pl-3">
          <CodeSurface text={body} wrap />
        </div>
      )}
    </div>
  );
}

type SessionTurnProps = {
  requests: EngineRequest[];
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
  onOpenAgent?: (taskId: string) => void;
  onOpenTab?: (tab: PanelTab) => void;
  onInsert?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenFileInNewTab?: (path: string) => void;
  turn: JournalTurn;
  /** The session's whole task roster: the task that woke a turn belongs to the turn that started it. */
  roster?: readonly JournalTask[];
  sending: boolean;
  live: boolean;
  onRetry: (turn: Pick<Turn, "runId" | "state" | "input">) => void;
  onResumeNow?: () => void;
};

// Presence of a gesture changes the render; identity does not (the cockpit passes inline arrows).
const TURN_GESTURES = ["onOpenAgent", "onOpenTab", "onInsert", "onOpenFile", "onOpenFileInNewTab", "onResumeNow"] as const;

// Compares what a turn draws, not object identity: every tail snapshot rebuilds turns as fresh objects.
// `prompt` is not compared; the engine writes it once and the runId key pins the turn.
function sameTurnRender(prev: SessionTurnProps, next: SessionTurnProps): boolean {
  if (prev.live !== next.live || prev.sending !== next.sending) return false;
  for (const gesture of TURN_GESTURES) if (Boolean(prev[gesture]) !== Boolean(next[gesture])) return false;
  if (!sameEach(prev.requests, next.requests, (a, b) => a.id === b.id && a.state === b.state && a.decision === b.decision)) return false;
  // Only the wake-up row reads the roster, and only on a turn that names the task that woke it.
  const rosterRead = (next.turn.wokenBy ?? next.turn.askedBy) !== undefined;
  if (rosterRead && !sameEach(prev.roster ?? [], next.roster ?? [], (a, b) => a.id === b.id && a.title === b.title && a.kind === b.kind)) return false;
  return sameTurnContent(prev.turn, next.turn);
}

function sameEach<T>(prev: readonly T[], next: readonly T[], same: (before: T, after: T) => boolean): boolean {
  if (prev === next) return true;
  return prev.length === next.length && prev.every((before, index) => before === next[index] || same(before, next[index]!));
}

/** Every field of a turn the body branches on or prints. */
function sameTurnContent(prev: JournalTurn, next: JournalTurn): boolean {
  if (prev === next) return true;
  return (
    prev.runId === next.runId &&
    prev.state === next.state &&
    prev.held === next.held &&
    prev.heldReason === next.heldReason &&
    prev.kind === next.kind &&
    prev.origin === next.origin &&
    prev.wokenBy === next.wokenBy &&
    prev.askedBy === next.askedBy &&
    prev.decidedForBackgroundWork === next.decidedForBackgroundWork &&
    prev.wakeReason?.kind === next.wakeReason?.kind &&
    prev.wakeReason?.sessionId === next.wakeReason?.sessionId &&
    prev.sender?.sessionId === next.sender?.sessionId &&
    prev.agentDelivery === next.agentDelivery &&
    prev.agentIntent === next.agentIntent &&
    prev.agentNotice === next.agentNotice &&
    prev.notification?.summary === next.notification?.summary &&
    prev.notification?.deliveries === next.notification?.deliveries &&
    prev.assignmentScope === next.assignmentScope &&
    prev.attachments?.length === next.attachments?.length &&
    prev.startedAt === next.startedAt &&
    prev.lastActivityAt === next.lastActivityAt &&
    prev.resultText === next.resultText &&
    prev.failure === next.failure &&
    prev.failureCode === next.failureCode &&
    prev.resumeAt === next.resumeAt &&
    prev.limitType === next.limitType &&
    prev.resumedAfterRateLimit === next.resumedAfterRateLimit &&
    prev.usage?.tokens.input === next.usage?.tokens.input &&
    prev.usage?.tokens.output === next.usage?.tokens.output &&
    sameItems(prev.items, next.items) &&
    sameTurnTasks(prev.tasks, next.tasks)
  );
}

function sameItems(prev: readonly JournalItem[], next: readonly JournalItem[]): boolean {
  return sameEach(prev, next, (before, after) =>
    before.id === after.id &&
    before.status === after.status &&
    before.taskId === after.taskId &&
    (before.detail === after.detail || (after.status !== "inProgress" && before.detail.type === after.detail.type)) &&
    itemText(before) === itemText(after));
}

function sameTurnTasks(prev: readonly JournalTask[], next: readonly JournalTask[]): boolean {
  return sameEach(prev, next, (before, after) =>
    before.id === after.id &&
    before.state === after.state &&
    before.kind === after.kind &&
    before.title === after.title &&
    before.backgrounded === after.backgrounded &&
    before.resultText === after.resultText &&
    before.failure === after.failure &&
    sameItems(before.items, after.items));
}

export const SessionTurn = memo(SessionTurnBody, sameTurnRender);

function SessionTurnBody({
  turn,
  requests,
  sending,
  live,
  onDecide,
  onOpenAgent,
  onOpenTab,
  onResumeNow,
  onInsert,
  onOpenFile,
  onOpenFileInNewTab,
  roster = [],
}: SessionTurnProps) {
  const doing = turnActivity(turn);
  const rowGestures = {
    ...(onOpenAgent ? { onOpenAgent } : {}),
    ...(onInsert ? { onInsert } : {}),
    ...(onOpenFile ? { onOpenFile } : {}),
    ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}),
  };
  const responses = splitAtMessageBoundaries(withoutOpeningNotification(turn));
  const answering = responses.at(-1)!;
  const earlier = responses.slice(0, -1);
  // Only the last response's final assistant message is the answer to the turn.
  const lastProse = answering.items.map((item) => item.detail.type).lastIndexOf("assistant_message");
  const activity = lastProse === -1 ? answering.items : answering.items.slice(0, lastProse);
  const closing = lastProse === -1 ? [] : answering.items.slice(lastProse);
  const streamedAnswer = closing.some((item) => itemText(item));
  const answerLane =
    live ||
    requests.length > 0 ||
    answering.items.length > 0 ||
    Boolean(turn.resultText) ||
    Boolean(turn.failure) ||
    Boolean(turn.usage) ||
    turn.resumedAfterRateLimit !== undefined ||
    turn.restartOrigin !== undefined ||
    turn.state === "stopped" ||
    turn.state === "discarded" ||
    turn.state === "failed";

  if (turn.kind === "compact") return <CompactTurn turn={turn} rowGestures={rowGestures} />;
  const boundary = (item: JournalItem) => (
    <div className={cn("mx-auto w-full min-w-0 max-w-[50rem]", item.detail.type === "user_message" && !item.detail.sender && !item.detail.wakeReason && "my-6")}>
      <TranscriptItem item={item} tasks={turn.tasks} {...rowGestures} {...(onOpenTab ? { onOpenTab } : {})} />
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <TurnOpening turn={turn} roster={roster} {...rowGestures} {...(onOpenTab ? { onOpenTab } : {})} />

      {earlier.map((response) => (
        <Fragment key={response.boundary?.id ?? "opening"}>
          {response.boundary && boundary(response.boundary)}
          {response.items.length > 0 && (
            <Message from="assistant">
              <MessageContent from="assistant">
                <LiveActivity items={response.items} tasks={turn.tasks} liveTail={false} {...rowGestures} />
              </MessageContent>
            </Message>
          )}
        </Fragment>
      ))}
      {answering.boundary && boundary(answering.boundary)}

      {answerLane && (
      <Message from="assistant">
        <MessageContent from="assistant">
          {requests.map((request) => (
            <ApprovalCard key={request.id} request={request} sending={sending} onDecide={onDecide} />
          ))}
          {live ? (
            // Only the answering response's items, so live and settled cut the turn in the same place.
            <LiveActivity items={answering.items} tasks={turn.tasks} {...rowGestures} />
          ) : (
            <>
              <ActivityGroup items={activity} tasks={turn.tasks} live={false} {...rowGestures} />
              {closing.map((item) => (
                <TranscriptItem key={item.id} item={item} tasks={turn.tasks} {...rowGestures} />
              ))}
            </>
          )}
          {!streamedAnswer && turn.resultText && <MessageResponse>{turn.resultText}</MessageResponse>}
          {turn.failure && (
            <TurnFailureRow
              failure={turn.failure}
              {...(turn.failureCode ? { code: turn.failureCode } : {})}
              {...(turn.resumeAt === undefined ? {} : { resumeAt: turn.resumeAt })}
              {...(turn.limitType ? { limitType: turn.limitType } : {})}
              {...(onResumeNow ? { onResume: onResumeNow, resuming: sending } : {})}
            />
          )}
          {turn.resumedAfterRateLimit !== undefined && <Marker>resumed after the usage limit reset</Marker>}
          {turn.restartOrigin !== undefined && <Marker>continued after Telar restarted to update</Marker>}
          {turn.state === "stopped" && <Marker>stopped — kept what arrived</Marker>}
          {turn.state === "discarded" && <Marker>{describeTurnState(turn.state).label.toLowerCase()}</Marker>}
          {live && (
            <WorkingIndicator
              label={doing.label}
              delegated={doing.delegated}
              compacting={isCompacting(turn)}
              startedAt={turn.startedAt}
              {...(turn.lastActivityAt ? { lastActivityAt: turn.lastActivityAt } : {})}
            />
          )}
          {turn.usage && !live && (
            <p className="font-mono text-3xs text-muted-foreground/70 tabular-nums">
              {(turn.usage.tokens.input + turn.usage.tokens.output).toLocaleString()} tokens
            </p>
          )}
          {turn.state === "failed" && <p className="mt-2 text-sm text-muted-foreground">This turn ended early. Your history is saved; send a new message to continue.</p>}
        </MessageContent>
      </Message>
      )}
    </div>
  );
}

type RowGestures = Pick<SessionTurnProps, "onOpenAgent" | "onInsert" | "onOpenFile" | "onOpenFileInNewTab">;

// A compaction is one quiet system line, not a "/compact" bubble with an empty reply.
function CompactTurn({ turn, rowGestures }: { turn: JournalTurn; rowGestures: RowGestures }) {
  return (
    <div className="flex flex-col gap-2">
      {turn.items.filter((item) => item.detail.type === "context_compaction").map((item) => (
        <TranscriptItem key={item.id} item={item} {...rowGestures} />
      ))}
      {turn.items.every((item) => item.detail.type !== "context_compaction") && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Minimize2Icon className="size-3.5 shrink-0" />
          <span>
            {isActiveTurn(turn.state)
                ? "Compacting context…"
                : turn.state === "failed"
                  ? "Compaction failed"
                  : "Context compaction requested"}
          </span>
        </p>
      )}
      {turn.state === "failed" && turn.failure && <p className="text-xs text-destructive">{turn.failure}</p>}
    </div>
  );
}

function TurnOpening({
  turn,
  roster,
  onInsert,
  onOpenTab,
  onOpenAgent,
}: RowGestures & { turn: JournalTurn; roster: readonly JournalTask[]; onOpenTab?: (tab: PanelTab) => void }) {
  return (
    <>
      {turn.kind !== "import" && turn.origin !== "provider" && turn.origin !== "session" && turn.origin !== "restart" && (
        // `markdown={false}`: the typed draft is not Markdown, so "Copy as Markdown" would mislabel it.
        <div className="mb-6">
          <MessageMenu text={turn.prompt} markdown={false} {...(onInsert ? { onQuote: onInsert } : {})}>
            <ConversationMessage text={turn.prompt} {...(turn.attachments ? { attachments: turn.attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />
          </MessageMenu>
        </div>
      )}

      {/* The initiating machine message precedes every response and steer. */}
      {(turn.origin === "provider" || turn.origin === "session") && (
        <Message from="assistant"><MessageContent from="assistant">
          {turn.notification ? (
            <NotificationRow detail={turn.notification} {...(turn.sender ? { message: turn.prompt } : {})} />
          ) : turn.origin === "session" && turn.sender ? (
            <AgentMessageBubble text={turn.prompt} sender={turn.sender} {...(turn.agentNotice ? { notice: turn.agentNotice } : {})} {...(turn.agentIntent ? { intent: turn.agentIntent } : {})} {...(turn.assignmentScope ? { scope: turn.assignmentScope } : {})} {...(turn.attachments ? { attachments: turn.attachments } : {})} {...(onOpenTab ? { onOpenTab } : {})} />
          ) : (
            <WakeUpRow turn={turn} roster={roster} {...(onOpenAgent ? { onOpen: onOpenAgent } : {})} />
          )}
        </MessageContent></Message>
      )}
    </>
  );
}

// Lets the browser skip rendering an off-screen settled turn, at the height it last rendered.
export function TurnFrame({ skippable, children }: { skippable: boolean; children: React.ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    if (!skippable) {
      element.style.removeProperty("content-visibility");
      element.style.removeProperty("contain-intrinsic-size");
      return;
    }
    // Measured once: a later reading would measure the skipped placeholder.
    if (element.style.getPropertyValue("content-visibility")) return;
    const measured = element.offsetHeight;
    if (!measured) return;
    element.style.setProperty("content-visibility", "auto");
    element.style.setProperty("contain-intrinsic-size", `auto ${measured}px`);
  }, [skippable]);
  return <div ref={frame}>{children}</div>;
}

export function EmptyTranscript({ loading }: { loading: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
      <p className="text-sm font-medium">{loading ? "Hydrating transcript…" : "Ready for its first turn"}</p>
      <p className="text-sm text-muted-foreground">
        {loading ? "Reading the durable journal from the engine." : "Ask for changes, or explore the project."}
      </p>
    </div>
  );
}
