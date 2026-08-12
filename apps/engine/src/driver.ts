/**
 * Provider code is deliberately a leaf of vNext. It receives an AbortSignal and
 * can only REPORT what it saw; it cannot mutate project or session state. The
 * worker relays those observations to the engine, which owns the durable
 * journal and the terminal transition.
 *
 * WHAT CHANGED IN v2, and it is the whole point of the protocol bump: this file
 * used to read `text_delta` and assistant text blocks and DROP `tool_use`,
 * `tool_result` and `thinking` on the floor. A session therefore rendered as a
 * wall of prose with no tool timeline, no reasoning, and nothing to approve.
 * Every surface the frozen cockpit has and `apps/vnext-web` does not was
 * downstream of that one omission.
 */
import crypto from "node:crypto";
import type {
  ItemDetail,
  ItemSeed,
  RequestDecision,
  RequestDetail,
  RequestKind,
  TurnObservation,
  UsageSnapshot,
} from "@telar/engine-client";

/** What the provider wants to do, in the contract's vocabulary. */
export type DriverRequest = {
  kind: RequestKind;
  detail: RequestDetail;
  /** The provider's own tool-use id, so the row and the request correlate. */
  toolUseId: string;
};

/**
 * The engine's browser, handed to the driver as a capability.
 *
 * PASSED IN RATHER THAN IMPORTED, so a driver constructed without one simply
 * has no browser tools instead of dragging Chromium into every unit test. It is
 * also what makes the headless/attached swap invisible to the model: the driver
 * only ever sees `call`.
 */
export type BrowserCapability = {
  call(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  isReadOnly(name: string, args?: Record<string, unknown>): boolean;
  tools: readonly { name: string; description: string; input: unknown }[];
};

export type DriverRun = {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /**
   * Scopes this turn's browser. Sessions are the natural boundary: two
   * sessions must not share a tab, and a session's tabs must survive between
   * its turns.
   */
  browserScopeKey?: string;
  /** Engine-owned provider continuity from the preceding completed turn. */
  providerSessionId?: string;
  /** Batched back to the engine. Never called after the run settles. */
  onObservations(observations: TurnObservation[]): Promise<void>;
  /**
   * Ask whether a tool call may proceed. Resolves with the engine's answer,
   * which may take an arbitrarily long time — a parked approval waits for a
   * human. ABSENT means the driver runs with no gate at all, which is the
   * `full-access` shape and is what the tests use.
   */
  onRequest?(request: DriverRequest): Promise<RequestDecision>;
};

export type DriverResult = {
  text: string;
  providerSessionId?: string;
  usage?: UsageSnapshot;
};

export type TurnDriver = {
  run(input: DriverRun): Promise<DriverResult>;
};

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** The SDK's permission callback, narrowed to what this driver uses. */
type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; title?: string },
) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean }>;

type SdkMcpServer = unknown;

type ClaudeSdk = {
  query(input: {
    prompt: string;
    options: {
      cwd: string;
      permissionMode: "default";
      abortController: AbortController;
      includePartialMessages: true;
      resume?: string;
      canUseTool?: SdkCanUseTool;
      mcpServers?: Record<string, SdkMcpServer>;
    };
  }): AsyncIterable<unknown>;
  /** OPTIONAL because the fake SDKs the tests inject only implement `query`.
   *  A driver whose SDK lacks these simply gets no browser tools. */
  createSdkMcpServer?(input: { name: string; version: string; tools: unknown[] }): SdkMcpServer;
  tool?(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ): unknown;
};

/**
 * Wrap the engine's browser as an in-process MCP server the SDK can call.
 *
 * `gate` RETURNS FALSE FOR A DECLINE and the tool answers with `isError`
 * rather than throwing. A thrown handler reads to the model as a broken tool
 * and it retries; an error result reads as "you may not do that" and it adapts.
 * That distinction is the whole reason a decline carries a reason.
 */
async function buildBrowserMcpServer(
  sdk: ClaudeSdk,
  browser: BrowserCapability,
  scopeKey: string,
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean>,
): Promise<SdkMcpServer | undefined> {
  const { createSdkMcpServer, tool } = sdk;
  if (!createSdkMcpServer || !tool) return undefined;
  const tools = browser.tools.map((definition) =>
    tool(
      definition.name,
      definition.description,
      // The SDK wants a raw shape, not a wrapped object schema.
      ((definition.input as { shape?: Record<string, unknown> }).shape ?? {}) as Record<string, unknown>,
      async (args) => {
        if (!(await gate(definition.name, args))) {
          return { content: [{ type: "text", text: "The human declined this browser action." }], isError: true };
        }
        return browser.call(scopeKey, definition.name, args);
      },
    ),
  );
  return createSdkMcpServer({ name: "browser", version: "2.0.0", tools });
}

/**
 * Which REQUEST kind a tool call belongs to.
 *
 * COARSER THAN THE ITEM MAPPING ON PURPOSE. An item type answers "what should
 * this row look like"; a request kind answers "what is the human being asked to
 * permit", and permission is about capability rather than vocabulary — "may you
 * run shell commands here" is one decision whether the tool is `Bash` or
 * `exec_command`. `requests.ts` says the same thing from the other side.
 */
export function requestKindForTool(name: string): RequestKind {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command_execution";
  if (name === "Read" || name === "NotebookRead" || name === "Glob" || name === "Grep") return "file_read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "file_change";
  return "tool_call";
}

/** The request payload for a tool call, reusing the item mapping's detail. */
export function requestDetailForToolCall(name: string, input: unknown): RequestDetail {
  const detail = itemDetailForToolCall(name, input);
  switch (detail.type) {
    case "command_execution":
      return { kind: "command_execution", command: detail.command };
    case "file_change":
      return { kind: "file_change", change: detail.change };
    case "file_read":
      return { kind: "file_read", read: detail.read };
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return { kind: "tool_call", call: detail.call };
    default:
      return { kind: "tool_call", call: { name, input: input === undefined ? undefined : input } };
  }
}

const itemId = (): string => `item_${crypto.randomUUID().replaceAll("-", "")}`;

/** Trim a value for a collapsed row label without splitting a surrogate pair. */
function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${[...flat].slice(0, max).join("")}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map one provider tool call onto a canonical item.
 *
 * THE MAPPING IS BY CAPABILITY, NOT BY NAME, which is the property that lets a
 * Claude `Bash` and a Codex `exec_command` land on the SAME row type so the UI
 * needs one renderer rather than one per provider. An unrecognised tool becomes
 * `dynamic_tool_call` rather than being dropped — a new provider tool should
 * show up unstyled, never invisible.
 */
export function itemDetailForToolCall(name: string, input: unknown): ItemDetail {
  const args = asRecord(input);
  const toolInput = input === undefined ? undefined : input;

  if (name === "Bash" || name === "BashOutput") {
    return {
      type: "command_execution",
      command: {
        command: str(args.command) ?? "",
        ...(str(args.cwd) ? { cwd: str(args.cwd)! } : {}),
      },
    };
  }
  if (name === "Read" || name === "NotebookRead") {
    return {
      type: "file_read",
      read: {
        path: str(args.file_path) ?? str(args.path) ?? "(unknown)",
        ...(typeof args.offset === "number" ? { fromLine: Math.max(1, args.offset) } : {}),
      },
    };
  }
  if (name === "Write" || name === "Edit" || name === "NotebookEdit" || name === "MultiEdit") {
    return {
      type: "file_change",
      change: {
        path: str(args.file_path) ?? str(args.path) ?? "(unknown)",
        kind: name === "Write" ? "create" : "edit",
      },
    };
  }
  if (name === "WebSearch") {
    return { type: "web_search", query: str(args.query) ?? "" };
  }
  if (name === "WebFetch") {
    return { type: "dynamic_tool_call", call: { name, input: toolInput } };
  }
  if (name.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return {
      type: "mcp_tool_call",
      call: { name, ...(server ? { server } : {}), input: toolInput },
    };
  }
  return { type: "dynamic_tool_call", call: { name, input: toolInput } };
}

/** The collapsed label for a tool row. Derived once, here, and stored. */
export function titleForToolCall(name: string, detail: ItemDetail): string {
  switch (detail.type) {
    case "command_execution":
      return oneLine(detail.command.command) || name;
    case "file_read":
      return detail.read.path;
    case "file_change":
      return detail.change.path;
    case "web_search":
      return oneLine(detail.query) || name;
    default:
      return name;
  }
}

/** Claude reports cumulative usage per assistant message; the result message
 *  carries the authoritative total plus the price. */
function usageFrom(value: unknown, costUsd: unknown): UsageSnapshot | undefined {
  const usage = asRecord(value);
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const n = (candidate: unknown): number => (typeof candidate === "number" && candidate >= 0 ? candidate : 0);
  return {
    tokens: {
      input: n(input),
      output: n(output),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheCreate: n(usage.cache_creation_input_tokens),
    },
    ...(typeof costUsd === "number" && costUsd >= 0 ? { costUsd } : {}),
  };
}

/**
 * Thin, injectable bridge to the locally installed Agent SDK. It does not
 * import Telar's legacy route/core execution layer and leaves approvals at the
 * SDK's normal default — `canUseTool` and hooks arrive in stage 2, and until
 * they do this driver cannot open a request. A missing SDK or login is surfaced
 * as a failure, never a fabricated answer.
 */
export function createClaudeDriver(
  loadSdk: () => Promise<ClaudeSdk> = () => import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeSdk>,
  options: { browser?: BrowserCapability } = {},
): TurnDriver {
  return {
    async run({ prompt, cwd, signal, onObservations, onRequest, providerSessionId, browserScopeKey }) {
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        throw new ProviderUnavailableError(
          "Claude Agent SDK is unavailable; install and configure Claude Code before retrying",
        );
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });

      let finalText = "";
      let receivedPartialText = false;
      let reportedSessionId: string | undefined;
      let usage: UsageSnapshot | undefined;
      let completed = false;

      /**
       * Streaming blocks keyed by the provider's content-block index.
       *
       * `text` ACCUMULATES, and that is not redundant with the deltas already
       * sent. Deltas are appends the engine journals but deliberately does NOT
       * fold into `items.json` — rewriting the whole projection per token would
       * be absurd — so the closing `item.completed` is the ONLY chance to give
       * the stored item its final text. Without it a live client looked right
       * (it folds deltas itself) while a client OPENING the session later got
       * empty reasoning and empty assistant messages from the snapshot. Found
       * by running it, not by a test; the test now exists.
       */
      const openBlocks = new Map<number, { id: string; kind: "text" | "thinking"; text: string }>();

      const closeBlock = (block: { id: string; kind: "text" | "thinking"; text: string }): TurnObservation => ({
        kind: "item.completed",
        itemId: block.id,
        status: "completed",
        detail: block.kind === "text" ? { type: "assistant_message", text: block.text } : { type: "reasoning", text: block.text },
      });
      /** Tool rows keyed by `tool_use_id`, so a later `tool_result` closes the
       *  row its call opened rather than opening a second one. */
      const openTools = new Map<string, { id: string; detail: ItemDetail }>();

      const pending: TurnObservation[] = [];
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
        await onObservations(batch);
      };
      const emit = (observation: TurnObservation): void => {
        pending.push(observation);
      };

      /**
       * The permission gate.
       *
       * IT MUST ALWAYS ANSWER. The SDK's own docs are blunt about the failure
       * mode: a permission prompt has no park deadline, so a callback that
       * throws or never settles blocks the tool indefinitely with nothing to
       * report it. Any failure here therefore becomes an explicit `deny`
       * carrying the reason, which is recoverable, rather than a hang.
       */
      const canUseTool: SdkCanUseTool | undefined = onRequest
        ? async (toolName, input, options) => {
            try {
              const decision = await onRequest({
                kind: requestKindForTool(toolName),
                detail: requestDetailForToolCall(toolName, input),
                toolUseId: options.toolUseID,
              });
              if (decision === "accept" || decision === "acceptForSession") return { behavior: "allow" };
              // `cancel` withdraws the whole turn rather than just this call.
              return {
                behavior: "deny",
                message: decision === "cancel" ? "The human cancelled this turn." : "The human declined this tool call.",
                ...(decision === "cancel" ? { interrupt: true } : {}),
              };
            } catch (error) {
              return { behavior: "deny", message: error instanceof Error ? error.message : "permission request failed" };
            }
          }
        : undefined;

      /**
       * The browser, as an in-process MCP server.
       *
       * IN-PROCESS RATHER THAN A SPAWNED SERVER because the engine already owns
       * the Chromium; a stdio MCP server would be a second process brokering
       * to the first. The scope key is resolved PER CALL from the run, never
       * captured once — a driver instance outlives any single turn.
       *
       * A MUTATING call goes through the SAME `onRequest` gate as every other
       * tool. Clicking a button on a live page is an action with consequences,
       * and the legacy stack classified browser calls for exactly this reason.
       */
      const mcpServers =
        options.browser && browserScopeKey
          ? {
              browser: await buildBrowserMcpServer(sdk, options.browser, browserScopeKey, async (name, args) => {
                if (!onRequest || options.browser!.isReadOnly(name, args)) return true;
                const decision = await onRequest({
                  kind: "tool_call",
                  detail: { kind: "tool_call", call: { name, input: args } },
                  toolUseId: `browser_${name}_${crypto.randomUUID().slice(0, 8)}`,
                });
                return decision === "accept" || decision === "acceptForSession";
              }),
            }
          : undefined;

      try {
        for await (const message of sdk.query({
          prompt,
          options: {
            cwd,
            permissionMode: "default",
            abortController: controller,
            includePartialMessages: true,
            ...(providerSessionId ? { resume: providerSessionId } : {}),
            ...(canUseTool ? { canUseTool } : {}),
            ...(mcpServers ? { mcpServers } : {}),
          },
        })) {
          const item = message as {
            type?: string;
            subtype?: string;
            session_id?: string;
            total_cost_usd?: number;
            usage?: unknown;
            message?: { content?: unknown[]; usage?: unknown };
            event?: {
              type?: string;
              index?: number;
              content_block?: { type?: string };
              delta?: { type?: string; text?: string; thinking?: string };
            };
          };

          if (str(item.session_id)) reportedSessionId = item.session_id;

          if (item.type === "result") {
            usage = usageFrom(item.usage, item.total_cost_usd) ?? usage;
            if (usage) emit({ kind: "usage", usage });
            if (item.subtype !== "success") {
              throw new Error(`Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`);
            }
            completed = true;
            await flush();
            continue;
          }

          // ── streaming text and reasoning ───────────────────────────────
          if (item.type === "stream_event") {
            const event = item.event ?? {};
            const index = typeof event.index === "number" ? event.index : -1;

            if (event.type === "content_block_start") {
              const blockType = event.content_block?.type;
              // TOOL BLOCKS ARE DELIBERATELY NOT OPENED HERE. Their input
              // arrives as `input_json_delta` fragments that are only valid
              // JSON once complete, and the assistant envelope below repeats
              // every tool_use with its input already parsed. Opening in both
              // places is how a row gets emitted twice.
              if (blockType === "text" || blockType === "thinking") {
                const id = itemId();
                openBlocks.set(index, { id, kind: blockType, text: "" });
                emit({
                  kind: "item.started",
                  item: {
                    id,
                    detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
                  },
                });
              }
              continue;
            }

            if (event.type === "content_block_delta") {
              const open = openBlocks.get(index);
              if (!open) continue;
              const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
              if (typeof text !== "string" || text.length === 0) continue;
              open.text += text;
              if (open.kind === "text") {
                receivedPartialText = true;
                finalText += text;
              }
              emit({
                kind: "content.delta",
                itemId: open.id,
                stream: open.kind === "text" ? "assistant_text" : "reasoning_text",
                text,
              });
              // Flush per delta: buffering streamed text defeats streaming.
              await flush();
              continue;
            }

            if (event.type === "content_block_stop") {
              const open = openBlocks.get(index);
              if (!open) continue;
              openBlocks.delete(index);
              emit(closeBlock(open));
              await flush();
            }
            continue;
          }

          // ── tool calls, from the complete envelope ─────────────────────
          if (item.type === "assistant") {
            usage = usageFrom(item.message?.usage, undefined) ?? usage;
            for (const raw of item.message?.content ?? []) {
              const block = asRecord(raw);
              if (block.type === "tool_use") {
                const name = str(block.name) ?? "tool";
                const useId = str(block.id) ?? itemId();
                const detail = itemDetailForToolCall(name, block.input);
                const seed: ItemSeed = {
                  id: `item_${useId}`,
                  detail,
                  title: titleForToolCall(name, detail),
                  providerRefs: { itemId: useId },
                };
                openTools.set(useId, { id: seed.id, detail });
                emit({ kind: "item.started", item: seed });
                continue;
              }
              // With partial messages enabled the envelope REPEATS its text.
              // Emitting it again would double both the transcript and the
              // final result, so this is only the compatibility fallback for
              // an SDK that produced no stream events at all.
              if (block.type === "text" && !receivedPartialText) {
                const text = str(block.text);
                if (!text) continue;
                finalText += text;
                const id = itemId();
                emit({ kind: "item.started", item: { id, detail: { type: "assistant_message", text } } });
                emit({ kind: "item.completed", itemId: id, status: "completed" });
              }
            }
            await flush();
            continue;
          }

          // ── tool results ──────────────────────────────────────────────
          if (item.type === "user") {
            for (const raw of item.message?.content ?? []) {
              const block = asRecord(raw);
              if (block.type !== "tool_result") continue;
              const useId = str(block.tool_use_id);
              const open = useId ? openTools.get(useId) : undefined;
              if (!open || !useId) continue;
              openTools.delete(useId);
              const failed = block.is_error === true;
              const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
              emit({
                kind: "item.completed",
                itemId: open.id,
                status: failed ? "failed" : "completed",
                detail: withToolOutput(open.detail, output),
              });
            }
            await flush();
          }
        }

        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        if (!completed) throw new Error("Claude ended without a successful result");

        // A tool whose result never arrived (the stream ended first) would
        // otherwise sit spinning in the UI forever.
        for (const [, open] of openTools) {
          emit({ kind: "item.completed", itemId: open.id, status: "failed" });
        }
        // A block the provider never closed still gets its accumulated text,
        // for the same reason: the projection has no other source for it.
        for (const [, open] of openBlocks) emit(closeBlock(open));
        await flush();

        return {
          text: finalText,
          ...(reportedSessionId ? { providerSessionId: reportedSessionId } : {}),
          ...(usage ? { usage } : {}),
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

/** Fold a tool's output into the detail its call opened with. */
function withToolOutput(detail: ItemDetail, output: string): ItemDetail {
  const preview = output.length > 4_000 ? `${output.slice(0, 4_000)}…` : output;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: preview } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return { ...detail, call: { ...detail.call, output: preview } };
    default:
      return detail;
  }
}
