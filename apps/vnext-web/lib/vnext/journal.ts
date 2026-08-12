import type { EngineEvent, Item, Session, Turn, TurnState, UsageSnapshot } from "@telar/engine-client";

/**
 * The client-side fold over protocol v2's journal.
 *
 * WHAT CHANGED FROM v1: the fold used to produce `{ prompt, text }` — one
 * string of accumulated prose per turn — because that is all the engine sent.
 * v2 carries a timeline, so a turn now owns an ordered list of ITEMS (tool
 * calls, reasoning, assistant messages) and streaming text lands on the item it
 * belongs to instead of being concatenated into one blob.
 *
 * THE FOLD IS THE ONLY SOURCE OF TRUTH FOR ORDER. Items sort by the event id
 * that opened them, never by timestamp: two events can share a millisecond, and
 * `at` is when the engine recorded a row rather than when the provider produced
 * it. The id is monotonic per session by construction.
 */

export type JournalItem = Item & {
  /** Deltas accumulated in arrival order. Empty for items that never stream. */
  streamedText: string;
  /** The event id that opened this item — the sort key, not a display value. */
  openedBy: number;
};

export type JournalTurn = {
  runId: string;
  prompt: string;
  state: TurnState;
  items: JournalItem[];
  /** The assistant's final text, as the engine recorded it on completion. */
  resultText: string;
  failure?: string;
  usage?: UsageSnapshot;
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

/**
 * Fold turns, the engine's item projection, and the event tail into a
 * renderable transcript.
 *
 * ITEMS COME FROM BOTH SIDES ON PURPOSE. The snapshot's `items` is what makes
 * opening a long session cheap — no replay from event 1 — while the event tail
 * is what makes a live turn stream. Applying the tail second means a row the
 * snapshot caught mid-flight is corrected by the events that followed it.
 */
export function projectJournal(turns: Turn[], items: Item[], events: EngineEvent[]): JournalTurn[] {
  const byRun = new Map<string, JournalTurn>(
    turns.map((turn) => [
      turn.runId,
      {
        runId: turn.runId,
        prompt: turn.input,
        state: turn.state,
        items: [],
        resultText: turn.resultText ?? "",
        ...(turn.failure ? { failure: turn.failure.message } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
      },
    ]),
  );
  const seenItems = new Map<string, JournalItem>();

  const upsert = (item: Item, openedBy: number): JournalItem | undefined => {
    const turn = byRun.get(item.runId);
    if (!turn) return undefined;
    const existing = seenItems.get(item.id);
    const merged: JournalItem = {
      ...item,
      streamedText: existing?.streamedText ?? "",
      openedBy: existing?.openedBy ?? openedBy,
    };
    seenItems.set(item.id, merged);
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) turn.items.push(merged);
    else turn.items[index] = merged;
    return merged;
  };

  // The snapshot first, so a session that has been running for an hour renders
  // without replaying its whole journal. Event id 0 is not a real id, so these
  // sort before anything the tail opens — which is the correct relative order
  // for rows that already existed when the page loaded.
  for (const item of items) upsert(item, 0);

  for (const event of events) {
    const turn = event.runId ? byRun.get(event.runId) : undefined;

    switch (event.type) {
      case "turn.accepted":
        if (!byRun.has(event.turn.runId)) {
          byRun.set(event.turn.runId, {
            runId: event.turn.runId,
            prompt: event.turn.input,
            state: event.turn.state,
            items: [],
            resultText: "",
          });
        }
        break;
      case "turn.claimed":
        if (turn) turn.state = "claimed";
        break;
      case "turn.started":
        if (turn) turn.state = "running";
        break;
      case "turn.requeued":
        if (turn) turn.state = "queued";
        break;
      case "turn.completed":
        if (turn) {
          turn.state = "completed";
          turn.resultText = event.resultText;
          if (event.usage) turn.usage = event.usage;
        }
        break;
      case "turn.failed":
        if (turn) {
          turn.state = "failed";
          turn.failure = event.message;
        }
        break;
      case "turn.stopped":
        if (turn) turn.state = "stopped";
        break;
      case "turn.ambiguous":
        if (turn) turn.state = "ambiguous";
        break;
      case "turn.discarded":
        if (turn) turn.state = "discarded";
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        upsert(event.item, event.id);
        break;
      case "content.delta": {
        // A delta for an item this client has not seen is DROPPED, not
        // buffered. It means the fold is missing the row that opened it, and
        // inventing a placeholder would render a message with no idea what
        // kind of row it belongs to. The next snapshot repairs it.
        const item = seenItems.get(event.itemId);
        if (item) item.streamedText += event.text;
        break;
      }
      case "usage.updated":
        if (turn) turn.usage = event.usage;
        break;
      default:
        // Every other family (runtime.*, request.*, task.*, browser.*, mcp.*)
        // is contract but not yet rendered. Ignoring them here is deliberate;
        // dropping them at PARSE time would not be, which is why
        // safeParseEvent only skips rows it cannot understand at all.
        break;
    }
  }

  for (const turn of byRun.values()) {
    turn.items.sort((left, right) => left.openedBy - right.openedBy || left.startedAt - right.startedAt);
  }
  return [...byRun.values()];
}

export function isActiveTurn(state: TurnState): boolean {
  return state === "queued" || state === "claimed" || state === "running";
}

/**
 * The text a rendered item should show.
 *
 * Streamed deltas WIN over the stored detail while a turn is live, because the
 * engine only folds accumulated text into `items.json` when the item closes —
 * writing the whole document per token would be absurd. Once closed, the two
 * agree and either is correct.
 */
export function itemText(item: JournalItem): string {
  if (item.streamedText) return item.streamedText;
  if (item.detail.type === "assistant_message" || item.detail.type === "reasoning") return item.detail.text;
  if (item.detail.type === "user_message") return item.detail.text;
  return "";
}

/** A one-line label for a collapsed row, preferring what the engine stored. */
export function itemLabel(item: JournalItem): string {
  if (item.title) return item.title;
  switch (item.detail.type) {
    case "command_execution":
      return item.detail.command.command || "command";
    case "file_change":
      return item.detail.change.path;
    case "file_read":
      return item.detail.read.path;
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "browser_action":
      return item.detail.call.name;
    case "web_search":
      return item.detail.query;
    case "error":
      return item.detail.error.message;
    default:
      return item.detail.type;
  }
}

/** Rows that render as a tool card rather than as prose. */
export function isToolItem(item: JournalItem): boolean {
  return (
    item.detail.type === "command_execution" ||
    item.detail.type === "file_change" ||
    item.detail.type === "file_read" ||
    item.detail.type === "mcp_tool_call" ||
    item.detail.type === "dynamic_tool_call" ||
    item.detail.type === "web_search" ||
    item.detail.type === "browser_action"
  );
}

/** The output body of a finished tool call, when it has one. */
export function toolOutput(item: JournalItem): string | undefined {
  if (item.detail.type === "command_execution") return item.detail.command.outputPreview;
  if (item.detail.type === "mcp_tool_call" || item.detail.type === "dynamic_tool_call") {
    const output = item.detail.call.output;
    return typeof output === "string" ? output : output === undefined ? undefined : JSON.stringify(output, null, 2);
  }
  return undefined;
}

export type { Session };
