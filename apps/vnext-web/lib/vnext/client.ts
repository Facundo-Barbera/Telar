import type {
  BrowserSnapshot,
  GitCommitEntry,
  GitHubSnapshot,
  GitOverview,
  SessionDiff,
  EngineErrorCode,
  EngineEvent,
  EngineHealth,
  McpServer,
  McpServerSpec,
  ModelSelection,
  Project,
  TurnAttachment,
  TurnModelSelection,
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
    projectGit: (projectId: string) =>
      request<{ git: GitOverview }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/git`),
    /** Issues and pull requests. A NETWORK read behind a thirty-second cache —
     *  `refresh` is what the button sends, and nothing else may send it. */
    projectGitHub: (projectId: string, options: { refresh?: boolean } = {}) =>
      request<{ github: GitHubSnapshot }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/github${options.refresh ? "?refresh=1" : ""}`,
      ),
    sessions: (projectId: string) =>
      request<{ sessions: Session[] }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/sessions`),
    createSession: (projectId: string, input: { title?: string; driver?: ProviderDriverKind; envMode?: "local" | "worktree" } = {}) =>
      request<{ session: Session }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/sessions`, input),
    // The contract's own snapshot type, not a hand-copied structural twin: this
    // route proxies the engine verbatim, so a field the engine adds is already
    // arriving and a local re-declaration only hides it.
    session: (sessionId: string) =>
      request<SessionSnapshot>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`),
    /** Rename, change the model, or change what the session may do without
     *  asking. The model must belong to the session's provider instance — the
     *  engine rejects anything else, because a turn is routed by that instance
     *  and the provider owns the resume cursor. */
    updateSession: (
      sessionId: string,
      patch: { title?: string; runtimeMode?: RuntimeMode; detached?: boolean; model?: ModelSelection },
    ) => request<{ session: Session }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, patch),
    /** End a session and free its worktree. The branch survives. */
    archiveSession: (sessionId: string) =>
      request<{ session: Session }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/archive`, {}),
    /** `answers` is only meaningful for a `user_input` request — the route has
     *  always forwarded it; this signature simply never offered it, so the one
     *  request kind that asks a question could not be answered from the UI. */
    resolveRequest: (
      sessionId: string,
      requestId: string,
      input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown> },
    ) =>
      request<{ request: EngineRequest }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input),
    events: (sessionId: string, after: number) =>
      request<{ events: EngineEvent[]; cursor: number; more: boolean }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`),
    /** `model` rides with THIS message — queue three with different models and
     *  each runs on the one it was written under. It cannot name a provider
     *  instance, so the session's provider is fixed for its whole life. */
    submitTurn: (sessionId: string, input: { runId: string; input: string; model?: TurnModelSelection; attachments?: string[] }) =>
      request<TurnSubmissionResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, input),
    /**
     * Put a file where the session's provider can reach it.
     *
     * A `File` goes over the wire as ITS OWN BODY rather than as base64 inside
     * JSON: base64 costs a third again on the largest thing this client ever
     * sends, and the JSON limit on every other route is deliberately small.
     */
    uploadAttachment: async (sessionId: string, file: File): Promise<{ attachment: TurnAttachment }> => {
      let response: Response;
      try {
        response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            // Encoded because a filename may hold bytes a header may not.
            "x-telar-attachment-name": encodeURIComponent(file.name),
          },
          body: file,
        });
      } catch {
        throw new VNextApiError("engine_unavailable", "The vNext cockpit cannot reach its local adapter.");
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = (payload as { error?: { code?: VNextErrorCode; message?: string } } | null)?.error;
        throw new VNextApiError(error?.code ?? "internal_error", error?.message ?? "That file could not be attached.", response.status);
      }
      return payload as { attachment: TurnAttachment };
    },
    /** What this session has done to the repository since it started — committed
     *  and uncommitted together, from the base recorded at creation. */
    sessionDiff: (sessionId: string) =>
      request<{ diff: SessionDiff }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/diff`),
    /** One file's patch, opened on demand. */
    sessionFilePatch: (sessionId: string, path: string, options: { untracked?: boolean } = {}) => {
      const query = new URLSearchParams({ path });
      if (options.untracked) query.set("untracked", "1");
      return request<{ file: { patch: string; binary: boolean } }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/diff?${query.toString()}`,
      );
    },
    /** Snapshot the session's work as one commit. A refusal ("nothing to commit",
     *  a hook that said no) comes back as `committed: false` with a reason, not
     *  as a thrown error — it is an answer about the repository. */
    commitSessionWork: (sessionId: string, message: string) =>
      request<{ committed: boolean; commit?: GitCommitEntry; reason?: string }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/git/commit`,
        { message },
      ),
    /** What the session's browser is looking at. `screenshot` costs a round trip
     *  through Chromium and `start` would LAUNCH one, so both are opt-in. */
    browserState: (sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}) => {
      const query = new URLSearchParams();
      if (options.screenshot) query.set("screenshot", "1");
      if (options.start) query.set("start", "1");
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<{ browser: BrowserSnapshot }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/browser${suffix}`);
    },
    /** The user's own MCP servers. Environment-scoped: configured once, not once
     *  per conversation. */
    mcpServers: () => request<{ mcpServers: McpServer[] }>(fetcher, "GET", "/api/mcp-servers"),
    saveMcpServer: (input: { id: string; label?: string; enabled?: boolean; spec: McpServerSpec }) =>
      request<{ mcpServer: McpServer }>(fetcher, "PUT", "/api/mcp-servers", input),
    removeMcpServer: (id: string) =>
      request<{ removed: boolean }>(fetcher, "DELETE", `/api/mcp-servers/${encodeURIComponent(id)}`),
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
