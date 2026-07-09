import { describe, expect, test } from "bun:test";
import {
  Budget,
  CriticClass,
  CriticVerdict,
  PanelReport,
  type CriticFinding,
} from "../src/schemas";

describe("CriticClass (§M.3 blocker-floor classes)", () => {
  test("includes adversarial and reproduction", () => {
    expect(CriticClass.options).toContain("adversarial");
    expect(CriticClass.options).toContain("reproduction");
  });
});

describe("CriticVerdict / PanelReport (pure parse)", () => {
  test("parses a valid CriticVerdict with findings + evidence", () => {
    const finding: CriticFinding = {
      severity: "blocker",
      title: "unhandled empty input",
      detail: "submitting an empty form silently no-ops instead of showing a validation error",
      recommendation: "surface a required-field message",
      assertionId: "a1",
      evidence: [{ kind: "screenshot", path: "evidence/empty-submit.png", label: "after submit" }],
    };

    const verdict = CriticVerdict.parse({
      lens: "adversarial/edge",
      class: "adversarial",
      blocker: true,
      ok: false,
      summary: "found an unhandled empty-input path",
      findings: [finding],
      evidence: [],
    });

    expect(verdict.class).toBe("adversarial");
    expect(verdict.blocker).toBe(true);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]!.severity).toBe("blocker");
  });

  test("parses a valid PanelReport with sizedFrom audit signals", () => {
    const report = PanelReport.parse({
      url: "http://localhost:3000",
      critics: [
        {
          lens: "reproduction",
          class: "reproduction",
          blocker: true,
          ok: true,
          summary: "claimed behavior reproduces cold",
        },
      ],
      sizedFrom: { diffLines: 120, filesTouched: 4, protectedPathsTouched: 0, priorFailingCritics: 1 },
    });

    expect(report.critics).toHaveLength(1);
    expect(report.sizedFrom).toEqual({
      diffLines: 120,
      filesTouched: 4,
      protectedPathsTouched: 0,
      priorFailingCritics: 1,
    });
  });

  test("defaults findings/evidence to [] and url/critics to empty when omitted", () => {
    const verdict = CriticVerdict.parse({
      lens: "intent",
      class: "intent",
      blocker: false,
      ok: true,
      summary: "satisfies the contract and its spirit",
    });
    expect(verdict.findings).toEqual([]);
    expect(verdict.evidence).toEqual([]);

    const report = PanelReport.parse({});
    expect(report.url).toBe("");
    expect(report.critics).toEqual([]);
    expect(report.sizedFrom).toBeUndefined();
  });
});

describe("Budget.maxCriticAgents (§M / D11 reserved critic sub-pool)", () => {
  test("defaults to 3, leaving existing defaults unchanged", () => {
    const budget = Budget.parse({});
    expect(budget.maxCriticAgents).toBe(3);
    expect(budget.maxParallelThreads).toBe(3);
    expect(budget.maxAgents).toBe(12);
  });
});
