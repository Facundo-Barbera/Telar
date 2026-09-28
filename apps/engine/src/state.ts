// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import { ExecutionStore } from "./platform/db/execution-store";
import fs from "node:fs";
import {
  type EngineEvent,
  type ProviderDriverKind,
  type RequestKind,
  type Turn,
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
import { requireRunningClaimFromQueue, TurnAnchors, WorkerChannel, TurnWakes, TurnRecovery, TurnClaims, TurnIngest, type StoppedClaim, TurnLifecycle, TurnIntake, RequestPath } from "./domains/turns";
import { Dictation } from "./domains/dictation";
import { type ResolvedComputerUse } from "./domains/computer-use";
import { WorkspaceFiles } from "./domains/files";
import { SessionGit, WorkspaceReads } from "./domains/git";
import { SessionBrowser } from "./domains/browser";
import { GitHubStore, defaultGhRunner, SessionPulls, type GhRunner } from "./domains/github";
import { ConversationAdoption } from "./domains/providers";
import { BUNDLED_MANIFEST, type ModelManifest, readModelCatalogue } from "./domains/providers";
import { PluginDoors, JobRunner } from "./domains/plugins";
import { ScheduleBook } from "./domains/schedules";
import { derivedBranchFor, prepareSessionWorktree, WorktreeMaintenance, createWorktreeQueue, defaultWorktreeGitRunner, type WorktreeQueue, SETUP_STOP_GRACE_MS, WorktreeSetups } from "./domains/worktrees";
import { defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, type GitRunner } from "./platform/git/runner";
import { PrefetchedGit } from "./platform/git/prefetch";
import { backfillTurnSummaries, CheckoutSizes, CleanupStore, migrateBareClaudeIds, migrateClaudeCompactionToLimits, migrateLegacyPluginFieldsOnOpen, type CheckoutSizesOptions } from "./domains/storage";
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
  readonly remounts: ProjectRemounts;
  readonly attachments: SessionAttachments;
  readonly queries: SessionQueries;
  readonly live: LiveSessions;
  readonly files: WorkspaceFiles;
  readonly requestPath: RequestPath;
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

  private writeIndexedDocument(file: string, indexFile: string, value: unknown, property: string, rows: Array<{ key: string; tag?: string }>, written?: SessionQueue): void {
    this.kernel.writeIndexedDocument(file, indexFile, value, property, rows, written);
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
  private readonly prefetch: PrefetchedGit;
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
    this.asyncGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultAsyncGitRunner);
    this.prefetch = new PrefetchedGit(options.git ?? defaultGitRunner, this.asyncGit);
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
      assertProjectAvailable: (id) => this.projectRegistry.assertAvailable(id),
    });
    this.settler = new SessionSettler(this.kernel, {
      records: this.records,
      scanQueue: (id) => this.scanQueue(id),
      settleDelegatedAfterHours: () => this.settings.inbox().settleDelegatedAfterHours,
      reviewCohorts: () => this.subscriptions.reviewCohorts(),
      onShelfGrew: () => this.enforceTerminalLimitSoon(),
      stopBackgroundTasks: (id, reason) => this.worker.stopBackgroundTasks(id, reason),
      releaseBrowser: (id, reason) => this.browser.release(id, reason),
      closeTerminals: (id) => this.sessionTerminals.closeForSettle(id),
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
    this.files = new WorkspaceFiles({
      projectRoot: (id) => this.projectRegistry.get(id).root,
      sessionRoot: (id) => workspaceRootOf(this.records.get(id)),
    });
    this.requestPath = new RequestPath({
      records: this.records,
      lifecycle: this.lifecycle,
      intake: this.intake,
      git: this.prefetch,
      getProject: (id) => this.projectRegistry.get(id),
      availability: (project) => this.projectProbes.availability(project),
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

  // A shelf that grew or a lower limit keeps its terminals (#883): enforced after the command, never inside it.
  private enforceTerminalLimitSoon(): void {
    if (this.sessionTerminals.attached) void Promise.resolve().then(() => this.sessionTerminals.enforceLimit()).catch(() => undefined);
  }

  private createLifecycle(): SessionLifecycle {
    return new SessionLifecycle(this.kernel, this.records, this.subscriptions, {
      git: this.prefetch.run,
      worktreeGit: this.worktreeGit,
      worktreeQueue: this.worktreeQueue,
      getProject: (projectId) => this.projectRegistry.get(projectId),
      assertProjectAvailable: (projectId) => this.projectRegistry.assertAvailable(projectId),
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
      releasePlugins: (sessionId, reason) => this.pluginDoors.release(sessionId, reason),
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
    const settings = new SettingsStore(this.kernel, () => this.enforceTerminalLimitSoon());
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
      assertProjectAvailable: (id) => this.projectRegistry.assertAvailable(id),
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
      git: this.prefetch.run,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      getProject: (id) => this.projectRegistry.get(id),
      availability: (project) => this.projectProbes.availability(project),
      assertProjectAvailable: (id) => this.projectRegistry.assertAvailable(id),
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

  private requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    return this.turnLifecycle.requeueUndeliveredSteers(queue, runId, at);
  }

  private fireSubscriptions(...args: Parameters<TurnWakes["fireSubscriptions"]>): void {
    this.wakes.fireSubscriptions(...args);
  }

  private evaluateDelegationSettling(sessionId: string): void {
    this.settler.evaluate(sessionId);
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
