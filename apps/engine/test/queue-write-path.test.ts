/**
 * THE QUEUE DOCUMENT ON THE WRITE PATH — issue #547, the instrument.
 *
 * THE INSTRUMENT FIRST, AND FALSIFIED ON ITS OWN. Everything #547 goes on to
 * claim about the write path is counted rather than argued, so the counter has
 * to be worth something before it certifies anything: `readAccounting` could
 * not see `readQueue` at all, which means it read 0 before and 0 after a change
 * that doubled the wall time. These two tests are what go red if that is ever
 * true again.
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
