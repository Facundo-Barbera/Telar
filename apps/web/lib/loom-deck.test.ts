// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Loom, LoomOverview, LoomState, TriageEntry } from "@telar/engine-client";
import { classificationOrder, deckSections, loomStep, overviewActive } from "./loom-deck";

const STATES: LoomState[] = [
  "queued",
  "working",
  "gating",
  "publishing",
  "published",
  "stuck",
  "parked",
  "asking",
  "cancelled",
];

function loom(state: LoomState, extra: Partial<Loom> = {}): Loom {
  return {
    id: `lm_${state}`,
    projectId: "p1",
    item: `item-${state}`,
    title: `${state} thing`,
    state,
    attempts: 0,
    ladderRung: 0,
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  } as Loom;
}

function triage(item: string, classification: TriageEntry["classification"]): TriageEntry {
  return { item, updatedAt: "r1", classification, reason: `because ${item}`, ask: "", at: 1 };
}

function overview(partial: Partial<LoomOverview> = {}): LoomOverview {
  return { projects: [], looms: [], triage: [], runs: [], unreadable: [], ...partial };
}

/** Exhaustive by construction — the wire type promises every state is present. */
const ZERO_COUNTS = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<LoomState, number>;

const project = (extra: Record<string, unknown> = {}) =>
  ({
    projectId: "p1",
    name: "One",
    root: "/tmp/one",
    hasProgram: true,
    programPath: "/tmp/one/.telar/loom.md",
    watch: { projectId: "p1", running: false, intervalSec: 300, quietChecks: 0 },
    counts: ZERO_COUNTS,
    assumed: [],
    warnings: [],
    ...extra,
  }) as LoomOverview["projects"][number];

describe("deckSections", () => {
  test("EVERY loom state lands in exactly one section", () => {
    /**
     * THE PROPERTY THAT ACTUALLY MATTERS. "Nothing silently dropped" is the
     * product's promise, and the way it breaks is a tenth state being added
     * upstream and matching none of the four filters — which looks like an
     * empty row rather than like a bug. This is the test that catches it.
     */
    const sections = deckSections(overview({ projects: [project()], looms: STATES.map((state) => loom(state)) }));
    const placed = [
      ...sections.needsYou.filter((row) => row.kind === "loom").map((row) => (row as { loom: Loom }).loom.id),
      ...sections.review.map((entry) => entry.id),
      ...sections.working.flatMap((group) => group.looms.map((entry) => entry.id)),
      ...sections.closed.map((entry) => entry.id),
    ];
    expect(placed.sort()).toEqual(STATES.map((state) => `lm_${state}`).sort());
    expect(new Set(placed).size).toBe(STATES.length);
  });

  test("`asking` leads, because it is the only thing blocked on a person", () => {
    const sections = deckSections(overview({ projects: [project()], looms: [loom("asking")] }));
    expect(sections.needsYou).toHaveLength(1);
    expect(sections.needsYou[0]?.kind).toBe("loom");
  });

  test("an `asking` loom with no question still says something", () => {
    // A loom that escalated without writing down what it wanted is a bug
    // upstream. An empty warning box would read as a loading state.
    const sections = deckSections(overview({ projects: [project()], looms: [loom("asking")] }));
    const row = sections.needsYou[0] as { question: string };
    expect(row.question.length).toBeGreaterThan(0);
  });

  test("unconfirmed assumptions join the same queue", () => {
    // §4.4 — a wrong assumption you can see is survivable, an invisible one is
    // not. So it sits with everything else waiting on a person.
    const sections = deckSections(overview({ projects: [project({ assumed: ["`listo` means ready to work"] })] }));
    expect(sections.needsYou.map((row) => row.kind)).toEqual(["assumed"]);
  });

  test("in-flight looms are grouped by project, not interleaved by time", () => {
    const sections = deckSections(
      overview({
        projects: [project(), project({ projectId: "p2", name: "Two" })],
        looms: [loom("working"), { ...loom("gating"), id: "lm_other", projectId: "p2" } as Loom],
      }),
    );
    expect(sections.working.map((group) => group.projectId)).toEqual(["p1", "p2"]);
    expect(sections.working[1]?.name).toBe("Two");
  });

  test("an item currently held by a live loom is not also listed as not taken", () => {
    // The same string appearing twice on one page, saying two different things
    // about itself, is worse than either statement alone.
    const held = loom("working", { item: "held" });
    const sections = deckSections(
      overview({
        projects: [project()],
        looms: [held],
        triage: [triage("held", "dispatchable"), triage("free", "needs-decision")],
      }),
    );
    expect(sections.seen.flatMap((group) => group.entries.map((entry) => entry.item))).toEqual(["free"]);
  });

  test("the three blocked classifications come before the takeable ones", () => {
    // The middle three ARE the finding — they are the reasons a well-written
    // backlog is still not actionable, and nothing in a tracker distinguishes
    // them. Burying them under "ready" would be the old, useless ordering.
    const order = classificationOrder();
    expect(order.slice(0, 4)).toEqual(["needs-decision", "needs-credentials", "needs-split", "never"]);
  });

  test("empty classification piles are not drawn", () => {
    const sections = deckSections(overview({ projects: [project()], triage: [triage("a", "never")] }));
    expect(sections.seen.map((group) => group.classification)).toEqual(["never"]);
  });
});

describe("overviewActive — the polling cadence", () => {
  test("idle when nothing is moving", () => {
    expect(overviewActive(overview({ projects: [project()], looms: [loom("published")] }))).toBe(false);
  });

  test("a loom in flight is active", () => {
    expect(overviewActive(overview({ looms: [loom("gating")] }))).toBe(true);
  });

  test("`stuck` counts as active, because the ladder is still advancing it", () => {
    // `stuck` is not a failure state; it is the ladder's entry point and
    // something cheap has not been tried yet.
    expect(overviewActive(overview({ looms: [loom("stuck")] }))).toBe(true);
  });

  test("a running tick is active even with no looms", () => {
    expect(
      overviewActive(
        overview({
          runs: [{ id: "r", projectId: "p1", kind: "tick", state: "running", startedAt: 1, dispatched: [] }],
        }),
      ),
    ).toBe(true);
  });

  test("an armed watch keeps the surface alive, so work started elsewhere appears", () => {
    expect(
      overviewActive(overview({ projects: [project({ watch: { projectId: "p1", running: true, intervalSec: 300, quietChecks: 0 } })] })),
    ).toBe(true);
  });
});

describe("loomStep", () => {
  test("every state has a sentence", () => {
    for (const state of STATES) expect(loomStep(loom(state)).length).toBeGreaterThan(0);
  });

  test("`stuck` names the rung rather than calling it a failure", () => {
    expect(loomStep(loom("stuck", { ladderRung: 2 }))).toContain("rung 2");
  });

  test("a park with no written reason is reported as the bug it is", () => {
    expect(loomStep(loom("parked"))).toContain("bug");
  });
});
