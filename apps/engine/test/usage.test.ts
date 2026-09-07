import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushUsageScanCaches, readUsageReport, resetUsageScanCaches, warmUsageScanCache, type UsageScanRoots } from "../src/usage";
import { normalizeModelName, priceTokens, resetRatesMemo, type RatesTable } from "../src/usage-pricing";

const roots: string[] = [];
const tmp = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  await flushUsageScanCaches();
  resetUsageScanCaches();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  resetRatesMemo();
});

/** Fixture transcript trees, in the CLIs' own shapes (verified against real
 *  files on disk — see usage.ts's header). */
function scanRoots(): UsageScanRoots {
  const base = tmp();
  const claude = path.join(base, "claude-projects");
  const codex = path.join(base, "codex-sessions");
  fs.mkdirSync(path.join(claude, "-tmp-proj"), { recursive: true });
  fs.mkdirSync(path.join(codex, "2026", "08", "30"), { recursive: true });
  return { claude, codex };
}

const AT = Date.UTC(2026, 7, 30, 12);
const iso = (at: number): string => new Date(at).toISOString();

function claudeLine(overrides: { at?: number; model?: string; costUSD?: number | null; mid?: string; requestId?: string; input?: number } = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(overrides.at ?? AT),
    sessionId: "sess-claude-1",
    requestId: overrides.requestId ?? null,
    costUSD: overrides.costUSD ?? null,
    message: {
      id: overrides.mid ?? `msg_${Math.random().toString(36).slice(2)}`,
      model: overrides.model ?? "claude-opus-5",
      usage: { input_tokens: overrides.input ?? 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 50 },
    },
  });
}

function codexLines(usage: { input: number; cached: number; write: number; output: number; reasoning?: number }, at = AT): string[] {
  return [
    JSON.stringify({ timestamp: iso(at), type: "session_meta", payload: { id: "sess-codex-1" } }),
    JSON.stringify({ timestamp: iso(at), type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: iso(at),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: usage.input,
            cached_input_tokens: usage.cached,
            cache_write_input_tokens: usage.write,
            output_tokens: usage.output,
            reasoning_output_tokens: usage.reasoning ?? 0,
          },
        },
      },
    }),
  ];
}

const RATES: RatesTable = {
  status: "fresh",
  rates: new Map([
    ["gpt-5.6-sol", { inputPerTok: 1e-6, outputPerTok: 2e-6, cacheReadPerTok: 1e-7 }],
    ["claude-opus-5", { inputPerTok: 1e-5, outputPerTok: 5e-5, cacheReadPerTok: 1e-6, cacheCreatePerTok: 1.25e-5 }],
  ]),
};

const WINDOW = { sinceMs: AT - 86_400_000, untilMs: AT + 86_400_000, resolution: "day" as const, timeZone: "UTC" };

async function read(scan: UsageScanRoots, window = WINDOW, rates: RatesTable = RATES, scanCachePath?: string) {
  // memo off: every test reuses WINDOW with different fixture roots.
  return readUsageReport(window, {
    roots: scan,
    ratesCachePath: path.join(tmp(), "rates.json"),
    ...(scanCachePath ? { scanCachePath } : {}),
    loadRatesTable: () => Promise.resolve(rates),
    memo: false,
  });
}

const turns = (report: Awaited<ReturnType<typeof read>>) => report.buckets.reduce((sum, bucket) => sum + bucket.turns, 0);

/** Bump a file's mtime past what the OS may have coalesced with the last
 *  write, so "grew" and "same size, new mtime" are both observable. */
function touch(file: string, plusMs = 5_000): void {
  const later = new Date(fs.statSync(file).mtimeMs + plusMs);
  fs.utimesSync(file, later, later);
}

test("both transcripts land with their REAL model names, priced from the table when unreported", async () => {
  const scan = scanRoots();
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"), claudeLine() + "\n");
  fs.writeFileSync(path.join(scan.codex, "2026", "08", "30", "rollout-a.jsonl"), codexLines({ input: 1100, cached: 1000, write: 50, output: 200, reasoning: 40 }).join("\n") + "\n");

  const report = await read(scan);
  expect(report.buckets.map((bucket) => `${bucket.driver}:${bucket.model}`)).toEqual(["claude:claude-opus-5", "codex:gpt-5.6-sol"]);
  const [claude, codex] = report.buckets;
  // Claude input already excludes cache; priced from the table (costUSD null).
  expect(claude!.tokens).toEqual({ input: 10, output: 50, cacheRead: 100, cacheCreate: 20 });
  expect(claude!.priced).toBe(true);
  expect(claude!.costUsd).toBeCloseTo(10 * 1e-5 + 50 * 5e-5 + 100 * 1e-6 + 20 * 1.25e-5);
  // Codex input is INCLUSIVE of cached+write: uncached = 1100-1000-50 = 50.
  expect(codex!.tokens).toEqual({ input: 50, output: 200, cacheRead: 1000, cacheCreate: 50, reasoning: 40 });
  // Missing cache-write rate falls back to the input rate — never free.
  expect(codex!.costUsd).toBeCloseTo(50 * 1e-6 + 200 * 2e-6 + 1000 * 1e-7 + 50 * 1e-6);
  expect(report.sessions).toBe(2);
  expect(report.sources.map((source) => `${source.provider}:${source.status}`)).toEqual(["claude:ok", "codex:ok"]);
});

test("token_count before the first turn_context is owned by the session's first named model", async () => {
  const scan = scanRoots();
  const lines = codexLines({ input: 1100, cached: 1000, write: 0, output: 200 });
  // Real rollouts can emit a token_count before any turn_context; without
  // backfill those tokens land as "unknown" and are never priced.
  const reordered = [lines[0]!, lines[2]!, lines[1]!, JSON.stringify({
    timestamp: iso(AT + 1000),
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 } } },
  })];
  fs.writeFileSync(path.join(scan.codex, "2026", "08", "30", "rollout-a.jsonl"), reordered.join("\n") + "\n");
  const report = await read(scan);
  expect(report.buckets.map((bucket) => bucket.model)).toEqual(["gpt-5.6-sol"]);
  expect(report.buckets[0]!.turns).toBe(2);
  expect(report.buckets[0]!.priced).toBe(true);
});

test("a provider-reported cost beats the rate table", async () => {
  const scan = scanRoots();
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"), claudeLine({ costUSD: 0.42 }) + "\n");
  const report = await read(scan);
  expect(report.buckets[0]!.costUsd).toBeCloseTo(0.42);
});

test("an unknown model's tokens count and its cost stays absent", async () => {
  const scan = scanRoots();
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"), claudeLine({ model: "claude-mystery-9" }) + "\n");
  const report = await read(scan);
  expect(report.buckets[0]!.priced).toBe(false);
  expect(report.buckets[0]!.costUsd).toBe(0);
  expect(report.buckets[0]!.tokens.cacheRead).toBe(100);
});

test("duplicated Claude messages (resumed session copies) count once; re-stamped Codex counts do too", async () => {
  const scan = scanRoots();
  const shared = claudeLine({ mid: "msg_shared", requestId: "req_1" });
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"), shared + "\n");
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-2.jsonl"), shared + "\n" + claudeLine({ mid: "msg_other" }) + "\n");
  const codex = codexLines({ input: 100, cached: 0, write: 0, output: 10 });
  fs.writeFileSync(path.join(scan.codex, "2026", "08", "30", "rollout-a.jsonl"), [...codex, codex[2]].join("\n") + "\n");

  const report = await read(scan);
  const claudeTurns = report.buckets.filter((bucket) => bucket.driver === "claude").reduce((sum, bucket) => sum + bucket.turns, 0);
  const codexTurns = report.buckets.filter((bucket) => bucket.driver === "codex").reduce((sum, bucket) => sum + bucket.turns, 0);
  expect(claudeTurns).toBe(2);
  expect(codexTurns).toBe(1);
});

test("the window bounds records; a missing directory is a named source, not zero", async () => {
  const scan = scanRoots();
  fs.writeFileSync(
    path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"),
    claudeLine() + "\n" + claudeLine({ at: AT + 10 * 86_400_000, mid: "msg_late" }) + "\n",
  );
  fs.rmSync(scan.codex, { recursive: true });
  const report = await read(scan);
  expect(report.buckets.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(1);
  expect(report.sources.find((source) => source.provider === "codex")?.status).toBe("missing");
});

test("hourly resolution buckets by hour start; malformed lines cost nothing", async () => {
  const scan = scanRoots();
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl"), "not json with assistant usage\n" + claudeLine() + "\n");
  const report = await read(scan, { ...WINDOW, resolution: "hour" });
  expect(report.buckets[0]!.period).toBe(String(Math.floor(AT / 3_600_000) * 3_600_000));
});

test("an appended transcript is re-read on the next report", async () => {
  const scan = scanRoots();
  const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
  fs.writeFileSync(file, claudeLine({ mid: "msg_1" }) + "\n");
  expect((await read(scan)).buckets[0]!.turns).toBe(1);
  fs.appendFileSync(file, claudeLine({ mid: "msg_2" }) + "\n");
  expect((await read(scan)).buckets[0]!.turns).toBe(2);
});

describe("the scan cache", () => {
  test("a record still being written counts once, and once only, as the line completes", async () => {
    // THE TAIL RULE. A transcript is appended one line at a time, and a read
    // can land mid-line. The half-line must not vanish (it is spend), and it
    // must not be counted again when the rest of it arrives.
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    const whole = claudeLine({ mid: "msg_2" });
    fs.writeFileSync(file, claudeLine({ mid: "msg_1" }) + "\n" + whole.slice(0, 40));
    // The cut line is not JSON yet: one turn.
    expect(turns(await read(scan))).toBe(1);
    fs.appendFileSync(file, whole.slice(40));
    // Complete but unterminated: it counts, from the tail.
    expect(turns(await read(scan))).toBe(2);
    fs.appendFileSync(file, "\n" + claudeLine({ mid: "msg_3" }) + "\n");
    // Terminated and committed, plus one more: still each once.
    expect(turns(await read(scan))).toBe(3);
  });

  test("a grown transcript is read from where the last read stopped, not from the top", async () => {
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    const cachePath = path.join(tmp(), "scan.json");
    fs.writeFileSync(file, claudeLine({ mid: "msg_1" }) + "\n");
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(1);
    await flushUsageScanCaches();
    const before = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, { offset: number; size: number }> };
    const first = before.files[file]!;
    expect(first.offset).toBe(first.size);

    // Corrupt the committed prefix on disk. A read from the top would now
    // lose msg_1; a read from the cursor never looks at it.
    const original = fs.readFileSync(file);
    const mangled = Buffer.from(original);
    mangled.write("xxxxxxxxxx", 2);
    fs.writeFileSync(file, mangled);
    fs.appendFileSync(file, claudeLine({ mid: "msg_2" }) + "\n");
    touch(file);
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(2);
  });

  test("a rewritten transcript — same size, new mtime, or shrunk — is re-read from the top", async () => {
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    const one = claudeLine({ mid: "msg_1", input: 10 });
    fs.writeFileSync(file, one + "\n");
    expect((await read(scan)).buckets[0]!.tokens.input).toBe(10);
    // Same length, different content: the cursor cannot be trusted.
    fs.writeFileSync(file, claudeLine({ mid: "msg_1", input: 99 }).padEnd(one.length) + "\n");
    touch(file);
    expect((await read(scan)).buckets[0]!.tokens.input).toBe(99);
    // Shrunk: likewise.
    fs.writeFileSync(file, claudeLine({ mid: "msg_9", input: 5 }) + "\n");
    expect((await read(scan)).buckets[0]!.tokens.input).toBe(5);
  });

  test("the cache survives a restart: a fresh process answers from disk without reading the transcripts", async () => {
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    const cachePath = path.join(tmp(), "scan.json");
    fs.writeFileSync(file, claudeLine({ mid: "msg_1" }) + "\n" + claudeLine({ mid: "msg_2" }) + "\n");
    // A whole-second mtime, so the rewrite below can reproduce it exactly:
    // APFS stamps sub-millisecond, and utimes cannot put that back.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(file, pinned, pinned);
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(2);
    await flushUsageScanCaches();
    expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600);

    // "Restart": forget everything in memory, then make the transcript
    // unreadable-as-usage while keeping its size and mtime. Only a process
    // that trusts the disk cache still sees two turns.
    resetUsageScanCaches();
    fs.writeFileSync(file, "x".repeat(fs.statSync(file).size));
    fs.utimesSync(file, pinned, pinned);
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(2);
  });

  test("a cache file that is not one costs a re-scan, never the report", async () => {
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    fs.writeFileSync(file, claudeLine({ mid: "msg_1" }) + "\n");
    for (const garbage of ["not json", '{"version":99,"files":{}}', `{"version":1,"files":{${JSON.stringify(file)}:{"size":"big"}}}`]) {
      const cachePath = path.join(tmp(), "scan.json");
      fs.writeFileSync(cachePath, garbage);
      expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(1);
    }
  });

  test("a deleted transcript leaves the cache on the next save", async () => {
    const scan = scanRoots();
    const keep = path.join(scan.claude, "-tmp-proj", "keep.jsonl");
    const gone = path.join(scan.claude, "-tmp-proj", "gone.jsonl");
    const cachePath = path.join(tmp(), "scan.json");
    fs.writeFileSync(keep, claudeLine({ mid: "msg_k" }) + "\n");
    fs.writeFileSync(gone, claudeLine({ mid: "msg_g" }) + "\n");
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(2);
    await flushUsageScanCaches();
    fs.rmSync(gone);
    expect(turns(await read(scan, WINDOW, RATES, cachePath))).toBe(1);
    await flushUsageScanCaches();
    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(stored.files)).toEqual([keep]);
  });

  test("a transcript older than the widest window leaves the cache too — the file is bounded by recent activity", async () => {
    const scan = scanRoots();
    const fresh = path.join(scan.claude, "-tmp-proj", "fresh.jsonl");
    const ancient = path.join(scan.claude, "-tmp-proj", "ancient.jsonl");
    const cachePath = path.join(tmp(), "scan.json");
    fs.writeFileSync(fresh, claudeLine({ mid: "msg_f" }) + "\n");
    fs.writeFileSync(ancient, claudeLine({ mid: "msg_a" }) + "\n");
    // A year-old mtime: inside no window the page can ask for.
    const longAgo = new Date(Date.now() - 365 * 86_400_000);
    fs.utimesSync(ancient, longAgo, longAgo);
    // A window wide enough to make the scanner READ the ancient file...
    await read(scan, { ...WINDOW, sinceMs: longAgo.getTime() - 86_400_000 }, RATES, cachePath);
    await flushUsageScanCaches();
    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, unknown> };
    // ...and it still is not kept: the widest window the page offers is 90 days.
    expect(Object.keys(stored.files)).toEqual([fresh]);
  });

  test("Codex state resumes across a growth: a model named before the cut still owns the tokens after it", async () => {
    const scan = scanRoots();
    const file = path.join(scan.codex, "2026", "08", "30", "rollout-a.jsonl");
    const [meta, context, count] = codexLines({ input: 100, cached: 0, write: 0, output: 10 });
    fs.writeFileSync(file, [meta, context, count].join("\n") + "\n");
    expect((await read(scan)).buckets.map((bucket) => `${bucket.model}:${bucket.turns}`)).toEqual(["gpt-5.6-sol:1"]);
    // A second token_count with new figures and NO turn_context of its own:
    // the model comes from the state the cursor carried, not from the file.
    const [, , later] = codexLines({ input: 300, cached: 0, write: 0, output: 30 }, AT + 60_000);
    fs.appendFileSync(file, later + "\n");
    touch(file);
    expect((await read(scan)).buckets.map((bucket) => `${bucket.model}:${bucket.turns}`)).toEqual(["gpt-5.6-sol:2"]);
    // …and a re-stamp of the same figures across the cut is still not spend.
    fs.appendFileSync(file, later + "\n");
    touch(file);
    expect((await read(scan)).buckets[0]!.turns).toBe(2);
  });

  test("warming reads the transcripts into the disk cache without a report or a rates fetch", async () => {
    const scan = scanRoots();
    const file = path.join(scan.claude, "-tmp-proj", "sess-claude-1.jsonl");
    const cachePath = path.join(tmp(), "scan.json");
    fs.writeFileSync(file, claudeLine({ at: Date.now() - 60_000, mid: "msg_1" }) + "\n");
    await warmUsageScanCache({ roots: scan, scanCachePath: cachePath });
    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { version: number; files: Record<string, { records: unknown[] }> };
    expect(stored.version).toBe(1);
    expect(stored.files[file]!.records).toHaveLength(1);
  });
});

describe("pricing", () => {
  test("one-hour cache writes cost double input, not the 5-minute rate", () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000 };
    // All 5m: the table's own cache-creation rate.
    expect(priceTokens(RATES, "claude-opus-5", tokens)).toBeCloseTo(1_000_000 * 1.25e-5);
    // All 1h: 2× the input rate.
    expect(priceTokens(RATES, "claude-opus-5", tokens, { cacheCreate1h: 1_000_000 })).toBeCloseTo(1_000_000 * 2 * 1e-5);
    // Split prices each slice at its own tier.
    expect(priceTokens(RATES, "claude-opus-5", tokens, { cacheCreate1h: 400_000 })).toBeCloseTo(600_000 * 1.25e-5 + 400_000 * 2e-5);
  });

  test("a prefixed duplicate row without cache rates cannot shadow the complete one", async () => {
    const { loadRates } = await import("../src/usage-pricing");
    const cachePath = path.join(tmp(), "rates.json");
    const payload = {
      "claude-x": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5, cache_read_input_token_cost: 1e-6 },
      "anthropic/claude-x": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
    };
    const table = await loadRates(cachePath, () => Promise.resolve(payload));
    expect(priceTokens(table, "claude-x", { input: 0, output: 0, cacheRead: 1_000_000, cacheCreate: 0 })).toBeCloseTo(1);
  });

  test("names normalize and bare aliases stay unpriceable", () => {
    expect(normalizeModelName("anthropic/Claude-Opus-5")).toBe("claude-opus-5");
    const tokens = { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 };
    expect(priceTokens(RATES, "haiku", tokens)).toBeUndefined();
    expect(priceTokens(RATES, "default", tokens)).toBeUndefined();
    expect(priceTokens(RATES, "unknown-model", tokens)).toBeUndefined();
    expect(priceTokens(RATES, "Anthropic/claude-opus-5", tokens)).toBeCloseTo(10 * 1e-5 + 10 * 5e-5);
  });
});


test("daily buckets honor local midnight and fall back to UTC for an invalid zone", async () => {
  const scan = scanRoots();
  const at = Date.UTC(2026, 7, 30, 2);
  fs.writeFileSync(path.join(scan.claude, "-tmp-proj", "midnight.jsonl"), claudeLine({ at }));
  const local = await read(scan, { ...WINDOW, timeZone: "America/Mexico_City" });
  const fallback = await read(scan, { ...WINDOW, timeZone: "invalid/zone" });
  expect(local.buckets[0]?.period).toBe("2026-08-29");
  expect(fallback.buckets[0]?.period).toBe("2026-08-30");
  expect(local.buckets[0]?.tokens).toEqual(fallback.buckets[0]?.tokens);
});
