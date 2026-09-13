import type { SnapshotWindow } from "@telar/engine-client";
import { appendJournalEvents } from "./journal";
import { hydrateSession, tailSession, mergeRows, type HydratedSession, type SessionSyncApi } from "./session-sync";

/** A host/session owns the cursor and its projection together. Surface mounts
 * borrow this state; they never advance a cursor without accepting its rows.
 * Reads coalesce, failures retain the last committed view, and dormant entries
 * are bounded so visiting conversations cannot retain unlimited transcripts.
 */
export class SessionConnection {
  private current?: HydratedSession;
  private flight?: Promise<HydratedSession>;
  constructor(private readonly api: SessionSyncApi, private readonly id: string, private readonly window?: SnapshotWindow) {}
  read(): Promise<HydratedSession> {
    if (this.flight) return this.flight;
    this.flight = this.refresh().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  peek(): HydratedSession | undefined { return this.current; }
  private async refresh(): Promise<HydratedSession> {
    const previous = this.current;
    if (!previous) {
      const next = await hydrateSession(this.api, this.id, this.window);
      this.current = next;
      return next;
    }
    const update = await tailSession(this.api, this.id, previous.cursor, this.window);
    const snapshot = update.snapshot;
    const baseCursor = snapshot?.cursor;
    /**
     * NOTHING ARRIVED, SO NOTHING IS REBUILT (#407). A quiet tail brings an
     * empty page and no companion snapshot, and both the merge and the filter
     * below are then provably no-ops — but each returns a NEW array, which is a
     * new value to every `useState` downstream and a full re-fold of the
     * transcript once a second for a conversation nobody is typing into.
     */
    const events =
      update.events.length === 0 && baseCursor === undefined
        ? previous.events
        : appendJournalEvents(previous.events, update.events).filter((event) => baseCursor === undefined || event.id > baseCursor);
    const patched = [...events].reverse().find((event) => event.type === "session.updated");
    const next: HydratedSession = {
      ...previous,
      ...(snapshot ? { ...snapshot,
        turns: mergeRows(previous.turns, snapshot.turns, (row) => row.runId),
        items: mergeRows(previous.items, snapshot.items, (row) => row.id),
        tasks: mergeRows(previous.tasks, snapshot.tasks, (row) => row.id), page: previous.page,
      } : {}),
      ...(patched?.type === "session.updated" ? { session: patched.session } : {}),
      events, cursor: Math.max(previous.cursor, update.cursor, baseCursor ?? 0),
    };
    this.current = next;
    return next;
  }
}
const connections = new Map<string, SessionConnection>();
export function sessionConnection(host: string, api: SessionSyncApi, id: string, window?: SnapshotWindow): SessionConnection {
  const key = JSON.stringify([host, id, window ?? null]);
  let connection = connections.get(key);
  if (!connection) connection = new SessionConnection(api, id, window);
  connections.delete(key); connections.set(key, connection);
  if (connections.size > 32) connections.delete(connections.keys().next().value!);
  return connection;
}
