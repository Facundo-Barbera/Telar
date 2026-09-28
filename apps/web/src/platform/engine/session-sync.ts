import type { EngineEvent, Item, SessionBootstrap, SessionSnapshot, SnapshotPage, SnapshotWindow, Subscription, Task, Turn } from "@telar/engine-client";
import { journalCursor } from "./journal";
import { isActiveTurn } from "./journal-items";

export type SessionSyncApi = {
  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot>;
  /** One page above `after`; an absent `more` (older engines) means that was everything. */
  events(sessionId: string, after: number): Promise<{ events: EngineEvent[]; more?: boolean }>;
  /**
   * Conditional page; optional because a remote host may run an older engine.
   * `unchanged: true` means keep what you have, not an empty page.
   */
  eventsIfChanged?(
    sessionId: string,
    after: number,
    etag?: string,
  ): Promise<{ unchanged: true; etag?: string } | { unchanged: false; payload: { events: EngineEvent[]; more?: boolean }; etag?: string }>;
  /** One-read opening; optional because a remote host may run an older engine. */
  sessionBootstrap?(sessionId: string, window?: SnapshotWindow): Promise<SessionBootstrap>;
};

/** First paint covers about a screen plus scrollback; older pages load on click. */
export const INITIAL_TURNS = 10;
export const OLDER_PAGE_TURNS = 20;

/**
 * Tail cadence: 1 s while a turn runs, 3 s once settled, matching iOS's
 * `SessionSyncEngine.interval`. Not gated on visibility: the desktop shell's
 * `backgroundThrottling: false` keeps `document.visibilityState` at "visible".
 */
export const TAIL_LIVE_MS = 1_000;
export const TAIL_SETTLED_MS = 3_000;

/** Derived from turns already in hand; `queued` counts as live. */
export function tailIntervalMs(turns: readonly Pick<Turn, "state">[]): number {
  return turns.some((turn) => isActiveTurn(turn.state)) ? TAIL_LIVE_MS : TAIL_SETTLED_MS;
}

export type HydratedSession = SessionSnapshot & {
  events: EngineEvent[];
  cursor: number;
  /** Present only from the one-read opening. */
  subscriptions?: Subscription[];
};

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
  // Requests change what the human must do; they're rare, so they can't storm.
  "request.opened",
  "request.resolved",
]);

/** Item and delta events are excluded: they stream per token and the fold applies them directly. */
export function needsSessionSnapshot(events: EngineEvent[]): boolean {
  return events.some((event) => QUEUE_CHANGING_EVENTS.has(event.type));
}

/**
 * Opens on the snapshot and tails from its cursor, which the engine reads before
 * the snapshot so the overlap is a replay, never a gap. Engines without a cursor
 * fall back to asking where the journal ends.
 */
export async function hydrateSession(
  api: SessionSyncApi,
  sessionId: string,
  window?: SnapshotWindow,
): Promise<HydratedSession> {
  // `/bootstrap` answers snapshot and tail from one instant in a single read.
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
  // Only a pre-cursor engine reaches here; drain to find the journal's end.
  const from = snapshot.cursor ?? (await drainEvents(api, sessionId, 0)).cursor;
  const tail = await drainEvents(api, sessionId, from);
  return { ...snapshot, events: tail.events, cursor: Math.max(from, tail.cursor) };
}

/**
 * Drains every page above `after`. `MAX_PAGES` stops a journal appended faster
 * than it is read; the returned cursor lets the next tick resume.
 */
const MAX_PAGES = 100;

async function drainEvents(
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
    // A page that moved nothing ends the walk regardless of `more`.
    if (!read.more || reached === cursor) return { events, cursor: reached };
    cursor = reached;
  }
  return { events, cursor };
}

/**
 * Never rewinds below the snapshot's cursor: the engine builds each open item's
 * prefix through that cursor (`openItemPrefix`), so a lower watermark means no
 * delta arrived in between.
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
  /** Absent from engines that don't mint one. */
  etag?: string;
  /** Nothing moved; `events` is empty but the caller must keep what it has. */
  unchanged?: true;
}> {
  // Conditional request for the first page only, when there's a tag to spend.
  if (api.eventsIfChanged && etag) {
    const asked = await api.eventsIfChanged(sessionId, after, etag);
    if (asked.unchanged) return { events: [], cursor: after, unchanged: true, ...(asked.etag ? { etag: asked.etag } : {}) };
    // May be the first of several pages.
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
  const page = await drainEvents(api, sessionId, after);
  return {
    events: page.events,
    cursor: Math.max(after, page.cursor),
    ...(needsSessionSnapshot(page.events) ? { snapshot: await api.session(sessionId, window) } : {}),
  };
}

export type SnapshotRows = { turns: Turn[]; items: Item[]; tasks: Task[] };
export type OlderPage = SnapshotRows & { page?: SnapshotPage };

export async function loadOlderTurns(api: SessionSyncApi, sessionId: string, before: string): Promise<OlderPage> {
  const snapshot = await api.session(sessionId, { turns: OLDER_PAGE_TURNS, before });
  return { turns: snapshot.turns, items: snapshot.items, tasks: snapshot.tasks, page: snapshot.page };
}

/** Union by id: `fresh` wins collisions; `older`-only rows are prepended in order. */
export function mergeRows<T>(older: T[], fresh: T[], id: (row: T) => string): T[] {
  const carried = new Set(fresh.map(id));
  const merged = [...older.filter((row) => !carried.has(id(row))), ...fresh];
  // An unchanged merge returns `older` itself so React bails out of the re-render.
  // Identity, not equality: rows come off `JSON.parse`.
  if (merged.length !== older.length) return merged;
  for (let index = 0; index < merged.length; index += 1) if (merged[index] !== older[index]) return merged;
  return older;
}

/** Dedupes by id since a page boundary can shift under a live session; current rows win. */
export function mergeOlderPage(current: SnapshotRows, page: SnapshotRows): SnapshotRows {
  return {
    turns: mergeRows(page.turns, current.turns, (turn) => turn.runId),
    items: mergeRows(page.items, current.items, (item) => item.id),
    tasks: mergeRows(page.tasks, current.tasks, (task) => task.id),
  };
}
