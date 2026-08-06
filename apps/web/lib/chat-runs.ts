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

import { logStop } from "@/lib/permission-diagnostics";

type ChatRun = { abort: AbortController; sessionId: string | null };

const g = globalThis as unknown as { __telarChatRuns?: Map<string, ChatRun> };
const runs = (g.__telarChatRuns ??= new Map<string, ChatRun>());

// Atomically reserve one active turn. `runId` is client-generated and known
// before the SDK session id exists, so Stop works even during a brand-new
// session's first turn. A resumed session is supplied up front: the engine,
// not renderer timing, enforces the single-active-turn invariant.
//
// Returns false rather than overwriting an existing handle. Reusing a run id or
// starting a second turn for the same canonical session must never orphan the
// first AbortController while its subprocess is still alive.
export function registerChatRun(
  runId: string,
  abort: AbortController,
  sessionId: string | null = null,
): boolean {
  if (runs.has(runId)) return false;
  if (sessionId) {
    for (const run of runs.values()) {
      if (run.sessionId === sessionId) return false;
    }
  }
  runs.set(runId, { abort, sessionId });
  return true;
}

// Attach the SDK-confirmed session id once system:init arrives, so a Stop (and,
// later, a reconnecting subscriber) can also find the run by session id.
export function setChatRunSession(runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  for (const [otherId, other] of runs) {
    if (otherId !== runId && other.sessionId === sessionId) {
      throw new Error(`session ${sessionId} already has an active turn`);
    }
  }
  run.sessionId = sessionId;
}

export function endChatRun(runId: string): void {
  runs.delete(runId);
}

// Abort a live run by runId OR session id. Returns whether anything was found.
//
// #28: THIS IS THE ONLY PATH THAT CANCELS A LIVE TURN, which makes it the only
// place inside telar that can produce the CLI's interrupted-tool-use text. All
// three known callers of POST /api/chat/stop are explicit user Stop actions, so
// a Stop logged here that no human clicked IS the bug. Instrumented rather than
// asserted, because "nothing else calls it" is exactly the kind of claim that is
// true of the source and false of the running process.
export function stopChatRun(key: string, via = "unknown"): boolean {
  const byRunId = runs.get(key);
  if (byRunId) {
    logStop(key, true, via);
    byRunId.abort.abort();
    return true;
  }
  for (const run of runs.values()) {
    if (run.sessionId === key) {
      logStop(key, true, via);
      run.abort.abort();
      return true;
    }
  }
  logStop(key, false, via);
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
