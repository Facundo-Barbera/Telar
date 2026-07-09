import { describe, expect, test } from "bun:test";
import { aggregatePanel, classifyPanel, panelSize, type PanelSignals } from "../src/panel";
import type { CriticFinding, CriticVerdict, PanelReport } from "../src/schemas";

const zeroSignals: PanelSignals = {
  diffLines: 0,
  filesTouched: 0,
  filesOutsideAllowed: 0,
  protectedPathsTouched: false,
  priorFailingCritics: 0,
};

const hasFloorLens = (lenses: { class: string; blocker: boolean }[]) =>
  lenses.some((l) => (l.class === "adversarial" || l.class === "reproduction") && l.blocker);

function verdict(overrides: Partial<CriticVerdict> = {}): CriticVerdict {
  return {
    lens: "intent/acceptance",
    class: "intent",
    blocker: true,
    ok: true,
    summary: "ok",
    findings: [],
    evidence: [],
    ...overrides,
  };
}

function finding(overrides: Partial<CriticFinding> = {}): CriticFinding {
  return {
    severity: "minor",
    title: "t",
    detail: "d",
    evidence: [],
    ...overrides,
  };
}

describe("panelSize (§M.4 pure sizer)", () => {
  test("always includes an intent blocker lens", () => {
    const lenses = panelSize(zeroSignals);
    expect(lenses.some((l) => l.class === "intent" && l.blocker)).toBe(true);
  });

  test("floor holds for the all-zero signal combo", () => {
    expect(hasFloorLens(panelSize(zeroSignals))).toBe(true);
  });

  test("floor holds across every signal combination (exhaustive small grid)", () => {
    const diffOpts = [0, 1, 399, 400, 5000];
    const filesOpts = [0, 1, 7, 8, 50];
    const outsideOpts = [0, 1, 3];
    const protectedOpts = [false, true];
    const priorOpts = [0, 1, 5];

    for (const diffLines of diffOpts) {
      for (const filesTouched of filesOpts) {
        for (const filesOutsideAllowed of outsideOpts) {
          for (const protectedPathsTouched of protectedOpts) {
            for (const priorFailingCritics of priorOpts) {
              const lenses = panelSize({
                diffLines,
                filesTouched,
                filesOutsideAllowed,
                protectedPathsTouched,
                priorFailingCritics,
              });
              expect(hasFloorLens(lenses)).toBe(true);
              expect(lenses.some((l) => l.class === "intent" && l.blocker)).toBe(true);
            }
          }
        }
      }
    }
  });

  test("trivial change (tiny diff, in-scope) yields the minimal floor only", () => {
    const lenses = panelSize(zeroSignals);
    expect(lenses).toEqual([
      { class: "intent", lens: "intent/acceptance", blocker: true },
      { class: "adversarial", lens: "adversarial/edge", blocker: true },
    ]);
  });

  test("large diffLines scales up: adds a reproduction blocker + live-experience advisory", () => {
    const lenses = panelSize({ ...zeroSignals, diffLines: 500 });
    expect(lenses.some((l) => l.class === "reproduction" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "live-experience" && !l.blocker)).toBe(true);
  });

  test("many filesTouched scales up the same way as large diff", () => {
    const lenses = panelSize({ ...zeroSignals, filesTouched: 8 });
    expect(lenses.some((l) => l.class === "reproduction" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "live-experience" && !l.blocker)).toBe(true);
  });

  test("filesOutsideAllowed > 0 adds a security blocker lens", () => {
    const lenses = panelSize({ ...zeroSignals, filesOutsideAllowed: 1 });
    expect(lenses.some((l) => l.class === "security" && l.blocker)).toBe(true);
  });

  test("protectedPathsTouched adds a security blocker lens", () => {
    const lenses = panelSize({ ...zeroSignals, protectedPathsTouched: true });
    expect(lenses.some((l) => l.class === "security" && l.blocker)).toBe(true);
  });

  test("out-of-scope alone (small diff) does not add reproduction/live-experience", () => {
    const lenses = panelSize({ ...zeroSignals, filesOutsideAllowed: 1 });
    expect(lenses.some((l) => l.class === "reproduction")).toBe(false);
    expect(lenses.some((l) => l.class === "live-experience")).toBe(false);
  });

  test("priorFailingCritics > 0 ensures BOTH adversarial and reproduction blockers run", () => {
    const lenses = panelSize({ ...zeroSignals, priorFailingCritics: 1 });
    expect(lenses.some((l) => l.class === "adversarial" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "reproduction" && l.blocker)).toBe(true);
  });

  test("all signals hot: floor, reproduction, live-experience, and security all present", () => {
    const lenses = panelSize({
      diffLines: 1000,
      filesTouched: 20,
      filesOutsideAllowed: 2,
      protectedPathsTouched: true,
      priorFailingCritics: 3,
    });
    expect(lenses.some((l) => l.class === "intent" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "adversarial" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "reproduction" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "security" && l.blocker)).toBe(true);
    expect(lenses.some((l) => l.class === "live-experience" && !l.blocker)).toBe(true);
  });

  test("deterministic: same input always yields the identical lens list", () => {
    const signals = { diffLines: 450, filesTouched: 3, filesOutsideAllowed: 0, protectedPathsTouched: false, priorFailingCritics: 0 };
    expect(panelSize(signals)).toEqual(panelSize(signals));
  });
});

describe("aggregatePanel (§M.3 pure verdict)", () => {
  test("hard-fails on an empty critic set (nothing ran)", () => {
    const result = aggregatePanel([]);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/floor/i);
  });

  test("hard-fails on a floorless panel even when every present critic is ok (vacuous-panel attack)", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "live-experience/ux", class: "live-experience", blocker: false, ok: true }),
    ];
    const result = aggregatePanel(critics);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/floor/i);
  });

  test("hard-fails when the only adversarial/reproduction critic present is non-blocker", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: false, ok: true }),
    ];
    const result = aggregatePanel(critics);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/floor/i);
  });

  test("fails when a blocker critic is not ok", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: false }),
    ];
    const result = aggregatePanel(critics);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/adversarial\/edge/);
  });

  test("fails when any critic (even a non-blocker one) has a blocker-severity finding, despite ok=true everywhere", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
      verdict({
        lens: "live-experience/ux",
        class: "live-experience",
        blocker: false,
        ok: true,
        findings: [finding({ severity: "blocker", title: "silent data loss" })],
      }),
    ];
    const result = aggregatePanel(critics);
    expect(result.pass).toBe(false);
    expect(result.blockerFindings).toHaveLength(1);
    expect(result.reason).toMatch(/blocker-severity/);
  });

  test("passes only when the floor is present, all blocker critics are ok, and no blocker findings exist", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({
        lens: "adversarial/edge",
        class: "adversarial",
        blocker: true,
        ok: true,
        findings: [finding({ severity: "minor" })], // non-blocker severity must not block
      }),
      verdict({ lens: "live-experience/ux", class: "live-experience", blocker: false, ok: false }), // advisory failure must not block
    ];
    const result = aggregatePanel(critics);
    expect(result.pass).toBe(true);
    expect(result.blockerFindings).toEqual([]);
  });

  test("passes with reproduction as the floor lens instead of adversarial", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "reproduction/cold", class: "reproduction", blocker: true, ok: true }),
    ];
    expect(aggregatePanel(critics).pass).toBe(true);
  });

  test("fails when a sized blocker lens never reported (crashed/null), even though the floor holds and every present critic is ok", () => {
    // intent was sized as a blocker but its agent call crashed/never emitted
    // -> it simply isn't in `critics`. Without `sized`, hasFloor + no-failing
    // -blocker-critic would wrongly pass this (the bug being fixed).
    const critics: CriticVerdict[] = [
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
    ];
    const sized = [
      { class: "intent" as const, lens: "intent/acceptance", blocker: true },
      { class: "adversarial" as const, lens: "adversarial/edge", blocker: true },
    ];
    const result = aggregatePanel(critics, sized);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/intent\/acceptance/);
  });

  test("passes when every sized blocker lens has a matching present critic", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
    ];
    const sized = [
      { class: "intent" as const, lens: "intent/acceptance", blocker: true },
      { class: "adversarial" as const, lens: "adversarial/edge", blocker: true },
    ];
    expect(aggregatePanel(critics, sized).pass).toBe(true);
  });

  test("omitting `sized` preserves the old present-critics-only behavior (back-compat)", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
    ];
    // No `sized` passed — a missing intent lens is simply never checked,
    // matching pre-fix behavior for any caller that doesn't supply it.
    expect(aggregatePanel(critics).pass).toBe(true);
  });

  test("a missing NON-blocker sized lens does not fail the panel", () => {
    const critics: CriticVerdict[] = [
      verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
      verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
    ];
    const sized = [
      { class: "intent" as const, lens: "intent/acceptance", blocker: true },
      { class: "adversarial" as const, lens: "adversarial/edge", blocker: true },
      { class: "live-experience" as const, lens: "live-experience/ux", blocker: false }, // advisory, crashed
    ];
    expect(aggregatePanel(critics, sized).pass).toBe(true);
  });

  test("collects blocker findings across multiple critics", () => {
    const critics: CriticVerdict[] = [
      verdict({
        lens: "intent/acceptance",
        class: "intent",
        blocker: true,
        ok: true,
        findings: [finding({ severity: "blocker", title: "a" })],
      }),
      verdict({
        lens: "adversarial/edge",
        class: "adversarial",
        blocker: true,
        ok: true,
        findings: [finding({ severity: "blocker", title: "b" }), finding({ severity: "nit", title: "c" })],
      }),
    ];
    const result = aggregatePanel(critics);
    expect(result.blockerFindings).toHaveLength(2);
    expect(result.blockerFindings.map((f) => f.title).sort()).toEqual(["a", "b"]);
  });
});

describe("classifyPanel (maps to executor.ts Verification lattice)", () => {
  test("skip when critics is empty — nothing judged, never auto-promote", () => {
    const report: PanelReport = { url: "", critics: [] };
    expect(classifyPanel(report)).toBe("skip");
  });

  test("pass when aggregatePanel passes", () => {
    const report: PanelReport = {
      url: "http://localhost:3000",
      critics: [
        verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
        verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true }),
      ],
    };
    expect(classifyPanel(report)).toBe("pass");
  });

  test("fail when aggregatePanel fails (floorless panel)", () => {
    const report: PanelReport = {
      url: "http://localhost:3000",
      critics: [verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true })],
    };
    expect(classifyPanel(report)).toBe("fail");
  });

  test("fail when a blocker critic did not clear", () => {
    const report: PanelReport = {
      url: "http://localhost:3000",
      critics: [
        verdict({ lens: "intent/acceptance", class: "intent", blocker: true, ok: true }),
        verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: false }),
      ],
    };
    expect(classifyPanel(report)).toBe("fail");
  });

  test("fail when report.sized names a blocker lens that dropped out of critics entirely", () => {
    const report: PanelReport = {
      url: "http://localhost:3000",
      critics: [verdict({ lens: "adversarial/edge", class: "adversarial", blocker: true, ok: true })],
      sized: [
        { class: "intent", lens: "intent/acceptance", blocker: true },
        { class: "adversarial", lens: "adversarial/edge", blocker: true },
      ],
    };
    expect(classifyPanel(report)).toBe("fail");
  });
});
