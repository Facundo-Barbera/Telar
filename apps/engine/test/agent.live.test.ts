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
 * ── TWO CALLS, AND THAT IS THE BUDGET ───────────────────────────────────────
 * One `GET /models` with no credential (the docs publish it as open), and ONE
 * completion capped at a single token. No loop and no retry: a smoke test that
 * retried would be one that could bill somebody twice for a mistake.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
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
});
