import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifyTelarTool, requiresHuman, type TurnObservation } from "@telar/engine-client";
import { unifiedDiff } from "../src/diff";
import {
  createClaudeDriver as createRealClaudeDriver,
  itemDetailForToolCall,
  planDetailForTodos,
  ProviderUnavailableError,
  requestKindForTool,
  taskKindForType,
  taskStateForStatus,
  titleForToolCall,
} from "../src/driver";

/**
 * EVERY TEST BELOW RUNS AGAINST A FAKE SDK, so none of them should care whether
 * this machine has Claude Code installed.
 *
 * The default resolver does care, deliberately — it refuses the turn when there
 * is no install (`cli-resolution.ts`). Left to it, this whole suite would pass
 * on a laptop with Claude Code and fail in CI, where there is none, on thirty
 * tests that are not about resolution at all. So the fake SDK gets a fake path,
 * and the real resolver is exercised by the two tests that are about it.
 */
const createClaudeDriver: typeof createRealClaudeDriver = (loadSdk, options = {}) =>
  createRealClaudeDriver(loadSdk, { resolveExecutable: () => "/fake/bin/claude", ...options });

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

test("the session's model and effort reach the SDK, and an unknown effort is dropped rather than forwarded", async () => {
  // The composer's reasoning pill is only worth having if the level survives
  // the whole way down. `effort` is an OPEN string in the contract because
  // provider vocabularies differ, so a word this SDK does not know has to be
  // dropped — forwarding it would fail the turn over a display-level choice.
  const seen: { model?: string; effort?: string }[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push({ model: input.options.model, effort: input.options.effort });
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { model: "claude-opus-5", effort: "xhigh" }).result;
  await run(driver, { model: "claude-opus-5", effort: "deliberate" }).result;
  await run(driver, {}).result;
  expect(seen).toEqual([
    { model: "claude-opus-5", effort: "xhigh" },
    { model: "claude-opus-5", effort: undefined },
    { model: undefined, effort: undefined },
  ]);
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

// ── reviewing the work ───────────────────────────────────────────────────────

test("a file edit carries a real diff, which nothing produced before", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } }] },
      };
      yield {
        type: "user",
        // The string content is what went to the MODEL — a confirmation
        // sentence. The reviewable half is on `tool_use_result`.
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "The file has been updated." }] },
        tool_use_result: {
          filePath: "src/a.ts",
          structuredPatch: [
            { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" keep", "-gone", "+added", "+also added"] },
          ],
        },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const closed = sink.observations.find((o) => o.kind === "item.completed");
  const detail = closed?.kind === "item.completed" ? closed.detail : undefined;
  expect(detail?.type).toBe("file_change");
  expect(detail?.type === "file_change" && detail.change.unifiedDiff).toBe(
    ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " keep", "-gone", "+added", "+also added"].join("\n"),
  );
  // An ABSOLUTE path drops the git `a/`/`b/` prefixes — with them the header
  // reads `--- a//tmp/x.ts`, which is neither absolute nor repo-relative.
  // Observed on a real turn.
  expect(unifiedDiff("/tmp/x.ts", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }])).toStartWith("--- /tmp/x.ts\n+++ /tmp/x.ts");
  expect(detail?.type === "file_change" && detail.change.linesAdded).toBe(2);
  expect(detail?.type === "file_change" && detail.change.linesRemoved).toBe(1);
});

test("a CREATED file shows its whole content as a diff, since the SDK sends no patch for one", async () => {
  // Measured against a real turn: a Write of a new file came back with an empty
  // `structuredPatch`, so the most legible change of all — "here is a whole new
  // file" — was the one the transcript could not show.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/new.ts" } }] } };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "created" }] },
        tool_use_result: { structuredPatch: [], originalFile: null, content: "export const a = 1;\nexport const b = 2;\n" },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.find((o) => o.kind === "item.completed");
  const detail = closed?.kind === "item.completed" ? closed.detail : undefined;
  expect(detail?.type === "file_change" && detail.change.unifiedDiff).toBe(
    ["--- a/src/new.ts", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+export const a = 1;", "+export const b = 2;"].join("\n"),
  );
  expect(detail?.type === "file_change" && detail.change.linesAdded).toBe(2);
  expect(detail?.type === "file_change" && detail.change.linesRemoved).toBe(0);
});

test("an edit that changed nothing does NOT get an invented all-additions diff", async () => {
  // Anti-vacuity for the arm above. It is guarded on `originalFile === null`
  // precisely so a no-op edit is not reported as a full rewrite.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } }] } };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "no change" }] },
        tool_use_result: { structuredPatch: [], originalFile: "export const a = 1;\n", content: "export const a = 1;\n" },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.find((o) => o.kind === "item.completed");
  expect(closed?.kind === "item.completed" && closed.detail?.type === "file_change" && closed.detail.change.unifiedDiff).toBeUndefined();
});

test("two edits in one message get NO diff rather than each other's", async () => {
  // `tool_use_result` hangs off the MESSAGE, not the block, so with two results
  // there is no way to know which it describes. One file's diff on another
  // file's row is worse than no diff.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/b.ts" } },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
        tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }] },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "item.completed");
  expect(closed).toHaveLength(2);
  for (const row of closed) {
    expect(row.kind === "item.completed" && row.detail?.type === "file_change" && row.detail.change.unifiedDiff).toBeUndefined();
  }
});

test("TodoWrite is ONE plan row updated in place, not a checklist per call", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "Read the code", status: "in_progress" }] } }],
        },
      };
      // Its result must close nothing — the plan is turn-scoped.
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "TodoWrite",
              input: { todos: [{ content: "Read the code", status: "completed" }, { content: "Write the fix", status: "in_progress" }] },
            },
          ],
        },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const started = sink.observations.filter((o) => o.kind === "item.started");
  const updated = sink.observations.filter((o) => o.kind === "item.updated");
  // ONE row. A row per call leaves the transcript full of near-identical
  // checklists — the failure the Codex seam already avoids.
  expect(started).toHaveLength(1);
  expect(started[0]?.kind === "item.started" && started[0].item.detail.type).toBe("plan");
  expect(updated).toHaveLength(1);
  const plan = updated[0]?.kind === "item.updated" ? updated[0].item.detail : undefined;
  expect(plan?.type === "plan" && plan.plan.steps).toEqual([
    { step: "Read the code", status: "completed" },
    { step: "Write the fix", status: "inProgress" },
  ]);
  // Closed with the turn, since no tool_result closes it.
  const closed = sink.observations.filter((o) => o.kind === "item.completed");
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "item.completed" && closed[0].status).toBe("completed");
});

test("a TodoWrite whose payload is not a todo list stays an ordinary tool row", () => {
  // Anti-vacuity: an unrecognised shape must not become an empty plan claiming
  // the agent has no steps.
  expect(planDetailForTodos({ todos: [] })).toBeUndefined();
  expect(planDetailForTodos({ nope: 1 })).toBeUndefined();
  expect(planDetailForTodos({ todos: [{ activeForm: "Reading" }] })?.steps).toEqual([{ step: "Reading", status: "pending" }]);
});

// ── the browser ──────────────────────────────────────────────────────────────
//
// The browser's TOOLS moved to the worker-hosted `BrowserToolSocket`
// (`browser-socket.test.ts` owns gating, state reporting and auth). What this
// driver still owns is REGISTRATION: pointing the SDK at the socket, and waving
// the socket's own tools past `canUseTool` so one click yields one card.

test("the browser socket registers as its own http server, ALONGSIDE the in-process telar server", async () => {
  // THE KEY IS WHAT NAMES THE SERVER — `mcp__telar-browser__…` is the prefix
  // the model sees and every client parses, so the key must be the contract's
  // `TELAR_BROWSER_MCP_SERVER`, on both providers.
  let servers: Record<string, unknown> | undefined;
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  });
  await run(createClaudeDriver(sdk), {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
  }).result;
  // Both Telar registrations present; the http entry carries the lease.
  expect(Object.keys(servers ?? {})).toEqual(["telar-browser", "telar"]);
  expect(servers?.["telar-browser"]).toEqual({
    type: "http",
    url: "http://127.0.0.1:1234/v2/browser/mcp",
    headers: { Authorization: "Bearer tok_abc" },
  });
  // …and the in-process server holds NO browser tools any more: `warp` only,
  // on a turn with no spool. One tool surface per capability, not two.
  const telar = servers?.telar as { tools?: { name?: string }[] } | undefined;
  expect((telar?.tools ?? []).map((tool) => tool.name)).toEqual(["warp"]);
});

test("a turn with no browser socket registers no telar-browser server", async () => {
  // Anti-vacuity for the spread above: absence means ABSENT, not an entry with
  // an undefined url the provider would then try to reach.
  let servers: Record<string, unknown> | undefined;
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  });
  await run(createClaudeDriver(sdk)).result;
  expect(Object.keys(servers ?? {})).toEqual(["telar"]);
});

test("canUseTool waves the browser socket's tools through, and ONLY those", async () => {
  // THE SOCKET IS THE DECIDER for its own tools — its per-lease gate already
  // asked the engine. Answering again in `canUseTool` would put two cards in
  // front of one click. The spool tool alongside it is the anti-vacuity: the
  // skip is per-server, never a blanket allow.
  const asked: string[] = [];
  const answers: unknown[] = [];
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: {
      options: {
        canUseTool?: (name: string, args: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>;
      };
    }) {
      const opts = { signal: new AbortController().signal, toolUseID: "toolu_1" };
      answers.push(await input.options.canUseTool!("mcp__telar-browser__browser_click", {}, opts));
      answers.push(await input.options.canUseTool!("mcp__telar__spool_create_item", {}, opts));
      yield { type: "result", subtype: "success" };
    },
  });
  await run(createClaudeDriver(sdk), {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
    onRequest: async (request: { detail: { kind: string; call?: { name: string } } }) => {
      asked.push(request.detail.kind === "tool_call" ? (request.detail.call?.name ?? "?") : request.detail.kind);
      return "accept";
    },
  }).result;
  expect(answers).toEqual([{ behavior: "allow" }, { behavior: "allow" }]);
  // The engine heard about the spool call and ONLY the spool call.
  expect(asked).toEqual(["mcp__telar__spool_create_item"]);
});

test("the spool registers under the SAME one server, and only when the turn carries one", async () => {
  // THE SEAM, not the toolkit — `spool-tools.test.ts` owns what the four tools
  // do. What this pins is that they reach the model at all, under `telar` like
  // every other Telar capability, and that a turn without a spool gets no spool
  // tools rather than empty ones. A model handed a tool that answers "no items"
  // for a store it cannot see would report that as the truth.
  const seen: { serverKeys?: string[] } = {};
  const names: string[] = [];
  const sdk = async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: unknown[] }>) => {
      names.push(name);
      return { name, handler };
    },
    createSdkMcpServer: (input: { tools: { name: string }[] }) => input,
    async *query(input: { options: { mcpServers?: Record<string, { tools: { name: string }[] }> } }) {
      seen.serverKeys = Object.keys(input.options.mcpServers ?? {});
      yield { type: "result", subtype: "success" };
    },
  });

  const spool = {
    project: "aurora",
    snapshot: async () => ({ lanes: [], rows: [], desk: [], unreadable: [], totalItems: 0, agentsAdded: 0 }),
    item: async () => null,
    create: async () => ({ id: "i-1", title: "x", provenance: "session", captured: "Tue 16:42", schemaVersion: 1 }),
    update: async () => ({ id: "i-1", title: "x", provenance: "session", captured: "Tue 16:42", schemaVersion: 1 }),
    consult: async () => ({ ok: false as const, reason: "not in this test" }),
  };
  await run(createClaudeDriver(sdk), { spool }).result;
  expect(seen.serverKeys).toEqual(["telar"]);
  expect(names).toEqual([
    "spool_list_items",
    "spool_list_lanes",
    "spool_create_item",
    "spool_update_item",
    "spool_consult_expert",
    "spool_list_threads",
    "spool_open_question",
    "spool_mark_waiting",
    "spool_answer_question",
    "spool_settle_thread",
    "spool_set_focus",
    "spool_end_focus",
    "spool_look",
    "spool_pin",
    "spool_set_area_permits",
    "spool_set_terrain",
    "spool_set_subject_identity",
    "spool_shelf",
    "spool_write_note",
    "spool_search",
    "warp",
  ]);

  // …and without one, the spool tools are GONE while `warp` stays — it is
  // unconditional by design, which is also what keeps this from passing for the
  // trivial reason that nothing registers at all.
  names.length = 0;
  await run(createClaudeDriver(sdk)).result;
  expect(names).toEqual(["warp"]);
  expect(seen.serverKeys).toEqual(["telar"]);
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

test("a finished task is not resurrected by the SDK still talking about it", async () => {
  /**
   * THE REAL SEQUENCE, off a measured turn: a backgrounded `sleep 90` reported
   * `task_updated{status: killed}` when the turn wound down, and then a
   * `task_notification` carrying a summary and NO STATUS. Read as `running`,
   * that notification put a finished task back to working — where nothing was
   * ever going to correct it, because the stream had ended. The session then
   * claimed to be busy, and the turn-end sweep marked it FAILED.
   */
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "Sleep for 90 seconds in background" };
      yield { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "killed" } };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_a", summary: "Sleep for 90 seconds in background" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const reports = sink.observations.filter((o) => o.kind === "task.started" || o.kind === "task.progress" || o.kind === "task.completed");
  const states = reports.map((o) => ("task" in o ? o.task.state : undefined));
  // Never back to running, and never swept into a failure it did not have.
  expect(states).toEqual(["running", "stopped", "stopped"]);
  expect(states).not.toContain("failed");
  // The last word is still a completion event, so a client folding these ends
  // up with a settled task rather than one that reads as in flight.
  expect(reports.at(-1)?.kind).toBe("task.completed");
});

test("a notification with no status is an ENDING, because that is the only thing it can mean", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "Audit the parser" };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_a", summary: "found three" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task).toMatchObject({ state: "completed", resultText: "found three" });
});

test("task classification is a DENYLIST, so a renamed agent type is unstyled and never invisible", () => {
  expect(taskKindForType("background_shell")).toBe("background");
  /**
   * MEASURED against the installed SDK (0.3.224), twice, because the name does
   * not say it: a Bash call with `run_in_background` announces `task_started`
   * with `task_type: "local_bash"`, and the same call in the FOREGROUND
   * announces no task at all. Read as an agent, a backgrounded shell was swept
   * to "failed" at the end of the turn it was meant to outlive.
   */
  expect(taskKindForType("local_bash")).toBe("background");
  expect(taskKindForType("subagent")).toBe("agent");
  // The load-bearing case: an SDK that invents a new agent flavour tomorrow.
  expect(taskKindForType("local_workflow")).toBe("agent");
  expect(taskKindForType(undefined)).toBe("agent");
  expect(taskStateForStatus("killed")).toBe("stopped");
  expect(taskStateForStatus("paused")).toBe("waiting");
  // The fallback belongs to the CALLER: a start or a progress line with no
  // status is running, and a notification with no status is over.
  expect(taskStateForStatus(undefined)).toBe("running");
  expect(taskStateForStatus(undefined, "completed")).toBe("completed");
  expect(taskStateForStatus("running", "completed")).toBe("running");
});

test("collapsed labels are derived once, by the engine", () => {
  expect(titleForToolCall("Bash", itemDetailForToolCall("Bash", { command: "  ls   -la  " }))).toBe("ls -la");
  expect(titleForToolCall("Read", itemDetailForToolCall("Read", { file_path: "src/a.ts" }))).toBe("src/a.ts");
  expect(titleForToolCall("Odd", itemDetailForToolCall("Odd", {}))).toBe("Odd");
});

test("an image attachment reaches Claude as pixels; anything else reaches it as a path", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-attach-")), "shot.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  let prompt: unknown;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      prompt = input.prompt;
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, {
    attachments: [
      { id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: file },
      { id: "att_2", name: "notes.md", mediaType: "text/markdown", bytes: 9, path: "/tmp/notes.md" },
    ],
  }).result;

  // The async-iterable form is what carries content blocks; a turn with no
  // attachment must stay a plain string, which the tests above already assert
  // by passing one through untouched.
  expect(typeof prompt).toBe("object");
  const messages: unknown[] = [];
  for await (const message of prompt as AsyncIterable<unknown>) messages.push(message);
  expect(messages).toHaveLength(1);
  const content = (messages[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
  expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
  // The non-image is NAMED WITH ITS PATH rather than inlined: the agent has a
  // Read tool and a file it can reopen beats a copy it cannot.
  expect(content[1]).toMatchObject({ type: "text" });
  expect(String((content[1] as { text: string }).text)).toContain("notes.md (text/markdown) at /tmp/notes.md");
});

test("the user's MCP servers reach the SDK, and Telar's own key wins a collision", async () => {
  let servers: Record<string, unknown> | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, {
    mcpServers: [
      { id: "linear", label: "Linear", enabled: true, createdAt: 1, updatedAt: 1, spec: { transport: "http", url: "https://mcp.linear.app" } },
      { id: "tools", label: "Tools", enabled: true, createdAt: 1, updatedAt: 1, spec: { transport: "stdio", command: "node", args: ["s.js"] } },
    ],
  }).result;
  expect(servers?.linear).toEqual({ type: "http", url: "https://mcp.linear.app" });
  expect(servers?.tools).toEqual({ type: "stdio", command: "node", args: ["s.js"] });
});

test("fast mode reaches the SDK only when a session asked for it, and no beta ever does", async () => {
  // A settings override is a request for non-default behaviour, so absence has
  // to stay absence. And NO `betas` is sent at all any more: the long-context
  // flag this driver used to translate is not a flag — Claude Code offers the
  // long window as a model (`claude-opus-5[1m]`), so there is nothing to opt
  // into and a stale dated beta would be the only thing left to send.
  const seen: { betas?: unknown; settings?: { fastMode?: boolean } }[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push({ betas: (input.options as { betas?: unknown }).betas, settings: input.options.settings });
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { fastMode: true }).result;
  await run(driver, {}).result;
  expect(seen).toEqual([
    { betas: undefined, settings: { fastMode: true } },
    { betas: undefined, settings: undefined },
  ]);
});

/**
 * WHICH BINARY ANSWERS THE TURN — the option that makes a packaged app work.
 *
 * Without `pathToClaudeCodeExecutable` the Agent SDK resolves an optional
 * ~272MB platform package it ships for itself. Telar does not bundle that (nor
 * does T3 Code), so in an installed app its absence is the difference between a
 * turn running and "native CLI binary not found" — and in a dev checkout, where
 * the package IS present, its absence means the Providers pane reports a version
 * from PATH while a completely different binary does the work.
 */
test("the Claude seam tells the SDK which executable to spawn", async () => {
  let received: string | undefined;
  const driver = createRealClaudeDriver(
    async () => ({
      async *query(input) {
        received = input.options.pathToClaudeCodeExecutable;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/opt/homebrew/bin/claude" },
  );
  await run(driver).result;
  expect(received).toBe("/opt/homebrew/bin/claude");
});

test("a resolver with nothing to offer leaves the SDK's own lookup alone", async () => {
  // Not the same as pointing it at a path that does not exist: an absent option
  // is the SDK's documented default, and inventing a path would turn "we could
  // not find one" into a spawn failure naming a file nobody chose.
  let seen = false;
  let received: string | undefined = "untouched";
  const driver = createRealClaudeDriver(
    async () => ({
      async *query(input) {
        seen = true;
        received = input.options.pathToClaudeCodeExecutable;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => undefined },
  );
  await run(driver).result;
  expect(seen).toBe(true);
  expect(received).toBeUndefined();
});

test("no Claude Code on this machine fails the turn with what to install", async () => {
  // AD-11: a harness Telar cannot honour fails the turn rather than degrading.
  // The message is the resolver's own, so the reader learns what to install
  // instead of reading an errno from a spawn three layers down.
  const driver = createRealClaudeDriver(
    async () => ({
      async *query() {
        throw new Error("the SDK must never be reached when there is no binary to run");
      },
    }),
    {
      resolveExecutable: () => {
        throw new ProviderUnavailableError("No Claude Code installation found. Telar does not bundle one.");
      },
    },
  );
  await expect(run(driver).result).rejects.toThrow(ProviderUnavailableError);
});

describe("the Spool's reads are reads", () => {
  test("listing your own spool is a file_read, so the front door does not park on it", () => {
    /**
     * FOUND BY DRIVING THE MASTER CHAT. The front door opened, the assistant
     * reached for `spool_list_items` to answer "where did I stop?", and the turn
     * parked asking the user to approve reading their own task list.
     *
     * `approval-required` auto-accepts `file_read` and parks everything else, so
     * classifying these correctly is what lets the existing ladder work. This is
     * not a bypass: no mode's decision is skipped, a read simply stops being
     * declared an action.
     */
    expect(requestKindForTool(qualifyTelarTool("spool_list_items"))).toBe("file_read");
    expect(requestKindForTool(qualifyTelarTool("spool_list_lanes"))).toBe("file_read");
    expect(requiresHuman("approval-required", requestKindForTool(qualifyTelarTool("spool_list_items")))).toBe(false);
  });

  test("everything that writes or spends still parks, in every attended mode", () => {
    // The half that makes the classification defensible. Two of these write to
    // the user's store and the third spends money on a model turn.
    for (const tool of ["spool_create_item", "spool_update_item", "spool_consult_expert"]) {
      expect(requestKindForTool(qualifyTelarTool(tool))).toBe("tool_call");
      expect(requiresHuman("approval-required", requestKindForTool(qualifyTelarTool(tool)))).toBe(true);
      expect(requiresHuman("auto-accept-edits", requestKindForTool(qualifyTelarTool(tool)))).toBe(true);
    }
  });

  test("a stranger's server cannot inherit the engine's posture by naming a tool the same", () => {
    // The reason the check is on (server, tool) and not on the bare name: a
    // user-configured MCP server called anything else must not get a free read.
    expect(requestKindForTool("mcp__notmine__spool_list_items")).toBe("tool_call");
    expect(requestKindForTool("spool_list_items")).toBe("tool_call");
  });
});
