/**
 * WHAT HAPPENED, DECIDED ONCE — issue #572.
 *
 * ── THE BUG THIS EXISTS TO END ──────────────────────────────────────────────
 * A worker sent its coordinator a `result` and its turn ended a few seconds
 * later. Those are two facts and #240 keeps them two on purpose — but both rows
 * read "Session finished a turn", because the surface drawing the peer's message
 * classified it as a wake. One duplicated line, and a coordinator that had been
 * told two different things could not see either.
 *
 * ── SO THE CLASSIFICATION IS ONE FUNCTION ───────────────────────────────────
 * `notificationVerbs` is the only place that turns a happening into a word.
 * `notificationLabel` (the transcript row, the cockpit's turn header, a wake
 * that landed mid-turn) derives from it, so there is no second switch to forget
 * a new intent in.
 *
 * ── HERE RATHER THAN IN `transcript.tsx` ────────────────────────────────────
 * The verbs used to live beside the component that drew them. A pure module
 * has no direction to be wrong about, and the table is testable on its own.
 */
import type { AgentMessageIntent, NotificationKind, RequestResolver, WakeKind } from "@telar/engine-client";

/** Everything the verb is decided from, and nothing else — so a caller holding
 *  a `NotificationDetail` or a `WakeReason` can ask. */
export type NotificationSubject = {
  kind: NotificationKind;
  /** For a peer's message: what the sender said it was. */
  intent?: AgentMessageIntent;
  /** For a wake: which of the four transitions. */
  wakeKind?: WakeKind;
  /**
   * For a request: WHO ANSWERED IT, when it is already answered (#541 D).
   *
   * Only `"timeout"` is read, and only to tell "waiting on you" from "answered
   * for you" — the same request kind, opposite instructions to a reader. It is
   * the contract's own `RequestResolver` value rather than a boolean, so a
   * surface that later wants to say "a peer answered this" has the field.
   */
  resolvedBy?: RequestResolver;
};

export type NotificationVerbs = {
  /** The sentence a transcript row, a turn header and the phone all say. */
  verb: string;
  /** `warning` when a person has to move; the rail's own pair. */
  tone: "warning" | "muted";
};

export function notificationVerbs(subject: NotificationSubject): NotificationVerbs {
  if (subject.kind === "peer_message") {
    switch (subject.intent ?? "report") {
      case "task":
        return { verb: "A session assigned work", tone: "muted" };
      case "blocker":
        return { verb: "A session reported a blocker", tone: "warning" };
      case "result":
        return { verb: "A session sent a result", tone: "muted" };
      default:
        return { verb: "A session sent a message", tone: "muted" };
    }
  }
  /**
   * A REQUEST THAT ANSWERED ITSELF IS THE OPPOSITE INSTRUCTION TO ONE THAT IS
   * WAITING (#541 D), so it is tested FIRST — both are `kind: "request"`, and
   * the branch below would otherwise tell a person to move on something that is
   * already closed. `muted`, because nothing needs them: it is news about a
   * decision taken in their absence, which they may want to look at and cannot
   * undo.
   */
  if (subject.resolvedBy === "timeout") {
    return { verb: "Session ran out its deadline and took its default", tone: "muted" };
  }
  // A PARKED REQUEST IS ITS OWN KIND, and the one a reader can act on. Keyed on
  // either field because the two spellings of it — a `request` notification and
  // a `request_opened` wake — are the same happening reaching two callers.
  if (subject.kind === "request" || subject.wakeKind === "request_opened") {
    return { verb: "Session asked a question", tone: "warning" };
  }
  switch (subject.wakeKind) {
    case "turn_completed":
      return { verb: "Session finished a turn", tone: "muted" };
    case "turn_failed":
      return { verb: "Session failed a turn", tone: "warning" };
    case "turn_stopped":
      return { verb: "Session was stopped", tone: "muted" };
    default:
      // A NEWER ENGINE'S VOCABULARY IS STILL A NOTIFICATION. Naming it vaguely
      // is honest; dropping the row would lose the fact entirely.
      return { verb: "Session activity", tone: "muted" };
  }
}

/**
 * HOW MUCH OF THE MESSAGE A ROW SHOWS AFTER THE VERB.
 *
 * Enough to tell two notices from one session apart at a glance, and not enough
 * to be the message — that is behind the disclosure, and quoting it in the row
 * would be the body problem drawn instead of sent.
 */
export const NOTIFICATION_HEAD_CHARS = 80;

/** The engine's own bracketed kind, stripped — the verb beside it already says
 *  which happening this is, and "[agent message · result]" twice is once. */
export function stripNotificationKind(line: string): string {
  return line.replace(/^\[[^\]]*]\s*/, "").trim();
}

/**
 * THE HEAD OF WHAT WAS ACTUALLY SENT — first line, clamped, and MARKED where it
 * was cut so a reader never has to guess whether the line finished.
 */
export function notificationHead(text: string | undefined, limit = NOTIFICATION_HEAD_CHARS): string | undefined {
  const line = (text ?? "").split("\n").map((each) => each.trim()).find((each) => each.length > 0);
  if (line === undefined) return undefined;
  const stripped = stripNotificationKind(line);
  if (stripped.length === 0) return undefined;
  return stripped.length <= limit ? stripped : `${stripped.slice(0, limit - 1)}…`;
}
