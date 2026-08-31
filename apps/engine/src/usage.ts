/**
 * The usage report — spend over time, scanned from the provider CLIs' own
 * transcripts. t3 code's architecture (itself modeled on ccusage), adopted
 * over folding Telar's journals because the transcripts know two things the
 * journals never will: WHICH model a default-riding turn actually ran, and
 * everything this machine spent OUTSIDE Telar. Telar's own turns land in the
 * same directories, so one source counts everything exactly once.
 *
 * Verified against the real files on disk, not the docs:
 *
 *   Claude — `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, one record
 *   per assistant message: `{type:"assistant", timestamp, sessionId,
 *   requestId, costUSD, message:{id, model, usage:{input_tokens,
 *   cache_read_input_tokens, cache_creation_input_tokens, output_tokens}}}`.
 *   `input_tokens` already EXCLUDES cache reads. `costUSD` is null on
 *   subscription plans. Dedupe by `messageId:requestId` (a resumed session
 *   copies its parent's history into a new file).
 *
 *   Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`:
 *   `{type:"event_msg", payload:{type:"token_count", info:{last_token_usage:
 *   {input_tokens, cached_input_tokens, cache_write_input_tokens,
 *   output_tokens, reasoning_output_tokens}}}}` — `input_tokens` INCLUDES the
 *   cached and cache-write figures, so uncached input is the difference. The
 *   model rides separately on `turn_context` records and is carried forward.
 *   Consecutive identical usage payloads are re-emissions, not new spend.
 *
 * Cost: the transcript's own figure when present, else the LiteLLM rate
 * table (usage-pricing.ts), else absent — never guessed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderDriverKind, TokenUsage, UsageBucket, UsageReport, UsageResolution, UsageSource } from "@telar/engine-client";
import { loadRates, priceTokens, type RatesTable } from "./usage-pricing";

export type UsageRecord = {
  at: number;
  model: string;
  tokens: TokenUsage;
  costUsd?: number;
  sessionId: string;
  /** Cross-file dedupe key; undefined means "trust the file order dedupe". */
  dedupe?: string;
};

/**
 * Files whose mtime predates the window by more than this cannot contain
 * records inside it — minus clock skew and long sessions, hence the generous
 * slack (t3 code's own figure). This is what keeps a 90-day scan from
 * re-reading a year of transcripts.
 */
const MTIME_SLACK_MS = 36 * 3_600_000;

/** Per-file parse results memoised by (size, mtime) — transcripts append. */
const scanCache = new Map<string, { size: number; mtimeMs: number; records: UsageRecord[] }>();

function tokensOf(input: number, output: number, cacheRead: number, cacheCreate: number, reasoning?: number): TokenUsage {
  return {
    input: Math.max(0, Math.floor(input)),
    output: Math.max(0, Math.floor(output)),
    cacheRead: Math.max(0, Math.floor(cacheRead)),
    cacheCreate: Math.max(0, Math.floor(cacheCreate)),
    ...(reasoning !== undefined ? { reasoning: Math.max(0, Math.floor(reasoning)) } : {}),
  };
}

function parseClaudeFile(text: string, fallbackSession: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    // The cheap gate before JSON.parse — most lines are content, not usage.
    if (!line.includes('"assistant"') || !line.includes("usage")) continue;
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
    records.push({
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

function parseCodexFile(text: string, fallbackSession: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  let model = "unknown";
  let sessionId = fallbackSession;
  let lastSignature = "";
  for (const line of text.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context") && !line.includes("session_meta")) continue;
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
      sessionId = p["id"];
      continue;
    }
    if (entry["type"] === "turn_context") {
      if (typeof p["model"] === "string" && p["model"]) model = p["model"];
      continue;
    }
    if (p["type"] !== "token_count") continue;
    const info = p["info"];
    if (typeof info !== "object" || info === null) continue;
    const last = (info as Record<string, unknown>)["last_token_usage"];
    if (typeof last !== "object" || last === null) continue;
    const u = last as Record<string, unknown>;
    const n = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
    // The same figures re-stamped are a UI refresh, not new spend.
    const signature = `${n("input_tokens")}:${n("cached_input_tokens")}:${n("cache_write_input_tokens")}:${n("output_tokens")}`;
    if (signature === lastSignature) continue;
    lastSignature = signature;
    const at = Date.parse(typeof entry["timestamp"] === "string" ? entry["timestamp"] : "");
    if (!Number.isFinite(at)) continue;
    const output = n("output_tokens");
    records.push({
      at,
      model,
      tokens: tokensOf(
        n("input_tokens") - n("cached_input_tokens") - n("cache_write_input_tokens"),
        output,
        n("cached_input_tokens"),
        n("cache_write_input_tokens"),
        Math.min(output, n("reasoning_output_tokens")),
      ),
      sessionId,
    });
  }
  return records;
}

function scanFile(file: string, provider: ProviderDriverKind, sinceMs: number): UsageRecord[] | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (stat.mtimeMs < sinceMs - MTIME_SLACK_MS) return [];
  const cached = scanCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.records;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const fallbackSession = path.basename(file, ".jsonl");
  const records = provider === "claude" ? parseClaudeFile(text, fallbackSession) : parseCodexFile(text, fallbackSession);
  scanCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, records });
  return records;
}

function* walkJsonl(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
    }
  }
}

export type UsageScanRoots = {
  claude: string;
  codex: string;
};

/** Where each CLI keeps its transcripts, honouring the same env vars the
 *  CLIs themselves read. */
export function defaultScanRoots(env: NodeJS.ProcessEnv = process.env): UsageScanRoots {
  const home = os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return { claude: path.join(claudeHome, "projects"), codex: path.join(codexHome, "sessions") };
}

/** `YYYY-MM-DD` in the requested zone. `en-CA` is the locale whose short date
 *  IS that shape — the same trick t3 code uses. */
function dayOf(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  }
}

const HOUR_MS = 3_600_000;

export async function readUsageReport(
  input: { sinceMs: number; untilMs: number; resolution: UsageResolution; timeZone: string },
  options: {
    roots?: UsageScanRoots;
    /** Where the rates snapshot lives — the engine state root. */
    ratesCachePath: string;
    /** Test seam; the default fetches LiteLLM's table. */
    loadRatesTable?: () => Promise<RatesTable>;
  },
): Promise<UsageReport> {
  const roots = options.roots ?? defaultScanRoots();
  const rates = await (options.loadRatesTable ?? (() => loadRates(options.ratesCachePath)))();

  const buckets = new Map<string, UsageBucket & { allPriced: boolean }>();
  const sessions = new Set<string>();
  const seen = new Set<string>();
  const sources: UsageSource[] = [];

  for (const provider of ["claude", "codex"] as const) {
    const root = roots[provider];
    if (!fs.existsSync(root)) {
      sources.push({ provider, status: "missing", path: root, files: 0, sessions: 0 });
      continue;
    }
    let files = 0;
    let failed = false;
    const providerSessions = new Set<string>();
    for (const file of walkJsonl(root)) {
      const records = scanFile(file, provider, input.sinceMs);
      if (records === undefined) {
        failed = true;
        continue;
      }
      if (records.length > 0) files += 1;
      for (const record of records) {
        if (record.at < input.sinceMs || record.at >= input.untilMs) continue;
        if (record.dedupe) {
          const key = `${provider}:${record.dedupe}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        providerSessions.add(record.sessionId);
        sessions.add(`${provider}:${record.sessionId}`);

        const period = input.resolution === "hour" ? String(Math.floor(record.at / HOUR_MS) * HOUR_MS) : dayOf(record.at, input.timeZone);
        const key = `${period}\0${provider}\0${record.model}`;
        const bucket = buckets.get(key) ?? {
          period,
          driver: provider,
          model: record.model,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
          costUsd: 0,
          priced: true,
          allPriced: true,
          turns: 0,
        };
        bucket.tokens.input += record.tokens.input;
        bucket.tokens.output += record.tokens.output;
        bucket.tokens.cacheRead += record.tokens.cacheRead;
        bucket.tokens.cacheCreate += record.tokens.cacheCreate;
        if (record.tokens.reasoning !== undefined) {
          bucket.tokens.reasoning = (bucket.tokens.reasoning ?? 0) + record.tokens.reasoning;
        }
        const cost = record.costUsd ?? priceTokens(rates, record.model, record.tokens);
        bucket.costUsd += cost ?? 0;
        bucket.allPriced = bucket.allPriced && cost !== undefined;
        bucket.turns += 1;
        buckets.set(key, bucket);
      }
    }
    sources.push({ provider, status: failed ? "failed" : "ok", path: root, files, sessions: providerSessions.size });
  }

  return {
    sinceMs: input.sinceMs,
    untilMs: input.untilMs,
    resolution: input.resolution,
    timeZone: input.timeZone,
    buckets: [...buckets.values()]
      .map(({ allPriced, ...bucket }) => ({ ...bucket, priced: allPriced }))
      .sort((left, right) => left.period.localeCompare(right.period) || left.driver.localeCompare(right.driver) || left.model.localeCompare(right.model)),
    sources,
    pricing: rates.status,
    sessions: sessions.size,
    readAt: Date.now(),
  };
}
