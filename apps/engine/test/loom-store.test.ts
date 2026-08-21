/**
 * The Loom store's proof.
 *
 * SANDBOX MECHANISM, ported from `spool-store.test.ts`: an `fs.mkdtempSync`
 * root per suite, cleared between tests, handed to every verb as `LoomPaths`.
 * The root is an ARGUMENT, so there is no global for a sibling suite in the
 * same bun process to move out from under this one and no way for this file to
 * reach an operator's real state root by forgetting a line.
 *
 * WHAT IS ASSERTED BY BEHAVIOUR RATHER THAN BY INSPECTION: "everything goes
 * through `atomicWrite`". A test that greps the module for the identifier
 * proves the identifier is present, not that a write used it. What `atomicWrite`
 * actually guarantees — a unique temp file that is renamed into place and never
 * left behind — is observable: after every write in this suite, the store
 * contains no `.tmp-` leftovers, and the ledger (the one declared exception) is
 * the only file that grew by appending.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LedgerEntry, Loom, TriageEntry } from "@telar/engine-client";
import {
  appendLedger,
  countByState,
  defaultWatch,
  ensureLooms,
  getLoom,
  listLooms,
  listProjectIds,
  loomFile,
  loomPaths,
  programPath,
  projectDir,
  readLedger,
  readLoom,
  readProgramDoc,
  readSentinel,
  readTriage,
  readWatch,
  readWatchRecord,
  storeEntries,
  writeWatchRecord,
  writeLoom,
  writeProgramDoc,
  writeSentinel,
  writeTriage,
  writeWatch,
  type LoomPaths,
  type LoomRuntime,
} from "../src/loom/store";
import { EngineStateError, EngineStore } from "../src/state";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-store-"));
const REPOS = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-repo-"));
let paths: LoomPaths;

beforeEach(() => {
  // A fresh store per test. The engine root is the sandbox; `looms/` under it
  // is what gets cleared, so nothing outside this temp directory is touched.
  fs.rmSync(path.join(ROOT, "looms"), { recursive: true, force: true });
  fs.rmSync(REPOS, { recursive: true, force: true });
  fs.mkdirSync(REPOS, { recursive: true });
  paths = loomPaths(ROOT);
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(REPOS, { recursive: true, force: true });
});

// ── local helpers ───────────────────────────────────────────────────────────
//
// PATHS ARE COMPOSED HERE ON PURPOSE. This suite asserts the LAYOUT, so
// re-deriving it from the module under test would assert nothing.
const loomsRoot = () => path.join(ROOT, "looms");
const projectPath = (projectId: string) => path.join(loomsRoot(), projectId);
const loomPath = (projectId: string, loomId: string) => path.join(projectPath(projectId), "looms", `${loomId}.json`);
const ledgerPath = (projectId: string) => path.join(projectPath(projectId), "ledger.jsonl");
const writeRaw = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Every file under the store, relative to it — the "no temp file survived"
 *  assertion's input, and the layout assertion's. */
function walk(dir: string, base = dir): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

const PROJECT = "project_alpha";

const aLoom = (over: Partial<Loom> = {}): Loom => ({
  id: "lm_one",
  projectId: PROJECT,
  item: "42",
  title: "make the thing work",
  state: "queued",
  attempts: 0,
  ladderRung: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

const anEntry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  at: 1_700_000_000_000,
  kind: "tick",
  summary: "nothing changed",
  ...over,
});

const aTriageEntry = (over: Partial<TriageEntry> = {}): TriageEntry => ({
  item: "42",
  updatedAt: "2026-08-20T10:00:00Z",
  classification: "dispatchable",
  reason: "the acceptance criteria are written out",
  ask: "add the retry",
  at: 1_700_000_000_000,
  ...over,
});

// ── the empty store ─────────────────────────────────────────────────────────

describe("an untouched engine", () => {
  test("lists zero looms rather than throwing or reporting a fault", () => {
    // No `ensureLooms`, no directory, nothing. This is the state of every
    // engine that has never run a loom, which is most of them.
    const listed = listLooms(paths);
    expect(listed.looms).toEqual([]);
    expect(listed.unreadable).toEqual([]);
    expect(listProjectIds(paths)).toEqual([]);
    expect(fs.existsSync(loomsRoot())).toBe(false);
  });

  test("answers every read with its empty state, and none of them throws", () => {
    expect(getLoom(paths, "lm_missing")).toBeNull();
    expect(readLedger(paths, PROJECT)).toEqual([]);
    expect(readTriage(paths, PROJECT)).toEqual({});
    expect(readSentinel(paths, PROJECT)).toBeUndefined();
    // Still nothing on disk: a read must never create the subtree, or "has this
    // project ever run?" stops being answerable.
    expect(fs.existsSync(loomsRoot())).toBe(false);
  });

  test("ensureLooms is idempotent and seeds nothing", () => {
    ensureLooms(paths);
    ensureLooms(paths);
    expect(fs.existsSync(loomsRoot())).toBe(true);
    expect(walk(loomsRoot())).toEqual([]);
  });
});

// ── the layout ──────────────────────────────────────────────────────────────

describe("the layout", () => {
  test("is exactly the four documented paths", () => {
    writeLoom(paths, aLoom());
    appendLedger(paths, PROJECT, anEntry());
    writeTriage(paths, PROJECT, { "42": aTriageEntry() });
    writeWatch(paths, PROJECT, defaultWatch(PROJECT));

    expect(walk(loomsRoot())).toEqual([
      path.join(PROJECT, "ledger.jsonl"),
      path.join(PROJECT, "looms", "lm_one.json"),
      path.join(PROJECT, "triage.json"),
      path.join(PROJECT, "watch.json"),
    ]);
  });

  test("storeEntries covers the whole subtree, ledger included", () => {
    // The ledger is what a session must not be able to rewrite: it is the
    // record of what the system did overnight.
    expect(storeEntries(paths)).toEqual([loomsRoot()]);
    const covered = (file: string) => storeEntries(paths).some((entry) => file.startsWith(entry + path.sep));
    expect(covered(ledgerPath(PROJECT))).toBe(true);
    expect(covered(loomPath(PROJECT, "lm_one"))).toBe(true);
  });

  test("the Program is NOT under the store — it lives in the project repo", () => {
    const repo = path.join(REPOS, "alpha");
    fs.mkdirSync(repo, { recursive: true });
    expect(programPath(repo)).toBe(path.join(repo, ".telar", "loom.md"));
    expect(programPath(repo).startsWith(loomsRoot())).toBe(false);
  });
});

// ── tolerance per row ───────────────────────────────────────────────────────

describe("a corrupt loom file", () => {
  test("appears in `unreadable` and the healthy ones still come back", () => {
    writeLoom(paths, aLoom({ id: "lm_one", item: "1" }));
    writeLoom(paths, aLoom({ id: "lm_three", item: "3" }));
    // Between them, a file that is not JSON at all — half a write, or a hand
    // edit at 2am.
    writeRaw(loomPath(PROJECT, "lm_two"), '{"id":"lm_two","projectId":"proj');

    const listed = listLooms(paths);
    expect(listed.looms.map((l) => l.id)).toEqual(["lm_one", "lm_three"]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]!.file).toBe(loomPath(PROJECT, "lm_two"));
    expect(listed.unreadable[0]!.reason).toContain("lm_two.json");
    // The reason must say what happened to the OTHER looms, or the operator
    // cannot tell a skipped row from a wiped store.
    expect(listed.unreadable[0]!.reason).toContain("nothing was rewritten");
  });

  test("a well-formed JSON file that is not a loom is reported, not skipped silently", () => {
    writeLoom(paths, aLoom());
    writeRaw(loomPath(PROJECT, "lm_bad"), JSON.stringify({ id: "lm_bad", state: "sideways" }));

    const listed = listLooms(paths);
    expect(listed.looms.map((l) => l.id)).toEqual(["lm_one"]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]!.reason).toContain("could not be read as a loom");
  });

  test("`.array().safeParse` semantics are NOT what happens — one bad row is one bad row", () => {
    for (const id of ["lm_a", "lm_b", "lm_c", "lm_d"]) writeLoom(paths, aLoom({ id }));
    writeRaw(loomPath(PROJECT, "lm_e"), "not json");
    // The all-or-nothing spelling would return zero here. It returns four.
    expect(listLooms(paths).looms).toHaveLength(4);
  });

  test("a record whose id does not match its file is refused rather than handed out", () => {
    // A hand-edited record returned under one address and rewritten under
    // another would clobber a loom nobody named.
    writeRaw(loomPath(PROJECT, "lm_one"), JSON.stringify(aLoom({ id: "lm_elsewhere" })));
    const listed = listLooms(paths);
    expect(listed.looms).toEqual([]);
    expect(listed.unreadable[0]!.reason).toContain("is not where it sits");
    expect(getLoom(paths, "lm_one")).toBeNull();
  });

  test("a stray file in looms/ is not a project and is not reported as a broken one", () => {
    ensureLooms(paths);
    fs.writeFileSync(path.join(loomsRoot(), ".DS_Store"), "");
    const listed = listLooms(paths);
    expect(listed.looms).toEqual([]);
    expect(listed.unreadable).toEqual([]);
  });
});

// ── traversal ───────────────────────────────────────────────────────────────

describe("the traversal guard", () => {
  test("refuses `../../etc/passwd` as a loom id", () => {
    expect(() => loomFile(paths, PROJECT, "../../etc/passwd")).toThrow(/invalid loom id/);
    // And through the tolerant reader it is simply not found — never a 500 and
    // never a read of the real file.
    expect(getLoom(paths, "../../etc/passwd")).toBeNull();
  });

  test("refuses `../../etc/passwd` as a project id", () => {
    expect(() => projectDir(paths, "../../etc/passwd")).toThrow(/invalid project id/);
    expect(() => loomFile(paths, "..", "lm_one")).toThrow(/invalid project id/);
  });

  test("refuses a dot-leading project id, which the character class alone would pass", () => {
    expect(() => projectDir(paths, ".")).toThrow(/invalid project id/);
    expect(() => projectDir(paths, "..")).toThrow(/invalid project id/);
    expect(() => projectDir(paths, ".hidden")).toThrow(/invalid project id/);
  });

  test("refuses a separator smuggled into an otherwise legal-looking id", () => {
    expect(() => loomFile(paths, PROJECT, "a/b")).toThrow(/invalid loom id/);
    expect(() => projectDir(paths, "a/b")).toThrow(/invalid project id/);
    expect(() => projectDir(paths, `..${path.sep}escaped`)).toThrow(/invalid project id/);
  });

  test("a planted file outside the store stays unreachable by id", () => {
    const planted = path.join(ROOT, "outside.json");
    fs.writeFileSync(planted, JSON.stringify(aLoom({ id: "outside" })));
    expect(getLoom(paths, "../outside")).toBeNull();
    expect(() => loomFile(paths, PROJECT, "../../../outside")).toThrow();
    // Still there, untouched — the guard refuses, it does not delete.
    expect(fs.existsSync(planted)).toBe(true);
    fs.rmSync(planted);
  });

  /**
   * THE REGRESSION build-routes CAUGHT: `GET /v2/looms/ledger?project=../../etc`
   * answered 200 with `{entries: []}`. The guard was present and correct, but
   * every reader composed its path INSIDE the try that tolerates a missing
   * file, so `projectDir`'s throw landed in the same catch as ENOENT and a
   * refused id came back as the ordinary first-run state.
   *
   * An empty answer is a CLAIM about a project. A malformed id has no project
   * to make a claim about, so the only honest reply is a refusal.
   */
  test("a malformed project id is REFUSED by every reader, not answered as empty", () => {
    for (const bad of ["../../etc", "..", ".", "a/b", `..${path.sep}escaped`]) {
      expect(() => readLedger(paths, bad)).toThrow(/invalid project id/);
      expect(() => readTriage(paths, bad)).toThrow(/invalid project id/);
      expect(() => readWatch(paths, bad)).toThrow(/invalid project id/);
      expect(() => readWatchRecord(paths, bad)).toThrow(/invalid project id/);
      expect(() => readSentinel(paths, bad)).toThrow(/invalid project id/);
      expect(() => listLooms(paths, bad)).toThrow(/invalid project id/);
    }
  });

  test("the refusal survives the file actually existing outside the store", () => {
    // Without the guard, `../outside/ledger.jsonl` would be read and its lines
    // returned as this project's history.
    const outside = path.join(ROOT, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "ledger.jsonl"), `${JSON.stringify(anEntry({ summary: "not yours" }))}\n`);
    expect(() => readLedger(paths, "../outside")).toThrow(/invalid project id/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("a WELL-FORMED id that has never run still degrades — the two failures stay distinct", () => {
    // The fix must not turn "never run" into a refusal; that is the whole point
    // of separating the id guard from the file read.
    expect(readLedger(paths, "project_never")).toEqual([]);
    expect(readTriage(paths, "project_never")).toEqual({});
    expect(readWatch(paths, "project_never")).toEqual(defaultWatch("project_never"));
    expect(listLooms(paths, "project_never")).toEqual({ looms: [], unreadable: [] });
  });

  test("a write to an unaddressable name is LOUD, not silently dropped", () => {
    expect(() => writeLoom(paths, aLoom({ projectId: "../escape" }))).toThrow(/invalid project id/);
    expect(() => appendLedger(paths, "../escape", anEntry())).toThrow(/invalid project id/);
  });
});

// ── the ledger ──────────────────────────────────────────────────────────────

describe("the ledger", () => {
  test("appends one JSON object per line and reads back newest-last", () => {
    appendLedger(paths, PROJECT, anEntry({ at: 1, summary: "one" }));
    appendLedger(paths, PROJECT, anEntry({ at: 2, summary: "two" }));
    appendLedger(paths, PROJECT, anEntry({ at: 3, summary: "three" }));

    expect(readLedger(paths, PROJECT).map((e) => e.summary)).toEqual(["one", "two", "three"]);
    const lines = fs.readFileSync(ledgerPath(PROJECT), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("`limit` tails, still in reading order", () => {
    for (let i = 1; i <= 10; i++) appendLedger(paths, PROJECT, anEntry({ at: i, summary: `n${i}` }));
    expect(readLedger(paths, PROJECT, 3).map((e) => e.summary)).toEqual(["n8", "n9", "n10"]);
    expect(readLedger(paths, PROJECT, 100)).toHaveLength(10);
    expect(readLedger(paths, PROJECT, 0)).toEqual([]);
  });

  test("survives a torn line in the MIDDLE — the surrounding entries still parse", () => {
    appendLedger(paths, PROJECT, anEntry({ at: 1, summary: "before" }));
    // A crash mid-append: half an object, then the next append lands after it.
    fs.appendFileSync(ledgerPath(PROJECT), '{"at":2,"kind":"dispat\n');
    appendLedger(paths, PROJECT, anEntry({ at: 3, summary: "after" }));

    const entries = readLedger(paths, PROJECT);
    expect(entries.map((e) => e.summary)).toEqual(["before", "after"]);
    // The torn line is still ON DISK — the reader steps over it, it does not
    // repair the file behind the operator's back.
    expect(fs.readFileSync(ledgerPath(PROJECT), "utf8")).toContain("dispat");
  });

  test("a valid JSON line that is not a ledger entry is skipped, not thrown", () => {
    appendLedger(paths, PROJECT, anEntry({ summary: "real" }));
    fs.appendFileSync(ledgerPath(PROJECT), `${JSON.stringify({ hello: "world" })}\n`);
    fs.appendFileSync(ledgerPath(PROJECT), "\n\n");
    expect(readLedger(paths, PROJECT).map((e) => e.summary)).toEqual(["real"]);
  });

  test("is the O_APPEND exception — an append never rewrites what is already there", () => {
    appendLedger(paths, PROJECT, anEntry({ at: 1, summary: "first" }));
    const firstLine = fs.readFileSync(ledgerPath(PROJECT), "utf8");
    appendLedger(paths, PROJECT, anEntry({ at: 2, summary: "second" }));
    const both = fs.readFileSync(ledgerPath(PROJECT), "utf8");
    // Byte-for-byte prefix: the existing bytes were not re-serialized.
    expect(both.startsWith(firstLine)).toBe(true);
  });

  test("an entry that will not parse is refused rather than written as a hole", () => {
    expect(() => appendLedger(paths, PROJECT, { kind: "nonsense" } as unknown as LedgerEntry)).toThrow();
    expect(fs.existsSync(ledgerPath(PROJECT))).toBe(false);
  });
});

// ── writes are loud ─────────────────────────────────────────────────────────

describe("writeLoom", () => {
  test("refuses an invalid state and writes nothing", () => {
    expect(() => writeLoom(paths, aLoom({ state: "sideways" as Loom["state"] }))).toThrow();
    expect(fs.existsSync(loomPath(PROJECT, "lm_one"))).toBe(false);
  });

  test("refuses a loom with no item", () => {
    expect(() => writeLoom(paths, aLoom({ item: "" }))).toThrow();
  });

  test("files under the projectId the loom itself claims", () => {
    writeLoom(paths, aLoom({ projectId: "project_beta" }));
    expect(fs.existsSync(loomPath("project_beta", "lm_one"))).toBe(true);
    expect(fs.existsSync(loomPath(PROJECT, "lm_one"))).toBe(false);
  });

  /**
   * `attempts` COUNTS RUNGS CONSUMED, NOT SESSIONS STARTED, and `nextRung` in
   * `ladder.ts` is its sole writer. The store's obligation is purely negative:
   * never invent a value for it. Bumping it on provision would make the LAST
   * enabled rung of every ladder silently unreachable, because `attempts` is
   * capped at the number of enabled rungs — a loom would run out of ladder one
   * rung early and go to `asking` with a cheap remedy untried.
   *
   * This is a persistence test, not a ladder test: `ladder.ts` owns the
   * arithmetic and pins it with its own regressions. What is asserted here is
   * that a round-trip through disk is TRANSPARENT to the field.
   *
   * ── THIS TEST IS CITED BY NAME FROM THE SCHEMA ──────────────────────────
   * `protocol/loom.ts`'s `attempts` block points here to justify leaving the
   * field `.default(0)` instead of tightening it to required — the default is
   * tolerance for an old record, and this test is what stops that tolerance
   * from silently forgiving a writer that drops the field and refunds a loom a
   * rung. RENAMING THIS TEST ORPHANS THAT REFERENCE: update the citation in
   * `packages/engine-client/src/protocol/loom.ts` in the same change, or the
   * schema will vouch for a guard nobody can find.
   */
  test("never invents or resets `attempts` — a round-trip is transparent to the ladder", () => {
    writeLoom(paths, aLoom({ id: "lm_fresh" }));
    expect(readLoom(paths, PROJECT, "lm_fresh")!.attempts).toBe(0);
    expect(readLoom(paths, PROJECT, "lm_fresh")!.ladderRung).toBe(0);

    // A loom mid-ladder survives a write/read cycle unchanged. If the store
    // ever re-defaulted these, a rung would be silently refunded or spent.
    writeLoom(paths, aLoom({ id: "lm_deep", attempts: 2, ladderRung: 2, state: "stuck" }));
    const back = readLoom(paths, PROJECT, "lm_deep")!;
    expect(back.attempts).toBe(2);
    expect(back.ladderRung).toBe(2);
    expect(listLooms(paths).looms.find((l) => l.id === "lm_deep")!.attempts).toBe(2);
  });

  test("round-trips through getLoom without knowing the project", () => {
    writeLoom(paths, aLoom({ id: "lm_a", projectId: "project_alpha" }));
    writeLoom(paths, aLoom({ id: "lm_b", projectId: "project_beta" }));
    expect(getLoom(paths, "lm_b")?.projectId).toBe("project_beta");
    expect(getLoom(paths, "lm_a")?.projectId).toBe("project_alpha");
    expect(getLoom(paths, "lm_c")).toBeNull();
  });

  test("listLooms scoped to one project returns only that project's", () => {
    writeLoom(paths, aLoom({ id: "lm_a", projectId: "project_alpha" }));
    writeLoom(paths, aLoom({ id: "lm_b", projectId: "project_beta" }));
    expect(listLooms(paths, "project_beta").looms.map((l) => l.id)).toEqual(["lm_b"]);
    expect(listLooms(paths).looms).toHaveLength(2);
    // A project the store has never written for is empty, not a fault.
    expect(listLooms(paths, "project_gamma")).toEqual({ looms: [], unreadable: [] });
  });
});

// ── the watch ───────────────────────────────────────────────────────────────

describe("the watch record", () => {
  test("defaults are sane for a project that has never run", () => {
    const watch = readWatch(paths, "project_never");
    expect(watch).toEqual({ projectId: "project_never", running: false, intervalSec: 300, quietChecks: 0 });
    // `running: false` is the only safe default — a store that has never been
    // written must not claim a supervisor is up.
    expect(watch.running).toBe(false);
    expect(readSentinel(paths, "project_never")).toBeUndefined();
    expect(fs.existsSync(loomsRoot())).toBe(false);
  });

  test("an unreadable watch.json degrades to the defaults instead of stopping the supervisor", () => {
    writeRaw(path.join(projectPath(PROJECT), "watch.json"), "{ not json");
    expect(readWatch(paths, PROJECT)).toEqual(defaultWatch(PROJECT));
    writeRaw(path.join(projectPath(PROJECT), "watch.json"), JSON.stringify({ watch: { running: "yes" } }));
    expect(readWatch(paths, PROJECT)).toEqual(defaultWatch(PROJECT));
  });

  test("the projectId is the directory, never the file's claim", () => {
    writeRaw(
      path.join(projectPath(PROJECT), "watch.json"),
      JSON.stringify({ watch: { projectId: "someone_else", running: true, intervalSec: 60, quietChecks: 2 } }),
    );
    expect(readWatch(paths, PROJECT).projectId).toBe(PROJECT);
    expect(readWatch(paths, PROJECT).intervalSec).toBe(60);
  });

  test("writing the schedule PRESERVES the fingerprint, and vice versa", () => {
    writeSentinel(paths, PROJECT, { hash: "abc123", at: 1_700_000_000_000, probe: "42:2026-08-20" });
    writeWatch(paths, PROJECT, { ...defaultWatch(PROJECT), running: true, quietChecks: 4 });

    const record = readWatchRecord(paths, PROJECT);
    expect(record.watch.running).toBe(true);
    expect(record.watch.quietChecks).toBe(4);
    // Discarding it here would make the very next probe report "changed"
    // against nothing and wake an agent for free work.
    expect(record.fingerprint?.hash).toBe("abc123");

    writeSentinel(paths, PROJECT, { hash: "def456", at: 1_700_000_000_001, probe: "43:2026-08-20" });
    expect(readWatchRecord(paths, PROJECT).watch.quietChecks).toBe(4);
    expect(readSentinel(paths, PROJECT)?.hash).toBe("def456");
  });

  test("carries the orchestrator session id, preserved across schedule and probe writes", () => {
    writeWatchRecord(paths, PROJECT, { watch: defaultWatch(PROJECT), orchestratorSessionId: "ses_abc" });
    writeSentinel(paths, PROJECT, { hash: "h1", at: 1, probe: "p" });
    writeWatch(paths, PROJECT, { ...defaultWatch(PROJECT), running: true });

    const record = readWatchRecord(paths, PROJECT);
    expect(record.orchestratorSessionId).toBe("ses_abc");
    expect(record.fingerprint?.hash).toBe("h1");
    expect(record.watch.running).toBe(true);
    // One file, so a summary cannot report a running watch beside a session
    // from before it started.
    expect(walk(loomsRoot())).toEqual([path.join(PROJECT, "watch.json")]);
  });

  test("an absent orchestrator session is absent, not an empty string", () => {
    writeWatch(paths, PROJECT, defaultWatch(PROJECT));
    expect(readWatchRecord(paths, PROJECT).orchestratorSessionId).toBeUndefined();
    writeRaw(path.join(projectPath(PROJECT), "watch.json"), JSON.stringify({ watch: defaultWatch(PROJECT), orchestratorSessionId: "" }));
    expect(readWatchRecord(paths, PROJECT).orchestratorSessionId).toBeUndefined();
  });

  /**
   * WHAT A RESTART HAS TO BE ABLE TO RESUME FROM.
   *
   * build-routes measured a persisted watch dying at the first restart:
   * `loomOverview` kept reporting `running: true` while no probe ever fired, so
   * the deck drew a watch that was not watching. The fix is `resume()` in
   * `startEngine` — re-arm the timer rather than clear the flag, because
   * clearing it would silently stop work the user asked for.
   *
   * That fix is only possible if the store persists enough to rebuild the
   * schedule, which is what this pins: `running` AND `quietChecks` AND
   * `nextProbeAt` AND the fingerprint all survive. `quietChecks` is the one
   * people drop as "derivable" — it is not. Resetting it to zero on restart
   * re-probes a silent repo every five minutes forever, which is exactly the
   * cost the backoff exists to avoid.
   *
   * `nextProbeAt` MUST SURVIVE BY VALUE, NOT BE RECOMPUTED — this is the
   * CRASH-LOOP PROPERTY. A daemon restarting every ten seconds must not fire
   * `probe` every ten seconds. If resume rebased the due time to
   * `now + intervalSec`, or worse treated an absent one as "due immediately",
   * every restart would spend a probe and a crash-looping daemon would hammer
   * the project's tracker for as long as it kept crashing. Honouring the
   * ALREADY-SCHEDULED instant is what makes restart cost nothing.
   */
  test("persists everything a restart needs to resume the schedule rather than reset it", () => {
    writeWatchRecord(paths, PROJECT, {
      watch: {
        ...defaultWatch(PROJECT),
        running: true,
        intervalSec: 1200,
        quietChecks: 5,
        lastProbeAt: 1_700_000_000_000,
        nextProbeAt: 1_700_001_200_000,
      },
      fingerprint: { hash: "steady", at: 1_700_000_000_000, probe: "no change" },
    });

    // A fresh `loomPaths` off the same root — the shape a restarted process
    // sees, holding none of this process's memory.
    const afterRestart = readWatchRecord(loomPaths(ROOT), PROJECT);
    expect(afterRestart.watch.running).toBe(true);
    expect(afterRestart.watch.intervalSec).toBe(1200);
    expect(afterRestart.watch.quietChecks).toBe(5);
    expect(afterRestart.watch.lastProbeAt).toBe(1_700_000_000_000);
    // BY VALUE — the already-scheduled instant, not `now + intervalSec`. A
    // resume that rebased this would make every restart spend a probe.
    expect(afterRestart.watch.nextProbeAt).toBe(1_700_001_200_000);
    expect(afterRestart.fingerprint?.hash).toBe("steady");
  });

  /**
   * "RESUMED BUT NOT YET DUE" MUST STAY DISTINGUISHABLE FROM "NEVER ARMED".
   *
   * A route test reading this record once nearly filed a regression against the
   * store over exactly this: after a probe, `nextProbeAt` sits a full
   * `intervalSec` ahead, so a freshly resumed daemon on the default 300s cadence
   * correctly does nothing for five minutes — which, watched from outside, is
   * indistinguishable from a resume that never armed anything.
   *
   * In BEHAVIOUR the two are identical. In the RECORD they are not, and this
   * pins the signal that separates them, because the way it gets destroyed is
   * somebody making `defaultWatch` stamp a `nextProbeAt` to look complete.
   */
  test("an armed-but-waiting watch is distinguishable from one that was never armed", () => {
    // Never armed: no probe is due, and the record says so by OMISSION.
    const never = readWatch(paths, "project_never");
    expect(never.running).toBe(false);
    expect(never.nextProbeAt).toBeUndefined();

    // Armed and waiting: nothing will fire for a full interval, but the record
    // carries a schedule. `running` plus the PRESENCE of `nextProbeAt` is the
    // answer to "did resume work?" — never watching for a probe.
    writeWatch(paths, PROJECT, {
      ...defaultWatch(PROJECT),
      running: true,
      lastProbeAt: 1_700_000_000_000,
      nextProbeAt: 1_700_000_300_000,
    });
    const armed = readWatch(paths, PROJECT);
    expect(armed.running).toBe(true);
    expect(armed.nextProbeAt).toBe(1_700_000_300_000);
    // A full intervalSec out — the gap that reads as "nothing is happening".
    expect(armed.nextProbeAt! - armed.lastProbeAt!).toBe(armed.intervalSec * 1000);
  });

  test("defaultWatch stamps no schedule — the omission IS the signal", () => {
    // If this ever starts returning a `nextProbeAt`, the test above stops being
    // able to tell the two states apart and the false regression comes back.
    expect(defaultWatch("project_x").nextProbeAt).toBeUndefined();
    expect(defaultWatch("project_x").lastProbeAt).toBeUndefined();
    expect(readWatchRecord(paths, "project_never").watch.nextProbeAt).toBeUndefined();
  });

  test("no fingerprint is not the same as a fingerprint of an empty probe line", () => {
    expect(readSentinel(paths, PROJECT)).toBeUndefined();
    writeSentinel(paths, PROJECT, { hash: "e3b0c442", at: 1, probe: "" });
    expect(readSentinel(paths, PROJECT)).toEqual({ hash: "e3b0c442", at: 1, probe: "" });
  });
});

// ── the triage cache ────────────────────────────────────────────────────────

describe("the triage cache", () => {
  test("round-trips keyed by item ref", () => {
    writeTriage(paths, PROJECT, { "42": aTriageEntry({ item: "42" }), "43": aTriageEntry({ item: "43" }) });
    const cache = readTriage(paths, PROJECT);
    expect(Object.keys(cache).sort()).toEqual(["42", "43"]);
    expect(cache["42"]!.ask).toBe("add the retry");
  });

  test("is tolerant per row — one broken entry does not cost the others", () => {
    writeRaw(
      path.join(projectPath(PROJECT), "triage.json"),
      JSON.stringify({ "42": aTriageEntry({ item: "42" }), "43": { item: "43", classification: "banana" } }),
    );
    const cache = readTriage(paths, PROJECT);
    expect(Object.keys(cache)).toEqual(["42"]);
  });

  test("an unreadable cache is a cold cache, not an error — it is derived and rebuildable", () => {
    writeRaw(path.join(projectPath(PROJECT), "triage.json"), "[]");
    expect(readTriage(paths, PROJECT)).toEqual({});
    writeRaw(path.join(projectPath(PROJECT), "triage.json"), "nonsense");
    expect(readTriage(paths, PROJECT)).toEqual({});
  });

  test("the write is loud", () => {
    expect(() => writeTriage(paths, PROJECT, { "42": { item: "42" } as unknown as TriageEntry })).toThrow();
  });
});

// ── the Program, in the project's own repo ──────────────────────────────────

describe("the Program", () => {
  const repo = () => {
    const dir = path.join(REPOS, "alpha");
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  };

  test("a project with no Program reports the state, not an error", () => {
    const doc = readProgramDoc(PROJECT, repo());
    expect(doc.exists).toBe(false);
    expect(doc.program).toBeNull();
    expect(doc.markdown).toBe("");
    expect(doc.warnings).toEqual([]);
    // It still NAMES the path, so the surface can say where the file would go.
    expect(doc.path).toBe(path.join(repo(), ".telar", "loom.md"));
  });

  test("writes into the repo, not into the engine root, and reads back parsed", () => {
    const dir = repo();
    const markdown = ["# Loom program — alpha", "", "## Work", "base: main", ""].join("\n");
    const doc = writeProgramDoc(PROJECT, dir, markdown);

    expect(doc.exists).toBe(true);
    expect(doc.markdown).toBe(markdown);
    expect(doc.program).not.toBeNull();
    expect(fs.readFileSync(path.join(dir, ".telar", "loom.md"), "utf8")).toBe(markdown);
    // Nothing landed under the store.
    expect(walk(loomsRoot())).toEqual([]);
  });

  test("refuses to escape the project root", () => {
    const dir = repo();
    // A root that is not a directory this machine can reach has nowhere to put
    // the file, and saying so beats writing to a path nobody named.
    expect(() => writeProgramDoc(PROJECT, path.join(dir, "..", "does-not-exist"), "# x")).toThrow(
      /not a directory this machine can reach/,
    );
    // `..` in the root resolves DOWN to the repos temp dir, so the write would
    // land outside the project the caller named. The realpath is what catches
    // it, and the file must not appear in the sibling.
    const sibling = path.join(REPOS, "beta");
    fs.mkdirSync(sibling, { recursive: true });
    writeProgramDoc(PROJECT, path.join(dir, "..", "beta"), "# beta");
    expect(fs.existsSync(path.join(dir, ".telar", "loom.md"))).toBe(false);
    expect(fs.readFileSync(path.join(sibling, ".telar", "loom.md"), "utf8")).toBe("# beta");
  });

  test("refuses a body that is not text", () => {
    expect(() => writeProgramDoc(PROJECT, repo(), { markdown: "x" } as unknown as string)).toThrow(/markdown text/);
  });

  test("leaves no scratch file in the user's repo", () => {
    const dir = repo();
    writeProgramDoc(PROJECT, dir, "# one");
    writeProgramDoc(PROJECT, dir, "# two");
    const inTelar = fs.readdirSync(path.join(dir, ".telar"));
    expect(inTelar).toEqual(["loom.md"]);
    expect(fs.readFileSync(path.join(dir, ".telar", "loom.md"), "utf8")).toBe("# two");
  });
});

// ── the atomic-write claim, asserted by behaviour ───────────────────────────

describe("every document write is atomic", () => {
  test("no `.tmp-` file survives any write in this store", () => {
    writeLoom(paths, aLoom({ id: "lm_a" }));
    writeLoom(paths, aLoom({ id: "lm_a", state: "working" })); // an overwrite
    writeTriage(paths, PROJECT, { "42": aTriageEntry() });
    writeTriage(paths, PROJECT, { "42": aTriageEntry({ ask: "changed" }) });
    writeWatch(paths, PROJECT, defaultWatch(PROJECT));
    writeSentinel(paths, PROJECT, { hash: "h", at: 1, probe: "p" });
    appendLedger(paths, PROJECT, anEntry());

    const files = walk(loomsRoot());
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(files).toEqual([
      path.join(PROJECT, "ledger.jsonl"),
      path.join(PROJECT, "looms", "lm_a.json"),
      path.join(PROJECT, "triage.json"),
      path.join(PROJECT, "watch.json"),
    ]);
  });

  test("a refused write leaves no partial file behind either", () => {
    expect(() => writeLoom(paths, aLoom({ id: "lm_bad", state: "sideways" as Loom["state"] }))).toThrow();
    expect(walk(loomsRoot()).filter((f) => f.includes("lm_bad"))).toEqual([]);
    expect(walk(loomsRoot()).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("an overwrite replaces the document rather than appending to it", () => {
    writeLoom(paths, aLoom({ id: "lm_a", state: "queued" }));
    writeLoom(paths, aLoom({ id: "lm_a", state: "published", publishedUrl: "https://example.test/pr/1" }));
    const raw = fs.readFileSync(loomPath(PROJECT, "lm_a"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).state).toBe("published");
    expect(raw).not.toContain("queued");
  });
});

// ── counts ──────────────────────────────────────────────────────────────────

describe("countByState", () => {
  test("names every state, so the deck's chips never have to guess at zero", () => {
    const counts = countByState([aLoom({ id: "a", state: "working" }), aLoom({ id: "b", state: "working" })]);
    expect(counts.working).toBe(2);
    expect(counts.stuck).toBe(0);
    expect(counts.published).toBe(0);
    expect(Object.keys(counts).sort()).toEqual(
      ["asking", "cancelled", "gating", "parked", "published", "publishing", "queued", "stuck", "working"].sort(),
    );
  });

  test("an empty list is all zeros, not an empty object", () => {
    expect(Object.values(countByState([])).every((n) => n === 0)).toBe(true);
    expect(Object.keys(countByState([]))).toHaveLength(9);
  });
});

// ── the EngineStore seam ────────────────────────────────────────────────────
//
// WHY THIS LIVES IN THE STORE'S SUITE. `startEngine` now attaches a composed
// runtime unconditionally, so the DETACHED path is reachable only by building an
// `EngineStore` directly — which no route test does, and which is exactly the
// construction every other suite in this repo uses. If it is not covered here it
// is covered nowhere.
//
// A REAL `EngineStore`, not a mock, because the thing under test is the
// translation layer: a store `Error` becoming `invalid_request` with its
// sentence intact, a `null` becoming `not_found`, and the refusal that stands in
// for a runtime nobody wired up. A mock would assert my own assumptions back at
// me.

describe("EngineStore's loom seam", () => {
  const engineRoots: string[] = [];
  const projectRoots: string[] = [];

  const newStore = (): EngineStore => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-engine-"));
    engineRoots.push(dir);
    // The git runner is INJECTED so `listProjects`' per-project `rev-parse`
    // never shells out — §14's rule, and the reason this suite is fast and
    // works on a machine with no git.
    return new EngineStore(dir, () => 100, { git: () => ({ status: 128, stdout: "", stderr: "not a repository" }) });
  };

  const withProject = (store: EngineStore, id = "project_one"): string => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-proj-"));
    projectRoots.push(repo);
    store.registerProject({ id, name: "One", root: repo });
    return fs.realpathSync.native(repo);
  };

  afterAll(() => {
    for (const dir of engineRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const dir of projectRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const attachable = (): { runtime: LoomRuntime; closed: () => number } => {
    let closes = 0;
    const loom = aLoom({ id: "lm_rt", projectId: "project_one" });
    const runtime: LoomRuntime = {
      loomWork: () => ({ runs: [] }),
      startLoomWatch: (projectId) => ({ watch: { ...defaultWatch(projectId), running: true } }),
      stopLoomWatch: (projectId) => ({ watch: defaultWatch(projectId) }),
      tickLoom: (projectId) => ({
        run: { id: "run_1", projectId, kind: "tick", state: "running", startedAt: 1, dispatched: [] },
      }),
      dryRunLoom: (projectId) => ({
        run: { id: "run_2", projectId, kind: "dry-run", state: "running", startedAt: 1, dispatched: [] },
      }),
      dispatchLoom: async () => ({ loom }),
      cancelLoom: async () => ({ loom }),
      answerLoom: async () => ({ loom }),
      suggestLoomProgram: () => ({ markdown: "# suggested", findings: [] }),
      ensureLoomSession: async () => ({ sessionId: "ses_one", created: true }),
      close: () => {
        closes += 1;
      },
    };
    return { runtime, closed: () => closes };
  };

  describe("with no runtime attached", () => {
    test("every runtime verb refuses with one sentence, sync and async alike", async () => {
      const store = newStore();
      withProject(store);
      const sentence = /the loom runtime is not attached/;

      expect(() => store.loomWork()).toThrow(sentence);
      expect(() => store.startLoomWatch("project_one")).toThrow(sentence);
      expect(() => store.stopLoomWatch("project_one")).toThrow(sentence);
      expect(() => store.tickLoom("project_one")).toThrow(sentence);
      expect(() => store.dryRunLoom("project_one")).toThrow(sentence);
      expect(() => store.suggestLoomProgram("project_one")).toThrow(sentence);
      // The three async arms REJECT rather than throwing synchronously — a
      // route awaiting them inside a try would not catch a throw raised before
      // the first await.
      await expect(store.dispatchLoom("project_one", { item: "42" })).rejects.toThrow(sentence);
      await expect(store.cancelLoom("lm_one")).rejects.toThrow(sentence);
      await expect(store.answerLoom("lm_one", "yes")).rejects.toThrow(sentence);
      await expect(store.ensureLoomSession("project_one")).rejects.toThrow(sentence);
    });

    test("the refusal is `invalid_request`, not `not_found` — the project is real, the capability is not", () => {
      const store = newStore();
      withProject(store);
      try {
        store.tickLoom("project_one");
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(EngineStateError);
        expect((error as EngineStateError).code).toBe("invalid_request");
      }
    });

    /**
     * THE ONE THAT PROTECTS `daemon.close()`. It calls this unguarded, and the
     * two statements AFTER it are `removeOwnDiscovery` and `lock.release()` — so
     * a throw here does not merely leak a timer, it strands the discovery record
     * and never releases the daemon lock, which the next start then has to
     * break. `close` is the one seam member that must NOT refuse when detached.
     */
    test("closeLoomRuntime is a silent no-op, so shutdown cannot abort on it", () => {
      const store = newStore();
      expect(() => store.closeLoomRuntime()).not.toThrow();
      expect(() => store.closeLoomRuntime()).not.toThrow(); // idempotent
    });

    test("the deck still renders — every persistence verb works without a supervisor", () => {
      const store = newStore();
      withProject(store);
      const overview = store.loomOverview();

      expect(overview.projects).toHaveLength(1);
      expect(overview.projects[0]!.projectId).toBe("project_one");
      expect(overview.projects[0]!.hasProgram).toBe(false);
      expect(overview.projects[0]!.counts.working).toBe(0);
      expect(overview.looms).toEqual([]);
      // The runs arm degrades to empty rather than taking the page down over
      // the one pane that needs a process.
      expect(overview.runs).toEqual([]);
      expect(store.looms()).toEqual({ looms: [], unreadable: [] });
      expect(store.loomLedger("project_one")).toEqual({ entries: [] });
      expect(store.loomTriage("project_one")).toEqual({ entries: [] });
    });
  });

  describe("with a runtime attached", () => {
    test("the verbs delegate and close is called through exactly once per call", async () => {
      const store = newStore();
      withProject(store);
      const { runtime, closed } = attachable();
      store.attachLoomRuntime(runtime);

      expect(store.startLoomWatch("project_one").watch.running).toBe(true);
      expect(store.tickLoom("project_one").run.kind).toBe("tick");
      expect(store.dryRunLoom("project_one").run.kind).toBe("dry-run");
      expect((await store.dispatchLoom("project_one", { item: "42" })).loom.id).toBe("lm_rt");
      expect((await store.ensureLoomSession("project_one")).created).toBe(true);
      expect(store.suggestLoomProgram("project_one").markdown).toBe("# suggested");

      expect(closed()).toBe(0);
      store.closeLoomRuntime();
      expect(closed()).toBe(1);
    });

    test("an unknown project is `not_found` BEFORE the runtime is asked", async () => {
      const store = newStore();
      const { runtime } = attachable();
      store.attachLoomRuntime(runtime);
      // No supervisor should ever be asked to watch something this machine has
      // not registered.
      expect(() => store.startLoomWatch("project_ghost")).toThrow(EngineStateError);
      expect(() => store.tickLoom("project_ghost")).toThrow(/project does not exist/);
      await expect(store.ensureLoomSession("project_ghost")).rejects.toThrow(/project does not exist/);
    });

    test("input validation happens here, so an in-process caller hits the same wall as HTTP", async () => {
      const store = newStore();
      withProject(store);
      store.attachLoomRuntime(attachable().runtime);
      await expect(store.dispatchLoom("project_one", { item: "  " })).rejects.toThrow(/needs the work item/);
      await expect(store.answerLoom("lm_one", "   ")).rejects.toThrow(/needs words/);
    });
  });

  describe("the one-call snapshot", () => {
    test("composes summaries, looms, triage and the orchestrator session from one read", () => {
      const store = newStore();
      const repo = withProject(store);
      // The store's OWN paths accessor — the same one `loomOverview` reads
      // through, so this fixture cannot drift from the layout under test.
      const enginePaths = store.loomStore;

      writeLoom(enginePaths, aLoom({ id: "lm_a", projectId: "project_one", state: "working" }));
      writeLoom(enginePaths, aLoom({ id: "lm_b", projectId: "project_one", state: "stuck" }));
      writeTriage(enginePaths, "project_one", { "42": aTriageEntry() });
      writeWatchRecord(enginePaths, "project_one", {
        watch: { ...defaultWatch("project_one"), running: true },
        orchestratorSessionId: "ses_orch",
      });
      fs.mkdirSync(path.join(repo, ".telar"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".telar", "loom.md"), "# Loom program — One\n");

      const overview = store.loomOverview();
      const summary = overview.projects[0]!;
      expect(summary.hasProgram).toBe(true);
      expect(summary.programPath).toBe(path.join(repo, ".telar", "loom.md"));
      expect(summary.watch.running).toBe(true);
      expect(summary.counts.working).toBe(1);
      expect(summary.counts.stuck).toBe(1);
      expect(summary.counts.published).toBe(0);
      // Sourced from the SAME watch record as the schedule, so a summary cannot
      // report a running watch beside a session from before it started.
      expect(summary.orchestratorSessionId).toBe("ses_orch");
      expect(overview.looms.map((l) => l.id).sort()).toEqual(["lm_a", "lm_b"]);
      expect(overview.triage.map((t) => t.item)).toEqual(["42"]);
    });

    test("a project that has never run reports absence rather than refusing", () => {
      const store = newStore();
      withProject(store);
      const summary = store.loomOverview().projects[0]!;
      expect(summary.hasProgram).toBe(false);
      expect(summary.orchestratorSessionId).toBeUndefined();
      expect(summary.watch.running).toBe(false);
      expect(summary.assumed).toEqual([]);
    });
  });

  describe("the error translation", () => {
    test("an unknown project is `not_found` on the Program arms", () => {
      const store = newStore();
      expect(() => store.loomProgram("project_ghost")).toThrow(/project does not exist/);
      expect(() => store.saveLoomProgram("project_ghost", "# x")).toThrow(/project does not exist/);
    });

    test("a malformed project id reaches the caller as a refusal, not an empty answer", () => {
      // The regression build-routes found, asserted at the layer that translates
      // it: the store's throw must survive as `invalid_request` rather than
      // being swallowed into the ordinary first-run state.
      const store = newStore();
      for (const bad of ["../../etc", ".."]) {
        expect(() => store.loomLedger(bad)).toThrow(EngineStateError);
        expect(() => store.loomTriage(bad)).toThrow(EngineStateError);
        expect(() => store.looms(bad)).toThrow(EngineStateError);
      }
    });

    test("the store's SENTENCE survives translation — it names the file and the next move", () => {
      const store = newStore();
      try {
        store.loomLedger("../../etc");
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(EngineStateError);
        expect((error as EngineStateError).code).toBe("invalid_request");
        // Replacing this with a generic "bad request" would throw away the only
        // useful part.
        expect((error as Error).message).toContain("invalid project id for the loom store");
      }
    });

    test("a missing loom is `not_found`, not an empty object", () => {
      const store = newStore();
      expect(() => store.loom("lm_nothing")).toThrow(EngineStateError);
      expect(() => store.loom("lm_nothing")).toThrow(/loom not found/);
    });

    test("saveLoomProgram writes into the project repo and reads back through loomProgram", () => {
      const store = newStore();
      const repo = withProject(store);
      const saved = store.saveLoomProgram("project_one", "# Loom program — One\n");
      expect(saved.exists).toBe(true);
      expect(saved.path).toBe(path.join(repo, ".telar", "loom.md"));
      expect(store.loomProgram("project_one").markdown).toBe("# Loom program — One\n");
      // Nothing of the Program landed under the engine root.
      expect(fs.existsSync(path.join(store.loomStore.root, "project_one"))).toBe(false);
    });
  });
});
