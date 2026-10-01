import {
  assignmentsOf,
  settlingActivityOf,
  wokeAt,
  type AssignmentTurn,
  type Session,
  type SessionSettleEnded,
  type SessionSettledBy,
} from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { delegationSettle, newestAssignment, type DeliveryTurn } from "./delegation-settling";
import { sessionMetadataFile, storedSession } from "./metadata";
import type { SessionQueue } from "./queue";
import type { SessionRecords } from "./records";

type SettlerDeps = {
  records: SessionRecords;
  scanQueue: (sessionId: string) => SessionQueue;
  settleDelegatedAfterHours: () => number | null;
  reviewCohorts: () => void;
  onShelfGrew: () => void;
  stopBackgroundTasks: (sessionId: string, reason: string) => number;
  releaseBrowser: (sessionId: string, reason: string) => Promise<unknown> | undefined;
  closeTerminals: (sessionId: string) => Promise<number>;
};

/**
 * The engine's two settling ticks: shelving a delegate once its coordinator has
 * its outcome (the rule is `delegationSettle`), and stamping the moment a snooze ended.
 */
export class SessionSettler {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: SettlerDeps,
  ) {}

  /** Asked at every terminal turn, for the session as a delegate and as a coordinator. Never throws into the transition. */
  evaluate(sessionId: string): void {
    try {
      this.settleIfDue(sessionId);
      // A coordinator's own queue names every delegate that could have just become delivered, so no store-wide scan.
      const delegates = new Set<string>();
      for (const turn of this.deps.scanQueue(sessionId).turns) {
        if (turn.wakeReason?.sessionId) delegates.add(turn.wakeReason.sessionId);
        if (turn.origin === "session" && turn.agentIntent === "result" && turn.sender?.sessionId) {
          delegates.add(turn.sender.sessionId);
        }
      }
      delegates.delete(sessionId);
      for (const delegate of delegates) this.settleIfDue(delegate);
    } catch (error) {
      this.kernel.appendEvent(sessionId, {
        type: "runtime.warning",
        message: `delegation settling was skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** The slow half: a grace that came due while nothing happened. Returns the sessions it settled. */
  sweepDelegated(): string[] {
    if (this.deps.settleDelegatedAfterHours() === null) return [];
    const settled: string[] = [];
    for (const sessionId of this.kernel.executionStore.unsettledSessionIds()) {
      try {
        if (this.settleIfDue(sessionId)) settled.push(sessionId);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return settled;
  }

  /** Every snooze that has ended, stamped once on the engine so every device agrees when it woke (`wokeAt` decides). */
  sweepSnoozeWakes(): string[] {
    const now = this.kernel.now();
    const woken: string[] = [];
    for (const row of this.kernel.executionStore.dueSnoozeWakes()) {
      try {
        const at = wokeAt({ ...row }, settlingActivityOf(row), { now });
        if (at === undefined) continue;
        if (this.recordSnoozeWake(row.id, at)) woken.push(row.id);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return woken;
  }

  // Re-read before writing, so a cancelled snooze is not woken and a wake is recorded once. `updatedAt` is untouched.
  private recordSnoozeWake(sessionId: string, at: number): boolean {
    const session = this.deps.records.get(sessionId);
    if (session.wokeAt !== undefined || session.snoozedUntil === undefined) return false;
    session.wokeAt = at;
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
    this.kernel.appendEvent(sessionId, { type: "session.woke", wokeAt: at });
    this.kernel.appendEvent(sessionId, { type: "session.updated", session });
    return true;
  }

  private settleIfDue(sessionId: string): boolean {
    let session: Session;
    try {
      session = this.deps.records.get(sessionId);
    } catch {
      return false;
    }
    // An archived row is off every list already, and a standing human decision is not the engine's to revisit.
    if (session.state === "archived" || session.settledOverride !== undefined) return false;
    const assignments = assignmentsOf(this.deps.scanQueue(sessionId).turns as unknown as AssignmentTurn[]);
    const newest = newestAssignment(assignments);
    if (!newest) return false;
    const outcome = delegationSettle({
      now: this.kernel.now(),
      graceHours: this.deps.settleDelegatedAfterHours(),
      delegateSessionId: sessionId,
      assignments,
      // A coordinator that no longer exists reads as an empty queue: "no delivery", not a settle on an absence.
      coordinatorTurns: this.deps.scanQueue(newest.fromSessionId).turns as unknown as DeliveryTurn[],
      activity: session.activity,
      archived: false,
      unsettledAssignments: session.unsettledAssignments ?? [],
    });
    if (!outcome.settle) return false;
    this.apply(sessionId, outcome.settle);
    return true;
  }

  // `updatedAt` dates the session's work and the quiet clock runs from it, so an engine settle leaves it alone.
  private apply(sessionId: string, settledBy: SessionSettledBy): void {
    const session = this.deps.records.get(sessionId);
    const next: Session = { ...session, settledOverride: "settled", settledAt: this.kernel.now(), settledBy };
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(next));
    this.kernel.appendEvent(sessionId, { type: "session.settled", settledBy });
    this.kernel.appendEvent(sessionId, { type: "session.updated", session: next });
    this.deps.reviewCohorts();
    this.deps.onShelfGrew();
  }

  /**
   * An explicit settle (the person's, or `sessions_settle`) ends what the session left running: its terminals, its
   * background tasks and its browser pages. Never the clock's settle. Best-effort, and un-settling restores none of it.
   */
  async endLeftovers(sessionId: string): Promise<SessionSettleEnded> {
    let backgroundTasks = 0;
    try {
      backgroundTasks = this.deps.stopBackgroundTasks(sessionId, "stopped when the session was settled");
    } catch {
      // A session that cannot be read has no tasks this can stop.
    }
    void this.deps.releaseBrowser(sessionId, "The session was settled.")?.catch(() => undefined);
    const terminals = await this.deps.closeTerminals(sessionId);
    return { terminals, backgroundTasks };
  }
}
