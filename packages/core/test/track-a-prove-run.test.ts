// THE TRACK A PROVE-RUN — SPEC-runtime-foundations' success signal, executed.
//
// WHAT THIS IS. The SPEC's Success signal is not "each port has a unit test";
// it is ONE SCRIPTED RUN, in ONE process, under ONE sandboxed state root, in
// which every runtime-foundations port SERVES A CONSUMER and the real ~/.telar
// is untouched throughout. WORK-SPLIT's phase-2 gate is literally "A6
// assertions green" — epics 4, 5 and 6, i.e. every remaining feature epic, do
// not start until this file and invariants.test.ts are green. So this file is a
// GATE, not a convenience.
//
// The whole run is one command, from the repo root:
//
//     TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-a prove-run"
//
// which produces the transcript below AND the `across N files` discovery figure
// in the same output, and selects exactly the five legs with everything else
// filtered out. (The suite pins its own mkdtemp'd root regardless — the
// TELAR_HOME on that command line is belt-and-braces, and the pin is what makes
// the run safe when someone forgets it.)
//
// WHY THE `packages/core` PATH ARGUMENT IS THERE, because it looks redundant
// and is not. The bare `bun test -t "track-a prove-run"` form fails on L4, for a
// reason that has nothing to do with this suite and everything to do with a
// PRE-EXISTING cross-workspace test-isolation defect: apps/web suites install a
// PROCESS-GLOBAL mock.module("@telar/core", …) at MODULE SCOPE and restore it
// only in afterAll. A repo-root run WITH a -t filter evaluates every file's
// module scope before running any test, so those afterAll hooks never fire and
// the stub is live inside every core suite in the process.
//
// BE PRECISE ABOUT WHICH SUITES DO WHAT — the first version of this note said
// "three suites stub saveLoom/getLoom/listLooms" and that is wrong about one of
// them, which is worse than saying nothing: the engineer who picks this up opens
// the file, finds no such stub, and discards a correct diagnosis of the other
// two. MEASURED, each one run on its own against packages/core:
//   - lib/loom-mcp.answer-blocked.test.ts and lib/loom-mcp.remint.test.ts stub
//     saveLoom to `() => {}` and getLoom/listLooms to fixtures. EITHER ONE
//     ALONE reproduces the L4 failure:
//     `bun test packages/core apps/web/lib/loom-mcp.remint.test.ts -t "L4 …"` → 1 fail.
//   - lib/ultra-mcp.test.ts installs the SAME process-global mock with the SAME
//     module-scope-install / afterAll-only-restore hygiene defect, but its
//     factory stubs only compileScript/getProject/getUltraManifest/launchUltra/
//     readUltraEvents/stopUltraRun — no loom writer. It does NOT reproduce this
//     symptom: the same command with ultra-mcp.test.ts → 1 pass.
// Pre-existence is measured too, on code that predates this story: story 1.2's
// own m5-reconcile-liveness.test.ts fails identically under
// `bun test -t "default liveness: a stranded in-flight loom"` from the repo
// root, with the same `TypeError: null is not an object (evaluating
// 'getLoom(id).state')`. apps/web is Track B/C's write set, so this is recorded
// rather than crossed (story 1.1's AC6 protocol) — see deferred-work.md. The
// path argument keeps the filtered run inside the core workspace, where no such
// mock exists. The UNFILTERED repo-root `bun test` is unaffected and green —
// without -t, bun loads and runs one file at a time, so each mock is restored by
// its own afterAll before the next file runs.
//
// THE FIVE LEGS, in AC4's clause order:
//   L1  an agent-facing event wakes a subscriber while a human-facing one
//       provably does not push                                        (AD-14/AD-21)
//   L2  a spend record attributes to an owner and reads back through a
//       projection                                                    (AD-18/AD-7)
//   L3  a loom-verify call wins a freed slot ahead of genuinely queued
//       loom-build work, with admissionSnapshot naming why            (AD-17)
//   L4  a stale lease reclaims to `failed` and never to `done`        (AD-16/AD-15)
//   L5  the real ~/.telar is untouched throughout                     (the operational scar)
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. Story 1.2 already unit-tests four of
// these five legs exhaustively, and re-asserting what those suites assert would
// be forty duplicated assertions maintained in two places — the first
// divergence is a lie in one of them. So each leg here exercises its port FOR
// REAL, asserts only the one or two facts that are its own AC clause, prints its
// transcript line, and CITES the suite that owns the exhaustive coverage. Every
// citation is executable: a renamed test fails the citation check at the bottom
// rather than rotting silently. The unique content of this file is the
// COMPOSITION, the TRANSCRIPT, and L5 — which is the one leg with no precedent
// anywhere in the repo.
//
// TWO HAZARDS THAT WOULD MAKE THIS FILE SILENTLY WORTHLESS, both from story 1.2:
//   - bun runs EVERY test file in ONE process, and the bus's registry and
//     admission's occupancy/queue are module singletons. resetBus() and
//     resetAdmission({}) run in beforeEach. resetAdmission({}) is not optional:
//     the ceiling re-reads the environment at every entry point, so a
//     TELAR_MAX_AGENTS in the developer's own shell would otherwise change L3's
//     arithmetic. And a test that leaves a WAITER QUEUED makes resetAdmission
//     THROW and takes the whole run down — L3 drains in a finally.
//   - re-declaring an event name is an ERROR, not an idempotent no-op, so L1
//     declares its catalogue INSIDE the test (never at module scope) and under
//     this suite's OWN module namespace. Nothing here is ever promoted into
//     packages/core/src: which concrete events a module publishes belongs to
//     that module's own epic (AD-21), and event-bus.test.ts's fixtures plus
//     these are the only event names in the repo.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ── the sandbox ─────────────────────────────────────────────────────────────
// House idiom (event-bus.test.ts / session-lease.test.ts): mkdtemp a root, pin
// it BEFORE importing anything that could resolve it, RESTORE the original in
// afterAll rather than deleting it — bun runs every file in one process, so a
// suite that re-points TELAR_HOME and does not put it back silently re-roots
// every suite that runs after it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "telar-track-a-prove-run-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = HOME;

// L5 layer 2, and it must be taken BEFORE any leg runs: a bounded, read-only
// fingerprint of the REAL ~/.telar. It never creates the directory, never
// stats it into existence, and never deletes anything. Note what it does NOT
// do: it does not assert the directory is absent. ~/.telar EXISTS on the
// machine this was written on — a story-1.1 verification agent ran an ad-hoc
// `bun -e` probe OUTSIDE the harness, where NODE_ENV is not "test" so
// logUsage's write-guard correctly did not fire, and a synthetic billing line
// landed on the home default. That is logged as NEEDS A HUMAN and is the
// operator's to clean up, not this suite's. An "it does not exist" assertion
// would fail on this tree and would be the wrong claim even where it passed.
const REAL_TELAR = path.join(os.homedir(), ".telar");
function realTelarSnapshot(): { exists: boolean; entries: string[] } {
  try {
    const entries = fs
      .readdirSync(REAL_TELAR)
      .map((name) => {
        try {
          const st = fs.statSync(path.join(REAL_TELAR, name));
          return `${name} size=${st.size} mtimeMs=${st.mtimeMs}`;
        } catch {
          return `${name} <unstattable>`;
        }
      })
      .sort();
    return { exists: true, entries };
  } catch {
    // ENOENT (and any other read failure) → "nothing observable here". Never
    // mkdir, never create it in order to check it: a probe that creates the
    // directory to inspect it IS the failure mode.
    return { exists: false, entries: [] };
  }
}
const REAL_TELAR_BEFORE = realTelarSnapshot();

// Pinned BEFORE these imports: static imports are hoisted and evaluated first,
// so a module that captured the root at evaluation time would capture the wrong
// one. (None of these do today; the idiom is what keeps that true.)
const bus = await import("../src/event-bus");
const admission = await import("../src/admission");
const ledger = await import("../src/usage-ledger");
const looms = await import("../src/looms");
const sessions = await import("../src/sessions");
const lease = await import("../src/runner/lease");
const liveness = await import("../src/runner/liveness");
const dispatcher = await import("../src/dispatcher");

beforeEach(() => {
  process.env.TELAR_HOME = HOME;
  bus.resetBus();
  // `{}` roots the ceiling read at an EMPTY environment record, which is what
  // makes this suite immune to a TELAR_MAX_AGENTS in the developer's shell.
  admission.resetAdmission({});
});

// EVERY STEP IS IN A finally, and the ORDER MATTERS. resetAdmission({}) THROWS
// on a leaked waiter (see the T-6 hazard above), so a plain sequential teardown
// would skip the TELAR_HOME restore on exactly the run where something already
// went wrong — leaving every suite that runs after this one re-rooted at a temp
// directory that this hook then failed to delete. The restore is the last thing
// that may be skipped, not the first.
afterAll(() => {
  try {
    try {
      bus.resetBus();
    } finally {
      admission.resetAdmission({});
    }
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = ORIGINAL_HOME;
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

// One line per leg, stable prefix. This IS the artifact epics.md's
// dev-server-proof line calls "the scripted run's transcript".
const transcript = (leg: string, what: string) => console.log(`[track-a] ${leg} ${what}`);

// Lets a queued acquire actually reach the queue before we assert on it.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const TTL_MS = 30_000;

describe("track-a prove-run", () => {
  test("L1 an agent-facing event wakes a subscriber while a human-facing one provably does not push", () => {
    // Declared HERE, not at module scope: re-declaration is an error and
    // beforeEach clears the registry, so a module-scope declaration would
    // survive exactly one test. Own namespace, so it cannot collide with
    // event-bus.test.ts's "fixture" catalogue.
    const port = bus.declareEvents("track-a", {
      "substrate-proved": { deliveryClass: "agent-facing", payload: z.object({ leg: z.string() }) },
      "transcript-appended": {
        deliveryClass: "human-facing",
        payload: z.object({ leg: z.string() }),
      },
    });

    const woken: string[] = [];
    const read: string[] = [];
    port.subscribeAgentFacing("substrate-proved", (p) => woken.push(p.leg));
    port.subscribe("transcript-appended", (p) => read.push(p.leg));

    const agentFacing = port.publish("substrate-proved", { leg: "L1" });
    const humanFacing = port.publish("transcript-appended", { leg: "L1" });

    // The wake channel really carried it.
    expect(woken).toEqual(["L1"]);
    expect(agentFacing.wakeDelivered).toBe(1);
    expect(agentFacing.failed).toBe(0);

    // "PROVABLY does not push" — structural, not documented, and asserted as
    // BOTH halves. wakeDelivered === 0 alone would also be true of an event
    // nobody received at all; delivered >= 1 is what makes the zero mean
    // "reached a surface, did not push" rather than "was dropped".
    expect(humanFacing.wakeDelivered).toBe(0);
    expect(humanFacing.delivered).toBeGreaterThanOrEqual(1);
    expect(read).toEqual(["L1"]);

    // …and the gate refuses the registration too, so the guarantee does not
    // depend on every publisher remembering it.
    expect(() => port.subscribeAgentFacing("transcript-appended" as never, () => {})).toThrow(
      "cannot be subscribed on the wake channel",
    );

    // Exhaustive class-filter coverage lives in event-bus.test.ts; this leg is
    // the demonstration, not a second copy.
    transcript(
      "L1",
      `bus: agent-facing wakeDelivered=${agentFacing.wakeDelivered} · human-facing ` +
        `wakeDelivered=${humanFacing.wakeDelivered} delivered=${humanFacing.delivered} · ` +
        `wake registration on the human-facing name REFUSED`,
    );
  });

  test("L2 a spend record attributes to an owner and reads back through a projection", () => {
    const ownerId = "loom_prove_run";
    const attributed = ledger.logUsage({
      ts: Date.now(),
      account: "personal",
      model: "claude-opus-5",
      sessionId: "sess-track-a",
      inputTokens: 1_000,
      outputTokens: 250,
      costUsd: 1.25,
      ownerKind: "loom",
      ownerId,
      entryKey: "track-a-prove-run:L2",
    });
    // logUsage returns a boolean; assert the RETURN, not merely the absence of
    // a throw — the write path is deliberately loud-but-non-throwing, so a
    // dropped entry looks exactly like a successful one from the call site.
    expect(attributed).toBe(true);

    // Read back through a PROJECTION, never by opening usage.ndjson. AD-18: a
    // spend readout is a fold over the one log, never an independent counter —
    // adding a second reader is the exact failure FR-RF-2 exists to end.
    expect(ledger.ledgerSpendUsd({ ownerKind: "loom", ownerId })).toBeCloseTo(1.25, 6);
    expect(ledger.ledgerSpendUsd({ ownerKind: "ultra", ownerId })).toBe(0); // owner key, not a substring
    expect(ledger.ledgerReadUnavailable()).toBe(false);

    // The write landed INSIDE the sandbox. Positive evidence, which is what L5
    // layer 3 rests on — "nothing appeared in ~/.telar" is a weaker claim than
    // "it appeared here instead".
    const ledgerFile = path.join(HOME, "usage.ndjson");
    expect(fs.existsSync(ledgerFile)).toBe(true);
    // Against THIS suite's root, not merely against os.tmpdir() — every
    // mkdtemp'd path satisfies the latter, including someone else's.
    expect(path.dirname(fs.realpathSync(ledgerFile))).toBe(fs.realpathSync(HOME));

    // THE TOLERANT-READER HALF (AD-7). Every UsageEntry field EXCEPT `ts`
    // carries a zod .default(...) — including ownerKind, ownerId and entryKey —
    // which is why logUsage takes { ts: number } & Partial<UsageEntry>. A record
    // written BEFORE attribution existed must still parse, still count, and
    // never throw. The only way to produce one is to append it raw: no port can
    // emit a record missing fields the schema defaults, so this test writes the
    // line directly. That is a TEST simulating history already on disk, not a
    // second writer — INV-5's sole-writer scan excludes *.test.ts for exactly
    // this reason.
    const before = ledger.usageSummary();
    fs.appendFileSync(
      ledgerFile,
      JSON.stringify({
        ts: Date.now(),
        account: "personal",
        model: "claude-opus-5",
        sessionId: "sess-pre-attribution",
        costUsd: 0.5,
      }) + "\n",
    );
    const after = ledger.usageSummary();
    expect(after.session.requests).toBe(before.session.requests + 1);
    expect(after.session.costUsd).toBeCloseTo(before.session.costUsd + 0.5, 6);
    // It folded into the SESSION-scoped projection, because the "session"
    // default is load-bearing rather than a placeholder.
    expect(ledger.usageCostBySession().get("sess-pre-attribution")).toBeCloseTo(0.5, 6);
    expect(ledger.ledgerReadUnavailable()).toBe(false);

    transcript(
      "L2",
      `ledger: logUsage=${attributed} · ledgerSpendUsd(loom:${ownerId})=` +
        `${ledger.ledgerSpendUsd({ ownerKind: "loom", ownerId })} · pre-attribution record still ` +
        `counts (session.requests ${before.session.requests}→${after.session.requests}) · file under ${HOME}`,
    );
  });

  test("L3 a loom-verify call wins a freed slot ahead of genuinely queued loom-build work", () => {
    // GENUINELY QUEUED means real contention, not a staged one: fill the pool
    // with builds, queue TWO MORE builds, arrive the verify AFTER them, then
    // free EXACTLY ONE slot and show the verify won it.
    //
    // Every slot is taken and released through the HANDLE acquireAdmission
    // returns, not through releaseAdmission(cls). Not because the test would
    // otherwise fail — admission.test.ts legitimately calls releaseAdmission
    // directly, because it is testing that function — but because a prove-run
    // is a demonstration of CORRECT USAGE, and releaseAdmission cannot detect a
    // class mismatch (story 1.2, Completion Note 15). A prove-run modelling the
    // unsafe form is a bad artifact.
    return (async () => {
      expect(admission.admissionCeiling()).toBe(admission.DEFAULT_ADMISSION_CEILING);
      const ceiling = admission.DEFAULT_ADMISSION_CEILING;
      const held: Array<() => void> = [];
      const order: string[] = [];
      let pending: Array<Promise<() => void>> = [];
      try {
        for (let i = 0; i < ceiling; i++) held.push(await admission.acquireAdmission("loom-build"));
        expect(admission.admissionSnapshot().inFlight).toBe(ceiling);

        pending = [
          admission.acquireAdmission("loom-build").then((h) => {
            order.push("loom-build");
            return h;
          }),
          admission.acquireAdmission("loom-build").then((h) => {
            order.push("loom-build");
            return h;
          }),
          // Arrives LAST, so winning cannot be an artifact of arrival order.
          admission.acquireAdmission("loom-verify").then((h) => {
            order.push("loom-verify");
            return h;
          }),
        ];
        await settle();

        // THE SNAPSHOT NAMES WHY, captured at the moment of contention: the
        // whole decision is reconstructable from it with no extra reads — the
        // pool is full of builds, a verify is waiting, and verify leads the
        // priority order, so the next freed slot is the verify's.
        const snap = admission.admissionSnapshot();
        expect(snap.policy.priority).toEqual(["loom-verify", "loom-build", "ultra", "other"]);
        expect(snap.policy.priority[0]).toBe("loom-verify");
        expect(snap.occupancy["loom-build"]).toBe(ceiling);
        expect(snap.waiting["loom-build"]).toBe(2);
        expect(snap.waiting["loom-verify"]).toBe(1);
        expect(snap.queued).toBe(3);
        expect(snap.inFlight).toBe(ceiling);

        // Free EXACTLY ONE slot, through the handle.
        held.pop()!();
        await settle();

        // Precedence, not a held-open slot: nothing was reserved for the verify
        // and nothing sat idle — it simply led the order when a slot appeared.
        expect(order).toEqual(["loom-verify"]);
        expect(admission.admissionSnapshot().occupancy["loom-verify"]).toBe(1);
        expect(admission.admissionSnapshot().queued).toBe(2);

        transcript(
          "L3",
          `admission: ceiling=${ceiling} · waiting build=2 verify=1 · priority=` +
            `${JSON.stringify(snap.policy.priority)} · one slot freed → won by ` +
            `${order.join(",")}`,
        );
      } finally {
        // T-6: a leaked waiter makes resetAdmission THROW and takes the whole
        // run down, so drain even on a failing assertion. Releasing the
        // remaining held slots admits every waiter; then hand their handles back.
        //
        // allSettled, NOT all. Promise.all short-circuits on the FIRST
        // rejection: one rejected acquire and the loop never runs, so every
        // already-granted handle beside it leaks, the next beforeEach's
        // resetAdmission({}) throws, and the rest of the file dies of something
        // unrelated to the regression that started it — the exact T-6 cascade
        // this finally exists to prevent.
        for (const release of held.splice(0)) release();
        for (const settled of await Promise.allSettled(pending)) {
          if (settled.status === "fulfilled") settled.value();
        }
        expect(admission.admissionSnapshot().inFlight).toBe(0);
        expect(admission.admissionSnapshot().queued).toBe(0);
      }
    })();
  });

  test("L4 a stale lease reclaims to failed and never to done", () => {
    // TWO HALVES WITH DIFFERENT SCOPES, kept distinct on purpose.
    //
    // HALF ONE — THE RECLAIM DECISION, on BOTH roots, because AD-16's claim is
    // one primitive with two lifetimes. Aged by an INJECTED CLOCK, never by
    // sleeping: leaseReclaim(lease, ttlMs, now) takes the clock as a parameter
    // precisely so a staleness test costs nothing and cannot flake.
    const T0 = 1_700_000_000_000;
    const loomId = "loom_prove_lease";
    const sessionId = "sess-prove-lease";

    const loomOwnerDir = looms.loomDir(loomId);
    lease.writeLease(loomOwnerDir, { pid: 4242, token: "loom-token" }, () => T0);
    sessions.writeSessionLease(sessionId, { pid: 4243, token: "session-token" }, () => T0);

    // Fresh on both roots while the owner is heartbeating…
    expect(lease.leaseReclaim(lease.readLease(loomOwnerDir), TTL_MS, T0 + 1)).toBe("held");
    expect(sessions.sessionLeaseReclaim(sessionId, TTL_MS, T0 + 1)).toBe("held");
    // …and reclaimable on both once the heartbeat is older than the TTL.
    expect(lease.leaseReclaim(lease.readLease(loomOwnerDir), TTL_MS, T0 + TTL_MS + 1)).toBe(
      "reclaimable",
    );
    expect(sessions.sessionLeaseReclaim(sessionId, TTL_MS, T0 + TTL_MS + 1)).toBe("reclaimable");
    // Both lifetimes really are the SAME primitive on disk — same filename,
    // written through the same functions.
    expect(path.basename(lease.leaseFile(loomOwnerDir))).toBe(".runner-lease");
    expect(path.basename(sessions.sessionLeaseFile(sessionId))).toBe(".runner-lease");
    // The moat, in the one line this leg owns: the union cannot express a
    // terminal success. The EXHAUSTIVE version of this claim — including the
    // compile-time one, which is checked by really running tsc — lives in
    // session-lease.test.ts and is cited below rather than re-run here (a tsc
    // spawn costs ~0.35s per fixture, and AC3 gives invariants.test.ts a 2000ms
    // budget this suite has no business eating into).
    expect([...lease.LEASE_RECLAIM_OUTCOMES]).toEqual(["held", "reclaimable"]);
    expect([...lease.LEASE_RECLAIM_OUTCOMES]).not.toContain("done");

    // HALF TWO — THE TERMINAL STATE, and this half is LOOM-ONLY.
    // sessions.ts is lease read/write/reclaim only: it has no `state` field and
    // no state machine, so "the terminal state is failed" structurally cannot
    // apply to it. Do not go hunting for a session state; there isn't one.
    //
    // The only production path that turns a stale lease into a PERSISTED
    // `failed` is dispatcher.ts's reconcileStuckLooms(liveness), with
    // runner/liveness.ts's crossProcessLiveness injected. Its own in-source
    // comment is the AD-1/AD-15 claim in one line — "MOAT: reconcileState can
    // only ever yield resume/queued/halt/leave/skip — never `done` — so this
    // sweep can never auto-complete a loom" — and this is what makes that
    // comment executable end to end.
    const stranded = looms.createLoom({
      project: "track-a-prove-run",
      kind: "custom",
      title: "stranded",
      prompt: "x",
      account: "personal",
    });
    // Seeded IN-FLIGHT and as a ROOT. Both matter: reconcileState maps
    // charter-review/ready/blocked/needs-review to `leave` and the terminal
    // states to `skip`, so a `ready` loom is correctly untouched — and a leg
    // asserting "nothing changed" would pass while proving the opposite of its
    // AC. reconcileStuckLooms also opens with `if (loom.parentLoomId) continue`.
    stranded.state = "running";
    looms.saveLoom(stranded);

    // PRECONDITION, and it is not paranoia — without it this leg dies on an
    // opaque `TypeError: null is not an object` twenty lines below and reads as
    // a broken prove-run rather than as the environmental defect it is. See the
    // file header: a repo-root `bun test -t …` leaves an apps/web
    // mock.module("@telar/core", …) installed, which stubs saveLoom to a no-op.
    // Under that stub every assertion after this point is meaningless, so say so
    // HERE, once, in the only place that can tell the difference.
    if (!fs.existsSync(path.join(looms.loomDir(stranded.id), "loom.json"))) {
      throw new Error(
        "L4 precondition failed: looms.saveLoom() wrote no loom.json. TWO CAUSES ARE POSSIBLE and " +
          "the invocation tells you which. (1) If apps/web files were loaded into this run — a " +
          "repo-root `bun test -t …` loads every module scope before running any test — then a " +
          "process-global mock.module(\"@telar/core\", …) is installed and has stubbed saveLoom out " +
          "from under this suite. TWO apps/web suites do that, MEASURED: " +
          "lib/loom-mcp.answer-blocked.test.ts and lib/loom-mcp.remint.test.ts, each of which " +
          "reproduces this failure on its own. (lib/ultra-mcp.test.ts installs the same " +
          "process-global mock with the same afterAll-only restore, but stubs only the ultra " +
          "functions and does NOT cause this.) (2) If this run loaded packages/core ONLY, no such " +
          "mock exists in the process and this IS a real regression in looms.saveLoom — do not " +
          "let cause (1) talk you out of reading looms.ts. CONSEQUENCE either way: everything " +
          "below would assert against fixtures instead of against the real dispatcher, i.e. it " +
          "would prove nothing while looking green. NEXT STEP: run " +
          "`TELAR_HOME=$(mktemp -d) bun test packages/core -t \"track-a prove-run\"` from the repo " +
          "root, or the unfiltered `bun test`; if BOTH are green the cause is (1) and the " +
          "underlying fix belongs to apps/web (Track B/C), not here — story 1.2's " +
          "m5-reconcile-liveness.test.ts fails the same way under the same invocation, which is " +
          "how its pre-existence was proved. It is recorded in deferred-work.md.",
      );
    }

    // The control, which is what makes the assertion above mean something: an
    // awaiting-a-human loom under the SAME sweep must not move.
    const awaiting = looms.createLoom({
      project: "track-a-prove-run",
      kind: "custom",
      title: "awaiting a human",
      prompt: "x",
      account: "personal",
    });
    awaiting.state = "ready";
    looms.saveLoom(awaiting);

    // A REAL lease record on disk for the stranded loom, aged past its TTL by
    // the injected clock. The runner reports nobody active, so the lease is
    // authoritative — and a stale lease makes the loom DEAD.
    lease.writeLease(looms.loomDir(stranded.id), { pid: 99_999, token: "dead" }, () => T0);
    // The two readLease shapes are DIFFERENT and must be adapted at the call
    // site: liveness.ts wants (id: string) => RunnerLease | null; lease.ts
    // exports readLease(ownerDir). Passing one where the other is expected
    // silently returns null for every id, which reads as "everything is dead"
    // and would make this leg pass for the wrong reason.
    const oracle = liveness.crossProcessLiveness(
      new Set<string>(),
      (id) => lease.readLease(looms.loomDir(id)),
      TTL_MS,
      () => T0 + TTL_MS + 1,
    );
    expect(oracle(stranded.id)).toBe(false); // stale lease ⇒ dead

    const reconciled = dispatcher.reconcileStuckLooms(oracle);

    expect(looms.getLoom(stranded.id)!.state).toBe("failed");
    expect(looms.getLoom(stranded.id)!.state).not.toBe("done");
    expect(looms.getLoom(stranded.id)!.error).toBeTruthy();
    expect(reconciled.some((r) => r.id === stranded.id && r.from === "running")).toBe(true);
    // The control did not move, and — the moat — nothing anywhere was
    // auto-completed.
    expect(looms.getLoom(awaiting.id)!.state).toBe("ready");
    expect(reconciled.every((r) => looms.getLoom(r.id)!.state !== "done")).toBe(true);

    transcript(
      "L4",
      `lease: stale on BOTH roots → reclaimable (loom + session) · reclaim union=` +
        `${JSON.stringify([...lease.LEASE_RECLAIM_OUTCOMES])} · stranded loom running→` +
        `${looms.getLoom(stranded.id)!.state} · ready loom untouched · never done`,
    );
  });

  test("L5 the real telar home is untouched throughout", () => {
    // Declared last so it runs last — bun runs a file's tests in declaration
    // order — which is what makes "throughout" mean the whole run rather than
    // one moment in it.
    //
    // LAYER 1 — the guard is ARMED, and IT IS PROVED FROM A CHILD PROCESS.
    // usage-ledger.ts refuses a write when NODE_ENV is "test" and TELAR_HOME is
    // unset or blank, which is the primary protection and exists ONLY inside the
    // harness. NODE_ENV comes from the runner, not from repo config: nothing in
    // this repo sets it (no bunfig preload, no env script, no root scripts
    // block), so this is proved behaviourally rather than assumed.
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.TELAR_HOME).toBe(HOME);

    // WHY A CHILD AND NOT `process.env.TELAR_HOME = "   "` RIGHT HERE. The
    // in-process form was how this leg was first written, and it ARMS THE EXACT
    // WEAPON THAT ALREADY FIRED: manifest.ts's telarDir() reads
    // process.env.TELAR_HOME?.trim() and falls back to path.join(os.homedir(),
    // ".telar") on a blank value, so the only thing standing between a blank
    // assignment in the SHARED test process and a synthetic $999 billing line in
    // the operator's REAL ~/.telar is the very guard under test. Weaken that
    // guard and the test written to prove ~/.telar is untouched becomes the
    // thing that touches it — byte-for-byte the story-1.1 incident that is still
    // open under NEEDS A HUMAN. A child gets its own env AND an mkdtemp'd HOME,
    // so a regressed guard writes into a temp box this test deletes; the shared
    // process's TELAR_HOME is never assigned at all. (os.homedir() under Bun is
    // fixed at process start and ignores an in-process process.env.HOME write —
    // apps/web/lib/state-root.test.ts's header states this — which is the other
    // half of why the fake home only exists for a child.)
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "telar-track-a-guard-"));
    try {
      const fakeHome = path.join(box, "home");
      const pinnedRoot = path.join(box, "pinned");
      fs.mkdirSync(fakeHome, { recursive: true });
      const probe = path.join(box, "probe.ts");
      const ledgerModule = JSON.stringify(
        fileURLToPath(new URL("../src/usage-ledger.ts", import.meta.url)),
      );
      fs.writeFileSync(
        probe,
        [
          `const { logUsage } = await import(${ledgerModule});`,
          `const entry = () => ({ ts: Date.now(), account: "personal", model: "claude-opus-5",`,
          `  sessionId: "track-a-L5", costUsd: 999 });`,
          `let blank = { threw: false, message: "" };`,
          `try {`,
          `  logUsage(entry());`,
          `} catch (e) {`,
          `  blank = { threw: true, message: String((e && e.message) || e) };`,
          `}`,
          // THE POSITIVE CONTROL, in the same child: with a root actually pinned
          // the identical call SUCCEEDS. Without it, "it threw" is equally
          // consistent with a module that failed to load or a child that died,
          // which is the vacuous-green shape this whole story exists to refuse.
          `process.env.TELAR_HOME = ${JSON.stringify(pinnedRoot)};`,
          `const pinned = logUsage({ ...entry(), costUsd: 0.01 });`,
          `console.log(JSON.stringify({ blank, pinned }));`,
        ].join("\n") + "\n",
      );
      const out = spawnSync(process.execPath, [probe], {
        // TELAR_HOME is WHITESPACE, not unset: the empty and unset cases were
        // already guarded and this is the one that got through in story 1.1.
        env: { ...process.env, HOME: fakeHome, TELAR_HOME: "   ", NODE_ENV: "test" },
        encoding: "utf8",
      });
      if (out.status !== 0) {
        throw new Error(
          `L5 layer 1: the write-guard child probe exited ${out.status}. It proves that a blank ` +
            `TELAR_HOME under NODE_ENV=test cannot write, and that claim is now UNPROVEN. ` +
            `stdout: ${out.stdout}\nstderr: ${out.stderr}`,
        );
      }
      const readback = JSON.parse(out.stdout.trim()) as {
        blank: { threw: boolean; message: string };
        pinned: boolean;
      };
      expect(readback.blank.threw).toBe(true);
      expect(readback.blank.message).toContain(
        "logUsage refused: NODE_ENV=test with no TELAR_HOME",
      );
      // The control: the same call, same child, same module — writes when a root
      // is pinned. So the refusal above is the GUARD firing, not a dead probe.
      expect(readback.pinned).toBe(true);
      expect(fs.existsSync(path.join(pinnedRoot, "usage.ndjson"))).toBe(true);
      // AND THE ASSERTION THAT ACTUALLY DISCRIMINATES a working guard from a
      // regressed one: nothing was created under the home the blank write would
      // have resolved to. Scanned recursively rather than by listing the home
      // directly — Bun creates unrelated entries under a fresh HOME on macOS.
      expect(fs.existsSync(path.join(fakeHome, ".telar"))).toBe(false);
      expect(
        fs
          .readdirSync(fakeHome, { recursive: true, encoding: "utf8" })
          .filter((f) => f.endsWith("usage.ndjson")),
      ).toEqual([]);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
    // This process's own root was never touched to run that probe — which is the
    // whole point of doing it in a child.
    expect(process.env.TELAR_HOME).toBe(HOME);

    // KNOW PRECISELY WHAT THAT GUARD DOES NOT COVER, because assuming more is
    // how story 1.1's pollution happened: it does not cover a write outside a
    // NODE_ENV=test process (dev and production are unguarded by design), it is
    // a local guard rather than a write interceptor (any writer other than
    // logUsage sails past it), and it catches "unset or blank" — never a
    // TELAR_HOME that is SET BUT WRONG.

    // LAYER 2 — the before/after snapshot of the REAL path, across the whole
    // run. This is the genuinely new content of this file: no existing test
    // makes this claim. Never created, never deleted, and never asserted absent.
    const after = realTelarSnapshot();
    expect(after).toEqual(REAL_TELAR_BEFORE);

    // LAYER 3 — positive evidence that the writes landed under the temp root.
    // "Nothing new appeared over there" is a weaker claim than "it appeared
    // here instead", and only the second one distinguishes a correct run from a
    // run in which nothing happened at all.
    //
    // EVERY WRITE BELOW IS L5'S OWN, and that is a repair rather than a
    // duplication of L2 and L4. The first version of this layer asserted over
    // the records L2 and L4 happen to leave behind, which made the leg pass only
    // as part of an ordered whole: §6.2's own discovery mechanism — running one
    // test by name — turned it RED
    // (`bun test packages/core -t "L5 the real telar home is untouched throughout"`
    // → `expect(fs.existsSync(ledgerFile)).toBe(true)` receiving false), because
    // nothing in L5 wrote usage.ndjson. A leg whose failure cannot be reproduced
    // on its own is a leg whose failure cannot be diagnosed on its own. Three
    // cheap calls through three ports remove the ordering dependency entirely.
    const evidenceKey = "track-a-prove-run:L5";
    const evidenceSession = "sess-track-a-L5";
    expect(
      ledger.logUsage({
        ts: Date.now(),
        account: "personal",
        model: "claude-opus-5",
        sessionId: evidenceSession,
        costUsd: 0.01,
        entryKey: evidenceKey,
      }),
    ).toBe(true);
    looms.createLoom({
      project: "track-a-prove-run",
      kind: "custom",
      title: "L5 evidence",
      prompt: "x",
      account: "personal",
    });
    sessions.writeSessionLease(evidenceSession, { pid: process.pid, token: "L5" }, () => Date.now());

    const ledgerFile = path.join(HOME, "usage.ndjson");
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const ledgerLines = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(ledgerLines.length).toBeGreaterThanOrEqual(1);
    // Not merely "a file exists": the line THIS leg wrote is in it.
    expect(ledgerLines.some((l) => l.includes(evidenceKey))).toBe(true);
    // The state root is a temp directory, and the ledger really lives under IT —
    // not merely under some temp directory, which any mkdtemp'd path satisfies.
    expect(fs.realpathSync(HOME).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(path.dirname(fs.realpathSync(ledgerFile))).toBe(fs.realpathSync(HOME));
    expect(fs.existsSync(path.join(HOME, "looms"))).toBe(true);
    expect(fs.existsSync(sessions.sessionLeaseFile(evidenceSession))).toBe(true);
    expect(fs.existsSync(path.join(HOME, "sessions"))).toBe(true);

    // LAYER 4 — the EXHAUSTIVE guard coverage is CITED, not rebuilt.
    // usage-ledger.test.ts owns the full set of write-guard cases (unset, empty
    // and whitespace TELAR_HOME) behind the same child-process idiom layer 1
    // now uses. Layer 1 spawns its own child because the claim it makes must be
    // made without assigning TELAR_HOME in THIS process; it deliberately does
    // NOT re-enumerate those cases. (See the citation check below, which fails
    // if that test moves.)

    transcript(
      "L5",
      `~/.telar untouched: exists=${after.exists} entries=${JSON.stringify(after.entries.length)} ` +
        `identical before/after · guard armed NODE_ENV=${process.env.NODE_ENV} · all writes under ${HOME}`,
    );
  });
});

// ── the citations, made executable ──────────────────────────────────────────
// Every leg above deliberately asserts LESS than the suite that owns its
// exhaustive coverage. That is only safe if the citation cannot rot: a renamed
// or deleted test must fail HERE rather than leaving this file reading as
// complete while the coverage it leans on is gone.
// NOTE THE NAME: this describe deliberately does NOT contain the string
// "track-a prove-run", so `bun test -t "track-a prove-run"` selects exactly the
// five legs and nothing else — AC4's one-command form has to report five, not
// five-plus-bookkeeping.
describe("prove-run citations", () => {
  const CITED: Array<{ leg: string; file: string; title: string }> = [
    {
      leg: "L1",
      file: "packages/core/test/event-bus.test.ts",
      title: "T-1 the bus persists NOTHING — a busy publish leaves the state root empty",
    },
    {
      leg: "L2",
      file: "packages/core/test/usage-ledger.test.ts",
      title: "logUsage appends one line to $TELAR_HOME/usage.ndjson and creates no other file",
    },
    {
      leg: "L3",
      file: "packages/core/test/admission.test.ts",
      title: "gives a freed slot to loom-verify ahead of a queued build fan-out",
    },
    {
      leg: "L3",
      file: "packages/core/test/admission.test.ts",
      title: "AC5 admissionSnapshot NAMES WHY: priority order and waiting-by-class are both readable",
    },
    {
      leg: "L4",
      file: "packages/core/test/session-lease.test.ts",
      title: "AC11 a STALE lease resolves to reclaimable on BOTH the loom path and the session path",
    },
    {
      leg: "L4",
      file: "packages/core/test/session-lease.test.ts",
      title: "AC11 every value the reclaim union can take is enumerated, and `done` is not among them",
    },
    {
      leg: "L4",
      file: "packages/core/test/session-lease.test.ts",
      title: "AC11 `done` is NOT assignable to LeaseReclaim — the moat, checked by tsc",
    },
    {
      leg: "L4",
      file: "packages/core/test/session-lease.test.ts",
      title: "AC11 the lease filename is `.runner-lease` on BOTH lifetimes — one filename, zero divergence",
    },
    {
      leg: "L4",
      file: "packages/core/test/m5-reconcile-liveness.test.ts",
      title: "default liveness: a stranded in-flight loom → failed (byte-identical)",
    },
    {
      leg: "L5",
      file: "packages/core/test/usage-ledger.test.ts",
      title: "a whitespace-only TELAR_HOME writes NOTHING under the resolved home (real child process)",
    },
  ];

  test("every suite this prove-run leans on still holds the test it is cited for", () => {
    const repo = path.resolve(import.meta.dir, "..", "..", "..");
    const missing = CITED.filter(({ file, title }) => {
      const abs = path.join(repo, file);
      return !fs.existsSync(abs) || !fs.readFileSync(abs, "utf8").includes(title);
    }).map(
      ({ leg, file, title }) =>
        `${leg} cites ${file} "${title}", which is no longer there. This prove-run deliberately ` +
          `asserts only its own AC clause and leans on that suite for the exhaustive cases. ` +
          `CONSEQUENCE: the coverage this leg stands on may be gone while the leg still reads as ` +
          `a complete demonstration. NEXT STEP: find where it moved and update the citation, or ` +
          `take the assertion over here.`,
    );
    expect(missing).toEqual([]);
    // Anti-vacuity: the citation list itself is non-empty and really was read.
    expect(CITED.length).toBeGreaterThanOrEqual(8);
    expect(fs.existsSync(path.join(repo, "bunfig.toml"))).toBe(true);
  });
});
