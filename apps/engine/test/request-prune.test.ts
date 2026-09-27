/**
 * POLICY-RESOLVED REQUEST PAIRS, PRUNED INTO PER-TURN COUNTS — issue #697 part B.
 *
 * What must not drift, each held by a row count rather than a marker:
 *
 *   - ONLY POLICY. A request a person, a session or a cancellation resolved,
 *     and one still open, is never touched.
 *   - THE POLICY HAS TO AGREE. A pair claiming `policy` that the runtime mode at
 *     the time would not have produced survives.
 *   - ONLY SETTLED TURNS, and only turns with a summary row to hold the count.
 *   - IDEMPOTENT, and on its own watermark: a journal already compacted and
 *     folded still has its pairs found.
 *   - SAFE ON OPEN: the sweep the store starts by itself does it.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, type ExecutionStoreOptions } from "../src/execution-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-request-prune-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  return root;
}

/** A session's journal, written by hand, continuing from whatever it holds. */
function journal(root: string, store: ExecutionStore, sessionId = "session_one") {
  store.write(path.join(root, "sessions", sessionId, "session.json"), { id: sessionId });
  let id = store.events(sessionId).reduce((max, event) => Math.max(max, event.id), 0);
  const at = Date.parse("2026-09-01T00:00:00Z");
  const append = (event: Record<string, unknown>) => store.append({ id: ++id, at, sessionId, ...event } as never);
  return {
    created: (runtimeMode: string) => append({ type: "session.created", session: { id: sessionId, runtimeMode } }),
    mode: (runtimeMode: string) => append({ type: "session.updated", session: { id: sessionId, runtimeMode } }),
    /** A pair as `openRequest` writes it when the mode resolves it on the spot. */
    policy: (runId: string, requestId: string, kind = "command_execution", decision = "accept") => {
      append({
        runId, type: "request.opened",
        request: { id: requestId, runId, sessionId, state: "resolved", detail: { kind }, openedAt: at, decision, resolvedBy: "policy", resolvedAt: at },
      });
      append({ runId, type: "request.resolved", requestId, decision, resolvedBy: "policy" });
    },
    /** A request that parked, answered later by `resolvedBy` — or left open. */
    parked: (runId: string, requestId: string, resolvedBy?: "human" | "session" | "cancelled") => {
      append({ runId, type: "request.opened", request: { id: requestId, runId, sessionId, state: "open", detail: { kind: "command_execution" }, openedAt: at } });
      if (resolvedBy) append({ runId, type: "request.resolved", requestId, decision: resolvedBy === "cancelled" ? "cancel" : "accept", resolvedBy });
    },
    usage: (runId: string, output: number) =>
      append({ runId, type: "usage.updated", usage: { tokens: { input: 0, output, cacheRead: 0, cacheCreate: 0 } } }),
    endTurn: (runId: string) => append({ runId, type: "turn.completed", resultText: "done" }),
  };
}

function summarise(store: ExecutionStore, runId: string, sessionId = "session_one"): void {
  store.writeTurnSummary({
    sessionId, runId, sequence: 1, state: "completed",
    input: "hello", itemCount: 0, itemTitles: [], answerHead: "done", answerChars: 4,
  });
}

function open(root: string, options: ExecutionStoreOptions = {}): ExecutionStore {
  return new ExecutionStore(root, { compactAfterOpenMs: 60 * 60 * 1000, ...options });
}

/** The request ids still in the journal, one entry per row. */
const requestRows = (store: ExecutionStore, sessionId = "session_one") =>
  store.events(sessionId).flatMap((event) => {
    const row = event as { type: string; requestId?: string; request?: { id: string } };
    if (row.type === "request.opened") return [`opened:${row.request!.id}`];
    if (row.type === "request.resolved") return [`resolved:${row.requestId}`];
    return [];
  });

test("policy pairs go, and every request somebody resolved or left open stays", () => {
  const root = home();
  const store = open(root);
  try {
    const write = journal(root, store);
    write.created("auto");
    write.policy("run_one", "req_a");
    write.policy("run_one", "req_b");
    write.policy("run_one", "req_c", "file_read");
    write.parked("run_one", "req_human", "human");
    write.parked("run_one", "req_session", "session");
    write.parked("run_one", "req_cancelled", "cancelled");
    write.parked("run_one", "req_open");
    write.endTurn("run_one");
    summarise(store, "run_one");

    expect(store.pruneJournalRequests()).toEqual({ pairs: 3, turns: 1, sessions: 1, refused: 0 });
    expect(requestRows(store)).toEqual([
      "opened:req_human", "resolved:req_human",
      "opened:req_session", "resolved:req_session",
      "opened:req_cancelled", "resolved:req_cancelled",
      "opened:req_open",
    ]);
    expect(store.turnPolicyRequests("session_one", "run_one")).toEqual({
      command_execution: { accept: 2 },
      file_read: { accept: 1 },
    });
  } finally { store.close(); }
});

test("a pair the mode at the time would not have resolved survives, read across a mode change", () => {
  const root = home();
  const store = open(root);
  try {
    const write = journal(root, store);
    write.created("approval-required");
    write.policy("run_one", "req_read", "file_read"); // approval-required passes reads
    write.policy("run_one", "req_forged"); // …and never a command
    write.mode("auto");
    write.policy("run_one", "req_command"); // auto passes it
    write.policy("run_one", "req_question", "user_input"); // no mode passes a question
    write.endTurn("run_one");
    summarise(store, "run_one");

    expect(store.pruneJournalRequests().pairs).toBe(2);
    expect(requestRows(store)).toEqual([
      "opened:req_forged", "resolved:req_forged",
      "opened:req_question", "resolved:req_question",
    ]);
  } finally { store.close(); }
});

test("a pair with no recorded mode, or whose halves disagree, survives", () => {
  const root = home();
  const store = open(root);
  try {
    const write = journal(root, store);
    write.policy("run_one", "req_no_mode"); // no session row below it at all
    write.created("auto");
    write.policy("run_one", "req_twice");
    write.policy("run_one", "req_twice"); // the same id twice is not one pair
    write.endTurn("run_one");
    summarise(store, "run_one");

    expect(store.pruneJournalRequests().pairs).toBe(0);
    expect(requestRows(store)).toHaveLength(6);
  } finally { store.close(); }
});

test("an unsettled turn keeps its pairs, and one with no summary row is refused", () => {
  const root = home();
  const store = open(root);
  try {
    const write = journal(root, store);
    write.created("auto");
    write.policy("run_orphan", "req_orphan"); // a turn that never ended
    write.policy("run_unsummarised", "req_unsummarised");
    write.endTurn("run_unsummarised");

    expect(store.pruneJournalRequests()).toEqual({ pairs: 0, turns: 0, sessions: 0, refused: 1 });
    expect(requestRows(store)).toHaveLength(4);
    expect(store.turnPolicyRequests("session_one", "run_unsummarised")).toBeUndefined();
  } finally { store.close(); }
});

test("it is idempotent, finds its pairs after compaction and the usage fold, and counts across sweeps", () => {
  const root = home();
  const store = open(root);
  try {
    const write = journal(root, store);
    write.created("auto");
    write.policy("run_one", "req_a");
    write.usage("run_one", 10);
    write.usage("run_one", 20);
    write.endTurn("run_one");
    summarise(store, "run_one");

    // The other sweeps go first and move their own watermarks to the terminal
    // event. A prune sharing one of those keys would find nothing.
    store.compactJournal();
    expect(store.foldJournalUsage().turns).toBe(1);
    expect(store.pruneJournalRequests().pairs).toBe(1);
    expect(store.pruneJournalRequests()).toEqual({ pairs: 0, turns: 0, sessions: 0, refused: 0 });

    // A later turn, in a range whose mode row is below the watermark.
    write.policy("run_two", "req_b");
    write.policy("run_two", "req_c");
    write.endTurn("run_two");
    summarise(store, "run_two");
    expect(store.pruneJournalRequests()).toEqual({ pairs: 2, turns: 1, sessions: 1, refused: 0 });
    expect(requestRows(store)).toEqual([]);
    expect(store.turnPolicyRequests("session_one", "run_one")).toEqual({ command_execution: { accept: 1 } });
    expect(store.turnPolicyRequests("session_one", "run_two")).toEqual({ command_execution: { accept: 2 } });
  } finally { store.close(); }
});

test("the sweep a store starts on open prunes the pairs and keeps the last usage row", async () => {
  const root = home();
  const seeded = open(root);
  const write = journal(root, seeded);
  write.created("auto");
  write.policy("run_one", "req_a");
  write.usage("run_one", 10);
  write.parked("run_one", "req_human", "human");
  write.usage("run_one", 20);
  write.endTurn("run_one");
  summarise(seeded, "run_one");
  seeded.close();

  // The walk runs each step inline, and the first one is armed on a zero timer.
  const store = open(root, { compactAfterOpenMs: 0, sweepYield: (next) => next() });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.housekeeping.requests).toEqual({ pairs: 1, turns: 1, sessions: 1, refused: 0 });
    expect(requestRows(store)).toEqual(["opened:req_human", "resolved:req_human"]);
    const usage = store.events("session_one").filter((event) => event.type === "usage.updated");
    expect(usage).toHaveLength(1);
    expect((usage[0] as { usage: { tokens: { output: number } } }).usage.tokens.output).toBe(20);
  } finally { store.close(); }
});
