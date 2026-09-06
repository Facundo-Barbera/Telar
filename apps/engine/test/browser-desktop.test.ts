/**
 * The desktop-host client and the router that finally consume
 * `TELAR_DESKTOP_BROWSER_CONTROL_{PORT,TOKEN}` — driven against a real
 * loopback HTTP server speaking the control server's own wire shape
 * (`apps/desktop/browser-control-server.js`: GET /state?scopeKey, POST /tool).
 */
import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import { BrowserRouter, DesktopBrowserClient, desktopBrowserFromEnv, type BrowserRuntime } from "../src/browser";
import { textOf } from "../src/browser/helpers";

type Handler = (input: { method: string; url: URL; auth: string | undefined; body: Record<string, unknown> }) => {
  status: number;
  payload: unknown;
};

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function fakeHost(handler: Handler): Promise<number> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      const answer = handler({
        method: request.method ?? "GET",
        url: new URL(request.url ?? "/", "http://127.0.0.1"),
        auth: request.headers.authorization,
        body,
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.payload));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

test("desktopBrowserFromEnv reads the shell's env pair and refuses halves", () => {
  expect(desktopBrowserFromEnv({})).toBeUndefined();
  expect(desktopBrowserFromEnv({ TELAR_DESKTOP_BROWSER_CONTROL_PORT: "4100" })).toBeUndefined();
  expect(desktopBrowserFromEnv({ TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: "t" })).toBeUndefined();
  expect(desktopBrowserFromEnv({ TELAR_DESKTOP_BROWSER_CONTROL_PORT: "not-a-port", TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: "t" })).toBeUndefined();
  expect(
    desktopBrowserFromEnv({ TELAR_DESKTOP_BROWSER_CONTROL_PORT: "4100", TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: "t" }),
  ).toBeInstanceOf(DesktopBrowserClient);
});

test("calls hit POST /tool with the bearer, normalized name and validated args", async () => {
  const seen: Record<string, unknown>[] = [];
  const port = await fakeHost(({ method, url, auth, body }) => {
    if (method === "GET" && url.pathname === "/state") return { status: 200, payload: { tabs: [] } };
    expect(auth).toBe("Bearer tok");
    expect(url.pathname).toBe("/tool");
    seen.push(body);
    return { status: 200, payload: { content: [{ type: "text", text: "ok from host" }] } };
  });
  const client = new DesktopBrowserClient({ port, token: "tok" });
  // Telar's read-only alias is the ENGINE's vocabulary; the host speaks
  // browser_tabs — the client translates, exactly like the headless runtime.
  const listed = await client.call("session_one", "browser_list_tabs", {});
  expect(textOf(listed)).toBe("ok from host");
  expect(seen[0]).toEqual({ scopeKey: "session_one", name: "browser_tabs", args: { action: "list" } });
});

test("invalid arguments are refused on THIS side of the wire, naming the field", async () => {
  let hit = 0;
  const port = await fakeHost(() => {
    hit += 1;
    return { status: 200, payload: {} };
  });
  const client = new DesktopBrowserClient({ port, token: "tok" });
  const result = await client.call("s", "browser_navigate", { url: "not-a-url" });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("url");
  expect(hit).toBe(0);
});

test("browser_fill_secret never reaches the host — the socket owns it", async () => {
  let hit = 0;
  const port = await fakeHost(() => {
    hit += 1;
    return { status: 200, payload: {} };
  });
  const client = new DesktopBrowserClient({ port, token: "tok" });
  const result = await client.call("s", "browser_fill_secret", { fields: [{ target: "e1", kind: "password" }] });
  expect(result.isError).toBe(true);
  expect(hit).toBe(0);
});

test("a host that quit answers an error RESULT, not a throw", async () => {
  const port = await fakeHost(() => ({ status: 200, payload: {} }));
  const client = new DesktopBrowserClient({ port, token: "tok" });
  await new Promise((resolve) => servers.pop()!.close(resolve));
  const result = await client.call("s", "browser_snapshot", {});
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("did not answer");
});

test("reachable(): ok host yes, wrong token no, dead host no — and the answer is cached", async () => {
  let probes = 0;
  const port = await fakeHost(({ auth }) => {
    probes += 1;
    return auth === "Bearer good" ? { status: 200, payload: { tabs: [] } } : { status: 401, payload: { error: "Unauthorized." } };
  });
  const good = new DesktopBrowserClient({ port, token: "good", probeTtlMs: 60_000 });
  expect(await good.reachable()).toBe(true);
  expect(await good.reachable()).toBe(true);
  expect(probes).toBe(1); // cached

  const bad = new DesktopBrowserClient({ port, token: "bad" });
  expect(await bad.reachable()).toBe(false);

  const dead = new DesktopBrowserClient({ port: 1, token: "good" });
  expect(await dead.reachable()).toBe(false);
});

// ── the router ─────────────────────────────────────────────────────────────

function fakeHeadless(log: string[]): BrowserRuntime {
  return {
    call: async (_scope: string, name: string) => {
      log.push(`headless:${name}`);
      return { content: [{ type: "text", text: "headless answered" }] };
    },
    isReadOnly: () => false,
    state: async (scopeKey: string) => ({ scopeKey, provider: "headless", running: false, tabs: [], screenshot: null, error: null }),
    release: async () => true,
    close: async () => undefined,
  } as unknown as BrowserRuntime;
}

test("the router prefers a reachable desktop host and falls back when it dies", async () => {
  const state = { tabs: [{ index: 0, title: "Example", url: "https://example.com", active: true }], controller: "agent" };
  const port = await fakeHost(({ method, url }) => {
    if (method === "GET" && url.pathname === "/state") return { status: 200, payload: state };
    return { status: 200, payload: { content: [{ type: "text", text: "desktop answered" }] } };
  });
  const log: string[] = [];
  const desktop = new DesktopBrowserClient({ port, token: "tok", probeTtlMs: 0 });
  const router = new BrowserRouter(fakeHeadless(log), desktop);

  const viaDesktop = await router.call("s", "browser_snapshot", {});
  expect(textOf(viaDesktop)).toBe("desktop answered");
  const routed = await router.state("s", { screenshot: false });
  expect(routed.provider).toBe("attached");
  expect(routed.tabs).toEqual([{ id: "0", url: "https://example.com", title: "Example", active: true }]);
  expect(log).toEqual([]);

  await new Promise((resolve) => servers.pop()!.close(resolve));
  const fallback = await router.call("s", "browser_snapshot", {});
  expect(textOf(fallback)).toBe("headless answered");
  expect(log).toEqual(["headless:browser_snapshot"]);
  expect((await router.state("s")).provider).toBe("headless");
});

test("without a desktop client the router IS the headless runtime", async () => {
  const log: string[] = [];
  const router = new BrowserRouter(fakeHeadless(log));
  await router.call("s", "browser_navigate", { url: "https://example.com" });
  expect(log).toEqual(["headless:browser_navigate"]);
});

test("a profile declared while desktop is offline is restored before opening and after host restart", async () => {
  // A host that is only reachable AFTER `up` flips true — the initial reads
  // 503 (unreachable), later 200. `probeTtlMs: 0` so reachability is re-probed.
  const hits: string[] = [];
  let up = false;
  let bound = false;
  const port = await fakeHost(({ method, url, body }) => {
    if (method === "GET" && url.pathname === "/state") {
      if (!up) return { status: 503, payload: { error: "not ready" } };
      return { status: 200, payload: { provider: "attached", running: true, tabs: [] } };
    }
    if (url.pathname === "/bind") { bound = true; hits.push(`bind:${String(body.profileKey)}`); return { status: 200, payload: { scopeKey: body.scopeKey, profileKey: body.profileKey, partition: "persist:telar-project-x" } }; }
    if (url.pathname === "/open" || url.pathname === "/tool") {
      hits.push(url.pathname);
      if (!bound) return { status: 400, payload: { error: "not bound" } };
      return { status: 200, payload: { running: true, tabs: [{ index: 0, title: "New tab", url: "about:blank", active: true }], content: [{ type: "text", text: "ready" }] } };
    }
    return { status: 200, payload: { content: [] } };
  });
  const desktop = new DesktopBrowserClient({ port, token: "tok", probeTtlMs: 0 });
  const router = new BrowserRouter(fakeHeadless([]), desktop);

  // Unreachable: bindProfile forwards nothing (the scope never gets a /bind).
  await router.bindProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(hits).toEqual([]);

  // The host comes up between declaration and start, with no second declaration.
  up = true;
  const opened = await router.state("s", { start: true, screenshot: false });
  expect(opened.error).toBeNull();
  expect(opened.tabs).toHaveLength(1);
  expect(hits).toEqual(["bind:project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/open"]);
  // A fresh host has lost its bindings, but the agent's next call still works.
  bound = false;
  hits.length = 0;
  expect(textOf(await router.call("s", "browser_snapshot"))).toBe("ready");
  expect(hits).toEqual(["bind:project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/tool"]);
  await expect(router.bindProfile("s", "project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toThrow(/different project/);
});

test("a rejected profile restore prevents both opening and agent calls", async () => {
  let up = false;
  const actions: string[] = [];
  const port = await fakeHost(({ url }) => {
    if (!up) return { status: 503, payload: { error: "offline" } };
    if (url.pathname === "/bind") return { status: 409, payload: { error: "profile conflict" } };
    if (url.pathname === "/open" || url.pathname === "/tool") actions.push(url.pathname);
    return { status: 200, payload: { running: true, tabs: [] } };
  });
  const router = new BrowserRouter(fakeHeadless([]), new DesktopBrowserClient({ port, token: "tok", probeTtlMs: 0 }));
  await router.bindProfile("s", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  up = true;
  expect((await router.state("s", { start: true })).error).toContain("profile conflict");
  await expect(router.call("s", "browser_snapshot")).rejects.toThrow(/profile conflict/);
  expect(actions).toEqual([]);
});

// ── starting a browser by hand, on the desktop branch ──────────────────────

function hostWithTabs(initial: { index: number; title: string; url: string; active: boolean; openedBy?: string }[], options: { openFails?: string } = {}) {
  const tabs = [...initial];
  const opens: Record<string, unknown>[] = [];
  const port = fakeHost(({ method, url, body }) => {
    if (method === "GET" && url.pathname === "/state") return { status: 200, payload: { running: true, tabs } };
    if (method === "POST" && url.pathname === "/open") {
      opens.push(body);
      if (options.openFails) return { status: 400, payload: { error: options.openFails } };
      tabs.push({ index: tabs.length, title: "New tab", url: String(body.url ?? "about:blank"), active: true, openedBy: "human" });
      return { status: 200, payload: { running: true, tabs } };
    }
    return { status: 200, payload: { content: [{ type: "text", text: "" }] } };
  });
  return { port, opens, tabs };
}

test("start on a desktop scope with no tabs opens one AS THE HUMAN", async () => {
  const { port, opens } = hostWithTabs([]);
  const router = new BrowserRouter(fakeHeadless([]), new DesktopBrowserClient({ port: await port, token: "tok", probeTtlMs: 0 }));
  const before = await router.state("s", { screenshot: false });
  expect(before.tabs).toEqual([]);
  expect(opens).toEqual([]); // a plain read never starts anything

  const started = await router.state("s", { start: true, screenshot: false });
  expect(started.error).toBeNull();
  expect(started.tabs).toHaveLength(1);
  expect(started.tabs[0]).toMatchObject({ active: true, openedBy: "human" });
  expect(opens).toEqual([{ scopeKey: "s", url: "about:blank" }]);
});

test("a repeated start is idempotent — a scope that already has a tab opens nothing", async () => {
  const { port, opens } = hostWithTabs([{ index: 0, title: "Example", url: "https://example.com", active: true, openedBy: "agent" }]);
  const router = new BrowserRouter(fakeHeadless([]), new DesktopBrowserClient({ port: await port, token: "tok", probeTtlMs: 0 }));
  const first = await router.state("s", { start: true, screenshot: false });
  const second = await router.state("s", { start: true, screenshot: false });
  expect(first.tabs).toHaveLength(1);
  expect(second.tabs).toHaveLength(1);
  expect(opens).toEqual([]);
});

test("a host that refuses to open answers the host's own error, not a throw", async () => {
  const { port } = hostWithTabs([], { openFails: "Tab limit reached (8 per session). Close a tab first." });
  const router = new BrowserRouter(fakeHeadless([]), new DesktopBrowserClient({ port: await port, token: "tok", probeTtlMs: 0 }));
  const state = await router.state("s", { start: true, screenshot: false });
  expect(state.provider).toBe("attached");
  expect(state.tabs).toEqual([]);
  expect(state.error).toContain("Tab limit reached");
});

test("concurrent starts on one scope open exactly one tab", async () => {
  const { port, opens } = hostWithTabs([]);
  const router = new BrowserRouter(fakeHeadless([]), new DesktopBrowserClient({ port: await port, token: "tok", probeTtlMs: 60_000 }));
  const results = await Promise.all(Array.from({ length: 5 }, () => router.state("s", { start: true, screenshot: false })));
  expect(opens).toHaveLength(1);
  for (const result of results) {
    expect(result.error).toBeNull();
    expect(result.tabs).toHaveLength(1);
  }
  // And a later start, after the flight has landed, still opens nothing new.
  const later = await router.state("s", { start: true, screenshot: false });
  expect(later.tabs).toHaveLength(1);
  expect(opens).toHaveLength(1);
});

test("bind() posts the scope's project profile to /bind and surfaces the host's refusal", async () => {
  const binds: Record<string, unknown>[] = [];
  const port = await fakeHost(({ url, body, auth }) => {
    if (auth !== "Bearer t") return { status: 401, payload: { error: "Unauthorized." } };
    if (url.pathname === "/bind") {
      binds.push(body);
      if (body.profileKey === "session_x") return { status: 400, payload: { error: "Browser profile key must be a project id" } };
      return { status: 200, payload: { scopeKey: body.scopeKey, profileKey: body.profileKey, partition: `persist:telar-project-${String(body.profileKey).slice(8)}` } };
    }
    return { status: 200, payload: { provider: "attached", running: true, tabs: [] } };
  });
  const client = new DesktopBrowserClient({ port, token: "t" });
  const ok = await client.bind("session_one", "project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(ok.partition).toBe("persist:telar-project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await expect(client.bind("session_one", "session_x")).rejects.toThrow(/project id/);
  expect(binds).toHaveLength(2);
  // The router forwards to the desktop host when reachable and is a no-op headless.
  const router = new BrowserRouter({ call: async () => ({ content: [] }), isReadOnly: () => true, state: async () => ({ scopeKey: "s", provider: "headless", running: false, tabs: [], screenshot: null, error: null }), release: async () => true, close: async () => undefined } as unknown as BrowserRuntime, client);
  await router.bindProfile("session_two", "none");
  expect(binds.at(-1)).toMatchObject({ scopeKey: "session_two", profileKey: "none" });
});
