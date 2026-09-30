import { describe, expect, test } from "bun:test";
import { blindReview, evalPrompt, parseEvalArgs, type EvalResult } from "./evaluate-titles";
import { titleEvalCases } from "./title-eval-cases";

describe("parseEvalArgs", () => {
  test("reads a provider, model, effort and output directory", () => {
    expect(parseEvalArgs(["--provider", "codex", "--model", "gpt-6-luna", "--effort", "medium", "--out", "/tmp/eval"])).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      effort: "medium",
      out: "/tmp/eval",
      initial: false,
      second: false,
    });
  });

  test("--second needs the first titles as a baseline", () => {
    expect(() => parseEvalArgs(["--provider", "claude", "--out", "/tmp/eval", "--second"])).toThrow("--baseline");
    expect(parseEvalArgs(["--provider", "claude", "--out", "/tmp/eval", "--second", "--baseline", "first.json"])).toMatchObject({ second: true, baseline: "first.json" });
  });

  test("refuses an unknown provider, a missing directory and an unknown effort", () => {
    expect(() => parseEvalArgs(["--provider", "cursor", "--out", "/tmp/eval"])).toThrow();
    expect(() => parseEvalArgs(["--provider", "claude"])).toThrow();
    expect(() => parseEvalArgs(["--provider", "claude", "--out", "/tmp/eval", "--effort", "max"])).toThrow();
  });
});

describe("evalPrompt", () => {
  const fixture = titleEvalCases.find((entry) => entry.id === "orchestrated")!;

  test("regenerating carries the previous title and the conversation, without reasoning or system items", () => {
    const prompt = evalPrompt(fixture, false);
    expect(prompt).toContain('The previous title was "New session".');
    expect(prompt).toContain("USER:\nMake the iOS Live Activity");
    expect(prompt).not.toContain("Orientation");
    expect(prompt).not.toContain("Planning the Live Activity timer");
  });

  test("a second pass retitles from the first title", () => {
    expect(evalPrompt(fixture, false, "Live Activity timer")).toContain('The previous title was "Live Activity timer".');
  });

  test("--initial titles only the opening request", () => {
    const prompt = evalPrompt(fixture, true);
    expect(prompt).toContain("User message:\nMake the iOS Live Activity");
    expect(prompt).not.toContain("previous title");
  });

  test("every case fits the prompt budget", () => {
    for (const entry of titleEvalCases) expect(evalPrompt(entry, false).length).toBeLessThan(12_000);
  });
});

describe("blindReview", () => {
  const cases = titleEvalCases.slice(0, 2);
  const results: EvalResult[] = cases.map((entry) => ({ id: entry.id, title: `new ${entry.id}`, latencyMs: 1 }));

  test("hides which title is new and keeps the answer in a separate key", () => {
    const flips = [true, false];
    const { review, answerKey } = blindReview(cases, results, [], () => flips.shift()!);
    expect(review[0]).toMatchObject({ A: "new rail-flicker", B: "New session" });
    expect(review[1]).toMatchObject({ A: "Finish run config PR", B: "new merge-after-green" });
    expect(answerKey).toEqual([
      { id: "rail-flicker", candidate: "A" },
      { id: "merge-after-green", candidate: "B" },
    ]);
  });

  test("compares against a baseline run when given one, and refuses a baseline that misses a case", () => {
    const baseline: EvalResult[] = [{ id: "rail-flicker", title: "old", latencyMs: 1 }];
    expect(() => blindReview(cases, results, baseline, () => true)).toThrow("missing merge-after-green");
    const { review } = blindReview(cases.slice(0, 1), results, baseline, () => false);
    expect(review[0]).toMatchObject({ A: "old", B: "new rail-flicker" });
  });
});
