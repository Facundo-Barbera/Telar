import type { ProviderDriverKind, WorkerClaim } from "@telar/engine-client";
import { EngineClientError } from "@telar/engine-client";
import { createOnePasswordSecrets, type SecretsProvider } from "../domains/browser";
import { ratifiedReadTools } from "../domains/plugins";
import { setPluginReadTools } from "../drivers/claude";
import type { DriverRequestOutcome, TurnDriver } from "../drivers";
import { defaultWorkerConcurrency } from "./concurrency";
import { executeClaim } from "./execute";
import type { Settlement, TurnHost } from "./host";
import { describeError, isConnectivityLoss, isRevocation, isTimeout, leaseExpired, WorkerLease } from "./lease";
import { UnsupportedDriverError, type EngineWorkerOptions, type WorkerDiagnostic } from "./options";

type Heartbeat = Awaited<ReturnType<EngineWorkerOptions["client"]["workerHeartbeat"]>>;

/** Inline re-sends for a settlement whose response was lost; after these it is retained. */
const SETTLE_ATTEMPTS = 5;
const SETTLE_BACKOFF_MS = 250;
/** Consecutive failed heartbeats that make an exempt worker's connection lost. */
const EXEMPT_FAILURE_LIMIT = 5;
const SETTLE_RETRY_MIN_MS = 250;
const SETTLE_RETRY_MAX_MS = 30_000;
/** Hysteresis, so the pause between two messages does not count as idle. */
const QUIET_TICKS_BEFORE_BACKOFF = 5;

/** An executor only: every observable lifecycle event travels back through the engine API. */
export class EngineWorker {
  private readonly pluginsLookedFor = new Set<string>();
  private readonly pollMs: number;
  private readonly idlePollMs: number;
  private intervalMs: number;
  private quietTicks = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Evaluates the lease deadline even while a request is hung. */
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  /** Tells a shutdown from a human Stop: both look identical on an AbortSignal and settle differently. */
  private shuttingDown = false;
  private stopReason: "shutdown" | "connection_lost" = "shutdown";
  /** Executions rather than settles: the abort unwinds `execute` a microtask after `stop()` looks. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly usedDrivers = new Set<TurnDriver>();
  private readonly shutdownSettleMs = 2_000;
  private readonly active = new Map<string, AbortController>();
  private readonly activeClaims = new Set<string>();
  private connectionLost = false;
  private readonly lease: WorkerLease;
  private readonly acknowledgedTaskStops = new Set<string>();
  private readonly stoppingTasks = new Set<string>();
  /** The exempt worker's liveness: attempts, not seconds, so sleep and stalls cannot expire it. */
  private heartbeatFailures = 0;
  /** Advances only on a definitive answer; a retry re-sends `pendingClaimSeq` so the engine replays. */
  private claimSeq = 0;
  private pendingClaimSeq: number | undefined;
  private claiming = false;
  /** One diagnostic line per outage rather than per tick. */
  private outageReported = false;
  private secrets: SecretsProvider | undefined;
  private readonly awaiting: TurnHost["awaiting"] = new Map<string, (outcome: DriverRequestOutcome) => void>();
  private readonly steering: TurnHost["steering"] = new Map();
  private readonly pushedSteers = new Set<string>();
  private readonly browserLeases: TurnHost["browserLeases"] = new Map();
  private readonly liveClaims: TurnHost["liveClaims"] = new Map();
  private readonly providerTurnsWanted = new Map<string, AbortController>();
  private readonly telarLeases: TurnHost["telarLeases"] = new Map();
  private readonly stopDeliveredAt = new Map<string, number>();
  /** Terminal settlements the engine has not acknowledged, by runId. */
  private readonly pendingSettlements = new Map<string, Settlement & { since: number; rounds: number; nextAttemptAt: number }>();
  private draining = false;
  private readonly host: TurnHost;

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollMs = options.pollMs ?? 100;
    this.idlePollMs = Math.max(this.pollMs, options.idlePollMs ?? 0);
    this.intervalMs = this.pollMs;
    this.lease = new WorkerLease(options.leaseExempt === true, () => this.now());
    this.host = {
      options,
      active: this.active,
      activeClaims: this.activeClaims,
      awaiting: this.awaiting,
      steering: this.steering,
      pushedSteers: this.pushedSteers,
      browserLeases: this.browserLeases,
      telarLeases: this.telarLeases,
      liveClaims: this.liveClaims,
      providerTurnsWanted: this.providerTurnsWanted,
      stopDeliveredAt: this.stopDeliveredAt,
      pluginsLookedFor: this.pluginsLookedFor,
      stopped: () => this.stopped,
      shuttingDown: () => this.shuttingDown,
      settle: (entry) => this.settle(entry),
      recordInterruption: (sessionId, runId, claimToken) => this.recordInterruption(sessionId, runId, claimToken),
      noteConnectivityFailure: (error) => this.noteConnectivityFailure(error),
      driverFor: (kind) => this.driverFor(kind),
      diagnose: (fields) => this.diagnose(fields),
      now: () => this.now(),
      secrets: () => this.options.secrets ?? (this.secrets ??= createOnePasswordSecrets()),
    };
  }

  async start(): Promise<void> {
    const startedAt = this.now();
    this.lease.lastAckAt = startedAt;
    // An out-of-process worker does not share the daemon's globals, so it ratifies from the same manifests.
    try {
      const health = await this.options.client.health();
      setPluginReadTools((health.plugins ?? []).flatMap((status) => ratifiedReadTools(status.meta)));
    } catch {
      // Left empty, so every plugin tool asks.
    }
    const registration = await this.options.client.registerWorker(this.options.workerId);
    if (this.stopped) return;
    this.lease.adopt(registration?.heartbeatIntervalMs);
    this.lease.lastAckAt = startedAt;
    this.watchdog = setInterval(() => this.checkLease(), Math.max(10, Math.floor((this.lease.ms ?? this.pollMs) / 3)));
    this.watchdog.unref?.();
    this.diagnose({ event: "worker_registered", operation: "registerWorker" });
    await this.tick();
    if (this.stopped) {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = undefined;
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.retune();
  }

  /** Slows the loop while nothing rides the heartbeat; the lease budget is unchanged. */
  private retune(): void {
    if (this.idlePollMs === this.pollMs || !this.timer) return;
    const wanted = this.quietTicks >= QUIET_TICKS_BEFORE_BACKOFF ? this.idlePollMs : this.pollMs;
    if (wanted === this.intervalMs) return;
    clearInterval(this.timer);
    this.intervalMs = wanted;
    this.timer = setInterval(() => void this.tick(), wanted);
  }

  /** Called in-process when the queue changes, so a backed-off worker beats immediately. */
  wake(): void {
    if (this.stopped || this.connectionLost) return;
    const wasSlow = this.intervalMs !== this.pollMs;
    this.quietTicks = 0;
    this.retune();
    if (wasSlow) void this.tick();
  }

  /** A Stop delivered in-process rather than discovered on the next heartbeat. Idempotent. */
  cancelClaims(cancellations: Array<{ claimToken: string; workerId: string }>): void {
    if (this.stopped) return;
    for (const cancellation of cancellations) {
      if (cancellation.workerId !== this.options.workerId) continue;
      this.abortClaim(cancellation.claimToken, "push");
    }
  }

  private abortClaim(claimToken: string, route: "push" | "heartbeat"): void {
    const controller = this.active.get(claimToken);
    if (!controller || controller.signal.aborted) return;
    this.stopDeliveredAt.set(claimToken, this.now());
    this.diagnose({ event: "turn_stop_delivered", operation: route });
    controller.abort(new Error("turn stopped"));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** On its own timer, so a hung request cannot suppress it. */
  private checkLease(): void {
    if (this.stopped || this.connectionLost || this.options.leaseExempt || this.lease.ms === undefined) return;
    if (this.lease.expired()) this.loseConnection(leaseExpired());
  }

  /** `connection_lost` means this worker is being replaced; the daemon may be alive. */
  async stop(reason: "shutdown" | "connection_lost" = "shutdown"): Promise<void> {
    this.stopReason = reason;
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Settles are awaited because the daemon closes its HTTP server as soon as this resolves.
    this.shuttingDown = true;
    for (const controller of this.active.values()) controller.abort(new Error("worker stopped"));
    // Bounded: a settle that misses leaves the turn `running`, which recovers as `ambiguous`.
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled(this.inFlight),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.shutdownSettleMs).unref?.();
        }),
      ]);
    }
    for (const { lease } of this.browserLeases.values()) lease.release();
    this.browserLeases.clear();
    this.liveClaims.clear();
    this.providerTurnsWanted.clear();
    for (const entry of this.telarLeases.values()) entry.lease?.release();
    this.telarLeases.clear();
    if (typeof this.options.driver !== "function") this.usedDrivers.add(this.options.driver);
    for (const driver of this.usedDrivers) {
      try { driver.dispose?.(); } catch { /* continue closing the remaining providers */ }
    }
    this.usedDrivers.clear();
  }

  /** Claims only that the turn was cut off, never that it was harmless. */
  private async recordInterruption(sessionId: string, runId: string, claimToken: string): Promise<void> {
    await this.options.client
      .failTurn(sessionId, runId, claimToken, {
        code: "interrupted",
        message:
          this.stopReason === "connection_lost"
            ? "Telar's worker lost contact with the engine and was replaced while this turn was running. What it had already done is above; whether it had finished anything elsewhere is unknown."
            : "Telar shut down while this turn was running. What it had already done is above; whether it had finished anything elsewhere is unknown.",
      })
      // An engine already gone cannot be told; the next boot calls the turn `ambiguous`.
      .catch(() => undefined);
  }

  /**
   * Repeats the same terminal call until the engine holds it; `conflict` means it already does.
   * Exhausted attempts retain the settlement rather than touching the connection.
   */
  private async settle(entry: Settlement, attempts = SETTLE_ATTEMPTS): Promise<"settled" | "pending"> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.pause(SETTLE_BACKOFF_MS);
      if (this.stopped || this.connectionLost || this.lease.expired()) break;
      try {
        await entry.send(AbortSignal.timeout(this.lease.settleTimeoutMs()));
        if (attempt > 0 || this.pendingSettlements.has(entry.runId)) this.diagnose({ event: "turn_settled_late", operation: entry.operation });
        this.pendingSettlements.delete(entry.runId);
        return "settled";
      } catch (error) {
        if (error instanceof EngineClientError && error.code === "conflict") {
          this.pendingSettlements.delete(entry.runId);
          return "settled";
        }
        if (error instanceof EngineClientError && error.code === "not_found") {
          this.pendingSettlements.delete(entry.runId);
          this.diagnose({ event: "turn_settlement_vacated", operation: entry.operation, ...describeError(error) });
          return "settled";
        }
        const timedOut = isTimeout(error);
        if (!timedOut && !isConnectivityLoss(error)) {
          this.diagnose({ event: "turn_settlement_refused", operation: entry.operation, ...describeError(error) });
          break;
        }
        if (isRevocation(error)) {
          this.noteConnectivityFailure(error);
          this.diagnose({ event: "turn_settlement_refused", operation: entry.operation, ...describeError(error) });
          this.pendingSettlements.delete(entry.runId);
          return "pending";
        }
        if (!timedOut) this.noteConnectivityFailure(error);
      }
    }
    this.retain(entry);
    return "pending";
  }

  /** Never dropped on a retry count; spaced by a capped exponential. */
  private retain(entry: Settlement): void {
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

  /** Off the tick's await chain: hung settlements awaited there starve the lease. */
  private startDrain(): void {
    if (this.draining || this.pendingSettlements.size === 0 || this.stopped || this.connectionLost) return;
    this.draining = true;
    void (async () => {
      try {
        for (const entry of [...this.pendingSettlements.values()]) {
          if (this.stopped || this.connectionLost) return;
          if (this.now() < entry.nextAttemptAt) continue;
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

  /** Claims until the cap or the queue runs dry, off the tick's await chain. */
  private startClaiming(): void {
    if (this.claiming || this.stopped || this.connectionLost) return;
    this.claiming = true;
    void (async () => {
      try {
        const cap = Math.max(1, this.options.concurrency ?? defaultWorkerConcurrency());
        while (this.activeClaims.size < cap && !this.stopped && !this.connectionLost) {
          const seq = (this.pendingClaimSeq ??= this.claimSeq + 1);
          this.options.onClaimPhase?.("requested");
          let claim: WorkerClaim | undefined;
          try {
            claim = (await this.options.client.claimTurn(this.options.workerId, seq, AbortSignal.timeout(this.lease.requestTimeoutMs()))).claim;
          } catch (error) {
            const timedOut = isTimeout(error);
            if (!timedOut && !isConnectivityLoss(error)) throw error;
            this.diagnose({ event: "claim_unresolved", operation: "claimTurn", ...describeError(error) });
            if (!timedOut) this.noteConnectivityFailure(error);
            return;
          }
          this.claimSeq = seq;
          this.pendingClaimSeq = undefined;
          this.options.onClaimPhase?.("granted");
          if (!claim) return;
          // Left `claimed` on a shutdown: that proves no provider spawned, so the engine requeues it.
          if (this.stopped) return;
          this.options.onClaimPhase?.("starting");
          const run = executeClaim(this.host, claim);
          this.inFlight.add(run);
          void run.finally(() => this.inFlight.delete(run));
        }
      } catch {
        // A non-connectivity throw is this pump's own; the next tick retries.
      } finally {
        this.claiming = false;
        this.options.onClaimPhase?.("idle");
      }
    })();
  }

  private pause(ms: number): Promise<void> {
    return this.options.pause ? this.options.pause(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    const issuedAt = this.now();
    try {
      const acknowledged = [...this.acknowledgedTaskStops];
      const status = await this.options.client.workerHeartbeat(this.options.workerId, AbortSignal.timeout(this.lease.requestTimeoutMs()), acknowledged);
      for (const id of acknowledged) this.acknowledgedTaskStops.delete(id);
      if (this.stopped || this.connectionLost) return;
      // The deadline, not the flags: an expired reply must not resurrect a spent budget.
      if (this.lease.expired()) {
        this.loseConnection(leaseExpired());
        return;
      }
      this.lease.lastAckAt = issuedAt;
      this.heartbeatFailures = 0;
      if (this.outageReported) {
        this.diagnose({ event: "engine_reachable", operation: "workerHeartbeat" });
        this.outageReported = false;
      }
      this.startDrain();
      this.apply(status);
      this.startClaiming();
      const carried = status.cancel.length > 0 || status.resolved.length > 0 ||
        (status.steer?.length ?? 0) > 0 || (status.stopTask?.length ?? 0) > 0;
      const busy = this.active.size > 0 || this.inFlight.size > 0 || this.pendingSettlements.size > 0;
      this.quietTicks = carried || busy ? 0 : this.quietTicks + 1;
      this.retune();
    } catch (error) {
      if (isTimeout(error)) this.noteConnectivityFailure(new EngineClientError("engine_unavailable", "engine did not answer in time", undefined, { operation: "workerHeartbeat", transport: "timeout" }), issuedAt);
      else if (isConnectivityLoss(error)) this.noteConnectivityFailure(error, issuedAt);
      else throw error;
    } finally {
      this.ticking = false;
    }
  }

  /** What a heartbeat carried: stops, answered approvals, background-task kills and steers. */
  private apply(status: Heartbeat): void {
    for (const cancellation of status.cancel) this.abortClaim(cancellation.claimToken, "heartbeat");
    // Keyed by run and request: two providers can mint the same tool-use id.
    for (const resolution of status.resolved) {
      const settle = this.awaiting.get(`${resolution.runId}:${resolution.requestId}`);
      if (!settle) continue;
      this.awaiting.delete(`${resolution.runId}:${resolution.requestId}`);
      settle({ decision: resolution.decision, ...(resolution.answers ? { answers: resolution.answers } : {}) });
    }
    for (const kill of status.stopTask ?? []) {
      const id = kill.deliveryId ?? `${kill.sessionId}:${kill.providerTaskId}`;
      if (this.stoppingTasks.has(id) || this.acknowledgedTaskStops.has(id)) continue;
      const driver = this.driverFor(kill.driver ?? "claude");
      if (!driver.stopTask) continue;
      this.stoppingTasks.add(id);
      void driver.stopTask(kill.sessionId, kill.providerTaskId).then(() => {
        if (kill.deliveryId) this.acknowledgedTaskStops.add(kill.deliveryId);
      }).catch(() => {
        this.diagnose({ event: "task_stop_retry", operation: "stopTask" });
      }).finally(() => this.stoppingTasks.delete(id));
    }
    for (const delivery of status.steer ?? []) {
      if (this.pushedSteers.has(delivery.steerRunId)) continue;
      // A provider turn has no mailbox; the message tells it somebody wants the session.
      this.providerTurnsWanted.get(delivery.claimToken)?.abort();
      const entry = this.steering.get(delivery.claimToken);
      // Undeliverable here: the turn stays `steering` and the engine's sweep requeues it.
      if (
        !entry?.mailbox.push({
          text: delivery.text,
          ...(delivery.attachments?.length ? { attachments: delivery.attachments } : {}),
          ...(delivery.sender ? { sender: delivery.sender } : {}),
          ...(delivery.notice ? { notice: delivery.notice } : {}),
          ...(delivery.wakeReason ? { wakeReason: delivery.wakeReason } : {}),
          ...(delivery.notification ? { notification: delivery.notification } : {}),
        })
      )
        continue;
      this.pushedSteers.add(delivery.steerRunId);
      entry.pendingAck.push({ sessionId: delivery.sessionId, steerRunId: delivery.steerRunId, claimToken: delivery.claimToken });
    }
  }

  private diagnose(fields: WorkerDiagnostic): void {
    const sink = this.options.onDiagnostic;
    if (sink) {
      sink(fields);
      return;
    }
    process.stderr.write(`[worker] ${JSON.stringify({ workerId: this.options.workerId, ...fields })}\n`);
  }

  /**
   * Revocation is final at once. Unreachable is ridden out within the lease; an exempt worker
   * counts only heartbeat failures no older than the last success.
   */
  private noteConnectivityFailure(error: unknown, issuedAt?: number): void {
    if (this.stopped || this.connectionLost) return;
    const described = describeError(error);
    if (isRevocation(error)) {
      this.loseConnection(error);
      return;
    }
    if (this.options.leaseExempt) {
      if (issuedAt !== undefined && issuedAt < this.lease.lastAckAt) return;
      if (described.operation !== "workerHeartbeat") return;
      this.reportOutage(described);
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures >= EXEMPT_FAILURE_LIMIT) this.loseConnection(error);
      return;
    }
    if (this.lease.ms === undefined) {
      this.loseConnection(error);
      return;
    }
    this.reportOutage(described);
    this.checkLease();
  }

  private reportOutage(described: ReturnType<typeof describeError>): void {
    if (this.outageReported) return;
    this.outageReported = true;
    this.diagnose({ event: "engine_unreachable", ...described });
  }

  private driverFor(kind: ProviderDriverKind): TurnDriver {
    const selector = this.options.driver;
    const driver = typeof selector === "function" ? selector(kind) : selector;
    if (!driver) throw new UnsupportedDriverError(kind);
    this.usedDrivers.add(driver);
    return driver;
  }

  private loseConnection(reason: unknown): void {
    if (this.connectionLost) return;
    this.connectionLost = true;
    this.diagnose({ event: "connection_lost", ...describeError(reason), outageMs: this.now() - this.lease.lastAckAt });
    for (const controller of this.active.values()) controller.abort(reason instanceof Error ? reason : new Error("engine connectivity lost"));
    this.options.onConnectionLost?.();
  }
}
