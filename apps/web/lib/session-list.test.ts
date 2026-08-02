// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  activeSessionFromPathname,
  deriveSessionList,
  SETTLED_AFTER_MS,
  type SidebarSession,
} from "./session-list";

const NOW = 10 * SETTLED_AFTER_MS;
const session = (
  id: string,
  over: Partial<SidebarSession> = {},
): SidebarSession => ({
  id,
  title: id,
  project: "alpha",
  createdAt: NOW - Number(id.replace(/\D/g, "") || 0),
  updatedAt: NOW - 1_000,
  costUsd: 0,
  ...over,
});

describe("deriveSessionList", () => {
  test("uses creation order, not activity order", () => {
    const rows = [
      session("older", { createdAt: 1, updatedAt: NOW }),
      session("newer", { createdAt: 2, updatedAt: NOW - 100 }),
    ];
    expect(deriveSessionList({ sessions: rows, now: NOW }).sessions.map((r) => r.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("shelves archived and three-day-quiet sessions", () => {
    const rows = [
      session("live"),
      session("quiet", { createdAt: 3, updatedAt: NOW - SETTLED_AFTER_MS }),
      session("archived", { createdAt: 2, archived: true }),
    ];
    const result = deriveSessionList({ sessions: rows, now: NOW });
    expect(result.sessions.map((r) => r.id)).toEqual(["live"]);
    expect(result.settled.map((r) => r.id)).toEqual(["quiet", "archived"]);
  });

  test("excludes loom-born sessions and scopes/searches locally", () => {
    const rows = [
      session("alpha-match", { title: "Fix parser" }),
      session("beta-match", { project: "beta", title: "Fix parser" }),
      session("steerer", { role: "steerer", title: "Fix parser" }),
      session("escalation", { role: "escalation", title: "Fix parser" }),
    ];
    expect(
      deriveSessionList({ sessions: rows, project: "alpha", query: "parser", now: NOW }).sessions.map(
        (r) => r.id,
      ),
    ).toEqual(["alpha-match"]);
  });

  test("search includes settled sessions and matches project names", () => {
    const quiet = session("quiet", {
      project: "Searchable Project",
      updatedAt: NOW - SETTLED_AFTER_MS,
    });
    const result = deriveSessionList({ sessions: [quiet], query: "searchable", now: NOW });
    expect(result.sessions.map((r) => r.id)).toEqual(["quiet"]);
    expect(result.settled).toEqual([]);
  });

  test("keeps the active session visible past shelf and paging boundaries", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      session(`s${index}`, { createdAt: 100 - index }),
    );
    rows.push(session("active", { createdAt: 0, updatedAt: NOW - SETTLED_AFTER_MS }));
    const result = deriveSessionList({
      sessions: rows,
      activeSessionId: "active",
      now: NOW,
      limit: 2,
    });
    expect(result.sessions.map((r) => r.id)).toEqual(["s0", "s1", "active"]);
    expect(result.settledCount).toBe(0);
    expect(result.hasMoreSessions).toBe(true);
  });
});

test("activeSessionFromPathname only recognizes persisted session routes", () => {
  expect(activeSessionFromPathname("/projects/alpha/sessions/a%20b")).toBe("a b");
  expect(activeSessionFromPathname("/projects/alpha/sessions/new")).toBeUndefined();
  expect(activeSessionFromPathname("/projects/alpha")).toBeUndefined();
});
