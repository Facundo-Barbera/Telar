import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { UsageLogAttribution, UsageLogBucket } from "@telar/engine-client";
import { parseClaudeLines } from "./log-parse";
import { priceTokens, type RatesTable } from "./pricing";

const TELAR_MARKERS = ['"mcp__telar__', '"mcp__telar-browser__', "running inside Telar, an agent cockpit", "[agent message · "].map((marker) => Buffer.from(marker));

export type AttributionInput = {
  logsRoot: string;
  sinceMs: number;
  rates: RatesTable;
  storeSessions: ReadonlySet<string>;
  storeFolders: readonly string[];
  telarFolders: readonly string[];
};

export type AttributedTranscript = { file: string; bucket: UsageLogBucket; cwd?: string; model: string; tokens: number; costUsd: number };

const inside = (folder: string, cwd: string): boolean => cwd === folder || cwd.startsWith(`${folder}${path.sep}`);

function cwdOf(buffer: Buffer): string | undefined {
  const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, Math.min(buffer.length, 200_000)).toString("utf8"));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function bucketOf(input: Pick<AttributionInput, "storeSessions" | "storeFolders" | "telarFolders">, transcript: { sessionIds: string[]; cwd?: string; marked: boolean }): UsageLogBucket {
  const { cwd } = transcript;
  if (transcript.sessionIds.some((id) => input.storeSessions.has(id))) return "store";
  if (cwd && input.storeFolders.some((folder) => inside(folder, cwd))) return "store";
  if (transcript.marked) return "telar";
  if (cwd && (input.telarFolders.some((folder) => inside(folder, cwd)) || cwd.split(path.sep).includes("worktrees"))) return "telar";
  return "outside";
}

async function* transcripts(root: string, sinceMs: number): AsyncGenerator<string> {
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
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await fs.promises.stat(full).catch(() => undefined);
        if (stat && stat.mtimeMs >= sinceMs) yield full;
      }
    }
  }
}

export async function attributeClaudeLogs(input: AttributionInput): Promise<AttributedTranscript[]> {
  const out: AttributedTranscript[] = [];
  const seen = new Set<string>();
  for await (const file of transcripts(input.logsRoot, input.sinceMs)) {
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(file);
    } catch {
      continue;
    }
    const records = parseClaudeLines(buffer, 0, buffer.length, path.basename(file, ".jsonl")).filter((record) => {
      if (record.at < input.sinceMs) return false;
      if (!record.dedupe) return true;
      if (seen.has(record.dedupe)) return false;
      seen.add(record.dedupe);
      return true;
    });
    await yieldImmediate();
    if (records.length === 0) continue;
    const cwd = cwdOf(buffer);
    const bucket = bucketOf(input, { sessionIds: [...new Set(records.map((record) => record.sessionId))], ...(cwd ? { cwd } : {}), marked: TELAR_MARKERS.some((marker) => buffer.includes(marker)) });
    const byModel = new Map<string, { tokens: number; costUsd: number }>();
    for (const record of records) {
      const entry = byModel.get(record.model) ?? { tokens: 0, costUsd: 0 };
      entry.tokens += record.tokens.input + record.tokens.output + record.tokens.cacheRead + record.tokens.cacheCreate;
      entry.costUsd += record.costUsd ?? priceTokens(input.rates, record.model, record.tokens, record.cacheCreate1h !== undefined ? { cacheCreate1h: record.cacheCreate1h } : {}) ?? 0;
      byModel.set(record.model, entry);
    }
    for (const [model, entry] of byModel) out.push({ file, bucket, ...(cwd ? { cwd } : {}), model, ...entry });
  }
  return out;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function summarizeAttribution(rows: readonly AttributedTranscript[], label: (cwd: string | undefined) => string): UsageLogAttribution {
  const buckets: UsageLogAttribution["buckets"] = { store: { tokens: 0, costUsd: 0, transcripts: 0 }, telar: { tokens: 0, costUsd: 0, transcripts: 0 }, outside: { tokens: 0, costUsd: 0, transcripts: 0 } };
  const files = { store: new Set<string>(), telar: new Set<string>(), outside: new Set<string>() };
  const projects = new Map<string, UsageLogAttribution["projects"][number]>();
  const models = new Map<string, { model: string; tokens: number; costUsd: number }>();
  for (const row of rows) {
    buckets[row.bucket].tokens += row.tokens;
    buckets[row.bucket].costUsd += row.costUsd;
    files[row.bucket].add(row.file);
    const id = label(row.cwd);
    const project = projects.get(`${id}:${row.bucket}`) ?? { id, bucket: row.bucket, tokens: 0, costUsd: 0, models: {} };
    project.tokens += row.tokens;
    project.costUsd += row.costUsd;
    project.models[row.model] = (project.models[row.model] ?? 0) + row.tokens;
    projects.set(`${id}:${row.bucket}`, project);
    const model = models.get(row.model) ?? { model: row.model, tokens: 0, costUsd: 0 };
    model.tokens += row.tokens;
    model.costUsd += row.costUsd;
    models.set(row.model, model);
  }
  for (const bucket of Object.keys(buckets) as UsageLogBucket[]) {
    buckets[bucket].transcripts = files[bucket].size;
    buckets[bucket].costUsd = round(buckets[bucket].costUsd);
  }
  const telarLike = buckets.store.tokens + buckets.telar.tokens;
  return {
    buckets,
    storeCoverage: telarLike === 0 ? 1 : Math.round((buckets.store.tokens / telarLike) * 1000) / 1000,
    projects: [...projects.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10).map((project) => ({ ...project, costUsd: round(project.costUsd) })),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8).map((model) => ({ ...model, costUsd: round(model.costUsd) })),
  };
}
