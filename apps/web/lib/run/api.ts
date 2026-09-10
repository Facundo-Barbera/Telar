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
 * ERRORS ARE `EngineApiError`, deliberately, and not a local class: components
 * already branch on `error.code === "conflict"`, and a run refusal is the same
 * kind of fact as any other engine refusal. `conflict` is the one a caller must
 * actually handle — it is how "this project is already deployed" and "Telar lost
 * contact with the last one" both arrive.
 */

import { EngineApiError } from "@/lib/engine/client";
import { pathnameFetcher } from "@/lib/hosts/client";
import type {
  RunConfigurationDraft,
  RunConfigurationView,
  RunOutputAnswer,
  RunStatusAnswer,
  RunView,
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

    status: (sessionId: string) => request<RunStatusAnswer>(fetcher, "GET", runPath(sessionId, "/status")),
    /** `replace` is the human saying "yes, take over the running one". Never
     *  sent by default: a silent takeover of somebody else's deployment is the
     *  failure this whole feature is shaped around. */
    start: (sessionId: string, configId: string, replace?: boolean) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/start"), { configId, ...(replace ? { replace: true } : {}) }),
    stop: (sessionId: string, runId?: string) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/stop"), runId ? { runId } : {}),
    restart: (sessionId: string, runId?: string) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/restart"), runId ? { runId } : {}),
    /** Frees a slot Telar cannot vouch for. Signals nothing — the human has
     *  checked, and this only records that they did. */
    release: (sessionId: string, runId: string) =>
      request<RunView>(fetcher, "POST", runPath(sessionId, "/release"), { runId }),
    output: (sessionId: string, options: { runId?: string; after?: number } = {}) =>
      request<RunOutputAnswer>(fetcher, "GET", runPath(sessionId, "/output", { runId: options.runId, after: options.after })),
  };
}

export type RunApi = ReturnType<typeof createRunApi>;

export const runApi: RunApi = createRunApi();
