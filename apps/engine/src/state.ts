// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import { ExecutionStore, type ExecutionHousekeeping } from "./platform/db/execution-store";
import fs from "node:fs";
import {
  type InboxPolicy,
  type EngineEvent,
  type ProviderDriverKind,
  type Project,
  type RequestKind,
  type Session,
  type SessionSettleEnded,
  type Turn,
  type WorkerClaim,
  type WorkspaceFile,
  type WorkspaceWriteResult,
} from "@telar/engine-client";
import { ProjectProbes, ProjectRegistry, ProjectRemounts, WorkspaceConfigStore } from "./domains/projects";
import { EngineStateError, Kernel, type JournalEntry } from "./platform/kernel";
import { SettingsStore } from "./domains/settings";
import { AppearanceStore } from "./domains/appearance";
import { McpOAuthStore, McpServers } from "./domains/agent-tools";
import { installedCli, ModelCatalogues, ProviderRegistry, type InstalledCli } from "./domains/providers";
import { DataScienceOps, LatexOps, PluginToolchains } from "./domains/plugins";
import { UsageLimitSources } from "./domains/usage";
import { SessionQueries, LiveSessions, SessionSettler, createSessionModules, SessionAttachments, workspaceRootOf, OpenPrefixes, SessionActivity, sessionDir, SessionIndex, SessionItems, SessionMailbox, sessionMetadataFile, type SessionQueue, SessionQueues, SessionRecords, SessionRequests, SessionLifecycle, SessionSubscriptions, SessionTasks, storedSession, RequestGate } from "./domains/sessions";
import { requireRunningClaimFromQueue, TurnAnchors, WorkerChannel, TurnWakes, TurnRecovery, TurnClaims, TurnIngest, type StoppedClaim, TurnLifecycle, TurnIntake } from "./domains/turns";
import { Dictation } from "./domains/dictation";
import { type ResolvedComputerUse } from "./domains/computer-use";
import { type ProjectIcon } from "./domains/appearance";
import { readFencedAsync, readFencedBytes, writeFenced } from "./domains/files";
import { SessionGit, WorkspaceReads } from "./domains/git";
import { SessionBrowser } from "./domains/browser";
import { GitHubStore, defaultGhRunner, SessionPulls, type GhRunner } from "./domains/github";
import { ConversationAdoption } from "./domains/providers";
import { BUNDLED_MANIFEST, type ModelManifest, readModelCatalogue } from "./domains/providers";
import { PluginDoors, JobRunner } from "./domains/plugins";
import { ScheduleBook } from "./domains/schedules";
import { derivedBranchFor, prepareSessionWorktree, WorktreeMaintenance, createWorktreeQueue, defaultWorktreeGitRunner, type WorktreeQueue, SETUP_STOP_GRACE_MS, WorktreeSetups } from "./domains/worktrees";
import { defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, type GitResult, type GitRunner } from "./platform/git/runner";
import { backfillTurnSummaries, CheckoutSizes, CleanupStore, copyStore, migrateBareClaudeIds, migrateClaudeCompactionToLimits, migrateLegacyPluginFieldsOnOpen, type CheckoutSizesOptions } from "./domains/storage";
import { pipeLauncher, processGroupFor, SessionTerminals } from "./domains/terminal";
import { type VolumeDeps } from "./platform/fs/volumes";

import { statePaths, type EngineStatePaths } from "./platform/fs/state-paths";
export { EngineStateError };

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

/** One git question, as `EngineStore.prefetchedGit` keys it. */
const prefetchKey = (cwd: string, args: string[]): string => JSON.stringify([cwd, args]);

/** What `resolveWorktreeBase` would pass to `rev-parse` — and only a ref the
 *  store's own validation would let through, so a prefetch never puts an
 *  unvalidated argument on a git command line. */
const prefetchableRef = (ref: string | undefined): string | undefined =>
  ref === undefined ? "HEAD" : /^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(ref) ? ref : undefined;

export class EngineStore {
  readonly kernel: Kernel<EngineNotifier>;
  readonly settings: SettingsStore;
  readonly appearance: AppearanceStore;
  readonly mcpOAuth: McpOAuthStore;
  readonly mcpServers: McpServers;
  readonly providers: ProviderRegistry;
  readonly usageSources: UsageLimitSources;
  readonly projectProbes: ProjectProbes;
  readonly projectRegistry: ProjectRegistry;
  readonly toolchains: PluginToolchains;
  readonly github: GitHubStore;
  readonly browser: SessionBrowser;
  readonly worktrees: WorktreeMaintenance;
  private readonly remounts: ProjectRemounts;
  readonly attachments: SessionAttachments;
  readonly queries: SessionQueries;
  readonly live: LiveSessions;
  readonly intake: TurnIntake;
  readonly turnLifecycle: TurnLifecycle;
  readonly ingest: TurnIngest;
  readonly claims: TurnClaims;
  readonly recovery: TurnRecovery;
  readonly wakes: TurnWakes;
  readonly settler: SessionSettler;
  readonly worker: WorkerChannel;
  readonly catalogues: ModelCatalogues;
  readonly records: SessionRecords;
  private readonly sessionItems: SessionItems;
  readonly prefixes: OpenPrefixes;
  private readonly sessionRequests: SessionRequests;
  readonly sessionTasks: SessionTasks;
  private readonly sessionQueues: SessionQueues;
  readonly mailbox: SessionMailbox;
  private readonly sessionIndex: SessionIndex;
  private readonly activity: SessionActivity;
  readonly subscriptions: SessionSubscriptions;
  readonly lifecycle: SessionLifecycle;
  readonly schedules: ScheduleBook;
  private readonly anchors: TurnAnchors;
  readonly pluginDoors: PluginDoors;
  readonly workspaceReads: WorkspaceReads;
  readonly sessionGit: SessionGit;
  readonly requestGate: RequestGate;
  readonly sessionTerminals: SessionTerminals;
  readonly sessionPulls: SessionPulls;
  readonly adoption: ConversationAdoption;
  readonly dictation: Dictation;
  readonly dataScienceOps: DataScienceOps;
  readonly latexOps: LatexOps;

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

  private settleWorktree(sessionId: string, failure: string | undefined): void {
    this.worktrees.settle(sessionId, failure);
  }

  private worktreeMaintenance(): WorktreeMaintenance {
    return new WorktreeMaintenance(this.kernel, {
      records: this.records,
      git: this.worktreeGit,
      queue: this.worktreeQueue,
      cleanup: this.cleanup,
      checkoutSizes: this.checkoutSizes,
      getProject: (id) => this.projectRegistry.get(id),
      listProjects: () => this.projectRegistry.list(),
      availability: (project) => this.projectProbes.availability(project),
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      setupRunning: (id) => this.setups.isRunning(id),
      startSetup: (id, worktree) => this.startWorktreeSetup(id, worktree),
      openTerminals: (id) => this.sessionTerminals.openCount(id),
      hasLiveBackgroundWork: (id) => this.queries.hasLiveBackgroundWork(id),
      autoSettleAfterHours: () => this.settings.inbox().autoSettleAfterHours,
      archiveSession: (id, options) => this.lifecycle.archiveSession(id, options),
    });
  }

  /** Environment builds and package installs, as jobs the settings page polls. */
  readonly dsJobs = new JobRunner(() => this.now());

  /** Compile and tlmgr jobs: a sibling runner, so a compile never queues behind pip installs. */
  readonly latexJobs = new JobRunner(() => this.now());

  setInboxPolicy(patch: { autoSettleAfterHours?: unknown; settleDelegatedAfterHours?: unknown; settledTerminalLimit?: unknown }): InboxPolicy {
    const next = this.settings.setInbox(patch);
    // A lower limit applies now rather than at the next sweep.
    if (patch.settledTerminalLimit !== undefined && this.sessionTerminals.attached) {
      void Promise.resolve().then(() => this.sessionTerminals.enforceLimit()).catch(() => undefined);
    }
    return next;
  }

  /** A consistent copy of this store, without the reproducible tier, to open instead of the live one. */
  copyStoreTo(destination: string): { root: string; files: number; bytes: number } {
    return copyStore(this.paths.root, this.kernel.executionStore, destination);
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
        const token = await this.mcpOAuth.resolveToken(server.id, server.projectId, fetchImpl);
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
      getProject: (projectId) => this.projectRegistry.get(projectId),
      availability: (project) => this.projectProbes.availability(project),
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
      onRetentionSweep: () => { this.settings.sweepRetention(); },
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
      subscriptionsOf: (sessionId) => this.subscriptions.subscriptionsOf(sessionId),
      nextWake: (sessionId) => this.schedules.nextWake(sessionId),
      autoSettleAfterHours: () => this.settings.inbox().autoSettleAfterHours,
      ...(options.onQueueChanged ? { onQueueChanged: options.onQueueChanged } : {}),
    }));
    this.live = new LiveSessions(this.kernel, {
      records: this.records,
      activity: this.activity,
      index: this.sessionIndex,
      getProject: (id) => this.projectRegistry.get(id),
      projects: () => this.projectRegistry.read().projects,
      availability: (project) => this.projectProbes.availability(project),
      inbox: () => this.settings.inbox(),
      sidebarLayout: () => this.settings.sidebarLayout(),
      terminalCounts: (ids) => this.sessionTerminals.countsFor(ids),
    });
    this.subscriptions = this.createSubscriptions();
    this.lifecycle = this.createLifecycle();
    this.intake = this.createIntake();
    this.turnLifecycle = this.createTurnLifecycle();
    this.claims = this.createClaims();
    this.sessionGit = new SessionGit(this.kernel, {
      records: this.records,
      worktreeGit: this.worktreeGit,
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      getProject: (id) => this.projectRegistry.get(id),
      registerProject: (input) => this.projectRegistry.register(input),
    });
    this.worker = new WorkerChannel(this.kernel, {
      records: this.records,
      tasks: this.sessionTasks,
      activity: this.activity,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      stopSession: (id) => this.turnLifecycle.stopSession(id),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
    });
    this.settler = new SessionSettler(this.kernel, {
      records: this.records,
      scanQueue: (id) => this.scanQueue(id),
      settleDelegatedAfterHours: () => this.settings.inbox().settleDelegatedAfterHours,
      reviewCohorts: () => this.subscriptions.reviewCohorts(),
      // A shelf that just grew keeps its terminals (#883); enforced after the command, never inside it.
      onShelfGrew: () => {
        if (this.sessionTerminals.attached) void Promise.resolve().then(() => this.sessionTerminals.enforceLimit()).catch(() => undefined);
      },
    });
    this.wakes = new TurnWakes(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      mailbox: this.mailbox,
      subscriptions: this.subscriptions,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      submitTurn: (id, input) => this.intake.submitTurn(id, input),
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
      getSessionDefaults: () => this.settings.sessionDefaults(),
      submitTurn: (id, input) => this.intake.submitTurn(id, input),
    });
    this.ingest = new TurnIngest(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      prefixes: this.prefixes,
      readQueue: (id) => this.readQueue(id),
      scanQueue: (id) => this.scanQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      requireRunningClaimFromQueue: (queue, runId, token) => requireRunningClaimFromQueue(queue, runId, token),
    });
    this.worktrees = this.worktreeMaintenance();
    ({ dataScienceOps: this.dataScienceOps, latexOps: this.latexOps } = this.createPluginOps());
    this.dictation = new Dictation(this.paths.root, {
      liveSessions: () => this.live.rows().sessions,
      projects: () => this.projectRegistry.read().projects,
    });
    this.adoption = new ConversationAdoption(this.records, this.sessionItems, {
      engineRoot: this.paths.root,
      now: () => this.now(),
      resolveInstance: (instanceId, driver) => this.providers.resolve(instanceId, driver),
      readQueue: (sessionId) => this.readQueue(sessionId),
      writeQueue: (sessionId, queue) => this.writeQueue(sessionId, queue),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
    });
    this.sessionPulls = new SessionPulls(this.github, {
      getSession: (sessionId) => this.records.get(sessionId),
      getProject: (projectId) => this.projectRegistry.get(projectId),
      worktreeGit: this.worktreeGit,
      asyncGit: this.asyncGit,
      gh: this.gh,
    });
    this.sessionTerminals = new SessionTerminals(this.records, this.sessionIndex, {
      now: () => this.now(),
      inboxPolicy: () => this.settings.inbox(),
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
    this.pluginDoors = new PluginDoors(this.dsJobs, this.latexJobs, {
      engineRoot: this.paths.root,
      now: () => this.now(),
      getSession: (sessionId) => this.records.get(sessionId),
      requireSession: (sessionId) => this.records.require(sessionId),
      machinePlugins: () => this.toolchains.machine(),
      resolveDataScience: (session) => this.toolchains.resolveDataScience(session),
      resolveLatex: (session) => this.toolchains.resolveLatex(session),
      latexToolchain: () => this.latexOps.toolchain(),
      sessionDir: (sessionId) => sessionDir(this.paths, sessionId),
      putAttachment: (sessionId, input) => this.attachments.put(sessionId, input),
      attachmentBytes: (sessionId, attachmentId) => this.attachments.bytes(sessionId, attachmentId).data,
      appendEvent: (sessionId, event) => void this.appendEvent(sessionId, event),
      dataScienceOps: () => this.dataScienceOps,
    });
    this.anchors = new TurnAnchors(this.kernel, this.records, this.sessionQueues, this.asyncGit, {
      readRoot: (session) => this.workspaceReads.anchorReadRoot(session),
      forgetReadsUnder: (root) => this.forgetGitReadsUnder(root),
    });
    this.schedules = new ScheduleBook(this.kernel, {
      requireSession: (sessionId) => void this.records.require(sessionId),
      submitTurn: (sessionId, input) => this.intake.submitTurn(sessionId, input),
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
      const project = this.projectRegistry.get(session.projectId);
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
      getProject: (projectId) => this.projectRegistry.get(projectId),
      assertProjectAvailable: (projectId) => this.assertProjectAvailable(projectId),
      projectAvailability: (project) => this.projectProbes.availability(project),
      projectOfSession: (session) => this.workspaceReads.projectOf(session),
      sessionDefaults: () => this.settings.sessionDefaults(),
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
        this.pluginDoors.disposeKernel(sessionId, reason);
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
      submitTurn: (sessionId, input) => this.intake.submitTurn(sessionId, input),
      warn: (sessionId, message) => void this.appendEvent(sessionId, { type: "runtime.warning", message }),
    });
  }

  /** The per-document stores that sit beside the sessions modules, built on the kernel. */
  private leafStores(options: { models?: typeof readModelCatalogue; cliVersion?: (driver: ProviderDriverKind) => Promise<InstalledCli>; manifest?: ModelManifest }) {
    const settings = new SettingsStore(this.kernel);
    const appearance = new AppearanceStore(this.kernel);
    const mcpOAuth = new McpOAuthStore(this.kernel);
    const mcpServers = new McpServers(this.kernel, { requireProject: (id) => void this.projectRegistry.get(id), forgetGrant: (id, projectId) => mcpOAuth.delete(id, projectId) });
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
      hasWorkInFlight: (sessionId) => this.queries.hasWorkInFlight(sessionId),
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
    const project = this.projectRegistry.get(projectId);
    const icon = await this.projectProbes.icon(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  /**
   * WHICH MOUNT CONFIGURATION EACH AWAY PROJECT HAS ALREADY BEEN SEARCHED FOR.
   *
   * The remount search is the expensive one — a `diskutil` child per mounted
   * volume — and it can only succeed if a disk has arrived. Keyed by project and
   * valued by `mountSignature`, so an unplugged drive that stays unplugged is
   * searched for exactly once no matter how long the poll runs.
   */

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
      let availability = this.projectProbes.availability(project);
      /**
       * A DRIVE MOUNTED SOMEWHERE ELSE IS STILL THIS DRIVE — see
       * `ProjectRemounts.recover`. Attempted only when the project cannot be
       * read, which is what keeps the `diskutil` it costs off the poll path, and
       * HERE rather than inside the probe because this is the call that happens
       * when a disk has just appeared.
       */
      if (availability !== "available" && this.remounts.recover(project) !== undefined) {
        recovered += 1;
        availability = this.projectProbes.availability(this.projectRegistry.get(project.id));
      }
      if (availability !== before) changed += 1;
    }
    return { projects: projects.length, changed, recovered };
  }

  /**
   * Refuses new work (a session, a turn or wake, a settings change) on a removed project or an unplugged
   * drive. Reads stay open, so a removed project's history still answers.
   */
  private assertProjectAvailable(projectId: string): void {
    const project = this.projectRegistry.get(projectId);
    if (project.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
    }
    // Probed fresh, and `unmounted` only: a missing folder is refused by the worker, in the conversation,
    // and an unplugged drive needs a cable rather than a re-registration that would mint a new project id.
    if (this.projectProbes.availability(project) === "unmounted") {
      throw new EngineStateError("conflict", `The drive holding ${project.name} is not connected. Plug it back in and this will work again.`);
    }
  }

  /**
   * Where a departure is announced. One subscriber — the plugin host — so a
   * plugin with per-session state gives it back without the store naming it.
   */
  private pluginRelease: ((sessionId: string, reason: string) => void) | undefined;

  attachPluginRelease(release: (sessionId: string, reason: string) => void): void {
    this.pluginRelease = release;
  }

  private createPluginOps(): { dataScienceOps: DataScienceOps; latexOps: LatexOps } {
    return {
      dataScienceOps: new DataScienceOps(this.toolchains, this.dsJobs, {
        root: this.paths.root,
        now: () => this.now(),
        getProject: (projectId) => this.projectRegistry.get(projectId),
        updateProject: (projectId, patch) => this.projectRegistry.update(projectId, patch),
        getSession: (sessionId) => this.records.get(sessionId),
        restartKernel: (sessionId) => this.pluginDoors.dataScience(sessionId).restart(),
        machinePlugins: () => this.toolchains.machine(),
      }),
      latexOps: new LatexOps(this.toolchains, this.latexJobs, (projectId) => this.projectRegistry.get(projectId)),
    };
  }

  projectFileAsync(projectId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(this.projectRegistry.get(projectId).root, target, "project");
  }

  sessionFileAsync(sessionId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  projectFileBytesAsync(projectId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(this.projectRegistry.get(projectId).root, target, "project");
  }

  sessionFileBytesAsync(sessionId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  /** `expected` is the hash the editor read; a stale one is refused rather than overwritten. */
  projectFileWrite(projectId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const project = this.projectRegistry.get(projectId);
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
  async createSessionAsync(input: Parameters<SessionLifecycle["createSession"]>[0]): Promise<Session> {
    let project: Project | undefined;
    try {
      project = input.projectId === undefined ? undefined : this.projectRegistry.get(input.projectId);
    } catch {
      // `createSession` refuses this itself, in its own order and words.
      return this.lifecycle.createSession(input);
    }
    if (project === undefined || this.projectProbes.availability(project) !== "available") return this.lifecycle.createSession(input);
    const questions = [...EngineStore.cutQuestions(input.baseRef), ["rev-parse", "HEAD"]];
    return this.withPrefetchedGit(project.root, questions, () => this.lifecycle.createSession(input));
  }

  /**
   * `submitTurn` FOR THE REQUEST PATH. Only the first send to a WORKTREE DRAFT
   * asks git anything — it promotes the draft and plans its cut — so every
   * other send is the synchronous command exactly as it was.
   */
  async submitTurnAsync(...args: Parameters<TurnIntake["submitTurn"]>): Promise<ReturnType<TurnIntake["submitTurn"]>> {
    return this.promotingDraft(args[0], () => this.intake.submitTurn(...args));
  }

  /** `submitAgentTurn` for the request path and the `sessions` tools — an
   *  agent's message to a worktree draft promotes it exactly as a person's does. */
  async submitAgentTurnAsync(...args: Parameters<TurnIntake["submitAgentTurn"]>): Promise<ReturnType<TurnIntake["submitAgentTurn"]>> {
    return this.promotingDraft(args[0], () => this.intake.submitAgentTurn(...args));
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
        const project = this.projectRegistry.get(session.projectId);
        if (this.projectProbes.availability(project) === "available") {
          root = project.root;
          baseRef = session.draft.baseRef;
        }
      }
    } catch {
      // Refused by `work` below, in its own words.
    }
    return root === undefined ? work() : this.withPrefetchedGit(root, EngineStore.cutQuestions(baseRef), work);
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
      getSessionDefaults: () => this.settings.sessionDefaults(),
      listMcpServers: () => this.mcpServers.list(),
      resolveProviderInstance: (instanceId, driver) => this.providers.resolve(instanceId, driver),
      getProject: (id) => this.projectRegistry.get(id),
      resolveDataScience: (session) => this.toolchains.resolveDataScience(session),
      resolveLatex: (session) => this.toolchains.resolveLatex(session),
      enabledPluginIds: (session) => this.toolchains.enabledIds(session),
      getAgentOrientation: () => this.settings.orientation(),
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
      requireRunningClaimFromQueue: (queue, runId, token) => requireRunningClaimFromQueue(queue, runId, token),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      anchorTurn: (id, runId, side) => this.anchors.anchor(id, runId, side),
      fireSubscriptions: (id, kind, turn, context) => this.fireSubscriptions(id, kind, turn, context),
      flushPendingNotifications: (id) => this.flushPendingNotifications(id),
      evaluateDelegationSettling: (id) => this.evaluateDelegationSettling(id),
      stopBackgroundTasks: (id) => this.worker.stopBackgroundTasks(id),
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
      getProject: (id) => this.projectRegistry.get(id),
      availability: (project) => this.projectProbes.availability(project),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      restoreWorktree: (id) => void this.worktrees.restore(id),
      prepareWorktree: (id, root, plan, baseSha) => this.lifecycle.prepareWorktree(id, root, plan, baseSha),
      planWorktree: prepareSessionWorktree,
      derivedBranchFor,
      promoteTurn: (id, runId) => this.turnLifecycle.promoteTurn(id, runId),
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

  private writeNotificationItem(sessionId: string, turn: Turn): void {
    this.intake.writeNotificationItem(sessionId, turn);
  }

  pauseSession(sessionId: string, _by: "human" | "session" = "human"): { session: Session; stopped?: Turn; held: number; already: boolean } {
    return this.worker.pauseSession(sessionId);
  }

  private requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    return this.turnLifecycle.requeueUndeliveredSteers(queue, runId, at);
  }

  private fireSubscriptions(...args: Parameters<TurnWakes["fireSubscriptions"]>): void {
    this.wakes.fireSubscriptions(...args);
  }

  private evaluateDelegationSettling(sessionId: string): void {
    this.settler.evaluate(sessionId);
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
      backgroundTasks = this.worker.stopBackgroundTasks(sessionId, "stopped when the session was settled");
    } catch {
      // A session that cannot be read has no tasks this can stop.
    }
    void this.browser.release(sessionId, "The session was settled.")?.catch(() => undefined);
    const terminals = await this.sessionTerminals.closeForSettle(sessionId);
    return { terminals, backgroundTasks };
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

  private rewriteNotificationItem(sessionId: string, turn: Turn): void {
    this.wakes.rewriteNotificationItem(sessionId, turn);
  }

  private discardQueuedWakes(subscriberId: string, targetSessionId?: string): number {
    return this.wakes.discardQueuedWakes(subscriberId, targetSessionId);
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
    return this.worker.requireRunningClaim(sessionId, runId, claimToken);
  }

  private requireSenderClaim(proof: { sessionId: string; runId: string; claimToken: string }): Turn {
    return this.worker.requireSenderClaim(proof);
  }

  private appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent {
    return this.kernel.appendEvent(sessionId, event, runId);
  }
}
