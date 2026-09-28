import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "../contract";
import { createClaudeDriver, run } from "../../../test/claude-harness";

test("a result while tool calls still run does NOT end the turn; the turn ends at the FINAL result", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Working on it." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 20 && echo late" } },
          ],
          stop_reason: "tool_use",
        },
      };
      yield { type: "result", subtype: "success", stop_reason: "tool_use" };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "late" }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: " done" }], stop_reason: "end_turn" } };
      yield { type: "result", subtype: "success", stop_reason: "end_turn" };
    },
  }));
  const { sink, result } = run(driver);
  const resolved = await result;
  // The run settles ONCE, after the second result: the final text carries the
  // continuation the first result would have cut off.
  expect(resolved.text).toBe("Working on it. done");
  // The tool row closed from its real tool_result — under the old behaviour
  // the pump had already stopped, and the end-of-turn sweep closed it FAILED.
  const toolClose = sink.observations.find((o) => o.kind === "item.completed" && o.itemId === "item_t1");
  expect(toolClose?.kind === "item.completed" && toolClose.status).toBe("completed");
});

test("a result with NO stop reason stated but main-loop tools unresolved also holds the turn open", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 40" } }] } };
      yield { type: "result", subtype: "success", stop_reason: null };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "after the sleep" }], stop_reason: "end_turn" } };
      yield { type: "result", subtype: "success", stop_reason: "end_turn" };
    },
  }));
  const { sink, result } = run(driver);
  const resolved = await result;
  expect(resolved.text).toBe("after the sleep");
  const toolClose = sink.observations.find((o) => o.kind === "item.completed" && o.itemId === "item_t1");
  expect(toolClose?.kind === "item.completed" && toolClose.status).toBe("completed");
});

test("a tool-use result with no unresolved top-level tools ends the turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "not blocking on the background work" }], stop_reason: "end_turn" },
      };
      yield { type: "result", subtype: "success", stop_reason: "tool_use" };
      await new Promise(() => undefined);
    },
  }));
  const { result } = run(driver);
  const raced = await Promise.race([
    result.then((value) => ({ kind: "resolved" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 250)),
  ]);
  expect(raced.kind).toBe("resolved");
  expect(raced.kind === "resolved" && raced.value.text).toBe("not blocking on the background work");
});

describe("the end-turn grace (#465)", () => {
  test("an end_turn with no result following settles the turn after the grace, with a row saying why", async () => {
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          yield { type: "stream_event", event: { type: "message_start" } };
          // EXACTLY AS THE SDK STREAMS IT (probed on 2.1.270): the envelope has
          // NO stop_reason; `end_turn` rides the closing message_delta only.
          yield { type: "assistant", message: { content: [{ type: "text", text: "the answer" }] } };
          yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } };
          yield { type: "stream_event", event: { type: "message_stop" } };
          await new Promise(() => undefined);
        },
      }),
      { endTurnGraceMs: 30 },
    );
    const { sink, result } = run(driver);
    const raced = await Promise.race([
      result.then((value) => ({ kind: "resolved" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500)),
    ]);
    expect(raced.kind).toBe("resolved");
    expect(raced.kind === "resolved" && raced.value.text).toBe("the answer");
    // SILENT: no transcript row about the missing frame. The owner read the
    // first cut's row as noise — the turn simply ended, from where they sit.
    expect(sink.observations.some((o) => o.kind === "item.started" && o.item.detail.type === "provider_wait")).toBeFalse();
  });

  test("a result that arrives inside the grace wins — no row, same text", async () => {
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "quick" }], stop_reason: "end_turn" } };
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
        },
      }),
      { endTurnGraceMs: 200 },
    );
    const { sink, result } = run(driver);
    await expect(result).resolves.toMatchObject({ text: "quick" });
    expect(sink.observations.some((o) => o.kind === "item.started" && o.item.detail.type === "provider_wait")).toBeFalse();
  });

  test("end_turn with a top-level tool still open does NOT arm the grace", async () => {
    // A tool round can straddle an `end_turn` on the envelope that launched
    // it; the tool's result is what the turn waits for, and it must keep
    // waiting past the grace.
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1" } }], stop_reason: "end_turn" } };
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "after" }], stop_reason: "end_turn" } };
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
        },
      }),
      { endTurnGraceMs: 20 },
    );
    const { sink, result } = run(driver);
    await expect(result).resolves.toMatchObject({ text: "after" });
    expect(sink.observations.some((o) => o.kind === "item.started" && o.item.detail.type === "provider_wait")).toBeFalse();
    const toolClose = sink.observations.find((o) => o.kind === "item.completed" && o.itemId === "item_t1");
    expect(toolClose?.kind === "item.completed" && toolClose.status).toBe("completed");
  });
});

describe("session_state_changed is the turn's end where the CLI sends it", () => {
  // A grace far longer than any test: if a turn below ends, `idle` ended it.
  const NEVER = { endTurnGraceMs: 600_000 };
  const state = (value: string) => ({ type: "system", subtype: "session_state_changed", state: value });

  test("the child is asked to send it", async () => {
    let env: Record<string, string | undefined> | undefined;
    const driver = createClaudeDriver(async () => ({
      async *query({ options }: { options: { env?: Record<string, string | undefined> } }) {
        env = options.env;
        yield { type: "result", subtype: "success" };
      },
    }) as never);
    await run(driver).result;
    expect(env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  });

  test("a result the CLI sends before it is done does not end the turn; idle does", async () => {
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          yield state("running");
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "first part" }], stop_reason: "end_turn" } };
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
          // More of OUR main loop — it disarms the grace the result armed.
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "assistant", message: { content: [{ type: "text", text: " and the rest" }], stop_reason: "end_turn" } };
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
          yield state("idle");
          await new Promise(() => undefined);
        },
      }),
      NEVER,
    );
    const { sink, result } = run(driver);
    const resolved = await result;
    expect(resolved.text).toContain("and the rest");
    const texts = sink.observations.flatMap((o) => (o.kind === "item.started" && o.item.detail.type === "assistant_message" ? [o.item.id] : []));
    expect(texts.length).toBe(2);
  });

  test("idle ends a turn whose result never came, without waiting out the grace", async () => {
    // #465's stall, closed by the CLI's own word instead of by a timer. The
    // reply's first frame echoes our send's uuid, as the CLI does: that is
    // what makes a result-less `idle` provably ours.
    const driver = createClaudeDriver(
      async () => ({
        async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
          const first = await prompt[Symbol.asyncIterator]().next();
          yield state("running");
          yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: first.value!.uuid };
          yield { type: "assistant", message: { content: [{ type: "text", text: "the answer" }], stop_reason: "end_turn" } };
          yield state("idle");
          await new Promise(() => undefined);
        },
      }),
      NEVER,
    );
    await expect(run(driver).result).resolves.toMatchObject({ text: "the answer" });
  });

  test("idle while a backgrounded agent runs ends the turn and leaves the agent alive", async () => {
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          yield state("running");
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_a1", description: "Explore", task_type: "local_agent", is_backgrounded: true };
          yield { type: "assistant", message: { content: [{ type: "text", text: "launched it" }], stop_reason: "end_turn" } };
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
          yield state("idle");
          await new Promise(() => undefined);
        },
      }),
      NEVER,
    );
    const { sink, result } = run(driver);
    await result;
    expect(sink.observations.filter((o) => o.kind === "task.completed")).toHaveLength(0);
  });

  test("an idle before our reply has begun is someone else's, and ends nothing", async () => {
    let release: (() => void) | undefined;
    const driver = createClaudeDriver(
      async () => ({
        async *query() {
          // The tail of an earlier turn, read first by this one.
          yield state("idle");
          yield state("running");
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "ours" }], stop_reason: "end_turn" } };
          release?.();
          yield { type: "result", subtype: "success", stop_reason: "end_turn" };
          yield state("idle");
          await new Promise(() => undefined);
        },
      }),
      NEVER,
    );
    const released = new Promise<void>((resolve) => { release = resolve; });
    const { result } = run(driver);
    let settled = false;
    void result.then(() => { settled = true; });
    await released;
    // The stray idle came before our text: had it ended the turn, the result
    // would already be settled with nothing in it.
    expect(settled).toBe(false);
    await expect(result).resolves.toMatchObject({ text: "ours" });
  });
});

test("a result echoing the person's own `origin: human` is OURS and ends the turn (#465)", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string; origin?: unknown }> }) {
      for await (const message of prompt) {
        yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: message.uuid };
        yield { type: "assistant", message: { content: [{ type: "text", text: "answered" }] } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", user_message_uuid: message.uuid, origin: message.origin };
        return;
      }
    },
  }) as never);
  const { result } = run(driver, { promptFromHuman: true });
  const raced = await Promise.race([
    result.then((value) => ({ kind: "resolved" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1500)),
  ]);
  expect(raced.kind).toBe("resolved");
  expect(raced.kind === "resolved" && raced.value.text).toBe("answered");
});

test("a sub-agent's result never completes the parent turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "child" } }] },
      };
      yield { type: "result", subtype: "success", parent_tool_use_id: "toolu_task", stop_reason: "end_turn" };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "child done" }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "parent answer" }], stop_reason: "end_turn" } };
      yield { type: "result", subtype: "success", stop_reason: "end_turn" };
    },
  }));
  const { result } = run(driver);
  await expect(result).resolves.toMatchObject({ text: "parent answer" });
});

test("a sub-agent's FAILED result does not fail the parent turn either", async () => {
  // The other half of the discrimination: a child that died is the child's
  // task row's problem. Before the guard, `subtype: "error_during_execution"`
  // from a sub-agent threw and failed the whole turn.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "result", subtype: "error_during_execution", parent_tool_use_id: "toolu_task" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "parent survived" }], stop_reason: "end_turn" } };
      yield { type: "result", subtype: "success", stop_reason: "end_turn" };
    },
  }));
  await expect(run(driver).result).resolves.toMatchObject({ text: "parent survived" });
});

test("the Claude seam never turns an unsuccessful result into a completed turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "result", subtype: "error_during_execution" };
    },
  }));
  await expect(run(driver).result).rejects.toThrow("Claude did not complete successfully");
});

test("an errored result that still says `success` fails the turn — the subtype alone cannot see it (#779)", async () => {
  const errored = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "half an answer" }] } };
      yield { type: "result", subtype: "success", is_error: true, stop_reason: "end_turn" };
    },
  }));
  await expect(run(errored).result).rejects.toThrow("Claude did not complete successfully (the result was flagged as an error)");

  // AND THE CONTROL, so the guard is not "every result fails now": the same
  // frames with the flag off are the turn they have always been.
  const clean = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "half an answer" }] } };
      yield { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" };
    },
  }));
  await expect(run(clean).result).resolves.toMatchObject({ text: "half an answer" });
});

test("a missing local SDK is a typed provider-unavailable failure", async () => {
  const driver = createClaudeDriver(async () => Promise.reject(new Error("missing")));
  await expect(run(driver).result).rejects.toBeInstanceOf(ProviderUnavailableError);
});
