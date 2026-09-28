import path from "node:path";
import type { EngineRequest, Turn } from "@telar/engine-client";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../state-paths";
import { sessionDir } from "./metadata";

// The same tail a snapshot renders; an open request is never dropped.
const RESOLVED_REQUEST_HISTORY = 50;
const NO_LIVE_REQUESTS: ReadonlyMap<string, EngineRequest> = new Map();

function requestsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "requests.json");
}

/**
 * Drops all but the newest resolved rows, in place, newest by when they were
 * answered: a long-parked request resolves after the ones opened behind it.
 */
function pruneResolvedRequests(requests: Map<string, EngineRequest>): number {
  const resolved = [...requests.values()].filter((request) => request.state !== "open");
  if (resolved.length <= RESOLVED_REQUEST_HISTORY) return 0;
  const oldestFirst = resolved.sort((left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0));
  const dropped = oldestFirst.slice(0, oldestFirst.length - RESOLVED_REQUEST_HISTORY);
  for (const request of dropped) requests.delete(request.id);
  return dropped.length;
}

// Rows are validated once when opened; reads only check the fields every reader keys on.
function isRequestRow(row: unknown): row is EngineRequest {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<EngineRequest>;
  return typeof candidate.id === "string" && typeof candidate.runId === "string" &&
    (candidate.state === "open" || candidate.state === "resolved");
}

/**
 * Each session's `requests.json`, plus an in-memory index of the rows a live run
 * could still be about: every open one, and every one this process saw resolve.
 * The index is built lazily and maintained only by `write`.
 */
export class SessionRequests {
  private liveIndex: Map<string, Map<string, EngineRequest>> | undefined;

  constructor(
    private readonly kernel: Kernel,
    private readonly sessionIds: () => string[],
  ) {
    kernel.onRollback(() => { this.liveIndex = undefined; });
    kernel.onSessionDeleted((id) => this.liveIndex?.delete(id));
  }

  read(sessionId: string): Map<string, EngineRequest> {
    const stored = this.kernel.readDocument(requestsFile(this.kernel.paths, sessionId));
    if (stored === undefined) return new Map();
    const rows = (stored as { requests?: unknown }).requests;
    if (!Array.isArray(rows) || rows.some((row) => !isRequestRow(row))) {
      throw new EngineStateError("invalid_request", "invalid request projection");
    }
    return new Map((rows as EngineRequest[]).map((request) => [request.id, request]));
  }

  /** The only writer: applies the history window and keeps the live index in step. */
  write(sessionId: string, requests: Map<string, EngineRequest>): void {
    pruneResolvedRequests(requests);
    this.kernel.writeDocument(requestsFile(this.kernel.paths, sessionId), { version: STATE_VERSION, requests: [...requests.values()] });
    this.reindex(sessionId, requests);
  }

  live(sessionId: string): ReadonlyMap<string, EngineRequest> {
    if (!this.liveIndex) {
      const index = new Map<string, Map<string, EngineRequest>>();
      for (const id of this.sessionIds()) {
        const open = new Map<string, EngineRequest>();
        try {
          for (const request of this.read(id).values()) {
            if (request.state === "open") open.set(request.id, structuredClone(request));
          }
        } catch { continue; }
        if (open.size > 0) index.set(id, open);
      }
      this.liveIndex = index;
    }
    return this.liveIndex.get(sessionId) ?? NO_LIVE_REQUESTS;
  }

  /** Drops indexed resolutions whose run can no longer take an answer; open rows stay. */
  trim(sessionId: string, turns: Turn[]): void {
    const live = this.liveIndex?.get(sessionId);
    if (!live) return;
    const answerable = new Set(turns.filter((turn) => turn.state === "running" && turn.claim).map((turn) => turn.runId));
    for (const [id, request] of live) {
      if (request.state !== "open" && !answerable.has(request.runId)) live.delete(id);
    }
    if (live.size === 0) this.liveIndex?.delete(sessionId);
  }

  /** Cancels the open requests of runs that ended; nothing will resume to answer them. */
  closeOpen(sessionId: string, runIds: ReadonlySet<string>, at: number): number {
    if (runIds.size === 0) return 0;
    const requests = this.read(sessionId);
    let closed = 0;
    for (const request of requests.values()) {
      if (!runIds.has(request.runId) || request.state !== "open") continue;
      request.state = "resolved";
      request.decision = "cancel";
      request.resolvedBy = "cancelled";
      request.resolvedAt = at;
      request.reason = "the turn ended before this request was answered";
      requests.set(request.id, request);
      this.kernel.appendEvent(sessionId, { type: "request.resolved", requestId: request.id, decision: "cancel", resolvedBy: "cancelled", reason: request.reason }, request.runId);
      closed += 1;
    }
    if (closed > 0) this.write(sessionId, requests);
    return closed;
  }

  /** Boot sweep: brings documents written before the history window inside it. */
  pruneHistory(): { sessions: number; dropped: number; bytes: number } {
    let sessions = 0;
    let dropped = 0;
    let bytes = 0;
    for (const sessionId of this.sessionIds()) {
      let requests: Map<string, EngineRequest>;
      const file = requestsFile(this.kernel.paths, sessionId);
      try {
        requests = this.read(sessionId);
      } catch {
        continue;
      }
      const before = this.kernel.documentBytes(file) ?? 0;
      const went = pruneResolvedRequests(requests);
      if (went === 0) continue;
      this.write(sessionId, requests);
      sessions += 1;
      dropped += went;
      bytes += before - (this.kernel.documentBytes(file) ?? 0);
    }
    return { sessions, dropped, bytes };
  }

  private reindex(sessionId: string, requests: Map<string, EngineRequest>): void {
    const index = this.liveIndex;
    if (!index) return;
    const known = index.get(sessionId);
    const live = new Map<string, EngineRequest>();
    for (const request of requests.values()) {
      if (request.state === "open" || known?.has(request.id)) live.set(request.id, structuredClone(request));
    }
    if (live.size > 0) index.set(sessionId, live);
    else index.delete(sessionId);
  }
}
