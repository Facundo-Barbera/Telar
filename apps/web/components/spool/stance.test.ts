// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SpoolDeskCard, SpoolMap, SpoolThreadView } from "@telar/engine-client";
import { deriveStance } from "@/components/spool/stance";

/**
 * FOCUS IS AN APERTURE, NOT A SUGGESTION — reproducing the bug where a stance
 * focused on one subject rendered another subject's threads. Every derived
 * strip (open threads, settled threads, the "in its hands" band) has to agree
 * with the item-scoping the room already does correctly.
 */
function threadView(id: string, subject: string, extra: Partial<SpoolThreadView["thread"]> = {}): SpoolThreadView {
  return {
    thread: {
      id,
      subject,
      question: `question for ${id}`,
      handle: id,
      items: [],
      facts: [],
      created: "2026-08-01T00:00:00.000Z",
      schemaVersion: 1,
      ...extra,
    },
    ply: { verified: 0, unchecked: 0, open: 0, captures: 0 },
    items: [{ id: `${id}-item`, title: `item for ${id}` }],
  };
}

function fakeMap(): SpoolMap {
  return {
    subjects: [
      {
        subject: "telar-vnext",
        permits: "draft",
        threads: [
          threadView("t-agent-home", "telar-vnext", { waiting: { kind: "agent" } }),
          threadView("t-person-home", "telar-vnext", { waiting: { kind: "person", who: "Ana" } }),
          threadView("t-settled-home", "telar-vnext", {
            settled: { at: "2026-08-10T00:00:00.000Z", answer: "yes, it matches" },
          }),
        ],
        loose: [],
      },
      {
        subject: "ozom-gv",
        permits: "draft",
        threads: [
          threadView("t-agent-away", "ozom-gv", { waiting: { kind: "agent" } }),
          threadView("t-person-away", "ozom-gv", { waiting: { kind: "person", who: "Diego" } }),
          threadView("t-settled-away", "ozom-gv", {
            settled: { at: "2026-08-10T00:00:00.000Z", answer: "no, it diverges" },
          }),
        ],
        loose: [],
      },
    ],
    floating: [],
  };
}

describe("deriveStance scopes threads to the focused subject", () => {
  test("a focused stance contains no other subject's threads", () => {
    const model = deriveStance(fakeMap(), null, null, [], "telar-vnext", []);

    for (const t of [...model.onPerson, ...model.withAgent, ...model.settled]) {
      expect(t.subject).toBe("telar-vnext");
    }
    expect(model.withAgent.map((t) => t.view.thread.id)).toEqual(["t-agent-home"]);
    expect(model.onPerson.map((t) => t.view.thread.id)).toEqual(["t-person-home"]);
    expect(model.settled.map((t) => t.view.thread.id)).toEqual(["t-settled-home"]);
  });

  test("settled threads never surface in the with-agent (in its hands) group", () => {
    const model = deriveStance(fakeMap(), null, null, [], "telar-vnext", []);
    const settledIds = new Set(model.settled.map((t) => t.view.thread.id));
    for (const t of model.withAgent) {
      expect(settledIds.has(t.view.thread.id)).toBe(false);
    }
  });

  test("wide (unfocused) still sees every subject's threads", () => {
    const model = deriveStance(fakeMap(), null, null, [], undefined, []);
    expect(model.withAgent.length).toBe(2);
    expect(model.onPerson.length).toBe(2);
    expect(model.settled.length).toBe(2);
  });
});

describe("focus hides the unfiled fold — it belongs to no subject", () => {
  test("a focused room shows no unfiled items, even though wide does", () => {
    const desk = [{ id: "chore-1", title: "loose chore", unplaced: true }] as unknown as SpoolDeskCard[];
    const wide = deriveStance(fakeMap(), null, null, desk, undefined, []);
    expect(wide.housekeeping.length).toBe(1);

    const focused = deriveStance(fakeMap(), null, null, desk, "telar-vnext", []);
    expect(focused.housekeeping.length).toBe(0);
  });
});

describe("the pickup's moved lines are scoped like every other strip", () => {
  /**
   * THE LIVE BUG: `currentFocus` never ends a prior open entry, so several
   * subjects can be open at once (the dogfood log had ozom-gv, telar-vnext
   * AND casa open together). `pickup.moved` carries every open one's
   * sentences — before `SpoolMoved` carried no subject at all, so a room
   * "Focused on telar-vnext" rendered ozom-gv's "answered: …" line under its
   * own "In its hands" band. Each line is now addressed, and a focused room
   * has to filter on it the same way it filters threads.
   */
  const focus = {
    pickup: {
      current: [],
      moved: [
        { subject: "telar-vnext", text: "Stance scoping — answered: fixed." },
        { subject: "ozom-gv", text: "Hito 1 — answered: no, it diverges." },
        { subject: "casa", text: "Renovation quote — answered: 4200 EUR." },
      ],
      waiting: [],
    },
    days: [],
  } as unknown as Parameters<typeof deriveStance>[1];

  test("a focused room shows only its own subject's moved lines", () => {
    const model = deriveStance(fakeMap(), focus, null, [], "telar-vnext", []);
    expect(model.moved).toEqual([{ subject: "telar-vnext", text: "Stance scoping — answered: fixed." }]);
  });

  test("wide still sees every open subject's moved lines", () => {
    const model = deriveStance(fakeMap(), focus, null, [], undefined, []);
    expect(model.moved.length).toBe(3);
  });
});
