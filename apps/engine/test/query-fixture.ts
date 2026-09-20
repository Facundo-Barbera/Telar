/**
 * THE 300-SESSION / 60,000-EVENT FIXTURE, AND THE CONTROL IT IS MEASURED
 * AGAINST — issue #516's acceptance.
 *
 * ══ WHY THIS FIXTURE IS A REAL STORE AND #515'S IS A FAKE ══
 *
 * `tool-budgets.test.ts` builds 500 sessions over a FAKE capability and its
 * header argues why: what that file asserts is how much a wall SAYS, and a fake
 * answers that question exactly as well as a real engine while cutting 500
 * worktrees does not.
 *
 * THIS FILE ASKS A DIFFERENT QUESTION AND SO NEEDS A DIFFERENT ANSWER. The
 * claim here is that `turnOutline` does not fold events at request time — a
 * claim about the STORE and the PROJECTION, not about the wall above them. A
 * fake capability cannot prove it, because a fake has no journal to fold: it
 * would answer in constant time no matter how the engine underneath were
 * written, and the test would pass on an engine that folded 60,000 events per
 * call. So the fixture here is seeded through the engine's own public path —
 * submit, claim, run, ingest, complete — and the measurements are taken against
 * sqlite.
 *
 * The byte half is measured here too, on the same fixture, for the same reason
 * it is worth having at all: the issue asks for the size of each answer "on an
 * engine with 300 sessions and a 60,000-event journal", and a number taken from
 * a three-session store is a number about a three-session store.
 *
 * ══ WHY THERE IS A FOLD CONTROL AT ALL ══
 *
 * "Before/after latency" cannot mean a remembered number or an old commit —
 * neither can be re-run, and neither says anything about the machine the
 * comparison is read on. So the "before" is built here instead: `foldOutline`
 * answers the SAME question as `turnOutline` by walking the journal at request
 * time, which is the thing the projection exists to replace. Both are measured
 * on the same fixture in the same process, at two journal sizes.
 *
 * WHAT PROVES THE POINT IS THE SHAPE, NOT THE MILLISECONDS. The projection's
 * cost must not move as the journal grows while the fold's does. A ratio
 * survives a loaded CI runner; a threshold in milliseconds is an assertion
 * about how busy the machine is, which is not a property of `turnOutline`.
 *
 * Shared by `query-acceptance.test.ts` (the guard) and `bench/outline.ts` (the
 * numbers), deliberately: a bench that priced a different fixture from the one
 * the test guards would let the two drift apart, and the PR's table would stop
 * describing the thing CI checks.
 */
import type { EngineEvent, Item, Turn } from "@telar/engine-client";
import type { EngineStore } from "../src/state";
import { outlineRow, summariseTurn, type OutlineRow } from "../src/turn-summary";

/** The issue's own numbers. `session_0` carries the 60,000-event journal and is
 *  also the session with the most turns — "the largest session", which is what
 *  the latency clause is about. */
export const SESSIONS = 300;
export const BIG_JOURNAL = 60_000;

/**
 * THE CONTROL'S JOURNAL, ONE ORDER OF MAGNITUDE DOWN.
 *
 * Ten times is the smallest gap that makes the two shapes unmistakable: a
 * reader whose cost tracks the journal is ~10× slower on the big one, and one
 * that does not is ~1×, so no amount of runner noise puts a flat reader above
 * `TRACKS_JOURNAL` or a folding one below it.
 */
export const SMALL_JOURNAL = 6_000;
export const JOURNAL_GROWTH = BIG_JOURNAL / SMALL_JOURNAL;

/** How many turns the two measured sessions carry. Identical on both, so the
 *  journal length is the ONLY variable between them — which is what makes the
 *  comparison a controlled one rather than two unrelated readings. */
export const MEASURED_TURNS = 30;

/** The answer every measured turn leaves. Long enough that an outline page is
 *  stopped by `OUTLINE_PAGE_BYTES` rather than by its row limit, which is the
 *  worst case the byte table should be reporting. */
export const ANSWER_CHARS = 4_000;

export const BIG_SESSION = "session_0";
/**
 * THE CONTROL SESSION IS A 301ST, not one of the 300. It exists only to be the
 * short-journal end of the comparison and it is named so that nothing reading
 * the fixture mistakes it for part of the engine the byte table describes.
 */
export const CONTROL_SESSION = "session_journal_control";

export const PROJECT = "project_query_fixture";

/** One completed turn through the public path. A hand-written queue would price
 *  a store no engine ever wrote — `turn-summary.test.ts` makes the same call. */
function conversation(store: EngineStore, sessionId: string, runId: string, input: string, answer: string, items: number): void {
  store.submitTurn(sessionId, { runId, input });
  const token = store.claimTurn(sessionId, "worker_fixture")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  for (let step = 0; step < items; step += 1) {
    const id = `${runId}_item_${step}`;
    store.ingestObservations(sessionId, runId, token, [
      { kind: "item.started", item: { id, title: `Read apps/engine/src/some/path/number-${step}.ts`, detail: { type: "assistant_message", text: "" } } },
      { kind: "item.completed", itemId: id, status: "completed", detail: { type: "assistant_message", text: `Paragraph ${step}. ${"Words a real item carries. ".repeat(10)}` } },
    ]);
  }
  store.completeTurn(sessionId, runId, token, { text: answer });
}

/**
 * A JOURNAL OF `events` ROWS, BUILT THE ONLY WAY AN ENGINE EVER BUILDS ONE.
 *
 * Streamed deltas, which is what the dogfood store's largest session (61,977
 * events) is mostly made of. Appended in batches because the cost being set up
 * is the READ, and a per-event transaction would spend the fixture's time in
 * the write path instead.
 */
function journal(store: EngineStore, sessionId: string, runId: string, events: number): void {
  store.submitTurn(sessionId, { runId, input: "the long one, streamed" });
  const token = store.claimTurn(sessionId, "worker_fixture")!.claim!.token;
  store.markRunning(sessionId, runId, token);
  store.ingestObservations(sessionId, runId, token, [
    { kind: "item.started", item: { id: `${runId}_item`, title: "The streamed reply", detail: { type: "assistant_message", text: "" } } },
  ]);
  const batch = 1_000;
  for (let sent = 0; sent < events; sent += batch) {
    store.ingestObservations(sessionId, runId, token, Array.from({ length: Math.min(batch, events - sent) }, () => ({
      kind: "content.delta" as const, itemId: `${runId}_item`, stream: "assistant_text" as const, text: "tok ",
    })));
  }
  store.ingestObservations(sessionId, runId, token, [
    { kind: "item.completed", itemId: `${runId}_item`, status: "completed", detail: { type: "assistant_message", text: "the streamed reply, settled" } },
  ]);
  store.completeTurn(sessionId, runId, token, { text: answerOf("the streamed answer.") });
}

/** An answer of EXACTLY `ANSWER_CHARS`, so `/answer`'s `totalChars` is a number
 *  the byte table can be read against rather than an accident of the prose. */
function answerOf(opening: string): string {
  return `${opening} ${"z".repeat(ANSWER_CHARS)}`.slice(0, ANSWER_CHARS);
}

/**
 * SEED THE ENGINE THE ISSUE DESCRIBES.
 *
 * 300 sessions with an ordinary turn each — enough that `find` has something to
 * choose between and the byte table is a number about a real engine — plus
 * `session_0` carrying 30 fat turns and the 60,000-event journal, plus the
 * control beside it at 6,000.
 */
export function seedQueryFixture(store: EngineStore): void {
  store.registerProject({ id: PROJECT, name: "Query fixture", root: "/tmp" });
  for (let index = 0; index < SESSIONS; index += 1) {
    store.createSession({ id: `session_${index}`, projectId: PROJECT });
  }
  store.createSession({ id: CONTROL_SESSION, projectId: PROJECT });

  // Every session gets one ordinary turn, so `find` scans a real corpus rather
  // than one session's worth of text wearing 300 ids.
  for (let index = 1; index < SESSIONS; index += 1) {
    conversation(store, `session_${index}`, "run_1", `message ${index} about the rail and the appearance rework`, `answer ${index}`, 2);
  }

  seedMeasuredSession(store, BIG_SESSION, BIG_JOURNAL);
  seedMeasuredSession(store, CONTROL_SESSION, SMALL_JOURNAL);
}

/**
 * ONE SESSION AT THE MEASURED SHAPE: `MEASURED_TURNS` turns and a journal of
 * `events` rows.
 *
 * THE TURNS DO NOT DEPEND ON `events`, which is what makes two of these a
 * controlled pair: the outline has identical work to do on both, so any
 * difference between the two readings is the journal and nothing else. The
 * bench sweeps several journal sizes through this; the fixture above uses it
 * twice, at the two the test compares.
 */
export function seedMeasuredSession(store: EngineStore, sessionId: string, events: number): void {
  for (let index = 0; index < MEASURED_TURNS; index += 1) {
    conversation(
      store,
      sessionId,
      `run_${index}`,
      `turn ${index}: the rail, the appearance rework, and what it concluded`,
      answerOf(`Conclusion ${index}, which mentions index.lock.`),
      4,
    );
  }
  journal(store, sessionId, "run_journal", events);
}

/**
 * THE CONTROL: the outline's answer, folded from the journal at request time.
 *
 * This is deliberately NOT a slow re-implementation invented to lose — it is
 * what answering the question without a projection costs. The turn documents
 * and the items are both reconstructed by replaying events, which is the only
 * thing a caller holding a journal and no index can do, and then handed to the
 * engine's OWN `summariseTurn`/`outlineRow` so that the two paths differ in
 * where the inputs came from and in nothing else.
 *
 * `summariseTurn` is given every item rather than this run's, because selecting
 * this run's is exactly the index the fold does not have.
 */
export function foldOutline(events: EngineEvent[], limit: number): OutlineRow[] {
  const turns = new Map<string, Turn>();
  const items = new Map<string, Item>();
  for (const event of events) {
    const carried = event as unknown as { type: string; runId?: string; at: number; turn?: Turn; item?: Item; resultText?: string };
    if (carried.type === "turn.accepted" && carried.turn) turns.set(carried.turn.runId, { ...carried.turn });
    else if (carried.type === "item.started" || carried.type === "item.completed") {
      if (carried.item) items.set(carried.item.id, carried.item);
    } else if (carried.type === "turn.completed" && carried.runId) {
      const turn = turns.get(carried.runId);
      if (turn) turns.set(carried.runId, { ...turn, state: "completed", resultText: carried.resultText ?? "", completedAt: carried.at } as Turn);
    }
  }
  const ordered = [...turns.values()].sort((a, b) => a.sequence - b.sequence);
  const all = [...items.values()];
  return ordered.slice(-limit).reverse().map((turn) => outlineRow(summariseTurn(turn, all)));
}

/**
 * ══ THE INSTRUMENT ══
 *
 * MEDIAN OF `runs`, AFTER A WARM-UP. A single reading on a shared machine is a
 * coin toss, and a mean is decided by whichever sample landed on a GC pause;
 * the median of five is the cheapest number that is about the code.
 */
export function measure(work: () => unknown, runs = 5): number {
  work();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const at = Bun.nanoseconds();
    work();
    samples.push((Bun.nanoseconds() - at) / 1e6);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

/** One reader, priced at both journal sizes. */
export type Shape = { smallMs: number; bigMs: number };

export const ratio = (shape: Shape): number => shape.bigMs / Math.max(shape.smallMs, 1e-6);

/**
 * THE VERDICT, AS ONE PREDICATE USED IN BOTH DIRECTIONS.
 *
 * The journal grows 10× between the two readings. A reader that folds it grows
 * with it; a reader that does not stays put. `3` sits an order of magnitude
 * clear of both — a flat reader measured at 1.4× is nowhere near it, and a fold
 * measured at 9× is nowhere near it from the other side — so the gap absorbs
 * runner noise without the threshold having to be tuned.
 *
 * IT IS A PREDICATE RATHER THAN AN INLINE `expect` SO THAT THE TEST CAN RUN IT
 * AGAINST A READER THAT IS KNOWN TO FOLD and show it returning `false`. A check
 * only ever exercised in its passing direction is a check nobody has seen fail,
 * which is the whole of `docs/operations/dispatch-board.md` §3.
 */
export const TRACKS_JOURNAL = 3;
export const isFlat = (shape: Shape): boolean => ratio(shape) < TRACKS_JOURNAL;

/**
 * FIXED WORK, NOT A FIXED DURATION — the clock check's load.
 *
 * A busy-wait that watched the clock would spin FOREVER on the frozen clock
 * this exists to catch: the failure mode would be a hang rather than a failing
 * assertion, and a hang is the one outcome that tells a reader nothing. A loop
 * of a fixed number of rounds terminates whatever the clock is doing, and the
 * assertion is then about what the clock SAID it took.
 */
export function rounds(count: number): number {
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += Math.sqrt(index) % 7;
  return sum;
}
