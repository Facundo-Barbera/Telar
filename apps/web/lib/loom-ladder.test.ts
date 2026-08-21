// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Rung } from "@telar/engine-client";
import { ladderAbsorbed, ladderSummary, ladderTrace } from "./loom-ladder";

const LADDER: Rung[] = [
  { n: 1, label: "re-read the item", enabled: true, absorbed: 4 },
  { n: 2, label: "run the gate again", enabled: true, absorbed: 2 },
  { n: 3, label: "narrow the scope", enabled: false, absorbed: 0 },
  { n: 4, label: "start over", enabled: true, absorbed: 0 },
];

describe("ladderTrace", () => {
  test("rungs at or below the loom's rung ran; the rest did not", () => {
    const steps = ladderTrace(LADDER, { ladderRung: 2 });
    expect(steps.filter((step) => step.tried).map((step) => step.n)).toEqual([1, 2]);
  });

  test("a disabled rung never counts as tried, even below the current rung", () => {
    // Rungs are skipped when off, so rung 3 cannot have run at rung 4.
    const steps = ladderTrace(LADDER, { ladderRung: 4 });
    expect(steps.find((step) => step.n === 3)?.tried).toBe(false);
    expect(steps.find((step) => step.n === 4)?.tried).toBe(true);
  });

  test("disabled rungs are still returned", () => {
    // An off rung is a CHOICE the human made. A row that hid it could not show
    // them that the thing they switched off is the thing that would have caught
    // this.
    expect(ladderTrace(LADDER, { ladderRung: 0 })).toHaveLength(4);
  });

  test("rungs come back in order regardless of how they were authored", () => {
    const shuffled = [LADDER[3]!, LADDER[0]!, LADDER[2]!, LADDER[1]!];
    expect(ladderTrace(shuffled, { ladderRung: 0 }).map((step) => step.n)).toEqual([1, 2, 3, 4]);
  });

  test("nothing has run before the first rung", () => {
    expect(ladderTrace(LADDER, { ladderRung: 0 }).some((step) => step.tried)).toBe(false);
  });
});

describe("ladderSummary", () => {
  test("an empty ladder says so, rather than implying something was tried", () => {
    expect(ladderSummary(ladderTrace([], { ladderRung: 0 }))).toContain("empty");
  });

  test("nothing tried is stated plainly", () => {
    expect(ladderSummary(ladderTrace(LADDER, { ladderRung: 0 }))).toContain("Nothing was tried");
  });

  test("it counts tried rungs against the ENABLED ones, not against all of them", () => {
    // "2 of 4" would be a lie when one rung is switched off and can never run.
    const summary = ladderSummary(ladderTrace(LADDER, { ladderRung: 2 }));
    expect(summary).toContain("2 of 3 rungs ran");
  });

  test("a ladder that has never absorbed anything is named as the suspect", () => {
    const barren: Rung[] = [{ n: 1, label: "x", enabled: true, absorbed: 0 }];
    expect(ladderSummary(ladderTrace(barren, { ladderRung: 1 }))).toContain("the ladder may be the problem");
  });

  test("the lifetime absorbed total is reported, because it is the ladder's scoreboard", () => {
    expect(ladderSummary(ladderTrace(LADDER, { ladderRung: 2 }))).toContain("absorbed 6 before");
  });
});

describe("ladderAbsorbed", () => {
  test("only enabled rungs count", () => {
    expect(ladderAbsorbed({ ladder: LADDER })).toBe(6);
  });

  test("no program is zero, not a crash", () => {
    expect(ladderAbsorbed(null)).toBe(0);
    expect(ladderAbsorbed(undefined)).toBe(0);
  });
});
