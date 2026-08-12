/**
 * The rail's inbox derivation.
 *
 * What matters is that the LIST, the SHELF and the COUNTS beside each filter all
 * come out of one function, so the rail can never say `Archived 3` above a list
 * that contradicts it — and that a session you are currently LOOKING AT cannot
 * disappear out from under you when it ages into the shelf.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { bandOf, deriveSessionList, SETTLED_AFTER_MS, toSidebarSession, type SidebarSession } from "./session-list";

const NOW = 1_800_000_000_000;

const row = (id: string, title: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title,
  projectId: "p1",
  projectName: "telar-vnext",
  createdAt: NOW - 1_000,
  updatedAt: NOW - 1_000,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  ...over,
});

const titles = (list: readonly SidebarSession[]) => list.map((entry) => entry.title);

describe("bandOf", () => {
  test("shelves a session archived by decision", () => {
    expect(bandOf(row("s1", "Done", { archived: true }), NOW)).toBe("settled");
  });

  test("shelves a session settled by neglect", () => {
    expect(bandOf(row("s1", "Quiet", { updatedAt: NOW - SETTLED_AFTER_MS }), NOW)).toBe("settled");
    // One millisecond short of the threshold is still live — the boundary is
    // where a row visibly moves, so it is worth pinning.
    expect(bandOf(row("s1", "Quiet"), NOW)).toBe("active");
    expect(bandOf(row("s1", "Quiet", { updatedAt: NOW - SETTLED_AFTER_MS + 1 }), NOW)).toBe("active");
  });
});

describe("deriveSessionList", () => {
  const FIXTURE = [
    row("s1", "Fix the exports flake", { createdAt: NOW - 3_000 }),
    row("s2", "Old spike", { archived: true, createdAt: NOW - 2_000 }),
    row("s3", "Browser naming", { projectId: "p2", projectName: "other-project", createdAt: NOW - 1_000 }),
  ];

  test("bands the default view: live rows above, settled on the shelf", () => {
    const list = deriveSessionList({ sessions: FIXTURE, now: NOW });
    expect(titles(list.sessions)).toEqual(["Browser naming", "Fix the exports flake"]);
    expect(titles(list.settled)).toEqual(["Old spike"]);
    expect(list.flat).toBe(false);
  });

  test("a chip flattens the shelf away rather than filtering above it", () => {
    const archived = deriveSessionList({ sessions: FIXTURE, filter: "archived", now: NOW });
    expect(titles(archived.sessions)).toEqual(["Old spike"]);
    // The whole point of the chip: nothing may remain hidden behind a shelf.
    expect(archived.settled).toEqual([]);
    expect(archived.flat).toBe(true);
  });

  test("counts are taken over the scope, not over the visible page", () => {
    const list = deriveSessionList({ sessions: FIXTURE, now: NOW, limit: 1 });
    expect(list.sessions).toHaveLength(1);
    expect(list.activeCount).toBe(2);
    expect(list.archivedCount).toBe(1);
    expect(list.hasMoreSessions).toBe(true);
  });

  test("search reaches into the shelf and searches the project NAME too", () => {
    // The rail can be scoped to all projects, where "which project" is the one
    // piece of context a bare title is missing — so it has to be searchable.
    expect(titles(deriveSessionList({ sessions: FIXTURE, query: "other-project", now: NOW }).sessions)).toEqual(["Browser naming"]);
    // `Old spike` is shelved; a search must still be able to recover it.
    expect(titles(deriveSessionList({ sessions: FIXTURE, query: "spike", now: NOW }).sessions)).toEqual(["Old spike"]);
  });

  test("a chip stays honored underneath a query", () => {
    expect(deriveSessionList({ sessions: FIXTURE, filter: "active", query: "spike", now: NOW }).sessions).toEqual([]);
  });

  test("ignores case and surrounding whitespace in the query", () => {
    expect(titles(deriveSessionList({ sessions: FIXTURE, query: "  EXPORTS  ", now: NOW }).sessions)).toEqual(["Fix the exports flake"]);
  });

  test("scoping to a project drops every other project's rows", () => {
    expect(titles(deriveSessionList({ sessions: FIXTURE, projectId: "p2", now: NOW }).sessions)).toEqual(["Browser naming"]);
  });

  test("the open session survives its own shelving, and is not rendered twice", () => {
    const list = deriveSessionList({ sessions: FIXTURE, activeSessionId: "s2", now: NOW });
    expect(titles(list.sessions)).toContain("Old spike");
    expect(titles(list.settled)).not.toContain("Old spike");
    // It left the shelf, so the shelf's count must agree.
    expect(list.settledCount).toBe(0);
  });

  test("the open session is pinned onto the page even past the limit", () => {
    const list = deriveSessionList({ sessions: FIXTURE, activeSessionId: "s1", now: NOW, limit: 1 });
    expect(titles(list.sessions)).toContain("Fix the exports flake");
  });
});

describe("toSidebarSession", () => {
  test("carries usage and worktree facts the row and hover card read", () => {
    const projected = toSidebarSession(
      {
        id: "s1",
        projectId: "p1",
        environmentId: "local",
        title: "Fix the flake",
        state: "active",
        createdAt: NOW,
        updatedAt: NOW,
        providerInstanceId: "claude:default",
        driver: "claude",
        model: { instanceId: "claude:default", model: "opus", effort: "high" },
        workspace: { mode: "worktree", path: "/wt", branch: "session/fix" },
        envMode: "worktree",
        runtimeMode: "auto",
        interactionMode: "default",
        detached: true,
        usage: { tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.25, contextUsed: 1_234 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fixture, not a wire payload
      } as any,
      "telar-vnext",
    );
    expect(projected.archived).toBe(false);
    expect(projected.model).toBe("opus");
    expect(projected.effort).toBe("high");
    // Every token the session has spent, cache included — not the price.
    expect(projected.tokens).toBe(15);
    expect(projected.contextTokens).toBe(1_234);
    expect(projected.worktreeBranch).toBe("session/fix");
    expect(projected.projectName).toBe("telar-vnext");
  });

  test("a local session reports no branch, rather than an empty one", () => {
    const projected = toSidebarSession(
      {
        id: "s2",
        projectId: "p1",
        environmentId: "local",
        title: "Local",
        state: "archived",
        createdAt: NOW,
        updatedAt: NOW,
        providerInstanceId: "claude:default",
        driver: "codex",
        workspace: { mode: "local", path: "/repo" },
        envMode: "local",
        runtimeMode: "auto",
        interactionMode: "default",
        detached: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fixture, not a wire payload
      } as any,
    );
    expect(projected.worktreeBranch).toBeUndefined();
    expect(projected.tokens).toBeUndefined();
    expect(projected.archived).toBe(true);
    expect(projected.driver).toBe("codex");
  });
});
