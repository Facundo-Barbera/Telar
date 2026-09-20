/**
 * WHERE A TURN TRANSITION'S MILLISECONDS ACTUALLY GO — issue #547, step 1.
 *
 *   bun run --cwd apps/engine bench:queue-write          # 10, 100 and 400 deep
 *   bun run --cwd apps/engine bench:queue-write 400      # one depth
 *   bun run --cwd apps/engine bench:queue-write 10 1200  # depth, answer bytes
 *
 * #547's investigation measured the TOTALS: one turn is four transitions, about
 * 5.6 ms at depth 10 and 49 ms at depth 400, against 1.15 ms for the rail's
 * whole read of the same session. It could account for roughly 2.1 ms of the
 * 12 ms a depth-400 transition costs and named the rest as candidates. This
 * bench is the instrument that settles which of them it is, and it prints
 * numbers rather than asserting any: a threshold here would be a CI failure
 * about somebody else's laptop.
 *
 * SELF TIME, NOT INCLUSIVE TIME. The interesting methods nest — `storeSessionRow`
 * calls `readQueue`, `readQueue` calls `readDocument` — so a table of inclusive
 * totals would attribute the same millisecond three times and every row would
 * look load-bearing. The frames below subtract their children, so the column
 * sums to the transition and the largest row IS the place to look.
 *
 * RUN IT AT BOTH DEPTHS, which is the falsification the investigation asked for.
 * The claim is that the cost is proportional to what the conversation already
 * holds; if the same rows dominate by the same shares at depth 10 and depth 400,
 * the cost is a constant per transition and #547's reading of it is wrong. The
 * `× vs depth 10` column is there to be read for exactly that.
 *
 * THE FIXTURE IS BUILT IN A TEMP DIR, never a real store, and is removed on the
 * way out. SQLite, because that is what every install runs (`main.ts`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const [firstArg, answerBytes = 1_200] = process.argv.slice(2).map(Number);
const DEPTHS = Number.isFinite(firstArg) && firstArg > 0 ? [firstArg] : [10, 100, 400];
/** The investigation's fixture shape: a uniform ~1.2 KB answer per turn. */
const ANSWER = "x".repeat(Math.max(1, answerBytes));
/** Medians, not means: one GC pause should not become the headline. */
const SAMPLES = 9;

/**
 * THE METHODS WORTH NAMING, and nothing else — an exhaustive wrap would be a
 * profiler, and a profiler's output is what this exists to replace with six
 * rows somebody can read. `readDocument` is in the list so that `readQueue`'s
 * own self time is exactly the parse and the zod walk above the fetch.
 */
const WATCHED = [
  "readQueue",
  "readDocument",
  "writeIndexedDocument",
  "writeDocument",
  "storeSessionRow",
  "withActivityFrom",
  "reconcileTurnSummaries",
  "knownTurnStates",
  "readRequests",
  "liveRequests",
  "readTasks",
  "trimResolvedRequests",
  "closeOrphanedTasks",
  "touchSession",
  "appendEvent",
  "noteSessionRevision",
  "bumpRevisionFor",
] as const;

type Frame = { self: number; calls: number };
const frames = new Map<string, Frame>();
let armed = false;
/** Time charged to the frames BELOW the one currently running. */
let childTime = 0;

/**
 * Wrap once, globally, and gate on `armed` — re-wrapping per sample would stack
 * seventeen closures deep by the end and the wrappers would be the measurement.
 */
const missing: string[] = [];
{
  const proto = EngineStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of WATCHED) {
    const real = proto[name];
    if (typeof real !== "function") { missing.push(name); continue; }
    proto[name] = function wrapped(this: unknown, ...args: unknown[]): unknown {
      if (!armed) return real.apply(this, args);
      const outerChildren = childTime;
      childTime = 0;
      const started = performance.now();
      try {
        return real.apply(this, args);
      } finally {
        const inclusive = performance.now() - started;
        const frame = frames.get(name) ?? { self: 0, calls: 0 };
        frame.self += inclusive - childTime;
        frame.calls += 1;
        frames.set(name, frame);
        childTime = outerChildren + inclusive;
      }
    };
  }
}
// LOUD, NOT SILENT. A renamed private method would otherwise drop out of the
// table and read as "this path got cheap".
if (missing.length > 0) {
  console.log(`WARNING: not on EngineStore.prototype, so unmeasured: ${missing.join(", ")}\n`);
}

function measure<T>(action: () => T): T {
  armed = true;
  childTime = 0;
  try { return action(); } finally { armed = false; }
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

type Fixture = { store: EngineStore; root: string; worker: string };

/** A session `depth` turns deep, seeded through the public path. */
function seeded(depth: number): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-queue-write-bench-"));
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  let clock = 1_000;
  const store = new EngineStore(root, () => (clock += 1), { executionStorage: "sqlite" });
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  const worker = "worker_bench";
  for (let n = 0; n < depth; n += 1) {
    const runId = `run_seed_${n}`;
    store.submitTurn("session_one", { runId, input: `message ${n}` });
    const token = store.claimTurn("session_one", worker)!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.completeTurn("session_one", runId, token, { text: ANSWER });
  }
  return { store, root, worker };
}

/** One whole turn through the store, each transition timed on its own. */
function turn(fixture: Fixture, runId: string): Record<string, number> {
  const { store, worker } = fixture;
  const at: Record<string, number> = {};
  let started = performance.now();
  store.submitTurn("session_one", { runId, input: "and again" });
  at.submitTurn = performance.now() - started;

  started = performance.now();
  const token = store.claimTurn("session_one", worker)!.claim!.token;
  at.claimTurn = performance.now() - started;

  started = performance.now();
  store.markRunning("session_one", runId, token);
  at.markRunning = performance.now() - started;

  started = performance.now();
  store.completeTurn("session_one", runId, token, { text: ANSWER });
  at.completeTurn = performance.now() - started;
  return at;
}

const TRANSITIONS = ["submitTurn", "claimTurn", "markRunning", "completeTurn"] as const;

type Reading = {
  depth: number;
  perTransition: Record<string, number>;
  titleWrite: number;
  liveRead: number;
  queueBytes: number;
  self: Array<{ name: string; ms: number; calls: number }>;
  turnTotal: number;
};

function readingAt(depth: number): Reading {
  const fixture = seeded(depth);
  const samples: Array<Record<string, number>> = [];
  const titles: number[] = [];
  const lives: number[] = [];
  frames.clear();

  for (let sample = 0; sample < SAMPLES; sample += 1) {
    samples.push(measure(() => turn(fixture, `run_timed_${sample}`)));

    // THE TWO REFERENCE ROWS the investigation quotes beside the transitions: a
    // write that cannot have moved the activity, and the rail's whole read.
    let started = performance.now();
    fixture.store.updateSession("session_one", { title: `Title ${sample}` });
    titles.push(performance.now() - started);

    started = performance.now();
    fixture.store.liveSessionRows({ all: true });
    lives.push(performance.now() - started);
  }

  const perTransition: Record<string, number> = {};
  for (const name of TRANSITIONS) perTransition[name] = median(samples.map((sample) => sample[name]!));

  // The queue as it stands at the end, which is the document every transition
  // above had to fetch, parse and rewrite.
  const queueBytes = Buffer.byteLength(
    JSON.stringify(fixture.store.turns("session_one")),
    "utf8",
  );

  const self = [...frames.entries()]
    .map(([name, frame]) => ({ name, ms: frame.self / SAMPLES, calls: frame.calls / SAMPLES }))
    .sort((a, b) => b.ms - a.ms);

  fixture.store.closeExecutionStore();
  fs.rmSync(fixture.root, { recursive: true, force: true });

  return {
    depth,
    perTransition,
    titleWrite: median(titles),
    liveRead: median(lives),
    queueBytes,
    self,
    turnTotal: TRANSITIONS.reduce((sum, name) => sum + perTransition[name]!, 0),
  };
}

const readings = DEPTHS.map(readingAt);
const shallowest = readings[0]!;

console.log(`one turn = four transitions, ${ANSWER.length}-byte answers, median of ${SAMPLES}\n`);

console.log(
  `${"depth".padStart(6)} ${"queue".padStart(9)} ` +
    TRANSITIONS.map((name) => name.padStart(13)).join("") +
    `${"one turn".padStart(11)}${"title-only".padStart(12)}${"liveRows".padStart(10)}`,
);
for (const reading of readings) {
  console.log(
    `${String(reading.depth).padStart(6)} ${`${(reading.queueBytes / 1e3).toFixed(0)} KB`.padStart(9)} ` +
      TRANSITIONS.map((name) => reading.perTransition[name]!.toFixed(2).padStart(13)).join("") +
      `${reading.turnTotal.toFixed(2).padStart(11)}${reading.titleWrite.toFixed(2).padStart(12)}${reading.liveRead.toFixed(2).padStart(10)}`,
  );
}
console.log("\n(ms)\n");

for (const reading of readings) {
  const accounted = reading.self.reduce((sum, row) => sum + row.ms, 0);
  console.log(`── depth ${reading.depth}: self time per turn, largest first ${"─".repeat(28)}`);
  console.log(`${"".padEnd(24)}${"ms/turn".padStart(9)}${"% of turn".padStart(11)}${"calls".padStart(8)}${`× vs depth ${shallowest.depth}`.padStart(16)}`);
  let running = 0;
  for (const row of reading.self) {
    if (row.ms < 0.005) continue;
    running += row.ms;
    const shallow = shallowest.self.find((other) => other.name === row.name)?.ms ?? 0;
    const growth = shallow > 0.005 ? `${(row.ms / shallow).toFixed(1)}×` : "—";
    console.log(
      `${row.name.padEnd(24)}${row.ms.toFixed(3).padStart(9)}${((row.ms / reading.turnTotal) * 100).toFixed(1).padStart(10)}%` +
        `${row.calls.toFixed(0).padStart(8)}${growth.padStart(16)}`,
    );
  }
  // WHAT THE TABLE DOES NOT EXPLAIN, said out loud. Free functions
  // (`arrayElementRanges`, `planWindow`), sqlite's own transaction and
  // everything between the wrapped frames land here, and a large number in this
  // line means the next question is not in the rows above it.
  console.log(
    `${"(unattributed)".padEnd(24)}${(reading.turnTotal - accounted).toFixed(3).padStart(9)}` +
      `${(((reading.turnTotal - accounted) / reading.turnTotal) * 100).toFixed(1).padStart(10)}%`,
  );
  console.log(`${"named above ≥80%?".padEnd(24)}${running >= reading.turnTotal * 0.8 ? "yes" : "no"}\n`);
}

process.exit(0);
