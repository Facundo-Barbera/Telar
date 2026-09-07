// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { dedupeAcrossHosts, groupSessions, moveProjectGroup, orderProjectGroups, projectGroupKey, type ProjectGroup } from "./session-groups";
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

const group = (key: string, name: string, over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key,
  projectId: key,
  name,
  sessions: [],
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

  test("same project id on two hosts is two groups, this Mac's first", () => {
    const local = row("a");
    const remote = row("a", { hostId: "h1", hostName: "Studio" });
    const out = groupSessions({ pinned: [], sessions: [remote, local] });
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

  test("a new conversation does not move its project — the groups sit where they sit", () => {
    // THE BUG THIS FILE NOW EXISTS TO PREVENT. Starting a conversation in beta
    // used to hoist beta to the top because the groups came out in the order
    // of their newest session. Now the arrangement is the reader's.
    const before = groupSessions({
      pinned: [],
      sessions: [row("a1", { createdAt: 5 }), row("b1", { projectId: "p2", projectName: "beta", createdAt: 3 })],
    });
    const after = groupSessions({
      pinned: [],
      sessions: [row("b2", { projectId: "p2", projectName: "beta", createdAt: 9 }), row("a1", { createdAt: 5 }), row("b1", { projectId: "p2", projectName: "beta", createdAt: 3 })],
    });
    expect(before.groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
    expect(after.groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
    // Within the group, the newest conversation is still on top.
    expect(after.groups[1]?.sessions.map((s) => s.id)).toEqual(["b2", "b1"]);
  });

  test("the reader's order wins, and groups nobody placed fall in after it alphabetically", () => {
    const out = groupSessions(
      {
        pinned: [],
        sessions: [
          row("a", { projectId: "alpha", projectName: "Alpha" }),
          row("b", { projectId: "beta", projectName: "Beta" }),
          row("c", { projectId: "gamma", projectName: "Gamma" }),
          row("d", { projectId: "delta", projectName: "Delta" }),
        ],
      },
      ["gamma", "beta"],
    );
    expect(out.groups.map((g) => g.name)).toEqual(["Gamma", "Beta", "Alpha", "Delta"]);
  });
});

describe("orderProjectGroups", () => {
  test("unplaced groups sort by name, case-insensitively, then this Mac before a paired one", () => {
    const out = orderProjectGroups([
      group("h1:z", "zulu", { hostId: "h1", hostName: "Studio" }),
      group("z", "Zulu"),
      group("a", "alpha"),
      group("B", "Bravo"),
    ]);
    expect(out.map((g) => g.key)).toEqual(["a", "B", "z", "h1:z"]);
  });

  test("a stored key the rail is not drawing costs nothing", () => {
    const out = orderProjectGroups([group("a", "alpha"), group("b", "beta")], ["gone", "b", "a"]);
    expect(out.map((g) => g.key)).toEqual(["b", "a"]);
  });
});

describe("moveProjectGroup", () => {
  const drawn = ["a", "b", "c", "d"];

  test("lands above or below the target, and writes the whole drawn order", () => {
    expect(moveProjectGroup([], drawn, "d", "b", "above")).toEqual(["a", "d", "b", "c"]);
    expect(moveProjectGroup([], drawn, "d", "b", "below")).toEqual(["a", "b", "d", "c"]);
    expect(moveProjectGroup([], drawn, "a", "d", "below")).toEqual(["b", "c", "d", "a"]);
  });

  test("dropping a group on itself, or on a group not drawn, changes nothing", () => {
    expect(moveProjectGroup([], drawn, "b", "b", "above")).toEqual(drawn);
    expect(moveProjectGroup([], drawn, "b", "zz", "above")).toEqual(drawn);
    expect(moveProjectGroup([], drawn, "zz", "b", "above")).toEqual(drawn);
  });

  test("stored keys the rail is not drawing keep their slot rather than being pruned", () => {
    // `away` is a paired Mac's project that did not answer this tick; `quiet`
    // has nothing live. Neither is on screen; both keep their place relative
    // to the groups that are.
    const stored = ["a", "away", "b", "quiet", "c"];
    expect(moveProjectGroup(stored, ["a", "b", "c"], "c", "a", "above")).toEqual(["c", "a", "away", "b", "quiet"]);
    // A stored key whose every neighbour moved still lands somewhere sane —
    // after the last stored key that IS drawn before it.
    expect(moveProjectGroup(["x", "a", "b"], ["a", "b"], "b", "a", "above")).toEqual(["x", "b", "a"]);
  });
});

describe("dedupeAcrossHosts", () => {
  test("the same engine read twice draws once, and the local read wins", () => {
    // A Mac paired with itself, or paired under two addresses: both reads
    // carry one daemonId, so their rows are one set. The local read comes
    // first and keeps its rows (no hop); the remote's twins are dropped.
    const local = { daemonId: "d1", sessions: [row("a"), row("b")] };
    const twin = { daemonId: "d1", sessions: [row("a", { hostId: "host_x", hostName: "mini" }), row("c", { hostId: "host_x", hostName: "mini" })] };
    const other = { daemonId: "d2", sessions: [row("a", { hostId: "host_y", hostName: "studio" })] };
    const out = dedupeAcrossHosts([local, twin, other]);
    expect(out.map((session) => `${session.hostId ?? "local"}:${session.id}`)).toEqual(["local:a", "local:b", "host_x:c", "host_y:a"]);
  });

  test("a read that could not name its engine is kept as it is", () => {
    // Unproven identity never drops a row: a Mac whose health did not answer
    // may or may not be another read's twin, and showing twice is the
    // recoverable mistake.
    const local = { daemonId: "d1", sessions: [row("a")] };
    const unknown = { sessions: [row("a", { hostId: "host_x", hostName: "mini" })] };
    expect(dedupeAcrossHosts([local, unknown])).toHaveLength(2);
  });
});
