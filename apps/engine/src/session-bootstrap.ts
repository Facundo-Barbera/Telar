import type {
  EngineEvent,
  EngineRequest,
  Item,
  Session,
  SessionAssignment,
  SessionSnapshot,
  Subscription,
  Task,
  Turn,
} from "@telar/engine-client";

/**
 * EVERYTHING A COCKPIT NEEDS TO OPEN A CONVERSATION, IN ONE READ (#407).
 *
 * A cockpit opening a session used to ask three times: the snapshot, then the
 * journal tail from the cursor the snapshot stamped, then — once the Agents
 * panel showed — this session's subscriptions. The second is the expensive part
 * of the shape rather than of the payload: it cannot be sent until the first
 * has come back, because its `after` IS the first answer's cursor. So the two
 * reads are strictly serial, and every hop between a cockpit and this engine is
 * paid twice: browser → Next route handler → engine, there and back.
 *
 * The engine already holds both halves at the same instant, so it can answer
 * both from one read and the serialisation disappears. `subscriptions` rides
 * along for the same reason `assignments` already rides the snapshot: it is a
 * small, session-scoped fold the opening screen wants and a separate round trip
 * is the only thing that made it expensive.
 *
 * THE FOLD LIVES HERE, NOT IN THE ROUTE, so it can be tested without a socket
 * and so `GET /v2/sessions/:id` and `GET /v2/sessions/:id/bootstrap` cannot
 * drift into two different snapshots — the second is the first plus two keys.
 */

/**
 * The store, as this fold uses it. Structural on purpose: the real
 * `EngineState` satisfies it, and a test can hand over a stub without building
 * a store on disk.
 */
export type SessionBootstrapStore = {
  eventCursor(sessionId: string): number;
  getSession(sessionId: string): Session;
  turns(sessionId: string): Turn[];
  items(sessionId: string): Item[];
  tasks(sessionId: string): Task[];
  /** Bounded for the snapshot — every open request, plus a tail of settled
   *  ones (#245). `requests()` itself stays whole for callers that want it. */
  snapshotRequests(sessionId: string): EngineRequest[];
  snapshotWindow(
    sessionId: string,
    window: { limit: number; before?: string },
  ): { turns: Turn[]; items: Item[]; tasks: Task[]; requests: EngineRequest[]; page: { before: string | null; more: boolean } };
  openItemPrefix(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined;
  sessionAssignments(sessionId: string): SessionAssignment[];
  subscriptionsFor(subscriberSessionId: string): Subscription[];
  readEvents(sessionId: string, after?: number): EngineEvent[];
};

/** `?turns=N[&before=runId]`, already validated by the caller. */
export type SessionBootstrapWindow = { turns: number; before?: string };

/** What `GET /v2/sessions/:id/bootstrap` answers with. */
export type SessionBootstrapPayload = SessionSnapshot & {
  /**
   * The journal from the snapshot's own cursor. Empty on a quiet session, which
   * is the ordinary case and the point: the client no longer pays a round trip
   * to be told nothing happened since the snapshot it is holding.
   */
  events: EngineEvent[];
  /** Who this conversation has asked to be woken by. */
  subscriptions: Subscription[];
};

/**
 * The snapshot `GET /v2/sessions/:id` answers with.
 *
 * READ THE CURSOR FIRST — it is the rule the route has always followed and the
 * reason this function reads it rather than taking it. A cursor read AFTER the
 * snapshot could name an event whose effect the snapshot does not carry, and
 * the client would skip it forever. Read before, the worst case is one event
 * replayed onto a snapshot that already has it, which the fold is built for.
 */
export function sessionSnapshot(
  store: SessionBootstrapStore,
  sessionId: string,
  window?: SessionBootstrapWindow,
): SessionSnapshot {
  const cursor = store.eventCursor(sessionId);
  const rows =
    window === undefined
      ? {
          turns: store.turns(sessionId),
          items: store.items(sessionId),
          // On the snapshot rather than behind its own route: a background task
          // outlives its turn, so "is this session still working" must be
          // answerable from the FIRST fetch of a cold session, before any event
          // has streamed.
          tasks: store.tasks(sessionId),
          requests: store.snapshotRequests(sessionId),
        }
      : store.snapshotWindow(sessionId, { limit: window.turns, ...(window.before === undefined ? {} : { before: window.before }) });
  /**
   * AN OPEN ITEM CARRIES WHAT IT HAS STREAMED (#214).
   *
   * `detail` is only filled in when an item closes, so without this a client
   * opening mid-reply saw an empty row and then only the text that arrived
   * after it looked. Bounded by the SAME cursor read above, so the prefix and
   * the tail meet exactly: never a gap, and any overlap is rejected by the
   * watermark that travels with it.
   */
  const items = rows.items.map((item) => {
    if (item.status !== "inProgress") return item;
    const prefix = store.openItemPrefix(sessionId, item.id, cursor);
    return prefix ? { ...item, ...prefix } : item;
  });
  return {
    cursor,
    session: store.getSession(sessionId),
    ...rows,
    items,
    // Folded over the WHOLE queue, not the window above: a client paging its
    // transcript must not have to guess at a carrier it cannot see.
    assignments: store.sessionAssignments(sessionId),
  };
}

/**
 * The snapshot, the journal from its cursor, and this session's subscriptions.
 *
 * THE ORDER IS THE CONTRACT. `events` is read AFTER the snapshot and from the
 * cursor the snapshot carries, so the two meet with an overlap at worst and
 * never a gap — the same guarantee `hydrateSession` used to buy with a second
 * request. A client's cursor after applying this is
 * `max(snapshot.cursor, last event id)`, exactly as before.
 */
export function sessionBootstrap(
  store: SessionBootstrapStore,
  sessionId: string,
  window?: SessionBootstrapWindow,
): SessionBootstrapPayload {
  const snapshot = sessionSnapshot(store, sessionId, window);
  return {
    ...snapshot,
    events: store.readEvents(sessionId, snapshot.cursor ?? 0),
    subscriptions: store.subscriptionsFor(sessionId),
  };
}
