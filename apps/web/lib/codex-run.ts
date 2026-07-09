// Codex execution adapter — runs one turn through @openai/codex-sdk and
// yields a small NORMALIZED event vocabulary that api/chat/route.ts maps
// onto the exact same send() SSE events the Claude Agent SDK path emits, so
// the client renders a Codex turn identically to a Claude one. This file
// owns all Codex-SDK-shape knowledge; route.ts never imports from
// "@openai/codex-sdk" directly.
import fs from "fs";
import {
  Codex,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadItem,
} from "@openai/codex-sdk";

export type CodexNormalizedEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking_start"; itemId: string }
  | { type: "thinking_delta"; itemId: string; text: string }
  | { type: "text_delta"; itemId: string; text: string }
  | { type: "text"; itemId: string; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | {
      type: "usage";
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    }
  | { type: "error"; message: string };

export type CodexRunOptions = {
  prompt: string;
  cwd: string;
  // A COMPLETE env for the subprocess — accountEnv(profile) already spreads
  // process.env, since the SDK does NOT inherit it once `env` is provided.
  env: Record<string, string | undefined>;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
  sandbox: SandboxMode;
  resume?: string | null;
  signal?: AbortSignal;
};

// Resolve the system Codex binary: an explicit override, else the common
// Homebrew location, else bare "codex" (resolved off PATH by the SDK/child
// process spawn).
const resolveCodexBin = (): string => {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (fs.existsSync("/opt/homebrew/bin/codex")) return "/opt/homebrew/bin/codex";
  return "codex";
};

const dropUndefined = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
};

// Tool-shaped item types get a "tool" open event (once) and a "tool_result"
// event once they reach a terminal state — the closest analog to Claude's
// tool_use / tool_result pair. agent_message/reasoning/error are handled
// separately (streaming text / thinking / fatal-ish notices).
const toolMeta = (item: ThreadItem): { name: string; input: Record<string, unknown> } | null => {
  switch (item.type) {
    case "command_execution":
      return { name: "Bash", input: { command: item.command } };
    case "file_change":
      return { name: "Edit", input: { changes: item.changes } };
    case "mcp_tool_call":
      return {
        name: `${item.server}.${item.tool}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
      };
    case "web_search":
      return { name: "WebSearch", input: { query: item.query } };
    case "todo_list":
      return { name: "TodoWrite", input: { items: item.items } };
    default:
      return null;
  }
};

const toolResultMeta = (item: ThreadItem): { output: string; isError: boolean } | null => {
  switch (item.type) {
    case "command_execution":
      return { output: item.aggregated_output, isError: item.status === "failed" };
    case "file_change":
      return {
        output: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"),
        isError: item.status === "failed",
      };
    case "mcp_tool_call":
      return {
        output: item.error ? item.error.message : JSON.stringify(item.result ?? {}),
        isError: item.status === "failed",
      };
    case "web_search":
      // WebSearchItem carries no status/result — its mere appearance means
      // the round-trip already completed.
      return { output: "", isError: false };
    case "todo_list":
      return {
        output: item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n"),
        isError: false,
      };
    default:
      return null;
  }
};

// Runs exactly one Codex turn and yields normalized events as they arrive.
// A generator (not a callback) so the caller (route.ts) can drive it with
// the same `for await` shape it already uses for the Claude SDK's query().
export async function* runCodexTurn(
  opts: CodexRunOptions,
): AsyncGenerator<CodexNormalizedEvent> {
  const codex = new Codex({
    codexPathOverride: resolveCodexBin(),
    env: dropUndefined(opts.env),
  });
  const threadOptions = {
    sandboxMode: opts.sandbox,
    model: opts.model,
    ...(opts.reasoningEffort ? { modelReasoningEffort: opts.reasoningEffort } : {}),
    workingDirectory: opts.cwd,
    approvalPolicy: "never" as const,
    skipGitRepoCheck: true,
    // workspace-write disables network by default, which silently breaks the
    // common cases (gh, npm/bun installs, git fetch). Tie network access to
    // whether the preset allows writes at all: "read-only" stays offline;
    // "workspace-write"/"danger-full-access" get the network. File writes are
    // still fenced by sandboxMode regardless.
    networkAccessEnabled: opts.sandbox !== "read-only",
  };
  const thread = opts.resume
    ? codex.resumeThread(opts.resume, threadOptions)
    : codex.startThread(threadOptions);
  const { events } = await thread.runStreamed(
    opts.prompt,
    opts.signal ? { signal: opts.signal } : undefined,
  );

  // Running text per streaming item (agent_message + reasoning), so repeat
  // item.started/item.updated/item.completed deliveries of the SAME
  // (growing) text can be turned into incremental deltas — the SDK sends
  // the item's full text-so-far at each event, not a delta itself.
  const lastText = new Map<string, string>();
  const seenTool = new Set<string>();
  const doneTool = new Set<string>();
  const seenError = new Set<string>();

  const diffText = (id: string, full: string): string => {
    const prev = lastText.get(id) ?? "";
    lastText.set(id, full);
    return full.startsWith(prev) ? full.slice(prev.length) : full;
  };

  function* handleItem(item: ThreadItem, terminal: boolean): Generator<CodexNormalizedEvent> {
    if (item.type === "agent_message") {
      const delta = diffText(item.id, item.text);
      if (delta) yield { type: "text_delta", itemId: item.id, text: delta };
      if (terminal) yield { type: "text", itemId: item.id, text: item.text };
      return;
    }
    if (item.type === "reasoning") {
      if (!lastText.has(item.id)) yield { type: "thinking_start", itemId: item.id };
      const delta = diffText(item.id, item.text);
      if (delta) yield { type: "thinking_delta", itemId: item.id, text: delta };
      return;
    }
    if (item.type === "error") {
      if (!seenError.has(item.id)) {
        seenError.add(item.id);
        yield { type: "error", message: item.message };
      }
      return;
    }
    const meta = toolMeta(item);
    if (!meta) return;
    if (!seenTool.has(item.id)) {
      seenTool.add(item.id);
      yield { type: "tool", id: item.id, name: meta.name, input: meta.input };
    }
    if (terminal && !doneTool.has(item.id)) {
      const result = toolResultMeta(item);
      if (result) {
        doneTool.add(item.id);
        yield { type: "tool_result", id: item.id, output: result.output, isError: result.isError };
      }
    }
  }

  for await (const ev of events) {
    if (ev.type === "thread.started") {
      yield { type: "session", sessionId: ev.thread_id };
    } else if (ev.type === "item.started" || ev.type === "item.updated") {
      yield* handleItem(ev.item, false);
    } else if (ev.type === "item.completed") {
      yield* handleItem(ev.item, true);
    } else if (ev.type === "turn.completed") {
      yield {
        type: "usage",
        usage: {
          input_tokens: ev.usage.input_tokens,
          output_tokens: ev.usage.output_tokens,
          cache_read_input_tokens: ev.usage.cached_input_tokens,
          cache_creation_input_tokens: 0,
        },
      };
    } else if (ev.type === "turn.failed") {
      // No graceful per-turn "failed" send() vocabulary on the Claude side
      // beyond the generic catch-all — throwing here lets route.ts's
      // existing try/catch (send("error", ...)) handle both providers
      // identically.
      throw new Error(ev.error.message);
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
    // "turn.started" carries no information route.ts needs — session id
    // already arrives via "thread.started".
  }
}
