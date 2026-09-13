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
  /**
   * THE JOIN KEY between a send and the reply it triggers. The CLI echoes it
   * as `user_message_uuid` on the turn's first stream frame and on its
   * `result` — and on NOTHING it starts by itself (a background task's
   * notification wakes the model for a turn of the CLI's own, whose result
   * carries `origin` instead). Without it the pump cannot tell its own turn's
   * end from a buffered stranger's.
   */
  uuid?: string;
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
  /** Ends the CURRENT turn; the process and the stream survive. With
   *  `perTaskStopAffordance`, this spares running background tasks. */
  interrupt?(): Promise<unknown>;
  /** Stops ONE background task by its provider id; the process survives and a
   *  `task_notification` with status 'stopped' follows. */
  stopTask?(taskId: string): Promise<void>;
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

/**
 * WHAT THIS PROCESS KNOWS ABOUT ITS TASKS, kept for the process's life.
 *
 * A task's identity is the `tool_use_id` of the call that launched it; the
 * SDK's own `task_id` is what every LATER frame about it carries — and a
 * `task_notification` for a shell that fires between turns arrives in a later
 * turn with the `task_id` alone. Kept per TURN (the first shape), that later
 * turn had never heard of the id and minted a second row, `task_<task_id>`,
 * with no title and the wrong kind: seven such ghosts in one measured session.
 * The process is what launched the task, so the process is what remembers it.
 *
 * Seeded on a cold start from the store's projection (`DriverRun.tasks`), so
 * a runtime rebuilt after a restart still knows the row a notification
 * belongs to. `known` is the last whole seed per row, the thing a partial
 * report is folded onto; `bySdkId` is the join.
 */
export type TaskMemory<Seed extends { id: string; providerTaskId?: string }> = {
  readonly bySdkId: Map<string, string>;
  readonly known: Map<string, Seed>;
  /** SDK task ids that are not rows — ambient housekeeping and shells that
   *  block their turn. Process-lived for the same reason the rows are: the
   *  frames that would resurrect one arrive in any turn, or between turns. */
  readonly suppressed: Set<string>;
  /** The SDK's own `task_type` per task id, from the frames that state it.
   *  Read instead of guessing a kind from `is_backgrounded`, which the SDK
   *  sets for sub-agents and shells alike. */
  readonly typesBySdkId: Map<string, string>;
  /** The row the last `task_notification` spoke for: the shell whose ending
   *  the CLI is about to wake the model over. Names the wake-up's reason. */
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
  /** Everything about the query that cannot change without a new process.
   *  A mismatch on lookup destroys and recreates — never patches. */
  readonly fingerprint: string;
  /**
   * The same identity, per field, as short digests — the only form of it safe
   * to log. The fingerprint string itself carries the login's env patch and
   * every server's headers; see `changedFields` in ./claude-identity.ts.
   */
  readonly fingerprintDigests: Record<string, string>;
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
  /** Every task this process launched or was told about — see `TaskMemory`. */
  readonly tasks: TaskMemory<Seed>;
  /**
   * THE ONE IN-FLIGHT `iterator.next()`, whoever started it.
   *
   * Between turns the driver's IDLE PUMP reads the stream (so a monitor's
   * ending is heard when it happens, not at the next human message); a turn
   * then takes the stream over. A pending `next()` cannot be cancelled, so it
   * is handed over instead: the pump that stops leaves its promise here, and
   * the pump that starts awaits this before calling `next()` itself. Whoever
   * finds `pendingStep` still equal to the promise it awaited owns the frame;
   * a pump told to stop returns before claiming it. Exactly one consumer per
   * frame, no frame lost, no `next()` ever called twice concurrently.
   */
  pendingStep: Promise<IteratorResult<unknown>> | undefined;
  /**
   * Frames the idle pump read but could not handle idly — the first frames of
   * a turn the CLI started on its own. Drained by the next turn's pump before
   * it touches the iterator, so a wake-up's opening frame is never lost.
   */
  readonly parked: unknown[];
  /** The idle pump's stop handle while one is reading. */
  idlePump: { stop: () => void } | undefined;
  /** The stream reported `done` — the process is over. */
  streamEnded: boolean;
  /** Kills the process outright. Idempotent; used by eviction and dispose. */
  readonly destroy: () => void;
  /** The model `setModel` last confirmed, so a turn can skip the round trip. */
  model: string | undefined;
  /**
   * THE QUERY'S RUNNING COST TOTAL, as of the last result this process
   * reported — the baseline a turn's own spend is measured against.
   *
   * It lives on the RUNTIME because that is the thing `total_cost_usd` is
   * scoped to: the SDK documents it as "cumulative across turns in
   * streaming-input sessions", so it resets exactly when the query does. A
   * fresh process starts at `undefined`, which is not the same as zero.
   */
  costTotalUsd: number | undefined;
  /**
   * This process has echoed a send's `uuid` back as `user_message_uuid` at
   * least once — so a main-loop turn that begins WITHOUT one, before ours has,
   * is the CLI's own (a background task's wake-up), not an older producer
   * that never says. Learned per process, never assumed.
   */
  echoesUserMessageUuid: boolean;
  /** A turn is pumping right now — never evict. */
  busy: boolean;
  /**
   * A turn THE CLI STARTED ITSELF is in flight — the idle pump got a binding
   * from the engine and is reading that turn's frames.
   *
   * DELIBERATELY NOT `busy`. `busy` is what `idle()` parks a claiming turn on,
   * and a wake-up must not make a human's next message wait for it: the human
   * turn's `claim` stops the idle pump and takes the stream, which is the
   * design. This flag says only "there is live work here", which is what
   * eviction needs to know and what `busy` alone did not say.
   */
  wakeActive: boolean;
  lastUsedAt: number;
};

/**
 * At most this many EVICTABLE runtimes live at once. Each is a real `claude`
 * process (hundreds of MB); a user hopping between many sessions must not
 * accumulate one per session forever.
 *
 * "EVICTABLE" IS NARROWER THAN "IDLE", and that is the whole of the #201 fix.
 * Measured in the fixtures: five sequential sessions left four idle runtimes
 * and the oldest was destroyed DESPITE a background task still running inside
 * it — the pool killed exactly the work the pool exists to keep alive. A
 * runtime is evictable only when no turn is pumping it, no provider-started
 * wake-up is in flight, and it owns no live background work.
 *
 * THE POOL CAN THEREFORE EXCEED THE CAP, on purpose. The alternative is
 * destroying a session's running shells and monitors to honour a number, and
 * between a memory bound and a person's work the person's work wins. What the
 * cap still guarantees is that abandoned processes do not accumulate.
 */
const MAX_IDLE_RUNTIMES = 3;

/**
 * HOW LONG A STOPPED TURN'S PROCESS GETS TO UNWIND POLITELY before it is
 * killed.
 *
 * THIS IS NOT THE STOP'S LATENCY and must not be read as one: the engine writes
 * `stopped` before the worker has even heard about it, so the transcript is
 * already correct while this grace runs. What it bounds is the TAIL — one pump
 * per session, so the person's next message parks on `idle()` until the
 * interrupted turn lets go of the stream.
 *
 * IT WAS TEN SECONDS, inline, and that was the wrong bound for the wrong
 * reason: it was chosen against "how long might a CLI take to answer an
 * interrupt" when the question the person actually asks is "how long after I
 * stop can I type again". A CLI that has not acknowledged an interrupt in three
 * seconds is not about to; the escalation destroys the process, and the next
 * turn cold-starts from `resume` — which costs a process spawn, not a
 * conversation.
 */
export const STOP_REAP_GRACE_MS = 3_000;

/**
 * The store: sessionId → live runtime, owned by one driver instance.
 *
 * NO TIMERS. Eviction happens lazily on `adopt()` (oldest-idle beyond the
 * cap) and eagerly on `destroyAll()`. A timer here would keep the worker
 * process — and every test that touches the driver — alive for its tick.
 */
export class ClaudeRuntimeStore<T = unknown, Seed extends { id: string; providerTaskId?: string } = { id: string; providerTaskId?: string }> {
  private readonly runtimes = new Map<string, ClaudeSessionRuntime<T, Seed>>();
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  /**
   * Does this task seed represent background work that is still going?
   *
   * INJECTED rather than read here, because the store's `Seed` is deliberately
   * the narrowest shape the handoff needs (`id`, `providerTaskId`) and the
   * driver owns what a task's state and backgrounded flag mean. Absent — the
   * default — means no seed protects anything, which is the pre-#201 behaviour
   * and what a test that does not care about eviction gets.
   */
  private readonly liveBackgroundWork: (seed: Seed) => boolean;

  constructor(options: { liveBackgroundWork?: (seed: Seed) => boolean } = {}) {
    this.liveBackgroundWork = options.liveBackgroundWork ?? (() => false);
  }

  /**
   * May this process be destroyed to make room? Only when nothing is using it:
   * no turn pumping, no provider-started wake-up in flight, and no background
   * task of its own still running.
   */
  private evictable(runtime: ClaudeSessionRuntime<T, Seed>): boolean {
    if (runtime.busy || runtime.wakeActive) return false;
    for (const seed of runtime.tasks.known.values()) if (this.liveBackgroundWork(seed)) return false;
    return true;
  }

  /**
   * Destroy the oldest evictable runtimes beyond the cap.
   *
   * RUN ON RELEASE AS WELL AS ADOPTION, which adoption alone did not achieve:
   * a newcomer arrives BUSY, so it was never itself counted, and the cap was
   * only ever tested at the moment before the newest process became idle.
   * Several sessions finishing their turns therefore left the pool over the
   * cap with nothing that would ever notice.
   */
  private prune(): void {
    const evictable = [...this.runtimes.values()].filter((candidate) => this.evictable(candidate)).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const evicted of evictable.slice(0, Math.max(0, evictable.length - MAX_IDLE_RUNTIMES))) {
      this.destroy(evicted.sessionId);
    }
  }

  /**
   * Resolves once no turn is pumping this session's runtime (or there is no
   * runtime). ONE PUMP PER SESSION: a stopped turn may stay on the iterator
   * until its interrupt is answered or escalated; a second turn pushing into
   * the same feed meanwhile would race that escalation's `destroy`. Looped,
   * because every waiter wakes at once and only the first gets to claim.
   */
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

  /** The live runtime, WITHOUT claiming it or destroying it on a mismatch.
   *  For the reuse diagnostic, which has to read the outgoing runtime's
   *  identity to say which field broke reuse. */
  peek(sessionId: string): ClaudeSessionRuntime<T, Seed> | undefined {
    return this.runtimes.get(sessionId);
  }

  /** The live runtime for this session — IF its fingerprint still matches.
   *  A mismatch means the turn's config changed (env, cwd, mcp, effort…):
   *  the old process is destroyed here and the caller cold-starts a new one. */
  claim(sessionId: string, fingerprint: string): ClaudeSessionRuntime<T, Seed> | undefined {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return undefined;
    if (runtime.fingerprint !== fingerprint) {
      this.destroy(sessionId);
      return undefined;
    }
    // The turn takes the stream: the idle pump lets go (its in-flight
    // `next()` stays on `pendingStep` for the turn to await).
    runtime.idlePump?.stop();
    runtime.idlePump = undefined;
    runtime.busy = true;
    // A wake-up in flight is OVER as far as the pool is concerned: the pump
    // reading it has been told to stop and will return without closing it, so
    // nothing else would ever clear the flag. `busy` protects the runtime from
    // here, and the wake-up's own frames are parked for this turn.
    runtime.wakeActive = false;
    runtime.lastUsedAt = Date.now();
    return runtime;
  }

  /**
   * Take the next frame — the pending one if a pump left it, else a fresh
   * `next()`. The handoff rule from `pendingStep`, in one place.
   */
  static async takeStep(runtime: { iterator: AsyncIterator<unknown>; pendingStep: Promise<IteratorResult<unknown>> | undefined }): Promise<IteratorResult<unknown>> {
    const step = runtime.pendingStep ?? runtime.iterator.next();
    runtime.pendingStep = step;
    const result = await step;
    if (runtime.pendingStep === step) runtime.pendingStep = undefined;
    return result;
  }

  /** Register a freshly created runtime, evicting the oldest evictable ones
   *  beyond the cap. The newcomer arrives busy — it is about to run a turn. */
  adopt(runtime: ClaudeSessionRuntime<T, Seed>): void {
    this.destroy(runtime.sessionId);
    runtime.busy = true;
    runtime.lastUsedAt = Date.now();
    this.runtimes.set(runtime.sessionId, runtime);
    this.prune();
  }

  /**
   * Stop ONE background task inside a session's live runtime, by its provider
   * id. Returns false when there is no live runtime for the session (its
   * process already gone, nothing to stop) or the SDK cannot — the caller
   * turns that into an honest "already gone" rather than a hang.
   */
  async stopTask(sessionId: string, providerTaskId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || typeof runtime.query.stopTask !== "function") return false;
    await runtime.query.stopTask(providerTaskId);
    return true;
  }

  /** The turn is over; the runtime lingers, eligible for eviction. */
  release(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.busy = false;
    runtime.lastUsedAt = Date.now();
    this.wakeIdle(sessionId);
    // The cap is enforced HERE too: this runtime has only just become
    // evictable, and adoption already ran before that was true.
    this.prune();
  }

  /**
   * A provider-started turn opened or closed inside this session's process.
   * Marks live work without touching `busy`, which a claiming turn parks on.
   */
  setWakeActive(sessionId: string, active: boolean): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.wakeActive = active;
    runtime.lastUsedAt = Date.now();
    if (!active) this.prune();
  }

  /**
   * Kill this session's process unless it has let go first.
   *
   * Returns the canceller the turn's `finally` calls when the CLI DID answer
   * its interrupt — so a polite unwind never trips the escalation. Unref'd:
   * a pending reap must not hold the worker process open for its grace.
   */
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
