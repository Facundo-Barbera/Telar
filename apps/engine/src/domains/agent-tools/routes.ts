import { resolveMcpServers, type McpOAuthStatus, type McpServer } from "@telar/engine-client";
import { beginConnect, checkMcpHealth, completeConnect, NO_CLIENT_STRATEGY, probeMcpAuth } from "../../mcp-oauth";
import { fail, ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

type Body = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Probes as us when we hold a grant, anonymously otherwise. Never throws: settings must render offline. */
async function mcpOAuthStatuses(store: EngineStore, servers: McpServer[]): Promise<McpOAuthStatus[]> {
  return Promise.all(
    servers.flatMap((server) => {
      if (server.spec.transport === "stdio") return [];
      const spec = server.spec;
      const record = store.getMcpOAuthRecord(server.id, server.projectId);
      const token = record?.tokens.accessToken || undefined;
      return [
        Promise.all([
          probeMcpAuth(spec.url).then((result) => result.requiresOAuth),
          checkMcpHealth(spec.url, { ...(token ? { token } : {}), ...(spec.headers ? { headers: spec.headers } : {}) }),
        ]).then(([requiresOAuth, health]): McpOAuthStatus => ({
          serverId: server.id,
          ...(server.projectId === undefined ? {} : { projectId: server.projectId }),
          requiresOAuth,
          connected: Boolean(token),
          ...(record?.tokens.expiresAt === undefined ? {} : { expiresAt: record.tokens.expiresAt }),
          ...(record?.tokens.scope ? { scope: record.tokens.scope } : {}),
          ...(record?.as.issuer ? { issuer: record.as.issuer } : {}),
          health,
        })),
      ];
    }),
  );
}

function settingsUrl(projectId: string | undefined, params: Record<string, string>): string {
  const query = new URLSearchParams(projectId ? { section: "projects", project: projectId, ...params } : { section: "tools", ...params });
  return `/settings?${query}`;
}

/** Single use: a replayed or expired state finds nothing, and the two are indistinguishable on purpose. */
async function complete(store: EngineStore, now: () => number, state: string, code: string): Promise<string> {
  const pending = store.takePendingMcpOAuth(state);
  if (!pending) return settingsUrl(undefined, { mcpOAuthError: "this sign-in link has expired or was already used" });
  try {
    const tokens = await completeConnect({ ctx: pending.ctx, code, returnedState: state });
    store.putMcpOAuthRecord({
      serverId: pending.serverId,
      ...(pending.projectId === undefined ? {} : { projectId: pending.projectId }),
      resource: pending.ctx.resource,
      as: pending.ctx.as,
      client: pending.ctx.client,
      tokens,
      updatedAt: now(),
    });
    return settingsUrl(pending.projectId, { mcpConnected: pending.serverId });
  } catch (error) {
    return settingsUrl(undefined, { mcpOAuthError: error instanceof Error ? error.message : "the token exchange failed" });
  }
}

/** Sign-in to third-party MCP servers. The PKCE verifier and state stay in the engine; the cockpit only relays `code`. */
export function mcpOAuthRoutes(store: EngineStore, now: () => number): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/mcp-oauth",
      auth: "engine",
      async handle({ query }) {
        const projectId = query.get("projectId")?.trim() || undefined;
        const servers = projectId ? resolveMcpServers(store.listMcpServers(), projectId) : store.listMcpServers({ projectId: null });
        return ok({ statuses: await mcpOAuthStatuses(store, servers) });
      },
    },
    {
      method: "POST",
      path: "/v2/mcp-oauth/connect",
      auth: "engine",
      async handle({ body }: { body: Body }) {
        const serverId = text(body.serverId);
        const redirectOrigin = text(body.redirectOrigin);
        const projectId = text(body.projectId);
        if (!serverId || !redirectOrigin) return fail(400, "invalid_request", "serverId and redirectOrigin are required");
        const server = store.listMcpServers().find((candidate) => candidate.id === serverId && candidate.projectId === projectId);
        if (!server) return fail(404, "not_found", `no MCP server "${serverId}" in this scope`);
        if (server.spec.transport === "stdio") return fail(400, "invalid_request", `"${serverId}" runs as a local command, so there is nothing to sign in to`);
        try {
          const ctx = await beginConnect({
            serverId,
            ...(projectId === undefined ? {} : { projectId }),
            serverUrl: server.spec.url,
            ...(server.spec.oauth ? { overrides: server.spec.oauth } : {}),
            redirectOrigin,
            store: store.mcpOAuthClientStore(),
            clientName: `Telar — ${server.label}`,
          });
          store.putPendingMcpOAuth({ serverId, ...(projectId === undefined ? {} : { projectId }), ctx, createdAt: now() });
          return ok({ authorizationUrl: ctx.authorizationUrl });
        } catch (error) {
          const message = error instanceof Error ? error.message : "could not start the sign-in";
          if (message.includes(NO_CLIENT_STRATEGY)) {
            return fail(400, "invalid_request", `"${server.label}" cannot register Telar automatically — add a client ID from the server's own dashboard, save, then sign in again`);
          }
          return fail(502, "provider_unavailable", message);
        }
      },
    },
    {
      method: "GET",
      path: "/v2/mcp-oauth/callback",
      auth: "engine",
      async handle({ query }) {
        const denied = query.get("error");
        if (denied) return ok({ redirect: settingsUrl(undefined, { mcpOAuthError: query.get("error_description") || denied }) });
        const state = query.get("state") ?? "";
        const code = query.get("code") ?? "";
        if (!state || !code) return ok({ redirect: settingsUrl(undefined, { mcpOAuthError: "That sign-in link was incomplete. Start it again from the server's row." }) });
        return ok({ redirect: await complete(store, now, state, code) });
      },
    },
    {
      method: "POST",
      path: "/v2/mcp-oauth/disconnect",
      auth: "engine",
      handle({ body }) {
        const serverId = text(body.serverId);
        if (!serverId) return fail(400, "invalid_request", "serverId is required");
        return ok({ removed: store.deleteMcpOAuthRecord(serverId, text(body.projectId)) });
      },
    },
  ];
}
