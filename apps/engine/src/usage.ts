/**
 * The usage report — spend over time, folded from the engine's own journals.
 *
 * NO SECOND RECORDING PATH. Every settled turn's journal already ends with a
 * `turn.completed` carrying its final `UsageSnapshot`; this module reads what
 * is there rather than teaching the write path to also keep a ledger the two
 * could disagree about. The trade is stated where it bites: usage lives and
 * dies with the session's journal, so deleting a session deletes its history
 * from this page. (t3 code scans the provider CLIs' transcript directories
 * instead — its threads run outside its own store; Telar's do not.)
 *
 * ABORTED TURNS COUNT WHAT THEY LAST REPORTED. A stopped or failed turn has
 * no `turn.completed`, so its spend is the LAST `usage.updated` seen for that
 * run — a floor, not a total (Claude's mid-turn snapshots are per-envelope),
 * and better than pretending an interrupted turn cost nothing. When a
 * `turn.completed` exists it wins outright: the result figure is the
 * provider's own whole-turn total, and adding snapshots on top would double
 * count.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderDriverKind, TokenUsage, UsageBucket, UsageReport, UsageResolution } from "@telar/engine-client";

type TurnSpend = {
  at: number;
  runId: string;
  tokens: TokenUsage;
  costUsd?: number;
  /** True when this figure is a turn.completed total, false for the
   *  last-snapshot floor of an aborted turn. */
  settled: boolean;
};

type SessionScan = {
  driver: ProviderDriverKind;
  /** runId → model actually selected for that turn (or the session default). */
  modelOf: Map<string, string>;
  spends: TurnSpend[];
};

/**
 * Parse results memoised per journal file by (size, mtime) — the same key t3
 * code's scan cache uses, for the same reason: journals only ever append, and
 * a usage page refresh must not re-read every session ever run. In memory
 * only; a daemon restart pays one cold scan.
 */
const scanCache = new Map<string, { size: number; mtimeMs: number; scan: SessionScan }>();

function readJsonLoose(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function tokensFrom(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const n = (key: string): number => (typeof raw[key] === "number" && raw[key] >= 0 ? Math.floor(raw[key]) : 0);
  return {
    input: n("input"),
    output: n("output"),
    cacheRead: n("cacheRead"),
    cacheCreate: n("cacheCreate"),
    ...(typeof raw["reasoning"] === "number" ? { reasoning: Math.floor(raw["reasoning"] as number) } : {}),
  };
}

function scanSession(sessionDir: string): SessionScan | undefined {
  const eventsFile = path.join(sessionDir, "events.ndjson");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(eventsFile);
  } catch {
    return undefined;
  }
  const cached = scanCache.get(eventsFile);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.scan;

  const session = readJsonLoose(path.join(sessionDir, "session.json"));
  const driver = session?.["driver"];
  if (driver !== "claude" && driver !== "codex") return undefined;
  const sessionModel =
    typeof session?.["model"] === "object" && session["model"] !== null
      ? (session["model"] as Record<string, unknown>)["model"]
      : undefined;

  const modelOf = new Map<string, string>();
  const queue = readJsonLoose(path.join(sessionDir, "queue.json"));
  if (Array.isArray(queue?.["turns"])) {
    for (const entry of queue["turns"] as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const turn = entry as Record<string, unknown>;
      const runId = turn["runId"];
      if (typeof runId !== "string") continue;
      const model = typeof turn["model"] === "object" && turn["model"] !== null ? (turn["model"] as Record<string, unknown>)["model"] : undefined;
      const chosen = model ?? sessionModel;
      if (typeof chosen === "string" && chosen) modelOf.set(runId, chosen);
    }
  }

  /**
   * STREAMED LINE BY LINE, LAST WRITER PER RUN WINS. The journal is
   * append-only NDJSON; a malformed line (a crash mid-append) costs that line,
   * never the file.
   */
  const byRun = new Map<string, TurnSpend>();
  let text: string;
  try {
    text = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event["type"];
    if (type !== "usage.updated" && type !== "turn.completed") continue;
    const runId = event["runId"];
    const at = event["at"];
    if (typeof runId !== "string" || typeof at !== "number") continue;
    const usage = typeof event["usage"] === "object" && event["usage"] !== null ? (event["usage"] as Record<string, unknown>) : undefined;
    const tokens = tokensFrom(usage?.["tokens"]);
    if (!tokens) continue;
    const existing = byRun.get(runId);
    // A snapshot never overwrites a settled total.
    if (existing?.settled && type === "usage.updated") continue;
    byRun.set(runId, {
      at,
      runId,
      tokens,
      ...(typeof usage?.["costUsd"] === "number" ? { costUsd: usage["costUsd"] as number } : {}),
      settled: type === "turn.completed",
    });
  }

  const scan: SessionScan = { driver, modelOf, spends: [...byRun.values()] };
  scanCache.set(eventsFile, { size: stat.size, mtimeMs: stat.mtimeMs, scan });
  return scan;
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

export function readUsageReport(
  sessionsRoot: string,
  input: { sinceMs: number; untilMs: number; resolution: UsageResolution; timeZone: string },
): UsageReport {
  const buckets = new Map<string, UsageBucket & { allPriced: boolean }>();
  let sessions = 0;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(sessionsRoot);
  } catch {
    // No sessions directory is a fresh install, not an error.
  }
  for (const entry of entries) {
    const scan = scanSession(path.join(sessionsRoot, entry));
    if (!scan) continue;
    let spentHere = false;
    for (const spend of scan.spends) {
      if (spend.at < input.sinceMs || spend.at >= input.untilMs) continue;
      spentHere = true;
      const period =
        input.resolution === "hour" ? String(Math.floor(spend.at / HOUR_MS) * HOUR_MS) : dayOf(spend.at, input.timeZone);
      const model = scan.modelOf.get(spend.runId) ?? "default";
      const key = `${period}\0${scan.driver}\0${model}`;
      const bucket = buckets.get(key) ?? {
        period,
        driver: scan.driver,
        model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        costUsd: 0,
        priced: true,
        allPriced: true,
        turns: 0,
      };
      bucket.tokens.input += spend.tokens.input;
      bucket.tokens.output += spend.tokens.output;
      bucket.tokens.cacheRead += spend.tokens.cacheRead;
      bucket.tokens.cacheCreate += spend.tokens.cacheCreate;
      bucket.costUsd += spend.costUsd ?? 0;
      // ONE unpriced turn makes the bucket unpriced: a figure missing part of
      // itself must say so rather than read as a smaller true number.
      bucket.allPriced = bucket.allPriced && spend.costUsd !== undefined;
      bucket.turns += 1;
      buckets.set(key, bucket);
    }
    if (spentHere) sessions += 1;
  }

  return {
    sinceMs: input.sinceMs,
    untilMs: input.untilMs,
    resolution: input.resolution,
    timeZone: input.timeZone,
    buckets: [...buckets.values()]
      .map(({ allPriced, ...bucket }) => ({ ...bucket, priced: allPriced }))
      .sort((left, right) => left.period.localeCompare(right.period) || left.driver.localeCompare(right.driver) || left.model.localeCompare(right.model)),
    sessions,
    readAt: Date.now(),
  };
}
