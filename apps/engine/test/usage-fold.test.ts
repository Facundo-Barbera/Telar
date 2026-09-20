/**
 * A TURN'S `usage.updated` ROWS, FOLDED INTO ONE AGGREGATE — issue #697.
 *
 * A token count is restated after every item, so a turn leaves as many of these
 * rows as it had envelopes and only the last one is ever read. What must not
 * drift, and why each of these is a test rather than a sentence in a PR:
 *
 *   - THE WATERMARK IS ITS OWN. Reusing `journal-compacted/` would start every
 *     already-compacted session past the whole backlog and report success. The
 *     first test compacts the fixture and folds it second; on a shared key it
 *     finds nothing.
 *   - THE AGGREGATE IS A SUM, NOT THE SURVIVOR. A Codex turn emits one row per
 *     CALL and no total at all, so the last row is the last call's tokens and
 *     nothing else. The non-monotonic fixture (1200/400/900) is what tells the
 *     two implementations apart.
 *   - THE FOLD IS INVISIBLE TO THE TRANSCRIPT. Replayed through the production
 *     fold — `apps/web/lib/engine/journal.ts`, the same function the cockpit
 *     runs — a folded turn's `usage` must be identical to an unfolded one's.
 *     The fixture whose `contextUsed` DROPS mid-turn is the one that catches a
 *     "keep the biggest" fold: occupancy is not a counter.
 *   - COUNTS AND VALUES, NEVER MARKERS. Every assertion below is a row count, a
 *     token total or a file size. A test that greps for a name it wrote itself
 *     passes when the code does nothing.
 *   - AND A DELETE RETURNS NO BYTES. The sweep alone leaves the file exactly as
 *     big as it was; only Reclaim's VACUUM changes that.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution-store";
import { projectJournal } from "../../web/lib/engine/journal";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function open(prefix: string): { root: string; store: ExecutionStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  return { root, store: new ExecutionStore(root) };
}

type Tokens = { input?: number; output?: number; cacheRead?: number; cacheCreate?: number; reasoning?: number };

/** A session's journal, written by hand. `at` is fixed: nothing here is about
 *  time, and a clock in a fixture is a flake waiting for a slow machine. */
function journal(root: string, store: ExecutionStore, sessionId: string) {
  store.write(path.join(root, "sessions", sessionId, "session.json"), { id: sessionId });
  let id = 0;
  const at = Date.parse("2026-09-01T00:00:00Z");
  return {
    get lastId() { return id; },
    usage: (runId: string, tokens: Tokens, extra: { contextUsed?: number; contextMax?: number; costUsd?: number } = {}) =>
      store.append({
        id: ++id, at, sessionId, runId, type: "usage.updated",
        usage: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...tokens },
          ...extra,
        },
      } as never),
    start: (runId: string, itemId: string) => store.append({
      id: ++id, at, sessionId, runId, type: "item.started",
      item: { id: itemId, runId, sessionId, status: "inProgress", detail: { type: "assistant_message", text: "" }, startedAt: at },
    } as never),
    delta: (runId: string, itemId: string, text: string) => store.append({
      id: ++id, at, sessionId, runId, type: "content.delta", itemId, stream: "assistant_text", text,
    } as never),
    complete: (runId: string, itemId: string, text: string) => store.append({
      id: ++id, at, sessionId, runId, type: "item.completed",
      item: { id: itemId, runId, sessionId, status: "completed", detail: { type: "assistant_message", text }, startedAt: at, completedAt: at },
    } as never),
    endTurn: (runId: string) => store.append({ id: ++id, at, sessionId, runId, type: "turn.completed", resultText: "done" } as never),
  };
}

/** The `turn_summaries` row a settled turn has in production — the fold refuses
 *  to delete anything for a turn that has nowhere to record the sum. */
function summarise(store: ExecutionStore, sessionId: string, runId: string, sequence = 1): void {
  store.writeTurnSummary({
    sessionId, runId, sequence, state: "completed",
    input: "hello", itemCount: 1, itemTitles: [], answerHead: "done", answerChars: 4,
  });
}

const usageRows = (store: ExecutionStore, sessionId: string) =>
  store.events(sessionId).filter((event) => event.type === "usage.updated");

/** The turn as the cockpit would draw it, folded by the production projector. */
function replayedUsage(store: ExecutionStore, sessionId: string, runId: string) {
  const turns = [{ runId, input: "hello", state: "completed" as const }];
  return projectJournal(turns as never, [], store.events(sessionId) as never)[0]?.usage;
}

/* ------------------------------------------------------------------ *
 * The watermark, which is the whole reason this is a separate key.
 * ------------------------------------------------------------------ */

test("a journal that was compacted first still has its usage rows found", () => {
  const { root, store } = open("telar-usage-watermark-");
  try {
    const write = journal(root, store, "session_one");
    write.start("run_one", "item_one");
    write.usage("run_one", { input: 100, output: 10 });
    write.delta("run_one", "item_one", "Once upon ");
    write.usage("run_one", { input: 100, output: 20 });
    write.delta("run_one", "item_one", "a time");
    write.usage("run_one", { input: 100, output: 30 });
    write.complete("run_one", "item_one", "Once upon a time");
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    // THE COMPACTION GOES FIRST, and it moves its own watermark to the terminal
    // turn event. A fold sharing that key would read `low` as that id, see
    // nothing below it, and report a clean sweep over three untouched rows.
    expect(store.compactJournal()).toEqual({ deltas: 2, starts: 1, sessions: 1 });
    expect(usageRows(store, "session_one")).toHaveLength(3);

    const folded = store.foldJournalUsage();
    expect(folded).toEqual({ rows: 2, turns: 1, sessions: 1, refused: 0 });
    expect(usageRows(store, "session_one")).toHaveLength(1);
    expect(store.turnUsage("session_one", "run_one")).toEqual({
      tokens: { input: 300, output: 60, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
      rows: 3,
    });
  } finally { store.close(); }
});

test("a second fold moves nothing, and does not sum a range the first one shrank", () => {
  const { root, store } = open("telar-usage-idempotent-");
  try {
    const write = journal(root, store, "session_one");
    write.usage("run_one", { input: 100, output: 1200 });
    write.usage("run_one", { input: 200, output: 400 });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    expect(store.foldJournalUsage()).toEqual({ rows: 1, turns: 1, sessions: 1, refused: 0 });
    const first = store.turnUsage("session_one", "run_one");
    expect(first).toEqual({ tokens: { input: 300, output: 1600, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, rows: 2 });

    // The watermark alone would carry this, but the fold also seeks on a NULL
    // aggregate: a turn folded twice would add up one surviving row and write
    // 400 over 1600. Both halves are asserted by the same call.
    expect(store.foldJournalUsage()).toEqual({ rows: 0, turns: 0, sessions: 0, refused: 0 });
    expect(store.turnUsage("session_one", "run_one")).toEqual(first!);
  } finally { store.close(); }
});

/* ------------------------------------------------------------------ *
 * The sum, against the survivor.
 * ------------------------------------------------------------------ */

test("a Codex-shaped turn keeps its spend, which its last row does not hold", () => {
  const { root, store } = open("telar-usage-codex-");
  try {
    const write = journal(root, store, "session_one");
    /**
     * `codexUsage` reads `tokenUsage.last` — one call's tokens, never the
     * thread's running total — so these three are three calls and the sequence
     * is not monotonic. 1200 + 400 + 900 is what the turn spent; 900 is what a
     * fold that kept the survivor would record, and the difference is the
     * entire reason the aggregate is a sum.
     */
    write.usage("run_one", { input: 3_000, output: 1200, cacheRead: 100, reasoning: 64 });
    write.usage("run_one", { input: 4_100, output: 400, cacheRead: 2_900, reasoning: 16 });
    write.usage("run_one", { input: 4_600, output: 900, cacheRead: 4_000, reasoning: 32 });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    expect(store.foldJournalUsage()).toEqual({ rows: 2, turns: 1, sessions: 1, refused: 0 });
    expect(store.turnUsage("session_one", "run_one")).toEqual({
      tokens: { input: 11_700, output: 2_500, cacheRead: 7_000, cacheCreate: 0, reasoning: 112 },
      rows: 3,
    });
    // And exactly one row is left, carrying the last call — which is what the
    // meter reads and what the survivor was always worth.
    const kept = usageRows(store, "session_one");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ usage: { tokens: { output: 900 } } });
  } finally { store.close(); }
});

test("the aggregate is written for exactly the turns folded and left null for the rest", () => {
  const { root, store } = open("telar-usage-counts-");
  try {
    const write = journal(root, store, "session_one");
    write.usage("run_one", { input: 10, output: 1 });
    write.usage("run_one", { input: 20, output: 2 });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one", 1);
    // A second turn that has NOT ended. Its rows sit above the session's last
    // terminal event and must be untouched.
    write.usage("run_two", { input: 30, output: 3 });
    write.usage("run_two", { input: 40, output: 4 });
    summarise(store, "session_one", "run_two", 2);

    expect(store.foldJournalUsage()).toEqual({ rows: 1, turns: 1, sessions: 1, refused: 0 });
    expect(store.turnUsage("session_one", "run_one")).toEqual({
      tokens: { input: 30, output: 3, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, rows: 2,
    });
    expect(store.turnUsage("session_one", "run_two")).toBeUndefined();
    expect(usageRows(store, "session_one").filter((event) => event.runId === "run_two")).toHaveLength(2);

    // …and once it ends, it folds on the next sweep like any other.
    write.endTurn("run_two");
    expect(store.foldJournalUsage()).toEqual({ rows: 1, turns: 1, sessions: 1, refused: 0 });
    expect(store.turnUsage("session_one", "run_two")).toEqual({
      tokens: { input: 70, output: 7, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, rows: 2,
    });
  } finally { store.close(); }
});

test("a turn with nowhere to record the sum keeps every row it has", () => {
  const { root, store } = open("telar-usage-refused-");
  try {
    const write = journal(root, store, "session_one");
    write.usage("run_one", { input: 10, output: 1 });
    write.usage("run_one", { input: 20, output: 2 });
    write.endTurn("run_one");
    // No `turn_summaries` row: the aggregate has nowhere to go, so the delete
    // is refused rather than taken on the promise of writing it somewhere.
    expect(store.foldJournalUsage()).toEqual({ rows: 0, turns: 0, sessions: 0, refused: 1 });
    expect(usageRows(store, "session_one")).toHaveLength(2);
  } finally { store.close(); }
});

/* ------------------------------------------------------------------ *
 * Replay equivalence, through the fold the cockpit actually runs.
 * ------------------------------------------------------------------ */

test("a turn whose context occupancy drops mid-turn replays identically after the fold", () => {
  const { root, store } = open("telar-usage-replay-");
  try {
    const write = journal(root, store, "session_one");
    /**
     * `contextUsed` IS OCCUPANCY, NOT A COUNTER. A provider compaction empties
     * the window mid-turn, so the third row reports LESS than the second. A
     * fold that kept the biggest row — a plausible reading of "keep the one
     * that matters" — would leave 180_000 here and the meter would draw a
     * window that is not the one the turn ended in.
     */
    write.usage("run_one", { input: 1_000, output: 10 }, { contextUsed: 90_000, contextMax: 200_000 });
    write.usage("run_one", { input: 2_000, output: 20 }, { contextUsed: 180_000, contextMax: 200_000 });
    write.usage("run_one", { input: 3_000, output: 30 }, { contextUsed: 40_000, contextMax: 200_000 });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    const before = replayedUsage(store, "session_one", "run_one");
    expect(before).toEqual({
      tokens: { input: 3_000, output: 30, cacheRead: 0, cacheCreate: 0 },
      contextUsed: 40_000, contextMax: 200_000,
    });

    expect(store.foldJournalUsage()).toEqual({ rows: 2, turns: 1, sessions: 1, refused: 0 });
    expect(replayedUsage(store, "session_one", "run_one")).toEqual(before!);
  } finally { store.close(); }
});

test("a Claude-shaped turn keeps the priced total the transcript reads", () => {
  const { root, store } = open("telar-usage-claude-");
  try {
    const write = journal(root, store, "session_one");
    // Claude restates: two envelopes, then the `result` message carrying the
    // authoritative total AND the price. The last row is the turn, and the fold
    // must not move it — the sum beside it is the restatements added up, which
    // is why `usage_rows` is stored rather than the number being called a total.
    write.usage("run_one", { input: 1_000, output: 500 });
    write.usage("run_one", { input: 1_600, output: 120 });
    write.usage("run_one", { input: 2_600, output: 620 }, { costUsd: 0.42, contextUsed: 3_220, contextMax: 200_000 });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    const before = replayedUsage(store, "session_one", "run_one");
    expect(store.foldJournalUsage()).toEqual({ rows: 2, turns: 1, sessions: 1, refused: 0 });
    expect(replayedUsage(store, "session_one", "run_one")).toEqual(before!);
    // The price is on the surviving row, untouched and un-summed.
    expect(usageRows(store, "session_one")[0]).toMatchObject({ usage: { costUsd: 0.42 } });
    expect(store.turnUsage("session_one", "run_one")).toEqual({
      tokens: { input: 5_200, output: 1_240, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, rows: 3,
    });
  } finally { store.close(); }
});

/* ------------------------------------------------------------------ *
 * What the sweep costs, and what it does not return.
 * ------------------------------------------------------------------ */

test("the sweep alone leaves the file exactly as big; Reclaim is what shrinks it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-bytes-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  const file = path.join(root, "execution.sqlite");
  try {
    const write = journal(root, store, "session_one");
    for (let turn = 0; turn < 20; turn += 1) {
      const runId = `run_${turn}`;
      for (let row = 0; row < 60; row += 1) write.usage(runId, { input: 1_000 + row, output: row, cacheRead: row * 2 });
      write.endTurn(runId);
      summarise(store, "session_one", runId, turn);
    }
    expect(usageRows(store, "session_one")).toHaveLength(1_200);

    const folded = store.foldJournalUsage();
    expect(folded).toEqual({ rows: 1_180, turns: 20, sessions: 1, refused: 0 });
    expect(usageRows(store, "session_one")).toHaveLength(20);

    // #646's fact 1, which this inherits: a DELETE moves pages to the freelist
    // and returns nothing to the filesystem.
    const afterSweep = fs.statSync(file).size;
    const reclaimed = store.reclaim();
    expect(reclaimed.usage).toBe(0); // nothing left to fold — the sweep took it
    expect(fs.statSync(file).size).toBeLessThan(afterSweep);
    expect(reclaimed.after).toBeLessThan(reclaimed.before);
  } finally { store.close(); }
});

test("Reclaim folds the rows the daily sweep has not reached yet", () => {
  const { root, store } = open("telar-usage-reclaim-");
  try {
    const write = journal(root, store, "session_one");
    for (let row = 0; row < 8; row += 1) write.usage("run_one", { input: 100, output: row });
    write.endTurn("run_one");
    summarise(store, "session_one", "run_one");

    const reclaimed = store.reclaim();
    expect(reclaimed.usage).toBe(7);
    expect(usageRows(store, "session_one")).toHaveLength(1);
    expect(store.turnUsage("session_one", "run_one")).toEqual({
      tokens: { input: 800, output: 28, cacheRead: 0, cacheCreate: 0, reasoning: 0 }, rows: 8,
    });
  } finally { store.close(); }
});
