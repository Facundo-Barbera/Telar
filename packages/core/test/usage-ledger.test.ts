// Story 1.1 / CAP-2 — the one attributed spend ledger (AD-18, AD-20).
// Temp TELAR_HOME (never the real ~/.telar, the looms.test.ts idiom). Exercises:
// owner attribution physically landing on disk, tolerant reads of records
// written before attribution existed, the owner-scoping rule that keeps the
// existing account windows byte-identical, and the byte-offset projection
// cache under append-then-read-in-one-tick.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-ledger-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin before every test.
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { logUsage, usageSummary, usageCostBySession, usageTokensBySession, ledgerSpendUsd } =
  await import("../src/usage-ledger");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Each test gets its own root so the byte-offset cache is exercised from a
// clean slate and no test can see another's lines.
function freshRoot(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-ul-${tag}-`));
  process.env.TELAR_HOME = root;
  return root;
}

const ledgerPath = (root: string) => path.join(root, "usage.ndjson");

function rawLines(root: string): Record<string, unknown>[] {
  return fs
    .readFileSync(ledgerPath(root), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Writes a line straight to disk, bypassing the port — the only way to build a
// record in a shape the port would no longer produce (a pre-attribution one).
function handWrite(root: string, obj: Record<string, unknown>) {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(ledgerPath(root), JSON.stringify(obj) + "\n");
}

const entry = (over: Record<string, unknown> = {}) => ({
  ts: Date.now(),
  account: "personal",
  model: "sonnet",
  sessionId: "s1",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  costUsd: 1,
  ...over,
});

describe("usage ledger (CAP-2)", () => {
  test("logUsage appends one line to $TELAR_HOME/usage.ndjson and creates no other file", () => {
    const root = freshRoot("one-file");
    logUsage(entry());
    expect(fs.readdirSync(root)).toEqual(["usage.ndjson"]);
    expect(rawLines(root)).toHaveLength(1);
    logUsage(entry());
    expect(fs.readdirSync(root)).toEqual(["usage.ndjson"]);
    expect(rawLines(root)).toHaveLength(2);
  });

  test("the appended record carries ownerKind and ownerId alongside account/model/sessionId/costUsd", () => {
    const root = freshRoot("attribution");
    logUsage(entry({ sessionId: "sess-a", ownerKind: "loom", ownerId: "loom-7", costUsd: 2 }));
    const [line] = rawLines(root);
    // Asserted on the PERSISTED bytes, not the in-memory object.
    expect(line.ownerKind).toBe("loom");
    expect(line.ownerId).toBe("loom-7");
    expect(line.account).toBe("personal");
    expect(line.model).toBe("sonnet");
    expect(line.sessionId).toBe("sess-a");
    expect(line.costUsd).toBe(2);
  });

  test("an entry logged without explicit owner fields is attributed to owner-kind session and its sessionId", () => {
    // This is why the pre-existing chat-route call site needs no edit.
    const root = freshRoot("default-owner");
    logUsage(entry({ sessionId: "sess-b" }));
    const [line] = rawLines(root);
    expect(line.ownerKind).toBe("session");
    expect(line.ownerId).toBe("sess-b");
  });

  test("a record written before owner attribution existed counts toward usageSummary and ledgerSpendUsd and never throws", () => {
    const root = freshRoot("historical");
    handWrite(root, {
      ts: Date.now(),
      account: "personal",
      model: "sonnet",
      sessionId: "old-session",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 4,
    });
    const summary = usageSummary();
    expect(summary.weekly.costUsd).toBe(4);
    expect(summary.weekly.requests).toBe(1);
    expect(summary.byAccount.personal.weekly.costUsd).toBe(4);
    expect(usageCostBySession().get("old-session")).toBe(4);
    expect(usageTokensBySession().get("old-session")!.inputTokens).toBe(7);
    // It attributes to its own session, so an owner query finds it too.
    expect(ledgerSpendUsd({ ownerKind: "session", ownerId: "old-session" })).toBe(4);
  });

  test("a malformed ledger line is skipped, not thrown", () => {
    const root = freshRoot("malformed");
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(ledgerPath(root), "{not json at all\n");
    handWrite(root, { ts: Date.now(), account: "personal", sessionId: "ok", costUsd: 3 });
    fs.appendFileSync(ledgerPath(root), '{"ts":"not-a-number"}\n');
    expect(() => usageSummary()).not.toThrow();
    expect(usageSummary().weekly.costUsd).toBe(3);
  });

  test("usageSummary over a mixed-owner ledger is byte-identical to the session-only ledger", () => {
    // The no-regression pin: loom and ultra lines are new to this file as of
    // CAP-2, and usageSummary feeds the sidebar/dashboard account windows.
    const sessionOnly = freshRoot("summary-a");
    const ts = Date.now();
    for (let i = 0; i < 3; i++) {
      logUsage(entry({ ts, sessionId: `s${i}`, costUsd: 1 }));
    }
    const before = usageSummary();

    const mixed = freshRoot("summary-b");
    for (let i = 0; i < 3; i++) {
      logUsage(entry({ ts, sessionId: `s${i}`, costUsd: 1 }));
    }
    logUsage(entry({ ts, account: "unknown", ownerKind: "loom", ownerId: "l1", costUsd: 9 }));
    logUsage(entry({ ts, account: "unknown", ownerKind: "loom", ownerId: "l2", costUsd: 9 }));
    logUsage(entry({ ts, account: "unknown", ownerKind: "ultra", ownerId: "u1", costUsd: 9 }));
    logUsage(entry({ ts, account: "unknown", ownerKind: "ultra", ownerId: "u2", costUsd: 9 }));
    const after = usageSummary();

    // Including requests counts and the byAccount key set — no phantom row.
    expect(after).toEqual(before);
    expect(Object.keys(after.byAccount)).toEqual(["personal"]);
    expect(sessionOnly).not.toBe(mixed);
  });

  test("usageCostBySession folds only session-owned rows", () => {
    // An ultra/loom line legitimately carries the OWNING chat's sessionId, so
    // an unfiltered fold would inflate that chat's cost.
    const root = freshRoot("scoping");
    logUsage(entry({ sessionId: "chat-1", costUsd: 1.5 }));
    logUsage(entry({ sessionId: "chat-1", ownerKind: "ultra", ownerId: "run-x", costUsd: 5 }));
    logUsage(entry({ sessionId: "chat-1", ownerKind: "loom", ownerId: "loom-y", costUsd: 7 }));
    expect(usageCostBySession().get("chat-1")).toBe(1.5);
    expect(usageTokensBySession().get("chat-1")!.inputTokens).toBe(10);
    expect(root).toBeTruthy();
  });

  test("ledgerSpendUsd filters by owner-kind and owner-id", () => {
    freshRoot("owners");
    logUsage(entry({ ownerKind: "loom", ownerId: "l1", costUsd: 2 }));
    logUsage(entry({ ownerKind: "loom", ownerId: "l1", costUsd: 3 }));
    logUsage(entry({ ownerKind: "loom", ownerId: "l2", costUsd: 100 }));
    logUsage(entry({ ownerKind: "ultra", ownerId: "l1", costUsd: 100 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "l1" })).toBe(5);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "l2" })).toBe(100);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: "l1" })).toBe(100);
    expect(ledgerSpendUsd({ ownerKind: "ultra", ownerId: "nobody" })).toBe(0);
  });

  test("the ledger record carries no cost language", () => {
    // USD-vs-tokens is a property of the projection, never of the record.
    const root = freshRoot("no-currency");
    logUsage(entry());
    const keys = Object.keys(rawLines(root)[0]).sort();
    expect(keys).toEqual([
      "account",
      "cacheCreateTokens",
      "cacheReadTokens",
      "costUsd",
      "inputTokens",
      "model",
      "outputTokens",
      "ownerId",
      "ownerKind",
      "sessionId",
      "ts",
    ]);
    expect(keys).not.toContain("currency");
    expect(keys).not.toContain("unit");
  });

  test("the projection stays exact across a burst of appends within one timestamp tick", () => {
    // Ultra and weave append then re-read inside the same synchronous tick;
    // mtime granularity can be coarser than that, a byte length cannot.
    freshRoot("burst");
    const N = 200;
    for (let i = 1; i <= N; i++) {
      logUsage(entry({ ownerKind: "loom", ownerId: "burst", costUsd: 1 }));
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "burst" })).toBe(i);
    }
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "burst" })).toBe(N);
  });

  test("a torn trailing line is not consumed and is folded once the append completes", () => {
    const root = freshRoot("torn");
    logUsage(entry({ ownerKind: "loom", ownerId: "t", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "t" })).toBe(1);
    const complete = JSON.stringify(entry({ ownerKind: "loom", ownerId: "t", costUsd: 4 }));
    const split = Math.floor(complete.length / 2);
    fs.appendFileSync(ledgerPath(root), complete.slice(0, split));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "t" })).toBe(1); // torn — excluded, no throw
    fs.appendFileSync(ledgerPath(root), complete.slice(split) + "\n");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "t" })).toBe(5); // folded exactly once
  });

  test("logUsage refuses to write outside a temp root under bun test", () => {
    const saved = process.env.TELAR_HOME;
    try {
      delete process.env.TELAR_HOME;
      expect(process.env.NODE_ENV).toBe("test");
      expect(() => logUsage(entry())).toThrow(/logUsage refused/);
    } finally {
      process.env.TELAR_HOME = saved;
    }
  });
});
