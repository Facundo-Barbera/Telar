import type { EngineClient } from "@telar/engine-client";
import type { EngineStore } from "../state";

export type ExecutionPort = Pick<EngineClient,
  | "registerWorker" | "workerHeartbeat" | "claimTurn" | "markTurnRunning"
  | "reportObservations" | "openRequest" | "completeTurn" | "failTurn"
  | "openProviderTurn" | "reportSessionTasks" | "ackSteer"
>;

type RegistrationPort = Pick<ExecutionPort, "registerWorker" | "workerHeartbeat" | "claimTurn">;

export function createExecutionPort(store: EngineStore, registration: RegistrationPort,
  assertWorker: (workerId: string) => unknown): ExecutionPort {
  return {
    ...registration,
    markTurnRunning: async (sessionId, runId, token) => ({ turn: store.turnLifecycle.markRunning(sessionId, runId, token) }),
    reportObservations: async (sessionId, runId, token, observations) => store.ingest.ingestObservations(sessionId, runId, token, observations),
    openRequest: async (sessionId, runId, token, input) => store.requestGate.open(sessionId, runId, token, input),
    completeTurn: async (sessionId, runId, token, result) => ({ turn: store.turnLifecycle.completeTurn(sessionId, runId, token, result) }),
    failTurn: async (sessionId, runId, token, failure) => ({ turn: store.turnLifecycle.failTurn(sessionId, runId, token, failure) }),
    ackSteer: async (sessionId, runId, token) => ({ turn: store.turnLifecycle.ackSteer(sessionId, runId, token) }),
    openProviderTurn: async (sessionId, input) => {
      assertWorker(input.workerId);
      return { turn: store.claims.openProviderTurn(sessionId, input) };
    },
    reportSessionTasks: async (sessionId, workerId, observations) => {
      assertWorker(workerId);
      return store.ingest.reportSessionTasks(sessionId, workerId, observations);
    },
  };
}

export function withDirectExecution(client: EngineClient, port: ExecutionPort,
  normalizeError: (error: unknown) => Error): EngineClient {
  return new Proxy(client, {
    get(target, key) {
      const direct = Reflect.get(port, key);
      if (typeof direct === "function") return async (...args: unknown[]) => {
        try { return await Reflect.apply(direct, port, args); }
        catch (error) { throw normalizeError(error); }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
