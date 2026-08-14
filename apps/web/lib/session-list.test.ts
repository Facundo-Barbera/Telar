/**
 * The rail's inbox derivation.
 *
 * What matters is that every band comes out of ONE function, so the rail can
 * never draw a shelf that contradicts the list above it — and that a session you
 * are currently LOOKING AT cannot disappear out from under you when it drops
 * into one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  bandOf,
  canvasHref,
  deriveSessionList,
  sessionHref,
  SETTLED_AFTER_MS,
  settlingActivity,
  toSidebarSession,
  type SidebarSession,
} from "./session-list";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const opts = { now: NOW, autoSettleAfterDays: 3 };

const row = (id: string, title: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title,
  projectId: "p1",
  projectName: "telar-vnext",
  activity: "idle",
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
    expect(bandOf(row("s1", "Done", { archived: true }), opts)).toBe("settled");
  });

  test("shelves a session settled by neglect", () => {
    expect(bandOf(row("s1", "Quiet", { updatedAt: NOW - SETTLED_AFTER_MS - 1 }), opts)).toBe("settled");
    // The boundary is where a row visibly moves, so it is worth pinning. It is
    // now STRICTLY past the window — the donor's comparison — where this used
    // to shelve a row at exactly the threshold.
    expect(bandOf(row("s1", "Quiet"), opts)).toBe("active");
    expect(bandOf(row("s1", "Quiet", { updatedAt: NOW - SETTLED_AFTER_MS }), opts)).toBe("active");
  });

  test("an explicit pin beats the clock, and gets a band of its own", () => {
    expect(bandOf(row("s1", "Shelved", { settledOverride: "settled" }), opts)).toBe("settled");
    expect(bandOf(row("s1", "Kept", { updatedAt: NOW - 30 * DAY, settledOverride: "active" }), opts)).toBe("pinned");
  });

  test("the window is a parameter, and null turns the clock off", () => {
    const stale = row("s1", "Ancient", { updatedAt: NOW - 400 * DAY });
    expect(bandOf(stale, { now: NOW, autoSettleAfterDays: null })).toBe("active");
    expect(bandOf(row("s1", "Quiet", { updatedAt: NOW - 4 * DAY }), { now: NOW, autoSettleAfterDays: 7 })).toBe("active");
  });

  test("a snooze hides a row, and outranks the pin it survives underneath", () => {
    // The whole point, and the thing that was written down and never called:
    // pressing a preset used to change nothing at all on screen.
    expect(bandOf(row("s1", "Later", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 60_000 }), opts)).toBe("snoozed");
    expect(
      bandOf(row("s1", "Later", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 60_000, settledOverride: "active" }), opts),
    ).toBe("snoozed");
    // Past its wake time it is simply not snoozed any more — which is why the
    // feature needs no timer, only this comparison.
    expect(bandOf(row("s1", "Woken", { snoozedUntil: NOW - 1, snoozedAt: NOW - HOUR }), opts)).toBe("active");
  });

  test("a blocker outranks the snooze that hid it", () => {
    const asking = row("s1", "Needs you", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 60_000, activity: "blocked" });
    expect(bandOf(asking, opts)).toBe("active");
    // And the work you snoozed FINISHING wakes it too — the fact the engine
    // had no way to report until it started deriving the last ended turn.
    const finished = row("s2", "Done early", {
      snoozedUntil: NOW + HOUR,
      snoozedAt: NOW - 60_000,
      lastTurnEndedAt: NOW - 30_000,
    });
    expect(bandOf(finished, opts)).toBe("active");
  });

  test("a blocker outranks a settle, however it was reached", () => {
    const blocked = row("s1", "Shelved but asking", { settledOverride: "settled", activity: "blocked" });
    expect(bandOf(blocked, opts)).toBe("active");
    const working = row("s2", "Stale but running", { updatedAt: NOW - 30 * DAY, activity: "working" });
    expect(bandOf(working, opts)).toBe("active");
  });
});

describe("settlingActivity", () => {
  test("queued counts as working, because a turn is on its way", () => {
    expect(settlingActivity(row("s1", "Q", { activity: "queued" })).working).toBe(true);
    expect(settlingActivity(row("s1", "B", { activity: "blocked" })).waitingOnYou).toBe(true);
    expect(settlingActivity(row("s1", "I", { activity: "idle" })).working).toBe(false);
  });

  test("a failure is dated by the turn that failed", () => {
    const activity = settlingActivity(row("s1", "Broke", { lastTurnFailed: true, lastTurnEndedAt: NOW - 5_000 }));
    expect(activity.failed).toBe(true);
    expect(activity.failedAt).toBe(NOW - 5_000);
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

  test("the pinned band is separate, and never paged", () => {
    const rows = [...FIXTURE, row("s4", "Keep this", { settledOverride: "active", createdAt: NOW - 4_000 })];
    const list = deriveSessionList({ sessions: rows, now: NOW, limit: 1 });
    expect(titles(list.pinned)).toEqual(["Keep this"]);
    // A pin is not a row in the list it was lifted out of.
    expect(titles(list.sessions)).not.toContain("Keep this");
    // `limit: 1` pages the live list and leaves the pin whole.
    expect(list.sessions).toHaveLength(1);
    expect(list.hasMoreSessions).toBe(true);
  });

  test("the snoozed shelf is sorted by what comes back FIRST", () => {
    const rows = [
      row("s4", "Next week", { snoozedUntil: NOW + 7 * DAY, snoozedAt: NOW - 1_000, createdAt: NOW - 9_000 }),
      row("s5", "In an hour", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 1_000, createdAt: NOW - 8_000 }),
    ];
    const list = deriveSessionList({ sessions: rows, now: NOW });
    // Everywhere else this rail sorts by recency; here recency is the wrong
    // end of the session, and the shelf answers "what returns next".
    expect(titles(list.snoozed)).toEqual(["In an hour", "Next week"]);
    expect(list.snoozedCount).toBe(2);
    expect(list.sessions).toEqual([]);
  });

  test("search reaches into the shelf and searches the project NAME too", () => {
    // The rail can be scoped to all projects, where "which project" is the one
    // piece of context a bare title is missing — so it has to be searchable.
    expect(titles(deriveSessionList({ sessions: FIXTURE, query: "other-project", now: NOW }).sessions)).toEqual(["Browser naming"]);
    // `Old spike` is shelved; a search must still be able to recover it.
    expect(titles(deriveSessionList({ sessions: FIXTURE, query: "spike", now: NOW }).sessions)).toEqual(["Old spike"]);
  });

  test("search reaches into the snoozed shelf too", () => {
    // The only way to reach a snoozed row on purpose rather than by waiting.
    const rows = [row("s4", "Deferred thing", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 1_000 })];
    const list = deriveSessionList({ sessions: rows, query: "deferred", now: NOW });
    expect(titles(list.sessions)).toEqual(["Deferred thing"]);
    expect(list.snoozed).toEqual([]);
    expect(list.flat).toBe(true);
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

  test("the open session survives a SNOOZE too", () => {
    // Reading a session you snoozed from another window is exactly as
    // disorienting as reading one that aged out, so the rule covers both.
    const rows = [row("s4", "Asleep", { snoozedUntil: NOW + HOUR, snoozedAt: NOW - 1_000 })];
    const list = deriveSessionList({ sessions: rows, activeSessionId: "s4", now: NOW });
    expect(titles(list.sessions)).toEqual(["Asleep"]);
    expect(list.snoozed).toEqual([]);
    expect(list.snoozedCount).toBe(0);
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

describe("canvasHref", () => {
  test("is the one spelling of the new-conversation route", () => {
    // THE COCKPIT DECIDES whether it is showing a canvas or a session by
    // comparing `usePathname()` against this string. A second spelling — the
    // sidebar's own template literal, which is where this came from — is a
    // screen that never resets when you press New conversation.
    expect(canvasHref("project_a")).toBe("/projects/project_a/sessions/new");
    expect(canvasHref("a/b")).toBe("/projects/a%2Fb/sessions/new");
    // And it must not be mistaken for a session by the sidebar's own reader.
    expect(sessionHref({ id: "s1", projectId: "project_a" })).not.toBe(canvasHref("project_a"));
  });
});
