import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-weave-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { rollupWeave, runWeave } = await import("../src/weave");
const { createLoom, listChildLooms, saveLoom, getLoom } = await import("../src/looms");
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Minimal fake Loom builder for pure roll-up / scheduler tests — no disk, no agent.
let fakeN = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  fakeN++;
  return {
    id: `fake_${fakeN}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
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

describe("rollupWeave (pure)", () => {
  test("all required children done -> ready (§A: the root loom is the thing the owner accepts)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "done" }),
    ];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "ready" });
  });

  test("a required child failed -> failed", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "failed" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("failed");
    expect(r.error).toBe("s2: failed");
  });

  test("a required child needs-review -> needs-review", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "needs-review" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("needs-review");
    expect(r.error).toBe("s2: not done");
  });

  test("a non-required subgoal's child failed while all required done -> ready", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "failed" }),
    ];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "ready" });
  });

  test("a required subgoal with no child -> needs-review", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [fakeLoom({ subGoalId: "s1", state: "done" })];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("needs-review");
    expect(r.error).toBe("s2: not done");
  });
});

describe("runWeave (fakes, no disk/agents)", () => {
  test("folds up to ready (§A) with two independent subgoals; children isolated from the root object", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const spawnedSubGoalIds: string[] = [];

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => {
        spawnedSubGoalIds.push(sg.id);
        return fakeLoom({ subGoalId: sg.id, state: "queued" });
      },
      runChild: async (child) => {
        child.state = "done";
        return child;
      },
    });

    expect(result.state).toBe("ready");
    expect(spawnedSubGoalIds.sort()).toEqual(["s1", "s2"]);
    // Isolation at the object level: the root doesn't embed child attempts/states.
    expect((result as unknown as Record<string, unknown>).children).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).threads).toBeUndefined();
    expect(result.attempts).toEqual([]);
  });

  test("a required child's failure fails the root", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = child.subGoalId === "s2" ? "failed" : "done";
        return child;
      },
    });

    expect(result.state).toBe("failed");
  });

  test("respects dependsOn ordering across waves", async () => {
    const decomposition = [subGoal({ id: "a" }), subGoal({ id: "b", dependsOn: ["a"] })];
    const root = fakeLoom();
    const order: string[] = [];

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        order.push(child.subGoalId!);
        child.state = "done";
        return child;
      },
    });

    expect(result.state).toBe("ready");
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });
});

describe("write isolation (real TELAR_HOME)", () => {
  test("root and child each get their own loom.json; listChildLooms scopes correctly; parent embeds no child data", () => {
    const root = createLoom({ project: "p", kind: "custom", title: "root", prompt: "x", account: "personal" });
    const child = createLoom({
      project: "p",
      kind: "quickfix",
      title: "child",
      prompt: "y",
      account: "personal",
      parentLoomId: root.id,
      subGoalId: "s1",
    });
    saveLoom(root);
    saveLoom(child);

    const rootFile = path.join(home, "looms", root.id, "loom.json");
    const childFile = path.join(home, "looms", child.id, "loom.json");
    expect(fs.existsSync(rootFile)).toBe(true);
    expect(fs.existsSync(childFile)).toBe(true);
    expect(rootFile).not.toBe(childFile);

    const children = listChildLooms(root.id);
    expect(children.map((c) => c.id)).toEqual([child.id]);

    const onDisk = JSON.parse(fs.readFileSync(rootFile, "utf8"));
    expect(onDisk.children).toBeUndefined();
    expect(onDisk.threads).toBeUndefined();
    expect(onDisk.attempts).toEqual([]);

    expect(getLoom(root.id)!.parentLoomId).toBeUndefined();
    expect(getLoom(child.id)!.parentLoomId).toBe(root.id);
  });
});
