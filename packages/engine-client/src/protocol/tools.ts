import { BUNDLED_PLUGIN_TOOL_PREFIXES } from "./plugins";

/** The server Telar's in-process tools are registered under. */
export const TELAR_MCP_SERVER = "telar";

export const TELAR_BROWSER_MCP_SERVER = "telar-browser";

export const TELAR_SESSIONS_MCP_SERVER = "telar-sessions";

export const TELAR_PLUGINS_MCP_SERVER = "telar-plugins";

/** Every server key Telar registers its own tools under. */
export const TELAR_MCP_SERVERS = [
  TELAR_MCP_SERVER,
  TELAR_BROWSER_MCP_SERVER,
  TELAR_SESSIONS_MCP_SERVER,
  TELAR_PLUGINS_MCP_SERVER,
] as const;

/** Whether a parsed server key is one of Telar's own. */
export function isTelarMcpServer(server: string | undefined): boolean {
  return server !== undefined && (TELAR_MCP_SERVERS as readonly string[]).includes(server);
}

export const TELAR_CORE_CAPABILITIES = ["browser", "sessions", "display", "run", "terminal", "prompt"] as const;

export const TELAR_CAPABILITIES = [...TELAR_CORE_CAPABILITIES, ...BUNDLED_PLUGIN_TOOL_PREFIXES] as const;
export type TelarCapability = (typeof TELAR_CAPABILITIES)[number];

const MCP_PREFIX = "mcp__";

export function canonicalToolName(server: string | undefined, tool: string): string {
  return server ? `${MCP_PREFIX}${server}__${tool}` : tool;
}

export function qualifyTelarTool(tool: string, server: string = TELAR_MCP_SERVER): string {
  return canonicalToolName(server, tool);
}

let installedPrefixes: readonly string[] = [];

export function registerPluginToolPrefixes(prefixes: readonly string[]): void {
  installedPrefixes = prefixes.filter((prefix) => !(TELAR_CAPABILITIES as readonly string[]).includes(prefix));
}

export type ParsedToolName = {
  /** The MCP server, when the name is qualified at all. */
  server?: string;
  /** The tool as its server knows it — never the qualified form. */
  tool: string;
  /**
   * Set only for Telar's own tools whose prefix names a known capability — a
   * core one, a bundled plugin's, or an installed plugin's registered prefix.
   */
  capability?: TelarCapability | (string & {});
};

export function parseToolName(name: string): ParsedToolName {
  if (!name.startsWith(MCP_PREFIX)) return { tool: name };
  const [, server, ...rest] = name.split("__");
  if (!server || rest.length === 0) return { tool: name };
  const tool = rest.join("__");
  if (!isTelarMcpServer(server)) return { server, tool };
  const capability = [...TELAR_CAPABILITIES, ...installedPrefixes].find((known) => tool.startsWith(`${known}_`));
  return { server, tool, ...(capability ? { capability } : {}) };
}

export function displayToolName(name: string): string {
  return parseToolName(name).tool;
}

export function assertTelarToolNames(names: readonly string[]): void {
  const bad = names.filter((name) => !TELAR_CAPABILITIES.some((capability) => name.startsWith(`${capability}_`)));
  if (bad.length > 0) {
    throw new Error(
      `Telar MCP tools must be prefixed with a declared capability (${TELAR_CAPABILITIES.join(", ")}); got: ${bad.join(", ")}`,
    );
  }
}
