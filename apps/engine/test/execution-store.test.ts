import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContentStream, ItemDetail } from "@telar/engine-client";
import { ContentStream as ContentStreamSchema, ItemDetail as ItemDetailSchema } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { ExecutionStore } from "../src/execution-store";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function setup(storage: "json" | "sqlite" = "sqlite") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sqlite-")); homes.push(home);
  const store = new EngineStore(home, Date.now, { executionStorage: storage }); stores.push(store);
  store.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { home, store };
}
test("SQLite commits projections, events and a receipt together; a lost response is replayed", () => {
  const { store } = setup();
  const action = () => store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  const first = store.executeCommand("submit:session_one:run_one", action, "command_one");
  const cursor = store.eventCursor("session_one");
  const again = store.executeCommand("submit:session_one:run_one", () => { throw new Error("must not repeat"); }, "command_one");
  expect(again).toEqual(first);
  expect(store.eventCursor("session_one")).toBe(cursor);
  expect(store.turns("session_one")).toHaveLength(1);
});
test("an interrupted transaction rolls back both journal and queue and invalidates caches", () => {
  const { store } = setup();
  const before = store.eventCursor("session_one");
  expect(() => store.executeCommand("broken", () => {
    store.submitTurn("session_one", { runId: "run_rollback", input: "never accepted" });
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");
  expect(store.turns("session_one")).toEqual([]);
  expect(store.eventCursor("session_one")).toBe(before);
  store.submitTurn("session_one", { runId: "run_next", input: "after rollback" });
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_next");
});
test("migration preserves history, keeps a backup, and reopening cannot return to stale JSON", () => {
  const { store: original, home } = setup("json");
  original.submitTurn("session_one", { runId: "run_one", input: "keep me" });
  const migrated = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(migrated);
  expect(migrated.turns("session_one")[0]?.input).toBe("keep me");
  expect(fs.existsSync(path.join(home, "execution-json-backup", "session_one", "queue.json"))).toBe(true);
  migrated.stopSession("session_one");
  migrated.closeExecutionStore(); stores.splice(stores.indexOf(migrated), 1);
  expect(() => new EngineStore(home, Date.now, { executionStorage: "json" })).toThrow("migrated");
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_one")[0]?.state).toBe("stopped");
  expect(reopened.readEvents("session_one").some((event) => event.type === "turn.stopped")).toBe(true);
});

test("a replayed Stop receipt cannot cancel a new message submitted afterward", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_first", input: "first" });
  const stop = () => store.executeCommand("stop:session_one", () => store.stopSession("session_one"), "command_stop");
  stop();
  store.submitTurn("session_one", { runId: "run_new", input: "new instruction" });
  stop();
  expect(store.turns("session_one").find((turn) => turn.runId === "run_new")?.state).toBe("queued");
});

test("task-stop deliveries survive reopening and only their owner can acknowledge them", () => {
  const { store, home } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "watch" });
  const turn = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", turn.runId, turn.claim!.token);
  store.ingestObservations("session_one", turn.runId, turn.claim!.token, [{ kind: "task.started", task: {
    id: "task_one", kind: "background", state: "running", title: "watch", providerTaskId: "provider_one",
  } }]);
  store.stopSession("session_one");
  const pending = store.taskStopsForWorker("worker_one");
  expect(pending).toHaveLength(1);
  expect(store.taskStopsForWorker("worker_other", [pending[0]!.deliveryId!])).toEqual([]);
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.taskStopsForWorker("worker_one")).toEqual(pending);
  expect(reopened.taskStopsForWorker("worker_one", [pending[0]!.deliveryId!])).toEqual([]);
});

test("SIGKILL between projection and commit leaves no accepted turn or journal fragment", async () => {
  const { store, home } = setup();
  const cursor = store.eventCursor("session_one");
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const child = Bun.spawn([process.execPath, "-e", `
    import { EngineStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/state.ts"))};
    const store = new EngineStore(process.argv[1]);
    store.executeCommand("crash", () => {
      store.submitTurn("session_one", { runId: "run_crashed", input: "uncommitted" });
      process.kill(process.pid, "SIGKILL");
    });
  `, home], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.turns("session_one")).toEqual([]);
  expect(reopened.eventCursor("session_one")).toBe(cursor);
  reopened.submitTurn("session_one", { runId: "run_after", input: "still usable" });
  expect(reopened.claimTurn("session_one", "worker_after")?.runId).toBe("run_after");
});

test("export retains post-migration history and reopens in a JSON-only store", async () => {
  const { home, store } = setup();
  store.submitTurn("session_one", { runId: "run_export", input: "after migration" });
  store.stopSession("session_one");
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const destination = `${home}-export`; homes.push(destination);
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/export-execution.ts"), home, destination], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const exported = new EngineStore(destination, Date.now, { executionStorage: "json" }); stores.push(exported);
  expect(exported.turns("session_one")[0]?.state).toBe("stopped");
  expect(exported.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("internal command receipts do not retain resolved provider credentials", async () => {
  const { store, home } = setup();
  store.executeCommand("claim-like", () => {
    store.submitTurn("session_one", { runId: "run_private", input: "hello" });
    return { providerInstance: { env: [{ name: "API_KEY", value: "private-fixture-token" }] } };
  });
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(home, "execution.sqlite"));
  try { expect(JSON.stringify(db.query("SELECT result FROM receipts").all())).not.toContain("private-fixture-token"); }
  finally { db.close(); }
});

test("human Stop keeps agent traffic blocked across restart until a fresh human message", () => {
  const { home, store } = setup();
  store.executeCommand("stop", () => store.stopSession("session_one", "user"), "stop_guard");
  store.closeExecutionStore();
  const reopened = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(reopened);
  expect(() => reopened.submitAgentTurn("session_one", { runId: "run_noise", input: "checkpoint" })).toThrow("stopped by its user");
  expect(reopened.turns("session_one")).toHaveLength(0);
  reopened.submitTurn("session_one", { runId: "run_human", input: "new task" });
  reopened.executeCommand("stop", () => reopened.stopSession("session_one", "user"), "stop_guard");
  expect(reopened.getSession("session_one").agentMessagesBlocked).toBeUndefined();
  expect(reopened.submitAgentTurn("session_one", { runId: "run_fresh", input: "new report" }).replayed).toBe(false);
});

/**
 * A CACHED STATEMENT MUST NOT CARRY THE PREVIOUS CALL'S BINDINGS. Preparing
 * each query once is what stops sqlite recompiling the same seven statements
 * ten times a second, and the only way that can go wrong is a reused statement
 * answering for the row it was last run with — so this interleaves several
 * sessions through every cached path and demands each one's own answer back.
 */
test("statements reused across calls still answer for the row they were asked about", () => {
  const { store } = setup();
  for (const id of ["session_two", "session_three"]) store.createSession({ id, projectId: "project_one" });
  const sessions = ["session_one", "session_two", "session_three"];
  for (const sessionId of sessions) store.submitTurn(sessionId, { runId: `run_${sessionId}`, input: `text for ${sessionId}` });
  // Interleaved, and twice, so any statement is run against a different
  // session than the one that prepared it.
  for (let round = 0; round < 2; round += 1) {
    for (const sessionId of sessions) {
      expect(store.turns(sessionId).map((turn) => turn.input)).toEqual([`text for ${sessionId}`]);
      expect(store.eventCursor(sessionId)).toBeGreaterThan(0);
      expect(store.readEvents(sessionId).every((event) => event.sessionId === sessionId)).toBe(true);
    }
  }
  store.stopTurn("session_two", "run_session_two");
  store.deleteSession("session_two");
  expect(store.turns("session_one")).toHaveLength(1);
  expect(store.turns("session_three")).toHaveLength(1);
  expect(() => store.getSession("session_two")).toThrow();
});

/**
 * THE SCAN CACHE MUST NEVER OUTLIVE THE QUEUE IT DESCRIBES.
 *
 * Serving an unchanged queue from memory is what takes the worker heartbeat
 * from ten milliseconds to a tenth of one, and the only way it can be wrong is
 * by answering with a queue that has since moved. Each of these writes a queue
 * behind a scan that already ran and demands the new answer.
 */
test("a queue written after a scan is seen by the next scan", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  expect(store.claimTurn("session_one", "worker_one")?.runId).toBe("run_one");
  // Populates the cache while there is nothing to report.
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  store.stopSession("session_one", "user");
  expect(store.cancellationsForWorker("worker_one").map((cancel) => cancel.runId)).toEqual(["run_one"]);
});

test("a rolled-back stop is not reported to the worker that would have acted on it", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  expect(() => store.executeCommand("broken-stop", () => {
    store.stopSession("session_one", "user");
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");
  // The transaction took the stop back, so there is nothing to cancel — and
  // the turn is still the claimed one it was before.
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
  expect(store.turns("session_one").map((turn) => turn.state)).toEqual(["claimed"]);
});

test("a session id reused after a delete does not inherit the old queue", () => {
  const { store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  store.stopSession("session_one", "user");
  expect(store.cancellationsForWorker("worker_one")).toHaveLength(1);
  store.deleteSession("session_one");
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.turns("session_one")).toEqual([]);
  expect(store.cancellationsForWorker("worker_one")).toEqual([]);
});

/**
 * A DEAD CLAIM IS NOT FREE TO LEAVE LYING ABOUT.
 *
 * `stopSession` keeps the claim on a turn it stops so the worker holding it
 * hears about the stop — but the token names a registration, and none survives
 * a restart. Left there it is not inert: `queueConcernsAWorker` counts it, so
 * every Stop anybody ever pressed kept a session in the set the heartbeat
 * walks, for ever and across every restart.
 */
/**
 * A STREAMED DELTA IS WRITTEN ONCE FOR THE WHOLE BATCH, AND READS AS IF IT WERE
 * WRITTEN AT ONCE.
 *
 * A WAL fsync costs one transaction and the engine used to run one per
 * `ingestObservations`, so a delta at a time was an fsync per token-chunk.
 * The two halves of the fix are inseparable and both are asserted here: the
 * deltas do NOT reach the database as they arrive, and a reader cannot tell —
 * `readEvents` and `eventCursor` answer with the held ones, in order, with the
 * text intact. A second connection is what separates the two questions, because
 * it sees only what has actually been committed.
 */
function streamed(home: string): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(home, "execution.sqlite"), { readonly: true });
  try { return db.query("SELECT id,value FROM events WHERE session_id='session_one' ORDER BY id").all() as Array<Record<string, unknown>>; }
  finally { db.close(); }
}

test("deltas arriving in one tick are held, read back whole, and stored in a single write", () => {
  const { store, home } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.markRunning("session_one", turn.runId, token);
  store.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  const settledBefore = streamed(home).length;
  const cursorBefore = store.eventCursor("session_one");

  // Twenty deltas, one call each, all inside this tick — the shape a driver
  // reporting a chunk at a time produces.
  const chunks = Array.from({ length: 20 }, (_, n) => `chunk-${n} `);
  for (const text of chunks) {
    store.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  }

  // NOT ONE OF THEM IS ON DISK YET — that is the whole saving.
  expect(streamed(home)).toHaveLength(settledBefore);
  // …and no reader can tell. Every delta, in arrival order, contiguous ids.
  const read = store.readEvents("session_one", cursorBefore);
  expect(read.map((event) => (event as { text?: string }).text)).toEqual(chunks);
  expect(read.map((event) => event.id)).toEqual(chunks.map((_, n) => cursorBefore + 1 + n));
  expect(store.eventCursor("session_one")).toBe(cursorBefore + chunks.length);

  // The event that settles the item takes the batch to the disk with it, and
  // nothing may be stored ahead of the deltas it concludes.
  store.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.completed", itemId: "item_one", status: "completed", detail: { type: "assistant_message", text: chunks.join("") } },
  ]);
  const stored = streamed(home);
  expect(stored).toHaveLength(settledBefore + chunks.length + 1);
  expect(stored.map((row) => Number(row.id))).toEqual(stored.map((_, n) => n + 1));
  const deltas = stored.map((row) => JSON.parse(String(row.value)) as { type: string; text?: string }).filter((event) => event.type === "content.delta");
  expect(deltas.map((event) => event.text).join("")).toBe(chunks.join(""));
});

/**
 * UNFLUSHED DELTAS MAY BE LOST. A SETTLED TURN MAY NOT — and neither may a
 * delta that some earlier command already committed, just because a later one
 * failed on top of it.
 */
test("a failed command does not take already-accepted deltas with it", () => {
  const { store, home } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.markRunning("session_one", turn.runId, token);
  store.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  for (const text of ["held-one ", "held-two "]) {
    store.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  }
  const cursor = store.eventCursor("session_one");

  expect(() => store.executeCommand("broken", () => {
    store.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "rolled-back " }]);
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");

  // The rolled-back delta is gone; the two accepted before it are not.
  expect(store.eventCursor("session_one")).toBe(cursor);
  expect(store.readEvents("session_one").filter((event) => event.type === "content.delta")
    .map((event) => (event as { text?: string }).text)).toEqual(["held-one ", "held-two "]);

  // And a clean close is what puts them on the disk, ids still contiguous.
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const stored = streamed(home);
  expect(stored.map((row) => Number(row.id))).toEqual(stored.map((_, n) => n + 1));
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.readEvents("session_one").filter((event) => event.type === "content.delta")
    .map((event) => (event as { text?: string }).text)).toEqual(["held-one ", "held-two "]);
});

/**
 * THE DELTA PATH SKIPS THE TRANSACTION AND THE PROJECTION READS (#443) — AND
 * NOTHING ELSE.
 *
 * `ingestObservations` routes a batch of nothing but `content.delta` past
 * `executeCommand` and past `readItems`/`readTasks`/`readQueue`, because such a
 * batch writes no document and a delta asks the projection one question. Every
 * one of these is a way that shortcut could be WRONG, and each is the same
 * demand: the fast path must refuse, drop and order exactly as the command path
 * does. What the two paths agree about when nothing is wrong is already pinned
 * by "deltas arriving in one tick…" above.
 */
function streaming(): { store: EngineStore; home: string; runId: string; token: string } {
  const { store, home } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.markRunning("session_one", turn.runId, token);
  store.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  return { store, home, runId: turn.runId, token };
}
const deltas = (store: EngineStore): string[] =>
  store.readEvents("session_one").filter((event) => event.type === "content.delta").map((event) => (event as { text: string }).text);

test("a stream cannot outlive its turn, even though the delta path reads a shared queue", () => {
  const { store, runId, token } = streaming();
  const delta = (text: string) => () =>
    store.ingestObservations("session_one", runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  // The first one is what puts the queue in the shared cache the fast path
  // reads; the turn then settles behind it. A cache that outlived the write
  // would let this stream go on writing into a turn that is over.
  delta("live ")();
  store.completeTurn("session_one", runId, token, { text: "done" });
  expect(delta("late ")).toThrow(/already settled \(completed\)/);
  expect(deltas(store)).toEqual(["live "]);
});

test("a delta under a claim that is not the running one is refused and journals nothing", () => {
  const { store, runId } = streaming();
  expect(() =>
    store.ingestObservations("session_one", runId, "not-the-token-at-all", [
      { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "forged " },
    ]),
  ).toThrow(/not running under this worker claim/);
  expect(deltas(store)).toEqual([]);
});

test("one malformed delta refuses the whole batch, including the valid ones ahead of it", () => {
  const { store, runId, token } = streaming();
  expect(() =>
    store.ingestObservations("session_one", runId, token, [
      { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "accepted " },
      // Empty text is the one thing the schema refuses about a delta.
      { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "" },
    ]),
  ).toThrow(/observations are invalid/);
  expect(deltas(store)).toEqual([]);
});

test("a delta for an item that never opened is dropped, and one for an item opened mid-stream is not", () => {
  const { store, runId, token } = streaming();
  const say = (itemId: string, text: string) =>
    store.ingestObservations("session_one", runId, token, [{ kind: "content.delta", itemId, stream: "assistant_text", text }]);
  say("item_one", "one ");
  // No such item: accepted as a report, journalled as nothing — the same thing
  // the command path does with it.
  expect(say("item_two", "nowhere ")).toEqual({ accepted: 1 });
  expect(deltas(store)).toEqual(["one "]);

  // …and the cached projection must not make that verdict permanent: an item
  // opened AFTER the stream began has to be visible to the very next delta.
  store.ingestObservations("session_one", runId, token, [
    { kind: "item.started", item: { id: "item_two", detail: { type: "assistant_message", text: "" } } },
  ]);
  say("item_two", "two ");
  expect(deltas(store)).toEqual(["one ", "two "]);
});

/**
 * THE RECEIPTS NOTHING WILL EVER READ AGAIN (#457).
 *
 * A receipt makes a retried command id free instead of repeating it, which
 * matters for the seconds a client spends retrying a request whose response it
 * lost — and never again after that. The dogfood store held 299,323 of them in
 * 723 MB. So: they go after a week, on open and once a day, and the only thing
 * worth asserting about the table is the behaviour it buys — a receipt that is
 * still there replays its command, and a receipt that is gone runs it again.
 */
test("receipts outlive a retry and not a week; opening the store is itself a sweep", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-receipts-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.parse("2026-09-01T00:00:00Z");
  let ran = 0;
  const count = (store: ExecutionStore, commandId: string) => store.transaction("count", () => (ran += 1), commandId);

  let store = new ExecutionStore(root, { now: () => clock });
  try {
    expect(count(store, "command_old")).toBe(1);
    // The receipt is the whole point: the same id does not run twice.
    expect(count(store, "command_old")).toBe(1);
    expect(ran).toBe(1);

    clock += 8 * day;
    count(store, "command_fresh");
    expect(ran).toBe(2);
    // Everything past the week goes — the store's own `import` marker included,
    // which is why this is not a fixed number — and nothing is left behind it.
    expect(store.pruneReceipts()).toBeGreaterThan(0);
    expect(store.pruneReceipts()).toBe(0);
    count(store, "command_old");
    expect(ran).toBe(3);
    count(store, "command_fresh");
    expect(ran).toBe(3);
  } finally { store.close(); }

  // What the daemon does on start, with a week of receipts behind it.
  clock += 8 * day;
  store = new ExecutionStore(root, { now: () => clock });
  try {
    count(store, "command_fresh");
    expect(ran).toBe(4);
  } finally { store.close(); }
});

test("a restart retires the claim on a stopped turn without disturbing the session", () => {
  const { home, store } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });
  store.claimTurn("session_one", "worker_one");
  store.stopSession("session_one", "user");
  expect(store.turns("session_one")[0]?.claim?.workerId).toBe("worker_one");
  const before = store.getSession("session_one").updatedAt;
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);

  const reopened = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(reopened);
  reopened.recover(); // what the daemon runs at boot
  const turn = reopened.turns("session_one")[0]!;
  expect(turn.claim).toBeUndefined();
  // Only the token went. The turn still says what it was and how it ended,
  // and nothing about the session moved.
  expect(turn).toMatchObject({ runId: "run_one", input: "hello", state: "stopped", stopReason: "user" });
  expect(reopened.getSession("session_one").updatedAt).toBe(before);
  // And with no claim left, no worker is asked about this session again.
  expect(reopened.cancellationsForWorker("worker_one")).toEqual([]);
});

/**
 * ISSUE #457, STEP 4 — the JSON the import replaced does not live forever.
 *
 * `importLegacy` keeps a copy of everything it read, as an undo for a migration
 * that went wrong. Its value is in the days right after the migration: a store
 * read and written through sqlite for a week has diverged from that copy
 * completely, so restoring it would discard the week rather than recover it. On
 * the dogfood home it was 239 MB, months old, beside a 735 MB database.
 */
test("the pre-SQLite backup is kept for its week and then swept, and the sweep says what it took", () => {
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.now();
  const { store: original, home } = setup("json");
  original.submitTurn("session_one", { runId: "run_one", input: "keep me" });
  original.closeExecutionStore(); stores.splice(stores.indexOf(original), 1);

  // The migration itself, which is what writes the backup.
  const migrated = new EngineStore(home, Date.now, { executionStorage: "sqlite" }); stores.push(migrated);
  const backup = path.join(home, "execution-json-backup");
  expect(fs.existsSync(path.join(backup, "session_one", "queue.json"))).toBe(true);
  // INSIDE ITS WEEK IT STAYS, and the report says so rather than nothing: a
  // migration that went wrong this morning still has its undo.
  const held = migrated.executionHousekeeping()?.backup;
  expect(held?.removed).toBe(false);
  expect(held!.files).toBeGreaterThan(0);
  expect(held!.bytes).toBeGreaterThan(0);
  expect(fs.existsSync(backup)).toBe(true);
  migrated.closeExecutionStore(); stores.splice(stores.indexOf(migrated), 1);

  // A WEEK LATER, ON THE ORDINARY START. Not a command anybody has to know to
  // run: the backlog this exists for is on machines nobody is administering.
  clock += 8 * day;
  const swept = new ExecutionStore(home, { now: () => clock });
  try {
    const report = swept.housekeeping.backup;
    expect(report?.removed).toBe(true);
    // AND IT SAYS WHAT WENT. A silent deletion of a quarter of a gigabyte is
    // one a person only ever learns about from its absence.
    expect(report!.files).toBeGreaterThan(0);
    expect(report!.bytes).toBeGreaterThan(0);
    expect(report!.ageMs).toBeGreaterThan(7 * day);
    expect(fs.existsSync(backup)).toBe(false);
    // The store it was a backup OF is untouched, which is the whole premise.
    expect(swept.sessionIds()).toContain("session_one");
  } finally { swept.close(); }

  // AND IT IS IDEMPOTENT. Nothing to consider on the next start, and nothing
  // reported — a line saying "removed nothing" every morning trains its reader
  // to skip the line that matters.
  const again = new ExecutionStore(home, { now: () => clock + day });
  try {
    expect(again.housekeeping.backup).toBeUndefined();
  } finally { again.close(); }
});

test("a store with no migration behind it has no backup to consider", () => {
  const { store } = setup();
  // Born on sqlite: `importLegacy` never ran, so there is nothing to age and
  // nothing to say about it.
  expect(store.executionHousekeeping()?.backup).toBeUndefined();
  expect(store.executionHousekeeping()?.receipts).toBe(0);
});

/**
 * THE JOURNAL ROWS A SETTLED TURN HAS SUPERSEDED (#646).
 *
 * `events` was 68% of a gigabyte store, and 57% of its rows said nothing their
 * own `item.completed` did not already say. The sweep drops those — but only
 * where it can PROVE the completed item holds the text, which is the single
 * thing worth asserting here: the guard, not the byte count.
 */
function journal(root: string, sessionId: string, store: ExecutionStore) {
  store.write(path.join(root, "sessions", sessionId, "session.json"), { id: sessionId });
  let id = 0;
  const at = Date.parse("2026-09-01T00:00:00Z");
  const runId = "run_one";
  // The kind and the stream are PARAMETERS rather than constants because the
  // reach test below has to write every item kind the contract has, and a
  // fixture that can only write `assistant_message` can only ever confirm the
  // one kind that was never in doubt. Both default to what the older tests
  // here pass, which is why those say nothing about either.
  return {
    start: (itemId: string, detail: ItemDetail = { type: "assistant_message", text: "" }) =>
      store.append({ id: ++id, at, sessionId, runId, type: "item.started",
        item: { id: itemId, runId, sessionId, status: "inProgress", detail, startedAt: at } } as never),
    delta: (itemId: string, text: string, stream: ContentStream = "assistant_text") =>
      store.append({ id: ++id, at, sessionId, runId, type: "content.delta", itemId, stream, text } as never),
    complete: (itemId: string, text: string, detail: ItemDetail = { type: "assistant_message", text }) =>
      store.append({ id: ++id, at, sessionId, runId, type: "item.completed",
        item: { id: itemId, runId, sessionId, status: "completed", detail, startedAt: at, completedAt: at } } as never),
    endTurn: () => store.append({ id: ++id, at, sessionId, runId, type: "turn.completed", resultText: "done" } as never),
  };
}
const types = (store: ExecutionStore, sessionId: string) => store.events(sessionId).map((event) => event.type);

test("a settled turn keeps its completed items and drops the rows they supersede", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "Once upon ");
    write.delta("item_one", "a time");
    write.complete("item_one", "Once upon a time");
    write.endTurn();

    const swept = store.compactJournal();
    expect(swept).toEqual({ deltas: 2, starts: 1, sessions: 1 });
    // The completed item survives, and with it the text both dropped kinds held.
    expect(types(store, "session_one")).toEqual(["item.completed", "turn.completed"]);
    expect(store.events("session_one")[0]).toMatchObject({ item: { detail: { text: "Once upon a time" } } });

    // AND IT IS INCREMENTAL. The watermark means the second sweep looks at
    // nothing, rather than re-scanning a settled journal every day forever.
    expect(store.compactJournal()).toEqual({ deltas: 0, starts: 0, sessions: 0 });
  } finally { store.close(); }
});

test("the guard keeps the deltas a completed item cannot account for", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-guard-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_short");
    write.delta("item_short", "the whole streamed paragraph");
    // Nine items in a 4,000-item sample completed with LESS text than was
    // streamed into them. This is that case: dropping the deltas here would
    // lose the difference, so the comparison keeps them.
    write.complete("item_short", "truncated");
    write.endTurn();

    expect(store.compactJournal()).toEqual({ deltas: 0, starts: 1, sessions: 1 });
    expect(types(store, "session_one")).toEqual(["content.delta", "item.completed", "turn.completed"]);
  } finally { store.close(); }
});

test("an unfinished turn is left entirely alone, and swept once it ends", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-live-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "still ");
    write.complete("item_one", "still streaming");
    write.delta("item_two", "an item with no completion at all");

    // No terminal turn event yet: nothing below it is final, so nothing goes.
    expect(store.compactJournal()).toEqual({ deltas: 0, starts: 0, sessions: 0 });
    expect(store.events("session_one")).toHaveLength(4);

    write.endTurn();
    expect(store.compactJournal()).toEqual({ deltas: 1, starts: 1, sessions: 1 });
    // `item_two` never completed, so its delta is the only record of that text
    // and it stays — the same rule as the guard, for the same reason.
    expect(types(store, "session_one")).toEqual(["item.completed", "content.delta", "turn.completed"]);
  } finally { store.close(); }
});

/**
 * HOW FAR COMPACTION REACHES, PER KIND, AND WHY IT STOPS WHERE IT DOES — #686.
 *
 * The guard compares an item's summed deltas against `detail.text` on its own
 * `item.completed`. Three of the contract's eighteen detail kinds have a
 * top-level `text`; the other fifteen keep their payload under a named field
 * or do not keep it at all. So the reach is not a coverage gap somebody forgot
 * to close — it is the guard correctly reporting that for those fifteen the
 * completed row DOES NOT HOLD what was streamed, and dropping their deltas
 * would be lossy rather than lossless. #686 opened as "compaction reaches 2 of
 * 18 kinds"; the finding was that widening it is the bug, not the fix.
 *
 * THE FIXTURE IS DELIBERATELY GENEROUS. Every kind's completed detail carries
 * the WHOLE streamed text in the most text-bearing field that kind has — the
 * command's `outputPreview`, the tool call's `output`, the diff, the error
 * message. They are kept anyway, which is the point: it is the shape the guard
 * reads, not the presence of the characters somewhere on the row. In real
 * traffic those fields are capped at 4,000 characters (see
 * `CommandExecutionDetail.outputPreview`), so pointing the comparison at them
 * would pass only where compaction was not worth doing.
 *
 * ASSERTED IN BOTH DIRECTIONS, WHICH IS WHAT MAKES IT A TEST. Only asserting
 * "9 dropped" would pass just as well on a fixture that quietly stopped writing
 * the other fifteen kinds' deltas. So the count is asserted BEFORE the sweep
 * (every kind really wrote three), the sweep's own return is asserted, and the
 * survivors are asserted per kind afterwards.
 *
 * THREE REACHABLE, TWO EMITTED. `user_message` is reachable and never streamed
 * into — it is typed, not generated — so the issue's "2 of 18" is the emission
 * count and this is the structural one. Both are worth having: the first can
 * change without anyone touching this store, and the trip-wire below is what
 * notices.
 */
const DELTAS_PER_KIND = 3;
/** The detail kinds whose completed row keeps the streamed text where the
 *  guard reads it — `$.item.detail.text`, no named field in between. */
const REACHABLE: ItemDetail["type"][] = ["user_message", "assistant_message", "reasoning"];
/** One row per contract kind: the stream that kind's deltas would arrive on if
 *  anything emitted them, and the most generous completed detail it can hold. */
const REACH: { kind: ItemDetail["type"]; stream: ContentStream; detail: (text: string) => ItemDetail }[] = [
  { kind: "user_message", stream: "assistant_text", detail: (text) => ({ type: "user_message", text }) },
  { kind: "notification", stream: "assistant_text", detail: (text) => ({ type: "notification", notification: { kind: "peer_message", summary: text, fetch: { sessionId: "session_one", runId: "run_one" }, body: text } }) },
  { kind: "assistant_message", stream: "assistant_text", detail: (text) => ({ type: "assistant_message", text }) },
  { kind: "reasoning", stream: "reasoning_text", detail: (text) => ({ type: "reasoning", text }) },
  { kind: "plan", stream: "assistant_text", detail: (text) => ({ type: "plan", plan: { steps: [{ step: text, status: "completed" }] } }) },
  { kind: "command_execution", stream: "command_output", detail: (text) => ({ type: "command_execution", command: { command: "bun test", outputPreview: text } }) },
  { kind: "file_change", stream: "tool_output", detail: (text) => ({ type: "file_change", change: { path: "a.ts", kind: "edit", unifiedDiff: text } }) },
  // Nowhere to put it at all: `FileReadDetail` is a path and a line range.
  { kind: "file_read", stream: "tool_output", detail: () => ({ type: "file_read", read: { path: "a.ts" } }) },
  { kind: "mcp_tool_call", stream: "tool_output", detail: (text) => ({ type: "mcp_tool_call", call: { name: "mcp__linear__search", output: text } }) },
  { kind: "dynamic_tool_call", stream: "tool_output", detail: (text) => ({ type: "dynamic_tool_call", call: { name: "WebFetch", output: text } }) },
  { kind: "web_search", stream: "tool_output", detail: (text) => ({ type: "web_search", query: text }) },
  { kind: "browser_action", stream: "tool_output", detail: (text) => ({ type: "browser_action", call: { name: "browser_click", output: text } }) },
  { kind: "task", stream: "assistant_text", detail: () => ({ type: "task", taskId: "task_one" }) },
  { kind: "context_compaction", stream: "assistant_text", detail: (text) => ({ type: "context_compaction", reason: text }) },
  { kind: "provider_wait", stream: "assistant_text", detail: () => ({ type: "provider_wait", wait: { kind: "api_retry", attempt: 1 } }) },
  { kind: "conversation_import", stream: "assistant_text", detail: (text) => ({ type: "conversation_import", import: { provider: "claude", sourceSessionId: "session_src", sessionId: "session_one", firstPrompt: text, records: 1, cut: "whole", rows: 1, rowCut: "whole" } }) },
  { kind: "error", stream: "assistant_text", detail: (text) => ({ type: "error", error: { message: text } }) },
  { kind: "unknown", stream: "unknown", detail: (text) => ({ type: "unknown", label: text }) },
];

test("compaction reaches exactly the kinds whose settled row keeps the streamed text", () => {
  // EXHAUSTIVE OR IT PROVES NOTHING. A nineteenth detail kind that nobody
  // thought about compaction for fails here rather than being silently exempt.
  expect(REACH.map((row) => row.kind)).toEqual(
    ItemDetailSchema.options.map((option) => option.shape.type.value as ItemDetail["type"]),
  );
  expect(REACH).toHaveLength(18);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-reach-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    const streamed = "one two three";
    for (const { kind, stream, detail } of REACH) {
      const itemId = `item_${kind}`;
      write.start(itemId, detail(""));
      // Three deltas summing to exactly the completed text, so the guard's
      // `settled.chars >= streamed.chars` holds wherever it can read both.
      write.delta(itemId, "one ", stream);
      write.delta(itemId, "two ", stream);
      write.delta(itemId, "three", stream);
      write.complete(itemId, streamed, detail(streamed));
    }
    write.endTurn();

    const deltasPerItem = (): Map<string, number> => {
      const counted = new Map<string, number>();
      for (const event of store.events("session_one")) {
        if (event.type !== "content.delta") continue;
        counted.set(event.itemId, (counted.get(event.itemId) ?? 0) + 1);
      }
      return counted;
    };

    // BEFORE: the fixture really wrote three for every kind. Without this the
    // "kept: 3" below would be satisfied by a fixture that wrote three and by
    // one that stopped emitting deltas for a kind entirely.
    const before = deltasPerItem();
    expect(REACH.map(({ kind }) => before.get(`item_${kind}`) ?? 0)).toEqual(REACH.map(() => DELTAS_PER_KIND));

    // The sweep's own accounting: 3 reachable kinds × 3 deltas, and an
    // `item.started` dropped for each of the 18 items that completed.
    expect(store.compactJournal()).toEqual({ deltas: REACHABLE.length * DELTAS_PER_KIND, starts: REACH.length, sessions: 1 });

    // AFTER, per kind and in both directions.
    const after = deltasPerItem();
    expect(REACH.map(({ kind }) => ({
      kind,
      kept: after.get(`item_${kind}`) ?? 0,
      dropped: (before.get(`item_${kind}`) ?? 0) - (after.get(`item_${kind}`) ?? 0),
    }))).toEqual(REACH.map(({ kind }) => REACHABLE.includes(kind)
      ? { kind, kept: 0, dropped: DELTAS_PER_KIND }
      : { kind, kept: DELTAS_PER_KIND, dropped: 0 }));

    // And the deltas that are the only record of their text are still there.
    expect(store.events("session_one").filter((event) => event.type === "content.delta")).toHaveLength(
      (REACH.length - REACHABLE.length) * DELTAS_PER_KIND,
    );
  } finally { store.close(); }
});

/**
 * THE TRIP-WIRE AT THE EMITTER SEAM — #686, and the cheap form of it.
 *
 * The dangerous change is not a wider guard, it is a NEW EMISSION. The moment a
 * driver streams a command's output or a tool's result, those deltas become the
 * only durable copy of anything past the 4,000-character preview — history, not
 * redundancy — and compaction must go on skipping them. The person that hurts
 * most is the command-heavy user, who is also the one a "fix" to the guard
 * would look like it was for.
 *
 * SO EVERY MEMBER IS CLASSIFIED, AND MOVING ONE IS A DECISION SOMEBODY MAKES ON
 * PURPOSE. A sixth member fails here. A member moved between the sets fails
 * here. Both failures are the prompt to answer one question first: what happens
 * to those deltas when their turn settles?
 *
 * OVER VALUES, NEVER OVER SOURCE TEXT. This repository has shipped a check that
 * grepped for a test name and therefore passed when the test was skipped; a
 * grep here would additionally pass through a rename, or through a driver that
 * emits via a variable rather than a literal.
 */
/** Streams whose deltas a settled `item.completed` can account for, because the
 *  item they open keeps its text at `detail.text`. */
const COMPACTABLE: ContentStream[] = ["assistant_text", "reasoning_text"];
/** Streams no driver in this repository emits. Moving one out of here means
 *  deciding what `compactJournal` should do with its deltas — the answer is
 *  "keep them", and the reach test above is where that gets written down. */
const NOT_EMITTED: ContentStream[] = ["command_output", "tool_output", "unknown"];

test("every content stream is classified for compaction, exactly once", () => {
  const classified = [...COMPACTABLE, ...NOT_EMITTED];
  // Exhaustive: a new member of the enum belongs to one of the two sets, and
  // until somebody puts it in one this fails.
  expect([...classified].sort()).toEqual([...ContentStreamSchema.options].sort());
  // And to exactly one: a member in both would make the pair agree with the
  // enum while saying nothing.
  expect(new Set(classified).size).toBe(classified.length);
  expect(COMPACTABLE.filter((stream) => NOT_EMITTED.includes(stream))).toEqual([]);
  // The two numbers #686 measured, held where a change has to walk past them.
  expect(COMPACTABLE).toHaveLength(2);
  expect(NOT_EMITTED).toHaveLength(3);
  // The compactable streams are exactly the reachable kinds that are streamed
  // into, which is the link between this trip-wire and the reach test above.
  expect(COMPACTABLE.length).toBe(REACHABLE.filter((kind) => kind !== "user_message").length);
});

/**
 * THE SWEEP IS NOT ON THE OPEN PATH, and that is measured rather than tidy.
 *
 * Running it in the constructor cost 54 SECONDS on the owner's gigabyte — a
 * one-time cost, but one-time on the launch right after an update, and a longer
 * stall than the VACUUM that is deliberately kept behind a button. So the open
 * returns and the sweep follows it.
 */
test("opening the store does not sweep; the sweep follows and says what it took", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-open-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  let store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    for (let turn = 0; turn < 40; turn += 1) {
      const item = `item_${turn}`;
      write.start(item);
      // Enough text that the freed pages are a file-size difference and not a
      // rounding error; the point of `reclaim` is that the file itself shrinks.
      for (let chunk = 0; chunk < 40; chunk += 1) write.delta(item, "x".repeat(512));
      write.complete(item, "x".repeat(512 * 40));
    }
    write.endTurn();
  } finally { store.close(); }

  const told: { deltas: number; starts: number; sessions: number }[] = [];
  store = new ExecutionStore(root, { onJournalCompacted: (swept) => told.push(swept) });
  try {
    // The open itself took nothing away — a person waiting on the daemon is
    // not waiting on housekeeping.
    expect(store.housekeeping.journal).toBeUndefined();
    expect(store.events("session_one").filter((event) => event.type === "content.delta")).toHaveLength(1600);

    // The sweep the timer would run, without waiting five seconds for it.
    const swept = store.compactJournal();
    expect(swept.deltas).toBe(1600);
    expect(swept.starts).toBe(40);

    // AND THE FILE IS EXACTLY AS BIG AS IT WAS. A DELETE moves pages to the
    // freelist and returns nothing to the filesystem — the whole reason the
    // button below exists. This is #646's own fact 1, as a test.
    const file = path.join(root, "execution.sqlite");
    const afterSweep = fs.statSync(file).size;
    const reclaimed = store.reclaim();
    expect(fs.statSync(file).size).toBeLessThan(afterSweep);
    expect(reclaimed.after).toBeLessThan(reclaimed.before);
    // Nothing left to compact, so pressing it again moves nothing — which is
    // what the before/after in Settings is there to show a person.
    expect(reclaimed.deltas).toBe(0);
    expect(store.events("session_one").filter((event) => event.type === "item.completed")).toHaveLength(40);
  } finally { store.close(); }

  // AND THE DAEMON IS TOLD WHEN THE ROWS ACTUALLY GO, not at open: the line is
  // a callback now, because there is no longer a moment during startup when
  // the answer is known.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-told-")); homes.push(fresh);
  fs.mkdirSync(path.join(fresh, "sessions"), { recursive: true });
  const seen: { deltas: number; starts: number; sessions: number }[] = [];
  /**
   * THE DELAY IS INJECTED RATHER THAN SLEPT THROUGH (#706).
   *
   * This used to sleep 5,400 ms and then assert the callback had fired — a
   * four-hundred-millisecond margin against the real five-second timer, on a
   * machine shared with the rest of the suite. That is not an assertion about
   * this store; it is an assertion that nothing else was busy. It also could
   * not pass at all under a bare root-level `bun test`, which gets bun's 5 s
   * default rather than the suite's `--timeout 20000`.
   *
   * Now the sweep is told to run immediately and the test waits for the
   * CALLBACK. What is asserted is what the sweep removed — the same answer
   * idle or loaded — and the whole test costs milliseconds.
   */
  const announced = new ExecutionStore(fresh, { onJournalCompacted: (swept) => seen.push(swept), compactAfterOpenMs: 1 });
  try {
    const write = journal(fresh, "session_one", announced);
    write.start("item_one");
    write.delta("item_one", "hello");
    write.complete("item_one", "hello");
    write.endTurn();
    const deadline = Date.now() + 4_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([{ deltas: 1, starts: 1, sessions: 1 }]);
  } finally { announced.close(); }
});
