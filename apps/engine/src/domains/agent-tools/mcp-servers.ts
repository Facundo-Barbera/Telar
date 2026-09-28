import { McpServer as McpServerSchema, McpServerSpec as McpServerSpecSchema, type McpServer } from "@telar/engine-client";
import { assertId, EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";

type McpServerDeps = {
  requireProject: (projectId: string) => void;
  forgetGrant: (serverId: string, projectId?: string) => void;
};

/**
 * The user's MCP servers, machine-wide or per project, in one document. Keyed by
 * `(projectId, id)`: the id is the name tools are addressed by, and two scopes
 * may spell it the same.
 */
export class McpServers {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: McpServerDeps,
  ) {}

  /** Absent scope returns everything, `null` the machine's, a project id that project's. */
  list(scope?: { projectId: string | null }): McpServer[] {
    const stored = this.kernel.readDocument(this.kernel.paths.mcpServers) as { mcpServers?: unknown } | undefined;
    const parsed = McpServerSchema.array().safeParse(stored?.mcpServers ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid MCP server registry");
    const all = structuredClone(parsed.data);
    if (scope === undefined) return all;
    if (scope.projectId === null) return all.filter((server) => server.projectId === undefined);
    return all.filter((server) => server.projectId === scope.projectId);
  }

  save(input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: unknown }): McpServer {
    assertId(input.id, "mcp server id");
    if (input.projectId !== undefined) this.deps.requireProject(input.projectId);
    const spec = McpServerSpecSchema.safeParse(input.spec);
    if (!spec.success) throw new EngineStateError("invalid_request", "MCP server configuration is invalid");
    const servers = this.list();
    const at = this.kernel.now();
    const sameSlot = (server: McpServer) => server.id === input.id && server.projectId === input.projectId;
    const existing = servers.find(sameSlot);
    const server: McpServer = {
      id: input.id,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      label: (input.label ?? existing?.label ?? input.id).trim().slice(0, 120) || input.id,
      enabled: input.enabled ?? existing?.enabled ?? true,
      spec: spec.data,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.write(existing ? servers.map((entry) => (sameSlot(entry) ? server : entry)) : [...servers, server]);
    return structuredClone(server);
  }

  /** Scoped removal; the grant goes too, so it can't re-attach to the next server of that id. */
  remove(id: string, projectId?: string): boolean {
    assertId(id, "mcp server id");
    const servers = this.list();
    const next = servers.filter((server) => !(server.id === id && server.projectId === projectId));
    if (next.length === servers.length) return false;
    this.write(next);
    this.deps.forgetGrant(id, projectId);
    return true;
  }

  private write(mcpServers: McpServer[]): void {
    this.kernel.writeDocument(this.kernel.paths.mcpServers, { version: STATE_VERSION, mcpServers });
  }
}
