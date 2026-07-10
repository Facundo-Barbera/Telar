// Telar-owned MCP OAuth 2.1 client engine (docs/mcp-oauth-design.md, Stage A).
// PURE + testable: every network function takes a `fetchImpl: typeof fetch`
// (defaulting to globalThis.fetch) so tests inject a mock — we never call the
// global `fetch` directly. This module builds the pieces (discovery, the
// client-identity ladder, PKCE, auth-URL, token/refresh, the record store);
// the browser connect flow + the hot-path injection wire onto it in Stage B —
// mcp.ts is NOT touched here beyond the mirror helper (via setMcpToken).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { telarDir } from "./manifest";
import { getMcpToken, setMcpToken } from "./mcp";
import type { McpOAuthConfig, McpSecretRef } from "./schemas";

// ---------------------------------------------------------------------------
// Types (docs/mcp-oauth-design.md §4)
// ---------------------------------------------------------------------------

export type AuthServerMeta = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  supportsCimd?: boolean;
};

export type ClientStrategy = "cimd" | "dcr" | "manual";

export type OAuthClient = {
  strategy: ClientStrategy;
  id: string;
  secret?: string;
  registrationAccessToken?: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
};

export type McpOAuthRecord = {
  project: string;
  server: string;
  resource: string; // canonical MCP server URI (RFC 8707 audience)
  as: AuthServerMeta;
  client: OAuthClient;
  tokens: OAuthTokens;
};

export type DiscoveryResult = AuthServerMeta & { resource: string };

const DEFAULT_REDIRECT_PATH = "/api/mcp/oauth/callback";
const REDIRECT_ORIGIN = "http://localhost:3131";

// ---------------------------------------------------------------------------
// Canonical resource (RFC 8707 §2): lowercase scheme+host (URL does this for
// us), drop fragment, strip a trailing slash. Path case is preserved.
// ---------------------------------------------------------------------------

export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Endpoint scheme guard (design §6, OAuth 2.1 / RFC 8414 / RFC 9728). The
// threat model is third-party servers (Supabase/GitHub): discovery pointers,
// the issuer, and every AS endpoint are server-controlled, and we eventually
// POST client_secret + auth code + refresh_token to the token endpoint. Require
// https, except loopback (localhost/127.0.0.1/::1) which the spec allows for
// local dev — so a malicious or MITM'd server can't redirect that POST to an
// arbitrary http:// or internal URL.
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertSecureUrl(url: string, label: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`${label} must be https (or an http loopback URL): ${url}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// (a) Discovery — RFC 9728 Protected Resource Metadata → RFC 8414 AS metadata.
// ---------------------------------------------------------------------------

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// The resource_metadata pointer from a 401 challenge, e.g.
//   WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/…"
function parseResourceMetadata(header: string | null): string | undefined {
  if (!header) return undefined;
  return header.match(/resource_metadata="([^"]+)"/i)?.[1];
}

// RFC 9728 path-aware well-known: origin + /.well-known/… + resource path.
function prmWellKnownUrl(resource: string): string {
  const u = new URL(resource);
  const p = u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${p}`;
}

// RFC 8414 (path-aware) with the openid-configuration well-known as a fallback.
function asWellKnownUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/$/, "");
  const base = `${u.origin}${p}`;
  return [
    `${u.origin}/.well-known/oauth-authorization-server${p}`,
    `${u.origin}/.well-known/openid-configuration${p}`,
    `${base}/.well-known/openid-configuration`, // path-appended variant
  ].filter((v, i, a) => a.indexOf(v) === i);
}

function parseAsMeta(meta: any, issuer: string): AuthServerMeta {
  assertSecureUrl(meta.authorization_endpoint, "authorization_endpoint");
  assertSecureUrl(meta.token_endpoint, "token_endpoint");
  if (meta.registration_endpoint) assertSecureUrl(meta.registration_endpoint, "registration_endpoint");
  return {
    issuer: meta.issuer ?? issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    supportsCimd: meta.client_id_metadata_document_supported === true,
  };
}

async function fetchAuthServerMeta(fetchImpl: typeof fetch, issuer: string): Promise<AuthServerMeta> {
  for (const url of asWellKnownUrls(issuer)) {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    let meta: any;
    try {
      meta = await res.json();
    } catch {
      continue;
    }
    if (meta?.authorization_endpoint && meta?.token_endpoint) return parseAsMeta(meta, issuer);
  }
  throw new Error(`could not fetch authorization server metadata for ${issuer}`);
}

export async function discover(opts: {
  serverUrl: string;
  authorizationServer?: string; // override → skip PRM discovery
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const resource = canonicalResource(opts.serverUrl);

  let issuer = opts.authorizationServer;
  if (!issuer) {
    // Probe the server; a compliant MCP server answers 401 with a
    // resource_metadata pointer. Fall back to the path-aware well-known.
    let prmUrl: string | undefined;
    try {
      const probe = await fetchImpl(opts.serverUrl);
      if (probe.status === 401) prmUrl = parseResourceMetadata(probe.headers.get("www-authenticate"));
    } catch {
      // network hiccup on the probe — the well-known fallback still applies.
    }
    prmUrl ??= prmWellKnownUrl(resource);
    assertSecureUrl(prmUrl, "resource metadata URL"); // server-supplied pointer
    const prm = await fetchJson(fetchImpl, prmUrl);
    issuer = prm.authorization_servers?.[0];
    if (!issuer) throw new Error(`protected resource metadata for ${resource} lists no authorization_servers`);
  }

  assertSecureUrl(issuer, "authorization server issuer");
  const as = await fetchAuthServerMeta(fetchImpl, issuer);
  return { ...as, resource };
}

// ---------------------------------------------------------------------------
// (a.probe) Best-effort OAuth DETECTION for the UI (docs/mcp-oauth-design.md
// §3: "OAuth is auto-detected, not declared"). A server needs OAuth when it
// either answers a probe with a 401 + WWW-Authenticate `resource_metadata`
// pointer (RFC 9728) OR exposes a resolvable protected-resource-metadata
// well-known that lists an authorization server. Anything else — a 200, a
// challenge-less response, or ANY network/parse error — is reported as "no
// OAuth": we NEVER throw and NEVER claim OAuth on an unknown. Reuses the same
// probe/WWW-Authenticate/PRM helpers as discover().
// ---------------------------------------------------------------------------

export async function probeMcpAuth(
  serverUrl: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ requiresOAuth: boolean; resourceMetadataUrl?: string }> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  try {
    // (1) Probe the server. A 401 carrying a resource_metadata pointer is the
    // strongest RFC 9728 signal — return it without a further fetch.
    try {
      const probe = await fetchImpl(serverUrl);
      if (probe.status === 401) {
        const pointer = parseResourceMetadata(probe.headers.get("www-authenticate"));
        if (pointer) return { requiresOAuth: true, resourceMetadataUrl: pointer };
      }
    } catch {
      // Probe network hiccup — the well-known fallback below still applies.
    }
    // (2) Fall back to a resolvable protected-resource-metadata well-known that
    // actually names an authorization server (what discover() would consume).
    const prmUrl = prmWellKnownUrl(canonicalResource(serverUrl));
    const prm = await fetchJson(fetchImpl, prmUrl); // throws on non-2xx / bad JSON
    if (Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length > 0) {
      return { requiresOAuth: true, resourceMetadataUrl: prmUrl };
    }
    return { requiresOAuth: false };
  } catch {
    // Any network/parse failure (incl. the well-known 404) → not OAuth.
    return { requiresOAuth: false };
  }
}

// ---------------------------------------------------------------------------
// (b) Client-identity ladder (docs/mcp-oauth-design.md §2): first that applies.
// ---------------------------------------------------------------------------

// PURE decision: which of the three tiers to use, in ladder order. Kept
// separate from the (possibly-networked) resolution so it's trivially testable.
//   1. CIMD  — AS advertises client-id-metadata support AND we have a hosted
//              client-doc URL to use as the client_id.
//   2. DCR   — AS advertises a registration_endpoint.
//   3. manual — a pre-registered clientId is configured.
export function decideClientStrategy(
  as: Pick<AuthServerMeta, "registrationEndpoint" | "supportsCimd">,
  auth: Pick<McpOAuthConfig, "clientId">,
  opts?: { clientDocUrl?: string },
): ClientStrategy {
  if (as.supportsCimd && opts?.clientDocUrl) return "cimd";
  if (as.registrationEndpoint) return "dcr";
  if (auth.clientId) return "manual";
  throw new Error(
    "no usable client-identity strategy: AS supports neither CIMD (no hosted doc) nor DCR, and no manual clientId is configured",
  );
}

function resolveClientSecret(project: string, ref?: McpSecretRef): string | undefined {
  if (!ref) return undefined;
  const token = getMcpToken(project, ref.secret);
  if (token === undefined) return undefined;
  return (ref.prefix ?? "") + token;
}

// (b.ii) DCR — RFC 7591 dynamic client registration.
export async function dcrRegister(opts: {
  registrationEndpoint: string;
  redirectUris: string[];
  scopes?: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthClient> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const metadata: Record<string, unknown> = {
    redirect_uris: opts.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: opts.tokenEndpointAuthMethod ?? "none",
    client_name: opts.clientName ?? "Telar",
  };
  if (opts.scopes?.length) metadata.scope = opts.scopes.join(" ");

  const res = await fetchImpl(opts.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) throw new Error(`DCR ${opts.registrationEndpoint} → ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  if (!j.client_id) throw new Error(`DCR response missing client_id`);
  return {
    strategy: "dcr",
    id: j.client_id,
    secret: j.client_secret,
    registrationAccessToken: j.registration_access_token,
  };
}

// Resolve the concrete client to use, applying the ladder and PERSISTING a DCR
// registration so a re-connect never re-registers. CIMD/manual are stateless
// (their id comes from config / the hosted doc), so only DCR touches the store.
//
// CIMD is a deliberate Stage-A STUB: the plumbing is wired (pass `clientDocUrl`
// and the tier is selected + used as the client_id), but Telar does not yet
// HOST a client-metadata document, so no caller supplies `clientDocUrl` in
// Stage A and this tier is never actually selected until Stage B stands up the
// hosted URL. Nothing else changes when it goes live.
export async function ensureClient(opts: {
  project: string;
  server: string;
  resource: string;
  as: AuthServerMeta;
  auth: McpOAuthConfig;
  redirectUri: string;
  clientName?: string;
  clientDocUrl?: string; // Stage-B hosted CIMD document URL
  fetchImpl?: typeof fetch;
}): Promise<OAuthClient> {
  const strategy = decideClientStrategy(opts.as, opts.auth, { clientDocUrl: opts.clientDocUrl });

  if (strategy === "cimd") {
    return { strategy: "cimd", id: opts.clientDocUrl! };
  }
  if (strategy === "manual") {
    return { strategy: "manual", id: opts.auth.clientId!, secret: resolveClientSecret(opts.project, opts.auth.clientSecret) };
  }

  // DCR: reuse a persisted registration, else register once and persist it.
  const existing = getRecord(opts.project, opts.server);
  if (existing?.client.strategy === "dcr" && existing.client.id) return existing.client;

  const client = await dcrRegister({
    registrationEndpoint: opts.as.registrationEndpoint!,
    redirectUris: [opts.redirectUri],
    scopes: opts.auth.scopes,
    clientName: opts.clientName,
    fetchImpl: opts.fetchImpl,
  });
  persistClient(opts.project, opts.server, opts.resource, opts.as, client);
  return client;
}

// ---------------------------------------------------------------------------
// (c) PKCE (RFC 7636) — S256 only.
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  // 32 random bytes → 43 base64url chars (within the 43-128 range); base64url's
  // [A-Za-z0-9-_] is a subset of the RFC 7636 unreserved set.
  return crypto.randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: codeChallenge(verifier), method: "S256" };
}

// ---------------------------------------------------------------------------
// (d) Authorization URL builder — PKCE S256 + RFC 8707 `resource`.
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(opts: {
  as: AuthServerMeta;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes?: string[];
  codeChallenge: string;
  state?: string;
}): { url: string; state: string } {
  const state = opts.state ?? crypto.randomBytes(16).toString("base64url");
  const url = new URL(opts.as.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  if (opts.scopes?.length) url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", opts.resource); // RFC 8707 audience
  return { url: url.toString(), state };
}

// ---------------------------------------------------------------------------
// (e) Token exchange + refresh.
// ---------------------------------------------------------------------------

// RFC 8707 / design §6: never accept a token minted for a different audience.
// When the access token is a JWT carrying an `aud` claim, assert it names this
// resource. Opaque (non-JWT) tokens and JWTs without an `aud` are passed
// through — the `resource` param already bound them at the AS and we cannot
// inspect them; the deeper Stage-B injection path stays the final gate.
export function assertTokenAudience(accessToken: string, resource: string): void {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return; // opaque access token — not a JWT
  let aud: unknown;
  try {
    aud = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.aud;
  } catch {
    return; // undecodable payload — treat as opaque
  }
  if (aud === undefined) return; // no audience claim to validate
  const audiences = (Array.isArray(aud) ? aud : [aud]).map(String);
  const matches = audiences.some((a) => {
    if (a === resource) return true;
    try {
      return canonicalResource(a) === resource; // tolerate trailing-slash form
    } catch {
      return false;
    }
  });
  if (!matches) {
    throw new Error(`access token audience ${JSON.stringify(aud)} does not match resource ${resource}`);
  }
}

function parseTokenResponse(j: any, prevRefresh?: string): OAuthTokens {
  if (!j.access_token) throw new Error("token response missing access_token");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? prevRefresh, // rotate when a new one comes back
    expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined,
    scope: j.scope,
  };
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  as: AuthServerMeta,
  client: OAuthClient,
  params: Record<string, string>,
): Promise<any> {
  const body = new URLSearchParams(params);
  body.set("client_id", client.id);
  if (client.secret) body.set("client_secret", client.secret); // client_secret_post
  const res = await fetchImpl(as.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token endpoint ${as.tokenEndpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(opts: {
  as: AuthServerMeta;
  client: OAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const j = await tokenRequest(fetchImpl, opts.as, opts.client, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    resource: opts.resource,
  });
  const tokens = parseTokenResponse(j);
  assertTokenAudience(tokens.accessToken, opts.resource);
  return tokens;
}

export async function refreshAccessToken(opts: {
  as: AuthServerMeta;
  client: OAuthClient;
  refreshToken: string;
  resource: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    resource: opts.resource,
  };
  if (opts.scopes?.length) params.scope = opts.scopes.join(" ");
  const j = await tokenRequest(fetchImpl, opts.as, opts.client, params);
  const tokens = parseTokenResponse(j, opts.refreshToken);
  assertTokenAudience(tokens.accessToken, opts.resource);
  return tokens;
}

// ---------------------------------------------------------------------------
// (f) Record store — atomic JSON under ~/.telar (docs/mcp-oauth-design.md §4).
// Keyed mcp-oauth:<project>:<server>; the live access token is mirrored into
// the existing mcp:<project>:<server> slot so today's resolver keeps working.
// ---------------------------------------------------------------------------

type OAuthStore = { version: number; records: Record<string, McpOAuthRecord> };
const storeFile = () => path.join(telarDir(), "mcp-oauth.json");
const recordKey = (project: string, server: string) => `mcp-oauth:${project}:${server}`;

function readStore(): OAuthStore {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return { version: data.version ?? 1, records: data.records ?? {} };
  } catch {
    return { version: 1, records: {} };
  }
}

function writeStore(store: OAuthStore): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // contains tokens — enforce 0600 even if a prior file relaxed it
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function getRecord(project: string, server: string): McpOAuthRecord | undefined {
  return readStore().records[recordKey(project, server)];
}

export function putRecord(record: McpOAuthRecord): void {
  const store = readStore();
  store.records[recordKey(record.project, record.server)] = record;
  writeStore(store);
}

export function deleteRecord(project: string, server: string): boolean {
  const store = readStore();
  const key = recordKey(project, server);
  if (!(key in store.records)) return false;
  delete store.records[key];
  writeStore(store);
  return true;
}

// Upsert only the AS/client half of a record — used to persist a DCR
// registration before any token exists, so a re-connect reuses the client.
function persistClient(project: string, server: string, resource: string, as: AuthServerMeta, client: OAuthClient): void {
  const existing = getRecord(project, server);
  putRecord({
    project,
    server,
    resource,
    as,
    client,
    tokens: existing?.tokens ?? { accessToken: "" }, // filled in by the token exchange
  });
}

// True when the access token is expired or within `skewSeconds` of expiring.
// No expiry known → treated as still-valid (false); the caller decides.
export function needsRefresh(record: McpOAuthRecord, skewSeconds = 60): boolean {
  const { expiresAt } = record.tokens;
  if (expiresAt === undefined) return false;
  return Date.now() >= expiresAt - skewSeconds * 1000;
}

// Mirror the live access token into the existing mcp:<project>:<server> slot so
// resolveProjectMcpServers picks it up unchanged (design §4). mcp.ts is not
// otherwise modified in this stage.
export function mirrorAccessToken(project: string, server: string, token: string): void {
  setMcpToken(project, server, token);
}

// Refresh a record's tokens, rotate the refresh token, persist, and re-mirror.
export async function refreshRecord(
  record: McpOAuthRecord,
  opts?: { fetchImpl?: typeof fetch; scopes?: string[] },
): Promise<McpOAuthRecord> {
  if (!record.tokens.refreshToken) throw new Error(`no refresh token for ${record.project}:${record.server}`);
  const tokens = await refreshAccessToken({
    as: record.as,
    client: record.client,
    refreshToken: record.tokens.refreshToken,
    resource: record.resource,
    scopes: opts?.scopes,
    fetchImpl: opts?.fetchImpl,
  });
  const updated: McpOAuthRecord = { ...record, tokens };
  putRecord(updated);
  mirrorAccessToken(record.project, record.server, tokens.accessToken);
  return updated;
}

// ---------------------------------------------------------------------------
// Thin connect orchestrators — composed from the primitives above; the Stage-B
// routes (initiate + /api/mcp/oauth/callback) call these. No hot-path change.
// ---------------------------------------------------------------------------

export type ConnectContext = {
  resource: string;
  as: AuthServerMeta;
  client: OAuthClient;
  state: string;
  codeVerifier: string; // caller stashes this (+ state) for the callback
  authorizationUrl: string;
  redirectUri: string;
};

function redirectUriFor(auth: McpOAuthConfig): string {
  const p = auth.redirectPath ?? DEFAULT_REDIRECT_PATH;
  // The origin is hardcoded to localhost, but redirectPath is config-supplied:
  // guard against redirect_uri manipulation. A value like "@evil.com/cb" would
  // otherwise concatenate into "http://localhost:3131@evil.com/cb" (host
  // evil.com). Require a plain absolute path and confirm the built URL stays on
  // REDIRECT_ORIGIN (exact-match redirect, design §6).
  if (!p.startsWith("/") || p.includes("@")) {
    throw new Error(`invalid auth.redirectPath ${JSON.stringify(p)} — must be an absolute path with no '@'`);
  }
  const uri = new URL(p, REDIRECT_ORIGIN);
  if (uri.origin !== REDIRECT_ORIGIN) {
    throw new Error(`auth.redirectPath ${JSON.stringify(p)} escapes ${REDIRECT_ORIGIN}`);
  }
  return uri.toString();
}

export async function beginConnect(opts: {
  project: string;
  server: string;
  serverUrl: string;
  auth: McpOAuthConfig;
  clientName?: string;
  clientDocUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<ConnectContext> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const redirectUri = redirectUriFor(opts.auth);
  const { resource, ...as } = await discover({
    serverUrl: opts.serverUrl,
    authorizationServer: opts.auth.authorizationServer,
    fetchImpl,
  });
  const client = await ensureClient({
    project: opts.project,
    server: opts.server,
    resource,
    as,
    auth: opts.auth,
    redirectUri,
    clientName: opts.clientName,
    clientDocUrl: opts.clientDocUrl,
    fetchImpl,
  });
  const { verifier, challenge } = generatePkce();
  const { url, state } = buildAuthorizationUrl({
    as,
    clientId: client.id,
    redirectUri,
    resource,
    scopes: opts.auth.scopes,
    codeChallenge: challenge,
  });
  return { resource, as, client, state, codeVerifier: verifier, authorizationUrl: url, redirectUri };
}

export async function completeConnect(opts: {
  project: string;
  server: string;
  ctx: ConnectContext;
  code: string;
  returnedState: string; // the `state` the callback came back with
  fetchImpl?: typeof fetch;
}): Promise<McpOAuthRecord> {
  // CSRF / code-injection guard (design §6): enforce state in the engine rather
  // than trusting each caller/route to compare it (PKCE only partially covers).
  if (opts.returnedState !== opts.ctx.state) {
    throw new Error("OAuth state mismatch — aborting token exchange (possible CSRF)");
  }
  const tokens = await exchangeCode({
    as: opts.ctx.as,
    client: opts.ctx.client,
    code: opts.code,
    codeVerifier: opts.ctx.codeVerifier,
    redirectUri: opts.ctx.redirectUri,
    resource: opts.ctx.resource,
    fetchImpl: opts.fetchImpl,
  });
  const record: McpOAuthRecord = {
    project: opts.project,
    server: opts.server,
    resource: opts.ctx.resource,
    as: opts.ctx.as,
    client: opts.ctx.client,
    tokens,
  };
  putRecord(record);
  mirrorAccessToken(opts.project, opts.server, tokens.accessToken);
  return record;
}
