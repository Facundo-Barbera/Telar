// Codex execution adapter — drives `codex app-server` (newline-delimited
// JSON-RPC 2.0 over stdio) directly, replacing the old @openai/codex-sdk
// adapter. Yields the SAME small NORMALIZED event vocabulary the old
// lib/codex-run.ts produced for the root thread (drop-in for route.ts), plus
// two new variants — "spawn" and "spawn_result" — that surface a Codex
// subagent (collabAgentToolCall) so route.ts can bucket it into its own tab,
// mirroring how the Claude branch buckets parent_tool_use_id-attributed
// subagent output. This file owns all app-server JSON-RPC wire-format
// knowledge; route.ts never touches raw protocol messages.
//
// Wire-shape reference: a MINIMAL hand-typed subset of what
// `codex app-server generate-ts --experimental -o <dir>` emits (ClientRequest
// / ServerNotification / ServerRequest unions and their referenced types) —
// not vendored wholesale, just the fields this adapter actually reads/sends.
import fs from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";

export type CodexNormalizedEvent =
  // `threadId` is present (and non-root) only for events belonging to a
  // subagent's own thread — see route.ts's resolveParent. Root-thread events
  // omit it, exactly like the old adapter, so route.ts's existing mapping is
  // untouched for the common (no-subagent) case.
  | { type: "session"; sessionId: string }
  | { type: "thinking_start"; itemId: string; threadId?: string }
  | { type: "thinking_delta"; itemId: string; text: string; threadId?: string }
  | { type: "text_delta"; itemId: string; text: string; threadId?: string }
  | { type: "text"; itemId: string; text: string; threadId?: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; threadId?: string }
  | { type: "tool_result"; id: string; output: string; isError: boolean; threadId?: string }
  | {
      type: "usage";
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    }
  | { type: "error"; message: string; threadId?: string }
  // A collabAgentToolCall spawnAgent resolved to a new child thread.
  // `parentThreadId` is the RAW senderThreadId (un-flattened — a subagent
  // that itself spawns a sub-subagent reports its own thread id here, not
  // the root's); route.ts's ParentFlattener collapses that nesting, same as
  // the Claude branch's tool_use-id flattening.
  | {
      type: "spawn";
      parentThreadId: string;
      childThreadId: string;
      prompt: string;
      model: string | null;
    }
  // The child thread's final result, read off the collabAgentToolCall's own
  // agentsStates[childThreadId].message once that state turns terminal —
  // NOT derived from the child's last agentMessage item, since a subagent
  // can end without one (error, interrupted).
  | { type: "spawn_result"; childThreadId: string; output: string; isError: boolean };

export type CodexRunOptions = {
  prompt: string;
  cwd: string;
  // A COMPLETE env for the subprocess — accountEnv(profile) already spreads
  // process.env; app-server needs PATH etc. like any other child process.
  env: Record<string, string | undefined>;
  model: string;
  reasoningEffort?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  resume?: string | null;
  signal?: AbortSignal;
};

// Resolve the system Codex binary: an explicit override, else the common
// Homebrew location, else bare "codex" (resolved off PATH by the child
// process spawn) — unchanged from the old adapter.
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

// --- Minimal JSON-RPC 2.0 plumbing over the app-server's stdio -------------

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

// A tiny pull-based async channel: push() from the readline callback,
// next() from the generator's for-await loop. Buffers whatever arrives
// before the consumer is ready to read it (readline lines can arrive faster
// than the generator drains them, e.g. a burst of item/started events).
class AsyncChannel<T> {
  private buffer: T[] = [];
  private waiting: Array<(v: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const w = this.waiting.shift();
    if (w) w({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    this.ended = true;
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

// Owns one `codex app-server` subprocess: request/response id correlation
// plus a notification channel. Any server->client REQUEST (id + method — not
// expected with approvalPolicy:"never", but the exec/patch approval methods
// exist on the wire) is auto-answered with a JSON-RPC error rather than left
// hanging, since interactive approvals are a later phase.
class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly notifications = new AsyncChannel<{ method: string; params: unknown }>();
  private closed = false;
  private closeError: Error | null = null;

  constructor(bin: string, env: Record<string, string>) {
    // Cast: Next.js's global NodeJS.ProcessEnv augmentation marks NODE_ENV as
    // a required literal, which a plain Record<string, string> (the shape
    // dropUndefined/accountEnv actually produce) doesn't structurally
    // satisfy — the subprocess only ever needs plain string env vars.
    this.child = spawn(bin, ["app-server"], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // stray non-JSON line — stdout is protocol-only per spec, but don't crash on a hiccup
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method !== undefined && msg.id !== undefined) {
        // Server->client request we don't support yet — answer so the
        // server doesn't hang waiting on it.
        this.write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not supported by telar's codex client" },
        });
        return;
      }
      if (msg.method !== undefined) {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    });
    // stderr is logs, not protocol — never parsed, just drained so the pipe
    // never backs up and blocks the child.
    this.child.stderr.resume();
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.closeError = new Error(
        `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const p of this.pending.values()) p.reject(this.closeError);
      this.pending.clear();
      this.notifications.end();
    });
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("codex app-server closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  kill(): void {
    if (!this.closed) this.child.kill();
  }
}

// --- Sandbox mapping ---------------------------------------------------

// thread/start takes the simple SandboxMode enum; turn/start's richer
// SandboxPolicy is what actually toggles network — replicate the old
// adapter's rule (network on for anything that isn't strictly read-only) by
// building it here rather than at thread/start time.
function sandboxPolicy(sandbox: CodexRunOptions["sandbox"], cwd: string): Record<string, unknown> {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

// --- Item -> normalized-event mapping (root OR child thread alike) --------

// Tool-shaped item types get a "tool" open event (once) and a "tool_result"
// event once terminal — same idiom as the old adapter's toolMeta/toolResultMeta,
// just against the app-server's ThreadItem shape instead of the SDK's.
function toolMeta(item: Record<string, any>): { name: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: item.command } };
    case "fileChange":
      return { name: "Edit", input: { changes: item.changes } };
    case "mcpToolCall":
      return { name: `${item.server}.${item.tool}`, input: (item.arguments ?? {}) as Record<string, unknown> };
    case "webSearch":
      return { name: "WebSearch", input: { query: item.query } };
    // The "plan" ThreadItem is a legacy free-text summary, not the
    // structured step list the checklist UI needs — that comes from the
    // "turn/plan/updated" notification instead (handled in the main
    // switch below).
    default:
      return null;
  }
}

function toolResultMeta(item: Record<string, any>): { output: string; isError: boolean } | null {
  switch (item.type) {
    case "commandExecution":
      return {
        output: item.aggregatedOutput ?? "",
        isError: item.status === "failed" || item.status === "declined",
      };
    case "fileChange":
      return {
        output: (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n"),
        isError: item.status === "failed" || item.status === "declined",
      };
    case "mcpToolCall":
      return {
        output: item.error ? item.error.message : JSON.stringify(item.result ?? {}),
        isError: item.status === "failed",
      };
    case "webSearch":
      return { output: "", isError: false };
    default:
      return null;
  }
}

const isTerminalCollabStatus = (s: string | undefined): boolean =>
  s === "completed" || s === "errored" || s === "interrupted" || s === "shutdown" || s === "notFound";

// Runs exactly one Codex turn against `codex app-server` and yields
// normalized events as they arrive — same generator contract as the old
// @openai/codex-sdk adapter (route.ts drives it with `for await`).
export async function* runCodexTurn(
  opts: CodexRunOptions,
): AsyncGenerator<CodexNormalizedEvent> {
  const client = new AppServerClient(resolveCodexBin(), dropUndefined(opts.env));
  const onAbort = () => client.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await client.request("initialize", {
      clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify("initialized");

    const threadStartParams = {
      cwd: opts.cwd,
      approvalPolicy: "never" as const,
      sandbox: opts.sandbox,
      model: opts.model,
    };
    const startResult = opts.resume
      ? await client.request<{ thread: { id: string } }>("thread/resume", {
          threadId: opts.resume,
          cwd: opts.cwd,
          approvalPolicy: "never",
          sandbox: opts.sandbox,
          model: opts.model,
        })
      : await client.request<{ thread: { id: string } }>("thread/start", threadStartParams);
    const rootThreadId = startResult.thread.id;
    // The thread/start RESPONSE already carries the thread id — the
    // thread/started NOTIFICATION that also fires for it (see the
    // "thread/started" case below) is a documented duplicate, not a second
    // thread, so "session" is only ever yielded here, once.
    yield { type: "session", sessionId: rootThreadId };

    const turnStartResult = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: rootThreadId,
      input: [{ type: "text", text: opts.prompt, text_elements: [] }],
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      model: opts.model,
      approvalPolicy: "never",
      sandboxPolicy: sandboxPolicy(opts.sandbox, opts.cwd),
    });
    const rootTurnId = turnStartResult.turn.id;

    // Streaming text per item id (agentMessage/reasoning items carry the
    // full text-so-far on item/started+item/completed, not deltas — the
    // dedicated delta notifications are what actually stream incrementally;
    // this just tracks "have we opened a thinking_start for this id yet"
    // and lets a completed item emit a final non-delta "text").
    const seenThinking = new Set<string>();
    const seenTool = new Set<string>();
    const doneTool = new Set<string>();
    // Children we've already emitted a "spawn" event for (dedupe repeat
    // collabAgentToolCall completions — sendInput/wait/closeAgent all touch
    // the same receiverThreadIds).
    const spawnedChildren = new Set<string>();
    const resultedChildren = new Set<string>();
    let planUpdateSeq = 0;
    let lastUsage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    } | null = null;

    const threadTag = (threadId: string): string | undefined =>
      threadId === rootThreadId ? undefined : threadId;

    function* handleItem(
      threadId: string,
      item: Record<string, any>,
      terminal: boolean,
    ): Generator<CodexNormalizedEvent> {
      const tag = threadTag(threadId);
      if (item.type === "userMessage" || item.type === "hookPrompt") return;
      if (item.type === "agentMessage") {
        if (terminal) yield { type: "text", itemId: item.id, text: item.text ?? "", ...(tag ? { threadId: tag } : {}) };
        return;
      }
      if (item.type === "reasoning") {
        if (!seenThinking.has(item.id)) {
          seenThinking.add(item.id);
          yield { type: "thinking_start", itemId: item.id, ...(tag ? { threadId: tag } : {}) };
        }
        return;
      }
      if (item.type === "collabAgentToolCall") {
        const senderThreadId: string = item.senderThreadId;
        const receiver: string | undefined = item.receiverThreadIds?.[0];
        if (item.tool === "spawnAgent" && terminal && receiver && !spawnedChildren.has(receiver)) {
          spawnedChildren.add(receiver);
          yield {
            type: "spawn",
            parentThreadId: senderThreadId,
            childThreadId: receiver,
            prompt: item.prompt ?? "",
            model: item.model ?? null,
          };
        }
        const states: Record<string, { status?: string; message?: string | null }> =
          item.agentsStates ?? {};
        for (const [childId, state] of Object.entries(states)) {
          if (!spawnedChildren.has(childId) || resultedChildren.has(childId)) continue;
          if (!isTerminalCollabStatus(state.status)) continue;
          resultedChildren.add(childId);
          yield {
            type: "spawn_result",
            childThreadId: childId,
            output: state.message ?? "",
            isError: state.status === "errored",
          };
        }
        return;
      }
      if (item.type === "subAgentActivity") return; // narration-only, not surfaced (v1)
      const meta = toolMeta(item);
      if (!meta) return;
      if (!seenTool.has(item.id)) {
        seenTool.add(item.id);
        yield { type: "tool", id: item.id, name: meta.name, input: meta.input, ...(tag ? { threadId: tag } : {}) };
      }
      if (terminal && !doneTool.has(item.id)) {
        const result = toolResultMeta(item);
        if (result) {
          doneTool.add(item.id);
          yield {
            type: "tool_result",
            id: item.id,
            output: result.output,
            isError: result.isError,
            ...(tag ? { threadId: tag } : {}),
          };
        }
      }
    }

    for (;;) {
      const { value: notif, done } = await client.notifications.next();
      if (done) throw new Error("codex app-server closed the connection mid-turn");
      const params = (notif.params ?? {}) as Record<string, any>;

      switch (notif.method) {
        case "thread/started":
          break; // duplicate of the thread/start response's own thread id — see above
        case "item/started":
          yield* handleItem(params.threadId, params.item, false);
          break;
        case "item/completed":
          yield* handleItem(params.threadId, params.item, true);
          break;
        case "item/agentMessage/delta": {
          const tag = threadTag(params.threadId);
          yield { type: "text_delta", itemId: params.itemId, text: params.delta, ...(tag ? { threadId: tag } : {}) };
          break;
        }
        case "item/reasoning/textDelta": {
          const tag = threadTag(params.threadId);
          if (!seenThinking.has(params.itemId)) {
            seenThinking.add(params.itemId);
            yield { type: "thinking_start", itemId: params.itemId, ...(tag ? { threadId: tag } : {}) };
          }
          yield { type: "thinking_delta", itemId: params.itemId, text: params.delta, ...(tag ? { threadId: tag } : {}) };
          break;
        }
        case "turn/plan/updated": {
          // A full plan-snapshot broadcast (no item id of its own) — mapped
          // to a fresh TodoWrite-shaped tool+tool_result pair each time,
          // same idiom as Claude re-calling TodoWrite: the client's
          // TodoBlock renders the input.todos snapshot directly, and each
          // update becomes its own checklist row in the transcript rather
          // than mutating one in place. `status` values here are
          // "inProgress"/"completed"/"pending" (TurnPlanStepStatus) —
          // translated to normalizeTodos' "in_progress" spelling client-side.
          const tag = threadTag(params.threadId);
          const id = `plan:${params.turnId}:${planUpdateSeq++}`;
          const todos = ((params.plan ?? []) as Array<{ step: string; status: string }>).map((s) => ({
            content: s.step,
            status: s.status === "inProgress" ? "in_progress" : s.status,
          }));
          const input = { todos };
          yield { type: "tool", id, name: "TodoWrite", input, ...(tag ? { threadId: tag } : {}) };
          yield { type: "tool_result", id, output: "", isError: false, ...(tag ? { threadId: tag } : {}) };
          break;
        }
        case "thread/tokenUsage/updated": {
          if (params.threadId !== rootThreadId) break;
          // `last` (most recent model call), not `total` (cumulative across
          // this thread's whole history) — matches the old adapter's
          // per-turn usage semantics, since route.ts's logUsage adds each
          // turn's figure rather than replacing it (a `total` here would
          // double-count on every subsequent turn of a resumed session).
          const last = params.tokenUsage?.last;
          if (last) {
            lastUsage = {
              input_tokens: last.inputTokens ?? 0,
              output_tokens: last.outputTokens ?? 0,
              cache_read_input_tokens: last.cachedInputTokens ?? 0,
              cache_creation_input_tokens: 0,
            };
          }
          break;
        }
        case "error": {
          const tag = threadTag(params.threadId);
          if (!tag && params.willRetry !== true) {
            throw new Error(params.error?.message ?? "Codex turn failed");
          }
          yield { type: "error", message: params.error?.message ?? "Codex error", ...(tag ? { threadId: tag } : {}) };
          break;
        }
        case "turn/completed": {
          if (params.threadId !== rootThreadId || params.turn?.id !== rootTurnId) break;
          if (params.turn?.status === "failed") {
            throw new Error(params.turn?.error?.message ?? "Codex turn failed");
          }
          if (lastUsage) yield { type: "usage", usage: lastUsage };
          return;
        }
        default:
          break; // every other notification (progress deltas we don't surface, account/*, etc.) is ignored
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    client.kill();
  }
}
