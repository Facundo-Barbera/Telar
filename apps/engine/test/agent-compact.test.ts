/**
 * TOOL RESULTS, COMPACTED BEFORE THEY COST ANYTHING TWICE (#563 item 1).
 *
 * What must not drift:
 *
 *   - the model's copy is minified and the THREAD ROW is not, because a person
 *     reads one and a model reads the other;
 *   - a result from an earlier lap of the same turn is one line, and the newest
 *     block is never touched;
 *   - a stub says which tool and how many of what, so the model can tell two
 *     abridged answers apart;
 *   - a result that is not JSON survives exactly as it was written;
 *   - the quadratic cost of a long turn is actually gone — measured on the
 *     16-lap turn the issue reports.
 *
 * AND THE FOLD BELOW IT (#541 part F), which is the other axis — older TURNS
 * rather than earlier laps:
 *
 *   - an over-budget conversation loses its oldest turns to one deterministic
 *     line each, and the turn being answered is never one of them;
 *   - the fold is a human/assistant pair, because a mid-conversation system
 *     message is not a thing the Anthropic-shaped route has;
 *   - a summary is never summarised — folding twice is folding once.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import {
  compactToolResults,
  FOLD_ANSWER_CHARS,
  FOLD_BLOCK_CHARS,
  FOLD_INPUT_CHARS,
  foldOldTurns,
  foldedTurnLine,
  isFold,
  minifyToolResult,
  toolResultStub,
} from "../src/agent/compact";
import { AgentRuntime } from "../src/agent/runtime";
import type { SocketTool } from "../src/mcp-socket";

const human = (text: string) => new HumanMessage(text);
const asked = (id: string, name: string) => new AIMessage({ content: "", tool_calls: [{ id, name, args: {}, type: "tool_call" }] });
const answered = (id: string, text: string) => new ToolMessage({ tool_call_id: id, content: text });
const contentOf = (message: BaseMessage) => String(message.content);

/* ------------------------------------------------------------------ *
 * Minified on the way in.
 * ------------------------------------------------------------------ */

test("a pretty-printed answer is minified, and still says the same thing", () => {
  const value = { sessions: [{ id: "session_a", title: "the dictation feature" }], more: false };
  const pretty = JSON.stringify(value, null, 2);
  const compact = minifyToolResult(pretty);
  expect(compact.length).toBeLessThan(pretty.length);
  expect(JSON.parse(compact)).toEqual(value);
});

test("prose is left exactly as it was written", () => {
  const refusal = 'No note goes by "note_gone" in any project\'s notebook.';
  expect(minifyToolResult(refusal)).toBe(refusal);
});

test("an answer the backstop clipped is not mangled into something that parses", () => {
  const clipped = `${JSON.stringify({ rows: [1, 2, 3] }, null, 2).slice(0, 20)}\n[… 400 more characters not shown]`;
  expect(minifyToolResult(clipped)).toBe(clipped);
});

/* ------------------------------------------------------------------ *
 * Stubbed on the way out.
 * ------------------------------------------------------------------ */

test("a stub names the tool, the count and the first ids", () => {
  const found = JSON.stringify({
    sessions: [{ id: "session_a" }, { id: "session_b" }, { id: "session_c" }, { id: "session_d" }, { id: "session_e" }],
    more: true,
  });
  const stub = toolResultStub("sessions_find", found);
  expect(stub).toContain("sessions_find");
  expect(stub).toContain("5 sessions");
  expect(stub).toContain("session_a, session_b, session_c");
  expect(stub).toContain("(+2)");
  expect(stub.split("\n")).toHaveLength(1);
});

test("an answer with no rows in it falls back to its opening line", () => {
  const stub = toolResultStub("sessions_answer", "The branch is green and the PR is open.\nSecond line nobody needs.");
  expect(stub).toContain("The branch is green");
  expect(stub).not.toContain("Second line");
});

test("earlier laps collapse; the newest block is untouched", () => {
  const big = JSON.stringify({ sessions: [{ id: "session_a" }, { id: "session_b" }], note: "x".repeat(2_000) });
  const messages = [
    human("find the dictation thread"),
    asked("call_1", "sessions_find"),
    answered("call_1", big),
    asked("call_2", "sessions_outline"),
    answered("call_2", big),
    asked("call_3", "sessions_answer"),
    answered("call_3", big),
  ];
  const compacted = compactToolResults(messages);

  expect(contentOf(compacted[2]!)).toContain("[earlier lap] sessions_find");
  expect(contentOf(compacted[4]!)).toContain("[earlier lap] sessions_outline");
  // The answer to the call the model made one superstep ago is never a summary
  // of the thing it just asked for.
  expect(contentOf(compacted[6]!)).toBe(big);
  // Every other message is the same object, not a copy.
  expect(compacted[0]).toBe(messages[0]!);
  expect(compacted[1]).toBe(messages[1]!);
});

test("a result from a previous TURN is left alone — older turns are the fold's problem", () => {
  const big = JSON.stringify({ sessions: [{ id: "session_a" }], note: "y".repeat(2_000) });
  const messages = [
    human("first question"),
    asked("call_1", "sessions_find"),
    answered("call_1", big),
    new AIMessage("here it is"),
    human("second question"),
    asked("call_2", "sessions_find"),
    answered("call_2", big),
    asked("call_3", "sessions_outline"),
    answered("call_3", big),
  ];
  const compacted = compactToolResults(messages);
  expect(contentOf(compacted[2]!)).toBe(big);
  expect(contentOf(compacted[6]!)).toContain("[earlier lap]");
  expect(contentOf(compacted[8]!)).toBe(big);
});

test("a stub that would be longer than the result it replaces is not applied", () => {
  const messages = [human("hi"), asked("call_1", "sessions_settle"), answered("call_1", "ok"), asked("call_2", "sessions_list"), answered("call_2", "rows")];
  const compacted = compactToolResults(messages);
  expect(contentOf(compacted[2]!)).toBe("ok");
});

test("a conversation with one lap is returned unchanged", () => {
  const messages = [human("hi"), asked("call_1", "sessions_list"), answered("call_1", "rows")];
  expect(compactToolResults(messages).map(contentOf)).toEqual(messages.map(contentOf));
});

/* ------------------------------------------------------------------ *
 * The measurement: the issue's own 16-lap turn.
 * ------------------------------------------------------------------ */

/** The turn #563 reports: "find the thread about the dictation feature" —
 *  9× sessions_find, 3× sessions_outline, 4× sessions_answer, the two largest
 *  outlines 7.6k and 6.4k of two-space JSON. */
function sixteenLaps(): Array<{ name: string; result: string }> {
  const find = (n: number) =>
    JSON.stringify(
      {
        sessions: Array.from({ length: 10 }, (_, index) => ({
          id: `session_${n}${index}`,
          title: `a conversation about something ${n}${index}`,
          activity: "idle",
          updatedAt: 1_700_000_000_000 + index,
          why: "…the dictation feature, on the phone and on the web…",
        })),
        index: "fts5",
        more: true,
      },
      null,
      2,
    );
  const outline = (turns: number) =>
    JSON.stringify(
      {
        turns: Array.from({ length: turns }, (_, index) => ({
          runId: `run_${index}`,
          sequence: index,
          state: "completed",
          input: `what was asked on turn ${index}, at about the length a person types`,
          items: 12,
          answer: "the opening line of what that turn concluded, which is what an outline shows",
          answerChars: 4_200,
        })),
        total: turns,
        more: true,
      },
      null,
      2,
    );
  const answer = (n: number) =>
    JSON.stringify({ runId: `run_${n}`, sequence: n, text: `${"the answer text, at about the size a real one is. ".repeat(30)}`, from: 0, totalChars: 4_000, more: true }, null, 2);
  return [
    ...Array.from({ length: 9 }, (_, index) => ({ name: "sessions_find", result: find(index) })),
    { name: "sessions_outline", result: outline(25) },
    { name: "sessions_outline", result: outline(21) },
    { name: "sessions_outline", result: outline(8) },
    ...Array.from({ length: 4 }, (_, index) => ({ name: "sessions_answer", result: answer(index) })),
  ];
}

/** `trim.ts`'s own arithmetic, so the two cannot disagree about what a prompt
 *  costs. */
function cost(messages: readonly BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const calls = (message as AIMessage).tool_calls;
    total += content.length + (calls ? JSON.stringify(calls).length : 0) + 32;
  }
  return total;
}

/** What the whole turn sends the model, summed over its laps — which is the
 *  number the issue measured and the number that was quadratic. */
function turnCost(laps: Array<{ name: string; result: string }>, options: { compact: boolean }): number {
  let history: BaseMessage[] = [human("find the thread about the dictation feature")];
  let total = 0;
  laps.forEach((lap, index) => {
    total += cost(options.compact ? compactToolResults(history) : history);
    const id = `call_${index}`;
    history = [...history, asked(id, lap.name), answered(id, options.compact ? minifyToolResult(lap.result) : lap.result)];
  });
  // The final lap, the one that answers.
  total += cost(options.compact ? compactToolResults(history) : history);
  return total;
}

test("the 16-lap turn stops being quadratic", () => {
  const laps = sixteenLaps();
  const before = turnCost(laps, { compact: false });
  const after = turnCost(laps, { compact: true });
  // Measured on this fixture: 383,928 → 64,654 characters over 17 model calls,
  // and the last lap's prompt 45,616 → 5,306. The assertion is the PROPERTY —
  // most of it is gone — rather than the exact number, which moves whenever the
  // fixture's prose does.
  expect(after).toBeLessThan(before / 4);
  // And the growth is linear: the last lap sends roughly what the first did
  // plus one full result, not seventeen of them.
  expect(after / laps.length).toBeLessThan(before / laps.length / 4);
});

/* ------------------------------------------------------------------ *
 * Through the runtime: the row keeps what the model no longer sees.
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
    const step = this.script[this.index] ?? { text: "done" };
    this.index += 1;
    const message = new AIMessage({ content: step.text ?? "", tool_calls: step.toolCalls ?? [] });
    return { generations: [{ text: step.text ?? "", message }] };
  }
}

async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("the transcript keeps the whole answer; the prompt carries the compact one", async () => {
  const pretty = JSON.stringify({ sessions: [{ id: "session_a", title: "the dictation feature" }], more: false }, null, 2);
  const tools: SocketTool[] = ["sessions_find", "sessions_outline"].map((name) => ({
    name,
    description: `the ${name} tool`,
    shape: {},
    run: async () => ({ content: [{ type: "text", text: pretty }] }),
  }));
  const model = new ScriptedChatModel([
    { toolCalls: [{ id: "call_1", name: "sessions_find", args: {}, type: "tool_call" }] },
    { toolCalls: [{ id: "call_2", name: "sessions_outline", args: {}, type: "tool_call" }] },
    { text: "it is session_a." },
  ]);
  const agent = new AgentRuntime({
    engineRoot: fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-compact-")),
    tools: () => tools,
    model: () => model,
  });
  agent.patch({ enabled: true });
  agent.submit({ text: "which thread was the dictation one?" });
  await until(() => agent.state().running === false, "the turn to finish");

  // THE ROW IS THE ANSWER AS THE TOOL WROTE IT — indentation and all, because
  // the cockpit renders it.
  const calls = agent.thread({ limit: 200 }).rows.filter((row) => row.kind === "tool_call");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.detail.output).toBe(pretty);

  // The second lap saw the first result minified…
  const secondLap = model.seen[1]!;
  const firstResult = secondLap.find((message) => message.getType() === "tool")!;
  expect(contentOf(firstResult)).toBe(minifyToolResult(pretty));
  // …and the third saw it as a stub, because by then it had been read.
  const thirdLap = model.seen[2]!;
  const results = thirdLap.filter((message) => message.getType() === "tool");
  expect(contentOf(results[0]!)).toContain("[earlier lap] sessions_find");
  expect(contentOf(results[1]!)).toBe(minifyToolResult(pretty));
  agent.close();
});

/* ------------------------------------------------------------------ *
 * Older turns, folded — #541 part F.
 * ------------------------------------------------------------------ */

const turn = (ask: string, tools: string[], answer: string): BaseMessage[] => [
  human(ask),
  ...tools.flatMap((name, index) => [asked(`${ask}_${index}`, name), answered(`${ask}_${index}`, "x".repeat(3_000))]),
  new AIMessage(answer),
];

test("a conversation inside its budget is not folded at all", () => {
  const messages = [...turn("first", ["sessions_list"], "two are running"), ...turn("second", [], "nothing else")];
  const folded = foldOldTurns(messages, { budgetChars: 500_000 });
  expect(folded.folded).toBe(0);
  expect(folded.messages).toEqual(messages);
});

test("the oldest turns become one line each, and the newest stays verbatim", () => {
  const messages = [
    ...turn("what is running", ["sessions_list", "sessions_status"], "two are running"),
    ...turn("find the dictation thread", ["sessions_find", "sessions_find", "sessions_find"], "it is session_a"),
    ...turn("what did it conclude", ["sessions_answer"], "the language picker went in"),
  ];
  const folded = foldOldTurns(messages, { budgetChars: 12_000 });
  expect(folded.folded).toBeGreaterThan(0);

  const [ask, block, ...rest] = folded.messages;
  expect(ask!.getType()).toBe("human");
  expect(block!.getType()).toBe("ai");
  expect(isFold(ask!)).toBe(true);
  expect(isFold(block!)).toBe(true);
  // The line is the projection's three fields: what was asked, what it did,
  // what it answered.
  expect(String(block!.content)).toContain("what is running");
  expect(String(block!.content)).toContain("sessions_list");
  expect(String(block!.content)).toContain("two are running");
  // Repeats are counted rather than listed.
  if (folded.folded > 1) expect(String(block!.content)).toContain("sessions_find ×3");
  // The turn being answered is untouched.
  expect(String(rest.at(-1)!.content)).toBe("the language picker went in");
  expect(rest.at(0)!.getType()).toBe("human");
});

test("the pair is human-then-assistant, which is the shape both routes take", () => {
  const messages = [...turn("a", ["sessions_list"], "x"), ...turn("b", ["sessions_list"], "y"), ...turn("c", [], "z")];
  const folded = foldOldTurns(messages, { budgetChars: 4_000 });
  const types = folded.messages.map((message) => message.getType());
  expect(types[0]).toBe("human");
  expect(types[1]).toBe("ai");
  // No system message appears mid-conversation: the Anthropic-shaped route has
  // nowhere to put one.
  expect(types).not.toContain("system");
});

test("a summary is never summarised: folding twice is folding once", () => {
  const messages = [...turn("a", ["sessions_list"], "x"), ...turn("b", ["sessions_list"], "y"), ...turn("c", [], "z")];
  const once = foldOldTurns(messages, { budgetChars: 4_000 });
  const twice = foldOldTurns(once.messages, { budgetChars: 4_000 });
  // The second pass sees the fold's own messages, drops them as stale, and has
  // only the verbatim tail left to read — so it folds nothing and the lines
  // cannot become input to another line.
  expect(twice.folded).toBe(0);
  expect(twice.messages.some((message) => isFold(message))).toBe(false);
  // And the pass that matters is deterministic.
  expect(foldOldTurns(messages, { budgetChars: 4_000 }).messages.map(contentOf)).toEqual(once.messages.map(contentOf));
});

test("the folded block has its own ceiling, and says what it left out", () => {
  const many = Array.from({ length: 400 }, (_, index) => turn(`question number ${index} ${"q".repeat(200)}`, ["sessions_list"], `answer ${index}`)).flat();
  const folded = foldOldTurns(many, { budgetChars: 8_000 });
  const block = folded.messages[1]!;
  expect(String(block.content).length).toBeLessThan(FOLD_BLOCK_CHARS + 500);
  expect(String(block.content)).toContain("in the thread only");
});

test("one line is a fixed size whatever the turn weighed", () => {
  const line = foldedTurnLine(turn(`${"a".repeat(4_000)}`, ["sessions_find", "sessions_find"], "b".repeat(4_000)));
  expect(line.length).toBeLessThan(FOLD_INPUT_CHARS + FOLD_ANSWER_CHARS + 120);
  expect(line).toContain("sessions_find ×2");
});
