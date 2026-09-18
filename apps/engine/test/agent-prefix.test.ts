/**
 * IS THE AGENT'S PROMPT PREFIX WORTH CACHING — measured, not argued (#563 item 3).
 *
 * ── WHY THIS FILE IS A MEASUREMENT AND NOT A FEATURE ────────────────────────
 * The Agent runs `deepseek-v4.1-flash`, which takes the CHAT route, and on that
 * route there is no `cache_control` to set: the caching is the provider's, it is
 * automatic, and it depends entirely on the prefix being BYTE-IDENTICAL between
 * calls. So the work item that reads "mark the prefix cacheable" has, for the
 * model actually in use, no field to set at all — what it has is an invariant to
 * establish and then defend. This file is that defence.
 *
 * `runtime.ts` CLAIMS THE ORDER WAS CHOSEN FOR THIS, in the note above the
 * system block: briefing, orientation, standing, digest, from most permanent to
 * least, "which is the shape #563 item 3 will want". The claim was worth
 * checking rather than trusting, and it HELD — but the thing that makes it
 * matter is one the note does not mention, and only a measurement from the
 * socket could have found it: the bound tool array is serialised BEFORE the
 * messages, so the single largest fixed block in the request (13,993 characters,
 * resent every lap) sits in the stable region by construction.
 *
 * ── IT ASSERTS FROM THE SOCKET, LIKE `agent-model.test.ts` ──────────────────
 * Byte-identity is not a property the runtime's message objects can be asked
 * about: two `SystemMessage`s that are equal may still serialise differently,
 * and it is the bytes a provider hashes. So this drives a REAL `agentChatModel`
 * against a local server and reads the request bodies off the wire, which is the
 * same rule — and the same reason — that file gives for watching the socket.
 *
 * ── WHAT IT DOES NOT CLAIM ─────────────────────────────────────────────────
 * That any provider actually SERVES this prefix from a cache. That is a fact
 * about OpenCode Go and its upstreams, it cannot be learned from a local server,
 * and it is what `agent-cache.live.test.ts` exists to ask — off by default,
 * because the answer costs somebody's credit.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentFleetCapability, AgentQueryCapability } from "../src/agent/tools";
import type { NotesCapability, SessionsCapability, SocketTool } from "../src/mcp-socket";
import { AGENT_SELF_ID, agentToolSpecs, collectAgentTools } from "../src/agent/tools";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { rememberSection } from "../src/agent/memory";
import { agentChatModel } from "../src/agent/model";
import { AgentRuntime } from "../src/agent/runtime";

/* ------------------------------------------------------------------ *
 * The wall, at the size the Agent really binds it.
 * ------------------------------------------------------------------ */

const noSessions = (): SessionsCapability =>
  ({
    self: { sessionId: AGENT_SELF_ID },
    list: async () => ({ sessions: [], projects: [] }),
    create: async () => ({}) as never,
    send: async () => ({ turn: {} as never, replayed: false }),
    read: async () => [],
    status: async () => ({ session: {} as never, turns: [] }),
    stop: async () => ({ stopped: 0 }) as never,
    settle: async () => ({}) as never,
    diff: async () => ({}) as never,
    subscribe: async () => ({}) as never,
    unsubscribe: async () => false,
    subscriptions: async () => [],
    requests: async () => [],
    resolveRequest: async () => ({}) as never,
  }) as never;

const noNotes = (): NotesCapability =>
  ({
    projects: async () => [],
    list: async () => [],
    read: async () => null,
    create: async () => ({}) as never,
    update: async () => null,
    remove: async () => false,
  }) as never;

const noQueries = (): AgentQueryCapability => ({
  find: async () => ({ sessions: [], index: "like", more: false }),
  outline: async () => ({ turns: [], total: 0, more: false }),
  answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
});

const emptyFleet = (): AgentFleetCapability => ({
  rail: async () => ({ sessions: [], projects: [] }),
  subscribed: async () => [],
  who: () => undefined,
  session: async () => undefined,
  lastTurn: async () => undefined,
  openRequests: async () => 0,
  unread: () => ({}),
  since: () => undefined,
});

const wholeWall = (): SocketTool[] =>
  collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    fleet: emptyFleet(),
    github: { issue: async () => ({ unavailable: "not_found" }), pull: async () => ({ unavailable: "not_found" }), projects: async () => [] },
    memory: { remember: (section) => ({ written: true, section, chars: 0, others: {}, standing: 0 }), recall: () => [] },
  }) as SocketTool[];

/* ------------------------------------------------------------------ *
 * A local server, and the bodies that reached it.
 * ------------------------------------------------------------------ */

/** The model on the CHAT route — the one the Agent actually runs, named here so
 *  a reader is never in doubt about which of the three this file is about. */
const ON_CHAT = "deepseek-v4.1-flash";

type Lap = { turn: number; body: string };

function agentDirWith(key: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-prefix-key-"));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ key }));
  return dir;
}

/** How many leading bytes two requests share. THE measurement: a provider's
 *  automatic cache is a prefix cache, so this number, and not a diff, is what
 *  decides whether the second call is cheap. */
function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

async function until(check: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A conversation, driven through the real factory, with every request body kept.
 *
 * `lapsPerTurn` LAPS THEN AN ANSWER, so a turn that calls tools is what is
 * measured rather than a turn that answers immediately: the quadratic cost item
 * 3 is about is paid by the multi-lap turn, and a one-lap turn would have hidden
 * every boundary this file is looking for.
 */
async function conversation(options: {
  says: string[];
  lapsPerTurn: number;
  toolResult?: string;
  between?: (agent: AgentRuntime) => void;
}): Promise<Lap[]> {
  const laps: Lap[] = [];
  let turn = 1;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      laps.push({ turn, body: await request.text() });
      const soFar = laps.filter((lap) => lap.turn === turn).length;
      const callTool = soFar < options.lapsPerTurn;
      if (!callTool) turn += 1;
      return Response.json({
        id: `chatcmpl_${laps.length}`,
        choices: [
          {
            index: 0,
            message: callTool
              ? { role: "assistant", content: "Looking.", tool_calls: [{ id: `call_${laps.length}`, type: "function", function: { name: "sessions_list", arguments: "{}" } }] }
              : { role: "assistant", content: "Here is what is running." },
            finish_reason: callTool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005 },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const agentDir = agentDirWith("sk-prefix-test");
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-prefix-"));
  const answer = options.toolResult;
  const tools = wholeWall().map((tool) =>
    answer !== undefined && tool.name === "sessions_list" ? { ...tool, run: async () => ({ content: [{ type: "text" as const, text: answer }] }) } : tool,
  );
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => tools,
    // STREAMING OFF so the fixture is one JSON answer rather than an SSE
    // transcript. It changes `stream` in the body and nothing else this file
    // measures — the tools, the system block and the messages are identical
    // either way, and those are the bytes a prefix cache hashes.
    model: (input) => agentChatModel({ threadId: input.threadId, model: ON_CHAT, agentDir, base, streaming: false }),
    orientation: () => "You are inside Telar, a cockpit for running agents.",
  });
  agent.patch({ enabled: true });
  try {
    for (const [index, text] of options.says.entries()) {
      if (index > 0) options.between?.(agent);
      agent.submit({ text });
      await until(() => agent.state().running === false, `the turn that said "${text}"`);
    }
  } finally {
    agent.close();
    server.stop(true);
  }
  return laps;
}

/* ------------------------------------------------------------------ *
 * 1 — the shape of the request, which is what puts the big block first.
 * ------------------------------------------------------------------ */

test("the bound tools are serialised before the messages, so the largest fixed block is in the prefix", async () => {
  const laps = await conversation({ says: ["what is running?"], lapsPerTurn: 1 });
  const body = laps[0]!.body;

  /**
   * THE FACT THE WHOLE ITEM RESTS ON, and it is `@langchain/openai`'s doing
   * rather than ours — which is exactly why it is pinned here. A library that
   * started emitting `messages` first would move ~14 KB of unchanging tool
   * definitions BEHIND a system block that changes every turn, and every byte
   * after the change misses. Nothing would fail; the bill would just go up.
   */
  expect(body.indexOf('"tools"')).toBeLessThan(body.indexOf('"messages"'));
  // And the tools are near the FRONT rather than merely before the messages.
  expect(body.indexOf('"tools"')).toBeLessThan(200);

  // Everything ahead of the tools is constant per conversation: the model id,
  // the temperature this factory sets, and the stream flag.
  const head = JSON.parse(body) as Record<string, unknown>;
  expect(Object.keys(head).slice(0, 4)).toEqual(["model", "temperature", "stream", "tools"]);
});

test("the tool definitions serialise identically every time, key order included", () => {
  /**
   * ASSEMBLED TWICE FROM SCRATCH rather than stringified twice from one array:
   * the wall is rebuilt per turn (`daemon.ts` passes a closure), so the question
   * is whether two independent assemblies agree byte for byte — key order,
   * property order and all. A zod-to-JSON-Schema bridge that started ordering
   * its keys by a hash would break this and nothing else.
   */
  expect(JSON.stringify(agentToolSpecs(wholeWall()))).toBe(JSON.stringify(agentToolSpecs(wholeWall())));
});

/* ------------------------------------------------------------------ *
 * 2 — lap to lap, inside one turn.
 * ------------------------------------------------------------------ */

test("the laps of one turn share everything but their tail", async () => {
  const laps = await conversation({ says: ["what is running?"], lapsPerTurn: 3 });
  expect(laps).toHaveLength(3);

  for (let index = 1; index < laps.length; index += 1) {
    const previous = laps[index - 1]!.body;
    const current = laps[index]!.body;
    const shared = commonPrefix(previous, current);
    /**
     * 97.3% AND 97.6% WHEN THIS WAS MEASURED. A FLOOR rather than an equality:
     * what must not come back is a prompt whose EARLY bytes move between laps,
     * and the tail is allowed to grow — it is the new assistant message and the
     * result of the call it made, which is the whole point of another lap.
     */
    expect(shared / current.length).toBeGreaterThan(0.9);
    // The shared run reaches past the tools AND past the system block, which is
    // the claim that makes the number worth having.
    expect(shared).toBeGreaterThan(current.indexOf('"messages"'));
  }
});

/* ------------------------------------------------------------------ *
 * 3 — turn to turn, which is where the system block moves.
 * ------------------------------------------------------------------ */

test("a `remember` between turns moves the system block and nothing before it", async () => {
  const laps = await conversation({
    says: ["first", "second"],
    lapsPerTurn: 1,
    // THE WRITE THE ORDERING WAS CHOSEN TO SURVIVE. `remember` rewrites the
    // standing document in place, and `runtime.ts` reads it once per turn — so
    // this is the ordinary between-turns change, not a contrived one.
    between: (agent) => rememberSection(agent.paths, "preferences", "Keep PRs small. Answer in the language you were asked in. ".repeat(8)),
  });
  expect(laps).toHaveLength(2);
  const [before, after] = [laps[0]!.body, laps[1]!.body];
  const shared = commonPrefix(before, after);

  /**
   * THE ORDERING CLAIM IN `runtime.ts`, HELD AS A NUMBER.
   *
   * The briefing and the orientation are the same characters on every turn of
   * every conversation; the standing state is the first thing in the prompt that
   * can change between turns. So the shared prefix must reach PAST the whole
   * tool array and PAST the briefing, and the divergence must land inside the
   * system block rather than ahead of it.
   */
  expect(shared).toBeGreaterThan(after.indexOf('"messages"'));
  expect(shared).toBeGreaterThan(after.indexOf(AGENT_BRIEFING.slice(0, 40).replace(/"/g, '\\"')));
  // Measured at 96.4% of the later prompt. A floor, for the reason above.
  expect(shared / after.length).toBeGreaterThan(0.9);
});

/* ------------------------------------------------------------------ *
 * 4 — the one thing that rewrites the prompt BACKWARDS.
 * ------------------------------------------------------------------ */

/**
 * THE FINDING THIS FILE WAS WRITTEN TO CATCH, and it is not fixed here (#563).
 *
 * ── WHAT HAPPENS ────────────────────────────────────────────────────────────
 * `compactToolResults` collapses the results of EARLIER LAPS OF THE SAME TURN to
 * one line each, and its turn boundary is the last human message. That scope is
 * deliberate and it is what makes a 16-lap turn affordable. But it means the
 * stubs are scoped to the turn: on the NEXT turn those laps are no longer "this
 * turn's", so their results are sent in FULL again — 5,514 characters where the
 * previous request had 60.
 *
 * ── WHY THAT IS FATAL RATHER THAN MERELY WASTEFUL ───────────────────────────
 * A prefix cache matches from the front and stops at the first byte that
 * differs. Re-expanding a stub does not cost the expanded bytes; it costs EVERY
 * BYTE AFTER THEM. The rewrite lands at the first tool result of the previous
 * turn — measured at byte 17,135 of a 24,082-byte prompt on turn 2, and 24,251
 * of 31,202 on turn 3 — so roughly a quarter of each prompt is downstream of it
 * and cannot be served from cache no matter how stable everything ahead of it is.
 *
 * ── WHY IT IS ONLY MEASURED HERE ────────────────────────────────────────────
 * Fixing it changes WHAT THE MODEL CAN READ about earlier turns, which is a
 * behaviour change; this item is a measurement and a reporting change, and the
 * two want different review. The size of the prize is also not yet known — no
 * live cache reading has been taken — so a fix now would be built before the
 * measurement that justifies it. The owner is filing it separately.
 *
 * THE TEST PINS THE BEHAVIOUR AS IT IS, not as it should be, and says so: if a
 * later change makes the stub survive the turn boundary, this fails and is
 * meant to — the number it asserts is the finding.
 */
test("a previous turn's compacted results expand again, rewriting the prompt backwards", async () => {
  // The size the issue measured for a real `sessions_outline` answer.
  const wide = JSON.stringify({ sessions: Array.from({ length: 60 }, (_, index) => ({ id: `session_${index}`, title: `a session about something ${index}`, state: "idle", project: "telar" })) });
  const laps = await conversation({ says: ["what is running?", "and the rail?"], lapsPerTurn: 3, toolResult: wide });

  const lastOfFirst = laps.filter((lap) => lap.turn === 1).at(-1)!.body;
  const firstOfSecond = laps.find((lap) => lap.turn === 2)!.body;

  // The turn that just ended sent a STUB for its own first lap …
  expect(lastOfFirst).toContain("[earlier lap] sessions_list:");
  // … and the next turn sends that same result in full again.
  expect(firstOfSecond).not.toContain("[earlier lap] sessions_list:");

  const shared = commonPrefix(lastOfFirst, firstOfSecond);
  const missed = firstOfSecond.length - shared;
  // THE DAMAGE IS THE TAIL, not the expansion: everything after the rewrite
  // point is a cache miss. Measured at 6,947 bytes of a 24,082-byte prompt.
  expect(missed).toBeGreaterThan(wide.length);
  // And the rewrite lands well INSIDE the prompt rather than at its end, which
  // is what makes it expensive — pinned as a fraction so the assertion survives
  // the prompt growing.
  expect(shared / firstOfSecond.length).toBeLessThan(0.85);
  expect(shared).toBeGreaterThan(firstOfSecond.indexOf('"messages"'));
});

/* ------------------------------------------------------------------ *
 * 5 — the reporting, which is what makes any of this checkable.
 * ------------------------------------------------------------------ */

test("the turn's usage row carries what the provider said about its cache", async () => {
  const laps: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      laps.push(await request.text());
      return Response.json({
        id: "chatcmpl_1",
        choices: [{ index: 0, message: { role: "assistant", content: "Nothing is running." }, finish_reason: "stop" }],
        // THE SHAPE THE CHAT ROUTE REPORTS IT IN. `prompt_tokens` INCLUDES the
        // cached ones, which is why the row's `cacheRead` is a fraction of its
        // `input` rather than a number beside it.
        usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010, prompt_tokens_details: { cached_tokens: 880 } },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const agentDir = agentDirWith("sk-prefix-test");
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-usage-"));
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => wholeWall(),
    model: (input) => agentChatModel({ threadId: input.threadId, model: ON_CHAT, agentDir, base, streaming: false }),
  });
  agent.patch({ enabled: true });
  agent.submit({ text: "what is running?" });
  await until(() => agent.state().running === false, "the turn to finish");

  const done = agent.thread({ limit: 50 }).rows.findLast((row) => row.kind === "turn_done")!;
  expect(done.detail.usage).toEqual({ input: 1_000, output: 10, total: 1_010, cacheRead: 880, cacheCreate: 0 });
  // AND ON THE STATE A CLIENT POLLS, from the same call that wrote the row.
  expect(agent.state().lastUsage?.usage).toMatchObject({ cacheRead: 880 });
  agent.close();
  server.stop(true);
});

/**
 * THE CASE A LIBRARY BUG NEARLY TURNED INTO A FALSE MEASUREMENT.
 *
 * `@langchain/openai` 1.5.x puts an EMPTY `input_token_details` on every chat
 * completion whether or not the server said anything about caching — its guard
 * compares an absent field against `null` and an absent field is `undefined`.
 * Reading "the details are there" as "the provider reported" would therefore
 * have written `cacheRead: 0` onto every turn served by a provider that forwards
 * no cache statistics, and a zero looks exactly like a finding. See the note in
 * `runtime.ts` where the numbers, rather than their container, are tested.
 */
test("a provider that says nothing about caching is written down as silent, not as cold", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      return Response.json({
        id: "chatcmpl_1",
        choices: [{ index: 0, message: { role: "assistant", content: "Nothing is running." }, finish_reason: "stop" }],
        // TOKENS COUNTED, CACHE UNMENTIONED — the case an OpenAI-compatible
        // server is entitled to, and the one a zero would misreport.
        usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const agentDir = agentDirWith("sk-prefix-test");
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-usage-silent-"));
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => wholeWall(),
    model: (input) => agentChatModel({ threadId: input.threadId, model: ON_CHAT, agentDir, base, streaming: false }),
  });
  agent.patch({ enabled: true });
  agent.submit({ text: "what is running?" });
  await until(() => agent.state().running === false, "the turn to finish");

  const done = agent.thread({ limit: 50 }).rows.findLast((row) => row.kind === "turn_done")!;
  expect(done.detail.usage).toEqual({ input: 1_000, output: 10, total: 1_010 });
  agent.close();
  server.stop(true);
});
