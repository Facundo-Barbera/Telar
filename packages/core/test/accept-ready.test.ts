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

  test("a required child spawned-but-not-done -> blocked (escalation), never 'ready' or a bare accept (L1/L6)", () => {
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const children = [
      fakeLoom({ subGoalId: "s1", state: "done" }),
      fakeLoom({ subGoalId: "s2", state: "running" }),
    ];
    const r = rollupWeave(children, decomposition);
    expect(r.state).not.toBe("ready");
    expect(r.state).toBe("blocked");
    expect(r.error).toContain("s2");
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

  // L3 (contract v0.8) — override is not accept: a bare acceptLoom on a
  // non-ready loom must THROW, never silently override. Replaces the old
  // "audited override with no opts" permissive behavior.
  for (const from of ["failed", "queued"] as const) {
    test(`bare accept from '${from}' (non-ready) THROWS — override is not accept (L3)`, () => {
      const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      loom.state = from;
      saveLoom(loom);

      expect(() => acceptLoom(loom.id, "alice")).toThrow(/without override/);
      expect(getLoom(loom.id)!.state).toBe(from); // never flipped
    });
  }

  test("override accept of 'failed' with {override:true, missing, cosignedBy} -> done, records missing + cosign", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "failed";
    saveLoom(loom);

    const accepted = acceptLoom(loom.id, "alice", { override: true, missing: "no verifier ran", cosignedBy: "bob" });
    expect(accepted.state).toBe("done");
    expect(accepted.acceptedOverride).toBe(true);
    expect(accepted.acceptedOverrideMissing).toBe("no verifier ran");

    const { events } = readEvents(loom.id);
    const acceptedEvents = events.filter((e) => e.type === "accepted");
    expect(acceptedEvents.length).toBe(1);
    expect(acceptedEvents[0]!.override).toBe(true);
    expect(acceptedEvents[0]!.missing).toBe("no verifier ran");
    expect(acceptedEvents[0]!.cosignedBy).toBe("bob");
  });

  // P5 (docs/loom-model.md §A/§M) + L3 (contract v0.8): the owner may close a
  // `needs-review` or `blocked` loom directly, but ONLY as a distinct,
  // deliberate override that names what is missing — a bare accept throws.
  for (const from of ["needs-review", "blocked"] as const) {
    test(`bare accept from '${from}' (non-ready) THROWS — override is not accept (L3)`, () => {
      const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      loom.state = from;
      saveLoom(loom);

      expect(() => acceptLoom(loom.id, "alice")).toThrow(/without override/);
      expect(getLoom(loom.id)!.state).toBe(from); // never flipped
    });

    test(`override accept from '${from}' with {override:true, missing} -> done, records acceptedOverrideMissing`, () => {
      const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
      loom.state = from;
      saveLoom(loom);

      const accepted = acceptLoom(loom.id, "alice", { override: true, missing: `${from}: named gap` });
      expect(accepted.state).toBe("done");
      expect(accepted.acceptedOverride).toBe(true);
      expect(accepted.acceptedOverrideMissing).toBe(`${from}: named gap`);
      expect(getLoom(loom.id)!.state).toBe("done");
      expect(getLoom(loom.id)!.acceptedOverrideMissing).toBe(`${from}: named gap`);

      const { events } = readEvents(loom.id);
      const acceptedEvents = events.filter((e) => e.type === "accepted");
      expect(acceptedEvents.length).toBe(1);
      expect(acceptedEvents[0]!.by).toBe("alice");
      expect(acceptedEvents[0]!.override).toBe(true);
      expect(acceptedEvents[0]!.fromState).toBe(from);
      expect(acceptedEvents[0]!.missing).toBe(`${from}: named gap`);
    });
  }

  test("override:true with a blank missing throws (L3)", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "needs-review";
    saveLoom(loom);

    expect(() => acceptLoom(loom.id, "alice", { override: true, missing: "   " })).toThrow(/non-blank .missing./);
    expect(getLoom(loom.id)!.state).toBe("needs-review"); // never flipped
  });

  // L5 accept-lock corollary (mandate 8): a child is consumed by the weave
  // rollup, never human-accepted directly.
  test("accepting a child loom (parentLoomId set) is refused", () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.parentLoomId = "root_x";
    loom.state = "ready";
    saveLoom(loom);

    expect(() => acceptLoom(loom.id, "alice")).toThrow(/child loom/);
    expect(getLoom(loom.id)!.state).toBe("ready"); // never flipped

    loom.state = "needs-review";
    saveLoom(loom);
    expect(() => acceptLoom(loom.id, "alice", { override: true, missing: "x" })).toThrow(/child loom/);
    expect(getLoom(loom.id)!.state).toBe("needs-review"); // never flipped
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
