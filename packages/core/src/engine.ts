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
  | { type: "tool"; name: string }
  | { type: "result"; subtype: string; costUsd?: number; turns?: number };

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
  if (account.configDir) env[p.configDirEnv] = expandHome(account.configDir);
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
        mcpServers: { out, ...opts.extraMcpServers },
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
          if (block.type === "tool_use") opts.onEvent?.({ type: "tool", name: block.name });
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
