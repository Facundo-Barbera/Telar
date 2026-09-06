// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { groupSessions, projectGroupKey } from "./session-groups";
import type { SidebarSession } from "./session-list";

const row = (id: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title: id,
  projectId: "p1",
  projectName: "alpha",
  activity: "idle",
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  ...over,
});

describe("groupSessions", () => {
  test("attention beats pinned, pinned beats project, each row once", () => {
    const blockedPinned = row("a", { activity: "blocked", settledOverride: "active" });
    const pinned = row("b", { settledOverride: "active" });
    const plain = row("c");
    const other = row("d", { projectId: "p2", projectName: "beta" });
    const out = groupSessions({ pinned: [blockedPinned, pinned], sessions: [plain, other, plain] });
    expect(out.attention.map((s) => s.id)).toEqual(["a"]);
    expect(out.pinned.map((s) => s.id)).toEqual(["b"]);
    expect(out.groups.map((g) => [g.name, g.sessions.map((s) => s.id)])).toEqual([
      ["alpha", ["c"]],
      ["beta", ["d"]],
    ]);
  });

  test("same project id on two hosts is two groups", () => {
    const local = row("a");
    const remote = row("a", { hostId: "h1", hostName: "Studio" });
    const out = groupSessions({ pinned: [], sessions: [local, remote] });
    expect(out.groups.map((g) => g.key)).toEqual(["p1", "h1:p1"]);
    expect(out.groups[1]?.hostName).toBe("Studio");
  });

  test("project-less rows are never grouped", () => {
    const out = groupSessions({ pinned: [], sessions: [row("m", { projectId: undefined })] });
    expect(out.groups).toEqual([]);
    expect(out.attention).toEqual([]);
  });

  test("group key qualifies by host", () => {
    expect(projectGroupKey({ projectId: "p" })).toBe("p");
    expect(projectGroupKey({ projectId: "p", hostId: "h" })).toBe("h:p");
  });
});
