// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  applySessionRuntimeEvent,
  createSessionRuntimeProjectionStore,
  sessionRuntimeProjectionFromSnapshot,
  type ProjectionBatchScheduler,
  type SessionRuntimeEvent,
  type SessionRuntimeSnapshot,
} from "./session-runtime-projection";

const snapshot = (overrides: Partial<SessionRuntimeSnapshot> = {}): SessionRuntimeSnapshot => ({
  sessionId: "s1",
  revision: 4,
  cursor: 10,
  queue: [
    { id: "q1", status: "running", text: "first" },
    { id: "q2", status: "queued", text: "second" },
  ],
  agents: [{ id: "a1", status: "running", name: "Scout" }],
  streams: [{ id: "main", kind: "text", text: "Hi", done: false }],
  ...overrides,
});

const event = <T extends SessionRuntimeEvent>(
  value: Omit<T, "sessionId" | "cursor" | "revision"> &
    Partial<Pick<T, "sessionId" | "cursor" | "revision">>,
): T => ({ sessionId: "s1", cursor: 11, revision: 5, ...value } as T);

describe("sessionRuntimeProjectionFromSnapshot", () => {
  test("normalizes queue, agents, and streams while preserving server order", () => {
    const projection = sessionRuntimeProjectionFromSnapshot(snapshot());
    expect(projection.queue.order).toEqual(["q1", "q2"]);
    expect(projection.queue.byId.q2.text).toBe("second");
    expect(projection.agents.order).toEqual(["a1"]);
    expect(projection.agents.byId.a1.status).toBe("running");
    expect(projection.streams.byId.main.text).toBe("Hi");
  });

  test("deduplicates repeated ids with latest data and first position", () => {
    const projection = sessionRuntimeProjectionFromSnapshot(snapshot({
      queue: [
        { id: "q1", status: "queued", text: "old" },
        { id: "q1", status: "failed", text: "new" },
      ],
    }));
    expect(projection.queue.order).toEqual(["q1"]);
    expect(projection.queue.byId.q1).toMatchObject({ status: "failed", text: "new" });
  });
});

describe("applySessionRuntimeEvent", () => {
  test("upserts and explicitly reorders authoritative queue items", () => {
    const initial = sessionRuntimeProjectionFromSnapshot(snapshot());
    const added = applySessionRuntimeEvent(initial, event({
      type: "queue.upsert",
      payload: { item: { id: "q3", status: "accepted", text: "third" }, index: 1 },
    }));
    expect(added.kind).toBe("applied");
    if (added.kind !== "applied") throw new Error("expected applied");
    expect(added.projection.queue.order).toEqual(["q1", "q3", "q2"]);

    const reordered = applySessionRuntimeEvent(added.projection, event({
      cursor: 12,
      revision: 5,
      type: "queue.reorder",
      payload: { order: ["q2", "unknown", "q2"] },
    }));
    expect(reordered.kind).toBe("applied");
    if (reordered.kind !== "applied") throw new Error("expected applied");
    expect(reordered.projection.queue.order).toEqual(["q2", "q1", "q3"]);
  });

  test("removes queue and agent entries only on explicit engine events", () => {
    const initial = sessionRuntimeProjectionFromSnapshot(snapshot());
    const queueRemoved = applySessionRuntimeEvent(initial, event({
      type: "queue.remove",
      payload: { id: "q1" },
    }));
    if (queueRemoved.kind !== "applied") throw new Error("expected applied");
    const agentRemoved = applySessionRuntimeEvent(queueRemoved.projection, event({
      cursor: 12,
      revision: 5,
      type: "agent.remove",
      payload: { id: "a1" },
    }));
    if (agentRemoved.kind !== "applied") throw new Error("expected applied");
    expect(queueRemoved.projection.queue.order).toEqual(["q2"]);
    expect(agentRemoved.projection.agents.order).toEqual([]);
  });

  test("makes replayed cursors idempotent without changing object identity", () => {
    const initial = sessionRuntimeProjectionFromSnapshot(snapshot());
    const duplicate = applySessionRuntimeEvent(initial, event({
      cursor: 10,
      revision: 4,
      type: "agent.remove",
      payload: { id: "a1" },
    }));
    expect(duplicate.kind).toBe("duplicate");
    expect(duplicate.projection).toBe(initial);
    expect(duplicate.projection.agents.order).toEqual(["a1"]);
  });

  test("detects cursor, revision, and session gaps without mutation", () => {
    const initial = sessionRuntimeProjectionFromSnapshot(snapshot());
    const cursorGap = applySessionRuntimeEvent(initial, event({
      cursor: 13,
      type: "agent.remove",
      payload: { id: "a1" },
    }));
    const revisionGap = applySessionRuntimeEvent(initial, event({
      revision: 8,
      type: "agent.remove",
      payload: { id: "a1" },
    }));
    const sessionGap = applySessionRuntimeEvent(initial, event({
      sessionId: "other",
      type: "agent.remove",
      payload: { id: "a1" },
    }));
    expect(cursorGap).toMatchObject({ kind: "gap", reason: "cursor", expected: 11, received: 13 });
    expect(revisionGap).toMatchObject({ kind: "gap", reason: "revision", expected: 5, received: 8 });
    expect(sessionGap).toMatchObject({ kind: "gap", reason: "session", expected: "s1", received: "other" });
    expect(cursorGap.projection).toBe(initial);
  });

  test("accumulates token deltas in a normalized stream", () => {
    const initial = sessionRuntimeProjectionFromSnapshot(snapshot());
    const result = applySessionRuntimeEvent(initial, event({
      type: "stream.delta",
      payload: { id: "main", text: " there" },
    }));
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied");
    expect(result.projection.streams.byId.main.text).toBe("Hi there");
    expect(result.projection.streams.order).toEqual(["main"]);
  });
});

function manualScheduler() {
  let pending: (() => void) | null = null;
  let cancelled = 0;
  const scheduler: ProjectionBatchScheduler = {
    schedule(flush) {
      pending = flush;
      return () => {
        pending = null;
        cancelled += 1;
      };
    },
  };
  return {
    scheduler,
    run: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    hasPending: () => pending !== null,
    cancelled: () => cancelled,
  };
}

describe("createSessionRuntimeProjectionStore", () => {
  test("batches token notifications while advancing cursor synchronously", () => {
    const batch = manualScheduler();
    const store = createSessionRuntimeProjectionStore(snapshot(), { scheduler: batch.scheduler });
    let notifications = 0;
    store.subscribe(() => notifications++);

    store.apply(event({ type: "stream.delta", payload: { id: "main", text: "!" } }));
    store.apply(event({
      cursor: 12,
      revision: 5,
      type: "stream.delta",
      payload: { id: "main", text: "!" },
    }));

    expect(store.getSnapshot().cursor).toBe(12);
    expect(store.getSnapshot().streams.byId.main.text).toBe("Hi!!");
    expect(notifications).toBe(0);
    expect(batch.hasPending()).toBe(true);
    batch.run();
    expect(notifications).toBe(1);
  });

  test("a structural event publishes the pending delta and latest state once", () => {
    const batch = manualScheduler();
    const store = createSessionRuntimeProjectionStore(snapshot(), { scheduler: batch.scheduler });
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.apply(event({ type: "stream.delta", payload: { id: "main", text: "!" } }));
    store.apply(event({
      cursor: 12,
      revision: 5,
      type: "agent.upsert",
      payload: { agent: { id: "a2", status: "running", name: "Builder" } },
    }));
    expect(notifications).toBe(1);
    expect(batch.cancelled()).toBe(1);
    expect(store.getSnapshot().agents.order).toEqual(["a1", "a2"]);
    batch.run();
    expect(notifications).toBe(1);
  });

  test("reports gaps and waits for snapshot replacement", () => {
    const gaps: string[] = [];
    const store = createSessionRuntimeProjectionStore(snapshot(), {
      onGap: (gap) => gaps.push(gap.reason),
    });
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.apply(event({
      cursor: 99,
      type: "queue.remove",
      payload: { id: "q1" },
    }));
    expect(gaps).toEqual(["cursor"]);
    expect(notifications).toBe(0);
    expect(store.getSnapshot().cursor).toBe(10);

    store.replaceSnapshot(snapshot({ revision: 9, cursor: 99, queue: [] }));
    expect(notifications).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 9, cursor: 99 });
    expect(store.getSnapshot().queue.order).toEqual([]);
  });
});
