/**
 * THE SAME TURN, ON ALL THREE OF GO'S ROUTES (#571).
 *
 * ── THE CLAIM THIS FILE EXISTS TO DEFEND ────────────────────────────────────
 * `agent/model.ts` builds a different client per route — `ChatOpenAI`,
 * `ChatAnthropic`, `ChatOpenAI` in its Responses mode — and hands every one of
 * them back as a `BaseChatModel`. The claim that buys is that the RUNTIME DOES
 * NOT KNOW THE ROUTE: one graph, one tools node, one approval path, one fold,
 * and a route is a fact about a URL. `agent-model.test.ts` proves what goes out
 * on each; this proves what happens to what comes BACK.
 *
 * ── WHY A SECOND SCRIPTED MODEL WAS NOT ENOUGH ──────────────────────────────
 * `agent-runtime.test.ts` and `agent-compact.test.ts` already drive the runtime
 * against a scripted model, and that model answers the way ONE of the three
 * clients does: `content` as a plain string. Parameterising those suites over
 * "three models" that all return the same shape would have proven nothing at
 * all — it would have run the identical bytes three times and reported
 * three-way parity.
 *
 * So the three scripted shapes below are TRANSCRIBED FROM THE REAL CLIENTS,
 * measured by putting each one in front of a local server that answered its
 * route's wire format with one sentence and one tool call. What each handed
 * back, for the same answer:
 *
 *   chat        content: "Looking."
 *   /messages   content: [{type:"text",text:"Looking."},
 *                         {type:"tool_use",id,name,input}]
 *   /responses  content: [{type:"text",text:"Looking.",annotations:[]}]
 *
 * `tool_calls` and `usage_metadata` come back NORMALISED by LangChain on all
 * three — identical objects — which is exactly why `content` is the one that
 * bit: it looks normalised and is not.
 *
 * ── AND IT FOUND FOUR ───────────────────────────────────────────────────────
 * `typeof content === "string" ? content : ""` was the shape of the read in
 * four places, and on the two new routes each one silently became an empty
 * string or a JSON blob: no streamed deltas, no `assistant_message` row, a turn
 * whose answer was `[{"type":"text",…}]`, and — the one only the fold scenario
 * below reached — a folded turn summarising a sentence it could not see. All
 * four are `assistantText` now.
 *
 * EVERY SCENARIO ASSERTS ACROSS SHAPES RATHER THAN WITHIN ONE. A suite that
 * only checked each route produced something sensible would have passed on two
 * different sensible answers; `identical()` cannot. The chat shape is then
 * pinned to the literals its sibling suites already use, because three shapes
 * agreeing on nothing would satisfy `identical` on its own.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type { SocketTool } from "../src/mcp-socket";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { isFold } from "../src/agent/compact";
import { assistantText } from "../src/agent/content";
import { AgentRuntime, type AgentStreamEvent } from "../src/agent/runtime";

/* ------------------------------------------------------------------ *
 * The three shapes.
 * ------------------------------------------------------------------ */

/** What a lap of a scripted conversation says, before any route dresses it. */
type Step = {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: { input: number; output: number };
};

/** The route names, as `catalogue.ts` spells them. `unknown` is not here: it is
 *  not a fourth wire format, it is this build admitting it has not been told,
 *  and `model.ts` serves it with the chat client. */
type Shape = "chat" | "messages" | "responses";
const SHAPES: Shape[] = ["chat", "messages", "responses"];

/**
 * ONE LAP, IN ONE ROUTE'S CLOTHING — the measured shapes, nothing invented.
 *
 * A `tool_use` block is included on the `/messages` side because the real
 * client puts one there, and leaving it out would have made the fixture agree
 * with the fix rather than with the provider. It is deliberately redundant with
 * `tool_calls`, which every shape also carries: that redundancy is the real
 * Anthropic answer, and a runtime that started reading the block instead of the
 * normalised field would still pass — which is fine, because both are true.
 */
function contentFor(shape: Shape, step: Step): AIMessage["content"] {
  const text = step.text ?? "";
  if (shape === "chat") return text;
  if (shape === "responses") return text ? [{ type: "text", text, annotations: [] }] : [];
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...(step.toolCalls ?? []).map((call) => ({ type: "tool_use", id: call.id ?? "", name: call.name, input: call.args })),
  ];
}

function messageFor(shape: Shape, step: Step, id: string): AIMessage {
  return new AIMessage({
    content: contentFor(shape, step) as never,
    tool_calls: step.toolCalls ?? [],
    id,
    ...(step.usage
      ? { usage_metadata: { input_tokens: step.usage.input, output_tokens: step.usage.output, total_tokens: step.usage.input + step.usage.output } }
      : {}),
  });
}

/**
 * A scripted model that answers in one route's shape.
 *
 * `_streamResponseChunks` IS IMPLEMENTED, not just `_generate`. The runtime
 * reads its deltas off `graph.stream(…, streamMode: "messages")`, and a model
 * with no streaming path would hand that one whole message per lap — which
 * would have let a block-shaped chunk through untested, and the streamed delta
 * is one of the three things that was broken.
 */
class ShapedChatModel extends BaseChatModel {
  index = 0;
  readonly seen: BaseMessage[][] = [];
  constructor(
    private readonly shape: Shape,
    private readonly script: Step[],
  ) {
    super({});
  }
  _llmType(): string {
    return `scripted-${this.shape}`;
  }
  override bindTools(): this {
    return this;
  }
  private next(messages: BaseMessage[]): { step: Step; id: string } {
    this.seen.push(messages);
    const step = this.script[this.index] ?? { text: "nothing left to say" };
    this.index += 1;
    return { step, id: `msg_${this.index}` };
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const { step, id } = this.next(messages);
    return { generations: [{ text: step.text ?? "", message: messageFor(this.shape, step, id) }] };
  }
  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const { step, id } = this.next(messages);
    const message = messageFor(this.shape, step, id);
    yield {
      text: step.text ?? "",
      message: new AIMessageChunk({ content: message.content as never, tool_calls: step.toolCalls ?? [], id, ...(message.usage_metadata ? { usage_metadata: message.usage_metadata } : {}) }),
    } as ChatGenerationChunk;
  }
}

/* ------------------------------------------------------------------ *
 * The fixture wall and the runtime, as the sibling suites build them.
 * ------------------------------------------------------------------ */

type Landed = { name: string; args: Record<string, unknown>; toolCallId?: string };

function wall(landed: Landed[], answer: (name: string) => string = (name) => `${name} ok`): SocketTool[] {
  return ["sessions_list", "sessions_send", "sessions_read"].map((name) => ({
    name,
    description: `the ${name} tool`,
    shape: {},
    run: async (args, context) => {
      landed.push({ name, args, ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}) });
      return { content: [{ type: "text", text: answer(name) }] };
    },
  }));
}

function runtime(shape: Shape, script: Step[], tools: SocketTool[], options: { budgetChars?: number } = {}) {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-parity-"));
  const model = new ShapedChatModel(shape, script);
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => tools,
    model: () => model,
    ...(options.budgetChars !== undefined ? { budgetChars: options.budgetChars } : {}),
  });
  agent.patch({ enabled: true });
  return { agent, model };
}

async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const kinds = (agent: AgentRuntime) => agent.thread({ limit: 200 }).rows.map((row) => row.kind);
const saidBy = (agent: AgentRuntime) =>
  agent
    .thread({ limit: 200 })
    .rows.filter((row) => row.kind === "assistant_message")
    .map((row) => row.detail.text);

/**
 * RUN ONE SCENARIO ON EVERY SHAPE AND COMPARE THE ANSWERS TO EACH OTHER.
 *
 * The comparison is the assertion, and that is the whole design of this file.
 * Asserting each shape against a literal would pass the day two of them agreed
 * on something wrong; asserting them against each OTHER cannot. The chat
 * shape's answer is named as the reference only because it is the one the
 * sibling suites already pin to literals — it is not privileged, it is cited.
 */
async function onEveryShape<T>(scenario: (shape: Shape) => Promise<T>): Promise<Record<Shape, T>> {
  const answers = {} as Record<Shape, T>;
  for (const shape of SHAPES) answers[shape] = await scenario(shape);
  return answers;
}

function identical<T>(answers: Record<Shape, T>): void {
  expect(answers.messages).toEqual(answers.chat);
  expect(answers.responses).toEqual(answers.chat);
}

/* ------------------------------------------------------------------ *
 * 1 — what the assistant said.
 * ------------------------------------------------------------------ */

test("the sentence before a tool call, and the answer after it, reach the transcript on every route", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent } = runtime(
      shape,
      [
        { text: "I'll check the rail.", toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] },
        { text: "Two sessions are running." },
      ],
      wall(landed),
    );
    agent.submit({ text: "what is running?" });
    await until(() => agent.state().runId === undefined, `the turn on ${shape}`);
    const rows = agent.thread({ limit: 200 }).rows;
    const answer = { kinds: kinds(agent), said: saidBy(agent), turnAnswer: rows.at(-1)!.detail.text, landed: landed.map((call) => `${call.name}/${call.toolCallId}`) };
    agent.close();
    return answer;
  });

  identical(answers);
  // AND THE REFERENCE IS THE ONE THE SIBLING SUITE PINS. Three shapes agreeing
  // on nothing would satisfy `identical` on its own.
  expect(answers.chat.said).toEqual(["I'll check the rail.", "Two sessions are running."]);
  expect(answers.chat.turnAnswer).toBe("Two sessions are running.");
  expect(answers.chat.kinds).toEqual(["user_message", "turn_started", "assistant_message", "tool_call", "assistant_message", "turn_done"]);
  // THE ONE THAT WAS BROKEN. On a block-shaped `content` the row used to be
  // written with an empty string and dropped, so the sentence a person watched
  // the model say was in no transcript afterwards.
  expect(answers.messages.said).toEqual(answers.chat.said);
});

test("a round that only calls tools writes no empty bubble on any route", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent } = runtime(shape, [{ toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] }, { text: "done" }], wall(landed));
    agent.submit({ text: "look" });
    await until(() => agent.state().runId === undefined, `the turn on ${shape}`);
    const answer = kinds(agent);
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat).toEqual(["user_message", "turn_started", "tool_call", "assistant_message", "turn_done"]);
});

/* ------------------------------------------------------------------ *
 * 2 — the deltas a person watches.
 * ------------------------------------------------------------------ */

test("deltas reach a watcher on every route, carrying the id the row lands with", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent } = runtime(shape, [{ text: "streamed" }], wall(landed));
    const events: AgentStreamEvent[] = [];
    const stop = agent.watch((event) => events.push(event));
    agent.submit({ text: "say something" });
    await until(() => agent.state().running === false, `the turn on ${shape}`);
    stop();

    const deltas = events.filter((event) => event.type === "delta") as { text: string; itemId: string }[];
    const row = agent.thread({ limit: 200 }).rows.find((entry) => entry.kind === "assistant_message")!;
    const answer = {
      text: deltas.map((delta) => delta.text).join(""),
      // A LIVE BUBBLE RECONCILES ON THIS. If the deltas and the row that
      // replaces them disagree about the id, a client paints the sentence twice.
      reconciles: deltas.every((delta) => delta.itemId === row.detail.itemId),
      // A delta is pushed and stored nowhere, on every route.
      stored: kinds(agent).includes("delta"),
    };
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat).toEqual({ text: "streamed", reconciles: true, stored: false });
});

/* ------------------------------------------------------------------ *
 * 3 — tool calls, and the results that answer them.
 * ------------------------------------------------------------------ */

test("a tool call and its result are paired by call id on every route, and no message carries a name", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent, model } = runtime(
      shape,
      [{ toolCalls: [{ id: "call_1", name: "sessions_list", args: { settled: false }, type: "tool_call" }] }, { text: "two are running" }],
      wall(landed),
    );
    agent.submit({ text: "what is running?" });
    await until(() => agent.state().runId === undefined, `the turn on ${shape}`);

    // THE PROMPT THE SECOND LAP SAW — where the tool result actually lives.
    const results = (model.seen.at(-1) ?? []).filter((message) => message.getType() === "tool");
    const answer = {
      landed: landed.map((call) => ({ name: call.name, args: call.args, toolCallId: call.toolCallId })),
      results: results.map((message) => ({
        callId: (message as unknown as { tool_call_id: string }).tool_call_id,
        text: assistantText(message.content),
        // #549: this field is what killed a conversation mid-turn, and half of
        // Go's models reject it. It must be absent on every route.
        named: "name" in message && (message as unknown as { name?: unknown }).name !== undefined,
      })),
      row: agent.thread({ limit: 200 }).rows.find((entry) => entry.kind === "tool_call")!.detail,
    };
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat.landed).toEqual([{ name: "sessions_list", args: { settled: false }, toolCallId: "call_1" }]);
  expect(answers.chat.results).toEqual([{ callId: "call_1", text: "sessions_list ok", named: false }]);
});

/* ------------------------------------------------------------------ *
 * 4 — approvals and interrupts.
 * ------------------------------------------------------------------ */

const sendTask: Step = {
  toolCalls: [{ id: "call_1", name: "sessions_send", args: { sessionId: "session_peer", intent: "task", input: "do the thing" }, type: "tool_call" }],
};

test("a gated call parks before its effect on every route, and the ask names the same call", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent } = runtime(shape, [sendTask, { text: "sent" }], wall(landed));
    agent.submit({ text: "delegate it" });
    await until(() => agent.state().request !== undefined, `the approval to park on ${shape}`);

    const request = agent.state().request!;
    // NOTHING HAS LANDED YET. The two-pass tools node buys this, and it must
    // buy it identically whatever shape the call arrived in.
    const parked = { landedBeforeApproval: landed.length, tool: request.tool, args: request.args, running: agent.state().running, opened: kinds(agent).includes("request_opened") };

    agent.resolveRequest(request.id, "accept");
    await until(() => agent.state().runId === undefined, `the turn to finish on ${shape}`);
    const answer = { ...parked, landedAfter: landed.map((call) => `${call.name}/${call.toolCallId}`) };
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat.landedBeforeApproval).toBe(0);
  expect(answers.chat.tool).toBe("sessions_send");
  expect(answers.chat.landedAfter).toEqual(["sessions_send/call_1"]);
});

test("a decline reaches the model as a sentence rather than a failed turn, on every route", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent, model } = runtime(shape, [sendTask, { text: "understood" }], wall(landed));
    agent.submit({ text: "delegate it" });
    await until(() => agent.state().request !== undefined, `the approval on ${shape}`);
    agent.resolveRequest(agent.state().request!.id, "decline");
    await until(() => agent.state().runId === undefined, `the turn on ${shape}`);

    const told = (model.seen.at(-1) ?? []).filter((message) => message.getType() === "tool").map((message) => assistantText(message.content));
    const answer = { landed: landed.length, told, said: saidBy(agent) };
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat.landed).toBe(0);
  expect(answers.chat.told).toHaveLength(1);
  expect(answers.chat.said).toEqual(["understood"]);
});

/* ------------------------------------------------------------------ *
 * 5 — the meter.
 * ------------------------------------------------------------------ */

test("usage is summed over a turn's laps identically on every route", async () => {
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent } = runtime(
      shape,
      [
        { toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }], usage: { input: 100, output: 10 } },
        { text: "two are running", usage: { input: 140, output: 6 } },
      ],
      wall(landed),
    );
    agent.submit({ text: "what is running?" });
    await until(() => agent.state().runId === undefined, `the turn on ${shape}`);
    const done = agent.thread({ limit: 200 }).rows.at(-1)!;
    const answer = { usage: done.detail.usage, state: agent.state().usage };
    agent.close();
    return answer;
  });

  identical(answers);
  // LangChain normalises `usage_metadata` across all three clients, so this one
  // was never in danger — which is exactly why it is worth pinning: the next
  // library version that stops normalising it fails here rather than in a
  // month's usage report.
  expect(answers.chat.usage).toMatchObject({ input: 240, output: 16 });
});

/* ------------------------------------------------------------------ *
 * 6 — the fold.
 * ------------------------------------------------------------------ */

test("the prompt folds at the same point on every route, and the transcript keeps everything", async () => {
  const wordy = "z".repeat(2_000);
  const answers = await onEveryShape(async (shape) => {
    const landed: Landed[] = [];
    const { agent, model } = runtime(
      shape,
      [
        { toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] },
        { text: "two are running" },
        { toolCalls: [{ id: "call_2", name: "sessions_list", args: {}, type: "tool_call" }] },
        { text: "still two" },
        { text: "nothing new" },
      ],
      wall(landed, () => wordy),
      // Relative to the briefing, which is charged against the budget — a fixed
      // number here fails the day the briefing grows a sentence.
      { budgetChars: AGENT_BRIEFING.length + 600 },
    );
    for (const text of ["what is running", "and now", "anything else"]) {
      agent.submit({ text });
      await until(() => agent.state().running === false && agent.state().queued === 0, `the turn for "${text}" on ${shape}`);
    }

    const last = model.seen.at(-1)!;
    const rows = agent.thread({ limit: 200 }).rows;
    const answer = {
      // WHAT THE MODEL WAS LEFT HOLDING — the fold's whole job.
      prompt: last.map((message) => `${message.getType()}:${assistantText(message.content).length}`),
      // `isFold` IS THE MARKER THE FOLD ITSELF SETS — the sibling suite's own
      // check. Sniffing for a rendered substring would make this test pass on a
      // fold that produced the right shape and the wrong words.
      folded: last.some((message) => isFold(message)),
      // AND THE LINE'S OWN CONTENT, which is what the four-place `content` bug
      // actually damaged: the turn's question and its answer, in one line.
      foldLine: last.filter((message) => isFold(message)).map((message) => assistantText(message.content)),
      // AND WHAT THE PERSON KEPT. The transcript is never folded.
      asked: rows.filter((row) => row.kind === "user_message").map((row) => row.detail.text),
      keptWholeOutput: rows.find((row) => row.kind === "tool_call")!.detail.output === wordy,
    };
    agent.close();
    return answer;
  });

  identical(answers);
  expect(answers.chat.folded).toBe(true);
  // THE ANSWER SURVIVES INTO THE LINE. This is the assertion the fourth
  // `content` bug failed: on a block-shaped route the folded line used to carry
  // the question and the tool name and no answer at all.
  expect(answers.chat.foldLine.join(" ")).toContain("what is running");
  expect(answers.chat.foldLine.join(" ")).toContain("two are running");
  expect(answers.chat.asked).toEqual(["what is running", "and now", "anything else"]);
  expect(answers.chat.keptWholeOutput).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 7 — the reader itself.
 *
 * The scenarios above are the real proof; this pins the seam they all run
 * through, including the two cases no scripted conversation produces.
 * ------------------------------------------------------------------ */

test("assistantText reads either shape, joins text in order, and invents nothing", () => {
  expect(assistantText("plain")).toBe("plain");
  expect(assistantText([{ type: "text", text: "Look" }, { type: "text", text: "ing." }])).toBe("Looking.");
  // The `/responses` block, with its annotations.
  expect(assistantText([{ type: "text", text: "Looking.", annotations: [] }])).toBe("Looking.");
  // A `tool_use` block is the CALL, which `tool_calls` already carries in a
  // shape the runtime reads properly. Rendering it would put JSON in a bubble.
  expect(assistantText([{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_01", name: "sessions_list", input: {} }])).toBe("Looking.");
  // Reasoning is not the assistant's words to the person, and never was a row.
  expect(assistantText([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done." }])).toBe("Done.");
  // AND A SHAPE NOBODY HAS SEEN CONTRIBUTES NOTHING, rather than `[object
  // Object]`. This returns what was SAID; a guess is not that.
  expect(assistantText([{ type: "future_block", payload: 1 }])).toBe("");
  expect(assistantText(undefined)).toBe("");
  expect(assistantText(null)).toBe("");
});
