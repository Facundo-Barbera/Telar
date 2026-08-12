import type { EngineEvent, Item, Session, Turn } from "@telar/engine-client";
import { appendJournalEvents, journalCursor } from "./journal";

type SessionSnapshot = { session: Session; turns: Turn[]; items: Item[] };

export type SessionSyncApi = {
  session(sessionId: string): Promise<SessionSnapshot>;
  events(sessionId: string, after: number): Promise<{ events: EngineEvent[] }>;
};

export type HydratedSession = SessionSnapshot & { events: EngineEvent[]; cursor: number };

/** Every event that changes the durable queue needs its companion snapshot. */
const QUEUE_CHANGING_EVENTS = new Set<EngineEvent["type"]>([
  "turn.accepted",
  "turn.requeued",
  "turn.claimed",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.stopped",
  "turn.ambiguous",
  "turn.discarded",
]);

/**
 * Every event that changes the durable queue needs its companion snapshot.
 *
 * ITEM AND DELTA EVENTS ARE DELIBERATELY ABSENT from this set. They are the
 * high-frequency half of v2 — a streaming turn emits one per token — and the
 * fold applies them directly. Refetching a snapshot per delta would turn
 * streaming into a request storm for information the event already carried.
 */
export function needsSessionSnapshot(events: EngineEvent[]): boolean {
  return events.some((event) => QUEUE_CHANGING_EVENTS.has(event.type));
}

/**
 * A journal page and a session snapshot cannot be read atomically.  Reading
 * journal → snapshot → journal tail → snapshot closes both directions of that
 * gap: transitions are reflected by their event and a new accepted turn gains
 * its prompt from a snapshot even though `turn.accepted` intentionally omits it.
 */
export async function hydrateVNextSession(api: SessionSyncApi, sessionId: string): Promise<HydratedSession> {
  const journal = await api.events(sessionId, 0);
  await api.session(sessionId);
  const catchup = await api.events(sessionId, journalCursor(journal.events));
  const events = appendJournalEvents(journal.events, catchup.events);
  const snapshot = await api.session(sessionId);
  return { ...snapshot, events, cursor: journalCursor(events) };
}

export async function tailVNextSession(api: SessionSyncApi, sessionId: string, after: number): Promise<{
  events: EngineEvent[];
  cursor: number;
  snapshot?: SessionSnapshot;
}> {
  const page = await api.events(sessionId, after);
  return {
    events: page.events,
    cursor: Math.max(after, journalCursor(page.events)),
    ...(needsSessionSnapshot(page.events) ? { snapshot: await api.session(sessionId) } : {}),
  };
}
