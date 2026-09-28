import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { isReadOnlyBrowserCall } from "./helpers";
import { BROWSER_TOOLS } from "./tools";
import { type BrowserSocketCapability, BrowserToolSocket } from "./socket";

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
  const socket = makeSocket(fakeCapability({ tools: BROWSER_TOOLS }));
  const lease = await socket.bind({ scopeKey: "session_one" });
  const listed = await rpc(lease.url, lease.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const body = (await listed.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((tool) => tool.name)).toEqual(BROWSER_TOOLS.map((tool) => tool.name));
});

test("each mode of a merged tool reaches the gate classified as its old tool was, and the old names are gone", async () => {
  const heard: { name: string; args: Record<string, unknown>; readOnly: boolean }[] = [];
  const socket = makeSocket(fakeCapability({ tools: BROWSER_TOOLS, isReadOnly: isReadOnlyBrowserCall }));
  const lease = await socket.bind({
    scopeKey: "s",
    gate: async (input) => {
      heard.push(input);
      return true;
    },
  });
  const modes: [string, Record<string, unknown>, boolean][] = [
    ["browser_tabs", {}, true],
    ["browser_tabs", { action: "new" }, false],
    ["browser_tabs", { action: "select", index: 0 }, false],
    ["browser_tabs", { action: "close", index: 0 }, false],
    ["browser_navigate", { url: "https://example.com/" }, false],
    ["browser_navigate", { url: "back" }, false],
    ["browser_snapshot", {}, true],
    ["browser_snapshot", { screenshot: true, fullPage: true }, true],
    ["browser_logs", { kind: "console" }, true],
    ["browser_logs", { kind: "network", filter: "/api" }, true],
    ["browser_type", { text: "hi" }, false],
    ["browser_type", { key: "Enter" }, false],
  ];
  for (const [name, args] of modes) expect((await rpc(lease.url, lease.token, call(name, args))).status).toBe(200);
  expect(heard.map(({ name, readOnly }) => [name, readOnly])).toEqual(modes.map(([name, , readOnly]) => [name, readOnly]));
  expect(heard[0]?.args.action).toBe("list");

  for (const old of ["browser_list_tabs", "browser_navigate_back", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_press_key"]) {
    const answer = (await (await rpc(lease.url, lease.token, call(old))).json()) as { error?: { code: number } };
    expect(answer.error?.code).toBe(-32602);
  }
});

test("browser_logs answers are bounded by their kind, each naming its own narrowing argument", async () => {
  const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
  const socket = makeSocket(fakeCapability({ tools: BROWSER_TOOLS, call: async () => ({ content: [{ type: "text", text: lines }] }) }));
  const lease = await socket.bind({ scopeKey: "s" });
  const textOf = async (args: Record<string, unknown>) =>
    ((await (await rpc(lease.url, lease.token, call("browser_logs", args))).json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
  const consoleText = await textOf({ kind: "console" });
  const networkText = await textOf({ kind: "network" });
  expect(consoleText).toContain("narrow with `level`");
  expect(networkText).toContain("narrow with `filter`");
  expect(consoleText).toContain("line 1999");
  expect(consoleText).not.toContain("line 0 ");
});

test("initialize names the browser server, and the transport answers the spec's edges", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "session_one" });

  const init = await rpc(lease.url, lease.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initBody = (await init.json()) as { result: { serverInfo: { name: string }; capabilities: unknown } };
  expect(initBody.result.serverInfo.name).toBe("telar-browser");
  expect(initBody.result.capabilities).toEqual({ tools: {} });

  const note = await rpc(lease.url, lease.token, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(note.status).toBe(202);

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
  expect(heard).toEqual([
    { name: "browser_snapshot", readOnly: true },
    { name: "browser_navigate", readOnly: false },
  ]);
});

test("an unchanged tab set reports once; a failed call reports nothing", async () => {
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
  await rpc(lease.url, lease.token, call("browser_snapshot"));
  await rpc(lease.url, lease.token, call("browser_click"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(states).toHaveLength(1);
  expect((states[0] as { tabs: { url: string }[] }).tabs[0]?.url).toBe("http://x");
});

test("a READ-ONLY call whose tabs changed still reports — a session that only reads has pages too", async () => {
  const states: string[] = [];
  let reads = 0;
  const socket = makeSocket(
    fakeCapability({
      isReadOnly: () => true,
      tools: [{ name: "browser_snapshot", description: "look", input: z.object({}) }],
      state: async () => ({
        provider: "headless",
        tabs: [{ id: "0", url: `http://page-${++reads}`, title: "P", active: true }],
      }),
    }),
  );
  const lease = await socket.bind({ scopeKey: "s", onNavigated: (state) => void states.push(state.tabs[0]?.url ?? "?") });
  await rpc(lease.url, lease.token, call("browser_snapshot"));
  await rpc(lease.url, lease.token, call("browser_snapshot"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(states).toEqual(["http://page-1", "http://page-2"]);
});

test("state reads are SEQUENCED per binding — a redirect's reports land in order", async () => {
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

test("a stalled state reporter cannot strand an already successful browser action", async () => {
  const socket = makeSocket(fakeCapability({
    state: async () => ({ provider: "headless", tabs: [] }),
  }));
  const lease = await socket.bind({
    scopeKey: "s",
    onNavigated: () => new Promise<void>(() => {}),
  });
  const answer = await (await rpc(lease.url, lease.token, call("browser_navigate", { url: "http://x" }))).json() as {
    result: { isError?: boolean };
  };
  expect(answer.result.isError).toBeUndefined();
});

test("the listener is LAZY: a socket never bound opens no port", async () => {
  const socket = makeSocket(fakeCapability());
  expect(socket.url).toBeUndefined();
  const lease = await socket.bind({ scopeKey: "s" });
  expect(socket.url).toBe(lease.url);
  expect(lease.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(lease.url.endsWith("/v2/browser/mcp")).toBe(true);
});

test("the socket serves ONE path — anything else is 404, even with a valid token", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "s" });
  const origin = new URL(lease.url).origin;
  const other = await fetch(`${origin}/v2/sessions/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify(call("browser_snapshot")),
  });
  expect(other.status).toBe(404);
});

const fillSecretTool = {
  name: "browser_fill_secret",
  description: "fill",
  input: z.object({ fields: z.array(z.object({ target: z.string(), kind: z.string() })) }),
};

test("browser_fill_secret routes to the binding's handler — NEVER through the generic gate or the capability", async () => {
  const gateSaw: string[] = [];
  const capabilitySaw: string[] = [];
  const handlerSaw: Record<string, unknown>[] = [];
  const socket = makeSocket(
    fakeCapability({
      tools: [fillSecretTool],
      call: async (_scope, name) => {
        capabilitySaw.push(name);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
  );
  const lease = await socket.bind({
    scopeKey: "s",
    gate: async ({ name }) => {
      gateSaw.push(name);
      return true;
    },
    fillSecret: async (args, callBrowser) => {
      handlerSaw.push(args);
      await callBrowser("browser_tabs", { action: "list" });
      return { content: [{ type: "text", text: "Filled username from “GitHub” on https://github.com." }] };
    },
  });
  const answer = (await (
    await rpc(lease.url, lease.token, call("browser_fill_secret", { fields: [{ target: "e1", kind: "username" }] }))
  ).json()) as { result: { isError?: boolean; content: { text?: string }[] } };

  expect(answer.result.isError).toBeUndefined();
  expect(answer.result.content[0]?.text).toContain("Filled username");
  expect(handlerSaw).toHaveLength(1);
  expect(gateSaw).toEqual([]);
  expect(capabilitySaw).toEqual(["browser_tabs"]);
});

test("without a handler, browser_fill_secret answers a sentence — not a hang, not a crash", async () => {
  const socket = makeSocket(fakeCapability({ tools: [fillSecretTool] }));
  const lease = await socket.bind({ scopeKey: "s" });
  const answer = (await (
    await rpc(lease.url, lease.token, call("browser_fill_secret", { fields: [{ target: "e1", kind: "username" }] }))
  ).json()) as { result: { isError?: boolean; content: { text?: string }[] } };
  expect(answer.result.isError).toBe(true);
  expect(answer.result.content[0]?.text).toContain("not available");
});

test("a file: URL is fenced at the socket — refused before the gate and before the browser", async () => {
  const gateAsked: string[] = [];
  const called: string[] = [];
  const socket = makeSocket(
    fakeCapability({
      call: async (_scope, name) => {
        called.push(name);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
  );
  const lease = await socket.bind({
    scopeKey: "session_one",
    workspaceRoot: "/tmp/telar-checkout",
    gate: async ({ name }) => {
      gateAsked.push(name);
      return true;
    },
  });

  const outside = await rpc(lease.url, lease.token, call("browser_navigate", { url: "file:///etc/hosts" }));
  const outsideBody = (await outside.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(outsideBody.result.isError).toBe(true);
  expect(outsideBody.result.content[0]!.text).toMatch(/checkout/);
  expect(gateAsked).toEqual([]);
  expect(called).toEqual([]);

  const inside = await rpc(lease.url, lease.token, call("browser_navigate", { url: "file:///tmp/telar-checkout/guide.html" }));
  const insideBody = (await inside.json()) as { result: { isError?: boolean } };
  expect(insideBody.result.isError).toBeUndefined();
  expect(gateAsked).toEqual(["browser_navigate"]);
  expect(called).toEqual(["browser_navigate"]);
});

test("a binding with NO workspace refuses every file: URL — the fence fails closed", async () => {
  const socket = makeSocket(fakeCapability());
  const lease = await socket.bind({ scopeKey: "session_one" });
  const refused = await rpc(lease.url, lease.token, call("browser_navigate", { url: "file:///tmp/anything.html" }));
  const body = (await refused.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]!.text).toMatch(/cannot open file URLs/);
});
