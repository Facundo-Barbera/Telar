// §A (docs/loom-model.md): "done" is accepted, not automatic.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-accept-ready-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { terminalStateForCompletedLoom } = await import("../src/executor");
const { rollupEpic } = await import("../src/epic");
const { acceptLoom, appendEvent, createLoom, getLoom, readEvents, saveLoom } = await import("../src/looms");
import type { Loom } from "../src/looms";
import type { SubGoal } from "../src/schemas";

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

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

describe("terminalStateForCompletedLoom (the executor.ts:532 branch, unit-tested directly)", () => {
  test("a completed ROOT leaf loom (no parentLoomId) reaches 'ready', not 'done'", () => {
    const root = fakeLoom({ role: "leaf" }); // no parentLoomId
    expect(terminalStateForCompletedLoom(root)).toBe("ready");
  });

  test("a completed CHILD thread (has parentLoomId) still reaches 'done'", () => {
    const child = fakeLoom({ role: "leaf", parentLoomId: "fake_epic" });
    expect(terminalStateForCompletedLoom(child)).toBe("done");
  });
});

describe("rollupEpic (§A retarget)", () => {
  test("all required children done -> epic rollup state 'ready'", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "done" }),
    ];
    expect(rollupEpic(children, decomposition)).toEqual({ state: "ready" });
  });

  test("a required child not done -> not 'ready' (needs-review)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "running" }),
    ];
    const r = rollupEpic(children, decomposition);
    expect(r.state).not.toBe("ready");
    expect(r.state).toBe("needs-review");
  });
});

describe("acceptLoom (real TELAR_HOME)", () => {
  test("ready -> done emits an 'accepted' event", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    saveLoom(loom);

    const accepted = acceptLoom(loom.id, "alice");
    expect(accepted.state).toBe("done");
    expect(getLoom(loom.id)!.state).toBe("done");

    const { events } = readEvents(loom.id);
    const acceptedEvents = events.filter((e) => e.type === "accepted");
    expect(acceptedEvents.length).toBe(1);
    expect(acceptedEvents[0]!.by).toBe("alice");
    expect(acceptedEvents[0]!.override).toBeUndefined();
  });

  test("accepting a non-ready loom throws without a co-sign", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    saveLoom(loom);

    expect(() => acceptLoom(loom.id, "alice")).toThrow(/override co-sign/);
    expect(() => acceptLoom(loom.id, "alice", { override: true })).toThrow(/override co-sign/); // no cosignedBy
    expect(getLoom(loom.id)!.state).toBe("needs-review");
  });

  test("accepting a non-ready (red) loom succeeds with {override:true, cosignedBy}", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    saveLoom(loom);

    const accepted = acceptLoom(loom.id, "alice", { override: true, cosignedBy: "bob" });
    expect(accepted.state).toBe("done");

    const { events } = readEvents(loom.id);
    const acceptedEvents = events.filter((e) => e.type === "accepted");
    expect(acceptedEvents.length).toBe(1);
    expect(acceptedEvents[0]!.override).toBe(true);
    expect(acceptedEvents[0]!.cosignedBy).toBe("bob");
  });

  test("accepting an already-'done' loom throws", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "done";
    saveLoom(loom);

    expect(() => acceptLoom(loom.id, "alice")).toThrow(/already accepted/);
    expect(() => acceptLoom(loom.id, "alice", { override: true, cosignedBy: "bob" })).toThrow(/already accepted/);
  });

  test("accepting a missing loom throws", () => {
    expect(() => acceptLoom("loom_nope", "alice")).toThrow(/not found/);
  });
});
