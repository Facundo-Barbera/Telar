// M4 — the plain runIntegrationVerify producer: a red verdict still demotes
// ready→needs-review, no repairHistory. (The DB-clone seam tests moved to
// db-clone-di.test.ts under the A3 de-flag.)
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// runWeave now appends a loom-owned line to the usage ledger as each child
// settles, so this suite MUST hold its own state root — unpinned it would
// write into the developer's real ~/.telar (weave.test.ts idiom).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-flag-off-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
import { runWeave } from "../src/weave";
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";

let n = 0;
function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  n++;
  return {
    id: `F${n}`,
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
function subGoal(id: string): SubGoal {
  return { id, title: id, detail: "d", proofStrategy: "custom", acceptanceCriteria: [], dependsOn: [], required: true, status: "pending" };
}

describe("the plain runIntegrationVerify path", () => {
  test("red integration verdict still demotes ready→needs-review; repairHistory absent", async () => {
    const root = fakeLoom();
    const out = await runWeave(root, [subGoal("s1")], {
      spawnChild: () => fakeLoom({ subGoalId: "s1", parentLoomId: root.id }),
      runChild: async (c) => ({ ...c, state: "done" }),
      // NO runAutoRepair injected (flag off) — only the plain producer.
      runIntegrationVerify: async () => ({ verification: "fail", gatesOk: false }),
    });
    expect(out.state).toBe("needs-review");
    expect(out.error).toBe("integration verification fail");
    expect(out.repairHistory).toBeUndefined();
  });

  test("pass keeps ready (unchanged)", async () => {
    const root = fakeLoom();
    const out = await runWeave(root, [subGoal("s1")], {
      spawnChild: () => fakeLoom({ subGoalId: "s1", parentLoomId: root.id }),
      runChild: async (c) => ({ ...c, state: "done" }),
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
    });
    expect(out.state).toBe("ready");
    expect(out.error).toBeNull();
    expect(out.repairHistory).toBeUndefined();
  });
});
