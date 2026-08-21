/**
 * THE LEDGER'S WIRE FORMAT — one JSON object per line, and a reader that
 * refuses to die on a bad one.
 *
 * The ledger is append-only JSONL, written with `O_APPEND`, so a torn write —
 * a daemon killed mid-line, a full disk, a machine that lost power at 4am —
 * costs ONE LINE AND NOT THE FILE. That property is worth nothing if the reader
 * throws on the damaged line, which is why `parseLedger` skips instead: the
 * whole point of choosing a line-oriented format over a single JSON document
 * was that partial data stays readable, and a strict parser would hand that
 * advantage straight back.
 *
 * This file is FORMAT ONLY. Opening the file, appending to it, and trimming it
 * are the store's business; keeping the two apart is what lets the format be
 * tested against a deliberately corrupted string with no filesystem in sight.
 */
import { LedgerEntry } from "@telar/engine-client";

/**
 * One entry, one line.
 *
 * `JSON.stringify` already escapes newlines inside strings as `\n`, so a
 * summary containing a line break cannot break the line format. The `replace`
 * is belt-and-braces for U+2028/U+2029, which are legal raw inside a JSON
 * string, are not escaped by `stringify`, and ARE line terminators to some
 * readers — a paragraph separator pasted out of a GitHub comment into a summary
 * is exactly how that would arrive.
 */
export function serializeEntry(entry: LedgerEntry): string {
  return JSON.stringify(entry).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Parse a whole ledger, SKIPPING anything malformed. Never throws.
 *
 * Three kinds of line are dropped silently-but-deliberately: blank ones (the
 * trailing newline every well-formed file ends with), lines that are not JSON
 * (a torn write), and lines that are JSON but not a `LedgerEntry` (a schema
 * that moved under an old file). All three are "this line is not evidence",
 * and none of them is a reason to lose the other nine hundred.
 *
 * The count of what was dropped is not returned, because no caller could act on
 * it: the ledger is a narrative a human reads, not a source of truth anything
 * reconciles against. Loom state lives in the loom records.
 */
export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = LedgerEntry.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/**
 * The last `limit` entries, oldest-first within the window.
 *
 * A tick's input carries the tail of the ledger so the orchestrator can see
 * what it did last time — the default 40 is what §7 fixes, and it is a bound
 * on the PROMPT, which is the resource actually at risk. Order is preserved so
 * the window reads as a narrative rather than a stack.
 */
export const LEDGER_TICK_WINDOW = 40;

export function tailLedger(entries: LedgerEntry[], limit: number = LEDGER_TICK_WINDOW): LedgerEntry[] {
  if (limit <= 0) return [];
  return entries.slice(Math.max(0, entries.length - limit));
}
