"use client";

/**
 * ONE DEFINITION OF WHAT A MESSAGE LOOKS LIKE.
 *
 * A message sent while nothing was running and a message sent INTO a running
 * turn are the same thing to the person who typed them, and they now render
 * through the same component. They did not before: a mid-run message went
 * through a bespoke row in `transcript.tsx` with its own bubble, padding,
 * width and alignment, so the same sentence looked like a different kind of
 * object depending on whether the agent happened to be busy when it was sent.
 *
 * THE AUTHOR DISTINCTIONS THAT SURVIVE ARE THE REAL ONES. A peer agent's
 * message and an engine wake are not the person's words, and they are drawn
 * differently — but drawn the SAME differently whether they arrive mid-run or
 * idle, which is the rule the old steer row broke in both directions. What
 * does not survive is a distinction drawn only from delivery timing: there is
 * no "steered" badge, no compact variant, no separate card.
 *
 * WHY IT LIVES HERE rather than in either caller: the cockpit draws a turn's
 * own message and the transcript draws a steered one, and the two must not be
 * able to drift. `transcript.tsx` may not import `session-cockpit.tsx` (the
 * import runs the other way), so a shared home is the only shape that lets
 * both use one definition.
 */

import { BotIcon, PaperclipIcon } from "lucide-react";
import type { TurnAttachment } from "@telar/engine-client";
import { Message, MessageContent } from "@/components/ui/message";
import { PromptText } from "./prompt-text";

type MessageSender = { sessionId?: string };

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
  onOpenTab?: (tab: Parameters<NonNullable<Parameters<typeof PromptText>[0]["onOpen"]>>[0]) => void;
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

/**
 * A MESSAGE ANOTHER AGENT SENT — `sessions_send`, landing as a turn of its own
 * or steered into a running one, and drawn identically either way. In the
 * assistant's lane, left-aligned, with a bot glyph and the sender's id: NOT the
 * person's bubble. The rendering this replaced showed an orchestrator's
 * instructions as if the human had typed them, which is the misreading the
 * engine's `sender` stamp exists to prevent — a peer's report carries no human
 * authorization and the transcript must not look as though it did.
 *
 * HERE, BESIDE `ConversationMessage`, for the reason that component exists at
 * all: the cockpit and the transcript both draw one of these, and the import
 * only runs one way between them.
 */
export function agentSenderLabel(sender: MessageSender): string {
  return sender.sessionId ? `agent · session …${sender.sessionId.slice(-6)}` : "agent · outside any session";
}

export function AgentMessageBubble({
  text,
  sender,
  attachments,
  onOpenTab,
}: {
  text: string;
  sender: MessageSender;
  attachments?: readonly TurnAttachment[];
  onOpenTab?: (tab: Parameters<NonNullable<Parameters<typeof PromptText>[0]["onOpen"]>>[0]) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-dashed border-border/80 bg-muted/30 px-3 py-2" aria-label="Message from another agent">
      <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <BotIcon className="size-3.5 shrink-0" />
        <span className="font-mono">{agentSenderLabel(sender)}</span>
        <span>· not the user, no approval implied</span>
      </div>
      <PromptText text={text} {...(onOpenTab ? { onOpen: onOpenTab } : {})} />
      <MessageAttachments {...(attachments ? { attachments } : {})} />
    </div>
  );
}
