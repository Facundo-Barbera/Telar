import path from "node:path";
import { Session, workspacePath } from "@telar/engine-client";
import { assertId, EngineStateError } from "../../platform/kernel";
import type { EngineStatePaths } from "../../state-paths";

const MAX_UNSETTLED_ASSIGNMENTS = 64;

export function sessionDir(paths: EngineStatePaths, sessionId: string): string {
  assertId(sessionId, "session id");
  const directory = path.join(paths.sessions, sessionId);
  const prefix = paths.sessions.endsWith(path.sep) ? paths.sessions : `${paths.sessions}${path.sep}`;
  if (!directory.startsWith(prefix)) throw new EngineStateError("invalid_request", "unsafe session path");
  return directory;
}

export function sessionMetadataFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "session.json");
}

export function parseSession(value: unknown): Session {
  const session = Session.safeParse(value);
  if (!session.success) throw new EngineStateError("invalid_request", "invalid session metadata");
  assertId(session.data.id, "session id");
  // Only when present: a project-less session is valid and must stay readable.
  if (session.data.projectId !== undefined) assertId(session.data.projectId, "project id");
  return session.data;
}

/** The half of a session that belongs on disk; the activity fields are folded from the queue on read. */
export function storedSession(
  session: Session,
): Omit<Session, "activity" | "activityAt" | "lastTurnEndedAt" | "lastTurnFailed" | "lastTurnSequence"> {
  const {
    activity: _activity,
    activityAt: _activityAt,
    lastTurnEndedAt: _lastTurnEndedAt,
    lastTurnFailed: _lastTurnFailed,
    lastTurnSequence: _lastTurnSequence,
    ...stored
  } = session;
  return stored;
}

/** Newest work first, ties broken by id so two passes never disagree. */
export const newestFirst = (left: Session, right: Session): number =>
  right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);

/**
 * Takes back an engine delegation settle and remembers the errand, so the next
 * evaluation does not shelve the row again. A no-op on rows the engine never settled.
 */
export function releaseDelegationSettle(session: Session): void {
  const stamp = session.settledBy;
  if (!stamp) return;
  delete session.settledBy;
  const released = session.unsettledAssignments ?? [];
  if (released.includes(stamp.runId)) return;
  session.unsettledAssignments = [...released, stamp.runId].slice(-MAX_UNSETTLED_ASSIGNMENTS);
}

/** The session's working directory, or a refusal for one that has none. */
export function workspaceRootOf(session: Pick<Session, "workspace">): string {
  const root = workspacePath(session.workspace);
  if (root === undefined) throw new EngineStateError("invalid_request", "this session has no working directory");
  return root;
}
