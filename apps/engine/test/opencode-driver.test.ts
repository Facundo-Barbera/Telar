import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { TurnObservation, type TurnObservation as Observation } from "@telar/engine-client";
import { createOpenCodeDriver } from "../src/opencode/driver";
import type { DriverRun } from "../src/provider-contract";

function fixture(options: { lostAck?: boolean; permission?: boolean; question?: boolean; admission?: Promise<void>; missingAdmission?: boolean; providerError?: boolean; multiple?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let messageID = "";
  let snapshots = 0;
  let permissionDone = !options.permission;
  let questionDone = !options.question;
  let closed = false;
  const fakeFetch = async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const pathname = new URL(request.url).pathname;
    const body = request.method === "POST" || request.method === "PATCH" ? await request.json().catch(() => ({})) : {};
    calls.push({ method: request.method, path: pathname, body });
    const json = (value: unknown) => Response.json(value);
    if (pathname === "/event") return new Response(new ReadableStream({ start(controller) {
      request.signal.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
    if (pathname === "/session" && request.method === "POST") return json({ id: "ses_test" });
    if (pathname === "/mcp") return json({});
    if (pathname.endsWith("/prompt_async")) {
      messageID = body.messageID;
      await options.admission;
      if (options.lostAck) throw new TypeError("lost admission response");
      return new Response(null, { status: 204 });
    }
    if (pathname === "/session/status") return json({ ses_test: { type: permissionDone && questionDone && snapshots > 1 ? "idle" : "busy" } });
    if (pathname === "/permission") return json(permissionDone ? [] : [{ id: "perm_test", sessionID: "ses_test", permission: "bash", patterns: ["echo hello"], metadata: {}, always: [], tool: { messageID: "msg_answer", callID: "call_one" } }]);
    if (pathname === "/question") return json(questionDone ? [] : [{ id: "que_test", sessionID: "ses_test", questions: [{ question: "Which branch?", header: "Branch", options: options.multiple ? [{ label: "main", description: "Main branch" }, { label: "dev", description: "Development" }] : [], ...(options.multiple ? { multiple: true, custom: false } : {}) }] }]);
    if (pathname === "/permission/perm_test/reply") { permissionDone = true; return json(true); }
    if (pathname === "/question/que_test/reply" || pathname === "/question/que_test/reject") { questionDone = true; return json(true); }
    if (pathname.endsWith("/abort")) return json(true);
    if (pathname === "/session/ses_test/message") {
      snapshots += 1;
      const complete = snapshots > 1 && permissionDone && questionDone;
      return json([{ info: { id: "msg_answer", sessionID: "ses_test", role: "assistant", parentID: messageID,
        time: { created: 1, ...(complete ? { completed: 2 } : {}) }, ...(options.providerError ? { error: { name: "APIError", data: { message: "fixture failure", isRetryable: false } } } : {}), finish: complete ? "stop" : undefined,
        cost: 0.001, tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } },
        parts: [{ id: "prt_text", sessionID: "ses_test", messageID: "msg_answer", type: "text", text: complete ? "Hello" : "Hel" },
          ...(options.permission ? [{ id: "prt_tool", sessionID: "ses_test", messageID: "msg_answer", type: "tool", tool: "bash", callID: "call_one",
            state: { status: complete ? "completed" : "running", input: { command: "echo hello" }, ...(complete ? { output: "hello", title: "echo", metadata: {}, time: { start: 1, end: 2 } } : {}) } }] : [])] }]);
    }
    if (pathname.startsWith("/session/ses_test/message/")) return options.missingAdmission ? new Response("missing", { status: 404 }) : json({ info: { id: messageID, role: "user" }, parts: [] });
    if (pathname === "/session/ses_test") return json({ id: "ses_test" });
    throw new Error(`unexpected ${request.method} ${pathname}`);
  };
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: fakeFetch as typeof fetch });
  const observations: Observation[] = [];
  const controller = new AbortController();
  const input: DriverRun = { sessionId: "session_one", runId: "run_one", cwd: "/tmp", prompt: "hello", signal: controller.signal,
    onObservations: async (batch) => { batch.forEach((o) => TurnObservation.parse(o)); observations.push(...batch); } };
  const driver = createOpenCodeDriver({ pollMs: 1, start: async () => ({ client, get closed() { return closed; }, close() { closed = true; } }) });
  return { driver, input, controller, observations, calls, closed: () => closed };
}

test("OpenCode snapshots preserve streaming text and count cumulative usage only once", async () => {
  const f = fixture();
  const result = await f.driver.run(f.input);
  expect(result.text).toBe("Hello");
  expect(result.usage?.tokens).toEqual({ input: 5, output: 2, cacheRead: 3, cacheCreate: 0, reasoning: 1 });
  expect(f.observations[0]).toEqual({ kind: "provider.session", providerSessionId: "ses_test" });
  expect(f.observations.filter((o) => o.kind === "item.started")).toHaveLength(1);
  expect(f.observations.some((o) => o.kind === "content.delta" && o.text === "lo")).toBe(true);
  f.driver.dispose?.();
});

test("a lost admission acknowledgment reconciles the exact message and never repeats the prompt", async () => {
  const f = fixture({ lostAck: true });
  expect((await f.driver.run(f.input)).text).toBe("Hello");
  expect(f.calls.filter((c) => c.path.endsWith("/prompt_async"))).toHaveLength(1);
  expect(f.calls.some((c) => c.path.startsWith("/session/ses_test/message/msg_"))).toBe(true);
  f.driver.dispose?.();
});

test("permission approval carries actual tool arguments and grants only once; questions retain answers", async () => {
  const f = fixture({ permission: true, question: true });
  const requests: unknown[] = [];
  f.input.onRequest = async (request) => { requests.push(request); return { decision: "acceptForSession", answers: { "0": "main" } }; };
  await f.driver.run(f.input);
  expect(requests).toContainEqual(expect.objectContaining({ kind: "tool_call", detail: { kind: "tool_call", call: { name: "bash", input: { command: "echo hello" } } } }));
  expect(f.calls.find((c) => c.path === "/permission/perm_test/reply")?.body.reply).toBe("once");
  expect(f.calls.find((c) => c.path === "/question/que_test/reply")?.body.answers).toEqual([["main"]]);
  f.driver.dispose?.();
});

test("Stop during admission aborts upstream and closes the owned server to fence late admission", async () => {
  let release!: () => void;
  const admission = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ admission });
  const result = f.driver.run(f.input);
  const rejected = result.then(() => undefined, (error) => error);
  while (!f.calls.some((c) => c.path.endsWith("/prompt_async"))) await Bun.sleep(1);
  f.controller.abort();
  release();
  expect(await rejected).toBeDefined();
  expect(f.calls.some((c) => c.path.endsWith("/abort"))).toBe(true);
  expect(f.closed()).toBe(true);
});


test("unconfirmed admission fails without replay and fences the owned runtime", async () => {
  const f = fixture({ lostAck: true, missingAdmission: true });
  await expect(f.driver.run(f.input)).rejects.toThrow("admission could not be confirmed");
  expect(f.calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(1);
  expect(f.closed()).toBe(true);
});
test("a provider failure is terminal rather than retried as a snapshot transport error", async () => {
  const f = fixture({ providerError: true });
  await expect(f.driver.run(f.input)).rejects.toThrow("APIError");
  expect(f.calls.filter((call) => call.path === "/session/ses_test/message")).toHaveLength(1);
  expect(f.closed()).toBe(true);
});


test("multiple-choice questions keep their choices and submit independent selections", async () => {
  const f = fixture({ question: true, multiple: true });
  f.input.onRequest = async (request) => {
    expect(request.detail).toMatchObject({ kind: "user_input", fields: [
      { key: "0:0", label: "Branch: main", kind: "boolean" },
      { key: "0:1", label: "Branch: dev", kind: "boolean" },
    ] });
    return { decision: "accept", answers: { "0:0": true, "0:1": true } };
  };
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["main", "dev"]]);
  f.driver.dispose?.();
});
