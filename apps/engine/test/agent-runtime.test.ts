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
 *   - a wake writes ONE INBOX ROW and starts no turn (#541 A), the row survives
 *     a restart, and marking it read moves it exactly once;
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
import type { NotificationDetail, WakeKind } from "@telar/engine-client";
import type { SocketTool } from "../src/mcp-socket";
import { wakeNotification } from "../src/notification";
import { AGENT_BRIEF_ANSWER } from "../src/agent/briefing";
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
  /**
   * WAS EACH LAP BOUND TO TOOLS — one entry per `_generate`, in order (#570).
   *
   * `bindTools` RETURNING `this` IS WHY THIS IS PER LAP rather than a flag: the
   * runtime binds a fresh copy conceptually but gets the same object back, so
   * "bound" has to mean "bound FOR THE LAP ABOUT TO RUN" or it would latch on
   * after the first call and never answer the question the cap test asks.
   */
  readonly boundLaps: boolean[] = [];
  private boundFor = -1;
  constructor(private readonly script: Step[]) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    this.boundFor = this.index;
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const bound = this.boundFor === this.index;
    this.boundLaps.push(bound);
    const step = this.script[this.index] ?? { text: "nothing left to say" };
    this.index += 1;
    const message = new AIMessage({
      content: step.text ?? "",
      // A MODEL WITH NO TOOLS BOUND CANNOT CALL ONE. The scripted model honours
      // that the way a real one does, so a step that asks for a tool on an
      // unbound lap says its text instead of reaching for something it was not
      // given — which is the whole mechanism the lap cap relies on.
      tool_calls: bound ? step.toolCalls ?? [] : [],
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

function runtime(script: Step[], tools: SocketTool[], options: { now?: () => number; budgetChars?: number; maxLaps?: number } = {}) {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-rt-"));
  const model = new ScriptedChatModel(script);
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => tools,
    model: () => model,
    ...(options.now ? { now: options.now } : {}),
    // A ceiling a scenario can actually cross. The default is 120k, which no
    // scripted conversation is ever going to reach.
    ...(options.budgetChars !== undefined ? { budgetChars: options.budgetChars } : {}),
    // Likewise for laps: the default is 12, and a test that had to script
    // twelve tool calls to reach the cap would be testing its own fixture.
    ...(options.maxLaps !== undefined ? { maxLaps: options.maxLaps } : {}),
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
 * 4 — wakes land in the inbox and start nothing (#541 A).
 * ------------------------------------------------------------------ */

/** A wake as the store now hands it over: the notification `notification.ts`
 *  minted for every subscriber to that transition (#550). */
const wakeOf = (sessionId: string, runId: string, kind: WakeKind, body: string): NotificationDetail =>
  wakeNotification({ wakeKind: kind, targetSessionId: sessionId, runId, body });

test("a wake writes one inbox row and starts no turn", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "noted" }], wall(landed));
  agent.submit({ text: "watch session_peer" });
  await until(() => agent.state().runId === undefined, "the first turn");
  const before = agent.thread({ limit: 200 }).rows.length;

  agent.wake({ notification: wakeOf("session_peer", "run_9", "turn_completed", "[wake: completed] Session session_peer — turn run_9 completed.") });

  // NOTHING RAN. No queued turn, no live turn, and not one new transcript row:
  // the whole point of #541 A is that a completion costs an INSERT rather than
  // a conversation.
  expect(agent.state().queued).toBe(0);
  expect(agent.state().running).toBe(false);
  expect(agent.thread({ limit: 200 }).rows).toHaveLength(before);

  const inbox = agent.inbox();
  expect(inbox.rows).toHaveLength(1);
  expect(inbox.rows[0]).toMatchObject({ sessionId: "session_peer", runId: "run_9", kind: "turn_completed", read: false });
  // The summary is the notification's own first line, not a second phrasing.
  expect(inbox.rows[0]!.summary).toBe("[wake: completed] Session session_peer — turn run_9 completed.");
  expect(inbox.unread).toBe(1);
  expect(agent.state().inboxUnread).toBe(1);
  agent.close();
});

test("a wake is pushed to a watcher so a cockpit can badge it without polling", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "noted" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the first turn");

  const seen: AgentStreamEvent[] = [];
  const stop = agent.watch((event) => seen.push(event));
  agent.wake({ notification: wakeOf("session_peer", "run_1", "request_opened", "[wake: waiting] Session session_peer — is WAITING on a request") });
  stop();

  const pushed = seen.filter((event) => event.type === "inbox");
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toMatchObject({ type: "inbox", row: { kind: "request_opened", sessionId: "session_peer" } });
  agent.close();
});

test("the inbox survives a restart, because it is a table in the thread's own file", async () => {
  const landed: Landed[] = [];
  const { agent, engineRoot } = runtime([{ text: "noted" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the first turn");
  agent.wake({ notification: wakeOf("session_peer", "run_2", "turn_failed", "[wake: failed] Session session_peer — turn run_2 FAILED") });
  agent.close();

  const second = new AgentRuntime({ engineRoot, tools: () => wall(landed), model: () => new ScriptedChatModel([{ text: "again" }]) });
  expect(second.inbox().rows.map((row) => row.kind)).toEqual(["turn_failed"]);
  expect(second.state().inboxUnread).toBe(1);
  second.close();
});

test("marking a row read moves it once, and a second attempt moves nothing", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "noted" }], wall(landed));
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the first turn");
  agent.wake({ notification: wakeOf("session_peer", "run_3", "turn_completed", "[wake: completed] one") });
  agent.wake({ notification: wakeOf("session_other", "run_4", "turn_completed", "[wake: completed] two") });

  const ids = agent.inbox().rows.map((row) => row.id);
  expect(agent.markInboxRead([ids[0]!])).toEqual({ read: 1, unread: 1 });
  expect(agent.markInboxRead([ids[0]!])).toEqual({ read: 0, unread: 1 });
  expect(agent.inbox({ unreadOnly: true }).rows.map((row) => row.runId)).toEqual(["run_4"]);
  agent.close();
});

test("a wake for a switched-off Agent is dropped rather than throwing at the turn that caused it", () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "x" }], wall(landed));
  agent.patch({ enabled: false, reset: true });
  expect(agent.wake({ notification: wakeOf("session_peer", "run_5", "turn_completed", "[wake: completed] x") })).toBeUndefined();
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
    // A short conversation folds nothing, and says so rather than staying
    // silent — see `endedRow`.
    folded: 0,
    // TWO MODEL CALLS, which is one tool round plus the lap that answered (#570).
    laps: 2,
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

test("the turns a fold cost ride the same reading the meter does", async () => {
  const landed: Landed[] = [];
  // A ceiling the system block alone nearly fills, and messages heavy enough to
  // cross it: the second turn's prompt is over budget, so the fold must run.
  const { agent } = runtime([{ text: "one" }, { text: "two" }], wall(landed), { budgetChars: 6_000 });
  const long = "x".repeat(2_000);

  agent.submit({ text: long });
  await until(() => agent.state().runId === undefined, "the first turn");
  // NOTHING TO FOLD YET. The turn being answered is never folded, and it is the
  // only turn there is — so the field is 0 rather than absent.
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.folded).toBe(0);
  expect(agent.state().lastUsage?.folded).toBe(0);

  agent.submit({ text: long });
  await until(() => agent.state().runId === undefined, "the second turn");
  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.kind).toBe("turn_done");
  // The first turn became one line, and the count says so on the row a client
  // pages and on the state it polls — one reading, two readers.
  expect(done.detail.folded).toBe(1);
  expect(agent.state().lastUsage).toMatchObject({ runId: done.runId, folded: 1 });
  agent.close();
});

/* ------------------------------------------------------------------ *
 * The lap cap — a turn out of laps still answers (#570).
 * ------------------------------------------------------------------ */

/** A model that never stops asking for tools, which is the shape of the turn
 *  the issue reports: 16 calls and no answer.
 *
 *  EACH LAP ASKS A DIFFERENT QUESTION, and that is load-bearing since #592: a
 *  byte-identical repeat is now answered from the within-turn memo without
 *  reaching the wall, so a fixture that asked for `{}` every lap would be
 *  measuring the memo instead of the cap. The reported turn's calls differed
 *  too — what it wasted laps on was variety, not one call sixteen times. */
const greedy = (laps: number): Step[] =>
  Array.from({ length: laps }, (_, index) => ({
    text: index === 0 ? "let me look." : "",
    toolCalls: [{ id: `call_${index}`, name: "sessions_list", args: { limit: index + 1 }, type: "tool_call" as const }],
  }));

test("a turn that reaches the lap cap ends with an answer rather than a recursion error", async () => {
  const landed: Landed[] = [];
  // Three laps: two that may call tools, and a third the cap makes terminal.
  const { agent, model } = runtime([...greedy(5)], wall(landed), { maxLaps: 3 });

  const { runId } = agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the capped turn");

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.kind).toBe("turn_done");
  // THE POINT OF THE WHOLE CHANGE: `completed`, not `failed`, and words rather
  // than "Recursion limit of 25 reached without hitting a stop condition".
  expect(done.detail.status).toBe("completed");
  expect(done.detail.message).toBeUndefined();
  expect(String(done.detail.text ?? "")).not.toContain("Recursion limit");
  expect(String(done.detail.text ?? "").trim().length).toBeGreaterThan(0);

  // It stopped where the cap is, and says so on the row and on the state.
  expect(done.detail.laps).toBe(3);
  expect(agent.state().lastUsage?.laps).toBe(3);
  // Two tool rounds happened; the third lap was the one that answered.
  expect(landed).toHaveLength(2);
  expect(model.index).toBe(3);
  agent.close();
});

test("the last lap is sent with no tools bound and one sentence saying why", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([...greedy(5)], wall(landed), { maxLaps: 3 });
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the capped turn");

  // UNBINDING IS WHAT MAKES THE LAST CALL TERMINAL — a model with nothing to
  // call cannot ask for a fourth lap, so nothing has to trust it to stop.
  expect(model.boundLaps).toEqual([true, true, false]);

  // And the note rides the SYSTEM block of that lap only, under everything else.
  const systems = model.seen.map((messages) => String(messages[0]!.content));
  expect(systems[0]).not.toContain("out of tool calls");
  expect(systems[1]).not.toContain("out of tool calls");
  expect(systems[2]).toContain("You are out of tool calls for this turn.");
  expect(systems[2]).toContain("say what you did not get to");
  agent.close();
});

test("a turn that answers early reports its own laps and never meets the cap", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "two sessions, both idle." }], wall(landed), { maxLaps: 3 });
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the short turn");

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.detail.status).toBe("completed");
  expect(done.detail.text).toBe("two sessions, both idle.");
  // ONE MODEL CALL IS ONE LAP. The count is of calls, not of tool rounds, so a
  // turn that used no tool reports 1 rather than 0.
  expect(done.detail.laps).toBe(1);
  expect(landed).toHaveLength(0);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * The two halves of `fleet_status` the runtime owns (#570).
 * ------------------------------------------------------------------ */

test("the runtime's half of the fleet read is its own notes and its own unread news", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ text: "noted" }], wall(landed));
  // A thread has to exist before the inbox does — the runtime opens its
  // database on the first turn.
  agent.submit({ text: "hello" });
  await until(() => agent.state().runId === undefined, "the first turn");

  // NOTHING WRITTEN YET reads as empty rather than as an error.
  expect(agent.fleet().who()).toBeUndefined();
  expect(agent.fleet().unread()).toEqual({});

  agent.memory().remember("who", "session_peer is on the lap cap; session_other is idle.");
  agent.wake({ notification: wakeOf("session_peer", "run_1", "turn_completed", "[wake: completed] one") });
  agent.wake({ notification: wakeOf("session_peer", "run_2", "turn_failed", "[wake: failed] two") });
  agent.wake({ notification: wakeOf("session_other", "run_3", "turn_completed", "[wake: completed] three") });

  // The `who` section VERBATIM: the tool reads the ids out of it, because that
  // is the shape the Agent writes it in.
  expect(agent.fleet().who()).toContain("session_peer");
  // COUNTED PER SESSION, which is the number a fleet row carries.
  expect(agent.fleet().unread()).toEqual({ session_peer: 2, session_other: 1 });
  agent.close();
});

/**
 * AND THE THIRD HALF OF IT — WHEN THE AGENT LAST LOOKED (#592).
 *
 * `fleet_status` keeps a session's prose only where it is news, and "news" is
 * the Agent's own previous turn rather than a wall-clock window: a condition
 * with meaning tracks a conversation that ran all morning as honestly as one
 * resumed after lunch.
 */
test("the fleet's recency boundary is the Agent's PREVIOUS turn, not its current one", async () => {
  const landed: Landed[] = [];
  let clock = 1_000;
  const { agent } = runtime([{ text: "one" }, { text: "two" }, { text: "three" }], wall(landed), { now: () => clock });

  // NO PREVIOUS TURN on the thread's first: everything is news, because the
  // Agent has reported on nothing.
  expect(agent.fleet().since()).toBeUndefined();

  agent.submit({ text: "first" });
  await until(() => agent.state().runId === undefined, "the first turn");
  // Still nothing BEFORE the first turn — one turn does not have a predecessor.
  expect(agent.fleet().since()).toBeUndefined();

  clock = 2_000;
  agent.submit({ text: "second" });
  await until(() => agent.state().runId === undefined, "the second turn");
  // The FIRST turn's start, not the second's: a session that moved while the
  // Agent was answering the first question is news it has not passed on.
  expect(agent.fleet().since()).toBe(1_000);

  clock = 3_000;
  agent.submit({ text: "third" });
  await until(() => agent.state().runId === undefined, "the third turn");
  expect(agent.fleet().since()).toBe(2_000);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * One message's calls run together (#570).
 * ------------------------------------------------------------------ */

/** A wall whose calls take measurable time and say when they ran. `delays` is
 *  keyed by the argument each call carries, so one tool name can be called
 *  twice in a batch and still be told apart. */
function timedWall(spans: Array<{ at: string; start: number; end: number }>, delays: Record<string, number>): SocketTool[] {
  return [
    {
      name: "sessions_read",
      description: "the sessions_read tool",
      shape: {},
      run: async (args) => {
        const at = String(args.sessionId ?? "");
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, delays[at] ?? 0));
        spans.push({ at, start, end: Date.now() });
        return { content: [{ type: "text", text: `read ${at}` }] };
      },
    },
  ];
}

test("two calls in one AI message run together, not one after the other", async () => {
  const spans: Array<{ at: string; start: number; end: number }> = [];
  // THE SECOND CALL FINISHES FIRST on purpose: it makes the ordering assertion
  // below mean something, because completion order and the model's order differ.
  const { agent } = runtime(
    [
      {
        toolCalls: [
          { id: "call_slow", name: "sessions_read", args: { sessionId: "slow" }, type: "tool_call" },
          { id: "call_fast", name: "sessions_read", args: { sessionId: "fast" }, type: "tool_call" },
        ],
      },
      { text: "both read." },
    ],
    timedWall(spans, { slow: 140, fast: 10 }),
  );

  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the batched turn");

  const slow = spans.find((span) => span.at === "slow")!;
  const fast = spans.find((span) => span.at === "fast")!;
  // CONCURRENT: the fast call ran while the slow one was still running. Run one
  // after the other, it could not have started before the slow one ended.
  expect(fast.start).toBeLessThan(slow.end);
  expect(fast.end).toBeLessThan(slow.end);
  // And the batch cost about the slowest call, not the sum of both.
  expect(Math.max(slow.end, fast.end) - Math.min(slow.start, fast.start)).toBeLessThan(140 + 10);
  agent.close();
});

test("the results still reach the model in the order it asked for them", async () => {
  const spans: Array<{ at: string; start: number; end: number }> = [];
  const { agent, model } = runtime(
    [
      {
        toolCalls: [
          { id: "call_slow", name: "sessions_read", args: { sessionId: "slow" }, type: "tool_call" },
          { id: "call_fast", name: "sessions_read", args: { sessionId: "fast" }, type: "tool_call" },
        ],
      },
      { text: "both read." },
    ],
    timedWall(spans, { slow: 140, fast: 10 }),
  );
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the batched turn");

  // `fast` FINISHED FIRST but pairs second, because a tool result list pairs
  // with `tool_calls` positionally and some providers check that it does.
  expect(spans.map((span) => span.at)).toEqual(["fast", "slow"]);
  const answered = model.seen.at(-1)!.filter((message) => message.getType() === "tool");
  expect(answered.map((message) => (message as { tool_call_id?: string }).tool_call_id)).toEqual(["call_slow", "call_fast"]);
  agent.close();
});

test("brief asks for a spoken answer, on that turn and no other", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([{ text: "two are idle." }, { text: "nothing has changed." }], wall(landed));

  agent.submit({ text: "what is running?", brief: true });
  await until(() => agent.state().runId === undefined, "the spoken turn");
  const spoken = model.seen[0]![0]!;
  expect(spoken.getType()).toBe("system");
  expect(String(spoken.content)).toContain(AGENT_BRIEF_ANSWER);
  // THE ROW SAYS WHY THE ANSWER WAS SHORT. A two-sentence reply under a
  // question that deserved a page is something a person comes back to.
  const started = agent.thread({ limit: 200 }).rows.find((row) => row.kind === "turn_started")!;
  expect(started.detail.brief).toBe(true);

  agent.submit({ text: "and now?" });
  await until(() => agent.state().runId === undefined && model.seen.length === 2, "the written turn");
  // IT DOES NOT PERSIST. The sentence was never in the conversation — only in
  // that one turn's system block, which is rebuilt per turn and never
  // checkpointed — so the next turn is an ordinary written one.
  expect(String(model.seen[1]![0]!.content)).not.toContain(AGENT_BRIEF_ANSWER);
  const rows = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "turn_started");
  expect(rows.at(-1)!.detail.brief).toBeUndefined();
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

/* ------------------------------------------------------------------ *
 * 11 — the same read, paid for once (#592).
 *
 * One measured turn called `fleet_status` twice for a byte-identical 6,628
 * characters and `sessions_requests` three times for an identical 133, and
 * every lap after the duplicate resent it. What these hold is that the repeat
 * costs a pointer, that ONLY a repeat does, and that the memo is gone by the
 * next turn — a memo that outlived its turn would be a stale fleet, which is a
 * correctness bug and much worse than the waste it replaces.
 * ------------------------------------------------------------------ */

/** A wall of named tools, each answering a body a test can recognise. Not
 *  `wall()` above, which is fixed to four names and none of them a read this
 *  scenario is about. */
function reads(landed: Landed[], names: readonly string[], answer: (name: string, args: Record<string, unknown>) => string = (name) => `${name} body`): SocketTool[] {
  return names.map((name) => ({
    name,
    description: `the ${name} tool`,
    shape: {},
    run: async (args: Record<string, unknown>, context?: { toolCallId?: string }) => {
      landed.push({ name, args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
      return { content: [{ type: "text" as const, text: answer(name, args) }] };
    },
  }));
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, args });

test("an identical read on a later lap answers with a pointer, and the turn still completes", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      { toolCalls: [call("call_1", "fleet_status", { limit: 20 })] },
      { toolCalls: [call("call_2", "fleet_status", { limit: 20 })] },
      { text: "Two sessions are running." },
    ],
    reads(landed, ["fleet_status"], () => "the whole fleet, at length"),
  );

  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the turn");

  // THE WALL WAS READ ONCE. The model asked twice and the second never landed.
  expect(landed.filter((one) => one.name === "fleet_status")).toHaveLength(1);
  const results = model.seen.flat().filter((message) => message.getType() === "tool");
  const second = results.find((message) => (message as { tool_call_id?: string }).tool_call_id === "call_2");
  expect(String(second?.content)).toContain("You already called fleet_status");
  expect(String(second?.content)).toContain("was not read again");
  // AND IT IS A POINTER, NOT THE PAYLOAD — which is the entire saving, because
  // every later lap resends whatever this was.
  expect(String(second?.content)).not.toContain("the whole fleet, at length");
  // The turn is unharmed: it answered.
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.text).toBe("Two sessions are running.");
  agent.close();
});

test("the repeat is still a row, so a person can see how the turn was spent", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_requests", { sessionId: "session_a" })] },
      { toolCalls: [call("call_2", "sessions_requests", { sessionId: "session_a" })] },
      { text: "nothing is waiting" },
    ],
    reads(landed, ["sessions_requests"]),
  );
  agent.submit({ text: "anything waiting on me?" });
  await until(() => agent.state().runId === undefined, "the turn");

  const calls = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "tool_call");
  expect(calls).toHaveLength(2);
  expect(String(calls[1]!.detail.output)).toContain("You already called sessions_requests");
  agent.close();
});

test("two identical reads in ONE message are one read", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      {
        toolCalls: [
          call("call_1", "fleet_status", { limit: 20 }),
          call("call_2", "fleet_status", { limit: 20 }),
          call("call_3", "sessions_list", {}),
        ],
      },
      { text: "done" },
    ],
    reads(landed, ["fleet_status", "sessions_list"]),
  );
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the turn");

  // The batch runs concurrently, so "the second one is a repeat" has to be
  // settled before any of them starts. First position wins.
  expect(landed.filter((one) => one.name === "fleet_status")).toHaveLength(1);
  expect(landed.filter((one) => one.name === "sessions_list")).toHaveLength(1);
  agent.close();
});

test("differing arguments are not memoised, and a smaller limit is not a subset", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "fleet_status", { limit: 20 })] },
      { toolCalls: [call("call_2", "fleet_status", { limit: 10 })] },
      { toolCalls: [call("call_3", "sessions_outline", { sessionId: "session_a", limit: 20 })] },
      { text: "done" },
    ],
    reads(landed, ["fleet_status", "sessions_outline"]),
  );
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the turn");

  expect(landed.map((one) => one.name)).toEqual(["fleet_status", "fleet_status", "sessions_outline"]);
  expect(landed[1]!.args).toEqual({ limit: 10 });
  agent.close();
});

test("argument ORDER and stray whitespace are the same call; case is not", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_find", { q: "the lap cap", limit: 5 })] },
      // Same call, keys the other way round and the phrase re-typed loosely.
      { toolCalls: [call("call_2", "sessions_find", { limit: 5, q: "  the   lap cap " })] },
      // NOT the same call: reasoning about case would be exactly the cleverness
      // that turns a token saving into a wrong answer.
      { toolCalls: [call("call_3", "sessions_find", { q: "The Lap Cap", limit: 5 })] },
      { text: "done" },
    ],
    reads(landed, ["sessions_find"]),
  );
  agent.submit({ text: "where did we talk about the lap cap?" });
  await until(() => agent.state().runId === undefined, "the turn");

  expect(landed).toHaveLength(2);
  expect(landed[1]!.args).toEqual({ q: "The Lap Cap", limit: 5 });
  agent.close();
});

test("a call that LANDS something is never memoised — two identical writes both go", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "notes_write", { title: "ping", body: "again" })] },
      { toolCalls: [call("call_2", "notes_write", { title: "ping", body: "again" })] },
      { text: "written twice" },
    ],
    reads(landed, ["notes_write"]),
  );
  agent.submit({ text: "write it twice" });
  await until(() => agent.state().runId === undefined, "the turn");

  // A person can ask for the same thing twice. Swallowing the second while
  // answering with a pointer would be work the Agent believes it did and
  // nobody received. `notes_write` is the honest case to hold this on: it is
  // ungated AND outside the effect ledger, so the memo is the only mechanism
  // that could have eaten it.
  expect(landed.filter((one) => one.name === "notes_write")).toHaveLength(2);
  agent.close();
});

test("a repeated send answers from the effect ledger, not from the memo", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_send", { sessionId: "session_a", input: "ping", intent: "report" })] },
      { toolCalls: [call("call_2", "sessions_send", { sessionId: "session_a", input: "ping", intent: "report" })] },
      { text: "done" },
    ],
    reads(landed, ["sessions_send"]),
  );
  agent.submit({ text: "tell it" });
  await until(() => agent.state().runId === undefined, "the turn");

  // THE LEDGER IS UNTOUCHED BY #592 and still owns this path — it exists so a
  // REPLAYED node cannot send twice, it is keyed on the thread rather than the
  // turn, and it answers with the RECORDED ANSWER rather than a pointer. What
  // must not happen is the memo quietly taking the lander's path over.
  const second = model.seen
    .flat()
    .filter((message) => message.getType() === "tool")
    .find((message) => (message as { tool_call_id?: string }).tool_call_id === "call_2");
  expect(String(second?.content)).toContain("already made on this thread");
  expect(String(second?.content)).not.toContain("You already called");
  agent.close();
});

test("a read that FAILED is asked again rather than pointed at its own refusal", async () => {
  const landed: Landed[] = [];
  const tools = reads(landed, ["sessions_answer"]).map((tool) => ({
    ...tool,
    run: async (args: Record<string, unknown>, context?: { toolCallId?: string }) => {
      landed.push({ name: "sessions_answer", args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
      return { content: [{ type: "text" as const, text: "the store hiccuped" }], isError: true };
    },
  }));
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a" })] },
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_a" })] },
      { text: "done" },
    ],
    tools as unknown as SocketTool[],
  );
  agent.submit({ text: "what did it say?" });
  await until(() => agent.state().runId === undefined, "the turn");

  expect(landed).toHaveLength(2);
  agent.close();
});

test("the memo does not survive into the next turn", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "fleet_status", { limit: 20 })] },
      { text: "two are running" },
      // A SECOND TURN, asking the identical question.
      { toolCalls: [call("call_2", "fleet_status", { limit: 20 })] },
      { text: "still two" },
    ],
    reads(landed, ["fleet_status"]),
  );

  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the first turn");
  agent.submit({ text: "and now?" });
  await until(() => agent.state().runId === undefined, "the second turn");

  // A memo that outlived its turn would answer the second question from the
  // first question's fleet, which is a wrong answer rather than a cheap one.
  expect(landed.filter((one) => one.name === "fleet_status")).toHaveLength(2);
  agent.close();
});
