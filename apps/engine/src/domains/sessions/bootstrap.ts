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
  eventCursor(sessionId: string): number;
  getSession(sessionId: string): Session;
  turns(sessionId: string): Turn[];
  items(sessionId: string): Item[];
  tasks(sessionId: string): Task[];
  snapshotRequests(sessionId: string): EngineRequest[];
  snapshotWindow(
    sessionId: string,
    window: { limit: number; before?: string },
  ): { turns: Turn[]; items: Item[]; tasks: Task[]; requests: EngineRequest[]; page: { before: string | null; more: boolean; total?: number } };
  openItemPrefix(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined;
  sessionAssignments(sessionId: string): SessionAssignment[];
  subscriptionsFor(subscriberSessionId: string): Subscription[];
  readEvents(sessionId: string, after?: number): EngineEvent[];
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
  const cursor = store.eventCursor(sessionId);
  const rows =
    window === undefined
      ? {
          turns: store.turns(sessionId),
          items: store.items(sessionId),
          tasks: store.tasks(sessionId),
          requests: store.snapshotRequests(sessionId),
        }
      : store.snapshotWindow(sessionId, { limit: window.turns, ...(window.before === undefined ? {} : { before: window.before }) });
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
    assignments: store.sessionAssignments(sessionId),
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
    events: store.readEvents(sessionId, snapshot.cursor ?? 0),
    subscriptions: store.subscriptionsFor(sessionId),
  };
}
