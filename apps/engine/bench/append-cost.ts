/**
 * WHAT ONE STREAMED TOKEN-CHUNK COSTS THE ENGINE.
 *
 *   bun run --cwd apps/engine bench:append           # the measured shape
 *   bun run --cwd apps/engine bench:append 327 400   # items in the session, deltas to time
 *
 * The shape is measured, not invented (docs/investigations/performance-2026-09-11.md):
 * a streaming turn peaks at 133.5 `content.delta`/s within one run, each about
 * 261 bytes, against a session whose item projection is ~327 items / 753 KB.
 * At that rate one millisecond per delta is 13.3% of a core, so the per-event
 * cost below IS the CPU share while an agent types.
 *
 * THE ROWS ATTRIBUTE THE COST TO DIFFERENT LAYERS:
 *
 *   append, uncoalesced     one INSERT and one transaction where the delta was
 *                           appended — the behaviour before #246.
 *                           `flushCount: 1` restores it.
 *   append, coalesced       the shipping default: deltas held and stored in one
 *                           transaction. #246's target (< 0.010).
 *   raw append, batched     the same INSERTs inside ONE explicit transaction,
 *                           for the fsync arithmetic on its own.
 *   ingest, N per call      the REAL path a delta takes — `reportObservations`,
 *                           swept over the batch sizes a driver might produce.
 *
 * `ingest, 1 per call` IS THE ROW THAT MATTERS, because one delta per call is
 * what a streaming driver actually produces. It measured 0.09–0.12 ms against
 * 0.006 for the append itself: the gap was everything `ingestObservations` did
 * AROUND the insert — a BEGIN/COMMIT over a batch that writes no row, the queue
 * re-parsed, the item projection copied, the task projection read — and on a
 * session with any history it dwarfed the write. #443 routes a delta-only batch
 * past all of it; the row is now under 0.02 and this bench is what keeps it
 * there. That is why it times the public path and not just
 * `ExecutionStore.append`.
 *
 * COMPARE A ROW WITH ITSELF ACROSS RUNS, NOT WITH THE ROW ABOVE IT. The sweep
 * shares one store, and the SECOND row measures about twice the first whichever
 * batch size is put there — swapping the sweep to `[2, 1, 4, 16]` moves the cost
 * onto `1 per call`, it does not move with the size. So it is something the
 * second pass inherits from the first (a grown store, a collection, a
 * checkpoint) rather than anything about batching, and the first row is the one
 * with a clean baseline behind it. That is the row #443 names.
 *
 * A terminal `item.completed` closes each timed append run, because that is
 * what forces a held batch out and a real streamed item always ends with one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { ExecutionStore } from "../src/execution-store";
import type { EngineEvent } from "@telar/engine-client";

const [items = 327, deltas = 400, batch = 16] = process.argv.slice(2).map(Number);
/** The measured average delta: 261 bytes of text. */
const DELTA = "streamed token chunk ".repeat(12) + "x".repeat(9);
/** ~2.3 KB an item, which is 327 items to the measured 753 KB projection. */
const ITEM_TEXT = "settled assistant message ".repeat(88);
/** The measured peak within one run. */
const DELTAS_PER_SECOND = 133;

function ready(): { store: EngineStore; root: string; runId: string; token: string; itemId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-append-bench-"));
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let clock = 1_000;
  const store = new EngineStore(root, () => (clock += 1), { executionStorage: "sqlite" });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });

  // A session with history: settled items the projection carries and every
  // later write has to serialise past. Seeded through the public path so the
  // documents hold exactly what production's would.
  const seedRun = "run_seed";
  store.submitTurn("session_one", { runId: seedRun, input: "Seed" });
  const seedToken = store.claimTurn("session_one", "worker_bench")!.claim!.token;
  store.markRunning("session_one", seedRun, seedToken);
  for (let n = 0; n < items; n += 1) {
    store.ingestObservations("session_one", seedRun, seedToken, [
      { kind: "item.started", item: { id: `item_${n}`, detail: { type: "assistant_message", text: "" } } },
      { kind: "item.completed", itemId: `item_${n}`, status: "completed", detail: { type: "assistant_message", text: ITEM_TEXT } },
    ]);
  }
  store.completeTurn("session_one", seedRun, seedToken, { text: "seeded" });

  // …and the turn the deltas stream into, with one open item to carry them.
  const runId = "run_stream";
  store.submitTurn("session_one", { runId, input: "Stream" });
  const token = store.claimTurn("session_one", "worker_bench")!.claim!.token;
  store.markRunning("session_one", runId, token);
  const itemId = "item_open";
  store.ingestObservations("session_one", runId, token, [
    { kind: "item.started", item: { id: itemId, detail: { type: "assistant_message", text: "" } } },
  ]);
  return { store, root, runId, token, itemId };
}

const report = (label: string, elapsed: number, events: number): void => {
  const per = elapsed / events;
  console.log(
    `${label.padEnd(26)} ${per.toFixed(4).padStart(8)} ms/event   ` +
      `${(per * DELTAS_PER_SECOND).toFixed(1).padStart(5)}% of a core at ${DELTAS_PER_SECOND} deltas/s`,
  );
};

const { store, root, runId, token, itemId } = ready();
const projection = fs.statSync(path.join(root, "execution.sqlite")).size;
console.log(`session seeded with ${items} settled items (${(ITEM_TEXT.length * items / 1e3).toFixed(0)} KB of item text, ${(projection / 1e6).toFixed(1)} MB sqlite)`);
console.log(`${deltas} deltas of ${DELTA.length} bytes each\n`);

// ── the sqlite floor, on stores of their own so the timings above are untouched ──
const event = (id: number): EngineEvent =>
  ({ id, at: 1, sessionId: "session_raw", runId: "run_raw", type: "content.delta", itemId: "item", stream: "assistant_text", text: DELTA }) as EngineEvent;
/** What ends a streamed item, and what forces a held batch to the disk. */
const settled = (id: number): EngineEvent =>
  ({ id, at: 1, sessionId: "session_raw", runId: "run_raw", type: "item.completed", itemId: "item",
    item: { id: "item", runId: "run_raw", sessionId: "session_raw", status: "completed", detail: { type: "assistant_message", text: DELTA }, startedAt: 1, completedAt: 1 } }) as EngineEvent;

function rawStore(flushCount?: number): { store: ExecutionStore; drop(): void } {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-append-raw-"));
  fs.mkdirSync(path.join(rawRoot, "sessions", "session_raw"), { recursive: true });
  return { store: new ExecutionStore(rawRoot, flushCount === undefined ? {} : { flushCount }), drop: () => fs.rmSync(rawRoot, { recursive: true, force: true }) };
}

/** Appends `deltas` of them and the `item.completed` that settles the batch. */
function timeAppends(label: string, flushCount?: number): void {
  const { store, drop } = rawStore(flushCount);
  let id = 0;
  const started = performance.now();
  for (let n = 0; n < deltas; n += 1) store.append(event((id += 1)));
  store.append(settled((id += 1)));
  report(label, performance.now() - started, deltas);
  store.close();
  drop();
}

timeAppends("append, uncoalesced", 1);
timeAppends("append, coalesced");

const { store: raw, drop: dropRaw } = rawStore(1);
let id = 0;
let started = performance.now();
for (let n = 0; n < deltas; n += batch) {
  raw.transaction("bench", () => {
    for (let k = 0; k < batch && n + k < deltas; k += 1) raw.append(event((id += 1)));
  });
}
report(`raw append, ${batch} per txn`, performance.now() - started, deltas);
raw.close();
dropRaw();

// ── the real path, swept over the batch sizes coalescing produces ──────────
const delta = { kind: "content.delta" as const, itemId, stream: "assistant_text" as const, text: DELTA };

for (const size of [1, 2, 4, batch]) {
  started = performance.now();
  for (let n = 0; n < deltas; n += size) {
    const count = Math.min(size, deltas - n);
    store.ingestObservations("session_one", runId, token, Array.from({ length: count }, () => delta));
  }
  report(`ingest, ${size} per call`, performance.now() - started, deltas);
}

store.closeExecutionStore();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
