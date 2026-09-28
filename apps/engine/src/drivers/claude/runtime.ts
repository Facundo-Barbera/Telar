type FeedMessage = {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: null;
  uuid?: string;
  origin?: { kind: string; [field: string]: unknown };
};

export class MessageFeed {
  private queue: FeedMessage[] = [];
  private ended = false;
  private wakers: Array<() => void> = [];

  push(message: FeedMessage): boolean {
    if (this.ended) return false;
    this.queue.push(message);
    const waiting = this.wakers;
    this.wakers = [];
    for (const wake of waiting) wake();
    return true;
  }

  end(): void {
    this.ended = true;
    const waiting = this.wakers;
    this.wakers = [];
    for (const wake of waiting) wake();
  }

  async *stream(): AsyncGenerator<FeedMessage> {
    for (;;) {
      while (this.queue.length === 0) {
        if (this.ended) return;
        await new Promise<void>((resolve) => this.wakers.push(resolve));
      }
      yield this.queue.shift()!;
    }
  }
}

export type RuntimeQuery = AsyncIterable<unknown> & {
  interrupt?(): Promise<unknown>;
  stopTask?(taskId: string): Promise<void>;
  close?(): void;
  setModel?(model?: string): Promise<void>;
};

export type RuntimeBindings<T> = { current: T };

type TaskMemory<Seed extends { id: string; providerTaskId?: string }> = {
  readonly bySdkId: Map<string, string>;
  readonly known: Map<string, Seed>;
  readonly suppressed: Set<string>;
  readonly typesBySdkId: Map<string, string>;
  lastWokenTaskId: string | undefined;
};

export function taskMemoryFrom<Seed extends { id: string; providerTaskId?: string }>(seeds: Iterable<Seed>): TaskMemory<Seed> {
  const memory: TaskMemory<Seed> = { bySdkId: new Map(), known: new Map(), suppressed: new Set(), typesBySdkId: new Map(), lastWokenTaskId: undefined };
  for (const seed of seeds) {
    memory.known.set(seed.id, seed);
    if (seed.providerTaskId) memory.bySdkId.set(seed.providerTaskId, seed.id);
  }
  return memory;
}

export type ClaudeSessionRuntime<T = unknown, Seed extends { id: string; providerTaskId?: string } = { id: string; providerTaskId?: string }> = {
  readonly sessionId: string;
  readonly fingerprint: string;
  readonly fingerprintDigests: Record<string, string>;
  readonly feed: MessageFeed;
  readonly query: RuntimeQuery;
  readonly iterator: AsyncIterator<unknown>;
  readonly bindings: RuntimeBindings<T>;
  readonly tasks: TaskMemory<Seed>;
  pendingStep: Promise<IteratorResult<unknown>> | undefined;
  readonly parked: unknown[];
  idlePump: { stop: () => void } | undefined;
  streamEnded: boolean;
  readonly destroy: () => void;
  model: string | undefined;
  costTotalUsd: number | undefined;
  echoesUserMessageUuid: boolean;
  reportsSessionState: boolean;
  busy: boolean;
  wakeActive: boolean;
  lastUsedAt: number;
};

const MAX_IDLE_RUNTIMES = 3;

const STOP_REAP_GRACE_MS = 3_000;

export const UNATTENDED_BACKGROUND_WORK_MS = 30 * 60_000;

type UnattendedStop = {
  sessionId: string;
  taskId: string;
  providerTaskId: string | undefined;
  idleForMs: number;
  stopped: boolean;
};

export class ClaudeRuntimeStore<T = unknown, Seed extends { id: string; providerTaskId?: string } = { id: string; providerTaskId?: string }> {
  private readonly runtimes = new Map<string, ClaudeSessionRuntime<T, Seed>>();
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  private readonly liveBackgroundWork: (seed: Seed) => boolean;
  private readonly now: () => number;
  private readonly unattendedAfterMs: number;
  private readonly onUnattended: ((stops: readonly UnattendedStop[]) => void) | undefined;
  private unattendedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    options: {
      liveBackgroundWork?: (seed: Seed) => boolean;
      now?: () => number;
      unattendedAfterMs?: number;
      onUnattended?: (stops: readonly UnattendedStop[]) => void;
    } = {},
  ) {
    this.liveBackgroundWork = options.liveBackgroundWork ?? (() => false);
    this.now = options.now ?? Date.now;
    this.unattendedAfterMs = options.unattendedAfterMs ?? Infinity;
    this.onUnattended = options.onUnattended;
  }

  private liveWorkIn(runtime: ClaudeSessionRuntime<T, Seed>): Seed[] {
    return [...runtime.tasks.known.values()].filter((seed) => this.liveBackgroundWork(seed));
  }

  private armUnattendedSweep(): void {
    if (this.unattendedTimer) clearTimeout(this.unattendedTimer);
    this.unattendedTimer = undefined;
    if (!Number.isFinite(this.unattendedAfterMs)) return;
    let earliest: number | undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.busy || runtime.wakeActive) continue;
      if (this.liveWorkIn(runtime).length === 0) continue;
      const due = runtime.lastUsedAt + this.unattendedAfterMs;
      if (earliest === undefined || due < earliest) earliest = due;
    }
    if (earliest === undefined) return;
    const timer = setTimeout(() => void this.sweepUnattended(), Math.max(0, earliest - this.now()));
    timer.unref?.();
    this.unattendedTimer = timer;
  }

  async sweepUnattended(): Promise<UnattendedStop[]> {
    const stopped: UnattendedStop[] = [];
    const at = this.now();
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.busy || runtime.wakeActive) continue;
      const idleForMs = at - runtime.lastUsedAt;
      if (idleForMs < this.unattendedAfterMs) continue;
      const live = this.liveWorkIn(runtime);
      if (live.length === 0) continue;
      for (const seed of live) {
        const took = seed.providerTaskId === undefined ? false : await this.stopTask(runtime.sessionId, seed.providerTaskId);
        stopped.push({ sessionId: runtime.sessionId, taskId: seed.id, providerTaskId: seed.providerTaskId, idleForMs, stopped: took });
      }
      this.destroy(runtime.sessionId);
    }
    if (stopped.length > 0) this.onUnattended?.(stopped);
    this.armUnattendedSweep();
    return stopped;
  }

  private evictable(runtime: ClaudeSessionRuntime<T, Seed>): boolean {
    if (runtime.busy || runtime.wakeActive) return false;
    for (const seed of runtime.tasks.known.values()) if (this.liveBackgroundWork(seed)) return false;
    return true;
  }

  private prune(): void {
    const evictable = [...this.runtimes.values()].filter((candidate) => this.evictable(candidate)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const evicted of evictable.slice(0, Math.max(0, evictable.length - MAX_IDLE_RUNTIMES))) {
      this.destroy(evicted.sessionId);
    }
  }

  async idle(sessionId: string): Promise<void> {
    for (;;) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime || !runtime.busy) return;
      await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(sessionId) ?? [];
        waiters.push(resolve);
        this.idleWaiters.set(sessionId, waiters);
      });
    }
  }

  private wakeIdle(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters) return;
    this.idleWaiters.delete(sessionId);
    for (const wake of waiters) wake();
  }

  peek(sessionId: string): ClaudeSessionRuntime<T, Seed> | undefined {
    return this.runtimes.get(sessionId);
  }

  claim(sessionId: string, fingerprint: string): ClaudeSessionRuntime<T, Seed> | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return undefined;
    if (runtime.fingerprint !== fingerprint) {
      this.destroy(sessionId);
      return undefined;
    }
    runtime.idlePump?.stop();
    runtime.idlePump = undefined;
    runtime.busy = true;
    runtime.wakeActive = false;
    runtime.lastUsedAt = this.now();
    this.armUnattendedSweep();
    return runtime;
  }

  static async takeStep(runtime: { iterator: AsyncIterator<unknown>; pendingStep: Promise<IteratorResult<unknown>> | undefined }): Promise<IteratorResult<unknown>> {
    const step = runtime.pendingStep ?? runtime.iterator.next();
    runtime.pendingStep = step;
    const result = await step;
    if (runtime.pendingStep === step) runtime.pendingStep = undefined;
    return result;
  }

  adopt(runtime: ClaudeSessionRuntime<T, Seed>): void {
    this.destroy(runtime.sessionId);
    runtime.busy = true;
    runtime.lastUsedAt = this.now();
    this.runtimes.set(runtime.sessionId, runtime);
    this.prune();
    this.armUnattendedSweep();
  }

  async stopTask(sessionId: string, providerTaskId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || typeof runtime.query.stopTask !== "function") return false;
    await runtime.query.stopTask(providerTaskId);
    return true;
  }

  release(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.busy = false;
    runtime.lastUsedAt = this.now();
    this.wakeIdle(sessionId);
    this.prune();
    this.armUnattendedSweep();
  }

  setWakeActive(sessionId: string, active: boolean): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.wakeActive = active;
    runtime.lastUsedAt = this.now();
    if (!active) this.prune();
    this.armUnattendedSweep();
  }

  reapAfter(sessionId: string, graceMs: number = STOP_REAP_GRACE_MS): () => void {
    const timer = setTimeout(() => this.destroy(sessionId), graceMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  }

  destroy(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    this.wakeIdle(sessionId);
    runtime.idlePump?.stop();
    runtime.idlePump = undefined;
    runtime.feed.end();
    try {
      runtime.destroy();
    } catch {
    }
    this.armUnattendedSweep();
  }

  destroyAll(): void {
    for (const sessionId of this.runtimes.keys()) this.destroy(sessionId);
    if (this.unattendedTimer) clearTimeout(this.unattendedTimer);
    this.unattendedTimer = undefined;
  }

  get size(): number {
    return this.runtimes.size;
  }
}
