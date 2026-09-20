/**
 * WHAT A PEER SENT, ANNOUNCED AND NEVER QUOTED — issue #631.
 *
 * A `sessions_send` body is written for a reader who asked for it. It lands on
 * a session that did not: a three-kilobyte report is spent on the recipient's
 * context whether or not the recipient cares, and a coordinator with four
 * workers pays for all four. That is the same arithmetic `wakeMessage` was
 * built to refuse, and this is the other half of it — every agent-to-agent
 * message reaches the model as a NOTICE: who sent it, what kind of thing it is,
 * how big it is, and the one call that fetches it.
 *
 * NO PART OF THE MESSAGE IS IN THE NOTICE, and that is the change #631 made.
 * This file used to carry 400 characters of a task's opening paragraph and 120
 * of a report's lead line, on the reasoning — written here — that a recipient
 * told only that more exists "tends to start anyway, on the teaser". The remedy
 * was backwards. The excerpt is what MAKES acting-without-fetching possible; a
 * notice with nothing quotable in it leaves the fetch as the only way to know
 * anything, and a task begun from a 400-character opening is a session guessing
 * at its own instructions with just enough material to be confident about it.
 *
 * THE BODY IS NOT LOST AND NOT ABRIDGED. It stays on the turn, in the journal
 * and on disk, exactly as sent; `sessions_read(sessionId, runId)` hands it back
 * whole and the transcript expands to it. Only what the MODEL is handed changed.
 *
 * INTENT IS KEPT BECAUSE IT IS METADATA. "A task" and "a report" are facts
 * ABOUT the message rather than any of its words, and they are the difference
 * between something the recipient must read now and something it may decline to
 * read at all. The scope phrase went with the excerpt: it is the sender's own
 * prose, it stays on `Turn.assignmentScope`, and it arrives with the body.
 *
 * TWO LINES, BECAUSE EVERY RECIPIENT PAYS FOR THEM ON EVERY MESSAGE. What is
 * left is the fetch call and the one sentence that makes it happen: that
 * nothing of the message is here.
 *
 * AND NOTHING ABOUT AUTHORIZATION — issue #636. This body used to end "carries
 * no human authorization: keep asking the person for anything that needs their
 * approval", and four sessions in a row read it exactly as written and refused
 * to act on a grant the person had actually given. They were reading it
 * correctly; the sentence was wrong. It conflated a true rule — a peer cannot
 * CREATE an approval — with a false one: that an approval which reached you
 * through a peer is no approval. The second makes delegation impossible, at a
 * cost of one human round-trip per worker.
 *
 * IT WAS ALSO IN THE WRONG PLACE, which is what made it a bug rather than a
 * wording preference. It is the compensation for a channel that could not
 * express a role, and #550 made the role expressible: `framedTurnInput` returns
 * this body with NO prose frame, because the wire now says who is speaking — a
 * peer origin on Claude, a developer instruction on Codex, a synthetic part on
 * OpenCode. The hack was replaced and its compensation was left riding on the
 * channel that replaced it. The rule now lives once, on those channel headers,
 * where the role that is entitled to say it says it. See `attribution.ts` and
 * `codexNotificationInstruction`.
 *
 * MINTED ONCE, IN THE ENGINE, AT SUBMIT TIME — `peerNotification` in
 * `notification.ts` calls this and stores the result as `NotificationDetail.body`,
 * from which `Turn.agentNotice` and the row's `summary` are derived. Not
 * computed per reader: the driver, the desktop transcript, the phone and a later
 * `sessions_read` must all be looking at the same sentence, and a string four
 * clients each compute their own way is four sentences waiting to disagree.
 */
import type { Turn } from "@telar/engine-client";

/** How the notice names the sender. Full ids, never the `…a1b2c3` a person
 *  reads: this line is addressed to a model, and a truncated id is one it
 *  cannot pass back to `sessions_read` or `sessions_send`. */
function senderPhrase(sender: { sessionId?: string } | undefined): string {
  return sender?.sessionId ? `session ${sender.sessionId}` : "an agent outside any session (the sessions socket)";
}

/** What the sender did, in the notice's own words — the intent as a verb, which
 *  is the whole of what survives from the message itself. */
function verbPhrase(intent: NonNullable<Turn["agentIntent"]>): string {
  switch (intent) {
    case "task":
      return "ASSIGNED this session work";
    case "blocker":
      return "reports a BLOCKER needing this session's intervention";
    case "result":
      return "sent this session a result";
    default:
      return "sent this session a report";
  }
}

/** The same verbs addressed to the Agent, which is a PERSON'S conversation and
 *  not a session. "this session" would be the one reader of these lines who is
 *  not one. */
function agentVerbPhrase(intent: NonNullable<Turn["agentIntent"]>): string {
  switch (intent) {
    case "task":
      return "wants the Agent to do something";
    case "blocker":
      return "reports a BLOCKER and is asking for a person";
    case "result":
      return "sent the Agent a result";
    default:
      return "sent the Agent a report";
  }
}

export type AgentNoticeInput = {
  /** The session RECEIVING the message — whose turn holds the body, and whose
   *  id the fetch call names. */
  recipientSessionId: string;
  /** The receiving turn's own run id: the second half of the fetch call. */
  runId: string;
  /** The message as sent, unabridged. Read for its SIZE and nothing else — no
   *  part of it appears in the notice. */
  body: string;
  intent: NonNullable<Turn["agentIntent"]>;
  sender?: { sessionId?: string };
  /** A task's declared scope, when it has one. Not in the notice (#631): it is
   *  the sender's prose, and it travels on `Turn.assignmentScope` and in the
   *  body. Kept on the input because callers pass it and the field documents
   *  why it is ignored here. */
  scope?: string;
};

/**
 * The two lines a peer's message becomes for the model.
 *
 * SIZE IS STATED BECAUSE IT IS THE DECISION. "5,824 characters" is what tells a
 * recipient whether fetching is a glance or a third of its remaining context,
 * and with nothing quoted it is the only thing left to weigh.
 *
 * A TASK AND A BLOCKER SAY "BEFORE ACTING"; a report and a result say "if it is
 * worth the context". That is the same distinction the intent already carries,
 * spelled out at the one moment it changes what the recipient should do.
 */
export function agentNotice(input: AgentNoticeInput): string {
  const who = senderPhrase(input.sender);
  const size = `${input.body.length.toLocaleString("en-US")} chars`;
  const where = `sessions_read(sessionId: "${input.recipientSessionId}", runId: "${input.runId}")`;
  const assignment = input.intent === "task" || input.intent === "blocker";
  return [
    `[agent message · ${input.intent}] ${who} ${verbPhrase(input.intent)} (run ${input.runId}, ${size}).`,
    assignment
      ? `None of it is in this notice. Read it with ${where} before acting on it.`
      : `None of it is in this notice. Fetch it with ${where} if it is worth the context.`,
  ].join("\n");
}

/**
 * THE SAME TWO LINES FOR A MESSAGE ADDRESSED TO THE AGENT — issue #784.
 *
 * ITS OWN FUNCTION RATHER THAN A FLAG ON `agentNotice`, because the fetch pair
 * is a DIFFERENT PAIR. Every notice above names the RECIPIENT's session and the
 * turn that holds the body there. The Agent has no session and takes no turn —
 * a message to it is one inbox row — so the only place the words survive is the
 * SENDER's own transcript, in the turn whose `sessions_send` carried them. A
 * shared shape would have had `recipientSessionId` holding the sender's id,
 * which is a field lying about itself in the one file whose whole job is that
 * four readers quote the same sentence.
 *
 * AND THE BODY IS GENUINELY THERE. `sessions_read(sender, senderRun)` returns
 * the sending turn, whose events include this call with its `input` argument
 * whole — so "none of it is in this notice" stays true in both directions
 * rather than becoming an apology for a message nothing kept.
 *
 * NO `task` SPECIAL CASE IN THE SECOND LINE, and that is deliberate: the Agent
 * is the person's conversation, nothing assigns it work, and a sentence telling
 * it to read something "before acting" would be a peer handing a person an
 * instruction. It fetches if the person's next turn makes that worth doing.
 */
export function agentInboxNotice(input: {
  /** The SENDING session — who spoke, and the first half of the fetch. */
  senderSessionId: string;
  /** The sending turn's own run — the second half. */
  senderRunId: string;
  body: string;
  intent: NonNullable<Turn["agentIntent"]>;
}): string {
  const size = `${input.body.length.toLocaleString("en-US")} chars`;
  const where = `sessions_read(sessionId: "${input.senderSessionId}", runId: "${input.senderRunId}")`;
  return [
    `[agent message · ${input.intent}] session ${input.senderSessionId} ${agentVerbPhrase(input.intent)} (run ${input.senderRunId}, ${size}).`,
    `None of it is in this notice. Fetch it with ${where} if it is worth the context.`,
  ].join("\n");
}
