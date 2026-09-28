import { expect, test } from "bun:test";
import type { SessionSnapshot, EngineEvent } from "@telar/engine-client";
import { SessionConnection, sessionConnection } from "./session-connection";
const initial = { session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 3 } as unknown as SessionSnapshot;
test("surface reads share one hydration and an outage retains projection and cursor atomically", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let failed = false;
  const api = { session: async () => { reads++; await barrier; return initial; }, events: async () => {
    if (failed) throw new Error("disconnected");
    return { events: [] as EngineEvent[] };
  } };
  const connection = new SessionConnection(api, "session_1");
  const first = connection.read();
  const second = connection.read();
  expect(first).toBe(second);
  release();
  await first;
  expect(reads).toBe(1);
  failed = true;
  await expect(connection.read()).rejects.toThrow("disconnected");
  expect(connection.peek()?.cursor).toBe(3);
  expect(connection.peek()?.session).toEqual(initial.session);
  expect(sessionConnection("host_a", api, "session_1")).toBe(sessionConnection("host_a", api, "session_1"));
  expect(sessionConnection("host_b", api, "session_1")).not.toBe(sessionConnection("host_a", api, "session_1"));
});
test("a companion snapshot ahead of the tail installs its cursor and excludes reflected events", async () => {
  let reads = 0;
  let eventReads = 0;
  const event = { id: 4, type: "turn.stopped", sessionId: "session_1", runId: "run_1", at: 1 } as EngineEvent;
  const connection = new SessionConnection({
    session: async () => ({ ...initial, cursor: ++reads === 1 ? 3 : 5 }),
    events: async () => ({ events: ++eventReads === 1 ? [] : [event] }),
  }, "session_1");
  await connection.read();
  const next = await connection.read();
  expect(next.cursor).toBe(5);
  expect(next.events).toEqual([]);
});

test("a task whose turn left the snapshot window still ends when its completion arrives on the tail", async () => {
  const running = { id: "task_1", sessionId: "session_1", runId: "run_old", kind: "background", backgrounded: true, state: "running", startedAt: 1, updatedAt: 1 };
  const ended = { ...running, state: "completed", updatedAt: 3, completedAt: 3 };
  const stale = { ...running, state: "running", updatedAt: 2 };
  const pages: EngineEvent[][] = [
    [],
    [{ id: 4, type: "task.completed", sessionId: "session_1", runId: "run_new", at: 3, task: ended } as EngineEvent],
    [{ id: 5, type: "task.progress", sessionId: "session_1", runId: "run_new", at: 2, task: stale } as EngineEvent],
  ];
  let reads = 0;
  const connection = new SessionConnection({
    session: async () => ({ ...initial, tasks: reads++ === 0 ? [running] : [] }) as unknown as SessionSnapshot,
    events: async () => ({ events: pages.shift() ?? [] }),
  }, "session_1");
  expect((await connection.read()).tasks.map((task) => task.state)).toEqual(["running"]);
  expect((await connection.read()).tasks.map((task) => task.state)).toEqual(["completed"]);
  expect((await connection.read()).tasks.map((task) => task.state)).toEqual(["completed"]);
});

test("Swift and web consume the same engine-produced OpenCode prefix fixture", async () => {
  const { Session, Item, Turn } = await import("@telar/engine-client");
  const { projectJournal } = await import("./journal");
  const { itemText } = await import("./journal-items");
  const raw = await import("../../../../ios/TelarMobileTests/Fixtures/engine-revision.json");
  const snapshot = { ...raw.default, session: Session.parse(raw.default.session), items: raw.default.items.map((item) => Item.parse(item)), turns: raw.default.turns.map((turn) => Turn.parse(turn)) };
  expect(snapshot.session.driver).toBe("opencode");
  expect(snapshot.turns[1]?.state).toBe("queued");
  const transcript = projectJournal(snapshot.turns, snapshot.items, [], snapshot.tasks);
  expect(itemText(transcript[0]!.items[0]!)).toBe("Hello");
});
