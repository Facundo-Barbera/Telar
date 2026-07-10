import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, ContractAssertion, ProjectManifest, SubGoal } from "../src/schemas";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-weave-planner-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { createDraftLoom, startLoomFromBundle } = await import("../src/dispatcher");
const { getLoom, listChildLooms, readEvents } = await import("../src/looms");
const { quickBundle, readBundleFile, readContract, writeBundleFile } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
const { planWeaveFromBundle } = await import("../src/scoping");
const { isWoven } = await import("../src/schemas");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function makeProject(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-weave-planner-${name}-`));
  return createProject(root, { name });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function subGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: overrides.id ?? "s1",
    title: "title",
    detail: "detail",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...overrides,
  };
}

// A bundle whose contract carries four distinct workstream subGoalIds plus one
// cross-cutting ("ALL") assertion — the exact grounding planWeaveFromBundle
// partitions by (values like W1-109, mirroring real contract.json).
const WORKSTREAM_ASSERTIONS: ContractAssertion[] = [
  { id: "a1", subGoalId: "W1-109", description: "w1 done", type: "contains", expected: "x1", blocker: true },
  { id: "a2", subGoalId: "W2-112", description: "w2 done", type: "contains", expected: "x2", blocker: true },
  { id: "a3", subGoalId: "W3-201", description: "w3 done", type: "value-equality", expected: "x3", blocker: true },
  { id: "a4", subGoalId: "W4-305", description: "w4 done", type: "value-equality", expected: "x4", blocker: true },
  { id: "a5", subGoalId: "ALL", description: "cross-cutting", type: "contains", expected: "xall", blocker: true },
];

const WORKSTREAM_IDS = ["W1-109", "W2-112", "W3-201", "W4-305"];

// A root context file (not contract.json / objective.md) that wireChildBundle
// must copy verbatim into every Thread's own bundle.
const ROADMAP_CONTENT = "W1-109 before W2-112; W3-201 before W4-305.";

// The canned 4-node charter the injected planner returns (one SubGoal per
// distinct non-ALL subGoalId, ids reused verbatim).
function cannedFourNodeCharter(): Charter {
  return {
    objective: "Deliver the four workstreams",
    proofStrategy: "verifier-criteria",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
    decomposition: WORKSTREAM_IDS.map((id) =>
      subGoal({ id, title: `build ${id}`, detail: `build ${id}`, acceptanceCriteria: [`${id} works`] }),
    ),
    version: 1,
  };
}

// A contract that mixes a critic-only workstream with a hard-gated one. W1's
// ONLY assertion is live-critic (its filtered child slice has no falsifiable
// hard gate -> wireChildBundle degrades it), while W2 keeps a non-live-critic
// assertion so the ROOT contract still validates. No "ALL" assertion, so W1's
// slice stays all-live-critic.
const MIXED_ASSERTIONS: ContractAssertion[] = [
  { id: "lc1", subGoalId: "W1", description: "W1 is subjectively good", type: "live-critic", observable: "W1 behavior", blocker: true },
  { id: "hg2", subGoalId: "W2", description: "W2 done", type: "contains", expected: "x2", blocker: true },
];

// The canned 2-node charter for MIXED_ASSERTIONS: one SubGoal per workstream,
// each carrying legacy acceptanceCriteria the degrade path falls back to.
function cannedTwoNodeMixedCharter(): Charter {
  return {
    objective: "Deliver two workstreams",
    proofStrategy: "verifier-criteria",
    scope: { allowedPaths: [], forbiddenPaths: [] },
    budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
    decomposition: [
      subGoal({ id: "W1", title: "build W1", detail: "build W1", acceptanceCriteria: ["W1 works"] }),
      subGoal({ id: "W2", title: "build W2", detail: "build W2", acceptanceCriteria: ["W2 works"] }),
    ],
    version: 1,
  };
}

const fakeManifest: ProjectManifest = {
  name: "p",
  root: "/tmp/telar-weave-planner-fake-root",
  adapter: "plain",
  account: "personal",
  baseBranch: "main",
  gates: [],
  guardrails: { disallowedTools: [], protectedPaths: [] },
  charterPolicy: "human-required-for-epics",
  mcpServers: {},
};

// Drives startLoomFromBundle end-to-end with an injected planner (canned
// 4-node charter) and an injected child runner (flips each Thread to done).
async function runWovenBundle(name: string) {
  const manifest = makeProject(name);
  const objective = "Deliver the four public-API workstreams end to end.";
  const loom = createDraftLoom({ project: manifest.name, title: "t", objective });
  quickBundle(loom.id, {
    objective,
    assertions: WORKSTREAM_ASSERTIONS,
    provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
  });
  // Root context file — must be copied into every child's bundle (§2).
  writeBundleFile(loom.id, "roadmap.md", ROADMAP_CONTENT);

  let childCalls = 0;
  const fakeRunChild = async (l: any) => {
    childCalls++;
    l.state = "done";
    return l;
  };

  await startLoomFromBundle(loom.id, "alice", {
    accounts: {},
    planWeaveFn: (async () => cannedFourNodeCharter()) as any,
    runLoomFn: fakeRunChild as any,
  });
  await waitFor(() => getLoom(loom.id)?.state === "ready");
  return { loomId: loom.id, childCalls: () => childCalls };
}

describe("startLoomFromBundle — auto-weave (woven charter)", () => {
  test("assigns the planner's decomposition, fans out to N Threads, rolls up to ready", async () => {
    const { loomId, childCalls } = await runWovenBundle("woven-fanout");

    const root = getLoom(loomId)!;
    expect(root.state).toBe("ready");
    expect(root.charter!.decomposition.length).toBe(4);
    expect(root.charter!.approvedBy).toBe("auto:weave-planner");
    expect(childCalls()).toBe(4);

    const children = listChildLooms(loomId);
    expect(children.length).toBe(4);
    expect(children.map((c) => c.subGoalId).sort()).toEqual(WORKSTREAM_IDS);

    const { events } = readEvents(loomId);
    expect(events.some((e) => e.type === "charter-approved" && e.by === "auto:weave-planner")).toBe(true);
    expect(events.filter((e) => e.type === "weave-child-spawned").length).toBe(4);
    expect(events.some((e) => e.type === "weave-rollup")).toBe(true);
  });

  test("each Thread gets ONLY its own subGoalId (+ ALL) assertions, contractRequired sticky", async () => {
    const { loomId } = await runWovenBundle("woven-per-thread-contract");

    const children = listChildLooms(loomId);
    for (const child of children) {
      expect(child.contractRequired).toBe(true);

      const { contract, errors } = readContract(child.id);
      expect(errors).toEqual([]);
      expect(contract).not.toBeNull();

      const ids = contract!.assertions.map((a) => a.id).sort();
      // its own workstream assertion + the cross-cutting a5 (ALL) — nothing else.
      const own = WORKSTREAM_ASSERTIONS.find((a) => a.subGoalId === child.subGoalId)!;
      expect(ids).toEqual([own.id, "a5"].sort());
      // no OTHER workstream's assertion leaked in
      const foreign = WORKSTREAM_ASSERTIONS.filter(
        (a) => a.subGoalId !== child.subGoalId && a.subGoalId !== "ALL",
      ).map((a) => a.id);
      for (const f of foreign) expect(ids).not.toContain(f);
    }
  });

  test("each Thread's bundle narrows objective.md to its SubGoal and copies root context in", async () => {
    const { loomId } = await runWovenBundle("woven-context-copy");

    const charter = getLoom(loomId)!.charter!;
    const children = listChildLooms(loomId);
    expect(children.length).toBe(4);
    for (const child of children) {
      const sg = charter.decomposition.find((s) => s.id === child.subGoalId)!;
      // objective.md narrowed to this SubGoal's detail (never the root objective)
      expect(readBundleFile(child.id, "objective.md")).toBe(sg.detail);
      // the root's other context files copied in verbatim
      expect(readBundleFile(child.id, "roadmap.md")).toBe(ROADMAP_CONTENT);
    }
  });
});

describe("startLoomFromBundle — per-Thread contract degradation", () => {
  test("a Thread whose only slice assertion is live-critic degrades to the legacy acceptanceCriteria path", async () => {
    const manifest = makeProject("woven-degrade");
    const objective = "Deliver one critic-only and one hard-gated workstream.";
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective });
    quickBundle(loom.id, {
      objective,
      assertions: MIXED_ASSERTIONS,
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    const fakeRunChild = async (l: any) => {
      l.state = "done";
      return l;
    };

    await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: (async () => cannedTwoNodeMixedCharter()) as any,
      runLoomFn: fakeRunChild as any,
    });
    await waitFor(() => getLoom(loom.id)?.state === "ready");

    const children = listChildLooms(loom.id);
    const w1 = children.find((c) => c.subGoalId === "W1")!;
    const w2 = children.find((c) => c.subGoalId === "W2")!;
    const w1Sg = cannedTwoNodeMixedCharter().decomposition.find((s) => s.id === "W1")!;

    // Degraded child: no contract.json written (readContract null + errors),
    // contractRequired never set, falls back to the SubGoal's acceptanceCriteria.
    const w1Read = readContract(w1.id);
    expect(w1Read.contract).toBeNull();
    expect(w1Read.errors.length).toBeGreaterThan(0);
    expect(w1.contractRequired).not.toBe(true);
    expect(w1.acceptanceCriteria).toEqual(w1Sg.acceptanceCriteria);

    // The hard-gated sibling still gets its own filtered slice + sticky flag.
    expect(w2.contractRequired).toBe(true);
    const w2Read = readContract(w2.id);
    expect(w2Read.errors).toEqual([]);
    expect(w2Read.contract!.assertions.map((a) => a.id)).toEqual(["hg2"]);
  });
});

describe("startLoomFromBundle — fallback (non-weaving charter)", () => {
  test("an empty decomposition leaves the loom non-woven and runs a single builder on the root", async () => {
    const manifest = makeProject("fallback-single");
    const objective = "Add a Retry-After header to every 429 response.";
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective });
    quickBundle(loom.id, {
      objective,
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    let calls = 0;
    const fakeRun = async (l: any) => {
      calls++;
      l.state = "done";
      return l;
    };

    const emptyCharter: Charter = {
      objective,
      proofStrategy: "verifier-criteria",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
      decomposition: [],
      version: 1,
    };

    await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: (async () => emptyCharter) as any,
      runLoomFn: fakeRun as any,
    });
    await waitFor(() => calls === 1);

    expect(calls).toBe(1); // one builder attempt on the root, not a fan-out
    const root = getLoom(loom.id)!;
    expect(root.charter).toBeUndefined(); // non-weaving -> charter never assigned
    expect(isWoven(root)).toBe(false);
    expect(listChildLooms(loom.id).length).toBe(0); // no Threads spawned
  });

  test("a planner that THROWS degrades to a single builder on the root", async () => {
    const manifest = makeProject("fallback-throws");
    const objective = "Add a Retry-After header to every 429 response.";
    const loom = createDraftLoom({ project: manifest.name, title: "t", objective });
    quickBundle(loom.id, {
      objective,
      assertions: [{ id: "a1", description: "checks x", type: "contains", expected: "hi", blocker: true }],
      provenance: { approvedBy: "planner-session", humanApprovedAt: Date.now() },
    });

    let calls = 0;
    const fakeRun = async (l: any) => {
      calls++;
      l.state = "done";
      return l;
    };

    await startLoomFromBundle(loom.id, "alice", {
      accounts: {},
      planWeaveFn: (async () => {
        throw new Error("boom");
      }) as any,
      runLoomFn: fakeRun as any,
    });
    await waitFor(() => calls === 1);

    expect(calls).toBe(1); // one builder attempt on the root, not a fan-out
    const root = getLoom(loom.id)!;
    expect(root.charter).toBeUndefined(); // planner threw -> charter never assigned
    expect(isWoven(root)).toBe(false);
    expect(listChildLooms(loom.id).length).toBe(0); // no Threads spawned
  });
});

describe("planWeaveFromBundle (injected fake agent, no live model)", () => {
  test("read-only lockdown + one workstream per distinct non-ALL subGoalId in the prompt", async () => {
    const canned = cannedFourNodeCharter();
    let captured: { prompt: string; opts: any } | null = null;
    const fakeAgent = (async (promptText: string, opts: any) => {
      captured = { prompt: promptText, opts };
      return canned;
    }) as unknown as typeof import("../src/engine").agent;

    const result = await planWeaveFromBundle(
      {
        loomId: "loom_unit",
        objective: "Deliver the four workstreams",
        bundleFiles: [
          { path: "objective.md", contents: "Deliver the four workstreams" },
          { path: "roadmap.md", contents: "W1-109 before W2-112" },
        ],
        contract: { version: 1, assertions: WORKSTREAM_ASSERTIONS },
        manifest: fakeManifest,
      },
      { agent: fakeAgent },
    );

    expect(result).toEqual(canned);
    expect(captured).not.toBeNull();

    // read-only lockdown, mirrored VERBATIM from draftCharter
    expect(captured!.opts.restrictTools).toBe(true);
    expect(captured!.opts.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(captured!.opts.tools).not.toContain("Write");
    expect(captured!.opts.tools).not.toContain("Edit");
    expect(captured!.opts.tools).not.toContain("Bash");
    expect(captured!.opts.disallowedTools).toContain("Write");
    expect(captured!.opts.disallowedTools).toContain("Edit");
    expect(captured!.opts.disallowedTools).toContain("Bash");
    expect(captured!.opts.settingSources).toEqual([]);
    expect(captured!.opts.cwd).toBe(fakeManifest.root);

    // one workstream per distinct non-ALL subGoalId; ALL never becomes its own node
    for (const id of WORKSTREAM_IDS) expect(captured!.prompt).toContain(id);
    expect(captured!.prompt).not.toContain("- ALL:");
  });

  test("NEVER throws — a null model result degrades to a minimal non-weaving charter", async () => {
    const fallback = await planWeaveFromBundle(
      {
        loomId: "loom_unit_null",
        objective: "do the atomic thing",
        bundleFiles: [],
        contract: { version: 1, assertions: WORKSTREAM_ASSERTIONS },
        manifest: fakeManifest,
      },
      { agent: (async () => null) as any },
    );

    expect(isWoven(fallback)).toBe(false);
    expect(fallback.objective).toBe("do the atomic thing");
  });
});
