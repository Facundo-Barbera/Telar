/**
 * The OAuth client, and the store it writes through.
 *
 * WHAT IS PINNED HERE IS THE PART THAT CANNOT BE CAUGHT BY LOOKING. A settings
 * page shows a green dot either way; what it cannot show is that the token
 * endpoint was reached over plaintext because a malicious server said so, or
 * that a token minted for somebody else was accepted, or that a replayed
 * callback was honoured twice. Every test below is one of those.
 *
 * Every network function takes `fetchImpl`, so none of this touches a socket.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertTokenAudience,
  buildAuthorizationUrl,
  canonicalResource,
  checkMcpHealth,
  codeChallenge,
  decideClientStrategy,
  discover,
  exchangeCode,
  generatePkce,
  NO_CLIENT_STRATEGY,
  needsRefresh,
  probeMcpAuth,
  resolveRedirectUri,
  type AuthServerMeta,
  type McpOAuthRecord,
} from "../src/mcp-oauth";
import { EngineStore } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mcp-oauth-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const store = (now = () => 1_000): EngineStore => new EngineStore(root(), now);

/** A fetch that answers from a table and records what it was asked. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const AS: AuthServerMeta = {
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
};

// ── the scheme guard ─────────────────────────────────────────────────────────

test("a server cannot point discovery at a plaintext authorization server", async () => {
  // THE ONE THIS FILE EXISTS FOR. Every URL in discovery is chosen by the MCP
  // server, and the end of that chain is a POST carrying an authorization code.
  // A server that names an http issuer must be refused, not followed.
  const { impl } = stubFetch({
    "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
    "https://mcp.example.com/.well-known/oauth-protected-resource": { body: { authorization_servers: ["http://auth.example.com"] } },
  });
  await expect(discover({ serverUrl: "https://mcp.example.com/", fetchImpl: impl })).rejects.toThrow(/must be https/);
});

test("a plaintext resource-metadata pointer is refused before it is fetched", async () => {
  const { impl, calls } = stubFetch({
    "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="http://evil.example.com/prm"' } },
  });
  await expect(discover({ serverUrl: "https://mcp.example.com/", fetchImpl: impl })).rejects.toThrow(/must be https/);
  // Refused BEFORE the request, not after: the pointer is never fetched at all.
  expect(calls).toEqual(["GET https://mcp.example.com/"]);
});

test("an authorization server cannot hand back a plaintext token endpoint", async () => {
  const { impl } = stubFetch({
    "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
    "https://mcp.example.com/.well-known/oauth-protected-resource": { body: { authorization_servers: ["https://auth.example.com"] } },
    "https://auth.example.com/.well-known/oauth-authorization-server": {
      body: { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "http://auth.example.com/token" },
    },
  });
  await expect(discover({ serverUrl: "https://mcp.example.com/", fetchImpl: impl })).rejects.toThrow(/token_endpoint must be https/);
});

test("an http loopback server is allowed, because that is how a local one is developed", async () => {
  const { impl } = stubFetch({
    "http://127.0.0.1:8080/mcp": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp"' } },
    "http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp": { body: { authorization_servers: ["http://127.0.0.1:9000"] } },
    "http://127.0.0.1:9000/.well-known/oauth-authorization-server": {
      body: { issuer: "http://127.0.0.1:9000", authorization_endpoint: "http://127.0.0.1:9000/authorize", token_endpoint: "http://127.0.0.1:9000/token" },
    },
  });
  const result = await discover({ serverUrl: "http://127.0.0.1:8080/mcp", fetchImpl: impl });
  expect(result.tokenEndpoint).toBe("http://127.0.0.1:9000/token");
});

// ── discovery mechanics ──────────────────────────────────────────────────────

test("the well-known is path-aware, and the resource keeps its path case", () => {
  // RFC 9728 puts the resource's path AFTER the well-known, which is the part
  // people get backwards. And a resource identifier is not a hostname:
  // lowercasing /API would name a different resource.
  expect(canonicalResource("HTTPS://MCP.Example.com/API/v1/")).toBe("https://mcp.example.com/API/v1");
  expect(canonicalResource("https://mcp.example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
});

test("discovery falls back to the well-known when the server offers no challenge", async () => {
  const { impl } = stubFetch({
    "https://mcp.example.com/mcp": { status: 200, body: {} }, // no 401, no pointer
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { body: { authorization_servers: ["https://auth.example.com"] } },
    "https://auth.example.com/.well-known/oauth-authorization-server": {
      body: { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register" },
    },
  });
  const result = await discover({ serverUrl: "https://mcp.example.com/mcp", fetchImpl: impl });
  expect(result.registrationEndpoint).toBe("https://auth.example.com/register");
  expect(result.resource).toBe("https://mcp.example.com/mcp");
});

test("detection never claims OAuth on an unknown", async () => {
  // A server that is DOWN must not render as one that needs a login: those two
  // want opposite actions from whoever is reading the row.
  const offline = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await probeMcpAuth("https://mcp.example.com/mcp", { fetchImpl: offline })).toEqual({ requiresOAuth: false });

  const { impl } = stubFetch({ "https://mcp.example.com/mcp": { status: 200, body: {} } });
  expect(await probeMcpAuth("https://mcp.example.com/mcp", { fetchImpl: impl })).toEqual({ requiresOAuth: false });
});

test("health separates 'not signed in' from 'not answering'", async () => {
  const challenged = stubFetch({ "https://mcp.example.com/mcp": { status: 401, body: { error: "unauthorized" } } });
  expect(await checkMcpHealth("https://mcp.example.com/mcp", { fetchImpl: challenged.impl })).toBe("needs-auth");

  const broken = stubFetch({ "https://mcp.example.com/mcp": { status: 500, body: {} } });
  expect(await checkMcpHealth("https://mcp.example.com/mcp", { fetchImpl: broken.impl })).toBe("error");

  const fine = stubFetch({ "https://mcp.example.com/mcp": { status: 200, body: { result: {} } } });
  expect(await checkMcpHealth("https://mcp.example.com/mcp", { token: "t", fetchImpl: fine.impl })).toBe("connected");
});

// ── the client ladder ────────────────────────────────────────────────────────

test("the ladder prefers registration, then a pasted client id, then says why not", () => {
  expect(decideClientStrategy({ registrationEndpoint: "https://auth/reg" }, {})).toBe("dcr");
  expect(decideClientStrategy({}, { clientId: "abc" })).toBe("manual");
  expect(decideClientStrategy({ registrationEndpoint: "https://auth/reg" }, { clientId: "abc" })).toBe("dcr");
  // The one failure with an action behind it, matched by the route so the
  // cockpit can ask for a client id rather than show a 502.
  expect(() => decideClientStrategy({}, {})).toThrow(NO_CLIENT_STRATEGY);
  // Wired but unreachable until Telar hosts a client document — passing one is
  // the only thing that selects the tier.
  expect(decideClientStrategy({ supportsCimd: true }, {}, { clientDocUrl: "https://telar/client.json" })).toBe("cimd");
  expect(decideClientStrategy({ supportsCimd: true }, { clientId: "abc" })).toBe("manual");
});

// ── PKCE and the authorization URL ───────────────────────────────────────────

test("the challenge is the S256 of the verifier, and the resource is bound", () => {
  const { verifier, challenge, method } = generatePkce();
  expect(method).toBe("S256");
  expect(challenge).toBe(codeChallenge(verifier));
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const { url, state } = buildAuthorizationUrl({
    as: AS,
    clientId: "client-1",
    redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
    resource: "https://mcp.example.com/mcp",
    scopes: ["read", "write"],
    codeChallenge: challenge,
  });
  const params = new URL(url).searchParams;
  expect(params.get("code_challenge_method")).toBe("S256");
  // RFC 8707: without this the token is not bound to this server, and one
  // minted here would be replayable against any other behind the same issuer.
  expect(params.get("resource")).toBe("https://mcp.example.com/mcp");
  expect(params.get("scope")).toBe("read write");
  expect(params.get("state")).toBe(state);
});

// ── the redirect URI ─────────────────────────────────────────────────────────

test("a redirect origin cannot smuggle a host past the origin check", () => {
  expect(resolveRedirectUri("http://localhost:3000")).toBe("http://localhost:3000/api/mcp/oauth/callback");
  expect(resolveRedirectUri("https://box.tailnet.ts.net")).toBe("https://box.tailnet.ts.net/api/mcp/oauth/callback");
  // A path, a query or credentials in the "origin" are all how redirect_uri
  // manipulation starts.
  expect(() => resolveRedirectUri("http://localhost:3000/anything")).toThrow(/bare/);
  expect(() => resolveRedirectUri("http://user:pw@localhost:3000")).toThrow(/bare/);
  // Plaintext off the loopback: the token would ride back over the wire.
  expect(() => resolveRedirectUri("http://example.com")).toThrow(/must be https/);
  // "@evil.com/cb" would otherwise concatenate into a URL whose host is evil.com.
  expect(() => resolveRedirectUri("http://localhost:3000", "@evil.com/cb")).toThrow(/absolute path/);
});

// ── audience ─────────────────────────────────────────────────────────────────

test("a JWT minted for a different server is refused", () => {
  const jwt = (aud: unknown) =>
    `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.sig`;

  expect(() => assertTokenAudience(jwt("https://other.example.com/mcp"), "https://mcp.example.com/mcp")).toThrow(/does not match/);
  expect(() => assertTokenAudience(jwt(["https://mcp.example.com/mcp", "x"]), "https://mcp.example.com/mcp")).not.toThrow();
  // The trailing-slash form names the same resource.
  expect(() => assertTokenAudience(jwt("https://mcp.example.com/mcp/"), "https://mcp.example.com/mcp")).not.toThrow();
  // Opaque tokens and audience-less JWTs pass: the `resource` parameter already
  // bound them and there is nothing here to inspect. Claiming otherwise would
  // reject every server that issues opaque tokens.
  expect(() => assertTokenAudience("opaque-token", "https://mcp.example.com/mcp")).not.toThrow();
  expect(() => assertTokenAudience(jwt(undefined), "https://mcp.example.com/mcp")).not.toThrow();
});

test("the exchange sends the verifier and the resource, and keeps no client secret", async () => {
  let sent = "";
  const impl = (async (_input: unknown, init?: RequestInit) => {
    sent = String(init?.body);
    return new Response(JSON.stringify({ access_token: "opaque", refresh_token: "r1", expires_in: 3600, scope: "read" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const tokens = await exchangeCode({
    as: AS,
    client: { strategy: "dcr", id: "client-1" },
    code: "the-code",
    codeVerifier: "the-verifier",
    redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
    resource: "https://mcp.example.com/mcp",
    fetchImpl: impl,
  });
  const body = new URLSearchParams(sent);
  expect(body.get("code_verifier")).toBe("the-verifier");
  expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
  expect(body.get("client_id")).toBe("client-1");
  // A public client: PKCE is the proof. Nothing in this repo can hold a secret
  // on a machine its user administers, so none is ever sent.
  expect(body.has("client_secret")).toBe(false);
  expect(tokens.refreshToken).toBe("r1");
  expect(tokens.expiresAt).toBeGreaterThan(Date.now());
});

test("a refresh window wide enough to outlive a turn", () => {
  const record = (expiresAt?: number): McpOAuthRecord => ({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "a", ...(expiresAt === undefined ? {} : { expiresAt }) },
    updatedAt: 0,
  });
  const now = 1_000_000;
  // A token with 30 seconds left is already useless: it is refreshed at CLAIM
  // time and then used for the whole turn.
  expect(needsRefresh(record(now + 30_000), 120, now)).toBe(true);
  expect(needsRefresh(record(now + 600_000), 120, now)).toBe(false);
  // No expiry known: the caller cannot do better than try it, and a 401 is the
  // honest signal.
  expect(needsRefresh(record(undefined), 120, now)).toBe(false);
});

// ── the store ────────────────────────────────────────────────────────────────

test("a grant is keyed by scope, so a project's server is not the machine's", () => {
  const engine = store();
  const base = { resource: "https://mcp.example.com/mcp", as: AS, client: { strategy: "dcr" as const, id: "c" }, updatedAt: 0 };
  engine.putMcpOAuthRecord({ ...base, serverId: "linear", tokens: { accessToken: "machine-token" } });
  engine.putMcpOAuthRecord({ ...base, serverId: "linear", projectId: "app", tokens: { accessToken: "project-token" } });

  expect(engine.getMcpOAuthRecord("linear")?.tokens.accessToken).toBe("machine-token");
  expect(engine.getMcpOAuthRecord("linear", "app")?.tokens.accessToken).toBe("project-token");
  // Scoped removal, so signing a project out cannot sign the machine out.
  expect(engine.deleteMcpOAuthRecord("linear", "app")).toBe(true);
  expect(engine.getMcpOAuthRecord("linear")?.tokens.accessToken).toBe("machine-token");
});

test("the grant file is 0600, because it holds tokens", () => {
  const engine = store();
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "secret-token" },
    updatedAt: 0,
  });
  expect(fs.statSync(engine.paths.mcpOAuth).mode & 0o777).toBe(0o600);
});

test("a pending flow is single use, and expires", () => {
  let clock = 1_000;
  const engine = store(() => clock);
  const ctx = {
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr" as const, id: "c" },
    state: "state-1",
    codeVerifier: "verifier-1",
    authorizationUrl: "https://auth.example.com/authorize?x=1",
    redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
  };
  engine.putPendingMcpOAuth({ serverId: "linear", ctx, createdAt: clock });
  expect(engine.takePendingMcpOAuth("state-1")?.ctx.codeVerifier).toBe("verifier-1");
  // A replayed callback finds nothing — the verifier is gone with the first use.
  expect(engine.takePendingMcpOAuth("state-1")).toBeUndefined();

  engine.putPendingMcpOAuth({ serverId: "linear", ctx: { ...ctx, state: "state-2" }, createdAt: clock });
  clock += 11 * 60_000;
  expect(engine.takePendingMcpOAuth("state-2")).toBeUndefined();
});

test("a DCR registration is reused across servers on the same issuer", () => {
  // One authorization server covering three MCP servers should hold ONE
  // registered client. Minting a second is how somebody ends up with a list of
  // identical stray OAuth apps, and some servers reject a fresh client id
  // outright — which reads as a broken button rather than as what it is.
  const engine = store();
  const redirectUri = "http://localhost:3000/api/mcp/oauth/callback";
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://linear.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "proven-client", redirectUri },
    tokens: { accessToken: "yes" },
    updatedAt: 0,
  });
  const clients = engine.mcpOAuthClientStore();
  expect(clients.findProvenDcrClient(AS.issuer, "sentry")?.id).toBe("proven-client");
  // A different issuer must not borrow it.
  expect(clients.findProvenDcrClient("https://other.example.com", "sentry")).toBeUndefined();
});

test("a registration left by an aborted connect is not treated as proven", () => {
  const engine = store();
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://linear.example.com/mcp",
    as: AS,
    // No token: the flow never completed, so nothing says this client works.
    client: { strategy: "dcr", id: "unproven", redirectUri: "http://localhost:3000/api/mcp/oauth/callback" },
    tokens: { accessToken: "" },
    updatedAt: 0,
  });
  const clients = engine.mcpOAuthClientStore();
  expect(clients.findProvenDcrClient(AS.issuer, "sentry")).toBeUndefined();
  // But the server's OWN retry reuses it, so pressing Connect twice does not
  // register two apps.
  expect(clients.findPendingDcrClient("linear")?.id).toBe("unproven");
});

test("removing a server takes its grant with it", () => {
  // Left behind, the record would re-attach to whatever the next server of that
  // id turned out to be — a token minted for one audience, sent to another.
  const engine = store();
  engine.saveMcpServer({ id: "linear", spec: { transport: "http", url: "https://mcp.example.com/mcp" } });
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "token" },
    updatedAt: 0,
  });
  expect(engine.removeMcpServer("linear")).toBe(true);
  expect(engine.getMcpOAuthRecord("linear")).toBeUndefined();
});

// ── the claim ────────────────────────────────────────────────────────────────

/** A store with a project and a session, ready to claim a turn. */
function claimable(now = () => 1_000): EngineStore {
  const engine = new EngineStore(root(), now);
  engine.registerProject({ id: "project_one", name: "One", root: os.tmpdir() });
  engine.createSession({ id: "session_one", projectId: "project_one" });
  return engine;
}

test("a signed-in server rides the claim with its bearer, and the list never shows it", async () => {
  // THE WHOLE POINT OF THE SPLIT: the token reaches the worker and reaches
  // nothing else. `listMcpServers` is what a settings page reads over HTTP.
  const engine = claimable();
  engine.saveMcpServer({ id: "linear", spec: { transport: "http", url: "https://mcp.example.com/mcp" } });
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "the-access-token" },
    updatedAt: 0,
  });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hi" });

  const claim = await engine.authorizeClaimedMcpServers(engine.claimNextTurn("worker_one")!);
  const spec = claim.mcpServers![0]!.spec as { headers?: Record<string, string> };
  expect(spec.headers?.Authorization).toBe("Bearer the-access-token");

  expect(JSON.stringify(engine.listMcpServers())).not.toContain("the-access-token");
});

test("a header somebody typed wins over the managed token", async () => {
  // Someone who typed an Authorization header meant it, and replacing it
  // silently is the harder of the two failures to diagnose.
  const engine = claimable();
  engine.saveMcpServer({
    id: "linear",
    spec: { transport: "http", url: "https://mcp.example.com/mcp", headers: { authorization: "Bearer mine" } },
  });
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "managed" },
    updatedAt: 0,
  });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hi" });

  const claim = await engine.authorizeClaimedMcpServers(engine.claimNextTurn("worker_one")!);
  expect((claim.mcpServers![0]!.spec as { headers: Record<string, string> }).headers).toEqual({ authorization: "Bearer mine" });
});

test("a server nobody signed in to is handed over untouched", async () => {
  // Keyed on a stored GRANT, never on the `oauth` block: the block is
  // overrides, and having signed in is what makes a server authenticated.
  const engine = claimable();
  engine.saveMcpServer({
    id: "linear",
    spec: { transport: "http", url: "https://mcp.example.com/mcp", oauth: { clientId: "declared-but-unused" } },
  });
  engine.saveMcpServer({ id: "local", spec: { transport: "stdio", command: "node" } });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hi" });

  const claim = await engine.authorizeClaimedMcpServers(engine.claimNextTurn("worker_one")!);
  expect(claim.mcpServers!.map((server) => server.spec)).toEqual([
    { transport: "http", url: "https://mcp.example.com/mcp", oauth: { clientId: "declared-but-unused" } },
    { transport: "stdio", command: "node" },
  ]);
});

test("an expiring token is refreshed before the turn, and a failed refresh still runs", async () => {
  const clock = 10_000_000;
  const engine = claimable(() => clock);
  engine.saveMcpServer({ id: "linear", spec: { transport: "http", url: "https://mcp.example.com/mcp" } });
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    // Thirty seconds left: enough to pass a naive check, not enough to outlive
    // a turn that is about to start.
    tokens: { accessToken: "stale", refreshToken: "r1", expiresAt: clock + 30_000 },
    updatedAt: 0,
  });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hi" });

  const rotated = (async () =>
    new Response(JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const claim = await engine.authorizeClaimedMcpServers(engine.claimNextTurn("worker_one")!, rotated);
  expect((claim.mcpServers![0]!.spec as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer fresh");
  // The rotated refresh token is kept, or the NEXT refresh fails.
  expect(engine.getMcpOAuthRecord("linear")?.tokens.refreshToken).toBe("r2");

});

test("a refresh that fails still lets the turn run", async () => {
  // A stale token 401s inside one tool call, which is legible. Throwing here
  // would kill a whole turn over a tool the user may not even have asked for.
  // A store of its own because a session hands out one active turn at a time.
  const clock = 10_000_000;
  const engine = claimable(() => clock);
  engine.saveMcpServer({ id: "linear", spec: { transport: "http", url: "https://mcp.example.com/mcp" } });
  engine.putMcpOAuthRecord({
    serverId: "linear",
    resource: "https://mcp.example.com/mcp",
    as: AS,
    client: { strategy: "dcr", id: "c" },
    tokens: { accessToken: "stale", refreshToken: "revoked", expiresAt: clock + 30_000 },
    updatedAt: 0,
  });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hi" });

  const offline = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const claim = await engine.authorizeClaimedMcpServers(engine.claimNextTurn("worker_one")!, offline);
  expect((claim.mcpServers![0]!.spec as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer stale");
});
