import type { EngineTransport } from "../platform/transport";
import type { McpOAuthStatus, McpServer, McpServerSpec } from "./schema";

const serverPath = (id: string, projectId?: string) =>
  projectId ? `/v2/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(id)}` : `/v2/mcp-servers/${encodeURIComponent(id)}`;

export const agentToolsClient = {
  listMcpServers(this: EngineTransport): Promise<{ mcpServers: McpServer[] }> {
    return this.request("GET", "/v2/mcp-servers");
  },

  /** `effective` is the merge the project's sessions actually run with. */
  listProjectMcpServers(this: EngineTransport, projectId: string): Promise<{ mcpServers: McpServer[]; effective: McpServer[] }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/mcp-servers`);
  },

  saveMcpServer(
    this: EngineTransport,
    input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: McpServerSpec },
  ): Promise<{ mcpServer: McpServer }> {
    const { projectId, ...server } = input;
    return this.request("PUT", serverPath(input.id, projectId), server);
  },

  removeMcpServer(this: EngineTransport, id: string, projectId?: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", serverPath(id, projectId));
  },

  mcpOAuthStatus(this: EngineTransport, projectId?: string): Promise<{ statuses: McpOAuthStatus[] }> {
    return this.request("GET", projectId ? `/v2/mcp-oauth?projectId=${encodeURIComponent(projectId)}` : "/v2/mcp-oauth");
  },

  connectMcpOAuth(this: EngineTransport, input: { serverId: string; projectId?: string; redirectOrigin: string }): Promise<{ authorizationUrl: string }> {
    return this.request("POST", "/v2/mcp-oauth/connect", input);
  },

  mcpOAuthCallback(this: EngineTransport, query: string): Promise<{ redirect: string }> {
    return this.request("GET", `/v2/mcp-oauth/callback?${query}`);
  },

  /** Idempotent; `removed` says whether a grant existed. */
  disconnectMcpOAuth(this: EngineTransport, input: { serverId: string; projectId?: string }): Promise<{ removed: boolean }> {
    return this.request("POST", "/v2/mcp-oauth/disconnect", input);
  },
};
