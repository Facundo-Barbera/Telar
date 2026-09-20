/**
 * EVERY TOOL ANSWER, MEASURED — issue #515.
 *
 * ── WHY THIS FILE IS DIFFERENT FROM `sessions-tools.test.ts` ────────────────
 * That file runs against a real store on a real repository, because what it
 * asserts is that the RULES exist. This one asserts a NUMBER, and a number
 * needs a fixture big enough to break the thing being measured: 500 sessions,
 * a 5,000-event journal, 685 turns, 200 notes. Cutting 500 worktrees to get
 * there would take minutes and prove nothing extra, so the capability here is a
 * fake — which is exactly right for a test about how much a wall SAYS rather
 * than about what the engine underneath it allows.
 *
 * ── WHAT A FAILURE HERE MEANS ───────────────────────────────────────────────
 * A tool answer is not output; it is the caller's context window, spent. Before
 * this issue `sessions_list` spent 142,703 characters of it in one call — more
 * than a small model has — and `sessions_status` 80,755 to answer "is it
 * finished yet". Both were correct. Neither was usable. So the assertion is a
 * ceiling per tool, and a tool that grows past its ceiling fails here rather
 * than in somebody's session.
 *
 * ── AND THE ANSWER MUST STILL PARSE ─────────────────────────────────────────
 * `bounded` in `tool-kit.ts` is the backstop under every JSON answer, and it
 * clips CHARACTERS: an answer that reaches it comes back as JSON with its tail
 * cut off and a marker where the cut happened. That is the right last resort
 * and the wrong ordinary case, so this file asserts both halves — under the
 * ceiling, AND still parseable. A tool that can only meet the first is a tool
 * whose own paging is missing, and the second assertion is what says so.
 */
import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineRequest, ProjectNote, Session, Subscription, Turn } from "@telar/engine-client";
import { sessionsTools, type SessionsCapability } from "../src/sessions-tools/tools";
import { notesTools, type NotesCapability } from "../src/notes-tools/tools";
import { displayTools } from "../src/display/tools";
import { WARP_DESCRIPTION } from "../src/driver";
import { TELAR_SKILL } from "../src/orientation";
import { MAX_ANSWER_CHARS } from "../src/tool-kit";
import { GREP_CONTEXT_CHARS, WHY_CHARS } from "../src/turn-summary";

/** The widest `find` the route will serve — the fixture answers at it, so the
 *  wall's own byte bound is what the ceiling below measures. */
const FIND_LIMIT_MAX = 50;

/** The fixture's size, and the reason each number is what it is. */
const SESSIONS = 500;
const EVENTS = 5_000;
const TURNS = 685; // the orchestrator session that prompted the issue
const NOTES = 200;
const REQUESTS = 200;
const SUBSCRIPTIONS = 200;
const DIFF_FILES = 500;

type Registered = {
  name: string;
  description: string;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

function register(): { registered: Registered[]; factory: never } {
  const registered: Registered[] = [];
  const factory = (name: string, description: string, _shape: Record<string, unknown>, run: Registered["run"]) => {
    registered.push({ name, description, run });
    return { name };
  };
  return { registered, factory: factory as never };
}

const SESSION_ID = "session_fixture_0";
const RUN_ID = "run_fixture_400";

/**
 * A session row with a title of the length people actually type. Short titles
 * would make every list budget pass for the wrong reason.
 */
const session = (index: number): Session =>
  ({
    id: `session_fixture_${index}`,
    projectId: `project_${index % 12}`,
    title: `Rework the ${index} case so the paging cursor survives a concurrent append`,
    state: "active",
    createdAt: 1_000 + index,
    updatedAt: 2_000 + index,
    driver: "claude",
    envMode: index % 3 === 0 ? "worktree" : "local",
    workspace:
      index % 3 === 0
        ? { mode: "worktree", path: `/tmp/worktrees/${index}`, branch: `telar/fixture-${index}-a-reasonably-long-branch-name` }
        : { mode: "local", path: "/tmp/project" },
    activity: index % 4 === 0 ? "working" : "idle",
    origin: "session",
  }) as unknown as Session;

/** A turn with a real answer on it, because `mode: "summary"` quotes answers
 *  and a fixture of empty ones would not exercise the budget. */
const turn = (index: number): Turn =>
  ({
    runId: `run_fixture_${index}`,
    sessionId: SESSION_ID,
    sequence: index,
    state: index === TURNS - 1 ? "running" : "completed",
    input: `Line ${index} of the ask\n${"and a second paragraph nobody needs to read. ".repeat(20)}`,
    origin: index % 5 === 0 ? "session" : "user",
    ...(index % 5 === 0 ? { sender: { sessionId: "session_fixture_1" }, agentIntent: "task", agentNotice: "[agent message · task] …" } : {}),
    acceptedAt: 1_000 + index,
    updatedAt: 1_000 + index,
    completedAt: 2_000 + index,
    resultText: `The answer to ${index}. ${"It took a while to explain and this is the explaining. ".repeat(40)}`,
  }) as unknown as Turn;

/** A journal whose events carry the payloads real ones do — an item with text
 *  on it, and the meter rows and auto-approved requests that are most of a real
 *  journal by count. */
function journal(): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (let index = 1; index <= EVENTS; index += 1) {
    const runId = `run_fixture_${Math.min(TURNS - 1, Math.floor(index / 8))}`;
    const shared = { id: index, at: 1_000 + index, sessionId: SESSION_ID, runId };
    if (index % 4 === 0) {
      events.push({
        ...shared,
        type: "usage.updated",
        usage: { tokens: { input: index, output: index, cacheRead: 0, cacheCreate: 0 }, contextUsed: index, contextMax: 200_000 },
      } as unknown as EngineEvent);
      continue;
    }
    if (index % 7 === 0) {
      events.push({
        ...shared,
        type: "request.opened",
        request: { id: `req_${index}`, runId, sessionId: SESSION_ID, state: "resolved", resolvedBy: "policy", decision: "accept", openedAt: 1_000 + index, detail: { kind: "tool_call", call: { name: "Read", server: "fs", input: {} } } },
      } as unknown as EngineEvent);
      continue;
    }
    events.push({
      ...shared,
      type: "item.completed",
      item: {
        id: `item_${index}`,
        runId,
        sessionId: SESSION_ID,
        status: "completed",
        title: `Read apps/engine/src/some/path/number-${index}.ts`,
        detail: { type: "assistant_message", text: `Paragraph ${index}. ${"Words that a real item really does carry. ".repeat(30)}` },
        startedAt: 1_000 + index,
      },
    } as unknown as EngineEvent);
  }
  return events;
}

const EVENTS_FIXTURE = journal();
const TURNS_FIXTURE = Array.from({ length: TURNS }, (_, index) => turn(index));

function capabilities(): { sessions: SessionsCapability; notes: NotesCapability } {
  const sessions: SessionsCapability = {
    self: { sessionId: SESSION_ID },
    /**
     * THE FIXTURE IGNORES `settled`, ON PURPOSE. A capability that honoured it
     * would hand the wall a short list and the budget would pass without the
     * paging ever running. Every ceiling below is therefore measured against
     * the WIDE answer — the worst case, not the happy one.
     */
    list: async () => ({
      sessions: Array.from({ length: SESSIONS }, (_, index) => session(index)),
      projects: Array.from({ length: 12 }, (_, index) => ({ id: `project_${index}`, name: `project number ${index}` })),
      settledCount: SESSIONS - 11,
    }),
    create: async () => session(0),
    send: async () => ({ turn: turn(1), replayed: false }),
    read: async (_id, after, options) => {
      const tail = EVENTS_FIXTURE.filter((event) => event.id > after);
      return options?.limit === undefined ? tail : tail.slice(0, options.limit);
    },
    cursor: async () => EVENTS,
    status: async () => ({ session: session(0), turns: TURNS_FIXTURE }),
    stop: async () => ({ stopped: TURNS_FIXTURE.slice(0, 40), live: turn(TURNS - 1) }),
    settle: async () => session(0),
    diff: async () =>
      ({
        repository: true,
        branch: "telar/fixture",
        base: "main",
        linesAdded: 4_000,
        linesRemoved: 1_200,
        commits: Array.from({ length: 60 }, (_, index) => ({ shortSha: `abc${index}`, sha: `abc${index}0000`, subject: `feat(engine): change number ${index} with a real subject line on it` })),
        files: Array.from({ length: DIFF_FILES }, (_, index) => ({
          path: `apps/engine/src/some/deeply/nested/path/file-${index}.ts`,
          status: "modified",
          linesAdded: index,
          linesRemoved: index,
        })),
      }) as never,
    subscribe: async () => ({ id: "sub_1", subscriberSessionId: SESSION_ID, targetSessionId: SESSION_ID, events: ["turn_completed"], once: true, createdAt: 1 }) as unknown as Subscription,
    unsubscribe: async () => true,
    subscriptions: async () =>
      Array.from(
        { length: SUBSCRIPTIONS },
        (_, index) =>
          ({
            id: `sub_${index}`,
            subscriberSessionId: SESSION_ID,
            targetSessionId: `session_fixture_${index}`,
            events: ["turn_completed", "turn_failed", "turn_stopped", "request_opened"],
            once: true,
            createdAt: 1_000 + index,
          }) as unknown as Subscription,
      ),
    requests: async () =>
      Array.from(
        { length: REQUESTS },
        (_, index) =>
          ({
            id: `req_${index}`,
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "open",
            openedAt: 1_000 + index,
            detail: {
              kind: "user_input",
              prompt: `Question ${index}: which of these should the importer do when the column is missing?`,
              fields: [{ key: "choice", label: "Pick one", kind: "select", choices: ["drop the row", "fill with null", "fail the import"], required: true }],
            },
          }) as unknown as EngineRequest,
      ),
    resolveRequest: async () =>
      ({ id: "req_1", runId: RUN_ID, sessionId: SESSION_ID, state: "resolved", openedAt: 1, decision: "accept", resolvedBy: "session", detail: { kind: "tool_call", call: { name: "Read", server: "fs", input: {} } } }) as unknown as EngineRequest,
    /**
     * #516's SIX, AND THE FIXTURE ANSWERS THEM AS WIDE AS THE ROUTE WOULD.
     *
     * Same rule as `list` above: a stub that honoured the wall's own limit
     * would make every ceiling below pass without the paging ever running. So
     * each of these hands back the MAXIMUM the route may serve, at the worst
     * per-row size the projection allows — a 200-character `why`, a
     * 200-character grep context, 400 steps — and the wall is measured against
     * that rather than against a happy answer.
     */
    query: {
      find: async () => ({
        sessions: Array.from({ length: FIND_LIMIT_MAX }, (_, index) => ({
          id: `session_fixture_${index}`,
          title: `Rework the ${index} case so the paging cursor survives a concurrent append`,
          projectId: `project_${index % 12}`,
          activity: "idle",
          updatedAt: 2_000 + index,
          runId: `run_fixture_${index}`,
          why: `…${"the line that matched, as long as the projection lets a why line be. ".repeat(3)}`.slice(0, WHY_CHARS),
        })),
        index: "fts5" as const,
        more: true,
      }),
      /**
       * A FULL PAGE OF WORST-CASE ROWS, which is the case the issue's "under
       * 6 KB per page" is about.
       *
       * The store bounds this page at `OUTLINE_PAGE_BYTES` measured on COMPACT
       * json — 5,918 B leaving the store on the measured engine, 7,048 B once
       * `json()` has pretty-printed it. So the fixture answers as wide as the
       * store's own bound allows and the ceiling below is on what a caller
       * actually receives. A fixture that returned a short page would make that
       * ceiling pass for the wrong reason.
       */
      outline: async (_id, window) => ({
        turns: Array.from({ length: window.limit }, (_, index) => ({
          runId: `run_fixture_${index}`,
          sequence: index,
          state: "completed",
          input: `Line ${index} of the ask, as long as an input line is allowed to be before it`.slice(0, 120),
          items: 40,
          answer: `The answer to ${index}, as long as an outline answer line may be, and no longer than that`.slice(0, 200),
          answerChars: 12_000,
          endedAt: 2_000 + index,
        })),
        total: TURNS,
        more: true,
        next: 0,
      }),
      answer: async (_id, options) => {
        const whole = TURNS_FIXTURE[0]!.resultText ?? "";
        const text = whole.slice(options.from, options.from + options.limit);
        const more = options.from + text.length < whole.length;
        return { runId: RUN_ID, sequence: 1, text, from: options.from, totalChars: whole.length, more, ...(more ? { next: options.from + text.length } : {}) };
      },
      // 400 STEPS is the tail of the dogfood store's per-turn item count, and
      // it is the number `turn-summary.ts` cites for why a row keeps twelve
      // titles rather than all of them.
      steps: async () => ({
        items: Array.from({ length: 400 }, (_, index) => ({
          index,
          id: `item_${index}`,
          title: `Read apps/engine/src/some/deeply/nested/path/number-${index}.ts`,
          status: "completed" as const,
          bytes: 1_200 + index,
        })),
      }),
      step: async (_id, _runId, step, maxChars) => {
        const text = `{\n  "type": "assistant_message",\n  "text": "${"Words that a real item really does carry. ".repeat(4_000)}"\n}`;
        return {
          index: typeof step === "number" ? step : 0,
          id: "item_12",
          title: "Read apps/engine/src/some/deeply/nested/path/number-12.ts",
          status: "completed" as const,
          startedAt: 1_012,
          completedAt: 1_013,
          text: text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters]`,
          totalChars: text.length,
          more: text.length > maxChars,
        };
      },
      grep: async (_id, _pattern, window) => ({
        matches: Array.from({ length: window.limit }, (_, index) => ({
          id: EVENTS - index,
          at: 1_000 + index,
          type: "item.completed",
          runId: RUN_ID,
          context: `…${"Words around the phrase that matched, as many of them as a context window holds. ".repeat(3)}`.slice(0, GREP_CONTEXT_CHARS),
        })),
        more: true,
        next: EVENTS - window.limit,
      }),
    },
  };

  const stamp = { label: "Thu 10:00", at: 1 };
  const note = (index: number): ProjectNote =>
    ({
      id: `note_${index}`,
      projectId: "p1",
      title: `Note ${index}: what the reviewer keeps asking for`,
      body: `Body ${index}. ${"A runbook is long, and this is what one looks like. ".repeat(60)}`,
      created: stamp,
      updated: stamp,
      author: index % 2 === 0 ? "you" : "session",
    }) as ProjectNote;

  const notes: NotesCapability = {
    self: { projectId: "p1" },
    projects: async () => Array.from({ length: 12 }, (_, index) => ({ id: `project_${index}`, name: `project number ${index}` })),
    list: async () => Array.from({ length: NOTES }, (_, index) => note(index)),
    read: async () => ({ note: note(0), projectId: "p1" }),
    create: async () => note(0),
    update: async () => note(0),
    remove: async () => true,
  };
  return { sessions, notes };
}

function wall() {
  const { registered, factory } = register();
  const { sessions, notes } = capabilities();
  sessionsTools(factory, sessions);
  notesTools(factory, notes);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((entry) => entry.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    const answer = await tool.run(args);
    return (answer.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
  };
  return { registered, call };
}

/**
 * EVERY TOOL, WITH THE ARGUMENTS A CALLER ACTUALLY PASSES, and the ceiling each
 * answer may not cross. The ceilings are the shaped bounds the tools set for
 * themselves — see the constants in `sessions-tools/tools.ts` — with room for
 * the notes and cursors that ride beside the rows.
 *
 * A RUN READ IS THE ONE THAT MAY EXCEED `MAX_ANSWER_CHARS`, and it is the only
 * one: its answer and message slices are VERBATIM by contract, so the backstop
 * may not clip them. See `MAX_RUN_ANSWER_CHARS`.
 */
const CASES: Array<{ tool: string; args?: Record<string, unknown>; ceiling: number; why: string }> = [
  { tool: "sessions_list", ceiling: 14_000, why: "50 rows of 500, plus the project registry" },
  { tool: "sessions_list", args: { settled: true, limit: 200 }, ceiling: MAX_ANSWER_CHARS, why: "the widest ask a caller can make" },
  { tool: "sessions_create", args: { projectId: "project_0", envMode: "local" }, ceiling: 2_000, why: "one session and two notes" },
  { tool: "sessions_send", args: { sessionId: SESSION_ID, input: "x".repeat(20_000) }, ceiling: 4_000, why: "a receipt, never an echo of the message" },
  // THE BARE CALL FOLDS (#608): the journal is the ask now, not the default.
  { tool: "sessions_read", args: { sessionId: SESSION_ID }, ceiling: 8_000, why: "five turns folded to a line each" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, mode: "summary" }, ceiling: 8_000, why: "the same shape, asked for by name" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, mode: "events" }, ceiling: 14_000, why: "the latest page, at the 12 KB event budget" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, mode: "events", from: "start" }, ceiling: 14_000, why: "the first page, same budget" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, mode: "events", verbose: true }, ceiling: 14_000, why: "nothing dropped, same budget" },
  { tool: "sessions_status", args: { sessionId: SESSION_ID }, ceiling: 2_000, why: "five turns of 685, plus the live one" },
  { tool: "sessions_status", args: { sessionId: SESSION_ID, turns: 20 }, ceiling: 4_000, why: "the most a caller may ask for" },
  { tool: "sessions_stop", args: { sessionId: SESSION_ID }, ceiling: 2_000, why: "a count and a sentence, never the turns" },
  { tool: "sessions_settle", args: { sessionId: SESSION_ID }, ceiling: 1_000, why: "a title and a sentence" },
  { tool: "sessions_diff", args: { sessionId: SESSION_ID }, ceiling: MAX_ANSWER_CHARS, why: "500 files and 60 commits" },
  { tool: "sessions_subscribe", args: { sessionId: SESSION_ID }, ceiling: 1_500, why: "one subscription and a sentence" },
  { tool: "sessions_unsubscribe", args: { subscriptionId: "sub_1" }, ceiling: 500, why: "a boolean" },
  { tool: "sessions_subscriptions", ceiling: MAX_ANSWER_CHARS, why: "200 subscriptions" },
  { tool: "sessions_requests", args: { sessionId: SESSION_ID }, ceiling: MAX_ANSWER_CHARS, why: "200 open questions with their fields" },
  { tool: "sessions_resolve_request", args: { sessionId: SESSION_ID, requestId: "req_1", decision: "accept" }, ceiling: 1_000, why: "one request and a sentence" },
  /**
   * #516'S SIX, AT THE ARGUMENTS THAT COST THE MOST.
   *
   * Each appears twice where the maximum is reachable: once bare, which is what
   * a model actually calls, and once at the ceiling the route allows — because
   * three of these are bounded at the route by a COUNT alone, and a count alone
   * does not bound bytes. The second case of each pair is what the wall's own
   * byte budget exists for, and it is the one that would have tripped the
   * backstop before it had one.
   */
  /**
   * 4,809 CHARACTERS MEASURED, AGAINST THE "UNDER 3 KB" #516 ASKS FOR — and the
   * gap is arithmetic rather than a missing bound.
   *
   * Ten hits is the default, `WHY_CHARS` is 200, and the quoted line is the
   * whole point of the tool: a list an agent can choose from rather than one it
   * has to open to evaluate. Ten of those alone is 2 KB before a single title,
   * id or timestamp, and `json()` pretty-prints at two spaces, which adds about
   * 45% on a shape this key-dense. The issue's number is reachable only by
   * dropping the quotation or by emitting compact JSON, and the first guts the
   * feature while the second is a decision about every answer on every wall.
   *
   * So the ceiling is the measured worst case plus a little, stated rather than
   * nudged — and it IS a worst case: the fixture gives every row a 74-character
   * title and a `why` filled to the last character.
   */
  { tool: "sessions_find", args: { q: "appearance" }, ceiling: 5_000, why: "ten hits at the default, each quoting a full 200-character line" },
  { tool: "sessions_find", args: { q: "appearance", limit: 50 }, ceiling: MAX_ANSWER_CHARS, why: "50 hits each quoting a 200-character line" },
  /**
   * THE ISSUE'S OWN NUMBER, ON THE THING THE ISSUE BUDGETS. "Under 6 KB per
   * page" is asked of `sessions_outline`, and what a caller receives is the
   * pretty-printed answer — 7,048 B measured before this, against 5,918 B
   * leaving the store. See `OUTLINE_ANSWER_CHARS`.
   */
  { tool: "sessions_outline", args: { sessionId: SESSION_ID }, ceiling: 6_000, why: "the issue's per-page budget, measured on what is delivered" },
  { tool: "sessions_outline", args: { sessionId: SESSION_ID, limit: 100 }, ceiling: 6_000, why: "the widest ask — the delivered bound holds whatever was asked for" },
  { tool: "sessions_answer", args: { sessionId: SESSION_ID }, ceiling: 12_000, why: "the 8,000-character floor slice, plus the envelope" },
  { tool: "sessions_answer", args: { sessionId: SESSION_ID, limit: 64_000 }, ceiling: 66_000, why: "a verbatim slice the backstop may not clip — see ANSWER_MAX_CHARS" },
  { tool: "sessions_steps", args: { sessionId: SESSION_ID, runId: RUN_ID }, ceiling: MAX_ANSWER_CHARS, why: "50 of a 400-step run" },
  { tool: "sessions_steps", args: { sessionId: SESSION_ID, runId: RUN_ID, limit: 200 }, ceiling: MAX_ANSWER_CHARS, why: "the widest ask against the longest run" },
  { tool: "sessions_step", args: { sessionId: SESSION_ID, runId: RUN_ID, step: 12 }, ceiling: 12_000, why: "one step at the 8,000-character default" },
  { tool: "sessions_step", args: { sessionId: SESSION_ID, runId: RUN_ID, step: 12, maxChars: 64_000 }, ceiling: 66_000, why: "the most a caller may ask one step for" },
  { tool: "sessions_grep", args: { sessionId: SESSION_ID, pattern: "index.lock" }, ceiling: MAX_ANSWER_CHARS, why: "20 matches with 200 characters of context each" },
  { tool: "sessions_grep", args: { sessionId: SESSION_ID, pattern: "index.lock", limit: 100 }, ceiling: MAX_ANSWER_CHARS, why: "the widest ask — 100 × 200 characters is past the backstop unbounded" },
  { tool: "notes_projects", ceiling: 2_000, why: "12 projects" },
  { tool: "notes_list", ceiling: MAX_ANSWER_CHARS, why: "200 notes as titles and previews" },
  { tool: "notes_read", args: { noteId: "note_0" }, ceiling: MAX_ANSWER_CHARS, why: "one note, whole — this is the call that carries a body" },
  { tool: "notes_write", args: { title: "t", body: "b" }, ceiling: MAX_ANSWER_CHARS, why: "the note it wrote, echoed back" },
  { tool: "notes_delete", args: { noteId: "note_1" }, ceiling: 500, why: "a sentence" },
];

describe("every tool answer is bounded", () => {
  for (const { tool, args, ceiling, why } of CASES) {
    const label = args ? `${tool}(${Object.keys(args).join(", ")})` : `${tool}()`;
    test(`${label} stays under ${ceiling} characters — ${why}`, async () => {
      const text = await wall().call(tool, args ?? {});
      expect(text.length).toBeLessThanOrEqual(ceiling);
    });
  }

  /**
   * AND THE ANSWER STILL PARSES, which is the assertion that says a tool is
   * bounded by its own SHAPE rather than by the backstop. `bounded` clips
   * characters, so an answer that reaches it is JSON with its tail cut off: a
   * caller gets a parse error instead of a short list. Reaching it is a bug in
   * the tool, and this is where that bug is caught.
   */
  test("no answer is clipped by the backstop — every tool bounds its own shape", async () => {
    const { call } = wall();
    const clipped: string[] = [];
    for (const { tool, args } of CASES) {
      const text = await call(tool, args ?? {});
      if (text.includes("more characters not shown")) clipped.push(tool);
      // `notes_delete` and friends answer in prose; only JSON has to parse.
      if (text.startsWith("{") || text.startsWith("[")) expect(() => JSON.parse(text) as unknown).not.toThrow();
    }
    expect(clipped).toEqual([]);
  });
});

/**
 * THE DESCRIPTIONS ARE CONTEXT TOO, and they are paid for on EVERY turn of
 * every session whether or not a tool is ever called — which makes them the
 * one cost here that is never conditional. The sessions wall was 11,186
 * characters of prose; the cap is what keeps the reasoning in the telar skill,
 * where a model reads it when it wants it.
 */
describe("every tool description is short enough to carry", () => {
  const MAX_DESCRIPTION = 350;

  test(`no description is over ${MAX_DESCRIPTION} characters`, () => {
    const over = wall()
      .registered.filter((entry) => entry.description.length > MAX_DESCRIPTION)
      .map((entry) => `${entry.name} (${entry.description.length})`);
    expect(over).toEqual([]);
  });

  test("the two walls together cost under 6 KB of description", () => {
    const total = wall().registered.reduce((sum, entry) => sum + entry.description.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
  });

  test("and every tool still says something — a cap is not an excuse for a blank", () => {
    for (const entry of wall().registered) expect(entry.description.length).toBeGreaterThan(80);
  });

  /**
   * THE OTHER TWO SURFACES #515 NAMED, which the wall above cannot reach.
   *
   * Item 5 of that issue caps "notes, display, warp, browser tools". Notes ride
   * on `wall()`; browser has its own `BROWSER_DESCRIPTION_MAX_BYTES` test. These
   * two had no guard at all and had drifted furthest — `display_open` to 655
   * characters and `warp` to 2,988, which is ~3.3 KB carried in every turn of
   * every session whether or not either tool is ever called.
   *
   * `warp` is asserted against its exported constant rather than a registered
   * tool because it is Claude-only and has no toolkit to enumerate — the same
   * reason `orientation.test.ts` names it explicitly.
   */
  test("display and warp are capped too — the two that had no guard", () => {
    const { registered, factory } = register();
    displayTools(factory, { open: async ({ path }) => ({ path }) });
    const display = registered.find((entry) => entry.name === "display_open");
    expect(display).toBeDefined();
    expect(display!.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(display!.description.length).toBeGreaterThan(80);

    expect(WARP_DESCRIPTION.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(WARP_DESCRIPTION.length).toBeGreaterThan(80);
  });

  /**
   * The cap is only honest if what was cut is still readable somewhere. Both
   * descriptions now point at the `telar` skill, which is written to disk once
   * and costs nothing until a model asks for it — so the reference has to
   * actually be there, or the cap traded 3.3 KB of context for a dead end.
   */
  test("what the cap displaced is in the skill, not deleted", () => {
    expect(WARP_DESCRIPTION).toContain("telar");
    for (const owed of ["export const meta", "pipeline(items, ...stages)", "parallel(thunks)", "agent(prompt, opts?)", "Math.random()"]) {
      expect(TELAR_SKILL).toContain(owed);
    }
  });
});
