import { expect, test } from "bun:test";
import type { TurnObservation } from "@telar/engine-client";
import {
  createClaudeDriver,
  itemDetailForToolCall,
  ProviderUnavailableError,
  taskKindForType,
  taskStateForStatus,
  titleForToolCall,
} from "../src/driver";

/** Collect everything a run reports, in order, the way the worker relays it. */
function recorder() {
  const observations: TurnObservation[] = [];
  return {
    observations,
    onObservations: async (batch: TurnObservation[]) => void observations.push(...batch),
  };
}

const run = (driver: ReturnType<typeof createClaudeDriver>, extra: Record<string, unknown> = {}) => {
  const sink = recorder();
  return {
    sink,
    result: driver.run({
      prompt: "prompt",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onObservations: sink.onObservations,
      ...extra,
    }),
  };
};

test("the Claude seam forwards SDK text and accepts only an explicit successful result", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await expect(result).resolves.toMatchObject({ text: "hello" });
  // No stream events, so the envelope is the compatibility fallback and the
  // text arrives as one complete item rather than as deltas.
  expect(sink.observations.map((o) => o.kind)).toEqual(["item.started", "item.completed"]);
});

test("the Claude seam resumes and captures the SDK session id", async () => {
  let receivedResume: string | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      receivedResume = input.options.resume;
      yield { type: "assistant", session_id: "claude-new-session", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { result } = run(driver, { providerSessionId: "claude-prior-session" });
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "claude-new-session" });
  expect(receivedResume).toBe("claude-prior-session");
});

test("partial text deltas stream against one item without duplicating the final envelope", async () => {
  let includePartialMessages = false;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      includePartialMessages = input.options.includePartialMessages;
      yield { type: "stream_event", session_id: "claude-stream", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "assistant", session_id: "claude-stream", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "claude-stream" });
  expect(includePartialMessages).toBeTrue();

  const deltas = sink.observations.filter((o) => o.kind === "content.delta");
  expect(deltas.map((o) => (o.kind === "content.delta" ? o.text : ""))).toEqual(["hel", "lo"]);
  // THE DOUBLE-COUNT GUARD. With partial messages on, the assistant envelope
  // REPEATS its text. Emitting it again would double both the transcript and
  // the final result — so exactly one text item exists, not two.
  expect(sink.observations.filter((o) => o.kind === "item.started")).toHaveLength(1);
});

test("a closed block carries its ACCUMULATED text, so a reloaded session is not empty", async () => {
  // THE BUG THIS PINS, found by running the thing rather than by a test:
  // `item.completed` was emitted with no detail, so the engine's projection
  // kept the empty text the block opened with. A LIVE client looked correct —
  // it folds `content.delta` itself — while a client opening the session
  // LATER got empty reasoning and empty assistant messages from the snapshot,
  // which is the exact path the projection exists to serve.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "thinking" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } } };
      yield { type: "stream_event", event: { type: "content_block_stop", index: 1 } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const closed = sink.observations.filter((o) => o.kind === "item.completed");
  expect(closed).toHaveLength(2);
  const [text, thinking] = closed;
  expect(text?.kind === "item.completed" && text.detail).toEqual({ type: "assistant_message", text: "hello" });
  expect(thinking?.kind === "item.completed" && thinking.detail).toEqual({ type: "reasoning", text: "hmm" });
});

test("a block the provider never closes still gets its accumulated text", async () => {
  // Same reason: the projection has no other source for it, and a stream that
  // ends mid-block is not rare — a stop lands there.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "unfinished" } } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.find((o) => o.kind === "item.completed");
  expect(closed?.kind === "item.completed" && closed.detail).toEqual({ type: "reasoning", text: "unfinished" });
});

test("thinking blocks are captured as reasoning, which v1 discarded entirely", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } };
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.find((o) => o.kind === "item.started");
  expect(started?.kind === "item.started" && started.item.detail.type).toBe("reasoning");
  const delta = sink.observations.find((o) => o.kind === "content.delta");
  expect(delta?.kind === "content.delta" && delta.stream).toBe("reasoning_text");
  // Reasoning must NOT contribute to the turn's final text.
  await expect(result).resolves.toMatchObject({ text: "" });
});

test("a tool call opens a row and its result closes the SAME row", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }] },
      };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }] },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const started = sink.observations.find((o) => o.kind === "item.started");
  const completed = sink.observations.find((o) => o.kind === "item.completed");
  expect(started?.kind === "item.started" && started.item.detail.type).toBe("command_execution");
  // Keyed off tool_use_id so a result arriving several messages later closes
  // the row its call opened, rather than opening a second one.
  expect(completed?.kind === "item.completed" && completed.itemId).toBe(
    started?.kind === "item.started" ? started.item.id : "",
  );
  expect(completed?.kind === "item.completed" && completed.status).toBe("completed");
  expect(completed?.kind === "item.completed" && completed.detail?.type === "command_execution" && completed.detail.command.outputPreview).toBe("a\nb");
});

test("a failed tool result marks its row failed rather than complete", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const completed = sink.observations.find((o) => o.kind === "item.completed");
  expect(completed?.kind === "item.completed" && completed.status).toBe("failed");
});

test("a tool whose result never arrives is closed as failed, not left spinning", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep" } }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const completed = sink.observations.filter((o) => o.kind === "item.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]?.kind === "item.completed" && completed[0].status).toBe("failed");
});

test("usage and cost are reported from the result message", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      };
    },
  }));
  const { sink, result } = run(driver);
  await expect(result).resolves.toMatchObject({
    usage: { tokens: { input: 100, output: 20, cacheRead: 5, cacheCreate: 2 }, costUsd: 0.0123 },
  });
  expect(sink.observations.some((o) => o.kind === "usage")).toBeTrue();
});

test("the Claude seam never turns an unsuccessful result into a completed turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "result", subtype: "error_during_execution" };
    },
  }));
  await expect(run(driver).result).rejects.toThrow("Claude did not complete successfully");
});

test("a missing local SDK is a typed provider-unavailable failure", async () => {
  const driver = createClaudeDriver(async () => Promise.reject(new Error("missing")));
  await expect(run(driver).result).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("tool mapping is by CAPABILITY, so a new provider tool is unstyled and never invisible", () => {
  expect(itemDetailForToolCall("Bash", { command: "ls" }).type).toBe("command_execution");
  expect(itemDetailForToolCall("Read", { file_path: "/a" }).type).toBe("file_read");
  expect(itemDetailForToolCall("Write", { file_path: "/a" }).type).toBe("file_change");
  expect(itemDetailForToolCall("Edit", { file_path: "/a" }).type).toBe("file_change");
  expect(itemDetailForToolCall("WebSearch", { query: "q" }).type).toBe("web_search");
  expect(itemDetailForToolCall("mcp__linear__search", {}).type).toBe("mcp_tool_call");
  // The load-bearing case: an unrecognised tool still produces a row.
  expect(itemDetailForToolCall("SomeFutureTool", { x: 1 }).type).toBe("dynamic_tool_call");
});

test("an mcp tool carries its server so a client can group by it", () => {
  const detail = itemDetailForToolCall("mcp__linear__search", { q: "x" });
  expect(detail.type === "mcp_tool_call" && detail.call.server).toBe("linear");
});

// ── the browser ──────────────────────────────────────────────────────────────

/** An SDK whose in-process MCP server is real enough to invoke a tool. */
function sdkWithBrowserTools(invoke: (handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>) => Promise<void>) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return async () => ({
    tool: (name: string, _description: string, _shape: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>) => {
      handlers.set(name, handler);
      return { name };
    },
    createSdkMcpServer: (input: unknown) => input,
    async *query() {
      await invoke(handlers);
      yield { type: "result", subtype: "success" };
    },
  });
}

test("a browser call that CHANGED the page journals what it is now looking at", async () => {
  const calls: string[] = [];
  const browser = {
    call: async (_scope: string, name: string) => {
      calls.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
    isReadOnly: (name: string) => name === "browser_snapshot",
    tools: [
      { name: "browser_navigate", description: "go", input: { shape: {} } },
      { name: "browser_snapshot", description: "look", input: { shape: {} } },
    ],
    state: async () => ({ provider: "headless" as const, tabs: [{ id: "0", url: "http://x", title: "X", active: true }] }),
  };
  const driver = createClaudeDriver(
    sdkWithBrowserTools(async (handlers) => {
      await handlers.get("browser_navigate")!({ url: "http://x" });
      // A READ must not trigger a state report: polling after every snapshot
      // puts a page listing behind each look at the DOM.
      await handlers.get("browser_snapshot")!({});
    }),
    { browser },
  );
  const { sink, result } = run(driver, { browserScopeKey: "session_one" });
  await result;

  const states = sink.observations.filter((o) => o.kind === "browser.state");
  expect(states).toHaveLength(1);
  expect(states[0]?.kind === "browser.state" && states[0].tabs[0]?.url).toBe("http://x");
  expect(calls).toEqual(["browser_navigate", "browser_snapshot"]);
});

test("a browser whose state cannot be read still lets the tool call succeed", async () => {
  // A browser panel that cannot be described must never fail the navigation
  // that moved it — the agent asked to browse, not to be observed.
  const browser = {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: () => false,
    tools: [{ name: "browser_navigate", description: "go", input: { shape: {} } }],
    state: async () => Promise.reject(new Error("the browser went away")),
  };
  let toolResult: unknown;
  const driver = createClaudeDriver(
    sdkWithBrowserTools(async (handlers) => {
      toolResult = await handlers.get("browser_navigate")!({ url: "http://x" });
    }),
    { browser },
  );
  const { sink, result } = run(driver, { browserScopeKey: "session_one" });
  await expect(result).resolves.toBeDefined();
  expect(toolResult).toMatchObject({ content: [{ type: "text", text: "ok" }] });
  expect(sink.observations.filter((o) => o.kind === "browser.state")).toHaveLength(0);
});

// ── sub-agents ───────────────────────────────────────────────────────────────

test("a Task call becomes a HANDLE row, not a generic tool row", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "Audit the parser", subagent_type: "Explore" } }],
        },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.find((o) => o.kind === "item.started");
  // items.ts: "the row is a handle; the detail is on the task events". The id
  // is derived from the tool_use id, which is what every message inside the
  // sub-agent will independently produce from its `parent_tool_use_id`.
  expect(started?.kind === "item.started" && started.item.detail).toEqual({ type: "task", taskId: "task_toolu_task" });
  expect(started?.kind === "item.started" && started.item.title).toBe("Audit the parser");
});

test("a sub-agent's work is FILED under its task and never becomes the turn's answer", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_task", description: "Audit the parser", subagent_type: "Explore" };
      // The child's own tool call and its own prose, both carrying the id of
      // the Task call that launched them.
      yield {
        type: "assistant",
        parent_tool_use_id: "toolu_task",
        message: { content: [{ type: "tool_use", id: "toolu_child", name: "Bash", input: { command: "rg parser" } }] },
      };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "child says" } } };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_stop", index: 0 } };
      // The main loop's own answer.
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parent says" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_task", status: "completed", summary: "found it", output_file: "/tmp/x" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);

  // THE HEADLINE ASSERTION. With `forwardSubagentText` on, a sub-agent's prose
  // arrives as an ordinary assistant message; appending it would make a
  // fan-out's turn summary the concatenation of every agent talking at once.
  await expect(result).resolves.toMatchObject({ text: "parent says" });

  const started = sink.observations.filter((o) => o.kind === "item.started");
  const child = started.find((o) => o.kind === "item.started" && o.item.id === "item_toolu_child");
  expect(child?.kind === "item.started" && child.item.taskId).toBe("task_toolu_task");
  // Both agents opened content block index 0. Keyed by index alone they would
  // be one row, and the parent's deltas would land on the child's item.
  const textRows = started.filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
  expect(textRows).toHaveLength(2);
  expect(new Set(textRows.map((o) => (o.kind === "item.started" ? o.item.taskId : undefined)))).toEqual(
    new Set(["task_toolu_task", undefined]),
  );
});

test("task lifecycle rides the stream, and a partial patch does not erase the title", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_task", description: "Audit the parser", subagent_type: "Explore", task_type: "subagent" };
      // Observed against the real SDK: progress repeats the description with a
      // "Running " prefix. Taking it as the title makes a roster row read as
      // status prose and churn while the agent works.
      yield { type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "toolu_task", description: "Running Audit the parser", usage: { total_tokens: 40, tool_uses: 2, duration_ms: 9 } };
      // `task_updated` carries a PATCH naming only what changed — no title, no
      // kind. A straight replace would blank both.
      yield { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed" } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const tasks = sink.observations.filter((o) => o.kind.startsWith("task."));
  expect(tasks.map((o) => o.kind)).toEqual(["task.started", "task.progress", "task.completed"]);
  const [opened, progressed, closed] = tasks;
  expect(progressed?.kind === "task.progress" && progressed.task.title).toBe("Audit the parser");
  expect(progressed?.kind === "task.progress" && progressed.task.usage?.tokens.output).toBe(40);
  expect(opened?.kind === "task.started" && opened.task).toMatchObject({
    id: "task_toolu_task",
    kind: "agent",
    state: "running",
    title: "Audit the parser",
    role: "Explore",
    providerTaskId: "t1",
  });
  // Folded onto what was already known, and joined back to the same contract id
  // even though this message carried no tool_use_id at all.
  expect(closed?.kind === "task.completed" && closed.task).toMatchObject({
    id: "task_toolu_task",
    state: "completed",
    title: "Audit the parser",
    role: "Explore",
  });
});

test("an agent still running when the turn ends is failed, so the session stops claiming it is busy", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "never reports back" };
      yield { type: "system", subtype: "task_started", task_id: "t2", tool_use_id: "toolu_b", description: "a log tail", task_type: "background_shell" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  // The agent is closed; the BACKGROUND task is not — outliving its turn is
  // the definition of background, and `livenessOf` reports it as monitoring.
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task.id).toBe("task_toolu_a");
  expect(closed[0]?.kind === "task.completed" && closed[0].task.state).toBe("failed");
});

test("task classification is a DENYLIST, so a renamed agent type is unstyled and never invisible", () => {
  expect(taskKindForType("background_shell")).toBe("background");
  expect(taskKindForType("subagent")).toBe("agent");
  // The load-bearing case: an SDK that invents a new agent flavour tomorrow.
  expect(taskKindForType("local_workflow")).toBe("agent");
  expect(taskKindForType(undefined)).toBe("agent");
  expect(taskStateForStatus("killed")).toBe("stopped");
  expect(taskStateForStatus("paused")).toBe("waiting");
  expect(taskStateForStatus(undefined)).toBe("running");
});

test("collapsed labels are derived once, by the engine", () => {
  expect(titleForToolCall("Bash", itemDetailForToolCall("Bash", { command: "  ls   -la  " }))).toBe("ls -la");
  expect(titleForToolCall("Read", itemDetailForToolCall("Read", { file_path: "src/a.ts" }))).toBe("src/a.ts");
  expect(titleForToolCall("Odd", itemDetailForToolCall("Odd", {}))).toBe("Odd");
});
