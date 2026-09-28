// The engine owns its loopback listener and the only writable engine state root.
// It intentionally has no provider imports: Phase 1 proves ownership and crash
// semantics before a driver is allowed to execute an agent turn.
import crypto from "node:crypto";
import { atomicWrite } from "./platform/fs/atomic";
import { createExecutionPort, withDirectExecution } from "./worker/execution-port";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import {
  BUNDLED_PLUGIN_TOOL_PREFIXES,
  ENGINE_PROTOCOL_VERSION,
  EngineClientError,
  GitHubLineCommentInput,
  ProviderDriverKind,
  type ComputerUseGrant,
  type EngineDiscovery,
  type EngineHealth,
  type WorkerClaim,
  machineAllows,
  parseDiffBaseQuery,
  parseFilePatchQuery,
  pluginSettings,
  readProjectPlugins,
  workspacePath,
} from "@telar/engine-client";
import { providersRoutes, type CliUpdateRun } from "./domains/providers";
import { computerUseRoutes, createComputerUseGate, type ComputerUseGate } from "./domains/computer-use";
import { bearerIsValid } from "./platform/http/auth";
import { readProviderSkillsCached, type LoadProviderCommands, type VersionProbe } from "./domains/providers";
import { BUNDLED_SKILLS, type SocketTool } from "./domains/agent-tools";
import { collectSessionsWallTools, ensureSessionsSocketSecret, handleSessionsSocketMessage, sessionBootstrap, type SessionBootstrapWindow, sessionsCapability, sessionSnapshot, sessionsSocketConnectCard, storeReads, storeSessionsPort, syncTelarSkill } from "./domains/sessions";
import { browserRoutes, createLoginGrantStore } from "./domains/browser";
import {
  acquireDaemonLock,
  EngineStateError,
  EngineStore,
  migrateLegacyEngineRoot,
  statePaths,
  engineRootFromEnv,
  type DiffBaseOption,
  type EngineNotifier,
  type FilePatchOptions,
  type StoppedClaim,
} from "./state";
import { bundledPlugins } from "./plugins/bundled";
import { isSymlink } from "./plugins/external/installer";
import { externalPluginsDir, loadInstalledPlugins, type LoadedExternalPlugin } from "./plugins/external/manifest";
import { externalPlugin } from "./plugins/external/module";
import { PluginHost } from "./plugins/host";
import { PluginInputError } from "./plugins/routes";
import { setPluginReadTools } from "./drivers/claude";
import { createRunMount } from "./run/mount";
import { RunError } from "./run/types";
import { maybeRetitleSession } from "./domains/providers";
import { appearanceRoutes } from "./domains/appearance";
import { warmUsageScanCache } from "./usage";
import {
  collectNotesWallTools,
  ensureNotesSocketSecret,
  handleNotesSocketMessage,
  notesCapability,
  ProjectNotesError,
  storeNoteRead,
  storeNotesPort,
  notesRoutes,
} from "./domains/notes";
import { PreparedPromptsError, promptsRoutes } from "./domains/prompts";
import { githubRoutes, type GhRunner } from "./domains/github";
import { createStorageMeter, reapNodeModules, storageRoutes, reapReport, retireAgentReport, retireAgentStore, sweepReport, sweepSpoolAndLooms, type CheckoutSizesOptions } from "./domains/storage";
import { WorktreeError, type AsyncGitRunner, type GitRunner } from "./worktree";
import { readWorktreesRoot } from "./worktrees-location";
import type { VolumeDeps } from "./volumes";
import type { DriverSelector } from "./worker";
import { readTaskOutput, resolveTaskOutputFile } from "./drivers/claude";
import { filesRoutes } from "./domains/files";
import { projectCheckoutRoutes, projectRoutes } from "./domains/projects";
import { installedPlugins, pluginRoutes, pluginScopedRoutes } from "./domains/plugins";
import { settingsRoutes } from "./domains/settings";
import { dictationRoutes } from "./domains/dictation";
import { worktreesRoutes } from "./domains/worktrees";
import { usageRoutes } from "./domains/usage";
import { createRemoteStore, remoteDirFor, remoteRoutes } from "./domains/remote";
import { createHostsStore, hostsRoutes } from "./domains/hosts";
import { mcpOAuthRoutes, mcpSocketRoute } from "./domains/agent-tools";
import { aboutRoutes } from "./domains/updates";
import { createPushService } from "./domains/push";
import { body, errorFor as httpErrorFor, HttpError, rawBody, writeError, writeJson } from "./platform/http/http";
import { router } from "./platform/http/router";
import type { Route } from "./platform/http/route";
import { stringValue } from "./platform/http/params";
import { sessionLifecycleRoutes, sessionReadRoutes, sessionsRoutes } from "./domains/sessions";
import { schedulesRoutes } from "./domains/schedules";
import { sessionTurnRoutes, turnRoutes, workerRoutes } from "./domains/turns";

/**
 * `claimSeq` is a per-registration HIGH-WATERMARK, not a cache key.
 *
 * A claim whose response is lost must be repeatable without allocating a second
 * turn, and a random request id cannot do that safely: A is delayed, its retry
 * resolves, B replaces the record, and the original A finally arrives with an
 * id nobody remembers — so it allocates again. An ordered sequence has no such
 * window. Equal to the watermark returns the cached outcome (including a cached
 * "nothing to claim"); older is refused without allocating; only the next
 * number allocates, and only once the current op is definitive.
 */
type RegisteredWorker = {
  workerId: string;
  registeredAt: number;
  heartbeatAt: number;
  claimSeq: number;
  claimResult: WorkerClaim | undefined;
  /** Serialises check+claim+cache for this worker ACROSS AWAITS: the claim
   *  branch authorizes MCP servers over the network before replying, and two
   *  concurrent requests interleaving there would both allocate. */
  claimBusy: Promise<void> | undefined;
};

export type EngineDaemonOptions = {
  /** The background checkout sizer's seams (`checkout-sizes.ts`). Tests only. */
  checkoutSizing?: CheckoutSizesOptions;
  engineRoot?: string;
  /** Where external plugins are installed. Defaults to `<TELAR_HOME>/plugins`. */
  pluginsDir?: string;
  remoteDir?: string;
  port?: number;
  now?: () => number;
  /**
   * HOW THE ENGINE REACHES DEEPGRAM'S GRANT ENDPOINT — injected for `gh`'s
   * reason (#544). A route test that mints a dictation token
   * must never spend a real Deepgram account, and a developer with a key
   * pasted into their own engine would otherwise have this suite doing exactly
   * that. Nothing in production passes anything; the default is `fetch`.
   */
  dictationFetch?: typeof fetch;
  /** Worker liveness is deliberately short; a lost running turn is stopped
   *  rather than replayed or left claimed. See `retireWorker`. */
  workerLeaseMs?: number;
  /** Testable cadence for pruning workers that can no longer heartbeat. */
  workerPruneIntervalMs?: number;
  /**
   * Testable cadence for the delegation-settling sweep — issue #378.
   *
   * SLOW ON PURPOSE. The grace is an hour by default and the two turn-completion
   * points catch every moment the facts change; this only exists for the case
   * where nothing further happens, so a row lands on the shelf a few minutes
   * either side of its hour and nobody can tell.
   */
  delegationSweepIntervalMs?: number;
  /**
   * Testable cadence for closing a clock-settled session's terminals once its
   * grace is over — issue #883. As slow as the delegation sweep: the grace is
   * half an hour, and a few minutes either side of it is not a difference.
   */
  settledTerminalSweepIntervalMs?: number;
  /** Testable cadence for the cohort and subscription sweep. */
  cohortSweepIntervalMs?: number;
  /**
   * Testable cadence for the snooze-wake sweep — issues #490, #586.
   *
   * Between the two above at 60 s, and the reasoning is at the `setInterval`:
   * the shortest snooze the cockpit offers is an hour, so this is finer than it
   * strictly needs to be because the query seeks rather than scans and a wake on
   * a coarse grid is visible.
   */
  snoozeWakeSweepIntervalMs?: number;
  /** #543's sweep. 30 s by default — see the wiring for why not 60. */
  scheduleSweepIntervalMs?: number;
  /** The automatic cleanup's cadence: 30 min, first run 5 min after start. */
  cleanupIntervalMs?: number;
  cleanupFirstDelayMs?: number;
  /** How long after start the model catalogues are refreshed in the
   *  background — see `EngineStore.prefetchModelCatalogues`. `null` turns the
   *  prefetch off, which is what a test that counts provider reads wants. */
  modelPrefetchDelayMs?: number | null;
  /**
   * Testable cadence for the request-deadline sweep — issue #541 D.
   *
   * THE FINEST OF THE FOUR, at 15 s, and the reason is that this one's deadline
   * is not a preset. A snooze is at least an hour and a report window at least a
   * minute; a request deadline is whatever the asker wrote, and "wait thirty
   * seconds then go ahead" is an ordinary thing for a worker to mean. A pass
   * coarser than the shortest sensible deadline silently becomes the deadline.
   *
   * IT IS STILL CHEAP: it walks the live-queue index, not the store, and a
   * daemon with nothing running costs one empty set per tick.
   */
  requestDeadlineSweepIntervalMs?: number;
  /**
   * Told when a worker registration retires. AN OBSERVER, NOT THE CLEANUP:
   * ending that worker's claims happens on the default path inside
   * `retireWorker` whether or not this is passed, because a deployment that
   * passed nothing would otherwise keep a stale claim for ever.
   */
  onWorkerRetired?: (workerId: string) => void;
  /**
   * Told when an approval parks with nobody watching. ABSENT MEANS NOBODY IS
   * TOLD, and the request records that honestly rather than claiming otherwise.
   */
  notifier?: EngineNotifier;
  /**
   * How the engine reaches GitHub. INJECTED for the reason every other
   * subprocess here is: a route test that drives a forge read must never
   * actually spend somebody's rate limit. The default shells to the real `gh`.
   */
  gh?: GhRunner;
  /**
   * Where the `telar` skill is written, and removed from — normally each
   * provider's own skills directory (`providerSkillRoots()`).
   *
   * ABSENT MEANS NOWHERE, AND THAT IS WHAT EVERY TEST GETS. Installing a file
   * into `~/.claude/skills` is a thing a PROCESS does on start, not a thing a
   * library call should do — the same rule `main.ts` already states for the
   * PATH repair and the usage-cache warm, and here it is sharper: a suite that
   * constructs forty daemons must not write forty times into the developer's
   * home directory. `main.ts` passes the real roots.
   */
  skillRoots?: readonly string[];
  asyncGit?: AsyncGitRunner;
  /** The MUTATING git, for the same reason `gh` is injected: a route test that
   *  drives `POST /v2/projects/clone` must never reach somebody's network — or
   *  write a checkout into a temp directory at the mercy of a remote. */
  git?: GitRunner;
  /** Test seam: the provider model list, so a suite never spawns a real CLI. */
  models?: ConstructorParameters<typeof EngineStore>[2] extends { models?: infer M } ? M : never;
  /**
   * How the engine asks about disks (`volumes.ts`). INJECTED for `gh`'s reason
   * and a sharper one: the default shells to `diskutil` and reads this Mac's
   * real `/Volumes`, and a route test about an unplugged drive must be able to
   * unplug one. See `test/fake-mount.ts`.
   */
  volumes?: VolumeDeps;
  /**
   * The engine's own environment — what a provider process would inherit from
   * it (#594).
   *
   * INJECTED BY TESTS ONLY; the default is this process's. A route test about
   * what a newly-configured login stops inheriting has to be able to launch the
   * engine "from a terminal that had a proxy set", and mutating the real
   * `process.env` to do it would leak into every other test in the file.
   */
  ambientEnv?: Record<string, string | undefined>;
  /**
   * Run a worker inside the daemon process.
   *
   * WHY THIS EXISTS: without it, `startEngine()` produces a control plane that
   * accepts turns and then refuses them — `POST /turns` 503s with
   * `worker_unavailable` until a SEPARATE `bun run worker` process registers.
   * "The engine runs on its own" was therefore false in the most literal sense:
   * one process was never enough. `scripts/dev.mjs` papered over it by
   * launching both.
   *
   * The out-of-process worker is NOT going away and is still the right shape
   * for isolating provider crashes — `worker-main.ts` plus
   * `WorkerReconnectController` stay exactly as they are, and an embedded
   * worker coexists with them because the engine already claims turns to
   * exactly one worker at a time.
   *
   * The driver is INJECTED as a factory and imported lazily, so a daemon
   * started without an embedded worker never loads the Claude SDK. Every test
   * in this repo depends on that.
   */
  embeddedWorker?: boolean | { workerId?: string; pollMs?: number; idlePollMs?: number; createDriver?: () => Promise<DriverSelector> | DriverSelector };
  /**
   * Read the provider transcripts into the usage scan cache shortly after
   * start-up, so the first Usage page after an update does not pay for a
   * cold gigabyte. Milliseconds to wait before starting; `false` never warms.
   * OFF BY DEFAULT because every test constructs a daemon and none of them
   * should be reading this machine's real `~/.claude`. `main.ts` turns it on.
   */
  warmUsageCacheAfterMs?: number | false;
  /**
   * How a provider's version is measured. The default runs `<bin> --version`;
   * a test supplies its own so the suite never depends on which CLIs happen to
   * be installed on the machine running it.
   */
  probeProviderVersion?: (driver: ProviderDriverKind, binaryPath: string | undefined, force: boolean) => Promise<VersionProbe>;
  /** INJECTED for the same reason as the probe: a test must never actually run
   *  `npm install -g`. The default spawns for real. */
  runProviderUpdate?: (driver: ProviderDriverKind, binaryPath: string | undefined) => Promise<CliUpdateRun>;
  /**
   * Where `/v2/sessions/:id/skills` reads from, and how it asks the provider.
   *
   * INJECTED FOR THE TWO REASONS EVERY SEAM ABOVE IS: a test must not read this
   * machine's real `~/.claude`, and it must not spawn a CLI to find out what
   * commands the CLI has. `env` redirects the machine-level roots
   * (`CLAUDE_CONFIG_DIR`, exactly as the CLI itself reads it); the loader
   * replaces the `supportedCommands()` handshake. Both default to the real thing.
   */
  providerSkills?: { env?: NodeJS.ProcessEnv; loadProviderCommands?: LoadProviderCommands };
  /**
   * Whether computer use WORKS here, remembered from the last probe — the one
   * fact that decides whether a claim gets the `mac` server.
   *
   * INJECTED BY TESTS: a test daemon must never probe this machine's
   * cua-driver, because probing a stopped daemon launches it and that is when
   * it puts its permissions panel on screen. The default is the real gate.
   */
  computerUseGate?: ComputerUseGate;
  /** INJECTED BY TESTS for the same reason: the real one runs `tccutil`. */
  resetComputerUse?: () => Promise<{ reset: boolean; message?: string }>;
  /** INJECTED BY TESTS: the real one raises macOS prompts and opens System Settings. */
  grantComputerUse?: () => Promise<ComputerUseGrant>;
};

export type EngineDaemon = {
  discovery: EngineDiscovery;
  store: EngineStore;
  /** Present only when `embeddedWorker` was requested. The id is the CURRENT
   *  registration's — it changes when the worker re-registers after lease loss. */
  worker?: { readonly workerId: string };
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

/** The HTTP edge's own ceiling. The store enforces the same number again —
 *  an in-process caller must not be able to walk past a check that only ever
 *  ran on the socket. */
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

function sessionPath(pathname: string): { sessionId: string; tail: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), tail: match[2] ?? "" };
}

/**
 * `?path=…&untracked=1&ignoreWhitespace=1` — how one file's patch is read.
 *
 * SHARED BY THE SESSION AND PROJECT ROUTES, which is the whole reason it is a
 * function: they serve the same surface (`diff-surface.tsx` switches between
 * them on whether there is a session yet), so a parameter one parsed and the
 * other ignored would be a toolbar control that worked in a conversation and
 * did nothing on a canvas.
 */
/**
 * THE QUERY IS PARSED BY THE CONTRACT'S OWN PARSER, not by a copy written here
 * — `protocol/diff-query.ts` carries the argument, and the bug it was written
 * for was a hand-written third copy dropping a parameter in silence.
 */
function filePatchOptions(url: URL): FilePatchOptions {
  return parseFilePatchQuery(url.searchParams);
}

function requestedBase(url: URL): DiffBaseOption {
  return parseDiffBaseQuery(url.searchParams);
}




function writeDiscovery(store: EngineStore, discovery: EngineDiscovery): void {
  // Carries the bearer token, so it stays private even on a single-user laptop.
  fs.mkdirSync(path.dirname(store.paths.engine), { recursive: true, mode: 0o700 });
  atomicWrite(store.paths.engine, discovery);
}

function removeOwnDiscovery(store: EngineStore, daemonId: string): void {
  try {
    const value = JSON.parse(fs.readFileSync(store.paths.engine, "utf8")) as { daemonId?: string };
    if (value.daemonId === daemonId) fs.unlinkSync(store.paths.engine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function startEngine(options: EngineDaemonOptions = {}): Promise<EngineDaemon> {
  const root = options.engineRoot ?? engineRootFromEnv();
  // Before the store opens, and before the lock: the daemon is the only process
  // allowed to move this tree, and it must do it while nothing has a handle on
  // either name.
  if (migrateLegacyEngineRoot(root)) {
    process.stdout.write(`Telar engine: moved the existing store from vnext/ to ${path.basename(root)}/\n`);
  }
  const lock = acquireDaemonLock(statePaths(root));
  /**
   * THE EMBEDDED WORKER'S DOORBELL, set by whichever generation is current and
   * absent when the daemon hosts no worker at all. Declared here because the
   * store is built long before the worker is, and the store is what rings it.
   */
  let wakeEmbeddedWorker: (() => void) | undefined;
  /**
   * THE OTHER HALF OF THE DOORBELL, and the one a Stop needs (#409). The nudge
   * above only un-backs-off an idle worker; this hands over the exact claims a
   * Stop just killed, so the abort happens in the same tick as the request
   * rather than on whatever heartbeat comes next. Set and retired by the same
   * generation fence as `wakeEmbeddedWorker`.
   */
  let cancelEmbeddedClaims: ((cancellations: StoppedClaim[]) => void) | undefined;
  const computerUseGate = options.computerUseGate ?? createComputerUseGate();
  let store: EngineStore;
  try {
  store = new EngineStore(root, options.now, {
    onQueueChanged: () => wakeEmbeddedWorker?.(),
    onTurnsStopped: (cancellations) => cancelEmbeddedClaims?.(cancellations),
    /**
     * THE JOURNAL SWEEP'S LINE, PRINTED LATE — issue #646.
     *
     * The sweep below reports at open because it finishes there. This one runs
     * on a timer seconds afterwards, because its first pass on a large store is
     * a minute of work and the open path is the wrong place for it — so the
     * line arrives when the rows actually go. Same rule as the rest: only when
     * something went, and "superseded" rather than "removed", because these
     * rows say nothing their turn's `item.completed` does not already say.
     */
    onExecutionHousekeeping: ({ journal }) => {
      const rows = journal.deltas + journal.starts;
      if (rows === 0) return;
      process.stdout.write(
        `Telar engine: compacted ${rows.toLocaleString("en-US")} superseded journal rows across ${journal.sessions.toLocaleString("en-US")} sessions\n`,
      );
    },
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.asyncGit ? { asyncGit: options.asyncGit } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.checkoutSizing ? { checkoutSizing: options.checkoutSizing } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.volumes ? { volumes: options.volumes } : {}),
    ...(options.ambientEnv ? { ambientEnv: options.ambientEnv } : {}),
    // Telar's computer use (cua-driver), answered from the gate's LAST PROBE —
    // never probed per claim — so only a measured `granted` injects it. The
    // binary is re-resolved per claim, so an uninstall applies to the next
    // turn. Injected here, not defaulted in the store, so tests never read the
    // real machine.
    computerUse: () => computerUseGate.forClaim(),
  });
  } catch (error) { lock.release(); throw error; }
  /**
   * WHAT THE STORE SWEPT ON THE WAY UP — issue #457, step 4.
   *
   * Both sweeps delete things nothing can reach: command receipts past their
   * week, and the JSON copy the sqlite import left behind once sqlite has owned
   * the store for a week. On the dogfood home that was 299,323 receipts and
   * 239 MB of backup, and the only evidence a person would otherwise have that
   * a quarter of a gigabyte went away is that it is gone.
   *
   * ONE LINE, AND ONLY WHEN SOMETHING WENT. A daemon that printed "removed
   * nothing" on every start would be training its reader to skip the line that
   * matters. A backup still inside its week is deliberately silent too: it is
   * not news, it is the ordinary state of a store migrated this week.
   */
  const swept = store.executionHousekeeping();
  if (swept) {
    const parts: string[] = [];
    if (swept.receipts > 0) parts.push(`${swept.receipts.toLocaleString("en-US")} spent command receipts`);
    if (swept.backup?.removed) {
      const mb = (swept.backup.bytes / 1_000_000).toFixed(1);
      const days = Math.floor(swept.backup.ageMs / 86_400_000);
      parts.push(`the pre-SQLite JSON backup (${swept.backup.files.toLocaleString("en-US")} files, ${mb} MB, ${days} days old)`);
    }
    if (parts.length > 0) process.stdout.write(`Telar engine: removed ${parts.join(" and ")}\n`);
  }
  /**
   * THE SESSION INDEX, WHEN IT HAD TO BE BUILT — issue #493.
   *
   * ONE LINE, AND ONLY WHEN THERE WAS WORK, on the same argument as the sweep
   * above: this is silent on every open after the first, and a daemon that said
   * "indexed 0 sessions" each time would train its reader past the one start
   * where the number is large and the open is visibly slower for it.
   */
  const indexed = store.sessionIndexBackfill;
  if (indexed && (indexed.built > 0 || indexed.removed > 0)) {
    const built = indexed.built > 0 ? `indexed ${indexed.built.toLocaleString("en-US")} sessions` : "";
    const removed = indexed.removed > 0 ? `dropped ${indexed.removed.toLocaleString("en-US")} orphaned rows` : "";
    process.stdout.write(`Telar engine: ${[built, removed].filter(Boolean).join(" and ")}\n`);
  }
  /**
   * AND THE TURN PROJECTION, WHEN IT HAD TO BE BUILT — issue #516.
   *
   * Its own line rather than a clause on the one above, because the two backfills
   * cost differently and a person watching a slow start is trying to work out
   * which: the session index folds four small documents per conversation, this
   * one parses every `items.json` on the machine. Silent on every open after the
   * first, on the same argument as both sweeps above.
   */
  const summarised = store.turnSummaryBackfill;
  if (summarised && summarised.turns > 0) {
    process.stdout.write(
      `Telar engine: summarised ${summarised.turns.toLocaleString("en-US")} turns across ${summarised.sessions.toLocaleString("en-US")} sessions\n`,
    );
  }
  /**
   * AND WHAT THE SPOOL AND THE LOOMS LEFT — issue #501, step 2.
   *
   * Beside the sweep above and for the same reason: two directories nothing in
   * this repository can open any more. Once per home, best-effort, and silent
   * unless something actually went. See `decommission-sweep.ts`.
   */
  const decommissioned = sweepReport(sweepSpoolAndLooms(store.paths.root));
  if (decommissioned) process.stdout.write(`${decommissioned}\n`);
  /**
   * AND THE `node_modules` UNDER FINISHED CONVERSATIONS — issue #633.
   *
   * A third sweep beside the two above, on their judgement: the machines
   * carrying these are nobody's to administer, and a cleanup you have to know
   * to run is a cleanup that does not happen. Archived sessions only, and the
   * checkout itself — its uncommitted work, its branch — is never touched; what
   * goes is the one part `bun install` remakes.
   *
   * THE CHECKOUTS ROOT IS ASKED FIRST, and its answer is passed in rather than
   * re-derived from a `stat`. A root on a drive that is out makes every tree
   * look already gone, and deleting on that reading is `git worktree prune`'s
   * failure. `readWorktreesRoot` is the one
   * place that tells "the drive is out" from "this build cannot tell" from "it
   * is right here".
   *
   * Best-effort and silent unless something actually went.
   */
  try {
    const checkouts = readWorktreesRoot(store.paths.root);
    const reaped = reapReport(reapNodeModules(store.paths.root, {
      rootReadable: checkouts.kind === "configured" || checkouts.kind === "default",
      candidates: store.reapableWorktrees(),
    }));
    if (reaped) process.stdout.write(`${reaped}\n`);
  } catch {
    // A sweep over somebody else's litter is never the reason a daemon fails to
    // start; the next one has another go. `decommission-sweep.ts` makes the
    // same trade for the same reason.
  }
  /**
   * AND EVERY LIVE WORKTREE IS LOCKED — issue #641.
   *
   * Not a sweep: nothing is deleted and nothing is once-per-home. It is the
   * backfill for a guard that is otherwise only applied at the cut, so the
   * worktrees that exist right now — including whichever session is mid-feature
   * when this daemon starts — are covered before the next `gh pr merge
   * --delete-branch` goes looking for one. Cheap, idempotent, and best-effort;
   * see `EngineStore.lockLiveWorktrees`.
   *
   * SILENT, unlike the sweeps above, and deliberately: this runs on every start
   * rather than once, and it changes nothing a person owns. A line per boot
   * saying "locked 7 worktrees" is how a log teaches its reader to skip it.
   */
  store.lockLiveWorktrees();
  /**
   * AND WHAT THE BUILT-IN AGENT LEFT — issue #908.
   *
   * `<engineRoot>/agent/` is MOVED to `retired/agent-<stamp>/`, never deleted:
   * it holds a key somebody pasted, and the Agent is being rebuilt outside
   * Telar. Once per home, best-effort, one line when it moved or could not.
   * See `retireAgentStore`.
   */
  const retiredAgent = retireAgentReport(retireAgentStore(store.paths.root, options.now ?? Date.now));
  if (retiredAgent) process.stdout.write(`${retiredAgent}\n`);
  /**
   * WHICH PROJECTS' DISKS ARE HERE — issue #534.
   *
   * ONCE, ON THE WAY UP, so an engine that started with a drive already unplugged
   * knows it BEFORE the first listing rather than on it. Without this the first
   * `GET /v2/projects` after a boot is the probe, and until it lands the rail
   * would draw an away project as an ordinary one and spawn git against it.
   *
   * NO TIMER FOLLOWS. The poll is `projectMetadata`'s existing call path and the
   * mount events are `POST /v2/projects/reprobe`; this is the floor's first
   * reading, not a third mechanism.
   *
   * ONE LINE, AND ONLY WHEN A DRIVE IS ACTUALLY AWAY, on the same argument as
   * every sweep above: a daemon that reported "all disks present" on each start
   * would train its reader past the start where one is not.
   */
  const away = store
    .listProjects()
    .map((project) => ({ project, availability: store.projectAvailability(project) }))
    .filter((entry) => entry.availability !== "available");
  if (away.length > 0) {
    const named = away.map((entry) => `${entry.project.name} (${entry.availability})`).join(", ");
    process.stdout.write(`Telar engine: ${away.length === 1 ? "a project is" : `${away.length} projects are`} unreadable — ${named}\n`);
  }
  /**
   * THE `telar` SKILL (AND `orchestrate` BESIDE IT), PUT WHERE EACH PROVIDER
   * READS SKILLS FROM — or taken away. Run once on start and again on every PATCH of the toggle.
   *
   * NOT AWAITED BY THE CALLER ON START, and never fatal: a provider that is not
   * installed has no directory to write into, and an engine that refused to
   * start over a missing `~/.codex` would be trading the whole app for a
   * reference file. `syncTelarSkill` reports per-root outcomes rather than
   * throwing, and rewrites only when the content hash moved — see
   * ./orientation.ts for why an unconditional rewrite would be harmful.
   */
  const skillRoots = options.skillRoots ?? [];
  const syncOrientationSkill = (policy = store.getAgentOrientation()): Promise<unknown> =>
    skillRoots.length
      ? Promise.all(BUNDLED_SKILLS.map((skill) => syncTelarSkill({ install: policy.skill, roots: skillRoots, ...skill }))).catch(() => [])
      : Promise.resolve([]);
  void syncOrientationSkill();
  const storageMeter = createStorageMeter(store);
  const daemonId = crypto.randomUUID();
  /**
   * WHAT ONE SESSION SEES OF A PLUGIN, resolved generically — the same question
   * for every plugin ("which project, has it opted in"), answered from the
   * plugin map. A per-plugin store method would be the hardcoded case the host
   * exists to remove.
   */
  const resolvePluginProject = (pluginId: string, sessionId: string): { projectId: string; sessionId: string } => {
    const session = store.getSession(sessionId);
    if (!session.projectId) throw new EngineStateError("invalid_request", `${pluginId} needs a project`);
    const project = store.getProject(session.projectId);
    // EFFECTIVE = MACHINE AND PROJECT. Every door goes through this one gate —
    // the generic `/plugins/:id/:verb`, the `/ds/` and `/latex/` aliases, and
    // the tool walls — so a globally disabled plugin is refused everywhere
    // rather than merely hidden in a cockpit.
    if (!store.pluginRuns(project, pluginId)) {
      const why = machineAllows(store.machinePlugins(), pluginId)
        ? `${pluginId} is not enabled for this session's project`
        : `${pluginId} is turned off for this Mac`;
      throw new EngineStateError("invalid_request", why);
    }
    return { projectId: project.id, sessionId };
  };
  const bundledModules = bundledPlugins({
    resolveHello: (sessionId) => resolvePluginProject("hello", sessionId),
    // The SAME capabilities the aliases and the tool walls already use —
    // migrating a door must not change what is behind it. Each gate is the
    // store's own, which reads the plugin map.
    latex: { resolve: (sessionId) => store.latex(sessionId), jobs: store.latexJobs, settings: store },
    dataScience: {
      resolve: (sessionId) => store.dataScience(sessionId),
      settings: store,
      /**
       * THE KERNEL HOST, built by the plugin's `init` — and only on a daemon
       * that runs turns, as it always was. Outputs are journaled by the
       * store's capability; the host only persists images.
       */
      ...(options.embeddedWorker
        ? {
            kernelHost: {
              options: {
                engineRoot: store.paths.root,
                sessionDir: (sessionId: string) => path.join(store.paths.sessions, sessionId),
                events: {
                  onState: (sessionId, state, reason) => store.recordKernelState(sessionId, state, reason),
                  persistImage: (sessionId, input) =>
                    store.putAttachment(sessionId, {
                      name: `${input.producer}.${input.mediaType === "image/svg+xml" ? "svg" : "png"}`,
                      mediaType: input.mediaType,
                      data: input.data,
                      tags: ["plot"],
                      producer: input.producer,
                      ...(input.title ? { title: input.title } : {}),
                    }).id,
                },
              },
              attach: (host) => store.attachKernels(host),
            },
          }
        : {}),
      projectOf: (sessionId) => {
        try { return store.getSession(sessionId).projectId; } catch { return undefined; }
      },
    },
  });
  /**
   * EXTERNAL PLUGINS, from `<TELAR_HOME>/plugins/<id>/plugin.json`. Loaded at
   * start, then installed and removed from Settings through the routes under
   * `/v2/plugins/installed`; a manifest that does not validate is listed as failed with its
   * reason and never runs (plugins/external/manifest.ts). The bundled ids and
   * prefixes are reserved, so an installed folder cannot shadow a shipped
   * feature.
   */
  const pluginsDir = options.pluginsDir ?? externalPluginsDir(root);
  const remoteDir = options.remoteDir ?? remoteDirFor(root);
  const remoteStore = createRemoteStore(remoteDir), openStreams = new Set<(() => void) & { end?: () => void }>();
  const push = createPushService({ remoteDir, pairedDevices: () => remoteStore.read().devices, openStreams });
  const domainRoutes = [...filesRoutes(), ...remoteRoutes(remoteStore), ...hostsRoutes(createHostsStore(remoteDir)), ...mcpOAuthRoutes(store, () => (options.now ?? Date.now)()), ...aboutRoutes(root), ...push.routes,
    ...settingsRoutes(store, syncOrientationSkill), ...dictationRoutes(store, options.dictationFetch), ...browserRoutes(store.paths.root),
    ...computerUseRoutes(computerUseGate, { ...(options.grantComputerUse ? { grant: options.grantComputerUse } : {}), ...(options.resetComputerUse ? { reset: options.resetComputerUse } : {}) }),
    ...storageRoutes(store, storageMeter), ...worktreesRoutes(store, storageMeter.checkoutsChanged), ...usageRoutes(store),
    ...providersRoutes(store, {
      now: options.now ?? Date.now,
      ...(options.probeProviderVersion ? { probeVersion: options.probeProviderVersion } : {}),
      ...(options.runProviderUpdate ? { runUpdate: options.runProviderUpdate } : {}),
    }),
    ...appearanceRoutes(store), ...promptsRoutes(store),
    ...notesRoutes(store, {
      port: (): number => {
        const bound: ReturnType<http.Server["address"]> = server.address();
        return bound && typeof bound === "object" ? bound.port : 0;
      },
      secret: () => notesSecret(),
    })];
  const external = loadInstalledPlugins(pluginsDir);
  const externalModule = (loaded: LoadedExternalPlugin) =>
    externalPlugin(loaded, {
      resolve: (sessionId) => resolvePluginProject(loaded.manifest.id, sessionId),
      enabledAnywhere: () => store.listProjects().some((project) => store.pluginRuns(project, loaded.manifest.id)),
      settings: (projectId) => {
        const machine = pluginSettings(store.machinePlugins(), loaded.manifest.id);
        if (projectId === undefined) return machine;
        try {
          return { ...machine, ...pluginSettings(readProjectPlugins(store.getProject(projectId)).plugins, loaded.manifest.id) };
        } catch {
          return machine;
        }
      },
    });
  const installed = installedPlugins(external);
  const pluginHost = new PluginHost(
    [...bundledModules, ...external.loaded.map(externalModule)],
    {
      daemonId,
      stateDir: store.paths.root,
      declaredPrefixes: [...BUNDLED_PLUGIN_TOOL_PREFIXES, ...installed.prefixes()],
      refused: external.refused.map(({ dir, meta, error }) => ({ meta, error, installed: { linked: isSymlink(dir) } })),
      log: (message, detail) => console.warn(`[telar] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
    },
  );
  /**
   * RUN CONFIGURATIONS, and the terminals they open. The daemon is what talks
   * to the desktop's terminal host — a process a worker spawned would die with
   * its conversation instead of living in the session's panel. Re-listing the
   * terminals a previous engine opened runs in the background: nothing waits
   * on it, because nothing is blocked by it.
   */
  const runMount = createRunMount({ root: store.paths.root, noteForNextTurn: (sessionId, note) => store.noteForNextTurn(sessionId, note) });
  // Settling closes a session's terminals and an open one holds its checkout
  // busy (#883), and both of those are the store's rules.
  store.attachTerminals(runMount.manager);
  // What the rail counts per session (#883): asked once now, and again when
  // one of the engine's own terminals changes — an event, never a timer.
  void store.refreshTerminalCensus();
  runMount.manager.watch(() => void store.refreshTerminalCensus());
  const pluginStatuses = await pluginHost.startAll();
  /**
   * The host is the authority on which of its tools are reads. Installed here
   * so every provider answers the same way — see `plugins/policy.ts` for why a
   * plugin's own manifest is not allowed to be that authority.
   */
  setPluginReadTools(pluginHost.ratifiedReadTools());
  // The store announces a session's departure; the host decides which plugin
  // cares. This is what let `releaseDataScience` stop naming features.
  store.attachPluginRelease((sessionId, reason) => void pluginHost.releaseSession(sessionId, reason));
  const token = crypto.randomBytes(32).toString("base64url");
  const startedAt = (options.now ?? Date.now)();
  const workers = new Map<string, RegisteredWorker>();
  // Only the registration established by our own supervisor gets process-lifetime
  // ownership. An HTTP client cannot opt into this by choosing a worker id.
  let embeddedRegistration: RegisteredWorker | undefined;
  const now = options.now ?? Date.now;
  const workerLeaseMs = options.workerLeaseMs ?? 15_000;
  /**
   * WHAT THE EMBEDDED WORKER'S LOOP SLOWS TO WITH NOTHING TO DO.
   *
   * A tenth of the fast rate, and it costs nothing a person can feel because
   * the store rings `wake()` the instant a queue moves — a message, a Stop, a
   * claim — so the interval is only ever this long while genuinely nothing is
   * happening. The one thing that does NOT ring it is stopping a background
   * task in a session with no live turn (`task-stops.json` is not a queue), so
   * that single action can take up to a second longer than it used to.
   * Comfortably inside the lease either way: the watchdog runs at lease/3.
   */
  const DEFAULT_EMBEDDED_IDLE_POLL_MS = 1_000;
  /**
   * A REGISTRATION RETIRES — THE ONE DOOR. Dropping the registration and
   * ending the work it held are the same event, so they are the same function
   * and `workers.delete` is not called anywhere else. A path that forgot the
   * second half would leave a claim held by a worker that no longer exists:
   * the session's dispatch blocked behind it for ever, and the stale claim
   * token still able to start a provider through `markTurnRunning` — a turn
   * beginning after the thing that owned it was stopped.
   *
   * Both halves are fenced by ending the turn: `markRunning` takes only a
   * `claimed` turn, so once this has run the old token is refused.
   *
   * Scoped per worker. A retiring registration says nothing about any other
   * worker's claims, and sweeping theirs would stop work nobody touched.
   */
  const retireWorker = (workerId: string): void => {
    // Idempotent: a registration already gone is a no-op, and the store finds
    // no live claims to settle, so a second call journals nothing. That is what
    // makes it safe to call from every path that might be the one that noticed.
    workers.delete(workerId);
    store.retireWorkerRegistration(workerId);
    /**
     * THE OBSERVER RUNS LAST, AND IS NOT THE CLEANUP. `onWorkerRetired` lets a
     * caller (a test, the desktop shell) hear about a retirement; it is
     * optional and unbound by default, so nothing that matters may depend on
     * it. Terminalization happened above, on the default `startEngine` path,
     * with no wiring required — a retirement whose cleanup lived in an
     * optional callback would leave a stale claim blocking the session, and
     * its token still able to start a provider, on every deployment that did
     * not pass one.
     */
    options.onWorkerRetired?.(workerId);
  };
  const pruneWorkers = (): void => {
    // The BACKSTOP for a worker that died without saying so — a directly
    // constructed one, or a crash. The lease bounds how long its claim can sit
    // there; nothing waits on it for ever.
    const expired = [...workers.values()].filter((worker) => worker !== embeddedRegistration && now() - worker.heartbeatAt > workerLeaseMs);
    for (const worker of expired) retireWorker(worker.workerId);
  };
  const activeWorker = (workerId: string): RegisteredWorker => {
    pruneWorkers();
    const worker = workers.get(workerId);
    if (!worker) throw new HttpError(503, "worker_unavailable", "worker is not registered or its lease expired");
    return worker;
  };
  const workerPruner = setInterval(pruneWorkers, options.workerPruneIntervalMs ?? Math.max(10, Math.floor(workerLeaseMs / 3)));
  workerPruner.unref();
  /**
   * THE GRACE NEEDS SOMETHING THAT TICKS — issue #378.
   *
   * A delegate becomes settleable the moment its coordinator takes delivery,
   * and then an hour has to pass with, typically, nothing happening at all.
   * There is no engine-side settling clock to ride: the quiet window is folded
   * by each client. `claimNextTurn` is the only other periodic pass and it
   * walks the LIVE queue index, which by construction excludes exactly the
   * finished conversations this is about.
   *
   * A THROW HERE MUST NOT TAKE THE DAEMON DOWN. The sweep already skips a
   * session it cannot read; this is the backstop for anything else.
   */
  const delegationSweeper = setInterval(() => {
    try {
      store.sweepDelegatedSettling();
    } catch {
      /* the next tick tries again */
    }
  }, options.delegationSweepIntervalMs ?? 5 * 60_000);
  delegationSweeper.unref();
  /**
   * AND A CLOCK-SETTLED SESSION'S TERMINALS NEED ONE — issue #883. Nothing
   * writes when the inactivity window passes, and nothing when the grace after
   * it does; see `sweepSettledTerminals`. Its own promise catches, so a tick
   * that fails waits for the next.
   */
  const settledTerminalSweeper = setInterval(() => {
    void store.sweepSettledTerminals().catch(() => undefined);
  }, options.settledTerminalSweepIntervalMs ?? 5 * 60_000);
  settledTerminalSweeper.unref();
  // A minute is the shortest cohort timeout, so this ticks faster than that.
  const cohortSweeper = setInterval(() => {
    try {
      store.sweepCohorts();
    } catch {
      /* the next tick tries again */
    }
    try {
      store.sweepSubscriptions();
    } catch {
      /* the next tick tries again */
    }
  }, options.cohortSweepIntervalMs ?? 30_000);
  cohortSweeper.unref();
  const snoozeWakeSweeper = setInterval(() => {
    try {
      store.sweepSnoozeWakes();
    } catch {
      /* the next tick tries again */
    }
  }, options.snoozeWakeSweepIntervalMs ?? 60_000);
  snoozeWakeSweeper.unref();
  // 30 s because the shortest schedule interval is 60 s; a 60 s tick would double it.
  /**
   * THE AUTOMATIC CLEANUP: once five minutes after start, then every thirty.
   * With every switch off, a sweep reads one small document and stops.
   */
  const sweepCleanup = () => {
    void store
      .runCleanup()
      .then(() => {
        storageMeter.forget();
      })
      .catch(() => {
        /* the next tick tries again */
      });
  };
  const cleanupFirst = setTimeout(sweepCleanup, options.cleanupFirstDelayMs ?? 5 * 60 * 1000);
  cleanupFirst.unref();
  /**
   * THE MODEL CATALOGUES, REFRESHED ONCE SOON AFTER START — so the first picker
   * opened today answers from a list read today. Late enough not to compete
   * with the start itself; one provider at a time inside the store; never on a
   * request path. A picker opened before it runs still answers at once, from
   * the catalogue persisted by the last run.
   */
  const modelPrefetch = options.modelPrefetchDelayMs === null
    ? undefined
    : setTimeout(() => void store.prefetchModelCatalogues().catch(() => undefined), options.modelPrefetchDelayMs ?? 5_000);
  modelPrefetch?.unref();
  const cleanupSweeper = setInterval(sweepCleanup, options.cleanupIntervalMs ?? 30 * 60 * 1000);
  cleanupSweeper.unref();
  const scheduleSweeper = setInterval(() => {
    try {
      store.sweepSchedules();
    } catch {
      /* the next tick tries again */
    }
  }, options.scheduleSweepIntervalMs ?? 30_000);
  scheduleSweeper.unref();
  /**
   * AND A REQUEST DEADLINE NEEDS ONE — issue #541 D.
   *
   * The fourth instance of the gap the three above describe, and the one with a
   * person's evening in it: `requests.ts` has said since it was written that a
   * detached session which parks an approval at minute three and sits there
   * until morning "is not autonomous; it is stuck, and worse, it is stuck
   * silently". Nothing writes when a deadline passes, so this is the write.
   *
   * 15 s, AND THE FLOOR IS FINER THAN THE THREE ABOVE ON PURPOSE. Their clocks
   * are presets — an hour's snooze, a minute's window — and this one's is
   * whatever the asker wrote down. A tick coarser than the shortest deadline
   * anyone sets would quietly BECOME the deadline, which is the class of bug
   * where a feature works and its number is a fiction.
   *
   * A THROW HERE MUST NOT TAKE THE DAEMON DOWN, as above. The sweep already
   * skips a session it cannot read; this is the backstop for anything else.
   */
  const requestDeadlineSweeper = setInterval(() => {
    try {
      store.sweepRequestDeadlines();
    } catch {
      /* the next tick tries again */
    }
  }, options.requestDeadlineSweepIntervalMs ?? 15_000);
  requestDeadlineSweeper.unref();
  const stopTimers = () => {
    for (const timer of [workerPruner, delegationSweeper, settledTerminalSweeper, cohortSweeper, snoozeWakeSweeper, scheduleSweeper, requestDeadlineSweeper, cleanupSweeper]) {
      clearInterval(timer);
    }
    clearTimeout(cleanupFirst);
    if (modelPrefetch) clearTimeout(modelPrefetch);
  };

  // Read once: it names the Mac to another cockpit (`.local` dropped — it is
  // mDNS's suffix, not the name), and a name that flickered per request
  // would be a row that renames itself.
  const hostname = os.hostname().replace(/\.local$/i, "") || undefined;
  const health = (): EngineHealth => ({
    version: ENGINE_PROTOCOL_VERSION,
    daemonId,
    ...(hostname ? { hostname } : {}),
    startedAt,
    ...(() => {
      pruneWorkers();
      const first = workers.values().next().value as RegisteredWorker | undefined;
      return first
        ? { worker: { registered: true, workerId: first.workerId, activeWorkers: workers.size } }
        : { worker: { registered: false, activeWorkers: 0 } };
    })(),
    // Every registered plugin and what its startup did. Additive on every
    // client: one that predates the host decodes the keys it knows.
    ...(pluginStatuses.length > 0 ? { plugins: pluginHost.statuses() } : {}),
  });

  /**
   * THE SESSIONS SOCKET'S SECRET AND TOOLS, both lazy: nothing is minted or
   * assembled until something asks. Minted SEPARATELY from the notebook's:
   * two doors, two keys.
   */
  let sessionsSecretCache: string | undefined;
  const sessionsSecret = () => (sessionsSecretCache ??= ensureSessionsSocketSecret(store.paths));
  let sessionsToolsCache: SocketTool[] | undefined;
  // No identity: a chat client is not a session, so it has no `self`, no ceiling and no claim proof.
  const buildSessionsCapability = () => sessionsCapability(storeSessionsPort(store), undefined, storeReads(store));
  const sessionsSocketTools = (): SocketTool[] => (sessionsToolsCache ??= collectSessionsWallTools(buildSessionsCapability()));

  /**
   * THE NOTES SOCKET'S SECRET AND TOOLS — the third door, lazy like the other
   * two and minted separately from both: three doors, three keys.
   */
  let notesSecretCache: string | undefined;
  const notesSecret = () => (notesSecretCache ??= ensureNotesSocketSecret(store.paths));
  let notesToolsCache: SocketTool[] | undefined;
  const buildNotesCapability = () => notesCapability(storeNotesPort(store), { read: storeNoteRead(store), updateFailureAsNull: false });
  const notesSocketTools = (): SocketTool[] => (notesToolsCache ??= collectNotesWallTools(buildNotesCapability()));



  const execution = createExecutionPort(store, {
    registerWorker: async (workerId) => {
        stringValue(workerId, "worker id");
        if (!/^[A-Za-z0-9_-]+$/.test(workerId)) throw new HttpError(400, "invalid_request", "worker id is unsafe");
        pruneWorkers();
        if (workers.has(workerId)) throw new HttpError(409, "conflict", "worker id is already registered");
        const at = now();
        workers.set(workerId, { workerId, registeredAt: at, heartbeatAt: at, claimSeq: 0, claimResult: undefined, claimBusy: undefined });
        return { worker: { workerId }, heartbeatIntervalMs: Math.max(50, Math.floor(workerLeaseMs / 3)) };

    },
    workerHeartbeat: async (workerId, _signal, acknowledgedTaskStops) => {
      const worker = activeWorker(workerId);
      worker.heartbeatAt = now();
      return { workerId, heartbeatAt: worker.heartbeatAt,
        cancel: store.cancellationsForWorker(workerId), resolved: store.resolutionsForWorker(workerId),
        steer: store.steerForWorker(workerId), stopTask: store.taskStopsForWorker(workerId, acknowledgedTaskStops) };
    },
    claimTurn: async (workerId, seq) => {
      const worker = activeWorker(workerId);
      worker.heartbeatAt = now();

          if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
            throw new HttpError(400, "invalid_request", "claim sequence must be a positive integer");
          }
          // One at a time per worker, so the authorize await below cannot let a
          // duplicate interleave between the watermark check and the cache.
          const previous = worker.claimBusy ?? Promise.resolve();
          let release!: () => void;
          worker.claimBusy = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            // This request may have waited behind an authorization call while
            // its registration retired. Never allocate for that old generation.
            if (activeWorker(workerId) !== worker) throw new HttpError(503, "worker_unavailable", "worker registration retired");
            // An already-answered sequence replays its outcome — never a second
            // allocation, and `undefined` is a cached answer like any other.
            if (seq === worker.claimSeq) {
              return { claim: worker.claimResult };
            }
            // A straggler from a superseded op. Refused WITHOUT allocating:
            // answering it would hand out a turn nobody is waiting for.
            if (seq < worker.claimSeq) throw new HttpError(409, "conflict", "claim sequence superseded");
            if (seq !== worker.claimSeq + 1) throw new HttpError(400, "invalid_request", "claim sequence out of order");
            // The claim itself is synchronous and under the state lock;
            // attaching managed OAuth bearers is a network call.
            const claimed = store.claimNextTurn(workerId);
            const authorized = claimed ? await store.authorizeClaimedMcpServers(claimed) : undefined;
            if (activeWorker(workerId) !== worker) throw new HttpError(503, "worker_unavailable", "worker registration retired");
            worker.claimSeq = seq;
            worker.claimResult = authorized;
            return { claim: authorized };
          } finally {
            release();
          }
    },
  }, activeWorker);

  const authorize = (auth: Route["auth"], request: http.IncomingMessage): void => {
    if (auth === "engine" && !bearerIsValid(request.headers.authorization, token)) {
      throw new HttpError(401, "engine_unauthorized", "engine authentication failed");
    }
    if (auth === "sessions-socket" && !bearerIsValid(request.headers.authorization, sessionsSecret())) {
      throw new HttpError(401, "engine_unauthorized", "the sessions socket answers to its own secret — see /v2/sessions/mcp-info");
    }
    if (auth === "notes-socket" && !bearerIsValid(request.headers.authorization, notesSecret())) {
      throw new HttpError(401, "engine_unauthorized", "the notes socket answers to its own secret — see /v2/notes/mcp-info");
    }
  };
  const legacyRoutes = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> => {
    try {
      authorize("engine", request);
      const session = sessionPath(url.pathname);
      if (session) {
        /**
         * The session's review: what it has done to the repository since it
         * started. `?path=` narrows it to ONE file's patch, because a review of
         * two hundred files carrying every patch is a megabyte on a poll.
         */
        if (request.method === "GET" && session.tail === "/diff") {
          const target = url.searchParams.get("path");
          if (target) {
            writeJson(response, 200, {
              file: await store.sessionFilePatchAsync(session.sessionId, target, filePatchOptions(url)),
            });
            return;
          }
          writeJson(response, 200, { diff: await store.sessionDiffAsync(session.sessionId, requestedBase(url)) });
          return;
        }
        /**
         * The session's checkout, as a file list. `?path=` reads ONE file's
         * text — the same split as `/diff`, and for the same reason: a tree asks
         * for every path once and a viewer asks for one file at a time.
         */
        if (request.method === "GET" && session.tail === "/files") {
          // OPENING A RELEASED SESSION'S FILES BRINGS ITS CHECKOUT BACK, the way
          // a message does; the listing answers once the re-cut lands.
          store.restoreSessionWorktree(session.sessionId);
          const target = url.searchParams.get("path");
          if (target) {
            writeJson(response, 200, { file: await store.sessionFileAsync(session.sessionId, target) });
            return;
          }
          writeJson(response, 200, { listing: await store.sessionFilesAsync(session.sessionId) });
          return;
        }
        /**
         * WHAT THE SESSION'S PROVIDER CAN BE ASKED TO DO — the composer's `$`
         * and `/` menus (#387).
         *
         * Read where the session actually runs, which is its worktree when it
         * cut one: a project's skills are the ones in ITS checkout, and the
         * provider answers about the directory it was started in. Cached per
         * session inside `provider-skills.ts` — the menu is allowed to ask on a
         * keystroke, so the route must not be a subprocess per keystroke.
         */
        if (request.method === "GET" && session.tail === "/skills") {
          const record = store.getSession(session.sessionId);
          // A session with no checkout has no project skills to read — the
          // answer is the empty menu, not a probe of some other directory.
          const checkout = workspacePath(record.workspace);
          if (checkout === undefined) {
            writeJson(response, 200, { skills: [], commands: [] });
            return;
          }
          writeJson(
            response,
            200,
            await readProviderSkillsCached({
              cacheKey: record.id,
              driver: record.driver,
              checkout,
              ...(options.providerSkills?.env ? { env: options.providerSkills.env } : {}),
              ...(options.providerSkills?.loadProviderCommands
                ? { loadProviderCommands: options.providerSkills.loadProviderCommands }
                : {}),
            }),
          );
          return;
        }
        /**
         * ADOPT ONE — fork it, import its history, and point this session's
         * next turn at the fork.
         *
         * A POST ON THE SESSION, because that is what changes: nothing about
         * the person's own conversation is touched (asserted, not assumed), and
         * what comes back is this session's new turn plus the stamp saying
         * where it came from.
         */
        if (request.method === "POST" && session.tail === "/adopt") {
          const input = await body(request);
          const cut = input.cut === "since_compact_boundary" || input.cut === "whole" ? input.cut : undefined;
          writeJson(
            response,
            201,
            await store.adoptClaudeConversation(session.sessionId, {
              sourceSessionId: stringValue(input.sourceSessionId, "source session id")!,
              ...(cut ? { cut } : {}),
              ...((value) => (value ? { sourceCwd: value } : {}))(stringValue(input.sourceCwd, "source cwd", true)),
            }),
          );
          return;
        }
        /** The session twin of `/v2/projects/:id/files/raw` — one file's bytes,
         *  fenced inside the session's own checkout. */
        if (request.method === "GET" && session.tail === "/files/raw") {
          const target = url.searchParams.get("path");
          if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
          const raw = await store.sessionFileBytesAsync(session.sessionId, target);
          response.writeHead(200, {
            "content-type": raw.mediaType,
            "content-length": raw.data.byteLength,
            "cache-control": "no-store",
          });
          response.end(raw.data);
          return;
        }
        /**
         * PUT, not POST: this replaces one named file and is idempotent given the
         * same hash. A refusal comes back 200 with `written: false` — "the file
         * changed under you" is an answer the editor renders, not an error it
         * should catch (same rule as `/git/commit`).
         */
        if (request.method === "PUT" && session.tail === "/files") {
          const target = url.searchParams.get("path");
          if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
          const input = await body(request);
          writeJson(
            response,
            200,
            store.sessionFileWrite(session.sessionId, target, stringValue(input.text, "file text")!, stringValue(input.expectedSha256, "expected hash")!),
          );
          return;
        }
        if (request.method === "POST" && session.tail === "/git/commit") {
          const input = await body(request);
          writeJson(response, 200, await store.commitSessionWork(session.sessionId, stringValue(input.message, "commit message")!));
          return;
        }
        if (request.method === "POST" && session.tail === "/git/push") {
          /**
           * NO BODY IS READ, and that is the whole security posture of this
           * route: the branch, the checkout and the remote come off the session
           * record. A refusal is a 200 with a reason, like the commit's — "this
           * checkout has no origin" is an answer about the repository, not a
           * failure of the request.
           */
          writeJson(response, 200, await store.pushSessionBranch(session.sessionId));
          return;
        }
        if (request.method === "POST" && session.tail === "/github/pull") {
          const input = await body(request);
          writeJson(
            response,
            200,
            await store.openSessionPullRequest(session.sessionId, {
              title: stringValue(input.title, "pull request title")!,
              ...(typeof input.body === "string" ? { body: input.body } : {}),
              ...(typeof input.base === "string" && input.base.trim() ? { base: input.base } : {}),
            }),
          );
          return;
        }
        /** The pull request a Diff line would be placed on, and the facts that
         *  decide whether it can be (#1014). */
        if (request.method === "GET" && session.tail === "/github/pull/anchor") {
          writeJson(response, 200, await store.sessionPullAnchor(session.sessionId));
          return;
        }
        /** A new review thread on the session branch's pull request. The pull
         *  request is the branch's; the body names only the line and the words. */
        if (request.method === "POST" && session.tail === "/github/pull/comments") {
          const input = GitHubLineCommentInput.safeParse(await body(request));
          if (!input.success) throw new HttpError(400, "invalid_request", "a comment needs a 40-character commit, a path, a line, a side and a body");
          writeJson(response, 200, await store.sessionPullLineComment(session.sessionId, input.data));
          return;
        }
        if (request.method === "GET" && session.tail === "/browser") {
          writeJson(response, 200, {
            browser: await store.browserState(session.sessionId, {
              screenshot: url.searchParams.get("screenshot") === "1",
              start: url.searchParams.get("start") === "1",
            }),
          });
          return;
        }
        if (request.method === "POST" && session.tail === "/browser/open") {
          // A human opening a page in the session's browser from a client
          // with no desktop shell of its own — see EngineStore.browserOpen.
          const input = await body(request);
          writeJson(response, 200, { browser: await store.browserOpen(session.sessionId, stringValue(input.url, "url")!) });
          return;
        }
        if (request.method === "POST" && session.tail === "/browser/control") {
          // The desktop shell reporting whose hands are on the shared browser
          // — see EngineStore.recordBrowserControl. Idempotent by dedupe.
          const input = await body(request);
          const controller = stringValue(input.controller, "controller")!;
          if (controller !== "agent" && controller !== "human" && controller !== "idle") {
            throw new HttpError(400, "invalid_request", "controller must be agent, human or idle");
          }
          store.recordBrowserControl(session.sessionId, controller, stringValue(input.tabId, "tab id", true), input.interrupted === true);
          writeJson(response, 200, {});
          return;
        }
        /**
         * THE DATA SCIENCE DOOR, NOW AN ALIAS. Data science is a migrated
         * plugin (`plugins/data-science.ts`): its verbs live in that module's
         * `routes` table and are served by the generic arm below at
         * `/plugins/data-science/<method>`. This arm stays because
         * `/ds/<method>` is what a RELEASED client calls, and an old cockpit
         * pointed at a new daemon has to keep working.
         *
         * It FORWARDS rather than reimplementing — the switch that used to sit
         * here is gone, so the two doors cannot drift apart.
         */
        const dsMethod = /^\/ds\/([a-z]+(?:\/[a-z]+)?)$/.exec(session.tail)?.[1];
        if (request.method === "POST" && dsMethod) {
          const module = pluginHost.ready("data-science");
          if (!module) throw new HttpError(404, "not_found", "data science is unavailable");
          const route = module.routes?.[dsMethod];
          if (!route) throw new HttpError(404, "not_found", `no data-science method ${dsMethod}`);
          const input = await body(request);
          try {
            writeJson(response, 200, (await route(input, module.resolve?.(session.sessionId))) ?? {});
          } catch (error) {
            if (error instanceof HttpError || error instanceof EngineStateError) throw error;
            throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error));
          }
          return;
        }
        /**
         * THE LATEX DOOR, NOW AN ALIAS, for the same reason and in the same
         * shape: `/latex/<method>` is what a released client calls, and the
         * verbs live in `plugins/latex.ts`.
         */
        const latexMethod = /^\/latex\/([a-z]+)$/.exec(session.tail)?.[1];
        if (request.method === "POST" && latexMethod) {
          const module = pluginHost.ready("latex");
          if (!module) throw new HttpError(404, "not_found", "latex is unavailable");
          const route = module.routes?.[latexMethod];
          if (!route) throw new HttpError(404, "not_found", `no latex method ${latexMethod}`);
          const input = await body(request);
          try {
            writeJson(response, 200, (await route(input, module.resolve?.(session.sessionId))) ?? {});
          } catch (error) {
            if (error instanceof HttpError || error instanceof EngineStateError) throw error;
            throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error));
          }
          return;
        }
        /**
         * THE GENERIC PLUGIN DOOR — the one arm that replaces the two above.
         * `/plugins/<id>/<verb>` resolves the plugin's capability for this
         * session and calls its own route. Nothing here knows what any plugin
         * does, which is the whole claim: adding a plugin adds no line here.
         */
        /**
         * ONE OPTIONAL SECOND SEGMENT IN THE VERB, and no more. A plugin may
         * own a second tool prefix — data science owns `notebook` — and those
         * verbs arrive as `notebook/read`, which a one-segment matcher could
         * not see: the request fell past this arm to "endpoint does not exist"
         * while the `/ds/` alias (whose own matcher allows the slash) answered
         * it. The depth is capped rather than opened up, and the route TABLE
         * still decides what executes, so this widens what can be addressed by
         * exactly the shape a registered verb can have.
         */
        const pluginCallPath = /^\/plugins\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)$/.exec(session.tail);
        if (request.method === "POST" && pluginCallPath) {
          const [, pluginId, verb] = pluginCallPath as unknown as [string, string, string];
          const module = pluginHost.ready(pluginId);
          if (!module) throw new HttpError(404, "not_found", `no plugin ${pluginId}`);
          const route = module.routes?.[verb];
          if (!route) throw new HttpError(404, "not_found", `plugin ${pluginId} has no ${verb}`);
          const input = await body(request);
          try {
            writeJson(response, 200, (await route(input, module.resolve?.(session.sessionId))) ?? {});
          } catch (error) {
            if (error instanceof HttpError || error instanceof EngineStateError) throw error;
            // A BROKEN PLUGIN IS LEGIBLE AS ITS OWN FAILURE — the id is on the
            // message, so a person sees which switch to turn off.
            throw new HttpError(400, "plugin_error", `${pluginId}: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        /**
         * THE RUN DOOR. Gated on the tail BEFORE the body is read, because
         * `body(request)` consumes the stream and every other session route
         * below still needs it. `run/mount.ts` owns everything else and answers
         * `undefined` when the request is not a run request.
         */
        /**
         * THE RUN FEED — #890, and it is what deletes two poll loops.
         *
         * BEFORE THE TABLE, because `RunRoute` returns a VALUE and this route
         * has none: it holds the socket open for the life of the panel. Same
         * frame shape as `/v2/sessions/stream` — the `: open` flush that puts
         * headers on the wire, the 25 s `: beat`, the `openStreams`
         * registration so `server.close()` is not parked on a connection that
         * by design never ends — and every reason written out there applies
         * here verbatim.
         *
         * THE FRAME CARRIES THE WHOLE `RunView`, WHICH THE SESSION FEED'S
         * FRAMES DELIBERATELY DO NOT. That rule exists because a thin frame
         * names a journal entry a reader can page back to; a run's status is
         * in the engine's memory and the only read of it is `/run/status` —
         * the poll this route exists to delete. See `RunStatusEvent`.
         *
         * SCOPED TO THE SESSION. A run is a terminal in one session's panel
         * ("Run = a new terminal"), and a connection that saw every session's
         * terminals would be a cross-session read granted by a typo.
         */
        if (request.method === "GET" && session.tail === "/run/stream") {
          const record = store.getSession(session.sessionId);
          if (!record.projectId) throw new HttpError(400, "invalid_request", "runs need a project");
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          response.write(": open\n\n");
          const stop = runMount.watch(record.id, (event) => {
            try {
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              // The socket has gone; the close handler below unsubscribes.
            }
          });
          const beat = setInterval(() => {
            try {
              response.write(": beat\n\n");
            } catch {
              /* the close handler is what actually tidies up */
            }
          }, 25_000);
          beat.unref();
          const finish = () => {
            clearInterval(beat);
            stop();
            openStreams.delete(finish);
          };
          openStreams.add(finish);
          request.on("close", finish);
          response.on("close", finish);
          (finish as { end?: () => void }).end = () => {
            finish();
            try {
              response.end();
            } catch {
              /* already gone */
            }
          };
          return;
        }
        if (session.tail === "/run" || session.tail.startsWith("/run/")) {
          const runAnswer = runMount.handle(
            request.method ?? "",
            session.tail,
            request.method === "GET" ? Object.fromEntries(url.searchParams) : await body(request),
            () => {
              const record = store.getSession(session.sessionId);
              if (!record.projectId) throw new RunError("invalid_request", "runs need a project");
              // A run is a process in a directory; a session with none cannot
              // have one. Stated separately from the project check because they
              // are different absences, even though today only one session has
              // both.
              const worktreePath = workspacePath(record.workspace);
              if (worktreePath === undefined) throw new RunError("invalid_request", "runs need a working directory");
              return {
                sessionId: record.id,
                projectId: record.projectId,
                worktreePath,
                ...(record.workspace.mode === "worktree" ? { worktreeBranch: record.workspace.branch } : {}),
              };
            },
          );
          if (runAnswer !== undefined) {
            try {
              writeJson(response, 200, (await runAnswer) ?? {});
            } catch (error) {
              // A run's refusal is an ANSWER about the request — "that port is
              // taken", "nothing is deployed" — not a crash.
              if (error instanceof RunError) {
                throw new HttpError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400, error.code, error.message);
              }
              throw error;
            }
            return;
          }
        }
        /** The CSV / Parquet table viewer's backend: a window of rows. */
        if (request.method === "GET" && session.tail === "/data/table") {
          const target = url.searchParams.get("path");
          if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
          writeJson(response, 200, await store.sessionTable(session.sessionId, target, {
            offset: Number(url.searchParams.get("offset") ?? 0),
            limit: Math.min(Number(url.searchParams.get("limit") ?? 200), 1000),
            ...(url.searchParams.get("sort") ? { sort: url.searchParams.get("sort")! } : {}),
            ...(url.searchParams.get("desc") === "1" ? { desc: true } : {}),
          }));
          return;
        }
        /**
         * A BACKGROUND TASK'S LOG, a page at a time — the Processes tab's row.
         * The path is the one the driver stored on the task, never the
         * caller's; `after` is a byte cursor, absent for "the tail".
         */
        const taskOutput = /^\/tasks\/([A-Za-z0-9_-]+)\/output$/.exec(session.tail);
        if (taskOutput && request.method === "GET") {
          const task = store.tasks(session.sessionId).find((one) => one.id === taskOutput[1]);
          if (!task) throw new HttpError(404, "not_found", "task not found");
          const file = task.kind === "background" && task.outputFile ? resolveTaskOutputFile(task.outputFile, task.providerTaskId) : undefined;
          if (!file) throw new HttpError(404, "not_found", "this task has no log");
          const raw = url.searchParams.get("after");
          const after = raw === null ? undefined : Number(raw);
          if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new HttpError(400, "invalid_request", "after must be a byte offset");
          writeJson(response, 200, await readTaskOutput(file, after));
          return;
        }
        /** The plots gallery reads the index; the transcript reads the bytes. */
        if (request.method === "GET" && session.tail === "/attachments") {
          const tag = url.searchParams.get("tag") ?? undefined;
          writeJson(response, 200, { attachments: store.listAttachments(session.sessionId, tag ? { tag } : {}) });
          return;
        }
        const attachmentOne = /^\/attachments\/([A-Za-z0-9_-]+)$/.exec(session.tail);
        if (attachmentOne && request.method === "GET") {
          const { attachment, data } = store.attachmentBytes(session.sessionId, attachmentOne[1]!);
          response.writeHead(200, {
            "content-type": attachment.mediaType,
            "content-length": data.byteLength,
            // The id is minted per write, so the bytes behind it never change.
            "cache-control": "private, max-age=31536000, immutable",
          });
          response.end(Buffer.from(data));
          return;
        }
        if (attachmentOne && request.method === "PATCH") {
          const input = await body(request);
          const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : [];
          writeJson(response, 200, { attachment: store.tagAttachment(session.sessionId, attachmentOne[1]!, tags) });
          return;
        }
        if (request.method === "POST" && session.tail === "/attachments") {
          const data = await rawBody(request, MAX_ATTACHMENT_UPLOAD_BYTES);
          const header = request.headers["x-telar-attachment-name"];
          const encoded = Array.isArray(header) ? header[0] : header;
          let name = "attachment";
          try {
            // Encoded by the client because a filename may hold bytes a header
            // may not. A name that will not decode is not worth failing an
            // upload over — the bytes are the point.
            if (encoded) name = decodeURIComponent(encoded);
          } catch {
            name = encoded ?? "attachment";
          }
          writeJson(response, 201, {
            attachment: store.putAttachment(session.sessionId, {
              name,
              mediaType: (request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim(),
              data,
            }),
          });
          return;
        }
      }
      throw new HttpError(404, "not_found", "engine endpoint does not exist");
    } catch (error) {
      writeError(response, errorFor(error));
    }
  };
  domainRoutes.push(
    mcpSocketRoute("/v2/sessions/mcp", "sessions-socket", "sessions", (message) => handleSessionsSocketMessage(sessionsSocketTools(), message)),
    mcpSocketRoute("/v2/notes/mcp", "notes-socket", "notes", (message) => handleNotesSocketMessage(notesSocketTools(), message)),
    { method: "GET", path: "/v2/health", auth: "engine", handle: () => ({ status: 200, body: health() }) },
    ...sessionsRoutes(store, { daemonId, openStreams, mcpInfo: () => sessionsSocketConnectCard(`http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? 0}/v2/sessions/mcp`, sessionsSecret()) }),
    ...schedulesRoutes(store), ...workerRoutes(execution), ...turnRoutes(store, execution),
    ...projectRoutes(store, pluginHost), ...projectCheckoutRoutes(store, options.providerSkills), ...githubRoutes(store),
    ...pluginRoutes(store, pluginHost, { dir: pluginsDir, installed, moduleFor: externalModule }), ...pluginScopedRoutes(store, pluginHost),
    ...sessionReadRoutes(store), ...sessionLifecycleRoutes(store, push.dismiss),
    ...sessionTurnRoutes(store, {
      execution,
      activeWorker,
      requireWorker: () => {
        pruneWorkers();
        if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
      },
      retitle: (sessionId, input) => setImmediate(() => void maybeRetitleSession(store, sessionId, input)),
    }),
  );
  const server = http.createServer(router(domainRoutes, { authorize, errorFor, fallback: legacyRoutes }));

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port ?? 0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("engine did not bind a TCP port");
    const discovery: EngineDiscovery = {
      version: ENGINE_PROTOCOL_VERSION,
      daemonId,
      host: "127.0.0.1",
      port: address.port,
      token,
      startedAt,
    };
    // Reconciliation happens while the state root lock is held and before
    // discovery is published, so clients never observe a pre-recovery queue.
    store.recover();
    writeDiscovery(store, discovery);
    push.listening(discovery);

    // Lifecycle operations use the same execution port as HTTP handlers,
    // directly in process. Tool capability calls retain the authenticated API.
    let embedded: { workerId: string; stop(): Promise<void> } | undefined;
    let browser: import("./domains/browser").BrowserRuntime | undefined;
    let browserSocket: import("./domains/browser").BrowserToolSocket | undefined;
    let telarRunSocket: import("./domains/agent-tools").TelarToolSocket | undefined;
    if (options.embeddedWorker) {
      const config = options.embeddedWorker === true ? {} : options.embeddedWorker;
      const [{ EngineClient }, { EngineWorker }] = await Promise.all([
        import("@telar/engine-client"),
        import("./worker"),
      ]);
      // The daemon owns the browser, not the driver: it outlives any turn and
      // has to be closed exactly once. `release(sessionId)` on archive is what
      // keeps Chromium instances from accumulating until the pool evicts them.
      const { BrowserRuntime, BrowserRouter, desktopBrowserFromEnv } = await import("./domains/browser");
      // Persistent per-session profiles, under the engine's own state root:
      // a login the human helped with on Tuesday still holds on Thursday.
      browser = new BrowserRuntime({ profileRoot: store.paths.browserProfiles });
      /**
       * THE SHARED BROWSER (§6 of the plan): when the desktop shell exported
       * its control server, calls route to the Electron-hosted tabs the human
       * can see and click; otherwise — detached machine, app quit — the same
       * calls run on the headless runtime. One capability either way, so the
       * store, the socket and both providers never learn which one answered.
       */
      const routed = new BrowserRouter(browser, desktopBrowserFromEnv());
      store.attachBrowser(routed);
      // The browser reaches sessions over the worker-hosted MCP socket, for
      // BOTH providers — see `./browser/socket.ts`. The daemon owns the socket
      // the way it owns the browser: it outlives any turn and is closed once.
      browserSocket = (await import("./drivers")).createBrowserToolSocket(routed);
      // The `telar` wall for Codex and OpenCode turns — worker-hosted like the
      // browser's, per-session tokens, no persisted secret. Distinct from the
      // daemon's outward `/v2/sessions/mcp` door below, which is for clients
      // outside any turn.
      telarRunSocket = new (await import("./domains/agent-tools")).TelarToolSocket();
      const createDriver = config.createDriver ?? (async () => (await import("./drivers")).createDefaultDrivers());
      const concurrency = (await import("./worker")).workerConcurrencyFromEnv();
      const { WorkerReconnectController } = await import("./worker-supervisor");
      const { createWorkerDiagnostics } = await import("./worker-diagnostics");
      // Built once up front so a driver that cannot be constructed fails the
      // boot, not a retry loop; every later attempt builds its own.
      let initialDriver: DriverSelector | undefined = await createDriver();
      const freshWorkerId = () => `worker_embedded_${crypto.randomUUID().replaceAll("-", "")}`;
      let workerId = config.workerId ?? freshWorkerId();
      let generation = 0;
      // The embedded worker shares this event loop: a late heartbeat cannot
      // distinguish a dead worker from a stalled daemon. Its supervisor owns
      // liveness; remote workers still need the ordinary heartbeat lease.
      const socket = browserSocket;
      const telarSocket = telarRunSocket;
      const supervisor = new WorkerReconnectController<InstanceType<typeof EngineClient>, InstanceType<typeof EngineWorker>>({
        connect: async () => {
          return withDirectExecution(new EngineClient(discovery), { ...execution, registerWorker: async (id) => {
            const result = await execution.registerWorker(id);
            embeddedRegistration = workers.get(id);
            return result;
          } }, (error) => {
            const normalized = errorFor(error);
            return new EngineClientError(normalized.code, normalized.message, normalized.status);
          });
        },
        createWorker: async (client, onConnectionLost) => {
          generation += 1;
          if (generation > 1) {
            workerId = freshWorkerId();
            process.stderr.write(`[telar] embedded worker lost its connection; re-registering as ${workerId}\n`);
          }
          const driver = initialDriver ?? (await createDriver());
          initialDriver = undefined;
          const worker = new EngineWorker({
            client,
            workerId,
            driver,
            browserSocket: socket,
            // The same file the settings list and revoke path read — see the
            // note on `createLoginGrantStore`.
            loginGrants: createLoginGrantStore(store.paths.root),
            ...(telarSocket ? { telarSocket } : {}),
            ...(concurrency === undefined ? {} : { concurrency }),
            // TRUSTED, and in-process: this is the registration `pruneWorkers`
            // excludes, so the worker must not expire itself on a clock the
            // engine does not hold it to. Not derivable from any response.
            leaseExempt: true,
            // Persisted, because the packaged app's stderr is /dev/null — see
            // ./worker-diagnostics.ts.
            onDiagnostic: createWorkerDiagnostics(store.paths.root, workerId),
            ...(config.pollMs === undefined ? {} : { pollMs: config.pollMs }),
            /**
             * IN-PROCESS, SO IT CAN AFFORD TO WAIT. An embedded worker is the
             * one that can be TOLD the instant a queue moves (see the store's
             * `onQueueChanged` below), so it does not have to discover work by
             * asking ten times a second forever. A worker in its own process
             * has no such doorbell and is left on its fixed interval.
             */
            idlePollMs: config.idlePollMs ?? DEFAULT_EMBEDDED_IDLE_POLL_MS,
            onConnectionLost,
          });
          // Whichever generation is current owns the doorbell; the `stop`
          // wrapper below hands it back when this one is retired.
          const wakeThisGeneration = () => worker.wake();
          wakeEmbeddedWorker = wakeThisGeneration;
          const cancelThisGeneration = (cancellations: StoppedClaim[]) => worker.cancelClaims(cancellations);
          cancelEmbeddedClaims = cancelThisGeneration;
          const stop = worker.stop.bind(worker);
          const ownedWorkerId = workerId;
          worker.stop = async (reason) => {
            // A stopped/replaced generation must not leave an immortal entry,
            // nor clear the ownership of a later generation.
            if (embeddedRegistration?.workerId === ownedWorkerId) embeddedRegistration = undefined;
            // Same fence for the doorbell: a retired generation must not keep
            // receiving nudges, and must not silence its replacement's.
            if (wakeEmbeddedWorker === wakeThisGeneration) wakeEmbeddedWorker = undefined;
            if (cancelEmbeddedClaims === cancelThisGeneration) cancelEmbeddedClaims = undefined;
            /**
             * THE OLD REGISTRATION IS RETIRED HERE, not left for a prune it is
             * exempt from. That is the FENCE: a late request carrying the dead
             * worker id is refused rather than served, and its cached claim
             * outcome dies with it.
             *
             * WHAT BECOMES OF ITS CLAIMED WORK IS NOT DECIDED HERE. An earlier
             * draft requeued those turns, which is automatic replay of an
             * intent the person's stop, quit or update already ended. The
             * unified terminal-stop lifecycle owns that decision; this hook is
             * the named seam it wires into, and it is scoped to THIS
             * generation's id so no unrelated session can be touched through it.
             */
            retireWorker(ownedWorkerId);
            // Forwarded, so a replaced generation's turns are told they were
            // replaced rather than that Telar shut down — see #208.
            await stop(reason);
          };
          return worker;
        },
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        ...(config.pollMs === undefined ? {} : { retryMs: config.pollMs }),
      });
      await supervisor.start();
      embedded = {
        get workerId() {
          return workerId;
        },
        stop: () => supervisor.stop(),
      };
    }

    /**
     * THE WARM-UP, after everything that matters has started. Deferred so the
     * embedded worker, the browser socket and the first client reads are not
     * competing with a gigabyte of transcript I/O for the event loop; unref'd
     * so it never holds the process open. A warm-up that fails costs nothing
     * — the next /v2/usage read simply does the work itself.
     */
    let warmUp: ReturnType<typeof setTimeout> | undefined;
    if (options.warmUsageCacheAfterMs !== undefined && options.warmUsageCacheAfterMs !== false) {
      warmUp = setTimeout(() => {
        warmUp = undefined;
        void warmUsageScanCache({ scanCachePath: store.paths.usageScanCache }).catch(() => undefined);
      }, options.warmUsageCacheAfterMs);
      warmUp.unref();
    }

    /**
     * COMPUTER USE AT START, only against a cua daemon that is ALREADY
     * running — the one probe that cannot draw a permissions panel on screen
     * (see `createComputerUseGate`). So a machine that works has the tools from
     * its first turn, and one that does not stays exactly as quiet as before.
     * Fire-and-forget; the gate swallows its own failures.
     */
    void computerUseGate.measureIfHostRunning();

    let closed = false;
    return {
      discovery,
      store,
      // A getter: the id changes when the supervisor re-registers.
      ...(embedded ? { worker: embedded } : {}),
      async close() {
        if (closed) return;
        closed = true;
        if (warmUp) clearTimeout(warmUp);
        push.close();
        // The worker stops FIRST: it holds claims, and a claim outliving the
        // server it reports to becomes an ambiguous turn on the next start.
        await embedded?.stop();
        // The socket before the browser it fronts: a listener that outlived
        // its browser would answer tool calls with a runtime already closing.
        await browserSocket?.close();
        await telarRunSocket?.close();
        // Kernels beside the browser: both are processes a turn borrowed and
        // the daemon owns, and both leak past a daemon that does not stop them.
        // Kernels and compile jobs come back through their plugins' own
        // `onDispose`, bounded per cleanup, rather than a line per feature here.
        await pluginHost.disposeAll("shutdown");
        // A run on the desktop's terminal host is left running — it is the
        // person's, and the next engine re-lists it; quitting Telar is what
        // closes it. Only the pipe fallback's children are closed here,
        // because nothing else could ever reach them.
        await runMount.shutdown();
        // Compile and tlmgr jobs are subprocesses of the same kind.
        // After the worker, before the lock: a live Chromium holding a profile
        // lock outlives the process that spawned it otherwise.
        await browser?.close("engine shutting down");
        // THE EVENT STREAMS FIRST, and before the server: `server.close()`
        // waits for open connections, and an SSE stream never closes itself.
        for (const stream of openStreams) (stream.end ?? stream)();
        openStreams.clear();
        await closeServer(server);
        stopTimers();
        store.checkoutSizes.stop();
        // No worktree setup outlives the engine that started it; a cleanup
        // deletes, so it does not tick against a store that is closing.
        store.setups.stopAll();
        removeOwnDiscovery(store, daemonId);
        store.closeExecutionStore();
        lock.release();
      },
    };
  } catch (error) {
    stopTimers();
    server.close();
    store.closeExecutionStore();
    lock.release();
    throw error;
  }
}
