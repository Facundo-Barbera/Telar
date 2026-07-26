import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-weave-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { rollupWeave, runWeave } = await import("../src/weave");
const { createLoom, listChildLooms, saveLoom, getLoom } = await import("../src/looms");
import type { Loom } from "../src/looms";
import type { Charter, SubGoal } from "../src/schemas";

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

  // Cut 0 mustFix FIX 1 — TESTS (a): a failed required child no longer
  // short-circuits with a single-id "s1: failed" before the never-spawned
  // siblings are enumerated. The reason ALWAYS carries the complete
  // unmet-required enumeration, in decomposition order.
  test("FIX 1: a failed required child + never-spawned required siblings -> failed, error enumerates the failed one AND every unspawned sibling", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const children = [fakeLoom({ subGoalId: "s1", state: "failed" })]; // s2, s3 never spawned
    const r = rollupWeave(children, decomposition);
    expect(r.state).toBe("failed");
    expect(r.error).toBe("s1: failed; s2: unspawned; s3: unspawned");
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

describe("runWeave — Cut 0 mustFix FIX 2: blocked-child attribution is unified (never diverges by settle order)", () => {
  // Two required children (s1, s2) both settle `blocked`, but s2 SETTLES FIRST
  // (finishes and lands in the `finished` map before s1) — the reverse of
  // decomposition order. The old code picked the root's blockedReason/
  // blockedQuestion via SETTLE order (children = [...finished.values()]) while
  // rollupWeave picked the rollup error via DECOMPOSITION order — so the two
  // could name DIFFERENT subgoals. The fix: ONE rule (decomposition-first) used
  // by both. loom.error, loom.blockedQuestion, and the lane-escalation
  // subGoalId must all attribute the SAME (s1, decomposition-first) primary,
  // and blockedReason must name BOTH blocked children so nothing is hidden.
  test("settle order reversed: root.error, blockedReason, blockedQuestion, and lane-escalation ALL attribute the decomposition-first primary (s1)", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        // s2 settles well before s1 — settle order is the REVERSE of
        // decomposition order (s1, s2).
        const delayMs = child.subGoalId === "s1" ? 60 : 4;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        child.state = "blocked";
        child.blockedReason = `${child.subGoalId} reason`;
        child.blockedQuestion = `${child.subGoalId} question?`;
        return child;
      },
      onEvent: (ev) => events.push(ev),
    });

    expect(result.state).toBe("blocked");
    // loom.error is the FIX 1 enumeration, decomposition-ordered: s1 leads.
    expect(result.error).toBe("s1: blocked; s2: blocked");
    // The primary is s1 (decomposition-first), NOT s2 (settle-first).
    expect(result.blockedQuestion).toBe("s1 question?");
    expect(result.blockedReason).toContain("s1 reason");
    // blockedReason names the OTHER blocked required child too — nothing hidden.
    expect(result.blockedReason).toContain("s2");
    // The lane-escalation event attributes the same (s1) primary.
    const esc = events.find((e) => e.type === "lane-escalation");
    expect(esc).toBeTruthy();
    expect(esc!.subGoalId).toBe("s1");
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

  // Cut 0 mustFix FIX 1 — TESTS (a) at the runWeave level: s2/s3 dependsOn the
  // always-failing s1, so they never become ready and never spawn. The root's
  // error must enumerate the failed s1 AND every unspawned sibling, not just s1.
  test("FIX 1: a failed required child's never-spawned dependents are enumerated in the root's error, not swallowed", async () => {
    const decomposition = [
      subGoal({ id: "s1" }),
      subGoal({ id: "s2", dependsOn: ["s1"] }),
      subGoal({ id: "s3", dependsOn: ["s1"] }),
    ];
    const root = fakeLoom();
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => ((child.state = "failed"), child), // s1 always fails
    });
    expect(result.state).toBe("failed");
    expect(result.error).toBe("s1: failed; s2: unspawned; s3: unspawned");
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

// ── CAP-2 / AC6(c): the charter's budget-left is a PROJECTION ────────────────
// Asserted through the REAL seam: BudgetState is a runWeave local and never
// escapes, but the Rationale attached to each emitted `decision` event carries
// a BudgetSnapshot — that is the observable the charter's ledger view renders.
const { ledgerSpendUsd } = await import("../src/usage-ledger");
const { MEDIATION_BUDGET } = await import("../src/tick");

const usageLedgerFile = () => path.join(process.env.TELAR_HOME!, "usage.ndjson");

function loomLinesFor(loomId: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = fs.readFileSync(usageLedgerFile(), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ownerKind === "loom" && e.ownerId === loomId);
}

// The spentUsd carried by the FIRST decision the weave emitted.
function firstDecisionSpentUsd(events: { type: string }[]): number {
  const decision = events.find((e) => e.type === "decision") as
    | { rationale?: { budget?: { spentUsd?: number } } }
    | undefined;
  return decision?.rationale?.budget?.spentUsd ?? NaN;
}

// The spentUsd carried by the LAST decision the weave emitted.
function lastDecisionSpentUsd(events: { type: string }[]): number {
  const decisions = events.filter((e) => e.type === "decision") as {
    rationale?: { budget?: { spentUsd?: number } };
  }[];
  return decisions[decisions.length - 1]?.rationale?.budget?.spentUsd ?? NaN;
}

// A PRODUCTION-SHAPED AttemptRecord. Production only ever PUSHES one of these
// onto attempts[] (executor.ts:1211/1397/1513/1894) and never replaces the
// array, so every fake below pushes too. A fake that ASSIGNS hides exactly the
// defect these tests exist to catch: the second settle of a reused child sees
// [1, 5], not [5].
//
// `id` is minted here because production mints it there — AD-18's billing
// identity, stamped at attempt-create time and carried on the record
// (looms.ts AttemptRecord.id). The producer scan at the bottom of this file
// pins that the four executor.ts sites really do mint one, so this fixture and
// production cannot drift apart silently.
function attemptRecord(over: Partial<Loom["attempts"][number]> = {}): Loom["attempts"][number] {
  return { id: crypto.randomUUID(), n: 1, role: "dev", model: "m", startedAt: 1, endedAt: 2, ...over };
}

// The SAME record as it was written before AttemptRecord.id existed — i.e. what
// is already sitting in every loom.json on disk. attemptKey's legacy branch
// keys these on (loom id, index, startedAt), and the tests that exercise that
// branch use this builder so they keep testing it after the id path exists.
function legacyAttemptRecord(over: Partial<Loom["attempts"][number]> = {}): Loom["attempts"][number] {
  const a = attemptRecord(over);
  delete a.id;
  return a;
}

// A hand-written ledger line, exactly as another writer — an older build, a
// second process, a resume that raced this one — would have left it on disk.
// Omit `entryKey` for the pre-idempotency (legacy) shape.
function appendLedgerLine(over: Record<string, unknown>): void {
  fs.mkdirSync(process.env.TELAR_HOME!, { recursive: true });
  fs.appendFileSync(
    usageLedgerFile(),
    JSON.stringify({
      ts: Date.now(),
      account: "personal",
      model: "",
      sessionId: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0,
      ownerKind: "loom",
      ownerId: "",
      ...over,
    }) + "\n",
  );
}

describe("runWeave — the charter's budget-left is a projection over usage.ndjson (AD-18)", () => {
  test("rationale.budget.spentUsd is a projection over the ledger for owner loom/<loomId>", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    const events: { type: string }[] = [];

    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "done";
        child.attempts.push(attemptRecord({ costUsd: 3 }));
        return child;
      },
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    // A loom-owned line was appended, and the projection agrees with it.
    expect(loomLinesFor(root.id)).toHaveLength(1);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(3);
    // The last decision's snapshot reflects the settled child's spend.
    const decisions = events.filter((e) => e.type === "decision") as {
      rationale?: { budget?: { spentUsd?: number } };
    }[];
    const last = decisions[decisions.length - 1];
    expect(last.rationale?.budget?.spentUsd).toBeCloseTo(3);
  });

  test("spend already in the ledger for this loom is visible in the FIRST decision's budget, before any child settles", async () => {
    // Decisive: a `let spentUsd = 0` accumulator always starts at 0.
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    fs.mkdirSync(process.env.TELAR_HOME!, { recursive: true });
    fs.appendFileSync(
      usageLedgerFile(),
      JSON.stringify({
        ts: Date.now(),
        account: "personal",
        model: "",
        sessionId: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 2,
        ownerKind: "loom",
        ownerId: root.id,
      }) + "\n",
    );

    const events: { type: string }[] = [];
    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "done";
        return child;
      },
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    expect(firstDecisionSpentUsd(events)).toBeCloseTo(2);
  });

  test("a mediated re-attempt bills only its NEW attempt — the first is never re-counted", async () => {
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom();
    let mediations = 0;
    // ONE child object for every spawnChild call, because that is what
    // production does: dispatcher.ts:439-471 finds the existing child by
    // subGoalId, keeps attempts[] INTACT, re-queues it and returns it. So the
    // mediated re-settle sees [1, 5] — a cumulative-per-settle recorder writes
    // 1 then 6 and bills $7 for $6 of work. Both attempts deliberately carry
    // `n: 1`: identity is the (loom id, attempts[] index) pair and must not
    // depend on AttemptRecord.n, which production restarts at 1 per
    // executeLoom call (executor.ts's `for (let n = 1; n <= maxAttempts; n++)`
    // attempt loop, :1873) and hardcodes at 1 on the verify path (the
    // `role: "verifier"` AttemptRecord literal, :1512). Both cited by symbol
    // first because the line moved twice in this story alone.
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });

    await runWeave(root, decomposition, {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "failed";
        c.attempts.push(attemptRecord({ n: 1, costUsd: 1 }));
        return c;
      },
      mediateThread: async (c) => {
        mediations++;
        c.state = "done";
        c.attempts.push(attemptRecord({ n: 1, costUsd: 5 }));
        return c;
      },
      onEvent: () => {},
    });

    expect(mediations).toBe(1);
    // THREE rows for TWO attempts, and both halves of that are the design.
    // The WRITE is never suppressed: the mediated re-settle honestly re-records
    // the first attempt it re-read, and that duplicate row is the audit trail a
    // human would need to see two writers disagree. The FOLD is what dedupes: a
    // non-empty key counts at most once, so the re-presented attempt adds no
    // money. Idempotence lives in the reader, never in a skipped append.
    const lines = loomLinesFor(root.id);
    expect(lines.map((l) => Number(l.costUsd)).sort((x, y) => x - y)).toEqual([1, 1, 5]);
    expect(new Set(lines.map((l) => String(l.entryKey))).size).toBe(2); // two ATTEMPTS
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(6);
  });

  test("a second runWeave over the same root and the same persisted child adds nothing (the resume shape)", async () => {
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });

    // Run 1 — the mediation shape above: $1 attempt, then a $5 re-attempt.
    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "failed";
        c.attempts.push(attemptRecord({ costUsd: 1 }));
        return c;
      },
      mediateThread: async (c) => {
        c.state = "done";
        c.attempts.push(attemptRecord({ costUsd: 5 }));
        return c;
      },
      onEvent: () => {},
    });
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(6);
    const rowsAfterRun1 = loomLinesFor(root.id).length;
    const keysAfterRun1 = new Set(loomLinesFor(root.id).map((l) => String(l.entryKey)));

    // Run 2 — a re-dispatch. runWeave's `finished`/`running` maps are declared
    // inside runWeave, so every call rebuilds them empty: tick re-schedules a
    // subgoal whose child is already done on disk, spawnChild hands back that
    // child with its two attempts intact, and executeLoom has no done
    // short-circuit. Nothing NEW is spent, so nothing new may be billed.
    // AN IN-PROCESS `Set<childId>` OR A PER-RUN DELTA MAP CANNOT PASS THIS —
    // both are runWeave locals too, so they re-record the cumulative 6.
    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        return c;
      },
      onEvent: () => {},
    });

    // The FILE grows — the resume honestly re-records the two attempts it
    // re-read, and suppressing that append would destroy the only record that a
    // second settle ever happened. What must not grow is the MONEY, or the set
    // of distinct keys the fold counts.
    const after = loomLinesFor(root.id);
    expect(after.length).toBeGreaterThan(rowsAfterRun1);
    expect(new Set(after.map((l) => String(l.entryKey)))).toEqual(keysAfterRun1);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(6);
  });

  test("the dedupe is a LEDGER READ, not the writer's memory: a pre-existing row for the key the run is about to write wins", async () => {
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });
    // The attempt is built HERE so the out-of-band row can name it by its own
    // minted id — the same identity the run will mint its key from.
    const a = attemptRecord({ costUsd: 2 });
    // Out of band and BEFORE the run: nothing in this process has ever written
    // this key, so a dedupe held by the writer cannot see it. Only a fold over
    // the FILE can. The key is (loom id, that attempt's id), so a hand-written
    // row only collides with the run's row when it names the SAME attempt,
    // which is the point.
    appendLedgerLine({ ownerId: root.id, costUsd: 9, entryKey: `attempt:${child.id}:${a.id}` });
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(9);

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        c.attempts.push(a);
        return c;
      },
      onEvent: () => {},
    });

    // FIRST OCCURRENCE WINS: the key is already settled, so the row this run
    // appends adds no money. The append itself is NOT suppressed — both rows are
    // on the file, and that is deliberate: the duplicate is the audit trail that
    // lets a human see two writers disagreed about what this attempt cost. (The
    // $2 is not billed; that is what "an honest re-record changes no total"
    // means when the two disagree.)
    const lines = loomLinesFor(root.id);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => Number(l.costUsd))).toEqual([9, 2]);
    expect(new Set(lines.map((l) => String(l.entryKey))).size).toBe(1); // ONE attempt
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(9);
  });

  test("mediation at the REAL bound bills each attempt once, and never suppresses a legitimate first record", async () => {
    // MEDIATION_BUDGET is 2 and only REQUIRED subgoals are mediable
    // (tick.ts:221-229), so s1 settles three times with APPENDED attempts
    // 1, 2, 4 while the non-required s2 settles exactly once at 8. Total 15
    // across four rows. A cumulative-per-settle recorder yields 19; a fix that
    // over-suppresses drops s2's only record and yields 7.
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", required: false })];
    const root = fakeLoom();
    const children = new Map<string, Loom>();
    const childFor = (id: string): Loom => {
      const existing = children.get(id);
      if (existing) return existing;
      const fresh = fakeLoom({ subGoalId: id, state: "queued" });
      children.set(id, fresh);
      return fresh;
    };
    let mediations = 0;

    await runWeave(root, decomposition, {
      spawnChild: (sg) => childFor(sg.id),
      runChild: async (c) => {
        if (c.subGoalId === "s1") {
          c.state = "failed";
          c.attempts.push(attemptRecord({ costUsd: 1 }));
        } else {
          c.state = "done";
          c.attempts.push(attemptRecord({ costUsd: 8 }));
        }
        return c;
      },
      mediateThread: async (c) => {
        mediations++;
        c.state = "failed"; // never converges — the bound is what we are pinning
        c.attempts.push(attemptRecord({ costUsd: mediations === 1 ? 2 : 4 }));
        return c;
      },
      onEvent: () => {},
    });

    expect(mediations).toBe(MEDIATION_BUDGET);
    const lines = loomLinesFor(root.id);
    // SEVEN rows for FOUR attempts: s1 settles at [1], then at [1,2], then at
    // [1,2,4] (1 + 2 + 3 rows) while s2 settles once at [8]. Every settle
    // honestly re-records everything it re-read — the write is never suppressed —
    // and the fold counts each of the four distinct keys exactly once.
    expect(lines).toHaveLength(7);
    const byKey = new Map(lines.map((l) => [String(l.entryKey), Number(l.costUsd)]));
    expect([...byKey.values()].sort((x, y) => x - y)).toEqual([1, 2, 4, 8]);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(15);
  });

  test("spentUsd stays a fold MID-RUN: an out-of-band row appended between settles moves the next decision's budget", async () => {
    // The 'before any child settles' pin above passes even for a fix that folds
    // once at start-up and caches the amount. This one does not: the row lands
    // AFTER the first decision, from outside the weave entirely.
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2", dependsOn: ["s1"] })];
    const root = fakeLoom();
    const events: { type: string }[] = [];

    await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        if (child.subGoalId === "s1") {
          appendLedgerLine({ ownerId: root.id, costUsd: 7 }); // un-keyed, i.e. the legacy shape
        }
        child.state = "done";
        return child;
      },
      onEvent: (ev) => events.push(ev as { type: string }),
    });

    expect(firstDecisionSpentUsd(events)).toBeCloseTo(0);
    expect(lastDecisionSpentUsd(events)).toBeCloseTo(7);
  });

  test("a resumed loom still under its real budget is SCHEDULED, not starved with 'the agent pool has no room'", async () => {
    // The functional harm, not the arithmetic. maxCostUsd 10, true spend 6.
    // Under a cumulative-per-settle recorder the third dispatch reads >= 18, so
    // budgetLeftUsd floors to 0 (budget.ts:26-28), fanoutClamp returns
    // chosen: 0 / "pool-exhausted" (:49-54) and tick escalates at :301-306 —
    // starving a loom with $4 of headroom. EST_COST_PER_AGENT is 0.5
    // (tick.ts:162), so $4 still buys floor(4 / 0.5) = 8 agents.
    const charter: Charter = {
      objective: "o",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3, maxCostUsd: 10 },
      decomposition: [],
      version: 1,
    };
    const root = fakeLoom({ charter });
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });

    // Dispatch 1 — the only one that spends anything.
    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        c.attempts.push(attemptRecord({ costUsd: 6 }));
        return c;
      },
      onEvent: () => {},
    });

    // Dispatches 2 and 3 — resumes that re-settle an already-done child.
    const resume = async () => {
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      const result = await runWeave(root, [subGoal({ id: "s1" })], {
        spawnChild: () => child,
        runChild: async (c) => {
          c.state = "done";
          return c;
        },
        onEvent: (ev) => events.push(ev),
      });
      return { result, events };
    };
    await resume();
    const third = await resume();

    const decisions = third.events
      .filter((e) => e.type === "decision")
      .map((e) => e.decision as { action: string; reason?: string });
    expect(decisions.some((d) => d.action === "schedule")).toBe(true);
    expect(decisions.some((d) => d.action === "escalate" && (d.reason ?? "").includes("agent pool has no room"))).toBe(
      false,
    );
    expect(third.result.state).toBe("ready");
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(6);
  });

  test("a throwing ledger never fails a weave that did real work, and reports at most once", async () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    // TELAR_HOME pointed at a regular FILE, so logUsage's mkdirSync throws on
    // every row — the persistent-EROFS shape, not a one-off.
    const notADir = path.join(home, "not-a-dir");
    fs.writeFileSync(notADir, "x");
    const realHome = process.env.TELAR_HOME;

    const run = async () => {
      process.env.TELAR_HOME = notADir;
      try {
        return await runWeave(root, decomposition, {
          spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
          runChild: async (child) => {
            child.state = "done";
            child.attempts.push(attemptRecord({ costUsd: 4 }));
            return child;
          },
          onEvent: (ev) => events.push(ev),
        });
      } finally {
        process.env.TELAR_HOME = realHome;
      }
    };
    const result = await run();

    // Accounting is best-effort; the work is not. The rollup stands and every
    // settled child is still in it.
    expect(result.state).toBe("ready");
    const rollup = events.find((e) => e.type === "weave-rollup") as {
      children?: { subGoalId?: string }[];
    };
    expect(rollup.children!.map((c) => c.subGoalId).sort()).toEqual(["s1", "s2"]);
    // ONE-SHOT: two children, two attempts, two failed writes, one event.
    expect(events.filter((e) => e.type === "spend-record-failed")).toHaveLength(1);
    // And nothing leaked into the real root.
    expect(loomLinesFor(root.id)).toHaveLength(0);
  });

  test("the loom total is the sum over DISTINCT keyed attempts plus the un-keyed residue, never the sum over lines", async () => {
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });
    const a = attemptRecord({ costUsd: 3 });

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        c.attempts.push(a);
        return c;
      },
      onEvent: () => {},
    });

    const keyed = loomLinesFor(root.id)[0];
    // (loom id, that attempt's own minted id) — NOT its index, its ordinal or
    // any other count. Spelled out as a literal, not recomputed from the
    // production helper, so a silent change to the key SHAPE fails here.
    expect(keyed.entryKey).toBe(`attempt:${child.id}:${a.id}`);
    // A duplicate that a second writer could genuinely have appended (the write
    // path never dedupes, so a re-presented key always lands), plus a legacy
    // un-keyed row.
    appendLedgerLine(keyed);
    appendLedgerLine({ ownerId: root.id, costUsd: 1 });

    const lines = loomLinesFor(root.id);
    expect(lines).toHaveLength(3); // the file really does carry the duplicate
    const seen = new Set<string>();
    let distinctSum = 0;
    for (const l of lines) {
      const key = String(l.entryKey ?? "");
      if (key) {
        if (seen.has(key)) continue; // counted once, exactly as foldLine does
        seen.add(key);
      }
      distinctSum += Number(l.costUsd);
    }
    expect(distinctSum).toBeCloseTo(4);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(distinctSum);
  });

  test("a zero-cost attempt writes no row; a non-finite cost writes no row and EMITS spend-record-skipped", async () => {
    const root = fakeLoom();
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "done";
        child.attempts.push(attemptRecord({ costUsd: 0 })); // free: nothing to bill YET
        child.attempts.push(attemptRecord({ costUsd: Number.NaN })); // must not vanish silently
        child.attempts.push(attemptRecord({ costUsd: 2 }));
        return child;
      },
      onEvent: (ev) => events.push(ev),
    });

    // Row count is NOT attempt count — that is deliberate, and this pins it.
    expect(loomLinesFor(root.id).map((l) => l.costUsd)).toEqual([2]);
    const skipped = events.filter((e) => e.type === "spend-record-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ attempt: 1, reason: "non-finite cost" });
  });

  test("a SCHEMA-REJECTED row (logUsage returns false, never throws) is still reported — reading the boolean, not just the try/catch", async () => {
    // logUsage reports a schema rejection by RETURNING FALSE, not by throwing
    // (usage-ledger.ts's UsageEntry.safeParse branch). A throw is caught by
    // the try/catch around the logUsage call; a `false` return is NOT — it is
    // just a value, and a caller that never reads it loses the row with no
    // event and only a console.error nobody tailing a run would see. This is
    // the defect the fix closes: `const logged = logUsage(...)` READS the
    // boolean and routes a false through reportSpendRecordFailed exactly like
    // the catch does for a throw.
    //
    // Trigger: weave.ts writes `account: loom.account` into every row, and
    // UsageEntry declares `account: z.string().default("unknown")`
    // (schemas.ts). A default only ever fills in for `undefined` — a
    // non-string value fails validation outright instead of falling back to
    // "unknown" — so a root loom with a non-string account makes
    // UsageEntry.safeParse fail on every attempt it tries to record.
    const decomposition = [subGoal({ id: "s1" })];
    const root = fakeLoom({ account: 42 as unknown as string });
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        child.state = "done";
        // A real, finite, non-zero attempt — genuinely attempted, so this is
        // recordSpend actually trying (and failing) to write a row, not the
        // zero-cost/non-finite short-circuits the test above already covers.
        child.attempts.push(attemptRecord({ costUsd: 4 }));
        return child;
      },
      onEvent: (ev) => events.push(ev),
    });

    // The row really did not land — logUsage's `false` means exactly that.
    expect(loomLinesFor(root.id)).toHaveLength(0);
    // Exactly ONE spend-record-failed event, carrying a message that names the
    // rejection (not a generic/blank string) — the same one-shot reporter the
    // throwing-ledger test above exercises via the OTHER route into it.
    const failed = events.filter((e) => e.type === "spend-record-failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0].message)).toContain("rejected");
    // Accounting is best-effort, the work is not: the accounting defect must
    // not fail the weave that actually completed.
    expect(result.state).not.toBe("failed");
  });

  // The divergent-writers fixture, shared by the three tests below because it is
  // the ONE shape every key scheme has to survive: two in-memory copies of one
  // persisted child (exactly what two re-reads of loom.json hand back), both
  // carrying the attempt they had already seen, each pushing its OWN genuinely
  // different next attempt at the same index. usage-ledger.ts's own header names
  // "a dev server and the packaged app appending to one root concurrently" as
  // legitimate, so this is a real configuration and not a contrived one. TRUE
  // spend is always 1 + 3 + 7 = 11.
  const divergentWriters = async (mint: (costUsd: number) => Loom["attempts"][number]) => {
    const root = fakeLoom();
    const shared = mint(1); // the attempt both writers had already seen on disk
    const copyA = fakeLoom({ subGoalId: "s1", state: "queued", attempts: [{ ...shared }] });
    const copyB = fakeLoom({ id: copyA.id, subGoalId: "s1", state: "queued", attempts: [{ ...shared }] });
    const a = mint(3);
    const b = mint(7);

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => copyA,
      runChild: async (c) => {
        c.state = "failed";
        c.attempts.push(a); // copyA's index 1
        return c;
      },
      mediateThread: async () => {
        copyB.state = "done";
        copyB.attempts.push(b); // copyB's index 1 — a DIFFERENT attempt
        return copyB;
      },
      onEvent: () => {},
    });
    // FOUR rows for THREE attempts: copyA's settle records [shared, a] and
    // copyB's re-settle records [shared, b]. The write is never suppressed, so
    // `shared` is on the file twice — the audit trail. `keyed` is what the fold
    // sees: one entry per DISTINCT key, which is what money is counted from.
    const lines = loomLinesFor(root.id);
    const keyed = new Map(lines.map((l) => [String(l.entryKey), Number(l.costUsd)]));
    return { root, childId: copyA.id, shared, a, b, lines, keyed };
  };

  test("two attempts stamped in the SAME MILLISECOND at the same index are both billed — the minted id, not the clock, is the identity", async () => {
    // THE ANNIHILATION THE (loom id, index, startedAt) KEY STILL HAD. Both
    // divergent attempts land at index 1 AND carry the same startedAt, so that
    // key made them one event: the fold kept the first, dropped the second, and
    // $11 of real work billed $4 with no ledger row and no event. Date.now() has
    // millisecond resolution, so this is a window, not a fantasy — and the
    // direction of the error is the bad one (an over-count is visible and
    // arguable, an under-count silently un-binds maxCostUsd).
    //
    // attemptRecord() mints an id exactly as executor.ts's four producers do, so
    // the two attempts are two events no matter what the clock said.
    const stamp = 1_700_000_000_999;
    const { root, childId, shared, a, b, lines, keyed } = await divergentWriters((costUsd) =>
      attemptRecord({ costUsd, startedAt: stamp, endedAt: stamp + 1 }),
    );

    // The collision the old key had really is present in this fixture: same
    // index, same millisecond. Without this the test could pass vacuously.
    expect([shared.startedAt, a.startedAt, b.startedAt]).toEqual([stamp, stamp, stamp]);
    expect(new Set([shared.id, a.id, b.id]).size).toBe(3); // three ids, three events

    // Three rows: the shared prefix once (re-presented by copyB, deduped by its
    // id), and BOTH divergent index-1 attempts.
    expect(lines).toHaveLength(4); // the re-presented shared attempt IS written
    expect([...keyed.keys()].sort()).toEqual(
      [`attempt:${childId}:${shared.id}`, `attempt:${childId}:${a.id}`, `attempt:${childId}:${b.id}`].sort(),
    );
    expect([...keyed.values()].sort((x, y) => x - y)).toEqual([1, 3, 7]);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(11);
  });

  test("two attempts with NO startedAt at the same index are both billed — a minted id needs no other discriminator", async () => {
    // The same annihilation by the other route: attemptKey's pre-id fallback for
    // a record with no finite startedAt was the BARE (loom id, index), so two
    // divergent index-1 attempts collapsed onto one key and $11 billed $4. An
    // id-bearing attempt never reaches that fallback.
    const { root, childId, shared, a, b, lines, keyed } = await divergentWriters(
      (costUsd) =>
        ({ id: crypto.randomUUID(), n: 2, role: "dev", model: "m", costUsd }) as unknown as Loom["attempts"][number],
    );

    expect([shared.startedAt, a.startedAt, b.startedAt].every((s) => !Number.isFinite(s))).toBe(true);
    expect(lines).toHaveLength(4); // the re-presented shared attempt IS written
    expect([...keyed.keys()].sort()).toEqual(
      [`attempt:${childId}:${shared.id}`, `attempt:${childId}:${a.id}`, `attempt:${childId}:${b.id}`].sort(),
    );
    expect([...keyed.values()].sort((x, y) => x - y)).toEqual([1, 3, 7]);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(11);
  });

  test("LEGACY records: two GENUINELY DIFFERENT attempts at the SAME attempts[] index are still both billed when their startedAt differs", async () => {
    // The pre-id key shape, kept for records already on disk, and still pinned:
    // (loom id, index, startedAt). It discriminates whenever the two attempts
    // did not start in the same millisecond — which is the most a record
    // carrying no minted id can offer. A legacy attempt is frozen (nothing
    // re-pushes a historical record), so this branch only ever runs over data
    // that can no longer grow.
    let t = 100;
    const { root, childId, lines, keyed } = await divergentWriters((costUsd) => {
      t += 100;
      return legacyAttemptRecord({ costUsd, startedAt: t, endedAt: t + 1 });
    });

    expect(lines).toHaveLength(4); // the re-presented shared attempt IS written
    expect([...keyed.keys()].sort()).toEqual(
      [`attempt:${childId}:0:200`, `attempt:${childId}:1:300`, `attempt:${childId}:1:400`].sort(),
    );
    expect([...keyed.values()].sort((x, y) => x - y)).toEqual([1, 3, 7]);
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(11);
  });

  test("the SAME attempt re-presented on a RE-READ copy of the child still dedupes to one row", async () => {
    // Property (a): identity has to survive PERSISTENCE, which is why the
    // billing id is a FIELD of the record rather than anything about the object.
    // A JSON round-trip is the honest resume shape — loom.json in, a different
    // object with the same values out. A key that leaned on object identity (a
    // WeakMap, a Symbol) or on an in-memory sequence number would bill this
    // attempt a second time here, once per resume, forever.
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });
    const a = attemptRecord({ costUsd: 4, startedAt: 1_700_000_000_000 });

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        c.attempts.push(a);
        return c;
      },
      onEvent: () => {},
    });
    expect(loomLinesFor(root.id)).toHaveLength(1);
    expect(loomLinesFor(root.id)[0].entryKey).toBe(`attempt:${child.id}:${a.id}`);

    const reread = JSON.parse(JSON.stringify(child)) as Loom;
    expect(reread).not.toBe(child); // the re-read really is a different object
    expect(reread.attempts).toHaveLength(1);
    expect(reread.attempts[0]).not.toBe(a); // ...and so is the attempt inside it
    expect(reread.attempts[0].id).toBe(a.id); // the id is what crossed the JSON
    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => reread,
      runChild: async (c) => {
        c.state = "done";
        return c;
      },
      onEvent: () => {},
    });

    // TWO rows, ONE key: the resume honestly re-recorded what it re-read (the
    // append is never suppressed), and the fold counted it once.
    const lines = loomLinesFor(root.id);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => String(l.entryKey)))).toEqual(new Set([`attempt:${child.id}:${a.id}`]));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(4);
  });

  test("a LEGACY attempt (no minted id) keys on (loom id, index, startedAt) and still dedupes across a JSON round-trip", async () => {
    // The fallback branch, on the data it exists for: a loom.json written before
    // AttemptRecord.id. It must still dedupe against itself on every resume,
    // because that is the property the whole scheme is for — the id path must
    // not have been bought by breaking the records already on disk.
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });
    const legacy = legacyAttemptRecord({ costUsd: 5, startedAt: 1_700_000_000_123 });
    expect(legacy.id).toBeUndefined(); // it really is the pre-id shape

    const settle = async (spawn: () => Loom) =>
      runWeave(root, [subGoal({ id: "s1" })], {
        spawnChild: spawn,
        runChild: async (c) => {
          c.state = "done";
          if (c.attempts.length === 0) c.attempts.push(legacy);
          return c;
        },
        onEvent: () => {},
      });
    await settle(() => child);
    const reread = JSON.parse(JSON.stringify(child)) as Loom;
    await settle(() => reread); // the resume, through the same round-trip

    const lines = loomLinesFor(root.id);
    expect(lines).toHaveLength(2); // written twice, on purpose
    expect(new Set(lines.map((l) => String(l.entryKey)))).toEqual(new Set([`attempt:${child.id}:0:1700000000123`]));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(5);
  });

  test("a NON-STRING or EMPTY id takes the legacy branch rather than collapsing every attempt onto one key", async () => {
    // Nothing validates loom.json against a schema, so a hand-edited or foreign
    // file can carry an `id` that is not a non-empty string. Falling through to
    // the legacy key is the SAFE direction; interpolating it blindly would give
    // every attempt of the loom the single key `attempt:<loomId>:` (empty id) or
    // fold two attempts that a foreign writer numbered 1, 2, 1 (numeric ids) —
    // the count-shaped annihilation this whole change exists to end.
    const root = fakeLoom();
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });
    const empty = { ...legacyAttemptRecord({ costUsd: 2, startedAt: 10 }), id: "" };
    const numeric = { ...legacyAttemptRecord({ costUsd: 3, startedAt: 20 }), id: 7 } as unknown as Loom["attempts"][number];

    await runWeave(root, [subGoal({ id: "s1" })], {
      spawnChild: () => child,
      runChild: async (c) => {
        c.state = "done";
        c.attempts.push(empty, numeric);
        return c;
      },
      onEvent: () => {},
    });

    const lines = loomLinesFor(root.id);
    expect(lines.map((l) => l.entryKey).sort()).toEqual(
      [`attempt:${child.id}:0:10`, `attempt:${child.id}:1:20`].sort(),
    );
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(5);
  });

  test("an attempt carrying neither an id nor a startedAt falls back to the bare (loom id, index) key and still dedupes", async () => {
    // AttemptRecord.startedAt is required by the type, but the type does not
    // govern what is already on disk. A record with neither a minted id nor a
    // usable startedAt keys on (loom id, index) alone — it still dedupes against
    // itself, it simply keeps the concurrent-index collision, which is the most
    // that can be said about a record carrying no discriminator at all. Only a
    // frozen historical record can reach here: everything executor.ts mints
    // today carries an id.
    const root = fakeLoom();
    const legacy = { n: 1, role: "dev", model: "m", costUsd: 6 } as unknown as Loom["attempts"][number];
    const child = fakeLoom({ subGoalId: "s1", state: "queued" });

    const settle = async () =>
      runWeave(root, [subGoal({ id: "s1" })], {
        spawnChild: () => child,
        runChild: async (c) => {
          c.state = "done";
          if (c.attempts.length === 0) c.attempts.push(legacy);
          return c;
        },
        onEvent: () => {},
      });
    await settle();
    await settle(); // the resume: the same legacy attempt re-presented

    const lines = loomLinesFor(root.id);
    expect(lines).toHaveLength(2); // written twice, on purpose
    expect(new Set(lines.map((l) => String(l.entryKey)))).toEqual(new Set([`attempt:${child.id}:0`]));
    expect(ledgerSpendUsd({ ownerKind: "loom", ownerId: root.id })).toBeCloseTo(6);
  });

  // ── The append-only scan over attempts[], and its own discrimination proof ──
  // attemptKey's LEGACY branch names an attempt by its INDEX, so a writer that
  // ASSIGNED OVER an existing index would re-present a different attempt under a
  // key the ledger has already settled: the correction folds to nothing,
  // silently, with no other test failing. (An id-bearing attempt is named by its
  // own minted id and is immune to this — but every loom.json written before
  // AttemptRecord.id existed still keys on the index, so the assumption is still
  // load-bearing.) The type system cannot express "append-only", so this is a
  // source-level scan. It covers the whole family of ways an index can stop
  // naming the attempt it named before — not just the array being replaced
  // wholesale.
  const APPEND_ONLY_VIOLATIONS: Array<[string, RegExp]> = [
    // The array replaced. Anchored on the PROPERTY write (`.attempts`) rather
    // than the bare identifier — deliberately, and this is the ONE pattern of
    // the twelve that is: reassigning a local alias (`attempts = […]`) only
    // re-points the local name and cannot reach the array the loom still holds,
    // so it cannot move any index, while `const attempts = …` IS how a
    // legitimate local READ binding reads (tick.ts:232) and flagging it would be
    // a standing false positive. The eleven patterns below, which are the ones
    // that DO mutate the underlying array, are all anchored on the bare
    // identifier and so are covered through an alias.
    ["array assignment", /\.attempts\s*=[^=]/g],
    // Assignment INTO a slot — the shape the whole key identity rests on, and
    // the one the pre-strengthening scan let through. Anchored on the bare
    // identifier so an aliased/destructured array is covered too; no
    // declaration form can collide here, because a declaration cannot carry a
    // subscript on its left-hand side.
    ["index assignment", /\battempts\s*\[[^\]\n]*\]\s*=[^=]/g],
    ["delete of an index", /\bdelete\b[^;\n]*\battempts\s*\[/g],
    ["length truncation", /\battempts\s*\.length\s*=[^=]/g],
    // In-place rewrites/reorders: each one leaves some index naming a
    // different attempt than it named a moment earlier.
    ["splice", /\battempts\s*\.splice\(/g],
    ["pop", /\battempts\s*\.pop\(/g],
    ["shift", /\battempts\s*\.shift\(/g],
    ["unshift", /\battempts\s*\.unshift\(/g],
    ["sort", /\battempts\s*\.sort\(/g],
    ["reverse", /\battempts\s*\.reverse\(/g],
    ["fill", /\battempts\s*\.fill\(/g],
    ["copyWithin", /\battempts\s*\.copyWithin\(/g],
  ];

  const tsFilesUnder = (dir: string): string[] =>
    fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(dir, f));

  // Reports `<file>:<line>: <label>` per hit so a future writer is told WHERE.
  // Honest about its reach: a TEXT scan of one directory tree, so an alias
  // under some other name, a computed member access, an object rebuilt around
  // a fresh attempts array, or a rewrite made outside the scanned tree all
  // evade it. It also matches inside comments and strings — conservative in
  // the safe direction (a false alarm, never a silent miss).
  const scanAppendOnly = (dir: string): string[] => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(dir)) {
      const text = fs.readFileSync(file, "utf8");
      for (const [label, re] of APPEND_ONLY_VIOLATIONS) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          offenders.push(`${path.relative(dir, file)}:${text.slice(0, m.index).split("\n").length}: ${label}`);
        }
      }
    }
    return offenders;
  };

  test("attempts[] is append-only in packages/core/src — the one assumption attemptKey rests on", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    expect(tsFilesUnder(srcDir).length).toBeGreaterThan(10); // the scan actually scanned something
    expect(scanAppendOnly(srcDir)).toEqual([]);
  });

  test("the append-only scan DISCRIMINATES: every rewriting shape is caught, the read/append shapes production is built from are not", () => {
    // Without this, the scan above passes just as quietly when its patterns
    // match nothing at all — which is exactly how it came to claim a guard it
    // did not provide (it had no pattern for an index assignment).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-scan-"));
    try {
      // NEGATIVE CONTROL — the shapes packages/core/src really contains today
      // (executor.ts:1206/1211/1706/1784, looms.ts:338/428, tick.ts:232, and a
      // prose mention of the array). None of these breaks the index binding.
      fs.writeFileSync(
        path.join(dir, "legit.ts"),
        [
          "const attempt: AttemptRecord = { id: crypto.randomUUID(), n: (loom.attempts?.length ?? 0) + 1, role: 'dev', startedAt: Date.now() };",
          "loom.attempts.push(attempt);",
          "const prior = loom.attempts[loom.attempts.length - 1];",
          "const built = loom.attempts.some((a) => !VERIFY_ONLY_ROLES.has(a.role));",
          "if (loom.attempts.length === 0) return null;",
          "attempt.costUsd = (attempt.costUsd ?? 0) + e.costUsd;",
          "const fresh = { ...base, attempts: [] };",
          "const attempts = t.mediationAttempts ?? 0;",
          "// the index into that loom's attempts[], and that attempt's own startedAt",
          "",
        ].join("\n"),
      );
      expect(scanAppendOnly(dir)).toEqual([]);
      fs.rmSync(path.join(dir, "legit.ts"));

      // POSITIVE CONTROL — one violating line at a time, each expected to be
      // caught EXACTLY once and under its own label (so a pattern can neither
      // go dead nor quietly stand in for another).
      const violations: Array<[string, string]> = [
        ["array assignment", "loom.attempts = [attempt];"],
        ["index assignment", "loom.attempts[0] = attempt;"],
        ["index assignment", "loom.attempts[loom.attempts.length - 1] = attempt;"],
        ["index assignment", "attempts[i] = attempt;"], // aliased/destructured
        ["delete of an index", "delete loom.attempts[0];"],
        ["length truncation", "loom.attempts.length = 0;"],
        ["splice", "loom.attempts.splice(0, 1, attempt);"],
        ["pop", "loom.attempts.pop();"],
        ["shift", "loom.attempts.shift();"],
        ["unshift", "loom.attempts.unshift(attempt);"],
        ["sort", "loom.attempts.sort((a, b) => a.n - b.n);"],
        ["reverse", "loom.attempts.reverse();"],
        ["fill", "loom.attempts.fill(attempt);"],
        ["copyWithin", "loom.attempts.copyWithin(0, 1);"],
      ];
      for (const [label, line] of violations) {
        fs.writeFileSync(path.join(dir, "v.ts"), `${line}\n`);
        expect(scanAppendOnly(dir)).toEqual([`v.ts:1: ${label}`]);
      }

      // MEASURED NON-COVERAGE — pinned rather than described, because weave.ts
      // used to claim every pattern matched a bare `attempts` binding and one
      // does not. Eleven of the twelve shapes are caught through a bare alias;
      // the array-replacement one is caught only through a `.attempts` property
      // write. That is the right anchor — rebinding a local alias re-points the
      // name and cannot move an index in the array the loom still holds — but it
      // is a real boundary, so it is asserted here instead of asserted in prose.
      const aliased: Array<[string, string, boolean]> = [
        ["array assignment", "attempts = [attempt];", false], // NOT caught, by design
        ["index assignment", "attempts[0] = attempt;", true],
        ["delete of an index", "delete attempts[0];", true],
        ["length truncation", "attempts.length = 0;", true],
        ["splice", "attempts.splice(0, 1, attempt);", true],
        ["pop", "attempts.pop();", true],
        ["shift", "attempts.shift();", true],
        ["unshift", "attempts.unshift(attempt);", true],
        ["sort", "attempts.sort((a, b) => a.n - b.n);", true],
        ["reverse", "attempts.reverse();", true],
        ["fill", "attempts.fill(attempt);", true],
        ["copyWithin", "attempts.copyWithin(0, 1);", true],
      ];
      for (const [label, line, caught] of aliased) {
        fs.writeFileSync(path.join(dir, "v.ts"), `${line}\n`);
        expect(scanAppendOnly(dir)).toEqual(caught ? [`v.ts:1: ${label}`] : []);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── The producer scan: every AttemptRecord literal mints its own billing id ──
  // AD-18's key is only unique because executor.ts stamps AttemptRecord.id at
  // every site that CREATES an attempt. A fifth producer that forgot to would
  // silently fall back to attemptKey's legacy (index, startedAt) branch — the
  // exact annihilation this design ended — and no behavioral test would notice,
  // because the legacy branch is correct code that happens to be reachable.
  // AttemptRecord.id is optional (loom.json compatibility), so the type system
  // cannot catch it either. Hence a source scan, in the same spirit as the
  // append-only one above and with the same discrimination proof.
  //
  // Reports `<file>:<line>` for each literal that mints no id.
  const scanProducers = (dir: string): { literals: number; pushes: number; offenders: string[] } => {
    let literals = 0;
    let pushes = 0;
    const offenders: string[] = [];
    for (const file of tsFilesUnder(dir)) {
      const text = fs.readFileSync(file, "utf8");
      pushes += text.match(/\battempts\s*\.push\(/g)?.length ?? 0;
      const decl = /:\s*AttemptRecord\s*=\s*\{/g;
      for (let m = decl.exec(text); m; m = decl.exec(text)) {
        literals++;
        // Walk forward from the `{` to its matching `}` so a multi-line literal
        // is read whole rather than line-by-line.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (let i = end; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        const literal = text.slice(m.index, end + 1);
        if (!/\bid:\s*crypto\.randomUUID\(\)/.test(literal)) {
          offenders.push(`${path.relative(dir, file)}:${text.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    return { literals, pushes, offenders };
  };

  test("every AttemptRecord producer in packages/core/src mints a unique billing id", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const { literals, pushes, offenders } = scanProducers(srcDir);
    expect(offenders).toEqual([]);
    // The four producers the comments name. Not an upper bound — a fifth is
    // fine, it just has to mint an id like the others — but it IS a floor, so a
    // scan whose pattern went dead cannot pass by matching nothing.
    expect(literals).toBeGreaterThanOrEqual(4);
    // And nothing pushes onto attempts[] that was NOT built by one of those
    // literals: an attempt assembled some other way would evade the scan
    // entirely. One literal per push is what packages/core/src holds today.
    expect(pushes).toBe(literals);
  });

  test("the producer scan DISCRIMINATES: a literal that mints no id is caught, and a count-shaped id does not satisfy it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-producer-"));
    try {
      // The four real shapes, single-line and multi-line.
      fs.writeFileSync(
        path.join(dir, "ok.ts"),
        [
          "const attempt: AttemptRecord = { id: crypto.randomUUID(), n: 1, role: 'verifier', model: policy.dev, startedAt: Date.now() };",
          "loom.attempts.push(attempt);",
          "const attempt: AttemptRecord = {",
          "  id: crypto.randomUUID(),",
          "  n: (loom.attempts?.length ?? 0) + 1,",
          "  role: 'integration',",
          "  gates: { nested: 1 },", // a nested brace must not end the literal early
          "};",
          "loom.attempts.push(attempt);",
          "",
        ].join("\n"),
      );
      expect(scanProducers(dir)).toEqual({ literals: 2, pushes: 2, offenders: [] });

      // A producer that forgot the id — the regression this scan exists for.
      fs.writeFileSync(path.join(dir, "ok.ts"), "const attempt: AttemptRecord = { n: 1, role: 'dev', startedAt: Date.now() };\n");
      expect(scanProducers(dir).offenders).toEqual(["ok.ts:1"]);

      // A COUNT dressed up as an id — the shape three rounds of this fix kept
      // reaching for. It must not satisfy the scan.
      fs.writeFileSync(path.join(dir, "ok.ts"), "const attempt: AttemptRecord = { id: `a-${loom.attempts.length}`, n: 1 };\n");
      expect(scanProducers(dir).offenders).toEqual(["ok.ts:1"]);

      // A push of something built outside an AttemptRecord literal — caught by
      // the push/literal balance rather than by the offender list.
      fs.writeFileSync(path.join(dir, "ok.ts"), "loom.attempts.push(fromSomewhereElse);\n");
      expect(scanProducers(dir)).toEqual({ literals: 0, pushes: 1, offenders: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
