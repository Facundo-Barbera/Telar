import { afterEach, describe, expect, jest, test } from "bun:test";
import type { TurnObservation } from "@telar/engine-client";
import { SteerMailbox } from "../../domains/turns";
import { until } from "../../../test/wait";
import { createClaudeDriver, run } from "../../../test/claude-harness";

describe("background work outlives its turn, but not its process (#465)", () => {
  const settleUntil = async (check: () => boolean, ms = 1_000) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(check()).toBe(true);
  };

  /** A session door with a recorder behind each hook — the idle-pump shape,
   *  re-declared because the one above is scoped to its own describe block. */
  const door465 = () => {
    const tasks: TurnObservation[] = [];
    const turns: Array<{ input: string; reason: unknown; observations: TurnObservation[]; closed?: unknown }> = [];
    let runSeq = 0;
    return {
      tasks,
      turns,
      hooks: {
        onTasks: async (batch: TurnObservation[]) => void tasks.push(...batch),
        onProviderTurn: async ({ input, reason }: { input: string; reason: unknown }) => {
          const record = { input, reason, observations: [] as TurnObservation[] } as (typeof turns)[number];
          turns.push(record);
          return {
            runId: `run_465_${(runSeq += 1)}`,
            onObservations: async (batch: TurnObservation[]) => void record.observations.push(...batch),
            close: async (result: unknown) => { record.closed = result; },
          };
        },
      },
    };
  };

  test("a reply with nothing left but a RUNNING background task settles, and the shell's ending opens a turn of its own", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        const uuid = first.value!.uuid!;
        yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid };
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "watch CI", task_type: "local_bash", is_backgrounded: true };
        yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "watch CI" }] };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Watching CI; I'll report back." }], stop_reason: "end_turn" } };
        // …and then nothing. No `result` — the measured stall exactly.
        await woke;
        yield { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", summary: "CI is green" };
        yield { type: "user", message: { role: "user", content: "Background task completed (CI is green)." } };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Green — merging." } } };
        yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
        await input.next();
      },
    }) as never);
    const door = door465();
    const { sink, result } = run(driver, { sessionId: "session_465_bg", session: door.hooks, endTurnGraceMs: 20 });
    // The turn ends on the reply it actually wrote, with the shell still alive.
    await expect(result).resolves.toMatchObject({ text: "Watching CI; I'll report back." });
    // NOT swept: background work is what outlives a turn, and closing it here
    // would kill the very thing the person is waiting on.
    expect(sink.observations.some((o) => o.kind === "task.completed")).toBe(false);

    releaseWake!();
    // Its ending arrives on the idle pump and opens a NEW turn, named after the
    // shell that woke it — the wake path #71/#447 already built.
    await settleUntil(() => door.turns[0]?.closed !== undefined);
    expect(door.turns).toHaveLength(1);
    expect(door.turns[0]!.reason).toEqual({ kind: "task_notification", taskId: "task_toolu_bg" });
    expect(door.turns[0]!.closed).toEqual({ text: "Green — merging." });
  });

  test("a process that dies BETWEEN turns with background work inside it says how much was lost, and the rows stop claiming to run", async () => {
    let releaseDeath: (() => void) | undefined;
    const died = new Promise<void>((resolve) => { releaseDeath = resolve; });
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        const uuid = first.value!.uuid!;
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "watch CI", task_type: "local_bash", is_backgrounded: true };
        yield { type: "system", subtype: "task_started", task_id: "bg2", tool_use_id: "toolu_bg2", description: "tail the log", task_type: "monitor", is_backgrounded: true };
        yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid };
        yield { type: "assistant", message: { content: [{ type: "text", text: "both running" }] } };
        yield { type: "result", subtype: "success", stop_reason: "end_turn", user_message_uuid: uuid };
        // The turn is over and the process is idle. Then it dies — a crash, a
        // quit, the owner restarting Telar.
        await died;
      },
    }) as never);
    const door = door465();
    await run(driver, { sessionId: "session_465_death", session: door.hooks }).result;
    releaseDeath!();

    await settleUntil(() => door.tasks.some((o) => o.kind === "runtime.warning"));
    const warning = door.tasks.find((o) => o.kind === "runtime.warning");
    expect(warning?.kind === "runtime.warning" && warning.message).toContain("2 background tasks still running");
    // Both rows are closed, so `livenessOf` stops reading the session as busy.
    const closed = door.tasks.filter((o) => o.kind === "task.completed");
    expect(closed.map((o) => (o.kind === "task.completed" ? [o.task.id, o.task.state] : []))).toEqual([
      ["task_toolu_bg", "stopped"],
      ["task_toolu_bg2", "stopped"],
    ]);
  });

  test("a process that dies DURING a turn reports the same loss on the turn itself", async () => {
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: first.value!.uuid! };
        yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "watch CI", task_type: "local_bash", is_backgrounded: true };
        // The stream ends mid-turn: no result, and the shell dies with it.
      },
    }) as never);
    const { sink, result } = run(driver, { sessionId: "session_465_death_midturn" });
    // The turn still fails — the process really did go away mid-answer.
    await expect(result).rejects.toThrow();
    const warning = sink.observations.find((o) => o.kind === "runtime.warning");
    expect(warning?.kind === "runtime.warning" && warning.message).toContain("1 background task still running");
    const closed = sink.observations.find((o) => o.kind === "task.completed");
    expect(closed?.kind === "task.completed" && closed.task).toMatchObject({ id: "task_toolu_bg", state: "stopped" });
  });
});

test("a steer that cuts a tool call does not wedge the turn — the cut row closes and the next result ends it (#465)", async () => {
  let startedGenerating: (() => void) | undefined;
  const generating = new Promise<void>((resolve) => { startedGenerating = resolve; });
  let releaseGeneration: (() => void) | undefined;
  const cut = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  const heard: unknown[] = [];
  const driver = createClaudeDriver(async () => ({
    query({ prompt }: { prompt: AsyncIterable<{ uuid?: string; message: { content: unknown } }> }) {
      const iterator = prompt[Symbol.asyncIterator]();
      async function* pump() {
        const first = await iterator.next();
        const uuid = first.value!.uuid!;
        heard.push(first.value!.message.content);
        yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid };
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_cut", name: "Bash", input: { command: "gh pr checks" } }] } };
        startedGenerating!();
        // The call is in flight when the steer lands. Its `tool_result` never
        // arrives — the interrupt killed the response that would have sent it.
        await cut;
        yield { type: "result", subtype: "interrupted", user_message_uuid: uuid };
        const second = await iterator.next();
        heard.push(second.value!.message.content);
        yield { type: "stream_event", event: { type: "message_start" } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "stopped, here is where I got to" }] } };
        // The shape the measured stall produced: a result that states nothing
        // definite. Against a stale tool set this used to park the pump.
        yield { type: "result", subtype: "success", stop_reason: null };
        await iterator.next();
      }
      return Object.assign(pump(), { interrupt: async () => releaseGeneration!() });
    },
  }) as never);
  const steer = new SteerMailbox();
  const { sink, result } = run(driver, { sessionId: "session_465_cut", steer });
  await generating;
  steer.push("actually, stop");
  // THE ASSERTION IS THAT THIS RESOLVES AT ALL. Before the fix the pump sat on
  // the stale id until a human pressed Stop — here, until the test timed out.
  await expect(result).resolves.toMatchObject({ text: "stopped, here is where I got to" });
  // The steer really was delivered as a second message, not queued behind.
  expect(heard).toEqual(["prompt", "actually, stop"]);
  // And the call the interrupt killed is closed rather than left spinning, with
  // the reason on the row: it really did not finish.
  const closed = sink.observations.find((o) => o.kind === "item.completed" && o.itemId === "item_toolu_cut");
  expect(closed?.kind === "item.completed" && closed.status).toBe("failed");
  expect(JSON.stringify(closed?.kind === "item.completed" ? closed.detail : undefined)).toContain("cut by a steer");
});

const reply = (uuid: string, prose: string) => [
  { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid },
  { type: "assistant", message: { content: [{ type: "text", text: prose }] } },
  { type: "result", subtype: "success", stop_reason: "end_turn", user_message_uuid: uuid },
];

type Gate = (name: string, args: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>;

const asChild = (toolUseID: string) => ({ signal: new AbortController().signal, toolUseID });

/** The engine's door, recording every turn the driver asked it to open. */
const claimDoor = (options: { decide?: () => Promise<"accept" | "decline"> } = {}) => {
  const tasks: TurnObservation[] = [];
  const turns: Array<{ input: string; reason: unknown; requests: unknown[]; closed?: unknown; want: AbortController }> = [];
  let seq = 0;
  return {
    tasks,
    turns,
    hooks: {
      onTasks: async (batch: TurnObservation[]) => void tasks.push(...batch),
      onProviderTurn: async ({ input, reason }: { input: string; reason: unknown }) => {
        const record = { input, reason, requests: [] as unknown[], want: new AbortController() } as (typeof turns)[number];
        turns.push(record);
        return {
          runId: `run_891_${(seq += 1)}`,
          wanted: record.want.signal,
          onObservations: async () => undefined,
          onRequest: async (request: unknown) => {
            record.requests.push(request);
            return options.decide ? await options.decide() : ("accept" as const);
          },
          close: async (result: unknown) => { record.closed = result; },
        };
      },
    },
  };
};

const dispatcher = (lingerMs = 20) => {
  const held: { gate?: Gate } = {};
  const driver = createClaudeDriver(
    (async () => ({
      async *query({ prompt, options }: { prompt: AsyncIterable<{ uuid?: string }>; options: { canUseTool?: Gate } }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        held.gate = options.canUseTool;
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "ag1",
          tool_use_id: "toolu_agent",
          description: "build the thing",
          task_type: "local_agent",
          is_backgrounded: true,
        };
        yield* reply(first.value!.uuid!, "dispatched; it will report back");
        // Alive between turns, like the CLI.
        await input.next();
      },
    })) as never,
    { backgroundClaimLingerMs: lingerMs },
  );
  return { driver, held };
};

describe("a task kept alive past turn end keeps a claim to ask under (#891)", () => {
  test("a backgrounded agent's tool call after its turn settles is decided under a claim of its own", async () => {
    const door = claimDoor();
    const { driver, held } = dispatcher();
    const { result } = run(driver, { sessionId: "session_891_claimed", session: door.hooks, onRequest: async () => "accept" });
    await expect(result).resolves.toMatchObject({ text: "dispatched; it will report back" });
    // The row is NOT swept: outliving its turn is what backgrounding means.
    expect(door.tasks.some((o) => o.kind === "task.completed")).toBe(false);

    // THE MOMENT THE BUG LIVED IN. The parent's turn has settled; the agent is
    // still working and needs a decision.
    await expect(held.gate!("Bash", { command: "rm -rf build" }, asChild("toolu_child"))).resolves.toEqual({ behavior: "allow" });

    // Decided under a turn opened FOR THE TASK, not against the dead one.
    expect(door.turns).toHaveLength(1);
    expect(door.turns[0]!.reason).toEqual({ kind: "background_task", taskId: "task_toolu_agent" });
    expect(door.turns[0]!.requests).toHaveLength(1);
    // A second call shares that one turn rather than writing a row per
    // decision into a transcript a person reads.
    await expect(held.gate!("Bash", { command: "ls" }, asChild("toolu_child2"))).resolves.toEqual({ behavior: "allow" });
    expect(door.turns).toHaveLength(1);
    expect(door.turns[0]!.requests).toHaveLength(2);
    // The agent is still alive, so the claim is too (#912).
    expect(door.turns[0]!.closed).toBeUndefined();
  });

  test("a decision the human declines reaches the child as the human's, not as plumbing", async () => {
    // The anti-vacuity for the test above: a claim that answered `allow` to
    // everything would pass it while deciding nothing.
    const door = claimDoor({ decide: async () => "decline" });
    const { driver, held } = dispatcher();
    await run(driver, { sessionId: "session_891_declined", session: door.hooks, onRequest: async () => "accept" }).result;
    await expect(held.gate!("Bash", { command: "rm -rf /" }, asChild("toolu_child"))).resolves.toMatchObject({
      behavior: "deny",
      message: "The human declined this tool call.",
    });
  });

  test("with nothing alive to claim for, the child is told what happened rather than reaching a dead claim", async () => {
    const door = claimDoor();
    const held: { gate?: Gate } = {};
    const driver = createClaudeDriver((async () => ({
      async *query({ prompt, options }: { prompt: AsyncIterable<{ uuid?: string }>; options: { canUseTool?: Gate } }) {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        held.gate = options.canUseTool;
        // A sub-agent that is NOT backgrounded: the turn-end sweep fails it, so
        // there is nothing left for a claim to be opened for.
        yield { type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "toolu_agent", description: "quick look", task_type: "local_agent" };
        yield* reply(first.value!.uuid!, "answered");
        await input.next();
      },
    })) as never);
    await run(driver, { sessionId: "session_891_floor", session: door.hooks, onRequest: async () => "accept" }).result;
    const answer = (await held.gate!("Bash", { command: "ls" }, asChild("toolu_child"))) as { behavior: string; message: string };
    expect(answer.behavior).toBe("deny");
    expect(answer.message).toContain("has ended");
    expect(answer.message).toContain("Nobody declined it");
    // No turn was opened for work that is not there.
    expect(door.turns).toHaveLength(0);
  });

  test("the claim yields to a real wake-up, and the gate comes back after it", async () => {
    let releaseWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => { releaseWake = resolve; });
    const held: { gate?: Gate } = {};
    const driver = createClaudeDriver(
      (async () => ({
        async *query({ prompt, options }: { prompt: AsyncIterable<{ uuid?: string }>; options: { canUseTool?: Gate } }) {
          const input = prompt[Symbol.asyncIterator]();
          const first = await input.next();
          held.gate = options.canUseTool;
          yield { type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "toolu_agent", description: "build", task_type: "local_agent", is_backgrounded: true };
          yield { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "toolu_bg", description: "watch", task_type: "local_bash", is_backgrounded: true };
          yield* reply(first.value!.uuid!, "dispatched");
          await woke;
          yield { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", summary: "DONE" };
          yield { type: "user", message: { role: "user", content: "Background task completed (DONE)." } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "noted" }] } };
          yield { type: "result", subtype: "success", stop_reason: "end_turn", origin: { kind: "task-notification" } };
          await input.next();
        },
      })) as never,
      // Long enough that the claim is still open when the wake arrives.
      { backgroundClaimLingerMs: 60_000 },
    );
    const door = claimDoor();
    await run(driver, { sessionId: "session_891_yield", session: door.hooks, onRequest: async () => "accept" }).result;
    await held.gate!("Bash", { command: "ls" }, asChild("toolu_child"));
    expect(door.turns).toHaveLength(1);
    // Two live tasks, so no single one can honestly be named.
    expect(door.turns[0]!.reason).toEqual({ kind: "background_task" });
    // Still open — the linger is a minute.
    expect(door.turns[0]!.closed).toBeUndefined();

    releaseWake!();
    // The wake got a turn of its own, which is only possible because the claim
    // let go of the session first.
    await until("the wake-up to open its own turn", () => door.turns.length === 2);
    expect(door.turns[0]!.closed).toBeDefined();
    expect(door.turns[1]!.reason).toEqual({ kind: "task_notification", taskId: "task_toolu_bg" });
    await until("the wake-up to settle", () => door.turns[1]!.closed !== undefined);
    // …and the agent, still alive, can ask again afterwards: `endWake` put the
    // background gate back rather than clearing it.
    await expect(held.gate!("Bash", { command: "ls" }, asChild("toolu_child3"))).resolves.toEqual({ behavior: "allow" });
    expect(door.turns).toHaveLength(3);
    expect(door.turns[2]!.reason).toEqual({ kind: "background_task", taskId: "task_toolu_agent" });
  });
});

describe("a task kept alive past turn end keeps a claim to ask under (#891)", () => {
  describe("one claim per stretch of background work, not per burst (#912)", () => {
    /** Every promise the pump and the claim chain queue, run to rest. */
    const drain = async () => {
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
    };

    /** The dispatcher, plus a handle to end the agent and a second turn that
     *  decides a child's call itself while it runs. */
    const researcher = () => {
      const held: { gate?: Gate; decidedInTurn?: unknown } = {};
      let finish: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const driver = createClaudeDriver(
        (async () => ({
          async *query({ prompt, options }: { prompt: AsyncIterable<{ uuid?: string }>; options: { canUseTool?: Gate } }) {
            const input = prompt[Symbol.asyncIterator]();
            const first = await input.next();
            held.gate = options.canUseTool;
            yield { type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "toolu_agent", description: "research", task_type: "local_agent", is_backgrounded: true };
            yield* reply(first.value!.uuid!, "dispatched");
            const next = await Promise.race([input.next(), finished.then(() => undefined)]);
            if (next === undefined) {
              yield { type: "system", subtype: "task_notification", task_id: "ag1", tool_use_id: "toolu_agent", status: "completed", summary: "found it" };
              await input.next();
              return;
            }
            // A person's turn: the child asks while it runs.
            yield { type: "stream_event", event: { type: "message_start" }, user_message_uuid: next.value!.uuid };
            held.decidedInTurn = await options.canUseTool!("Bash", { command: "ls" }, asChild("toolu_child_in_turn"));
            yield { type: "assistant", message: { content: [{ type: "text", text: "yours" }] } };
            yield { type: "result", subtype: "success", stop_reason: "end_turn", user_message_uuid: next.value!.uuid };
            await input.next();
          },
        })) as never,
        { backgroundClaimLingerMs: 5_000 },
      );
      return { driver, held, finish: () => finish!() };
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    test("calls 8 s apart under one live agent share one claim, which closes 5 s after the agent ends", async () => {
      const door = claimDoor();
      const { driver, held, finish } = researcher();
      await run(driver, { sessionId: "session_912_stretch", session: door.hooks, onRequest: async () => "accept" }).result;
      jest.useFakeTimers();

      await held.gate!("Bash", { command: "curl a" }, asChild("toolu_c1"));
      jest.advanceTimersByTime(8_000);
      await drain();
      // Past the old 5 s linger, and the agent is still working: still open.
      expect(door.turns[0]!.closed).toBeUndefined();
      await held.gate!("Bash", { command: "curl b" }, asChild("toolu_c2"));
      expect(door.turns).toHaveLength(1);
      expect(door.turns[0]!.requests).toHaveLength(2);

      // The agent reports back. The tail starts from HERE, not from the call.
      finish();
      await drain();
      jest.advanceTimersByTime(4_999);
      await drain();
      expect(door.turns[0]!.closed).toBeUndefined();
      jest.advanceTimersByTime(1);
      await drain();
      expect(JSON.stringify(door.turns[0]!.closed)).toContain("background work");
      expect(door.turns).toHaveLength(1);
    });

    test("a person's message mid-claim closes it after the decision in flight, and their turn owns the next one", async () => {
      let answer: ((decision: "accept") => void) | undefined;
      const door = claimDoor({ decide: () => new Promise((resolve) => { answer = resolve; }) });
      const { driver, held } = researcher();
      await run(driver, { sessionId: "session_912_person", session: door.hooks, onRequest: async () => "accept" }).result;
      jest.useFakeTimers();

      // A card is parked under the claim when the person writes.
      const parked = held.gate!("Bash", { command: "rm -rf build" }, asChild("toolu_c1"));
      await drain();
      expect(door.turns[0]!.requests).toHaveLength(1);
      door.turns[0]!.want.abort();
      await drain();
      // The card is not cut out from under the child waiting on it.
      expect(door.turns[0]!.closed).toBeUndefined();
      answer!("accept");
      await expect(parked).resolves.toEqual({ behavior: "allow" });
      await drain();
      // No linger: the session is somebody else's now.
      expect(door.turns[0]!.closed).toBeDefined();

      jest.useRealTimers();
      const inTurn: unknown[] = [];
      const second = run(driver, {
        sessionId: "session_912_person",
        session: door.hooks,
        onRequest: async (request: unknown) => {
          inTurn.push(request);
          return "accept";
        },
      });
      await expect(second.result).resolves.toMatchObject({ text: "yours" });
      expect(held.decidedInTurn).toEqual({ behavior: "allow" });
      expect(inTurn).toHaveLength(1);
      // Decided under the person's turn, not under a claim reopened beside it.
      expect(door.turns).toHaveLength(1);
    });
  });
});
