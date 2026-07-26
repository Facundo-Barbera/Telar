// Ultra journal storage (doc §3 "Journal + deterministic-ordinal resume", §5
// "Storage & API"). ~/.telar/ultra/<runId>/journal.jsonl — env-resolved root
// (TELAR_HOME, manifest.ts:17 pattern), a NEW top-level sibling of looms/ so no
// loom-listing/reaper code can ever enumerate a run (doc §5). U4 grows this
// module with manifest.json/events.ndjson/agents/<ordinal>.ndjson; this cut
// only needs the resume source.
//
// One record per ordinal: the agent() result + a content hash of (prompt,
// opts) as a cache-validity check (doc §3) — NOT the key itself. The ordinal
// (assigned at issue time, executor.ts) is the key everywhere.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { telarDir } from "../manifest";

export const ultraDir = (): string => path.join(telarDir(), "ultra");

// Same guard idiom as looms.ts's loomDir — id must be a bare, separator-free
// segment so a hostile runId can never relocate a run's dir off-disk.
export const runDir = (runId: string): string => {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`invalid ultra runId: ${JSON.stringify(runId)}`);
  }
  return path.join(ultraDir(), runId);
};

const journalFile = (runId: string) => path.join(runDir(runId), "journal.jsonl");

export type JournalRecord = {
  ordinal: number;
  hash: string;
  result: unknown;
  // Cut U4: the settled call's cost/turns (doc §3 "cost visibility" / doc §5
  // "record per-call cost/turns"), from the runner's "result" EngineEvent.
  // Optional — absent on a call made with no cost-reporting fake (most of
  // this cut's own DI tests) and on any pre-U4 journal record, so an old
  // journal on disk still parses (JSON.parse simply yields `undefined` for a
  // missing key, same as never provided).
  costUsd?: number;
  turns?: number;
  // THE BILLING IDENTITY OF THE SETTLE THIS RECORD IS (executor.ts's
  // UltraEvent.settleId): a unique id minted at the moment the money was
  // spent, carried here so every later replay of this record re-presents the
  // key its live settle already wrote instead of deriving a new one from the
  // record's position, order or count — the one property that makes the spend
  // ledger's dedupe safe under corruption and under two concurrent writers.
  // Optional for the same reason costUsd is: a record written before the field
  // existed still parses and still replays, and only such a record falls back
  // to the count-derived key that older code used for it (executor.ts's
  // `legacyCounts`).
  settleId?: string;
};

// Deep, key-sorted canonicalization so two structurally-identical (prompt,
// opts) values hash the same regardless of property insertion order. Functions
// (e.g. inside a zod schema's internals) are left as-is; JSON.stringify drops
// them silently and deterministically wherever they appear, so a schema built
// the same way by a re-executed script hashes the same (doc §3: "schema
// included").
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = canonicalize((v as Record<string, unknown>)[k]);
  }
  return out;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

// The cache-validity check stored inside each journal record (doc §3).
export function hashCall(prompt: string, opts: unknown): string {
  return crypto.createHash("sha256").update(stableStringify({ prompt, opts })).digest("hex");
}

// Append-only — called once per LIVE agent() call as it settles (cache hits
// never append, so replaying a full-cache prefix is a pure read). Concurrent
// live calls under parallel() may append out of ordinal order; readJournal
// doesn't assume file order matches ordinal order.
export function appendJournal(runId: string, rec: JournalRecord): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalFile(runId), JSON.stringify(rec) + "\n");
}

// Line-by-line parse, tolerant of a torn trailing line (crash mid-append, doc
// §3 "Corruption tolerance") — same lines.pop() idiom as looms.ts's
// readEvents: a file ending without a final "\n" has its last (possibly
// partial) line dropped rather than JSON.parse-thrown. A malformed line
// mid-file (not just the tail) is also skipped rather than aborting the whole
// read, so one corrupt record doesn't blind resume to every record after it.
export function readJournal(runId: string): JournalRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalFile(runId), "utf8");
  } catch {
    return []; // no journal yet — a fresh run, not an error
  }
  const lines = raw.split("\n");
  lines.pop(); // trailing "" after a final \n, or a torn partial line either way
  const out: JournalRecord[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Partial<JournalRecord>;
      if (typeof rec.ordinal === "number" && typeof rec.hash === "string") {
        // `settleId` names MONEY (see the type above), so it is accepted only
        // as a non-empty string. Anything else — a hand-edited number, null, a
        // truncated "" — is dropped to `undefined` here, at the parse boundary,
        // so the replay takes the documented pre-settleId fallback rather than
        // keying a ledger row on a shape nothing ever minted.
        if (typeof rec.settleId !== "string" || rec.settleId === "") delete rec.settleId;
        out.push(rec as JournalRecord);
      }
    } catch {
      // corrupt line: skip, that ordinal re-runs live
    }
  }
  return out;
}

// Keyed by ordinal for O(1) lookup during a re-run — the last record wins if
// an ordinal somehow appears twice (defensive; the executor never writes an
// ordinal it has already served from cache or already appended live).
export function readJournalMap(runId: string): Map<number, JournalRecord> {
  const map = new Map<number, JournalRecord>();
  for (const rec of readJournal(runId)) map.set(rec.ordinal, rec);
  return map;
}
