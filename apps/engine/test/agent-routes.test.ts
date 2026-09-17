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
 *   - reset archives and bumps the generation;
 *   - a wake writes an inbox row and starts no turn (#541 A), the inbox pages
 *     and clamps, marking read moves a row once, the row is pushed on the
 *     stream, and the next human turn opens with the digest and clears it.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ChatResult } from "@langchain/core/outputs";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { AGENT_SELF_ID } from "../src/agent/identity";
import { stubModels } from "./stub-models";
import * as notebook from "../src/notes";
import { AGENT_SELF_ID } from "../src/agent/identity";
import { agentPaths } from "../src/agent/store";
import { readStanding, rememberSection } from "../src/agent/memory";

/**
 * A MODEL THAT NEVER LEAVES THE MACHINE.
 *
 * Not an optimisation — a correctness requirement. The key ladder's third rung
 * reads the OpenCode CLI's own credential, so a developer signed into it would
 * have these tests spending real calls against a real API, at whatever latency
 * that API happened to have. See `EngineDaemonOptions.agentModel`.
 */
class ScriptedChatModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly script: Array<{ text?: string; toolCalls?: ToolCall[] }> = []) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const step = this.script[this.index] ?? { text: "nothing is running." };
    this.index += 1;
    const message = new AIMessage({ content: step.text ?? "", tool_calls: step.toolCalls ?? [] });
    return { generations: [{ text: step.text ?? "", message }] };
  }
}

/** The one gated call, as a model step: `sessions_send` with `intent: task`. */
const asksToDelegate: { toolCalls: ToolCall[] } = {
  toolCalls: [{ id: "call_route", name: "sessions_send", args: { sessionId: "session_peer", intent: "task", input: "do it" }, type: "tool_call" }],
};

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-routes-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

async function engine(script: Array<{ text?: string; toolCalls?: ToolCall[] }> = []): Promise<{ daemon: EngineDaemon; client: EngineClient }> {
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), agentModel: () => new ScriptedChatModel(script) });
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

/**
 * #541 part F, owner decision 3 — through the real daemon, because the thing
 * being asserted is the WIRING: which notebook the preferences land in.
 */
test("reset leaves the preferences as a pinned note in the Agent's own notebook", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  rememberSection(agentPaths(daemon.store.paths.root), "doing", "coordinating #541");
  rememberSection(agentPaths(daemon.store.paths.root), "preferences", "Small PRs, and ask before opening one.");

  await client.setAgent({ reset: true });

  const notes = notebook.readNotes(daemon.store.paths, AGENT_SELF_ID);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.pinned).toBe(true);
  expect(notes[0]!.body).toBe("Small PRs, and ask before opening one.");
  // NOT A PROJECT'S NOTEBOOK: the Agent owns none, and a fact about a person
  // does not belong in a strip about a codebase.
  expect(notes[0]!.projectId).toBe(AGENT_SELF_ID);
  // Everything else went.
  expect(readStanding(agentPaths(daemon.store.paths.root))).toEqual({ sections: {} });

  // A SECOND RESET REWRITES THE NOTE rather than growing a pile of them.
  await client.setAgent({ enabled: true });
  rememberSection(agentPaths(daemon.store.paths.root), "preferences", "Small PRs. Conventional commits.");
  await client.setAgent({ reset: true });
  const again = notebook.readNotes(daemon.store.paths, AGENT_SELF_ID);
  expect(again).toHaveLength(1);
  expect(again[0]!.body).toBe("Small PRs. Conventional commits.");
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

  const daemon = await startEngine({ models: stubModels, engineRoot: directory, agentModel: () => new ScriptedChatModel() });
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
 * `readAgentModels`, which calls opencode.ai and models.dev — and a test in the
 * default suite that reaches the network is the thing
 * `EngineDaemonOptions.agentModel` exists to prevent. What it DOES with those
 * two answers — the merge, the route table, the cache, the default — is
 * `agent-catalogue.test.ts`, which injects both and touches no network. The
 * real endpoints are `agent.live.test.ts`, under TELAR_LIVE_SMOKE=1.
 */

async function until(check: () => Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("an approval opens and resolves on the stream, and the state says so between", async () => {
  // A project and a peer, so the gated `sessions_send` has somewhere real to go.
  const { client } = await engine([asksToDelegate, { text: "sent" }]);
  await client.setAgent({ enabled: true });

  const stream = client.agentStream(0);
  const controller = new AbortController();
  const response = await fetch(stream.url, { headers: stream.headers, signal: controller.signal });
  const frames: Array<{ type: string; row?: { kind: string; detail: Record<string, unknown> } }> = [];
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

  await client.sendAgentTurn("delegate it");
  await until(async () => frames.some((frame) => frame.row?.kind === "request_opened"), "the approval on the stream");

  // The ASK is on the wire whole, so a surface need not re-derive the call.
  const opened = frames.find((frame) => frame.row?.kind === "request_opened")!.row!;
  expect(opened.detail.tool).toBe("sessions_send");
  expect((opened.detail.args as { sessionId: string }).sessionId).toBe("session_peer");

  // And the state agrees, with `running` FALSE while a person is being asked.
  const parked = (await client.agent()).agent;
  expect(parked.request?.id).toBe(opened.detail.id as string);
  expect(parked.running).toBe(false);

  expect(await client.resolveAgentRequest(parked.request!.id, "decline")).toMatchObject({ resolved: true });
  await until(async () => frames.some((frame) => frame.row?.kind === "request_resolved"), "the resolution on the stream");
  const resolved = frames.find((frame) => frame.row?.kind === "request_resolved")!.row!;
  expect(resolved.detail.decision).toBe("decline");

  await until(async () => (await client.agent()).agent.runId === undefined, "the turn to end");
  expect((await client.agent()).agent.request).toBeUndefined();

  controller.abort();
  await pump;
});

test("the thread route and the stream both carry what the assistant said before a tool call", async () => {
  const { client } = await engine([
    { text: "I'll check the rail.", toolCalls: [{ id: "call_say", name: "sessions_list", args: {}, type: "tool_call" }] },
    { text: "Nothing is running." },
  ]);
  await client.setAgent({ enabled: true });

  const stream = client.agentStream(0);
  const controller = new AbortController();
  const response = await fetch(stream.url, { headers: stream.headers, signal: controller.signal });
  const said: string[] = [];
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
          const event = JSON.parse(frame.slice(5).trim()) as { type: string; row?: { kind: string; detail: { text?: string } } };
          if (event.row?.kind === "assistant_message") said.push(String(event.row.detail.text));
        }
      }
    } catch {
      // The abort below is how this ends.
    }
  })();

  await client.sendAgentTurn("what is running?");
  await until(async () => said.length >= 2, "both assistant rows on the stream");
  expect(said).toEqual(["I'll check the rail.", "Nothing is running."]);

  // And the same two are pageable, in the same order, with the tool call
  // between them.
  const rows = (await client.agentThread({ limit: 200 })).rows;
  expect(rows.map((row) => row.kind)).toEqual([
    "user_message",
    "turn_started",
    "assistant_message",
    "tool_call",
    "assistant_message",
    "turn_done",
  ]);

  controller.abort();
  await pump;
});

/* ------------------------------------------------------------------ *
 * The wake inbox — issue #541, section A.
 * ------------------------------------------------------------------ */

/**
 * A REAL WAKE, THROUGH THE REAL PATH: a session the Agent subscribed to finishes
 * a turn, the store fans the subscription out, and the daemon's sink is what
 * catches the one subscriber that is not a session. Nothing here reaches into
 * the runtime — the point is that the wiring between the three holds.
 */
async function workerCompletes(daemon: EngineDaemon, runId = "run_worker"): Promise<string> {
  const store = daemon.store;
  if (store.listProjects().length === 0) store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  const sessionId = `session_${runId}`;
  store.createSession({ id: sessionId, projectId: "project_one" });
  store.subscribe(AGENT_SELF_ID, { targetSessionId: sessionId, events: ["turn_completed"] });
  store.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claimTurn(sessionId, `worker_${runId}`)!.claim!.token;
  store.markRunning(sessionId, runId, token);
  store.completeTurn(sessionId, runId, token, { text: "done" });
  return sessionId;
}

test("a subscribed session finishing writes an inbox row and starts no Agent turn", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  const sessionId = await workerCompletes(daemon);

  const state = (await client.agent()).agent;
  // NOT A TURN. This is the whole of #541 A at the seam a client can see.
  expect(state.running).toBe(false);
  expect(state.queued).toBe(0);
  expect(state.inboxUnread).toBe(1);
  expect((await client.agentThread()).rows).toHaveLength(0);

  const inbox = await client.agentInbox();
  expect(inbox.rows).toHaveLength(1);
  expect(inbox.rows[0]).toMatchObject({ sessionId, runId: "run_worker", kind: "turn_completed", read: false });
  expect(inbox.rows[0]!.summary).toContain("[wake: completed]");
  expect(inbox.unread).toBe(1);
  expect(inbox.more).toBe(false);
});

test("the inbox pages by cursor, filters to unread, and clamps its limit", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  await workerCompletes(daemon, "run_one");
  await workerCompletes(daemon, "run_two");
  await workerCompletes(daemon, "run_three");

  const first = await client.agentInbox({ limit: 2 });
  expect(first.rows.map((row) => row.runId)).toEqual(["run_one", "run_two"]);
  expect(first.more).toBe(true);
  const second = await client.agentInbox({ after: first.cursor, limit: 2 });
  expect(second.rows.map((row) => row.runId)).toEqual(["run_three"]);
  expect(second.more).toBe(false);

  // A LIMIT PAST THE CEILING IS CLAMPED, not refused: the store's own bound is
  // the one that pages, and a second set here would be a second thing to keep
  // in step with it.
  expect((await client.agentInbox({ limit: 5_000 })).rows).toHaveLength(3);

  await client.markAgentInboxRead([first.rows[0]!.id]);
  expect((await client.agentInbox({ unreadOnly: true })).rows.map((row) => row.runId)).toEqual(["run_two", "run_three"]);
  expect((await client.agentInbox()).unread).toBe(2);
});

test("marking read moves a row once, and a bad body is refused rather than ignored", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });
  await workerCompletes(daemon);
  const id = (await client.agentInbox()).rows[0]!.id;

  expect(await client.markAgentInboxRead([id])).toEqual({ read: 1, unread: 0 });
  expect(await client.markAgentInboxRead([id])).toEqual({ read: 0, unread: 0 });
  expect((await client.agent()).agent.inboxUnread).toBe(0);

  const bad = await fetch(`http://${daemon.discovery.host}:${daemon.discovery.port}/v2/agent/inbox/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: "everything" }),
  });
  expect(bad.status).toBe(400);
});

test("an inbox row is pushed on the stream, so a client can badge it without polling", async () => {
  const { daemon, client } = await engine();
  await client.setAgent({ enabled: true });

  const stream = client.agentStream(0);
  const controller = new AbortController();
  const response = await fetch(stream.url, { headers: stream.headers, signal: controller.signal });

  const inboxFrames: Array<{ type: string; row: { kind: string; sessionId: string } }> = [];
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
          const event = JSON.parse(frame.slice(5).trim()) as { type: string; row: { kind: string; sessionId: string } };
          if (event.type === "inbox") inboxFrames.push(event);
        }
      }
    } catch {
      // The abort below is how this ends.
    }
  })();

  const sessionId = await workerCompletes(daemon);
  await until(async () => inboxFrames.length >= 1, "the inbox frame");
  expect(inboxFrames[0]!.row).toMatchObject({ kind: "turn_completed", sessionId });

  controller.abort();
  await pump;
});

test("the digest opens the next turn a person begins, and clears the inbox", async () => {
  const { daemon, client } = await engine([{ text: "I read the digest." }]);
  await client.setAgent({ enabled: true });
  await workerCompletes(daemon);
  expect((await client.agent()).agent.inboxUnread).toBe(1);

  await client.sendAgentTurn("what happened?");
  await until(async () => (await client.agentThread()).rows.some((row) => row.kind === "turn_done"), "the turn");

  // THE TRANSCRIPT KEEPS THE PERSON'S WORDS ALONE. The digest is engine prose
  // and rides the system message; a row carrying it would put the engine's
  // summary in the person's bubble, which is the mistake #550 fixed.
  const user = (await client.agentThread()).rows.find((row) => row.kind === "user_message")!;
  expect(user.detail.text).toBe("what happened?");
  expect((await client.agent()).agent.inboxUnread).toBe(0);
  expect((await client.agentInbox()).rows[0]!.read).toBe(true);
});
