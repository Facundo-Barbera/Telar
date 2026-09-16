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
 *     history.
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

type Step = { text?: string; toolCalls?: ToolCall[] };

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
    const message = new AIMessage({ content: step.text ?? "", tool_calls: step.toolCalls ?? [] });
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
  expect(kinds(agent)).toEqual(["user_message", "turn_started", "turn_done"]);
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
  expect(second.thread().rows.map((row) => row.kind)).toEqual(["user_message", "turn_started", "turn_done"]);
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
