/**
 * WHAT THE COCKPIT SPENDS ON ITS TRANSCRIPT, PER TICK (#407).
 *
 * The cockpit tails once a second and re-folds whatever it is holding whenever
 * any of `turns`, `items`, `events` or `tasks` changes identity. This prices
 * the three ticks that actually happen, at the shape the dogfood store reports
 * (`docs/investigations/performance-2026-09-12.md`: a 10-turn window carrying
 * ~327 items):
 *
 *   quiet      nothing arrived. Before the fix this was a full re-fold once a
 *              second, per open conversation, forever.
 *   streaming  one delta on the newest turn — everything above it settled.
 *   snapshot   a companion snapshot landed; every row is a fresh object.
 *
 * Run: `bun run --cwd apps/web bench:journal [turns] [itemsPerTurn] [reps]`
 *
 * IT MEASURES THE FOLD, NOT THE APP. There is no React here and no network —
 * this is the CPU a tick costs before anything renders, which is the part this
 * change can move. The navigation numbers in the issue need a running app and
 * are measured with `lib/perf-marks.ts` instead.
 */
import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { createJournalProjector, projectJournal } from "../lib/engine/journal";

const TURNS = Number(process.argv[2] ?? 10);
const ITEMS_PER_TURN = Number(process.argv[3] ?? 33);
const REPS = Number(process.argv[4] ?? 200);

const SESSION = "session_bench";
/** Roughly the size of a real tool result or a paragraph of reply. */
const BODY = "x".repeat(2_000);

function build(): { turns: Turn[]; items: Item[]; tasks: Task[]; events: EngineEvent[] } {
  const turns: Turn[] = [];
  const items: Item[] = [];
  for (let index = 0; index < TURNS; index += 1) {
    const runId = `run_${index}`;
    const live = index === TURNS - 1;
    turns.push({
      runId,
      sessionId: SESSION,
      sequence: index + 1,
      input: `message ${index}`,
      state: live ? "running" : "completed",
      acceptedAt: index,
      updatedAt: index,
      ...(live ? {} : { resultText: BODY.slice(0, 400) }),
    } as Turn);
    for (let step = 0; step < ITEMS_PER_TURN; step += 1) {
      items.push({
        id: `${runId}_item_${step}`,
        runId,
        sessionId: SESSION,
        status: live && step === ITEMS_PER_TURN - 1 ? "inProgress" : "completed",
        startedAt: index * 100 + step,
        completedAt: index * 100 + step,
        detail:
          step % 3 === 0
            ? { type: "assistant_message", text: BODY }
            : { type: "command_execution", command: { command: "bun test", outputPreview: BODY } },
      } as Item);
    }
  }
  return { turns, items, tasks: [], events: [] };
}

const delta = (id: number, runId: string, itemId: string): EngineEvent =>
  ({ id, at: id, sessionId: SESSION, runId, type: "content.delta", itemId, stream: "assistant_text", text: "tok " }) as EngineEvent;

/**
 * EVERY ROW IS MEASURED TWICE, ALTERNATING, and both passes are printed.
 *
 * This machine is shared with other agents, and a single sweep of six rows
 * gives the last one a different machine from the first — on one run the same
 * row varied fivefold between invocations. Two alternating passes do not remove
 * the noise, but they make it visible: a ratio that survives both passes is the
 * change, and one that does not is the load.
 */
const rows: { label: string; run: (index: number) => void }[] = [];
const record = (label: string, run: (index: number) => void) => rows.push({ label, run });

function sweep(reps: number): number[] {
  return rows.map(({ run }) => {
    run(0); // untimed, so JIT warmup is not charged to the first row
    const started = performance.now();
    for (let index = 0; index < reps; index += 1) run(index);
    return (performance.now() - started) / reps;
  });
}

const { turns, items, tasks } = build();
const liveRun = `run_${TURNS - 1}`;
const liveItem = `${liveRun}_item_${ITEMS_PER_TURN - 1}`;

console.log(`${TURNS} turns × ${ITEMS_PER_TURN} items = ${items.length} items, ${REPS} ticks each\n`);

/**
 * THE ARRAYS ARE BUILT OUTSIDE THE CLOCK. A quiet tick hands the fold a new
 * ARRAY of the same rows, and copying 330 references costs about as much as the
 * fold does — charging it to both sides would bury the thing being compared.
 */
const quietCopies = Array.from({ length: REPS + 1 }, () => ({ turns: [...turns], items: [...items], tasks: [...tasks] }));
/** A turn streaming: the tail GROWS, and both sides re-read all of it — that is
 *  what the cockpit's `events` state does between two snapshots. */
const tails: EngineEvent[][] = [];
const growing: EngineEvent[] = [];
for (let index = 0; index <= REPS; index += 1) {
  growing.push(delta(index + 1, liveRun, liveItem));
  tails.push([...growing]);
}
/** A companion snapshot: every row a fresh object, as `JSON.parse` hands them
 *  over. The cache must miss here; this is the price of the bookkeeping. */
const fresh = Array.from({ length: REPS + 1 }, () => ({
  turns: turns.map((turn) => ({ ...turn })),
  items: items.map((item) => ({ ...item })),
}));

const quiet = createJournalProjector();
quiet(turns, items, [], tasks);
const streaming = createJournalProjector();
streaming(turns, items, [], tasks);
const cold = createJournalProjector();

// The three ticks, each both ways, interleaved so a pass covers both builds.
record("quiet tick — whole fold", (index) => {
  const copy = quietCopies[index]!;
  projectJournal(copy.turns, copy.items, [], copy.tasks);
});
record("quiet tick — memoised", (index) => {
  const copy = quietCopies[index]!;
  quiet(copy.turns, copy.items, [], copy.tasks);
});
record("streaming tick — whole fold", (index) => {
  projectJournal(turns, items, tails[index]!, tasks);
});
record("streaming tick — memoised", (index) => {
  streaming(turns, items, tails[index]!, tasks);
});
record("fresh snapshot — whole fold", (index) => {
  projectJournal(fresh[index]!.turns, fresh[index]!.items, [], tasks);
});
record("fresh snapshot — memoised", (index) => {
  cold(fresh[index]!.turns, fresh[index]!.items, [], tasks);
});

const first = sweep(REPS);
const second = sweep(REPS);
for (const [index, row] of rows.entries()) {
  console.log(`${row.label.padEnd(30)} ${first[index]!.toFixed(3)} / ${second[index]!.toFixed(3)} ms/tick`);
}
