import crypto from "node:crypto";
import {
  defaultInstanceIdForDriver,
  resolveMcpServers,
  STALLED_AFTER_MS,
  workspacePath,
  type AgentOrientation,
  type McpServer,
  type ModelSelection,
  type Project,
  type ProviderDriverKind,
  type ProviderInstance,
  type SessionDefaults,
  type Session,
  type Task,
  type TaskSeed,
  type Turn,
  type TurnFailureCode,
  type WakeKind,
  type WorkerClaim,
  type EngineRequest,
} from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import { withComputerUse, type ResolvedComputerUse } from "../computer-use";
import type { ModelCatalogues } from "../providers";
import { awaitsRateLimitSweep, TELAR_ORIENTATION, type SessionMailbox, type SessionQueue, type SessionRecords, type SessionRequests, type SessionTasks } from "../sessions";
import { MAX_TEXT_LENGTH } from "./intake";

// How far the durable progress stamp may lag the in-memory one before a write; well under `STALLED_AFTER_MS`.
const PROGRESS_STAMP_MS = 60_000;

/** A task that has not ended. Wider than `countsAsActivity`: a paused task is still work a cold process must be seeded with. */
export function isLiveTask(task: Task): boolean {
  return task.state === "pending" || task.state === "running" || task.state === "waiting";
}

// Strips the engine-minted fields, so a claim never hands a worker something it must not mint back.
function taskSeedOf(task: Task): TaskSeed {
  const { sessionId: _sessionId, runId: _runId, startedAt: _startedAt, updatedAt: _updatedAt, completedAt: _completedAt, ...seed } = task;
  return seed;
}

type ClaimDeps = {
  records: SessionRecords;
  tasks: SessionTasks;
  requests: SessionRequests;
  mailbox: SessionMailbox;
  catalogues: ModelCatalogues;
  computerUse: () => ResolvedComputerUse | undefined;
  readQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  scanQueue: (sessionId: string) => SessionQueue;
  liveQueueSessionIds: () => Set<string>;
  requeueUndeliveredSteers: (queue: { turns: Turn[] }, runId: string, at: number) => Turn[];
  fireSubscriptions: (sessionId: string, kind: WakeKind, turn: Turn, context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest }) => void;
  flushPendingNotifications: (sessionId: string) => void;
  getSessionDefaults: () => SessionDefaults;
  listMcpServers: () => McpServer[];
  resolveProviderInstance: (instanceId: string, driver: ProviderDriverKind) => ProviderInstance;
  getProject: (projectId: string) => Project;
  resolveDataScience: (session: Session) => unknown;
  resolveLatex: (session: Session) => unknown;
  enabledPluginIds: (session: Session) => string[];
  getAgentOrientation: () => AgentOrientation;
};

/** Handing queued turns to workers: claiming, the sweeps a claim poll runs, and what the worker is handed. */
export class TurnClaims {
  private readonly warnedLegacyDriver = new Set<string>();

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: ClaimDeps,
  ) {}

  /** Claims exactly one queued turn; the daemon has one state lock, so two workers cannot claim it twice. */
  claimTurn(sessionId: string, workerId: string): Turn | undefined {
    return this.kernel.command("claimTurn", () => {
      assertId(workerId, "worker id");
      // A PAUSED SESSION DISPATCHES NOTHING — checked on the record, not
      // inferred from held flags, so a message that slipped into `queued`
      // unheld by any path still cannot run. See `pauseSession`.
      if (this.deps.records.get(sessionId).paused) return undefined;
      if (this.deps.records.get(sessionId).preparation) return undefined;
      const queue = this.deps.readQueue(sessionId);
      if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) return undefined;
      if (queue.turns.some((turn) => turn.state === "ambiguous")) return undefined;
      const turn = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
      if (!turn) return undefined;
      const at = this.kernel.now();
      turn.state = "claimed";
      // The watermark rides the claim: everything submitted from here on was
      // written against a session the person had reason to think was live.
      turn.claim = { workerId, token: crypto.randomUUID(), at, sequence: queue.nextSequence };
      turn.updatedAt = at;
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      this.kernel.appendEvent(sessionId, { type: "turn.claimed", workerId }, turn.runId);
      return structuredClone(turn);
    });
  }

  /** A turn the provider started between turns, born running under a fresh claim; refused while any turn is live. */
  openProviderTurn(sessionId: string, input: { workerId: string; input: string; reason: NonNullable<Turn["providerReason"]> }): Turn {
    return this.kernel.command("openProviderTurn", () => {
      assertId(input.workerId, "worker id");
      // The CLI woke itself on a background task, but the human paused the
      // session: no turn opens. The driver parks the frames; a `conflict` is
      // what it already reads as "not now".
      if (this.deps.records.get(sessionId).paused) throw new EngineStateError("conflict", "session is paused");
      const queue = this.deps.readQueue(sessionId);
      if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) {
        throw new EngineStateError("conflict", "session already has a live turn");
      }
      const at = this.kernel.now();
      const turn: Turn = {
        runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
        sessionId,
        sequence: queue.nextSequence++,
        input: input.input.slice(0, MAX_TEXT_LENGTH),
        origin: "provider",
        providerReason: input.reason,
        state: "running",
        acceptedAt: at,
        startedAt: at,
        updatedAt: at,
        claim: { workerId: input.workerId, token: crypto.randomUUID(), at },
      };
      queue.turns.push(turn);
      this.deps.writeQueue(sessionId, queue);
      this.deps.records.touch(sessionId, at);
      // The same three events a human turn produces, in one breath: tailing
      // clients fold a provider turn with the code they already have.
      this.kernel.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
      this.kernel.appendEvent(sessionId, { type: "turn.claimed", workerId: input.workerId }, turn.runId);
      this.kernel.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
      return structuredClone(turn);
    });
  }

  /** Whether this turn would run Claude with no model of its own on a cold catalogue, so the probe runs only when needed. */
  claudeAdmissionNeedsCatalogue(sessionId: string, turnModel?: { model?: string }): boolean {
    if (turnModel?.model) return false;
    const session = this.deps.records.get(sessionId);
    return session.driver === "claude" && !session.model?.model && this.deps.catalogues.defaultClaudeModelId() === undefined;
  }

  // Settles a never-claimed turn as failed; the code is the caller's, since not every such failure is a provider's.
  private failQueuedTurn(
    sessionId: string,
    queue: SessionQueue,
    turn: Turn,
    message: string,
    code: TurnFailureCode = "provider_unavailable",
  ): void {
    const at = this.kernel.now();
    turn.state = "failed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.failure = { code, message };
    const requeued = this.deps.requeueUndeliveredSteers(queue, turn.runId, at);
    this.deps.writeQueue(sessionId, queue);
    // This turn's own bookkeeping only: no worker ran, so there are no items or
    // tasks of its own, and background work belongs to whatever else is running.
    this.deps.requests.closeOpen(sessionId, new Set([turn.runId]), at);
    this.deps.records.touch(sessionId, at);
    this.kernel.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
    for (const reverted of requeued) this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    // A coordinator waiting on this session hears the failure like any other.
    this.deps.fireSubscriptions(sessionId, "turn_failed", turn, { failure: turn.failure });
    this.deps.flushPendingNotifications(sessionId);
  }

  // Absent means yes for Claude (asking the standing default) and no otherwise; only an explicit choice is stored.
  private resumesAfterRateLimit(session: Session): boolean {
    // Resolved at read time, so changing the standing default reaches every
    // session that never chose for itself.
    return session.resumeAfterRateLimit ?? (session.driver === "claude" && this.deps.getSessionDefaults().resumeAfterRateLimit !== false);
  }

  private lastProgressOf(sessionId: string, turn: Turn): number {
    const seen = this.kernel.runProgress.get(sessionId);
    if (seen?.runId === turn.runId) return seen.at;
    return turn.lastProgressAt ?? turn.startedAt ?? turn.claim?.at ?? turn.acceptedAt;
  }

  /**
   * Marks a running turn that has gone quiet as stalled, advisory only, and clears it when evidence returns.
   * Nothing is journalled here: an event would count as the run's own progress and clear the flag.
   */
  private sweepStalledTurns(sessionId: string): void {
    const scan = this.deps.scanQueue(sessionId);
    if (!scan.turns.some((turn) => turn.state === "running")) return;
    const at = this.kernel.now();
    const verdicts = scan.turns
      .filter((turn) => turn.state === "running")
      .map((turn) => {
        const since = this.lastProgressOf(sessionId, turn);
        return {
          runId: turn.runId,
          since,
          stalled: at - since >= STALLED_AFTER_MS,
          was: turn.stalled !== undefined,
          drifted: since - (turn.lastProgressAt ?? 0) >= PROGRESS_STAMP_MS,
        };
      });
    if (!verdicts.some((verdict) => verdict.stalled !== verdict.was || verdict.drifted)) return;
    // Writes, so a queue of its own rather than the copy every other reader is
    // sharing — `sweepRateLimited` immediately above does the same.
    const own = this.deps.readQueue(sessionId);
    for (const verdict of verdicts) {
      const turn = own.turns.find((candidate) => candidate.runId === verdict.runId);
      // Re-read rather than trusted: the scan copy was taken before this call
      // and a turn that has settled since must not be marked stalled on its way
      // out. The same argument `settleWorktree`'s header makes.
      if (!turn || turn.state !== "running") continue;
      turn.lastProgressAt = verdict.since;
      if (verdict.stalled) turn.stalled = { since: verdict.since, noticedAt: turn.stalled?.noticedAt ?? at };
      else delete turn.stalled;
    }
    this.deps.writeQueue(sessionId, own);
  }

  /** Requeues a turn whose usage limit has lifted (keeping its place and its failure), or records the decision not to. */
  private sweepRateLimited(sessionId: string): void {
    const at = this.kernel.now();
    const due = (turn: Turn): boolean => awaitsRateLimitSweep(turn) && turn.failure!.resumeAt! <= at;
    if (!this.deps.scanQueue(sessionId).turns.some(due)) return;

    const session = this.deps.records.get(sessionId);
    if (session.paused || session.state === "archived") return;

    const queue = this.deps.readQueue(sessionId);
    const resuming = this.resumesAfterRateLimit(session);
    const requeued: Turn[] = [];
    for (const turn of queue.turns) {
      if (!due(turn)) continue;
      turn.failure = { ...turn.failure!, resumeDecidedAt: at };
      turn.updatedAt = at;
      if (!resuming) continue;
      turn.state = "queued";
      turn.resumedAfterRateLimit = at;
      delete turn.completedAt;
      delete turn.claim;
      requeued.push(turn);
    }
    this.deps.writeQueue(sessionId, queue);
    for (const turn of requeued) {
      this.kernel.appendEvent(sessionId, { type: "turn.requeued", reason: "rate_limit_reset" }, turn.runId);
    }
    // THE SESSION COMES BACK TO THE LIST when its own work restarts, the same
    // way a wake does: a limit that lifted at 3am should not leave the session
    // shelved with a turn quietly running inside it.
    if (requeued.length > 0) {
      this.deps.records.wakeForNewWork(sessionId);
      this.deps.records.touch(sessionId, at);
    }
  }

  /** Sweeps every live queue, then claims the oldest runnable turn across sessions. */
  claimNextTurn(workerId: string): WorkerClaim | undefined {
    return this.kernel.command("claimNextTurn", () => {
      assertId(workerId, "worker id");
      const candidates: Array<{ sessionId: string; acceptedAt: number }> = [];
      for (const sessionId of [...this.deps.liveQueueSessionIds()]) {
        const next = this.nextClaimable(sessionId);
        if (next) candidates.push({ sessionId, acceptedAt: next.acceptedAt });
      }
      candidates.sort((left, right) => left.acceptedAt - right.acceptedAt || left.sessionId.localeCompare(right.sessionId));
      for (const candidate of candidates) {
        const candidateSession = this.deps.records.get(candidate.sessionId);
        if ((candidateSession.driver as string) === "telar") {
          if (!this.warnedLegacyDriver.has(candidate.sessionId)) {
            this.warnedLegacyDriver.add(candidate.sessionId);
            console.error(`[telar] session ${candidate.sessionId} runs on the removed "telar" driver and will not be claimed (#531).`);
          }
          continue;
        }
        const turn = this.claimTurn(candidate.sessionId, workerId);
        if (!turn) continue;
        return this.workerClaim(this.deps.records.get(candidate.sessionId), turn);
      }
      return undefined;
    });
  }

  // An absent Claude model gets the known default id, since the CLI's own default is the short window. A named model runs as named.
  private claimModelSelection(
    driver: ProviderDriverKind,
    normalized: ModelSelection | undefined,
    instanceId: string,
  ): ModelSelection | undefined {
    if (driver !== "claude" || normalized?.model) return normalized;
    const model = this.deps.catalogues.defaultClaudeModelId(normalized?.instanceId ?? instanceId);
    // Nothing known: unchanged. A guess here would be the 200k bug wearing a
    // different hat.
    if (!model) return normalized;
    // `instanceId` is required on a selection, so it comes from the session
    // rather than being conjured — an absent selection has none of its own.
    return { ...normalized, instanceId: normalized?.instanceId ?? instanceId, model };
  }

  // Sweeps the session, then answers the turn it could run now, or nothing; a checkout that failed or a model that cannot resolve fails the turn here.
  private nextClaimable(sessionId: string): Turn | undefined {
    this.sweepRateLimited(sessionId);
    this.sweepStalledTurns(sessionId);
    // A SCAN, so the shared copy: the one session that wins is claimed
    // through `claimTurn`, which reads a queue of its own to write.
    const queue = this.deps.scanQueue(sessionId);
    // One turn per session at a time — the engine's own invariant, checked
    // here so a busy session costs nothing further.
    if (queue.turns.some((candidate) => candidate.state === "claimed" || candidate.state === "running")) return undefined;
    if (queue.turns.some((candidate) => candidate.state === "ambiguous")) return undefined;
    // `!held` matches `claimTurn`'s own choice — a session whose only queued
    // work is held has nothing to offer, and listing it as a candidate would
    // win the sort and then claim nothing.
    const next = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
    if (!next) return undefined;
    // `claimTurn` refuses a paused session; skipping it here keeps it from
    // winning the sort and stalling every other session for a poll.
    const session = this.deps.records.get(sessionId);
    if (session.paused) return undefined;
    if (session.preparation?.state === "preparing") return undefined;
    // Released with a turn queued: the restore `submitTurn` started is on its
    // way, and a turn must never run in a directory that is not there.
    if (session.workspace.mode === "worktree" && session.workspace.released) return undefined;
    if (session.preparation?.state === "failed") {
      // Writes, so it takes a queue of its own rather than editing the copy
      // every other reader is sharing — see the `selection === "failed"`
      // branch below, which is the same shape for the same reason.
      const own = this.deps.readQueue(sessionId);
      const failing = own.turns.find((candidate) => candidate.runId === next.runId);
      if (failing) {
        this.failQueuedTurn(
          sessionId,
          own,
          failing,
          // GIT'S OWN WORDS FIRST. `preparation.error` is what the cut said
          // and it is the only part of this a person can act on; the rest
          // says what the engine did and did not do with it.
          `This session's checkout could not be created, so nothing can run in it. Git said: ${
            session.preparation.error ?? "no reason was recorded"
          }. Nothing was sent to a provider. Fix the checkout — or make a new session — and send again.`,
          "workspace_unavailable",
        );
      }
      return undefined;
    }
    const selection = this.deps.catalogues.claudeSelectionState(session.driver, next.model ?? session.model);
    if (selection === "pending") {
      // One probe in flight for the whole engine, never one per tick.
      void this.deps.catalogues.prepareClaude();
      return undefined;
    }
    if (selection === "failed") {
      // The one branch of this scan that WRITES, so it takes a queue of its
      // own rather than editing the copy every other reader is sharing.
      const own = this.deps.readQueue(sessionId);
      const failing = own.turns.find((candidate) => candidate.runId === next.runId);
      if (failing) {
        this.failQueuedTurn(
          sessionId,
          own,
          failing,
          "Telar could not resolve a long-context Claude model, so it cannot tell which context window this session would run. Nothing was sent to the provider. Pick a model for this session from the composer's model picker, or send again to retry.",
        );
      }
      return undefined;
    }
    return next;
  }

  // Everything the worker is handed with a claimed turn, resolved now so a mid-session change applies to the next turn.
  private workerClaim(session: Session, turn: Turn): WorkerClaim {
    if (session.purpose === "usage-diagnosis") return this.diagnosisClaim(session, turn);
    const resumeCursor = this.deps.records.resumeCursorFor(session);
    // Normalised HERE TOO, because a record saved before the window became a
    // control is read here without ever passing through a patch — and the
    // claim is the one place that decides what actually runs.
    const model = this.claimModelSelection(session.driver, turn.model ?? session.model, session.providerInstanceId ?? defaultInstanceIdForDriver(session.driver));
    const registered = resolveMcpServers(this.deps.listMcpServers(), session.projectId);
    const mcpServers = withComputerUse(
      registered.filter((server) => server.enabled),
      registered,
      session.driver,
      this.deps.computerUse(),
    );
    const providerInstance = this.deps.resolveProviderInstance(session.providerInstanceId, session.driver);
    return {
      sessionId: session.id,
      // Emitted only when the session HAS one — see `WorkerClaim.projectRoot`.
      // A `none` workspace sends nothing rather than a path nobody chose.
      ...(workspacePath(session.workspace) ? { projectRoot: workspacePath(session.workspace)! } : {}),
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(() => {
        if (session.workspace.mode !== "worktree" || !session.projectId) return {};
        try {
          const project = this.deps.getProject(session.projectId);
          return { worktree: { branch: session.workspace.branch, repoRoot: project.root } };
        } catch {
          // A session whose project record went. Nothing to say about it that
          // would be true, so it says nothing and the worker keeps the
          // path-only wording.
          return {};
        }
      })(),
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      providerInstance,
      // Resolved HERE, at claim time, so a model changed mid-session applies
      // to the next turn the worker picks up rather than to the one it is
      // already running.
      ...(model ? { model } : {}),
      // Filtered to the enabled ones in the engine, so "disabled" is decided
      // in exactly one place rather than trusted to every worker.
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(() => {
        const resolves: Record<string, () => unknown> = {
          "data-science": () => this.deps.resolveDataScience(session),
          latex: () => this.deps.resolveLatex(session),
        };
        const ids = this.deps.enabledPluginIds(session).filter((id) => (id in resolves ? resolves[id]!() !== undefined : true));
        return ids.length > 0 ? { plugins: ids } : {};
      })(),
      ...(resumeCursor ? { resumeCursor } : {}),
      // The session's LIVE task rows, so a provider process built cold
      // files a still-running shell's report on the row that exists rather
      // than minting a second one. Settled rows have nothing to report on.
      ...(() => {
        const live = [...this.deps.tasks.read(session.id).values()].filter(isLiveTask).map(taskSeedOf);
        return live.length > 0 ? { tasks: live } : {};
      })(),
      ...(this.deps.getAgentOrientation().preamble ? { orientation: TELAR_ORIENTATION } : {}),
      ...(() => {
        const notes = [...this.deps.mailbox.takeNextTurnNotes(session.id), ...this.deps.mailbox.takeHeldMail(session.id)];
        return notes.length > 0 ? { notes } : {};
      })(),
      turn,
    };
  }

  private diagnosisClaim(session: Session, turn: Turn): WorkerClaim {
    const model = this.claimModelSelection(session.driver, turn.model ?? session.model, session.providerInstanceId ?? defaultInstanceIdForDriver(session.driver));
    const providerInstance = this.deps.resolveProviderInstance(session.providerInstanceId, session.driver);
    const resumeCursor = this.deps.records.resumeCursorFor(session);
    return {
      sessionId: session.id,
      projectRoot: this.kernel.paths.root,
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      providerInstance,
      ...(model ? { model } : {}),
      ...(resumeCursor ? { resumeCursor } : {}),
      readOnly: true,
      turn,
    };
  }
}
