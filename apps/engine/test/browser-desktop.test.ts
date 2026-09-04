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
