// M4 — flag-off byte-identity + the flag/seam primitives. With autoRepair off
// and TELAR_AUTO_REPAIR unset, no new code path executes: the plain
// runIntegrationVerify producer runs exactly as pre-M4 (a red verdict still
// demotes ready→needs-review, no repairHistory). Also pins the flag helpers and
// the DB-clone seam (no real Postgres — LiveDbCloner refuses to construct
// unless explicitly armed).
import { afterEach, describe, expect, test } from "bun:test";
import { autoRepairEnabled, liveDbCloneArmed } from "../src/vcs";
import { FakeDbCloner, LiveDbCloner, NullDbCloner, resolveDbCloner } from "../src/db-clone";
import { runWeave } from "../src/weave";
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";

afterEach(() => {
  delete process.env.TELAR_AUTO_REPAIR;
  delete process.env.TELAR_FROZEN_LANE_DB;
});

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

describe("flag helpers", () => {
  test("autoRepairEnabled is false by default; honors manifest flag + env override", () => {
    delete process.env.TELAR_AUTO_REPAIR;
    expect(autoRepairEnabled({})).toBe(false);
    expect(autoRepairEnabled({ autoRepair: false })).toBe(false);
    expect(autoRepairEnabled({ autoRepair: true })).toBe(true);
    process.env.TELAR_AUTO_REPAIR = "1";
    expect(autoRepairEnabled({})).toBe(true);
  });

  test("liveDbCloneArmed is false unless TELAR_FROZEN_LANE_DB=1", () => {
    delete process.env.TELAR_FROZEN_LANE_DB;
    expect(liveDbCloneArmed()).toBe(false);
    process.env.TELAR_FROZEN_LANE_DB = "1";
    expect(liveDbCloneArmed()).toBe(true);
  });
});

describe("DB-clone seam — mocked in tests, live impl gated", () => {
  test("NullDbCloner clones nothing (no DATABASE_URL override)", async () => {
    const c = new NullDbCloner();
    expect(await c.clone("t", "id")).toBe("");
    await c.drop("x"); // no-op, no throw
  });

  test("FakeDbCloner scripts a url and records the drop", async () => {
    const c = new FakeDbCloner();
    const url = await c.clone("tmpl", "L1");
    expect(url).toBe("postgres://fake/telar_frozen_L1");
    await c.drop(url);
    expect(c.dropped).toEqual([url]);
  });

  test("LiveDbCloner REFUSES to construct unless armed (no blind real-Postgres code)", () => {
    delete process.env.TELAR_FROZEN_LANE_DB;
    expect(() => new LiveDbCloner()).toThrow(/TELAR_FROZEN_LANE_DB/);
  });

  test("resolveDbCloner returns NullDbCloner when not armed", () => {
    delete process.env.TELAR_FROZEN_LANE_DB;
    expect(resolveDbCloner()).toBeInstanceOf(NullDbCloner);
  });
});

describe("flag-off byte-identity — the plain runIntegrationVerify path is unchanged", () => {
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
