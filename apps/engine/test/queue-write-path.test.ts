/**
 * THE QUEUE DOCUMENT ON THE WRITE PATH — issue #547, step 2.
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
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

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
