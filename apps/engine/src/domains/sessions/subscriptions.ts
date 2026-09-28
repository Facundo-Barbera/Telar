import crypto from "node:crypto";
import {
  Cohort as CohortSchema,
  Subscription as SubscriptionSchema,
  type Cohort,
  type CohortMember,
  type NotificationDetail,
  type Session,
  type SubscribedCohort,
  type Subscription,
  type Turn,
  type WakeKind,
} from "@telar/engine-client";
import { assertId, EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import { cohortNotification, inlineExcerpt, notificationLabel } from "../turns";

// The file is rewritten whole on each change, so a loop that subscribed forever would slow every transition.
const MAX_SUBSCRIPTIONS_PER_SESSION = 64;
/** The longest an ongoing (`once: false`) subscription lives: a cohort's longest timeout. */
const MAX_WATCH_MS = 7 * 24 * 60 * 60_000;
// Twenty members keeps a cohort's one notice inside `NotificationDetail.body`; the default expiry covers waiting on CI.
const MAX_COHORT_MEMBERS = 20;
const MAX_COHORTS_PER_SESSION = 16;
const DEFAULT_COHORT_MINUTES = 240;
const MAX_COHORT_MINUTES = 7 * 24 * 60;
const COHORT_LINE_CHARS = 200;
const ALL_WAKE_KINDS: readonly WakeKind[] = ["turn_completed", "turn_failed", "turn_stopped", "request_opened"];

/** The events that end a turn, and so the only ones that may consume a one-shot subscription. */
export const TERMINAL_WAKE_KINDS: readonly WakeKind[] = ["turn_completed", "turn_failed", "turn_stopped"];

/** Stopped by a boot or a lost worker, or failed as `interrupted`: Telar cut it off, so for a cohort it is not an ending. */
function cutOffByTelar(turn: Turn): boolean {
  if (turn.state === "stopped") return turn.stopReason === "engine_restart" || turn.stopReason === "worker_unavailable";
  return turn.state === "failed" && turn.failure?.code === "interrupted";
}

function excerptOf(text: string): Pick<CohortMember, "excerpt" | "chars"> {
  const trimmed = text.trim();
  return trimmed ? { excerpt: inlineExcerpt(trimmed).shown, chars: trimmed.length } : {};
}

function firstLineOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.length <= COHORT_LINE_CHARS ? line : `${line.slice(0, COHORT_LINE_CHARS - 1)}…`;
}

type WakeTurn = { runId: string; input: string; origin: "session"; wakeReason: NonNullable<Turn["wakeReason"]>; notification: NotificationDetail };

/** What subscriptions and cohorts still ask of the store around them. */
type SubscriptionHost = {
  require(sessionId: string): Session;
  find(sessionId: string): Session | undefined;
  turnsOf(sessionId: string): Turn[];
  hasLiveTurn(sessionId: string): boolean;
  discardQueuedWakes(subscriberId: string, targetSessionId: string): void;
  submitTurn(sessionId: string, input: WakeTurn): unknown;
  warn(sessionId: string, message: string): void;
};

/** One session asking to be woken by another, and cohorts: one wake when several sessions are all done. */
export class SessionSubscriptions {
  /** The activity fold's grouped view of both files, kept until the next write; this module is its only writer. */
  private subscriptionsBySubscriber: Map<string, Subscription[]> | undefined;

  constructor(
    private readonly kernel: Kernel,
    private readonly host: SubscriptionHost,
  ) {}

  /** Both sessions must be live. Idempotent on the pair: a retry merges the events into the one subscription. */
  subscribe(
    subscriberSessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Subscription {
    return this.kernel.command("subscribe", () => {
      assertId(input.targetSessionId, "target session id");
      if (subscriberSessionId === input.targetSessionId) {
        throw new EngineStateError("invalid_request", "a session cannot subscribe to itself");
      }
      const subscriber = this.host.require(subscriberSessionId);
      if (subscriber.state !== "active") throw new EngineStateError("conflict", "an archived session cannot be woken");
      const target = this.host.require(input.targetSessionId);
      if (target.state !== "active") throw new EngineStateError("conflict", "an archived session will do nothing worth waking for");
      const events = input.events && input.events.length > 0 ? [...new Set(input.events)] : [...ALL_WAKE_KINDS];
      const all = this.readSubscriptions();
      const existing = all.find((each) => each.subscriberSessionId === subscriberSessionId && each.targetSessionId === input.targetSessionId);
      if (existing) {
        existing.events = [...new Set([...existing.events, ...events])];
        if (input.once !== undefined) {
          if (input.once) existing.once = true;
          else delete existing.once;
        }
        // Re-subscribing MERGES, so naming a policy changes it and omitting one
        // leaves whatever was chosen before — the same rule `events` follows.
        if (input.completionWake !== undefined) existing.completionWake = input.completionWake;
        this.writeSubscriptions(all);
        return structuredClone(existing);
      }
      const mine = all.filter((each) => each.subscriberSessionId === subscriberSessionId).length;
      if (mine >= MAX_SUBSCRIPTIONS_PER_SESSION) {
        throw new EngineStateError(
          "conflict",
          `this session is already subscribed to ${mine} sessions, the most it may be. Unsubscribe from ones you are finished with — sessions_subscriptions lists them.`,
        );
      }
      const subscription: Subscription = {
        id: `sub_${crypto.randomUUID().replaceAll("-", "")}`,
        subscriberSessionId,
        targetSessionId: input.targetSessionId,
        events,
        ...(input.once ? { once: true } : {}),
        // ABSENT MEANS `settled_only`. Stored only when explicitly asked for, so
        // the default stays a reading of the contract rather than a value written
        // into every subscription ever made.
        ...(input.completionWake ? { completionWake: input.completionWake } : {}),
        createdAt: this.kernel.now(),
      };
      all.push(subscription);
      this.writeSubscriptions(all);
      return structuredClone(subscription);
    });
  }


  /** With `subscriberSessionId`, another session's subscription reads as
   *  absent — a session may not remove what it did not ask for. */
  unsubscribe(subscriptionId: string, subscriberSessionId?: string): boolean {
    return this.kernel.command("unsubscribe", () => {
      assertId(subscriptionId, "subscription id");
      if (subscriptionId.startsWith("coh_")) {
        // A cohort has no wakes queued before it closes, so there is nothing else to withdraw.
        const cohorts = this.readCohorts();
        const kept = cohorts.filter((each) => !(each.id === subscriptionId && (subscriberSessionId === undefined || each.subscriberSessionId === subscriberSessionId)));
        if (kept.length === cohorts.length) return false;
        this.writeCohorts(kept);
        return true;
      }
      const all = this.readSubscriptions();
      const index = all.findIndex(
        (each) => each.id === subscriptionId && (subscriberSessionId === undefined || each.subscriberSessionId === subscriberSessionId),
      );
      if (index < 0) return false;
      const [removed] = all.splice(index, 1);
      this.writeSubscriptions(all);
      // "Stop waking me" includes the wakes already waiting: an unsubscribe that
      // left fourteen queued wakes to run one by one stopped nothing a person
      // could see. Only QUEUED ones go; a running wake is the worker's.
      this.host.discardQueuedWakes(removed!.subscriberSessionId, removed!.targetSessionId);
      return true;
    });
  }

  /** What this session has asked to be woken by. */
  subscriptionsFor(subscriberSessionId: string): Subscription[] {
    this.host.require(subscriberSessionId);
    return structuredClone(this.readSubscriptions().filter((each) => each.subscriberSessionId === subscriberSessionId));
  }

  readSubscriptions(): Subscription[] {
    const stored = this.kernel.readDocument(this.kernel.paths.subscriptions) as { subscriptions?: unknown } | undefined;
    const parsed = SubscriptionSchema.array().safeParse(stored?.subscriptions ?? []);
    // A corrupt file costs the subscriptions, not the engine — same rule as
    // the attachments index.
    return parsed.success ? parsed.data : [];
  }

  writeSubscriptions(subscriptions: Subscription[]): void {
    this.subscriptionsBySubscriber = undefined;
    this.kernel.writeDocument(this.kernel.paths.subscriptions, { version: STATE_VERSION, subscriptions });
  }

  subscriptionsOf(subscriberSessionId: string): readonly Subscription[] {
    if (!this.subscriptionsBySubscriber) {
      const grouped = new Map<string, Subscription[]>();
      for (const each of this.readSubscriptions()) grouped.set(each.subscriberSessionId, [...(grouped.get(each.subscriberSessionId) ?? []), each]);
      // A cohort's pending members are waited on exactly as a subscription's target is.
      for (const cohort of this.readCohorts()) {
        for (const member of cohort.members) {
          if (member.outcome) continue;
          const each: Subscription = { id: cohort.id, subscriberSessionId: cohort.subscriberSessionId, targetSessionId: member.sessionId, events: ["turn_completed"], createdAt: cohort.createdAt };
          grouped.set(each.subscriberSessionId, [...(grouped.get(each.subscriberSessionId) ?? []), each]);
        }
      }
      this.subscriptionsBySubscriber = grouped;
    }
    return this.subscriptionsBySubscriber.get(subscriberSessionId) ?? [];
  }

  /** A session that is gone can neither wake nor be woken: both directions go. */
  dropSubscriptionsOf(sessionId: string): void {
    const all = this.readSubscriptions();
    const kept = all.filter((each) => each.subscriberSessionId !== sessionId && each.targetSessionId !== sessionId);
    if (kept.length !== all.length) this.writeSubscriptions(kept);
    this.reviewCohorts();
  }

  /** Removes what will never fire: a target settled, archived or deleted, or an ongoing watch past `MAX_WATCH_MS`. */
  sweepSubscriptions(): string[] {
    const all = this.readSubscriptions();
    const now = this.kernel.now();
    const stale = all.filter((each) => {
      if (!each.once && now - each.createdAt >= MAX_WATCH_MS) return true;
      const target = this.host.find(each.targetSessionId);
      return !target || target.state !== "active" || target.settledOverride === "settled";
    });
    if (stale.length === 0) return [];
    this.writeSubscriptions(all.filter((each) => !stale.includes(each)));
    for (const each of stale) this.host.discardQueuedWakes(each.subscriberSessionId, each.targetSessionId);
    return stale.map((each) => each.id);
  }

  // ── Cohorts — one wake when several sessions are all done ────────────────

  /**
   * One notification when every member is done. A member that already finished this subscriber's errand counts at
   * once. The same member set returns the open cohort; an overlapping set takes those members from the older one.
   */
  subscribeCohort(
    subscriberSessionId: string,
    input: { sessionIds: string[]; timeoutMinutes?: number; completionWake?: Cohort["completionWake"] },
  ): SubscribedCohort {
    const ids = [...new Set(input.sessionIds)];
    if (ids.length === 0 || ids.length > MAX_COHORT_MEMBERS) {
      throw new EngineStateError("invalid_request", `a cohort names between 1 and ${MAX_COHORT_MEMBERS} sessions`);
    }
    for (const id of ids) {
      assertId(id, "cohort member session id");
      if (id === subscriberSessionId) throw new EngineStateError("invalid_request", "a session cannot be in its own cohort");
    }
    const minutes = input.timeoutMinutes ?? DEFAULT_COHORT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_COHORT_MINUTES) {
      throw new EngineStateError("invalid_request", `timeoutMinutes must be a whole number from 1 to ${MAX_COHORT_MINUTES}`);
    }
    const subscriber = this.host.require(subscriberSessionId);
    if (subscriber.state !== "active") throw new EngineStateError("conflict", "an archived session cannot be woken");
    const open = this.readCohorts();
    const wanted = new Set(ids);
    const same = open.find(
      (each) => each.subscriberSessionId === subscriberSessionId && !each.ready && each.members.length === wanted.size && each.members.every((member) => wanted.has(member.sessionId)),
    );
    if (same) return { ...structuredClone(same), alreadySubscribed: true };
    const at = this.kernel.now();
    const members = ids.map((id) => {
      const target = this.host.require(id);
      if (target.state !== "active") throw new EngineStateError("conflict", `session ${id} is archived and will do nothing worth waiting for`);
      return this.cohortMemberAtStart(subscriberSessionId, target, at);
    });
    const movedFrom: string[] = [];
    const all = open.flatMap((each) => {
      if (each.subscriberSessionId !== subscriberSessionId || each.ready || !each.members.some((member) => wanted.has(member.sessionId))) return [each];
      movedFrom.push(each.id);
      const rest = each.members.filter((member) => !wanted.has(member.sessionId));
      return rest.length > 0 ? [{ ...each, members: rest }] : [];
    });
    const mine = all.filter((each) => each.subscriberSessionId === subscriberSessionId).length;
    if (mine >= MAX_COHORTS_PER_SESSION) {
      throw new EngineStateError("conflict", `this session already has ${mine} cohorts open, the most it may. Unsubscribe from ones you are finished with.`);
    }
    const cohort: Cohort = {
      id: `coh_${crypto.randomUUID().replaceAll("-", "")}`,
      subscriberSessionId,
      members,
      ...(input.completionWake ? { completionWake: input.completionWake } : {}),
      createdAt: at,
      expiresAt: at + minutes * 60_000,
    };
    this.writeCohorts([...all, cohort]);
    // An older cohort left with only finished members is done now.
    this.closeDoneCohorts([...movedFrom, cohort.id]);
    return { ...structuredClone(cohort), ...(movedFrom.length > 0 ? { movedFrom } : {}) };
  }

  cohortsFor(subscriberSessionId: string): Cohort[] {
    this.host.require(subscriberSessionId);
    return structuredClone(this.readCohorts().filter((each) => each.subscriberSessionId === subscriberSessionId));
  }

  readCohorts(): Cohort[] {
    const stored = this.kernel.readDocument(this.kernel.paths.cohorts) as { cohorts?: unknown } | undefined;
    const parsed = CohortSchema.array().safeParse(stored?.cohorts ?? []);
    return parsed.success ? parsed.data : [];
  }

  private writeCohorts(cohorts: Cohort[]): void {
    this.subscriptionsBySubscriber = undefined;
    this.kernel.writeDocument(this.kernel.paths.cohorts, { version: STATE_VERSION, cohorts });
  }

  /** A member as the cohort first sees it: pending, unless it is already done. */
  private cohortMemberAtStart(subscriberSessionId: string, target: Session, at: number): CohortMember {
    const base: CohortMember = { sessionId: target.id, ...(target.title ? { title: target.title.slice(0, 200) } : {}) };
    if (target.settledOverride === "settled") return { ...base, outcome: "settled", at };
    const turns = this.host.turnsOf(target.id).filter((turn) => turn.agentDelivery !== "passive");
    const last = turns.at(-1);
    if (!last || !["completed", "failed", "stopped"].includes(last.state)) return base;
    // Idle — but on whose errand? Only one this subscriber gave counts.
    const errand = turns.filter((turn) => turn.sender?.sessionId === subscriberSessionId).at(-1);
    if (!errand) return base;
    const said = this.host.turnsOf(subscriberSessionId).filter(
      (turn) => turn.sender?.sessionId === target.id && turn.acceptedAt >= errand.acceptedAt && (turn.agentIntent === "result" || turn.agentIntent === "blocker"),
    ).at(-1);
    if (said?.agentIntent === "blocker") return { ...base, blocked: true };
    if (said) return { ...base, outcome: "result", fetch: { sessionId: subscriberSessionId, runId: said.runId }, firstLine: firstLineOf(said.input), ...excerptOf(said.input), at };
    // A turn that merely completed is not the errand's end; only its result is.
    // Nor is one a restart cut off: it was not stopped, it was interrupted.
    if (last.state === "completed" || cutOffByTelar(last)) return base;
    const kind: WakeKind = last.state === "failed" ? "turn_failed" : "turn_stopped";
    return { ...base, ...this.cohortOutcome(target.id, kind, last, { ...(last.resultText ? { resultText: last.resultText } : {}), ...(last.failure ? { failure: last.failure } : {}) }), at };
  }

  private cohortOutcome(sessionId: string, kind: WakeKind, turn: Turn, context: { resultText?: string; failure?: Turn["failure"] }): Pick<CohortMember, "outcome" | "fetch" | "firstLine" | "excerpt" | "chars"> {
    const outcome = kind === "turn_completed" ? "completed" : kind === "turn_failed" ? "failed" : "stopped";
    const text = kind === "turn_failed" ? [context.failure?.code, context.failure?.message].filter(Boolean).join(": ") : context.resultText ?? "";
    const line = firstLineOf(text);
    return { outcome, fetch: { sessionId, runId: turn.runId }, ...(line ? { firstLine: line } : {}), ...excerptOf(text) };
  }

  /**
   * Done is the errand's end, not a turn's: on an errand this subscriber gave it, a member is done by its `result`,
   * a failed or stopped turn, or being put away. Otherwise any turn's end counts, but never a background-task turn.
   */
  advanceCohortMember(sessionId: string, kind: WakeKind, turn: Turn, context: { resultText?: string; failure?: Turn["failure"] }): void {
    if (!TERMINAL_WAKE_KINDS.includes(kind)) return;
    if (turn.origin === "provider" && turn.providerReason?.kind === "background_task") return;
    // A worker shutting down fails its turn as `interrupted`; the member stays pending.
    if (cutOffByTelar(turn)) return;
    const completed = kind === "turn_completed";
    const errandFrom = new Map<string, boolean>();
    const onErrand = (subscriberSessionId: string): boolean => {
      if (!errandFrom.has(subscriberSessionId)) {
        errandFrom.set(
          subscriberSessionId,
          this.host.turnsOf(sessionId).some((each) => each.agentDelivery !== "passive" && each.sender?.sessionId === subscriberSessionId),
        );
      }
      return errandFrom.get(subscriberSessionId)!;
    };
    this.updateCohortMembers(sessionId, undefined, (member, subscriberSessionId) => {
      if (member.outcome) return undefined;
      if (completed && (member.blocked || onErrand(subscriberSessionId))) return undefined;
      const { blocked: _ended, ...rest } = member;
      return { ...rest, ...this.cohortOutcome(sessionId, kind, turn, context), at: this.kernel.now() };
    });
  }

  /** Does an open cohort `subscriberSessionId` holds still take `memberSessionId`'s result? */
  cohortHolds(subscriberSessionId: string, memberSessionId: string): boolean {
    return this.readCohorts().some(
      (cohort) =>
        !cohort.ready &&
        cohort.subscriberSessionId === subscriberSessionId &&
        cohort.members.some((member) => member.sessionId === memberSessionId && (!member.outcome || member.outcome === "result")),
    );
  }

  /**
   * From a member, a `result` makes it done and a `blocker` holds it pending until answered;
   * from the subscriber to a member, that answer releases the blocker.
   */
  recordCohortMessage(recipientSessionId: string, senderSessionId: string, intent: NonNullable<Turn["agentIntent"]>, runId: string, body: string): void {
    if (intent === "result") {
      const line = firstLineOf(body);
      this.updateCohortMembers(senderSessionId, recipientSessionId, (member) =>
        member.outcome && member.outcome !== "result"
          ? undefined
          : { sessionId: member.sessionId, ...(member.title ? { title: member.title } : {}), outcome: "result", fetch: { sessionId: recipientSessionId, runId }, ...(line ? { firstLine: line } : {}), ...excerptOf(body), at: this.kernel.now() },
      );
    } else if (intent === "blocker") {
      this.updateCohortMembers(senderSessionId, recipientSessionId, (member) => (member.outcome || member.blocked ? undefined : { ...member, blocked: true }));
    }
    this.updateCohortMembers(recipientSessionId, senderSessionId, (member) => {
      if (!member.blocked) return undefined;
      const { blocked: _answered, ...rest } = member;
      return rest;
    });
  }

  /** Rewrites every matching member (`update` returns undefined to leave one alone), then delivers the cohorts now complete. */
  private updateCohortMembers(
    memberSessionId: string,
    subscriberSessionId: string | undefined,
    update: (member: CohortMember, subscriberSessionId: string) => CohortMember | undefined,
  ): void {
    const all = this.readCohorts();
    const touched: string[] = [];
    for (const cohort of all) {
      if (cohort.ready || (subscriberSessionId !== undefined && cohort.subscriberSessionId !== subscriberSessionId)) continue;
      cohort.members = cohort.members.map((member) => {
        if (member.sessionId !== memberSessionId) return member;
        const next = update(member, cohort.subscriberSessionId);
        if (!next) return member;
        touched.push(cohort.id);
        return next;
      });
    }
    if (touched.length === 0) return;
    this.writeCohorts(all);
    this.closeDoneCohorts(touched);
  }

  /** A member put away (settled, archived, deleted) is done; a subscriber put away takes its cohorts with it. */
  reviewCohorts(): void {
    const all = this.readCohorts();
    if (all.length === 0) return;
    const at = this.kernel.now();
    const touched: string[] = [];
    const kept = all.filter((cohort) => {
      const subscriber = this.host.find(cohort.subscriberSessionId);
      if (!subscriber || subscriber.state !== "active") return false;
      cohort.members = cohort.members.map((member) => {
        if (member.outcome) return member;
        const session = this.host.find(member.sessionId);
        const outcome = !session ? "deleted" : session.state !== "active" ? "archived" : session.settledOverride === "settled" ? "settled" : undefined;
        if (!outcome) return member;
        touched.push(cohort.id);
        return { ...member, outcome, at };
      });
      return true;
    });
    if (touched.length === 0 && kept.length === all.length) return;
    this.writeCohorts(kept);
    this.closeDoneCohorts(touched);
  }

  /** Deliver each named cohort whose every member is done. */
  private closeDoneCohorts(ids: string[]): void {
    for (const cohort of this.readCohorts()) {
      if (!ids.includes(cohort.id) || cohort.ready) continue;
      if (cohort.members.every((member) => member.outcome)) this.closeCohort(cohort, "all");
    }
  }

  /**
   * Delivers one cohort as one notification. Under `settled_only` (the default) a subscriber mid-turn is not
   * interrupted: the cohort is marked `ready` and delivered, as its own turn, when that turn ends.
   */
  private closeCohort(cohort: Cohort, reason: "all" | "expired"): void {
    const subscriberId = cohort.subscriberSessionId;
    const remaining = this.readCohorts().filter((each) => each.id !== cohort.id);
    const subscriber = this.host.find(subscriberId);
    if (!subscriber || subscriber.state !== "active") {
      this.writeCohorts(remaining);
      return;
    }
    if ((cohort.completionWake ?? "settled_only") === "settled_only" && this.host.hasLiveTurn(subscriberId)) {
      this.writeCohorts([...remaining, { ...cohort, ready: reason }]);
      return;
    }
    this.writeCohorts(remaining);
    // Never the same ending twice: a (session, run) an earlier cohort notice already named is left out.
    const told = this.cohortEndingsDeliveredTo(subscriberId);
    const fresh = cohort.members.filter((member) => !(member.outcome && member.fetch && told.has(`${member.sessionId} ${member.fetch.runId}`)));
    if (fresh.length === 0) return;
    const members = fresh.map((member) => {
      if (member.fetch) return member;
      // A member with no read of its own is given its latest turn, if it has one.
      const latest = this.host.find(member.sessionId) ? this.host.turnsOf(member.sessionId).at(-1) : undefined;
      return latest ? { ...member, fetch: { sessionId: member.sessionId, runId: latest.runId } } : member;
    });
    const notification: NotificationDetail = {
      ...cohortNotification({
        cohortId: cohort.id,
        openedAt: cohort.createdAt,
        members,
        reason,
        minutes: Math.round((cohort.expiresAt - cohort.createdAt) / 60_000),
        // Only when no member has a turn at all — the cohort's own id, which
        // names what this is even though no run carries it.
        fallbackFetch: { sessionId: members[0]!.sessionId, runId: cohort.id },
      }),
      deliveries: 1,
    };
    try {
      this.host.submitTurn(subscriberId, {
        runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
        input: notificationLabel(notification),
        origin: "session",
        wakeReason: {
          kind: notification.wakeKind!,
          sessionId: notification.sessionId!,
          ...(notification.runId ? { runId: notification.runId } : {}),
        },
        notification,
      });
    } catch (error) {
      if (!(error instanceof EngineStateError && error.code === "conflict")) throw error;
      this.host.warn(subscriberId, `cohort ${cohort.id} could not be delivered: ${error.message}`);
    }
  }

  /** Every "session run" a cohort notice on this subscriber has already named. */
  private cohortEndingsDeliveredTo(subscriberId: string): Set<string> {
    const told = new Set<string>();
    for (const turn of this.host.turnsOf(subscriberId)) {
      if (!turn.notification?.cohortId) continue;
      for (const entry of turn.notification.entries ?? []) if (entry.runId) told.add(`${entry.sessionId} ${entry.runId}`);
    }
    return told;
  }

  /** The subscriber came up for air: deliver the cohorts that closed meanwhile. */
  deliverReadyCohorts(subscriberId: string): void {
    const ready = this.readCohorts().filter((cohort) => cohort.subscriberSessionId === subscriberId && cohort.ready);
    for (const cohort of ready) this.closeCohort({ ...cohort, ready: undefined }, cohort.ready!);
  }

  /** Every cohort past its expiry, delivered with what it has; also where a member put away unseen is noticed. */
  sweepCohorts(): string[] {
    this.reviewCohorts();
    const now = this.kernel.now();
    const closed: string[] = [];
    for (const cohort of this.readCohorts()) {
      if (cohort.ready) {
        if (!this.host.hasLiveTurn(cohort.subscriberSessionId)) {
          this.closeCohort({ ...cohort, ready: undefined }, cohort.ready);
          closed.push(cohort.id);
        }
        continue;
      }
      if (now < cohort.expiresAt) continue;
      this.closeCohort(cohort, "expired");
      closed.push(cohort.id);
    }
    return closed;
  }
}
