/**
 * THE RESOLVED-REQUEST WINDOW — issue #545.
 *
 * `requests.json` was append-only for the life of a session: one conversation
 * held 4,902 rows, every one resolved, and the store 43,280 over 345 documents.
 * The document is now a window over the newest resolved rows, and the JOURNAL is
 * the ledger — so the property under test is not "the document is smaller" but
 * "nothing became unanswerable by making it smaller".
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { toLegacyHome } from "../../../test/store-internals";

const roots: string[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-request-history-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const bashDetail = { kind: "command_execution" as const, command: { command: "rm -rf build" } };

function readyStore(directory = root()): EngineStore {
  let clock = 100;
  const store = new EngineStore(directory, () => (clock += 1), { notifier: () => true });
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  return store;
}

/** A claimed, running turn — the only state in which a request may be opened. */
function runningSession(store: EngineStore, sessionId = "session_one", runId = "run_one"): string {
  store.lifecycle.createSession({ id: sessionId, projectId: "project_one", detached: false });
  store.intake.submitTurn(sessionId, { runId, input: "Hello" });
  const claimed = store.claims.claimTurn(sessionId, "worker_one")!;
  store.turnLifecycle.markRunning(sessionId, runId, claimed.claim!.token);
  return claimed.claim!.token;
}

/** Open and immediately answer `count` requests, oldest first. */
function churn(store: EngineStore, token: string, count: number, sessionId = "session_one", runId = "run_one"): void {
  for (let n = 0; n < count; n += 1) {
    const requestId = `req_${String(n).padStart(4, "0")}`;
    store.requestGate.open(sessionId, runId, token, { requestId, kind: "command_execution", detail: bashDetail });
    store.requestGate.resolve(sessionId, requestId, { decision: "accept" });
  }
}

test("the document keeps the newest 50 resolved requests and drops the rest", () => {
  const store = readyStore();
  const token = runningSession(store);
  churn(store, token, 140);

  const kept = store.requestGate.list("session_one");
  expect(kept).toHaveLength(50);
  expect(kept[0]!.id).toBe("req_0090");
  expect(kept.at(-1)!.id).toBe("req_0139");
  expect(kept.every((request) => request.state === "resolved")).toBe(true);
});

test("a person-resolved request older than the window is still readable from the journal", () => {
  // This is what makes the trim safe: the document is a window, the journal is
  // the record, and a request a PERSON resolved is never trimmed from it. Only
  // policy-resolved pairs are pruned (#697 part B) — see
  // `request-prune.test.ts`, which holds this same row through the sweep.
  const store = readyStore();
  const token = runningSession(store);
  churn(store, token, 140);

  expect(store.requestGate.list("session_one").some((request) => request.id === "req_0000")).toBe(false);
  const events = store.queries.readEvents("session_one");
  const opened = events.find((event) => event.type === "request.opened" && event.request.id === "req_0000");
  const resolved = events.find((event) => event.type === "request.resolved" && event.requestId === "req_0000");
  expect(opened).toBeDefined();
  expect(resolved).toMatchObject({ decision: "accept", resolvedBy: "human" });
});

test("a request parked and answered late survives the window it opened before", () => {
  // The window is over WHEN A ROW WAS ANSWERED, not where it sits: the document
  // is in open order, so a question a human left parked is answered long after
  // the ones opened behind it. Ordering by position would drop the row that had
  // just resolved — the one the blocked worker is polling the heartbeat for.
  const store = readyStore();
  const token = runningSession(store);
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_parked", kind: "command_execution", detail: bashDetail });
  churn(store, token, 140);
  store.requestGate.resolve("session_one", "req_parked", { decision: "accept" });

  expect(store.requestGate.list("session_one").map((request) => request.id)).toContain("req_parked");
  // And the answer still reaches the worker that is parked on it, which is what
  // dropping it by position would have broken.
  const offered = store.requestGate.resolutionsForWorker("worker_one");
  expect(offered.map((resolution) => resolution.requestId)).toContain("req_parked");
  // Bounded by the same window as the document — the heartbeat never carries
  // more than the store keeps.
  expect(offered).toHaveLength(50);
});

test("an open request is never dropped, however far past the window it sits", () => {
  const store = readyStore();
  const token = runningSession(store);
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_parked", kind: "command_execution", detail: bashDetail });
  churn(store, token, 140);

  const kept = store.requestGate.list("session_one");
  expect(kept.filter((request) => request.state === "open")).toMatchObject([{ id: "req_parked" }]);
  // And the session still reads as waiting on a human because of it.
  expect(store.records.get("session_one").activity).toBe("blocked");
  // The window is over the RESOLVED rows; the open one rides on top of it.
  expect(kept).toHaveLength(51);
});

test("the boot sweep trims documents written before the window existed", () => {
  const directory = root();
  const seeded = readyStore(directory);
  const token = runningSession(seeded);
  churn(seeded, token, 20);

  // A fat document in a legacy home, as an engine without the window left it.
  const rows = Array.from({ length: 300 }, (_unused, n) => ({
    id: `old_${String(n).padStart(4, "0")}`,
    runId: "run_one",
    sessionId: "session_one",
    state: "resolved",
    detail: bashDetail,
    openedAt: 1,
    decision: "accept",
    resolvedBy: "human",
    resolvedAt: 2,
  }));
  toLegacyHome(seeded, directory, (key, value) =>
    key === "sessions/session_one/requests.json" ? { version: 1, requests: rows } : value);

  const booted = new EngineStore(directory, () => 9_000, { notifier: () => true });
  booted.recovery.recover();

  const kept = booted.requestGate.list("session_one");
  expect(kept).toHaveLength(50);
  expect(kept[0]!.id).toBe("old_0250");

  // Idempotent: a second boot has nothing left to trim.
  booted.kernel.executionStore.close();
  const again = new EngineStore(directory, () => 9_100, { notifier: () => true });
  again.recovery.recover();
  expect(again.requestGate.list("session_one")).toEqual(kept);
});

test("sessions_requests still shows only the open ones", () => {
  // The window changes what the HISTORY holds. What a session is WAITING on is
  // the question tools ask, and its answer is untouched.
  const store = readyStore();
  const token = runningSession(store);
  churn(store, token, 80);
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_parked", kind: "command_execution", detail: bashDetail });

  expect(store.requestGate.list("session_one").filter((request) => request.state === "open")).toMatchObject([{ id: "req_parked" }]);
});
