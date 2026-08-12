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
import fs from "node:fs";
import type {
  BrowserProvider,
  BrowserTab,
  ItemDetail,
  ItemSeed,
  McpServer,
  TurnAttachment,
  RequestDecision,
  RequestDetail,
  RequestKind,
  PlanDetail,
  TaskKind,
  TaskSeed,
  TaskState,
  TurnObservation,
  UsageSnapshot,
} from "@telar/engine-client";
// The tool NAMING rule lives in the contract, not here — see ./protocol/tools.ts
// in engine-client. Every client renders these names too.
import { displayToolName, parseToolName, qualifyTelarTool, TELAR_MCP_SERVER } from "@telar/engine-client";
import { countDiffLines, patchHunksOf, unifiedDiff } from "./diff";

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
  /**
   * What the browser is looking at now, WITHOUT launching one.
   *
   * Optional because a capability assembled by a test has no browser to
   * describe. Its absence means the session simply never journals browser
   * state, which is strictly better than journalling an invented one.
   */
  state?(scopeKey: string): Promise<{ provider: BrowserProvider; tabs: BrowserTab[] }>;
};

export type DriverRun = {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /**
   * Which model to run, resolved by the engine from the session.
   *
   * ABSENT MEANS "the provider's own default", and that is a distinct state
   * from any string this code could invent. A driver that substituted a name
   * here would silently override whatever the installed harness is configured
   * to use, and the session would report a model it is not running.
   */
  model?: string;
  /** Reasoning effort, where the provider has the concept. Same absent rule. */
  effort?: string;
  /**
   * Files the human attached to THIS message, already on disk.
   *
   * The engine wrote them and owns the paths; a driver reads them and decides
   * how its provider wants them. That split is deliberate — a driver that
   * accepted bytes would have to be trusted with where they came from.
   */
  attachments?: TurnAttachment[];
  /** The user's own MCP servers, already filtered to the enabled ones by the
   *  engine. Telar's in-process servers are added by the driver on top. */
  mcpServers?: McpServer[];
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

/**
 * One user message with content blocks, which is the only way to hand this SDK
 * an image.
 *
 * A PLAIN STRING PROMPT STAYS A PLAIN STRING when there is nothing attached —
 * see `claudePrompt`. Switching every turn to the async-iterable form would
 * change how the SDK reads input for the 99% of turns that carry no file, for
 * no gain.
 */
type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: Array<Record<string, unknown>> };
  parent_tool_use_id: null;
};

/** The image types the Anthropic API accepts as an image block. Anything else
 *  is offered as a PATH instead — the agent has a Read tool, and a file it can
 *  open beats a block the API rejects. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Build the prompt Claude receives, attachments included.
 *
 * IMAGES GO IN AS PIXELS, EVERYTHING ELSE AS A PATH. An image is the one kind of
 * attachment the model cannot open for itself — there is no tool that turns a
 * PNG into something it can see — so it is inlined as base64. A text file, a
 * PDF, a CSV: the agent has Read and the file is on the same disk it is working
 * on, so a path is both smaller and more useful than an inlined copy it cannot
 * re-read later.
 *
 * A file that has vanished between upload and turn is NAMED rather than
 * silently dropped. "Look at this" with nothing attached is a worse failure than
 * a line saying the attachment could not be read.
 */
function claudePrompt(prompt: string, attachments: TurnAttachment[]): string | AsyncIterable<SdkUserMessage> {
  if (attachments.length === 0) return prompt;
  const blocks: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const attachment of attachments) {
    if (CLAUDE_IMAGE_TYPES.has(attachment.mediaType)) {
      try {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mediaType, data: fs.readFileSync(attachment.path).toString("base64") },
        });
        notes.push(`- ${attachment.name} (image, shown above)`);
        continue;
      } catch {
        notes.push(`- ${attachment.name} — attached but could not be read from ${attachment.path}`);
        continue;
      }
    }
    notes.push(`- ${attachment.name} (${attachment.mediaType}) at ${attachment.path}`);
  }
  blocks.push({ type: "text", text: `${prompt}\n\nAttached files:\n${notes.join("\n")}` });
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null } satisfies SdkUserMessage;
    },
  };
}

/**
 * The user's MCP servers in the SDK's own config shape.
 *
 * A TRANSLATION, NOT A PASS-THROUGH. The contract's `McpServerSpec` is the shape
 * three clients and a settings form agree on; this SDK's is the shape one
 * library wants, and `stdio` is the arm where they differ — the contract names
 * the transport explicitly, the SDK infers it. Keeping our own vocabulary means
 * a Codex-side implementation later reads the same config rather than the
 * Anthropic SDK's.
 */
function claudeMcpServers(servers: McpServer[] | undefined): Record<string, SdkMcpServer> | undefined {
  if (!servers || servers.length === 0) return undefined;
  const out: Record<string, SdkMcpServer> = {};
  for (const server of servers) {
    if (server.spec.transport === "stdio") {
      out[server.id] = {
        type: "stdio",
        command: server.spec.command,
        ...(server.spec.args ? { args: server.spec.args } : {}),
        // Overlaid on the worker's environment rather than replacing it: an MCP
        // server still needs PATH and HOME like any other child process.
        ...(server.spec.env ? { env: { ...process.env, ...server.spec.env } } : {}),
      };
      continue;
    }
    out[server.id] = {
      type: server.spec.transport,
      url: server.spec.url,
      ...(server.spec.headers ? { headers: server.spec.headers } : {}),
    };
  }
  return out;
}

/**
 * The Agent SDK's effort vocabulary, verbatim from its `EffortLevel`.
 *
 * `ModelSelection.effort` is an OPEN string on purpose — provider vocabularies
 * differ, and the contract says so (packages/engine-client/src/protocol/common.ts).
 * So the word travelling from a session may be one this SDK has never heard of,
 * set by another client or by a provider that spells its levels differently. It
 * is DROPPED here rather than forwarded: failing a whole turn over an unknown
 * display-level nicety is the worse trade, and a level the SDK cannot honour is
 * indistinguishable from none.
 */
type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
const claudeEffort = (value: string | undefined): ClaudeEffort | undefined =>
  value !== undefined && CLAUDE_EFFORTS.has(value) ? (value as ClaudeEffort) : undefined;

type ClaudeSdk = {
  query(input: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options: {
      cwd: string;
      permissionMode: "default";
      abortController: AbortController;
      /** Omitted entirely when the session names none — the SDK then uses the
       *  model the local Claude Code install is configured with. */
      model?: string;
      /** How hard to think. A CLOSED vocabulary here, unlike `DriverRun.effort`
       *  — see `claudeEffort` below. */
      effort?: ClaudeEffort;
      includePartialMessages: true;
      /** Without this the SDK forwards only a sub-agent's tool_use/tool_result
       *  blocks — "enough for a heartbeat counter", in its own words. A nested
       *  transcript needs the text and the thinking too. */
      forwardSubagentText: true;
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
  onNavigated: () => void,
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
        const result = await browser.call(scopeKey, definition.name, args);
        // A call that CHANGED something is the only one worth re-reading state
        // for. Polling after every read would put a screenshot's worth of work
        // behind each `browser_snapshot`.
        if (!browser.isReadOnly(definition.name, args) && !result.isError) onNavigated();
        return result;
      },
    ),
  );
  // ONE server for every Telar capability, not one per toolkit.
  return createSdkMcpServer({ name: TELAR_MCP_SERVER, version: "2.0.0", tools });
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
    case "browser_action":
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

  const parsed = parseToolName(name);
  /**
   * TELAR'S OWN TOOLS GET THEIR OWN ROW TYPES.
   *
   * This arm is what `browser_action` was waiting for. It has been in the
   * contract and in the cockpit's icon table since v2 was written, and nothing
   * produced it: the browser was registered as a server called `browser`, so
   * every call matched the generic `mcp__` arm below and rendered as an
   * anonymous MCP row with a duplicated name. Routing on CAPABILITY rather than
   * on server identity is what makes the distinction survive the next toolkit.
   */
  if (parsed.capability === "browser") {
    return {
      type: "browser_action",
      call: { name, server: parsed.server ?? TELAR_MCP_SERVER, input: toolInput },
      // The page it acts on, when the call names one. Absent for a click or a
      // snapshot, which act on wherever the tab already is.
      ...(str(args.url) ? { url: str(args.url)! } : {}),
    };
  }
  if (parsed.server) {
    return {
      type: "mcp_tool_call",
      call: { name, server: parsed.server, input: toolInput },
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
    case "browser_action":
      // `browser_navigate → example.com` rather than the qualified name. The
      // stored `call.name` stays fully qualified; this is the label only.
      return detail.url ? `${displayToolName(name)} → ${oneLine(detail.url, 80)}` : displayToolName(name);
    case "mcp_tool_call":
      return displayToolName(name);
    default:
      return name;
  }
}

/**
 * Which kind of task an SDK `task_started` describes.
 *
 * A DENYLIST, matching ./tasks.ts in the contract and t3 code's own comment on
 * the same problem: the SDK renames its agent-flavoured task types as it grows
 * (`subagent`, `local_agent`, `local_workflow`, …), and an ALLOWLIST silently
 * dropped real sub-agents the first time a new name appeared. Only the types
 * KNOWN to be background are treated as background; everything else is an agent
 * and shows up unstyled rather than invisible.
 */
const BACKGROUND_TASK_TYPES = new Set(["background_shell", "background_bash", "monitor", "watch"]);

export function taskKindForType(taskType: string | undefined): TaskKind {
  return taskType && BACKGROUND_TASK_TYPES.has(taskType) ? "background" : "agent";
}

/** The SDK's task status vocabulary onto the contract's. `killed` and `paused`
 *  have no contract equivalent and map to the nearest honest one — a killed
 *  task was stopped, and a paused one is still waiting to resume. */
export function taskStateForStatus(status: string | undefined): TaskState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    case "paused":
      return "waiting";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

/**
 * A TodoWrite call as the contract's plan.
 *
 * Returns `undefined` when the payload is not a todo list, so an unrecognised
 * shape falls through to an ordinary tool row rather than becoming an empty
 * plan that claims the agent has no steps.
 */
export function planDetailForTodos(input: unknown): PlanDetail | undefined {
  const todos = asRecord(input).todos;
  if (!Array.isArray(todos)) return undefined;
  const steps = todos.flatMap((raw) => {
    const todo = asRecord(raw);
    // `content` is the imperative form; `activeForm` is the present-continuous
    // one the SDK shows while a step runs. The imperative reads correctly in a
    // list whatever the step's state, so it is the one stored.
    const step = str(todo.content) ?? str(todo.activeForm);
    if (!step) return [];
    const status = todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "inProgress" : "pending";
    return [{ step, status } as const];
  });
  return steps.length > 0 ? { steps } : undefined;
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
    async run({
      prompt,
      cwd,
      signal,
      model,
      effort,
      attachments,
      mcpServers: userMcpServers,
      onObservations,
      onRequest,
      providerSessionId,
      browserScopeKey,
    }) {
      let sdk: ClaudeSdk;
      try {
        sdk = await loadSdk();
      } catch {
        throw new ProviderUnavailableError(
          "Claude Agent SDK is unavailable; install and configure Claude Code before retrying",
        );
      }
      const sdkEffort = claudeEffort(effort);
      const userServers = claudeMcpServers(userMcpServers);
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
      const openBlocks = new Map<string, { id: string; kind: "text" | "thinking"; text: string }>();

      const closeBlock = (block: { id: string; kind: "text" | "thinking"; text: string }): TurnObservation => ({
        kind: "item.completed",
        itemId: block.id,
        status: "completed",
        detail: block.kind === "text" ? { type: "assistant_message", text: block.text } : { type: "reasoning", text: block.text },
      });
      /** Tool rows keyed by `tool_use_id`, so a later `tool_result` closes the
       *  row its call opened rather than opening a second one. */
      const openTools = new Map<string, { id: string; detail: ItemDetail }>();

      /**
       * Sub-agents, keyed by the SDK's own `task_id`.
       *
       * THE CONTRACT ID IS DERIVED FROM `tool_use_id` WHEN THERE IS ONE, not
       * from `task_id`, and that is what makes filing work without a lookup:
       * every message produced inside a sub-agent carries `parent_tool_use_id`
       * — the id of the `Task` call that launched it — so an item can name its
       * task from the message alone. `task_updated` is the one SDK message that
       * carries `task_id` and no `tool_use_id`, which is the only reason this
       * map exists.
       */
      /** The turn's single plan row, once TodoWrite has opened one. */
      let planItemId: string | undefined;

      const taskIdsBySdkId = new Map<string, string>();
      /** Last seed per task, so `task_updated`'s PATCH can be folded onto
       *  something rather than sent as a task with no title or kind. */
      const knownTasks = new Map<string, TaskSeed>();

      const taskIdFor = (sdkTaskId: string | undefined, toolUseId: string | undefined): string => {
        if (toolUseId) return `task_${toolUseId}`;
        if (sdkTaskId && taskIdsBySdkId.has(sdkTaskId)) return taskIdsBySdkId.get(sdkTaskId)!;
        return `task_${sdkTaskId ?? crypto.randomUUID().replaceAll("-", "")}`;
      };

      /** Fold a partial report onto what this task was last known to be, then
       *  emit it whole — the repetition ./tasks.ts requires of every event. */
      const emitTask = (
        kind: "task.started" | "task.progress" | "task.completed",
        sdkTaskId: string | undefined,
        patch: Partial<TaskSeed> & { state: TaskState },
        toolUseId?: string,
        message?: string,
      ): void => {
        const id = taskIdFor(sdkTaskId, toolUseId);
        if (sdkTaskId) taskIdsBySdkId.set(sdkTaskId, id);
        const known = knownTasks.get(id);
        const task: TaskSeed = {
          ...known,
          ...patch,
          id,
          kind: patch.kind ?? known?.kind ?? "agent",
          state: patch.state,
          ...(sdkTaskId ? { providerTaskId: sdkTaskId } : {}),
        };
        knownTasks.set(id, task);
        emit(kind === "task.progress" ? { kind, task, ...(message ? { message } : {}) } : { kind, task });
      };

      /** A sub-agent's usage, in the contract's shape. The SDK reports one
       *  total rather than an input/output split, and inventing a split would
       *  be a fabricated number — it is carried as output, which is the field a
       *  cost roll-up sums. */
      const taskUsage = (value: unknown): UsageSnapshot | undefined => {
        const usage = asRecord(value);
        if (typeof usage.total_tokens !== "number") return undefined;
        return { tokens: { input: 0, output: usage.total_tokens, cacheRead: 0, cacheCreate: 0 } };
      };

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
      /**
       * Journal what the browser is looking at after it moves.
       *
       * SEQUENCED THROUGH A SINGLE PROMISE rather than fired per call: a page
       * that redirects produces several mutating calls in quick succession, and
       * two overlapping `state()` reads would report the intermediate page after
       * the final one. Failures are swallowed — a browser panel that cannot be
       * described must not fail the tool call that moved it.
       */
      let browserStateQueue: Promise<void> = Promise.resolve();
      const reportBrowserState = (): void => {
        const read = options.browser?.state;
        if (!read || !browserScopeKey) return;
        browserStateQueue = browserStateQueue
          .then(async () => {
            const state = await read.call(options.browser, browserScopeKey);
            emit({ kind: "browser.state", provider: state.provider, tabs: state.tabs });
            await flush();
          })
          .catch(() => undefined);
      };

      /**
       * THE KEY IS WHAT NAMES THE SERVER, not `createSdkMcpServer`'s `name`.
       *
       * Measured, by running it: with `createSdkMcpServer({ name: "telar" })`
       * but this key left as `browser`, the model still saw
       * `mcp__browser__browser_navigate` and every call landed back in the
       * generic `mcp_tool_call` arm. The title read correctly the whole time,
       * which is exactly why a passing unit test on `itemDetailForToolCall` did
       * not catch it — the mapping was right and the input to it was wrong.
       */
      const telarServer =
        options.browser && browserScopeKey
          ? {
              [TELAR_MCP_SERVER]: await buildBrowserMcpServer(
                sdk,
                options.browser,
                browserScopeKey,
                async (name, args) => {
                  if (!onRequest || options.browser!.isReadOnly(name, args)) return true;
                  const decision = await onRequest({
                    kind: "tool_call",
                    // The QUALIFIED name, so the approval and the timeline row
                    // name the same tool. A client shortens it for display
                    // (`displayToolName`); the data does not lie about which
                    // server it belongs to.
                    detail: { kind: "tool_call", call: { name: qualifyTelarTool(name), server: TELAR_MCP_SERVER, input: args } },
                    toolUseId: `${TELAR_MCP_SERVER}_${name}_${crypto.randomUUID().slice(0, 8)}`,
                  });
                  return decision === "accept" || decision === "acceptForSession";
                },
                reportBrowserState,
              ),
            }
          : undefined;

      /**
       * TELAR'S SERVERS AND THE USER'S, IN ONE RECORD — and Telar's are applied
       * LAST on purpose. The keys become the `mcp__<key>__<tool>` addressing
       * every client parses, so a user server called `telar` would shadow the
       * engine's own capabilities and route their approvals to the generic arm.
       * Losing a colliding user server is the better failure of the two, and it
       * is the one the naming standard in ./protocol/tools.ts already assumes.
       */
      const mcpServers =
        userServers || telarServer ? { ...(userServers ?? {}), ...(telarServer ?? {}) } : undefined;

      try {
        for await (const message of sdk.query({
          prompt: claudePrompt(prompt, attachments ?? []),
          options: {
            cwd,
            permissionMode: "default",
            abortController: controller,
            includePartialMessages: true,
            forwardSubagentText: true,
            ...(model ? { model } : {}),
            ...(sdkEffort ? { effort: sdkEffort } : {}),
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
            /** The tool's full structured Output — where `structuredPatch` lives. */
            tool_use_result?: unknown;
            /** Set on everything a sub-agent produced: the id of the `Task`
             *  call that launched it. `null` on the main loop's own messages. */
            parent_tool_use_id?: string | null;
            task_id?: string;
            tool_use_id?: string;
            description?: string;
            subagent_type?: string;
            task_type?: string;
            workflow_name?: string;
            summary?: string;
            status?: string;
            patch?: { status?: string; description?: string; error?: string; is_backgrounded?: boolean };
            event?: {
              type?: string;
              index?: number;
              content_block?: { type?: string };
              delta?: { type?: string; text?: string; thinking?: string };
            };
          };

          if (str(item.session_id)) reportedSessionId = item.session_id;

          /**
           * Whose work is this?
           *
           * A SUB-AGENT'S OUTPUT MUST NOT BECOME THE TURN'S RESULT, which is
           * the trap `forwardSubagentText` opens: with it on, every sub-agent's
           * prose arrives as an ordinary `assistant` message, and appending it
           * to `finalText` would make the turn's summary the concatenation of
           * five agents talking at once instead of the main loop's answer.
           */
          const parentToolUseId = str(item.parent_tool_use_id ?? undefined);
          const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : undefined;

          // ── sub-agents and background work ────────────────────────────
          if (item.type === "system" && item.subtype === "task_started") {
            emitTask(
              "task.started",
              str(item.task_id),
              {
                state: "running",
                kind: taskKindForType(str(item.task_type)),
                ...(str(item.description) ? { title: oneLine(item.description!) } : {}),
                ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
                ...(str(item.workflow_name)
                  ? { warp: { warpRunId: str(item.task_id) ?? "warp", warpName: item.workflow_name! } }
                  : {}),
              },
              str(item.tool_use_id),
            );
            await flush();
            continue;
          }
          if (item.type === "system" && item.subtype === "task_progress") {
            /**
             * A PROGRESS DESCRIPTION DOES NOT RENAME THE TASK.
             *
             * Measured against the real SDK: `task_started` carried "Find
             * top-level .ts files non-recursively" and the progress messages
             * that followed carried "Running Find top-level .ts files
             * non-recursively". Taking the later one as the title makes a
             * roster row read as status prose, and makes it churn while the
             * agent runs. The start event names the task; progress reports on
             * it. A task that never announced a start still takes one, because
             * an ugly title beats an anonymous row.
             */
            const known = knownTasks.get(taskIdFor(str(item.task_id), str(item.tool_use_id)));
            emitTask(
              "task.progress",
              str(item.task_id),
              {
                state: "running",
                ...(!known?.title && str(item.description) ? { title: oneLine(item.description!) } : {}),
                ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
                ...(taskUsage(item.usage) ? { usage: taskUsage(item.usage)! } : {}),
              },
              str(item.tool_use_id),
              str(item.summary),
            );
            await flush();
            continue;
          }
          if (item.type === "system" && item.subtype === "task_updated") {
            const status = str(item.patch?.status);
            const state = taskStateForStatus(status);
            const terminal = state === "completed" || state === "failed" || state === "stopped";
            emitTask(
              terminal ? "task.completed" : "task.progress",
              str(item.task_id),
              {
                state,
                ...(str(item.patch?.description) ? { title: oneLine(item.patch!.description!) } : {}),
                ...(str(item.patch?.error) ? { failure: item.patch!.error! } : {}),
                ...(item.patch?.is_backgrounded === true ? { kind: "background" as const } : {}),
              },
              undefined,
            );
            await flush();
            continue;
          }
          if (item.type === "system" && item.subtype === "task_notification") {
            emitTask(
              "task.completed",
              str(item.task_id),
              {
                state: taskStateForStatus(str(item.status)),
                ...(str(item.summary) ? { resultText: item.summary! } : {}),
                ...(taskUsage(item.usage) ? { usage: taskUsage(item.usage)! } : {}),
              },
              str(item.tool_use_id),
            );
            await flush();
            continue;
          }

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
            /**
             * KEYED BY OWNER AND INDEX, NOT BY INDEX ALONE.
             *
             * Content-block indices restart at 0 in every agent, so with
             * sub-agent text forwarded a child's block 0 and the main loop's
             * block 0 are two different blocks with one key — the child's
             * `content_block_start` would silently overwrite the parent's open
             * row and the parent's deltas would then append to the child's
             * item. Concurrent agents make this the common case, not an edge.
             */
            const index = `${parentToolUseId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;

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
                    ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
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
              if (open.kind === "text" && !ownerTaskId) {
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
            // A sub-agent's usage is reported on its own task, not folded into
            // the parent's running total, or the turn would double-count it
            // against the `result` message's authoritative figure.
            if (!ownerTaskId) usage = usageFrom(item.message?.usage, undefined) ?? usage;
            for (const raw of item.message?.content ?? []) {
              const block = asRecord(raw);
              if (block.type === "tool_use") {
                const name = str(block.name) ?? "tool";
                const useId = str(block.id) ?? itemId();
                /**
                 * ONE PLAN ROW PER TURN, UPDATED IN PLACE.
                 *
                 * TodoWrite is called repeatedly with the WHOLE list, so a row
                 * per call leaves the transcript full of near-identical
                 * checklists — the exact failure the Codex seam already avoids,
                 * and the reason `plan` says "updated in place across a turn".
                 * The call is deliberately not registered in `openTools`, so
                 * its `tool_result` closes nothing; the plan closes with the
                 * turn.
                 */
                const plan = name === "TodoWrite" ? planDetailForTodos(block.input) : undefined;
                if (plan) {
                  const detail: ItemDetail = { type: "plan", plan };
                  if (planItemId) emit({ kind: "item.updated", item: { id: planItemId, detail, title: "Plan" } });
                  else {
                    planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
                    emit({ kind: "item.started", item: { id: planItemId, detail, title: "Plan" } });
                  }
                  continue;
                }
                /**
                 * A `Task` call is a HANDLE, not a tool row.
                 *
                 * items.ts defines `task` as "the row is a handle; the detail
                 * is on the task events", and the id is derived from the
                 * tool_use id — the same derivation every message inside the
                 * sub-agent will produce from its `parent_tool_use_id`. That is
                 * what joins the handle to the work without a lookup table.
                 */
                const isTask = name === "Task" || name === "Agent";
                const detail: ItemDetail = isTask
                  ? { type: "task", taskId: `task_${useId}` }
                  : itemDetailForToolCall(name, block.input);
                const title = isTask
                  ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name)
                  : titleForToolCall(name, detail);
                const seed: ItemSeed = {
                  id: `item_${useId}`,
                  detail,
                  title,
                  ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
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
                if (!ownerTaskId) finalText += text;
                const id = itemId();
                emit({
                  kind: "item.started",
                  item: { id, detail: { type: "assistant_message", text }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) },
                });
                emit({ kind: "item.completed", itemId: id, status: "completed" });
              }
            }
            await flush();
            continue;
          }

          // ── tool results ──────────────────────────────────────────────
          if (item.type === "user") {
            const results = (item.message?.content ?? []).map(asRecord).filter((block) => block.type === "tool_result");
            /**
             * `tool_use_result` IS PER MESSAGE, NOT PER BLOCK.
             *
             * It carries the tool's full structured Output — for a file edit,
             * the `structuredPatch` this whole diff feature depends on. But the
             * SDK hangs it off the message rather than off the block, so with
             * two results in one message there is no way to know which it
             * describes. Attaching it anyway would put one file's diff on
             * another file's row, which is worse than having no diff at all.
             */
            const structured = results.length === 1 ? item.tool_use_result : undefined;
            for (const block of results) {
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
                detail: withToolResult(open.detail, output, structured),
              });
            }
            await flush();
          }
        }

        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        if (!completed) throw new Error("Claude ended without a successful result");

        // Drained BEFORE the turn settles. A state read still in flight would
        // otherwise report against a turn the engine has already closed, which
        // it rejects as a conflict.
        await browserStateQueue;

        // A tool whose result never arrived (the stream ended first) would
        // otherwise sit spinning in the UI forever.
        for (const [, open] of openTools) {
          emit({ kind: "item.completed", itemId: open.id, status: "failed" });
        }
        // A block the provider never closed still gets its accumulated text,
        // for the same reason: the projection has no other source for it.
        for (const [, open] of openBlocks) emit(closeBlock(open));
        // The plan is turn-scoped and has no tool_result to close it.
        if (planItemId) emit({ kind: "item.completed", itemId: planItemId, status: "completed" });
        /**
         * A task left running when the turn ended is closed as failed.
         *
         * THIS MATTERS MORE THAN THE TOOL CASE ABOVE. `livenessOf()` reads task
         * state to answer "is this session still working", and a sub-agent
         * stuck at `running` makes a finished detached session claim it is
         * still busy — forever, with no live stream to correct it and nothing
         * for a human to stop. A BACKGROUND task is left alone: outliving its
         * turn is what background means.
         */
        for (const [id, task] of knownTasks) {
          if (task.kind === "background") continue;
          if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
          emit({ kind: "task.completed", task: { ...task, id, state: "failed", failure: "the turn ended before this agent reported back" } });
        }
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

/**
 * Fold a tool's result into the detail its call opened with.
 *
 * `structured` is the SDK's full Output object, which is where the interesting
 * half lives: a file edit's `structuredPatch`. The string `output` is only what
 * was sent to the MODEL, and for an edit that is a confirmation sentence.
 */
export function withToolResult(detail: ItemDetail, output: string, structured?: unknown): ItemDetail {
  if (detail.type === "file_change") {
    const hunks = patchHunksOf(structured);
    if (!hunks) return detail;
    return {
      ...detail,
      change: {
        ...detail.change,
        unifiedDiff: unifiedDiff(detail.change.path, hunks),
        ...countDiffLines(hunks),
      },
    };
  }
  return withToolOutput(detail, output);
}

/** Fold a tool's output into the detail its call opened with. */
function withToolOutput(detail: ItemDetail, output: string): ItemDetail {
  const preview = output.length > 4_000 ? `${output.slice(0, 4_000)}…` : output;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: preview } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    // A browser action's output is its snapshot or its console dump, and it is
    // the whole reason the row is expandable. Omitted before this arm existed.
    case "browser_action":
      return { ...detail, call: { ...detail.call, output: preview } };
    default:
      return detail;
  }
}
