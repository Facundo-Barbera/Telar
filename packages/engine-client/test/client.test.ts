import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError, discoverEngine } from "../src";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("discovery rejects missing or malformed state without falling back to legacy state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-client-"));
  roots.push(root);
  await expect(discoverEngine(root)).rejects.toMatchObject({ code: "engine_unavailable" });
  fs.writeFileSync(path.join(root, "engine.json"), "{}");
  await expect(discoverEngine(root)).rejects.toMatchObject({ code: "engine_unavailable" });
});

test("client preserves typed engine errors", async () => {
  const client = new EngineClient(
    { version: 1, daemonId: "daemon", host: "127.0.0.1", port: 4010, token: "x".repeat(32), startedAt: 1 },
    (async () =>
      new Response(JSON.stringify({ error: { code: "worker_unavailable", message: "no worker" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  );
  await expect(client.registerProject({ name: "A", root: "/tmp/a" })).rejects.toEqual(
    new EngineClientError("worker_unavailable", "no worker", 503),
  );
});

test("client exposes the authenticated ambiguous-turn discard action", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new EngineClient(
    { version: 1, daemonId: "daemon", host: "127.0.0.1", port: 4010, token: "x".repeat(32), startedAt: 1 },
    (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "run_uncertain", state: "discarded" } });
    }) as typeof fetch,
  );
  await client.discardAmbiguousTurn("session_one", "run_uncertain");
  expect(calls).toEqual([{
    url: "http://127.0.0.1:4010/v1/sessions/session_one/turns/run_uncertain/discard",
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" },
      body: "{}",
    },
  }]);
});
