import type { WorkerClaim } from "@telar/engine-client";
import { HttpError } from "../platform/http/http";
import { stringValue } from "../platform/http/params";
import type { EngineStore } from "../state";
import type { ExecutionPort } from "./execution-port";

/**
 * `claimSeq` is a per-registration high-watermark, not a cache key: equal replays the cached outcome
 * (including "nothing to claim"), older is refused without allocating, only the next number allocates.
 */
type RegisteredWorker = {
  workerId: string;
  registeredAt: number;
  heartbeatAt: number;
  claimSeq: number;
  claimResult: WorkerClaim | undefined;
  claimBusy: Promise<void> | undefined;
};

type RegistryOptions = { now: () => number; leaseMs: number; onRetired?: (workerId: string) => void };

export function createWorkerRegistry(store: EngineStore, { now, leaseMs, onRetired }: RegistryOptions) {
  const workers = new Map<string, RegisteredWorker>();
  // Only the registration our own supervisor made is lease-exempt; an HTTP client cannot opt in by choosing an id.
  let embedded: RegisteredWorker | undefined;

  // The one door out: dropping a registration and ending the claims it held are one event. Idempotent.
  const retire = (workerId: string): void => {
    workers.delete(workerId);
    store.recovery.retireWorkerRegistration(workerId);
    onRetired?.(workerId);
  };
  // The backstop for a worker that died without saying so.
  const prune = (): void => {
    for (const worker of workers.values()) {
      if (worker !== embedded && now() - worker.heartbeatAt > leaseMs) retire(worker.workerId);
    }
  };
  const active = (workerId: string): RegisteredWorker => {
    prune();
    const worker = workers.get(workerId);
    if (!worker) throw new HttpError(503, "worker_unavailable", "worker is not registered or its lease expired");
    return worker;
  };

  const registration: Pick<ExecutionPort, "registerWorker" | "workerHeartbeat" | "claimTurn"> = {
    registerWorker: async (workerId) => {
      stringValue(workerId, "worker id");
      if (!/^[A-Za-z0-9_-]+$/.test(workerId)) throw new HttpError(400, "invalid_request", "worker id is unsafe");
      prune();
      if (workers.has(workerId)) throw new HttpError(409, "conflict", "worker id is already registered");
      const at = now();
      workers.set(workerId, { workerId, registeredAt: at, heartbeatAt: at, claimSeq: 0, claimResult: undefined, claimBusy: undefined });
      return { worker: { workerId }, heartbeatIntervalMs: Math.max(50, Math.floor(leaseMs / 3)) };
    },
    workerHeartbeat: async (workerId, _signal, acknowledgedTaskStops) => {
      const worker = active(workerId);
      worker.heartbeatAt = now();
      return {
        workerId,
        heartbeatAt: worker.heartbeatAt,
        cancel: store.recovery.cancellationsForWorker(workerId),
        resolved: store.requestGate.resolutionsForWorker(workerId),
        steer: store.worker.steerForWorker(workerId),
        stopTask: store.sessionTasks.stopsForWorker(workerId, acknowledgedTaskStops),
      };
    },
    claimTurn: async (workerId, seq) => {
      const worker = active(workerId);
      worker.heartbeatAt = now();
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
        throw new HttpError(400, "invalid_request", "claim sequence must be a positive integer");
      }
      // One claim at a time per worker, so the authorize await cannot interleave a duplicate.
      const previous = worker.claimBusy ?? Promise.resolve();
      let release!: () => void;
      worker.claimBusy = new Promise<void>((resolve) => (release = resolve));
      await previous;
      try {
        if (active(workerId) !== worker) throw new HttpError(503, "worker_unavailable", "worker registration retired");
        if (seq === worker.claimSeq) return { claim: worker.claimResult };
        if (seq < worker.claimSeq) throw new HttpError(409, "conflict", "claim sequence superseded");
        if (seq !== worker.claimSeq + 1) throw new HttpError(400, "invalid_request", "claim sequence out of order");
        // The claim is synchronous under the state lock; attaching OAuth bearers is a network call.
        const claimed = store.claims.claimNextTurn(workerId);
        const authorized = claimed ? await store.mcpOAuth.authorizeClaim(claimed) : undefined;
        if (active(workerId) !== worker) throw new HttpError(503, "worker_unavailable", "worker registration retired");
        worker.claimSeq = seq;
        worker.claimResult = authorized;
        return { claim: authorized };
      } finally {
        release();
      }
    },
  };

  return {
    registration,
    retire,
    prune,
    active,
    requireAny(): void {
      prune();
      if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
    },
    health() {
      prune();
      const first = workers.values().next().value;
      return first ? { registered: true, workerId: first.workerId, activeWorkers: workers.size } : { registered: false, activeWorkers: 0 };
    },
    /** Marks the supervisor's own registration lease-exempt, or clears it when that generation stops. */
    setEmbedded(workerId: string | undefined): void {
      if (workerId === undefined) embedded = undefined;
      else embedded = workers.get(workerId);
    },
    embeddedId: () => embedded?.workerId,
  };
}
