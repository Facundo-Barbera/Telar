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

/* ------------------------------------------------------------------ *
 * The courier — the LIFECYCLE, which is where the real hazards are.
 * ------------------------------------------------------------------ */

/**
 * WHOSE SESSION THIS IS. Both halves, always.
 *
 * A session id is unique per ENGINE, not per cockpit: two paired Macs can mint
 * the same one, and this window can be looking at either. Everything below is
 * keyed on the pair, so a receipt raised on one Mac's session can never be
 * applied to another Mac's session that happens to share its id.
 */
export type ReceiptIdentity = { sessionId: string; hostId: string };

export function sameIdentity(left: ReceiptIdentity | undefined, right: ReceiptIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.sessionId === right.sessionId && left.hostId === right.hostId;
}

/** What the engine answers a receipt with — only the fields unread reads. */
export type ReceiptAnswer = { lastReadTurnSequence?: number; readAt?: number };

type Timer = unknown;

/** Is anybody looking at the newest answer right now? The two gate facts that
 *  are about the READER, as opposed to `loading`, which is about the data. */
function opened(gate: ReceiptGate | undefined): boolean {
  return Boolean(gate?.foreground && gate.atLatestResult);
}

export type ReceiptCourierPorts = {
  send: (identity: ReceiptIdentity, runId: string) => Promise<ReceiptAnswer>;
  /** Called ONLY for a receipt that is still about the current identity. */
  onRead: (identity: ReceiptIdentity, answer: ReceiptAnswer) => void;
  setTimer: (run: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
};

export type ReceiptWorld = {
  identity?: ReceiptIdentity;
  candidate?: ResultTurn;
  /** `Session.lastReadTurnSequence` as this client last heard it. */
  readSequence?: number;
  gate: ReceiptGate;
};

/**
 * THE PART A PURE FUNCTION CANNOT HOLD: what is in flight, for whom.
 *
 * `receiptToSend` answers "should this render confirm anything". Everything
 * that goes wrong after that is about TIME — a request outliving the thing it
 * was about — and each of these was a real defect in the first cut of this:
 *
 *   - A RECEIPT OUTLIVING ITS SESSION. The cockpit switches sessions without
 *     remounting, so a request raised on A can resolve while B is on screen.
 *     Its callbacks used to mutate the shared bookkeeping — B's high-water
 *     mark, B's attempt budget — and hand B's cockpit A's answer. Every
 *     request now carries the generation it was raised in, and a generation
 *     that is no longer current is dropped on the floor: no state, no
 *     callback.
 *   - A RECEIPT OUTLIVING ITS HOST. Same session id on a different Mac is a
 *     DIFFERENT session, so the generation is keyed on the pair.
 *   - AN OLD FAILURE UNDOING A NEW SUCCESS. The first cut restored the
 *     high-water mark from a value captured before the request, so a slow
 *     failure for turn 5 landing after a fast success for turn 6 dragged the
 *     mark back to 5 and re-sent a receipt for an answer already confirmed.
 *     The mark only ever moves FORWARD now: a success raises it, and a failure
 *     merely stops counting its own attempt as in flight.
 *
 * Framework-free on purpose — the hook is a twenty-line adapter over this, and
 * this is what the tests drive with deferred promises. There is no DOM test
 * runner in this app, and a lifecycle this fiddly is not something to verify by
 * reading it.
 */
export class ReadReceiptCourier {
  /** Bumped whenever the identity changes. Anything raised under an older one
   *  is stale by definition. */
  private generation = 0;
  private identity: ReceiptIdentity | undefined;
  /** The highest sequence the ENGINE has confirmed to this courier. Monotonic
   *  within a generation, and reset with it. */
  private confirmed = 0;
  /** Sequences currently being sent, by run id — counted as "already claimed"
   *  so a re-render does not send a second copy, and removed on either
   *  outcome so a failure does not claim one forever. */
  private inFlight = new Map<string, number>();
  private attempts = new Map<string, number>();
  private timer: Timer | undefined;
  private world: ReceiptWorld | undefined;
  private disposed = false;

  constructor(private readonly ports: ReceiptCourierPorts) {}

  /** Re-evaluate against the current world. Called from an effect. */
  update(world: ReceiptWorld): void {
    if (this.disposed) return;
    if (!sameIdentity(this.identity, world.identity)) this.resetTo(world.identity);
    // THE READER LOOKING AGAIN IS A FRESH START. The attempt budget exists to
    // stop a retry loop against an engine that is down, not to give up on the
    // session for good — so a gate that closes and re-opens (they scrolled
    // back to the answer, or came back to the window) hands the budget back.
    if (opened(world.gate) && !opened(this.world?.gate)) this.attempts.clear();
    this.world = world;
    this.evaluate();
  }

  /** Stop everything. A courier is never reused after this. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
  }

  /** The high-water mark `receiptToSend` is given — what is confirmed, plus
   *  what is on its way. */
  private claimed(): number {
    let claimed = this.confirmed;
    for (const sequence of this.inFlight.values()) claimed = Math.max(claimed, sequence);
    return claimed;
  }

  private resetTo(identity: ReceiptIdentity | undefined): void {
    this.generation += 1;
    this.identity = identity;
    this.confirmed = 0;
    this.inFlight.clear();
    this.attempts.clear();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.ports.clearTimer(this.timer);
    this.timer = undefined;
  }

  private evaluate(): void {
    const world = this.world;
    const identity = this.identity;
    // A pending send is cancelled on EVERY re-evaluation and re-armed below if
    // it still applies. That is what makes the settle window a DWELL: scrolling
    // away, or losing focus, before it elapses sends nothing.
    this.clearTimer();
    if (!world || !identity || this.disposed) return;
    const pending = receiptToSend({
      ...(world.candidate ? { candidate: world.candidate } : {}),
      ...(world.readSequence === undefined ? {} : { readSequence: world.readSequence }),
      confirmedSequence: this.claimed(),
      gate: world.gate,
    });
    if (!pending) return;
    const spent = this.attempts.get(pending.runId) ?? 0;
    if (spent >= RECEIPT_MAX_ATTEMPTS) return;
    const generation = this.generation;
    const delay = spent === 0 ? RECEIPT_SETTLE_MS : receiptRetryDelayMs(spent);
    this.timer = this.ports.setTimer(() => {
      this.timer = undefined;
      if (generation !== this.generation) return;
      this.attempts.set(pending.runId, spent + 1);
      this.inFlight.set(pending.runId, pending.sequence);
      this.ports.send(identity, pending.runId).then(
        (answer) => {
          // STALE MEANS GONE. Not "apply carefully" — the session this was
          // about is not the session on screen.
          if (generation !== this.generation) return;
          this.inFlight.delete(pending.runId);
          this.confirmed = Math.max(this.confirmed, pending.sequence);
          this.attempts.delete(pending.runId);
          this.ports.onRead(identity, answer);
          this.evaluate();
        },
        () => {
          if (generation !== this.generation) return;
          // Only the claim is released. `confirmed` is never lowered, so a
          // slow failure cannot undo a fast success for a later turn.
          this.inFlight.delete(pending.runId);
          this.evaluate();
        },
      );
    }, delay);
  }
}
