// M11.4 (finding 4) — the unfixable-gate circuit breaker, both legs:
//   (A) the PURE repair-guard signature guard (auto-repair altitude), and
//   (B) the executor attempt-loop safety-net breaker.
// A gate that fails byte-identically across attempts while the tree keeps
// changing is not builder-fixable (the red is contract/environment state) — the
// loop must ESCALATE/PARK instead of burning every attempt.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideRepairContinuation, normalizeGateOutput, type RepairCaps, type RepairRound } from "../src/repair-guard";
import type { BudgetState } from "../src/budget";

const budget = (over: Partial<BudgetState> = {}): BudgetState => ({
  maxAgents: 12,
  inFlight: 0,
  spentUsd: 0,
  startedAtMs: 0,
  ...over,
});
const CAPS: RepairCaps = { maxRepairIterations: 3, estCostPerRepair: 0.5 };
const NOW = 1000;

function round(n: number, failing: string[], sig?: Record<string, string>, passing: string[] = []): RepairRound {
  return {
    n,
    failingIds: failing,
    passingIds: passing,
    verification: failing.length ? "fail" : "pass",
    costUsd: 0,
    startedAt: 0,
    endedAt: 0,
    ...(sig ? { failingSig: sig } : {}),
  };
}

describe("repair-guard signature guard (finding 4A)", () => {
  test("an assertion RED with a byte-identical signature across 3 rounds -> escalate 'unfixable gate' EVEN as the set shrinks", () => {
    // Guard 3 (strict-shrink) would say "repair" here — the set shrinks every
    // round — but `a` never budges (identical output), so it is unfixable.
    const history = [
      round(1, ["a", "b", "c"], { a: "boom-A", b: "boom-B", c: "boom-C" }),
      round(2, ["a", "b"], { a: "boom-A", b: "boom-B" }),
      round(3, ["a"], { a: "boom-A" }),
    ];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "unfixable gate: a",
    });
  });

  test("a CHANGING signature is genuine progress -> repair (not unfixable)", () => {
    const history = [
      round(1, ["a", "b", "c"], { a: "r1", b: "x", c: "y" }),
      round(2, ["a", "b"], { a: "r2", b: "x" }),
      round(3, ["a"], { a: "r3" }),
    ];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({ action: "repair" });
  });

  test("an EMPTY signature carries no signal -> not unfixable (conservative, declines to judge)", () => {
    const history = [
      round(1, ["a"], { a: "" }),
      round(2, ["a"], { a: "" }),
      round(3, ["a"], { a: "" }),
    ];
    // Falls through to Guard 3 on the plateau — never a false 'unfixable'.
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "no progress",
    });
  });

  test("rounds WITHOUT failingSig never trigger the signature guard", () => {
    // Shrinking set, no signatures attached (legacy / panel-only rounds) ->
    // the signature guard is inert; Guard 3 permits the repair.
    const history = [round(1, ["a", "b", "c"]), round(2, ["a", "b"]), round(3, ["a"])];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({ action: "repair" });
  });

  test("regression still outranks the signature guard", () => {
    // `a` was green in round 1, red again in round 3 with a stable sig -> the
    // regression guard (checked first) wins with its own reason.
    const history = [
      round(1, ["b"], { b: "boom-B" }, ["a"]),
      round(2, ["a", "b"], { a: "boom-A", b: "boom-B" }),
      round(3, ["a", "b"], { a: "boom-A", b: "boom-B" }),
    ];
    expect(decideRepairContinuation(history, budget(), NOW, CAPS)).toEqual({
      action: "escalate",
      reason: "regression: a",
    });
  });

  test("normalizeGateOutput: collapses whitespace, trims, bounds the tail", () => {
    expect(normalizeGateOutput("  process:   not found\n\n")).toBe("process: not found");
    const long = "x".repeat(600);
    expect(normalizeGateOutput(long).length).toBe(500);
  });
});

// --- (B) the executor attempt-loop breaker -------------------------------------

import type { ExecuteOpts } from "../src/executor";
import { executeLoom } from "../src/executor";
import { createLoom, saveLoom } from "../src/looms";
import { createProject } from "../src/manifest";
import { ProjectManifest } from "../src/schemas";
import { CONTRACT_FILE, writeBundleFile } from "../src/bundle";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-breaker-home-"));
process.env.TELAR_HOME = home;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

let repo: string;
let projN = 0;
let projectName: string;

beforeEach(() => {
  process.env.TELAR_HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-breaker-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  projN++;
  projectName = `m11brk-${projN}`;
  createProject(repo, { name: projectName });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A manifest whose one gate ALWAYS fails with a stable non-empty output — the
// "prose command running as sh -c" live bug, distilled: no attempt can move it.
function manifestFor() {
  const base = ProjectManifest.parse({ name: projectName, root: repo });
  return { ...base, gates: [{ name: "g", run: "echo nope; exit 1" }] };
}

// A builder that reports success AND touches a fresh file every attempt (the
// tree changes each round) but can never affect the failing gate.
function runOptsCounting(): { opts: ExecuteOpts; calls: () => number } {
  let n = 0;
  const run = (async (_p: unknown, o: { cwd: string }) => {
    n++;
    fs.writeFileSync(path.join(o.cwd, `attempt-${n}.txt`), `try ${n}\n`);
    return { ok: true, summary: "did work", files_touched: [`attempt-${n}.txt`], blocker: null };
  }) as unknown as ExecuteOpts["run"];
  return { opts: { run, onState: saveLoom, onEvent: () => {} }, calls: () => n };
}

describe("executor attempt-loop breaker (finding 4B)", () => {
  test("an unfixable gate PARKS to blocked after 2 attempts (does not burn the 3rd)", async () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    const { opts, calls } = runOptsCounting();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(loom, manifestFor(), { ...opts, onEvent: (e) => events.push(e), maxAttempts: 3, viaWorkflow: true });

    expect(res.state).toBe("blocked");
    expect(calls()).toBe(2); // parked after attempt 2 — the 3rd never ran
    expect(res.blockedReason).toContain("Unfixable gate");
    expect(res.blockedReason).toContain("g");
    expect(res.blockedQuestion && res.blockedQuestion.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "lane-escalation" && e.reason === "unfixable-gate")).toBe(true);
  });

  test("a CONVERGING loom is NOT parked — a momentarily-identical id does not park while the failing SET strictly shrinks (finding 3)", async () => {
    // Two independent failing gates. g1 prints a STABLE non-empty output while
    // broken (so its signature is byte-identical across attempts) but is fixable by
    // touching f1; g2 is fixable by touching f2. The builder fixes ONE per attempt:
    // attempt 1 touches neither relevant file (both red), attempt 2 writes f2 (g2
    // greens, g1 still red with its identical output), attempt 3 writes f1 (both
    // green). The OLD breaker (prev-vs-current, any single stuck id, no progress
    // check) would PARK at attempt 2 — g1's signature is identical — even though the
    // loom is converging. The no-progress precondition sees the failing SET strictly
    // shrink ({g1,g2}->{g1}) and lets attempt 3 run, so the loom is never parked.
    const base = ProjectManifest.parse({ name: projectName, root: repo });
    const manifest = {
      ...base,
      gates: [
        { name: "g1", run: "test -f f1 || { echo g1missing; exit 1; }" },
        { name: "g2", run: "test -f f2 || { echo g2missing; exit 1; }" },
      ],
    };
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    let n = 0;
    const run = (async (_p: unknown, o: { cwd: string }) => {
      n++;
      if (n === 2) fs.writeFileSync(path.join(o.cwd, "f2"), "x\n"); // fix g2
      if (n === 3) fs.writeFileSync(path.join(o.cwd, "f1"), "x\n"); // fix g1
      fs.writeFileSync(path.join(o.cwd, `touch-${n}.txt`), `try ${n}\n`); // tree always changes
      return { ok: true, summary: "did work", files_touched: [`touch-${n}.txt`], blocker: null };
    }) as unknown as ExecuteOpts["run"];
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(loom, manifest, { run, onState: saveLoom, onEvent: (e) => events.push(e), maxAttempts: 3, viaWorkflow: true });

    expect(n).toBe(3); // all three attempts ran — NOT parked at attempt 2
    expect(res.state).not.toBe("blocked");
    expect(events.some((e) => e.type === "lane-escalation" && e.reason === "unfixable-gate")).toBe(false);
  });

  test("the builder touches NOTHING -> no park (the breaker needs a tree change to fire)", async () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    let n = 0;
    const run = (async () => {
      n++;
      return { ok: true, summary: "noop", files_touched: [], blocker: null };
    }) as unknown as ExecuteOpts["run"];
    const res = await executeLoom(loom, manifestFor(), { run, onState: saveLoom, onEvent: () => {}, maxAttempts: 3, viaWorkflow: true });
    // No files_touched -> treeChanged false -> breaker never engages -> the
    // ordinary decide() path lands it failed after all attempts.
    expect(res.state).toBe("failed");
    expect(n).toBe(3);
  });
});

// M11 item-2(iv) (finding 2) — the pre-attempt-loop fail-CLOSED backstop: a
// LEGACY on-disk contract whose `command` expected is prose (validateContract
// would now reject it, so readContract returns null and the yardstick would
// SILENTLY vanish) must PARK the loom to blocked, never run the prose through
// sh -c and never proceed yardstick-less. We seed the broken contract with the
// RAW bundle writer (writeContract validates and would refuse it) — exactly the
// pre-guard artifact this backstop exists for. A gate-less manifest isolates the
// pre-flight from the finding-4 attempt-loop breaker above.
describe("executor item-2(iv) non-runnable-expected pre-flight park", () => {
  function manifestPlain() {
    const base = ProjectManifest.parse({ name: projectName, root: repo });
    return { ...base };
  }

  function seedProseCommandContract(loomId: string) {
    writeBundleFile(
      loomId,
      CONTRACT_FILE,
      JSON.stringify({
        version: 1,
        assertions: [
          {
            id: "bun-test-suite-passes",
            description: "the bun test suite passes",
            type: "command",
            expected: "process exits with code 0; all tests green",
            blocker: true,
          },
        ],
      }),
    );
  }

  test("a legacy prose command contract PARKS before any attempt runs", async () => {
    const loom = createLoom({ project: projectName, kind: "custom", title: "t", prompt: "x", account: "personal" });
    saveLoom(loom);
    seedProseCommandContract(loom.id);
    let builderCalls = 0;
    const run = (async () => {
      builderCalls++;
      return { ok: true, summary: "built", files_touched: ["f.txt"], blocker: null };
    }) as unknown as ExecuteOpts["run"];
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const res = await executeLoom(loom, manifestPlain(), {
      run,
      onState: saveLoom,
      onEvent: (e) => events.push(e),
      maxAttempts: 3,
      viaWorkflow: true,
    });

    expect(res.state).toBe("blocked");
    expect(builderCalls).toBe(0); // parked BEFORE the attempt loop — no prose ever hit sh -c
    expect(res.blockedReason).toContain("Non-runnable");
    expect(res.blockedReason).toContain("bun-test-suite-passes");
    expect(res.blockedQuestion && res.blockedQuestion.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "lane-escalation" && e.reason === "nonrunnable-expected")).toBe(true);
  });
});
