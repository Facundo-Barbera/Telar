/**
 * THE RE-ENTRY BRIEF — a subject's room, opened (§13.2). Pure composition,
 * proved the same way `spool-focus.test.ts` proves `pickupFrom`: fixtures
 * built by hand, no store, no disk.
 */
import { describe, expect, test } from "bun:test";
import { composeBrief } from "../src/spool/brief";
import type {
  SpoolItem,
  SpoolLookOutcome,
  SpoolNote,
  SpoolPickup,
  SpoolSubjectRow,
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

const item = (over: Partial<SpoolItem> = {}): SpoolItem => ({
  id: "i-1",
  title: "an item",
  provenance: "you",
  captured: "Sat 12:00",
  project: "ozom-gv",
  ...over,
});

const row = (i: SpoolItem, lane?: string, rank?: number): SpoolSubjectRow => ({
  item: i,
  ...(lane ? { lane } : {}),
  ...(rank !== undefined ? { rank } : {}),
});

const note = (over: Partial<SpoolNote> = {}): SpoolNote => ({
  id: "n-1",
  title: "a note",
  body: "body",
  tags: [],
  created: { label: "Sat 12:00", at: 0 },
  updated: { label: "Sat 12:00", at: 0 },
  author: "you",
  schemaVersion: 1,
  ...over,
});

const emptyPickup: SpoolPickup = { current: [], moved: [], waiting: [] };

const noLook = (subjectKey: string): SpoolLookOutcome => ({ subject: subjectKey, fresh: false });

describe("composeBrief — the re-entry brief", () => {
  test("pickup is filtered to THIS subject's own entries — another subject's focus never leaks in", () => {
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: {
        current: [
          { id: "f-1", subject: "ozom-gv", label: "Sat 07:40", day: "Saturday", at: 0, schemaVersion: 1 },
          { id: "f-2", subject: "telar-vnext", label: "Sat 07:41", day: "Saturday", at: 0, schemaVersion: 1 },
        ],
        moved: [
          { subject: "ozom-gv", text: "Hito 1 — answered: yes." },
          { subject: "telar-vnext", text: "unrelated." },
        ],
        waiting: [],
      },
      threads: threadsFor(),
      look: noLook("ozom-gv"),
      rows: [],
      notes: [],
    });
    expect(brief.pickup.current).toHaveLength(1);
    expect(brief.pickup.current[0]!.id).toBe("f-1");
    expect(brief.pickup.moved).toEqual([{ subject: "ozom-gv", text: "Hito 1 — answered: yes." }]);
  });

  test("open splits stuck-on-you from waiting-on-others, and drops settled threads entirely", () => {
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: emptyPickup,
      threads: threadsFor({
        threads: [
          view({ id: "t-you", waiting: { kind: "you", note: "needs a yes/no" } }),
          view({ id: "t-ana", waiting: { kind: "person", who: "Ana", note: "needs the live tracker" } }),
          view({ id: "t-settled", settled: { at: "Sat", answer: "done" } }),
        ],
      }),
      look: noLook("ozom-gv"),
      rows: [],
      notes: [],
    });
    expect(brief.open.stuckOnYou).toEqual([{ threadId: "t-you", question: "Does our ad data match what the platforms say?", note: "needs a yes/no" }]);
    expect(brief.open.waitingOnOthers).toEqual([
      { threadId: "t-ana", question: "Does our ad data match what the platforms say?", who: "Ana", note: "needs the live tracker" },
    ]);
  });

  test("sinceYourLook carries the stored look outcome whole — the honest fresh:false of a stored-only read", () => {
    const look: SpoolLookOutcome = {
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
    };
    const brief = composeBrief({ key: "ozom-gv", pickup: emptyPickup, threads: threadsFor(), look, rows: [], notes: [] });
    expect(brief.sinceYourLook).toEqual(look);
    expect(brief.sinceYourLook.fresh).toBe(false);
  });

  test("next: pinned-to-today first, then briefed/drafted rows in their own chain order, capped at 3, every one cited", () => {
    const rows = [
      row(item({ id: "i-lane1-1", fixed: "briefed" }), "office", 1),
      row(item({ id: "i-lane1-2", draft: "an approach" }), "office", 2),
      row(item({ id: "i-unfiled", draft: "approach" })),
      row(item({ id: "i-captured-only" })), // not prepared — excluded
      row(item({ id: "i-pinned", pinned: { day: "2026-08-18" }, fixed: "briefed" })),
    ];
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: emptyPickup,
      threads: threadsFor(),
      look: noLook("ozom-gv"),
      rows,
      notes: [],
      today: "2026-08-18",
    });
    expect(brief.next).toEqual([
      { itemId: "i-pinned", title: "an item", source: "pinned to 2026-08-18" },
      { itemId: "i-lane1-1", title: "an item", source: "briefed, rank 1 in office" },
      { itemId: "i-lane1-2", title: "an item", source: "drafted, rank 2 in office" },
    ]);
  });

  test("without `today`, next skips the pinned-first pass entirely rather than guessing", () => {
    const rows = [row(item({ id: "i-pinned", pinned: { day: "2026-08-18" } })), row(item({ id: "i-briefed", fixed: "b" }), "office", 1)];
    const brief = composeBrief({ key: "ozom-gv", pickup: emptyPickup, threads: threadsFor(), look: noLook("ozom-gv"), rows, notes: [] });
    expect(brief.next).toEqual([{ itemId: "i-briefed", title: "an item", source: "briefed, rank 1 in office" }]);
  });

  test("notes: count is the active shelf only, and latestTitle is the most recently updated one — retired notes count for neither", () => {
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: emptyPickup,
      threads: threadsFor(),
      look: noLook("ozom-gv"),
      rows: [],
      notes: [
        note({ id: "n-1", title: "older", updated: { label: "Fri", at: 1 } }),
        note({ id: "n-2", title: "newer", updated: { label: "Sat", at: 2 } }),
        note({ id: "n-3", title: "retired one", retired: { label: "Sun", at: 3, reason: "stale" }, updated: { label: "Sun", at: 3 } }),
      ],
    });
    expect(brief.notes).toEqual({ count: 2, latestTitle: "newer" });
  });

  test("notes: absent latestTitle when there are no active notes at all", () => {
    const brief = composeBrief({ key: "ozom-gv", pickup: emptyPickup, threads: threadsFor(), look: noLook("ozom-gv"), rows: [], notes: [] });
    expect(brief.notes).toEqual({ count: 0 });
  });

  test("deadItems: untouched — no pin, no thread, never briefed or drafted — capped at 3, facts only", () => {
    const rows = [
      row(item({ id: "i-dead-1" })),
      row(item({ id: "i-dead-2" })),
      row(item({ id: "i-dead-3" })),
      row(item({ id: "i-dead-4" })), // the 4th is a candidate too, but the cap keeps it out
      row(item({ id: "i-pinned", pinned: { day: "2026-08-18" } })), // has a pin — not dead
      row(item({ id: "i-briefed", fixed: "b" })), // has work-state — not dead
      row(item({ id: "i-claimed" })), // claimed by a thread — not dead
    ];
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: emptyPickup,
      threads: threadsFor({ threads: [view({ items: ["i-claimed"] })] }),
      look: noLook("ozom-gv"),
      rows,
      notes: [],
    });
    expect(brief.deadItems).toHaveLength(3);
    expect(brief.deadItems.map((d) => d.itemId)).toEqual(["i-dead-1", "i-dead-2", "i-dead-3"]);
  });

  test("a closed row is excluded from both next and deadItems — the tracker does not outlive the task", () => {
    const rows = [row(item({ id: "i-closed", closed: { label: "Sat", at: 0 } }))];
    const brief = composeBrief({ key: "ozom-gv", pickup: emptyPickup, threads: threadsFor(), look: noLook("ozom-gv"), rows, notes: [] });
    expect(brief.next).toEqual([]);
    expect(brief.deadItems).toEqual([]);
  });

  test("a thread that references a settled question still claims its items — a settled thread's captures are not dead", () => {
    const rows = [row(item({ id: "i-claimed" }))];
    const brief = composeBrief({
      key: "ozom-gv",
      pickup: emptyPickup,
      threads: threadsFor({ threads: [view({ items: ["i-claimed"], settled: { at: "Sat", answer: "yes" } })] }),
      look: noLook("ozom-gv"),
      rows,
      notes: [],
    });
    expect(brief.deadItems).toEqual([]);
  });
});
