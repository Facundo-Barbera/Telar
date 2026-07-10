// Per-project MCP servers (docs/runtime-architecture.md §B): materialize a
// project's manifest `mcpServers` into concrete SDK configs, resolving each
// { secret } reference from the secret store. DECOUPLED from the Claude
// account by construction — tokens are read here on their OWN path (getMcpToken)
// and attached to each server's own env/headers, NEVER via accountEnv, so
// switching a loom/session's account can't rotate MCP auth. This is the only
// place MCP tokens are read.
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getProject } from "./manifest";
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
      out[name] = {
        type: "http",
        url: cfg.url,
        headers: resolveRecord(cfg.headers, projectName, name),
      };
    }
  }
  return out;
}
