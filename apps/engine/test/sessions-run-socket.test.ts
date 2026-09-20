/**
 * The sessions RUN socket — the wall a Codex turn is pointed at, driven over
 * real HTTP because the transport is the feature (see
 * `src/sessions-tools/run-socket.ts`).
 *
 * The properties under test:
 *   · the SAME wall a Claude session gets — tool-list parity is asserted
 *     against `sessionsTools` itself, not a copied list;
 *   · `self` rides the binding, so the subscription tools WORK here (the
 *     daemon's outward socket is the door that refuses them);
 *   · tokens isolate bindings: each session's token reaches its own
 *     capability and nobody else's, and a released token is a 401;
 *   · the transport surface matches the house shape — 202 for a
 *     notification, 405 for GET, 200 for DELETE.
 */
import { afterEach, expect, test } from "bun:test";
import type { Subscription } from "@telar/engine-client";
import { SessionsToolSocket, type SessionsSocketLease } from "../src/sessions-tools/run-socket";
import { collectSessionsWallTools } from "../src/sessions-tools/socket";
import type { SessionsCapability } from "../src/sessions-tools/tools";

const sockets: SessionsToolSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
});

function socket(): SessionsToolSocket {
  const made = new SessionsToolSocket();
  sockets.push(made);
  return made;
}

/**
 * A capability that answers emptily and REMEMBERS what it was asked. Every
 * verb that would land somewhere throws — what these tests pin is transport
 * and binding, and a stub that pretended to create sessions would be asserting
 * something this file does not check.
 */
function capability(selfId: string, calls: Array<{ verb: string; args: unknown[] }>): SessionsCapability {
  const note = (verb: string) => (...args: unknown[]) => void calls.push({ verb, args });
  return {
    self: { sessionId: selfId },
    list: async () => {
      note("list")();
      return { sessions: [], projects: [{ id: "proj_1", name: "aurora" }] };
    },
    create: async () => {
      throw new Error("this test does not create sessions");
    },
    send: async () => {
      throw new Error("this test does not send");
    },
    read: async () => [],
    status: async () => {
      throw new Error("this test does not read status");
    },
    stop: async () => ({ stopped: false }),
    settle: async () => {
      throw new Error("this test does not settle");
    },
    diff: async () => {
      throw new Error("this test does not diff");
    },
    subscribe: async (subscriber, input) => {
      note("subscribe")(subscriber, input);
      const subscription: Subscription = {
        id: "sub_1",
        subscriberSessionId: subscriber,
        targetSessionId: input.targetSessionId,
        events: input.events ?? ["turn_completed", "turn_failed", "turn_stopped", "request_opened"],
        createdAt: 0,
      };
      return subscription;
    },
    unsubscribe: async () => false,
    subscriptions: async () => [],
    requests: async () => [],
    resolveRequest: async () => {
      throw new Error("this test does not resolve");
    },
  };
}

async function rpc(lease: SessionsSocketLease, message: unknown, token = lease.token): Promise<Response> {
  return fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
}

async function callTool(lease: SessionsSocketLease, name: string, args: Record<string, unknown>) {
  const answered = await rpc(lease, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  const { result } = (await answered.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

/** The wall's own tool names, collected through the same seam the socket uses. */
const wallNames = collectSessionsWallTools({} as SessionsCapability).map((tool) => tool.name);

test("tools/list IS the wall, and the server introduces itself under the key Codex registers", async () => {
  const lease = await socket().bind(capability("session_host", []));

  const initialized = await rpc(lease, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  const answer = (await initialized.json()) as { result: { serverInfo: { name: string } } };
  // The `initialize` name and the `mcp_servers` key must agree, or a client
  // showing Telar's servers renders one entity under two names.
  expect(answer.result.serverInfo.name).toBe("telar-sessions");

  const listed = await rpc(lease, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const { result } = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
  // PARITY WITH THE WALL, structurally: both lists come from `sessionsTools`,
  // so a tool added to the toolkit appears here in the same change or this fails.
  expect(result.tools.map((tool) => tool.name)).toEqual(wallNames);
  // 21 since #543 added `sessions_schedule`.
  expect(result.tools.length).toBe(21);
});

test("`self` rides the binding: a subscription made over this socket names the bound session as subscriber", async () => {
  // THE PROPERTY THE DAEMON'S OUTWARD SOCKET CANNOT HAVE. A chat client there
  // has no session to wake and the wall refuses; here the worker bound the
  // session's own id, so a Codex session subscribes exactly as a Claude one.
  const calls: Array<{ verb: string; args: unknown[] }> = [];
  const lease = await socket().bind(capability("session_host", calls));

  const subscribed = await callTool(lease, "sessions_subscribe", { sessionId: "session_target", events: ["turn_completed"] });
  expect(subscribed.isError).toBe(false);
  expect(calls).toEqual([
    { verb: "subscribe", args: ["session_host", { targetSessionId: "session_target", events: ["turn_completed"], once: true }] },
  ]);
  expect(JSON.parse(subscribed.text)).toMatchObject({ subscriberSessionId: "session_host", targetSessionId: "session_target" });
});

test("tokens isolate bindings, and a released token is a 401 — which is the whole revocation story", async () => {
  const shared = socket();
  const callsA: Array<{ verb: string; args: unknown[] }> = [];
  const callsB: Array<{ verb: string; args: unknown[] }> = [];
  const leaseA = await shared.bind(capability("session_a", callsA));
  const leaseB = await shared.bind(capability("session_b", callsB));
  // One listener, two doors: the URL is shared, the token is what binds.
  expect(leaseA.url).toBe(leaseB.url);

  await callTool(leaseA, "sessions_list", {});
  const subscribedB = await callTool(leaseB, "sessions_subscribe", { sessionId: "session_a" });
  expect(callsA.map((call) => call.verb)).toEqual(["list"]);
  // B's subscribe names B, never A — the capability came with the token.
  expect(callsB).toEqual([{ verb: "subscribe", args: ["session_b", { targetSessionId: "session_a", once: true }] }]);
  expect(JSON.parse(subscribedB.text)).toMatchObject({ subscriberSessionId: "session_b" });

  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  expect((await rpc(leaseA, ping, "not-a-token")).status).toBe(401);
  leaseA.release();
  expect((await rpc(leaseA, ping)).status).toBe(401);
  // …and releasing A revoked nothing of B's.
  expect((await rpc(leaseB, ping)).status).toBe(200);
});

test("the transport surface matches the house shape", async () => {
  const lease = await socket().bind(capability("session_host", []));
  const headers = { authorization: `Bearer ${lease.token}` };

  expect((await rpc(lease, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  expect((await fetch(lease.url, { headers })).status).toBe(405);
  expect((await fetch(lease.url, { method: "DELETE", headers })).status).toBe(200);

  // An argument the wall's schema refuses never reaches a handler — the same
  // check the SDK performs for a Claude session.
  const bad = await rpc(lease, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "sessions_create", arguments: { projectId: "p", envMode: "container" } },
  });
  expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32602);
});
