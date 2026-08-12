/**
 * vNext engine client — protocol v2.
 *
 * PROTOCOL v1 IS GONE, not deprecated. Its eleven flat `turn.*` events were not
 * a subset of v2 and there is no dual-emit path; an engine speaking v2 answers
 * on `/v2/**` and a v1 client gets a 404 rather than a confusing parse failure
 * three layers in. The routes moved with the version deliberately, so the break
 * is visible at the URL.
 */
import {
  ENGINE_PROTOCOL_VERSION,
  EngineDiscovery,
  type EngineErrorBody,
  type EngineErrorCode,
  type EngineEvent,
  type EngineHealth,
  type Item,
  type Project,
  type ProviderDriverKind,
  type Session,
  type Task,
  type EngineRequest,
  type RequestDecision,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type Turn,
  type TurnObservation,
  type TurnSubmissionResult,
  type UsageSnapshot,
  type WorkerClaim,
  type WorkerStatus,
} from "./protocol";

export * from "./protocol";

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

/** Engine discovery (`discoverEngine`/`connectEngine`) lives in `./node`, a
 *  separate entry point, because it reads the filesystem and this root export
 *  is bundled into browser client components — a top-level `node:fs/promises`
 *  import here is a hard Turbopack error. */
export type FetchLike = typeof fetch;

/** What `GET /v2/sessions/:id` answers with — the snapshot a client opens on
 *  so it does not have to replay the journal from zero. */
export type SessionSnapshot = {
  session: Session;
  turns: Turn[];
  items: Item[];
  requests: EngineRequest[];
  /** Sub-agents and background work. A background task OUTLIVES the turn that
   *  started it, so this is the only thing that can tell a client opening a
   *  cold session that it is still working. */
  tasks: Task[];
};

export class EngineClient {
  constructor(
    readonly discovery: EngineDiscovery,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.discovery.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "vNext engine is unreachable");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "vNext engine returned an invalid response", response.status);
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      const code: EngineErrorCode = error?.code ?? "engine_unavailable";
      throw new EngineClientError(code, error?.message ?? "vNext engine request failed", response.status);
    }
    return payload as T;
  }

  health(): Promise<EngineHealth> {
    return this.request("GET", "/v2/health");
  }

  listProjects(): Promise<{ projects: Project[] }> {
    return this.request("GET", "/v2/projects");
  }

  registerProject(input: { id?: string; name: string; root: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects", input);
  }

  listSessions(projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  createSession(input: {
    id?: string;
    projectId: string;
    title?: string;
    detached?: boolean;
    envMode?: "local" | "worktree";
    /** Which provider runs this session's turns. Defaults to Claude. */
    driver?: ProviderDriverKind;
  }): Promise<{ session: Session }> {
    return this.request("POST", "/v2/sessions", input);
  }

  session(sessionId: string): Promise<SessionSnapshot> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}`);
  }

  events(sessionId: string, after = 0): Promise<{ events: EngineEvent[]; cursor: number; more: boolean }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
  }

  submitTurn(sessionId: string, input: { runId: string; input: string }): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns`, input);
  }

  stopTurn(sessionId: string, runId?: string): Promise<{ turn?: Turn; stopped: boolean }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop`, { runId });
  }

  /** End a session and free its worktree. The branch survives — it is the
   *  session's output, and destroying it is a separate human decision. */
  archiveSession(sessionId: string): Promise<{ session: Session }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/archive`, {});
  }

  /** Explicit human resolution for a turn whose provider effects are uncertain. */
  discardAmbiguousTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {});
  }

  registerWorker(workerId: string): Promise<{ worker: { workerId: string } }> {
    return this.request("POST", "/v2/workers/register", { workerId });
  }

  workerHeartbeat(workerId: string): Promise<WorkerStatus> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/heartbeat`, {});
  }

  claimTurn(workerId: string): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/claim`, {});
  }

  markTurnRunning(sessionId: string, runId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/running`, { claimToken });
  }

  /** Batched: one round trip per delta would dominate the cost of streaming. */
  reportObservations(
    sessionId: string,
    runId: string,
    claimToken: string,
    observations: TurnObservation[],
  ): Promise<{ accepted: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/observe`, {
      claimToken,
      observations,
    });
  }

  /**
   * Ask whether a tool call may proceed. The engine applies the session's
   * runtime mode and either answers immediately or parks the request; a parked
   * answer arrives later on the heartbeat.
   */
  openRequest(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { requestId: string; kind: RequestKind; detail: RequestDetail; itemId?: string },
  ): Promise<RequestOpenResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/request`, {
      claimToken,
      ...input,
    });
  }

  /** A human answering a parked request. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown> },
  ): Promise<{ request: EngineRequest }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input);
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    result: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
  ): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/complete`, {
      claimToken,
      ...result,
    });
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: "provider_unavailable" | "driver_failed" | "budget_exhausted"; message: string },
  ): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/fail`, {
      claimToken,
      ...failure,
    });
  }
}

export { ENGINE_PROTOCOL_VERSION };
