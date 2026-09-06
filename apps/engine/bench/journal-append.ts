/**
 * How long 20 journal appends take on a session that already holds N events.
 *
 *   bun run --cwd apps/engine bench:journal            # 1k, 10k, 50k
 *   bun run --cwd apps/engine bench:journal 200000     # any sizes
 *
 * The journal is synthetic (one plausible record per id, ~200 bytes each) and
 * the appends go through `submitTurn`/`stopTurn`, the public path a real turn
 * takes, so the number includes the queue read/write beside the append. Each
 * size runs on a fresh store, so the first append is the cold one that seeds
 * the head from the journal tail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const APPENDS = 20;
const sizes = process.argv.slice(2).map(Number).filter((size) => Number.isSafeInteger(size) && size > 0);

function storeWithJournal(events: number): { store: EngineStore; root: string; bytes: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-bench-"));
  const store = new EngineStore(root, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" }); // event 1
  const file = path.join(root, "sessions", "session_one", "events.ndjson");
  const lines: string[] = [];
  for (let id = 2; id <= events; id += 1) {
    lines.push(
      JSON.stringify({ id, at: 100, sessionId: "session_one", runId: `run_${id}`, type: "turn.text", text: `synthetic event ${id} `.repeat(6) }),
    );
  }
  if (lines.length) fs.appendFileSync(file, `${lines.join("\n")}\n`);
  // The synthetic records were written behind the first store's back, so hand
  // the measurement to a fresh instance — the same shape as a daemon restart
  // over an existing journal.
  return { store: new EngineStore(root, () => 100), root, bytes: fs.statSync(file).size };
}

for (const size of sizes.length ? sizes : [1_000, 10_000, 50_000]) {
  const { store, root, bytes } = storeWithJournal(size);
  const started = performance.now();
  // submit + stop is two appends (turn.accepted, turn.stopped) and keeps the
  // queue empty, so the session's queued-turn cap never interferes.
  for (let n = 0; n < APPENDS / 2; n += 1) {
    store.submitTurn("session_one", { runId: `bench_${n}`, input: "x" });
    store.stopTurn("session_one", `bench_${n}`);
  }
  const elapsed = performance.now() - started;
  const last = store.eventCursor("session_one");
  console.log(`${size.toLocaleString("en-US").padStart(9)} events (${(bytes / 1e6).toFixed(1).padStart(5)} MB): ${APPENDS} appends in ${elapsed.toFixed(1).padStart(7)} ms  (last id ${last})`);
  fs.rmSync(root, { recursive: true, force: true });
}
