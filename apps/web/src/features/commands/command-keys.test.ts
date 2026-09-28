// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { groupSessions, railJumpSlots, railRowsForCommandKeys } from "@/lib/session-groups";
import { deriveSessionList, sessionHref, sessionKey, type SidebarSession } from "@/lib/session-list";

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
    expect(counted(rows)).toEqual(["Alpha new", "Beta old", "Beta older"]);
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
    const recent = counted(rows, { activeSessionId: "s19" });
    expect(recent).toHaveLength(9);
    expect(recent[0]).toBe("Session 0");
    expect(sessionHref(row("s0", "Session 0"))).toBe("/projects/p1/sessions/s0");
  });
});

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
    expect(counted[0]?.title).toBe("Waiting");
  });

  test("a row the keys do not count wears nothing", () => {
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
    const folded = railJumpSlots(railRows(rows, new Set(["beta"])));
    expect(folded.get(sessionKey(row("c1", "Gamma")))).toBe(2);
    expect(folded.get(sessionKey(row("b1", "Beta")))).toBeUndefined();
  });
});
