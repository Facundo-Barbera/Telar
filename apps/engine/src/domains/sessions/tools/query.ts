import { z } from "zod";
import type { Item } from "@telar/engine-client";
import { clampLimit, err, failure, fillWithin, json, type ToolFactory } from "../../agent-tools";
import { TURN_ANSWER_NONE, TURN_ANSWER_NO_SUCH_RUN } from "../../turns";

type StepRow = { index: number; id: string; title: string; status: Item["status"]; bytes: number };

type StepRead = {
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

type OutlineTurn = { sequence: number } & Record<string, unknown>;

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
  steps(sessionId: string, runId: string): Promise<{ items: StepRow[] }>;
  step(sessionId: string, runId: string, step: number | string, maxChars: number): Promise<StepRead>;
  grep(sessionId: string, pattern: string, window: { limit: number; before?: number }): Promise<{
    matches: Array<{ id: number; at: number; type: string; runId?: string; context: string }>;
    more: boolean;
    next?: number;
  }>;
};

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

const FIND_CHARS = 8_000;
const GREP_CHARS = 10_000;

const OUTLINE_ANSWER_CHARS = 5_200;
const STEPS_LIMIT_DEFAULT = 50;
const STEPS_LIMIT_MAX = 200;
const STEPS_CHARS = 8_000;

const ANSWER_MAX_CHARS = ANSWER_SLICE_MAX + 2_000;
const ITEM_MAX_CHARS = ITEM_CHARS_MAX + 2_000;

const FIND =
  "Which conversation was this — a lexical search over every session, each hit carrying the line that matched. " +
  "The cheap first step before sessions_read.";

const OUTLINE =
  "Scroll a conversation without reading it: one row per turn, newest first — what was asked, what it did, how it ended.";

const ANSWER =
  "What one turn concluded — the answer alone, without its events. Defaults to the latest turn that said something.";

const STEPS =
  "What one turn DID, as a list to pick from: every step with its title, its state and its BYTE COST. " +
  "Read this before sessions_step — the bytes are what say which step you can afford.";

const STEP =
  "One step of one turn, whole: the call, its input and its output, clamped with a marker saying how much was left. " +
  "Address it by the index sessions_steps gave, or by an item id you already hold.";

const GREP =
  "Where a phrase appears in ONE session's journal, newest first, with the line around each hit. " +
  "Substring, not a regular expression — the words you remember seeing. sessions_find is the same question across sessions.";

const ANSWER_WHOLE_UNDER = ANSWER_SLICE_DEFAULT;

const ANSWER_MISSES: Readonly<Record<string, string>> = {
  [TURN_ANSWER_NONE]:
    "this session has never left an answer. There is nothing here to read and no runId will produce one, so do not ask it again — sessions_status says what it is doing, sessions_outline what its turns were.",
  [TURN_ANSWER_NO_SUCH_RUN]:
    "no turn with that runId is in this session. Do not guess another — omit runId for the latest turn that said something, or sessions_outline to see which turns there are.",
};

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
    ...lookupTools(tool, capability),
    ...stepTools(tool, capability),
  ];
}

function lookupTools(tool: ToolFactory, capability: SessionsQueryCapability): unknown[] {
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
          const { rows } = fillWithin(found.sessions, (session) => session, { limit, chars: FIND_CHARS });
          const dropped = found.sessions.length - rows.length;
          const more = found.more || dropped > 0;
          return json({
            sessions: rows,
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
          const { rows } = fillWithin(page.turns, (turn) => turn, { limit, chars: OUTLINE_ANSWER_CHARS });
          const trimmed = rows.length < page.turns.length;
          const more = page.more || trimmed;
          const next = trimmed ? rows.at(-1)?.sequence : page.next;
          return json({
            sessionId,
            turns: rows,
            total: page.total,
            more,
            ...(next === undefined ? {} : { next }),
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
            limit: Math.max(clampLimit(args.limit, ANSWER_SLICE_DEFAULT, ANSWER_SLICE_MAX), ANSWER_WHOLE_UNDER),
          });
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
  ];
}

function stepTools(tool: ToolFactory, capability: SessionsQueryCapability): unknown[] {
  return [
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

