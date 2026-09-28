// Run refusals are EngineApiError; `conflict` means the terminal host is
// unreachable or the terminal has already ended.

import { domainMethods, type RunConfigurationDraft } from "@telar/engine-client";
import { pathnameFetcher, type Fetcher } from "@/platform/engine/host-client";
import { apiTransport } from "@/platform/engine/transport";

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

/** The contract's terminal methods over the host hop. Unbudgeted: a live terminal's polls must not queue behind other reads. */
export function createRunApi(fetcher: Fetcher = pathnameFetcher) {
  const engine = domainMethods(apiTransport(fetcher, null));
  return {
    configurations: (sessionId: string) => engine.runConfigurations(sessionId),
    createConfiguration: (sessionId: string, draft: RunConfigurationDraft) => engine.createRunConfiguration(sessionId, draft),
    updateConfiguration: (sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>) => engine.updateRunConfiguration(sessionId, configId, patch),
    removeConfiguration: (sessionId: string, configId: string) => engine.removeRunConfiguration(sessionId, configId),
    /** The session's terminals, newest first. */
    status: (sessionId: string) => engine.runStatus(sessionId),
    /** Opens a new terminal; a busy port comes back as `warning`, never a conflict. */
    start: (sessionId: string, configId: string) => engine.startRun(sessionId, { configId }),
    stop: (sessionId: string, terminalId?: string) => engine.stopRun(sessionId, terminalId),
    restart: (sessionId: string, terminalId?: string) => engine.restartRun(sessionId, terminalId),
    output: (sessionId: string, options: { runId?: string; after?: number } = {}) => engine.runOutput(sessionId, options),
    /** Over the host hop so a paired Mac's run is readable, and redacted, unlike the desktop bridge's raw bytes. */
    bytes: (sessionId: string, options: { runId?: string; after?: number } = {}) => engine.runBytes(sessionId, options),
    /** Keystrokes for the program the recipe named. Not redacted. */
    write: (sessionId: string, options: { runId?: string; data: string }) => engine.writeRun(sessionId, options),
    resize: (sessionId: string, options: { runId?: string; cols: number; rows: number }) => engine.resizeRun(sessionId, options),
  };
}

export type RunApi = ReturnType<typeof createRunApi>;
