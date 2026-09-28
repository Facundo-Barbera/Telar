import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { sessionBootstrap, type SessionBootstrapStore } from "./bootstrap";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bootstrap-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready() {
  const daemon = await startEngine({ engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.createSession({ id: "session_two", projectId: "project_one" });
  await client.registerWorker("worker_one");
  return { daemon, client, store: daemon.store };
}

function settle(store: EngineDaemon["store"], sessionId: string, runId: string) {
  const queue = (store as never as { readQueue(id: string): { turns: { runId: string; state: string; completedAt?: number }[] } }).readQueue(sessionId);
  const turn = queue.turns.find((candidate) => candidate.runId === runId)!;
  turn.state = "completed";
  turn.completedAt = 5_000;
  (store as never as { writeQueue(id: string, queue: unknown): void }).writeQueue(sessionId, queue);
}

test("the bootstrap IS the snapshot, plus the journal and the subscriptions", async () => {
  const { client, store } = await ready();
  for (let index = 0; index < 4; index += 1) {
    store.intake.submitTurn("session_one", { runId: `run_${index}`, input: `message ${index}` });
    settle(store, "session_one", `run_${index}`);
  }
  await client.subscribe("session_one", { targetSessionId: "session_two" });

  const snapshot = await client.session("session_one");
  const { events, subscriptions, ...opened } = await client.sessionBootstrap("session_one");

  expect({ ...opened, cursor: 0 }).toEqual({ ...snapshot, cursor: 0 });
  expect(opened.cursor ?? 0).toBeGreaterThanOrEqual(snapshot.cursor ?? 0);
  expect(opened.turns).toHaveLength(4);

  expect(subscriptions).toHaveLength(1);
  expect(subscriptions[0]).toMatchObject({ subscriberSessionId: "session_one", targetSessionId: "session_two" });

  expect(events).toEqual([]);
  expect((await client.events("session_one", 0)).events.length).toBeGreaterThan(0);
});

test("a bootstrap taken with work above the cursor carries it, and never a gap", async () => {
  const { client, store } = await ready();
  store.intake.submitTurn("session_one", { runId: "run_old", input: "settled" });
  settle(store, "session_one", "run_old");

  const first = await client.sessionBootstrap("session_one");
  store.intake.submitTurn("session_one", { runId: "run_new", input: "later" });

  const second = await client.sessionBootstrap("session_one");
  expect(second.cursor ?? 0).toBeGreaterThan(first.cursor ?? 0);
  for (const event of second.events) expect(event.id).toBeGreaterThan(second.cursor ?? 0);
  expect(second.turns.some((turn) => turn.runId === "run_new")).toBe(true);
});

test("the window and its refusals are the snapshot route's, not a second set", async () => {
  const { client, store } = await ready();
  for (let index = 0; index < 6; index += 1) {
    store.intake.submitTurn("session_one", { runId: `run_${index}`, input: `message ${index}` });
    settle(store, "session_one", `run_${index}`);
  }

  const windowed = await client.sessionBootstrap("session_one", { turns: 2 });
  expect(windowed.turns).toHaveLength(2);
  expect(windowed.page).toMatchObject({ more: true });

  const page = await client.sessionBootstrap("session_one", { turns: 2, before: windowed.page!.before! });
  expect(page.turns).toHaveLength(2);
  expect(page.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);

  await expect(client.request("GET", "/v2/sessions/session_one/bootstrap?before=run_2")).rejects.toBeInstanceOf(EngineClientError);
  await expect(client.request("GET", "/v2/sessions/session_one/bootstrap?turns=0")).rejects.toBeInstanceOf(EngineClientError);
});

test("an unknown session is a 404 here too, rather than an empty conversation", async () => {
  const { client } = await ready();
  await expect(client.sessionBootstrap("session_missing")).rejects.toBeInstanceOf(EngineClientError);
});

test("the cursor is read before the rows, and the journal after them", () => {
  const calls: string[] = [];
  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const session = { id: "session_one" } as never;
  const stub: SessionBootstrapStore = {
    records: { get: () => record("session", session) },
    queries: {
      eventCursor: () => record("cursor", 7),
      turns: () => record("turns", []),
      items: () => record("items", []),
      tasks: () => record("tasks", []),
      assignments: () => record("assignments", []),
      readEvents: (_id, after) => record(`events@${after}`, []),
      snapshotRequests: () => record("requests", []),
      snapshotWindow: () => record("window", { turns: [], items: [], tasks: [], requests: [], page: { before: null, more: false } }),
    },
    prefixes: { get: () => undefined },
    subscriptions: { subscriptionsFor: () => record("subscriptions", []) },
  };

  const payload = sessionBootstrap(stub, "session_one");
  expect(calls[0]).toBe("cursor");
  expect(calls.indexOf("events@7")).toBeGreaterThan(calls.indexOf("turns"));
  expect(payload.cursor).toBe(7);
  expect(payload.events).toEqual([]);
  expect(payload.subscriptions).toEqual([]);
});

test("an open item's prefix is stamped with the cursor the journal resumes from", () => {
  const open = { id: "item_1", runId: "run_1", sessionId: "session_one", status: "inProgress", startedAt: 1, detail: { type: "assistant_message", text: "" } };
  let askedThrough: number | undefined;
  const stub: SessionBootstrapStore = {
    records: { get: () => ({ id: "session_one" }) as never },
    queries: {
      eventCursor: () => 42,
      turns: () => [],
      items: () => [open as never],
      tasks: () => [],
      assignments: () => [],
      readEvents: () => [],
      snapshotRequests: () => [],
      snapshotWindow: () => ({ turns: [], items: [], tasks: [], requests: [], page: { before: null, more: false } }),
    },
    prefixes: {
      get: (_id, _itemId, through) => {
        askedThrough = through;
        return { streamed: "half a repl", streamedThrough: 40 };
      },
    },
    subscriptions: { subscriptionsFor: () => [] },
  };

  const payload = sessionBootstrap(stub, "session_one");
  expect(askedThrough).toBe(42);
  expect(payload.items[0]).toMatchObject({ streamed: "half a repl", streamedThrough: 40 });
});
