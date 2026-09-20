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
 *      laps 1–9 are nine lists the model has already chosen from. So on every
 *      later send, every result but the newest block's collapses to one line —
 *      the tool's name and a count/ids summary derived from the answer's own
 *      shape, or its first 160 characters when it has no shape to derive from.
 *
 * ── AND THE STUB IS MONOTONIC (#563 step 1) ─────────────────────────────────
 * The stub used to be scoped to the turn that made it, so the next turn sent
 * those results in full again and rewrote a quarter of the prompt backwards. It
 * is now scoped to "everything but the newest run", so a result goes full →
 * stub ONCE and never back, and the divergence point a prefix cache stops at is
 * always the second-newest result — lap to lap and across turn boundaries
 * alike. `compactToolResults` below has the measurement and the cost.
 *
 * ── WHAT IS DELIBERATELY NOT COMPACTED ──────────────────────────────────────
 * THE NEWEST BLOCK, ever: it is the answer to the question the model asked one
 * superstep ago, and stubbing it would be answering with a summary of the thing
 * it just asked for.
 *
 * WHOLE OLD TURNS ARE STILL A DIFFERENT PROBLEM. A stub keeps the shape of the
 * conversation — every call, every answer, one line each; the answer to "this
 * thread is forty turns long" is `foldOldTurns` at the foot of this file, one
 * deterministic line per TURN, which is #541 part F's summary compaction.
 *
 * AND THE TRANSCRIPT, WHICH KEEPS EVERYTHING. `agent_rows` is written from the
 * tool's own answer before any of this runs, so the cockpit still shows the
 * whole 7.6k outline. This file shapes what the MODEL sees; `thread-log.ts`
 * holds what a person reads. That split is `trim.ts`'s rule and it is the same
 * rule.
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { firstLine } from "../turn-summary";
import { assistantText } from "./content";
import { ERA_TURNS, type EraStore, type FoldedTurn } from "./eras";

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
 * THE HISTORY THIS LAP SENDS — every tool result but the newest run's, as one
 * line each.
 *
 * ── WHY THE SCOPE IS "EVERYTHING BUT THE NEWEST", NOT "THIS TURN" (#563) ────
 * It used to be this turn's laps: the lower bound was the last human message,
 * so a stub was scoped to the turn that made it. On the NEXT turn those results
 * were no longer "this turn's" and were sent IN FULL AGAIN — and a prefix cache
 * matches from the front and stops at the first byte that differs, so
 * re-expanding a stub did not cost the expanded bytes, it cost EVERY BYTE AFTER
 * THEM. Measured from the socket at byte 17,125 of a 24,072-byte prompt on turn
 * 2 and 24,241 of 31,192 on turn 3: 22–29% of each prompt downstream of a
 * rewrite, and the missed tail roughly constant while the prompt grows.
 *
 * WITHOUT THE LOWER BOUND EACH RESULT GOES FULL → STUB EXACTLY ONCE, at the lap
 * after the one that read it, and never back. History becomes append-shaped in
 * the only sense a prefix cache cares about: the divergence point is always the
 * second-newest result run, on every lap and across every turn boundary.
 *
 * THE COST, SAID PLAINLY: a later turn can no longer re-read an earlier turn's
 * full result — it sees the stub. What makes that acceptable rather than lossy
 * is that the stub names the tool and the first three ids, the tool is one call
 * away, `agent_rows` holds every answer whole and `recall` searches it, and
 * `foldOldTurns` was going to reduce those turns to one line each anyway once
 * the conversation passed its budget. The change is WHEN, not WHETHER.
 *
 * THE NEWEST CONTIGUOUS RUN OF RESULTS SURVIVES. It is the answer to the call
 * the model made one superstep ago.
 *
 * A STUB THAT IS NOT SHORTER THAN WHAT IT REPLACES IS NOT APPLIED. A one-word
 * result exists ("true", "Deleted \"x\".") and spending 30 characters of
 * scaffolding to save 4 is the opposite of the point.
 */
/**
 * A CALL THE MODEL MADE THAT NOTHING EVER ANSWERED, ANSWERED (owner, 2026-09-17).
 *
 * WHAT LEFT ONE BEHIND: a turn that ended between the model asking for a tool
 * and the tools node writing its result — the recursion limit of the build
 * before #570 threw exactly there, and a crash or a cancel can still. The
 * checkpoint then holds an assistant message with `tool_calls` followed by a
 * human message, and every route Go serves refuses that prompt with a 400
 * ("an assistant message with 'tool_calls' must be followed by tool
 * messages"). Since the checkpoint is the conversation, every LATER turn sent
 * it again and failed the same way: three in a row on the owner's thread, the
 * Agent mute until a reset.
 *
 * THE REPAIR IS A RESULT, NOT A DELETION. Dropping the assistant message
 * would drop what it said beside the call; answering the call with one line
 * that says it was never run keeps the history honest and the API satisfied.
 * Applied to what is SENT, never written back to the checkpoint — the same
 * rule as every other step in this file, and the reason a repaired thread
 * still shows the gap in the transcript.
 */
export const ORPHANED_CALL_RESULT = "[this call was never run: the turn ended before it could be]";

export function answerOrphanedCalls(messages: readonly BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    out.push(message);
    const calls = message.getType() === "ai" ? ((message as AIMessage).tool_calls ?? []) : [];
    if (calls.length === 0) continue;
    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messages[next]!.getType() === "tool"; next += 1) {
      answered.add((messages[next] as ToolMessage).tool_call_id);
    }
    for (const call of calls) {
      if (call.id && !answered.has(call.id)) out.push(new ToolMessage({ tool_call_id: call.id, content: ORPHANED_CALL_RESULT }));
    }
  }
  return out;
}

export function compactToolResults(messages: readonly BaseMessage[]): BaseMessage[] {
  const newest = newestResultRun(messages);
  // Nothing ahead of the newest run: a conversation with no results at all, or
  // one that is a single run of them.
  if (newest <= 0) return [...messages];
  const names = toolCallNames(messages);
  return messages.map((message, index) => {
    if (index >= newest || message.getType() !== "tool") return message;
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

/**
 * HOW FAR DOWN A FOLD GOES — the LOW-WATER MARK (#567).
 *
 * ── THE BUG THIS NUMBER IS ─────────────────────────────────────────────────
 * The fold used to stop the moment what was left fitted, which is the SAME
 * number that triggered it. So a conversation that had saturated once folded
 * one turn, landed a few hundred characters under the ceiling, and was over it
 * again on the next message: six consecutive turns measured 119382, 119570,
 * 94489, 102165, 119512 and 109347 against a 120k budget. The engine was
 * compacting on almost every turn and the meter never moved — which reads as
 * "it is not compacting" and, worse, leaves a multi-lap turn no room to run in.
 *
 * ── SO THE TRIGGER AND THE TARGET ARE DIFFERENT NUMBERS ────────────────────
 * Over `budgetChars` starts a fold; the fold then keeps going until what is
 * left is under `budgetChars * FOLD_TARGET_RATIO`. At 120k that is a floor of
 * 72k, so one fold buys about 48k characters of room, the meter visibly drops,
 * and the turns after it do not re-fold. The gap between the two marks is the
 * hysteresis — the reason this is a ratio and not a second constant.
 *
 * A conversation BETWEEN the marks is not folded: the trigger is the ceiling,
 * never the floor, so a history sitting at 70% is left exactly as it is.
 */
export const FOLD_TARGET_RATIO = 0.6;

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
    // EITHER SHAPE — on the two Anthropic/Responses routes the model's answer
    // arrives as text BLOCKS, and reading it as a string meant a folded turn
    // from those routes lost the one sentence it was summarising. See
    // `./content.ts`; `agent-runtime-parity.test.ts` folds on all three.
    const said = assistantText(message.content);
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
 * This is a PROJECTION of the raw turns and is never persisted INTO THE
 * CHECKPOINT — so a fold's output is never a fold's input, and "never
 * re-summarise a summary" is a property of the shape rather than a check that
 * could be forgotten. Any fold message found in the input is therefore stale and
 * is dropped before the turns are read, which is what makes the function
 * idempotent.
 *
 * ── AND THE NEWEST TURNS ARE VERBATIM ───────────────────────────────────────
 * Folding runs oldest first and stops at the LOW-WATER MARK — see
 * `FOLD_TARGET_RATIO` for why that is not the mark that triggered it — and the
 * turn being answered is never folded. A conversation inside its budget comes
 * back untouched, which is every ordinary one.
 *
 * ── THE FOLD IS DERIVED ONCE PER TURN, NOT ONCE PER LAP (#599) ──────────────
 * `eras` is where the settled part of the fold is kept: a run of turns entirely
 * behind the frontier, holding the line for each and what each weighed. Without
 * it this function stringifies every message in the conversation to weigh it and
 * rewrites every folded line, on every lap of every turn — the same old history
 * folded 119 times on the owner's thread. With it, an era is derived ONCE and
 * only the tail behind the window is computed fresh. See `./eras.ts`.
 *
 * WHAT IS STORED IS THE FOLD, NEVER THE TRANSCRIPT. The rows and the FTS index
 * are untouched, and `recall` still finds a word that occurs only in a turn old
 * enough to have been summarised — which is the case the owner named and
 * `agent-eras.test.ts` proves.
 *
 * WITHOUT AN `eras` PORT THIS BEHAVES EXACTLY AS IT DID, and it must: the port
 * is a cache of a deterministic projection, so the messages it returns and the
 * turn it stops at cannot depend on whether one was passed. The suite asserts
 * that equality rather than trusting it.
 */
export function foldOldTurns(
  messages: readonly BaseMessage[],
  options: { budgetChars: number; reservedChars?: number; eras?: EraStore },
): { messages: BaseMessage[]; folded: number } {
  const raw = messages.filter((message) => !isFold(message));
  const reserved = options.reservedChars ?? 0;
  const turns = splitTurns(raw);
  /**
   * WHAT EACH TURN WEIGHS, from the store where the store has it.
   *
   * This is the whole saving: a weight is `JSON.stringify` over every message
   * of a turn, and the turns an era covers are closed forever. One pass, so a
   * turn is never weighed twice — the loop below subtracts from this array
   * rather than re-costing what it folds.
   */
  const settled = settledTurns(options.eras, turns.length);
  const weights = turns.map((turn, index) => settled[index]?.chars ?? cost(turn));
  // THE CEILING IS THE TRIGGER AND NOTHING ELSE. A conversation between the two
  // marks is one a previous fold already made room in, and folding it again
  // would spend its history to buy room it has.
  let verbatim = reserved + weights.reduce((total, chars) => total + chars, 0);
  if (verbatim <= options.budgetChars) return { messages: [...raw], folded: 0 };

  const target = options.budgetChars * FOLD_TARGET_RATIO;
  const lines: string[] = [];
  let folded = 0;
  // THE BLOCK IS CHARGED FOR AS IT GROWS, by building it rather than estimating
  // it: the lines that replace the folded turns are themselves part of what the
  // next prompt sends, and a fold that counted only what it removed would stop
  // a block's worth above the floor it was aiming at.
  let block = 0;
  while (verbatim + block > target && folded < turns.length - 1) {
    lines.push(settled[folded]?.line ?? foldedTurnLine(turns[folded]!));
    verbatim -= weights[folded]!;
    block = cost(foldBlock(lines));
    folded += 1;
  }
  if (folded === 0) return { messages: [...raw], folded: 0 };
  sealAgedEras(options.eras, settled.length, lines, weights, folded);
  return { messages: [...foldBlock(lines), ...turns.slice(folded).flat()], folded };
}

/**
 * THE STORED FOLD, FLATTENED ONTO TURN INDICES — one entry per turn an era
 * already covers, and nothing past it.
 *
 * IGNORED WHOLE IF IT REACHES PAST THE CONVERSATION. An era claiming more turns
 * than the thread has is a store that does not describe this message list, and
 * the safe reading of that is to derive everything from raw. It should be
 * impossible — a reset mints a new thread id and archives the file — so this is
 * the branch that keeps "impossible" from meaning "lines under the wrong
 * numbers".
 */
function settledTurns(eras: EraStore | undefined, turns: number): FoldedTurn[] {
  if (!eras) return [];
  const sealed = eras.sealed();
  const flat = sealed.flatMap((era) => era.turns);
  return flat.length <= turns ? flat : [];
}

/**
 * SEAL EVERY WHOLE ERA THE FOLD HAS NOW PASSED.
 *
 * The condition is that ALL of an era's turns were folded — `(ordinal + 1) ·
 * ERA_TURNS <= folded` — which is what "aged out of the live window" means
 * here. A partial era is not sealed: its turns are behind the frontier this
 * lap and the numbers it would store are the same either way, but storing half
 * an era would break the multiplication `settledTurns` reads it back with.
 *
 * Starts at the first unsealed ordinal, so the ones already on disk are never
 * rewritten — and `seal` ignores a duplicate anyway, which is what makes an era
 * summarised once rather than summarised once per reader.
 */
function sealAgedEras(
  eras: EraStore | undefined,
  covered: number,
  lines: readonly string[],
  weights: readonly number[],
  folded: number,
): void {
  if (!eras) return;
  for (let ordinal = Math.floor(covered / ERA_TURNS); (ordinal + 1) * ERA_TURNS <= folded; ordinal += 1) {
    const from = ordinal * ERA_TURNS;
    eras.seal({
      ordinal,
      turns: Array.from({ length: ERA_TURNS }, (_unused, index) => ({ line: lines[from + index]!, chars: weights[from + index]! })),
    });
  }
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
