import type { InboxPolicy, Session } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { indexRow, rowIsShelved, type SessionIndex, type SessionRecords } from "../sessions";

export type AttachedTerminals = {
  openCount(sessionId: string): number;
  openSessions(): string[];
  /** `by` is "person" only when the person asked; Telar otherwise. */
  closeSession(sessionId: string, by?: "telar" | "person"): Promise<number>;
  /** The host's count per session, the person's shells included. Absent means this engine's own terminals are all there are. */
  sessionCounts?(): Promise<Record<string, number>>;
};

/** How long a clock-settled session keeps its terminals, so a conversation that merely aged out keeps its dev server a while. */
export const SETTLED_TERMINAL_GRACE_MS = 30 * 60_000;

export type SessionTerminalsHost = {
  now(): number;
  inboxPolicy(): Pick<InboxPolicy, "autoSettleAfterHours" | "settledTerminalLimit">;
  /** Writes the record without touching `updatedAt`: closing a settled session's terminals must not pull it off the shelf. */
  recordSession(session: Session): void;
};

/**
 * What the terminal host last said each session holds. Read when something changes (a settle or close,
 * one of the engine's own terminals opening or ending, the settled sweep) rather than per row or on a timer.
 */
export class SessionTerminals {
  private terminals?: AttachedTerminals;
  private census = new Map<string, number>();
  private censusTask?: Promise<void>;
  private censusAgain = false;
  private limitTask?: Promise<string[]>;

  constructor(
    private readonly records: SessionRecords,
    private readonly index: SessionIndex,
    private readonly host: SessionTerminalsHost,
  ) {}

  /** Absent means this store knows of no terminals: settling closes none, and nothing is held busy by one. */
  attach(terminals: AttachedTerminals): void {
    this.terminals = terminals;
  }

  get attached(): boolean {
    return this.terminals !== undefined;
  }

  openCount(sessionId: string): number {
    return this.terminals?.openCount(sessionId) ?? 0;
  }

  /** Callers in flight share one read, and one more if they arrived during it. */
  refresh(): Promise<void> {
    if (!this.terminals) return Promise.resolve();
    if (this.censusTask) {
      this.censusAgain = true;
      return this.censusTask;
    }
    this.censusTask = (async () => {
      do {
        this.censusAgain = false;
        const terminals = this.terminals!;
        let counts: Record<string, number>;
        try {
          counts = terminals.sessionCounts
            ? await terminals.sessionCounts()
            : Object.fromEntries(terminals.openSessions().map((sessionId) => [sessionId, terminals.openCount(sessionId)]));
        } catch {
          // The host is out of reach: what it last said stands.
          return;
        }
        this.apply(counts);
      } while (this.censusAgain);
    })().finally(() => {
      this.censusTask = undefined;
    });
    return this.censusTask;
  }

  private apply(counts: Record<string, number>): void {
    const changed = new Set<string>();
    for (const [sessionId, count] of this.census) if ((counts[sessionId] ?? 0) !== count) changed.add(sessionId);
    for (const [sessionId, count] of Object.entries(counts)) if ((this.census.get(sessionId) ?? 0) !== count) changed.add(sessionId);
    this.census = new Map(Object.entries(counts).filter(([, count]) => count > 0));
    // A count is on the row's answer, so a change must move its list's cursor or a conditional read calls it unchanged.
    const at = this.index.settlingClock();
    for (const sessionId of changed) {
      try {
        this.index.bumpRow(indexRow(this.records.get(sessionId)), at);
      } catch {
        // A session the host knows and this store does not is not on any list.
      }
    }
  }

  private sessions(): string[] {
    return [...new Set([...this.census.keys(), ...(this.terminals?.openSessions() ?? [])])];
  }

  /** How many terminals this session holds, whoever opened them; the engine's own records keep a run from being under-counted. */
  count(sessionId: string): number {
    return Math.max(this.census.get(sessionId) ?? 0, this.terminals?.openCount(sessionId) ?? 0);
  }

  /** The census for the rows of one answer: sessions with one or more, only. */
  countsFor(sessionIds: Iterable<string>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const sessionId of sessionIds) {
      const count = this.count(sessionId);
      if (count > 0) counts[sessionId] = count;
    }
    return counts;
  }

  /** What Settle would close, asked now; the answer also refreshes what the rail is told. */
  async countNow(sessionId: string): Promise<number> {
    this.records.get(sessionId);
    await this.refresh();
    return this.count(sessionId);
  }

  /** A settled row's "close them": recorded as the person's, so a watching agent is told on its next turn. */
  async closeForPerson(sessionId: string): Promise<number> {
    this.records.get(sessionId);
    if (!this.terminals) return 0;
    let closed: number;
    try {
      closed = await this.terminals.closeSession(sessionId, "person");
    } catch (error) {
      throw new EngineStateError("conflict", `Telar could not close this session's terminals: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refresh();
    return closed;
  }

  /** An explicit settle's close. The settled limit is not checked: this settle only lowered the total it sums. */
  async closeForSettle(sessionId: string): Promise<number> {
    let closed = 0;
    try {
      closed = (await this.terminals?.closeSession(sessionId)) ?? 0;
    } catch {
      // The desktop's terminal host is out of reach. Quitting Telar closes every terminal it holds.
    }
    await this.refresh();
    return closed;
  }

  private recordClosed(sessionId: string, terminals: number, reason: "grace" | "limit"): void {
    if (terminals <= 0) return;
    try {
      this.host.recordSession({ ...this.records.get(sessionId), terminalsClosed: { at: this.host.now(), terminals, reason } });
    } catch {
      // The terminals are closed either way; a record that could not be kept costs the explanation, not the close.
    }
  }

  /**
   * Closes the terminals of sessions settled for longer than the grace, including sessions whose only terminal
   * is a shell the person opened, then checks the settled limit. Answers the sessions the grace closed.
   */
  async sweepSettled(): Promise<string[]> {
    if (!this.terminals) return [];
    await this.refresh();
    const now = this.host.now();
    const window = this.host.inboxPolicy().autoSettleAfterHours;
    const due: string[] = [];
    for (const sessionId of this.sessions()) {
      try {
        const row = indexRow(this.records.get(sessionId));
        if (!rowIsShelved(row, { now, autoSettleAfterHours: window })) continue;
        const since = now - SETTLED_TERMINAL_GRACE_MS;
        const longEnough = row.settledOverride === "settled"
          ? (row.settledAt ?? 0) <= since
          // Shelved by the clock: it was already shelved a grace ago.
          : rowIsShelved(row, { now: since, autoSettleAfterHours: window });
        if (longEnough) due.push(sessionId);
      } catch {
        // A session that cannot be read is not closed on a guess.
      }
    }
    for (const sessionId of due) {
      try {
        const closed = await this.terminals.closeSession(sessionId);
        this.recordClosed(sessionId, closed, "grace");
      } catch {
        // The next tick tries again.
      }
    }
    if (due.length > 0) await this.refresh();
    await this.enforceLimit();
    return due;
  }

  /**
   * No more than `settledTerminalLimit` terminals across settled sessions: past it, the session settled longest ago
   * (`settledAt`, or last activity plus the window for the clock) is closed first. Answers the sessions it closed.
   */
  enforceLimit(): Promise<string[]> {
    // One check at a time: two overlapping would both close the same oldest session.
    this.limitTask ??= this.checkLimit().finally(() => {
      this.limitTask = undefined;
    });
    return this.limitTask;
  }

  private async checkLimit(): Promise<string[]> {
    if (!this.terminals) return [];
    const limit = this.host.inboxPolicy().settledTerminalLimit;
    const at = this.index.settlingClock();
    const windowMs = (at.autoSettleAfterHours ?? 0) * 60 * 60_000;
    const settled: Array<{ sessionId: string; count: number; since: number }> = [];
    for (const sessionId of this.sessions()) {
      const count = this.count(sessionId);
      if (count === 0) continue;
      try {
        const row = indexRow(this.records.get(sessionId));
        if (row.state === "active" && !rowIsShelved(row, at)) continue;
        const since = row.settledOverride === "settled" ? (row.settledAt ?? row.updatedAt) : row.updatedAt + windowMs;
        settled.push({ sessionId, count, since });
      } catch {
        // A session that cannot be read is not closed on a guess.
      }
    }
    let total = settled.reduce((sum, entry) => sum + entry.count, 0);
    const closed: string[] = [];
    for (const entry of settled.sort((a, b) => a.since - b.since)) {
      if (total <= limit) break;
      try {
        const ended = await this.terminals.closeSession(entry.sessionId);
        this.recordClosed(entry.sessionId, Math.max(ended, entry.count), "limit");
        total -= entry.count;
        closed.push(entry.sessionId);
      } catch {
        // The host is out of reach; the next check tries again.
        break;
      }
    }
    if (closed.length > 0) await this.refresh();
    return closed;
  }
}
