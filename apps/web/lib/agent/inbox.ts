"use client";

/**
 * THE AGENT'S WAKE INBOX, READ AND CLEARED — issue #541, section A.
 *
 * ── WHY IT IS NOT PART OF `useAgentThread` ──────────────────────────────────
 * The thread hook merges two sources into one ordered transcript and follows a
 * live stream. The inbox is a flat, small, separately-cursored list that most
 * screens never open, and folding it in would make every change to either a
 * change to both. It shares the stream ONLY as a nudge: an `inbox` frame says
 * "something landed", and this re-reads. The route stays the authoritative list,
 * because a reconnect does not replay those frames.
 *
 * ── UNREAD ONLY, AND THAT IS THE WHOLE SECTION ──────────────────────────────
 * What the strip above the composer is for is "what came in while I was away".
 * A row the Agent has already been shown is history, and history is what the
 * conversation below it already is.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInboxRow } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { inboxSubject, notificationVerbs } from "@/lib/notifications";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

/**
 * HOW MANY ROWS THE SECTION HOLDS. It is a strip above a composer, not a
 * mailbox: past a screenful the useful answer is the COUNT plus "ask the Agent",
 * which is exactly what `unread` beside the rows gives.
 */
export const AGENT_INBOX_LIMIT = 20;

/** The section's own poll. Slower than the status row's three seconds, because a
 *  wake landing is not something anyone is watching for by the second, and the
 *  stream nudges this the moment one does. */
export const AGENT_INBOX_POLL_MS = 15_000;

/**
 * WHAT A ROW IS CALLED — the digest's own vocabulary, deliberately.
 *
 * The block the model was shown says "WAITING ON YOU", "FAILED", "finished";
 * this strip is the person's view of the same rows, and two spellings of one
 * happening is the bug `notificationVerbs` exists to prevent. `tone` is the
 * rail's pair: `warning` for "a person has to move".
 *
 * THE REGISTER IS THIS STRIP'S; THE CLASSIFICATION IS NOT (#572). It used to
 * keep its own switch on kind and intent — a second place for a new intent to be
 * forgotten in, and a second place to decide a peer's message was a wake.
 */
export function agentInboxLabel(row: Pick<AgentInboxRow, "kind" | "intent">): { verb: string; tone: "warning" | "muted" } {
  const { short, tone } = notificationVerbs(inboxSubject(row));
  return { verb: short, tone };
}

/**
 * THE RANKING THE DIGEST USES, applied to the strip.
 *
 * Waiting on you, then failed, then everything else newest-first. A person
 * glancing at this asks the same question the model was asked — "is anything
 * waiting on me" — and a list in arrival order buries it under whatever finished
 * last.
 */
const RANK: Record<AgentInboxRow["kind"], number> = {
  request_opened: 0,
  turn_failed: 1,
  peer_message: 2,
  turn_completed: 3,
  turn_stopped: 4,
};

export function rankAgentInbox(rows: readonly AgentInboxRow[]): AgentInboxRow[] {
  return [...rows].sort((left, right) => RANK[left.kind] - RANK[right.kind] || right.id - left.id);
}

export type AgentInboxHandle = {
  /** Unread rows, ranked. Empty when there is nothing waiting, which is the
   *  ordinary case and is why the section draws nothing at all. */
  rows: AgentInboxRow[];
  /** How many are unread IN TOTAL — the number behind a capped list. */
  unread: number;
  /** Mark these read. Optimistic: the row goes at once and the next read is the
   *  engine's word on it, because a strip that waited a round trip to dismiss
   *  would feel broken on a slow Mac. */
  dismiss: (ids: readonly number[]) => Promise<void>;
  /** Re-read now. The stream's `inbox` frame calls this. */
  refresh: () => void;
};

export function useAgentInbox(hostId: string = LOCAL_HOST_ID, nudge = 0): AgentInboxHandle {
  const [rows, setRows] = useState<AgentInboxRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [tick, setTick] = useState(0);
  const api = useMemo(() => createEngineApi(hostFetcher(hostId)), [hostId]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const answer = await api.agentInbox({ unreadOnly: true, limit: AGENT_INBOX_LIMIT });
        if (cancelled) return;
        setRows(rankAgentInbox(answer.rows));
        setUnread(answer.unread);
      } catch {
        // A MAC THAT DID NOT ANSWER KEEPS WHAT IS ON SCREEN, like every other
        // poll in this cockpit. The next ask is seconds away.
      }
    };
    // Deferred a tick like every other loader here — setting state from an
    // effect BODY is the cascade this app's lint forbids.
    const first = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => void read(), AGENT_INBOX_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [api, tick, nudge]);

  const dismiss = useCallback(async (ids: readonly number[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setRows((held) => held.filter((row) => !gone.has(row.id)));
    setUnread((held) => Math.max(0, held - ids.length));
    try {
      const answer = await api.markAgentInboxRead(ids);
      setUnread(answer.unread);
    } catch {
      // The write failed, so the next poll will put the rows back — which is
      // the honest outcome rather than a row that looks dismissed for ever.
      setTick((value) => value + 1);
    }
  }, [api]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return { rows, unread, dismiss, refresh };
}
