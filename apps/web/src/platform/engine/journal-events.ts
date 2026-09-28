import type { EngineEvent,TurnState } from "@telar/engine-client";

/** Merges a cursor page without duplicating durable journal records. */
export function appendJournalEvents(existing: EngineEvent[], incoming: EngineEvent[]): EngineEvent[] {
  const events = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((left, right) => left.id - right.id);
}

export function journalCursor(events: EngineEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.id), 0);
}

export function isActiveTurn(state: TurnState): boolean {
  return state === "queued" || state === "claimed" || state === "running";
}
