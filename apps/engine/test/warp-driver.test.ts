/**
 * WARP, WIRED — the tool the directing agent actually calls.
 *
 * The runner's tests prove a fan-out's shape with `spawn` stubbed; the spawn's
 * tests prove a child's options with the SDK faked. This file joins them: the
 * driver builds Telar's MCP server, the fake model calls `warp` on it, the
 * script's children come back through the SAME fake SDK, and the rows land on
 * the turn's observation stream where the cockpit and the engine read them.
 *
 * Nothing here spawns a process or spends a token.
 */
import { expect, test } from "bun:test";
import { TaskSeed, type TurnObservation } from "@telar/engine-client";
import { createClaudeDriver } from "../src/driver";
import { WARP_CHILD_DISALLOWED_TOOLS } from "../src/warp/spawn";

type FakeTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};

/**
 * An SDK whose main turn calls `warp` once, and whose children answer from a
 * script keyed by their prompt.
 *
 * ONE `query` SERVES BOTH, which is the point: a warp child goes through the
 * same SDK entry point the turn does, and the branch below is the only thing
 * that tells them apart — `disallowedTools`, which the spawn sets and the turn
 * never does.
 */
function warpSdk(input: { script: string; args?: unknown; child?: (prompt: string) => string }) {
  const registered: { tools: FakeTool[] } = { tools: [] };
  const childOptions: Array<Record<string, unknown>> = [];
  let toolResult: { content: Array<{ text?: string }>; isError?: boolean } | undefined;

  const sdk = {
    tool: (name: string, description: string, inputSchema: Record<string, unknown>, handler: FakeTool["handler"]) =>
      ({ name, description, inputSchema, handler }) satisfies FakeTool,
    createSdkMcpServer: ({ tools }: { tools: unknown[] }) => {
      registered.tools = tools as FakeTool[];
      return { tools };
    },
    async *query(query: { prompt: unknown; options: Record<string, unknown> }) {
      // ── a warp child ────────────────────────────────────────────────────
      if (query.options.disallowedTools) {
        childOptions.push(query.options);
        let prompt = "";
        if (typeof query.prompt === "string") prompt = query.prompt;
        else {
          for await (const message of query.prompt as AsyncIterable<{ message: { content: unknown } }>) {
            prompt = String(message.message.content);
            break;
          }
        }
        yield {
          type: "result",
          subtype: "success",
          result: input.child ? input.child(prompt) : `answered: ${prompt}`,
          usage: { input_tokens: 5, output_tokens: 2 },
        };
        return;
      }

      // ── the main turn ───────────────────────────────────────────────────
      const warp = registered.tools.find((tool) => tool.name === "warp");
      if (!warp) throw new Error("the driver registered no `warp` tool");
      toolResult = await warp.handler({ script: input.script, ...(input.args === undefined ? {} : { args: input.args }) });
      yield { type: "assistant", message: { content: [{ type: "text", text: "the warp is done" }] } };
      yield { type: "result", subtype: "success" };
    },
  };

  return {
    sdk,
    registered,
    childOptions,
    /** What the model got back from `warp`, parsed. */
    result: () => JSON.parse(toolResult?.content[0]?.text ?? "{}") as Record<string, unknown>,
    isError: () => toolResult?.isError === true,
  };
}

async function drive(fake: ReturnType<typeof warpSdk>, extra: Record<string, unknown> = {}) {
  const observations: TurnObservation[] = [];
  const driver = createClaudeDriver(async () => fake.sdk as never, { resolveExecutable: () => "/fake/bin/claude" });
  await driver.run({
    prompt: "fan this out",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async (batch) => void observations.push(...batch),
    ...extra,
  });
  return observations;
}

/** Every task row the turn reported, in order. */
const tasks = (observations: TurnObservation[]) =>
  observations.filter((o): o is Extract<TurnObservation, { task: unknown }> => "task" in o);

const META = `export const meta = { name: "demo", description: "a demo" };\n`;

test("warp is offered even when the session has no browser", async () => {
  /**
   * THE REASON THE BROWSER BUILDER RETURNS TOOLS RATHER THAN A SERVER. Telar
   * has more than one capability and there is exactly one server for all of
   * them; while the browser was what constructed it, a session without a browser
   * scope silently had no Telar tools at all.
   */
  const fake = warpSdk({ script: `${META}return "done";` });
  await drive(fake);
  expect(fake.registered.tools.map((tool) => tool.name)).toEqual(["warp"]);
});

test("a run and its agents land on the turn's own task stream", async () => {
  const fake = warpSdk({
    script: `${META}
      phase("Scan");
      const found = await parallel([() => agent("read the logs"), () => agent("read the config")]);
      return found.length;
    `,
  });
  const rows = tasks(await drive(fake, { providerInstanceId: "claude-default" }));

  // THE STRUCTURAL BET: the run is a background task, its agents are parented
  // to it, and nothing else was invented to hold either.
  const run = rows.find((row) => row.task.kind === "background")!;
  expect(run.kind).toBe("task.started");
  expect(run.task.title).toBe("demo");

  const agents = rows.filter((row) => row.task.kind === "agent");
  expect(new Set(agents.map((row) => row.task.parentTaskId))).toEqual(new Set([run.task.id]));
  expect(new Set(agents.map((row) => row.task.warp?.phaseTitle))).toEqual(new Set(["Scan"]));

  // Announced once, settled once — a client folding these must not see two
  // starts for one agent, or a completion for something it never saw start.
  const perId = new Map<string, string[]>();
  for (const row of rows) perId.set(row.task.id, [...(perId.get(row.task.id) ?? []), row.kind]);
  for (const [, kinds] of perId) {
    expect(kinds.filter((kind) => kind === "task.started")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("task.completed");
  }

  // And every row is something the engine will actually accept.
  for (const row of rows) expect(TaskSeed.safeParse(row.task).success).toBe(true);
});

test("the script's return value is what the directing agent gets back", async () => {
  const fake = warpSdk({
    script: `${META}
      const answers = await pipeline(["a", "b"], (item) => agent("study " + item));
      return { answers, count: answers.length };
    `,
    child: (prompt) => prompt.replace("study ", "studied "),
  });
  await drive(fake);

  const result = fake.result();
  expect(fake.isError()).toBe(false);
  expect(result.state).toBe("completed");
  expect(result.agents).toEqual({ total: 2, failed: 0 });
  expect(result.result).toEqual({ answers: ["studied a", "studied b"], count: 2 });
});

test("args reach the script verbatim", async () => {
  const fake = warpSdk({ script: `${META}return args.map((n) => n * 2);`, args: [1, 2, 3] });
  await drive(fake);
  expect(fake.result().result).toEqual([2, 4, 6]);
});

test("a script that cannot work is refused before a runId exists", async () => {
  /**
   * COMPILE BEFORE SPEND, end to end. The refusal is addressed to the AUTHOR —
   * kind, detail, line — and it must arrive with nothing having been started,
   * because the whole value of a synchronous check is that it happens before
   * agent 1 of 60 rather than after agent 39.
   */
  const fake = warpSdk({ script: `${META}const now = Date.now();\nawait agent("never runs");` });
  const rows = tasks(await drive(fake));

  expect(fake.isError()).toBe(true);
  expect(fake.result()).toMatchObject({ kind: "banned-identifier", detail: "Date", line: 2 });
  expect(rows).toHaveLength(0);
});

test("a child is launched with the session's own binary and may not fan out", async () => {
  const fake = warpSdk({ script: `${META}await agent("do the thing");` });
  await drive(fake, { binaryPath: "/opt/claude/bin/claude", model: "claude-sonnet-5" });

  expect(fake.childOptions).toHaveLength(1);
  const child = fake.childOptions[0]!;
  expect(child.disallowedTools).toEqual([...WARP_CHILD_DISALLOWED_TOOLS]);
  expect(child.model).toBe("claude-sonnet-5");
  // The resolver injected by this suite answers for every path, so what is
  // asserted here is that the child asks it at all rather than defaulting to
  // the ~272MB package the SDK would otherwise resolve for itself.
  expect(child.pathToClaudeCodeExecutable).toBe("/fake/bin/claude");
});

test("Telar's own server is withheld from a child, so a warp cannot recurse", async () => {
  // A child that could call `warp` would fan out without bound, and four
  // children sharing one browser scope would fight over the same tabs.
  const fake = warpSdk({ script: `${META}await agent("do the thing");` });
  await drive(fake, { browserScopeKey: "session-1" });
  expect(fake.childOptions[0]!.mcpServers).toBeUndefined();
});

test("a dead child fails its row and is named in the result, without losing the run", async () => {
  const fake = warpSdk({
    script: `${META}
      const found = await parallel([() => agent("good one"), () => agent("bad one")]);
      return found;
    `,
    child: (prompt) => {
      if (prompt.includes("bad")) throw new Error("the child died");
      return "fine";
    },
  });
  const rows = tasks(await drive(fake));

  const failedRow = rows.find((row) => row.task.state === "failed");
  expect(failedRow?.task.title).toBe("bad one");
  // `.filter(Boolean)` is the documented idiom precisely because this is null.
  expect(fake.result().result).toEqual(["fine", null]);
  // NAMED, NOT COUNTED: which one and why is what decides whether to re-run.
  expect(fake.result().failures).toEqual([{ label: "bad one", failure: "the child died" }]);
});

test("a row still in flight is not lost when the turn ends", async () => {
  /**
   * THE HAZARD A FAN-OUT INTRODUCED, and it took instrumenting the delivery
   * order to see what it actually was.
   *
   * The main loop only ever ran `emit(); await flush();` in sequence, so a plain
   * async `flush` was enough. A warp child cannot await its own report — that
   * would serialise the whole fan-out behind one HTTP round trip each — so
   * reports are in flight while the run continues. Unchained, the end-of-turn
   * `await flush()` waits only for whatever is in `pending` AT THAT MOMENT and
   * knows nothing about the calls still resolving: the turn returns, the worker
   * settles it, and a row that was mid-report is DROPPED.
   *
   * Measured, with the first report slowed to 20ms: the run's own `task.started`
   * never arrived, leaving agents parented to a run the engine never saw begin.
   * Not a reordering — a loss. Chaining fixes it because the final `await
   * flush()` now sits at the end of the same chain.
   */
  const delivered: string[] = [];
  let reports = 0;
  const fake = warpSdk({ script: `${META}await agent("only one");` });
  const driver = createClaudeDriver(async () => fake.sdk as never, { resolveExecutable: () => "/fake/bin/claude" });
  await driver.run({
    prompt: "fan this out",
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async (batch) => {
      // The FIRST report is the slow one — it carries the run's start row, and
      // it is the one an unchained flush leaves behind.
      await new Promise((resolve) => setTimeout(resolve, reports++ === 0 ? 20 : 0));
      for (const observation of batch) {
        if ("task" in observation) delivered.push(`${observation.task.title}:${observation.task.state}`);
      }
    },
  });

  expect(delivered).toEqual([
    "demo:running",
    "only one:pending",
    "only one:running",
    "only one:completed",
    "demo:completed",
  ]);
});

test("stopping the turn stops the fan-out and says so", async () => {
  /**
   * Without this the turn settles while the children keep spending — the run
   * blocks the tool call, so a stop that reached only the outer query would
   * leave a fleet running with nothing left on screen to stop it.
   */
  const controller = new AbortController();
  const fake = warpSdk({
    script: `${META}await agent("first"); await agent("second");`,
    child: (prompt) => {
      if (prompt.includes("first")) controller.abort(new Error("turn stopped"));
      return "fine";
    },
  });
  const observations: TurnObservation[] = [];
  const driver = createClaudeDriver(async () => fake.sdk as never, { resolveExecutable: () => "/fake/bin/claude" });
  await driver
    .run({
      prompt: "fan this out",
      cwd: "/tmp",
      signal: controller.signal,
      onObservations: async (batch) => void observations.push(...batch),
    })
    .catch(() => undefined);

  expect(fake.result().state).toBe("stopped");
  expect(fake.isError()).toBe(true);
  // The second agent never reached the gate, so it was never announced at all.
  expect(fake.childOptions).toHaveLength(1);
});
