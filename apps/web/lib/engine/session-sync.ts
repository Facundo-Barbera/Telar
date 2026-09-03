// IMPORTED, NOT RE-DECLARED. This file used to carry its own structural copy of
// the snapshot shape, which typechecked happily while the engine grew a field it
// never learned about — `tasks` was invisible here for exactly that reason.
import type { EngineEvent, Item, SessionSnapshot, SnapshotPage, SnapshotWindow, Task, Turn } from "@telar/engine-client";
import { journalCursor } from "./journal";

export type SessionSyncApi = {
  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot>;
  events(sessionId: string, after: number): Promise<{ events: EngineEvent[] }>;
};

/**
 * WHY 10 AND 20. The first paint should carry roughly what a screen can show
 * plus a little scrollback — t3code measured ~100 KB gzipped for ten turns of
 * a typical session, against 4.5 MB for the same session read whole. Ten turns
 * also covers the MEDIAN session entirely, so most opens are still one page.
 * Older pages are a deliberate click, so they can afford to be bigger: twenty
 * turns per "Load earlier turns" press keeps the click count low without
 * making any single response heavy.
 */
export const INITIAL_TURNS = 10;
export const OLDER_PAGE_TURNS = 20;

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
export async function hydrateSession(
  api: SessionSyncApi,
  sessionId: string,
  window?: SnapshotWindow,
): Promise<HydratedSession> {
  const snapshot = await api.session(sessionId, window);
  const from = snapshot.cursor ?? journalCursor((await api.events(sessionId, 0)).events);
  const tail = await api.events(sessionId, from);
  return { ...snapshot, events: tail.events, cursor: Math.max(from, journalCursor(tail.events)) };
}

export async function tailSession(
  api: SessionSyncApi,
  sessionId: string,
  after: number,
  window?: SnapshotWindow,
): Promise<{
  events: EngineEvent[];
  cursor: number;
  snapshot?: SessionSnapshot;
}> {
  const page = await api.events(sessionId, after);
  return {
    events: page.events,
    cursor: Math.max(after, journalCursor(page.events)),
    ...(needsSessionSnapshot(page.events) ? { snapshot: await api.session(sessionId, window) } : {}),
  };
}

export type SnapshotRows = { turns: Turn[]; items: Item[]; tasks: Task[] };
export type OlderPage = SnapshotRows & { page?: SnapshotPage };

/** One page of settled turns above `before`, sized for a deliberate click. */
export async function loadOlderTurns(api: SessionSyncApi, sessionId: string, before: string): Promise<OlderPage> {
  const snapshot = await api.session(sessionId, { turns: OLDER_PAGE_TURNS, before });
  return { turns: snapshot.turns, items: snapshot.items, tasks: snapshot.tasks, page: snapshot.page };
}

/**
 * Union by id: `fresh` wins every collision, `older` rows it does not carry
 * are PREPENDED in their own order. This one shape serves both directions —
 * an older page merged under the loaded transcript, and a windowed companion
 * snapshot merged over already-paged-in history.
 */
export function mergeRows<T>(older: T[], fresh: T[], id: (row: T) => string): T[] {
  const carried = new Set(fresh.map(id));
  return [...older.filter((row) => !carried.has(id(row))), ...fresh];
}

/**
 * Prepend an older page below what is already loaded. Pure, and dedupes by id
 * (turns by runId, items and tasks by id) because a page boundary can shift
 * under a live session — a turn settling between two reads may appear on both
 * sides. The CURRENT rows win a collision: they are the fresher read.
 */
export function mergeOlderPage(current: SnapshotRows, page: SnapshotRows): SnapshotRows {
  return {
    turns: mergeRows(page.turns, current.turns, (turn) => turn.runId),
    items: mergeRows(page.items, current.items, (item) => item.id),
    tasks: mergeRows(page.tasks, current.tasks, (task) => task.id),
  };
}
