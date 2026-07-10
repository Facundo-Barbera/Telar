// Per-project MCP servers (docs/runtime-architecture.md §B): materialize a
// project's manifest `mcpServers` into concrete SDK configs, resolving each
// { secret } reference from the secret store. DECOUPLED from the Claude
// account by construction — tokens are read here on their OWN path (getMcpToken)
// and attached to each server's own env/headers, NEVER via accountEnv, so
// switching a loom/session's account can't rotate MCP auth. This is the only
// place MCP tokens are read.
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getProject } from "./manifest";
import { readSecret, writeSecret } from "./secrets";
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
