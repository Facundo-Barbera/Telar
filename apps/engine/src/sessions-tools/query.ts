/**
 * ASKING A CONVERSATION A QUESTION, RATHER THAN PAGING IT — issue #516.
 *
 * ── WHY THIS IS A FILE OF ITS OWN, BESIDE `tools.ts` ────────────────────────
 * The fourteen tools next door are VERBS about a session: create it, send to
 * it, stop it, shelve it. These six are QUESTIONS about one: which conversation
 * was this, what were its turns, what did that turn conclude, what did step
 * twelve do, where did it mention `index.lock`. They share the wall — a session
 * asking a peer a question is the same door as a session steering one — and
 * they share nothing else: every one is read-only, every one answers from the
 * `turn_summary` projection or one indexed span, and NONE of them folds the
 * journal (except `grep`, which is a question about event text and says so).
 *
 * They are therefore a separate CAPABILITY too. `SessionsCapability`'s members
 * mirror `EngineStore` verbs one for one; these mirror the five query ROUTES,
 * which is what lets the out-of-process worker build them out of `EngineClient`
 * calls while the daemon builds them out of `store.*` calls — the parity
 * `tools.ts`'s header argues for, held by one port rather than by two lists
 * somebody keeps in step.
 */
import { z } from "zod";
import type { Item } from "@telar/engine-client";
import { clampLimit, err, failure, fillWithin, json, type ToolFactory } from "../tool-kit";
import { TURN_ANSWER_NONE, TURN_ANSWER_NO_SUCH_RUN } from "../turn-summary";

/**
 * ONE RUN'S STEP, AS A ROW TO CHOOSE FROM.
 *
 * `bytes` IS THE POINT OF THE LIST. An agent picking a step to read should know
 * what it is about to spend BEFORE it spends it; without the number the only
 * way to find the big item is to fetch all of them, which is the cost this
 * exists to avoid.
 */
export type StepRow = { index: number; id: string; title: string; status: Item["status"]; bytes: number };

/** One step, whole — up to the read budget, with the marker that says how much
 *  was left behind. `text` is the step's `detail`, which is everything it
 *  actually SAID; the scalars beside it are how a reader identifies it. */
export type StepRead = {
  index: number;
  id: string;
  title: string;
  status: Item["status"];
  startedAt: number;
  completedAt?: number;
  taskId?: string;
  text: string;
  totalChars: number;
  more: boolean;
};

/**
 * ONE FIELD OF AN OUTLINE ROW, AND THE REST IS THE STORE'S.
 *
 * The row shape is `turn-summary.ts`'s `OutlineRow` and it is the STORE's to
 * decide; a second declaration of it here would be a shape this wall could
 * drift from without anything noticing. What the wall genuinely needs is the
 * CURSOR — `sequence` — because it re-bounds the page by delivered bytes and a
 * page it trimmed has a different "next" from the one the store handed over.
 * Everything else rides through untouched.
 */
export type OutlineTurn = { sequence: number } & Record<string, unknown>;

/**
 * The five query routes as a capability — the seam every other wall in this
 * engine uses, so a test drives these six tools with six functions and no
 * daemon, and the two deployments answer identically because they satisfy one
 * type rather than one convention.
 */
export type SessionsQueryCapability = {
  find(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit: number }): Promise<{
    sessions: Array<{ id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>;
    index: string;
    more: boolean;
  }>;
  outline(sessionId: string, window: { limit: number; before?: number }): Promise<{ turns: OutlineTurn[]; total: number; more: boolean; next?: number }>;
  answer(sessionId: string, options: { runId?: string; from: number; limit: number }): Promise<{
    runId: string;
    sequence: number;
    text: string;
    from: number;
    totalChars: number;
    more: boolean;
    next?: number;
  }>;
  /** Every step of one run, in the order they started. Unbounded at this seam
   *  and bounded by the wall: the route hands over the whole list because a
   *  cockpit renders it, and a model cannot hold 400 rows. */
  steps(sessionId: string, runId: string): Promise<{ items: StepRow[] }>;
  /** One step by position, or by the item id a journal page already named. */
  step(sessionId: string, runId: string, step: number | string, maxChars: number): Promise<StepRead>;
  grep(sessionId: string, pattern: string, window: { limit: number; before?: number }): Promise<{
    matches: Array<{ id: number; at: number; type: string; runId?: string; context: string }>;
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
const GREP_PAGE_DEFAULT = 20;
const GREP_PAGE_MAX = 100;
const ITEM_CHARS_DEFAULT = 8_000;
const ITEM_CHARS_MAX = 64_000;

/**
 * WHAT A LIST MAY COST WHEN THE ROUTE'S OWN CEILING IS A COUNT.
 *
 * Three of these answers are bounded by rows at the route and by NOTHING by
 * bytes: 50 `find` hits each quoting a 200-character line, 100 `grep` matches
 * each carrying 200 characters of context, and a run's whole step list — which
 * on the dogfood store reaches 400 rows. Each of the three lands past the
 * toolkit's 16,000-character backstop at its maximum, and the backstop CLIPS:
 * the caller gets JSON with its tail cut off rather than a short list.
 *
 * So each fills to a byte budget as well, states its total, and hands back the
 * cursor — the two-number bound `pageEvents` already argues for next door. The
 * numbers are small because these answers are read to DECIDE something: which
 * session, which step, which event, and a decision is made from the first
 * screen of a list or not at all.
 */
const FIND_CHARS = 8_000;
const GREP_CHARS = 10_000;

/**
 * THE ONE BUDGET #516 STATES AS A NUMBER, MEASURED WHERE IT IS SPENT.
 *
 * ── THE ACCEPTANCE BULLET IS ABOUT THE TOOL, AND THE TOOL WAS OVER ──────────
 * "Under 6 KB per page" is what the issue asks of `sessions_outline`.
 * `OUTLINE_PAGE_BYTES` already holds the STORE's page at 6,000 — measured on a
 * 300-session / 60,000-event engine at 5,918 B leaving the store — and the same
 * page reached a caller at 7,048 B. The gap is not a leak: `json()` pretty-
 * prints at two spaces, deliberately and on every wall, and that is about 19%
 * on a shape this key-dense.
 *
 * ── SO THE BOUND IS APPLIED AGAIN HERE, IN THE UNITS THAT ARE DELIVERED ─────
 * `fillWithin` measures rows exactly as `json()` will write them, so this is a
 * ceiling on the answer rather than on something 19% smaller than the answer.
 * The store's number is left alone: the route has other callers (the web
 * transcript is named in the issue), it already meets its own budget, and
 * shrinking a shared page to fix one consumer's serialisation would put this
 * tool's accounting two files away from the `json()` call that causes it.
 *
 * THE HEADROOM IS THE ENVELOPE — `sessionId`, `total`, `more`, `next`, the
 * continuation note, and the per-row indentation `fillWithin` does not see
 * because it measures a row standing alone rather than nested in an array.
 * Measured at 665 characters on a full twenty-row page, so 800 is the working
 * allowance and 5,200 is what is left for the rows.
 */
const OUTLINE_ANSWER_CHARS = 5_200;
const STEPS_LIMIT_DEFAULT = 50;
const STEPS_LIMIT_MAX = 200;
const STEPS_CHARS = 8_000;

/**
 * THE BACKSTOP THESE TWO ANSWERS NEED, RATHER THAN THE TOOLKIT'S DEFAULT (#608).
 *
 * A DEFECT FOUND WHILE MEASURING THE PAGING: `json()` clamps at 16,000 and
 * `sessions_answer` will hand over a 64,000-character slice, so any caller
 * taking the tool at its word got JSON cut off mid-string with a marker
 * appended — text it could still read, but a reply whose `more` and
 * `totalChars` were no longer parseable and whose slices no longer concatenated
 * into the answer.
 *
 * `MAX_RUN_ANSWER_CHARS` in `tools.ts` is the same judgment for the same
 * reason: a slice that is VERBATIM by contract cannot be clipped by a backstop
 * that knows nothing about it. `sessions_step` joins it — its `text` carries
 * the store's own `[… N more characters]` marker, and a second, different
 * truncation layered over that one would make the marker a lie.
 *
 * The budget is the largest slice the tool may legitimately be asked for, plus
 * room for the envelope around it.
 */
const ANSWER_MAX_CHARS = ANSWER_SLICE_MAX + 2_000;
const ITEM_MAX_CHARS = ITEM_CHARS_MAX + 2_000;

const FIND =
  "Which conversation was this — a lexical search over every session, each hit carrying the line that matched. " +
  "The cheap first step before sessions_read.";

const OUTLINE =
  "Scroll a conversation without reading it: one row per turn, newest first — what was asked, what it did, how it ended.";

const ANSWER =
  "What one turn concluded — the answer alone, without its events. Defaults to the latest turn that said something.";

/**
 * THE LIST EXISTS SO A CALLER CAN CHOOSE BEFORE IT PAYS, and the description
 * has to say so or the pair reads as one tool split in two for no reason.
 * `bytes` is the field that makes the choice possible, so it is named.
 */
const STEPS =
  "What one turn DID, as a list to pick from: every step with its title, its state and its BYTE COST. " +
  "Read this before sessions_step — the bytes are what say which step you can afford.";

const STEP =
  "One step of one turn, whole: the call, its input and its output, clamped with a marker saying how much was left. " +
  "Address it by the index sessions_steps gave, or by an item id you already hold.";

const GREP =
  "Where a phrase appears in ONE session's journal, newest first, with the line around each hit. " +
  "Substring, not a regular expression — the words you remember seeing. sessions_find is the same question across sessions.";

/**
 * THE FIRST CALL IS THE WHOLE ANSWER WHERE THE ANSWER FITS (#608).
 *
 * ── THE MEASURED FAILURE IS NOT A DEFAULT THAT IS TOO SMALL ─────────────────
 * The default slice is 8,000 characters and every wasteful read in the log asked
 * for LESS: limits of 2,500, 2,400, 3,000, 4,000. Worst case, 20,273 characters
 * fetched across eight overlapping windows for an answer of 6,127 — and an
 * 883-character answer read five times at 2500/4000/4000/3000/4000, where the
 * limit was never the constraint at all. The model was discovering the size by
 * trial, and a bigger default would not have changed one of those calls.
 *
 * ── SO `limit` IS A CEILING A CALLER MAY RAISE, NOT ONE IT MAY LOWER ────────
 * Anything at or under the default slice is served WHOLE, whatever was asked
 * for. The overrun is bounded by the default itself — a caller asking for 2,500
 * can be handed at most 8,000, which is what it would have got by omitting the
 * argument — and it buys `more: false` on the first call, which is both the
 * honest answer to "is that all of it".
 *
 * Above the default the number is the caller's again: a 40,000-character answer
 * is paged, because that IS a case where the window is the constraint.
 */
const ANSWER_WHOLE_UNDER = ANSWER_SLICE_DEFAULT;

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
 * move that is not a retry.
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

/**
 * THE PORT, READ AT CALL TIME RATHER THAN AT REGISTRATION.
 *
 * ── WHAT THIS EXISTS TO SURVIVE ─────────────────────────────────────────────
 * `driver.ts` binds Claude's in-process wall through `delegatingCapability`, a
 * Proxy whose every read resolves the capability of the turn RUNNING NOW and
 * THROWS when there is no turn. `sessionsTools` composes the query tools by
 * reaching for `capability.query`, and it does that while REGISTERING them —
 * one property read, at the wrong moment, which on that path is the difference
 * between a wall and an exception.
 *
 * So the composition hands over this instead: six functions that each resolve
 * the port when they are CALLED, which is exactly when the proxy has a turn to
 * answer for. Every other deployment passes a plain object and is unaffected.
 *
 * SIX EXPLICIT DELEGATIONS RATHER THAN A SECOND PROXY. A proxy here would work
 * and would also make a member added to the port silently reachable without
 * anyone deciding it should be — and this file's whole argument is that the two
 * deployments satisfy one declared type rather than one convention.
 */
export function deferredQuery(get: () => SessionsQueryCapability): SessionsQueryCapability {
  return {
    find: (search) => get().find(search),
    outline: (sessionId, window) => get().outline(sessionId, window),
    answer: (sessionId, options) => get().answer(sessionId, options),
    steps: (sessionId, runId) => get().steps(sessionId, runId),
    step: (sessionId, runId, step, maxChars) => get().step(sessionId, runId, step, maxChars),
    grep: (sessionId, pattern, window) => get().grep(sessionId, pattern, window),
  };
}

/**
 * A STEP ADDRESSED BY POSITION OR BY NAME, exactly as the route is.
 *
 * A caller that has just read `sessions_steps` names a POSITION — "the twelfth
 * thing it did" is how an agent refers to a step — and one that found the item
 * in a journal page already holds its ID. Making the second look up an index
 * first would be a round trip to translate a name into a number, so both are
 * accepted and `runItem` decides which it got.
 */
function stepAddress(raw: unknown): number | string | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const index = Number(raw);
    return Number.isSafeInteger(index) && index >= 0 ? index : raw.trim();
  }
  return undefined;
}

export function sessionQueryTools(tool: ToolFactory, capability: SessionsQueryCapability): unknown[] {
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
        const limit = clampLimit(args.limit, FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX);
        try {
          const found = await capability.find({
            q: String(args.q ?? ""),
            ...(typeof args.projectId === "string" && args.projectId ? { projectId: args.projectId } : {}),
            ...(typeof args.settled === "boolean" ? { settled: args.settled } : {}),
            ...(typeof args.since === "number" ? { since: args.since } : {}),
            limit,
          });
          /**
           * BOUNDED HERE TOO, AND BY BOTH NUMBERS.
           *
           * The count is asked of the capability above and applied again here,
           * which is not belt-and-braces for its own sake: an implementation is
           * free to answer wider than it was asked (the route's `?all=1` does
           * exactly that one tool over), and a wall whose size depends on how
           * literally its port took an argument is a wall with no bound. The
           * BYTE half has no other owner at all — fifty hits each quoting a
           * 200-character line is past the toolkit's backstop, which clips
           * characters and would hand back JSON that does not parse.
           */
          const { rows } = fillWithin(found.sessions, (session) => session, { limit, chars: FIND_CHARS });
          const dropped = found.sessions.length - rows.length;
          const more = found.more || dropped > 0;
          return json({
            sessions: rows,
            // WHICH INDEX ANSWERED, carried through from the store. A caller
            // comparing two engines' results deserves to know whether it got
            // FTS5 or the bounded scan.
            index: found.index,
            more,
            note: more ? "More sessions matched than are shown. Narrow with projectId, settled or since rather than raising the limit." : undefined,
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
        const limit = clampLimit(args.limit, OUTLINE_PAGE_DEFAULT, OUTLINE_PAGE_MAX);
        try {
          const page = await capability.outline(sessionId, {
            limit,
            ...(typeof args.before === "number" ? { before: args.before } : {}),
          });
          // RE-BOUNDED IN DELIVERED BYTES — see `OUTLINE_ANSWER_CHARS`. Usually
          // a no-op: the store's own page is already under its budget, and this
          // only bites where two-space JSON pushes it over the issue's.
          const { rows } = fillWithin(page.turns, (turn) => turn, { limit, chars: OUTLINE_ANSWER_CHARS });
          const trimmed = rows.length < page.turns.length;
          const more = page.more || trimmed;
          // THE CURSOR IS THE LAST ROW ACTUALLY SHOWN. A `next` taken from the
          // store's page would step over every turn this trimmed, which is the
          // exact silent loss a bounded read exists to avoid.
          const next = trimmed ? rows.at(-1)?.sequence : page.next;
          return json({
            sessionId,
            turns: rows,
            total: page.total,
            more,
            ...(next === undefined ? {} : { next }),
            // The continuation is only printable when there IS a cursor. A note
            // naming `before: undefined` would be a call that reads the newest
            // page again, which is worse than no note at all.
            ...(more && next !== undefined
              ? { note: `Turns down to sequence ${next}. Continue with sessions_outline(sessionId: "${sessionId}", before: ${next}).` }
              : {}),
          });
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
        limit: z.number().int().min(1).max(ANSWER_SLICE_MAX).optional().describe(`Default ${ANSWER_SLICE_DEFAULT}, which is also the least it sends.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          const answered = await capability.answer(sessionId, {
            ...(typeof args.runId === "string" && args.runId ? { runId: args.runId } : {}),
            from: typeof args.from === "number" ? Math.max(0, args.from) : 0,
            // A FLOOR, NOT A DEFAULT — see `ANSWER_WHOLE_UNDER`.
            limit: Math.max(clampLimit(args.limit, ANSWER_SLICE_DEFAULT, ANSWER_SLICE_MAX), ANSWER_WHOLE_UNDER),
          });
          /**
           * THE ANSWER SAYS WHETHER IT IS ALL OF IT, in the sentence rather than
           * only in a boolean. `more` and `totalChars` have been in this reply
           * since #516 and nothing read them; a model that is told in words does
           * not have to infer "there is no more" from two fields agreeing.
           */
          const next = answered.next ?? answered.from + answered.text.length;
          return json(
            {
              ...answered,
              note: answered.more
                ? `Characters ${answered.from}-${next} of ${answered.totalChars}. Continue with sessions_answer(sessionId: "${sessionId}", runId: "${answered.runId}", from: ${next}).`
                : `That is the whole answer (${answered.totalChars} characters). There is no more of it to fetch, at any offset or limit — do not read this run again.`,
            },
            ANSWER_MAX_CHARS,
          );
        } catch (error) {
          const said = failure(error);
          return err(`Could not read the answer from "${sessionId}": ${ANSWER_MISSES[said] ?? said}`);
        }
      },
    ),
    tool(
      "sessions_steps",
      STEPS,
      {
        sessionId: z.string().min(1),
        runId: z.string().min(1).describe("The id a wake or sessions_outline gave you."),
        after: z.number().int().min(0).optional().describe("The `next` a previous page returned."),
        limit: z.number().int().min(1).max(STEPS_LIMIT_MAX).optional().describe(`Default ${STEPS_LIMIT_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const runId = String(args.runId ?? "");
        const limit = clampLimit(args.limit, STEPS_LIMIT_DEFAULT, STEPS_LIMIT_MAX);
        const after = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
        try {
          const { items } = await capability.steps(sessionId, runId);
          const window = items.slice(after);
          const { rows } = fillWithin(window, (item) => item, { limit, chars: STEPS_CHARS });
          const more = after + rows.length < items.length;
          return json({
            sessionId,
            runId,
            // THE TOTAL IS STATED WHETHER OR NOT THE LIST IS COMPLETE. A caller
            // handed fifty rows of a 400-step run and no count will report fifty
            // as everything the turn did.
            total: items.length,
            ...(after > 0 ? { after } : {}),
            items: rows,
            more,
            ...(more ? { next: after + rows.length } : {}),
            note:
              items.length === 0
                ? `No steps are filed under ${runId}. Either that run did nothing yet, or the runId is not this session's — sessions_outline lists the turns it has.`
                : more
                  ? `Steps ${after}–${after + rows.length} of ${items.length}. Continue with sessions_steps(sessionId: "${sessionId}", runId: "${runId}", after: ${after + rows.length}). Read one with sessions_step; \`bytes\` is what it will cost.`
                  : `All ${items.length} steps of that turn. Read one with sessions_step(step: index); \`bytes\` is what it will cost.`,
          });
        } catch (error) {
          return err(`Could not list the steps of "${runId}" on "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_step",
      STEP,
      {
        sessionId: z.string().min(1),
        runId: z.string().min(1),
        step: z
          .union([z.number().int().min(0), z.string().min(1)])
          .describe("The index sessions_steps gave, or an item id."),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(ITEM_CHARS_MAX)
          .optional()
          .describe(`Default ${ITEM_CHARS_DEFAULT}; what is cut is marked.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const runId = String(args.runId ?? "");
        const step = stepAddress(args.step);
        if (step === undefined) {
          return err(`"${String(args.step)}" is not a step: pass the index sessions_steps listed, or an item id. sessions_steps(sessionId: "${sessionId}", runId: "${runId}") lists them.`);
        }
        try {
          const read = await capability.step(sessionId, runId, step, clampLimit(args.maxChars, ITEM_CHARS_DEFAULT, ITEM_CHARS_MAX));
          return json(
            {
              sessionId,
              runId,
              ...read,
              note: read.more
                ? `${read.totalChars} characters in that step and not all of them are here. Raise maxChars if you need the rest — there is no offset, because a step is read whole or clamped.`
                : `That step, whole (${read.totalChars} characters).`,
            },
            ITEM_MAX_CHARS,
          );
        } catch (error) {
          return err(`Could not read step ${String(step)} of "${runId}" on "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_grep",
      GREP,
      {
        sessionId: z.string().min(1),
        pattern: z.string().min(1).describe("Case-insensitive, and matched anywhere in an event."),
        before: z.number().int().min(0).optional().describe("The `next` a previous page returned."),
        limit: z.number().int().min(1).max(GREP_PAGE_MAX).optional().describe(`Default ${GREP_PAGE_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const pattern = String(args.pattern ?? "");
        const limit = clampLimit(args.limit, GREP_PAGE_DEFAULT, GREP_PAGE_MAX);
        try {
          const found = await capability.grep(sessionId, pattern, {
            limit,
            ...(typeof args.before === "number" ? { before: args.before } : {}),
          });
          // A HUNDRED MATCHES OF 200 CHARACTERS IS PAST THE BACKSTOP — see
          // `GREP_CHARS`, and `sessions_find` above for why the count is applied
          // at this end as well as asked for at the other. Trimmed from the END,
          // so the cursor below is still the oldest row actually shown and a
          // caller paging with it cannot step over a match.
          const { rows } = fillWithin(found.matches, (match) => match, { limit, chars: GREP_CHARS });
          const more = found.more || rows.length < found.matches.length;
          const next = more ? (rows.at(-1)?.id ?? found.next) : undefined;
          return json({
            sessionId,
            pattern,
            matches: rows,
            more,
            ...(next === undefined ? {} : { next }),
            note:
              rows.length === 0
                ? `Nothing in this session's journal contains "${pattern}". It is a substring match, so try fewer words or the exact spelling you saw.`
                : more
                  ? `${rows.length} matches, newest first, and there are older ones. Continue with sessions_grep(sessionId: "${sessionId}", pattern: "${pattern}", before: ${next}). Each hit names the event; sessions_step reads one whole.`
                  : `All ${rows.length} matches, newest first. Each hit names the event it is in; sessions_step reads one whole.`,
          });
        } catch (error) {
          return err(`Could not search "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}
