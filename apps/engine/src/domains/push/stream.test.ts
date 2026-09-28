import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function engine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-push-stream-"));
  roots.push(home);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  const base = `http://127.0.0.1:${daemon.discovery.port}`;
  const headers = { authorization: `Bearer ${daemon.discovery.token}` };
  return { daemon, home, base, headers, client: new EngineClient(daemon.discovery) };
}

async function subscribe(base: string, headers: Record<string, string>) {
  const abort = new AbortController();
  aborts.push(abort);
  const response = await fetch(`${base}/v2/push/desktop/stream`, { headers, signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const frame = buffered.split("\n\n").find((part) => part.startsWith("data: "));
      if (frame) {
        buffered = buffered.slice(buffered.indexOf(frame) + frame.length + 2);
        return JSON.parse(frame.slice(6)) as Record<string, unknown>;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffered += decoder.decode(value, { stream: true });
    }
  };
  await reader.read();
  return { status: response.status, type: response.headers.get("content-type"), next };
}

test("the shell's stream carries a dismissal when a session is read", async () => {
  const { base, headers, client, home } = await engine();
  fs.mkdirSync(path.join(home, "checkout"));
  await client.registerProject({ id: "project_one", name: "One", root: path.join(home, "checkout") });
  await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");
  await client.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claim = (await client.claimTurn("worker_one", 1)).claim!;
  await client.markTurnRunning("session_one", "run_one", claim.turn.claim!.token);
  await client.completeTurn("session_one", "run_one", claim.turn.claim!.token, { text: "Done" });

  const stream = await subscribe(base, headers);
  expect(stream.status).toBe(200);
  expect(stream.type).toBe("text/event-stream");
  const frame = stream.next();
  await client.markSessionRead("session_one", "run_one");
  expect(await frame).toEqual({ type: "telar:desktop-notification:dismiss", sessionId: "session_one" });
});

test("an approval the engine never offered is answered not ok on the stream", async () => {
  const { base, headers } = await engine();
  const stream = await subscribe(base, headers);
  const frame = stream.next();
  const posted = await fetch(`${base}/v2/push/desktop/messages`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ type: "telar:desktop-notification:approve", sessionId: "s1", requestId: "r1" }),
  });
  expect(posted.status).toBe(200);
  expect(await frame).toEqual({ type: "telar:desktop-notification:approved", sessionId: "s1", requestId: "r1", ok: false });
});

test("closing the engine ends a subscribed shell's stream", async () => {
  const { base, headers, daemon } = await engine();
  const stream = await subscribe(base, headers);
  await daemon.close();
  await expect(stream.next()).rejects.toThrow();
});

test("the stream and the shell's messages answer only to the engine token", async () => {
  const { base } = await engine();
  expect((await fetch(`${base}/v2/push/desktop/stream`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await fetch(`${base}/v2/push/desktop/messages`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
});
