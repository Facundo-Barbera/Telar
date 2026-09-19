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
 *   subscription plans. Dedupe by `messageId:requestId`.
 *
 *   THAT DEDUPE IS LOAD-BEARING, AND NOT FOR THE REASON THIS COMMENT USED TO
 *   GIVE. It said a resumed session copies its parent's history into a new
 *   file. Re-measured at CLI 2.1.275 (#616): resume appends to the SAME file
 *   and keeps the same session id, and across the 2,533 transcripts on a
 *   working machine there is not one `messageId:requestId` that appears in two
 *   files — the copying the dedupe was written for no longer happens.
 *
 *   What it actually suppresses is INSIDE a single file. The CLI writes one
 *   record PER CONTENT BLOCK of an assistant response — `apiBlockIndex` 0, 1,
 *   2 for a reply that thought, spoke and called a tool — and stamps every one
 *   of them with the SAME `usage` object. Measured: 52,526 of 113,359 usage
 *   records are such re-emissions, 46%. Counting them would bill a three-block
 *   answer three times.
 *
 *   So this key must not be removed on the grounds that resume no longer
 *   forks. Left as it was, the stale rationale invited exactly that.
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
 *
 * THE SCAN IS BUILT FOR A GIGABYTE OF TRANSCRIPTS, because that is what a
 * week of agent work leaves behind (measured: 4,200 files, 933 MB, of which
 * usage lines are a quarter of the lines and a fraction of the bytes). Three
 * things keep a cold report under a second and a warm one near free:
 *
 *   BYTES, NOT STRINGS. A transcript is mostly tool output, and decoding all
 *   of it to find the handful of usage lines allocated the whole gigabyte as
 *   JS strings. The scanner searches the raw buffer for the bytes a usage
 *   line must contain and decodes only those lines.
 *
 *   THE TAIL, NOT THE FILE. Transcripts append. Each file's parse is kept
 *   with the byte offset it reached, and a file that grew is read from there.
 *   A trailing line with no newline yet is parsed but not committed — the
 *   next read re-covers it — so a record mid-write is neither lost nor
 *   counted twice.
 *
 *   ON DISK, NOT ONLY IN MEMORY. The per-file cache lives in the state root,
 *   so an engine restart (every nightly install) does not re-read a gigabyte
 *   before the first Usage page can draw.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
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
  /** The 1-hour-TTL slice of `tokens.cacheCreate` — billed at 2× input, so
   *  pricing needs the split (see usage-pricing.ts). Claude only. */
  cacheCreate1h?: number;
};

/**
 * Files whose mtime predates the window by more than this cannot contain
 * records inside it — minus clock skew and long sessions, hence the generous
 * slack (t3 code's own figure). This is what keeps a 90-day scan from
 * re-reading a year of transcripts.
 */
const MTIME_SLACK_MS = 36 * 3_600_000;

/** How far back the start-up warm-up reaches: the widest window the usage
 *  page offers, so every one of its buttons is warm. */
const WARM_WINDOW_MS = 90 * 86_400_000;

const NL = 0x0a;

function tokensOf(input: number, output: number, cacheRead: number, cacheCreate: number, reasoning?: number): TokenUsage {
  return {
    input: Math.max(0, Math.floor(input)),
    output: Math.max(0, Math.floor(output)),
    cacheRead: Math.max(0, Math.floor(cacheRead)),
    cacheCreate: Math.max(0, Math.floor(cacheCreate)),
    ...(reasoning !== undefined ? { reasoning: Math.max(0, Math.floor(reasoning)) } : {}),
  };
}

/**
 * The lines in `buf[from, to)` that contain any of the needles, decoded, in
 * file order. Every other line stays bytes: this is the whole saving.
 *
 * `from` must sit at a line start. A line that runs past `to` is cut there
 * — the caller decides whether a cut line is a partial record.
 */
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

function parseClaudeLines(buf: Buffer, from: number, to: number, fallbackSession: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of candidateLines(buf, from, to, CLAUDE_NEEDLES)) {
    // The cheap gate before JSON.parse — most lines are content, not usage.
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

/**
 * What a Codex parse carries from one line to the next — and, because a
 * file is read in pieces, from one read to the next. Serialisable, so the
 * disk cache can resume a file exactly where the last read stopped.
 */
type CodexState = {
  model: string;
  sessionId: string;
  lastSignature: string;
  /** token_count events can precede the first turn_context; those records
   *  land as "unknown" and are never priced. The session's first NAMED model
   *  owns them — backfilled once it is known. */
  firstNamedModel?: string;
};

const CODEX_NEEDLES = [Buffer.from("token_count"), Buffer.from("turn_context"), Buffer.from("session_meta")];

function parseCodexLines(buf: Buffer, from: number, to: number, state: CodexState): UsageRecord[] {
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
    // The same figures re-stamped are a UI refresh, not new spend.
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

/**
 * One transcript's parse, and where it stopped.
 *
 * `records` come from lines that ended in a newline before `offset`; they
 * are final. `tail` comes from whatever followed the last newline — a record
 * still being written, or a file that simply never got its final newline —
 * and is thrown away and re-read on the next growth, so it can neither go
 * missing nor be counted twice.
 */
type FileEntry = {
  size: number;
  mtimeMs: number;
  offset: number;
  records: UsageRecord[];
  tail: UsageRecord[];
  codex?: CodexState;
};

/** The disk shape of a record — positional, because sixty thousand of them
 *  with spelled-out keys is a file the cold path has to parse. */
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

/**
 * Every transcript's parse, by path, optionally mirrored to one JSON file.
 *
 * ONE PER PATH, module-wide, because two reports in flight (the page's
 * stale-while-revalidate fires them) must share a parse rather than race two.
 * With no path the cache is memory only — the shape every test wants, and
 * what the engine had before the disk copy existed.
 *
 * WRITTEN AFTER THE REPORT, NOT DURING IT. The report answers first; the save
 * (a stringify plus an async write-and-rename) follows on its own, coalesced
 * so a burst of reports costs one write. A cache that fails to load or save
 * costs a re-scan, never a report.
 */
class UsageScanCache {
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

  /**
   * Persist, keeping only the files a walk just saw — a deleted transcript
   * should not live on in the cache — and only those young enough to matter
   * to the widest window the page offers, so the file is bounded by recent
   * activity rather than by everything ever scanned. No-op without a path or
   * a change.
   */
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

  /** Test seam: the pending write, if one is in flight or queued. */
  async flushed(): Promise<void> {
    while (this.saving) await this.saving;
  }
}

const cachesByPath = new Map<string, UsageScanCache>();
const memoryOnlyCache = new UsageScanCache(undefined);

function cacheFor(file: string | undefined): UsageScanCache {
  if (!file) return memoryOnlyCache;
  let cache = cachesByPath.get(file);
  if (!cache) {
    cache = new UsageScanCache(file);
    cachesByPath.set(file, cache);
  }
  return cache;
}

/** Test seams: wait for every pending cache write; forget every in-memory
 *  cache (so a test can prove the disk copy is what gets read). */
export async function flushUsageScanCaches(): Promise<void> {
  await Promise.all([...cachesByPath.values()].map((cache) => cache.flushed()));
}

export function resetUsageScanCaches(): void {
  cachesByPath.clear();
}

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

/**
 * One transcript's records, from the cache when nothing changed, from its
 * new tail when it grew, and from the top when it did anything else.
 *
 * `undefined` is "could not read", which the report surfaces as a failed
 * source; `[]` is "nothing in the window", which it does not.
 */
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
  // GROWTH IS AN APPEND; anything else is a rewrite. Same size with a new
  // mtime, or a smaller file, is a transcript somebody edited or replaced,
  // and the only honest answer is to start over.
  const resume = cached && stat.size > cached.size ? cached : undefined;
  const from = resume?.offset ?? 0;
  let buf: Buffer;
  try {
    buf = await readRange(file, from, stat.size);
  } catch {
    return undefined;
  }
  const fallbackSession = path.basename(file, ".jsonl");
  // Everything before the last newline is committed; the rest is the tail.
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
    // The tail parses from a COPY of the committed state, so a partial line
    // cannot move the cursor's own state forward.
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

/** Where each CLI keeps its transcripts, honouring the same env vars the
 *  CLIs themselves read. */
export function defaultScanRoots(env: NodeJS.ProcessEnv = process.env): UsageScanRoots {
  const home = os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  // `archived_sessions` is where `codex` moves rollouts a user archives from
  // its picker — archived, not deleted, and still spend.
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

/**
 * Every record from one provider's roots, cache-assisted. Yields to the
 * event loop after every file it actually read and every so often while it
 * only stats, so the daemon keeps answering session and browser traffic
 * while a report is assembled. `visited` collects every path seen, for the
 * cache to prune against.
 */
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

/** `YYYY-MM-DD` in the requested zone. `en-CA` is the locale whose short date
 *  IS that shape — the same trick t3 code uses. */
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
}

const HOUR_MS = 3_600_000;

/** Whole-report memo: the UI's window buttons re-request with a fresh
 *  untilMs every click, so the raw args never repeat — rounded to the
 *  minute they do, and a minute-old report of a 90-day window is the same
 *  report. Bounds the walk+parse to once a minute per window shape. */
const reportMemo = new Map<string, { at: number; report: UsageReport }>();
const REPORT_MEMO_TTL_MS = 60_000;

export type UsageScanOptions = {
  roots?: UsageScanRoots;
  /** Where the rates snapshot lives — the engine state root. */
  ratesCachePath: string;
  /** Where the per-transcript parse cache lives. Absent keeps it in memory
   *  only — every test wants that; the daemon does not. */
  scanCachePath?: string;
  /** Test seam; the default fetches LiteLLM's table. */
  loadRatesTable?: () => Promise<RatesTable>;
  /** Test seam: memoization off so fixtures don't bleed between tests. */
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

  // Constructing an ICU formatter for every record dominated range changes.
  const calendar = input.resolution === "day" ? dayFormatter(input.timeZone) : undefined;
  const buckets = new Map<string, UsageBucket & { allPriced: boolean }>();
  const sessions = new Set<string>();
  const seen = new Set<string>();
  const sources: UsageSource[] = [];
  const visited = new Set<string>();

  for (const [provider, candidates] of providerRoots(roots)) {
    // The archive is an extra shelf of the same store, not a second source —
    // one row reports the primary path, and a missing archive is ordinary.
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
    // Four window buttons × two resolutions is the whole working set.
    if (reportMemo.size > 8) {
      const oldest = [...reportMemo.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) reportMemo.delete(oldest[0]);
    }
  }
  // The answer is on its way before the cache is written; see UsageScanCache.
  void cache.save(visited);
  return report;
}

/**
 * Bring the scan cache up to date without producing a report — what the
 * daemon does shortly after it starts, so the first Usage page a person opens
 * after an update finds the transcripts already read. Reaches back the
 * widest window the page offers. Rates are not touched: they are the page's
 * concern, and fetching them here would put a network call on start-up.
 */
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
