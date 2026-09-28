import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { EngineStore } from "../../state";
import { cleanup, setup, stores } from "./execution-store-fixture";

afterEach(cleanup);

function streamed(home: string): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(home, "execution.sqlite"), { readonly: true });
  try { return db.query("SELECT id,value FROM events WHERE session_id='session_one' ORDER BY id").all() as Array<Record<string, unknown>>; }
  finally { db.close(); }
}

test("deltas arriving in one tick are held, read back whole, and stored in a single write", () => {
  const { store, home } = setup();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claims.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", turn.runId, token);
  store.ingest.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  const settledBefore = streamed(home).length;
  const cursorBefore = store.queries.eventCursor("session_one");

  // Twenty deltas, one call each, all inside this tick — the shape a driver
  // reporting a chunk at a time produces.
  const chunks = Array.from({ length: 20 }, (_, n) => `chunk-${n} `);
  for (const text of chunks) {
    store.ingest.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  }

  // NOT ONE OF THEM IS ON DISK YET — that is the whole saving.
  expect(streamed(home)).toHaveLength(settledBefore);
  // …and no reader can tell. Every delta, in arrival order, contiguous ids.
  const read = store.queries.readEvents("session_one", cursorBefore);
  expect(read.map((event) => (event as { text?: string }).text)).toEqual(chunks);
  expect(read.map((event) => event.id)).toEqual(chunks.map((_, n) => cursorBefore + 1 + n));
  expect(store.queries.eventCursor("session_one")).toBe(cursorBefore + chunks.length);

  // The event that settles the item takes the batch to the disk with it, and
  // nothing may be stored ahead of the deltas it concludes.
  store.ingest.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.completed", itemId: "item_one", status: "completed", detail: { type: "assistant_message", text: chunks.join("") } },
  ]);
  const stored = streamed(home);
  expect(stored).toHaveLength(settledBefore + chunks.length + 1);
  expect(stored.map((row) => Number(row.id))).toEqual(stored.map((_, n) => n + 1));
  const deltas = stored.map((row) => JSON.parse(String(row.value)) as { type: string; text?: string }).filter((event) => event.type === "content.delta");
  expect(deltas.map((event) => event.text).join("")).toBe(chunks.join(""));
});

test("a failed command does not take already-accepted deltas with it", () => {
  const { store, home } = setup();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claims.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", turn.runId, token);
  store.ingest.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  for (const text of ["held-one ", "held-two "]) {
    store.ingest.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  }
  const cursor = store.queries.eventCursor("session_one");

  expect(() => store.executeCommand("broken", () => {
    store.ingest.ingestObservations("session_one", turn.runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "rolled-back " }]);
    throw new Error("injected disk failure");
  })).toThrow("injected disk failure");

  // The rolled-back delta is gone; the two accepted before it are not.
  expect(store.queries.eventCursor("session_one")).toBe(cursor);
  expect(store.queries.readEvents("session_one").filter((event) => event.type === "content.delta")
    .map((event) => (event as { text?: string }).text)).toEqual(["held-one ", "held-two "]);

  // And a clean close is what puts them on the disk, ids still contiguous.
  store.closeExecutionStore(); stores.splice(stores.indexOf(store), 1);
  const stored = streamed(home);
  expect(stored.map((row) => Number(row.id))).toEqual(stored.map((_, n) => n + 1));
  const reopened = new EngineStore(home); stores.push(reopened);
  expect(reopened.queries.readEvents("session_one").filter((event) => event.type === "content.delta")
    .map((event) => (event as { text?: string }).text)).toEqual(["held-one ", "held-two "]);
});

function streaming(): { store: EngineStore; home: string; runId: string; token: string } {
  const { store, home } = setup();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "stream" });
  const turn = store.claims.claimTurn("session_one", "worker_one")!;
  const token = turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", turn.runId, token);
  store.ingest.ingestObservations("session_one", turn.runId, token, [
    { kind: "item.started", item: { id: "item_one", detail: { type: "assistant_message", text: "" } } },
  ]);
  return { store, home, runId: turn.runId, token };
}
const deltas = (store: EngineStore): string[] =>
  store.queries.readEvents("session_one").filter((event) => event.type === "content.delta").map((event) => (event as { text: string }).text);

test("a stream cannot outlive its turn, even though the delta path reads a shared queue", () => {
  const { store, runId, token } = streaming();
  const delta = (text: string) => () =>
    store.ingest.ingestObservations("session_one", runId, token, [{ kind: "content.delta", itemId: "item_one", stream: "assistant_text", text }]);
  // The first one is what puts the queue in the shared cache the fast path
  // reads; the turn then settles behind it. A cache that outlived the write
  // would let this stream go on writing into a turn that is over.
  delta("live ")();
  store.turnLifecycle.completeTurn("session_one", runId, token, { text: "done" });
  expect(delta("late ")).toThrow(/already settled \(completed\)/);
  expect(deltas(store)).toEqual(["live "]);
});

test("a delta under a claim that is not the running one is refused and journals nothing", () => {
  const { store, runId } = streaming();
  expect(() =>
    store.ingest.ingestObservations("session_one", runId, "not-the-token-at-all", [
      { kind: "content.delta", itemId: "item_one", stream: "assistant_text", text: "forged " },
    ]),
  ).toThrow(/not running under this worker claim/);
  expect(deltas(store)).toEqual([]);
});

test("one malformed delta refuses the whole batch, including the valid ones ahead of it", () => {
  const { store, runId, token } = streaming();
  expect(() =>
    store.ingest.ingestObservations("session_one", runId, token, [
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
    store.ingest.ingestObservations("session_one", runId, token, [{ kind: "content.delta", itemId, stream: "assistant_text", text }]);
  say("item_one", "one ");
  // No such item: accepted as a report, journalled as nothing — the same thing
  // the command path does with it.
  expect(say("item_two", "nowhere ")).toEqual({ accepted: 1 });
  expect(deltas(store)).toEqual(["one "]);

  // …and the cached projection must not make that verdict permanent: an item
  // opened AFTER the stream began has to be visible to the very next delta.
  store.ingest.ingestObservations("session_one", runId, token, [
    { kind: "item.started", item: { id: "item_two", detail: { type: "assistant_message", text: "" } } },
  ]);
  say("item_two", "two ");
  expect(deltas(store)).toEqual(["one ", "two "]);
});
