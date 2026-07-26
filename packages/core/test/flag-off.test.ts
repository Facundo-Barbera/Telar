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
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";
// ESM HOISTS AND EVALUATES every static import BEFORE the first top-level
// statement above it runs, so a static value import of ../src/weave would load
// weave.ts and its whole graph BEFORE the pin at :13 — the pin would only
// APPEAR to come first, and holds today solely because every state-root
// resolver happens to be lazy. `await import` evaluates HERE, after the pin,
// which makes the ordering real. weave.ts is the only import in this file that
// reaches the usage ledger, so it is the only one deferred; the `import type`
// lines are erased at runtime and stay static. Idiom: weave.test.ts (its two
// deferred `await import` lines for ../src/weave and ../src/looms, both placed
// after the same pin) and m11-blocked-propagation.test.ts (four deferred
// imports after its pin — that suite already used this idiom and was never
// broken). Cited by SYMBOL, not by line: the ":13" this comment used to carry
// was already off by one, because a line number names a slot in a file and any
// edit above it hands that slot to something else. Pinned at the source level by T30
// (orchestrator.test.ts).
const { runWeave } = await import("../src/weave");

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
