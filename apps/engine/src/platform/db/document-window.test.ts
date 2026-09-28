/**
 * WHAT A WINDOWED SNAPSHOT COSTS, AND WHAT IT CARRIES (#419, #245).
 *
 * Two complaints with one shape: opening a conversation was priced by its whole
 * history rather than by the ten turns it answers with. #419 is the read — the
 * queue and item documents were parsed entire and filtered afterwards. #245 is
 * the payload — the `requests` key carried every approval ever settled.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { EngineStore } from "../../state";
import { ExecutionStore } from "./execution-store";
import { ITEM_ROWS_FOR_RUNS_SQL } from "./tables";
import { sessionSnapshot } from "../../domains/sessions";
import { arrayElementRanges, parseSpan } from "./document-window";
import { toLegacyHome } from "../../../test/store-internals";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-"));
  roots.push(directory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const stores: EngineStore[] = [];
const open = (home: string): EngineStore => {
  const store = new EngineStore(home, () => 100);
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Roughly a paragraph of reply, so the documents have the shape a real one
 *  has. Smaller than the dogfood store's average on purpose: what is under test
 *  is the RATIO between the window and the history, and seeding is quadratic —
 *  every turn rewrites a projection that every earlier turn made longer. */
const BODY = "x".repeat(800);

/**
 * A session of `turns` completed turns, seeded through the PUBLIC path.
 *
 * A hand-written queue would price a store no engine ever wrote — and, here,
 * would index a document the writer never produced, which is exactly the thing
 * under test.
 */
function conversation(turns: number, itemsPerTurn = 3): string {
  const home = root();
  const store = open(home);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  for (let index = 0; index < turns; index += 1) {
    const runId = `run_${index}`;
    store.submitTurn("session_one", { runId, input: `message ${index}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    // One ingest per turn rather than one per item: the projection is rewritten
    // per call, and seeding a hundred turns a call at a time is the slowest
    // thing in this file.
    store.ingestObservations("session_one", runId, token, Array.from({ length: itemsPerTurn }, (_, step) => `${runId}_item_${step}`).flatMap((id) => [
      { kind: "item.started" as const, item: { id, detail: { type: "assistant_message", text: "" } } },
      { kind: "item.completed" as const, itemId: id, status: "completed" as const, detail: { type: "assistant_message", text: `${BODY} ${index}` } },
    ]));
    store.completeTurn("session_one", runId, token, { text: `answer ${index}` });
  }
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);
  return home;
}

test("opening a 120-turn session reads its tail, not its history", () => {
  const home = conversation(120);

  // What the whole projection weighs, read by a store of its own so the one
  // under test starts with nothing parsed and nothing cached.
  const measured = open(home);
  const everyItem = measured.items("session_one");
  const whole = JSON.stringify(everyItem).length + JSON.stringify(measured.turns("session_one")).length;

  const cold = open(home);
  cold.readAccounting.documentBytes = 0;
  cold.readAccounting.documentReads = 0;
  const window = cold.snapshotWindow("session_one", { limit: 10 });
  const touched = cold.readAccounting.documentBytes;

  // THE ANSWER IS THE SAME ANSWER. The window is what it always was; only the
  // route to it changed.
  expect(window.turns.map((turn) => turn.runId)).toEqual(Array.from({ length: 10 }, (_, at) => `run_${110 + at}`));
  expect(window.page).toEqual({ before: "run_110", more: true, total: 120 });
  const chosen = new Set(window.turns.map((turn) => turn.runId));
  expect(window.items.map((item) => item.id).sort()).toEqual(everyItem.filter((item) => chosen.has(item.runId)).map((item) => item.id).sort());
  expect(window.items).toEqual(everyItem.filter((item) => chosen.has(item.runId)));

  // AND IT COST THE TAIL. Ten turns of a hundred and twenty is a twelfth of
  // the conversation; a fifth is slack for the span between an unsettled turn
  // and the tail, and still fails loudly if the whole document is parsed
  // again.
  expect(touched).toBeGreaterThan(0);
  expect(touched).toBeLessThan(whole / 5);
}, 60_000); // Seeding 120 turns rewrites a growing projection 120 times.

test("a conversation migrated into SQLite reads correctly before it is indexed again", () => {
  // `importLegacy` brings no indexes, so the first read after a migration is a
  // whole-document read, and the first write earns the index back.
  const home = conversation(30);
  const seeded = open(home);
  const before = seeded.snapshotWindow("session_one", { limit: 8 });
  // Items live as rows, not documents, so the legacy home gets its blob by hand.
  const items = seeded.items("session_one");
  toLegacyHome(seeded, home);
  fs.writeFileSync(path.join(home, "sessions", "session_one", "items.json"), JSON.stringify({ items }));

  const migrated = open(home);
  migrated.readAccounting.documentBytes = 0;
  expect(migrated.snapshotWindow("session_one", { limit: 8 })).toEqual(before);
  const whole = migrated.readAccounting.documentBytes;
  expect(whole).toBeGreaterThan(JSON.stringify(before.items).length * 2);

  // One write rebuilds both indexes against sqlite's own text, and the next
  // read is a tail read again.
  migrated.submitTurn("session_one", { runId: "run_next", input: "and again" });
  const token = migrated.claimTurn("session_one", "worker_one")!.claim!.token;
  migrated.markRunning("session_one", "run_next", token);
  migrated.ingestObservations("session_one", "run_next", token, [
    { kind: "item.started", item: { id: "run_next_item", detail: { type: "assistant_message", text: "" } } },
    { kind: "item.completed", itemId: "run_next_item", status: "completed", detail: { type: "assistant_message", text: BODY } },
  ]);
  migrated.completeTurn("session_one", "run_next", token, { text: "done" });

  const warm = open(home);
  warm.readAccounting.documentBytes = 0;
  const after = warm.snapshotWindow("session_one", { limit: 8 });
  expect(after.turns.map((turn) => turn.runId)).toEqual([...before.turns.slice(1).map((turn) => turn.runId), "run_next"]);
  expect(warm.readAccounting.documentBytes).toBeLessThan(whole / 2);
});

test("a windowed read still pages, and an unsettled turn still rides along", () => {
  const home = conversation(12);
  const store = open(home);
  store.submitTurn("session_one", { runId: "run_live", input: "Now" });

  const first = store.snapshotWindow("session_one", { limit: 3 });
  expect(first.turns.map((turn) => turn.runId)).toEqual(["run_9", "run_10", "run_11", "run_live"]);
  expect(first.page).toEqual({ before: "run_9", more: true, total: 13 });

  // An older page is history: it drops the live turn rather than repeating it.
  const older = store.snapshotWindow("session_one", { limit: 3, before: "run_9" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_6", "run_7", "run_8"]);
  expect(older.items.every((item) => ["run_6", "run_7", "run_8"].includes(item.runId))).toBe(true);
  expect(older.page).toEqual({ before: "run_6", more: true, total: 13 });
});

test("paging back from the tail reaches the first turn with no gap and no repeat", () => {
  const home = conversation(17, 2);
  const store = open(home);
  store.submitTurn("session_one", { runId: "run_live", input: "Now" });
  const whole = sessionSnapshot(store, "session_one");
  // No window, no page: the unwindowed answer is the shape it always was.
  expect(Object.keys(whole).sort()).toEqual(["assignments", "cursor", "items", "requests", "session", "tasks", "turns"]);

  const turns: string[] = [];
  const items: string[] = [];
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const page = sessionSnapshot(store, "session_one", { turns: 5, ...(before === undefined ? {} : { before }) });
    pages += 1;
    expect(page.page!.total).toBe(18);
    // Prepended, exactly as a reader scrolling up would.
    turns.unshift(...page.turns.map((turn) => turn.runId));
    items.unshift(...page.items.map((item) => item.id));
    if (!page.page!.more) { expect(page.page!.before).toBeNull(); break; }
    before = page.page!.before!;
  }
  expect(pages).toBe(4);
  expect(turns).toEqual(whole.turns.map((turn) => turn.runId));
  expect(new Set(turns).size).toBe(turns.length);
  expect(items).toEqual(whole.items.map((item) => item.id));
}, 30_000);

/**
 * THE WINDOW'S ITEMS ARE AN INDEXED SEARCH, NOT A SCAN (#658). The plan of the
 * exact statement `itemRowsForRuns` runs, against the schema the real store
 * creates: were it ever `SCAN items`, a windowed open would cost the whole
 * history again however few rows it returned.
 */
test("the windowed item read searches items_run rather than scanning the table", () => {
  const home = root();
  fs.mkdirSync(path.join(home, "sessions"));
  new ExecutionStore(home).close();
  const db = new Database(path.join(home, "execution.sqlite"), { readonly: true });
  try {
    const plan = db.query(`EXPLAIN QUERY PLAN ${ITEM_ROWS_FOR_RUNS_SQL}`).all("session_one", JSON.stringify(["run_1", "run_2"])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect(details.some((detail) => /SEARCH items USING (COVERING )?INDEX items_run/.test(detail))).toBe(true);
    expect(details.some((detail) => /^SCAN items\b/.test(detail))).toBe(false);
  } finally {
    db.close();
  }
});

/**
 * #245. Windowing the key by turn was most of the fix; this is the shape it
 * left reachable — one long agentic turn that opened thousands of approvals,
 * every one of them inside the window that turn is in.
 */
test("a snapshot carries a bounded tail of settled requests, and every open one", () => {
  const home = root();
  const store = open(home);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  // Attached, so a request parks for a human rather than resolving by policy.
  store.createSession({ id: "session_one", projectId: "project_one", detached: false });

  store.submitTurn("session_one", { runId: "run_busy", input: "do the thing" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_busy", token);
  store.openRequest("session_one", "run_busy", token, {
    requestId: "req_seed",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "echo seed" } },
  });
  store.resolveRequest("session_one", "req_seed", { decision: "accept" });
  store.openRequest("session_one", "run_busy", token, {
    requestId: "req_open",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf build" } },
  });

  // The 2,000 settled ones are clones of a request this store wrote, imported
  // as a legacy home: opening each through the public path would be too slow.
  const settled = store.requests("session_one").find((request) => request.id === "req_seed")!;
  const opened = store.requests("session_one").find((request) => request.id === "req_open")!;
  const many = Array.from({ length: 2_000 }, (_, at) => ({ ...settled, id: `req_${at}`, openedAt: 100 + at }));
  toLegacyHome(store, home, (key, value) => key.endsWith("/requests.json") ? { ...(value as object), requests: [...many, opened] } : value);

  const reopened = open(home);
  const window = reopened.snapshotWindow("session_one", { limit: 10 });

  // THE PROOF THE ISSUE ASKS FOR: 2,000 settled requests, and the key the
  // snapshot carries is under 30 KB.
  expect(JSON.stringify(window.requests).length).toBeLessThan(30_000);
  expect(window.requests.filter((request) => request.state === "open").map((request) => request.id)).toEqual(["req_open"]);
  // The tail, newest kept: the last fifty settled, in document order.
  const carried = window.requests.filter((request) => request.state !== "open");
  expect(carried).toHaveLength(50);
  expect(carried.map((request) => request.id)).toEqual(Array.from({ length: 50 }, (_, at) => `req_${1_950 + at}`));

  // The unwindowed snapshot is bounded the same way…
  expect(JSON.stringify(reopened.snapshotRequests("session_one")).length).toBeLessThan(30_000);
  expect(reopened.snapshotRequests("session_one").map((request) => request.id).at(-1)).toBe("req_open");
  // …and `requests()` is untouched: what a session was ever asked is a
  // different question from what a transcript renders.
  expect(reopened.requests("session_one")).toHaveLength(2_001);
});

test("a session with few requests carries all of them, open or settled", () => {
  const home = conversation(3);
  const store = open(home);
  const window = store.snapshotWindow("session_one", { limit: 10 });
  expect(window.requests).toEqual([]);
  expect(store.snapshotRequests("session_one")).toEqual([]);
});

test("a window carries every item its turns own", () => {
  const home = conversation(12, 8);
  const store = open(home);
  const everyItem = store.items("session_one");
  expect(everyItem).toHaveLength(12 * 8);
  const window = open(home).snapshotWindow("session_one", { limit: 2 });
  expect(window.items).toEqual(everyItem.filter((item) => ["run_10", "run_11"].includes(item.runId)));
  expect(window.items).toHaveLength(16);
});

/** The scanner the index is built with, on text that is not ASCII. */
test("array element ranges point at whole elements, in bytes", () => {
  const value = { version: 2, sessionId: "session_one", turns: [{ runId: "run_1", text: "café ☕" }, { runId: "run_2", text: 'a "quoted" ] brace }' }, { runId: "run_3", text: "plain" }] };
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const ranges = arrayElementRanges(bytes, "turns")!;
  expect(ranges).toHaveLength(3);
  for (const [at, range] of ranges.entries()) {
    expect(JSON.parse(bytes.toString("utf8", range.start, range.end))).toEqual(value.turns[at]!);
  }
  // A span from one element to another is a valid array body once bracketed,
  // which is what makes a one-read window possible.
  expect(parseSpan(bytes.subarray(ranges[1]!.start, ranges[2]!.end))).toEqual([value.turns[1]!, value.turns[2]!]);

  expect(arrayElementRanges(Buffer.from('{"turns":[]}'), "turns")).toEqual([]);
  expect(arrayElementRanges(Buffer.from('{"turns":{}}'), "turns")).toBeUndefined();
  expect(arrayElementRanges(Buffer.from('{"other":[1]}'), "turns")).toBeUndefined();
});
