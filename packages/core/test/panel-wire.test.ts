// P2 wiring (docs/loom-model.md §4): the Critic Panel replaces the single
// Verifier as the SOURCE of `verification` for a bundle loom, feeding the
// SAME decide() promotion rule unchanged. PURE composition tests only — every
// panel run here injects a fake `run` into runVerification's opts (which
// threads to runPanel -> runCritic -> agent), so NOTHING here ever makes a
// live agent()/verify() call or drives a real browser.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManifest, type VerificationContract } from "../src/schemas";
import type { AttemptRecord, Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-panel-wire-"));
process.env.TELAR_HOME = home;
// bun test runs every file in one process — re-pin before each test (same
// pattern as bundle.test.ts / looms.test.ts).
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createLoom } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { decide, runVerification, terminalStateForCompletedLoom } = await import("../src/executor");
const { classifyPanel } = await import("../src/panel");

const manifest = ProjectManifest.parse({
  name: "p",
  root: "/tmp/telar-panel-wire-repo",
  urls: { dev: "http://localhost:3000" },
});

const CONTRACT: VerificationContract = {
  version: 1,
  assertions: [
    { id: "a1", description: "total matches cart", type: "value-equality", expected: "42.00", blocker: true },
    {
      id: "a2",
      description: "checkout completes for a real signed-in user",
      type: "live-critic",
      observable: "order confirmation visible",
      blocker: true,
    },
  ],
};

function makeBundleLoom(): Loom {
  const loom = createLoom({
    project: "p",
    kind: "custom",
    title: "Checkout flow",
    prompt: "build checkout",
    account: "personal",
  });
  writeBundleFile(loom.id, "objective.md", "Let a signed-in user complete checkout.");
  writeContract(loom.id, CONTRACT);
  return loom;
}

function pushAttempt(loom: Loom, n: number, verdictOk: boolean): AttemptRecord {
  const attempt: AttemptRecord = {
    n,
    role: n === 1 ? "dev" : "careful",
    model: "sonnet",
    startedAt: Date.now(),
    verdict: { ok: verdictOk, summary: "done", files_touched: ["src/checkout.ts"], blocker: null },
  };
  loom.attempts.push(attempt);
  return attempt;
}

// Extract the lens label from the real prompt runCritic builds (same trick
// critic.test.ts uses) and hand back a canned outcome per lens; `null` means
// "the agent never emitted" (runCritic returns null for that lens).
function fakeRun(pick: (lens: string) => { ok: boolean; findings?: unknown[] } | null) {
  return (async (task: string) => {
    const m = task.match(/--- Your lens: (.+?) \(/);
    const lens = m ? m[1]! : "unknown";
    const outcome = pick(lens);
    if (!outcome) return null;
    return {
      lens,
      ok: outcome.ok,
      summary: outcome.ok ? "clean" : "found a blocker",
      findings: outcome.findings ?? [],
      evidence: [],
    };
  }) as any;
}

describe("panel wiring: bundle loom -> the Critic Panel is the source of `verification`", () => {
  test("panel aggregates clean -> verification 'pass' -> decide -> promotion -> ready (root loom)", async () => {
    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    const events: { type: string }[] = [];
    const run = fakeRun(() => ({ ok: true }));

    const result = await runVerification(loom, manifest, attempt, (e) => events.push(e), undefined, undefined, {
      run,
    });

    expect(result.verification).toBe("pass");
    expect(result.panelReport?.critics.length).toBeGreaterThanOrEqual(2); // §M.3 floor: >=1 blocker present
    expect(classifyPanel(result.panelReport!)).toBe("pass");
    expect(attempt.panelReport).toEqual(result.panelReport); // attached to the attempt
    expect(events.some((e) => e.type === "panel")).toBe(true); // emitted for the UI/spend ledger

    const decision = decide({
      gatesConfigured: false,
      gatesOk: true,
      verdict: attempt.verdict!,
      verification: result.verification,
      n: 1,
      maxAttempts: 3,
      flakyUsed: 0,
      maxFlaky: 2,
    });
    expect(decision).toEqual({ action: "done" });
    // §A: a completed ROOT loom lands "ready", never straight to "done".
    expect(terminalStateForCompletedLoom(loom)).toBe("ready");
  });

  test("a failing blocker critic -> verification 'fail' -> decide -> retry, then needs-review once exhausted", async () => {
    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    const run = fakeRun((lens) => ({
      ok: lens !== "adversarial/edge",
      findings:
        lens === "adversarial/edge"
          ? [{ severity: "blocker", title: "breaks on empty cart", detail: "throws on submit", evidence: [] }]
          : [],
    }));

    const result = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, { run });
    expect(result.verification).toBe("fail");

    expect(
      decide({
        gatesConfigured: false,
        gatesOk: true,
        verdict: attempt.verdict!,
        verification: result.verification,
        n: 1,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "retry" });

    expect(
      decide({
        gatesConfigured: false,
        gatesOk: true,
        verdict: attempt.verdict!,
        verification: result.verification,
        n: 3,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "needs-review", error: "verification failed" });
  });

  test("one blocker lens (intent) crashes while the other (adversarial) clears -> 'fail', not 'pass' (§M.4 no silent drop)", async () => {
    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    // intent's agent call never emits (null); adversarial clears clean.
    const run = fakeRun((lens) => (lens === "intent/acceptance" ? null : { ok: true }));

    const result = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, { run });
    expect(result.panelReport?.critics.length).toBe(1); // only adversarial made it in
    expect(result.panelReport?.critics.every((c) => c.ok)).toBe(true); // every PRESENT critic is clean
    // Without the sized-lens cross-check this would wrongly classify "pass"
    // (floor present via adversarial, no present failing blocker critic).
    expect(result.verification).toBe("fail");
    expect(classifyPanel(result.panelReport!).valueOf()).toBe("fail");
  });

  test("every critic agent errors out -> empty panel -> 'skip' -> never promotes (panel IS the gate)", async () => {
    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    const run = fakeRun(() => null); // agent never emits, for every sized lens

    const result = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, { run });
    expect(result.panelReport?.critics).toEqual([]);
    expect(result.verification).toBe("skip");
    expect(result.panelRequired).toBe(true); // a contract-anchored loom always requires the panel
    expect(classifyPanel(result.panelReport!)).toBe("skip"); // aggregatePanel's floor check never even runs

    // No deterministic gates configured -> the panel/Verifier IS the gate
    // (§4 Layer 3, no-gates branch) -- an empty panel must never promote,
    // mirroring the pre-existing no-gates "skip -> needs-review" rule.
    expect(
      decide({
        gatesConfigured: false,
        gatesOk: true,
        verdict: attempt.verdict!,
        verification: result.verification,
        panelRequired: result.panelRequired,
        n: 1,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "needs-review" });

    // §4 Layer 3: with hard gates ALSO configured, panelRequired must still
    // prevent the "skip" from carrying straight to "done" (this is the fix —
    // see the panelRequired=true test below for the previously-buggy case).
    expect(
      decide({
        gatesConfigured: true,
        gatesOk: true,
        verdict: attempt.verdict!,
        verification: result.verification,
        panelRequired: result.panelRequired,
        n: 1,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "retry" });
  });

  // A bundle loom's project ALSO having hard gates configured must NOT let a
  // "skip" verification (missing target / thrown exception / all-null critic
  // set — see runPanelVerification) carry straight to "done": the panel IS
  // the gate for a contract-anchored loom, so decide() is told panelRequired
  // via runVerification's returned `panelRequired` flag and refuses to
  // collapse "skip" into a promotion, retrying (or needs-review once
  // exhausted) instead. A legacy/no-contract loom (panelRequired: false,
  // decide.test.ts) keeps the old "gates carry it" behavior verbatim.
  test("panelRequired=true: gates green + agent ok but panel 'skip' -> retry, then needs-review once exhausted", () => {
    const okVerdict = { ok: true, summary: "done", files_touched: [], blocker: null };
    expect(
      decide({
        gatesConfigured: true,
        gatesOk: true,
        verdict: okVerdict,
        verification: "skip",
        panelRequired: true,
        n: 1,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "retry" });

    expect(
      decide({
        gatesConfigured: true,
        gatesOk: true,
        verdict: okVerdict,
        verification: "skip",
        panelRequired: true,
        n: 3,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "needs-review", error: "panel verification required but did not run" });
  });

  test("classifyPanel hard-fails an empty panel directly (pure composition, no wiring involved)", () => {
    expect(classifyPanel({ url: "", critics: [], sizedFrom: {} })).toBe("skip");
  });
});

describe("no-bundle loom: the legacy single-Verifier path is byte-identical", () => {
  test("no contract.json in the bundle -> legacy skip guard (missing acceptanceCriteria/target), unchanged", async () => {
    const loom = createLoom({ project: "p", kind: "quickfix", title: "fix typo", prompt: "fix it", account: "personal" });
    const attempt: AttemptRecord = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    const events: unknown[] = [];
    const result = await runVerification(loom, manifest, attempt, (e) => events.push(e));

    expect(result).toEqual({ verification: "skip", report: null, panelRequired: false });
    expect(attempt.panelReport).toBeUndefined();
    expect(events).toEqual([]); // the legacy guard returns before ever emitting — same as pre-wiring
  });

  test("acceptanceCriteria present but no target url -> still 'skip', legacy guard unchanged", async () => {
    const loom = createLoom({ project: "p", kind: "quickfix", title: "t", prompt: "x", account: "personal" });
    loom.acceptanceCriteria = ["shows a success toast"];
    const noUrlManifest = ProjectManifest.parse({ name: "p", root: "/tmp/telar-panel-wire-repo" }); // no urls.dev
    const attempt: AttemptRecord = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    const result = await runVerification(loom, noUrlManifest, attempt, () => {});
    expect(result).toEqual({ verification: "skip", report: null, panelRequired: false });
  });
});

// §M.1/§M.2 regression guard: a loom that required a Verification Contract at
// start (loom.contractRequired, stamped by startLoomFromBundle's CONTRACT
// GATE) must NEVER fall through to the legacy no-panel skip path just because
// contract.json later went missing/corrupt/invalid — that would let hard
// gates + a self-reported Verdict silently promote a bundle loom with zero
// panel evidence for the attempt (the exact "panel has nothing to check"
// scenario, reachable mid-run instead of at start).
describe("contractRequired: a lost/invalid contract on an already-started bundle loom is a hard failure, never a silent 'skip'", () => {
  test("contract.json missing but loom.contractRequired=true -> verification 'fail', not the legacy 'skip'", async () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.contractRequired = true; // what startLoomFromBundle stamps once the CONTRACT GATE passes
    const attempt: AttemptRecord = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    const events: { type: string }[] = [];
    const result = await runVerification(loom, manifest, attempt, (e) => events.push(e));

    expect(result).toEqual({ verification: "fail", report: null, panelReport: null, panelRequired: true });
    expect(events.some((e) => e.type === "panel-error")).toBe(true);
  });

  test("even with hard gates green + agent ok, decide() never promotes a contractRequired loom whose contract vanished", () => {
    const okVerdict = { ok: true, summary: "done", files_touched: [], blocker: null };
    // n < maxAttempts -> retry, not a silent "done".
    expect(
      decide({
        gatesConfigured: true,
        gatesOk: true,
        verdict: okVerdict,
        verification: "fail",
        panelRequired: true,
        n: 1,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "retry" });

    // exhausted -> needs-review, still never "done".
    expect(
      decide({
        gatesConfigured: true,
        gatesOk: true,
        verdict: okVerdict,
        verification: "fail",
        panelRequired: true,
        n: 3,
        maxAttempts: 3,
        flakyUsed: 0,
        maxFlaky: 2,
      }),
    ).toEqual({ action: "needs-review", error: "verification failed" });
  });
});

// §M.4: filesTouched/protectedPathsTouched must come from an INDEPENDENT
// git-status read of manifest.root, not solely the builder's self-reported
// Verdict.files_touched — otherwise a builder can shrink its own panel or
// hide a protected-path edit just by omitting it from its own report.
describe("panel wiring: independent git-derived §M.4 signals (closes builder self-report gaming)", () => {
  let gitRoot: string;

  beforeAll(() => {
    gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-panel-git-"));
    execFileSync("git", ["init"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.name", "Telar Test"], { cwd: gitRoot });
    fs.writeFileSync(path.join(gitRoot, "README.md"), "hi\n");
    execFileSync("git", ["add", "README.md"], { cwd: gitRoot });
    execFileSync("git", ["commit", "-m", "init"], { cwd: gitRoot });
  });

  afterAll(() => {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  });

  test("a protected-path edit omitted from the builder's self-report is still caught via `git status`", async () => {
    fs.mkdirSync(path.join(gitRoot, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(gitRoot, "secrets", "keys.json"), "{}\n");

    const gitManifest = ProjectManifest.parse({
      name: "p",
      root: gitRoot,
      urls: { dev: "http://localhost:3000" },
      guardrails: { protectedPaths: ["secrets/"] },
    });

    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    attempt.verdict!.files_touched = ["src/checkout.ts"]; // self-report omits secrets/keys.json
    const run = fakeRun(() => ({ ok: true }));

    const result = await runVerification(loom, gitManifest, attempt, () => {}, undefined, undefined, { run });

    // sizedFrom is the audit trail of the raw signals the panel actually saw.
    expect(result.panelReport?.sizedFrom?.protectedPathsTouched).toBe(1);
    expect(result.panelReport?.critics.some((c) => c.class === "security")).toBe(true);
  });

  test("many git-changed files not in the self-report still scale the panel up (reproduction lens added)", async () => {
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(gitRoot, `f${i}.txt`), `content ${i}\n`);
    }

    const gitManifest = ProjectManifest.parse({
      name: "p",
      root: gitRoot,
      urls: { dev: "http://localhost:3000" },
    });

    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    attempt.verdict!.files_touched = []; // self-report claims nothing was touched
    const run = fakeRun(() => ({ ok: true }));

    const result = await runVerification(loom, gitManifest, attempt, () => {}, undefined, undefined, { run });

    expect(result.panelReport?.sizedFrom?.filesTouched).toBeGreaterThanOrEqual(8);
    expect(result.panelReport?.critics.some((c) => c.lens === "reproduction/cold")).toBe(true);
  });

  test("a non-git root (or git failure) falls back to the self-reported files_touched, best-effort", async () => {
    const noGitManifest = ProjectManifest.parse({
      name: "p",
      root: "/tmp/telar-panel-wire-not-a-git-repo",
      urls: { dev: "http://localhost:3000" },
    });

    const loom = makeBundleLoom();
    const attempt = pushAttempt(loom, 1, true);
    attempt.verdict!.files_touched = ["src/checkout.ts"];
    const run = fakeRun(() => ({ ok: true }));

    const result = await runVerification(loom, noGitManifest, attempt, () => {}, undefined, undefined, { run });

    expect(result.panelReport?.sizedFrom?.filesTouched).toBe(1); // just the self-reported file
    expect(result.verification).toBe("pass");
  });
});
