/**
 * What an IDLE engine spends, and where.
 *
 *   bun run --cwd apps/engine bench:idle              # default shape
 *   bun run --cwd apps/engine bench:idle 129 45 27    # sessions, live-index, turns each
 *   bun --cpu-prof --cpu-prof-md run --cwd apps/engine bench/idle-heartbeat.ts
 *
 * The shape is measured, not invented: on one dogfood machine after four and a
 * half hours the store held 129 sessions, 45 of which `liveQueueSessionIds`
 * considered live — 3.3 MB of queue JSON over 1233 turns, of which exactly TWO
 * were actually running. The other 155 were `stopped` turns still carrying a
 * claim, which is what `queueConcernsAWorker` counts, and which nothing ever
 * clears. The worker heartbeats ten times a second and each beat asks three
 * questions that each walk that index, so the daemon re-read and re-validated
 * ten megabytes a second to discover nothing had happened.
 *
 * TWO NUMBERS, because they answer different questions. `heartbeat` is the
 * store cost of one beat — attributable, and what a fix has to move. `idle` is
 * the whole daemon's `process.cpuUsage()` over a quiet window, which is the
 * number the person actually feels in Activity Monitor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { startEngine } from "../src/daemon";
import type { TurnDriver } from "../src/driver";

const [sessions = 129, liveIndex = 45, turnsEach = 27] = process.argv.slice(2).map(Number);
const IDLE_WINDOW_MS = Number(process.env.BENCH_IDLE_MS ?? 15_000);
/** ~2.7 KB a turn, the measured average of that machine's queues. */
const FILLER = "synthetic turn text ".repeat(135);

function seed(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-idle-bench-"));
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let clock = 1_000;
  const store = new EngineStore(root, () => (clock += 1), { executionStorage: "sqlite" });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  for (let n = 0; n < sessions; n += 1) {
    const sessionId = `session_${String(n).padStart(6, "0")}`;
    store.createSession({ id: sessionId, projectId: "project_one" });
    // A session in the live index carries a full history; an idle one carries
    // the one turn that makes it a real conversation rather than an empty row.
    const depth = n < liveIndex ? turnsEach : 1;
    for (let t = 0; t < depth; t += 1) {
      const runId = `run_${n}_${t}`;
      store.submitTurn(sessionId, { runId, input: `${FILLER}${runId}` });
      store.stopTurn(sessionId, runId);
    }
    if (n >= liveIndex) continue;
    /**
     * THE ZOMBIE, built the way production builds it: claim a turn, then Stop
     * it. `stopSession` moves the state to `stopped` and deliberately KEEPS the
     * claim so the worker learns of the stop over its heartbeat — and nothing
     * afterwards takes it away, so the session is in the index for the life of
     * the daemon.
     */
    store.submitTurn(sessionId, { runId: `run_${n}_live`, input: `${FILLER}live` });
    store.claimNextTurn("worker_seed");
    store.stopSession(sessionId);
  }
  return root;
}

const root = seed();
const store = new EngineStore(root, Date.now, { executionStorage: "sqlite" });
const bytes = fs.statSync(path.join(root, "execution.sqlite")).size;

// One beat is exactly what `execution.workerHeartbeat` asks the store for.
const beat = (workerId: string): void => {
  store.cancellationsForWorker(workerId);
  store.resolutionsForWorker(workerId);
  store.steerForWorker(workerId);
};
beat("worker_warm");
const beats = 50;
const started = performance.now();
for (let n = 0; n < beats; n += 1) beat("worker_warm");
const perBeat = (performance.now() - started) / beats;

console.log(`seeded ${sessions} sessions (${liveIndex} in the live index, ${turnsEach} turns each) — ${(bytes / 1e6).toFixed(1)} MB sqlite`);
// Ten beats a second, so the millisecond cost of one beat IS the percentage of
// a core the heartbeat alone spends.
console.log(`heartbeat: ${perBeat.toFixed(2)} ms per beat → ${perBeat.toFixed(1)}% of a core at 10 beats/s`);

const echo: TurnDriver = { run: async ({ prompt }) => ({ text: `echo:${prompt}` }) };
const daemon = await startEngine({ engineRoot: root, embeddedWorker: { createDriver: () => echo, pollMs: 100 } });
// Nothing is submitted: this window is the engine doing nothing at all.
const before = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));
const spent = process.cpuUsage(before);
const cpu = (spent.user + spent.system) / 1_000 / IDLE_WINDOW_MS;
console.log(`idle: ${(cpu * 100).toFixed(1)}% of a core over ${IDLE_WINDOW_MS / 1000}s, RSS ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB`);

await daemon.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
