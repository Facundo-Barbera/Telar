/**
 * The `sessions` toolkit — a session's only path to OTHER sessions.
 *
 * Built on the seams every Telar toolkit shares: a capability PORT, a wall
 * of tools built over it, `tool` arriving as an argument so no test needs an
 * SDK, and every rule about a session implemented ONCE, in the store, rather
 * than here.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
 * There is NO PARENT AND NO CHILD here. A session that calls `sessions_create`
 * gets back a session it has no relationship to: nothing links the two,
 * nothing records which one asked on either session, no depth is tracked.
 * They are peers, and every tool below treats every session the same way
 * regardless of who created it.
 *
 * WHAT A SESSION CAN HAVE INSTEAD IS A SUBSCRIPTION: an explicit, revocable,
 * one-directional wish to be WOKEN when a peer finishes a turn, fails, is
 * stopped, or parks a request. It is recorded on the subscription and on
 * neither session, it is the subscriber's to remove, and it makes no claim
 * about who owns whom — an orchestrator subscribed to ten workers and a
 * worker subscribed to its orchestrator are the same shape. The wake is a
 * real turn in the subscriber's own session (`Turn.origin: "session"`), so an
 * orchestrator that ended its turn is woken by the engine rather than left
 * polling.
 *
 * AND A SESSION CAN ANSWER A PEER'S PARKED REQUEST — a question, an approval
 * — through `sessions_resolve_request`, recorded as answered by a session so
 * the audit trail never says a person did. The one thing it cannot answer is
 * a secret pick: that is a vault item the answering session cannot see.
 *
 * ── THE ABSENCES THAT ARE RULES RATHER THAN SCOPE ───────────────────────────
 *   · NOTHING ACCEPT-SHAPED. INV-1 (`packages/core/test/invariants.test.ts`)
 *     holds that no MCP surface exposes an accept-shaped tool, and the wall
 *     below is one. Create, send, read, status, stop and diff are all fine:
 *     none of them LANDS anything. There is no merge, no push to a base
 *     branch, no "mark this session's work done" — a session's diff is
 *     readable here and is accepted by a human somewhere else, or not at all.
 *   · NOTHING THAT DELETES OR ARCHIVES. The engine has both verbs and a person
 *     reaches them from a surface they are looking at. An agent that could
 *     archive a session could erase another agent's work with one call.
 *     `sessions_settle` is deliberately NOT one of these: it moves a session
 *     out of (or back into) the list and touches nothing else — the same
 *     reversible switch as the sidebar's Settle button, so an orchestrator
 *     can tidy the peers it finished with without being handed a verb that
 *     destroys anything.
 *   · NO PERMISSION LAUNDERING, which is the one rule this wall can only SAY.
 *     See `NOT_A_BYPASS` below: it is stated in the prose of every tool that
 *     could be used for it, because that text is the only voice the wall has
 *     on a question no check here can settle.
 *   · `sessions_create` IS FAN-OUT BY ANOTHER NAME, and it is on this wall
 *     because a coordinating session is exactly who should have it. What is not
 *     here is a way to hand it to something that cannot be seen: a child
 *     process spawned inside a turn is not a session, has no row in the rail,
 *     and there is no seam on this wall for one to reach through.
 *
 * ── NO CAP ON CREATION, AND WHY ─────────────────────────────────────────────
 * There used to be a live-session budget in `EngineStore.createSession`, and
 * it was removed when a session was allowed to ORCHESTRATE many: an agent
 * driving ten worktrees is the use, not the abuse. What bounds creation now is
 * the person — archive and delete are theirs and nobody else's — and the
 * telar skill, which is the only voice this wall has on a question no count can
 * settle. See `Session.origin`, which still says who asked.
 *
 * ── BUT EVERY ANSWER IS CAPPED, AND THAT IS NEW (#515) ──────────────────────
 * The paragraph above used to have a companion that said this wall needed no
 * bound on what it RETURNED either, because "the live set is small in practice
 * — bounded by nothing but the person's own tidiness". It was measured and it
 * was wrong by two orders of magnitude: 334 sessions, of which 323 were shelved
 * out of the list the person was actually looking at, folded into one 142,703-
 * character `sessions_list` that spent a 256k model's entire context. A
 * `sessions_status` on a working session was 80,755 characters of turn list to
 * answer "is it finished yet". A `sessions_read` handed back the FIRST fifty
 * events of a journal holding 61,933.
 *
 * The rule those three share: an answer's size was a property of the engine's
 * history rather than of the question asked. So every tool here now bounds what
 * it returns by its own shape — a page, a count of turns, a fold — states the
 * bound in the answer, and names the argument that lifts it. `tool-kit.ts`'s
 * `bounded` sits under all of them as the backstop. No behaviour was removed:
 * every argument that worked before still works, and every old answer is still
 * reachable by asking for it.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { EngineEvent, EngineRequest, EnvMode, LiveSessionRow, NotificationDetail, ProviderDriverKind, ReportCadence, Session, SessionDiff, Subscription, Turn, WakeKind } from "@telar/engine-client";
import { HOLD_REPORTS, MAX_REPORT_WINDOW_MINUTES, MIN_REPORT_WINDOW_MINUTES, STALLED_AFTER_MS } from "@telar/engine-client";

/**
 * What the toolkit may do.
 *
 * EVERY MEMBER IS A THIN MIRROR OF ONE `EngineStore` METHOD, and that is the
 * whole design: validation lives in the store, so the tool wall composes
 * sentences and never decides anything. The port exists for the same reason
 * every other capability here does — there are two worker deployments, the daemon's
 * embedded one and `worker-main.ts`, and only one of them can reach the
 * filesystem store, so the worker builds this out of `EngineClient` calls while
 * the daemon's socket builds it out of `store.*` calls. Both land on the same
 * implementation of every rule.
 */
export type SessionsCapability = {
  /** Every LIVE session on this engine, across projects, plus the projects
   *  themselves — a project id is what `create` takes, so a caller needs both
   *  halves of this answer at once.
   *
   *  ROWS, NOT WHOLE RECORDS (#459): the route behind the out-of-process
   *  deployment sends `LiveSessionRow`, and `summarise` below reads nothing
   *  else. A full `Session` is assignable to one, so the daemon's own
   *  `store.liveSessions()` still satisfies this.
   *
   *  `settled` IS THE SHELF, AND IT IS OPTIONAL AT THIS SEAM (#515). Absent
   *  means the unsettled rows — the list a person actually has open, and 11 of
   *  334 on the owner's store. Both deployments answer it with the rule the
   *  clients already share (`isShelved`, via the store's own `liveSessionRows`
   *  and the route's `?all=1`), so neither writes a second fold. An
   *  implementation that ignores the argument is still type-correct and simply
   *  answers wide; the wall states in the answer what it actually got. */
  list(options?: { settled?: boolean }): Promise<{
    sessions: LiveSessionRow[];
    projects: Array<{ id: string; name: string }>;
    /** How many rows the unsettled answer left out, when the source counted
     *  them. Absent is "this source did not say", never "the shelf is empty". */
    settledCount?: number;
  }>;
  /**
   * A NEW SESSION, WITH NO LINK TO THE CALLER.
   *
   * `origin: "session"` is stamped by the implementation of this member, never
   * by a model argument — no shape below carries it, exactly as the notebook's
   * `source: "session"` is. Provenance a list can show; nothing counts it.
   *
   * AND NEITHER IS THE PRIVILEGE CEILING (#541 G1). Each implementation names
   * its own session as `ceilingFrom` on the store call, so the new session's
   * runtime mode is capped at the CALLER's: if you have to ask about something,
   * so does anything you create. It is deliberately not a link — nothing here
   * gives the caller any authority over the session afterwards, and the two
   * remain peers exactly as the sentence above says.
   */
  create(input: { projectId: string; title?: string; envMode: EnvMode; driver?: ProviderDriverKind }): Promise<Session>;
  /** Queue ONE turn. The `runId` is minted by the wall so a retry of the same
   *  tool call cannot double-submit. */
  send(sessionId: string, input: { runId: string; input: string; intent?: Turn["agentIntent"] }): Promise<{
    turn: Turn;
    replayed: boolean;
  }>;
  /** The journal after a cursor, at most `limit` rows of it. The STORE returns
   *  the whole tail when no limit is given; the bound is this wall's, because
   *  the wall is what lands in a model's context.
   *
   *  `limit` IS OPTIONAL AT THIS SEAM so an older implementation stays
   *  type-correct — it simply answers wide and the wall pages what it gets. */
  read(sessionId: string, after: number, options?: { limit?: number }): Promise<EngineEvent[]>;
  /**
   * THE ID OF THE LAST EVENT ON THE JOURNAL — what a tail read starts from.
   *
   * OPTIONAL, and its absence is a real case rather than a gap: a capability
   * that cannot answer it makes `sessions_read` fall back to paging from the
   * beginning, which is what the tool did before #515. With it, "what happened
   * lately" costs one page instead of walking 61,933 events to reach the end.
   */
  cursor?(sessionId: string): Promise<number>;
  /**
   * THE SESSION AND ITS TURNS — AT LEAST THE NEWEST `recent` AND EVERY LIVE ONE.
   *
   * `recent` is a floor, not a filter: an implementation may hand back every
   * turn (the in-process store does; it pays no serialisation), and one reached
   * over HTTP reads a windowed snapshot instead of the whole history, which on a
   * 1,200-turn session is 0.3 MB rather than 39 MB. `turnCount` is the session's
   * whole count when `turns` may be a window; absent, `turns.length` is it.
   * Omit `recent` to ask for every turn.
   */
  status(
    sessionId: string,
    options?: { recent?: number },
  ): Promise<{ session: Session; turns: Turn[]; turnCount?: number; pendingNotifications?: NotificationDetail[] }>;
  /**
   * ONE TURN BY ITS RUN ID. Optional: without it the wall looks the turn up in
   * `status`. A remote capability answers the recent case from a window and
   * only falls back to the whole history for a turn older than that.
   */
  turn?(sessionId: string, runId: string): Promise<Turn | undefined>;
  /**
   * PAUSE, NOT A ONE-TURN STOP — `EngineStore.pauseSession`, stamped
   * `by: "session"`. A stop of one turn lets the worker take the next queued
   * message within a heartbeat, which is exactly what an agent asking a peer
   * to stop did not mean. Measured: a stop was followed within a second by a
   * new run on the same session. There is NO resume on this wall: a pause an
   * agent could lift is a pause a person cannot rely on.
   */
  /** Stop the session's work: `stopped` is every turn settled (the live one
   *  plus whatever was waiting), `live` the one that was actually running. No
   *  hold count and no `already` — there is no latch to be already in. */
  stop(sessionId: string): Promise<{ stopped: Turn[]; live?: Turn }>;
  /**
   * SHELVE OR UNSHELVE A SESSION IN THE LIST — `Session.settledOverride`, the
   * same switch the sidebar's Settle button flips. NOT an archive: the session
   * stays live and resumable, nothing is deleted, and a new message (or a
   * wake) lifts it again. It is the one housekeeping verb an orchestrator
   * needs when a peer it started has finished and is now only clutter.
   */
  settle(sessionId: string, settled: boolean): Promise<Session>;
  /**
   * HOW OFTEN THIS SESSION IS TOLD ABOUT ROUTINE PEER REPORTS — issue #723.
   *
   * THE CALLER'S OWN SESSION, ALWAYS. It takes an id because the store does,
   * and `sessions_report_window` passes `self` and nothing else: a session
   * setting ANOTHER session's cadence would be one peer deciding how another is
   * allowed to be interrupted, which is a relationship conferring behaviour —
   * exactly what #199 spent a milestone refusing.
   */
  setReportWindow(sessionId: string, minutes: ReportCadence | null): Promise<Session>;
  /** #543. Absent on an engine with no sqlite execution store, which the tool
   *  reports rather than throwing. */
  putSchedule?(input: { sessionId: string; prompt: string; rule: unknown; zone: string }): Promise<{ id: string; nextRunAt: number; zone: string }>;
  diff(sessionId: string): Promise<SessionDiff>;
  /**
   * WHO IS ASKING — present inside a turn, ABSENT on the outward socket. A
   * subscription needs a session to wake; a chat client on the socket is not
   * one, and the three subscription tools refuse there in words rather than
   * subscribing nobody.
   */
  self?: { sessionId: string };
  subscribe(
    subscriberSessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Promise<Subscription>;
  unsubscribe(subscriptionId: string, subscriberSessionId: string): Promise<boolean>;
  subscriptions(subscriberSessionId: string): Promise<Subscription[]>;
  /** Every OPEN request a session has, plus possibly some resolved ones; the
   *  wall keeps the open ones. */
  requests(sessionId: string): Promise<EngineRequest[]>;
  /** The implementation stamps `resolvedBy: "session"`; no shape carries it. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "acceptForSession" | "decline"; reason?: string; answers?: Record<string, string> },
  ): Promise<EngineRequest>;
  /**
   * THE SIX READS THAT ASK A CONVERSATION SOMETHING — issue #516, and the one
   * member here that is not a single store verb.
   *
   * A SUB-PORT RATHER THAN SIX MORE MEMBERS, because they are answered by a
   * different half of the engine: the verbs above land on `EngineStore` methods
   * about a session's LIFE, and these land on the `turn_summary` projection and
   * on indexed document spans. Grouping them keeps the two halves separately
   * implementable, each from its own side of the engine.
   *
   * REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT OF THE PORT. `cursor` above is
   * optional because an implementation that cannot answer it has a documented
   * fallback; there is no fallback for these — a deployment that left them out
   * would answer a session's question differently depending on which worker ran
   * its turn, which is the exact drift this seam exists to prevent. Both builds
   * can answer: the daemon's from `store.*`, the worker's from `EngineClient`.
   */
  query: SessionsQueryCapability;
};

import { err, failure, fillWithin, json, ok, type ToolFactory } from "../tool-kit";
import { deferredQuery, sessionQueryTools, type SessionsQueryCapability } from "./query";
export type { ToolFactory };
export type { SessionsQueryCapability, StepRead, StepRow } from "./query";

/**
 * THE SENTENCE THE WALL CANNOT ENFORCE, so it says it instead — in the prose of
 * every tool that could be bent into it.
 *
 * A session cannot be stopped in code from asking another session to do the
 * thing it was itself refused: the second session is a peer with its own
 * permission boundary, and by construction there is no link between them for a
 * check to read. The engine's own guards still apply on the other side — a new
 * session parks anything that escapes its boundary exactly as this one does —
 * but "I was told no, so I will ask someone else" is a decision a model makes
 * in words, and words are what this text answers.
 */
const NOT_A_BYPASS = "Never hand a peer work you were refused — the same action, renamed.";

/**
 * ── THESE ARE SHORT ON PURPOSE, AND THE RULE IS "EVERY RULE, FEWER WORDS" ───
 *
 * Measured (#563): the Agent's 21 tool definitions were 18,722 characters and
 * every lap of every turn resent all of them. That is a fixed tax on a
 * conversation, paid before the model has read a word of it.
 *
 * So each of these was rewritten to the SENTENCES THAT CHANGE A DECISION —
 * what the tool answers, what it costs, and the one thing a model gets wrong
 * about it — and nothing else. Nothing was dropped: a rule that used to be in a
 * description and is now in the argument that carries it (an `intent`, an
 * `envMode`) is still stated exactly once, where the caller is choosing it.
 */
const LIST = `Live sessions, and the projects one can be created in. Unsettled only by default. Read it before creating anything — the session you want may exist.`;

const CREATE = `Start a NEW session on a project. It is a PEER: it does not report back, and creating it starts no work — sessions_send with intent task does. ${NOT_A_BYPASS}`;

const SEND = `Message another session. It is handed a NOTICE naming sessions_read, not your text — lead with the point. ${NOT_A_BYPASS}`;

const NO_SELF =
  "This door has no session to wake: subscriptions need a calling session, and this client is not one. Poll with sessions_status instead.";

/**
 * WHEN THE WAITING MAIL WILL MOVE, in one clause — the three cadences (#723,
 * #784), spelled once because `sessions_status` and `sessions_report_window`
 * both say it and a reader must not get two accounts of one setting.
 *
 * THE HOLD CLAUSE SAYS WHERE THE MAIL IS AND HOW TO SEE IT. "Never delivered"
 * on its own is the sentence that makes a held report read as a lost one.
 */
function cadencePhrase(cadence: Session["reportWindowMinutes"]): string {
  if (cadence === undefined) return "";
  if (cadence === HOLD_REPORTS) {
    return ", and they are being HELD — this session asked to keep routine reports as mail rather than take them as turns, so they stay here until somebody reads them and no turn is ever started for them";
  }
  return `, at most every ${cadence} minute${cadence === 1 ? "" : "s"}`;
}

/**
 * A CALLER THAT IS NOT A SESSION CANNOT SCHEDULE — issue #543, and it is the
 * guard rather than a politeness.
 *
 * A row names the session its prompt is submitted to, so a caller with no
 * `self` has nothing to put there. Writing one anyway would create WORK THAT
 * OUTLIVES ITS CALLER and belongs to nobody — a clock firing into an id that
 * is not a session, which the first sweep would disable hours later, long
 * after anyone could connect the dead row to the call that made it.
 *
 * The same shape as `NO_SELF` above and for the same reason: the door that
 * hits this is the outward sessions socket, a client a person is typing at,
 * and they can ask their own session for it.
 */
const NO_SESSION_TO_SCHEDULE =
  "This door has no session to schedule: a scheduled run is submitted INTO a conversation, and this client is not one. Ask a session to schedule itself.";

const SUBSCRIBE = `Be woken when a session completes, fails, is stopped or parks a request — a notification in YOUR session, so you can end this turn rather than poll. It is a PING; sessions_read fetches the outcome. A completion whose result you already received is recorded, not delivered again.`;

const UNSUBSCRIBE = `Stop being woken by a session, by the id sessions_subscribe returned. Queued wakes are withdrawn. One that is not yours answers removed: false — not an error.`;

const SUBSCRIPTIONS = `Every subscription this session holds. Read it before subscribing again, and for an id to unsubscribe.`;

const REQUESTS = `What a session is WAITING on — its open requests, with the id sessions_resolve_request takes. A request is a question to a HUMAN by default; answering it is you taking responsibility.`;

const RESOLVE_REQUEST = `Answer a session's open request on the user's behalf. Recorded as answered BY A SESSION. Only answer what you actually know; a secret pick is refused. ${NOT_A_BYPASS}`;

/**
 * IT DEFAULTED TO THE EXPENSIVE HALF OF ITS OWN JOB (#608).
 *
 * ── WHAT WAS MEASURED ───────────────────────────────────────────────────────
 * 8,568 characters on one turn, 9,107 and 12,953 on two others — and one of
 * those reported `quietEvents: 69`, sixty-nine rows the tool itself had judged
 * not worth showing inside a payload charged at full price. The question behind
 * every one of them was "what has this session been doing", and `mode:
 * "summary"` answers exactly that in 2,000–4,000.
 *
 * ── SO THE FOLD IS THE DEFAULT AND THE JOURNAL IS THE ASK ───────────────────
 * The bare call is the one a model makes when a peer has been working and it
 * wants to know what came of it; raw events are for debugging a run's tool
 * trace, which is a real need and now a named one. `runId` is untouched and
 * still wins outright — a wake names a run, and that read was never the waste.
 *
 * ── IT IS A BREAK, AND DELIBERATELY NOT A NARROW ONE ────────────────────────
 * This wall is bound by every session driver and every MCP client, not only by
 * the Agent, so the default flips for all of them. Scoping the change to a bare
 * call — leaving `after` on the events shape as a "continuation" — was tried on
 * paper and rejected: the measured call WAS `{after: 4100, limit: 14}`, from a
 * turn that had made no previous read to get a cursor from. A default that
 * depends on which arguments happen to be present is also one no description can
 * state in a sentence. `after` still narrows which events the summary's "did"
 * lines are drawn from, so it is honoured rather than ignored.
 */
/**
 * AND IT POINTS AT THE SIX FIRST, which is #516's own sentence: "`sessions_read`
 * stays for the raw journal; its description should point at these first."
 *
 * IT IS PAID FOR PER LAP, so it is one clause and not a menu. The three named
 * are the ones a caller reaching for `sessions_read` actually wanted — which
 * turn, what it concluded, what one step did — and the routing rule a model
 * needs at the moment it is choosing is "there is a narrower verb", not the
 * whole list. `sessions_find` and `sessions_grep` answer a question this tool
 * was never a candidate for, so naming them here would be bytes spent on a
 * choice nobody is making.
 */
const READ = `What a session has done: by default a turn-by-turn summary. runId answers ONE turn; mode: events for the raw journal, which is long. Narrower and cheaper first: sessions_outline for its turns, sessions_answer for one conclusion, sessions_steps for what a turn did.`;

const STATUS = `Working, waiting on a person, or idle, and how recent turns ended. The cheap "is it finished yet", before sessions_read. Changes nothing.`;

const STOP = `Stop a session's work now: the running turn ends where it stands and the queue is settled. Nothing is undone — what it wrote stays written and a command it ran may have finished. Then idle, not paused.`;

const SETTLE = `Shelve a session out of the active list, or settled: false to bring it back. Nothing is deleted and a new message lifts it back. Housekeeping, not acceptance.`;

const REPORT_WINDOW = `Be told about routine reports on a clock instead of one at a time: minutes holds them and delivers the batch as one notification, null goes back to arrival. Sets YOUR OWN cadence, nobody else's. A task, a blocker and a result you subscribed to still arrive at once.`;

/**
 * THE `filesIncomplete` CLAUSE COSTS 45 OF THE 47 CHARACTERS the wide tool wall
 * had left (#654; see agent-tools.test.ts's ceiling). It is worth the whole of
 * that headroom: this is the one tool of the three diff surfaces read by an
 * AGENT, and an empty answer taken for "changed nothing" gets reported to a
 * person as fact. Everything else the reader needs — which read failed, whether
 * a retry helps, and the refusal of that sentence in the words it would have
 * used — is on the answer's own `note`, where it costs nothing per lap.
 */
const DIFF = `What a session changed in its checkout since it started. A "local" session shares the project's checkout, so the diff may carry work that is not its own. An empty answer may be unread, not unchanged. READ-ONLY, NOT AN ACCEPTANCE: nothing here merges or approves.`;

/**
 * ── THE BOUND ON `sessions_read`, AND WHY IT IS TWO NUMBERS ─────────────────
 *
 * A session's journal is unbounded — a long-running session accumulates
 * thousands of events, some of them carrying whole files — and this output
 * lands in a model's context window. One number cannot bound it: a count alone
 * lets fifty events carrying a megabyte of patch through, and a byte budget
 * alone will happily return four thousand tiny events. So both, whichever is
 * reached first, plus a per-string clamp so ONE enormous event cannot fill the
 * page on its own and hide the twenty after it.
 *
 * THE CAPS ARE STATED IN THE ANSWER, not just applied to it. A page that
 * silently looked complete is how a model reports a session's first ten
 * minutes as its whole life.
 */
const MAX_EVENTS = 50;
/** Lowered from 24 KB (#515): a page is a look at a journal, not a download of
 *  one, and 24 KB of it was a sixth of a small model's window for one call. */
const MAX_EVENT_CHARS = 12_000;
const MAX_STRING_CHARS = 2_000;
/** A run-scoped read hands over the turn's answer whole, up to this. Larger
 *  than the per-string clamp on purpose: this IS what the caller asked for. */
const MAX_RESULT_CHARS = 8_000;
/**
 * A RUN-SCOPED READ'S EVENT PAGE, which is smaller than a journal page and not
 * by accident (#515). A caller naming a `runId` came for the TURN — what it was
 * asked and what it concluded — and the events are context around that. The
 * budget goes where the caller pointed.
 */
const MAX_RUN_EVENT_CHARS = 6_000;
/**
 * THE ONE ANSWER ALLOWED PAST THE TOOLKIT'S DEFAULT BACKSTOP, and the reason is
 * a contract rather than a preference.
 *
 * A run read may carry an 8,000-character answer slice AND an 8,000-character
 * message slice, and both are VERBATIM: concatenated across calls they are the
 * text exactly as it was written, with nothing trimmed or marked inside them.
 * `bounded`'s marker would be a silent edit in the middle of that guarantee —
 * it clips the JSON, not the slice, so a caller reassembling from offsets would
 * splice a truncation into the text and never know. So this answer gets a
 * budget above the sum of what it may legitimately be asked for, and every part
 * of it stays self-describing: two slices with their own offsets and totals,
 * and an event page bounded at `MAX_RUN_EVENT_CHARS`.
 */
const MAX_RUN_ANSWER_CHARS = 24_000;
/** A summary line's share of a turn's answer. Enough to know what it concluded;
 *  never enough to be mistaken for the answer, which `runId` hands over. */
const MAX_SUMMARY_RESULT_CHARS = 300;
/** How many turns `mode: "summary"` describes, and its ceiling. The same
 *  numbers `sessions_status` uses, for the same reason. */
const SUMMARY_TURNS_DEFAULT = 5;
const SUMMARY_TURNS_MAX = 20;
/**
 * HOW FAR BACK A TAIL READ REACHES to find the last page.
 *
 * The journal is keyed on event id, so "the end" is `cursor - window` read
 * forward — there is no backwards read at either seam and adding one would mean
 * a new route, a new store method and a new client call for a window this size.
 * 200 is the events route's own page (#494), so this costs exactly one page
 * wherever it runs, and the events it finds are trimmed to `MAX_EVENTS` from the
 * END. Ids are dense in practice; where they are not, the read simply reaches a
 * little less far back, which the answer states rather than hides.
 */
const TAIL_WINDOW = 200;
/** One widening, for a journal whose ids are sparse enough that the first
 *  window came back nearly empty. One and not a loop: a second miss means the
 *  ids are sparse beyond anything a page size can chase, and the honest answer
 *  is the short page plus the cursor to walk with. */
const TAIL_WINDOW_WIDE = 1_000;

/**
 * WHAT ONE PIECE OF AN ANSWER WILL ACTUALLY COST, measured the way it will
 * actually be written.
 *
 * `json` pretty-prints at two spaces, so sizing a page against compact JSON
 * understated every budget here by around a third — a 24 KB page emitted 31 KB,
 * and a "12 KB" one emitted 15. A budget that does not mean what it says is
 * worse than a larger honest one, because it is the number the description and
 * the tests quote. Still approximate by the wrapper's own indent, which adds a
 * little per line; approximate and conservative beats wrong by 30%.
 */
function measure(value: unknown): number {
  return JSON.stringify(value, null, 2)?.length ?? 0;
}

/** One event, with any oversized string inside it clamped and MARKED. Recursive
 *  because the payloads nest (an item's detail, a turn's observations) and a
 *  top-level-only clamp would miss every one that matters. */
function clamp(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more characters, not shown]`;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, clamp(inner)]));
  }
  return value;
}

/**
 * A page of events, and the honest cursor for the next one.
 *
 * THE CURSOR IS THE LAST EVENT ACTUALLY RETURNED, never the last one read. A
 * cursor that ran ahead of the page would skip everything the budget trimmed,
 * which is the exact failure a bounded read exists to avoid: silent loss that
 * looks like completeness.
 */
export function pageEvents(
  events: readonly EngineEvent[],
  options: { limit?: number; chars?: number } = {},
): { page: unknown[]; cursor: number; more: boolean } {
  const limit = options.limit ?? MAX_EVENTS;
  const budget = options.chars ?? MAX_EVENT_CHARS;
  const page: unknown[] = [];
  let cursor = 0;
  let chars = 0;
  for (const event of events) {
    if (page.length >= limit) return { page, cursor, more: true };
    const trimmed = clamp(event);
    const size = measure(trimmed);
    // The FIRST event is always let through whatever it costs: a page of zero
    // with `more: true` is a caller that can never advance.
    if (page.length > 0 && chars + size > budget) return { page, cursor, more: true };
    page.push(trimmed);
    chars += size;
    cursor = event.id;
  }
  return { page, cursor, more: false };
}

/**
 * THE SAME PAGE, FILLED FROM THE END — issue #515.
 *
 * "What has this session been doing" is a question about the end of a journal,
 * and the tool answered it from the beginning: a caller looking at a session
 * with 61,933 events got its first fifty, every time, with 1,238 pages between
 * them and anything current. Filling backwards is the whole fix, and it is a
 * separate function rather than a flag because the CURSOR means the opposite
 * thing here — it is where the page ENDS, which is where a caller resumes.
 *
 * `earlier` IS WHAT CAME BEFORE THE PAGE, when the window held more than fit.
 * A caller that wants the turn before this one asks with `after` below it.
 */
function pageEventsFromEnd(
  events: readonly EngineEvent[],
  options: { limit?: number; chars?: number } = {},
): { page: unknown[]; cursor: number; from: number; earlier: boolean } {
  const limit = options.limit ?? MAX_EVENTS;
  const budget = options.chars ?? MAX_EVENT_CHARS;
  const page: unknown[] = [];
  let chars = 0;
  let earlier = false;
  let from = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (page.length >= limit) {
      earlier = true;
      break;
    }
    const trimmed = clamp(event);
    const size = measure(trimmed);
    if (page.length > 0 && chars + size > budget) {
      earlier = true;
      break;
    }
    page.unshift(trimmed);
    chars += size;
    from = event.id;
  }
  return { page, cursor: events.at(-1)?.id ?? 0, from, earlier };
}

/**
 * THE EVENTS NOBODY READS, DROPPED BEFORE THEY ARE PAGED — issue #515.
 *
 * A journal carries two classes of row that exist for the engine rather than
 * for a reader, and together they are most of it:
 *
 *   · `usage.updated` — a token count restated after every item. It is what
 *     draws a meter, and no caller of this tool has a meter.
 *   · A request the POLICY opened and resolved in the same instant — a tool
 *     call that was allowed by a standing rule. Both halves say only "the
 *     engine permitted something it was always going to permit". A request a
 *     PERSON or a SESSION resolved is kept, always: that is a decision somebody
 *     made, and it is exactly what a caller auditing a peer came to read.
 *
 * `verbose: true` keeps everything. The filter is about what a page spends its
 * budget on, never about what the journal holds — nothing here is deleted, and
 * the answer says how many rows it passed over.
 */
/**
 * THE END OF A JOURNAL, FOUND WITHOUT WALKING IT.
 *
 * `cursor` is the last event id, so the last page is `cursor - window` read
 * FORWARD — one page's cost wherever this runs, against 61,933 events and
 * 38.5 MB to reach the same rows by paging from zero.
 *
 * A CAPABILITY WITHOUT `cursor` STILL WORKS, and pays what it always paid: the
 * whole tail, filled from the end rather than the start. Keeping that path is
 * what lets the seam stay optional for an implementation that has no cheap way
 * to answer it.
 */
async function tailEvents(
  capability: SessionsCapability,
  sessionId: string,
  limit: number,
): Promise<{ events: EngineEvent[]; from: number; reached: boolean }> {
  const cursor = capability.cursor ? await capability.cursor(sessionId) : 0;
  /**
   * A CURSOR OF ZERO IS "NO CURSOR", and both readings of it want the same
   * thing. An empty journal costs nothing to read whole; an engine too old to
   * stamp one leaves the wall exactly where it was before this existed. What
   * neither may do is take `0 - window` as the end of the journal — that would
   * page the FIRST rows and call them the latest, which is the one answer worse
   * than the slow one.
   */
  if (cursor <= 0) return { events: await capability.read(sessionId, 0), from: 0, reached: true };
  let events: EngineEvent[] = [];
  let from = 0;
  // ONE WIDENING AND NO MORE — see `TAIL_WINDOW_WIDE`. `from === 0` means the
  // window already reaches the journal's start, so a wider one finds nothing.
  for (const window of [TAIL_WINDOW, TAIL_WINDOW_WIDE]) {
    from = Math.max(0, cursor - window);
    events = await capability.read(sessionId, from, { limit: window });
    if (from === 0 || events.length >= limit) break;
  }
  return { events, from, reached: from === 0 };
}

/** How many item titles one summarised turn may list. A turn that ran two
 *  hundred tools is described by its first dozen and a count; the rest is what
 *  `mode: "events"` is for. */
const MAX_SUMMARY_TITLES = 12;

/**
 * A SESSION'S RECENT TURNS AS SENTENCES RATHER THAN EVENTS — issue #515.
 *
 * "What has this peer been doing" is answerable in a few hundred bytes a turn:
 * what it was asked, what it did, what it concluded. A page of raw events
 * answers the same question in twelve kilobytes and leaves the reader to fold
 * it. This is the fold, done once, here.
 *
 * TITLES COME FROM THE EVENTS IN HAND, never from a second read. A turn older
 * than the page's window is still summarised — its input and its answer live on
 * the TURN — and simply lists no items; the answer says so rather than implying
 * the turn did nothing.
 */
function summariseTurns(turns: readonly Turn[], events: readonly EngineEvent[], wanted: number) {
  const titles = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = (event as { item?: { runId?: string; title?: string } }).item;
    if (!item?.runId || !item.title) continue;
    const held = titles.get(item.runId) ?? [];
    if (!held.includes(item.title)) held.push(item.title);
    titles.set(item.runId, held);
  }
  return turns.slice(-wanted).map((turn) => {
    const did = titles.get(turn.runId) ?? [];
    const answer = turn.resultText ?? "";
    return {
      runId: turn.runId,
      sequence: turn.sequence,
      state: turn.state,
      ...(turn.origin === "session" ? { from: "session" as const, ...(turn.agentIntent ? { intent: turn.agentIntent } : {}) } : {}),
      // THE FIRST LINE OF WHAT IT WAS ASKED. A turn's input is the one thing
      // that says what it was FOR, and its first line is how a sender was told
      // to write it — see `agentNotice`.
      asked: firstLine(turn.input),
      ...(did.length > 0 ? { did: did.slice(0, MAX_SUMMARY_TITLES) } : {}),
      ...(did.length > MAX_SUMMARY_TITLES ? { didMore: did.length - MAX_SUMMARY_TITLES } : {}),
      ...(answer
        ? {
            answered: answer.slice(0, MAX_SUMMARY_RESULT_CHARS),
            resultChars: answer.length,
          }
        : {}),
      ...(turn.failure ? { failure: turn.failure } : {}),
    };
  });
}

/** The first line with anything on it, clamped. A summary line that ran to a
 *  paragraph would be the thing summarising exists to avoid. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.length <= MAX_SUMMARY_RESULT_CHARS ? trimmed : `${trimmed.slice(0, MAX_SUMMARY_RESULT_CHARS)}…`;
  }
  return "";
}

/**
 * A `turn.accepted` WITHOUT THE COPY OF THE BODY THE ANSWER ALREADY CARRIES.
 *
 * Marked rather than deleted: an event with a field silently missing is an
 * event a reader cannot trust, and the line names the field that holds the
 * text. Everything else on the event — who sent it, which intent, when it was
 * accepted — is untouched, because that is what the event is FOR.
 */
function withoutDuplicateBody(event: EngineEvent): EngineEvent {
  if (event.type !== "turn.accepted") return event;
  const turn = (event as { turn?: Record<string, unknown> }).turn;
  if (!turn || typeof turn.input !== "string") return event;
  return {
    ...event,
    turn: {
      ...turn,
      input: `[the message body is the \`message\` field of this answer, ${String(turn.input).length} characters here]`,
      ...(typeof turn.agentNotice === "string" ? { agentNotice: "[the notice this session was handed; its body is the `message` field]" } : {}),
    },
  } as EngineEvent;
}

function readable(event: EngineEvent): boolean {
  if (event.type === "usage.updated") return false;
  if (event.type === "request.opened") {
    const request = (event as { request?: { state?: string; resolvedBy?: string } }).request;
    return !(request?.state === "resolved" && request.resolvedBy === "policy");
  }
  if (event.type === "request.resolved") return (event as { resolvedBy?: string }).resolvedBy !== "policy";
  return true;
}

/** A session as a caller should read it — the fields a person scans a sidebar
 *  for, and nothing about who created it, because nothing records that.
 *
 *  `state` AND `driver` ARE NOT HERE, and their absence is the point (#515).
 *  Every row on a LIVE list has `state: "active"` — `foldLiveSessions` drops
 *  the others before this sees them — so the key was 334 copies of a constant.
 *  `driver` is the same shape of nothing on an engine running one provider, so
 *  the LIST states it ONCE for the whole answer and puts it back on the row
 *  only when the rows actually disagree. `summariseOne` below is the single-row
 *  caller, where "the rows disagree" has no meaning and the field is simply
 *  reported. */
function summarise(session: LiveSessionRow, projects: Map<string, string>, options: { driver?: boolean } = {}) {
  return {
    id: session.id,
    // ABSENT IS THE PROJECT-LESS MASTER, said out loud rather than left blank:
    // a caller reading no `project` key cannot tell it from a dropped field.
    project: session.projectId ? (projects.get(session.projectId) ?? session.projectId) : "no project",
    ...(session.projectId ? { projectId: session.projectId } : {}),
    title: session.title,
    envMode: session.envMode,
    activity: session.activity,
    ...(options.driver ? { driver: session.driver } : {}),
    // The branch, when it has one of its own. It is what a human will look for
    // when they come to review the work, so a report that omits it is harder
    // to act on than one that names it.
    ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
    /**
     * WHETHER THIS SESSION HAS A CHECKOUT AT ALL — issue #813.
     *
     * Absent is ready, exactly as it is on the record. Present means the
     * session cannot be claimed: `preparing` while the cut runs, `failed` when
     * it did not work, carrying git's own sentence.
     *
     * THE COCKPIT RAIL HAS DRAWN THIS SINCE #496 and the agent surface did not,
     * which is the whole of #813's invisibility: a human glancing at the list
     * saw "Worktree setup failed" on the same row an agent was told was fine.
     * One extra key on a row, on the small fraction of rows that have it.
     */
    ...(session.preparation ? { preparation: session.preparation } : {}),
    updatedAt: session.updatedAt,
  };
}

/** One session, described on its own — `sessions_create` and `sessions_status`,
 *  where there is no set for a field to be constant across and every fact is
 *  worth its bytes. */
function summariseOne(session: LiveSessionRow, projects: Map<string, string>) {
  return { ...summarise(session, projects, { driver: true }), state: session.state };
}

/**
 * HOW MANY ROWS ONE `sessions_list` MAY ANSWER WITH.
 *
 * 50 is a list a model can actually read and act on; the measured answer at
 * that size is under 4 KB against 142 KB for the 334 rows the wall used to fold
 * unasked. The MAX is what stops a caller from asking for the old cost back in
 * one call — a caller that genuinely wants them all pages, and the answer hands
 * it the cursor to do it with.
 */
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
/**
 * AND A BYTE BUDGET BESIDE THE ROW COUNT, for the reason `pageEvents` gives:
 * one number cannot bound this. A row is mostly its title, and a title is
 * whatever a person or an agent typed — fifty of them are usually 4 KB and
 * could be forty. Whichever bound is reached first ends the page, and `more`
 * carries the cursor either way.
 */
const LIST_CHARS = 10_000;

/**
 * THE THREE LISTS THAT ARE NOT `sessions_list` AND ARE JUST AS UNBOUNDED.
 *
 * The issue named the three big tools; the budget test found these behind them,
 * and found them the same way — by having 200 of something. A session waiting
 * on 200 questions, an orchestrator holding 200 subscriptions, and a branch
 * that touched 500 files all produced answers past the `bounded` backstop,
 * which clips CHARACTERS: the caller got JSON with its tail cut off rather than
 * a short list. Each is a normal thing to have.
 *
 * So each fills to a budget and states its total. The numbers are small because
 * these answers are read to DECIDE something — which request to answer, which
 * file to look at — and a decision is made from the first screen of a list or
 * not at all.
 */
const REQUESTS_LIMIT = 20;
const REQUESTS_CHARS = 8_000;
const SUBSCRIPTIONS_LIMIT = 40;
const SUBSCRIPTIONS_CHARS = 6_000;
const DIFF_FILES_LIMIT = 100;
const DIFF_FILES_CHARS = 8_000;
const DIFF_COMMITS_LIMIT = 30;
const DIFF_COMMITS_CHARS = 4_000;

/** The turn states a caller means by "is anything running". Named once so the
 *  status tool and its own `running` flag cannot disagree. */
const LIVE_TURN_STATES = new Set(["queued", "claimed", "running"]);

/**
 * HOW MANY TURNS `sessions_status` MAY DESCRIBE (#515).
 *
 * The capability hands over the whole queue — `store.turns(sessionId)`, every
 * turn the session has ever taken — and the wall used to render all of them:
 * 685 turns, 80,755 characters, to answer "is it finished yet". Five is what
 * that question actually needs, and the ones that are RUNNING are never among
 * the ones dropped (see below), so the answer cannot go quiet about live work
 * just because a session has been busy for a week.
 */
const STATUS_TURNS_DEFAULT = 5;
const STATUS_TURNS_MAX = 20;

/** One turn as a status line: what it was, how it ended, and nothing it said.
 *  The text of a turn is `sessions_read`'s job and is where the bytes are. */
function turnLine(turn: Turn) {
  return {
    runId: turn.runId,
    sequence: turn.sequence,
    state: turn.state,
    ...(turn.completedAt === undefined ? {} : { endedAt: turn.completedAt }),
    ...(turn.failure ? { failure: turn.failure } : {}),
    /**
     * NO EVIDENCE FOR A LONG WHILE — #813. On the turn rather than the session,
     * because that is what it is about, and only when it is true: an ordinary
     * running turn carries neither key.
     *
     * `lastProgressAt` RIDES WITH IT rather than being reported always. The
     * number is only worth its bytes when there is a silence to measure, and a
     * caller handed `stalled` with no "since when" would have to ask again.
     */
    ...(turn.stalled ? { stalled: turn.stalled, lastProgressAt: turn.lastProgressAt ?? turn.stalled.since } : {}),
  };
}

/**
 * Build the toolkit.
 *
 * THE `tool` FACTORY ARRIVES AS AN ARGUMENT rather than being imported, the
 * same seam the browser toolkit takes: the provider SDK is loaded
 * lazily on the first run, and a module that imported it at the top would pull
 * it into every unit test. `zod` is imported directly — it is the engine's own
 * dependency, not the provider's.
 */
export function sessionsTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    /**
     * ── WHY THIS TOOL HAS ARGUMENTS NOW (#515) ──────────────────────────────
     *
     * It used to have none, and the comment here said there was nothing a
     * caller could usefully narrow because "the live set is small in practice —
     * bounded by nothing but the person's own tidiness". Measured: 334 rows,
     * 142,703 characters, one call, a 256k agent's entire context. The premise
     * was the person's tidiness and the person was not tidy, which is not a
     * fault of theirs — 323 of those rows were SETTLED, shelved out of the list
     * they were looking at, and the wall folded every one of them anyway.
     *
     * So the default is now the list a person actually has open, and the three
     * narrowings a caller genuinely wants are arguments. Nothing was removed:
     * `settled: true` is the old answer, paged.
     */
    tool(
      "sessions_list",
      LIST,
      {
        settled: z
          .boolean()
          .optional()
          .describe("Default false — the list a person has open."),
        projectId: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .optional()
          .describe(`Default ${LIST_LIMIT_DEFAULT}.`),
        after: z.number().int().min(0).optional().describe("The cursor a previous answer's `more` hands back."),
      },
      async (args) => {
        const settled = args.settled === true;
        const wantedProject = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : undefined;
        const limit =
          typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1
            ? Math.min(args.limit, LIST_LIMIT_MAX)
            : LIST_LIMIT_DEFAULT;
        const after = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
        const answer = await capability.list({ settled });
        const { sessions, projects } = answer;
        const names = new Map(projects.map((project) => [project.id, project.name]));
        /**
         * THE PROJECT FILTER IS THE WALL'S, not a second store query. The shelf
         * is the store's rule and has to be — it decides which documents are
         * read at all — but "only this project" is a predicate over rows the
         * caller already paid for, and pushing it down would mean a second
         * narrowing path per deployment for no read saved.
         */
        const matching = wantedProject ? sessions.filter((session) => session.projectId === wantedProject) : sessions;
        const window = matching.slice(after, after + limit);
        // ONE DRIVER FOR THE WHOLE ANSWER IS A FACT ABOUT THE ANSWER, not a
        // field on every row: 50 copies of "claude" tell a reader nothing that
        // one line at the top does not. Rows carry it when they disagree.
        const drivers = new Set(window.map((session) => session.driver));
        const perRowDriver = drivers.size > 1;
        const { rows } = fillWithin(window, (session) => summarise(session, names, { driver: perRowDriver }), {
          limit,
          chars: LIST_CHARS,
        });
        const page = window.slice(0, rows.length);
        const more = after + page.length < matching.length;
        return json({
          sessions: rows,
          ...(drivers.size === 1 ? { driver: [...drivers][0] } : {}),
          total: matching.length,
          ...(after > 0 ? { after } : {}),
          more,
          ...(more ? { next: after + page.length } : {}),
          /**
           * THE SHELF IS COUNTED EVEN THOUGH IT IS NOT HERE. A caller told only
           * "11 sessions" on an engine holding 334 would report that as the
           * truth; the count is the one integer that makes the omission legible
           * and names the argument that lifts it.
           */
          ...(!settled && typeof answer.settledCount === "number" && answer.settledCount > 0 ? { settledNotShown: answer.settledCount } : {}),
          projects: projects.map((project) => ({ id: project.id, name: project.name })),
          ...(matching.length === 0
            ? {
                note: wantedProject
                  ? `No ${settled ? "" : "unsettled "}sessions on project "${wantedProject}".`
                  : settled
                    ? "No sessions are live on this engine."
                    : "No unsettled sessions. Settled ones are still live and resumable — ask with settled: true.",
              }
            : more
              ? { note: `Rows ${after}–${after + page.length} of ${matching.length}. Continue with sessions_list(after: ${after + page.length}).` }
              : {}),
          ...(projects.length === 0
            ? { note2: "No projects are registered, so nothing can be created — the user registers a project themselves." }
            : {}),
        });
      },
    ),
    tool(
      "sessions_create",
      CREATE,
      {
        projectId: z.string().min(1).describe("From sessions_list's `projects`."),
        title: z
          .string()
          .optional()
          .describe("A few words. Write one — an untitled session is unidentifiable an hour later."),
        envMode: z
          .enum(["local", "worktree"])
          .describe(
            '"worktree" for anything that edits files: a checkout of its own. "local" shares the project\'s checkout with every other local session and the user\'s editor. No safe default.',
          ),
        driver: z
          .enum(["claude", "codex"])
          .optional()
          .describe("Omit unless the user asked for one."),
      },
      async (args) => {
        const projectId = String(args.projectId ?? "");
        const envMode = args.envMode === "worktree" ? "worktree" : "local";
        let session: Session;
        try {
          session = await capability.create({
            projectId,
            ...(typeof args.title === "string" && args.title.trim() ? { title: args.title } : {}),
            envMode,
            ...(args.driver === "claude" || args.driver === "codex" ? { driver: args.driver } : {}),
          });
        } catch (error) {
          /**
           * THE STORE'S OWN SENTENCE, CARRIED WHOLE. A missing project, a
           * repository that cannot take a worktree, a driver that is not
           * installed — each refusal names its cause, and a wall that replaced
           * it with "could not create session" would delete the only
           * actionable part.
           */
          return err(`Could not create a session on "${projectId}": ${failure(error)}`);
        }
        const names = new Map<string, string>();
        return json({
          ...summariseOne(session, names),
          note:
            session.workspace.mode === "worktree"
              ? `Created with a checkout of its own on branch ${session.workspace.branch}. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`
              : `Created against the project's own checkout, which it shares with anything else working there. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`,
          note2: "This session is a peer, not yours: it does not report back, and nothing records that you created it.",
          /**
           * WHAT IT MAY DO WITHOUT ASKING — issue #541 G1.
           *
           * SAID IN THE ANSWER because the mode is the one fact about a new
           * session nobody could see: the caller picked a project, a title and
           * an env mode, and got a permission posture it was never shown. It is
           * capped at the CALLER's own mode, so a session that has to ask about
           * commands cannot produce one that does not — this line is what makes
           * that legible rather than merely true.
           */
          access: `${session.runtimeMode} — never wider than your own, so if you have to ask about something, so does it.`,
        });
      },
    ),
    tool(
      "sessions_send",
      SEND,
      {
        sessionId: z.string().min(1),
        intent: z.enum(["task", "report", "result", "blocker"]).optional().describe("report (default) passive, for progress mid-task; task assigns work; result is your FINAL answer — send it last, it wakes an awaiting subscriber once and the completion that follows will not wake them again; blocker asks for intervention."),
        input: z.string().min(1).describe("The whole message; it cannot see this conversation."),
      },
      async (args, context) => {
        const sessionId = String(args.sessionId ?? "");
        const text = String(args.input ?? "");
        const intent = args.intent === "task" || args.intent === "result" || args.intent === "blocker" ? args.intent : "report";
        /**
         * THE RUN ID BELONGS TO THE CALL, not to the model and not to this
         * invocation of the handler.
         *
         * `submitTurn` is idempotent on it — a resubmitted id with the same
         * text replays rather than queueing twice — and that guarantee is only
         * worth anything if the id is one a RETRY produces again. It is still
         * never taken as an argument: a model-supplied id lets two different
         * messages share one, which the store refuses loudly, and a model
         * reusing one by accident silently loses its second message.
         *
         * ── WHY A RANDOM ID WAS NOT ENOUGH (#531, the lab's finding 2) ───────
         * A node is the unit of atomicity, not an effect: a cancel that lands
         * between the HTTP call and the checkpoint write replays the node, and
         * a replayed node that minted a FRESH run id queued a second turn on
         * the peer. The engine's own idempotency was sitting right there and
         * was unreachable, because nothing about the second call looked like
         * the first. No framework can fix that — an HTTP call and a local
         * checkpoint write cannot be made atomic — so the fix belongs at this
         * wall, where every framework's retry passes.
         *
         * DERIVED BY HASH RATHER THAN USED RAW. A provider's call id is opaque
         * and its alphabet is nobody's promise; `Id` here accepts letters,
         * digits, `_` and `-`, so a call id with a dot in it would be refused
         * at the store with a message about an id the model never chose. The
         * hash is stable, is the same length every time, and reveals nothing.
         *
         * NO CALL ID MEANS THE OLD BEHAVIOUR, unchanged: the MCP socket has
         * none to give (a JSON-RPC id is the transport's, not the model's), and
         * a random id is exactly right for a caller that cannot replay.
         */
        const runId = context?.toolCallId
          ? `run_${crypto.createHash("sha256").update(`sessions_send:${context.toolCallId}`).digest("hex").slice(0, 32)}`
          : `run_${crypto.randomUUID().replaceAll("-", "")}`;
        try {
          const { turn } = await capability.send(sessionId, { runId, input: text, intent });
          return json({
            sessionId,
            runId: turn.runId,
            state: turn.state,
            delivery: turn.agentDelivery,
            // WHAT THE OTHER SIDE ACTUALLY SEES, quoted back. A sender that
            // believes its 6 KB report was read verbatim writes the next one
            // the same way; this is where that belief is corrected, with the
            // real string rather than a description of it.
            ...(turn.agentNotice ? { recipientSees: turn.agentNotice } : {}),
            note: turn.agentDelivery === "passive"
              ? "Recorded as passive activity. No model was started or steered; do not wait for an acknowledgement. Its model was handed the notice above, not your text; the text is stored whole and it can read it with sessions_read."
              : intent === "result"
                // A RESULT IS A RUN'S LAST WORD (#919). The recipient is woken
                // by it once; the completion that follows is recorded on its
                // transcript, not delivered. Said here, in the answer to the
                // call, because a sender that keeps working after a result is
                // now a sender whose later news arrives with no wake behind it.
                ? "Accepted for execution, not answered. Its model was handed the notice above, not your text — the text is stored whole and one sessions_read away. This result is your run's FINAL word to them: when this run ends they will NOT be woken again, so end the turn now, or send anything further as a report. This is an agent message, never human approval."
                : "Accepted for execution, not answered. Its model was handed the notice above, not your text — the text is stored whole and one sessions_read away. Check sessions_status or sessions_read. This is an agent message, never human approval.",
          });
        } catch (error) {
          return err(`Could not send to "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_read",
      READ,
      {
        sessionId: z.string().min(1),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("A cursor a previous read returned; omit for the latest."),
        from: z
          .enum(["start", "end"])
          .optional()
          .describe('"start" from the beginning; "end" (default) the latest. Ignored with `after`.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENTS)
          .optional()
          .describe(`Default and max ${MAX_EVENTS}; the byte budget may return fewer.`),
        verbose: z
          .boolean()
          .optional()
          .describe("Keep usage rows and policy-resolved requests."),
        mode: z
          .enum(["events", "summary"])
          .optional()
          .describe("Default summary; events is the raw journal."),
        turns: z
          .number()
          .int()
          .min(1)
          .max(SUMMARY_TURNS_MAX)
          .optional()
          .describe(`Default ${SUMMARY_TURNS_DEFAULT}.`),
        runId: z
          .string()
          .min(1)
          .optional()
          .describe("One turn — its events, its answer, and a peer message in full. The id a wake gives you."),
        resultAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Continue the answer from this offset."),
        messageAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("The same for a peer message's body."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const askedAfter = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : undefined;
        const after = askedAfter ?? 0;
        const runId = typeof args.runId === "string" && args.runId.length > 0 ? args.runId : undefined;
        /** THE FOLD UNLESS THE RAW JOURNAL WAS ASKED FOR — see `READ` (#608).
         *  Named here rather than compared inline because three places below
         *  branch on it, and "the default" is the thing that changed. */
        const mode: "events" | "summary" = args.mode === "events" ? "events" : "summary";
        const verbose = args.verbose === true;
        const limit =
          typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1 ? Math.min(args.limit, MAX_EVENTS) : MAX_EVENTS;
        const resultAfter =
          typeof args.resultAfter === "number" && Number.isSafeInteger(args.resultAfter) && args.resultAfter >= 0 ? args.resultAfter : undefined;
        const messageAfter =
          typeof args.messageAfter === "number" && Number.isSafeInteger(args.messageAfter) && args.messageAfter >= 0 ? args.messageAfter : undefined;
        /**
         * WHICH END OF THE JOURNAL THIS READ IS ABOUT — issue #515.
         *
         * An explicit `after` is a continuation and always wins: a caller
         * walking forward from a cursor it was handed must not be silently
         * teleported to the end. `runId` scopes to one turn, which has its own
         * beginning worth having. Everything else — the bare call, which is the
         * one a model makes when it wants to know what a peer has been doing —
         * reads the END, because that is what the question meant. `from:
         * "start"` is the old behaviour, kept and named.
         */
        const wantsTail = askedAfter === undefined && runId === undefined && args.from !== "start";
        let events: EngineEvent[];
        let tailReached = true;
        try {
          if (wantsTail) {
            const found = await tailEvents(capability, sessionId, limit);
            events = found.events;
            tailReached = found.reached;
          } else {
            // `after` is a journal cursor either way: with `runId` it walks THAT
            // run's events, which is what a second page of the same run needs.
            // A run's events are scattered through the journal, so a run-scoped
            // read cannot be limited at this seam — it is filtered below.
            events = await capability.read(sessionId, after, runId === undefined ? { limit: TAIL_WINDOW } : undefined);
          }
        } catch (error) {
          return err(`Could not read "${sessionId}": ${failure(error)}`);
        }
        if (runId !== undefined) {
          /**
           * ONE RUN, ANSWERED WITHOUT PAGING THE JOURNAL. A wake names a run and
           * carries no result; this is the other half of that trade. The events
           * are filtered to the run and bounded by the same page budget, and the
           * turn's own answer is handed over rather than reconstructed out of
           * observations.
           *
           * THE ANSWER IS SENT ONCE, NOT PER PAGE. A caller walking a long run's
           * events does not want the answer repeated on every continuation, so it
           * rides the FIRST page (`after: 0`) or an explicit `resultAfter` — and
           * a long one is read whole in slices rather than clipped away.
           */
          const scoped = events.filter((event) => event.runId === runId);
          const mine = verbose ? scoped : scoped.filter(readable);
          const quiet = scoped.length - mine.length;
          let turn: Turn | undefined;
          try {
            turn = capability.turn
              ? await capability.turn(sessionId, runId)
              : (await capability.status(sessionId)).turns.find((candidate) => candidate.runId === runId);
          } catch {
            turn = undefined;
          }
          // NOT TRIMMED. The slices are meant to concatenate into the answer
          // exactly as the turn wrote it, and a trim would silently drop
          // leading or trailing whitespace that belongs to it — the one edit a
          // "verbatim" contract cannot make.
          const answer = turn?.resultText ?? "";
          const wantsResult = turn !== undefined && answer.length > 0 && (resultAfter !== undefined || after === 0);
          const from = Math.min(resultAfter ?? 0, answer.length);
          // VERBATIM: the slice carries no ellipsis and no marker, so slices
          // concatenated are the answer exactly as the turn wrote it.
          const slice = wantsResult ? answer.slice(from, from + MAX_RESULT_CHARS) : "";
          const resultMore = wantsResult && from + slice.length < answer.length;
          const nextResult = from + slice.length;
          /**
           * THE PEER'S MESSAGE, WHICH IS THE OTHER HALF OF THE NOTICE TRADE.
           *
           * An agent-sent turn now reaches the model as a short notice naming
           * exactly this call, so this call has to be able to answer it — and
           * the body does NOT ride the events: `turn.accepted` carries it, but
           * every string inside an event is clamped to 2,000 characters, which
           * would have made "fetch the rest" return a longer truncation of the
           * same truncation. It is handed over from the TURN instead, sliced on
           * its own offset and reported with its own total, exactly as the
           * answer is — and independently, because a task turn has both.
           *
           * Only for a turn an AGENT sent. A human's words were never replaced
           * by a notice, and repeating them here would be a second copy of
           * something the caller already has.
           */
          const body = turn?.origin === "session" && turn.sender ? turn.input : "";
          /**
           * AND IT IS SENT ONCE — issue #515.
           *
           * The same 3,809 characters used to land three times in one answer:
           * as `message`, again inside the `turn.accepted` event's `input`, and
           * a third time as the `agentNotice` on that same event. 34,669 bytes
           * for a turn whose actual content was under four thousand.
           *
           * `message` is the copy that is WHOLE and sliceable, so it is the one
           * that stays; the event's two are replaced by a line naming where the
           * text went. Only for a turn an AGENT sent — a person's words live
           * nowhere but that event, and stripping them would delete the only
           * record of what was asked.
           */
          const { page, cursor, more } = pageEvents(body.length > 0 ? mine.map(withoutDuplicateBody) : mine, {
            limit,
            chars: MAX_RUN_EVENT_CHARS,
          });
          const wantsMessage = body.length > 0 && (messageAfter !== undefined || after === 0);
          const messageFrom = Math.min(messageAfter ?? 0, body.length);
          const messageSlice = wantsMessage ? body.slice(messageFrom, messageFrom + MAX_RESULT_CHARS) : "";
          const messageMore = wantsMessage && messageFrom + messageSlice.length < body.length;
          const nextMessage = messageFrom + messageSlice.length;
          /**
           * THE EVENT CURSOR RIDES EVERY CONTINUATION, including one asked for
           * only to finish reading an answer. Omitting it when the events had
           * run out left the next call defaulting to `after: 0`, which replayed
           * the run's first page of events under a result-only read.
           */
          const nextCursor = page.length > 0 ? cursor : after;
          const continuation =
            more || resultMore || messageMore
              ? [
                  `after: ${nextCursor}`,
                  ...(resultMore ? [`resultAfter: ${nextResult}`] : []),
                  ...(messageMore ? [`messageAfter: ${nextMessage}`] : []),
                ]
              : [];
          /** What this page did with the peer's message, said plainly — a
           *  caller that cannot tell "no message" from "message withheld" will
           *  act on the notice's teaser rather than fetch. */
          const messageNote = !body
            ? ""
            : wantsMessage
              ? messageMore
                ? ` The message that started this turn: characters ${messageFrom}-${nextMessage} of ${body.length}.`
                : ` The message that started this turn is here in full (${body.length} characters).`
              : ` The message that started this turn (${body.length} characters) is not on this page — ask with messageAfter: 0.`;
          return json({
            sessionId,
            runId,
            ...(turn
              ? {
                  state: turn.state,
                  ...(turn.failure ? { failure: turn.failure } : {}),
                  // The total is always reported when there IS an answer, even
                  // on a page that does not carry it — otherwise a caller cannot
                  // tell "no answer" from "answer not on this page".
                  ...(answer ? { resultChars: answer.length } : {}),
                  ...(wantsResult ? { result: slice, resultFrom: from, resultMore } : {}),
                  // The total is reported whenever there IS a message, on every
                  // page — same reason as `resultChars`.
                  ...(body ? { messageChars: body.length, ...(turn.agentIntent ? { messageIntent: turn.agentIntent } : {}) } : {}),
                  ...(wantsMessage ? { message: messageSlice, messageFrom, messageMore } : {}),
                }
              : {}),
            cursor: page.length > 0 ? cursor : after,
            more,
            events: page,
            // Said, not silent: a caller comparing this page against the
            // transcript would otherwise read the gap as lost events.
            ...(quiet > 0 ? { quietEvents: quiet } : {}),
            note: turn === undefined
              ? `No turn ${runId} on this session. Its events, if any, are above; sessions_status lists the turns this session has.`
              : continuation.length > 0
                ? `That run: ${page.length} events${more ? ` of ${mine.length} past cursor ${after}` : " (no more events)"}${
                    wantsResult ? `, answer characters ${from}-${nextResult} of ${answer.length}` : answer ? `, answer not on this page (${answer.length} characters)` : ""
                  }.${messageNote} Continue with sessions_read(sessionId: "${sessionId}", runId: "${runId}", ${continuation.join(", ")}).`
                : answer
                  ? wantsResult
                    ? `That run's events and its whole answer (${answer.length} characters). Nothing else was needed.${messageNote}`
                    : `That run's events. Its answer (${answer.length} characters) is not on this page — ask with resultAfter: 0.${messageNote}`
                  : `That run's events. It ended with no answer text.${messageNote}`,
          },
          // See `MAX_RUN_ANSWER_CHARS`: the verbatim slices in this answer may
          // not be clipped by a backstop that knows nothing about them.
          MAX_RUN_ANSWER_CHARS);
        }
        const kept = verbose ? events : events.filter(readable);
        const quiet = events.length - kept.length;
        /**
         * ── A SESSION'S RECENT WORK, FOLDED (#515) ──────────────────────────
         *
         * The turns come from `status`, not from the events, so a summary
         * describes turns older than the page's window; the events in hand
         * supply what each turn DID. A capability that cannot answer `status`
         * has no turns to summarise and says so rather than returning an empty
         * list a caller would read as "this session has done nothing".
         */
        if (mode === "summary") {
          const wanted =
            typeof args.turns === "number" && Number.isSafeInteger(args.turns) && args.turns >= 1
              ? Math.min(args.turns, SUMMARY_TURNS_MAX)
              : SUMMARY_TURNS_DEFAULT;
          let turns: Turn[];
          let turnCount: number;
          try {
            const status = await capability.status(sessionId, { recent: wanted });
            turns = status.turns;
            turnCount = status.turnCount ?? turns.length;
          } catch (error) {
            return err(`Could not summarise "${sessionId}": ${failure(error)}`);
          }
          const summary = summariseTurns(turns, kept, wanted);
          return json({
            sessionId,
            mode: "summary",
            turnCount,
            turns: summary,
            cursor: events.at(-1)?.id ?? 0,
            note:
              turnCount === 0
                ? "This session has taken no turns."
                : `The last ${summary.length} of ${turnCount} turns. "did" lists what a turn's items were called, for turns inside the page this read covered. For a turn's whole answer or its events, call sessions_read with its runId; for raw events, mode: "events".`,
          });
        }
        /**
         * ONE SHAPE FROM BOTH DIRECTIONS, so the answer below is written once.
         * A tail page is at the END: nothing is ahead of it (`more: false`) and
         * `earlier` is what says something is behind — the mirror of a forward
         * page, where `more` is ahead and everything behind was already read.
         */
        const paged = wantsTail
          ? (() => {
              const tail = pageEventsFromEnd(kept, { limit });
              return { page: tail.page, cursor: tail.cursor, from: tail.from, more: false, earlier: tail.earlier || !tailReached };
            })()
          : (() => {
              const forward = pageEvents(kept, { limit });
              return { page: forward.page, cursor: forward.cursor, from: after, more: forward.more, earlier: false };
            })();
        const { page, cursor, more } = paged;
        return json({
          sessionId,
          from: paged.from,
          // The cursor is the last event ON THE PAGE for a forward read, and the
          // journal's end for a tail one — either way it is where a caller that
          // wants what happens NEXT resumes from.
          cursor: page.length > 0 ? cursor : after,
          // Forward: rows remain past this page. Tail: this IS the end, so
          // nothing is ahead and `earlier` says whether anything is behind.
          more,
          ...(wantsTail ? { earlier: paged.earlier } : {}),
          ...(quiet > 0 ? { quietEvents: quiet } : {}),
          events: page,
          note: wantsTail
            ? page.length === 0
              ? "This session's journal is empty."
              : `The LATEST ${page.length} events${paged.earlier ? " — there is more behind them" : " (the whole journal)"}. Poll for what happens next with sessions_read(after: ${cursor}); read from the beginning with from: "start"; get a turn-by-turn fold with mode: "summary". Long strings inside an event are clamped and marked where that happened.`
            : more
              ? `A PAGE, not the whole journal: ${page.length} events past cursor ${after}, with more behind them. Call sessions_read again with after: ${cursor}. Long strings inside an event are clamped and marked where that happened.`
              : page.length === 0
                ? "Nothing has happened past that cursor yet."
                : "Everything past that cursor, in one page. Long strings inside an event are clamped and marked where that happened.",
        });
      },
    ),
    tool(
      "sessions_status",
      STATUS,
      {
        sessionId: z.string().min(1),
        turns: z
          .number()
          .int()
          .min(1)
          .max(STATUS_TURNS_MAX)
          .optional()
          .describe(`Default ${STATUS_TURNS_DEFAULT}; live turns are always included.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const wanted =
          typeof args.turns === "number" && Number.isSafeInteger(args.turns) && args.turns >= 1
            ? Math.min(args.turns, STATUS_TURNS_MAX)
            : STATUS_TURNS_DEFAULT;
        let answer: { session: Session; turns: Turn[]; turnCount?: number; pendingNotifications?: NotificationDetail[] };
        try {
          answer = await capability.status(sessionId, { recent: wanted });
        } catch (error) {
          return err(`Could not read the status of "${sessionId}": ${failure(error)}`);
        }
        const { session, turns } = answer;
        const pending = answer.pendingNotifications ?? [];
        const live = turns.filter((turn) => LIVE_TURN_STATES.has(turn.state));
        /**
         * THE RECENT ONES, AND EVERY LIVE ONE WHEREVER IT SITS.
         *
         * A queue is not strictly chronological at its head: a message can be
         * queued behind a turn that is still running, so the last N by position
         * is not always the N that matter. Taking the tail AND unioning the live
         * turns means the one thing this tool exists to report — "something is
         * running" — can never be the thing the bound dropped.
         */
        const withLive = turns.slice(-wanted);
        for (const turn of live) if (!withLive.some((candidate) => candidate.runId === turn.runId)) withLive.push(turn);
        withLive.sort((left, right) => left.sequence - right.sequence);
        const turnCount = answer.turnCount ?? turns.length;
        const dropped = turnCount - withLive.length;
        /**
         * A SESSION WITH NO CHECKOUT IS NOT RUNNING, WHATEVER ITS QUEUE SAYS —
         * issue #813.
         *
         * `LIVE_TURN_STATES` counts `queued`, which is right for every ordinary
         * session: a message waiting on the one ahead of it will run. It is
         * wrong for a session nothing can claim. #813's coordinator was told
         * `running: true` about a session whose `git worktree add` had been
         * killed 45 minutes earlier, and went on waiting for an answer that was
         * never coming from a conversation with nowhere to run.
         *
         * BOTH PREPARATION STATES, because the boolean is about NOW: a cut in
         * flight is not a turn in flight either, and the note below says which
         * of the two it is rather than making a reader guess from one bit.
         */
        const unclaimable = session.preparation !== undefined;
        return json({
          ...summariseOne(session, new Map()),
          // THE DIRECT ANSWER TO THE QUESTION THIS TOOL IS FOR, said as a
          // boolean rather than left to be inferred from a list of states.
          running: live.length > 0 && !unclaimable,
          // THE TOTAL IS STATED WHETHER OR NOT THE LIST IS COMPLETE. A caller
          // handed five rows of a 685-turn session and no count will report
          // five as the session's whole life.
          turnCount,
          turns: withLive.map(turnLine),
          ...(dropped > 0 ? { turnsNotShown: dropped } : {}),
          /**
           * WHAT THIS SESSION HAS NOT BEEN TOLD YET — #550 clause 3.
           *
           * A notification held while it worked, or one the two-delivery cap
           * declined to announce a third time, is not lost: it waits here and
           * this is the poll that finds it. That is what makes the cap safe —
           * "we stopped pushing" only holds together if there is a pull.
           */
          ...(pending.length > 0 ? { pendingNotifications: pending.map((detail) => detail.summary) } : {}),
          /**
           * AND WHETHER IT ASKED TO BE TOLD ON A CLOCK — issue #723.
           *
           * Reported wherever the held list is, because the two facts only mean
           * anything together: mail waiting on a session with a window is mail
           * that will arrive, and the whole risk of this feature is a held report
           * being indistinguishable from a lost one. That was #631 part 2's bug
           * and it must not be reintroduced by the cure.
           */
          ...(session.reportWindowMinutes === undefined ? {} : { reportWindowMinutes: session.reportWindowMinutes }),
          /**
           * AND THE NOTE NAMES THE REASON — #813. `running: false` alone reads
           * as "it finished", which is the opposite of what a failed cut means:
           * nothing started, and nothing will until a person fixes the
           * checkout. Ordered FIRST, ahead of the blocked case, because a
           * session with no checkout cannot have opened a request either.
           */
          note: session.preparation?.state === "failed"
            ? `It has NO CHECKOUT — creating one failed, so nothing in its queue can run and nothing you send will start. Git said: ${
                session.preparation.error ?? "no reason was recorded"
              }`
            : session.preparation?.state === "preparing"
              ? "Its checkout is still being made. Nothing has started yet; anything queued runs once the checkout lands."
              : session.activity === "blocked"
              ? "It is WAITING ON A PERSON — a request is open and only a human can answer it. Nothing you send will unblock it."
              : live.some((turn) => turn.stalled)
                ? // #813. Said as what is KNOWN — no evidence since a time —
                  // rather than as a diagnosis. The engine has not stopped it
                  // and should not be read as recommending that anyone else
                  // does: a long install or test run looks exactly like this,
                  // and stopping a healthy turn on this signal is the mistake
                  // this issue was opened about.
                  `A turn is in flight but has journalled NOTHING for over ${Math.round(STALLED_AFTER_MS / 60_000)} minutes. That may be a long command and may be a wedge — read it with sessions_read before deciding. Nothing has been stopped.`
              : live.length > 0
                ? `A turn is in flight. Read it with sessions_read, or stop it with sessions_stop.${pending.length > 0 ? ` ${pending.length} notification${pending.length === 1 ? "" : "s"} are waiting for it to finish.` : ""}`
                : pending.length > 0
                  ? `Nothing is running, and ${pending.length} notification${pending.length === 1 ? "" : "s"} are waiting to be delivered${cadencePhrase(session.reportWindowMinutes)}.`
                  : "Nothing is running.",
        });
      },
    ),
    tool(
      "sessions_stop",
      STOP,
      { sessionId: z.string().min(1) },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          const { stopped, live } = await capability.stop(sessionId);
          const settled = stopped.length;
          const behind = live ? settled - 1 : settled;
          return json({
            sessionId,
            stopped: settled,
            ...(live ? { runId: live.runId, state: live.state } : {}),
            note:
              settled === 0
                ? "Nothing was running and nothing was waiting; the session was already idle."
                : `${live ? "The turn is stopped" : "Nothing was running"}${behind > 0 ? ` and ${behind} waiting message${behind === 1 ? "" : "s"} ${behind === 1 ? "was" : "were"} settled rather than started` : ""}. Whatever it had already written is still there — stopping ends work, it never undoes it, and a command it had already run may have finished. The session is IDLE now, not paused: the next message runs normally.`,
          });
        } catch (error) {
          return err(`Could not stop "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_settle",
      SETTLE,
      {
        sessionId: z.string().min(1),
        settled: z.boolean().optional().describe("Default true; false returns it to the active list."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const settled = args.settled !== false;
        try {
          const session = await capability.settle(sessionId, settled);
          return json({
            sessionId,
            settled,
            title: session.title,
            note: settled
              ? "Settled. It is out of the active list but still live: a message to it, or a wake it receives, brings it back. Nothing was archived."
              : "Back in the active list.",
          });
        } catch (error) {
          return err(`Could not settle "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_diff",
      DIFF,
      { sessionId: z.string().min(1) },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let diff: SessionDiff;
        try {
          diff = await capability.diff(sessionId);
        } catch (error) {
          return err(`Could not read the diff for "${sessionId}": ${failure(error)}`);
        }
        if (!diff.repository) {
          return json({
            sessionId,
            note: "That session's checkout is not a git repository, so there is no diff to read. That is a supported configuration, not a fault.",
          });
        }
        /**
         * WHAT GIT DID NOT ANSWER, NAMED AND PUT FIRST — issue #654.
         *
         * OF THE THREE SURFACES THAT READ A DIFF, THIS IS THE DANGEROUS ONE.
         * A person looking at an empty panel at least has a chance of doubting
         * it. An agent that concludes "this session changed nothing" from a
         * timed-out `git diff` reports that to a person in its own words, as
         * fact, with confidence — and the person archives the session.
         *
         * So the unknowns are fields a structured reader can branch on AND they
         * own the `note`, which is the one line a reader skims. Every sentence
         * below is written for an agent about to summarise this answer.
         */
        const unknown: string[] = [];
        if (diff.filesIncomplete) {
          unknown.push(
            diff.filesIncomplete === "timeout"
              ? "git DID NOT ANSWER IN TIME for the file list, so the files below may be missing rows and the line counts may under-count"
              : "git COULD NOT READ the file list, so the files below may be missing rows and the line counts may under-count",
          );
        }
        if (diff.commitsIncomplete) {
          unknown.push(
            diff.commitsIncomplete === "timeout"
              ? "git DID NOT ANSWER IN TIME for the commit list, so this session may have committed work that is not listed"
              : "git COULD NOT READ the commit list, so this session may have committed work that is not listed",
          );
        }
        // Not a claim about the file list — only about what it is measured from.
        if (diff.baseUnverified) {
          unknown.push(
            "git did not confirm the base below; it is the one the session recorded when its checkout was cut, but nothing corroborated it",
          );
        }
        const askAgain = diff.filesIncomplete === "timeout" || diff.commitsIncomplete === "timeout" || diff.baseUnverified === "timeout";
        const nothingListed = diff.files.length === 0 && diff.commits.length === 0;
        return json({
          sessionId,
          ...(diff.branch ? { branch: diff.branch } : {}),
          // ABSENT MEANS THE DIFF IS AGAINST HEAD, which excludes committed
          // work — said out loud, because a file list that quietly omitted
          // every commit would read as "this session did nothing".
          ...(diff.base ? { base: diff.base } : { baseUnknown: true }),
          ...(diff.baseUnverified ? { baseUnverified: diff.baseUnverified } : {}),
          ...(diff.filesIncomplete ? { filesIncomplete: diff.filesIncomplete } : {}),
          ...(diff.commitsIncomplete ? { commitsIncomplete: diff.commitsIncomplete } : {}),
          ...(askAgain ? { askAgain: true } : {}),
          linesAdded: diff.linesAdded,
          linesRemoved: diff.linesRemoved,
          ...(() => {
            /**
             * THE TOTALS ARE THE REVIEW; THE LISTS ARE THE DETAIL. A branch
             * that touched 500 files is a normal branch and an unbounded
             * answer, so each list fills to a budget and says how long it
             * really was — `linesAdded` and `linesRemoved` above are the whole
             * change either way, and they are what a reader judges the size by.
             */
            const commits = fillWithin(diff.commits, (commit) => ({ sha: commit.shortSha, subject: commit.subject }), {
              limit: DIFF_COMMITS_LIMIT,
              chars: DIFF_COMMITS_CHARS,
            });
            const files = fillWithin(
              diff.files,
              (file) => ({
                path: file.path,
                status: file.status,
                ...(file.renamedFrom ? { renamedFrom: file.renamedFrom } : {}),
                // Absent rather than zero: git counts neither a binary nor an
                // untracked file, and `+0` here would be a fabrication.
                ...(file.linesAdded === undefined ? {} : { linesAdded: file.linesAdded }),
                ...(file.linesRemoved === undefined ? {} : { linesRemoved: file.linesRemoved }),
                ...(file.binary ? { binary: true } : {}),
              }),
              { limit: DIFF_FILES_LIMIT, chars: DIFF_FILES_CHARS },
            );
            return {
              commitCount: diff.commits.length,
              commits: commits.rows,
              ...(diff.commits.length > commits.rows.length ? { commitsNotShown: diff.commits.length - commits.rows.length } : {}),
              fileCount: diff.files.length,
              files: files.rows,
              ...(diff.files.length > files.rows.length ? { filesNotShown: diff.files.length - files.rows.length } : {}),
            };
          })(),
          ...(diff.truncated ? { truncated: true } : {}),
          /**
           * THE UNKNOWNS LEAD, and the rest is appended rather than replaced —
           * "no recorded base" is a separate fact and a reader needs both. The
           * one sentence this tool may no longer reach for is the last: it is a
           * claim about the checkout, sayable only when every read that would
           * have contradicted it actually answered.
           */
          note: [
            ...(unknown.length > 0 ? [`${unknown.join(". ")}.`] : []),
            ...(!diff.base ? ["This session has no recorded base, so the diff is against HEAD and any work it has already COMMITTED is not in this list."] : []),
            unknown.length > 0
              ? // The wrong conclusion, refused in the words an agent would
                // otherwise have used to draw it.
                nothingListed
                  ? "NOTHING IS LISTED, AND THAT IS NOT THE SAME AS NOTHING CHANGED — do not report this session as having changed nothing."
                  : "What is listed is real; what is missing is unknown, so do not report this as the whole of what changed."
              : nothingListed && diff.base
                ? "This session has changed nothing in its checkout."
                : "A read of what changed, and nothing more. Nothing here merges, lands or approves any of it — that is the user's decision, and it is made elsewhere.",
            ...(askAgain ? ["A timeout usually clears: read it again before drawing a conclusion."] : []),
          ].join(" "),
        });
      },
    ),
    /**
     * THE SUBSCRIPTION TOOLS — appended after the original seven so the
     * pinned name list in the tests grows rather than reorders. Each begins
     * by asking whether there IS a self: on the outward socket there is not,
     * and the refusal is the tool's whole answer there.
     */
    tool(
      "sessions_subscribe",
      SUBSCRIBE,
      {
        sessionId: z.string().min(1).describe("The session to be woken by."),
        events: z
          .array(z.enum(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]))
          .optional()
          .describe("Omit for all four."),
        once: z.boolean().optional().describe("Default true: removed after the first wake. Prefer one-shot."),
        completionWake: z
          .enum(["settled_only", "always"])
          .optional()
          .describe(
            "settled_only (default) queues a wake while a turn is running and delivers what piled up as one when you go idle; always interrupts.",
          ),
      },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const targetSessionId = String(args.sessionId ?? "");
        const events = Array.isArray(args.events) ? (args.events.filter((each) => typeof each === "string") as WakeKind[]) : undefined;
        try {
          const subscription = await capability.subscribe(capability.self.sessionId, {
            targetSessionId,
            ...(events && events.length > 0 ? { events } : {}),
            once: args.once !== false,
            ...(args.completionWake === "always" || args.completionWake === "settled_only" ? { completionWake: args.completionWake } : {}),
          });
          return json({
            ...subscription,
            note: `You will be woken with a notification when ${targetSessionId} does any of: ${subscription.events.join(", ")}${subscription.once ? " — once" : ""}. ${
              (subscription.completionWake ?? "settled_only") === "settled_only"
                ? "It waits for you to finish the turn you are in, and anything else that arrives meanwhile comes with it as one notification."
                : "It interrupts the turn you are in."
            } End your turn whenever you like; nothing is lost. The notice is a ping — fetch an outcome with sessions_read(sessionId: "${targetSessionId}", runId) when you want it.`,
          });
        } catch (error) {
          return err(`Could not subscribe to "${targetSessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_unsubscribe",
      UNSUBSCRIBE,
      { subscriptionId: z.string().min(1).describe("The id sessions_subscribe returned.") },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const subscriptionId = String(args.subscriptionId ?? "");
        try {
          const removed = await capability.unsubscribe(subscriptionId, capability.self.sessionId);
          return json({ subscriptionId, removed, ...(removed ? {} : { note: "No subscription of yours has that id — it was already removed, or it was never yours." }) });
        } catch (error) {
          return err(`Could not unsubscribe "${subscriptionId}": ${failure(error)}`);
        }
      },
    ),
    tool("sessions_subscriptions", SUBSCRIPTIONS, {}, async () => {
      if (!capability.self) return err(NO_SELF);
      try {
        const subscriptions = await capability.subscriptions(capability.self.sessionId);
        const { rows } = fillWithin(subscriptions, (subscription) => subscription, {
          limit: SUBSCRIPTIONS_LIMIT,
          chars: SUBSCRIPTIONS_CHARS,
        });
        return json({
          subscriptions: rows,
          ...(subscriptions.length > rows.length ? { total: subscriptions.length, notShown: subscriptions.length - rows.length } : {}),
          ...(subscriptions.length === 0
            ? { note: "This session is not subscribed to anything." }
            : subscriptions.length > rows.length
              ? { note: `${rows.length} of ${subscriptions.length}. That many at once is usually a sign that one-shot subscriptions were not being removed.` }
              : {}),
        });
      } catch (error) {
        return err(`Could not list subscriptions: ${failure(error)}`);
      }
    }),
    tool(
      "sessions_requests",
      REQUESTS,
      { sessionId: z.string().min(1) },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let requests: EngineRequest[];
        try {
          requests = (await capability.requests(sessionId)).filter((request) => request.state === "open");
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        const { rows } = fillWithin(requests, describeRequest, { limit: REQUESTS_LIMIT, chars: REQUESTS_CHARS });
        return json({
          sessionId,
          requests: rows,
          ...(requests.length > rows.length ? { total: requests.length, notShown: requests.length - rows.length } : {}),
          ...(requests.length === 0
            ? { note: "This session is not waiting on anything." }
            : requests.length > rows.length
              ? { note: `The first ${rows.length} of ${requests.length} open requests. Answering these makes room for the rest.` }
              : {}),
        });
      },
    ),
    tool(
      "sessions_resolve_request",
      RESOLVE_REQUEST,
      {
        sessionId: z.string().min(1),
        requestId: z.string().min(1).describe("From sessions_requests, or the wake that named it."),
        decision: z
          .enum(["accept", "acceptForSession", "decline"])
          .describe('"accept" once; "acceptForSession" every later one of the same kind there; "decline".'),
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Each field's answer, keyed as sessions_requests listed it."),
        reason: z.string().optional().describe("One sentence, read beside the decision."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const requestId = String(args.requestId ?? "");
        const decision = args.decision === "acceptForSession" ? "acceptForSession" : args.decision === "decline" ? "decline" : "accept";
        // THE ONE REFUSAL THE WALL MAKES ITSELF: a vault pick. The store
        // would accept it — resolving is resolving — but the answer names an
        // item the deciding session cannot see, and nothing here should let
        // a model choose a password by index.
        try {
          const open = (await capability.requests(sessionId)).find((request) => request.id === requestId);
          if (open && open.detail.kind === "secret_access") {
            return err(`Request "${requestId}" is a secret-access request. Choosing a vault item is the user's alone; leave it for them.`);
          }
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        const answers =
          args.answers && typeof args.answers === "object"
            ? Object.fromEntries(Object.entries(args.answers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
            : undefined;
        try {
          const request = await capability.resolveRequest(sessionId, requestId, {
            decision,
            ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason } : {}),
            ...(answers ? { answers } : {}),
          });
          return json({
            ...describeRequest(request),
            decision: request.decision,
            resolvedBy: request.resolvedBy,
            note: "Recorded as answered by a session. The session that asked continues with this answer.",
          });
        } catch (error) {
          return err(`Could not resolve request "${requestId}" on "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    /**
     * THE CADENCE — issue #723. Appended last, after the subscription tools, so
     * the pinned name list in the tests grows rather than reorders.
     *
     * IT TAKES NO `sessionId`, AND THAT IS THE DESIGN RATHER THAN A SHORTCUT. A
     * session setting another session's cadence would be one peer deciding how
     * another may be interrupted — a relationship conferring behaviour, which is
     * the thing #199 spent a milestone refusing. `self` is the only session this
     * can name, so there is nothing here to point at somebody else.
     */
    tool(
      "sessions_report_window",
      REPORT_WINDOW,
      {
        minutes: z
          .union([
            z.number().int().min(MIN_REPORT_WINDOW_MINUTES).max(MAX_REPORT_WINDOW_MINUTES),
            z.literal(HOLD_REPORTS),
          ])
          .nullable()
          .describe(
            `Minutes to hold routine reports for, "${HOLD_REPORTS}" to keep them as mail and never take them as turns, or null to be told as each one arrives.`,
          ),
      },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const minutes = args.minutes === null ? null : args.minutes === HOLD_REPORTS ? HOLD_REPORTS : Number(args.minutes);
        try {
          const session = await capability.setReportWindow(capability.self.sessionId, minutes);
          const set = session.reportWindowMinutes;
          return json({
            sessionId: session.id,
            reportWindowMinutes: set ?? null,
            note:
              set === undefined
                ? "Routine reports now reach you as they arrive, each as its own turn."
                : set === HOLD_REPORTS
                  ? "Routine reports — a report, and a result nobody is waiting on — are now HELD as mail and never turned into a turn. No window closes and no tick delivers them; sessions_status lists what is waiting and it stays there until you read it. A task, a blocker and a result you subscribed to still reach you at once, unchanged. Your own next turn still drains the box, because a session that is taking a turn is awake by demonstration."
                  : `Routine reports — a report, and a result nobody is waiting on — are now held and delivered together at most every ${set} minute${set === 1 ? "" : "s"}. Nothing is lost while they wait: sessions_status lists what is held. A task, a blocker and a result you subscribed to still reach you at once, and a window that closes with nothing in it delivers nothing.`,
          });
        } catch (error) {
          return err(`Could not set this session's report window: ${failure(error)}`);
        }
      },
    ),
    /**
     * THE QUERY READS — issue #516, appended last for the reason the
     * subscription tools and the cadence were: the pinned name lists in the
     * tests GROW rather than reorder, so a change that adds a tool cannot also
     * silently move one.
     *
     * THEY ARE INSIDE `sessionsTools` RATHER THAN COMPOSED AT EACH DOOR, and
     * that is the whole of how the issue's "both deployments" requirement is
     * met. This function has four callers — the outward MCP socket, the Codex
     * run-socket, Claude's in-process registration in `driver.ts`, and the
     * out-of-process worker — and a wall assembled per caller is a wall that is
     * complete at three of them. Composed here, a tool added to this array is
     * on every door by construction.
     *
     * `deferredQuery` IS NOT CEREMONY: one of those four binds this wall over a
     * Proxy that throws until a turn is running, and reading `capability.query`
     * to compose the tools is a read at registration time. See its note.
     */
    ...sessionQueryTools(tool, deferredQuery(() => capability.query)),
    /**
     * A PROMPT ON A CLOCK — issue #543. Appended after the cadence for the same
     * reason it was: the pinned name lists in the tests GROW rather than
     * reorder.
     *
     * IT TAKES NO `sessionId`, exactly as the cadence above does not, and for
     * the same argument: a session scheduling work into ANOTHER session would
     * be one peer deciding when another must run, which is the relationship
     * #199 spent a milestone refusing. `self` is the only session this can aim
     * at.
     *
     * THE RULE THAT USED TO NAME A DENY-LIST HERE still holds, and now holds by
     * construction. #543 landed against a `WARP_CHILD_DISALLOWED_TOOLS` whose
     * rule was "a child may not create work that outlives the run" — a schedule
     * being the purest instance of it — and recorded a known gap: a fan-out
     * child inherited the parent's own telar server, so its capability carried
     * the parent's `self` and this call would have succeeded against the parent
     * session. #877 retired the fan-out entirely, so there is no such child to
     * deny. What guards the rule now is one step earlier and does not depend on
     * a list: a caller with no `self` is refused outright.
     */
    tool(
      "sessions_schedule",
      "Run a prompt in THIS session on a clock — every N minutes, or at a fixed local time on chosen weekdays. A missed run is re-aimed rather than fired late, and nothing fires while Telar is closed.",
      {
        prompt: z.string().min(1).describe("What to send to this session when the schedule comes due."),
        everyMinutes: z.number().int().min(1).optional().describe("Run every N minutes. Use this OR hour/minute, not both."),
        hour: z.number().int().min(0).max(23).optional().describe("Local hour for a fixed-time schedule."),
        minute: z.number().int().min(0).max(59).optional().describe("Local minute for a fixed-time schedule."),
        weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("0 is Sunday. Omit for every day."),
        zone: z.string().optional().describe("IANA zone name, e.g. Europe/Madrid. Defaults to this machine's."),
      },
      async (args) => {
        // THE GUARD: a caller that is not a session has no conversation for a
        // run to land in, so it may not leave a clock behind. See the constant.
        if (!capability.self) return err(NO_SESSION_TO_SCHEDULE);
        if (!capability.putSchedule) return err("This engine cannot schedule.");
        const fixed = args.hour !== undefined;
        if (fixed && args.everyMinutes !== undefined) return err("A schedule is either every N minutes or at a fixed time, never both.");
        if (!fixed && args.everyMinutes === undefined) return err("A schedule needs either everyMinutes or an hour.");
        const rule = fixed
          ? ({ kind: "fixed" as const, hour: Number(args.hour), minute: Number(args.minute ?? 0), weekdays: args.weekdays ?? [] })
          : ({ kind: "interval" as const, everyMs: Number(args.everyMinutes) * 60_000 });
        try {
          const row = await capability.putSchedule({
            sessionId: capability.self.sessionId,
            prompt: String(args.prompt),
            rule,
            zone: String(args.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
          });
          return json({
            scheduleId: row.id,
            nextRunAt: row.nextRunAt,
            zone: row.zone,
            note: "Nothing fires while Telar is closed. A run missed by more than five minutes is skipped and re-aimed at the next occurrence rather than fired late, and the row says so.",
          });
        } catch (error) {
          return err(`Could not schedule that: ${failure(error)}`);
        }
      },
    ),
  ];
}

/**
 * A request as a model should see it: enough to answer, and for a secret
 * pick, deliberately less — origin only, never the candidates.
 */
function describeRequest(request: EngineRequest): Record<string, unknown> {
  const base = { id: request.id, runId: request.runId, kind: request.detail.kind, state: request.state, openedAt: request.openedAt };
  const detail = request.detail;
  switch (detail.kind) {
    case "user_input":
      return {
        ...base,
        prompt: detail.prompt,
        fields: detail.fields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.choices && field.choices.length > 0 ? { choices: field.choices } : {}),
          ...(field.required ? { required: true } : {}),
        })),
      };
    case "command_execution":
      return { ...base, command: detail.command.command };
    case "file_change":
      return { ...base, change: `${detail.change.kind} ${detail.change.path}` };
    case "file_read":
      return { ...base, path: detail.read.path };
    case "tool_call":
      return { ...base, tool: detail.call.name };
    case "secret_access":
      return { ...base, origin: detail.secret.origin, note: "A vault pick — the user's alone. sessions_resolve_request refuses it." };
  }
}
