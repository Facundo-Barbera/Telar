import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ATTENDED_RUNTIME_MODE,
  DEFAULT_DETACHED_RUNTIME_MODE,
  defaultInstanceIdForDriver,
  ModelSelection,
  narrowerRuntimeMode,
  type AgentModelChoice,
  type EngineEvent,
  type EnvMode,
  type ModelCatalogue,
  type ModelSelection as ModelSelectionValue,
  type Project,
  type ProviderDriverKind,
  type ProviderInstance,
  type RuntimeMode,
  type Session,
  type SessionOrigin,
  type Turn,
} from "@telar/engine-client";
import type { AsyncGitRunner, GitRunner } from "../../platform/git/runner";
import type { ProjectAvailability } from "../../platform/fs/volumes";
import { assertId, EngineStateError, type JournalEntry, type Kernel } from "../../platform/kernel";
import { removeTelarVenv, telarVenvDir } from "../plugins";
import { RUNTIME_MODES } from "../settings";
import { createSessionWorktreeAsync, derivedBranchFor, isGitWorkTree, prepareSessionWorktree, pruneBuildOutputs, removeSessionWorktreeAsync, type WorktreePlan, type WorktreeQueue } from "../worktrees";
import { parseSession, releaseDelegationSettle, sessionDir, sessionMetadataFile, storedSession } from "./metadata";
import { emptyQueue, type SessionQueue } from "./queue";
import type { SessionRecords } from "./records";
import type { SessionSubscriptions } from "./subscriptions";

export type CreateSessionInput = {
  draft?: boolean;
  id?: string;
  /** Optional: absent means the session belongs to no project, so asking for a worktree is refused. */
  projectId?: string;
  /** Who started this session, from the creating turn's verified claim; no permission travels with it. */
  startedFrom?: { sessionId: string; runId?: string };
  /**
   * A session id whose runtime mode this one may not exceed: an agent's child never has more access than its creator.
   * Read once, stored nowhere, and refused when it names nothing, because ignoring it would give the widest session.
   */
  ceilingFrom?: string;
  title?: string;
  detached?: boolean;
  envMode?: EnvMode;
  driver?: ProviderDriverKind;
  /** A configured login; naming one also names the driver, so `driver` is then ignored. */
  providerInstanceId?: string;
  /** A caller-proposed worktree branch under `loom/` or `telar/`; absent, it derives from the title. */
  branchSlug?: string;
  /** What a worktree is cut from, resolved to a sha at creation; absent means HEAD. */
  baseRef?: string;
  /** A human's own name for the new branch — see `sanitizeBranchName`. */
  branchName?: string;
  workspace?: { path: string; branch: string; baseRef?: string };
  /** Provenance only: `"session"` means the `sessions` toolkit asked. Set by the caller's code, never by a model argument. */
  origin?: SessionOrigin;
  model?: AgentModelChoice;
  purpose?: Session["purpose"];
};

/** What the session lifecycle still asks of the store around it. */
type LifecycleHost = {
  git: GitRunner;
  worktreeGit: AsyncGitRunner;
  worktreeQueue: WorktreeQueue;
  getProject(projectId: string): Project;
  assertProjectAvailable(projectId: string): void;
  projectAvailability(project: Project): ProjectAvailability;
  projectOfSession(session: Session): Project | undefined;
  sessionDefaults(): { envMode?: EnvMode; runtimeMode?: RuntimeMode };
  requireInstance(instanceId: string): ProviderInstance;
  cachedModels(driver: ProviderDriverKind): ModelCatalogue["models"] | undefined;
  chooseModel(driver: ProviderDriverKind, instanceId: string, choice: AgentModelChoice): ModelSelectionValue | undefined;
  readQueue(sessionId: string): SessionQueue;
  writeQueue(sessionId: string, queue: SessionQueue): void;
  appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent;
  settleWorktree(sessionId: string, error: string | undefined): void;
  forgetGitReadsUnder(root: string): void;
  /** Runs the project's `setup.command` in the new checkout, in the background; best-effort. */
  startSetup(sessionId: string, worktree: string): Promise<void>;
  releaseBrowser(sessionId: string, reason: string): Promise<unknown> | void;
  releasePlugins(sessionId: string, reason: string): void;
  releasesArchivedCheckouts(): boolean;
};

/** Creating, updating, archiving and deleting a session, with the checkout each of those cuts or gives back. */
export class SessionLifecycle {
  constructor(
    private readonly kernel: Kernel,
    private readonly records: SessionRecords,
    private readonly subscriptions: SessionSubscriptions,
    private readonly host: LifecycleHost,
  ) {}

  createSession(input: CreateSessionInput): Session {
    return this.kernel.command("createSession", () => {
      if (input.id !== undefined) assertId(input.id, "session id");
      // Both reads are about a project, so both are skipped when there is none —
      // never replaced by a guess at which project was meant.
      const project = input.projectId === undefined ? undefined : this.host.getProject(input.projectId);
      if (input.projectId !== undefined) this.host.assertProjectAvailable(input.projectId);
      if (project === undefined && input.envMode === "worktree") {
        throw new EngineStateError("invalid_request", "a worktree is cut from a project, and this session has none");
      }
      const id = input.id ?? `session_${crypto.randomUUID().replaceAll("-", "")}`;
      const metadata = sessionMetadataFile(this.kernel.paths, id);
      const existing = this.kernel.readDocument(metadata);
      if (existing !== undefined) {
        const session = parseSession(existing);
        if (session.projectId === input.projectId) return structuredClone(session);
        throw new EngineStateError("conflict", "session id is already owned by another project");
      }
      const at = this.kernel.now();
      const detached = input.detached ?? true;
      const ceiling = input.ceilingFrom === undefined ? undefined : this.records.get(input.ceilingFrom).runtimeMode;
      const availability = project === undefined ? undefined : this.host.projectAvailability(project);
      const preferred = project === undefined ? "local" : (project.envMode ?? this.host.sessionDefaults().envMode);
      const envMode =
        project === undefined ? "local" : (input.envMode ?? (preferred === "worktree" && isGitWorkTree(this.host.git, project.root) ? "worktree" : "local"));
      if (input.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(input.baseRef)) {
        throw new EngineStateError("invalid_request", "base ref is not a usable git ref name");
      }
      const chosen = input.providerInstanceId === undefined ? undefined : this.host.requireInstance(input.providerInstanceId);
      const driver = chosen?.driver ?? input.driver ?? "claude";
      if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
        throw new EngineStateError("invalid_request", "unknown provider driver");
      }
      if (chosen && !chosen.enabled) throw new EngineStateError("conflict", "that provider instance is switched off");
      const instanceId = chosen?.id ?? defaultInstanceIdForDriver(driver);
      const picked = input.model ? this.host.chooseModel(driver, instanceId, input.model) : undefined;
      const cut =
        envMode === "worktree" && !input.draft && project !== undefined
          ? (() => {
              const branchSlug = input.branchSlug ?? derivedBranchFor(input.title ?? "", id);
              return prepareSessionWorktree(this.host.git, {
                engineRoot: this.kernel.paths.root,
                projectRoot: project.root,
                projectName: project.name,
                sessionId: id,
                ...(availability !== undefined ? { availability } : {}),
                ...(branchSlug !== undefined ? { branchSlug } : {}),
                ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
                ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
              });
            })()
          : undefined;
      const workspace: Session["workspace"] =
        cut !== undefined
          ? // `baseRef` is stored NOW rather than when the cut lands: it is the
            // commit the checkout will start from, so a reader asking "what has
            // this session done" has its anchor from the first instant.
            { mode: "worktree" as const, path: cut.plan.path, branch: cut.plan.branch, baseRef: cut.baseSha }
          : project === undefined
            ? // NO PROJECT MEANS NO DIRECTORY — see `SessionWorkspace`'s `none`
              // variant. There is nothing to resolve a base against either: a
              // base is a commit, and there is no repository here.
              { mode: "none" as const }
            : (() => {
              const head = this.host.git(project.root, ["rev-parse", "HEAD"]);
              const baseRef = head.status === 0 ? head.stdout.trim() : "";
              return { mode: "local" as const, path: project.root, ...(baseRef ? { baseRef } : {}) };
            })();
      const session: Session = {
        id,
        // Written only when there IS one. An explicit `undefined` would be a
        // second spelling of absent on a field whose absence is the statement.
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        environmentId: "local",
        title: input.title?.trim() || "New session",
        state: "active",
        // Only ever written when it is TRUE. An explicit `"human"` on every
        // session document would be a second spelling of absent, and the two
        // would drift the first time a reader forgot one of them.
        ...(input.origin === "session" ? { origin: "session" as const } : {}),
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.startedFrom
          ? { startedFrom: { sessionId: input.startedFrom.sessionId, ...(input.startedFrom.runId ? { runId: input.startedFrom.runId } : {}) } }
          : {}),
        createdAt: at,
        updatedAt: at,
        providerInstanceId: instanceId,
        driver,
        ...(() => {
          if (picked) return { model: picked };
          if (!project?.defaultModel || project.defaultModel.instanceId !== instanceId) return {};
          const model = this.supportedOptions(driver, project.defaultModel);
          return model ? { model } : {};
        })(),
        workspace,
        // The directory is not there yet; `prepareWorktree` below clears this or
        // flips it to `failed`. Absent means ready, which is every other session.
        ...(cut !== undefined ? { preparation: { state: "preparing" as const, at } } : {}),
        envMode,
        ...(input.draft ? { draft: {
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
          ...(input.branchName ? { branchName: input.branchName } : {}),
          ...(input.branchSlug ? { branchSlug: input.branchSlug } : {}),
        } } : {}),
        runtimeMode: (() => {
          // The standing default replaces the detached posture only: an attended
          // session is one somebody is watching, and it keeps asking.
          const posture = detached ? (this.host.sessionDefaults().runtimeMode ?? DEFAULT_DETACHED_RUNTIME_MODE) : DEFAULT_ATTENDED_RUNTIME_MODE;
          return ceiling === undefined ? posture : narrowerRuntimeMode(posture, ceiling);
        })(),
        interactionMode: "default",
        detached,
        // Derived on every read (`withActivity`) and stripped before every write
        // (`storedSession`); named here only because the wire shape requires it,
        // and a session with no queue yet is genuinely idle.
        activity: "idle",
      };
      this.kernel.writeDocument(metadata, storedSession(session));
      // Through `writeQueue` like every other queue write: an id reused after a
      // delete must not find the old session's cached queue waiting for it.
      this.host.writeQueue(id, emptyQueue(id));
      this.host.appendEvent(id, { type: "session.created", session });
      // AFTER the document, never before: the flip this schedules writes the same
      // record, and a cut that finished first would be overwritten by the row that
      // said it had not started.
      if (cut !== undefined && project !== undefined) this.prepareWorktree(id, project.root, cut.plan, cut.baseSha);
      return structuredClone(session);
    });
  }

  /** A project's stored model selection without the options its model no longer offers, read from the cached catalogue. */
  private supportedOptions(driver: ProviderDriverKind, selection: ModelSelection): ModelSelection | undefined {
    const listed = this.host.cachedModels(driver);
    if (!listed) return selection;
    const id = selection.model ?? listed.find((row) => row.isDefault)?.id;
    const row = listed.find((candidate) => candidate.id === id || candidate.resolves === id);
    if (!row || row.source === "user") return selection;
    const { effort, fastMode, serviceTier, ultracode, ...rest } = selection;
    const kept: ModelSelection = {
      ...rest,
      ...(effort !== undefined && row.efforts.includes(effort) ? { effort } : {}),
      ...(fastMode !== undefined && row.fastMode ? { fastMode } : {}),
      ...(serviceTier !== undefined && row.serviceTiers?.some((tier) => tier.id === serviceTier) ? { serviceTier } : {}),
      // Ultracode runs at xhigh, so it needs a model that offers that level.
      ...(ultracode !== undefined && row.efforts.includes("xhigh") ? { ultracode } : {}),
    };
    const named = [kept.model, kept.effort, kept.fastMode, kept.serviceTier, kept.ultracode].some((value) => value !== undefined);
    return named ? kept : undefined;
  }

  /** Cuts the checkout a `preparing` session waits for, then flips its row; not awaited, and serialised per project. */
  prepareWorktree(sessionId: string, projectRoot: string, plan: WorktreePlan, baseSha: string): void {
    void this.host.worktreeQueue(projectRoot, async () => {
      try {
        await createSessionWorktreeAsync(this.host.worktreeGit, { engineRoot: this.kernel.paths.root, projectRoot, plan, baseSha });
        this.host.settleWorktree(sessionId, undefined);
        void this.host.startSetup(sessionId, plan.path);
      } catch (error) {
        // Git's own words, not ours — see `SessionPreparation.error`.
        this.host.settleWorktree(sessionId, error instanceof Error ? error.message : String(error));
      } finally {
        // A cut adds a branch and a worktree the project's overview lists.
        this.host.forgetGitReadsUnder(projectRoot);
        this.host.forgetGitReadsUnder(plan.path);
      }
    });
  }

  /** Changes what a session is and may do mid-flight; a tighter runtime mode applies from the next tool call. */
  updateSession(
    sessionId: string,
    /** `model: null` CLEARS the selection; absent leaves it alone. The two are
     *  different requests and JSON cannot express the difference any other way. */
    patch: {
      title?: string;
      /** Engine-only; a title change without it means someone else chose the title. */
      autoTitle?: "first" | "second";
      runtimeMode?: RuntimeMode;
      detached?: boolean;
      model?: ModelSelectionValue | null;
      /** `null` returns the session to the inactivity rule; the two strings pin
       *  it out of or into the list. Three answers, so not a boolean. */
      settledOverride?: "settled" | "active" | null;
      /** `null` cancels a snooze. A time in the past is accepted and simply
       *  reads as awake — a client's clock is not this engine's to police. */
      snoozedUntil?: number | null;
      /** `null` returns the session to the driver's default rather than storing
       *  one — see `Session.resumeAfterRateLimit`. Three answers, so not a
       *  boolean: "on", "off", and "whatever this provider does". */
      resumeAfterRateLimit?: boolean | null;
    },
  ): Session {
    return this.kernel.command("updateSession", () => {
      const session = this.records.get(sessionId);
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");

      const next: Session = { ...session };
      if (patch.title !== undefined) {
        const title = String(patch.title).trim();
        if (!title) throw new EngineStateError("invalid_request", "session title cannot be empty");
        next.title = title.slice(0, 200);
      }
      if (patch.autoTitle !== undefined) next.autoTitle = patch.autoTitle;
      else if (next.title !== session.title) delete next.autoTitle;
      if (patch.runtimeMode !== undefined) {
        if (!RUNTIME_MODES.has(patch.runtimeMode)) throw new EngineStateError("invalid_request", "unknown runtime mode");
        next.runtimeMode = patch.runtimeMode;
      }
      if (patch.detached !== undefined) {
        if (typeof patch.detached !== "boolean") throw new EngineStateError("invalid_request", "detached must be a boolean");
        next.detached = patch.detached;
      }
      if (patch.model !== undefined) {
        if (patch.model === null) {
          delete next.model;
        } else {
          const parsed = ModelSelection.safeParse(patch.model);
          if (!parsed.success) throw new EngineStateError("invalid_request", "model selection is malformed");
          if (parsed.data.instanceId !== session.providerInstanceId) {
            throw new EngineStateError("invalid_request", "model must belong to the session's provider instance");
          }
          next.model = parsed.data;
        }
      }
      if (patch.settledOverride !== undefined) {
        if (patch.settledOverride === null) {
          delete next.settledOverride;
          delete next.settledAt;
          releaseDelegationSettle(next);
        } else if (patch.settledOverride === "settled" || patch.settledOverride === "active") {
          if (patch.settledOverride === "settled") delete next.settledBy;
          else releaseDelegationSettle(next);
          next.settledOverride = patch.settledOverride;
          next.settledAt = this.kernel.now();
        } else {
          throw new EngineStateError("invalid_request", "settledOverride must be 'settled', 'active' or null");
        }
      }
      if (patch.resumeAfterRateLimit !== undefined) {
        if (patch.resumeAfterRateLimit === null) delete next.resumeAfterRateLimit;
        else if (typeof patch.resumeAfterRateLimit === "boolean") next.resumeAfterRateLimit = patch.resumeAfterRateLimit;
        else throw new EngineStateError("invalid_request", "resumeAfterRateLimit must be a boolean or null");
      }
      if (patch.snoozedUntil !== undefined) {
        delete next.wokeAt;
        if (patch.snoozedUntil === null) {
          delete next.snoozedUntil;
          delete next.snoozedAt;
        } else {
          if (!Number.isFinite(patch.snoozedUntil)) throw new EngineStateError("invalid_request", "snoozedUntil must be a timestamp");
          next.snoozedUntil = Math.floor(patch.snoozedUntil);
          // The early-wake rule needs "set at" to answer "has anything happened since?".
          next.snoozedAt = this.kernel.now();
        }
      }
      // Nothing changed: no write, no event, so a polling "save" button adds no journal rows.
      if (
        next.title === session.title &&
        next.autoTitle === session.autoTitle &&
        next.runtimeMode === session.runtimeMode &&
        next.detached === session.detached &&
        next.settledOverride === session.settledOverride &&
        next.snoozedUntil === session.snoozedUntil &&
        // Or a cancel on an already-woken row would clear the recorded wake in
        // `next` and then be dropped here as "nothing changed", leaving the stale
        // stamp on disk with no event to say it went.
        next.wokeAt === session.wokeAt &&
        next.resumeAfterRateLimit === session.resumeAfterRateLimit &&
        JSON.stringify(next.model ?? null) === JSON.stringify(session.model ?? null)
      ) {
        return structuredClone(session);
      }
      next.updatedAt = this.kernel.now();
      this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(next));
      this.host.appendEvent(sessionId, { type: "session.updated", session: next });
      // A member settled before it reported ends its cohort's wait (`reviewCohorts`).
      if (next.settledOverride === "settled" && session.settledOverride !== "settled") this.subscriptions.reviewCohorts();
      return structuredClone(next);
    });
  }

  /**
   * Re-derives a `telar/` branch from the current title after a generated title replaced the seed. Declines rather
   * than throws, and never moves the directory a provider may be running in.
   */
  async refreshWorktreeBranchFromTitle(sessionId: string): Promise<string | undefined> {
    const session = this.records.get(sessionId);
    if (session.state === "archived" || session.workspace.mode !== "worktree") return undefined;
    const current = session.workspace.branch;
    if (!current.startsWith("telar/")) return undefined;
    const next = derivedBranchFor(session.title, sessionId);
    if (next === undefined || next === current) return undefined;
    // On the mutation pool, never the thread: this runs behind every first turn.
    const renamed = await this.host.worktreeGit(session.workspace.path, ["branch", "-m", current, next]);
    if (renamed.status !== 0) return undefined;
    this.host.forgetGitReadsUnder(session.workspace.path);
    const projectRoot = this.host.projectOfSession(session)?.root;
    if (projectRoot) this.host.forgetGitReadsUnder(projectRoot);
    // RE-READ after the await: the record moved on while git ran, and writing
    // the copy from before it would undo whatever happened in between.
    const latest = this.records.get(sessionId);
    if (latest.workspace.mode !== "worktree" || latest.workspace.branch !== current) return undefined;
    const updated: Session = { ...latest, workspace: { ...latest.workspace, branch: next }, updatedAt: this.kernel.now() };
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(updated));
    this.host.appendEvent(sessionId, { type: "session.updated", session: updated });
    return next;
  }

  /**
   * Ends a session and, when asked, frees its checkout. The branch survives: its commits are the session's output.
   * Refused while a turn is in flight, which would pull the checkout from under a live provider.
   */
  archiveSession(sessionId: string, options: { releaseCheckout?: boolean } = {}): Session {
    const session = this.records.get(sessionId);
    if (session.state === "archived") return session;
    const active = this.host.readQueue(sessionId).turns.find(
      (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
    );
    if (active) throw new EngineStateError("conflict", "session has an active turn; stop it before archiving");

    // Free the session's browser. WITHOUT THIS, Chromium instances accumulate
    // until the pool's LRU evicts them six sessions later — which is a leak
    // measured in hundreds of megabytes on a machine running detached work.
    void this.host.releaseBrowser(sessionId, "session archived");
    this.releaseDataScience(session, "session archived");

    // A worktree implies a project; the checkout goes only when asked (Storage's policy, or a caller giving it back).
    if (session.workspace.mode === "worktree" && session.projectId && !session.workspace.released) {
      const project = this.host.getProject(session.projectId);
      // Best-effort. A leaked directory is bounded inside the engine's own
      // root and is reapable later; refusing to archive because git was
      // unhappy would strand the session in a state a human cannot leave.
      if (options.releaseCheckout ?? this.host.releasesArchivedCheckouts()) this.releaseWorktree(project, session.workspace.path);
      else this.pruneWorktree(project, session.workspace.path);
    }
    const at = this.kernel.now();
    session.state = "archived";
    session.updatedAt = at;
    this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, sessionId), storedSession(session));
    this.host.appendEvent(sessionId, { type: "session.archived" });
    this.subscriptions.dropSubscriptionsOf(sessionId);
    return structuredClone(session);
  }

  /** Gives a checkout back on the per-project queue, without waiting; best-effort, since a leaked worktree is reapable later. */
  private releaseWorktree(project: Project, worktreePath: string): void {
    // Availability is read on the queue, when git would actually run: a drive can go while the removal waits.
    void this.host.worktreeQueue(project.root, async () => {
      try {
        const removed = await removeSessionWorktreeAsync(this.host.worktreeGit, project.root, worktreePath, this.host.projectAvailability(project));
        if (!removed) await pruneBuildOutputs(this.host.worktreeGit, worktreePath).catch(() => []);
      } finally {
        this.host.forgetGitReadsUnder(project.root);
        this.host.forgetGitReadsUnder(worktreePath);
      }
    });
  }

  private pruneWorktree(project: Project, worktreePath: string): void {
    void this.host.worktreeQueue(project.root, () => pruneBuildOutputs(this.host.worktreeGit, worktreePath).catch(() => []));
  }

  private releaseDataScience(session: Session, reason: string): void {
    this.host.releasePlugins(session.id, reason);
    if (session.workspace.mode === "worktree" && session.projectId) {
      removeTelarVenv(telarVenvDir(this.kernel.paths.root, session.projectId, path.basename(session.workspace.path)));
    }
  }

  /** Continue independently: marks outstanding task turns detached without deleting or stopping anything. */
  detachAssignments(sessionId: string, runId?: string): Turn[] {
    const session = this.records.get(sessionId);
    const at = this.kernel.now();
    const queue = this.host.readQueue(session.id);
    const detached: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.origin !== "session" || turn.agentIntent !== "task") continue;
      if (runId && turn.runId !== runId) continue;
      if (turn.assignmentDetachedAt !== undefined) continue;
      turn.assignmentDetachedAt = at;
      turn.updatedAt = at;
      detached.push(structuredClone(turn));
    }
    if (detached.length > 0) {
      this.host.writeQueue(session.id, queue);
      // No `turn.updated` kind exists; the cockpit refolds from the snapshot on `session.updated`.
      this.host.appendEvent(sessionId, { type: "session.updated", session });
    }
    return detached;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.records.get(sessionId);
    const active = this.host.readQueue(sessionId).turns.find(
      (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
    );
    if (active) throw new EngineStateError("conflict", "session has an active turn; stop it before deleting");

    void this.host.releaseBrowser(sessionId, "session deleted");
    this.releaseDataScience(session, "session deleted");

    // See `archiveSession` for why the project is checked beside the mode.
    if (session.workspace.mode === "worktree" && session.projectId) {
      const project = this.host.getProject(session.projectId);
      this.releaseWorktree(project, session.workspace.path);
    }

    // The event is appended BEFORE the directory goes, so a subscriber watching
    // this session is told why its stream ended rather than simply losing it.
    this.host.appendEvent(sessionId, { type: "session.archived" });
    this.kernel.executionStore.deleteSession(sessionId);
    fs.rmSync(sessionDir(this.kernel.paths, sessionId), { recursive: true, force: true });
    this.kernel.sessionDeleted(sessionId);
    return true;
  }
}
