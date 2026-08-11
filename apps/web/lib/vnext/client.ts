import type {
  EngineEvent,
  EngineHealth,
  EngineProject,
  EngineSession,
  EngineTurn,
  TurnSubmissionResult,
} from "@telar/engine-client";

export type VNextErrorCode =
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
    health: () => request<EngineHealth>(fetcher, "GET", "/api/vnext/health"),
    projects: () => request<{ projects: EngineProject[] }>(fetcher, "GET", "/api/vnext/projects"),
    registerProject: (input: { name: string; root: string }) =>
      request<{ project: EngineProject }>(fetcher, "POST", "/api/vnext/projects", input),
    sessions: (projectId: string) =>
      request<{ sessions: EngineSession[] }>(fetcher, "GET", `/api/vnext/projects/${encodeURIComponent(projectId)}/sessions`),
    createSession: (projectId: string, title?: string) =>
      request<{ session: EngineSession }>(fetcher, "POST", `/api/vnext/projects/${encodeURIComponent(projectId)}/sessions`, { title }),
    session: (sessionId: string) =>
      request<{ session: EngineSession; turns: EngineTurn[] }>(fetcher, "GET", `/api/vnext/sessions/${encodeURIComponent(sessionId)}`),
    events: (sessionId: string, after: number) =>
      request<{ events: EngineEvent[] }>(fetcher, "GET", `/api/vnext/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`),
    submitTurn: (sessionId: string, input: { runId: string; text: string }) =>
      request<TurnSubmissionResult>(fetcher, "POST", `/api/vnext/sessions/${encodeURIComponent(sessionId)}/turns`, input),
    stopTurn: (sessionId: string, runId?: string) =>
      request<{ turn?: EngineTurn; stopped: boolean }>(fetcher, "POST", `/api/vnext/sessions/${encodeURIComponent(sessionId)}/stop`, { runId }),
    discardAmbiguousTurn: (sessionId: string, runId: string) =>
      request<{ turn: EngineTurn }>(fetcher, "POST", `/api/vnext/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {}),
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
  turn: Pick<EngineTurn, "runId" | "state" | "text">,
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
  return api.submitTurn(sessionId, { runId, text: turn.text });
}
