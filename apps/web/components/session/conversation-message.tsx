"use client";

/**
 * ONE DEFINITION OF WHAT A MESSAGE LOOKS LIKE.
 *
 * A message sent while nothing was running and one sent INTO a running turn
 * are the same thing to the person who typed them. A mid-run message used to
 * go through a bespoke row with its own bubble, padding, width and alignment,
 * so the same sentence looked like a different kind of object depending on
 * whether the agent happened to be busy.
 *
 * Author distinctions survive — a peer agent's words and an engine wake are
 * not the person's — but drawn the same way whether they arrive mid-run or
 * idle. No badge, no compact variant, no card earned by timing alone.
 *
 * HERE rather than in either caller because both draw one and `transcript.tsx`
 * may not import `session-cockpit.tsx`; the import runs the other way.
 */

import { useState } from "react";
import { BotIcon, ChevronRightIcon, PaperclipIcon } from "lucide-react";
import type { TurnAttachment } from "@telar/engine-client";
import { Message, MessageContent, MessageResponse } from "@/components/ui/message";
import { PromptText } from "./prompt-text";

type MessageSender = { sessionId?: string };

/** Opening a reference a chip stands for — the composer's own gesture,
 *  threaded so a steered message's chips work like an idle one's. */
export type OpenTab = NonNullable<Parameters<typeof PromptText>[0]["onOpen"]>;

/**
 * WHAT WAS SENT, not what the model made of it. A transcript that shows the
 * words and not the screenshot has lost half the message, and re-reading it
 * later is exactly when that half matters. Named rather than rendered: the
 * bytes live beside the session on the engine's disk, and no route serves
 * them back to a browser.
 */
export function MessageAttachments({ attachments }: { attachments?: readonly TurnAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          title={attachment.path}
          className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-2xs text-muted-foreground"
        >
          <PaperclipIcon className="size-3 shrink-0" />
          <span className="max-w-48 truncate">{attachment.name}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A MESSAGE THE PERSON SENT. The ordinary bubble, wherever it landed.
 *
 * `PromptText` rather than the raw string, and this is not a detail: every
 * reference a gesture put in the composer comes back as a chip. Rendering the
 * text bare is how a dropped issue reappeared in the transcript as
 * `#409 "…" (https://github.com/…)`, URL and all. Nothing is stored to fix
 * that — the draft has always been plain text with chips derived from it, and
 * this reads it the same way the composer wrote it.
 *
 * NOT ROUTED THROUGH THE STREAMING BODY, deliberately. A person's message is
 * complete the instant it exists: there is no partial text to reveal, and
 * pacing one would be an animation on something nobody is waiting for. The
 * streamed path belongs to the assistant's reply.
 */
export function ConversationMessage({
  text,
  attachments,
  onOpenTab,
}: {
  text: string;
  attachments?: readonly TurnAttachment[];
  onOpenTab?: OpenTab;
}) {
  return (
    <Message from="user">
      <MessageContent from="user">
        {/* An image-only message is its pictures; an empty paragraph above
            them would only be a gap. */}
        {text.trim() && <PromptText text={text} {...(onOpenTab ? { onOpen: onOpenTab } : {})} />}
        <MessageAttachments {...(attachments ? { attachments } : {})} />
      </MessageContent>
    </Message>
  );
}

/** Direct session messages are internal activity, like session wakes. Keep
 * the sender visible and the payload behind a disclosure, independent of
 * whether it starts a turn or arrives as steering. */
export function agentSenderLabel(sender: MessageSender): string {
  return sender.sessionId ? `agent · session …${sender.sessionId.slice(-6)}` : "agent · outside any session";
}

/**
 * THE COLLAPSED ROW SAYS WHAT THE MODEL WAS TOLD, VERBATIM.
 *
 * A peer's message no longer reaches the recipient's model as its text: the
 * engine mints a one-line notice — sender, run, size, opening line — and hands
 * the model that (see `Turn.agentNotice`). The row shows the SAME string rather
 * than a summary of its own, because a person opening this transcript to work
 * out why a session did something needs the sentence it actually acted on, not
 * a second rendering of the same facts that could drift from it.
 *
 * The engine ids in it are deliberate duplication with the sender chip beside
 * it: the chip is the link a person clicks, the line is the text a model read.
 *
 * Falls back to the old label for turns stored before notices existed.
 */
function noticeLine(notice: string): string {
  return notice.split("\n", 1)[0] ?? notice;
}

/**
 * The peer's own word for what it sent — `task`, `report`, `result`, `blocker`
 * — as the row's label. A message steered mid-turn carries no intent (the
 * engine stamps that on the turn), and keeps the wording the row always had.
 */
function intentLabel(intent?: string): string {
  return intent ? intent.charAt(0).toUpperCase() + intent.slice(1) : "Agent message";
}

/**
 * EVERY INTENT COLLAPSES, A TASK INCLUDED.
 *
 * A task used to render in full here, on the reasoning that the instruction is
 * why the session is doing anything. But the full-render arm meant a peer
 * decided how much of someone else's prose sat in the middle of this
 * conversation — on the phone it put 3 KB of a worker's report between two of
 * the reader's own messages. The intent is the row's LABEL instead, the scope
 * stays on the header line, and the body opens on tap into a bounded scroll.
 */
export function AgentMessageBubble({
  text,
  notice,
  sender,
  attachments,
  intent,
  scope,
}: {
  text: string;
  /** The engine's announcement of this message — the collapsed label, and what
   *  the recipient's model was handed in place of `text`. */
  notice?: string;
  sender: MessageSender;
  attachments?: readonly TurnAttachment[];
  /** What the peer meant by sending. Names the row; never renders it in full. */
  intent?: string;
  scope?: string;
  onOpenTab?: OpenTab;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[50rem] py-0.5 text-sm" aria-label="Message from another agent">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{intentLabel(intent)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {notice ? noticeLine(notice) : agentSenderLabel(sender)}
        </span>
        {scope && <span className="shrink-0 truncate text-2xs text-muted-foreground">{scope}</span>}
        <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        // EXPANDS TO WHAT WAS SENT, not to the notice — bounded, with its own
        // scroll, the way the phone bounds it: the body is stored whole and a
        // peer does not get to decide how much of this transcript it occupies.
        <div className="max-h-96 min-w-0 overflow-auto break-words px-1.5 py-2">
          {/* WHERE THE WORDS CAME FROM. Attribution is the ENGINE's
              (`Turn.sender`, stamped from a claim token), so nothing a model
              writes can change whose name is on it. */}
          {sender.sessionId ? (
            <a
              href={`/sessions/${encodeURIComponent(sender.sessionId)}`}
              className="mb-1.5 block min-w-0 truncate font-mono text-2xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {agentSenderLabel(sender)}
            </a>
          ) : (
            <span className="mb-1.5 block min-w-0 truncate font-mono text-2xs text-muted-foreground">{agentSenderLabel(sender)}</span>
          )}
          <MessageResponse streaming={false}>{text}</MessageResponse>
          <MessageAttachments {...(attachments ? { attachments } : {})} />
        </div>
      )}
    </div>
  );
}
