// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import { ExecutionStore, type ExecutionHousekeeping } from "./platform/db/execution-store";
import type { ScheduleRow, SessionIndexRow } from "./platform/db/tables";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countsAsActivity,
  isBackgroundWork,
  type RetentionPolicy,
  type RetentionBucket,
  type JournalRetirement,
  type UsageLimitSource,
  machineAllows,
  type ProjectPlugins,
  assignmentsOf,
  // THE CLIENTS' OWN SETTLING RULE, imported rather than re-implemented: the
  // live list drops the rows a rail would shelve (#457), so an engine that
  // disagreed with a cockpit here would produce a conversation neither of them
  // shows. See `protocol/settling.ts`.
  settlingActivityOf,
  // AND THE WAKE MOMENT, from the same file and for the same reason. It already
  // decides the scheduled expiry and the early wake together; `sweepSnoozeWakes`
  // records what it answers rather than deciding again (#490, #586).
  wokeAt,
  type AssignmentTurn,
  type SessionAssignment,
  type LiveSessionRow,
  type SessionSettledBy,
  type PluginPatch,
  type BrowserSnapshot,
  type GitCommitEntry,
  type GitHubCheckLog,
  type GitHubCommentResult,
  type GitHubReactionContent,
  type GitHubReactionResult,
  type GitHubThreadReplyResult,
  type GitHubThreadResolveResult,
  type GitHubLineCommentInput,
  type GitHubLineCommentResult,
  type GitHubPullAnchor,
  type GitHubFacets,
  type GitHubIssueFilter,
  type GitHubIssueRead,
  type GitHubMergeMethod,
  type GitHubMergeResult,
  type GitHubPullCreateResult,
  type GitPushResult,
  type GitHubPullFilter,
  type GitHubPullRead,
  type GitHubSnapshot,
  type GitignoreRemoval,
  type GitignoreResult,
  type AgentOrientation,
  type InboxPolicy,
  type SessionDefaults,
  type SidebarLayout,
  type TextGenPolicy,
  type ModelCatalogue,
  type ModelOverlay,
  type GitFilePatch,
  type GitReadFailure,
  type SessionDiff,
  type EngineEvent,
  type Item,
  type McpServer,
  type NotificationDetail,
  type ProviderInstance,
  type TurnAttachment,
  type ProviderDriverKind,
  // The runtime enum too, not just the type: `readProviderInstances` asks it
  // whether a row on disk names a driver this build still has.
  type Task,
  type Project,
  type EngineRequest,
  type RequestKind,
  type RequestOpenResult,
  type Session,
  type SessionSettleEnded,
  type Subscription,
  type Cohort,
  type SubscribedCohort,
  type Turn,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
  type WorktreeInventory,
  type WorktreeReclaimItem,
  type WorktreeReclaimResult,
} from "@telar/engine-client";
import { type ProjectPatch, ProjectProbes, ProjectRegistry, ProjectRemounts, WorkspaceConfigStore } from "./domains/projects";
import { assertId, EngineStateError, Kernel, type JournalEntry } from "./platform/kernel";
import { SettingsStore } from "./domains/settings";
import { AppearanceStore } from "./domains/appearance";
import { type McpOAuthRecord, McpOAuthStore, McpServers, type OAuthClientStore, type PendingMcpOAuth } from "./domains/agent-tools";
import { installedCli, ModelCatalogues, ProviderRegistry, type InstalledCli, type ProviderInstanceInput } from "./domains/providers";
import { DataScienceOps, LatexOps, PluginToolchains } from "./domains/plugins";
import { UsageLimitSources, type ResolvedUsageLimitSource, type UsageLimitSourceInput } from "./domains/usage";
import { type AttachmentInput, SessionQueries, createSessionModules, SessionAttachments, workspaceRootOf, delegationSettle, type DeliveryTurn, newestAssignment, OpenPrefixes, SessionActivity, sessionDir, SessionIndex, SessionItems, SessionMailbox, sessionMetadataFile, type SessionQueue, SessionQueues, SessionRecords, SessionRequests, SessionLifecycle, SessionSubscriptions, SessionTasks, storedSession, type OpenRequestInput, RequestGate, type ResolveRequestInput } from "./domains/sessions";
import { TurnWakes, TurnRecovery, isLiveTask, TurnClaims, TurnIngest, type StoppedClaim, TurnLifecycle, TurnIntake, type TurnSubmission } from "./domains/turns";
import { Dictation } from "./domains/dictation";
import { type ResolvedComputerUse } from "./domains/computer-use";
import { type ProjectIcon } from "./domains/appearance";
import { readFenced, readFencedAsync, readFencedBytes, writeFenced } from "./domains/files";
import { WorkspaceReads, cloneRepository, commitSessionWork, ensureTelarGitignore, isCloneFailure, pushSessionBranch, removeTelarGitignore, type GitOverview } from "./domains/git";
import {  } from "./platform/git/parse";
import { type AttachedBrowser, SessionBrowser } from "./domains/browser";
import { GitHubStore, defaultGhRunner, SessionPulls, type GhRunner } from "./domains/github";
import {  } from "zod";
import { type AdoptionInput, ConversationAdoption } from "./domains/providers";
import { type ClaudeConversation } from "./drivers/claude";
import { BUNDLED_MANIFEST, type ModelManifest, readModelCatalogue } from "./domains/providers";
import { type BootstrapRequest, type CompileStatus as LatexCompileMemory, type CreateEnvironmentRequest, type DsCapability, DsFiles, type JobRead, JobRunner, type KernelHost, type LatexBootstrapRequest, type LatexCapability, type LatexPackagesAnswer, type LatexToolchain, type ManagedTectonicStatus, NOTEBOOK_MAX_BYTES, type RequirementsSource, type ResolvedLatex, storeDsCapability, storeLatexCapability, type TableWindow, telarVenvDir, type Toolchain, windowCsv } from "./domains/plugins";
import { ScheduleBook, type ScheduleInput } from "./domains/schedules";
import { WorktreeMaintenance, createWorktreeQueue, defaultWorktreeGitRunner, type WorktreeQueue, type ReleaseRefusal, SETUP_STOP_GRACE_MS, WorktreeSetups, type MoveOutcome } from "./domains/worktrees";
import { defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, type GitResult, type GitRunner } from "./platform/git/runner";
import { backfillTurnSummaries, CheckoutSizes, CleanupStore, copyStore, migrateBareClaudeIds, migrateClaudeCompactionToLimits, migrateLegacyPluginFieldsOnOpen, type CheckoutSizesOptions } from "./domains/storage";
import { type AttachedTerminals, pipeLauncher, processGroupFor, SessionTerminals } from "./domains/terminal";
import { type ProjectAvailability, type VolumeDeps } from "./platform/fs/volumes";














/**
 * How long a turn's anchor probe may take — issue #741.
 *
 * MUCH SHORTER THAN `DEFAULT_GIT_TIMEOUT_MS`, and the difference is the point.
 * `rev-parse --verify HEAD` reads one file; thirty seconds of a shared pool
 * slot for it would be thirty seconds every other read waits behind, on a
 * command that runs at the start and end of every turn of every session. A
 * probe that does not answer in five seconds is a machine under load, and the
 * honest record of that is `read`, not a longer wait.
 *
 * The same five seconds `projectGitAsync`'s own HEAD read already uses.
 */
const ANCHOR_PROBE_MS = 5_000;




/**
 * A SECOND TELAR MEETING A LIVE LOCK IS NOT A CRASH — issue #894.
 *
 * `main.ts` exits with this instead of 1 when `acquireDaemonLock` refuses,
 * because the desktop shell has to tell those two apart and an exit code is the
 * only channel it has: the engine is forked with `stdio: "inherit"`, so a
 * packaged app's stderr goes somewhere nobody reads. On 1 the shell quits — an
 * engine that died is a cockpit full of errors. On this it puts a dialog up
 * first, which is the difference between "Telar refuses to open" and "a Telar
 * is already running".
 *
 * 3 RATHER THAN 2: node exits 1 on an uncaught throw and reserves 2 for a
 * shell's own misuse, so the lowest number that cannot be produced by either is
 * the first one that means something.
 *
 * THE SHELL KEEPS ITS OWN COPY of this number, because `apps/desktop/main.js`
 * is plain CommonJS that imports nothing from this app. `engine-exit.test.js`
 * reads both files and fails if they disagree.
 */
export const ENGINE_EXIT_LOCK_HELD = 3;




import { statePaths, type EngineStatePaths } from "./platform/fs/state-paths";
import type { ReapCandidate } from "./domains/storage";
export { EngineStateError };


export function engineRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim();
  if (!home) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be explicitly set for the engine");
  }
  if (!path.isAbsolute(home)) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be an absolute path for the engine");
  }
  const resolved = canonicalPath(home);
  for (const legacy of [".telar", ".telar-dev"]) {
    const legacyRoot = canonicalPath(path.join(os.homedir(), legacy));
    if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
      throw new EngineStateError("invalid_request", "TELAR_HOME must not point at legacy Telar state");
    }
  }
  return path.join(resolved, "engine");
}

/**
 * The name this subtree used to have.
 *
 * WHY THE ENGINE STILL HAS A SUBTREE AT ALL, rather than being TELAR_HOME
 * itself: the packaged shell points TELAR_HOME at Electron's own userData
 * directory, which already holds `Cache/`, `Local Storage/`, `update-prefs.json`
 * and `server-port.json`. Dropping `projects.json`, `sessions/` and `worktrees/`
 * in beside them would leave two owners of one directory, and no way to tell by
 * looking which files may be deleted.
 */
const LEGACY_ROOT_NAME = "vnext";

/**
 * Carry an existing store across the rename, once.
 *
 * A RENAME, NOT A COPY: it is atomic within a filesystem, so there is no window
 * where half the sessions exist under both names. It runs only when the new root
 * does not exist yet — a second engine, or a second launch, finds nothing to do
 * and says nothing.
 *
 * Returns whether it moved anything, so the caller can say so out loud. A silent
 * migration is indistinguishable from data loss to the person watching their
 * session list come back empty.
 */
export function migrateLegacyEngineRoot(engineRoot: string): boolean {
  const resolved = path.resolve(engineRoot);
  const legacy = path.join(path.dirname(resolved), LEGACY_ROOT_NAME);
  // A root that IS the legacy path (tests, and anyone who pinned it explicitly)
  // has nothing to migrate and must not be renamed onto itself.
  if (legacy === resolved) return false;
  if (fs.existsSync(resolved) || !fs.existsSync(legacy)) return false;
  fs.renameSync(legacy, resolved);
  return true;
}

/** Resolve existing symlinks while also handling a not-yet-created state root. */
function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = fs.realpathSync.native(existing);
  for (const segment of missing) canonical = path.join(canonical, segment);
  return canonical;
}


/**
 * One session record, narrowed to the row a rail draws — see `LiveSessionRow`.
 *
 * SPELLED AS A PICK RATHER THAN A DELETE-LIST, so a field added to `Session`
 * tomorrow does not silently join every polling answer: growing the wire has to
 * be a decision somebody writes down here. Absent keys are left absent rather
 * than set to `undefined`, because `JSON.stringify` drops the one and the point
 * of this function is the bytes.
 */
const liveRow = (session: Session): LiveSessionRow => ({
  id: session.id,
  ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  title: session.title,
  state: session.state,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  driver: session.driver,
  ...(session.model === undefined ? {} : { model: session.model }),
  // Not a rail's field — the `sessions` toolkit's, which lists off this route
  // from the out-of-process worker and names each row's workspace mode.
  envMode: session.envMode,
  // `baseRef` is the commit a checkout was cut from: one review surface's
  // question, and 40 bytes on every row of every poll otherwise.
  workspace:
    session.workspace.mode === "worktree"
      ? { mode: "worktree", path: session.workspace.path, branch: session.workspace.branch }
      : session.workspace.mode === "none"
        ? // A session with no directory says so on the row, rather than sending a
          // path-shaped answer a rail would draw an "open in Finder" button from.
          { mode: "none" }
        : { mode: "local", path: session.workspace.path },
  // ON THE ROW because it is a row's question: the rail is where a person
  // watches a session they just opened, and "the checkout is still being made"
  // is the only thing worth saying about it in those seconds. Absent on every
  // ready session, which is almost all of them — see `SessionPreparation`.
  ...(session.preparation === undefined ? {} : { preparation: session.preparation }),
  ...(session.draft === undefined ? {} : { draft: session.draft }),
  ...(session.usage === undefined ? {} : { usage: session.usage }),
  activity: session.activity,
  ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
  ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
  ...(session.lastTurnFailed === undefined ? {} : { lastTurnFailed: session.lastTurnFailed }),
  ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
  ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
  ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  ...(session.settledOverride === undefined ? {} : { settledOverride: session.settledOverride }),
  ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
  ...(session.settledBy === undefined ? {} : { settledBy: session.settledBy }),
  // A settled row's hover says why its terminals are gone (#883).
  ...(session.terminalsClosed === undefined ? {} : { terminalsClosed: session.terminalsClosed }),
  ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
  ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
  // ON THE WIRE DELIBERATELY, unlike `title`/`branch` on the index row: this is
  // the one field a rail needs in order to draw the thing #490 asked for. A dot
  // that says "this woke while you were away" cannot be derived from the other
  // three — deriving it is what made every cockpit decide it separately.
  ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
  ...(session.startedFrom === undefined ? {} : { startedFrom: session.startedFrom }),
});

/**
 * One claim a Stop just killed — the same triple `cancellationsForWorker`
 * returns, plus the worker it belongs to, because this is PUSHED rather than
 * asked for and the receiver has to check the claim is its own.
 */

export type EngineNotifier = (input: {
  sessionId: string;
  runId: string;
  requestId: string;
  kind: RequestKind;
  title: string;
}) => boolean;



/**
 * `DiffBaseOption` AND `FilePatchOptions` COME FROM THE CONTRACT, not from
 * here — `protocol/diff-query.ts` owns the shape, its query builder and its
 * parser together, because a fourth hand-written copy of this is precisely
 * what dropped the ignore-whitespace flag in silence. Re-exported so the
 * engine's own callers need not reach past their own module boundary.
 */
import type { DiffBaseOption, FilePatchOptions } from "@telar/engine-client";

/** One git question, as `EngineStore.prefetchedGit` keys it. */
const prefetchKey = (cwd: string, args: string[]): string => JSON.stringify([cwd, args]);

/** What `resolveWorktreeBase` would pass to `rev-parse` — and only a ref the
 *  store's own validation would let through, so a prefetch never puts an
 *  unvalidated argument on a git command line. */
const prefetchableRef = (ref: string | undefined): string | undefined =>
  ref === undefined ? "HEAD" : /^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(ref) ? ref : undefined;

export class EngineStore {
  private readonly kernel: Kernel<EngineNotifier>;
  private readonly settings: SettingsStore;
  private readonly appearance: AppearanceStore;
  private readonly mcpOAuth: McpOAuthStore;
  private readonly mcpServers: McpServers;
  private readonly providers: ProviderRegistry;
  private readonly usageSources: UsageLimitSources;
  private readonly projectProbes: ProjectProbes;
  private readonly projectRegistry: ProjectRegistry;
  private readonly toolchains: PluginToolchains;
  private readonly github: GitHubStore;
  private readonly browser: SessionBrowser;
  private readonly worktrees: WorktreeMaintenance;
  private readonly remounts: ProjectRemounts;
  private readonly attachments: SessionAttachments;
  private readonly queries: SessionQueries;
  private readonly intake: TurnIntake;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly ingest: TurnIngest;
  private readonly claims: TurnClaims;
  private readonly recovery: TurnRecovery;
  private readonly wakes: TurnWakes;
  private readonly catalogues: ModelCatalogues;
  private readonly records: SessionRecords;
  private readonly sessionItems: SessionItems;
  private readonly prefixes: OpenPrefixes;
  private readonly sessionRequests: SessionRequests;
  private readonly sessionTasks: SessionTasks;
  private readonly sessionQueues: SessionQueues;
  private readonly mailbox: SessionMailbox;
  private readonly sessionIndex: SessionIndex;
  private readonly activity: SessionActivity;
  private readonly subscriptions: SessionSubscriptions;
  private readonly lifecycle: SessionLifecycle;
  private readonly schedules: ScheduleBook;
  private readonly workspaceReads: WorkspaceReads;
  private readonly requestGate: RequestGate;
  private readonly sessionTerminals: SessionTerminals;
  private readonly sessionPulls: SessionPulls;
  private readonly adoption: ConversationAdoption;
  readonly dictation: Dictation;
  private readonly dataScienceOps: DataScienceOps;
  private readonly latexOps: LatexOps;

  private registerCacheHooks(): void {
    this.kernel.onRollback(() => this.kernel.runProgress.clear());
    this.kernel.onSessionDeleted((id) => this.kernel.runProgress.delete(id));
    this.kernel.onSessionDeleted((id) => this.subscriptions.dropSubscriptionsOf(id));
  }
  private readDocument(file: string): unknown | undefined {
    return this.kernel.readDocument(file);
  }
  private writeDocument(file: string, value: unknown, mode?: number): void {
    this.kernel.writeDocument(file, value, mode);
  }

  sessionsRevision(options: { all?: boolean } = {}): number {
    return this.sessionIndex.revision(options.all === true);
  }

  /**
   * WHAT THE EXECUTION STORE SWEPT WHEN IT OPENED — issue #457, step 4.
   *
   * Command receipts past their retention, and the JSON the sqlite import
   * replaced once sqlite has owned the store a week. Surfaced so the daemon can
   * SAY it: both sweeps delete things nothing can reach, so without a line in
   * the log the only evidence a person has that a quarter of a gigabyte went
   * away is that it is gone.
   */
  executionHousekeeping(): ExecutionHousekeeping | undefined {
    return this.kernel.executionStore.housekeeping;
  }

  /**
   * COMPACT THE JOURNAL AND GIVE THE PAGES BACK — issue #646, and only on ask.
   *
   * The sweep runs itself; the VACUUM behind this does not, because it rewrites
   * the database under an exclusive lock (7 s on the owner's gigabyte) to
   * return space that accrues over a month. See `ExecutionStore.reclaim`.
   */
  reclaimExecutionStore(): { before: number; after: number; deltas: number; starts: number; sessions: number; usage: number } {
    return this.kernel.executionStore.reclaim();
  }

  get readAccounting(): Kernel["readAccounting"] {
    return this.kernel.readAccounting;
  }

  private writeIndexedDocument(file: string, indexFile: string, value: unknown, property: string, rows: Array<{ key: string; tag?: string }>, written?: SessionQueue): void {
    this.kernel.writeIndexedDocument(file, indexFile, value, property, rows, written);
  }

  closeExecutionStore(): void { this.kernel.executionStore.close(); }
  executeCommand<T>(command: string, action: () => T, commandId?: string): T {
    return this.kernel.command(command, action, commandId);
  }

  readonly paths: EngineStatePaths;
  /** How each project's worktrees are prepared — see `workspace-config.ts`. */
  readonly workspace: WorkspaceConfigStore;
  /** Each worktree's `setup.command`, run in the background after a cut. */
  readonly setups: WorktreeSetups;
  /** Settings → Storage's automatic cleanup — see `cleanup.ts`. */
  readonly cleanup: CleanupStore;
  /** See the constructor option: the claims a Stop just killed, handed to the
   *  in-process worker so the abort does not ride a poll. */
  private readonly onTurnsStopped?: (cancellations: StoppedClaim[]) => void;
  /** See the constructor: daemon-injected, absent means no computer use. */
  private readonly computerUse?: (() => ResolvedComputerUse | undefined) | undefined;
  /** The injected SYNCHRONOUS runner. Reached only through `git` below. */
  private readonly syncGit: GitRunner;
  /**
   * ANSWERS ALREADY READ OFF THE POOL, for the one synchronous call in flight.
   *
   * `createSession` and a draft's promotion in `submitTurn` stay synchronous —
   * they are sqlite commands, and a command cannot span an await — but the few
   * `rev-parse`s they ask are refusals the caller must hear, so they cannot move
   * behind the response either. `withPrefetchedGit` reads them through the pool
   * FIRST and sets this for exactly the synchronous call that follows; only a
   * question nobody prefetched falls through to the blocking runner.
   */
  private prefetchedGit: Map<string, GitResult> | undefined;
  private readonly git: GitRunner = (cwd, args, options) =>
    this.prefetchedGit?.get(prefetchKey(cwd, args)) ?? this.syncGit(cwd, args, options);
  private readonly asyncGit: AsyncGitRunner;
  /** The cuts and removals, on a pool the rail's polls do not share — see
   *  `defaultWorktreeGitRunner`. The same runner when a caller injected one. */
  private readonly worktreeGit: AsyncGitRunner;
  /**
   * EVERY CHECKOUT'S SIZE, MEASURED IN THE BACKGROUND and shared by the two
   * surfaces that show one — the storage row and the inventory's rows — so they
   * cannot disagree and a checkout is never walked twice.
   */
  readonly checkoutSizes: CheckoutSizes;
  /**
   * One worktree mutation at a time per project — the ordering the synchronous
   * runner used to buy by blocking the daemon (#496). In memory, like
   * `liveRevision`: one writer, in this process, and a restart has nothing in
   * flight to order.
   */
  private readonly worktreeQueue: WorktreeQueue = createWorktreeQueue();
  /**
   * HOW THIS STORE ASKS THE MACHINE ABOUT DISKS — see `volumes.ts`.
   *
   * INJECTED BY TESTS ONLY, and the seam this whole feature is testable on: a
   * fake mount is a temp directory with a stable uuid, so unplug, remount at a
   * new path and the recreated-empty-mountpoint case are unit tests rather than
   * a drawer of USB sticks.
   */
  private readonly volumes: VolumeDeps;
  private readonly gh: GhRunner;
  /** What a provider process would inherit from this engine — read to say what
   *  a newly-configured login is about to stop inheriting (#594). */
  private readonly ambientEnv: Record<string, string | undefined>;


  noteForNextTurn(sessionId: string, note: string): void {
    this.mailbox.noteForNextTurn(sessionId, note);
  }

  attachBrowser(browser: AttachedBrowser): void {
    this.browser.attach(browser);
  }

  attachTerminals(terminals: AttachedTerminals): void {
    this.sessionTerminals.attach(terminals);
  }

  releaseSessionWorktree(
    sessionId: string,
    reason: "manual" | "inactive" | "unchanged" | "archived",
    options: { strict?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; refusal: ReleaseRefusal | "in-use" | "not-worktree"; detail?: string }> {
    return this.worktrees.release(sessionId, reason, options);
  }

  runCleanup(): Promise<void> {
    return this.worktrees.runCleanup();
  }

  isCleanupRunning(): boolean {
    return this.worktrees.isCleanupRunning();
  }

  restoreSessionWorktree(sessionId: string): Session {
    return this.worktrees.restore(sessionId);
  }

  private settleWorktree(sessionId: string, failure: string | undefined): void {
    this.worktrees.settle(sessionId, failure);
  }

  reapableWorktrees(): ReapCandidate[] {
    return this.worktrees.reapable();
  }

  lockLiveWorktrees(): { locked: number } {
    return this.worktrees.lockLive();
  }

  moveWorktrees(destination: string): Promise<MoveOutcome> {
    return this.worktrees.move(destination);
  }

  worktreeInventory(): Promise<WorktreeInventory> {
    return this.worktrees.inventory();
  }

  reclaimWorktrees(items: readonly WorktreeReclaimItem[]): Promise<WorktreeReclaimResult[]> {
    return this.worktrees.reclaim(items);
  }

  private worktreeMaintenance(): WorktreeMaintenance {
    return new WorktreeMaintenance(this.kernel, {
      records: this.records,
      git: this.worktreeGit,
      queue: this.worktreeQueue,
      cleanup: this.cleanup,
      checkoutSizes: this.checkoutSizes,
      getProject: (id) => this.getProject(id),
      listProjects: () => this.listProjects(),
      availability: (project) => this.projectAvailability(project),
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      setupRunning: (id) => this.setups.isRunning(id),
      startSetup: (id, worktree) => this.startWorktreeSetup(id, worktree),
      openTerminals: (id) => this.sessionTerminals.openCount(id),
      hasLiveBackgroundWork: (id) => this.hasLiveBackgroundWork(id),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      archiveSession: (id, options) => this.archiveSession(id, options),
    });
  }

  refreshTerminalCensus(): Promise<void> {
    return this.sessionTerminals.refresh();
  }

  sessionTerminalCount(sessionId: string): Promise<number> {
    return this.sessionTerminals.countNow(sessionId);
  }

  closeSessionTerminals(sessionId: string): Promise<number> {
    return this.sessionTerminals.closeForPerson(sessionId);
  }

  /**
   * The daemon's kernel host, attached like the browser and for the same
   * reason: the store must build in a test without spawning Python. Absent
   * means every kernel verb refuses with "no kernel host".
   */
  private kernels?: KernelHost;

  attachKernels(host: KernelHost): void {
    this.kernels = host;
  }

  /** Environment builds and package installs, as jobs the settings page polls. */
  readonly dsJobs = new JobRunner(() => this.now());

  /**
   * THE DATA-SCIENCE DOOR FOR ONE SESSION. Resolves the project's interpreter
   * with the worktree rule, builds the capability over the daemon's kernel
   * host and this store's files, and refuses when the project has not opted
   * in. Every route and every toolkit reaches the kernel through this.
   */
  dataScience(sessionId: string): DsCapability {
    const session = this.records.get(sessionId);
    const resolved = this.resolveDataScience(session);
    if (!resolved) {
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.machinePlugins(), "data-science")
          ? "data science is not enabled for this session's project"
          : "data science is turned off for this Mac",
      );
    }
    if (!this.kernels) throw new EngineStateError("invalid_request", "this engine has no kernel host");
    return storeDsCapability({
      sessionId,
      cwd: workspaceRootOf(session),
      python: resolved.pythonPath,
      telarVenv: telarVenvDir(this.paths.root, session.projectId!, session.workspace.mode === "worktree" ? path.basename(session.workspace.path) : undefined),
      host: this.kernels,
      files: new DsFiles(path.join(sessionDir(this.paths, sessionId), "ds")),
      // A notebook with plots in it passes the editor's 512 KB ceiling in one
      // cell; both fences take the notebook-sized cap instead.
      readFile: (target) => readFenced(workspaceRootOf(session), target, "session workspace", NOTEBOOK_MAX_BYTES),
      writeFile: (target, text, expected) => writeFenced(workspaceRootOf(session), target, text, expected, "session workspace", NOTEBOOK_MAX_BYTES),
      putAttachment: (input) => this.putAttachment(sessionId, input),
      attachmentBytes: (id) => this.attachmentBytes(sessionId, id).data,
      appendEvent: (event) => { this.appendEvent(sessionId, event); },
      now: () => this.now(),
      // Package operations resolve the environment against THIS session's
      // workspace — the worktree rule again — and run as the store's jobs.
      packages: () => this.dataSciencePackages(session.projectId!, workspaceRootOf(session)),
      startInstall: (input) => this.dataScienceInstall(session.projectId!, input as Parameters<EngineStore["dataScienceInstall"]>[1], workspaceRootOf(session)),
      waitJob: (jobId, timeoutMs) => this.dsJobs.wait(jobId, timeoutMs),
      environments: async () => ({ environments: await this.dataScienceOps.environmentRows(session.projectId!, workspaceRootOf(session)) }),
      useEnvironment: (target) => this.dataScienceUseEnvironment(sessionId, target),
    });
  }

  resolveDataScience(session: Session): { pythonPath: string } | undefined {
    return this.toolchains.resolveDataScience(session);
  }

  /** Compile and tlmgr jobs — a SIBLING runner, not `dsJobs`, so a thesis
   *  compile never queues behind three pip installs and the job-id namespaces
   *  stay apart. Same class, own concurrency budget. */
  readonly latexJobs = new JobRunner(() => this.now());

  /** The last compile per session, for `latex_status` and the surface. */
  private readonly latexCompiles = new Map<string, LatexCompileMemory>();

  /**
   * THE LATEX DOOR FOR ONE SESSION, shaped like `dataScience()` above:
   * resolves the project's toolchain with the worktree rule for `mainFile`,
   * builds the capability over this store's jobs, and refuses when the
   * project has not opted in.
   */
  latex(sessionId: string): LatexCapability {
    const session = this.records.get(sessionId);
    const resolved = this.resolveLatex(session);
    if (!resolved) {
      // WHICH SWITCH, so a person knows where to go. The ceiling and the
      // project's own setting produce the same refusal but not the same fix.
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.machinePlugins(), "latex")
          ? "LaTeX is not enabled for this session's project"
          : "LaTeX is turned off for this Mac",
      );
    }
    return storeLatexCapability({
      sessionId,
      cwd: workspaceRootOf(session),
      resolved,
      toolchain: () => this.latexToolchain(),
      jobs: this.latexJobs,
      appendEvent: (event) => { this.appendEvent(sessionId, event); },
      now: () => this.now(),
      lastCompile: {
        get: () => this.latexCompiles.get(sessionId),
        set: (status) => { this.latexCompiles.set(sessionId, status); },
      },
    });
  }

  resolveLatex(session: Session): ResolvedLatex | undefined {
    return this.toolchains.resolveLatex(session);
  }

  managedTectonic(): ManagedTectonicStatus {
    return this.toolchains.managedStatus();
  }

  installManagedTectonic(): Promise<ManagedTectonicStatus> {
    return this.toolchains.installManaged();
  }

  /** The kernel host reporting a state change; journaled so the panel's pill follows it. */
  recordKernelState(sessionId: string, state: "starting" | "idle" | "busy" | "restarting" | "dead", reason?: string): void {
    try {
      this.records.require(sessionId);
    } catch {
      return; // a kernel outliving its session has nowhere to report
    }
    this.appendEvent(sessionId, { type: "kernel.state.changed", state, ...(reason ? { reason } : {}) });
  }

  /**
   * A WINDOW OF ROWS from a CSV, TSV or Parquet file in the session's tree.
   * CSV is parsed here; Parquet goes through the kernel (pyarrow), so it needs
   * data science on. The fence is `readFenced`'s.
   */
  async sessionTable(sessionId: string, target: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }): Promise<TableWindow> {
    const session = this.records.get(sessionId);
    if (/\.parquet$/i.test(target)) {
      const ds = this.dataScience(sessionId);
      const sort = options.sort ? `.sort_values(${JSON.stringify(options.sort)}, ascending=${options.desc ? "False" : "True"})` : "";
      const code = `import pandas as _pd, json as _j\n_df = _pd.read_parquet(${JSON.stringify(path.resolve(workspaceRootOf(session), target))})${sort}\n_w = _df.iloc[${options.offset}:${options.offset + options.limit}]\nprint("__TELAR_TABLE__" + _j.dumps({"columns": list(map(str, _df.columns)), "dtypes": [str(_df.dtypes[c]) for c in _df.columns], "total": int(len(_df)), "rows": _j.loads(_w.to_json(orient="values", date_format="iso"))}, default=str))`;
      const result = await ds.execute({ code, producer: "table" });
      const line = result.outputs.find((o) => o.kind === "text" && o.text.includes("__TELAR_TABLE__"));
      if (!result.ok || !line || line.kind !== "text") throw new EngineStateError("invalid_request", result.error ? `${result.error.ename}: ${result.error.evalue}` : "could not read the parquet file");
      const parsed = JSON.parse(line.text.slice(line.text.indexOf("__TELAR_TABLE__") + 15)) as Omit<TableWindow, "offset" | "path">;
      return { path: target, offset: options.offset, ...parsed };
    }
    const file = readFenced(workspaceRootOf(session), target, "session workspace");
    if (file.binary) throw new EngineStateError("invalid_request", "that file is not text");
    return { path: target, ...windowCsv(file.text, /\.tsv$/i.test(target) ? "\t" : ",", options), ...(file.truncated ? { truncated: true } : {}) };
  }

  listAttachments(sessionId: string, options: { tag?: string } = {}): TurnAttachment[] {
    return this.attachments.list(sessionId, options);
  }

  attachmentBytes(sessionId: string, attachmentId: string): { attachment: TurnAttachment; data: Uint8Array } {
    return this.attachments.bytes(sessionId, attachmentId);
  }

  tagAttachment(sessionId: string, attachmentId: string, tags: string[]): TurnAttachment {
    return this.attachments.tag(sessionId, attachmentId, tags);
  }

  recordBrowserControl(sessionId: string, controller: "agent" | "human" | "idle", tabId?: string, interrupted = false): void {
    this.browser.recordControl(sessionId, controller, tabId, interrupted);
  }

  browserState(sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}): Promise<BrowserSnapshot> {
    return this.browser.state(sessionId, options);
  }

  browserOpen(sessionId: string, url: string): Promise<BrowserSnapshot> {
    return this.browser.open(sessionId, url);
  }

  listMcpServers(scope?: { projectId: string | null }): McpServer[] {
    return this.mcpServers.list(scope);
  }

  saveMcpServer(input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: unknown }): McpServer {
    return this.mcpServers.save(input);
  }

  removeMcpServer(id: string, projectId?: string): boolean {
    return this.mcpServers.remove(id, projectId);
  }

  getInboxPolicy(): InboxPolicy {
    return this.settings.inbox();
  }

  setInboxPolicy(patch: { autoSettleAfterHours?: unknown; settleDelegatedAfterHours?: unknown; settledTerminalLimit?: unknown }): InboxPolicy {
    const next = this.settings.setInbox(patch);
    // A lower limit applies now rather than at the next sweep.
    if (patch.settledTerminalLimit !== undefined && this.sessionTerminals.attached) {
      void Promise.resolve().then(() => this.enforceSettledTerminalLimit()).catch(() => undefined);
    }
    return next;
  }

  /** A consistent copy of this store, without the reproducible tier, to open instead of the live one. */
  copyStoreTo(destination: string): { root: string; files: number; bytes: number } {
    return copyStore(this.paths.root, this.kernel.executionStore, destination);
  }

  getRetentionPolicy(): RetentionPolicy {
    return this.settings.retention();
  }

  setRetentionPolicy(patch: { idleAfterDays?: unknown; exportTo?: unknown }): RetentionPolicy {
    return this.settings.setRetention(patch);
  }

  retentionPreview(options: { bytes?: boolean } = {}): RetentionBucket[] {
    return this.settings.retentionPreview(options);
  }

  sweepRetention(): JournalRetirement {
    return this.settings.sweepRetention();
  }

  getAgentOrientation(): AgentOrientation {
    return this.settings.orientation();
  }

  setAgentOrientation(patch: { preamble?: unknown; skill?: unknown }): AgentOrientation {
    return this.settings.setOrientation(patch);
  }

  getSessionDefaults(): SessionDefaults {
    return this.settings.sessionDefaults();
  }

  setSessionDefaults(patch: { envMode?: unknown; resumeAfterRestart?: unknown; runtimeMode?: unknown; resumeAfterRateLimit?: unknown }): SessionDefaults {
    return this.settings.setSessionDefaults(patch);
  }

  getSidebarLayout(): SidebarLayout {
    return this.settings.sidebarLayout();
  }

  setSidebarLayout(patch: { projectOrder?: unknown; sessionOrder?: unknown; pinnedOrder?: unknown; mode?: unknown }): SidebarLayout {
    return this.settings.setSidebarLayout(patch);
  }

  getTextGenPolicy(): TextGenPolicy {
    return this.settings.textGen();
  }

  setTextGenPolicy(patch: { titles?: unknown; renameBranches?: unknown; driver?: unknown; model?: unknown }): TextGenPolicy {
    return this.settings.setTextGen(patch);
  }


  getAppearance(): { updatedAt: number; blob: Record<string, unknown> } | null {
    return this.appearance.get();
  }

  setAppearance(blob: unknown): { updatedAt: number; blob: Record<string, unknown> } {
    return this.appearance.set(blob);
  }

  clearAppearance(): void {
    this.appearance.clear();
  }

  getMcpOAuthRecord(serverId: string, projectId?: string): McpOAuthRecord | undefined {
    return this.mcpOAuth.get(serverId, projectId);
  }

  putMcpOAuthRecord(record: McpOAuthRecord): void {
    this.mcpOAuth.put(record);
  }

  deleteMcpOAuthRecord(serverId: string, projectId?: string): boolean {
    return this.mcpOAuth.delete(serverId, projectId);
  }

  mcpOAuthClientStore(): OAuthClientStore {
    return this.mcpOAuth.clientStore();
  }

  putPendingMcpOAuth(flow: PendingMcpOAuth): void {
    this.mcpOAuth.putPending(flow);
  }

  takePendingMcpOAuth(state: string): PendingMcpOAuth | undefined {
    return this.mcpOAuth.takePending(state);
  }

  async resolveMcpOAuthToken(serverId: string, projectId: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
    return this.mcpOAuth.resolveToken(serverId, projectId, fetchImpl);
  }

  /**
   * Attaches the managed bearer to each claimed server with a stored grant, after the claim so a slow
   * token refresh never runs under the state lock. A hand-written `Authorization` header wins.
   */
  async authorizeClaimedMcpServers(claim: WorkerClaim, fetchImpl?: typeof fetch): Promise<WorkerClaim> {
    if (!claim.mcpServers?.length) return claim;
    const mcpServers = await Promise.all(
      claim.mcpServers.map(async (server) => {
        if (server.spec.transport === "stdio") return server;
        const headers = server.spec.headers ?? {};
        if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) return server;
        // The grant is keyed by the scope the SERVER came from, which for a
        // project-scoped server is that project — not the session's, which for
        // a global server would be a key nothing was ever stored under.
        const token = await this.resolveMcpOAuthToken(server.id, server.projectId, fetchImpl);
        if (!token) return server;
        return { ...server, spec: { ...server.spec, headers: { ...headers, Authorization: `Bearer ${token}` } } };
      }),
    );
    return { ...claim, mcpServers };
  }

  // ── provider instances ────────────────────────────────────────────────────
  //
  // THE ACCOUNT REGISTRY the contract has been routing at since v2. Every
  // session already stores a `providerInstanceId`; until now the engine minted
  // `<driver>:default` and nothing was behind the id.
  //
  // TELAR ADOPTS LOGINS, IT DOES NOT CREATE THEM. Nothing here signs anyone in
  // and no route below ever will. An instance names a config folder the user
  // has already authenticated, plus the environment its provider process runs
  // with; whether that folder actually holds a login is a question `probe()`
  // answers from the filesystem, never by reading a credential.

  listProviderInstances(): ProviderInstance[] {
    return this.providers.list();
  }

  saveProviderInstance(input: ProviderInstanceInput): { instance: ProviderInstance; stoppedInheriting: string[] } {
    return this.providers.save(input);
  }


  removeProviderInstance(id: string): boolean {
    return this.providers.remove(id);
  }

  resolveProviderInstance(instanceId: string, driver: ProviderDriverKind): ProviderInstance {
    return this.providers.resolve(instanceId, driver);
  }

  listUsageLimitSources(): UsageLimitSource[] {
    return this.usageSources.list();
  }

  saveUsageLimitSource(input: UsageLimitSourceInput): UsageLimitSource {
    return this.usageSources.save(input);
  }

  removeUsageLimitSource(id: string): boolean {
    return this.usageSources.remove(id);
  }

  resolveUsageLimitSources(): ResolvedUsageLimitSource[] {
    return this.usageSources.resolve();
  }

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: {
      /**
       * WHAT THE JOURNAL SWEEP REMOVED, once it has — issue #646.
       *
       * The receipts and backup sweeps report through `executionHousekeeping`
       * because they finish inside the constructor. The journal sweep does not:
       * its first pass is a minute's work on a large store, so it runs on a
       * timer after the open and tells whoever is listening when it is done.
       * Absent by default — a store on its own announces nothing.
       */
      onExecutionHousekeeping?: (swept: { journal: { deltas: number; starts: number; sessions: number } }) => void;
      notifier?: EngineNotifier;
      /**
       * SOMETHING IN SOME SESSION'S QUEUE CHANGED — a message accepted, a turn
       * claimed or stopped, a steer promoted. Fired from `writeQueue`, which is
       * the only writer, so no transition can forget it, and only AFTER the
       * transaction commits so a rolled-back write announces nothing.
       *
       * INJECTED BY THE DAEMON, for the worker it hosts in-process: it is what
       * lets that worker poll slowly while nothing is happening without putting
       * the backoff's latency on the next thing the person types. Absent by
       * default, so a store on its own announces nothing to anybody.
       */
      onQueueChanged?: () => void;
      /**
       * A STOP'S CANCELLATIONS, HANDED STRAIGHT TO THE WORKER HOLDING THEM.
       *
       * `onQueueChanged` is not enough for this, and #409 is why. It only ever
       * puts a BACKED-OFF worker back on its fast interval — a worker already
       * beating fast (which is every worker with a turn running, i.e. every
       * worker a Stop concerns) does nothing with the nudge and goes on
       * DISCOVERING the stop by polling. The abort therefore waits for the next
       * heartbeat, and for the one in flight to answer first: an unbounded wait
       * on a busy daemon, measured at up to five seconds.
       *
       * So a stop tells the worker WHICH CLAIMS DIED rather than that something
       * moved, and the worker aborts them in-process, in the same tick as the
       * HTTP request. The heartbeat's `cancellationsForWorker` is unchanged and
       * still the backstop: it is the only path an OUT-OF-PROCESS worker has,
       * and re-aborting an already-aborted controller is a no-op.
       *
       * INJECTED BY THE DAEMON for the worker it hosts, like `onQueueChanged`;
       * absent by default, so a store on its own tells nobody anything.
       */
      onTurnsStopped?: (cancellations: StoppedClaim[]) => void;
      /** The background checkout sizer's seams — see `checkout-sizes.ts`.
       *  INJECTED BY TESTS ONLY; the default walks the real disk. */
      checkoutSizing?: CheckoutSizesOptions;
      git?: GitRunner;
      asyncGit?: AsyncGitRunner;
      gh?: GhRunner;
      /** The daemon's computer-use gate: resolves cua-driver only while the
       *  last probe answered `granted`. INJECTED BY THE DAEMON, absent by
       *  default — so tests never read the real machine's installs, and a
       *  store without it simply has no computer use. */
      computerUse?: () => ResolvedComputerUse | undefined;
      /** Test seam for the provider model handshake. */
      models?: typeof readModelCatalogue;
      /** Test seam for the installed-CLI version probe. */
      cliVersion?: (driver: ProviderDriverKind) => Promise<InstalledCli>;
      /** Test seam for the bundled model manifest. */
      manifest?: ModelManifest;
      /** How disks are asked about (`volumes.ts`). INJECTED BY TESTS ONLY — the
       *  default reads the real machine's mounts and `diskutil`, and a test
       *  about an unplugged drive should not need a drive. */
      volumes?: VolumeDeps;
      /**
       * THE ENGINE'S OWN ENVIRONMENT — what a provider process would inherit
       * from this one if nothing scrubbed it (#594).
       *
       * INJECTED BY TESTS ONLY. The default is `process.env`, which is the only
       * correct answer in a running engine: the question "what is this login
       * about to stop inheriting" is a question about THIS process, and a test
       * that had to mutate the real environment to ask it would be a test that
       * leaks into every other test in the file.
       */
      ambientEnv?: Record<string, string | undefined>;
    } = {},
  ) {
    this.onTurnsStopped = options.onTurnsStopped;
    this.computerUse = options.computerUse;
    this.syncGit = options.git ?? defaultGitRunner;
    this.asyncGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultAsyncGitRunner);
    this.workspaceReads = new WorkspaceReads(this.asyncGit, {
      now: () => this.now(),
      getSession: (sessionId) => this.records.get(sessionId),
      getProject: (projectId) => this.getProject(projectId),
      availability: (project) => this.projectAvailability(project),
    });
    // A POOL OF ITS OWN FOR THE CUTS, so the slowest git child cannot hold a
    // slot the rail's polls need — see `defaultWorktreeGitRunner`. An INJECTED
    // runner still wins, and wins for both: a test that fakes git is faking the
    // whole of git, and two seams would let a fake apply to half of it.
    this.worktreeGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultWorktreeGitRunner);
    this.checkoutSizes = new CheckoutSizes(options.checkoutSizing);
    this.gh = options.gh ?? defaultGhRunner;
    this.volumes = options.volumes ?? {};
    this.ambientEnv = options.ambientEnv ?? process.env;
    this.paths = statePaths(root);
    this.workspace = new WorkspaceConfigStore(this.paths.workspace);
    this.cleanup = new CleanupStore(this.paths.cleanup);
    this.setups = new WorktreeSetups({
      directoryOf: (sessionId) => sessionDir(this.paths, sessionId),
      launcher: pipeLauncher(processGroupFor(process.platform, (pid, signal) => process.kill(pid, signal)), { graceMs: SETUP_STOP_GRACE_MS }),
      now: () => this.now(),
    });
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
    // The journal sweep says what it removed when it removes it, which is
    // seconds AFTER the open rather than during it — the first pass on a
    // large store is a minute's work and belongs nowhere near the startup
    // path (#646). `onExecutionHousekeeping` is the daemon's line.
    const executionStore = new ExecutionStore(root, {
      onJournalCompacted: (swept) => options.onExecutionHousekeeping?.({ journal: swept }),
      onRetentionSweep: () => { this.sweepRetention(); },
    });
    this.kernel = new Kernel({ paths: this.paths, now, executionStore, notifier: options.notifier });
    ({
      settings: this.settings, appearance: this.appearance, mcpOAuth: this.mcpOAuth, mcpServers: this.mcpServers, usageSources: this.usageSources,
      projectProbes: this.projectProbes, projectRegistry: this.projectRegistry, catalogues: this.catalogues, providers: this.providers, toolchains: this.toolchains, github: this.github, browser: this.browser, remounts: this.remounts,
    } = this.leafStores(options));
    ({
      records: this.records, items: this.sessionItems, requests: this.sessionRequests, tasks: this.sessionTasks, mailbox: this.mailbox,
      activity: this.activity, index: this.sessionIndex, queues: this.sessionQueues, prefixes: this.prefixes, attachments: this.attachments, queries: this.queries,
    } = createSessionModules(this.kernel, {
      readQueue: (sessionId) => this.readQueue(sessionId),
      readEvents: (sessionId) => this.readEvents(sessionId),
      subscriptionsOf: (sessionId) => this.subscriptions.subscriptionsOf(sessionId),
      nextWake: (sessionId) => this.schedules.nextWake(sessionId),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      ...(options.onQueueChanged ? { onQueueChanged: options.onQueueChanged } : {}),
    }));
    this.subscriptions = this.createSubscriptions();
    this.lifecycle = this.createLifecycle();
    this.intake = this.createIntake();
    this.turnLifecycle = this.createTurnLifecycle();
    this.claims = this.createClaims();
    this.wakes = new TurnWakes(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      mailbox: this.mailbox,
      subscriptions: this.subscriptions,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      submitTurn: (id, input) => this.submitTurn(id, input),
      writeNotificationItem: (id, turn) => this.writeNotificationItem(id, turn),
    });
    this.recovery = new TurnRecovery(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      getSessionDefaults: () => this.getSessionDefaults(),
      submitTurn: (id, input) => this.submitTurn(id, input),
    });
    this.ingest = new TurnIngest(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      prefixes: this.prefixes,
      readQueue: (id) => this.readQueue(id),
      scanQueue: (id) => this.scanQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      requireRunningClaimFromQueue: (queue, runId, token) => this.requireRunningClaimFromQueue(queue, runId, token),
    });
    this.worktrees = this.worktreeMaintenance();
    ({ dataScienceOps: this.dataScienceOps, latexOps: this.latexOps } = this.createPluginOps());
    this.dictation = new Dictation(this.paths.root, {
      liveSessions: () => this.liveSessionRows().sessions,
      projects: () => this.projectRegistry.read().projects,
    });
    this.adoption = new ConversationAdoption(this.records, this.sessionItems, {
      engineRoot: this.paths.root,
      now: () => this.now(),
      resolveInstance: (instanceId, driver) => this.resolveProviderInstance(instanceId, driver),
      readQueue: (sessionId) => this.readQueue(sessionId),
      writeQueue: (sessionId, queue) => this.writeQueue(sessionId, queue),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
    });
    this.sessionPulls = new SessionPulls(this.github, {
      getSession: (sessionId) => this.records.get(sessionId),
      getProject: (projectId) => this.getProject(projectId),
      worktreeGit: this.worktreeGit,
      asyncGit: this.asyncGit,
      gh: this.gh,
    });
    this.sessionTerminals = new SessionTerminals(this.records, this.sessionIndex, {
      now: () => this.now(),
      inboxPolicy: () => this.getInboxPolicy(),
      recordSession: (session) => {
        this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(session));
        this.appendEvent(session.id, { type: "session.updated", session });
      },
    });
    this.requestGate = new RequestGate(this.kernel, this.records, this.sessionRequests, {
      requireRunningClaim: (sessionId, runId, claimToken) => this.requireRunningClaim(sessionId, runId, claimToken),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      scanQueue: (sessionId) => this.scanQueue(sessionId),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
      requestOpened: (sessionId, turn, request) => this.fireSubscriptions(sessionId, "request_opened", turn, { request }),
    });
    this.schedules = new ScheduleBook(this.kernel, {
      requireSession: (sessionId) => void this.records.require(sessionId),
      submitTurn: (sessionId, input) => this.submitTurn(sessionId, input),
      bumpList: () => this.sessionIndex.bumpList(),
    });
    this.registerCacheHooks();
    // The backfill's writes go through one transaction rather than one per row.
    this.sessionIndexBackfill = this.sessionIndex.backfill();
    this.turnSummaryBackfill = backfillTurnSummaries(this.kernel, this.sessionItems, this.sessionQueues);
    // Before anything can claim a turn — see the method.
    this.claudeLongWindowMigration = migrateBareClaudeIds(this.kernel, () => this.records.ids(), this.catalogues.manifest);
    this.claudeCompactionMigration = migrateClaudeCompactionToLimits(this.kernel);
    this.pluginFieldMigration = migrateLegacyPluginFieldsOnOpen(this.kernel);
  }

  /**
   * THE PROJECT'S `setup.command`, IN THE BACKGROUND — never inside the
   * per-project queue, which would hold every other cut for as long as an
   * install takes. Best-effort: a setup that cannot start is in its own log.
   */
  private async startWorktreeSetup(sessionId: string, worktree: string): Promise<void> {
    try {
      const session = this.records.get(sessionId);
      if (!session.projectId) return;
      const project = this.getProject(session.projectId);
      const { effective } = await this.workspace.view(project);
      await this.setups.start(sessionId, { worktree, config: effective, env: { TELAR_WORKTREE: worktree } });
    } catch {
      // A session deleted in the meantime has nothing to set up.
    }
  }

  private createLifecycle(): SessionLifecycle {
    return new SessionLifecycle(this.kernel, this.records, this.subscriptions, {
      git: this.git,
      worktreeGit: this.worktreeGit,
      worktreeQueue: this.worktreeQueue,
      getProject: (projectId) => this.getProject(projectId),
      assertProjectAvailable: (projectId) => this.assertProjectAvailable(projectId),
      projectAvailability: (project) => this.projectAvailability(project),
      projectOfSession: (session) => this.workspaceReads.projectOf(session),
      sessionDefaults: () => this.getSessionDefaults(),
      requireInstance: (instanceId) => this.providers.require(instanceId),
      cachedModels: (driver) => this.catalogues.cachedRows(driver),
      readQueue: (sessionId) => this.readQueue(sessionId),
      writeQueue: (sessionId, queue) => this.writeQueue(sessionId, queue),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
      settleWorktree: (sessionId, error) => this.settleWorktree(sessionId, error),
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      startSetup: (sessionId, worktree) => this.startWorktreeSetup(sessionId, worktree),
      releaseBrowser: (sessionId, reason) => this.browser.release(sessionId, reason),
      releasePlugins: (sessionId, reason) => {
        this.pluginRelease?.(sessionId, reason);
        void this.kernels?.dispose(sessionId, reason);
      },
      releasesArchivedCheckouts: () => this.cleanup.policy().archived,
    });
  }

  private createSubscriptions(): SessionSubscriptions {
    return new SessionSubscriptions(this.kernel, {
      require: (sessionId) => this.records.get(sessionId),
      find: (sessionId) => {
        try {
          return this.records.get(sessionId);
        } catch {
          return undefined;
        }
      },
      turnsOf: (sessionId) => this.scanQueue(sessionId).turns,
      hasLiveTurn: (sessionId) => this.hasLiveTurn(sessionId),
      discardQueuedWakes: (subscriberId, targetSessionId) => void this.discardQueuedWakes(subscriberId, targetSessionId),
      submitTurn: (sessionId, input) => this.submitTurn(sessionId, input),
      warn: (sessionId, message) => void this.appendEvent(sessionId, { type: "runtime.warning", message }),
    });
  }

  /** The per-document stores that sit beside the sessions modules, built on the kernel. */
  private leafStores(options: { models?: typeof readModelCatalogue; cliVersion?: (driver: ProviderDriverKind) => Promise<InstalledCli>; manifest?: ModelManifest }) {
    const settings = new SettingsStore(this.kernel);
    const appearance = new AppearanceStore(this.kernel);
    const mcpOAuth = new McpOAuthStore(this.kernel);
    const mcpServers = new McpServers(this.kernel, { requireProject: (id) => void this.getProject(id), forgetGrant: (id, projectId) => mcpOAuth.delete(id, projectId) });
    const usageSources = new UsageLimitSources(this.kernel);
    const projectProbes = new ProjectProbes(this.kernel, {
      asyncGit: this.asyncGit,
      volumes: this.volumes,
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      onUnavailable: (project) => void this.remounts.recover(project),
    });
    const projectRegistry = new ProjectRegistry(this.kernel, {
      probes: projectProbes,
      volumes: this.volumes,
      sessionsOf: (projectId) => this.records.read().filter((session) => session.projectId === projectId).map((session) => session.id),
      hasWorkInFlight: (sessionId) => this.sessionHasWorkInFlight(sessionId),
    });
    const catalogues = new ModelCatalogues(this.kernel, {
      readModels: options.models ?? readModelCatalogue,
      cliVersion: options.cliVersion ?? installedCli,
      manifest: options.manifest ?? BUNDLED_MANIFEST,
    });
    const providers = new ProviderRegistry(this.kernel, this.ambientEnv);
    const toolchains = new PluginToolchains(this.kernel, { getProject: (id) => projectRegistry.get(id) });
    const github = new GitHubStore(this.kernel, { gh: this.gh, getProject: (id) => projectRegistry.get(id), requireSenderClaim: (proof) => this.requireSenderClaim(proof) });
    const remounts = new ProjectRemounts(this.kernel, {
      registry: projectRegistry,
      probes: projectProbes,
      volumes: this.volumes,
      sessions: () => this.records.read(),
      prepareWorktree: (sessionId, root, plan, baseSha) => this.lifecycle.prepareWorktree(sessionId, root, plan, baseSha),
    });
    const browser = new SessionBrowser(this.kernel, {
      require: (id) => void this.records.require(id),
      getSession: (id) => this.records.get(id),
      runningRunId: (id) => this.readQueue(id).turns.find((turn) => turn.state === "running")?.runId,
    });
    return { settings, appearance, mcpOAuth, mcpServers, usageSources, projectProbes, projectRegistry, catalogues, providers, toolchains, github, browser, remounts };
  }

  /** How many projects the legacy-field fold changed on this open (0 on most). */
  readonly pluginFieldMigration: number;
  /** How many logins the one-time compaction rewrite changed on this open, or nothing when it had already run. */
  readonly claudeCompactionMigration?: number;
  /** What the one-time `[1m]` rewrite changed on this open, or nothing when it had already run. */
  readonly claudeLongWindowMigration?: { sessions: number; projects: number };
  /** What the index backfill built on open, for the daemon to report; zero on every open after the first. */
  readonly sessionIndexBackfill?: { built: number; removed: number };
  /** What the turn projection built on open, reported like the index backfill. */
  readonly turnSummaryBackfill?: { sessions: number; turns: number };

  /** The icon's bytes-on-disk, for the daemon's serve route. Refuses when the
   *  project has none rather than guessing. */
  async projectIconFileAsync(projectId: string): Promise<ProjectIcon> {
    const project = this.getProject(projectId);
    const icon = await this.projectProbes.icon(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  listProjects(options: { includeRemoved?: boolean } = {}): Project[] {
    return this.projectRegistry.list(options);
  }


  /**
   * WHICH MOUNT CONFIGURATION EACH AWAY PROJECT HAS ALREADY BEEN SEARCHED FOR.
   *
   * The remount search is the expensive one — a `diskutil` child per mounted
   * volume — and it can only succeed if a disk has arrived. Keyed by project and
   * valued by `mountSignature`, so an unplugged drive that stays unplugged is
   * searched for exactly once no matter how long the poll runs.
   */

  projectAvailability(project: Pick<Project, "id" | "root"> & { volume?: Project["volume"] }): ProjectAvailability {
    return this.projectProbes.availability(project);
  }


  private forgetGitReadsUnder(root: string): void {
    this.workspaceReads.forgetUnder(root);
  }

  /**
   * ASK EVERY PROJECT'S DISK NOW, rather than waiting for somebody to look.
   *
   * TWO CALLERS, ONE PROBE. The daemon runs this once at start, so an engine
   * that came up with a drive already unplugged knows it before the first
   * listing rather than on it; and `POST /v2/projects/reprobe` runs it when the
   * desktop shell notices a mount or an unmount, which is what turns "within ten
   * seconds" into "immediately". Neither is a second opinion — both go through
   * `projectAvailability`, and the poll stays the floor under both.
   *
   * REMOVED PROJECTS ARE SKIPPED. A put-away project is on no surface that could
   * show a drive badge, and probing it would be three `stat`s for a row nobody
   * is drawing.
   */
  reprobeProjects(): { projects: number; changed: number; recovered: number } {
    const projects = this.projectRegistry.read().projects.filter((project) => project.removedAt === undefined);
    let changed = 0;
    let recovered = 0;
    for (const project of projects) {
      const before = this.projectProbes.lastAvailability(project.id);
      let availability = this.projectAvailability(project);
      /**
       * A DRIVE MOUNTED SOMEWHERE ELSE IS STILL THIS DRIVE — see
       * `ProjectRemounts.recover`. Attempted only when the project cannot be
       * read, which is what keeps the `diskutil` it costs off the poll path, and
       * HERE rather than inside the probe because this is the call that happens
       * when a disk has just appeared.
       */
      if (availability !== "available" && this.remounts.recover(project) !== undefined) {
        recovered += 1;
        availability = this.projectAvailability(this.getProject(project.id));
      }
      if (availability !== before) changed += 1;
    }
    return { projects: projects.length, changed, recovered };
  }


  registerProject(input: { id?: string; name: string; root: string }): Project {
    return this.projectRegistry.register(input);
  }

  unregisterProject(projectId: string): { project: Project; sessions: number } {
    return this.projectRegistry.unregister(projectId);
  }

  restoreProject(projectId: string): Project {
    return this.projectRegistry.restore(projectId);
  }

  /**
   * Whether a session still has something running, or something that might be.
   *
   * The turn states here are the NON-TERMINAL ones plus `ambiguous`; see
   * `unregisterProject` for why "we do not know" is counted as busy. Live
   * backgrounded tasks are checked separately because they are exactly the
   * work a turn-state check misses: `TaskKind` says a backgrounded task
   * continues after the turn that started it settles.
   */
  private sessionHasWorkInFlight(sessionId: string): boolean {
    const unsettled: ReadonlySet<Turn["state"]> = new Set<Turn["state"]>(["queued", "claimed", "running", "steering", "ambiguous"]);
    if (this.turns(sessionId).some((turn) => unsettled.has(turn.state))) return true;
    return [...this.sessionTasks.read(sessionId).values()].some(isLiveTask);
  }

  /** Background work still moving: `livenessOf`'s "monitoring" half, asked of
   *  the tasks directly by callers that must not trust a stale index row. */
  private hasLiveBackgroundWork(sessionId: string): boolean {
    return [...this.sessionTasks.read(sessionId).values()].some((task) => countsAsActivity(task) && isBackgroundWork(task));
  }

  /**
   * Refuses new work (a session, a turn or wake, a settings change) on a removed project or an unplugged
   * drive. Reads stay open, so a removed project's history still answers.
   */
  private assertProjectAvailable(projectId: string): void {
    const project = this.getProject(projectId);
    if (project.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
    }
    // Probed fresh, and `unmounted` only: a missing folder is refused by the worker, in the conversation,
    // and an unplugged drive needs a cable rather than a re-registration that would mint a new project id.
    if (this.projectAvailability(project) === "unmounted") {
      throw new EngineStateError("conflict", `The drive holding ${project.name} is not connected. Plug it back in and this will work again.`);
    }
  }

  getProject(projectId: string): Project {
    return this.projectRegistry.get(projectId);
  }

  updateProject(projectId: string, patch: ProjectPatch): Project {
    return this.projectRegistry.update(projectId, patch);
  }

  /**
   * Where a departure is announced. One subscriber — the plugin host — so a
   * plugin with per-session state gives it back without the store naming it.
   */
  private pluginRelease: ((sessionId: string, reason: string) => void) | undefined;

  /**
   * Every assignment this session holds, folded over its WHOLE queue.
   *
   * Authoritative over what the engine STILL HOLDS: a client's transcript may be
   * a page, and a fold over a page cannot tell "the joined run finished" from
   * "the joined run is not in this window". The engine has every turn it has
   * kept, so it answers once and the answer rides the snapshot.
   *
   * `unresolved` can still occur here, and saying otherwise would be a lie:
   * journal retention or a deleted turn can remove a carrier the engine no
   * longer has. That is genuinely unknown, and reporting it as unknown is the
   * honest answer — not "running", and not a guess at an outcome.
   */
  sessionAssignments(sessionId: string): SessionAssignment[] {
    // A PLAIN cast, not `as unknown as`: the structural type names fields a
    // `Turn` really has, so a rename that breaks the fold is a type error here
    // rather than an `undefined` on every assignment (issue #380).
    return assignmentsOf(this.readQueue(sessionId).turns as AssignmentTurn[]);
  }

  /**
   * CONTINUE INDEPENDENTLY. Stops PRESENTING an assignment as active without
   * deleting anything: the task turn, its outcome and the session's
   * `startedFrom` all remain, and nothing running is stopped.
   *
   * Marks every outstanding task turn rather than taking a run id, because
   * "continue independently" is a statement about the session's relationship to
   * its coordinators, not about one message.
   */
  detachAssignments(sessionId: string, runId?: string): Turn[] {
    const session = this.records.get(sessionId);
    const at = this.now();
    const queue = this.readQueue(session.id);
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
      this.writeQueue(session.id, queue);
      // No `turn.updated` kind exists; the cockpit refolds from the snapshot on
      // `session.updated`, which is what a detach changes for a reader.
      this.appendEvent(sessionId, { type: "session.updated", session });
    }
    return detached;
  }

  machinePlugins(): ProjectPlugins {
    return this.toolchains.machine();
  }

  updateMachinePlugins(patch: PluginPatch): ProjectPlugins {
    return this.toolchains.updateMachine(patch);
  }

  pluginRuns(project: Project, id: string): boolean {
    return this.toolchains.runs(project, id);
  }

  attachPluginRelease(release: (sessionId: string, reason: string) => void): void {
    this.pluginRelease = release;
  }

  enabledPluginIds(session: Session): string[] {
    return this.toolchains.enabledIds(session);
  }

  dataScienceToolchain(fresh = false): Promise<Toolchain> {
    return this.dataScienceOps.toolchain(fresh);
  }

  dataScienceEnvironments(projectId: string, workspace?: string) {
    return this.dataScienceOps.environments(projectId, workspace);
  }

  dataScienceUseEnvironment(sessionId: string, target: string) {
    return this.dataScienceOps.useEnvironment(sessionId, target);
  }

  dataScienceCreateEnvironment(projectId: string, request: CreateEnvironmentRequest): Promise<{ jobId: string }> {
    return this.dataScienceOps.createEnvironment(projectId, request);
  }

  dataSciencePackages(projectId: string, workspace?: string) {
    return this.dataScienceOps.packages(projectId, workspace);
  }

  dataScienceInstall(projectId: string, input: { add?: string[]; remove?: string[]; requirements?: RequirementsSource }, workspace?: string): Promise<{ jobId: string }> {
    return this.dataScienceOps.install(projectId, input, workspace);
  }

  dataScienceBootstrap(request: BootstrapRequest): Promise<{ jobId: string }> {
    return this.dataScienceOps.bootstrap(request);
  }

  dataScienceJob(jobId: string, after?: number): JobRead {
    return this.dataScienceOps.job(jobId, after);
  }

  dataScienceCancelJob(jobId: string): void {
    this.dataScienceOps.cancelJob(jobId);
  }

  dataScienceProbe(projectId: string, target: string) {
    return this.dataScienceOps.probe(projectId, target);
  }

  latexToolchain(fresh = false): Promise<LatexToolchain> {
    return this.latexOps.toolchain(fresh);
  }

  latexDistributions(projectId: string) {
    return this.latexOps.distributions(projectId);
  }

  latexBootstrap(request: LatexBootstrapRequest): Promise<{ jobId: string }> {
    return this.latexOps.bootstrap(request);
  }

  latexPackages(projectId: string): Promise<LatexPackagesAnswer> {
    return this.latexOps.packages(projectId);
  }

  latexInstall(projectId: string, input: { add?: string[]; remove?: string[] }): Promise<{ jobId: string }> {
    return this.latexOps.install(projectId, input);
  }

  latexJob(jobId: string, after?: number): JobRead {
    return this.latexOps.job(jobId, after);
  }

  latexCancelJob(jobId: string): void {
    this.latexOps.cancelJob(jobId);
  }

  private createPluginOps(): { dataScienceOps: DataScienceOps; latexOps: LatexOps } {
    return {
      dataScienceOps: new DataScienceOps(this.toolchains, this.dsJobs, {
        root: this.paths.root,
        now: () => this.now(),
        getProject: (projectId) => this.getProject(projectId),
        updateProject: (projectId, patch) => this.updateProject(projectId, patch),
        getSession: (sessionId) => this.records.get(sessionId),
        restartKernel: (sessionId) => this.dataScience(sessionId).restart(),
        machinePlugins: () => this.machinePlugins(),
      }),
      latexOps: new LatexOps(this.toolchains, this.latexJobs, (projectId) => this.getProject(projectId)),
    };
  }

  /**
   * Stamp where the repository stands, OFF THE LOCK — issue #741.
   *
   * ────────────────────────────────────────────────────────────────────────
   * NEVER THE SYNCHRONOUS RUNNER, AND NEVER INLINE. `worktree.ts`'s header
   * records what that costs: `listProjects` calling sync git in the daemon loop
   * froze every request, and a `rev-parse --abbrev-ref HEAD` on a project under
   * `~/Documents` blocked FOR MINUTES in the kernel. `markRunning` runs for
   * every turn of every session, under the store lock. So the probe is
   * dispatched and the answer written back when it arrives; a turn is never
   * held waiting for git, and the worst case is an anchor that lands a moment
   * after the event that named it.
   * ────────────────────────────────────────────────────────────────────────
   *
   * A PROBE THAT DID NOT ANSWER SETS `read` RATHER THAN LEAVING A PLAUSIBLE
   * ABSENT. Absent with no `read` means "there was nothing to see" — a
   * repository with no commits yet, which `rev-parse --verify` reports by
   * exiting non-zero. The two are different claims and #654 is the precedent
   * for keeping them apart.
   */
  private anchorTurn(sessionId: string, runId: string, side: "before" | "after"): void {
    let cwd: string | undefined;
    try {
      /**
       * `requireSession`, NOT `getSession` — #545's lesson, and this method is
       * exactly the caller it was written about.
       *
       * `getSession` folds the session's ACTIVITY, which parses `queue.json`,
       * `requests.json` and `tasks.json` to derive a pill nothing here looks
       * at. This runs INSIDE `markRunning` and the three terminal transitions,
       * which `queue-write-path.test.ts` pins at a fixed number of whole-queue
       * parses each — so the fold turned `markRunning`'s 2 into 3. All this
       * wants is the workspace and the project id.
       */
      cwd = this.workspaceReads.anchorReadRoot(this.records.require(sessionId));
    } catch {
      // A session that vanished between the transition and this line has
      // nothing to anchor; the turn's own record is already written.
      return;
    }
    if (cwd === undefined) return;
    // A TURN THAT ENDED HAS JUST WRITTEN TO THIS CHECKOUT. Every terminal
    // transition passes here, so the review surfaces' cached reads of it are
    // dropped rather than served for up to another two seconds.
    if (side === "after") this.forgetGitReadsUnder(cwd);
    void this.asyncGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: ANCHOR_PROBE_MS })
      .then((result) => this.stampAnchor(sessionId, runId, side, result))
      .catch(() => {
        // The runner reports every failure as a result; a throw here would be
        // the store itself, and it must not take the daemon with it.
      });
  }

  /**
   * Write one side of an anchor onto whatever the turn says NOW.
   *
   * RE-READ RATHER THAN CLOSED OVER, exactly as `settleWorktree` is: git ran
   * while the world moved, and writing a turn captured before the probe would
   * silently undo whatever happened during it. A turn that no longer exists is
   * not an error — there is simply nothing left to stamp.
   *
   * THROUGH `executeCommand`, because this arrives on a promise rather than
   * through the wrapped command surface, and a queue write outside the
   * transaction is a queue write nothing serialises.
   */
  private stampAnchor(sessionId: string, runId: string, side: "before" | "after", result: GitResult): void {
    /**
     * FOUR ANSWERS FROM ONE COMMAND, and the third is the one worth naming.
     *
     *   status 0   a sha. Write it.
     *   timedOut   nobody looked. `read: "timeout"`, and the sha stays absent
     *              rather than becoming a plausible wrong one.
     *   status 1   `--verify --quiet` reporting that HEAD does not resolve — a
     *              repository with NO COMMITS YET. Nothing to write, and
     *              nothing wrong: absent with no `read` is the honest record,
     *              and the empty-tree sha would be a sentinel a reader could
     *              also have named deliberately.
     *   anything   git did not answer at all (128 on a path that is not a
     *   else       repository). `read: "failed"`.
     */
    if (result.timedOut) return this.writeAnchor(sessionId, runId, { read: "timeout" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      return this.writeAnchor(sessionId, runId, sha ? { [side]: sha } : { read: "failed" });
    }
    if (result.status === 1) return;
    this.writeAnchor(sessionId, runId, { read: "failed" });
  }

  private writeAnchor(sessionId: string, runId: string, patch: { before?: string; after?: string; read?: GitReadFailure }): void {
    if (Object.keys(patch).length === 0) return;
    try {
      this.kernel.command("stampTurnAnchor", () => {
        const queue = this.readQueue(sessionId);
        const turn = queue.turns.find((candidate) => candidate.runId === runId);
        if (!turn) return;
        const merged = { ...turn.anchor, ...patch };
        // A LATER GOOD READ CLEARS AN EARLIER DOUBT, but a doubt never erases a
        // sha somebody already observed: `before` and `after` are separate
        // observations and only the failing one is in doubt.
        if (patch.read === undefined) delete merged.read;
        turn.anchor = merged;
        turn.updatedAt = this.now();
        this.writeQueue(sessionId, queue);
      });
    } catch {
      // A session deleted while the probe ran leaves nothing to write to.
    }
  }

  projectGitAsync(projectId: string): Promise<GitOverview> {
    return this.workspaceReads.projectOverview(projectId);
  }

  projectDiffAsync(projectId: string): Promise<SessionDiff> {
    return this.workspaceReads.projectDiff(projectId);
  }

  sessionDiffAsync(sessionId: string, options: DiffBaseOption = {}): Promise<SessionDiff> {
    return this.workspaceReads.sessionDiff(sessionId, options);
  }

  projectFilePatchAsync(projectId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    return this.workspaceReads.projectFilePatch(projectId, target, options);
  }

  sessionFilePatchAsync(sessionId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    return this.workspaceReads.sessionFilePatch(sessionId, target, options);
  }

  modelCatalogue(driver: ProviderDriverKind, options: { force?: boolean; instanceId?: string } = {}): Promise<ModelCatalogue> {
    return this.catalogues.catalogue(driver, options);
  }

  prefetchModelCatalogues(drivers?: readonly ProviderDriverKind[]): Promise<void> {
    return this.catalogues.prefetch(drivers);
  }

  getModelOverlay(instanceId: string): ModelOverlay {
    return this.catalogues.overlay(instanceId);
  }

  setModelOverlay(instanceId: string, patch: { favorites?: unknown; hidden?: unknown; order?: unknown; custom?: unknown; default?: unknown }): ModelOverlay {
    return this.catalogues.setOverlay(instanceId, patch);
  }

  projectGitHub(projectId: string, options: { force?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {}): Promise<GitHubSnapshot> {
    return this.github.list(projectId, options);
  }

  projectForgeFacets(projectId: string, options: { force?: boolean } = {}): Promise<GitHubFacets> {
    return this.github.facetsOf(projectId, options);
  }

  projectCheckLog(projectId: string, jobId: string): Promise<GitHubCheckLog> {
    return this.github.checkLog(projectId, jobId);
  }

  /**
   * Ignore Telar's own files in a project's repository.
   *
   * THE ONLY WRITE IN THIS STORE THAT TOUCHES A FILE THE USER DID NOT NAME, which
   * is why the rules live in the engine (`gitignore.ts`) and this method takes a
   * project id and nothing else. A caller that could pass the lines could append
   * anything to a file inside somebody's repository.
   */
  projectGitignore(projectId: string): GitignoreResult {
    return ensureTelarGitignore(this.getProject(projectId).root);
  }

  /**
   * Take those rules back out — the Undo behind the toast that reports them.
   *
   * IT EXISTS BECAUSE THE WRITE STOPPED ASKING. Registering a project now ignores
   * Telar's files by default (the switch in the old Register dialog became a
   * default), and a write into somebody's repository that nobody opted into needs
   * a way back that is as cheap as the way in.
   */
  undoProjectGitignore(projectId: string): GitignoreRemoval {
    return removeTelarGitignore(this.getProject(projectId).root);
  }

  /**
   * CLONE A REPOSITORY AND REGISTER WHAT LANDED — the Sources palette's "Git URL"
   * and "GitHub repository" rows, in one request.
   *
   * ONE CALL RATHER THAN TWO, because the cockpit cannot name the path in between:
   * it hands over a URL and a parent folder, and only the engine knows which
   * directory `git clone` created. Splitting it would mean answering a path to a
   * client whose next call would be "now register this path I did not choose".
   *
   * THE CLONE IS NOT UNDONE WHEN THE REGISTRATION FAILS. The checkout on disk is
   * the expensive half and it is perfectly good; `registerProject` refuses for
   * reasons a person can act on (a root already registered under another name),
   * and deleting somebody's fresh clone to tidy up after that would be the worst
   * possible reading of the error.
   */
  async cloneProject(input: { url: string; parent: string; name?: string }): Promise<Project> {
    // The MUTATION pool: a clone is minutes at worst, and it must neither hold
    // the thread nor a slot the rail's reads need.
    const outcome = await cloneRepository(this.worktreeGit, { url: input.url, parent: input.parent });
    if (isCloneFailure(outcome)) {
      throw new EngineStateError(outcome.code === "failed" ? "invalid_request" : outcome.code, outcome.message);
    }
    const folder = outcome.root.split("/").pop() ?? outcome.root;
    return this.registerProject({ name: input.name?.trim() || folder, root: outcome.root });
  }

  projectIssue(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubIssueRead> {
    return this.github.issue(projectId, number, options);
  }

  projectPull(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubPullRead> {
    return this.github.pull(projectId, number, options);
  }

  projectPullMerge(projectId: string, number: number, input: { method: GitHubMergeMethod; expectedHeadOid: string }): Promise<GitHubMergeResult> {
    return this.github.merge(projectId, number, input);
  }

  projectGitHubComment(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; body: string },
    proof: { sessionId: string; runId: string; claimToken: string },
  ): Promise<GitHubCommentResult> {
    return this.github.comment(projectId, input, proof);
  }

  projectGitHubReaction(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; subjectId: string; content: GitHubReactionContent; react: boolean },
  ): Promise<GitHubReactionResult> {
    return this.github.react(projectId, input);
  }

  projectThreadReply(projectId: string, number: number, input: { threadId: string; body: string }): Promise<GitHubThreadReplyResult> {
    return this.github.threadReply(projectId, number, input);
  }

  projectThreadResolve(projectId: string, number: number, input: { threadId: string; resolved: boolean }): Promise<GitHubThreadResolveResult> {
    return this.github.threadResolve(projectId, number, input);
  }

  /**
   * Snapshot the session's work as one commit.
   *
   * THE ONE GIT MUTATION THE ENGINE OFFERS. It is additive and reversible, a
   * human pressed it, and it runs in the session's own checkout — see
   * `commitSessionWork` for why staging, branch switching and discarding are
   * deliberately absent rather than pending.
   *
   * NOT `async`, so a bad message is refused before the first await. On the
   * MUTATION pool, like a cut: `add -A` and a pre-commit hook are seconds, and
   * the rail's reads must not queue behind them. What the commit changed is
   * dropped from the read cache — this is a write the store KNOWS about, and a
   * two-second-old "3 changed" beside a fresh commit is the badge lying.
   */
  commitSessionWork(sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    const session = this.records.get(sessionId);
    const text = message.trim();
    if (!text) throw new EngineStateError("invalid_request", "a commit message is required");
    if (text.length > 2_000) throw new EngineStateError("invalid_request", "commit message is too long");
    const cwd = workspaceRootOf(session);
    return commitSessionWork(this.worktreeGit, { cwd, message: text }).finally(() => this.forgetGitReadsUnder(cwd));
  }

  /**
   * Publish this session's branch — issue #670.
   *
   * ── THE BINDING IS THE STORE'S, NEVER THE CALLER'S ──────────────────────────
   * The checkout, the mode and the branch all come off the session record. A
   * request body that could name a branch could ask this engine to push any ref
   * in any repository on the machine, which is the same reason `sessionDiff`
   * takes no directory and `projectGitHubComment` takes no session id.
   *
   * ── ON THE MUTATION POOL, NOT THE READ POOL ─────────────────────────────────
   * `worktreeGit` has two slots against the read pool's four and is already the
   * home of the engine's other slow git children. A push is the slowest of them
   * and the only one whose clock is somebody's upload; putting it in the read
   * pool would let one person's first push of a large branch hold a quarter of
   * the capacity every rail poll draws from. It is bounded at
   * `PUSH_TIMEOUT_MS` so a slot cannot be held indefinitely.
   */
  async pushSessionBranch(sessionId: string): Promise<GitPushResult> {
    const session = this.records.get(sessionId);
    const workspace = session.workspace;
    if (workspace.mode === "none") throw new EngineStateError("invalid_request", "this session has no working directory");
    const cwd = workspaceRootOf(session);
    try {
      return structuredClone(
        await pushSessionBranch(this.worktreeGit, {
          cwd,
          mode: workspace.mode,
          ...(workspace.mode === "worktree" ? { branch: workspace.branch } : {}),
        }),
      );
    } finally {
      // Ahead/behind in the overview moved with the push.
      this.forgetGitReadsUnder(cwd);
    }
  }

  openSessionPullRequest(sessionId: string, input: { title: string; body?: string; base?: string }): Promise<GitHubPullCreateResult> {
    return this.sessionPulls.open(sessionId, input);
  }

  sessionPullAnchor(sessionId: string): Promise<GitHubPullAnchor> {
    return this.sessionPulls.anchor(sessionId);
  }

  sessionPullLineComment(sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    return this.sessionPulls.lineComment(sessionId, input);
  }

  projectFilesAsync(projectId: string): Promise<WorkspaceListing> {
    return this.workspaceReads.projectFiles(projectId);
  }

  sessionFilesAsync(sessionId: string): Promise<WorkspaceListing> {
    return this.workspaceReads.sessionFiles(sessionId);
  }

  projectFileAsync(projectId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(this.getProject(projectId).root, target, "project");
  }

  sessionFileAsync(sessionId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  projectFileBytesAsync(projectId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(this.getProject(projectId).root, target, "project");
  }

  sessionFileBytesAsync(sessionId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  /** `expected` is the hash the editor read; a stale one is refused rather than overwritten. */
  projectFileWrite(projectId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const project = this.getProject(projectId);
    return writeFenced(project.root, target, text, expected, "project");
  }

  sessionFileWrite(sessionId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const session = this.records.get(sessionId);
    return writeFenced(workspaceRootOf(session), target, text, expected, "session workspace");
  }

  /**
   * Run a synchronous store command with its git questions already answered
   * off the pool — see `prefetchedGit`. The answers live for exactly `work`:
   * it is synchronous, so nothing else can run while they are set.
   */
  private async withPrefetchedGit<T>(cwd: string, questions: string[][], work: () => T): Promise<T> {
    // De-duplicated BEFORE spawning: a default base is `rev-parse HEAD`, which a
    // local session's own base asks too.
    const unique = new Map(questions.map((args) => [prefetchKey(cwd, args), args]));
    const answers = new Map<string, GitResult>(
      await Promise.all([...unique].map(async ([key, args]) => [key, await this.asyncGit(cwd, args)] as const)),
    );
    this.prefetchedGit = answers;
    try {
      return work();
    } finally {
      this.prefetchedGit = undefined;
    }
  }

  /** The `rev-parse`s a worktree cut's refusals ask (`prepareSessionWorktree`). */
  private static cutQuestions(baseRef: string | undefined): string[][] {
    const base = prefetchableRef(baseRef);
    return [["rev-parse", "--is-inside-work-tree"], ...(base ? [["rev-parse", base]] : [])];
  }

  /**
   * `createSession` FOR THE REQUEST PATH — the same command, with its git
   * questions (`isGitWorkTree`, the cut's base, a local session's HEAD) read
   * through the pool first instead of on the engine's only thread. Measured on
   * an external disk: 2.4 s of a frozen daemon per new session, before this.
   *
   * A project that is not there skips the prefetch: `createSession` refuses it
   * before asking git anything, and asking git about an unplugged drive is the
   * thing #534 took out.
   */
  async createSessionAsync(input: Parameters<EngineStore["createSession"]>[0]): Promise<Session> {
    let project: Project | undefined;
    try {
      project = input.projectId === undefined ? undefined : this.getProject(input.projectId);
    } catch {
      // `createSession` refuses this itself, in its own order and words.
      return this.createSession(input);
    }
    if (project === undefined || this.projectAvailability(project) !== "available") return this.createSession(input);
    const questions = [...EngineStore.cutQuestions(input.baseRef), ["rev-parse", "HEAD"]];
    return this.withPrefetchedGit(project.root, questions, () => this.createSession(input));
  }

  /**
   * `submitTurn` FOR THE REQUEST PATH. Only the first send to a WORKTREE DRAFT
   * asks git anything — it promotes the draft and plans its cut — so every
   * other send is the synchronous command exactly as it was.
   */
  async submitTurnAsync(...args: Parameters<EngineStore["submitTurn"]>): Promise<ReturnType<EngineStore["submitTurn"]>> {
    return this.promotingDraft(args[0], () => this.submitTurn(...args));
  }

  /** `submitAgentTurn` for the request path and the `sessions` tools — an
   *  agent's message to a worktree draft promotes it exactly as a person's does. */
  async submitAgentTurnAsync(...args: Parameters<EngineStore["submitAgentTurn"]>): Promise<ReturnType<EngineStore["submitAgentTurn"]>> {
    return this.promotingDraft(args[0], () => this.submitAgentTurn(...args));
  }

  /**
   * Prefetch a worktree draft's cut questions, then run `work`. Anything that
   * is not a promotable draft — including a session that does not resolve — is
   * handed straight to `work`, so every refusal keeps its original order.
   */
  private async promotingDraft<T>(sessionId: string, work: () => T): Promise<T> {
    let root: string | undefined;
    let baseRef: string | undefined;
    try {
      const session = this.records.require(sessionId);
      if (session.draft && session.envMode === "worktree" && session.projectId) {
        const project = this.getProject(session.projectId);
        if (this.projectAvailability(project) === "available") {
          root = project.root;
          baseRef = session.draft.baseRef;
        }
      }
    } catch {
      // Refused by `work` below, in its own words.
    }
    return root === undefined ? work() : this.withPrefetchedGit(root, EngineStore.cutQuestions(baseRef), work);
  }

  createSession(input: Parameters<SessionLifecycle["createSession"]>[0]): Session {
    return this.lifecycle.createSession(input);
  }







  updateSession(sessionId: string, patch: Parameters<SessionLifecycle["updateSession"]>[1]): Session {
    return this.lifecycle.updateSession(sessionId, patch);
  }

  refreshWorktreeBranchFromTitle(sessionId: string): Promise<string | undefined> {
    return this.lifecycle.refreshWorktreeBranchFromTitle(sessionId);
  }

  getSession(sessionId: string): Session {
    return this.records.get(sessionId);
  }

  markSessionRead(sessionId: string, runId: string): Session {
    return this.records.markRead(sessionId, runId);
  }

  listSessions(projectId: string): Session[] {
    this.getProject(projectId);
    // By the (project_id, updated_at) index, so only this project's documents are parsed.
    const rows = this.kernel.executionStore.projectSessionRows(projectId);
    return this.records.read(new Set(rows.map((row) => row.id)));
  }

  /** Each project's latest activity, folded off the index rather than the documents. Active sessions only,
   *  matching the list it replaced, so a project whose sessions are all archived scores nothing. */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    return this.kernel.executionStore.projectActivity();
  }

  /**
   * Every active session across projects in one read, with the registry and the sidebar
   * layout beside it: every rail polls this, so a drag on one device reaches the others.
   */
  liveSessions(only?: Set<string>): {
    sessions: Session[];
    // The rail's "drive not connected" badge, so it needs no second fetch per pass.
    projects: Array<{ id: string; name: string; availability?: ProjectAvailability }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
  } {
    const projects = this.projectRegistry.read().projects;
    // One pass over the queues answers activity and assignments, not a history fetch per row.
    const { sessions, assignments } = this.activity.foldLive(only);
    return {
      sessions,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        // Removed projects are in `projects` here (it is the raw registry), and
        // a put-away checkout is never probed — see `listProjects`.
        ...(project.removedAt === undefined ? { availability: this.projectAvailability(project) } : {}),
      })),
      assignments,
      layout: this.getSidebarLayout(),
    };
  }

  /**
   * `liveSessions` projected to what a rail draws (`LiveSessionRow`), with the settling window.
   * Unsettled rows only unless `all`; the shelf rule is the clients' own `isShelved`.
   */
  liveSessionRows(options: { all?: boolean } = {}): {
    sessions: LiveSessionRow[];
    projects: Array<{ id: string; name: string }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
    inbox: InboxPolicy;
    revision: number;
    settledCount: number;
    /** Open terminals per session in this answer, whoever opened them (#883). */
    terminals: Record<string, number>;
  } {
    // Read first, so a write that lands mid-fold is reported by the next read rather than swallowed.
    const revision = this.sessionsRevision({ all: options.all === true });
    const inbox = this.getInboxPolicy();
    // Every conversation settles by the same rule; nothing is exempted.
    const indexed = this.activity.shelf(inbox, options.all === true);
    // Documents are read only for rows that survived the partition; activity is re-derived
    // from them rather than trusted from a possibly stale row.
    const full = this.liveSessions(indexed.chosen);
    return {
      ...full,
      sessions: full.sessions.map(liveRow),
      inbox,
      revision,
      settledCount: indexed.settledCount,
      terminals: this.sessionTerminals.countsFor(full.sessions.map((session) => session.id)),
    };
  }

  turns(sessionId: string): Turn[] {
    this.records.require(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  turnOutline(...args: Parameters<SessionQueries["turnOutline"]>): ReturnType<SessionQueries["turnOutline"]> {
    return this.queries.turnOutline(...args);
  }

  runItems(...args: Parameters<SessionQueries["runItems"]>): ReturnType<SessionQueries["runItems"]> {
    return this.queries.runItems(...args);
  }

  runItem(...args: Parameters<SessionQueries["runItem"]>): ReturnType<SessionQueries["runItem"]> {
    return this.queries.runItem(...args);
  }

  turnAnswer(...args: Parameters<SessionQueries["turnAnswer"]>): ReturnType<SessionQueries["turnAnswer"]> {
    return this.queries.turnAnswer(...args);
  }

  grepSession(...args: Parameters<SessionQueries["grepSession"]>): ReturnType<SessionQueries["grepSession"]> {
    return this.queries.grepSession(...args);
  }

  findSessions(...args: Parameters<SessionQueries["findSessions"]>): ReturnType<SessionQueries["findSessions"]> {
    return this.queries.findSessions(...args);
  }

  snapshotWindow(...args: Parameters<SessionQueries["snapshotWindow"]>): ReturnType<SessionQueries["snapshotWindow"]> {
    return this.queries.snapshotWindow(...args);
  }

  snapshotRequests(sessionId: string): EngineRequest[] {
    return this.queries.snapshotRequests(sessionId);
  }













  items(sessionId: string): Item[] {
    this.records.require(sessionId);
    return structuredClone([...this.sessionItems.read(sessionId).values()]);
  }

  tasks(sessionId: string): Task[] {
    this.records.require(sessionId);
    return structuredClone([...this.sessionTasks.read(sessionId).values()]);
  }

  putAttachment(sessionId: string, input: AttachmentInput): TurnAttachment {
    return this.attachments.put(sessionId, input);
  }


  private createClaims(): TurnClaims {
    return new TurnClaims(this.kernel, {
      records: this.records,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      mailbox: this.mailbox,
      catalogues: this.catalogues,
      computerUse: () => this.computerUse?.(),
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      requeueUndeliveredSteers: (queue, runId, at) => this.requeueUndeliveredSteers(queue, runId, at),
      fireSubscriptions: (id, kind, turn, context) => this.fireSubscriptions(id, kind, turn, context),
      flushPendingNotifications: (id) => this.flushPendingNotifications(id),
      getSessionDefaults: () => this.getSessionDefaults(),
      listMcpServers: () => this.listMcpServers(),
      resolveProviderInstance: (instanceId, driver) => this.resolveProviderInstance(instanceId, driver),
      getProject: (id) => this.getProject(id),
      resolveDataScience: (session) => this.resolveDataScience(session),
      resolveLatex: (session) => this.resolveLatex(session),
      enabledPluginIds: (session) => this.enabledPluginIds(session),
      getAgentOrientation: () => this.getAgentOrientation(),
    });
  }

  private createTurnLifecycle(): TurnLifecycle {
    return new TurnLifecycle(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      requireRunningClaimFromQueue: (queue, runId, token) => this.requireRunningClaimFromQueue(queue, runId, token),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      anchorTurn: (id, runId, side) => this.anchorTurn(id, runId, side),
      fireSubscriptions: (id, kind, turn, context) => this.fireSubscriptions(id, kind, turn, context),
      flushPendingNotifications: (id) => this.flushPendingNotifications(id),
      evaluateDelegationSettling: (id) => this.evaluateDelegationSettling(id),
      stopBackgroundTasks: (id) => this.stopBackgroundTasks(id),
      announceStoppedClaims: (cancellations) => this.announceStoppedClaims(cancellations),
    });
  }

  private createIntake(): TurnIntake {
    return new TurnIntake(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      mailbox: this.mailbox,
      attachments: this.attachments,
      git: this.git,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      getProject: (id) => this.getProject(id),
      availability: (project) => this.projectAvailability(project),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      restoreWorktree: (id) => void this.restoreSessionWorktree(id),
      prepareWorktree: (id, root, plan, baseSha) => this.lifecycle.prepareWorktree(id, root, plan, baseSha),
      promoteTurn: (id, runId) => this.promoteTurn(id, runId),
      requireSenderClaim: (proof) => this.requireSenderClaim(proof),
      hasLiveTurn: (id) => this.hasLiveTurn(id),
      waitingNotificationTurn: (id) => this.waitingNotificationTurn(id),
      joinWaitingNotification: (id, waitingRunId, notification) => this.joinWaitingNotification(id, waitingRunId, notification),
      rewriteNotificationItem: (id, turn) => this.rewriteNotificationItem(id, turn),
      waitingSubscription: (subscriber, target) =>
        this.subscriptions.readSubscriptions().some((sub) => sub.subscriberSessionId === subscriber && sub.targetSessionId === target && sub.events.includes("turn_completed")),
      cohortHolds: (id, sender) => this.subscriptions.cohortHolds(id, sender),
      recordCohortMessage: (id, sender, intent, runId, text) => this.subscriptions.recordCohortMessage(id, sender, intent, runId, text),
    });
  }

  submitTurn(sessionId: string, input: TurnSubmission): { turn: Turn; replayed: boolean } {
    return this.intake.submitTurn(sessionId, input);
  }

  submitAgentTurn(...args: Parameters<TurnIntake["submitAgentTurn"]>): { turn: Turn; replayed: boolean } {
    return this.intake.submitAgentTurn(...args);
  }

  private writeNotificationItem(sessionId: string, turn: Turn): void {
    this.intake.writeNotificationItem(sessionId, turn);
  }


  /**
   * DEPRECATED — A COMPATIBILITY ALIAS FOR `stopSession`.
   *
   * There is no persistent pause any more. It meant "stop, and stay stopped
   * until a human presses Resume", and the person it was built for said the
   * plainest possible thing about it: hitting stop should stop a session, not
   * put it in a pause for them to resume. Stop is stop, from every origin —
   * the button, this route, `sessions_stop`, a crash, an update.
   *
   * KEPT AS A NAME so an older client (a phone that has not updated, a script)
   * calling `/pause` gets the behaviour the app now has rather than a 404 or,
   * far worse, a latch nothing in the product knows how to lift. It returns
   * the old shape: `held` is always 0, because nothing is held any more, and
   * `already` is always false, because there is no latch to be already in.
   *
   * `by` is ignored. It distinguished a human's pause from an agent's, and the
   * two are now the same verb with the same result — which is the whole point
   * of the change.
   */
  pauseSession(sessionId: string, _by: "human" | "session" = "human"): { session: Session; stopped?: Turn; held: number; already: boolean } {
    return this.kernel.command("pauseSession", () => {
      const session = this.records.get(sessionId);
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
      const { live } = this.stopSession(sessionId);
      return { session: this.activity.of(structuredClone(this.records.get(sessionId))), ...(live ? { stopped: live } : {}), held: 0, already: false };
    });
  }

  /**
   * DEPRECATED, AND INERT IN PRACTICE. Nothing sets `paused` any more and boot
   * clears any latch left on disk, so there is no pause left to lift and no
   * held message left to release. Kept so an older client's `/resume` answers
   * instead of erroring, and so a latch written by a build older than this one
   * still has a way off in the window before the next restart.
   *
   * IT RELEASES ONLY WHAT AN OLD PAUSE HELD (`held.reason === "session_paused"`),
   * which is the one case where running the messages IS what the person asked
   * for: they pressed Resume. Nothing else here starts work.
   *
   * Historically: a human resumes; the pause comes off and every message it
   * held is released, in its original order — the worker's next heartbeat
   * claims the oldest.
   *
   * WHAT "HUMAN ONLY" ACTUALLY MEANS HERE, stated exactly: the sessions tool
   * wall has no resume, and the worker's client (`WorkerClient`) cannot call
   * this, so no session — Claude in-process, Codex over the socket, a chat
   * client on the outward sessions socket — can lift a pause through Telar's
   * agent surfaces. It is NOT a security boundary: `/resume` answers to the
   * engine's ordinary bearer, and an agent with a shell and the engine's
   * `engine.json` could POST it, exactly as it could POST anything else on
   * this API. Telar has no separate trusted-UI credential to gate it on, and
   * inventing one is not this fix.
   */
  resumeSession(sessionId: string): { session: Session; released: number; already: boolean } {
    return this.kernel.command("resumeSession", () => {
      const session = this.records.get(sessionId);
      if (!session.paused) return { session: this.activity.of(structuredClone(session)), released: 0, already: true };
      if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
      const at = this.now();
      const queue = this.readQueue(sessionId);
      const released: Turn[] = [];
      for (const turn of queue.turns) {
        if (turn.state !== "queued" || turn.held?.reason !== "session_paused") continue;
        delete turn.held;
        turn.updatedAt = at;
        released.push(turn);
      }
      if (released.length > 0) this.writeQueue(sessionId, queue);
      delete session.paused;
      session.updatedAt = at;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
      for (const turn of released) this.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
      this.appendEvent(sessionId, { type: "session.resumed", released: released.length });
      this.appendEvent(sessionId, { type: "session.updated", session });
      return { session: this.activity.of(structuredClone(session)), released: released.length, already: false };
    });
  }







  claimTurn(sessionId: string, workerId: string): Turn | undefined {
    return this.claims.claimTurn(sessionId, workerId);
  }


  openProviderTurn(...args: Parameters<TurnClaims["openProviderTurn"]>): Turn {
    return this.claims.openProviderTurn(...args);
  }


  listAdoptableClaudeConversations(options: { instanceId?: string; cwd?: string; limit?: number } = {}): Promise<ClaudeConversation[]> {
    return this.adoption.list(options);
  }

  adoptClaudeConversation(sessionId: string, input: AdoptionInput) {
    return this.adoption.adopt(sessionId, input);
  }

  reportSessionTasks(sessionId: string, workerId: string, observations: unknown[]): { accepted: number } {
    return this.ingest.reportSessionTasks(sessionId, workerId, observations);
  }

  claudeAdmissionNeedsCatalogue(sessionId: string, turnModel?: { model?: string }): boolean {
    return this.claims.claudeAdmissionNeedsCatalogue(sessionId, turnModel);
  }




  prepareClaudeCatalogue(timeoutMs?: number): Promise<void> {
    return this.catalogues.prepareClaude(timeoutMs);
  }





  claimNextTurn(workerId: string): WorkerClaim | undefined {
    return this.claims.claimNextTurn(workerId);
  }




  markRunning(sessionId: string, runId: string, claimToken: string): Turn {
    return this.turnLifecycle.markRunning(sessionId, runId, claimToken);
  }


  ingestObservations(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    return this.ingest.ingestObservations(sessionId, runId, claimToken, observations);
  }




  completeTurn(...args: Parameters<TurnLifecycle["completeTurn"]>): Turn {
    return this.turnLifecycle.completeTurn(...args);
  }


  resumeRateLimitedTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.resumeRateLimitedTurn(sessionId, runId);
  }


  failTurn(...args: Parameters<TurnLifecycle["failTurn"]>): Turn {
    return this.turnLifecycle.failTurn(...args);
  }


  stopSession(sessionId: string, by: "user" | "agent" = "user"): { stopped: Turn[]; live?: Turn } {
    return this.turnLifecycle.stopSession(sessionId, by);
  }


  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    return this.turnLifecycle.stopTurn(sessionId, requestedRunId);
  }



  promoteTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.promoteTurn(sessionId, runId);
  }


  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Turn {
    return this.turnLifecycle.ackSteer(sessionId, steerRunId, claimToken);
  }


  private requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    return this.turnLifecycle.requeueUndeliveredSteers(queue, runId, at);
  }


  releaseHeldTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.releaseHeldTurn(sessionId, runId);
  }


  discardAmbiguousTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.discardAmbiguousTurn(sessionId, runId);
  }


  archiveSession(sessionId: string, options: { releaseCheckout?: boolean } = {}): Session {
    return this.lifecycle.archiveSession(sessionId, options);
  }







  deleteSession(sessionId: string): boolean {
    return this.lifecycle.deleteSession(sessionId);
  }


  subscribe(...args: Parameters<SessionSubscriptions["subscribe"]>): Subscription {
    return this.subscriptions.subscribe(...args);
  }
  unsubscribe(subscriptionId: string, subscriberSessionId?: string): boolean {
    return this.subscriptions.unsubscribe(subscriptionId, subscriberSessionId);
  }
  subscriptionsFor(subscriberSessionId: string): Subscription[] {
    return this.subscriptions.subscriptionsFor(subscriberSessionId);
  }
  sweepSubscriptions(): string[] {
    return this.subscriptions.sweepSubscriptions();
  }
  subscribeCohort(...args: Parameters<SessionSubscriptions["subscribeCohort"]>): SubscribedCohort {
    return this.subscriptions.subscribeCohort(...args);
  }
  cohortsFor(subscriberSessionId: string): Cohort[] {
    return this.subscriptions.cohortsFor(subscriberSessionId);
  }
  sweepCohorts(): string[] {
    return this.subscriptions.sweepCohorts();
  }

  private fireSubscriptions(...args: Parameters<TurnWakes["fireSubscriptions"]>): void {
    this.wakes.fireSubscriptions(...args);
  }


  /* ---------------------------------------------------------------- *
   * DELEGATION SETTLING — issue #378. The rule is in
   * `./delegation-settling.ts`; this is where the engine reads the facts and
   * writes the answer.
   *
   * BESIDE `fireSubscriptions` BECAUSE IT READS THE SAME SIGNAL —
   * `agentIntent === "result"` plus `agentSourceRunId`, "the coordinator
   * already has this run's outcome", which is clause 2 of the settle. The wake
   * above no longer folds that fact (#240: a result and a completion are two
   * different facts to a coordinator); the settle still does, because "has this
   * errand been reported on" is exactly the question it asks.
   * ---------------------------------------------------------------- */

  /**
   * A TERMINAL TURN IS THE MOMENT TO ASK, on both sides of a delegation.
   *
   * The session that just ended a turn may be the DELEGATE whose errand this
   * finished, and it may be the COORDINATOR whose turn just consumed a wake —
   * an orchestrator is routinely both at once. Asking both questions here is
   * what makes the two evaluation points the issue names one call site rather
   * than a rule spelled twice.
   *
   * NEVER THROWS INTO THE TRANSITION. Same contract as the wake above it: the
   * turn has already been written and journalled, and a shelf is not worth
   * failing a completion for.
   */
  private evaluateDelegationSettling(sessionId: string): void {
    try {
      this.settleDelegateIfDue(sessionId);
      /**
       * WHOSE DELEGATES, WITHOUT A SCAN. A coordinator's OWN queue names every
       * session that could have just become delivered: a wake carries the
       * child in `wakeReason.sessionId`, and a result carries it as the
       * sender. Walking those is one queue read; the alternative — asking
       * every session on disk who it works for — is the N+1 over whole
       * transcripts that `liveSessions` exists to avoid, on every turn.
       */
      const delegates = new Set<string>();
      for (const turn of this.scanQueue(sessionId).turns) {
        if (turn.wakeReason?.sessionId) delegates.add(turn.wakeReason.sessionId);
        if (turn.origin === "session" && turn.agentIntent === "result" && turn.sender?.sessionId) {
          delegates.add(turn.sender.sessionId);
        }
      }
      delegates.delete(sessionId);
      for (const delegate of delegates) this.settleDelegateIfDue(delegate);
    } catch (error) {
      this.appendEvent(sessionId, {
        type: "runtime.warning",
        message: `delegation settling was skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * A PERSON SETTLED THIS SESSION: END WHAT IT LEFT RUNNING — issue #883.
   *
   * Called for an EXPLICIT settle only — the person's Settle, or an agent's
   * `sessions_settle` — and never for the clock's, which waits
   * `SETTLED_TERMINAL_GRACE_MS` (see `sweepSettledTerminals`). The settle itself
   * is already written; nothing here can refuse it, and each part is
   * best-effort so a host out of reach does not stop the rest.
   *
   * - Every terminal the session owns, whoever opened it, recorded as closed
   *   by Telar — so its agent is not told the person closed them.
   * - Its background tasks, the chip's own Stop.
   * - Its browser pages.
   *
   * Un-settling brings none of it back. Answers the counts, which is what the
   * settle reports.
   */
  async endSessionLeftovers(sessionId: string): Promise<SessionSettleEnded> {
    let backgroundTasks = 0;
    try {
      backgroundTasks = this.stopBackgroundTasks(sessionId, "stopped when the session was settled");
    } catch {
      // A session that cannot be read has no tasks this can stop.
    }
    void this.browser.release(sessionId, "The session was settled.")?.catch(() => undefined);
    const terminals = await this.sessionTerminals.closeForSettle(sessionId);
    return { terminals, backgroundTasks };
  }

  sweepSettledTerminals(): Promise<string[]> {
    return this.sessionTerminals.sweepSettled();
  }

  enforceSettledTerminalLimit(): Promise<string[]> {
    return this.sessionTerminals.enforceLimit();
  }

  /**
   * EVERY ROW THE GRACE HAS COME DUE ON — the slow half of the rule.
   *
   * The two turn-completion points above catch the moment the FACTS change;
   * neither of them fires when nothing more happens, which is precisely the
   * common case: a coordinator takes delivery and then everybody goes quiet.
   * So the grace needs something that ticks. Returns the sessions it settled,
   * so a caller (and a test) can see the sweep's work without a timer.
   *
   * A WHOLE-STORE PASS, ON A SLOW TIMER, and the cost is bounded by the cheap
   * refusals first: no grace configured is one document read for the entire
   * sweep, and a session with no task turn costs one queue scan. There is no
   * engine-side settling clock to ride — the quiet window is folded by each
   * client — so this is the tick, and it is the daemon's only one besides the
   * worker pruner.
   */
  sweepDelegatedSettling(): string[] {
    if (this.getInboxPolicy().settleDelegatedAfterHours === null) return [];
    const settled: string[] = [];
    for (const sessionId of this.records.ids()) {
      try {
        if (this.settleDelegateIfDue(sessionId)) settled.push(sessionId);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return settled;
  }

  /**
   * ══ EVERY SNOOZE THAT HAS ENDED — issues #490, #586 ══
   *
   * THE THIRD OF THESE, AND THE ONE WITH THE STRONGEST CASE. `snoozedUntil` is a
   * stored timestamp and nothing else: "is this snoozed?" is COMPUTED against
   * `now`, and every reference to it across the engine stores it, reads it, or
   * deletes it. Nothing scheduled anything at expiry, so there was no moment at
   * which a conversation woke and nothing could announce one — the row simply
   * reappeared whenever something happened to render after the deadline. The
   * owner reported it as "nos faltó añadir un punto de notificación para mostrar
   * que una conversación se despertó"; this is the point of notification.
   *
   * A DEADLINE PASSING IS NOT AN EVENT, which is the same thing
   * `sessionsRevision` says about the same class of bug: *"no counter can move
   * on an event that does not happen."* So the wake needs something that ticks,
   * exactly as the grace above it did (#378) and the report window before it
   * (#723).
   *
   * ══ WHY THE ENGINE AND NOT EACH COCKPIT ══
   *
   * A per-row client timer would light the dot. It would also fire
   * INDEPENDENTLY IN EVERY COCKPIT, so two devices would disagree about when a
   * conversation woke — the same class of bug as two disagreeing about whether a
   * turn ended. "When did this conversation wake" is a server-side fact with
   * exactly one correct answer, and computing it per device IS the defect rather
   * than an implementation detail of it. `lastReadTurnSequence` is the precedent
   * and it is in the same file as the rule: both numbers are the engine's, so
   * they answer the same on every device and survive a reload.
   *
   * SO THIS IS ONE TIMER REPLACING N, not a timer added. #490 is removing
   * timers, and the arithmetic runs the right way: one process-level tick
   * instead of one per row per connected cockpit.
   *
   * ══ WHAT IT COSTS, AND WHY IT IS NOT A WHOLE-STORE PASS ══
   *
   * `dueSnoozeWakes` SEEKS: a session with no snooze, or with its wake already
   * recorded, is not a row it returns. The two sweeps above walk `sessionIds()`
   * because their predicates live in documents SQL cannot see; this one's are
   * two columns, so copying their loop would reinstate the fold #493 removed.
   *
   * ══ AND THE DECISION IS NOT MADE HERE ══
   *
   * `wokeAt()` is the one implementation, shared with every client, and it
   * already handles both branches — the scheduled expiry and the early wake a
   * raised hand causes. This records what it answers. Writing a second rule here
   * is how the engine and the cockpit come to disagree about the very thing this
   * exists to make them agree on.
   *
   * Returns the sessions it woke, so a caller — and a test — can see the tick's
   * work without waiting on a timer.
   */
  sweepSchedules(): string[] {
    return this.schedules.sweep();
  }

  listSchedules(sessionId?: string): ScheduleRow[] {
    return this.schedules.list(sessionId);
  }

  readSchedule(id: string): ScheduleRow | undefined {
    return this.schedules.read(id);
  }

  putSchedule(input: ScheduleInput): ScheduleRow {
    return this.schedules.put(input);
  }

  deleteSchedule(id: string): boolean {
    return this.schedules.delete(id);
  }

  sweepSnoozeWakes(): string[] {
    const now = this.now();
    const woken: string[] = [];
    for (const row of this.snoozeWakeCandidates()) {
      try {
        const at = wokeAt({ ...row }, settlingActivityOf(row), { now });
        if (at === undefined) continue;
        if (this.recordSnoozeWake(row.id, at)) woken.push(row.id);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return woken;
  }

  sweepRequestDeadlines(): string[] {
    return this.requestGate.sweepDeadlines();
  }

  /**
   * The rows a wake could still be owed on.
   *
   * One indexed query.
   */
  private snoozeWakeCandidates(): SessionIndexRow[] {
    return this.kernel.executionStore.dueSnoozeWakes();
  }

  /**
   * Stamp one wake, once.
   *
   * RE-READ BEFORE WRITING, because the row that produced the candidate is a
   * projection and the document is the truth — a snooze cancelled between the
   * query and here must not be woken, and a wake already recorded must not be
   * recorded twice. That second guard is what makes "exactly one signal" a
   * property of the code rather than of the tick's timing.
   *
   * `updatedAt` IS DELIBERATELY NOT TOUCHED, for `applyDelegationSettle`'s
   * reason and one of its own: `idleSince` (`settling.ts`) already counts a
   * snooze's wake as the start of the inactivity window, so stamping here would
   * both make an engine wake look like fresh work AND move the row to the top of
   * a list the house rule says must not reorder itself while it is being read.
   *
   * TWO EVENTS, as the settle makes: `session.updated` is how a client's fold
   * learns the new record, `session.woke` is the edge — the one thing anything
   * acting on the wake can subscribe to without diffing two snapshots. It is
   * #586's fifth frame, waiting for #586's feed.
   */
  private recordSnoozeWake(sessionId: string, at: number): boolean {
    const session = this.records.get(sessionId);
    if (session.wokeAt !== undefined || session.snoozedUntil === undefined) return false;
    session.wokeAt = at;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.woke", wokeAt: at });
    this.appendEvent(sessionId, { type: "session.updated", session });
    return true;
  }

  /** The whole rule for one session: gather, fold, and write if it says so. */
  private settleDelegateIfDue(sessionId: string): boolean {
    let session: Session;
    try {
      session = this.records.get(sessionId);
    } catch {
      return false;
    }
    // Cheap refusals before the policy read: an archived row is off every list
    // already, and a standing human decision is not the engine's to revisit.
    if (session.state === "archived" || session.settledOverride !== undefined) return false;
    const assignments = assignmentsOf(this.scanQueue(sessionId).turns as unknown as AssignmentTurn[]);
    const newest = newestAssignment(assignments);
    // Not a delegate. The overwhelming majority of sessions stop here.
    if (!newest) return false;

    const outcome = delegationSettle({
      now: this.now(),
      graceHours: this.getInboxPolicy().settleDelegatedAfterHours,
      delegateSessionId: sessionId,
      assignments,
      // A coordinator that no longer exists reads as an empty queue, which is
      // "no delivery" — the honest answer, not a settle on an absence.
      coordinatorTurns: this.scanQueue(newest.fromSessionId).turns as unknown as DeliveryTurn[],
      activity: session.activity,
      archived: false,
      unsettledAssignments: session.unsettledAssignments ?? [],
    });
    if (!outcome.settle) return false;
    this.applyDelegationSettle(sessionId, outcome.settle);
    return true;
  }

  /**
   * WRITE THE SHELF AND SAY WHY.
   *
   * `updatedAt` IS DELIBERATELY NOT TOUCHED, for `markSessionRead`'s reason:
   * it dates the session's WORK, and the quiet clock is measured from it.
   * Stamping it here would make an engine settle look like fresh activity to
   * every rule downstream — including the one a person would meet if they
   * pulled the row back off the shelf.
   *
   * TWO EVENTS, AND THEY ARE NOT THE SAME ROW. `session.updated` is how a
   * client's fold learns the new record; `session.settled` is the one moment
   * something acting on the settling (worktree removal, later) can subscribe to
   * without diffing snapshots.
   */
  private applyDelegationSettle(sessionId: string, settledBy: SessionSettledBy): void {
    const session = this.records.get(sessionId);
    const next: Session = { ...session, settledOverride: "settled", settledAt: this.now(), settledBy };
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(next));
    this.appendEvent(sessionId, { type: "session.settled", settledBy });
    this.appendEvent(sessionId, { type: "session.updated", session: next });
    this.subscriptions.reviewCohorts();
    // A shelf that just grew by a session keeping its terminals (#883). After
    // the command that settled it, never inside it.
    if (this.sessionTerminals.attached) void Promise.resolve().then(() => this.enforceSettledTerminalLimit()).catch(() => undefined);
  }


  private waitingNotificationTurn(sessionId: string): string | undefined {
    return this.wakes.waitingNotificationTurn(sessionId);
  }


  private joinWaitingNotification(...args: Parameters<TurnWakes["joinWaitingNotification"]>): void {
    this.wakes.joinWaitingNotification(...args);
  }






  private hasLiveTurn(sessionId: string): boolean {
    return this.wakes.hasLiveTurn(sessionId);
  }



  private flushPendingNotifications(sessionId: string): void {
    this.wakes.flushPendingNotifications(sessionId);
  }


  pendingNotifications(sessionId: string): NotificationDetail[] {
    return this.wakes.pendingNotifications(sessionId);
  }


  private rewriteNotificationItem(sessionId: string, turn: Turn): void {
    this.wakes.rewriteNotificationItem(sessionId, turn);
  }


  private discardQueuedWakes(subscriberId: string, targetSessionId?: string): number {
    return this.wakes.discardQueuedWakes(subscriberId, targetSessionId);
  }


  requests(sessionId: string): EngineRequest[] {
    return this.requestGate.list(sessionId);
  }

  openRequest(sessionId: string, runId: string, claimToken: string, input: OpenRequestInput): RequestOpenResult {
    return this.requestGate.open(sessionId, runId, claimToken, input);
  }

  resolveRequest(sessionId: string, requestId: string, input: ResolveRequestInput): EngineRequest {
    return this.requestGate.resolve(sessionId, requestId, input);
  }

  resolutionsForWorker(workerId: string): WorkerStatus["resolved"] {
    return this.requestGate.resolutionsForWorker(workerId);
  }

  /**
   * Promoted turns waiting for this worker's running turns, the same shape of
   * query as `resolutionsForWorker` and riding the same heartbeat: the worker
   * pushes the text into the driver's mailbox, THEN acks — duplication over
   * loss, see the worker's mailbox note.
   */
  steerForWorker(workerId: string): WorkerStatus["steer"] {
    assertId(workerId, "worker id");
    return [...this.liveQueueSessionIds()].flatMap((sessionId) => {
      const queue = this.scanQueue(sessionId);
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
        /**
         * CLONED, because `queue` here is the SHARED scan copy. Everything
         * else this heartbeat returns is strings the engine built; a delivery
         * is the one thing that would otherwise hand an embedded worker live
         * references into the cache — its attachments array, its sender — and
         * anything downstream that edited one would be editing the store's
         * idea of the queue. Steers are rare; a copy of one costs nothing.
         */
        return [
          structuredClone({
            sessionId,
            runId: turn.steer.intoRunId,
            claimToken,
            steerRunId: turn.runId,
            text: turn.input,
            // The attachments ride with the words — a steered image used to be
            // stored here and never delivered.
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
            // And so does WHO SAID THEM: an agent's message steered into a
            // running turn used to reach the provider as the person's own.
            ...(turn.origin === "session" && turn.sender ? { sender: turn.sender } : {}),
            // AND THE NOTICE RIDES WITH THE SENDER. Without it a peer's message
            // would be short when the recipient was idle and full-size when it
            // was mid-turn — the same message costing different amounts by an
            // accident of timing.
            ...(turn.origin === "session" && turn.sender && turn.agentNotice ? { notice: turn.agentNotice } : {}),
            // A WAKE KEEPS ITS IDENTITY THROUGH THE PROMOTION. `submitTurn`
            // steers whatever it accepts when a turn is running, and a wake is
            // accepted the same way — so the engine's own announcement about a
            // peer used to arrive here stripped of `wakeReason` and reach both
            // the provider and the transcript as a person's typed message. The
            // stamp is the turn's; it rides the delivery.
            ...(turn.origin === "session" && turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
            // AND SO DOES WHAT IT IS. The two stamps above say who; this says
            // the delivery is a notification, which is what lets the driver put
            // it on a channel that is not the person's. A promotion that
            // dropped it would make the SAME message honest when the recipient
            // was idle and a fake user message when it was busy — the asymmetry
            // #550 is closing.
            ...(turn.notification ? { notification: turn.notification } : {}),
          }),
        ];
      });
    });
  }

  /**
   * The journal above `after`, at most `limit` rows of it — issue #494.
   *
   * `limit` IS THE CALLER'S PAGE SIZE, and absent means the whole tail: the
   * route bounds what it serialises over HTTP, while an in-process fold that
   * genuinely needs the run (the export, `openItemPrefix`) asks without one and
   * is unchanged. The cursor check stays here rather than at any caller's seam
   * because this method owns it — see the sessions socket's capability.
   *
   * NO OFFSET, EVER. The window is keyed on the event id, so a page is the same
   * page whether or not rows were appended while the caller was reading, and a
   * client that resumes from the last id it saw can neither skip nor repeat.
   */
  readEvents(sessionId: string, after = 0, limit?: number): EngineEvent[] {
    this.records.require(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new EngineStateError("invalid_request", "event limit is invalid");
    return this.kernel.executionStore.events(sessionId, after, limit);
  }

  /**
   * The id of the last event on the journal — "now", for a client that wants
   * to tail from the snapshot it just read rather than replay from zero.
   */
  eventCursor(sessionId: string): number {
    this.records.require(sessionId);
    return this.kernel.executionStore.cursor(sessionId);
  }

  openItemPrefix(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined {
    return this.prefixes.get(sessionId, itemId, through);
  }

  recover(): { stopped: string[] } {
    return this.recovery.recover();
  }



  retireWorkerRegistration(workerId: string): { stopped: string[] } {
    return this.recovery.retireWorkerRegistration(workerId);
  }


  cancellationsForWorker(workerId: string): Array<{ sessionId: string; runId: string; claimToken: string }> {
    return this.recovery.cancellationsForWorker(workerId);
  }


  private scanQueue(sessionId: string): SessionQueue {
    return this.sessionQueues.scan(sessionId);
  }

  private liveQueueSessionIds(): Set<string> {
    return this.sessionQueues.liveSessionIds();
  }

  private readQueue(sessionId: string): SessionQueue {
    return this.sessionQueues.read(sessionId);
  }

  private writeQueue(sessionId: string, queue: SessionQueue): void {
    this.sessionQueues.write(sessionId, queue);
  }

  /**
   * AFTER THE COMMIT, FOR THE SAME REASON `announceQueueChange` DEFERS: telling
   * a worker to abort a claim a rollback then resurrects would kill a turn the
   * store still believes is running. Outside a transaction there is nothing to
   * wait for and the call is direct.
   */
  private announceStoppedClaims(cancellations: StoppedClaim[]): void {
    if (!this.onTurnsStopped || cancellations.length === 0) return;
    if (!this.kernel.inCommand) {
      this.onTurnsStopped(cancellations);
      return;
    }
    this.kernel.afterCommit(() => this.onTurnsStopped?.(cancellations));
  }

  private requireRunningClaim(sessionId: string, runId: string, claimToken: string): Turn {
    return this.requireRunningClaimFromQueue(this.readQueue(sessionId), runId, claimToken);
  }

  /**
   * THE SENDER'S CLAIM — `requireRunningClaim` with somewhere to go when it
   * refuses.
   *
   * A REFUSAL HERE IS DIFFERENT IN KIND from a late observation's. An
   * observation would MUTATE a terminal turn, so "no" is the whole answer and
   * the turn's immutability is the reason. A `sessions_send` mutates nothing on
   * the sender's turn — the claim is read only to say WHO is speaking — and the
   * work it was carrying is a message to somebody else that now simply does not
   * arrive. Measured: an orchestrator mid-restart lost every send it made for
   * the rest of its turn, and the only workaround anybody found was to wait for
   * its next turn, because the refusal said the turn had ended and nothing
   * about what to do instead.
   *
   * SO IT STILL REFUSES — a settled claim does not prove a live sender, and
   * accepting one would attribute a peer's message to a turn that is over — but
   * it NAMES THE TURN THIS SESSION IS ACTUALLY RUNNING. The worker proves each
   * send with the claim that is live when the call arrives (see `liveClaims` in
   * worker.ts), so "retry" is a real instruction: the retry carries the turn
   * named here. When there is no live turn, it says that instead, because
   * retrying would be the same refusal again.
   *
   * ONLY FOR A CLAIM THAT REALLY IS THIS SESSION'S. A token that never matched
   * the named turn is a foreign or forged claim and keeps the flat answer — the
   * longer one would be a hint offered to whoever guessed wrong. A turn whose
   * claim a RESTART retired (`recover()` deletes it) has no token left to match,
   * so it is recognised by being terminal with no claim at all.
   */
  private requireSenderClaim(proof: { sessionId: string; runId: string; claimToken: string }): Turn {
    const queue = this.readQueue(proof.sessionId);
    try {
      return this.requireRunningClaimFromQueue(queue, proof.runId, proof.claimToken);
    } catch (error) {
      if (!(error instanceof EngineStateError) || error.code !== "conflict") throw error;
      const named = queue.turns.find((turn) => turn.runId === proof.runId);
      // ONLY A TURN THAT ENDED. A claim against one that has not started yet,
      // or is being steered, is early rather than stale, and the flat refusal
      // is the true thing to say about it.
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

  private requireRunningClaimFromQueue(queue: SessionQueue, runId: string, claimToken: string): Turn {
    assertId(runId, "run id");
    if (typeof claimToken !== "string" || claimToken.length < 16) {
      throw new EngineStateError("invalid_request", "claim token is invalid");
    }
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "running" || turn.claim?.token !== claimToken) {
      /**
       * NAME THE ACTUAL SITUATION. The right claim token against a settled
       * turn is not a foreign worker — it is THIS turn's provider reporting
       * late (a tool call still running when the turn completed). The code
       * stays `conflict` deliberately: the worker's settle paths key off that
       * code to drop late reports instead of failing the turn, and a new code
       * would turn every late report into a spurious `turn.failed`. The
       * message is what changes, so a daemon log reads as "late", not as a
       * claim mix-up. Late observations are REFUSED rather than accepted
       * within a grace window: a terminal turn is immutable — recovery,
       * projections and tailing clients all rely on nothing landing after
       * `turn.completed` — and the driver now holds the turn open until its
       * tool calls settle, which removes the systematic case. What remains is
       * a true race measured in milliseconds, not worth weakening the
       * invariant for.
       */
      const settled = turn.state === "completed" || turn.state === "failed";
      if (settled && turn.claim?.token === claimToken) {
        throw new EngineStateError("conflict", `turn has already settled (${turn.state}); this report arrived after the turn ended`);
      }
      throw new EngineStateError("conflict", "turn is not running under this worker claim");
    }
    return turn;
  }

  /**
   * STOP THE SESSION'S LINGERING BACKGROUND TASKS — the "N tasks still
   * working" chip's Stop. Distinct from `stopTurn`: a background task outlives
   * its turn, so there may be no turn to stop, and stopping the turn would be
   * the wrong verb even if there were one. Marks each task `stopped` in the
   * projection (so the roster is right at once) AND queues the actual process
   * kill for the worker holding the runtime. Returns how many it stopped.
   */
  stopBackgroundTasks(sessionId: string, reason = "stopped from the cockpit"): number {
    return this.kernel.command("stopBackgroundTasks", () => {
      const at = this.now();
      const closed = this.sessionTasks.closeLive(sessionId, at, reason, {
        includeBackground: true,
        onlyBackground: true,
        state: "stopped",
      });
      if (closed.length === 0) return 0;
      const deliveries = this.sessionTasks.readStops();
      const turns = this.readQueue(sessionId).turns;
      const driver = this.records.get(sessionId).driver;
      for (const task of closed) {
        if (!task.providerTaskId) continue;
        const workerId = turns.find((turn) => turn.runId === task.runId)?.claim?.workerId;
        if (workerId) deliveries.push({ deliveryId: `stop_${crypto.randomUUID().replaceAll("-", "")}`, sessionId,
          providerTaskId: task.providerTaskId, workerId, driver });
      }
      this.sessionTasks.writeStops(deliveries);
      this.records.touch(sessionId, at);
      return closed.length;
    });
  }

  taskStopsForWorker(workerId: string, acknowledged: string[] = []): WorkerStatus["stopTask"] {
    return this.sessionTasks.stopsForWorker(workerId, acknowledged);
  }


  private appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent {
    return this.kernel.appendEvent(sessionId, event, runId);
  }

  watch(listener: (event: EngineEvent) => void): () => void {
    return this.kernel.watch(listener);
  }
}

export type DaemonLock = { token: string; release(): void };

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A LOCK WRITTEN BY ANOTHER MACHINE IS NEVER STALE — issue #630.
 *
 * `processExists` asks THIS kernel about a pid. That is a sound test for a
 * stale lock exactly as long as the state root can only ever have been locked
 * from here, which was true while it lived on the machine's own disk.
 *
 * A store on a removable volume can be carried to a second Mac, and pids are
 * small integers that every machine hands out from the same low range. So the
 * recorded pid being "alive" over there says nothing about here, and — the
 * dangerous direction — the recorded pid being dead HERE says nothing about a
 * daemon that is very much alive THERE. Without this check, plugging a drive
 * into a second machine while the first is still running breaks a live lock and
 * puts two daemons on one store, which is data loss with no warning.
 *
 * The hostname was already being written and never read. Reading it is the fix.
 * An unrecorded hostname (a lock from before this) is treated as ours, because
 * that is what it was.
 */
function lockHeldElsewhere(owner: { hostname?: string }): boolean {
  return typeof owner.hostname === "string" && owner.hostname !== "" && owner.hostname !== os.hostname();
}

/** Exclusive state-root ownership. A dead owner's lock is reclaimed, never a live one. */
export function acquireDaemonLock(paths: EngineStatePaths): DaemonLock {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const breaker = `${paths.lock}.break`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const descriptor = fs.openSync(paths.lock, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, hostname: os.hostname(), startedAt: Date.now() }));
      fs.closeSync(descriptor);
      return {
        token,
        release() {
          try {
            const lock = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { token?: string };
            if (lock.token === token) fs.unlinkSync(paths.lock);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; hostname?: string } = {};
      let fingerprint: string | undefined;
      try {
        const stat = fs.statSync(paths.lock);
        fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        owner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number; hostname?: string };
      } catch {
        // A torn stale lock cannot establish a live owner. The retry below is
        // still guarded by unlink + O_EXCL and never replaces an active lock.
      }
      if (lockHeldElsewhere(owner)) {
        throw new EngineStateError("conflict", `engine state root is locked by ${owner.hostname}`);
      }
      /**
       * THE PID IS IN THE MESSAGE — issue #894, and it is the only copy anyone
       * downstream gets. `main.ts` prints this line beside the lock's path, and
       * the shell puts the pid in front of a person who now has to decide
       * whether the Telar already running is one they want.
       *
       * `(pid N)` rather than `by pid N`: `state.test.ts` distinguishes this
       * refusal from the cross-host one above by matching `/locked by/`, and a
       * message satisfying both regexes would make that assertion vacuous.
       */
      if (processExists(owner.pid ?? -1))
        throw new EngineStateError("conflict", `engine state root is already locked (pid ${owner.pid})`);
      const breakerToken = crypto.randomUUID();
      try {
        const descriptor = fs.openSync(breaker, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: breakerToken }));
        fs.closeSync(descriptor);
      } catch (breakError) {
        if ((breakError as NodeJS.ErrnoException).code === "EEXIST") {
          // Another stale-lock breaker owns the compare-and-delete window;
          // never race it by unlinking its freshly acquired daemon lock.
          throw new EngineStateError("conflict", "engine state root is already being recovered");
        }
        throw breakError;
      }
      try {
        try {
          const stat = fs.statSync(paths.lock);
          const current = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
          const currentOwner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number; hostname?: string };
          // Re-checked inside the breaker window for the same reason the pid is:
          // the lock may have been replaced between the read above and here.
          if (current !== fingerprint || lockHeldElsewhere(currentOwner) || processExists(currentOwner.pid ?? -1)) continue;
          fs.unlinkSync(paths.lock);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      } finally {
        try {
          const value = JSON.parse(fs.readFileSync(breaker, "utf8")) as { token?: string };
          if (value.token === breakerToken) fs.unlinkSync(breaker);
        } catch (breakCleanupError) {
          if ((breakCleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw breakCleanupError;
        }
      }
    }
  }
  throw new EngineStateError("conflict", "engine state root is already locked");
}
