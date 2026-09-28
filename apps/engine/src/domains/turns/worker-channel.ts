import crypto from "node:crypto";
import type { Session, Turn, WorkerStatus } from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import { sessionMetadataFile, storedSession, type SessionActivity, type SessionQueue, type SessionRecords, type SessionTasks } from "../sessions";
import type { SenderProof } from "./intake";

/**
 * The running claim `runId` names. A right token against a settled turn is that turn's provider reporting late: still
 * `conflict` (the worker drops those rather than failing the turn), but worded as late. A terminal turn stays immutable.
 */
export function requireRunningClaimFromQueue(queue: SessionQueue, runId: string, claimToken: string): Turn {
  assertId(runId, "run id");
  if (typeof claimToken !== "string" || claimToken.length < 16) {
    throw new EngineStateError("invalid_request", "claim token is invalid");
  }
  const turn = queue.turns.find((candidate) => candidate.runId === runId);
  if (!turn) throw new EngineStateError("not_found", "turn does not exist");
  if (turn.state !== "running" || turn.claim?.token !== claimToken) {
    const settled = turn.state === "completed" || turn.state === "failed";
    if (settled && turn.claim?.token === claimToken) {
      throw new EngineStateError("conflict", `turn has already settled (${turn.state}); this report arrived after the turn ended`);
    }
    throw new EngineStateError("conflict", "turn is not running under this worker claim");
  }
  return turn;
}

type ChannelDeps = {
  records: SessionRecords;
  tasks: SessionTasks;
  activity: SessionActivity;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  scanQueue: (sessionId: string) => SessionQueue;
  liveQueueSessionIds: () => Set<string>;
  stopSession: (sessionId: string) => { stopped: Turn[]; live?: Turn };
  assertProjectAvailable: (projectId: string) => void;
};

/** What the worker's heartbeat and claims are checked against: steers to deliver, claims to prove, background stops. */
export class WorkerChannel {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: ChannelDeps,
  ) {}

  /** Steers waiting on this worker's running turns; the worker pushes the text into the driver, then acks. */
  steerForWorker(workerId: string): WorkerStatus["steer"] {
    assertId(workerId, "worker id");
    return [...this.deps.liveQueueSessionIds()].flatMap((sessionId) => {
      const queue = this.deps.scanQueue(sessionId);
      const claimed = new Map(
        queue.turns
          .filter((turn) => turn.claim?.workerId === workerId && turn.state === "running")
          .map((turn) => [turn.runId, turn.claim!.token] as const),
      );
      if (claimed.size === 0) return [];
      return queue.turns.flatMap((turn) => {
        if (turn.state !== "steering" || !turn.steer) return [];
        const claimToken = claimed.get(turn.steer.intoRunId);
        if (!claimToken) return [];
        // Cloned: `queue` is the shared scan copy, and a delivery must not hand a worker live references into it.
        return [
          structuredClone({
            sessionId,
            runId: turn.steer.intoRunId,
            claimToken,
            steerRunId: turn.runId,
            text: turn.input,
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
            // Who said it, the notice the model reads, the wake's stamp and that it is a notification all ride the
            // delivery, or a message steered into a busy turn would reach the provider as the person's own.
            ...(turn.origin === "session" && turn.sender ? { sender: turn.sender } : {}),
            ...(turn.origin === "session" && turn.sender && turn.agentNotice ? { notice: turn.agentNotice } : {}),
            ...(turn.origin === "session" && turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
            ...(turn.notification ? { notification: turn.notification } : {}),
          }),
        ];
      });
    });
  }

  requireRunningClaim(sessionId: string, runId: string, claimToken: string): Turn {
    return requireRunningClaimFromQueue(this.deps.readQueue(sessionId), runId, claimToken);
  }

  /**
   * A sender's claim. Still refused when stale, but for a claim that really was this session's, the refusal names
   * the turn it is running now (a retry carries that claim), or says there is none. A foreign token keeps the flat answer.
   */
  requireSenderClaim(proof: SenderProof): Turn {
    const queue = this.deps.readQueue(proof.sessionId);
    try {
      return requireRunningClaimFromQueue(queue, proof.runId, proof.claimToken);
    } catch (error) {
      if (!(error instanceof EngineStateError) || error.code !== "conflict") throw error;
      const named = queue.turns.find((turn) => turn.runId === proof.runId);
      // Only a turn that ended: a claim on one not started yet is early, not stale.
      if (!named || (named.state !== "completed" && named.state !== "failed" && named.state !== "stopped")) throw error;
      if (named.claim && named.claim.token !== proof.claimToken) throw error;
      const live = queue.turns.find((turn) => turn.state === "running" && turn.claim);
      const ending = named.state === "stopped" ? `was stopped (${named.stopReason ?? "stopped"})` : `has already settled (${named.state})`;
      throw new EngineStateError(
        "conflict",
        live
          ? `The turn this message was sent from (${proof.runId}) ${ending}, so it cannot be named as the sender. This session's live turn is ${live.runId} — send it again and it goes from that turn.`
          : `The turn this message was sent from (${proof.runId}) ${ending}, and this session has no live turn to send from. Nothing was delivered; say it again on your next turn.`,
      );
    }
  }

  /** The background tasks chip's Stop: marks them stopped at once and queues the real kill for the worker holding them. */
  stopBackgroundTasks(sessionId: string, reason = "stopped from the cockpit"): number {
    return this.kernel.command("stopBackgroundTasks", () => {
      const at = this.kernel.now();
      const closed = this.deps.tasks.closeLive(sessionId, at, reason, {
        includeBackground: true,
        onlyBackground: true,
        state: "stopped",
      });
      if (closed.length === 0) return 0;
      const deliveries = this.deps.tasks.readStops();
      const turns = this.deps.readQueue(sessionId).turns;
      const driver = this.deps.records.get(sessionId).driver;
      for (const task of closed) {
        if (!task.providerTaskId) continue;
        const workerId = turns.find((turn) => turn.runId === task.runId)?.claim?.workerId;
        if (workerId) deliveries.push({ deliveryId: `stop_${crypto.randomUUID().replaceAll("-", "")}`, sessionId,
          providerTaskId: task.providerTaskId, workerId, driver });
      }
      this.deps.tasks.writeStops(deliveries);
      this.deps.records.touch(sessionId, at);
      return closed.length;
    });
  }

  /** Deprecated alias for stop: there is no pause any more. Returns the old shape, with `held` 0 and `already` false. */
  pauseSession(sessionId: string): { session: Session; stopped?: Turn; held: number; already: boolean } {
    return this.kernel.command("pauseSession", () => {
      const session = this.deps.records.get(sessionId);
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
      const { live } = this.deps.stopSession(sessionId);
      return { session: this.deps.activity.of(structuredClone(this.deps.records.get(sessionId))), ...(live ? { stopped: live } : {}), held: 0, already: false };
    });
  }

  /** Deprecated and inert in practice: lifts a latch an older build wrote and releases only what that pause held. */
  resumeSession(sessionId: string): { session: Session; released: number; already: boolean } {
    return this.kernel.command("resumeSession", () => {
      const session = this.deps.records.get(sessionId);
      if (!session.paused) return { session: this.deps.activity.of(structuredClone(session)), released: 0, already: true };
      if (session.projectId !== undefined) this.deps.assertProjectAvailable(session.projectId);
      const at = this.kernel.now();
      const queue = this.deps.readQueue(sessionId);
      const released: Turn[] = [];
      for (const turn of queue.turns) {
        if (turn.state !== "queued" || turn.held?.reason !== "session_paused") continue;
        delete turn.held;
        turn.updatedAt = at;
        released.push(turn);
      }
      if (released.length > 0) this.deps.writeQueue(sessionId, queue);
      delete session.paused;
      session.updatedAt = at;
      this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
      for (const turn of released) this.kernel.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
      this.kernel.appendEvent(sessionId, { type: "session.resumed", released: released.length });
      this.kernel.appendEvent(sessionId, { type: "session.updated", session });
      return { session: this.deps.activity.of(structuredClone(session)), released: released.length, already: false };
    });
  }
}
