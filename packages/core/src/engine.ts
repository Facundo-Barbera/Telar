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
import { acquireAdmission, type AdmissionClass } from "./admission";

export type AgentOpts<S extends z.ZodRawShape> = {
  schema: z.ZodObject<S>;
  model?: string;
  // Reasoning effort, handed straight to the SDK — the same option
  // apps/web/app/api/chat/route.ts passes for a session turn, so a child agent
  // and a session turn mean the same thing by it. Absent lets the SDK pick.
  effort?: string;
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
  // Which admission class this call competes in (admission.ts). OPTIONAL —
  // omitted means "other": the lowest-weight class with no precedence, so an
  // untagged call can never take a freed slot ahead of verification, and
  // adopting the controller needs no sweep of every call site.
  admissionClass?: AdmissionClass;
  onEvent?: (e: EngineEvent) => void;
};

export type EngineEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input?: unknown }
  | { type: "tool-result"; name?: string; ok?: boolean; output?: string }
  | {
      type: "result";
      subtype: string;
      costUsd?: number;
      turns?: number;
      // The provider's own usage split for this agent's whole run, carried so a
      // caller can report tokens rather than only dollars. Optional because a
      // provider (or a stub in a test) may report none — absent means "not
      // reported", which a reader must not print as a confident 0.
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreateTokens?: number;
    };

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

// Concurrency is admission-controlled (admission.ts): one visible, configurable
// ceiling (TELAR_MAX_AGENTS, default 4) divided into classes with entitlement
// floors and a priority order. This REPLACES the module-private
// MAX_CONCURRENT = 4 FIFO gate that used to live here, which (a) hid the real
// ceiling from the Charter's budget.maxAgents, (b) knew nothing about who was
// asking, so a build fan-out could starve verification, and (c) could drift
// above its own ceiling — a woken waiter did `active++` without re-checking, so
// an arrival slipping in between release() and that resumption over-committed
// the pool by one. Do NOT re-add a semaphore here: a second gate is a second
// ceiling, and the two would disagree. Call sites opt into a class via
// AgentOpts.admissionClass; omitted means "other".

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
  // The class is resolved ONCE into a local before the try, and the release goes
  // through the HANDLE acquireAdmission hands back — the handle closes over the
  // class whose slot was actually taken, so the acquire/release pair cannot
  // disagree even if this local were later edited apart from the finally.
  const admissionClass = opts.admissionClass ?? "other";
  const releaseSlot = await acquireAdmission(admissionClass);
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
        ...(opts.effort ? { effort: opts.effort as never } : {}),
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
        // TOKENS RIDE ALONGSIDE COST, from the same one-shot `result` message.
        // The SDK has always sent `usage`; this event dropped it and kept only
        // the dollar figure, so nothing downstream of an `agent()` call could
        // ever state a token count — which is why an Ultra's agent rows could
        // only ever show money. The four fields are the SAME PAIR-PLUS-CACHE
        // SPLIT `UsageEntry` stores and the chat route already reads off its own
        // usage payload, so a figure derived here is comparable with one derived
        // there rather than being a fifth definition of "tokens".
        //
        // `?? 0` per field, not a guard on `usage` as a whole: a provider that
        // reports only part of the split should contribute what it reported, and
        // absent counts are genuinely zero rather than unknown.
        const u = (msg as any).usage ?? {};
        opts.onEvent?.({
          type: "result",
          subtype: msg.subtype,
          costUsd: (msg as any).total_cost_usd,
          turns: (msg as any).num_turns,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
        });
      }
    }
    return result; // null = never emitted — caller treats as failure, never infers success
  } finally {
    releaseSlot();
  }
}

export const parallel = <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> =>
  Promise.all(thunks.map((t) => t().catch(() => null)));
