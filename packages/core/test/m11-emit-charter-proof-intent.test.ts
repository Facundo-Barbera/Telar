// M11.1 deliverable (a) — PERSIST proof intent (proofStrategy + proofHints)
// through the emit->charter assembly (docs/adaptive-verification.md §3.1).
// Repairs the loom_mrinlb18 evidence: a bundle loom whose weave-planner emits a
// VALID but NON-WOVEN charter (a greenfield/library one-workstream bundle → empty
// decomposition → isWoven=false) had its proofStrategy + proofHints DROPPED at two
// assembly seams — startLoomFromBundle's isWoven-guarded charter assign, and
// ensureWoven's weave-of-one rebuild. This proves the two fixes end-to-end through
// the real dispatcher (a faked planWeaveFn + runLoomFn — no LLM, no builder):
//   - the emitted non-woven charter's proofHints survive onto the persisted
//     weave-of-one charter (ensureWoven forwards them), a
//     `charter-proof-intent-captured` event is recorded, and the authored contract
//     is then TIGHTENED at the choke point (the live-critic whose id matches a hint
//     becomes a runnable command + a `contract-tightened` event fires)
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m11-emit-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createDraftLoom, startLoomFromBundle } = await import("../src/dispatcher");
const { getLoom, readEvents } = await import("../src/looms");
const { quickBundle, readContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");

const projRoots: string[] = [];
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of projRoots) fs.rmSync(r, { recursive: true, force: true });
});

function makeProject(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-m11-emit-${name}-`));
  projRoots.push(root);
  return createProject(root, { name });
}

// The weave-planner emits a VALID but NON-WOVEN charter (empty decomposition)
// that DOES carry proof intent — proofStrategy "verifier-criteria" + a
// per-criterion proofHint. This is exactly the loom_mrinlb18 shape whose hints
// were dropped before reaching the charter/derivation.
const fakePlanNonWovenWithHints = (async () => ({
  objective: "Ship the arithmetic library end-to-end",
  proofStrategy: "verifier-criteria",
  scope: { allowedPaths: [], forbiddenPaths: [] },
  budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
  decomposition: [],
  version: 1,
  proofHints: [{ criterion: "bun-test-suite-passes", run: "bun test" }],
})) as any;

// 15 s, the bound the engine suite's `eventually`/`until` helpers carry, under
// the 20 s bunfig ceiling: the predicate is one this test expects to become
// true, so a healthy run leaves as soon as it does and only a loaded runner
// ever spends the budget (#458).
async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// An AUTHORED bundle contract (bundle looms are contract-gated): one live-critic
// whose id matches the planner's proofHint criterion, plus a hard-gate command so
// the contract validates at quickBundle time.
function authoredContract() {
  return [
    { id: "bun-test-suite-passes", subGoalId: "ALL", description: "the bun test suite passes", type: "live-critic", observable: "the bun test suite passes", blocker: true },
    { id: "builds", subGoalId: "ALL", description: "the library builds", type: "command", expected: "bun run build", blocker: true },
  ] as any;
}

async function dispatchBundle(name: string) {
  const manifest = makeProject(name);
  const loom = createDraftLoom({ project: manifest.name, title: "lib", objective: "Ship the arithmetic library end-to-end" });
  quickBundle(loom.id, {
    objective: "Ship the arithmetic library end-to-end",
    assertions: authoredContract(),
    provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
  });

  let calls = 0;
  const fakeRunLoom = async (l: any) => {
    calls++;
    l.state = "done";
    return l;
  };

  await startLoomFromBundle(loom.id, "alice", {
    accounts: {},
    planWeaveFn: fakePlanNonWovenWithHints,
    runLoomFn: fakeRunLoom as any,
  });
  // Dispatch is deferred behind the (fake) planner + the async weave — wait until
  // the single weave-of-one child has actually run (past the choke point).
  await waitFor(() => calls >= 1);
  return loom.id;
}

describe("proof intent survives the emit->charter assembly and drives tightening", () => {
  test("the persisted weave-of-one charter carries the emitted proofHints and the contract is tightened", async () => {
    const id = await dispatchBundle("on");

    const persisted = getLoom(id)!;
    // The non-woven planner charter was captured (A1) and its hints forwarded
    // through the weave-of-one rebuild (A2).
    expect(persisted.charter?.proofHints).toEqual([{ criterion: "bun-test-suite-passes", run: "bun test" }]);
    // Still routed as a weave-of-one (ensureWoven built the single subgoal).
    expect(persisted.charter?.singleThread).toBe(true);
    expect(persisted.charter?.decomposition?.length).toBe(1);

    const { events } = readEvents(id);
    expect(events.some((e) => e.type === "charter-proof-intent-captured")).toBe(true);

    // The authored contract's live-critic (id == the hint criterion) was TIGHTENED
    // to a runnable command at the choke point, and persisted (readContract sees it).
    const { contract } = readContract(id);
    const tightened = contract!.assertions.find((a) => a.id === "bun-test-suite-passes")!;
    expect(tightened.type).toBe("command");
    expect(tightened.expected).toBe("bun test");
    expect(events.some((e) => e.type === "contract-tightened" && (e as any).assertionId === "bun-test-suite-passes")).toBe(true);
  });
});
