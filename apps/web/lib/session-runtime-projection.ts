/**
 * Framework-light client projection of the session runtime's authoritative
 * snapshot + ordered event feed.
 *
 * This module deliberately knows nothing about React, HTTP, SSE, or browser
 * persistence. The engine owns queue/agent truth; a UI may only replace this
 * projection from a snapshot and advance it with contiguous engine events.
 */

export type SessionQueueStatus =
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SessionQueueItem {
  id: string;
  clientMessageId?: string;
  status: SessionQueueStatus;
  text?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export type SessionAgentStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface SessionAgent {
  id: string;
  parentId?: string;
  name?: string;
  description?: string;
  status: SessionAgentStatus;
  activity?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SessionTextStream {
  id: string;
  parentId?: string;
  kind: "text" | "thinking";
  text: string;
  done: boolean;
}

export interface NormalizedCollection<T> {
  order: string[];
  byId: Record<string, T>;
}

export interface SessionRuntimeProjection {
  sessionId: string;
  /** Monotonic engine state revision. Several events may share a revision. */
  revision: number;
  /** Cursor of the last event incorporated into this projection. */
  cursor: number;
  queue: NormalizedCollection<SessionQueueItem>;
  agents: NormalizedCollection<SessionAgent>;
  streams: NormalizedCollection<SessionTextStream>;
}

export interface SessionRuntimeSnapshot {
  sessionId: string;
  revision: number;
  cursor: number;
  queue?: readonly SessionQueueItem[];
  agents?: readonly SessionAgent[];
  streams?: readonly SessionTextStream[];
}

type EventEnvelope<TType extends string, TPayload> = {
  sessionId: string;
  cursor: number;
  revision: number;
  type: TType;
  payload: TPayload;
};

export type SessionRuntimeEvent =
  | EventEnvelope<"queue.upsert", { item: SessionQueueItem; index?: number }>
  | EventEnvelope<"queue.remove", { id: string }>
  | EventEnvelope<"queue.reorder", { order: string[] }>
  | EventEnvelope<"agent.upsert", { agent: SessionAgent; index?: number }>
  | EventEnvelope<"agent.remove", { id: string }>
  | EventEnvelope<"stream.set", { stream: SessionTextStream; index?: number }>
  | EventEnvelope<
      "stream.delta",
      { id: string; text: string; parentId?: string; kind?: SessionTextStream["kind"] }
    >
  | EventEnvelope<"stream.remove", { id: string }>;

export type ProjectionGap = {
  kind: "gap";
  reason: "session" | "cursor" | "revision";
  expected: string | number;
  received: string | number;
  projection: SessionRuntimeProjection;
};

export type ProjectionApplyResult =
  | { kind: "applied"; projection: SessionRuntimeProjection }
  | { kind: "duplicate"; projection: SessionRuntimeProjection }
  | ProjectionGap;

function normalized<T extends { id: string }>(items: readonly T[]): NormalizedCollection<T> {
  const order: string[] = [];
  const byId: Record<string, T> = {};
  for (const item of items) {
    if (!Object.prototype.hasOwnProperty.call(byId, item.id)) order.push(item.id);
    byId[item.id] = item;
  }
  return { order, byId };
}

export function sessionRuntimeProjectionFromSnapshot(
  snapshot: SessionRuntimeSnapshot,
): SessionRuntimeProjection {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    cursor: snapshot.cursor,
    queue: normalized(snapshot.queue ?? []),
    agents: normalized(snapshot.agents ?? []),
    streams: normalized(snapshot.streams ?? []),
  };
}

function upsert<T extends { id: string }>(
  collection: NormalizedCollection<T>,
  item: T,
  index?: number,
): NormalizedCollection<T> {
  const exists = Object.prototype.hasOwnProperty.call(collection.byId, item.id);
  let order = collection.order;
  if (!exists) {
    order = [...order];
    const insertion = index === undefined
      ? order.length
      : Math.max(0, Math.min(Math.trunc(index), order.length));
    order.splice(insertion, 0, item.id);
  }
  return { order, byId: { ...collection.byId, [item.id]: item } };
}

function remove<T>(collection: NormalizedCollection<T>, id: string): NormalizedCollection<T> {
  if (!Object.prototype.hasOwnProperty.call(collection.byId, id)) return collection;
  const byId = { ...collection.byId };
  delete byId[id];
  return { order: collection.order.filter((candidate) => candidate !== id), byId };
}

function reorder<T>(collection: NormalizedCollection<T>, requested: readonly string[]) {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of requested) {
    if (seen.has(id) || !Object.prototype.hasOwnProperty.call(collection.byId, id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of collection.order) {
    if (!seen.has(id)) order.push(id);
  }
  return { ...collection, order };
}

/**
 * Apply one authoritative event. Duplicate/replayed cursors are harmless no-ops;
 * a missing cursor or revision is reported without mutating the projection so a
 * transport can fetch a fresh snapshot before continuing.
 */
export function applySessionRuntimeEvent(
  projection: SessionRuntimeProjection,
  event: SessionRuntimeEvent,
): ProjectionApplyResult {
  if (event.sessionId !== projection.sessionId) {
    return {
      kind: "gap",
      reason: "session",
      expected: projection.sessionId,
      received: event.sessionId,
      projection,
    };
  }
  if (event.cursor <= projection.cursor) return { kind: "duplicate", projection };
  if (event.cursor !== projection.cursor + 1) {
    return {
      kind: "gap",
      reason: "cursor",
      expected: projection.cursor + 1,
      received: event.cursor,
      projection,
    };
  }
  if (event.revision < projection.revision || event.revision > projection.revision + 1) {
    return {
      kind: "gap",
      reason: "revision",
      expected: event.revision < projection.revision
        ? projection.revision
        : projection.revision + 1,
      received: event.revision,
      projection,
    };
  }

  let queue = projection.queue;
  let agents = projection.agents;
  let streams = projection.streams;
  switch (event.type) {
    case "queue.upsert":
      queue = upsert(queue, event.payload.item, event.payload.index);
      break;
    case "queue.remove":
      queue = remove(queue, event.payload.id);
      break;
    case "queue.reorder":
      queue = reorder(queue, event.payload.order);
      break;
    case "agent.upsert":
      agents = upsert(agents, event.payload.agent, event.payload.index);
      break;
    case "agent.remove":
      agents = remove(agents, event.payload.id);
      break;
    case "stream.set":
      streams = upsert(streams, event.payload.stream, event.payload.index);
      break;
    case "stream.delta": {
      const current = streams.byId[event.payload.id];
      streams = upsert(streams, {
        id: event.payload.id,
        parentId: event.payload.parentId ?? current?.parentId,
        kind: event.payload.kind ?? current?.kind ?? "text",
        text: (current?.text ?? "") + event.payload.text,
        done: false,
      });
      break;
    }
    case "stream.remove":
      streams = remove(streams, event.payload.id);
      break;
  }

  return {
    kind: "applied",
    projection: {
      ...projection,
      revision: event.revision,
      cursor: event.cursor,
      queue,
      agents,
      streams,
    },
  };
}

export interface ProjectionBatchScheduler {
  /** Schedule one notification batch and return its cancellation function. */
  schedule: (flush: () => void) => () => void;
}

function animationFrameScheduler(): ProjectionBatchScheduler {
  return {
    schedule(flush) {
      if (typeof globalThis.requestAnimationFrame === "function") {
        const frame = globalThis.requestAnimationFrame(() => flush());
        return () => globalThis.cancelAnimationFrame(frame);
      }
      const timer = setTimeout(flush, 0);
      return () => clearTimeout(timer);
    },
  };
}

export interface SessionRuntimeProjectionStore {
  getSnapshot: () => SessionRuntimeProjection;
  subscribe: (listener: () => void) => () => void;
  apply: (event: SessionRuntimeEvent) => ProjectionApplyResult;
  replaceSnapshot: (snapshot: SessionRuntimeSnapshot) => SessionRuntimeProjection;
  /** Immediately publish a pending token-delta batch, if one exists. */
  flush: () => void;
  dispose: () => void;
}

function isProjection(
  value: SessionRuntimeSnapshot | SessionRuntimeProjection,
): value is SessionRuntimeProjection {
  const queue = value.queue;
  return !!queue && !Array.isArray(queue) && "byId" in queue;
}

/**
 * Store wrapper suitable for `useSyncExternalStore` or any other subscriber.
 * State advances synchronously for every event, preserving cursor correctness;
 * only subscriber notification for high-frequency token deltas is batched.
 */
export function createSessionRuntimeProjectionStore(
  initial: SessionRuntimeSnapshot | SessionRuntimeProjection,
  options: {
    scheduler?: ProjectionBatchScheduler;
    onGap?: (gap: ProjectionGap) => void;
  } = {},
): SessionRuntimeProjectionStore {
  let projection = isProjection(initial)
    ? initial
    : sessionRuntimeProjectionFromSnapshot(initial);
  const listeners = new Set<() => void>();
  const scheduler = options.scheduler ?? animationFrameScheduler();
  let cancelBatch: (() => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const cancelPending = () => {
    cancelBatch?.();
    cancelBatch = null;
  };
  const notifyNow = () => {
    cancelPending();
    notify();
  };
  const scheduleNotify = () => {
    if (cancelBatch) return;
    cancelBatch = scheduler.schedule(() => {
      cancelBatch = null;
      notify();
    });
  };

  return {
    getSnapshot: () => projection,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply(event) {
      const result = applySessionRuntimeEvent(projection, event);
      if (result.kind === "gap") {
        options.onGap?.(result);
        return result;
      }
      if (result.kind === "duplicate") return result;
      projection = result.projection;
      if (event.type === "stream.delta") scheduleNotify();
      else notifyNow();
      return result;
    },
    replaceSnapshot(snapshot) {
      projection = sessionRuntimeProjectionFromSnapshot(snapshot);
      notifyNow();
      return projection;
    },
    flush() {
      if (!cancelBatch) return;
      cancelPending();
      notify();
    },
    dispose() {
      cancelPending();
      listeners.clear();
    },
  };
}
