import { expect, test } from "bun:test";
import { classify } from "../src/executor";
import { VerifierReport, type CriterionResult } from "../src/schemas";

const crit = (verdict: CriterionResult["verdict"]): CriterionResult => ({
  criterion: "c",
  verdict,
  observed: "",
  evidence: [],
  repro: [],
  locators: [],
});

// `ok` is deliberately allowed to disagree with the criteria — that's the point.
const report = (ok: boolean, verdicts: CriterionResult["verdict"][]) =>
  VerifierReport.parse({ feature: "f", url: "u", ok, summary: "", criteria: verdicts.map(crit) });

test("all criteria pass -> pass", () => {
  expect(classify(report(true, ["pass", "pass"]))).toBe("pass");
});

test("a fail criterion -> fail EVEN IF report.ok is true (don't trust the say-so)", () => {
  expect(classify(report(true, ["pass", "fail"]))).toBe("fail");
});

test("flaky (no fail) -> flaky even when report.ok is false", () => {
  expect(classify(report(false, ["pass", "flaky"]))).toBe("flaky");
});

test("fail takes precedence over flaky", () => {
  expect(classify(report(false, ["flaky", "fail"]))).toBe("fail");
});

test("empty criteria -> skip (nothing verified; never auto-promote)", () => {
  expect(classify(report(true, []))).toBe("skip");
});
