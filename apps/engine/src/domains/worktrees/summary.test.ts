import { expect, test } from "bun:test";
import type { WorktreeRow } from "@telar/engine-client";
import { labelOf, summarizeWorktrees, volumeOf, type SessionFacts, type SummaryInput } from "./summary";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const GB = 1024 ** 3;

function row(path: string, patch: Partial<WorktreeRow> & { session?: string; lifecycle?: "live" | "settled" | "archived" } = {}): WorktreeRow {
  const { session, lifecycle, ...rest } = patch;
  return {
    path,
    basename: path.split("/").pop()!,
    branch: "telar/x",
    owner: session ? { kind: "session", sessionId: session, lifecycle: lifecycle ?? "settled" } : { kind: "none" },
    registered: true,
    onDisk: true,
    bytes: GB,
    clean: true,
    merged: false,
    verdict: { kind: "reclaimable" },
    ...rest,
  };
}

function summarize(rows: WorktreeRow[], options: { sessions?: Record<string, Partial<SessionFacts>>; current?: string; present?: string[] } = {}) {
  const sessions = new Map(Object.entries(options.sessions ?? {}).map(([id, facts]) => [id, { lastActiveAt: NOW, released: false, ...facts }]));
  const present = new Set(options.present ?? ["/Volumes/Old", "/Volumes/Old/live", "/Volumes/New", "/Volumes/New/wt", "/Users/me/wt"]);
  const input: SummaryInput = {
    inventory: { rows, roots: [], partial: false, measuredAt: NOW - 5_000 },
    sessions,
    current: options.current ?? "/Volumes/New/wt",
    defaultRoot: "/Users/me/.telar/engine/worktrees",
    idleDays: 7,
    now: NOW,
    exists: (folder) => present.has(folder),
  };
  return summarizeWorktrees(input);
}

test("worktrees are grouped by the folder they live in, current first, with counts and sizes", () => {
  const summary = summarize([row("/Volumes/Old/live/a"), row("/Volumes/Old/live/b", { bytes: 2 * GB }), row("/Volumes/New/wt/c")]);

  expect(summary.locations.map(({ folder, volume, current, present, worktrees }) => ({ folder, volume, current, present, worktrees }))).toEqual([
    { folder: "/Volumes/New/wt", volume: "New", current: true, present: true, worktrees: { count: 1, bytes: GB, unmeasured: 0 } },
    { folder: "/Volumes/Old/live", volume: "Old", current: false, present: true, worktrees: { count: 2, bytes: 3 * GB, unmeasured: 0 } },
  ]);
  expect(summary.checkedAt).toBe(NOW - 5_000);
});

test("the current location is listed even before anything has been made there", () => {
  const summary = summarize([row("/Volumes/Old/live/a")]);
  expect(summary.locations[0]).toMatchObject({ folder: "/Volumes/New/wt", current: true, worktrees: { count: 0, bytes: 0 } });
  expect(summary.locations[0]!.move).toBeUndefined();
});

test("a folder on a drive that is not plugged in is shown as absent, still counted, and offers no move", () => {
  const summary = summarize([row("/Volumes/Gone/live/a", { onDisk: false, bytes: undefined, session: "s1" })], { sessions: { s1: {} } });
  const gone = summary.locations.find((location) => location.folder === "/Volumes/Gone/live");
  expect(gone).toMatchObject({ volume: "Gone", present: false, worktrees: { count: 1, unmeasured: 1 } });
  expect(gone!.move).toBeUndefined();
});

test("a released checkout and one that vanished from a connected disk are not counted", () => {
  const summary = summarize([
    row("/Volumes/Old/live/released", { onDisk: false, session: "s1" }),
    row("/Volumes/Old/live/vanished", { onDisk: false }),
  ], { sessions: { s1: { released: true } } });
  expect(summary.locations.find((location) => location.folder === "/Volumes/Old/live")).toBeUndefined();
});

test("every worktree falls in one state, and only proven-safe ones are offered for release", () => {
  const summary = summarize(
    [
      row("/Users/me/wt/live", { session: "live", lifecycle: "live", verdict: { kind: "locked", reason: "active" } }),
      row("/Users/me/wt/busy", { session: "busy", lifecycle: "settled", verdict: { kind: "locked", reason: "in-use" } }),
      row("/Users/me/wt/archived", { session: "archived", lifecycle: "archived" }),
      row("/Users/me/wt/orphan"),
      row("/Users/me/wt/merged", { session: "merged", merged: true }),
      row("/Users/me/wt/idle", { session: "idle" }),
      row("/Users/me/wt/idle-dirty", { session: "idle-dirty", clean: false, verdict: { kind: "needs-force", reasons: ["dirty"] } }),
      row("/Users/me/wt/recent", { session: "recent" }),
    ],
    { sessions: { idle: { lastActiveAt: NOW - 10 * DAY }, "idle-dirty": { lastActiveAt: NOW - 30 * DAY }, recent: { lastActiveAt: NOW - DAY } } },
  );

  const byState = Object.fromEntries(summary.states.map((entry) => [entry.state, [entry.worktrees.count, entry.releasable.count]]));
  expect(byState).toEqual({ "in-use": [2, 0], archived: [1, 1], orphaned: [1, 1], unchanged: [1, 1], idle: [2, 1], recent: [1, 0] });
  expect(summary.states.reduce((sum, entry) => sum + entry.worktrees.count, 0)).toBe(8);
});

test("moving out of a folder counts what moves and why the rest stays put", () => {
  const summary = summarize([
    row("/Volumes/Old/live/ok", { session: "a" }),
    row("/Volumes/Old/live/ok2", { session: "b", bytes: 2 * GB }),
    row("/Volumes/Old/live/dirty", { session: "c", clean: false }),
    row("/Volumes/Old/live/busy", { session: "d", verdict: { kind: "locked", reason: "in-use" } }),
    row("/Volumes/Old/live/orphan"),
    row("/Volumes/Old/live/detached", { session: "e", branch: undefined }),
  ]);
  expect(summary.locations.find((location) => location.folder === "/Volumes/Old/live")!.move).toEqual({
    movable: { count: 2, bytes: 3 * GB, unmeasured: 0 },
    staying: { busy: 1, dirty: 1, unowned: 1, detached: 1 },
  });
});

test("sizes not measured yet are reported as such, never as zero", () => {
  const summary = summarize([row("/Users/me/wt/a", { bytes: undefined })]);
  expect(summary.measuring).toBe(true);
  expect(summary.locations.find((location) => location.folder === "/Users/me/wt")!.worktrees).toEqual({ count: 1, bytes: 0, unmeasured: 1 });
});

test("a location is labelled Default, by its drive, or by its last two folders", () => {
  expect(labelOf("/Users/me/.telar/engine/worktrees", "/Users/me/.telar/engine/worktrees")).toBe("Default");
  expect(labelOf("/Volumes/Focaltec HD/live/Telar", "/Users/me/.telar/engine/worktrees")).toBe("Focaltec HD");
  expect(labelOf("/Users/me/code/worktrees", "/Users/me/.telar/engine/worktrees")).toBe("code/worktrees");
});

test("a drive's name comes from its mount point; the host's own disk has none", () => {
  expect(volumeOf("/Volumes/Focaltec HD/live/Telar")).toBe("Focaltec HD");
  expect(volumeOf("/Users/me/Library/worktrees")).toBeUndefined();
});
