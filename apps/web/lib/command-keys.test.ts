/**
 * WHICH ROWS ⌘1..⌘9 COUNT.
 *
 * The registry itself, the chord arithmetic and the focus rule are pinned next
 * door in `commands.test.ts`. What is left here is the one question that is
 * about the RAIL rather than about keys: the jump commands promise the Nth row
 * as drawn, and "as drawn" is a derivation with bands, arranged groups and folds
 * in it.
 *
 * WHAT THIS WOULD HAVE CAUGHT: a jump that counted the flat list by creation
 * time — which is what it did until the groups landed, and which makes ⌘3 a
 * shortcut you have to look at the screen to use.
 */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { commandDestination, jumpDestinations } from "./command-keys";
import { AGENT_JUMP_SLOT, groupSessions, railJumpSlots, railRowsForCommandKeys, railSessionSlots } from "./session-groups";
import { deriveSessionList, sessionHref, sessionKey, type SidebarSession } from "./session-list";

const NOW = 1_800_000_000_000;

const row = (id: string, title: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title,
  projectId: "p1",
  activity: "idle",
  createdAt: NOW - 1_000,
  updatedAt: NOW - 1_000,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  ...over,
});

describe("what ⌘1..⌘9 count", () => {
  // The rail's own derivation, exactly as `app-sidebar.tsx` runs it: banded,
  // then grouped in the reader's order, then walked top to bottom.
  const counted = (rows: SidebarSession[], options: { order?: string[]; collapsed?: Set<string>; activeSessionId?: string } = {}) =>
    railRowsForCommandKeys(
      groupSessions(
        deriveSessionList({
          sessions: rows,
          now: NOW,
          autoSettleAfterHours: 72,
          ...(options.activeSessionId ? { activeSessionId: options.activeSessionId } : {}),
        }),
        options.order ?? [],
      ),
      options.collapsed,
    ).map((session) => session.title);

  test("pinned rows come first, because that is where the rail draws them", () => {
    const rows = [
      row("s1", "Newest", { createdAt: NOW - 1_000 }),
      row("s2", "Older", { createdAt: NOW - 2_000 }),
      row("s3", "Kept", { createdAt: NOW - 9_000, settledOverride: "active" }),
    ];
    // A ⌘1 that skipped the row sitting at the top of the rail would be a
    // shortcut you have to look at the screen to use.
    expect(counted(rows)).toEqual(["Kept", "Newest", "Older"]);
  });

  test("a blocked row outranks even the pin — the 'Needs you' band is drawn above everything", () => {
    const rows = [
      row("s1", "Kept", { settledOverride: "active" }),
      row("s2", "Waiting", { activity: "blocked", createdAt: NOW - 9_000 }),
      row("s3", "Plain"),
    ];
    expect(counted(rows)).toEqual(["Waiting", "Kept", "Plain"]);
  });

  test("the groups count in the reader's own order, not by which conversation is newest", () => {
    const rows = [
      row("a1", "Alpha new", { projectId: "alpha", projectName: "Alpha", createdAt: NOW - 1_000 }),
      row("b1", "Beta old", { projectId: "beta", projectName: "Beta", createdAt: NOW - 5_000 }),
      row("b2", "Beta older", { projectId: "beta", projectName: "Beta", createdAt: NOW - 6_000 }),
    ];
    // Nobody arranged anything: alphabetical, and Alpha's brand-new session
    // does not hoist it — it was first by name anyway.
    expect(counted(rows)).toEqual(["Alpha new", "Beta old", "Beta older"]);
    // Beta dragged above Alpha: ⌘1 is now Beta's top row, whatever was created when.
    expect(counted(rows, { order: ["beta", "alpha"] })).toEqual(["Beta old", "Beta older", "Alpha new"]);
  });

  test("a folded group's rows are not countable — a number on a row you cannot see is one you cannot check", () => {
    const rows = [
      row("a1", "Alpha", { projectId: "alpha", projectName: "Alpha" }),
      row("b1", "Beta", { projectId: "beta", projectName: "Beta" }),
      row("c1", "Gamma", { projectId: "gamma", projectName: "Gamma" }),
    ];
    expect(counted(rows, { collapsed: new Set(["beta"]) })).toEqual(["Alpha", "Gamma"]);
  });

  test("shelved rows are not countable — you said you did not want them in front of you", () => {
    const rows = [
      row("s1", "Live"),
      row("s2", "Asleep", { snoozedUntil: NOW + 3_600_000, snoozedAt: NOW - 1_000 }),
      row("s3", "Shelved", { settledOverride: "settled" }),
    ];
    expect(counted(rows)).toEqual(["Live"]);
  });

  test("never more than nine, whatever the survivor rule pins into view", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`s${index}`, `Session ${index}`, { createdAt: NOW - index * 1_000 }));
    // The open session is pinned onto the page past the limit, which is right
    // for rendering and meaningless for indexing — hence the slice.
    const recent = counted(rows, { activeSessionId: "s19" });
    expect(recent).toHaveLength(9);
    expect(recent[0]).toBe("Session 0");
    expect(sessionHref(row("s0", "Session 0"))).toBe("/projects/p1/sessions/s0");
  });
});

/**
 * WHICH NUMBER EACH ROW WEARS while ⌘ is held — issue #401.
 *
 * The hints are drawn from `railJumpSlots` over the SAME array `useCommandKeys`
 * is handed, which is the only arrangement in which a row's number and the key
 * that fires cannot disagree. So the claim under test is a correspondence rather
 * than a table: whatever the block above says ⌘N counts, the Nth of those rows
 * is the one wearing N.
 */
describe("the numbers a row wears line up with what the keys count", () => {
  const railRows = (rows: SidebarSession[], collapsed?: Set<string>) =>
    railRowsForCommandKeys(groupSessions(deriveSessionList({ sessions: rows, now: NOW, autoSettleAfterHours: 72 }), []), collapsed);

  test("slot N is the Nth counted row, bands, groups and folds included", () => {
    const rows = [
      row("s1", "Waiting", { activity: "blocked", createdAt: NOW - 9_000 }),
      row("s2", "Kept", { settledOverride: "active", createdAt: NOW - 8_000 }),
      row("a1", "Alpha", { projectId: "alpha", projectName: "Alpha" }),
      row("b1", "Beta", { projectId: "beta", projectName: "Beta" }),
    ];
    const counted = railRows(rows);
    const slots = railJumpSlots(counted);
    expect(counted.map((session) => slots.get(sessionKey(session)))).toEqual([1, 2, 3, 4]);
    // Said the other way round, which is the promise a reader makes with their
    // fingers: the row wearing ⌘1 is the row at the top of the rail.
    expect(counted[0]?.title).toBe("Waiting");
  });

  test("a row the keys do not count wears nothing", () => {
    // The tenth row down: there is no ⌘10, and a number it could not honour is
    // worse than no number.
    const rows = Array.from({ length: 12 }, (_, index) => row(`s${index}`, `Session ${index}`, { createdAt: NOW - index * 1_000 }));
    const slots = railJumpSlots(railRows(rows));
    expect(slots.size).toBe(9);
    expect(slots.get(sessionKey(row("s9", "Session 9")))).toBeUndefined();
  });

  test("folding a group renumbers the rows below it, exactly as the keys do", () => {
    const rows = [
      row("a1", "Alpha", { projectId: "alpha", projectName: "Alpha" }),
      row("b1", "Beta", { projectId: "beta", projectName: "Beta" }),
      row("c1", "Gamma", { projectId: "gamma", projectName: "Gamma" }),
    ];
    const open = railJumpSlots(railRows(rows));
    expect(open.get(sessionKey(row("c1", "Gamma")))).toBe(3);
    // Beta folded away: Gamma moves up on screen, and its number moves with it.
    const folded = railJumpSlots(railRows(rows, new Set(["beta"])));
    expect(folded.get(sessionKey(row("c1", "Gamma")))).toBe(2);
    expect(folded.get(sessionKey(row("b1", "Beta")))).toBeUndefined();
  });
});

/**
 * ⌘1 OPENS THE AGENT WHEN THE RAIL DRAWS IT — issue #569.
 *
 * WHAT THIS WOULD HAVE CAUGHT is what shipped: the Agent's entry is pinned above
 * every band, so it is the FIRST thing in the rail, and the jumps counted from
 * the row under it — the one entry always on screen was the one entry no number
 * key could reach.
 *
 * THE TWO HALVES HAVE TO MOVE TOGETHER. `jumpDestinations` decides what a key
 * OPENS and `railJumpSlots` decides what a row WEARS; one shifting without the
 * other puts ⌘2 on the row ⌘1 opens, which is worse than no number at all. So
 * both are asserted against the same fact here.
 */
describe("the Agent's place in the numbers", () => {
  const AGENT = "/agent";
  const rows = [
    row("s1", "First", { createdAt: NOW - 1_000 }),
    row("s2", "Second", { createdAt: NOW - 2_000 }),
    row("s3", "Third", { createdAt: NOW - 3_000 }),
  ];
  const hrefs = rows.map((session) => sessionHref(session));

  test("shown: ⌘1 is the Agent and the conversations start at ⌘2", () => {
    const destinations = jumpDestinations(hrefs, AGENT);
    expect(commandDestination("jump-1", destinations)).toEqual({ kind: "navigate", href: AGENT });
    expect(commandDestination("jump-2", destinations)).toEqual({ kind: "navigate", href: "/projects/p1/sessions/s1" });
    expect(commandDestination("jump-4", destinations)).toEqual({ kind: "navigate", href: "/projects/p1/sessions/s3" });
    // Nothing is in the fifth place, and a key that promised a conversation
    // there would open whatever happened to be last.
    expect(commandDestination("jump-5", destinations)).toEqual({ kind: "noop" });
  });

  test("hidden: nothing moves — a Mac with the Agent off has the keys it always had", () => {
    const destinations = jumpDestinations(hrefs);
    expect(commandDestination("jump-1", destinations)).toEqual({ kind: "navigate", href: "/projects/p1/sessions/s1" });
    expect(commandDestination("jump-3", destinations)).toEqual({ kind: "navigate", href: "/projects/p1/sessions/s3" });
  });

  test("it is the VIEWED Mac's Agent, because that is the row that was drawn", () => {
    expect(jumpDestinations(hrefs, "/hosts/host_mini/agent")[0]).toBe("/hosts/host_mini/agent");
  });

  test("the badges shift with the keys, so a row wears the chord that opens it", () => {
    const counted = railRowsForCommandKeys(groupSessions(deriveSessionList({ sessions: rows, now: NOW, autoSettleAfterHours: 72 }), []), undefined, {
      agentEntry: true,
    });
    const slots = railJumpSlots(counted, { agentEntry: true });
    expect(AGENT_JUMP_SLOT).toBe(1);
    expect(counted.map((session) => slots.get(sessionKey(session)))).toEqual([2, 3, 4]);
    // Said the other way round: the row the badge numbers is the row the key
    // opens. `jumpDestinations` is handed the same array.
    const destinations = jumpDestinations(counted.map((session) => sessionHref(session)), AGENT);
    for (const session of counted) {
      expect(destinations[slots.get(sessionKey(session))! - 1]).toBe(sessionHref(session));
    }
  });

  test("nine numbers, not ten: the Agent spends one of them", () => {
    const many = Array.from({ length: 20 }, (_, index) => row(`s${index}`, `Session ${index}`, { createdAt: NOW - index * 1_000 }));
    expect(railSessionSlots(true)).toBe(8);
    expect(railSessionSlots(false)).toBe(9);
    const counted = railRowsForCommandKeys(groupSessions(deriveSessionList({ sessions: many, now: NOW, autoSettleAfterHours: 72 }), []), undefined, {
      agentEntry: true,
    });
    expect(counted).toHaveLength(8);
    expect(railJumpSlots(counted, { agentEntry: true }).get(sessionKey(many[7]!))).toBe(9);
    expect(jumpDestinations(counted.map((session) => sessionHref(session)), AGENT)).toHaveLength(9);
  });
});
