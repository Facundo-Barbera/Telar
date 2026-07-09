import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { criticPrompt, runCritic, runPanel, type CriticContext } from "../src/critic";
import { panelSize, type LensSpec, type PanelSignals } from "../src/panel";
import type { AgentOpts } from "../src/engine";
import type { CriticVerdict } from "../src/schemas";

// No live agent calls anywhere in this file: every test injects `run`/`opts.run`
// instead of letting runCritic/runPanel fall back to the real engine agent().

const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-critic-test-"));

const ctx: CriticContext = {
  featureName: "checkout flow",
  url: "http://localhost:3000/checkout",
  objective: "let a signed-in user complete a purchase",
  assertions: [
    { id: "a1", description: "submitting with an empty cart shows an error", type: "live-critic", observable: "error text visible", blocker: true },
  ],
};

const LOW_RISK: PanelSignals = {
  diffLines: 10,
  filesTouched: 1,
  filesOutsideAllowed: 0,
  protectedPathsTouched: false,
  priorFailingCritics: 0,
};

// Sized to exercise every panelSize() branch (risky + hardened + out-of-scope)
// so the panel has more lenses than any maxCriticAgents we test with.
const HIGH_RISK: PanelSignals = {
  diffLines: 500,
  filesTouched: 10,
  filesOutsideAllowed: 1,
  protectedPathsTouched: true,
  priorFailingCritics: 1,
};

// Extract the lens label criticPrompt embeds ("--- Your lens: <lens> (<class>...")
// so tests can prove *which* lens actually reached the injected runner without
// any back-channel — reading only the real prompt text runCritic builds.
function lensFromTask(task: string): string {
  const m = task.match(/--- Your lens: (.+?) \(/);
  if (!m) throw new Error("prompt missing lens header");
  return m[1]!;
}

function fakeVerdict(overrides: Partial<CriticVerdict> = {}): CriticVerdict {
  return {
    lens: "stub",
    class: "intent",
    blocker: false,
    ok: true,
    summary: "stub verdict",
    findings: [],
    evidence: [],
    ...overrides,
  };
}

describe("criticPrompt (§M.5 information isolation)", () => {
  test("carries the bundle + lens charge and nothing else reachable", () => {
    const lens: LensSpec = { class: "adversarial", lens: "adversarial/edge", blocker: true };
    const prompt = criticPrompt(lens, ctx);

    expect(prompt).toContain(ctx.featureName);
    expect(prompt).toContain(ctx.url);
    expect(prompt).toContain(ctx.objective);
    expect(prompt).toContain("a1"); // the assertion id
    expect(prompt).toContain("adversarial/edge");
  });

  test("a builder verdict/summary placed in a sibling field never reaches the prompt", () => {
    const LEAK = "BUILDER-SAID-IT-PASSES-DO-NOT-TRUST-CRITIC";
    // Deliberately construct a wider object — as if a careless caller tried to
    // smuggle the builder's Verdict/summary alongside the legitimate context —
    // and pass it where CriticContext is expected.
    const poisoned = {
      ...ctx,
      builderVerdict: { ok: true, summary: LEAK },
      builderSummary: LEAK,
      siblingLensVerdict: { lens: "reproduction", ok: false, summary: LEAK },
    } as CriticContext & Record<string, unknown>;

    const lens: LensSpec = { class: "intent", lens: "intent/acceptance", blocker: true };
    const prompt = criticPrompt(lens, poisoned);

    expect(prompt).not.toContain(LEAK);
    // Control: prove the assertion is meaningful — legitimate ctx fields DO flow through.
    expect(prompt).toContain(ctx.featureName);
  });
});

describe("runCritic", () => {
  test("uses the injected runner (no live call) and forces class/blocker from the lens", async () => {
    let capturedTask = "";
    let capturedOpts: unknown;
    const run = (async (task: string, opts: AgentOpts<any>) => {
      capturedTask = task;
      capturedOpts = opts;
      // Canned verdict deliberately claims the OPPOSITE class/blocker of the
      // lens, to prove runCritic overrides rather than trusting self-report.
      return fakeVerdict({ lens: "whatever", class: "security", blocker: false, ok: true });
    }) as any;

    const lens: LensSpec = { class: "reproduction", lens: "reproduction/cold", blocker: true };
    const verdict = await runCritic(lens, ctx, { evidenceDir, run });

    expect(verdict).not.toBeNull();
    expect(verdict!.class).toBe("reproduction");
    expect(verdict!.blocker).toBe(true);
    expect(capturedTask).toContain("reproduction/cold");
    expect(capturedOpts).toBeTruthy();
  });

  test("isolation holds through runCritic too: no leaked builder field reaches the runner", async () => {
    const LEAK = "SIBLING-VERDICT-LEAK-MARKER";
    const poisoned = { ...ctx, builderVerdict: { ok: false, summary: LEAK } } as CriticContext & Record<string, unknown>;

    let capturedTask = "";
    const run = (async (task: string) => {
      capturedTask = task;
      return fakeVerdict();
    }) as any;

    const lens: LensSpec = { class: "intent", lens: "intent/acceptance", blocker: true };
    await runCritic(lens, poisoned, { evidenceDir, run });

    expect(capturedTask).not.toContain(LEAK);
  });

  test("returns null when the agent never emits (no result to infer)", async () => {
    const run = (async () => null) as any;
    const lens: LensSpec = { class: "intent", lens: "intent/acceptance", blocker: true };
    const verdict = await runCritic(lens, ctx, { evidenceDir, run });
    expect(verdict).toBeNull();
  });
});

describe("runPanel", () => {
  test("runs exactly the lenses panelSize(signals) returns", async () => {
    const seenLenses: string[] = [];
    const run = (async (task: string) => {
      seenLenses.push(lensFromTask(task));
      return fakeVerdict();
    }) as any;

    const expected = panelSize(HIGH_RISK).map((l) => l.lens);
    const report = await runPanel(ctx, { evidenceDir, run, signals: HIGH_RISK, maxCriticAgents: 3 });

    expect(seenLenses.sort()).toEqual([...expected].sort());
    expect(report.critics).toHaveLength(expected.length);
  });

  test("respects maxCriticAgents concurrency cap under a wide (5-lens) panel", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const run = (async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return fakeVerdict();
    }) as any;

    expect(panelSize(HIGH_RISK).length).toBeGreaterThan(2); // sanity: the cap is actually being tested

    const report = await runPanel(ctx, { evidenceDir, run, signals: HIGH_RISK, maxCriticAgents: 2 });

    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(maxObserved).toBe(2); // proves it actually parallelizes, not serializes
    expect(report.critics).toHaveLength(panelSize(HIGH_RISK).length);
  });

  test("assembled PanelReport carries class/blocker correctly, overriding a mismatched canned verdict", async () => {
    // Every canned verdict lies about class/blocker; the report must reflect
    // what the panel SIZED, not what the agent claimed about itself.
    const run = (async () => fakeVerdict({ class: "performance", blocker: false, ok: true })) as any;

    const report = await runPanel(ctx, { evidenceDir, run, signals: HIGH_RISK, maxCriticAgents: 3 });
    const expected = panelSize(HIGH_RISK);

    // Every critic's (class, blocker) must match ITS OWN lens spec exactly —
    // not the mismatched canned verdict every mock call returned.
    const expectedPairs = expected.map((l) => `${l.class}:${l.blocker}`).sort();
    const actualPairs = report.critics.map((c) => `${c.class}:${c.blocker}`).sort();
    expect(actualPairs).toEqual(expectedPairs);
    // §M.3 floor: at least one blocker lens present and correctly flagged.
    expect(report.critics.some((c) => c.blocker)).toBe(true);

    expect(report.url).toBe(ctx.url);
    expect(report.sizedFrom).toEqual({
      diffLines: HIGH_RISK.diffLines,
      filesTouched: HIGH_RISK.filesTouched,
      filesOutsideAllowed: HIGH_RISK.filesOutsideAllowed,
      protectedPathsTouched: 1,
      priorFailingCritics: HIGH_RISK.priorFailingCritics,
    });
  });

  test("low-risk signals size a small panel and still run exactly those lenses", async () => {
    const seenLenses: string[] = [];
    const run = (async (task: string) => {
      seenLenses.push(lensFromTask(task));
      return fakeVerdict();
    }) as any;

    const expected = panelSize(LOW_RISK).map((l) => l.lens);
    const report = await runPanel(ctx, { evidenceDir, run, signals: LOW_RISK, maxCriticAgents: 3 });

    expect(seenLenses.sort()).toEqual([...expected].sort());
    expect(report.critics).toHaveLength(expected.length);
  });

  test("retryBlockerOnly re-runs only blocker lenses plus a fresh reproduction lens", async () => {
    const seenLenses: string[] = [];
    const run = (async (task: string) => {
      seenLenses.push(lensFromTask(task));
      return fakeVerdict();
    }) as any;

    const report = await runPanel(ctx, {
      evidenceDir,
      run,
      signals: HIGH_RISK,
      maxCriticAgents: 3,
      retryBlockerOnly: true,
    });

    const blockersOfFullPanel = panelSize(HIGH_RISK).filter((l) => l.blocker).map((l) => l.lens);
    expect(seenLenses.sort()).toEqual([...new Set([...blockersOfFullPanel, "reproduction/cold-retry"])].sort());
    // Every critic that ran must be a blocker lens (advisory lenses like
    // live-experience must NOT be re-run on a blocker-only retry).
    expect(report.critics.every((c) => c.blocker)).toBe(true);
  });

  test("emits an onEvent per critic (cost + verdict) so panel cost can flow into spentUsd", async () => {
    const run = (async (_task: string, opts: AgentOpts<any>) => {
      opts.onEvent?.({ type: "result", subtype: "success", costUsd: 0.05, turns: 3 });
      return fakeVerdict();
    }) as any;

    const events: Array<{ type: string; lens: string }> = [];
    const report = await runPanel(ctx, {
      evidenceDir,
      run,
      signals: LOW_RISK,
      maxCriticAgents: 3,
      onEvent: (e) => events.push({ type: e.type, lens: e.lens }),
    });

    const costEvents = events.filter((e) => e.type === "critic-cost");
    const verdictEvents = events.filter((e) => e.type === "critic-verdict");
    expect(costEvents).toHaveLength(report.critics.length);
    expect(verdictEvents).toHaveLength(report.critics.length);
  });
});
