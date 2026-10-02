import { expect, test } from "bun:test";
import type { UsageDiagnosisReport, UsageDigest } from "@telar/engine-client";
import { fallbackReport, parseDiagnosisReport, redactReport, redactText } from "./diagnosis-report";

const report: UsageDiagnosisReport = {
  window: "7d",
  summary: "Usage is high because s1 keeps a 900k context.",
  topConsumers: [{ id: "s1", share: 0.6, reason: "1,200 turns" }],
  findings: [
    {
      signal: "long_lived_session",
      severity: "high",
      title: "One session runs for ever",
      why: "Each turn re-reads the history.",
      evidence: [{ metric: "turns", value: 1200 }],
      fix: { setting: "compaction", action: "Start fresh sessions." },
      estSavingsPct: 40,
    },
  ],
};

const digest = {
  windows: { "30d": { totals: { tokens: { input: 1e6, output: 1e6, cacheRead: 98e6, cacheCreate: 0 }, costUsd: 12, turns: 1300, sessions: 4, cacheHit: 0.98 }, byModel: [] } },
  topSessions: [{ id: "s1", turns: 1200, model: "claude-opus-5", tokens: { input: 1e6, output: 1e6, cacheRead: 58e6, cacheCreate: 0 } }],
  signals: [
    { id: "cache_read_dominant", value: 0.98, threshold: 0.9 },
    { id: "long_lived_session", value: 1, threshold: 1, sessions: ["s1"] },
    { id: "made_up", value: 3, threshold: 1 },
  ],
} as unknown as UsageDigest;

test("reads the report out of the agent's answer, fenced or not", () => {
  expect(parseDiagnosisReport(JSON.stringify(report))).toEqual({ report });
  expect(parseDiagnosisReport(`Here it is:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``)).toEqual({ report });
});

test("an answer that is not a valid report says why", () => {
  expect(parseDiagnosisReport("I could not finish.")).toEqual({ error: "the answer held no JSON object" });
  expect(parseDiagnosisReport("{ nope")).toEqual({ error: "the answer held no JSON object" });
  const tooLong = parseDiagnosisReport(JSON.stringify({ ...report, summary: "x".repeat(401) }));
  expect("error" in tooLong && tooLong.error).toMatch(/^summary:/);
  const badSetting = parseDiagnosisReport(JSON.stringify({ ...report, findings: [{ ...report.findings[0], fix: { setting: "rm -rf", action: "x" } }] }));
  expect("error" in badSetting).toBe(true);
});

test("the fallback is built from known signals and the top sessions only", () => {
  const fallback = fallbackReport(digest);

  expect(fallback.findings.map((finding) => finding.signal)).toEqual(["cache_read_dominant", "long_lived_session"]);
  expect(fallback.topConsumers).toEqual([{ id: "s1", share: 0.6, reason: "1200 turns on claude-opus-5" }]);
  expect(fallback.summary).toBe("100M tokens over 30 days across 4 sessions; 98% were cache reads.");
});

test("redaction removes paths, ids, addresses, keys and every name the engine knows", () => {
  const text = [
    "See /Users/facundo/Projects/Acme/src/app.ts and ~/work/thing,",
    "session_b1d34698e99143f4a30f26852b5b5cdf, run_6e3bd577896b43de9614e6d2f87a2b13,",
    "mail me at someone@example.com from 192.168.1.20 or studio.local,",
    "key sk-ant-REALLYSECRET123456 and https://internal.example.com/x.",
    "Project Acme Rocket and branch telar/fix-login on Facundos-MacBook.",
  ].join(" ");

  const clean = redactText(text, ["Acme Rocket", "telar/fix-login", "fix-login", "Facundos-MacBook"]);

  for (const leaked of ["/Users", "~/work", "session_b1d3", "run_6e3b", "someone@", "192.168", "studio.local", "sk-ant", "https://", "Acme Rocket", "fix-login", "Facundos-MacBook"]) {
    expect(clean).not.toContain(leaked);
  }
  expect(clean).toContain("Project [redacted]");
});

test("deny-listed words are matched whole, so ordinary words survive", () => {
  expect(redactText("Usage is high in the web app", ["web"])).toBe("Usage is high in the [redacted] app");
  expect(redactText("A website and webhooks", ["web"])).toBe("A website and webhooks");
});

test("a report keeps its numbers and settings, loses private text and drops unknown sessions", () => {
  const leaky: UsageDiagnosisReport = {
    ...report,
    summary: "Acme Rocket at /Volumes/Taller/worktrees/x spends most.",
    topConsumers: [...report.topConsumers, { id: "s9", share: 0.1, reason: "not in the digest" }],
  };

  const clean = redactReport(leaky, ["Acme Rocket"], digest);

  expect(clean.summary).toBe("[redacted] at [redacted] spends most.");
  expect(clean.topConsumers.map((entry) => entry.id)).toEqual(["s1"]);
  expect(clean.findings[0]).toMatchObject({ evidence: [{ metric: "turns", value: 1200 }], fix: { setting: "compaction" }, estSavingsPct: 40 });
});
