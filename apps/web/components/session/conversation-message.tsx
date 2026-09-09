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
          className="flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-[0.6875rem] text-muted-foreground"
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
        <PromptText text={text} {...(onOpenTab ? { onOpen: onOpenTab } : {})} />
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

export function AgentMessageBubble({
  text,
  sender,
  attachments,
}: {
  text: string;
  sender: MessageSender;
  attachments?: readonly TurnAttachment[];
  onOpenTab?: OpenTab;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[50rem] py-0.5 text-sm" aria-label="Message from another agent">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">Agent message</span>
        <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{agentSenderLabel(sender)}</span>
        <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="max-h-96 min-w-0 overflow-auto break-words px-1.5 py-2">
          <MessageResponse streaming={false}>{text}</MessageResponse>
          <MessageAttachments {...(attachments ? { attachments } : {})} />
        </div>
      )}
    </div>
  );
}
