/**
 * WHAT A LAP COSTS THE LAPS AFTER IT — tool results, compacted (#563).
 *
 * ── THE MEASUREMENT THIS FILE EXISTS FOR ────────────────────────────────────
 * One turn on the owner's thread — "find the thread about the dictation
 * feature" — ran 16 laps and cost 166,557 input tokens. Nothing about it was
 * pathological: it called `sessions_find` nine times, `sessions_outline` three
 * and `sessions_answer` four, and every lap resent the whole history plus every
 * result so far. Cost is therefore QUADRATIC IN LAPS, and the constant is the
 * results: 58,019 characters of them in one prompt, pretty-printed JSON at two
 * spaces, the two largest outlines 7.6k and 6.4k on their own.
 *
 * ── TWO CUTS, AND THEY ARE DIFFERENT KINDS OF CUT ───────────────────────────
 *   1. MINIFIED ON THE WAY IN. `tool-kit.ts`'s `json` pretty-prints because a
 *      PERSON reads the transcript, and two-space JSON is about a third larger
 *      than the same object compact. The model does not need the whitespace, so
 *      the result is minified before it becomes a `ToolMessage` — which means
 *      the CHECKPOINT holds the compact form and every later lap is cheaper for
 *      free. Not parseable as JSON? Then it is somebody's prose and is left
 *      exactly as it is.
 *   2. STUBBED ON THE WAY OUT. A result is READ by the lap that follows it and
 *      almost never read again: by lap 12 the nine `sessions_find` answers from
 *      laps 1–9 are nine lists the model has already chosen from. So when a
 *      LATER lap of the same turn is sent, every result but the newest block's
 *      collapses to one line — the tool's name and a count/ids summary derived
 *      from the answer's own shape, or its first 160 characters when it has no
 *      shape to derive from.
 *
 * ── WHAT IS DELIBERATELY NOT COMPACTED ──────────────────────────────────────
 * THE NEWEST BLOCK, ever: it is the answer to the question the model asked one
 * superstep ago, and stubbing it would be answering with a summary of the thing
 * it just asked for.
 *
 * RESULTS FROM EARLIER TURNS. The unit here is the LAP, inside one turn, and a
 * turn boundary is the last human message. Older TURNS are a different problem
 * with a different answer — one deterministic line per turn, which is #541 part
 * F's summary compaction rather than this one.
 *
 * AND THE TRANSCRIPT, WHICH KEEPS EVERYTHING. `agent_rows` is written from the
 * tool's own answer before any of this runs, so the cockpit still shows the
 * whole 7.6k outline. This file shapes what the MODEL sees; `thread-log.ts`
 * holds what a person reads. That split is `trim.ts`'s rule and it is the same
 * rule.
 */
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { firstLine } from "../turn-summary";

/** How much of a shapeless result a stub carries. Enough to recognise which
 *  answer it was; nowhere near enough to work from, which is the point — the
 *  tool is one call away and the transcript has it whole. */
export const STUB_HEAD_CHARS = 160;

/** How many ids a stub names before it starts counting instead. Three is enough
 *  to recognise a list you have already seen and short enough to stay one
 *  line. */
const STUB_IDS = 3;

/* ------------------------------------------------------------------ *
 * 1. Minified on the way in.
 * ------------------------------------------------------------------ */

/**
 * The same answer, without the whitespace a person was going to read.
 *
 * ANYTHING THAT IS NOT JSON COMES BACK UNTOUCHED, and that is most refusals:
 * `err()` writes sentences, and a sentence re-encoded through `JSON.parse`
 * would either throw or come back quoted. A result that `bounded` clipped is
 * not JSON any more either — its tail was cut — so it falls through the same
 * door rather than being silently mangled.
 */
export function minifyToolResult(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    const compact = JSON.stringify(JSON.parse(trimmed));
    // `JSON.stringify(undefined)` is `undefined`, and a value that round-trips
    // LARGER is not a saving worth making.
    return compact !== undefined && compact.length < text.length ? compact : text;
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Stubbed on the way out.
 * ------------------------------------------------------------------ */

/**
 * ONE LINE STANDING IN FOR ONE RESULT.
 *
 * THE SUMMARY IS DERIVED FROM THE ANSWER'S OWN SHAPE rather than written by
 * hand per tool. Every wall on this engine answers with an object whose arrays
 * are the rows — `{sessions: [...]}`, `{notes: [...]}`, `{turns: [...]}` — so
 * "12 sessions: session_a, session_b, session_c (+9)" is something the JSON
 * already says, and a table of per-tool summarisers would be twenty-one places
 * to forget to update. A result with no arrays in it has no count to give and
 * falls back to its opening.
 */
export function toolResultStub(name: string, text: string): string {
  return `[earlier lap] ${name}: ${countSummary(text) ?? firstLine(text, STUB_HEAD_CHARS)}`;
}

function countSummary(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) return countOf(value, "rows");
  if (!value || typeof value !== "object") return undefined;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, rows]) => countOf(rows, key));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function countOf(rows: readonly unknown[], key: string): string {
  const ids = rows.map(idOf).filter((id): id is string => id !== undefined).slice(0, STUB_IDS);
  if (ids.length === 0) return `${rows.length} ${key}`;
  const rest = rows.length - ids.length;
  return `${rows.length} ${key}: ${ids.join(", ")}${rest > 0 ? ` (+${rest})` : ""}`;
}

/** What one row is CALLED, in the vocabulary these walls actually use. The
 *  order is the order of specificity: a row with both an `id` and a `name` is
 *  identified by the id, because that is what the next call takes. */
function idOf(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  for (const field of ["id", "sessionId", "runId", "noteId", "subscriptionId", "requestId", "name"]) {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * THE HISTORY THIS LAP SENDS — every tool result from an EARLIER lap of the
 * SAME turn, as one line each.
 *
 * THE TURN BOUNDARY IS THE LAST HUMAN MESSAGE, which is what a turn starts
 * with: `runTurn` streams `{messages: [new HumanMessage(...)]}` and a resumed
 * approval adds nothing, so everything after the last human message is this
 * turn's laps. A conversation whose checkpoint holds no human message at all
 * (an older build, a truncated file) is treated as one long turn rather than
 * refused — the stub is lossy, not wrong.
 *
 * THE NEWEST CONTIGUOUS RUN OF RESULTS SURVIVES. It is the answer to the call
 * the model made one superstep ago.
 *
 * A STUB THAT IS NOT SHORTER THAN WHAT IT REPLACES IS NOT APPLIED. A one-word
 * result exists ("true", "Deleted \"x\".") and spending 30 characters of
 * scaffolding to save 4 is the opposite of the point.
 */
export function compactToolResults(messages: readonly BaseMessage[]): BaseMessage[] {
  const turnStart = lastIndexOfType(messages, "human") + 1;
  const newest = newestResultRun(messages);
  if (newest <= turnStart) return [...messages];
  const names = toolCallNames(messages);
  return messages.map((message, index) => {
    if (index < turnStart || index >= newest || message.getType() !== "tool") return message;
    const result = message as ToolMessage;
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const stub = toolResultStub(names.get(result.tool_call_id) ?? "tool", text);
    return stub.length < text.length ? new ToolMessage({ tool_call_id: result.tool_call_id, content: stub }) : message;
  });
}

/** Where the newest unbroken run of `tool` messages begins, or the end of the
 *  list when there is none. */
function newestResultRun(messages: readonly BaseMessage[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.getType() !== "tool") index -= 1;
  if (index < 0) return messages.length;
  while (index > 0 && messages[index - 1]!.getType() === "tool") index -= 1;
  return index;
}

/** Which tool each call id asked for, read off the assistant messages that
 *  asked. A result whose call has fallen out of the history keeps the neutral
 *  word `tool` rather than losing its stub. */
function toolCallNames(messages: readonly BaseMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.getType() !== "ai") continue;
    for (const call of (message as AIMessage).tool_calls ?? []) {
      if (call.id) names.set(call.id, call.name);
    }
  }
  return names;
}

function lastIndexOfType(messages: readonly BaseMessage[], type: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.getType() === type) return index;
  }
  return -1;
}
