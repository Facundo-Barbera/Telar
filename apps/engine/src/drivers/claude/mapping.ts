import crypto from "node:crypto";
import { displayToolName, isTelarMcpServer, parseToolName, TELAR_MCP_SERVER, UNKNOWN_PATH, type ItemDetail, type RequestDetail, type RequestKind } from "@telar/engine-client";

const TELAR_READ_TOOLS = new Set<string>(["display_open", "display_inline"]);

let telarPluginReadTools = new Set<string>();

export function setPluginReadTools(tools: Iterable<string>): void {
  telarPluginReadTools = new Set(tools);
}

export function requestKindForTool(name: string): RequestKind {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "command_execution";
  if (name === "Read" || name === "NotebookRead" || name === "Glob" || name === "Grep") return "file_read";
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "file_change";
  const parsed = parseToolName(name);
  // Only OUR servers' tools qualify — a user-configured server that happened to
  // name a tool `display_open` must not inherit the engine's own posture.
  if (isTelarMcpServer(parsed.server) && (TELAR_READ_TOOLS.has(parsed.tool) || telarPluginReadTools.has(parsed.tool))) {
    return "file_read";
  }
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

export const itemId = (): string => `item_${crypto.randomUUID().replaceAll("-", "")}`;

/** Trim a value for a collapsed row label without splitting a surrogate pair. */
export function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${[...flat].slice(0, max).join("")}…`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function contentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The input keys a file tool names its file by, in the order they are read. */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

function toolPath(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const path = str(args[key]);
    if (path) return path;
  }
  return undefined;
}

export function isFileTool(name: string): boolean {
  return ["Read", "NotebookRead", "Write", "Edit", "NotebookEdit", "MultiEdit"].includes(name);
}

export function pathFromPartialInput(json: string): string | undefined {
  for (const key of PATH_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(json);
    if (!match) continue;
    try {
      const path = str(JSON.parse(`"${match[1]}"`));
      if (path) return path;
    } catch {
      // A malformed escape: wait for the envelope rather than guess.
    }
  }
  return undefined;
}

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
        path: toolPath(args) ?? UNKNOWN_PATH,
        ...(typeof args.offset === "number" ? { fromLine: Math.max(1, args.offset) } : {}),
      },
    };
  }
  if (name === "Write" || name === "Edit" || name === "NotebookEdit" || name === "MultiEdit") {
    return {
      type: "file_change",
      change: {
        path: toolPath(args) ?? UNKNOWN_PATH,
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
    // No path yet is the tool's name, never the sentinel.
    case "file_read":
      return detail.read.path === UNKNOWN_PATH ? name : detail.read.path;
    case "file_change":
      return detail.change.path === UNKNOWN_PATH ? name : detail.change.path;
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
