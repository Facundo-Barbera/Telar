/**
 * THE AGENT'S MODEL FACTORY — the three headers, the three routes, and the
 * refusal (#531, #571).
 *
 * What must not drift:
 *
 *   - the agent string, the session header and the key all reach the wire, and
 *     the key reaches it exactly once;
 *   - `x-opencode-session` is the THREAD id, so one Telar conversation is one
 *     upstream conversation;
 *   - the default model is `go.ts`'s, not a second copy;
 *   - no key is a refusal a settings pane can act on, never a quiet fallback;
 *   - no message reaches the wire with a `name` on it, because half the models
 *     OpenCode Go serves reject that field (#549);
 *   - the ROUTE decides the client, the endpoint, the credential header and the
 *     spelling of effort — and the id alone decides the route (#571).
 *
 * EVERY ROUTE ASSERTION IS MADE FROM THE SOCKET, which is this file's standing
 * rule and the reason it exists: what a client library was configured with and
 * what it sent are two different facts, and this suite has been paid twice for
 * knowing the difference (the `User-Agent` a library overrode, and the
 * `reasoningEffort` field that never reached a chat body).
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { AgentCredentialError, agentChatModel } from "../src/agent/model";
import { DEFAULT_GO_MODEL } from "../src/agent/go";
import { TELAR_ENGINE_VERSION } from "../src/version";

/**
 * A REAL `agent/` DIRECTORY WITH A REAL KEY IN IT — rung 1, on disk.
 *
 * The rungs below it are the machine's: `OPENCODE_API_KEY` in this process's
 * environment, and the OpenCode CLI's own credential. A test that did not write
 * one of its own would silently pass on a developer's machine using THEIR key,
 * which is how the first version of this file spent real calls.
 */
function agentDirWith(key: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-key-"));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ key }), { mode: 0o600 });
  return dir;
}

/** One request, as it actually arrived. `path` is what makes the route legible
 *  — an id going to the wrong endpoint is the failure this suite is for. */
type Call = { path: string; headers: Headers; body: Record<string, unknown> };

/**
 * A server that records what it was asked and answers one short completion —
 * IN THE SHAPE THE ENDPOINT IT WAS ASKED ON RETURNS.
 *
 * All three answers are minimal but real: each client library parses what comes
 * back, and a stub in the wrong shape fails inside the library with an error
 * about the response rather than telling you anything about the request. The
 * bodies below are trimmed copies of what OpenCode Go actually returned on
 * 2026-09-17 — same field names, one token of content.
 */
async function withServer<T>(run: (base: string, seen: () => Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
      if (path.endsWith("/messages")) {
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "union-alpha",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      }
      if (path.endsWith("/responses")) {
        return Response.json({
          id: "resp_1",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "grok-4.6",
          output: [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
      }
      return Response.json({
        id: "chatcmpl_1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    },
  });
  try {
    /**
     * THE BASE ENDS IN `/v1`, LIKE THE REAL ONE, and that is load-bearing.
     *
     * `OPENCODE_GO_BASE` is `https://opencode.ai/zen/go/v1`, and the two client
     * families disagree about who owns that segment: `@langchain/openai` joins
     * its path straight on, while `@anthropic-ai/sdk` adds `/v1` itself. A test
     * server at a bare host would have hidden that — every route would have
     * looked fine — and the doubled `…/v1/v1/messages` would have been found by
     * a person whose turn 404'd. See `anthropicBaseOf`.
     */
    return await run(`http://127.0.0.1:${server.port}/v1`, () => calls);
  } finally {
    server.stop(true);
  }
}

/** An id on each route, from `GO_ROUTES`. Named here so a test reads as "the
 *  messages route" rather than as a model somebody happened to pick. */
const ON_MESSAGES = "union-alpha";
const ON_RESPONSES = "grok-4.6";

test("the three headers reach the wire, and the key reaches it once", async () => {
  await withServer(async (base, seen) => {
    const model = agentChatModel({
      threadId: "thread_abc",
      agentDir: agentDirWith("sk-test-key"),
      base,
      streaming: false,
    });
    const answer = (await model.invoke("hello")) as AIMessage;
    expect(String(answer.content)).toBe("ok");

    const headers = seen()[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer sk-test-key");
    expect(headers.get("user-agent")).toBe(`telar/${TELAR_ENGINE_VERSION}`);
    expect(headers.get("x-opencode-session")).toBe("thread_abc");
  });
});

test("the model id defaults to go.ts's, and a setting overrides it", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("sk-test-key");
    await agentChatModel({ threadId: "thread_abc", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.model).toBe(DEFAULT_GO_MODEL);

    await agentChatModel({ threadId: "thread_abc", model: "some-other-model", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.model).toBe("some-other-model");
  });
});

test("an empty model setting is the default rather than a model id nothing serves", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: "   ", agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.model).toBe(DEFAULT_GO_MODEL);
  });
});

test("no key on any rung refuses, and the refusal names all three", () => {
  let threw: unknown;
  try {
    agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith(""), readCliKey: () => undefined, base: "http://127.0.0.1:1" });
  } catch (error) {
    threw = error;
  }
  expect(threw).toBeInstanceOf(AgentCredentialError);
  const message = (threw as Error).message;
  expect(message).toContain("Settings");
  expect(message).toContain("OPENCODE_API_KEY");
  expect(message).toContain("OpenCode CLI");
});

test("the CLI's own key is reached when nothing nearer answers", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({
      threadId: "thread_abc",
      agentDir: agentDirWith(""),
      readCliKey: () => "sk-from-the-cli",
      base,
      streaming: false,
    }).invoke("hello");
    expect(seen()[0]!.headers.get("authorization")).toBe("Bearer sk-from-the-cli");
  });
});

/**
 * EFFORT — `reasoning_effort` on the wire (#539).
 *
 * THE SPELLING IS THE API'S. OpenCode Go's own docs publish the base URL and
 * the session header and no parameter list, but the endpoint is explicitly
 * OpenAI-compatible and `reasoning_effort` is that API's field for a reasoning
 * DEPTH. This test watches the socket rather than the configuration, which is
 * the same thing the header test above does and for the same reason: what
 * `ChatOpenAI` was told and what it sent are two different facts.
 */
test("effort reaches the wire as reasoning_effort when it is set", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("sk-test-key");
    await agentChatModel({ threadId: "thread_abc", effort: "high", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.reasoning_effort).toBe("high");

    await agentChatModel({ threadId: "thread_abc", effort: "low", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.reasoning_effort).toBe("low");
  });
});

test("an unset effort sends no reasoning field at all, rather than a default", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    // OMITTED, NOT DEFAULTED. A model with no reasoning mode is served today by
    // a request that does not mention reasoning; sending "medium" on its behalf
    // would change what every existing conversation asks for, and on a strict
    // server it is a 400 where there was an answer.
    expect("reasoning_effort" in seen()[0]!.body).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * A TOOL ROUND TRIP, AND THE FIELD THAT MUST NOT BE ON IT (#549).
 *
 * The Agent died mid-conversation on `omen-alpha` with `400 … messages[7]:
 * "name" is not supported by this endpoint`: OpenCode Go proxies some of its
 * models to an Anthropic-shaped upstream, and `@langchain/openai` had been
 * serialising the `name` the runtime put on every tool result. The
 * OpenAI-shaped routes accepted the identical thread, which is what made it
 * read as a bad model rather than a bad message.
 *
 * Both halves of the fix are watched from the socket, because that is the only
 * place the question is actually answered — measured on 1.5.13, a `ToolMessage`
 * built with a name arrives as `{role: "tool", content, name, tool_call_id}`.
 * ------------------------------------------------------------------ */

/** The messages of the first request, as they were serialised. */
const wireMessages = (body: Record<string, unknown>): Record<string, unknown>[] => body.messages as Record<string, unknown>[];

test("a tool round trip reaches the wire paired by tool_call_id, with no name on any message", async () => {
  await withServer(async (base, seen) => {
    const model = agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith("sk-test-key"), base, streaming: false });
    await model.invoke([
      new HumanMessage("what is running?"),
      new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "sessions_list", args: { settled: false } }] }),
      // BUILT THE WAY `runtime.ts` BUILDS ONE: the call id and the answer, and
      // nothing else. If that ever grows a `name` again this fails here.
      new ToolMessage({ tool_call_id: "call_1", content: "one session" }),
    ]);

    const messages = wireMessages(seen()[0]!.body);
    expect(messages.some((message) => "name" in message)).toBe(false);

    // PAIRED ON THE ID, which is the field every OpenAI-compatible route reads.
    const result = messages.find((message) => message.role === "tool")!;
    expect(result.tool_call_id).toBe("call_1");
    expect(result.content).toBe("one session");

    // AND THE TOOL'S NAME IS NOT LOST — it is where the protocol keeps it, on
    // the assistant's call. A strip that took this too would leave the model
    // unable to say which tool it had asked for.
    const assistant = messages.find((message) => message.role === "assistant")!;
    const calls = assistant.tool_calls as { id: string; function: { name: string } }[];
    expect(calls[0]!.function.name).toBe("sessions_list");
    expect(calls[0]!.id).toBe("call_1");
  });
});

test("a name the client library puts on a message is taken off before the socket sees it", async () => {
  await withServer(async (base, seen) => {
    const model = agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith("sk-test-key"), base, streaming: false });
    // THE LIBRARY'S OWN BEHAVIOUR, ON PURPOSE. This is the message the runtime
    // used to build, and it is what a future version that infers a name from a
    // tool call would build again. The wrapper is what makes that a no-op.
    await model.invoke([
      new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "sessions_list", args: {} }] }),
      new ToolMessage({ tool_call_id: "call_1", name: "sessions_list", content: "one session" }),
    ]);

    const messages = wireMessages(seen()[0]!.body);
    expect(messages.some((message) => "name" in message)).toBe(false);
    expect(messages.find((message) => message.role === "tool")!.tool_call_id).toBe("call_1");
  });
});

test("a request with nothing to strip is sent exactly as the library built it", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    // The ordinary path is the overwhelming majority of requests, and it does
    // not go through a re-serialisation to find that out.
    expect(wireMessages(seen()[0]!.body)).toEqual([{ role: "user", content: "hello" }]);
  });
});

/* ------------------------------------------------------------------ *
 * THE OTHER TWO ROUTES (#571).
 *
 * Go serves 38 ids on three endpoints and the id is the only thing that says
 * which. These tests assert the whole consequence of that choice from the
 * socket: the PATH, the CREDENTIAL HEADER, and the spelling of EFFORT. Each of
 * the three is a place a plausible-looking configuration produces a 401 or a
 * silently ignored setting, and none of them is visible from the factory's
 * return value.
 *
 * THE CREDENTIAL HEADERS ARE NOT SYMMETRIC, and that asymmetry is measured
 * rather than assumed — asked directly, `/messages` answers `401 Missing API
 * key.` to a Bearer token and `/responses` answers the same 401 to `x-api-key`.
 * See the header of `src/agent/model.ts`.
 * ------------------------------------------------------------------ */

test("a messages-route id goes to /messages, with the key as x-api-key and no Authorization", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, agentDir: agentDirWith("sk-test-key"), base, streaming: false }).invoke("hello");

    const call = seen()[0]!;
    expect(call.path).toBe("/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("sk-test-key");
    /**
     * AND NOTHING ON `Authorization` — THE ASSERTION THAT EARNED ITS KEEP.
     *
     * A bearer here would be a 401 upstream, which is the obvious reason. The
     * real one is what this caught: `@anthropic-ai/sdk` reads
     * `ANTHROPIC_AUTH_TOKEN` out of the ambient environment when its caller
     * leaves `authToken` undefined, and `@langchain/anthropic` leaves it
     * undefined — so on a machine with that variable set, this request went out
     * carrying a bearer token for an unrelated Anthropic account beside the Go
     * key it was supposed to use. `clientOptions.authToken: null` is the fix.
     *
     * This is why a header test asserts absence and not just presence. Nothing
     * about the factory's configuration mentions a second credential; only the
     * socket does.
     */
    expect(call.headers.get("authorization")).toBeNull();
    // The two promises `go.ts` makes survive the change of client library —
    // which is the whole reason they live in a fetch wrapper and not in a
    // per-client `defaultHeaders`.
    expect(call.headers.get("user-agent")).toBe(`telar/${TELAR_ENGINE_VERSION}`);
    expect(call.headers.get("x-opencode-session")).toBe("thread_abc");
    expect(call.body.model).toBe(ON_MESSAGES);
  });
});

test("a responses-route id goes to /responses, with the key as a bearer and no x-api-key", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, agentDir: agentDirWith("sk-test-key"), base, streaming: false }).invoke("hello");

    const call = seen()[0]!;
    expect(call.path).toBe("/v1/responses");
    expect(call.headers.get("authorization")).toBe("Bearer sk-test-key");
    expect(call.headers.get("x-api-key")).toBeNull();
    expect(call.headers.get("user-agent")).toBe(`telar/${TELAR_ENGINE_VERSION}`);
    expect(call.headers.get("x-opencode-session")).toBe("thread_abc");
    expect(call.body.model).toBe(ON_RESPONSES);
  });
});

test("a chat-route id still goes to /chat/completions, and so does an id nobody transcribed", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.path).toBe("/v1/chat/completions");

    // AN UNKNOWN ID GETS THE CHAT CLIENT — `AgentModel.supported`'s own rule.
    // Go's base is OpenAI-compatible, so a model added yesterday is far likelier
    // to answer there than anywhere else, and guessing is better than refusing.
    await agentChatModel({ threadId: "thread_abc", model: "brand-new-9", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.path).toBe("/v1/chat/completions");
  });
});

/**
 * EFFORT, IN EACH API'S OWN VOCABULARY.
 *
 * One setting, three spellings. The chat case is asserted further up as
 * `reasoning_effort`; these are the other two, and they are the ones a reader
 * would most reasonably expect to be wrong — `thinking` takes a token BUDGET
 * rather than a level, so the three words had to be given numbers.
 */
test("effort reaches /messages as a thinking budget sized by the word", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    for (const effort of ["low", "medium", "high"] as const) {
      await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, effort, agentDir, base, streaming: false }).invoke("hello");
    }
    expect(seen().map((call) => call.body.thinking)).toEqual([
      { type: "enabled", budget_tokens: 2_000 },
      { type: "enabled", budget_tokens: 8_000 },
      { type: "enabled", budget_tokens: 16_000 },
    ]);
  });
});

test("effort reaches /responses as reasoning.effort", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, effort: "high", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.reasoning).toMatchObject({ effort: "high" });

    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, effort: "low", agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.reasoning).toMatchObject({ effort: "low" });
  });
});

test("an unset effort mentions no reasoning on either of the new routes", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, agentDir, base, streaming: false }).invoke("hello");
    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, agentDir, base, streaming: false }).invoke("hello");
    // OMITTED, NOT DEFAULTED — the chat route's rule, unchanged. On `/messages`
    // it matters more, not less: a budget sent on behalf of somebody who never
    // asked for one is tokens they are billed for.
    expect("thinking" in seen()[0]!.body).toBe(false);
    expect(seen()[1]!.body.reasoning).toBeUndefined();
  });
});

/**
 * THE CEILING `/messages` REQUIRES, AND WHAT IT DOES TO THE BUDGET.
 *
 * `max_tokens` is mandatory in the Anthropic shape, and `budget_tokens` must be
 * strictly under it or the request is a 400. Both halves are asserted because
 * both are invisible: a missing ceiling fails on the first real turn, and a
 * budget that outgrew a small ceiling fails only for the caller that set one.
 */
test("the messages route sends a ceiling nobody asked for, because its API demands one", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    // Big enough to clear the `high` budget with an answer left over, and small
    // enough that `@anthropic-ai/sdk` will still send it without streaming —
    // it refuses a non-streaming request over 21,333. Both bounds are real, and
    // a ceiling raised past the upper one breaks this call, not a later one.
    expect(seen()[0]!.body.max_tokens).toBe(20_000);
  });
});

/**
 * TEMPERATURE STEPS ASIDE FOR THINKING, because the library will not let both
 * travel: `temperature is not supported when thinking is enabled` is thrown
 * before a request is built. A 0 nobody typed must not be what costs somebody
 * the reasoning they did ask for.
 */
test("a thinking request drops the default temperature, and one without it keeps it", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, effort: "medium", agentDir, base, streaming: false }).invoke("hello");
    expect("temperature" in seen()[0]!.body).toBe(false);

    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.temperature).toBe(0);
  });
});

/**
 * THE SAME RULE, THE OTHER NEW ROUTE — a default this factory invented is never
 * allowed to be the thing that costs somebody a model.
 *
 * The live smoke over all five `/responses` ids found `gpt-5.6-luna` answering
 * `400 … Unsupported parameter: 'temperature' is not supported with this
 * model`. Nobody types a temperature into `agent.json`; the 0 was this file's
 * own, and it was breaking a model for a value no person had chosen.
 */
test("the responses route sends no temperature of its own, and still sends one it was given", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, agentDir, base, streaming: false }).invoke("hello");
    expect("temperature" in seen()[0]!.body).toBe(false);

    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, temperature: 0.4, agentDir, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.temperature).toBe(0.4);
  });
});

test("the chat route still sends its temperature, because nothing there refuses one", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.temperature).toBe(0);
  });
});

test("a caller's own ceiling wins, and a budget that would not fit under it is dropped rather than sent", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, effort: "high", maxTokens: 1, agentDir: agentDirWith("k"), base, streaming: false }).invoke("hello");
    const body = seen()[0]!.body;
    expect(body.max_tokens).toBe(1);
    // THE LIVE SMOKE IS THE CALLER THIS IS FOR: it buys a single token to prove
    // a round trip and has no business paying for 16k of reasoning to do it.
    // The alternative — raising the ceiling to fit the budget — would overrule
    // the one thing the caller actually asked for.
    expect("thinking" in body).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Prompt caching — #563 item 3.
 * ------------------------------------------------------------------ */

/**
 * THE BREAKPOINTS THE ANTHROPIC SHAPE TAKES, AND THE TWO ROUTES THAT MUST NOT
 * SEE THEM.
 *
 * ASSERTED FROM THE SOCKET, like everything else in this file, and for a sharper
 * reason than usual: `cache_control` is added by a `fetch` wrapper AFTER
 * `@langchain/anthropic` has finished building the request, so there is no
 * configuration object anywhere that could be inspected instead. What was sent
 * is the only thing that is true.
 */
test("the messages route carries cache breakpoints on its tools, its system block and its last message", async () => {
  await withServer(async (base, seen) => {
    const model = agentChatModel({ threadId: "thread_abc", model: ON_MESSAGES, agentDir: agentDirWith("k"), base, streaming: false });
    await model
      .bindTools!([{ type: "function", function: { name: "sessions_list", description: "the rail", parameters: { type: "object", properties: {} } } }] as never)
      .invoke([new SystemMessage("the briefing"), new HumanMessage("hello")]);

    const body = seen()[0]!.body as { system?: unknown; tools?: unknown[]; messages?: unknown[] };
    const ephemeral = { type: "ephemeral" };

    // THE LARGEST BLOCK FIRST. Anthropic's prompt order is tools → system →
    // messages, so a breakpoint on the last tool is what keeps ~14 KB of tool
    // definitions cached when the system block changes — and it changes on every
    // turn, because `remember` rewrites the standing state and the digest is
    // rebuilt per turn.
    expect((body.tools as Record<string, unknown>[]).at(-1)!.cache_control).toEqual(ephemeral);
    // A STRING SYSTEM PROMPT BECOMES ONE MARKED TEXT BLOCK — the field has
    // nowhere to live on a bare string.
    expect(body.system).toEqual([{ type: "text", text: "the briefing", cache_control: ephemeral }]);
    // AND THE CONVERSATION SO FAR, on the last message's last content block.
    const last = (body.messages as Record<string, unknown>[]).at(-1)!;
    expect((last.content as Record<string, unknown>[]).at(-1)!.cache_control).toEqual(ephemeral);
  });
});

test("neither OpenAI-shaped route is given a field its API does not have", async () => {
  await withServer(async (base, seen) => {
    const agentDir = agentDirWith("k");
    await agentChatModel({ threadId: "thread_abc", agentDir, base, streaming: false }).invoke("hello");
    await agentChatModel({ threadId: "thread_abc", model: ON_RESPONSES, agentDir, base, streaming: false }).invoke("hello");
    /**
     * THE POINT IS NOT THAT THE FIELD WOULD BE REJECTED. It is that on these two
     * routes the caching is the PROVIDER'S and automatic, and it holds only
     * while the prefix is byte-identical between calls — so a field added here
     * would be the very thing that stops the cache working. The most useful
     * thing this wrapper can do for them is leave the body alone.
     */
    for (const call of seen()) expect(JSON.stringify(call.body)).not.toContain("cache_control");
  });
});
