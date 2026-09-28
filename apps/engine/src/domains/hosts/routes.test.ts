import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Route } from "../../platform/http/route";
import { matchRoute } from "../../platform/http/router";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";
import { hostsRoutes } from "./routes";
import { createHostsStore } from "./store";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PAIRING_URL = "http://Mini.Tail:3000/pair#token=12345678";

function otherMac(pair: (body: Record<string, unknown>) => Response | Promise<Response>): { fetcher: typeof fetch; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/pair")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(body);
      return pair(body);
    }
    if (url.endsWith("/api/health")) return Response.json({ daemonId: "daemon_mini", hostname: "mini" });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetcher, seen };
}

function routes(fetcher: typeof fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-routes-"));
  roots.push(dir);
  const store = createHostsStore(path.join(dir, "remote"));
  const table = hostsRoutes(store, fetcher);
  const call = async (method: Route["method"], pathname: string, body: Record<string, unknown> = {}) => {
    const { route, params } = matchRoute(table, method, pathname)!;
    return route.handle({ body, params, query: new URLSearchParams() });
  };
  return { call, store };
}

test("pairing with another Mac stores its token and answers without it", async () => {
  const mac = otherMac(() => Response.json({ deviceToken: "tlr_other" }));
  const { call, store } = routes(mac.fetcher);

  const added = await call("POST", "/v2/hosts", { pairingUrl: PAIRING_URL, deviceName: "Studio" });
  expect(added).toMatchObject({ status: 200, body: { host: { name: "mini", baseUrl: "http://mini.tail:3000", daemonId: "daemon_mini" } } });
  expect(mac.seen).toEqual([{ token: "12345678", deviceName: "Studio", kind: "desktop", client: "Telar", os: "macOS" }]);
  expect(store.read().hosts[0]!.deviceToken).toBe("tlr_other");
  expect(JSON.stringify(added.body)).not.toContain("tlr_other");
  expect(JSON.stringify((await call("GET", "/v2/hosts")).body)).not.toContain("tlr_other");
});

test("a refused, unreachable or malformed pairing stores nothing", async () => {
  const refused = routes(otherMac(() => Response.json({ error: { message: "That pairing code has expired." } }, { status: 401 })).fetcher);
  expect(await refused.call("POST", "/v2/hosts", { pairingUrl: PAIRING_URL })).toMatchObject({
    status: 502,
    body: { error: { code: "cockpit_pairing_refused", message: "That pairing code has expired." } },
  });

  const unreachable = routes(otherMac(() => Promise.reject(new Error("offline"))).fetcher);
  expect((await unreachable.call("POST", "/v2/hosts", { pairingUrl: PAIRING_URL })).status).toBe(503);

  const malformed = routes(otherMac(() => Response.json({})).fetcher);
  expect((await malformed.call("POST", "/v2/hosts", { pairingUrl: "http://mini:3000/pair?token=12345678" })).status).toBe(400);

  for (const { store } of [refused, unreachable, malformed]) expect(store.read().hosts).toEqual([]);
});

test("rename and forget a host", async () => {
  const { call, store } = routes(otherMac(() => Response.json({ deviceToken: "tlr_other" })).fetcher);
  const { body } = await call("POST", "/v2/hosts", { pairingUrl: PAIRING_URL });
  const id = (body as { host: { id: string } }).host.id;
  expect(await call("PATCH", `/v2/hosts/${id}`, { name: "Studio" })).toMatchObject({ status: 200, body: { host: { name: "Studio" } } });
  expect((await call("PATCH", `/v2/hosts/${id}`, {})).status).toBe(400);
  expect((await call("DELETE", `/v2/hosts/${id}`)).status).toBe(200);
  expect((await call("DELETE", `/v2/hosts/${id}`)).status).toBe(404);
  expect(store.read().hosts).toEqual([]);
});

test("the engine serves the hosts book behind its token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-engine-"));
  roots.push(home);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  const get = (token: string) => fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/hosts`, { headers: { authorization: `Bearer ${token}` } });
  expect(await (await get(daemon.discovery.token)).json()).toEqual({ hosts: [] });
  expect((await get("wrong")).status).toBe(401);
});

test("the engine forwards a host's /api to that Mac with its device token, streaming the answer", async () => {
  const seen: { url: string; authorization: string | null; hostSecret: string | null; body: string }[] = [];
  const mac = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      seen.push({ url: request.url, authorization: request.headers.get("authorization"), hostSecret: request.headers.get("x-telar-host"), body: await request.text() });
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions/s1/run/stream") {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ echoed: url.pathname + url.search }, { headers: { "set-cookie": "telar_device=leak" } });
    },
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-forward-"));
  roots.push(home);
  const remoteDir = path.join(home, "remote");
  const host = createHostsStore(remoteDir).add({ baseUrl: `http://127.0.0.1:${mac.port}`, deviceToken: "tlr_remote", name: "mini" });
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(home, "engine"), remoteDir });
  daemons.push(daemon);
  const call = (tail: string, init: RequestInit = {}, token = daemon.discovery.token) =>
    fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/hosts/${tail}`, { ...init, headers: { authorization: `Bearer ${token}`, "x-telar-host": "tlr_local", ...init.headers } });
  try {
    const read = await call(`${host.id}/api/projects/a%20b?x=1`);
    expect(await read.json()).toEqual({ echoed: "/api/projects/a%20b?x=1" });
    expect(read.headers.get("set-cookie")).toBeNull();
    expect(read.headers.get("telar-host")).toBe("mini");
    const write = await call(`${host.id}/api/sessions/s1/turns`, { method: "POST", body: JSON.stringify({ input: "hi" }), headers: { "content-type": "application/json" } });
    expect(write.status).toBe(200);
    expect(seen.at(-1)!.body).toBe(JSON.stringify({ input: "hi" }));
    expect(seen.every((s) => s.authorization === "Bearer tlr_remote" && s.hostSecret === null)).toBe(true);
    expect(await (await call(`${host.id}/api/sessions/s1/run/stream`)).text()).toBe("data: 1\n\n");
    expect((await call("host_nope/api/projects")).status).toBe(404);
    expect((await call(`${host.id}/api/projects`, {}, "wrong")).status).toBe(401);
  } finally {
    mac.stop(true);
  }
});
