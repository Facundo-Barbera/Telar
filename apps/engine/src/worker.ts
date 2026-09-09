import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type { EngineClient, ProviderDriverKind, RequestDecision, WorkerClaim } from "@telar/engine-client";
import { clientDsCapability } from "./ds/client-capability";
import { createDisplayCapability } from "./display/capability";
import { clientLatexCapability } from "./latex/client-capability";
import { EngineClientError, qualifyTelarTool, TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import type { BrowserRunBinding, BrowserSocketLease, BrowserToolSocket } from "./browser/socket";
import { runSecretFill } from "./browser/secret-fill";
import type { SessionsSocketLease, SessionsToolSocket } from "./sessions-tools/run-socket";
import { ProviderUnavailableError, type DriverRequest, type DriverRequestOutcome, type SessionsCapability, type TurnDriver } from "./driver";
import { createOnePasswordSecrets, type SecretsProvider } from "./secrets/onepassword";
import type { LoginGrantStore } from "./secrets/login-grants";
import { providerProcessEnv } from "./provider-instances";
import { SteerMailbox } from "./steering";
import { framedTurnInput } from "./attribution";

type WorkerClient = Pick<
  EngineClient,
  | "registerWorker"
  | "workerHeartbeat"
  | "claimTurn"
  | "markTurnRunning"
  | "reportObservations"
  | "openRequest"
  | "completeTurn"
  | "failTurn"
  | "openProviderTurn"
  | "reportSessionTasks"
  | "ackSteer"
  // Shelve/unshelve only — never the whole `updateSession`. See `settleSession`.
  | "settleSession"
  // The spool's verbs. THE WORKER STILL HOLDS NO STORE HANDLE — these go
  // back over the same loopback socket as everything else here, which is what
  // makes the toolkit identical in the embedded worker and the out-of-process
  // one. See `SpoolCapability`.
  | "spool"
  | "spoolItem"
  | "createSpoolItem"
  | "updateSpoolItem"
  | "consultSpoolExpert"
  | "spoolMap"
  | "openSpoolThread"
  | "setSpoolThreadWaiting"
  | "settleSpoolThread"
  | "answerSpoolQuestion"
  | "spoolFocus"
  | "openSpoolFocus"
  | "closeSpoolFocus"
  | "reconcileSpoolLook"
  | "setSpoolSubjectTerrain"
  | "setSpoolSubjectIdentity"
  | "setSpoolAperture"
  | "setSpoolAreaCeiling"
  | "spoolNotes"
  | "createSpoolNote"
  | "updateSpoolNote"
  | "spoolSearch"
  // The `sessions` verbs. Same rule as the spool's above: no store handle,
  // everything back over the loopback socket, so the toolkit is identical in
  // the embedded worker and the out-of-process one. See `SessionsCapability`.
  //
  // NOTHING HERE ARCHIVES, DELETES OR MERGES. `EngineClient` has all three, and
  // their absence from this Pick is what makes "the wall cannot land work"
  // true of the worker's own reach and not only of the tool names: a handler
  // that tried would not compile.
  | "liveSessions"
  | "ds"
  | "latex"
  | "createSession"
  // An AGENT's message, never `submitTurn`: the worker speaks for a turn, and
  // the route it reaches stamps who — see `EngineStore.submitAgentTurn`.
  | "submitAgentTurn"
  | "events"
  | "session"
  // Pause only — no `resumeSession`, so an agent cannot lift a pause.
  | "pauseSession"
  | "sessionDiff"
  // Subscriptions and answering a peer's request. `resolveRequest` reaches
  // the same gate a human's answer does; the WALL narrows it — no `cancel`
  // (that is `stopTurn`), no `secret_access` (a vault pick nobody but the
  // person may make) — and stamps `resolvedBy: "session"` so the trail says
  // an agent answered.
  | "subscribe"
  | "unsubscribe"
  | "subscriptions"
  | "resolveRequest"
>;

/**
 * Which driver runs a claimed turn.
 *
 * A FUNCTION OF THE CLAIM, not a field set once at construction. The engine
 * decides which provider a session belongs to and says so in `claim.driver`; a
 * worker that captured one driver would happily run a Codex session through the
 * Claude SDK and produce a plausible, wrong transcript. Passing a bare
 * `TurnDriver` is still allowed and means "every turn, regardless of provider",
 * which is what the tests want and what a single-provider deployment is.
 */
export type DriverSelector = TurnDriver | ((driver: ProviderDriverKind) => TurnDriver | undefined);

export class UnsupportedDriverError extends Error {
  constructor(driver: string) {
    super(`this worker has no driver for ${driver}`);
    this.name = "UnsupportedDriverError";
  }
}

/**
 * HOW MANY DIFFERENT SESSIONS MAY RUN AT ONCE, derived from the machine
 * instead of guessed.
 *
 * The old value was a flat 4, chosen "under the browser's scope target with
 * headroom" — which meant a laptop with eight cores and 24 GB queued the fifth
 * conversation behind four that were, almost always, idle inside an HTTP
 * request. A provider process is not CPU-bound: it spends its life waiting on
 * a model, so the binding resource is MEMORY, not parallelism. Measured on the
 * dogfood machine, a live `claude` child sits around 300 MB resident.
 *
 * So: budget half of physical memory at 512 MB a process. 16 GB yields 16,
 * 24 GB yields 24 (clamped), 8 GB yields 8. The floor of 4 keeps the old
 * behaviour on a small machine; the ceiling is where the daemon's own event
 * loop — one thread, serving every one of these — stops being able to keep up
 * with their observation traffic, which is a real limit and not a memory one.
 */
const WORKER_MEMORY_BUDGET_PER_TURN = 512 * 1024 * 1024;
const MIN_WORKER_CONCURRENCY = 4;
const MAX_WORKER_CONCURRENCY = 24;

export function defaultWorkerConcurrency(totalBytes: number = os.totalmem()): number {
  const affordable = Math.floor(totalBytes / 2 / WORKER_MEMORY_BUDGET_PER_TURN);
  return Math.min(MAX_WORKER_CONCURRENCY, Math.max(MIN_WORKER_CONCURRENCY, affordable));
}

/** The deployment knob, read by BOTH worker construction sites so the
 *  embedded and standalone workers cannot drift — same rule as
 *  `createDefaultDrivers`. */
export function workerConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.TELAR_WORKER_CONCURRENCY?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export type EngineWorkerOptions = {
  client: WorkerClient;
  workerId: string;
  driver: DriverSelector;
  /**
   * The browser, as the worker-hosted MCP socket both drivers are pointed at.
   * Absent means sessions simply have no browser tools — what a test gets,
   * and strictly better than a socket describing a browser that is not there.
   */
  browserSocket?: BrowserToolSocket;
  /**
   * The `sessions_*` wall as the worker-hosted MCP socket CODEX turns are
   * pointed at — Claude's registration stays in-process (see
   * `DriverRun.sessionsSocket`). Absent means a Codex session simply has no
   * sessions tools, which is what a test gets and what every deployment
   * produced before this existed.
   */
  sessionsSocket?: SessionsToolSocket;
  /**
   * The password-manager read path for `browser_fill_secret`. Defaults to the
   * real `op` CLI adapter; injected by tests so no suite ever spawns one. The
   * default degrades cleanly on a machine without `op` — a sentence, not a
   * crash — so this is safe to construct unconditionally.
   */
  secrets?: SecretsProvider;
  /**
   * Remembered login authorizations (`secrets/login-grants.ts`) — the store a
   * matching `browser_fill_secret` may skip Telar's approval card against.
   * ABSENT MEANS EVERY FILL ASKS, which is the safe default and what a test
   * gets: nothing here can be inferred, only read.
   */
  loginGrants?: LoginGrantStore;
  /**
   * HOW MANY TURNS THIS WORKER RUNS AT ONCE. The engine already refuses two
   * concurrent turns of the SAME session (`claimTurn` skips a session with a
   * claimed or running turn), so this cap only decides how many DIFFERENT
   * sessions may progress together — the old hard-coded 1 was why creating
   * three sessions queued them single-file across unrelated projects.
   * Clamped to at least 1; absent means `defaultWorkerConcurrency()`.
   *
   * IT IS COUNTED OVER CLAIMS, not over live turns — a turn the provider woke
   * by itself is real work but holds no slot, see `tick`.
   *
   * The browser is NOT a reason to keep this small. Its pool (`MAX_BROWSER_SCOPES`)
   * is an LRU that reclaims idle Chromiums on its own, so exceeding it costs a
   * browser relaunch on a session nobody was looking at — not correctness.
   */
  concurrency?: number;
  /** Short testable polling loop; production process supervision is outside this leaf. */
  pollMs?: number;
  /** Used by the process supervisor to rediscover a restarted daemon. */
  onConnectionLost?: () => void;
  /**
   * THIS WORKER IS EXEMPT FROM THE ENGINE'S LEASE — set ONLY by the daemon for
   * the worker it hosts in-process (`daemon.ts` excludes that registration from
   * pruning). A trusted in-process decision, never something a client can
   * assert over HTTP or infer from a response it received.
   */
  leaseExempt?: boolean;
  /** Injected clock and sleep, so a lease test drives time instead of waiting. */
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  /** Where sanitized connectivity diagnostics go. Defaults to stderr; see
   *  `diagnose`. Never receives a message, URL, header or token. */
  onDiagnostic?: (fields: { event: string; operation?: string; code?: string; status?: number; transport?: string; outageMs?: number }) => void;
};

/** A lease this worker will not exceed however large the engine's answer —
 *  a finite derived budget rather than whatever arrives on the wire. */
const MAX_LEASE_MS = 120_000;
/** Inline re-send attempts for a terminal settlement whose response was lost;
 *  after these it is retained and retried per healthy tick instead. */
const SETTLE_ATTEMPTS = 5;
const SETTLE_BACKOFF_MS = 250;
/** How many consecutive failed HEARTBEATS make an exempt worker's connection
 *  lost. Attempts, not seconds: see `heartbeatFailures`. */
const EXEMPT_FAILURE_LIMIT = 5;
/** The bound on any single request for a worker with no lease budget to spend
 *  down. Exemption is from EXPIRY, never from bounding a hung call. */
const EXEMPT_REQUEST_TIMEOUT_MS = 15_000;
/** Ceiling on one settle attempt, so an unleased engine cannot hang a turn. */
const SETTLE_TIMEOUT_MS = 10_000;
/** Retry spacing for a retained settlement: capped exponential, so a dead
 *  endpoint is polled at a bounded rate rather than every tick. */
const SETTLE_RETRY_MIN_MS = 250;
const SETTLE_RETRY_MAX_MS = 30_000;

/** A worker is an executor only: every observable lifecycle event travels back through the engine API. */
export class EngineWorker {
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Evaluates the lease deadline even while a request is hung — see `start`. */
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  /** Set by `stop()` before it aborts, so `execute` can tell a shutdown from a
   *  human Stop — the two look identical on an AbortSignal and settle
   *  differently. */
  private shuttingDown = false;
  /** Why `stop()` was called — the turns it interrupts are told which. */
  private stopReason: "shutdown" | "connection_lost" = "shutdown";
  /**
   * Every `execute` still unwinding, awaited (bounded) by `stop()`.
   *
   * THE EXECUTIONS RATHER THAN THE SETTLES, and the difference is a race that
   * would have made the whole thing a no-op: `stop()` aborts and then looks,
   * but the abort only unwinds `execute` a microtask later, so a set of
   * in-flight SETTLES is reliably empty at the moment it is read. Holding the
   * run itself is what gives `stop()` something that is already there to wait
   * on.
   */
  private readonly inFlight = new Set<Promise<void>>();
  /** How long `stop()` will wait for those settles. Short: a quit that hangs is
   *  worse than a turn that recovers as `ambiguous`, which is what a missed
   *  settle degrades to. */
  private readonly shutdownSettleMs = 2_000;
  private readonly active = new Map<string, AbortController>();
  /** The subset of `active` that came from a CLAIM — what the concurrency cap
   *  is counted over. A provider-opened turn is live work but was never
   *  scheduled through the gate, so it must not hold a slot shut. */
  private readonly activeClaims = new Set<string>();
  private connectionLost = false;
  /**
   * THE DAEMON'S OWN LEASE, learned at registration — never invented here.
   * `registerWorker` answers with `heartbeatIntervalMs`; the daemon prunes at
   * three of them. `undefined` (an older daemon states no rule) means no budget
   * we are entitled to spend, so a failure is fatal on the first occurrence.
   */
  private leaseMs: number | undefined;
  /**
   * CONSECUTIVE FAILED HEARTBEATS, the exempt worker's liveness signal.
   *
   * Elapsed wall-clock cannot be it: the daemon never prunes this registration,
   * so expiring on `Date.now()` is the worker inventing an authority the engine
   * does not exercise — and a system sleep or an event-loop stall makes that
   * clock jump past any lease with no request having failed at all. Counting
   * ATTEMPTS is immune to both: none happen while suspended.
   */
  private heartbeatFailures = 0;
  /**
   * When the last acknowledged exchange with the engine STARTED — not when its
   * reply arrived, and not when a failure was noticed.
   *
   * The anchor has to be the last success, or the budget is unbounded: a
   * request issued at t=29s that fails at t=31s would otherwise open a fresh
   * lease at t=31s, and a worker could act arbitrarily far past the engine's
   * own expiry. Taking the request's START rather than its completion also
   * absorbs response latency in the conservative direction.
   */
  private lastAckAt = Date.now();
  /** Set once a failure has been reported for the current outage, so the
   *  diagnostic sink gets one line per outage rather than one per tick. */
  private outageReported = false;
  /** Lazily built default `op` adapter — one per worker, never per turn. */
  private secrets: SecretsProvider | undefined;
  /**
   * Approvals this worker is blocked on, keyed by request id.
   *
   * A driver sitting inside `canUseTool` is parked on one of these promises.
   * The engine cannot push, so the answer arrives on the next heartbeat and
   * `tick()` settles it — which is why the heartbeat must keep running while a
   * turn is blocked, and therefore why the "one turn at a time" early-return in
   * `tick()` comes AFTER the heartbeat rather than before it.
   */
  private readonly awaiting = new Map<string, (outcome: DriverRequestOutcome) => void>();
  /**
   * Each running turn's steer mailbox plus its unacked deliveries, keyed by
   * claim token like `active`.
   *
   * ACK ON DRAIN, NOT ON PUSH. A pushed message can still be lost — the turn
   * can settle before the driver's next boundary drains it — and an ack at
   * push time would mark that lost message `steered`. A DRAINED message is
   * one the driver holds, so the mailbox's drain hook is where the ack fires;
   * an undrained one leaves the turn `steering`, and the engine's settlement
   * sweep requeues it. A lost ACK still re-carries and re-pushes on a later
   * heartbeat — duplication over loss, the codebase's stated side of that
   * trade; `pushedSteers` narrows it to actually-lost acks.
   */
  private readonly steering = new Map<string, { mailbox: SteerMailbox; pendingAck: Array<{ sessionId: string; steerRunId: string; claimToken: string }> }>();
  private readonly pushedSteers = new Set<string>();
  /**
   * Each session's browser binding, KEPT ACROSS TURNS. The lease's url+token
   * are baked into the Claude session runtime's MCP config at process
   * creation (driver.ts), so a per-turn token would force a new provider
   * process every turn — the exact lifetime this store exists to avoid. The
   * gate and observation sink still belong to a TURN (they ride a claim
   * token), so they delegate through `refs`, re-pointed at the top of every
   * turn. Between turns the stale gate asks the engine against a settled
   * claim and is refused — a browser call from lingering background work is
   * denied rather than approved by a ghost.
   */
  private readonly browserLeases = new Map<
    string,
    {
      lease: BrowserSocketLease;
      refs: {
        gate: NonNullable<BrowserRunBinding["gate"]>;
        onNavigated: NonNullable<BrowserRunBinding["onNavigated"]>;
        /** Per-turn like the gate — its `ask` opens a `secret_access` request
         *  against THIS turn's claim, so a stale one must be refused, not
         *  answered by a ghost. */
        fillSecret: NonNullable<BrowserRunBinding["fillSecret"]>;
      };
    }
  >();
  /**
   * Each CODEX session's sessions-wall lease, kept across turns for the same
   * reason the browser's is: the url+token are baked into the provider process
   * at creation and that process outlives the turn. No per-turn refs here —
   * the capability closes over the session id and the worker's client, both
   * stable for the session's life. Revoked in `stop()`.
   */
  private readonly sessionsLeases = new Map<string, SessionsSocketLease>();
  /** Terminal settlements the engine has not acknowledged, by runId. Retried on
   *  every healthy tick — see `drainSettlements`. */
  private readonly pendingSettlements = new Map<
    string,
    { sessionId: string; runId: string; claimToken: string; operation: "completeTurn" | "failTurn"; send: (signal: AbortSignal) => Promise<unknown>; since: number; rounds: number; nextAttemptAt: number }
  >();
  /** One drain at a time, and never on the tick's own await chain. */
  private draining = false;

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollMs = options.pollMs ?? 100;
  }

  async start(): Promise<void> {
    const startedAt = this.now();
    this.lastAckAt = startedAt;
    const registration = await this.options.client.registerWorker(this.options.workerId);
    // Nothing is installed once stop() has run: no timers, no claims.
    if (this.stopped) return;
    // Clamped: a finite budget, whatever the engine answers.
    const interval = registration?.heartbeatIntervalMs;
    if (typeof interval === "number" && Number.isFinite(interval) && interval > 0) {
      this.leaseMs = Math.min(interval * 3, MAX_LEASE_MS);
    }
    this.lastAckAt = startedAt;
    // BEFORE the first tick, not after: a first heartbeat that hangs would
    // otherwise have no watchdog at all until it timed out.
    this.watchdog = setInterval(() => this.checkLease(), Math.max(10, Math.floor((this.leaseMs ?? this.pollMs) / 3)));
    this.watchdog.unref?.();
    await this.tick();
    if (this.stopped) {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = undefined;
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  /** The clock, injectable so a test can drive the lease without sleeping. */
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** What is left of the lease. `undefined` when the engine states none, and
   *  for an exempt worker, whose requests take a fixed bound instead. */
  private remainingLeaseMs(): number | undefined {
    if (this.options.leaseExempt || this.leaseMs === undefined) return undefined;
    return this.leaseMs - (this.now() - this.lastAckAt);
  }

  /** An exempt worker never expires on elapsed time — see `heartbeatFailures`. */
  private expired(): boolean {
    if (this.options.leaseExempt) return false;
    const remaining = this.remainingLeaseMs();
    return remaining !== undefined && remaining <= 0;
  }

  /** Every request is bounded, exempt or not: exemption from the lease must
   *  never mean an unbounded hung HTTP call. */
  private requestTimeoutMs(): number {
    const remaining = this.remainingLeaseMs();
    return Math.max(1, Math.min(EXEMPT_REQUEST_TIMEOUT_MS, remaining ?? EXEMPT_REQUEST_TIMEOUT_MS));
  }

  /** Out of contact longer than the engine allows? On its own timer, so a hung
   *  request cannot suppress it. */
  private checkLease(): void {
    if (this.stopped || this.connectionLost || this.options.leaseExempt || this.leaseMs === undefined) return;
    if (this.expired()) {
      this.loseConnection(new EngineClientError("engine_unavailable", "engine lease expired", undefined, { operation: "workerHeartbeat", transport: "lease_expired" }));
    }
  }

  /**
   * `reason` is what the turns this worker was running will be TOLD, and the
   * two are not the same event.
   *
   * `"shutdown"` is Telar quitting. `"connection_lost"` is this worker being
   * REPLACED after the supervisor gave up on its connection — the daemon may
   * be perfectly alive, and before #208 both settled a turn with copy that
   * asserted a shutdown had happened. A person reading "Telar shut down" when
   * Telar had not shut down cannot debug anything, and it is simply false.
   */
  async stop(reason: "shutdown" | "connection_lost" = "shutdown"): Promise<void> {
    this.stopReason = reason;
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    /**
     * A TURN THIS WORKER WAS RUNNING IS TOLD SO ON THE WAY OUT, and before this
     * it simply was not.
     *
     * The abort below unwinds `execute`, whose catch has always opened with
     * `if (controller.signal.aborted) return` — correct for a human Stop (the
     * engine recorded `stopped` before the worker ever saw it) and silently
     * wrong for a shutdown, where nobody recorded anything. Measured against a
     * real daemon: `queue.json` still read `running` after an awaited
     * `daemon.close()`, so the next boot found it and called it `ambiguous` —
     * a state that demands a human decision about a turn we had just watched
     * being interrupted. `daemon.ts` even claimed stopping the worker first
     * prevented exactly this. It did not.
     *
     * `shuttingDown` is what lets `execute` tell the two aborts apart, and the
     * settles are AWAITED here because `daemon.close()` closes the HTTP server
     * immediately after this resolves — an unawaited `failTurn` would race the
     * socket it needs and lose.
     */
    this.shuttingDown = true;
    for (const controller of this.active.values()) controller.abort(new Error("worker stopped"));
    /**
     * BOUNDED, because quitting must not hang on an engine that is already
     * gone. A settle that does not land in time leaves the turn `running`,
     * which recovers as `ambiguous` — the old behaviour, which is the correct
     * thing to degrade to: it is the honest answer when we could not say.
     */
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.shutdownSettleMs).unref?.();
        }),
      ]);
    }
    // The session-lived state dies with the WORKER, not with any turn: the
    // browser tokens are revoked and every lingering provider process — the
    // ones deliberately kept alive between turns — is closed.
    for (const { lease } of this.browserLeases.values()) lease.release();
    this.browserLeases.clear();
    for (const lease of this.sessionsLeases.values()) lease.release();
    this.sessionsLeases.clear();
    const selector = this.options.driver;
    if (typeof selector === "function") {
      try {
        selector("claude")?.dispose?.();
      } catch {
        // A deployment with no Claude driver has nothing to dispose.
      }
    } else {
      selector.dispose?.();
    }
  }

  /**
   * TELL THE ENGINE THIS TURN WAS CUT OFF BY A SHUTDOWN.
   *
   * Reached from BOTH ways an aborted run can end — the driver returning
   * cleanly (the common one) and the driver throwing — which is why it is a
   * method rather than a line at one of them.
   *
   * WHAT THE MESSAGE CLAIMS, and deliberately no more: the turn was
   * interrupted. Not that it was harmless. Anything it had already run — a
   * push, a delete, an outbound call — was in the world before the abort
   * arrived, and no shutdown can take it back. The copy says so, because
   * "interrupted" read as "nothing happened" would invite exactly the blind
   * replay the ambiguous state exists to prevent.
   */
  private async recordInterruption(sessionId: string, runId: string, claimToken: string): Promise<void> {
    await this.options.client
      .failTurn(sessionId, runId, claimToken, {
        code: "interrupted",
        message:
          this.stopReason === "connection_lost"
            ? // NEUTRAL ABOUT THE CAUSE. A replacement follows an expired
              // budget, a refused credential OR an unknown registration, and
              // the copy must not assert one of them — an immediate
              // `engine_unauthorized` did not "exceed" anything. It says what
              // is certain: contact was lost, the worker was replaced.
              "Telar's worker lost contact with the engine and was replaced while this turn was running. What it had already done is above; whether it had finished anything elsewhere is unknown."
            : "Telar shut down while this turn was running. What it had already done is above; whether it had finished anything elsewhere is unknown.",
      })
      // An engine already gone cannot be told, and a quit must not hang on it.
      // The turn stays `running` and the next boot calls it `ambiguous` — the
      // honest degradation, and the behaviour this replaced.
      .catch(() => undefined);
  }

  /**
   * A TERMINAL SETTLEMENT, REPEATED AS ITSELF UNTIL THE ENGINE HOLDS IT.
   *
   * The same call, so a completed turn stays completed with its own text and
   * usage. Idempotent by claim token: `conflict` means the engine already has
   * it, before or after a lost acknowledgement. No provider re-runs.
   *
   * Every attempt is bounded by a signal and re-checks state and deadline, so a
   * hanging or post-stop send cannot park the turn. Exhausting the inline
   * attempts does NOT abandon the turn and does NOT touch the connection: the
   * settlement is RETAINED and retried on later ticks, because an endpoint
   * failing while heartbeats succeed is not evidence the engine is gone.
   * Revocation is the exception — the engine's verdict on this worker, failed
   * closed at once.
   */
  private async settle(
    entry: { sessionId: string; runId: string; claimToken: string; operation: "completeTurn" | "failTurn"; send: (signal: AbortSignal) => Promise<unknown> },
    attempts = SETTLE_ATTEMPTS,
  ): Promise<"settled" | "pending"> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await this.pause(SETTLE_BACKOFF_MS);
        // Re-checked AFTER the pause: a stop or an expiry landing inside it
        // must not send the next request.
        if (this.stopped || this.connectionLost || this.expired()) break;
      } else if (this.stopped || this.connectionLost || this.expired()) {
        break;
      }
      try {
        await entry.send(AbortSignal.timeout(this.settleTimeoutMs()));
        // "Late" means it had needed retrying at all — including on a later
        // tick, where this is the first attempt of its round.
        if (attempt > 0 || this.pendingSettlements.has(entry.runId)) this.diagnose({ event: "turn_settled_late", operation: entry.operation });
        this.pendingSettlements.delete(entry.runId);
        return "settled";
      } catch (error) {
        if (error instanceof EngineClientError && error.code === "conflict") {
          this.pendingSettlements.delete(entry.runId);
          return "settled";
        }
        // `not_found` is an explicit disposition, not a failed retry: there is
        // no such turn to settle, so the entry is released rather than held.
        if (error instanceof EngineClientError && error.code === "not_found") {
          this.pendingSettlements.delete(entry.runId);
          this.diagnose({ event: "turn_settlement_vacated", operation: entry.operation, ...EngineWorker.describe(error) });
          return "settled";
        }
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        // A non-connectivity refusal is still an unresolved outcome: retained
        // and spaced like a transport failure, never rethrown or dropped.
        if (!timedOut && !isConnectivityLoss(error)) {
          this.diagnose({ event: "turn_settlement_refused", operation: entry.operation, ...EngineWorker.describe(error) });
          break;
        }
        if (error instanceof EngineClientError && (error.code === "engine_unauthorized" || error.code === "worker_unavailable")) {
          this.noteConnectivityFailure(error);
          this.diagnose({ event: "turn_settlement_refused", operation: entry.operation, ...EngineWorker.describe(error) });
          this.pendingSettlements.delete(entry.runId);
          return "pending";
        }
        if (!timedOut) this.noteConnectivityFailure(error);
      }
    }
    this.retain(entry);
    return "pending";
  }

  /** Hold this settlement for a later drain. Never dropped on a retry count —
   *  forgetting an unresolved outcome is the defect — and spaced by a capped
   *  exponential so a refusing endpoint is polled at a bounded rate. */
  private retain(entry: { sessionId: string; runId: string; claimToken: string; operation: "completeTurn" | "failTurn"; send: (signal: AbortSignal) => Promise<unknown> }): void {
    const held = this.pendingSettlements.get(entry.runId);
    const rounds = (held?.rounds ?? 0) + 1;
    const at = this.now();
    this.pendingSettlements.set(entry.runId, {
      ...entry,
      since: held?.since ?? at,
      rounds,
      nextAttemptAt: at + Math.min(SETTLE_RETRY_MAX_MS, SETTLE_RETRY_MIN_MS * 2 ** Math.min(rounds, 12)),
    });
    if (!held) this.diagnose({ event: "turn_settlement_pending", operation: entry.operation });
  }

  /** A settle attempt's own bound: the remaining lease when there is one, never
   *  more than a fixed ceiling, so an unleased engine still cannot hang us. */
  private settleTimeoutMs(): number {
    const remaining = this.remainingLeaseMs();
    return Math.max(1, Math.min(SETTLE_TIMEOUT_MS, remaining ?? SETTLE_TIMEOUT_MS));
  }

  /**
   * Retry retained settlements, OFF the tick's await chain.
   *
   * Awaiting this inside `tick` was itself an outage generator: three hung
   * endpoints at ten seconds each starve a thirty-second lease, the watchdog
   * calls the engine lost, and every healthy session dies — the original
   * incident, recreated by its own fix. So the tick starts a drain and moves
   * on; heartbeats, cancellations and steers are never behind a settlement.
   * One drain at a time, and only entries whose backoff has elapsed.
   */
  private startDrain(): void {
    if (this.draining || this.pendingSettlements.size === 0 || this.stopped || this.connectionLost) return;
    this.draining = true;
    void (async () => {
      try {
        for (const entry of [...this.pendingSettlements.values()]) {
          if (this.stopped || this.connectionLost) return;
          if (this.now() < entry.nextAttemptAt) continue;
          // Per entry: one settlement the engine keeps refusing must not stop
          // every later one from being attempted. `settle` retains and spaces
          // what it classifies; this catches anything it could not.
          try {
            await this.settle(entry, 1);
          } catch {
            this.retain(entry);
          }
        }
      } finally {
        this.draining = false;
      }
    })();
  }

  /** Injectable so a fake-clock test never sleeps. */
  private pause(ms: number): Promise<void> {
    return this.options.pause ? this.options.pause(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Exposed for deterministic tests and embedded supervisors. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    // Held outside the try so the catch can tell a failure from THIS attempt
    // from one whose attempt predates a newer acknowledgement.
    const tickIssuedAt = this.now();
    try {
      const issuedAt = tickIssuedAt;
      // Bounded by what is LEFT of the lease, not a fresh one per request: a
      // reply due after the deadline is worthless, and a per-request timeout
      // would let successive requests outlive the budget entirely.
      const status = await this.options.client.workerHeartbeat(this.options.workerId, AbortSignal.timeout(this.requestTimeoutMs()));
      if (this.stopped || this.connectionLost) return;
      // THE DEADLINE, NOT THE FLAGS. The watchdog runs every lease/3, so an
      // expired reply can land before it next fires; accepting it would reset
      // `lastAckAt` and resurrect a budget that is already spent.
      if (this.expired()) {
        this.loseConnection(new EngineClientError("engine_unavailable", "engine lease expired", undefined, { operation: "workerHeartbeat", transport: "lease_expired" }));
        return;
      }
      // Anchored at the moment we ASKED, so latency counts against us.
      this.lastAckAt = issuedAt;
      this.heartbeatFailures = 0;
      if (this.outageReported) {
        this.diagnose({ event: "engine_reachable", operation: "workerHeartbeat" });
        this.outageReported = false;
      }
      // The engine is answering: push any turn whose outcome it never
      // acknowledged — started, NOT awaited. See `startDrain`.
      this.startDrain();
      for (const cancellation of status.cancel) this.active.get(cancellation.claimToken)?.abort(new Error("turn stopped"));
      // Settle anything a human answered since the last beat. This must happen
      // even while a turn is active — the turn is what is waiting. KEYED BY
      // RUN AND REQUEST, not request alone: with concurrent turns, two
      // providers could mint the same tool-use id and a request-only key
      // would settle the wrong session's approval.
      for (const resolution of status.resolved) {
        const settle = this.awaiting.get(`${resolution.runId}:${resolution.requestId}`);
        if (!settle) continue;
        this.awaiting.delete(`${resolution.runId}:${resolution.requestId}`);
        // The ANSWERS ride along — a `user_input` request is worthless to the
        // driver as a bare decision.
        settle({ decision: resolution.decision, ...(resolution.answers ? { answers: resolution.answers } : {}) });
      }
      // Stop lingering background tasks the user asked to end. The task lives
      // in the session's live provider process, which this worker's driver
      // holds — no turn, no claim token, just the session and the provider id.
      // Best-effort: the engine has already marked the projection stopped, so
      // a driver that no longer has the runtime (false) simply means the
      // process is gone and the task with it.
      for (const kill of status.stopTask ?? []) {
        const driver = this.driverFor("claude");
        void driver.stopTask?.(kill.sessionId, kill.providerTaskId).catch(() => undefined);
      }
      // Deliver send-now messages into their running turns' mailboxes. The
      // ack fires later, from the mailbox's drain hook — see `steering`.
      for (const delivery of status.steer ?? []) {
        if (this.pushedSteers.has(delivery.steerRunId)) continue;
        const entry = this.steering.get(delivery.claimToken);
        // No mailbox (or closed): this worker cannot deliver — leave the
        // turn `steering`; the engine's settlement sweep requeues it.
        if (
          !entry?.mailbox.push({
            text: delivery.text,
            ...(delivery.attachments?.length ? { attachments: delivery.attachments } : {}),
            ...(delivery.sender ? { sender: delivery.sender } : {}),
            ...(delivery.wakeReason ? { wakeReason: delivery.wakeReason } : {}),
          })
        )
          continue;
        this.pushedSteers.add(delivery.steerRunId);
        entry.pendingAck.push({ sessionId: delivery.sessionId, steerRunId: delivery.steerRunId, claimToken: delivery.claimToken });
      }
      // Claim until the cap or the queue runs dry. One claim per call is the
      // engine's shape (`claimNextTurn` hands out the oldest claimable turn),
      // so the loop is what turns a per-tick single claim into real
      // cross-session concurrency.
      /**
       * COUNTED OVER CLAIMS, NOT OVER EVERY LIVE TURN.
       *
       * `active` also holds PROVIDER turns — the ones a CLI opens by itself
       * when a background task notifies it — and those were never claimed
       * through this gate. Counting them here meant a session waking up on its
       * own silently consumed one of the machine's execution slots, so a human
       * starting a new conversation could sit at "queued" behind work nobody
       * scheduled and no slot could be seen to be free. Measured on the
       * dogfood machine: four human turns plus one wake-up, and the fifth
       * conversation would not start.
       */
      const cap = Math.max(1, this.options.concurrency ?? defaultWorkerConcurrency());
      while (this.activeClaims.size < cap && !this.stopped) {
        const { claim } = await this.options.client.claimTurn(this.options.workerId);
        if (!claim) break;
        /**
         * THE SHUTDOWN CAN LAND INSIDE THAT AWAIT.
         *
         * A claim is a round trip, and `stop()` runs on its own schedule: it
         * can set `stopped`, abort what it knows about and snapshot `inFlight`
         * entirely between this request and its response. Starting the run
         * anyway would put a turn into `running` on a worker that is already
         * dismantling itself — after the only wait that would have settled it,
         * so it lands on the next boot as `ambiguous` for a turn that never
         * reached a provider at all.
         *
         * LEFT `claimed`, DELIBERATELY. `markTurnRunning` has not been called,
         * and `worker.ts` orders it before the driver is constructed precisely
         * so `claimed` PROVES no provider was spawned — which is why recovery
         * requeues such a turn instead of holding it for a human. Handing it
         * back by doing nothing is the safest of the three options, and the
         * only one that needs no new engine verb.
         */
        if (this.stopped) break;
        // Held so `stop()` can wait for the run to unwind and record its
        // interruption, rather than aborting into the dark.
        const run = this.execute(claim);
        this.inFlight.add(run);
        void run.finally(() => this.inFlight.delete(run));
      }
    } catch (error) {
      // Our own heartbeat bound firing is an outage, not a caller hanging up.
      if (error instanceof DOMException && error.name === "TimeoutError") this.noteConnectivityFailure(new EngineClientError("engine_unavailable", "engine did not answer in time", undefined, { operation: "workerHeartbeat", transport: "timeout" }), tickIssuedAt);
      else if (isConnectivityLoss(error)) this.noteConnectivityFailure(error, tickIssuedAt);
      else throw error;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * ONE BOUNDED, SANITIZED LINE PER EVENT — the sink `operation` and
   * `transport` exist for; without it they would be dropped exactly as the raw
   * cause was. Never carries a message, URL, header or token.
   */
  private diagnose(fields: { event: string; operation?: string; code?: string; status?: number; transport?: string; outageMs?: number }): void {
    const sink = this.options.onDiagnostic;
    if (sink) {
      sink(fields);
      return;
    }
    process.stderr.write(`[worker] ${JSON.stringify({ workerId: this.options.workerId, ...fields })}\n`);
  }

  /** The safe half of an EngineClientError, for `diagnose`. */
  private static describe(error: unknown): { code?: string; status?: number; operation?: string; transport?: string } {
    if (!(error instanceof EngineClientError)) return {};
    return {
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.transport === undefined ? {} : { transport: error.transport }),
    };
  }

  /**
   * A FAILED CONTROL POLL IS NOT AUTOMATICALLY A LOST ENGINE — #208.
   *
   * REVOKED (`engine_unauthorized`, `worker_unavailable`) is the engine
   * answering definitively that this worker may not act: immediate, nothing to
   * wait out. UNREACHABLE (`engine_unavailable`) is a transport fact, not an
   * engine verdict, and is ridden out within the engine's own lease with the
   * worker's turns still running.
   */
  private noteConnectivityFailure(error: unknown, issuedAt?: number): void {
    if (this.stopped || this.connectionLost) return;
    const described = EngineWorker.describe(error);
    // REVOKED: the engine answering, definitively, that this worker may not
    // act. Nothing to wait out, and continuing would be work outside the lease.
    if (error instanceof EngineClientError && (error.code === "engine_unauthorized" || error.code === "worker_unavailable")) {
      this.loseConnection(error);
      return;
    }
    /**
     * AN EXEMPT WORKER COUNTS ATTEMPTS, NOT SECONDS. Only heartbeat failures
     * count, and only ones from an attempt no older than the last success — a
     * stale failure landing after a newer acknowledgement must not push a
     * healthy worker toward a loss it has already disproved.
     */
    if (this.options.leaseExempt) {
      if (issuedAt !== undefined && issuedAt < this.lastAckAt) return;
      if (described.operation !== "workerHeartbeat") return;
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures >= EXEMPT_FAILURE_LIMIT) this.loseConnection(error);
      return;
    }
    // No stated lease means no budget we are entitled to spend: fail closed on
    // the first failure, exactly as before #208.
    if (this.leaseMs === undefined) {
      this.loseConnection(error);
      return;
    }
    if (!this.outageReported) {
      this.outageReported = true;
      this.diagnose({ event: "engine_unreachable", ...described });
    }
    // The deadline is measured from the last ACKNOWLEDGED exchange, never from
    // this failure — the watchdog owns the expiry decision so a hung request
    // cannot defer it.
    this.checkLease();
  }

  /**
   * Takes the CLAIM rather than seven positional fields.
   *
   * The claim is already the engine's complete answer to "what should this
   * worker run" — unpacking it at the call site meant every new field on the
   * contract (the model, most recently) had to be threaded through another
   * positional parameter, in the right order, with nothing to catch a swap of
   * two adjacent strings.
   */
  private async execute(claim: WorkerClaim): Promise<void> {
    const { sessionId, projectRoot: cwd, resumeCursor: providerSessionId, driver: driverKind, model } = claim;
    const { runId } = claim.turn;
    // An agent's message reaches the provider framed as a peer's and a wake as
    // the engine's own notice, never as the person's words — and a wake that
    // opens its own turn here is framed exactly as one steered mid-turn is.
    // See ./attribution.ts.
    const prompt = framedTurnInput(claim.turn);
    const claimToken = claim.turn.claim!.token;
    const controller = new AbortController();
    this.active.set(claimToken, controller);
    this.activeClaims.add(claimToken);
    // The turn's send-now mailbox, registered before the first heartbeat that
    // could carry a delivery. Closed with the turn — a push after close is
    // refused and the engine's sweep requeues the message instead.
    const steer = new SteerMailbox();
    const steerEntry = { mailbox: steer, pendingAck: [] as Array<{ sessionId: string; steerRunId: string; claimToken: string }> };
    this.steering.set(claimToken, steerEntry);
    steer.onDrain(() => {
      // The driver holds the text now; tell the engine, one ack per delivery.
      // A failed ack leaves `pushedSteers` cleared so a later heartbeat
      // re-carries and re-pushes — the accepted duplicate, never a loss.
      for (const ack of steerEntry.pendingAck.splice(0)) {
        void this.options.client
          .ackSteer(ack.sessionId, ack.steerRunId, ack.claimToken)
          .catch(() => undefined)
          .finally(() => this.pushedSteers.delete(ack.steerRunId));
      }
    });
    /**
     * ONE park/heartbeat implementation for both doors into the engine's gate:
     * the driver's own `onRequest`, and the browser socket's per-call gate.
     * Factored rather than duplicated so an abort settles BOTH the same way.
     */
    /**
     * ONE LINE PER TURN when the engine refuses a tool request because the
     * turn already settled. This is the signature of the premature-completion
     * bug (a `result` consumed while tool calls were still running): every
     * refusal after the first says nothing new, and the driver already turns
     * each into a deny the model can read — but with zero log lines the
     * failure was undiagnosable from the daemon log alone.
     */
    const { askEngine, gate: gateForTurn, onNavigated: onNavigatedForTurn, fillSecret: fillSecretForTurn } = this.bindTurn(sessionId, runId, claimToken, controller);
    let lease: BrowserSocketLease | undefined;
    try {
      // AFTER `markTurnRunning`, NOT BEFORE, and the ordering is load-bearing:
      // `failTurn` only settles a turn that is RUNNING, so a worker with no
      // driver for this provider that threw here first would leave the turn
      // stuck at `claimed` until its lease expired, with nothing recorded.
      // Measured — the test below asserted `failed` and got `claimed`.
      await this.options.client.markTurnRunning(sessionId, runId, claimToken);
      const driver = this.driverFor(driverKind);
      // THE PROJECT FOLDER MUST EXIST BEFORE A PROVIDER IS SPAWNED IN IT. A
      // missing cwd makes the SDK's spawn fail with ENOENT, which the Claude
      // SDK reports as a misleading "native binary" error — the folder, not
      // the binary, is what is gone (a moved checkout, a deleted worktree).
      // Said plainly here, in the words that fix it, before anything spawns.
      assertProjectRoot(cwd);
      /**
       * THE SESSION'S BROWSER LEASE, one binding per session rather than one
       * per run. The lease's url+token are baked into the provider's live
       * process at creation, and that process now OUTLIVES the turn — a
       * per-run token would invalidate the process's browser access the
       * moment its first turn settled. Per-turn authority still holds: the
       * gate delegates through `refs`, re-pointed here every turn, and a call
       * arriving between turns is asked against a settled claim and refused.
       * Released in `stop()`, when the provider processes die too.
       */
      // THE PROJECT PROFILE, EVERY TURN, BEFORE THE LEASE. Idempotent, and
      // repeated on purpose: the desktop manager's in-memory bindings are lost
      // if its window is rebuilt (e.g. a translucency rebuild) while the worker
      // keeps its cached lease — without a rebind that session's browser would
      // refuse to open until the cockpit next declared it. The host refuses
      // tabs for a scope nobody bound; a projectless session binds `none`.
      //
      // A BINDING THE HOST CANNOT TAKE IS NOT THE TURN'S FAILURE. Measured in
      // release review: an older desktop shell (no `/bind` route) answered
      // 404 "Not found." and, because this threw, EVERY turn on the machine
      // failed as `driver_failed: Not found.` before the provider ran — with
      // no browser tool involved. The binding is a precondition for the
      // browser TOOLS, and the router re-issues it before each tool call
      // (`restoreProfile`), where a refusal lands on the call that needs it.
      // Here it is best-effort; the reason is noted for the operator.
      if (this.options.browserSocket) {
        try {
          await this.options.browserSocket.bindProfile(sessionId, claim.projectId ?? "none");
        } catch (error) {
          console.error(`[worker] browser profile binding deferred for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const cached = this.browserLeases.get(sessionId);
      if (cached) {
        cached.refs.gate = gateForTurn;
        cached.refs.onNavigated = onNavigatedForTurn;
        cached.refs.fillSecret = fillSecretForTurn;
        lease = cached.lease;
      } else if (this.options.browserSocket) {
        const refs = { gate: gateForTurn, onNavigated: onNavigatedForTurn, fillSecret: fillSecretForTurn };
        lease = await this.options.browserSocket.bind({
          // Sessions are the browser's natural boundary: two sessions must not
          // share a tab, and a session's tabs must survive between its turns.
          scopeKey: sessionId,
          // Where a `file:` navigation may point — the session's own checkout,
          // and nowhere else. Stable for the session's life, like the scope.
          workspaceRoot: cwd,
          gate: (input) => refs.gate(input),
          onNavigated: (state) => refs.onNavigated(state),
          fillSecret: (args, callBrowser, profile) => refs.fillSecret(args, callBrowser, profile),
        });
        this.browserLeases.set(sessionId, { lease, refs });
      }
      /**
       * THE SESSIONS TOOLKIT — a session's door to OTHER sessions. Hoisted out
       * of the `driver.run` call because it now has TWO consumers: Claude's
       * in-process registration (the `sessions` field below) and the socket
       * lease a Codex turn is pointed at.
       *
       * UNSCOPED, unlike the spool, and that is not an oversight: there is no
       * scope to apply. A session created here is a PEER of the one that
       * asked — no parent, no child, no link recorded anywhere — so there is
       * nothing about this turn for the capability to be narrowed by, and
       * nothing counts how many it creates.
       *
       * EVERY VERB GOES BACK THROUGH THE CLIENT, for the reason the spool's
       * do: the worker holds no store handle, and routing through the same
       * HTTP surface the cockpit uses means there is exactly one
       * implementation of every rule about a session, whichever door
       * reached it.
       *
       * `origin: "session"` IS DECLARED HERE, in this code, and no tool shape
       * on the wall carries it — the same construction as the spool's
       * `source: "session"`.
       */
      const sessionsCapability: SessionsCapability = {
        /**
         * THE ONE SCOPED THING ON THIS CAPABILITY: who is asking, so a
         * subscription can name the session to wake. Closed over the claim
         * exactly as the spool's `project` is. The daemon's socket builds
         * this same capability WITHOUT it — a chat client has no session
         * to be woken in — and the wall refuses to subscribe there.
         */
        self: { sessionId },
        list: () => this.options.client.liveSessions(),
        create: async (input) => (await this.options.client.createSession({ ...input, origin: "session" })).session,
        /**
         * SENT AS THIS TURN, PROVABLY. The proof is the claim the worker is
         * running under — the one thing a model inside the turn cannot see
         * or forge — so the engine can stamp `Turn.sender` with this session
         * and draw the message as a peer's report rather than the person's.
         * Measured before this: the same call went through `submitTurn` and
         * the receiving session showed an orchestrator's instructions in the
         * human's own bubble, with the provider told the user had spoken.
         */
        send: async (id, input) => {
          const accepted = await this.options.client.submitAgentTurn(id, { ...input, proof: { sessionId, runId, claimToken } });
          return { turn: accepted.turn, replayed: accepted.replayed };
        },
        read: async (id, after) => (await this.options.client.events(id, after)).events,
        status: async (id) => {
          const snapshot = await this.options.client.session(id);
          return { session: snapshot.session, turns: snapshot.turns };
        },
        // A PAUSE, stamped as an agent's. `stopTurn` would let this worker
        // claim the peer's next message a heartbeat later.
        stop: (id) => this.options.client.pauseSession(id, "session"),
        settle: async (id, settled) => (await this.options.client.settleSession(id, settled)).session,
        diff: async (id) => (await this.options.client.sessionDiff(id)).diff,
        subscribe: async (subscriber, input) => (await this.options.client.subscribe(subscriber, input)).subscription,
        unsubscribe: async (id, subscriber) => (await this.options.client.unsubscribe(id, { subscriberSessionId: subscriber })).removed,
        subscriptions: async (subscriber) => (await this.options.client.subscriptions(subscriber)).subscriptions,
        requests: async (id) => (await this.options.client.session(id)).requests,
        resolveRequest: async (id, requestId, input) =>
          (await this.options.client.resolveRequest(id, requestId, { ...input, resolvedBy: "session" })).request,
      };
      /**
       * THE SESSIONS WALL FOR CODEX, leased on the worker-hosted socket —
       * see `sessions-tools/run-socket.ts`. Bound only for a Codex claim:
       * Claude gets the same capability in-process, so a lease for it would
       * be a credential nobody redeems. Cached per SESSION like the browser's
       * lease and revoked in `stop()`.
       */
      let sessionsLease = this.sessionsLeases.get(sessionId);
      if (!sessionsLease && driverKind === "codex" && this.options.sessionsSocket) {
        sessionsLease = await this.options.sessionsSocket.bind(sessionsCapability);
        this.sessionsLeases.set(sessionId, sessionsLease);
      }
      const result = await driver.run({
        prompt,
        sessionId,
        cwd,
        signal: controller.signal,
        // Spread rather than passed as possibly-undefined: `exactOptionalPropertyTypes`
        // distinguishes "absent" from "present and undefined", and the drivers
        // read absence as "use the provider's own default".
        ...(model?.model ? { model: model.model } : {}),
        ...(model?.effort ? { effort: model.effort } : {}),
        ...(model?.fastMode === undefined ? {} : { fastMode: model.fastMode }),
        // Both arrive ON THE CLAIM, resolved by the engine, for the same reason
        // everything else here does: the worker holds no store handle and must
        // not look anything up between claim and execution.
        ...(claim.turn.attachments?.length ? { attachments: claim.turn.attachments } : {}),
        ...(claim.mcpServers?.length ? { mcpServers: claim.mcpServers } : {}),
        ...(claim.tasks?.length ? { tasks: claim.tasks } : {}),
        // WHICH LOGIN THIS RUNS AS. Derived here rather than on the claim
        // because it is a fact about spawning a process, and the worker is the
        // process that spawns one — the engine's job was to resolve WHICH
        // instance, which it did. An older engine sends no instance at all, and
        // absence means "run exactly as this worker's own environment does",
        // which is what every session did before the registry existed.
        ...(claim.providerInstance ? { env: providerProcessEnv(claim.providerInstance) } : {}),
        // WHICH BINARY, as opposed to what it inherits. A login may pin its own
        // — a beta build, a second install — and the driver must spawn that one
        // rather than the driver's default, or the settings pane would be
        // describing an executable no turn ever runs.
        ...(claim.providerInstance?.binaryPath ? { binaryPath: claim.providerInstance.binaryPath } : {}),
        // WHICH LOGIN, by id. Not spent on spawning anything — it is what lets a
        // warp agent's task row name whose account ran it, which the contract
        // requires of any row that names a model at all.
        providerInstanceId: claim.providerInstanceId,
        providerSessionId,
        // Send-now deliveries land here; how the driver injects them is its
        // own affair (Claude at turn boundaries, Codex mid-turn).
        steer,
        // The browser rides the worker's socket; the driver only learns where
        // and with which credential. Spread on the same absent-means-absent
        // rule as everything above it.
        ...(lease ? { browserSocket: { url: lease.url, token: lease.token } } : {}),
        /**
         * THE SPOOL, SCOPED TO THIS TURN'S PROJECT.
         *
         * Assembled here, per run, because the scope IS the run's: `claim.project`
         * is the project's own label, and it is what a spool item's `project`
         * field is compared against. Absent leaves the capability unscoped, which
         * is the project-less master's view — and the claim's own comment says
         * why absence means that rather than "no items".
         *
         * EVERY VERB GOES BACK THROUGH THE CLIENT, so the toolkit exercises the
         * same routes the queue does and there is exactly one implementation of
         * every rule about an item.
         */
        spool: {
          ...(claim.project ? { project: claim.project } : {}),
          snapshot: () => this.options.client.spool(),
          item: (id) =>
            this.options.client.spoolItem(id).catch(() => null),
          create: async (input) => (await this.options.client.createSpoolItem(input)).item,
          update: async (id, patch) => (await this.options.client.updateSpoolItem(id, patch)).item,
          consult: (id) => this.options.client.consultSpoolExpert(id),
          // The work-state verbs, through the same client for the same reason:
          // one implementation of every rule, already under test.
          map: () => this.options.client.spoolMap(),
          openThread: async (subject, input) => (await this.options.client.openSpoolThread(subject, input)).thread,
          setWaiting: async (subject, threadId, waiting) =>
            (await this.options.client.setSpoolThreadWaiting(subject, threadId, waiting)).thread,
          settle: async (subject, threadId, answer) =>
            (await this.options.client.settleSpoolThread(subject, threadId, answer)).thread,
          answer: async (itemId, question, answer) =>
            (await this.options.client.answerSpoolQuestion(itemId, question, answer)).item,
          focus: () => this.options.client.spoolFocus(),
          setFocus: async (input) => (await this.options.client.openSpoolFocus(input)).focus,
          endFocus: async (id, end) => (await this.options.client.closeSpoolFocus(id, end)).focus,
          // Loop 1's verbs reach every session the same way the rest do. The
          // reconcile itself is the engine's — deterministic, pull-only — so a
          // scoped session glancing at its own subject spends nothing and can
          // start nothing.
          look: async (subjectKey) => (await this.options.client.reconcileSpoolLook(subjectKey)).look,
          setTerrain: async (subjectKey, terrain) =>
            (await this.options.client.setSpoolSubjectTerrain(subjectKey, terrain)).subject,
          setIdentity: async (subjectKey, patch) =>
            (await this.options.client.setSpoolSubjectIdentity(subjectKey, patch)).subject,
          // Chat and hand share one slot / one record: both of these go through
          // the same routes the room's own controls PUT and PATCH, so there is
          // exactly one implementation of the view and of the clamp.
          setAperture: async (view) => (await this.options.client.setSpoolAperture(view)).aperture,
          setAreaPermits: async (name, ceiling) =>
            (await this.options.client.setSpoolAreaCeiling(name, ceiling)).area,
          // The shelf and the search, through the same client for the same
          // reason as everything above: one implementation of every rule.
          // The toolkit's own handler declares `author: "session"` on create;
          // the capability forwards it verbatim, exactly as `create.source`.
          notes: async () => (await this.options.client.spoolNotes()).notes,
          createNote: async (input) => (await this.options.client.createSpoolNote(input)).note,
          updateNote: async (id, patch) => (await this.options.client.updateSpoolNote(id, patch)).note,
          search: async (query, subject) =>
            (await this.options.client.spoolSearch(query, subject ? { subject } : {})).hits,
        },
        // The sessions toolkit, hoisted above — one assembly, two consumers.
        sessions: sessionsCapability,
        // The sessions wall over HTTP, for the provider that takes servers as
        // config. Same absent-means-absent rule as `browserSocket`.
        ...(sessionsLease ? { sessionsSocket: { url: sessionsLease.url, token: sessionsLease.token } } : {}),
        /**
         * THE KERNEL, WHEN THE CLAIM SAYS THE PROJECT OPTED IN. Every verb is
         * an HTTP call to the daemon, which owns the kernel — the worker holds
         * no process and no store, exactly as with the spool. Absent on the
         * claim means absent here, and the driver registers no toolkit.
         */
        ...(claim.dataScience ? { ds: clientDsCapability(this.options.client, sessionId) } : {}),
        // The compile door, same shape: HTTP to the daemon, which owns the jobs.
        ...(claim.latex ? { latex: clientLatexCapability(this.options.client, sessionId) } : {}),
        /**
         * `display_open` — show the human one file in the cockpit. The fence
         * is this turn's own checkout; the report rides the same observation
         * channel as everything else the worker sees, so the engine journals
         * it under this turn and a stop refuses it like any late report.
         */
        display: createDisplayCapability({
          cwd,
          report: (observation) =>
            this.options.client
              .reportObservations(sessionId, runId, claimToken, [{ kind: "display.opened", ...observation }])
              .then(() => undefined),
        }),
        onRequest: askEngine,
        onObservations: async (observations) => {
          // A stop is terminal the moment the engine records it, and the
          // driver may still be mid-message when the abort lands. Reporting
          // after that point would append rows to a turn that is already
          // settled, which the store rejects as a conflict — so drop them
          // here rather than turning a clean stop into a failure.
          if (controller.signal.aborted) return;
          await this.options.client.reportObservations(sessionId, runId, claimToken, observations);
        },
        /**
         * THE SESSION'S DOOR FOR WHAT HAPPENS BETWEEN TURNS. The driver keeps
         * reading the provider process after this turn settles; task frames
         * come back through `onTasks` with no claim, and a turn the CLI
         * starts on its own is opened as a PROVIDER TURN — a real turn under
         * a claim this worker holds, with a gate and a sink of its own, so a
         * wake-up's tool calls are decided by a human rather than refused
         * against this turn's settled claim.
         */
        session: {
          onTasks: (observations) =>
            this.options.client.reportSessionTasks(sessionId, this.options.workerId, observations).then(() => undefined),
          onProviderTurn: async ({ input, reason }) => {
            let opened: { turn: { runId: string; claim?: { token: string } } };
            try {
              opened = await this.options.client.openProviderTurn(sessionId, { workerId: this.options.workerId, input, reason });
            } catch (error) {
              // A live turn already has the session: the wake-up's frames
              // are that turn's stream. Anything else is a real failure.
              if (error instanceof EngineClientError && error.code === "conflict") return undefined;
              throw error;
            }
            const providerRunId = opened.turn.runId;
            const providerToken = opened.turn.claim!.token;
            const providerController = new AbortController();
            this.active.set(providerToken, providerController);
            const bound = this.bindTurn(sessionId, providerRunId, providerToken, providerController);
            // The browser's per-turn gate now answers to THIS turn's claim.
            const cached = this.browserLeases.get(sessionId);
            if (cached) {
              cached.refs.gate = bound.gate;
              cached.refs.onNavigated = bound.onNavigated;
              cached.refs.fillSecret = bound.fillSecret;
            }
            return {
              runId: providerRunId,
              onRequest: bound.askEngine,
              onObservations: async (observations) => {
                if (providerController.signal.aborted) return;
                await this.options.client.reportObservations(sessionId, providerRunId, providerToken, observations);
              },
              close: async (result) => {
                this.active.delete(providerToken);
                if (providerController.signal.aborted) return;
                try {
                  if ("failure" in result) {
                    await this.options.client.failTurn(sessionId, providerRunId, providerToken, { code: "driver_failed", message: result.failure });
                  } else {
                    await this.options.client.completeTurn(sessionId, providerRunId, providerToken, {
                      text: result.text,
                      ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
                      ...(result.usage ? { usage: result.usage } : {}),
                    });
                  }
                } catch (error) {
                  if (!(error instanceof EngineClientError && error.code === "conflict")) throw error;
                }
              },
            };
          },
        },
      });
      // Drained BEFORE the turn settles. A state read still in flight would
      // otherwise report against a turn the engine has already closed, which
      // it rejects as a conflict — the guarantee the old in-driver queue gave.
      await lease?.drain();
      if (!controller.signal.aborted) {
        // Retried as ITSELF on a lost response — the turn completed, and that
        // is what the engine must end up holding.
        await this.settle({
          sessionId,
          runId,
          claimToken,
          operation: "completeTurn",
          send: (signal) =>
            this.options.client.completeTurn(
              sessionId,
              runId,
              claimToken,
              {
                text: result.text,
                ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
              },
              signal,
            ),
        });
      } else if (this.shuttingDown) {
        // A DRIVER THAT RETURNS ON ABORT REACHES HERE, NOT THE CATCH — and
        // that is most of them: aborting a well-behaved driver unwinds it
        // cleanly, so the run resolves rather than throwing and the catch
        // below never sees it. Missing this was why a first pass at recording
        // the interruption changed nothing at all.
        await this.recordInterruption(sessionId, runId, claimToken);
      }
    } catch (error) {
      /**
       * A SHUTDOWN SAYS SO; A STOP STAYS SILENT.
       *
       * Both arrive as an aborted signal, and the old single branch treated
       * them alike — returning without settling. For a human Stop that is
       * right: the engine wrote `stopped` before the worker heard about it,
       * and `failTurn` would be overwriting a settled truth with an error.
       * For a shutdown nothing was written at all, and the silence is what
       * left the turn `running` for the next boot to call `ambiguous`.
       *
       * WHAT `interrupted` CLAIMS, EXACTLY: this turn was cut off. NOT that it
       * did nothing — whatever it had already run is already in the world, and
       * the message says so rather than inviting a blind replay.
       */
      if (this.shuttingDown && controller.signal.aborted) {
        await this.recordInterruption(sessionId, runId, claimToken);
        return;
      }
      // Stop is terminal before a worker sees the heartbeat. Never overwrite it with an error.
      if (controller.signal.aborted || (error instanceof EngineClientError && error.code === "conflict")) return;
      if (isConnectivityLoss(error)) {
        /**
         * THE ORIGINAL ERROR IS CLASSIFIED FIRST. A pre-settlement fault
         * (`markTurnRunning`, an observation report) that was a REVOCATION must
         * revoke this worker — otherwise a successful `failTurn` afterwards
         * would bury the engine's verdict and the worker would carry on. Its
         * diagnostic is recorded against the operation that actually failed,
         * not against the settle that followed.
         */
        this.noteConnectivityFailure(error);
        // The turn produced no outcome, so `interrupted` is the honest one; a
        // terminal settlement that lost its response never reaches here.
        await this.settle({
          sessionId,
          runId,
          claimToken,
          operation: "failTurn",
          send: (signal) =>
            this.options.client.failTurn(
              sessionId,
              runId,
              claimToken,
              {
                code: "interrupted",
                message: "Telar's worker lost contact with the engine before this turn produced a result. What it had already done is above; whether it had finished anything elsewhere is unknown.",
              },
              signal,
            ),
        });
        return;
      }
      const failure =
        error instanceof ProviderUnavailableError || error instanceof UnsupportedDriverError
          ? { code: "provider_unavailable" as const, message: error.message }
          : { code: "driver_failed" as const, message: error instanceof Error ? error.message : "Telar driver failed" };
      await this.settle({
        sessionId,
        runId,
        claimToken,
        operation: "failTurn",
        send: (signal) => this.options.client.failTurn(sessionId, runId, claimToken, failure, signal),
      });
    } finally {
      // The lease is deliberately NOT released here — it is the session's
      // now (see the cache above), revoked in `stop()` alongside the
      // provider processes that hold its token.
      steer.close();
      // An undrained delivery was never delivered: forget it here so the
      // heartbeat's re-carry (after the engine's sweep requeues it) is not
      // skipped by the pushed-set.
      for (const ack of steerEntry.pendingAck.splice(0)) this.pushedSteers.delete(ack.steerRunId);
      this.steering.delete(claimToken);
      this.active.delete(claimToken);
      this.activeClaims.delete(claimToken);
    }
  }

  /**
   * EVERYTHING A TURN'S CLAIM BINDS, built once per claim: the engine gate
   * (`askEngine`), and the browser socket's per-turn gate, navigation sink
   * and secret fill on top of it. Extracted so a PROVIDER turn (a wake-up the
   * driver reads between turns) gets exactly the gate a human turn gets —
   * its tool calls decided under its own claim, never refused against a
   * settled one.
   */
  private bindTurn(sessionId: string, runId: string, claimToken: string, controller: AbortController) {
    /**
     * ONE LINE PER TURN when the engine refuses a tool request because the
     * turn already settled. This is the signature of the premature-completion
     * bug (a `result` consumed while tool calls were still running): every
     * refusal after the first says nothing new, and the driver already turns
     * each into a deny the model can read — but with zero log lines the
     * failure was undiagnosable from the daemon log alone.
     */
    let lateRefusalLogged = false;
    const askEngine = async ({ kind, detail, toolUseId }: DriverRequest): Promise<DriverRequestOutcome> => {
      const requestId = `req_${toolUseId.replace(/[^A-Za-z0-9_-]/g, "")}`;
      const opened = await this.options.client.openRequest(sessionId, runId, claimToken, {
        requestId,
        kind,
        detail,
      }).catch((error: unknown) => {
        if (!lateRefusalLogged && error instanceof EngineClientError && error.code === "conflict") {
          lateRefusalLogged = true;
          console.error(`[worker] tool request refused for ${runId}: ${error.message}`);
        }
        throw error;
      });
      // Auto-resolved by the session's runtime mode — no human involved,
      // no wait. This is the common path in a detached session. (`user_input`
      // never auto-resolves — no mode can invent a human's answer.)
      if (opened.state === "resolved") return { decision: opened.decision };

      // Parked. Wait for the heartbeat to carry an answer, or for the turn
      // to be aborted. ABORT MUST SETTLE THIS PROMISE: a stop arriving
      // while a human is deciding would otherwise leave the driver blocked
      // forever inside canUseTool, and the turn would never end.
      return new Promise<DriverRequestOutcome>((resolve) => {
        // The runId in the key mirrors the heartbeat's settle lookup — see
        // `tick()` for why request-only keying breaks under concurrency.
        this.awaiting.set(`${runId}:${requestId}`, resolve);
        const onAbort = () => {
          if (!this.awaiting.delete(`${runId}:${requestId}`)) return;
          resolve({ decision: "cancel" });
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    /**
     * THIS TURN'S gate and observation sink — swapped into the session's
     * long-lived browser binding. Both close over this turn's claim, which
     * is why the binding itself cannot capture them.
     */
    const gate: NonNullable<BrowserRunBinding["gate"]> = async ({ name, args, readOnly }) => {
      const { decision } = await askEngine({
        // A CLASSIFICATION, NOT A BYPASS — the same rule TELAR_READ_TOOLS
        // states in driver.ts. A read-only browser call changes nothing,
        // so it is declared as a read and the mode ladder's existing
        // auto-accept does its job; a mutation stays `tool_call` and
        // parks where the mode says to park.
        kind: readOnly ? "file_read" : "tool_call",
        // The QUALIFIED name, so the approval and the timeline row name
        // the same tool. A client shortens it for display
        // (`displayToolName`); the data does not lie about which server
        // it belongs to.
        detail: {
          kind: "tool_call",
          call: { name: qualifyTelarTool(name, TELAR_BROWSER_MCP_SERVER), server: TELAR_BROWSER_MCP_SERVER, input: args },
        },
        toolUseId: `${TELAR_BROWSER_MCP_SERVER}_${name}_${crypto.randomUUID().slice(0, 8)}`,
      });
      return decision === "accept" || decision === "acceptForSession";
    };
    const onNavigated: NonNullable<BrowserRunBinding["onNavigated"]> = async (state) => {
      // A stop is terminal the moment the engine records it — same guard
      // as `onObservations`, for the same conflict.
      if (controller.signal.aborted) return;
      await this.options.client
        .reportObservations(sessionId, runId, claimToken, [{ kind: "browser.state", provider: state.provider, tabs: state.tabs }])
        .catch(() => undefined);
    };
    /**
     * `browser_fill_secret`, wired per turn like the gate: the orchestrator
     * gets the socket's own scope-bound browser, the `op` adapter, and an
     * `ask` that opens a `secret_access` request through the SAME askEngine
     * as every other gate — so an abort settles it, and the heartbeat
     * carries back the human's item pick in `answers.item`. The values live
     * inside `runSecretFill` and the fill call it makes; nothing of them
     * reaches this closure's return value or the journal.
     */
    const fillSecret: NonNullable<BrowserRunBinding["fillSecret"]> = (args, callBrowser, profile) =>
      runSecretFill(
        {
          callBrowser,
          secrets: this.options.secrets ?? (this.secrets ??= createOnePasswordSecrets()),
          ...(profile ? { profile } : {}),
          ...(this.options.loginGrants ? { grants: this.options.loginGrants } : {}),
          ask: async (secret) => {
            const outcome = await askEngine({
              kind: "secret_access",
              detail: { kind: "secret_access", secret },
              toolUseId: `${TELAR_BROWSER_MCP_SERVER}_fill_secret_${crypto.randomUUID().slice(0, 8)}`,
            });
            const item = outcome.answers?.item;
            return {
              decision: outcome.decision,
              ...(typeof item === "string" ? { itemId: item } : {}),
              // The card's opt-in. Only ever TRUE because a person ticked a box
              // that starts unchecked — no mode and no default can produce it.
              ...(outcome.answers?.remember === true ? { remember: true } : {}),
            };
          },
        },
        args,
      );
    return { askEngine, gate, onNavigated, fillSecret };
  }

  private driverFor(kind: ProviderDriverKind): TurnDriver {
    const selector = this.options.driver;
    if (typeof selector !== "function") return selector;
    const driver = selector(kind);
    if (!driver) throw new UnsupportedDriverError(kind);
    return driver;
  }

  private loseConnection(reason: unknown): void {
    if (this.connectionLost) return;
    this.connectionLost = true;
    this.diagnose({ event: "connection_lost", ...EngineWorker.describe(reason), outageMs: this.now() - this.lastAckAt });
    for (const controller of this.active.values()) controller.abort(reason instanceof Error ? reason : new Error("engine connectivity lost"));
    this.options.onConnectionLost?.();
  }
}

/**
 * The project folder a provider would be spawned in must be a readable
 * directory NOW. Thrown as a `driver_failed` message that names the path and
 * the likely cause, so a moved checkout reads as "the folder is gone", never
 * as a broken binary.
 */
export function assertProjectRoot(cwd: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `The project folder ${cwd} does not exist. It may have been moved or deleted; re-register the project with its current location (or restore the folder) and retry.`
        : `The project folder ${cwd} cannot be accessed (${code ?? "unknown error"}). Check its permissions and retry.`,
    );
  }
  if (!stat.isDirectory()) throw new Error(`The project path ${cwd} is not a folder. Re-register the project with its checkout directory and retry.`);
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`The project folder ${cwd} is not readable by this user. Check its permissions and retry.`);
  }
}

function isConnectivityLoss(error: unknown): boolean {
  // A restarted daemon can reuse a port (old capability becomes unauthorized)
  // or forget this worker registration; neither permits stale provider work to
  // continue under the old control-plane lease.
  return (
    error instanceof EngineClientError &&
    (error.code === "engine_unavailable" || error.code === "engine_unauthorized" || error.code === "worker_unavailable")
  );
}
