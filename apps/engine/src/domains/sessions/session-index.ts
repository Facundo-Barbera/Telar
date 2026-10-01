import path from "node:path";
import { isShelved, settlingActivityOf, type Session, type Turn } from "@telar/engine-client";
import type { SessionIndexRow } from "../../platform/db/tables";
import { ID, type Kernel } from "../../platform/kernel";
import { parseSession, sessionMetadataFile } from "./metadata";
import type { SessionQueue } from "./queue";

type SettlingClock = { now: number; autoSettleAfterHours: number | null };
type Owner = { id: string; movesActivity: boolean };
export type LiveScope = "lean" | "all" | "shelf";

type IndexDeps = {
  withActivityFrom: (session: Session, turns: Turn[]) => Session;
  readQueue: (sessionId: string) => SessionQueue;
  autoSettleAfterHours: () => number | null;
};

/** A session narrowed to the scalars the rail decides on; spelled as a pick so new fields join deliberately. */
export const indexRow = (session: Session): SessionIndexRow => ({
  id: session.id,
  ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  state: session.state,
  updatedAt: session.updatedAt,
  createdAt: session.createdAt,
  archived: session.state === "archived",
  draft: session.draft !== undefined,
  ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  ...(session.settledOverride === undefined ? {} : { settledOverride: session.settledOverride }),
  ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
  ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
  ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
  ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
  ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
  ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
  ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
  ...(session.lastTurnFailed === undefined ? {} : { lastTurnFailed: session.lastTurnFailed }),
  activity: session.activity ?? "idle",
  ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
  ...(session.title === undefined ? {} : { title: session.title }),
  ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
});

/** The clients' own shelving rule, asked of a row instead of a record; the two must never disagree. */
export function rowIsShelved(row: SessionIndexRow, at: SettlingClock): boolean {
  return isShelved({ ...row, archived: row.archived, draft: row.draft }, settlingActivityOf(row), at);
}

/**
 * The `sessions` index rows, stored in the same transaction as the documents they fold,
 * and the live-list revision counters: `list` for membership, the others per side of the shelf.
 */
export class SessionIndex {
  private readonly dirtyRows = new Map<string, { movesActivity: boolean; queue?: SessionQueue }>();
  private revisionClock = Date.now();
  private listRevision = this.revisionClock;
  private unshelvedRevision = this.revisionClock;
  private shelvedRevision = this.revisionClock;
  private epoch = 0;
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: IndexDeps,
  ) {
    kernel.onWrite((file, write, written) => {
      const owner = this.ownerOf(file);
      this.inRowTransaction(owner, write, written as SessionQueue | undefined);
      this.bumpFor(file, owner);
    });
    kernel.beforeCommit(() => this.flush());
    kernel.onRollback(() => this.dirtyRows.clear());
    kernel.onSessionDeleted((id) => {
      this.dirtyRows.delete(id);
      this.generations.delete(id);
      this.bumpMembership();
    });
  }

  /** The cursor for one shape of the live list: unshelved rows, the shelf alone, or both. */
  revision(scope: LiveScope): number {
    if (scope === "shelf") return Math.max(this.listRevision, this.shelvedRevision);
    const base = Math.max(this.listRevision, this.unshelvedRevision);
    return scope === "all" ? Math.max(base, this.shelvedRevision) : base;
  }

  stamp(sessionId: string): string {
    return `${this.epoch}:${this.generations.get(sessionId) ?? 0}`;
  }

  bumpList(): void {
    this.epoch += 1;
    this.bumpMembership();
  }

  /** Moves the counter of the list this row is on, for a change the row itself doesn't carry. */
  bumpRow(row: SessionIndexRow, at: SettlingClock): void {
    if (row.state !== "active" || rowIsShelved(row, at)) this.shelvedRevision = this.nextRevision();
    else this.unshelvedRevision = this.nextRevision();
  }

  /** The store's clock and the settling window, read once per pass. */
  settlingClock(): SettlingClock {
    return { now: this.kernel.now(), autoSettleAfterHours: this.deps.autoSettleAfterHours() };
  }

  /** Builds missing rows and drops orphaned ones; empty on every open but the first. */
  backfill(): { built: number; removed: number } {
    const store = this.kernel.executionStore;
    const { missing, orphaned } = store.sessionRowGaps();
    if (missing.length === 0 && orphaned.length === 0) return { built: 0, removed: 0 };
    this.kernel.command("backfillSessionIndex", () => {
      for (const id of orphaned) store.deleteSessionRow(id);
      for (const id of missing) this.store(id);
    });
    return { built: missing.length, removed: orphaned.length };
  }

  private bumpMembership(): void {
    this.listRevision = this.nextRevision();
  }

  private nextRevision(): number {
    this.revisionClock += 1;
    return this.revisionClock;
  }

  // Matched on the path so a new writer can't forget. A metadata-only write can't move the activity fields.
  private ownerOf(file: string): Owner | undefined {
    const name = path.basename(file);
    if (name !== "session.json" && name !== "queue.json" && name !== "requests.json" && name !== "tasks.json") return undefined;
    const relative = path.relative(this.kernel.paths.sessions, path.dirname(file));
    if (!relative || relative.startsWith("..") || !ID.test(relative)) return undefined;
    return { id: relative, movesActivity: name !== "session.json" };
  }

  private inRowTransaction(owner: Owner | undefined, write: () => void, written?: SessionQueue): void {
    if (owner === undefined) return write();
    if (this.kernel.inCommand) {
      write();
      const owed = this.dirtyRows.get(owner.id);
      // Activity is OR-ed across the command's writes; the latest queue written wins.
      this.dirtyRows.set(owner.id, {
        movesActivity: (owed?.movesActivity ?? false) || owner.movesActivity,
        queue: written ?? owed?.queue,
      });
      return;
    }
    this.kernel.executionStore.atomically(() => {
      write();
      this.store(owner.id, owner.movesActivity, undefined, written);
    });
  }

  // One clock for the whole flush, so rows compared against each other share a window.
  private flush(): void {
    if (this.dirtyRows.size === 0) return;
    const owed = [...this.dirtyRows];
    this.dirtyRows.clear();
    const at = this.settlingClock();
    for (const [sessionId, row] of owed) this.store(sessionId, row.movesActivity, at, row.queue);
  }

  /**
   * Folds one session into its row. Without `movesActivity` the five folded
   * fields are carried from the stored row, sparing a queue parse; `written`
   * is the queue this command already holds.
   */
  private store(sessionId: string, movesActivity = true, at = this.settlingClock(), written?: SessionQueue): void {
    const store = this.kernel.executionStore;
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    const stored = this.kernel.readDocument(sessionMetadataFile(this.kernel.paths, sessionId));
    const before = store.sessionRow(sessionId);
    if (stored === undefined) {
      store.deleteSessionRow(sessionId);
      if (before) this.bumpMembership();
      return;
    }
    let record: Session;
    try {
      record = parseSession(stored);
    } catch {
      return;
    }
    const folded = movesActivity || before === undefined
      ? this.deps.withActivityFrom(record, (written ?? this.deps.readQueue(sessionId)).turns)
      : {
          ...record,
          activity: before.activity,
          ...(before.activityAt === undefined ? {} : { activityAt: before.activityAt }),
          ...(before.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: before.lastTurnEndedAt }),
          ...(before.lastTurnFailed === undefined ? {} : { lastTurnFailed: before.lastTurnFailed }),
          ...(before.lastTurnSequence === undefined ? {} : { lastTurnSequence: before.lastTurnSequence }),
        };
    const row = indexRow(folded);
    store.writeSessionRow(row);
    this.noteRevision(before, row, at);
  }

  // Only the documents the live list reads beside its rows move `list`; a session's own write is attributed by its row.
  private bumpFor(file: string, owner: Owner | undefined): void {
    if (owner !== undefined) return;
    const paths = this.kernel.paths;
    if (file === paths.projects || file === paths.sidebarLayout || file === paths.inbox || file === paths.subscriptions || file === paths.cohorts) {
      this.bumpList();
    }
  }

  // Crossing between list and shelf is membership, which every reader must see.
  private noteRevision(before: SessionIndexRow | undefined, after: SessionIndexRow, at: SettlingClock): void {
    const shelved = after.state !== "active" || rowIsShelved(after, at);
    const wasShelved = before === undefined ? undefined : before.state !== "active" || rowIsShelved(before, at);
    if (before === undefined || wasShelved !== shelved) {
      this.bumpMembership();
      return;
    }
    if (shelved) this.shelvedRevision = this.nextRevision();
    else this.unshelvedRevision = this.nextRevision();
  }
}
