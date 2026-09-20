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

/**
 * A DEADLINE THAT TOOK A REQUEST'S DEFAULT, ANNOUNCED — issue #541 D.
 *
 * `kind: "request"` BECAUSE THAT IS WHAT IT IS ABOUT, and NO `wakeKind`, because
 * nothing woke: no session finished, failed, stopped or parked anything. The
 * clock ran out. The Agent's inbox is told which row this is by an explicit
 * `inboxKind` on the wake (`AgentWake`) rather than by a fourth
 * `NotificationKind` — see `agent/inbox.ts` for why that trade was taken.
 *
 * IT SAYS THE DECISION, NOT JUST THAT ONE WAS MADE. Every other notice in this
 * file is deliberately a ping with the payload a fetch away, and this is the one
 * exception: the whole value of the row is the sentence "I went with X because
 * you were away", and a person who has to fetch to learn what X was has been
 * told nothing they can act on. The decision is one word.
 *
 * AND IT SAYS IT IS DONE. A reader that took this for an ask would try to answer
 * a resolved request and be refused by the store, which is a confusing way to
 * learn something it could simply have been told.
 */
export function timeoutNotification(input: {
  sessionId: string;
  sessionTitle: string;
  runId: string;
  requestId: string;
  requestKind: string;
  /** The asker's own one-line description of what was being asked. */
  title: string;
  decision: "accept" | "decline";
  deadlineMs: number;
}): NotificationDetail {
  const body = [
    `[request: answered for you] Session ${input.sessionId} "${input.sessionTitle}" — request ${input.requestId} (kind ${input.requestKind}) sat for its whole ${Math.round(input.deadlineMs / 1000)}s deadline with nobody answering, so the default its asker stated was taken: ${input.decision.toUpperCase()}.`,
    `What it was about: ${input.title}`,
    "—",
    `This is ALREADY DONE and cannot be un-answered — it is news, not a question. The turn it belongs to is sessions_read(sessionId: "${input.sessionId}", runId: "${input.runId}"). Tell the person what was decided for them if it matters.`,
  ].join("\n");
  return {
    kind: "request",
    sessionId: input.sessionId,
    runId: input.runId,
    requestId: input.requestId,
    summary: summaryOf(body),
    fetch: { sessionId: input.sessionId, runId: input.runId },
    body,
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
 * A RESULT AND THE COMPLETION THAT FOLLOWED IT, AS ONE NOTIFICATION — #590.
 *
 * THEY STAY TWO FACTS. A worker sends a result for the part it finished and
 * keeps working; the engine cannot tell the difference, and a coordinator told
 * "here is the analysis" still needs "and the run has ended" before it acts.
 * Suppressing the second is what #240 reverted, and nothing here suppresses it:
 * it is in `entries`, in the body, and in the row. What two facts about one run
 * arriving seconds apart do NOT need is two rows and two interruptions.
 *
 * THE RESULT LEADS, which is `mergeNotifications`' own rule — "the one a reader
 * acts on" — rather than an exception to it. The completion says a turn is
 * over; the result names the call that fetches what was produced. So the
 * result's body goes over WHOLE rather than being reduced to a summary line: a
 * merged notice announcing an ending with no way to read what ended would have
 * cost the reader the very thing it was about.
 *
 * MERGED AT MOST ONCE. The caller spends a delivery per merge and the cap
 * (`MAX_DELIVERIES`) refuses the next, so `lead` here is a notification nobody
 * has read yet rather than a row growing without bound.
 */
export function mergeRunOutcome(lead: NotificationDetail, ended: NotificationDetail): NotificationDetail {
  const entries = [...(lead.entries ?? [asEntry(lead)]), asEntry(ended)].slice(-MAX_COHORT_ENTRIES);
  return {
    ...lead,
    summary: `${lead.summary} (and ${entries.length - 1} more)`,
    body: [
      lead.body,
      "—",
      `[and since] ${ended.summary}`,
      // Said in words because the entry above is a summary line and a model
      // acting on "the analysis is in" needs to know the run it came from is
      // finished — that is the fact #240 exists to protect.
      "That is TWO things about one run, in one notice: the message above, and the fact that the run it came from has since ended. Nothing was withheld and nothing else arrived.",
    ].join("\n"),
    entries,
  };
}

/**
 * HELD MAIL, DELIVERED — issue #631 part 2.
 *
 * A peer message that arrived while this session was working has ALREADY been
 * announced: `submitAgentTurn` wrote its row at accept, because a person
 * reading the transcript is entitled to see a thing arrive when it arrived.
 * What the model gets is this, later, at the idle transition — and the two must
 * not read as the same event said twice.
 *
 * SO IT SAYS WHEN. One clause, and it is the fact that distinguishes the rows:
 * the row above is "this landed", this one is "and here it is, now that you are
 * free". A cohort of several already reads as a delivery (`mergeNotifications`
 * writes its own list header), so only the singleton needs saying.
 *
 * WAKES ARE UNTOUCHED. A held wake was never announced at accept — nothing
 * wrote a row for it — so for that path the delivery IS the arrival and there
 * is no second reading to distinguish it from.
 */
export function heldDelivery(detail: NotificationDetail): NotificationDetail {
  if (detail.kind !== "peer_message" || detail.entries) return detail;
  return {
    ...detail,
    body: `${detail.body}\nIt arrived while this session was working and was held until now; nothing else is waiting.`,
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
  // A HELD PEER MESSAGE REACHES THIS TOO (#631 part 2), and it is not a wake:
  // nothing this session subscribed to did anything. The label used to read
  // `[notification: wake · session X]` for whatever was not a request, which
  // for a peer's report would have named a wake that never happened.
  const what = detail.kind === "request" ? "request" : detail.kind === "peer_message" ? "peer message" : "wake";
  const where = detail.sessionId ? ` · session ${detail.sessionId}` : "";
  const which = detail.wakeKind ? ` · ${detail.wakeKind}` : "";
  return `[notification: ${what}${which}${where}]`;
}
