import { describe, expect, test } from "bun:test";
import { createClaudeDriver, run } from "../../../test/claude-harness";

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

describe("cost is the turn's, out of the query's running total", () => {
  /** Three turns down one live query, with the running totals the SDK reports. */
  const driverReporting = (totals: (number | undefined)[]) => {
    let turn = 0;
    return createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        for await (const message of prompt) {
          void message;
          const total = totals[turn++];
          yield {
            type: "result",
            subtype: "success",
            ...(total === undefined ? {} : { total_cost_usd: total }),
            usage: { input_tokens: 10, output_tokens: 2 },
          };
        }
      },
    }) as never);
  };
  const costsOf = async (driver: ReturnType<typeof createClaudeDriver>, turns: number) => {
    const out: (number | undefined)[] = [];
    for (let index = 0; index < turns; index += 1) {
      out.push((await run(driver, { sessionId: "session_costed" }).result).usage?.costUsd);
    }
    return out;
  };

  test("cumulative totals become per-turn deltas, so the sum is the query's spend", async () => {
    const costs = await costsOf(driverReporting([0.1, 0.3, 0.35]), 3);
    expect(costs).toEqual([0.1, 0.2, 0.05]);
    expect(costs.reduce((sum, cost) => sum! + cost!, 0)).toBeCloseTo(0.35, 10);
  });

  test("a crash-zeroed result preserves the running total instead of erasing it", async () => {
    // "Crash/startup-error results may carry zeroed values" — so zero is no
    // information, never "this query has spent nothing since".
    const costs = await costsOf(driverReporting([0.1, 0, 0.3]), 3);
    expect(costs).toEqual([0.1, undefined, 0.2]);
  });

  test("a total that drops below the baseline is a new epoch, and all of it is this turn's", async () => {
    // A mid-session /clear resets the running total; a resumed session starts
    // fresh. Subtracting the old baseline would report a negative price.
    expect(await costsOf(driverReporting([0.3, 0.05, 0.09]), 3)).toEqual([0.3, 0.05, 0.04]);
  });

  test("a provider that reports no cost at all reports none — not $0.00", async () => {
    // Claude omits cost on subscription plans.
    expect(await costsOf(driverReporting([undefined, undefined]), 2)).toEqual([undefined, undefined]);
  });

  test("a cold start resets the baseline, because a new process is a new query", async () => {
    let queries = 0;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: AsyncIterable<unknown> }) {
        const mine = (queries += 1);
        for await (const message of prompt) {
          void message;
          yield { type: "result", subtype: "success", total_cost_usd: mine === 1 ? 0.4 : 0.05, usage: { input_tokens: 1, output_tokens: 1 } };
        }
      },
    }) as never);
    const first = await run(driver, { sessionId: "session_cold", cwd: "/tmp" }).result;
    // A different cwd is a different fingerprint: the process is replaced, and
    // the new query's total starts from its own zero rather than from $0.40.
    const second = await run(driver, { sessionId: "session_cold", cwd: "/tmp/elsewhere" }).result;
    expect(queries).toBe(2);
    expect([first.usage?.costUsd, second.usage?.costUsd]).toEqual([0.4, 0.05]);
  });
});

test("the meter moves DURING a turn: each assistant envelope emits usage, with context occupancy", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 } },
      };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 200, cache_creation_input_tokens: 3 } },
      };
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 22, output_tokens: 6 },
        modelUsage: {
          "claude-sonnet-5": { contextWindow: 200_000, inputTokens: 22 },
          "claude-haiku-4-5": { contextWindow: 100_000, inputTokens: 4 },
        },
      };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const usages = sink.observations.filter((o) => o.kind === "usage");
  // One per envelope plus the result — this is what lets the ring move mid-turn.
  expect(usages).toHaveLength(3);
  // Occupancy is the NEWEST message's input+cacheRead+cacheCreate+output.
  expect(usages[0]?.kind === "usage" && usages[0].usage.contextUsed).toBe(115);
  expect(usages[1]?.kind === "usage" && usages[1].usage.contextUsed).toBe(219);
  // THE PROVIDER'S OWN WINDOW, not an assumption: the main loop's 200k is what
  // the meter says, and the sidechain's smaller table entry does not win.
  const last = usages[2];
  expect(last?.kind === "usage" && last.usage.contextMax).toBe(200_000);
  expect(last?.kind === "usage" && last.usage.contextUsed).toBe(219);
  // Tokens still come from the result's own usage, never from modelUsage.
  expect(last?.kind === "usage" && last.usage.tokens.input).toBe(22);
});

test("message_delta carries the response's REAL output count; the envelope's was a placeholder", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 } },
      };
      yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 812 } } };
      yield { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 812 } };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const usages = sink.observations.flatMap((o) => (o.kind === "usage" ? [o.usage] : []));
  // Envelope, correction, result.
  expect(usages).toHaveLength(3);
  expect(usages[0]?.tokens.output).toBe(2);
  expect(usages[1]?.tokens.output).toBe(812);
  // Occupancy follows: input + cache reads + cache writes + the REAL output.
  expect(usages[1]?.contextUsed).toBe(925);
  // Everything else on the envelope is preserved rather than replaced.
  expect(usages[1]?.tokens).toMatchObject({ input: 10, cacheRead: 100, cacheCreate: 3 });
});

test("a message_delta before any envelope, or from a sub-agent, moves nothing", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      // No envelope yet: nothing to correct, and inventing a record would
      // report an occupancy with no input or cache counts at all.
      yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 99 } } };
      // A sub-agent's output is reported on its own task, never the parent's.
      yield { type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 10, output_tokens: 2 } } };
      yield { type: "stream_event", parent_tool_use_id: "use_child", event: { type: "message_delta", usage: { output_tokens: 500 } } };
      yield { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 2 } };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const usages = sink.observations.flatMap((o) => (o.kind === "usage" ? [o.usage] : []));
  expect(usages.map((usage) => usage.tokens.output)).toEqual([2, 2]);
});

test("the meter assumes 1M only for an explicit [1m] row, and the provider's report corrects it either way", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 400_000, output_tokens: 2 } },
      };
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 400_000, output_tokens: 2 },
        modelUsage: { "claude-fable-5-1": { contextWindow: 200_000, inputTokens: 400_000 } },
      };
    },
  }));
  const selected = run(driver, { model: "claude-fable-5-1[1m]" });
  await selected.result;
  const selectedUsages = selected.sink.observations.filter((o) => o.kind === "usage");
  // Before the provider speaks, an explicit [1m] row is assumed 1M so the
  // ring has a denominator on the first envelope…
  expect(selectedUsages[0]?.kind === "usage" && selectedUsages[0].usage.contextMax).toBe(1_000_000);
  // …and the provider's own report corrects it DOWN when it disagrees.
  const selectedUsage = selectedUsages.at(-1);
  expect(selectedUsage?.kind === "usage" && selectedUsage.usage.contextMax).toBe(200_000);
  expect(selectedUsage?.kind === "usage" && selectedUsage.usage.contextUsed).toBe(400_002);

  // A bare id or no model assumes nothing until the provider reports.
  for (const extra of [{}, { model: "opus" }, { model: "claude-opus-5" }]) {
    const bare = run(driver, extra);
    await bare.result;
    const usages = bare.sink.observations.filter((o) => o.kind === "usage");
    expect(usages[0]?.kind === "usage" && usages[0].usage.contextMax).toBeUndefined();
    expect(usages.at(-1)?.kind === "usage" && usages.at(-1)!.usage.contextMax).toBe(200_000);
  }
});

test("compaction is a timeline row, not a dropped message", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "status", status: "compacting" };
      yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 12_000 } };
      yield { type: "system", subtype: "status", status: null, compact_result: "success" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.filter((o) => o.kind === "item.started");
  expect(started).toHaveLength(1);
  const updated = sink.observations.find((o) => o.kind === "item.updated");
  expect(
    updated?.kind === "item.updated" && updated.item.detail.type === "context_compaction" && updated.item.detail,
  ).toMatchObject({ reason: "auto", preTokens: 150_000, postTokens: 12_000 });
  const completed = sink.observations.find((o) => o.kind === "item.completed");
  expect(completed?.kind === "item.completed" && completed.status).toBe("completed");
});

test("a boundary with no announcement still produces a row, and an unfinished compaction closes failed", async () => {
  // Auto-compaction may emit only the boundary; and a stream that ends inside
  // a compaction must not leave the row spinning forever.
  const boundaryOnly = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 9, post_tokens: 3 } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const first = run(boundaryOnly);
  await first.result;
  const row = first.sink.observations.find((o) => o.kind === "item.started");
  expect(row?.kind === "item.started" && row.item.detail.type).toBe("context_compaction");
  const closed = first.sink.observations.find((o) => o.kind === "item.completed");
  expect(closed?.kind === "item.completed" && closed.status).toBe("completed");

  const unfinished = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "status", status: "compacting" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const second = run(unfinished);
  await second.result;
  const swept = second.sink.observations.find((o) => o.kind === "item.completed");
  expect(swept?.kind === "item.completed" && swept.status).toBe("failed");

  // Announced, succeeded, but the boundary never came: the turn's end closes
  // the row as what the CLI said it was — completed, not failed.
  const unmeasured = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "status", status: "compacting" };
      yield { type: "system", subtype: "status", status: null, compact_result: "success" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const third = run(unmeasured);
  await third.result;
  const closedByTurn = third.sink.observations.filter((o) => o.kind === "item.completed");
  expect(closedByTurn).toHaveLength(1);
  expect(closedByTurn[0]?.kind === "item.completed" && closedByTurn[0].status).toBe("completed");
});
