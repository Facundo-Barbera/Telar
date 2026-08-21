/**
 * The ledger's line format.
 *
 * The assertion that matters is the torn write: a corrupted line in the MIDDLE
 * of the file must cost that line and nothing else. A reader that throws would
 * hand back the entire advantage of choosing JSONL over one JSON document, and
 * it would do it at exactly the moment the file is most worth reading — after
 * the crash that corrupted it.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEntry } from "@telar/engine-client";
import { LEDGER_TICK_WINDOW, parseLedger, serializeEntry, tailLedger } from "../src/loom/ledger-format";

const at = 1_700_000_000_000;

const entry = (n: number, patch: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at: at + n,
  kind: "tick",
  summary: `tick ${n}`,
  ...patch,
});

describe("serializeEntry", () => {
  test("is exactly one line", () => {
    const line = serializeEntry(entry(1, { summary: "gate failed:\nbun run ci\nexit 1" }));
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line).summary).toBe("gate failed:\nbun run ci\nexit 1");
  });

  test("survives a round trip through parseLedger", () => {
    const original = entry(1, { kind: "dispatch", loomId: "loom_1", item: "#457", detail: "brief" });
    expect(parseLedger(serializeEntry(original))).toEqual([original]);
  });

  test("escapes the unicode line separators JSON leaves raw", () => {
    // U+2028 is legal unescaped inside a JSON string and IS a line terminator
    // to some readers — a paragraph break pasted out of a comment thread.
    const summary = "before\u2028after\u2029end";
    const line = serializeEntry(entry(1, { summary }));
    expect(line.includes("\u2028")).toBe(false);
    expect(line.includes("\u2029")).toBe(false);
    expect(parseLedger(line)[0]?.summary).toBe(summary);
  });

  test("unicode content survives whole", () => {
    const original = entry(1, { summary: "decisión de JMB — 🧵" });
    expect(parseLedger(serializeEntry(original))[0]?.summary).toBe("decisión de JMB — 🧵");
  });
});

describe("parseLedger skips instead of throwing", () => {
  const good = [entry(1), entry(2, { kind: "dispatch" }), entry(3, { kind: "publish" })];

  test("a torn line in the MIDDLE costs one line, not the file", () => {
    const text = [
      serializeEntry(good[0] as LedgerEntry),
      '{"at":170000000000,"kind":"dispa',
      serializeEntry(good[1] as LedgerEntry),
      serializeEntry(good[2] as LedgerEntry),
    ].join("\n");
    const parsed = parseLedger(text);
    expect(parsed).toEqual([good[0] as LedgerEntry, good[1] as LedgerEntry, good[2] as LedgerEntry]);
  });

  test("valid JSON that is not a ledger entry is skipped too", () => {
    const text = [serializeEntry(good[0] as LedgerEntry), '{"hello":"world"}', '"a bare string"', "42", "[]", serializeEntry(good[1] as LedgerEntry)].join(
      "\n",
    );
    expect(parseLedger(text)).toEqual([good[0] as LedgerEntry, good[1] as LedgerEntry]);
  });

  test("an entry with an unknown kind is skipped, not coerced", () => {
    const text = ['{"at":1,"kind":"shrug","summary":"x"}', serializeEntry(good[0] as LedgerEntry)].join("\n");
    expect(parseLedger(text)).toEqual([good[0] as LedgerEntry]);
  });

  test("blank lines, a trailing newline and CRLF are all fine", () => {
    const text = `\n${serializeEntry(good[0] as LedgerEntry)}\r\n\n${serializeEntry(good[1] as LedgerEntry)}\n\n`;
    expect(parseLedger(text)).toHaveLength(2);
  });

  test("an empty file, whitespace and outright garbage all read as no entries", () => {
    expect(parseLedger("")).toEqual([]);
    expect(parseLedger("\n\n   \n")).toEqual([]);
    expect(parseLedger("not json at all\nnor is this")).toEqual([]);
  });

  test("a half-written last line — the actual crash shape — loses only itself", () => {
    const text = serializeEntry(good[0] as LedgerEntry) + "\n" + serializeEntry(good[1] as LedgerEntry).slice(0, 20);
    expect(parseLedger(text)).toEqual([good[0] as LedgerEntry]);
  });
});

describe("tailLedger", () => {
  const many = Array.from({ length: 100 }, (_, i) => entry(i));

  test("takes the last N, oldest-first within the window", () => {
    const tail = tailLedger(many, 3);
    expect(tail.map((e) => e.summary)).toEqual(["tick 97", "tick 98", "tick 99"]);
  });

  test("the default window is the one §7 fixed", () => {
    expect(LEDGER_TICK_WINDOW).toBe(40);
    expect(tailLedger(many)).toHaveLength(40);
  });

  test("a short ledger is returned whole, and a zero window is empty", () => {
    expect(tailLedger([entry(1)], 40)).toHaveLength(1);
    expect(tailLedger(many, 0)).toEqual([]);
    expect(tailLedger(many, -1)).toEqual([]);
  });
});
