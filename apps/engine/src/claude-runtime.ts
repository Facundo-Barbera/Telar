/**
 * THE SESSION-SCOPED CLAUDE RUNTIME — the process model behind "background
 * work survives the turn".
 *
 * WHY THIS EXISTS, measured on this very app: the driver used to create one
 * SDK query per TURN, and the query's input generator returned the moment a
 * turn finished unsteered. The SDK reads a closed input stream as "the session
 * is over", tears the CLI process down, and every descendant dies with it —
 * backgrounded shells, monitors, in-flight sub-agents. Steering had the same
 * root: there was no live input stream left to inject into, so "send now"
 * silently degraded into a queued turn. T3 Code (the reference this app
 * borrows its shape from) never had either problem because its query lives
 * per SESSION and only `stopSessionInternal` closes it.
 *
 * So: ONE LIVE QUERY PER SESSION, held here between turns. A turn pushes its
 * prompt into the open feed, pumps the shared output iterator until its own
 * result message, and then simply stops pumping — the stream stays open, the
 * process stays alive, and whatever the agent left running keeps running.
 * Conversation continuity is the process's own; `resume` is demoted from
 * "every turn" to "cold start only".
 */

/** One user message in the SDK's streaming-input shape. Structurally the
 *  driver's `SdkUserMessage`; declared open here so this module needs no
 *  import from the driver (the driver imports from HERE). */
export type FeedMessage = {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: null;
};

/**
 * The runtime's input stream: an open mailbox the prompt generator reads
 * for the life of the SESSION.
 *
 * EDGE CASES ARE THE POINT. `stream()` parks between turns — that parked
 * `await` is precisely what keeps the CLI's stdin open, which is what keeps
 * the process alive. `end()` is the only way the generator returns, and it is
 * called exactly once, by the store, when the runtime is destroyed.
 */
export class MessageFeed {
  private queue: FeedMessage[] = [];
  private ended = false;
  private wakers: Array<() => void> = [];

  /** False after `end()` — the caller must treat the runtime as dead. */
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

/**
 * What the SDK's live Query object can do beyond iteration — spelled
 * structurally because the driver's `ClaudeSdk` type deliberately narrows the
 * SDK to `AsyncIterable<unknown>`, and the FAKE SDKs the tests inject
 * implement none of these. Every use is optional-chained for the same reason.
 */
export type RuntimeQuery = AsyncIterable<unknown> & {
  /** Ends the CURRENT turn; the process and the stream survive. */
  interrupt?(): Promise<unknown>;
  /** Ends the process. stdin closes, then SIGTERM escalating to SIGKILL. */
  close?(): void;
  setModel?(model?: string): Promise<void>;
};

/**
 * The per-turn half of the runtime, swapped whole at the top of every turn.
 *
 * The query is created ONCE with stable wrappers (`(...a) => bindings.current.x(...a)`)
 * because `canUseTool`, the Telar MCP tools and the warp spawn all close over
 * per-turn state — the worker's request gate is bound to a claim token that
 * dies with the turn. The wrapper is what lets a session-lived process talk to
 * a turn-lived gate.
 */
export type RuntimeBindings<T> = { current: T };

export type ClaudeSessionRuntime<T = unknown> = {
  readonly sessionId: string;
  /** Everything about the query that cannot change without a new process.
   *  A mismatch on lookup destroys and recreates — never patches. */
  readonly fingerprint: string;
  readonly feed: MessageFeed;
  readonly query: RuntimeQuery;
  /**
   * THE ONE ITERATOR, advanced with explicit `.next()` — never `for await`.
   * Breaking out of a `for await` loop calls `.return()` on the generator,
   * which is the SDK's cue to shut the process down: the exact teardown this
   * module exists to avoid.
   */
  readonly iterator: AsyncIterator<unknown>;
  readonly bindings: RuntimeBindings<T>;
  /** Kills the process outright. Idempotent; used by eviction and dispose. */
  readonly destroy: () => void;
  /** The model `setModel` last confirmed, so a turn can skip the round trip. */
  model: string | undefined;
  /** A turn is pumping right now — never evict. */
  busy: boolean;
  lastUsedAt: number;
};

/**
 * At most this many IDLE runtimes live at once. Each is a real `claude`
 * process (hundreds of MB); a user hopping between many sessions must not
 * accumulate one per session forever. Busy runtimes are never counted against
 * the cap and never evicted.
 */
const MAX_IDLE_RUNTIMES = 3;

/**
 * The store: sessionId → live runtime, owned by one driver instance.
 *
 * NO TIMERS. Eviction happens lazily on `adopt()` (oldest-idle beyond the
 * cap) and eagerly on `destroyAll()`. A timer here would keep the worker
 * process — and every test that touches the driver — alive for its tick.
 */
export class ClaudeRuntimeStore<T = unknown> {
  private readonly runtimes = new Map<string, ClaudeSessionRuntime<T>>();

  /** The live runtime for this session — IF its fingerprint still matches.
   *  A mismatch means the turn's config changed (env, cwd, mcp, effort…):
   *  the old process is destroyed here and the caller cold-starts a new one. */
  claim(sessionId: string, fingerprint: string): ClaudeSessionRuntime<T> | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return undefined;
    if (runtime.fingerprint !== fingerprint) {
      this.destroy(sessionId);
      return undefined;
    }
    runtime.busy = true;
    runtime.lastUsedAt = Date.now();
    return runtime;
  }

  /** Register a freshly created runtime, evicting the oldest idle ones beyond
   *  the cap. The newcomer arrives busy — it is about to run a turn. */
  adopt(runtime: ClaudeSessionRuntime<T>): void {
    this.destroy(runtime.sessionId);
    runtime.busy = true;
    runtime.lastUsedAt = Date.now();
    this.runtimes.set(runtime.sessionId, runtime);
    const idle = [...this.runtimes.values()].filter((candidate) => !candidate.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const evicted of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_RUNTIMES))) {
      this.destroy(evicted.sessionId);
    }
  }

  /** The turn is over; the runtime lingers, eligible for eviction. */
  release(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.busy = false;
    runtime.lastUsedAt = Date.now();
  }

  destroy(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    runtime.feed.end();
    try {
      runtime.destroy();
    } catch {
      // A process that is already gone is the outcome destroy wanted.
    }
  }

  destroyAll(): void {
    for (const sessionId of [...this.runtimes.keys()]) this.destroy(sessionId);
  }

  get size(): number {
    return this.runtimes.size;
  }
}
