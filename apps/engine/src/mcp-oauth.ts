/**
 * THE OAUTH 2.1 CLIENT FOR MCP SERVERS — discovery, the client-identity ladder,
 * PKCE, the code exchange and the refresh.
 *
 * Ported from `packages/core/src/mcp-oauth.ts`, which is the working
 * implementation this repo already had and which nothing in vNext could reach:
 * that one is bound to `~/.telar`'s manifest and secret store, and this engine
 * has neither. What changed, and why:
 *
 *   · NO FILE IO IN THIS MODULE. The donor read and wrote its own JSON. Here
 *     every persistent read and write is `state.ts`'s, so the OAuth records land
 *     under the same lock, the same atomic rename and the same 0600 as
 *     everything else the engine keeps. The store arrives as an interface
 *     (`OAuthClientStore`) with the two operations the DCR tier genuinely needs.
 *   · NO TOKEN MIRROR. The donor copied each access token into a second
 *     `mcp:<project>:<server>` secret slot so the legacy resolver would find it.
 *     Here the claim reads the record directly, so the token lives in exactly one
 *     place and there is no second copy to leave behind on a disconnect.
 *   · NO CONFIDENTIAL CLIENTS. The donor resolved a `clientSecret` through a
 *     secret ref. This engine takes a manual `clientId` only, which is the
 *     public-client + PKCE shape OAuth 2.1 actually recommends for a native app;
 *     a secret shipped to a machine the user controls is not a secret. A server
 *     that requires one is refused with a sentence saying so rather than half
 *     attempted.
 *
 * EVERY NETWORK FUNCTION TAKES `fetchImpl` and defaults to `globalThis.fetch`,
 * exactly as the donor did — this module never touches the global directly, so
 * a test injects a server without a server existing.
 *
 * THE THREAT MODEL IS THE SERVER ITSELF. Discovery pointers, the issuer and
 * every endpoint are third-party controlled, and we eventually POST an
 * authorization code to the token endpoint. `assertSecureUrl` is what stops a
 * malicious or MITM'd server from redirecting that POST somewhere plaintext or
 * internal.
 */
import crypto from "node:crypto";

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
  registrationAccessToken?: string;
  /** DCR only: the exact `redirect_uri` this registration was minted with. The
   *  authorization server exact-matches it, so a client is only reusable for a
   *  connect that would send the same one. */
  redirectUri?: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent when the server named no `expires_in`. */
  expiresAt?: number;
  scope?: string;
};

/** What the user may pin when autodetection is not enough. All optional: OAuth
 *  is DETECTED, not declared, and an absent block does not disable it. */
export type McpOAuthOverrides = {
  authorizationServer?: string;
  clientId?: string;
  scopes?: string[];
};

export type McpOAuthRecord = {
  /** Absent for a machine-wide server, matching `McpServer.projectId`. */
  projectId?: string;
  serverId: string;
  /** The canonical MCP server URI — the RFC 8707 audience. */
  resource: string;
  as: AuthServerMeta;
  client: OAuthClient;
  tokens: OAuthTokens;
  updatedAt: number;
};

export type DiscoveryResult = AuthServerMeta & { resource: string };

/**
 * RFC 8707 §2: lowercase scheme and host (which `URL` does), no fragment, no
 * trailing slash. Path case is PRESERVED — a resource identifier is not a
 * hostname, and lowercasing `/API/v1` would name a different resource.
 */
export function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * https, or http on loopback — the OAuth 2.1 rule, applied to every
 * server-supplied URL before we fetch it or send anything to it.
 *
 * The loopback exception is not laxity: it is what makes a locally-run MCP
 * server developable at all, and the spec carves it out for the same reason.
 */
function assertSecureUrl(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${label} must be https (or an http loopback URL): ${url}`);
  }
  return url;
}

// ── discovery: RFC 9728 protected-resource metadata → RFC 8414 AS metadata ───

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** The pointer a compliant server puts in its 401:
 *  `WWW-Authenticate: Bearer resource_metadata="https://…"`. */
function parseResourceMetadata(header: string | null): string | undefined {
  if (!header) return undefined;
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1];
}

/** RFC 9728's path-aware well-known: origin, then the well-known, then the
 *  resource's own path — NOT the other way round. */
function prmWellKnownUrl(resource: string): string {
  const url = new URL(resource);
  const suffix = url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
}

/** RFC 8414 path-aware, with the OpenID variants as fallbacks. Real servers
 *  disagree about which of these three they publish, so all three are tried. */
function asWellKnownUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const suffix = url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${url.origin}/.well-known/openid-configuration${suffix}`,
    `${url.origin}${suffix}/.well-known/openid-configuration`,
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function parseAsMeta(meta: Record<string, unknown>, issuer: string): AuthServerMeta {
  const authorizationEndpoint = assertSecureUrl(String(meta.authorization_endpoint), "authorization_endpoint");
  const tokenEndpoint = assertSecureUrl(String(meta.token_endpoint), "token_endpoint");
  const registrationEndpoint =
    typeof meta.registration_endpoint === "string"
      ? assertSecureUrl(meta.registration_endpoint, "registration_endpoint")
      : undefined;
  return {
    issuer: typeof meta.issuer === "string" ? meta.issuer : issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    supportsCimd: meta.client_id_metadata_document_supported === true,
  };
}

async function fetchAuthServerMeta(fetchImpl: typeof fetch, issuer: string): Promise<AuthServerMeta> {
  for (const url of asWellKnownUrls(issuer)) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    let meta: Record<string, unknown>;
    try {
      meta = (await response.json()) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (meta.authorization_endpoint && meta.token_endpoint) return parseAsMeta(meta, issuer);
  }
  throw new Error(`could not fetch authorization server metadata for ${issuer}`);
}

export async function discover(options: {
  serverUrl: string;
  /** Pinned by the user; skips protected-resource discovery entirely. */
  authorizationServer?: string;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resource = canonicalResource(options.serverUrl);

  let issuer = options.authorizationServer;
  if (!issuer) {
    let pointer: string | undefined;
    try {
      const probe = await fetchImpl(options.serverUrl);
      if (probe.status === 401) pointer = parseResourceMetadata(probe.headers.get("www-authenticate"));
    } catch {
      // A hiccup on the probe is not fatal — the well-known fallback still applies.
    }
    pointer ??= prmWellKnownUrl(resource);
    assertSecureUrl(pointer, "resource metadata URL"); // server-supplied: check before fetching
    const metadata = await fetchJson(fetchImpl, pointer);
    const servers = metadata.authorization_servers;
    issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
    if (!issuer) throw new Error(`protected resource metadata for ${resource} lists no authorization_servers`);
  }

  assertSecureUrl(issuer, "authorization server issuer");
  return { ...(await fetchAuthServerMeta(fetchImpl, issuer)), resource };
}

/**
 * DOES THIS SERVER WANT OAUTH? Best-effort, for the settings row.
 *
 * OAuth is auto-detected rather than declared, so this answers from the wire:
 * either a 401 carrying an RFC 9728 pointer, or a resolvable
 * protected-resource-metadata document that names an authorization server.
 *
 * ANYTHING ELSE IS "NO", INCLUDING EVERY ERROR. It never throws and never
 * claims OAuth on an unknown — a server that is merely down must not render as
 * one that needs a login, because the two want opposite actions from the reader.
 */
export async function probeMcpAuth(
  serverUrl: string,
  options?: { fetchImpl?: typeof fetch },
): Promise<{ requiresOAuth: boolean; resourceMetadataUrl?: string }> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    try {
      const probe = await fetchImpl(serverUrl);
      if (probe.status === 401) {
        const pointer = parseResourceMetadata(probe.headers.get("www-authenticate"));
        if (pointer) return { requiresOAuth: true, resourceMetadataUrl: pointer };
      }
    } catch {
      // Fall through to the well-known.
    }
    const wellKnown = prmWellKnownUrl(canonicalResource(serverUrl));
    const metadata = await fetchJson(fetchImpl, wellKnown); // throws on non-2xx / bad JSON
    const servers = metadata.authorization_servers;
    if (Array.isArray(servers) && servers.length > 0) return { requiresOAuth: true, resourceMetadataUrl: wellKnown };
    return { requiresOAuth: false };
  } catch {
    return { requiresOAuth: false };
  }
}

/**
 * IS IT ANSWERING US, RIGHT NOW? A real MCP `initialize` over Streamable HTTP,
 * with whatever token we hold.
 *
 * Distinct from `probeMcpAuth`, which only asks whether OAuth is REQUIRED. This
 * one asks whether the credential we have actually works, which is the question
 * the health dot is really about.
 *
 * `needs-auth` COVERS BOTH "never signed in" AND "the token expired", because
 * from here they are the same observation and the same fix.
 */
export async function checkMcpHealth(
  serverUrl: string,
  options?: { token?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch },
): Promise<"connected" | "needs-auth" | "error"> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    const headers: Record<string, string> = {
      ...(options?.headers ?? {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (options?.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetchImpl(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "telar", version: "2" },
        },
      }),
    });
    if (response.ok) return "connected";
    if (response.status === 401 || response.headers.get("www-authenticate")) return "needs-auth";
    return "error";
  } catch {
    return "error";
  }
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

// ── the client-identity ladder ───────────────────────────────────────────────

/**
 * WHICH TIER APPLIES, as a pure decision so it can be tested without a server.
 *
 *   1. CIMD   — the AS reads a hosted client-metadata document, and we have one.
 *   2. DCR    — the AS will register a client on demand (RFC 7591).
 *   3. manual — the user pasted a client id from the server's dashboard.
 *
 * CIMD IS WIRED BUT UNREACHABLE, exactly as in the donor: Telar hosts no client
 * document, so no caller passes `clientDocUrl` and this tier never wins. It is
 * left in place because the day there is a hosted URL, nothing else changes.
 */
export function decideClientStrategy(
  as: Pick<AuthServerMeta, "registrationEndpoint" | "supportsCimd">,
  overrides: Pick<McpOAuthOverrides, "clientId">,
  options?: { clientDocUrl?: string },
): ClientStrategy {
  if (as.supportsCimd && options?.clientDocUrl) return "cimd";
  if (as.registrationEndpoint) return "dcr";
  if (overrides.clientId) return "manual";
  throw new Error(NO_CLIENT_STRATEGY);
}

/** Matched by the route so the cockpit can offer the one action that fixes it —
 *  pasting a client id — instead of rendering a 502. */
export const NO_CLIENT_STRATEGY =
  "no usable client-identity strategy: the authorization server supports neither a hosted client document nor dynamic registration, and no client ID is configured";

/** RFC 7591 dynamic client registration. `token_endpoint_auth_method: "none"`
 *  because this is a public client: PKCE is the proof, not a shipped secret. */
export async function dcrRegister(options: {
  registrationEndpoint: string;
  redirectUris: string[];
  scopes?: string[];
  clientName?: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthClient> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const metadata: Record<string, unknown> = {
    redirect_uris: options.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_name: options.clientName ?? "Telar",
  };
  if (options.scopes?.length) metadata.scope = options.scopes.join(" ");

  const response = await fetchImpl(options.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) {
    throw new Error(`dynamic registration at ${options.registrationEndpoint} → ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.client_id !== "string") throw new Error("dynamic registration returned no client_id");
  if (typeof body.client_secret === "string" && body.client_secret) {
    // A confidential client is not something a locally-installed app can keep.
    // Refusing is honest; storing it and pretending otherwise is not.
    throw new Error(
      "this authorization server issued a confidential client, which Telar cannot hold safely on your machine — " +
        "register a public (PKCE) client in its dashboard and paste the client ID instead",
    );
  }
  return {
    strategy: "dcr",
    id: body.client_id,
    ...(typeof body.registration_access_token === "string"
      ? { registrationAccessToken: body.registration_access_token }
      : {}),
  };
}

/**
 * The two store operations the ladder needs, and no others.
 *
 * A DCR REGISTRATION IS AS-SCOPED, NOT SERVER-SCOPED. One authorization server
 * covering three MCP servers should hold ONE registered client, not three: some
 * servers (Supabase was the one that taught the donor this) reject a
 * freshly-minted client id outright, and every extra registration is another
 * stray OAuth app in somebody's account.
 */
export type OAuthClientStore = {
  /** A DCR client that has already yielded a token on this issuer — this
   *  server's own first, then any other. Proven, because an aborted connect can
   *  leave an unproven one behind. */
  findProvenDcrClient(issuer: string, serverId: string, projectId?: string): OAuthClient | undefined;
  /** The registration this slot is mid-flow with, proven or not. */
  findPendingDcrClient(serverId: string, projectId?: string): OAuthClient | undefined;
  /** Remember a registration BEFORE any token exists, so a retried Connect
   *  reuses it rather than registering a second app. */
  rememberClient(input: { serverId: string; projectId?: string; resource: string; as: AuthServerMeta; client: OAuthClient }): void;
};

export async function ensureClient(options: {
  serverId: string;
  projectId?: string;
  resource: string;
  as: AuthServerMeta;
  overrides: McpOAuthOverrides;
  redirectUri: string;
  store: OAuthClientStore;
  clientName?: string;
  clientDocUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthClient> {
  const strategy = decideClientStrategy(options.as, options.overrides, {
    ...(options.clientDocUrl ? { clientDocUrl: options.clientDocUrl } : {}),
  });

  if (strategy === "cimd") return { strategy: "cimd", id: options.clientDocUrl! };
  if (strategy === "manual") return { strategy: "manual", id: options.overrides.clientId! };

  const proven = options.store.findProvenDcrClient(options.as.issuer, options.serverId, options.projectId);
  if (proven && proven.redirectUri === options.redirectUri) {
    options.store.rememberClient({
      serverId: options.serverId,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      resource: options.resource,
      as: options.as,
      client: proven,
    });
    return proven;
  }
  const pending = options.store.findPendingDcrClient(options.serverId, options.projectId);
  if (pending?.id && pending.redirectUri === options.redirectUri) return pending;

  const client: OAuthClient = {
    ...(await dcrRegister({
      registrationEndpoint: options.as.registrationEndpoint!,
      redirectUris: [options.redirectUri],
      ...(options.overrides.scopes ? { scopes: options.overrides.scopes } : {}),
      ...(options.clientName ? { clientName: options.clientName } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })),
    redirectUri: options.redirectUri,
  };
  options.store.rememberClient({
    serverId: options.serverId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    resource: options.resource,
    as: options.as,
    client,
  });
  return client;
}

// ── PKCE (RFC 7636), S256 only ───────────────────────────────────────────────

export function generateCodeVerifier(): string {
  // 32 random bytes → 43 base64url characters, inside the spec's 43–128 range,
  // and base64url's alphabet is a subset of the unreserved set it requires.
  return crypto.randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: codeChallenge(verifier), method: "S256" };
}

// ── the authorization URL ────────────────────────────────────────────────────

export function buildAuthorizationUrl(options: {
  as: AuthServerMeta;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes?: string[];
  codeChallenge: string;
  state?: string;
}): { url: string; state: string } {
  const state = options.state ?? crypto.randomBytes(16).toString("base64url");
  const url = new URL(options.as.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  if (options.scopes?.length) url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: bind the token to THIS server, so a token minted here cannot be
  // replayed against a different MCP server behind the same authorization server.
  url.searchParams.set("resource", options.resource);
  return { url: url.toString(), state };
}

// ── token exchange and refresh ───────────────────────────────────────────────

/**
 * Never accept a token minted for someone else.
 *
 * When the access token is a JWT carrying `aud`, it must name this resource.
 * Opaque tokens and JWTs without an audience pass through — the `resource`
 * parameter already bound them at the authorization server and there is nothing
 * here to inspect. This is a defence-in-depth check, not the only one.
 */
export function assertTokenAudience(accessToken: string, resource: string): void {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return; // opaque
  let audience: unknown;
  try {
    audience = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { aud?: unknown }).aud;
  } catch {
    return; // undecodable payload — treat as opaque
  }
  if (audience === undefined) return;
  const audiences = (Array.isArray(audience) ? audience : [audience]).map(String);
  const matches = audiences.some((entry) => {
    if (entry === resource) return true;
    try {
      return canonicalResource(entry) === resource; // tolerate the trailing-slash form
    } catch {
      return false;
    }
  });
  if (!matches) {
    throw new Error(`access token audience ${JSON.stringify(audience)} does not match resource ${resource}`);
  }
}

function parseTokenResponse(body: Record<string, unknown>, previousRefresh?: string): OAuthTokens {
  if (typeof body.access_token !== "string") throw new Error("token response contained no access_token");
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
  return {
    accessToken: body.access_token,
    // Rotated when the server sends a new one, kept when it does not — a server
    // that rotates and a server that does not both have to keep working.
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  as: AuthServerMeta,
  client: OAuthClient,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  body.set("client_id", client.id);
  const response = await fetchImpl(as.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`token endpoint ${as.tokenEndpoint} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

export async function exchangeCode(options: {
  as: AuthServerMeta;
  client: OAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const body = await tokenRequest(fetchImpl, options.as, options.client, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    resource: options.resource,
  });
  const tokens = parseTokenResponse(body);
  assertTokenAudience(tokens.accessToken, options.resource);
  return tokens;
}

export async function refreshAccessToken(options: {
  as: AuthServerMeta;
  client: OAuthClient;
  refreshToken: string;
  resource: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    resource: options.resource,
  };
  if (options.scopes?.length) params.scope = options.scopes.join(" ");
  const body = await tokenRequest(fetchImpl, options.as, options.client, params);
  const tokens = parseTokenResponse(body, options.refreshToken);
  assertTokenAudience(tokens.accessToken, options.resource);
  return tokens;
}

/**
 * Is this token expired, or close enough that a turn would outlive it?
 *
 * `skewSeconds` is the margin, and it exists because the refresh happens at
 * CLAIM time while the token is used for the whole turn — a token with 20
 * seconds left is already useless. No expiry known → false: the caller cannot
 * do better than try it, and a 401 is the honest signal.
 */
export function needsRefresh(record: McpOAuthRecord, skewSeconds = 120, now = Date.now()): boolean {
  const { expiresAt } = record.tokens;
  if (expiresAt === undefined) return false;
  return now >= expiresAt - skewSeconds * 1000;
}

// ── the connect orchestrators the routes call ────────────────────────────────

export type ConnectContext = {
  resource: string;
  as: AuthServerMeta;
  client: OAuthClient;
  state: string;
  /** The caller stashes this with the state, for the callback. It is a secret
   *  for the length of one flow. */
  codeVerifier: string;
  authorizationUrl: string;
  redirectUri: string;
};

const DEFAULT_REDIRECT_PATH = "/api/mcp/oauth/callback";

/**
 * The origin the authorization server will send the browser back to.
 *
 * IT COMES FROM THE REQUEST that started the connect, not from a constant,
 * because the callback has to land on the cockpit the user is actually looking
 * at — which may be on any port, or on a tailnet name. Same scheme rule as
 * everything else here, plus it must be a BARE origin: a path, credentials or a
 * query smuggled in is how `redirect_uri` manipulation starts.
 */
export function resolveRedirectUri(origin: string, redirectPath = DEFAULT_REDIRECT_PATH): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`redirect origin is not a valid URL: ${origin}`);
  }
  if (parsed.origin !== origin) throw new Error(`redirect origin must be bare (scheme://host[:port]): ${origin}`);
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`redirect origin must be https (or an http loopback origin): ${origin}`);
  }
  // `@` would turn "http://localhost:3000" + "@evil.com/cb" into a URL whose
  // host is evil.com. Require a plain absolute path and re-check the origin.
  if (!redirectPath.startsWith("/") || redirectPath.includes("@")) {
    throw new Error(`redirect path ${JSON.stringify(redirectPath)} must be an absolute path with no '@'`);
  }
  const uri = new URL(redirectPath, parsed.origin);
  if (uri.origin !== parsed.origin) throw new Error(`redirect path ${JSON.stringify(redirectPath)} escapes ${parsed.origin}`);
  return uri.toString();
}

export async function beginConnect(options: {
  serverId: string;
  projectId?: string;
  serverUrl: string;
  overrides?: McpOAuthOverrides;
  redirectOrigin: string;
  store: OAuthClientStore;
  clientName?: string;
  fetchImpl?: typeof fetch;
}): Promise<ConnectContext> {
  const overrides = options.overrides ?? {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const redirectUri = resolveRedirectUri(options.redirectOrigin);
  const { resource, ...as } = await discover({
    serverUrl: options.serverUrl,
    ...(overrides.authorizationServer ? { authorizationServer: overrides.authorizationServer } : {}),
    fetchImpl,
  });
  const client = await ensureClient({
    serverId: options.serverId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    resource,
    as,
    overrides,
    redirectUri,
    store: options.store,
    ...(options.clientName ? { clientName: options.clientName } : {}),
    fetchImpl,
  });
  const { verifier, challenge } = generatePkce();
  const { url, state } = buildAuthorizationUrl({
    as,
    clientId: client.id,
    redirectUri,
    resource,
    ...(overrides.scopes ? { scopes: overrides.scopes } : {}),
    codeChallenge: challenge,
  });
  return { resource, as, client, state, codeVerifier: verifier, authorizationUrl: url, redirectUri };
}

export async function completeConnect(options: {
  ctx: ConnectContext;
  code: string;
  /** Whatever the callback came back with. */
  returnedState: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  // Enforced HERE rather than trusted to each route: PKCE covers code
  // interception, but only the state comparison covers a code injected by a
  // third party into a flow we started.
  if (options.returnedState !== options.ctx.state) {
    throw new Error("OAuth state mismatch — refusing the token exchange");
  }
  return exchangeCode({
    as: options.ctx.as,
    client: options.ctx.client,
    code: options.code,
    codeVerifier: options.ctx.codeVerifier,
    redirectUri: options.ctx.redirectUri,
    resource: options.ctx.resource,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
