import path from "node:path";
import { Turn, TurnState, type Item } from "@telar/engine-client";
import { assertId, assertStateVersion, EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../state-paths";
import { summariseTurn } from "../turns";
import { sessionDir } from "./metadata";

export type SessionQueue = { version: typeof STATE_VERSION; sessionId: string; nextSequence: number; turns: Turn[] };

const FOLDED_TURNS_LIMIT = 8;

export const emptyQueue = (sessionId: string): SessionQueue => ({ version: STATE_VERSION, sessionId, nextSequence: 1, turns: [] });

export function sessionQueueFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "queue.json");
}

export function sessionQueueIndexFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "queue.index.json");
}

// The four fields every reader keys on; a property check per row, not a schema walk.
function isTurnRow(row: unknown): row is Turn {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<Turn>;
  return typeof candidate.runId === "string" && typeof candidate.sessionId === "string"
    && Number.isSafeInteger(candidate.sequence) && TurnState.safeParse(candidate.state).success;
}

/**
 * `trusted` documents come from the execution store, which `write` validated;
 * they get the structural guard only. Anything else gets the full schema walk.
 */
function parseQueue(value: unknown, sessionId: string, trusted: boolean): SessionQueue {
  assertStateVersion(value, "session queue");
  const stored = value as { sessionId?: unknown; nextSequence?: unknown; turns?: unknown };
  if (stored.sessionId !== sessionId || !Number.isSafeInteger(stored.nextSequence)) {
    throw new EngineStateError("invalid_request", "invalid session queue");
  }
  let rows: Turn[];
  if (trusted) {
    if (!Array.isArray(stored.turns) || stored.turns.some((row) => !isTurnRow(row))) {
      throw new EngineStateError("invalid_request", "invalid session queue");
    }
    rows = stored.turns as Turn[];
  } else {
    const turns = Turn.array().safeParse(stored.turns);
    if (!turns.success) throw new EngineStateError("invalid_request", "invalid session queue");
    rows = turns.data;
  }
  const ids = new Set<string>();
  for (const turn of rows) {
    assertId(turn.runId, "run id");
    if (ids.has(turn.runId)) throw new EngineStateError("invalid_request", "duplicate Telar turn id");
    ids.add(turn.runId);
  }
  return { version: STATE_VERSION, sessionId, nextSequence: stored.nextSequence as number, turns: rows };
}

/** A failed turn the rate-limit sweep has not yet decided about. */
export function awaitsRateLimitSweep(turn: Turn): boolean {
  return (
    turn.state === "failed" &&
    turn.failure?.code === "rate_limited" &&
    turn.failure.resumeAt !== undefined &&
    turn.failure.resumeDecidedAt === undefined
  );
}

/**
 * Whether a worker could have business with this queue: the union of what a
 * claim, the heartbeat and the rate-limit sweep read. A stopped turn keeps its
 * claim, which is how a worker learns of a Stop.
 */
function queueConcernsAWorker(queue: SessionQueue): boolean {
  return queue.turns.some(
    (turn) =>
      turn.state === "queued" ||
      turn.state === "claimed" ||
      turn.state === "running" ||
      turn.state === "steering" ||
      (turn.state === "stopped" && turn.claim !== undefined) ||
      awaitsRateLimitSweep(turn),
  );
}

type QueueDeps = {
  sessionIds: () => string[];
  itemsForRuns: (sessionId: string, runs: Set<string>) => Item[];
  afterWrite: (sessionId: string, turns: Turn[]) => void;
  onChanged?: () => void;
};

/**
 * Each session's `queue.json`, its only writer, and the caches that writer keeps
 * in step: the parsed-queue cache, the index of sessions a worker could care
 * about, and the memo of turn states already folded into `turn_summaries`.
 */
export class SessionQueues {
  private readonly cache = new Map<string, SessionQueue>();
  private liveIndex: Set<string> | undefined;
  private readonly foldedTurnStates = new Map<string, Map<string, Turn["state"]>>();
  private changeAnnounced = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: QueueDeps,
  ) {
    kernel.onRollback(() => {
      this.cache.clear();
      this.liveIndex = undefined;
      this.changeAnnounced = false;
      this.foldedTurnStates.clear();
    });
    kernel.onSessionDeleted((id) => {
      this.cache.delete(id);
      this.liveIndex?.delete(id);
    });
  }

  /** Forgets every parsed queue and fold memo, as a restart would. */
  clear(): void {
    this.cache.clear();
    this.foldedTurnStates.clear();
  }

  /** A queue of the caller's own, safe to edit and hand back to `write`. */
  read(sessionId: string): SessionQueue {
    const file = sessionQueueFile(this.kernel.paths, sessionId);
    const stored = this.kernel.readDocument(file);
    if (stored === undefined) return emptyQueue(sessionId);
    this.kernel.accountWholeRead(file);
    this.kernel.readAccounting.queueParses += 1;
    return parseQueue(stored, sessionId, true);
  }

  /** The shared parsed copy, for reading only. */
  scan(sessionId: string): SessionQueue {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const queue = this.read(sessionId);
    this.cache.set(sessionId, queue);
    return queue;
  }

  liveSessionIds(): Set<string> {
    if (this.liveIndex) return this.liveIndex;
    const index = new Set<string>();
    for (const sessionId of this.deps.sessionIds()) {
      if (queueConcernsAWorker(this.scan(sessionId))) index.add(sessionId);
    }
    this.liveIndex = index;
    // The cold build touched every session; keep only what the index holds.
    for (const sessionId of this.cache.keys()) {
      if (!index.has(sessionId)) this.cache.delete(sessionId);
    }
    return index;
  }

  /** The only writer: validates, stores with its row index, and keeps every cache and projection level. */
  write(sessionId: string, queue: SessionQueue): void {
    if (!Turn.array().safeParse(queue.turns).success) {
      throw new EngineStateError("invalid_request", "invalid session queue");
    }
    this.kernel.writeIndexedDocument(
      sessionQueueFile(this.kernel.paths, sessionId),
      sessionQueueIndexFile(this.kernel.paths, sessionId),
      queue,
      "turns",
      queue.turns.map((turn) => ({ key: turn.runId, tag: turn.state })),
      queue,
    );
    this.reconcileTurnSummaries(sessionId, queue);
    this.cache.delete(sessionId);
    this.announceChange();
    this.deps.afterWrite(sessionId, queue.turns);
    if (!this.liveIndex) return;
    if (queueConcernsAWorker(queue)) this.liveIndex.add(sessionId);
    else this.liveIndex.delete(sessionId);
  }

  private knownTurnStates(sessionId: string): Map<string, Turn["state"]> {
    const cached = this.foldedTurnStates.get(sessionId);
    if (cached) return cached;
    const known = new Map<string, Turn["state"]>(
      this.kernel.executionStore.turnSummaryStates(sessionId).map((row) => [row.runId, row.state as Turn["state"]]),
    );
    if (this.foldedTurnStates.size >= FOLDED_TURNS_LIMIT) {
      const oldest = this.foldedTurnStates.keys().next();
      if (!oldest.done) this.foldedTurnStates.delete(oldest.value);
    }
    this.foldedTurnStates.set(sessionId, known);
    return known;
  }

  // Refolds only the turns whose state moved, and drops rows whose turn left the queue.
  private reconcileTurnSummaries(sessionId: string, queue: SessionQueue): void {
    const store = this.kernel.executionStore;
    const known = this.knownTurnStates(sessionId);
    const stale = queue.turns.filter((turn) => known.get(turn.runId) !== turn.state);
    const live = new Set(queue.turns.map((turn) => turn.runId));
    const gone = [...known.keys()].filter((runId) => !live.has(runId));
    if (stale.length === 0 && gone.length === 0) return;
    const items = stale.length > 0 ? this.deps.itemsForRuns(sessionId, new Set(stale.map((turn) => turn.runId))) : [];
    for (const turn of stale) {
      store.writeTurnSummary(summariseTurn(turn, items));
      known.set(turn.runId, turn.state);
    }
    for (const runId of gone) {
      store.deleteTurnSummary(sessionId, runId);
      known.delete(runId);
    }
  }

  // Once per committed command: a rolled-back write must not wake a worker.
  private announceChange(): void {
    const onChanged = this.deps.onChanged;
    if (!onChanged) return;
    if (!this.kernel.inCommand) {
      onChanged();
      return;
    }
    if (this.changeAnnounced) return;
    this.changeAnnounced = true;
    this.kernel.afterCommit(() => {
      this.changeAnnounced = false;
      this.deps.onChanged?.();
    });
  }
}
