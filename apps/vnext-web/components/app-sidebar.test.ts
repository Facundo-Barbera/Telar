/**
 * The rail's filter and search.
 *
 * This used to assert three label strings, which pinned vocabulary rather than
 * behaviour and went stale the moment the filters changed from `recent/active/
 * all` to the session record's real states. What matters is that the LIST and
 * the COUNTS beside each filter are derived from one function, so the rail can
 * never say `Archived 3` above an empty list.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Session } from "@telar/engine-client";
import { ALL_PROJECTS, sessionFilterLabel, visibleSessions } from "./vnext-session-list";

const session = (id: string, title: string, state: Session["state"], projectId = "p1") =>
  ({ id, title, state, projectId, updatedAt: 1 }) as Session;

const FIXTURE = [
  session("s1", "Fix the exports flake", "active"),
  session("s2", "Old spike", "archived"),
  session("s3", "Browser naming", "active", "p2"),
];

const names = (id: string) => (id === "p1" ? "telar-vnext" : "other-project");
const titles = (list: readonly Session[]) => list.map((entry) => entry.title);

describe("visibleSessions", () => {
  test("filters on the session record's own state", () => {
    expect(titles(visibleSessions(FIXTURE, { filter: "all", query: "", projectName: names }))).toHaveLength(3);
    expect(titles(visibleSessions(FIXTURE, { filter: "active", query: "", projectName: names }))).toEqual([
      "Fix the exports flake",
      "Browser naming",
    ]);
    expect(titles(visibleSessions(FIXTURE, { filter: "archived", query: "", projectName: names }))).toEqual(["Old spike"]);
  });

  test("searches the project NAME as well as the title", () => {
    // The rail can be scoped to all projects, where "which project" is the one
    // piece of context a bare title is missing — so it has to be searchable.
    expect(titles(visibleSessions(FIXTURE, { filter: "all", query: "other-project", projectName: names }))).toEqual(["Browser naming"]);
  });

  test("ignores case and surrounding whitespace in the query", () => {
    expect(titles(visibleSessions(FIXTURE, { filter: "all", query: "  EXPORTS  ", projectName: names }))).toEqual(["Fix the exports flake"]);
  });

  test("composes filter and query rather than letting one win", () => {
    // `Old spike` matches the text but not the filter; the row must stay hidden.
    expect(visibleSessions(FIXTURE, { filter: "active", query: "spike", projectName: names })).toEqual([]);
  });
});

describe("the all-projects sentinel", () => {
  test("is not a project id and not the empty string", () => {
    // `""` would make "no scope chosen" and "all projects" the same value, which
    // is how a rail ends up showing nothing on first paint.
    expect(ALL_PROJECTS).not.toBe("");
    expect(FIXTURE.some((entry) => entry.projectId === ALL_PROJECTS)).toBe(false);
  });
});

describe("sessionFilterLabel", () => {
  test("names each filter after the state it selects", () => {
    expect(sessionFilterLabel("all")).toBe("All");
    expect(sessionFilterLabel("active")).toBe("Active");
    expect(sessionFilterLabel("archived")).toBe("Archived");
  });
});
