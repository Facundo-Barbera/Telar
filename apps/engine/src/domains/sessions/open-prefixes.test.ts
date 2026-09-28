import { describe, expect, test } from "bun:test";
import { EngineStore } from "../../state";
import { forgetOpenPrefixes, openPrefixCount } from "../../../test/store-internals";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

describe("an open item's streamed prefix", () => {
  const streaming = (): { store: EngineStore; token: string } => {
    const { store } = readyStore();
    store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
    const claimed = store.claimTurn("session_one", "worker_one")!;
    const token = claimed.claim!.token;
    store.markRunning("session_one", "run_one", token);
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
    ]);
    return { store, token };
  };

  test("carries the text streamed so far, through the delta that last extended it", () => {
    const { store } = streaming();
    const cursor = store.eventCursor("session_one");
    const prefix = store.openItemPrefix("session_one", "i1", cursor)!;
    expect(prefix.streamed).toBe("Once upon ");
    expect(prefix.streamedThrough).toBeLessThanOrEqual(cursor);
  });

  test("REGRESSION: a delta appended after the cache was lost still yields the WHOLE prefix", () => {
    /**
     * THE TRUNCATION, MOVED INTO THE ENGINE. A restart empties the accumulator.
     * The next delta then built an entry holding only itself — and a cutoff at
     * or above it looked satisfiable, so the tail was served as if it were the
     * whole reply. Exactly the bug the field exists to prevent, one layer down.
     */
    const { store, token } = streaming();
    forgetOpenPrefixes(store);
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
    ]);
    const prefix = store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!;
    expect(prefix.streamed).toBe("Once upon a time");
  });

  test("a cutoff behind the cache rebuilds the prefix exactly to it", () => {
    const { store, token } = streaming();
    const behind = store.eventCursor("session_one");
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
    ]);
    // The cache now reaches further than the caller's cutoff, so the journal
    // decides — anything else would report text from the future.
    expect(store.openItemPrefix("session_one", "i1", behind)!.streamed).toBe("Once upon ");
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon a time");
  });

  test("an item left open by a stop keeps its text, cache or no cache", () => {
    // Stop deliberately leaves items open, so the prefix is the only account of
    // what the reader was shown — and it must outlive the process that held it.
    const { store } = streaming();
    forgetOpenPrefixes(store);
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon ");
  });

  test("two sessions' items with the same id do not share a prefix", () => {
    const { store, token } = streaming();
    store.createSession({ id: "session_two", projectId: "project_one" });
    store.submitTurn("session_two", { runId: "run_two", input: "Hello" });
    const claimed = store.claimTurn("session_two", "worker_two")!;
    store.markRunning("session_two", "run_two", claimed.claim!.token);
    store.ingestObservations("session_two", "run_two", claimed.claim!.token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "different" },
    ]);
    expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon ");
    expect(store.openItemPrefix("session_two", "i1", store.eventCursor("session_two"))!.streamed).toBe("different");
    void token;
  });

  test("a closed item's stored text wins, even when it is SHORTER than the prefix", () => {
    // A provider that revises its answer on close must be able to shorten it,
    // which is why the client prefers `detail` once an item is no longer open.
    const { store, token } = streaming();
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.completed", itemId: "i1", status: "completed", detail: { type: "assistant_message", text: "Short." } },
    ]);
    const item = store.items("session_one").find((row) => row.id === "i1")!;
    expect(item.status).toBe("completed");
    expect(item.detail).toMatchObject({ text: "Short." });
  });
});

test("#214 an item evicted from the prefix cache keeps streaming correctly", () => {
  // An evicted item's cache is rebuilt from a tail, not its beginning, so it must fall
  // back to the journal rather than report the tail as the whole reply.
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "Once upon " },
  ]);
  // Enough opens to evict i1, and opens alone — no deltas.
  for (let index = 0; index < 80; index += 1) {
    store.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: `filler_${index}`, detail: { type: "assistant_message", text: "" } } },
    ]);
  }
  // THE BOUND ITSELF, asserted separately: the text above stays correct whether
  // or not eviction ran, so it cannot tell a held bound from a skipped one.
  // Opening is the path that used to insert without trimming.
  expect(openPrefixCount(store)).toBeLessThanOrEqual(64);
  store.ingestObservations("session_one", "run_one", token, [
    { kind: "content.delta", itemId: "i1", stream: "assistant_text", text: "a time" },
  ]);
  expect(store.openItemPrefix("session_one", "i1", store.eventCursor("session_one"))!.streamed).toBe("Once upon a time");
  expect(openPrefixCount(store)).toBeLessThanOrEqual(64);
});
