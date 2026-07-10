// Telar engine: deterministic control flow in code, intelligence in the leaves.
// agent() = one query() forced through a typed result tool.
// parallel() = Promise.all behind a concurrency gate (subscription-friendly).
import { query, tool, createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AccountProfile } from "./schemas";
import { providerOf } from "./providers";
import { readSecret } from "./secrets";

export type AgentOpts<S extends z.ZodRawShape> = {
  schema: z.ZodObject<S>;
  model?: string;
  label?: string;
  cwd?: string;
  maxTurns?: number;
  tools?: string[]; // [] = pure-reasoning agent
  disallowedTools?: string[]; // explicit SDK disallow — wins over any allow, incl. repo settingSources
  // Hard-restrict the AVAILABLE built-in tools to `tools` via the SDK `tools`
  // option — NOT just auto-approve them. Required for a real capability wall:
  // under permissionMode:"bypassPermissions" `allowedTools` does not gate
  // availability, so without this the full claude_code preset (Write/Edit/Bash/
  // Agent/…) stays loaded. Opt-in — the builder keeps the preset; the Verifier
  // sets it so its read-only guarantee is enforced by construction, not denylist.
  restrictTools?: boolean;
  // Extra MCP servers merged alongside the built-in "out" (emit_result) server —
  // e.g. the Playwright MCP server for the Verifier. Their tools surface as
  // `mcp__<name>__*` and must be listed in `tools` to be callable.
  extraMcpServers?: Record<string, McpServerConfig>;
  account?: AccountProfile; // routes this run to a specific Claude account
  resume?: string; // session id — continue a previous run
  abort?: AbortController;
  settingSources?: Array<"user" | "project" | "local">; // repo .claude support
  onEvent?: (e: EngineEvent) => void;
};

export type EngineEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input?: unknown }
  | { type: "tool-result"; name?: string; ok?: boolean; output?: string }
  | { type: "result"; subtype: string; costUsd?: number; turns?: number };

// Cap on captured tool_result output so a single fat result (e.g. a big file
// read) can't bloat the loom event stream / SSE payloads.
const TOOL_OUTPUT_CAP = 4096;
const toolOutputText = (content: unknown): string => {
  // SDK tool_result content is either a string or an array of content blocks.
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b: any) => (typeof b?.text === "string" ? b.text : JSON.stringify(b)))
            .join("")
        : JSON.stringify(content);
  return raw.length > TOOL_OUTPUT_CAP ? raw.slice(0, TOOL_OUTPUT_CAP) + "…[truncated]" : raw;
};

// Cap a tool_use input the same way we cap tool_result output, so a huge
// Write/Edit body (block.input) can't bloat events.ndjson or the SSE stream.
// We preserve object structure — capping long string VALUES in place — so the
// transcript preview (command/file_path/etc.) still resolves; only oversized
// values are truncated. Deep/large containers fall back to a whole-JSON cap.
const capToolInput = (input: unknown): unknown => {
  const capString = (s: string) =>
    s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + "…[truncated]" : s;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return capString(v);
    if (depth <= 0 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth - 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth - 1);
    return out;
  };
  const capped = walk(input, 6);
  // Safety net: even after per-value capping, a pathologically wide/deep object
  // could still be large. If so, fall back to a truncated JSON string.
  try {
    const json = JSON.stringify(capped);
    if (json && json.length > TOOL_OUTPUT_CAP * 2) return json.slice(0, TOOL_OUTPUT_CAP * 2) + "…[truncated]";
  } catch {
    // non-serializable (cycles etc.) — hand back the structurally-capped value
  }
  return capped;
};

const MAX_CONCURRENT = 4;
let active = 0;
const waiters: (() => void)[] = [];
const acquire = async () => {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
};
const release = () => {
  active--;
  waiters.shift()?.();
};

const expandHome = (p: string): string =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

// Translates an account profile into the subprocess env for its provider.
// Provider-neutral: the descriptor decides which config-dir/token env vars to
// set (CLAUDE_CONFIG_DIR vs CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN vs OPENAI_API_KEY).
export function accountEnv(account?: AccountProfile): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (!account) return env;
  const p = providerOf(account.provider);
  if (account.configDir) {
    env[p.configDirEnv] = expandHome(account.configDir);
  } else {
    // No configDir means "the provider's BASE login" (the unset-var Keychain
    // default, per accounts.ts). We must ACTIVELY DELETE the config-dir env var
    // — not merely skip setting it — because `env` starts from process.env, so
    // an ambient value (e.g. the server itself was launched under
    // CLAUDE_CONFIG_DIR=~/.claude-work) would otherwise leak this account onto a
    // DIFFERENT login. That is the "personal silently resolves to work" bug.
    delete env[p.configDirEnv];
  }
  const mode = account.authMode ?? "subscription";
  if (mode !== "subscription") {
    const target = p.tokenEnvByMode[mode];
    // Prefer an explicitly-named env var (the hosting path — secret never on
    // disk), fall back to the Telar-managed secret store keyed by account name.
    const value = (account.tokenEnv && process.env[account.tokenEnv]) || readSecret(account.name);
    if (target && value) env[target] = value;
  }
  return env;
}

export async function agent<S extends z.ZodRawShape>(
  promptText: string,
  opts: AgentOpts<S>,
): Promise<z.infer<z.ZodObject<S>> | null> {
  await acquire();
  try {
    let result: z.infer<z.ZodObject<S>> | null = null;
    const out = createSdkMcpServer({
      name: "out",
      version: "1.0.0",
      tools: [
        tool(
          "emit_result",
          "REQUIRED final act: emit your structured result exactly once.",
          opts.schema.shape,
          async (v) => {
            result = v as z.infer<z.ZodObject<S>>;
            return { content: [{ type: "text", text: "recorded" }] };
          },
        ),
      ],
    });

    // Map tool_use id -> tool name so a later tool_result (which only carries
    // tool_use_id) can be labelled with the tool it came from.
    const toolNames = new Map<string, string>();

    for await (const msg of query({
      prompt: `${promptText}\n\nWhen finished, call emit_result exactly once with your final result.`,
      options: {
        cwd: opts.cwd ?? process.cwd(),
        model: opts.model ?? "sonnet",
        maxTurns: opts.maxTurns ?? 30,
        permissionMode: "bypassPermissions",
        env: accountEnv(opts.account),
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.abort ? { abortController: opts.abort } : {}),
        ...(opts.settingSources ? { settingSources: opts.settingSources } : {}),
        // Availability restriction (built-in tools only; MCP tools come via
        // mcpServers below). Filter out mcp__ names — they aren't built-ins.
        ...(opts.restrictTools
          ? { tools: (opts.tools ?? ["Read", "Grep", "Glob"]).filter((t) => !t.startsWith("mcp__")) }
          : {}),
        mcpServers: { out, ...opts.extraMcpServers },
        // Telar OWNS the MCP surface: only the servers we pass here (emit_result
        // + the project's telar.yaml servers) are used. Ignore the repo's own
        // .mcp.json, user settings, and plugin MCP that settingSources would
        // otherwise pull in — those are the user's local Claude config, not
        // Telar's, and leak in as confusing duplicate/unauthenticated servers.
        strictMcpConfig: true,
        allowedTools: [...(opts.tools ?? ["Read", "Grep", "Glob"]), "mcp__out__emit_result"],
        // Belt-and-suspenders against settingSources: a repo's own .claude
        // settings can widen its own allow rules, but an explicit SDK
        // disallow always wins over any allow rule.
        ...(opts.disallowedTools?.length ? { disallowedTools: opts.disallowedTools } : {}),
      },
    })) {
      if (msg.type === "system" && msg.subtype === "init") {
        opts.onEvent?.({ type: "session", sessionId: (msg as any).session_id });
      } else if (msg.type === "assistant") {
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === "text") opts.onEvent?.({ type: "text", text: block.text });
          if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            opts.onEvent?.({ type: "tool", name: block.name, input: capToolInput(block.input) });
          }
        }
      } else if (msg.type === "user") {
        // Tool outputs surface as tool_result blocks on the synthetic user
        // message that follows the assistant's tool_use. Best-effort capture.
        for (const block of (msg as any).message?.content ?? []) {
          if (block?.type === "tool_result") {
            opts.onEvent?.({
              type: "tool-result",
              name: toolNames.get(block.tool_use_id),
              ok: !block.is_error,
              output: toolOutputText(block.content),
            });
          }
        }
      } else if (msg.type === "result") {
        opts.onEvent?.({
          type: "result",
          subtype: msg.subtype,
          costUsd: (msg as any).total_cost_usd,
          turns: (msg as any).num_turns,
        });
      }
    }
    return result; // null = never emitted — caller treats as failure, never infers success
  } finally {
    release();
  }
}

export const parallel = <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> =>
  Promise.all(thunks.map((t) => t().catch(() => null)));
