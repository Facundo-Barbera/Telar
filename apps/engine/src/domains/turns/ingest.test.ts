import { expect, spyOn, test } from "bun:test";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import type { ExecutionStore } from "../../platform/db/execution-store";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

test("streamed deltas journal without rewriting the item projection, and the close still lands", () => {
  // Deltas write nothing to the projection, and the close still writes the text a later reader needs.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i_1", detail: { type: "assistant_message", text: "" } } },
  ]);

  const upserts = spyOn(documents(store), "upsertItems");
  const texts = spyOn(documents(store), "writeText");
  const projectionWrites = () => upserts.mock.calls.length + texts.mock.calls.filter(([file]) => file.endsWith("items.json")).length;
  try {
    for (const text of ["hel", "lo ", "there"]) {
      store.ingest.ingestObservations("session_one", "run_one", token, [
        { kind: "content.delta", itemId: "i_1", stream: "assistant_text", text },
      ]);
    }
    expect(projectionWrites()).toBe(0);

    store.ingest.ingestObservations("session_one", "run_one", token, [
      { kind: "item.completed", itemId: "i_1", status: "completed", detail: { type: "assistant_message", text: "hello there" } },
    ]);
    expect(projectionWrites()).toBe(1);
  } finally {
    upserts.mockRestore();
    texts.mockRestore();
  }

  // The deltas are still durable, and the projection carries the folded text —
  // read back through a path that does not share the writer's copy.
  expect(store.queries.readEvents("session_one").filter((event) => event.type === "content.delta")).toHaveLength(3);
  expect(store.queries.items("session_one").map((item) => item.detail)).toEqual([{ type: "assistant_message", text: "hello there" }]);
});

test("observations become durable items and deltas, and only under a live claim", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;

  // A worker may only report against a RUNNING turn it holds the claim for.
  expect(() =>
    store.ingest.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(/not running/);

  store.turnLifecycle.markRunning("session_one", "run_one", token);
  expect(() =>
    store.ingest.ingestObservations("session_one", "run_one", "not-the-token-at-all", [
      { kind: "item.started", item: { id: "i1", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(EngineStateError);

  store.ingest.ingestObservations("session_one", "run_one", token, [
    { kind: "item.started", item: { id: "i1", detail: { type: "command_execution", command: { command: "ls" } }, title: "ls" } },
    { kind: "content.delta", itemId: "i1", stream: "command_output", text: "a" },
    { kind: "item.completed", itemId: "i1", status: "completed" },
  ]);

  const items = store.queries.items("session_one");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "i1", runId: "run_one", sessionId: "session_one", status: "completed", title: "ls" });
  expect(store.queries.readEvents("session_one").map((event) => event.type)).toEqual([
    "session.created",
    "turn.accepted",
    "turn.claimed",
    "turn.started",
    "item.started",
    "content.delta",
    "item.completed",
  ]);
});

test("a report against a SETTLED turn is a typed conflict that says the turn ended, not a claim mix-up", () => {
  // A report can land just after its turn settles; it gets a typed `conflict` that reads as late,
  // not as a stolen claim, and nothing lands after `turn.completed`.
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "done" });

  const late = () =>
    store.ingest.ingestObservations("session_one", "run_one", token, [
      { kind: "item.started", item: { id: "i_late", detail: { type: "command_execution", command: { command: "echo late" } } } },
    ]);
  expect(late).toThrow(EngineStateError);
  expect(late).toThrow(/already settled \(completed\)/);
  try {
    late();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineStateError);
    expect((error as EngineStateError).code).toBe("conflict");
  }
  // Refused means refused: the settled turn's journal gained nothing.
  expect(store.queries.items("session_one").some((item) => item.id === "i_late")).toBe(false);

  // A WRONG token against the same settled turn stays the generic claim
  // refusal — "settled" is only claimed for the worker that really ran it.
  expect(() =>
    store.ingest.ingestObservations("session_one", "run_one", "not-the-token-at-all", [
      { kind: "item.started", item: { id: "i_late", detail: { type: "assistant_message", text: "" } } },
    ]),
  ).toThrow(/not running under this worker claim/);
});

test("a malformed observation rejects the WHOLE batch, leaving no half-written provider message", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claimed.claim!.token);
  const before = store.queries.readEvents("session_one").length;

  expect(() =>
    store.ingest.ingestObservations("session_one", "run_one", claimed.claim!.token, [
      { kind: "item.started", item: { id: "good", detail: { type: "assistant_message", text: "" } } },
      { kind: "item.started", item: { id: "bad", detail: { type: "file_change", command: { command: "ls" } } } },
    ]),
  ).toThrow(/observations are invalid/);

  expect(store.queries.readEvents("session_one")).toHaveLength(before);
  expect(store.queries.items("session_one")).toEqual([]);
});

test("a delta for an item that was never opened is dropped rather than journalled", () => {
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claimed.claim!.token);
  store.ingest.ingestObservations("session_one", "run_one", claimed.claim!.token, [
    { kind: "content.delta", itemId: "ghost", stream: "assistant_text", text: "x" },
  ]);
  expect(store.queries.readEvents("session_one").some((event) => event.type === "content.delta")).toBe(false);
});

test("an artifact published under one id again, even a turn later, journals as the next version", () => {
  const { store } = readyStore();
  const publish = (runId: string, artifacts: Array<{ id: string; attachmentId: string }>) => {
    store.intake.submitTurn("session_one", { runId, input: "Draw" });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", runId, token);
    store.ingest.ingestObservations(
      "session_one",
      runId,
      token,
      artifacts.map((artifact) => ({ kind: "artifact.published", artifact: { ...artifact, kind: "svg", title: "Chart" } })),
    );
    store.turnLifecycle.completeTurn("session_one", runId, token, { text: "drawn" });
  };
  publish("run_one", [{ id: "chart", attachmentId: "att_1" }, { id: "chart", attachmentId: "att_2" }]);
  publish("run_two", [{ id: "chart", attachmentId: "att_3" }, { id: "other", attachmentId: "att_4" }]);

  const artifacts = store.queries.items("session_one").flatMap((item) => (item.detail.type === "artifact" ? [{ item: item.id, run: item.runId, ...item.detail.artifact }] : []));
  expect(artifacts.map(({ item, run, id, version, attachmentId }) => ({ item, run, id, version, attachmentId }))).toEqual([
    { item: "artifact_chart_v1", run: "run_one", id: "chart", version: 1, attachmentId: "att_1" },
    { item: "artifact_chart_v2", run: "run_one", id: "chart", version: 2, attachmentId: "att_2" },
    { item: "artifact_chart_v3", run: "run_two", id: "chart", version: 3, attachmentId: "att_3" },
    { item: "artifact_other_v1", run: "run_two", id: "other", version: 1, attachmentId: "att_4" },
  ]);
});
