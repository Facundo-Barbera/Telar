/**
 * THE CONVERSATION, REBUILT FROM THE TRANSCRIPT (#526).
 *
 * What must not drift:
 *
 *   - the SYSTEM prompt and the CURRENT turn survive any budget, because a
 *     model that forgot what it is, or what it was just asked, is worse than one
 *     that forgot last Tuesday;
 *   - a tool RESULT never outlives its CALL — an orphan `tool` message is a 400
 *     from the API, not a slightly shorter history;
 *   - the kept history is a contiguous TAIL, so it reads as a conversation
 *     rather than one with a hole in the middle;
 *   - the current run's own rows are not replayed as history beside the prompt
 *     that produced them.
 */
import { expect, test } from "bun:test";
import type { Item, ItemDetail } from "@telar/engine-client";
import { buildGoMessages, transcriptMessages } from "../src/main-session/history";

let clock = 0;
const item = (detail: ItemDetail, over: Partial<Item> = {}): Item => {
  clock += 1;
  return {
    id: `item_${clock}`,
    runId: over.runId ?? "run_old",
    sessionId: "session_main",
    status: "completed",
    detail,
    startedAt: clock,
    ...over,
  } as Item;
};

const user = (text: string, over: Partial<Item> = {}) => item({ type: "user_message", text }, over);
const assistant = (text: string, over: Partial<Item> = {}) => item({ type: "assistant_message", text }, over);
const call = (name: string, id: string, input: unknown, output: unknown, over: Partial<Item> = {}) =>
  item({ type: "dynamic_tool_call", call: { name, toolUseId: id, input, output } }, over);

test("a plain exchange becomes user and assistant messages, oldest first", () => {
  const blocks = transcriptMessages([user("hello"), assistant("hi")]);
  expect(blocks).toEqual([[{ role: "user", content: "hello" }], [{ role: "assistant", content: "hi" }]]);
});

test("a tool call becomes an assistant call plus its paired result", () => {
  const [block] = transcriptMessages([call("sessions_list", "call_1", { limit: 5 }, "two sessions")]);
  expect(block).toEqual([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "sessions_list", arguments: '{"limit":5}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "two sessions" },
  ]);
});

test("a tool call with no provider id is dropped whole rather than given one", () => {
  // The id is what pairs a result to a call; inventing one would pair a result
  // to a call the model never made.
  expect(transcriptMessages([item({ type: "dynamic_tool_call", call: { name: "sessions_list" } })])).toEqual([]);
});

test("rows that are not conversation are left out", () => {
  const rows = [
    item({ type: "reasoning", text: "thinking" }),
    item({ type: "plan", plan: { steps: [{ step: "one", status: "pending" }] } }),
    item({ type: "error", error: { message: "it broke" } }),
    item({ type: "context_compaction" }),
  ];
  expect(transcriptMessages(rows)).toEqual([]);
});

test("an agent notice is what the model saw, so it is what goes back", () => {
  // The body is the peer's whole message; the notice is what the provider was
  // actually handed at the time. Replaying the body would rewrite history into
  // something the model never read.
  const rows = [item({ type: "user_message", text: "the whole 3k message", notice: "[peer sent you work]" })];
  expect(transcriptMessages(rows)).toEqual([[{ role: "user", content: "[peer sent you work]" }]]);
});

test("the system prompt and the current turn survive a budget that fits nothing else", () => {
  const messages = buildGoMessages({
    system: "you are main",
    items: [user("ancient"), assistant("also ancient")],
    prompt: "what now",
    budgetChars: 1,
  });
  expect(messages).toEqual([
    { role: "system", content: "you are main" },
    { role: "user", content: "what now" },
  ]);
});

test("trimming keeps a contiguous tail — the newest exchanges, never a hole in the middle", () => {
  const rows = [user("one"), assistant("first"), user("two"), assistant("second"), user("three"), assistant("third")];
  const full = buildGoMessages({ system: "s", items: rows, prompt: "now" });
  expect(full).toHaveLength(8);

  // Enough for the fixed pair plus roughly the last two blocks.
  const fixed = JSON.stringify({ role: "system", content: "s" }).length + JSON.stringify({ role: "user", content: "now" }).length;
  const block = JSON.stringify({ role: "assistant", content: "third" }).length;
  const trimmed = buildGoMessages({ system: "s", items: rows, prompt: "now", budgetChars: fixed + block * 2 + 4 });

  expect(trimmed[0]).toEqual({ role: "system", content: "s" });
  expect(trimmed.at(-1)).toEqual({ role: "user", content: "now" });
  const middle = trimmed.slice(1, -1);
  expect(middle).toEqual([
    { role: "user", content: "three" },
    { role: "assistant", content: "third" },
  ]);
});

test("a tool call and its result are trimmed together, never half in", () => {
  const rows = [call("sessions_list", "call_1", {}, "a".repeat(400)), user("recent"), assistant("answer")];
  const fixed = JSON.stringify({ role: "system", content: "s" }).length + JSON.stringify({ role: "user", content: "now" }).length;
  // Room for the recent pair and nowhere near enough for the 400-char result.
  const messages = buildGoMessages({ system: "s", items: rows, prompt: "now", budgetChars: fixed + 120 });

  expect(messages.some((message) => message.role === "tool")).toBe(false);
  // And when there is room, BOTH halves are there.
  const whole = buildGoMessages({ system: "s", items: rows, prompt: "now" });
  const toolMessages = whole.filter((message) => message.role === "tool");
  expect(toolMessages).toHaveLength(1);
  const calls = whole.filter((message) => message.role === "assistant" && "tool_calls" in message && message.tool_calls);
  expect(calls).toHaveLength(1);
});

test("the current run's own rows are not replayed beside the prompt that produced them", () => {
  const rows = [user("old question"), assistant("old answer"), user("what now", { runId: "run_live" })];
  const messages = buildGoMessages({ system: "s", items: rows, prompt: "what now", currentRunId: "run_live" });
  expect(messages.filter((message) => message.role === "user" && message.content === "what now")).toHaveLength(1);
});

test("rows are ordered by when they started, not by the order they were handed over", () => {
  const first = user("first", { startedAt: 1 });
  const second = assistant("second", { startedAt: 2 });
  // Handed over newest-first on purpose: the store's read order is not a
  // promise, and a history in the wrong order is a model answering backwards.
  const messages = transcriptMessages([second, first]);
  expect(messages).toEqual([[{ role: "user", content: "first" }], [{ role: "assistant", content: "second" }]]);
});
