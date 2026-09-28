import path from "node:path";
import { fileURLToPath } from "node:url";
import { orient, viewportPreset } from "../../../../desktop/src/browser/viewport-presets.js";
import { BROWSER_DEFAULT_VIEWPORT, BROWSER_TOOL_NAMES, type BrowserToolResult } from "./tools";

export type BrowserTabInfo = {
  index: number;
  title: string;
  url: string;
  active: boolean;
  agentFocus?: boolean;
  profileId?: string;
  profileLabel?: string;
  tabUid?: string;
};

const READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
]);

type BrowserCall = { name: string; args: Record<string, unknown> };

function defined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

export function browserOperation(name: string, args: Record<string, unknown>): BrowserCall {
  const { tabId } = args;
  switch (name) {
    case "browser_tabs":
      return { name, args: { ...args, action: args.action ?? "list" } };
    case "browser_navigate":
      return args.url === "back" ? { name: "browser_navigate_back", args: defined({ tabId }) } : { name, args };
    case "browser_snapshot": {
      const { screenshot, type, fullPage, scale, ...snapshot } = args;
      if (screenshot !== true) return { name, args: snapshot };
      return { name: "browser_take_screenshot", args: defined({ type, fullPage, scale, tabId }) };
    }
    case "browser_logs":
      return args.kind === "network"
        ? { name: "browser_network_requests", args: defined({ static: args.static, filter: args.filter, tabId }) }
        : { name: "browser_console_messages", args: defined({ level: args.level, all: args.all, tabId }) };
    case "browser_type": {
      const { key, ...typed } = args;
      return key === undefined ? { name, args: typed } : { name: "browser_press_key", args: defined({ key, tabId }) };
    }
    default:
      return { name, args };
  }
}

export function headlessBrowserToolCall(name: string, args: Record<string, unknown>): BrowserCall {
  if (name !== "browser_resize") return { name, args };
  const { preset, mode, orientation, ...rest } = args;
  const turn = orientation === "portrait" || orientation === "landscape" ? orientation : undefined;
  let size: { width: unknown; height: unknown } | undefined;
  const entry = typeof preset === "string" ? viewportPreset(preset) : undefined;
  if (entry) size = { width: entry.width, height: entry.height };
  else if (rest.width !== undefined || rest.height !== undefined) {
    size = { width: rest.width ?? BROWSER_DEFAULT_VIEWPORT.width, height: rest.height ?? BROWSER_DEFAULT_VIEWPORT.height };
  } else if (typeof mode === "string" || turn) size = { ...BROWSER_DEFAULT_VIEWPORT };
  const leftover = {
    ...rest,
    ...(preset !== undefined && !entry ? { preset } : {}),
    ...(orientation !== undefined && !turn ? { orientation } : {}),
  };
  if (!size) return { name, args: leftover };
  if (turn && typeof size.width === "number" && typeof size.height === "number") {
    size = orient({ width: size.width, height: size.height }, turn);
  }
  return { name, args: { ...leftover, ...size } };
}

export function isReadOnlyBrowserCall(name: string, args: Record<string, unknown> = {}): boolean {
  if (!BROWSER_TOOL_NAMES.has(name)) return false;
  const operation = browserOperation(name, args);
  if (operation.name === "browser_tabs") return operation.args.action === "list";
  return READ_ONLY_OPERATIONS.has(operation.name);
}

export function fileUrlViolation(name: string, args: Record<string, unknown>, workspaceRoot?: string): string | null {
  const raw =
    name === "browser_navigate" || (name === "browser_tabs" && args.action === "new")
      ? args.url
      : undefined;
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  if (!workspaceRoot) return "The integrated browser cannot open file URLs in this session.";
  let target: string;
  try {
    target = fileURLToPath(parsed);
  } catch {
    return "That file URL does not name a local path this machine can read.";
  }
  const resolved = path.resolve(target);
  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    return `The integrated browser opens local files only inside this session's checkout (${workspaceRoot}).`;
  }
  return null;
}

export function browserErrorText(value: unknown): string {
  return String(value)
    .replace(/^\s*#{1,6}\s*Error\s*/i, "")
    .replace(/^\s*Error:\s*/i, "")
    .trim();
}

export function isBrowserNotInstalled(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    (lowered.includes("is not installed") || lowered.includes("install-browser") || lowered.includes("executable doesn't exist")) &&
    lowered.includes("brows")
  );
}

export function textOf(result: BrowserToolResult): string {
  const chunks: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("\n");
}

export function imageDataUrlOf(result: BrowserToolResult): string | null {
  for (const part of result.content) {
    if (part.type !== "image" || typeof part.data !== "string") continue;
    const mimeType = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image/jpeg";
    return `data:${mimeType};base64,${part.data}`;
  }
  return null;
}

function tabUidFromMeta(meta: string): { tabUid?: string } {
  const uid = /(?:^|,)\s*tab=([^,\s}]+)/i.exec(meta)?.[1];
  return uid ? { tabUid: uid } : {};
}

function profileFromMeta(meta: string): { profileId?: string; profileLabel?: string } {
  const id = /(?:^|,)\s*profile=([^,\s}]+)/i.exec(meta)?.[1];
  if (!id) return {};
  const rawLabel = /(?:^|,)\s*profile-label=([^,\s}]*)/i.exec(meta)?.[1];
  let label: string | undefined;
  if (rawLabel) {
    try {
      label = decodeURIComponent(rawLabel);
    } catch {
      label = undefined;
    }
  }
  return { profileId: id, ...(label ? { profileLabel: label } : {}) };
}

export function parseBrowserTabs(text: string): BrowserTabInfo[] {
  const tabs: BrowserTabInfo[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*[-*]?\s*(?:Tab\s+)?(\d+)\s*[:.]\s*(\((?:current|active)\)\s*)?(?:\[([^\]]*)\]\(([^)]+)\)|(.+?)\s+-\s+(https?:\/\/\S+|about:blank))\s*(\[(?:current|active)\]|\((?:current|active)\))?\s*(?:\[crashed\])?\s*(?:\{([^}]*)\})?\s*$/i,
    );
    if (!match) continue;
    const index = Number(match[1]);
    const title = (match[3] ?? match[5] ?? `Tab ${index + 1}`).trim();
    const url = (match[4] ?? match[6] ?? "about:blank").trim();
    const meta = match[8] ?? "";
    tabs.push({
      index,
      title: title.replace(/\s*\((?:current|active)\)\s*$/i, "") || `Tab ${index + 1}`,
      url,
      active: Boolean(match[2] || match[7]),
      ...(/(^|,)\s*yours\s*(,|$)/i.test(meta) ? { agentFocus: true } : {}),
      ...tabUidFromMeta(meta),
      ...profileFromMeta(meta),
    });
  }
  return tabs;
}
