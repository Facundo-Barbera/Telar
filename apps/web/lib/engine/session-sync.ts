// IMPORTED, NOT RE-DECLARED. This file used to carry its own structural copy of
// the snapshot shape, which typechecked happily while the engine grew a field it
// never learned about — `tasks` was invisible here for exactly that reason.
import type { EngineEvent, SessionSnapshot } from "@telar/engine-client";
import { appendJournalEvents, journalCursor } from "./journal";

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
  // A request opening or closing changes what the human must DO, so it earns a
  // snapshot even though it is not a queue transition. Approvals are rare —
  // unlike deltas, they cannot storm.
  "request.opened",
  "request.resolved",
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
 * OPEN ON THE SNAPSHOT, TAIL FROM ITS CURSOR.
 *
 * The snapshot already says everything a settled turn will ever say; the
 * journal only adds what is still streaming. Reading the journal from zero to
 * learn what the snapshot already carried was the whole cost of opening a
 * long session — nine megabytes of events for one that needed a few hundred
 * kilobytes of tail. The engine stamps the snapshot with the id of the last
 * event it reflects (read BEFORE the snapshot, so the overlap is a replay the
 * fold absorbs, never a gap), and the client tails from there.
 *
 * An engine older than the stamp answers without one; then the journal has to
 * be asked where it ends. That read is the old cost, kept only for that case.
 */
export async function hydrateSession(api: SessionSyncApi, sessionId: string): Promise<HydratedSession> {
  const snapshot = await api.session(sessionId);
  const from = snapshot.cursor ?? journalCursor((await api.events(sessionId, 0)).events);
  const tail = await api.events(sessionId, from);
  return { ...snapshot, events: tail.events, cursor: Math.max(from, journalCursor(tail.events)) };
}

export async function tailSession(api: SessionSyncApi, sessionId: string, after: number): Promise<{
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
