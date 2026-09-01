import { expect, test } from "bun:test";
import http from "node:http";
import type { EngineEvent, Session, SessionActivity } from "@telar/engine-client";
import { lintelPlan, mirrorMessages, readLintelToken, startLintelCallbackServer, startLintelSync, LINTEL_MESSAGE_MAX } from "../src/lintel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function session(id: string, activity: SessionActivity, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 1,
    driver: "claude",
    state: "active",
    detached: false,
    workspace: { mode: "local", path: "/tmp/x" },
    activity,
    ...overrides,
  } as Session;
}

const NAMES = new Map([["project_1", "Telar"]]);

test("live sessions become chips, blocked wears red and banners once", () => {
  const sessions = [
    session("s_work", "working", { projectId: "project_1" }),
    session("s_block", "blocked"),
    session("s_watch", "monitoring"),
    session("s_idle", "idle"),
  ];
  const { plan, next } = lintelPlan(sessions, NAMES, new Map());
  expect(plan.agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual([
    "s_work:running",
    "s_block:error",
    "s_watch:running",
  ]);
  expect(plan.agents[0]!.detail).toBe("Working · Telar");
  expect(plan.banners).toHaveLength(1);
  expect(plan.banners[0]!.title).toBe("Waiting on you");

  // The next pass RE-POSTS every live chip (Lintel's 120s TTL is the whole
  // anti-ghost design) but does not re-fire the blocked banner.
  const again = lintelPlan(sessions, NAMES, next);
  expect(again.plan.agents).toHaveLength(3);
  expect(again.plan.banners).toHaveLength(0);
});

test("a session that ends posts one terminal chip, honest about failure", () => {
  const before = new Map<string, SessionActivity>([
    ["s_done", "working"],
    ["s_fail", "working"],
  ]);
  const { plan, next } = lintelPlan(
    [session("s_done", "idle"), session("s_fail", "idle", { lastTurnFailed: true })],
    NAMES,
    before,
  );
  expect(plan.agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual(["s_done:done", "s_fail:error"]);
  // Terminal chips are one-shot: the following pass says nothing.
  expect(lintelPlan([session("s_done", "idle")], NAMES, next).plan.agents).toHaveLength(0);
});

test("a session deleted mid-flight is removed, not left to the TTL", () => {
  const before = new Map<string, SessionActivity>([["s_gone", "working"]]);
  const { plan } = lintelPlan([], NAMES, before);
  expect(plan.removals).toEqual(["s_gone"]);
});

const NO_SKIP = { runIds: new Set<string>(), texts: new Set<string>() };

function turnAccepted(runId: string, input: string, replayed = false): EngineEvent {
  return {
    id: 1,
    at: 1,
    sessionId: "s",
    type: "turn.accepted",
    replayed,
    turn: { runId, sessionId: "s", sequence: 1, state: "queued", input, acceptedAt: 1, updatedAt: 1 },
  } as unknown as EngineEvent;
}

function itemCompleted(type: "assistant_message" | "user_message", text: string): EngineEvent {
  return {
    id: 2,
    at: 2,
    sessionId: "s",
    type: "item.completed",
    item: { id: "item_1", sessionId: "s", runId: "run_x", openedBy: 1, startedAt: 1, status: "completed", detail: { type, text } },
  } as unknown as EngineEvent;
}

test("the mirror folds prompts and replies in order, clipping long ones", () => {
  const long = "x".repeat(LINTEL_MESSAGE_MAX + 500);
  const messages = mirrorMessages(
    [turnAccepted("run_1", "fix the bug"), itemCompleted("assistant_message", long), itemCompleted("user_message", "steered note")],
    NO_SKIP,
  );
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[1]!.text.length).toBe(LINTEL_MESSAGE_MAX);
});

test("the no-echo rule: injected prompts and replayed turns are not mirrored back", () => {
  const skip = { runIds: new Set(["run_injected"]), texts: new Set(["from the notch"]) };
  const messages = mirrorMessages(
    [
      turnAccepted("run_injected", "from the notch"),
      turnAccepted("run_replay", "again", true),
      itemCompleted("user_message", "from the notch"),
      itemCompleted("assistant_message", "a real reply"),
    ],
    skip,
  );
  expect(messages).toEqual([{ role: "assistant", text: "a real reply" }]);
});

test("the callback server checks the bearer, answers fast, dedupes, and injects async", async () => {
  const received: Array<[string, string]> = [];
  const server = await startLintelCallbackServer((agentId, text) => received.push([agentId, text]));
  const send = (headers: Record<string, string>, body: unknown) =>
    fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  expect((await send({}, {})).status).toBe(401);
  const good = { type: "user_message", agentId: "session_1", messageId: "m1", text: "hello from the notch", sentAt: 1 };
  expect((await send({ authorization: `Bearer ${server.token}` }, good)).status).toBe(200);
  // A retry with the SAME messageId is acknowledged but not re-injected.
  expect((await send({ authorization: `Bearer ${server.token}` }, good)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(received).toEqual([["session_1", "hello from the notch"]]);
  server.close();
});

test("a short-lived session mirrors its opening prompt and its final reply", async () => {
  // The bug this pins, found live: a session that starts and finishes within
  // a couple of passes showed a chip with an EMPTY chat — the bootstrap
  // skipped the prompt as "history", and the reply landed after the session
  // left the live set.
  const log: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stub = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      log.push({ path: request.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      response.writeHead(200).end("{}");
    });
  });
  const port = await new Promise<number>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve((stub.address() as { port: number }).port));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintel-short-"));
  const tokenPath = path.join(dir, "api-token");
  fs.writeFileSync(tokenPath, "tok");

  let passCount = 0;
  const sync = startLintelSync(
    {
      liveSessions: () => {
        passCount += 1;
        // Pass 1: working. Pass 2+: the turn already finished.
        return { sessions: [session("s_quick", passCount === 1 ? "working" : "idle")], projects: [] };
      },
      readEvents: (_id, after) => {
        const all = [
          { id: 1, at: 1, sessionId: "s_quick", type: "turn.accepted", replayed: false, turn: { runId: "run_q", sessionId: "s_quick", sequence: 1, state: "queued", input: "Test", acceptedAt: 1, updatedAt: 1 } },
          { id: 2, at: 2, sessionId: "s_quick", type: "item.completed", item: { id: "item_r", sessionId: "s_quick", runId: "run_q", openedBy: 1, startedAt: 2, status: "completed", detail: { type: "assistant_message", text: "Test received." } } },
        ] as unknown as EngineEvent[];
        // Pass 1 sees only the prompt; the reply arrives before pass 2.
        const visible = passCount === 1 ? all.slice(0, 1) : all;
        return visible.filter((event) => event.id > after);
      },
      submitTurn: () => {},
    },
    { intervalMs: 40, tokenPath, port },
  );
  await new Promise((resolve) => setTimeout(resolve, 110));
  sync.stop();
  stub.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const mirrored = log.filter((entry) => entry.path === "/v1/agents/s_quick/messages").map((entry) => entry.body);
  expect(mirrored.map((body) => body.text)).toEqual(["Test", "Test received."]);
  expect(mirrored.map((body) => body.role)).toEqual(["user", "assistant"]);
  // And the terminal chip still posted.
  const statuses = log.filter((entry) => entry.path === "/v1/agents").map((entry) => entry.body.status);
  expect(statuses).toContain("done");
});

test("a 404 on /messages re-registers in full and retries once — the self-heal", async () => {
  // A stub Lintel that FORGOT the agent (restart or TTL expiry): /messages
  // 404s until a registration arrives, then accepts. The bridge must re-POST
  // the FULL registration (callback fields included) and retry the message.
  const log: Array<{ path: string; body: Record<string, unknown> }> = [];
  const known = new Set<string>();
  const stub = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      log.push({ path: request.url ?? "", body });
      if (request.url === "/v1/agents") {
        known.add(String(body.id));
        response.writeHead(200).end("{}");
        return;
      }
      const match = /^\/v1\/agents\/([^/]+)\/messages$/.exec(request.url ?? "");
      if (match) {
        response.writeHead(known.has(decodeURIComponent(match[1]!)) ? 200 : 404).end("{}");
        return;
      }
      response.writeHead(200).end("{}");
    });
  });
  const port = await new Promise<number>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve((stub.address() as { port: number }).port));
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintel-heal-"));
  const tokenPath = path.join(dir, "api-token");
  fs.writeFileSync(tokenPath, "tok");
  const live = session("s_live", "working");
  let eventsServed = 0;
  const sync = startLintelSync(
    {
      liveSessions: () => ({ sessions: [live], projects: [] }),
      readEvents: () => {
        // Pass 1: cursor bootstrap (id 1). Pass 2: one new prompt to mirror.
        eventsServed += 1;
        if (eventsServed === 1) return [{ id: 1, at: 1, sessionId: "s_live", type: "turn.accepted", replayed: false, turn: { runId: "run_m", sessionId: "s_live", sequence: 1, state: "queued", input: "seed", acceptedAt: 1, updatedAt: 1 } } as unknown as EngineEvent];
        return [{ id: 2, at: 2, sessionId: "s_live", type: "turn.accepted", replayed: false, turn: { runId: "run_n", sessionId: "s_live", sequence: 2, state: "queued", input: "mirror me", acceptedAt: 2, updatedAt: 2 } } as unknown as EngineEvent];
      },
      submitTurn: () => {},
    },
    { intervalMs: 40, tokenPath, port },
  );

  // Pass 1 registers the agent; simulate Lintel restarting (it forgets), then
  // pass 2 tries to mirror and hits the 404.
  await new Promise((resolve) => setTimeout(resolve, 25));
  known.clear();
  await new Promise((resolve) => setTimeout(resolve, 80));
  sync.stop();
  stub.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const paths = log.map((entry) => entry.path);
  const messageIndex = paths.indexOf("/v1/agents/s_live/messages");
  expect(messageIndex).toBeGreaterThan(-1);
  // After the 404: a FULL re-registration (with callback fields), then the retry.
  const after = log.slice(messageIndex + 1);
  const reregistration = after.find((entry) => entry.path === "/v1/agents");
  expect(reregistration).toBeDefined();
  expect(reregistration!.body.id).toBe("s_live");
  expect(typeof reregistration!.body.callbackURL).toBe("string");
  expect(typeof reregistration!.body.callbackToken).toBe("string");
  const retried = after.filter((entry) => entry.path === "/v1/agents/s_live/messages");
  expect(retried.length).toBeGreaterThanOrEqual(1);
  expect(retried[0]!.body.text).toBe("mirror me");
});

test("the token file is the opt-in, and absence is silence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintel-"));
  const tokenPath = path.join(dir, "api-token");
  expect(readLintelToken(tokenPath)).toBeUndefined();
  fs.writeFileSync(tokenPath, "  abc123\n");
  expect(readLintelToken(tokenPath)).toBe("abc123");
  fs.rmSync(dir, { recursive: true, force: true });
});
