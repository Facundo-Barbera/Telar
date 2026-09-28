import { needsRefresh, refreshAccessToken, type ConnectContext, type McpOAuthRecord, type OAuthClientStore } from "../../mcp-oauth";
import { SECRET_KEY_SEPARATOR, STATE_VERSION, type Kernel } from "../../platform/kernel";

/** A sign-in mid-flight; the callback needs everything in `ctx` and is given none of it. */
export type PendingMcpOAuth = { serverId: string; projectId?: string; ctx: ConnectContext; createdAt: number };

const PENDING_MCP_OAUTH_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_SECONDS = 120;

/**
 * MCP server sign-ins, the one credential Telar mints: a third-party server has
 * no other store for its grant. Keyed like the server, `(projectId, serverId)`,
 * so a project's server and the machine's hold different grants.
 */
export class McpOAuthStore {
  constructor(private readonly kernel: Kernel) {}

  /** Tokens and all; for the claim and the refresh, never a route. */
  get(serverId: string, projectId?: string): McpOAuthRecord | undefined {
    const record = this.records()[key(serverId, projectId)];
    return record ? structuredClone(record) : undefined;
  }

  put(record: McpOAuthRecord): void {
    const records = this.records();
    records[key(record.serverId, record.projectId)] = { ...record, updatedAt: this.kernel.now() };
    this.writeRecords(records);
  }

  delete(serverId: string, projectId?: string): boolean {
    const records = this.records();
    const k = key(serverId, projectId);
    if (!(k in records)) return false;
    delete records[k];
    this.writeRecords(records);
    return true;
  }

  /** A dynamic client registration is issuer-scoped, so servers behind one issuer share one proven client. */
  clientStore(): OAuthClientStore {
    return {
      findProvenDcrClient: (issuer, serverId, projectId) => {
        const records = this.records();
        const proven = (record: McpOAuthRecord | undefined): boolean =>
          record?.client?.strategy === "dcr" && Boolean(record.client.id) && Boolean(record.tokens?.accessToken);
        const own = records[key(serverId, projectId)];
        if (proven(own)) return structuredClone(own!.client);
        for (const record of Object.values(records)) {
          if (record.as?.issuer === issuer && proven(record)) return structuredClone(record.client);
        }
        return undefined;
      },
      findPendingDcrClient: (serverId, projectId) => {
        const record = this.records()[key(serverId, projectId)];
        return record?.client?.strategy === "dcr" && record.client.id ? structuredClone(record.client) : undefined;
      },
      rememberClient: ({ serverId, projectId, resource, as, client }) => {
        // Runs before the exchange; a reconnect must not blank a working grant.
        const existing = this.get(serverId, projectId);
        this.put({
          serverId,
          ...(projectId === undefined ? {} : { projectId }),
          resource,
          as,
          client,
          tokens: existing?.tokens ?? { accessToken: "" },
          updatedAt: this.kernel.now(),
        });
      },
    };
  }

  /** Stashes an in-flight sign-in by its `state`, sweeping abandoned ones on the way in. */
  putPending(flow: PendingMcpOAuth): void {
    const flows = this.prunePending(this.readPending());
    flows[flow.ctx.state] = flow;
    this.kernel.writeDocument(this.kernel.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
  }

  /** Single use. Not atomic across processes; the authorization code's own single use is the backstop. */
  takePending(state: string): PendingMcpOAuth | undefined {
    if (!state) return undefined;
    const flows = this.prunePending(this.readPending());
    const flow = flows[state];
    delete flows[state];
    this.kernel.writeDocument(this.kernel.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
    return flow;
  }

  /** The token to run with, refreshed near expiry. A failed refresh returns the old token rather than failing the turn. */
  async resolveToken(serverId: string, projectId: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
    const record = this.get(serverId, projectId);
    if (!record?.tokens.accessToken) return undefined;
    if (!needsRefresh(record, REFRESH_MARGIN_SECONDS, this.kernel.now()) || !record.tokens.refreshToken) return record.tokens.accessToken;
    try {
      const tokens = await refreshAccessToken({
        as: record.as,
        client: record.client,
        refreshToken: record.tokens.refreshToken,
        resource: record.resource,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      this.put({ ...record, tokens });
      return tokens.accessToken;
    } catch {
      return record.tokens.accessToken;
    }
  }

  private records(): Record<string, McpOAuthRecord> {
    const stored = this.kernel.readDocument(this.kernel.paths.mcpOAuth) as { records?: unknown } | undefined;
    const records = stored?.records;
    if (!records || typeof records !== "object") return {};
    return records as Record<string, McpOAuthRecord>;
  }

  private writeRecords(records: Record<string, McpOAuthRecord>): void {
    this.kernel.writeDocument(this.kernel.paths.mcpOAuth, { version: STATE_VERSION, records });
  }

  private readPending(): Record<string, PendingMcpOAuth> {
    const stored = this.kernel.readDocument(this.kernel.paths.mcpOAuthPending) as { flows?: unknown } | undefined;
    const flows = stored?.flows;
    if (!flows || typeof flows !== "object") return {};
    return flows as Record<string, PendingMcpOAuth>;
  }

  private prunePending(flows: Record<string, PendingMcpOAuth>): Record<string, PendingMcpOAuth> {
    const cutoff = this.kernel.now() - PENDING_MCP_OAUTH_TTL_MS;
    for (const [state, flow] of Object.entries(flows)) {
      if (!flow || typeof flow.createdAt !== "number" || flow.createdAt <= cutoff) delete flows[state];
    }
    return flows;
  }
}

// A space can't appear in either half: both are ids.
function key(serverId: string, projectId?: string): string {
  return (projectId ?? "") + SECRET_KEY_SEPARATOR + serverId;
}
