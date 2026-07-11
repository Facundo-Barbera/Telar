// Unit 4 (docs §2-§5): deterministic assertion routing.
// - partitionAssertions splits a contract by MODALITY (command/gate/db-runnable
//   -> deterministic gates; the five value/prose kinds + live-SQL db -> panel).
// - runContractGates runs the deterministic slice via runGate (exit-code, no
//   LLM); the runner is INJECTED here so every case is hermetic (no real spawn,
//   no browser, no agent()).
// - runVerification only ever hands the AGENT-JUDGED slice to the panel, and an
//   all-deterministic contract skips the panel entirely (panelRequired false).
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManifest, type ContractAssertion, type VerificationContract } from "../src/schemas";
import type { Gate, GateResult } from "../src/gates";
import type { AttemptRecord, Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-routing-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { partitionAssertions, runContractGates, runVerification } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");

createProject(fs.mkdtempSync(path.join(os.tmpdir(), "telar-routing-p-")), { name: "p" });

const manifest = ProjectManifest.parse({
  name: "p",
  root: "/tmp/telar-routing-repo",
  urls: { dev: "http://localhost:3000" },
  gates: [{ name: "lint", run: "eslint ." }],
});

// A fake runGate: decides ok by a lookup on the command string, records what it
// was asked to run. Never spawns a process.
function fakeRunner(decide: (cmd: string) => { ok: boolean; exitCode?: number }) {
  const calls: Gate[] = [];
  const runner = async (gate: Gate): Promise<GateResult> => {
    calls.push(gate);
    const d = decide(gate.run);
    return {
      name: gate.name,
      ok: d.ok,
      exitCode: d.ok ? 0 : (d.exitCode ?? 1),
      output: `ran: ${gate.run}`,
      durationMs: 1,
      timedOut: false,
    };
  };
  return { runner, calls };
}

const a = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});

describe("partitionAssertions — split by modality", () => {
  test("command / gate / runnable-db route DETERMINISTIC; value/prose kinds + live-SQL db route AGENT-JUDGED", () => {
    const cmd = a({ id: "c1", type: "command", expected: "bun test" });
    const gate = a({ id: "g1", type: "gate", expected: "lint" });
    const dbRun = a({ id: "d1", type: "db", expected: "pg_prove t/*.sql" });
    const dbLive = a({ id: "d2", type: "db", expected: "SELECT count(*) FROM orders", observable: "row exists" });
    const critic = a({ id: "lc", type: "live-critic", expected: undefined, observable: "confirmation visible" });
    const value = a({ id: "v1", type: "value-equality", expected: "42.00" });
    const golden = a({ id: "gd", type: "golden-diff", expected: "snap.txt" });

    const { deterministic, agentJudged } = partitionAssertions([cmd, gate, dbRun, dbLive, critic, value, golden]);
    expect(deterministic.map((x) => x.id)).toEqual(["c1", "g1", "d1"]);
    expect(agentJudged.map((x) => x.id)).toEqual(["d2", "lc", "v1", "gd"]);
  });

  test("BACK-COMPAT: an all live-critic + value-equality contract partitions to deterministic:[] (byte-identical routing)", () => {
    const { deterministic, agentJudged } = partitionAssertions([
      a({ id: "lc", type: "live-critic", expected: undefined, observable: "visible" }),
      a({ id: "v1", type: "value-equality", expected: "42.00" }),
    ]);
    expect(deterministic).toEqual([]);
    expect(agentJudged.map((x) => x.id)).toEqual(["lc", "v1"]);
  });
});

describe("runContractGates — deterministic slice runs via the gate layer, no LLM", () => {
  test("command passes on exit 0, fails on non-zero; result.name = assertion id", async () => {
    const det: ContractAssertion[] = [
      a({ id: "green", type: "command", expected: "bun test" }),
      a({ id: "red", type: "command", expected: "exit 1" }),
    ];
    const { runner, calls } = fakeRunner((cmd) => ({ ok: cmd === "bun test" }));
    const results = await runContractGates(det, manifest, manifest.root, undefined, runner);

    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["green", true],
      ["red", false],
    ]);
    // The assertion's own command string is what got run.
    expect(calls.map((c) => c.run)).toEqual(["bun test", "exit 1"]);
  });

  test("gate assertion runs the referenced manifest gate's command, named after the assertion", async () => {
    const det: ContractAssertion[] = [a({ id: "g1", type: "gate", expected: "lint" })];
    const { runner, calls } = fakeRunner(() => ({ ok: true }));
    const results = await runContractGates(det, manifest, manifest.root, undefined, runner);

    expect(results[0]!.name).toBe("g1"); // a red result names the assertion, not the gate
    expect(calls[0]!.run).toBe("eslint ."); // ran the manifest gate's command
  });

  test("gate assertion referencing an UNKNOWN manifest gate -> synthetic ok:false, never a silent pass", async () => {
    const det: ContractAssertion[] = [a({ id: "g1", type: "gate", expected: "nope" })];
    const { runner, calls } = fakeRunner(() => ({ ok: true }));
    const results = await runContractGates(det, manifest, manifest.root, undefined, runner);

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.output).toContain("nope");
    expect(calls).toEqual([]); // nothing was ever spawned for a dangling reference
  });

  test("runnable db routes through runGate by exit code", async () => {
    const det: ContractAssertion[] = [a({ id: "d1", type: "db", expected: "pg_prove t/schema.sql" })];
    const { runner, calls } = fakeRunner(() => ({ ok: true }));
    const results = await runContractGates(det, manifest, manifest.root, undefined, runner);
    expect(results[0]!.ok).toBe(true);
    expect(calls[0]!.run).toBe("pg_prove t/schema.sql");
  });

  test("onGate fires per result, in order", async () => {
    const det: ContractAssertion[] = [
      a({ id: "one", type: "command", expected: "echo 1" }),
      a({ id: "two", type: "command", expected: "echo 2" }),
    ];
    const { runner } = fakeRunner(() => ({ ok: true }));
    const seen: string[] = [];
    await runContractGates(det, manifest, manifest.root, (r) => seen.push(r.name), runner);
    expect(seen).toEqual(["one", "two"]);
  });

  test("uses the REAL runGate by default: exit 0 passes, non-zero fails (hermetic — shell only)", async () => {
    const det: ContractAssertion[] = [
      a({ id: "green", type: "command", expected: "true" }),
      a({ id: "red", type: "command", expected: "exit 3" }),
    ];
    const results = await runContractGates(det, manifest, os.tmpdir());
    expect(results.find((r) => r.name === "green")!.ok).toBe(true);
    expect(results.find((r) => r.name === "red")!.ok).toBe(false);
    expect(results.find((r) => r.name === "red")!.exitCode).toBe(3);
  });
});

// Integration: runVerification only ever hands the panel the agent-judged slice.
function makeLoom(contract: VerificationContract): Loom {
  const loom = createLoom({ project: "p", kind: "custom", title: "T", prompt: "build", account: "personal" });
  writeBundleFile(loom.id, "objective.md", "Objective.");
  writeContract(loom.id, contract);
  return loom;
}

function pushAttempt(loom: Loom): AttemptRecord {
  const attempt: AttemptRecord = {
    n: 1,
    role: "dev",
    model: "sonnet",
    startedAt: Date.now(),
    verdict: { ok: true, summary: "done", files_touched: ["src/x.ts"], blocker: null },
  };
  loom.attempts.push(attempt);
  return attempt;
}

describe("runVerification — the panel only ever sees the agent-judged slice", () => {
  test("all-deterministic contract -> panel SKIPPED, panelRequired false, no browser/agent (zero-browser backend verify)", async () => {
    const loom = makeLoom({
      version: 1,
      assertions: [
        a({ id: "c1", type: "command", expected: "bun test" }),
        a({ id: "g1", type: "gate", expected: "lint" }),
      ],
    });
    const attempt = pushAttempt(loom);
    let ranAgent = false;
    const run = (async () => {
      ranAgent = true;
      return null;
    }) as any;

    const result = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, { run });

    expect(result.panelRequired).toBe(false);
    expect(result.verification).toBe("skip");
    expect(result.panelReport ?? null).toBeNull();
    expect(ranAgent).toBe(false); // the panel never ran -> no agent, no browser
    expect(attempt.panelReport).toBeUndefined();
  });

  test("mixed contract (command + live-critic) -> the deterministic slice is NOT in the panel's assertions; panelRequired true", async () => {
    const loom = makeLoom({
      version: 1,
      assertions: [
        a({ id: "c1", type: "command", expected: "bun test", description: "unit tests pass" }),
        a({ id: "lc", type: "live-critic", expected: undefined, observable: "confirmation visible", description: "checkout completes" }),
      ],
    });
    const attempt = pushAttempt(loom);
    const prompts: string[] = [];
    const run = (async (task: string) => {
      prompts.push(task);
      const m = task.match(/--- Your lens: (.+?) \(/);
      return { lens: m ? m[1]! : "unknown", ok: true, summary: "clean", findings: [], evidence: [] };
    }) as any;

    const result = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, { run });

    expect(result.panelRequired).toBe(true);
    expect(result.verification).toBe("pass");
    // Every critic prompt grounds in the live-critic assertion but NEVER the
    // deterministic command (it already settled as a gate; re-judging it by
    // prose is the bug Unit 4 closes).
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain("[lc]");
      expect(p).not.toContain("[c1]");
    }
  });
});
