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
  redirectUri?: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

export type McpOAuthOverrides = {
  authorizationServer?: string;
  clientId?: string;
  scopes?: string[];
};

export type McpOAuthRecord = {
  projectId?: string;
  serverId: string;
  resource: string;
  as: AuthServerMeta;
  client: OAuthClient;
  tokens: OAuthTokens;
  updatedAt: number;
};

export type DiscoveryResult = AuthServerMeta & { resource: string };

export function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function parseResourceMetadata(header: string | null): string | undefined {
  if (!header) return undefined;
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1];
}

function prmWellKnownUrl(resource: string): string {
  const url = new URL(resource);
  const suffix = url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
}

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
    }
    pointer ??= prmWellKnownUrl(resource);
    assertSecureUrl(pointer, "resource metadata URL");
    const metadata = await fetchJson(fetchImpl, pointer);
    const servers = metadata.authorization_servers;
    issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
    if (!issuer) throw new Error(`protected resource metadata for ${resource} lists no authorization_servers`);
  }

  assertSecureUrl(issuer, "authorization server issuer");
  return { ...(await fetchAuthServerMeta(fetchImpl, issuer)), resource };
}

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
    }
    const wellKnown = prmWellKnownUrl(canonicalResource(serverUrl));
    const metadata = await fetchJson(fetchImpl, wellKnown);
    const servers = metadata.authorization_servers;
    if (Array.isArray(servers) && servers.length > 0) return { requiresOAuth: true, resourceMetadataUrl: wellKnown };
    return { requiresOAuth: false };
  } catch {
    return { requiresOAuth: false };
  }
}

export async function checkMcpHealth(
  serverUrl: string,
  options?: { token?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch },
): Promise<"connected" | "needs-auth" | "error"> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    const headers: Record<string, string> = {
      ...options?.headers,
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

export const NO_CLIENT_STRATEGY =
  "no usable client-identity strategy: the authorization server supports neither a hosted client document nor dynamic registration, and no client ID is configured";

async function dcrRegister(options: {
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

export type OAuthClientStore = {
  findProvenDcrClient(issuer: string, serverId: string, projectId?: string): OAuthClient | undefined;
  findPendingDcrClient(serverId: string, projectId?: string): OAuthClient | undefined;
  rememberClient(input: { serverId: string; projectId?: string; resource: string; as: AuthServerMeta; client: OAuthClient }): void;
};

async function ensureClient(options: {
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
  const strategy = decideClientStrategy(options.as, options.overrides, options.clientDocUrl ? { clientDocUrl: options.clientDocUrl } : {});

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

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generatePkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: codeChallenge(verifier), method: "S256" };
}

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
  url.searchParams.set("resource", options.resource);
  return { url: url.toString(), state };
}

export function assertTokenAudience(accessToken: string, resource: string): void {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return;
  let audience: unknown;
  try {
    audience = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { aud?: unknown }).aud;
  } catch {
    return;
  }
  if (audience === undefined) return;
  const audiences = (Array.isArray(audience) ? audience : [audience]).map(String);
  const matches = audiences.some((entry) => {
    if (entry === resource) return true;
    try {
      return canonicalResource(entry) === resource;
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

export function needsRefresh(record: McpOAuthRecord, skewSeconds = 120, now = Date.now()): boolean {
  const { expiresAt } = record.tokens;
  if (expiresAt === undefined) return false;
  return now >= expiresAt - skewSeconds * 1000;
}

export type ConnectContext = {
  resource: string;
  as: AuthServerMeta;
  client: OAuthClient;
  state: string;
  codeVerifier: string;
  authorizationUrl: string;
  redirectUri: string;
};

const DEFAULT_REDIRECT_PATH = "/api/mcp/oauth/callback";

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
  returnedState: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
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
