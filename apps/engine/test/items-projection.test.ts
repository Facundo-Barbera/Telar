/**
 * WHAT AN ITEM EVENT COSTS TO READ — issue #658, step 0.
 *
 * `itemsCache` exists so the streaming path can answer "does this delta's item
 * exist" without parsing `items.json` and revalidating every row through
 * `ItemSchema`. `writeItems` then threw the cache away on every write, so the
 * projection was rebuilt once per item event and once per delta that followed
 * one — 0.21 ms of parse and validate per event on a 100-item session, 11.75 ms
 * on a 7000-item one, on the thread streaming tokens.
 *
 * The claim these hold the engine to is that a turn's worth of item events
 * costs ONE parse of the projection rather than one per event, and it is made
 * with both bounds: `itemParses` must be exactly 1, and the bytes must be at
 * least most of one whole document. An instrument hooked to a path the engine
 * stopped using reads zero, and zero passes any "less than" on its own.
 *
 * `itemParses` rather than `documentBytes` alone, for #547's reason one
 * document over: bytes also move when a WINDOW reads a span, and a count of
 * whole-document parses is the number this issue is actually about.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-items-"));
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

/** Roughly a paragraph of reply, so a row weighs what a real one weighs. */
const BODY = "x".repeat(800);

/**
 * A session of `turns` turns holding `perTurn` items each, seeded the way the
 * DRIVER flushes: one `ingestObservations` call per observation.
 *
 * Seeding two observations in one call halves the writes and halves the reads
 * with them, which would hide the per-event shape this file is about — see
 * `bench/append-cost.ts`, which does exactly that on purpose because it is
 * measuring something else.
 */
function seeded(storage: Storage, turns: number, perTurn: number): string {
  const home = root();
  const store = open(home, storage);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `run_${turn}`;
    store.submitTurn("session_one", { runId, input: `message ${turn}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    for (let step = 0; step < perTurn; step += 1) {
      const id = `${runId}_item_${step}`;
      store.ingestObservations("session_one", runId, token, [
        { kind: "item.started", item: { id, detail: { type: "assistant_message", text: "" } } },
      ]);
      store.ingestObservations("session_one", runId, token, [
        { kind: "item.completed", itemId: id, status: "completed", detail: { type: "assistant_message", text: `${BODY} ${turn}.${step}` } },
      ]);
    }
    store.completeTurn("session_one", runId, token, { text: `answer ${turn}` });
  }
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);
  return home;
}

const TURNS = 40;
const PER_TURN = 5;
/** 200 items. Well past the eight-item crossover the investigation measured,
 *  and far enough past it that one whole-document read is unmistakable beside
 *  twenty of them. */
const SEEDED_ITEMS = TURNS * PER_TURN;

for (const storage of BACKENDS) {
  test(`a turn of item events reads the projection once, not once each (${storage})`, () => {
    const home = seeded(storage, TURNS, PER_TURN);

    // What one whole read weighs, priced by a store of its own so the one under
    // test starts cold and nothing it is about to do has been paid for here.
    const measured = open(home, storage);
    expect(measured.items("session_one")).toHaveLength(SEEDED_ITEMS);
    expect(measured.readAccounting.itemParses).toBe(1);
    const wholeDocument = measured.readAccounting.documentBytes;
    expect(wholeDocument).toBeGreaterThan(SEEDED_ITEMS * BODY.length);

    const store = open(home, storage);
    const runId = "run_measured";
    store.submitTurn("session_one", { runId, input: "once more" });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);

    store.readAccounting.documentBytes = 0;
    store.readAccounting.itemParses = 0;

    const EVENTS = 20;
    for (let index = 0; index < EVENTS; index += 1) {
      const id = `measured_item_${index}`;
      store.ingestObservations("session_one", runId, token, [
        { kind: "item.started", item: { id, detail: { type: "assistant_message", text: "" } } },
      ]);
      // The delta between them is the half of the cost the issue did not count:
      // `hasItem` re-read the projection too, once per streamed chunk.
      store.ingestObservations("session_one", runId, token, [
        { kind: "content.delta", itemId: id, stream: "assistant_text", text: BODY },
      ]);
      store.ingestObservations("session_one", runId, token, [
        { kind: "item.completed", itemId: id, status: "completed", detail: { type: "assistant_message", text: BODY } },
      ]);
    }

    // ONE PARSE FOR ALL OF IT. The first ingest finds a cold cache and reads the
    // document; every event after it is answered from what the write left
    // behind. Before this fix each of the twenty item events and each of the
    // twenty deltas paid for its own parse.
    expect(store.readAccounting.itemParses).toBe(1);

    // AND THE INSTRUMENT IS LOOKING — the bound that fails when the measurement
    // stops measuring rather than when the engine stops behaving. A counter
    // wired to a path the engine no longer takes reports zero, and `toBe(1)`
    // above is only half a claim if zero can reach it: the cold read priced at
    // the top of this test is what proves bytes still flow through this seam,
    // and it fails at 0 exactly as this one fails at 40.
    //
    // Bytes are the loose bound here rather than the tight one, because #547
    // put `readQueue` in the same total: forty batches read the queue as well,
    // so an exact figure would be measuring two documents at once. Five whole
    // projections still catches the shape this issue is about, which is forty.
    expect(store.readAccounting.documentBytes).toBeGreaterThan(wholeDocument * 0.9);
    expect(store.readAccounting.documentBytes).toBeLessThan(wholeDocument * 5);

    // …and the projection the cache kept is the projection the store holds.
    const every = store.items("session_one");
    expect(every).toHaveLength(SEEDED_ITEMS + EVENTS);
    expect(every.filter((item) => item.runId === runId).map((item) => item.id))
      .toEqual(Array.from({ length: EVENTS }, (_, index) => `measured_item_${index}`));
    const reopened = open(home, storage);
    expect(reopened.items("session_one")).toEqual(every);
  }, 60_000); // Seeding rewrites a growing projection 400 times.
}
