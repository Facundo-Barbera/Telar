// M10.1 — the orchestrator whole-verification GATE (the TOP gate). Hermetic:
// a fake git runner, an injected verify producer, injected fake gates. No real
// agent, git, DB, browser, or telar repo. Asserts:
//   (helper) orchestratorVerifyEnabled: default OFF, manifest + env override
//   (1) a red whole-verdict demotes ready -> needs-review (flag on)
//   (2) a pass/LEGITIMATE-skip whole-verdict keeps ready (flag on)
//   (3) a THROWING whole-verify is fail-OPEN (caught, keeps ready)
//   (4) the fork targets consolidationBranch when present, baseSha when absent
//   (5) flag-OFF byte-identical: no forkRef => baseSha, no fullContract => ALL slice
//   (6) the gate only KEEPS or DEMOTES ready — it NEVER writes "done"
//   (fail-closed hole, HIGH) fullContract + a REQUIRED panel that obtained NO
//     evidence (no reachable target) DEMOTES to "fail" — it must NOT collapse to
//     a keep-ready "skip" (the composed whole would obtain zero evidence for a
//     required completeness criterion yet stay `ready`: sacred invariant 3).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m10verify-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
  delete process.env.TELAR_ORCHESTRATOR_VERIFY;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { orchestratorVerifyEnabled } = await import("../src/runner/flag");
const { runWeave } = await import("../src/weave");
const { frozenLaneVerify } = await import("../src/verify-thread");
const { runIntegrationVerify } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
import type { Loom } from "../src/looms";
import type { IvResult } from "../src/verify-thread";
import type { SubGoal, VerificationContract, ContractAssertion } from "../src/schemas";
import { ProjectManifest } from "../src/schemas";
import type { GitRunner } from "../src/vcs";
import type { Gate, GateResult } from "../src/gates";

let n = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  n++;
  return {
    id: `M${n}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...overrides,
  };
}
function subGoal(over: Partial<SubGoal> = {}): SubGoal {
  return {
    id: over.id ?? "s1",
    title: "title",
    detail: "detail",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...over,
  };
}
function fakeGit(): { runner: GitRunner; args: string[][] } {
  const args: string[][] = [];
  const runner: GitRunner = (_root, a) => {
    args.push(a);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, args };
}
const fakeManifest = { root: "/telar/fake-root", urls: { dev: "http://root-dev" } } as any;

// ── (helper) orchestratorVerifyEnabled — TOP-LEVEL flag, default OFF ─────────
describe("(helper) orchestratorVerifyEnabled: default OFF; manifest + env override", () => {
  test("false by default; honors manifest flag + TELAR_ORCHESTRATOR_VERIFY", () => {
    delete process.env.TELAR_ORCHESTRATOR_VERIFY;
    expect(orchestratorVerifyEnabled({})).toBe(false);
    expect(orchestratorVerifyEnabled({ orchestratorVerify: false })).toBe(false);
    expect(orchestratorVerifyEnabled({ orchestratorVerify: true })).toBe(true);
    process.env.TELAR_ORCHESTRATOR_VERIFY = "1";
    expect(orchestratorVerifyEnabled({})).toBe(true);
  });
});

// ── the reused weave gate consumes the whole-verification IvResult ───────────
// weave.ts:395-433 is REUSED UNCHANGED — the whole-verification returns the same
// IvResult shape, so the demote/keep/throw semantics are identical.
describe("weave gate — whole-verification producer (flag ON): demote / keep / fail-open / never-done", () => {
  test("(1) a red whole-verdict demotes ready -> needs-review", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let calls = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      onEvent: (ev) => events.push(ev),
      // The whole-verification over the composed whole returns a red verdict.
      runIntegrationVerify: async (): Promise<IvResult> => ((calls++, { verification: "fail", gatesOk: false })),
    });
    expect(result.state).toBe("needs-review");
    expect(result.latestVerdict).toBe("fail");
    expect(result.error).toBe("integration verification fail");
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "weave-verify" && e.verification === "fail")).toBe(true);
  });

  test("(2) a pass verdict keeps ready; a LEGITIMATE skip verdict keeps ready", async () => {
    const pass = await runWeave(fakeLoom(), [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (c) => ((c.state = "done"), c),
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
    });
    expect(pass.state).toBe("ready");
    expect(pass.latestVerdict).toBe("pass");

    // The weave gate legitimately keeps `ready` on a genuine `skip` — nothing
    // was owed. This is CORRECT weave-gate semantics and stays. It is NOT the
    // fail-closed hole: the producer (runIntegrationVerify) only ever emits a
    // keep-ready `skip` when NO panel was required (an empty agent-judged slice).
    // A REQUIRED-but-unrun panel over the full contract now yields "fail" at the
    // producer, demoted by this same gate — proven in the runIntegrationVerify
    // fail-closed test below (and end-to-end in the demote test at the bottom).
    const skip = await runWeave(fakeLoom(), [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (c) => ((c.state = "done"), c),
      runIntegrationVerify: async () => ({ verification: "skip", gatesOk: true }),
    });
    expect(skip.state).toBe("ready");
    expect(skip.latestVerdict).toBe("skip");
  });

  test("(3) a THROWING whole-verify is fail-OPEN — caught, keeps ready, emits weave-verify-error", async () => {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await runWeave(fakeLoom(), [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (c) => ((c.state = "done"), c),
      onEvent: (ev) => events.push(ev),
      runIntegrationVerify: async () => {
        throw new Error("whole-verify blew up");
      },
    });
    expect(result.state).toBe("ready"); // NOT demoted, NOT failed
    expect(result.latestVerdict).toBeUndefined();
    expect(events.some((e) => e.type === "weave-verify-error")).toBe(true);
  });

  test("(6) the gate NEVER writes 'done' — a pass keeps ready (human acceptLoom is the only path to done)", async () => {
    const result = await runWeave(fakeLoom(), [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (c) => ((c.state = "done"), c),
      // Even a green whole-verdict: ceiling is "ready".
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
    });
    expect(result.state).toBe("ready");
    expect(result.state).not.toBe("done");
  });
});

// ── (4) the fork ref: consolidationBranch when present, baseSha when absent ──
describe("(4) frozenLaneVerify fork ref — whole-verify forks the consolidation branch", () => {
  test("forkRef set to consolidationBranch => worktree add uses the branch; fullContract carried through", async () => {
    const git = fakeGit();
    let captured: any = null;
    const loom = fakeLoom({ baseSha: "deadbeef", consolidationBranch: "telar/M-root" });
    await frozenLaneVerify(loom, fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      // mirror the dispatcher whole-verify wiring
      forkRef: loom.consolidationBranch ?? loom.baseSha,
      verifyOpts: { fullContract: true },
      resolveServersConfig: () => ({ version: 1, driver: "none", services: {} }) as any,
    } as any);
    const add = git.args.find((a) => a[0] === "worktree" && a[1] === "add");
    expect(add).toBeTruthy();
    // last arg to `worktree add --detach <wt> <ref>` is the ref -> the branch NAME
    expect(add![add!.length - 1]).toBe("telar/M-root");
    // fullContract is threaded through verifyOpts into the producer opts
    expect(captured.fullContract).toBe(true);
    expect(path.basename(captured.verifyCwd)).toContain("frozen-");
  });

  test("forkRef unset => forks loom.baseSha (fallback)", async () => {
    const git = fakeGit();
    const loom = fakeLoom({ baseSha: "cafef00d" }); // no consolidationBranch
    await frozenLaneVerify(loom, fakeManifest, {
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => ({ version: 1, driver: "none", services: {} }) as any,
    } as any);
    const add = git.args.find((a) => a[0] === "worktree" && a[1] === "add");
    expect(add![add!.length - 1]).toBe("cafef00d");
  });

  test("neither forkRef nor baseSha => ref-aware degrade to runIntegrationVerify passthrough, no worktree", async () => {
    const git = fakeGit();
    let captured: any = null;
    const loom = fakeLoom(); // no baseSha, no consolidationBranch
    await frozenLaneVerify(loom, fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      verifyOpts: { fullContract: true },
    } as any);
    expect(git.args).toHaveLength(0); // no worktree machinery
    expect(captured.verifyCwd).toBeUndefined(); // producer defaults to manifest.root
    expect(captured.fullContract).toBe(true); // fullContract still carried
  });
});

// ── (5) flag-OFF byte-identical: no forkRef => baseSha, no fullContract => ALL
describe("(5) flag-OFF byte-identical", () => {
  test("no forkRef and no verifyOpts => forks baseSha and passes NO fullContract (today's path)", async () => {
    const git = fakeGit();
    let captured: any = null;
    const loom = fakeLoom({ baseSha: "basesha01", consolidationBranch: "telar/M-root" });
    // Flag OFF ⇒ the dispatcher passes neither forkRef nor fullContract.
    await frozenLaneVerify(loom, fakeManifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => ({ version: 1, driver: "none", services: {} }) as any,
    } as any);
    const add = git.args.find((a) => a[0] === "worktree" && a[1] === "add");
    // Forks baseSha (NOT the consolidation branch) — byte-identical to pre-M10.1.
    expect(add![add!.length - 1]).toBe("basesha01");
    expect(captured.fullContract).toBeUndefined();
  });
});

// ── fullContract slice: completeness over the composed whole (executor) ──────
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m10verify-p-"));
createProject(projectRoot, { name: "pm10" });
const ivManifest = ProjectManifest.parse({
  name: "pm10",
  root: "/tmp/telar-m10verify-repo",
  urls: { dev: "http://localhost:3000" },
  gates: [{ name: "lint", run: "eslint ." }],
});
const asrt = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});
function rootLoom(contract: VerificationContract): Loom {
  const loom = createLoom({ project: "pm10", kind: "custom", title: "root", prompt: "assemble", account: "personal" });
  writeBundleFile(loom.id, "objective.md", "obj");
  writeContract(loom.id, contract);
  return loom;
}
function fakeGates(decide: (cmd: string) => boolean) {
  const calls: Gate[] = [];
  const gateRunner = async (gate: Gate): Promise<GateResult> => {
    calls.push(gate);
    const ok = decide(gate.run);
    return { name: gate.name, ok, exitCode: ok ? 0 : 1, output: "", durationMs: 1, timedOut: false };
  };
  return { gateRunner, calls };
}

describe("runIntegrationVerify — fullContract widens the slice to the WHOLE contract", () => {
  const contract: VerificationContract = {
    version: 1,
    assertions: [
      asrt({ id: "c_all", type: "command", expected: "echo all", subGoalId: "ALL" }),
      asrt({ id: "c_child", type: "command", expected: "echo perchild", subGoalId: "s1" }),
    ],
  };

  test("default (no fullContract) verifies ONLY the ALL slice — per-subGoal assertions dropped", async () => {
    const loom = rootLoom(contract);
    const { gateRunner, calls } = fakeGates(() => true);
    const out = await runIntegrationVerify(loom, ivManifest, { gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("pass");
    const ran = calls.map((g) => g.run);
    expect(ran).toContain("echo all");
    expect(ran).not.toContain("echo perchild"); // per-child dropped in the ALL slice
  });

  test("fullContract:true verifies the FULL contract — per-subGoal assertions INCLUDED (completeness)", async () => {
    const loom = rootLoom(contract);
    const { gateRunner, calls } = fakeGates(() => true);
    const out = await runIntegrationVerify(loom, ivManifest, {
      fullContract: true,
      gateRunner,
      run: (async () => null) as any,
    });
    expect(out?.verification).toBe("pass"); // fires (does not no-op) over the root's validated contract
    const ran = calls.map((g) => g.run);
    expect(ran).toContain("echo all");
    expect(ran).toContain("echo perchild"); // the whole contract, unfiltered
  });

  test("fullContract:true with a red per-child gate => 'fail' (regression surfaces as a gate fail, not a throw)", async () => {
    const loom = rootLoom(contract);
    const { gateRunner } = fakeGates((cmd) => cmd !== "echo perchild"); // per-child gate red
    const out = await runIntegrationVerify(loom, ivManifest, {
      fullContract: true,
      gateRunner,
      run: (async () => null) as any,
    });
    expect(out?.verification).toBe("fail");
    expect(out?.gatesOk).toBe(false);
  });
});

// ── fail-CLOSED hole (HIGH): a REQUIRED whole-panel with NO evidence ─────────
// The confirmed PoC. Under fullContract the top gate pulls per-child live-critic
// COMPLETENESS assertions up to the composed whole. When the verify lane has no
// reachable target (no urls.dev), runPanelVerification returns a `panelRequired`
// `skip` (no evidence). Pre-fix, runIntegrationVerify collapsed that to a
// keep-ready `skip`, so the loom stayed `ready` with ZERO independent evidence
// for a required criterion — a false green (violates sacred invariant 3). The
// fix mirrors decide()'s thread-level rule at the top: `panelRequired && skip`
// under fullContract ⇒ a DEMOTING `fail`. These tests are the regression guard.
const noTargetManifest = ProjectManifest.parse({ name: "pm10", root: "/tmp/telar-m10verify-repo" }); // NO urls.dev ⇒ no target
const REQUIRED_SKIP_ERROR = "panel verification required but did not run (composed whole)";
const liveCritic = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "lc",
  description: "d",
  type: "live-critic",
  observable: "the composed UI shows the feature",
  blocker: true,
  ...over,
});

describe("runIntegrationVerify — fail-closed over the composed whole (the M10.1 hole)", () => {
  // The PoC: one PASSING deterministic gate on ALL + one live-critic completeness
  // assertion on a CHILD subgoal. fullContract pulls the child assertion up.
  const holeContract: VerificationContract = {
    version: 1,
    assertions: [
      asrt({ id: "c_all", type: "command", expected: "echo all", subGoalId: "ALL" }),
      liveCritic({ id: "lc_child", subGoalId: "s1" }),
    ],
  };

  test("(HOLE CLOSED) fullContract:true + a REQUIRED panel + NO reachable target => demoting 'fail', NOT keep-ready 'skip'", async () => {
    const loom = rootLoom(holeContract);
    const { gateRunner } = fakeGates(() => true); // the ALL deterministic gate passes
    const out = await runIntegrationVerify(loom, noTargetManifest, {
      fullContract: true,
      gateRunner,
      run: (async () => null) as any, // never invoked: no target ⇒ the panel cannot run
    });
    // The whole obtained ZERO evidence for the required completeness criterion —
    // the verdict must DEMOTE (weave demotes on "fail"), never a keep-ready skip.
    expect(out?.verification).toBe("fail");
    expect(out?.verification).not.toBe("skip");
    expect(out?.error).toBe(REQUIRED_SKIP_ERROR);
  });

  test("(no over-fire) fullContract:true + an all-deterministic contract + NO target keeps a green verdict (panelRequired false ⇒ never demoted)", async () => {
    const detContract: VerificationContract = {
      version: 1,
      assertions: [asrt({ id: "c_all", type: "command", expected: "echo all", subGoalId: "ALL" })],
    };
    const loom = rootLoom(detContract);
    const { gateRunner } = fakeGates(() => true);
    const out = await runIntegrationVerify(loom, noTargetManifest, {
      fullContract: true,
      gateRunner,
      run: (async () => null) as any,
    });
    expect(out?.verification).toBe("pass"); // empty agent-judged slice ⇒ the coercion never fires
    expect(out?.error).toBeUndefined();
  });

  test("(flag-OFF byte-identical) the SAME required-panel/no-target ALL slice keeps 'skip' without fullContract; fullContract flips it to fail-closed 'fail'", async () => {
    // Both assertions on subGoalId ALL so the required panel is in the ALL slice
    // itself — the ONE input isolates exactly the fullContract toggle.
    const allSliceContract: VerificationContract = {
      version: 1,
      assertions: [
        asrt({ id: "c_all", type: "command", expected: "echo all", subGoalId: "ALL" }),
        liveCritic({ id: "lc_all", subGoalId: "ALL" }),
      ],
    };
    const { gateRunner } = fakeGates(() => true);
    // flag OFF (no fullContract): today's behavior — the required-panel skip is
    // preserved as a keep-ready "skip". Byte-identical to pre-M10.1.
    const off = await runIntegrationVerify(rootLoom(allSliceContract), noTargetManifest, {
      gateRunner,
      run: (async () => null) as any,
    });
    expect(off?.verification).toBe("skip");
    expect(off?.error).toBeUndefined();
    // flag ON (fullContract): the SAME evidence-free required panel demotes.
    const on = await runIntegrationVerify(rootLoom(allSliceContract), noTargetManifest, {
      fullContract: true,
      gateRunner,
      run: (async () => null) as any,
    });
    expect(on?.verification).toBe("fail");
    expect(on?.error).toBe(REQUIRED_SKIP_ERROR);
  });

  test("(end-to-end) the whole-verify producer's evidence-free required panel demotes ready -> needs-review through the weave gate", async () => {
    const root = rootLoom(holeContract);
    const { gateRunner } = fakeGates(() => true);
    const result = await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (c) => ((c.state = "done"), c),
      // the REAL producer, bound with fullContract + no target (the PoC scenario).
      runIntegrationVerify: (l) =>
        runIntegrationVerify(l, noTargetManifest, { fullContract: true, gateRunner, run: (async () => null) as any }),
    });
    expect(result.state).toBe("needs-review"); // demoted from the self-reported ready
    expect(result.latestVerdict).toBe("fail");
  });
});
