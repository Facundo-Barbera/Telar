/**
 * THE AGENT'S LOOP — the lab's scenarios, against the real store shapes (#531).
 *
 * What must not drift:
 *
 *   - the Agent has its own state and creates no session for itself;
 *   - a gated call PARKS before any effect in the same node runs, and the ask
 *     names the call it is about;
 *   - a decline reaches the model as a sentence, not as a failed turn;
 *   - the effect ledger makes a replayed send reach the wall once;
 *   - a cancel ends the live turn and does not undo what already landed;
 *   - one turn at a time: a second message queues rather than interleaving;
 *   - the transcript is rows with a cursor, so a phone can page it;
 *   - a wake runs as a turn on the same thread and sees the first turn's
 *     history;
 *   - everything the assistant SAYS reaches a row, including the sentence
 *     before a tool call — which `turn_done.detail.text` alone could never
 *     carry, because it holds the turn's last message.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { SocketTool } from "../src/mcp-socket";
import { AgentRuntime, type AgentStreamEvent } from "../src/agent/runtime";
import { patchAgentSettings } from "../src/agent/store";

/* ------------------------------------------------------------------ *
 * A scripted model. The lab's `RecordedChatModel`, narrowed to what these
 * scenarios need: it proves the PATHS, never that a real model chooses them.
 * ------------------------------------------------------------------ */

type Step = {
  text?: string;
  toolCalls?: ToolCall[];
  /** What this lap reports back as `usage_metadata`. Omitted on purpose by the
   *  steps that test a provider which reports nothing. */
  usage?: { input: number; output: number };
};

class ScriptedChatModel extends BaseChatModel {
  index = 0;
  readonly seen: BaseMessage[][] = [];
  constructor(private readonly script: Step[]) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.script[this.index] ?? { text: "nothing left to say" };
    this.index += 1;
    const message = new AIMessage({
      content: step.text ?? "",
      tool_calls: step.toolCalls ?? [],
      ...(step.usage
        ? { usage_metadata: { input_tokens: step.usage.input, output_tokens: step.usage.output, total_tokens: step.usage.input + step.usage.output } }
        : {}),
    });
    return { generations: [{ text: step.text ?? "", message }] };
  }
}

/* ------------------------------------------------------------------ *
 * A fixture wall — the real `SocketTool` shape, counting what landed.
 * ------------------------------------------------------------------ */

type Landed = { name: string; args: Record<string, unknown>; toolCallId?: string };

function wall(landed: Landed[], overrides: Record<string, (args: Record<string, unknown>) => string> = {}): SocketTool[] {
  const make = (name: string): SocketTool => ({
    name,
    description: `the ${name} tool`,
    shape: {},
    run: async (args, context) => {
      landed.push({ name, args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
      return { content: [{ type: "text", text: overrides[name]?.(args) ?? `${name} ok` }] };
    },
  });
  return ["sessions_list", "sessions_send", "sessions_create", "sessions_read"].map(make);
}

function runtime(script: Step[], tools: SocketTool[], options: { now?: () => number } = {}) {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-rt-"));
  const model = new ScriptedChatModel(script);
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => tools,
    model: () => model,
    ...(options.now ? { now: options.now } : {}),
  });
  agent.patch({ enabled: true });
  return { agent, model, engineRoot };
}

/** Wait until a predicate holds, or give up — the engine suite's own idiom. */
async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const kinds = (agent: AgentRuntime) => agent.thread({ limit: 200 }).rows.map((row) => row.kind);

/* ------------------------------------------------------------------ *
 * 1 — own state, no Telar session.
 * ------------------------------------------------------------------ */

test("the Agent answers from its own thread and creates no session for itself", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "Nothing is running." }], wall(landed));

  const { runId } = agent.submit({ text: "what is running?" });
  await until(() => agent.state().running === false && agent.state().runId === undefined, "the turn to finish");

  expect(landed.filter((call) => call.name === "sessions_create")).toHaveLength(0);
  expect(kinds(agent)).toEqual(["user_message", "turn_started", "assistant_message", "turn_done"]);
  const done = agent.thread().rows.at(-1)!;
  expect(done.runId).toBe(runId);
  expect(done.detail.status).toBe("completed");
  expect(done.detail.text).toBe("Nothing is running.");
  agent.close();
});

test("the thread survives a new runtime over the same file — a restart resumes it", async () => {
  const landed: Landed[] = [];
  const { agent, engineRoot } = runtime([{ text: "first" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().running === false, "the first turn");
  agent.close();

  const second = new AgentRuntime({ engineRoot, tools: () => wall(landed), model: () => new ScriptedChatModel([{ text: "second" }]) });
  expect(second.thread().rows.map((row) => row.kind)).toEqual(["user_message", "turn_started", "assistant_message", "turn_done"]);
  second.submit({ text: "again" });
  await until(() => second.state().running === false, "the second turn");
  // The MODEL saw the first exchange, which is what a resumed thread means.
  expect(second.thread({ limit: 200 }).rows.filter((row) => row.kind === "user_message")).toHaveLength(2);
  second.close();
});

/* ------------------------------------------------------------------ *
 * 2 — streaming.
 * ------------------------------------------------------------------ */

test("a watcher is pushed rows as they happen, and deltas that are never stored", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "streamed" }], wall(landed));
  const events: AgentStreamEvent[] = [];
  const stop = agent.watch((event) => events.push(event));

  agent.submit({ text: "say something" });
  await until(() => agent.state().running === false, "the turn");
  stop();

  expect(events.filter((event) => event.type === "delta").length).toBeGreaterThan(0);
  expect(events.filter((event) => event.type === "row").map((event) => (event as { row: { kind: string } }).row.kind)).toEqual([
    "user_message",
    "turn_started",
    "assistant_message",
    "turn_done",
  ]);
  // A delta is pushed and stored nowhere.
  expect(kinds(agent)).not.toContain("delta");
  agent.close();
});

test("the transcript pages forward from a cursor", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "one" }, { text: "two" }], wall(landed));
  agent.submit({ text: "first" });
  await until(() => agent.state().running === false, "the first turn");
  const first = agent.thread({ limit: 2 });
  expect(first.rows).toHaveLength(2);
  expect(first.more).toBe(true);
  const second = agent.thread({ after: first.cursor, limit: 2 });
  expect(second.rows[0]!.id).toBeGreaterThan(first.cursor);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 3 — approval.
 * ------------------------------------------------------------------ */

const sendTask = (id: string): Step => ({
  toolCalls: [{ id, name: "sessions_send", args: { sessionId: "session_peer", intent: "task", input: "do the thing" }, type: "tool_call" }],
});

test("a task parks before the send, and the ask names the call", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }], wall(landed));

  agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the approval to park");

  // THE EFFECT HAS NOT HAPPENED. This is the property the two-pass node buys.
  expect(landed).toHaveLength(0);
  const request = agent.state().request!;
  expect(request.tool).toBe("sessions_send");
  expect(request.args.sessionId).toBe("session_peer");
  expect(request.reason).toContain("assigns work");
  expect(agent.state().running).toBe(false);
  expect(kinds(agent)).toContain("request_opened");

  expect(agent.resolveRequest(request.id, "accept")).toBe(true);
  await until(() => agent.state().runId === undefined, "the turn to finish");
  expect(landed.map((call) => call.name)).toEqual(["sessions_send"]);
  expect(landed[0]!.toolCallId).toBe("call_1");
  agent.close();
});

test("a stale request id answers nothing rather than approving the next question", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }], wall(landed));
  agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the approval");
  expect(agent.resolveRequest("req_nonsense", "accept")).toBe(false);
  expect(landed).toHaveLength(0);
  agent.resolveRequest(agent.state().request!.id, "decline");
  await until(() => agent.state().runId === undefined, "the turn");
  agent.close();
});

test("a decline reaches the model as a sentence, and nothing lands", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([sendTask("call_1"), { text: "understood" }], wall(landed));
  agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the approval");
  agent.resolveRequest(agent.state().request!.id, "decline");
  await until(() => agent.state().runId === undefined, "the turn");

  expect(landed).toHaveLength(0);
  const lastPrompt = model.seen.at(-1)!;
  const toolMessage = lastPrompt.find((message) => message.getType() === "tool")!;
  expect(String(toolMessage.content)).toContain("declined");
  // AND IT IS IDENTIFIED BY THE CALL ID ALONE (#549) — see the test below.
  expect(toolMessage.name).toBeUndefined();
  // The turn ENDED, rather than failing.
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.status).toBe("completed");
  agent.close();
});

test("a report is never asked about", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [{ toolCalls: [{ id: "call_1", name: "sessions_send", args: { sessionId: "session_peer", intent: "report", input: "fyi" }, type: "tool_call" }] }, { text: "told them" }],
    wall(landed),
  );
  agent.submit({ text: "tell them" });
  await until(() => agent.state().runId === undefined, "the turn");
  expect(landed.map((call) => call.name)).toEqual(["sessions_send"]);
  expect(kinds(agent)).not.toContain("request_opened");
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 6 — no duplicate delegation.
 * ------------------------------------------------------------------ */

test("the model asking for the same send twice reaches the wall once, and asks the person once", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [sendTask("call_1"), sendTask("call_2"), { text: "already sent" }],
    wall(landed),
  );
  agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the first approval");
  agent.resolveRequest(agent.state().request!.id, "accept");
  await until(() => agent.state().runId === undefined, "the turn");

  // ONE send, ONE approval — the ledger is read before the gate.
  expect(landed.filter((call) => call.name === "sessions_send")).toHaveLength(1);
  expect(kinds(agent).filter((kind) => kind === "request_opened")).toHaveLength(1);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 5 — cancellation.
 * ------------------------------------------------------------------ */

test("a cancel ends the parked turn and records that it was stopped", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }], wall(landed));
  const { runId } = agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the approval");

  expect(agent.cancel(runId)).toBe(true);
  await until(() => agent.state().runId === undefined, "the turn to unwind");
  expect(landed).toHaveLength(0);
  expect(agent.state().request).toBeUndefined();
  agent.close();
});

test("cancelling a queued turn removes it without touching the live one", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }, { text: "second" }], wall(landed));
  agent.submit({ text: "first" });
  await until(() => agent.state().request !== undefined, "the approval");
  const queued = agent.submit({ text: "second" });
  expect(agent.state().queued).toBe(1);
  expect(agent.cancel(queued.runId)).toBe(true);
  expect(agent.state().queued).toBe(0);
  expect(agent.state().request).toBeDefined();
  agent.cancel();
  await until(() => agent.state().runId === undefined, "the live turn");
  agent.close();
});

/* ------------------------------------------------------------------ *
 * One turn at a time.
 * ------------------------------------------------------------------ */

test("a second message while a turn runs is queued, and runs after it", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "first done" }, { text: "second done" }], wall(landed));
  agent.submit({ text: "first" });
  await until(() => agent.state().request !== undefined, "the approval");
  const second = agent.submit({ text: "second" });
  expect(agent.state().queued).toBe(1);

  agent.resolveRequest(agent.state().request!.id, "accept");
  await until(() => agent.state().runId === undefined && agent.state().queued === 0, "both turns");

  const users = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "user_message");
  expect(users.map((row) => row.detail.text)).toEqual(["first", "second"]);
  expect(users[1]!.runId).toBe(second.runId);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 4 — wakes.
 * ------------------------------------------------------------------ */

test("a wake runs as a turn on the same thread, marked as something that arrived", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "noted" }, { text: "acted on it" }], wall(landed));
  agent.submit({ text: "watch session_peer" });
  await until(() => agent.state().runId === undefined, "the first turn");

  agent.wake({ notice: "session_peer finished run_9", wakeReason: { kind: "turn_completed", sessionId: "session_peer", runId: "run_9" } });
  await until(() => agent.state().runId === undefined && agent.state().queued === 0, "the wake turn");

  const users = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "user_message");
  expect(users).toHaveLength(2);
  expect(users[1]!.detail.origin).toBe("wake");
  expect(users[1]!.detail.text).toBe("session_peer finished run_9");
  expect((users[1]!.detail.wakeReason as { runId: string }).runId).toBe("run_9");
  agent.close();
});

test("a wake for a switched-off Agent is dropped rather than throwing at the turn that caused it", () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "x" }], wall(landed));
  agent.patch({ enabled: false });
  agent.wake({ notice: "session_peer finished" });
  expect(agent.state().queued).toBe(0);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * Lifecycle.
 * ------------------------------------------------------------------ */

test("a turn cannot be submitted while the Agent is off", () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "x" }], wall(landed));
  agent.patch({ enabled: false });
  expect(() => agent.submit({ text: "hello" })).toThrow("switched off");
  agent.close();
});

test("reset archives the thread and leaves the transcript empty", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "before" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the turn");
  expect(agent.thread().rows.length).toBeGreaterThan(0);

  const state = agent.patch({ reset: true });
  expect(state.generation).toBe(1);
  expect(agent.thread().rows).toHaveLength(0);
  expect(fs.readdirSync(agent.paths.dir).some((name) => /^threads-\d{8}T\d{6}\.sqlite$/.test(name))).toBe(true);
  agent.close();
});

test("disable keeps the transcript, and re-enabling returns to it", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "before" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the turn");
  const before = agent.thread().rows.length;

  agent.patch({ enabled: false });
  agent.patch({ enabled: true });
  expect(agent.thread().rows).toHaveLength(before);
  agent.close();
});

test("the settings a client reads are the document's, plus what only the runtime knows", () => {
  const landed: Landed[] = [];
  const { agent, engineRoot } = runtime([{ text: "x" }], wall(landed));
  patchAgentSettings(agent.paths, { model: "some-model" });
  const state = agent.state();
  expect(state.enabled).toBe(true);
  expect(state.model).toBe("some-model");
  expect(state.threadId).toMatch(/^thread_/);
  expect(state.running).toBe(false);
  expect(state.queued).toBe(0);
  expect(fs.existsSync(path.join(engineRoot, "agent", "agent.json"))).toBe(true);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 3 — the approval that outlives the process that asked.
 * ------------------------------------------------------------------ */

test("an approval parked by one process is found and answered by the next", async () => {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-restart-"));

  /**
   * A REAL CHILD, awaited, exit code checked. Two runtimes in one heap would
   * share the saver's own process memory and prove nothing about a restart —
   * see `fixtures/agent-park-approval.ts`.
   */
  const child = Bun.spawn(["bun", "run", path.join(import.meta.dir, "fixtures", "agent-park-approval.ts"), engineRoot], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: path.join(import.meta.dir, ".."),
  });
  const printed = await new Response(child.stdout).text();
  const failed = await new Response(child.stderr).text();
  expect(await child.exited, `the child failed: ${failed}`).toBe(0);
  const parked = JSON.parse(printed.trim()) as { id: string; runId: string; tool: string; args: Record<string, unknown> };

  // A FRESH RUNTIME that has never seen this thread — the process boundary the
  // durability claim is about.
  const landed: Landed[] = [];
  const second = new AgentRuntime({
    engineRoot,
    tools: () => wall(landed),
    model: () => new ScriptedChatModel([{ text: "sent" }]),
  });
  await second.restore();

  const request = second.state().request;
  expect(request, "the parked approval did not survive the restart").toBeDefined();
  // THE PAYLOAD CAME BACK WITH IT, which is what `interrupt()` buys over the
  // static gate: the surface need not re-derive which call it is about.
  expect(request!.id).toBe(parked.id);
  expect(request!.runId).toBe(parked.runId);
  expect(request!.tool).toBe("sessions_send");
  expect(request!.args.sessionId).toBe("session_peer");
  expect(request!.args.intent).toBe("task");
  // The child made NO send: it parked before any effect in the node.
  expect(landed).toHaveLength(0);

  // And answering it here resumes the turn the other process started.
  expect(second.resolveRequest(request!.id, "accept")).toBe(true);
  await until(() => second.state().runId === undefined && second.state().request === undefined, "the resumed turn");
  expect(landed.map((call) => call.name)).toEqual(["sessions_send"]);
  expect(landed[0]!.toolCallId).toBe("call_restart");

  // ONE user_message, not two: a resumed turn says nothing new.
  const users = second.thread({ limit: 200 }).rows.filter((row) => row.kind === "user_message");
  expect(users).toHaveLength(1);
  expect(second.thread({ limit: 200 }).rows.filter((row) => row.kind === "request_resolved")).toHaveLength(1);
  second.close();
});

test("a thread with no parked approval restores nothing", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "done" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the turn");
  await agent.restore();
  expect(agent.state().request).toBeUndefined();
  agent.close();
});

/* ------------------------------------------------------------------ *
 * What the assistant said, as rows.
 * ------------------------------------------------------------------ */

test("a turn that says something and THEN calls a tool keeps the said text", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      // The bug this pins: only `turn_done.detail.text` used to reach a row, and
      // that is the turn's LAST message — so this sentence was lost entirely.
      { text: "I'll check the rail.", toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] },
      { text: "Two sessions are running." },
    ],
    wall(landed),
  );

  agent.submit({ text: "what is running?" });
  await until(() => agent.state().runId === undefined, "the turn");

  expect(kinds(agent)).toEqual([
    "user_message",
    "turn_started",
    "assistant_message",
    "tool_call",
    "assistant_message",
    "turn_done",
  ]);
  const said = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "assistant_message");
  expect(said.map((row) => row.detail.text)).toEqual(["I'll check the rail.", "Two sessions are running."]);
  // The ORDER is the conversation's: the sentence lands before the call it
  // introduced, not after it.
  const rows = agent.thread({ limit: 200 }).rows;
  expect(rows.findIndex((row) => row.kind === "assistant_message")).toBeLessThan(rows.findIndex((row) => row.kind === "tool_call"));
  // And the turn's ANSWER is unchanged — two readers, two shapes.
  expect(rows.at(-1)!.detail.text).toBe("Two sessions are running.");
  agent.close();
});

test("a round that only calls tools writes no empty bubble", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [{ toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] }, { text: "done" }],
    wall(landed),
  );
  agent.submit({ text: "look" });
  await until(() => agent.state().runId === undefined, "the turn");
  expect(kinds(agent)).toEqual(["user_message", "turn_started", "tool_call", "assistant_message", "turn_done"]);
  agent.close();
});

test("an assistant row carries the id its deltas carried, so a live bubble reconciles", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "streamed" }], wall(landed));
  const events: AgentStreamEvent[] = [];
  const stop = agent.watch((event) => events.push(event));
  agent.submit({ text: "say something" });
  await until(() => agent.state().runId === undefined, "the turn");
  stop();

  const delta = events.find((event) => event.type === "delta") as { itemId: string } | undefined;
  const row = agent.thread({ limit: 200 }).rows.find((each) => each.kind === "assistant_message");
  expect(delta).toBeDefined();
  expect(row?.detail.itemId).toBe(delta!.itemId);
  // The row rides the stream too, so a watcher need not poll for it.
  expect(events.some((event) => event.type === "row" && event.row.kind === "assistant_message")).toBe(true);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * The context meter — #539. The Agent reported no context at all, and a
 * coordinator whose conversation is quietly being trimmed is one a person
 * cannot reason about.
 * ------------------------------------------------------------------ */

test("a turn's usage is the model's own numbers summed over its laps, on the row and on the state", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }], usage: { input: 1_200, output: 30 } },
      { text: "two sessions, both idle.", usage: { input: 1_400, output: 60 } },
    ],
    wall(landed),
  );
  const { runId } = agent.submit({ text: "what is running?" });
  await until(() => agent.state().runId === undefined, "the turn");

  // TWO LAPS, ONE TURN. The question a person asks is what the TURN cost.
  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.kind).toBe("turn_done");
  expect(done.detail.usage).toEqual({ input: 2_600, output: 90, total: 2_690 });

  // The prompt's size comes from the trim step, and the ceiling with it, so a
  // client can draw a proportion without knowing the engine's constant.
  expect(done.detail.contextChars).toBeGreaterThan(0);
  expect(done.detail.budgetChars).toBe(120_000);
  expect(done.detail.contextChars as number).toBeLessThan(done.detail.budgetChars as number);

  // The state a cockpit polls says the same thing about the same turn.
  expect(agent.state().lastUsage).toEqual({
    runId,
    at: done.at,
    usage: { input: 2_600, output: 90, total: 2_690 },
    contextChars: done.detail.contextChars as number,
    budgetChars: 120_000,
  });
  agent.close();
});

test("a provider that reports no usage leaves the token count absent rather than zero", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "no numbers here" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the turn");

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  // ABSENT, NOT ZERO: "nobody said" and "that turn was free" are different
  // facts, and a meter reading 0 tokens would assert the second.
  expect(done.detail.usage).toBeUndefined();
  expect(agent.state().lastUsage?.usage).toBeUndefined();
  // The context half still lands — it is the engine's own measurement.
  expect(agent.state().lastUsage?.contextChars).toBeGreaterThan(0);
  agent.close();
});

test("the meter survives a restart, because it was never this process's number", async () => {
  const landed: Landed[] = [];
  const { agent, engineRoot } = runtime([{ text: "first", usage: { input: 900, output: 40 } }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the first turn");
  const before = agent.state().lastUsage;
  agent.close();

  const second = new AgentRuntime({ engineRoot, tools: () => wall(landed), model: () => new ScriptedChatModel([{ text: "second" }]) });
  // A fresh process has nothing in memory; `restore` reads the last ended turn.
  expect(second.state().lastUsage).toBeUndefined();
  await second.restore();
  expect(second.state().lastUsage).toEqual(before!);
  second.close();
});

test("a stopped turn still reports what it spent, because the tokens were bought", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }], usage: { input: 700, output: 20 } },
      { text: "never said", usage: { input: 800, output: 25 } },
    ],
    wall(landed, { sessions_list: () => { agent.cancel(); return "rows"; } }),
  );
  agent.submit({ text: "what is running?" });
  await until(() => agent.state().runId === undefined, "the turn to end");

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.kind).toBe("turn_done");
  expect(done.detail.status).toBe("stopped");
  // The first lap's tokens were spent before the stop landed, and they count.
  expect(done.detail.usage).toEqual({ input: 700, output: 20, total: 720 });
  agent.close();
});

/* ------------------------------------------------------------------ *
 * `access: "auto"` — #539. The gate still asks; policy answers.
 * ------------------------------------------------------------------ */

test("auto access lets a gated call through and records that policy allowed it", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }], wall(landed));
  agent.patch({ access: "auto" });

  agent.submit({ text: "delegate it" });
  await until(() => agent.state().runId === undefined, "the turn to finish");

  // NOTHING PARKED, and the effect happened.
  expect(agent.state().request).toBeUndefined();
  expect(landed.map((call) => call.name)).toEqual(["sessions_send"]);

  /**
   * THE QUESTION IS STILL IN THE TRANSCRIPT. This is `openRequest`'s own shape
   * for a session's runtime mode: opened and resolved in the same breath,
   * stamped `resolvedBy: "policy"`. A mode that simply skipped the gate would
   * leave a conversation in which the Agent assigned work and nothing anywhere
   * says a decision was made.
   */
  const rows = agent.thread({ limit: 200 }).rows;
  const opened = rows.find((row) => row.kind === "request_opened")!;
  const resolved = rows.find((row) => row.kind === "request_resolved")!;
  expect(opened.detail.tool).toBe("sessions_send");
  expect(resolved.detail).toMatchObject({ decision: "accept", resolvedBy: "policy", tool: "sessions_send" });
  agent.close();
});

test("auto access does not widen what is gated — a read is still never asked about", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [{ toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] }, { text: "two sessions" }],
    wall(landed),
  );
  agent.patch({ access: "auto" });
  agent.submit({ text: "what is running?" });
  await until(() => agent.state().runId === undefined, "the turn");

  // `needsApproval` is untouched by the mode: `auto` moves who ANSWERS the
  // question, never which calls raise one. A read raises none either way, so
  // there is no policy row to write.
  expect(kinds(agent)).not.toContain("request_opened");
  expect(kinds(agent)).not.toContain("request_resolved");
  expect(landed.map((call) => call.name)).toEqual(["sessions_list"]);
  agent.close();
});

test("ask is the default, so an Agent nobody configured still parks", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([sendTask("call_1"), { text: "sent" }], wall(landed));
  expect(agent.state().access).toBeUndefined();
  agent.submit({ text: "delegate it" });
  await until(() => agent.state().request !== undefined, "the approval to park");
  expect(landed).toHaveLength(0);
  agent.cancel();
  await until(() => agent.state().runId === undefined, "the turn");
  agent.close();
});

/* ------------------------------------------------------------------ *
 * 10 — the shape of a tool result (#549).
 * ------------------------------------------------------------------ */

/**
 * EVERY TOOL RESULT, ON EVERY PATH, IS THE CALL ID AND THE ANSWER.
 *
 * `ToolMessage` also takes a `name`, this runtime used to set it on all four of
 * its paths, and `@langchain/openai` serialises it onto the wire — where the
 * Anthropic-shaped models OpenCode Go proxies reject it outright (`400 …
 * messages[7]: "name" is not supported by this endpoint`). `model.ts`'s wrapper
 * strips the field as a backstop, which means the SOCKET can no longer tell
 * whether this file stopped setting it; that is what this test is for, and why
 * it reads the messages handed to the model rather than a request body.
 *
 * Three of the four paths are here in one turn — an effect that ran, a tool
 * that does not exist, and a call the ledger already answered. The fourth, a
 * decline, is asserted where declines are tested above.
 */
test("every tool result the runtime builds is identified by its call id and carries no name", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      { toolCalls: [{ id: "call_1", name: "sessions_send", args: { sessionId: "session_peer", intent: "task", input: "do the thing" }, type: "tool_call" }, { id: "call_2", name: "no_such_tool", args: {}, type: "tool_call" }] },
      // The same send again: answered off the ledger rather than at the wall.
      sendTask("call_3"),
      { text: "done" },
    ],
    wall(landed),
  );
  agent.patch({ access: "auto" });
  agent.submit({ text: "delegate it" });
  await until(() => agent.state().runId === undefined, "the turn");

  const results = model.seen.flat().filter((message) => message.getType() === "tool");
  const ids = results.map((message) => (message as { tool_call_id?: string }).tool_call_id);
  // Each lap re-sends the history, so the three results appear more than once;
  // what matters is that the set is the three calls and that none of them
  // carries a name.
  expect(new Set(ids)).toEqual(new Set(["call_1", "call_2", "call_3"]));
  expect(results.every((message) => message.name === undefined)).toBe(true);
  expect(landed.filter((call) => call.name === "sessions_send")).toHaveLength(1);
  agent.close();
});

test("effort and access are reported on the state a composer reads", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "ok" }], wall(landed));
  expect(agent.state().effort).toBeUndefined();
  const set = agent.patch({ effort: "high", access: "auto" });
  expect(set.effort).toBe("high");
  expect(set.access).toBe("auto");
  // And a cleared pill disappears from the state rather than reading as a value.
  expect(agent.patch({ effort: "" }).effort).toBeUndefined();
  agent.close();
});
