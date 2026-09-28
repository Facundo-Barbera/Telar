import path from "node:path";
import { NotificationDetail } from "@telar/engine-client";
import { MAX_COHORT_ENTRIES, mergeNotifications } from "../../notification";
import { STATE_VERSION, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../state-paths";
import { sessionDir } from "./metadata";

const MAX_NEXT_TURN_NOTES = 5;

export const isPeerMail = (detail: NotificationDetail): boolean => detail.kind === "peer_message";

function notificationsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "notifications.json");
}

/**
 * What a session has not been told yet: notifications held while it worked,
 * with the time the box started waiting, and in-memory notes for its next turn.
 */
export class SessionMailbox {
  private readonly nextTurnNotes = new Map<string, string[]>();

  constructor(private readonly kernel: Kernel) {}

  /** An absent or torn box reads as empty; every fact in it is readable at its source. */
  pending(sessionId: string): NotificationDetail[] {
    const stored = this.kernel.readDocument(notificationsFile(this.kernel.paths, sessionId));
    if (stored === undefined) return [];
    const parsed = NotificationDetail.array().safeParse((stored as { pending?: unknown }).pending);
    return parsed.success ? parsed.data : [];
  }

  setPending(sessionId: string, pending: NotificationDetail[], heldSince?: number): void {
    this.kernel.writeDocument(notificationsFile(this.kernel.paths, sessionId), {
      version: STATE_VERSION,
      pending,
      ...(heldSince === undefined ? {} : { heldSince }),
    });
  }

  /** When the box became non-empty: the report window's clock. Absent on older boxes, which read as due. */
  heldSince(sessionId: string): number | undefined {
    const stored = this.kernel.readDocument(notificationsFile(this.kernel.paths, sessionId));
    if (stored === undefined) return undefined;
    const held = (stored as { heldSince?: unknown }).heldSince;
    return typeof held === "number" && Number.isFinite(held) ? held : undefined;
  }

  /**
   * Holds one notification. The newest fact about a run replaces older ones,
   * the oldest entries go past the cap, and an existing `heldSince` is kept so a
   * trickle of reports can't hold the box open for ever.
   */
  hold(sessionId: string, detail: NotificationDetail): void {
    const pending = this.pending(sessionId);
    const index = pending.findIndex(
      (each) => each.kind === detail.kind && each.sessionId === detail.sessionId && each.runId === detail.runId,
    );
    if (index >= 0) pending[index] = detail;
    else pending.push(detail);
    const heldSince = this.heldSince(sessionId) ?? this.kernel.now();
    this.setPending(sessionId, pending.slice(-MAX_COHORT_ENTRIES), heldSince);
  }

  /** Removes a held peer message that was corrected before it was read. */
  withdrawPeer(sessionId: string, runId: string): void {
    const pending = this.pending(sessionId);
    const kept = pending.filter((each) => !(each.kind === "peer_message" && each.runId === runId));
    if (kept.length !== pending.length) this.setPending(sessionId, kept, kept.length > 0 ? this.heldSince(sessionId) : undefined);
  }

  /** A box of peer mail alone rides ahead of the next turn's input; anything else waits for the flush. */
  takeHeldMail(sessionId: string): string[] {
    const pending = this.pending(sessionId);
    if (pending.length === 0 || !pending.every(isPeerMail)) return [];
    this.setPending(sessionId, []);
    return [`Held for you while you were busy; no reply needed.\n${mergeNotifications(pending).body}`];
  }

  /** A sentence for the session's next turn, deduplicated and capped. Lost on restart. */
  noteForNextTurn(sessionId: string, note: string): void {
    const notes = this.nextTurnNotes.get(sessionId) ?? [];
    if (!notes.includes(note)) notes.push(note);
    this.nextTurnNotes.set(sessionId, notes.slice(-MAX_NEXT_TURN_NOTES));
  }

  takeNextTurnNotes(sessionId: string): string[] {
    const notes = this.nextTurnNotes.get(sessionId) ?? [];
    this.nextTurnNotes.delete(sessionId);
    return notes;
  }
}
