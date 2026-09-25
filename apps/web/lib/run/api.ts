/**
 * The cockpit's door to a project's deployment.
 *
 * SEPARATE FROM `createEngineApi` ON PURPOSE, FOR NOW. Run belongs on that
 * singleton like every other capability, and it will land there in the change
 * that lifts the protocol types (`lib/run/types.ts` says the same). Until then a
 * second author inside a 900-line shared module costs more than this small
 * module does — and because every caller imports `runApi` rather than
 * constructing anything, moving it later is a re-export, not a rewrite.
 *
 * ERRORS ARE `EngineApiError`, deliberately, and not a local class: a run
 * refusal is the same kind of fact as any other engine refusal. There is no
 * "already deployed" conflict any more — every start opens a new terminal —
 * so `conflict` now means the terminal host could not be reached or a
 * terminal has already ended.
 */

import { EngineApiError } from "@/lib/engine/client";
import { pathnameFetcher } from "@/lib/hosts/client";
import type {
  RunBytesAnswer,
  RunConfigurationDraft,
  RunConfigurationView,
  RunOutputAnswer,
  RunResizeAnswer,
  RunStatusAnswer,
  RunView,
  RunWriteAnswer,
} from "./types";

type Fetcher = typeof fetch;

/** `/api/sessions/:id/run/…` — the run door is session-scoped because the
 *  project and the worktree are things the daemon knows about the session, not
 *  things a client should be able to name. */
export function runPath(sessionId: string, tail: string, query?: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const suffix = search.size ? `?${search.toString()}` : "";
  return `/api/sessions/${encodeURIComponent(sessionId)}/run${tail}${suffix}`;
}

async function request<T>(fetcher: Fetcher, method: string, pathname: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(pathname, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new EngineApiError("engine_unavailable", "The cockpit cannot reach its local adapter.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngineApiError("engine_unavailable", "The engine adapter returned an invalid response.", response.status);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new EngineApiError(
      (error?.code as EngineApiError["code"]) ?? "internal_error",
      error?.message ?? "The run request failed.",
      response.status,
    );
  }
  return payload as T;
}

export function createRunApi(fetcher: Fetcher = pathnameFetcher) {
  return {
    configurations: (sessionId: string) =>
      request<{ configurations: RunConfigurationView[] }>(fetcher, "GET", runPath(sessionId, "/configs")),
    createConfiguration: (sessionId: string, draft: RunConfigurationDraft) =>
      request<RunConfigurationView>(fetcher, "POST", runPath(sessionId, "/configs"), draft),
    updateConfiguration: (sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>) =>
      request<RunConfigurationView>(fetcher, "POST", runPath(sessionId, `/configs/${encodeURIComponent(configId)}`), patch),
    removeConfiguration: (sessionId: string, configId: string) =>
      request<{ removed: string }>(fetcher, "DELETE", runPath(sessionId, `/configs/${encodeURIComponent(configId)}`)),

    /** The session's terminals, newest first. */
    status: (sessionId: string) => request<RunStatusAnswer>(fetcher, "GET", runPath(sessionId, "/status")),
    /** Opens a NEW terminal from the configuration. Never a conflict with one
     *  already open; a busy port comes back as `warning`. */
    start: (sessionId: string, configId: string) => request<RunView>(fetcher, "POST", runPath(sessionId, "/start"), { configId }),
    /** Closes a terminal, which ends what runs in it. From the cockpit, so the
     *  engine records the person as who closed it. */
    stop: (sessionId: string, terminalId?: string) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/stop"), terminalId ? { terminalId } : {}),
    restart: (sessionId: string, terminalId?: string) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/restart"), terminalId ? { terminalId } : {}),
    output: (sessionId: string, options: { runId?: string; after?: number } = {}) =>
      request<RunOutputAnswer>(fetcher, "GET", runPath(sessionId, "/output", { runId: options.runId, after: options.after })),
    /**
     * The same window as `output`, as the redacted bytes the emulator draws.
     *
     * OVER THE HOST HOP LIKE EVERY OTHER RUN CALL, which is the whole reason
     * this route exists rather than the panel reading `telarDesktop.terminal`.
     * `terminalBridge()` is undefined for a session on another Mac — on purpose
     * — so a bridge-fed emulator would show a PAIRED session an empty screen
     * for a run happening on the computer it is about. And the bridge fans RAW
     * node-pty bytes: an emulator on it would draw a run's secrets unredacted.
     */
    bytes: (sessionId: string, options: { runId?: string; after?: number } = {}) =>
      request<RunBytesAnswer>(fetcher, "GET", runPath(sessionId, "/bytes", { runId: options.runId, after: options.after })),
    /** Keystrokes for the program the recipe named. Not redacted, and nothing
     *  here pretends otherwise — docs/run-terminal.md §5. */
    write: (sessionId: string, options: { runId?: string; data: string }) =>
      request<RunWriteAnswer>(fetcher, "POST", runPath(sessionId, "/write"), options),
    resize: (sessionId: string, options: { runId?: string; cols: number; rows: number }) =>
      request<RunResizeAnswer>(fetcher, "POST", runPath(sessionId, "/resize"), options),
  };
}

export type RunApi = ReturnType<typeof createRunApi>;

export const runApi: RunApi = createRunApi();
