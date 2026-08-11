/**
 * The vNext engine is a local, authenticated control plane.  These types are
 * deliberately dependency-free so browser clients can use them without ever
 * importing the server-side Telar core package.
 */

export const ENGINE_PROTOCOL_VERSION = 1 as const;

export type EngineErrorCode =
  | "engine_unavailable"
  | "engine_unauthorized"
  | "engine_locked"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "worker_unavailable"
  | "provider_unavailable"
  | "driver_failed"
  | "internal_error";

export type EngineErrorBody = {
  error: {
    code: EngineErrorCode;
    message: string;
  };
};

export type EngineDiscovery = {
  version: typeof ENGINE_PROTOCOL_VERSION;
  daemonId: string;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: number;
};

export type EngineHealth = {
  version: typeof ENGINE_PROTOCOL_VERSION;
  daemonId: string;
  startedAt: number;
  worker: { registered: boolean; workerId?: string; activeWorkers?: number };
};

export type EngineProject = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  updatedAt: number;
};

export type EngineSession = {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** vNext currently executes only Claude turns; continuity remains engine-owned. */
  provider: { kind: "claude"; sessionId?: string };
};

export type TurnState = "queued" | "claimed" | "running" | "completed" | "failed" | "stopped" | "ambiguous" | "discarded";

export type EngineTurn = {
  runId: string;
  sequence: number;
  text: string;
  state: TurnState;
  acceptedAt: number;
  updatedAt: number;
  claim?: { workerId: string; token: string; at: number };
  stoppedAt?: number;
  ambiguousAt?: number;
  /** A human explicitly chose not to replay an uncertain provider invocation. */
  discardedAt?: number;
  completedAt?: number;
  failedAt?: number;
  result?: { text: string };
  failure?: { code: "provider_unavailable" | "driver_failed"; message: string };
  /** Claude session used/created for this turn, when the SDK reports one. */
  providerSessionId?: string;
};

export type EngineEvent = {
  id: number;
  at: number;
  type:
    | "session.created"
    | "turn.accepted"
    | "turn.claimed"
    | "turn.running"
    | "turn.text"
    | "turn.final"
    | "turn.error"
    | "turn.stopped"
    | "turn.requeued"
    | "turn.ambiguous"
    | "turn.discarded";
  runId?: string;
  data: Record<string, unknown>;
};

export type TurnSubmission = {
  runId: string;
  text: string;
};

export type TurnSubmissionResult = {
  turn: EngineTurn;
  replayed: boolean;
  /** The accepted work is durable and claimable by a registered vNext worker. */
  execution: { status: "scheduled"; code: "scheduled" };
};

export type WorkerClaim = { sessionId: string; projectRoot: string; provider: EngineSession["provider"]; turn: EngineTurn };

export type WorkerStatus = {
  workerId: string;
  heartbeatAt: number;
  cancel: Array<{ sessionId: string; runId: string; claimToken: string }>;
};

export class EngineClientError extends Error {
  readonly code: EngineErrorCode;
  readonly status?: number;

  constructor(code: EngineErrorCode, message: string, status?: number) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
    this.status = status;
  }
}
