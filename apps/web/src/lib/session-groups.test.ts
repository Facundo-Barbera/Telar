// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  dedupeAcrossHosts,
  foldedAfter,
  groupSessions,
  moveProjectGroup,
  moveProjectGroupStep,
  moveSessionRow,
  orderProjectGroups,
  orderSessions,
  projectGroupKey,
  type ProjectGroup,
} from "./session-groups";
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

  test("two Macs' checkouts of ONE repository share a key, whatever their ids and names", () => {
    const here = { projectId: "project_here", projectRemote: "github.com/owner/repo" };
    const there = { projectId: "project_over_there", hostId: "host_b", projectRemote: "github.com/owner/repo" };
    expect(projectGroupKey(there)).toBe(projectGroupKey(here));
    expect(projectGroupKey(here)).toBe("repo:github.com/owner/repo");
  });

  test("two different repositories keep two keys", () => {
    expect(projectGroupKey({ projectId: "p", projectRemote: "github.com/owner/repo" })).not.toBe(
      projectGroupKey({ projectId: "p", projectRemote: "github.com/owner/other" }),
    );
  });

  test("a row with no repository to name keeps the host-qualified key", () => {
    // The important half: a project with no origin, an unversioned directory, a
    // Mac still loading its list. Folding those on their NAME would merge two
    // unrelated folders both called `scratch` — a worse failure than the one
    // the remote fixes — so an absent answer is never treated as an answer.
    expect(projectGroupKey({ projectId: "p", hostId: "h", projectRemote: undefined })).toBe("h:p");
    expect(projectGroupKey({ projectId: "p", projectRemote: "" })).toBe("p");
  });

  test("the prefix keeps a repository from colliding with a host-qualified key", () => {
    // A host id of `github.com` with a project id of `owner/repo` would spell
    // the same string as the repository without it.
    expect(projectGroupKey({ hostId: "github.com", projectId: "owner/repo" })).not.toBe(
      projectGroupKey({ projectId: "p", projectRemote: "github.com/owner/repo" }),
    );
  });

  test("two Macs' rows merge into ONE group, with both Macs' rows under it", () => {
    const remote = "github.com/owner/repo";
    const out = groupSessions({
      pinned: [],
      sessions: [
        row("here", { projectId: "project_here", projectName: "telar", projectRemote: remote }),
        row("there", { projectId: "project_b", projectName: "Telar", hostId: "host_b", hostName: "mini", projectRemote: remote }),
      ],
    });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.sessions.map((session) => session.id)).toEqual(["here", "there"]);
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

/**
 * THE FOUR FOLD MOVES the project header's menu and the rail's empty-space menu
 * fire. Asserted on the set rather than through a rendered menu: what is being
 * pinned is which keys a gesture may touch, and that is decidable without a DOM.
 */
describe("foldedAfter", () => {
  const drawn = ["a", "b", "c"];

  test("toggle swaps one key and leaves the rest alone", () => {
    expect([...foldedAfter(new Set(), drawn, { kind: "toggle", key: "b" })]).toEqual(["b"]);
    expect([...foldedAfter(new Set(["b"]), drawn, { kind: "toggle", key: "b" })]).toEqual([]);
  });

  test("collapse others folds every drawn group but this one — and unfolds this one", () => {
    // The lobby's verb: you asked to see THIS project, so a folded one you
    // named must come open rather than stay shut.
    expect([...foldedAfter(new Set(["b"]), drawn, { kind: "others", key: "b" })].sort()).toEqual(["a", "c"]);
  });

  test("collapse all and expand all move exactly the drawn keys", () => {
    expect([...foldedAfter(new Set(), drawn, { kind: "all" })].sort()).toEqual(["a", "b", "c"]);
    expect([...foldedAfter(new Set(drawn), drawn, { kind: "none" })]).toEqual([]);
  });

  test("a fold for a group NOT on screen survives every move — it is not this gesture's to clear", () => {
    // `away` is a paired Mac's project that did not answer this tick. Expanding
    // all must not silently un-fold it, or it springs open the moment that Mac
    // comes back.
    const withAway = new Set(["away"]);
    expect([...foldedAfter(withAway, drawn, { kind: "none" })]).toEqual(["away"]);
    expect([...foldedAfter(withAway, drawn, { kind: "all" })].sort()).toEqual(["a", "away", "b", "c"]);
    expect([...foldedAfter(withAway, drawn, { kind: "others", key: "a" })].sort()).toEqual(["away", "b", "c"]);
  });

  test("pure: the set handed in is never mutated", () => {
    const current = new Set(["a"]);
    foldedAfter(current, drawn, { kind: "all" });
    expect([...current]).toEqual(["a"]);
  });
});

describe("moveProjectGroupStep", () => {
  const drawn = ["a", "b", "c"];

  test("one place up, one place down — the same write the drop makes", () => {
    expect(moveProjectGroupStep([], drawn, "c", "up")).toEqual(["a", "c", "b"]);
    expect(moveProjectGroupStep([], drawn, "a", "down")).toEqual(["b", "a", "c"]);
    // Identical to resolving the neighbour by hand and dropping on it.
    expect(moveProjectGroupStep([], drawn, "c", "up")).toEqual(moveProjectGroup([], drawn, "c", "b", "above"));
  });

  test("undefined at either end, which is what disables the menu row", () => {
    expect(moveProjectGroupStep([], drawn, "a", "up")).toBeUndefined();
    expect(moveProjectGroupStep([], drawn, "c", "down")).toBeUndefined();
    expect(moveProjectGroupStep([], drawn, "zz", "up")).toBeUndefined();
  });

  test("keys the rail is not drawing keep their slot, exactly as a drop leaves them", () => {
    const stored = ["a", "away", "b", "c"];
    expect(moveProjectGroupStep(stored, drawn, "c", "up")).toEqual(["a", "away", "c", "b"]);
  });
});

describe("orderSessions", () => {
  const rows = [row("a"), row("b"), row("c")];

  test("no stored order is the recency order the list already produced", () => {
    expect(orderSessions(rows).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(orderSessions(rows, []).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("placed rows first, in the stored order; the rest keep their recency order", () => {
    expect(orderSessions(rows, ["c"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(orderSessions(rows, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(orderSessions(rows, ["c", "b", "a"]).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  test("a stored key for a row that is not here places nothing", () => {
    expect(orderSessions(rows, ["gone", "b"]).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  test("rows are keyed the way the rail keys them: a paired Mac's row is host-qualified", () => {
    const remote = row("a", { hostId: "h1" });
    const local = row("a");
    // Two rows with the SAME id, one local and one remote — the bare id must
    // not place both, or a drag in one rail would move a row in the other.
    expect(orderSessions([local, remote], ["h1:a"]).map((s) => s.hostId)).toEqual(["h1", undefined]);
  });

  test("pure: the list handed in is never reordered in place", () => {
    const given = [...rows];
    orderSessions(given, ["c", "b", "a"]);
    expect(given.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("moveSessionRow", () => {
  const drawn = ["a", "b", "c"];

  test("above and below, by which half of the target the pointer was in", () => {
    expect(moveSessionRow([], drawn, "a", "c", "below")).toEqual(["b", "c", "a"]);
    expect(moveSessionRow([], drawn, "c", "a", "above")).toEqual(["c", "a", "b"]);
  });

  test("the WHOLE drawn band is written, so an unplaced row stops drifting", () => {
    // Nothing was stored before this drop and every drawn row comes back
    // placed — the same promise `moveProjectGroup` makes one level up.
    expect(moveSessionRow([], drawn, "b", "a", "above")).toEqual(["b", "a", "c"]);
  });

  test("rows the rail is not drawing keep their slot relative to the ones it is", () => {
    const stored = ["a", "page2", "b", "c"];
    expect(moveSessionRow(stored, drawn, "c", "b", "above")).toEqual(["a", "page2", "c", "b"]);
  });

  test("a row dropped outside its own band leaves the band alone", () => {
    // The handler passes ONE band's drawn keys; a row from another group is not
    // among them, so there is no anchor and nothing moves. Moving a
    // conversation between projects is a different verb.
    expect(moveSessionRow([], drawn, "elsewhere", "b", "above")).toEqual(drawn);
    expect(moveSessionRow([], drawn, "a", "elsewhere", "above")).toEqual(drawn);
    expect(moveSessionRow([], drawn, "b", "b", "above")).toEqual(drawn);
  });

  test("it is the group drag's own arithmetic, on a different list", () => {
    expect(moveSessionRow([], drawn, "a", "c", "below")).toEqual(moveProjectGroup([], drawn, "a", "c", "below"));
  });
});

describe("groupSessions honours the stored row orders", () => {
  const a = row("a");
  const b = row("b");
  const c = row("c");

  test("a group's rows sit where the reader dragged them", () => {
    const out = groupSessions({ pinned: [], sessions: [a, b, c] }, [], { sessions: { p1: ["c", "a"] } });
    expect(out.groups[0]?.sessions.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  test("the pinned band arranges among itself", () => {
    const out = groupSessions({ pinned: [a, b, c], sessions: [] }, [], { pinned: ["b", "c"] });
    expect(out.pinned.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  test("one group's order never reaches another's", () => {
    const other = row("d", { projectId: "p2", projectName: "beta" });
    const out = groupSessions({ pinned: [], sessions: [a, b, other] }, [], { sessions: { p2: ["b", "a"] } });
    expect(out.groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
      ["p1", ["a", "b"]],
      ["p2", ["d"]],
    ]);
  });

  test("no orders at all is exactly the list the rail drew before any of this", () => {
    const out = groupSessions({ pinned: [a], sessions: [b, c] });
    expect(out.pinned.map((s) => s.id)).toEqual(["a"]);
    expect(out.groups[0]?.sessions.map((s) => s.id)).toEqual(["b", "c"]);
  });

  test("the attention band is not arranged — it is a queue, not a shelf", () => {
    const blocked = row("z", { activity: "blocked" });
    const alsoBlocked = row("y", { activity: "blocked" });
    const out = groupSessions({ pinned: [], sessions: [blocked, alsoBlocked] }, [], { pinned: ["y", "z"], sessions: { p1: ["y", "z"] } });
    expect(out.attention.map((s) => s.id)).toEqual(["z", "y"]);
  });
});

/**
 * THE DRIVE BADGE ON A PROJECT GROUP — issue #534.
 *
 * The rule is a fold over the group's rows, and the interesting half is when it
 * declines to answer: a group spanning two Macs is reachable if the drive is
 * plugged into one of them, and "not yet known" is not evidence of anything.
 */
describe("a group's drive badge", () => {
  test("says the drive is away only when every row agrees", () => {
    const groups = groupSessions({
      pinned: [],
      sessions: [row("a", { projectAvailability: "unmounted" }), row("b", { projectAvailability: "unmounted" })],
    }).groups;
    expect(groups[0]!.availability).toBe("unmounted");
  });

  test("says nothing when one place can still read the project", () => {
    // Two Macs, one repository — see `projectGroupKey`. The work is reachable
    // on the Mac that has the drive, so a header badge would be false for half
    // the rows under it.
    const groups = groupSessions({
      pinned: [],
      sessions: [
        row("a", { projectRemote: "github.com/o/r", projectAvailability: "unmounted" }),
        row("b", { projectRemote: "github.com/o/r", hostId: "mini", projectAvailability: "available" }),
      ],
    }).groups;
    expect(groups[0]!.availability).toBeUndefined();
  });

  test("says nothing while an answer is still missing, rather than flickering on", () => {
    const groups = groupSessions({
      pinned: [],
      sessions: [row("a", { projectAvailability: "unmounted" }), row("b")],
    }).groups;
    expect(groups[0]!.availability).toBeUndefined();
  });

  test("says nothing at all on an engine that predates the field", () => {
    const groups = groupSessions({ pinned: [], sessions: [row("a"), row("b")] }).groups;
    expect(groups[0]!.availability).toBeUndefined();
  });

  test("does not mix two different failures into one badge", () => {
    const groups = groupSessions({
      pinned: [],
      sessions: [
        row("a", { projectRemote: "github.com/o/r", projectAvailability: "unmounted" }),
        row("b", { projectRemote: "github.com/o/r", hostId: "mini", projectAvailability: "missing" }),
      ],
    }).groups;
    expect(groups[0]!.availability).toBeUndefined();
  });
});
