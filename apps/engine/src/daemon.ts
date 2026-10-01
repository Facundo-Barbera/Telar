import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ENGINE_PROTOCOL_VERSION, ProviderDriverKind, type ComputerUseGrant, type EngineDiscovery, type EngineHealth } from "@telar/engine-client";
import { BUNDLED_SKILLS, mcpOAuthRoutes } from "./domains/agent-tools";
import { appearanceRoutes } from "./domains/appearance";
import { browserRoutes, browserSessionRoutes } from "./domains/browser";
import { computerUseRoutes, createComputerUseGate, type ComputerUseGate } from "./domains/computer-use";
import { dictationRoutes } from "./domains/dictation";
import { filesRoutes, sessionFilesRoutes } from "./domains/files";
import { sessionGitRoutes } from "./domains/git";
import { githubRoutes, sessionGitHubRoutes, type GhRunner } from "./domains/github";
import { createHostsStore, hostsRoutes } from "./domains/hosts";
import { notesRoutes, notesSocketDoor, ProjectNotesError } from "./domains/notes";
import { createEnginePlugins, externalPluginsDir, PluginInputError, pluginRoutes, pluginScopedRoutes, pluginSessionRoutes } from "./domains/plugins";
import { PreparedPromptsError, promptsRoutes } from "./domains/prompts";
import { projectCheckoutRoutes, projectRoutes } from "./domains/projects";
import { maybeRetitleSession, maybeRetitleWithContext, providersRoutes, readModelCatalogue, sessionProviderRoutes, type CliUpdateRun, type ProviderSkillsOptions, type VersionProbe } from "./domains/providers";
import { createPushService } from "./domains/push";
import { createRemoteStore, remoteDirFor, remoteRoutes } from "./domains/remote";
import { schedulesRoutes } from "./domains/schedules";
import { sessionAttachmentRoutes, sessionLifecycleRoutes, sessionReadRoutes, sessionsRoutes, sessionsSocketDoor, syncTelarSkill, type OpenStream } from "./domains/sessions";
import { settingsRoutes } from "./domains/settings";
import { createStorageMeter, reportBootHousekeeping, storageRoutes, sweepCheckoutsAfterBoot, type CheckoutSizesOptions } from "./domains/storage";
import { createRunMount, runRoutes } from "./domains/terminal";
import { sessionTurnRoutes, turnRoutes, workerRoutes } from "./domains/turns";
import { aboutRoutes } from "./domains/updates";
import { usageRoutes, warmUsageScanCache } from "./domains/usage";
import { WorktreeError, worktreesRoutes } from "./domains/worktrees";
import { setPluginReadTools } from "./drivers/claude";
import type { VolumeDeps } from "./platform/fs/volumes";
import { statePaths } from "./platform/fs/state-paths";
import type { AsyncGitRunner, GitRunner } from "./platform/git/runner";
import { bearerIsValid } from "./platform/http/auth";
import { errorFor as httpErrorFor, HttpError } from "./platform/http/http";
import { closeServer, listenLoopback, removeOwnDiscovery, writeDiscovery } from "./platform/http/listen";
import type { Route } from "./platform/http/route";
import { router } from "./platform/http/router";
import { createLoopLag } from "./platform/process/loop-lag";
import { startSweepers, type Sweep } from "./platform/process/sweepers";
import { EngineStore, type EngineNotifier } from "./state";
import { engineRootFromEnv, migrateLegacyEngineRoot } from "./platform/fs/engine-root";
import { acquireDaemonLock } from "./platform/process/daemon-lock";
import { startEmbeddedWorker, type EmbeddedDoorbell, type EmbeddedWorkerConfig } from "./worker/embedded";
import { createExecutionPort } from "./worker/execution-port";
import { createWorkerRegistry } from "./worker/registry";
import { gitChildren } from "./platform/git/children";

/** Every field is a seam for tests or `main.ts`; absent means the real thing, or off where the real thing would touch this Mac. */
export type EngineDaemonOptions = {
  engineRoot?: string;
  /** Where external plugins are installed. Defaults to `<TELAR_HOME>/plugins`. */
  pluginsDir?: string;
  remoteDir?: string;
  port?: number;
  now?: () => number;
  /** How the engine reaches Deepgram; a test must never spend a real account. */
  dictationFetch?: typeof fetch;
  /** Short on purpose: a lost running turn is stopped rather than replayed or left claimed. */
  workerLeaseMs?: number;
  workerPruneIntervalMs?: number;
  delegationSweepIntervalMs?: number;
  settledTerminalSweepIntervalMs?: number;
  cohortSweepIntervalMs?: number;
  snoozeWakeSweepIntervalMs?: number;
  scheduleSweepIntervalMs?: number;
  requestDeadlineSweepIntervalMs?: number;
  /** The automatic cleanup: every 30 min, first 5 min after start. */
  cleanupIntervalMs?: number;
  cleanupFirstDelayMs?: number;
  /** When the model catalogues refresh after start; `null` turns it off for tests that count provider reads. */
  modelPrefetchDelayMs?: number | null;
  /** An observer only: the retired worker's claims end whether or not this is passed. */
  onWorkerRetired?: (workerId: string) => void;
  /** Told when an approval parks with nobody watching; absent means nobody is told, and the request says so. */
  notifier?: EngineNotifier;
  gh?: GhRunner;
  asyncGit?: AsyncGitRunner;
  /** The mutating git: a clone test must never reach a network. */
  git?: GitRunner;
  /** Where the `telar` skill is installed. Absent means nowhere: a test must not write into the developer's home. */
  skillRoots?: readonly string[];
  models?: typeof readModelCatalogue;
  volumes?: VolumeDeps;
  /** The environment a provider would inherit; tests only. */
  ambientEnv?: Record<string, string | undefined>;
  checkoutSizing?: CheckoutSizesOptions;
  /** Runs a worker inside the engine, so one process is enough; the driver loads lazily, so tests never load an SDK. */
  embeddedWorker?: boolean | EmbeddedWorkerConfig;
  /** Warms the usage scan cache after this many ms; off by default so tests never read the real `~/.claude`. */
  warmUsageCacheAfterMs?: number | false;
  probeProviderVersion?: (driver: ProviderDriverKind, binaryPath: string | undefined, force: boolean) => Promise<VersionProbe>;
  /** A test must never actually run a global install. */
  runProviderUpdate?: (driver: ProviderDriverKind, binaryPath: string | undefined) => Promise<CliUpdateRun>;
  providerSkills?: ProviderSkillsOptions;
  /** The real gate probes cua-driver, which can put a permissions panel on screen. */
  computerUseGate?: ComputerUseGate;
  resetComputerUse?: () => Promise<{ reset: boolean; message?: string }>;
  grantComputerUse?: () => Promise<ComputerUseGrant>;
};

export type EngineDaemon = {
  discovery: EngineDiscovery;
  store: EngineStore;
  /** Present only with `embeddedWorker`; the id changes when the worker re-registers after lease loss. */
  worker?: { readonly workerId: string };
  /** The checkout passes that start once the engine serves; never rejects. */
  checkoutPasses: Promise<void>;
  close(): Promise<void>;
};

function domainError(error: unknown): HttpError | undefined {
  if (error instanceof PluginInputError || error instanceof WorktreeError) return new HttpError(400, "invalid_request", error.message);
  if (error instanceof ProjectNotesError || error instanceof PreparedPromptsError) {
    return new HttpError(error.code === "not_found" ? 404 : 400, error.code, error.message);
  }
  return undefined;
}

const errorFor = (error: unknown): HttpError => httpErrorFor(error, domainError);
const say = (line: string) => process.stdout.write(`${line}\n`);

function openStore(root: string, options: EngineDaemonOptions, doorbell: EmbeddedDoorbell, computerUseGate: ComputerUseGate): EngineStore {
  return new EngineStore(root, options.now, {
    onQueueChanged: () => doorbell.wake?.(),
    onTurnsStopped: (cancellations) => doorbell.cancel?.(cancellations),
    // Printed when the timed journal sweep actually removes rows, not at open.
    onExecutionHousekeeping: ({ journal }) => {
      const rows = journal.deltas + journal.starts;
      if (rows > 0) say(`Telar engine: compacted ${rows.toLocaleString("en-US")} superseded journal rows across ${journal.sessions.toLocaleString("en-US")} sessions`);
    },
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.asyncGit ? { asyncGit: options.asyncGit } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.checkoutSizing ? { checkoutSizing: options.checkoutSizing } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.volumes ? { volumes: options.volumes } : {}),
    ...(options.ambientEnv ? { ambientEnv: options.ambientEnv } : {}),
    // From the gate's last probe, never probed per claim, so only a measured `granted` injects the tools.
    computerUse: () => computerUseGate.forClaim(),
  });
}

const leaseMs = (options: EngineDaemonOptions) => options.workerLeaseMs ?? 15_000;

function engineSweeps(store: EngineStore, options: EngineDaemonOptions, pruneWorkers: () => void, forgetStorage: () => void): Sweep[] {
  const sweepCleanup = () => store.worktrees.runCleanup().then(forgetStorage);
  return [
    { name: "worker-prune", every: options.workerPruneIntervalMs ?? Math.max(10, Math.floor(leaseMs(options) / 3)), run: pruneWorkers },
    // Nothing writes when a delegate's quiet hour passes, a settled session's grace ends or a deadline expires; these are those writes.
    { name: "delegations", every: options.delegationSweepIntervalMs ?? 5 * 60_000, run: () => store.settler.sweepDelegated() },
    { name: "settled-terminals", every: options.settledTerminalSweepIntervalMs ?? 5 * 60_000, run: () => store.sessionTerminals.sweepSettled() },
    // A minute is the shortest cohort timeout, so this ticks faster than that.
    {
      name: "cohorts",
      every: options.cohortSweepIntervalMs ?? 30_000,
      run: () => {
        try {
          store.subscriptions.sweepCohorts();
        } finally {
          store.subscriptions.sweepSubscriptions();
        }
      },
    },
    { name: "snooze-wakes", every: options.snoozeWakeSweepIntervalMs ?? 60_000, run: () => store.settler.sweepSnoozeWakes() },
    { name: "schedules", every: options.scheduleSweepIntervalMs ?? 30_000, run: () => store.schedules.sweep() },
    // Finer than the rest: a tick coarser than the shortest deadline someone sets would become the deadline.
    { name: "request-deadlines", every: options.requestDeadlineSweepIntervalMs ?? 15_000, run: () => store.requestGate.sweepDeadlines() },
    { name: "first-cleanup", once: options.cleanupFirstDelayMs ?? 5 * 60 * 1000, run: sweepCleanup },
    { name: "cleanup", every: options.cleanupIntervalMs ?? 30 * 60 * 1000, run: sweepCleanup },
    { name: "model-prefetch", once: options.modelPrefetchDelayMs === null ? null : (options.modelPrefetchDelayMs ?? 5_000), run: () => store.catalogues.prefetch() },
  ];
}

type RouteContext = {
  store: EngineStore;
  options: EngineDaemonOptions;
  now: () => number;
  root: string;
  remoteStore: ReturnType<typeof createRemoteStore>;
  hostsStore: ReturnType<typeof createHostsStore>;
  push: ReturnType<typeof createPushService>;
  syncOrientationSkill: (policy: ReturnType<EngineStore["settings"]["orientation"]>) => Promise<unknown>;
  computerUseGate: ComputerUseGate;
  storageMeter: ReturnType<typeof createStorageMeter>;
  notesDoor: ReturnType<typeof notesSocketDoor>;
  sessionsDoor: ReturnType<typeof sessionsSocketDoor>;
  daemonId: string;
  openStreams: Set<OpenStream>;
  execution: ReturnType<typeof createExecutionPort>;
  plugins: ReturnType<typeof createEnginePlugins>;
  runMount: ReturnType<typeof createRunMount>;
  workers: ReturnType<typeof createWorkerRegistry>;
  health: () => EngineHealth;
  port: () => number;
};

function engineRoutes(ctx: RouteContext): Route[] {
  const { store, options, now, root, remoteStore, hostsStore, push, syncOrientationSkill, computerUseGate, storageMeter, notesDoor, sessionsDoor, daemonId, openStreams, execution, plugins, runMount, workers, health, port } = ctx;
  return [
    sessionsDoor.route,
    notesDoor.route,
    { method: "GET", path: "/v2/health", auth: "engine", handle: () => ({ status: 200, body: health() }) },
    ...filesRoutes(),
    ...remoteRoutes(remoteStore),
    ...hostsRoutes(hostsStore),
    ...mcpOAuthRoutes(store, now),
    ...aboutRoutes(root),
    ...push.routes,
    ...settingsRoutes(store, syncOrientationSkill),
    ...dictationRoutes(store.dictation, options.dictationFetch),
    ...browserRoutes(store.paths.root),
    ...computerUseRoutes(computerUseGate, { ...(options.grantComputerUse ? { grant: options.grantComputerUse } : {}), ...(options.resetComputerUse ? { reset: options.resetComputerUse } : {}) }),
    ...storageRoutes(store, storageMeter),
    ...worktreesRoutes(store, storageMeter.checkoutsChanged),
    ...usageRoutes(store),
    ...providersRoutes(store, { now, ...(options.probeProviderVersion ? { probeVersion: options.probeProviderVersion } : {}), ...(options.runProviderUpdate ? { runUpdate: options.runProviderUpdate } : {}) }),
    ...appearanceRoutes(store),
    ...promptsRoutes(store),
    ...notesRoutes(store, { port, secret: notesDoor.secret }),
    ...sessionsRoutes(store, { daemonId, openStreams, mcpInfo: sessionsDoor.card }),
    ...schedulesRoutes(store),
    ...workerRoutes(execution),
    ...turnRoutes(store, execution),
    ...projectRoutes(store, plugins.host),
    ...projectCheckoutRoutes(store, options.providerSkills),
    ...githubRoutes(store),
    ...pluginRoutes(store, plugins.host, { dir: plugins.dir, installed: plugins.installed, moduleFor: plugins.moduleFor }),
    ...pluginScopedRoutes(store, plugins.host),
    ...sessionReadRoutes(store),
    ...sessionLifecycleRoutes(store, push.dismiss),
    ...sessionFilesRoutes(store),
    ...sessionGitRoutes(store),
    ...sessionGitHubRoutes(store),
    ...sessionProviderRoutes(store, options.providerSkills),
    ...browserSessionRoutes(store),
    ...pluginSessionRoutes((id) => plugins.host.ready(id)),
    ...runRoutes(store, runMount, openStreams),
    ...sessionAttachmentRoutes(store),
    ...sessionTurnRoutes(store, {
      execution,
      activeWorker: workers.active,
      requireWorker: workers.requireAny,
      retitle: (sessionId, input) => setImmediate(() => void maybeRetitleSession(store, sessionId, input)),
    }),
  ];
}

export async function startEngine(options: EngineDaemonOptions = {}): Promise<EngineDaemon> {
  const root = options.engineRoot ?? engineRootFromEnv();
  const now = options.now ?? Date.now;
  // Before the store and the lock: only the engine may move this tree, and nothing may hold either name.
  if (migrateLegacyEngineRoot(root)) say(`Telar engine: moved the existing store from vnext/ to ${path.basename(root)}/`);
  const lock = await acquireDaemonLock(statePaths(root));
  const doorbell: EmbeddedDoorbell = {};
  const computerUseGate = options.computerUseGate ?? createComputerUseGate();
  const loopLag = createLoopLag();
  loopLag.start();
  let store: EngineStore;
  try {
    store = loopLag.run("boot: open store", () => openStore(root, options, doorbell, computerUseGate));
  } catch (error) {
    loopLag.stop();
    lock.release();
    throw error;
  }
  loopLag.run("boot: housekeeping", () => reportBootHousekeeping(store, now, say));
  const skillRoots = options.skillRoots ?? [];
  // Never fatal and never awaited on start: a provider that isn't installed has nowhere to put the skill.
  const syncOrientationSkill = (policy = store.settings.orientation()): Promise<unknown> =>
    skillRoots.length
      ? Promise.all(BUNDLED_SKILLS.map((skill) => syncTelarSkill({ install: policy.skill, roots: skillRoots, ...skill }))).catch(() => [])
      : Promise.resolve([]);
  void syncOrientationSkill();
  const storageMeter = createStorageMeter(store);
  const daemonId = crypto.randomUUID();
  const plugins = createEnginePlugins(store, {
    dir: options.pluginsDir ?? externalPluginsDir(root),
    daemonId,
    stateDir: store.paths.root,
    withKernels: Boolean(options.embeddedWorker),
  });
  const remoteDir = options.remoteDir ?? remoteDirFor(root);
  const remoteStore = createRemoteStore(remoteDir);
  const openStreams = new Set<OpenStream>();
  const hostsStore = createHostsStore(remoteDir);
  const push = createPushService({ remoteDir, pairedDevices: () => remoteStore.read().devices, pairedHosts: () => hostsStore.read().hosts, openStreams });
  // Run configurations live here, not in a worker: a terminal must outlive the turn that opened it.
  const runMount = createRunMount({ root: store.paths.root, noteForNextTurn: (sessionId, note) => store.mailbox.noteForNextTurn(sessionId, note) });
  store.sessionTerminals.attach(runMount.manager);
  void store.sessionTerminals.refresh();
  runMount.manager.watch(() => void store.sessionTerminals.refresh());
  const pluginStatuses = await plugins.host.startAll();
  // The host, not a plugin's own manifest, is the authority on which of its tools are reads.
  setPluginReadTools(plugins.host.ratifiedReadTools());
  store.pluginDoors.attachRelease((sessionId, reason) => void plugins.host.releaseSession(sessionId, reason));
  const token = crypto.randomBytes(32).toString("base64url");
  const startedAt = now();
  const workers = createWorkerRegistry(store, { now, leaseMs: leaseMs(options), ...(options.onWorkerRetired ? { onRetired: options.onWorkerRetired } : {}) });
  const execution = createExecutionPort(store, workers.registration, workers.active, (sessionId) =>
    setImmediate(() => void maybeRetitleWithContext(store, sessionId).catch((error: unknown) => console.error(`[engine] the second title for ${sessionId} failed: ${String(error)}`))),
  );
  const sweepers = startSweepers(engineSweeps(store, options, workers.prune, storageMeter.forget), loopLag.run);
  // Read once, `.local` dropped: a name that changed per request would be a row that renames itself.
  const hostname = os.hostname().replace(/\.local$/i, "") || undefined;
  const health = (): EngineHealth => ({
    version: ENGINE_PROTOCOL_VERSION,
    daemonId,
    ...(hostname ? { hostname } : {}),
    startedAt,
    worker: workers.health(),
    ...(pluginStatuses.length > 0 ? { plugins: plugins.host.statuses() } : {}),
    git: { liveChildren: gitChildren.live(), cap: gitChildren.cap },
    eventLoop: loopLag.health(),
  });
  let port = 0;
  const sessionsDoor = sessionsSocketDoor(store, () => port);
  const notesDoor = notesSocketDoor(store);
  const secrets: Record<Route["auth"], () => string> = { engine: () => token, "sessions-socket": sessionsDoor.secret, "notes-socket": notesDoor.secret };
  const refusals: Record<Route["auth"], string> = {
    engine: "engine authentication failed",
    "sessions-socket": "the sessions socket answers to its own secret — see /v2/sessions/mcp-info",
    "notes-socket": "the notes socket answers to its own secret — see /v2/notes/mcp-info",
  };
  const authorize = (auth: Route["auth"], request: http.IncomingMessage): void => {
    if (!bearerIsValid(request.headers.authorization, secrets[auth]())) throw new HttpError(401, "engine_unauthorized", refusals[auth]);
  };
  const routes = engineRoutes({ store, options, now, root, remoteStore, hostsStore, push, syncOrientationSkill, computerUseGate, storageMeter, notesDoor, sessionsDoor, daemonId, openStreams, execution, plugins, runMount, workers, health, port: () => port });
  const server = http.createServer(router(routes, { authorize, errorFor, observe: loopLag.run }));

  try {
    port = await listenLoopback(server, options.port ?? 0);
    const discovery: EngineDiscovery = { version: ENGINE_PROTOCOL_VERSION, daemonId, host: "127.0.0.1", port, token, startedAt };
    // Recovered under the lock and before discovery is published, so no client sees a pre-recovery queue.
    loopLag.run("boot: recovery", () => store.recovery.recover());
    writeDiscovery(store.paths.engine, discovery);
    push.listening(discovery);
    const checkoutPasses = sweepCheckoutsAfterBoot(store, say).catch((error: unknown) => console.error(`[engine] the checkout passes failed: ${String(error)}`));
    const embedded = options.embeddedWorker
      ? await startEmbeddedWorker(options.embeddedWorker === true ? {} : options.embeddedWorker, { store, discovery, execution, workers, doorbell, errorFor })
      : undefined;
    // After everything that matters has started, so a gigabyte of transcript I/O does not compete with the first reads.
    let warmUp: ReturnType<typeof setTimeout> | undefined;
    if (options.warmUsageCacheAfterMs !== undefined && options.warmUsageCacheAfterMs !== false) {
      warmUp = setTimeout(() => {
        warmUp = undefined;
        void warmUsageScanCache({ scanCachePath: store.paths.usageScanCache }).catch(() => undefined);
      }, options.warmUsageCacheAfterMs);
      warmUp.unref();
    }
    // Only against a cua daemon already running: the one probe that cannot draw a permissions panel.
    void computerUseGate.measureIfHostRunning();

    let closed = false;
    return {
      discovery,
      store,
      ...(embedded ? { worker: embedded } : {}),
      checkoutPasses,
      async close() {
        if (closed) return;
        closed = true;
        if (warmUp) clearTimeout(warmUp);
        push.close();
        // The worker first: a claim outliving the server it reports to becomes an ambiguous turn on the next start.
        await embedded?.stop();
        await embedded?.closeResources();
        await plugins.host.disposeAll("shutdown");
        // Only the pipe fallback's children close; a run on the desktop's terminal host is the person's to keep.
        await runMount.shutdown();
        await embedded?.closeBrowser();
        // Streams before the server: `server.close()` waits for open connections, and an SSE stream never ends itself.
        for (const stream of openStreams) (stream.end ?? stream)();
        openStreams.clear();
        await closeServer(server);
        sweepers.stop();
        loopLag.stop();
        store.checkoutSizes.stop();
        store.setups.stopAll();
        removeOwnDiscovery(store.paths.engine, daemonId);
        store.kernel.executionStore.close();
        lock.release();
      },
    };
  } catch (error) {
    sweepers.stop();
    loopLag.stop();
    server.close();
    store.kernel.executionStore.close();
    lock.release();
    throw error;
  }
}
