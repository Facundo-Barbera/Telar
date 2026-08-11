import type { EngineClient } from "@telar/engine-client";
import { EngineClientError } from "@telar/engine-client";
import { ProviderUnavailableError, type TurnDriver } from "./driver";

type WorkerClient = Pick<
  EngineClient,
  "registerWorker" | "workerHeartbeat" | "claimTurn" | "markTurnRunning" | "appendTurnText" | "completeTurn" | "failTurn"
>;

export type EngineWorkerOptions = {
  client: WorkerClient;
  workerId: string;
  driver: TurnDriver;
  /** Short testable polling loop; production process supervision is outside this leaf. */
  pollMs?: number;
  /** Used by the process supervisor to rediscover a restarted daemon. */
  onConnectionLost?: () => void;
};

/** A worker is an executor only: every observable lifecycle event travels back through the engine API. */
export class EngineWorker {
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private readonly active = new Map<string, AbortController>();
  private connectionLost = false;

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollMs = options.pollMs ?? 100;
  }

  async start(): Promise<void> {
    await this.options.client.registerWorker(this.options.workerId);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort(new Error("worker stopped"));
  }

  /** Exposed for deterministic tests and embedded supervisors. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const status = await this.options.client.workerHeartbeat(this.options.workerId);
      for (const cancellation of status.cancel) this.active.get(cancellation.claimToken)?.abort(new Error("turn stopped"));
      if (this.active.size !== 0) return;
      const { claim } = await this.options.client.claimTurn(this.options.workerId);
      if (claim) {
        void this.execute(
          claim.sessionId,
          claim.projectRoot,
          claim.provider.sessionId,
          claim.turn.runId,
          claim.turn.claim!.token,
          claim.turn.text,
        );
      }
    } catch (error) {
      if (isConnectivityLoss(error)) this.loseConnection(error);
      else throw error;
    } finally {
      this.ticking = false;
    }
  }

  private async execute(sessionId: string, cwd: string, providerSessionId: string | undefined, runId: string, claimToken: string, prompt: string): Promise<void> {
    const controller = new AbortController();
    this.active.set(claimToken, controller);
    try {
      await this.options.client.markTurnRunning(sessionId, runId, claimToken);
      const result = await this.options.driver.run({
        prompt,
        cwd,
        signal: controller.signal,
        providerSessionId,
        onText: async (text) => this.options.client.appendTurnText(sessionId, runId, claimToken, text),
      });
      if (!controller.signal.aborted) await this.options.client.completeTurn(sessionId, runId, claimToken, result.text, result.providerSessionId);
    } catch (error) {
      // Stop is terminal before a worker sees the heartbeat. Never overwrite it with an error.
      if (controller.signal.aborted || (error instanceof EngineClientError && error.code === "conflict")) return;
      if (isConnectivityLoss(error)) {
        this.loseConnection(error);
        return;
      }
      const failure =
        error instanceof ProviderUnavailableError
          ? { code: "provider_unavailable" as const, message: error.message }
          : { code: "driver_failed" as const, message: error instanceof Error ? error.message : "vNext driver failed" };
      try {
        await this.options.client.failTurn(sessionId, runId, claimToken, failure);
      } catch (settleError) {
        if (!(settleError instanceof EngineClientError && settleError.code === "conflict")) throw settleError;
      }
    } finally {
      this.active.delete(claimToken);
    }
  }

  private loseConnection(reason: unknown): void {
    if (this.connectionLost) return;
    this.connectionLost = true;
    for (const controller of this.active.values()) controller.abort(reason instanceof Error ? reason : new Error("engine connectivity lost"));
    this.options.onConnectionLost?.();
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
