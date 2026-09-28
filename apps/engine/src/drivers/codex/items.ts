import { canonicalToolName, parseToolName, type ItemDetail, type ItemStatus, type RequestDetail, type RequestKind, type UsageSnapshot, UNKNOWN_PATH } from "@telar/engine-client";
import { requestKindForTool, titleForToolCall } from "../claude";

type CodexItem = Record<string, unknown>;

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function nonNegative(value: unknown): number {
  const n = int(value);
  return n !== undefined && n >= 0 ? n : 0;
}

function preview(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}

export function codexItemStatus(value: unknown, fallback: ItemStatus): ItemStatus {
  return value === "inProgress" || value === "completed" || value === "failed" || value === "declined"
    ? value
    : fallback;
}

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
      return "edit";
  }
}

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

// `userMessage` is dropped: the engine journals the prompt itself, and Codex's copy would be a second user row.
export function codexItemDetail(item: CodexItem): { detail: ItemDetail; title?: string } | null {
  const type = str(item.type) ?? "unknown";
  switch (type) {
    case "userMessage":
    case "hookPrompt":
      return null;

    case "agentMessage":
      return { detail: { type: "assistant_message", text: str(item.text) ?? "" } };

    case "reasoning":
      return { detail: { type: "reasoning", text: "" } };

    case "commandExecution": {
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
          path: str(first.path) ?? UNKNOWN_PATH,
          kind: fileChangeKind(first.kind),
        },
      };
      const path = detail.change.path === UNKNOWN_PATH ? "File change" : detail.change.path;
      const title = changes.length > 1 ? `${path} (+${changes.length - 1} more)` : path;
      return { detail, title };
    }

    case "mcpToolCall": {
      const server = str(item.server);
      const tool = str(item.tool) ?? "tool";
      const failure = str(record(item.error).message);
      const output = failure ?? (item.result === undefined ? undefined : item.result);
      const name = canonicalToolName(server, tool);
      const call = {
        name,
        ...(server ? { server } : {}),
        ...(item.arguments === undefined ? {} : { input: item.arguments }),
        ...(output === undefined ? {} : { output }),
        ...(str(item.id) ? { toolUseId: str(item.id)! } : {}),
      };
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

    case "contextCompaction":
      return { detail: { type: "context_compaction" }, title: "Context compacted" };

    default:
      return {
        detail: { type: "unknown", label: type, payload: item },
        title: type,
      };
  }
}

export function codexItemFailed(item: CodexItem, status: ItemStatus): boolean {
  return status === "failed" || item.success === false;
}

// Codex asks about MCP tools through an elicitation with `_meta.codex_approval_kind`, not an approval request.
export const MCP_ELICITATION = "mcpServer/elicitation/request";

export function codexApprovalRequest(
  method: string,
  params: Record<string, unknown>,
): { kind: RequestKind; detail: RequestDetail; toolUseId: string } | null {
  if (method === MCP_ELICITATION) return mcpToolApproval(params);
  const isFile = method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
  const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
  if (!isFile && !isCommand) return null;

  const toolUseId = str(params.itemId) ?? str(params.callId) ?? `${isFile ? "fileChange" : "command"}_${Date.now()}`;

  if (isCommand) {
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

  const changes: Record<string, unknown>[] = Array.isArray(params.changes)
    ? params.changes.map(record)
    : Object.entries(record(params.fileChanges)).map(([path, change]) => ({ ...record(change), path }));
  const first = changes[0] ?? {};
  return {
    kind: "file_change",
    detail: {
      kind: "file_change",
      change: { path: str(first.path) ?? str(params.path) ?? UNKNOWN_PATH, kind: fileChangeKind(first.kind) },
    },
    toolUseId,
  };
}

function mcpToolApproval(
  params: Record<string, unknown>,
): { kind: RequestKind; detail: RequestDetail; toolUseId: string } | null {
  const meta = record(params._meta);
  if (meta.codex_approval_kind !== "mcp_tool_call") return null;
  const server = str(params.serverName) ?? "mcp";
  const message = str(params.message) ?? "";
  const quoted = /"([^"]+)"/.exec(message)?.[1];
  const tool = quoted ?? message ?? "tool";
  const name = quoted ? canonicalToolName(server, quoted) : tool;
  const kind = requestKindForTool(name);
  return {
    kind,
    detail: {
      kind: "tool_call",
      call: {
        name,
        server,
        ...(meta.tool_params === undefined ? {} : { input: meta.tool_params }),
      },
    },
    toolUseId: `mcp_${server}_${str(params.turnId) ?? str(params.threadId) ?? "call"}`,
  };
}

// `last`, never `total`: `total` spans the whole thread, so a resumed session would bill earlier turns again.
export function codexUsage(params: Record<string, unknown>): UsageSnapshot | undefined {
  const usage = record(params.tokenUsage);
  const last = record(usage.last);
  if (Object.keys(last).length === 0) return undefined;

  const input = nonNegative(last.inputTokens);
  const output = nonNegative(last.outputTokens);
  const cacheRead = nonNegative(last.cachedInputTokens);
  const reasoning = nonNegative(last.reasoningOutputTokens);
  const contextMax = int(usage.modelContextWindow);
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
