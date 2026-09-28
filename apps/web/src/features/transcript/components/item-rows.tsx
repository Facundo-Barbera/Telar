"use client";

import { useState } from "react";
import {
BotIcon,
CheckIcon,
ChevronRightIcon,
CircleIcon,
DownloadIcon,ListTodoIcon,
Loader2Icon,
HourglassIcon,
Minimize2Icon
} from "lucide-react";
import { itemLabel,itemText,type JournalItem,type JournalTask,type JournalTurn } from "@/platform/engine";
import { fmtTokens } from "@/lib/format";
import { attachmentUrl } from "@/lib/ds";
import { MessageMenu,MessageResponse } from "@/components/ui/message";
import { ContextMenu,ContextMenuContent,ContextMenuItem,ContextMenuTrigger } from "@/components/ui/context-menu";
import { Shimmer } from "@/components/ui/shimmer";
import { ROW } from "./transcript-fold";
import { AgentMessageBubble,ConversationMessage,type OpenTab } from "@/components/session/conversation-message";
import { cn } from "@/lib/utils";
import { notificationLabel,reasoningPaints,reasoningTokens,running } from "../model";
import { RowGestures } from "./tool-row";

/** Extended thinking. Italic, hairline-indented, quiet — never a card. */
export function ReasoningRow({ item }: { item: JournalItem }) {
  const [open, setOpen] = useState(false);
  const text = itemText(item);
  if (!reasoningPaints(item)) return null;
  const tokens = reasoningTokens(item);

  if (running(item)) {
    return (
      <div className="py-1 text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-2xs font-medium">
            {tokens === undefined ? (text.trim() ? "Thinking" : "Thinking…") : `Thinking · ~${fmtTokens(tokens)} tokens`}
          </Shimmer>
        </div>
        {text.trim() && (
          <p className="ml-5 border-l border-border/70 pl-3 text-xs leading-relaxed whitespace-pre-wrap italic">
            {text}
            <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-muted-foreground/70 align-middle" />
          </p>
        )}
      </div>
    );
  }

  // Settled with only a count: there is nothing behind a disclosure, so none.
  if (!text.trim()) {
    return (
      <div className={cn(ROW, "text-muted-foreground")}>
        <span aria-hidden className="shrink-0">
          ✻
        </span>
        <span className="min-w-0 flex-1 truncate italic">Thought · {fmtTokens(tokens ?? 0)} tokens</span>
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
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/30 p-2 text-2xs whitespace-pre-wrap italic text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}

/** A to-do list is never collapsed: the point of one is to be glanceable. */
export function PlanRow({ item }: { item: JournalItem }) {
  if (item.detail.type !== "plan") return null;
  const steps = item.detail.plan.steps;
  const done = steps.filter((step) => step.status === "completed").length;

  return (
    <div className="rounded-md px-1.5 py-1">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5" />
        To-dos
        <span className="font-mono text-3xs text-muted-foreground/70">
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

export function AgentRow({ item, task, onOpen, onInsert }: { item: JournalItem; task: JournalTask | undefined; onOpen?: (taskId: string) => void } & Pick<RowGestures, "onInsert">) {
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
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{label}</span>
            </>
          )}
          {body && (
            <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          )}
        </button>
        <span className={cn("shrink-0 font-mono text-3xs tabular-nums", isError ? "text-destructive" : "text-muted-foreground")}>
          {status}
          {tokens ? ` · ${fmtTokens(tokens)}` : ""}
        </span>
        {onOpen && taskId && (
          <button
            type="button"
            onClick={() => onOpen(taskId)}
            title="Open in the Agents panel"
            className="shrink-0 rounded px-1 text-3xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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

export function CompactionRow({ item }: { item: JournalItem }) {
  // WHILE IT RUNS, THE WORKING LINE SAYS IT — "Compacting context" with its
  // clock (`turnActivity`). A second, clockless row above it was the same fact
  // twice. The row appears once there is something the line cannot say: that
  // it finished, and what it reclaimed.
  if (running(item)) return null;
  const detail = item.detail.type === "context_compaction" ? item.detail : undefined;
  const label = item.status === "failed" ? "Compaction failed" : "Compacted context";
  const reclaimed =
    detail?.preTokens !== undefined && detail?.postTokens !== undefined
      ? `${fmtTokens(detail.preTokens)} → ${fmtTokens(detail.postTokens)}`
      : undefined;
  return (
    <p className={cn(ROW, item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
      <Minimize2Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail?.reason === "auto" && <span className="shrink-0 text-3xs opacity-70">automatic</span>}
      {reclaimed && <span className="shrink-0 font-mono text-3xs tabular-nums">{reclaimed}</span>}
    </p>
  );
}

export function ConversationImportRow({ item }: { item: JournalItem }) {
  const detail = item.detail.type === "conversation_import" ? item.detail.import : undefined;
  if (!detail) return null;
  const kept =
    detail.cut === "since_compact_boundary"
      ? `${detail.records} records since its last compaction`
      : `${detail.records} records`;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-dashed border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <DownloadIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Imported from Claude Code — {kept}. Your own Claude Code history is untouched.
        </span>
      </p>
      {detail.firstPrompt && <p className="min-w-0 truncate pl-5 italic opacity-80">“{detail.firstPrompt}”</p>}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 font-mono text-3xs opacity-70">
        {detail.sourceCwd && <span className="min-w-0 truncate">{detail.sourceCwd}</span>}
        <span>{detail.sourceSessionId}</span>
        {detail.rows !== detail.records && <span>{detail.rows} rows shown</span>}
      </p>
    </div>
  );
}

export function ProviderWaitRow({ item }: { item: JournalItem }) {
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
      {resets && <span className="shrink-0 text-3xs opacity-70">resets {resets}</span>}
    </p>
  );
}

export function sessionWakeLabel(reason: NonNullable<JournalTurn["wakeReason"]>): { verb: string; Icon: typeof BotIcon } {
  return notificationLabel({ kind: reason.kind === "request_opened" ? "request" : "wake", wakeKind: reason.kind });
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
    <div className="min-w-0" aria-label="Wake from another session">
      <button
        type="button"
        className={ROW}
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{verb}</span>
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{`session …${reason.sessionId.slice(-6)}`}</span>
        {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {open && body && <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-1.5 pb-1 text-xs text-muted-foreground">{body}</p>}
    </div>
  );
}

export function SteeredMessageRow({ item, onOpenTab, onInsert }: { item: JournalItem; onOpenTab?: OpenTab } & Pick<RowGestures, "onInsert">) {
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
export function PlotRow({ item, attachmentId }: { item: JournalItem; attachmentId: string }) {
  return (
    <figure className="my-1 max-w-md overflow-hidden rounded-md border border-border bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={attachmentUrl(item.sessionId, attachmentId)} alt={itemLabel(item)} className="block max-h-72 w-full object-contain" loading="lazy" />
      <figcaption className="border-t border-border bg-background px-2 py-0.5 text-3xs text-muted-foreground">{itemLabel(item)}</figcaption>
    </figure>
  );
}
