import { expect, test } from "bun:test";
import type { TurnObservation } from "@telar/engine-client";
import { createClaudeDriver, itemDetailForToolCall, ProviderUnavailableError, titleForToolCall } from "../src/driver";

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

test("collapsed labels are derived once, by the engine", () => {
  expect(titleForToolCall("Bash", itemDetailForToolCall("Bash", { command: "  ls   -la  " }))).toBe("ls -la");
  expect(titleForToolCall("Read", itemDetailForToolCall("Read", { file_path: "src/a.ts" }))).toBe("src/a.ts");
  expect(titleForToolCall("Odd", itemDetailForToolCall("Odd", {}))).toBe("Odd");
});
