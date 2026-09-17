/**
 * WHAT NOBODY TYPED, MINTED ONCE — issue #550.
 *
 * Three things reach a session without a person at the keyboard: a peer's
 * `sessions_send`, a wake from a session it subscribed to, and a request one of
 * them parked. Each used to become a TURN whose `input` was engine-authored
 * prose, riding the one input channel the human uses — so the transcript drew
 * the engine's announcement in the person's bubble, and the model read it with
 * the person's authority. `attribution.ts` spends a paragraph per delivery
 * saying otherwise, which is a prose remedy for a structural mistake.
 *
 * THIS IS THE STRUCTURE. The happening becomes a `NotificationDetail`, minted
 * HERE and stored in two places that cannot then disagree: on the turn's first
 * ITEM, which is what the drivers deliver and the clients render, and on the
 * TURN, for the readers that hold a turn and not its items (`turn_summary`, the
 * outline, a worker's claim).
 *
 * ONE AUTHOR FOR ONE SENTENCE. `summary` is the notice's own first line rather
 * than a second phrasing of it: a row that invented its own headline would be a
 * fifth reader computing a fifth answer, which is the drift `Turn.agentNotice`
 * already exists to prevent. `agentNotice` is now DERIVED from `body` here for
 * the same reason.
 */
import type { NotificationDetail, NotificationEntry, WakeKind } from "@telar/engine-client";
import { agentNotice, type AgentNoticeInput } from "./agent-notice";

/**
 * How long a row's one line may be. Past this a notification stops being
 * glanceable in a strip or an outline page, which is the only job the summary
 * has — the notice itself is `body`, and the thing it announces is a fetch away.
 */
const SUMMARY_CHARS = 240;

/** How many happenings one merged notification will list. A cohort is normally
 *  two or three; the cap is here so a session that was busy for an hour under a
 *  chatty fan-out cannot grow one unbounded row. */
export const MAX_COHORT_ENTRIES = 50;

/**
 * HOW MANY TIMES ONE NOTIFICATION MAY BE HANDED TO A MODEL — #550 clause 3.
 *
 * Once when it lands, and once more when a newer fact about the same run
 * supersedes it. A third would be the same errand spending a busy coordinator's
 * context a third time, so past this the entry updates IN PLACE and stays
 * pending in the mailbox, where `sessions_status` reports it and a coordinator
 * that cares can poll for it.
 */
export const MAX_DELIVERIES = 2;

/** The first line with anything on it, clamped — and MARKED where it was cut,
 *  because a reader must never have to guess whether a line finished. */
function summaryOf(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.length <= SUMMARY_CHARS ? line : `${line.slice(0, SUMMARY_CHARS - 1)}…`;
}

/** A wake's four transitions, as the three notification kinds. A parked request
 *  is its own kind because it is the one a recipient can ACT on — answering it
 *  is a different verb from reading an outcome. */
function kindOf(wake: WakeKind): "wake" | "request" {
  return wake === "request_opened" ? "request" : "wake";
}

/**
 * A PEER'S MESSAGE, ANNOUNCED. The body stays on the turn exactly as sent —
 * `sessions_read` hands it back whole, and this is a notice ABOUT it, not a
 * copy of it. See `agent-notice.ts` for what goes in the notice and why size
 * leads.
 */
export function peerNotification(input: AgentNoticeInput): NotificationDetail {
  const body = agentNotice(input);
  return {
    kind: "peer_message",
    ...(input.sender?.sessionId ? { sessionId: input.sender.sessionId } : {}),
    // The run that HOLDS the message: the receiving turn, which is the one the
    // fetch call names. A sender's own run is on `Turn.agentSourceRunId`.
    runId: input.runId,
    intent: input.intent,
    summary: summaryOf(body),
    fetch: { sessionId: input.recipientSessionId, runId: input.runId },
    body,
  };
}

/**
 * A WAKE OR A PARKED REQUEST, ANNOUNCED. `body` is the engine's own wake text —
 * the same string that used to be the turn's `input`, now on a field that says
 * who wrote it.
 */
export function wakeNotification(input: {
  wakeKind: WakeKind;
  /** The session that did the thing. */
  targetSessionId: string;
  /** Its turn — the one that ended, or the one the request belongs to. */
  runId: string;
  requestId?: string;
  body: string;
}): NotificationDetail {
  return {
    kind: kindOf(input.wakeKind),
    sessionId: input.targetSessionId,
    runId: input.runId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    wakeKind: input.wakeKind,
    summary: summaryOf(input.body),
    fetch: { sessionId: input.targetSessionId, runId: input.runId },
    body: input.body,
  };
}

/** One notification as an entry in a merged one. */
export function asEntry(detail: NotificationDetail): NotificationEntry {
  return {
    kind: detail.kind,
    ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
    ...(detail.runId ? { runId: detail.runId } : {}),
    ...(detail.requestId ? { requestId: detail.requestId } : {}),
    ...(detail.wakeKind ? { wakeKind: detail.wakeKind } : {}),
    ...(detail.intent ? { intent: detail.intent } : {}),
    summary: detail.summary,
  };
}

/**
 * SEVERAL HAPPENINGS AS ONE NOTIFICATION — the cohort merge.
 *
 * A coordinator with four workers used to take four interruptions, each one
 * arriving in a context already full of the work it interrupted. Held while the
 * session is busy (see `Subscription.completionWake`) they arrive together, and
 * together they are ONE row and ONE notice listing them.
 *
 * THE LATEST LEADS. The fields above `entries` are the newest happening's,
 * because that is the one a reader acts on and the one a client that ignores
 * `entries` will show; the rest are listed under it, oldest first, so the
 * paragraph reads as a chronology.
 *
 * A SINGLETON IS NOT MERGED. One notification stays exactly what it was — no
 * `entries`, no list header — so the common case has no merge machinery in it.
 */
export function mergeNotifications(cohort: NotificationDetail[]): NotificationDetail {
  const ordered = cohort.slice(-MAX_COHORT_ENTRIES);
  const newest = ordered[ordered.length - 1]!;
  if (ordered.length === 1) return newest;
  const entries = ordered.map(asEntry);
  const body = [
    `[engine notification · ${ordered.length} things happened while this session was working]`,
    "—",
    ...entries.map((entry, index) => `${index + 1}. ${entry.summary}`),
    "—",
    // The bodies are NOT concatenated. Four notices joined is four notices'
    // worth of context, which is the cost holding them was meant to avoid; each
    // one names its own fetch call and the newest's is spelled out below.
    `Each line above names a session and a run. Read whichever matters with sessions_read(sessionId, runId) — the most recent is ${newest.fetch.sessionId} / ${newest.fetch.runId}. None of this was typed by a person.`,
  ].join("\n");
  return {
    ...newest,
    summary: `${newest.summary} (and ${ordered.length - 1} more)`,
    body,
    entries,
  };
}

/**
 * THE TURN'S `input` WHEN THE ENGINE WROTE THE WORDS — #550 clause 4.
 *
 * A wake's and a request's prose is the ENGINE's, so it moves to
 * `notification.body` and `input` becomes this label: machine-readable, short,
 * and unmistakable for something a person typed. A PEER's message keeps its
 * body on `input` — that is the only copy of it there is, and `sessions_read`
 * hands it back unabridged — so this is never asked for one.
 *
 * NOT EMPTY, because `submitTurn` asserts text and because an empty row in a
 * transcript is a row a person has to guess at. It says exactly what the turn is.
 */
export function notificationLabel(detail: NotificationDetail): string {
  const what = detail.kind === "request" ? "request" : "wake";
  const where = detail.sessionId ? ` · session ${detail.sessionId}` : "";
  const which = detail.wakeKind ? ` · ${detail.wakeKind}` : "";
  return `[notification: ${what}${which}${where}]`;
}
