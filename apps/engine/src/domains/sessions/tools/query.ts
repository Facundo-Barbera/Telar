import type { Item } from "@telar/engine-client";
import { clampLimit, err, failure, fillWithin, json } from "../../agent-tools";
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

type Args = Record<string, unknown>;

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

export const FIND_LIMIT_DEFAULT = 10;
const FIND_LIMIT_MAX = 50;
const OUTLINE_PAGE_DEFAULT = 20;
const OUTLINE_PAGE_MAX = 100;
export const CHARS_DEFAULT = 8_000;
export const CHARS_MAX = 64_000;
const GREP_PAGE_DEFAULT = 20;
const GREP_PAGE_MAX = 100;

const FIND_CHARS = 8_000;
const GREP_CHARS = 10_000;

const OUTLINE_ANSWER_CHARS = 5_200;
const STEPS_LIMIT_DEFAULT = 50;
export const STEPS_LIMIT_MAX = 200;
const STEPS_CHARS = 8_000;

const SLICE_MAX_CHARS = CHARS_MAX + 2_000;

const ANSWER_MISSES: Readonly<Record<string, string>> = {
  [TURN_ANSWER_NONE]:
    'this session has never left an answer. There is nothing here to read and no runId will produce one, so do not ask it again — sessions_status says what it is doing, sessions_read view: "outline" what its turns were.',
  [TURN_ANSWER_NO_SUCH_RUN]:
    'no turn with that runId is in this session. Do not guess another — omit runId for the latest turn that said something, or sessions_read view: "outline" to see which turns there are.',
};

function stepAddress(raw: unknown): number | string | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const index = Number(raw);
    return Number.isSafeInteger(index) && index >= 0 ? index : raw.trim();
  }
  return undefined;
}

const runIdOf = (args: Args): string | undefined => (typeof args.runId === "string" && args.runId ? args.runId : undefined);

export async function findView(capability: SessionsQueryCapability, args: Args) {
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
}

export async function outlineView(capability: SessionsQueryCapability, sessionId: string, args: Args) {
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
        ? { note: `Turns down to sequence ${next}. Continue with sessions_read(sessionId: "${sessionId}", view: "outline", before: ${next}).` }
        : {}),
    });
  } catch (error) {
    return err(`Could not outline "${sessionId}": ${failure(error)}`);
  }
}

export async function answerView(capability: SessionsQueryCapability, sessionId: string, args: Args) {
  const runId = runIdOf(args);
  try {
    const answered = await capability.answer(sessionId, {
      ...(runId ? { runId } : {}),
      from: typeof args.resultAfter === "number" ? Math.max(0, args.resultAfter) : 0,
      limit: Math.max(clampLimit(args.maxChars, CHARS_DEFAULT, CHARS_MAX), CHARS_DEFAULT),
    });
    const next = answered.next ?? answered.from + answered.text.length;
    return json(
      {
        ...answered,
        note: answered.more
          ? `Characters ${answered.from}-${next} of ${answered.totalChars}. Continue with sessions_read(sessionId: "${sessionId}", view: "answer", runId: "${answered.runId}", resultAfter: ${next}).`
          : `That is the whole answer (${answered.totalChars} characters). There is no more of it to fetch, at any offset or limit — do not read this run again.`,
      },
      SLICE_MAX_CHARS,
    );
  } catch (error) {
    const said = failure(error);
    return err(`Could not read the answer from "${sessionId}": ${ANSWER_MISSES[said] ?? said}`);
  }
}

export async function stepsView(capability: SessionsQueryCapability, sessionId: string, args: Args) {
  const runId = runIdOf(args);
  if (!runId) return err(`view "steps" needs the runId whose steps to list — a wake or view "outline" gives it.`);
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
          ? `No steps are filed under ${runId}. Either that run did nothing yet, or the runId is not this session's — sessions_read view: "outline" lists the turns it has.`
          : more
            ? `Steps ${after}–${after + rows.length} of ${items.length}. Continue with sessions_read(sessionId: "${sessionId}", view: "steps", runId: "${runId}", after: ${after + rows.length}). Read one with view: "step"; \`bytes\` is what it will cost.`
            : `All ${items.length} steps of that turn. Read one with sessions_read(view: "step", step: index); \`bytes\` is what it will cost.`,
    });
  } catch (error) {
    return err(`Could not list the steps of "${runId}" on "${sessionId}": ${failure(error)}`);
  }
}

export async function stepView(capability: SessionsQueryCapability, sessionId: string, args: Args) {
  const runId = runIdOf(args);
  if (!runId) return err(`view "step" needs the runId the step belongs to — a wake or view "outline" gives it.`);
  const step = stepAddress(args.step);
  if (step === undefined) {
    return err(`"${String(args.step)}" is not a step: pass the index view "steps" listed, or an item id. sessions_read(sessionId: "${sessionId}", view: "steps", runId: "${runId}") lists them.`);
  }
  try {
    const read = await capability.step(sessionId, runId, step, clampLimit(args.maxChars, CHARS_DEFAULT, CHARS_MAX));
    return json(
      {
        sessionId,
        runId,
        ...read,
        note: read.more
          ? `${read.totalChars} characters in that step and not all of them are here. Raise maxChars if you need the rest — there is no offset, because a step is read whole or clamped.`
          : `That step, whole (${read.totalChars} characters).`,
      },
      SLICE_MAX_CHARS,
    );
  } catch (error) {
    return err(`Could not read step ${String(step)} of "${runId}" on "${sessionId}": ${failure(error)}`);
  }
}

export async function grepView(capability: SessionsQueryCapability, sessionId: string, args: Args) {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return err(`view "grep" needs a pattern: the words you remember seeing.`);
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
            ? `${rows.length} matches, newest first, and there are older ones. Continue with sessions_read(sessionId: "${sessionId}", view: "grep", pattern: "${pattern}", before: ${next}). Each hit names the event; view "step" reads one whole.`
            : `All ${rows.length} matches, newest first. Each hit names the event it is in; view "step" reads one whole.`,
    });
  } catch (error) {
    return err(`Could not search "${sessionId}": ${failure(error)}`);
  }
}
