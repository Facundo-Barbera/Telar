/**
 * DOES THE PREFIX ACTUALLY GET CACHED — the one question a local server cannot
 * answer (#563 item 3).
 *
 * ── WHY THIS IS A SEPARATE, SEPARATELY-GATED FILE ───────────────────────────
 * `agent-prefix.test.ts` proves the prefix is byte-identical between calls. That
 * is a fact about THIS codebase and it is worth defending on every commit. It is
 * not the same as the prefix being SERVED from a cache, which is a fact about
 * OpenCode Go and whatever it proxies to, and no local server can be asked it.
 *
 * SO THIS SPENDS SOMEBODY'S CREDIT, and it is off unless asked for BY ITS OWN
 * NAME. `agent.live.test.ts` is gated on `TELAR_LIVE_SMOKE`; this deliberately
 * does NOT share that gate, so the person who smokes the endpoint after a
 * dependency bump does not silently also buy a caching measurement. One command,
 * typed on purpose:
 *
 *     TELAR_LIVE_CACHE=1 bun test --cwd apps/engine test/agent-cache.live.test.ts
 *
 * `TELAR_HOME` may name an engine root so rung 1 of the key ladder is read the
 * way a real turn reads it; `TELAR_LIVE_CACHE_MODEL` points it at another id.
 *
 * ── THE BUDGET: FOUR CALLS, ONE OUTPUT TOKEN EACH ───────────────────────────
 * The prompt is large on purpose — it is the Agent's REAL system block and its
 * REAL 25-tool array, which is the thing whose caching is in question — and the
 * answer is capped at a single token, because this buys a measurement rather
 * than a reply. No retry: a smoke that retried could bill somebody twice for a
 * mistake, which is `agent.live.test.ts`'s rule and is kept here.
 *
 * ── WHAT THE FOUR CALLS ARE, AND WHY THE FOURTH IS THE INTERESTING ONE ──────
 *   1. COLD. The first send of this prefix. Whatever it reports is the floor.
 *   2. WARM. Byte-identical to 1. The difference between 1 and 2 IS the answer
 *      to "does Go forward and honour a prompt cache for this model".
 *   3. A LATER LAP. The same prefix with one more exchange appended — what the
 *      second lap of a turn really sends. A prefix cache should still hit.
 *   4. THE TURN BOUNDARY. The same conversation with one earlier tool result
 *      REWRITTEN from its compacted stub back to full text, which is what
 *      `compactToolResults` does to every prompt at every turn boundary (see
 *      `agent-prefix.test.ts`, which measures the rewrite landing ~71–78% into
 *      the prompt). If 3 hits and 4 does not, the cost of that rewrite is the
 *      difference, and that number is what decides whether fixing it is urgent
 *      or tidy.
 *
 * NOTHING IT PRINTS CAN CARRY A KEY — every line goes through `say`, which runs
 * `redactKey` first, the same rule `agent.live.test.ts` states.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { AgentFleetCapability, AgentQueryCapability } from "../src/agent/tools";
import type { NotesCapability, SessionsCapability, SocketTool } from "../src/mcp-socket";
import { AGENT_SELF_ID, agentToolSpecs, collectAgentTools } from "../src/agent/tools";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { TELAR_ORIENTATION } from "../src/orientation";
import { toolResultStub } from "../src/agent/compact";
import { describeGoCredential, redactKey, resolveGoCredential } from "../src/agent/credentials";
import { agentChatModel } from "../src/agent/model";

const LIVE = process.env.TELAR_LIVE_CACHE === "1";

/** The conversation this measurement is on, so the upstream sees one thread for
 *  it — and deliberately not a real one. */
const CACHE_THREAD = "thread_telar_cache_probe";

/** The id the Agent runs today. Overridable, because the point of the file is
 *  the measurement rather than this particular model. */
const MODEL = process.env.TELAR_LIVE_CACHE_MODEL?.trim() || "deepseek-v4.1-flash";

const agentDir = process.env.TELAR_HOME ? path.join(process.env.TELAR_HOME, "engine", "agent") : undefined;

/* ------------------------------------------------------------------ *
 * The real prompt. Not a fixture — the bytes a turn sends.
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
  ({ projects: async () => [], list: async () => [], read: async () => null, create: async () => ({}) as never, update: async () => null, remove: async () => false }) as never;

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

/** The system block as `runtime.ts` builds it: briefing, then orientation. */
const SYSTEM = new SystemMessage(`${AGENT_BRIEFING}\n\n${TELAR_ORIENTATION}`);

/** A tool result the size the issue measured for a real `sessions_outline`. */
const WIDE = JSON.stringify({
  sessions: Array.from({ length: 60 }, (_, index) => ({ id: `session_${index}`, title: `a session about something ${index}`, state: "idle", project: "telar" })),
});

const call = (id: string) => ({ id, name: "sessions_list", args: {}, type: "tool_call" as const });

/** Lap 1 of a turn: the question, the model's first call, its answer. */
const LAP_ONE = [
  new HumanMessage("what is running?"),
  new AIMessage({ content: "Looking.", tool_calls: [call("call_1")] }),
  new ToolMessage({ tool_call_id: "call_1", content: WIDE }),
];

describe.skipIf(!LIVE)("OpenCode Go, live, does the Agent's prefix get cached", () => {
  const credential = resolveGoCredential({ ...(agentDir ? { agentDir } : {}) });
  const say = (line: string) => console.log(redactKey(line, credential?.key));

  test("the resolver finds a usable credential, or says which rungs were empty", () => {
    say(`[cache] credential: ${describeGoCredential(credential)}`);
    expect(credential, "no key on any of the three rungs — paste one in Settings, export OPENCODE_API_KEY, or sign the OpenCode CLI in").toBeDefined();
  });

  test("four calls, and the numbers that answer item 3", async () => {
    const tools = wholeWall();
    const specs = agentToolSpecs(tools);
    say(`[cache] model: ${MODEL} — ${specs.length} tools, ${JSON.stringify(specs).length} chars of definitions`);

    /** One measured call. `maxTokens: 1` buys the round trip, not an answer. */
    const probe = async (label: string, messages: unknown[]): Promise<{ input: number; cached?: number }> => {
      const model = agentChatModel({
        threadId: CACHE_THREAD,
        model: MODEL,
        ...(agentDir ? { agentDir } : {}),
        streaming: false,
        maxTokens: 1,
      });
      const answer = (await model.bindTools!(specs as never).invoke(messages as never)) as { usage_metadata?: { input_tokens?: number; input_token_details?: { cache_read?: number } } };
      const usage = answer.usage_metadata;
      const input = usage?.input_tokens ?? 0;
      // ABSENT IS THE FINDING, NOT A ZERO. If Go forwards no cache statistics at
      // all this stays undefined on every call, and that IS the answer to item 3
      // — see the note at the bottom of this test.
      const cached = usage?.input_token_details?.cache_read;
      say(`[cache] ${label}: input ${input}, cache_read ${cached === undefined ? "NOT REPORTED" : cached} (${cached === undefined || input === 0 ? "—" : `${Math.round((cached / input) * 100)}%`})`);
      return { input, ...(cached === undefined ? {} : { cached }) };
    };

    const cold = await probe("1 cold      ", [SYSTEM, ...LAP_ONE.slice(0, 1)]);
    const warm = await probe("2 warm      ", [SYSTEM, ...LAP_ONE.slice(0, 1)]);
    // Lap 2 of the same turn: the earlier result is a STUB, which is what
    // `compactToolResults` sends once the lap that consumed it has passed.
    const stubbed = [SYSTEM, LAP_ONE[0]!, LAP_ONE[1]!, new ToolMessage({ tool_call_id: "call_1", content: toolResultStub("sessions_list", WIDE) }), new AIMessage({ content: "Still looking.", tool_calls: [call("call_2")] }), new ToolMessage({ tool_call_id: "call_2", content: WIDE })];
    const lap2 = await probe("3 later lap ", stubbed);
    // The NEXT turn: the same conversation with that stub expanded back to its
    // full text, which is exactly what crossing a turn boundary does.
    const expanded = [SYSTEM, ...LAP_ONE, new AIMessage({ content: "Still looking.", tool_calls: [call("call_2")] }), new ToolMessage({ tool_call_id: "call_2", content: WIDE }), new HumanMessage("and the rail?")];
    const boundary = await probe("4 boundary  ", expanded);

    /**
     * THE REPORT, AND IT IS THE POINT OF THE FILE. A failure here is a finding
     * rather than a bug: if `cache_read` is NOT REPORTED on all four lines
     * above, OpenCode Go does not forward cache statistics for this model, and
     * item 3 cannot be verified on it at all — which is worth landing and saying
     * plainly rather than shipping a change nobody can check.
     */
    const reported = [cold, warm, lap2, boundary].filter((probe) => probe.cached !== undefined).length;
    say(`[cache] cache statistics reported on ${reported} of 4 calls`);
    if (reported === 0) {
      say("[cache] FINDING: this model reports no cache statistics through Go. Item 3's prefix work cannot be measured on it.");
    } else {
      say(`[cache] warm vs cold: ${(warm.cached ?? 0) - (cold.cached ?? 0)} more tokens read from cache`);
      say(`[cache] later lap: ${warm.cached === undefined ? "—" : `${lap2.cached ?? 0} of ${lap2.input}`}`);
      say(`[cache] turn boundary: ${boundary.cached ?? 0} of ${boundary.input} — the gap against line 3 is what the stub re-expansion costs`);
    }
    // THE ASSERTION IS ONLY THAT THE CALLS HAPPENED. Every number above is
    // reported rather than required: this file measures a service, and a service
    // that answers honestly with "no caching" must not be a red test.
    expect(cold.input).toBeGreaterThan(0);
    expect(warm.input).toBeGreaterThan(0);
  });
});
