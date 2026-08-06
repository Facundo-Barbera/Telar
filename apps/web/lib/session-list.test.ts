// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  activeSessionFromPathname,
  bandOf,
  deriveSessionList,
  isUnread,
  newSessionHref,
  recentSessionsForCommandKeys,
  sessionHref,
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

describe("sessionHref", () => {
  test("builds the same route a session row links to", () => {
    expect(sessionHref({ id: "abc", project: "my project" })).toBe(
      "/projects/my%20project/sessions/abc",
    );
  });

  test("is undefined for a session with no project (never a broken link)", () => {
    expect(sessionHref({ id: "abc", project: undefined })).toBeUndefined();
  });
});

describe("recentSessionsForCommandKeys (issue #16's cmd+1..cmd+9)", () => {
  test("is exactly the sidebar's own unfiltered Recent order, capped at 9", () => {
    const rows = Array.from({ length: 12 }, (_, index) => session(`s${index}`, { createdAt: 100 - index }));
    const recent = recentSessionsForCommandKeys(rows, undefined, NOW);
    expect(recent.map((r) => r.id)).toEqual([
      "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8",
    ]);
    expect(
      deriveSessionList({ sessions: rows, now: NOW }).sessions.slice(0, 9).map((r) => r.id),
    ).toEqual(recent.map((r) => r.id));
  });

  test("never grows past 9 even when the open session is pinned past the limit", () => {
    const rows = Array.from({ length: 9 }, (_, index) => session(`s${index}`, { createdAt: 100 - index }));
    rows.push(session("open-but-old", { createdAt: 0, updatedAt: NOW - SETTLED_AFTER_MS }));
    const recent = deriveSessionList({
      sessions: rows,
      activeSessionId: "open-but-old",
      now: NOW,
      limit: 9,
    }).sessions;
    // Sanity check on the fixture: without capping, the pin pushes a 10th
    // entry onto the page (deriveSessionList's own documented behaviour).
    expect(recent.length).toBe(10);
    // MUST pass the SAME activeSessionId recentSessionsForCommandKeys forwards
    // in real use (use-command-keys.ts) — passing none here would make this
    // pass for the wrong reason (deriveSessionList's own `limit: 9` already
    // caps an unpinned list, so the function's own trailing slice would never
    // even run). This was caught adversarially: with no activeSessionId
    // threaded through, mutating or deleting recentSessionsForCommandKeys's
    // slice bound passed every test in this file.
    const capped = recentSessionsForCommandKeys(rows, "open-but-old", NOW);
    expect(capped.length).toBe(9);
    expect(capped.map((r) => r.id)).not.toContain("open-but-old");
  });

  test("excludes steerer/escalation rows, same as the sidebar", () => {
    const rows = [
      session("visible"),
      session("steerer", { role: "steerer" }),
      session("escalation", { role: "escalation" }),
    ];
    expect(recentSessionsForCommandKeys(rows, undefined, NOW).map((r) => r.id)).toEqual(["visible"]);
  });
});

describe("inbox bands", () => {
  test("an explicit settle shelves a session that is otherwise live", () => {
    const rows = [session("rested", { settledAt: NOW - 10 })];
    const result = deriveSessionList({ sessions: rows, now: NOW });
    expect(result.sessions).toEqual([]);
    expect(result.settled.map((r) => r.id)).toEqual(["rested"]);
  });

  test("snooze beats every settle reason so its wake-up stays visible", () => {
    // Quiet enough to auto-settle AND explicitly archived — the snooze still
    // wins, because it is the only state carrying a return time.
    const rows = [
      session("deferred", {
        updatedAt: NOW - SETTLED_AFTER_MS,
        archived: true,
        snoozedUntil: NOW + 60_000,
      }),
    ];
    const result = deriveSessionList({ sessions: rows, now: NOW });
    expect(result.snoozed.map((r) => r.id)).toEqual(["deferred"]);
    expect(result.settled).toEqual([]);
    expect(result.snoozedCount).toBe(1);
  });

  test("a snooze whose instant has passed needs no timer to expire", () => {
    const row = session("woken", { snoozedUntil: NOW - 1 });
    expect(bandOf(row, NOW)).toBe("active");
    expect(deriveSessionList({ sessions: [row], now: NOW }).sessions.map((r) => r.id)).toEqual([
      "woken",
    ]);
  });

  test("unread is a watermark, so a later turn re-marks a read session", () => {
    expect(isUnread(session("fresh", { updatedAt: 100, readAt: 50 }))).toBe(true);
    expect(isUnread(session("seen", { updatedAt: 100, readAt: 100 }))).toBe(false);
    expect(isUnread(session("never", { updatedAt: 100 }))).toBe(true);
    // "Mark unread" writes 0 rather than adding a second flag that could
    // disagree with updatedAt.
    expect(isUnread(session("remarked", { updatedAt: 100, readAt: 0 }))).toBe(true);
  });

  test("unreadCount spans every band, not just the visible page", () => {
    const rows = [
      session("a", { updatedAt: NOW - 1_000 }),
      session("b", { settledAt: NOW - 10 }),
      session("c", { snoozedUntil: NOW + 60_000 }),
      session("d", { updatedAt: NOW - 1_000, readAt: NOW }),
    ];
    expect(deriveSessionList({ sessions: rows, now: NOW, limit: 1 }).unreadCount).toBe(3);
  });

  test("a chip returns a flat, shelf-less view over one predicate", () => {
    const rows = [
      session("live"),
      session("rested", { settledAt: NOW - 10 }),
      session("deferred", { snoozedUntil: NOW + 60_000 }),
    ];
    const result = deriveSessionList({ sessions: rows, now: NOW, filter: "settled" });
    expect(result.sessions.map((r) => r.id)).toEqual(["rested"]);
    expect(result.flat).toBe(true);
    expect(result.settled).toEqual([]);
    expect(result.snoozed).toEqual([]);
  });

  test("a chip stays honored underneath a search", () => {
    const rows = [
      session("match-unread", { title: "Fix parser" }),
      session("match-read", { title: "Fix parser", readAt: NOW }),
      session("other-unread", { title: "Ship docs" }),
    ];
    const result = deriveSessionList({
      sessions: rows,
      now: NOW,
      query: "parser",
      filter: "unread",
    });
    expect(result.sessions.map((r) => r.id)).toEqual(["match-unread"]);
  });

  test("the open session surfaces out of the snoozed shelf exactly once", () => {
    const rows = [session("open", { snoozedUntil: NOW + 60_000 })];
    const result = deriveSessionList({ sessions: rows, activeSessionId: "open", now: NOW });
    expect(result.sessions.map((r) => r.id)).toEqual(["open"]);
    expect(result.snoozed).toEqual([]);
    expect(result.snoozedCount).toBe(0);
  });
});

test("activeSessionFromPathname only recognizes persisted session routes", () => {
  expect(activeSessionFromPathname("/projects/alpha/sessions/a%20b")).toBe("a b");
  expect(activeSessionFromPathname("/projects/alpha/sessions/new")).toBeUndefined();
  expect(activeSessionFromPathname("/projects/alpha")).toBeUndefined();
});

test("newSessionHref lands in the same project's fresh composer, not /", () => {
  expect(newSessionHref("alpha")).toBe("/projects/alpha/sessions/new");
  // Percent-encoded, same as every other session route builder in this app —
  // a project name with a slash or space must not split the path or land on
  // the wrong route.
  expect(newSessionHref("my project/v2")).toBe("/projects/my%20project%2Fv2/sessions/new");
});
