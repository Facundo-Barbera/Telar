// Unit 6 (docs §8 MVP): the end-of-orchestration ALL-scope integration verify
// PRODUCER's DEFAULT runner (runIntegrationVerify in executor.ts). Hermetic:
// the deterministic slice runs through an INJECTED fake gate runner and the
// agent-judged slice through an INJECTED fake panel agent — no real process,
// no browser, no agent(). Asserts:
//   - the ALL/unlabelled slice is isolated (per-subGoal assertions ignored)
//   - all-deterministic ALL slice, gates green -> "pass" (zero-browser backend)
//   - a red deterministic gate -> "fail", the panel never runs
//   - a mixed ALL slice -> the panel judges ONLY the agent-judged slice
//   - no ALL slice / no contract -> null (no-op producer, back-compat)
//   - each call pushes exactly one role:"integration" AttemptRecord (evidence)
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManifest, type ContractAssertion, type VerificationContract } from "../src/schemas";
import type { Gate, GateResult } from "../src/gates";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-intverify-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { runIntegrationVerify } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");

// Register project "p" so runPanel's registry lookup resolves (the panel path).
createProject(fs.mkdtempSync(path.join(os.tmpdir(), "telar-intverify-p-")), { name: "p" });

const manifest = ProjectManifest.parse({
  name: "p",
  root: "/tmp/telar-intverify-repo",
  urls: { dev: "http://localhost:3000" },
  gates: [{ name: "lint", run: "eslint ." }],
});

const a = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});

// Fake gate runner: decides ok by the command string, records the calls. Never spawns.
function fakeGates(decide: (cmd: string) => boolean) {
  const calls: Gate[] = [];
  const gateRunner = async (gate: Gate): Promise<GateResult> => {
    calls.push(gate);
    const ok = decide(gate.run);
    return { name: gate.name, ok, exitCode: ok ? 0 : 1, output: `ran: ${gate.run}`, durationMs: 1, timedOut: false };
  };
  return { gateRunner, calls };
}

function rootLoom(contract: VerificationContract): Loom {
  const loom = createLoom({ project: "p", kind: "custom", title: "root", prompt: "assemble", account: "personal" });
  writeBundleFile(loom.id, "objective.md", "Integration objective.");
  writeContract(loom.id, contract);
  return loom;
}

describe("runIntegrationVerify — default runner, hermetic", () => {
  test("all-deterministic ALL slice, gates green -> pass; per-subGoal assertions ignored; no agent/browser", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [
        a({ id: "c1", type: "command", expected: "bun test", subGoalId: "ALL" }),
        a({ id: "g1", type: "gate", expected: "lint", subGoalId: "ALL" }),
        a({ id: "u1", type: "command", expected: "echo unlabelled" }), // unlabelled -> ALL slice
        a({ id: "p1", type: "command", expected: "echo perchild", subGoalId: "s1" }), // per-subGoal -> ignored
      ],
    });
    const { gateRunner, calls } = fakeGates(() => true);
    let ranAgent = false;
    const run = (async () => ((ranAgent = true), null)) as any;

    const iv = await runIntegrationVerify(loom, manifest, { gateRunner, run });

    expect(iv).not.toBeNull();
    expect(iv!.verification).toBe("pass");
    expect(iv!.gatesOk).toBe(true);
    expect(ranAgent).toBe(false); // zero-browser backend verify
    // Only the ALL/unlabelled deterministic assertions ran — never the per-subGoal p1.
    expect(calls.map((c) => c.name).sort()).toEqual(["c1", "g1", "u1"]);
    // One integration AttemptRecord recorded on the ROOT as evidence.
    expect(loom.attempts.length).toBe(1);
    expect(loom.attempts[0]!.role).toBe("integration");
    expect(loom.attempts[0]!.gates!.map((g) => g.name).sort()).toEqual(["c1", "g1", "u1"]);
    expect(loom.attempts[0]!.endedAt).toBeGreaterThan(0);
  });

  test("a red deterministic gate -> fail, and the panel never runs", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [
        a({ id: "c1", type: "command", expected: "exit 1", subGoalId: "ALL" }),
        a({ id: "lc", type: "live-critic", expected: undefined, observable: "assembled whole visible", subGoalId: "ALL" }),
      ],
    });
    const { gateRunner } = fakeGates((cmd) => cmd !== "exit 1");
    let ranAgent = false;
    const run = (async () => ((ranAgent = true), null)) as any;

    const iv = await runIntegrationVerify(loom, manifest, { gateRunner, run });

    expect(iv!.verification).toBe("fail");
    expect(iv!.gatesOk).toBe(false);
    expect(ranAgent).toBe(false); // an already-falsified whole is not prose-judged
  });

  test("mixed ALL slice, gates green -> the panel judges ONLY the agent-judged slice", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [
        a({ id: "c1", type: "command", expected: "bun test", subGoalId: "ALL", description: "integration cmd passes" }),
        a({ id: "lc", type: "live-critic", expected: undefined, observable: "end-to-end flow works", subGoalId: "ALL", description: "flow works" }),
      ],
    });
    const { gateRunner } = fakeGates(() => true);
    const prompts: string[] = [];
    const run = (async (task: string) => {
      prompts.push(task);
      const m = task.match(/--- Your lens: (.+?) \(/);
      return { lens: m ? m[1]! : "unknown", ok: true, summary: "clean", findings: [], evidence: [] };
    }) as any;

    const iv = await runIntegrationVerify(loom, manifest, { gateRunner, run });

    expect(iv!.verification).toBe("pass");
    expect(iv!.gatesOk).toBe(true);
    expect(iv!.panelReport).toBeTruthy();
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain("[lc]"); // grounds in the live-critic ALL assertion
      expect(p).not.toContain("[c1]"); // never re-judges the already-settled gate
    }
  });

  test("no ALL slice (every assertion per-subGoal) -> null, no attempt pushed (no-op)", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [
        a({ id: "p1", type: "command", expected: "echo a", subGoalId: "s1" }),
        a({ id: "p2", type: "command", expected: "echo b", subGoalId: "s2" }),
      ],
    });
    const iv = await runIntegrationVerify(loom, manifest, { gateRunner: fakeGates(() => true).gateRunner });
    expect(iv).toBeNull();
    expect(loom.attempts.length).toBe(0);
  });

  test("no bundle contract on the root -> null (back-compat)", async () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "plain root", prompt: "x", account: "personal" });
    const iv = await runIntegrationVerify(loom, manifest, {});
    expect(iv).toBeNull();
    expect(loom.attempts.length).toBe(0);
  });

  test("an all-live-critic ALL slice (no falsifiable hard gate) -> null (validateContract floor)", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [
        // Whole contract validates (the per-subGoal command is a hard gate)...
        a({ id: "p1", type: "command", expected: "echo a", subGoalId: "s1" }),
        // ...but the ALL slice is live-critic only -> not a real ALL contract.
        a({ id: "lc", type: "live-critic", expected: undefined, observable: "vibes", subGoalId: "ALL" }),
      ],
    });
    const iv = await runIntegrationVerify(loom, manifest, {});
    expect(iv).toBeNull();
    expect(loom.attempts.length).toBe(0);
  });
});
