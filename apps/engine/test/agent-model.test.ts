/**
 * THE AGENT'S MODEL FACTORY — the three headers, and the refusal (#531).
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
 *     OpenCode Go serves reject that field (#549).
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
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

/** A server that records what it was asked and answers one short completion. */
async function withServer<T>(run: (base: string, seen: () => { headers: Headers; body: Record<string, unknown> }[]) => Promise<T>): Promise<T> {
  const calls: { headers: Headers; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls.push({ headers: request.headers, body: (await request.json()) as Record<string, unknown> });
      return Response.json({
        id: "chatcmpl_1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    },
  });
  try {
    return await run(`http://127.0.0.1:${server.port}`, () => calls);
  } finally {
    server.stop(true);
  }
}

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
