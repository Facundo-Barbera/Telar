/**
 * THE QUEUE DOCUMENT ON THE WRITE PATH — issue #547, steps 2 and 3.
 *
 * THE INSTRUMENT FIRST, AND FALSIFIED ON ITS OWN. Everything #547 claims about
 * the write path is counted rather than argued, so the counter has to be worth
 * something before it certifies anything: `readAccounting` could not see
 * `readQueue` at all, which means it read 0 before and 0 after a change that
 * doubled the wall time. The first two tests are what go red if that is ever
 * true again.
 *
 * THEN THE CLAIM: THE ROW'S FOLD NO LONGER RE-PARSES WHAT THE COMMAND JUST
 * WROTE. Measured, not asserted in prose — the parse counts below are exact,
 * and reverting the pass-through in `writeQueue` adds one to each of them. A
 * test that could not tell N from N+1 would not be testing this.
 *
 * THE COUNTS ARE ALSO A RATCHET. Fifteen whole-queue parses per turn survive
 * this issue (5 + 4 + 2 + 4), and they are written down on purpose: this issue
 * is about the write path reading the queue more often than it needs to, so a
 * change that moves these numbers is a change somebody should look at, in
 * either direction.
 *
 * AND THEN THE TRADE: VALIDATE ON WRITE, TRUST ON READ, with the refusal
 * surviving it. A turn that violates `Turn` must still be refused — at the
 * write now rather than at the read. Every
 * test below that asserts a refusal has a sibling asserting the same shape is
 * ACCEPTED where it should be, so "refuses everything" cannot pass here.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { ExecutionStore } from "../../platform/db/execution-store";
import { toLegacyHome } from "../../../test/store-internals";
import { SessionQueues } from "./queue";

const roots: string[] = [];
const stores: EngineStore[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-queue-write-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.kernel.executionStore.close(); } catch { /* the test closed it itself */ }
  }
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A clock that moves, so `activityAt` and `lastTurnEndedAt` are distinguishable. */
function open(directory: string, now?: () => number): EngineStore {
  let clock = 1_000;
  const store = new EngineStore(directory, now ?? (() => (clock += 1)));
  stores.push(store);
  return store;
}

function seeded(store: EngineStore, turns: number, sessionId = "session_one"): EngineStore {
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  store.lifecycle.createSession({ id: sessionId, projectId: "project_one" });
  for (let n = 0; n < turns; n += 1) {
    const runId = `run_seed_${n}`;
    store.intake.submitTurn(sessionId, { runId, input: `message ${n}` });
    const token = store.claims.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(sessionId, runId, token);
    store.turnLifecycle.completeTurn(sessionId, runId, token, { text: `answer ${n}` });
  }
  return store;
}

/** Whole-queue parses made by `action`, which is the number #547 is about. */
function queueParses(store: EngineStore, action: () => void): number {
  const before = store.kernel.readAccounting.queueParses;
  action();
  return store.kernel.readAccounting.queueParses - before;
}

// ── the instrument, falsified before anything is proved with it ──────────────

test("a whole-queue read is accounted for, bytes and all", () => {
  /**
   * THE COUNTER THIS SUITE USES, CHECKED AGAINST THE DOCUMENT ITSELF.
   *
   * `readAccounting` could not see `readQueue` at all before #547 — it was
   * called from the two windowed reads and nowhere else, so every whole-queue
   * read counted zero and a fold improvement proved with it would have read
   * 0 = 0 as success. This test is the one that goes red if that is true
   * again, and it is deliberately the first in the file.
   */
  const store = seeded(open(root()), 4);
  const turns = store.queries.turns("session_one");

  store.kernel.readAccounting.documentBytes = 0;
  store.kernel.readAccounting.documentReads = 0;
  store.kernel.readAccounting.queueParses = 0;
  // `turns()` is one `readQueue` and nothing else, which is what makes the
  // count below exactly one rather than "at least one".
  expect(store.queries.turns("session_one")).toEqual(turns);

  expect(store.kernel.readAccounting.documentReads).toBe(1);
  expect(store.kernel.readAccounting.queueParses).toBe(1);

  // AND THE BYTES ARE THE DOCUMENT'S BYTES: larger than the turns it holds, and
  // not by much — the rest is a version, a session id and a sequence.
  const rows = Buffer.byteLength(JSON.stringify(turns), "utf8");
  expect(store.kernel.readAccounting.documentBytes).toBeGreaterThanOrEqual(rows);
  expect(store.kernel.readAccounting.documentBytes).toBeLessThan(rows + 200);
});

test("a session whose queue document is missing is not counted as a read", () => {
  // `createSession` writes an empty queue, so the absent branch is reached by a
  // legacy home that lost the file; it must record nothing, not a zero-byte read.
  const directory = root();
  toLegacyHome(seeded(open(directory), 1), directory);
  fs.rmSync(path.join(directory, "sessions", "session_one", "queue.json"));
  const store = open(directory);
  store.kernel.readAccounting.documentReads = 0;
  store.kernel.readAccounting.queueParses = 0;
  expect(store.queries.turns("session_one")).toEqual([]);
  expect(store.kernel.readAccounting.documentReads).toBe(0);
  expect(store.kernel.readAccounting.queueParses).toBe(0);
});

// ── step 2: the row's fold reads nothing the command already wrote ───────────

test("a queue-writing command parses the queue a fixed number of times", () => {
  /**
   * THE NUMBERS, AND WHY THEY ARE WRITTEN DOWN RATHER THAN COMPARED.
   *
   * Each of the four transitions used to make one MORE whole-queue parse than
   * this: `storeSessionRow` fetched the document back out of the store and
   * re-parsed it to fold the activity, immediately after `writeQueue` had
   * serialised the very same object. Reverting that pass-through turns
   * 5/4/2/4 into 6/5/3/5, which is the red run this test exists to produce.
   */
  const store = seeded(open(root()), 5);

  expect(queueParses(store, () => store.intake.submitTurn("session_one", { runId: "run_x", input: "hello" }))).toBe(5);

  let token = "";
  expect(queueParses(store, () => { token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token; })).toBe(4);
  expect(queueParses(store, () => store.turnLifecycle.markRunning("session_one", "run_x", token))).toBe(2);
  expect(queueParses(store, () => store.turnLifecycle.completeTurn("session_one", "run_x", token, { text: "done" }))).toBe(4);

  // AND A WRITE THAT CANNOT HAVE MOVED THE QUEUE still reads it once and not
  // twice — `indexedSessionOf`'s carve-out means the row carries the folded
  // fields over rather than folding them again.
  expect(queueParses(store, () => store.lifecycle.updateSession("session_one", { title: "Renamed" }))).toBe(1);
});

test("the carried queue is the one the command wrote, at every transition", () => {
  // A pass-through that carried a STALE queue would keep the parse count at
  // 5/4/2/4 and put a wrong pill on the rail, so the folded row is pinned at
  // every transition. The clock only moves by hand.
  let clock = 1_000;
  const store = seeded(open(root(), () => clock), 3);

  const folded = (): unknown => {
    const row = store.live.rows({ all: true }).sessions.find((session) => session.id === "session_one")!;
    return {
      activity: row.activity,
      activityAt: row.activityAt,
      lastTurnEndedAt: row.lastTurnEndedAt,
      lastTurnFailed: row.lastTurnFailed,
      lastTurnSequence: row.lastTurnSequence,
    };
  };
  const idle = (endedAt: number, sequence: number) =>
    ({ activity: "idle", activityAt: undefined, lastTurnEndedAt: endedAt, lastTurnFailed: undefined, lastTurnSequence: sequence });
  const busy = (activity: string, at: number) =>
    ({ activity, activityAt: at, lastTurnEndedAt: 1_000, lastTurnFailed: undefined, lastTurnSequence: 3 });

  expect(folded()).toEqual(idle(1_000, 3));
  const step = (action: () => void, expected: unknown): void => {
    clock += 10;
    action();
    expect(folded()).toEqual(expected);
  };

  let token = "";
  step(() => store.intake.submitTurn("session_one", { runId: "run_x", input: "hello" }), busy("queued", 1_010));
  step(() => { token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token; }, busy("queued", 1_010));
  step(() => store.turnLifecycle.markRunning("session_one", "run_x", token), busy("working", 1_030));
  step(() => store.turnLifecycle.completeTurn("session_one", "run_x", token, { text: "done" }), idle(1_040, 4));
  // A metadata-only write must not disturb what the queue write folded.
  step(() => store.lifecycle.updateSession("session_one", { title: "Renamed" }), idle(1_040, 4));
});

// ── step 3: validate on write, trust on read, refuse either way ──────────────

/** A turn that satisfies the structural guard and violates `Turn`. */
const malformedTurn = (sessionId: string, sequence: number): Record<string, unknown> => ({
  runId: "run_bad",
  sessionId,
  sequence,
  state: "completed",
  // `input` is `z.string()`. A number passes the four structural fields and
  // fails the schema, which is exactly the gap trust-on-read opens.
  input: 42,
  acceptedAt: 1,
  updatedAt: 1,
});

/** Put an exact queue document into the store's database, behind its back. */
function injectQueue(directory: string, sessionId: string, document: unknown): void {
  const raw = new ExecutionStore(directory);
  try {
    raw.transaction("test-inject", () => {
      raw.writeText(path.join(directory, "sessions", sessionId, "queue.json"), JSON.stringify(document));
      // The offset index describes bytes that have just moved, so it is
      // invalidated rather than left to be trusted — the same marker
      // `writeIndexedDocument` writes when it cannot index a document.
      raw.write(path.join(directory, "sessions", sessionId, "queue.index.json"), { version: 2, length: -1, rows: [] });
    });
  } finally {
    raw.close();
  }
}

test("a malformed turn in the store is refused at the write, not let through", () => {
  /**
   * THE TRADE THIS STEP MAKES, IN BOTH DIRECTIONS.
   *
   * The schema walk no longer runs per read, so a turn that violates
   * `Turn` is READ without complaint — that is the saving, and pretending
   * otherwise would be testing the wrong thing. What must not change is that
   * the store refuses to carry it: the next write validates every turn and
   * throws, so the bad row cannot be written back and cannot spread.
   */
  const directory = root();
  const first = seeded(open(directory), 2);
  const seededTurns = first.queries.turns("session_one");
  const queue = { version: 2, sessionId: "session_one", nextSequence: 9, turns: [...seededTurns, malformedTurn("session_one", 8)] };
  first.kernel.executionStore.close();
  stores.splice(stores.indexOf(first), 1);

  injectQueue(directory, "session_one", queue);

  const store = open(directory);
  // READ: trusted, so the row reaches the caller rather than throwing.
  expect(store.queries.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_bad"]);

  // WRITE: refused, with the turn still on file rather than half-replaced.
  expect(() => store.intake.submitTurn("session_one", { runId: "run_next", input: "hello" })).toThrow(/invalid session queue/);
  expect(store.queries.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_bad"]);

  // …and a well-formed turn in the same position is accepted, so this is a
  // guard rather than a store that has stopped writing.
  const clean = { ...queue, turns: seededTurns };
  store.kernel.executionStore.close();
  stores.splice(stores.indexOf(store), 1);
  injectQueue(directory, "session_one", clean);
  const healthy = open(directory);
  healthy.intake.submitTurn("session_one", { runId: "run_next", input: "hello" });
  expect(healthy.queries.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_next"]);
});

test("a structurally broken turn is refused on read", () => {
  // The four fields every reader keys on are still checked, so a document a
  // downgrade or a migration left behind fails as "invalid session queue"
  // rather than as an `undefined` on the rail.
  const directory = root();
  const first = seeded(open(directory), 2);
  const turns = first.queries.turns("session_one");
  first.kernel.executionStore.close();
  stores.splice(stores.indexOf(first), 1);

  for (const broken of [
    { ...turns[0]!, runId: undefined },
    { ...turns[0]!, sessionId: 7 },
    { ...turns[0]!, sequence: "second" },
    { ...turns[0]!, state: "mid-flight" },
  ]) {
    injectQueue(directory, "session_one", { version: 2, sessionId: "session_one", nextSequence: 3, turns: [broken] });
    const store = open(directory);
    expect(() => store.queries.turns("session_one")).toThrow(/invalid session queue/);
    store.kernel.executionStore.close();
    stores.splice(stores.indexOf(store), 1);
  }

  // AND THE SAME ROW, INTACT, READS FINE — four refusals mean nothing without
  // this line.
  injectQueue(directory, "session_one", { version: 2, sessionId: "session_one", nextSequence: 3, turns: [turns[0]!] });
  expect(open(directory).queries.turns("session_one")).toEqual([turns[0]!]);
});

test("the scan cache keeps live queues and only the most recently scanned idle ones", () => {
  const store = open(root());
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  const ids = Array.from({ length: 100 }, (_, n) => `session_${n}`);
  for (const id of ids) store.lifecycle.createSession({ id, projectId: "project_one" });
  store.intake.submitTurn("session_0", { runId: "run_live", input: "hello" });
  const queues = new SessionQueues(store.kernel, { sessionIds: () => ids, itemsForRuns: () => [], afterWrite: () => {} });
  expect([...queues.liveSessionIds()]).toEqual(["session_0"]);
  for (const id of ids) queues.scan(id);

  expect(queueParses(store, () => queues.scan("session_0"))).toBe(0);
  expect(queueParses(store, () => { for (const id of ids.slice(-32)) queues.scan(id); })).toBe(0);
  expect(queueParses(store, () => queues.scan("session_1"))).toBe(1);
});

test("a cold live-queue build reads the live queues only, however long the history", () => {
  const directory = root();
  const store = seeded(open(directory), 1);
  const ids = ["session_one"];
  for (let n = 0; n < 60; n += 1) {
    const id = `session_done_${n}`;
    ids.push(id);
    seeded(store, 1, id);
  }
  store.lifecycle.createSession({ id: "session_queued", projectId: "project_one" });
  store.intake.submitTurn("session_queued", { runId: "run_queued", input: "hello" });
  store.lifecycle.createSession({ id: "session_stopped", projectId: "project_one" });
  store.intake.submitTurn("session_stopped", { runId: "run_stopped", input: "hello" });
  store.claims.claimTurn("session_stopped", "worker_one");
  store.turnLifecycle.stopTurn("session_stopped", "run_stopped");
  ids.push("session_queued", "session_stopped");
  const queues = (on: EngineStore) => new SessionQueues(on.kernel, { sessionIds: () => ids, itemsForRuns: () => [], afterWrite: () => {} });

  let first: Set<string> = new Set();
  expect(queueParses(store, () => { first = queues(store).liveSessionIds(); })).toBe(ids.length);
  expect([...first].sort()).toEqual(["session_queued", "session_stopped"]);
  store.kernel.executionStore.close();
  stores.splice(stores.indexOf(store), 1);

  const reopened = open(directory);
  let cold: Set<string> = new Set();
  expect(queueParses(reopened, () => { cold = queues(reopened).liveSessionIds(); })).toBeLessThanOrEqual(2);
  expect([...cold].sort()).toEqual(["session_queued", "session_stopped"]);

  const token = reopened.claims.claimTurn("session_queued", "worker_two")!.claim!.token;
  reopened.turnLifecycle.markRunning("session_queued", "run_queued", token);
  reopened.turnLifecycle.completeTurn("session_queued", "run_queued", token, { text: "done" });
  expect([...queues(reopened).liveSessionIds()]).toEqual(["session_stopped"]);
});
