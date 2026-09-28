import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchRoute } from "../../platform/http/router";
import { authRoutes, decideAccess, EXEMPT_PATHS, type Credentials } from "./auth";
import { createRemoteStore, hashToken, type DeviceRole, type RemoteFile } from "./store";

const RAW = "tlr_" + "a".repeat(43);

function file(overrides: Partial<RemoteFile> = {}, role: DeviceRole = "full"): RemoteFile {
  return {
    version: 1,
    requireAuth: true,
    devices: [{ id: "dev_1", name: "Phone", tokenHash: hashToken(RAW), createdAt: 1, role }],
    ...overrides,
  };
}

function ask(
  pathname: string,
  credentials: { authorization?: string; deviceCookie?: string; method?: string } = {},
  remote = file(),
) {
  return decideAccess(
    remote,
    {
      pathname,
      method: credentials.method ?? "GET",
      authorization: credentials.authorization ?? null,
      deviceCookie: credentials.deviceCookie ?? null,
    },
    undefined,
  );
}

describe("api gate", () => {
  test("everything passes while requireAuth is off", () => {
    expect(ask("/api/health", {}, file({ requireAuth: false }))).toEqual({ allow: true });
  });

  test("a tokenless request is refused once requireAuth is on", () => {
    expect(ask("/api/sessions/live")).toEqual({ allow: false, code: "cockpit_unauthorized" });
  });

  test("/api/health is gated by name — it identifies the daemon", () => {
    expect(ask("/api/health")).toEqual({ allow: false, code: "cockpit_unauthorized" });
  });

  test("the exemptions answer strangers", () => {
    for (const pathname of EXEMPT_PATHS) {
      expect(ask(pathname)).toEqual({ allow: true });
    }
  });

  test("a bearer token admits the device", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}` })).toEqual({ allow: true, deviceId: "dev_1", role: "full" });
  });

  test("the cookie admits a paired browser", () => {
    expect(ask("/api/health", { deviceCookie: RAW })).toEqual({ allow: true, deviceId: "dev_1", role: "full" });
  });

  test("the bearer wins over the cookie when both are present", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}`, deviceCookie: "tlr_wrong" })).toEqual({
      allow: true,
      deviceId: "dev_1",
      role: "full",
    });
  });

  test("a revoked device's token is refused", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}` }, file({ devices: [] }))).toEqual({
      allow: false,
      code: "cockpit_unauthorized",
    });
  });

  test("a malformed authorization header is refused, not crashed on", () => {
    expect(ask("/api/health", { authorization: "Bearer not-a-telar-token" })).toEqual({
      allow: false,
      code: "cockpit_unauthorized",
    });
    expect(ask("/api/health", { authorization: "Basic dXNlcg==" })).toEqual({
      allow: false,
      code: "cockpit_unauthorized",
    });
  });

  test("a full device may write", () => {
    expect(ask("/api/sessions/x/turns", { authorization: `Bearer ${RAW}`, method: "POST" })).toEqual({
      allow: true,
      deviceId: "dev_1",
      role: "full",
    });
  });

  test("an observer may GET and HEAD, nothing else", () => {
    const observer = file({}, "observer");
    expect(ask("/api/health", { authorization: `Bearer ${RAW}` }, observer)).toEqual({
      allow: true,
      deviceId: "dev_1",
      role: "observer",
    });
    expect(ask("/api/health", { authorization: `Bearer ${RAW}`, method: "HEAD" }, observer)).toEqual({
      allow: true,
      deviceId: "dev_1",
      role: "observer",
    });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(ask("/api/sessions/x/turns", { authorization: `Bearer ${RAW}`, method }, observer)).toEqual({
        allow: false,
        code: "cockpit_forbidden",
      });
    }
  });

  test("an observer cannot escalate itself — the device routes are writes too", () => {
    expect(ask("/api/remote/devices/dev_1", { authorization: `Bearer ${RAW}`, method: "PATCH" }, file({}, "observer"))).toEqual({
      allow: false,
      code: "cockpit_forbidden",
    });
  });

  test("the pairing exchange stays open to an observer's POST — it is exempt by path", () => {
    expect(ask("/api/pair", { method: "POST" }, file({}, "observer"))).toEqual({ allow: true });
  });
});

describe("the process that runs the server", () => {
  const HOST = "tlr_" + "h".repeat(43);
  const file = { version: 1 as const, requireAuth: true, devices: [] };
  const asHost = (credentials: { deviceCookie?: string; hostHeader?: string; method?: string }, secret: string | null = HOST) =>
    decideAccess(
      file,
      {
        pathname: "/api/projects",
        method: credentials.method ?? "GET",
        authorization: null,
        deviceCookie: credentials.deviceCookie ?? null,
        hostHeader: credentials.hostHeader ?? null,
      },
      secret ?? undefined,
    );

  test("the host's secret is a full-role caller without a device record", () => {
    expect(asHost({ deviceCookie: HOST, method: "POST" })).toEqual({ allow: true, role: "full" });
  });

  test("the header alone admits the host, with no cookie at all", () => {
    expect(asHost({ hostHeader: HOST, method: "POST" })).toEqual({ allow: true, role: "full" });
  });

  test("a near-miss header is refused, by length and by content", () => {
    expect(asHost({ hostHeader: HOST + "x" }).allow).toBe(false);
    expect(asHost({ hostHeader: HOST.slice(0, -1) + "z" }).allow).toBe(false);
    expect(asHost({ hostHeader: HOST.slice(0, -1) }).allow).toBe(false);
  });

  test("with no secret set, an empty header is not a pass either", () => {
    expect(asHost({ deviceCookie: "" }, null)).toEqual({ allow: false, code: "cockpit_unauthorized" });
    expect(asHost({ hostHeader: "" }, null)).toEqual({ allow: false, code: "cockpit_unauthorized" });
    expect(asHost({ hostHeader: HOST }, null)).toEqual({ allow: false, code: "cockpit_unauthorized" });
  });

  test("a wrong header does not spoil a right cookie", () => {
    expect(asHost({ hostHeader: "tlr_stale", deviceCookie: HOST })).toEqual({ allow: true, role: "full" });
  });

  test("a near-miss is still refused", () => {
    expect(asHost({ deviceCookie: HOST + "x" }).allow).toBe(false);
    expect(asHost({ deviceCookie: HOST.slice(0, -1) + "z" }).allow).toBe(false);
  });
});

describe("the routes the cockpit asks", () => {
  const HOST = "tlr_" + "h".repeat(43);
  function routes() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-auth-"));
    const store = createRemoteStore(path.join(home, "remote"));
    const raw = "tlr_" + "p".repeat(43);
    const device = store.addDevice("Phone", raw);
    store.setRequireAuth(true);
    const table = authRoutes(store, () => HOST);
    const call = (route: string, body: Record<string, unknown>) =>
      matchRoute(table, "POST", route)!.route.handle({ body, params: [], query: new URLSearchParams() });
    return { store, device, raw, call, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  test("decide answers the gate and stamps the admitted device", async () => {
    const { store, device, raw, call, cleanup } = routes();
    try {
      expect((await call("/v2/auth/decide", { pathname: "/api/projects", method: "GET" })).body).toEqual({ allow: false, code: "cockpit_unauthorized" });
      expect((await call("/v2/auth/decide", { pathname: "/api/projects", method: "GET", authorization: `Bearer ${raw}` })).body).toEqual({ allow: true, deviceId: device.id, role: "full" });
      expect(store.read().devices[0]!.lastSeenAt).toBeGreaterThan(0);
      expect((await call("/v2/auth/decide", { pathname: "/api/projects", method: "POST", hostHeader: HOST })).body).toEqual({ allow: true, role: "full" });
      expect((await call("/v2/auth/decide", { method: "GET" })).status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("identify names the device and the host without deciding anything", async () => {
    const { device, raw, call, cleanup } = routes();
    try {
      const credentials: Credentials = { deviceCookie: raw };
      expect((await call("/v2/auth/identify", credentials)).body).toEqual({ host: false, device: { id: device.id, role: "full" } });
      expect((await call("/v2/auth/identify", { hostHeader: HOST })).body).toEqual({ host: true });
      expect((await call("/v2/auth/identify", {})).body).toEqual({ host: false });
    } finally {
      cleanup();
    }
  });
});
