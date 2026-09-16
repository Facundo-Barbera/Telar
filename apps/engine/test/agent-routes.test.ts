/**
 * THE AGENT'S ROUTES, AGAINST A REAL DAEMON (#531).
 *
 * What must not drift:
 *
 *   - the switch is off out of the box, and turning it on mints one thread;
 *   - the rail's own read carries `agent: { enabled }`, so the entry costs no
 *     extra request;
 *   - a turn cannot be submitted to a switched-off Agent, and the refusal says
 *     so rather than 500ing;
 *   - the transcript pages by cursor;
 *   - the stream replays from a cursor and then pushes, on one connection;
 *   - reset archives and bumps the generation.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

/**
 * A MODEL THAT NEVER LEAVES THE MACHINE.
 *
 * Not an optimisation — a correctness requirement. The key ladder's third rung
 * reads the OpenCode CLI's own credential, so a developer signed into it would
 * have these tests spending real calls against a real API, at whatever latency
 * that API happened to have. See `EngineDaemonOptions.agentModel`.
 */
class ScriptedChatModel extends BaseChatModel {
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: "nothing is running." });
    return { generations: [{ text: "nothing is running.", message }] };
  }
}

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-routes-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

async function engine(): Promise<{ daemon: EngineDaemon; client: EngineClient }> {
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), agentModel: () => new ScriptedChatModel({}) });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery) };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("the Agent is off out of the box, and nothing is written until it is switched on", async () => {
  const { daemon, client } = await engine();
  const answer = await client.agent();
  expect(answer.agent).toMatchObject({ enabled: false, running: false, queued: 0 });
  expect(answer.agent.threadId).toBeUndefined();
  expect(fs.existsSync(path.join(daemon.store.paths.root, "agent", "agent.json"))).toBe(false);
});

test("enabling mints one thread, and enabling again reuses it", async () => {
  const { client } = await engine();
  const first = await client.setAgent({ enabled: true });
  expect(first.agent.enabled).toBe(true);
  expect(first.agent.threadId).toMatch(/^thread_/);
  const again = await client.setAgent({ enabled: true });
  expect(again.agent.threadId).toBe(first.agent.threadId!);
});

test("the rail's own read carries the flag, so the entry costs no extra request", async () => {
  const { client } = await engine();
  expect((await client.liveSessions()).agent).toEqual({ enabled: false });
  await client.setAgent({ enabled: true });
  expect((await client.liveSessions()).agent).toEqual({ enabled: true });
});

test("the model is a setting of its own, and emptying it returns to the default", async () => {
  const { client } = await engine();
  await client.setAgent({ enabled: true });
  expect((await client.setAgent({ model: "some-model" })).agent.model).toBe("some-model");
  expect((await client.setAgent({ model: "" })).agent.model).toBeUndefined();
});

test("a turn cannot be sent to a switched-off Agent, and the refusal is a sentence", async () => {
  const { client } = await engine();
  await expect(client.sendAgentTurn("hello")).rejects.toMatchObject({ code: "conflict" });
  await expect(client.sendAgentTurn("hello")).rejects.toThrow("switched off");
});

test("the transcript is empty before a turn and pages by cursor after one", async () => {
  const { client } = await engine();
  await client.setAgent({ enabled: true });
  const empty = await client.agentThread();
  expect(empty.rows).toEqual([]);
  expect(empty.more).toBe(false);

  const { runId } = await client.sendAgentTurn("what is running?");
  expect(runId).toMatch(/^run_/);
  await until(async () => (await client.agentThread()).rows.some((row) => row.kind === "turn_done"), "the turn to settle");

  const page = await client.agentThread({ limit: 1 });
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]!.kind).toBe("user_message");
  expect(page.more).toBe(true);
  const next = await client.agentThread({ after: page.cursor, limit: 10 });
  expect(next.rows[0]!.id).toBeGreaterThan(page.cursor);
});

test("cancelling a run that already finished is a fact rather than an error", async () => {
  const { client } = await engine();
  await client.setAgent({ enabled: true });
  expect(await client.cancelAgentTurn("run_nothing")).toMatchObject({ stopped: false });
});

test("answering a request nobody asked answers false rather than approving something", async () => {
  const { client } = await engine();
  await client.setAgent({ enabled: true });
  expect(await client.resolveAgentRequest("req_nothing", "accept")).toMatchObject({ resolved: false });
});

test("a decision that is neither accept nor decline is refused", async () => {
  const { daemon } = await engine();
  const response = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/agent/requests/req_x`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "maybe" }),
  });
  expect(response.status).toBe(400);
});

test("the stream replays from a cursor and then pushes, on one connection", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  await client.sendAgentTurn("first");
  await until(async () => (await client.agentThread()).rows.some((row) => row.kind === "turn_done"), "the first turn");

  const stream = client.agentStream(0);
  const controller = new AbortController();
  const response = await fetch(stream.url, { headers: stream.headers, signal: controller.signal });
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const frames: Array<{ type: string; row?: { kind: string } }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("data:")) continue;
          frames.push(JSON.parse(frame.slice(5).trim()));
        }
      }
    } catch {
      // The abort below is how this ends.
    }
  })();

  // The BACKLOG arrives without anything new happening.
  await until(async () => frames.some((frame) => frame.row?.kind === "user_message"), "the replayed backlog");
  // …and then a new turn's rows are PUSHED down the same connection.
  await client.sendAgentTurn("second");
  await until(async () => frames.filter((frame) => frame.row?.kind === "user_message").length >= 2, "the pushed row");

  controller.abort();
  await pump;
});

test("reset archives the conversation and bumps the generation", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  await client.sendAgentTurn("hello");
  await until(async () => (await client.agentThread()).rows.length > 0, "a row");

  const after = await client.setAgent({ reset: true });
  expect(after.agent.generation).toBe(1);
  expect((await client.agentThread()).rows).toEqual([]);
  const agentDir = path.join(daemon.store.paths.root, "agent");
  expect(fs.readdirSync(agentDir).some((name) => /^threads-\d{8}T\d{6}\.sqlite$/.test(name))).toBe(true);
});

test("the key is write-only: it is stored 0600 and read back only as a boolean", async () => {
  const { daemon, client } = await engine();
  expect((await client.agent()).credential?.set).toBe(false);

  const after = await client.setAgent({ apiKey: "sk-pasted-into-settings" });
  expect(after.credential).toEqual({ source: "setting", set: true });
  // NEVER THE KEY, on any read — not redacted, not a prefix, not its length.
  expect(JSON.stringify(after)).not.toContain("sk-pasted-into-settings");

  const file = path.join(daemon.store.paths.root, "agent", "credentials.json");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);

  // An empty string is what a person emptying the field means.
  expect((await client.setAgent({ apiKey: "" })).credential?.set).toBe(false);
});

test("the startup sweep deletes main-session.json and carries its key across", async () => {
  const directory = root();
  // A machine that had #526's Main assistant: the document, and a key pasted
  // as a sensitive variable on the `telar` provider login.
  fs.writeFileSync(path.join(directory, "main-session.json"), JSON.stringify({ version: 1, enabled: true, sessionId: "session_old" }));
  fs.writeFileSync(
    path.join(directory, "provider-secrets.json"),
    JSON.stringify({ version: 1, secrets: { "telar OPENCODE_API_KEY": "sk-from-526" } }),
  );

  const daemon = await startEngine({ models: stubModels, engineRoot: directory, agentModel: () => new ScriptedChatModel({}) });
  daemons.push(daemon);

  expect(fs.existsSync(path.join(directory, "main-session.json"))).toBe(false);
  const client = new EngineClient(daemon.discovery);
  // The key came across, so nobody re-pastes — and it is still only ever a
  // boolean on the way out.
  expect((await client.agent()).credential).toEqual({ source: "setting", set: true });
});

test("a machine that never switched Main on is swept silently and gains no key", async () => {
  const { daemon, client } = await engine();
  expect(fs.existsSync(path.join(daemon.store.paths.root, "main-session.json"))).toBe(false);
  expect((await client.agent()).credential?.set).toBe(false);
});

/*
 * `/v2/agent/models` IS NOT TESTED HERE, ON PURPOSE. It delegates to
 * `readAgentModels`, which calls opencode.ai — and a test in the default suite
 * that reaches the network is the thing `EngineDaemonOptions.agentModel` exists
 * to prevent. It is covered by `agent.live.test.ts`, which lists models against
 * the real endpoint and runs only under TELAR_LIVE_SMOKE=1.
 */

async function until(check: () => Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
