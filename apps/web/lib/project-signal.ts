// How busy is a project? Pure — no React, no fetch — because four surfaces ask
// that question of the same three payloads and, until this module, four
// different answers came back. The Projects index counted `running` and
// `openLooms`, the dashboard's Hot projects counted `running` and `open`, the
// sidebar counted "not terminal", the project header counted `running` and
// `needsYou`. Same looms, same chats, four vocabularies — so one project could
// read "All quiet" in its own header while the sidebar beside it pulsed.
//
// The cure is not a mode flag. Every legitimate difference between those
// surfaces is WHICH BUCKET IT RENDERS, never how the bucket is computed: an
// index showing a single "open work" number and a project page showing
// needs-you apart from ready are both right about the same data. So this module
// hands back every bucket and lets the surface choose, and a mode enum would
// only teach the model about the surfaces. The one thing that really is a
// parameter is `now` — injected so "today" is a fact a test can state. Honesty
// about that: no production caller injects it yet, so in the app this module is
// pure GIVEN `now` and reads the wall clock (in local time) by default. Only
// `chatsToday` depends on it. Both callers that render it were already re-reading
// the clock the same way at phase 1, so nothing got staler — but a caller that
// wants two derivations in one render to agree on where today starts has to say
// so, and a server component would have to say so too.
import type { Loom, WorkUnitState } from "@telar/core";

/* ------------------------------------------------------------- vocabulary */

// FOUR BUCKETS, and every WorkUnitState lands in exactly one (project-signal
// .test.ts walks the enum and proves it, so a fourteenth state fails loudly
// instead of falling into whichever bucket happens to catch the remainder).
//
// IN_FLIGHT is byte-for-byte the dispatcher's IN_FLIGHT_STATES
// (packages/core/src/dispatcher.ts) — "this loom is mid-run and expects a live
// runner". That is exactly the claim a pulsing dot makes on the reader's
// behalf, which is why the engine's set and not a UI approximation owns it.
const IN_FLIGHT: readonly WorkUnitState[] = [
  "queued",
  "scoping",
  "preparing",
  "running",
  "verifying",
];

// The attention side splits in two because `ready` is not `blocked`. A ready
// loom means the machine finished, verified itself, and is waiting to be
// ACCEPTED — the human-accept moat (docs/loom-model.md §A). The other four mean
// a decision is owed before anything can move at all. Index surfaces fold the
// two together into one "open work" number and are right to; the project page
// shows them apart and is right to. Separate fields are what lets both be true
// without either one re-deriving the split.
const AWAITING_DECISION: readonly WorkUnitState[] = [
  "charter-review",
  "needs-review",
  "blocked",
  "failed",
];
const AWAITING_ACCEPT: readonly WorkUnitState[] = ["ready"];
const CLOSED: readonly WorkUnitState[] = ["done", "halted", "skipped"];

export const isLoomRunning = (s: WorkUnitState): boolean => IN_FLIGHT.includes(s);
export const isLoomAwaitingDecision = (s: WorkUnitState): boolean =>
  AWAITING_DECISION.includes(s);
export const isLoomAwaitingAccept = (s: WorkUnitState): boolean =>
  AWAITING_ACCEPT.includes(s);
export const isLoomClosed = (s: WorkUnitState): boolean => CLOSED.includes(s);

// The coarse index fold: one "waiting on you" bucket over both attention
// states. `isLoomRecent` is the name the indexes have always used for closed
// work; it used to be defined as "neither running nor needs-you", which meant
// any state added to the enum silently became "recent". It is now the CLOSED
// set by name, and the partition test is what keeps the two readings equal.
export const isLoomNeedsYou = (s: WorkUnitState): boolean =>
  isLoomAwaitingDecision(s) || isLoomAwaitingAccept(s);
export const isLoomRecent = isLoomClosed;

// DEPRECATED — do not reach for this in new code. It is the sidebar's current
// notion of "this project is busy": the complement of components/looms/utils'
// isTerminal, which was written to answer a different question ("has this
// loom's event stream closed?") and folds needs-review and failed in with done.
// Read as project busyness it is wrong on both edges — it pulses the weaving
// glyph for charter-review, ready and blocked (states the dispatcher documents
// as paused BY DESIGN, with no runner) and it hides the two states that most
// need a human. It exists here, spelled out in this module's own vocabulary
// rather than imported, so that all four derivations live in one tested file
// while the sidebar's pixels stay exactly where phase 1 left them. Phase 2b
// deletes it and the divergence together.
export const isLoomLegacyActive = (s: WorkUnitState): boolean =>
  !isLoomClosed(s) && s !== "needs-review" && s !== "failed";

/* ------------------------------------------------------------------ input */

// Structural rather than the wire types, for the same reason provider-order's
// OrderableAccount is: this module reads a name, a registration date and two
// timestamps, and narrowing the input to those lets the sidebar (which types
// its projects as {name, addedAt} and its chats with a title) pass its own
// records without either side widening to match the other.
export type ProjectSource = { entry: { name: string; addedAt: number } };
export type ChatTouch = { project?: string; updatedAt: number };

export type ProjectSignalInput<P extends ProjectSource, C extends ChatTouch> = {
  projects: readonly P[];
  looms: readonly Loom[];
  chats: readonly C[];
  // Defaults to the wall clock. Passed explicitly by tests, and by any caller
  // that needs two derivations in one render to agree on where today starts.
  now?: number;
};

export type ProjectSignal<
  P extends ProjectSource = ProjectSource,
  C extends ChatTouch = ChatTouch,
> = {
  name: string;
  // The caller's own project record, handed straight back, so a row can read
  // the manifest and root it already had without a second lookup by name.
  project: P;

  // The partition, in the order the payload arrived — the sidebar renders this
  // list, so input order is part of the output.
  inFlight: Loom[];
  awaitingDecision: Loom[];
  awaitingAccept: Loom[];
  closed: Loom[];
  // DEPRECATED, sidebar-only — see isLoomLegacyActive. Overlaps the buckets
  // above rather than partitioning with them.
  legacyActive: Loom[];

  counts: {
    inFlight: number;
    awaitingDecision: number;
    awaitingAccept: number;
    // Everything not closed: the single number an index shows when it has one
    // column for "work that is still open".
    open: number;
  };

  // Today's sessions, newest first. "Today" is local-midnight-to-now-or-later:
  // a timestamp in the future counts, because a clock that disagrees with the
  // filesystem should not make a session disappear. That is the Projects
  // index's boundary and always was; the sidebar's was a calendar-day compare
  // that hid the future, and it narrows this list itself rather than making
  // this module carry two answers. Phase 2b removes the narrowing.
  chatsToday: C[];

  // WHEN SOMETHING LAST HAPPENED HERE, and when the ROW last changed — two
  // fields because the two surfaces mean different things by "recent".
  // lastTouch is null for a project nothing has ever run in; lastActivity
  // floors it at registration, so a freshly registered repo sorts as new
  // rather than as whatever its oldest surviving loom remembers (which is
  // reachable: unregister drops the registry entry while looms and chats
  // survive in TELAR_HOME, so re-registering stamps a fresh addedAt).
  lastTouch: number | null;
  lastActivity: number;
};

/* ------------------------------------------------------------- derivation */

const startOfDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function push<T>(into: Map<string, T[]>, key: string, value: T): void {
  const list = into.get(key);
  if (list) list.push(value);
  else into.set(key, [value]);
}

export function deriveProjectSignals<P extends ProjectSource, C extends ChatTouch>({
  projects,
  looms,
  chats,
  now = Date.now(),
}: ProjectSignalInput<P, C>): ProjectSignal<P, C>[] {
  const dayStart = startOfDay(now);

  // Bucket by project once instead of once per row. The index used to filter
  // the whole loom list and the whole chat list inside the map over projects,
  // which is fine at ten repos and quietly quadratic past that.
  const loomsBy = new Map<string, Loom[]>();
  for (const l of looms) push(loomsBy, l.project, l);
  const chatsBy = new Map<string, C[]>();
  for (const c of chats) if (c.project) push(chatsBy, c.project, c);

  return projects.map((project) => {
    const name = project.entry.name;
    const mine = loomsBy.get(name) ?? [];
    const myChats = chatsBy.get(name) ?? [];

    const inFlight: Loom[] = [];
    const awaitingDecision: Loom[] = [];
    const awaitingAccept: Loom[] = [];
    const closed: Loom[] = [];
    const legacyActive: Loom[] = [];
    let lastTouch: number | null = null;

    // A touch has to be a real number to count. `updatedAt` is typed as one,
    // but readChats (lib/store.ts) casts the parsed JSON rather than validating
    // it, so a legacy or hand-edited chats.json can hand us a row without one —
    // and this is a DECLARED DIVERGENCE from what the sidebar did before. The
    // old accumulator was `Math.max(prev ?? 0, ts)`, which turns a single
    // missing timestamp into NaN and keeps it: the project's recency became NaN,
    // its comparator returned NaN, the sort silently gave up and left the
    // Recents rows in registry order, and the Projects index rendered the
    // literal string "NaNy ago". Skipping the bad row instead means the project
    // is ranked by its remaining real touches. The guard is also what makes
    // `lastTouch: number | null` true at runtime rather than just on paper.
    const touch = (ts: number) => {
      if (Number.isFinite(ts) && (lastTouch === null || ts > lastTouch)) lastTouch = ts;
    };

    for (const l of mine) {
      if (isLoomRunning(l.state)) inFlight.push(l);
      else if (isLoomAwaitingDecision(l.state)) awaitingDecision.push(l);
      else if (isLoomAwaitingAccept(l.state)) awaitingAccept.push(l);
      else closed.push(l);
      if (isLoomLegacyActive(l.state)) legacyActive.push(l);
      touch(l.updatedAt);
    }
    for (const c of myChats) touch(c.updatedAt);

    return {
      name,
      project,
      inFlight,
      awaitingDecision,
      awaitingAccept,
      closed,
      legacyActive,
      counts: {
        inFlight: inFlight.length,
        awaitingDecision: awaitingDecision.length,
        awaitingAccept: awaitingAccept.length,
        open: inFlight.length + awaitingDecision.length + awaitingAccept.length,
      },
      chatsToday: myChats
        .filter((c) => c.updatedAt >= dayStart)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      lastTouch,
      lastActivity: Math.max(project.entry.addedAt, lastTouch ?? project.entry.addedAt),
    };
  });
}

/* ------------------------------------------------------------ comparators */

// Only what the comparators read, so a caller's richer signal still fits.
type Ranked = Pick<ProjectSignal, "lastActivity" | "counts">;

export const byLastActivity = (a: Ranked, b: Ranked): number =>
  b.lastActivity - a.lastActivity;

// A RUNNING LOOM COUNTS TWICE. `open` already contains the in-flight ones, so
// adding `inFlight` again weights work the machine is doing right now above the
// same amount of work sitting in a queue for a human — which is what "sort by
// open work" is asked for. Both the Projects index and the dashboard's Hot
// projects were already doing exactly this arithmetic; naming it here is the
// only thing that changed.
export const byOpenWork = (a: Ranked, b: Ranked): number =>
  b.counts.inFlight + b.counts.open - (a.counts.inFlight + a.counts.open);
