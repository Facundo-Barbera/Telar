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

export type SessionBootstrapStore = {
  records: { get(sessionId: string): Session };
  queries: {
    eventCursor(sessionId: string): number;
    turns(sessionId: string): Turn[];
    items(sessionId: string): Item[];
    tasks(sessionId: string): Task[];
    assignments(sessionId: string): SessionAssignment[];
    readEvents(sessionId: string, after?: number): EngineEvent[];
    snapshotRequests(sessionId: string): EngineRequest[];
    snapshotWindow(
      sessionId: string,
      window: { limit: number; before?: string },
    ): { turns: Turn[]; items: Item[]; tasks: Task[]; requests: EngineRequest[]; page: { before: string | null; more: boolean; total?: number } };
  };
  prefixes: { get(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined };
  subscriptions: { subscriptionsFor(subscriberSessionId: string): Subscription[] };
};

export type SessionBootstrapWindow = { turns: number; before?: string };

type SessionBootstrapPayload = SessionSnapshot & {
  events: EngineEvent[];
  subscriptions: Subscription[];
};

export function sessionSnapshot(
  store: SessionBootstrapStore,
  sessionId: string,
  window?: SessionBootstrapWindow,
): SessionSnapshot {
  const cursor = store.queries.eventCursor(sessionId);
  const rows =
    window === undefined
      ? {
          turns: store.queries.turns(sessionId),
          items: store.queries.items(sessionId),
          tasks: store.queries.tasks(sessionId),
          requests: store.queries.snapshotRequests(sessionId),
        }
      : store.queries.snapshotWindow(sessionId, { limit: window.turns, ...(window.before === undefined ? {} : { before: window.before }) });
  const items = rows.items.map((item) => {
    if (item.status !== "inProgress") return item;
    const prefix = store.prefixes.get(sessionId, item.id, cursor);
    return prefix ? { ...item, ...prefix } : item;
  });
  return {
    cursor,
    session: store.records.get(sessionId),
    ...rows,
    items,
    assignments: store.queries.assignments(sessionId),
  };
}

export function sessionBootstrap(
  store: SessionBootstrapStore,
  sessionId: string,
  window?: SessionBootstrapWindow,
): SessionBootstrapPayload {
  const snapshot = sessionSnapshot(store, sessionId, window);
  return {
    ...snapshot,
    events: store.queries.readEvents(sessionId, snapshot.cursor ?? 0),
    subscriptions: store.subscriptions.subscriptionsFor(sessionId),
  };
}
