// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  appliedProjectFilter,
  filterSessionsToProjects,
  projectFilterKey,
  toggledProjectFilter,
} from "./project-filter";

/**
 * The rail's multi-select project filter, as set math — issue #470. The hook
 * around these is localStorage and an effect; everything that DECIDES anything
 * is here, so it can be exercised without a rail.
 */

const local = (projectId: string) => ({ projectId });
const on = (hostId: string, projectId: string) => ({ projectId, hostId });

describe("a project's key", () => {
  test("is host-qualified, because ids are minted per engine", () => {
    // The same id on two Macs is two projects. A bare id would filter one and
    // hide the other.
    expect(projectFilterKey("project_9f")).toBe("local:project_9f");
    expect(projectFilterKey("project_9f", "mini")).toBe("mini:project_9f");
    expect(projectFilterKey("project_9f")).not.toBe(projectFilterKey("project_9f", "mini"));
  });

  test("a host called `local` cannot pose as this Mac", () => {
    // Both halves carry a prefix, so there is no unprefixed form to collide with.
    expect(projectFilterKey("p", "local")).toBe("local:p");
    // ...which is the one collision this shape does admit, and it needs a paired
    // Mac whose id is literally "local". Host ids are UUIDs (`hosts/book.ts`).
    expect(projectFilterKey("p")).toBe("local:p");
  });
});

describe("the selection as it applies", () => {
  const known = ["local:a", "local:b", "mini:a"];

  test("is the stored set narrowed to what this cockpit can see", () => {
    expect([...appliedProjectFilter(new Set(["local:b", "mini:a"]), known)]).toEqual(["local:b", "mini:a"]);
  });

  test("a key naming nothing on screen applies as nothing", () => {
    // A project that left the registry, or a paired Mac that is away. Applying
    // it would empty the rail and leave no checked row to explain why.
    expect(appliedProjectFilter(new Set(["gone:x"]), known).size).toBe(0);
  });

  test("an away Mac narrows the filter rather than clearing it", () => {
    expect([...appliedProjectFilter(new Set(["local:a", "away:z"]), known)]).toEqual(["local:a"]);
  });

  test("it never invents a key the store did not hold", () => {
    expect(appliedProjectFilter(new Set(), known).size).toBe(0);
  });
});

describe("the rows the filter leaves", () => {
  const rows = [local("a"), local("b"), on("mini", "a")];

  test("nothing selected is every project", () => {
    expect(filterSessionsToProjects(rows, new Set())).toEqual(rows);
  });

  test("n selected is those n, and the host is part of the answer", () => {
    expect(filterSessionsToProjects(rows, new Set(["local:a"]))).toEqual([local("a")]);
    expect(filterSessionsToProjects(rows, new Set(["mini:a"]))).toEqual([on("mini", "a")]);
    expect(filterSessionsToProjects(rows, new Set(["local:a", "local:b"]))).toEqual([local("a"), local("b")]);
  });

  test("a row with no project is not in any project's filter", () => {
    const orphan = { projectId: undefined };
    expect(filterSessionsToProjects([...rows, orphan], new Set(["local:a"]))).toEqual([local("a")]);
    // But an unfiltered rail still draws it.
    expect(filterSessionsToProjects([orphan], new Set())).toEqual([orphan]);
  });

  test("the input is never mutated — the rail re-derives on every poll", () => {
    const before = [...rows];
    filterSessionsToProjects(rows, new Set(["local:a"]));
    expect(rows).toEqual(before);
  });
});

describe("pressing a row", () => {
  test("adds, then removes, and leaves the rest alone", () => {
    const one = toggledProjectFilter(new Set(["local:a"]), "local:b");
    expect([...one].sort()).toEqual(["local:a", "local:b"]);
    expect([...toggledProjectFilter(one, "local:a")]).toEqual(["local:b"]);
  });

  test("returns a new set, so React sees the change", () => {
    const current = new Set(["local:a"]);
    expect(toggledProjectFilter(current, "local:b")).not.toBe(current);
    expect([...current]).toEqual(["local:a"]);
  });
});
