/**
 * What a sidebar row says about itself.
 *
 * The wording is the product here: these strings are what somebody reads while
 * deciding which of twenty rows to open, and every wrong one sends them to the
 * wrong row.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { ACTIVITY_TONE, activityBadge, fmtDuration, rowStatusText, rowSubtitle } from "./session-activity";

describe("activityBadge", () => {
  test("a session waiting for a human says so in the second person", () => {
    // The engine's word is "blocked", which is about the TURN. The row's word
    // has to be about the reader, because they are the thing that unblocks it.
    expect(activityBadge("blocked")).toEqual({ label: "Waiting on you", tone: "attention", ticking: false });
  });

  test("the two states worth seeing across the room have their own colours", () => {
    expect(activityBadge("working")?.tone).toBe("live");
    expect(activityBadge("queued")?.tone).toBe("quiet");
    // WARNING FOR "ACT", PRIMARY FOR "ALIVE" — both from globals.css's five
    // tokens, never a raw ramp. `live` was plain foreground on the first pass,
    // which made a running turn look identical to the timestamp it replaces:
    // the badge was legible only if you were already reading that row, which
    // is the opposite of what it is for.
    expect(ACTIVITY_TONE.attention).toBe("text-warning");
    expect(ACTIVITY_TONE.live).toBe("text-primary");
    // `queued` stays grey on purpose: three coloured states and none of them
    // is a signal any more.
    expect(ACTIVITY_TONE.quiet).toBe("text-muted-foreground");
  });

  test("a resting session gets no badge at all", () => {
    // An "Idle" pill on every quiet row is chrome that says only "this row
    // exists" — and it would push the timestamp, which IS useful, off the line.
    expect(activityBadge("idle")).toBeNull();
  });

  test("only a state with a real start ticks", () => {
    expect(activityBadge("working")?.ticking).toBe(true);
    // How long a turn has sat in the queue is not the reader's business, and a
    // ticking number implies something is happening.
    expect(activityBadge("queued")?.ticking).toBe(false);
  });
});

test("the status takes the timestamp's slot rather than sitting beside it", () => {
  const now = 1_800_000_000_000;
  const base = { updatedAt: now - 3 * 60 * 60_000 };
  // Both are computed; the ROW picks one. A row showing "Working" and "3h ago"
  // at once invites the question of which one is now.
  const working = rowStatusText({ ...base, activity: "working", activityAt: now - 180_000 }, now);
  expect(working.badge?.label).toBe("Working");
  expect(working.time).toBe("3h ago");

  const idle = rowStatusText({ ...base, activity: "idle" }, now);
  expect(idle.badge).toBeNull();
  expect(idle.time).toBe("3h ago");
});

test("a duration is a duration, not a timestamp", () => {
  const now = 1_800_000_000_000;
  // "Working 3m ago" would be wrong in a way that matters: the work did not
  // happen 3 minutes ago, it started then and is still going.
  expect(fmtDuration(now - 45_000, now)).toBe("45s");
  expect(fmtDuration(now - 180_000, now)).toBe("3m");
  expect(fmtDuration(now - 3 * 60 * 60_000, now)).toBe("3h");
  expect(fmtDuration(now - 50 * 60 * 60_000, now)).toBe("2d");
  // Seconds below a minute, so a turn that just began does not read as "0m".
  expect(fmtDuration(now, now)).toBe("0s");
  // A clock that ran backwards must not print a negative age.
  expect(fmtDuration(now + 10_000, now)).toBe("0s");
});

describe("rowSubtitle", () => {
  test("the branch wins, because it is the most stable identifier", () => {
    // t3's own correction: the plan step used to take this slot while a thread
    // worked, "but it truncated to a half-sentence and dropped the branch".
    expect(rowSubtitle({ worktreeBranch: "feat/x", projectName: "telar", workspacePath: "/a/b" })).toEqual({
      text: "feat/x",
      kind: "branch",
    });
  });

  test("a local session names its project — unless the header already did", () => {
    expect(rowSubtitle({ projectName: "telar-vnext", workspacePath: "/a/telar-vnext" })).toEqual({
      text: "telar-vnext",
      kind: "project",
    });
    // THE ONE THIS EXISTS FOR. In an all-projects list the card's header line
    // already names the project, and falling back to it here printed the same
    // word twice, one line apart. Found by reading a rendered row.
    expect(rowSubtitle({ projectName: "telar-vnext", workspacePath: "/a/telar-vnext" }, { projectShown: true })).toBeNull();
    // A branch still wins over the header — it is a different fact.
    expect(
      rowSubtitle({ worktreeBranch: "feat/x", projectName: "telar", workspacePath: "/a" }, { projectShown: true }),
    ).toEqual({ text: "feat/x", kind: "branch" });
  });

  test("and with the leaf of its path when it has nothing else", () => {
    // The leaf, not the whole path: a 220px column truncates an absolute path
    // to its least distinctive half.
    expect(rowSubtitle({ workspacePath: "/Users/x/Projects/ozom-gv" })).toEqual({ text: "ozom-gv", kind: "path" });
    expect(rowSubtitle({ workspacePath: "/" })).toEqual({ text: "/", kind: "path" });
  });
});
