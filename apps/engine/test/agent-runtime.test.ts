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
 *     carry, because it holds the turn's last message;
 *   - a SPOKEN turn is cheap and not merely short (#603): a shorter wall, three
 *     laps rather than twelve, a withheld tool that refuses in a sentence
 *     instead of being silently absent, and a landing that still admits the gap.
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
import { collectTools, type SocketTool } from "../src/mcp-socket";
import { sessionsTools } from "../src/sessions-tools/tools";
import { agentFleetTools, agentQueryTools } from "../src/agent/tools";
import { wakeNotification } from "../src/notification";
import { AGENT_BRIEF_ANSWER, AGENT_BRIEFING, AGENT_SPOKEN_BRIEFING } from "../src/agent/briefing";
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
  /** What this lap throws INSTEAD of answering — the shape #602 measured, where
   *  a provider refuses the prompt and the turn never produces a word. A
   *  property rather than a value so a step can throw something falsy. */
  throws?: { error: unknown };
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
  /** AND TO WHAT (#603). The spoken wall is a shorter LIST, so "was it bound"
   *  cannot answer the question — the names are what changed. */
  readonly boundNames: string[][] = [];
  private boundFor = -1;
  constructor(private readonly script: Step[]) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]): this {
    this.boundFor = this.index;
    this.boundNames.push((tools as ReadonlyArray<{ function?: { name?: string } }>).map((spec) => spec.function?.name ?? ""));
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const bound = this.boundFor === this.index;
    this.boundLaps.push(bound);
    const step = this.script[this.index] ?? { text: "nothing left to say" };
    this.index += 1;
    // AFTER the counter, so a throwing lap still counts as a lap — which is what
    // `turn_done.laps` reported for the failures #602 measured.
    if (step.throws) throw step.throws.error;
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

function wall(landed: Landed[], overrides: Record<string, (args: Record<string, unknown>) => string> = {}, names?: readonly string[]): SocketTool[] {
  const make = (name: string): SocketTool => ({
    name,
    description: `the ${name} tool`,
    shape: {},
    run: async (args, context) => {
      landed.push({ name, args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
      return { content: [{ type: "text", text: overrides[name]?.(args) ?? `${name} ok` }] };
    },
  });
  return (names ?? ["sessions_list", "sessions_send", "sessions_create", "sessions_read"]).map(make);
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
 * A turn that fails says so — #602.
 *
 * Seven of 119 turns on the dogfood Mac ended `failed`, five of them without
 * reaching the model. What must not drift is that a failure is EVIDENCE: the
 * provider's own sentence on the row a person pages, never an empty status
 * somebody has to go and diagnose from a daemon log that has since rotated.
 * ------------------------------------------------------------------ */

/** The 400 that killed three consecutive turns on 2026-09-17, verbatim. */
const PROVIDER_400 =
  "400 Error from provider (Console Go): Upstream request failed: [invalid_request_error] An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";

test("a turn whose model call throws records the reason, and says it as the turn's answer", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime([{ throws: { error: new Error(PROVIDER_400) } }], wall(landed));
  const events: AgentStreamEvent[] = [];
  const stop = agent.watch((event) => events.push(event));

  const { runId } = agent.submit({ text: "Hola, ¿cómo estás?" });
  await until(() => agent.state().runId === undefined, "the failed turn");
  stop();

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.kind).toBe("turn_done");
  expect(done.detail.status).toBe("failed");
  // PERSISTED, NOT ONLY LOGGED. This row is the whole diagnosis a week later.
  expect(done.detail.message).toBe(PROVIDER_400);
  // AND READABLE BY THE OTHER READER — the one that takes one answer per turn
  // off `text` and never folds the log. Silence there is what the person heard.
  expect(done.detail.text).toBe(PROVIDER_400);
  // It died on its first call: a lap was spent, nothing was bought, nothing said.
  expect(done.detail.laps).toBe(1);
  expect(done.detail.usage).toBeUndefined();
  expect(kinds(agent)).toEqual(["user_message", "turn_started", "turn_done"]);

  // AND IT RIDES THE STREAM, so a cockpit watching the turn is told rather than
  // left drawing a spinner until it next polls.
  const pushed = events.find((event) => event.type === "row" && event.row.kind === "turn_done");
  expect(pushed).toBeDefined();
  expect((pushed as { row: { runId: string; detail: Record<string, unknown> } }).row.runId).toBe(runId);
  agent.close();
});

test("a turn cannot end failed with nothing to show for it, whatever was thrown", async () => {
  // THE INVARIANT, on the three shapes that used to produce an empty sentence:
  // an Error nobody gave a message, a bare string, and a thrown non-Error.
  const thrown: unknown[] = [new Error(""), "", { code: 500 }];
  for (const error of thrown) {
    const landed: Landed[] = [];
    const { agent } = runtime([{ throws: { error } }], wall(landed));
    agent.submit({ text: "¿Estás ahí?" });
    await until(() => agent.state().runId === undefined, "the failed turn");

    const done = agent.thread({ limit: 200 }).rows.at(-1)!;
    expect(done.detail.status).toBe("failed");
    // Neither usage nor an answer — so the reason is the ONLY thing this turn
    // can give the person, and it is never blank.
    expect(done.detail.usage).toBeUndefined();
    expect(String(done.detail.message ?? "").trim().length).toBeGreaterThan(0);
    expect(String(done.detail.text ?? "").trim().length).toBeGreaterThan(0);
    agent.close();
  }
});

test("a turn that spoke before it fell over keeps its own words and still reports the fault", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { text: "let me look.", toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }], usage: { input: 900, output: 20 } },
      { throws: { error: new Error("Streaming response failed: [500] EngineCore encountered an issue.") } },
    ],
    wall(landed),
  );
  agent.submit({ text: "how are things?" });
  await until(() => agent.state().runId === undefined, "the failed turn");

  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.detail.status).toBe("failed");
  expect(done.detail.message).toContain("EngineCore");
  // THE SENTENCE IT DID SAY IS STILL ITS OWN ROW, so the transcript reads as the
  // conversation that happened: it narrated, it acted, and then it fell over.
  expect(kinds(agent)).toEqual(["user_message", "turn_started", "assistant_message", "tool_call", "turn_done"]);
  // And the first lap's tokens were bought, so the meter reports them.
  expect(done.detail.usage).toEqual({ input: 900, output: 20, total: 920 });
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
 * Answering before looking (#601).
 *
 * WHAT A SCRIPTED MODEL CAN AND CANNOT PROVE, said plainly because the issue
 * asks for "a turn answered from the digest makes zero tool calls" and a fake
 * model chooses nothing. It proves the PATH — that the prompt in front of the
 * model on a check-in turn ALREADY CONTAINS the answer, that answering straight
 * from it costs one lap and no call, and that nothing in the engine caps or
 * gates the exception when a read is genuinely needed. Whether a real model then
 * chooses the cheap path is a question only a real model answers; that is what
 * `agent-answer-first.live.test.ts` is for, and why it is gated off by default.
 * ------------------------------------------------------------------ */

test("a check-in turn is handed its answer before it can call anything", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([{ text: "Dos sesiones terminaron; una espera tu respuesta." }], wall(landed));
  agent.wake({ notification: wakeOf("session_alpha", "run_1", "turn_completed", "[wake: completed] Session session_alpha — turn run_1 completed.") });
  agent.wake({ notification: wakeOf("session_beta", "run_2", "request_opened", "[wake: waiting] Session session_beta — is WAITING on a request.") });

  agent.submit({ text: "¿cómo vamos?" });
  await until(() => agent.state().runId === undefined, "the check-in turn");

  // ONE PROMPT, BOTH HALVES OF IT. The rule names the digest AND the notes, and
  // the digest is in the same system block — so the news the Agent used to spend
  // seven laps re-reading was in front of it before the model's first token.
  const system = String(model.seen[0]![0]!.content);
  expect(system).toContain("ANSWER BEFORE YOU LOOK");
  expect(system).toContain("what happened since your last turn");
  expect(system).toContain("WAITING ON YOU");
  // THE RULE SITS ABOVE THE NEWS, which is the order `buildGraph` already has
  // for its own reason: a reader reaching the digest has been told what it is.
  expect(system.indexOf("ANSWER BEFORE YOU LOOK")).toBeLessThan(system.indexOf("what happened since your last turn"));

  // AND THE MEASUREMENT THE ISSUE IS ABOUT: zero calls, one lap.
  expect(landed).toHaveLength(0);
  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.detail.status).toBe("completed");
  expect(done.detail.laps).toBe(1);
  agent.close();
});

/**
 * AND NOTHING WAS CAPPED — the half the issue is emphatic about.
 *
 * "Do not fix this by capping tool calls. A hard cap would produce confident
 * answers built on nothing when a question genuinely needs a read." So this
 * drives the exception: a question the digest cannot answer, a model that
 * reaches for the one-turn read, and the read must LAND and the turn must carry
 * its result — with a digest present, which is precisely the state where a cap
 * dressed up as a default would have swallowed it.
 */
test("a question needing one turn's words still reads it, digest or no digest", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { text: "let me get that turn.", toolCalls: [{ id: "call_1", name: "sessions_read", args: { sessionId: "session_alpha", runId: "run_1" }, type: "tool_call" as const }] },
      { text: "It said the migration is finished." },
    ],
    wall(landed),
  );
  agent.wake({ notification: wakeOf("session_alpha", "run_1", "turn_completed", "[wake: completed] Session session_alpha — turn run_1 completed.") });

  agent.submit({ text: "what exactly did session_alpha say in run_1?" });
  await until(() => agent.state().runId === undefined, "the reading turn");

  expect(landed.map((call) => call.name)).toEqual(["sessions_read"]);
  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.detail.status).toBe("completed");
  expect(done.detail.text).toBe("It said the migration is finished.");
  // TWO LAPS, NOT ONE. The read happened and its answer reached the model — a
  // default that had quietly become a ceiling would show one lap here.
  expect(done.detail.laps).toBe(2);
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
 * A SPOKEN TURN SHOULD COST LIKE ONE — #603.
 *
 * `brief` used to mean one thing: 154 characters asking for a short answer.
 * The work underneath was identical — full wall, full lap budget — and the
 * measured result was 221,633 input tokens for a 90-character reply. These
 * four hold the three things that changed, and the one that must not:
 *
 *   - the WALL is shorter on a spoken turn, and the same tools on a typed one;
 *   - a tool kept off it REFUSES IN A SENTENCE and does not run, which is the
 *     failure that would be worse than the cost being fixed;
 *   - a withheld call does not wake anybody for an approval it will refuse;
 *   - the LAP CAP lands, and the landing still admits the gap — the cap is
 *     only allowed to exist because the answer it produces is honest.
 * ------------------------------------------------------------------ */

/** A model that keeps calling a tool it IS allowed on a spoken turn, so the cap
 *  is what stops it rather than a refusal. Different arguments each lap, for
 *  `greedy`'s reason: an identical repeat would measure the memo. */
const greedySpoken = (laps: number, last?: string): Step[] =>
  Array.from({ length: laps }, (_, index) => ({
    text: index === 0 ? "let me look." : (index === laps - 1 && last) || "",
    ...(index === laps - 1 && last
      ? {}
      : { toolCalls: [{ id: `call_${index}`, name: "sessions_send", args: { sessionId: `session_${index}`, intent: "report", input: "ping" }, type: "tool_call" as const }] }),
  }));

test("a spoken turn is bound to the short wall, and the next typed one to all of it", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([{ text: "two are idle." }, { text: "two are idle." }], wall(landed));

  agent.submit({ text: "how are things?", brief: true });
  await until(() => agent.state().runId === undefined, "the spoken turn");
  // THE WALL IS THE LEVER: tool specs are the one part of the prompt resent
  // WHOLE on every lap, so this is the saving that multiplies by lap count.
  // `sessions_list` and `sessions_read` are off it — one is a second way to do
  // what `fleet_status` does, the other pages a journal at somebody's ears.
  expect(model.boundNames[0]).toEqual(["sessions_send", "sessions_create"]);

  agent.submit({ text: "and now?" });
  await until(() => agent.state().runId === undefined && model.seen.length === 2, "the typed turn");
  // AND IT IS PER TURN, exactly as the sentence is: the written UI is untouched.
  expect(model.boundNames[1]).toEqual(["sessions_list", "sessions_send", "sessions_create", "sessions_read"]);
  agent.close();
});

test("a spoken turn is sent the spoken briefing, and the next typed one the whole paragraph", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([{ text: "two are idle." }, { text: "two are idle." }], wall(landed));

  agent.submit({ text: "how are things?", brief: true });
  await until(() => agent.state().runId === undefined, "the spoken turn");
  const spoken = String(model.seen[0]![0]!.content);
  expect(spoken).toContain(AGENT_SPOKEN_BRIEFING);
  expect(spoken).not.toContain(AGENT_BRIEFING);
  // The subset's own clause is here; the four a nine-tool turn makes false are not.
  expect(spoken).toContain("THIS TURN HOLDS FEWER TOOLS");
  expect(spoken).not.toContain("YOU HOLD THE SESSIONS WALL AND THE NOTES WALL");

  agent.submit({ text: "and now?" });
  await until(() => agent.state().runId === undefined && model.seen.length === 2, "the typed turn");
  // PER TURN, like everything else `brief` touches: the written UI is untouched.
  expect(String(model.seen[1]![0]!.content)).toContain(AGENT_BRIEFING);
  agent.close();
});

test("a tool withheld from a spoken turn refuses in a sentence, and nothing runs", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      { text: "", toolCalls: [{ id: "call_1", name: "sessions_read", args: { sessionId: "session_a" }, type: "tool_call" }] },
      { text: "That one needs the cockpit on the Mac." },
    ],
    wall(landed),
  );

  agent.submit({ text: "read me that session", brief: true });
  await until(() => agent.state().runId === undefined, "the spoken turn");

  // THE THING THAT WOULD BE WORSE THAN THE COST: a silent absence that lets the
  // Agent believe and then SAY it did something. It did not run, and both the
  // model and the transcript are told so in those words.
  expect(landed).toHaveLength(0);
  const row = agent.thread({ limit: 200 }).rows.find((one) => one.kind === "tool_call")!;
  expect(row.detail.status).toBe("failed");
  expect(String(row.detail.output)).toContain("NOTHING HAPPENED");
  expect(String(row.detail.output)).toContain("sessions_read");
  const answered = model.seen.at(-1)!.filter((message) => message.getType() === "tool");
  expect(String(answered[0]!.content)).toContain("needs the cockpit on the Mac");
  // AND THE TURN STILL ANSWERS. A refusal is a tool result, never a thrown turn.
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.status).toBe("completed");
  agent.close();
});

test("a withheld call that would have been gated wakes nobody", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { text: "", toolCalls: [{ id: "call_1", name: "sessions_stop", args: { sessionId: "session_a" }, type: "tool_call" }] },
      { text: "Stopping one needs the Mac." },
    ],
    wall(landed, {}, ["sessions_stop", "sessions_send"]),
  );

  agent.submit({ text: "stop that one", brief: true });
  await until(() => agent.state().runId === undefined, "the spoken turn");

  // THE WORST OUTCOME WOULD BE A HANG: a person waiting to HEAR an answer while
  // the turn is parked on an approval for a call that was never going to run.
  // So the withheld check sits above the gate, not below it.
  expect(kinds(agent)).not.toContain("request_opened");
  expect(agent.state().request).toBeUndefined();
  expect(landed).toHaveLength(0);
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.status).toBe("completed");
  agent.close();
});

test("a spoken turn lands at three laps where a typed one would keep going", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime([...greedySpoken(6)], wall(landed));
  agent.submit({ text: "how are things?", brief: true });
  await until(() => agent.state().runId === undefined, "the capped spoken turn");
  // Two laps that may look, and a third the cap makes terminal — against the
  // eleven the owner measured on the headset.
  expect(model.index).toBe(3);
  expect(model.boundLaps).toEqual([true, true, false]);
  expect(landed).toHaveLength(2);
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.laps).toBe(3);
  agent.close();

  // THE SAME SCRIPT TYPED IS UNCAPPED at three: `lapCeiling` only lowers, and
  // only for the turn that asked to be spoken.
  const typedLanded: Landed[] = [];
  const typed = runtime([...greedySpoken(6)], wall(typedLanded));
  typed.agent.submit({ text: "how are things?" });
  await until(() => typed.agent.state().runId === undefined, "the typed turn");
  // Six tool laps and a seventh that answers because the SCRIPT ran out — the
  // typed ceiling of twelve was never the thing that stopped it.
  expect(typed.model.index).toBe(7);
  expect(typedLanded).toHaveLength(6);
  typed.agent.close();
});

test("the spoken landing asks for the gap INSIDE the one sentence it is allowed", async () => {
  const landed: Landed[] = [];
  const answer = "Two are idle and I did not get to the third.";
  const { agent, model } = runtime([...greedySpoken(3, answer)], wall(landed));
  agent.submit({ text: "how are things?", brief: true });
  await until(() => agent.state().runId === undefined, "the capped spoken turn");

  const systems = model.seen.map((messages) => String(messages[0]!.content));
  expect(systems[0]).not.toContain("out of tool calls");
  expect(systems[2]).toContain("You are out of tool calls for this turn.");
  /**
   * THE CAP IS ONLY ALLOWED TO EXIST BECAUSE OF THIS LINE. #601 refused a cap
   * that "produces confident answers built on nothing"; what makes this one a
   * different object is that the last lap asks for the gap. On a SPOKEN turn
   * the two instructions are in tension — one sentence, and also an admission —
   * and a model resolving that by dropping the admission is exactly the thing
   * that was refused. So the spoken landing puts the gap INSIDE the sentence,
   * and both instructions are in the block that lap sends.
   */
  expect(systems[2]).toContain("IN THAT SAME SENTENCE");
  expect(systems[2]).toContain(AGENT_BRIEF_ANSWER);

  // And the sentence reaches the answer whole — nothing folds, trims or
  // rewrites the turn's last words on the way to the row a surface speaks.
  const done = agent.thread({ limit: 200 }).rows.at(-1)!;
  expect(done.detail.status).toBe("completed");
  expect(done.detail.text).toBe(answer);
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

/* ------------------------------------------------------------------ *
 * 12 — one run's answer, however it was asked for (#608).
 *
 * #592's memo keys on the LITERAL arguments, and the measured waste walks
 * straight through that: `sessions_answer` re-read with a different `from` and
 * `limit`, and with `runId` sometimes named and sometimes omitted, for text the
 * turn already had whole. 20,273 characters fetched for a 6,127-character
 * answer across eight overlapping windows; 15,384 over seven calls for one of
 * 3,556. What these hold is that the key is the RESOLVED `(sessionId, runId)`,
 * that it closes only on `more: false`, and that a run still being paged is
 * never short-circuited.
 * ------------------------------------------------------------------ */

/**
 * A `sessions_answer` wall over one body, answering the real reply shape — the
 * resolved runId, the slice, and whether anything is left. `runId` omitted
 * resolves to `latest`, which is what the store does.
 *
 * THE FLOOR IS MODELLED HERE BECAUSE THE TWO HALVES OF #608 DEPEND ON EACH
 * OTHER: the dedup below closes on `more: false`, and the floor (`limit` is a
 * ceiling a caller may raise, never lower — see `ANSWER_WHOLE_UNDER`) is what
 * makes the FIRST call say it. A fake that honoured a 2,500 limit literally
 * would page forever and dedup nothing, which is the bug, not the fix.
 */
function answers(landed: Landed[], body: string, latest = "run_1"): SocketTool[] {
  return [
    {
      name: "sessions_answer",
      description: "what one turn concluded",
      shape: {},
      run: async (args: Record<string, unknown>, context?: { toolCallId?: string }) => {
        landed.push({ name: "sessions_answer", args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
        const from = typeof args.from === "number" ? args.from : 0;
        const limit = Math.max(typeof args.limit === "number" ? args.limit : 8_000, 8_000);
        const text = body.slice(from, from + limit);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ runId: typeof args.runId === "string" ? args.runId : latest, sequence: 1, text, from, totalChars: body.length, more: from + text.length < body.length }),
            },
          ],
        };
      },
    },
  ];
}

test("a second window onto a run this turn already has whole is a pointer", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      // The measured shape: a first read that got everything, then the same run
      // again under arguments no literal-key memo can match.
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a", limit: 2_500 })] },
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_a", from: 2_500, limit: 2_400 })] },
      // And a third spelling: the runId named outright this time.
      { toolCalls: [call("call_3", "sessions_answer", { sessionId: "session_a", runId: "run_1" })] },
      { text: "it finished the migration" },
    ],
    answers(landed, "z".repeat(6_127)),
  );

  agent.submit({ text: "what did it conclude?" });
  await until(() => agent.state().runId === undefined, "the turn");

  // THE WALL WAS READ ONCE. Two of the three never landed.
  expect(landed).toHaveLength(1);
  const results = model.seen.flat().filter((message) => message.getType() === "tool");
  const content = (id: string) => String(results.find((message) => (message as { tool_call_id?: string }).tool_call_id === id)?.content);
  for (const id of ["call_2", "call_3"]) {
    expect(content(id)).toContain("You already have the whole answer for run run_1 of session_a");
    expect(content(id)).toContain("was not read again");
    // A POINTER, NOT THE PAYLOAD — the entire saving, since every later lap
    // resends whatever this was.
    expect(content(id)).not.toContain("zzzz");
  }
  // It names the RUN rather than the arguments: the arguments are the one thing
  // that differed, and quoting them invites a fourth spelling.
  expect(content("call_2")).not.toContain("2400");
  expect(agent.thread({ limit: 200 }).rows.at(-1)!.detail.text).toBe("it finished the migration");
  agent.close();
});

test("a run still being paged is never short-circuited", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a", limit: 10_000 })] },
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_a", from: 10_000, limit: 10_000 })] },
      { toolCalls: [call("call_3", "sessions_answer", { sessionId: "session_a", from: 20_000, limit: 10_000 })] },
      // NOW it is whole, and only now does a repeat cost a pointer.
      { toolCalls: [call("call_4", "sessions_answer", { sessionId: "session_a", from: 0, limit: 30_000 })] },
      { text: "done" },
    ],
    // 25,000 characters: three pages, the third of which ends it.
    answers(landed, "y".repeat(25_000)),
  );

  agent.submit({ text: "read me the whole thing" });
  await until(() => agent.state().runId === undefined, "the turn");

  // THREE READS LANDED AND THE FOURTH DID NOT. A memo that closed on the first
  // page would have handed back a pointer to a third of the answer.
  expect(landed).toHaveLength(3);
  expect(landed.map((one) => one.args.from)).toEqual([undefined, 10_000, 20_000]);
  agent.close();
});

test("a different session's answer is a different run, and a failure is not memoised", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a" })] },
      // SAME runId, DIFFERENT session — the key is the pair, not the run alone.
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_b" })] },
      { text: "both said something" },
    ],
    answers(landed, "short"),
  );
  agent.submit({ text: "what did they say?" });
  await until(() => agent.state().runId === undefined, "the turn");
  expect(landed).toHaveLength(2);
  agent.close();
});

test("an answer that could not be read is not memoised, and the retry runs", async () => {
  const landed: Landed[] = [];
  // A MISS IS NOT JSON, so there is no run to key on and the second call runs —
  // the failure direction is a duplicate page, never a wrong one.
  const failing: SocketTool[] = [
    {
      name: "sessions_answer",
      description: "what one turn concluded",
      shape: {},
      run: async (args: Record<string, unknown>) => {
        landed.push({ name: "sessions_answer", args });
        return { content: [{ type: "text" as const, text: 'Could not read the answer from "session_a": no turn with that runId is in this session.' }], isError: true };
      },
    },
  ];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a", runId: "run_guess" })] },
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_a", runId: "run_other" })] },
      { text: "there is nothing there" },
    ],
    failing,
  );
  agent.submit({ text: "what did it say?" });
  await until(() => agent.state().runId === undefined, "the turn");
  expect(landed).toHaveLength(2);
  agent.close();
});

/**
 * THE 10:17 TURN, REPLAYED AGAINST THE REAL TOOLS (#608).
 *
 * ── WHAT WAS MEASURED, ALREADY RUNNING #601 AND #592 ────────────────────────
 *   sessions_answer {sessionId, limit: 2500}            → 2,661
 *   fleet_status    {}                                  → 3,877
 *   sessions_answer {sessionId, from: 2500, limit: 2400} → 2,545  paginating by guess
 *   fleet_status    {}                                  →   145  #592's memo, working
 *   sessions_status {sessionId, turns: 2}               →   759  fleet_status said this
 *   sessions_read   {sessionId, after: 4100, limit: 14} → 8,568  raw events
 *                                                        ------
 *                                                        18,555 over six calls
 *
 * ── WHAT THIS REPLAY CAN AND CANNOT SHOW ────────────────────────────────────
 * The model is SCRIPTED, so the six laps are fixed by the script and this test
 * cannot prove a real model stops asking — only the fleet answer's own sentence
 * and the tool descriptions can do that, and they are held where they are read.
 * What it does prove is the half that does not depend on the model: how many of
 * those six calls reach the wall at all, and what the six answers cost.
 *
 * THE FIRST `fleet_status` IS LEGITIMATE AND STAYS SO — #601 left it open
 * deliberately. The question is about a session working RIGHT NOW, and the
 * digest carries transitions, so a running session has no row in it and the
 * Agent genuinely could not know without asking. The waste is the second call
 * onwards, and the fixture below keeps that first call honest by making the
 * session it is about actually be working.
 *
 * THE TOOLS ARE THE REAL ONES. A fake wall would be measuring the fixture.
 */
function replayWall(landed: Landed[]): SocketTool[] {
  const answer = "It finished the migration and left a note about the index. ".repeat(100).slice(0, 4_900);
  const events = Array.from({ length: 60 }, (_, index) => ({
    id: 4_100 + index,
    at: 1_000 + index,
    sessionId: "session_peer",
    runId: `run_${Math.floor(index / 10)}`,
    type: index % 3 === 0 ? "item.completed" : "item.started",
    item: { id: `item_${index}`, runId: `run_${Math.floor(index / 10)}`, title: `a step the session took, number ${index}`, status: "completed", detail: { type: "command", command: `bun run something --with-a-flag ${index}` } },
  }));
  const turns = Array.from({ length: 6 }, (_, index) => ({
    runId: `run_${index}`,
    sessionId: "session_peer",
    sequence: index + 1,
    input: `do the ${index}th piece of work\nand a second line nobody needs`,
    origin: "session",
    state: index === 5 ? "running" : "completed",
    ...(index === 4 ? { resultText: answer } : {}),
  }));

  const counted = (tools: SocketTool[]): SocketTool[] =>
    tools.map((tool) => ({
      ...tool,
      run: async (args: Record<string, unknown>, context?: { toolCallId?: string }) => {
        landed.push({ name: tool.name, args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
        return tool.run(args, context);
      },
    }));

  return [
    ...counted(
      collectTools(agentQueryTools as never, {
        find: async () => ({ sessions: [], index: "like", more: false }),
        outline: async () => ({ turns: [], total: 0, more: false }),
        answer: async (_id: string, options: { from: number; limit: number }) => {
          const text = answer.slice(options.from, options.from + options.limit);
          const more = options.from + text.length < answer.length;
          return { runId: "run_4", sequence: 5, text, from: options.from, totalChars: answer.length, more, ...(more ? { next: options.from + text.length } : {}) };
        },
      } as never),
    ),
    ...counted(
      collectTools(agentFleetTools as never, {
        rail: async () => ({ sessions: [{ id: "session_peer", title: "the index migration", projectId: "p0", activity: "working" }], projects: [{ id: "p0", name: "Telar" }] }),
        subscribed: async () => ["session_peer"],
        who: () => "session_peer is on the index migration.",
        session: async () => undefined,
        lastTurn: async () => ({ state: "running", answer }),
        openRequests: async () => 0,
        unread: () => ({}),
        since: () => 1,
      } as never),
    ),
    ...counted(
      collectTools(sessionsTools as never, {
        self: { sessionId: "agent" },
        read: async () => events,
        status: async () => ({ session: { id: "session_peer", title: "the index migration", activity: "working", projectId: "p0" }, turns }),
      } as never),
    ).filter((tool) => tool.name === "sessions_read" || tool.name === "sessions_status"),
  ];
}

test("the 10:17 turn replayed: two of its six calls never reach the wall, and the six answers cost a fraction", async () => {
  const landed: Landed[] = [];
  const { agent, model } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_peer", limit: 2_500 })] },
      { toolCalls: [call("call_2", "fleet_status", {})] },
      { toolCalls: [call("call_3", "sessions_answer", { sessionId: "session_peer", from: 2_500, limit: 2_400 })] },
      { toolCalls: [call("call_4", "fleet_status", {})] },
      { toolCalls: [call("call_5", "sessions_status", { sessionId: "session_peer", turns: 2 })] },
      { toolCalls: [call("call_6", "sessions_read", { sessionId: "session_peer", after: 4_100, limit: 14 })] },
      { text: "It finished the migration." },
    ],
    replayWall(landed),
  );

  agent.submit({ text: "how is the migration going?" });
  await until(() => agent.state().runId === undefined, "the turn");

  const results = model.seen.flat().filter((message) => message.getType() === "tool");
  const size = (id: string) => String(results.find((message) => (message as { tool_call_id?: string }).tool_call_id === id)?.content ?? "").length;
  const costs = Object.fromEntries(["call_1", "call_2", "call_3", "call_4", "call_5", "call_6"].map((id) => [id, size(id)]));

  // TWO OF THE SIX NEVER REACHED THE WALL. The second `sessions_answer` is the
  // one that is new: its arguments differ from the first's, so #592's key could
  // not see it, and the resolved `(sessionId, runId)` can.
  expect(landed.filter((one) => one.name === "sessions_answer")).toHaveLength(1);
  expect(landed.filter((one) => one.name === "fleet_status")).toHaveLength(1);
  expect(landed).toHaveLength(4);

  // THE FIRST `sessions_answer` IS NOW THE WHOLE ANSWER — 2,500 was asked for
  // and 4,900 was sent, which is what makes the second call a pointer rather
  // than a legitimate continuation.
  const first = JSON.parse(String(results.find((message) => (message as { tool_call_id?: string }).tool_call_id === "call_1")?.content)) as { more: boolean; totalChars: number };
  expect(first.more).toBe(false);
  expect(first.totalChars).toBe(4_900);

  // THE RE-READ AND THE REPEAT COST POINTERS, both well under their payloads:
  // 2,545 and 145 measured, against a sentence each.
  expect(costs.call_3).toBeLessThan(400);
  expect(costs.call_4).toBeLessThan(400);

  // AND THE JOURNAL READ IS THE FOLD. 8,568 characters of raw events was the
  // single most expensive call of the turn; the question behind it was "what has
  // this session been doing", which is this shape.
  expect(costs.call_6).toBeLessThan(3_000);

  /**
   * ONLY THE CALLS WHOSE SHAPE CHANGED ARE COMPARED, and that is the honest
   * bound rather than a flattering one. This fixture's fleet is ONE session and
   * the measured one was thirteen, so `fleet_status` here is 441 characters
   * against 3,877 and `sessions_status` 64 against 759 — sizes that belong to
   * the fixture, not to the fix. Summing all six would report the fixture's
   * smallness as a saving.
   *
   * The four that this PR actually moves are calls 1, 3, 4 and 6: 13,919
   * characters when measured, and the ceiling below is comfortably under it.
   *
   * NOTE WHAT CALL 1 DOES — it GROWS, 2,661 to ~5,100, because it now sends the
   * whole 4,900-character answer instead of the 2,500 that was asked for. That
   * is the trade and it is worth stating plainly: across this pair alone the
   * characters are a wash. What is bought is the LAP. The second read is
   * answered by the first, and a lap is not one payload — every later lap of the
   * turn resends the whole history, so removing one is worth far more than the
   * ninety characters the note costs. The character saving lives in the worse
   * cases the issue measured: 20,273 fetched for a 6,127-character answer across
   * eight overlapping windows, and an 883-character answer read five times.
   */
  expect(costs.call_1 + costs.call_3 + costs.call_4 + costs.call_6).toBeLessThan(8_000);
  agent.close();
});

test("the run memo does not survive into the next turn either", async () => {
  const landed: Landed[] = [];
  const { agent } = runtime(
    [
      { toolCalls: [call("call_1", "sessions_answer", { sessionId: "session_a" })] },
      { text: "it said one thing" },
      { toolCalls: [call("call_2", "sessions_answer", { sessionId: "session_a" })] },
      { text: "and now another" },
    ],
    answers(landed, "the answer"),
  );
  agent.submit({ text: "what did it say?" });
  await until(() => agent.state().runId === undefined, "the first turn");
  agent.submit({ text: "and now?" });
  await until(() => agent.state().runId === undefined, "the second turn");

  // A run memo that outlived its turn would answer the second question with the
  // first turn's answer, after the session has since said something else.
  expect(landed).toHaveLength(2);
  agent.close();
});
