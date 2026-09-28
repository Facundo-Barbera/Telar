import { describe, expect, test } from "bun:test";
import type { TurnObservation, UsageSnapshot } from "@telar/engine-client";
import { SteerMailbox } from "../../domains/turns";
import { createClaudeDriver, run } from "../../../test/claude-harness";

const wakeUp = (prose: string) => [
  { type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "toolu_bg", summary: "WOKE" },
  { type: "stream_event", event: { type: "message_start" } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: prose } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  { type: "assistant", message: { content: [{ type: "text", text: prose }] } },
  { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } },
];

const reply = (uuid: string, prose: string) => [
  { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: prose } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  { type: "assistant", message: { content: [{ type: "text", text: prose }] } },
  { type: "result", subtype: "success", stop_reason: "end_turn", user_message_uuid: uuid },
];

const sessionDoor = (options: { refuse?: boolean } = {}) => {
  const tasks: TurnObservation[] = [];
  const turns: Array<{ input: string; reason: unknown; observations: TurnObservation[]; closed?: unknown; requests: unknown[] }> = [];
  let runSeq = 0;
  return {
    tasks,
    turns,
    hooks: {
      onTasks: async (batch: TurnObservation[]) => void tasks.push(...batch),
      onProviderTurn: async ({ input, reason }: { input: string; reason: unknown }) => {
        if (options.refuse) return undefined;
        const record: (typeof turns)[number] = { input, reason, observations: [], requests: [] };
        turns.push(record);
        return {
          runId: `run_provider_${(runSeq += 1)}`,
          onObservations: async (batch: TurnObservation[]) => void record.observations.push(...batch),
          onRequest: async (request: unknown) => {
            record.requests.push(request);
            return "accept" as const;
          },
          close: async (result: unknown) => {
            record.closed = result;
          },
        };
      },
    },
  };
};

const settle = async (check: () => boolean, ms = 500) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
};

describe("a turn the CLI started by itself is not this turn", () => {
  test("a buffered wake-up is filed under its task, and the turn ends at ITS OWN result", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        let turns = 0;
        for await (const message of prompt) {
          turns += 1;
          if (turns === 1) {
            yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
            yield* reply(message.uuid!, "started");
            // The shell fires between turns: the CLI's own turn lands on the
            // iterator before the next engine turn's reply.
            yield* wakeUp("Background task completed (WOKE).");
          } else {
            yield* reply(message.uuid!, "ok2");
          }
        }
      },
    }) as never);
    const first = run(driver, { sessionId: "session_woken" });
    await expect(first.result).resolves.toMatchObject({ text: "started" });

    const second = run(driver, { sessionId: "session_woken" });
    const resolved = await second.result;
    // The second turn's answer is ITS answer — not the wake-up's prose, and
    // not "started" twice.
    expect(resolved.text).toBe("ok2");
    // The wake-up's prose is on the transcript, filed under the shell that
    // fired it rather than as the assistant's reply.
    const rows = second.sink.observations.filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
    const foreign = rows.find((o) => o.kind === "item.started" && o.item.taskId === "task_toolu_bg");
    expect(foreign).toBeDefined();
    const own = rows.filter((o) => o.kind === "item.started" && !o.item.taskId);
    expect(own).toHaveLength(1);
    // The notification itself closed the task.
    const closed = second.sink.observations.find((o) => o.kind === "task.completed");
    expect(closed?.kind === "task.completed" && closed.task).toMatchObject({ id: "task_toolu_bg", state: "completed", resultText: "WOKE" });
  });

  for (const echoes of [true, false]) {
    test(`a steer that cuts the turn before its first frame is still answered in it (steer reply ${echoes ? "echoes its key" : "carries no key"})`, async () => {
      let startedGenerating: (() => void) | undefined;
      const generating = new Promise<void>((resolve) => {
        startedGenerating = resolve;
      });
      let cut: (() => void) | undefined;
      const wasCut = new Promise<void>((resolve) => {
        cut = resolve;
      });
      const driver = createClaudeDriver(async () => ({
        query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
          const iterator = prompt[Symbol.asyncIterator]();
          async function* pump() {
            // Turn 1: the process shows it echoes the key.
            yield* reply((await iterator.next()).value!.uuid!, "first");
            // Turn 2: cut before any frame of the reply.
            const opened = (await iterator.next()).value!;
            startedGenerating!();
            await wasCut;
            yield { type: "result", subtype: "interrupted", user_message_uuid: opened.uuid };
            const steered = (await iterator.next()).value!;
            const answer = reply(steered.uuid!, "answered the steer");
            if (!echoes) for (const frame of answer) delete (frame as { user_message_uuid?: string }).user_message_uuid;
            // Disowned, this result is skipped and the stream ends under a
            // turn with no result — a rejection here, a hang against the
            // real CLI, which keeps the stream open.
            yield* answer;
          }
          return Object.assign(pump(), { interrupt: async () => void cut!() });
        },
      }) as never);
      await expect(run(driver, { sessionId: `session_cut_${echoes}` }).result).resolves.toMatchObject({ text: "first" });
      const steer = new SteerMailbox();
      const second = run(driver, { sessionId: `session_cut_${echoes}`, steer });
      await generating;
      steer.push("change course");
      await expect(second.result).resolves.toMatchObject({ text: "answered the steer" });
    });
  }

  test("a notification in a LATER turn lands on the row its tool-use opened — no ghost row", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        let turns = 0;
        for await (const message of prompt) {
          turns += 1;
          if (turns === 1) {
            yield { type: "system", subtype: "task_started", task_id: "b7ohaj89n", tool_use_id: "toolu_mon", description: "Monitor the log", task_type: "local_bash", is_backgrounded: true };
            yield* reply(message.uuid!, "watching");
          } else {
            // The CLI reports on it by SDK id alone, in the next turn.
            yield { type: "system", subtype: "task_updated", task_id: "b7ohaj89n", patch: { status: "killed" } };
            yield { type: "system", subtype: "task_notification", task_id: "b7ohaj89n", summary: "stream ended" };
            yield* reply(message.uuid!, "ok2");
          }
        }
      },
    }) as never);
    await run(driver, { sessionId: "session_remembers" }).result;
    const second = run(driver, { sessionId: "session_remembers" });
    await second.result;
    const taskEvents = second.sink.observations.filter((o) => o.kind === "task.completed" || o.kind === "task.progress" || o.kind === "task.started");
    expect(taskEvents.map((o) => (o.kind === "task.completed" || o.kind === "task.progress" || o.kind === "task.started") && o.task.id)).toEqual(["task_toolu_mon", "task_toolu_mon"]);
    const last = taskEvents.at(-1);
    expect(last?.kind === "task.completed" && last.task).toMatchObject({ id: "task_toolu_mon", kind: "background", state: "stopped", title: "Monitor the log", resultText: "stream ended" });
  });

  test("a runtime built cold is seeded with the store's live rows, so a restart does not orphan a shell's report", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        for await (const message of prompt) {
          // The very first thing the fresh process hears about is a task it
          // never launched — the store did, under a process that is gone.
          yield { type: "system", subtype: "task_notification", task_id: "b7ohaj89n", status: "completed", summary: "CI is green" };
          yield* reply(message.uuid!, "ok");
        }
      },
    }) as never);
    const { sink, result } = run(driver, {
      sessionId: "session_cold",
      tasks: [{ id: "task_toolu_ci", providerTaskId: "b7ohaj89n", kind: "background", backgrounded: true, state: "running", title: "Wait for CI" }],
    });
    await result;
    const closed = sink.observations.filter((o) => o.kind === "task.completed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.kind === "task.completed" && closed[0].task).toMatchObject({ id: "task_toolu_ci", kind: "background", state: "completed", title: "Wait for CI", resultText: "CI is green" });
    expect(sink.observations.some((o) => o.kind === "task.started")).toBe(false);
  });
});

describe("a turn the CLI started by itself is not this turn", () => {
  test("a wake-up whose task never announced keeps its rows, but is never the answer", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        let turns = 0;
        for await (const message of prompt) {
          turns += 1;
          if (turns === 1) {
            yield* reply(message.uuid!, "first");
            // No task_notification precedes it — the CLI's turn has no task
            // this driver can name.
            yield* wakeUp("orphan prose").filter((m) => m.subtype !== "task_notification");
          } else {
            yield* reply(message.uuid!, "second");
          }
        }
      },
    }) as never);
    await run(driver, { sessionId: "session_orphan" }).result;
    const second = run(driver, { sessionId: "session_orphan" });
    // The turn's answer is ITS answer: the wake-up's prose never joins it.
    await expect(second.result).resolves.toMatchObject({ text: "second" });
    // The wake-up's prose is still on the transcript — a human turn's window
    // is the fallback for a wake-up the idle pump did not get to; dropping
    // it hid what the agent did. It has no task to file under.
    const prose = second.sink.observations.filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
    expect(prose).toHaveLength(2);
    expect(prose.every((o) => o.kind === "item.started" && o.item.taskId === undefined)).toBe(true);
  });

  test("BETWEEN TURNS the idle pump hears a shell end and opens a PROVIDER TURN for the wake-up", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        // The turn is over; the engine is idle. The shell fires.
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        // The CLI echoes the message it injected, then the model replies.
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CI is green, merging." } } };
        yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_merge", name: "Bash", input: { command: "gh pr merge" } }] } };
        yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_merge", content: "merged" }] } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        // Stay alive for a possible next turn.
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    const first = run(driver, { sessionId: "session_idle_pump", session: door.hooks });
    await expect(first.result).resolves.toMatchObject({ text: "started" });
    expect(door.tasks).toHaveLength(0);

    releaseWake!();
    // The notification closed the row WITH NO HUMAN TURN.
    await settle(() => door.tasks.some((o) => o.kind === "task.completed"));
    const closed = door.tasks.find((o) => o.kind === "task.completed");
    expect(closed?.kind === "task.completed" && closed.task).toMatchObject({ id: "task_toolu_bg", state: "completed", resultText: "DONE" });

    // The wake-up became a turn of its own, named after the shell.
    await settle(() => door.turns[0]?.closed !== undefined);
    const wake = door.turns[0]!;
    expect(wake.reason).toEqual({ kind: "task_notification", taskId: "task_toolu_bg" });
    expect(wake.input).toBe("Background task completed (DONE).");
    expect(wake.closed).toEqual({ text: "CI is green, merging." });
    // Its rows went to ITS sink: prose, and a tool row that got a decision.
    expect(wake.observations.some((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message")).toBe(true);
    const tool = wake.observations.find((o) => o.kind === "item.started" && o.item.detail.type === "command_execution");
    expect(tool).toBeDefined();
    expect(wake.observations.some((o) => o.kind === "item.completed" && o.itemId === "item_toolu_merge" && o.status === "completed")).toBe(true);
    // Nothing of it leaked into the first turn's sink.
    expect(first.sink.observations.some((o) => o.kind === "item.started" && o.item.detail.type === "command_execution")).toBe(false);
  });

  test("a wake-up's result flagged `is_error` closes as a failure, not as its own answer (#779)", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "half an answer" }] } };
        yield { type: "result", subtype: "success", is_error: true, stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    const first = run(driver, { sessionId: "session_idle_errored_success", session: door.hooks });
    await expect(first.result).resolves.toMatchObject({ text: "started" });

    releaseWake!();
    await settle(() => door.turns[0]?.closed !== undefined);
    // Measured against the old predicate: `{ text: "" }` — the safeguard's
    // error filed as the wake-up's answer, and an empty one at that.
    expect(door.turns[0]!.closed).toEqual({ failure: "Claude did not complete successfully (the result was flagged as an error)" });
  });
});

describe("a turn the CLI started by itself is not this turn", () => {
  test("a wake-up's retry and its final output count reach ITS turn, exactly as a human turn's do", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        // The provider makes the AUTONOMOUS turn wait.
        yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 3, retry_delay_ms: 15_000, error_status: 529 };
        // An unrelated shell reporting mid-wait must not end it.
        yield { type: "system", subtype: "task_progress", task_id: "bg1", summary: "still going" };
        yield { type: "assistant", message: { content: [{ type: "text", text: "back" }], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 2 } } };
        yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 640 } } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_wake_parity", session: door.hooks }).result;
    releaseWake!();
    await settle(() => door.turns[0]?.closed !== undefined);
    const wake = door.turns[0]!;

    // The wait is a row on the wake-up's own turn…
    const waitStarted = wake.observations.findIndex((o) => o.kind === "item.started" && o.item.detail.type === "provider_wait");
    expect(waitStarted).toBeGreaterThanOrEqual(0);
    const row = wake.observations[waitStarted] as { item: { id: string; title?: string; detail: { type: string } } };
    expect(row.item.title).toBe("Retrying in 15s after HTTP 529 (attempt 2 of 3)");
    // …closed by this turn's own model output, not by the shell's progress.
    const waitClosed = wake.observations.findIndex((o) => o.kind === "item.completed" && o.itemId === row.item.id);
    expect(waitClosed).toBeGreaterThan(waitStarted);
    // (the shell had already been notified, so its later report announces as a
    // repeat completion rather than progress — either way it is task traffic,
    // and either way it must not be read as the retried request succeeding)
    expect(wake.observations.slice(waitStarted + 1, waitClosed).some((o) => o.kind.startsWith("task."))).toBeTrue();

    // And the meter takes the response's REAL output, not the envelope's 1.
    const usages = wake.observations.flatMap((o) => (o.kind === "usage" ? [o.usage] : []));
    expect(usages.map((usage) => usage.tokens.output)).toEqual([1, 640, 640]);
    expect(usages[1]?.contextUsed).toBe(739);
    expect(usages[1]?.tokens).toMatchObject({ input: 7, cacheRead: 90, cacheCreate: 2 });
  });

  test("a wake-up collapses the repeat warning the same way a human turn does (#897)", async () => {
    const warning = (extra: Record<string, unknown> = {}) => ({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_800_000_000, utilization: 0.88, ...extra },
    });
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield warning();
        yield { type: "assistant", message: { content: [{ type: "text", text: "back" }] } };
        yield warning({ utilization: 0.9 });
        yield warning();
        // A new reset time still speaks.
        yield warning({ resetsAt: 1_800_600_000 });
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_wake_limit_warning", session: door.hooks }).result;
    releaseWake!();
    await settle(() => door.turns[0]?.closed !== undefined);
    const waits = door.turns[0]!.observations.flatMap((o) => (o.kind === "item.started" && o.item.detail.type === "provider_wait" ? [o.item] : []));
    expect(waits.map((item) => item.title)).toEqual(["Approaching the rate limit (five hour)", "Approaching the rate limit (five hour)"]);
    const waited = waits.flatMap((item) => (item.detail.type === "provider_wait" ? [item.detail.wait] : []));
    expect(waited.map((wait) => wait.resetsAt)).toEqual([1_800_000_000, 1_800_600_000]);
  });

  test("THE REQUEST OPENS THE WAKE-UP'S TURN, so the gap before the first token is not silence (#71)", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    let releaseReply: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => { releaseReply = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        // The request goes out. Everything below it is the silence.
        yield { type: "system", subtype: "status", status: "requesting" };
        await answered;
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CI is green." } } };
        yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_wake_requesting", session: door.hooks }).result;

    releaseWake!();
    // The turn is open on the announcement alone — named after the shell that
    // woke it, and with nothing on it yet, which is the state the indicator
    // exists to draw.
    await settle(() => door.turns.length === 1);
    expect(door.turns[0]!.reason).toEqual({ kind: "task_notification", taskId: "task_toolu_bg" });
    expect(door.turns[0]!.observations.filter((o) => o.kind === "item.started")).toHaveLength(0);
    expect(door.turns[0]!.closed).toBeUndefined();

    // And the reply that follows joins THAT turn rather than opening a second.
    releaseReply!();
    await settle(() => door.turns[0]?.closed !== undefined);
    expect(door.turns).toHaveLength(1);
    expect(door.turns[0]!.closed).toEqual({ text: "CI is green." });
    // The echoed notification is not a row: it was the turn's input, and a turn
    // opened before it arrived simply has none.
    expect(door.turns[0]!.observations.filter((o) => o.kind === "item.started")).toHaveLength(1);
    expect(door.turns[0]!.input).toBe("");
  });
});

describe("a turn the CLI started by itself is not this turn", () => {
  test("a request the CLI sends between turns with no task behind it opens no turn", async () => {
    let releaseIdle: (() => void) | undefined;
    const idled = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield* reply(first.value!.uuid!, "done");
        await idled;
        // No task spoke: nothing woke the model, whatever this request is.
        yield { type: "system", subtype: "status", status: "requesting" };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_idle_requesting", session: door.hooks }).result;
    releaseIdle!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(door.turns).toHaveLength(0);
  });

  test("a Monitor's tick is a task_progress, and the wake-up it triggers is still named after the monitor", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "mon1", tool_use_id: "toolu_mon", description: "two ticks", task_type: "monitor", is_backgrounded: true };
        // A shell launched AFTER the monitor in the same turn: the last task
        // to speak inside the turn, and not what wakes the model below.
        yield { type: "system", subtype: "task_started", task_id: "sh1", tool_use_id: "toolu_sh", description: "sleep then done", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "watching");
        await woke;
        // A tick: progress, not a notification — and the CLI wakes on it.
        yield { type: "system", subtype: "task_progress", task_id: "mon1", summary: "TICK_ONE" };
        yield { type: "user", message: { role: "user", content: "Monitor output: TICK_ONE" } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "tick: TICK_ONE" }] } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_tick", session: door.hooks }).result;
    releaseWake!();
    await settle(() => door.turns[0]?.closed !== undefined);
    expect(door.turns[0]!.reason).toEqual({ kind: "task_notification", taskId: "task_toolu_mon" });
  });

  test("a wake-up the engine refuses (a human turn won) is parked and read by that turn", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep 5", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield* wakeUp("late wake");
        const second = await input.next();
        yield* reply(second.value!.uuid!, "ok2");
      },
    }) as never);
    const door = sessionDoor({ refuse: true });
    await run(driver, { sessionId: "session_parked_wake", session: door.hooks }).result;
    releaseWake!();
    // The idle pump read the notification (filed), then the message_start,
    // which the engine refused — parked for the next turn.
    await settle(() => door.tasks.some((o) => o.kind === "task.completed"));
    const second = run(driver, { sessionId: "session_parked_wake", session: door.hooks });
    await expect(second.result).resolves.toMatchObject({ text: "ok2" });
    // The wake-up's prose is on THIS turn, filed under the shell; the turn's
    // answer is its own. No frame was lost.
    const foreign = second.sink.observations.find((o) => o.kind === "item.started" && o.item.taskId === "task_toolu_bg");
    expect(foreign).toBeDefined();
  });

  test("a provider-started turn emits usage per envelope and takes the provider's window from its result", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "sleep", task_type: "local_bash", is_backgrounded: true };
        yield* reply(first.value!.uuid!, "started");
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", summary: "DONE" };
        yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "noted" }], usage: { input_tokens: 150_000, output_tokens: 10, cache_read_input_tokens: 20_000 } } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" }, usage: { input_tokens: 150_000, output_tokens: 10 }, modelUsage: { "claude-opus-5": { contextWindow: 200_000, inputTokens: 150_000 } } };
        await input.next();
      },
    }) as never);
    const door = sessionDoor();
    await run(driver, { sessionId: "session_idle_usage", session: door.hooks, model: "opus[1m]" }).result;
    releaseWake!();
    await settle(() => door.turns[0]?.closed !== undefined);
    const wake = door.turns[0]!;
    const usages = wake.observations.filter((o) => o.kind === "usage");
    expect(usages.length).toBeGreaterThanOrEqual(2);
    // The envelope: occupancy, under the selected row's 1M assumption.
    expect(usages[0]?.kind === "usage" && usages[0].usage).toMatchObject({ contextUsed: 170_010, contextMax: 1_000_000 });
    // The result: the provider's window replaces the assumption, downward.
    expect(usages.at(-1)?.kind === "usage" && usages.at(-1)!.usage).toMatchObject({ contextUsed: 170_010, contextMax: 200_000, tokens: { input: 150_000, output: 10 } });
    // And the turn's close carries it, so the engine stores it on the turn.
    expect((wake.closed as { usage?: UsageSnapshot }).usage).toMatchObject({ contextMax: 200_000 });
  });

  test("without a session door the stream is read only while a turn pumps — the old behaviour, exactly", async () => {
    let pulled = 0;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield* reply(first.value!.uuid!, "one");
        pulled += 1;
        yield { type: "system", subtype: "task_notification", task_id: "x", summary: "never read idly" };
        pulled += 1;
        await input.next();
      },
    }) as never);
    await run(driver, { sessionId: "session_no_door" }).result;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing pulled past the result: the notification is still buffered
    // inside the generator, exactly where the old pump left it.
    expect(pulled).toBe(0);
  });
});

describe("a turn the CLI started by itself is not this turn", () => {
  test("a local command's result — no message_start, no uuid, no origin — ends OUR turn", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        let turns = 0;
        for await (const message of prompt) {
          turns += 1;
          if (turns === 1) {
            yield* reply(message.uuid!, "first");
          } else {
            yield { type: "system", subtype: "status", status: "compacting" };
            yield { type: "system", subtype: "status", status: null, compact_result: "success" };
            yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 358_700, post_tokens: 9_400 } };
            yield { type: "system", subtype: "init" };
            yield { type: "result", subtype: "success", stop_reason: null, num_turns: 0 };
          }
        }
      },
    }) as never);
    await run(driver, { sessionId: "session_compact" }).result;
    const second = run(driver, { sessionId: "session_compact", prompt: "/compact" });
    await expect(second.result).resolves.toMatchObject({ text: "" });
    // One compaction row, opened by the announcement and closed by the
    // boundary that carries the numbers — not a second "Compacted context".
    const rows = second.sink.observations.filter((o) => o.kind === "item.started");
    expect(rows).toHaveLength(1);
    const closed = second.sink.observations.filter((o) => o.kind === "item.completed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.kind === "item.completed" && closed[0].status).toBe("completed");
    expect(closed[0]?.kind === "item.completed" && closed[0].detail).toMatchObject({ preTokens: 358_700, postTokens: 9_400 });
  });

  test("an older producer that never echoes the uuid still ends the turn at its result", async () => {
    // No `user_message_uuid` and no `origin` anywhere: nothing says foreign,
    // so the first result is the turn's — exactly as before.
    const driver = createClaudeDriver(async () => ({
      async *query() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "plain" }] } };
        yield { type: "result", subtype: "success" };
      },
    }));
    await expect(run(driver).result).resolves.toMatchObject({ text: "plain" });
  });
});

for (const providerSessionId of [undefined, 'resumed-browser-session']) {
  test(`browser briefing preserves Claude's preset on ${providerSessionId ? 'resume' : 'start'} and is absent without a browser`, async () => {
    const prompts: unknown[] = [];
    const sdk = async () => ({
      async *query(input: { options: { systemPrompt?: unknown } }) {
        prompts.push(input.options.systemPrompt);
        yield { type: "result", subtype: "success" };
      },
    });
    await run(createClaudeDriver(sdk), {
      ...(providerSessionId ? { providerSessionId } : {}),
      browserSocket: { url: 'http://127.0.0.1:1234/v2/browser/mcp', token: 'test-token' },
    }).result;
    const briefing = prompts[0] as { type: string; preset: string; append: string };
    expect(briefing.type).toBe('preset');
    expect(briefing.preset).toBe('claude_code');
    expect(briefing.append).toContain('telar-browser');
    expect(briefing.append).toContain('tools may be deferred');
    expect(JSON.stringify(prompts[0])).not.toContain('test-token');
    await run(createClaudeDriver(sdk), providerSessionId ? { providerSessionId } : {}).result;
    expect(prompts[1]).toBeUndefined();
  });
}
