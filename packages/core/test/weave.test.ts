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

  test("a required child spawned-but-not-done -> blocked (escalation), enumerated as not-done — never a bare needs-review", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "running" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("blocked");
    expect(r.error).toContain("s2: not done (running)");
  });

  test("a non-required subgoal's child failed while all required done -> ready", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "failed" }),
    ];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "ready" });
  });

  test("a required subgoal with no child -> blocked, enumerated as 'unspawned' (L1: never a needs-review accept affordance)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [fakeLoom({ subGoalId: "s1", state: "done" })];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("blocked");
    expect(r.error).toContain("s2: unspawned");
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

describe("runWeave — integration verify producer + Unit 7 verdict gate (injected fake)", () => {
  // A woven loom that folds up to "ready" runs EXACTLY ONE integration verify
  // (the injected runner), records the verdict + emits weave-verify. Unit 7:
  // a REAL red verdict ("fail"/"flaky") demotes the terminal state to
  // "needs-review"; green ("pass"/"skip") and null keep "ready".
  test("records latestVerdict + emits weave-verify; a fail verdict DEMOTES ready -> needs-review (Unit 7)", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let calls = 0;
    let seenLoom: Loom | undefined;

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "done";
        return child;
      },
      onEvent: (ev) => events.push(ev),
      // Fake runner: no executor, no disk, no agent, no browser.
      runIntegrationVerify: async (l) => {
        calls++;
        seenLoom = l;
        return { verification: "fail", gatesOk: false };
      },
    });

    // Unit 7: a real red ALL verdict demotes the self-reported "ready".
    expect(result.state).toBe("needs-review");
    expect(result.error).toBe("integration verification fail");
    // The verdict is recorded where a later tick / the UI reads it.
    expect(result.latestVerdict).toBe("fail");
    // Exactly ONE integration verify, over the woven root itself.
    expect(calls).toBe(1);
    expect(seenLoom).toBe(root);
    // The event is on the root's stream for the UI + a later tick.
    const wv = events.filter((e) => e.type === "weave-verify");
    expect(wv.length).toBe(1);
    expect(wv[0]).toMatchObject({ verification: "fail", gatesOk: false });
    // weave-verify is emitted AFTER the rollup (recorded alongside, not before).
    expect(events.findIndex((e) => e.type === "weave-verify")).toBeGreaterThan(
      events.findIndex((e) => e.type === "weave-rollup"),
    );
    // The demotion is a real state transition emitted AFTER the verdict.
    expect(events.findIndex((e) => e.type === "state" && e.state === "needs-review")).toBeGreaterThan(
      events.findIndex((e) => e.type === "weave-verify"),
    );
  });

  test("a flaky verdict DEMOTES ready -> needs-review (Unit 7 lean: a human looks)", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      runIntegrationVerify: async () => ({ verification: "flaky", gatesOk: true }),
    });

    expect(result.state).toBe("needs-review");
    expect(result.error).toBe("integration verification flaky");
    expect(result.latestVerdict).toBe("flaky");
  });

  test("a skip verdict (ran, nothing falsifiable) keeps ready", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      runIntegrationVerify: async () => ({ verification: "skip", gatesOk: true }),
    });

    expect(result.state).toBe("ready");
    expect(result.latestVerdict).toBe("skip");
  });

  test("a pass verdict is recorded but still never changes the ready state", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
    });

    expect(result.state).toBe("ready");
    expect(result.latestVerdict).toBe("pass");
  });

  test("a throwing integration verify never demotes the loom (best-effort, stays ready)", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      onEvent: (ev) => events.push(ev),
      // The producer (or a saveLoom/appendEvent inside it) throws. It must be
      // swallowed — an informational verify can't reach the outer catch and
      // demote a correctly-woven "ready" loom to "failed".
      runIntegrationVerify: async () => {
        throw new Error("verify blew up");
      },
    });

    expect(result.state).toBe("ready"); // NOT demoted to "failed"
    expect(result.latestVerdict).toBeUndefined(); // no verdict leaked
    expect(events.some((e) => e.type === "weave-verify")).toBe(false);
    expect(events.some((e) => e.type === "weave-verify-error")).toBe(true);
  });

  test("NO ALL contract (runner returns null) -> nothing recorded, unchanged", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let calls = 0;

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      onEvent: (ev) => events.push(ev),
      runIntegrationVerify: async () => {
        calls++;
        return null; // no ALL contract
      },
    });

    expect(result.state).toBe("ready");
    expect(result.latestVerdict).toBeUndefined();
    expect(calls).toBe(1); // asked once; got null
    expect(events.some((e) => e.type === "weave-verify")).toBe(false);
  });

  test("seam not injected at all -> byte-identical to today (no producer)", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      onEvent: (ev) => events.push(ev),
    });

    expect(result.state).toBe("ready");
    expect(result.latestVerdict).toBeUndefined();
    expect(events.some((e) => e.type === "weave-verify")).toBe(false);
  });

  test("a non-ready rollup (required child failed) NEVER runs the integration verify", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    let calls = 0;

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = child.subGoalId === "s2" ? "failed" : "done";
        return child;
      },
      runIntegrationVerify: async () => {
        calls++;
        return { verification: "pass", gatesOk: true };
      },
    });

    expect(result.state).toBe("failed"); // rollup unchanged
    expect(calls).toBe(0); // nothing coherent to integration-verify
    expect(result.latestVerdict).toBeUndefined();
  });

  test("the recorded verdict lands in the persisted loom (onState) where Unit 7 / the UI reads it", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = createLoom({ project: "p", kind: "custom", title: "root", prompt: "x", account: "personal" });
    let persisted = 0;

    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "done"), child),
      onState: (l) => {
        persisted++;
        saveLoom(l);
      },
      runIntegrationVerify: async () => ({ verification: "flaky", gatesOk: true }),
    });

    // Read the loom back from disk exactly as a Unit-7 tick / the UI would.
    const onDisk = getLoom(root.id)!;
    expect(onDisk.latestVerdict).toBe("flaky");
    expect(persisted).toBeGreaterThan(0);
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

describe("rollupWeave — L1/L6: enumerate ALL unmet required, distinguish unspawned vs not-done", () => {
  test("multiple unmet: one never spawned, one spawned-not-done -> blocked, BOTH enumerated with correct labels", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "running" }), // spawned, not done
      // s3 never spawned
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("blocked");
    expect(r.error).toContain("s2: not done (running)");
    expect(r.error).toContain("s3: unspawned");
  });

  test("a failed required child still lands `failed` (decisive red), unchanged", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [fakeLoom({ subGoalId: "s1", state: "done" }), fakeLoom({ subGoalId: "s2", state: "failed" })];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "failed", error: "s2: failed" });
  });
});

describe("runWeave — L1: required work never spawned lands the ROOT blocked, never a needs-review accept affordance", () => {
  test("a required subgoal blocked by an unmet dependency never spawns; the loop exhausts -> root blocked with the enumerated reason", async () => {
    // s2 dependsOn s1; s1's child fails, so s2 never becomes ready and never spawns.
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", dependsOn: ["s1"] })];
    const root = fakeLoom();
    let calls = 0;
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "failed"), child), // s1 always fails
      runIntegrationVerify: async () => {
        calls++;
        return { verification: "pass", gatesOk: true };
      },
    });
    // s1 failed -> failedRequired wins (decisive red). The integration verify never runs.
    expect(result.state).toBe("failed");
    expect(calls).toBe(0);
  });

  test("a non-required child's outcome is accounted for in the weave-rollup event (never silently vanishes)", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = child.subGoalId === "s2" ? "failed" : "done"), child),
      onEvent: (ev) => events.push(ev),
    });
    // Required s1 done -> root ready (an optional failure never blocks accept)...
    expect(result.state).toBe("ready");
    // ...but the failed optional child is recorded in the rollup accounting.
    const rollup = events.find((e) => e.type === "weave-rollup") as {
      children?: { subGoalId?: string; state: string; required: boolean }[];
    };
    const optional = rollup.children!.find((c) => c.subGoalId === "s2");
    expect(optional).toMatchObject({ state: "failed", required: false });
  });
});

describe("runWeave — FINDING 1: the root's blocked-child lift is scoped to REQUIRED subgoals", () => {
  test("an optional child parked blocked never masks the enumerated reason for unspawned required work", async () => {
    // s_opt is optional and parks blocked with its own unrelated question.
    // s_req is required and dependsOn s_opt, so it never becomes ready and
    // never spawns. rollupWeave must reach the enumerate branch (blockedChild
    // is scoped to `required`, and s_req has no child), and runWeave's own
    // root-level lift must NOT pick up s_opt's blocked state/question in its
    // place — it must surface the complete enumerated reason instead.
    const decomposition = [
      subGoal({ id: "s_opt", required: false }),
      subGoal({ id: "s_req", required: true, dependsOn: ["s_opt"] }),
    ];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "blocked";
        child.blockedReason = "OPTIONAL child unrelated blocker";
        child.blockedQuestion = "optional child question?";
        return child;
      },
      onEvent: (ev) => events.push(ev),
    });

    expect(result.state).toBe("blocked");
    expect(result.blockedReason).toContain("s_req: unspawned");
    expect(result.blockedReason).not.toContain("OPTIONAL child unrelated blocker");
    expect(result.blockedQuestion).toContain("Re-plan or reassign");
    expect(result.blockedQuestion).not.toBe("optional child question?");

    const laneEscalations = events.filter((e) => e.type === "lane-escalation");
    expect(laneEscalations).toHaveLength(1);
    expect(laneEscalations[0]).toMatchObject({
      reason: "required-subgoals-unmet",
      subGoalId: root.subGoalId,
    });
  });
});

describe("runWeave — L13: SubGoal.status is synced at real transitions (record reads truthfully)", () => {
  test("spawn -> active, settle done -> done; a never-scheduled dependent stays pending until it runs", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", dependsOn: ["s1"] })];
    const root = fakeLoom();
    const seenAtSpawn: Record<string, SubGoal["status"]> = {};
    await runWeave(root, decomposition, {
      spawnChild: (sg) => {
        // s2 is still "pending" while s1 runs (dependency not yet done).
        seenAtSpawn[sg.id] = decomposition.find((s) => s.id === "s2")!.status;
        return fakeLoom({ subGoalId: sg.id, state: "queued" });
      },
      runChild: async (child) => ((child.state = "done"), child),
    });
    expect(decomposition[0].status).toBe("done");
    expect(decomposition[1].status).toBe("done");
    expect(seenAtSpawn["s1"]).toBe("pending"); // s2 not yet scheduled when s1 spawned
  });

  test("a settled failed child syncs the subgoal to failed", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "failed"), child),
    });
    expect(decomposition[0].status).toBe("failed");
  });

  test("a child recovered failed->done via mediation ends the subgoal 'done', not stuck 'failed'", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    let attempt = 0;
    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        attempt++;
        child.state = attempt === 1 ? "failed" : "done"; // first fails, mediation converges
        return child;
      },
    });
    expect(decomposition[0].status).toBe("done");
  });
});
