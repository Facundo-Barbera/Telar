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
 * with a different answer — `foldOldTurns` at the foot of this file, one
 * deterministic line per turn, which is #541 part F's summary compaction.
 *
 * AND THE TRANSCRIPT, WHICH KEEPS EVERYTHING. `agent_rows` is written from the
 * tool's own answer before any of this runs, so the cockpit still shows the
 * whole 7.6k outline. This file shapes what the MODEL sees; `thread-log.ts`
 * holds what a person reads. That split is `trim.ts`'s rule and it is the same
 * rule.
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
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

/* ------------------------------------------------------------------ *
 * 3. Older turns, one deterministic line each — #541 part F.
 * ------------------------------------------------------------------ */

/**
 * HOW MUCH OF ONE FOLDED TURN SURVIVES — the three fields `turn-summary.ts`
 * already settled on, and the same numbers rather than a second opinion: the
 * first line of what was asked, what it did, and the head of what it answered.
 */
export const FOLD_INPUT_CHARS = 120;
export const FOLD_ANSWER_CHARS = 200;

/**
 * THE FOLDED BLOCK'S OWN CEILING.
 *
 * A line per turn is fixed-size by construction, but "fixed-size, forever" is
 * still unbounded — a thread with nine hundred turns would carry nine hundred
 * lines. So the block keeps the NEWEST lines that fit and counts the rest in a
 * sentence, which is the bound every page in this engine has. The lines it
 * leaves out are not lost: `agent_rows` holds every turn whole and `recall`
 * searches it.
 */
export const FOLD_BLOCK_CHARS = 12_000;

/** The stamp that says a message is the engine's fold rather than something
 *  anybody said. See `foldOldTurns` for what it is for. */
export const FOLD_MARKER = "telar_turn_fold";

const FOLD_ASK = "What happened earlier in this conversation?";
const FOLD_LEAD =
  "Earlier turns, one line each — a record, not a transcript. The thread holds them whole and `recall` searches them.";

/**
 * ONE TURN, AS THE LINE THAT REPLACES IT.
 *
 * DETERMINISTIC AND MODEL-FREE (#541, owner decision 1). The Agent never writes
 * prose about its own history: a summary a model wrote is a summary that can be
 * re-summarised, drift and cost a call. The projection that answers "what was
 * that turn" for every OTHER conversation on this engine is `summariseTurn` —
 * three fields and a fold — and this is the same three fields over LangGraph
 * messages instead of over a journal.
 */
export function foldedTurnLine(turn: readonly BaseMessage[]): string {
  const asked = turn.find((message) => message.getType() === "human");
  const calls: string[] = [];
  let answer = "";
  for (const message of turn) {
    if (message.getType() !== "ai") continue;
    for (const call of (message as AIMessage).tool_calls ?? []) calls.push(call.name);
    const said = typeof message.content === "string" ? message.content : "";
    if (said.trim()) answer = said;
  }
  const did = calls.length > 0 ? ` · ${countCalls(calls)}` : "";
  const said = answer.trim() ? ` · ${firstLine(answer, FOLD_ANSWER_CHARS)}` : "";
  return `· ${firstLine(contentOf(asked), FOLD_INPUT_CHARS) || "(nothing said)"}${did}${said}`;
}

/** `sessions_find ×9, sessions_outline ×3` — what the turn DID, each tool named
 *  once. Nine repetitions of a name and a reader counting to nine are the same
 *  fact; only one of them is worth the characters. */
function countCalls(calls: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

function contentOf(message: BaseMessage | undefined): string {
  if (!message) return "";
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

/** Is this one of the two messages a fold produces? */
export function isFold(message: BaseMessage): boolean {
  return message.additional_kwargs?.[FOLD_MARKER] === true;
}

/**
 * THE OLDEST TURNS, REPLACED BY THEIR LINES — the summary compaction that takes
 * the 120k trim's DROP (#541 part F).
 *
 * ── WHAT THIS REPLACES, AND WHY DROPPING WAS WRONG ──────────────────────────
 * `trim.ts` kept the newest contiguous tail that fitted and let the rest fall
 * off the top. That is safe and it is amnesia: the conversation in which the
 * person explained what they wanted is exactly the part furthest from the end.
 * A line per turn costs about 250 characters against the several thousand a
 * turn really weighs, so forty turns of context become ten thousand characters
 * instead of a hundred thousand — and the trim stays behind it as a backstop
 * that should now never fire.
 *
 * ── A PAIR OF MESSAGES, NOT A SYSTEM BLOCK ──────────────────────────────────
 * The Agent's model is whatever OpenCode Go is pointed at, and Go proxies both
 * an OpenAI-shaped route and an Anthropic-shaped one. A `system` message in the
 * MIDDLE of a conversation is ordinary on the first and is not a thing the
 * second has — its system prompt is a separate top-level field, which is
 * exactly the shape difference that cost a model in #549. A HUMAN message
 * followed by an AI one is the shape both routes take without a per-route
 * branch, so the fold asks a question and answers it. Both halves carry
 * `FOLD_MARKER`, so a reader can tell the engine's words from anybody's.
 *
 * ── A SUMMARY IS NEVER SUMMARISED, AND IT IS STRUCTURAL ─────────────────────
 * This is a PROJECTION of the raw turns, recomputed from them on every lap and
 * never persisted into the checkpoint — so a fold's output is never a fold's
 * input, and "never re-summarise a summary" is a property of the shape rather
 * than a check that could be forgotten. Any fold message found in the input is
 * therefore stale and is dropped before the turns are read, which is what makes
 * the function idempotent.
 *
 * ── AND THE NEWEST TURNS ARE VERBATIM ───────────────────────────────────────
 * Folding stops as soon as what is left fits the budget, oldest first, and the
 * turn being answered is never folded. A conversation inside its budget comes
 * back untouched, which is every ordinary one.
 */
export function foldOldTurns(
  messages: readonly BaseMessage[],
  options: { budgetChars: number; reservedChars?: number },
): { messages: BaseMessage[]; folded: number } {
  const raw = messages.filter((message) => !isFold(message));
  const turns = splitTurns(raw);
  const lines: string[] = [];

  let spent = (options.reservedChars ?? 0) + cost(raw);
  let folded = 0;
  while (spent > options.budgetChars && folded < turns.length - 1) {
    const turn = turns[folded]!;
    lines.push(foldedTurnLine(turn));
    spent -= cost(turn);
    folded += 1;
  }
  if (folded === 0) return { messages: [...raw], folded: 0 };
  return { messages: [...foldBlock(lines), ...turns.slice(folded).flat()], folded };
}

/** The conversation as turns, each beginning at a human message. Anything
 *  before the first human message — which should be nothing — is its own
 *  leading group rather than being dropped. */
function splitTurns(messages: readonly BaseMessage[]): BaseMessage[][] {
  const turns: BaseMessage[][] = [];
  for (const message of messages) {
    if (message.getType() === "human" || turns.length === 0) turns.push([message]);
    else turns.at(-1)!.push(message);
  }
  return turns;
}

/** The pair, carrying the newest lines that fit and a count of the rest. */
function foldBlock(lines: readonly string[]): BaseMessage[] {
  const kept: string[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (kept.length > 0 && chars + line.length > FOLD_BLOCK_CHARS) break;
    kept.unshift(line);
    chars += line.length + 1;
  }
  const missing = lines.length - kept.length;
  const body = [
    FOLD_LEAD,
    ...(missing > 0 ? [`(${missing} turn${missing === 1 ? "" : "s"} older than these are in the thread only — use recall.)`] : []),
    ...kept,
  ].join("\n");
  const stamp = { additional_kwargs: { [FOLD_MARKER]: true } };
  return [new HumanMessage({ content: FOLD_ASK, ...stamp }), new AIMessage({ content: body, ...stamp })];
}

/** What a run of messages costs, on `trim.ts`'s own arithmetic so the two
 *  cannot disagree about whether a conversation fits. */
function cost(messages: readonly BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const calls = (message as AIMessage).tool_calls;
    total += content.length + (calls ? JSON.stringify(calls).length : 0) + 32;
  }
  return total;
}
