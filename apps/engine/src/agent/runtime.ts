/**
 * THE AGENT'S LOOP — a hand-built StateGraph, one thread per machine (#531).
 *
 * ── THE AGENT HAS NO PROCESS OF ITS OWN ─────────────────────────────────────
 * It runs INSIDE THE DAEMON, in the daemon's event loop. `daemon.ts` constructs
 * one `AgentRuntime` and spawns nothing: no CLI, no worker, no child. A turn is
 * an async function on this object, its state is `agent/threads.sqlite` under
 * the engine root, and `shutdown` below ends any live turn before the daemon's
 * server closes. Stop the engine and the Agent stops with it, mid-sentence;
 * there is no second thing to kill and none to survive.
 *
 * THIS IS WRITTEN DOWN BECAUSE THE OWNER MEASURED THE OPPOSITE (#539). On the
 * first night of the nightly the cockpit reported the engine down while the
 * Agent kept answering, and the honest reading of that is "the Agent is
 * somewhere else". It was not. The cockpit was wrong: #526's `telar` provider
 * row broke `readProviderInstances`, so the claims route and the settings page
 * failed and the engine READ as down while it was serving the Agent perfectly
 * well (fixed in a36557fc). The daemon was up the entire time.
 *
 * WHICH IS WHY THE AGENT READS `resolveProviderInstance` NOWHERE, ON PURPOSE.
 * A provider instance is a SESSION's account-and-model binding, resolved on the
 * session claim; the Agent has no session, no claim and no driver, and its model
 * is `agent.json`'s one field resolved through `./model.ts` and `./go.ts`
 * against OpenCode Go, with the key ladder in `./credentials.ts`. So the read
 * that broke is one this file cannot make — not by luck, and not as an
 * optimisation, but because the Agent is not a provider session and borrowing a
 * session's binding would give it a driver it does not have.
 * `agent-in-engine.test.ts` holds both halves: that the daemon's stop ends an
 * Agent turn, and that the whole Agent surface goes with the daemon.
 *
 * ── WHY A `StateGraph` AND NOT `createReactAgent` ───────────────────────────
 * The installed package deprecates its own prebuilt: `@langchain/langgraph`
 * 1.4.15 ships `createReactAgent` with `@deprecated CreateReactAgentParams has
 * been moved to the langchain package`. The replacement, `createAgent` from
 * `langchain`, is a third package and an agent abstraction with its own
 * middleware system — adopting it would mean taking somebody's opinions about
 * approvals, context and subagents on top of the ones Telar already has. A
 * graph over the two packages #531 names is the non-deprecated API and is what
 * the lab measured.
 *
 * ── THE TWO PROPERTIES THAT ARE NOT DECORATION ──────────────────────────────
 * 1. APPROVAL IS A FIRST PASS. `interrupt()` propagates by throwing, so a node
 *    that ran one tool and THEN interrupted would lose that tool's state write
 *    and re-run it on resume — the effect landing twice. Every gated call in a
 *    batch is therefore interrupted before any effect in the same node runs.
 * 2. EFFECTS ARE LEDGERED IN GRAPH STATE, so the record of an effect is
 *    checkpointed in the same write as the messages that produced it. The
 *    ledger is read BEFORE the approval check, so a deduplicated retry neither
 *    asks the person again nor reaches the wall. This is "checkpoint before
 *    effect" done the only way a checkpointer can give it: the effect and its
 *    record commit together, and a crash between them replays the node.
 *
 * Neither closes the case the lab found in scenario 5C — a cancel landing
 * BETWEEN the HTTP call and the checkpoint write. No graph framework can: an
 * HTTP call and a local write are not atomic. That one is closed at the wall,
 * by `sessions_send` deriving its run id from the tool call id.
 *
 * ── ONE TURN AT A TIME, AND A QUEUE BEHIND IT ───────────────────────────────
 * A thread is a conversation and a conversation has one live turn. A second
 * human message while a turn runs is QUEUED rather than steered: LangGraph's
 * unit of execution is a graph invocation on a thread, and injecting into one
 * mid-flight would mean writing to `messages` from outside the graph, behind
 * the checkpointer's back.
 *
 * ── AND A WAKE IS NOT A TURN AT ALL ANY MORE (#541 A) ───────────────────────
 * A wake used to queue on that same line, on the reading that a person's
 * message and a session's completion must not interleave into one prompt. True,
 * and beside the point: a completion is not something to say to the Agent, it is
 * something to TELL THE PERSON, next time they speak. So `wake` writes a row in
 * `./inbox.ts` and starts nothing, and `./digest.ts` renders what is unread at
 * the top of the next turn a PERSON begins — a projection, with no model call in
 * it. Four workers finishing overnight cost four INSERTs and one paragraph,
 * where they used to cost four conversations.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, Command, END, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import crypto from "node:crypto";
import type { AgentSettings, NotificationDetail } from "@telar/engine-client";
import type { SocketTool } from "../mcp-socket";
import { agentToolSpecs, answerIdentity, onSpokenWall, withheldFromSpokenTurn, type AgentFleetCapability, type AgentMemoryCapability } from "./tools";
import { approvalRequest, DECLINED_ANSWER, needsApproval, readsOnly, type AgentApprovalDecision, type AgentApprovalRequest } from "./approval";
import { AGENT_BRIEF_ANSWER, AGENT_BRIEFING, AGENT_SPOKEN_BRIEFING } from "./briefing";
import { answerOrphanedCalls, compactToolResults, foldOldTurns, minifyToolResult } from "./compact";
import { assistantText } from "./content";
import { openAgentCheckpointer, type OpenedCheckpointer } from "./checkpointer";
import { renderDigest } from "./digest";
import { AgentEraLog, type EraStore } from "./eras";
import { AgentInbox, inboxRowFromNotification, type AgentInboxRow } from "./inbox";
import { clearStanding, preferencesOf, readStanding, rememberSection, renderStanding } from "./memory";
import { AgentThreadLog, THREAD_PAGE_DEFAULT, type AgentRecallHit, type AgentRow } from "./thread-log";
import { agentPaths, patchAgentSettings, readAgentSettings, type AgentPaths } from "./store";
import { DEFAULT_AGENT_BUDGET_CHARS, trimAgentHistory } from "./trim";

/**
 * HOW MANY TIMES ONE TURN MAY GO BACK TO THE MODEL — `MAX_ROUNDS`' own number
 * and its own argument. A model that keeps calling tools keeps costing money
 * and nobody is watching a coordinator at 3am. Generous for the work this loop
 * does (read the rail, read a session, send a task, report) and small enough
 * that a loop costs a few calls rather than a night.
 *
 * LangGraph counts SUPERSTEPS, and one lap is two of them (model, tools), so
 * the graph's ceiling is twice the laps plus one.
 *
 * ── IT IS A LANDING, NOT A WALL (#570) ──────────────────────────────────────
 * This number used to be spent only as `recursionLimit`, and the way a turn met
 * it was that LangGraph THREW: `Recursion limit of 25 reached without hitting a
 * stop condition`, the turn `failed`, and the person who asked "how are things"
 * got a library's sentence instead of an answer, after sixteen tool calls and
 * 312k tokens. Measured on nightly 20260917.4, three of ten turns.
 *
 * So the cap is now spent HERE, one lap early: `callModel` sees that this call
 * is the last one the turn may make, invokes the model with NO TOOLS BOUND and
 * one sentence added to the system block, and whatever it says is the turn's
 * answer. Unbinding is what makes that final call terminal — a model with no
 * tools to call cannot ask for a seventeenth lap, so `shouldContinue` routes to
 * END and nothing has to trust the model to stop when told.
 *
 * `recursionLimit` STAYS, above this, as the backstop it always should have
 * been. Nothing routine reaches it any more: the final lap is superstep
 * 2·MAX_LAPS−1, and the limit sits above that, so it can only fire if this cap
 * is bypassed (a turn resumed into a fresh graph, see `spend.laps`) — which is
 * exactly when a ceiling is still wanted.
 */
const MAX_LAPS = 12;

/**
 * THE SAME CEILING, MUCH LOWER, FOR A TURN SOMEBODY IS LISTENING TO (#603).
 *
 * ── WHY A SPOKEN TURN GETS ITS OWN NUMBER ───────────────────────────────────
 * Measured on the owner's own history: brief turns spent 2.55 laps each on
 * average and up to eleven, to produce answers a couple of hundred characters
 * long — one of them 221,633 input tokens for a 90-character reply. A lap is
 * the whole prompt and the whole tool wall again, and on a spoken turn it is
 * also a person standing there waiting with their ears. Three is two chances to
 * look and one to answer.
 *
 * ── IT IS NOT THE CAP #601 REFUSED, AND THE DIFFERENCE IS THE LANDING ───────
 * "Do not fix this by capping tool calls" was aimed at a cap that produces
 * confident answers built on nothing. This one cannot: `MAX_LAPS`'s landing
 * already binds no tools and adds `OUT_OF_LAPS`, which asks for the GAP as well
 * as the answer — so a spoken turn that runs out says what it did not get to,
 * out loud, and the person asks again in three seconds. An honest short answer
 * is a different object from a confident wrong one.
 *
 * ── IT ONLY EVER LOWERS ─────────────────────────────────────────────────────
 * Taken as a `Math.min` against whatever is configured, so a test that asks for
 * two laps still gets two and this cannot quietly raise anybody's ceiling.
 */
const BRIEF_MAX_LAPS = 3;

/**
 * WHAT THE LAST LAP IS TOLD, and it is deliberately one sentence.
 *
 * It rides the SYSTEM block rather than the message list for `AGENT_BRIEF_ANSWER`'s
 * reason: this is an instruction about how to answer THIS call, and anything
 * appended to `messages` would be checkpointed and still be there three turns
 * later. The system block is rebuilt per lap from `buildGraph`'s own pieces, so
 * appending to it costs nothing and outlives nothing.
 *
 * IT ASKS FOR THE GAP AS WELL AS THE ANSWER. "Answer with what you have" alone
 * produces a confident summary of a half-finished look; naming what was not
 * reached is what lets the person decide whether to ask again.
 *
 * ── AND ON A SPOKEN TURN THE GAP HAS TO FIT IN THE SENTENCE (#603) ──────────
 * `AGENT_BRIEF_ANSWER` asks for ONE sentence, and a model reading it beside
 * "say what you did not get to" can honour both by dropping the second — which
 * is exactly the confident-answer-built-on-nothing that `BRIEF_MAX_LAPS` is
 * only allowed to exist because it avoids. So the spoken landing puts the
 * admission INSIDE the sentence rather than beside it, and the two share their
 * first clause rather than being two sentences that can drift apart.
 */
const OUT_OF_LAPS_OPENING = "You are out of tool calls for this turn. Answer with what you have";
const OUT_OF_LAPS = `${OUT_OF_LAPS_OPENING} and say what you did not get to.`;
const OUT_OF_LAPS_SPOKEN = `${OUT_OF_LAPS_OPENING}, and say what you did not get to IN THAT SAME SENTENCE — one sentence that admits the gap, never a confident one that hides it.`;

/** The turn's lap ceiling: whatever is configured, lowered for a spoken turn.
 *  `Math.min` rather than a choice, so this can only ever take laps away. */
function lapCeiling(configured: number, brief: boolean | undefined): number {
  return brief === true ? Math.min(configured, BRIEF_MAX_LAPS) : configured;
}

/**
 * WHAT A FAILED TURN SAYS WHEN THE ERROR SAID NOTHING (#602).
 *
 * Measured over 119 turns on the dogfood Mac: seven ended `failed`, five of them
 * without reaching the model at all. Every one of those did carry a reason — but
 * `error.message` is free to be the empty string (`new Error()`, a thrown
 * `undefined`, a rejection carrying a bare object), and an empty reason is the
 * one outcome this issue exists to forbid. A person who is told nothing re-asks
 * and pays for the same turn again, so "failed, and I cannot say why" has to be
 * a SENTENCE rather than an absent field.
 */
const TURN_FAILED_WITHOUT_REASON = "The turn failed before it could answer, and the error carried no message.";

/**
 * A THROWN ANYTHING, AS THE ONE LINE A PERSON READS.
 *
 * NEVER EMPTY, which is the whole point — see `TURN_FAILED_WITHOUT_REASON`. The
 * ladder is "what was said", then "what kind of thing it was", then the
 * sentence: an `AbortError` with no message is worth more as its own name than
 * as the generic line, and `String({})` is worth less than either.
 */
function failureReason(error: unknown): string {
  const said = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  if (error instanceof Error) {
    const name = said(error.name);
    return said(error.message) || (name && name !== "Error" ? name : "") || TURN_FAILED_WITHOUT_REASON;
  }
  if (typeof error === "object" && error !== null) {
    const carried = said((error as { message?: unknown }).message);
    if (carried) return carried;
  }
  return said(error) || TURN_FAILED_WITHOUT_REASON;
}

/** The ledger's key for one effect. A hash rather than the arguments because a
 *  key is compared and never read, and a `sessions_send` argument is a whole
 *  message. */
function effectKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${crypto.createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16)}`;
}

/** Which calls must not happen twice — the two that LAND something on another
 *  session. A read replayed costs a page; a send replayed costs somebody a
 *  second turn they did not ask for. */
function ledgerKey(name: string, args: Record<string, unknown>): string | undefined {
  return name === "sessions_send" || name === "sessions_create" ? effectKey(name, args) : undefined;
}

/**
 * THE SAME READ, PAID FOR ONCE — the within-turn memo (#592).
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 * Measured on one stopped turn: `fleet_status` twice for a BYTE-IDENTICAL 6,628
 * characters, `sessions_requests` three times for an identical 133. ~7,900
 * characters of pure duplicate — and because every lap resends the whole
 * history, a duplicate that lands at lap 2 is paid for again at laps 3 through
 * 8. The briefing already asked for this ("call fleet_status ONCE") and the
 * model did it twice regardless, which is the argument for a mechanism: a rule
 * a model can ignore should become one that does not depend on it.
 *
 * ── THE THREE PROPERTIES IT HAS TO HAVE ─────────────────────────────────────
 *   1. IT MUST NOT SURVIVE THE TURN. A memo that outlived one would hand the
 *      Agent a stale fleet on the next question — a correctness bug, and far
 *      worse than the waste it replaces. So the store is a `Set` created inside
 *      `buildGraph`, which `runTurn` calls once per turn and a resume calls
 *      again: the memo is scoped by the LIFETIME OF AN OBJECT rather than by a
 *      clearing rule somebody has to remember to write. Nothing about it is
 *      checkpointed; `state.effects` is deliberately not reused, because that
 *      ledger is the thing that DOES persist.
 *   2. READS ONLY, and structurally so — `readsOnly` answers from the one table
 *      in `approval.ts`, which fails towards "lands" for a name it has not been
 *      taught. Two identical `sessions_send` calls are not a duplicate: a person
 *      can ask for the same message twice, and swallowing the second while
 *      returning a pointer would silently drop work the Agent believes it did.
 *   3. IT HOLDS NO PAYLOAD. A `Set` of keys, not a `Map` of answers — the repeat
 *      returns a POINTER, so there is structurally no stale body to serve.
 *
 * ── WHY IT CANNOT MAKE A TURN WRONG ─────────────────────────────────────────
 * Within one turn the Agent has no way to act on a difference between two reads
 * anyway, and anything that DID change arrives as a notification on the next
 * one. The one honest edge is the trim: if the first answer is old enough to
 * fall out of the window while the pointer is still in it, the pointer names
 * something the model can no longer read. The memo makes that strictly LESS
 * likely than not having it — it is removing the bytes that push the window
 * over — so it is noted rather than guarded.
 */
const MEMO_ARGS_SHOWN = 120;

/**
 * THE ARGUMENTS, CANONICAL — order-insensitive and whitespace-insensitive, and
 * DELIBERATELY NOT SEMANTICALLY CLEVER.
 *
 * Keys are sorted, so `{a,b}` and `{b,a}` are one call. Strings are trimmed and
 * their internal runs of whitespace collapsed, so a re-typed argument with a
 * stray space is one call. `undefined` members drop, because `JSON.stringify`
 * drops them anyway and a key explicitly set to nothing is a key not passed.
 *
 * NOTHING ELSE IS TOUCHED. `{limit:20}` and `{limit:10}` are DIFFERENT calls and
 * must stay different: reasoning about whether the smaller answer is a subset of
 * the larger is exactly the kind of cleverness that turns a token saving into a
 * wrong answer. Case is meaning too, and array order is meaning.
 */
function canonicalArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArgs);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, member]) => [key, canonicalArgs(member)]));
  }
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  return value;
}

/** One read's identity for the turn, or `undefined` for a call that lands
 *  something. Hashed for `effectKey`'s reason: a key is compared, never read. */
function memoKey(name: string, args: Record<string, unknown>): string | undefined {
  if (!readsOnly(name)) return undefined;
  return `${name}:${crypto.createHash("sha256").update(JSON.stringify(canonicalArgs(args ?? {}))).digest("hex").slice(0, 16)}`;
}

/**
 * WHAT A REPEAT GETS INSTEAD OF THE PAYLOAD.
 *
 * IT NAMES THE CALL, with its arguments, because "you already did that" against
 * a batch of six reads is not something a model can pair with anything. The
 * arguments are the canonical form clipped hard — a pointer that quoted a long
 * `q` would start costing what it was written to save.
 *
 * AND IT SAYS THE ANSWER IS ABOVE, which is the whole instruction: the first
 * call's result is in this same thread, unchanged, and the model's next move is
 * to use it rather than to reach for a different phrasing of the same read.
 */
function memoPointer(name: string, args: Record<string, unknown>): string {
  const shown = JSON.stringify(canonicalArgs(args ?? {}));
  const clipped = shown.length > MEMO_ARGS_SHOWN ? `${shown.slice(0, MEMO_ARGS_SHOWN)}…` : shown;
  return `You already called ${name}(${clipped}) on this turn; its answer is above and was not read again. Nothing changes mid-turn — use that answer, or act.`;
}

/**
 * THE SECOND KEY THE SAME MEMO HOLDS — one RUN, however it was asked for (#608).
 *
 * ── WHY THE ARGUMENT KEY ABOVE CANNOT SEE THIS ──────────────────────────────
 * `memoKey` is deliberately literal: `{limit:20}` and `{limit:10}` are two calls
 * because deciding whether one answer contains the other is the cleverness that
 * turns a saving into a wrong answer. The measured waste walks straight through
 * that rule — `sessions_answer` re-read with a different `from` and `limit`, and
 * with `runId` sometimes named and sometimes omitted, for text the turn already
 * had whole. Worst case: 20,273 characters for a 6,127-character answer.
 *
 * ── SO IT KEYS ON THE RESOLVED PAIR, AND ONLY WHEN THE TEXT IS FINISHED ─────
 * `(sessionId, runId)` after the store has resolved what "the latest turn" meant,
 * and only once a reply has said `more: false`. That is the difference between
 * "we have seen some of this" and "there is nothing left to fetch", and it is
 * the whole guard: a half-read run is NOT memoised, so a caller genuinely paging
 * a 40,000-character answer is never handed a pointer in the middle of it.
 *
 * ── ONE SET, TWO KEYS — BESIDE #592 RATHER THAN PARALLEL TO IT ──────────────
 * Both keys live in the same `memo`, are decided in the same pass, and produce
 * the same kind of pointer. The namespace prefix keeps them from colliding, and
 * the lifetime argument above covers both without being made twice.
 */
function answerRunKey(sessionId: string, runId: string): string {
  return `run:${sessionId}:${runId}`;
}

/**
 * WHICH RUN A `sessions_answer` CALL IS ABOUT, BEFORE IT RUNS.
 *
 * A NAMED `runId` IS THE PAIR OUTRIGHT. An omitted one means "the latest turn
 * that said something", which only the store knows — so it is answered from what
 * THIS TURN has already resolved, and `undefined` before the turn has resolved
 * it once. That is the conservative direction: the first such call always runs.
 *
 * Only a resolution the STORE made is recorded as "the latest" — see
 * `answerIdentity`'s `latest`, which is why a call that named an old runId
 * cannot teach this map that the old turn is the newest one.
 */
function answerRunFor(name: string, args: Record<string, unknown>, latest: ReadonlyMap<string, string>): { sessionId: string; runId: string } | undefined {
  if (name !== "sessions_answer") return undefined;
  const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
  if (!sessionId) return undefined;
  const runId = typeof args.runId === "string" && args.runId ? args.runId : latest.get(sessionId);
  return runId ? { sessionId, runId } : undefined;
}

/** What a re-read of a run this turn already has whole gets instead of the text.
 *  It names the RUN rather than the arguments, because the arguments are the one
 *  thing that differed — a pointer quoting them would read as "you asked
 *  something else" and invite a third spelling. */
function runPointer(sessionId: string, runId: string): string {
  return `You already have the whole answer for run ${runId} of ${sessionId} on this turn; it is above and was not read again. Every offset and limit of it is already there — use it, or act.`;
}

const AgentGraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** key → the answer that effect already produced. */
  effects: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
});
type AgentGraphStateType = typeof AgentGraphState.State;

/* ------------------------------------------------------------------ *
 * What the runtime tells the world.
 * ------------------------------------------------------------------ */

export type AgentTurnOrigin = "human" | "wake";

export type AgentPendingRequest = AgentApprovalRequest & { id: string; runId: string; openedAt: number };

/**
 * WHAT ONE TURN COST THE MODEL — summed over its laps, not per call (#539).
 *
 * A turn that calls three tools goes back to the model four times, and the
 * question a person asks is "what did that turn cost", so these are totals. The
 * numbers are the PROVIDER'S, reported on `usage_metadata`; nothing here counts
 * tokens itself.
 */
export type AgentUsage = {
  input: number;
  output: number;
  total: number;
  /**
   * HOW MUCH OF `input` THE PROVIDER SERVED FROM ITS CACHE (#563 item 3).
   *
   * A FRACTION OF `input`, NOT A NUMBER BESIDE IT, and that is true on all three
   * of Go's routes rather than by a convention invented here: `@langchain/openai`
   * reports `input_tokens` as the whole `prompt_tokens`, of which
   * `prompt_tokens_details.cached_tokens` is a part, and `@langchain/anthropic`
   * adds `cache_read_input_tokens` and `cache_creation_input_tokens` INTO
   * `input_tokens` before handing it over. So `cacheRead / input` is a
   * proportion on every route, and a reader never has to know which one ran.
   *
   * ── ABSENT IS NOT ZERO, WHICH IS WHY BOTH ARE OPTIONAL ──────────────────────
   * `usage` itself is already absent when the provider reported no count at all,
   * for the reason `AgentLastUsage.usage` gives. These two need the same
   * distinction one level down: a provider can report tokens and say NOTHING
   * about caching — no `input_token_details` on the message at all — and a `0`
   * there would read as "the cache was cold" when the truth is "nobody said".
   * The difference is the whole point of item 3: a cold cache is a thing to fix,
   * and a silent provider is a thing to find out about.
   *
   * WRITTEN ONLY WHEN SOME LAP OF THE TURN CARRIED DETAILS. Summed over the
   * turn's laps like the three numbers above it, and a lap that said nothing
   * contributes nothing rather than suppressing the turn's total.
   */
  cacheRead?: number;
  /**
   * WHAT IT COST TO PUT THIS TURN'S PREFIX INTO THE CACHE — the miss half.
   *
   * ONLY `/messages` EVER REPORTS IT. The Anthropic shape bills cache writes as
   * their own line (`cache_creation_input_tokens`) because they are charged at a
   * premium; the chat and `/responses` routes have no equivalent field, and
   * provider-side automatic caching there simply does not bill a write. So this
   * is absent on the route the Agent runs today, and present on a Claude-model
   * Agent — which is exactly the fact a reader needs in order to compare them.
   */
  cacheCreate?: number;
};

/**
 * THE CONTEXT METER'S WHOLE INPUT — the last turn's cost and the size of the
 * prompt that produced it.
 *
 * ON THE STATE RATHER THAN DERIVED PER READER: a cockpit, a phone and a later
 * `GET /v2/agent` must show the same number, and three clients each folding the
 * transcript would be three numbers waiting to disagree. It survives a restart
 * because `restore` reads it back off the last `turn_done` row.
 */
export type AgentLastUsage = {
  /** The turn these numbers came from, so a client can tell a stale meter from
   *  a fresh one without a timestamp comparison. */
  runId: string;
  at: number;
  /**
   * ABSENT WHEN THE MODEL REPORTED NONE, which is a real case: an
   * OpenAI-compatible server is not obliged to send usage, and a zero here
   * would read as "that turn was free" rather than "nobody said".
   */
  usage?: AgentUsage;
  /** What the prompt cost in CHARACTERS on the turn's last lap, as the trim
   *  step measured it — system prompt included. See `./trim.ts`. */
  contextChars: number;
  /** The trim's ceiling those characters are measured against, so a reader can
   *  draw a proportion without knowing the engine's constant. */
  budgetChars: number;
  /**
   * HOW MANY OLDER TURNS THIS TURN FOLDED to one line each (#567).
   *
   * THE METER'S MISSING SENTENCE. A fold now drops the reading from full to
   * about 60% (see `FOLD_TARGET_RATIO`), and a gauge that halves itself between
   * two turns with nothing to explain it looks like a bug rather than like the
   * engine working. This is what the clients say beside it.
   *
   * THE LAST LAP WINS, exactly as `contextChars` does — the fold is recomputed
   * from the raw turns on every lap, so the number that means anything is the
   * one from the prompt that was actually sent last. `0` on the ordinary turn
   * that folded nothing.
   */
  folded: number;
  /**
   * HOW MANY TIMES THIS TURN WENT BACK TO THE MODEL (#570).
   *
   * THE NUMBER THE LAP CAP IS ABOUT, and the one nobody could see while the cap
   * was a thrown exception: "sixteen calls" was read off a screenshot. It counts
   * MODEL CALLS, which is one more than the tool rounds — the last lap is the
   * one that answers — so a turn that called no tool at all reports `1`.
   *
   * ALWAYS WRITTEN, like the three numbers beside it. `0` is not a turn that
   * ran: it is a row written before this field existed, or a turn stopped
   * before it reached the model, and both are honestly "no laps to report".
   */
  laps: number;
};

export type AgentStateAnswer = {
  enabled: boolean;
  threadId?: string;
  model?: string;
  /** `reasoning_effort` on the wire. Absent means the parameter is not sent —
   *  see `AgentSettings.effort`. */
  effort?: AgentSettings["effort"];
  /** Absent means `ask`, which is what shipped. See `AgentSettings.access`. */
  access?: AgentSettings["access"];
  generation?: number;
  /** A turn is executing right now. False while one is parked for a person —
   *  which is why `request` is reported beside it rather than inside it. */
  running: boolean;
  /** The run this is all about, whether it is executing or parked. */
  runId?: string;
  /** How many turns are waiting behind the live one. */
  queued: number;
  request?: AgentPendingRequest;
  /** The context meter — what the last COMPLETED turn cost. Absent until one
   *  has, and unchanged while the next runs, because a meter that emptied
   *  itself the moment you spoke would answer a question nobody asked. */
  lastUsage?: AgentLastUsage;
  /** How many wakes are waiting in the inbox (#541 A) — the badge's number, on
   *  the state the rail already polls. `0` on a machine with no thread. */
  inboxUnread: number;
};

/**
 * What a watcher is pushed. A row is durable and pageable; a delta is neither,
 * and is folded into the assistant row when the message completes.
 *
 * AN `inbox` FRAME IS A NUDGE, NOT A FEED (#541 A). It is pushed when a wake
 * lands so a cockpit can badge the entry without waiting for its next poll, and
 * it is deliberately NOT replayed by the stream's `after` — that cursor is the
 * TRANSCRIPT's, and an inbox row has its own id space. A client that reconnects
 * reads `GET /v2/agent/inbox`, which is the authoritative list; this frame only
 * saves it the wait.
 */
export type AgentStreamEvent =
  | { type: "row"; row: AgentRow }
  | { type: "delta"; runId: string; itemId: string; text: string }
  | { type: "inbox"; row: AgentInboxRow };

export type AgentRuntimeOptions = {
  engineRoot: string;
  /** Rebuilt per turn, because a wall closes over store state that a long-lived
   *  object would pin. */
  tools: () => SocketTool[];
  /** The model, per turn, for the key ladder's reason: a person who pastes a
   *  key gets the new answer on their next message, not their next restart.
   *  `effort` rides with it for the same reason — see `AgentSettings.effort`. */
  model: (input: { threadId: string; model?: string; effort?: AgentSettings["effort"] }) => BaseChatModel;
  now?: () => number;
  /** Appended after the briefing, exactly as a session's orientation is. */
  orientation?: () => string | undefined;
  maxLaps?: number;
  budgetChars?: number;
  /**
   * WHERE THE PREFERENCES GO WHEN A RESET TAKES EVERYTHING ELSE — #541's owner
   * decision 3.
   *
   * INJECTED, because a notebook is the ENGINE's and this object owns only the
   * Agent's own directory. The daemon wires it to the Agent's own notebook file
   * (`notes/agent.json`, under the reserved id the sessions wall already knows);
   * a test wires it to a function and asserts the order.
   *
   * ABSENT IS LEGITIMATE. A runtime built without one resets exactly as it did
   * before — the preferences go with everything else — rather than refusing to
   * reset because nothing was listening.
   */
  keepPreferences?: (preferences: string) => void;
};

type QueuedTurn = {
  runId: string;
  input: string;
  origin: AgentTurnOrigin;
  wakeReason?: Record<string, unknown>;
  /** THIS TURN IS BEING SPOKEN, so its answer is written to be heard (#567).
   *  Per turn, never stored — see `AGENT_BRIEF_ANSWER` for why. */
  brief?: boolean;
  /**
   * THIS TURN CONTINUES ONE THE CHECKPOINT ALREADY HOLDS — see `restore`.
   *
   * Present only for a turn resumed after a RESTART: the conversation is in the
   * checkpoint, the parked interrupt is in it too, and what this carries is the
   * person's answer rather than anything new to say. It writes no
   * `user_message` and no `turn_started`, because neither happened twice.
   */
  resume?: AgentApprovalDecision;
};

/* ------------------------------------------------------------------ *
 * The runtime.
 * ------------------------------------------------------------------ */

export class AgentRuntime {
  readonly paths: AgentPaths;
  private readonly now: () => number;
  private opened?: OpenedCheckpointer;
  private log?: AgentThreadLog;
  /** The wake inbox, on the same handle as the transcript — see `open`. Named
   *  `inboxTable` because `inbox()` is the read method beside it. */
  private inboxTable?: AgentInbox;
  /** Where the settled half of the fold is kept, on the same handle again — see
   *  `./eras.ts`. Named for the table rather than `eras` because `eras()` is
   *  not a read method anybody outside this object wants. */
  private eraTable?: AgentEraLog;
  private queue: QueuedTurn[] = [];
  private live?: { turn: QueuedTurn; controller: AbortController };
  private pending?: AgentPendingRequest;
  /** Resolves when the person answers. The parked turn awaits it. */
  private answer?: (decision: AgentApprovalDecision) => void;
  private watchers = new Set<(event: AgentStreamEvent) => void>();
  /** The drain in flight, so `submit` does not start a second one — and so
   *  `shutdown` has something to await. Cleared when the queue runs dry. */
  private draining?: Promise<void>;
  /** The context meter, last written by a completed turn and read back off the
   *  transcript at startup. See `AgentLastUsage`. */
  private lastUsage?: AgentLastUsage;
  /** What the live turn has spent so far: the model's own numbers summed over
   *  its laps, and the prompt size the most recent lap was trimmed to. Reset
   *  when a turn starts, folded into `turn_done` when one ends. */
  private spend?: {
    input: number;
    output: number;
    total: number;
    reported: boolean;
    /** Did ANY lap carry `input_token_details`? Separate from `reported` for the
     *  reason `AgentUsage.cacheRead` gives: a provider that counts tokens and
     *  says nothing about caching must not be written down as a cold cache. */
    cacheReported: boolean;
    cacheRead: number;
    cacheCreate: number;
    contextChars: number;
    folded: number;
    laps: number;
  };
  /** Which conversation the live turn belongs to — see `row`. */
  private turnThreadId?: string;
  /** The inbox rows the live turn's digest accounts for, marked read when it
   *  ends. See `renderDigest` for why the overflow is in here too. */
  private pendingDigest?: number[];
  /** Whether a prompt carrying that digest was actually built. A turn stopped
   *  before its first model call has shown the person nothing, so its rows stay
   *  unread for the next turn. */
  private digestDelivered = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.paths = agentPaths(options.engineRoot);
    this.now = options.now ?? Date.now;
  }

  /* -------------------------------------------------------------- *
   * Lifecycle.
   * -------------------------------------------------------------- */

  /**
   * The thread's file, opened lazily and kept open.
   *
   * LAZY BECAUSE AN ENGINE WHOSE AGENT IS OFF SHOULD NOT GROW A DATABASE. The
   * first turn, the first thread read or the first stream opens it; a machine
   * that never switches the Agent on never has one.
   */
  private open(): { opened: OpenedCheckpointer; log: AgentThreadLog; inbox: AgentInbox; eras: AgentEraLog } {
    if (!this.opened || !this.log || !this.inboxTable || !this.eraTable) {
      const opened = openAgentCheckpointer(this.paths.threads);
      this.opened = opened;
      this.log = new AgentThreadLog(opened.db);
      // THE SAME HANDLE, a third table on it — and now a fourth. Two
      // connections to one WAL database would be two things to close before a
      // reset could move it — see `thread-log.ts`.
      this.inboxTable = new AgentInbox(opened.db);
      this.eraTable = new AgentEraLog(opened.db);
    }
    return { opened: this.opened, log: this.log, inbox: this.inboxTable, eras: this.eraTable };
  }

  /**
   * AN APPROVAL PARKED BY A PREVIOUS PROCESS, FOUND AGAIN (#531).
   *
   * THIS IS THE WHOLE POINT OF A DURABLE CHECKPOINTER, and it is the property
   * the lab measured: `interrupt()` writes the parked call INTO the checkpoint,
   * payload and all, so a process that has never seen the thread can read what
   * the person was being asked and carry on from it. `MemorySaver` survives
   * nothing across a process boundary, which is exactly what a restart is.
   *
   * THE REQUEST'S OWN ID COMES FROM THE TRANSCRIPT, not from the checkpoint.
   * LangGraph stores the payload our node passed to `interrupt()`; the id and
   * the run it belongs to are Telar's, and they were written as a
   * `request_opened` row in the same breath. Recovering them from there is what
   * lets a cockpit that was holding the old id still answer it.
   *
   * AWAITED BY THE DAEMON AT STARTUP rather than fired off inside the first
   * read. It is one bounded sqlite read, it happens once, and doing it eagerly
   * is what makes "the request is there the moment the route can answer" true
   * instead of nearly true.
   *
   * SILENT WHEN THERE IS NOTHING TO RESTORE, which is every ordinary start.
   */
  async restore(): Promise<void> {
    const settings = readAgentSettings(this.paths);
    if (!settings.enabled || !settings.threadId || this.pending || this.live) return;
    try {
      const graph = this.buildGraph({ tools: [], model: undefined, runId: "" });
      // THE METER SURVIVES THE RESTART, because the number it shows was never
      // this process's — it is on the last `turn_done` row, where the turn that
      // earned it wrote it. Read before the parked-request check, which returns
      // early on every ordinary start.
      this.lastUsage = this.lastTurnUsage(settings.threadId);
      const snapshot = await graph.getState({ configurable: { thread_id: settings.threadId } });
      const parked = firstInterrupt(snapshot);
      if (!parked) return;
      const opened = this.lastUnresolvedRequest(settings.threadId);
      if (!opened) return;
      this.pending = { ...parked, id: opened.id, runId: opened.runId, openedAt: opened.openedAt };
      // NO `answer` RESOLVER: the promise that held the parked turn died with
      // the process that made it. `resolveRequest` sees that and queues a
      // RESUME turn instead of settling a promise nobody is waiting on.
    } catch {
      // A thread whose checkpoint cannot be read is not a reason a daemon fails
      // to start. The conversation is still on disk for a later build.
    }
  }

  /**
   * The newest `turn_done` on this thread, as the context meter — so a cockpit
   * opened after a restart shows the last turn's cost rather than an empty
   * gauge.
   *
   * Bounded to the same tail `lastUnresolvedRequest` reads: a turn that ended
   * is one of the newest things on the thread, and a meter is not worth walking
   * a transcript for. Absent when the tail holds no ended turn, which is a
   * thread whose only turn is still running.
   */
  private lastTurnUsage(threadId: string): AgentLastUsage | undefined {
    const log = this.log;
    if (!log) return undefined;
    const end = log.cursor(threadId);
    const page = log.page(threadId, Math.max(0, end - 50), 50);
    let found: AgentLastUsage | undefined;
    for (const row of page.rows) {
      if (row.kind !== "turn_done") continue;
      const detail = row.detail as { usage?: Partial<AgentUsage>; contextChars?: unknown; budgetChars?: unknown; folded?: unknown; laps?: unknown };
      // A row written before the meter existed carries no numbers. It is still
      // the newest ended turn, so it CLEARS a stale meter rather than leaving
      // an older turn's figures on screen.
      const usage = detail.usage;
      found = {
        runId: row.runId,
        at: row.at,
        ...(typeof usage?.input === "number" && typeof usage.output === "number" && typeof usage.total === "number"
          ? {
              usage: {
                input: usage.input,
                output: usage.output,
                total: usage.total,
                // READ BACK ONLY WHEN THE ROW CARRIES THEM. A `turn_done` from
                // before #563 item 3 has no cache numbers, and the meter must
                // say nothing rather than draw a cold cache onto a turn that was
                // never asked about one.
                ...(typeof usage.cacheRead === "number" ? { cacheRead: usage.cacheRead } : {}),
                ...(typeof usage.cacheCreate === "number" ? { cacheCreate: usage.cacheCreate } : {}),
              },
            }
          : {}),
        contextChars: typeof detail.contextChars === "number" ? detail.contextChars : 0,
        budgetChars: typeof detail.budgetChars === "number" ? detail.budgetChars : this.options.budgetChars ?? DEFAULT_AGENT_BUDGET_CHARS,
        folded: typeof detail.folded === "number" ? detail.folded : 0,
        laps: typeof detail.laps === "number" ? detail.laps : 0,
      };
    }
    return found;
  }

  /** The newest `request_opened` on this thread with no `request_resolved`
   *  after it. Bounded: an approval nobody answered is the newest thing that
   *  happened, so the tail is where it is. */
  private lastUnresolvedRequest(threadId: string): { id: string; runId: string; openedAt: number } | undefined {
    const log = this.log;
    if (!log) return undefined;
    const end = log.cursor(threadId);
    const page = log.page(threadId, Math.max(0, end - 50), 50);
    let found: { id: string; runId: string; openedAt: number } | undefined;
    for (const row of page.rows) {
      if (row.kind === "request_opened" && typeof row.detail.id === "string") {
        found = { id: row.detail.id, runId: row.runId, openedAt: typeof row.detail.openedAt === "number" ? row.detail.openedAt : row.at };
      }
      if (row.kind === "request_resolved") found = undefined;
    }
    return found;
  }

  /** Close the thread file. The reset path's precondition, where it must be
   *  SYNCHRONOUS — `patchAgentSettings` will not move a database until its
   *  `beforeArchive` hook has returned. Safe to call when nothing is open.
   *
   *  Not the daemon's shutdown: that is `shutdown` below, which ends the live
   *  turn first. Closing the handle under a running turn only means the next
   *  row it writes reopens it. */
  close(): void {
    this.opened?.close();
    this.opened = undefined;
    this.log = undefined;
    this.inboxTable = undefined;
    this.eraTable = undefined;
  }

  /**
   * THE ENGINE IS GOING AWAY, SO THE AGENT IS — and this method is the proof of
   * the header's claim (#539).
   *
   * There is no process to signal and no child to reap: the turn is a promise
   * in THIS event loop, so ending it is aborting its controller, and what makes
   * that observable is the wait. The `turn_done` row a stopped turn writes is
   * written by the drain's own catch, which runs a tick later; a shutdown that
   * closed the database first would have that row reopen the handle behind it —
   * the leak the daemon's teardown comment warns about — and a shutdown that
   * did not wait at all would leave the transcript ending mid-turn, so the next
   * process could not tell a stopped turn from one still running somewhere.
   *
   * So: drop the queue, abort the live turn, WAIT for the drain to settle, then
   * close the file. `agent-in-engine.test.ts` asserts the whole of that from
   * outside, through a second daemon reading the same transcript.
   */
  async shutdown(): Promise<void> {
    this.queue = [];
    this.cancel();
    // `draining` is undefined when nothing was running, which is the ordinary
    // case on an engine whose Agent is off.
    await this.draining?.catch(() => undefined);
    this.close();
  }

  /**
   * ENABLE, DISABLE, MODEL, RESET — the settings verb, with the one side effect
   * the store cannot perform on its own.
   *
   * THE CLOSE IS WIRED HERE because this object owns the handle. `patchAgentSettings`
   * refuses to move a database until its `beforeArchive` hook has run, and this
   * is what that hook is for.
   */
  patch(patch: { enabled?: unknown; model?: unknown; effort?: unknown; access?: unknown; reset?: unknown }): AgentStateAnswer {
    /**
     * THE PREFERENCES ARE KEPT BEFORE ANYTHING IS DESTROYED — #541's owner
     * decision 3, and the ORDER is the decision.
     *
     * Three of the four standing sections describe work in flight and are
     * exactly what a person resetting has asked to be rid of. The fourth is not
     * about the work at all: it is what they taught the Agent about themselves,
     * over many conversations, and making them teach it again is the reset
     * costing them something they did not ask to lose.
     *
     * So it is written out FIRST, into the Agent's own notebook, and only then
     * is the document deleted and the thread archived. A reset that failed
     * halfway would leave the note written and the conversation intact, which is
     * the harmless half of the two.
     *
     * DISABLE KEEPS EVERYTHING and takes none of this path: switching the Agent
     * off is a switch on an entry in the rail, which is `store.ts`'s rule for
     * the thread and is the same rule for what the thread learned.
     */
    if (patch.reset === true) {
      const preferences = preferencesOf(readStanding(this.paths));
      if (preferences) {
        try {
          this.options.keepPreferences?.(preferences);
        } catch {
          // A notebook that will not take the note must not block the reset the
          // person asked for. They said start again; this is the courtesy.
        }
      }
    }
    const result = patchAgentSettings(this.paths, patch, { now: this.now, beforeArchive: () => this.close() });
    if (patch.reset === true) {
      // The conversation is gone; anything waiting to be said to it is too —
      // the meter included, since it measured a thread that no longer exists.
      this.queue = [];
      this.live?.controller.abort();
      this.pending = undefined;
      this.answer = undefined;
      this.lastUsage = undefined;
      // AND WHAT IT WAS HOLDING. The standing state describes the conversation
      // that has just been retired; carrying it into the new one would be the
      // Agent starting again with somebody else's notes.
      clearStanding(this.paths);
    }
    if (result.settings.enabled === false) this.queue = [];
    return this.state();
  }

  state(): AgentStateAnswer {
    const settings = readAgentSettings(this.paths);
    /**
     * THE BADGE'S NUMBER RIDES THE STATE THE RAIL ALREADY POLLS (#541 A).
     *
     * `/v2/agent` is asked every three seconds by the sidebar entry's own hook,
     * for the status line; a second route for one integer would be a second
     * request on the same cadence answering a question this one is already
     * making a round trip for. It is a COUNT and not the rows: the section above
     * the composer pages those when it is opened.
     *
     * ZERO WHEN THERE IS NO THREAD, which is the guard that keeps a machine
     * whose Agent has never been switched on from growing a database because
     * something read its state — the same condition `thread()` and `cursor()`
     * check before they open anything.
     */
    const unread = settings.threadId ? this.inbox({ limit: 1 }).unread : 0;
    return {
      enabled: settings.enabled,
      inboxUnread: unread,
      ...(settings.threadId ? { threadId: settings.threadId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.access ? { access: settings.access } : {}),
      ...(settings.generation === undefined ? {} : { generation: settings.generation }),
      running: this.live !== undefined && this.pending === undefined,
      ...(this.live ? { runId: this.live.turn.runId } : {}),
      queued: this.queue.length,
      ...(this.pending ? { request: this.pending } : {}),
      ...(this.lastUsage ? { lastUsage: this.lastUsage } : {}),
    };
  }

  /* -------------------------------------------------------------- *
   * Reading.
   * -------------------------------------------------------------- */

  thread(options: { after?: number; limit?: number } = {}): { rows: AgentRow[]; cursor: number; more: boolean; threadId?: string } {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return { rows: [], cursor: 0, more: false };
    const { log } = this.open();
    return { ...log.page(threadId, Math.max(0, options.after ?? 0), options.limit ?? THREAD_PAGE_DEFAULT), threadId };
  }

  /** THE LAST PAGE FIRST, then backwards — what a screen opening a long thread
   *  reads instead of walking it (#580). See `AgentThreadLog.window`. */
  threadWindow(options: { before?: number; limit?: number } = {}): { rows: AgentRow[]; cursor: number; oldest?: number; more: boolean; threadId?: string } {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return { rows: [], cursor: 0, more: false };
    const { log } = this.open();
    return {
      ...log.window(threadId, {
        ...(options.before === undefined ? {} : { before: options.before }),
        limit: options.limit ?? THREAD_PAGE_DEFAULT,
      }),
      threadId,
    };
  }

  /** The end of the transcript, so a watcher can start from the tail without
   *  paging a whole conversation to reach it. */
  cursor(): number {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return 0;
    return this.open().log.cursor(threadId);
  }

  /**
   * THE AGENT'S OWN MEMORY, AS A CAPABILITY THE WALL CAN BE BUILT OVER (#541 F).
   *
   * HANDED OUT RATHER THAN HELD, because the daemon assembles the tool list and
   * this object owns the two things these verbs touch: the standing document
   * beside `agent.json`, and the transcript's own search index. A wall built
   * over this reaches neither directly.
   *
   * `recall` IS SCOPED TO THE LIVE THREAD, and answers nothing when the Agent is
   * off or has been reset — an archived conversation is a different file, and
   * searching it would answer a question about a thread the person retired.
   */
  memory(): AgentMemoryCapability {
    return {
      // HANDED STRAIGHT THROUGH (#607). This used to reshape the write into
      // `{ sections }` — the whole document, echoed back to confirm one
      // sentence the caller had just written. The result now says which section
      // and how big, and the wall turns that into an answer.
      remember: (section, text) => rememberSection(this.paths, section, text, this.now),
      recall: (query, limit): AgentRecallHit[] => {
        const threadId = readAgentSettings(this.paths).threadId;
        if (!threadId) return [];
        const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean);
        return this.open().log.search(threadId, terms, limit);
      },
    };
  }

  /**
   * THE TWO HALVES OF `fleet_status` THAT ARE THE AGENT'S OWN (#570).
   *
   * The other five members of `AgentFleetCapability` are the STORE's — the rail,
   * a session, its last turn, its open requests — and the daemon wires those.
   * These two are not: the `who` section is the standing document this object
   * owns, and the inbox is this thread's own unread news. Handed over the same
   * seam `memory()` uses, for its reason: a test drives the tool with functions
   * and no daemon, and the daemon composes one capability out of two owners.
   */
  fleet(): Pick<AgentFleetCapability, "who" | "unread" | "since"> {
    return {
      who: () => readStanding(this.paths).sections.who,
      // THE BOUNDARY "RECENTLY" MEANS, and it is this object's to answer for the
      // same reason the other two are: the thread is the Agent's own, and when
      // it last looked at the fleet is a fact about this conversation rather
      // than about any session in it.
      since: (): number | undefined => {
        const threadId = readAgentSettings(this.paths).threadId;
        return threadId ? this.open().log.previousTurnStart(threadId) : undefined;
      },
      unread: (): Record<string, number> => {
        const threadId = readAgentSettings(this.paths).threadId;
        if (!threadId) return {};
        const counted: Record<string, number> = {};
        // BOUNDED BY `AgentInbox.unread`'s own scan, which is the digest's: a
        // machine left running over a holiday must not make a status question
        // walk ten thousand rows.
        for (const row of this.open().inbox.unread(threadId)) counted[row.sessionId] = (counted[row.sessionId] ?? 0) + 1;
        return counted;
      },
    };
  }

  /** Push events to a watcher until it unsubscribes. The caller is responsible
   *  for the rows BEFORE its cursor — it pages those, then watches. */
  watch(listener: (event: AgentStreamEvent) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  private push(event: AgentStreamEvent): void {
    for (const watcher of [...this.watchers]) {
      try {
        watcher(event);
      } catch {
        // A watcher whose socket has gone must not take down the turn that was
        // talking to it. It will be dropped when its own route notices.
      }
    }
  }

  /**
   * ONE ROW, ON THE THREAD IT IS ABOUT — or nowhere.
   *
   * THE THREAD CHECK IS NOT PARANOIA, it is a reset. Resetting aborts the live
   * turn, and that turn unwinds a moment LATER, in the pump's own catch — by
   * which time `agent.json` names a different conversation. Without this, a
   * brand-new thread's first row would be the ending of a turn from the
   * conversation that was just archived, carrying a run id that appears
   * nowhere else in it.
   */
  private row(kind: AgentRow["kind"], runId: string, detail: Record<string, unknown>): AgentRow | undefined {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return undefined;
    if (this.turnThreadId !== undefined && this.turnThreadId !== threadId) return undefined;
    const row = this.open().log.append({ threadId, runId, at: this.now(), kind, detail });
    this.push({ type: "row", row });
    return row;
  }

  /* -------------------------------------------------------------- *
   * Turns.
   * -------------------------------------------------------------- */

  /**
   * QUEUE A TURN, AND ANSWER ITS RUN ID AT ONCE.
   *
   * The id is minted here rather than by the caller so two clients pressing
   * send cannot collide, and it is returned before the turn runs because the
   * composer needs something to follow — the same contract `submitTurn` has for
   * a session.
   */
  submit(input: { text: string; origin?: AgentTurnOrigin; wakeReason?: Record<string, unknown>; brief?: boolean }): { runId: string; queued: number } {
    const settings = readAgentSettings(this.paths);
    if (!settings.enabled || !settings.threadId) throw new Error("Telar's Agent is switched off.");
    const text = input.text.trim();
    if (!text) throw new Error("a turn needs something to say");
    const turn: QueuedTurn = {
      runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
      input: text,
      origin: input.origin ?? "human",
      ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
      ...(input.brief ? { brief: true } : {}),
    };
    this.queue.push(turn);
    void this.pump();
    return { runId: turn.runId, queued: this.queue.length };
  }

  /**
   * A SESSION'S COMPLETION OR PARKED REQUEST, AS AN INBOX ROW — AND NO TURN
   * (#541 A).
   *
   * THIS IS THE CHANGE THE ISSUE IS ABOUT. A wake used to `submit` a turn whose
   * input was the engine's notice: a model call, a lap of the graph, a
   * transcript row, tokens — to announce a fact nobody had asked about. Four
   * workers under one Agent meant four such turns at 3am, each re-reading the
   * whole conversation to say "that one finished too". The Agent does not ACT on
   * a completion; it tells the person about it the next time they speak. So the
   * happening becomes one row in `./inbox.ts`, and `./digest.ts` renders what is
   * unread at the top of the next turn a PERSON begins.
   *
   * THE ROW IS PUSHED to whoever is watching the stream, so a cockpit can badge
   * it without waiting for its next poll.
   *
   * SILENT WHEN THE AGENT IS OFF, and for the same reason it always was: a
   * subscription outliving the switch is a real state — the store keeps
   * subscription rows — and a wake it produces has nowhere to go. Throwing would
   * fail the turn whose ending caused it.
   */
  wake(input: { notification: NotificationDetail }): AgentInboxRow | undefined {
    try {
      const threadId = readAgentSettings(this.paths).threadId;
      if (!threadId) return undefined;
      const fields = inboxRowFromNotification(input.notification);
      if (!fields) return undefined;
      const row = this.open().inbox.append({ threadId, at: this.now(), ...fields });
      this.push({ type: "inbox", row });
      return row;
    } catch {
      // Switched off, or reset out from under the subscription.
      return undefined;
    }
  }

  /* -------------------------------------------------------------- *
   * The inbox.
   * -------------------------------------------------------------- */

  /** A page of the inbox, newest-ward from a cursor. `unreadOnly` is what the
   *  section above the composer asks for. */
  inbox(options: { after?: number; limit?: number; unreadOnly?: boolean } = {}): { rows: AgentInboxRow[]; cursor: number; more: boolean; unread: number } {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return { rows: [], cursor: 0, more: false, unread: 0 };
    const { inbox } = this.open();
    return { ...inbox.page(threadId, options), unread: inbox.unreadCount(threadId) };
  }

  /** Mark rows read by id, and answer how many actually moved. A client that
   *  sends an id twice, or one already read, is told `0` rather than being
   *  congratulated on a write that did nothing. */
  markInboxRead(ids: readonly number[]): { read: number; unread: number } {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return { read: 0, unread: 0 };
    const { inbox } = this.open();
    return { read: inbox.markRead(threadId, ids), unread: inbox.unreadCount(threadId) };
  }

  /**
   * STOP THE LIVE TURN WHERE IT STANDS.
   *
   * WHAT IT DOES NOT DO is undo anything: a `sessions_send` that already
   * reached the store has landed, and the person who pressed Stop is told that
   * rather than promised otherwise. Resuming is a new turn, from the last
   * checkpoint — which is what makes the replay safe, since the effect ledger
   * came back with it.
   */
  cancel(runId?: string): boolean {
    const before = this.queue.length;
    if (runId) this.queue = this.queue.filter((turn) => turn.runId !== runId);
    if (this.live && (runId === undefined || this.live.turn.runId === runId)) {
      this.live.controller.abort();
      // A turn parked for a person is not awaiting the model, so aborting the
      // signal alone would leave it waiting for an answer that will never come.
      this.answer?.("decline");
      return true;
    }
    return this.queue.length !== before;
  }

  /**
   * ANSWER THE PARKED APPROVAL.
   *
   * BY ID, so a stale client cannot answer a question that has already been
   * answered and accidentally approve the next one. The id is the request's
   * own, minted when it parked.
   */
  resolveRequest(requestId: string, decision: AgentApprovalDecision): boolean {
    if (!this.pending || this.pending.id !== requestId) return false;
    const pending = this.pending;
    this.row("request_resolved", pending.runId, { requestId, decision, tool: pending.tool });
    this.pending = undefined;
    if (this.answer) {
      // The turn is still in this process, waiting on the promise below.
      const answer = this.answer;
      this.answer = undefined;
      answer(decision);
      return true;
    }
    /**
     * NOBODY IS WAITING — this approval was parked by a PROCESS THAT IS GONE,
     * and `restore` found it in the checkpoint. The answer therefore starts a
     * turn rather than settling a promise: same run id, same thread, and the
     * graph picks up inside the node it was interrupted in.
     */
    this.queue.push({ runId: pending.runId, input: "", origin: "human", resume: decision });
    void this.pump();
    return true;
  }

  /* -------------------------------------------------------------- *
   * The pump.
   * -------------------------------------------------------------- */

  /** Start draining the queue, or join the drain already running. Returns the
   *  same promise either way, which is what makes `shutdown` able to wait. */
  private pump(): Promise<void> {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queue.shift();
      if (!next) return;
      const controller = new AbortController();
      this.live = { turn: next, controller };
      // The meter's accumulator, per turn. A stopped or failed turn reports
      // what it had spent before it ended — the tokens were bought either way.
      this.spend = { input: 0, output: 0, total: 0, reported: false, cacheReported: false, cacheRead: 0, cacheCreate: 0, contextChars: 0, folded: 0, laps: 0 };
      try {
        await this.runTurn(next, controller.signal);
      } catch (error) {
        // A STOP IS NOT A FAULT and carries no reason — the person who pressed
        // it knows why the turn ended. Everything else owes them the sentence,
        // and `failureReason` guarantees there is one.
        this.endedRow(next.runId, {
          status: controller.signal.aborted ? "stopped" : "failed",
          ...(controller.signal.aborted ? {} : { message: failureReason(error) }),
        });
      } finally {
        this.live = undefined;
        this.pending = undefined;
        this.answer = undefined;
        this.turnThreadId = undefined;
        this.spend = undefined;
        this.pendingDigest = undefined;
        this.digestDelivered = false;
      }
    }
  }

  private async runTurn(turn: QueuedTurn, signal: AbortSignal): Promise<void> {
    const settings = readAgentSettings(this.paths);
    const threadId = settings.threadId;
    if (!threadId) return;
    this.turnThreadId = threadId;
    this.open();

    // A RESUMED TURN SAYS NOTHING NEW. The person's words and the turn's start
    // were written by the process that parked the approval; writing them again
    // would put the same question in the transcript twice.
    if (!turn.resume) {
      this.row("user_message", turn.runId, {
        text: turn.input,
        origin: turn.origin,
        ...(turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
      });
      // `brief` IS ON THE ROW because it changes the answer the transcript
      // holds: a two-sentence reply under a question that deserved a page is a
      // thing a person will come back to and wonder about, and the row is where
      // the reason lives. Absent rather than false on an ordinary turn.
      this.row("turn_started", turn.runId, { origin: turn.origin, ...(turn.brief ? { brief: true } : {}) });
    }

    /**
     * THE DIGEST OPENS EVERY TURN A PERSON BEGAN (#541 A).
     *
     * ── WHY ONLY A HUMAN-STARTED TURN ───────────────────────────────────────
     * Nothing else starts one any more. A wake writes a row and stops (see
     * `wake`), and a RESUME continues a turn that already opened with a digest —
     * re-rendering it after an approval would tell the model the same news twice
     * inside one conversation, and mark rows read against a turn that had
     * already accounted for them.
     *
     * ── AND WHY IT RIDES THE SYSTEM MESSAGE ─────────────────────────────────
     * The digest is ENGINE PROSE, and #550 is exactly about engine prose not
     * riding the channel a person types on. The system message is rebuilt per
     * turn and is never checkpointed (`buildGraph` passes `[system, ...history]`
     * and only `history` is graph state), so it is also the one slot where a
     * digest cannot accumulate: turn forty does not re-read turn three's news,
     * and the trim budget accounts for the block honestly through
     * `reservedChars`.
     */
    const digest = !turn.resume && turn.origin === "human" ? renderDigest(this.open().inbox.unread(threadId)) : undefined;
    this.pendingDigest = digest?.rowIds;
    this.digestDelivered = false;

    const tools = this.options.tools();
    const graph = this.buildGraph({
      tools,
      ...(digest ? { digest: digest.text } : {}),
      // EFFORT RIDES THE MODEL, because it is a property of the REQUEST rather
      // than of the conversation — read per turn, like the model itself and the
      // key behind it, so a person changing the pill gets it on their next
      // message and not on the next restart.
      model: this.options.model({
        threadId,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
      }),
      runId: turn.runId,
      // ONE PORT PER TURN, because one graph is one turn — see `AgentEraLog.port`.
      eras: this.open().eras.port(threadId),
      ...(settings.access ? { access: settings.access } : {}),
      // THE ANSWER'S SHAPE, FOR THIS TURN ONLY (#567). It rides the graph
      // because the graph owns the system block, and it is read off the queued
      // turn rather than off the settings so the written UI is untouched.
      ...(turn.brief ? { brief: true } : {}),
    });
    const config: RunnableConfig = {
      configurable: { thread_id: threadId },
      /**
       * THE BACKSTOP, ABOVE THE CAP THAT NOW FIRES FIRST (#570).
       *
       * One lap is two supersteps, plus the final model call that answers, so
       * `callModel`'s own cap lands the turn at superstep 2·maxLaps−1 and this
       * is never reached on the path the person sees. It is kept because it
       * bounds the one case the cap does not: a graph rebuilt mid-turn starts
       * its lap count again, and a ceiling that only existed while the counter
       * was trustworthy would not be a ceiling.
       *
       * IT FOLLOWS THE SPOKEN CAP DOWN (#603) through the same `lapCeiling` the
       * node uses, so the backstop stays above the cap rather than seven laps
       * above it.
       */
      recursionLimit: lapCeiling(this.options.maxLaps ?? MAX_LAPS, turn.brief) * 2 + 1,
      signal,
    };

    /** The first pass carries the person's words; every pass after an approval
     *  carries the decision instead, which is how LangGraph resumes a parked
     *  interrupt rather than restarting the node with new input. Typed off the
     *  compiled graph so the node names in `Command`'s own generics stay right
     *  when a node is added. */
    let input: Parameters<typeof graph.stream>[0] = turn.resume
      ? new Command({ resume: turn.resume })
      : { messages: [new HumanMessage(turn.input)] };
    for (;;) {
      /**
       * `streamMode: "messages"` IS WHERE THE TOKENS COME FROM. Tool rows are
       * emitted by the tools node itself instead: the node knows a call is
       * about to run, and a row derived from the stream could only ever say
       * that one already had.
       */
      for await (const part of await graph.stream(input, { ...config, streamMode: "messages" })) {
        if (signal.aborted) break;
        const [chunk] = part as [unknown, unknown];
        const message = chunk as { content?: unknown; id?: string; getType?: () => string };
        if (message?.getType?.() !== "ai") continue;
        // BOTH SHAPES, because a streamed chunk carries whatever its route's
        // client builds — a bare string on chat/completions, a text block on
        // the other two. See `assistantText`.
        const text = assistantText(message.content);
        if (text) this.push({ type: "delta", runId: turn.runId, itemId: message.id ?? turn.runId, text });
      }
      signal.throwIfAborted();

      const snapshot = await graph.getState(config);
      const parked = firstInterrupt(snapshot);
      if (!parked) break;

      const decision = await this.park(parked, turn.runId, signal);
      input = new Command({ resume: decision });
    }

    const snapshot = await graph.getState(config);
    const text = lastAssistantText(snapshot.values?.messages ?? []);
    this.endedRow(turn.runId, { status: "completed", ...(text ? { text } : {}) });
  }

  /**
   * THE ONE PLACE A TURN ENDS — `turn_done`, with the meter folded in (#539).
   *
   * Every ending goes through here (completed, stopped, failed) so the context
   * meter cannot be a property of only the happy path: a turn that spent 40k
   * tokens and then failed spent them, and a transcript whose usage appeared
   * only on success would understate what the machine cost.
   *
   * IT ALSO UPDATES `lastUsage`, in the same call that writes the row, so the
   * state a client polls and the transcript it pages can never disagree about
   * which turn the meter is showing.
   */
  private endedRow(runId: string, detail: Record<string, unknown>): void {
    const spend = this.spend;
    const budgetChars = this.options.budgetChars ?? DEFAULT_AGENT_BUDGET_CHARS;
    const usage: AgentUsage | undefined = spend?.reported
      ? {
          input: spend.input,
          output: spend.output,
          total: spend.total,
          // ONLY WHEN SOME LAP ACTUALLY CARRIED DETAILS — see `AgentUsage.cacheRead`.
          // The two travel together: a route that reports one reports both, and
          // writing `cacheRead` without `cacheCreate` would invite a reader to
          // treat the missing one as zero on the route that has no such field.
          ...(spend.cacheReported ? { cacheRead: spend.cacheRead, cacheCreate: spend.cacheCreate } : {}),
        }
      : undefined;
    const contextChars = spend?.contextChars ?? 0;
    // WRITTEN EVEN WHEN IT IS ZERO, like the two numbers beside it: these three
    // are one reading, and a field that appeared only on the turns that folded
    // would leave a client unable to tell "folded nothing" from "an engine too
    // old to say".
    const folded = spend?.folded ?? 0;
    // AND HOW MANY MODEL CALLS IT TOOK (#570) — on the same row and by the same
    // rule. It is the reading the lap cap exists to bound, so a turn that ended
    // at the cap and a turn that answered on its first call are told apart in
    // the transcript rather than by counting tool rows.
    const laps = spend?.laps ?? 0;
    const row = this.row("turn_done", runId, {
      ...detail,
      ...this.failureWords(detail),
      ...(usage ? { usage } : {}),
      contextChars,
      budgetChars,
      folded,
      laps,
    });
    // Only when the row landed: a row suppressed because the thread was reset
    // mid-turn belongs to a conversation that no longer exists, and its meter
    // with it.
    if (row) this.lastUsage = { runId, at: row.at, ...(usage ? { usage } : {}), contextChars, budgetChars, folded, laps };
    /**
     * THE DIGEST'S ROWS ARE READ NOW — every ending, not only the happy one
     * (#541 A).
     *
     * A turn that was shown the news and then failed was still shown it, and
     * re-announcing four completions at the top of the next turn because the
     * first one fell over would make the digest a thing that repeats until a
     * turn happens to succeed. The guard is `digestDelivered`, not the status:
     * what matters is whether a prompt carrying the block was ever built.
     *
     * NOT GUARDED ON `row` LIKE THE METER ABOVE. A reset mid-turn archives the
     * whole database, inbox and all, so there is nothing left to mark and the
     * call is a no-op on the new file's empty table.
     */
    if (this.pendingDigest && this.digestDelivered) {
      try {
        this.markInboxRead(this.pendingDigest);
      } catch {
        // A thread closed or archived underneath this is not worth failing a
        // turn's ending over.
      }
    }
    this.pendingDigest = undefined;
    this.digestDelivered = false;
  }

  /**
   * A FAILED TURN SAYS SO, TO BOTH READERS OF A `turn_done` ROW (#602).
   *
   * ── WHY THIS IS A RULE OF THE ROW AND NOT OF ITS ONE CALLER ─────────────────
   * The drain's catch is where a failure comes from today, and it already writes
   * `message`. Putting the guarantee HERE instead makes it a property of the row
   * rather than of the code path that happened to write it: any future ending
   * that says `failed` says why, without a second author having to remember.
   *
   * ── AND `text`, WHICH IS THE HALF THAT WAS ACTUALLY SILENT ──────────────────
   * `turn_done` has two readers. One folds the whole log and draws a failure
   * from `status` + `message` — that is the cockpit's transcript, and it has
   * always worked. The OTHER wants ONE ANSWER PER TURN and reads
   * `turn_done.detail.text`; `apps/web/lib/agent/thread.ts` documents that
   * contract, and the voice client is the reader that lives by it. A failed turn
   * carried no `text` at all, so to that reader a turn that fell over and a turn
   * that has not happened are the same thing: nothing. Three of the failures
   * #602 measured were spoken questions, which is exactly where silence costs
   * the most.
   *
   * SO THE REASON BECOMES THE TURN'S ANSWER when it has no other. Never over the
   * top of real words — a turn that said something and then fell over keeps what
   * it said — and the transcript is unaffected, because it never draws
   * `turn_done.text`.
   */
  private failureWords(detail: Record<string, unknown>): Record<string, unknown> {
    if (detail.status !== "failed") return {};
    const said = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
    const reason = said(detail.message) || TURN_FAILED_WITHOUT_REASON;
    return { message: reason, ...(said(detail.text) ? {} : { text: reason }) };
  }

  /**
   * PARK, AND WAIT FOR A PERSON.
   *
   * The promise is what holds the turn: the graph has already written its
   * checkpoint (the interrupt is IN it), so a restart here loses nothing — the
   * request is re-read from the checkpoint and the conversation resumes. What
   * does not survive is this process's promise, which is why an abort settles
   * it as a decline rather than leaving it hanging.
   */
  private park(request: AgentApprovalRequest, runId: string, signal: AbortSignal): Promise<AgentApprovalDecision> {
    const pending: AgentPendingRequest = { ...request, id: `req_${crypto.randomUUID().replaceAll("-", "")}`, runId, openedAt: this.now() };
    this.pending = pending;
    this.row("request_opened", runId, { ...pending });
    return new Promise<AgentApprovalDecision>((resolve) => {
      this.answer = resolve;
      if (signal.aborted) {
        this.answer = undefined;
        this.pending = undefined;
        resolve("decline");
        return;
      }
      signal.addEventListener("abort", () => resolve("decline"), { once: true });
    });
  }

  /* -------------------------------------------------------------- *
   * The graph.
   * -------------------------------------------------------------- */

  private buildGraph(context: {
    tools: SocketTool[];
    model: BaseChatModel | undefined;
    runId: string;
    access?: AgentSettings["access"];
    digest?: string;
    brief?: boolean;
    /** WHERE THE SETTLED HALF OF THE FOLD IS KEPT (#599) — see `./eras.ts`.
     *  Scoped to ONE thread and to ONE graph, which is one turn: the port
     *  memoises its read, so the laps after the first read nothing. Absent on
     *  `restore`'s graph, which only ever reads state and never folds. */
    eras?: EraStore;
  }) {
    const byName = new Map(context.tools.map((tool) => [tool.name, tool]));
    /**
     * THE READS THIS TURN HAS ALREADY PAID FOR — see `memoKey` (#592).
     *
     * ITS SCOPE IS THIS OBJECT'S LIFETIME, and that is the point: `runTurn`
     * builds one graph per turn and a resumed turn builds another, so the memo
     * begins empty on every turn without anything having to clear it. A resume
     * starting cold is the conservative direction too — the aborted attempt's
     * `ToolMessage`s were never committed, so its reads must genuinely run
     * again rather than be pointed at answers that are not in the thread.
     */
    const memo = new Set<string>();
    /**
     * WHAT "THE LATEST TURN" RESOLVED TO, PER SESSION, ON THIS TURN (#608).
     *
     * Written only from a reply to a call that OMITTED `runId`, so it holds the
     * store's own resolution and never a guess. Its lifetime is the memo's, for
     * the memo's reason: a mapping that outlived the turn would answer "the
     * latest" with a turn that has since been overtaken.
     *
     * THE ONE EDGE, STATED RATHER THAN GUARDED: a peer that finishes a turn
     * while this one is running makes "the latest" older than the truth, and a
     * second omitted-runId read is pointed at the first resolution. That is the
     * memo's existing premise — nothing changes mid-turn, and what did arrives
     * as a notification on the next one — and `fleet_status` has been just as
     * stale since #592. An explicit `runId` is unaffected either way.
     */
    const latestAnswered = new Map<string, string>();
    /**
     * BOUND AS FUNCTION DEFINITIONS, NOT AS LANGCHAIN TOOL OBJECTS.
     *
     * The wall already produces a JSON Schema for its own MCP socket
     * (`toolInputSchema`), and the model only ever needs the schema — execution
     * goes through `SocketTool.run` below, which is what carries the tool call
     * id the idempotency key is derived from. Wrapping each wall tool in a
     * LangChain `tool()` would add a second zod bridge and put the framework
     * between us and the call id, for nothing.
     *
     * `agentToolSpecs` IS WHERE THE SHAPE IS NARROWED for this one binding —
     * see it for why `$schema` goes and why only here (#563).
     *
     * AND ON A SPOKEN TURN THE LIST IS NARROWED TOO (#603): 13,973 bytes of
     * wall becomes 5,484, on every lap. `context.tools` is untouched — `byName`
     * below still holds all 25, which is what lets a withheld call be REFUSED
     * rather than merely missing. See `SPOKEN_WALL`.
     */
    const specs = agentToolSpecs(context.tools, { spoken: context.brief === true });
    /** Was this name kept off THIS turn's binding? Asked twice below — once so
     *  nobody is woken for a call that will be refused, once to refuse it. */
    const withheld = (name: string): boolean => context.brief === true && byName.has(name) && !onSpokenWall(name);
    /**
     * THE SYSTEM BLOCK, IN FOUR, FROM MOST PERMANENT TO LEAST: the briefing, the
     * orientation, WHAT THE AGENT REMEMBERS, and then the news.
     *
     * STANDING STATE IS NOT IN THE TRANSCRIPT (#541 part F). It is what is TRUE
     * NOW rather than something that was said, so it is rewritten in place by
     * `remember` and read here once per turn; putting it in the message list
     * would make every edit an append and leave three contradicting copies in
     * the history.
     *
     * THE DIGEST STAYS LAST, under it (#541 A). Both are engine prose in the one
     * slot that is rebuilt per turn and never checkpointed, and the order is the
     * argument each made for itself: the standing state is a settled account of
     * the work and the digest is what happened since the person last spoke, so a
     * reader arriving at the news has already been told what it is looking at.
     *
     * AND THE ORDER IS WHAT A CACHE PREFIX CAN MATCH. The briefing and the
     * orientation are the same characters on every turn of every conversation,
     * the standing state changes between turns, and the digest changes every
     * turn — which is the shape #563 item 3 will want when it marks a prefix
     * cacheable, in its own PR.
     *
     * READ PER TURN, not per lap: a `remember` call inside this turn lands on
     * the NEXT turn's prompt. The alternative is a system block that changes
     * between laps of one turn, which is a cache miss on every lap and a model
     * watching its own instructions move mid-thought.
     *
     * AND `brief` GOES UNDER ALL OF IT (#567), because it is the least
     * permanent thing here: not a setting, not a property of the conversation,
     * but of the ONE request a voice client sent. See `AGENT_BRIEF_ANSWER`.
     */
    const standing = renderStanding(readStanding(this.paths));
    const system = new SystemMessage(
      [
        // THE SPOKEN BRIEFING IS THE SAME CLAUSES, TAGGED (#603) — not a second
        // text. What is dropped is what a spoken turn's nine-tool wall makes
        // FALSE, plus one clause whose content its tool's own schema carries.
        context.brief ? AGENT_SPOKEN_BRIEFING : AGENT_BRIEFING,
        this.options.orientation?.(),
        standing,
        context.digest,
        context.brief ? AGENT_BRIEF_ANSWER : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const budget = this.options.budgetChars;

    const callModel = async (state: AgentGraphStateType, config?: RunnableConfig): Promise<Partial<AgentGraphStateType>> => {
      // `restore` compiles this graph with no model at all — it only ever reads
      // state — so a node that somehow ran without one says so rather than
      // dereferencing undefined.
      if (!context.model) throw new Error("the Agent has no model for this turn");
      // THE DIGEST HAS BEEN DELIVERED once a prompt carrying it has been built.
      // `endedRow` marks its rows read only after this, so a turn stopped before
      // it ever reached the model leaves the news unread for the next one.
      if (context.digest) this.digestDelivered = true;
      /**
       * THE LAP CAP, SPENT AS A LANDING (#570) — see `MAX_LAPS`.
       *
       * COUNTED ON `spend`, which is the turn's own accumulator: it is created
       * per turn in `drain` and is the same object `endedRow` reports from, so
       * the number that bounds the loop and the number written to `turn_done`
       * cannot disagree. A graph rebuilt mid-turn (a restart resuming a parked
       * approval) gets a fresh one and a fresh budget — deliberate, and the
       * reason `recursionLimit` is still set above this.
       *
       * `final` IS DECIDED BEFORE THE CALL, so this lap is the one that answers
       * rather than the one that discovers it cannot continue. With no tools
       * bound the model has nothing to call, `shouldContinue` sees no
       * `tool_calls` and routes to END.
       */
      const laps = this.spend ? (this.spend.laps += 1) : 1;
      const final = laps >= lapCeiling(this.options.maxLaps ?? MAX_LAPS, context.brief);
      // THE SPOKEN LANDING IS A DIFFERENT SENTENCE (#603), because the answer it
      // lands in is one sentence long and the gap has to be inside it.
      const landing = context.brief ? OUT_OF_LAPS_SPOKEN : OUT_OF_LAPS;
      const prompt = final ? new SystemMessage(`${String(system.content)}\n\n${landing}`) : system;
      const bound = final ? context.model : context.model.bindTools?.(specs as never) ?? context.model;
      /**
       * THE PRE-MODEL STEP, IN THREE, AND THE ORDER IS THE ARGUMENT.
       *
       * 1. COMPACT THIS TURN'S LAPS (#563). Earlier laps' results collapse to a
       *    line each. This is what makes a 16-lap turn cost what a 3-lap one
       *    does, and it runs first because it is the cheapest and the most of
       *    what a long turn weighs.
       * 2. FOLD OLDER TURNS (#541 part F). What is still over budget after that
       *    is a long CONVERSATION rather than a long turn, so the oldest turns
       *    are replaced by one deterministic line each — the projection in
       *    `./compact.ts`, never a model call, never a summary of a summary.
       * 3. TRIM, AS A BACKSTOP — see `./trim.ts`. It DROPS, which is why it is
       *    last and should now never fire: everything it would have thrown away
       *    has already become a line the model can still read.
       *
       * THE METER MEASURES THE END OF THAT, so what a person is shown is what
       * was really sent rather than what would have been.
       */
      const budgetChars = budget ?? DEFAULT_AGENT_BUDGET_CHARS;
      // MEASURED ON THE BLOCK THIS LAP ACTUALLY SENDS, which on the last lap is
      // one sentence longer than the others — the meter is what was sent.
      const reservedChars = String(prompt.content).length;
      // 0. ANSWER ANY CALL NOTHING EVER ANSWERED — see `answerOrphanedCalls`.
      //    First, because every step after it groups results under their call.
      const folded = foldOldTurns(compactToolResults(answerOrphanedCalls(state.messages)), {
        budgetChars,
        reservedChars,
        ...(context.eras ? { eras: context.eras } : {}),
      });
      const history = trimAgentHistory(folded.messages, { budgetChars, reservedChars });
      /**
       * THE PROMPT'S SIZE, TAKEN WHERE IT IS DECIDED — the context meter's
       * denominator (#539). The LAST lap wins rather than the largest: a turn
       * that called three tools ends with the fullest prompt it ever sent, and
       * that is the number a person reading "how full is this conversation"
       * means. Recorded before the call, so a turn the model refuses still
       * reports what it tried to send.
       */
      if (this.spend) {
        this.spend.contextChars = history.chars;
        // AND HOW MANY TURNS IT COST TO GET THERE (#567). Same lap, same rule:
        // the fold is recomputed from the raw turns every lap, so the last
        // lap's count is the one that describes the prompt that was sent.
        this.spend.folded = folded.folded;
      }
      // CONFIG IS PASSED THROUGH so the turn's abort signal reaches the
      // provider call. A cancel that unwound the graph and left the request in
      // flight would not be a cancel.
      const answer = (await bound.invoke([prompt, ...history.messages], config)) as AIMessage;
      /**
       * THE MODEL'S OWN TOKEN COUNT, SUMMED OVER THE TURN'S LAPS. Nothing here
       * counts tokens — `usage_metadata` is what the provider reported, and a
       * provider that reported nothing leaves `reported` false so the meter can
       * say "no count" rather than "zero".
       */
      const usage = answer.usage_metadata;
      if (this.spend && usage) {
        this.spend.input += usage.input_tokens ?? 0;
        this.spend.output += usage.output_tokens ?? 0;
        this.spend.total += usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        this.spend.reported = true;
        /**
         * AND HOW MUCH OF THAT INPUT CAME OUT OF THE CACHE (#563 item 3).
         *
         * ── ONE FIELD, THREE ROUTES, AND LANGCHAIN ALREADY DID THE JOINING ────
         * `input_token_details` is `@langchain/core`'s normalised shape and every
         * client the Agent's factory can build fills it: `cached_tokens` from
         * chat/completions' `prompt_tokens_details`, the same from `/responses`'
         * `input_tokens_details`, and `cache_read_input_tokens` /
         * `cache_creation_input_tokens` from the Anthropic shape. MEASURED
         * against a local server on all three, streaming and not — see
         * `agent-prefix.test.ts`. So there is no route branch here either, which
         * is the rule `model.ts` keeps one layer down.
         *
         * THE SIGNAL IS A FIELD BEING PRESENT, NOT THE DETAILS OBJECT BEING
         * THERE — and that distinction is MEASURED rather than fastidious.
         * `@langchain/openai` 1.5.x attaches `input_token_details` to EVERY chat
         * completion, empty, even when the server sent no `prompt_tokens_details`
         * at all: its guard reads `promptTokensDetails?.audio_tokens !== null`,
         * and an absent field is `undefined`, which is not `null`, so the branch
         * always runs. A flag set on the object's existence would therefore have
         * reported "cache cold, 0 tokens read" for every provider on earth that
         * declines to forward cache statistics — which is the exact false
         * measurement item 3 exists to avoid, and it would have looked like a
         * finding rather than like a bug.
         *
         * SO THE TEST IS ON THE NUMBERS THEMSELVES. A provider that says
         * `cache_read: 0` IS telling us the cache was cold, and that is a real
         * and different sentence from saying nothing; both survive this read.
         */
        const details = usage.input_token_details;
        if (details && (details.cache_read !== undefined || details.cache_creation !== undefined)) {
          this.spend.cacheReported = true;
          this.spend.cacheRead += details.cache_read ?? 0;
          this.spend.cacheCreate += details.cache_creation ?? 0;
        }
      }
      /**
       * ONE ROW PER THING THE ASSISTANT SAYS, AS IT SAYS IT.
       *
       * THE BUG THIS FIXES: a turn that says something and THEN calls a tool
       * lost the said text entirely. Only `turn_done.detail.text` reached a
       * row, and that carries the LAST assistant message of the turn — so
       * "I'll check the rail" followed by `sessions_list` left a transcript in
       * which the Agent narrated nothing and simply acted.
       *
       * EMITTED FROM THE NODE rather than derived from the stream, for the
       * reason the tool rows already are: the node holds the finished message,
       * where a row derived from deltas would have to decide for itself when a
       * message had ended.
       *
       * `itemId` IS THE MESSAGE'S OWN ID, which is also what the deltas carry,
       * so a client that has been painting a live bubble can reconcile it with
       * the row that lands rather than drawing the same sentence twice.
       *
       * A ROUND THAT ONLY CALLS TOOLS SAYS NOTHING, and writes no row — the
       * same rule `main-session/driver.ts` had for its text item: an empty
       * speech bubble in the transcript is worse than none.
       *
       * `turn_done.detail.text` IS UNCHANGED BY THIS ROW, deliberately. It is
       * the turn's ANSWER — what a list view renders without replaying the
       * thread — and the final assistant row is the same words in the
       * conversation. Two readers, two shapes, one of them keyed by run. (The
       * one turn whose `text` is not an assistant's words is a FAILED one, which
       * has none and says why instead — see `failureWords`.)
       */
      const said = assistantText(answer.content);
      if (said.trim()) this.row("assistant_message", context.runId, { text: said, itemId: answer.id ?? context.runId });
      return { messages: [answer] };
    };

    const callTools = async (state: AgentGraphStateType, config?: RunnableConfig): Promise<Partial<AgentGraphStateType>> => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      const calls = last?.tool_calls ?? [];
      if (calls.length === 0) return {};

      // PASS 1 — every approval, before any effect. See the header.
      const decisions = new Map<string, AgentApprovalDecision>();
      for (const call of calls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        // A CALL THIS TURN WILL REFUSE IS NOT WORTH WAKING ANYBODY FOR (#603).
        // Above `needsApproval` because the alternative is the worst outcome in
        // the issue: a spoken turn parked on an approval for a `sessions_stop`
        // that was never going to run, with the person waiting to hear an answer.
        if (withheld(call.name)) continue;
        if (!needsApproval({ name: call.name, args })) continue;
        // AN EFFECT ALREADY ON THE LEDGER IS NOT ASKED ABOUT AGAIN: the person
        // approved this exact call once, nothing new will happen, and waking
        // them for it would teach them that approvals are noise.
        const key = ledgerKey(call.name, args);
        if (key && state.effects[key] !== undefined) continue;
        const request = approvalRequest({ name: call.name, args }, call.id ?? "");
        /**
         * `access: "auto"` — THE QUESTION IS STILL ASKED, AND POLICY ANSWERS IT
         * (#539).
         *
         * This is `openRequest`'s own shape for a session's runtime mode, one
         * level down: the request is OPENED and then RESOLVED in the same
         * breath, stamped `resolvedBy: "policy"`, so the transcript records
         * that a gated call happened and who let it through. A mode that simply
         * skipped the gate would leave a conversation in which the Agent
         * created three sessions and nothing anywhere says a decision was made.
         *
         * WHAT DOES NOT CHANGE IS WHICH CALLS REACH HERE. `needsApproval` is
         * untouched — same tools, same argument-aware `sessions_send` rule — so
         * `auto` moves who answers and never what may be asked.
         */
        if (context.access === "auto") {
          this.row("request_opened", context.runId, { ...request, id: `req_${crypto.randomUUID().replaceAll("-", "")}`, runId: context.runId, openedAt: this.now() });
          this.row("request_resolved", context.runId, { requestId: request.toolCallId, decision: "accept", resolvedBy: "policy", tool: request.tool });
          decisions.set(call.id ?? "", "accept");
          continue;
        }
        decisions.set(call.id ?? "", interrupt<AgentApprovalRequest, AgentApprovalDecision>(request));
      }

      /**
       * PASS 1.5 — WHICH OF THESE CALLS IS A REPEAT, DECIDED BEFORE ANY OF THEM
       * RUNS (#592).
       *
       * IT IS A SEPARATE PASS BECAUSE THE BATCH RUNS CONCURRENTLY. Two identical
       * reads in ONE message would otherwise both find the memo empty and both
       * run — the model asked for `fleet_status` twice in the same breath, and
       * "the second one is a repeat" has to be settled while that is still a
       * question about a list rather than a race between two promises. Deciding
       * it here also makes it deterministic: the FIRST position wins, whatever
       * order the work finishes in.
       *
       * A repeat is a key already answered on an earlier lap of this turn, or an
       * earlier position in this same batch.
       *
       * IT CARRIES THE POINTER RATHER THAN A BARE FLAG (#608), because there are
       * now two ways to be a repeat and they do not read the same: one says "you
       * made this exact call", the other says "you already have this run's whole
       * answer, under different arguments". Deciding which sentence applies is
       * the same decision as deciding that it IS a repeat, so it is made once,
       * here, rather than reconstructed where the message is built.
       *
       * THE RUN CHECK GOES FIRST. A call can be both — the same arguments twice
       * AFTER the run is known whole — and naming the run is the more useful of
       * the two sentences, since it also forecloses the next re-spelling.
       */
      const repeats = new Map<number, string>();
      const batch = new Set<string>();
      calls.forEach((call, index) => {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const run = answerRunFor(call.name, args, latestAnswered);
        if (run && memo.has(answerRunKey(run.sessionId, run.runId))) {
          repeats.set(index, runPointer(run.sessionId, run.runId));
          return;
        }
        const key = memoKey(call.name, args);
        if (!key) return;
        if (memo.has(key) || batch.has(key)) {
          repeats.set(index, memoPointer(call.name, args));
          return;
        }
        batch.add(key);
      });

      /**
       * PASS 2 — THE EFFECTS, ALL OF THEM AT ONCE (#570).
       *
       * ── WHY CONCURRENTLY ────────────────────────────────────────────────────
       * One AI message's `tool_calls` are the calls the model decided it could
       * make WITHOUT seeing each other's answers — that is what putting them in
       * one message means. Running them one after another spends the sum of
       * their latencies to buy nothing: four session reads that each take 300 ms
       * cost 1.2 s sequentially and 300 ms together, and the model waits either
       * way. This node is the only thing between "the model asked for four
       * reads" and "the model has four answers", so it is the only place that
       * choice exists.
       *
       * ── WHAT IS DELIBERATELY UNCHANGED ──────────────────────────────────────
       * THE APPROVALS PASS ABOVE STAYS SEQUENTIAL, and that is the invariant the
       * whole node is built around: every gated call is asked about BEFORE any
       * effect runs, `interrupt()` parks the node on the first, and the node
       * replays from the top on resume. Starting effects concurrently with the
       * asking would land the ungated half of a batch while a person was still
       * looking at the gated half.
       *
       * THE RESULTS STAY IN THE MODEL'S OWN ORDER. `Promise.all` resolves in
       * argument order whatever order the work finished in, so the `ToolMessage`
       * list pairs with `tool_calls` positionally as it always did — some
       * providers care, and a reader of the checkpoint certainly does. Only the
       * transcript ROWS land in completion order now, which is the honest thing
       * for them to do: a row says a call happened, and they happened together.
       *
       * THE LEDGER IS UNAFFECTED because it is read from `state.effects` — the
       * state as this node was entered — and written once, below, from what the
       * batch produced. Two identical sends in ONE message both ran before this
       * change too; what the ledger has always prevented is a REPLAY of this
       * node, and that still reads a committed state write.
       */
      /**
       * A TOOL RESULT CARRIES ITS CALL ID AND NOTHING ELSE (#549).
       *
       * `ToolMessage` also takes a `name`, and setting it cost a whole model:
       * `@langchain/openai` serialises that field onto the wire message, and
       * OpenCode Go proxies some of its models (`omen-alpha` among them) to an
       * Anthropic-shaped upstream that rejects it outright — `400 …
       * messages[7]: "name" is not supported by this endpoint`, mid-conversation,
       * on the first turn that used a tool. The OpenAI-shaped routes accepted
       * the same thread, so the failure looked like the model and was the shape.
       *
       * Nothing is lost by dropping it. `tool_call_id` is what every
       * OpenAI-compatible route pairs a result to its call on, and it is what
       * the ledger, the transcript row and `sessions_send`'s idempotence all key
       * off here. The name was decoration on a field the protocol already has.
       * `model.ts`'s wrapper strips it from the body as well, so a library
       * version that starts inferring one cannot put it back.
       */
      const settled = await Promise.all(
        calls.map(async (call, index): Promise<{ message: ToolMessage; effect?: [string, string] }> => {
          const id = call.id ?? "";
          const args = (call.args ?? {}) as Record<string, unknown>;
          /**
           * A TOOL THIS TURN WAS NOT GIVEN REFUSES IN A SENTENCE (#603).
           *
           * FIRST, ABOVE THE LEDGER, AND THE ORDER IS A FORECLOSURE RATHER THAN
           * A FIX. The ledger replays a committed effect for a byte-identical
           * call and it OUTLIVES THE TURN THAT MADE IT, so a ledgered call that
           * were ever withheld would be handed its old answer here and the
           * Agent would say out loud that it had just done something it had
           * done last week — the silent absence the issue forbids, arriving
           * through the one door that is open when a tool is not bound. Today
           * the two ledgered calls (`sessions_send`, `sessions_create`) are both
           * ON the spoken wall, so nothing reaches that door; `SPOKEN_WALL` is a
           * table somebody will edit, which is why this sits above it anyway.
           *
           * IT IS A TOOL RESULT AND A ROW, not a throw: the model has to be
           * able to tell the person, and the transcript has to show that the
           * model reached for something it did not have.
           */
          if (withheld(call.name)) {
            const refusal = withheldFromSpokenTurn(call.name);
            this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: refusal, status: "failed" });
            return { message: new ToolMessage({ tool_call_id: id, content: refusal }) };
          }
          const key = ledgerKey(call.name, args);
          const already = key ? state.effects[key] : undefined;
          if (already !== undefined) {
            return { message: new ToolMessage({ tool_call_id: id, content: `${minifyToolResult(already)}\n\n[this exact call was already made on this thread; the recorded answer is above and nothing was sent again]` }) };
          }
          if (needsApproval({ name: call.name, args }) && decisions.get(id) !== "accept") {
            this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: DECLINED_ANSWER, status: "declined" });
            return { message: new ToolMessage({ tool_call_id: id, content: DECLINED_ANSWER }) };
          }
          const tool = byName.get(call.name);
          if (!tool) {
            const message = `There is no tool called ${call.name} in this conversation. Use one of the tools you were given.`;
            this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: message, status: "failed" });
            return { message: new ToolMessage({ tool_call_id: id, content: message }) };
          }
          /**
           * A READ THIS TURN ALREADY HAS — THE POINTER, NOT THE PAYLOAD (#592).
           *
           * BELOW THE LEDGER AND THE GATE, and that ordering is deliberate: a
           * memoised call is a read, reads are never gated, and the two checks
           * above answer questions this one must not be able to shadow.
           *
           * IT STILL WRITES A ROW, because a call the model MADE is a thing that
           * happened and the transcript is where a person sees how a turn was
           * spent. The row carries the pointer as its output, so the duplicate
           * is visible rather than silently missing.
           */
          const pointer = repeats.get(index);
          if (pointer !== undefined) {
            this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: pointer, status: "completed" });
            return { message: new ToolMessage({ tool_call_id: id, content: pointer }) };
          }
          let text: string;
          let failed = false;
          try {
            // THE CALL ID GOES THROUGH, which is what makes `sessions_send`
            // idempotent across a replay of this node.
            const answer = await tool.run(args, { toolCallId: id });
            text = textOf(answer.content);
            failed = answer.isError === true;
          } catch (error) {
            // EVERY OUTCOME IS A TOOL RESULT, never a thrown turn. A refusal, a
            // bad argument and a handler that threw are all things the model can
            // respond to; failing the turn would throw away a conversation over
            // one bad call. It is also what keeps ONE bad call in a batch from
            // rejecting the `Promise.all` and losing its siblings' answers.
            text = error instanceof Error ? error.message : String(error);
            failed = true;
          }
          /**
           * THE ROW GETS THE ANSWER WHOLE; THE MODEL GETS IT MINIFIED (#563).
           *
           * `json()` pretty-prints at two spaces because a PERSON reads the
           * transcript, and that whitespace is about a third of every structured
           * result. The row is written from `text` — unchanged, so the cockpit
           * still renders the outline it always did — and the message that enters
           * the checkpoint is the compact form, which every later lap of this
           * turn then resends at the smaller size.
           */
          this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: text, status: failed ? "failed" : "completed" });
          /**
           * ONLY A READ THAT ANSWERED IS REMEMBERED (#592).
           *
           * A FAILURE IS NOT "the answer has not been re-read" — it is "that did
           * not work", and a store that hiccuped once inside a turn should be
           * allowed to answer the second time it is asked. The saving is in the
           * payloads anyway: a duplicate `fleet_status` is 6,628 characters and
           * a duplicate refusal is ninety.
           */
          const memoised = memoKey(call.name, args);
          if (memoised && !failed) memo.add(memoised);
          /**
           * AND WHICH RUN THAT WAS, IF IT WAS ONE (#608).
           *
           * TWO FACTS OUT OF ONE REPLY, and they are recorded independently. The
           * resolution is worth keeping even from a PARTIAL read — it is what
           * lets a later omitted-`runId` call be recognised as the same run at
           * all — while the run itself is only closed once a reply has said
           * `more: false`. A half-read run therefore teaches the map what "the
           * latest" means without ever short-circuiting the rest of the paging.
           */
          const identity = failed ? undefined : answerIdentity(call.name, args, text);
          if (identity) {
            if (identity.latest) latestAnswered.set(identity.sessionId, identity.runId);
            if (identity.whole) memo.add(answerRunKey(identity.sessionId, identity.runId));
          }
          return {
            message: new ToolMessage({ tool_call_id: id, content: minifyToolResult(text) }),
            ...(key ? { effect: [key, text] as [string, string] } : {}),
          };
        }),
      );
      const messages = settled.map((one) => one.message);
      const effects = Object.fromEntries(settled.flatMap((one) => (one.effect ? [one.effect] : [])));
      config?.signal?.throwIfAborted();
      return { messages, effects };
    };

    const shouldContinue = (state: AgentGraphStateType): typeof END | "tools" => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      return (last?.tool_calls?.length ?? 0) > 0 ? "tools" : END;
    };

    return new StateGraph(AgentGraphState)
      .addNode("model", callModel)
      .addNode("tools", callTools)
      .addEdge(START, "model")
      .addConditionalEdges("model", shouldContinue, ["tools", END])
      .addEdge("tools", "model")
      .compile({ checkpointer: this.open().opened.saver });
  }
}

/* ------------------------------------------------------------------ *
 * Reading a graph snapshot.
 * ------------------------------------------------------------------ */

/** The one interrupt a parked graph is waiting on, with the payload our own
 *  node put in it. Several gated calls in one batch park one at a time: the
 *  node replays on resume and the next `interrupt()` throws again. */
function firstInterrupt(snapshot: { tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }> }): AgentApprovalRequest | undefined {
  for (const task of snapshot.tasks ?? []) {
    for (const parked of task.interrupts ?? []) {
      const value = parked.value as AgentApprovalRequest | undefined;
      if (value && value.type === "approval") return value;
    }
  }
  return undefined;
}

/** The assistant's last words, for the row that closes the turn. */
function lastAssistantText(messages: readonly BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.getType() !== "ai") continue;
    const content = assistantText(message.content);
    if (content.trim()) return content;
  }
  return "";
}

/** An MCP content list as the one string a `tool` message carries. */
function textOf(content: unknown[]): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string") {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.join("\n");
}
