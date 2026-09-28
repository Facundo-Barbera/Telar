import crypto from "node:crypto";
import {
  type EngineRequest,
  type Item,
  type NotificationDetail,
  type RequestDetail,
  type Session,
  type Subscription,
  type Turn,
  type WakeKind,
  type WakeReason,
} from "@telar/engine-client";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import { isPeerMail, TERMINAL_WAKE_KINDS, type SessionItems, type SessionMailbox, type SessionQueue, type SessionRecords, type SessionSubscriptions } from "../sessions";
import { quotedExcerpt } from "./agent-notice";
import { RELAY_RULE } from "./attribution";
import { FOLDING_INTENTS, type TurnSubmission } from "./intake";
import { heldDelivery, MAX_DELIVERIES, mergeNotifications, mergeRunOutcome, notificationLabel, wakeNotification, withoutWakesFrom } from "./notification";

// The engine's one sentence about a transition: a summons naming where to read, never the result itself.
function wakeMessage(
  kind: WakeKind,
  target: Session,
  turn: Turn,
  context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest },
): string {
  const who = `Session ${target.id} "${target.title}"`;
  const lines: string[] = [];
  switch (kind) {
    case "turn_completed": {
      const text = (context.resultText ?? "").trim();
      lines.push(`[wake: completed] ${who} — turn ${turn.runId} completed.`);
      if (!text) {
        lines.push("It ended with no answer text.");
        break;
      }
      const where = `sessions_read(sessionId: "${target.id}", runId: "${turn.runId}")`;
      lines.push(`It answered with ${text.length} characters.`, ...quotedExcerpt(text, where), RELAY_RULE, "—", "The same read has that run's events; its diff is sessions_diff.");
      return lines.join("\n");
    }
    case "turn_failed":
      lines.push(
        `[wake: failed] ${who} — turn ${turn.runId} FAILED${context.failure ? ` (${context.failure.code})` : "."}`,
        ...(context.failure ? [clampWake(context.failure.message)] : []),
      );
      break;
    case "turn_stopped":
      lines.push(`[wake: stopped] ${who} — turn ${turn.runId} was stopped.`);
      break;
    case "request_opened": {
      const request = context.request!;
      lines.push(
        `[wake: waiting] ${who} — is WAITING on a request (request ${request.id}, kind ${request.detail.kind}): ${clampWake(requestTitle(request.detail))}`,
        "—",
        `Read it with sessions_read(sessionId: "${target.id}", runId: "${turn.runId}") — the request's own fields are there. Answer with sessions_resolve_request(sessionId: "${target.id}", requestId: "${request.id}", decision, answers?). Only answer what you actually know; decline or leave it for the user otherwise.`,
      );
      return lines.join("\n");
    }
  }
  lines.push(
    "—",
    // THE RETRIEVAL IS DIRECTLY USABLE, and scoped to this run: a coordinator
    // that wants the outcome should not have to page a journal to find it.
    `Fetch it with sessions_read(sessionId: "${target.id}", runId: "${turn.runId}") — that run's events and its final answer, bounded. Its diff with sessions_diff.`,
  );
  return lines.join("\n");
}

export const TIMEOUT_REASON =
  "Nobody answered before this request's deadline, so the default stated when it was opened was taken. A person did not decide this. Do not re-open the same request — say what happened and carry on, or ask something the person can answer later.";

function clampWake(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_WAKE_LINE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_WAKE_LINE_CHARS)}… [${trimmed.length - MAX_WAKE_LINE_CHARS} more characters — sessions_read has the rest]`;
}

export function requestTitle(detail: RequestDetail): string {
  switch (detail.kind) {
    case "command_execution":
      return detail.command.command;
    case "file_change":
      return `${detail.change.kind} ${detail.change.path}`;
    case "file_read":
      return detail.read.path;
    case "tool_call":
      return detail.call.name;
    case "user_input":
      return detail.prompt;
    case "secret_access":
      // Origin and nothing else: the notification body may land on a lock
      // screen, and even item TITLES are more than a passer-by should read.
      return `Fill login from 1Password — ${detail.secret.origin}`;
  }
}

const MAX_WAKE_LINE_CHARS = 240;

const RESULT_DELIVERED_STATES: ReadonlySet<Turn["state"]> = new Set(["claimed", "running", "steering", "steered", "completed"]);

type WakeDeps = {
  records: SessionRecords;
  items: SessionItems;
  mailbox: SessionMailbox;
  subscriptions: SessionSubscriptions;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  scanQueue: (sessionId: string) => SessionQueue;
  submitTurn: (sessionId: string, input: TurnSubmission) => { turn: Turn; replayed: boolean };
  writeNotificationItem: (sessionId: string, turn: Turn) => void;
};

/** Waking subscribers when a session's turn ends or parks, and holding, merging and delivering those notifications. */
export class TurnWakes {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: WakeDeps,
  ) {}

  /**
   * The wake, after a terminal transition or a parked request has been written, so it can never fail that transition.
   * A wake is a turn on the subscriber through `submitTurn`; a wake's own ending wakes nobody.
   */
  fireSubscriptions(
    targetSessionId: string,
    kind: WakeKind,
    turn: Turn,
    context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest },
  ): void {
    if (turn.origin === "session" && turn.wakeReason) return;
    this.deps.subscriptions.advanceCohortMember(targetSessionId, kind, turn, context);
    const all = this.deps.subscriptions.readSubscriptions();
    const hits = all.filter((each) => each.targetSessionId === targetSessionId && each.events.includes(kind));
    if (kind === "request_opened") {
      for (const cohort of this.deps.subscriptions.readCohorts()) {
        if (!cohort.members.some((member) => member.sessionId === targetSessionId && !member.outcome)) continue;
        if (hits.some((each) => each.subscriberSessionId === cohort.subscriberSessionId)) continue;
        hits.push({
          id: cohort.id,
          subscriberSessionId: cohort.subscriberSessionId,
          targetSessionId,
          events: ["request_opened"],
          ...(cohort.completionWake ? { completionWake: cohort.completionWake } : {}),
          createdAt: cohort.createdAt,
        });
      }
    }
    if (hits.length === 0) return;
    let target: Session;
    try {
      target = this.deps.records.get(targetSessionId);
    } catch {
      return;
    }
    let changed = false;
    const remove = (subscription: Subscription) => {
      const index = all.indexOf(subscription);
      if (index >= 0) all.splice(index, 1);
      changed = true;
    };
    const notification = wakeNotification({
      wakeKind: kind,
      targetSessionId,
      runId: turn.runId,
      ...(context.request ? { requestId: context.request.id } : {}),
      body: wakeMessage(kind, target, turn, context),
    });
    // Asked once, not per subscriber: it is a fact about the run.
    const silentTurn = kind === "turn_completed" && this.saidNothing(targetSessionId, turn);
    for (const subscription of hits) {
      const subscriberId = subscription.subscriberSessionId;
      if (subscriberId === targetSessionId) continue;
      let subscriber: Session | undefined;
      try {
        subscriber = this.deps.records.get(subscriberId);
      } catch {
        subscriber = undefined;
      }
      if (!subscriber || subscriber.state !== "active") {
        // The subscriber is gone; its wish goes with it.
        remove(subscription);
        continue;
      }
      if (subscriber.agentMessagesBlocked) continue;
      const wakeReason: WakeReason = {
        kind,
        sessionId: targetSessionId,
        runId: turn.runId,
        ...(context.request ? { requestId: context.request.id } : {}),
      };
      const interrupting = (subscription.completionWake ?? "settled_only") === "always" && this.hasLiveTurn(subscriberId);
      if (!interrupting && this.mergeIntoWaitingResult(subscriberId, targetSessionId, notification, kind)) {
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      if (
        kind === "turn_completed" &&
        (this.reportedTo(subscriberId, targetSessionId, turn.runId) ||
          ((subscription.completionWake ?? "settled_only") === "settled_only" && (this.messageDeliveredTo(subscriberId, targetSessionId, turn.runId) || silentTurn)))
      ) {
        const recorded: NotificationDetail = { ...notification, deliveries: 1 };
        try {
          this.deps.submitTurn(subscriberId, {
            runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
            input: notificationLabel(recorded),
            origin: "session",
            wakeReason,
            notification: recorded,
            agentDelivery: "passive",
          });
        } catch (error) {
          // The same contract as the wake path below: a subscriber that cannot
          // take a row (its project put away, say) keeps its own state, and the
          // reason goes on its journal.
          if (!(error instanceof EngineStateError && error.code === "conflict")) throw error;
          this.kernel.appendEvent(subscriberId, {
            type: "runtime.warning",
            message: `a completion from session ${targetSessionId} could not be recorded: ${error.message}`,
          });
        }
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      if ((subscription.completionWake ?? "settled_only") === "settled_only" && this.hasLiveTurn(subscriberId)) {
        this.deps.mailbox.hold(subscriberId, notification);
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      if (this.deps.mailbox.pending(subscriberId).length > 0) {
        this.deps.mailbox.hold(subscriberId, notification);
        this.flushPendingNotifications(subscriberId);
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      try {
        const coalesced = this.coalesceQueuedWake(subscriberId, targetSessionId, notification, wakeReason);
        const waiting = coalesced || interrupting ? undefined : this.waitingNotificationTurn(subscriberId);
        if (waiting) this.joinWaitingNotification(subscriberId, waiting, notification, wakeReason);
        else if (!coalesced) {
          const delivered: NotificationDetail = { ...notification, deliveries: 1 };
          this.deps.submitTurn(subscriberId, {
            runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
            input: notificationLabel(delivered),
            origin: "session",
            wakeReason,
            notification: delivered,
          });
        }
        // ONLY AN ENDING SPENDS A ONE-SHOT — see `TERMINAL_WAKE_KINDS`. A
        // `request_opened` says the target is waiting on someone, not that it
        // is finished, and a subscription spent there never fired again.
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
      } catch (error) {
        // A full backlog or an ambiguous turn on the subscriber is that
        // session's own state, and a wake is not worth breaking it for. Said
        // on the subscriber's journal, where the person reading it will look.
        if (error instanceof EngineStateError && error.code === "conflict") {
          this.kernel.appendEvent(subscriberId, {
            type: "runtime.warning",
            message: `a wake from session ${targetSessionId} (${kind}) was dropped: ${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
    if (changed) this.deps.subscriptions.writeSubscriptions(all);
  }

  // Rewrites a still-queued wake about the same child run in place; past `MAX_DELIVERIES` the newer fact goes to the mailbox.
  private coalesceQueuedWake(subscriberId: string, targetSessionId: string, notification: NotificationDetail, wakeReason: WakeReason): boolean {
    const queue = this.deps.readQueue(subscriberId);
    const waiting = queue.turns.find(
      (turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason?.sessionId === targetSessionId && turn.wakeReason.runId === wakeReason.runId,
    );
    if (!waiting) return false;
    const deliveries = (waiting.notification?.deliveries ?? 1) + 1;
    if (deliveries > MAX_DELIVERIES) {
      this.deps.mailbox.hold(subscriberId, notification);
      return true;
    }
    const at = this.kernel.now();
    // A turn that carries a cohort keeps it: only this run's lines are replaced.
    const others = waiting.notification?.entries?.filter((entry) => !(entry.sessionId === targetSessionId && entry.runId === wakeReason.runId));
    notification = { ...(others?.length ? mergeNotifications([{ ...waiting.notification!, entries: others }, notification]) : notification), deliveries };
    waiting.input = notificationLabel(notification);
    waiting.notification = notification;
    waiting.wakeReason = wakeReason;
    waiting.updatedAt = at;
    this.deps.writeQueue(subscriberId, queue);
    this.deps.records.touch(subscriberId, at);
    // The ROW is rewritten with the turn: the transcript's notification says
    // what the turn says, or a person reads a superseded line beside a turn that
    // will announce something else.
    this.rewriteNotificationItem(subscriberId, waiting);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.kernel.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  /** The queued notification turn still waiting to be read: a wake, or a peer's report, result or blocker. */
  waitingNotificationTurn(sessionId: string): string | undefined {
    return this.deps.readQueue(sessionId).turns.find(
      (turn) =>
        turn.state === "queued" &&
        turn.origin === "session" &&
        turn.notification !== undefined &&
        turn.agentDelivery !== "passive" &&
        (turn.wakeReason !== undefined || (turn.agentIntent !== undefined && FOLDING_INTENTS.has(turn.agentIntent))),
    )?.runId;
  }

  /** Joins a notification to the waiting turn. Not a delivery spent; a peer's turn keeps its body and takes no `wakeReason`. */
  joinWaitingNotification(sessionId: string, waitingRunId: string, notification: NotificationDetail, wakeReason?: WakeReason): void {
    const queue = this.deps.readQueue(sessionId);
    const waiting = queue.turns.find((candidate) => candidate.runId === waitingRunId);
    if (!waiting?.notification || waiting.state !== "queued") return;
    const at = this.kernel.now();
    const merged: NotificationDetail = { ...mergeNotifications([waiting.notification, notification]), deliveries: waiting.notification.deliveries ?? 1 };
    waiting.notification = merged;
    if (waiting.wakeReason) {
      waiting.input = notificationLabel(merged);
      if (wakeReason) waiting.wakeReason = wakeReason;
    } else {
      waiting.agentNotice = merged.body;
    }
    waiting.updatedAt = at;
    this.deps.writeQueue(sessionId, queue);
    this.deps.records.touch(sessionId, at);
    this.rewriteNotificationItem(sessionId, waiting);
    this.kernel.appendEvent(sessionId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
  }

  // Folds a run's ending into the unread result it already sent. The peer's body (`input`) is never rewritten.
  private mergeIntoWaitingResult(subscriberId: string, targetSessionId: string, notification: NotificationDetail, kind: WakeKind): boolean {
    // AN ENDING, NOT A PARKED REQUEST. "Someone is waiting on you" is a thing
    // to act on rather than an outcome, and folding it under a result would
    // hide the one notification a person is meant to answer.
    if (!TERMINAL_WAKE_KINDS.includes(kind)) return false;
    const queue = this.deps.readQueue(subscriberId);
    const waiting = queue.turns.find(
      (candidate) =>
        candidate.state === "queued" &&
        candidate.origin === "session" &&
        !candidate.wakeReason &&
        candidate.notification?.kind === "peer_message" &&
        candidate.sender?.sessionId === targetSessionId &&
        candidate.agentSourceRunId === notification.runId,
    );
    if (!waiting?.notification) return false;
    const deliveries = (waiting.notification.deliveries ?? 1) + 1;
    if (deliveries > MAX_DELIVERIES) {
      this.deps.mailbox.hold(subscriberId, notification);
      return true;
    }
    const at = this.kernel.now();
    const merged: NotificationDetail = { ...mergeRunOutcome(waiting.notification, notification), deliveries };
    waiting.notification = merged;
    // THE NOTICE AND THE NOTIFICATION ARE ONE STRING (#550). `agentNotice` is
    // derived from the body and nothing else, so a merge that moved one and
    // left the other is the drift that field exists to prevent.
    waiting.agentNotice = merged.body;
    waiting.updatedAt = at;
    this.deps.writeQueue(subscriberId, queue);
    this.deps.records.touch(subscriberId, at);
    this.rewriteNotificationItem(subscriberId, waiting);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.kernel.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  // A run that left nothing to read: a background-claim turn, or no answer text and no assistant message.
  private saidNothing(sessionId: string, turn: Turn): boolean {
    if (turn.origin === "provider" && turn.providerReason?.kind === "background_task") return true;
    if (turn.resultText?.trim()) return false;
    const items = this.deps.items.peekRun(sessionId, turn.runId);
    return !items.some((item) => item.detail.type === "assistant_message" && item.detail.text.trim().length > 0);
  }

  // The target already gave this subscriber its answer (a result or blocker from the run, or a result since the latest errand).
  private reportedTo(subscriberId: string, targetSessionId: string, runId: string): boolean {
    const errandAt = this.deps.scanQueue(targetSessionId).turns
      .filter((turn) => turn.agentDelivery !== "passive" && turn.sender?.sessionId === subscriberId)
      .at(-1)?.acceptedAt;
    return this.deps.scanQueue(subscriberId).turns.some(
      (candidate) =>
        candidate.origin === "session" &&
        candidate.state !== "discarded" &&
        candidate.sender?.sessionId === targetSessionId &&
        (((candidate.agentIntent === "result" || candidate.agentIntent === "blocker") && candidate.agentSourceRunId === runId) ||
          (candidate.agentIntent === "result" && errandAt !== undefined && candidate.acceptedAt >= errandAt)),
    );
  }

  // A report, result or blocker from this run already reached the subscriber's model as a wake.
  private messageDeliveredTo(subscriberId: string, targetSessionId: string, runId: string): boolean {
    return this.deps.scanQueue(subscriberId).turns.some(
      (candidate) =>
        RESULT_DELIVERED_STATES.has(candidate.state) &&
        candidate.origin === "session" &&
        candidate.agentIntent !== undefined &&
        FOLDING_INTENTS.has(candidate.agentIntent) &&
        candidate.agentDelivery !== "passive" &&
        candidate.sender?.sessionId === targetSessionId &&
        candidate.agentSourceRunId === runId,
    );
  }

  /** A turn in front of a provider now; `queued` is deliberately not busy. */
  hasLiveTurn(sessionId: string): boolean {
    return this.deps.scanQueue(sessionId).turns.some((turn) => turn.state === "claimed" || turn.state === "running" || turn.state === "steering");
  }

  /** Delivers everything held as one notification when the session is idle; peer mail alone rides with the next turn. */
  flushPendingNotifications(sessionId: string): void {
    if (!this.hasLiveTurn(sessionId)) this.deps.subscriptions.deliverReadyCohorts(sessionId);
    const pending = this.deps.mailbox.pending(sessionId);
    if (pending.length === 0) return;
    if (this.hasLiveTurn(sessionId)) return;
    // Peer mail alone is not a reason for a turn: it rides with the next one.
    if (pending.every(isPeerMail)) return;
    const merged = heldDelivery(mergeNotifications(pending));
    // CLEARED BEFORE THE SUBMIT, so a submit that throws cannot be retried into
    // a duplicate — and after it, the facts live on the turn, which is durable.
    this.deps.mailbox.setPending(sessionId, []);
    // A notification turn already queued takes the held mail with it.
    const waiting = this.waitingNotificationTurn(sessionId);
    if (waiting) {
      this.joinWaitingNotification(sessionId, waiting, merged);
      return;
    }
    const delivered: NotificationDetail = { ...merged, deliveries: 1 };
    try {
      this.deps.submitTurn(sessionId, {
        runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
        input: notificationLabel(delivered),
        origin: "session",
        ...(merged.wakeKind
          ? {
              wakeReason: {
                kind: merged.wakeKind,
                sessionId: merged.sessionId ?? sessionId,
                ...(merged.runId ? { runId: merged.runId } : {}),
                ...(merged.requestId ? { requestId: merged.requestId } : {}),
              },
            }
          : { sender: merged.sessionId ? { sessionId: merged.sessionId } : {} }),
        notification: delivered,
      });
    } catch (error) {
      // Same contract as `fireSubscriptions`: the recipient's own state is not
      // worth breaking a delivery for, and the reason goes where a person looks.
      if (error instanceof EngineStateError && error.code === "conflict") {
        this.kernel.appendEvent(sessionId, { type: "runtime.warning", message: `held notifications could not be delivered: ${error.message}` });
        return;
      }
      throw error;
    }
  }

  /** What the cap kept from being pushed again, for `sessions_status`. */
  pendingNotifications(sessionId: string): NotificationDetail[] {
    this.deps.records.require(sessionId);
    return structuredClone(this.deps.mailbox.pending(sessionId));
  }

  /** The other half of `writeNotificationItem`: the row a coalesce superseded. */
  rewriteNotificationItem(sessionId: string, turn: Turn): void {
    const detail = turn.notification;
    if (!detail) return;
    const items = this.deps.items.read(sessionId);
    const existing = items.get(`notification_${turn.runId}`);
    if (!existing) {
      this.deps.writeNotificationItem(sessionId, turn);
      return;
    }
    const item: Item = { ...existing, title: detail.summary, detail: { type: "notification", notification: detail } };
    items.set(item.id, item);
    this.deps.items.write(sessionId, items, new Set([item.id]));
    this.kernel.appendEvent(sessionId, { type: "item.updated", item }, turn.runId);
  }

  /** Withdraws queued wakes (from one source, or all); a turn other sessions' news joined keeps the rest. */
  discardQueuedWakes(subscriberId: string, targetSessionId?: string): number {
    const queue = this.deps.readQueue(subscriberId);
    const at = this.kernel.now();
    const candidates = queue.turns.filter((turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason !== undefined);
    const dropped: Turn[] = [];
    const trimmed: Turn[] = [];
    for (const turn of candidates) {
      // A cohort's notification is about all its members, not the one that led it.
      if (targetSessionId !== undefined && turn.notification?.cohortId) continue;
      if (targetSessionId === undefined || !turn.notification?.entries) {
        if (targetSessionId === undefined || turn.wakeReason!.sessionId === targetSessionId) dropped.push(turn);
        continue;
      }
      const kept = withoutWakesFrom(turn.notification, targetSessionId, subscriberId);
      if (!kept) dropped.push(turn);
      else if (kept !== turn.notification) {
        turn.notification = { ...kept, deliveries: turn.notification.deliveries ?? 1 };
        turn.input = notificationLabel(turn.notification);
        const wake = kept.entries?.filter((entry) => entry.kind !== "peer_message" && entry.wakeKind).at(-1);
        if (wake) turn.wakeReason = { kind: wake.wakeKind!, sessionId: wake.sessionId!, runId: wake.runId!, ...(wake.requestId ? { requestId: wake.requestId } : {}) };
        turn.updatedAt = at;
        trimmed.push(turn);
      }
    }
    if (dropped.length === 0 && trimmed.length === 0) return 0;
    for (const turn of dropped) {
      turn.state = "discarded";
      turn.completedAt = at;
      turn.updatedAt = at;
    }
    this.deps.writeQueue(subscriberId, queue);
    this.deps.records.touch(subscriberId, at);
    for (const turn of trimmed) {
      this.rewriteNotificationItem(subscriberId, turn);
      this.kernel.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(turn), replayed: true }, turn.runId);
    }
    for (const turn of dropped) this.kernel.appendEvent(subscriberId, { type: "turn.discarded" }, turn.runId);
    return dropped.length + trimmed.length;
  }
}
