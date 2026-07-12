// M10.2 coverage-invariant guard — the silent-coverage-drop (fail-open) hole.
//
// M10.2 makes a CHILD's `panelRequired` skip resolve to GREEN-with-note under the
// orchestratorVerify flag, on the promise that the relaxed criterion is re-proven
// at M10.1's top gate (`runIntegrationVerify` with `fullContract:true` over the
// ROOT's `contract.assertions`). That promise ONLY holds for a CONTRACT-BACKED
// child — one whose skip came from the contract-partition path, whose assertions
// are a `wireChildBundle` filtered slice of the root contract the top gate walks.
//
// A LEGACY / no-contract child reaches the SAME `{skip, panelRequired:true}` triple
// via the `verify()` null/throw fallback (executor.ts ~857/~881), where the relaxed
// criterion is the subGoal's PROSE `acceptanceCriteria` — NOT an assertion in any
// contract, so the top gate STRUCTURALLY cannot re-prove it. Relaxing it would drop
// coverage silently (fail-open). The fix gates the relaxation on `!!readContract`
// (`routedContract` at the call site). This file proves, over the REAL executeLoom,
// that the SAME decide() triple lands OPPOSITE terminals split only by contract
// presence: legacy ⇒ fail-closed needs-review; contract-backed ⇒ green-with-note.
//
// Hermetic: the Claude Agent SDK is mocked to an empty synthetic stream (mirrors
// verifier-mcp.test.ts) so the legacy `verify()` runs the REAL agent loop and
// returns null (no live model, no browser) — the exact null-report skip fallback.
import { afterAll, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock BEFORE importing executor so engine's `query` binds the empty-stream stub.
// An empty generator ⇒ agent() never receives an emit_result ⇒ returns null ⇒ the
// legacy verify() returns null ⇒ runVerification's {skip, panelRequired:true}.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool: () => ({}),
  createSdkMcpServer: (cfg: unknown) => cfg,
  query: () => (async function* () {})(),
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m102-cov-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
  delete process.env.TELAR_ORCHESTRATOR_VERIFY;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { executeLoom } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { writeContract, writeBundleFile } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
import { ProjectManifest } from "../src/schemas";
import type { VerificationContract, ContractAssertion } from "../src/schemas";

// A CONTRACT with an agent-judged (live-critic) assertion ⇒ partitionAssertions
// yields agentJudged.length > 0 ⇒ panelRequired true on the contract path.
const asrt = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});
const contractBackedContract: VerificationContract = {
  version: 1,
  assertions: [
    asrt({ id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok" }),
    asrt({ id: "lc", subGoalId: "s1", type: "live-critic", observable: "the UI shows the feature" }),
  ],
};

let pn = 0;
function makeProject(over: Record<string, unknown> = {}) {
  pn++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-m102cov-${pn}-`));
  const m = createProject(root, { name: `m102cov-${pn}` });
  const manifest = ProjectManifest.parse({ name: m.name, root, ...over });
  return { name: m.name, root, manifest };
}

// Drive the REAL executeLoom over a CHILD. `withContract` is the SOLE structural
// variable that must flip the terminal:
//   - withContract=true  ⇒ NO target; contract-partition path ⇒ {skip,panelRequired:true}
//   - withContract=false ⇒ target + prose acceptanceCriteria; legacy verify()→null
//                           ⇒ the IDENTICAL {skip,panelRequired:true} triple
// Both reach decide() with verdict.ok && verification==="skip" && panelRequired.
async function runChild(o: { flagOn: boolean; withContract: boolean; asRoot?: boolean }) {
  const { name, manifest, root } = makeProject({
    ...(o.flagOn ? { orchestratorVerify: true } : {}),
    // The legacy path needs a reachable target so verify() actually runs (else the
    // no-target early-return yields panelRequired:false, not the hole). The mocked
    // SDK makes verify() return null regardless of the URL — no real browser.
    ...(o.withContract ? {} : { urls: { dev: "http://127.0.0.1:9" } }),
  });
  const loom = createLoom({
    project: name,
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    ...(o.asRoot ? {} : { parentLoomId: "ROOT-COV", subGoalId: "s1" }),
    // Legacy child: prose acceptanceCriteria is the ONLY criterion (no contract).
    ...(o.withContract ? {} : { acceptanceCriteria: ["the feature works"] }),
  });
  writeBundleFile(loom.id, "objective.md", "obj");
  if (o.withContract) writeContract(loom.id, contractBackedContract);
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  await executeLoom(loom, manifest, {
    run: (async () => ({ ok: true, summary: "s", files_touched: [], blocker: null })) as any,
    maxAttempts: 1,
    onEvent: (e) => events.push(e),
    onState: () => {},
  });
  fs.rmSync(root, { recursive: true, force: true });
  const verifySummary = events.find((e) => e.type === "verify-summary");
  return { loom, events, verifySummary };
}

describe("M10.2 coverage invariant — advisory relaxation is CONTRACT-BACKED only (fail-open hole closed)", () => {
  test("(HOLE CLOSED) flag ON + LEGACY no-contract CHILD reaching the SAME {skip,panelRequired:true} triple stays fail-closed needs-review — its PROSE criterion is not in the root contract the top gate re-proves", async () => {
    const { loom, events, verifySummary } = await runChild({ flagOn: true, withContract: false });
    // Same decide() triple as the relaxed mainline: skip + panelRequired, verdict ok.
    expect(verifySummary?.verification).toBe("skip");
    expect(verifySummary?.panelRequired).toBe(true);
    // ...yet NOT relaxed: the legacy prose criterion is invisible to the top gate,
    // so the thread MUST keep gating it (fail-closed).
    expect(loom.state).toBe("needs-review");
    expect(loom.error).toBe("panel verification required but did not run");
    expect(events.some((e) => e.type === "thread-advisory")).toBe(false);
  });

  test("(mainline preserved) flag ON + CONTRACT-BACKED CHILD with the SAME triple STILL relaxes to green-with-note — its assertion is a wireChildBundle slice the top gate re-verifies", async () => {
    const { loom, events, verifySummary } = await runChild({ flagOn: true, withContract: true });
    expect(verifySummary?.verification).toBe("skip");
    expect(verifySummary?.panelRequired).toBe(true);
    expect(loom.state).toBe("done"); // relaxed
    expect(loom.error).toBeNull();
    const advisory = events.find((e) => e.type === "thread-advisory");
    expect(advisory).toBeTruthy();
    expect(advisory!.subGoalId).toBe("s1");
  });

  test("(flag OFF byte-identical) the LEGACY child lands needs-review with the flag OFF too — the flag still gates everything", async () => {
    const { loom, events } = await runChild({ flagOn: false, withContract: false });
    expect(loom.state).toBe("needs-review");
    expect(loom.error).toBe("panel verification required but did not run");
    expect(events.some((e) => e.type === "thread-advisory")).toBe(false);
  });

  test("(root-scoped unchanged) a LEGACY ROOT (no parentLoomId) is never relaxed regardless — its own fail-closed path stands", async () => {
    const { loom } = await runChild({ flagOn: true, withContract: false, asRoot: true });
    expect(loom.state).toBe("needs-review");
    expect(loom.error).toBe("panel verification required but did not run");
  });
});
