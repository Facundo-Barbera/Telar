/**
 * TELAR'S OWN AGENT LOOP, against a fake OpenCode Go (#526).
 *
 * THE SERVER LIVES INSIDE THIS PROCESS and dies with it: `Bun.serve` in
 * `beforeEach`, `stop()` in `afterEach`. Nothing here reaches the real API,
 * nothing here needs a key on the machine running it, and no test leaves a
 * listener behind.
 *
 * What is pinned, and why each one is the failure that would actually happen:
 *
 *   - STREAMING TEXT arrives as deltas on one item, not as one lump at the end:
 *     the cockpit renders a turn as it is spoken, and a driver that only
 *     reported on completion would look like a hang;
 *   - A TOOL CALL ROUND TRIP runs the wall's own handler and sends the result
 *     back, so a turn is a LOOP rather than a request;
 *   - A PARKED REQUEST resumes: the gate may take arbitrarily long (it is
 *     waiting for a human), and the stream must still be there afterwards;
 *   - A DECLINE reaches the model as a result it can read, never as a failed
 *     turn;
 *   - ABORT MID-STREAM ends the turn and does not keep reporting into a claim
 *     the engine has already settled;
 *   - 401 AND 429 SURFACE THE SERVER'S OWN WORDS, because the service knows
 *     which limit and a sentence written here months ago does not;
 *   - NO KEY REACHES AN ITEM OR A MESSAGE, including when the server echoes the
 *     header straight back into its error body — which servers do.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import type { TurnObservation } from "@telar/engine-client";
import { createTelarDriver, GoRequestError, readSseFrames } from "../src/main-session/driver";
import type { DriverRun, SessionsCapability } from "../src/provider-contract";

/* ------------------------------------------------------------------ *
 * A fake OpenCode Go.
 * ------------------------------------------------------------------ */

type Handler = (request: Request, body: Record<string, unknown>) => Response | Promise<Response>;

let server: Server | undefined;
let base = "";
/** Every request body the driver sent, so a test can assert what went out —
 *  the headers, the messages, the tool list. */
let sent: Array<{ body: Record<string, unknown>; headers: Headers }> = [];

function serve(handler: Handler): void {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push({ body, headers: request.headers });
      return handler(request, body);
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
}

/** One SSE response out of a list of chunk objects. Written frame by frame so
 *  a test can put a split anywhere the real wire could. */
function sse(frames: unknown[], options: { delayMs?: number } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        if (options.delayMs) await Bun.sleep(options.delayMs);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

const textChunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const stopChunk = () => ({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const usageChunk = (input: number, output: number) => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });
const callChunks = (id: string, name: string, args: string) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] } }] },
  // Arguments arrive in fragments — the shape that breaks a naive parser.
  ...[...args].map((piece) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/* ------------------------------------------------------------------ *
 * A turn.
 * ------------------------------------------------------------------ */

const KEY = "sk-test-not-a-real-key";

let observed: TurnObservation[] = [];

function run(over: Partial<DriverRun> = {}): DriverRun {
  observed = [];
  return {
    runId: "run_one",
    sessionId: "session_main",
    prompt: "what is going on",
    signal: new AbortController().signal,
    env: { OPENCODE_API_KEY: KEY },
    onObservations: async (observations) => {
      observed.push(...observations);
    },
    ...over,
  } as DriverRun;
}

const driver = () => createTelarDriver({ base, readCliKey: () => undefined });

/** The sessions wall, with one verb doing something a test can see. The row is
 *  a plausible one rather than a stub: the wall folds it, so a half-row would
 *  be testing the fixture rather than the driver. */
function sessionsCapability(over: Partial<SessionsCapability> = {}): SessionsCapability {
  return {
    self: { sessionId: "session_main" },
    list: async () => ({
      sessions: [
        {
          id: "session_two",
          projectId: "project_one",
          title: "Other",
          state: "active",
          createdAt: 1,
          updatedAt: 2,
          driver: "claude",
          envMode: "local",
          workspace: { mode: "local", path: "/tmp/one" },
          activity: "idle",
        },
      ],
      projects: [{ id: "project_one", name: "One" }],
    }),
    ...over,
  } as unknown as SessionsCapability;
}

const textOf = (): string =>
  observed
    .filter((observation): observation is Extract<TurnObservation, { kind: "content.delta" }> => observation.kind === "content.delta")
    .map((observation) => observation.text)
    .join("");

/* ------------------------------------------------------------------ *
 * Streaming.
 * ------------------------------------------------------------------ */

test("text streams as deltas on one item, and the turn's result is the whole of it", async () => {
  serve(() => sse([textChunk("Two sessions"), textChunk(" are working."), stopChunk(), usageChunk(120, 8)]));

  const result = await driver().run(run());

  expect(result.text).toBe("Two sessions are working.");
  expect(textOf()).toBe("Two sessions are working.");
  const started = observed.filter((observation) => observation.kind === "item.started");
  expect(started).toHaveLength(1);
  const completed = observed.find((observation) => observation.kind === "item.completed");
  expect(completed).toMatchObject({ status: "completed", detail: { type: "assistant_message", text: "Two sessions are working." } });
  expect(result.usage?.tokens?.input).toBe(120);
  expect(result.usage?.tokens?.output).toBe(8);
});

test("a round with no prose opens no empty speech bubble", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "sessions_list", "{}")) : sse([textChunk("done"), stopChunk()])));

  await driver().run(run({ sessions: sessionsCapability() }));

  const assistantItems = observed.filter(
    (observation) => observation.kind === "item.started" && observation.item.detail.type === "assistant_message",
  );
  expect(assistantItems).toHaveLength(1);
});

test("the two headers OpenCode Go asks a third-party agent for are on every request", async () => {
  serve(() => sse([textChunk("hi"), stopChunk()]));
  await driver().run(run());

  const headers = sent[0]!.headers;
  expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(headers.get("user-agent")).toMatch(/^telar\/\d+\.\d+\.\d+$/);
  // Stable per conversation — it is the Telar session's own id.
  expect(headers.get("x-opencode-session")).toBe("session_main");
});

test("the model id is the turn's, and the default when the turn names none", async () => {
  serve(() => sse([textChunk("hi"), stopChunk()]));
  await driver().run(run());
  expect(sent[0]!.body.model).toBe("kimi-k3");

  sent = [];
  await driver().run(run({ model: "some-other-model" }));
  expect(sent[0]!.body.model).toBe("some-other-model");
});

/* ------------------------------------------------------------------ *
 * Tools.
 * ------------------------------------------------------------------ */

test("a tool call runs the wall's own handler and the result goes back to the model", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "sessions_list", "{}")) : sse([textChunk("One other session."), stopChunk()])));

  const result = await driver().run(run({ sessions: sessionsCapability() }));

  expect(result.text).toBe("One other session.");
  // The second request carries the assistant's call and the tool's answer, in
  // that order — an orphan `tool` message is a 400, not a shorter history.
  const second = sent[1]!.body.messages as Array<Record<string, unknown>>;
  const assistant = second.find((message) => message.role === "assistant" && message.tool_calls);
  expect(assistant).toBeDefined();
  const toolMessage = second.find((message) => message.role === "tool");
  expect(toolMessage).toMatchObject({ tool_call_id: "call_1" });
  expect(String(toolMessage!.content)).toContain("session_two");

  // And the transcript got both halves of the row.
  const opened = observed.find((observation) => observation.kind === "item.started" && observation.item.detail.type === "dynamic_tool_call");
  expect(opened).toBeDefined();
  const closed = observed.find((observation) => observation.kind === "item.completed" && observation.itemId === "telar_tool_call_1");
  expect(closed).toMatchObject({ status: "completed" });
});

test("the wall is the sessions and notes tools and nothing else", async () => {
  serve(() => sse([textChunk("hi"), stopChunk()]));
  await driver().run(run({ sessions: sessionsCapability() }));

  const tools = sent[0]!.body.tools as Array<{ function: { name: string } }>;
  const names = tools.map((tool) => tool.function.name);
  expect(names.every((name) => name.startsWith("sessions_"))).toBe(true);
  // The absences that matter: not disabled, not present and refusing — absent.
  for (const forbidden of ["Bash", "browser_navigate", "Read", "Write", "display_open", "ds_run", "run_start"]) {
    expect(names).not.toContain(forbidden);
  }
});

test("a turn with no capabilities offers no tools at all, rather than an empty list", async () => {
  serve(() => sse([textChunk("hi"), stopChunk()]));
  await driver().run(run());
  expect(sent[0]!.body.tools).toBeUndefined();
});

test("a request that parks resumes, and the stream is still there afterwards", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "sessions_list", "{}")) : sse([textChunk("after the wait"), stopChunk()])));

  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = driver().run(
    run({
      sessions: sessionsCapability(),
      onRequest: async () => {
        // A human took their time. The driver must simply still be here.
        await parked;
        return "accept";
      },
    }),
  );
  await Bun.sleep(30);
  release!();

  expect((await result).text).toBe("after the wait");
});

test("a decline reaches the model as a result it can read, not as a failed turn", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "sessions_list", "{}")) : sse([textChunk("understood"), stopChunk()])));

  const result = await driver().run(run({ sessions: sessionsCapability(), onRequest: async () => "decline" }));

  expect(result.text).toBe("understood");
  const second = sent[1]!.body.messages as Array<Record<string, unknown>>;
  expect(String(second.find((message) => message.role === "tool")!.content)).toMatch(/declined/i);
  const closed = observed.find((observation) => observation.kind === "item.completed" && observation.itemId === "telar_tool_call_1");
  expect(closed).toMatchObject({ status: "failed" });
});

test("a tool the model invented is answered, not thrown", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "make_coffee", "{}")) : sse([textChunk("sorry"), stopChunk()])));

  const result = await driver().run(run({ sessions: sessionsCapability() }));
  expect(result.text).toBe("sorry");
  const second = sent[1]!.body.messages as Array<Record<string, unknown>>;
  expect(String(second.find((message) => message.role === "tool")!.content)).toContain("no tool called make_coffee");
});

test("arguments that are not JSON are answered with what to fix", async () => {
  let round = 0;
  serve(() => (round++ === 0 ? sse(callChunks("call_1", "sessions_list", "{oops")) : sse([textChunk("retrying"), stopChunk()])));

  await driver().run(run({ sessions: sessionsCapability() }));
  const second = sent[1]!.body.messages as Array<Record<string, unknown>>;
  expect(String(second.find((message) => message.role === "tool")!.content)).toContain("valid JSON");
});

test("the loop is bounded, and says so rather than stopping silently", async () => {
  // A model that never stops calling tools is the one way this burns credit
  // unattended.
  serve(() => sse(callChunks(`call_${Math.random()}`, "sessions_list", "{}")));

  const result = await createTelarDriver({ base, readCliKey: () => undefined, maxRounds: 3 }).run(run({ sessions: sessionsCapability() }));

  expect(result.text).toContain("stopped this turn after 3 rounds");
  expect(sent).toHaveLength(3);
});

/* ------------------------------------------------------------------ *
 * Stopping.
 * ------------------------------------------------------------------ */

test("an abort mid-stream ends the turn and stops reporting", async () => {
  serve(() => sse([textChunk("one "), textChunk("two "), textChunk("three "), textChunk("four "), stopChunk()], { delayMs: 25 }));

  const controller = new AbortController();
  const promise = driver().run(run({ signal: controller.signal }));
  await Bun.sleep(40);
  controller.abort();

  // Either shape is legitimate — the contract lets a driver return on abort or
  // throw — and what matters is that it ENDS, and does not keep streaming.
  await promise.catch(() => undefined);
  const before = observed.length;
  await Bun.sleep(80);
  expect(observed.length).toBe(before);
  expect(textOf().length).toBeLessThan("one two three four ".length);
});

/* ------------------------------------------------------------------ *
 * Refusals.
 * ------------------------------------------------------------------ */

test("a 401 surfaces the service's own words, with the status", async () => {
  serve(() => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));

  const error = await driver()
    .run(run())
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(GoRequestError);
  expect((error as GoRequestError).status).toBe(401);
  expect((error as Error).message).toContain("invalid api key");
});

test("a 429 surfaces its words too — the service knows which limit", async () => {
  serve(() => new Response(JSON.stringify({ error: { message: "rate limit exceeded, retry in 30s" } }), { status: 429 }));

  const error = await driver()
    .run(run())
    .catch((caught: unknown) => caught);

  expect((error as GoRequestError).status).toBe(429);
  expect((error as Error).message).toContain("retry in 30s");
});

test("no key reaches an item or a thrown message, even when the server echoes it back", async () => {
  // Servers do this: the failing request's headers come back in the error body.
  serve(() => new Response(JSON.stringify({ error: { message: `bad credential: Bearer ${KEY}` } }), { status: 401 }));

  const error = await driver()
    .run(run())
    .catch((caught: unknown) => caught);

  const message = (error as Error).message;
  expect(message).not.toContain(KEY);
  expect(message).toContain("[redacted]");
  expect(JSON.stringify(observed)).not.toContain(KEY);
});

test("a turn with no key anywhere refuses before it calls, and names the three ways to fix it", async () => {
  serve(() => sse([textChunk("never reached"), stopChunk()]));

  const error = await createTelarDriver({ base, readCliKey: () => undefined })
    .run(run({ env: {} }))
    .catch((caught: unknown) => caught);

  expect((error as Error).message).toContain("OPENCODE_API_KEY");
  expect((error as Error).name).toBe("ProviderUnavailableError");
  expect(sent).toHaveLength(0);
});

/* ------------------------------------------------------------------ *
 * The stream reader itself.
 * ------------------------------------------------------------------ */

test("frames split across reads at any byte are still one frame", async () => {
  const encoder = new TextEncoder();
  const whole = `data: ${JSON.stringify({ a: 1 })}\n\ndata: ${JSON.stringify({ b: 2 })}\n\ndata: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One byte at a time: the worst split the wire can produce.
      for (const character of whole) controller.enqueue(encoder.encode(character));
      controller.close();
    },
  });

  const frames: unknown[] = [];
  for await (const frame of readSseFrames(stream)) frames.push(frame);
  expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
});

test("a frame that is not JSON is skipped rather than ending the stream", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": keep-alive\n\ndata: not json\n\ndata: {\"a\":1}\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  });

  const frames: unknown[] = [];
  for await (const frame of readSseFrames(stream)) frames.push(frame);
  expect(frames).toEqual([{ a: 1 }]);
});
