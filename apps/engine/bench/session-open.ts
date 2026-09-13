/**
 * WHAT IT COSTS TO OPEN A CONVERSATION, OVER THE REAL WIRE (#407).
 *
 * A cockpit switching sessions asked twice and could not overlap the two: the
 * journal's `after` is the snapshot's own answer, so the second request waits on
 * the first. `/v2/sessions/:id/bootstrap` answers both from one read. This
 * prices the difference against a real store built here, through the daemon's
 * loopback HTTP — so the serialisation, the parse and the socket are all in it.
 *
 * IT MEASURES THE ENGINE BOUNDARY ONLY. In the app each of these requests also
 * crosses a Next route handler, which forwards it to this same socket — so the
 * saved round trip is worth roughly twice what this bench reports. The
 * end-to-end figure needs a running app and is measured with
 * `apps/web/lib/perf-marks.ts` instead.
 *
 * Run: `bun run --cwd apps/engine bench:open [turns] [itemsPerTurn] [reps]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine } from "../src/daemon";

const TURNS = Number(process.argv[2] ?? 40);
const ITEMS_PER_TURN = Number(process.argv[3] ?? 8);
const REPS = Number(process.argv[4] ?? 30);
/** Roughly a paragraph of reply or a trimmed tool result. */
const BODY = "x".repeat(2_000);

const root = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "telar-open-bench-"));
const home = root();
const daemon = await startEngine({ engineRoot: home });
const client = new EngineClient(daemon.discovery);

await client.registerProject({ id: "project_bench", name: "Bench", root: root() });
await client.createSession({ id: "session_bench", projectId: "project_bench" });
await client.registerWorker("worker_bench");

/**
 * Seeded through the PUBLIC path — claim, run, ingest, complete — so the
 * documents behind the reads hold exactly what production's would, journal
 * included. A hand-written queue would price a store no engine ever wrote.
 */
const store = daemon.store as never as {
  submitTurn(id: string, input: unknown): unknown;
  claimTurn(id: string, workerId: string): { claim?: { token: string } } | undefined;
  markRunning(id: string, runId: string, token: string): unknown;
  ingestObservations(id: string, runId: string, token: string, observations: unknown[]): unknown;
  completeTurn(id: string, runId: string, token: string, result: { text: string }): unknown;
};

for (let index = 0; index < TURNS; index += 1) {
  const runId = `run_${index}`;
  store.submitTurn("session_bench", { runId, input: `message ${index}` });
  const token = store.claimTurn("session_bench", "worker_bench")!.claim!.token;
  store.markRunning("session_bench", runId, token);
  for (let step = 0; step < ITEMS_PER_TURN; step += 1) {
    const id = `${runId}_item_${step}`;
    store.ingestObservations("session_bench", runId, token, [
      { kind: "item.started", item: { id, detail: { type: "assistant_message", text: "" } } },
      { kind: "item.completed", itemId: id, status: "completed", detail: { type: "assistant_message", text: BODY } },
    ]);
  }
  store.completeTurn("session_bench", runId, token, { text: `answer ${index}` });
}

const window = { turns: 10 } as const;
const bytes = JSON.stringify(await client.sessionBootstrap("session_bench", window)).length;
console.log(`${TURNS} turns × ${ITEMS_PER_TURN} items, 10-turn window, ${(bytes / 1024).toFixed(0)} KB per open, ${REPS} opens each\n`);

/** What `hydrateSession` used to do, and still does against an older engine. */
async function twoReads(): Promise<void> {
  const snapshot = await client.session("session_bench", window);
  await client.events("session_bench", snapshot.cursor ?? 0);
}
async function oneRead(): Promise<void> {
  await client.sessionBootstrap("session_bench", window);
}

const rows: [string, () => Promise<void>][] = [
  ["snapshot + events (serial)", twoReads],
  ["bootstrap (one read)", oneRead],
];

async function sweep(): Promise<number[]> {
  const timings: number[] = [];
  for (const [, run] of rows) {
    await run();
    const started = performance.now();
    for (let index = 0; index < REPS; index += 1) await run();
    timings.push((performance.now() - started) / REPS);
  }
  return timings;
}

// Two alternating passes, as `append-cost.ts` does: this machine is shared, and
// a single sweep gives the second row a different machine from the first.
const first = await sweep();
const second = await sweep();
for (const [index, [label]] of rows.entries()) {
  console.log(`${label.padEnd(28)} ${first[index]!.toFixed(2)} / ${second[index]!.toFixed(2)} ms/open`);
}

await daemon.close();
fs.rmSync(home, { recursive: true, force: true });
