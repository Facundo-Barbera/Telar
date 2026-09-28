import {
  PROVIDER_CAPABILITIES,
  WorkerTurnFailureCode as WorkerTurnFailureCodeSchema,
  type EngineRequest,
  type Turn,
  type TurnFailure,
  type TurnFailureCode,
  type UsageSnapshot,
  type WakeKind,
} from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import { sessionMetadataFile, storedSession, type SessionItems, type SessionQueue, type SessionRecords, type SessionRequests, type SessionTasks } from "../sessions";
import { MAX_TEXT_LENGTH } from "./intake";

const TURN_FAILURE_CODES = new Set<TurnFailureCode>(WorkerTurnFailureCodeSchema.options);

export type StoppedClaim = { sessionId: string; runId: string; claimToken: string; workerId: string };

type LifecycleDeps = {
  records: SessionRecords;
  items: SessionItems;
  tasks: SessionTasks;
  requests: SessionRequests;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  requireRunningClaimFromQueue: (queue: SessionQueue, runId: string, claimToken: string) => Turn;
  assertProjectAvailable: (projectId: string) => void;
  anchorTurn: (sessionId: string, runId: string, side: "before" | "after") => void;
  fireSubscriptions: (sessionId: string, kind: WakeKind, turn: Turn, context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest }) => void;
  flushPendingNotifications: (sessionId: string) => void;
  evaluateDelegationSettling: (sessionId: string) => void;
  stopBackgroundTasks: (sessionId: string) => number;
  announceStoppedClaims: (cancellations: StoppedClaim[]) => void;
};

/** A turn from running to its end: start, complete, fail, stop, steer, release and discard. */
export class TurnLifecycle {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: LifecycleDeps,
  ) {}

  // Messages submitted after the claim (by queue sequence, not clock) steer into the turn once it runs; refusals just wait.
  private promoteClaimWindow(sessionId: string, queue: SessionQueue, running: Turn, at: number): Turn[] {
    const watermark = running.claim?.sequence;
    if (watermark === undefined) return [];
    const promoted: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.state !== "queued" || turn.sequence < watermark) continue;
      try {
        this.promoteInQueue(sessionId, queue, turn, running, at);
      } catch (error) {
        // A refusal is "this one waits", never a failure to start the turn:
        // the message keeps its place in the queue and runs in its own right.
        if (error instanceof EngineStateError && error.code === "conflict") continue;
        throw error;
      }
      promoted.push(turn);
    }
    return promoted;
  }

  markRunning(sessionId: string, runId: string, claimToken: string): Turn {
    return this.kernel.command("markRunning", () => {
      const queue = this.deps.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === runId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
      if (turn.state !== "claimed" || turn.claim?.token !== claimToken) {
        throw new EngineStateError("conflict", "turn is not claimed by this worker");
      }
      const at = this.kernel.now();
      turn.state = "running";
      turn.startedAt = at;
      turn.updatedAt = at;
      const promoted = this.promoteClaimWindow(sessionId, queue, turn, at);
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      // WHERE THE REPOSITORY STANDS AS THIS TURN BEGINS (#741). Dispatched, never
      // awaited — see `anchorTurn` for why this one line may not be a git call.
      this.deps.anchorTurn(sessionId, turn.runId, "before");
      this.kernel.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
      // AFTER `turn.started`, so a client reading the journal in order never sees
      // a message steered into a turn it has not yet been told began.
      for (const late of promoted) this.kernel.appendEvent(sessionId, { type: "turn.steering", intoRunId: turn.runId }, late.runId);
      return structuredClone(turn);
    });
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
  ): Turn {
    return this.kernel.command("completeTurn", () => {
      if (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH) {
        throw new EngineStateError("invalid_request", "final text exceeds the allowed size");
      }
      const queue = this.deps.readQueue(sessionId);
      const turn = this.deps.requireRunningClaimFromQueue(queue, runId, claimToken);
      const at = this.kernel.now();
      turn.state = "completed";
      turn.completedAt = at;
      turn.updatedAt = at;
      turn.resultText = input.text;
      if (input.usage !== undefined) turn.usage = input.usage;
      if (input.providerSessionId !== undefined) {
        if (typeof input.providerSessionId !== "string" || !input.providerSessionId.trim() || input.providerSessionId.length > 4_000) {
          throw new EngineStateError("invalid_request", "provider session id is invalid");
        }
        turn.providerSessionId = input.providerSessionId;
      }
      const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
      this.deps.writeQueue(sessionId, queue);
      // ...and where it stands now it has ended (#741). The pair is what makes
      // `before..after` a range git can be asked about.
      this.deps.anchorTurn(sessionId, turn.runId, "after");
      this.deps.tasks.closeOrphaned(sessionId, turn.runId, at, "the turn ended before this agent reported back");
      this.deps.records.touch(sessionId, at, input.providerSessionId);
      this.kernel.appendEvent(
        sessionId,
        {
          type: "turn.completed",
          resultText: input.text,
          ...(input.usage ? { usage: input.usage } : {}),
          ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
        },
        turn.runId,
      );
      for (const reverted of requeued) this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
      this.deps.fireSubscriptions(sessionId, "turn_completed", turn, { resultText: input.text });
      this.deps.flushPendingNotifications(sessionId);
      // AFTER THE WAKE, NOT BEFORE. A coordinator's turn completing is what makes
      // its wake "consumed", and this session may be that coordinator — see
      // `evaluateDelegationSettling`.
      this.deps.evaluateDelegationSettling(sessionId);
      return structuredClone(turn);
    });
  }

  /** A person resuming a rate-limited turn now: the clock is deliberately not checked, and the project gate applies. */
  resumeRateLimitedTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const session = this.deps.records.get(sessionId);
    if (session.projectId !== undefined) this.deps.assertProjectAvailable(session.projectId);
    const queue = this.deps.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "failed" || turn.failure?.code !== "rate_limited") {
      throw new EngineStateError("conflict", "turn is not waiting for a usage limit");
    }
    // One turn at a time is the engine's own invariant; a resume that produced
    // a second live turn would be the one place it could be broken by a click.
    if (queue.turns.some((candidate) => candidate.state === "claimed" || candidate.state === "running")) {
      throw new EngineStateError("conflict", "the session is already running a turn");
    }
    const at = this.kernel.now();
    turn.state = "queued";
    turn.updatedAt = at;
    // Stamped decided, so the sweep does not consider it again and the session
    // leaves the live index by the ordinary route once this turn settles.
    turn.failure = { ...turn.failure, resumeDecidedAt: at };
    delete turn.completedAt;
    delete turn.claim;
    this.deps.writeQueue(sessionId, queue);
    this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "rate_limit_resumed" }, turn.runId);
    this.deps.records.wakeForNewWork(sessionId);
    this.deps.records.touch(sessionId, at);
    return structuredClone(turn);
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: TurnFailure["code"]; message: string; resumeAt?: number; limitType?: TurnFailure["limitType"] },
  ): Turn {
    return this.kernel.command("failTurn", () => {
      if (!TURN_FAILURE_CODES.has(failure.code) || typeof failure.message !== "string" || !failure.message.trim()) {
        throw new EngineStateError("invalid_request", "turn failure is invalid");
      }
      const resumeAt =
        typeof failure.resumeAt === "number" && Number.isFinite(failure.resumeAt) && failure.resumeAt >= 0
          ? Math.trunc(failure.resumeAt)
          : undefined;
      if (failure.code === "rate_limited" && resumeAt === undefined) {
        throw new EngineStateError("invalid_request", "a rate-limited failure must say when the limit resets");
      }
      const queue = this.deps.readQueue(sessionId);
      const turn = this.deps.requireRunningClaimFromQueue(queue, runId, claimToken);
      const at = this.kernel.now();
      turn.state = "failed";
      turn.completedAt = at;
      turn.updatedAt = at;
      turn.failure = {
        code: failure.code,
        message: failure.message.slice(0, 4_000),
        // Only on the code that means them: a `driver_failed` carrying a reset
        // time would be a row inviting a resume that nothing will ever perform.
        ...(failure.code === "rate_limited" && resumeAt !== undefined ? { resumeAt } : {}),
        ...(failure.code === "rate_limited" && failure.limitType ? { limitType: failure.limitType } : {}),
      };
      const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
      this.deps.anchorTurn(sessionId, turn.runId, "after");
      if (failure.code === "interrupted") {
        for (const reverted of requeued) reverted.held = { at, reason: "engine_restart" };
      }
      this.deps.writeQueue(sessionId, queue);
      // A failed turn means the provider process died — background shells died
      // with it, whichever turn started them.
      this.deps.tasks.closeLive(sessionId, at, "the turn failed before this agent reported back", { includeBackground: true });
      this.deps.items.closeOpen(sessionId, new Set([turn.runId]), at);
      this.deps.requests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
      for (const reverted of requeued) this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
      this.deps.fireSubscriptions(sessionId, "turn_failed", turn, { failure: turn.failure });
      this.deps.flushPendingNotifications(sessionId);
      // A FAILED TURN STILL ENDS ONE. It never makes this session settleable —
      // clause 1 refuses a failed assignment — but the session may be the
      // COORDINATOR whose delegate is now waiting on nothing.
      this.deps.evaluateDelegationSettling(sessionId);
      return structuredClone(turn);
    });
  }

  /** Ends all of a session's work, backlog and background tasks included; a user stop blocks agent messages until a person writes. */
  stopSession(sessionId: string, by: "user" | "agent" = "user"): { stopped: Turn[]; live?: Turn } {
    return this.kernel.command("stopSession", () => {
      const session = this.deps.records.get(sessionId);
      const queue = this.deps.readQueue(sessionId);
      const at = this.kernel.now();
      const live = queue.turns.find((turn) => turn.state === "claimed" || turn.state === "running");
      const stopped = queue.turns.filter((turn) =>
        turn.state === "queued" || turn.state === "claimed" || turn.state === "running" ||
        turn.state === "steering" || turn.state === "ambiguous",
      );
      for (const turn of stopped) {
        turn.state = "stopped";
        turn.stopReason = by;
        turn.completedAt = at;
        turn.updatedAt = at;
        delete turn.steer;
        delete turn.held;
      }
      if (stopped.length > 0) this.deps.writeQueue(sessionId, queue);
      // A peer must not undo a human Stop by immediately sending another turn.
      // A fresh human message clears this gate; no discarded work is replayed.
      if (by === "user") {
        session.agentMessagesBlocked = true;
        session.agentMessagesBlockedAt = at;
        session.updatedAt = at;
        this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
      }
      // Clear a legacy latch only after its backlog has been terminalized.
      if (session.paused) {
        delete session.paused;
        session.updatedAt = at;
        this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
      }
      for (const turn of stopped) {
        this.deps.tasks.closeOrphaned(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
        this.deps.items.closeOpen(sessionId, new Set([turn.runId]), at);
        this.deps.requests.closeOpen(sessionId, new Set([turn.runId]), at);
      }
      // Also runs when no foreground turn exists: a background task outlives
      // its turn, but belongs to the session the user just stopped.
      const backgroundStopped = this.deps.stopBackgroundTasks(sessionId);
      if (stopped.length > 0 || backgroundStopped > 0) this.deps.records.touch(sessionId, at);
      for (const turn of stopped) this.kernel.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
      this.deps.announceStoppedClaims(
        stopped.flatMap((turn) =>
          turn.claim ? [{ sessionId, runId: turn.runId, claimToken: turn.claim.token, workerId: turn.claim.workerId }] : [],
        ),
      );
      // One wake for the live turn, not one per cancelled backlog message.
      if (live) this.deps.fireSubscriptions(sessionId, "turn_stopped", live, {});
      this.deps.flushPendingNotifications(sessionId);
      this.deps.evaluateDelegationSettling(sessionId);
      return { stopped: stopped.map((turn) => structuredClone(turn)), ...(live ? { live: structuredClone(live) } : {}) };
    });
  }

  /** Stops one run; the next queued message is claimed as usual and subscribers are woken. */
  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    return this.kernel.command("stopTurn", () => {
      const queue = this.deps.readQueue(sessionId);
      const turn = requestedRunId
        ? queue.turns.find((candidate) => candidate.runId === requestedRunId)
        : queue.turns.find((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "running");
      if (!turn || turn.state === "stopped" || turn.state === "ambiguous" || (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running")) {
        const swept = this.deps.stopBackgroundTasks(sessionId);
        return { ...(turn ? { turn: structuredClone(turn) } : {}), stopped: swept > 0 };
      }
      const at = this.kernel.now();
      turn.state = "stopped";
      turn.completedAt = at;
      turn.updatedAt = at;
      const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
      this.deps.writeQueue(sessionId, queue);
      // Where the repository stands now this turn has ended (#741). A STOPPED
      // turn is the case the anchor is worth most for: the work ended where it
      // stood, and the range is the only account of it that is not the agent's.
      this.deps.anchorTurn(sessionId, turn.runId, "after");
      this.deps.tasks.closeOrphaned(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
      this.deps.items.closeOpen(sessionId, new Set([turn.runId]), at);
      this.deps.requests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
      for (const reverted of requeued) this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
      this.deps.fireSubscriptions(sessionId, "turn_stopped", turn, {});
      this.deps.flushPendingNotifications(sessionId);
      // A stopped assignment IS finished (clause 1 takes it), so a Stop is one of
      // the moments a delegate can become settleable.
      this.deps.evaluateDelegationSettling(sessionId);
      return { turn: structuredClone(turn), stopped: true };
    });
  }

  // The steering eligibility rules in one place, so `promoteTurn` and `markRunning` cannot disagree. The caller writes the queue.
  private promoteInQueue(sessionId: string, queue: SessionQueue, turn: Turn, running: Turn, at: number): void {
    if (!PROVIDER_CAPABILITIES[this.deps.records.get(sessionId).driver].liveSteering)
      throw new EngineStateError("conflict", "this provider queues follow-up messages until the active turn ends");
    if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be sent now");
    // A HOLD IS SOMEBODY'S DECISION about this message — a pause, or a
    // restart's re-read. Releasing it by steering it would be that decision
    // undoing itself.
    if (turn.held) throw new EngineStateError("conflict", "a held message is not sent until it is released");
    // A compaction is a gesture on the session, not words for the model.
    if (turn.kind === "compact") throw new EngineStateError("conflict", "a compaction always waits its turn");
    if (running.state !== "running" || !running.claim) throw new EngineStateError("conflict", "no turn is running to send this into");
    // AND NOT INTO A COMPACTION EITHER. The target being a compaction turn is
    // the same refusal from the other side: there is no conversation to
    // interrupt, only a context being squeezed.
    if (running.kind === "compact") throw new EngineStateError("conflict", "the provider is compacting its context and cannot take a message right now");
    const compacting = [...this.deps.items.read(sessionId).values()].some(
      (item) => item.runId === running.runId && item.detail.type === "context_compaction" && item.status === "inProgress",
    );
    if (compacting) {
      throw new EngineStateError("conflict", "the provider is compacting its context and cannot take a message right now");
    }
    turn.state = "steering";
    turn.steer = { intoRunId: running.runId, requestedAt: at };
    turn.updatedAt = at;
  }

  /** Sends a queued message into the running turn. A promise of not losing it, never of delivery. */
  promoteTurn(sessionId: string, runId: string): Turn {
    return this.kernel.command("promoteTurn", () => {
      assertId(runId, "run id");
      const queue = this.deps.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === runId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
      // Checked here as well as inside, to keep the refusals in the order this
      // route has always reported them: what you asked for, then what is live.
      if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be sent now");
      const running = queue.turns.find((candidate) => candidate.state === "running" && candidate.claim);
      if (!running) throw new EngineStateError("conflict", "no turn is running to send this into");
      const at = this.kernel.now();
      this.promoteInQueue(sessionId, queue, turn, running, at);
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.steering", intoRunId: running.runId }, turn.runId);
      return structuredClone(turn);
    });
  }

  /** The worker's half of delivery; idempotent, since the provider has the words either way. */
  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Turn {
    return this.kernel.command("ackSteer", () => {
      assertId(steerRunId, "run id");
      const queue = this.deps.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === steerRunId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
      if (turn.state === "steered") return structuredClone(turn);
      if (turn.state !== "steering" || !turn.steer) {
        throw new EngineStateError("conflict", "turn is not being steered");
      }
      const running = queue.turns.find((candidate) => candidate.runId === turn.steer!.intoRunId);
      if (!running || running.state !== "running" || running.claim?.token !== claimToken) {
        throw new EngineStateError("conflict", "the running turn is not held by this claim");
      }
      const at = this.kernel.now();
      turn.state = "steered";
      turn.steer.deliveredAt = at;
      turn.completedAt = at;
      turn.updatedAt = at;
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.steered", intoRunId: turn.steer.intoRunId }, turn.runId);
      return structuredClone(turn);
    });
  }

  /** Every terminal transition calls this: a steer still pointing at the turn was never delivered and queues again. */
  requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    const reverted: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.state !== "steering" || turn.steer?.intoRunId !== runId) continue;
      turn.state = "queued";
      delete turn.steer;
      turn.updatedAt = at;
      reverted.push(turn);
    }
    return reverted;
  }

  /** Runs a held message: clears the flag, and the claim path takes it from its original place in the queue. */
  releaseHeldTurn(sessionId: string, runId: string): Turn {
    return this.kernel.command("releaseHeldTurn", () => {
      assertId(runId, "run id");
      const session = this.deps.records.get(sessionId);
      if (session.projectId !== undefined) this.deps.assertProjectAvailable(session.projectId);
      const queue = this.deps.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === runId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
      if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be released");
      // Already runnable: nothing to do, and saying so is kinder than a conflict
      // for a button pressed twice.
      if (!turn.held) return structuredClone(turn);
      // Releasing ONE message does not un-pause the session — `claimTurn` would
      // still refuse it. The honest answer is to say so: resume is the verb.
      if (turn.held.reason === "session_paused" && session.paused) {
        throw new EngineStateError("conflict", "the session is paused; resume it to run this message");
      }
      const at = this.kernel.now();
      delete turn.held;
      turn.updatedAt = at;
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
      return structuredClone(turn);
    });
  }

  /** A person's one-way decision about a turn that may have reached a provider. Held messages behind it stay held. */
  discardAmbiguousTurn(sessionId: string, runId: string): Turn {
    return this.kernel.command("discardAmbiguousTurn", () => {
      assertId(runId, "run id");
      const queue = this.deps.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === runId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
      if (turn.state !== "ambiguous") {
        throw new EngineStateError("conflict", "only an ambiguous turn can be discarded");
      }
      const at = this.kernel.now();
      turn.state = "discarded";
      turn.completedAt = at;
      turn.updatedAt = at;
      // The stale worker claim must not remain usable after human resolution.
      delete turn.claim;
      this.deps.writeQueue(sessionId, queue);
      this.deps.tasks.closeOrphaned(sessionId, turn.runId, at, "the turn was discarded before this agent reported back");
      this.deps.requests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.discarded" }, turn.runId);
      return structuredClone(turn);
    });
  }
}
