// In-flight chat-turn registry (docs/runtime-architecture.md §A.4).
//
// A session's agent turn used to be bound to its HTTP request: a client
// disconnect (navigation, closed tab, hot-reload) tripped `req.signal` and
// killed the SDK subprocess mid-turn. Now the turn runs detached — a disconnect
// no longer aborts it. This registry is the handle the run leaves behind so an
// EXPLICIT Stop (POST /api/chat/stop) can still reach it, keyed by the client's
// per-turn runId and (once the SDK confirms it) the session id.
//
// globalThis-backed so the registry survives Next dev HMR module reloads, the
// same way lib/permissions.ts keeps its pending map.

type ChatRun = { abort: AbortController; sessionId: string | null };

const g = globalThis as unknown as { __telarChatRuns?: Map<string, ChatRun> };
const runs = (g.__telarChatRuns ??= new Map<string, ChatRun>());

// Register a freshly-started turn. `runId` is client-generated and known before
// the SDK session id exists, so Stop works even during a brand-new session's
// first turn (before its id is confirmed).
export function registerChatRun(runId: string, abort: AbortController): void {
  runs.set(runId, { abort, sessionId: null });
}

// Attach the SDK-confirmed session id once system:init arrives, so a Stop (and,
// later, a reconnecting subscriber) can also find the run by session id.
export function setChatRunSession(runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (run) run.sessionId = sessionId;
}

export function endChatRun(runId: string): void {
  runs.delete(runId);
}

// Abort a live run by runId OR session id. Returns whether anything was found.
export function stopChatRun(key: string): boolean {
  const byRunId = runs.get(key);
  if (byRunId) {
    byRunId.abort.abort();
    return true;
  }
  for (const run of runs.values()) {
    if (run.sessionId === key) {
      run.abort.abort();
      return true;
    }
  }
  return false;
}

// Whether a turn is currently running for this session (used by the reconnect
// path in §1b; harmless now).
export function isSessionRunLive(sessionId: string): boolean {
  for (const run of runs.values()) {
    if (run.sessionId === sessionId) return true;
  }
  return false;
}
