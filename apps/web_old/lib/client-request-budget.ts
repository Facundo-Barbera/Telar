"use client";

export type IdleRequestBudgetSnapshot = {
  queued: number;
  inFlight: number;
  granted: number;
  deferred: number;
  maxPerWindow: number;
  windowMs: number;
};

type IdleTask = {
  generation: number;
  run: () => void | Promise<void>;
};

type Scheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

const DEFAULT_MAX_PER_WINDOW = 8;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * A fair, process-wide gate for recovery polling. Interactive requests and
 * event-driven refreshes do not pass through this queue; only safety polling
 * that may run while the user is doing nothing belongs here.
 *
 * Re-enqueuing the same key replaces its callback without moving it to the end
 * of the queue. That keeps a frequently ticking observer from starving quieter
 * observers, while one in-flight key can never overlap itself.
 */
export class IdleRequestCoordinator {
  private readonly queue = new Map<string, IdleTask>();
  private readonly inFlight = new Set<string>();
  private readonly starts: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private granted = 0;
  private deferred = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly maxPerWindow = DEFAULT_MAX_PER_WINDOW,
    private readonly windowMs = DEFAULT_WINDOW_MS,
  ) {}

  enqueue(key: string, run: () => void | Promise<void>) {
    const generation = ++this.generation;
    const existing = this.queue.get(key);
    this.queue.set(key, { generation, run });
    if (!existing && this.availableSlots() === 0) this.deferred += 1;
    this.schedule(0);
    return () => {
      if (this.queue.get(key)?.generation === generation) this.queue.delete(key);
      this.reschedule();
    };
  }

  cancel(key: string) {
    this.queue.delete(key);
    this.reschedule();
  }

  snapshot(): IdleRequestBudgetSnapshot {
    this.prune();
    return {
      queued: this.queue.size,
      inFlight: this.inFlight.size,
      granted: this.granted,
      deferred: this.deferred,
      maxPerWindow: this.maxPerWindow,
      windowMs: this.windowMs,
    };
  }

  private prune() {
    const cutoff = this.scheduler.now() - this.windowMs;
    while (this.starts.length > 0 && this.starts[0] <= cutoff) this.starts.shift();
  }

  private availableSlots() {
    this.prune();
    return Math.max(0, this.maxPerWindow - this.starts.length);
  }

  private schedule(delayMs: number) {
    if (this.timer || this.queue.size === 0) return;
    this.timer = this.scheduler.setTimer(() => {
      this.timer = null;
      this.drain();
    }, Math.max(0, delayMs));
  }

  private reschedule() {
    if (this.timer) {
      this.scheduler.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.queue.size === 0) return;
    this.prune();
    const delay = this.availableSlots() > 0
      ? 0
      : Math.max(1, this.starts[0] + this.windowMs - this.scheduler.now());
    this.schedule(delay);
  }

  private drain() {
    let slots = this.availableSlots();
    for (const [key, task] of this.queue) {
      if (slots <= 0) break;
      if (this.inFlight.has(key)) continue;
      this.queue.delete(key);
      this.inFlight.add(key);
      this.starts.push(this.scheduler.now());
      this.granted += 1;
      slots -= 1;
      void Promise.resolve()
        .then(task.run)
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(key);
          this.reschedule();
        });
    }
    const hasRunnableQueuedTask = [...this.queue.keys()].some(
      (key) => !this.inFlight.has(key),
    );
    if (hasRunnableQueuedTask) {
      this.deferred += this.queue.size;
      this.reschedule();
    }
  }
}

const idleRequests = new IdleRequestCoordinator({
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
});

export function enqueueIdleRequest(key: string, run: () => void | Promise<void>) {
  return idleRequests.enqueue(key, run);
}

export function cancelIdleRequest(key: string) {
  idleRequests.cancel(key);
}

export function getIdleRequestBudgetDiagnostics() {
  return idleRequests.snapshot();
}
