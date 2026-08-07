// THE PROJECTOR'S FIRST TESTS. route.ts's message loop ran untested from the
// route's birth until this extraction; these pin the load-bearing behaviours
// the client and the persisted transcript both depend on: event names/payloads
// byte-compatible with the old inline send() calls, parent flattening through
// spawn chains, first-write-wins tool results, supersedes eviction, the
// capture-don't-act result rule, and the three teardown finalizers.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  flushStreamingText,
  markInterruptedTools,
  newClaudeTurnState,
  projectClaudeMessage,
  rationToolDetail,
} from "./project-message";

const asMsg = (m: unknown) => m as SDKMessage;

const streamDelta = (text: string, parent?: string) =>
  asMsg({
    type: "stream_event",
    parent_tool_use_id: parent ?? null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

const assistantText = (text: string, opts?: { parent?: string; uuid?: string }) =>
  asMsg({
    type: "assistant",
    parent_tool_use_id: opts?.parent ?? null,
    uuid: opts?.uuid,
    message: { content: [{ type: "text", text }] },
  });

const assistantTool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  opts?: { parent?: string; uuid?: string },
) =>
  asMsg({
    type: "assistant",
    parent_tool_use_id: opts?.parent ?? null,
    uuid: opts?.uuid,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, output: string, isError = false) =>
  asMsg({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
    },
  });

describe("projectClaudeMessage", () => {
  test("deltas accumulate streaming text and emit byte-compatible delta events", () => {
    const state = newClaudeTurnState();
    const a = projectClaudeMessage(streamDelta("Hel"), state);
    const b = projectClaudeMessage(streamDelta("lo"), state);
    expect(a.events).toEqual([{ event: "delta", data: { text: "Hel" } }]);
    expect(b.events).toEqual([{ event: "delta", data: { text: "lo" } }]);
    expect(state.streamingText.get(null)).toBe("Hello");
  });

  test("an assistant text block finalizes the streamed block and persists a part", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(streamDelta("Hello"), state);
    const p = projectClaudeMessage(assistantText("Hello"), state);
    expect(p.events).toEqual([{ event: "text", data: { text: "Hello" } }]);
    expect(p.mainAssistantStep).toBe(true);
    expect(state.parts).toEqual([{ type: "text", text: "Hello" }]);
    // The streamed accumulation was superseded by the finalized block.
    expect(state.streamingText.get(null)).toBe("");
  });

  test("a subagent's assistant message is parent-attributed, not a main step", () => {
    const state = newClaudeTurnState();
    // The spawn must be seen first so the flattener knows the parent id.
    projectClaudeMessage(assistantTool("spawn-1", "Agent", { prompt: "explore" }), state);
    const p = projectClaudeMessage(assistantText("found it", { parent: "spawn-1" }), state);
    expect(p.mainAssistantStep).toBe(false);
    expect(p.events).toEqual([{ event: "text", data: { text: "found it", parent: "spawn-1" } }]);
    expect(state.parts[1]).toEqual({ type: "text", text: "found it", parentId: "spawn-1" });
  });

  test("an Agent spawn gets agent meta and flattens nested sub-spawns to the top id", () => {
    const state = newClaudeTurnState();
    const spawn = projectClaudeMessage(
      assistantTool("top", "Agent", { prompt: "p", description: "d" }),
      state,
    );
    const toolEvent = spawn.events[0] as { event: string; data: Record<string, unknown> };
    expect(toolEvent.event).toBe("tool");
    expect(toolEvent.data.agent).toBeDefined();
    // The subagent itself spawns a child; messages under the CHILD's id must
    // resolve to the TOP-level spawn (ParentFlattener.noteSpawn chain).
    projectClaudeMessage(assistantTool("child", "Task", { prompt: "q" }, { parent: "top" }), state);
    const deep = projectClaudeMessage(assistantText("deep", { parent: "child" }), state);
    expect(deep.events[0]).toEqual({ event: "text", data: { text: "deep", parent: "top" } });
  });

  test("tool results attach first-write-wins and flag CLI-cancelled fillers", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(assistantTool("t1", "Read", { file_path: "/x" }), state);
    const first = projectClaudeMessage(toolResult("t1", "contents"), state);
    expect(first.events).toEqual([
      { event: "tool_result", data: { id: "t1", output: "contents", isError: false } },
    ]);
    // A duplicate/retried delivery must not overwrite the resolved result.
    const dup = projectClaudeMessage(toolResult("t1", "stale rewrite"), state);
    expect(dup.events).toEqual([]);
    const part = state.parts[0] as Extract<(typeof state.parts)[number], { type: "tool" }>;
    expect(part.output).toBe("contents");
    // The CLI's compiled-in interrupt filler is flagged, not rendered as a refusal.
    projectClaudeMessage(assistantTool("t2", "Glob", { pattern: "*" }), state);
    const cancelled = projectClaudeMessage(
      toolResult(
        "t2",
        "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
        true,
      ),
      state,
    );
    const data = (cancelled.events[0] as { data: Record<string, unknown> }).data;
    expect(data.cancelled).toBe(true);
  });

  test("a stray tool_result matching no part is skipped silently", () => {
    const state = newClaudeTurnState();
    const p = projectClaudeMessage(toolResult("ghost", "noise"), state);
    expect(p.events).toEqual([]);
    expect(state.parts).toEqual([]);
  });

  test("task_notification records taskStatus on the spawn part and emits task_status", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(assistantTool("spawn-1", "Agent", { prompt: "bg" }), state);
    const p = projectClaudeMessage(
      asMsg({ type: "system", subtype: "task_notification", tool_use_id: "spawn-1", status: "completed" }),
      state,
    );
    expect(p.events).toEqual([
      { event: "task_status", data: { id: "spawn-1", status: "completed" } },
    ]);
    const part = state.parts[0] as Extract<(typeof state.parts)[number], { type: "tool" }>;
    expect(part.taskStatus).toBe("completed");
  });

  test("permission_denied rewrites the SDK text and synthesizes a part when none exists", () => {
    const state = newClaudeTurnState();
    const p = projectClaudeMessage(
      asMsg({
        type: "system",
        subtype: "permission_denied",
        tool_name: "WebFetch",
        tool_use_id: "pd-1",
        message: "The user doesn't want to proceed",
        decision_reason_type: "hook",
      }),
      state,
    );
    expect(p.events[0]?.event).toBe("permission_denied");
    const part = state.parts[0] as Extract<(typeof state.parts)[number], { type: "tool" }>;
    expect(part.autoDenied).toBe(true);
    expect(part.isError).toBe(true);
    expect(part.output).toBeDefined();
  });

  test("supersedes evicts exactly the parts from the retracted frames", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(assistantText("kept", { uuid: "u-keep" }), state);
    projectClaudeMessage(assistantTool("t1", "Bash", { command: "x" }, { uuid: "u-dead" }), state);
    projectClaudeMessage(
      asMsg({
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "u-new",
        supersedes: ["u-dead"],
        message: { content: [{ type: "text", text: "replacement" }] },
      }),
      state,
    );
    expect(
      state.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool" ? p.id : "")),
    ).toEqual(["kept", "replacement"]);
    expect(state.partOrigin).toEqual(["u-keep", "u-new"]);
  });

  test("compact_boundary emits the event AND returns the fact for the caller's fold", () => {
    const state = newClaudeTurnState();
    const p = projectClaudeMessage(
      asMsg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 12_000 },
      }),
      state,
    );
    expect(p.compaction?.trigger).toBe("auto");
    expect(p.compaction?.preTokens).toBe(90_000);
    expect(p.events[0]?.event).toBe("compact_boundary");
  });

  test("result is captured, never emitted, and the LAST result wins", () => {
    const state = newClaudeTurnState();
    const first = projectClaudeMessage(
      asMsg({ type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 3 }),
      state,
    );
    expect(first.events).toEqual([]);
    projectClaudeMessage(
      asMsg({ type: "result", subtype: "success", total_cost_usd: 0.8, num_turns: 5 }),
      state,
    );
    expect(state.lastResult?.totalCostUsd).toBe(0.8);
    expect(state.costUsd).toBe(0.8);
  });

  test("main-thread usage is captured for CTX; subagent usage is not", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(
      asMsg({
        type: "assistant",
        parent_tool_use_id: null,
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 }, content: [] },
      }),
      state,
    );
    expect(state.lastMainUsage).toEqual({ input_tokens: 100, cache_read_input_tokens: 50 });
    projectClaudeMessage(assistantTool("s", "Agent", { prompt: "p" }), state);
    projectClaudeMessage(
      asMsg({
        type: "assistant",
        parent_tool_use_id: "s",
        message: { usage: { input_tokens: 999_999 }, content: [] },
      }),
      state,
    );
    expect(state.lastMainUsage).toEqual({ input_tokens: 100, cache_read_input_tokens: 50 });
  });
});

describe("teardown finalizers", () => {
  test("flushStreamingText pushes leftover streamed text per parent", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(assistantTool("spawn-1", "Agent", { prompt: "p" }), state);
    projectClaudeMessage(streamDelta("main in flight"), state);
    projectClaudeMessage(streamDelta("sub in flight", "spawn-1"), state);
    flushStreamingText(state);
    const texts = state.parts.filter((p) => p.type === "text");
    expect(texts).toEqual([
      { type: "text", text: "main in flight" },
      { type: "text", text: "sub in flight", parentId: "spawn-1" },
    ]);
  });

  test("markInterruptedTools flags only outputless tool parts and reports it", () => {
    const state = newClaudeTurnState();
    projectClaudeMessage(assistantTool("done", "Read", { file_path: "/x" }), state);
    projectClaudeMessage(toolResult("done", "ok"), state);
    projectClaudeMessage(assistantTool("hung", "Bash", { command: "sleep" }), state);
    expect(markInterruptedTools(state)).toBe(true);
    const byId = new Map(
      state.parts.flatMap((p) => (p.type === "tool" ? [[p.id, p] as const] : [])),
    );
    expect(byId.get("hung")?.interrupted).toBe(true);
    expect(byId.get("done")?.interrupted).toBeUndefined();
    // Nothing hanging → false, so the caller skips the "interrupted" broadcast.
    expect(markInterruptedTools(newClaudeTurnState())).toBe(false);
  });

  test("rationToolDetail budgets detail PER PARENT, not with one shared counter", () => {
    const state = newClaudeTurnState();
    // A chatty subagent burns 3 calls; the main thread makes 2. Cap of 2 must
    // strip only the subagent's third call, never the main thread's own.
    projectClaudeMessage(assistantTool("spawn-1", "Agent", { prompt: "p" }), state);
    for (let i = 0; i < 3; i++) {
      projectClaudeMessage(
        assistantTool(`sub-${i}`, "Read", { file_path: `/${i}` }, { parent: "spawn-1" }),
        state,
      );
      projectClaudeMessage(toolResult(`sub-${i}`, "data"), state);
    }
    projectClaudeMessage(assistantTool("main-1", "Read", { file_path: "/m" }), state);
    projectClaudeMessage(toolResult("main-1", "data"), state);
    rationToolDetail(state, 2);
    const byId = new Map(
      state.parts.flatMap((p) => (p.type === "tool" ? [[p.id, p] as const] : [])),
    );
    expect(byId.get("sub-2")?.output).toBeUndefined();
    expect(byId.get("sub-2")?.input).toBeUndefined();
    expect(byId.get("sub-1")?.output).toBe("data");
    // Main thread: spawn-1 + main-1 = 2 calls, both inside the budget.
    expect(byId.get("main-1")?.output).toBe("data");
    expect(byId.get("spawn-1")?.input).toBeDefined();
  });
});
