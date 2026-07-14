// B1 — the COVERAGE INVARIANT (the SAFETY half of the advisory reshape).
//
// Doctrine §70-72: a per-thread verify relaxation (the panel SKIP carried as
// advisory — the one relax-to-green case; a panel FAIL / contract-miss / step-check
// ESCALATES `blocked` instead) is NEVER terminal on its own; the thread advises and
// the ONE authoritative fail-closed proof is the orchestrator's top gate. That only
// holds if everything a thread RELAXES is provably RE-PROVEN at the top gate. This
// file pins the top-gate CONSUMPTION mechanism, which is KIND-AGNOSTIC (it keys
// only on assertionIds) — so the synthetic records below use arbitrary kind labels
// to exercise the covered / structural-gap / unproven paths.
//
// Step 1 lands the safety net BEFORE step 2 broadens the relaxations:
//   (a) a thread that relaxes coverage RECORDS exactly what it stopped gating as
//       an explicit `relaxedCoverage` record (the contract-assertion ids) on its
//       own loom result — not an implicit routedContract coupling;
//   (b) the TOP GATE (runIntegrationVerify with fullContract) CONSUMES those
//       records and fails CLOSED — demotes to a "fail" the weave gate acts on —
//       for ANY relaxed id it cannot re-prove (absent from its passing set over
//       the composed whole).
//
// THE PIN: a thread relaxes X while the top gate CANNOT re-prove X => the whole
// verdict is "fail" (weave demotes ready -> needs-review), NEVER a keep-ready pass.
//
// Hermetic: no real agent/git/DB/browser. Injected fake gates; child looms are
// real loom.json in a temp TELAR_HOME so listChildLooms reads them.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-b1cov-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { runIntegrationVerify } = await import("../src/executor");
const { createLoom, saveLoom, uncoveredRelaxedIds } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
import type { Loom, RelaxedCoverage } from "../src/looms";
import type { VerificationContract, ContractAssertion } from "../src/schemas";
import { ProjectManifest } from "../src/schemas";
import type { Gate, GateResult } from "../src/gates";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-b1cov-p-"));
createProject(projectRoot, { name: "b1cov" });
// NO urls.dev on the base manifest: a live-critic slice hits the no-target floor.
const manifest = ProjectManifest.parse({ name: "b1cov", root: projectRoot });

const asrt = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});

function rootLoom(contract: VerificationContract): Loom {
  const loom = createLoom({ project: "b1cov", kind: "custom", title: "root", prompt: "assemble", account: "personal" });
  writeBundleFile(loom.id, "objective.md", "obj");
  writeContract(loom.id, contract);
  return loom;
}

// A real child loom.json under `root`, carrying a relaxedCoverage record. The
// top gate enumerates it via listChildLooms(root.id).
function childRelaxing(root: Loom, rec: RelaxedCoverage): Loom {
  const child = createLoom({
    project: "b1cov",
    kind: "custom",
    title: "child",
    prompt: "x",
    account: "personal",
    parentLoomId: root.id,
    subGoalId: "s1",
  });
  child.relaxedCoverage = [rec];
  saveLoom(child);
  return child;
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

// ── (unit) the PURE coverage predicate ───────────────────────────────────────
describe("uncoveredRelaxedIds — the pure fail-closed coverage predicate", () => {
  test("every relaxed id present in the proven set => nothing uncovered", () => {
    const relaxed: RelaxedCoverage[] = [{ kind: "panel-skip", assertionIds: ["a", "b"] }];
    expect(uncoveredRelaxedIds(relaxed, ["a", "b", "c"])).toEqual([]);
  });
  test("a relaxed id ABSENT from the proven set surfaces (deduped + sorted)", () => {
    const relaxed: RelaxedCoverage[] = [
      { kind: "panel-skip", assertionIds: ["z", "a"] },
      { kind: "panel-skip", assertionIds: ["a", "z"] }, // dupes across records
    ];
    expect(uncoveredRelaxedIds(relaxed, ["b"])).toEqual(["a", "z"]);
  });
  test("no relaxations => never uncovered (byte-identical pre-B1 path)", () => {
    expect(uncoveredRelaxedIds([], [])).toEqual([]);
  });
});

// ── (top gate) consumes relaxed records + fails closed on an unre-proven id ───
describe("runIntegrationVerify (top gate) — re-proves relaxed coverage, fail-closed", () => {
  // A whole contract whose every assertion is a passing deterministic gate.
  const contract: VerificationContract = {
    version: 1,
    assertions: [
      asrt({ id: "c_all", type: "command", expected: "echo all", subGoalId: "ALL" }),
      asrt({ id: "c_child", type: "command", expected: "echo child", subGoalId: "s1" }),
    ],
  };

  test("(covered => pass) a child relaxed an id the top gate PROVES green => stays pass, no demote", async () => {
    const root = rootLoom(contract);
    childRelaxing(root, { kind: "panel-skip", assertionIds: ["c_child"] });
    const { gateRunner } = fakeGates(() => true); // both gates green ⇒ c_child re-proven
    const out = await runIntegrationVerify(root, manifest, { fullContract: true, gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("pass");
    expect(out?.error).toBeUndefined();
    expect(out?.passingIds).toContain("c_child");
  });

  test("(THE PIN — structural gap) a child relaxed an id the full contract does NOT contain => 'fail', never keep-ready", async () => {
    const root = rootLoom(contract);
    // "ghost" is relaxed by the thread but is NOT an assertion in the root
    // contract — the top gate STRUCTURALLY cannot re-prove it (the exact
    // fail-open hole step 2's broader relaxations could open).
    childRelaxing(root, { kind: "contract-miss", assertionIds: ["ghost"] });
    const { gateRunner } = fakeGates(() => true); // every REAL gate passes ⇒ absent the check this is a false green
    const out = await runIntegrationVerify(root, manifest, { fullContract: true, gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("fail"); // demote — weave lifts ready -> needs-review on "fail"
    expect(out?.error).toContain("relaxed coverage not re-proven");
    expect(out?.error).toContain("ghost");
  });

  test("(THE PIN — unproven at top) a child relaxed a real id whose top-gate gate goes RED => 'fail'", async () => {
    const root = rootLoom(contract);
    childRelaxing(root, { kind: "panel-skip", assertionIds: ["c_child"] });
    // c_child's gate reddens at the top gate ⇒ not in passingIds ⇒ uncovered.
    const { gateRunner } = fakeGates((cmd) => cmd !== "echo child");
    const out = await runIntegrationVerify(root, manifest, { fullContract: true, gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("fail");
  });

  test("(scoping) WITHOUT fullContract (a checkpoint slice) the relaxed records are NOT consumed => no demote", async () => {
    const root = rootLoom(contract);
    childRelaxing(root, { kind: "contract-miss", assertionIds: ["ghost"] });
    const { gateRunner } = fakeGates(() => true);
    // No fullContract ⇒ the ALL slice (c_all only) verifies; the whole's
    // relaxation authority is not this pass's to consume.
    const out = await runIntegrationVerify(root, manifest, { gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("pass");
    expect(out?.error).toBeUndefined();
  });

  test("(no relaxations) a root whose children relaxed NOTHING is byte-identical => pass", async () => {
    const root = rootLoom(contract);
    createLoom({ project: "b1cov", kind: "custom", title: "clean-child", prompt: "x", account: "personal", parentLoomId: root.id, subGoalId: "s1" });
    const { gateRunner } = fakeGates(() => true);
    const out = await runIntegrationVerify(root, manifest, { fullContract: true, gateRunner, run: (async () => null) as any });
    expect(out?.verification).toBe("pass");
    expect(out?.error).toBeUndefined();
  });
});
