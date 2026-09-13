/**
 * THE ONE-READ OPENING (#407).
 *
 * Two things have to be true of `/bootstrap`, and they are different kinds of
 * claim, so they are tested differently.
 *
 * IT IS THE SNAPSHOT, NOT A SECOND OPINION. Proved over the real wire against a
 * real store: the same session read both ways must answer with the same
 * snapshot, windowed the same way and rejecting the same bad input. A route
 * that drifted from `GET /v2/sessions/:id` would be a second definition of what
 * a conversation is, which is the failure this fold exists to prevent.
 *
 * ITS CURSOR AND ITS EVENTS MEET. That is an ORDERING claim about three reads
 * inside one function, and no amount of HTTP can observe it — so it is proved
 * against a stub store that records what was asked and when. Read the cursor
 * after the snapshot instead of before and the client skips an event forever;
 * nothing else in the suite would notice.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { sessionBootstrap, type SessionBootstrapStore } from "../src/session-bootstrap";

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

/** Settle a turn so it leaves the unsettled set and becomes pageable. */
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
    store.submitTurn("session_one", { runId: `run_${index}`, input: `message ${index}` });
    settle(store, "session_one", `run_${index}`);
  }
  await client.subscribe("session_one", { targetSessionId: "session_two" });

  const snapshot = await client.session("session_one");
  const { events, subscriptions, ...opened } = await client.sessionBootstrap("session_one");

  // The same conversation, described the same way. `cursor` is read live and
  // may legitimately have moved between the two calls, so it is compared
  // separately — it must not have gone BACKWARDS.
  expect({ ...opened, cursor: 0 }).toEqual({ ...snapshot, cursor: 0 });
  expect(opened.cursor ?? 0).toBeGreaterThanOrEqual(snapshot.cursor ?? 0);
  expect(opened.turns).toHaveLength(4);

  expect(subscriptions).toHaveLength(1);
  expect(subscriptions[0]).toMatchObject({ subscriberSessionId: "session_one", targetSessionId: "session_two" });

  /**
   * THE JOURNAL IS NOT REPLAYED. The snapshot already says everything those
   * four settled turns will ever say, so the tail that comes with it is the
   * part above its cursor — which on a quiet session is nothing at all. The
   * whole journal is non-empty, which is what makes the assertion mean
   * something.
   */
  expect(events).toEqual([]);
  expect((await client.events("session_one", 0)).events.length).toBeGreaterThan(0);
});

test("a bootstrap taken with work above the cursor carries it, and never a gap", async () => {
  const { client, store } = await ready();
  store.submitTurn("session_one", { runId: "run_old", input: "settled" });
  settle(store, "session_one", "run_old");

  const first = await client.sessionBootstrap("session_one");
  // Something happens after that read — the case a second read has to close.
  store.submitTurn("session_one", { runId: "run_new", input: "later" });

  const second = await client.sessionBootstrap("session_one");
  expect(second.cursor ?? 0).toBeGreaterThan(first.cursor ?? 0);
  // Every event a client applies on top of the snapshot is one the snapshot
  // does not already reflect. Below that line is the snapshot's business.
  for (const event of second.events) expect(event.id).toBeGreaterThan(second.cursor ?? 0);
  // And nothing between the two reads went missing: the turn submitted above is
  // on the second snapshot, whether or not its event is on the tail.
  expect(second.turns.some((turn) => turn.runId === "run_new")).toBe(true);
});

test("the window and its refusals are the snapshot route's, not a second set", async () => {
  const { client, store } = await ready();
  for (let index = 0; index < 6; index += 1) {
    store.submitTurn("session_one", { runId: `run_${index}`, input: `message ${index}` });
    settle(store, "session_one", `run_${index}`);
  }

  const windowed = await client.sessionBootstrap("session_one", { turns: 2 });
  expect(windowed.turns).toHaveLength(2);
  expect(windowed.page).toMatchObject({ more: true });

  const page = await client.sessionBootstrap("session_one", { turns: 2, before: windowed.page!.before! });
  expect(page.turns).toHaveLength(2);
  expect(page.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);

  // `before` without `turns` is meaningless, and is refused here exactly as it
  // is on the snapshot route — the two share one parser.
  await expect(client.request("GET", "/v2/sessions/session_one/bootstrap?before=run_2")).rejects.toBeInstanceOf(EngineClientError);
  await expect(client.request("GET", "/v2/sessions/session_one/bootstrap?turns=0")).rejects.toBeInstanceOf(EngineClientError);
});

test("an unknown session is a 404 here too, rather than an empty conversation", async () => {
  const { client } = await ready();
  await expect(client.sessionBootstrap("session_missing")).rejects.toBeInstanceOf(EngineClientError);
});

/**
 * THE ORDERING, which no HTTP test can see.
 *
 * The cursor must be read BEFORE the rows and the journal AFTER them. Read the
 * other way round, a cursor could name an event whose effect the snapshot does
 * not carry — and since the client tails from that cursor, the event is skipped
 * forever rather than replayed.
 */
test("the cursor is read before the rows, and the journal after them", () => {
  const calls: string[] = [];
  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const session = { id: "session_one" } as never;
  const stub: SessionBootstrapStore = {
    eventCursor: () => record("cursor", 7),
    getSession: () => record("session", session),
    turns: () => record("turns", []),
    items: () => record("items", []),
    tasks: () => record("tasks", []),
    requests: () => record("requests", []),
    snapshotWindow: () => record("window", { turns: [], items: [], tasks: [], requests: [], page: { before: null, more: false } }),
    openItemPrefix: () => undefined,
    sessionAssignments: () => record("assignments", []),
    subscriptionsFor: () => record("subscriptions", []),
    readEvents: (_id, after) => record(`events@${after}`, []),
  };

  const payload = sessionBootstrap(stub, "session_one");
  expect(calls[0]).toBe("cursor");
  expect(calls.indexOf("events@7")).toBeGreaterThan(calls.indexOf("turns"));
  expect(payload.cursor).toBe(7);
  expect(payload.events).toEqual([]);
  expect(payload.subscriptions).toEqual([]);
});

/** An open item's streamed prefix is bounded by the SAME cursor the tail starts
 *  from, so the two meet exactly — the guarantee #214 bought and this route must
 *  not spend. */
test("an open item's prefix is stamped with the cursor the journal resumes from", () => {
  const open = { id: "item_1", runId: "run_1", sessionId: "session_one", status: "inProgress", startedAt: 1, detail: { type: "assistant_message", text: "" } };
  let askedThrough: number | undefined;
  const stub: SessionBootstrapStore = {
    eventCursor: () => 42,
    getSession: () => ({ id: "session_one" }) as never,
    turns: () => [],
    items: () => [open as never],
    tasks: () => [],
    requests: () => [],
    snapshotWindow: () => ({ turns: [], items: [], tasks: [], requests: [], page: { before: null, more: false } }),
    openItemPrefix: (_id, _itemId, through) => {
      askedThrough = through;
      return { streamed: "half a repl", streamedThrough: 40 };
    },
    sessionAssignments: () => [],
    subscriptionsFor: () => [],
    readEvents: () => [],
  };

  const payload = sessionBootstrap(stub, "session_one");
  expect(askedThrough).toBe(42);
  expect(payload.items[0]).toMatchObject({ streamed: "half a repl", streamedThrough: 40 });
});
