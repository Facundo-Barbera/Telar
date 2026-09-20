/**
 * WHAT `outline` COSTS, AGAINST THE FOLD IT REPLACED — issue #516.
 *
 * "Before/after latency of `outline` on the largest session" cannot mean a
 * remembered number or a reading from an old commit: neither can be re-run, and
 * neither says anything about the machine the comparison is read on. So the
 * "before" is BUILT HERE and measured in the same process as the "after" —
 * `foldOutline` answers the same question by walking the journal at request
 * time, which is precisely what the projection exists to replace.
 *
 * ── WHY A SWEEP AND NOT TWO NUMBERS ────────────────────────────────────────
 * `query-acceptance.test.ts` asserts the comparison at two journal sizes,
 * because a test wants the cheapest reading that can fail. A bench is read by a
 * person deciding whether to believe it, and a person is better served by the
 * SHAPE of the two curves than by either endpoint: a flat line beside one that
 * rises with the journal is an argument, where two milliseconds are a claim.
 *
 * ── WHAT WOULD MAKE THIS LIE ───────────────────────────────────────────────
 * A frozen clock, which has happened in this repository: six performance tests
 * passed while measuring zero. So the last column is the fold's absolute cost,
 * and the run refuses to print a table in which it is not above a millisecond —
 * folding 60,000 events cannot be free, and a zero there is the instrument
 * speaking rather than the code. The same check is a test in
 * `query-acceptance.test.ts`, which is where CI reads it.
 *
 * The fixture is the test's own (`test/query-fixture.ts`), deliberately: a
 * bench that priced a different fixture would let the PR's table and the thing
 * CI guards drift apart.
 *
 * Run: `bun run --cwd apps/engine bench:outline [events...]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import {
  MEASURED_TURNS,
  PROJECT,
  foldOutline,
  measure,
  seedMeasuredSession,
} from "../test/query-fixture";

/** The journal sizes to price, smallest first. The default sweep brackets the
 *  dogfood store's largest session (61,977 events). */
const SIZES = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [6_000, 20_000, 60_000];
const OUTLINE_LIMIT = 20;
/** Folding this many events cannot take under a millisecond. Below it, the
 *  clock is what is being measured. */
const FOLD_FLOOR_MS = 1;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-outline-bench-"));
fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
const store = new EngineStore(home, () => Date.now(), { executionStorage: "sqlite" });
store.registerProject({ id: PROJECT, name: "Outline bench", root: "/tmp" });

const rows: Array<{ events: number; outlineMs: number; foldMs: number }> = [];
for (const events of SIZES) {
  const sessionId = `session_journal_${events}`;
  store.createSession({ id: sessionId, projectId: PROJECT });
  seedMeasuredSession(store, sessionId, events);
  rows.push({
    events,
    outlineMs: measure(() => store.turnOutline(sessionId, { limit: OUTLINE_LIMIT })),
    foldMs: measure(() => foldOutline(store.readEvents(sessionId, 0), OUTLINE_LIMIT)),
  });
}

store.closeExecutionStore();
fs.rmSync(home, { recursive: true, force: true });

const base = rows[0]!;
console.log(`\noutline vs the fold it replaced — ${MEASURED_TURNS} turns on every row, limit ${OUTLINE_LIMIT}\n`);
console.log("  events    projection    ×base      fold     ×base");
for (const row of rows) {
  console.log(
    `  ${String(row.events).padStart(6)}  ${row.outlineMs.toFixed(3).padStart(9)} ms  ${(row.outlineMs / base.outlineMs).toFixed(2).padStart(5)}×  ` +
      `${row.foldMs.toFixed(2).padStart(7)} ms  ${(row.foldMs / base.foldMs).toFixed(2).padStart(5)}×`,
  );
}

/**
 * THE INSTRUMENT'S OWN CHECK, BEFORE THE TABLE IS BELIEVED. A fold measured at
 * zero means the clock did not move, and every ratio above is then 0/0 wearing
 * the look of a result.
 */
const slowest = rows.at(-1)!;
if (!(slowest.foldMs > FOLD_FLOOR_MS)) {
  console.error(
    `\nREFUSING TO REPORT: the widest fold in this sweep (${slowest.events} events) measured ${slowest.foldMs.toFixed(3)} ms, which is under the ` +
      `${FOLD_FLOOR_MS} ms floor. Either the sweep is too small to price anything — pass larger sizes — or the clock is not moving, which is the ` +
      `failure this floor exists for. Ratios taken against a number this size are noise wearing the look of a result.\n`,
  );
  process.exit(1);
}
console.log(
  `\n  the projection is ${(slowest.outlineMs / base.outlineMs).toFixed(2)}× its own baseline across ${(slowest.events / base.events).toFixed(0)}× the journal; ` +
    `the fold is ${(slowest.foldMs / base.foldMs).toFixed(2)}×.\n`,
);
