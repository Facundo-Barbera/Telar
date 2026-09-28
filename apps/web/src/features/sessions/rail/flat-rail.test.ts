import { describe, expect, test } from "bun:test";
import type { SessionAssignment } from "@telar/engine-client";
import { flatRailRows, flattenSessions, parentKeyOf, summarizeChildren } from "./flat-rail";
import { deriveSessionList, type SidebarSession } from "../session-list";

const NOW = 10_000_000;

const row = (id: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title: id,
  projectId: "p1",
  projectName: "alpha",
  activity: "idle",
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  ...over,
});

const task = (fromSessionId: string, receivedAt = NOW - 500): SessionAssignment => ({
  taskRunId: `run_${fromSessionId}_${receivedAt}`,
  fromSessionId,
  receivedAt,
  runId: `run_${fromSessionId}_${receivedAt}`,
});

const shape = (sessions: SidebarSession[], pinnedOrder: string[] = []) => {
  const list = deriveSessionList({ sessions, now: NOW, order: "activity", autoSettleAfterHours: null });
  return flattenSessions(list, pinnedOrder).map((entry) => [entry.session.id, entry.children.map((child) => child.id)]);
};

describe("flat rail ordering", () => {
  test("pinned first in their arranged order, then the rest by latest activity", () => {
    const sessions = [
      row("old-but-busy", { createdAt: NOW - 9000, updatedAt: NOW - 9000, activityAt: NOW - 10 }),
      row("new-and-quiet", { createdAt: NOW - 100, updatedAt: NOW - 100 }),
      row("middle", { createdAt: NOW - 5000, updatedAt: NOW - 400 }),
      row("pin-a", { settledOverride: "active", updatedAt: NOW - 1 }),
      row("pin-b", { settledOverride: "active", updatedAt: NOW - 9000 }),
    ];
    expect(shape(sessions, ["pin-b", "pin-a"]).map(([id]) => id)).toEqual(["pin-b", "pin-a", "old-but-busy", "new-and-quiet", "middle"]);
  });
});

describe("flat rail nesting", () => {
  test("a session assigned a task by another sits under it, and not top-level", () => {
    const sessions = [row("parent"), row("child", { assignments: [task("parent")], updatedAt: NOW - 10 })];
    expect(shape(sessions)).toEqual([["parent", ["child"]]]);
  });

  test("startedFrom wins over the task link", () => {
    const sessions = [
      row("a"),
      row("b"),
      row("child", { startedFrom: { sessionId: "b" }, assignments: [task("a")] }),
    ];
    expect(parentKeyOf(sessions[2]!)).toBe("b");
    expect(shape(sessions).find(([id]) => id === "b")).toEqual(["b", ["child"]]);
  });

  test("the earliest assignment is the one that spawned it", () => {
    expect(parentKeyOf(row("c", { assignments: [task("later", NOW - 10), task("first", NOW - 900)] }))).toBe("first");
  });

  test("a grandchild sits under the top-level row too", () => {
    const sessions = [
      row("root"),
      row("child", { startedFrom: { sessionId: "root" }, updatedAt: NOW - 20 }),
      row("grandchild", { startedFrom: { sessionId: "child" }, updatedAt: NOW - 10 }),
    ];
    expect(shape(sessions)).toEqual([["root", ["grandchild", "child"]]]);
  });

  test("a link to another Mac's session of the same id is not a parent", () => {
    const sessions = [row("parent"), row("child", { hostId: "h1", startedFrom: { sessionId: "parent" } })];
    expect(shape(sessions).map(([id]) => id).sort()).toEqual(["child", "parent"]);
  });

  test("a loop leaves every row in it top-level rather than hiding them", () => {
    const sessions = [row("a", { startedFrom: { sessionId: "b" } }), row("b", { startedFrom: { sessionId: "a" } })];
    expect(shape(sessions).map(([id]) => id).sort()).toEqual(["a", "b"]);
  });
});

describe("flat rail orphans", () => {
  test("a child whose parent is missing is a top-level row", () => {
    expect(shape([row("child", { startedFrom: { sessionId: "gone" } })])).toEqual([["child", []]]);
  });

  test("a child whose parent is settled is a top-level row", () => {
    const sessions = [row("parent", { settledOverride: "settled", settledAt: NOW - 50 }), row("child", { assignments: [task("parent")] })];
    expect(shape(sessions)).toEqual([["child", []]]);
  });

  test("a pinned child stays top-level where the person put it", () => {
    const sessions = [row("parent"), row("child", { settledOverride: "active", startedFrom: { sessionId: "parent" } })];
    expect(shape(sessions)).toEqual([["child", []], ["parent", []]]);
  });
});

describe("the collapsed summary", () => {
  const children = [
    row("w", { activity: "working" }),
    row("b", { activity: "blocked" }),
    row("q", { activity: "idle" }),
    row("open", { activity: "idle" }),
  ];

  test("counts the children and the working ones, and names who needs the person", () => {
    expect(summarizeChildren(children).label).toBe("4 sessions · 1 working · 1 needs you");
    expect(summarizeChildren([row("x")]).label).toBe("1 session");
  });

  test("a child that needs the person, or is being read, is surfaced while collapsed", () => {
    expect(summarizeChildren(children, "open").surfaced.map((child) => child.id)).toEqual(["b", "open"]);
    expect(summarizeChildren([row("wait", { activity: "waiting" })]).surfaced.map((child) => child.id)).toEqual(["wait"]);
  });

  test("the number keys count what is drawn: surfaced children when collapsed, all when open", () => {
    const entries = [{ session: row("p"), pinned: false, children }];
    expect(flatRailRows(entries, new Set()).map((session) => session.id)).toEqual(["p", "b"]);
    expect(flatRailRows(entries, new Set(["p"])).map((session) => session.id)).toEqual(["p", "w", "b", "q", "open"]);
  });
});
