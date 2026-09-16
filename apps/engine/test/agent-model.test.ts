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
 *   - no key is a refusal a settings pane can act on, never a quiet fallback.
 */
import { expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { AgentCredentialError, agentChatModel } from "../src/agent/model";
import { DEFAULT_GO_MODEL } from "../src/agent/go";
import { TELAR_ENGINE_VERSION } from "../src/version";

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
      instanceEnv: { OPENCODE_API_KEY: "sk-test-key" },
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
    const env = { OPENCODE_API_KEY: "sk-test-key" };
    await agentChatModel({ threadId: "thread_abc", instanceEnv: env, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.model).toBe(DEFAULT_GO_MODEL);

    await agentChatModel({ threadId: "thread_abc", model: "some-other-model", instanceEnv: env, base, streaming: false }).invoke("hello");
    expect(seen()[1]!.body.model).toBe("some-other-model");
  });
});

test("an empty model setting is the default rather than a model id nothing serves", async () => {
  await withServer(async (base, seen) => {
    await agentChatModel({ threadId: "thread_abc", model: "   ", instanceEnv: { OPENCODE_API_KEY: "k" }, base, streaming: false }).invoke("hello");
    expect(seen()[0]!.body.model).toBe(DEFAULT_GO_MODEL);
  });
});

test("no key on any rung refuses, and the refusal names all three", () => {
  let threw: unknown;
  try {
    agentChatModel({ threadId: "thread_abc", instanceEnv: {}, readCliKey: () => undefined, base: "http://127.0.0.1:1" });
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
      instanceEnv: {},
      readCliKey: () => "sk-from-the-cli",
      base,
      streaming: false,
    }).invoke("hello");
    expect(seen()[0]!.headers.get("authorization")).toBe("Bearer sk-from-the-cli");
  });
});
