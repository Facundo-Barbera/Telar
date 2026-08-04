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
import type { HarnessToolNamespace } from "@telar/core";
import { findTool, toContentItems, toDynamicTools } from "@/lib/harness-tools";

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
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
        reasoning_output_tokens: number;
        model_context_window: number | null;
      };
    }
  | { type: "error"; message: string; threadId?: string }
  // Raw fields off a `account/rateLimits/updated` notification's
  // RateLimitSnapshot — consumers decide whether to display provider limits
  // shaping (mirroring the Claude branch's own "rate_limit_event" handling),
  // this adapter just relays what the wire sent.
  | {
      type: "rate_limits";
      primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
      secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
      planType: string | null;
    }
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

/**
 * One composer attachment, as `runCodexTurn` needs it. Structurally the
 * provider-neutral `TurnAttachment` from lib/attachment-contract minus the
 * fields this file has no use for — kept as its own type so the adapter stays
 * importable without dragging a web-app module into it.
 */
export type CodexAttachment = { name: string; mediaType: string; path: string };

export type CodexRunOptions = {
  prompt: string;
  /**
   * Composer attachments for this turn, sent as their OWN input items rather
   * than as text: the app-server's `UserInput` union has first-class
   * `localImage` (`{type, path}`) and `mention` (`{type, name, path}`) members,
   * so an image arrives as an image the model can actually look at, and a
   * non-image arrives as the same kind of file reference the TUI's `@` produces.
   * Text-splicing a path would get neither.
   */
  attachments?: readonly CodexAttachment[];
  /**
   * `@path` file mentions from the message text, as repo-relative paths already
   * validated against the project root by the caller. Sent as the app-server's
   * `mention` input items — the same thing the Codex TUI produces — so the file
   * is a reference the harness understands rather than a string in the prose.
   */
  mentions?: readonly { name: string; path: string }[];
  cwd: string;
  // A COMPLETE env for the subprocess — accountEnv(profile) already spreads
  // process.env; app-server needs PATH etc. like any other child process.
  env: Record<string, string | undefined>;
  model: string;
  reasoningEffort?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  resume?: string | null;
  signal?: AbortSignal;
  // Mirrors the app-server's AskForApproval union. "never" keeps the old
  // behavior (sandbox alone governs, no prompts); "untrusted"/"on-request"
  // let the server send back the item/*/requestApproval (or legacy
  // execCommandApproval/applyPatchApproval) REQUESTS handled below.
  approvalPolicy: "untrusted" | "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  serviceTier?: string;
  // Called for every server->client approval REQUEST when approvalPolicy
  // isn't "never" — route.ts wires this to the same canUseTool/pending-
  // approval machinery the Claude branch uses. Absent (or approvalPolicy
  // "never", where the server shouldn't send these at all) falls back to the
  // old -32601 auto-answer.
  onApproval?: (req: {
    command?: string;
    cwd?: string;
    reason?: string;
    kind: "command" | "file";
  }) => Promise<"accept" | "decline">;
  // TELAR'S OWN TOOLS, reaching Codex as `dynamicTools` on thread/start.
  //
  // This is the capability gap that made a Codex session unable to run an
  // Ultra: the Claude branch registers ultra/loom/workspace as in-process MCP
  // servers, `runCodexTurn` took no equivalent, and so the model was asked for
  // a tool that was not in its toolset and narrated using it instead.
  //
  // Dynamic tools are the app-server's answer to exactly this: the client
  // DECLARES {name, description, inputSchema} up front, and the server sends a
  // `dynamicToolCall` REQUEST back over this same stdio channel when the model
  // calls one. Same in-process handlers as the Claude path — see
  // harness-tools.ts for why this beats standing up an HTTP MCP server.
  tools?: readonly HarnessToolNamespace[];
  // Dynamic tools execute in Telar's process, outside Codex's native
  // command/file approval requests. The route uses this hook to apply the
  // same browser permission policy before a shared tab is mutated.
  onDynamicTool?: (request: {
    namespace: string | null;
    tool: string;
    arguments: Record<string, unknown>;
  }) => Promise<"accept" | "decline">;
  // Appended to the system prompt. Codex's spelling of Claude's
  // `systemPrompt.append`, and the second capability gap closed here: the
  // appendix used to be built by route.ts and then silently dropped, which is
  // what made planner/steerer profiles a non-session on this provider.
  instructions?: string;
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

// The two legacy (pre-item/*) approval method names — still on the wire per
// `codex app-server generate-ts --experimental`'s ServerRequest union.
// Answered with {decision: ReviewDecision} ("approved"/"denied"), unlike the
// item/* pair's {decision: "accept"/"decline"}.
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);

// Server->client approval REQUEST methods this client can answer via
// onApproval — the current item/* pair plus LEGACY_APPROVAL_METHODS.
// Anything else falls through to the -32601 auto-answer below.
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  ...LEGACY_APPROVAL_METHODS,
]);

// Server->client request methods that mean "run one of the tools you declared".
// Both spellings are listed because the app-server's own naming moved and a
// pinned adapter that recognises only one of them silently loses every tool
// call on the other side of that bump — which reads exactly like the model
// choosing not to use its tools.
const DYNAMIC_TOOL_METHODS = new Set([
  // Current v2 protocol (Codex 0.145 generated ServerRequest union).
  "item/tool/call",
  // Older app-server spellings retained so system Codex upgrades can move in
  // either direction without silently dropping Telar's tool callbacks.
  "dynamicToolCall",
  "thread/dynamicToolCall",
]);

// Owns one `codex app-server` subprocess: request/response id correlation
// plus a notification channel. Any server->client REQUEST (id + method) for
// an approval method is routed to `onApproval` (when set) and answered async
// — handling it must never block the line-by-line notification loop, since a
// human can take arbitrarily long to answer. Every other server->client
// request (unsupported/unknown methods) is auto-answered with a JSON-RPC
// error rather than left hanging.
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
  // Set right after construction (synchronously, before any stdout line can
  // possibly be processed — see runCodexTurn) rather than threaded through
  // the constructor, so it can be omitted entirely for approvalPolicy:"never".
  onApproval?: CodexRunOptions["onApproval"];
  onDynamicTool?: CodexRunOptions["onDynamicTool"];
  // Set before the first turn, same discipline as onApproval: assigned
  // synchronously before any await, so no stdout line can be processed (hence
  // no dynamicToolCall answered) against an empty tool set.
  tools: readonly HarnessToolNamespace[] = [];

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
        // A TOOL CALL COMING BACK AT US. Same fire-and-forget discipline as an
        // approval: awaiting the handler inside the readline callback would
        // stall every subsequent stdout line — including this turn's own text
        // notifications — until an ultra script finished compiling.
        if (DYNAMIC_TOOL_METHODS.has(msg.method)) {
          const id = msg.id;
          this.answerDynamicTool(id, msg.params).catch((e) => {
            // A handler that threw is a FAILED TOOL, not a dead turn: answer
            // with success:false so the model can read the error and carry on.
            this.write({
              jsonrpc: "2.0",
              id,
              result: {
                contentItems: [
                  { type: "inputText", text: e instanceof Error ? e.message : String(e) },
                ],
                success: false,
              },
            });
          });
          return;
        }
        if (this.onApproval && APPROVAL_METHODS.has(msg.method)) {
          // Fire-and-forget from the readline callback's point of view —
          // awaiting onApproval here would stall every subsequent stdout
          // line (including this same turn's own item/text notifications)
          // until the human answers. The promise chain below is what
          // actually blocks, and it blocks nothing but itself.
          this.answerApproval(msg.method, msg.id, msg.params).catch(() => {
            // onApproval rejected (should not happen — route.ts's callback
            // never throws) — fall back to a decline-shaped answer so the
            // server never hangs.
            this.write({
              jsonrpc: "2.0",
              id: msg.id,
              result: LEGACY_APPROVAL_METHODS.has(msg.method!) ? { decision: "denied" } : { decision: "decline" },
            });
          });
          return;
        }
        // Server->client request we don't support (or no onApproval wired
        // up, e.g. approvalPolicy:"never") — answer so the server doesn't
        // hang waiting on it.
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

  // Shapes one server->client approval REQUEST's params down to onApproval's
  // small {command?, cwd?, reason?, kind} contract, awaits the human's
  // decision, and writes back the method-appropriate result shape —
  // {decision:"accept"|"decline"} for the item/* pair, {decision:"approved"|
  // "denied"} (ReviewDecision) for the legacy pair. Never throws: any error
  // from onApproval itself propagates to the caller's .catch (see above),
  // which answers decline/denied so the server doesn't hang either way.
  private async answerApproval(method: string, id: string | number, params: unknown): Promise<void> {
    const p = (params ?? {}) as Record<string, any>;
    const isFile = method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
    const req: { command?: string; cwd?: string; reason?: string; kind: "command" | "file" } = {
      kind: isFile ? "file" : "command",
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
    };
    if (!isFile) {
      // item/commandExecution/requestApproval's `command` is already a
      // single string; the legacy execCommandApproval's is an argv array —
      // join so onApproval always sees one shell-ish string either way.
      if (typeof p.command === "string") req.command = p.command;
      else if (Array.isArray(p.command)) req.command = p.command.join(" ");
      if (typeof p.cwd === "string") req.cwd = p.cwd;
    }
    const decision = await this.onApproval!(req);
    const result = LEGACY_APPROVAL_METHODS.has(method)
      ? { decision: decision === "accept" ? "approved" : "denied" }
      : { decision };
    this.write({ jsonrpc: "2.0", id, result });
  }

  // Runs one dynamic tool and writes its DynamicToolCallResponse back.
  //
  // AN UNKNOWN TOOL IS ANSWERED, NOT THROWN. A model naming a tool that does
  // not exist is an ordinary thing to reply to — the alternative (letting it
  // reject into the catch above) is the same answer with a worse message.
  private async answerDynamicTool(id: string | number, params: unknown): Promise<void> {
    // `unknown` rather than this file's usual wire-shaped `any`: every field
    // read below is type-guarded anyway, so the looser type buys nothing.
    const p = (params ?? {}) as Record<string, unknown>;
    const namespace: string | null = typeof p.namespace === "string" ? p.namespace : null;
    const name: string = typeof p.tool === "string" ? p.tool : "";
    const descriptor = findTool(this.tools, namespace, name);
    if (!descriptor) {
      this.write({
        jsonrpc: "2.0",
        id,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: `No such tool: ${namespace ? `${namespace}/` : ""}${name || "(unnamed)"}.`,
            },
          ],
          success: false,
        },
      });
      return;
    }
    const args = (p.arguments ?? {}) as Record<string, unknown>;
    if (this.onDynamicTool) {
      const decision = await this.onDynamicTool({ namespace, tool: name, arguments: args });
      if (decision !== "accept") {
        this.write({
          jsonrpc: "2.0",
          id,
          result: {
            contentItems: [{ type: "inputText", text: "The browser action was not approved." }],
            success: false,
          },
        });
        return;
      }
    }
    // The handler is the SAME function the Claude path calls through MCP.
    const result = await (descriptor.handler as (a: unknown) => Promise<
      { content: Array<{ type: string; [k: string]: unknown }>; isError?: boolean }
    >)(args);
    this.write({
      jsonrpc: "2.0",
      id,
      result: { contentItems: toContentItems(result), success: !result.isError },
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
    case "dynamicToolCall":
      return {
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        input: (item.arguments ?? {}) as Record<string, unknown>,
      };
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
    case "dynamicToolCall": {
      const output = (item.contentItems ?? []).map((content: Record<string, unknown>) => {
        if (content.type === "inputText") return String(content.text ?? "");
        if (content.type === "inputImage") return "[Browser screenshot captured]";
        if (content.type === "inputAudio") return "[Audio captured]";
        return "[Tool content omitted]";
      }).filter(Boolean).join("\n");
      return {
        output,
        isError: item.status === "failed" || item.success === false,
      };
    }
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
/**
 * Build `turn/start`'s `input` array: the user's text, then one item per
 * attachment. Shape is pinned by the app-server's own generated bindings
 * (`codex app-server generate-ts` → v2/UserInput.ts):
 *
 *   {type:"text", text, text_elements} | {type:"localImage", path, detail?}
 *   | {type:"mention", name, path} | …
 *
 * Images become `localImage` so the model SEES them; everything else becomes a
 * `mention`, which is exactly what the TUI's `@` produces and lets the model
 * open the file on its own terms. The text item stays FIRST and unchanged, so a
 * turn with no attachments produces byte-identical input to before.
 */
export function turnInput(
  prompt: string,
  attachments: readonly CodexAttachment[] = [],
  mentions: readonly { name: string; path: string }[] = [],
): Array<Record<string, unknown>> {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...attachments.map((a) =>
      a.mediaType.startsWith("image/")
        ? { type: "localImage", path: a.path }
        : { type: "mention", name: a.name, path: a.path },
    ),
    ...mentions.map((m) => ({ type: "mention", name: m.name, path: m.path })),
  ];
}

export async function* runCodexTurn(
  opts: CodexRunOptions,
): AsyncGenerator<CodexNormalizedEvent> {
  const client = new AppServerClient(resolveCodexBin(), dropUndefined(opts.env));
  // Set synchronously, before any await — no stdout line can be processed
  // (hence no approval REQUEST answered) until the event loop turns, which
  // can't happen before this assignment runs.
  client.onApproval = opts.onApproval;
  client.onDynamicTool = opts.onDynamicTool;
  client.tools = opts.tools ?? [];
  const onAbort = () => client.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await client.request("initialize", {
      clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify("initialized");

    // Declared ONCE, on the thread — not per turn. Both fields are omitted
    // entirely when empty rather than sent as `[]`/`""`: the app-server treats
    // an explicit empty dynamicTools as "this client has no tools", which is a
    // different statement from not mentioning tools at all, and the difference
    // shows up as a resumed thread losing the tools it started with.
    const harnessParams = {
      ...(opts.tools?.length ? { dynamicTools: toDynamicTools(opts.tools) } : {}),
      ...(opts.instructions?.trim() ? { developerInstructions: opts.instructions } : {}),
    };
    const threadStartParams = {
      cwd: opts.cwd,
      approvalPolicy: opts.approvalPolicy,
      approvalsReviewer: opts.approvalsReviewer,
      sandbox: opts.sandbox,
      model: opts.model,
      ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
      ...harnessParams,
    };
    const startResult = opts.resume
      ? await client.request<{ thread: { id: string } }>("thread/resume", {
          threadId: opts.resume,
          cwd: opts.cwd,
          approvalPolicy: opts.approvalPolicy,
          approvalsReviewer: opts.approvalsReviewer,
          sandbox: opts.sandbox,
          model: opts.model,
          ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
          // A RESUMED thread re-declares them too. The tool set lives in this
          // process, not in the harness's persisted thread state, so a resume
          // that stayed silent would hand the model a thread whose tools no
          // longer exist on the other end of the socket.
          ...harnessParams,
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
      input: turnInput(opts.prompt, opts.attachments, opts.mentions),
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      model: opts.model,
      approvalPolicy: opts.approvalPolicy,
      approvalsReviewer: opts.approvalsReviewer,
      sandboxPolicy: sandboxPolicy(opts.sandbox, opts.cwd),
      ...(opts.serviceTier ? { serviceTier: opts.serviceTier } : {}),
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
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      reasoning_output_tokens: number;
      model_context_window: number | null;
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
              total_tokens: last.totalTokens ?? 0,
              input_tokens: last.inputTokens ?? 0,
              output_tokens: last.outputTokens ?? 0,
              cache_read_input_tokens: last.cachedInputTokens ?? 0,
              cache_creation_input_tokens: last.cacheWriteInputTokens ?? 0,
              reasoning_output_tokens: last.reasoningOutputTokens ?? 0,
              model_context_window: params.tokenUsage?.modelContextWindow ?? null,
            };
          }
          break;
        }
        case "account/rateLimits/updated": {
          // Notification shape is { rateLimits: RateLimitSnapshot } — see
          // AccountRateLimitsUpdatedNotification (confirmed via `codex
          // app-server generate-ts --experimental`). Not gated on rootThreadId
          // (this is account-scoped, not thread-scoped) and yielded even for
          // a subagent-adjacent turn — route.ts saves the latest snapshot
          // regardless of which thread's activity triggered it.
          const snap = params.rateLimits ?? {};
          yield {
            type: "rate_limits",
            primary: snap.primary ?? null,
            secondary: snap.secondary ?? null,
            planType: snap.planType ?? null,
          };
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
          break; // every other notification (progress deltas we don't surface, account/updated, etc.) is ignored
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    client.kill();
  }
}
