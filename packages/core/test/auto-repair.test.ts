// M4 — the WIRED auto-repair loop + frozen-lane seam tests. Everything is
// hermetic: a fake verify producer, a spy repair runner, an injected clock +
// budget, a fake git runner, and the FakeDbCloner. No real agent, no real git,
// no DB/network, no telar repo.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-autorepair-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { runAutoRepair, frozenLaneVerify } = await import("../src/verify-thread");
import type { AutoRepairDeps, IvResult } from "../src/verify-thread";
const { runWeave } = await import("../src/weave");
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";
import type { GitRunner } from "../src/vcs";
import { FakeDbCloner, NullDbCloner } from "../src/db-clone";
import type { BudgetState } from "../src/budget";

let n = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  n++;
  return {
    id: `L${n}`,
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

function iv(failing: string[], passing: string[] = [], verification?: string): IvResult {
  return {
    verification: verification ?? (failing.length ? "fail" : "pass"),
    gatesOk: failing.length === 0,
    failingIds: failing,
    passingIds: passing,
  };
}

// A verify producer that returns a scripted sequence of results, one per call.
function scriptedVerify(seq: (IvResult | null)[]) {
  let i = 0;
  const calls: number[] = [];
  const fn = async (_loom: Loom): Promise<IvResult | null> => {
    calls.push(++i);
    return seq[Math.min(i - 1, seq.length - 1)] ?? null;
  };
  return { fn, get callCount() { return i; } };
}

function baseDeps(over: Partial<AutoRepairDeps> = {}): AutoRepairDeps {
  return {
    verify: async () => iv([]),
    repair: async () => ({ costUsd: 0 }),
    budget: (): BudgetState => ({ maxAgents: 12, inFlight: 0, spentUsd: 0, startedAtMs: 0 }),
    caps: { maxRepairIterations: 3, estCostPerRepair: 0.5 },
    now: () => 1000,
    ...over,
  };
}

describe("runAutoRepair — the wired loop (fakes/spies)", () => {
  test("no ALL contract -> null, no repair, no history (no-op producer)", async () => {
    let repairs = 0;
    const loom = fakeLoom();
    const out = await runAutoRepair(loom, baseDeps({ verify: async () => null, repair: async () => (repairs++, { costUsd: 0 }) }));
    expect(out).toBeNull();
    expect(repairs).toBe(0);
    expect(loom.repairHistory).toBeUndefined();
  });

  test("B.11 converging reaches READY (moat: never done)", async () => {
    let repairs = 0;
    const verify = scriptedVerify([iv(["a", "b"]), iv(["a"], ["b"]), iv([], ["a", "b"], "pass")]);
    const loom = fakeLoom();
    const out = await runAutoRepair(
      loom,
      baseDeps({ verify: verify.fn, repair: async () => (repairs++, { costUsd: 0 }) }),
    );
    expect(out?.verification).toBe("pass");
    expect(repairs).toBe(2);
    expect(loom.error).toBeNull(); // no escalate reason set — stays ready
    expect(loom.repairHistory?.map((r) => r.verification)).toEqual(["fail", "fail", "pass"]);
  });

  test("B.9 never-converges hits the cap, no blowout", async () => {
    let repairs = 0;
    // strictly shrinking but never empty, large enough that the ITERATION cap
    // (3) binds before the strict-shrink bound (|F_0|=4).
    const verify = scriptedVerify([iv(["a", "b", "c", "d"]), iv(["a", "b", "c"]), iv(["a", "b"]), iv(["a"]), iv(["a"])]);
    const loom = fakeLoom();
    const out = await runAutoRepair(loom, baseDeps({ verify: verify.fn, repair: async () => (repairs++, { costUsd: 0 }) }));
    expect(repairs).toBe(3); // exactly maxRepairIterations — NOT infinite
    expect(loom.error).toBe("max repair iterations");
    expect(out?.verification).toBe("fail");
  });

  test("B.10 oscillator halts EARLY via regression (not to the cap)", async () => {
    let repairs = 0;
    const verify = scriptedVerify([iv(["a"], ["b"]), iv(["b"], ["a"])]);
    const loom = fakeLoom();
    await runAutoRepair(loom, baseDeps({ verify: verify.fn, repair: async () => (repairs++, { costUsd: 0 }) }));
    expect(repairs).toBe(1); // one repair, then the regression is caught
    expect(loom.error).toBe("regression: b");
  });

  test("B.12 budget blowout prevented — loop stops at the budget bound", async () => {
    let repairs = 0;
    const verify = scriptedVerify([iv(["a", "b", "c"]), iv(["a", "b"]), iv(["a"]), iv([])]);
    const loom = fakeLoom();
    // budget reads the recorded repair spend; each repair costs 0.5, cap $1.
    const budget = (): BudgetState => ({
      maxAgents: 12,
      inFlight: 0,
      spentUsd: (loom.repairHistory ?? []).reduce((s, r) => s + r.costUsd, 0),
      startedAtMs: 0,
      maxCostUsd: 1,
    });
    await runAutoRepair(
      loom,
      baseDeps({ verify: verify.fn, repair: async () => (repairs++, { costUsd: 0.5 }), budget, caps: { maxRepairIterations: 10, estCostPerRepair: 0.5 } }),
    );
    expect(repairs).toBe(2); // 2 repairs -> spent $1 -> no headroom for a 3rd
    expect(loom.error).toBe("budget exhausted");
  });

  test("history costUsd accumulates onto repairHistory (budget accounting is honest)", async () => {
    const verify = scriptedVerify([iv(["a", "b"]), iv(["a"]), iv([])]);
    const loom = fakeLoom();
    await runAutoRepair(loom, baseDeps({ verify: verify.fn, repair: async () => ({ costUsd: 0.3 }) }));
    expect(loom.repairHistory?.map((r) => r.costUsd)).toEqual([0, 0.3, 0.3]); // round 1 = initial verify, cost 0
  });
});

// --- C.13 moat: never done, only ready/needs-review, through the REAL weave ---

function subGoal(id: string): SubGoal {
  return { id, title: id, detail: "d", proofStrategy: "custom", acceptanceCriteria: [], dependsOn: [], required: true, status: "pending" };
}

async function weaveWith(finalVerify: (IvResult | null)[], repairCost = 0): Promise<Loom> {
  const root = fakeLoom({ id: `root${n}`, state: "queued" });
  const child = fakeLoom({ subGoalId: "s1", parentLoomId: root.id, state: "queued" });
  const verify = scriptedVerify(finalVerify);
  return runWeave(root, [subGoal("s1")], {
    spawnChild: () => child,
    runChild: async (c) => ({ ...c, state: "done" }),
    runAutoRepair: (l) =>
      runAutoRepair(l, baseDeps({ verify: verify.fn, repair: async () => ({ costUsd: repairCost }) })),
  });
}

describe("moat — the woven root only ever lands ready/needs-review, never done", () => {
  test("converged weave stays READY", async () => {
    const out = await weaveWith([iv(["a"]), iv([], ["a"], "pass")]);
    expect(out.state).toBe("ready");
  });

  test("escalated weave demotes to NEEDS-REVIEW with the guard reason", async () => {
    const out = await weaveWith([iv(["a"]), iv(["a"])]); // plateau -> no progress
    expect(out.state).toBe("needs-review");
    expect(out.error).toBe("no progress");
  });

  test("across converge + escalate paths, state is NEVER done", async () => {
    for (const seq of [
      [iv([], [], "pass")],
      [iv(["a"]), iv([], ["a"], "pass")],
      [iv(["a"]), iv(["a"])],
      [iv(["a"], ["b"]), iv(["b"], ["a"])],
    ]) {
      const out = await weaveWith(seq);
      expect(["ready", "needs-review"]).toContain(out.state);
      expect(out.state).not.toBe("done");
    }
  });
});

// --- C.14 / C.15 frozen-lane seam: DB clone mocked, verify read-only vs a snapshot ---

function fakeGit(): { runner: GitRunner; args: string[][] } {
  const args: string[][] = [];
  const runner: GitRunner = (_root, a) => {
    args.push(a);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, args };
}

const manifest = { root: "/telar/fake-root", urls: { dev: "http://root-dev" } } as any;

describe("frozenLaneVerify — frozen snapshot + injectable DB clone", () => {
  test("C.14 FakeDbCloner: clone(templateDb,id) once, drop once; verify runs against a frozen worktree (not root)", async () => {
    const git = fakeGit();
    const cloner = new FakeDbCloner();
    let captured: any = null;
    const loom = fakeLoom({ baseSha: "deadbeef" });
    const out = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => {
        captured = o;
        return iv([]);
      },
      git: git.runner,
      dbCloner: cloner,
      templateDb: "telar_template",
      resolveServersConfig: () => ({ version: 1, driver: "none", services: {} }) as any,
    });
    expect(out?.verification).toBe("pass");
    // DB clone is a mocked seam — exactly one clone/drop pair, no real Postgres.
    expect(cloner.cloned).toHaveLength(1);
    expect(cloner.cloned[0]).toMatchObject({ templateDb: "telar_template", snapshotId: loom.id });
    expect(cloner.dropped).toHaveLength(1);
    // C.15 read-only: verify ran against a FROZEN worktree, not manifest.root.
    expect(captured.verifyCwd).toBeTruthy();
    expect(captured.verifyCwd).not.toBe(manifest.root);
    expect(path.basename(captured.verifyCwd)).toContain("telar-wt-frozen-");
    // No lane (driver none) -> target falls back to the static dev url.
    expect(captured.url).toBe("http://root-dev");
    // Worktree was added AND removed (crash-safe cleanup in finally).
    const flat = git.args.map((a) => a.join(" "));
    expect(flat.some((s) => s.startsWith("worktree add"))).toBe(true);
    expect(flat.some((s) => s.startsWith("worktree remove"))).toBe(true);
  });

  test("C.14 NullDbCloner injects NO DATABASE_URL into the lane env", async () => {
    const git = fakeGit();
    let laneEnv: NodeJS.ProcessEnv | undefined;
    const loom = fakeLoom({ baseSha: "deadbeef" });
    await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async () => iv([]),
      git: git.runner,
      dbCloner: new NullDbCloner(),
      resolveServersConfig: () => ({ version: 1, driver: "host-process", services: { app: {} } }) as any,
      startLane: async (_cfg, _root, o) => {
        laneEnv = o?.env;
        return { services: { app: { name: "app", port: 1, url: "http://lane", stop: async () => {} } }, stopAll: async () => {} };
      },
    });
    expect(laneEnv?.DATABASE_URL).toBeUndefined();
  });

  test("FakeDbCloner MERGES the ephemeral DATABASE_URL into the lane env, target = lane url", async () => {
    const git = fakeGit();
    const cloner = new FakeDbCloner();
    let laneEnv: NodeJS.ProcessEnv | undefined;
    let stopped = false;
    let captured: any = null;
    const loom = fakeLoom({ baseSha: "deadbeef" });
    await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), iv([])),
      git: git.runner,
      dbCloner: cloner,
      baseEnv: { EXISTING: "1" },
      resolveServersConfig: () => ({ version: 1, driver: "host-process", services: { app: {} } }) as any,
      startLane: async (_cfg, _root, o) => {
        laneEnv = o?.env;
        return { services: { app: { name: "app", port: 1, url: "http://lane-app", stop: async () => {} } }, stopAll: async () => (stopped = true, undefined) };
      },
    });
    expect(laneEnv?.DATABASE_URL).toBe(cloner.cloned[0]!.url);
    expect(laneEnv?.EXISTING).toBe("1"); // base env preserved
    expect(captured.url).toBe("http://lane-app"); // verify drove the lane, not the static url
    expect(stopped).toBe(true); // lane torn down
    expect(cloner.dropped).toHaveLength(1); // ephemeral DB dropped
  });

  test("no baseSha -> degrades to verifying against the shared root (still read-only), no worktree/clone", async () => {
    const git = fakeGit();
    const cloner = new FakeDbCloner();
    let captured: any = null;
    const loom = fakeLoom(); // no baseSha
    await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), iv([])),
      git: git.runner,
      dbCloner: cloner,
    });
    expect(git.args).toHaveLength(0); // no worktree machinery
    expect(cloner.cloned).toHaveLength(0);
    expect(captured.verifyCwd).toBeUndefined(); // producer defaults to manifest.root
  });
});

// --- checkpoints: best-effort per-subGoal verify on child fold ---

describe("checkpoints — best-effort, non-blocking, informational", () => {
  test("runCheckpoint fires once per DONE child; rollup state is unaffected", async () => {
    const root = fakeLoom({ state: "queued" });
    const checkpointed: string[] = [];
    const out = await runWeave(root, [subGoal("s1"), subGoal("s2")], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, parentLoomId: root.id }),
      runChild: async (c) => ({ ...c, state: "done" }),
      runCheckpoint: async (child) => {
        checkpointed.push(child.subGoalId!);
      },
    });
    expect(out.state).toBe("ready");
    expect(checkpointed.sort()).toEqual(["s1", "s2"]);
  });

  test("a non-done child is NOT checkpointed", async () => {
    const root = fakeLoom();
    let calls = 0;
    await runWeave(root, [subGoal("s1")], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, parentLoomId: root.id }),
      runChild: async (c) => ({ ...c, state: "failed" }),
      runCheckpoint: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
  });

  test("a throwing checkpoint never breaks the weave (best-effort)", async () => {
    const root = fakeLoom();
    const out = await runWeave(root, [subGoal("s1")], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, parentLoomId: root.id }),
      runChild: async (c) => ({ ...c, state: "done" }),
      runCheckpoint: async () => {
        throw new Error("checkpoint boom");
      },
    });
    expect(out.state).toBe("ready");
  });
});
