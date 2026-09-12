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
 * FOUR NUMBERS, because they attribute the cost to different layers:
 *
 *   raw append              one INSERT, its own implicit transaction — the sqlite
 *                           floor, one WAL fsync per event at `synchronous=FULL`.
 *   raw append, batched     the same INSERTs inside ONE transaction: what
 *                           amortising the fsync is worth and nothing else.
 *   ingest, N per call      the REAL path a delta takes — `reportObservations`,
 *                           swept over the batch sizes coalescing produces.
 *
 * READ THE SWEEP, NOT ONE ROW. A 16 ms coalescing window at 133 deltas/s holds
 * about two chunks, not sixteen, so `2 per call` is what the driver's tick
 * actually buys and `16 per call` is the shape of the ceiling. The gap between
 * "raw append" and "ingest, 1 per call" is everything the store does AROUND the
 * insert — the queue read, the item projection's read and rewrite, the receipt,
 * the commit — and on a session with any history that gap, not the fsync, is
 * the cost. That is why this bench times the public path and not just
 * `ExecutionStore.append`.
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

// ── the sqlite floor, on a store of its own so the timings above are untouched ──
const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-append-raw-"));
fs.mkdirSync(path.join(rawRoot, "sessions", "session_raw"), { recursive: true });
const raw = new ExecutionStore(rawRoot);
const event = (id: number): EngineEvent =>
  ({ id, at: 1, sessionId: "session_raw", runId: "run_raw", type: "content.delta", itemId: "item", stream: "assistant_text", text: DELTA }) as EngineEvent;

let id = 0;
let started = performance.now();
for (let n = 0; n < deltas; n += 1) raw.append(event((id += 1)));
report("raw append", performance.now() - started, deltas);

started = performance.now();
for (let n = 0; n < deltas; n += batch) {
  raw.transaction("bench", () => {
    for (let k = 0; k < batch && n + k < deltas; k += 1) raw.append(event((id += 1)));
  });
}
report(`raw append, ${batch} per txn`, performance.now() - started, deltas);
raw.close();
fs.rmSync(rawRoot, { recursive: true, force: true });

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
