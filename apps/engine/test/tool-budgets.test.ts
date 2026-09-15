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
import { MAX_ANSWER_CHARS } from "../src/tool-kit";

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
  { tool: "sessions_read", args: { sessionId: SESSION_ID }, ceiling: 14_000, why: "the latest page, at the 12 KB event budget" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, from: "start" }, ceiling: 14_000, why: "the first page, same budget" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, mode: "summary" }, ceiling: 8_000, why: "five turns folded to a line each" },
  { tool: "sessions_read", args: { sessionId: SESSION_ID, verbose: true }, ceiling: 14_000, why: "nothing dropped, same budget" },
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
});
