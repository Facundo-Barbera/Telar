/**
 * STEERING PRIMITIVES — how "send now" reaches a turn that is already running.
 *
 * A mailbox that text can be pushed into mid-turn, and a boundary the prompt
 * generator waits on. Imported by `worker.ts`, `driver.ts` and
 * `provider-contract.ts`: this is the ordinary session path, not a corner of
 * one, and `send` on every session goes through it.
 *
 * A FILE OF ITS OWN rather than a section of `driver.ts`, because the contract
 * imports it too and a contract that imported the driver would be the wrong way
 * round.
 */

import type { NotificationDetail, TurnAttachment, WakeReason } from "@telar/engine-client";

/**
 * A turn boundary the prompt generator can wait on.
 *
 * EDGE-TRIGGERED WITH A COUNTER, not a bare promise, and that is the whole
 * reason this is a class. A `result` message can arrive before the generator
 * gets around to awaiting the next boundary; a level-triggered signal would
 * miss it, the generator would park for ever, and the SDK would sit waiting
 * for an input that never comes — the same deadlock the mailbox was
 * introduced to kill, reintroduced one layer down.
 */
export class TurnBoundary {
  private settled = 0;
  private observed = 0;
  private closed = false;
  private waiters: Array<(open: boolean) => void> = [];

  /** A turn just ended. */
  mark(): void {
    this.settled += 1;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(true);
  }

  /** The output stream ended: no further boundary can ever arrive. */
  close(): void {
    this.closed = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(false);
  }

  /** Resolves `true` at the next (or an already-missed) boundary, `false` once
   *  the stream is closed. */
  next(): Promise<boolean> {
    if (this.settled > this.observed) {
      this.observed = this.settled;
      return Promise.resolve(true);
    }
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Text pushed into a running turn, waiting for the driver to take it.
 *
 * `wake` FIRES ON PUSH so a driver that can inject mid-turn (Codex's
 * `turn/steer`) hears about a message the moment it arrives, while a driver
 * that injects at turn boundaries (Claude's streaming-input prompt) simply
 * drains when its boundary comes and never registers a waker. Closed with the
 * turn; a push after close is dropped, because the engine's sweep will requeue
 * the undelivered message as its own turn — losing it silently is the one
 * failure this whole channel exists to prevent.
 */
/** One steered message: the words, and the files the human attached to them.
 *  The engine wrote the files and owns the paths, exactly as for a queued
 *  turn's attachments. */
export type SteerMessage = {
  text: string;
  /** The engine's short announcement of an agent's message — what the PROVIDER
   *  reads in place of `text`, while `text` remains the body the transcript row
   *  expands to. Set only alongside `sender`. See `Turn.agentNotice`. */
  notice?: string;
  attachments?: TurnAttachment[];
  /** Present when an AGENT sent it — the driver frames the words as a peer's
   *  and the transcript row says so. Absent means the person typed it. */
  sender?: { sessionId?: string };
  /** Present when the ENGINE wrote it — a wake about a subscribed session.
   *  Framed as the engine's own notice and drawn as a wake row, not a bubble.
   *  Never set together with `sender`. */
  wakeReason?: WakeReason;
  /** What this delivery IS, when nobody typed it — a peer's message, a wake, a
   *  parked request. Present on every agent-sent and engine-written delivery;
   *  absent means a person typed the words. The driver reads it to pick a
   *  channel that is not the user's. See `NotificationDetail`. */
  notification?: NotificationDetail;
};

export class SteerMailbox {
  private queue: SteerMessage[] = [];
  private closed = false;
  private wakers: Array<() => void> = [];

  /** True when the message was accepted; false after close, when the engine's
   *  requeue sweep is the delivery path instead. A bare string is the
   *  text-only form the tests still use. */
  push(message: string | SteerMessage): boolean {
    if (this.closed) return false;
    this.queue.push(typeof message === "string" ? { text: message } : message);
    const waiting = this.wakers;
    this.wakers = [];
    for (const wake of waiting) wake();
    return true;
  }

  /** Everything queued right now, removed. Non-blocking, never throws. */
  drain(): SteerMessage[] {
    const queued = this.queue;
    this.queue = [];
    // Fired AFTER the take: a listener acking delivery must only hear about
    // text the consumer actually holds.
    if (queued.length > 0) for (const listener of this.drainListeners) listener();
    return queued;
  }

  /** Hear every non-empty drain. The worker acks send-now deliveries here —
   *  a drained message is one the driver holds, which is the earliest moment
   *  "delivered" is true rather than hoped. */
  onDrain(listener: () => void): void {
    this.drainListeners.push(listener);
  }
  private drainListeners: Array<() => void> = [];

  get pending(): number {
    return this.queue.length;
  }

  /** True once the turn is over — how a consumer loop knows an empty drain
   *  after a wake means "stop", not "spin". */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Resolves on the next push, or immediately when something is already
   *  waiting or the mailbox has closed. */
  wake(): Promise<void> {
    if (this.queue.length > 0 || this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => this.wakers.push(resolve));
  }

  close(): void {
    this.closed = true;
    const waiting = this.wakers;
    this.wakers = [];
    for (const wake of waiting) wake();
  }
}
