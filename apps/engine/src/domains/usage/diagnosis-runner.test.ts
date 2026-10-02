import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageDigest } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { UsageDiagnoses } from "./diagnosis-runner";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.kernel.executionStore.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const digest = {
  version: 1,
  createdAt: 100,
  windows: { "30d": { totals: { tokens: { input: 0, output: 0, cacheRead: 9e6, cacheCreate: 0 }, costUsd: 3, turns: 10, sessions: 1, cacheHit: 1 }, byModel: [] } },
  topSessions: [{ id: "s1", turns: 10, model: "sonnet", tokens: { input: 0, output: 0, cacheRead: 9e6, cacheCreate: 0 } }],
  signals: [{ id: "cache_read_dominant", value: 1, threshold: 0.9 }],
} as unknown as UsageDigest;

function engine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-run-"));
  homes.push(home);
  const store = new EngineStore(home, () => 100);
  stores.push(store);
  store.projectRegistry.register({ id: "project_one", name: "Acme Rocket", root: home });
  const diagnoses = new UsageDiagnoses(store, async () => ({ digest, names: { s1: "Fix the login page" } }));
  return { store, diagnoses };
}

function finish(store: EngineStore, sessionId: string, runId: string, text: string) {
  const token = store.claims.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning(sessionId, runId, token);
  store.turnLifecycle.completeTurn(sessionId, runId, token, { text });
}

test("starting writes the digest, opens a hidden read-only session and sends it the prompt", async () => {
  const { store, diagnoses } = engine();

  const started = await diagnoses.start({});

  expect(started).toMatchObject({ state: "running", model: "sonnet · medium", promptVersion: 2, names: { s1: "Fix the login page" } });
  expect(store.records.get(started.sessionId)).toMatchObject({ purpose: "usage-diagnosis", driver: "claude", model: { model: "sonnet", effort: "medium" } });
  const turn = store.queries.turns(started.sessionId).find((candidate) => candidate.runId === started.runId)!;
  expect(turn.input).toContain(`diagnostics/usage/${started.id}/digest.json`);
  expect(turn.input).toContain("execution.sqlite");
  expect(JSON.parse(fs.readFileSync(path.join(store.paths.diagnostics, "usage", started.id, "digest.json"), "utf8"))).toEqual(digest);
  expect(await diagnoses.start({})).toEqual(started);
  expect(diagnoses.current()).toEqual(started);
});

test("a finished turn becomes a redacted report", async () => {
  const { store, diagnoses } = engine();
  const started = await diagnoses.start({ model: "haiku", effort: "low" });
  const report = {
    window: "30d",
    summary: "Acme Rocket spends most in s1.",
    topConsumers: [{ id: "s1", share: 1, reason: "every turn" }],
    findings: [{ signal: "cache_read_dominant", severity: "high", title: "Cache reads", why: "Long context.", evidence: [{ metric: "cacheHit", value: 1 }], fix: { setting: "compaction", action: "Compact sooner." } }],
  };

  finish(store, started.sessionId, started.runId, JSON.stringify(report));

  const ready = diagnoses.current()!;
  expect(ready).toMatchObject({ state: "ready", finishedAt: 100, model: "haiku · low" });
  expect(ready.fallback).toBeUndefined();
  expect(ready.report!.summary).toBe("[redacted] spends most in s1.");
});

test("an unusable answer falls back to the signals and says why", async () => {
  const { store, diagnoses } = engine();
  const started = await diagnoses.start({});

  finish(store, started.sessionId, started.runId, "I looked around and it seems fine.");

  expect(diagnoses.current()).toMatchObject({ state: "ready", fallback: true, error: "the answer held no JSON object", report: { findings: [{ signal: "cache_read_dominant" }] } });
});

test("stopping ends the turn and the diagnosis", async () => {
  const { diagnoses } = engine();
  await diagnoses.start({});

  expect(diagnoses.stop()).toMatchObject({ state: "failed", error: "The diagnosis was stopped." });
  expect(diagnoses.current()).toMatchObject({ state: "failed" });
});

test("no diagnosis yet reads as none", () => {
  expect(engine().diagnoses.current()).toBeUndefined();
});

test("a failed turn's own error becomes the diagnosis's error", async () => {
  const { store, diagnoses } = engine();
  const started = await diagnoses.start({});
  const token = store.claims.claimTurn(started.sessionId, "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning(started.sessionId, started.runId, token);
  const message = "Claude did not complete successfully: Failed to authenticate: OAuth session expired and could not be refreshed";
  store.turnLifecycle.failTurn(started.sessionId, started.runId, token, { code: "driver_failed", message });

  expect(diagnoses.current()).toMatchObject({ state: "failed", error: message });
});
