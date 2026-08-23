/**
 * FOCUS — what you are on, where you left it, and where to pick up.
 *
 * See `SpoolFocusEntry` for why this record exists at all. In one line: every
 * other record here is about the work, and a surface cannot decide what you do
 * not need to see while nothing knows what you are attending to.
 *
 * ── EVERYTHING HERE IS PURE EXCEPT THE THREE THAT TOUCH DISK ────────────────
 * `pickupFrom` and `focusDays` take their inputs and return their answers, so
 * the suite drives every branch — including the proposal — without a store and
 * without a model.
 *
 * ── AND NOTHING IN HERE DECIDES ─────────────────────────────────────────────
 * `proposeFrom` returns OPTIONS with reasons. It never opens a focus, never
 * orders your day and never picks. §5 keeps "no Telar-authored agenda", and the
 * distinction that keeps it true is that this offers and you act.
 */
import fs from "node:fs";
import path from "node:path";
import {
  SpoolFocusEntry,
  type SpoolFocusDay,
  type SpoolFocusEnd,
  type SpoolGrounded,
  type SpoolMoved,
  type SpoolPickup,
  type SpoolSubjectThreads,
  type SpoolThreadView,
} from "@telar/engine-client";
import { atomicWrite } from "../atomic";
import { capturedLabel, type SpoolPaths } from "./store";
import { threadLabel } from "./threads";

const FOCUS_FILE = "focus.json";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The day axis, minted by the store like every other label — so no surface
 *  ever computes one from a stamp. */
export function dayLabel(at: Date): string {
  return DAYS[at.getDay()]!;
}

export function focusPath(paths: SpoolPaths): string {
  return path.join(paths.root, FOCUS_FILE);
}

/** Tolerant per row, like every other list in this store: one hand-edited entry
 *  that will not parse must not cost you the whole history. */
export function readFocus(paths: SpoolPaths): SpoolFocusEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(focusPath(paths), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const entries: SpoolFocusEntry[] = [];
  for (const row of raw) {
    const parsed = SpoolFocusEntry.safeParse(row);
    if (!parsed.success) continue;
    if (entries.some((e) => e.id === parsed.data.id)) continue;
    entries.push(parsed.data);
  }
  return entries;
}

export function writeFocus(paths: SpoolPaths, entries: SpoolFocusEntry[]): SpoolFocusEntry[] {
  const parsed = entries.map((e) => SpoolFocusEntry.parse(e));
  atomicWrite(focusPath(paths), parsed);
  return parsed;
}

/** Open entries are current. A SET rather than a single value, so working two
 *  subjects at once is two rows and not a mode. */
export function currentFocus(entries: readonly SpoolFocusEntry[]): SpoolFocusEntry[] {
  return entries.filter((e) => !e.ended);
}

// ── the verbs ───────────────────────────────────────────────────────────────

/**
 * START BEING ON SOMETHING.
 *
 * RE-OPENING WHAT IS ALREADY OPEN IS A NO-OP, not a second row. Saying "I'm on
 * ozom-gv" twice is one stance stated twice, and two rows would make the day
 * reading claim you switched to the thing you were already doing.
 */
export function openFocus(
  paths: SpoolPaths,
  input: { subject: string; threadId?: string; note?: string },
  at: Date = new Date(),
): SpoolFocusEntry {
  const entries = readFocus(paths);

  /**
   * ONE OPEN ENTRY PER SUBJECT. A SECOND CLICK NARROWS IT, IT DOES NOT ADD ONE.
   *
   * ── THE BUG THIS IS ────────────────────────────────────────────────────────
   * This matched on `subject` AND an identical `threadId`, so "I'm on ozom-gv"
   * and "I'm on the budget question inside ozom-gv" were two different things to
   * be on at once. Driven live the moment the brief made thread rows clickable,
   * three clicks produced FOUR concurrent entries on the same subject and the
   * surface reported working on four instances of one thing.
   *
   * Parallel focus is real and stays — it is what "changeable, and more than one
   * at a time" asked for. But it is parallel across SUBJECTS. A thread is where
   * inside a subject you are, which is a property of the one focus, not a second.
   *
   * NOT RECORDED AS AN AMENDMENT. `amended[]` is for being WRONG about what you
   * were on; moving between questions in the same subject is the ordinary shape
   * of working, and logging it as a correction would bury the real ones. The
   * entry keeps its id and its `at`, so "how long have I been on this" stays the
   * answer to the question a person actually asks.
   */
  const open = currentFocus(entries).find((e) => e.subject === input.subject);
  if (open) {
    if (open.threadId === input.threadId) return open;
    const narrowed: SpoolFocusEntry = { ...open };
    if (input.threadId) narrowed.threadId = input.threadId;
    else delete narrowed.threadId;
    writeFocus(
      paths,
      entries.map((e) => (e.id === open.id ? narrowed : e)),
    );
    return narrowed;
  }

  const entry: SpoolFocusEntry = {
    id: `f-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    subject: input.subject,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    label: capturedLabel(at),
    day: dayLabel(at),
    at: at.getTime(),
    schemaVersion: 1,
  };
  writeFocus(paths, [...entries, entry]);
  return entry;
}

/**
 * STOP BEING ON SOMETHING, and say where you left it.
 *
 * THE NOTE IS THE WHOLE POINT of closing rather than just opening something
 * else: "where I left it" is what "pick back up from" means, and nothing else in
 * this store can reconstruct it.
 */
export function closeFocus(
  paths: SpoolPaths,
  id: string,
  input: { reason: SpoolFocusEnd; note?: string },
  at: Date = new Date(),
): SpoolFocusEntry | null {
  const entries = readFocus(paths);
  const found = entries.find((e) => e.id === id);
  if (!found || found.ended) return null;
  const next: SpoolFocusEntry = {
    ...found,
    ended: {
      label: capturedLabel(at),
      at: at.getTime(),
      reason: input.reason,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
  };
  writeFocus(
    paths,
    entries.map((e) => (e.id === id ? next : e)),
  );
  return next;
}

/**
 * CORRECT AN ENTRY — and the old value is KEPT.
 *
 * "No deletion path. Dismissing drains" applies to your own history too. A focus
 * log you can silently rewrite is one you cannot trust the next time it says
 * "Saturday you were on ozom-gv", and correcting a mis-set focus within the day
 * is exactly when the temptation to rewrite shows up.
 *
 * SO THE AMENDMENT IS THE RECORD. The entry reads true afterwards AND says it
 * was corrected, which is the only combination that is honest.
 */
export function amendFocus(
  paths: SpoolPaths,
  id: string,
  patch: { subject?: string; threadId?: string | null; note?: string },
  why?: string,
  at: Date = new Date(),
): SpoolFocusEntry | null {
  const entries = readFocus(paths);
  const found = entries.find((e) => e.id === id);
  if (!found) return null;

  const was = `${found.subject}${found.threadId ? ` · ${found.threadId}` : ""}${found.note ? ` — ${found.note}` : ""}`;
  const next: SpoolFocusEntry = {
    ...found,
    ...(patch.subject ? { subject: patch.subject } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    amended: [...(found.amended ?? []), { label: capturedLabel(at), was, ...(why ? { why } : {}) }],
  };
  // `null` CLEARS the thread — "I was on the subject, not that one thread" is a
  // real correction, and `undefined` cannot express it because it means "leave
  // alone" everywhere else in this patch.
  if (patch.threadId === null) delete next.threadId;
  else if (patch.threadId) next.threadId = patch.threadId;

  writeFocus(
    paths,
    entries.map((e) => (e.id === id ? next : e)),
  );
  return next;
}

// ── the readings ────────────────────────────────────────────────────────────

/**
 * THE Sat / Sun / Mon READING — grouped, newest day last.
 *
 * GROUPED ON THE STAMP AND LABELLED FROM THE STORE. The comparison happens here,
 * in the engine, and what leaves is `day` — a string a surface prints. §3.2's
 * line is about a renderer reading a clock, and none does.
 */
export function focusDays(entries: readonly SpoolFocusEntry[]): SpoolFocusDay[] {
  const days: SpoolFocusDay[] = [];
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    const last = days.at(-1);
    if (last && last.day === entry.day) last.entries.push(entry);
    else days.push({ day: entry.day, entries: [entry] });
  }
  return days;
}

/**
 * WHAT MOVED ON WHAT YOU ARE ON — as finished sentences.
 *
 * COMPOSED HERE RATHER THAN IN THE SURFACE, so the brief renders and computes
 * nothing. Every string that leaves is already in the user's register: no
 * counts of threads, no plies, no jargon.
 */
function movedOn(entry: SpoolFocusEntry, map: readonly SpoolSubjectThreads[]): SpoolMoved[] {
  const subject = map.find((s) => s.subject === entry.subject);
  if (!subject) return [];
  const mine = entry.threadId
    ? subject.threads.filter((t) => t.thread.id === entry.threadId)
    : subject.threads;

  const lines: SpoolMoved[] = [];
  for (const view of mine) {
    if (view.thread.settled) {
      lines.push({ subject: entry.subject, text: `${threadLabel(view.thread)} — answered: ${view.thread.settled.answer}` });
    } else if (view.ply.unchecked > 0 && view.ply.verified === 0) {
      lines.push({
        subject: entry.subject,
        text: `${threadLabel(view.thread)} — something was written about it that nobody has checked`,
      });
    }
  }
  return lines;
}

/**
 * A PERSON IS WAITING — and ONLY a person.
 *
 * ── TWO THINGS FOUND BY READING THE LIVE OUTPUT ─────────────────────────────
 * This also listed every `you`-blocked thread, and both halves of that were
 * wrong.
 *
 *   1. IT DUPLICATED THE PROPOSAL. "A short answer from you unblocks it" is
 *      already an option down there, with a Start button. Saying it twice on one
 *      screen is the thing this whole surface exists instead of.
 *   2. THE SENTENCE ASSUMED THE MODEL'S GRAMMAR. The template was "…can't move
 *      until you ${note}", which needs the note to be a verb phrase; a live pass
 *      wrote standalone clauses and produced "can't move until you Needs the
 *      user to confirm or rule out that this item is." A composed sentence must
 *      never depend on a model finishing it grammatically.
 *
 * So this band is now the one thing nothing else says: someone else is waiting,
 * and their cost grows while you do nothing about it. `you`-blocked threads are
 * the proposal's job.
 */
function waitingOn(map: readonly SpoolSubjectThreads[]): SpoolGrounded[] {
  const lines: SpoolGrounded[] = [];
  for (const subject of map) {
    for (const view of subject.threads) {
      if (view.thread.settled) continue;
      const w = view.thread.waiting;
      // `normalizeWaiting` guarantees a `person` has a real name that is not the
      // user, so this cannot render "Someone is waiting" for you.
      if (w?.kind === "person" && w.who) lines.push(ground(subject.subject, view, `${w.who} is waiting on ${threadLabel(view.thread)}.`));
    }
  }
  return lines;
}

/**
 * ATTACH THE WORDS THAT CAUSED IT — see `SpoolGrounded`.
 *
 * THE FIRST CAPTURE WITH RAW WINS. A thread usually holds one; where it holds
 * several, the earliest is the one that started the question, and showing all of
 * them would turn a grounding line into a second list.
 */
function ground(subject: string, view: SpoolThreadView, derived: string): SpoolGrounded {
  const source = view.items.find((i) => i.said?.trim());
  return {
    derived,
    subject,
    threadId: view.thread.id,
    ...(source?.said ? { said: source.said, itemId: source.id } : {}),
  };
}

/**
 * WHEN THERE IS NO CLEAR PATH, OFFER ONE — and only then.
 *
 * A proposal appears when you are on nothing, and not otherwise: something to
 * suggest while you are mid-flow is an interruption, which is the whole category
 * §3.3 keeps out. The reasons are stated so you can disagree with them, which is
 * the difference between a proposal and an agenda.
 *
 * THE ORDER IS NOT A RANKING. Blocked-on-a-person first because that is the only
 * kind whose cost grows while you do nothing; the rest is the order the store
 * hands them over.
 */
export function proposeFrom(
  entries: readonly SpoolFocusEntry[],
  map: readonly SpoolSubjectThreads[],
): SpoolPickup["proposal"] {
  if (currentFocus(entries).length > 0) return undefined;

  const options: Array<SpoolGrounded & { rank: number }> = [];

  for (const subject of map) {
    for (const view of subject.threads) {
      if (view.thread.settled) continue;
      const label = threadLabel(view.thread);
      const w = view.thread.waiting;
      if (w?.kind === "person") {
        options.push({ ...ground(subject.subject, view, `${w.who ?? "Someone"} is waiting on ${label}.`), rank: 0 });
      } else if (view.ply.verified > 0 && view.ply.open === 0) {
        options.push({ ...ground(subject.subject, view, `${label} — everything it needed is known.`), rank: 1 });
      } else if (w?.kind === "you") {
        options.push({ ...ground(subject.subject, view, `${label} — a short answer from you unblocks it.`), rank: 2 });
      }
    }
    // A LAST RESORT, AND NAMED AS ONE: unmapped captures are the only honest
    // suggestion for a subject whose questions nobody has worked out yet — and it
    // is grounded by the loose capture itself, which is the whole reason it is
    // worth offering. NEVER A CLOSED ONE: the user ticked the box, so proposing
    // it as somewhere to pick up would be the assistant re-opening by nagging.
    const openLoose = subject.loose.filter((i) => !i.closed);
    if (subject.threads.length === 0 && openLoose.length > 0) {
      const first = openLoose.find((i) => i.said?.trim()) ?? openLoose[0]!;
      options.push({
        derived: `${subject.subject} — you dumped things here and nothing has been worked out yet.`,
        subject: subject.subject,
        ...(first.said ? { said: first.said, itemId: first.id } : {}),
        rank: 3,
      });
    }
  }

  if (options.length === 0) return undefined;
  /**
   * GROUNDED FIRST, WITHIN A RANK. A line carrying your own words is one you can
   * verify by reading it; one that is only the system's bookkeeping is not, and
   * offering the unverifiable one above the verifiable one is how a surface
   * starts reporting things nobody understands.
   */
  const ordered = [...options]
    .sort((a, b) => a.rank - b.rank || Number(!!b.said) - Number(!!a.said))
    .slice(0, 3);
  return {
    why: "You're not on anything right now.",
    options: ordered.map(({ rank: _rank, ...option }) => option),
  };
}

/**
 * WHERE TO PICK UP — the whole answer, in one call.
 *
 * PURE, and that is deliberate: the brief is the most argued-over surface in
 * this module and every sentence it shows has to be checkable without a browser
 * or a model.
 */
export function pickupFrom(
  entries: readonly SpoolFocusEntry[],
  map: readonly SpoolSubjectThreads[],
): SpoolPickup {
  const current = currentFocus(entries);
  const proposal = proposeFrom(entries, map);

  /**
   * A FACT APPEARS ONCE ON A SCREEN.
   *
   * FOUND IN A SCREENSHOT: "Ana is waiting on September budget mismatch." was
   * rendered under WAITING and again under COULD PICK UP, a hundred pixels
   * apart. Both were correct and the repetition was the whole complaint about
   * this surface — the same thing said twice reads as noise however true it is.
   *
   * THE PROPOSAL WINS, because it is the one that can be ACTED on: its row
   * starts the work, while the waiting line only states it. So `waiting` keeps
   * what nothing else says.
   */
  const offered = new Set((proposal?.options ?? []).map((option) => option.derived));
  return {
    current,
    moved: current.flatMap((entry) => movedOn(entry, map)),
    waiting: waitingOn(map).filter((line) => !offered.has(line.derived)),
    ...(proposal ? { proposal } : {}),
  };
}

/**
 * WHAT YOU WERE LAST ON, for a subject you are returning to — the Monday half of
 * the Sat/Sun/Mon reading.
 *
 * THE MOST RECENT CLOSED ENTRY, and its note is what "pick back up from" means.
 * Absent means you have never been on it, which the brief says rather than
 * inventing a starting point.
 */
export function lastLeftOff(entries: readonly SpoolFocusEntry[], subject: string): SpoolFocusEntry | undefined {
  return [...entries]
    .filter((e) => e.subject === subject && e.ended)
    .sort((a, b) => (a.ended?.at ?? 0) - (b.ended?.at ?? 0))
    .at(-1);
}
