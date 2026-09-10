/**
 * Codex `ThreadItem`s and notification payloads, mapped onto the contract's
 * canonical rows.
 *
 * PURE ON PURPOSE. Everything here is a value in, a value out, so the mapping
 * that decides what a session LOOKS like is testable without a subprocess, a
 * thread or a turn — which is the half of the legacy bridge that was only ever
 * exercised end-to-end and therefore only ever wrong in production.
 *
 * The mapping is BY CAPABILITY, matching `../driver.ts`: a Codex
 * `commandExecution` and a Claude `Bash` land on the same `command_execution`
 * row, so the cockpit needs one renderer rather than one per provider. An item
 * type nobody here recognises becomes `unknown` rather than being dropped — a
 * silently missing row is worse than an ugly one, and Codex ships new item
 * types faster than this file can learn them.
 */
import { requestKindForTool } from "../driver";
import { canonicalToolName, parseToolName, type ItemDetail, type ItemStatus, type RequestDetail, type RequestKind, type UsageSnapshot } from "@telar/engine-client";
import { titleForToolCall } from "../driver";

export type CodexItem = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function nonNegative(value: unknown): number {
  const n = int(value);
  return n !== undefined && n >= 0 ? n : 0;
}

/** Output is carried in full as deltas; the row keeps a bounded preview. */
function preview(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}

/**
 * `item.status`, straight through where the vocabularies already agree.
 *
 * `declined` IS NOT `failed` AND THE DIFFERENCE IS THE PRODUCT: a human said no
 * and nothing went wrong. The contract carries the distinction (`ItemStatus`),
 * Codex carries the distinction, and collapsing them here would be the one
 * place it got lost.
 */
export function codexItemStatus(value: unknown, fallback: ItemStatus): ItemStatus {
  return value === "inProgress" || value === "completed" || value === "failed" || value === "declined"
    ? value
    : fallback;
}

/** Codex's file-change verbs, in the contract's spelling. */
function fileChangeKind(value: unknown): "create" | "edit" | "delete" | "rename" {
  switch (value) {
    case "add":
    case "create":
      return "create";
    case "delete":
    case "remove":
      return "delete";
    case "rename":
    case "move":
      return "rename";
    default:
      // `update` and anything a newer app-server invents: an edit is the
      // conservative reading, and it keeps the row renderable.
      return "edit";
  }
}

/** The text a `dynamicToolCall`'s content items amount to. */
function contentItemsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((raw) => {
      const item = record(raw);
      if (item.type === "inputText") return String(item.text ?? "");
      if (item.type === "inputImage") return "[image]";
      if (item.type === "inputAudio") return "[audio]";
      return "[tool content omitted]";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * One Codex thread item as a timeline row, or `null` for the items the engine
 * already owns.
 *
 * `userMessage` IS DELIBERATELY DROPPED: the engine journalled the prompt when
 * it accepted the turn, and echoing Codex's copy back would give every turn two
 * user rows that disagree the moment attachments exist.
 */
export function codexItemDetail(item: CodexItem): { detail: ItemDetail; title?: string } | null {
  const type = str(item.type) ?? "unknown";
  switch (type) {
    case "userMessage":
    case "hookPrompt":
      return null;

    case "agentMessage":
      return { detail: { type: "assistant_message", text: str(item.text) ?? "" } };

    // NO TEXT ON THE ITEM, EVER. Codex sends reasoning content only as
    // `item/reasoning/textDelta`; reading a `text` field here would look right
    // and always produce an empty block.
    case "reasoning":
      return { detail: { type: "reasoning", text: "" } };

    case "commandExecution": {
      // `command` IS A STRING on this wire, not Claude's argv array. Joining or
      // indexing it is how a shell line becomes its first character.
      const command = str(item.command) ?? "";
      const output = str(item.aggregatedOutput);
      const detail: ItemDetail = {
        type: "command_execution",
        command: {
          command,
          ...(str(item.cwd) ? { cwd: str(item.cwd)! } : {}),
          ...(int(item.exitCode) !== undefined ? { exitCode: int(item.exitCode)! } : {}),
          ...(output ? { outputPreview: preview(output) } : {}),
        },
      };
      return { detail, title: titleForToolCall(command || "command", detail) };
    }

    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
      const first = changes[0] ?? {};
      const detail: ItemDetail = {
        type: "file_change",
        change: {
          path: str(first.path) ?? "(unknown)",
          kind: fileChangeKind(first.kind),
        },
      };
      // ONE CODEX ITEM IS ONE ROW even when it patched several files, because
      // the completion that closes this row names one item id. The count is put
      // in the title so a multi-file patch does not read as a single-file one;
      // `FileChangeDetail` has nowhere to carry the rest, and inventing extra
      // rows would leave them open when only the parent item completes.
      const title = changes.length > 1 ? `${detail.change.path} (+${changes.length - 1} more)` : detail.change.path;
      return { detail, title };
    }

    case "mcpToolCall": {
      const server = str(item.server);
      const tool = str(item.tool) ?? "tool";
      const failure = str(record(item.error).message);
      const output = failure ?? (item.result === undefined ? undefined : item.result);
      /**
       * NORMALIZED TO CLAUDE'S SPELLING, not to Codex's own.
       *
       * Codex hands over `{ server, tool }` and this used to render
       * `linear.search` while the same tool called through Claude stored
       * `mcp__linear__search`. One tool, two names, and therefore two rows a
       * client cannot group, two approvals to remember, and — once Telar's own
       * toolkits reach Codex — a `browser_*` call that maps to `browser_action`
       * from one provider and `mcp_tool_call` from the other. See the contract's
       * ./protocol/tools.ts.
       */
      const name = canonicalToolName(server, tool);
      const call = {
        name,
        ...(server ? { server } : {}),
        ...(item.arguments === undefined ? {} : { input: item.arguments }),
        ...(output === undefined ? {} : { output }),
        ...(str(item.id) ? { toolUseId: str(item.id)! } : {}),
      };
      // Telar's own capabilities get their own row type here too, so the split
      // is by capability rather than by which provider placed the call.
      if (parseToolName(name).capability === "browser") {
        const url = str(record(item.arguments).url);
        return {
          detail: { type: "browser_action", call, ...(url ? { url } : {}) },
          title: url ? `${tool} → ${url}` : tool,
        };
      }
      return { detail: { type: "mcp_tool_call", call }, title: tool };
    }

    case "dynamicToolCall": {
      const namespace = str(item.namespace);
      const tool = str(item.tool) ?? "tool";
      const name = namespace ? `${namespace}.${tool}` : tool;
      const output = contentItemsText(item.contentItems);
      return {
        detail: {
          type: "dynamic_tool_call",
          call: {
            name,
            ...(item.arguments === undefined ? {} : { input: item.arguments }),
            ...(output ? { output } : {}),
            ...(str(item.id) ? { toolUseId: str(item.id)! } : {}),
          },
        },
        title: name,
      };
    }

    case "webSearch": {
      const detail: ItemDetail = { type: "web_search", query: str(item.query) ?? "" };
      return { detail, title: titleForToolCall("web search", detail) };
    }

    // The provider compacted its own context mid-turn. Worth a row: it explains
    // why the agent appears to forget something.
    case "contextCompaction":
      return { detail: { type: "context_compaction" }, title: "Context compacted" };

    default:
      return {
        detail: { type: "unknown", label: type, payload: item },
        title: type,
      };
  }
}

/**
 * Whether a completed item's own payload contradicts its status.
 *
 * `dynamicToolCall` reports failure in `success: false` while its status still
 * reads `completed`, which is the one place Codex disagrees with itself.
 */
export function codexItemFailed(item: CodexItem, status: ItemStatus): boolean {
  return status === "failed" || item.success === false;
}

/**
 * A server→client approval request, in the contract's vocabulary.
 *
 * FOUR METHODS, TWO GENERATIONS. `item/*` is current; `execCommandApproval` and
 * `applyPatchApproval` are the pre-item spellings that are still on the wire.
 * A client that recognises only one generation does not fail loudly — it stops
 * answering, and the app-server waits forever.
 */
export function codexApprovalRequest(
  method: string,
  params: Record<string, unknown>,
): { kind: RequestKind; detail: RequestDetail; toolUseId: string } | null {
  if (method === MCP_ELICITATION) return mcpToolApproval(params);
  const isFile = method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
  const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
  if (!isFile && !isCommand) return null;

  // `itemId` correlates the approval with the row it is about; `callId` is the
  // legacy pair's spelling of the same thing.
  const toolUseId = str(params.itemId) ?? str(params.callId) ?? `${isFile ? "fileChange" : "command"}_${Date.now()}`;

  if (isCommand) {
    // The item/* spelling is one string; the legacy one is an argv array.
    const raw = params.command;
    const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(String).join(" ") : "";
    return {
      kind: "command_execution",
      detail: {
        kind: "command_execution",
        command: { command, ...(str(params.cwd) ? { cwd: str(params.cwd)! } : {}) },
      },
      toolUseId,
    };
  }

  // The legacy `applyPatchApproval` keys its changes BY PATH; the item/* pair
  // sends a list. Same fact, two shapes, and only one of them has a `path`
  // field to read.
  const changes: Record<string, unknown>[] = Array.isArray(params.changes)
    ? params.changes.map(record)
    : Object.entries(record(params.fileChanges)).map(([path, change]) => ({ ...record(change), path }));
  const first = changes[0] ?? {};
  return {
    kind: "file_change",
    detail: {
      kind: "file_change",
      change: { path: str(first.path) ?? str(params.path) ?? "(unknown)", kind: fileChangeKind(first.kind) },
    },
    toolUseId,
  };
}

/**
 * HOW CODEX ASKS ABOUT AN MCP TOOL — which is not an approval request at all.
 *
 * It arrives as an MCP *elicitation*, the protocol's general "ask the human
 * something" channel, with the approval hidden in `_meta`:
 *
 *   mcpServer/elicitation/request {
 *     serverName: "linear", mode: "form",
 *     message: 'Allow the linear MCP server to run tool "search"?',
 *     _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {…} },
 *     requestedSchema: { type: "object", properties: {} },
 *   }
 *
 * WHY THIS IS WORTH THE PARSING. Without it the request falls through to the
 * transport's `-32601` — sent so the app-server is never left waiting — and
 * Codex reads a refused REQUEST as a refused TOOL, ending the turn with "user
 * rejected MCP tool call" about a user who was never asked. The first fix here
 * was to pre-approve every tool in the injected config, which worked and was
 * too blunt: it moved the decision out of the engine entirely. Answering the
 * question keeps it where every other decision lives.
 *
 * THE TOOL NAME IS ONLY IN THE PROSE. `serverName` and `_meta.tool_params` are
 * structured; the tool itself appears solely inside `message`, so it is read
 * out of the quotes with the message as the fallback. Verified against
 * codex-cli 0.145.0 by running a real turn and logging the request.
 *
 * AN ELICITATION WITHOUT `codex_approval_kind` IS NOT OURS. A server may
 * legitimately elicit input — a form, a URL to visit — and the engine has no
 * answer to invent, which is the same rule `user_input` follows in the
 * contract. Those return null here and the driver declines them explicitly.
 */
export const MCP_ELICITATION = "mcpServer/elicitation/request";

function mcpToolApproval(
  params: Record<string, unknown>,
): { kind: RequestKind; detail: RequestDetail; toolUseId: string } | null {
  const meta = record(params._meta);
  if (meta.codex_approval_kind !== "mcp_tool_call") return null;
  const server = str(params.serverName) ?? "mcp";
  const message = str(params.message) ?? "";
  const quoted = /"([^"]+)"/.exec(message)?.[1];
  const tool = quoted ?? message ?? "tool";
  /**
   * CLASSIFIED THE SAME WAY CLAUDE'S IS, and this used to be a real defect.
   *
   * This arm answered `tool_call` unconditionally, so `spool_list_items` — a
   * pure read — auto-accepted under Claude and parked a card under Codex, for
   * the same tool. The engine's own classifier is the single authority for
   * every wire; the host installs the plugin half of it at startup, so a
   * plugin's reads are ratified once and answered identically wherever the call
   * came from.
   */
  const name = quoted ? canonicalToolName(server, quoted) : tool;
  const kind = requestKindForTool(name);
  return {
    kind,
    detail: {
      kind: "tool_call",
      // Qualified the way every other row names an MCP tool, so an approval
      // card and the timeline row it is about spell the same string.
      call: {
        name,
        server,
        ...(meta.tool_params === undefined ? {} : { input: meta.tool_params }),
      },
    },
    // No item id travels on this request — the elicitation is identified by its
    // own MCP request id, which the app-server does not forward. The turn id is
    // the most specific thing here that correlates with anything.
    toolUseId: `mcp_${server}_${str(params.turnId) ?? str(params.threadId) ?? "call"}`,
  };
}

/**
 * `thread/tokenUsage/updated` → the contract's usage snapshot.
 *
 * `last`, NEVER `total`. `total` is cumulative across the thread's whole
 * history, so on a resumed session it re-reports every earlier turn's tokens
 * and the ledger double-counts — the exact bug the legacy adapter's own comment
 * records.
 *
 * NO `costUsd`. Codex quotes no price anywhere on this wire; a computed one
 * would be a second definition of what a turn cost, and the contract is explicit
 * that the field carries the provider's own figure or nothing.
 */
export function codexUsage(params: Record<string, unknown>): UsageSnapshot | undefined {
  const usage = record(params.tokenUsage);
  const last = record(usage.last);
  if (Object.keys(last).length === 0) return undefined;

  const input = nonNegative(last.inputTokens);
  const output = nonNegative(last.outputTokens);
  const cacheRead = nonNegative(last.cachedInputTokens);
  const reasoning = nonNegative(last.reasoningOutputTokens);
  const contextMax = int(usage.modelContextWindow);
  // The last call's own total IS the occupancy of the window it ran against —
  // for a linear thread every earlier message is in that call's input. Reported
  // because a `contextMax` with no `contextUsed` beside it cannot draw a meter.
  const contextUsed = nonNegative(last.totalTokens) || input + cacheRead + output;

  return {
    tokens: {
      input,
      output,
      cacheRead,
      cacheCreate: nonNegative(last.cacheWriteInputTokens),
      ...(reasoning > 0 ? { reasoning } : {}),
    },
    ...(contextUsed > 0 ? { contextUsed } : {}),
    ...(contextMax !== undefined && contextMax > 0 ? { contextMax } : {}),
  };
}

/** `turn/plan/updated` → the plan row's steps. Codex's step statuses already
 *  use the contract's spelling; anything else is treated as not started. */
export function codexPlanDetail(params: Record<string, unknown>): ItemDetail | null {
  const raw = Array.isArray(params.plan) ? params.plan : null;
  if (!raw) return null;
  const steps = raw
    .map(record)
    .map((step) => ({
      step: str(step.step) ?? "",
      status: step.status === "inProgress" || step.status === "completed" ? step.status : ("pending" as const),
    }))
    .filter((step): step is { step: string; status: "pending" | "inProgress" | "completed" } => step.step.length > 0);
  return steps.length > 0 ? { type: "plan", plan: { steps } } : null;
}
