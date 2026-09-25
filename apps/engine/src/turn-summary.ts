/**
 * WHAT A TURN WAS, IN A ROW AN ORCHESTRATOR CAN AFFORD TO READ — issue #516.
 *
 * The engine already keeps two projections beside the journal: `queue.json` for
 * the turns and `items.json` for the timeline. Both exist so that OPENING a
 * conversation does not mean replaying it. Neither helps an agent that wants to
 * ASK a conversation something — which turn mentioned the appearance rework,
 * what did the last one conclude, what did step twelve do — because answering
 * any of those still meant folding the whole history at request time. On the
 * dogfood store's largest session that fold is 38.6 MB of journal and 1.2 s, per
 * question, per caller.
 *
 * SO THE ANSWER IS STORED WHEN IT IS KNOWN, not derived when it is asked for.
 * A turn ends once; its first input line, its item count, the head of its answer
 * and how long that answer is are all settled at that instant and never change
 * again. Writing them then costs a fold nobody notices — the documents are
 * already in hand in the transaction that settled the turn — and turns every
 * later question into an indexed seek.
 *
 * ══ WHY THE BOUNDS ARE IN THE PROJECTION AND NOT AT THE ROUTE ══
 *
 * A 300-character answer head is not a display choice, it is the thing that
 * makes the row a fixed size. If the row held the whole answer, an outline of
 * twenty turns would be priced by the longest reply among them, and #515's whole
 * complaint — that a single tool answer can eat a model's context — would come
 * back one layer down. The full text is always one `/answer` slice away, and
 * that route states `totalChars` so a caller knows what it is choosing not to
 * read.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ══
 *
 * Usage, model, attachments, claims, requests. Every one of them is on the turn
 * already and none of them is something an orchestrator asks a conversation
 * ABOUT; carrying them would grow the one row this exists to keep small.
 *
 * ══ AND THE ONE THAT IS ON THE TABLE ANYWAY — issue #697 ══
 *
 * `turn_summaries` grew nullable `usage_*` columns that no `TurnSummary` here
 * carries, and the two facts are not in tension: the sentence above is about
 * the ROW an orchestrator reads, and those columns are never on it. They exist
 * because the journal's `usage.updated` rows are folded into one aggregate and
 * the sum has to be written down before the rows are deleted — the same split
 * the `sessions` table already makes between what it decides on and what goes
 * on the wire. `ExecutionStore.turnUsage` is the reader; `foldUsage` is the
 * writer; nothing in this file knows about either.
 */
import type { Item, Turn } from "@telar/engine-client";

/**
 * THE TWO WAYS `turnAnswer` MISSES, NAMED RATHER THAN TYPED OUT TWICE (#592).
 *
 * THEY STAY PLAIN STATEMENTS OF FACT, because the HTTP route serves the same
 * throw and "do not guess another runId" is advice to a language model, not to
 * a browser. `sessions-tools/query.ts`'s `sessions_answer` is where that half is
 * added, and it compares against THESE — matching a retyped string literal is
 * how a pairing like that quietly stops working the first time one side is
 * reworded.
 *
 * THEY LIVE HERE RATHER THAN IN `state.ts`, WHICH IS WHERE THEY ARE THROWN, for
 * one reason: this module has no runtime imports at all, and `state.ts` pulls in
 * the whole `EngineStore` — sqlite, git, the worktree machinery. The query wall
 * is bound inside the OUT-OF-PROCESS worker, which holds no store by design, so
 * reaching for these two strings there must not be what puts one in its process.
 * `state.ts` re-exports them, so every existing importer is untouched.
 */
export const TURN_ANSWER_NONE = "this session has no answered turn";
export const TURN_ANSWER_NO_SUCH_RUN = "turn does not exist";

/** The first input line, as the outline draws it. Long enough to tell two
 *  messages apart, short enough that twenty of them are a page. */
export const INPUT_LINE_CHARS = 120;

/** How much of the answer the row itself carries. The outline shows the first
 *  200 of it; `/answer` serves the rest by slice. */
export const ANSWER_HEAD_CHARS = 300;

/**
 * HOW MANY ITEM TITLES A ROW REMEMBERS, and how long each may be.
 *
 * A row has to answer "what did this turn DO" without the caller paying for the
 * run's items — and on the dogfood store a turn's items are 8 rows at the median
 * and 400 at the tail. Twelve is past the median and nowhere near the tail,
 * which is the right place for a fixed-size summary to stop: a caller that wants
 * the rest asks `/runs/:runId/items`, which is the route that exists for it.
 */
export const ITEM_TITLES = 12;
export const ITEM_TITLE_CHARS = 80;

/** A failure's sentence, not its stack. Same argument as the answer head. */
export const FAILURE_CHARS = 300;

/** How much of the journal line a `grep` hit shows around the match. Enough for
 *  the sentence the phrase is in; a caller that wants the event reads it. */
export const GREP_CONTEXT_CHARS = 200;

/** The quotation a `find` hit carries, so a chooser is not taking the engine's
 *  word for the match. */
export const WHY_CHARS = 200;

/**
 * HOW MANY MATCHING ROWS `find` WILL LOOK AT BEFORE IT ANSWERS.
 *
 * The filters — project, settled, since — are applied AFTER the match, because
 * they live on the session index and the match lives on the turn rows; so the
 * scan has to be wider than the answer or a narrow filter would come back empty
 * while matching rows sat just past the cap. Five hundred is roughly fifty
 * sessions' worth of hits at ten turns each, and it bounds the `LIKE` fallback,
 * which is the path that actually needs a bound.
 */
export const FIND_SCAN = 500;

/**
 * ONE TURN, AS THE INDEX HOLDS IT.
 *
 * `answerChars` IS THE WHOLE ANSWER'S LENGTH, not the head's — that is what
 * makes a caller able to decide whether to fetch it. A row whose two lengths
 * could not disagree would have nothing to say about what it left out.
 */
export type TurnSummary = {
  sessionId: string;
  runId: string;
  sequence: number;
  origin?: NonNullable<Turn["origin"]>;
  state: Turn["state"];
  startedAt?: number;
  endedAt?: number;
  /** The first line of what was asked, clamped to `INPUT_LINE_CHARS`. */
  input: string;
  itemCount: number;
  itemTitles: string[];
  /** The first `ANSWER_HEAD_CHARS` of `resultText`. */
  answerHead: string;
  answerChars: number;
  failure?: string;
};

/** The first line of `text`, clamped — with the ellipsis that says so. A caller
 *  must never have to guess whether a value was cut. */
export function firstLine(text: string, limit: number): string {
  const line = text.replace(/\r\n?/g, "\n").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** `text`'s opening, clamped across line breaks — what an answer head is. */
export function head(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * THE FOLD: one turn and the items filed under it, as a row.
 *
 * `items` IS ALREADY THIS RUN'S — the caller reads them by the items index's
 * own per-run span, so this never filters a whole conversation's timeline to
 * find three rows. It re-checks `runId` anyway, because that span is coalesced
 * and may carry a neighbour's rows (see `coalesceByKey`).
 *
 * ORDERED BY `startedAt`, so the twelve titles a row keeps are the turn's FIRST
 * twelve rather than whichever twelve the projection's map happened to yield.
 */
export function summariseTurn(turn: Turn, items: Item[]): TurnSummary {
  const mine = items.filter((item) => item.runId === turn.runId).sort((a, b) => a.startedAt - b.startedAt);
  const answer = turn.resultText ?? "";
  return {
    sessionId: turn.sessionId,
    runId: turn.runId,
    sequence: turn.sequence,
    ...(turn.origin === undefined ? {} : { origin: turn.origin }),
    state: turn.state,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(endedAt(turn) === undefined ? {} : { endedAt: endedAt(turn)! }),
    /**
     * A NOTIFICATION'S SUMMARY IS ITS LINE — issue #550 clause 4.
     *
     * `input` on such a turn is a machine label (`[notification: wake · …]`) or
     * a peer's whole message, and neither is what an outline page is for: an
     * orchestrator scanning twenty rows wants "Session session_a finished a
     * turn", which is exactly the line the notification already carries. Read
     * from the stored summary rather than re-derived, for the reason every other
     * one-liner here is: one author per sentence.
     */
    input: turn.notification ? firstLine(turn.notification.summary, INPUT_LINE_CHARS) : firstLine(turn.input.trim() ? turn.input : attachedLine(turn), INPUT_LINE_CHARS),
    itemCount: mine.length,
    itemTitles: mine.slice(0, ITEM_TITLES).map((item) => firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS)),
    answerHead: head(answer, ANSWER_HEAD_CHARS),
    answerChars: answer.length,
    ...(turn.failure === undefined ? {} : { failure: head(`${turn.failure.code}: ${turn.failure.message}`, FAILURE_CHARS) }),
  };
}

/**
 * WHAT THE OUTLINE PUTS ON THE WIRE — a strict narrowing of the stored row.
 *
 * TWO SHAPES, DELIBERATELY. The row REMEMBERS more than a page SHOWS: the
 * answer head is 300 characters so `find` has something to quote and the
 * transcript has a preview, and the item titles are kept because "what did this
 * turn do" is a question the row can answer without reading a run's items. A
 * page of twenty rows carrying both is 10.8 KB — measured — against the 6 KB
 * the issue budgets, and the budget is the thing that matters: an outline is
 * read repeatedly, by a model, beside the rest of its work.
 *
 * SO THE PAGE CARRIES THE EIGHT FIELDS #516 NAMES and the projection keeps the
 * rest for the callers that ask for one row at a time. `answer` is the first
 * LINE of the head rather than its first 200 characters, because an answer's
 * opening line is what identifies it and its second is usually a blank.
 */
export const OUTLINE_ANSWER_CHARS = 200;

/**
 * AND A PAGE IS BOUNDED BY BYTES AS WELL AS BY ROWS — the two-number bound.
 *
 * #516 asks for twenty rows AND for under 6 KB a page, and on worst-case data
 * those two cannot both hold: twenty rows of a 120-character input line and a
 * 200-character answer line is 8.4 KB before the keys. A count alone would put
 * the engine in the position of quietly serving 8 KB while claiming 6; a
 * character cap alone would make a page of one-line turns needlessly short.
 *
 * SO THE PAGE FILLS UNTIL EITHER BOUND IS REACHED and says `more` for whichever
 * stopped it — which is the bound `sessions_read` already carries (#515) and
 * means the same thing here. ONE ROW ALWAYS FITS: a turn whose own row exceeds
 * the budget must still be readable, or a conversation could hold a page nothing
 * can page past.
 */
export const OUTLINE_PAGE_BYTES = 6_000;

export type OutlineRow = {
  runId: string;
  sequence: number;
  origin?: NonNullable<Turn["origin"]>;
  state: Turn["state"];
  input: string;
  items: number;
  answer: string;
  /** The whole answer's length, so a caller can see what `/answer` would cost
   *  before it asks. One integer, and it is the reason a page is choosable. */
  answerChars: number;
  endedAt?: number;
  failure?: string;
};

/** As many of `rows` as fit inside both bounds — see `OUTLINE_PAGE_BYTES`. The
 *  first row always fits, whatever it weighs. */
export function boundedOutline(rows: OutlineRow[], limit: number): OutlineRow[] {
  const page: OutlineRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (page.length >= limit) break;
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes > OUTLINE_PAGE_BYTES && page.length > 0) break;
    page.push(row);
  }
  return page;
}

export function outlineRow(summary: TurnSummary): OutlineRow {
  return {
    runId: summary.runId,
    sequence: summary.sequence,
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    state: summary.state,
    input: summary.input,
    items: summary.itemCount,
    answer: firstLine(summary.answerHead, OUTLINE_ANSWER_CHARS),
    answerChars: summary.answerChars,
    ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
    ...(summary.failure === undefined ? {} : { failure: summary.failure }),
  };
}

/**
 * WHEN THE TURN STOPPED BEING THE ONE IN FLIGHT.
 *
 * `completedAt` is stamped by every terminal transition the engine has —
 * completion, failure, a stop, a discard — so it is the honest answer for all of
 * them. A turn still queued or running has none, and reporting `updatedAt`
 * instead would put a time on a row that has not ended and make "newest ended
 * first" mean something different for the tail of a live session.
 */
/** An image-only message's line names what was sent, so an outline row is
 *  never blank. */
function attachedLine(turn: Turn): string {
  const names = (turn.attachments ?? []).map((attachment) => attachment.name);
  return names.length > 0 ? `[${names.join(", ")}]` : "";
}

function endedAt(turn: Turn): number | undefined {
  return turn.completedAt;
}

/**
 * IS THIS TURN'S ROW SETTLED — i.e. can it still change?
 *
 * The reconcile that maintains the projection compares stored state against the
 * queue's, so a row is rewritten whenever the state moves. This is the other
 * half: a turn in a non-terminal state has a row that is still provisional (its
 * item count is whatever had happened by the last write), and a caller reading
 * the outline of a LIVE session should see that rather than a stale count
 * presented as final.
 */
export const TERMINAL_TURN_STATES: ReadonlySet<Turn["state"]> = new Set<Turn["state"]>([
  "completed",
  "failed",
  "stopped",
  "discarded",
  "steered",
  "ambiguous",
]);

/**
 * WHERE A PATTERN MATCHED, WITH ENOUGH AROUND IT TO READ — `grep`'s context.
 *
 * Centred on the match rather than starting at it: "where did it mention
 * index.lock" is a question about the sentence the phrase is in, and a window
 * that began at the hit would answer with the sentence AFTER it. Marked at both
 * ends when it was cut, for the same reason every other bound here is.
 */
export function context(text: string, at: number, width: number): string {
  const start = Math.max(0, at - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}
