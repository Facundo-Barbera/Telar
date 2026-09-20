/**
 * ITEMS AS ROWS — issue #658, step 1.
 *
 * `items.json` was one row rewritten whole on every batch that touched an item,
 * so writing the Nth item cost the whole of the N-1 before it. Measured at the
 * write seam: 25 items cost 1.5 MiB of writes to build a 60 KiB document, 800
 * cost 1.45 GiB to build 1.9 MiB. The amplification factor IS the item count.
 *
 * ══ HOW THIS FILE TRIES NOT TO LIE ══
 *
 * The issue's own list of ways to get this wrong, each answered here:
 *
 *   1. COUNT BYTES, NOT CALLS. Splitting one write into two moves a call count
 *      without moving the disk. Every assertion below is bytes.
 *   2. HOOK EVERY SEAM, AND HOLD A LOWER BOUND. A counter on a method the write
 *      path has stopped using reads ZERO, and zero passes any "less than". All
 *      three doors an item's text can reach the database through are hooked,
 *      and the bytes must be at least the projection they built.
 *   3. SIZE THE FIXTURE ABOVE THE CROSSOVER. At four items the two shapes are
 *      within 12 KiB of each other and a test would pass unfixed. 200 items put
 *      two orders of magnitude between them.
 *   4. FLUSH THE WAY THE DRIVER FLUSHES — one `ingestObservations` call per
 *      observation. `bench/append-cost.ts` sends two in one call, which halves
 *      the writes and hides the per-event shape.
 *   5. DO NOT MEASURE THE FILE. 1.45 GiB of writes left an 8 MiB sqlite file.
 *      Nothing here stats the database.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const roots: string[] = [];
const stores: EngineStore[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-items-rows-"));
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

function open(directory: string, backend: Backend): EngineStore {
  let clock = 1_000;
  const store = new EngineStore(directory, () => (clock += 1), backend === "sqlite" ? { executionStorage: "sqlite" } : {});
  stores.push(store);
  return store;
}

/** Roughly a paragraph of reply, so a row weighs what a real one weighs. */
const BODY = "x".repeat(800);

/** Well past the eight-item crossover the investigation measured, and far
 *  enough past it that the two shapes differ by orders of magnitude. */
const ITEMS = 200;
const PER_TURN = 5;

/** The item's text at each of the two events the driver sends for it. */
const opened = (id: string) => ({ kind: "item.started" as const, item: { id, detail: { type: "assistant_message" as const, text: "" } } });
const closed = (id: string, text: string) =>
  ({ kind: "item.completed" as const, itemId: id, status: "completed" as const, detail: { type: "assistant_message" as const, text } });

/**
 * A session of `ITEMS` items, seeded through the PUBLIC path, ONE
 * `ingestObservations` CALL PER OBSERVATION — trap 4.
 */
function seed(store: EngineStore, sessionId = "session_one"): void {
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: sessionId, projectId: "project_one" });
  for (let turn = 0; turn < ITEMS / PER_TURN; turn += 1) {
    const runId = `run_${turn}`;
    store.submitTurn(sessionId, { runId, input: `message ${turn}` });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    for (let step = 0; step < PER_TURN; step += 1) {
      const id = `${runId}_item_${step}`;
      store.ingestObservations(sessionId, runId, token, [opened(id)]);
      store.ingestObservations(sessionId, runId, token, [closed(id, `${BODY} ${turn}.${step}`)]);
    }
    store.completeTurn(sessionId, runId, token, { text: `answer ${turn}` });
  }
}

/**
 * EVERY DOOR AN ITEM'S TEXT CAN REACH THE DATABASE THROUGH — trap 2.
 *
 * `writeText` is the blob's, `upsertItems` the row shape's, and
 * `migrateItemsToRows` the one-time move between them. Hooked together so that
 * a write path which moved to any one of them is still seen, and so that a
 * write path which moved to a FOURTH makes the lower bound below fail rather
 * than making this read a triumphant zero.
 */
type Row = { id: string; runId: string; value: string };
type Seam = {
  writeText(file: string, text: string): void;
  upsertItems(sessionId: string, rows: ReadonlyArray<Row>): void;
  migrateItemsToRows(sessionId: string, rows: ReadonlyArray<Row>, documents: string[]): void;
};
function countItemBytes(store: EngineStore): () => number {
  const seam = (store as unknown as { executionStore: Seam }).executionStore;
  let bytes = 0;
  const writeText = seam.writeText.bind(seam);
  seam.writeText = (file, text) => {
    if (path.basename(file) === "items.json") bytes += Buffer.byteLength(text, "utf8");
    writeText(file, text);
  };
  const upsertItems = seam.upsertItems.bind(seam);
  seam.upsertItems = (sessionId, rows) => {
    for (const row of rows) bytes += Buffer.byteLength(row.value, "utf8");
    upsertItems(sessionId, rows);
  };
  const migrate = seam.migrateItemsToRows.bind(seam);
  seam.migrateItemsToRows = (sessionId, rows, documents) => {
    for (const row of rows) bytes += Buffer.byteLength(row.value, "utf8");
    migrate(sessionId, rows, documents);
  };
  return () => bytes;
}

// ── the claim ───────────────────────────────────────────────────────────────

test("two hundred items cost two hundred items' worth of writes, not two hundred documents", () => {
  const store = open(root(), "sqlite");
  const bytes = countItemBytes(store);
  seed(store);

  const items = store.items("session_one");
  expect(items).toHaveLength(ITEMS);
  const projection = Buffer.byteLength(JSON.stringify(items), "utf8");

  /**
   * THE UPPER BOUND — trap 3. Each item is stored twice, once nearly empty when
   * it opens and once whole when it closes, so the honest figure is a little
   * over one projection. Three is slack. The blob shape writes the whole
   * projection on EVERY one of the four hundred batches: about 200× this bound,
   * which is why a fixture this size cannot pass both ways by accident.
   */
  expect(bytes()).toBeLessThan(projection * 3);

  /**
   * THE LOWER BOUND — trap 2, and the reason this test is worth anything. If
   * the write path moves to a seam none of the three hooks above cover, this
   * counter reads zero and the assertion above passes triumphantly. Two hundred
   * items were stored; their bytes have to have gone somewhere this can see.
   */
  expect(bytes()).toBeGreaterThan(projection * 0.9);
});

test("the item a batch did not touch is not rewritten", () => {
  // The same claim one item at a time, which is the shape the amplification
  // came from: the last write of a 200-item session must weigh one item.
  const store = open(root(), "sqlite");
  seed(store);

  const runId = "run_last";
  store.submitTurn("session_one", { runId, input: "one more" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", runId, token);

  const bytes = countItemBytes(store);
  store.ingestObservations("session_one", runId, token, [opened("last_item")]);
  store.ingestObservations("session_one", runId, token, [closed("last_item", BODY)]);

  const stored = store.items("session_one").find((item) => item.id === "last_item")!;
  const one = Buffer.byteLength(JSON.stringify(stored), "utf8");
  expect(bytes()).toBeGreaterThan(one * 0.9);
  // Two writes of one item, not two writes of two hundred and one.
  expect(bytes()).toBeLessThan(one * 3);
});

// ── the answer is the same answer ───────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`the projection reads back whole and in first-open order (${backend})`, () => {
    const directory = root();
    const store = open(directory, backend);
    seed(store);
    const expected = Array.from({ length: ITEMS / PER_TURN }, (_, turn) =>
      Array.from({ length: PER_TURN }, (_, step) => `run_${turn}_item_${step}`)).flat();

    expect(store.items("session_one").map((item) => item.id)).toEqual(expected);
    // And across a restart, from whatever shape it is actually stored in.
    const reopened = open(directory, backend);
    expect(reopened.items("session_one")).toEqual(store.items("session_one"));
  });

  test(`a window carries its own turns' items and no others (${backend})`, () => {
    const directory = root();
    const store = open(directory, backend);
    seed(store);
    const every = store.items("session_one");

    // A store of its own, so the answer comes from storage rather than from a
    // cache the seeding left warm — which is the path the run index is for.
    const cold = open(directory, backend);
    const window = cold.snapshotWindow("session_one", { limit: 4 });
    const chosen = new Set(window.turns.map((turn) => turn.runId));
    expect(chosen.size).toBe(4);
    expect(window.items).toEqual(every.filter((item) => chosen.has(item.runId)));
    expect(window.items).toHaveLength(4 * PER_TURN);
  });
}

// ── the migration ───────────────────────────────────────────────────────────

/** A sqlite store holding a session in the OLD shape: the blob, its offset
 *  index, and no marker. Built by seeding on JSON and importing, which is the
 *  route every existing store will actually take. */
function blobShaped(): { directory: string; expected: ReturnType<EngineStore["items"]> } {
  const directory = root();
  const json = open(directory, "json");
  seed(json);
  const expected = json.items("session_one");
  json.closeExecutionStore();
  stores.splice(stores.indexOf(json), 1);
  return { directory, expected };
}

type Marker = { itemsAreRows(sessionId: string): boolean; read(file: string): unknown; byteLength(file: string): number | undefined };
const inner = (store: EngineStore): Marker => (store as unknown as { executionStore: Marker }).executionStore;

test("a session stored as a blob is moved to rows the first time it is read, and answers identically", () => {
  const { directory, expected } = blobShaped();
  const store = open(directory, "sqlite");
  const items = path.join(directory, "sessions", "session_one", "items.json");

  // Imported, not yet migrated: the blob is there and the marker is not.
  expect(inner(store).itemsAreRows("session_one")).toBe(false);
  expect(inner(store).byteLength(items)).toBeGreaterThan(ITEMS * BODY.length);

  expect(store.items("session_one")).toEqual(expected);

  // And now it is rows: marker present, blob and its index gone.
  expect(inner(store).itemsAreRows("session_one")).toBe(true);
  expect(inner(store).byteLength(items)).toBeUndefined();
  expect(inner(store).byteLength(path.join(directory, "sessions", "session_one", "items.index.json"))).toBeUndefined();

  // The answer survives the shape change and a restart.
  expect(open(directory, "sqlite").items("session_one")).toEqual(expected);
});

test("a migration killed before it commits leaves the blob, the index and no marker", () => {
  const { directory, expected } = blobShaped();
  const store = open(directory, "sqlite");
  const items = path.join(directory, "sessions", "session_one", "items.json");
  const index = path.join(directory, "sessions", "session_one", "items.index.json");
  const before = inner(store).byteLength(items);
  const beforeIndex = inner(store).byteLength(index);
  expect(before).toBeGreaterThan(ITEMS * BODY.length);

  /**
   * THE KILL, AT THE WORST MOMENT THERE IS: after the rows are inserted and the
   * documents are deleted, as the marker is about to land. That is the one
   * instant where a store that did this in two transactions would lose the
   * projection — rows nobody will read, and no blob to read instead.
   *
   * `statement` is intercepted rather than the process being signalled, which
   * is the honest limit of this test and is stated as such: it proves the
   * TRANSACTION BOUNDARY holds, not that SIGKILL behaves. `intercepted` is
   * asserted below so a rename that slips past this hook fails here rather than
   * passing as a migration that was never interrupted.
   */
  const seam = store as unknown as { executionStore: { statement(sql: string): unknown } };
  const real = seam.executionStore.statement.bind(seam.executionStore);
  let intercepted = 0;
  seam.executionStore.statement = (sql: string) => {
    if (sql.startsWith("INSERT INTO metadata")) {
      intercepted += 1;
      throw new Error("killed mid-migration");
    }
    return real(sql);
  };

  expect(() => store.items("session_one")).toThrow("killed mid-migration");
  expect(intercepted).toBe(1);
  seam.executionStore.statement = real;

  // NOTHING MOVED. The blob is byte-for-byte what it was, its index is beside
  // it, and the marker never landed — which is a correct unmigrated session.
  expect(inner(store).itemsAreRows("session_one")).toBe(false);
  expect(inner(store).byteLength(items)).toBe(before!);
  // Whatever the index was — a legacy import carries no offset index at all,
  // since `importLegacy` moves the five documents and not the two derived from
  // them — it is exactly what it was.
  expect(inner(store).byteLength(index)).toBe(beforeIndex!);

  // And the next read simply tries again and succeeds.
  expect(store.items("session_one")).toEqual(expected);
  expect(inner(store).itemsAreRows("session_one")).toBe(true);
});

test("deleting a session takes its rows and the marker that points at them", () => {
  const directory = root();
  const store = open(directory, "sqlite");
  seed(store);
  expect(store.items("session_one")).toHaveLength(ITEMS);
  expect(inner(store).itemsAreRows("session_one")).toBe(true);

  expect(store.deleteSession("session_one")).toBe(true);
  expect(inner(store).itemsAreRows("session_one")).toBe(false);

  /**
   * AND A SESSION THAT COMES BACK UNDER THE SAME ID STARTS EMPTY — the failure
   * the sweep exists to prevent, which a marker left behind turns into a
   * conversation that reads as empty rather than into an error.
   */
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(store.items("session_one")).toEqual([]);
});
