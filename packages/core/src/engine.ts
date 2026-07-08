// Telar engine: deterministic control flow in code, intelligence in the leaves.
// agent() = one query() forced through a typed result tool.
// parallel() = Promise.all behind a concurrency gate (subscription-friendly).
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AccountProfile } from "./schemas";

export type AgentOpts<S extends z.ZodRawShape> = {
  schema: z.ZodObject<S>;
  model?: string;
  label?: string;
  cwd?: string;
  maxTurns?: number;
  tools?: string[]; // [] = pure-reasoning agent
  account?: AccountProfile; // routes this run to a specific Claude account
  resume?: string; // session id — continue a previous run
  abort?: AbortController;
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

export function accountEnv(account?: AccountProfile): Record<string, string | undefined> {
  if (!account) return { ...process.env };
  const env: Record<string, string | undefined> = { ...process.env };
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  if (account.oauthTokenEnv) env.CLAUDE_CODE_OAUTH_TOKEN = process.env[account.oauthTokenEnv];
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
        mcpServers: { out },
        allowedTools: [...(opts.tools ?? ["Read", "Grep", "Glob"]), "mcp__out__emit_result"],
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
