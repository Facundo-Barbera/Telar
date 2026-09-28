import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { ProviderDriverKind, UsageBucket, UsageReport, UsageResolution, UsageSource } from "@telar/engine-client";
import { loadRates, priceTokens, type RatesTable } from ".";
import { type CodexState, MTIME_SLACK_MS, NL, parseClaudeLines, parseCodexLines, type UsageRecord, WARM_WINDOW_MS } from "./log-parse";
import { cacheFor, UsageScanCache } from "./scan-cache";

async function readRange(file: string, from: number, to: number): Promise<Buffer> {
  if (from === 0) return fs.promises.readFile(file);
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, to - from));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, from + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

async function scanFile(file: string, provider: ProviderDriverKind, sinceMs: number, cache: UsageScanCache): Promise<{ records: UsageRecord[]; read: boolean } | undefined> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return undefined;
  }
  if (stat.mtimeMs < sinceMs - MTIME_SLACK_MS) return { records: [], read: false };
  const cached = cache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { records: cached.tail.length ? [...cached.records, ...cached.tail] : cached.records, read: false };
  }
  const resume = cached && stat.size > cached.size ? cached : undefined;
  const from = resume?.offset ?? 0;
  let buf: Buffer;
  try {
    buf = await readRange(file, from, stat.size);
  } catch {
    return undefined;
  }
  const fallbackSession = path.basename(file, ".jsonl");
  const committed = buf.lastIndexOf(NL) + 1;
  let records: UsageRecord[];
  let tail: UsageRecord[];
  let codex: CodexState | undefined;
  if (provider === "claude") {
    const fresh = parseClaudeLines(buf, 0, committed, fallbackSession);
    records = resume ? [...resume.records, ...fresh] : fresh;
    tail = parseClaudeLines(buf, committed, buf.length, fallbackSession);
  } else {
    codex = resume?.codex ? { ...resume.codex } : { model: "unknown", sessionId: fallbackSession, lastSignature: "" };
    const fresh = parseCodexLines(buf, 0, committed, codex);
    records = resume ? [...resume.records, ...fresh] : fresh;
    tail = parseCodexLines(buf, committed, buf.length, { ...codex });
    if (codex.firstNamedModel) {
      for (const record of records) if (record.model === "unknown") record.model = codex.firstNamedModel;
      for (const record of tail) if (record.model === "unknown") record.model = codex.firstNamedModel;
    }
  }
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, offset: from + committed, records, tail, ...(codex ? { codex } : {}) });
  return { records: tail.length ? [...records, ...tail] : records, read: true };
}

async function* walkJsonl(root: string): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
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
  codexArchive?: string;
};

function defaultScanRoots(env: NodeJS.ProcessEnv = process.env): UsageScanRoots {
  const home = os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return {
    claude: path.join(claudeHome, "projects"),
    codex: path.join(codexHome, "sessions"),
    codexArchive: path.join(codexHome, "archived_sessions"),
  };
}

type ProviderScan = {
  records: UsageRecord[];
  files: number;
  failed: boolean;
};

async function scanProvider(
  provider: ProviderDriverKind,
  roots: readonly string[],
  sinceMs: number,
  cache: UsageScanCache,
  visited: Set<string>,
): Promise<ProviderScan> {
  const records: UsageRecord[] = [];
  let files = 0;
  let failed = false;
  let walked = 0;
  for (const root of roots) {
    for await (const file of walkJsonl(root)) {
      visited.add(file);
      walked += 1;
      const scanned = await scanFile(file, provider, sinceMs, cache);
      if (scanned === undefined) {
        failed = true;
        continue;
      }
      if (scanned.read || walked % 64 === 0) await yieldImmediate();
      if (scanned.records.length > 0) files += 1;
      for (const record of scanned.records) records.push(record);
    }
  }
  return { records, files, failed };
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
}

const HOUR_MS = 3_600_000;

const reportMemo = new Map<string, { at: number; report: UsageReport }>();
const REPORT_MEMO_TTL_MS = 60_000;

export type UsageScanOptions = {
  roots?: UsageScanRoots;
  ratesCachePath: string;
  scanCachePath?: string;
  loadRatesTable?: () => Promise<RatesTable>;
  memo?: boolean;
};

function providerRoots(roots: UsageScanRoots): [ProviderDriverKind, string[]][] {
  return [
    ["claude", [roots.claude]],
    ["codex", [roots.codex, ...(roots.codexArchive ? [roots.codexArchive] : [])]],
  ];
}

export async function readUsageReport(
  input: { sinceMs: number; untilMs: number; resolution: UsageResolution; timeZone: string },
  options: UsageScanOptions,
): Promise<UsageReport> {
  const memoKey = [
    input.resolution,
    input.timeZone,
    Math.round(input.sinceMs / 60_000),
    Math.round(input.untilMs / 60_000),
  ].join("\0");
  if (options.memo !== false) {
    const memo = reportMemo.get(memoKey);
    if (memo && Date.now() - memo.at < REPORT_MEMO_TTL_MS) return memo.report;
  }
  const roots = options.roots ?? defaultScanRoots();
  const cache = cacheFor(options.scanCachePath);
  const [rates] = await Promise.all([(options.loadRatesTable ?? (() => loadRates(options.ratesCachePath)))(), cache.load()]);

  const calendar = input.resolution === "day" ? dayFormatter(input.timeZone) : undefined;
  const buckets = new Map<string, UsageBucket & { allPriced: boolean }>();
  const sessions = new Set<string>();
  const seen = new Set<string>();
  const sources: UsageSource[] = [];
  const visited = new Set<string>();

  for (const [provider, candidates] of providerRoots(roots)) {
    const present = candidates.filter((candidate) => fs.existsSync(candidate));
    if (!present.includes(candidates[0]!)) {
      sources.push({ provider, status: "missing", path: candidates[0]!, files: 0, sessions: 0 });
      continue;
    }
    const scan = await scanProvider(provider, present, input.sinceMs, cache, visited);
    const providerSessions = new Set<string>();
    for (const record of scan.records) {
      if (record.at < input.sinceMs || record.at >= input.untilMs) continue;
      if (record.dedupe) {
        const key = `${provider}:${record.dedupe}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      providerSessions.add(record.sessionId);
      sessions.add(`${provider}:${record.sessionId}`);

      const period = input.resolution === "hour" ? String(Math.floor(record.at / HOUR_MS) * HOUR_MS) : calendar!.format(record.at);
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
      const cost =
        record.costUsd ??
        priceTokens(rates, record.model, record.tokens, record.cacheCreate1h !== undefined ? { cacheCreate1h: record.cacheCreate1h } : {});
      bucket.costUsd += cost ?? 0;
      bucket.allPriced = bucket.allPriced && cost !== undefined;
      bucket.turns += 1;
      buckets.set(key, bucket);
    }
    sources.push({ provider, status: scan.failed ? "failed" : "ok", path: candidates[0]!, files: scan.files, sessions: providerSessions.size });
  }

  const report: UsageReport = {
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
  if (options.memo !== false) {
    reportMemo.set(memoKey, { at: Date.now(), report });
    if (reportMemo.size > 8) {
      const oldest = [...reportMemo.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) reportMemo.delete(oldest[0]);
    }
  }
  void cache.save(visited);
  return report;
}

export async function warmUsageScanCache(options: { roots?: UsageScanRoots; scanCachePath: string; now?: () => number }): Promise<void> {
  const roots = options.roots ?? defaultScanRoots();
  const cache = cacheFor(options.scanCachePath);
  await cache.load();
  const sinceMs = (options.now ?? Date.now)() - WARM_WINDOW_MS;
  const visited = new Set<string>();
  for (const [provider, candidates] of providerRoots(roots)) {
    const present = candidates.filter((candidate) => fs.existsSync(candidate));
    if (!present.includes(candidates[0]!)) continue;
    await scanProvider(provider, present, sinceMs, cache, visited);
  }
  await cache.save(visited);
}
