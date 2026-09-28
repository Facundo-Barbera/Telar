/**
 * THE OPEN-REQUEST INDEX — issue #545.
 *
 * The property under test is not "the index is a map". It is that the two hot
 * readers get the SAME answer they used to get from the document, and get it
 * without reading the document at all: an idle engine was spending most of a
 * core re-parsing 43,280 resolved requests to find the nought that were open.
 *
 * So each test here asserts a behaviour AND a read count. The read count is the
 * half that regresses silently — an index that is correct but bypassed looks
 * exactly like this suite passing.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { toLegacyHome } from "../../../test/store-internals";

const roots: string[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-request-index-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const bashDetail = { kind: "command_execution" as const, command: { command: "rm -rf build" } };

/**
 * A store on the JSON backend, so `requests.json` reads are real file reads this
 * suite can count. The sqlite backend answers the same calls through
 * `ExecutionStore.read`, which is the same `readDocument` either way — the
 * parse and the zod walk that made it expensive are above that line.
 */
function readyStore(directory = root()): EngineStore {
  const store = new EngineStore(directory, () => 100, { notifier: () => true });
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  return store;
}

/** A session with one claimed, running turn — what a request needs to exist. */
function runningSession(store: EngineStore, sessionId: string, runId: string): string {
  store.lifecycle.createSession({ id: sessionId, projectId: "project_one", detached: false });
  store.intake.submitTurn(sessionId, { runId, input: "Hello" });
  const claimed = store.claims.claimTurn(sessionId, "worker_one")!;
  store.turnLifecycle.markRunning(sessionId, runId, claimed.claim!.token);
  return claimed.claim!.token;
}

/**
 * COUNT THE `requests.json` READS AROUND ONE CALL.
 *
 * `fs.readFileSync` rather than a stub store: the point is that the real read
 * path is not taken, and a spy on a seam the code could stop using would prove
 * nothing.
 */
function documentReads(suffixes: string[], action: () => void): number {
  const real = fs.readFileSync;
  let reads = 0;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
    if (typeof file === "string" && suffixes.some((suffix) => file.endsWith(suffix))) reads += 1;
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    action();
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = real;
  }
  return reads;
}

const requestDocumentReads = (action: () => void): number => documentReads(["requests.json"], action);

test("the index follows one request through open, resolve and retire", () => {
  const store = readyStore();
  const token = runningSession(store, "session_one", "run_one");

  // OPEN — the activity fold reads the index, so this is the index answering.
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  expect(store.records.get("session_one")).toMatchObject({ activity: "blocked", activityAt: 100 });
  expect(store.requestGate.resolutionsForWorker("worker_one")).toEqual([]);

  // RESOLVE — no longer blocking, and now deliverable to the blocked worker.
  store.requestGate.resolve("session_one", "req_1", { decision: "accept" });
  expect(store.records.get("session_one").activity).toBe("working");
  expect(store.requestGate.resolutionsForWorker("worker_one")).toEqual([
    { requestId: "req_1", sessionId: "session_one", runId: "run_one", decision: "accept" },
  ]);

  // RETIRE — the turn ends, so the resolution is no longer deliverable and the
  // document keeps it as history.
  store.turnLifecycle.stopSession("session_one");
  expect(store.requestGate.resolutionsForWorker("worker_one")).toEqual([]);
  expect(store.requestGate.list("session_one")).toMatchObject([{ id: "req_1", state: "resolved", decision: "accept" }]);
});

test("a request left open when its turn ends stops blocking the session", () => {
  // The retire path that is NOT a resolve: `closeOpenRequests` cancels it, and
  // the index has to let go of it too or the rail says "waiting on you" forever.
  const store = readyStore();
  const token = runningSession(store, "session_one", "run_one");
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  expect(store.records.get("session_one").activity).toBe("blocked");

  store.turnLifecycle.stopSession("session_one");
  expect(store.records.get("session_one").activity).toBe("idle");
  expect(store.requestGate.list("session_one")).toMatchObject([{ id: "req_1", state: "resolved", resolvedBy: "cancelled" }]);
});

test("a restart rebuilds the index from the documents", () => {
  const directory = root();
  const first = readyStore(directory);
  const token = runningSession(first, "session_one", "run_one");
  first.requestGate.open("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });

  // A second store over the same root has no index at all until it builds one.
  const second = new EngineStore(directory, () => 200, { notifier: () => true });
  expect(second.records.get("session_one")).toMatchObject({ activity: "blocked", activityAt: 100 });
  expect(second.requestGate.list("session_one")).toMatchObject([{ id: "req_1", state: "open" }]);

  // And the rebuilt index is maintained from there, not frozen at boot.
  second.requestGate.resolve("session_one", "req_1", { decision: "accept" });
  expect(second.records.get("session_one").activity).toBe("working");
});

test("the live-list fold reads no requests document", () => {
  const store = readyStore();
  for (const n of [1, 2, 3]) runningSession(store, `session_${n}`, `run_${n}`);
  // Warm the index once, the way a booting daemon does.
  store.live.all();

  expect(requestDocumentReads(() => {
    store.live.all();
    store.live.all();
  })).toBe(0);

  // And it is still the RIGHT answer, not merely a cheap one.
  const token = store.claims.claimTurn("session_1", "worker_one") ?? undefined;
  expect(token).toBeUndefined(); // already claimed by `runningSession`
  expect(store.live.all().sessions).toHaveLength(3);
});

test("a heartbeat with N claimed sessions does no whole-document request read", () => {
  const store = readyStore();
  const tokens = [1, 2, 3, 4, 5].map((n) => runningSession(store, `session_${n}`, `run_${n}`));
  // One parked request per session, so every one of them has something to find.
  tokens.forEach((token, at) => {
    const n = at + 1;
    store.requestGate.open(`session_${n}`, `run_${n}`, token, { requestId: `req_${n}`, kind: "command_execution", detail: bashDetail });
    store.requestGate.resolve(`session_${n}`, `req_${n}`, { decision: "accept" });
  });

  expect(requestDocumentReads(() => {
    for (let beat = 0; beat < 10; beat += 1) store.requestGate.resolutionsForWorker("worker_one");
  })).toBe(0);

  expect(store.requestGate.resolutionsForWorker("worker_one")).toHaveLength(5);
});

test("the index does not keep a resolution for a session no worker is on", () => {
  // The bound that stops the map growing with the age of the daemon: a session
  // whose queue stops concerning any worker cannot have anything polling it.
  const store = readyStore();
  const token = runningSession(store, "session_one", "run_one");
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });
  store.requestGate.resolve("session_one", "req_1", { decision: "accept" });
  expect(store.requestGate.resolutionsForWorker("worker_one")).toHaveLength(1);

  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "done" });
  expect(store.requestGate.resolutionsForWorker("worker_one")).toEqual([]);
  // The record is untouched: only the in-memory copy went.
  expect(store.requestGate.list("session_one")).toMatchObject([{ id: "req_1", state: "resolved" }]);
});

test("an existence check folds no activity", () => {
  // `readEvents`, `eventCursor`, `items`, `tasks` and the rest want one thing
  // from `getSession`: a not_found when the id names nothing. Paying an activity
  // fold for it meant three more documents parsed per call — and
  // `sessionSnapshot` makes seven such calls to open one conversation.
  const store = readyStore();
  const token = runningSession(store, "session_one", "run_one");
  store.requestGate.open("session_one", "run_one", token, { requestId: "req_1", kind: "command_execution", detail: bashDetail });

  expect(documentReads(["queue.json", "requests.json", "tasks.json"], () => {
    store.queries.readEvents("session_one");
    store.queries.eventCursor("session_one");
    store.queries.items("session_one");
  })).toBe(0);

  // And the check still fails on a session that is not there.
  expect(() => store.queries.readEvents("session_missing")).toThrow("session does not exist");
});

test("a requests document that is not this store's is rejected rather than trusted", () => {
  // "Validate on write, trust on read" only holds while the rows really were
  // this store's. A hand-edited document, imported from a legacy home, must
  // still fail loudly.
  const directory = root();
  const seeded = readyStore(directory);
  runningSession(seeded, "session_one", "run_one");
  toLegacyHome(seeded, directory);
  const file = path.join(directory, "sessions", "session_one", "requests.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, requests: [{ id: "req_1", state: "elsewhere" }] }));
  const store = new EngineStore(directory, () => 100, { notifier: () => true });
  expect(() => store.requestGate.list("session_one")).toThrow("invalid request projection");
});
