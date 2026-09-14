// IMPORTED, NOT RE-DECLARED. This file used to carry its own structural copy of
// the snapshot shape, which typechecked happily while the engine grew a field it
// never learned about — `tasks` was invisible here for exactly that reason.
import type { EngineEvent, Item, SessionBootstrap, SessionSnapshot, SnapshotPage, SnapshotWindow, Subscription, Task, Turn } from "@telar/engine-client";
import { journalCursor } from "./journal";

export type SessionSyncApi = {
  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot>;
  events(sessionId: string, after: number): Promise<{ events: EngineEvent[] }>;
  /**
   * The one-read opening (#407). OPTIONAL, and that is not politeness: a
   * REMOTE host may be running an engine older than the route, and the two-call
   * path below is the honest fallback rather than a 404 on every switch.
   */
  sessionBootstrap?(sessionId: string, window?: SnapshotWindow): Promise<SessionBootstrap>;
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

export type HydratedSession = SessionSnapshot & {
  events: EngineEvent[];
  cursor: number;
  /** Present only from the one-read opening — the engine folded it beside the
   *  snapshot. Absent on the fallback path, where nothing asked for it. */
  subscriptions?: Subscription[];
};

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
  /**
   * ONE READ WHERE THE ENGINE OFFERS ONE (#407). The two calls below are
   * SERIAL by construction — the tail's `after` is the snapshot's own cursor —
   * so opening a conversation cost two full round trips through the cockpit's
   * route handlers before a transcript could be folded. `/bootstrap` answers
   * both from the same instant, with the same overlap-never-gap guarantee.
   */
  if (api.sessionBootstrap) {
    const { events, subscriptions, ...snapshot } = await api.sessionBootstrap(sessionId, window);
    return {
      ...snapshot,
      events,
      subscriptions,
      cursor: Math.max(snapshot.cursor ?? 0, journalCursor(events)),
    };
  }
  const snapshot = await api.session(sessionId, window);
  const from = snapshot.cursor ?? journalCursor((await api.events(sessionId, 0)).events);
  const tail = await api.events(sessionId, from);
  return { ...snapshot, events: tail.events, cursor: Math.max(from, journalCursor(tail.events)) };
}

/**
 * NO REWIND HERE, DELIBERATELY. An open item's prefix can end BELOW the
 * snapshot's cursor, which looks like a reason to tail from the lower of the
 * two — and would be, if the gap could contain that item's deltas. It cannot:
 * the engine builds each open item's prefix complete through the same cursor it
 * stamps (`openItemPrefix`), so a lower watermark only means no delta arrived
 * in between. Rewinding would replay `item.completed` and turn transitions onto
 * a snapshot that already reflects them — a much larger claim than dropping a
 * duplicate delta, and one event-id dedupe does not make for us.
 */
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
  const merged = [...older.filter((row) => !carried.has(id(row))), ...fresh];
  /**
   * A MERGE THAT CHANGED NOTHING HANDS BACK WHAT IT WAS GIVEN (#407).
   *
   * The cockpit tails once a second and merges the answer into state whether or
   * not the answer moved — and the quiet answer is the SAME row objects, because
   * no companion snapshot was fetched. A fresh array of identical rows is still
   * a new value to `useState`, so every quiet second re-rendered the cockpit and
   * re-folded its whole transcript to arrive back where it started. Returning
   * `older` makes React's own bail-out do the work.
   *
   * Identity, not equality: these rows come off `JSON.parse`, so two structurally
   * equal rows from two reads are correctly different and a deep compare would
   * only be a slower way to reach the same answer.
   */
  if (merged.length !== older.length) return merged;
  for (let index = 0; index < merged.length; index += 1) if (merged[index] !== older[index]) return merged;
  return older;
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
