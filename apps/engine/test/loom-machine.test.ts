/**
 * The loom state machine.
 *
 * Every legal edge is asserted individually, and so is a representative set of
 * illegal ones — including the three that would actually cost something: a
 * terminal loom coming back to life, a `queued` loom skipping straight to
 * `published`, and a self-transition passing for progress.
 */
import { describe, expect, test } from "bun:test";
import { LoomState, type Loom } from "@telar/engine-client";
import { TERMINAL_LOOM_STATES, canTransition, isActive, isTerminal, transitionLoom } from "../src/loom/machine";

const at = 1_700_000_000_000;

const loom = (state: Loom["state"]): Loom => ({
  id: "loom_1",
  projectId: "proj_1",
  item: "#457",
  title: "the identity backbone",
  state,
  attempts: 0,
  ladderRung: 0,
  createdAt: at,
  updatedAt: at,
});

const LEGAL: Array<[Loom["state"], Loom["state"]]> = [
  ["queued", "working"],
  ["queued", "stuck"],
  ["queued", "cancelled"],
  ["working", "gating"],
  ["working", "stuck"],
  ["working", "cancelled"],
  ["gating", "publishing"],
  ["gating", "stuck"],
  ["gating", "parked"],
  ["gating", "cancelled"],
  ["publishing", "published"],
  ["publishing", "stuck"],
  ["publishing", "cancelled"],
  ["stuck", "working"],
  ["stuck", "gating"],
  ["stuck", "asking"],
  ["stuck", "parked"],
  ["stuck", "cancelled"],
  ["asking", "queued"],
  ["asking", "working"],
  ["asking", "parked"],
  ["asking", "cancelled"],
];

describe("terminal states", () => {
  test("are exactly published, parked and cancelled", () => {
    expect([...TERMINAL_LOOM_STATES].sort()).toEqual(["cancelled", "parked", "published"]);
  });

  test("isTerminal / isActive read a loom or a bare state", () => {
    expect(isTerminal("published")).toBe(true);
    expect(isTerminal(loom("published"))).toBe(true);
    expect(isActive(loom("stuck"))).toBe(true);
    expect(isActive("cancelled")).toBe(false);
  });

  test("nothing leaves a terminal state — reopening is a NEW loom", () => {
    for (const from of TERMINAL_LOOM_STATES) {
      for (const to of LoomState.options) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe("legal transitions", () => {
  for (const [from, to] of LEGAL) {
    test(`${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
      expect(transitionLoom(loom(from), to).state).toBe(to);
    });
  }

  test("every non-terminal state can be cancelled by the human", () => {
    for (const state of LoomState.options) {
      if (TERMINAL_LOOM_STATES.has(state)) continue;
      expect(canTransition(state, "cancelled")).toBe(true);
    }
  });
});

describe("illegal transitions", () => {
  const ILLEGAL: Array<[Loom["state"], Loom["state"]]> = [
    ["queued", "published"], // skipping the gate entirely
    ["queued", "gating"], // nothing has been written yet
    ["queued", "publishing"],
    ["working", "published"], // the worker never publishes its own work
    ["working", "publishing"],
    ["working", "parked"], // parking is a decision made after gating
    ["gating", "working"], // going back needs the ladder, via stuck
    ["publishing", "gating"],
    ["publishing", "parked"],
    ["stuck", "published"], // the ladder never publishes directly
    ["stuck", "publishing"],
    ["asking", "gating"], // an answer re-dispatches; it does not resume a gate
    ["asking", "stuck"],
    ["published", "working"], // the three that would cost real money
    ["parked", "working"],
    ["cancelled", "queued"],
  ];

  for (const [from, to] of ILLEGAL) {
    test(`${from} ↛ ${to}`, () => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => transitionLoom(loom(from), to)).toThrow();
    });
  }

  test("a self-transition is not a transition", () => {
    for (const state of LoomState.options) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  test("the error names both states and what was legal instead", () => {
    expect(() => transitionLoom(loom("queued"), "published")).toThrow(/queued to published/);
    expect(() => transitionLoom(loom("queued"), "published")).toThrow(/working, stuck, cancelled/);
  });

  test("the error off a terminal state says terminal, not 'legal moves: none'", () => {
    expect(() => transitionLoom(loom("published"), "working")).toThrow(/terminal/);
    expect(() => transitionLoom(loom("published"), "working")).toThrow(/new loom/);
  });
});

describe("transitionLoom is pure", () => {
  test("the argument is not mutated and the result is a new object", () => {
    const before = loom("working");
    const after = transitionLoom(before, "gating");
    expect(before.state).toBe("working");
    expect(after).not.toBe(before);
    expect(after.id).toBe(before.id);
  });

  test("updatedAt is bumped unless the patch supplies one", () => {
    const before = loom("working");
    expect(transitionLoom(before, "gating").updatedAt).toBeGreaterThanOrEqual(at);
    expect(transitionLoom(before, "gating", { updatedAt: 42 }).updatedAt).toBe(42);
  });

  test("the patch lands, and cannot overwrite the state it was called with", () => {
    const after = transitionLoom(loom("gating"), "publishing", {
      gate: { command: "bun run ci", exitCode: 0, outcome: "pass" },
      attempts: 2,
    });
    expect(after.state).toBe("publishing");
    expect(after.gate?.outcome).toBe("pass");
    expect(after.attempts).toBe(2);
  });

  test("a park carries its reason and a publish carries its url", () => {
    expect(transitionLoom(loom("stuck"), "parked", { parkedReason: "touched .env" }).parkedReason).toBe(
      "touched .env",
    );
    expect(
      transitionLoom(loom("publishing"), "published", { publishedUrl: "https://x/pull/1" }).publishedUrl,
    ).toBe("https://x/pull/1");
  });
});
