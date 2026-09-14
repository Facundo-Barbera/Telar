/**
 * WHAT A WINDOWED SNAPSHOT COSTS, AND WHAT IT CARRIES (#419, #245).
 *
 * Two complaints with one shape: opening a conversation was priced by its whole
 * history rather than by the ten turns it answers with. #419 is the read —
 * `queue.json` and `items.json` were parsed entire and filtered afterwards, so a
 * 120-turn session cost 38–44 ms where a 20-turn one cost 3.7 ms for an
 * identical 175 KB answer. #245 is the payload — the `requests` key carried
 * every approval the session had ever settled, 315 KB of the dogfood store's
 * 1.07 MB snapshot, none of which renders.
 *
 * Both are asserted against BOTH backends, because the fix is one mechanism
 * across two document stores and a claim about only one of them would be half a
 * claim.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { arrayElementRanges, parseSpan } from "../src/document-window";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-"));
  roots.push(directory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const stores: EngineStore[] = [];
const open = (home: string, storage: Storage): EngineStore => {
  const store = new EngineStore(home, () => 100, { executionStorage: storage });
  stores.push(store);
  return store;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Storage = "json" | "sqlite";
const BACKENDS: Storage[] = ["json", "sqlite"];

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
function conversation(storage: Storage, turns: number, itemsPerTurn = 3): string {
  const home = root();
  const store = open(home, storage);
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

for (const storage of BACKENDS) {
  test(`opening a 120-turn session reads its tail, not its history (${storage})`, () => {
    const home = conversation(storage, 120);

    // What the whole projection weighs, read by a store of its own so the one
    // under test starts with nothing parsed and nothing cached.
    const measured = open(home, storage);
    const everyItem = measured.items("session_one");
    const whole = JSON.stringify(everyItem).length + JSON.stringify(measured.turns("session_one")).length;

    const cold = open(home, storage);
    cold.readAccounting.documentBytes = 0;
    cold.readAccounting.documentReads = 0;
    const window = cold.snapshotWindow("session_one", { limit: 10 });
    const touched = cold.readAccounting.documentBytes;

    // THE ANSWER IS THE SAME ANSWER. The window is what it always was; only the
    // route to it changed.
    expect(window.turns.map((turn) => turn.runId)).toEqual(Array.from({ length: 10 }, (_, at) => `run_${110 + at}`));
    expect(window.page).toEqual({ before: "run_110", more: true });
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

}

test("a document with no index is read whole, and answers identically", () => {
  // The state every conversation written before #419 is in. The index is an
  // optimisation: losing it may cost time and may not change an answer.
  const home = conversation("json", 40);
  const indexed = open(home, "json").snapshotWindow("session_one", { limit: 10 });

  const session = path.join(home, "sessions", "session_one");
  fs.rmSync(path.join(session, "queue.index.json"));
  fs.rmSync(path.join(session, "items.index.json"));

  const stripped = open(home, "json");
  stripped.readAccounting.documentBytes = 0;
  expect(stripped.snapshotWindow("session_one", { limit: 10 })).toEqual(indexed);
  // …and it really did fall back, rather than quietly finding an index.
  expect(stripped.readAccounting.documentBytes).toBeGreaterThan(JSON.stringify(indexed.items).length * 2);
});

test("a conversation migrated into SQLite reads correctly before it is indexed again", () => {
  /**
   * THE MIGRATION IS THE REAL UNINDEXED CASE. `importLegacy` inserts the
   * documents it finds and no indexes — it has none to insert, and the ones on
   * disk describe the pretty-printed files rather than the compact rows sqlite
   * now holds. So the first read after a migration is a whole-document read,
   * and the first write earns the index back.
   */
  const home = conversation("json", 30);
  const before = open(home, "json").snapshotWindow("session_one", { limit: 8 });

  const migrated = open(home, "sqlite");
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

  const warm = open(home, "sqlite");
  warm.readAccounting.documentBytes = 0;
  const after = warm.snapshotWindow("session_one", { limit: 8 });
  expect(after.turns.map((turn) => turn.runId)).toEqual([...before.turns.slice(1).map((turn) => turn.runId), "run_next"]);
  expect(warm.readAccounting.documentBytes).toBeLessThan(whole / 2);
});

test("a queue edited behind the store's back is not read through a stale index", () => {
  // A test rewriting `queue.json` is the ordinary case of this, and the honest
  // answer is to distrust the index rather than to seek into bytes that moved.
  const home = conversation("json", 20);
  const reference = open(home, "json").snapshotWindow("session_one", { limit: 5 });

  const file = path.join(home, "sessions", "session_one", "queue.json");
  const queue = JSON.parse(fs.readFileSync(file, "utf8"));
  // Compact rather than indented: same turns, every offset moved.
  fs.writeFileSync(file, JSON.stringify(queue));

  const after = open(home, "json").snapshotWindow("session_one", { limit: 5 });
  expect(after.turns.map((turn) => turn.runId)).toEqual(reference.turns.map((turn) => turn.runId));
  expect(after.items).toEqual(reference.items);
});

test("a windowed read still pages, and an unsettled turn still rides along", () => {
  const home = conversation("json", 12);
  const store = open(home, "json");
  store.submitTurn("session_one", { runId: "run_live", input: "Now" });

  const first = store.snapshotWindow("session_one", { limit: 3 });
  expect(first.turns.map((turn) => turn.runId)).toEqual(["run_9", "run_10", "run_11", "run_live"]);
  expect(first.page).toEqual({ before: "run_9", more: true });

  // An older page is history: it drops the live turn rather than repeating it.
  const older = store.snapshotWindow("session_one", { limit: 3, before: "run_9" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_6", "run_7", "run_8"]);
  expect(older.items.every((item) => ["run_6", "run_7", "run_8"].includes(item.runId))).toBe(true);
  expect(older.page).toEqual({ before: "run_6", more: true });
});

/**
 * #245. Windowing the key by turn was most of the fix; this is the shape it
 * left reachable — one long agentic turn that opened thousands of approvals,
 * every one of them inside the window that turn is in.
 */
test("a snapshot carries a bounded tail of settled requests, and every open one", () => {
  const home = root();
  const store = open(home, "json");
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

  /**
   * The 2,000 settled ones are written as a FIXTURE rather than opened one at a
   * time: each `openRequest` rewrites the projection, so seeding them through
   * the public path would be four thousand rewrites of a growing document to
   * test a read. They are clones of a request this store really did write, so
   * the shape is the engine's own.
   */
  const settled = store.requests("session_one").find((request) => request.id === "req_seed")!;
  const opened = store.requests("session_one").find((request) => request.id === "req_open")!;
  const many = Array.from({ length: 2_000 }, (_, at) => ({ ...settled, id: `req_${at}`, openedAt: 100 + at }));
  const file = path.join(home, "sessions", "session_one", "requests.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, requests: [...many, opened] }, null, 2));

  const reopened = open(home, "json");
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
  const home = conversation("json", 3);
  const store = open(home, "json");
  const window = store.snapshotWindow("session_one", { limit: 10 });
  expect(window.requests).toEqual([]);
  expect(store.snapshotRequests("session_one")).toEqual([]);
});

test("the items index is one row per turn, not one per item", () => {
  /**
   * THE INDEX IS THE ONE DOCUMENT A TAIL READ STILL PARSES WHOLE, so it may not
   * grow the way the document does. `items.json` holds eight or more rows per
   * turn; an entry each would put the history back in the read by the side door
   * — on a 500-turn session, a 160 KB index in front of a 247 KB answer.
   */
  const home = conversation("json", 12, 8);
  const index = JSON.parse(fs.readFileSync(path.join(home, "sessions", "session_one", "items.index.json"), "utf8"));
  expect(index.rows).toHaveLength(12);
  expect(new Set(index.rows.map((row: { key: string }) => row.key)).size).toBe(12);

  // …and a turn's span still covers every item it owns.
  const store = open(home, "json");
  const everyItem = store.items("session_one");
  expect(everyItem).toHaveLength(12 * 8);
  const window = open(home, "json").snapshotWindow("session_one", { limit: 2 });
  expect(window.items).toEqual(everyItem.filter((item) => ["run_10", "run_11"].includes(item.runId)));
  expect(window.items).toHaveLength(16);
});

/** The scanner the index is built with, on the two shapes it has to survive:
 *  pretty-printed and compact, both carrying text that is not ASCII. */
test("array element ranges point at whole elements, in bytes", () => {
  const value = { version: 2, sessionId: "session_one", turns: [{ runId: "run_1", text: "café ☕" }, { runId: "run_2", text: 'a "quoted" ] brace }' }, { runId: "run_3", text: "plain" }] };
  for (const text of [JSON.stringify(value), `${JSON.stringify(value, null, 2)}\n`]) {
    const bytes = Buffer.from(text, "utf8");
    const ranges = arrayElementRanges(bytes, "turns")!;
    expect(ranges).toHaveLength(3);
    for (const [at, range] of ranges.entries()) {
      expect(JSON.parse(bytes.toString("utf8", range.start, range.end))).toEqual(value.turns[at]!);
    }
    // A span from one element to another is a valid array body once bracketed —
    // separators and all — which is what makes a one-read window possible.
    expect(parseSpan(bytes.subarray(ranges[1]!.start, ranges[2]!.end))).toEqual([value.turns[1]!, value.turns[2]!]);
  }

  expect(arrayElementRanges(Buffer.from('{"turns":[]}'), "turns")).toEqual([]);
  expect(arrayElementRanges(Buffer.from('{"turns":{}}'), "turns")).toBeUndefined();
  expect(arrayElementRanges(Buffer.from('{"other":[1]}'), "turns")).toBeUndefined();
});
