import type { EngineEvent, EngineTurn, TurnState } from "@telar/engine-client";

export type JournalTurn = {
  runId: string;
  prompt: string;
  text: string;
  state: TurnState;
  failure?: string;
};

/** Merges a cursor page without duplicating durable journal records. */
export function appendJournalEvents(existing: EngineEvent[], incoming: EngineEvent[]): EngineEvent[] {
  const events = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((left, right) => left.id - right.id);
}

export function journalCursor(events: EngineEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.id), 0);
}

export function projectJournal(turns: EngineTurn[], events: EngineEvent[]): JournalTurn[] {
  const byRun = new Map<string, JournalTurn>(
    turns.map((turn) => [
      turn.runId,
      {
        runId: turn.runId,
        prompt: turn.text,
        text: turn.result?.text ?? "",
        state: turn.state,
        failure: turn.failure?.message,
      },
    ]),
  );
  for (const event of events) {
    if (!event.runId) continue;
    const turn = byRun.get(event.runId);
    if (!turn) continue;
    // The durable journal is the live queue projection.  Do not wait for a
    // later snapshot to show a state change: doing so can make a claimed or
    // running turn look queued while a request is in flight.
    if (event.type === "turn.accepted" || event.type === "turn.requeued") turn.state = "queued";
    if (event.type === "turn.claimed") turn.state = "claimed";
    if (event.type === "turn.running") turn.state = "running";
    if (event.type === "turn.text" && typeof event.data.text === "string") turn.text += event.data.text;
    if (event.type === "turn.final") {
      turn.state = "completed";
      if (typeof event.data.text === "string") turn.text = event.data.text;
    }
    if (event.type === "turn.error") {
      turn.state = "failed";
      if (typeof event.data.message === "string") turn.failure = event.data.message;
    }
    if (event.type === "turn.stopped") turn.state = "stopped";
    if (event.type === "turn.ambiguous") turn.state = "ambiguous";
    if (event.type === "turn.discarded") turn.state = "discarded";
  }
  return [...byRun.values()];
}

export function isActiveTurn(state: TurnState): boolean {
  return state === "queued" || state === "claimed" || state === "running";
}
