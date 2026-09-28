import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContentStream, ItemDetail } from "@telar/engine-client";
import { ContentStream as ContentStreamSchema, ItemDetail as ItemDetailSchema } from "@telar/engine-client";
import { ExecutionStore } from "./execution-store";
import { cleanup, homes } from "./execution-store-fixture";

afterEach(cleanup);

function journal(root: string, sessionId: string, store: ExecutionStore) {
  store.write(path.join(root, "sessions", sessionId, "session.json"), { id: sessionId });
  let id = 0;
  const at = Date.parse("2026-09-01T00:00:00Z");
  const runId = "run_one";
  return {
    start: (itemId: string, detail: ItemDetail = { type: "assistant_message", text: "" }) =>
      store.append({ id: ++id, at, sessionId, runId, type: "item.started",
        item: { id: itemId, runId, sessionId, status: "inProgress", detail, startedAt: at } } as never),
    delta: (itemId: string, text: string, stream: ContentStream = "assistant_text") =>
      store.append({ id: ++id, at, sessionId, runId, type: "content.delta", itemId, stream, text } as never),
    complete: (itemId: string, text: string, detail: ItemDetail = { type: "assistant_message", text }) =>
      store.append({ id: ++id, at, sessionId, runId, type: "item.completed",
        item: { id: itemId, runId, sessionId, status: "completed", detail, startedAt: at, completedAt: at } } as never),
    endTurn: () => store.append({ id: ++id, at, sessionId, runId, type: "turn.completed", resultText: "done" } as never),
  };
}
const types = (store: ExecutionStore, sessionId: string) => store.events(sessionId).map((event) => event.type);

test("a settled turn keeps its completed items and drops the rows they supersede", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "Once upon ");
    write.delta("item_one", "a time");
    write.complete("item_one", "Once upon a time");
    write.endTurn();

    const swept = store.sweep(["compact"]).journal;
    expect(swept).toEqual({ deltas: 2, starts: 1, sessions: 1 });
    // The completed item survives, and with it the text both dropped kinds held.
    expect(types(store, "session_one")).toEqual(["item.completed", "turn.completed"]);
    expect(store.events("session_one")[0]).toMatchObject({ item: { detail: { text: "Once upon a time" } } });

    // AND IT IS INCREMENTAL. The watermark means the second sweep looks at
    // nothing, rather than re-scanning a settled journal every day forever.
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 0, starts: 0, sessions: 0 });
  } finally { store.close(); }
});

test("the guard keeps the deltas a completed item cannot account for", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-guard-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_short");
    write.delta("item_short", "the whole streamed paragraph");
    // Completed with less text than was streamed, so the deltas are kept.
    write.complete("item_short", "truncated");
    write.endTurn();

    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 0, starts: 1, sessions: 1 });
    expect(types(store, "session_one")).toEqual(["content.delta", "item.completed", "turn.completed"]);
  } finally { store.close(); }
});

test("an unfinished turn is left entirely alone, and swept once it ends", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-live-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "still ");
    write.complete("item_one", "still streaming");
    write.delta("item_two", "an item with no completion at all");

    // No terminal turn event yet: nothing below it is final, so nothing goes.
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 0, starts: 0, sessions: 0 });
    expect(store.events("session_one")).toHaveLength(4);

    write.endTurn();
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 1, starts: 1, sessions: 1 });
    // `item_two` never completed, so its delta is the only record of that text
    // and it stays — the same rule as the guard, for the same reason.
    expect(types(store, "session_one")).toEqual(["item.completed", "content.delta", "turn.completed"]);
  } finally { store.close(); }
});

const DELTAS_PER_KIND = 3;
/** The detail kinds whose completed row keeps the streamed text where the
 *  guard reads it — `$.item.detail.text`, no named field in between. */
const REACHABLE: ItemDetail["type"][] = ["user_message", "assistant_message", "reasoning"];
/** One row per contract kind: the stream that kind's deltas would arrive on if
 *  anything emitted them, and the most generous completed detail it can hold. */
const REACH: { kind: ItemDetail["type"]; stream: ContentStream; detail: (text: string) => ItemDetail }[] = [
  { kind: "user_message", stream: "assistant_text", detail: (text) => ({ type: "user_message", text }) },
  { kind: "notification", stream: "assistant_text", detail: (text) => ({ type: "notification", notification: { kind: "peer_message", summary: text, fetch: { sessionId: "session_one", runId: "run_one" }, body: text } }) },
  { kind: "assistant_message", stream: "assistant_text", detail: (text) => ({ type: "assistant_message", text }) },
  { kind: "reasoning", stream: "reasoning_text", detail: (text) => ({ type: "reasoning", text }) },
  { kind: "plan", stream: "assistant_text", detail: (text) => ({ type: "plan", plan: { steps: [{ step: text, status: "completed" }] } }) },
  { kind: "command_execution", stream: "command_output", detail: (text) => ({ type: "command_execution", command: { command: "bun test", outputPreview: text } }) },
  { kind: "file_change", stream: "tool_output", detail: (text) => ({ type: "file_change", change: { path: "a.ts", kind: "edit", unifiedDiff: text } }) },
  // Nowhere to put it at all: `FileReadDetail` is a path and a line range.
  { kind: "file_read", stream: "tool_output", detail: () => ({ type: "file_read", read: { path: "a.ts" } }) },
  { kind: "mcp_tool_call", stream: "tool_output", detail: (text) => ({ type: "mcp_tool_call", call: { name: "mcp__linear__search", output: text } }) },
  { kind: "dynamic_tool_call", stream: "tool_output", detail: (text) => ({ type: "dynamic_tool_call", call: { name: "WebFetch", output: text } }) },
  { kind: "web_search", stream: "tool_output", detail: (text) => ({ type: "web_search", query: text }) },
  { kind: "browser_action", stream: "tool_output", detail: (text) => ({ type: "browser_action", call: { name: "browser_click", output: text } }) },
  { kind: "task", stream: "assistant_text", detail: () => ({ type: "task", taskId: "task_one" }) },
  { kind: "context_compaction", stream: "assistant_text", detail: (text) => ({ type: "context_compaction", reason: text }) },
  { kind: "provider_wait", stream: "assistant_text", detail: () => ({ type: "provider_wait", wait: { kind: "api_retry", attempt: 1 } }) },
  { kind: "conversation_import", stream: "assistant_text", detail: (text) => ({ type: "conversation_import", import: { provider: "claude", sourceSessionId: "session_src", sessionId: "session_one", firstPrompt: text, records: 1, cut: "whole", rows: 1, rowCut: "whole" } }) },
  { kind: "error", stream: "assistant_text", detail: (text) => ({ type: "error", error: { message: text } }) },
  { kind: "unknown", stream: "unknown", detail: (text) => ({ type: "unknown", label: text }) },
];

test("compaction reaches exactly the kinds whose settled row keeps the streamed text", () => {
  // Exhaustive, so a new detail kind fails here rather than being silently exempt.
  expect(REACH.map((row) => row.kind)).toEqual(
    ItemDetailSchema.options.map((option) => option.shape.type.value as ItemDetail["type"]),
  );
  expect(REACH).toHaveLength(18);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-reach-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    const streamed = "one two three";
    for (const { kind, stream, detail } of REACH) {
      const itemId = `item_${kind}`;
      write.start(itemId, detail(""));
      // Three deltas summing to exactly the completed text, so the guard's
      // `settled.chars >= streamed.chars` holds wherever it can read both.
      write.delta(itemId, "one ", stream);
      write.delta(itemId, "two ", stream);
      write.delta(itemId, "three", stream);
      write.complete(itemId, streamed, detail(streamed));
    }
    write.endTurn();

    const deltasPerItem = (): Map<string, number> => {
      const counted = new Map<string, number>();
      for (const event of store.events("session_one")) {
        if (event.type !== "content.delta") continue;
        counted.set(event.itemId, (counted.get(event.itemId) ?? 0) + 1);
      }
      return counted;
    };

    // The fixture really wrote three for every kind.
    const before = deltasPerItem();
    expect(REACH.map(({ kind }) => before.get(`item_${kind}`) ?? 0)).toEqual(REACH.map(() => DELTAS_PER_KIND));

    // The sweep's own accounting: 3 reachable kinds × 3 deltas, and an
    // `item.started` dropped for each of the 18 items that completed.
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: REACHABLE.length * DELTAS_PER_KIND, starts: REACH.length, sessions: 1 });

    // AFTER, per kind and in both directions.
    const after = deltasPerItem();
    expect(REACH.map(({ kind }) => ({
      kind,
      kept: after.get(`item_${kind}`) ?? 0,
      dropped: (before.get(`item_${kind}`) ?? 0) - (after.get(`item_${kind}`) ?? 0),
    }))).toEqual(REACH.map(({ kind }) => REACHABLE.includes(kind)
      ? { kind, kept: 0, dropped: DELTAS_PER_KIND }
      : { kind, kept: DELTAS_PER_KIND, dropped: 0 }));

    // And the deltas that are the only record of their text are still there.
    expect(store.events("session_one").filter((event) => event.type === "content.delta")).toHaveLength(
      (REACH.length - REACHABLE.length) * DELTAS_PER_KIND,
    );
  } finally { store.close(); }
});

const COMPACTABLE: ContentStream[] = ["assistant_text", "reasoning_text"];
/** Streams no driver emits; moving one out means deciding what compaction does with its deltas. */
const NOT_EMITTED: ContentStream[] = ["command_output", "tool_output", "unknown"];

test("every content stream is classified for compaction, exactly once", () => {
  const classified = [...COMPACTABLE, ...NOT_EMITTED];
  // Exhaustive: a new member of the enum belongs to one of the two sets, and
  // until somebody puts it in one this fails.
  expect([...classified].sort()).toEqual([...ContentStreamSchema.options].sort());
  // And to exactly one: a member in both would make the pair agree with the
  // enum while saying nothing.
  expect(new Set(classified).size).toBe(classified.length);
  expect(COMPACTABLE.filter((stream) => NOT_EMITTED.includes(stream))).toEqual([]);
  expect(COMPACTABLE).toHaveLength(2);
  expect(NOT_EMITTED).toHaveLength(3);
  // The compactable streams are exactly the reachable kinds that are streamed
  // into, which is the link between this trip-wire and the reach test above.
  expect(COMPACTABLE.length).toBe(REACHABLE.filter((kind) => kind !== "user_message").length);
});

test("opening the store does not sweep; the sweep follows and says what it took", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-open-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  let store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    for (let turn = 0; turn < 40; turn += 1) {
      const item = `item_${turn}`;
      write.start(item);
      // Enough text that the freed pages are a file-size difference and not a
      // rounding error; the point of `reclaim` is that the file itself shrinks.
      for (let chunk = 0; chunk < 40; chunk += 1) write.delta(item, "x".repeat(512));
      write.complete(item, "x".repeat(512 * 40));
    }
    write.endTurn();
  } finally { store.close(); }

  const told: { deltas: number; starts: number; sessions: number }[] = [];
  store = new ExecutionStore(root, { onJournalCompacted: (swept) => told.push(swept) });
  try {
    // The open itself took nothing away — a person waiting on the daemon is
    // not waiting on housekeeping.
    expect(store.housekeeping.journal).toBeUndefined();
    expect(store.events("session_one").filter((event) => event.type === "content.delta")).toHaveLength(1600);

    // The sweep the timer would run, without waiting five seconds for it.
    const swept = store.sweep(["compact"]).journal;
    expect(swept.deltas).toBe(1600);
    expect(swept.starts).toBe(40);

    // A DELETE moves pages to the freelist and returns nothing to the filesystem.
    const file = path.join(root, "execution.sqlite");
    const afterSweep = fs.statSync(file).size;
    const reclaimed = store.reclaim();
    expect(fs.statSync(file).size).toBeLessThan(afterSweep);
    expect(reclaimed.after).toBeLessThan(reclaimed.before);
    // Nothing left to compact, so pressing it again moves nothing — which is
    // what the before/after in Settings is there to show a person.
    expect(reclaimed.deltas).toBe(0);
    expect(store.events("session_one").filter((event) => event.type === "item.completed")).toHaveLength(40);
  } finally { store.close(); }

  // The daemon is told when the rows actually go, not at open.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compact-told-")); homes.push(fresh);
  fs.mkdirSync(path.join(fresh, "sessions"), { recursive: true });
  const seen: { deltas: number; starts: number; sessions: number }[] = [];
  const announced = new ExecutionStore(fresh, { onJournalCompacted: (swept) => seen.push(swept), compactAfterOpenMs: 1 });
  try {
    const write = journal(fresh, "session_one", announced);
    write.start("item_one");
    write.delta("item_one", "hello");
    write.complete("item_one", "hello");
    write.endTurn();
    const deadline = Date.now() + 4_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([{ deltas: 1, starts: 1, sessions: 1 }]);
  } finally { announced.close(); }
});


/** The metadata row as it is on disk, read through a second connection; `null` when absent. */
function metadataValue(root: string, key: string): string | null {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path.join(root, "execution.sqlite"), { readonly: true });
  try {
    const row = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value?: string } | null;
    return row?.value === undefined ? null : String(row.value);
  } finally { db.close(); }
}

const TERMINAL_HIGH = "journal-terminal-high/";

function threeSessions(root: string, store: ExecutionStore): string[] {
  const ids = ["session_a", "session_b", "session_c"];
  for (const id of ids) {
    const write = journal(root, id, store);
    write.start("item_one");
    write.delta("item_one", "Once upon ");
    write.delta("item_one", "a time");
    write.complete("item_one", "Once upon a time");
    write.endTurn();
  }
  return ids;
}

const deltasIn = (store: ExecutionStore, sessionId: string) =>
  store.events(sessionId).filter((event) => event.type === "content.delta").length;

test("the background sweep hands the event loop back between sessions, one at a time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sweep-walk-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  let ids: string[] = [];
  let seeded = new ExecutionStore(root);
  try { ids = threeSessions(root, seeded); } finally { seeded.close(); }

  // THE SAME FIXTURE, SWEPT SYNCHRONOUSLY, is what the walk's totals are held
  // against — a number typed here would drift the moment the fixture does.
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sweep-sync-")); homes.push(reference);
  fs.mkdirSync(path.join(reference, "sessions"), { recursive: true });
  const sync = new ExecutionStore(reference);
  let expected: { deltas: number; starts: number; sessions: number };
  try {
    threeSessions(reference, sync);
    expected = sync.sweep(["compact"]).journal;
  } finally { sync.close(); }
  expect(expected).toEqual({ deltas: 6, starts: 3, sessions: 3 });

  // THE YIELD IS THE TEST'S OWN, so the walk advances only when this test says
  // so. Nothing here sleeps through a real timer except the 1 ms arming above.
  const queued: (() => void)[] = [];
  const told: { deltas: number; starts: number; sessions: number }[] = [];
  const store = new ExecutionStore(root, {
    compactAfterOpenMs: 1,
    sweepYield: (next) => { queued.push(next); },
    onJournalCompacted: (swept) => { told.push(swept); },
  });
  try {
    const deadline = Date.now() + 4_000;
    while (queued.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    // The timer fired and the walk asked for a macrotask instead of taking the
    // whole store in the callback it was already in.
    expect(queued).toHaveLength(1);
    expect(ids.map((id) => deltasIn(store, id))).toEqual([2, 2, 2]);

    // One step: the first session is compacted, the second waits behind a yield.
    queued.shift()!();
    expect(ids.map((id) => deltasIn(store, id))).toEqual([0, 2, 2]);
    expect(queued).toHaveLength(1);
    expect(told).toEqual([]);

    queued.shift()!();
    expect(ids.map((id) => deltasIn(store, id))).toEqual([0, 0, 2]);
    queued.shift()!();
    expect(ids.map((id) => deltasIn(store, id))).toEqual([0, 0, 0]);

    // One more step to find the end of the list and report. The daemon still
    // gets exactly one line, and it says what the synchronous sweep would.
    expect(told).toEqual([]);
    queued.shift()!();
    expect(queued).toHaveLength(0);
    expect(told).toEqual([expected]);
    expect(store.housekeeping.journal).toEqual(expected);
  } finally { store.close(); }
});

test("retention runs after the walk, and a close mid-walk stops it without reporting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sweep-cancel-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  let ids: string[] = [];
  const seeded = new ExecutionStore(root);
  try { ids = threeSessions(root, seeded); } finally { seeded.close(); }

  const queued: (() => void)[] = [];
  const told: { deltas: number; starts: number; sessions: number }[] = [];
  let retentionSweeps = 0;
  const store = new ExecutionStore(root, {
    compactAfterOpenMs: 1,
    sweepYield: (next) => { queued.push(next); },
    onJournalCompacted: (swept) => { told.push(swept); },
    onRetentionSweep: () => { retentionSweeps += 1; },
  });
  const deadline = Date.now() + 4_000;
  while (queued.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  queued.shift()!();
  // One session in: the walk is real, and retention has NOT run — it is one
  // call and it waits for the end rather than firing per session.
  expect(deltasIn(store, ids[0]!)).toBe(0);
  expect(retentionSweeps).toBe(0);

  store.close();
  // The step still queued must not run a transaction against a closed
  // database; it returns, and a partial walk announces nothing.
  expect(queued).toHaveLength(1);
  expect(() => queued.shift()!()).not.toThrow();
  expect(told).toEqual([]);
  expect(retentionSweeps).toBe(0);

  // And the two sessions the walk did not reach still hold every row, which is
  // the half that says the cancel stopped work rather than only silenced it.
  const after = new ExecutionStore(root);
  try { expect(ids.map((id) => deltasIn(after, id))).toEqual([0, 2, 2]); } finally { after.close(); }
});

test("the terminal-turn bound is written by the append that creates it, and read by the sweep", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-terminal-high-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "Once upon ");
    write.delta("item_one", "a time");
    write.complete("item_one", "Once upon a time");
    // No turn has ended, so there is no bound to record yet — and the absence
    // is what the fallback in `terminalHigh` is allowed to read as "unknown".
    expect(metadataValue(root, `${TERMINAL_HIGH}session_one`)).toBeNull();

    write.endTurn();
    // The terminal event's own id, committed with the row it describes.
    const terminal = store.events("session_one").at(-1)!;
    expect(terminal.type).toBe("turn.completed");
    expect(metadataValue(root, `${TERMINAL_HIGH}session_one`)).toBe(String(terminal.id));

    // …and the sweep bounded by it removes exactly what it always did.
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 2, starts: 1, sessions: 1 });
    expect(types(store, "session_one")).toEqual(["item.completed", "turn.completed"]);

    // A SECOND TURN MOVES IT, so a settled store does not go permanently blind
    // to everything appended after the first one ended.
    write.start("item_two");
    write.delta("item_two", "and then");
    write.complete("item_two", "and then");
    write.endTurn();
    const second = store.events("session_one").at(-1)!;
    expect(Number(metadataValue(root, `${TERMINAL_HIGH}session_one`))).toBe(second.id);
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 1, starts: 1, sessions: 1 });

    // And it goes with the session, like the two watermarks beside it: a bound
    // outliving its journal would send a reused id past its whole history.
    store.deleteSession("session_one");
    expect(metadataValue(root, `${TERMINAL_HIGH}session_one`)).toBeNull();
  } finally { store.close(); }
});

test("a journal written before the bound existed still sweeps, and pays the parse once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-terminal-high-legacy-")); homes.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  try {
    const write = journal(root, "session_one", store);
    write.start("item_one");
    write.delta("item_one", "Once upon ");
    write.delta("item_one", "a time");
    write.complete("item_one", "Once upon a time");
    write.endTurn();
    const terminal = store.events("session_one").at(-1)!;

    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const raw = new Database(path.join(root, "execution.sqlite"));
    try { raw.query("DELETE FROM metadata WHERE key=?").run(`${TERMINAL_HIGH}session_one`); } finally { raw.close(); }
    expect(metadataValue(root, `${TERMINAL_HIGH}session_one`)).toBeNull();

    // The sweep takes what it would have taken with the key present…
    expect(store.sweep(["compact"]).journal).toEqual({ deltas: 2, starts: 1, sessions: 1 });
    expect(types(store, "session_one")).toEqual(["item.completed", "turn.completed"]);
    // …and the answer is written down, so the parse is paid once.
    expect(metadataValue(root, `${TERMINAL_HIGH}session_one`)).toBe(String(terminal.id));
  } finally { store.close(); }
});
