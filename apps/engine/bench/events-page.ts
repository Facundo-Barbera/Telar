/**
 * WHAT ONE `GET /v2/sessions/:id/events` COSTS, PAGED AND UNPAGED (#490).
 *
 * `daemon.ts`'s `EVENT_PAGE_DEFAULT = 200` carries a number in its comment —
 * "185 KB / 106 ms against 36.5 MB / 2.48 s for the same session unpaged" —
 * attributed to "#490's audit". That audit was never produced
 * (`docs/investigations/closure-audit-2026-09-19.md`), so the figure has no
 * traceable invocation behind it. This bench is what it would have come from.
 *
 * IT PRICES THE RATIO, NOT THE HEADLINE. 36.5 MB is a property of whatever
 * session was measured, and no bench can reproduce a session it was not told
 * the shape of. What is reproducible — and what the cap actually rests on — is
 * that a paged read costs the page and an unpaged read costs the conversation,
 * so the two diverge linearly with length. Run it at two lengths and the slope
 * is the claim.
 *
 * SAME SEEDING AS `session-open.ts`: the public claim/run/ingest/complete path,
 * through the daemon's loopback HTTP, so serialisation, parse and socket are
 * all in the number. A hand-written journal would price a store no engine wrote.
 *
 * Run: `bun run --cwd apps/engine bench:events [turns] [itemsPerTurn] [reps]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine } from "../src/daemon";

const TURNS = Number(process.argv[2] ?? 40);
const ITEMS_PER_TURN = Number(process.argv[3] ?? 8);
const REPS = Number(process.argv[4] ?? 20);
/** Roughly a paragraph of reply or a trimmed tool result — `session-open.ts`'s. */
const BODY = "x".repeat(2_000);
/** The cap under test. */
const PAGE = 200;

const root = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "telar-events-bench-"));
const home = root();
const daemon = await startEngine({ engineRoot: home });
const client = new EngineClient(daemon.discovery);

await client.registerProject({ id: "project_bench", name: "Bench", root: root() });
await client.createSession({ id: "session_bench", projectId: "project_bench" });
await client.registerWorker("worker_bench");

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

/**
 * THE UNPAGED READ IS `limit=EVENT_PAGE_MAX`, NOT "no limit" — the route refuses
 * to serve a whole journal in one answer, which is the cap's entire point. So
 * the honest comparison is one page against the largest answer the route will
 * give, plus the number of round trips a full fold actually takes.
 */
const paged = await client.events("session_bench", 0, PAGE);
const widest = await client.events("session_bench", 0, 1_000);

const pagedBytes = JSON.stringify(paged).length;
const widestBytes = JSON.stringify(widest).length;

/** How many round trips a cockpit folding the WHOLE journal pays at each size. */
async function foldAll(limit: number): Promise<{ trips: number; bytes: number }> {
  let cursor = 0;
  let trips = 0;
  let bytes = 0;
  for (;;) {
    const page = await client.events("session_bench", cursor, limit);
    trips += 1;
    bytes += JSON.stringify(page).length;
    const rows = (page as { events?: { id: number }[] }).events ?? [];
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!.id;
    if (last === cursor) break;
    cursor = last;
    if ((page as { more?: boolean }).more === false) break;
  }
  return { trips, bytes };
}

const fold = await foldAll(PAGE);

console.log(`${TURNS} turns × ${ITEMS_PER_TURN} items  (BODY=${BODY.length} chars)\n`);
console.log(`one page (limit=${PAGE})        ${(pagedBytes / 1024).toFixed(1)} KB`);
console.log(`one page (limit=1000)          ${(widestBytes / 1024).toFixed(1)} KB`);
console.log(`whole journal, paged at ${PAGE}   ${(fold.bytes / 1024).toFixed(1)} KB over ${fold.trips} round trips\n`);

async function time(run: () => Promise<unknown>): Promise<number> {
  await run();
  const started = performance.now();
  for (let index = 0; index < REPS; index += 1) await run();
  return (performance.now() - started) / REPS;
}

const rows: [string, () => Promise<unknown>][] = [
  [`page of ${PAGE}`, () => client.events("session_bench", 0, PAGE)],
  ["page of 1000", () => client.events("session_bench", 0, 1_000)],
  ["whole journal (paged fold)", () => foldAll(PAGE)],
];

// Two alternating passes, as `session-open.ts` and `append-cost.ts` do: this
// machine is shared, and one sweep gives the last row a different machine from
// the first.
const first: number[] = [];
for (const [, run] of rows) first.push(await time(run));
const second: number[] = [];
for (const [, run] of rows) second.push(await time(run));
for (const [index, [label]] of rows.entries()) {
  console.log(`${label.padEnd(28)} ${first[index]!.toFixed(2)} / ${second[index]!.toFixed(2)} ms`);
}

await daemon.close();
fs.rmSync(home, { recursive: true, force: true });
