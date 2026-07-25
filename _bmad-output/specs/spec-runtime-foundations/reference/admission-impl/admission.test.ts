import { describe, expect, it, beforeEach } from "bun:test";
import {
  ADMISSION_CLASSES,
  DEFAULT_ADMISSION_CEILING,
  acquireAdmission,
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

describe("readCeiling — tolerant parse, never throws at import", () => {
  it("defaults when unset or blank", () => {
    expect(readCeiling({})).toBe(DEFAULT_ADMISSION_CEILING);
    expect(readCeiling({ TELAR_MAX_AGENTS: "" })).toBe(DEFAULT_ADMISSION_CEILING);
    expect(readCeiling({ TELAR_MAX_AGENTS: "   " })).toBe(DEFAULT_ADMISSION_CEILING);
  });

  it("accepts a positive integer", () => {
    expect(readCeiling({ TELAR_MAX_AGENTS: "12" })).toBe(12);
    expect(readCeiling({ TELAR_MAX_AGENTS: "1" })).toBe(1);
  });

  it("falls back on garbage rather than throwing", () => {
    for (const bad of ["0", "-3", "2.5", "abc", "NaN", "1e3x"]) {
      expect(readCeiling({ TELAR_MAX_AGENTS: bad })).toBe(DEFAULT_ADMISSION_CEILING);
    }
  });
});

describe("entitlement — pure, weighted with a floor", () => {
  it("at the default ceiling of 4 the floors dominate: one each", () => {
    const p = defaultAdmissionPolicy({});
    expect(entitlement(p, "loom-build")).toBe(1);
    expect(entitlement(p, "loom-verify")).toBe(1);
    expect(entitlement(p, "ultra")).toBe(1);
    // `other` has floor 0 and weight 1 of 8 -> floor(4/8) = 0
    expect(entitlement(p, "other")).toBe(0);
  });

  it("weights take over once the ceiling is large enough", () => {
    const p = { ...defaultAdmissionPolicy({}), ceiling: 16 };
    // weights 3/2/2/1 of 8 over a ceiling of 16
    expect(entitlement(p, "loom-build")).toBe(6);
    expect(entitlement(p, "loom-verify")).toBe(4);
    expect(entitlement(p, "ultra")).toBe(4);
    expect(entitlement(p, "other")).toBe(2);
  });

  it("never drops below the class floor", () => {
    const p = { ...defaultAdmissionPolicy({}), ceiling: 1 };
    expect(entitlement(p, "loom-verify")).toBe(1); // floor 1 beats floor(1*2/8)=0
    expect(entitlement(p, "other")).toBe(0);
  });

  it("survives an all-zero weight map without dividing by zero", () => {
    const p = {
      ...defaultAdmissionPolicy({}),
      weight: occ() as ClassMap,
    };
    for (const c of ADMISSION_CLASSES) expect(Number.isFinite(entitlement(p, c))).toBe(true);
  });
});

describe("admissionCheck — pure decision", () => {
  const p = defaultAdmissionPolicy({}); // ceiling 4

  it("refuses at the ceiling regardless of class or borrow", () => {
    const full = occ({ "loom-build": 4 });
    expect(admissionCheck(p, full, "loom-verify", { allowBorrow: true })).toEqual({
      admit: false,
      reason: "at-ceiling",
    });
    expect(availableFor(p, full)).toBe(0);
  });

  it("admits within entitlement even while others are queued", () => {
    expect(
      admissionCheck(p, occ({ "loom-build": 2, ultra: 1 }), "loom-verify", { allowBorrow: false }),
    ).toEqual({ admit: true, reason: "entitled" });
  });

  it("blocks over-entitlement when borrowing is disallowed", () => {
    expect(admissionCheck(p, occ({ ultra: 1 }), "ultra", { allowBorrow: false })).toEqual({
      admit: false,
      reason: "over-share",
    });
  });

  it("lends idle capacity when borrowing is allowed", () => {
    expect(admissionCheck(p, occ({ ultra: 1 }), "ultra", { allowBorrow: true })).toEqual({
      admit: true,
      reason: "borrowed",
    });
  });
});

describe("the queue", () => {
  beforeEach(() => resetAdmission({}));

  it("lets a single class borrow up to the whole ceiling", async () => {
    for (let i = 0; i < DEFAULT_ADMISSION_CEILING; i++) await acquireAdmission("ultra");
    const s = admissionSnapshot();
    expect(s.inFlight).toBe(4);
    expect(s.occupancy.ultra).toBe(4);
    expect(s.queued).toBe(0);
    for (let i = 0; i < 4; i++) releaseAdmission("ultra");
  });

  it("never exceeds the ceiling, even when arrivals race a release", async () => {
    // The old gate's bug: a woken waiter did `active++` without re-checking, so
    // an arrival landing between release() and that resumption over-committed.
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
    for (const c of ADMISSION_CLASSES) {
      const held = admissionSnapshot().occupancy[c];
      for (let i = 0; i < held; i++) releaseAdmission(c);
    }
    await barger;
    for (const c of ADMISSION_CLASSES) {
      const held = admissionSnapshot().occupancy[c];
      for (let i = 0; i < held; i++) releaseAdmission(c);
    }

    expect(peak).toBeLessThanOrEqual(DEFAULT_ADMISSION_CEILING);
  });

  it("gives a freed slot to loom-verify ahead of a queued build fan-out", async () => {
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
    for (const c of ADMISSION_CLASSES) {
      const held = admissionSnapshot().occupancy[c];
      for (let i = 0; i < held; i++) releaseAdmission(c);
    }
  });

  it("does not idle a slot when every waiter is over its entitlement", async () => {
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

  it("release is idempotent below zero — a double release cannot mint capacity", () => {
    releaseAdmission("ultra");
    releaseAdmission("ultra");
    expect(admissionSnapshot().occupancy.ultra).toBe(0);
    expect(admissionSnapshot().inFlight).toBe(0);
  });

  it("refuses to reconfigure while waiters are queued", async () => {
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

  it("snapshot does not leak mutable internals", () => {
    const s = admissionSnapshot();
    s.occupancy.ultra = 99;
    s.policy.weight.ultra = 99;
    expect(admissionSnapshot().occupancy.ultra).toBe(0);
    expect(admissionSnapshot().policy.weight.ultra).toBe(2);
  });
});

describe("fanoutClamp — the process ceiling term", () => {
  const base = { maxAgents: 12, inFlight: 0, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 };

  it("is inert when no processCeiling is supplied (existing call sites unchanged)", () => {
    const c = fanoutClamp(8, base);
    expect(c.capByProcess).toBe(Infinity);
    expect(c.chosen).toBe(8);
    expect(c.binding).toBe("pieces");
  });

  it("binds when the process admits less than the charter promises", () => {
    // The headline defect: a Charter asking for 12 under a ceiling of 4.
    const c = fanoutClamp(12, { ...base, processCeiling: DEFAULT_ADMISSION_CEILING });
    expect(c.capByPool).toBe(12);
    expect(c.chosen).toBe(4);
    expect(c.binding).toBe("process");
  });

  it("still reports pool or budget when one of those is tighter", () => {
    expect(fanoutClamp(12, { ...base, inFlight: 10, processCeiling: 4 }).binding).toBe("pool");
    expect(fanoutClamp(12, { ...base, budgetLeftUsd: 0.6, processCeiling: 4 }).binding).toBe(
      "budget",
    );
  });

  it("does not inflate demand — a small piece count still wins", () => {
    const c = fanoutClamp(2, { ...base, processCeiling: 4 });
    expect(c.chosen).toBe(2);
    expect(c.binding).toBe("pieces");
  });
});
