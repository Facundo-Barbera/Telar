"use client";

import { useState } from "react";
import { BotIcon, ChevronRightIcon, PaperclipIcon } from "lucide-react";
import type { TurnAttachment } from "@telar/engine-client";
import { Message, MessageContent, MessageResponse } from "@/ui/message";
import { PromptText } from "./prompt-text";

type MessageSender = { sessionId?: string };

export type OpenTab = NonNullable<Parameters<typeof PromptText>[0]["onOpen"]>;

function MessageAttachments({ attachments }: { attachments?: readonly TurnAttachment[] }) {
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
        {text.trim() && <PromptText text={text} {...(onOpenTab ? { onOpen: onOpenTab } : {})} />}
        <MessageAttachments {...(attachments ? { attachments } : {})} />
      </MessageContent>
    </Message>
  );
}

export function agentSenderLabel(sender: MessageSender): string {
  return sender.sessionId ? `agent · session …${sender.sessionId.slice(-6)}` : "agent · outside any session";
}

function noticeLine(notice: string): string {
  return notice.split("\n", 1)[0] ?? notice;
}

function intentLabel(intent?: string): string {
  return intent ? intent.charAt(0).toUpperCase() + intent.slice(1) : "Agent message";
}

export function AgentMessageBubble({
  text,
  notice,
  sender,
  attachments,
  intent,
  scope,
}: {
  text: string;
  notice?: string;
  sender: MessageSender;
  attachments?: readonly TurnAttachment[];
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
        <div className="max-h-96 min-w-0 overflow-auto break-words px-1.5 py-2">
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
