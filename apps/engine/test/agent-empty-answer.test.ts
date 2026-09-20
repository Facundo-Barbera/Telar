/**
 * A PROVIDER THAT ANSWERS 200 AND SAYS NOTHING — issue #710.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * A 4xx or 5xx raises a real provider error naming a reason. A 200 whose body
 * is not a completion raises NOTHING on the way in, and every client library on
 * this path then dies reading a field of `undefined` three frames down. Measured
 * on this suite's stub before the fix, across all three routes and both
 * streaming modes — six distinct errors, and not one of them names a model, a
 * route, or the fact that a provider was involved:
 *
 *   chat, either mode      TypeError: undefined is not an object (evaluating
 *                          '(await this.generatePrompt([promptValue], options,
 *                          options?.callbacks)).generations[0][0].message')
 *   messages, buffered     TypeError: undefined is not an object (evaluating
 *                          'messages.length')
 *   messages, streaming    Error: No chunks returned from Anthropic API.
 *   responses, buffered    TypeError: undefined is not an object (evaluating
 *                          'response.output.map')
 *   responses, empty SSE   TypeError: rsp is not an Object. (evaluating
 *                          '"object" in rsp')
 *   responses, streaming   the `generations[0][0]` one again
 *
 * On #610 the first of those cost two people twenty minutes before anyone
 * established it was not a defect in the diff under review.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
 * THE MESSAGE, not merely the throw. A test that asserted `toThrow()` would
 * pass against every one of the six strings above, which is exactly the outcome
 * #710 was filed about. So every case below asserts what a PERSON READS: the
 * model id, the route and its endpoint, and that the call succeeded at the HTTP
 * level and came back empty.
 *
 * AND THE TWO THINGS IT MUST NOT DO — swallow a good error, and grow into one
 * that leaks a key. Both have their own test at the bottom.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { AgentEmptyAnswerError, agentChatModel } from "../src/agent/model";
import { loopbackBase, serveLoopback } from "./loopback-server";

/** Rung 1 on disk, so no test ever reaches a developer's real key — the rule
 *  `agent-model.test.ts` states and the reason it states it. */
function agentDirWith(key: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-empty-answer-"));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ key }), { mode: 0o600 });
  return dir;
}

/** The key every model below is built with. Long and recognisable on purpose:
 *  the leak test greps the finished sentence for it. */
const KEY = "sk-telar-empty-answer-secret";

/** An id on each route, from `GO_ROUTES` — named so a test reads as a route. */
const ROUTES = [
  { route: "chat", model: "deepseek-v4.1-flash", endpoint: "POST /chat/completions" },
  { route: "messages", model: "union-alpha", endpoint: "POST /messages" },
  { route: "responses", model: "grok-4.6", endpoint: "POST /responses" },
] as const;

/**
 * THE TWO SHAPES A 200 CAN BE WRONG IN, and both are real.
 *
 * `json200` is #710's own reproduction — the gateway or error page that answers
 * a completion request with some other JSON document.
 *
 * `emptySSE` is the streaming half of the same defect, and it is NOT what the
 * issue described: a well-formed `text/event-stream` that carries no event at
 * all. It matters because a turn STREAMS, so this is the shape a proxy failing
 * mid-chain would actually produce in front of a person, and before the fix it
 * died exactly as opaquely.
 */
const BAD: Record<string, () => Response> = {
  json200: () => Response.json({ ok: true }),
  emptySSE: () => new Response(new ReadableStream({ start: (controller) => controller.close() }), { headers: { "Content-Type": "text/event-stream" } }),
};

async function withStub<T>(answer: (request: Request) => Response | Promise<Response>, run: (base: string) => Promise<T>): Promise<T> {
  // Through `serveLoopback`, which pins the hostname — #610. A wildcard bind can
  // be handed a port another loopback listener owns and then watch IT answer,
  // which in this file would mean asserting a neighbour's silence.
  const server: Server = serveLoopback(answer);
  try {
    return await run(loopbackBase(server));
  } finally {
    await server.stop(true);
  }
}

function modelOn(base: string, model: string, streaming: boolean) {
  return agentChatModel({ threadId: "thread_710", model, agentDir: agentDirWith(KEY), readCliKey: () => undefined, base, streaming });
}

/** The error a call raised, or a failure saying it did not raise one. */
async function errorFrom(chat: ReturnType<typeof modelOn>): Promise<Error> {
  try {
    await chat.invoke([new HumanMessage("hello")]);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call resolved — a provider that answered nothing must not look like a turn that worked");
}

for (const { route, model, endpoint } of ROUTES) {
  for (const shape of Object.keys(BAD)) {
    for (const streaming of [false, true]) {
      test(`${route}: a 200 with no completion (${shape}, streaming=${streaming}) names the model, the route and the 200`, async () => {
        await withStub(BAD[shape]!, async (base) => {
          const error = await errorFrom(modelOn(base, model, streaming));

          // ITS OWN CLASS, so a caller can branch without reading prose.
          expect(error).toBeInstanceOf(AgentEmptyAnswerError);
          const raised = error as AgentEmptyAnswerError;
          expect(raised.model).toBe(model);
          expect(raised.route).toBe(route);
          expect(raised.status).toBe(200);

          // AND THE SENTENCE ITSELF — the actual deliverable of #710.
          expect(raised.message).toContain(model);
          expect(raised.message).toContain(endpoint);
          expect(raised.message).toContain(`${route} route`);
          expect(raised.message).toContain("HTTP 200");
          expect(raised.message).toContain("came back with nothing");

          // NOT THE STRING THE LIBRARY USED TO THROW ON ITS OWN. If this ever
          // fails, the guard stopped running and the opaque `TypeError` is back.
          expect(raised.message).not.toMatch(/^TypeError/);
        });
      });
    }
  }
}

/**
 * THE HALF THAT IS EASY TO GET WRONG — a real provider error must survive.
 *
 * The guard re-describes what followed a 2xx and nothing else. A 400 already
 * carries the reason the provider gave, and replacing it with "the model
 * returned no answer" would be #710's own defect pointed the other way: a
 * sentence that names a cause it does not know.
 */
for (const { route, model } of ROUTES) {
  test(`${route}: a 400 keeps the provider's own reason and is not re-described`, async () => {
    await withStub(
      () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
      async (base) => {
        const error = await errorFrom(modelOn(base, model, false));
        expect(error).not.toBeInstanceOf(AgentEmptyAnswerError);
        expect(error.message).toContain("model not found");
      },
    );
  });
}

/**
 * AND A GOOD ANSWER IS STILL A GOOD ANSWER, on every route and both modes.
 *
 * This is the regression the fix could plausibly cause and the reason it is
 * here: the guard sits on `_generate` and `_streamResponseChunks`, which is the
 * path EVERY turn takes. The `fetch` wrapper that feeds it reads three response
 * headers and hands the response back untouched — it never clones or buffers a
 * body — and a streaming answer arriving intact is what proves it.
 */
const GOOD: Record<string, (streaming: boolean) => Response> = {
  chat: (streaming) =>
    streaming
      ? sse([{ id: "chatcmpl_1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }], { done: true })
      : Response.json({ id: "chatcmpl_1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  messages: (streaming) =>
    streaming
      ? sse([
          { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "union-alpha", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ], { named: true })
      : Response.json({ id: "msg_1", type: "message", role: "assistant", model: "union-alpha", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 1 } }),
  responses: (streaming) => {
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "grok-4.6",
      output: [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
    return streaming
      ? sse([
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] } },
          { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
          { type: "response.output_item.done", output_index: 0, item: response.output[0] },
          { type: "response.completed", response },
        ])
      : Response.json(response);
  },
};

/**
 * An SSE body, in the dialect the route's own client reads.
 *
 * `done` adds chat/completions' `[DONE]` sentinel, which the two other wire
 * formats do not use — they end on their own terminal event. `named` puts an
 * `event:` line in front of each frame, which `@anthropic-ai/sdk` REQUIRES:
 * given bare `data:` frames it parses the stream as empty, which this file's
 * own guard then reports as a provider that said nothing.
 */
function sse(chunks: { type?: string }[], options: { done?: boolean; named?: boolean } = {}): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          const frame = `${options.named && chunk.type ? `event: ${chunk.type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`;
          controller.enqueue(new TextEncoder().encode(frame));
        }
        if (options.done) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/** The answer's text, whether the route returned a string or content blocks —
 *  two of the three wire formats return blocks, and `String(content)` on one of
 *  those is `[object Object]`. */
function textOf(message: AIMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((block) => (typeof block === "string" ? block : ((block as { text?: string }).text ?? ""))).join("");
}

for (const { route, model } of ROUTES) {
  for (const streaming of [false, true]) {
    test(`${route}: a real completion still arrives (streaming=${streaming})`, async () => {
      await withStub(
        () => GOOD[route]!(streaming),
        async (base) => {
          const answer = (await modelOn(base, model, streaming).invoke([new HumanMessage("hello")])) as AIMessage;
          expect(textOf(answer)).toContain("ok");
        },
      );
    });
  }
}

/**
 * THE SENTENCE NAMES A MODEL AND A ROUTE AND NEVER A CREDENTIAL.
 *
 * An error that grows detail is an error that can grow the wrong detail, and
 * the body of a 200-shaped-wrong answer is the likeliest carrier: a proxy's
 * error page is exactly the kind of document that echoes the request — headers
 * included — back at you. So the guard describes the body's TYPE and SIZE and
 * never its content, and this asserts it against a stub that puts the key in
 * the answer on purpose.
 */
test("the message describes the body and never quotes it, so no credential can reach a person", async () => {
  await withStub(
    (request) => Response.json({ ok: true, youSent: request.headers.get("authorization"), alsoThis: `${KEY} again` }),
    async (base) => {
      const error = await errorFrom(modelOn(base, "deepseek-v4.1-flash", false));
      expect(error).toBeInstanceOf(AgentEmptyAnswerError);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("Bearer");
      expect(error.message).not.toContain("youSent");
      // What it says instead: the type and the size, which cannot carry a key.
      expect(error.message).toContain("application/json");
      expect(error.message).toContain("bytes");
    },
  );
});

/**
 * THE `cause` IS KEPT, so the frame the library actually died in is not lost.
 *
 * The sentence is for the person; the cause is for whoever has to fix the
 * library version. `union-alpha` buffered is the case where a real underlying
 * error exists — the chat route produces an empty RESULT rather than a throw,
 * and there is honestly nothing to attach there.
 */
test("the library's own error is kept as the cause rather than discarded", async () => {
  await withStub(BAD.json200!, async (base) => {
    const error = await errorFrom(modelOn(base, "union-alpha", false));
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(error.message).toContain("Underlying: TypeError");
  });
});
