/**
 * THE RE-ENTRY BRIEF — a subject's room opens on this, not a task list.
 * `docs/spool-loops.md` §13.2: "where you left off (the pickup), what moved
 * since (the look's diff, honestly dated), what's still open, what's next —
 * with RESUME SESSION as the headline verb."
 *
 * PURE COMPOSITION, LIKE `briefing.ts`. Nothing here reads disk or calls a
 * model; every input is already what another spool route reads (the subject's
 * threads, its stored look, the whole store's focus pickup, its rows off
 * `subjectSlice`, its notes). `EngineStore.spoolSubjectBrief` is the thin
 * caller that gathers them.
 */
import type {
  SpoolBrief,
  SpoolBriefDeadItem,
  SpoolBriefNextItem,
  SpoolBriefOpenThread,
  SpoolLookOutcome,
  SpoolNote,
  SpoolPickup,
  SpoolSubjectRow,
  SpoolSubjectThreads,
  SpoolThreadView,
} from "@telar/engine-client";

function toOpenThread(view: SpoolThreadView): SpoolBriefOpenThread {
  const waiting = view.thread.waiting;
  return {
    threadId: view.thread.id,
    question: view.thread.question,
    ...(view.thread.handle ? { handle: view.thread.handle } : {}),
    ...(waiting?.who ? { who: waiting.who } : {}),
    ...(waiting?.note ? { note: waiting.note } : {}),
  };
}

export function composeBrief(input: {
  key: string;
  /** The WHOLE pickup — `EngineStore.spoolPickup()`'s own answer, filtered
   *  here to this subject's own entries. Reusing it rather than re-deriving
   *  from `readFocus` keeps this subject's `current`/`moved` byte-for-byte
   *  what the wide pickup already says about it. */
  pickup: SpoolPickup;
  /** This subject's map — its threads and the captures no thread claims. */
  threads: SpoolSubjectThreads;
  /** The STORED look outcome — never a fresh `gh` read; embedded whole so a
   *  surface gets the same four-state contract (fresh / stale+error / no
   *  terrain / stored) `SpoolLookOutcome` already states, rather than a second
   *  shape that could drift from it. */
  look: SpoolLookOutcome;
  /** This subject's rows off `subjectSlice` — already in chain order (lane,
   *  then rank, then the unfiled remainder), so "next" inherits an order it
   *  did not invent. */
  rows: SpoolSubjectRow[];
  /** This subject's notes, retired ones included per the shelf's own
   *  "dismissing drains" rule — filtered to the active set below for the
   *  count and the latest title, since a retired note is not "the latest"
   *  knowledge to resume from. */
  notes: SpoolNote[];
  /** Absent means no clock-free way to say what is pinned "to today" —
   *  pinned-first ordering in `next` is simply skipped, not guessed. */
  today?: string;
}): SpoolBrief {
  const pickup = {
    current: input.pickup.current.filter((entry) => entry.subject === input.key),
    moved: input.pickup.moved.filter((line) => line.subject === input.key),
  };

  const openViews = input.threads.threads.filter((view) => !view.thread.settled);
  const open = {
    stuckOnYou: openViews.filter((view) => view.thread.waiting?.kind === "you").map(toOpenThread),
    waitingOnOthers: openViews.filter((view) => view.thread.waiting?.kind === "person").map(toOpenThread),
  };

  const openRows = input.rows.filter((row) => !row.item.closed);
  const pinnedToday = input.today ? openRows.filter((row) => row.item.pinned?.day === input.today) : [];
  const pinnedIds = new Set(pinnedToday.map((row) => row.item.id));
  const prepared = openRows.filter((row) => (row.item.fixed || row.item.draft) && !pinnedIds.has(row.item.id));

  const next: SpoolBriefNextItem[] = [
    ...pinnedToday.map(
      (row): SpoolBriefNextItem => ({
        itemId: row.item.id,
        title: row.item.title,
        source: `pinned to ${row.item.pinned!.day}`,
      }),
    ),
    ...prepared.map((row): SpoolBriefNextItem => {
      const stage = row.item.draft ? "drafted" : "briefed";
      return {
        itemId: row.item.id,
        title: row.item.title,
        source: row.lane ? `${stage}, rank ${row.rank} in ${row.lane}` : `${stage}, unfiled`,
      };
    }),
  ].slice(0, 3);

  const activeNotes = input.notes.filter((note) => !note.retired);
  const latestNote = [...activeNotes].sort((a, b) => a.updated.at - b.updated.at).at(-1);

  // NO THREAD CLAIMS IT, no pin, and no work-state (never drafted, never
  // briefed) — §13.3.5's compost candidate, exactly as `queueSlice`'s own
  // "conservation" comments define "untouched": present on disk, touched by
  // nothing since capture.
  const claimedIds = new Set(input.threads.threads.flatMap((thread) => thread.thread.items));
  const deadItems: SpoolBriefDeadItem[] = openRows
    .filter((row) => !claimedIds.has(row.item.id) && !row.item.pinned && !row.item.fixed && !row.item.draft)
    .slice(0, 3)
    .map((row) => ({ itemId: row.item.id, title: row.item.title }));

  return {
    subject: input.key,
    pickup,
    sinceYourLook: input.look,
    open,
    next,
    notes: {
      count: activeNotes.length,
      ...(latestNote ? { latestTitle: latestNote.title } : {}),
    },
    deadItems,
  };
}
