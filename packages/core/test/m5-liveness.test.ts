// M5 ownership oracle: the two liveness backings + the double-dispatch guard.
import { describe, expect, test } from "bun:test";
import { makeInProcessLiveness, crossProcessLiveness, refuseIfLive } from "../src/runner/liveness";
import type { RunnerLease } from "../src/runner/lease";

describe("makeInProcessLiveness (flag-off backing)", () => {
  test("byte-identical to activeLoomIds().includes(id)", () => {
    const live = makeInProcessLiveness(() => ["a", "b"]);
    expect(live("a")).toBe(true);
    expect(live("c")).toBe(false);
  });
});

describe("crossProcessLiveness (flag-on backing)", () => {
  const lease = (ts: number): RunnerLease => ({ pid: 1, token: "t", ts });

  test("fresh lease ⇒ LIVE even when the runner is unreachable (empty /active)", () => {
    const now = () => 1000;
    const live = crossProcessLiveness(new Set(), (id) => (id === "L1" ? lease(950) : null), 100, now);
    expect(live("L1")).toBe(true);
  });

  test("stale lease + not in /active ⇒ DEAD", () => {
    const now = () => 1000;
    const live = crossProcessLiveness(new Set(), (id) => (id === "L1" ? lease(800) : null), 100, now);
    expect(live("L1")).toBe(false);
  });

  test("absent lease + not in /active ⇒ DEAD", () => {
    const live = crossProcessLiveness(new Set(), () => null, 100, () => 1000);
    expect(live("L1")).toBe(false);
  });

  test("in /active ⇒ LIVE regardless of lease", () => {
    const live = crossProcessLiveness(new Set(["L1"]), () => null, 100, () => 1000);
    expect(live("L1")).toBe(true);
  });
});

describe("refuseIfLive (R2 double-dispatch guard)", () => {
  test("throws when the loom is owned by a live runner", () => {
    expect(() => refuseIfLive("L1", () => true)).toThrow(/double-execution guard/);
  });

  test("no-op when not live (flag-off never blocks a local redispatch)", () => {
    expect(() => refuseIfLive("L1", () => false)).not.toThrow();
  });
});
