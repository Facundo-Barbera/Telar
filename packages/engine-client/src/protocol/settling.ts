/**
 * WHICH SESSIONS ARE ASKING FOR YOUR ATTENTION, AND WHICH ARE NOT.
 *
 * Ported from t3 code's `packages/client-runtime/src/state/threadSettled.ts`,
 * and it lived in `apps/web/lib/session-settling.ts` until issue #457 gave the
 * ENGINE a reason to ask the same question.
 *
 * WHY IT IS IN THE PROTOCOL NOW. `GET /v2/sessions/live` answers only the
 * UNSETTLED rows by default — 7 of 291 on the owner's store — so the engine
 * decides "settled" on the way out and the rail no longer receives the rows it
 * would have hidden. That makes an ENGINE that disagreed with a CLIENT about
 * this rule into an invisible session: a row the engine dropped and the cockpit
 * would have drawn, with nothing on either side to notice. One module, imported
 * by both, is what makes that disagreement unrepresentable rather than unlikely.
 * (`apps/ios` keeps its Swift port, `Settling.swift`, for the obvious reason;
 * it is held to this file by `SettlingTests.swift`.)
 *
 * The snooze MENU — presets, wake labels, anything that reads a locale — stayed
 * in the cockpit. This is the rule, not the chrome.
 *
 * ══ THE THREE-LAYER RULE, IN THE ORDER IT IS EVALUATED ══
 *
 *   1. BLOCKERS BEAT EVERYTHING. A session with a request waiting on a human,
 *      or a turn actually running, stays in the list no matter what anyone
 *      pinned. This is the ordering that makes the whole feature safe: the
 *      worst outcome of a settling system is hiding the one row that needed
 *      you, and putting the blockers first makes that unrepresentable rather
 *      than unlikely.
 *   2. THE EXPLICIT PIN WINS, IN BOTH DIRECTIONS. "settled" shelves a session
 *      the clock would have kept; "active" keeps one the clock would have
 *      shelved. Absent means "let the rule decide" — a third answer, which is
 *      why the engine stores an enum rather than a boolean.
 *   3. A LIVE SNOOZE, AN UNREAD ANSWER AND LIVE BACKGROUND WORK BEAT THE
 *      CLOCK. All are cases where the clock's premise — "nothing has happened
 *      here for hours" — is simply false: a decision that has not expired yet,
 *      a result nobody has seen, work that is still running. Below the pin,
 *      because a human settling a session with any of them in front of them
 *      means it.
 *   4. THE CLOCK DECIDES THE REST, and only if the reader configured it to.
 *
 * ══ WHAT WE DELIBERATELY DID NOT PORT ══
 *
 * The donor also auto-settles on a merged or closed pull request, and refuses
 * to auto-settle while one is open. Telar reads GitHub per PROJECT and on a
 * thirty-second cache (`github.ts`), with no link from a session to a pull
 * request — so the join does not exist to make, and inventing one from branch
 * names would shelve rows on a guess. The hook is where it would go: see
 * `SettlingOptions`.
 *
 * The donor's `hasQueuedTurnStart` grace window is not ported either, and does
 * not need to be: it exists because its server adopts a message into a session
 * asynchronously, so a just-sent message is briefly invisible. Telar's queue IS
 * the durable record — a submitted turn is in `queue.json` before the response
 * returns — so "is there queued work" is answerable directly.
 */
import type { SessionActivity } from "./entities";

/**
 * ONLY WHAT THE RULE READS, rather than the engine's `Session`.
 *
 * The sidebar works on `SidebarSession`, a flattened projection; the cockpit
 * works on the record itself; the engine works on a `Session` it has just read
 * off disk. Naming the fields this actually reads lets all three satisfy it
 * without a conversion, and keeps the rule free of the contract's shapes —
 * which is what makes it testable in six lines instead of thirty.
 */
export type SettleableSession = {
  /** The conversation is over. Distinct from settled, which is about the LIST. */
  archived: boolean;
  updatedAt: number;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
  /** The unread pair — see `hasUnreadResult`, and `Session` for what each one
   *  means. Absent on a session that has never produced a result. */
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  /** When the newest receipt landed. Only the inactivity baseline reads it;
   *  unread itself is decided on the sequences, never on a clock. */
  readAt?: number;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * What settling needs to know about a session BEYOND its record.
 *
 * Kept as an explicit input rather than read from the session, because this is
 * not the shape any one caller has: the engine reports an `activity` enum and a
 * last-turn stamp, and the four questions the rules below actually ask are a
 * fold over those. `settlingActivityOf` does that fold once, for everyone.
 *
 * NOT `SessionActivity`, which is the contract's four-state enum. The two used
 * to share a name across two modules that are imported together, which is the
 * kind of collision you only notice from a type error three files away.
 */
export type SettlingActivity = {
  /** A turn is queued, claimed or running. */
  working?: boolean;
  /** A request is parked on a human — an approval, or a question. */
  waitingOnYou?: boolean;
  /** No turn, but live background work — a backgrounded shell, monitor or
   *  sub-agent that outlived its turn (`activity: "monitoring"`). Holds off the
   *  CLOCK, not a person: see `isSettled`. */
  backgroundWork?: boolean;
  /** When the last turn ended, for the early-wake rule. Absent when none has. */
  lastTurnEndedAt?: number;
  /** The last turn failed. A fresh failure outranks a snooze. */
  failed?: boolean;
  /** When that failure was recorded, so an OLD one does not keep waking a
   *  session somebody snoozed precisely because they had seen it. */
  failedAt?: number;
};

export type SettlingOptions = {
  now: number;
  /** `null` turns the clock off entirely: nothing settles by neglect, only by
   *  decision. */
  autoSettleAfterHours: number | null;
};

/**
 * THE ENGINE'S `activity` ENUM AND ITS LAST-TURN STAMP, folded into the four
 * questions the rules above actually ask.
 *
 * ONE PLACE, because the rail, the row and now the ENGINE all need it and they
 * must not answer differently: a row whose Snooze button is enabled while the
 * list would refuse to hide it is a control that does nothing — and a row the
 * engine folds one way and the cockpit the other is a conversation that is
 * simply not in the list.
 *
 * `queued` COUNTS AS WORKING. It is not running yet, but a turn is on its way,
 * and settling a session that is about to answer you is the same mistake as
 * settling one mid-answer.
 *
 * `monitoring` IS NOT WORKING, BUT IT IS NOT NOTHING EITHER. It is the engine's
 * word for live background work and no turn (`livenessOf`, which already leaves
 * paused and ambient tasks out), so it gets its own flag rather than joining
 * `working`: a person may still shelve it by hand, but nothing AUTOMATIC may.
 */
export function settlingActivityOf(session: {
  activity?: SessionActivity;
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
}): SettlingActivity {
  return {
    working: session.activity === "working" || session.activity === "queued",
    waitingOnYou: session.activity === "blocked",
    backgroundWork: session.activity === "monitoring",
    ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
    // A failure is dated by when the turn ended, because that IS when it
    // failed — the engine derives both from the same turn.
    ...(session.lastTurnFailed ? { failed: true, ...(session.lastTurnEndedAt === undefined ? {} : { failedAt: session.lastTurnEndedAt }) } : {}),
  };
}

/**
 * May this session be shelved right now?
 *
 * DELIBERATELY THE SAME LIST `isSettled` refuses to classify on. Anything the
 * partition will not call settled must also be refused as a settle TARGET, or
 * the button appears to do nothing — which reads as a broken control rather
 * than as a rule.
 *
 * `backgroundWork` IS NOT ON IT, and that is the same argument run backwards:
 * `isSettled` honours a "settled" pin over background work, so the button must
 * stay enabled. A hand settle only moves the row — it stops nothing — and the
 * work's own wake brings the row back when it has something to say.
 */
export function canSettle(activity: SettlingActivity): boolean {
  return !activity.waitingOnYou && !activity.working;
}

/**
 * May it be snoozed?
 *
 * A RUNNING SESSION IS SNOOZABLE and a blocked one is not, which is the
 * difference between the two verbs: snoozing only changes what you are shown,
 * so hiding work in progress is a legitimate thing to want. Hiding a question
 * that is waiting on you defeats the question.
 */
export function canSnooze(activity: SettlingActivity): boolean {
  return !activity.waitingOnYou;
}

/**
 * Something happened that outranks the snooze.
 *
 * A snooze is "not now", not "never" — so the agent needing you, failing, or
 * finishing the work you were waiting on all cut it short. RAISING A HAND NEVER
 * CLEARS THE STORED SNOOZE: it only stops the session classifying as snoozed,
 * so if the reason goes away the snooze is still there and still counting.
 */
export function raisedHandWhileSnoozed(session: SettleableSession, activity: SettlingActivity): boolean {
  if (activity.waitingOnYou) return true;
  const snoozedAt = session.snoozedAt;
  /**
   * ONLY A FRESH FAILURE. A session snoozed while ALREADY failed stays snoozed
   * — that snooze was the reader saying "I saw it, not now", and waking it on
   * the same failure would be arguing with them.
   */
  if (activity.failed && (snoozedAt === undefined || (activity.failedAt ?? 0) > snoozedAt)) return true;
  if (snoozedAt !== undefined && activity.lastTurnEndedAt !== undefined && activity.lastTurnEndedAt > snoozedAt) return true;
  return false;
}

/** Hidden until its wake time, unless it has raised its hand. */
export function isSnoozed(session: SettleableSession, activity: SettlingActivity, options: Pick<SettlingOptions, "now">): boolean {
  const until = session.snoozedUntil;
  if (until === undefined) return false;
  // Malformed data never hides a session. Of the two ways to be wrong, showing
  // a row that should be hidden is the recoverable one.
  if (!Number.isFinite(until)) return false;
  if (until <= options.now) return false;
  return !raisedHandWhileSnoozed(session, activity);
}

/**
 * When a snoozed session woke, or nothing if it never slept or still sleeps.
 *
 * The list's sort is deliberately static — a row does not jump to the top when
 * it wakes, because a list that reorders itself while you read it is not a
 * list. So the WAKE has to carry the signal, and that needs a timestamp.
 */
export function wokeAt(session: SettleableSession, activity: SettlingActivity, options: Pick<SettlingOptions, "now">): number | undefined {
  const until = session.snoozedUntil;
  if (until === undefined || !Number.isFinite(until)) return undefined;
  if (raisedHandWhileSnoozed(session, activity)) {
    // The early wake stays authoritative even once the scheduled time passes:
    // reporting the scheduled time then would resurface a signal the reader
    // already dealt with.
    if (session.snoozedAt !== undefined && activity.lastTurnEndedAt !== undefined && activity.lastTurnEndedAt > session.snoozedAt) {
      return activity.lastTurnEndedAt;
    }
    return activity.failedAt ?? session.snoozedAt ?? until;
  }
  return until <= options.now ? until : undefined;
}

/**
 * IS THERE AN ANSWER ON THIS SESSION NOBODY HAS READ?
 *
 * Two engine-owned numbers and a `>`. `lastTurnSequence` is the newest turn
 * that left a RESULT; `lastReadTurnSequence` is the newest one a human was
 * actually shown (see `Session` in the protocol, and the cockpit's receipt).
 * Both are the engine's, so this answers the same on every device and survives
 * a reload — which is the entire reason it is not a browser flag.
 *
 * ABSENT `lastTurnSequence` MEANS "NOTHING TO READ", NOT "UNKNOWN". An engine
 * that models receipts always sets it once a turn has produced a result, so
 * the only session without one is a session that has never answered. The
 * alternative reading — treat absence as unread — would make every row from a
 * host too old to send the field immortal in the list, and a shelf that can
 * never take anything is worse than one that occasionally shelves a result
 * nobody read on a Mac running last month's build.
 */
export function hasUnreadResult(session: SettleableSession): boolean {
  if (session.lastTurnSequence === undefined) return false;
  return session.lastTurnSequence > (session.lastReadTurnSequence ?? 0);
}

/**
 * WHEN THE INACTIVITY CLOCK STARTS COUNTING for this session.
 *
 * `updatedAt` alone was the whole of it, and it is the wrong baseline in two
 * cases the reader would call obvious:
 *
 *   - A SNOOZE MUST NOT EXPIRE INTO A SHELF. "Tomorrow at 9" on a machine set
 *     to auto-settle after three hours used to mean the row came back already
 *     shelved — the snooze outlived the window it was measured against, so
 *     the session was hidden by the clock the moment it stopped being hidden
 *     by the snooze. Counting from the wake time gives it the full window to
 *     be noticed, which is what "wake me tomorrow" asked for.
 *   - READING IS NOT NOTHING. Opening a session and reading its answer is the
 *     reader saying they are still here; it must not stamp `updatedAt` (that
 *     is the session's work, and this clock is measured from it), so `readAt`
 *     is picked up here instead.
 *
 * EXPORTED FOR RETENTION (#542), which needs the baseline WITHOUT the window.
 * `settled_at` looked like the column to key a retention sweep on and is not
 * one: it is stamped only by an EXPLICIT settle, so a session shelved by the
 * clock has none and a sweep keyed on it would skip almost the whole store.
 * This is the durable fact underneath both, and it gives retention the right
 * behaviour for free — reading a session resets its retention age, because
 * `readAt` is a human's read receipt and not an agent calling `sessions_read`.
 */
export function idleSince(session: SettleableSession): number {
  const snoozedUntil = Number.isFinite(session.snoozedUntil) ? session.snoozedUntil! : 0;
  return Math.max(session.updatedAt, session.readAt ?? 0, snoozedUntil);
}

/**
 * HAS NOTHING HAPPENED HERE FOR A WHOLE SETTLING WINDOW?
 *
 * The clock's own question, with none of the guards that sit above it — which
 * is the whole reason it is named: `isSettled` is this PLUS the pin, the
 * snooze and the unread answer, and a caller that wants the clock alone would
 * otherwise re-derive the baseline and get `updatedAt` wrong twice over.
 *
 * The sidebar's tree used to ask it directly (`leavesRelatedWork`, #370), to
 * decide when a delegate stopped being drawn under its coordinator. That tree
 * is gone (#381) and so is the question; `isSettled` below is the caller that
 * remains, and this stays named because the two ARE different questions and
 * merging them is how the baseline gets computed twice.
 *
 * NO WINDOW MEANS NEVER STALE. A reader who turned the clock off asked for
 * nothing to age out, and that answer has to hold everywhere it is asked.
 */
export function isStale(session: SettleableSession, options: SettlingOptions): boolean {
  if (options.autoSettleAfterHours === null) return false;
  return idleSince(session) < options.now - options.autoSettleAfterHours * HOUR_MS;
}

/**
 * Is this session off the list?
 *
 * The whole rule, in the order stated in this file's header. Read it top to
 * bottom: every early return above the clock is a case where the clock has no
 * business having an opinion.
 */
export function isSettled(session: SettleableSession, activity: SettlingActivity, options: SettlingOptions): boolean {
  // 1. Blockers. Even an explicit settle does not survive a parked request:
  // the reader shelved a session they believed was finished with them.
  if (activity.waitingOnYou || activity.working) return false;
  // An archived session is over. It is shelved by a decision that outranks
  // every pin below, including a `settledOverride` of "active".
  if (session.archived) return true;
  // 2. The pin. BOTH DIRECTIONS ARE DECISIONS, and everything below this line
  // is the clock guessing — so a human's answer is taken before any of it,
  // including the two guards. Settling an unread session is allowed for
  // exactly that reason: the reader said so.
  if (session.settledOverride === "settled") return true;
  if (session.settledOverride === "active") return false;
  /**
   * 3. The two things the clock has no business overruling.
   *
   * A LIVE SNOOZE OWNS ITS WHOLE INTERVAL. The row is hidden either way, so
   * this changes nothing on screen today — it is what stops the session
   * arriving in the settled shelf rather than the list when it wakes, since
   * `bandOf` asks `isSnoozed` first and `isSettled` second.
   *
   * AN UNREAD RESULT IS NEVER SHELVED BY NEGLECT. The clock's premise is
   * "nothing has happened here for hours"; an answer waiting to be read IS
   * something that happened, and hiding it is the one failure this whole
   * feature must not have. Note what this does NOT do: it does not keep the
   * row unshelved forever, because the moment the reader looks at the answer
   * the receipt lands and the window starts from `readAt`.
   */
  if (session.snoozedUntil !== undefined && Number.isFinite(session.snoozedUntil) && session.snoozedUntil > options.now) return false;
  if (hasUnreadResult(session)) return false;
  /**
   * LIVE BACKGROUND WORK IS SOMETHING HAPPENING, so the clock's premise is
   * false for the same reason an unread answer makes it false: a shell or a
   * sub-agent still running is not "nothing for hours", however long ago the
   * turn that started it ended. BELOW THE PIN, because a person shelving a row
   * with a watcher on it means it; ABOVE THE CLOCK, which also keeps retention
   * (`retirable`, which zeroes the window and keeps these guards) off it.
   */
  if (activity.backgroundWork) return false;
  // 4. The clock, if the reader wants one.
  return isStale(session, options);
}

/**
 * IS THIS ROW ON THE SHELF RATHER THAN IN THE LIST — the question a LIST asks,
 * as distinct from the question a ROW asks.
 *
 * `isSettled` above is about one conversation: may this be shelved, is it
 * shelved, should this button be enabled. This is about the partition, and it
 * is the one the engine asks, because `GET /v2/sessions/live` now answers only
 * the rows a rail would draw (#457). It is exactly the rail's `bandOf`, read for
 * its one non-`isSettled` clause:
 *
 * A DRAFT IS NEVER SHELVED BY THE CLOCK. An unsent conversation has by
 * definition done nothing for the clock to measure, so `isStale` is true of
 * every draft older than the window — and a draft that vanished off the rail a
 * few hours after you opened it is the composer eating your work. Only an
 * explicit "settled" takes one. `bandOf` has always had this carve-out; the
 * engine has to have it too, or the route drops the rows the rail was about to
 * draw.
 *
 * THE SAFER SIDE OF EVERY DISAGREEMENT. `apps/ios`'s `groupInbox` has no draft
 * clause, so the phone would shelve a stale draft this keeps. Keeping it is the
 * recoverable error — a row shown on one device and shelved on another, rather
 * than a row no device can reach — and it is why the ENGINE asks this and not
 * `isSettled`.
 */
export function isShelved(
  session: SettleableSession & { draft?: boolean },
  activity: SettlingActivity,
  options: SettlingOptions,
): boolean {
  if (session.draft && !session.archived && session.settledOverride !== "settled") return false;
  return isSettled(session, activity, options);
}
