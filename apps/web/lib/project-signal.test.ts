// The record of what the four project surfaces now agree on — and, just as
// importantly, of the three places they still deliberately don't.
//
// Most of these cases are not hypotheticals. Each one below marked DIVERGENCE
// is a real disagreement that was on screen before this module existed: a
// project reading "All quiet" in its own header while the sidebar beside it
// pulsed, three failed looms visible on two surfaces and invisible on a third,
// two adjacent dashboard panels disagreeing about whether a repo is busy. The
// tests pin WHICH ANSWER EACH SURFACE NOW GETS, so that when phase 2b changes
// one of them it has to change a line here and say so.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { WorkUnitState, type Loom } from "@telar/core";
import {
  byLastActivity,
  byOpenWork,
  deriveProjectSignals,
  isLoomAwaitingAccept,
  isLoomAwaitingDecision,
  isLoomClosed,
  isLoomNeedsYou,
  isLoomRecent,
  isLoomRunning,
  type ProjectSource,
} from "@/lib/project-signal";

const ALL_STATES = WorkUnitState.options as WorkUnitState[];

const NOON = new Date(2026, 6, 31, 12, 0, 0).getTime();
const MORNING = new Date(2026, 6, 31, 7, 30, 0).getTime();
const YESTERDAY = new Date(2026, 6, 30, 23, 30, 0).getTime();

let seq = 0;
const loom = (project: string, state: WorkUnitState, updatedAt = MORNING): Loom => ({
  id: `l${++seq}`,
  project,
  kind: "quickfix",
  title: `${project} ${state}`,
  prompt: "",
  account: "personal",
  state,
  createdAt: updatedAt,
  updatedAt,
  attempts: [],
  error: null,
});

// Carries a field the module never reads, because it must not: the sidebar
// passes chats with titles and the Projects index passes chats without, and
// both get their own record back.
type TestChat = { id: string; title: string; project?: string; updatedAt: number };
const chat = (project: string | undefined, updatedAt: number): TestChat => ({
  id: `c${++seq}`,
  title: "session",
  project,
  updatedAt,
});

const proj = (name: string, addedAt = YESTERDAY): ProjectSource => ({
  entry: { name, addedAt },
});

const derive = (
  projects: ProjectSource[],
  looms: Loom[],
  chats: TestChat[] = [],
  now = NOON,
) => deriveProjectSignals({ projects, looms, chats, now });

const one = (looms: Loom[], chats: TestChat[] = [], now = NOON) =>
  derive([proj("api")], looms, chats, now)[0];

describe("the state vocabulary", () => {
  test("every WorkUnitState lands in exactly one of the four buckets", () => {
    for (const s of ALL_STATES) {
      const hits = [
        isLoomRunning(s),
        isLoomAwaitingDecision(s),
        isLoomAwaitingAccept(s),
        isLoomClosed(s),
      ].filter(Boolean);
      expect([s, hits.length]).toEqual([s, 1]);
    }
  });

  test("in-flight is the dispatcher's set — nothing awaiting a human is in it", () => {
    expect(ALL_STATES.filter(isLoomRunning)).toEqual([
      "queued",
      "scoping",
      "preparing",
      "running",
      "verifying",
    ]);
  });

  // The membership of the other three sets, written out. The
  // `isLoomAwaitingDecision` predicate is what the
  // project header's "N need you" and the Looms tab's "Needs you" group are
  // made of. Moving a state out of it should cost someone a failing test, not
  // go unnoticed because the coarse-fold check below is true by definition.
  test("the attention and closed sets, enumerated", () => {
    expect(ALL_STATES.filter(isLoomAwaitingDecision)).toEqual([
      "charter-review",
      "needs-review",
      "blocked",
      "failed",
    ]);
    expect(ALL_STATES.filter(isLoomAwaitingAccept)).toEqual(["ready"]);
    expect(ALL_STATES.filter(isLoomClosed)).toEqual(["done", "halted", "skipped"]);
  });

  test("the indexes' coarse fold is exactly the two attention buckets", () => {
    for (const s of ALL_STATES) {
      expect([s, isLoomNeedsYou(s)]).toEqual([
        s,
        isLoomAwaitingDecision(s) || isLoomAwaitingAccept(s),
      ]);
    }
    // ready is the moat state: folded into "needs you" on an index, kept apart
    // on the project page. Both readings come off the same partition.
    expect(isLoomNeedsYou("ready")).toBe(true);
    expect(isLoomAwaitingDecision("ready")).toBe(false);
  });

  test("isLoomRecent still means closed, as it did when it meant 'neither of the others'", () => {
    for (const s of ALL_STATES) {
      expect([s, isLoomRecent(s)]).toEqual([s, !isLoomRunning(s) && !isLoomNeedsYou(s)]);
    }
  });
});

describe("bucketing", () => {
  test("looms are grouped by project and nothing leaks across", () => {
    const signals = derive(
      [proj("api"), proj("web")],
      [loom("api", "running"), loom("web", "failed"), loom("api", "ready")],
    );
    expect(signals.map((s) => [s.name, s.counts.open])).toEqual([
      ["api", 2],
      ["web", 1],
    ]);
    expect(signals[0].inFlight).toHaveLength(1);
    expect(signals[0].awaitingAccept).toHaveLength(1);
  });

  test("a project with no looms and no chats is all zeros, not undefined", () => {
    const s = one([]);
    expect(s.counts).toEqual({
      inFlight: 0,
      awaitingDecision: 0,
      awaitingAccept: 0,
      open: 0,
    });
    expect(s.lastTouch).toBeNull();
  });

  test("bucket order follows the payload — the sidebar renders this list", () => {
    const a = loom("api", "running", 1);
    const b = loom("api", "queued", 9);
    const s = one([a, b]);
    expect(s.inFlight.map((l) => l.id)).toEqual([a.id, b.id]);
  });

  test("looms belonging to no registered project are simply absent", () => {
    const signals = derive([proj("api")], [loom("ghost", "running")]);
    expect(signals[0].counts.open).toBe(0);
  });
});

describe("DIVERGENCE — a project whose only loom is `ready`", () => {
  // Four surfaces, four readings, two of them on screen at once. All four are
  // preserved here; 2b is where "All quiet" stops being one of them.
  const s = one([loom("api", "ready")]);

  test("the Projects index: no live dot, one open loom, filed under Active", () => {
    expect(s.counts.inFlight).toBe(0); // no LiveDot
    expect(s.counts.open).toBe(1); // the WorkflowIcon metric
  });

  test("the dashboard's Hot projects: no clock chip, '1 open'", () => {
    expect(s.counts.inFlight).toBe(0);
    expect(s.counts.open).toBe(1);
  });

  test("the project header STILL reads 'All quiet' — the bug is preserved on purpose", () => {
    // The header shows counts.inFlight running · counts.awaitingDecision need
    // you, and falls through to "All quiet" when both are zero. A verified loom
    // waiting on its owner is neither, so the moat state renders as silence.
    // counts.awaitingAccept is the field that fixes it, and 2b is where the
    // header starts reading it.
    expect(s.counts.inFlight).toBe(0);
    expect(s.counts.awaitingDecision).toBe(0);
    expect(s.counts.awaitingAccept).toBe(1);
  });

});

describe("needs-review and failed", () => {
  const s = one([
    loom("api", "failed"),
    loom("api", "failed"),
    loom("api", "needs-review"),
  ]);

  test("three surfaces count them as work that needs a human", () => {
    expect(s.counts.awaitingDecision).toBe(3); // header: "3 need you"
    expect(s.counts.open).toBe(3); // index + Hot projects
  });
});

describe("charter-review and blocked", () => {
  const s = one([loom("api", "charter-review"), loom("api", "blocked")]);

  test("they are waiting on a human, and every count says so", () => {
    expect(s.counts.inFlight).toBe(0);
    expect(s.counts.awaitingDecision).toBe(2);
  });
});

describe("global sidebar semantics", () => {
  test("in-flight and needs-you remain distinct", () => {
    const s = one([
      loom("api", "running"),
      loom("api", "ready"),
      loom("api", "ready"),
      loom("api", "needs-review"),
      loom("api", "failed"),
    ]);
    expect(s.counts.inFlight).toBe(1); // the dashboard's "Running now"
    expect(s.counts.awaitingDecision + s.counts.awaitingAccept).toBe(4); // "Needs you"
  });
});

describe("DIVERGENCE — a project where only sessions moved", () => {
  const s = one([], [chat("api", MORNING)]);

  test("the Projects index files it under Active (sessions count as activity)", () => {
    expect(s.chatsToday).toHaveLength(1);
  });

  test("the dashboard's Hot projects STILL drops it — that panel is looms-only", () => {
    expect(s.counts.open).toBe(0);
  });

  test("the session remains available to session-list derivation", () => {
    expect(s.chatsToday).toHaveLength(1);
  });
});

describe("today", () => {
  test("today starts at local midnight, not 24 hours ago", () => {
    const s = one([], [chat("api", YESTERDAY), chat("api", MORNING)]);
    expect(s.chatsToday).toHaveLength(1);
  });

  test("newest first", () => {
    const older = chat("api", MORNING);
    const newer = chat("api", NOON - 1);
    const s = one([], [older, newer]);
    expect(s.chatsToday.map((c) => c.id)).toEqual([newer.id, older.id]);
  });

  // The one place the module and the sidebar still disagree, so it is pinned at
  // the only timestamp that can tell them apart. The sidebar's compare is
  // same-calendar-day, so anything later today (NOON + 60s, NOON + 11h) is
  // "today" to BOTH and proves nothing; only a date on a LATER DAY separates
  // them. The module admits it — a session the filesystem dates in the future
  // is a clock disagreement, not a reason for a row to vanish — and
  // app-sidebar.tsx re-filters this list with its own isToday until 2b.
  test("a session dated TOMORROW still counts as today here", () => {
    const s = one([], [chat("api", NOON + 24 * 60 * 60 * 1000)]);
    expect(s.chatsToday).toHaveLength(1);
  });

  test("...but yesterday never does, from either side of midnight", () => {
    const justBefore = new Date(2026, 6, 30, 23, 59, 59, 999).getTime();
    const justAfter = new Date(2026, 6, 31, 0, 0, 0, 0).getTime();
    const s = one([], [chat("api", justBefore), chat("api", justAfter)]);
    expect(s.chatsToday.map((c) => c.updatedAt)).toEqual([justAfter]);
  });

  test("a chat with no project belongs to no project", () => {
    const s = one([], [chat(undefined, MORNING)]);
    expect(s.chatsToday).toHaveLength(0);
  });
});

describe("DIVERGENCE — recency has two honest answers, so it has two fields", () => {
  // Reachable, not theoretical: unregistering a project deletes its registry
  // entry while its looms and chats survive in TELAR_HOME, so re-registering
  // stamps a fresh addedAt over old work.
  const REREGISTERED = NOON - 1000;
  const s = derive(
    [proj("api", REREGISTERED)],
    [loom("api", "done", YESTERDAY)],
  )[0];

  test("the Projects index sorts it as new — lastActivity floors at registration", () => {
    expect(s.lastActivity).toBe(REREGISTERED);
  });

  test("the sidebar STILL sorts it by the old loom — lastTouch has no floor", () => {
    expect(s.lastTouch).toBe(YESTERDAY);
  });

  test("with no touches at all, lastActivity is the registration date", () => {
    const fresh = derive([proj("api", MORNING)], [])[0];
    expect(fresh.lastTouch).toBeNull();
    expect(fresh.lastActivity).toBe(MORNING);
  });

  test("chats count as touches, not just looms", () => {
    const t = one([loom("api", "done", MORNING)], [chat("api", NOON - 1)]);
    expect(t.lastTouch).toBe(NOON - 1);
  });

  // DECLARED CHANGE, not a transcription. The sidebar's old accumulator was
  // `Math.max(prev ?? 0, ts)`; one row without an updatedAt made it NaN and it
  // stayed NaN through every later row, so the project's recency comparator
  // returned NaN, the sort quietly kept registry order, and the Projects index
  // printed "NaNy ago". readChats casts its JSON instead of parsing it, so the
  // input is reachable. This module skips the bad row and ranks the project by
  // what it does know. If someone reverts the guard, this is the test that says
  // what they gave back.
  test("a chat with no updatedAt no longer poisons recency to NaN", () => {
    const broken = { id: "cx", title: "session", project: "api" } as unknown as TestChat;
    const s = one([loom("api", "done", MORNING)], [broken]);
    expect(s.lastTouch).toBe(MORNING);
    expect(s.lastActivity).toBe(MORNING);
  });

  test("lastTouch is null, never undefined, when every touch is malformed", () => {
    const broken = { id: "cx", title: "session", project: "api" } as unknown as TestChat;
    const s = derive([proj("api", MORNING)], [], [broken]);
    expect(s[0].lastTouch).toBeNull();
    expect(s[0].lastActivity).toBe(MORNING);
  });
});

describe("comparators", () => {
  test("last active, newest first", () => {
    const signals = derive(
      [proj("api", YESTERDAY), proj("web", MORNING)],
      [],
    ).sort(byLastActivity);
    expect(signals.map((s) => s.name)).toEqual(["web", "api"]);
  });

  // Preserved arithmetic, now stated once: five failed looms still outrank one
  // running loom, because five pieces of open work outweigh a doubled one.
  test("open work counts a running loom twice — and five stalled ones still win", () => {
    const signals = derive(
      [proj("api"), proj("web")],
      [
        loom("api", "running"),
        ...Array.from({ length: 5 }, () => loom("web", "failed")),
      ],
    ).sort(byOpenWork);
    expect(signals.map((s) => s.name)).toEqual(["web", "api"]);
  });

  test("but one running loom outranks one waiting one", () => {
    const signals = derive(
      [proj("api"), proj("web")],
      [loom("api", "blocked"), loom("web", "running")],
    ).sort(byOpenWork);
    expect(signals.map((s) => s.name)).toEqual(["web", "api"]);
  });
});
