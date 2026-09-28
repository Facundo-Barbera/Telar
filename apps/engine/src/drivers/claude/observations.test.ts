import { expect, test } from "bun:test";
import { unifiedDiff } from "../../domains/git/diff";
import { until } from "../../../test/wait";
import { createClaudeDriver, run } from "../../../test/claude-harness";

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

  // Two chunks of one block, coalesced into the one row a reader would have
  // folded them into anyway — see `flushSoon`.
  const deltas = sink.observations.filter((o) => o.kind === "content.delta");
  expect(deltas.map((o) => (o.kind === "content.delta" ? o.text : ""))).toEqual(["hello"]);
  // THE DOUBLE-COUNT GUARD. With partial messages on, the assistant envelope
  // REPEATS its text. Emitting it again would double both the transcript and
  // the final result — so exactly one text item exists, not two.
  expect(sink.observations.filter((o) => o.kind === "item.started")).toHaveLength(1);
});

test("streamed deltas are coalesced per block, and a second block never joins the first", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      for (const chunk of ["a", "b", "c", "d"]) {
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } };
      }
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      // A SECOND BLOCK, so the merge is proved to stop at the row boundary
      // rather than at "is the last one also a delta".
      yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "thinking" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hm" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "mm" } } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const deltas = sink.observations.filter((o) => o.kind === "content.delta");
  expect(deltas.map((o) => (o.kind === "content.delta" ? [o.stream, o.text] : []))).toEqual([
    ["assistant_text", "abcd"],
    ["reasoning_text", "hmmm"],
  ]);
  // The text still reaches the projection whole, which is what a client
  // opening the session later reads.
  const closed = sink.observations.filter((o) => o.kind === "item.completed");
  expect(closed.map((o) => (o.kind === "item.completed" ? o.detail : undefined))).toEqual([
    { type: "assistant_message", text: "abcd" },
    { type: "reasoning", text: "hmmm" },
  ]);
  // …and six chunks cost the engine far fewer commands than six. The bound
  // counts each block's opening as its own command: a block start is flushed
  // at once, so a thought with no text deltas is still visible while it runs.
  expect(sink.batches.length).toBeLessThanOrEqual(5);
  const deltaBatches = sink.batches.filter((batch) => batch.some((o) => o.kind === "content.delta"));
  expect(deltaBatches.length).toBeLessThanOrEqual(2);
});

test("a closed block carries its ACCUMULATED text, so a reloaded session is not empty", async () => {
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

test("a thought with its text withheld still reaches the engine while it runs, with its size", async () => {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "message_start", message: {} } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 900 } } };
      yield { type: "system", subtype: "thinking_tokens", estimated_tokens: 1200, estimated_tokens_delta: 300 };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } };
      await parked;
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  const tokensReported = () =>
    sink.observations.flatMap((o) => (o.kind === "item.updated" && o.item.detail.type === "reasoning" ? [o.item.detail.estimatedTokens] : []));
  await until("the running estimate reached the sink", () => tokensReported().includes(1200));
  const started = sink.observations.find((o) => o.kind === "item.started");
  expect(started?.kind === "item.started" && started.item.detail.type).toBe("reasoning");
  // One report per 500-token step crossed, not one per frame.
  expect(tokensReported()).toEqual([900, 1200]);
  expect(sink.observations.some((o) => o.kind === "item.completed")).toBeFalse();

  release();
  await result;
  const closed = sink.observations.find((o) => o.kind === "item.completed");
  // The final count rides the close, which is what a later reader sees.
  expect(closed?.kind === "item.completed" && closed.detail).toEqual({ type: "reasoning", text: "", estimatedTokens: 1200 });
});

test("a tool row opens as the model starts writing the call, and the envelope updates it", async () => {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => (release = resolve));
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "message_start", message: {} } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } } };
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a.ts","content":"xx' } } };
      await parked;
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/tmp/a.ts", content: "xx" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  const startedFor = () => sink.observations.filter((o) => o.kind === "item.started" && o.item.id === "item_toolu_1");
  await until("the tool row reached the sink", () => startedFor().length > 0);
  const early = startedFor()[0];
  expect(early?.kind === "item.started" && early.item).toMatchObject({ title: "Write", providerRefs: { itemId: "toolu_1" } });

  release();
  await result;
  // Still ONE row: the envelope updates it rather than opening another.
  expect(startedFor()).toHaveLength(1);
  const updated = sink.observations.find((o) => o.kind === "item.updated" && o.item.id === "item_toolu_1");
  expect(updated?.kind === "item.updated" && updated.item).toMatchObject({
    title: "/tmp/a.ts",
    detail: { type: "file_change", change: { path: "/tmp/a.ts", kind: "create" } },
  });
  const closed = sink.observations.find((o) => o.kind === "item.completed" && o.itemId === "item_toolu_1");
  expect(closed?.kind === "item.completed" && closed.status).toBe("completed");
});

test("a streamed edit names its file as soon as the path arrives, never a made-up one", async () => {
  let releaseHead!: () => void;
  let releaseTail!: () => void;
  const head = new Promise<void>((resolve) => (releaseHead = resolve));
  const tail = new Promise<void>((resolve) => (releaseTail = resolve));
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "stream_event", event: { type: "message_start", message: {} } };
      yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_e", name: "Edit", input: {} } } };
      // The path split across fragments: nothing is claimed until its closing quote.
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/sr' } } };
      await head;
      yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'c/a.ts","old_string":"x' } } };
      await tail;
      yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_e", name: "Edit", input: { file_path: "/tmp/src/a.ts", old_string: "x", new_string: "y" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "ok" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  const forRow = () => sink.observations.filter((o) => (o.kind === "item.started" || o.kind === "item.updated") && o.item.id === "item_toolu_e");
  await until("the edit row opened", () => forRow().length > 0);
  const started = forRow()[0];
  expect(started?.kind === "item.started" && started.item.title).toBe("Edit");
  expect(JSON.stringify(started)).not.toContain("/tmp/sr");

  releaseHead();
  await until("the path reached the row", () => forRow().length > 1);
  const named = forRow()[1];
  expect(named?.kind === "item.updated" && named.item).toMatchObject({
    title: "/tmp/src/a.ts",
    detail: { type: "file_change", change: { path: "/tmp/src/a.ts", kind: "edit" } },
  });

  releaseTail();
  await result;
  expect(forRow().filter((o) => o.kind === "item.started")).toHaveLength(1);
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

test("a tool output past the preview cap is truncated, and the remainder is journalled nowhere", async () => {
  const kept = "a".repeat(4_000);
  const cut = `TAIL${"b".repeat(997)}`;
  const output = kept + cut;
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_big", name: "Bash", input: { command: "bun test" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_big", content: output }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const completed = sink.observations.find((o) => o.kind === "item.completed");
  const preview = completed?.kind === "item.completed" && completed.detail?.type === "command_execution"
    ? completed.detail.command.outputPreview
    : undefined;
  expect(preview).toBe(`${kept}…`);
  expect(preview).toHaveLength(4_001);
  expect(output).toHaveLength(5_001);

  // AND NOTHING ELSE CARRIES THE OTHER 1,001. Asserted over the emitted values,
  // not over the source: a check that read driver.ts would pass just as happily
  // if a driver started streaming through a variable instead of a literal.
  expect(JSON.stringify(sink.observations)).not.toContain(cut);
  expect(sink.observations.filter((o) => o.kind === "content.delta")).toHaveLength(0);
  // One row holds the output at all, and it holds 4,000 of its 5,001 characters.
  expect(sink.observations.filter((o) => JSON.stringify(o).includes(kept.slice(0, 64)))).toHaveLength(1);
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
    ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " keep", "-gone", "+added", "+also added"].join("\n"),
  );
  // An ABSOLUTE path drops the git `a/`/`b/` prefixes — with them the header
  // reads `--- a//tmp/x.ts`, which is neither absolute nor repo-relative.
  // Observed on a real turn.
  expect(unifiedDiff("/tmp/x.ts", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }]).diff).toStartWith("--- /tmp/x.ts\n+++ /tmp/x.ts");
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
    ["diff --git a/src/new.ts b/src/new.ts", "--- a/src/new.ts", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+export const a = 1;", "+export const b = 2;"].join("\n"),
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
