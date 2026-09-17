/**
 * THE ONE TEST THAT TOUCHES THE REAL SERVICE — off unless asked for (#526,
 * moved to the Agent's own factory by #531).
 *
 * SKIPPED UNLESS `TELAR_LIVE_SMOKE=1`, so it never runs in CI, never runs on a
 * contributor's machine by accident, and never spends anybody's credit as a
 * side effect of `bun test`. Everything else about the Agent is tested against
 * a scripted model inside the test process; this exists to answer the one
 * question a fake cannot — does the real endpoint accept what this build
 * actually sends.
 *
 * ── IT GOES THROUGH `agentChatModel`, NOT AROUND IT ─────────────────────────
 * The first version of this file built its own `fetch` and its own headers,
 * which proved the ENDPOINT and not the code path. What ships is
 * `@langchain/openai` behind a `fetch` wrapper that forces the two promised
 * headers — and that wrapper exists precisely because the client library
 * overrode one of them. So the smoke drives the factory the runtime drives,
 * and a regression in the wrapper fails here rather than in somebody's log.
 *
 * ── THE KEY IS RESOLVED THE WAY A TURN RESOLVES IT ──────────────────────────
 * `resolveGoCredential` with the same three rungs. If that finds nothing the
 * test says which rungs were empty and stops; it does not fall back to a key
 * typed here, and it does not go looking anywhere a turn would not. Rung 1 is
 * read from a real engine root when `TELAR_HOME` names one, so a machine whose
 * key is pasted into Telar is smoked on that key.
 *
 * ── NOTHING IT PRINTS CAN CARRY A KEY ───────────────────────────────────────
 * Every line goes through `say`, which runs `redactKey` over it first. The
 * source is named by RUNG (`describeGoCredential`), which is the only thing
 * about a credential this codebase will say out loud.
 *
 * ── THREE CALLS, AND THAT IS THE BUDGET ─────────────────────────────────────
 * One `GET /models` with no credential (the docs publish it as open), and TWO
 * completions capped at a single token each — the plain one, and the tool round
 * trip #549 added. No loop and no retry: a smoke test that retried would be one
 * that could bill somebody twice for a mistake.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { goRouteGaps } from "../src/agent/catalogue";
import { describeGoCredential, redactKey, resolveGoCredential } from "../src/agent/credentials";
import { DEFAULT_GO_MODEL, readOpenCodeGoModels } from "../src/agent/go";
import { agentChatModel } from "../src/agent/model";

const LIVE = process.env.TELAR_LIVE_SMOKE === "1";

/** The thread this smoke is on, so the upstream sees one conversation for it —
 *  the same header a real turn carries, and deliberately not a real thread id. */
const SMOKE_THREAD = "thread_telar_live_smoke";

/** Rung 1's directory when this machine has an engine root, so a key pasted
 *  into Telar is the one smoked. Absent falls through to rungs 2 and 3. */
const agentDir = process.env.TELAR_HOME ? path.join(process.env.TELAR_HOME, "engine", "agent") : undefined;

/**
 * THE MODEL THAT SAID NO (#549) — deliberately NOT `DEFAULT_GO_MODEL`.
 *
 * `kimi-k3` is the default and is OpenAI-shaped, and it accepted the very
 * conversation this smoke is about; the 400 came from `omen-alpha`, which
 * OpenCode Go proxies to an Anthropic-shaped upstream. A smoke for that bug run
 * against the default would pass on every build, including the broken one.
 * `TELAR_LIVE_SMOKE_MODEL` points it at another route when Go's model list
 * changes underneath.
 */
const TOOL_SMOKE_MODEL = process.env.TELAR_LIVE_SMOKE_MODEL?.trim() || "omen-alpha";

describe.skipIf(!LIVE)("OpenCode Go, live, through the Agent's own factory", () => {
  const credential = resolveGoCredential({ ...(agentDir ? { agentDir } : {}) });
  /** Print, with any key scrubbed first. The backstop is applied even to lines
   *  that could not contain one — a redaction with an exception is a redaction
   *  somebody will eventually route around. */
  const say = (line: string) => console.log(redactKey(line, credential?.key));

  test("the resolver finds a usable credential, or says which rungs were empty", () => {
    say(`[live] credential: ${describeGoCredential(credential)}`);
    // A FAILURE HERE IS THE REPORT, not a guess: the next two tests cannot say
    // anything about the service if there is nothing to call it with.
    expect(credential, "no key on any of the three rungs — paste one in Settings, export OPENCODE_API_KEY, or sign the OpenCode CLI in").toBeDefined();
  });

  test("the model list answers, without a credential", async () => {
    const answer = await readOpenCodeGoModels();
    const ids = answer.models.map((model) => model.id);
    say(`[live] models → ${ids.length}, default ${DEFAULT_GO_MODEL} ${ids.includes(DEFAULT_GO_MODEL) ? "served" : "NOT in list"}${answer.message ? ` (${answer.message})` : ""}`);
    expect(ids.length).toBeGreaterThan(0);
  });

  /**
   * THE ROUTE TABLE, AGAINST THE REAL LIST (#551).
   *
   * `agent-catalogue.test.ts` asks the same question of a RECORDED list, which
   * is what CI can afford and what makes the tripwire fire on a fixture
   * refresh. This asks the service, so a smoke run says the day Go adds a model
   * rather than the day somebody re-records the fixture. The remedy is the
   * same: read the "Model ID / Endpoint" table at opencode.ai/docs/go and add
   * the row to `GO_ROUTES`.
   */
  test("every id Go serves has a transcribed route", async () => {
    const ids = (await readOpenCodeGoModels()).models.map((model) => model.id);
    const gaps = goRouteGaps(ids);
    say(`[live] routes → ${ids.length - gaps.length}/${ids.length} placed${gaps.length ? `, missing ${gaps.join(", ")}` : ""}`);
    expect(gaps, "transcribe these from the endpoint table at opencode.ai/docs/go into GO_ROUTES").toEqual([]);
  });

  test("one completion, one token, through agentChatModel", async () => {
    if (!credential) return;
    const model = agentChatModel({
      threadId: SMOKE_THREAD,
      ...(agentDir ? { agentDir } : {}),
      // NOT STREAMED, deliberately: what this proves is that the headers, the
      // auth and the model id are accepted. Streaming is covered by the runtime
      // suite against a scripted model, chunk by chunk.
      streaming: false,
      maxTokens: 1,
    });
    const answer = (await model.invoke("hi")) as AIMessage;
    const usage = answer.usage_metadata;
    say(`[live] completion → ok, usage ${usage ? JSON.stringify(usage) : "(not reported)"}`);
    // The CONTENT is never printed: a completion is the model's words and this
    // test has no business putting them in a log. That it came back at all is
    // the whole assertion.
    expect(answer).toBeDefined();
  });

  /**
   * THE ONE THAT WOULD HAVE CAUGHT #549 — a tool result on the wire.
   *
   * ── WHY THE EXCHANGE IS BUILT RATHER THAN PROVOKED ──────────────────────────
   * The request that failed was the SECOND one of a lap: the one carrying a
   * tool result back. Asking a model to please call a tool and then answering
   * it costs two completions and still depends on the model choosing to — a
   * smoke that sometimes sends the shape it is testing is not a smoke. So the
   * prior lap is handed over as history, which puts exactly the message #549 is
   * about in front of the model on one call, with the tool declared alongside
   * it so the request is a tool-using request in both directions.
   *
   * ── AND THE STATUS IS READ FROM THE RESPONSE, NOT INFERRED ──────────────────
   * `fetchImpl` is the injection point the factory already has for a test that
   * wants to watch the socket. The number it records is what gets reported: a
   * smoke whose report is "it did not throw" is one that cannot tell a 200 from
   * a 200-shaped error page. On a failure the provider's own sentence is
   * printed — redacted like every other line — because that sentence is how the
   * owner found this bug in the first place.
   */
  test("a tool round trip is accepted by the model that rejected one", async () => {
    if (!credential) return;
    let status = 0;
    const model = agentChatModel({
      threadId: SMOKE_THREAD,
      model: TOOL_SMOKE_MODEL,
      ...(agentDir ? { agentDir } : {}),
      streaming: false,
      maxTokens: 1,
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        status = response.status;
        return response;
      },
    });
    const withTool = model.bindTools!([
      {
        type: "function",
        function: {
          name: "telar_smoke_status",
          description: "Report whether the machine is well. Used only by Telar's live smoke.",
          parameters: { type: "object", properties: { probe: { type: "string" } }, required: ["probe"] },
        },
      },
    ]);

    try {
      await withTool.invoke([
        new HumanMessage("Is the machine well?"),
        new AIMessage({ content: "", tool_calls: [{ id: "call_telar_smoke", name: "telar_smoke_status", args: { probe: "live" } }] }),
        // THE MESSAGE THE FIX IS ABOUT: the call id and the answer, no `name`.
        new ToolMessage({ tool_call_id: "call_telar_smoke", content: "the machine is well" }),
      ]);
    } catch (error) {
      say(`[live] ${TOOL_SMOKE_MODEL} tool round trip → ${status || "no response"} ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    say(`[live] ${TOOL_SMOKE_MODEL} tool round trip → ${status}`);
    expect(status).toBe(200);
  });
});
