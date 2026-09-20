/**
 * WHAT `GET /v2/sessions/live` COSTS ON A STORE SHAPED LIKE THE OWNER'S — #493.
 *
 *   bun run --cwd apps/engine bench:live           # 291 sessions, 284 settled
 *   bun run --cwd apps/engine bench:live 291 284 12
 *
 * THE SHAPE IS MEASURED, NOT INVENTED, and it is the one #457 re-measured on the
 * owner's machine: 291 sessions in the store, of which SEVEN are not settled.
 * The other 284 were folded, projected and serialised on every poll so that each
 * rail could decide, again, to draw them on a shelf nobody had open — 276 KB and
 * 2.33 s per read, three seconds apart, per connected cockpit.
 *
 * SETTLED BY THE CLOCK, WHICH IS HOW THE OWNER'S ARE. The seed runs the store on
 * a clock thirty days in the past for the settled ones and moves it to now for
 * the live seven, so every one of the 284 is stale against the default settling
 * window rather than carrying an explicit pin. A fixture that pinned them would
 * be measuring a cheaper decision than the one production makes.
 *
 * A FIXTURE DAEMON IN A TEMP DIR, NEVER A LIVE ENGINE. It starts its own daemon
 * on a random port, measures, and removes the directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EngineStore } from "../src/state";
import { startEngine } from "../src/daemon";

const [total = 291, settled = 284, turnsEach = 12] = process.argv.slice(2).map(Number);
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 20);
const DAY_MS = 86_400_000;
/** ~2.7 KB a turn, the measured average of the dogfood machine's queues. */
const FILLER = "synthetic turn text ".repeat(135);

function seed(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-bench-"));
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  // Thirty days back for the settled ones, so the inactivity clock has long
  // since passed over them; `live` moves to the present for the last seven.
  let clock = Date.now() - 30 * DAY_MS;
  const store = new EngineStore(root, () => (clock += 1), { executionStorage: "sqlite" });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (let n = 0; n < total; n += 1) {
    if (n === settled) clock = Date.now() - 60_000;
    const sessionId = `session_${String(n).padStart(6, "0")}`;
    store.createSession({ id: sessionId, projectId: "project_one" });
    let last = "";
    for (let t = 0; t < turnsEach; t += 1) {
      const runId = `run_${n}_${t}`;
      store.submitTurn(sessionId, { runId, input: `${FILLER}${runId}` });
      store.stopTurn(sessionId, runId);
      last = runId;
    }
    /**
     * THE SETTLED ONES HAVE BEEN READ, which is what makes them settled.
     * `isSettled` refuses to shelve a session carrying an answer nobody has
     * seen — deliberately, it is the one failure the feature must not have — so
     * a fixture of unread sessions would be a fixture of 291 LIVE rows wearing a
     * settled label, and would measure the wrong path.
     */
    if (n < settled) store.markSessionRead(sessionId, last);
  }
  store.closeExecutionStore();
  return root;
}

/** `curl -w`'s two numbers, taken the way `curl -w` takes them: the whole
 *  request, wall clock, and the bytes that came back. */
async function sample(url: string, token: string): Promise<{ ms: number; bytes: number; status: number }> {
  const started = performance.now();
  const answer = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await answer.arrayBuffer();
  return { ms: performance.now() - started, bytes: body.byteLength, status: answer.status };
}

function report(label: string, runs: Array<{ ms: number; bytes: number; status: number }>): void {
  const sorted = [...runs].map((run) => run.ms).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const best = sorted[0]!;
  const worst = sorted.at(-1)!;
  const kb = (runs[0]!.bytes / 1000).toFixed(1);
  console.log(`  ${label.padEnd(24)} ${median.toFixed(1)} ms median (${best.toFixed(1)}–${worst.toFixed(1)}), ${kb} KB, HTTP ${runs[0]!.status}`);
}

const root = seed();
const sqlite = fs.statSync(path.join(root, "execution.sqlite")).size;
console.log(`seeded ${total} sessions (${settled} settled by the clock, ${turnsEach} turns each) — ${(sqlite / 1e6).toFixed(1)} MB sqlite`);

/**
 * THE FOLD'S OWN QUERY PLAN, read off the fixture's real database rather than a
 * sketch of it — the `sessions` scan the live route now decides from, and the
 * `documents` reads it replaced.
 */
const native = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
const raw = process.versions.bun
  ? new native.Database(path.join(root, "execution.sqlite"))
  : new native.DatabaseSync(path.join(root, "execution.sqlite"));
const plan = (sql: string): string =>
  raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row: Record<string, unknown>) => String(row.detail)).join(" | ");
console.log("\nEXPLAIN QUERY PLAN");
console.log(`  fold (after)   ${plan("SELECT * FROM sessions WHERE archived = 0")}`);
console.log(`  project rows   ${plan("SELECT * FROM sessions WHERE project_id='project_one'")}`);
console.log(`  fold (before)  ${plan("SELECT value FROM documents WHERE key LIKE 'sessions/%/session.json'")}`);
console.log(`  ids (before)   ${plan("SELECT key FROM documents WHERE key LIKE 'sessions/%/session.json'")}`);
console.log(`  ids (after)    ${plan("SELECT key FROM documents WHERE key >= 'sessions/' AND key < 'sessions0' AND key LIKE '%/session.json' ORDER BY key")}`);
console.log(`  delete (before)${plan("DELETE FROM documents WHERE substr(key,1,9)='sessions/'")}`);
console.log(`  delete (after) ${plan("DELETE FROM documents WHERE key >= 'sessions/' AND key < 'sessions0'")}`);
const rows = Number(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get().n);
const rowBytes = Number(raw.prepare("SELECT SUM(LENGTH(id)+LENGTH(COALESCE(project_id,''))+72) AS n FROM sessions").get().n);
const blobBytes = Number(raw.prepare("SELECT SUM(LENGTH(CAST(value AS BLOB))) AS n FROM documents").get().n);
console.log(`\n  sessions table  ${rows} rows ≈ ${(rowBytes / 1000).toFixed(0)} KB of scalars`);
console.log(`  documents       ${(blobBytes / 1e6).toFixed(1)} MB of blobs the fold used to parse`);
raw.close();

const daemon = await startEngine({ engineRoot: root });
const base = `http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live`;
const token = daemon.discovery.token;

console.log(`\n${SAMPLES} samples each`);
for (const [label, query] of [["default (unsettled)", ""], ["?all=1", "?all=1"], ["?full=1", "?full=1"]] as const) {
  await sample(`${base}${query}`, token); // warm
  const runs = [];
  for (let n = 0; n < SAMPLES; n += 1) runs.push(await sample(`${base}${query}`, token));
  report(label, runs);
}

await daemon.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
