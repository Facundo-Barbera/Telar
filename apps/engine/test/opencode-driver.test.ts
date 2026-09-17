import { expect, test } from "bun:test";
import { createOpencodeClient, type QuestionInfo } from "@opencode-ai/sdk/v2";
import { TurnObservation, type TurnObservation as Observation } from "@telar/engine-client";
import { createOpenCodeDriver } from "../src/opencode/driver";
import type { DriverRun } from "../src/provider-contract";

/**
 * The raw question payload the server parks, typed as OPENCODE'S OWN
 * `QuestionInfo` so the compiler checks these against the SDK's generated
 * shape. There is no captured multi-select sample to copy from — the opencode
 * binary is not installed here — so these are constructed, and the SDK type is
 * what keeps them honest.
 */
const BRANCH_OPTIONS = [{ label: "main", description: "Main branch" }, { label: "dev", description: "Development" }];
const MULTI_QUESTION: QuestionInfo = { question: "Which branches?", header: "Branches", options: BRANCH_OPTIONS, multiple: true };

function fixture(options: { lostAck?: boolean; permission?: boolean; question?: boolean; admission?: Promise<void>; missingAdmission?: boolean; providerError?: boolean; providerErrorShape?: { name: string; data: Record<string, unknown> }; questions?: QuestionInfo[]; mcpAddFails?: boolean } = {}) {
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
    if (pathname === "/mcp") return options.mcpAddFails ? new Response("mcp failed", { status: 500 }) : json({});
    if (pathname.endsWith("/prompt_async")) {
      messageID = body.messageID;
      await options.admission;
      if (options.lostAck) throw new TypeError("lost admission response");
      return new Response(null, { status: 204 });
    }
    if (pathname === "/session/status") return json({ ses_test: { type: permissionDone && questionDone && snapshots > 1 ? "idle" : "busy" } });
    if (pathname === "/permission") return json(permissionDone ? [] : [{ id: "perm_test", sessionID: "ses_test", permission: "bash", patterns: ["echo hello"], metadata: {}, always: [], tool: { messageID: "msg_answer", callID: "call_one" } }]);
    if (pathname === "/question") return json(questionDone ? [] : [{ id: "que_test", sessionID: "ses_test",
      questions: options.questions ?? [{ question: "Which branch?", header: "Branch", options: [] }] }]);
    if (pathname === "/permission/perm_test/reply") { permissionDone = true; return json(true); }
    if (pathname === "/question/que_test/reply" || pathname === "/question/que_test/reject") { questionDone = true; return json(true); }
    if (pathname.endsWith("/abort")) return json(true);
    if (pathname === "/session/ses_test/message") {
      snapshots += 1;
      const complete = snapshots > 1 && permissionDone && questionDone;
      return json([{ info: { id: "msg_answer", sessionID: "ses_test", role: "assistant", parentID: messageID,
        time: { created: 1, ...(complete ? { completed: 2 } : {}) }, ...(options.providerError ? { error: options.providerErrorShape ?? { name: "APIError", data: { message: "fixture failure", isRetryable: false } } } : {}), finish: complete ? "stop" : undefined,
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

test("the turn fails with WHAT WENT WRONG, not just the error's name", async () => {
  /**
   * The reported failure, end to end: a real Dev session died as
   * "OpenCode: UnknownError" while the SDK was holding "Token refresh failed:
   * 401". The driver threw the name and dropped the sentence.
   */
  const f = fixture({
    providerError: true,
    providerErrorShape: { name: "UnknownError", data: { message: "Token refresh failed: 401" } },
  });
  const error = await f.driver.run(f.input).then(() => undefined, (thrown: Error) => thrown);
  expect(error?.message).toContain("Token refresh failed: 401");
  expect(error?.message).toContain("Reconnect this provider in OpenCode (opencode auth login).");
  expect(error?.message).toContain("UnknownError");
});

test("an APIError's response headers and body never reach the turn's failure", async () => {
  const f = fixture({
    providerError: true,
    providerErrorShape: {
      name: "APIError",
      data: {
        message: "Rate limit reached",
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { authorization: "Bearer sk-live-REALTOKENVALUE0123456789" },
        responseBody: '{"key":"sk-live-REALTOKENVALUE0123456789"}',
      },
    },
  });
  const error = await f.driver.run(f.input).then(() => undefined, (thrown: Error) => thrown);
  expect(error?.message).not.toContain("REALTOKENVALUE");
  expect(error?.message).not.toContain("Bearer");
  expect(error?.message).toContain("429");
  expect(error?.message).toContain("Rate limited");
});


test("the connection and model ids survive to the prompt, split at the FIRST slash", async () => {
  /**
   * `openai/gpt-6-astra` — the pairing on the reported session. The provider is
   * the first segment and the model is everything after it, so a routed id like
   * `openrouter/anthropic/claude` keeps its inner slash instead of losing half
   * the model name.
   */
  const f = fixture({});
  await f.driver.run({ ...f.input, model: "openai/gpt-6-astra" });
  const prompt = f.calls.find((call) => call.path.endsWith("/prompt_async"));
  expect((prompt?.body as { model?: unknown })?.model).toEqual({ providerID: "openai", modelID: "gpt-6-astra" });

  const routed = fixture({});
  await routed.driver.run({ ...routed.input, model: "openrouter/anthropic/claude-x" });
  const routedPrompt = routed.calls.find((call) => call.path.endsWith("/prompt_async"));
  expect((routedPrompt?.body as { model?: unknown })?.model).toEqual({ providerID: "openrouter", modelID: "anthropic/claude-x" });
});

test("a model id with no connection prefix is REFUSED, not silently defaulted", async () => {
  // Better than falling back to the server's choice: a session that asked for
  // one model and quietly got another is the harder bug to see.
  const f = fixture({});
  await expect(f.driver.run({ ...f.input, model: "gpt-6-astra" })).rejects.toThrow("provider/model");
  expect(f.calls.some((call) => call.path.endsWith("/prompt_async"))).toBe(false);
});

/** Telar's computer-use server, exactly as a claim carries it (see
 *  computer-use.ts — `mac`, because Claude Code reserves `computer-use`). */
const macServer = {
  id: "mac",
  label: "Computer Use (Mac)",
  enabled: true,
  spec: { transport: "stdio" as const, command: "/Users/tester/.local/bin/cua-driver", args: ["mcp"] },
  createdAt: 0,
  updatedAt: 0,
};

test("the computer-use server is registered with the running OpenCode server, not just configured", async () => {
  // #368: OpenCode takes MCP servers as a RUNTIME registration against the
  // session's own server, so "the claim carried it" is not the same claim as
  // "the session has the tools". This is the call that makes it true.
  const f = fixture();
  await f.driver.run({ ...f.input, mcpServers: [macServer] });
  expect(f.calls.find((call) => call.path === "/mcp")?.body).toEqual({
    name: "mac",
    config: { type: "local", command: ["/Users/tester/.local/bin/cua-driver", "mcp"] },
  });
  f.driver.dispose?.();
});

test("a server that will not register costs its tools, not the turn", async () => {
  /**
   * The reported failure: a session with cua-driver installed could not run at
   * all on OpenCode. `mcp.add` CONNECTS the server, against OpenCode's own 30s
   * budget, and this driver waited 10s and threw — so merely HAVING computer
   * use installed killed every turn. The Claude driver has always let a bad
   * server cost only its own tools.
   */
  const f = fixture({ mcpAddFails: true });
  expect((await f.driver.run({ ...f.input, mcpServers: [macServer] })).text).toBe("Hello");
  // Never remembered as connected, so the next turn TRIES AGAIN rather than
  // skipping it — or, worse, disconnecting a name that never was.
  await f.driver.run({ ...f.input, runId: "run_two", mcpServers: [macServer] });
  expect(f.calls.filter((call) => call.path === "/mcp")).toHaveLength(2);
  f.driver.dispose?.();
});

test("a multi-select question is ONE checklist field, not one boolean per option", async () => {
  /**
   * #242. Exploded into N `boolean` fields the request was no longer
   * all-choice, so neither drawer would render it — the human got a stack of
   * switches on a form card instead of the one question that was asked.
   */
  const f = fixture({ question: true, questions: [MULTI_QUESTION] });
  f.input.onRequest = async (request) => {
    expect(request.detail).toEqual({ kind: "user_input",
      prompt: "Which branches?\nmain: Main branch\ndev: Development",
      fields: [{ key: "0", label: "Which branches?", kind: "choice", choices: ["main", "dev"], multiple: true, required: true }] });
    return { decision: "accept", answers: { "0": ["main", "dev"] } };
  };
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["main", "dev"]]);
  f.driver.dispose?.();
});

test("a multi-select question the human typed an answer to sends the typed answer", async () => {
  // The drawer's composer is the free-text affordance for a choice field, and
  // it answers with a one-element list — the shape the field asked for. It must
  // reach OpenCode as the answer rather than being dropped for not being an
  // offered label.
  const f = fixture({ question: true, questions: [MULTI_QUESTION] });
  f.input.onRequest = async () => ({ decision: "accept" as const, answers: { "0": ["release/2026-09"] } });
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["release/2026-09"]]);
  f.driver.dispose?.();
});

test("a multi-select question with no options at all stays a text field", async () => {
  // A checklist of nothing is not a question; the flag alone does not make one.
  const f = fixture({ question: true, questions: [{ question: "Which branches?", header: "Branches", options: [], multiple: true }] });
  f.input.onRequest = async (request) => {
    expect(request.detail).toMatchObject({ fields: [{ key: "0", kind: "text", required: true }] });
    return { decision: "accept", answers: { "0": "main and dev" } };
  };
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["main and dev"]]);
  f.driver.dispose?.();
});

test("a single-select question takes the FIRST pick of an array, never all of them", async () => {
  /**
   * An array on a field that never said `multiple` is a client bug. Joining it
   * would answer a one-pick question with several and the model would act on
   * it — the same guard the Claude and Codex arms carry.
   */
  const f = fixture({ question: true, questions: [{ question: "Which branch?", header: "Branch", options: BRANCH_OPTIONS, custom: false }] });
  f.input.onRequest = async (request) => {
    expect(request.detail).toMatchObject({ fields: [{ key: "0", kind: "choice", choices: ["main", "dev"], required: true }] });
    expect((request.detail as { fields: Array<{ multiple?: boolean }> }).fields[0]?.multiple).toBeUndefined();
    return { decision: "accept", answers: { "0": ["main", "dev"] } };
  };
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["main"]]);
  f.driver.dispose?.();
});

test("two questions answer positionally, one list each", async () => {
  // `QuestionAnswer` is per question BY POSITION, so a mixed pair is where a
  // 1:1 field mapping stops being a detail and starts being the contract.
  const f = fixture({ question: true, questions: [MULTI_QUESTION, { question: "Which remote?", header: "Remote", options: [{ label: "origin", description: "Default" }], custom: false }] });
  f.input.onRequest = async () => ({ decision: "accept" as const, answers: { "0": ["dev"], "1": "origin" } });
  await f.driver.run(f.input);
  expect(f.calls.find((call) => call.path === "/question/que_test/reply")?.body.answers).toEqual([["dev"], ["origin"]]);
  f.driver.dispose?.();
});

/**
 * #550 — A NOTIFICATION REACHES OPENCODE AS A SYNTHETIC PART.
 *
 * OpenCode has no developer or system role on `session.prompt`, but its
 * `TextPartInput` carries `synthetic` — the SDK's own word for "generated, not
 * typed" — and that is exactly the distinction. It is the structural half the
 * prose frames used to stand in for.
 */
const NOTIFICATION = {
  kind: "peer_message" as const,
  sessionId: "session_peer",
  runId: "run_x",
  intent: "report" as const,
  summary: "[agent message · report] from session session_peer",
  fetch: { sessionId: "session_one", runId: "run_one" },
  body: "[agent message · report] from session session_peer (run run_x, 9 chars)",
};

test("a notification's part is marked synthetic; a person's is not", async () => {
  const f = fixture();
  await f.driver.run({ ...f.input, prompt: NOTIFICATION.body, notification: NOTIFICATION });
  const parts = f.calls.find((c) => c.path.endsWith("/prompt_async"))?.body.parts as Array<Record<string, unknown>>;
  expect(parts[0]).toEqual({ type: "text", text: NOTIFICATION.body, synthetic: true });
  f.driver.dispose?.();

  // ANTI-VACUITY. A person's words carry no flag at all — absent is not a role,
  // and inventing one for the human would make the distinction meaningless.
  const human = fixture();
  await human.driver.run(human.input);
  const typed = human.calls.find((c) => c.path.endsWith("/prompt_async"))?.body.parts as Array<Record<string, unknown>>;
  expect(typed[0]).toEqual({ type: "text", text: "hello" });
  human.driver.dispose?.();
});
