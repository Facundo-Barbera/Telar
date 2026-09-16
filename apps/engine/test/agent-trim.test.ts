/**
 * THE PRE-MODEL TRIM, ON THE FRAMEWORK'S MESSAGES (#531).
 *
 * What must not drift — the three rules `main-session/history.ts` established
 * and this keeps, because LangGraph manages no context at all:
 *
 *   - a tool RESULT never outlives its CALL, so the unit is a block;
 *   - what survives is a contiguous TAIL, not the cheapest subset;
 *   - the newest block survives any budget, because dropping it means
 *     answering a question nobody asked.
 */
import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { messageBlocks, trimAgentMessages } from "../src/agent/trim";

const human = (text: string) => new HumanMessage(text);
const said = (text: string) => new AIMessage(text);
const asked = (id: string, name: string) => new AIMessage({ content: "", tool_calls: [{ id, name, args: {}, type: "tool_call" }] });
const answered = (id: string, text: string) => new ToolMessage({ tool_call_id: id, content: text });

test("a call and its result are one block; everything else is a block of one", () => {
  const blocks = messageBlocks([human("hi"), asked("call_1", "sessions_list"), answered("call_1", "rows"), said("there are two")]);
  expect(blocks.map((block) => block.messages.length)).toEqual([1, 2, 1]);
});

test("an orphan result joins the block above rather than becoming one of its own", () => {
  // Should not happen — the graph writes both halves in one update — but a
  // checkpoint from an older build must not produce a block the trim can keep
  // alone and then 400 the API with.
  const blocks = messageBlocks([human("hi"), answered("call_gone", "stray")]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.messages).toHaveLength(2);
});

test("a conversation inside the budget is returned untouched", () => {
  const messages = [human("hi"), said("hello"), human("and again")];
  expect(trimAgentMessages(messages)).toEqual(messages);
});

test("the tail is contiguous, and a call never loses its result", () => {
  const big = "x".repeat(4_000);
  const messages = [
    human(`old ${big}`),
    asked("call_1", "sessions_read"),
    answered("call_1", big),
    human("recent"),
    said("answered"),
  ];
  // Tight enough that the call block does not fit: it goes WHOLE, taking its
  // result with it, rather than leaving a `tool` message with no call above it.
  const kept = trimAgentMessages(messages, { budgetChars: 4_000 });
  expect(kept.map((message) => message.getType())).toEqual(["human", "ai"]);
  expect(kept.some((message) => message.getType() === "tool")).toBe(false);
});

test("the newest block survives a budget it cannot possibly fit", () => {
  const enormous = "y".repeat(50_000);
  const kept = trimAgentMessages([human("old"), human(enormous)], { budgetChars: 10 });
  expect(kept).toHaveLength(1);
  expect(String(kept[0]!.content)).toBe(enormous);
});

test("the system prompt is charged against the budget rather than trusted to fit", () => {
  const block = "z".repeat(1_000);
  const messages = [human(block), human(block), human("newest")];
  const roomy = trimAgentMessages(messages, { budgetChars: 3_000 });
  const crowded = trimAgentMessages(messages, { budgetChars: 3_000, reservedChars: 2_000 });
  expect(roomy.length).toBeGreaterThan(crowded.length);
});

test("an empty conversation trims to nothing rather than throwing", () => {
  expect(trimAgentMessages([])).toEqual([]);
});
