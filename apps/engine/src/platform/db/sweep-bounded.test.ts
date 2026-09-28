import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "./execution-store";
import { turnPolicyRequests } from "../../../test/store-internals";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ITEMS_PER_TURN = 6;
const PAIRS_PER_TURN = 10;

/** A store holding `sessions` with `turns` settled turns each, written straight
 *  into sqlite: appending tens of thousands of rows through the store would
 *  pay a durability barrier per turn and measure the fixture, not the sweep. */
function seed(sessions: Record<string, number>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sweep-bounded-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root, { compactAfterOpenMs: 60 * 60 * 1000 });
  try {
    for (const sessionId of Object.keys(sessions))
      store.write(path.join(root, "sessions", sessionId, "session.json"), { id: sessionId });
  } finally { store.close(); }

  const db = new Database(path.join(root, "execution.sqlite"));
  try {
    const event = db.prepare("INSERT INTO events(session_id,id,value) VALUES(?,?,?)");
    const item = db.prepare("INSERT INTO items(session_id,item_id,run_id,ord,value) VALUES(?,?,?,?,?)");
    const summary = db.prepare("INSERT INTO turn_summaries(session_id,run_id,sequence,state) VALUES(?,?,?,'completed')");
    db.exec("BEGIN");
    for (const [sessionId, turns] of Object.entries(sessions)) {
      let id = 0;
      let ord = 0;
      const at = Date.parse("2026-09-01T00:00:00Z");
      const add = (row: Record<string, unknown>) => event.run(sessionId, ++id, JSON.stringify({ id, at, sessionId, ...row }));
      add({ type: "session.created", session: { id: sessionId, runtimeMode: "auto" } });
      for (let turn = 0; turn < turns; turn++) {
        const runId = `run_${turn}`;
        add({ runId, type: "turn.started" });
        for (let i = 0; i < ITEMS_PER_TURN; i++) {
          const value = { id: `item_${turn}_${i}`, runId, sessionId, status: "completed", title: "ls", detail: { type: "command", command: "ls", output: "x".repeat(200) } };
          add({ runId, type: "item.started", item: { ...value, status: "inProgress" } });
          add({ runId, type: "item.completed", item: value });
          item.run(sessionId, value.id, runId, ++ord, JSON.stringify(value));
        }
        for (let r = 0; r < PAIRS_PER_TURN; r++) {
          const requestId = `req_${turn}_${r}`;
          add({
            runId, type: "request.opened",
            request: { id: requestId, runId, sessionId, state: "resolved", detail: { kind: "command_execution" }, openedAt: at, decision: "accept", resolvedBy: "policy", resolvedAt: at },
          });
          add({ runId, type: "request.resolved", requestId, decision: "accept", resolvedBy: "policy" });
        }
        add({ runId, type: "turn.completed", resultText: "done" });
        summary.run(sessionId, runId, turn + 1);
      }
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  return root;
}

/** Opened as the daemon opens it, with the walk's yields handed to the test. */
function open(root: string) {
  const queued: Array<() => void> = [];
  const store = new ExecutionStore(root, { compactAfterOpenMs: 60 * 60 * 1000, sweepYield: (next) => { queued.push(next); } });
  // The walk the open timer starts, started by hand: no test sleeps through it.
  const sweep = () => (store as unknown as { sweepJournal(): void }).sweepJournal();
  return { store, queued, sweep };
}

const requestRuns = (store: ExecutionStore, sessionId: string) =>
  new Set(store.events(sessionId).flatMap((event) => event.type === "request.opened" ? [event.runId] : []));

test("a long session is swept in turn-bounded steps, and a read is served between them", () => {
  const root = seed({ session_long: 150 });
  const { store, queued, sweep } = open(root);
  try {
    sweep();
    expect(queued).toHaveLength(1);
    queued.shift()!();

    // One step into the session, it is only partly done: its early turns lost
    // their pairs, its last turn has not been reached, and the walk comes back
    // to it. The old walk finished a whole session per step.
    const left = requestRuns(store, "session_long");
    expect(left.has("run_0")).toBe(false);
    expect(left.has("run_149")).toBe(true);
    expect(queued).toHaveLength(1);

    // What a conversation switch asks for, answered between two steps.
    expect(store.events("session_long", 0, 50)).toHaveLength(50);

    let steps = 1;
    while (queued.length) { queued.shift()!(); steps += 1; }
    expect(steps).toBeGreaterThan(3);
    expect(requestRuns(store, "session_long").size).toBe(0);

    // The totals the synchronous sweep reports, the session counted once
    // however many steps it took.
    expect(store.housekeeping.requests).toEqual({ pairs: 150 * PAIRS_PER_TURN, turns: 150, sessions: 1, refused: 0 });
    expect(store.housekeeping.slimmed).toEqual({ rows: 150 * ITEMS_PER_TURN, sessions: 1 });
    expect(store.housekeeping.journal).toEqual({ deltas: 0, starts: 150 * ITEMS_PER_TURN, sessions: 1 });
    expect(turnPolicyRequests(store, "session_long", "run_149")).toEqual({ command_execution: { accept: PAIRS_PER_TURN } });
  } finally { store.close(); }
});

test("no sweep step grows with the session's history", () => {
  // 800 turns: the per-run scan took seconds on this in one step, and a chunk
  // takes tens of milliseconds. The bound sits between the two with room on
  // both sides for a loaded machine.
  const root = seed({ session_long: 800 });
  const { store, queued, sweep } = open(root);
  try {
    sweep();
    let longest = 0;
    while (queued.length) {
      const started = performance.now();
      queued.shift()!();
      longest = Math.max(longest, performance.now() - started);
    }
    expect(store.housekeeping.requests?.pairs).toBe(800 * PAIRS_PER_TURN);
    expect(longest).toBeLessThan(750);
  } finally { store.close(); }
});
