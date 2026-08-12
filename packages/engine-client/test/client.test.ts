import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "../src";
import { discoverEngine } from "../src/node";

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
    { version: 2, daemonId: "daemon", host: "127.0.0.1", port: 4010, token: "x".repeat(32), startedAt: 1 },
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
    { version: 2, daemonId: "daemon", host: "127.0.0.1", port: 4010, token: "x".repeat(32), startedAt: 1 },
    (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ turn: { runId: "run_uncertain", state: "discarded" } });
    }) as typeof fetch,
  );
  await client.discardAmbiguousTurn("session_one", "run_uncertain");
  expect(calls).toEqual([{
    url: "http://127.0.0.1:4010/v2/sessions/session_one/turns/run_uncertain/discard",
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" },
      body: "{}",
    },
  }]);
});

test("the root export is browser-safe: no node builtins reachable from it", async () => {
  /**
   * THE REGRESSION THIS PINS, and it shipped: `discoverEngine` sat in
   * `./index.ts` with a top-level `node:fs/promises` import. That was harmless
   * until a client component imported ANY value from the package — a tool-name
   * helper was enough — at which point Turbopack refused to build the browser
   * chunk and the whole cockpit 500'd. Nothing in the test suite noticed,
   * because nothing in the test suite bundles for a browser.
   *
   * Node-only code lives in `./node`, which is exempt by construction: it is a
   * separate entry point that browser code never imports.
   */
  const dir = path.join(import.meta.dir, "..", "src");
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && name !== "node.ts");
  expect(files.length).toBeGreaterThan(5);

  const offenders = files.filter((name) => /from\s+"node:|require\("node:/.test(fs.readFileSync(path.join(dir, name), "utf8")));
  expect(offenders).toEqual([]);
});
