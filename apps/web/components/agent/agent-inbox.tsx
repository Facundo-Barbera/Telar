"use client";

/**
 * THE INBOX STRIP, ABOVE THE COMPOSER — issue #541, section A.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 * A wake no longer starts an Agent turn, so nothing in the conversation below
 * says that four workers finished overnight. The model is told at the top of the
 * next turn, as a digest; this is the same rows, for the person, before they
 * type — so they can ask about the one that matters rather than "what happened".
 *
 * ── THE SAME WORDS THE DIGEST USES ──────────────────────────────────────────
 * `agentInboxLabel` and `rankAgentInbox` are shared with nothing by accident:
 * the block the model reads says "WAITING ON YOU", "FAILED", "finished", and a
 * strip that said "Session finished a turn" beside it would be two spellings of
 * one happening — the bug `sessionWakeLabel` exists to prevent, one surface over.
 *
 * ── COLLAPSED BY DEFAULT, AND ABSENT WHEN EMPTY ─────────────────────────────
 * Absent is the ordinary case: a cockpit with no fan-out running has nothing
 * here and should show nothing, not an empty box. When there IS something, the
 * header alone answers "how many and is any of it waiting on me"; the rows are
 * one press away, because the thing directly above the composer should not push
 * the conversation off screen.
 */

import { useState } from "react";
import { BellIcon, CheckIcon, ChevronRightIcon } from "lucide-react";
import type { AgentInboxRow } from "@telar/engine-client";
import { agentInboxLabel } from "@/lib/agent/inbox";
import { cn } from "@/lib/utils";

/** The strip's own summary: what a collapsed header says. Lifted out so a test
 *  holds the sentence rather than reaching it through a render. */
export function agentInboxSummary(rows: readonly AgentInboxRow[], unread: number): string {
  const waiting = rows.filter((row) => row.kind === "request_opened").length;
  const count = Math.max(unread, rows.length);
  const what = `${count} ${count === 1 ? "update" : "updates"}`;
  return waiting > 0 ? `${what} · ${waiting} waiting on you` : what;
}

export function AgentInbox({
  rows,
  unread,
  onDismiss,
}: {
  rows: readonly AgentInboxRow[];
  unread: number;
  onDismiss: (ids: readonly number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // NOTHING WAITING, NOTHING DRAWN. Not an empty state: the conversation below
  // is the screen, and a permanent empty box above the composer would cost it
  // room to say nothing.
  if (rows.length === 0) return null;
  const waiting = rows.some((row) => row.kind === "request_opened");
  return (
    <div className="shrink-0 border-t border-border/60 px-4 py-1" aria-label="Agent inbox">
      <div className="mx-auto flex w-full max-w-[50rem] flex-col">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <BellIcon aria-hidden className={cn("size-3.5 shrink-0", waiting ? "text-warning" : "text-muted-foreground")} />
            <span className="shrink-0 font-medium">Inbox</span>
            <span className={cn("min-w-0 truncate", waiting ? "text-warning" : "text-muted-foreground")}>{agentInboxSummary(rows, unread)}</span>
            <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
          {/* CLEARING IS EXPLICIT AND SAYS WHAT IT DOES. The rows the Agent has
              not been shown are the ones it will open its next turn with, so
              dismissing them is a decision — "I have read this, do not tell it"
              — rather than tidying. */}
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-1 text-2xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onDismiss(rows.map((row) => row.id))}
          >
            Mark all read
          </button>
        </div>
        {open && (
          <ul className="space-y-0.5 pb-1">
            {rows.map((row) => (
              <AgentInboxItem key={row.id} row={row} onDismiss={onDismiss} />
            ))}
            {/* THE NUMBER BEHIND A CAPPED LIST. The strip holds a screenful; the
                honest answer past that is the count and the sentence that says
                who can find the rest. */}
            {unread > rows.length && (
              <li className="px-1.5 py-1 text-2xs text-muted-foreground">
                {`and ${unread - rows.length} more — ask the Agent, it can find them with sessions_find.`}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function AgentInboxItem({ row, onDismiss }: { row: AgentInboxRow; onDismiss: (ids: readonly number[]) => void }) {
  const { verb, tone } = agentInboxLabel(row);
  return (
    <li className="group/inbox flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs hover:bg-accent/40">
      <span className={cn("shrink-0", tone === "warning" ? "text-warning" : "text-muted-foreground")}>{verb}</span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground">{`session …${row.sessionId.slice(-6)}`}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{summaryOf(row.summary)}</span>
      <button
        type="button"
        aria-label={`Mark read: ${verb}`}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 outline-none group-hover/inbox:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onDismiss([row.id])}
      >
        <CheckIcon aria-hidden className="size-3" />
      </button>
    </li>
  );
}

/** The engine's own bracketed kind, stripped — the digest does the same, and for
 *  the same reason: the verb is already on the row beside it. */
function summaryOf(summary: string): string {
  return summary.replace(/^\[[^\]]*]\s*/, "").trim();
}
