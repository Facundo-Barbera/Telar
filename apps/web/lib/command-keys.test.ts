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
import { groupSessions, railRowsForCommandKeys } from "./session-groups";
import { deriveSessionList, sessionHref, type SidebarSession } from "./session-list";

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
