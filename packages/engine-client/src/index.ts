import fs from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineClientError,
  type EngineDiscovery,
  type EngineErrorBody,
  type EngineErrorCode,
  type EngineEvent,
  type EngineHealth,
  type EngineProject,
  type EngineSession,
  type TurnSubmission,
  type TurnSubmissionResult,
  type WorkerClaim,
  type WorkerStatus,
} from "./contract";

export * from "./contract";

const discoveryFile = (vnextRoot: string): string => path.join(vnextRoot, "engine.json");

function isDiscovery(value: unknown): value is EngineDiscovery {
  const candidate = value as Partial<EngineDiscovery> | null;
  return Boolean(
    candidate &&
      candidate.version === ENGINE_PROTOCOL_VERSION &&
      typeof candidate.daemonId === "string" &&
      candidate.daemonId.length > 0 &&
      candidate.host === "127.0.0.1" &&
      Number.isInteger(candidate.port) &&
      (candidate.port ?? 0) > 0 &&
      (candidate.port ?? 0) < 65536 &&
      typeof candidate.token === "string" &&
      candidate.token.length >= 32 &&
      Number.isFinite(candidate.startedAt),
  );
}

/** Reads only the vNext discovery document; it never touches legacy Telar state. */
export async function discoverEngine(vnextRoot: string): Promise<EngineDiscovery> {
  try {
    const raw = await fs.readFile(discoveryFile(vnextRoot), "utf8");
    const discovery: unknown = JSON.parse(raw);
    if (!isDiscovery(discovery)) {
      throw new EngineClientError("engine_unavailable", "vNext engine discovery is invalid");
    }
    return discovery;
  } catch (error) {
    if (error instanceof EngineClientError) throw error;
    throw new EngineClientError("engine_unavailable", "vNext engine is not discoverable");
  }
}

type FetchLike = typeof fetch;

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
    return this.request("GET", "/v1/health");
  }

  listProjects(): Promise<{ projects: EngineProject[] }> {
    return this.request("GET", "/v1/projects");
  }

  registerProject(input: { id?: string; name: string; root: string }): Promise<{ project: EngineProject }> {
    return this.request("POST", "/v1/projects", input);
  }

  listSessions(projectId: string): Promise<{ sessions: EngineSession[] }> {
    return this.request("GET", `/v1/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  createSession(input: { id?: string; projectId: string; title?: string }): Promise<{ session: EngineSession }> {
    return this.request("POST", "/v1/sessions", input);
  }

  session(sessionId: string): Promise<{ session: EngineSession; turns: TurnSubmissionResult["turn"][] }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  events(sessionId: string, after = 0): Promise<{ events: EngineEvent[] }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
  }

  submitTurn(sessionId: string, input: TurnSubmission): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, input);
  }

  stopTurn(sessionId: string, runId?: string): Promise<{ turn?: TurnSubmissionResult["turn"]; stopped: boolean }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { runId });
  }

  /** Explicit human resolution for a turn whose provider effects are uncertain. */
  discardAmbiguousTurn(sessionId: string, runId: string): Promise<{ turn: TurnSubmissionResult["turn"] }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {});
  }

  registerWorker(workerId: string): Promise<{ worker: { workerId: string } }> {
    return this.request("POST", "/v1/workers/register", { workerId });
  }

  workerHeartbeat(workerId: string): Promise<WorkerStatus> {
    return this.request("POST", `/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, {});
  }

  claimTurn(workerId: string): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", `/v1/workers/${encodeURIComponent(workerId)}/claim`, {});
  }

  markTurnRunning(sessionId: string, runId: string, claimToken: string): Promise<{ turn: TurnSubmissionResult["turn"] }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/running`, { claimToken });
  }

  appendTurnText(sessionId: string, runId: string, claimToken: string, text: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/text`, { claimToken, text });
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    text: string,
    providerSessionId?: string,
  ): Promise<{ turn: TurnSubmissionResult["turn"] }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/complete`, {
      claimToken,
      text,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
    });
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: "provider_unavailable" | "driver_failed"; message: string },
  ): Promise<{ turn: TurnSubmissionResult["turn"] }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/fail`, { claimToken, ...failure });
  }
}

export async function connectEngine(vnextRoot: string, fetchImpl?: FetchLike): Promise<EngineClient> {
  return new EngineClient(await discoverEngine(vnextRoot), fetchImpl);
}
