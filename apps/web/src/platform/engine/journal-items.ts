import { displayToolName, type Item, type TurnState } from "@telar/engine-client";
import type { JournalItem, JournalTurn } from "@/platform/engine/journal";

export function isActiveTurn(state: TurnState): boolean {
  return state === "queued" || state === "claimed" || state === "running";
}

/** Whether an open `context_compaction` item is on the turn: the one definition the working
 *  indicator, the compact button and the send-now gate share. */
export function isCompacting(turn?: JournalTurn): boolean {
  return Boolean(turn?.items.some((item) => item.detail.type === "context_compaction" && item.status === "inProgress"));
}

// While open the stream is the text: the engine folds text into the item only on close.
// Once closed the stored detail wins even when shorter, so a provider can revise its answer.
export function itemText(item: JournalItem): string {
  if (item.status === "inProgress" && item.streamedText) return item.streamedText;
  if (item.streamedText && !storedText(item)) return item.streamedText;
  return storedText(item);
}

// Whichever prefix reaches further wins, with its watermark: a companion snapshot repeats the held one,
// a reconnect brings a longer one. Safe because the engine never un-streams text.
export function pickPrefix(existing: JournalItem | undefined, incoming: Item): Pick<JournalItem, "streamedText" | "streamedThrough"> {
  const held = existing?.streamedText ?? "";
  const heldThrough = existing?.streamedThrough;
  const offered = incoming.streamed ?? "";
  const offeredThrough = incoming.streamedThrough;
  // No watermark on the offer — an engine too old to send one. Its prefix
  // cannot be reconciled with a tail, so it is only usable as a first seed.
  if (offeredThrough === undefined) {
    return held ? { streamedText: held, ...(heldThrough === undefined ? {} : { streamedThrough: heldThrough }) } : { streamedText: offered };
  }
  if (heldThrough !== undefined && heldThrough >= offeredThrough) {
    return { streamedText: held, streamedThrough: heldThrough };
  }
  // A held prefix with no watermark came from an old engine or an unseeded
  // fold; the offered one is reconcilable, so it wins outright.
  return { streamedText: offered, streamedThrough: offeredThrough };
}

/** What the engine has FOLDED for this item — empty until it closes. */
function storedText(item: JournalItem): string {
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
      // The stored name is fully qualified for approval correlation; the contract owns how to shorten it.
      return displayToolName(item.detail.call.name);
    case "web_search":
      return item.detail.query;
    case "error":
      return item.detail.error.message;
    // The label IS the row for a one-line notice ("Opened a tab — …").
    case "unknown":
      return item.detail.label ?? item.detail.type;
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
