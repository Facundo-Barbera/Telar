"use client";

/**
 * WHAT THE AGENT'S CONVERSATION DRAWS (#531).
 *
 * THE COCKPIT'S MESSAGE COMPONENTS, NOT ITS TRANSCRIPT. `Message`,
 * `MessageContent` and `MessageResponse` are the cockpit's own, reused whole —
 * so prose, markdown, code blocks and maths look identical here and improve in
 * both places at once, and the 50rem measure keeps this conversation in the
 * same lane as the composer under it.
 *
 * WHAT IS NOT REUSED IS `TranscriptItem`, and it is worth saying why rather
 * than leaving it to look like an oversight. That component draws a `JournalItem`
 * — a session's turn, its tasks, its workspace, its harness folds, its read
 * receipt. The Agent has none of those: it has a flat row log with four kinds in
 * it. Threading "but not this one" through every branch of the session
 * transcript would make each future change to it a change to both, for a screen
 * whose whole content is a message, a tool row, and a failure.
 *
 * A TOOL ROW IS ONE LINE UNTIL IT IS ASKED TO BE MORE. The Agent's tools are
 * the sessions and notes walls — reads that answer in paragraphs — and a
 * conversation that printed every answer in full would be unreadable. So the
 * line says what ran and how it went, and the disclosure holds what it said.
 */

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CircleSlashIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { displayToolName } from "@telar/engine-client";
import type { AgentItem } from "@/lib/agent/thread";
import { CodeSurface } from "@/components/ui/code-surface";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
import { cn } from "@/lib/utils";

/**
 * WHAT A WAKE READS AS, when the Agent's turn was not started by a person.
 *
 * A TURN WITH NO HUMAN BEHIND IT MUST SAY SO. The Agent subscribes to the work
 * it delegates, and a completion on one of those enqueues a turn whose input is
 * the notice rather than anything anybody typed. Drawing that as an ordinary
 * user message would attribute somebody else's machine to the reader — which is
 * the one thing a conversation must never get wrong.
 */
export function wakeLabel(item: Extract<AgentItem, { kind: "user" }>): string | undefined {
  if (!item.origin || item.origin === "user") return undefined;
  return item.wakeReason ? `Woken — ${item.wakeReason}` : "Woken by Telar";
}

export function AgentTranscript({ items }: { items: readonly AgentItem[] }) {
  return (
    <div className="flex flex-col gap-4 py-4">
      {items.map((item) => (
        <AgentItemRow key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

function AgentItemRow({ item }: { item: AgentItem }) {
  if (item.kind === "user") {
    const wake = wakeLabel(item);
    return (
      <Message from="user">
        {wake && <p className="font-mono text-3xs tracking-wide text-muted-foreground uppercase">{wake}</p>}
        <MessageContent from="user">{item.text}</MessageContent>
      </Message>
    );
  }

  if (item.kind === "assistant") {
    return (
      <Message from="assistant">
        <MessageContent from="assistant">
          <MessageResponse streaming={item.streaming === true}>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === "tool") return <ToolRow item={item} />;

  return (
    <Message from="assistant">
      <MessageContent from="assistant">
        <p className={cn("flex items-center gap-1.5 text-sm", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {item.status === "failed" ? <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" /> : <CircleSlashIcon aria-hidden className="size-3.5 shrink-0" />}
          {/* A PERSON WHO PRESSED CANCEL KNOWS WHY THE TURN ENDED. A turn that
              fell over owes them the sentence; a stopped one owes them nothing
              but the fact. */}
          {item.status === "stopped" ? "Stopped." : (item.message ?? "The turn failed.")}
        </p>
      </MessageContent>
    </Message>
  );
}

function ToolRow({ item }: { item: Extract<AgentItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  let input: string | undefined;
  try {
    input = item.input && Object.keys(item.input as Record<string, unknown>).length > 0 ? JSON.stringify(item.input, null, 2) : undefined;
  } catch {
    input = undefined;
  }
  return (
    <Message from="assistant">
      <MessageContent from="assistant">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <WrenchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs text-foreground">{displayToolName(item.name)}</span>
          {/* COMPLETED SAYS NOTHING, which is the common case and needs no
              badge. The two that are not routine say which they are. */}
          {item.status === "failed" && <span className="shrink-0 text-3xs text-destructive">failed</span>}
          {item.status === "declined" && <span className="shrink-0 text-3xs text-muted-foreground">denied</span>}
        </button>
        {open && (
          <div className="flex flex-col gap-2 pl-4">
            {input && <CodeSurface text={input} wrap tone="muted" />}
            {item.output && <CodeSurface text={item.output} wrap tone="muted" />}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}
