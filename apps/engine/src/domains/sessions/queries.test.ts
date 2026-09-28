import { expect, test } from "bun:test";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

test("a windowed snapshot is the newest settled turns plus everything unsettled, paged by runId", () => {
  const { store } = readyStore();
  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.intake.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", runId, token);
    store.ingest.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `i_${n}`, detail: { type: "assistant_message", text: `Answer ${n}` } } },
      { kind: "item.completed", itemId: `i_${n}`, status: "completed" },
    ]);
    store.turnLifecycle.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  store.intake.submitTurn("session_one", { runId: "run_live", input: "Now" }); // queued — unsettled

  const first = store.queries.snapshotWindow("session_one", { limit: 2 });
  expect(first.turns.map((turn) => turn.runId)).toEqual(["run_4", "run_5", "run_live"]);
  expect(first.page).toEqual({ before: "run_4", more: true, total: 6 });
  // Items follow their turns — the window is what makes the read small.
  expect(first.items.map((item) => item.id).sort()).toEqual(["i_4", "i_5"]);

  const older = store.queries.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);
  expect(older.page).toEqual({ before: "run_2", more: true, total: 6 });

  const oldest = store.queries.snapshotWindow("session_one", { limit: 2, before: "run_2" });
  expect(oldest.turns.map((turn) => turn.runId)).toEqual(["run_1"]);
  expect(oldest.page).toEqual({ before: null, more: false, total: 6 });

  // A limit past the start is the whole history, first page, no cursor.
  const whole = store.queries.snapshotWindow("session_one", { limit: 50 });
  expect(whole.turns).toHaveLength(6);
  expect(whole.page).toEqual({ before: null, more: false, total: 6 });

  expect(() => store.queries.snapshotWindow("session_one", { limit: 2, before: "run_nope" })).toThrow(EngineStateError);
});

test("a windowed snapshot carries the window's requests and every open one, not the whole history", () => {
  // THE KEY THAT USED TO IGNORE THE WINDOW. On the dogfood store this was 549
  // requests / 315 KB per read, of which 44 were in the window and none were
  // unresolved — re-read every second by every open cockpit.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one", detached: false });

  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.intake.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", runId, token);
    store.requestGate.open("session_one", runId, token, {
      requestId: `req_${n}`,
      kind: "command_execution",
      detail: { kind: "command_execution", command: { command: `echo ${n}` } },
    });
    store.requestGate.resolve("session_one", `req_${n}`, { decision: "accept" });
    store.turnLifecycle.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  // …and one still running, holding the question nobody has answered.
  store.intake.submitTurn("session_one", { runId: "run_live", input: "Now" });
  const liveToken = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_live", liveToken);
  store.requestGate.open("session_one", "run_live", liveToken, {
    requestId: "req_open",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf build" } },
  });

  const first = store.queries.snapshotWindow("session_one", { limit: 2 });
  expect(first.requests.map((request) => request.id)).toEqual(["req_4", "req_5", "req_open"]);

  // An older page drops the newer turns' settled requests — but NOT the open
  // one: a client replaces this key rather than merging it, so a question left
  // off a page is a question the composer stops being able to answer.
  const older = store.queries.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.requests.map((request) => request.id)).toEqual(["req_2", "req_3", "req_open"]);

  // The unwindowed read is unchanged: everything the session ever opened.
  expect(store.requestGate.list("session_one")).toHaveLength(6);
});
