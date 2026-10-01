import fs from "node:fs";
import { type Session, type SessionDefaults, type Turn } from "@telar/engine-client";
import { assertId, type Kernel } from "../../platform/kernel";
import {
  latestProviderSessionId,
  sessionMetadataFile,
  storedSession,
  type SessionItems,
  type SessionQueue,
  type SessionRecords,
  type SessionRequests,
  type SessionTasks,
} from "../sessions";
import type { TurnSubmission } from "./intake";

// Covers a slow update install and relaunch; an older marker describes some earlier restart nobody remembers.
const PLANNED_RESTART_WINDOW_MS = 10 * 60_000;

/** The engine's words to the model on the turn that continues after an update restart. */
const PLANNED_RESTART_CONTINUATION =
  "Telar restarted to install an update in the middle of your last turn. Check the current state before redoing anything that may already have happened, then continue.";

// Ended by a worker going away, as a quit ends it; `engine_restart` is excluded because a boot also stamps it on backlog that never ran.
function endedByShutdown(turn: Turn): boolean {
  if (turn.state === "stopped") return turn.stopReason === "worker_unavailable";
  return turn.state === "failed" && turn.failure?.code === "interrupted";
}

type RecoveryDeps = {
  records: SessionRecords;
  items: SessionItems;
  tasks: SessionTasks;
  requests: SessionRequests;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  scanQueue: (sessionId: string) => SessionQueue;
  liveQueueSessionIds: () => Set<string>;
  getSessionDefaults: () => SessionDefaults;
  submitTurn: (sessionId: string, input: TurnSubmission) => { turn: Turn; replayed: boolean };
};

/** Settling what a previous process or a lost worker left in flight. Nothing here requeues work or wakes a subscriber. */
export class TurnRecovery {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: RecoveryDeps,
  ) {}

  /**
   * Boot: every turn the last process left live is stopped, and nobody is summoned by it.
   * A planned update restart may then continue what it cut off, once per session.
   */
  recover(): { stopped: string[] } {
    return this.kernel.command("recover", () => {
      const stopped: string[] = [];
      // The turns this boot cut off mid-flight, per session: what a planned restart may continue.
      const cutOff = new Map<string, string[]>();
      // The live index adds a stopped turn still holding its claim, which neither table row can show.
      const unfinished = new Set([...this.kernel.executionStore.unfinishedSessionIds(), ...this.deps.liveQueueSessionIds()]);
      for (const sessionId of unfinished) {
        this.recoverSession(this.deps.records.get(sessionId), cutOff, stopped);
      }
      const pruned = this.deps.requests.pruneHistory();
      if (pruned.dropped > 0) {
        const freed = pruned.bytes >= 1e6 ? `${(pruned.bytes / 1e6).toFixed(1)} MB` : `${Math.round(pruned.bytes / 1e3)} KB`;
        console.log(`[engine] trimmed ${pruned.dropped} resolved requests out of ${pruned.sessions} session${pruned.sessions === 1 ? "" : "s"} (${freed}); the journal still holds them, except policy-resolved pairs of settled turns.`);
      }
      // Last, once every queue is terminal: nothing above may see the turn this opens.
      try {
        this.resumeAfterPlannedRestart(cutOff);
      } catch (error) {
        console.warn("[engine] could not continue sessions after the restart:", error);
      }
      return { stopped };
    });
  }

  /** A registration retired: only this worker's own claims end, recorded as stopped, never requeued. */
  retireWorkerRegistration(workerId: string): { stopped: string[] } {
    return this.kernel.command("retireWorkerRegistration", () => {
      assertId(workerId, "worker id");
      const stopped: string[] = [];
      for (const sessionId of Array.from(this.deps.liveQueueSessionIds())) {
        const session = this.deps.records.get(sessionId);
        const queue = this.deps.readQueue(session.id);
        const mine = queue.turns.filter((turn) => turn.claim?.workerId === workerId && (turn.state === "claimed" || turn.state === "running"));
        if (mine.length === 0) continue;
        const at = this.kernel.now();
        const live = new Set(mine.map((turn) => turn.runId));
        // A steer aimed at one of those turns was never delivered; it ends where it stands rather than requeueing.
        const orphanedSteers = queue.turns.filter((turn) => turn.state === "steering" && turn.steer && live.has(turn.steer.intoRunId));
        // Per session, so this session's events are never journalled onto the next.
        const settled: string[] = [];
        for (const turn of [...mine, ...orphanedSteers]) {
          const wasRunning = turn.state === "running";
          turn.state = "stopped";
          turn.stopReason = "worker_unavailable";
          turn.completedAt = at;
          turn.updatedAt = at;
          delete turn.steer;
          delete turn.claim;
          settled.push(turn.runId);
          if (wasRunning) {
            this.deps.tasks.closeOrphaned(session.id, turn.runId, at, "the worker running this agent disappeared");
            this.deps.items.closeOpen(session.id, new Set([turn.runId]), at);
            this.deps.requests.closeOpen(session.id, new Set([turn.runId]), at);
          }
        }
        this.deps.writeQueue(session.id, queue);
        this.deps.records.touch(session.id, at);
        for (const runId of settled) this.kernel.appendEvent(session.id, { type: "turn.stopped", reason: "worker_unavailable" }, runId);
        stopped.push(...settled);
      }
      const deliveries = this.deps.tasks.readStops();
      const remaining = deliveries.filter((delivery) => delivery.workerId !== workerId);
      if (remaining.length !== deliveries.length) this.kernel.writeDocument(this.kernel.paths.taskStops, remaining);
      return { stopped };
    });
  }

  cancellationsForWorker(workerId: string): Array<{ sessionId: string; runId: string; claimToken: string }> {
    assertId(workerId, "worker id");
    return [...this.deps.liveQueueSessionIds()].flatMap((sessionId) =>
      this.deps.scanQueue(sessionId).turns.flatMap((turn) =>
        turn.state === "stopped" && turn.claim?.workerId === workerId
          ? [{ sessionId, runId: turn.runId, claimToken: turn.claim.token }]
          : [],
      ),
    );
  }

  private recoverSession(session: Session, cutOff: Map<string, string[]>, stopped: string[]): void {
    const queue = this.deps.readQueue(session.id);
    const settledRuns = new Set<string>();
    for (const turn of queue.turns) {
      if (turn.state === "queued" || turn.state === "claimed" || turn.state === "running") continue;
      settledRuns.add(turn.runId);
    }
    const sweptAt = this.kernel.now();
    this.deps.tasks.closeLive(session.id, sweptAt, "the turn ended before this agent reported back", { runIds: settledRuns, includeBackground: false });
    // A stopped turn from before this sweep existed still holds the tool row it was inside.
    this.deps.items.closeOpen(session.id, settledRuns, sweptAt);
    this.deps.requests.closeOpen(session.id, settledRuns, sweptAt);
    let changed = false;
    // Retiring a dead claim rewrites the queue but must not bump the session and reorder a sidebar.
    let claimsRetired = false;
    const recoveryEvents: Array<{ type: "turn.stopped"; runId: string }> = [];
    const at = this.kernel.now();
    const recoveredProviderSessionId = latestProviderSessionId(queue.turns);
    let metadataChanged = false;
    if (!session.resumeCursor && recoveredProviderSessionId) {
      session.resumeCursor = recoveredProviderSessionId;
      session.updatedAt = at;
      metadataChanged = true;
    }
    for (const turn of queue.turns) {
      if (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running" && turn.state !== "steering") continue;
      const wasLive = turn.state === "running";
      if ((wasLive || turn.state === "claimed") && turn.kind !== "compact") {
        cutOff.set(session.id, [...(cutOff.get(session.id) ?? []), turn.runId]);
      }
      turn.state = "stopped";
      turn.stopReason = "engine_restart";
      turn.completedAt = at;
      turn.updatedAt = at;
      delete turn.steer;
      delete turn.claim;
      // A hold was a question waiting to be asked; there is no question now.
      delete turn.held;
      stopped.push(turn.runId);
      recoveryEvents.push({ type: "turn.stopped", runId: turn.runId });
      if (wasLive) {
        // The process running these did not survive, and a question it parked can never be answered.
        this.deps.tasks.closeOrphaned(session.id, turn.runId, at, "the engine restarted while this agent was running");
        this.deps.items.closeOpen(session.id, new Set([turn.runId]), at);
        this.deps.requests.closeOpen(session.id, new Set([turn.runId]), at);
      }
      changed = true;
    }
    for (const turn of queue.turns) {
      if (turn.state !== "ambiguous") continue;
      turn.state = "stopped";
      turn.stopReason = "engine_restart";
      turn.completedAt ??= at;
      turn.updatedAt = at;
      delete turn.held;
      stopped.push(turn.runId);
      recoveryEvents.push({ type: "turn.stopped", runId: turn.runId });
      changed = true;
    }
    for (const turn of queue.turns) {
      if (turn.state !== "stopped" || !turn.claim) continue;
      delete turn.claim;
      claimsRetired = true;
    }
    if (session.paused) {
      delete session.paused;
      session.updatedAt = at;
      metadataChanged = true;
    }
    const swept = this.deps.tasks.closeLive(session.id, at, "the process that owned this task is gone", { includeBackground: true, onlyBackground: true, state: "stopped" });
    if (changed || claimsRetired) this.deps.writeQueue(session.id, queue);
    if (changed || metadataChanged || swept.length > 0) {
      if (!metadataChanged) this.deps.records.touch(session.id, at);
      else this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, session.id), storedSession(session));
    }
    if (changed) {
      for (const event of recoveryEvents) this.kernel.appendEvent(session.id, { type: event.type, reason: "engine_restart" }, event.runId);
    }
  }

  /**
   * Continues what a planned update restart cut off. The shell's fresh marker is the whole permission (a crash writes
   * none), it is deleted on every path, and the run id derives from it so a second boot cannot open a second turn.
   */
  private resumeAfterPlannedRestart(cutOff: Map<string, string[]>): string[] {
    const file = this.kernel.paths.plannedRestart;
    if (!fs.existsSync(file)) return [];
    const resumed: string[] = [];
    try {
      let marker: unknown;
      try {
        marker = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return resumed;
      }
      const now = this.kernel.now();
      if (
        typeof marker !== "object" || marker === null ||
        (marker as { version?: unknown }).version !== 1 ||
        (marker as { reason?: unknown }).reason !== "update"
      ) return resumed;
      const plannedAt = (marker as { at?: unknown }).at;
      if (typeof plannedAt !== "number" || !Number.isFinite(plannedAt) || plannedAt > now || now - plannedAt > PLANNED_RESTART_WINDOW_MS) {
        return resumed;
      }
      if (this.deps.getSessionDefaults().resumeAfterRestart !== true) return resumed;

      // A turn is cut off three ways: stopped by this boot, failed `interrupted`, or stopped `worker_unavailable` on a clean quit.
      const candidates = new Map(cutOff);
      for (const sessionId of this.kernel.executionStore.sessionIdsWithTurnsEndedSince(plannedAt)) {
        if (candidates.has(sessionId)) continue;
        const interrupted = this.deps.readQueue(sessionId).turns.filter(
          (turn) => endedByShutdown(turn) && turn.kind !== "compact" && (turn.completedAt ?? 0) >= plannedAt,
        );
        if (interrupted.length > 0) candidates.set(sessionId, interrupted.map((turn) => turn.runId));
      }
      for (const [sessionId, runIds] of candidates) {
        // One bad session is skipped, never the boot.
        try {
          const session = this.deps.records.get(sessionId);
          // Put away, or stopped by the person: either way somebody decided this session is done for now.
          if (session.state === "archived" || session.settledOverride === "settled" || session.agentMessagesBlocked || session.draft) continue;
          const turns = this.deps.readQueue(sessionId).turns;
          const last = turns.filter((turn) => runIds.includes(turn.runId)).sort((a, b) => b.sequence - a.sequence)[0];
          // A turn the person stopped is theirs to restart, not ours.
          if (!last || last.stopReason === "user" || last.stopReason === "agent") continue;
          const { turn } = this.deps.submitTurn(sessionId, {
            runId: `run_restart_${plannedAt}_${sessionId}`.slice(0, 200),
            input: PLANNED_RESTART_CONTINUATION,
            origin: "restart",
            restartOrigin: { reason: "update", plannedAt, interruptedRunId: last.runId },
            // The same model and effort the cut-off turn was running on.
            ...(last.model ? { model: (({ instanceId: _instanceId, ...selection }) => selection)(last.model) } : {}),
          });
          resumed.push(turn.runId);
        } catch (error) {
          console.warn(`[engine] could not continue ${sessionId} after the restart:`, error);
        }
      }
      if (resumed.length > 0) console.log(`[engine] continued ${resumed.length} session${resumed.length === 1 ? "" : "s"} cut off by the update restart.`);
      return resumed;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}
