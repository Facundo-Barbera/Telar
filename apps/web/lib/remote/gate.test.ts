// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { decideApiAccess, EXEMPT_API_PATHS } from "./gate";
import { hashToken, type RemoteFile } from "./store";

const RAW = "tlr_" + "a".repeat(43);

function file(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    version: 1,
    requireAuth: true,
    devices: [{ id: "dev_1", name: "Phone", tokenHash: hashToken(RAW), createdAt: 1 }],
    ...overrides,
  };
}

function ask(pathname: string, credentials: { authorization?: string; deviceCookie?: string } = {}, remote = file()) {
  return decideApiAccess(
    { pathname, authorization: credentials.authorization ?? null, deviceCookie: credentials.deviceCookie ?? null },
    remote,
  );
}

describe("api gate", () => {
  test("everything passes while requireAuth is off", () => {
    expect(ask("/api/health", {}, file({ requireAuth: false }))).toEqual({ allow: true });
  });

  test("a tokenless request is refused once requireAuth is on", () => {
    expect(ask("/api/sessions/live")).toEqual({ allow: false });
  });

  test("/api/health is gated by name — it identifies the daemon", () => {
    expect(ask("/api/health")).toEqual({ allow: false });
  });

  test("the exemptions answer strangers", () => {
    for (const pathname of EXEMPT_API_PATHS) {
      expect(ask(pathname)).toEqual({ allow: true });
    }
  });

  test("a bearer token admits the device", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}` })).toEqual({ allow: true, deviceId: "dev_1" });
  });

  test("the cookie admits a paired browser", () => {
    expect(ask("/api/health", { deviceCookie: RAW })).toEqual({ allow: true, deviceId: "dev_1" });
  });

  test("the bearer wins over the cookie when both are present", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}`, deviceCookie: "tlr_wrong" })).toEqual({
      allow: true,
      deviceId: "dev_1",
    });
  });

  test("a revoked device's token is refused", () => {
    expect(ask("/api/health", { authorization: `Bearer ${RAW}` }, file({ devices: [] }))).toEqual({ allow: false });
  });

  test("a malformed authorization header is refused, not crashed on", () => {
    expect(ask("/api/health", { authorization: "Bearer not-a-telar-token" })).toEqual({ allow: false });
    expect(ask("/api/health", { authorization: "Basic dXNlcg==" })).toEqual({ allow: false });
  });
});
