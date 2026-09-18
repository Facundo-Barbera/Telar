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
 *   - a summary is never summarised — folding twice is folding once;
 *   - and it goes to a LOW-water mark (#567): the ceiling triggers a fold, the
 *     floor stops it, and a history between the two is left alone. Without the
 *     gap the meter sat at 100% for ever, because the mark that stopped the
 *     fold was the mark that started it.
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
  answerOrphanedCalls,
  compactToolResults,
  FOLD_ANSWER_CHARS,
  FOLD_BLOCK_CHARS,
  FOLD_INPUT_CHARS,
  FOLD_TARGET_RATIO,
  foldOldTurns,
  foldedTurnLine,
  isFold,
  minifyToolResult,
  ORPHANED_CALL_RESULT,
  toolResultStub,
} from "../src/agent/compact";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { AgentRuntime } from "../src/agent/runtime";
import { trimAgentHistory } from "../src/agent/trim";
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
 * The same sixteen calls, in laps — #570's measurement.
 * ------------------------------------------------------------------ */

/**
 * THE SAME FIXTURE, GROUPED THE WAY THE BRIEFING NOW ASKS FOR IT.
 *
 * ── WHY GROUPING BY KIND IS THE HONEST GROUPING, NOT A FLATTERING ONE ───────
 * It is the fixture's real dependency structure. The nine searches do not need
 * each other's answers, so they are one message; the three outlines need the
 * searches' results, so they are the next; the four answer reads need the
 * outlines'. Three batches is what this turn's data dependencies allow, and no
 * regrouping could make it two.
 *
 * ── AND WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────
 * It is a measurement of the ENGINE's lap arithmetic for a given batching, not
 * an observation of a model choosing to batch. Nothing in a unit test can hold
 * a model to a briefing sentence; what the engine now guarantees is that a
 * message's calls run TOGETHER when they arrive together, and that the turn
 * lands with an answer whether they do or not.
 */
function batches(laps: Array<{ name: string; result: string }>): Array<Array<{ name: string; result: string }>> {
  const kinds = ["sessions_find", "sessions_outline", "sessions_answer"];
  return kinds.map((kind) => laps.filter((lap) => lap.name === kind)).filter((batch) => batch.length > 0);
}

/** What one turn sends the model when each batch is ONE message carrying all of
 *  its calls — `turnCost`'s arithmetic, one message per batch instead of one per
 *  call. */
function batchedTurnCost(grouped: Array<Array<{ name: string; result: string }>>, options: { compact: boolean }): number {
  let history: BaseMessage[] = [human("find the thread about the dictation feature")];
  let total = 0;
  grouped.forEach((batch, round) => {
    total += cost(options.compact ? compactToolResults(history) : history);
    const calls: ToolCall[] = batch.map((lap, index) => ({ id: `call_${round}_${index}`, name: lap.name, args: {}, type: "tool_call" }));
    const results = batch.map(
      (lap, index) => new ToolMessage({ tool_call_id: `call_${round}_${index}`, content: options.compact ? minifyToolResult(lap.result) : lap.result }),
    );
    history = [...history, new AIMessage({ content: "", tool_calls: calls }), ...results];
  });
  total += cost(options.compact ? compactToolResults(history) : history);
  return total;
}

test("the 16-lap turn is four laps when its independent reads share a message", () => {
  const laps = sixteenLaps();
  const grouped = batches(laps);

  // BEFORE: one call per message is one lap per call, plus the lap that answers.
  const before = laps.length + 1;
  // AFTER: one message per set of reads that do not need each other's answers.
  const after = grouped.length + 1;
  expect(before).toBe(17);
  expect(after).toBe(4);

  // Every call is still made — batching changes how many times the model is
  // asked, never what the turn does.
  expect(grouped.flat()).toHaveLength(laps.length);

  // AND THE TURN NOW FITS UNDER THE CAP. Seventeen model calls is over MAX_LAPS,
  // which is how this turn met LangGraph's ceiling and died with no answer;
  // four is not close to it.
  expect(before).toBeGreaterThan(12);
  expect(after).toBeLessThan(12);

  // The prompt cost falls with the lap count, because the count is what the
  // per-lap prefix was being paid for.
  expect(batchedTurnCost(grouped, { compact: true })).toBeLessThan(turnCost(laps, { compact: true }));
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

/* ------------------------------------------------------------------ *
 * The low-water mark — #567. The meter sat at 100% because the fold stopped at
 * the same number that started it.
 * ------------------------------------------------------------------ */

/**
 * WHAT THE NEXT PROMPT WOULD REALLY COST, measured the way the meter measures
 * it — `trimAgentHistory`'s own arithmetic, against a ceiling high enough that
 * it drops nothing. The point of #567 is a number a person reads off a gauge,
 * so the assertions are about that number rather than about a turn count.
 */
const measure = (messages: readonly BaseMessage[], reservedChars = 0) =>
  trimAgentHistory(messages, { budgetChars: Number.MAX_SAFE_INTEGER, reservedChars }).chars;

test("a saturated history folds to under the low-water mark, so the meter actually drops", () => {
  const budgetChars = 120_000;
  const messages = Array.from({ length: 40 }, (_, index) =>
    turn(`question number ${index}`, ["sessions_list", "sessions_find"], `answer number ${index}`),
  ).flat();
  // The conversation the issue is about: saturated, and over the ceiling.
  expect(measure(messages)).toBeGreaterThan(budgetChars);

  const folded = foldOldTurns(messages, { budgetChars });
  expect(folded.folded).toBeGreaterThan(0);
  // UNDER 60%, not "just under 100%". The old fold stopped at `budgetChars` and
  // left the next turn to start the whole thing again a few hundred characters
  // later; this one buys about 48k of room at the default budget.
  expect(measure(folded.messages)).toBeLessThanOrEqual(budgetChars * FOLD_TARGET_RATIO);
  // The newest turn is still there, whole — the fold bought room from the top.
  expect(contentOf(folded.messages.at(-1)!)).toBe("answer number 39");
});

test("a history between the two marks is left alone: the ceiling triggers a fold, the floor does not", () => {
  const messages = [
    ...turn("what is running", ["sessions_list"], "two are running"),
    ...turn("find the dictation thread", ["sessions_find"], "it is session_a"),
    ...turn("what did it conclude", ["sessions_answer"], "the language picker went in"),
  ];
  // A ceiling this history sits at 70% of: comfortably over the low-water mark
  // and comfortably under the one that starts a fold.
  const budgetChars = Math.ceil(measure(messages) / 0.7);
  expect(measure(messages)).toBeGreaterThan(budgetChars * FOLD_TARGET_RATIO);
  expect(measure(messages)).toBeLessThan(budgetChars);

  const folded = foldOldTurns(messages, { budgetChars });
  // NOT FOLDED DOWN TO THE FLOOR. The floor is where a fold STOPS; a
  // conversation that never crossed the ceiling is one an earlier fold already
  // made room in, and folding it again would spend its history for nothing.
  expect(folded.folded).toBe(0);
  expect(folded.messages).toEqual(messages);
});

test("the turn being answered survives even when the floor is out of reach", () => {
  const messages = [
    ...turn("first", ["sessions_list"], "two are running"),
    ...turn("second", ["sessions_find"], "it is session_a"),
    ...turn("last question", ["sessions_answer"], "the last answer"),
  ];
  // A budget no single turn fits in: the fold can never reach the floor, so the
  // rule that stops it has to be the other one.
  const folded = foldOldTurns(messages, { budgetChars: 1_000 });
  expect(folded.folded).toBe(2);

  const [, , ...tail] = folded.messages;
  expect(tail[0]!.getType()).toBe("human");
  expect(contentOf(tail[0]!)).toBe("last question");
  expect(contentOf(tail.at(-1)!)).toBe("the last answer");
  // VERBATIM, results and all — the turn being answered is never abridged, and
  // what is still over budget after this is `trimAgentHistory`'s problem.
  expect(tail.some((message) => message.getType() === "tool")).toBe(true);
});

test("one line is a fixed size whatever the turn weighed", () => {
  const line = foldedTurnLine(turn(`${"a".repeat(4_000)}`, ["sessions_find", "sessions_find"], "b".repeat(4_000)));
  expect(line.length).toBeLessThan(FOLD_INPUT_CHARS + FOLD_ANSWER_CHARS + 120);
  expect(line).toContain("sessions_find ×2");
});

test("through the runtime: the prompt folds, and every row is still in the thread", async () => {
  const wordy = "z".repeat(2_000);
  const tools: SocketTool[] = [
    { name: "sessions_list", description: "a fixture", shape: {}, run: async () => ({ content: [{ type: "text", text: wordy }] }) },
  ];
  const model = new ScriptedChatModel([
    { toolCalls: [{ id: "call_1", name: "sessions_list", args: {}, type: "tool_call" }] },
    { text: "two are running" },
    { toolCalls: [{ id: "call_2", name: "sessions_list", args: {}, type: "tool_call" }] },
    { text: "still two" },
    { text: "nothing new" },
  ]);
  const agent = new AgentRuntime({
    engineRoot: fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-fold-")),
    tools: () => tools,
    model: () => model,
    // Small enough that two ordinary turns cross it, but relative to the
    // briefing: the system block is charged against the budget, and a fixed
    // number here fails the day the briefing grows a sentence.
    budgetChars: AGENT_BRIEFING.length + 600,
  });
  agent.patch({ enabled: true });
  for (const text of ["what is running", "and now", "anything else"]) {
    agent.submit({ text });
    await until(() => agent.state().running === false && agent.state().queued === 0, `the turn for "${text}"`);
  }

  const last = model.seen.at(-1)!;
  expect(last.some((message) => isFold(message))).toBe(true);
  const block = last.find((message) => isFold(message) && message.getType() === "ai")!;
  expect(String(block.content)).toContain("what is running");
  expect(String(block.content)).toContain("sessions_list");

  // THE TRANSCRIPT KEEPS EVERYTHING. What the prompt folded is still a row, and
  // still carries the tool's whole answer.
  const rows = agent.thread({ limit: 200 }).rows;
  expect(rows.filter((row) => row.kind === "user_message").map((row) => row.detail.text)).toEqual(["what is running", "and now", "anything else"]);
  expect(rows.find((row) => row.kind === "tool_call")!.detail.output).toBe(wordy);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * A call nothing answered (owner, 2026-09-17).
 * ------------------------------------------------------------------ */

test("a tool call the turn died before answering is answered, so the next prompt is not a 400", () => {
  const messages = [
    human("como vamos?"),
    asked("call_dead", "sessions_answer"),
    // The turn ended here (recursion limit, crash, cancel). The next human
    // message follows the unanswered call directly.
    human("hola?"),
  ];
  const repaired = answerOrphanedCalls(messages);
  expect(repaired).toHaveLength(4);
  expect(repaired[2]!.getType()).toBe("tool");
  expect((repaired[2] as ToolMessage).tool_call_id).toBe("call_dead");
  expect(contentOf(repaired[2]!)).toBe(ORPHANED_CALL_RESULT);
  expect(repaired[3]).toBe(messages[2]!);
});

test("a call that was answered is left exactly as it was, and a partial answer set is completed", () => {
  const whole = [human("hi"), asked("call_1", "sessions_list"), answered("call_1", "rows")];
  expect(answerOrphanedCalls(whole)).toEqual(whole);
  const two = new AIMessage({
    content: "",
    tool_calls: [
      { id: "call_a", name: "sessions_find", args: {}, type: "tool_call" },
      { id: "call_b", name: "sessions_find", args: {}, type: "tool_call" },
    ],
  });
  const partial = [human("hi"), two, answered("call_a", "ok"), human("next")];
  const repaired = answerOrphanedCalls(partial);
  expect(repaired.map((m) => m.getType())).toEqual(["human", "ai", "tool", "tool", "human"]);
  // Both ids are answered before the next human message; which comes first
  // is not a fact the API cares about.
  expect(repaired.slice(2, 4).map((m) => (m as ToolMessage).tool_call_id).sort()).toEqual(["call_a", "call_b"]);
});

/* ------------------------------------------------------------------ *
 * The whole pre-model step, at the size the cluster failed at — #602.
 *
 * ── WHAT THE ISSUE MEASURED, AND WHY A UNIT TEST WAS NOT ENOUGH ─────────────
 * Three consecutive turns died on the same 400 — "an assistant message with
 * 'tool_calls' must be followed by tool messages" — at contextChars 64,697 /
 * 64,769 / 64,821, each having folded 38 turns, immediately after a turn that
 * burned 306,913 input tokens and died on the recursion limit. That death is
 * what leaves the dangling call in the checkpoint, and `answerOrphanedCalls`
 * repairs it.
 *
 * But the repair is the FIRST of four steps, and the two after it rearrange the
 * list: the fold replaces whole turns with a pair of messages, and the trim
 * drops blocks off the top. Proving the repair alone says nothing about what is
 * finally SENT. So this drives the real order — repair, compact, fold, trim —
 * at the fold depth and prompt size the cluster reported, and asserts the one
 * property the provider actually checks.
 * ------------------------------------------------------------------ */

/** The provider's rule, both directions: no call goes unanswered, and no result
 *  answers a call that is not above it. Returns the first breach, so a failure
 *  names what is wrong rather than just that something is. */
function pairingFault(messages: readonly BaseMessage[]): string | undefined {
  const asked_ = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.getType() === "ai") {
      const answers = new Set<string>();
      for (let next = index + 1; next < messages.length && messages[next]!.getType() === "tool"; next += 1) {
        answers.add((messages[next] as ToolMessage).tool_call_id);
      }
      for (const call of (message as AIMessage).tool_calls ?? []) {
        if (!call.id) continue;
        if (!answers.has(call.id)) return `call ${call.id} at ${index} is followed by no result`;
        asked_.add(call.id);
      }
      continue;
    }
    if (message.getType() !== "tool") continue;
    const id = (message as ToolMessage).tool_call_id;
    if (!asked_.has(id)) return `result at ${index} answers ${id}, which nothing above it asked for`;
  }
  return undefined;
}

/**
 * THE CHECKPOINT THE CLUSTER INHERITED: a long conversation whose LAST turn
 * ended between the model asking for a tool and the tools node answering, with
 * the person's next question directly underneath.
 *
 * The old turns are small and the recent ones heavy, which is what a real
 * conversation looks like once `compactToolResults` has been over the old laps —
 * and it is what puts the fold depth and the prompt size in the band the issue
 * measured.
 */
function threadWithADeadCall(): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let turn = 0; turn < 40; turn += 1) {
    messages.push(human(`older question ${turn}`));
    messages.push(asked(`call_old_${turn}`, "sessions_find"));
    messages.push(answered(`call_old_${turn}`, JSON.stringify({ sessions: [{ id: `session_${turn}` }], note: "x".repeat(1_400) })));
    messages.push(new AIMessage(`answer ${turn}`));
  }
  for (let turn = 0; turn < 5; turn += 1) {
    messages.push(human(`recent question ${turn}`));
    messages.push(asked(`call_recent_${turn}`, "sessions_answer"));
    messages.push(answered(`call_recent_${turn}`, JSON.stringify({ events: [{ id: turn }], body: "y".repeat(11_800) })));
    messages.push(new AIMessage(`recent answer ${turn}`));
  }
  // THE DEATH. `sessions_answer` was asked for and never ran — the turn hit the
  // recursion limit between the two supersteps — so the checkpoint ends with an
  // assistant message carrying a call and no result under it.
  messages.push(human("dame el resumen completo"));
  messages.push(asked("call_dead", "sessions_answer"));
  // And the person asks the next question into that.
  messages.push(human("Hola, ¿cómo estás?"));
  return messages;
}

/** `callModel`'s pre-model step, in its real order. Kept as one function so the
 *  test cannot accidentally prove something about a different sequence than the
 *  runtime runs. */
function preModel(messages: readonly BaseMessage[], options: { repair: boolean; budgetChars: number; reservedChars: number }) {
  const repaired = options.repair ? answerOrphanedCalls(messages) : [...messages];
  const folded = foldOldTurns(compactToolResults(repaired), options);
  const history = trimAgentHistory(folded.messages, options);
  return { ...history, folded: folded.folded };
}

test("at the size the cluster failed at, everything the prompt sends is still a matched pair", () => {
  const budgetChars = 120_000;
  const reservedChars = AGENT_BRIEFING.length;
  const messages = threadWithADeadCall();

  // BEFORE THE FIX: the same fixture, the same three steps after it, and the
  // breach the provider refused with a 400 is right there in what would be sent.
  const broken = preModel(messages, { repair: false, budgetChars, reservedChars });
  expect(pairingFault(broken.messages)).toContain("call_dead");

  // AFTER: nothing to refuse, and the repair survives the fold and the trim.
  const sent = preModel(messages, { repair: true, budgetChars, reservedChars });
  expect(pairingFault(sent.messages)).toBeUndefined();
  // The dead call is answered by the line that says so rather than quietly
  // dropped — the model is told the look never happened.
  const excuse = sent.messages.find((message) => message.getType() === "tool" && (message as ToolMessage).tool_call_id === "call_dead");
  expect(contentOf(excuse!)).toBe(ORPHANED_CALL_RESULT);
  // And the person's question is still the last thing in it.
  expect(contentOf(sent.messages.at(-1)!)).toBe("Hola, ¿cómo estás?");

  // AT THE MEASURED SIZE, which is what makes this the cluster's fixture rather
  // than a small hand-made list: a deep fold, and a prompt in the 64k band the
  // three failures reported against a 120k budget.
  expect(sent.folded).toBeGreaterThan(25);
  expect(sent.chars).toBeGreaterThan(50_000);
  expect(sent.chars).toBeLessThan(80_000);
  // The trim is a backstop and should not have fired at all — everything the
  // fold left fits, so nothing fell off the top.
  expect(sent.dropped).toBe(0);
});
