// Phase 1 — universal weave routing (weave-of-one). Every loom now runs through
// the weaver: a plain custom loom is given a deterministic single-subgoal
// charter and executed by exactly one child. This proves the load-bearing
// seams: the synthesized decomposition (G2 moat), acceptanceCriteria carried
// into the child (G3 verify-not-skipped), spawn-or-reuse with session
// continuity + no orphan across a steer (G4 session-resume), and reconcile
// marking only the root (G5 no double-strand). No live agent runs — runLoomFn
// is faked. NOTE (M1): a plain custom loom is no longer contractless — the
// dispatcher choke point synthesizes + persists a Verification Contract, so the
// child takes the panel path (G3 below) and the integration-verify producer can
// fire; the fake runLoomFn still never spins a real panel/agent.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-single-thread-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { singleThreadDecomposition, startLoom, steerLoom, reconcileStuckLooms } = await import("../src/dispatcher");
const { readContract } = await import("../src/bundle");
const { createLoom, getLoom, listChildLooms, saveLoom } = await import("../src/looms");
const { validateCharter } = await import("../src/scoping");
const { createProject } = await import("../src/manifest");

let n = 0;
function makeProject() {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-single-thread-proj-${n}-`));
  return createProject(root, { name: `single-thread-${n}` });
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A minimal in-memory Loom for the pure decomposition test — no disk, no agent.
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_1",
    project: "p",
    kind: "custom",
    title: "Add a health-check route",
    prompt: "Implement GET /healthz returning 200.",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
}

// A fake runner standing in for executeLoom: it records every child object the
// weaver hands it (so we can inspect reuse + session continuity), stamps a
// builder session on the FIRST run only, marks the child done, and persists it
// via the injected onState so a later re-dispatch reads the attempts back.
function captureRuns() {
  const seen: Loom[] = [];
  const runLoomFn = async (child: Loom, _manifest: unknown, opts: { onState?: (l: Loom) => void }) => {
    seen.push(child);
    if (child.attempts.length === 0) {
      child.attempts = [{ n: 1, role: "builder", model: "test-model", startedAt: Date.now(), sessionId: "sess-1" }];
    }
    child.state = "done";
    opts.onState?.(child); // persist via the dispatcher's saveLoom
    return child;
  };
  return { seen, runLoomFn };
}

describe("singleThreadDecomposition (G2 — the weave-of-one)", () => {
  test("yields exactly one required:true subgoal carrying the loom's fields", () => {
    const loom = fakeLoom({ acceptanceCriteria: ["returns 200", "no auth required"] });
    const d = singleThreadDecomposition(loom);

    expect(d.length).toBe(1);
    const sg = d[0]!;
    expect(sg.id).toBe("s1");
    expect(sg.title).toBe(loom.title);
    expect(sg.detail).toBe(loom.prompt); // -> child objective.md
    expect(sg.proofStrategy).toBe("custom"); // no charter -> "custom"
    expect(sg.acceptanceCriteria).toEqual(["returns 200", "no auth required"]); // CARRIED (blocker #2)
    expect(sg.dependsOn).toEqual([]);
    expect(sg.required).toBe(true); // moat: finish-loom gates on this
    expect(sg.status).toBe("pending");
  });

  test("defaults acceptanceCriteria to [] and honors a charter proofStrategy", () => {
    const loom = fakeLoom({
      acceptanceCriteria: undefined,
      charter: {
        objective: "o",
        proofStrategy: "quickfix",
        scope: { allowedPaths: [], forbiddenPaths: [] },
        budget: { maxParallelThreads: 1, maxAgents: 12, maxCriticAgents: 3 },
        decomposition: [],
        version: 1,
      },
    });
    const sg = singleThreadDecomposition(loom)[0]!;
    expect(sg.acceptanceCriteria).toEqual([]);
    expect(sg.proofStrategy).toBe("quickfix");
  });
});

describe("universal routing (weave-of-one) end-to-end", () => {
  test("G2/G3: a plain custom loom weaves-of-one — valid singleThread charter, criteria carried into the child", async () => {
    const m = makeProject();
    const { seen, runLoomFn } = captureRuns();
    const root = startLoom(
      {
        project: m.name,
        kind: "custom",
        title: "t",
        prompt: "do the thing",
        acceptanceCriteria: ["must do X"], // present -> fast path, no scoping LLM
      },
      { accounts: {}, runLoomFn: runLoomFn as never },
    );

    await waitFor(() => getLoom(root.id)?.state === "ready");

    // G2 — the synthesized charter is a REAL moat: singleThread, one required
    // subgoal, and it passes validateCharter.
    const charter = getLoom(root.id)!.charter!;
    expect(charter.singleThread).toBe(true);
    expect(charter.decomposition.length).toBe(1);
    expect(charter.decomposition[0]!.required).toBe(true);
    expect(validateCharter(charter).ok).toBe(true);

    // G3 (M1) — verification is NOT silently skipped, and the loom is no longer
    // contractless: the M1 choke point SYNTHESIZES a Verification Contract from
    // the root's prose acceptanceCriteria (one live-critic per criterion,
    // subGoalId:"ALL", synthesized:true) and PERSISTS it to the root. The
    // weave-of-one child inherits the ALL slice → its OWN synthesized
    // contract.json + contractRequired:true (the panel path), NOT the legacy
    // acceptanceCriteria degrade. Forcing a contract on every loom is the
    // explicit M1 invariant that replaces the pre-M1 contractless routing.
    expect(seen.length).toBe(1);
    const child = seen[0]!;
    expect(child.parentLoomId).toBe(root.id);
    expect(child.subGoalId).toBe("s1");
    expect(child.contractRequired).toBe(true); // panel path, not legacy degrade
    expect(child.acceptanceCriteria).toBeUndefined(); // no legacy degrade
    // The root carries the persisted synthesized contract...
    const rootContract = readContract(root.id).contract;
    expect(rootContract?.synthesized).toBe(true);
    expect(rootContract?.assertions).toEqual([
      { id: "synth-0", subGoalId: "ALL", description: "must do X", type: "live-critic", observable: "must do X", blocker: true },
    ]);
    // ...and the child's filtered slice is the same synthesized ALL assertion.
    const childContract = readContract(child.id).contract;
    expect(childContract?.synthesized).toBe(true);
    expect(childContract?.assertions.map((a) => a.id)).toEqual(["synth-0"]);
  });

  test("G4: steer reuses the SAME child (session continuity, no orphan) and refreshes its prompt", async () => {
    const m = makeProject();
    const { seen, runLoomFn } = captureRuns();
    const root = startLoom(
      { project: m.name, kind: "custom", title: "t", prompt: "base prompt", acceptanceCriteria: ["x"] },
      { accounts: {}, runLoomFn: runLoomFn as never },
    );

    await waitFor(() => getLoom(root.id)?.state === "ready");
    expect(seen.length).toBe(1);
    expect(seen[0]!.attempts.at(-1)?.sessionId).toBe("sess-1");

    // Steer: fold a directive into the loom and re-dispatch through the weaver.
    await steerLoom(root.id, "the special directive", "you", { accounts: {}, runLoomFn: runLoomFn as never });
    await waitFor(() => seen.length === 2);

    // No orphan — exactly one child under the root across both dispatches.
    expect(listChildLooms(root.id).length).toBe(1);
    // The SAME child object was reused (spawn-or-reuse keyed on (root, "s1")).
    expect(seen[1]!.id).toBe(seen[0]!.id);
    // Session continuity — the reused child still carries its first session, so
    // executeLoom resumes the prior builder session instead of starting fresh.
    expect(seen[1]!.attempts.at(-1)?.sessionId).toBe("sess-1");
    // The steer directive reached the reused child via ensureWoven's refresh.
    expect(seen[1]!.prompt).toContain("the special directive");

    // ensureWoven idempotency: still a single-subgoal weave-of-one, never a
    // real epic, and the id stayed "s1" so the reuse key held.
    const charter = getLoom(root.id)!.charter!;
    expect(charter.singleThread).toBe(true);
    expect(charter.decomposition.length).toBe(1);
    expect(charter.decomposition[0]!.id).toBe("s1");
    expect(charter.decomposition[0]!.detail).toContain("the special directive");
  });
});

describe("reconcileStuckLooms (G5 — root-only, no double-strand)", () => {
  test("marks only the stranded root failed; the in-flight child is left for the root's re-weave", () => {
    // Isolate the listLooms() walk in a fresh store so only our two looms exist.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "telar-single-thread-reconcile-"));
    process.env.TELAR_HOME = isolated;
    try {
      const rootLoom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      rootLoom.state = "running";
      saveLoom(rootLoom);

      const childLoom = createLoom({ project: "p", kind: "custom", title: "c", prompt: "y", account: "personal" });
      childLoom.state = "verifying";
      childLoom.parentLoomId = rootLoom.id;
      childLoom.subGoalId = "s1";
      saveLoom(childLoom);

      const reconciled = reconcileStuckLooms();

      // Only the root is stranded and marked failed.
      expect(getLoom(rootLoom.id)!.state).toBe("failed");
      expect(reconciled.map((r) => r.id)).toEqual([rootLoom.id]);

      // The child is untouched — it recovers via the root's re-weave (spawnChild
      // reuse), never independently. No doubled failed strand.
      expect(getLoom(childLoom.id)!.state).toBe("verifying");
      expect(reconciled.some((r) => r.id === childLoom.id)).toBe(false);
    } finally {
      process.env.TELAR_HOME = home;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});
