/**
 * WHAT A WARP CHILD IS ACTUALLY ASKED TO DO, pinned against a fake SDK.
 *
 * The runner's tests prove the SHAPE of a fan-out — concurrency, phases, the
 * dead-agent rule — with `spawn` stubbed out entirely. This file covers the
 * other side of that seam: the options a real child is launched with, and the
 * handshake that lets one be steered mid-flight. Nothing here spawns a process
 * or spends a token; the fake stands in for `query` and records what it was
 * handed.
 */
import { expect, test } from "bun:test";
import type { WarpSteer } from "../src/warp/runner";
import { createWarpSpawn, WARP_CHILD_DISALLOWED_TOOLS, type WarpSpawnSdk } from "../src/warp/spawn";

/** The runner's mailbox, in miniature — the same contract a real child sees. */
function mailbox(initial: string[] = []): WarpSteer & { post: (message: string) => void } {
  const buffer = [...initial];
  return {
    drain: () => buffer.splice(0, buffer.length),
    get pending() {
      return buffer.length;
    },
    post: (message: string) => void buffer.push(message),
  };
}

const success = (result: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  result,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
  ...extra,
});

/**
 * An SDK that answers each turn from a script.
 *
 * IT PULLS THE NEXT PROMPT ONLY AFTER YIELDING THE PREVIOUS RESULT, which is
 * both what a real streaming-input session does and — see the edge-triggered
 * test below — precisely the interleaving that a naive turn signal loses.
 */
function fakeSdk(answer: (turn: number, text: string) => Record<string, unknown>) {
  const seen: { options: Record<string, unknown>; turns: string[] } = { options: {}, turns: [] };
  const sdk: WarpSpawnSdk = {
    query({ prompt, options }) {
      seen.options = options;
      return {
        async *[Symbol.asyncIterator]() {
          if (typeof prompt === "string") {
            seen.turns.push(prompt);
            yield answer(0, prompt);
            return;
          }
          let turn = 0;
          for await (const message of prompt) {
            const text = String((message as { message: { content: unknown } }).message.content);
            seen.turns.push(text);
            yield answer(turn, text);
            turn += 1;
          }
        },
      };
    },
  };
  return { sdk, seen };
}

const call = (overrides: Partial<Parameters<ReturnType<typeof createWarpSpawn>>[0]> = {}) => ({
  taskId: "task_1",
  prompt: "find the bug",
  opts: {},
  signal: new AbortController().signal,
  steer: mailbox(),
  ...overrides,
});

test("an unsteered child takes exactly one turn", async () => {
  // The common path, and the one that must not pay for steering existing: the
  // mailbox is empty at the boundary, so the generator returns and the session
  // ends as an ordinary one-shot.
  const { sdk, seen } = fakeSdk(() => success("the bug is on line 12"));
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call());

  expect(seen.turns).toEqual(["find the bug"]);
  expect(outcome.text).toBe("the bug is on line 12");
  expect(outcome.failure).toBeUndefined();
  expect(outcome.usage?.tokens).toEqual({ input: 10, output: 4, cacheRead: 2, cacheCreate: 0 });
  expect(outcome.usage?.costUsd).toBe(0.01);
});

test("a message posted mid-turn becomes the child's next turn", async () => {
  /**
   * THE STEERING HANDSHAKE, end to end. The runner offers a mailbox; only the
   * spawn knows when a turn has SETTLED, because that is the SDK's news and not
   * the runner's — so the drain happens here, at the boundary, and anything
   * waiting becomes another turn.
   */
  const steer = mailbox();
  const { sdk, seen } = fakeSdk((turn) => success(turn === 0 ? "first pass done" : "narrowed to the parser"));
  const spawn = createWarpSpawn({ sdk, cwd: "/repo" });

  // Posted before the run so it is already waiting when the first turn settles,
  // which is exactly what a human pressing send during a long turn produces.
  steer.post("focus on the parser");
  const outcome = await spawn(call({ steer }));

  expect(seen.turns).toEqual(["find the bug", "focus on the parser"]);
  // THE LAST RESULT WINS: a steered child's answer is what it said last, not
  // what it said before it was redirected.
  expect(outcome.text).toBe("narrowed to the parser");
});

test("a turn that settles before the child looks is not lost", async () => {
  /**
   * THE EDGE-TRIGGERED COUNTER, and the deadlock it prevents.
   *
   * A generator suspended at `yield` is NOT yet waiting on the next boundary, so
   * the `result` message lands in a window where nothing is listening. A
   * level-triggered signal drops it; the generator then parks for ever, the SDK
   * waits for an input that never comes, and the child never returns — the same
   * deadlock the mailbox replaced a stream to kill, one layer down.
   *
   * The fake above reproduces that window naturally: it marks the boundary
   * before pulling again. Two turns arriving here is the proof it was caught.
   */
  const steer = mailbox(["and check the tests"]);
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({ sdk, cwd: "/repo" })(call({ steer }));
  expect(seen.turns).toHaveLength(2);
});

test("several messages queued during one turn arrive as one interruption", async () => {
  // They were said while a single turn was running, so they are one
  // interruption with several sentences rather than several redirections.
  const steer = mailbox(["check the tests", "and the fixtures"]);
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({ sdk, cwd: "/repo" })(call({ steer }));
  expect(seen.turns[1]).toBe("check the tests\n\nand the fixtures");
});

test("a child may not create work that outlives the run", async () => {
  /**
   * THE CONSTRAINT THE WHOLE DESIGN RESTS ON. Without it a four-agent warp is
   * four agents that may each spawn four more, and the runner's concurrency gate
   * — which is counting real processes on the user's machine — is counting the
   * wrong thing entirely.
   */
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({ sdk, cwd: "/repo" })(call());
  expect(seen.options.disallowedTools).toEqual([...WARP_CHILD_DISALLOWED_TOOLS]);
  // The four groups the rule covers, each named so a future edit that drops one
  // has to say so out loud. Measured off a real child's `system/init`.
  for (const tool of ["Agent", "Task", "Workflow"]) expect(WARP_CHILD_DISALLOWED_TOOLS).toContain(tool);
  for (const tool of ["CronCreate", "ScheduleWakeup"]) expect(WARP_CHILD_DISALLOWED_TOOLS).toContain(tool);
  for (const tool of ["SendMessage", "ListAgents", "PushNotification"]) expect(WARP_CHILD_DISALLOWED_TOOLS).toContain(tool);
  // A child cutting its own worktree would scatter a fan-out's writes — the very
  // diff that removing `isolation` from the authoring surface was meant to stop.
  for (const tool of ["EnterWorktree", "ExitWorktree"]) expect(WARP_CHILD_DISALLOWED_TOOLS).toContain(tool);
});

test("the session is inherited and the call overrides it", async () => {
  // `DriverRun.model`'s rule, one level down: absent means the provider's own
  // default, so a script that names nothing must not have a name invented for
  // it — but a script that names one must get exactly that one.
  const { sdk, seen } = fakeSdk(() => success("done"));
  const spawn = createWarpSpawn({ sdk, cwd: "/repo", model: "claude-sonnet-5", effort: "medium", fastMode: true });

  await spawn(call());
  expect(seen.options.model).toBe("claude-sonnet-5");
  expect(seen.options.effort).toBe("medium");
  expect(seen.options.settings).toEqual({ fastMode: true });

  await spawn(call({ opts: { model: "claude-opus-5", effort: "max" } }));
  expect(seen.options.model).toBe("claude-opus-5");
  expect(seen.options.effort).toBe("max");
});

test("an effort word the SDK has never heard of is dropped, not forwarded", async () => {
  // `Effort` is an OPEN string in the contract because provider vocabularies
  // differ; failing a child over a display-level nicety is the worse trade.
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({ sdk, cwd: "/repo" })(call({ opts: { effort: "ludicrous" } }));
  expect(seen.options.effort).toBeUndefined();
});

test("a schema is forwarded as an output format and comes back structured", async () => {
  // This is what makes a fan-out composable: the stage between two agents
  // becomes ordinary code rather than another agent hired to read paragraphs.
  const schema = { type: "object", properties: { bugs: { type: "array" } } };
  const { sdk, seen } = fakeSdk(() => success("{}", { structured_output: { bugs: ["one"] } }));
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call({ opts: { schema } }));

  expect(seen.options.outputFormat).toEqual({ type: "json_schema", schema });
  expect(outcome.structured).toEqual({ bugs: ["one"] });
});

test("an agent type reaches the SDK's own main-thread option", async () => {
  // Applied to the MAIN thread rather than by spawning one, because a warp child
  // may not use the Agent tool at all — same registry, no fan-out.
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({ sdk, cwd: "/repo" })(call({ opts: { agentType: "code-reviewer" } }));
  expect(seen.options.agent).toBe("code-reviewer");
});

test("an error result is a dead agent carrying its reason", async () => {
  const { sdk } = fakeSdk(() => ({ type: "result", subtype: "error_during_execution", errors: ["ran out of context"] }));
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call());
  expect(outcome.failure).toBe("ran out of context");
  expect(outcome.text).toBeUndefined();
});

test("a steered child that failed one turn can recover on the next", async () => {
  // Which is why the last result decides rather than the first failure: a child
  // told "you misread the file" must be able to come back with the right answer.
  const steer = mailbox(["you misread the file"]);
  const { sdk } = fakeSdk((turn) =>
    turn === 0 ? { type: "result", subtype: "error_during_execution", errors: ["gave up"] } : success("got it"),
  );
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call({ steer }));
  expect(outcome.failure).toBeUndefined();
  expect(outcome.text).toBe("got it");
});

test("a stop is reported as stopped, not as the child's failure", async () => {
  /**
   * The human pressed Stop. The runner is already unwinding the script and will
   * mark the row `stopped`; a row that read "AbortError" here would blame the
   * child for something the human did on purpose.
   */
  const controller = new AbortController();
  const sdk: WarpSpawnSdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          controller.abort(new Error("turn stopped"));
          throw new Error("AbortError: the operation was aborted");
          // eslint-disable-next-line no-unreachable
          yield {};
        },
      };
    },
  };
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call({ signal: controller.signal }));
  expect(outcome.failure).toBe("stopped");
});

test("a stream that ends with no result at all is a failure, not an empty success", async () => {
  // An agent that returned nothing has not answered; treating that as success
  // hands the script an empty string it will happily build on.
  const sdk: WarpSpawnSdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant" };
        },
      };
    },
  };
  const outcome = await createWarpSpawn({ sdk, cwd: "/repo" })(call());
  expect(outcome.failure).toBe("the agent ended without a result");
});

test("the login's environment and binary are what the child actually runs", async () => {
  // A pane that described one binary while another answered is the failure
  // `cli-resolution.ts` exists to prevent; a warp child must not reintroduce it.
  const { sdk, seen } = fakeSdk(() => success("done"));
  await createWarpSpawn({
    sdk,
    cwd: "/repo",
    env: { CLAUDE_CONFIG_DIR: "/tmp/login-a" },
    executable: "/opt/claude/bin/claude",
  })(call());

  expect(seen.options.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
  expect((seen.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/tmp/login-a");
  // Overlaid on this process's own, never replacing it — the SDK's option means
  // "the subprocess environment", so a bare patch would strip PATH and HOME.
  expect((seen.options.env as Record<string, string>).PATH).toBe(process.env.PATH!);
});
