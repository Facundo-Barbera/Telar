import { expect, test } from "bun:test";
import type { EngineEvent, Session, SessionActivity } from "@telar/engine-client";
import { lintelPlan, mirrorMessages, readLintelToken, startLintelCallbackServer, LINTEL_MESSAGE_MAX } from "../src/lintel";
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

test("the token file is the opt-in, and absence is silence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintel-"));
  const tokenPath = path.join(dir, "api-token");
  expect(readLintelToken(tokenPath)).toBeUndefined();
  fs.writeFileSync(tokenPath, "  abc123\n");
  expect(readLintelToken(tokenPath)).toBe("abc123");
  fs.rmSync(dir, { recursive: true, force: true });
});
