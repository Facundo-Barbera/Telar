/**
 * THE AGENT'S TRANSCRIPT — what rows become, and what two sources make of one
 * list (#531).
 *
 * THE CLAIMS WORTH HOLDING ARE THE ONES ABOUT DUPLICATION. Rows arrive from a
 * page AND from a stream that replays from the same cursor, and a reconnect
 * replays again — so a merge that appended would double the overlap every time
 * the connection blinked. A delta is pushed live and the row that follows
 * carries the same words, so a transcript that drew both would say everything
 * twice. Neither failure is visible in a happy-path render; both are certain in
 * a long session.
 *
 * AND THE ONE ABOUT WHERE THE ASSISTANT'S WORDS LIVE. The log declares an
 * `assistant_message` kind and today's runtime puts the answer on `turn_done`
 * instead. Both must draw, or this screen is empty now or silently lossy later.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { AgentRow } from "@telar/engine-client";
import { agentItems, liveAssistantItem, mergeAgentRows } from "./thread";

const row = (id: number, kind: AgentRow["kind"], detail: Record<string, unknown> = {}, runId = "run_one"): AgentRow =>
  ({ id, threadId: "thread_one", runId, at: 1_000 + id, kind, detail });

describe("merging rows from a page and a stream", () => {
  test("the overlap a replay produces is absorbed, not appended", () => {
    const paged = [row(1, "user_message", { text: "hello" }), row(2, "turn_started")];
    // The stream replays from the caller's cursor and then goes live.
    const streamed = [row(2, "turn_started"), row(3, "turn_done", { status: "completed", text: "hi" })];
    const merged = mergeAgentRows(paged, streamed);
    expect(merged.map((each) => each.id)).toEqual([1, 2, 3]);
  });

  test("ordered by id, not by arrival and not by time", () => {
    // Two rows written in the same millisecond must not swap places between
    // reads; ids are monotonic within a thread and timestamps are not.
    const same = [
      { ...row(7, "tool_call"), at: 5_000 },
      { ...row(6, "user_message"), at: 5_000 },
    ];
    expect(mergeAgentRows([], same).map((each) => each.id)).toEqual([6, 7]);
  });

  test("an empty push keeps the identity of what is held", () => {
    // The stream's keep-alive and its non-row frames must not cost a re-render.
    const held = [row(1, "user_message", { text: "hello" })];
    expect(mergeAgentRows(held, [])).toBe(held);
  });
});

describe("what rows draw", () => {
  test("a user message, and a wake that says it was not a person", () => {
    const items = agentItems([
      row(1, "user_message", { text: "what is happening", origin: "user" }),
      row(2, "user_message", { text: "[notice]", origin: "wake", wakeReason: "turn_completed" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "what is happening" });
    expect(items[0]).not.toHaveProperty("wakeReason");
    expect(items[1]).toMatchObject({ kind: "user", origin: "wake", wakeReason: "turn_completed" });
  });

  test("the assistant's words from BOTH places they can live", () => {
    // Today's runtime puts the answer on `turn_done`…
    expect(agentItems([row(1, "turn_done", { status: "completed", text: "done" })])).toEqual([
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]);
    // …and the log declares a kind for it that a later runtime may emit.
    expect(agentItems([row(1, "assistant_message", { text: "thinking aloud" })])).toEqual([
      expect.objectContaining({ kind: "assistant", text: "thinking aloud" }),
    ]);
  });

  test("a turn that only ran tools draws no empty bubble", () => {
    expect(agentItems([row(1, "turn_done", { status: "completed" })])).toEqual([]);
    expect(agentItems([row(1, "assistant_message", { text: "" })])).toEqual([]);
  });

  test("a tool row keeps its status, and an unknown status is not a failure", () => {
    const items = agentItems([
      row(1, "tool_call", { name: "sessions_list", input: { limit: 5 }, output: "…", status: "completed" }),
      row(2, "tool_call", { name: "sessions_stop", input: {}, output: "no", status: "declined" }),
      row(3, "tool_call", { name: "notes_write", input: {}, output: "boom", status: "failed" }),
      // A status this client has never heard of must read as the ordinary case
      // rather than painting a failure over a tool call that worked.
      row(4, "tool_call", { name: "notes_list", input: {}, output: "ok", status: "something_new" }),
    ]);
    expect(items.map((each) => (each as { status: string }).status)).toEqual(["completed", "declined", "failed", "completed"]);
  });

  test("stopped and failed are different sentences", () => {
    const items = agentItems([
      row(1, "turn_done", { status: "stopped" }),
      row(2, "turn_done", { status: "failed", message: "the model refused" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "failure", status: "stopped" });
    expect(items[0]).not.toHaveProperty("message");
    expect(items[1]).toMatchObject({ kind: "failure", status: "failed", message: "the model refused" });
  });

  test("turn_started and the request rows are not drawn as messages", () => {
    // `turn_started` says nothing the user message above it does not, and an
    // open approval is LIVE state — a card drawn from history would resurrect
    // decisions already made.
    expect(
      agentItems([
        row(1, "turn_started", { origin: "user" }),
        row(2, "request_opened", { id: "req_1", tool: "sessions_send" }),
        row(3, "request_resolved", { requestId: "req_1", decision: "accept" }),
      ]),
    ).toEqual([]);
  });

  test("a row whose detail is missing its fields still draws something", () => {
    // The detail column is untyped JSON. A row that lost a field must not take
    // the screen down with it.
    const items = agentItems([row(1, "user_message", {}), row(2, "tool_call", {})]);
    expect(items[0]).toMatchObject({ kind: "user", text: "" });
    expect(items[1]).toMatchObject({ kind: "tool", name: "tool", output: "" });
  });
});

describe("the live sentence", () => {
  test("shows while its run has landed no durable row", () => {
    const item = liveAssistantItem([row(1, "user_message", { text: "go" })], { runId: "run_one", text: "work" });
    expect(item).toMatchObject({ kind: "assistant", text: "work", streaming: true });
  });

  test("disappears the moment the row that carries the same words lands", () => {
    // THE BUG THIS PREVENTS is the sentence appearing twice — once from the
    // live buffer and once from the durable row that repeats it.
    const landed = [row(1, "turn_done", { status: "completed", text: "work" })];
    expect(liveAssistantItem(landed, { runId: "run_one", text: "work" })).toBeUndefined();
    // …and the same for the row kind the log declares.
    expect(liveAssistantItem([row(1, "assistant_message", { text: "work" })], { runId: "run_one", text: "work" })).toBeUndefined();
  });

  test("another run's row does not silence this one's buffer", () => {
    const other = [row(1, "turn_done", { status: "completed", text: "earlier" }, "run_earlier")];
    expect(liveAssistantItem(other, { runId: "run_two", text: "now" })).toMatchObject({ text: "now" });
  });

  test("nothing at all when there is nothing buffered", () => {
    expect(liveAssistantItem([], undefined)).toBeUndefined();
    expect(liveAssistantItem([], { runId: "run_one", text: "" })).toBeUndefined();
  });

  test("it sorts to the end of the transcript", () => {
    const rows = [row(1, "user_message", { text: "go" })];
    const item = liveAssistantItem(rows, { runId: "run_one", text: "work" })!;
    expect(item.id).toBeGreaterThan(rows.at(-1)!.id);
  });
});
