// M10.2 coverage-invariant guard — the silent-coverage-drop (fail-open) hole.
//
// M10.2 makes a CHILD's `panelRequired` skip resolve to GREEN-with-note, on the
// promise that the relaxed criterion is re-proven at M10.1's UNCONDITIONAL top
// gate (`runIntegrationVerify` with `fullContract:true` over the ROOT's
// `contract.assertions`). That promise ONLY holds for a CONTRACT-BACKED child —
// one whose skip came from the contract-partition path, whose assertions are a
// `wireChildBundle` filtered slice of the root contract the top gate walks.
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
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { executeLoom } = await import("../src/executor");
const { createLoom, getLoom, saveLoom } = await import("../src/looms");
import type { Loom } from "../src/looms";
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
async function runChild(o: { withContract: boolean; asRoot?: boolean; onState?: (l: Loom) => void }) {
  const { name, manifest, root } = makeProject({
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
    onState: o.onState ?? (() => {}),
  });
  fs.rmSync(root, { recursive: true, force: true });
  const verifySummary = events.find((e) => e.type === "verify-summary");
  return { loom, events, verifySummary };
}

describe("M10.2 coverage invariant — advisory relaxation is CONTRACT-BACKED only (fail-open hole closed)", () => {
  test("(HOLE CLOSED, L5) a LEGACY no-contract CHILD reaching {skip,panelRequired:true} ESCALATES (blocked), not the old fail-closed needs-review — a CHILD never waits for a human, and its prose criterion is still not relaxed to green", async () => {
    const { loom, events, verifySummary } = await runChild({ withContract: false });
    // Same decide() triple as the relaxed mainline: skip + panelRequired, verdict ok.
    expect(verifySummary?.verification).toBe("skip");
    expect(verifySummary?.panelRequired).toBe(true);
    // L5 (contract mandate 1) — NOT relaxed to green (no contract for the top gate to
    // re-prove) AND NOT parked human-gated: the child ESCALATES to the orchestrator
    // (blocked + lane-escalation), carrying the couldn't-verify cause.
    expect(loom.state).toBe("blocked");
    expect(loom.blockedReason).toContain("panel verification required but did not run");
    expect(events.some((e) => e.type === "lane-escalation")).toBe(true);
    expect(events.some((e) => e.type === "thread-advisory")).toBe(false);
  });

  test("(mainline) a CONTRACT-BACKED CHILD with the SAME triple relaxes to green-with-note — its assertion is a wireChildBundle slice the top gate re-verifies", async () => {
    const { loom, events, verifySummary } = await runChild({ withContract: true });
    expect(verifySummary?.verification).toBe("skip");
    expect(verifySummary?.panelRequired).toBe(true);
    expect(loom.state).toBe("done"); // relaxed
    expect(loom.error).toBeNull();
    const advisory = events.find((e) => e.type === "thread-advisory");
    expect(advisory).toBeTruthy();
    expect(advisory!.subGoalId).toBe("s1");
    // B1 (generalized COVERAGE INVARIANT) — the relaxation is now RECORDED
    // explicitly: the child stamps the exact agent-judged assertion id it stopped
    // gating so the top gate can independently re-prove it (never trusting an
    // implicit routedContract coupling). "lc" is the live-critic assertion; the
    // deterministic "g" gate already ran, so it is not relaxed.
    expect(loom.relaxedCoverage).toEqual([
      { kind: "panel-skip", assertionIds: ["lc"], note: expect.any(String) },
    ]);
  });

  test("(B1 PERSISTENCE PIN) the relaxedCoverage record reaches DISK — it is stamped BEFORE the terminal setState, so onState/saveLoom persists it to the child loom.json the top gate reads via listChildLooms", async () => {
    // The regression this guards: if the stamp ran AFTER setState(done), the
    // onState write would persist a record-LESS child (weave never re-saves the
    // returned loom) ⇒ the top gate's listChildLooms reads no relaxations ⇒
    // fail-OPEN. Driving the REAL executeLoom with the REAL saveLoom as onState
    // and reading the child back from disk proves the record survives the persist.
    const { loom } = await runChild({ withContract: true, onState: saveLoom });
    const onDisk = getLoom(loom.id);
    expect(onDisk?.relaxedCoverage).toEqual([
      { kind: "panel-skip", assertionIds: ["lc"], note: expect.any(String) },
    ]);
  });

  test("(root-scoped unchanged) a LEGACY ROOT (no parentLoomId) is never relaxed regardless — its own fail-closed path stands", async () => {
    const { loom } = await runChild({ withContract: false, asRoot: true });
    expect(loom.state).toBe("needs-review");
    expect(loom.error).toBe("panel verification required but did not run");
  });
});

// B1 (§70-72) — the ESCALATE posture over the REAL executeLoom. A per-thread
// VERIFICATION-shaped FAIL that exhausts the thread's mediation is NOT a terminal
// per-thread demote on a CHILD: it ESCALATES (parks `blocked`), so the weave lifts
// it to the orchestrator and B2 re-routes to mediation. Driven via a contract-miss
// (loom.contractRequired set, contract.json ABSENT) — runVerification returns
// {verification:"fail", panelRequired:true} without needing a live panel, the exact
// contract-miss the plan names. A ROOT keeps the fail-closed needs-review demote.
describe("B1 thread ESCALATE — a child's exhausted verification-fail parks blocked, never a terminal demote", () => {
  async function runContractMiss(o: { asRoot?: boolean }) {
    const { name, manifest, root } = makeProject();
    const loom = createLoom({
      project: name,
      kind: "custom",
      title: "t",
      prompt: "x",
      account: "personal",
      ...(o.asRoot ? {} : { parentLoomId: "ROOT-ESC", subGoalId: "s1" }),
    });
    loom.contractRequired = true; // required a contract to start…
    writeBundleFile(loom.id, "objective.md", "obj"); // …but NONE is written ⇒ contract-miss
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    await executeLoom(loom, manifest, {
      run: (async () => ({ ok: true, summary: "s", files_touched: [], blocker: null })) as any,
      maxAttempts: 1,
      onEvent: (e) => events.push(e),
      onState: () => {},
    });
    fs.rmSync(root, { recursive: true, force: true });
    return { loom, events };
  }

  test("(mainline) a CHILD contract-miss ESCALATES — parks blocked with an answerable question + a lane-escalation, never needs-review, never green", async () => {
    const { loom, events } = await runContractMiss({});
    expect(loom.state).toBe("blocked");
    expect(loom.blockedQuestion).toBeTruthy();
    expect(loom.blockedReason).toMatch(/Per-thread verification failed/);
    expect(events.some((e) => e.type === "lane-escalation" && e.reason === "thread-verify-exhausted")).toBe(true);
    // An escalation never promotes green and never relaxes coverage to the top gate.
    expect(loom.relaxedCoverage).toBeUndefined();
  });

  test("(root-scoped unchanged) a ROOT contract-miss keeps the fail-closed needs-review — its authoritative verify is the top gate, not an escalation", async () => {
    const { loom } = await runContractMiss({ asRoot: true });
    expect(loom.state).toBe("needs-review");
    expect(loom.state).not.toBe("blocked");
  });
});
