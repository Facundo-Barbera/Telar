import type {
  EngineErrorCode,
  EngineEvent,
  EngineHealth,
  Project,
  ProviderDriverKind,
  EngineRequest,
  RequestDecision,
  RuntimeMode,
  Session,
  SessionSnapshot,
  Turn,
  TurnSubmissionResult,
} from "@telar/engine-client";

/**
 * DERIVED FROM THE CONTRACT, not re-listed beside it. This union used to be ten
 * hand-written literals that had to be kept in step with the engine's own
 * `EngineErrorCode` by hand — and when v2 added `protocol_mismatch`, the copy
 * here was the thing that went stale. An alias cannot.
 */
export type VNextErrorCode = EngineErrorCode;

export class VNextApiError extends Error {
  constructor(readonly code: VNextErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "VNextApiError";
  }
}

type Fetcher = typeof fetch;

async function request<T>(fetcher: Fetcher, method: string, pathname: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(pathname, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new VNextApiError("engine_unavailable", "The vNext cockpit cannot reach its local adapter.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VNextApiError("engine_unavailable", "The vNext engine adapter returned an invalid response.", response.status);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: VNextErrorCode; message?: string } } | null)?.error;
    throw new VNextApiError(error?.code ?? "internal_error", error?.message ?? "The vNext request failed.", response.status);
  }
  return payload as T;
}

export function createVNextApi(fetcher: Fetcher = fetch) {
  return {
    health: () => request<EngineHealth>(fetcher, "GET", "/api/health"),
    projects: () => request<{ projects: Project[] }>(fetcher, "GET", "/api/projects"),
    registerProject: (input: { name: string; root: string }) =>
      request<{ project: Project }>(fetcher, "POST", "/api/projects", input),
    sessions: (projectId: string) =>
      request<{ sessions: Session[] }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/sessions`),
    createSession: (projectId: string, input: { title?: string; driver?: ProviderDriverKind; envMode?: "local" | "worktree" } = {}) =>
      request<{ session: Session }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/sessions`, input),
    // The contract's own snapshot type, not a hand-copied structural twin: this
    // route proxies the engine verbatim, so a field the engine adds is already
    // arriving and a local re-declaration only hides it.
    session: (sessionId: string) =>
      request<SessionSnapshot>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`),
    /** Rename, or change what the session may do without asking. */
    updateSession: (sessionId: string, patch: { title?: string; runtimeMode?: RuntimeMode; detached?: boolean }) =>
      request<{ session: Session }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, patch),
    resolveRequest: (sessionId: string, requestId: string, input: { decision: RequestDecision; reason?: string }) =>
      request<{ request: EngineRequest }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input),
    events: (sessionId: string, after: number) =>
      request<{ events: EngineEvent[]; cursor: number; more: boolean }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`),
    submitTurn: (sessionId: string, input: { runId: string; input: string }) =>
      request<TurnSubmissionResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, input),
    stopTurn: (sessionId: string, runId?: string) =>
      request<{ turn?: Turn; stopped: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { runId }),
    discardAmbiguousTurn: (sessionId: string, runId: string) =>
      request<{ turn: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {}),
  };
}

/** Browser-generated ids are stable if the submission has to be retried. */
export function newVNextRunId(uuid: () => string = () => crypto.randomUUID()): string {
  return `run_${uuid().replaceAll("-", "")}`;
}

type VNextTurnApi = Pick<ReturnType<typeof createVNextApi>, "discardAmbiguousTurn" | "submitTurn">;

/**
 * Retrying uncertain work is deliberately a two-command flow: first persist
 * the human discard decision, then submit the same prompt under a new id.
 * The ambiguous run id is never replayed.
 */
export async function retryAmbiguousTurn(
  api: VNextTurnApi,
  sessionId: string,
  turn: Pick<Turn, "runId" | "state" | "input">,
  createRunId: () => string = newVNextRunId,
): Promise<TurnSubmissionResult> {
  if (turn.state !== "ambiguous") {
    throw new VNextApiError("conflict", "Only an ambiguous turn requires explicit discard before retrying.");
  }
  await api.discardAmbiguousTurn(sessionId, turn.runId);
  const runId = createRunId();
  if (runId === turn.runId) {
    throw new VNextApiError("conflict", "Retry must use a fresh run id.");
  }
  return api.submitTurn(sessionId, { runId, input: turn.input });
}
