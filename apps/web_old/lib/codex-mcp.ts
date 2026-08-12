// THE CLAUDE-SHAPED MCP ROSTER, TRANSLATED FOR CODEX — story 13 of
// SPEC-organization-workspace, closing brownfield.md's "Codex MCP gap".
//
// The roster itself is not re-derived here. `resolveProjectMcpServers` (core)
// is still the ONE place a project's telar.yaml servers are materialized and
// the ONE place MCP tokens are read; this module only re-spells what it
// returned into the fields `codex app-server` understands, so the two providers
// mount the same set from the same source.
//
// ── WHAT DOES NOT CONVERT, AND WHY THAT IS SAID OUT LOUD ─────────────────────
// The SDK's `McpServerConfig` union is wider than Codex's config:
//
//   · `sdk`  — an in-process server OBJECT. It cannot cross a subprocess
//     boundary by definition. Telar's own in-process tools reach Codex by a
//     different road entirely (`dynamicTools`, see harness-tools.ts), so a
//     dropped `sdk` entry here is not a lost capability — it is the entry that
//     was never this transport's to carry.
//   · `sse`  — Codex 0.145's `mcp_servers` table has `command`/`args`/`env`
//     (stdio) and `url`/`http_headers` (streamable HTTP), and no SSE spelling.
//     A project declaring one genuinely loses it on this provider.
//   · `tools` / `timeout` / `alwaysLoad` — real fields on the SDK's stdio and
//     http members with no Codex home. `tools` is a per-server ALLOWLIST, so
//     its loss makes this provider's roster WIDER than Claude's, which is the
//     one direction a silent loss must never take.
//
// And one thing that converts perfectly and is still refused: a server NAME
// Codex will not accept (see CODEX_SERVER_NAME).
//
// So `toCodexMcpServers` returns the DROPS and the NARROWINGS beside the
// servers rather than quietly returning fewer keys, or wider ones, than it was
// given. AD-11: no silent degradation — a caller that ignores them is a caller
// that chose to, visibly, instead of one that never knew.
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { CodexMcpServerConfig } from "@/lib/codex-app-server";

export type CodexMcpDrop = {
  /** The roster key, so a log line names the server the user configured. */
  readonly name: string;
  /** The SDK transport tag of the server that could not be carried. */
  readonly type: string;
  /** Why, in words a human reading a warning can act on. */
  readonly reason: string;
};

/** A server that DID come along, minus fields Codex's `mcp_servers` table has
 *  no home for. Reported separately from a drop because the server is mounted
 *  and working — what changed is its shape, and in `tools`' case its WIDTH. */
export type CodexMcpNarrowing = {
  readonly name: string;
  readonly fields: readonly string[];
  readonly reason: string;
};

export type CodexMcpConversion = {
  readonly servers: Record<string, CodexMcpServerConfig>;
  readonly dropped: readonly CodexMcpDrop[];
  readonly narrowed: readonly CodexMcpNarrowing[];
};

// CODEX'S OWN SERVER-NAME GRAMMAR, copied from the error the app-server emits
// rather than guessed: "Invalid MCP server name 'dot.name': must match pattern
// ^[a-zA-Z0-9_-]+$". Measured against a live `codex app-server` 0.145.0 by
// injecting three servers through the same request `config` overlay this module
// feeds — `plain_name` and `has-dash` both SPAWNED, `dot.name` did not, and the
// only trace was an `mcpServer/startupStatus/updated` notification.
//
// Telar's own roster key type is `z.record(z.string(), …)` (core's schemas.ts),
// so a project may legally declare `mcpServers: { "my.server": … }`; it works on
// Claude. Checking it HERE is what turns "vanishes on Codex" into a named drop
// the human can act on, before anything is spawned.
const CODEX_SERVER_NAME = /^[a-zA-Z0-9_-]+$/;

// Fields the SDK's `McpServerConfig` carries that Codex's table has no spelling
// for. `tools` is the one that matters: it is a per-server ALLOWLIST, so losing
// it makes the Codex roster strictly WIDER than the Claude one — the one
// direction a silent loss must never take. Latent today (nothing sets them), and
// reported anyway, because the SDK union is the declared input type and the next
// caller is the one that fills it.
const UNSUPPORTED_FIELDS: Record<string, string> = {
  tools: "a per-server tool allowlist — dropping it WIDENS this server on Codex",
  timeout: "per-server tool-call timeout",
  alwaysLoad: "eager tool loading",
};

function narrowingOf(name: string, cfg: Record<string, unknown>): CodexMcpNarrowing | null {
  const fields = Object.keys(UNSUPPORTED_FIELDS).filter((f) => cfg[f] !== undefined);
  if (!fields.length) return null;
  return {
    name,
    fields,
    reason: fields.map((f) => `${f}: ${UNSUPPORTED_FIELDS[f]}`).join("; "),
  };
}

/** Claude-shaped roster → Codex-shaped roster, plus what could not come along.
 *
 *  Pure: no manifest read, no secret read, no clock. Everything it needs was
 *  already resolved by `resolveProjectMcpServers`, including the tokens that
 *  are ALREADY inside the `env`/`headers` it copies — which is why the caller
 *  must keep this value off any surface a human or a model can read back. */
export function toCodexMcpServers(
  roster: Readonly<Record<string, McpServerConfig>>,
): CodexMcpConversion {
  const servers: Record<string, CodexMcpServerConfig> = {};
  const dropped: CodexMcpDrop[] = [];
  const narrowed: CodexMcpNarrowing[] = [];
  for (const [name, cfg] of Object.entries(roster)) {
    // `type` is optional on the SDK's stdio member (stdio is its default), so
    // an absent tag means stdio — not "unknown". Reading it the other way
    // would drop the most common server shape there is.
    const type = cfg.type ?? "stdio";
    // NAME FIRST, transport second: a name Codex refuses is a drop whatever the
    // transport is, and reporting it as "no sse transport" would send the human
    // to fix the wrong thing.
    if (!CODEX_SERVER_NAME.test(name)) {
      dropped.push({
        name,
        type,
        reason: `codex rejects this server name — it must match ${CODEX_SERVER_NAME.source}`,
      });
      continue;
    }
    const lost = narrowingOf(name, cfg as unknown as Record<string, unknown>);
    if (lost && (type === "stdio" || type === "http")) narrowed.push(lost);
    if (type === "stdio") {
      const stdio = cfg as McpStdioServerConfig;
      servers[name] = {
        transport: "stdio",
        command: stdio.command,
        ...(stdio.args?.length ? { args: [...stdio.args] } : {}),
        ...(stdio.env && Object.keys(stdio.env).length ? { env: { ...stdio.env } } : {}),
      };
      continue;
    }
    if (type === "http") {
      const http = cfg as McpHttpServerConfig;
      servers[name] = {
        transport: "http",
        url: http.url,
        ...(http.headers && Object.keys(http.headers).length ? { headers: { ...http.headers } } : {}),
      };
      continue;
    }
    dropped.push({
      name,
      type,
      reason:
        type === "sdk"
          ? "in-process servers reach Codex as dynamic tools, not as MCP config"
          : `codex app-server has no ${type} transport in its mcp_servers config`,
    });
  }
  return { servers, dropped, narrowed };
}

/** One warning per loss per SCOPE per process — a dropped server is a standing
 *  condition of a project's config, not a per-turn event, and this runs on
 *  every turn. Same discipline as core's `mcp.ts` missing-token warn.
 *
 *  THE SCOPE IS IN THE KEY, and that is not decoration: this set is
 *  module-global while the roster is per-project, so a bare `name:type` key let
 *  project A's `legacy` permanently silence project B's — the second user never
 *  learns their server is missing. */
const warned = new Set<string>();

export function warnCodexMcpLosses(
  conversion: Pick<CodexMcpConversion, "dropped" | "narrowed">,
  scope: string,
): void {
  const say = (key: string, line: string) => {
    const scoped = `${scope} ${key}`;
    if (warned.has(scoped)) return;
    warned.add(scoped);
    console.warn(line);
  };
  for (const d of conversion.dropped) {
    say(`drop:${d.name}:${d.type}`, `[codex-mcp] dropping MCP server "${d.name}" (${d.type}): ${d.reason}`);
  }
  for (const n of conversion.narrowed) {
    say(
      `narrow:${n.name}:${n.fields.join(",")}`,
      `[codex-mcp] MCP server "${n.name}" loses ${n.fields.join(", ")} on codex — ${n.reason}`,
    );
  }
}

/** Test seam — the module-scope warn set leaks across suites in bun's one
 *  process, exactly as session-mcp's registry does. */
export function resetCodexMcpWarnings(): void {
  warned.clear();
}
