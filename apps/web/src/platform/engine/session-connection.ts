import type { EngineEvent, SnapshotWindow, Task } from "@telar/engine-client";
import { appendJournalEvents } from "./journal";
import { hydrateSession, tailSession, mergeRows, type HydratedSession, type SessionSyncApi } from "./session-sync";

/** Owns a host/session's cursor and projection; mounts borrow it, and failures keep the last committed view. */
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
    // Nothing arrived: reuse the previous array so downstream state and the fold don't churn.
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
        page: previous.page,
      } : {}),
      tasks: withTaskEvents(snapshot ? mergeRows(previous.tasks, snapshot.tasks, (row) => row.id) : previous.tasks, update.events),
      ...(patched?.type === "session.updated" ? { session: patched.session } : {}),
      events, cursor: Math.max(previous.cursor, update.cursor, baseCursor ?? 0),
    };
    this.current = next;
    return next;
  }
}

// A windowed snapshot omits tasks whose turn scrolled out, so their ending reaches the cockpit only as an event.
function withTaskEvents(tasks: Task[], events: readonly EngineEvent[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const event of events) {
    if (event.type !== "task.started" && event.type !== "task.progress" && event.type !== "task.completed") continue;
    const held = byId.get(event.task.id);
    if (!held || event.task.updatedAt > held.updatedAt) byId.set(event.task.id, event.task);
  }
  return byId.size === tasks.length && tasks.every((task) => byId.get(task.id) === task) ? tasks : [...byId.values()];
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
