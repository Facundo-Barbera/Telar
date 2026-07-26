// Admission control (AD-17 / CAP-4). Re-homed from the SPEC's reference
// implementation at _bmad-output/specs/spec-runtime-foundations/reference/
// admission-impl/admission.test.ts, which sits inside bunfig.toml's
// pathIgnorePatterns and is therefore INVISIBLE to `bun test` where it lives.
// Its relative imports ("../src/admission") only resolve from here, which is
// the whole reason the re-home is a task and not a copy.
//
// Two adaptations from the reference: `it(` -> `test(` (the house convention —
// zero of packages/core/test's files use `it(`), and a reset between tests.
// bun runs EVERY test file in one process and admission.ts holds module-level
// singleton state, so a suite that leaves occupancy or a queued waiter behind
// silently re-roots every suite after it — and a stranded waiter makes
// resetAdmission THROW and takes the whole run down. Every test below drains.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ADMISSION_CLASSES,
  DEFAULT_ADMISSION_CEILING,
  acquireAdmission,
  admissionCeiling,
  admissionCheck,
  admissionSnapshot,
  availableFor,
  configureAdmission,
  defaultAdmissionPolicy,
  entitlement,
  readCeiling,
  releaseAdmission,
  resetAdmission,
  type AdmissionClass,
  type ClassMap,
} from "../src/admission";
import { fanoutClamp } from "../src/budget";

const occ = (partial: Partial<ClassMap> = {}): ClassMap => ({
  "loom-build": 0,
  "loom-verify": 0,
  ultra: 0,
  other: 0,
  ...partial,
});

// Lets a queued acquire() actually reach the queue before we assert on it.
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

// Hand every slot back, whatever class holds it. Used as the last act of any
// test that touched the queue — see the file header on one-process runs.
const drain = () => {
  for (const c of ADMISSION_CLASSES) {
    const held = admissionSnapshot().occupancy[c];
    for (let i = 0; i < held; i++) releaseAdmission(c);
  }
};

// The controller's state must not survive this file (T-4). Safe because every
// test drains its own waiters — if one ever does not, this throws loudly here
// rather than corrupting a later suite silently.
afterAll(() => resetAdmission({}));

describe("readCeiling — tolerant parse, never throws at import", () => {
  test("defaults when unset or blank", () => {
    expect(readCeiling({})).toBe(DEFAULT_ADMISSION_CEILING);
    expect(readCeiling({ TELAR_MAX_AGENTS: "" })).toBe(DEFAULT_ADMISSION_CEILING);
    expect(readCeiling({ TELAR_MAX_AGENTS: "   " })).toBe(DEFAULT_ADMISSION_CEILING);
    expect(readCeiling({ TELAR_MAX_AGENTS: undefined })).toBe(DEFAULT_ADMISSION_CEILING);
  });

  test("accepts a positive integer", () => {
    expect(readCeiling({ TELAR_MAX_AGENTS: "12" })).toBe(12);
    expect(readCeiling({ TELAR_MAX_AGENTS: "8" })).toBe(8);
    expect(readCeiling({ TELAR_MAX_AGENTS: "1" })).toBe(1);
  });

  test("falls back on garbage rather than throwing", () => {
    for (const bad of ["0", "-3", "2.5", "abc", "NaN", "1e3x"]) {
      expect(readCeiling({ TELAR_MAX_AGENTS: bad })).toBe(DEFAULT_ADMISSION_CEILING);
    }
  });

  test("AC4 import-time safety: the parse NEVER throws, so a module-level policy is safe", () => {
    // Asserted, not assumed. `let policy = defaultAdmissionPolicy()` runs at
    // module evaluation; if the parse could throw on a hostile TELAR_MAX_AGENTS
    // the import itself would take the server down before anything could catch.
    for (const bad of ["0", "-3", "2.5", "abc", "", "   ", " ", "\x00", "\t\n", "Infinity", "-Infinity"]) {
      expect(() => readCeiling({ TELAR_MAX_AGENTS: bad })).not.toThrow();
      expect(() => defaultAdmissionPolicy({ TELAR_MAX_AGENTS: bad })).not.toThrow();
      expect(defaultAdmissionPolicy({ TELAR_MAX_AGENTS: bad }).ceiling).toBe(
        DEFAULT_ADMISSION_CEILING,
      );
    }
  });
});

describe("entitlement — pure, weighted with a floor", () => {
  test("at the default ceiling of 4 the floors dominate: one each", () => {
    const p = defaultAdmissionPolicy({});
    expect(entitlement(p, "loom-build")).toBe(1);
    expect(entitlement(p, "loom-verify")).toBe(1);
    expect(entitlement(p, "ultra")).toBe(1);
    // `other` has floor 0 and weight 1 of 8 -> floor(4/8) = 0
    expect(entitlement(p, "other")).toBe(0);
  });

  test("weights take over once the ceiling is large enough", () => {
    const p = { ...defaultAdmissionPolicy({}), ceiling: 16 };
    // weights 3/2/2/1 of 8 over a ceiling of 16
    expect(entitlement(p, "loom-build")).toBe(6);
    expect(entitlement(p, "loom-verify")).toBe(4);
    expect(entitlement(p, "ultra")).toBe(4);
    expect(entitlement(p, "other")).toBe(2);
  });

  test("never drops below the class floor", () => {
    const p = { ...defaultAdmissionPolicy({}), ceiling: 1 };
    expect(entitlement(p, "loom-verify")).toBe(1); // floor 1 beats floor(1*2/8)=0
    expect(entitlement(p, "other")).toBe(0);
  });

  test("survives an all-zero weight map without dividing by zero", () => {
    const p = {
      ...defaultAdmissionPolicy({}),
      weight: occ() as ClassMap,
    };
    for (const c of ADMISSION_CLASSES) expect(Number.isFinite(entitlement(p, c))).toBe(true);
  });
});

describe("admissionCheck — pure decision", () => {
  const p = defaultAdmissionPolicy({}); // ceiling 4

  test("refuses at the ceiling regardless of class or borrow", () => {
    const full = occ({ "loom-build": 4 });
    expect(admissionCheck(p, full, "loom-verify", { allowBorrow: true })).toEqual({
      admit: false,
      reason: "at-ceiling",
    });
    expect(availableFor(p, full)).toBe(0);
  });

  test("admits within entitlement even while others are queued", () => {
    expect(
      admissionCheck(p, occ({ "loom-build": 2, ultra: 1 }), "loom-verify", { allowBorrow: false }),
    ).toEqual({ admit: true, reason: "entitled" });
  });

  test("blocks over-entitlement when borrowing is disallowed", () => {
    expect(admissionCheck(p, occ({ ultra: 1 }), "ultra", { allowBorrow: false })).toEqual({
      admit: false,
      reason: "over-share",
    });
  });

  test("lends idle capacity when borrowing is allowed", () => {
    expect(admissionCheck(p, occ({ ultra: 1 }), "ultra", { allowBorrow: true })).toEqual({
      admit: true,
      reason: "borrowed",
    });
  });

  test("NFR-RF-6 the policy half is PURE — no argument mutated, no controller state touched", () => {
    // Purity is an architectural obligation here, so it is asserted rather than
    // inferred from "it has no imports": these three take policy and occupancy
    // as arguments and must neither write to them nor reach the live queue.
    const policy = defaultAdmissionPolicy({});
    const occupancy = occ({ "loom-build": 2 });
    const policyBefore = JSON.stringify(policy);
    const occupancyBefore = JSON.stringify(occupancy);
    const controllerBefore = JSON.stringify(admissionSnapshot());

    entitlement(policy, "ultra");
    availableFor(policy, occupancy);
    admissionCheck(policy, occupancy, "ultra", { allowBorrow: true });
    admissionCheck(policy, occupancy, "loom-build", { allowBorrow: false });

    expect(JSON.stringify(policy)).toBe(policyBefore);
    expect(JSON.stringify(occupancy)).toBe(occupancyBefore);
    expect(JSON.stringify(admissionSnapshot())).toBe(controllerBefore);
  });
});

describe("the queue", () => {
  beforeEach(() => resetAdmission({}));

  test("lets a single class borrow up to the whole ceiling", async () => {
    for (let i = 0; i < DEFAULT_ADMISSION_CEILING; i++) await acquireAdmission("ultra");
    const s = admissionSnapshot();
    expect(s.inFlight).toBe(4);
    expect(s.occupancy.ultra).toBe(4);
    expect(s.queued).toBe(0);
    for (let i = 0; i < 4; i++) releaseAdmission("ultra");
  });

  test("an omitted class lands in `other` — the untagged default engine.agent() uses", async () => {
    await acquireAdmission();
    expect(admissionSnapshot().occupancy.other).toBe(1);
    releaseAdmission();
    expect(admissionSnapshot().inFlight).toBe(0);
  });

  test("admissionCeiling reports the live policy ceiling", () => {
    expect(admissionCeiling()).toBe(DEFAULT_ADMISSION_CEILING);
    configureAdmission({ ceiling: 9 });
    expect(admissionCeiling()).toBe(9);
    resetAdmission({});
    expect(admissionCeiling()).toBe(DEFAULT_ADMISSION_CEILING);
  });

  test("never exceeds the ceiling, even when arrivals race a release", async () => {
    // The old gate's bug: a woken waiter did `active++` without re-checking, so
    // an arrival landing between release() and that resumption over-committed.
    //
    // MEASURED CAVEAT, recorded so nobody mistakes this for the pin: this case
    // is the SPEC reference suite's AC6 proof, and against a faithful revert of
    // the old gate (arrival barges + the waiter increments in its own
    // continuation) it still PASSES — every release here lands before any woken
    // waiter resumes, so the overlap it is named for never actually forms. The
    // load-bearing assertion is the next test, which was verified to FAIL
    // against that same revert ("Expected: 4, Received: 3"). Kept because it is
    // a real smoke test of the fixed controller and the name the spec cites.
    for (let i = 0; i < 4; i++) await acquireAdmission("loom-build");

    let peak = 4;
    const track = () => {
      peak = Math.max(peak, admissionSnapshot().inFlight);
    };

    const queued = [
      acquireAdmission("loom-build").then(track),
      acquireAdmission("ultra").then(track),
      acquireAdmission("loom-build").then(track),
    ];
    await settle();
    expect(admissionSnapshot().queued).toBe(3);

    // Release and immediately try to barge in with a fresh arrival.
    releaseAdmission("loom-build");
    const barger = acquireAdmission("other").then(track);
    track();

    releaseAdmission("loom-build");
    releaseAdmission("loom-build");
    releaseAdmission("loom-build");
    await Promise.all(queued);
    track();

    // Drain whatever is still holding a slot so the barger completes.
    drain();
    await barger;
    drain();

    expect(peak).toBeLessThanOrEqual(DEFAULT_ADMISSION_CEILING);
  });

  test("AC6 the slot is taken BEFORE the waiter wakes — a synchronous barge cannot over-commit", async () => {
    // The sharpest form of the same race, with no scheduling luck in it. The
    // window the old gate lost is the SYNCHRONOUS one between release() and the
    // woken waiter's resumption: `release()` decremented, scheduled the wake as
    // a microtask, and an acquire() landing before that microtask ran saw a free
    // slot. Here the barge is issued on the very next statement after the
    // release, so it lands squarely inside that window — and in-flight must
    // still read exactly the ceiling, never ceiling + 1.
    for (let i = 0; i < 4; i++) await acquireAdmission("loom-build");
    const waiter = acquireAdmission("loom-build");
    await settle();
    expect(admissionSnapshot().queued).toBe(1);

    releaseAdmission("loom-build"); // pump() takes the slot for the waiter, synchronously
    const barger = acquireAdmission("other"); // ...and this arrives before it resumes
    expect(admissionSnapshot().inFlight).toBe(DEFAULT_ADMISSION_CEILING);
    expect(admissionSnapshot().occupancy["loom-build"]).toBe(4);
    expect(admissionSnapshot().queued).toBe(1); // the barger queued; it did not take a slot

    await waiter;
    expect(admissionSnapshot().inFlight).toBe(DEFAULT_ADMISSION_CEILING);

    drain();
    await barger;
    drain();
    expect(admissionSnapshot().inFlight).toBe(0);
  });

  test("gives a freed slot to loom-verify ahead of a queued build fan-out", async () => {
    // The failure this class system exists to prevent: verification stuck
    // behind a build fan-out. Fill the pool with builds, queue more builds,
    // then queue one verify — verify must win the next release.
    for (let i = 0; i < 4; i++) await acquireAdmission("loom-build");

    const order: AdmissionClass[] = [];
    const pending = [
      acquireAdmission("loom-build").then(() => order.push("loom-build")),
      acquireAdmission("loom-build").then(() => order.push("loom-build")),
      acquireAdmission("loom-verify").then(() => order.push("loom-verify")),
    ];
    await settle();
    expect(admissionSnapshot().queued).toBe(3);

    releaseAdmission("loom-build");
    await settle();

    // Verify jumped the two builds that queued before it.
    expect(order).toEqual(["loom-verify"]);

    for (let i = 0; i < 3; i++) releaseAdmission("loom-build");
    await Promise.all(pending);
    drain();
  });

  test("AC5 admissionSnapshot NAMES WHY: priority order and waiting-by-class are both readable", async () => {
    // "Names why" is a contract, not a nicety: a reader must be able to
    // reconstruct the decision from the snapshot alone — who is in flight, who
    // is waiting in which class, and the order a freed slot will be offered in.
    for (let i = 0; i < 4; i++) await acquireAdmission("loom-build");
    const pending = [
      acquireAdmission("loom-build"),
      acquireAdmission("loom-build"),
      acquireAdmission("loom-verify"),
    ];
    await settle();

    const s = admissionSnapshot();
    expect(s.policy.ceiling).toBe(DEFAULT_ADMISSION_CEILING);
    expect(s.policy.priority).toEqual(["loom-verify", "loom-build", "ultra", "other"]);
    expect(s.policy.weight).toEqual({ "loom-build": 3, "loom-verify": 2, ultra: 2, other: 1 });
    expect(s.policy.floor).toEqual({ "loom-build": 1, "loom-verify": 1, ultra: 1, other: 0 });
    expect(s.occupancy).toEqual(occ({ "loom-build": 4 }));
    expect(s.waiting).toEqual(occ({ "loom-build": 2, "loom-verify": 1 }));
    expect(s.inFlight).toBe(4);
    expect(s.queued).toBe(3);
    // The whole decision, reconstructed from the snapshot with no extra reads:
    // the pool is full of builds, a verify is waiting, and verify leads the
    // priority order — so the next freed slot is the verify's.
    expect(s.policy.priority[0]).toBe("loom-verify");
    expect(s.waiting["loom-verify"]).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) releaseAdmission("loom-build");
    await Promise.all(pending);
    drain();
  });

  test("does not idle a slot when every waiter is over its entitlement", async () => {
    // Pass 2's reason for existing: with ceiling 2 and both classes at their
    // entitlement, a queued waiter must still get a freed slot by borrowing
    // rather than the pool sitting half empty.
    configureAdmission({ ceiling: 2 });
    await acquireAdmission("ultra");
    await acquireAdmission("ultra");

    let woke = false;
    const pending = acquireAdmission("ultra").then(() => {
      woke = true;
    });
    await settle();
    expect(woke).toBe(false);

    releaseAdmission("ultra");
    await settle();
    expect(woke).toBe(true);
    expect(admissionSnapshot().inFlight).toBe(2);

    await pending;
    releaseAdmission("ultra");
    releaseAdmission("ultra");
    resetAdmission({});
  });

  test("release is idempotent below zero — a double release cannot mint capacity", () => {
    releaseAdmission("ultra");
    releaseAdmission("ultra");
    expect(admissionSnapshot().occupancy.ultra).toBe(0);
    expect(admissionSnapshot().inFlight).toBe(0);
  });

  test("AC9 a double release of a HELD slot floors at zero rather than lending one out", async () => {
    // The dangerous shape of the same bug: release the slot you hold, then
    // release it again. An unfloored decrement would leave occupancy at -1 and
    // the ceiling would silently become 5.
    await acquireAdmission("loom-verify");
    expect(admissionSnapshot().occupancy["loom-verify"]).toBe(1);
    releaseAdmission("loom-verify");
    releaseAdmission("loom-verify");
    expect(admissionSnapshot().occupancy["loom-verify"]).toBe(0);
    expect(availableFor(admissionSnapshot().policy, admissionSnapshot().occupancy)).toBe(
      DEFAULT_ADMISSION_CEILING,
    );
  });

  test("refuses to reconfigure while waiters are queued", async () => {
    configureAdmission({ ceiling: 1 });
    await acquireAdmission("ultra");
    const pending = acquireAdmission("ultra");
    await settle();

    expect(() => configureAdmission({ ceiling: 8 })).toThrow(/waiters still queued/);
    expect(() => resetAdmission({})).toThrow(/waiters still queued/);

    releaseAdmission("ultra");
    await pending;
    releaseAdmission("ultra");
    resetAdmission({});
  });

  test("snapshot does not leak mutable internals", () => {
    const s = admissionSnapshot();
    s.occupancy.ultra = 99;
    s.policy.weight.ultra = 99;
    s.policy.floor.ultra = 99;
    s.waiting.ultra = 99;
    (s.policy.priority as AdmissionClass[]).push("ultra");
    expect(admissionSnapshot().occupancy.ultra).toBe(0);
    expect(admissionSnapshot().policy.weight.ultra).toBe(2);
    expect(admissionSnapshot().policy.floor.ultra).toBe(1);
    expect(admissionSnapshot().waiting.ultra).toBe(0);
    expect(admissionSnapshot().policy.priority).toEqual([
      "loom-verify",
      "loom-build",
      "ultra",
      "other",
    ]);
  });
});

describe("fanoutClamp — the process ceiling term", () => {
  const base = { maxAgents: 12, inFlight: 0, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 };

  test("is inert when no processCeiling is supplied (existing call sites unchanged)", () => {
    const c = fanoutClamp(8, base);
    expect(c.capByProcess).toBe(Infinity);
    expect(c.chosen).toBe(8);
    expect(c.binding).toBe("pieces");
  });

  test("binds when the process admits less than the charter promises", () => {
    // The headline defect: a Charter asking for 12 under a ceiling of 4.
    const c = fanoutClamp(12, { ...base, processCeiling: DEFAULT_ADMISSION_CEILING });
    expect(c.capByPool).toBe(12);
    expect(c.chosen).toBe(4);
    expect(c.binding).toBe("process");
  });

  test("still reports pool or budget when one of those is tighter", () => {
    expect(fanoutClamp(12, { ...base, inFlight: 10, processCeiling: 4 }).binding).toBe("pool");
    expect(fanoutClamp(12, { ...base, budgetLeftUsd: 0.6, processCeiling: 4 }).binding).toBe(
      "budget",
    );
  });

  test("does not inflate demand — a small piece count still wins", () => {
    const c = fanoutClamp(2, { ...base, processCeiling: 4 });
    expect(c.chosen).toBe(2);
    expect(c.binding).toBe("pieces");
  });

  test("AC10 the pool -> budget tie-break is byte-identical with the new term absent", () => {
    // NFR-RF-9. The regression this guards is subtle: `process` joining the
    // tie-break could steal the `binding` readout from `pool` or `budget` at a
    // tie, and orchestrator.test.ts asserts those two strings directly. Swept
    // over the whole small grid rather than spot-checked.
    for (let maxAgents = 0; maxAgents <= 6; maxAgents++) {
      for (let inFlight = 0; inFlight <= 6; inFlight++) {
        for (const budgetLeftUsd of [0, 0.4, 1, 2.5, 5, Infinity]) {
          for (const pieces of [1, 2, 5, 12]) {
            const args = { maxAgents, inFlight, budgetLeftUsd, estCostPerAgent: 0.5 };
            const c = fanoutClamp(pieces, args);
            expect(c.capByProcess).toBe(Infinity);
            // The pre-term formula, restated here so a rewrite of fanoutClamp
            // is compared against the OLD contract, not against itself.
            const capByPool = maxAgents - inFlight;
            const capByBudget = isFinite(budgetLeftUsd) ? Math.floor(budgetLeftUsd / 0.5) : Infinity;
            const cap = Math.min(capByPool, capByBudget);
            const p = Math.max(1, pieces);
            const expected =
              cap <= 0
                ? { chosen: 0, binding: "pool-exhausted" }
                : {
                    chosen: Math.min(p, cap),
                    binding:
                      Math.min(p, cap) === p ? "pieces" : capByPool <= capByBudget ? "pool" : "budget",
                  };
            expect({ chosen: c.chosen, binding: c.binding }).toEqual(expected);
          }
        }
      }
    }
  });

  test("AC10 a zero process ceiling is pool-exhausted, and capByProcess is always reported", () => {
    const c = fanoutClamp(5, { ...base, processCeiling: 0 });
    expect(c.chosen).toBe(0);
    expect(c.binding).toBe("pool-exhausted");
    expect(c.capByProcess).toBe(0);
    // capByProcess is part of the readout on every path, not only the binding one.
    expect(fanoutClamp(5, { ...base, processCeiling: 9 }).capByProcess).toBe(9);
    expect(fanoutClamp(5, base).capByProcess).toBe(Infinity);
  });
});
