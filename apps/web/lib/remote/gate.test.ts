// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { decideApiAccess, EXEMPT_API_PATHS } from "./gate";
import { hashToken, type DeviceRole, type RemoteFile } from "./store";

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
  return decideApiAccess(
    {
      pathname,
      method: credentials.method ?? "GET",
      authorization: credentials.authorization ?? null,
      deviceCookie: credentials.deviceCookie ?? null,
    },
    remote,
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
    for (const pathname of EXEMPT_API_PATHS) {
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

  test("the host's secret is a full-role caller without a device record", () => {
    process.env.TELAR_HOST_TOKEN = HOST;
    try {
      const decision = decideApiAccess({ pathname: "/api/projects", method: "POST", authorization: null, deviceCookie: HOST }, file);
      expect(decision).toEqual({ allow: true, role: "full" });
    } finally {
      delete process.env.TELAR_HOST_TOKEN;
    }
  });

  test("with no secret set, nothing passes as the host", () => {
    delete process.env.TELAR_HOST_TOKEN;
    // The dangerous shape: an absent env var must not let an empty cookie in.
    expect(decideApiAccess({ pathname: "/api/projects", method: "GET", authorization: null, deviceCookie: "" }, file)).toEqual({
      allow: false,
      code: "cockpit_unauthorized",
    });
  });

  test("a near-miss is still refused", () => {
    process.env.TELAR_HOST_TOKEN = HOST;
    try {
      expect(decideApiAccess({ pathname: "/api/projects", method: "GET", authorization: null, deviceCookie: HOST + "x" }, file).allow).toBe(false);
      expect(decideApiAccess({ pathname: "/api/projects", method: "GET", authorization: null, deviceCookie: HOST.slice(0, -1) + "z" }, file).allow).toBe(false);
    } finally {
      delete process.env.TELAR_HOST_TOKEN;
    }
  });
});
