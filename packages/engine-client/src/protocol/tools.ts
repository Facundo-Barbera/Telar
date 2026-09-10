/**
 * Telar's own tools are MCP tools, and they get ONE server and ONE naming rule.
 *
 * THE SHAPE IS t3 CODE'S, and it is worth stating why rather than just copying.
 * Its server is `t3-code` and its tools are capability-prefixed — a model sees
 * `mcp__t3-code__preview_navigate`, and the toolkit lives under
 * `mcp/toolkits/preview/` behind a `requireMcpCapability("preview")` gate. So:
 * one server, many capabilities, and the capability is legible in the tool name
 * itself.
 *
 * WHAT WE HAD INSTEAD, and what it cost. The browser was registered as a server
 * called `browser` holding tools called `browser_*`, so the model saw
 * `mcp__browser__browser_navigate` — the stutter is the visible symptom, but the
 * real defect is structural in two ways:
 *
 *   1. Every new Telar toolkit would have become its own MCP SERVER. Ten
 *      capabilities, ten servers, and a client grouping tool calls "by server"
 *      would show ten groups that are all just Telar.
 *   2. Nothing could tell a Telar tool from a user-configured one. The contract
 *      has had a `browser_action` item type since v2 was written, the cockpit
 *      has an icon for it — and NOTHING EVER PRODUCED ONE, because
 *      `mcp__browser__…` matched the generic `mcp__` arm in
 *      `itemDetailForToolCall` and every browser call rendered as an anonymous
 *      MCP row. Fixing the name is what makes the type reachable.
 *
 * The rule, from here on: a Telar tool is `mcp__telar__<capability>_<verb>`.
 * `assertTelarToolNames` is run over every toolkit by a test, so a tool added
 * without its prefix fails the build rather than quietly landing in the generic
 * bucket.
 */

/** The server Telar's in-process tools are registered under. */
export const TELAR_MCP_SERVER = "telar";

/**
 * The browser's own server — ONE NAMESPACE, TWO REGISTRATIONS, and the second
 * exists for a wire reason rather than a naming one. The browser must be
 * reachable by Codex, and the Codex app-server takes MCP servers as CONFIG (a
 * url), not as an in-process handle — so the browser is served over HTTP by the
 * worker that owns it, and an HTTP server cannot share the `telar` key with the
 * in-process server that still carries the spool and warp. Both keys are
 * Telar's: `isTelarMcpServer` is what the capability mapping and the approval
 * posture read, so a `browser_*` call is a `browser_action` row on either
 * provider.
 *
 * THE NAME IS CONSTRAINED BY CODEX: server ids must match `^[a-zA-Z0-9_-]+$`
 * (measured — see docs/deferred-work.md), so no dot-separated spelling.
 */
export const TELAR_BROWSER_MCP_SERVER = "telar-browser";

/**
 * The sessions wall's HTTP registration, for the same wire reason as the
 * browser's: Codex takes MCP servers as CONFIG (a url), so the worker serves
 * the `sessions_*` wall over a session-scoped socket and points Codex at it.
 * Claude keeps its in-process registration under `telar` — renaming a shipped
 * tool would split its identity — so this key exists only where the in-process
 * handle cannot reach. Same character constraint as the browser's: Codex
 * server ids must match `^[a-zA-Z0-9_-]+$`.
 */
export const TELAR_SESSIONS_MCP_SERVER = "telar-sessions";

/** Every server key Telar registers its own tools under. */
export const TELAR_MCP_SERVERS = [TELAR_MCP_SERVER, TELAR_BROWSER_MCP_SERVER, TELAR_SESSIONS_MCP_SERVER] as const;

/** Whether a parsed server key is one of Telar's own. */
export function isTelarMcpServer(server: string | undefined): boolean {
  return server !== undefined && (TELAR_MCP_SERVERS as readonly string[]).includes(server);
}

/**
 * Capabilities Telar exposes. Adding one here is the whole registration: the
 * prefix check, the item mapping and the approval routing all read this list.
 *
 * THE LIST IS DELIBERATELY NOT PADDED with the ones that are planned. A
 * capability named here that nothing implements is a tool namespace the model
 * can be told about and then cannot use — so an entry appears in the same change
 * that ships its toolkit, never before.
 */
export const TELAR_CAPABILITIES = ["browser", "spool", "sessions", "notebook", "ds", "latex", "display", "run"] as const;
export type TelarCapability = (typeof TELAR_CAPABILITIES)[number];

const MCP_PREFIX = "mcp__";

/**
 * The one canonical spelling of "tool `t` on server `s`".
 *
 * PROVIDERS DISAGREE ABOUT THIS AND THE CONTRACT MUST NOT. Claude reports
 * `mcp__linear__search`; the Codex app-server reports `{ server: "linear", tool:
 * "search" }`, which the driver used to render as `linear.search`. That left one
 * MCP tool with two names depending on which provider happened to call it — so
 * a client grouping by tool, an approval remembered per tool, and a
 * `browser_action` check all silently split in two. Claude's spelling wins
 * because it is the one that already arrives on a wire we do not control.
 */
export function canonicalToolName(server: string | undefined, tool: string): string {
  return server ? `${MCP_PREFIX}${server}__${tool}` : tool;
}

/** The name a model sees for one of our tools. The default server is the
 *  in-process one; the browser's callers name `TELAR_BROWSER_MCP_SERVER`
 *  explicitly. The default is deliberately unchanged — shifting it would
 *  silently rename every spool tool. */
export function qualifyTelarTool(tool: string, server: string = TELAR_MCP_SERVER): string {
  return canonicalToolName(server, tool);
}

export type ParsedToolName = {
  /** The MCP server, when the name is qualified at all. */
  server?: string;
  /** The tool as its server knows it — never the qualified form. */
  tool: string;
  /** Set only for Telar's own tools whose prefix names a known capability. */
  capability?: TelarCapability;
};

/**
 * Split a provider tool name into server, tool and (for ours) capability.
 *
 * THE REST-JOIN ON `__` IS NOT PEDANTRY. The previous code did
 * `name.split("__")` and took `[1]`, which is correct for the server but throws
 * away everything after it — and an MCP server is perfectly entitled to a tool
 * name containing `__`. Rejoining the tail keeps `mcp__github__fetch__pr`
 * meaning a tool called `fetch__pr` rather than a tool called `fetch`.
 */
export function parseToolName(name: string): ParsedToolName {
  if (!name.startsWith(MCP_PREFIX)) return { tool: name };
  const [, server, ...rest] = name.split("__");
  if (!server || rest.length === 0) return { tool: name };
  const tool = rest.join("__");
  if (!isTelarMcpServer(server)) return { server, tool };
  const capability = TELAR_CAPABILITIES.find((known) => tool.startsWith(`${known}_`));
  return { server, tool, ...(capability ? { capability } : {}) };
}

/**
 * The label a human should read. Strips the `mcp__server__` framing, which is
 * addressing information rather than meaning — an approval card asking whether
 * you permit `mcp__telar__browser_click` reads worse than `browser_click`, and
 * the qualified name is still what the item stores.
 */
export function displayToolName(name: string): string {
  return parseToolName(name).tool;
}

/**
 * Fail loudly when a toolkit exposes a name that does not declare its
 * capability. Called from a test rather than at startup: a mis-prefixed tool is
 * a coding error, and the cost of catching it at runtime is a daemon that
 * refuses to start over a string.
 */
export function assertTelarToolNames(names: readonly string[]): void {
  const bad = names.filter((name) => !TELAR_CAPABILITIES.some((capability) => name.startsWith(`${capability}_`)));
  if (bad.length > 0) {
    throw new Error(
      `Telar MCP tools must be prefixed with a declared capability (${TELAR_CAPABILITIES.join(", ")}); got: ${bad.join(", ")}`,
    );
  }
}
