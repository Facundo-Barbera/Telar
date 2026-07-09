import { expect, test } from "bun:test";
import { classify } from "../src/executor";
import { DesignFinding, ProjectManifest, VerifierReport, type CriterionResult } from "../src/schemas";

const crit = (verdict: CriterionResult["verdict"]): CriterionResult => ({
  criterion: "c",
  verdict,
  observed: "",
  evidence: [],
  repro: [],
  locators: [],
});

test("DesignFinding round-trips a full finding", () => {
  const finding = {
    severity: "major" as const,
    category: "spacing-alignment" as const,
    title: "Inconsistent card padding",
    detail: "Cards use 12px on mobile but 16px on desktop, breaking the 8px grid.",
    recommendation: "Use 16px padding at all breakpoints.",
    evidence: [{ kind: "screenshot" as const, path: "cards.png", label: "card grid" }],
  };
  expect(DesignFinding.parse(finding)).toEqual(finding);
});

test("VerifierReport parses with designFindings present", () => {
  const report = VerifierReport.parse({
    feature: "f",
    url: "u",
    ok: true,
    summary: "",
    criteria: [crit("pass")],
    designFindings: [
      {
        severity: "nit",
        category: "copy",
        title: "Button label casing",
        detail: "Inconsistent title-case vs sentence-case across buttons.",
      },
    ],
  });
  expect(report.designFindings).toHaveLength(1);
  expect(report.designFindings[0]?.severity).toBe("nit");
});

test("VerifierReport without designFindings still parses (back-compat) -> []", () => {
  const report = VerifierReport.parse({
    feature: "f",
    url: "u",
    ok: true,
    summary: "",
    criteria: [crit("pass")],
  });
  expect(report.designFindings).toEqual([]);
});

test("ProjectManifest leaves designRules undefined by default", () => {
  const m = ProjectManifest.parse({ name: "n", root: "/tmp/x" });
  expect(m.designRules).toBeUndefined();
});

test("ProjectManifest round-trips designRules when set", () => {
  const m = ProjectManifest.parse({ name: "n", root: "/tmp/x", designRules: "docs/design.md" });
  expect(m.designRules).toBe("docs/design.md");
});

test("classify: non-empty designFindings with all criteria pass -> still pass", () => {
  const report = VerifierReport.parse({
    feature: "f",
    url: "u",
    ok: true,
    summary: "",
    criteria: [crit("pass"), crit("pass")],
    designFindings: [
      { severity: "blocker", category: "contrast-a11y", title: "Low contrast", detail: "Text fails WCAG AA." },
    ],
  });
  expect(classify(report)).toBe("pass");
});

test("classify: designFindings never override a failing criterion", () => {
  const report = VerifierReport.parse({
    feature: "f",
    url: "u",
    ok: true,
    summary: "",
    criteria: [crit("pass"), crit("fail")],
    designFindings: [], // clean design, but functional fail still wins
  });
  expect(classify(report)).toBe("fail");
});
