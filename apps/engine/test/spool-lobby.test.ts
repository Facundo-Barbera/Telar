/**
 * THE LOBBY — mission control, ranked, never enumerated (§13.2). Pure
 * composition over already-read data, like `spool-focus.test.ts` proves
 * `pickupFrom` with — no store, no disk, every branch driven directly.
 */
import { describe, expect, test } from "bun:test";
import { composeLobby } from "../src/spool/lobby";
import type {
  SpoolArea,
  SpoolItem,
  SpoolLookOutcome,
  SpoolSubject,
  SpoolSubjectThreads,
  SpoolThreadView,
} from "@telar/engine-client";

const view = (over: Partial<SpoolThreadView["thread"]> = {}): SpoolThreadView => ({
  thread: {
    id: "t-1",
    subject: "ozom-gv",
    question: "Does our ad data match what the platforms say?",
    items: [],
    facts: [],
    created: "Sat 12:00",
    schemaVersion: 1,
    ...over,
  },
  ply: { verified: 0, unchecked: 0, open: 0, captures: 0 },
  items: [],
});

const threadsFor = (over: Partial<SpoolSubjectThreads> = {}): SpoolSubjectThreads => ({
  subject: "ozom-gv",
  permits: "draft",
  threads: [],
  loose: [],
  ...over,
});

const subject = (over: Partial<SpoolSubject> = {}): SpoolSubject => ({
  key: "ozom-gv",
  name: "Ozom GV",
  permits: "draft",
  created: "Sat 12:00",
  schemaVersion: 1,
  ...over,
});

const item = (over: Partial<SpoolItem> = {}): SpoolItem => ({
  id: "i-1",
  title: "an item",
  provenance: "you",
  captured: "Sat 12:00",
  ...over,
});

const noLook = (subjectKey: string): SpoolLookOutcome => ({ subject: subjectKey, fresh: false });

describe("composeLobby — the mission-control ranking", () => {
  test("a subject with a stuck-on-you thread, an unacked observation and a live session earns needsYou, moved and sessionLive", () => {
    const lobby = composeLobby({
      subjects: [subject({ key: "ozom-gv", area: "Ozom", color: "sea" })],
      areas: [{ name: "Ozom", ceiling: "draft", created: "Sat 12:00", schemaVersion: 1 }],
      map: [
        threadsFor({
          subject: "ozom-gv",
          threads: [view({ waiting: { kind: "you", note: "needs a yes/no" } })],
        }),
      ],
      looks: [
        {
          subject: "ozom-gv",
          fresh: false,
          look: {
            subject: "ozom-gv",
            schemaVersion: 1,
            lastLooked: "Sat 07:40",
            lastLookedAt: 0,
            world: { issues: [], pulls: [] },
            observations: [
              { id: "o-1", text: "PR #420 merged.", refs: [], seen: "Sat 07:40", seenAt: 0 },
              { id: "o-2", text: "Issue #12 closed.", refs: [], seen: "Sat 07:40", seenAt: 0 },
            ],
          },
          digest: [{ text: "8 PRs merged, 7 issues closed", observationIds: ["o-1", "o-2"] }],
        },
      ],
      items: [],
      sessionLive: { "ozom-gv": true },
    });

    expect(lobby.areas).toHaveLength(1);
    expect(lobby.areas[0]!.name).toBe("Ozom");
    expect(lobby.areas[0]!.ceiling).toBe("draft");
    const row = lobby.areas[0]!.subjects[0]!;
    expect(row.key).toBe("ozom-gv");
    expect(row.area).toBe("Ozom");
    expect(row.color).toBe("sea");
    // 1 stuck-on-you thread + 0 pinned-today (no `today` sent). Unacked
    // observations are a MOVED fact, not an ask on the user — they carry
    // into `moved.count` only, never into `needsYou` too.
    expect(row.needsYou).toBe(1);
    expect(row.moved).toEqual({ count: 2, line: "As of the look at Sat 07:40: 8 PRs merged, 7 issues closed" });
    expect(row.sessionLive).toBe(true);
    expect(row.folded).toBe(false);
  });

  test("a subject with only unacked observations (no stuck-on-you thread, no pin) still unfolds — via moved.count, not needsYou", () => {
    const lobby = composeLobby({
      subjects: [subject({ key: "ozom-gv", area: "Ozom" })],
      areas: [{ name: "Ozom", created: "Sat 12:00", schemaVersion: 1 }],
      map: [threadsFor({ subject: "ozom-gv" })],
      looks: [
        {
          subject: "ozom-gv",
          fresh: false,
          look: {
            subject: "ozom-gv",
            schemaVersion: 1,
            lastLooked: "Sat 07:40",
            lastLookedAt: 0,
            world: { issues: [], pulls: [] },
            observations: [{ id: "o-1", text: "PR #420 merged.", refs: [], seen: "Sat 07:40", seenAt: 0 }],
          },
          digest: [{ text: "1 PR merged", observationIds: ["o-1"] }],
        },
      ],
      items: [],
      sessionLive: { "ozom-gv": false },
    });
    const row = lobby.areas[0]!.subjects[0]!;
    expect(row.needsYou).toBe(0);
    expect(row.moved).toEqual({ count: 1, line: "As of the look at Sat 07:40: 1 PR merged" });
    expect(row.folded).toBe(false);
  });

  test("a subject with nothing pulling folds, and folded is computed here rather than left for a surface to guess", () => {
    const lobby = composeLobby({
      subjects: [subject({ key: "trivia", area: "Ozom" })],
      areas: [{ name: "Ozom", created: "Sat 12:00", schemaVersion: 1 }],
      map: [threadsFor({ subject: "trivia" })],
      looks: [noLook("trivia")],
      items: [],
      sessionLive: { trivia: false },
    });
    const row = lobby.areas[0]!.subjects[0]!;
    expect(row.needsYou).toBe(0);
    expect(row.moved).toEqual({ count: 0 });
    expect(row.sessionLive).toBe(false);
    expect(row.folded).toBe(true);
  });

  test("a bare subject (no terrain, so no look at all) still composes honestly — sessionLive is null, not a guessed false", () => {
    const lobby = composeLobby({
      subjects: [subject({ key: "casa", area: "Personal" })],
      areas: [{ name: "Personal", created: "Sat 12:00", schemaVersion: 1 }],
      map: [
        threadsFor({
          subject: "casa",
          threads: [view({ id: "t-2", subject: "casa", waiting: { kind: "you" } })],
        }),
      ],
      looks: [{ subject: "casa", fresh: false, note: "no terrain — nowhere to look" }],
      items: [],
      sessionLive: { casa: null },
    });
    const row = lobby.areas[0]!.subjects[0]!;
    // The one stuck-on-you thread is enough to earn a card even with no terrain.
    expect(row.needsYou).toBe(1);
    expect(row.moved).toEqual({ count: 0 });
    expect(row.sessionLive).toBeNull();
    expect(row.folded).toBe(false);
  });

  test("areas sort alphabetically, case-insensitively; subjects with no area ride unareaed, last", () => {
    const lobby = composeLobby({
      subjects: [
        subject({ key: "b-subject", area: "personal" }),
        subject({ key: "a-subject", area: "Ozom" }),
        subject({ key: "floating-subject" }),
      ],
      areas: [],
      map: [],
      looks: [],
      items: [],
      sessionLive: {},
    });
    expect(lobby.areas.map((a) => a.name)).toEqual(["Ozom", "personal"]);
    expect(lobby.unareaed).toHaveLength(1);
    expect(lobby.unareaed[0]!.key).toBe("floating-subject");
  });

  test("an area with no stated ceiling carries none — never a default", () => {
    const lobby = composeLobby({
      subjects: [subject({ key: "ozom-gv", area: "Ozom" })],
      areas: [{ name: "Ozom", created: "Sat 12:00", schemaVersion: 1 }],
      map: [],
      looks: [],
      items: [],
      sessionLive: {},
    });
    expect(lobby.areas[0]!.ceiling).toBeUndefined();
  });

  test("`today` gates the pinned-today and nextPin facts — absent, neither is computed", () => {
    const items = [
      item({ id: "i-1", project: "ozom-gv", pinned: { day: "2026-08-18" } }),
      item({ id: "i-2", project: "ozom-gv", pinned: { day: "2026-08-25" } }),
    ];
    const withoutToday = composeLobby({
      subjects: [subject({ key: "ozom-gv" })],
      areas: [],
      map: [],
      looks: [],
      items,
      sessionLive: {},
    });
    expect(withoutToday.unareaed[0]!.needsYou).toBe(0);
    expect(withoutToday.unareaed[0]!.nextPin).toBeUndefined();

    const withToday = composeLobby({
      subjects: [subject({ key: "ozom-gv" })],
      areas: [],
      map: [],
      looks: [],
      items,
      sessionLive: {},
      today: "2026-08-18",
    });
    const row = withToday.unareaed[0]!;
    expect(row.needsYou).toBe(1); // i-1 is pinned to today
    expect(row.nextPin).toEqual({ day: "2026-08-18", label: "Tuesday" });
    expect(row.folded).toBe(false);
  });

  test("nextPin is the SOONEST pin at-or-after today, never a past one", () => {
    const items = [item({ id: "i-1", project: "ozom-gv", pinned: { day: "2026-08-10" } })];
    const lobby = composeLobby({
      subjects: [subject({ key: "ozom-gv" })],
      areas: [],
      map: [],
      looks: [],
      items,
      sessionLive: {},
      today: "2026-08-18",
    });
    expect(lobby.unareaed[0]!.nextPin).toBeUndefined();
  });

  test("subjects within an area sort by rank ascending, unranked ones after — in their existing order", () => {
    const lobby = composeLobby({
      subjects: [
        subject({ key: "c-subject", area: "Ozom", rank: 3 }),
        subject({ key: "a-subject", area: "Ozom" }),
        subject({ key: "b-subject", area: "Ozom", rank: 1 }),
      ],
      areas: [{ name: "Ozom", created: "Sat 12:00", schemaVersion: 1 }],
      map: [],
      looks: [],
      items: [],
      sessionLive: {},
    });
    const ordered = lobby.areas[0]!.subjects.map((s) => s.key);
    expect(ordered).toEqual(["b-subject", "c-subject", "a-subject"]);
    expect(lobby.areas[0]!.subjects[0]!.rank).toBe(1);
  });

  test("a closed item's pin never counts toward needsYou or nextPin", () => {
    const items = [item({ id: "i-1", project: "ozom-gv", pinned: { day: "2026-08-18" }, closed: { label: "Sat", at: 0 } })];
    const lobby = composeLobby({
      subjects: [subject({ key: "ozom-gv" })],
      areas: [],
      map: [],
      looks: [],
      items,
      sessionLive: {},
      today: "2026-08-18",
    });
    expect(lobby.unareaed[0]!.needsYou).toBe(0);
    expect(lobby.unareaed[0]!.nextPin).toBeUndefined();
  });
});
