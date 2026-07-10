import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-oauth-"));
process.env.TELAR_HOME = home;
// bun test shares one process across files — re-pin the env before each test.
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const {
  canonicalResource,
  discover,
  decideClientStrategy,
  ensureClient,
  generatePkce,
  generateCodeVerifier,
  codeChallenge,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  refreshRecord,
  needsRefresh,
  mirrorAccessToken,
  getRecord,
  putRecord,
  deleteRecord,
} = await import("../src/mcp-oauth");
import type { AuthServerMeta, McpOAuthRecord, OAuthClient } from "../src/mcp-oauth";
const { getMcpToken, setMcpToken } = await import("../src/mcp");

// --- mock fetch ------------------------------------------------------------
type Call = { url: string; init?: RequestInit };
function makeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    calls.push({ url, init });
    const handler = routes[url];
    return handler ? handler() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
// A fetch that must never be hit (offline paths: manual client, PKCE, …).
const noFetch = (async () => {
  throw new Error("network must not be called");
}) as unknown as typeof fetch;

const AS = {
  issuer: "https://auth.example.com",
  authEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registerEndpoint: "https://auth.example.com/register",
  oauthWk: "https://auth.example.com/.well-known/oauth-authorization-server",
  openidWk: "https://auth.example.com/.well-known/openid-configuration",
};
const asMetaBody = (extra: Record<string, unknown> = {}) =>
  Response.json({
    issuer: AS.issuer,
    authorization_endpoint: AS.authEndpoint,
    token_endpoint: AS.tokenEndpoint,
    ...extra,
  });

const asMeta = (extra: Partial<AuthServerMeta> = {}): AuthServerMeta => ({
  issuer: AS.issuer,
  authorizationEndpoint: AS.authEndpoint,
  tokenEndpoint: AS.tokenEndpoint,
  ...extra,
});
const manualClient: OAuthClient = { strategy: "manual", id: "cli" };

// --- canonical resource ----------------------------------------------------
describe("canonicalResource (RFC 8707)", () => {
  test("lowercases scheme/host, drops fragment + trailing slash, keeps path case", () => {
    expect(canonicalResource("HTTPS://MCP.Example.COM/Mcp/")).toBe("https://mcp.example.com/Mcp");
    expect(canonicalResource("https://mcp.example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
    expect(canonicalResource("https://mcp.example.com")).toBe("https://mcp.example.com");
  });
});

// --- discovery -------------------------------------------------------------
describe("discover", () => {
  const server = "https://mcp.example.com/mcp";
  const prmUrl = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
  const challenge401 = () =>
    new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${prmUrl}"` },
    });
  const prmBody = () => Response.json({ authorization_servers: [AS.issuer] });

  test("401 → PRM → AS metadata, reading the WWW-Authenticate pointer", async () => {
    const { fetchImpl, calls } = makeFetch({
      [server]: challenge401,
      [prmUrl]: prmBody,
      [AS.oauthWk]: () => asMetaBody({ registration_endpoint: AS.registerEndpoint, client_id_metadata_document_supported: true }),
    });
    const d = await discover({ serverUrl: server, fetchImpl });
    expect(d.resource).toBe("https://mcp.example.com/mcp");
    expect(d.issuer).toBe(AS.issuer);
    expect(d.authorizationEndpoint).toBe(AS.authEndpoint);
    expect(d.tokenEndpoint).toBe(AS.tokenEndpoint);
    expect(d.registrationEndpoint).toBe(AS.registerEndpoint);
    expect(d.supportsCimd).toBe(true);
    expect(calls[0].url).toBe(server); // probed the server first
  });

  test("falls back to the openid-configuration well-known when oauth-authorization-server 404s", async () => {
    const { fetchImpl } = makeFetch({
      [server]: challenge401,
      [prmUrl]: prmBody,
      // AS.oauthWk deliberately absent → 404
      [AS.openidWk]: () => asMetaBody(),
    });
    const d = await discover({ serverUrl: server, fetchImpl });
    expect(d.tokenEndpoint).toBe(AS.tokenEndpoint);
    expect(d.supportsCimd).toBe(false); // not advertised
  });

  test("authorizationServer override skips the PRM probe entirely", async () => {
    const { fetchImpl, calls } = makeFetch({
      [AS.oauthWk]: () => asMetaBody({ registration_endpoint: AS.registerEndpoint }),
    });
    const d = await discover({ serverUrl: server, authorizationServer: AS.issuer, fetchImpl });
    expect(d.issuer).toBe(AS.issuer);
    expect(d.registrationEndpoint).toBe(AS.registerEndpoint);
    expect(calls.some((c) => c.url === server)).toBe(false); // never probed the resource
    expect(calls.some((c) => c.url === prmUrl)).toBe(false); // never fetched PRM
  });
});

// --- client-identity ladder ------------------------------------------------
describe("decideClientStrategy (ladder order)", () => {
  test("DCR when a registration_endpoint is advertised", () => {
    expect(decideClientStrategy({ registrationEndpoint: AS.registerEndpoint }, {})).toBe("dcr");
  });
  test("manual when no registration_endpoint but a clientId is configured", () => {
    expect(decideClientStrategy({}, { clientId: "abc" })).toBe("manual");
  });
  test("CIMD wins over DCR when supported AND a hosted doc URL is given", () => {
    expect(
      decideClientStrategy(
        { supportsCimd: true, registrationEndpoint: AS.registerEndpoint },
        { clientId: "abc" },
        { clientDocUrl: "https://telar.app/client.json" },
      ),
    ).toBe("cimd");
  });
  test("supportsCimd without a hosted doc URL falls through (Stage-A stub)", () => {
    expect(decideClientStrategy({ supportsCimd: true, registrationEndpoint: AS.registerEndpoint }, {})).toBe("dcr");
  });
  test("throws when no tier applies", () => {
    expect(() => decideClientStrategy({}, {})).toThrow(/no usable client-identity strategy/);
  });
});

describe("ensureClient", () => {
  test("DCR registers once and PERSISTS the client — a second call reuses it", async () => {
    const project = "proj-dcr";
    const server = "srv";
    const as = asMeta({ registrationEndpoint: AS.registerEndpoint });
    let registrations = 0;
    const { fetchImpl } = makeFetch({
      [AS.registerEndpoint]: () => {
        registrations++;
        return Response.json({ client_id: "dcr-123", client_secret: "sek", registration_access_token: "rat" });
      },
    });
    const args = {
      project,
      server,
      resource: "https://mcp.example.com/mcp",
      as,
      auth: { type: "oauth" as const },
      redirectUri: "http://localhost:3131/api/mcp/oauth/callback",
      fetchImpl,
    };
    const c1 = await ensureClient(args);
    expect(c1).toEqual({ strategy: "dcr", id: "dcr-123", secret: "sek", registrationAccessToken: "rat" });
    expect(registrations).toBe(1);
    expect(getRecord(project, server)?.client.id).toBe("dcr-123"); // persisted

    const c2 = await ensureClient(args);
    expect(c2.id).toBe("dcr-123");
    expect(registrations).toBe(1); // NO re-registration
  });

  test("manual client path when no registration_endpoint (no network)", async () => {
    const c = await ensureClient({
      project: "proj-manual",
      server: "srv",
      resource: "https://mcp.example.com/mcp",
      as: asMeta(), // no registrationEndpoint, no CIMD
      auth: { type: "oauth", clientId: "manual-xyz" },
      redirectUri: "http://localhost:3131/api/mcp/oauth/callback",
      fetchImpl: noFetch,
    });
    expect(c.strategy).toBe("manual");
    expect(c.id).toBe("manual-xyz");
  });

  test("manual confidential client resolves clientSecret from the secret store", async () => {
    const project = "proj-conf";
    setMcpToken(project, "cs", "shh");
    const c = await ensureClient({
      project,
      server: "srv",
      resource: "https://mcp.example.com/mcp",
      as: asMeta(),
      auth: { type: "oauth", clientId: "conf", clientSecret: { secret: "cs" } },
      redirectUri: "http://localhost:3131/api/mcp/oauth/callback",
      fetchImpl: noFetch,
    });
    expect(c.secret).toBe("shh");
  });
});

// --- PKCE ------------------------------------------------------------------
describe("PKCE (S256)", () => {
  test("verifier is 43-128 chars of the unreserved charset", () => {
    for (let i = 0; i < 20; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });
  test("challenge = base64url(sha256(verifier)) and method is S256", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(codeChallenge(verifier)).toBe(expected);
  });
});

// --- authorization URL -----------------------------------------------------
describe("buildAuthorizationUrl", () => {
  test("carries resource, code_challenge+S256, state, scope, client_id, redirect_uri", () => {
    const { url, state } = buildAuthorizationUrl({
      as: asMeta(),
      clientId: "cli",
      redirectUri: "http://localhost:3131/api/mcp/oauth/callback",
      resource: "https://mcp.example.com/mcp",
      scopes: ["read", "write"],
      codeChallenge: "CHAL",
    });
    const p = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe(AS.authEndpoint);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("cli");
    expect(p.get("redirect_uri")).toBe("http://localhost:3131/api/mcp/oauth/callback");
    expect(p.get("scope")).toBe("read write");
    expect(p.get("code_challenge")).toBe("CHAL");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(p.get("state")).toBe(state);
    expect(state.length).toBeGreaterThan(0);
  });
  test("uses a supplied state verbatim", () => {
    const { state } = buildAuthorizationUrl({
      as: asMeta(),
      clientId: "cli",
      redirectUri: "http://localhost:3131/cb",
      resource: "https://mcp.example.com/mcp",
      codeChallenge: "C",
      state: "fixed-state",
    });
    expect(state).toBe("fixed-state");
  });
});

// --- token exchange + refresh ----------------------------------------------
describe("exchangeCode", () => {
  test("parses access/refresh/scope + computes expiresAt, sends code_verifier + resource", async () => {
    const { fetchImpl, calls } = makeFetch({
      [AS.tokenEndpoint]: () =>
        Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read write" }),
    });
    const before = Date.now();
    const tokens = await exchangeCode({
      as: asMeta(),
      client: manualClient,
      code: "the-code",
      codeVerifier: "the-verifier",
      redirectUri: "http://localhost:3131/cb",
      resource: "https://mcp.example.com/mcp",
      fetchImpl,
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.scope).toBe("read write");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const body = new URLSearchParams(String(calls[0].init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(body.get("client_id")).toBe("cli");
  });
});

describe("refreshAccessToken", () => {
  test("rotates the refresh token when a new one is returned", async () => {
    const { fetchImpl, calls } = makeFetch({
      [AS.tokenEndpoint]: () => Response.json({ access_token: "at2", refresh_token: "rt2", expires_in: 1000 }),
    });
    const tokens = await refreshAccessToken({
      as: asMeta(),
      client: manualClient,
      refreshToken: "rt1",
      resource: "https://mcp.example.com/mcp",
      fetchImpl,
    });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("rt2");
    const body = new URLSearchParams(String(calls[0].init!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt1");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
  });
  test("keeps the old refresh token when none is returned", async () => {
    const { fetchImpl } = makeFetch({
      [AS.tokenEndpoint]: () => Response.json({ access_token: "at3", expires_in: 500 }),
    });
    const tokens = await refreshAccessToken({
      as: asMeta(),
      client: manualClient,
      refreshToken: "rt-keep",
      resource: "https://mcp.example.com/mcp",
      fetchImpl,
    });
    expect(tokens.refreshToken).toBe("rt-keep");
  });
});

// --- record store + refreshRecord + needsRefresh ---------------------------
const makeRecord = (project: string, server: string, tokens: McpOAuthRecord["tokens"]): McpOAuthRecord => ({
  project,
  server,
  resource: "https://mcp.example.com/mcp",
  as: asMeta(),
  client: manualClient,
  tokens,
});

describe("record store", () => {
  test("get/put/delete round-trip", () => {
    const rec = makeRecord("proj-store", "srv", { accessToken: "at", refreshToken: "rt", expiresAt: 123 });
    expect(getRecord("proj-store", "srv")).toBeUndefined();
    putRecord(rec);
    expect(getRecord("proj-store", "srv")).toEqual(rec);
    expect(deleteRecord("proj-store", "srv")).toBe(true);
    expect(getRecord("proj-store", "srv")).toBeUndefined();
    expect(deleteRecord("proj-store", "srv")).toBe(false); // already gone
  });
});

describe("mirrorAccessToken", () => {
  test("writes the live token into the existing mcp:<project>:<server> slot", () => {
    mirrorAccessToken("proj-mirror", "srv", "live-token");
    expect(getMcpToken("proj-mirror", "srv")).toBe("live-token");
  });
});

describe("needsRefresh", () => {
  const now = Date.now();
  test("true inside the skew window / when already expired", () => {
    expect(needsRefresh(makeRecord("p", "s", { accessToken: "x", expiresAt: now + 5_000 }), 60)).toBe(true);
    expect(needsRefresh(makeRecord("p", "s", { accessToken: "x", expiresAt: now - 1_000 }), 60)).toBe(true);
  });
  test("false when comfortably before expiry", () => {
    expect(needsRefresh(makeRecord("p", "s", { accessToken: "x", expiresAt: now + 120_000 }), 60)).toBe(false);
  });
  test("false when no expiry is known", () => {
    expect(needsRefresh(makeRecord("p", "s", { accessToken: "x" }), 60)).toBe(false);
  });
});

describe("refreshRecord", () => {
  test("refreshes, rotates, persists the record, and re-mirrors the token", async () => {
    const project = "proj-refresh";
    const server = "srv";
    const rec = makeRecord(project, server, { accessToken: "old", refreshToken: "rt1", expiresAt: Date.now() - 1 });
    putRecord(rec);
    const { fetchImpl } = makeFetch({
      [AS.tokenEndpoint]: () => Response.json({ access_token: "new", refresh_token: "rt2", expires_in: 3600 }),
    });
    const updated = await refreshRecord(rec, { fetchImpl });
    expect(updated.tokens.accessToken).toBe("new");
    expect(updated.tokens.refreshToken).toBe("rt2");
    expect(getRecord(project, server)?.tokens.accessToken).toBe("new"); // persisted
    expect(getMcpToken(project, server)).toBe("new"); // mirrored
  });
  test("throws when the record has no refresh token", async () => {
    const rec = makeRecord("p", "s", { accessToken: "x" });
    await expect(refreshRecord(rec)).rejects.toThrow(/no refresh token/);
  });
});
