// IMPORTED, NOT RE-DECLARED. This file used to carry its own structural copy of
// the snapshot shape, which typechecked happily while the engine grew a field it
// never learned about — `tasks` was invisible here for exactly that reason.
import type { EngineEvent, Item, SessionBootstrap, SessionSnapshot, SnapshotPage, SnapshotWindow, Subscription, Task, Turn } from "@telar/engine-client";
import { isActiveTurn, journalCursor } from "./journal";

export type SessionSyncApi = {
  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot>;
  /** ONE PAGE above `after` (#494). `more` is optional here because an engine
   *  older than the route never sends it, and absent must read as "that was
   *  everything" — which is exactly what it meant before. */
  events(sessionId: string, after: number): Promise<{ events: EngineEvent[]; more?: boolean }>;
  /**
   * The same page, asked CONDITIONALLY — issue #586.
   *
   * OPTIONAL for `sessionBootstrap`'s reason: a remote host may be running an
   * engine older than the tag, and the unconditional `events` above is the
   * honest fallback rather than a broken tail on every switch.
   *
   * `unchanged: true` MEANS KEEP WHAT YOU HAVE. It is not an empty page, and a
   * caller that folded it as one would blank a transcript once a second — which
   * is why the two arms are different shapes rather than one shape with an
   * empty list.
   */
  eventsIfChanged?(
    sessionId: string,
    after: number,
    etag?: string,
  ): Promise<{ unchanged: true; etag?: string } | { unchanged: false; payload: { events: EngineEvent[]; more?: boolean }; etag?: string }>;
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

/**
 * HOW OFTEN THE COCKPIT RE-READS THE JOURNAL — 1 s while a turn is running,
 * 3 s once the conversation has settled.
 *
 * A PORT, NOT A DESIGN. iOS has shipped exactly this since
 * `SessionSyncEngine.interval` (`apps/ios/TelarMobile/Sync/SessionSyncEngine.swift`),
 * and the web cockpit is simply the client that never got it. Two clients
 * disagreeing about when a conversation is worth watching is the class of bug
 * #490 keeps turning up, so the numbers here are the Swift ones rather than
 * fresh opinions.
 *
 * WHY THIS AND NOT A VISIBILITY GATE. The obvious saving — stop polling when
 * nobody is looking — is not available in Telar's own shell: `apps/desktop`
 * sets `webPreferences.backgroundThrottling: false` as the renderer half of the
 * anti-flicker pair for the translucent window, and that flag SUPPRESSES THE
 * PAGE VISIBILITY API outright. `document.visibilityState` reads `"visible"`
 * for the life of the window and `visibilitychange` never fires, so a gate
 * written against it is dead code on the only platform this app ships.
 * Measured in a real Electron with a one-token control; see the #490 comment of
 * 2026-09-20. This cadence needs none of that — it follows turn state, which is
 * true on every platform.
 *
 * AND IT CANNOT WEDGE, which is the property that matters more than the
 * saving. Every tick still happens; only the spacing changes. A settled cockpit
 * polling at 3 s still notices a turn somebody else started — a peer assigning
 * work, a detached run finishing — within one tick, and re-arms to 1 s. There
 * is no edge to miss and no state to get stuck in, which is the defect a
 * "stop polling until something wakes us" design would have re-created in a new
 * place (#490 §4.5's snooze bug, one layer along).
 *
 * WHAT IT SAVES: an idle cockpit on a settled conversation drops from 86,400
 * reads a day to 28,800, and the saving is identical on a store with three
 * conversations and one with three hundred.
 */
export const TAIL_LIVE_MS = 1_000;
export const TAIL_SETTLED_MS = 3_000;

/**
 * The tail's period for a conversation in this state.
 *
 * FROM TURNS ALREADY IN HAND — never a separate probe. The whole point is to
 * spend fewer requests, so asking the engine whether it is worth asking the
 * engine would be the same cost wearing a different hat. `turns` is what the
 * last tail wrote, so this is free.
 *
 * `queued` COUNTS AS LIVE, via `isActiveTurn`. A turn waiting its place in the
 * queue is about to produce rows, and the backlog's own position changes as the
 * one ahead of it finishes — a reader watching a queue of three wants that at
 * 1 s like anything else in motion.
 */
export function tailIntervalMs(turns: readonly Pick<Turn, "state">[]): number {
  return turns.some((turn) => isActiveTurn(turn.state)) ? TAIL_LIVE_MS : TAIL_SETTLED_MS;
}

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
  /**
   * DRAINED, because this branch wants the journal's END and a page gives it
   * the journal's BEGINNING (#494). Only an engine too old to stamp a cursor
   * reaches here, and for that one there is no cheaper answer than walking to
   * the last id — in bounded pages now, rather than one 36 MB response.
   */
  const from = snapshot.cursor ?? (await drainEvents(api, sessionId, 0)).cursor;
  const tail = await drainEvents(api, sessionId, from);
  return { ...snapshot, events: tail.events, cursor: Math.max(from, tail.cursor) };
}

/**
 * EVERY EVENT ABOVE `after`, however many pages that takes (#494).
 *
 * The engine caps one response, so a client that has been away — a laptop that
 * slept, a tab left open through a long turn — gets `more: true` and has to ask
 * again. Folding one page and stopping would leave the transcript silently
 * short of what the session actually did, which is worse than the cost this
 * paging exists to avoid.
 *
 * `MAX_PAGES` IS A STOP, NOT A BUDGET. A journal appended to faster than it is
 * read would otherwise spin here forever, blocking a tick that runs once a
 * second; stopping hands back a valid cursor, so the next tick resumes where
 * this one reached and nothing is lost.
 */
const MAX_PAGES = 100;

export async function drainEvents(
  api: SessionSyncApi,
  sessionId: string,
  after: number,
): Promise<{ events: EngineEvent[]; cursor: number }> {
  let cursor = after;
  let events: EngineEvent[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await api.events(sessionId, cursor);
    events = events.length ? [...events, ...read.events] : read.events;
    const reached = Math.max(cursor, journalCursor(read.events));
    // A page that moved nothing ends the walk whatever `more` claims: asking
    // again from the same cursor is the one way this loop cannot terminate.
    if (!read.more || reached === cursor) return { events, cursor: reached };
    cursor = reached;
  }
  return { events, cursor };
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
  etag?: string,
): Promise<{
  events: EngineEvent[];
  cursor: number;
  snapshot?: SessionSnapshot;
  /** The tag to spend on the next tick. Absent from an engine that does not
   *  mint one, which simply keeps the unconditional behaviour. */
  etag?: string;
  /** THE ENGINE SAID NOTHING MOVED. `events` is empty because there is nothing
   *  to add, NOT because the journal is empty — the caller keeps what it has
   *  and must not treat this as a reset. */
  unchanged?: true;
}> {
  /**
   * THE CHEAP TICK FIRST — issue #586. This is the cockpit's largest loop at
   * 1 s, and almost every pass answers "nothing new"; with a tag that pass
   * costs a status line and no body at all.
   *
   * ONLY WHEN THERE IS A TAG TO SPEND, and only for the FIRST page. A drain
   * that is paging through a backlog is not the case this saves — it has real
   * rows to carry on every request — so the condition is asked once and the
   * walk below is unchanged.
   */
  if (api.eventsIfChanged && etag) {
    const asked = await api.eventsIfChanged(sessionId, after, etag);
    if (asked.unchanged) return { events: [], cursor: after, unchanged: true, ...(asked.etag ? { etag: asked.etag } : {}) };
    // A page came back. It may be the first of several, so the drain below
    // still runs from wherever this one reached.
    const reached = Math.max(after, journalCursor(asked.payload.events));
    const rest = asked.payload.more ? await drainEvents(api, sessionId, reached) : { events: [], cursor: reached };
    const events = rest.events.length ? [...asked.payload.events, ...rest.events] : asked.payload.events;
    return {
      events,
      cursor: Math.max(reached, rest.cursor),
      ...(asked.etag ? { etag: asked.etag } : {}),
      ...(needsSessionSnapshot(events) ? { snapshot: await api.session(sessionId, window) } : {}),
    };
  }
  // DRAINED (#494): a quiet tick is one page and stops on the first answer, so
  // the ordinary second costs exactly what it did. A tick that comes back to a
  // session which ran while the tab slept keeps paging — each request bounded,
  // the transcript complete.
  const page = await drainEvents(api, sessionId, after);
  return {
    events: page.events,
    cursor: Math.max(after, page.cursor),
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
