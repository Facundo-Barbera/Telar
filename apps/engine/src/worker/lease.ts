import { EngineClientError } from "@telar/engine-client";

const MAX_LEASE_MS = 120_000;
/** Exemption is from expiry, never from bounding a hung call. */
const EXEMPT_REQUEST_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 10_000;

export class WorkerLease {
  /** Three of the daemon's heartbeat intervals; undefined means no budget, so a failure is fatal. */
  ms: number | undefined;
  /** When the last acknowledged exchange started, so latency counts against the budget. */
  lastAckAt = Date.now();

  constructor(
    readonly exempt: boolean,
    private readonly now: () => number,
  ) {}

  adopt(heartbeatIntervalMs: number | undefined): void {
    if (typeof heartbeatIntervalMs === "number" && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
      this.ms = Math.min(heartbeatIntervalMs * 3, MAX_LEASE_MS);
    }
  }

  remaining(): number | undefined {
    if (this.exempt || this.ms === undefined) return undefined;
    return this.ms - (this.now() - this.lastAckAt);
  }

  /** An exempt worker never expires on elapsed time; it counts failed heartbeats instead. */
  expired(): boolean {
    if (this.exempt) return false;
    const remaining = this.remaining();
    return remaining !== undefined && remaining <= 0;
  }

  requestTimeoutMs(): number {
    return this.bounded(EXEMPT_REQUEST_TIMEOUT_MS);
  }

  settleTimeoutMs(): number {
    return this.bounded(SETTLE_TIMEOUT_MS);
  }

  private bounded(ceiling: number): number {
    return Math.max(1, Math.min(ceiling, this.remaining() ?? ceiling));
  }
}

export const leaseExpired = () =>
  new EngineClientError("engine_unavailable", "engine lease expired", undefined, { operation: "workerHeartbeat", transport: "lease_expired" });

export const isTimeout = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError";

export const isRevocation = (error: unknown) =>
  error instanceof EngineClientError && (error.code === "engine_unauthorized" || error.code === "worker_unavailable");

/** A restarted daemon can reuse a port or forget this worker; neither lets stale work continue. */
export function isConnectivityLoss(error: unknown): boolean {
  return isRevocation(error) || (error instanceof EngineClientError && error.code === "engine_unavailable");
}

/** The safe half of an EngineClientError, for diagnostics. */
export function describeError(error: unknown): { code?: string; status?: number; operation?: string; transport?: string } {
  if (!(error instanceof EngineClientError)) return {};
  return {
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.transport === undefined ? {} : { transport: error.transport }),
  };
}
