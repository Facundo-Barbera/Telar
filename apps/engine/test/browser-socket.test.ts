import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { BROWSER_TOOLS } from "../src/browser";
import { BrowserToolSocket, type BrowserSocketCapability } from "../src/browser/socket";

/**
 * THE SOCKET IS DRIVEN OVER REAL HTTP, the way a provider subprocess drives it
 * — `spool-socket.test.ts` sets the pattern. The capability is a fake; what is
 * under test is the transport, the per-lease auth, the gate and the state
 * reporting, which are exactly the parts that used to live in `driver.ts` and
 * now serve BOTH providers.
 */

const sockets: BrowserToolSocket[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) => socket.close()));
});

function makeSocket(capability: BrowserSocketCapability): BrowserToolSocket {
  const socket = new BrowserToolSocket(capability);
  sockets.push(socket);
  return socket;
}

function fakeCapability(overrides: Partial<BrowserSocketCapability> = {}): BrowserSocketCapability {
  return {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    isReadOnly: (name) => name === "browser_snapshot",
    tools: [
      { name: "browser_navigate", description: "go", input: z.object({ url: z.string() }) },
      { name: "browser_snapshot", description: "look", input: z.object({}) },
    ],
    ...overrides,
  };
}

async function rpc(url: string, token: string | undefined, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

test("tools/list serves the browser toolkit VERBATIM — parity is structural, not maintained", async () => {
  // Imported from the toolkit, never copied: the socket maps `BROWSER_TOOLS`
  // itself, so a tool added there lands here without a second registry.
  const socket = makeSocket(fakeCapability({ tools: BROWSER_TOOLS }));
  const lease = await socket.bind({ scopeKey: "session_one" });
  const listed = await rpc(lease.url, lease.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const body = (await listed.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((tool) => tool.name)).toEqual(BROWSER_TOOLS.map((tool) => tool.name));
});

test("initialize names the browser server, and the transport answers the spec's edges", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "session_one" });

  const init = await rpc(lease.url, lease.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initBody = (await init.json()) as { result: { serverInfo: { name: string }; capabilities: unknown } };
  expect(initBody.result.serverInfo.name).toBe("telar-browser");
  expect(initBody.result.capabilities).toEqual({ tools: {} });

  // A notification expects no answer — 202, empty.
  const note = await rpc(lease.url, lease.token, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(note.status).toBe(202);

  // GET is not part of this server (no SSE stream); DELETE is a session
  // teardown the spec allows a stateless server to answer 200.
  const got = await fetch(lease.url, { headers: { authorization: `Bearer ${lease.token}` } });
  expect(got.status).toBe(405);
  const deleted = await fetch(lease.url, { method: "DELETE", headers: { authorization: `Bearer ${lease.token}` } });
  expect(deleted.status).toBe(200);

  const unknown = await rpc(lease.url, lease.token, { jsonrpc: "2.0", id: 2, method: "resources/list" });
  expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  const badTool = await rpc(lease.url, lease.token, call("browser_teleport"));
  expect(((await badTool.json()) as { error: { code: number } }).error.code).toBe(-32602);
  const badArgs = await rpc(lease.url, lease.token, call("browser_navigate", { url: 7 }));
  expect(((await badArgs.json()) as { error: { code: number } }).error.code).toBe(-32602);
});

test("the token is the lock: absent, wrong, and RELEASED tokens are all 401", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "session_one" });

  expect((await rpc(lease.url, undefined, call("browser_snapshot"))).status).toBe(401);
  expect((await rpc(lease.url, "not-the-token", call("browser_snapshot"))).status).toBe(401);
  expect((await rpc(lease.url, lease.token, call("browser_snapshot"))).status).toBe(200);

  // Release IS revocation — the whole reason tokens are per-run.
  lease.release();
  expect((await rpc(lease.url, lease.token, call("browser_snapshot"))).status).toBe(401);
});

test("one run's token addresses ONE scope — two live leases cannot cross", async () => {
  const scopes: string[] = [];
  const socket = makeSocket(
    fakeCapability({
      call: async (scopeKey) => {
        scopes.push(scopeKey);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
  );
  const one = await socket.bind({ scopeKey: "session_one" });
  const two = await socket.bind({ scopeKey: "session_two" });
  await rpc(one.url, one.token, call("browser_navigate", { url: "http://x" }));
  await rpc(two.url, two.token, call("browser_navigate", { url: "http://x" }));
  expect(scopes).toEqual(["session_one", "session_two"]);
});

test("a declined gate answers isError WITHOUT reaching the browser; a throwing gate is a decline, not a hang", async () => {
  const calls: string[] = [];
  const socket = makeSocket(
    fakeCapability({
      call: async (_scope, name) => {
        calls.push(name);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
  );
  const declined = await socket.bind({ scopeKey: "s", gate: async () => false });
  const answer = (await (await rpc(declined.url, declined.token, call("browser_navigate", { url: "http://x" }))).json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  // An error RESULT, never a throw: a thrown handler reads to the model as a
  // broken tool and it retries; an error result reads as "you may not".
  expect(answer.result.isError).toBe(true);
  expect(answer.result.content[0]?.text).toContain("declined");
  expect(calls).toEqual([]);

  const throwing = await socket.bind({
    scopeKey: "s",
    gate: async () => {
      throw new Error("the engine went away");
    },
  });
  const thrown = (await (await rpc(throwing.url, throwing.token, call("browser_navigate", { url: "http://x" }))).json()) as {
    result: { isError?: boolean };
  };
  expect(thrown.result.isError).toBe(true);
  expect(calls).toEqual([]);
});

test("the gate hears reads AS reads, and an accepted call proceeds", async () => {
  const heard: { name: string; readOnly: boolean }[] = [];
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({
    scopeKey: "s",
    gate: async ({ name, readOnly }) => {
      heard.push({ name, readOnly });
      return true;
    },
  });
  expect((await rpc(lease.url, lease.token, call("browser_snapshot"))).status).toBe(200);
  expect((await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://x" }))).status).toBe(200);
  // The classification rides to the gate, which is what lets the worker
  // declare a read as `file_read` and the mode ladder auto-accept it.
  expect(heard).toEqual([
    { name: "browser_snapshot", readOnly: true },
    { name: "browser_navigate", readOnly: false },
  ]);
});

test("a call that CHANGED the page reports fresh state; reads and failures report nothing", async () => {
  const states: unknown[] = [];
  const socket = makeSocket(
    fakeCapability({
      call: async (_scope, name) => ({
        content: [{ type: "text", text: "ok" }],
        ...(name === "browser_click" ? { isError: true } : {}),
      }),
      isReadOnly: (name) => name === "browser_snapshot",
      tools: [
        { name: "browser_navigate", description: "go", input: z.object({ url: z.string() }) },
        { name: "browser_snapshot", description: "look", input: z.object({}) },
        { name: "browser_click", description: "click", input: z.object({}) },
      ],
      state: async () => ({ provider: "headless", tabs: [{ id: "0", url: "http://x", title: "X", active: true }] }),
    }),
  );
  const lease = await socket.bind({ scopeKey: "s", onNavigated: (state) => void states.push(state) });
  await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://x" }));
  // A READ must not trigger a state report: polling after every snapshot puts
  // a page listing behind each look at the DOM. A FAILED mutation moved
  // nothing worth describing either.
  await rpc(lease.url, lease.token, call("browser_snapshot"));
  await rpc(lease.url, lease.token, call("browser_click"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(states).toHaveLength(1);
  expect((states[0] as { tabs: { url: string }[] }).tabs[0]?.url).toBe("http://x");
});

test("state reads are SEQUENCED per binding — a redirect's reports land in order", async () => {
  // Two mutating calls in quick succession, the FIRST state read slower than
  // the second: unsequenced, the intermediate page would be reported last.
  const reported: string[] = [];
  let reads = 0;
  const socket = makeSocket(
    fakeCapability({
      isReadOnly: () => false,
      state: async () => {
        const which = ++reads;
        if (which === 1) await new Promise((resolve) => setTimeout(resolve, 30));
        return { provider: "headless", tabs: [{ id: "0", url: `http://page-${which}`, title: "P", active: true }] };
      },
    }),
  );
  const lease = await socket.bind({
    scopeKey: "s",
    onNavigated: (state) => void reported.push(state.tabs[0]?.url ?? "?"),
  });
  await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://a" }));
  await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://b" }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(reported).toEqual(["http://page-1", "http://page-2"]);
});

test("a browser whose state cannot be read still lets the tool call succeed", async () => {
  // A browser panel that cannot be described must never fail the navigation
  // that moved it — the agent asked to browse, not to be observed.
  const socket = makeSocket(
    fakeCapability({
      isReadOnly: () => false,
      state: async () => Promise.reject(new Error("the browser went away")),
    }),
  );
  const lease = await socket.bind({ scopeKey: "s", onNavigated: () => undefined });
  const answer = (await (await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://x" }))).json()) as {
    result: { isError?: boolean };
  };
  expect(answer.result.isError).toBeUndefined();
});

test("the listener is LAZY: a socket never bound opens no port", async () => {
  const socket = makeSocket(fakeCapability());
  expect(socket.url).toBeUndefined();
  const lease = await socket.bind({ scopeKey: "s" });
  expect(socket.url).toBe(lease.url);
  // Loopback, always — the token is the second lock, this is the first.
  expect(lease.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(lease.url.endsWith("/v2/browser/mcp")).toBe(true);
});

test("the socket serves ONE path — anything else is 404, even with a valid token", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "s" });
  const origin = new URL(lease.url).origin;
  const other = await fetch(`${origin}/v2/spool/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify(call("browser_snapshot")),
  });
  expect(other.status).toBe(404);
});
