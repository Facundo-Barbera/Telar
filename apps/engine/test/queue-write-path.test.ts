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
 * write now rather than at the read, and on the JSON backend at both. Every
 * test below that asserts a refusal has a sibling asserting the same shape is
 * ACCEPTED where it should be, so "refuses everything" cannot pass here.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { ExecutionStore } from "../src/execution-store";

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
    try { store.closeExecutionStore(); } catch { /* the test closed it itself */ }
  }
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Backend = "sqlite" | "json";
const BACKENDS: Backend[] = ["sqlite", "json"];

/** A clock that moves, so `activityAt` and `lastTurnEndedAt` are distinguishable. */
function open(directory: string, backend: Backend, now?: () => number): EngineStore {
  let clock = 1_000;
  const store = new EngineStore(directory, now ?? (() => (clock += 1)), backend === "sqlite" ? { executionStorage: "sqlite" } : {});
  stores.push(store);
  return store;
}

function seeded(store: EngineStore, turns: number, sessionId = "session_one"): EngineStore {
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: sessionId, projectId: "project_one" });
  for (let n = 0; n < turns; n += 1) {
    const runId = `run_seed_${n}`;
    store.submitTurn(sessionId, { runId, input: `message ${n}` });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.completeTurn(sessionId, runId, token, { text: `answer ${n}` });
  }
  return store;
}

/** Whole-queue parses made by `action`, which is the number #547 is about. */
function queueParses(store: EngineStore, action: () => void): number {
  const before = store.readAccounting.queueParses;
  action();
  return store.readAccounting.queueParses - before;
}

// ── the instrument, falsified before anything is proved with it ──────────────

for (const backend of BACKENDS) {
  test(`a whole-queue read is accounted for, bytes and all (${backend})`, () => {
    /**
     * THE COUNTER THIS SUITE USES, CHECKED AGAINST THE DOCUMENT ITSELF.
     *
     * `readAccounting` could not see `readQueue` at all before #547 — it was
     * called from the two windowed reads and nowhere else, so every whole-queue
     * read counted zero and a fold improvement proved with it would have read
     * 0 = 0 as success. This test is the one that goes red if that is true
     * again, and it is deliberately the first in the file.
     */
    const directory = root();
    const store = seeded(open(directory, backend), 4);
    const turns = store.turns("session_one");

    store.readAccounting.documentBytes = 0;
    store.readAccounting.documentReads = 0;
    store.readAccounting.queueParses = 0;
    // `turns()` is one `readQueue` and nothing else, which is what makes the
    // count below exactly one rather than "at least one".
    expect(store.turns("session_one")).toEqual(turns);

    expect(store.readAccounting.documentReads).toBe(1);
    expect(store.readAccounting.queueParses).toBe(1);

    /**
     * AND THE BYTES ARE THE DOCUMENT'S BYTES, not a number that is merely
     * positive. On the JSON backend that is exactly the file on disk, which is
     * the strongest form this can take. SQLite stores the same document
     * compactly and there is no file to stat, so it is pinned to the turns it
     * holds instead: larger than them, and not by much — the rest of the
     * document is a version, a session id and a sequence.
     */
    if (backend === "json") {
      expect(store.readAccounting.documentBytes).toBe(fs.statSync(path.join(directory, "sessions", "session_one", "queue.json")).size);
    } else {
      const rows = Buffer.byteLength(JSON.stringify(turns), "utf8");
      expect(store.readAccounting.documentBytes).toBeGreaterThanOrEqual(rows);
      expect(store.readAccounting.documentBytes).toBeLessThan(rows + 200);
    }
  });
}

test("a session whose queue document is missing is not counted as a read", () => {
  // The floor this would otherwise put under every measurement. `createSession`
  // writes an empty queue, so the only way to reach the absent branch is a home
  // that lost the file — a partial restore, a hand-edited directory — and the
  // accounting must record nothing rather than a zero-byte read.
  const directory = root();
  const store = seeded(open(directory, "json"), 1);
  fs.rmSync(path.join(directory, "sessions", "session_one", "queue.json"));
  store.readAccounting.documentReads = 0;
  store.readAccounting.queueParses = 0;
  expect(store.turns("session_one")).toEqual([]);
  expect(store.readAccounting.documentReads).toBe(0);
  expect(store.readAccounting.queueParses).toBe(0);
});

// ── step 2: the row's fold reads nothing the command already wrote ───────────

for (const backend of BACKENDS) {
  test(`a queue-writing command parses the queue a fixed number of times (${backend})`, () => {
    /**
     * THE NUMBERS, AND WHY THEY ARE WRITTEN DOWN RATHER THAN COMPARED.
     *
     * Each of the four transitions used to make one MORE whole-queue parse than
     * this: `storeSessionRow` fetched the document back out of the store and
     * re-parsed it to fold the activity, immediately after `writeQueue` had
     * serialised the very same object. Reverting that pass-through turns
     * 5/4/2/4 into 6/5/3/5 on sqlite, which is the red run this test exists to
     * produce.
     *
     * THE JSON BACKEND IS THE CONTROL, not a second copy of the same proof. It
     * has no index row at all — `indexedSessionOf` returns nothing without an
     * execution store — so it never made the extra parse and reverting the
     * pass-through does not move it. The two agreeing on 5/4/2/4 is the
     * statement that sqlite now reads the queue as many times as a store with
     * no row to fold, and no more.
     */
    const store = seeded(open(root(), backend), 5);

    expect(queueParses(store, () => store.submitTurn("session_one", { runId: "run_x", input: "hello" }))).toBe(5);

    let token = "";
    expect(queueParses(store, () => { token = store.claimTurn("session_one", "worker_one")!.claim!.token; })).toBe(4);
    expect(queueParses(store, () => store.markRunning("session_one", "run_x", token))).toBe(2);
    expect(queueParses(store, () => store.completeTurn("session_one", "run_x", token, { text: "done" }))).toBe(4);

    // AND A WRITE THAT CANNOT HAVE MOVED THE QUEUE still reads it once and not
    // twice — `indexedSessionOf`'s carve-out means the row carries the folded
    // fields over rather than folding them again.
    expect(queueParses(store, () => store.updateSession("session_one", { title: "Renamed" }))).toBe(1);
  });
}

test("the carried queue is the one the command wrote, at every transition", () => {
  /**
   * THE COUNT IS HALF THE CLAIM; THIS IS THE OTHER HALF.
   *
   * A pass-through that carried a STALE queue — the first of two writes in one
   * command, or an object edited after the write — would keep the parse count
   * at 5/4/2/4 and put a wrong pill on the rail. So the folded row is compared,
   * transition by transition, against the same conversation folded from the
   * documents on a store that has no index at all: `session-index.test.ts`'
   * argument, applied to the write path rather than the read.
   */
  /**
   * ONE CLOCK FOR BOTH, ADVANCED BY HAND. A clock that ticks per `now()` call
   * gives the two backends different timestamps for the same transition — they
   * do not read the clock the same number of times — and the comparison below
   * would then fail for a reason that is not the thing under test.
   */
  let clock = 1_000;
  const tick = (): number => clock;
  const indexed = seeded(open(root(), "sqlite", tick), 3);
  const documents = seeded(open(root(), "json", tick), 3);

  const folded = (store: EngineStore): unknown => {
    const row = store.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_one")!;
    return {
      activity: row.activity,
      activityAt: row.activityAt,
      lastTurnEndedAt: row.lastTurnEndedAt,
      lastTurnFailed: row.lastTurnFailed,
      lastTurnSequence: row.lastTurnSequence,
    };
  };

  // The seeded conversations already agree, which is the baseline the steps
  // below are read against.
  expect(folded(indexed)).toEqual(folded(documents));
  expect(folded(indexed)).toMatchObject({ activity: "idle", lastTurnSequence: 3 });

  const step = (action: (store: EngineStore) => void, expected: Record<string, unknown>): void => {
    clock += 10;
    action(indexed);
    action(documents);
    expect(folded(indexed)).toEqual(folded(documents));
    // …and it is the state we meant, not two stores agreeing on the old answer.
    expect(folded(indexed)).toMatchObject(expected);
  };

  step((store) => store.submitTurn("session_one", { runId: "run_x", input: "hello" }), { activity: "queued" });
  const tokens = new Map<EngineStore, string>();
  step((store) => { tokens.set(store, store.claimTurn("session_one", "worker_one")!.claim!.token); }, { activity: "queued" });
  step((store) => store.markRunning("session_one", "run_x", tokens.get(store)!), { activity: "working" });
  step((store) => store.completeTurn("session_one", "run_x", tokens.get(store)!, { text: "done" }), { activity: "idle", lastTurnSequence: 4 });

  // A metadata-only write afterwards must not disturb what the queue write
  // folded — this is the carry-over half of `indexedSessionOf`, still working.
  step((store) => store.updateSession("session_one", { title: "Renamed" }), { activity: "idle", lastTurnSequence: 4 });
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
   * On sqlite the schema walk no longer runs per read, so a turn that violates
   * `Turn` is READ without complaint — that is the saving, and pretending
   * otherwise would be testing the wrong thing. What must not change is that
   * the store refuses to carry it: the next write validates every turn and
   * throws, so the bad row cannot be written back and cannot spread.
   */
  const directory = root();
  const first = seeded(open(directory, "sqlite"), 2);
  const seededTurns = first.turns("session_one");
  const queue = { version: 2, sessionId: "session_one", nextSequence: 9, turns: [...seededTurns, malformedTurn("session_one", 8)] };
  first.closeExecutionStore();
  stores.splice(stores.indexOf(first), 1);

  injectQueue(directory, "session_one", queue);

  const store = open(directory, "sqlite");
  // READ: trusted, so the row reaches the caller rather than throwing.
  expect(store.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_bad"]);

  // WRITE: refused, with the turn still on file rather than half-replaced.
  expect(() => store.submitTurn("session_one", { runId: "run_next", input: "hello" })).toThrow(/invalid session queue/);
  expect(store.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_bad"]);

  // …and a well-formed turn in the same position is accepted, so this is a
  // guard rather than a store that has stopped writing.
  const clean = { ...queue, turns: seededTurns };
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);
  injectQueue(directory, "session_one", clean);
  const healthy = open(directory, "sqlite");
  healthy.submitTurn("session_one", { runId: "run_next", input: "hello" });
  expect(healthy.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1", "run_next"]);
});

test("a structurally broken turn is refused on read, on the backend that trusts", () => {
  /**
   * TRUST IS ABOUT WHICH PROCESS WROTE THE BYTES, NOT THAT THEY ARE THERE.
   *
   * The four fields every reader keys on are checked on both backends, so a
   * document a downgrade or a migration left behind fails as "invalid session
   * queue" rather than as an `undefined` on the rail.
   */
  const directory = root();
  const first = seeded(open(directory, "sqlite"), 2);
  const turns = first.turns("session_one");
  first.closeExecutionStore();
  stores.splice(stores.indexOf(first), 1);

  for (const broken of [
    { ...turns[0]!, runId: undefined },
    { ...turns[0]!, sessionId: 7 },
    { ...turns[0]!, sequence: "second" },
    { ...turns[0]!, state: "mid-flight" },
  ]) {
    injectQueue(directory, "session_one", { version: 2, sessionId: "session_one", nextSequence: 3, turns: [broken] });
    const store = open(directory, "sqlite");
    expect(() => store.turns("session_one")).toThrow(/invalid session queue/);
    store.closeExecutionStore();
    stores.splice(stores.indexOf(store), 1);
  }

  // AND THE SAME ROW, INTACT, READS FINE — four refusals mean nothing without
  // this line.
  injectQueue(directory, "session_one", { version: 2, sessionId: "session_one", nextSequence: 3, turns: [turns[0]!] });
  expect(open(directory, "sqlite").turns("session_one")).toEqual([turns[0]!]);
});

test("the JSON backend still validates every turn on read", () => {
  /**
   * THE REFERENCE BACKEND KEEPS THE FULL WALK, and this is what says so. A
   * `queue.json` is an ordinary file — a test rewrites it, an older engine
   * wrote it, a person can open it — so nothing about which process wrote it
   * can be assumed, and the schema is the only thing that knows the difference
   * between `input: "hello"` and `input: 42`.
   */
  const directory = root();
  const store = seeded(open(directory, "json"), 2);
  const file = path.join(directory, "sessions", "session_one", "queue.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8")) as { turns: unknown[]; nextSequence: number };

  fs.writeFileSync(file, JSON.stringify({ ...document, turns: [...document.turns, malformedTurn("session_one", 8)] }));
  expect(() => store.turns("session_one")).toThrow(/invalid session queue/);

  // The same document without the bad turn reads, so the refusal above is the
  // turn and not the rewrite.
  fs.writeFileSync(file, JSON.stringify(document));
  expect(store.turns("session_one").map((turn) => turn.runId)).toEqual(["run_seed_0", "run_seed_1"]);
});
