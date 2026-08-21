/**
 * The escalation ladder.
 *
 * The rules that are asserted rather than assumed: in order, once each,
 * disabled skipped, and `attempts` CAPPED at the number of enabled rungs. The
 * cap is the promise — "there is no fourth try" — so it is tested both the
 * ordinary way (walk the ladder to the end) and the adversarial way (hand it a
 * loom whose counters have been corrupted).
 */
import { describe, expect, test } from "bun:test";
import { LoomProgram, type Loom, type LoomProgram as LoomProgramType } from "@telar/engine-client";
import { absorbRung, nextRung, rungsRemaining } from "../src/loom/ladder";

const at = 1_700_000_000_000;

const loom = (patch: Partial<Loom> = {}): Loom => ({
  id: "loom_1",
  projectId: "proj_1",
  item: "#457",
  title: "t",
  state: "stuck",
  attempts: 0,
  ladderRung: 0,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

const withLadder = (ladder: Array<{ n: number; label: string; enabled: boolean; absorbed?: number }>): LoomProgramType =>
  LoomProgram.parse({ ladder });

const THREE = withLadder([
  { n: 1, label: "re-read the item", enabled: true },
  { n: 2, label: "run the gate again", enabled: true },
  { n: 3, label: "narrow the scope", enabled: true },
]);

describe("rungs are tried in order, cheapest first", () => {
  test("a fresh loom gets rung 1", () => {
    const step = nextRung(loom(), THREE);
    expect("exhausted" in step).toBe(false);
    if ("exhausted" in step) return;
    expect(step.rung.n).toBe(1);
    expect(step.rung.label).toBe("re-read the item");
    expect(step.loom.attempts).toBe(1);
    expect(step.loom.ladderRung).toBe(1);
  });

  test("authoring order does not matter — the numbering does", () => {
    const scrambled = withLadder([
      { n: 3, label: "third", enabled: true },
      { n: 1, label: "first", enabled: true },
      { n: 2, label: "second", enabled: true },
    ]);
    const step = nextRung(loom(), scrambled);
    if ("exhausted" in step) throw new Error("expected a rung");
    expect(step.rung.label).toBe("first");
  });

  test("a rung is tried once — walking the whole ladder never repeats one", () => {
    let current = loom();
    const tried: number[] = [];
    for (;;) {
      const step = nextRung(current, THREE);
      if ("exhausted" in step) break;
      tried.push(step.rung.n);
      current = step.loom;
    }
    expect(tried).toEqual([1, 2, 3]);
    expect(new Set(tried).size).toBe(tried.length);
  });

  test("past the last enabled rung it is exhausted — the caller moves it to asking", () => {
    const spent = loom({ attempts: 3, ladderRung: 3 });
    expect(nextRung(spent, THREE)).toEqual({ exhausted: true });
  });

  test("resuming mid-ladder after a restart continues rather than repeating", () => {
    const step = nextRung(loom({ attempts: 1, ladderRung: 1 }), THREE);
    if ("exhausted" in step) throw new Error("expected a rung");
    expect(step.rung.n).toBe(2);
  });
});

describe("disabled rungs are skipped entirely", () => {
  const MIXED = withLadder([
    { n: 1, label: "cheap", enabled: true },
    { n: 2, label: "switched off", enabled: false },
    { n: 3, label: "expensive", enabled: true },
    { n: 4, label: "also off", enabled: false },
  ]);

  test("off means off, not later", () => {
    let current = loom();
    const tried: string[] = [];
    for (;;) {
      const step = nextRung(current, MIXED);
      if ("exhausted" in step) break;
      tried.push(step.rung.label);
      current = step.loom;
    }
    expect(tried).toEqual(["cheap", "expensive"]);
  });

  test("a ladder with nothing enabled is exhausted immediately", () => {
    const off = withLadder([{ n: 1, label: "x", enabled: false }]);
    expect(nextRung(loom(), off)).toEqual({ exhausted: true });
  });

  test("no ladder at all is exhausted immediately — straight to the human", () => {
    expect(nextRung(loom(), LoomProgram.parse({}))).toEqual({ exhausted: true });
  });
});

describe("attempts can never exceed the number of enabled rungs", () => {
  test("walking a three-rung ladder stops at three", () => {
    let current = loom();
    let guard = 0;
    for (; guard < 50; guard++) {
      const step = nextRung(current, THREE);
      if ("exhausted" in step) break;
      current = step.loom;
    }
    expect(current.attempts).toBe(3);
    expect(guard).toBe(3);
  });

  test("two enabled rungs out of five means at most two attempts", () => {
    const MIXED = withLadder([
      { n: 1, label: "a", enabled: true },
      { n: 2, label: "b", enabled: false },
      { n: 3, label: "c", enabled: true },
      { n: 4, label: "d", enabled: false },
      { n: 5, label: "e", enabled: false },
    ]);
    let current = loom();
    for (let i = 0; i < 20; i++) {
      const step = nextRung(current, MIXED);
      if ("exhausted" in step) break;
      current = step.loom;
    }
    expect(current.attempts).toBe(2);
  });

  test("A TWO-RUNG LADDER TRIES BOTH RUNGS — the last rung is not eaten by dispatch", () => {
    // The regression this pins: `attempts` counts RUNGS CONSUMED, not sessions
    // started. If provisioning a loom bumped `attempts` to 1, the second stuck
    // would hit `1 >= 2` and escalate, so the last enabled rung of every ladder
    // would silently never run. A freshly dispatched loom is attempts: 0.
    const TWO = withLadder([
      { n: 1, label: "re-read the item", enabled: true },
      { n: 2, label: "run the gate again", enabled: true },
    ]);
    const fresh = loom({ attempts: 0, ladderRung: 0 });

    const first = nextRung(fresh, TWO);
    if ("exhausted" in first) throw new Error("a fresh loom must get rung 1");
    expect(first.rung.n).toBe(1);
    expect(first.loom.attempts).toBe(1);

    const second = nextRung(first.loom, TWO);
    if ("exhausted" in second) throw new Error("rung 2 must be tried before asking");
    expect(second.rung.n).toBe(2);
    expect(second.loom.attempts).toBe(2);

    // Only NOW is the human woken.
    expect(nextRung(second.loom, TWO)).toEqual({ exhausted: true });
  });

  test("rung N sets attempts to exactly N — the two counters stay in step", () => {
    let current = loom();
    for (const n of [1, 2, 3]) {
      const step = nextRung(current, THREE);
      if ("exhausted" in step) throw new Error(`expected rung ${n}`);
      expect(step.rung.n).toBe(n);
      expect(step.loom.attempts).toBe(n);
      expect(step.loom.ladderRung).toBe(n);
      current = step.loom;
    }
  });

  test("a loom whose counters disagree is still capped — the cap does not trust ladderRung", () => {
    // attempts already at the ceiling, ladderRung stale at 0: without the
    // independent cap this would hand out rung 1 for a fourth time.
    expect(nextRung(loom({ attempts: 3, ladderRung: 0 }), THREE)).toEqual({ exhausted: true });
    expect(nextRung(loom({ attempts: 99, ladderRung: 0 }), THREE)).toEqual({ exhausted: true });
  });

  test("nextRung does not mutate the loom it was handed", () => {
    const before = loom();
    nextRung(before, THREE);
    expect(before.attempts).toBe(0);
    expect(before.ladderRung).toBe(0);
  });

  test("it does not move the loom's state — that is the caller's decision", () => {
    const step = nextRung(loom({ state: "stuck" }), THREE);
    if ("exhausted" in step) throw new Error("expected a rung");
    expect(step.loom.state).toBe("stuck");
  });
});

describe("rungsRemaining", () => {
  test("counts what is left, not what exists", () => {
    expect(rungsRemaining(loom(), THREE)).toBe(3);
    expect(rungsRemaining(loom({ ladderRung: 2 }), THREE)).toBe(1);
    expect(rungsRemaining(loom({ ladderRung: 3 }), THREE)).toBe(0);
  });
});

describe("absorbed is the feedback loop", () => {
  test("crediting a rung increments only that rung", () => {
    const after = absorbRung(THREE, 2);
    expect(after.ladder.map((r) => r.absorbed)).toEqual([0, 1, 0]);
    // and it is pure
    expect(THREE.ladder.map((r) => r.absorbed)).toEqual([0, 0, 0]);
  });

  test("credits accumulate across calls", () => {
    const after = absorbRung(absorbRung(absorbRung(THREE, 1), 1), 3);
    expect(after.ladder.map((r) => r.absorbed)).toEqual([2, 0, 1]);
  });

  test("a rung the human deleted mid-flight loses the credit rather than throwing", () => {
    const same = absorbRung(THREE, 9);
    expect(same).toBe(THREE);
  });

  test("a disabled rung can still be credited — it was enabled when it ran", () => {
    const mixed = withLadder([{ n: 1, label: "x", enabled: false, absorbed: 4 }]);
    expect(absorbRung(mixed, 1).ladder[0]?.absorbed).toBe(5);
  });
});
