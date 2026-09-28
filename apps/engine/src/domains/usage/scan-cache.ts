import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { type CodexState, MTIME_SLACK_MS, tokensOf, type UsageRecord, WARM_WINDOW_MS } from "./log-parse";

type FileEntry = {
  size: number;
  mtimeMs: number;
  offset: number;
  records: UsageRecord[];
  tail: UsageRecord[];
  codex?: CodexState;
};

type StoredRecord = [
  at: number,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
  sessionId: string,
  dedupe: string | null,
  costUsd: number | null,
  reasoning: number | null,
  cacheCreate1h: number | null,
];

type StoredEntry = Omit<FileEntry, "records" | "tail"> & { records: StoredRecord[]; tail: StoredRecord[] };

const SCAN_CACHE_VERSION = 1;

function packRecord(record: UsageRecord): StoredRecord {
  return [
    record.at,
    record.model,
    record.tokens.input,
    record.tokens.output,
    record.tokens.cacheRead,
    record.tokens.cacheCreate,
    record.sessionId,
    record.dedupe ?? null,
    record.costUsd ?? null,
    record.tokens.reasoning ?? null,
    record.cacheCreate1h ?? null,
  ];
}

function unpackRecord(stored: unknown): UsageRecord | undefined {
  if (!Array.isArray(stored) || stored.length < 7) return undefined;
  const [at, model, input, output, cacheRead, cacheCreate, sessionId, dedupe, costUsd, reasoning, cacheCreate1h] = stored as unknown[];
  if (typeof at !== "number" || typeof model !== "string" || typeof sessionId !== "string") return undefined;
  if ([input, output, cacheRead, cacheCreate].some((value) => typeof value !== "number")) return undefined;
  return {
    at,
    model,
    tokens: tokensOf(input as number, output as number, cacheRead as number, cacheCreate as number, typeof reasoning === "number" ? reasoning : undefined),
    sessionId,
    ...(typeof dedupe === "string" ? { dedupe } : {}),
    ...(typeof costUsd === "number" ? { costUsd } : {}),
    ...(typeof cacheCreate1h === "number" ? { cacheCreate1h } : {}),
  };
}

function unpackEntry(stored: unknown): FileEntry | undefined {
  if (typeof stored !== "object" || stored === null) return undefined;
  const e = stored as Partial<StoredEntry>;
  if (typeof e.size !== "number" || typeof e.mtimeMs !== "number" || typeof e.offset !== "number") return undefined;
  if (!Array.isArray(e.records) || !Array.isArray(e.tail)) return undefined;
  const records: UsageRecord[] = [];
  for (const item of e.records) {
    const record = unpackRecord(item);
    if (!record) return undefined;
    records.push(record);
  }
  const tail: UsageRecord[] = [];
  for (const item of e.tail) {
    const record = unpackRecord(item);
    if (!record) return undefined;
    tail.push(record);
  }
  const codex = e.codex;
  if (codex !== undefined) {
    if (typeof codex !== "object" || codex === null) return undefined;
    if (typeof codex.model !== "string" || typeof codex.sessionId !== "string" || typeof codex.lastSignature !== "string") return undefined;
    if (codex.firstNamedModel !== undefined && typeof codex.firstNamedModel !== "string") return undefined;
  }
  return { size: e.size, mtimeMs: e.mtimeMs, offset: e.offset, records, tail, ...(codex ? { codex } : {}) };
}

export class UsageScanCache {
  private readonly files = new Map<string, FileEntry>();
  private loaded: Promise<void> | undefined;
  private dirty = false;
  private saving: Promise<void> | undefined;
  private saveAgain = false;

  constructor(private readonly file: string | undefined) {}

  load(): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.loaded ??= (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.promises.readFile(this.file!, "utf8"));
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const { version, files } = parsed as { version?: unknown; files?: unknown };
      if (version !== SCAN_CACHE_VERSION || typeof files !== "object" || files === null) return;
      for (const [file, stored] of Object.entries(files as Record<string, unknown>)) {
        const entry = unpackEntry(stored);
        if (entry) this.files.set(file, entry);
      }
    })();
    return this.loaded;
  }

  get(file: string): FileEntry | undefined {
    return this.files.get(file);
  }

  set(file: string, entry: FileEntry): void {
    this.files.set(file, entry);
    this.dirty = true;
  }

  save(visited: ReadonlySet<string>, now = Date.now()): Promise<void> {
    const horizon = now - WARM_WINDOW_MS - MTIME_SLACK_MS;
    for (const [file, entry] of this.files) {
      if (!visited.has(file) || entry.mtimeMs < horizon) {
        this.files.delete(file);
        this.dirty = true;
      }
    }
    if (!this.file || !this.dirty) return this.saving ?? Promise.resolve();
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.dirty = false;
    this.saving = this.write()
      .catch(() => undefined)
      .finally(() => {
        this.saving = undefined;
        if (this.saveAgain) {
          this.saveAgain = false;
          this.dirty = true;
          void this.save(new Set(this.files.keys()));
        }
      });
    return this.saving;
  }

  private async write(): Promise<void> {
    const files: Record<string, StoredEntry> = {};
    for (const [file, entry] of this.files) {
      files[file] = { ...entry, records: entry.records.map(packRecord), tail: entry.tail.map(packRecord) };
    }
    const target = this.file!;
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ version: SCAN_CACHE_VERSION, files }), { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  }

  async flushed(): Promise<void> {
    while (this.saving) await this.saving;
  }
}

const cachesByPath = new Map<string, UsageScanCache>();
const memoryOnlyCache = new UsageScanCache(undefined);

export function cacheFor(file: string | undefined): UsageScanCache {
  if (!file) return memoryOnlyCache;
  let cache = cachesByPath.get(file);
  if (!cache) {
    cache = new UsageScanCache(file);
    cachesByPath.set(file, cache);
  }
  return cache;
}

export async function flushUsageScanCaches(): Promise<void> {
  await Promise.all([...cachesByPath.values()].map((cache) => cache.flushed()));
}

export function resetUsageScanCaches(): void {
  cachesByPath.clear();
}
