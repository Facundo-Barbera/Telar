import type { Session, Turn } from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import { newestFirst, parseSession, releaseDelegationSettle, sessionMetadataFile, storedSession } from "./metadata";

type RecordsDeps = {
  withActivity: (session: Session) => Session;
  readQueue: (sessionId: string) => { turns: Turn[] };
};

/** Session metadata documents: reading, listing and the small writes that only touch `session.json`. */
export class SessionRecords {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: RecordsDeps,
  ) {}

  /** Existence and metadata only; use `get` when the activity fold is wanted. */
  require(sessionId: string): Session {
    const stored = this.kernel.readDocument(sessionMetadataFile(this.kernel.paths, sessionId));
    if (stored === undefined) throw new EngineStateError("not_found", "session does not exist");
    return parseSession(stored);
  }

  get(sessionId: string): Session {
    return this.deps.withActivity(structuredClone(this.require(sessionId)));
  }

  ids(): string[] {
    return this.kernel.executionStore.sessionIds();
  }

  all(): Session[] {
    return this.ids().map((sessionId) => this.get(sessionId));
  }

  /** Every readable session, newest first; a missing one is skipped rather than thrown. */
  read(only?: Set<string>): Session[] {
    return (only ? [...only] : this.ids())
      .flatMap((id) => {
        try {
          return [this.get(id)];
        } catch (error) {
          if (error instanceof EngineStateError && error.code === "not_found") return [];
          throw error;
        }
      })
      .sort(newestFirst);
  }

  touch(sessionId: string, at: number, resumeCursor?: string): void {
    const session = this.get(sessionId);
    session.updatedAt = at;
    if (resumeCursor !== undefined) session.resumeCursor = resumeCursor;
    this.write(session);
  }

  /**
   * Work a person queued lifts the shelf and the snooze, but keeps a pin.
   * The wake is stamped before the snooze is deleted, so `wokeAt` can answer.
   */
  wakeForNewWork(sessionId: string): void {
    const session = this.get(sessionId);
    if (session.settledOverride !== "settled" && session.snoozedUntil === undefined) return;
    if (session.settledOverride === "settled") {
      delete session.settledOverride;
      delete session.settledAt;
      releaseDelegationSettle(session);
    }
    const woken = session.snoozedUntil !== undefined;
    if (woken) session.wokeAt = this.kernel.now();
    delete session.snoozedUntil;
    delete session.snoozedAt;
    this.write(session);
    if (woken) this.kernel.appendEvent(sessionId, { type: "session.woke", wokeAt: session.wokeAt! });
    this.kernel.appendEvent(sessionId, { type: "session.updated", session });
  }

  /** Prefer metadata, but let a durable turn heal an interrupted metadata write. */
  resumeCursorFor(session: Session): string | undefined {
    if (session.resumeCursor) return session.resumeCursor;
    const recovered = latestProviderSessionId(this.deps.readQueue(session.id).turns);
    if (!recovered) return undefined;
    session.resumeCursor = recovered;
    session.updatedAt = this.kernel.now();
    this.write(session);
    return recovered;
  }

  /** A read receipt names a finished turn, never a clock, and only ever moves forward. */
  markRead(sessionId: string, runId: string): Session {
    return this.kernel.command("markSessionRead", () => {
      assertId(runId, "run id");
      const session = this.get(sessionId);
      const turn = this.deps.readQueue(sessionId).turns.find((entry) => entry.runId === runId);
      if (!turn || !isResultTurn(turn)) {
        throw new EngineStateError("invalid_request", "read receipt must name a completed, failed or stopped turn in this session");
      }
      if (turn.sequence <= (session.lastReadTurnSequence ?? 0)) return session;
      session.lastReadTurnSequence = turn.sequence;
      session.readAt = this.kernel.now();
      this.write(session);
      this.kernel.appendEvent(sessionId, { type: "session.updated", session });
      return structuredClone(session);
    });
  }

  private write(session: Session): void {
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, session.id), storedSession(session));
  }
}

/** Ended with an answer: the turns a read receipt may name. */
export function isResultTurn(turn: Turn): boolean {
  return turn.state === "completed" || turn.state === "failed" || turn.state === "stopped";
}

// Any state: a stopped first turn still carries the provider id a restart must resume.
export function latestProviderSessionId(turns: Turn[]): string | undefined {
  return turns
    .filter((turn) => typeof turn.providerSessionId === "string" && turn.providerSessionId.trim())
    .sort((left, right) => right.sequence - left.sequence)[0]?.providerSessionId;
}
