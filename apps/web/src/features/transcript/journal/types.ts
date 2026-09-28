import { type Item,type RateLimitType,type Task,type Turn,type TurnAttachment,type TurnFailureCode,type TurnState,type UsageSnapshot } from "@telar/engine-client";

export type JournalItem = Item & {
  /** Deltas accumulated in arrival order. Empty for items that never stream. */
  streamedText: string;
  /** A figure the kernel drew during this turn — the attachment behind it.
   *  Set only on the synthetic `unknown` rows the plot fold produces. */
  plotAttachmentId?: string;
  /** The event id that opened this item — the sort key, not a display value. */
  openedBy: number;
};

/** A sub-agent, with the rows it produced. */
export type JournalTask = Task & { items: JournalItem[] };

export type JournalTurn = {
  runId: string;
  prompt: string;
  kind?: "message" | "compact" | "import";
  /** `schedule` since #543 — a turn a CLOCK started, drawn as what it is
   *  rather than as something a person typed. */
  origin?: "user" | "provider" | "session" | "schedule" | "restart";
  /** Why the engine wrote this turn itself after a restart — see
   *  `Turn.restartOrigin`. Present only on `origin: "restart"`. */
  restartOrigin?: Turn["restartOrigin"];
  /** For a provider turn: the row whose ending woke it, when known. */
  wokenBy?: string;
  askedBy?: string;
  /** That turn exists for the claim, not for a reply. True even when the
   *  asking task could not be named. */
  decidedForBackgroundWork?: boolean;
  /** For a session turn: what the other session did, and which one. */
  wakeReason?: Turn["wakeReason"];
  /** For a session turn an AGENT sent directly (`sessions_send`): who. Drawn
   *  as an agent's bubble, never as the person's — the words are a peer's. */
  sender?: Turn["sender"];
  agentDelivery?: Turn["agentDelivery"];
  /** `task` renders as a full message; a report stays collapsed. */
  agentIntent?: Turn["agentIntent"];
  /** The engine's one-line announcement of that message — the collapsed row's
   *  label, and what the recipient's model was handed instead of `prompt`. */
  agentNotice?: Turn["agentNotice"];
  notification?: Turn["notification"];
  /** What the sender said the task covers. Descriptive; confers nothing. */
  assignmentScope?: Turn["assignmentScope"];
  /** Files sent WITH this message. On the turn because that is what they
   *  describe — a transcript that showed the words and not the screenshot has
   *  lost half of what was said. */
  attachments?: TurnAttachment[];
  state: TurnState;
  held?: boolean;
  /** WHY it is held: a restart's re-read, or the session being paused. The
   *  transcript offers different verbs for the two. */
  heldReason?: NonNullable<Turn["held"]>["reason"];
  items: JournalItem[];
  /** Sub-agents and background work launched by this turn. */
  tasks: JournalTask[];
  /** When the engine took the message — for a passive arrival, WHEN it
   *  arrived, which is what places it inside the turn that was running. */
  acceptedAt?: number;
  /** When the provider actually started, for the live elapsed clock. Absent
   *  until the turn is claimed and running. */
  startedAt?: number;
  /** When the turn reached a terminal state, however it got there. */
  endedAt?: number;
  lastActivityAt?: number;
  /** The assistant's final text, as the engine recorded it on completion. */
  resultText: string;
  failure?: string;
  failureCode?: TurnFailureCode;
  /** `rate_limited`: when the limit lifts, in MILLISECONDS. The engine converted
   *  it from the provider's seconds — see `TurnFailure.resumeAt`. */
  resumeAt?: number;
  /** `rate_limited`: which limit, so the row can name it. */
  limitType?: RateLimitType;
  /** The engine brought this turn back after a limit lifted. Kept even though
   *  the turn is `queued` again, so scrolling back shows the session sat one
   *  out rather than an unexplained gap. */
  resumedAfterRateLimit?: number;
  usage?: UsageSnapshot;
};

export function taskRoster(snapshot: readonly Task[], journal: readonly JournalTask[]): JournalTask[] {
  const known = new Set(journal.map((task) => task.id));
  return [...journal, ...snapshot.filter((task) => !known.has(task.id)).map((task) => ({ ...task, items: [] }))];
}
