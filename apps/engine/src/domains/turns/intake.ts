import {
  assignmentsOf,
  PROVIDER_CAPABILITIES,
  type AssignmentTurn,
  seedSessionTitle,
  turnHasContent,
  type Item,
  type NotificationDetail,
  type Project,
  type Session,
  type Turn,
  type TurnModelSelection,
  type WakeReason,
} from "@telar/engine-client";
import type { GitRunner } from "../../platform/git/runner";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import type { ProjectAvailability } from "../../platform/fs/volumes";
import {
  ACTIVE_TURN_STATES,
  sessionMetadataFile,
  storedSession,
  type SessionAttachments,
  type SessionItems,
  type SessionMailbox,
  type SessionQueue,
  type SessionRecords,
} from "../sessions";
import type { prepareSessionWorktree, WorktreePlan } from "../worktrees";
import { MAX_DELIVERIES, mergeNotifications, peerNotification } from "./notification";

export const MAX_TEXT_LENGTH = 200_000;
// A runaway-client guard: a retry loop minting fresh run ids would otherwise grow a queue rewritten whole on every transition.
const MAX_QUEUED_TURNS = 16;
// Per turn, so one message cannot carry 16 × 20 MB past the per-file cap.
const MAX_TURN_ATTACHMENTS = 16;
/** The intents that speak for the run that sent them — see `messageDeliveredTo`. */
export const FOLDING_INTENTS: ReadonlySet<NonNullable<Turn["agentIntent"]>> = new Set(["report", "result", "blocker"]);

function assertText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new EngineStateError("invalid_request", "turn text must be non-empty and within the allowed size");
  }
}

export type SenderProof = { sessionId: string; runId: string; claimToken: string };

export type TurnSubmission = {
  runId: string;
  input: string;
  kind?: "message" | "compact";
  model?: TurnModelSelection;
  attachments?: string[];
  /** `origin: "session"` needs exactly one of `wakeReason` (set by `fireSubscriptions`) or `sender` (set by `submitAgentTurn`); no route reads either from a body. */
  agentIntent?: Turn["agentIntent"];
  agentDelivery?: Turn["agentDelivery"];
  /** A passive message whose notification was folded into a wake still waiting in the queue. Not mail. */
  foldedIntoWaitingWake?: boolean;
  agentSourceRunId?: string;
  corrects?: string;
  /** The short line the model reads in place of `input`; minted by `submitAgentTurn` only. */
  agentNotice?: string;
  /** Makes the engine write a `notification` item and the drivers deliver off the user channel. */
  notification?: NotificationDetail;
  assignmentScope?: string;
  origin?: "session" | "schedule" | "restart";
  wakeReason?: WakeReason;
  sender?: { sessionId?: string };
  scheduleOrigin?: { scheduleId: string; dueAt: number };
  restartOrigin?: NonNullable<Turn["restartOrigin"]>;
};

type IntakeDeps = {
  records: SessionRecords;
  items: SessionItems;
  mailbox: SessionMailbox;
  attachments: SessionAttachments;
  git: GitRunner;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  getProject: (projectId: string) => Project;
  availability: (project: Project) => ProjectAvailability;
  assertProjectAvailable: (projectId: string) => void;
  restoreWorktree: (sessionId: string) => void;
  prepareWorktree: (sessionId: string, projectRoot: string, plan: WorktreePlan, baseSha: string) => void;
  // Injected rather than imported: the worktrees domain reaches agent-tools, which reads the sessions index at load.
  planWorktree: typeof prepareSessionWorktree;
  derivedBranchFor: (title: string, sessionId: string) => string | undefined;
  promoteTurn: (sessionId: string, runId: string) => Turn;
  requireSenderClaim: (proof: SenderProof) => { sessionId: string };
  hasLiveTurn: (sessionId: string) => boolean;
  waitingNotificationTurn: (sessionId: string) => string | undefined;
  joinWaitingNotification: (sessionId: string, waitingRunId: string, notification: NotificationDetail) => void;
  rewriteNotificationItem: (sessionId: string, turn: Turn) => void;
  waitingSubscription: (subscriberSessionId: string, targetSessionId: string) => boolean;
  cohortHolds: (sessionId: string, senderSessionId: string) => boolean;
  recordCohortMessage: (sessionId: string, senderSessionId: string, intent: NonNullable<Turn["agentIntent"]>, runId: string, text: string) => void;
};

/** Accepting a message into a session's queue: a person's, an agent's, a wake or a schedule's. */
export class TurnIntake {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: IntakeDeps,
  ) {}

  /** Idempotent on `runId`. Steers into a running turn when the provider can take it live. */
  submitTurn(sessionId: string, input: TurnSubmission): { turn: Turn; replayed: boolean } {
    return this.kernel.command("submitTurn", () => {
      validateSubmission(input);
      const kind = input.kind === "compact" ? "compact" : undefined;
      const session = this.deps.records.get(sessionId);
      // A message to a released session brings its checkout back; the turn waits on `preparing`.
      if (session.workspace.mode === "worktree" && session.workspace.released) this.deps.restoreWorktree(sessionId);
      if (kind === "compact" && !PROVIDER_CAPABILITIES[session.driver].compaction)
        throw new EngineStateError("conflict", "this provider does not support manual compaction");
      const queue = this.deps.readQueue(sessionId);
      const known = queue.turns.find((turn) => turn.runId === input.runId);
      if (known) {
        if (known.input !== input.input) throw new EngineStateError("conflict", "run id was already submitted with different text");
        return { turn: structuredClone(known), replayed: true };
      }
      if (input.origin === "session" && session.agentMessagesBlocked) {
        throw new EngineStateError("conflict", "this session was stopped by its user; agent messages cannot restart it. Wait for a new human message.");
      }
      if (session.projectId !== undefined) this.deps.assertProjectAvailable(session.projectId);
      const passive = input.origin === "session" && input.agentDelivery === "passive";
      const queued = queue.turns.filter((turn) => turn.state === "queued" || turn.state === "steering").length;
      if (!passive && queued >= MAX_QUEUED_TURNS) {
        throw new EngineStateError("conflict", "session already has the maximum number of queued turns");
      }
      if (kind === "compact" && queue.turns.some((turn) => turn.kind === "compact" && ACTIVE_TURN_STATES.has(turn.state))) {
        throw new EngineStateError("conflict", "a compaction is already queued or running on this session");
      }
      const at = this.kernel.now();
      const turn = this.buildTurn(sessionId, session, queue, input, { kind, passive, at });
      if (!turnHasContent(turn.input, (turn.attachments ?? []).map((attachment) => attachment.mediaType))) {
        throw new EngineStateError("invalid_request", "a message needs text or an image");
      }
      if (session.draft) this.promoteDraft(sessionId, session, turn, input.input, kind, at);
      if (session.paused && !passive) turn.held = { at, reason: "session_paused" };
      if (input.origin !== "session" && input.origin !== "restart" && kind !== "compact" && session.agentMessagesBlocked) {
        delete session.agentMessagesBlocked;
        delete session.agentMessagesBlockedAt;
        this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
      }
      queue.turns.push(turn);
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      // Queueing a message lifts any shelf or snooze the session was under.
      if (!passive) this.deps.records.wakeForNewWork(sessionId);
      this.kernel.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
      if (passive) {
        if (turn.notification) this.writeNotificationItem(sessionId, turn);
        if (turn.notification && !turn.wakeReason && !input.foldedIntoWaitingWake) this.deps.mailbox.hold(sessionId, turn.notification);
        this.kernel.appendEvent(sessionId, { type: "turn.completed", resultText: "" }, turn.runId);
        return { turn: structuredClone(turn), replayed: false };
      }
      // A compaction is a gesture on the session, not words for the running model; it always waits its turn.
      const interrupts = turn.origin !== "session" || turn.agentIntent === "task" || turn.agentIntent === "blocker";
      if (kind !== "compact" && interrupts && !session.paused && PROVIDER_CAPABILITIES[session.driver].liveSteering) {
        const steered = this.steerIfRunning(sessionId, turn.runId);
        if (steered) return { turn: steered, replayed: false };
      }
      if (turn.notification) this.writeNotificationItem(sessionId, turn);
      return { turn: structuredClone(turn), replayed: false };
    });
  }

  /**
   * A direct message from an agent. The sender is proven by a live claim, never declared;
   * without proof it is still an agent's, unattributed, and never recorded as the person's.
   */
  submitAgentTurn(
    sessionId: string,
    input: { runId: string; input: string; attachments?: string[]; intent?: Turn["agentIntent"]; scope?: string; corrects?: string },
    proof?: SenderProof,
  ): { turn: Turn; replayed: boolean } {
    return this.kernel.command("submitAgentTurn", () => {
      let sender: { sessionId?: string } = {};
      if (proof) {
        assertId(proof.sessionId, "sender session id");
        const claimed = this.deps.requireSenderClaim(proof);
        sender = { sessionId: claimed.sessionId };
      }
      const intent = input.intent ?? "report";
      if ((intent === "result" || intent === "blocker") && sender.sessionId) this.assertAnswersAnAssignment(sessionId, sender.sessionId, intent);
      const waiting = intent === "result" && sender.sessionId ? this.deps.waitingSubscription(sessionId, sender.sessionId) : false;
      const correction = input.corrects && !this.deps.readQueue(sessionId).turns.some((turn) => turn.runId === input.runId)
        ? this.correctionOf(sessionId, input.corrects, sender.sessionId)
        : undefined;
      const cohortHeld = intent === "result" && sender.sessionId !== undefined && this.deps.cohortHolds(sessionId, sender.sessionId);
      const delivery = !cohortHeld && (intent === "task" || intent === "blocker" || waiting || correction === "read" || correction === "queued")
        ? "wake"
        : "passive";
      const scope = intent === "task" ? input.scope : undefined;
      const notification = peerNotification({
        recipientSessionId: sessionId, runId: input.runId, body: input.input, intent,
        ...(input.corrects ? { corrects: input.corrects } : {}),
        ...(sender.sessionId ? { sender } : {}),
        ...(scope ? { scope } : {}),
      });
      // Not for a correction: it replaces an earlier message rather than joining it.
      const folds = !correction && delivery === "wake" && proof && sender.sessionId && FOLDING_INTENTS.has(intent)
        ? this.waitingMessageFrom(sessionId, sender.sessionId, proof.runId, input.runId)
        : undefined;
      const joins = !folds && !correction && delivery === "wake" && FOLDING_INTENTS.has(intent) && !this.deps.hasLiveTurn(sessionId) &&
        !this.deps.readQueue(sessionId).turns.some((turn) => turn.runId === input.runId)
        ? this.deps.waitingNotificationTurn(sessionId)
        : undefined;
      const result = this.submitTurn(sessionId, {
        ...(folds || joins || cohortHeld ? { foldedIntoWaitingWake: true } : {}),
        runId: input.runId,
        input: input.input,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        origin: "session", sender, agentIntent: intent, agentDelivery: folds || joins ? "passive" : delivery,
        ...(proof ? { agentSourceRunId: proof.runId } : {}),
        ...(input.corrects ? { corrects: input.corrects } : {}),
        notification,
        agentNotice: notification.body,
        // Only a task carries a scope; a report that named one would read as an assignment.
        ...(scope ? { assignmentScope: scope } : {}),
      });
      if (folds && !result.replayed) this.foldIntoWaitingMessage(sessionId, folds, notification);
      if (joins && !result.replayed) this.deps.joinWaitingNotification(sessionId, joins, notification);
      if (!result.replayed && sender.sessionId) this.deps.recordCohortMessage(sessionId, sender.sessionId, intent, input.runId, input.input);
      // The unread version goes only once its replacement is safely accepted.
      if (correction === "queued" || correction === "held") this.withdrawCorrected(sessionId, input.corrects!, correction);
      return result;
    });
  }

  private assertAnswersAnAssignment(recipientSessionId: string, senderSessionId: string, intent: "result" | "blocker"): void {
    const assigners = [...new Set(assignmentsOf(this.deps.readQueue(senderSessionId).turns as AssignmentTurn[]).map((each) => each.fromSessionId))];
    if (assigners.length === 0 || assigners.includes(recipientSessionId)) return;
    throw new EngineStateError(
      "conflict",
      `${recipientSessionId} never assigned you work, so it cannot take your ${intent}. Send it to the session that assigned the work you are answering (${assigners.join(", ")}), or send ${recipientSessionId} a report.`,
    );
  }

  /** The notification's row, written by the engine at accept and closed at once: it is what arrived, true before any worker claims it. */
  writeNotificationItem(sessionId: string, turn: Turn): void {
    const detail = turn.notification;
    if (!detail) return;
    const at = this.kernel.now();
    const items = this.deps.items.read(sessionId);
    const item: Item = {
      // Derived from the run, since `submitTurn` is idempotent on it and a replay must not add a second row.
      id: `notification_${turn.runId}`,
      runId: turn.runId,
      sessionId,
      status: "completed",
      title: detail.summary,
      detail: { type: "notification", notification: detail },
      startedAt: at,
      completedAt: at,
    };
    if (items.has(item.id)) return;
    items.set(item.id, item);
    this.deps.items.write(sessionId, items, new Set([item.id]));
    this.kernel.appendEvent(sessionId, { type: "item.started", item }, turn.runId);
    this.kernel.appendEvent(sessionId, { type: "item.completed", item }, turn.runId);
  }

  private buildTurn(
    sessionId: string,
    session: Session,
    queue: SessionQueue,
    input: TurnSubmission,
    at: { kind: "compact" | undefined; passive: boolean; at: number },
  ): Turn {
    const { kind, passive } = at;
    return {
      runId: input.runId,
      sessionId,
      sequence: queue.nextSequence++,
      input: input.input,
      ...(kind ? { kind } : {}),
      ...(input.origin === "session" && input.wakeReason ? { origin: "session" as const, wakeReason: input.wakeReason } : {}),
      ...(input.origin === "session" && input.sender
        ? { origin: "session" as const, sender: input.sender.sessionId ? { sessionId: input.sender.sessionId } : {} }
        : {}),
      ...(input.origin === "schedule" && input.scheduleOrigin ? { origin: "schedule" as const, scheduleOrigin: input.scheduleOrigin } : {}),
      ...(input.origin === "restart" && input.restartOrigin ? { origin: "restart" as const, restartOrigin: input.restartOrigin } : {}),
      ...(input.agentIntent ? { agentIntent: input.agentIntent } : {}),
      ...(input.agentDelivery ? { agentDelivery: input.agentDelivery } : {}),
      ...(input.agentSourceRunId ? { agentSourceRunId: input.agentSourceRunId } : {}),
      ...(input.corrects ? { corrects: input.corrects } : {}),
      ...(input.agentNotice ? { agentNotice: input.agentNotice } : {}),
      ...(input.notification ? { notification: input.notification } : {}),
      ...(input.assignmentScope ? { assignmentScope: input.assignmentScope } : {}),
      ...(passive ? { completedAt: at.at, resultText: "" } : {}),
      state: passive ? "completed" : "queued",
      acceptedAt: at.at,
      updatedAt: at.at,
      ...this.resolveAttachments(sessionId, input.attachments ?? []),
      ...(input.model
        ? {
            model: {
              instanceId: session.providerInstanceId,
              ...(input.model.model ? { model: input.model.model } : {}),
              ...(input.model.effort ? { effort: input.model.effort } : {}),
              ...(input.model.fastMode === undefined ? {} : { fastMode: input.model.fastMode }),
              ...(input.model.serviceTier ? { serviceTier: input.model.serviceTier } : {}),
              ...(input.model.ultracode === undefined ? {} : { ultracode: input.model.ultracode }),
            },
          }
        : {}),
    };
  }

  private resolveAttachments(sessionId: string, ids: string[]): Pick<Turn, "attachments"> {
    if (ids.length === 0) return {};
    if (ids.length > MAX_TURN_ATTACHMENTS) throw new EngineStateError("invalid_request", "too many attachments on one turn");
    const index = this.deps.attachments.index(sessionId);
    const attachments = ids.map((id) => {
      const found = index.get(id);
      // Loud rather than silent: "look at this" arriving with nothing attached is worse than a failed send.
      if (!found) throw new EngineStateError("not_found", "attachment does not exist on this session");
      return found;
    });
    return { attachments };
  }

  // The first message turns a draft into a session: its worktree is planned now and cut after the document is written.
  private promoteDraft(sessionId: string, session: Session, turn: Turn, text: string, kind: "compact" | undefined, at: number): void {
    const draft = session.draft!;
    let cut: { projectRoot: string; plan: WorktreePlan; baseSha: string } | undefined;
    if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
    if (kind === "compact") throw new EngineStateError("conflict", "a browser draft has no conversation to compact");
    if (session.envMode === "worktree") {
      if (!session.projectId) throw new EngineStateError("conflict", "a worktree draft requires a project");
      const project = this.deps.getProject(session.projectId);
      const planned = this.deps.planWorktree(this.deps.git, {
        engineRoot: this.kernel.paths.root, projectRoot: project.root, projectName: project.name, sessionId,
        // The send already went through `assertProjectAvailable`; this is that reading, not a second one.
        availability: this.deps.availability(project),
        branchSlug: draft.branchSlug ?? this.deps.derivedBranchFor(text, sessionId),
        ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
        ...(draft.branchName ? { branchName: draft.branchName } : {}),
      });
      session.workspace = { mode: "worktree", path: planned.plan.path, branch: planned.plan.branch, baseRef: planned.baseSha };
      session.preparation = { state: "preparing", at };
      cut = { projectRoot: project.root, ...planned };
    }
    if (session.title === "Browser draft") {
      const images = (turn.attachments ?? []).filter((attachment) => attachment.mediaType.startsWith("image/"));
      session.title = seedSessionTitle(text, images.map((attachment) => attachment.name)) || session.title;
    }
    delete session.draft;
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
    if (cut) this.deps.prepareWorktree(sessionId, cut.projectRoot, cut.plan, cut.baseSha);
  }

  /** Where a corrected message stands for this recipient; refused when it names nothing this sender sent here. */
  private correctionOf(sessionId: string, correctedRunId: string, senderSessionId: string | undefined): "queued" | "held" | "read" {
    const corrected = this.deps.readQueue(sessionId).turns.find((turn) => turn.runId === correctedRunId);
    if (!corrected || corrected.origin !== "session" || !senderSessionId || corrected.sender?.sessionId !== senderSessionId || corrected.notification?.kind !== "peer_message") {
      throw new EngineStateError("invalid_request", `corrects must name an earlier message you sent to this session; ${correctedRunId} is not one`);
    }
    if (corrected.state === "queued") return "queued";
    const held = this.deps.mailbox.pending(sessionId).some((each) => each.kind === "peer_message" && each.runId === correctedRunId);
    return corrected.agentDelivery === "passive" && held ? "held" : "read";
  }

  /** A queued wake is discarded (its body stays readable on the turn); a held one leaves the mailbox. */
  private withdrawCorrected(sessionId: string, correctedRunId: string, where: "queued" | "held"): void {
    if (where === "held") {
      this.deps.mailbox.withdrawPeer(sessionId, correctedRunId);
      return;
    }
    const queue = this.deps.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === correctedRunId && candidate.state === "queued");
    if (!turn) return;
    const at = this.kernel.now();
    turn.state = "discarded";
    turn.completedAt = at;
    turn.updatedAt = at;
    this.deps.writeQueue(sessionId, queue);
    this.deps.records.touch(sessionId, at);
    this.kernel.appendEvent(sessionId, { type: "turn.discarded" }, turn.runId);
  }

  /** The queued, unread wake an earlier message from this same run waits in; past the delivery cap, none. */
  private waitingMessageFrom(sessionId: string, senderSessionId: string, sourceRunId: string, runId: string): string | undefined {
    const turns = this.deps.readQueue(sessionId).turns;
    // The same run id again is a retried call, not a second message.
    if (turns.some((candidate) => candidate.runId === runId)) return undefined;
    const waiting = turns.find(
      (candidate) =>
        candidate.state === "queued" &&
        !candidate.held &&
        candidate.origin === "session" &&
        !candidate.wakeReason &&
        candidate.notification?.kind === "peer_message" &&
        candidate.agentIntent !== undefined &&
        FOLDING_INTENTS.has(candidate.agentIntent) &&
        candidate.sender?.sessionId === senderSessionId &&
        candidate.agentSourceRunId === sourceRunId,
    );
    if (!waiting?.notification) return undefined;
    return (waiting.notification.deliveries ?? 1) + 1 > MAX_DELIVERIES ? undefined : waiting.runId;
  }

  private foldIntoWaitingMessage(sessionId: string, waitingRunId: string, notification: NotificationDetail): void {
    const queue = this.deps.readQueue(sessionId);
    const waiting = queue.turns.find((candidate) => candidate.runId === waitingRunId);
    if (!waiting?.notification || waiting.state !== "queued") return;
    const at = this.kernel.now();
    const merged: NotificationDetail = { ...mergeNotifications([waiting.notification, notification]), deliveries: (waiting.notification.deliveries ?? 1) + 1 };
    waiting.notification = merged;
    waiting.agentNotice = merged.body;
    waiting.updatedAt = at;
    this.deps.writeQueue(sessionId, queue);
    this.deps.records.touch(sessionId, at);
    this.deps.rewriteNotificationItem(sessionId, waiting);
    this.kernel.appendEvent(sessionId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
  }

  // `promoteTurn`'s conflicts are exactly the cases that fall back to `queued`, so only they are swallowed.
  private steerIfRunning(sessionId: string, runId: string): Turn | undefined {
    const running = this.deps.readQueue(sessionId).turns.some((candidate) => candidate.state === "running" && candidate.claim);
    if (!running) return undefined;
    try {
      return this.deps.promoteTurn(sessionId, runId);
    } catch (error) {
      if (error instanceof EngineStateError && error.code === "conflict") return undefined;
      throw error;
    }
  }
}

function validateSubmission(input: TurnSubmission): void {
  assertId(input.runId, "run id");
  // A blank message with attachments is judged later, once their types are known.
  const blankWithFiles =
    typeof input.input === "string" && input.input.trim() === "" && input.kind !== "compact" && (input.attachments?.length ?? 0) > 0;
  if (!blankWithFiles) assertText(input.input);
  const companions =
    Number(input.wakeReason !== undefined) +
    Number(input.sender !== undefined) +
    Number(input.scheduleOrigin !== undefined) +
    Number(input.restartOrigin !== undefined);
  const wants = input.origin === "session" || input.origin === "schedule" || input.origin === "restart" ? 1 : 0;
  if (companions !== wants) {
    throw new EngineStateError("invalid_request", "a session- or schedule-origin turn carries exactly one companion, and only such a turn does");
  }
  if (input.origin === "schedule" && input.scheduleOrigin === undefined) {
    throw new EngineStateError("invalid_request", "a schedule-origin turn names the schedule that started it");
  }
  if (input.origin === "restart" && input.restartOrigin === undefined) {
    throw new EngineStateError("invalid_request", "a restart-origin turn names the restart that started it");
  }
}
