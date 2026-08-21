// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Loom, LoomOverview, LoomState, OverviewTriageEntry } from "@telar/engine-client";
import { classificationOrder, deckSections, loomStep, overviewActive, scopeOverview } from "./loom-deck";

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

function triage(
  item: string,
  classification: OverviewTriageEntry["classification"],
  projectId = "p1",
): OverviewTriageEntry {
  return { item, projectId, updatedAt: "r1", classification, reason: `because ${item}`, ask: "", at: 1 };
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

  test("AN ITEM WITH A LOOM IN ANY STATE HAS BEEN TAKEN", () => {
    /**
     * THE RULE, ACROSS THE WHOLE STATE SPACE — and it is a real bug fixed,
     * measured on live data: `a1` had a `published` loom and a `dispatchable`
     * triage entry, and the deck drew it under **Ready to review** AND under
     * **Ready, waiting for a slot**. One string, one page, two contradictory
     * statements about itself.
     *
     * The cache is not at fault and is not reconciled: it is re-read only when
     * the item's own `updatedAt` moves, which is what makes reading a whole
     * thread affordable. THE PROJECTION RECONCILES. An earlier guard excluded
     * only the in-flight states — the subset that happened to be on screen
     * while it was written — so this loops every state rather than naming the
     * four that were wrong.
     */
    for (const state of STATES) {
      const sections = deckSections(
        overview({
          projects: [project()],
          looms: [loom(state, { item: "taken" })],
          triage: [triage("taken", "dispatchable"), triage("free", "needs-decision")],
        }),
      );
      expect(
        sections.seen.flatMap((group) => group.entries.map((entry) => entry.item)),
        `an item with a ${state} loom is still listed as seen and not taken`,
      ).toEqual(["free"]);
    }
  });

  test("a stopped loom's item does not return to the pile, because the loom is already drawn", () => {
    /**
     * THE TEMPTING EXCEPTION, DECIDED. Nobody is working a `parked` or
     * `cancelled` loom, so the pile arguably owns its item again. It does not,
     * and the reason is about this page rather than about the words: the loom
     * is ALREADY on screen in **Stopped, with a reason**, carrying the reason
     * it stopped. The pile's copy would be the strictly worse statement — a
     * classification from before the work was attempted, beside a written
     * record of what actually happened.
     *
     * NOTHING IS DROPPED, WHICH IS WHAT MAKES THE EXCLUSION SAFE. This asserts
     * both halves together: absent from the pile, present in `closed`.
     */
    for (const state of ["parked", "cancelled"] as const) {
      const sections = deckSections(
        overview({
          projects: [project()],
          looms: [loom(state, { item: "stopped" })],
          triage: [triage("stopped", "dispatchable")],
        }),
      );
      expect(sections.seen).toEqual([]);
      expect(sections.closed.map((entry) => entry.item)).toEqual(["stopped"]);
    }
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

describe("scopeOverview — one project's slice of the one snapshot", () => {
  const two = () =>
    overview({
      projects: [project(), project({ projectId: "p2", name: "Two" })],
      looms: [loom("working"), loom("published", { id: "lm_p2", projectId: "p2", item: "other" })],
      triage: [triage("mine", "never"), triage("theirs", "never", "p2")],
      runs: [
        { id: "r1", projectId: "p1", kind: "tick", state: "done", startedAt: 1 },
        { id: "r2", projectId: "p2", kind: "tick", state: "done", startedAt: 1 },
      ] as LoomOverview["runs"],
    });

  test("looms, projects, triage and runs all narrow to the one project", () => {
    const scoped = scopeOverview(two(), "p1");
    expect(scoped.projects.map((entry) => entry.projectId)).toEqual(["p1"]);
    expect(scoped.looms.map((entry) => entry.projectId)).toEqual(["p1"]);
    expect(scoped.triage.map((entry) => entry.item)).toEqual(["mine"]);
    expect(scoped.runs.map((entry) => entry.id)).toEqual(["r1"]);
  });

  test("the slice comes out of the snapshot, so the piles still read the same way", () => {
    // The project page must not fetch anything the deck did not already have.
    const sections = deckSections(scopeOverview(two(), "p2"));
    expect(sections.review.map((entry) => entry.item)).toEqual(["other"]);
    expect(sections.seen.flatMap((group) => group.entries.map((entry) => entry.item))).toEqual(["theirs"]);
  });

  test("an unattributed entry lands on the only project there is", () => {
    // A daemon older than `OverviewTriageEntry.projectId` sends no owner. With
    // one project registered that is a FACT, not a guess, and blanking the
    // whole pile instead would be the worse answer.
    const stale = { ...triage("orphan", "never"), projectId: undefined } as OverviewTriageEntry;
    const scoped = scopeOverview(overview({ projects: [project()], triage: [stale] }), "p1");
    expect(scoped.triage.map((entry) => entry.item)).toEqual(["orphan"]);
  });

  test("with two projects an unattributed entry is guessed onto neither", () => {
    const stale = { ...triage("orphan", "never"), projectId: undefined } as OverviewTriageEntry;
    const both = overview({ projects: [project(), project({ projectId: "p2", name: "Two" })], triage: [stale] });
    expect(scopeOverview(both, "p1").triage).toEqual([]);
    expect(scopeOverview(both, "p2").triage).toEqual([]);
  });
});
