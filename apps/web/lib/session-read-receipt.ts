/**
 * WHEN A RESULT COUNTS AS READ — the decision, with no React in it.
 *
 * The engine records that a human was shown an answer (`markSessionRead`), and
 * the inbox refuses to shelve a session whose newest answer nobody has read
 * (`lib/session-settling.ts`). That only works if the client is HONEST about
 * what "shown" means, and the ways to be dishonest are all easy:
 *
 *   - MARKING ON HYDRATE. A tab that opens a session in the background — a
 *     restored window, a preloaded route — has rendered nothing to anybody.
 *   - MARKING ON POLL. The cockpit tails the journal every second or so. A
 *     receipt on the sync loop would mark every open session read forever,
 *     including the one on a laptop that has been shut since Tuesday.
 *   - MARKING WHILE HIDDEN. A background tab and a foreground one differ by
 *     one boolean, and the background one has a person in front of something
 *     else entirely.
 *   - MARKING WHAT IS NOT ON SCREEN. A reader scrolled up to re-read an old
 *     answer has not seen the new one at the bottom.
 *
 * So the gate is all four at once, held for a beat, and the receipt names the
 * turn that was actually rendered — never "now". `receiptToSend` is that rule
 * as one pure function, which is what lets it be tested without a browser.
 */
import type { TurnState } from "@telar/engine-client";

/** The three fields the rule reads off a turn. Not `Turn`, so a test can build
 *  one in a line and the cockpit can pass its own rows unchanged. */
export type ResultTurn = { runId: string; state: TurnState; sequence: number };

/**
 * The states that leave AN ANSWER — the same set the engine will accept a
 * receipt for (`isResultTurn` in `apps/engine/src/state.ts`), spelled here so
 * the client never sends a turn the engine must refuse.
 *
 * `steering`/`steered` are the human's own words on their way into a running
 * turn and are not drawn as turns at all; `discarded` is a dismissed recovery;
 * `ambiguous` is a question for a human, not a result.
 */
export function isResultTurn(turn: { state: TurnState }): boolean {
  return turn.state === "completed" || turn.state === "failed" || turn.state === "stopped";
}

/**
 * The turn a receipt would name: the newest answer in the transcript.
 *
 * BY SEQUENCE, not by array position or by a timestamp — the engine's unread
 * comparison is on sequence, so choosing any other way is how a client ends up
 * confirming a turn that leaves the session still unread.
 */
export function newestResultTurn(turns: readonly ResultTurn[]): ResultTurn | undefined {
  let newest: ResultTurn | undefined;
  for (const turn of turns) {
    if (!isResultTurn(turn)) continue;
    if (newest === undefined || turn.sequence > newest.sequence) newest = turn;
  }
  return newest;
}

/** Every condition that must hold at once for a render to count as "seen". */
export type ReceiptGate = {
  /** The document is visible AND its window has focus. Two facts, because a
   *  visible-but-unfocused window is a window somebody is not looking at. */
  foreground: boolean;
  /** The end of the newest answer is inside the viewport right now. */
  atLatestResult: boolean;
  /** A hydrate is still in flight, so what is on screen may not be this
   *  session's, or may not be current. Nothing is confirmed mid-load. */
  loading: boolean;
};

/**
 * Which turn to confirm, if any.
 *
 * `confirmedSequence` is what this client has already sent or is sending, and
 * it is deliberately separate from `readSequence` (what the engine last told
 * us): the answer from a receipt takes a round trip to come back, and without
 * the local high-water mark a visible answer would be reported once per render
 * until it did.
 */
export function receiptToSend(input: {
  candidate?: ResultTurn;
  /** `Session.lastReadTurnSequence` — the engine's own high-water mark. */
  readSequence?: number;
  /** The highest sequence this client has already sent. */
  confirmedSequence?: number;
  gate: ReceiptGate;
}): ResultTurn | undefined {
  const { candidate, gate } = input;
  if (!candidate || gate.loading || !gate.foreground || !gate.atLatestResult) return undefined;
  const known = Math.max(input.readSequence ?? 0, input.confirmedSequence ?? 0);
  return candidate.sequence > known ? candidate : undefined;
}

/**
 * How long the gate must hold before a receipt is sent.
 *
 * A SCROLL PAST IS NOT A READ, and neither is a tab that flashes into focus on
 * the way to another one. Short enough that nobody notices, long enough that
 * the answer was actually on screen.
 */
export const RECEIPT_SETTLE_MS = 700;

/**
 * Retry, but not forever: a receipt is worth almost nothing on its own, and a
 * client that keeps trying to send one at an engine that is down is a client
 * hammering a socket for a nicety. Three attempts, then wait for the next time
 * the reader looks at the answer.
 */
export const RECEIPT_MAX_ATTEMPTS = 3;

/** Backoff for attempt `n` (1-based), in ms. */
export function receiptRetryDelayMs(attempt: number): number {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}
