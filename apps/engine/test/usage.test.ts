import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsageReport } from "../src/usage";

const roots: string[] = [];
const tmp = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const TOKENS = { input: 10, output: 20, cacheRead: 100, cacheCreate: 5 };

function seedSession(
  root: string,
  id: string,
  input: {
    driver?: string;
    model?: string;
    turns?: { runId: string; model?: string }[];
    events: Record<string, unknown>[];
  },
): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({ id, driver: input.driver ?? "claude", ...(input.model ? { model: { instanceId: "x", model: input.model } } : {}) }),
  );
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify({ turns: (input.turns ?? []).map((turn) => ({ runId: turn.runId, ...(turn.model ? { model: { model: turn.model } } : {}) })) }));
  fs.writeFileSync(path.join(dir, "events.ndjson"), input.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

const WINDOW = { sinceMs: 0, untilMs: 10_000_000, resolution: "day" as const, timeZone: "UTC" };

test("a completed turn's final usage lands in a bucket with its model and cost", () => {
  const root = tmp();
  seedSession(root, "session_one", {
    turns: [{ runId: "run_1", model: "sonnet" }],
    events: [
      { type: "usage.updated", runId: "run_1", at: 1000, usage: { tokens: { ...TOKENS, output: 1 } } },
      { type: "turn.completed", runId: "run_1", at: 2000, usage: { tokens: TOKENS, costUsd: 0.5 } },
    ],
  });
  const report = readUsageReport(root, WINDOW);
  expect(report.buckets).toHaveLength(1);
  expect(report.buckets[0]).toMatchObject({ driver: "claude", model: "sonnet", costUsd: 0.5, priced: true, turns: 1, period: "1970-01-01" });
  expect(report.buckets[0]!.tokens).toEqual(TOKENS);
  expect(report.sessions).toBe(1);
});

test("an aborted turn counts its last snapshot; a settled one is never overwritten by a late snapshot", () => {
  const root = tmp();
  seedSession(root, "session_one", {
    events: [
      // run_a never completes: the LAST snapshot is its floor.
      { type: "usage.updated", runId: "run_a", at: 1000, usage: { tokens: { ...TOKENS, output: 1 } } },
      { type: "usage.updated", runId: "run_a", at: 1500, usage: { tokens: { ...TOKENS, output: 7 } } },
      // run_b completes, then a straggler snapshot arrives.
      { type: "turn.completed", runId: "run_b", at: 2000, usage: { tokens: TOKENS, costUsd: 1 } },
      { type: "usage.updated", runId: "run_b", at: 2100, usage: { tokens: { ...TOKENS, output: 999 } } },
    ],
  });
  const report = readUsageReport(root, WINDOW);
  const [bucket] = report.buckets;
  expect(report.buckets).toHaveLength(1);
  expect(bucket!.turns).toBe(2);
  expect(bucket!.tokens.output).toBe(7 + TOKENS.output);
  // run_a carried no cost, so the bucket is honest about being partial.
  expect(bucket!.priced).toBe(false);
  expect(bucket!.costUsd).toBe(1);
  // No per-turn model anywhere: the default label, never a guess.
  expect(bucket!.model).toBe("default");
});

test("the window bounds and hourly resolution bucket by hour start", () => {
  const root = tmp();
  seedSession(root, "session_one", {
    events: [
      { type: "turn.completed", runId: "run_in", at: 3_600_000 + 60_000, usage: { tokens: TOKENS, costUsd: 1 } },
      { type: "turn.completed", runId: "run_out", at: 99_999_999, usage: { tokens: TOKENS, costUsd: 1 } },
    ],
  });
  const report = readUsageReport(root, { ...WINDOW, resolution: "hour" });
  expect(report.buckets).toHaveLength(1);
  expect(report.buckets[0]!.period).toBe(String(3_600_000));
});

test("malformed lines, foreign files and a missing directory cost nothing", () => {
  const root = tmp();
  seedSession(root, "session_one", {
    events: [{ type: "turn.completed", runId: "run_1", at: 1000, usage: { tokens: TOKENS } }],
  });
  fs.appendFileSync(path.join(root, "session_one", "events.ndjson"), "not json\n{\"type\":\"turn.completed\"}\n");
  fs.writeFileSync(path.join(root, "stray-file"), "not a session dir");
  fs.mkdirSync(path.join(root, "session_empty"));
  expect(readUsageReport(root, WINDOW).buckets).toHaveLength(1);
  expect(readUsageReport(path.join(root, "does-not-exist"), WINDOW).buckets).toHaveLength(0);
});

describe("the scan cache", () => {
  test("an appended journal is re-read; an untouched one is not re-parsed wrongly", () => {
    const root = tmp();
    seedSession(root, "session_one", {
      events: [{ type: "turn.completed", runId: "run_1", at: 1000, usage: { tokens: TOKENS, costUsd: 1 } }],
    });
    expect(readUsageReport(root, WINDOW).buckets[0]!.turns).toBe(1);
    fs.appendFileSync(
      path.join(root, "session_one", "events.ndjson"),
      JSON.stringify({ type: "turn.completed", runId: "run_2", at: 1500, usage: { tokens: TOKENS, costUsd: 1 } }) + "\n",
    );
    expect(readUsageReport(root, WINDOW).buckets[0]!.turns).toBe(2);
  });
});
