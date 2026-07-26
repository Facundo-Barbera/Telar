// AD-18 — LOOM SPEND IS IDEMPOTENT BECAUSE THE LEDGER IS, NOT BECAUSE THE
// WRITER REMEMBERS.
//
// weave.test.ts covers the in-run mediation case, where one runWeave call
// settles the same child more than once. That case is BOUNDED (1 +
// MEDIATION_BUDGET settles per required subgoal) and, crucially, it is the one
// case a `Set<childId>` held by the runWeave closure would also fix. The case
// that discriminates a real fix from a cosmetic one is the RESUME: resumeLoom /
// steerLoom / rejectLoom / answerBlocked all re-enter dispatchExecution →
// runWeave in a NEW PROCESS, and runWeave's own `finished`/`runningThread`/
// `running` maps are FUNCTION LOCALS rebuilt empty on every entry (weave.ts,
// declared inside `runWeave`), so tick re-schedules a subgoal whose child is
// already `done` on disk, and dispatcher.ts's `spawnChild` reuse-by-subGoalId
// branch hands that child back with attempts[] intact. It is unbounded — every
// human resume adds another full re-record — and no amount of process memory
// can see it.
//
// Those two are cited by SYMBOL rather than by line on purpose: the line
// numbers this header used to carry were wrong within one editing round, and
// both files are edited by other work. A line number names a slot; grep finds
// a symbol. Same policy as deferred-work.md's citation note.
//
// So this file spends genuinely separate OS processes on ONE TELAR_HOME. Any
// implementation whose dedupe lives in a module-global memo passes every test in
// weave.test.ts and fails the first test here.
//
// The mirror image lives here too, and it is the one the key SHAPE has to earn:
// two processes that are genuinely CONCURRENT rather than sequential. Both read
// the same persisted child before either writes, so both see the same
// attempts.length and both append a DIFFERENT attempt at the same index. An
// entryKey derived from the index alone makes those two events one event, and
// the fold — correctly, given what it was told — drops the second. Sequential
// resumes can never catch that; the barrier below is what makes the overlap
// real instead of hoped-for.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pin is a TOP-LEVEL STATEMENT and every value import below is an
// `await import` placed AFTER it. Static imports are hoisted and evaluated
// before the first top-level statement runs, so a static value import would
// load the module graph against the ambient root — safe only for as long as
// every resolver stays lazy, which is exactly the assumption CAP-1 exists to
// stop relying on.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spend-idem-"));
process.env.TELAR_HOME = home;

const { ledgerSpendUsd } = await import("../src/usage-ledger");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const usageLedgerFile = () => path.join(home, "usage.ndjson");

function loomLinesFor(loomId: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = fs.readFileSync(usageLedgerFile(), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ownerKind === "loom" && e.ownerId === loomId);
}

describe("loom spend idempotence across PROCESSES (AD-18)", () => {
  // Absolute paths, because the probes live in the temp home and resolve
  // `../src/...` relative to themselves otherwise.
  const modulePath = (rel: string) => JSON.stringify(fileURLToPath(new URL(rel, import.meta.url)));
  const LOOMS = modulePath("../src/looms.ts");
  const WEAVE = modulePath("../src/weave.ts");
  const LEDGER = modulePath("../src/usage-ledger.ts");

  const SUBGOAL = JSON.stringify({
    id: "s1",
    title: "t",
    detail: "d",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
  });
  // A production-shaped AttemptRecord — executor.ts only ever PUSHES one of
  // these (:1211/1397/1513/1894), and every one of them mints its own `id`
  // (AD-18's billing identity; weave.test.ts's producer scan pins that it does).
  // The literal id here stands in for a minted one: what matters below is that
  // it is unique per ATTEMPT and carried on the record, not how it was produced.
  const ATTEMPT = JSON.stringify({
    id: "att-resume-probe",
    n: 1,
    role: "dev",
    model: "m",
    startedAt: 1,
    endedAt: 2,
    costUsd: 2,
  });

  function probe(name: string, lines: string[]): string {
    const file = path.join(home, name);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  // NODE_ENV is deliberately NOT "test" in the children: they stand in for the
  // packaged server / dev process, and logUsage's test guard (which refuses to
  // write with NODE_ENV=test and no TELAR_HOME) is covered elsewhere. TELAR_HOME
  // is passed explicitly, so all three children share ONE state root.
  function run(file: string, arg?: string): { stdout: string; stderr: string; status: number | null } {
    const env = { ...process.env, TELAR_HOME: home, NODE_ENV: "production" as const };
    const out = spawnSync(process.execPath, arg === undefined ? [file] : [file, arg], {
      env,
      encoding: "utf8",
    });
    return { stdout: out.stdout, stderr: out.stderr, status: out.status };
  }

  // The same thing UNSYNCHRONOUSLY: two of these are in flight at once, which
  // is the entire point of the concurrency test below. spawnSync cannot express
  // it — it blocks the parent until the child exits, so two spawnSync calls are
  // two sequential runs no matter what the children do.
  function runAsync(file: string, arg: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
    const env = { ...process.env, TELAR_HOME: home, NODE_ENV: "production" as const };
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file, arg], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (status) => resolve({ stdout, stderr, status }));
    });
  }

  test("three separate processes on one TELAR_HOME: a resume re-settles a persisted child and bills nothing new", () => {
    // PROCESS A — the original run. A real child loom is created and persisted
    // through looms.ts, so process B reads the same records production would.
    const probeA = probe("probe-a.ts", [
      `const { createLoom, saveLoom, getLoom } = await import(${LOOMS});`,
      `const { runWeave } = await import(${WEAVE});`,
      `const root = createLoom({ project: "p", kind: "custom", title: "root", prompt: "x", account: "personal" });`,
      `saveLoom(root);`,
      `const child = createLoom({ project: "p", kind: "quickfix", title: "c", prompt: "y", account: "personal", parentLoomId: root.id, subGoalId: "s1" });`,
      `saveLoom(child);`,
      `await runWeave(root, [${SUBGOAL}], {`,
      `  spawnChild: () => getLoom(child.id),`,
      `  runChild: async (c) => { c.state = "done"; c.attempts.push(${ATTEMPT}); saveLoom(c); return c; },`,
      `  onState: saveLoom,`,
      `});`,
      `console.log(JSON.stringify({ rootId: root.id, childId: child.id }));`,
    ]);
    const a = run(probeA);
    expect(a.stderr).toBe("");
    expect(a.status).toBe(0);
    const ids = JSON.parse(a.stdout.trim()) as { rootId: string; childId: string };

    // One $2 attempt, one row.
    expect(loomLinesFor(ids.rootId)).toHaveLength(1);

    // PROCESS B — THE RESUME. Fresh process, therefore fresh runWeave locals,
    // fresh module state, fresh everything. spawnChild returns the PERSISTED
    // child with its historical attempts[]; runChild appends nothing, because
    // nothing new was spent. The pre-fix code re-wrote the child's cumulative
    // total here and the ledger became $4.
    const probeB = probe("probe-b.ts", [
      `const ids = JSON.parse(process.argv[2]);`,
      `const { saveLoom, getLoom } = await import(${LOOMS});`,
      `const { runWeave } = await import(${WEAVE});`,
      `const root = getLoom(ids.rootId);`,
      `await runWeave(root, [${SUBGOAL}], {`,
      `  spawnChild: () => getLoom(ids.childId),`,
      `  runChild: async (c) => { c.state = "done"; return c; },`,
      `  onState: saveLoom,`,
      `});`,
      `console.log(JSON.stringify({ attempts: getLoom(ids.childId).attempts.length }));`,
    ]);
    const b = run(probeB, JSON.stringify(ids));
    expect(b.stderr).toBe("");
    expect(b.status).toBe(0);
    // The resume really did re-settle a child carrying its historical attempt —
    // without this the test would be vacuously green.
    expect(JSON.parse(b.stdout.trim())).toEqual({ attempts: 1 });

    // PROCESS C — an independent reader, so the answer comes from the FILE and
    // not from any fold either writer happened to be holding.
    const probeC = probe("probe-c.ts", [
      `const ids = JSON.parse(process.argv[2]);`,
      `const { ledgerSpendUsd } = await import(${LEDGER});`,
      `console.log(String(ledgerSpendUsd({ ownerKind: "loom", ownerId: ids.rootId })));`,
    ]);
    const c = run(probeC, JSON.stringify(ids));
    expect(c.stderr).toBe("");
    expect(c.status).toBe(0);
    expect(Number(c.stdout.trim())).toBeCloseTo(2);

    // Belt and braces. The resume DID append a row — the write is never
    // suppressed, because the duplicate line is the audit trail that a second
    // settle happened at all, and suppressing it would be the one way to lose
    // that evidence. What makes it harmless is that both rows carry the same
    // key, so this process — which never saw either writer, and folds from the
    // FILE — still answers 2.
    const rows = loomLinesFor(ids.rootId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((l) => String(l.entryKey))).size).toBe(1);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: ids.rootId })).toBeCloseTo(2);
  });

  test("LEGACY records: two CONCURRENT processes appending a different attempt at the same index each bill their own — no silent under-count", () => {
    // THE FAILURE MODE AN INDEX-ONLY KEY HAS, proven with real overlap rather
    // than argued. Setup persists a child already carrying ONE attempt. Two
    // processes then start; each re-reads that child (observing attempts.length
    // === 1), each announces itself at a filesystem barrier, and NEITHER
    // proceeds until BOTH have announced — so both reads provably precede both
    // writes. Each then appends its OWN genuinely different attempt at index 1,
    // worth $3 and $7 against a $1 shared prefix.
    //
    // Keyed on (loom id, index) both mint `attempt:<childId>:1`; the fold folds
    // a key at most once, so it drops one — $4 or $8 on the ledger for $11 of
    // real work, with no event, no log line and no way to notice.
    //
    // The attempts here carry NO minted id, i.e. they are the shape already
    // sitting in every loom.json written before AttemptRecord.id existed, and
    // this pins that attemptKey's legacy branch — (loom id, index, startedAt) —
    // still discriminates them. Its RESIDUAL, two attempts stamped in the same
    // millisecond, is what the next test closes; startedAt is set explicitly
    // here so this test asserts the key rule rather than racing the clock.
    const barrierDir = path.join(home, "barrier-concurrent");
    fs.mkdirSync(barrierDir, { recursive: true });
    const SHARED = JSON.stringify({ n: 1, role: "dev", model: "m", startedAt: 100, endedAt: 101, costUsd: 1 });

    const setup = probe("probe-conc-setup.ts", [
      `const { createLoom, saveLoom } = await import(${LOOMS});`,
      `const root = createLoom({ project: "p", kind: "custom", title: "root", prompt: "x", account: "personal" });`,
      `saveLoom(root);`,
      `const child = createLoom({ project: "p", kind: "quickfix", title: "c", prompt: "y", account: "personal", parentLoomId: root.id, subGoalId: "s1" });`,
      `child.attempts.push(${SHARED});`,
      `saveLoom(child);`,
      `console.log(JSON.stringify({ rootId: root.id, childId: child.id }));`,
    ]);
    const s = run(setup);
    expect(s.stderr).toBe("");
    expect(s.status).toBe(0);
    const ids = JSON.parse(s.stdout.trim()) as { rootId: string; childId: string };
    expect(loomLinesFor(ids.rootId)).toHaveLength(0); // setup billed nothing

    // The racer. It deliberately does NOT persist: saveLoom writes through a
    // FIXED `loom.json.tmp` name, so two processes saving one loom id at once
    // can interleave in the temp file. That hazard is real but it is a
    // different subject — this test is about the LEDGER, whose writer is a
    // single O_APPEND line and is safe under exactly this concurrency.
    const racer = probe("probe-conc-racer.ts", [
      `const fs = await import("node:fs");`,
      `const cfg = JSON.parse(process.argv[2]);`,
      `const { getLoom } = await import(${LOOMS});`,
      `const { runWeave } = await import(${WEAVE});`,
      // READ FIRST — before the barrier, so the observation is genuinely made
      // against the pre-race file and not against the peer's write.
      `const child = getLoom(cfg.childId);`,
      `const observed = child.attempts.length;`,
      `fs.writeFileSync(cfg.barrierDir + "/" + cfg.tag, "1");`,
      `const deadline = Date.now() + 20000;`,
      `while (fs.readdirSync(cfg.barrierDir).length < 2) {`,
      `  if (Date.now() > deadline) { console.error("barrier timeout"); process.exit(3); }`,
      `  await new Promise((r) => setTimeout(r, 2));`,
      `}`,
      `const root = getLoom(cfg.rootId);`,
      `await runWeave(root, [${SUBGOAL}], {`,
      `  spawnChild: () => child,`,
      `  runChild: async (c) => {`,
      `    c.state = "done";`,
      `    c.attempts.push({ n: 2, role: "dev", model: "m", startedAt: cfg.startedAt, endedAt: cfg.startedAt + 1, costUsd: cfg.costUsd });`,
      `    return c;`,
      `  },`,
      `});`,
      `console.log(JSON.stringify({ tag: cfg.tag, observed }));`,
    ]);
    const cfg = (tag: string, costUsd: number, startedAt: number) =>
      JSON.stringify({ ...ids, barrierDir, tag, costUsd, startedAt });

    return Promise.all([
      runAsync(racer, cfg("a", 3, 1000)),
      runAsync(racer, cfg("b", 7, 2000)),
    ]).then(([a, b]) => {
      expect(a.stderr).toBe("");
      expect(b.stderr).toBe("");
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      // The race really was a race: both processes read the SAME one-attempt
      // child, so both genuinely wrote to index 1. Without this the test could
      // pass by accidentally serializing.
      expect(JSON.parse(a.stdout.trim())).toEqual({ tag: "a", observed: 1 });
      expect(JSON.parse(b.stdout.trim())).toEqual({ tag: "b", observed: 1 });

      const keys = [...new Set(loomLinesFor(ids.rootId).map((l) => String(l.entryKey)))].sort();
      expect(keys).toEqual(
        [
          `attempt:${ids.childId}:0:100`, // the shared prefix — both wrote it, it folds once
          `attempt:${ids.childId}:1:1000`, // racer a
          `attempt:${ids.childId}:1:2000`, // racer b
        ].sort(),
      );
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: ids.rootId })).toBeCloseTo(11);
    });
  });

  test("two CONCURRENT processes appending in the SAME MILLISECOND each bill their own — the minted id, not the clock", () => {
    // THE ANNIHILATION THE (loom id, index, startedAt) KEY STILL HAD, closed and
    // proven with the same real overlap as the test above. Identical setup —
    // both processes read one persisted child at attempts.length === 1, meet at
    // a filesystem barrier so both reads provably precede both writes, and each
    // appends its own genuinely different attempt at index 1 — except that both
    // attempts (and the shared prefix) carry the SAME startedAt. Under the
    // previous key that made two events one: `attempt:<childId>:1:<stamp>` for
    // both, the fold kept one and dropped the other, and $11 of real work billed
    // $4 with no ledger row and no event.
    //
    // Date.now() has millisecond resolution and two SDK calls can be launched
    // inside one, so this is a window and not a fantasy. Each racer mints its
    // own id in its OWN process the way executor.ts's producers do, so the two
    // attempts are two events regardless of what the clock said. The assertion
    // below reconstructs the OLD key from what each racer reported and shows the
    // two really would have been the same string.
    const STAMP = 1_700_000_000_999;
    const SHARED_ID = "att-shared-samems";
    const barrierDir = path.join(home, "barrier-samems");
    fs.mkdirSync(barrierDir, { recursive: true });
    const SHARED = JSON.stringify({
      id: SHARED_ID,
      n: 1,
      role: "dev",
      model: "m",
      startedAt: STAMP,
      endedAt: STAMP + 1,
      costUsd: 1,
    });

    const setup = probe("probe-samems-setup.ts", [
      `const { createLoom, saveLoom } = await import(${LOOMS});`,
      `const root = createLoom({ project: "p", kind: "custom", title: "root", prompt: "x", account: "personal" });`,
      `saveLoom(root);`,
      `const child = createLoom({ project: "p", kind: "quickfix", title: "c", prompt: "y", account: "personal", parentLoomId: root.id, subGoalId: "s1" });`,
      `child.attempts.push(${SHARED});`,
      `saveLoom(child);`,
      `console.log(JSON.stringify({ rootId: root.id, childId: child.id }));`,
    ]);
    const s = run(setup);
    expect(s.stderr).toBe("");
    expect(s.status).toBe(0);
    const ids = JSON.parse(s.stdout.trim()) as { rootId: string; childId: string };
    expect(loomLinesFor(ids.rootId)).toHaveLength(0); // setup billed nothing

    const racer = probe("probe-samems-racer.ts", [
      `const fs = await import("node:fs");`,
      `const crypto = await import("node:crypto");`,
      `const cfg = JSON.parse(process.argv[2]);`,
      `const { getLoom } = await import(${LOOMS});`,
      `const { runWeave } = await import(${WEAVE});`,
      // READ FIRST — before the barrier, so the observation is genuinely made
      // against the pre-race file and not against the peer's write.
      `const child = getLoom(cfg.childId);`,
      `const observed = child.attempts.length;`,
      `fs.writeFileSync(cfg.barrierDir + "/" + cfg.tag, "1");`,
      `const deadline = Date.now() + 20000;`,
      `while (fs.readdirSync(cfg.barrierDir).length < 2) {`,
      `  if (Date.now() > deadline) { console.error("barrier timeout"); process.exit(3); }`,
      `  await new Promise((r) => setTimeout(r, 2));`,
      `}`,
      // Minted in THIS process, exactly as executor.ts's four producers mint it.
      // Two independent processes therefore cannot agree on it, which is the
      // whole property — no shared counter, no shared clock, nothing to collide.
      `const attemptId = crypto.randomUUID();`,
      `const root = getLoom(cfg.rootId);`,
      `await runWeave(root, [${SUBGOAL}], {`,
      `  spawnChild: () => child,`,
      `  runChild: async (c) => {`,
      `    c.state = "done";`,
      `    c.attempts.push({ id: attemptId, n: 2, role: "dev", model: "m", startedAt: cfg.startedAt, endedAt: cfg.startedAt + 1, costUsd: cfg.costUsd });`,
      `    return c;`,
      `  },`,
      `});`,
      `console.log(JSON.stringify({ tag: cfg.tag, observed, attemptId, startedAt: cfg.startedAt }));`,
    ]);
    const cfg = (tag: string, costUsd: number) => JSON.stringify({ ...ids, barrierDir, tag, costUsd, startedAt: STAMP });

    return Promise.all([runAsync(racer, cfg("a", 3)), runAsync(racer, cfg("b", 7))]).then(([a, b]) => {
      expect(a.stderr).toBe("");
      expect(b.stderr).toBe("");
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as { tag: string; observed: number; attemptId: string; startedAt: number };
      const rb = JSON.parse(b.stdout.trim()) as { tag: string; observed: number; attemptId: string; startedAt: number };

      // The race really was a race: both processes read the SAME one-attempt
      // child, so both genuinely wrote to index 1. Without this the test could
      // pass by accidentally serializing.
      expect([ra.observed, rb.observed]).toEqual([1, 1]);
      // ...and the collision condition really is present: same index, same
      // millisecond. Reconstructing the PREVIOUS key from what each racer
      // reported gives ONE string for TWO attempts — that is the bug, spelled
      // out rather than asserted about.
      expect(`attempt:${ids.childId}:${ra.observed}:${ra.startedAt}`).toBe(
        `attempt:${ids.childId}:${rb.observed}:${rb.startedAt}`,
      );
      // The minted ids, produced in two unrelated processes, are not equal.
      expect(ra.attemptId).not.toBe(rb.attemptId);

      const keys = [...new Set(loomLinesFor(ids.rootId).map((l) => String(l.entryKey)))].sort();
      expect(keys).toEqual(
        [
          `attempt:${ids.childId}:${SHARED_ID}`, // the shared prefix — both wrote it, it folds once
          `attempt:${ids.childId}:${ra.attemptId}`, // racer a
          `attempt:${ids.childId}:${rb.attemptId}`, // racer b
        ].sort(),
      );
      expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: ids.rootId })).toBeCloseTo(11);
    });
  });

  test("a duplicate keyed line folds once on BOTH readFold paths, and legacy un-keyed lines still count", () => {
    // The write path never dedupes at all, so a re-presented key ALWAYS
    // appends — one writer or two. That is harmless only because the fold —
    // which is rebuilt from the file, not carried by a writer — is the thing
    // that dedupes. This pins it on both of readFold's paths.
    const ownerId = "loom_dupe_probe";
    const entryKey = "attempt:loom_dupe_probe_child:0";
    const line = (over: Record<string, unknown>) =>
      JSON.stringify({
        ts: Date.now(),
        account: "personal",
        model: "",
        sessionId: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0,
        ownerKind: "loom",
        ownerId,
        ...over,
      }) + "\n";

    // Prime the fold first, so the appends below take the byte-INCREMENTAL path
    // rather than a cold rebuild.
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId })).toBeCloseTo(0);
    const dupe = line({ costUsd: 4, entryKey });
    fs.appendFileSync(usageLedgerFile(), dupe);
    fs.appendFileSync(usageLedgerFile(), dupe); // byte-identical duplicate
    fs.appendFileSync(usageLedgerFile(), line({ costUsd: 1 })); // legacy: no entryKey at all
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId })).toBeCloseTo(5);

    // Now force a FULL REBUILD by shrinking the file past the cached offset,
    // then restoring the exact same bytes. The dedupe must survive it, because
    // it is derived from the file and not cached alongside the fold.
    const full = fs.readFileSync(usageLedgerFile());
    fs.writeFileSync(usageLedgerFile(), "");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId })).toBeCloseTo(0);
    fs.writeFileSync(usageLedgerFile(), full);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId })).toBeCloseTo(5);
  });
});
