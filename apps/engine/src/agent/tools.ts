/**
 * WHAT THE AGENT CAN DO — the two walls it already had, and three reads it
 * did not (#531).
 *
 * ── WHICH CAPABILITY, AND WHY NEITHER GIVES THE GATE AWAY ───────────────────
 * There are two builds of `SessionsCapability` in this engine and the issue
 * asks which one the Agent should take.
 *
 *   · `daemon.ts`'s socket build — in-process, every verb a direct `store.*`
 *     call, and NO `self` because a chat client on that socket is not a session
 *     and has nowhere to be woken.
 *   · `worker.ts`'s build — every verb back over HTTP, with `self` set to the
 *     session whose turn is running.
 *
 * THE ANSWER IS THE DAEMON'S, WITH A `self` ADDED. The Agent runs inside the
 * daemon process: routing its `sessions_list` through the daemon's own HTTP
 * surface would be a loopback and a credential for a call between two functions
 * in one process. What the worker's build has that the daemon's lacks is only
 * the `self` — so that is what is supplied here, as the reserved id `agent`.
 *
 * AND NEITHER GIVES THE REQUEST GATE FOR FREE, which is the part of the
 * question with a surprising answer. The gate a Codex or Claude turn passes
 * through is NOT on the capability at all: it is the driver's `onRequest`,
 * which is `worker.ts`'s `askEngine`, and `askEngine` is bound to a CLAIM —
 * a session, a run id and a claim token the engine can check. The Agent has
 * none of the three, because it is not a session and takes no claim. So there
 * is nothing to inherit, and inventing a synthetic claim to borrow one would be
 * a fake session existing solely to satisfy a signature. The Agent's approval
 * is therefore its own, and #531 says where it lives: `interrupt()` in the
 * graph, parked as a request on the Agent's own state rather than on a
 * session's. See `./approval.ts`.
 *
 * ── THE `self` IS `agent`, AND WHAT THAT BUYS ───────────────────────────────
 * Two things, both of which a capability with no `self` refuses in words:
 * SUBSCRIPTIONS (`sessions_subscribe` needs somebody to wake) and ATTRIBUTION
 * (a turn the Agent sends is stamped as coming from it). It is a RESERVED id
 * rather than a session id — nothing in `sessions/` goes by it, `sessions_read`
 * on it answers not-found, and the store's subscription verbs know it by name.
 *
 * ── AND NOTHING ELSE ────────────────────────────────────────────────────────
 * No shell, no browser, no files, no notebooks-as-documents, no ds, no latex,
 * no run, no display. Not disabled — ABSENT, which is `main-session/driver.ts`'s
 * rule and the right one: a model with no such tool says so, where a model whose
 * tool is refused reports the refusal as a fault.
 */
import { z } from "zod";
import { collectTools, toolInputSchema, type SocketTool } from "../mcp-socket";
import { notesTools, PREVIEW_CHARS, type NotesCapability } from "../notes-tools/tools";
import { sessionsTools, type SessionsCapability } from "../sessions-tools/tools";
import { err, failure, json, type ToolFactory } from "../tool-kit";
import { TURN_ANSWER_NONE, TURN_ANSWER_NO_SUCH_RUN } from "../state";
import { SECTION_CHARS, STANDING_SECTION_KEYS, type StandingSection } from "./memory";
import type { AgentRecallHit } from "./thread-log";
import { head } from "../turn-summary";
import type { GitHubIssueDetail, GitHubIssueRead, GitHubPullDetail, GitHubPullRead } from "@telar/engine-client";

export { AGENT_SELF_ID } from "./identity";

/* ------------------------------------------------------------------ *
 * The three query tools — #516's reads, with the Agent as their first user.
 * ------------------------------------------------------------------ */

/**
 * The store methods behind `sessions_find`, `sessions_outline` and
 * `sessions_answer`, as a capability rather than a store handle — the seam
 * every other wall in this engine uses, so a test drives these three with three
 * functions and no daemon.
 */
export type AgentQueryCapability = {
  find(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit: number }): Promise<{
    sessions: Array<{ id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>;
    index: string;
    more: boolean;
  }>;
  outline(sessionId: string, window: { limit: number; before?: number }): Promise<{ turns: unknown[]; total: number; more: boolean; next?: number }>;
  answer(sessionId: string, options: { runId?: string; from: number; limit: number }): Promise<{
    runId: string;
    sequence: number;
    text: string;
    from: number;
    totalChars: number;
    more: boolean;
    next?: number;
  }>;
};

/**
 * THE SAME CEILINGS THE ROUTES APPLY, and deliberately the same numbers rather
 * than a second opinion — `daemon.ts`'s query-route block is where they are
 * argued for. A tool answer is a context window spent (#515), so these are
 * clamps and not suggestions: asking for more is served less, and the answer
 * says so.
 */
const FIND_LIMIT_DEFAULT = 10;
const FIND_LIMIT_MAX = 50;
const OUTLINE_PAGE_DEFAULT = 20;
const OUTLINE_PAGE_MAX = 100;
const ANSWER_SLICE_DEFAULT = 8_000;
const ANSWER_SLICE_MAX = 64_000;

const FIND =
  "Which conversation was this — a lexical search over every session, each hit carrying the line that matched. " +
  "The cheap first step before sessions_read.";

const OUTLINE =
  "Scroll a conversation without reading it: one row per turn, newest first — what was asked, what it did, how it ended.";

const ANSWER =
  "What one turn concluded — the answer alone, without its events. Defaults to the latest turn that said something.";

/**
 * WHEN THERE IS NOTHING TO READ, SAY SO IN A SENTENCE THAT CLOSES (#592).
 *
 * ── WHAT THE OLD ONES DID ───────────────────────────────────────────────────
 * The measured turn's two failures read `…: turn does not exist` and `…: this
 * session has no answered turn`. Both DESCRIBE the miss and neither CLOSES the
 * door, so the model tried again with different arguments — and the second is
 * the worse of the two, because "has no answered turn" reads as "pick a
 * different turn" when the true meaning is "there is nothing here, stop
 * asking". A refusal a model reads as a hint about arguments is a refusal that
 * costs two more calls.
 *
 * ── THE SHAPE, WHICH IS `DECLINED_ANSWER`'S ─────────────────────────────────
 * Name the fact, shut the retry down in as many words, and point at the one
 * move that is not a retry. `approval.ts` argues that shape for a declined
 * call; this is the same problem with the person taken out of it.
 *
 * ── AND WHY THE CLOSING HALF IS HERE RATHER THAN AT THE THROW ───────────────
 * The store's sentences are served to an HTTP client too, and "do not guess
 * another runId" is advice to a language model. So the store states the fact
 * and the TOOL — whose only reader is a model — says what to do about it.
 */
const ANSWER_MISSES: Readonly<Record<string, string>> = {
  [TURN_ANSWER_NONE]:
    "this session has never left an answer. There is nothing here to read and no runId will produce one, so do not ask it again — sessions_status says what it is doing, sessions_outline what its turns were.",
  [TURN_ANSWER_NO_SUCH_RUN]:
    "no turn with that runId is in this session. Do not guess another — omit runId for the latest turn that said something, or sessions_outline to see which turns there are.",
};

export function agentQueryTools(tool: ToolFactory, capability: AgentQueryCapability): unknown[] {
  return [
    tool(
      "sessions_find",
      FIND,
      {
        q: z.string().min(1).describe("Lexical, not semantic — the phrase you remember seeing."),
        projectId: z.string().min(1).optional(),
        settled: z.boolean().optional().describe("true for shelved only, false for open. Omit for both."),
        since: z.number().int().min(0).optional().describe("Epoch milliseconds."),
        limit: z.number().int().min(1).max(FIND_LIMIT_MAX).optional().describe(`Default ${FIND_LIMIT_DEFAULT}.`),
      },
      async (args) => {
        try {
          const found = await capability.find({
            q: String(args.q ?? ""),
            ...(typeof args.projectId === "string" && args.projectId ? { projectId: args.projectId } : {}),
            ...(typeof args.settled === "boolean" ? { settled: args.settled } : {}),
            ...(typeof args.since === "number" ? { since: args.since } : {}),
            limit: clamp(args.limit, FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX),
          });
          return json({
            ...found,
            // WHICH INDEX ANSWERED, carried through from the store. A caller
            // comparing two engines' results deserves to know whether it got
            // FTS5 or the bounded scan.
            note: found.more ? "More sessions matched than are shown. Narrow with projectId, settled or since rather than raising the limit." : undefined,
          });
        } catch (error) {
          return err(`Could not search: ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_outline",
      OUTLINE,
      {
        sessionId: z.string().min(1),
        before: z.number().int().min(0).optional().describe("The `next` a previous page returned, so appends cannot shift the window."),
        limit: z.number().int().min(1).max(OUTLINE_PAGE_MAX).optional().describe(`Default ${OUTLINE_PAGE_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          return json(
            await capability.outline(sessionId, {
              limit: clamp(args.limit, OUTLINE_PAGE_DEFAULT, OUTLINE_PAGE_MAX),
              ...(typeof args.before === "number" ? { before: args.before } : {}),
            }),
          );
        } catch (error) {
          return err(`Could not outline "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_answer",
      ANSWER,
      {
        sessionId: z.string().min(1),
        runId: z.string().min(1).optional().describe("Omit for the latest turn that left text — the usual case after a wake."),
        from: z.number().int().min(0).optional().describe("Character offset; the reply says the total."),
        limit: z.number().int().min(1).max(ANSWER_SLICE_MAX).optional().describe(`Default ${ANSWER_SLICE_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          return json(
            await capability.answer(sessionId, {
              ...(typeof args.runId === "string" && args.runId ? { runId: args.runId } : {}),
              from: typeof args.from === "number" ? Math.max(0, args.from) : 0,
              limit: clamp(args.limit, ANSWER_SLICE_DEFAULT, ANSWER_SLICE_MAX),
            }),
          );
        } catch (error) {
          const said = failure(error);
          return err(`Could not read the answer from "${sessionId}": ${ANSWER_MISSES[said] ?? said}`);
        }
      },
    ),
  ];
}

/** A caller's number, or the default, never above the ceiling. Clamped rather
 *  than refused, because a model that asked for 500 wants as many as it can
 *  have and the answer says what it got. */
function clamp(raw: unknown, fallback: number, ceiling: number): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, ceiling);
}

/* ------------------------------------------------------------------ *
 * `fleet_status` — the whole answer to "how are things" (#570).
 * ------------------------------------------------------------------ */

/**
 * THE READ THE AGENT DID NOT HAVE, and the absence cost sixteen laps.
 *
 * Asked "how are things", the Agent had no call that answers the question, so it
 * assembled one: two `sessions_status`, two `sessions_outline`, one
 * `sessions_requests` and TEN `sessions_answer` — one per session it remembered
 * — and then hit the graph's ceiling with nothing to say. Every one of those
 * reads is correctly scoped; none of them is "the fleet", and a model with no
 * fleet read builds one a session at a time.
 *
 * ── WHY THE UNION OF THREE SOURCES ──────────────────────────────────────────
 * "The sessions the Agent has touched" is not one list, and no single one of the
 * three is it:
 *
 *   · SUBSCRIPTIONS are the work it ASSIGNED and asked to be woken by. The
 *     highest-signal source, and the smallest — a one-shot subscription is
 *     removed when it fires, so a session it delegated an hour ago is already
 *     gone from here.
 *   · THE STANDING STATE'S `who` SECTION is what it believes it is coordinating,
 *     in its own words, and it SURVIVES the subscription: "session_x is on the
 *     lap cap" stays true after the wake that removed the subscription. It is
 *     also the only source that can name a session nobody else would list.
 *   · THE UNSETTLED RAIL is what the PERSON has open, which is the half the
 *     Agent's own bookkeeping cannot know: a session they started themselves,
 *     this morning, is in no subscription and in no section the Agent wrote.
 *
 * A union, deduplicated by id. Each source alone answers a different question;
 * "how are things" is all three.
 *
 * ── AND WHY IT IS BOUNDED TWICE ─────────────────────────────────────────────
 * `limit` rows AND `FLEET_MAX_CHARS` of answer, whichever comes first — the
 * two-number bound `boundedOutline` already argues for one level up. A count
 * alone lets twenty rows of long titles through; a byte budget alone would
 * happily return sixty tiny ones. What is left out is COUNTED and the count is
 * in the answer, because a list that silently looked complete is how a model
 * reports a third of the fleet as all of it.
 */
export type AgentFleetCapability = {
  /** The unsettled rail — the list the PERSON has open — and the project names
   *  its rows point at. Settled sessions are deliberately not in it: the shelf
   *  is the person's own "I am done looking at this". */
  rail(): Promise<{ sessions: FleetSessionRow[]; projects: Array<{ id: string; name: string }> }>;
  /** The session ids this Agent asked to be woken by. */
  subscribed(): Promise<string[]>;
  /** The standing state's "who is on what" section, verbatim — the ids are read
   *  out of its prose, because that is the shape the Agent writes it in. */
  who(): string | undefined;
  /** One session, for an id that came from a subscription or from `who` and was
   *  not on the rail. `undefined` when it no longer exists, which is ordinary:
   *  the Agent's own notes outlive the sessions they name. */
  session(sessionId: string): Promise<FleetSessionRow | undefined>;
  /** The newest turn, as the outline already folds one. */
  lastTurn(sessionId: string): Promise<{ state: string; endedAt?: number; answer: string } | undefined>;
  /** How many requests that session has OPEN — the number, not the requests. */
  openRequests(sessionId: string): Promise<number>;
  /** Unread inbox rows per session id. The Agent's OWN news — what it has not
   *  been shown yet — rather than anything the store knows about. */
  unread(): Record<string, number>;
  /**
   * WHEN THE AGENT'S PREVIOUS TURN BEGAN — the boundary "recently" means (#592).
   *
   * A CONDITION WITH MEANING RATHER THAN A CLOCK. "Moved in the last hour" is a
   * number somebody picked; "moved since I last looked at this" is the actual
   * question a status row's prose answers, and it tracks a conversation that ran
   * all morning as honestly as one that resumed after lunch. A session untouched
   * since this conversation's previous turn is staleness and nothing else.
   *
   * `undefined` ON THE FIRST TURN OF A THREAD, where there is no previous turn
   * and therefore nothing the Agent has already reported on — see the caller for
   * what that falls back to.
   */
  since(): number | undefined;
};

export type FleetSessionRow = { id: string; title?: string; projectId?: string; activity: string; updatedAt?: number };

/** Twenty sessions is the rail on a busy machine, and the ceiling the issue
 *  names. A caller asking for more is served twenty and told so. */
const FLEET_LIMIT_DEFAULT = 20;
const FLEET_LIMIT_MAX = 20;

/**
 * THE ANSWER'S OWN CEILING — `OUTLINE_PAGE_BYTES`' number, for its reason. This
 * lands in a model's context beside the rest of its work, and the whole point of
 * the tool is that it costs ONE call rather than sixteen; a 20 KB answer would
 * have moved the cost rather than removed it.
 */
const FLEET_MAX_CHARS = 6_000;

/**
 * WHAT ONE ROW QUOTES OF THE LAST ANSWER, AND WHICH ROWS GET TO (#592).
 *
 * ── IT WAS MOST OF THE ANSWER'S BYTES AND NEARLY ALL OF ITS STALENESS ───────
 * Measured: 6,628 characters for thirteen sessions, and a 200-character prose
 * excerpt per row was the bulk of it — carried for long-idle sessions in other
 * projects as readily as for the one that had just finished. "How are things"
 * needs title, activity, open requests and whether a turn is running; the prose
 * is what made the answer expensive, and an excerpt of a turn that ended two
 * days ago is not news.
 *
 * ── BUT NOT DROPPED, BECAUSE ONE ROW EARNS IT ───────────────────────────────
 * The session that JUST finished is exactly the one the Agent is about to report
 * on. Remove its line and the Agent buys the bytes straight back with a
 * `sessions_answer` call, which moves the waste rather than removing it. So:
 * clamped hard, and only where it is still news.
 *
 *   · CLAMPED to the notebook's own preview length, which is the identical
 *     judgment about different prose — enough to recognise which turn it was,
 *     not enough to work from. Deliberately not a second number for one idea.
 *   · KEPT only for a session that is WORKING (its answer is the last thing it
 *     said before the turn now running) or whose last turn ended AFTER the
 *     Agent's previous turn began — news since the Agent last looked.
 */
const FLEET_ANSWER_CHARS = PREVIEW_CHARS;

/**
 * A SESSION ID AS THE AGENT WRITES ONE INTO ITS NOTES.
 *
 * THE `session_` PREFIX IS THE WHOLE GUARD, and it is enough: a `who` section is
 * prose, and prose does not contain that token unless it is naming a session. A
 * minimum length was tried and removed — it silently dropped short ids, which
 * made "the notes source works" depend on how long the id happened to be.
 *
 * NOTHING IS TRUSTED FROM IT. An id read out of the Agent's own prose is looked
 * up like any other, and one that no longer resolves drops out of the answer.
 */
const SESSION_ID = /\bsession_[A-Za-z0-9_-]+\b/g;

/**
 * IT OPENED BY ANSWERING THE QUESTION IT SHOULD NOW DECLINE (#601).
 *
 * "How are things across every session you are on" is the phrase a check-in uses,
 * and a description that opens with it is an invitation: the model matching
 * "¿cómo vamos?" against twenty-five tools found its own question quoted back.
 * Measured over 119 turns, this became a per-turn ritual — fired identically for
 * a real status question and for "¿Estás ahí?", at ~6,600 characters a call.
 *
 * SO IT LEADS WITH WHAT IT IS INSTEAD OF WHAT IT ANSWERS. "Live state" is the
 * thing this tool uniquely has: `renderDigest` reports TRANSITIONS, so a session
 * WORKING right now has no row in the digest and only this call knows about it.
 * That is the gap, and naming the gap is what routes a question here correctly
 * rather than reflexively.
 *
 * AND ONE CLAUSE FORBIDS THE MEASURED WASTE. "NOT to confirm the digest" is the
 * whole of #601 as it applies at the moment of choosing this call — the briefing
 * carries the general rule ("read only for what they cannot carry") and this
 * carries the specific one, where a model reads it while deciding.
 *
 * #570'S FINDING IS UNTOUCHED, in its own words: the day a status question DOES
 * need a look, ONE call is still the difference between this and sixteen
 * `sessions_*` reads assembled by hand.
 *
 * PAID FOR WITHIN `agent-tools.test.ts`'S 14,000-CHARACTER CEILING, which the
 * bound array was within 27 characters of — every lap of every turn resends it,
 * so the opening phrase shortening from "How are things across" to "Live state
 * for" is what bought the new clause. The ceiling was not raised.
 */
const FLEET_STATUS =
  "Live state for every session you are on — subscriptions, the ones your notes name, and the person's open rail — one bounded row each. " +
  "NOT to confirm the digest. ONE call answers 'how is it going'; sessions_answer is for one turn's words.";

type FleetRow = {
  id: string;
  title?: string;
  projectName?: string;
  activity: string;
  lastTurn?: { state: string; endedAt?: number };
  lastAnswer?: string;
  openRequests: number;
  unreadInbox: number;
  /** Which of the three lists put this row here, so a reader can tell work it
   *  assigned from work it merely has open. */
  sources: string[];
};

/**
 * WAITING ON A PERSON FIRST, THEN RUNNING, THEN MOST RECENTLY ENDED.
 *
 * THE RANKING IS THE ARGUMENT, and it is `renderDigest`'s: a parked request is
 * the only band a person can act on, and a status answer that led with six idle
 * sessions while one sat blocked would bury the single row that mattered. A
 * session is "waiting" if it has an open request OR the engine calls it
 * `blocked` — the two are the same fact seen from either end, and either alone
 * would miss a case.
 */
function band(row: FleetRow): number {
  if (row.openRequests > 0 || row.activity === "blocked") return 0;
  if (row.activity === "working" || row.activity === "queued") return 1;
  return 2;
}

export function agentFleetTools(tool: ToolFactory, capability: AgentFleetCapability): unknown[] {
  return [
    tool(
      "fleet_status",
      FLEET_STATUS,
      {
        limit: z.number().int().min(1).max(FLEET_LIMIT_MAX).optional().describe(`Default ${FLEET_LIMIT_DEFAULT}, which is also the most it will return.`),
      },
      async (args) => {
        const limit = clamp(args.limit, FLEET_LIMIT_DEFAULT, FLEET_LIMIT_MAX);
        try {
          /**
           * THE THREE SOURCES, READ TOGETHER. They do not depend on each other,
           * and this tool exists to cost one round trip — running them in
           * sequence here would be the very thing it was built to stop the model
           * doing one level up.
           */
          const [rail, subscribed] = await Promise.all([capability.rail(), capability.subscribed()]);
          const named = [...new Set((capability.who() ?? "").match(SESSION_ID) ?? [])];

          const sources = new Map<string, Set<string>>();
          const note = (id: string, source: string) => sources.set(id, (sources.get(id) ?? new Set()).add(source));
          for (const session of rail.sessions) note(session.id, "rail");
          for (const id of subscribed) note(id, "subscribed");
          for (const id of named) note(id, "notes");

          const known = new Map(rail.sessions.map((session) => [session.id, session]));
          const projects = new Map(rail.projects.map((project) => [project.id, project.name]));
          const unread = capability.unread();
          /**
           * NO PREVIOUS TURN MEANS EVERYTHING IS NEWS, and that is the honest
           * reading rather than a convenient one: on the first turn of a
           * conversation the Agent has reported on nothing, so nothing it can
           * see is something the person has already been told. It is one turn
           * per thread, and the hard clamp applies to those rows all the same.
           */
          const since = capability.since() ?? 0;

          /**
           * ONE ROW EACH, ALL AT ONCE. A session named only in the notes costs
           * one extra read; twenty of them in sequence would cost twenty round
           * trips, which is the sixteen-lap turn again with the laps hidden
           * inside one call.
           */
          const rows = (
            await Promise.all(
              [...sources.keys()].map(async (id): Promise<FleetRow | undefined> => {
                const session = known.get(id) ?? (await capability.session(id));
                // A NOTE OUTLIVES THE SESSION IT NAMES, and that is ordinary
                // rather than an error: the row is dropped and the count says
                // how many were.
                if (!session) return undefined;
                const [lastTurn, openRequests] = await Promise.all([capability.lastTurn(id), capability.openRequests(id)]);
                // NEWS, OR NOTHING. A turn still running has no `endedAt`, and
                // its last answer is the last thing that session said before the
                // work now in flight — which is news by definition.
                const news = session.activity === "working" || (lastTurn !== undefined && (lastTurn.endedAt ?? Number.MAX_SAFE_INTEGER) >= since);
                return {
                  id,
                  ...(session.title ? { title: session.title } : {}),
                  ...(session.projectId && projects.get(session.projectId) ? { projectName: projects.get(session.projectId)! } : {}),
                  activity: session.activity,
                  ...(lastTurn ? { lastTurn: { state: lastTurn.state, ...(lastTurn.endedAt === undefined ? {} : { endedAt: lastTurn.endedAt }) } } : {}),
                  ...(news && lastTurn?.answer ? { lastAnswer: head(lastTurn.answer, FLEET_ANSWER_CHARS) } : {}),
                  openRequests,
                  unreadInbox: unread[id] ?? 0,
                  sources: [...(sources.get(id) ?? [])].sort(),
                };
              }),
            )
          ).filter((row): row is FleetRow => row !== undefined);

          rows.sort((left, right) => {
            const bands = band(left) - band(right);
            if (bands !== 0) return bands;
            // Most recently ended first inside a band. A turn still running has
            // no `endedAt`; it sorts to the top of its band, which is where a
            // reader looking for "what is happening now" wants it.
            return (right.lastTurn?.endedAt ?? Number.MAX_SAFE_INTEGER) - (left.lastTurn?.endedAt ?? Number.MAX_SAFE_INTEGER);
          });

          // BOUNDED TWICE, and the first row always fits — `boundedOutline`'s
          // own rule, so one enormous title cannot return an empty list.
          const shown: FleetRow[] = [];
          let chars = 0;
          for (const row of rows) {
            if (shown.length >= limit) break;
            chars += JSON.stringify(row).length + 1;
            if (chars > FLEET_MAX_CHARS && shown.length > 0) break;
            shown.push(row);
          }

          const left = rows.length - shown.length;
          return json({
            sessions: shown,
            total: rows.length,
            ...(left > 0
              ? { note: `${left} more session${left === 1 ? "" : "s"} not shown. sessions_list for the rest, sessions_answer for one turn's words.` }
              : {}),
          });
        } catch (error) {
          return err(`Could not read the fleet: ${failure(error)}`);
        }
      },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * The Agent's own memory — #541 part F.
 * ------------------------------------------------------------------ */

/**
 * The two verbs the Agent has about ITSELF, as a capability for the same reason
 * every other one here is: the runtime owns the document and the transcript,
 * and a test drives these two with two functions and no graph.
 */
export type AgentMemoryCapability = {
  /** Replace one section of the standing document. Empty text clears it. */
  remember(section: StandingSection, text: string): { sections: Partial<Record<StandingSection, string>> };
  /** Search this thread's own rows. */
  recall(query: string, limit: number): AgentRecallHit[];
};

const RECALL_LIMIT_DEFAULT = 8;
const RECALL_LIMIT_MAX = 25;

const REMEMBER =
  "Rewrite one section of what you hold across turns. It is always in your prompt and never in the conversation, so it " +
  "survives older turns being folded away. One section at a time — the other three are untouched. Empty text clears a section.";

const RECALL =
  "Search THIS conversation's own history — what you and the person said, and what your tools answered — including turns " +
  "already folded out of your prompt. Newest first, each hit quoting the line that matched.";

export function agentMemoryTools(tool: ToolFactory, capability: AgentMemoryCapability): unknown[] {
  return [
    tool(
      "remember",
      REMEMBER,
      {
        section: z
          .enum(STANDING_SECTION_KEYS as [StandingSection, ...StandingSection[]])
          .describe("doing: what you are working on. who: which session is on what. questions: what you are waiting to hear. preferences: how this person wants to be worked with."),
        text: z.string().describe(`The section's whole new text — it REPLACES what was there. Clipped at ${SECTION_CHARS} characters.`),
      },
      async (args) => {
        try {
          const state = capability.remember(args.section as StandingSection, typeof args.text === "string" ? args.text : "");
          return json({ sections: state.sections, note: "Rewritten. It is in your prompt from the next lap onwards." });
        } catch (error) {
          return err(`Could not remember that: ${failure(error)}`);
        }
      },
    ),
    tool(
      "recall",
      RECALL,
      {
        q: z.string().min(1).describe("Lexical, not semantic — the phrase you remember seeing."),
        limit: z.number().int().min(1).max(RECALL_LIMIT_MAX).optional().describe(`Default ${RECALL_LIMIT_DEFAULT}.`),
      },
      async (args) => {
        try {
          const hits = capability.recall(String(args.q ?? ""), clamp(args.limit, RECALL_LIMIT_DEFAULT, RECALL_LIMIT_MAX));
          return json({
            hits,
            ...(hits.length === 0 ? { note: "Nothing in this conversation matched. It is lexical — try the words you actually used." } : {}),
          });
        } catch (error) {
          return err(`Could not recall that: ${failure(error)}`);
        }
      },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * The one fact that is not a session — #541's owner decision 4.
 * ------------------------------------------------------------------ */

/**
 * ONE ISSUE OR ONE PULL REQUEST, READ THROUGH `gh`.
 *
 * WHY THE AGENT HAS THIS AND NOTHING ELSE OUTSIDE TELAR. Every other fact a
 * coordinator needs is a session's, and the sessions wall answers it. GitHub is
 * the exception the owner named: "is #541 still open", "did the checks pass on
 * that PR" and "what did the last comment say" come up constantly, the answer
 * lives nowhere in this engine, and the alternative is the Agent assigning a
 * session a turn to go and look.
 *
 * READ-ONLY, AND STRUCTURALLY SO. There is no merge here, no comment, no close
 * — the capability has two methods and both are reads, so "the Agent merged my
 * PR" is not a thing that can happen through a prompt. Merging stays where
 * `projectPullMerge` put it: behind a person pressing a button that names the
 * head commit they reviewed.
 */
export type AgentGitHubCapability = {
  issue(projectId: string, number: number): Promise<GitHubIssueRead>;
  pull(projectId: string, number: number): Promise<GitHubPullRead>;
  /** Registered projects, so a number with no project named can resolve when
   *  there is only one it could mean. */
  projects(): Promise<Array<{ id: string; name: string }>>;
};

/** How much of the last comment rides along — `ANSWER_HEAD_CHARS`'s own number,
 *  for its own reason: enough to know what was said, not enough to be a thread. */
const COMMENT_HEAD_CHARS = 300;

/** How many failing checks are named before the answer starts counting. A
 *  person asks "what is red", and the first few are the answer. */
const FAILING_CHECKS = 5;

const GITHUB_STATUS =
  "One GitHub issue or pull request by number: state, title, and for a PR its checks, mergeable state and review " +
  "decision, plus the head of the last comment. Read-only — nothing here comments, closes or merges.";

export function agentGitHubTools(tool: ToolFactory, capability: AgentGitHubCapability): unknown[] {
  return [
    tool(
      "github_status",
      GITHUB_STATUS,
      {
        number: z.number().int().min(1).describe("The issue or pull request number."),
        kind: z.enum(["issue", "pull"]).optional().describe("Omit to try the pull request first and fall back to the issue."),
        projectId: z.string().min(1).optional().describe("Whose repository. Omit only when this engine has one project."),
      },
      async (args) => {
        const number = typeof args.number === "number" ? args.number : 0;
        let projectId: string;
        try {
          projectId = await resolveGitHubProject(capability, args.projectId);
        } catch (error) {
          return err(failure(error));
        }
        const kind = args.kind === "issue" || args.kind === "pull" ? args.kind : undefined;
        try {
          if (kind !== "issue") {
            const asPull = await capability.pull(projectId, number);
            if ("pull" in asPull) return json(pullStatus(asPull.pull));
            // NOT FOUND AS A PULL REQUEST IS NOT AN ERROR WHEN NO KIND WAS
            // NAMED: GitHub numbers issues and pull requests from one sequence,
            // so the same number is one or the other and asking is how you find
            // out. Any OTHER failure — not signed in, not a repository — is
            // about the machine and is reported rather than retried as an issue.
            if (kind === "pull" || asPull.unavailable !== "not_found") return err(unavailableSentence(asPull, number, "pull request"));
          }
          const asIssue = await capability.issue(projectId, number);
          if ("issue" in asIssue) return json(issueStatus(asIssue.issue));
          return err(unavailableSentence(asIssue, number, "issue"));
        } catch (error) {
          return err(`Could not read #${number}: ${failure(error)}`);
        }
      },
    ),
  ];
}

/** The project a number means: the one it named, else the only one there is.
 *  The refusal names the alternatives rather than saying "ambiguous". */
async function resolveGitHubProject(capability: AgentGitHubCapability, named: unknown): Promise<string> {
  if (typeof named === "string" && named.trim()) return named.trim();
  const projects = await capability.projects();
  if (projects.length === 1) return projects[0]!.id;
  if (projects.length === 0) throw new Error("This engine has no projects, so there is no repository to ask GitHub about.");
  throw new Error(
    `Name the project whose repository this number is in — there are ${projects.length}: ${projects.map((project) => `${project.name} (${project.id})`).join(", ")}.`,
  );
}

/** `gh`'s four reasons, as sentences a model can act on rather than a code. */
function unavailableSentence(failed: { unavailable: string; message?: string }, number: number, what: string): string {
  const because =
    failed.unavailable === "not_found"
      ? `there is no ${what} #${number} in that repository`
      : failed.unavailable === "not_installed"
        ? "the gh CLI is not installed on this machine"
        : failed.unavailable === "not_authenticated"
          ? "nobody is signed in to gh on this machine"
          : failed.unavailable === "not_a_repository"
            ? "that project is not a GitHub repository"
            : failed.message || "gh could not answer";
  return `Could not read #${number}: ${because}.`;
}

/** The last thing anybody said, clamped. Minimised comments are skipped — a
 *  comment GitHub hid is not the state of the conversation. */
function lastComment(comments: ReadonlyArray<{ author?: string; body: string; createdAt: number; minimized: boolean }>, older: number) {
  const visible = comments.filter((comment) => !comment.minimized);
  const last = visible.at(-1);
  if (!last) return {};
  return {
    lastComment: { ...(last.author ? { by: last.author } : {}), at: last.createdAt, head: head(last.body, COMMENT_HEAD_CHARS) },
    comments: visible.length + older,
  };
}

function issueStatus(issue: GitHubIssueDetail) {
  return {
    kind: "issue" as const,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    ...(issue.stateReason ? { stateReason: issue.stateReason } : {}),
    ...(issue.author ? { author: issue.author } : {}),
    // LABELS BY NAME. The stored row carries a colour beside each, which is a
    // thing a panel draws and a model has no use for.
    ...(issue.labels.length > 0 ? { labels: issue.labels.map((label) => label.name) } : {}),
    ...(issue.assignees.length > 0 ? { assignees: issue.assignees } : {}),
    url: issue.url,
    updatedAt: issue.updatedAt,
    ...lastComment(issue.comments, issue.olderComments),
  };
}

function pullStatus(pull: GitHubPullDetail) {
  const failing = pull.checks.filter((check) => check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion));
  const running = pull.checks.filter((check) => check.status !== "COMPLETED");
  return {
    kind: "pull" as const,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    ...(pull.isDraft ? { draft: true } : {}),
    ...(pull.author ? { author: pull.author } : {}),
    ...(pull.headRefName ? { head: pull.headRefName } : {}),
    ...(pull.baseRefName ? { base: pull.baseRefName } : {}),
    // GITHUB'S OWN WORDS, UNMAPPED — `GitHubPullDetail` argues it, and the two
    // fields are different questions: do the trees combine, and will GitHub let
    // you. UNKNOWN means ask again, not no.
    mergeable: pull.mergeable,
    mergeState: pull.mergeStateStatus,
    ...(pull.reviewDecision ? { review: pull.reviewDecision } : {}),
    checks:
      pull.checks.length === 0
        ? "none ran"
        : {
            total: pull.checks.length,
            ...(running.length > 0 ? { running: running.length } : {}),
            ...(failing.length > 0
              ? { failing: failing.slice(0, FAILING_CHECKS).map((check) => check.name), ...(failing.length > FAILING_CHECKS ? { moreFailing: failing.length - FAILING_CHECKS } : {}) }
              : {}),
            ...(failing.length === 0 && running.length === 0 ? { green: true } : {}),
          },
    changed: { files: pull.changedFiles, additions: pull.additions, deletions: pull.deletions },
    url: pull.url,
    updatedAt: pull.updatedAt,
    ...lastComment(pull.comments, pull.olderComments),
  };
}

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

export type AgentWalls = {
  sessions: SessionsCapability;
  notes: NotesCapability;
  query: AgentQueryCapability;
  /** "How are things" in one call (#570). Absent in a test that is only asking
   *  what the two shared walls hold. */
  fleet?: AgentFleetCapability;
  /** The Agent's own standing state and history search. Absent in a test that
   *  is only asking what the two shared walls hold. */
  memory?: AgentMemoryCapability;
  /** The one read that is not about a Telar session — #541's owner decision 4. */
  github?: AgentGitHubCapability;
};

/**
 * The Agent's whole tool list: 13 sessions tools, 3 query tools, the fleet read,
 * 5 notes tools, one GitHub read, and the two it has about itself.
 *
 * SESSIONS FIRST, then the queries beside them, then the notebook — the order a
 * model is shown them in, and it is deliberate: the sessions wall is what the
 * Agent is FOR, and a read that narrows the rail belongs next to the one that
 * lists it. Its own memory is last, because it is the only pair that is about
 * the Agent rather than about Telar's work.
 *
 * `fleet_status` SITS WITH THE QUERIES, immediately after them, because it is
 * the widest of the same family: `sessions_answer` is one turn, `sessions_outline`
 * is one session, and this is all of them. A model choosing among four reads
 * reads them in that order and picks the one whose scope matches its question,
 * which is exactly the choice #570 is about.
 */
export function collectAgentTools(walls: AgentWalls): SocketTool[] {
  return [
    ...collectTools(sessionsTools as never, walls.sessions as never),
    ...collectTools(agentQueryTools as never, walls.query as never),
    ...(walls.fleet ? collectTools(agentFleetTools as never, walls.fleet as never) : []),
    ...collectTools(notesTools as never, walls.notes as never),
    ...(walls.github ? collectTools(agentGitHubTools as never, walls.github as never) : []),
    ...(walls.memory ? collectTools(agentMemoryTools as never, walls.memory as never) : []),
  ];
}

/* ------------------------------------------------------------------ *
 * The wall a SPOKEN turn is bound to — #603 lever 2.
 * ------------------------------------------------------------------ */

/**
 * WHICH TOOLS A SPOKEN TURN IS GIVEN, AND WHY IT IS A SHORTER LIST.
 *
 * ── THE ARITHMETIC THAT MAKES THIS THE FIRST LEVER ──────────────────────────
 * Tool definitions are the one part of the prompt that is resent WHOLE on every
 * lap — the history compacts, the system block is one copy, and this array is
 * not either of those. Measured on the 25 tools the Agent binds: 13,993 bytes,
 * ×2.55 laps on the median brief turn, on every spoken turn of every day. The
 * nine below are 5,514. Nothing else on a brief turn is worth 8,479 bytes a lap.
 *
 * ── THE RULE, AND IT IS ONE SENTENCE ────────────────────────────────────────
 * A SPOKEN TURN ANSWERS. It does not page a document and it does not tidy the
 * rail. So what survives is the reads whose answer can be SAID — a fleet line,
 * a session's state, what one turn concluded, what is waiting on a person, an
 * issue's state — plus the three things a spoken sentence can actually be: hand
 * work to a session, start one, and keep something in mind.
 *
 * What that rule removes, and each one is removed for its own reason:
 *
 *   · `sessions_read`, `sessions_outline`, `sessions_diff`, the notebook's four
 *     — THEY PAGE. A journal read aloud is not an answer, and the payload is
 *     paid for again on every remaining lap of the turn. `sessions_answer` is
 *     the same question at speakable size and it stays.
 *   · `sessions_stop`, `sessions_settle`, `sessions_subscribe`,
 *     `sessions_unsubscribe`, `sessions_resolve_request`, `notes_delete` — THEY
 *     TIDY THE RAIL. Housekeeping is a thing a person does looking at the list,
 *     and five of the six are irreversible enough that hearing about them
 *     afterwards is the wrong order.
 *   · `sessions_list` and `recall` — A SECOND WAY TO DO SOMETHING ALREADY HERE.
 *     The briefing already says to call `fleet_status` once for "how are
 *     things", and `recall` searches a history the prompt is already carrying.
 *
 * ── IT FAILS TOWARDS WITHHELD ───────────────────────────────────────────────
 * A name this table has never heard of is NOT on the spoken wall, and that is
 * the safe direction: a new tool nobody classified costs a spoken turn one
 * honest refusal, where the other direction would silently put bytes back on
 * every lap. `agent-tools.test.ts` pins that every tool the Agent is given has
 * an entry, so the backstop is a backstop rather than the normal case.
 *
 * ── AND ABSENCE IS NEVER SILENT ─────────────────────────────────────────────
 * A withheld tool is withheld from the BINDING only. It is still on the wall the
 * runtime dispatches against, and `withheldFromSpokenTurn` is what a call to one
 * answers with — see `runtime.ts`'s tools node, where that check sits ABOVE the
 * effect ledger precisely so a `sessions_create` that landed on an earlier typed
 * turn cannot be replayed into a spoken turn as something this turn did.
 */
const SPOKEN_WALL: Readonly<Record<string, "spoken" | "withheld">> = {
  // The reads whose answer can be said out loud.
  fleet_status: "spoken",
  sessions_find: "spoken",
  sessions_answer: "spoken",
  sessions_status: "spoken",
  sessions_requests: "spoken",
  github_status: "spoken",
  // The three things a spoken sentence can be.
  sessions_send: "spoken",
  sessions_create: "spoken",
  remember: "spoken",
  // They page.
  sessions_read: "withheld",
  sessions_outline: "withheld",
  sessions_diff: "withheld",
  notes_projects: "withheld",
  notes_list: "withheld",
  notes_read: "withheld",
  notes_write: "withheld",
  // They tidy the rail.
  sessions_stop: "withheld",
  sessions_settle: "withheld",
  sessions_subscribe: "withheld",
  sessions_unsubscribe: "withheld",
  sessions_subscriptions: "withheld",
  sessions_resolve_request: "withheld",
  notes_delete: "withheld",
  // A second way to do something already here.
  sessions_list: "withheld",
  recall: "withheld",
};

/** Is this tool bound on a turn that will be spoken aloud? Unknown names are
 *  not — see `SPOKEN_WALL` for why that is the safe direction. */
export function onSpokenWall(name: string): boolean {
  return SPOKEN_WALL[name] === "spoken";
}

/** Every tool the table has been taught, so a test can hold it against the list
 *  the Agent is actually given rather than against itself. */
export function spokenWallTable(): Readonly<Record<string, "spoken" | "withheld">> {
  return SPOKEN_WALL;
}

/**
 * WHAT A WITHHELD TOOL ANSWERS WITH, IF THE MODEL REACHES FOR IT ANYWAY.
 *
 * THE FAILURE THIS EXISTS TO PREVENT is not the cost, it is the claim: a call
 * that returned nothing, or a stale ledger entry, lets the Agent say "done" in
 * the one sentence the person hears and then walk away. So the answer opens
 * with what did NOT happen, and closes by telling the model to say so.
 *
 * IT NAMES THE MAC because "you cannot do that" with no second half is an answer
 * a person cannot act on. The tool exists; it is this turn that cannot reach it.
 */
export function withheldFromSpokenTurn(name: string): string {
  return `NOTHING HAPPENED: ${name} is not available on a spoken turn, and no part of it ran. Tell the person, in one sentence, that this one needs the cockpit on the Mac.`;
}

/**
 * ONE FUNCTION DEFINITION PER TOOL, AS THE MODEL IS BOUND TO THEM.
 *
 * ── WHAT IS DROPPED, AND WHY ONLY HERE (#563) ───────────────────────────────
 * `z.toJSONSchema` writes for a VALIDATOR. Three of the things it writes mean
 * nothing to a language model and are resent on every lap of every turn:
 *
 *   · `"$schema": "https://json-schema.org/draft/2020-12/schema"` — 56
 *     characters naming a dialect version nobody here is checking, ×21 tools.
 *   · `"maximum": 9007199254740991` — what `z.number().int()` emits, which is
 *     "an integer" said in 26 characters.
 *   · `"minLength": 1` and `"propertyNames"` — a required string is required
 *     and a record's keys are strings.
 *
 * THE MCP SOCKET KEEPS ALL OF IT. `tools/list` answers programs that may well
 * validate, `toolInputSchema` is what that route serves, and one lap of one
 * Agent turn is not a reason to narrow a wire format other software reads. This
 * is the Agent's own binding, so the narrowing lives in it.
 *
 * NOTHING THE MODEL CHOOSES FROM IS TOUCHED: names, types, enums, real bounds
 * and `required` all go through exactly as they were.
 *
 * ── AND ON A SPOKEN TURN IT IS ALSO SHORTER (#603) ──────────────────────────
 * `spoken` narrows the LIST rather than the shape — see `SPOKEN_WALL`. It is a
 * property of the one request, so it is an argument here and not a field on the
 * wall: the same `SocketTool[]` is bound wide on a typed turn and narrow on a
 * spoken one, in the same process, seconds apart.
 */
export function agentToolSpecs(
  tools: readonly SocketTool[],
  options?: { spoken?: boolean },
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return (options?.spoken ? tools.filter((tool) => onSpokenWall(tool.name)) : tools).map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: forModel(toolInputSchema(tool.shape)) as Record<string, unknown> },
  }));
}

/** The validator's bookkeeping removed, everything a model reads kept. */
function forModel(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forModel);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema" || key === "minLength" || key === "propertyNames") continue;
    // A safe-integer bound is zod saying "whole number", not a limit anybody set.
    if ((key === "maximum" || key === "minimum") && typeof value === "number" && Math.abs(value) === Number.MAX_SAFE_INTEGER) continue;
    out[key] = forModel(value);
  }
  return out;
}
