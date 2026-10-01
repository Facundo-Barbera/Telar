import fs from "node:fs";
import path from "node:path";
import {
  isShelved,
  settlingActivityOf,
  type Project,
  type ReleasableState,
  type Session,
  type WorktreeInventory,
  type WorktreeReclaimItem,
  type WorktreeReclaimResult,
  type WorktreeSummary,
} from "@telar/engine-client";
import type { AsyncGitRunner } from "../../platform/git/runner";
import type { Kernel } from "../../platform/kernel";
import type { ProjectAvailability } from "../../platform/fs/volumes";
import { existsWithin, VolumeGate, type VolumeProbe } from "../../platform/fs/volume-gate";
import { parseSession, sessionDir, sessionMetadataFile, storedSession, type SessionRecords } from "../sessions";
import { planWorktreeCleanup, sweepCheckouts, sweepLogs, type CheckoutSizes, type CleanupStore, type PlannedRelease, type ReapCandidate, type SweepOutcome } from "../storage";
import { lockSessionWorktree, removeUnregisteredCheckout } from "./checkout";
import { liveCheckouts, lockCheckouts } from "./boot-pass";
import { cleanupCandidates } from "./cleanup-sweep";
import { buildInventory, type InventoryProject, type InventorySession } from "./inventory";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf, worktreesRootBlocker } from "./location";
import { moveCheckouts, type Checkout, type MoveOutcome } from "./move";
import { checkoutsWithProcesses, reattachSessionWorktreeAsync, releaseRefusal, type ReleaseRefusal } from "./release";
import { removeSessionWorktreeAsync, type WorktreeQueue } from "./session-worktree";
import { countedRows, stateOf, summarizeWorktrees, type SessionFacts } from "./summary";

const SUMMARY_TTL_MS = 60_000;
const DEFAULT_IDLE_DAYS = 7;

type MaintenanceDeps = {
  records: SessionRecords;
  git: AsyncGitRunner;
  queue: WorktreeQueue;
  cleanup: CleanupStore;
  checkoutSizes: CheckoutSizes;
  getProject: (projectId: string) => Project;
  listProjects: () => Project[];
  availability: (project: Project) => ProjectAvailability;
  forgetGitReadsUnder: (root: string) => void;
  setupRunning: (sessionId: string) => boolean;
  startSetup: (sessionId: string, worktree: string) => Promise<void>;
  openTerminals: (sessionId: string) => number;
  hasLiveBackgroundWork: (sessionId: string) => boolean;
  autoSettleAfterHours: () => number | null;
  archiveSession: (sessionId: string, options: { releaseCheckout: boolean }) => unknown;
  probeVolume?: VolumeProbe;
};

/** The checkouts a store holds after they are cut: release, restore, sweep, lock, move, inventory and reclaim. */
export class WorktreeMaintenance {
  private cleanupRunning = false;
  private checked?: { inventory: WorktreeInventory; at: number };
  private checking?: Promise<WorktreeInventory>;
  private readonly locked = new Set<string>();
  readonly volumes: VolumeGate;

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: MaintenanceDeps,
  ) {
    this.volumes = new VolumeGate(deps.probeVolume);
  }

  /** Gives a session's checkout back, keeping its branch; refused with nothing touched while anything could still use it. `strict` is the sweep's. */
  async release(
    sessionId: string,
    reason: "manual" | "inactive" | "settled" | "unchanged" | "archived",
    options: { strict?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; refusal: ReleaseRefusal | "in-use" | "not-worktree"; detail?: string }> {
    const session = this.deps.records.get(sessionId);
    if (session.workspace.mode !== "worktree" || !session.projectId) return { ok: false, refusal: "not-worktree" };
    if (session.workspace.released) return { ok: true };
    if (session.activity !== "idle" || session.preparation !== undefined || this.deps.setupRunning(sessionId)) {
      return { ok: false, refusal: "in-use" };
    }
    const openTerminals = this.deps.openTerminals(sessionId);
    if (openTerminals > 0) {
      return { ok: false, refusal: "process", detail: `${openTerminals} terminal${openTerminals === 1 ? " is" : "s are"} open in this session` };
    }
    const project = this.deps.getProject(session.projectId);
    const workspace = session.workspace;
    const location = readWorktreesRoot(this.kernel.paths.root);
    const configured = rootOf(location);
    const roots = [defaultWorktreesRoot(this.kernel.paths.root), ...(configured ? [configured] : [])];
    const processes = await checkoutsWithProcesses([workspace.path]);
    const checked = await releaseRefusal(this.deps.git, {
      projectRoot: project.root,
      worktreesRoots: roots,
      path: workspace.path,
      branch: workspace.branch,
      process: processes === undefined ? undefined : processes.has(workspace.path),
      strict: options.strict === true,
    });
    if (checked.refusal) return { ok: false, refusal: checked.refusal, ...(checked.detail ? { detail: checked.detail } : {}) };

    const removed = await this.deps.queue(project.root, () =>
      removeSessionWorktreeAsync(this.deps.git, project.root, workspace.path, this.deps.availability(project)),
    );
    this.deps.forgetGitReadsUnder(project.root);
    this.deps.forgetGitReadsUnder(workspace.path);
    if (!removed) return { ok: false, refusal: "not-found", detail: "the checkout is still there" };

    // Re-read: seconds passed while git ran.
    const current = this.deps.records.get(sessionId);
    if (current.workspace.mode !== "worktree") return { ok: true };
    const updated: Session = {
      ...current,
      workspace: { ...current.workspace, released: { at: this.kernel.now(), reason } },
      updatedAt: this.kernel.now(),
    };
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(updated));
    this.kernel.appendEvent(sessionId, { type: "session.updated", session: updated });
    return { ok: true };
  }

  /** One sweep of the Storage switches; a second call while one runs does nothing. */
  async runCleanup(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const policy = this.deps.cleanup.policy();
      const now = this.kernel.now();
      const sessions = this.deps.records.read();
      const plan = planWorktreeCleanup(cleanupCandidates(sessions, { now, autoSettleAfterHours: this.deps.autoSettleAfterHours() }), policy, now);
      const swept = await sweepCheckouts(plan, {
        release: (item) => this.sweepRelease(item),
        sizeOf: (target) => this.deps.checkoutSizes.known(target),
        gate: this.volumes,
      });
      let { freedBytes } = swept;
      const { released, skipped } = swept;
      let logs = 0;
      if (policy.logsDays !== null) {
        const gone = new Set(
          sessions.filter((session) => session.workspace.mode === "worktree" && session.workspace.released).map((session) => session.id),
        );
        const swept = await sweepLogs({
          logDirectories: [this.kernel.paths.diagnostics],
          setupLogs: [...gone].map((sessionId) => path.join(sessionDir(this.kernel.paths, sessionId), "setup.log")),
          days: policy.logsDays,
          now,
        });
        logs = swept.count;
        freedBytes += swept.bytes;
      }
      this.deps.cleanup.record({ at: this.kernel.now(), freedBytes, released, logs, skipped });
    } finally {
      this.cleanupRunning = false;
    }
  }

  private async sweepRelease({ sessionId, reason }: PlannedRelease): Promise<SweepOutcome> {
    const session = this.deps.records.get(sessionId);
    if (session.workspace.mode !== "worktree" || !session.projectId) return "ignored";
    if (reason === "unchanged" && !(await this.branchUnchanged(session.projectId, session.workspace.branch))) return "ignored";
    if (!(await existsWithin(this.volumes, session.workspace.path))) return "ignored";
    return (await this.release(sessionId, reason, { strict: true })).ok ? "released" : "skipped";
  }

  isCleanupRunning(): boolean {
    return this.cleanupRunning;
  }

  // Zero commits past the default branch; a git read that did not answer counts as changed, since this licenses a delete.
  private async branchUnchanged(projectId: string, branch: string): Promise<boolean> {
    const project = this.deps.getProject(projectId);
    for (const base of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
      const exists = await this.deps.git(project.root, ["rev-parse", "--verify", "--quiet", base]);
      if (exists.status !== 0) continue;
      const ahead = await this.deps.git(project.root, ["rev-list", "--count", `${base}..refs/heads/${branch}`]);
      return ahead.status === 0 && !ahead.timedOut && ahead.stdout.trim() === "0";
    }
    return false;
  }

  /** Re-cuts a released checkout at the same path and branch, then runs its setup; idempotent. */
  restore(sessionId: string): Session {
    const session = this.deps.records.get(sessionId);
    if (session.workspace.mode !== "worktree" || !session.workspace.released || session.preparation?.state === "preparing") {
      return session;
    }
    if (!session.projectId) return session;
    const project = this.deps.getProject(session.projectId);
    const { released: _released, ...workspace } = session.workspace;
    const updated: Session = {
      ...session,
      workspace,
      preparation: { state: "preparing", at: this.kernel.now() },
      updatedAt: this.kernel.now(),
    };
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(updated));
    this.kernel.appendEvent(sessionId, { type: "session.updated", session: updated });
    void this.deps.queue(project.root, async () => {
      try {
        await reattachSessionWorktreeAsync(this.deps.git, {
          projectRoot: project.root,
          path: workspace.path,
          branch: workspace.branch,
        });
        this.settle(sessionId, undefined);
        void this.deps.startSetup(sessionId, workspace.path);
      } catch (error) {
        this.settle(sessionId, error instanceof Error ? error.message : String(error));
      } finally {
        this.deps.forgetGitReadsUnder(project.root);
        this.deps.forgetGitReadsUnder(workspace.path);
      }
    });
    return updated;
  }

  /** Records how a cut ended on the row as it is now, since the session may have changed while git ran. */
  settle(sessionId: string, failure: string | undefined): void {
    const existing = this.kernel.readDocument(sessionMetadataFile(this.kernel.paths, sessionId));
    if (existing === undefined) return;
    const session = parseSession(existing);
    const updated: Session = {
      ...session,
      // Absent is READY. A success clears the key rather than writing a third
      // state, so every reader's "is this ready" is one question.
      ...(failure === undefined ? {} : { preparation: { state: "failed" as const, error: failure, at: this.kernel.now() } }),
      updatedAt: this.kernel.now(),
    };
    if (failure === undefined) delete updated.preparation;
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(updated));
    this.kernel.appendEvent(sessionId, { type: "session.updated", session: updated });
  }

  /** Archived sessions' unreleased checkouts, with whether anything live still uses them; no fs, so history costs nothing. */
  reapable(): ReapCandidate[] {
    return this.deps.records.read().flatMap((session) => {
      if (session.state !== "archived" || session.workspace.mode !== "worktree" || session.workspace.released || !session.projectId) return [];
      const activity = settlingActivityOf(this.kernel.executionStore.sessionRow(session.id) ?? { activity: session.activity });
      return [{
        sessionId: session.id,
        worktree: session.workspace.path,
        archived: true,
        live:
          activity.working === true ||
          activity.waitingOnYou === true ||
          this.deps.hasLiveBackgroundWork(session.id) ||
          // A dev server in an open terminal is reading those node_modules.
          this.deps.openTerminals(session.id) > 0,
      }];
    });
  }

  /** Locks the live sessions' checkouts, skipping any on a volume that is slow or gone; settled ones lock on reopen. */
  async lockLive(): Promise<{ locked: number }> {
    const at = { now: this.kernel.now(), autoSettleAfterHours: this.deps.autoSettleAfterHours() };
    const checkouts = liveCheckouts(this.deps.records.read(), at);
    const roots = new Map(checkouts.flatMap((checkout) => {
      const project = this.projectOf(checkout.projectId);
      return project ? [[checkout.projectId, project.root] as const] : [];
    }));
    await this.volumes.admit([...roots.values()]);
    const locked = await lockCheckouts(checkouts, this.volumes, (checkout) => {
      const root = roots.get(checkout.projectId);
      if (root === undefined || !this.volumes.open(root)) return Promise.resolve();
      return this.deps.queue(root, () => lockSessionWorktree(this.deps.git, root, checkout.path));
    });
    for (const sessionId of locked) this.locked.add(sessionId);
    return { locked: locked.length };
  }

  /** A message to a session: a released checkout is cut again, and one not locked since this engine started is locked. */
  reopen(sessionId: string): void {
    const session = this.deps.records.get(sessionId);
    if (session.workspace.mode !== "worktree" || !session.projectId) return;
    if (session.workspace.released) {
      this.restore(sessionId);
      return;
    }
    if (this.locked.has(sessionId)) return;
    const project = this.projectOf(session.projectId);
    if (!project) return;
    this.locked.add(sessionId);
    const worktreePath = session.workspace.path;
    void this.deps.queue(project.root, () => lockSessionWorktree(this.deps.git, project.root, worktreePath));
  }

  private projectOf(projectId: string): Project | undefined {
    try {
      return this.deps.getProject(projectId);
    } catch {
      return undefined;
    }
  }

  /** Re-cuts the checkouts on disk (only those directly under `from`, when given) under a new root, on the per-project queues so a move never races a cut. */
  async move(destination: string, from?: string): Promise<MoveOutcome> {
    this.forgetSummary();
    const source = from === undefined ? undefined : path.resolve(from);
    const checkouts: Checkout[] = [];
    for (const session of this.deps.records.read()) {
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      if (source !== undefined && path.dirname(path.resolve(session.workspace.path)) !== source) continue;
      if (!fs.existsSync(session.workspace.path)) continue;
      let project: Project;
      try {
        project = this.deps.getProject(session.projectId);
      } catch {
        continue; // A removed project is not one to re-cut against.
      }
      checkouts.push({
        sessionId: session.id,
        path: session.workspace.path,
        branch: session.workspace.branch ?? "",
        projectRoot: project.root,
        busy: session.activity !== "idle",
      });
    }
    const roots = [...new Set(checkouts.map((checkout) => checkout.projectRoot))];
    const run = () =>
      moveCheckouts(this.deps.git, {
        checkouts,
        destination,
        onMoved: (sessionId, to) => this.recordMove(sessionId, to),
      });
    // One queue is enough to serialise against cuts; with several projects the
    // queues nest, which is the same ordering guarantee one at a time.
    return roots.reduce<() => Promise<MoveOutcome>>((next, root) => () => this.deps.queue(root, next), run)();
  }

  /** The facts only the store knows, handed to `buildInventory`, which decides what may be reclaimed. */
  async inventory(): Promise<WorktreeInventory> {
    const location = readWorktreesRoot(this.kernel.paths.root);
    const configured = rootOf(location);
    const fallback = defaultWorktreesRoot(this.kernel.paths.root);
    const roots = configured && configured !== fallback ? [configured, fallback] : [fallback];
    const at = { now: this.kernel.now(), autoSettleAfterHours: this.deps.autoSettleAfterHours() };

    const projects: InventoryProject[] = this.deps.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      available: this.deps.availability(project) === "available",
    }));

    const sessions: InventorySession[] = [];
    for (const session of this.deps.records.read()) {
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      const settleable = { ...session, archived: session.state === "archived", draft: session.draft !== undefined };
      const lifecycle =
        session.state === "archived" ? "archived" : isShelved(settleable, settlingActivityOf(session), at) ? "settled" : "live";
      sessions.push({
        id: session.id,
        ...(session.title ? { title: session.title } : {}),
        path: session.workspace.path,
        ...(session.workspace.branch ? { branch: session.workspace.branch } : {}),
        projectId: session.projectId,
        lifecycle,
        // `moveWorktrees`' predicate, and #671's rung 1. See
        // `worktree-inventory.ts` for why this is a policy asserted up front
        // rather than a git lock waiting to refuse.
        busy: session.activity !== "idle",
      });
    }

    return buildInventory(
      {
        git: this.deps.git,
        measure: async (target) => this.deps.checkoutSizes.peek(target, roots),
      },
      {
        // Both roots while a #642 move is half-done — `readStorage`'s reason,
        // and the same pair it passes.
        roots,
        rootsReadable: location.kind !== "absent" && location.kind !== "unreadable",
        ...(worktreesRootBlocker(location) ? { blocker: worktreesRootBlocker(location)! } : {}),
        sessions,
        projects,
        // The tree this daemon is executing from, when it is executing from
        // one. On the machine Telar is developed on that is a worktree of
        // Telar, and it must never be offered for reclamation.
        engineRoot: process.cwd(),
        now: at.now,
      },
    );
  }

  forgetSummary(): void {
    this.checked = undefined;
  }

  /** Counts and sizes per location and state. Git is asked at most once a minute; sizes are re-read every time. */
  async summary(options: { refresh?: boolean } = {}): Promise<WorktreeSummary> {
    const [inventory] = await Promise.all([this.checkedInventory(options.refresh === true), this.volumes.recheck()]);
    const degraded = [...this.volumes.degraded].map(([mount, state]) => ({ mount, state }));
    return { ...summarizeWorktrees(this.summaryInput(inventory)), ...(degraded.length > 0 ? { degradedVolumes: degraded } : {}) };
  }

  /** Gives back every worktree in `state` that is proven safe to lose; nothing that needs a typed confirmation. */
  async releaseState(state: ReleasableState): Promise<WorktreeReclaimResult[]> {
    const input = this.summaryInput(await this.inventory());
    const rows = countedRows(input).filter((row) => row.verdict.kind === "reclaimable" && stateOf(row, input) === state);
    return this.reclaim(rows.map((row) => ({ path: row.path })));
  }

  private async checkedInventory(refresh: boolean): Promise<WorktreeInventory> {
    if (!refresh && this.checked && this.kernel.now() - this.checked.at < SUMMARY_TTL_MS) return this.checked.inventory;
    this.checking ??= this.inventory()
      .then((inventory) => {
        this.checked = { inventory, at: this.kernel.now() };
        return inventory;
      })
      .finally(() => (this.checking = undefined));
    return this.checking;
  }

  private summaryInput(inventory: WorktreeInventory) {
    const sessions = new Map<string, SessionFacts>();
    for (const session of this.deps.records.read()) {
      if (session.workspace.mode !== "worktree") continue;
      sessions.set(session.id, {
        lastActiveAt: Math.max(session.updatedAt, session.lastTurnEndedAt ?? 0, session.activityAt ?? 0),
        released: session.workspace.released !== undefined,
      });
    }
    const rows = inventory.rows.map((row) => {
      const bytes = this.deps.checkoutSizes.peek(row.path, inventory.roots).bytes ?? row.bytes;
      return bytes === undefined ? row : { ...row, bytes };
    });
    const current = rootOf(readWorktreesRoot(this.kernel.paths.root));
    return {
      inventory: { ...inventory, rows },
      sessions,
      ...(current ? { current } : {}),
      defaultRoot: defaultWorktreesRoot(this.kernel.paths.root),
      idleDays: this.deps.cleanup.policy().inactiveDays ?? DEFAULT_IDLE_DAYS,
      now: this.kernel.now(),
      exists: (folder: string) => fs.existsSync(folder),
    };
  }

  /** Releases, archives or removes each item, re-proving every refusal here rather than trusting the listing. */
  async reclaim(items: readonly WorktreeReclaimItem[]): Promise<WorktreeReclaimResult[]> {
    this.forgetSummary();
    const inventory = await this.inventory();
    const byPath = new Map(inventory.rows.map((row) => [path.resolve(row.path), row]));
    const results: WorktreeReclaimResult[] = [];

    for (const item of items) {
      const row = byPath.get(path.resolve(item.path));
      if (!row) {
        results.push({ path: item.path, ok: false, refusal: "not-found" });
        continue;
      }
      if (row.verdict.kind === "locked") {
        results.push({ path: row.path, ok: false, refusal: row.verdict.reason });
        continue;
      }
      if (row.verdict.kind === "needs-force") {
        // THE BASENAME, TYPED. Not ceremony: these are the rows where Telar
        // could NOT prove the work is safe, so the person is being asked to say
        // they looked — which a checkbox cannot express.
        if (item.confirm === undefined) {
          results.push({ path: row.path, ok: false, refusal: "needs-confirm" });
          continue;
        }
        if (item.confirm.trim() !== row.basename) {
          results.push({ path: row.path, ok: false, refusal: "confirm-mismatch" });
          continue;
        }
      }

      const bytes = row.bytes;
      try {
        if (row.owner.kind === "session" && row.owner.lifecycle === "settled" && item.settled !== "archive") {
          // RELEASE IS THE DEFAULT: the checkout goes, the
          // session and its branch stay, and the next message brings it back.
          const released = await this.release(row.owner.sessionId, "manual");
          results.push(
            released.ok
              ? { path: row.path, ok: true, action: "released", sessionId: row.owner.sessionId, ...(bytes === undefined ? {} : { bytes }) }
              : {
                  path: row.path,
                  ok: false,
                  refusal:
                    released.refusal === "in-use" || released.refusal === "dirty" || released.refusal === "unpushed" || released.refusal === "process" || released.refusal === "not-found"
                      ? released.refusal
                      : "failed",
                  ...(released.detail ? { detail: released.detail } : {}),
                },
          );
          continue;
        }
        if (row.owner.kind === "session" && row.owner.lifecycle === "settled") {
          // The supported path, which releases the checkout on the project
          // queue as part of putting the session down.
          this.deps.archiveSession(row.owner.sessionId, { releaseCheckout: true });
          results.push({
            path: row.path,
            ok: true,
            action: "archived",
            sessionId: row.owner.sessionId,
            ...(bytes === undefined ? {} : { bytes }),
          });
          continue;
        }
        const project = row.projectId ? this.deps.getProject(row.projectId) : undefined;
        const removed =
          row.registered && project
            ? await this.deps.queue(project.root, () =>
                removeSessionWorktreeAsync(this.deps.git, project.root, row.path, this.deps.availability(project)),
              )
            : removeUnregisteredCheckout(row.path, inventory.roots);
        if (!removed) {
          results.push({ path: row.path, ok: false, refusal: "failed", detail: "the checkout is still there" });
          continue;
        }
        results.push({ path: row.path, ok: true, action: "removed", ...(bytes === undefined ? {} : { bytes }) });
      } catch (cause) {
        results.push({
          path: row.path,
          ok: false,
          refusal: "failed",
          detail: cause instanceof Error ? cause.message : "the checkout could not be given back",
        });
      }
    }
    return results;
  }

  private recordMove(sessionId: string, to: string): void {
    const session = this.deps.records.get(sessionId);
    const updated: Session = {
      ...session,
      workspace: { ...session.workspace, path: to } as Session["workspace"],
      updatedAt: this.kernel.now(),
    };
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(updated));
    this.kernel.appendEvent(sessionId, { type: "session.updated", session: updated });
  }
}
