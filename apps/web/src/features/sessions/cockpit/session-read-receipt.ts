import type { TurnState } from "@telar/engine-client";

/** The three fields the rule reads off a turn. Not `Turn`, so a test can build
 *  one in a line and the cockpit can pass its own rows unchanged. */
export type ResultTurn = { runId: string; state: TurnState; sequence: number };

export function isResultTurn(turn: { state: TurnState }): boolean {
  return turn.state === "completed" || turn.state === "failed" || turn.state === "stopped";
}

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
  /** The document is visible and its window has focus. Two facts, because a
   *  visible-but-unfocused window is a window somebody is not looking at. */
  foreground: boolean;
  /** The end of the newest answer is inside the viewport right now. */
  atLatestResult: boolean;
  /** A hydrate is still in flight, so what is on screen may not be this
   *  session's, or may not be current. Nothing is confirmed mid-load. */
  loading: boolean;
};

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

const RECEIPT_SETTLE_MS = 700;

export const RECEIPT_MAX_ATTEMPTS = 3;

/** Backoff for attempt `n` (1-based), in ms. */
export function receiptRetryDelayMs(attempt: number): number {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export type ReceiptIdentity = { sessionId: string; hostId: string };

function sameIdentity(left: ReceiptIdentity | undefined, right: ReceiptIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.sessionId === right.sessionId && left.hostId === right.hostId;
}

/** What the engine answers a receipt with — only the fields unread reads. */
export type ReceiptAnswer = { lastReadTurnSequence?: number; readAt?: number };

type Timer = unknown;

/** Is anybody looking at the newest answer right now? The two gate facts that
 *  are about the reader, as opposed to `loading`, which is about the data. */
function opened(gate: ReceiptGate | undefined): boolean {
  return Boolean(gate?.foreground && gate.atLatestResult);
}

export type ReceiptCourierPorts = {
  send: (identity: ReceiptIdentity, runId: string) => Promise<ReceiptAnswer>;
  /** Called only for a receipt that is still about the current identity. */
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

export class ReadReceiptCourier {
  /** Bumped whenever the identity changes. Anything raised under an older one
   *  is stale by definition. */
  private generation = 0;
  private identity: ReceiptIdentity | undefined;
  /** The highest sequence the engine has confirmed to this courier. Monotonic
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
    // A pending send is cancelled on every re-evaluation and re-armed below if
    // it still applies. That is what makes the settle window a dwell: scrolling
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
