import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../../platform/db/execution-store";
import { buildUsageDigest } from "./digest";
import type { RatesTable } from "./pricing";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const HOUR = 3_600_000;
const RATES: RatesTable = { status: "fresh", rates: new Map([["claude-sonnet-5", { inputPerTok: 3e-6, outputPerTok: 1.5e-5, cacheReadPerTok: 3e-7, cacheCreatePerTok: 3.75e-6 }]]) };

const roots: string[] = [];
const stores: ExecutionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-digest-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const store = new ExecutionStore(root);
  stores.push(store);
  const session = (id: string, doc: Record<string, unknown>) =>
    store.write(path.join(root, "sessions", id, "session.json"), { id, title: `Private title ${id}`, driver: "claude", createdAt: NOW - 40 * 24 * HOUR, ...doc });
  let sequence = 0;
  const turn = (sessionId: string, endedAt: number, tokens: { cacheRead: number; input?: number; output?: number }, origin = "user") => {
    const runId = `run_${++sequence}`;
    store
      .statement(
        `INSERT INTO turn_summaries (session_id, run_id, sequence, origin, state, started_at, ended_at, usage_input, usage_output, usage_cache_read, usage_cache_create, usage_reasoning, usage_rows)
         VALUES (?,?,?,?,'completed',?,?,?,?,?,0,0,1)`,
      )
      .run(sessionId, runId, sequence, origin, endedAt - 1000, endedAt, tokens.input ?? 100, tokens.output ?? 50, tokens.cacheRead);
    return runId;
  };
  const item = (sessionId: string, runId: string, value: unknown) =>
    store.statement("INSERT INTO items (session_id, item_id, run_id, ord, value) VALUES (?,?,?,?,?)").run(sessionId, `item_${++sequence}`, runId, sequence, JSON.stringify(value));
  return { store, session, turn, item };
}

const digestOf = (store: ExecutionStore) => buildUsageDigest({ db: store, now: NOW, rates: RATES, providerLogs: [], config: { orientation: true }, projectName: (id) => `Project ${id}` });

test("ranks sessions by tokens under anonymous ids and keeps their titles out of the digest", () => {
  const { store, session, turn } = fixture();
  session("session_big", { projectId: "project_secret", model: { instanceId: "claude", model: "claude-sonnet-5" } });
  session("session_small", {});
  for (let index = 0; index < 3; index += 1) turn("session_big", NOW - HOUR, { cacheRead: 1_000_000 });
  turn("session_small", NOW - HOUR, { cacheRead: 10 });

  const { digest, names } = digestOf(store);

  expect(digest.topSessions.map((entry) => entry.id)).toEqual(["s1", "s2"]);
  expect(digest.topSessions[0]).toMatchObject({ project: "p1", model: "claude-sonnet-5", turns: 3 });
  expect(digest.windows["24h"].totals.turns).toBe(4);
  expect(digest.windows["30d"].totals.cacheHit).toBeGreaterThan(0.99);
  expect(digest.windows["30d"].totals.costUsd).toBeGreaterThan(0);
  expect(names).toMatchObject({ s1: "Private title session_big", p1: "Project project_secret" });
  const text = JSON.stringify(digest);
  expect(text).not.toContain("session_big");
  expect(text).not.toContain("Private title");
  expect(text).not.toContain("project_secret");
});

test("windows count only turns that ended inside them", () => {
  const { store, session, turn } = fixture();
  session("session_one", {});
  turn("session_one", NOW - 2 * HOUR, { cacheRead: 1 });
  turn("session_one", NOW - 3 * 24 * HOUR, { cacheRead: 1 });
  turn("session_one", NOW - 20 * 24 * HOUR, { cacheRead: 1 });
  turn("session_one", NOW - 60 * 24 * HOUR, { cacheRead: 1 });

  const { digest } = digestOf(store);

  expect([digest.windows["24h"].totals.turns, digest.windows["7d"].totals.turns, digest.windows["30d"].totals.turns]).toEqual([1, 2, 3]);
});

test("folds builders into their orchestrator's tree and flags opus builders", () => {
  const { store, session, turn } = fixture();
  session("session_root", {});
  for (const id of ["session_a", "session_b"]) {
    session(id, { startedFrom: { sessionId: "session_root" }, model: { instanceId: "claude", model: "claude-opus-5[1m]" } });
    turn(id, NOW - HOUR, { cacheRead: 500_000 });
  }
  turn("session_root", NOW - HOUR, { cacheRead: 1000 }, "session");

  const { digest } = digestOf(store);

  expect(digest.trees).toHaveLength(1);
  expect(digest.trees[0]).toMatchObject({ sessions: 3, depth: 1 });
  expect(digest.topSessions.find((entry) => entry.model.includes("opus"))).toMatchObject({ startedBy: expect.stringMatching(/^s\d$/), longContext: true });
  expect(digest.signals.map((signal) => signal.id)).toEqual(expect.arrayContaining(["opus_builders", "long_context_window", "cache_read_dominant"]));
});

test("counts compactions, provider waits and oversized tool outputs per session", () => {
  const { store, session, turn, item } = fixture();
  session("session_one", {});
  const runId = turn("session_one", NOW - HOUR, { cacheRead: 10 });
  item("session_one", runId, { detail: { type: "context_compaction" } });
  item("session_one", runId, { detail: { type: "provider_wait", wait: { kind: "rate_limit" } } });
  item("session_one", runId, { detail: { type: "command_execution", output: "x".repeat(60_000) } });

  const [only] = digestOf(store).digest.topSessions;

  expect(only).toMatchObject({ compactions: 1, largeToolOutputs: 1, providerWaits: { rateLimit: 1, apiRetry: 0 } });
});

test("reports schedules with their period and leaves diagnosis sessions out", () => {
  const { store, session, turn } = fixture();
  session("session_cron", {});
  session("session_diagnosis", { purpose: "usage-diagnosis" });
  turn("session_cron", NOW - HOUR, { cacheRead: 10 }, "schedule");
  turn("session_diagnosis", NOW - HOUR, { cacheRead: 9_999_999 });
  store
    .statement("INSERT INTO schedules (id, session_id, prompt, rule, zone, enabled, next_run_at) VALUES ('schedule_one','session_cron','secret prompt',?,'UTC',1,0)")
    .run(JSON.stringify({ kind: "interval", everyMs: 15 * 60_000 }));

  const { digest } = digestOf(store);

  expect(digest.topSessions).toHaveLength(1);
  expect(digest.schedules).toEqual([{ session: "s1", periodMinutes: 15, enabled: true, runs: 1, tokens: 160 }]);
  expect(digest.signals.map((signal) => signal.id)).toContain("frequent_schedule");
  expect(JSON.stringify(digest)).not.toContain("secret prompt");
});

test("log usage is split by evidence, labelled by folder, and a small share of Telar runs is flagged rather than called outside", () => {
  const { store, session, turn } = fixture();
  session("session_one", { projectId: "project_one" });
  turn("session_one", NOW - HOUR, { cacheRead: 10 });
  const row = (bucket: "store" | "telar" | "outside", cwd: string, tokens: number, model = "claude-sonnet-5") => ({ file: `${bucket}-${cwd}`, bucket, cwd, model, tokens, costUsd: tokens / 1e6 });

  const { digest, names } = buildUsageDigest({
    db: store,
    now: NOW,
    rates: RATES,
    providerLogs: [{ provider: "claude", tokens: 1_000_000, costUsd: 1.234 }],
    config: {},
    projectName: (id) => `Project ${id}`,
    projectRoots: [{ id: "project_one", root: "/code/acme" }],
    claudeLogs: [
      row("store", "/code/acme", 50_000),
      row("telar", "/elsewhere/worktrees/acme-1234/src", 900_000, "claude-opus-5[1m]"),
      row("outside", "/home/me/scratch", 50_000),
    ],
  });

  expect(digest.claudeLogs!.buckets).toMatchObject({ store: { tokens: 50_000, transcripts: 1 }, telar: { tokens: 900_000 }, outside: { tokens: 50_000 } });
  expect(digest.claudeLogs!.storeCoverage).toBe(0.053);
  expect(digest.claudeLogs!.projects.map((project) => [project.id, project.bucket])).toEqual([["p2", "telar"], ["p1", "store"], ["p3", "outside"]]);
  expect(digest.claudeLogs!.models[0]).toMatchObject({ model: "claude-opus-5[1m]", tokens: 900_000 });
  expect(names).toMatchObject({ p1: "Project project_one", p2: "acme-1234", p3: "scratch" });
  expect(JSON.stringify(digest)).not.toMatch(/acme|scratch|elsewhere/);
  const signals = digest.signals.map((signal) => signal.id);
  expect(signals).toContain("store_misses_telar_runs");
  expect(signals).not.toContain("outside_telar");
});
