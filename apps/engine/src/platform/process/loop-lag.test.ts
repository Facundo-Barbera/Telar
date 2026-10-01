import { expect, test } from "bun:test";
import { createLoopLag } from "./loop-lag";

function clocked() {
  let at = 0;
  const warnings: string[] = [];
  const lag = createLoopLag({ thresholdMs: 500, intervalMs: 100, now: () => at, warn: (line) => warnings.push(line) });
  return { lag, warnings, advance: (ms: number) => (at += ms) };
}

test("a tick on time records no stall", () => {
  const { lag, warnings, advance } = clocked();
  advance(100);
  lag.tick();
  expect(lag.health()).toEqual({ thresholdMs: 500, maxLagMs: 0, stalls: [] });
  expect(warnings).toEqual([]);
});

test("a late tick names the longest labelled section since the previous tick", () => {
  const { lag, warnings, advance } = clocked();
  lag.run("GET /v2/sessions", () => advance(50));
  lag.run("boot: housekeeping", () => advance(700));
  advance(50);
  lag.tick();
  expect(lag.health().maxLagMs).toBe(700);
  expect(lag.health().stalls.map(({ lagMs, operation }) => ({ lagMs, operation }))).toEqual([{ lagMs: 700, operation: "boot: housekeeping" }]);
  expect(warnings).toEqual(["Telar engine: the event loop stalled 700 ms during boot: housekeeping"]);
});

test("a stall with no labelled section is reported as unlabelled, and labels reset each tick", () => {
  const { lag, advance } = clocked();
  lag.run("sweep cleanup", () => advance(10));
  advance(90);
  lag.tick();
  advance(900);
  lag.tick();
  expect(lag.health().stalls.map((stall) => stall.operation)).toEqual(["unlabelled"]);
});

test("run returns the section's value and still records a throwing section", () => {
  const { lag, advance } = clocked();
  expect(lag.run("ok", () => 42)).toBe(42);
  expect(() => lag.run("boom", () => { advance(800); throw new Error("x"); })).toThrow("x");
  lag.tick();
  expect(lag.health().stalls[0]?.operation).toBe("boom");
});

test("only the latest twenty stalls are kept", () => {
  const { lag, advance } = clocked();
  for (let index = 0; index < 25; index += 1) {
    advance(100 + 500 + index);
    lag.tick();
  }
  const { stalls, maxLagMs } = lag.health();
  expect(stalls).toHaveLength(20);
  expect(stalls[0]?.lagMs).toBe(505);
  expect(maxLagMs).toBe(524);
});
