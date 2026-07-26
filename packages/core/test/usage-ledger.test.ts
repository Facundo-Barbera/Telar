// Story 1.1 / CAP-2 — the one attributed spend ledger (AD-18, AD-20).
// Temp TELAR_HOME (never the real ~/.telar, the looms.test.ts idiom). Exercises:
// owner attribution physically landing on disk, tolerant reads of records
// written before attribution existed, the owner-scoping rule that keeps the
// existing account windows byte-identical, and the byte-offset projection
// cache under append-then-read-in-one-tick.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-ledger-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin before every test.
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  logUsage,
  usageSummary,
  usageCostBySession,
  usageTokensBySession,
  ledgerSpendUsd,
  ledgerReadUnavailable,
  ledgerReadDegraded,
} = await import("../src/usage-ledger");

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

// One ledger line, exactly as it would sit on disk — for the tests that need
// to place bytes themselves rather than go through the port.
const raw = (over: Record<string, unknown> = {}) => JSON.stringify(entry(over)) + "\n";

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

  // THE GUARD AND THE RESOLVER MUST READ ONE VALUE.
  //
  // The test above pins the UNSET and the empty case. Neither reaches the value
  // that actually got through: the guard tested the RAW variable while the
  // write lands wherever telarDir() (manifest.ts) resolves, and telarDir TRIMS
  // first. " " is truthy, so the guard stayed silent; " ".trim() is "", so the
  // resolver fell through to os.homedir()/.telar and a green `bun test` run
  // appended a synthetic billing line to the developer's REAL ledger — the one
  // failure the whole state-root story exists to prevent, defeated by the guard
  // added to prevent it. Every value below is a value telarDir() reads as
  // "unset"; the guard has to agree with it on all of them.
  test("logUsage refuses a WHITESPACE-ONLY TELAR_HOME — the guard reads the same value telarDir() does", () => {
    const saved = process.env.TELAR_HOME;
    try {
      expect(process.env.NODE_ENV).toBe("test");
      for (const blank of [" ", "  ", "\t", "\n", " \t\n "]) {
        process.env.TELAR_HOME = blank;
        expect(() => logUsage(entry())).toThrow(/logUsage refused/);
      }
    } finally {
      process.env.TELAR_HOME = saved;
    }
  });

  // The consequence, proven rather than argued, and hermetically: a REAL child
  // process with a throwaway HOME (os.homedir() is resolved at process start
  // under Bun, so only a child can redirect it) and TELAR_HOME=" ". The
  // assertion that discriminates a fixed guard from a broken one is not the
  // throw — it is that NOTHING was created under the home the write would have
  // landed in. Pre-fix this child exits 0 having written
  // <fakeHome>/.telar/usage.ndjson.
  test("a whitespace-only TELAR_HOME writes NOTHING under the resolved home (real child process)", () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ul-blank-home-"));
    try {
      const fakeHome = path.join(box, "home");
      fs.mkdirSync(fakeHome, { recursive: true });
      const probe = path.join(box, "probe.ts");
      const ledgerModule = JSON.stringify(fileURLToPath(new URL("../src/usage-ledger.ts", import.meta.url)));
      fs.writeFileSync(
        probe,
        [
          `const { logUsage } = await import(${ledgerModule});`,
          `let threw = false;`,
          `try {`,
          `  logUsage({ ts: Date.now(), account: "personal", model: "sonnet", sessionId: "blank", costUsd: 1 });`,
          `} catch {`,
          `  threw = true;`,
          `}`,
          `console.log(JSON.stringify({ threw }));`,
        ].join("\n") + "\n",
      );
      const out = spawnSync(process.execPath, [probe], {
        // TELAR_HOME is whitespace, NOT unset: the empty and unset cases were
        // already guarded, and this is the one that got through.
        env: { ...process.env, HOME: fakeHome, TELAR_HOME: " ", NODE_ENV: "test" },
        encoding: "utf8",
      });
      expect(out.status).toBe(0);
      expect(JSON.parse(out.stdout.trim())).toEqual({ threw: true });
      // The real assertion: the resolved root was never touched. Scanned
      // recursively rather than by listing the home directly — Bun itself
      // creates unrelated entries under a fresh HOME on macOS (`Library/`), so
      // an "empty home" assertion would fail for a reason that has nothing to
      // do with the ledger.
      expect(fs.existsSync(path.join(fakeHome, ".telar"))).toBe(false);
      const under = fs.readdirSync(fakeHome, { recursive: true, encoding: "utf8" });
      expect(under.filter((f) => f.endsWith("usage.ndjson"))).toEqual([]);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  // ── The keyed-row dedupe ──────────────────────────────────────────────────

  test("a duplicate keyed line folds exactly once on both readFold paths, and un-keyed lines still count", () => {
    // The dedupe is a property of the FOLD OVER THE FILE, not of a writer's
    // memory — which is what makes it survive a cache rebuild, a restart and a
    // second writer. Both branches of readFold have to honour it.
    const root = freshRoot("dedupe");
    const keyed = raw({ ownerKind: "loom", ownerId: "K", costUsd: 4, entryKey: "attempt:K:0" });
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(ledgerPath(root), keyed);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "K" })).toBe(4); // primes the byte-offset cache
    // A byte-identical duplicate (the resume/mediation shape) plus a legacy
    // un-keyed row for the same owner.
    fs.appendFileSync(ledgerPath(root), keyed);
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "K", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "K" })).toBe(5); // incremental path
    // Shrink the file so the cached slot cannot be reused: the next read is a
    // full rebuild, and the dedupe must be rebuilt with it.
    fs.writeFileSync(ledgerPath(root), keyed + keyed);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "K" })).toBe(4); // rebuild path
  });

  test("two legacy rows sharing one sessionId and no entryKey still sum", () => {
    // Forecloses the tempting "just key on sessionId" simplification: two chat
    // turns in one session share a sessionId, so keying on it would fold away
    // half of every historical session's spend — a direct AC5 violation.
    const root = freshRoot("legacy-sum");
    const ts = Date.now();
    const legacy = (costUsd: number) => ({
      ts,
      account: "personal",
      model: "sonnet",
      sessionId: "legacy",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd,
    });
    handWrite(root, legacy(2));
    handWrite(root, legacy(3));
    expect(usageCostBySession().get("legacy")).toBe(5);
    expect(usageSummary().weekly.requests).toBe(2);
    expect(ledgerSpendUsd({ ownerKind: "session", ownerId: "legacy" })).toBe(5);
  });

  test("an un-keyed record omits entryKey on disk and a keyed one carries it", () => {
    // The schema materializes the "" default on parse, so the serializer has
    // to drop it — otherwise every historical-shaped line grows a 12th key.
    const root = freshRoot("entrykey-bytes");
    logUsage(entry());
    logUsage(entry({ ownerKind: "loom", ownerId: "L", entryKey: "attempt:L:0" }));
    const [plain, keyed] = rawLines(root);
    expect(Object.keys(plain)).not.toContain("entryKey");
    expect(Object.keys(plain)).toHaveLength(11);
    expect(keyed.entryKey).toBe("attempt:L:0");
  });

  test("a colliding entryKey still APPENDS its row, and the fold still counts it once", () => {
    // Idempotence is never enforced by SUPPRESSING A WRITE. foldLine already
    // makes the duplicate row harmless, so a write-side skip buys one row and
    // pays the audit trail for it: a key that collides for the wrong reason
    // then leaves no row anywhere, and money that `jq -s 'map(.costUsd)|add'`
    // cannot see is money no human can reconcile. An over-count is visible and
    // arguable; a missing row is silent.
    const root = freshRoot("write-append");
    const attempt = { ownerKind: "loom", ownerId: "W", costUsd: 4, entryKey: "attempt:W:0" };
    expect(logUsage(entry(attempt))).toBe(true);
    expect(logUsage(entry(attempt))).toBe(true);
    const rows = rawLines(root);
    expect(rows).toHaveLength(2); // the append-only log keeps both
    expect(rows.map((r) => r.entryKey)).toEqual(["attempt:W:0", "attempt:W:0"]);
    // Both dollars are still on disk to be summed by hand...
    expect(rows.reduce((n, r) => n + Number(r.costUsd), 0)).toBe(8);
    // ...and the fold — the sole guarantee — still bills the event once.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "W" })).toBe(4);
  });

  test("a fold that could not be re-read never suppresses the next row", () => {
    // The measured regression the write-side skip caused: foldAfterFailedRead
    // matched the cache on PATH ALONE, so a key folded from the file that USED
    // to be at this path suppressed a row for the file that is there now.
    // logUsage returned true, nothing was appended, and the spend was gone
    // from disk as well as from the total.
    const root = freshRoot("stale-suppress");
    const attempt = { ownerKind: "loom", ownerId: "R", costUsd: 10, entryKey: "attempt:R:0" };
    logUsage(entry(attempt));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "R" })).toBe(10); // folds the key, caches this inode
    // Rotate: same path, NEW inode, none of the old file's keys.
    const rotated = fs.statSync(ledgerPath(root)).ino;
    fs.rmSync(ledgerPath(root));
    fs.writeFileSync(ledgerPath(root), "");
    expect(fs.statSync(ledgerPath(root)).ino).not.toBe(rotated); // the premise, asserted
    // A transient READ failure that leaves the WRITE path working: readFold
    // opens with "r", appendFileSync does not.
    const realOpen = fs.openSync;
    (fs as any).openSync = (p: unknown, flags: unknown, ...rest: unknown[]) => {
      if (flags === "r") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return (realOpen as any)(p, flags, ...rest);
    };
    try {
      // A fold of the PREVIOUS inode is not a fold of this one, at any price.
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "R" })).toBe(0);
      expect(ledgerReadUnavailable()).toBe(true);
      expect(logUsage(entry(attempt))).toBe(true);
    } finally {
      (fs as any).openSync = realOpen;
    }
    expect(rawLines(root)).toHaveLength(1); // the row exists…
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "R" })).toBe(10); // …and it counts
  });

  // ── readFold under adversarial I/O ────────────────────────────────────────
  // Each of the following names the review finding it reproduces. Every fs
  // patch restores in a `finally` — a leaked patch would corrupt every later
  // suite in the same bun process.

  test("(a) an append landing between the size read and the content read is not re-folded", () => {
    const root = freshRoot("toctou");
    // No cached fold for this path yet, so the next read takes the FULL
    // REBUILD branch — the one that stats, then reads, then caches the stat.
    fs.writeFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "L", costUsd: 1 }));
    const realStat = fs.statSync;
    const realFstat = fs.fstatSync;
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "L", costUsd: 10 }));
    };
    (fs as any).statSync = (...a: unknown[]) => {
      const r = (realStat as any)(...a);
      fire();
      return r;
    };
    (fs as any).fstatSync = (...a: unknown[]) => {
      const r = (realFstat as any)(...a);
      fire();
      return r;
    };
    let raced = 0;
    try {
      raced = ledgerSpendUsd({ ownerKind: "loom", ownerId: "L" });
    } finally {
      (fs as any).statSync = realStat;
      (fs as any).fstatSync = realFstat;
    }
    // The read sees the appended line, so it must COUNT it — and must not
    // cache an offset that would make the next read count it again.
    expect(raced).toBe(11);
    logUsage(entry({ ownerKind: "loom", ownerId: "L", costUsd: 100 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "L" })).toBe(111);
  });

  test("(b) a transient read failure does not poison the fold to zero forever", () => {
    const root = freshRoot("poison");
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "P", costUsd: 7 }));
    const realRead = fs.readSync;
    (fs as any).readSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      expect(() => ledgerSpendUsd({ ownerKind: "loom", ownerId: "P" })).not.toThrow();
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "P" })).toBe(0);
    } finally {
      (fs as any).readSync = realRead;
    }
    // The empty answer must never have been cached.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "P" })).toBe(7);
  });

  test("(c) an I/O failure on the incremental path does not throw out of the read API", () => {
    const root = freshRoot("incr-throw");
    logUsage(entry({ ownerKind: "loom", ownerId: "C", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C" })).toBe(1); // primes the cache
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "C", costUsd: 2 }));
    const realOpen = fs.openSync;
    (fs as any).openSync = () => {
      throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    };
    try {
      // Otherwise a chat GET 500s and an in-flight weave is marked failed.
      expect(() => ledgerSpendUsd({ ownerKind: "loom", ownerId: "C" })).not.toThrow();
    } finally {
      (fs as any).openSync = realOpen;
    }
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C" })).toBe(3);
  });

  test("(d) a same-size in-place rewrite is noticed", () => {
    // An inode-only cache key CANNOT pass this — an in-place rewrite keeps the
    // inode. Only the mtimeMs tiebreaker on the equal-size branch catches it.
    const root = freshRoot("rewrite");
    const ts = Date.now();
    const a = raw({ ts, ownerKind: "loom", ownerId: "aaa", costUsd: 1 });
    const b = raw({ ts, ownerKind: "loom", ownerId: "bbb", costUsd: 1 });
    expect(a.length).toBe(b.length);
    fs.writeFileSync(ledgerPath(root), a);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "aaa" })).toBe(1);
    const before = fs.statSync(ledgerPath(root)).mtimeMs;
    fs.writeFileSync(ledgerPath(root), b);
    // APFS timestamps are sub-microsecond, so an immediate rewrite moves mtime
    // on its own; re-write only if this filesystem's clock is coarser, so the
    // pin is on the cache noticing the rewrite rather than on timer resolution.
    while (fs.statSync(ledgerPath(root)).mtimeMs === before) {
      fs.writeFileSync(ledgerPath(root), b);
    }
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "bbb" })).toBe(1);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "aaa" })).toBe(0);
  });

  test("(d) rotate-then-regrow past the cached offset does not keep pre-rotation entries", () => {
    const root = freshRoot("rotate");
    fs.writeFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "old", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "old" })).toBe(1);
    fs.renameSync(ledgerPath(root), ledgerPath(root) + ".1");
    fs.writeFileSync(
      ledgerPath(root),
      raw({ ownerKind: "loom", ownerId: "new", costUsd: 2 }) +
        raw({ ownerKind: "loom", ownerId: "new", costUsd: 3 }),
    );
    // A (dev, ino) mismatch, not a length comparison, is what catches THIS
    // rotation: rename gives the replacement a new inode, and it is LONGER
    // than the cached offset, so no length check would fire. That is a claim
    // about the RENAME variant only. A truncate-in-place regrow (`> file`,
    // fs.writeFileSync, logrotate copytruncate) KEEPS the inode, grows past
    // the cached offset, and is read as an append — a documented residual of
    // the module (see its cache header), not something this test pins.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "new" })).toBe(5);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "old" })).toBe(0);
  });

  test("(e) a short read loses no bytes, on the very read that observes the growth", () => {
    const root = freshRoot("short");
    logUsage(entry({ ownerKind: "loom", ownerId: "E", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "E" })).toBe(1); // primes the cache
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "E", costUsd: 4 }));
    const realRead = fs.readSync;
    let short = true;
    let calls = 0;
    (fs as any).readSync = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      calls++;
      if (short) {
        short = false;
        return (realRead as any)(fd, buf, off, Math.min(len, 5), pos); // 5 bytes of a whole line
      }
      return (realRead as any)(fd, buf, off, len, pos);
    };
    let during = -1;
    try {
      during = ledgerSpendUsd({ ownerKind: "loom", ownerId: "E" });
    } finally {
      (fs as any).readSync = realRead;
    }
    expect(calls).toBeGreaterThan(1); // it kept reading rather than deferring
    // Merely accounting for the short read (subarray(0, n)) defers the
    // remainder to the NEXT call and fails here; the loop is what makes it
    // exact now.
    expect(during).toBe(5);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "E" })).toBe(5);
  });

  test("(e) a short read on EVERY iteration still loses no bytes and pads nothing", () => {
    // The companion to the bound added for (i): bounding the tail read must not
    // cost the short-read loop. Every read here returns one byte, so the loop
    // has to iterate all the way to the size the fstat promised, and every
    // iteration is a fresh chance to leak the untouched remainder of the read
    // buffer — which Buffer.alloc has zeroed — into the parser.
    const root = freshRoot("short-every");
    logUsage(entry({ ownerKind: "loom", ownerId: "S", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "S" })).toBe(1); // primes the cache
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "S", costUsd: 4 }));
    // A session-owned row too, so the DECODED text is observable as a byAccount
    // key: NUL padding reaching the parser either kills the line outright or
    // survives inside the key, and both are visible here.
    fs.appendFileSync(ledgerPath(root), raw({ sessionId: "short-sess", costUsd: 2 }));
    const realRead = fs.readSync;
    let calls = 0;
    (fs as any).readSync = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      calls++;
      return (realRead as any)(fd, buf, off, Math.min(len, 1), pos);
    };
    let during = -1;
    try {
      during = ledgerSpendUsd({ ownerKind: "loom", ownerId: "S" });
    } finally {
      (fs as any).readSync = realRead;
    }
    expect(calls).toBeGreaterThan(1); // it kept reading rather than deferring
    expect(during).toBe(5); // exact on the read that OBSERVED the growth
    // BUILT, never typed: a raw 0x00 in this source would make the file binary
    // to git and grep, which is exactly what (g) below byte-scans for.
    const NUL = String.fromCharCode(0);
    const accounts = Object.keys(usageSummary().byAccount);
    expect(accounts).toEqual(["personal"]);
    expect(accounts.some((a) => a.includes(NUL))).toBe(false);
    expect(usageSummary().byAccount.personal.weekly.costUsd).toBe(2);
    expect(usageSummary().byAccount.personal.weekly.requests).toBe(1);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "S" })).toBe(5);
  });

  test("(i) a writer appending after every read cannot make one readFold spin", () => {
    // The tail read is BOUNDED by the size the fstat that decided it observed.
    // An unbounded loop that ran until readSync returned 0 cannot terminate
    // while an appender lands a line between iterations — it is not a slow
    // read, it is a read with no end. Bytes that land later are the NEXT call's
    // tail, which is the byte-incremental design's premise, and the assertions
    // below pin that they are deferred rather than lost.
    const root = freshRoot("no-spin");
    logUsage(entry({ ownerKind: "loom", ownerId: "N", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "N" })).toBe(1); // primes the cache
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "N", costUsd: 2 }));
    const realRead = fs.readSync;
    let calls = 0;
    let bailed = false;
    // Returns 0 at the bail instead of throwing: a regression then FAILS an
    // assertion rather than hanging the suite forever.
    const appendingReader = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (calls >= 25) {
        bailed = true;
        return 0;
      }
      calls++;
      const n = (realRead as any)(fd, buf, off, len, pos);
      fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "N", costUsd: 1000 }));
      return n;
    };
    // The INCREMENTAL branch.
    (fs as any).readSync = appendingReader;
    let during = -1;
    try {
      during = ledgerSpendUsd({ ownerKind: "loom", ownerId: "N" });
    } finally {
      (fs as any).readSync = realRead;
    }
    expect(bailed).toBe(false);
    expect(calls).toBeLessThan(25);
    expect(during).toBe(3); // the promised bytes, and only those
    // Every line the writer landed mid-read is still folded — once — by the
    // call that follows. `calls` lines of 1000 plus the 3 already counted.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "N" })).toBe(3 + calls * 1000);

    // The FULL-REBUILD branch reads through the same loop. Shrink the file so
    // the cached slot cannot be reused, then hold the appender open across it.
    fs.writeFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "N", costUsd: 7 }));
    calls = 0;
    bailed = false;
    (fs as any).readSync = appendingReader;
    let rebuilt = -1;
    try {
      rebuilt = ledgerSpendUsd({ ownerKind: "loom", ownerId: "N" });
    } finally {
      (fs as any).readSync = realRead;
    }
    expect(bailed).toBe(false);
    expect(calls).toBeLessThan(25);
    expect(rebuilt).toBe(7);
  });

  test("(f) logUsage reports an unloggable entry instead of silently dropping it", () => {
    const root = freshRoot("drop");
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    try {
      expect(logUsage(entry({ costUsd: 1 }))).toBe(true);
      // `ts` is the one field with no schema default, and z.number() rejects
      // NaN — so this is the whole record vanishing, not one bad field.
      expect(logUsage(entry({ ts: Number.NaN }))).toBe(false);
    } finally {
      console.error = realError;
    }
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("dropped an unloggable usage entry");
    expect(errs[0]).toContain("ts");
    expect(rawLines(root)).toHaveLength(1);
  });

  test("(h) a line torn inside a multi-byte character survives intact", () => {
    const root = freshRoot("utf8");
    logUsage(entry({ ownerKind: "loom", ownerId: "U", costUsd: 1 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "U" })).toBe(1);
    const line = Buffer.from(raw({ account: "café", costUsd: 2, sessionId: "utf8" }), "utf8");
    const cut = line.indexOf(Buffer.from("é", "utf8")) + 1; // mid-character
    fs.appendFileSync(ledgerPath(root), line.subarray(0, cut));
    ledgerSpendUsd({ ownerKind: "loom", ownerId: "U" }); // torn read, carried forward as BYTES
    fs.appendFileSync(ledgerPath(root), line.subarray(cut));
    // Carrying the partial as a decoded string mangles it to U+FFFD here. The
    // priming row above is loom-owned, so it is correctly absent from byAccount.
    expect(Object.keys(usageSummary().byAccount).sort()).toEqual(["café"]);
  });

  // ── The money guard's fail-soft read ──────────────────────────────────────
  // A MEASURED regression rather than a review finding: answering 0 on any
  // failed open discarded a perfectly good in-memory fold. 0 reaches weave.ts
  // as a SUCCESSFUL read — no event, no log line, no duplicate row to
  // reconcile — so a ledger already worth $100 stopped blocking a spawn under
  // a $1 cap. These pin the distinction that fixes it: an UNREADABLE ledger is
  // not an EMPTY one.

  test("(j) a ledger that cannot be opened serves the last known good fold, never 0", () => {
    const root = freshRoot("warm-eacces");
    logUsage(entry({ ownerKind: "loom", ownerId: "M", costUsd: 100 }));
    logUsage(entry({ sessionId: "warm-sess", costUsd: 5 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "M" })).toBe(100); // primes the fold
    fs.chmodSync(ledgerPath(root), 0o000);
    try {
      // The probe means nothing unless the open really does fail.
      expect(() => fs.readFileSync(ledgerPath(root))).toThrow();
      // Stale-and-high is safe for a budget check; zero is not. Every
      // projection over that fold, not just the owner query.
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "M" })).toBe(100);
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "M" })).toBe(100); // and on every later tick
      expect(usageCostBySession().get("warm-sess")).toBe(5);
      expect(usageSummary().weekly.costUsd).toBe(5);
    } finally {
      fs.chmodSync(ledgerPath(root), 0o600);
    }
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "M" })).toBe(100);
  });

  test("(k) an unreadable ledger with NO fold to serve answers 0 and never caches it", () => {
    // (b)'s guarantee restated for the open path: failing SOFT must not become
    // failing SILENT FOREVER. The bytes are placed without ever being read, so
    // this root has no last-known-good fold to fall back on.
    const root = freshRoot("cold-eacces");
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "C0", costUsd: 42 }));
    fs.chmodSync(ledgerPath(root), 0o000);
    try {
      expect(() => fs.readFileSync(ledgerPath(root))).toThrow();
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C0" })).toBe(0);
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C0" })).toBe(0);
    } finally {
      fs.chmodSync(ledgerPath(root), 0o600);
    }
    // The 0 above had to be an ANSWER, never a state: one readable moment and
    // the real total is back.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C0" })).toBe(42);
  });

  test("(l) a missing ledger answers 0 and is never served some other fold", () => {
    // The boundary the fix must not overshoot. ENOENT is the ledger's
    // legitimate empty state, so serving a fold for it would invent spend out
    // of a file that is not there — from another root, or from this one before
    // it was rotated away.
    const a = freshRoot("enoent-a");
    logUsage(entry({ ownerKind: "loom", ownerId: "Z", costUsd: 9 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "Z" })).toBe(9); // the cache now holds root A
    freshRoot("enoent-b");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "Z" })).toBe(0);
    expect(usageSummary().weekly.requests).toBe(0);
    process.env.TELAR_HOME = a;
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "Z" })).toBe(9);
    fs.rmSync(ledgerPath(a));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "Z" })).toBe(0);
  });

  // ── The failed read, made OBSERVABLE ─────────────────────────────────────
  // (j)/(k) fixed WHAT a failed read answers. These pin that a caller can tell
  // that it failed at all: (k)'s 0 is byte-identical to a successful read of an
  // empty ledger, so weave.ts records it as a SUCCESSFUL read of 0, maxCostUsd
  // stops binding and no event fires. The read still must not throw — (c) pins
  // that a chat GET cannot 500 and an in-flight weave cannot be failed by one —
  // so the signal is a separate predicate over the LAST read.

  test("(m) ledgerReadUnavailable is FALSE for every ledger that was actually read — missing, empty or full", () => {
    const root = freshRoot("avail-false");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "V" })).toBe(0); // ENOENT
    expect(ledgerReadUnavailable()).toBe(false); // a ledger that is not there really IS worth 0
    fs.writeFileSync(ledgerPath(root), "");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "V" })).toBe(0); // present and empty
    expect(ledgerReadUnavailable()).toBe(false);
    logUsage(entry({ ownerKind: "loom", ownerId: "V", costUsd: 3 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "V" })).toBe(3);
    expect(ledgerReadUnavailable()).toBe(false);
    // Every projection is a fold-producing read, so each answers for itself.
    usageSummary();
    expect(ledgerReadUnavailable()).toBe(false);
    usageCostBySession();
    expect(ledgerReadUnavailable()).toBe(false);
    usageTokensBySession();
    expect(ledgerReadUnavailable()).toBe(false);
  });

  test("(m) a cold unreadable ledger answers 0 AND reports itself unavailable, and one readable moment clears it", () => {
    const root = freshRoot("avail-true");
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(ledgerPath(root), raw({ ownerKind: "loom", ownerId: "C1", costUsd: 42 }));
    fs.chmodSync(ledgerPath(root), 0o000);
    try {
      expect(() => fs.readFileSync(ledgerPath(root))).toThrow(); // the probe means nothing unless it fails
      expect(() => ledgerSpendUsd({ ownerKind: "loom", ownerId: "C1" })).not.toThrow();
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C1" })).toBe(0); // the un-interrogable number
      expect(ledgerReadUnavailable()).toBe(true); // …and how a caller learns not to trust it
      expect(usageSummary().weekly.costUsd).toBe(0);
      expect(ledgerReadUnavailable()).toBe(true); // and on every later tick
    } finally {
      fs.chmodSync(ledgerPath(root), 0o600);
    }
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "C1" })).toBe(42);
    expect(ledgerReadUnavailable()).toBe(false); // a property of the LAST read, never a latch
  });

  test("(m) a stale-but-real fold served under EACCES is NOT reported unavailable", () => {
    // The boundary the signal must not overshoot. (j) serves the last known
    // good fold for THIS file, and stale-and-high still binds a budget where
    // zero does not — calling that unavailable would fail closed on a number
    // that is safe.
    const root = freshRoot("avail-warm");
    logUsage(entry({ ownerKind: "loom", ownerId: "WS", costUsd: 100 }));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "WS" })).toBe(100); // primes the fold
    fs.chmodSync(ledgerPath(root), 0o000);
    try {
      expect(() => fs.readFileSync(ledgerPath(root))).toThrow();
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "WS" })).toBe(100);
      expect(ledgerReadUnavailable()).toBe(false);
    } finally {
      fs.chmodSync(ledgerPath(root), 0o600);
    }
  });

  // ── The WIDER signal, for a per-row readout ───────────────────────────────
  // (m)'s last case pins that a served stale fold is deliberately NOT
  // "unavailable": it is real, it is a lower bound, and stale-and-high still
  // binds a budget where zero does not. That is right for weave.ts and wrong
  // for a DISPLAY, which asks a row-scoped question the file-scoped predicate
  // cannot answer: a fold taken before a row was appended answers 0 for that
  // row, and a bare 0 is indistinguishable from "this session never spent
  // anything". ledgerReadDegraded() is the second predicate, and these pin that
  // it covers BOTH degraded cases without touching the first one's meaning.

  test("(n) ledgerReadDegraded is TRUE for a served STALE fold, where ledgerReadUnavailable is false", () => {
    const root = freshRoot("degraded-warm");
    // A row for one session, then a successful read: the fold is now warm and
    // knows only about `old`.
    logUsage(entry({ sessionId: "old", costUsd: 5 }));
    expect(usageCostBySession().get("old")).toBe(5);
    expect(ledgerReadDegraded()).toBe(false); // a real read is not degraded
    // A row appended for a DIFFERENT session — the packaged app writing while
    // this process holds a warm fold — and then the read fails. chmod keeps the
    // inode, so identity still matches and the stale fold is served.
    handWrite(root, entry({ sessionId: "fresh", costUsd: 12.34 }));
    fs.chmodSync(ledgerPath(root), 0o000);
    try {
      expect(() => fs.readFileSync(ledgerPath(root))).toThrow();
      // The stale fold is real about what it saw…
      expect(usageCostBySession().get("old")).toBe(5);
      // …and SILENT about what it did not: `fresh` reads exactly like a session
      // that never spent anything. This 0 is the wrong number, and the narrow
      // predicate cannot flag it.
      expect(usageCostBySession().get("fresh")).toBeUndefined();
      expect(ledgerReadUnavailable()).toBe(false); // unchanged, and correct for a budget
      expect(ledgerReadDegraded()).toBe(true); // the readout's signal
    } finally {
      fs.chmodSync(ledgerPath(root), 0o600);
    }
    // One readable moment and both go back to describing a real read.
    expect(usageCostBySession().get("fresh")).toBe(12.34);
    expect(ledgerReadDegraded()).toBe(false);
  });

  test("(n) ledgerReadDegraded is TRUE when nothing could be served, and FALSE for every real read", () => {
    const cold = freshRoot("degraded-cold");
    fs.mkdirSync(cold, { recursive: true });
    fs.appendFileSync(ledgerPath(cold), raw({ ownerKind: "loom", ownerId: "D1", costUsd: 42 }));
    fs.chmodSync(ledgerPath(cold), 0o000);
    try {
      expect(() => fs.readFileSync(ledgerPath(cold))).toThrow();
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "D1" })).toBe(0);
      expect(ledgerReadDegraded()).toBe(true); // strictly wider: true wherever unavailable is
      expect(ledgerReadUnavailable()).toBe(true);
    } finally {
      fs.chmodSync(ledgerPath(cold), 0o600);
    }
    // The boundary it must not overshoot — a read that reached the file is not
    // degraded, whatever it found there.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "D1" })).toBe(42);
    expect(ledgerReadDegraded()).toBe(false);
    const empty = freshRoot("degraded-empty");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "D1" })).toBe(0); // ENOENT
    expect(ledgerReadDegraded()).toBe(false);
    fs.writeFileSync(ledgerPath(empty), "");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: "D1" })).toBe(0); // present and empty
    expect(ledgerReadDegraded()).toBe(false);
  });

  test("(g) neither the ledger module nor this suite contains a raw NUL byte", () => {
    // A rendered diff shows a raw 0x00 as a SPACE, so a reviewer reading the
    // diff sees different code than what is on disk — and git/grep treat the
    // whole file as binary. Only a byte scan can catch it.
    for (const rel of ["../src/usage-ledger.ts", "./usage-ledger.test.ts"]) {
      const buf = fs.readFileSync(path.join(import.meta.dir, rel));
      expect({ rel, nul: buf.indexOf(0) }).toEqual({ rel, nul: -1 });
    }
  });
});
