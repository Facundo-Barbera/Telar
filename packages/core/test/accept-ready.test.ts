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
const { rollupWeave } = await import("../src/weave");
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
  test("a completed ROOT loom (no parentLoomId) reaches 'ready', not 'done'", () => {
    const root = fakeLoom(); // no parentLoomId
    expect(terminalStateForCompletedLoom(root)).toBe("ready");
  });

  test("a completed CHILD thread (has parentLoomId) still reaches 'done'", () => {
    const child = fakeLoom({ parentLoomId: "fake_root" });
    expect(terminalStateForCompletedLoom(child)).toBe("done");
  });
});

describe("rollupWeave (§A retarget)", () => {
  test("all required children done -> weave rollup state 'ready'", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "done" }),
    ];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "ready" });
  });

  test("a required child not done -> not 'ready' (needs-review)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "running" }),
    ];
    const r = rollupWeave(children, decomposition);
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

  // #55 Fix 1: EVERY non-`ready`/non-`done` state is now an AUDITED OWNER
  // OVERRIDE the server-derived `by` may close — no co-sign gate. `failed` and
  // `queued` (the reported bug) both reach `done` with the audited flag/event.
  for (const from of ["failed", "queued"] as const) {
    test(`accept from '${from}' with no opts is an audited override -> done (no co-sign gate)`, () => {
      const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      loom.state = from;
      saveLoom(loom);

      const accepted = acceptLoom(loom.id, "alice"); // no override/cosign opts
      expect(accepted.state).toBe("done");
      expect(accepted.acceptedOverride).toBe(true);
      expect(getLoom(loom.id)!.state).toBe("done");

      const { events } = readEvents(loom.id);
      const acceptedEvents = events.filter((e) => e.type === "accepted");
      expect(acceptedEvents.length).toBe(1);
      expect(acceptedEvents[0]!.by).toBe("alice");
      expect(acceptedEvents[0]!.override).toBe(true);
      expect(acceptedEvents[0]!.fromState).toBe(from);
    });
  }

  test("accepting a `failed` loom succeeds with {override:true, cosignedBy}", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "failed";
    saveLoom(loom);

    const accepted = acceptLoom(loom.id, "alice", { override: true, cosignedBy: "bob" });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);

    const { events } = readEvents(loom.id);
    const acceptedEvents = events.filter((e) => e.type === "accepted");
    expect(acceptedEvents.length).toBe(1);
    expect(acceptedEvents[0]!.override).toBe(true);
    expect(acceptedEvents[0]!.cosignedBy).toBe("bob");
  });

  // P5 (docs/loom-model.md §A/§M): the owner may close a `needs-review` or
  // `blocked` loom directly — NOT independently verified, so it is an AUDITED
  // OVERRIDE (override:true event + acceptedOverride flag), never a clean
  // accept, and the server-derived `by` is the human touch (no cosign needed).
  for (const from of ["needs-review", "blocked"] as const) {
    test(`accept from '${from}' is an audited override: override:true + flag, no cosign, -> done`, () => {
      const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      loom.state = from;
      saveLoom(loom);

      const accepted = acceptLoom(loom.id, "alice"); // no override/cosign opts
      expect(accepted.state).toBe("done");
      expect(accepted.acceptedOverride).toBe(true);
      expect(getLoom(loom.id)!.state).toBe("done");

      const { events } = readEvents(loom.id);
      const acceptedEvents = events.filter((e) => e.type === "accepted");
      expect(acceptedEvents.length).toBe(1);
      expect(acceptedEvents[0]!.by).toBe("alice");
      expect(acceptedEvents[0]!.override).toBe(true);
      expect(acceptedEvents[0]!.fromState).toBe(from);
    });
  }

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

  // §A: "done" is reachable solely through a human/authenticated delegate —
  // a blank `by` must be rejected structurally by acceptLoom itself, not just
  // by caller discipline (mirrors assertProvenance's blank-approvedBy check).
  test("a blank or whitespace-only `by` is rejected, even on an otherwise-ready loom", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    saveLoom(loom);

    expect(() => acceptLoom(loom.id, "")).toThrow(/non-blank/);
    expect(() => acceptLoom(loom.id, "   ")).toThrow(/non-blank/);
    expect(() => acceptLoom(loom.id, "", { override: true, cosignedBy: "bob" })).toThrow(/non-blank/);
    expect(getLoom(loom.id)!.state).toBe("ready"); // never flipped to done
  });
});
