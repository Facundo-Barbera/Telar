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
 *
 * …AND A RUN OF THEM IS ONE LINE TOO (#569). One line each was still twelve
 * lines for a turn with twelve calls, which on a screenshot of a working Agent
 * was the whole screen. The activity lane's own two rules apply here unchanged —
 * a live run shows its newest step behind "+N earlier steps", a settled one
 * folds behind "16 steps · sessions_read ×12" — and they are READ FROM the same
 * `StepFold` the session transcript reads them from, not restated. What does NOT
 * fold is anything that is not work: prose, the person's own message, a wake, a
 * turn that failed. Those are seams, exactly as they are over there.
 */

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CircleSlashIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { displayToolName } from "@telar/engine-client";
import type { AgentItem } from "@/lib/agent/thread";
import { CodeSurface } from "@/components/ui/code-surface";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
import { StepFold } from "@/components/transcript-fold";
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

export type AgentToolItem = Extract<AgentItem, { kind: "tool" }>;

/** A tool call, and nothing else. `assistant`, `user` and `failure` rows are
 *  seams: each is a thing the reader is meant to see as it lands, and a fold
 *  that swallowed one would hide the sentence the work was an answer to. */
export const isAgentToolItem = (item: AgentItem): item is AgentToolItem => item.kind === "tool";

/**
 * THE CONVERSATION, CUT AT ITS SEAMS — the session transcript's
 * `segmentActivity`, over the Agent's own four kinds.
 *
 * Everything between two seams is a RUN of work, and a run is what folds. The
 * cut is what keeps prose readable while an agent is mid-sweep: a turn that
 * says one sentence and then runs twenty tools is a sentence followed by one
 * folded run, not twenty-one rows.
 */
export type AgentSegment = { kind: "row"; item: Exclude<AgentItem, AgentToolItem> } | { kind: "run"; items: AgentToolItem[] };

export function segmentAgentItems(items: readonly AgentItem[]): AgentSegment[] {
  const segments: AgentSegment[] = [];
  for (const item of items) {
    if (!isAgentToolItem(item)) {
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
 * `sessions_read ×3 · notes_list`, in FIRST-APPEARANCE order — the session
 * transcript's `tallyParts` rule, with the Agent's own name for a step.
 *
 * A STEP IS NAMED BY ITS TOOL, because that is all these rows are: the session's
 * verbs ("Ran command", "Read file") come off a typed `detail` the Agent's rows
 * do not have, and `displayToolName` is already what the unfolded row says — so
 * the fold and the rows behind it use one vocabulary.
 */
export function agentTallyParts(items: readonly AgentToolItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = displayToolName(item.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
}

export function AgentTranscript({
  items,
  /**
   * A TURN IS IN FLIGHT, so the LAST run keeps the rolling window and its
   * newest step stays visible — the agent's current step is the one thing a
   * reader watching it work is watching for. Every earlier run has been moved
   * past and is already a tally, and a settled conversation is all tallies.
   */
  running = false,
}: {
  items: readonly AgentItem[];
  running?: boolean;
}) {
  const segments = segmentAgentItems(items);
  const tail = running ? segments.length - 1 : -1;
  return (
    <div className="flex flex-col gap-4 py-4">
      {segments.map((segment, index) =>
        segment.kind === "row" ? (
          <AgentItemRow key={`${segment.item.kind}:${segment.item.id}`} item={segment.item} />
        ) : (
          // Keyed by the run's FIRST row so the fold's open state survives rows
          // appending to it, and so a run that just settled keeps the same
          // element rather than remounting collapsed under the reader.
          <AgentStepGroup key={`run:${segment.items[0]!.id}`} items={segment.items} live={index === tail} />
        ),
      )}
    </div>
  );
}

/**
 * A RUN OF TOOL CALLS, at whichever of the two scales applies.
 *
 * ONE `Message` FOR THE RUN, not one per call: the lane and its 50rem measure
 * are about where the assistant's side of the conversation sits, and a fold that
 * opened twelve of them would put eleven gaps inside one collapsed step.
 */
function AgentStepGroup({ items, live }: { items: AgentToolItem[]; live: boolean }) {
  return (
    <Message from="assistant">
      <MessageContent from="assistant">
        <div className="flex w-full min-w-0 flex-col gap-0.5 text-xs">
          <StepFold
            rows={items}
            live={live}
            failed={(item) => item.status === "failed"}
            tally={() => agentTallyParts(items).join(" · ")}
            renderRows={(shown) => shown.map((item) => <ToolRow key={item.id} item={item} />)}
          />
        </div>
      </MessageContent>
    </Message>
  );
}

function AgentItemRow({ item }: { item: Exclude<AgentItem, AgentToolItem> }) {
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

/**
 * ONE TOOL CALL. Bare — no `Message` of its own, because it is drawn inside the
 * run's lane (see `AgentStepGroup`) rather than as a message in its own right.
 */
function ToolRow({ item }: { item: AgentToolItem }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  let input: string | undefined;
  try {
    input = item.input && Object.keys(item.input as Record<string, unknown>).length > 0 ? JSON.stringify(item.input, null, 2) : undefined;
  } catch {
    input = undefined;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
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
    </div>
  );
}
