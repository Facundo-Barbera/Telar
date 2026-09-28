import type { TokenUsage } from "@telar/engine-client";

export type UsageRecord = {
  at: number;
  model: string;
  tokens: TokenUsage;
  costUsd?: number;
  sessionId: string;
  dedupe?: string;
  cacheCreate1h?: number;
};

export const MTIME_SLACK_MS = 36 * 3_600_000;

export const WARM_WINDOW_MS = 90 * 86_400_000;

export const NL = 0x0a;

export function tokensOf(input: number, output: number, cacheRead: number, cacheCreate: number, reasoning?: number): TokenUsage {
  return {
    input: Math.max(0, Math.floor(input)),
    output: Math.max(0, Math.floor(output)),
    cacheRead: Math.max(0, Math.floor(cacheRead)),
    cacheCreate: Math.max(0, Math.floor(cacheCreate)),
    ...(reasoning !== undefined ? { reasoning: Math.max(0, Math.floor(reasoning)) } : {}),
  };
}

function candidateLines(buf: Buffer, from: number, to: number, needles: readonly Buffer[]): string[] {
  const starts = new Set<number>();
  for (const needle of needles) {
    let hit = buf.indexOf(needle, from);
    while (hit >= 0 && hit < to) {
      const previousBreak = buf.lastIndexOf(NL, hit);
      starts.add(previousBreak < from ? from : previousBreak + 1);
      const lineEnd = buf.indexOf(NL, hit);
      if (lineEnd < 0 || lineEnd >= to) break;
      hit = buf.indexOf(needle, lineEnd + 1);
    }
  }
  return [...starts]
    .sort((left, right) => left - right)
    .map((start) => {
      let end = buf.indexOf(NL, start);
      if (end < 0 || end > to) end = to;
      return buf.toString("utf8", start, end);
    });
}

const CLAUDE_NEEDLES = [Buffer.from('"usage"')];

export function parseClaudeLines(buf: Buffer, from: number, to: number, fallbackSession: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of candidateLines(buf, from, to, CLAUDE_NEEDLES)) {
    if (!line.includes('"assistant"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry["type"] !== "assistant") continue;
    const message = entry["message"];
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;
    const usage = m["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;
    const n = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
    const at = Date.parse(typeof entry["timestamp"] === "string" ? entry["timestamp"] : "");
    if (!Number.isFinite(at)) continue;
    const model = typeof m["model"] === "string" && m["model"] ? m["model"] : "unknown";
    const messageId = typeof m["id"] === "string" ? m["id"] : undefined;
    const requestId = typeof entry["requestId"] === "string" ? entry["requestId"] : undefined;
    const creation = u["cache_creation"];
    const oneHour =
      typeof creation === "object" && creation !== null && typeof (creation as Record<string, unknown>)["ephemeral_1h_input_tokens"] === "number"
        ? ((creation as Record<string, unknown>)["ephemeral_1h_input_tokens"] as number)
        : 0;
    records.push({
      ...(oneHour > 0 ? { cacheCreate1h: Math.floor(oneHour) } : {}),
      at,
      model,
      tokens: tokensOf(n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens")),
      ...(typeof entry["costUSD"] === "number" ? { costUsd: entry["costUSD"] as number } : {}),
      sessionId: typeof entry["sessionId"] === "string" ? (entry["sessionId"] as string) : fallbackSession,
      ...(messageId ? { dedupe: `${messageId}:${requestId ?? ""}` } : {}),
    });
  }
  return records;
}

export type CodexState = {
  model: string;
  sessionId: string;
  lastSignature: string;
  firstNamedModel?: string;
};

const CODEX_NEEDLES = [Buffer.from("token_count"), Buffer.from("turn_context"), Buffer.from("session_meta")];

export function parseCodexLines(buf: Buffer, from: number, to: number, state: CodexState): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of candidateLines(buf, from, to, CODEX_NEEDLES)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry["payload"];
    if (typeof payload !== "object" || payload === null) continue;
    const p = payload as Record<string, unknown>;
    if (entry["type"] === "session_meta" && typeof p["id"] === "string") {
      state.sessionId = p["id"];
      continue;
    }
    if (entry["type"] === "turn_context") {
      if (typeof p["model"] === "string" && p["model"]) {
        state.model = p["model"];
        state.firstNamedModel ??= state.model;
      }
      continue;
    }
    if (p["type"] !== "token_count") continue;
    const info = p["info"];
    if (typeof info !== "object" || info === null) continue;
    const last = (info as Record<string, unknown>)["last_token_usage"];
    if (typeof last !== "object" || last === null) continue;
    const u = last as Record<string, unknown>;
    const n = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
    const signature = `${n("input_tokens")}:${n("cached_input_tokens")}:${n("cache_write_input_tokens")}:${n("output_tokens")}`;
    if (signature === state.lastSignature) continue;
    state.lastSignature = signature;
    const at = Date.parse(typeof entry["timestamp"] === "string" ? entry["timestamp"] : "");
    if (!Number.isFinite(at)) continue;
    const output = n("output_tokens");
    records.push({
      at,
      model: state.model,
      tokens: tokensOf(
        n("input_tokens") - n("cached_input_tokens") - n("cache_write_input_tokens"),
        output,
        n("cached_input_tokens"),
        n("cache_write_input_tokens"),
        Math.min(output, n("reasoning_output_tokens")),
      ),
      sessionId: state.sessionId,
    });
  }
  return records;
}
