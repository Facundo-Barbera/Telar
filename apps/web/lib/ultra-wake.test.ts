// Story 4.1 — the wake's pure delivery seam (AC1, AC2). No DOM, no disk, no
// core import: everything here is a function of its arguments, which is exactly
// why the seam exists as its own module.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig can't resolve it — suppress just the import.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  ULTRA_WAKE_PROMPT,
  ULTRA_WAKE_SENTINEL,
  formatUltraWakeAppendix,
  isUltraWakeTrigger,
  resolveUltraWakeMessage,
  type UltraWakeSummary,
} from "./ultra-wake";

const wake = (over: Partial<UltraWakeSummary> = {}): UltraWakeSummary => ({
  runId: "run_1",
  name: "nightly sweep",
  state: "done",
  spendUsd: 1.5,
  ...over,
});

describe("ultra wake — the recognizer (AC1)", () => {
  test("the sentinel on an existing session IS a wake trigger", () => {
    expect(isUltraWakeTrigger("sess-1", ULTRA_WAKE_SENTINEL)).toBe(true);
  });

  test("T11 — the sentinel with an EMPTY sessionId is NOT a trigger", () => {
    // THE TRAP THIS TEST EXISTS FOR. escalation-kickoff.ts's
    // `isEscalationKickoff` gates on `!sessionId` ("a kickoff is always turn 1").
    // A wake is structurally the reverse — it belongs to a run whose manifest
    // already names a session — so a faithful line-for-line copy of the template
    // would produce a recognizer that is FALSE on every legitimate wake and TRUE
    // only here. This asserts the inversion rather than trusting it.
    expect(isUltraWakeTrigger("", ULTRA_WAKE_SENTINEL)).toBe(false);
    expect(isUltraWakeTrigger(null, ULTRA_WAKE_SENTINEL)).toBe(false);
    expect(isUltraWakeTrigger(undefined, ULTRA_WAKE_SENTINEL)).toBe(false);
  });

  test("an ordinary user turn is never a trigger, whatever it says", () => {
    expect(isUltraWakeTrigger("sess-1", "how did the ultra run go?")).toBe(false);
    expect(isUltraWakeTrigger("sess-1", "")).toBe(false);
    expect(isUltraWakeTrigger("sess-1", `  ${ULTRA_WAKE_SENTINEL}  `)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", `${ULTRA_WAKE_SENTINEL} and also`)).toBe(false);
    // Non-string wire values collapse to false rather than throwing.
    expect(isUltraWakeTrigger("sess-1", undefined)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", 42)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", { message: ULTRA_WAKE_SENTINEL })).toBe(false);
  });

  test("the swap is byte-identical for every non-trigger turn", () => {
    expect(resolveUltraWakeMessage("sess-1", ULTRA_WAKE_SENTINEL)).toBe(ULTRA_WAKE_PROMPT);
    expect(resolveUltraWakeMessage("sess-1", "hello")).toBe("hello");
    expect(resolveUltraWakeMessage("", ULTRA_WAKE_SENTINEL)).toBe(ULTRA_WAKE_SENTINEL);
    expect(resolveUltraWakeMessage(null, "hello")).toBe("hello");
  });

  test("the sentinel is opaque enough that a human cannot type it by accident", () => {
    expect(ULTRA_WAKE_SENTINEL).toMatch(/^__telar_/);
    expect(ULTRA_WAKE_SENTINEL).not.toContain(" ");
    // …and it is not the escalation one. Two sentinels, two branches; a shared
    // value would make each recognizer fire on the other's turn.
    expect(ULTRA_WAKE_SENTINEL).not.toBe("__telar_escalation_kickoff__");
  });

  test("the server-authored prompt tells the model NOT to poll — AC2's 'without calling ultra_status'", () => {
    expect(ULTRA_WAKE_PROMPT).toContain("ultra_status");
    expect(ULTRA_WAKE_PROMPT.toLowerCase()).toContain("do not call");
  });
});

describe("ultra wake — the appendix formatter (AC1 proof 5, AC2)", () => {
  test("the empty case is EXACTLY '' — never a stray header", () => {
    // This composes on every chat POST for every session, so the common case is
    // no wakes. A lone heading with nothing under it is an instruction to talk
    // about nothing.
    expect(formatUltraWakeAppendix([])).toBe("");
  });

  test("a `done` wake renders its RESULT", () => {
    const out = formatUltraWakeAppendix([wake({ result: { files: 12, ok: true } })]);
    expect(out).toContain("COMPLETED ULTRA RUNS");
    expect(out).toContain("nightly sweep");
    expect(out).toContain("run_1");
    expect(out).toContain("done");
    expect(out).toContain('"files": 12');
    expect(out).not.toContain("error:");
  });

  test("a `failed` wake renders its ERROR", () => {
    const out = formatUltraWakeAppendix([
      wake({ state: "failed", error: "step 3 threw: ENOENT" }),
    ]);
    expect(out).toContain("failed");
    expect(out).toContain("step 3 threw: ENOENT");
    expect(out).not.toContain("result:");
  });

  test("a `stopped` wake renders NEITHER, and says so", () => {
    // A stop has no resolved value and no failure. Inventing one is a cue to
    // summarize something that does not exist.
    const out = formatUltraWakeAppendix([
      wake({ state: "stopped", result: { should: "not appear" }, error: "should not appear" }),
    ]);
    expect(out).toContain("stopped");
    expect(out).toContain("no result and no error");
    expect(out).not.toContain("should not appear");
  });

  test("a `done` wake that returned nothing says so rather than printing undefined", () => {
    const out = formatUltraWakeAppendix([wake({ result: undefined })]);
    expect(out).toContain("returned nothing");
    expect(out).not.toContain("undefined");
  });

  test("a `failed` wake with no error text still says it failed", () => {
    const out = formatUltraWakeAppendix([wake({ state: "failed", error: "   " })]);
    expect(out).toContain("failed");
    expect(out).toContain("recorded no error text");
  });

  test("a string result is rendered verbatim, not JSON-quoted", () => {
    const out = formatUltraWakeAppendix([wake({ result: "all 12 checks passed" })]);
    expect(out).toContain("all 12 checks passed");
    expect(out).not.toContain('"all 12 checks passed"');
  });

  test("T10 — three finished runs ride ONE appendix", () => {
    // The client fires one trigger per pass; the formatter is what makes that
    // sufficient. A design where each wake needed its own turn would fire three.
    const out = formatUltraWakeAppendix([
      wake({ runId: "run_a", name: "alpha", state: "done", result: "A" }),
      wake({ runId: "run_b", name: "beta", state: "failed", error: "B broke" }),
      wake({ runId: "run_c", name: "gamma", state: "stopped" }),
    ]);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(out).toContain("B broke");
    // One header, three runs.
    expect(out.match(/COMPLETED ULTRA RUNS/g)).toHaveLength(1);
    expect(out.match(/^• /gm)).toHaveLength(3);
  });

  test("the block is BOUNDED — a huge result cannot swell every turn's system prompt", () => {
    const huge = "x".repeat(500_000);
    const out = formatUltraWakeAppendix([wake({ result: huge })]);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(3_000);
    // …and the bound is per run, so three huge runs stay bounded too.
    const three = formatUltraWakeAppendix([
      wake({ runId: "a", result: huge }),
      wake({ runId: "b", result: huge }),
      wake({ runId: "c", result: huge }),
    ]);
    expect(three.length).toBeLessThan(7_000);
  });

  test("an unserializable result degrades to a note rather than throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatUltraWakeAppendix([wake({ result: circular })])).not.toThrow();
    expect(formatUltraWakeAppendix([wake({ result: circular })])).toContain(
      "could not be serialized",
    );
    // A BigInt is the other JSON.stringify throw, and it is reachable from a
    // script that counted something large. Built with BigInt() rather than a
    // `1n` literal: this workspace's tsconfig targets below ES2020, so the
    // literal form is a compile error under `bunx tsc --noEmit` here.
    expect(() => formatUltraWakeAppendix([wake({ result: { n: BigInt(1) } })])).not.toThrow();
  });

  test("the spend rides along, in the run's own USD figure", () => {
    // AC5's manifest figure, restated to the model so it can answer "what did it
    // cost" without a tool call. Ultra is Claude-only today (route.ts builds the
    // ultra MCP server on the non-Codex branch), so USD is the only language a
    // run's own spend has ever had.
    expect(formatUltraWakeAppendix([wake({ spendUsd: 2.5 })])).toContain("$2.5000");
  });
});
