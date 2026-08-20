/**
 * THE LOBBY — mission control, ranked, never enumerated. `docs/spool-loops.md`
 * §13.2: "a subject earns a card by having a session running, needing you, or
 * having moved; everything else folds to a quiet line under its area header."
 *
 * PURE COMPOSITION, LIKE `briefing.ts`. Every input here is something the
 * store already reads for another route — subjects, areas, the thread map,
 * the stored looks, the items, and a per-subject session-liveness answer the
 * caller resolves (see `EngineStore.spoolLobby` for why that one join cannot
 * live in a pure function: it needs `listProjects`/`listSessions`/`turns`,
 * which touch disk). No model call anywhere in this file.
 */
import type {
  SpoolArea,
  SpoolItem,
  SpoolLobby,
  SpoolLobbyArea,
  SpoolLobbySubject,
  SpoolLookOutcome,
  SpoolSubject,
  SpoolSubjectThreads,
} from "@telar/engine-client";
import { dayLabel } from "./focus";
import { sortSubjectsByRank } from "./subjects";

/** Same two-stage, locale-free compare `store.ts`'s `compareSubjects` uses for
 *  subject names — copied rather than imported, because that one is a project
 *  STRING and this one is an area NAME; importing it would tie two unrelated
 *  axes to one private helper for no shared meaning. */
function compareNames(a: string, b: string): number {
  const fa = a.toLowerCase();
  const fb = b.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pin's own weekday, derived from ITS date, never from `new Date()` with
 *  no argument — the clock law's "no renderer reads a live clock" holds
 *  because nothing here asks what day it is now, only what day a stored
 *  `YYYY-MM-DD` fell on. */
function pinWeekday(day: string): string {
  return dayLabel(new Date(`${day}T00:00:00`));
}

export function composeLobby(input: {
  subjects: SpoolSubject[];
  areas: SpoolArea[];
  /** One entry per subject, from `spoolMap().subjects` — carries this
   *  subject's threads, keyed by `.subject`. */
  map: SpoolSubjectThreads[];
  /** One entry per subject, from `spoolLooks()` — the STORED look, never a
   *  fresh `gh` read; this route touches no network, same as the lobby's own
   *  pull-only law. */
  looks: SpoolLookOutcome[];
  /** Every readable item, any subject — filtered per subject inside. */
  items: SpoolItem[];
  /** Resolved by the caller (see the module doc) — `null` is the honest
   *  "no registered project to ask", never a guessed `false`. */
  sessionLive: Record<string, boolean | null>;
  /** Absent means "no clock-free way to compare a pin to today" — every
   *  today-relative fact below (`needsYou`'s pinned-today count, `nextPin`)
   *  degrades rather than guesses. */
  today?: string;
}): SpoolLobby {
  const ceilingByArea = new Map(input.areas.map((area) => [area.name, area.ceiling]));

  const rows: SpoolLobbySubject[] = input.subjects.map((subject) => {
    const threads = input.map.find((m) => m.subject === subject.key);
    const stuckOnYou = (threads?.threads ?? []).filter(
      (view) => !view.thread.settled && view.thread.waiting?.kind === "you",
    ).length;

    const outcome = input.looks.find((l) => l.subject === subject.key);
    const observations = outcome?.look?.observations ?? [];
    const unacked = observations.filter((o) => !o.acknowledged);

    const subjectItems = input.items.filter((i) => i.project === subject.key && !i.closed);
    const pinnedToday = input.today ? subjectItems.filter((i) => i.pinned?.day === input.today).length : 0;

    // Unacked observations are a MOVED fact, not an ask on the user — they
    // already carry into `moved.count` below. Counting them here too would
    // double-count the same fact under two names, and they are not
    // something the user need answer, so they do not belong in "needs you."
    const needsYou = stuckOnYou + pinnedToday;

    const digestLine = outcome?.digest?.[0];
    const movedLine =
      digestLine && outcome?.look ? `As of the look at ${outcome.look.lastLooked}: ${digestLine.text}` : undefined;
    const moved = { count: unacked.length, ...(movedLine ? { line: movedLine } : {}) };

    const sessionLive = input.sessionLive[subject.key] ?? null;

    let nextPin: SpoolLobbySubject["nextPin"];
    if (input.today) {
      const upcoming = subjectItems
        .filter((i) => i.pinned && i.pinned.day >= input.today!)
        .sort((a, b) => (a.pinned!.day < b.pinned!.day ? -1 : a.pinned!.day > b.pinned!.day ? 1 : 0));
      const soonest = upcoming[0];
      if (soonest?.pinned) nextPin = { day: soonest.pinned.day, label: pinWeekday(soonest.pinned.day) };
    }

    const folded = needsYou === 0 && moved.count === 0 && sessionLive !== true;

    return {
      key: subject.key,
      name: subject.name,
      ...(subject.area ? { area: subject.area } : {}),
      ...(subject.color ? { color: subject.color } : {}),
      ...(typeof subject.rank === "number" ? { rank: subject.rank } : {}),
      needsYou,
      moved,
      sessionLive,
      ...(nextPin ? { nextPin } : {}),
      folded,
    };
  });

  const byArea = new Map<string, SpoolLobbySubject[]>();
  const unareaed: SpoolLobbySubject[] = [];
  for (const row of rows) {
    if (row.area) {
      const list = byArea.get(row.area);
      if (list) list.push(row);
      else byArea.set(row.area, [row]);
    } else {
      unareaed.push(row);
    }
  }

  const areas: SpoolLobbyArea[] = [...byArea.entries()]
    .sort(([a], [b]) => compareNames(a, b))
    .map(([name, subjects]) => ({
      name,
      ...(ceilingByArea.get(name) ? { ceiling: ceilingByArea.get(name)! } : {}),
      // RANKED-THEN-UNRANKED, WITHIN THIS ONE AREA — see `sortSubjectsByRank`.
      // Every subject in `subjects` already shares `name` as its `area`, so
      // this is exactly the drag order a rail would show, never invented.
      subjects: sortSubjectsByRank(subjects),
    }));

  return { areas, unareaed };
}
