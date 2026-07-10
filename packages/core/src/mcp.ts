// Per-project MCP servers (docs/runtime-architecture.md §B): materialize a
// project's manifest `mcpServers` into concrete SDK configs, resolving each
// { secret } reference from the secret store. DECOUPLED from the Claude
// account by construction — tokens are read here on their OWN path (getMcpToken)
// and attached to each server's own env/headers, NEVER via accountEnv, so
// switching a loom/session's account can't rotate MCP auth. This is the only
// place MCP tokens are read.
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getProject } from "./manifest";
import { getRecord, needsRefresh, refreshRecord } from "./mcp-oauth";
import { deleteSecret, readSecret, writeSecret } from "./secrets";
import type { McpValue } from "./schemas";

// MCP tokens live under a distinct namespace so they can never collide with an
// account's token (secrets.ts keys those by the bare account name).
const mcpKey = (project: string, key: string) => `mcp:${project}:${key}`;

export function setMcpToken(project: string, key: string, token: string): void {
  writeSecret(mcpKey(project, key), token);
}

export function getMcpToken(project: string, key: string): string | undefined {
  return readSecret(mcpKey(project, key));
}

// Forget a stored MCP token. Returns true if one existed and was removed.
export function clearMcpToken(project: string, key: string): boolean {
  return deleteSecret(mcpKey(project, key));
}

// Is a token stored for this secret key? (Never returns the value itself.)
export function hasMcpToken(project: string, key: string): boolean {
  return getMcpToken(project, key) !== undefined;
}

// The distinct secret keys a project's manifest declares across every MCP
// server's env/headers { secret } refs — the set of tokens the UI must let the
// user fill. Sorted + deduped; [] when the project declares no mcpServers.
export function declaredMcpSecretKeys(project: string): string[] {
  const servers = getProject(project).manifest.mcpServers;
  const keys = new Set<string>();
  const scan = (rec: Record<string, McpValue> | undefined) => {
    for (const v of Object.values(rec ?? {})) {
      if (typeof v !== "string") keys.add(v.secret);
    }
  };
  for (const cfg of Object.values(servers)) {
    if (cfg.transport === "stdio") scan(cfg.env);
    else scan(cfg.headers);
  }
  return [...keys].sort();
}

// One warning per missing token key (per process) — a server with a missing
// token just fails auth later; we never throw here.
const warned = new Set<string>();

function resolveValue(value: McpValue, project: string, serverName: string): string {
  if (typeof value === "string") return value;
  const token = getMcpToken(project, value.secret);
  if (token === undefined) {
    const k = mcpKey(project, value.secret);
    if (!warned.has(k)) {
      warned.add(k);
      console.warn(`[mcp] missing token ${k} for server ${serverName}`);
    }
  }
  return (value.prefix ?? "") + (token ?? "");
}

function resolveRecord(
  rec: Record<string, McpValue> | undefined,
  project: string,
  serverName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec ?? {})) out[k] = resolveValue(v, project, serverName);
  return out;
}

export function resolveProjectMcpServers(projectName: string): Record<string, SdkMcpServerConfig> {
  const servers = getProject(projectName).manifest.mcpServers;
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.transport === "stdio") {
      out[name] = {
        type: "stdio",
        command: cfg.command,
        args: cfg.args,
        env: resolveRecord(cfg.env, projectName, name),
      };
    } else {
      const headers = resolveRecord(cfg.headers, projectName, name);
      // Telar-owned OAuth (docs/mcp-oauth-design.md §3/§5): for an http server
      // that declares auth.type === "oauth", auto-inject the managed Bearer
      // token from the mirrored mcp:<project>:<server> slot — unless the user
      // already wired an Authorization header themselves. A missing token warns
      // + injects an empty Bearer (401s later), exactly like any other missing
      // secret; it never throws. resolveValue is reused so the warn behavior is
      // identical to the manual { secret } path.
      if (cfg.auth?.type === "oauth" && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
        headers.Authorization = resolveValue({ secret: name, prefix: "Bearer " }, projectName, name);
      }
      out[name] = {
        type: "http",
        url: cfg.url,
        headers,
      };
    }
  }
  return out;
}

// Before a run, refresh any near-expiry Telar-owned OAuth tokens so the Bearer
// resolveProjectMcpServers injects is live (docs/mcp-oauth-design.md §5). Each
// server is isolated in try/catch and BEST-EFFORT: a refresh failure (network,
// revoked refresh token) must never throw out of here — a stale token just 401s
// at use. No-op when the project declares no oauth servers.
export async function refreshProjectMcpAuth(project: string): Promise<void> {
  const servers = getProject(project).manifest.mcpServers;
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.transport !== "http" || cfg.auth?.type !== "oauth") continue;
    try {
      const record = getRecord(project, name);
      if (record && needsRefresh(record)) await refreshRecord(record);
    } catch {
      // Best-effort: swallow so one server's refresh failure can't abort a run.
    }
  }
}
