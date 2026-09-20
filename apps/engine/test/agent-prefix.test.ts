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
 * messages, so the single largest fixed block in the request (13,953 characters,
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
import type { AgentFleetCapability } from "../src/agent/tools";
import { noQueries } from "./query-stub";
import type { NotesCapability, SessionsCapability, SocketTool } from "../src/mcp-socket";
import { AGENT_SELF_ID, agentToolSpecs, collectAgentTools } from "../src/agent/tools";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { rememberSection } from "../src/agent/memory";
import { agentChatModel } from "../src/agent/model";
import { AgentRuntime } from "../src/agent/runtime";
// EVERY STUB IN THIS SUITE BINDS THROUGH HERE — issue #610. The wildcard bind
// `Bun.serve` defaults to can land on a port another loopback listener owns,
// and then the neighbour answers instead of the stub. See `loopback-server.ts`.
import { loopbackBase, serveLoopback } from "./loopback-server";

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

/* ------------------------------------------------------------------ *
 * What a request really carried — read back off the same bytes.
 * ------------------------------------------------------------------ *
 * A SHARED-PREFIX RATIO IS SATISFIED BY TWO PROMPTS THAT ARE BOTH NEARLY
 * EMPTY, and the failure this file is most likely to misread as a triumph is a
 * prompt that got shorter because history fell out of it. So every byte claim
 * below is paired with a COUNT taken from these three, and the counts come from
 * parsing the bytes that were sent rather than from the runtime's own objects.
 */

type SentMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> };

const sentMessages = (body: string): SentMessage[] => (JSON.parse(body) as { messages: SentMessage[] }).messages;

/** Every result in a request, by the call it answers, in the order sent. */
function resultsIn(body: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of sentMessages(body)) {
    if (message.role === "tool" && message.tool_call_id) results.set(message.tool_call_id, message.content);
  }
  return results;
}

/** Every call the assistant asked for, in the order it asked. */
const callsIn = (body: string): string[] => sentMessages(body).flatMap((message) => (message.tool_calls ?? []).map((call) => call.id));

/**
 * WHERE ONE RESULT ENDS IN THE RAW BODY. The chat route serialises a result as
 * `{"role":"tool","content":…,"tool_call_id":"call_N"}`, so this anchor sits
 * just PAST the content it identifies: a divergence after call N−1's anchor and
 * before call N's is a divergence inside call N's result, which is how a
 * divergence gets NAMED here instead of merely measured.
 */
function resultAnchor(body: string, id: string): number {
  const at = body.indexOf(`"tool_call_id":"${id}"`);
  if (at < 0) throw new Error(`no result for ${id} in this request`);
  return at;
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
  toolResult?: (call: number) => string;
  between?: (agent: AgentRuntime) => void;
}): Promise<Lap[]> {
  const laps: Lap[] = [];
  let turn = 1;
  const server = serveLoopback(async (request) => {
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
            ? {
                role: "assistant",
                content: "Looking.",
                // THE ARGUMENTS DIFFER PER CALL, and they have to: #608's read
                // dedup answers a repeat of `tool(args)` with a notice instead
                // of the tool's own answer, so identical arguments would make
                // every lap after the first return 150 characters of refusal
                // and there would be no second RESULT to measure the stub on.
                tool_calls: [{ id: `call_${laps.length}`, type: "function", function: { name: "sessions_list", arguments: JSON.stringify({ limit: laps.length }) } }],
              }
            : { role: "assistant", content: "Here is what is running." },
          finish_reason: callTool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005 },
    });
  });
  const base = loopbackBase(server);
  const agentDir = agentDirWith("sk-prefix-test");
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-prefix-"));
  const answer = options.toolResult;
  const tools = wholeWall().map((tool) =>
    answer !== undefined && tool.name === "sessions_list"
      ? { ...tool, run: async (args: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: answer(Number(args.limit)) }] }) }
      : tool,
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
    await server.stop(true);
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
  // Measured at 95.4% of the later prompt. A floor, for the reason above.
  expect(shared / after.length).toBeGreaterThan(0.9);
});

/* ------------------------------------------------------------------ *
 * 4 — the turn boundary, which used to rewrite the prompt BACKWARDS.
 * ------------------------------------------------------------------ */

/**
 * THE FINDING THIS FILE WAS WRITTEN TO CATCH, NOW FIXED (#563 step 1).
 *
 * ── WHAT USED TO HAPPEN ─────────────────────────────────────────────────────
 * `compactToolResults` scoped its stubs to the CURRENT TURN — its lower bound
 * was the last human message — so on the next turn those results were no longer
 * "this turn's" and were sent IN FULL AGAIN: 5,514 characters where the previous
 * request had 79. A prefix cache matches from the front and stops at the first
 * byte that differs, so re-expanding a stub did not cost the expanded bytes, it
 * cost EVERY BYTE AFTER THEM. Measured from this socket at byte 17,125 of a
 * 24,072-byte prompt on turn 2 and 24,241 of 31,192 on turn 3 — 28.9% and 22.3%
 * of each prompt downstream of a rewrite, with the missed tail roughly constant
 * (6,947 then 6,951) while the prompt grows.
 *
 * ── WHAT HAPPENS NOW ────────────────────────────────────────────────────────
 * The lower bound is gone: the scope is "everything but the newest result run",
 * so a result goes full → stub EXACTLY ONCE, at the lap after the one that read
 * it, and never back. The two tests below are the two halves of that claim —
 * the boundary is a pure append, and every divergence that does happen is one
 * named result flipping, once.
 *
 * ── AND IT IS A BEHAVIOUR CHANGE, WHICH IS WHY IT IS SAID OUT LOUD ──────────
 * A later turn can no longer re-read an earlier turn's full result; it sees the
 * stub. The stub names the tool and the first three ids, the tool is one call
 * away, `agent_rows` holds every answer whole and `recall` searches it.
 */

/** The lead every stub carries, and the only thing these tests match on by
 *  text — everything else is counts and named call ids. */
const STUB_LEAD = "[earlier lap] sessions_list:";

/**
 * A result at the size the issue measured for a real `sessions_outline` answer,
 * and NAMED PER CALL so two of them can be told apart. That is what makes the
 * #811 rule checkable here: a stub claiming "60 sessions" has to name ids that
 * were in the result IT replaced, so `s2_0` in call 1's stub would be a stub of
 * the wrong answer and a passing count would be hiding it.
 */
const wideResult = (call: number) =>
  JSON.stringify({ sessions: Array.from({ length: 60 }, (_, index) => ({ id: `s${call}_${index}`, title: `a session about something ${index}`, state: "idle", project: "telar" })) });

test("a previous turn's results stay stubbed, so the next turn's first lap only appends", async () => {
  const laps = await conversation({ says: ["what is running?", "and the rail?"], lapsPerTurn: 3, toolResult: wideResult });
  const lastOfFirst = laps.filter((lap) => lap.turn === 1).at(-1)!.body;
  const firstOfSecond = laps.find((lap) => lap.turn === 2)!.body;

  // COUNTS FIRST, because a prompt that got shorter by losing history reads as
  // an excellent result on every byte and ratio underneath this.
  const before = resultsIn(lastOfFirst);
  const after = resultsIn(firstOfSecond);
  expect([...before.keys()]).toEqual(["call_1", "call_2"]);
  expect([...after.keys()]).toEqual(["call_1", "call_2"]);
  expect(callsIn(firstOfSecond)).toEqual(["call_1", "call_2"]);
  // AND NOTHING THE ASSISTANT ASKED FOR IS LEFT UNANSWERED. An orphaned call is
  // a 400 from every route Go serves, not a cheaper prompt — see
  // `answerOrphanedCalls`, which exists because that happened.
  for (const id of callsIn(firstOfSecond)) expect(after.get(id)).toBeDefined();

  // THE CHANGE ITSELF: the stub the turn that ended made is the stub the next
  // turn sends, byte for byte. It used to be the full result again.
  expect(before.get("call_1")).toStartWith(STUB_LEAD);
  expect(after.get("call_1")).toBe(before.get("call_1")!);
  // …and it names ids out of the answer it replaced rather than the other one.
  expect(after.get("call_1")).toContain("60 sessions: s1_0, s1_1, s1_2 (+57)");
  expect(after.get("call_1")).not.toContain("s2_");
  // THE NEWEST RUN IS STILL WHOLE in both — it is the answer to the call the
  // model made one superstep ago, and stubbing it would be answering with a
  // summary of the thing it just asked for.
  expect(after.get("call_2")).toBe(wideResult(2));

  // SO THE DIVERGENCE IS PAST EVERY RESULT ALREADY SENT, named by the call it
  // is past rather than asserted as a ratio: the later request differs from the
  // earlier one only where it appends the answer and the new question.
  const shared = commonPrefix(lastOfFirst, firstOfSecond);
  expect(shared).toBeGreaterThan(resultAnchor(firstOfSecond, "call_2"));
  // Measured at 99.6% of the later prompt, against 71.1% before this change. A
  // floor, because the tail is allowed to grow — that growth is the new turn.
  expect(shared / firstOfSecond.length).toBeGreaterThan(0.95);
});

test("each result flips to its stub exactly once, and the divergence is that result's", async () => {
  const laps = await conversation({ says: ["what is running?", "and the rail?"], lapsPerTurn: 3, toolResult: wideResult });
  expect(laps.map((lap) => lap.turn)).toEqual([1, 1, 1, 2, 2, 2]);
  const bodies = laps.map((lap) => lap.body);

  /**
   * THE LEDGER EVERY CLAIM BELOW IS READ OFF — which results each request
   * carried, and which of them were stubs. Written out in full rather than
   * summarised, because the property is about the WHOLE sequence: a set that
   * only grows, and an id that never leaves it.
   */
  const held = bodies.map(resultsIn);
  const stubs = held.map((results) => [...results].filter(([, text]) => text.startsWith(STUB_LEAD)).map(([id]) => id));
  const whole = held.map((results) => [...results].filter(([, text]) => !text.startsWith(STUB_LEAD)).map(([id]) => id));

  expect(stubs).toEqual([[], [], ["call_1"], ["call_1"], ["call_1", "call_2"], ["call_1", "call_2", "call_4"]]);
  expect(whole).toEqual([[], ["call_1"], ["call_2"], ["call_2"], ["call_4"], ["call_5"]]);
  // Which says the same thing twice over: every result is present on every lap
  // after the one that produced it — nothing was DROPPED to make the prompt
  // small — and exactly one run is whole once there is any result at all.
  expect(held.map((results) => results.size)).toEqual([0, 1, 2, 2, 3, 4]);
  for (const [index, body] of bodies.entries()) {
    for (const id of callsIn(body)) expect(held[index]!.get(id)).toBeDefined();
  }

  /**
   * THE TURN BOUNDARY, NAMED. Turn 1's last request had `call_2` whole; turn
   * 2's SECOND lap is the first request in which `call_2` is a stub, and that
   * flip is the only difference between them that a cache can see. So the
   * divergence lands strictly inside `call_2`'s result: past `call_1`'s, which
   * was already a stub on both sides of the boundary, and before `call_2`'s own
   * anchor.
   */
  const lastOfFirstTurn = bodies[2]!;
  const secondLapOfSecondTurn = bodies[4]!;
  const shared = commonPrefix(lastOfFirstTurn, secondLapOfSecondTurn);
  expect(shared).toBeGreaterThan(resultAnchor(secondLapOfSecondTurn, "call_1"));
  expect(shared).toBeLessThan(resultAnchor(secondLapOfSecondTurn, "call_2"));
  // And the flip went the CHEAP way — a stub replacing a result, not a result
  // replacing a stub.
  expect(held[2]!.get("call_2")).toBe(wideResult(2));
  expect(held[4]!.get("call_2")).toStartWith(STUB_LEAD);
  expect(held[4]!.get("call_2")).toContain("60 sessions: s2_0, s2_1, s2_2 (+57)");
});

/* ------------------------------------------------------------------ *
 * 5 — the reporting, which is what makes any of this checkable.
 * ------------------------------------------------------------------ */

test("the turn's usage row carries what the provider said about its cache", async () => {
  const laps: string[] = [];
  const server = serveLoopback(async (request) => {
    laps.push(await request.text());
    return Response.json({
      id: "chatcmpl_1",
      choices: [{ index: 0, message: { role: "assistant", content: "Nothing is running." }, finish_reason: "stop" }],
      // THE SHAPE THE CHAT ROUTE REPORTS IT IN. `prompt_tokens` INCLUDES the
      // cached ones, which is why the row's `cacheRead` is a fraction of its
      // `input` rather than a number beside it.
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010, prompt_tokens_details: { cached_tokens: 880 } },
    });
  });
  const base = loopbackBase(server);
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
  await server.stop(true);
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
  const server = serveLoopback(async (request) => {
    await request.text();
    return Response.json({
      id: "chatcmpl_1",
      choices: [{ index: 0, message: { role: "assistant", content: "Nothing is running." }, finish_reason: "stop" }],
      // TOKENS COUNTED, CACHE UNMENTIONED — the case an OpenAI-compatible
      // server is entitled to, and the one a zero would misreport.
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    });
  });
  const base = loopbackBase(server);
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
  await server.stop(true);
});
