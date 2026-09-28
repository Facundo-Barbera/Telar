import fs from "node:fs";
import type { ItemDetail, ItemStatus, ProviderRefs } from "@telar/engine-client";
import { itemDetailForToolCall, titleForToolCall } from "./mapping";

export type ImportedRow = {
  detail: ItemDetail;
  title?: string;
  status: ItemStatus;
  startedAt: number;
  completedAt?: number;
  imported: true;
  providerRefs: ProviderRefs;
};

type TranscriptCut =
  | { kind: "whole"; }
  | { kind: "compact_boundary"; at: number; droppedTokens?: number }
  | { kind: "row_budget"; budget: number };

export type TranscriptImport = {
  rows: ImportedRow[];
  cut: TranscriptCut;
  priorSummary?: string;
  dropped: Record<string, number>;
  unparseable: number;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  lastActivityAt?: number;
  chainBrokeEarly: boolean;
};

type ReadOptions = {
  maxRows?: number;
  maxOutputChars?: number;
};

const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_OUTPUT_CHARS = 2_000;
const DEFAULT_MAX_TAIL_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

const CONVERSATION_TYPES = new Set(["user", "assistant", "system"]);

type Record_ = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number; cumulativeDroppedTokens?: number };
  toolUseResult?: unknown;
  [key: string]: unknown;
};

type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

function asBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

function millis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
}

function outputText(block: Block, limit: number): string | undefined {
  const raw = typeof block.content === "string" ? block.content : asBlocks(block.content).map((b) => b.text ?? "").join("");
  if (!raw) return undefined;
  return raw.length > limit ? `${raw.slice(0, limit)}\n… ${raw.length - limit} more characters in the transcript` : raw;
}

function slashCommand(text: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

function oneLine(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

type Drop = (what: string) => void;

type Walk = {
  chain: Record_[];
  cut: TranscriptCut;
  chainBrokeEarly: boolean;
  unparseable: number;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  lastActivityAt?: number;
};

// Walks the parent links back from the newest conversation record, stopping at a compact boundary or the row budget.
function walkChain(lines: readonly string[], maxRows: number, drop: Drop): Walk {
  let unparseable = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let lastActivityAt: number | undefined;

  let want: string | undefined;
  const chain: Record_[] = [];
  let cut: TranscriptCut = { kind: "whole" };
  let keptEstimate = 0;
  let sawLinkedRecord = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let record: Record_;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        unparseable += 1;
        continue;
      }
      record = parsed as Record_;
    } catch {
      unparseable += 1;
      continue;
    }

    const uuid = record.uuid;
    if (!uuid) {
      drop(record.type ?? "<untyped>");
      continue;
    }
    sawLinkedRecord = true;

    if (want === undefined) {
      if (record.isSidechain) {
        drop("sidechain");
        continue;
      }
      if (!CONVERSATION_TYPES.has(record.type ?? "")) {
        drop(record.type ?? "<untyped>");
        continue;
      }
      want = uuid;
    } else if (uuid !== want) {
      drop(record.isSidechain ? "sidechain" : "offPath");
      continue;
    }

    chain.push(record);
    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    gitBranch ??= record.gitBranch;
    const at = millis(record.timestamp);
    if (at !== undefined && (lastActivityAt === undefined || at > lastActivityAt)) lastActivityAt = at;

    if (record.type === "assistant") keptEstimate += asBlocks(record.message?.content).length;
    else if (record.type === "user" && !record.isMeta) keptEstimate += 1;

    if (record.subtype === "compact_boundary") {
      cut = {
        kind: "compact_boundary",
        at: at ?? 0,
        ...(typeof record.compactMetadata?.cumulativeDroppedTokens === "number"
          ? { droppedTokens: record.compactMetadata.cumulativeDroppedTokens }
          : {}),
      };
      break;
    }

    if (keptEstimate >= maxRows) {
      cut = { kind: "row_budget", budget: maxRows };
      break;
    }

    const parent = record.parentUuid ?? record.logicalParentUuid ?? undefined;
    if (!parent) {
      cut = { kind: "whole" };
      want = undefined;
      break;
    }
    want = parent;
  }

  const chainBrokeEarly = cut.kind === "whole" && sawLinkedRecord && (want !== undefined || chain.length === 0);
  chain.reverse();
  return { chain, cut, chainBrokeEarly, unparseable, sessionId, cwd, gitBranch, lastActivityAt };
}

function foldRows(chain: readonly Record_[], maxOutputChars: number, drop: Drop): { rows: ImportedRow[]; priorSummary?: string } {
  const results = new Map<string, { block: Block; at?: number }>();
  for (const record of chain) {
    if (record.type !== "user") continue;
    for (const block of asBlocks(record.message?.content)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, { block, at: millis(record.timestamp) });
      }
    }
  }

  const rows: ImportedRow[] = [];
  let priorSummary: string | undefined;

  const push = (record: Record_, detail: ItemDetail, extra: { title?: string; status?: ItemStatus; completedAt?: number } = {}) => {
    const startedAt = millis(record.timestamp) ?? 0;
    rows.push({
      detail,
      ...(extra.title ? { title: extra.title } : {}),
      status: extra.status ?? "completed",
      startedAt,
      ...(extra.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
      imported: true,
      providerRefs: {
        ...(record.uuid ? { itemId: record.uuid } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      },
    });
  };

  for (const record of chain) {
    if (record.subtype === "compact_boundary") {
      push(record, {
        type: "context_compaction",
        ...(record.compactMetadata?.trigger ? { reason: record.compactMetadata.trigger } : {}),
        ...(typeof record.compactMetadata?.preTokens === "number" ? { preTokens: record.compactMetadata.preTokens } : {}),
        ...(typeof record.compactMetadata?.postTokens === "number" ? { postTokens: record.compactMetadata.postTokens } : {}),
      }, { title: "Context compacted" });
      continue;
    }

    if (record.type === "user") {
      if (record.isCompactSummary) {
        const text = userText(record.message?.content);
        if (text) {
          priorSummary = text;
          push(record, { type: "unknown", label: "Summary of the earlier conversation", payload: { text } }, {
            title: "Summary of the earlier conversation",
          });
        }
        continue;
      }

      if (record.isMeta) {
        drop("meta");
        continue;
      }

      const blocks = asBlocks(record.message?.content);
      if (blocks.length > 0 && blocks.every((b) => b.type === "tool_result")) {
        continue;
      }

      const text = userText(record.message?.content);
      if (!text) {
        drop("emptyUser");
        continue;
      }
      const command = slashCommand(text);
      if (command) {
        push(record, { type: "user_message", text: command }, { title: command });
        continue;
      }
      push(record, { type: "user_message", text }, { title: oneLine(text) });
      continue;
    }

    if (record.type === "assistant") {
      for (const block of asBlocks(record.message?.content)) {
        if (block.type === "thinking") {
          const text = block.thinking ?? "";
          if (text.trim()) push(record, { type: "reasoning", text });
          continue;
        }
        if (block.type === "text") {
          const text = block.text ?? "";
          if (text.trim()) push(record, { type: "assistant_message", text }, { title: oneLine(text) });
          continue;
        }
        if (block.type === "tool_use" && block.name) {
          const detail = itemDetailForToolCall(block.name, block.input);
          const found = block.id ? results.get(block.id) : undefined;
          const output = found ? outputText(found.block, maxOutputChars) : undefined;
          const withOutput = attachOutput(detail, block, output);
          push(record, withOutput, {
            title: titleForToolCall(block.name, detail),
            status: found?.block.is_error ? "failed" : "completed",
            ...(found?.at !== undefined ? { completedAt: found.at } : {}),
          });
          continue;
        }
        drop(`assistant:${block.type ?? "<untyped>"}`);
      }
      continue;
    }

    drop(record.type ?? "<untyped>");
  }

  return { rows, ...(priorSummary ? { priorSummary } : {}) };
}

export function readClaudeTranscript(lines: readonly string[], options: ReadOptions = {}): TranscriptImport {
  const dropped: Record<string, number> = {};
  const drop: Drop = (what) => {
    dropped[what] = (dropped[what] ?? 0) + 1;
  };
  const walk = walkChain(lines, options.maxRows ?? DEFAULT_MAX_ROWS, drop);
  const { rows, priorSummary } = foldRows(walk.chain, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, drop);
  return {
    rows,
    cut: walk.cut,
    ...(priorSummary ? { priorSummary } : {}),
    dropped,
    unparseable: walk.unparseable,
    ...(walk.sessionId ? { sessionId: walk.sessionId } : {}),
    ...(walk.cwd ? { cwd: walk.cwd } : {}),
    ...(walk.gitBranch ? { gitBranch: walk.gitBranch } : {}),
    ...(walk.lastActivityAt !== undefined ? { lastActivityAt: walk.lastActivityAt } : {}),
    chainBrokeEarly: walk.chainBrokeEarly,
  };
}

function attachOutput(detail: ItemDetail, block: Block, output: string | undefined): ItemDetail {
  if (output === undefined) return detail;
  switch (detail.type) {
    case "command_execution":
      return { ...detail, command: { ...detail.command, outputPreview: output } };
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "browser_action":
      return { ...detail, call: { ...detail.call, output, ...(block.id ? { toolUseId: block.id } : {}) } };
    default:
      return detail;
  }
}

export function readClaudeTranscriptFile(
  filePath: string,
  options: ReadOptions & { maxTailBytes?: number } = {},
): TranscriptImport {
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const handle = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const from = Math.max(0, size - maxTailBytes);
    const buffer = Buffer.allocUnsafe(size - from);
    fs.readSync(handle, buffer, 0, buffer.length, from);
    const start = from === 0 ? 0 : buffer.indexOf(NEWLINE) + 1;
    const text = buffer.toString("utf8", start <= 0 ? 0 : start);
    return readClaudeTranscript(text.split("\n"), options);
  } finally {
    fs.closeSync(handle);
  }
}

export function describeImport(result: TranscriptImport): string {
  const rows = result.rows.length;
  const plural = rows === 1 ? "row" : "rows";
  switch (result.cut.kind) {
    case "compact_boundary":
      return `Imported the ${rows} ${plural} since this conversation last compacted its context${
        result.priorSummary ? ", with Claude's own summary of what came before" : ""
      }.`;
    case "row_budget":
      return `Imported the most recent ${rows} ${plural} of this conversation. Earlier turns stayed in Claude Code.`;
    case "whole":
      return result.chainBrokeEarly
        ? `Imported ${rows} ${plural}. The transcript did not reach the start of the conversation.`
        : `Imported this conversation in full — ${rows} ${plural}.`;
  }
}
