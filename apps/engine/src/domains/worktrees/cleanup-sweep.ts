import type { Session, SettlingOptions } from "@telar/engine-client";
import type { CleanupCandidate } from "../storage";
import { liveCheckouts } from "./boot-pass";

const HOUR_MS = 60 * 60 * 1000;

export function cleanupCandidates(sessions: readonly Session[], at: SettlingOptions): CleanupCandidate[] {
  const live = new Set(liveCheckouts(sessions, at).map((checkout) => checkout.sessionId));
  return sessions.flatMap((session) => {
    if (session.workspace.mode !== "worktree" || !session.projectId) return [];
    const archived = session.state === "archived";
    const active = Math.max(session.updatedAt, session.lastTurnEndedAt ?? 0, session.activityAt ?? 0);
    const settledAt = (session.settledOverride === "settled" ? session.settledAt : undefined) ?? active + (at.autoSettleAfterHours ?? 0) * HOUR_MS;
    return [
      {
        sessionId: session.id,
        path: session.workspace.path,
        archived,
        released: session.workspace.released !== undefined,
        lastActiveAt: active,
        ...(archived || live.has(session.id) ? {} : { settledAt }),
      },
    ];
  });
}
