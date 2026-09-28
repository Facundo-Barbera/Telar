"use client";

import { useState } from "react";
import {
ChevronRightIcon
} from "lucide-react";
import { type JournalTurn } from "@/platform/engine";
import { ROW } from "./transcript-fold";
import { cn } from "@/ui/utils";
import { notificationLabel } from "../model";

export function NotificationRow({ detail, message }: { detail: NonNullable<JournalTurn["notification"]>; message?: string }) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const { verb, Icon, head } = notificationLabel(detail, message);
  const body = detail.body.trim();
  const entries = detail.entries ?? [];
  const peerMessage = detail.kind === "peer_message" && message && message.trim() !== body ? message.trim() : undefined;
  return (
    <div className="min-w-0" aria-label="Notification">
      <button
        type="button"
        className={ROW}
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{verb}</span>
        {/* WHICH RESULT, not just that one arrived — #572. Two notices from one
            session on one screen have to be told apart without expanding both. */}
        {head && <span className="min-w-0 truncate text-2xs text-muted-foreground">{head}</span>}
        {entries.length > 1 && <span className="shrink-0 text-2xs text-muted-foreground">{`and ${entries.length - 1} more`}</span>}
        {detail.sessionId && (
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{`session …${detail.sessionId.slice(-6)}`}</span>
        )}
        {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {open && body && (
        <div className="px-1.5 pb-1">
          {entries.length > 1 && (
            <ul className="mb-1 space-y-0.5">
              {entries.map((entry, index) => (
                <li key={`${entry.runId ?? entry.sessionId ?? index}-${index}`} className="truncate text-2xs text-muted-foreground">
                  {entry.summary}
                </li>
              ))}
            </ul>
          )}
          <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{body}</p>
          {/* THE ACTION THE ROW IS FOR. The notice announces a message rather
              than quoting it — that is what keeps a recipient's context cheap —
              so the row has to offer the thing it announced, or the reader is
              left holding a headline. */}
          {peerMessage && (
            <button
              type="button"
              className="mt-1 rounded-md px-1 py-0.5 text-2xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={reading}
              onClick={() => setReading((current) => !current)}
            >
              {reading ? "Hide the message" : "Read the message"}
            </button>
          )}
          {reading && peerMessage && (
            <p className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs">{peerMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}
