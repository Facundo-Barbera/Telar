// The proof that the sidebar's lists hold what they claim, in the order they
// claim it.
//
// Four of these are regressions waiting to happen rather than hypotheticals: a
// pin whose project vanished must keep its slot in the store (a "tidy up on
// read" rewrite loses the bookmark permanently), pinned projects must not eat
// recents slots (otherwise pinning hides a row instead of promoting one), the
// active partition must beat recency outright rather than weigh against it, and
// equal-recency projects must hold the order they were handed in — the tie-break
// nothing in the comparator mentions, and the one a Map-based rewrite silently
// loses.
//
// The last-position case in moveByName asserts a quirk, not a nicety: dropping
// onto the final wheel lands you second-to-last. It is pinned here so that
// changing it has to be a decision.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  compareRecents,
  highlightedProject,
  moveByName,
  type OrderableProject,
  parseStoredList,
  pinnedProjects,
  reconcileOrder,
  recentProjects,
  RECENTS_LIMIT,
  togglePinned,
} from "@/lib/sidebar-order";

const proj = (
  name: string,
  recency: number,
  active = false,
): OrderableProject => ({ name, recency, active });

const names = (rows: readonly { name: string }[]): string[] => rows.map((r) => r.name);

describe("parseStoredList", () => {
  test("an absent or empty key is an empty list", () => {
    expect(parseStoredList(null)).toEqual([]);
    expect(parseStoredList("")).toEqual([]);
  });

  test("unparseable JSON is an empty list, not a throw", () => {
    expect(parseStoredList("{oh no")).toEqual([]);
  });

  test("a value that is not an array of strings is rejected WHOLE", () => {
    expect(parseStoredList("false")).toEqual([]);
    expect(parseStoredList("{}")).toEqual([]);
    expect(parseStoredList('"one"')).toEqual([]);
    expect(parseStoredList("[1,2]")).toEqual([]);
    // The mixed case is the one worth stating: ["a", null] does not become ["a"].
    expect(parseStoredList('["a",null]')).toEqual([]);
  });

  test("duplicates and empty strings survive — the parser checks shape, not sense", () => {
    expect(parseStoredList('["a","a",""]')).toEqual(["a", "a", ""]);
  });

  test("an empty array round-trips as itself", () => {
    expect(parseStoredList("[]")).toEqual([]);
  });
});

describe("togglePinned", () => {
  test("pinning appends to the END — pinned order is pin order", () => {
    expect(togglePinned(["alpha", "beta"], "gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  test("pinning into an empty list starts it", () => {
    expect(togglePinned([], "alpha")).toEqual(["alpha"]);
  });

  test("unpinning removes it and leaves the rest in place", () => {
    expect(togglePinned(["alpha", "beta", "gamma"], "beta")).toEqual(["alpha", "gamma"]);
  });

  test("pin then unpin returns the list to exactly where it started", () => {
    const before = ["alpha", "beta"];
    const after = togglePinned(togglePinned(before, "gamma"), "gamma");
    expect(after).toEqual(before);
  });

  test("unpin then re-pin does NOT return to the original position — it appends", () => {
    // Stated so the asymmetry above is not read as a general round-trip
    // guarantee: a pin has no memory of where it used to sit.
    const before = ["alpha", "beta", "gamma"];
    expect(togglePinned(togglePinned(before, "alpha"), "alpha")).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
  });

  test("unpinning purges every occurrence of a hand-edited duplicate", () => {
    expect(togglePinned(["a", "b", "a"], "a")).toEqual(["b"]);
  });

  test("does not mutate the list it was given", () => {
    const before = ["alpha"];
    togglePinned(before, "beta");
    togglePinned(before, "alpha");
    expect(before).toEqual(["alpha"]);
  });
});

describe("pinnedProjects", () => {
  const projects = [proj("alpha", 3), proj("beta", 2), proj("gamma", 1)];

  test("nothing pinned is an empty list", () => {
    expect(names(pinnedProjects([], projects))).toEqual([]);
  });

  test("renders in STORED order, not the source list's order", () => {
    expect(names(pinnedProjects(["gamma", "alpha"], projects))).toEqual(["gamma", "alpha"]);
  });

  test("a pinned name with no project is dropped from the render, and the rest keep their slots", () => {
    // The store still holds "ghost" — this function has no way to remove it, and
    // that is what lets the row come back in place when the project returns.
    const pinned = ["alpha", "ghost", "gamma"];
    expect(names(pinnedProjects(pinned, projects))).toEqual(["alpha", "gamma"]);
    expect(pinned).toEqual(["alpha", "ghost", "gamma"]);
    // ...and when it comes back it lands between them again, not at the end.
    expect(names(pinnedProjects(pinned, [...projects, proj("ghost", 0)]))).toEqual([
      "alpha",
      "ghost",
      "gamma",
    ]);
  });

  test("every pin missing means every row missing, not a fallback list", () => {
    expect(names(pinnedProjects(["ghost", "wraith"], projects))).toEqual([]);
  });

  test("a duplicated pin resolves twice, to the very same project object", () => {
    const rows = pinnedProjects(["alpha", "alpha"], projects);
    expect(names(rows)).toEqual(["alpha", "alpha"]);
    expect(rows[0]).toBe(rows[1]);
  });
});

describe("compareRecents", () => {
  test("active outranks idle however stale it is", () => {
    const stale = proj("stale", 0, true);
    const fresh = proj("fresh", 9_999, false);
    expect(compareRecents(stale, fresh)).toBeLessThan(0);
    expect(compareRecents(fresh, stale)).toBeGreaterThan(0);
  });

  test("inside a group, newer first", () => {
    expect(compareRecents(proj("new", 2), proj("old", 1))).toBeLessThan(0);
    expect(compareRecents(proj("old", 1), proj("new", 2))).toBeGreaterThan(0);
  });

  test("equal recency in the same group is 0, so the sort leaves them alone", () => {
    expect(compareRecents(proj("a", 5), proj("b", 5))).toBe(0);
    expect(compareRecents(proj("a", 5, true), proj("b", 5, true))).toBe(0);
  });
});

describe("recentProjects", () => {
  test("an empty source list is an empty result", () => {
    expect(names(recentProjects([], []))).toEqual([]);
  });

  test("active first, then newest first — the full order, asserted end to end", () => {
    const projects = [
      proj("idle-new", 500),
      proj("active-old", 1, true),
      proj("idle-old", 100),
      proj("active-new", 400, true),
    ];
    expect(names(recentProjects(projects, []))).toEqual([
      "active-new",
      "active-old",
      "idle-new",
      "idle-old",
    ]);
  });

  test("equal recency holds the order it was handed in — the implicit tie-break", () => {
    // Registry insertion order in the real caller. Asserted explicitly because
    // nothing in the comparator mentions it: it exists only because `sort` is
    // stable and the input array is the one the caller built.
    const forwards = [proj("first", 7), proj("second", 7), proj("third", 7)];
    expect(names(recentProjects(forwards, []))).toEqual(["first", "second", "third"]);
    const backwards = [proj("third", 7), proj("second", 7), proj("first", 7)];
    expect(names(recentProjects(backwards, []))).toEqual(["third", "second", "first"]);
    // The same holds inside the active group.
    const active = [proj("a", 7, true), proj("b", 7, true)];
    expect(names(recentProjects(active, []))).toEqual(["a", "b"]);
  });

  test("pinned projects are excluded and do NOT consume a slot", () => {
    const projects = Array.from({ length: 8 }, (_, i) => proj(`p${i}`, 100 - i));
    // p0 and p1 are the two freshest; pinning them should reveal p6 and p7.
    const recents = recentProjects(projects, [{ name: "p0" }, { name: "p1" }]);
    expect(names(recents)).toEqual(["p2", "p3", "p4", "p5", "p6", "p7"]);
  });

  test("a pin for a project that is not in the list excludes nothing", () => {
    const projects = [proj("alpha", 2), proj("beta", 1)];
    expect(names(recentProjects(projects, [{ name: "ghost" }]))).toEqual(["alpha", "beta"]);
  });

  test("the cap is applied last, after the exclusion and the sort", () => {
    const projects = Array.from({ length: RECENTS_LIMIT + 3 }, (_, i) => proj(`p${i}`, i));
    const recents = recentProjects(projects, []);
    expect(recents).toHaveLength(RECENTS_LIMIT);
    // Newest-first, so the tail — the oldest three — is what falls off.
    expect(names(recents)).toEqual(["p8", "p7", "p6", "p5", "p4", "p3"]);
  });

  test("enough active projects fill every slot and no idle one is ever shown", () => {
    const projects = [
      ...Array.from({ length: RECENTS_LIMIT }, (_, i) => proj(`weaving-${i}`, i, true)),
      proj("idle-but-fresh", 10_000),
    ];
    expect(names(recentProjects(projects, []))).not.toContain("idle-but-fresh");
  });

  test("the limit is a parameter, and 0 means nothing", () => {
    const projects = [proj("alpha", 2), proj("beta", 1)];
    expect(names(recentProjects(projects, [], 1))).toEqual(["alpha"]);
    expect(names(recentProjects(projects, [], 0))).toEqual([]);
  });

  test("sorts a copy — the caller's array is state and must not move", () => {
    const projects = [proj("old", 1), proj("new", 2)];
    const before = names(projects);
    recentProjects(projects, []);
    expect(names(projects)).toEqual(before);
  });
});

describe("highlightedProject", () => {
  test("is the first active row in the ordered list", () => {
    const recents = recentProjects(
      [proj("idle", 900), proj("active-old", 1, true), proj("active-new", 5, true)],
      [],
    );
    expect(highlightedProject(recents)).toBe("active-new");
  });

  test("is undefined when nothing is weaving", () => {
    expect(highlightedProject([proj("a", 2), proj("b", 1)])).toBeUndefined();
  });

  test("is undefined for an empty list", () => {
    expect(highlightedProject([])).toBeUndefined();
  });
});

describe("reconcileOrder", () => {
  test("nothing stored yields the canonical order untouched", () => {
    expect(reconcileOrder([], ["personal", "work"])).toEqual(["personal", "work"]);
  });

  test("a remembered order wins over the canonical one", () => {
    expect(reconcileOrder(["work", "personal"], ["personal", "work"])).toEqual([
      "work",
      "personal",
    ]);
  });

  test("names that vanished are dropped from the render", () => {
    expect(reconcileOrder(["gone", "work"], ["work", "personal"])).toEqual(["work", "personal"]);
  });

  test("newcomers land at the END, in canonical order — never interleaved", () => {
    expect(reconcileOrder(["work"], ["work", "aaa", "zzz"])).toEqual(["work", "aaa", "zzz"]);
  });

  test("a stored duplicate survives, because dedupe on read would rewrite the key", () => {
    expect(reconcileOrder(["a", "a", "b"], ["a", "b"])).toEqual(["a", "a", "b"]);
  });

  test("an empty live set is empty however much is remembered", () => {
    expect(reconcileOrder(["a", "b"], [])).toEqual([]);
  });

  test("does not mutate either input", () => {
    const stored = ["b"];
    const actual = ["a", "b"];
    reconcileOrder(stored, actual);
    expect(stored).toEqual(["b"]);
    expect(actual).toEqual(["a", "b"]);
  });
});

describe("moveByName", () => {
  const order = ["a", "b", "c", "d"];

  test("dropping on the first row moves to index 0", () => {
    expect(moveByName(order, "c", "a")).toEqual(["c", "a", "b", "d"]);
  });

  test("dropping on the LAST row lands second-to-last, not last", () => {
    // The insert-before rule, stated as a fact rather than discovered as a bug:
    // the final slot cannot be reached by dropping onto the row that holds it.
    expect(moveByName(order, "a", "d")).toEqual(["b", "c", "a", "d"]);
  });

  test("insertion is before the target whichever way the pointer travelled", () => {
    expect(moveByName(order, "a", "c")).toEqual(["b", "a", "c", "d"]);
    expect(moveByName(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  test("a target that is not in the order returns the order unchanged, by identity", () => {
    // The out-of-bounds guard. There is no index arithmetic to land past an end,
    // so an unknown target is a no-op rather than an append.
    expect(moveByName(order, "a", "ghost")).toBe(order);
  });

  test("dropping something onto itself returns the very same array", () => {
    expect(moveByName(order, "b", "b")).toBe(order);
  });

  test("dragging a name that is not in the order still reorders nothing it owns", () => {
    // `from` missing means the filter removes nothing and `to` keeps its index,
    // so the mover is inserted ahead of the target — one row longer than before.
    expect(moveByName(order, "ghost", "b")).toEqual(["a", "ghost", "b", "c", "d"]);
  });

  test("a duplicated name collapses to one on its first drag", () => {
    expect(moveByName(["a", "b", "a", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  test("a two-item swap works in both directions", () => {
    expect(moveByName(["a", "b"], "b", "a")).toEqual(["b", "a"]);
    // ...and the other direction cannot reach the end, same rule as above.
    expect(moveByName(["a", "b"], "a", "b")).toEqual(["a", "b"]);
  });

  test("does not mutate the order it was given", () => {
    const before = [...order];
    moveByName(order, "a", "c");
    expect(order).toEqual(before);
  });
});

describe("pins and recents together", () => {
  const projects = [proj("alpha", 300), proj("beta", 200, true), proj("gamma", 100)];

  test("pinning moves a project out of Recent and unpinning puts it back in place", () => {
    const pinnedNames = togglePinned([], "alpha");
    const pinned = pinnedProjects(pinnedNames, projects);
    expect(names(pinned)).toEqual(["alpha"]);
    expect(names(recentProjects(projects, pinned))).toEqual(["beta", "gamma"]);

    const unpinned = pinnedProjects(togglePinned(pinnedNames, "alpha"), projects);
    expect(names(unpinned)).toEqual([]);
    // alpha returns to the position its recency earns — ahead of gamma, behind
    // the weaving beta.
    expect(names(recentProjects(projects, unpinned))).toEqual(["beta", "alpha", "gamma"]);
  });

  test("a pinned project that is weaving does not steal the Recent highlight", () => {
    const pinned = pinnedProjects(["beta"], projects);
    const recents = recentProjects(projects, pinned);
    expect(names(recents)).toEqual(["alpha", "gamma"]);
    expect(highlightedProject(recents)).toBeUndefined();
  });
});
