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
  GitHubReactionContent,
  GitHubSubjectId,
  parseForgeQuery,
  PluginInstallInput,
  registerPluginToolPrefixes,
  ProviderDriverKind,
  resolveMcpServers,
  type ComputerUseGrant,
  type EngineDiscovery,
  type EngineHealth,
  type WorkerClaim,
  pluginEnabled,
  machineAllows,
  parseDiffBaseQuery,
  parseFilePatchQuery,
  pluginSettings,
  readProjectPlugins,
  workspacePath,
} from "@telar/engine-client";
import { runCliUpdate, type CliUpdateRun } from "./domains/providers";
import { computerUseRoutes, createComputerUseGate, type ComputerUseGate } from "./domains/computer-use";
import { bearerIsValid } from "./platform/http/auth";
import { createProviderProber, readProviderSkillsCached, type LoadProviderCommands, type VersionProbe } from "./domains/providers";
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
import { bundledPlugins, pluginToolModules, setPluginToolModules } from "./plugins/bundled";
import { installPluginFolder, isSymlink, PluginInstallError, removePluginFolder } from "./plugins/external/installer";
import { BUNDLED_RESERVATIONS, externalPluginsDir, loadInstalledPlugins, type LoadedExternalPlugin } from "./plugins/external/manifest";
import { externalPlugin, externalToolModule, isExternalToolModule } from "./plugins/external/module";
import { PluginHost } from "./plugins/host";
import { matchPluginRoute, PluginInputError, type PluginRouteMethod, type PluginScopedRoute } from "./plugins/routes";
import { setPluginReadTools } from "./drivers/claude";
import { createRunMount } from "./run/mount";
import { RunError } from "./run/types";
import { maybeRetitleSession, runStructuredForPolicy } from "./domains/providers";
import {
  isAppearanceId,
  listImages,
  putImage,
  readProjectIconBytes,
  readImage,
  readLooks,
  readSettings,
  readThemes,
  removeEntry,
  writeLook,
  writeSettings,
  writeTheme,
} from "./domains/appearance";
import { warmUsageScanCache } from "./usage";
import {
  collectNotesWallTools,
  ensureNotesSocketSecret,
  handleNotesSocketMessage,
  notesSocketConnectCard,
  notesCapability,
  ProjectNotesError,
  storeNoteRead,
  storeNotesPort,
} from "./domains/notes";
import * as notebook from "./domains/notes";
import * as shelf from "./domains/prompts";
import { PreparedPromptsError } from "./domains/prompts";
import type { GhRunner } from "./domains/github";
import { createStorageMeter, reapNodeModules, storageRoutes, reapReport, retireAgentReport, retireAgentStore, sweepReport, sweepSpoolAndLooms, type CheckoutSizesOptions } from "./domains/storage";
import { WorktreeError, type AsyncGitRunner, type GitRunner } from "./worktree";
import { readWorktreesRoot } from "./worktrees-location";
import type { VolumeDeps } from "./volumes";
import type { DriverSelector } from "./worker";
import { readTaskOutput, resolveTaskOutputFile } from "./drivers/claude";
import { filesRoutes } from "./domains/files";
import { settingsRoutes } from "./domains/settings";
import { dictationRoutes } from "./domains/dictation";
import { worktreesRoutes } from "./domains/worktrees";
import { usageRoutes } from "./domains/usage";
import { createIconPng } from "./domains/projects";
import { createRemoteStore, remoteDirFor, remoteRoutes } from "./domains/remote";
import { createHostsStore, hostsRoutes } from "./domains/hosts";
import { mcpOAuthRoutes, mcpSocketRoute } from "./domains/agent-tools";
import { aboutRoutes } from "./domains/updates";
import { createPushService } from "./domains/push";
import { body, errorFor as httpErrorFor, HttpError, matchesETag, writeError, writeJson } from "./platform/http/http";
import { router } from "./platform/http/router";
import type { Route } from "./platform/http/route";
import { positiveParam, stringValue } from "./platform/http/params";
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

/**
 * The attachment route's body — raw bytes, with its own much larger cap.
 *
 * SEPARATE FROM `body()` RATHER THAN A PARAMETER ON IT. The 1 MB JSON cap is a
 * guard worth keeping tight on every other route, and one shared reader with a
 * size argument is how that guard drifts: the next route to want a big body
 * passes the big number and nobody notices which limit applies where.
 */
/** The HTTP edge's own ceiling. The store enforces the same number again —
 *  an in-process caller must not be able to walk past a check that only ever
 *  ran on the socket. */
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * A backdrop picture's ceiling. Generous next to the 3.5MB the browser store
 * had to enforce — that number was a share of one origin's localStorage, and
 * this one is a file on a disk. It exists so a mis-aimed upload cannot fill
 * the volume, not to make anyone compress a photograph.
 */
const MAX_APPEARANCE_IMAGE_BYTES = 32 * 1024 * 1024;

/** The four formats `imageExtension` will admit, by the extension it returns. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

async function rawBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new HttpError(400, "invalid_request", "attachment is larger than the engine accepts");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The appearance route's body — JSON like `body()`, but with the cap the
 * published look actually needs.
 *
 * ITS OWN READER RATHER THAN A BIGGER `body()`, for the reason stated above
 * `rawBody`: the 1 MB JSON ceiling is worth keeping tight on every other route,
 * and one shared reader with a size argument is exactly how such a guard drifts.
 * A published look carries its backdrop's pixels — the cockpit's picker
 * compresses to at most 3.5 MB — so this one route reads up to 8 MiB and no
 * other route can accidentally inherit that.
 *
 * REFUSED BEFORE IT IS BUFFERED, twice over: a declared `content-length` past
 * the cap is answered without reading a byte, and a body that lies about (or
 * omits) its length still stops at the limit mid-stream. Buffering eight
 * megabytes only to measure them is the denial of service the cap exists to
 * prevent.
 */
const MAX_APPEARANCE_UPLOAD_BYTES = 8 * 1024 * 1024;

async function appearanceBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const tooLarge = () => new HttpError(413, "invalid_request", `appearance must be under ${MAX_APPEARANCE_UPLOAD_BYTES} bytes`, true);
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_APPEARANCE_UPLOAD_BYTES) throw tooLarge();
  // The bounded read, inline rather than through `rawBody`: this one refuses
  // with a connection-ending error, and `rawBody`'s caller (attachments) reads
  // its body to the end and must keep its socket.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_APPEARANCE_UPLOAD_BYTES) throw tooLarge();
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new HttpError(400, "invalid_request", "request body must be an object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_request", "request body is invalid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new HttpError(400, "invalid_request", "request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The published look's validator, as one string.
 *
 * CUT FROM THE ENGINE'S OWN STAMP, not from a hash of the blob. Hashing would
 * mean walking megabytes on every GET to answer a question the mailbox already
 * knows: there is exactly one published look, it is replaced wholesale, and
 * `updatedAt` is when this engine accepted that replacement. A republish of
 * byte-identical content does mint a new tag and cost one re-download; that is
 * the honest trade against hashing every read forever.
 */
function appearanceEtag(updatedAt: number): string {
  return `"a${updatedAt.toString(36)}"`;
}

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
  const iconPng = createIconPng(path.join(store.paths.root, "icon-png"));
  const remoteStore = createRemoteStore(remoteDir), openStreams = new Set<(() => void) & { end?: () => void }>();
  const push = createPushService({ remoteDir, pairedDevices: () => remoteStore.read().devices, openStreams });
  const domainRoutes = [...filesRoutes(), ...remoteRoutes(remoteStore), ...hostsRoutes(createHostsStore(remoteDir)), ...mcpOAuthRoutes(store, () => (options.now ?? Date.now)()), ...aboutRoutes(root), ...push.routes,
    ...settingsRoutes(store, syncOrientationSkill), ...dictationRoutes(store, options.dictationFetch), ...browserRoutes(store.paths.root),
    ...computerUseRoutes(computerUseGate, { ...(options.grantComputerUse ? { grant: options.grantComputerUse } : {}), ...(options.resetComputerUse ? { reset: options.resetComputerUse } : {}) }),
    ...storageRoutes(store, storageMeter), ...worktreesRoutes(store, storageMeter.checkoutsChanged), ...usageRoutes(store)];
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
  /** What is installed now: loaded by id, and refused folders by listed id. Settings changes both. */
  const installedPlugins = new Map(external.loaded.map((loaded) => [loaded.manifest.id, loaded]));
  const refusedFolders = new Map(external.refused.map((refused) => [refused.meta.id, refused.dir]));
  const installedPrefixes = () => [...installedPlugins.values()].flatMap((loaded) => (loaded.manifest.toolPrefix ? [loaded.manifest.toolPrefix] : []));
  // The walls this process had that are not an installed plugin's — the
  // bundled ones, or a test's own.
  const baseToolModules = pluginToolModules().filter((module) => !isExternalToolModule(module));
  /**
   * The embedded worker registers tools from this list; the out-of-process
   * worker loads the same folder itself (worker-main.ts). And installed tool
   * rows are typed like a bundled plugin's (`parseToolName`).
   */
  const syncInstalledTools = () => {
    registerPluginToolPrefixes(installedPrefixes());
    setPluginToolModules([...baseToolModules, ...[...installedPlugins.values()].map(externalToolModule)]);
  };
  syncInstalledTools();
  const pluginHost = new PluginHost(
    [...bundledModules, ...external.loaded.map(externalModule)],
    {
      daemonId,
      stateDir: store.paths.root,
      declaredPrefixes: [...BUNDLED_PLUGIN_TOOL_PREFIXES, ...installedPrefixes()],
      refused: external.refused.map(({ dir, meta, error }) => ({ meta, error, installed: { linked: isSymlink(dir) } })),
      log: (message, detail) => console.warn(`[telar] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
    },
  );
  /**
   * ONE SERVER FOR EVERY PLUGIN'S PROJECT AND MACHINE VERBS — the generic doors
   * and the old hand-written paths alike, so the two cannot drift apart.
   *
   * `legacy` is the ALIAS mode, and it exists to keep a released client's
   * behaviour byte for byte: no enablement gate (those paths never had one — a
   * settings page lists environments before anything is on), and a plugin's
   * unexpected throw is left to the daemon's ordinary handler rather than
   * relabelled. The generic doors gate and relabel, like the session door.
   */
  const servePluginScoped = async (
    input: {
      pluginId: string;
      scope: "project" | "machine";
      projectId?: string;
      verb: string;
      legacy?: boolean;
    },
    request: http.IncomingMessage,
    url: URL,
    response: http.ServerResponse,
  ): Promise<boolean> => {
    const module = pluginHost.ready(input.pluginId);
    const table: Record<string, PluginScopedRoute<never>> | undefined =
      input.scope === "project" ? module?.projectRoutes : module?.machineRoutes;
    const method = request.method as PluginRouteMethod;
    const matched = matchPluginRoute(table, method, input.verb);
    if (!matched) {
      if (input.legacy) return false;
      if (!module) throw new HttpError(404, "not_found", `no plugin ${input.pluginId}`);
      throw new HttpError(404, "not_found", `plugin ${input.pluginId} has no ${method} ${input.verb}`);
    }
    const { route, params } = matched;
    const beforeEnable = route.beforeEnable === true;
    if (!input.legacy) {
      // THE SAME GATE AND WORDS AS THE SESSION DOOR: off for this Mac refuses
      // every scope; at project scope, a project that has not turned the
      // plugin on refuses too, unless the verb is how it chooses to.
      if (!machineAllows(store.machinePlugins(), input.pluginId)) {
        throw new EngineStateError("invalid_request", `${input.pluginId} is turned off for this Mac`);
      }
      if (input.projectId !== undefined) {
        const project = store.getProject(input.projectId);
        if (!beforeEnable && !store.pluginRuns(project, input.pluginId)) {
          throw new EngineStateError("invalid_request", `${input.pluginId} is not enabled for this project`);
        }
      }
    }
    const parsedBody = method === "POST" ? await body(request) : {};
    const routeRequest = { input: parsedBody, query: url.searchParams, params };
    let answer: unknown;
    try {
      answer = await (route.handle as (request: typeof routeRequest, scope: unknown) => unknown)(
        routeRequest,
        input.projectId !== undefined ? { projectId: input.projectId } : {},
      );
    } catch (error) {
      if (input.legacy || error instanceof HttpError || error instanceof EngineStateError || error instanceof PluginInputError) throw error;
      throw new HttpError(400, "plugin_error", `${input.pluginId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeJson(response, route.status ?? 200, answer ?? {});
    return true;
  };
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
   * INJECTED so a test never shells out to a real CLI. The default probes for
   * real; every engine test in this repo passes its own, which is also what
   * keeps the suite fast and offline.
   */
  const probeProviders = createProviderProber({
    ...(options.probeProviderVersion ? { version: options.probeProviderVersion } : {}),
    now,
  });
  const updateProvider =
    options.runProviderUpdate ??
    ((driver: ProviderDriverKind, binaryPath: string | undefined) => {
      return runCliUpdate(driver, binaryPath ? { binaryPath } : {});
    });
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
      if (request.method === "GET" && url.pathname === "/v2/models") {
        const driver = url.searchParams.get("driver") ?? "claude";
        const instanceId = url.searchParams.get("instanceId");
        writeJson(response, 200, {
          catalogue: await store.modelCatalogue(driver as "claude" | "codex", {
            force: url.searchParams.get("refresh") === "1",
            // Absent means the driver's built-in slot — the same fallback
            // `resolveProviderInstance` makes for a session naming an id nobody
            // configured. The PROVIDER answer is still driver-wide; the instance
            // is what selects the overlay laid over it.
            ...(instanceId ? { instanceId } : {}),
          }),
        });
        return;
      }
      /**
       * THE PERSON'S OWN CLAUDE CODE CONVERSATIONS — `/resume`'s picker (#616).
       *
       * NOT UNDER A SESSION, and that is the whole reason it is here rather
       * than beside `/skills`: the picker runs on a CANVAS, before the session
       * it would adopt into exists. `projectSkills` learned the same thing in
       * #500 — a question a canvas has to ask cannot be scoped to a session.
       *
       * IT IS STILL A LOGIN'S QUESTION. A configured instance keeps its own
       * config directory with its own history in it, so `?instanceId=` selects
       * whose conversations these are; absent is the built-in slot, which is
       * where a terminal `claude` writes.
       *
       * `?cwd=` narrows to one project directory. Absent lists every project,
       * which is the right default: resume finds a conversation BY ID from any
       * directory, so filtering to cwd-matched projects would hide
       * conversations that would adopt perfectly well. The project path is on
       * each row instead, and the person decides.
       */
      if (request.method === "GET" && url.pathname === "/v2/claude/conversations") {
        const instanceId = url.searchParams.get("instanceId")?.trim();
        const cwd = url.searchParams.get("cwd")?.trim();
        writeJson(response, 200, {
          conversations: await store.listAdoptableClaudeConversations({
            ...(instanceId ? { instanceId } : {}),
            ...(cwd ? { cwd } : {}),
            limit: positiveParam(url.searchParams.get("limit"), 100, 500, "limit"),
          }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/projects") {
        // `?includeRemoved=1` OPTS IN to the put-away ones. Absent by default,
        // so every picker and the sidebar drop a removed project without
        // knowing the concept exists; its own settings page is the one caller
        // that has to name it in order to offer to restore it.
        writeJson(response, 200, { projects: store.listProjects({ includeRemoved: url.searchParams.get("includeRemoved") === "1" }) });
        return;
      }
      /**
       * A DRIVE WAS PLUGGED IN OR PULLED OUT — issue #534.
       *
       * ACCELERATION, NOT TRUTH, and the distinction is the whole contract. The
       * poll in `projectMetadata` is the floor and is what makes the feature
       * correct; this only moves the moment it notices from "within one pass" to
       * "now". So a shell that never calls it, a watcher that dies, an event
       * missed while the Mac was asleep — each costs latency and nothing else,
       * which is why the desktop side (`main.js`) is allowed to be best-effort.
       *
       * NO BODY, AND IT NAMES NO PROJECT. The caller knows a disk moved; it does
       * not know which registrations that concerns, and asking it to work that
       * out would put the engine's rule in the shell. Every project is re-probed
       * — three `stat`s each — and the answer says how many actually moved, which
       * is what makes the desktop unit test able to assert the call landed.
       */
      if (request.method === "POST" && url.pathname === "/v2/projects/reprobe") {
        writeJson(response, 200, store.reprobeProjects());
        return;
      }
      /** Who writes generated titles and branch names — a document of the
       *  environment, like the inbox rule above and for the same reason. */
      if (url.pathname === "/v2/textgen" && (request.method === "GET" || request.method === "PATCH")) {
        if (request.method === "GET") {
          writeJson(response, 200, { textGen: store.getTextGenPolicy() });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          textGen: store.setTextGenPolicy({
            ...("titles" in input ? { titles: input.titles } : {}),
            ...("renameBranches" in input ? { renameBranches: input.renameBranches } : {}),
            ...("driver" in input ? { driver: input.driver } : {}),
            // `null` returns to the driver's default model; the key's presence
            // is the question, same rule as the inbox window above.
            ...("model" in input ? { model: input.model } : {}),
          }),
        });
        return;
      }
      /**
       * ONE STRUCTURED COMPLETION, for a caller that brought its own schema.
       *
       * THE GENERALISATION OF THE TITLE JOB above it: same policy, same
       * built-in instance, same short-lived `claude -p` / `codex exec` child
       * that cannot touch any session's transcript. What changes is who writes
       * the prompt — a cockpit feature that needs one small model answer no
       * longer has to grow its own subprocess plumbing.
       *
       * SYNCHRONOUS AND SLOW BY NATURE (a cold harness start plus a completion,
       * bounded by textgen's own timeout). Callers must treat it as a request
       * that can take a minute, and must survive it failing.
       *
       * A FAILURE IS A 502, NOT AN EMPTY 200. textgen's contract is that every
       * failure — missing CLI, timeout, refusal, unparseable output — resolves
       * to `undefined`, which is exactly right for a background nicety and
       * exactly wrong for a caller that ASKED for an answer. The gateway status
       * says the truth: this daemon is fine, the harness behind it did not
       * deliver.
       */
      if (request.method === "POST" && url.pathname === "/v2/textgen/complete") {
        const input = await body(request);
        const prompt = input["prompt"];
        if (typeof prompt !== "string" || prompt.trim().length === 0) {
          throw new HttpError(400, "invalid_request", "prompt must be a non-empty string");
        }
        // Well past any reasonable one-shot prompt, well short of a context
        // window — a caller pasting a whole repository in here has taken a
        // wrong turn, and the CLI would only fail slower.
        if (prompt.length > 20_000) {
          throw new HttpError(400, "invalid_request", "prompt must be under 20000 characters");
        }
        const schema = input["schema"];
        if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
          throw new HttpError(400, "invalid_request", "schema must be a JSON schema object");
        }
        const model = input["model"];
        if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
          throw new HttpError(400, "invalid_request", "model must be a non-empty string when given");
        }
        const effort = input["effort"];
        if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
          throw new HttpError(400, "invalid_request", "effort must be low, medium or high when given");
        }
        // A caller that hangs up mid-completion kills the harness child rather
        // than leaving it to burn its two-minute timeout. `close` also fires
        // after a normal end, where aborting a finished run is a no-op.
        const abort = new AbortController();
        response.on("close", () => abort.abort());
        const result = await runStructuredForPolicy(store, {
          prompt,
          schema: schema as object,
          ...(typeof model === "string" ? { model } : {}),
          ...(typeof effort === "string" ? { effort: effort as "low" | "medium" | "high" } : {}),
          signal: abort.signal,
        });
        if (abort.signal.aborted) return; // Nobody is listening for the answer.
        if (result === undefined) throw new HttpError(502, "textgen_failed", "the harness did not answer");
        writeJson(response, 200, { result });
        return;
      }
      /**
       * THE HOST'S LOOK, PUBLISHED — see `EngineStore.getAppearance`.
       *
       * WHY THE ENGINE HOLDS A BROWSER'S PREFERENCE, which is otherwise against
       * the grain here: appearance lives in localStorage because that is where a
       * person configures it, and a paired iOS client has no way to read another
       * device's localStorage. The cockpit republishes its RESOLVED look through
       * `PUT`, and every paired client reads the same answer from `GET`.
       *
       * OPAQUE ON PURPOSE. The daemon does not know what an accent or a theme
       * half is and must not learn — the store's only rules are "a JSON object"
       * and "under the cap", which is what keeps the vocabulary additive across
       * an engine and an app that ship on different days. The SHAPE is a real
       * type now (`PublishedAppearance` in @telar/engine-client) and the client
       * parses it on the way out; the engine still does not read a key of it.
       *
       * CACHEABLE, BECAUSE IT GOT BIG. A published look carries its backdrop's
       * pixels, so a phone polling this on every foreground would re-download
       * megabytes to learn nothing changed. GET answers with `updatedAt` and an
       * `ETag`; a matching `If-None-Match` gets a bodyless 304.
       *
       * DELETE IS A REAL OPERATION, not the absence of one. "I do not want my
       * look published any more" had no expression at all, and the closest
       * available move — PUTting an empty object — publishes a look that
       * describes nothing rather than withdrawing the one on file.
       *
       * PAIRED-ONLY, like everything else under `/v2`: this is a description of
       * one person's machine, and the bearer check upstream is the whole access
       * story. Nothing here is exempt from it.
       */
      /**
       * THE APPEARANCE HOME — the files themselves, over HTTP.
       *
       * /v2/appearance is a MAILBOX: one resolved blob a browser published for
       * paired clients to wear. This is the RECORD: the themes, looks, settings
       * and pictures that a person or an agent edits on disk, which the cockpit
       * reads and writes so both authors see one truth. Two routes because they
       * are two different things, not two spellings of one.
       */
      if (url.pathname === "/v2/appearance/home") {
        if (request.method === "GET") {
          const themes = readThemes(store.paths.root);
          const looks = readLooks(store.paths.root);
          writeJson(response, 200, {
            settings: readSettings(store.paths.root) ?? null,
            themes: themes.entries,
            looks: looks.entries,
            images: listImages(store.paths.root),
            // NAMED, not swallowed: a hand-edited directory grows broken files,
            // and someone hunting for a theme that will not appear deserves to
            // be told which one it is.
            skipped: [...themes.skipped, ...looks.skipped],
          });
          return;
        }
        writeJson(response, 405, { error: { code: "invalid_request", message: "the appearance home accepts GET" } }, { allow: "GET" });
        return;
      }
      if (url.pathname === "/v2/appearance/home/settings" && request.method === "PUT") {
        const body_ = await body(request);
        writeSettings(store.paths.root, body_);
        writeJson(response, 200, { ok: true });
        return;
      }
      {
        // themes/<id> and looks/<id>, which differ only in the folder.
        const entry = /^\/v2\/appearance\/home\/(themes|looks)\/([^/]+)$/.exec(url.pathname);
        if (entry) {
          const kind = entry[1] as "themes" | "looks";
          const id = decodeURIComponent(entry[2]!);
          if (!isAppearanceId(id)) {
            throw new HttpError(400, "invalid_request", "id must contain only letters, numbers, underscores or hyphens");
          }
          if (request.method === "PUT") {
            const value = await body(request);
            if (kind === "themes") writeTheme(store.paths.root, id, value);
            else writeLook(store.paths.root, id, value);
            writeJson(response, 200, { ok: true, id });
            return;
          }
          if (request.method === "DELETE") {
            removeEntry(store.paths.root, kind, id);
            writeJson(response, 200, { ok: true });
            return;
          }
          writeJson(response, 405, { error: { code: "invalid_request", message: "accepts PUT and DELETE" } }, { allow: "PUT, DELETE" });
          return;
        }
      }
      if (url.pathname === "/v2/appearance/home/images" && request.method === "POST") {
        const bytes = await rawBody(request, MAX_APPEARANCE_IMAGE_BYTES);
        const name = putImage(store.paths.root, bytes);
        // REFUSED HERE rather than stored and discovered broken later: the
        // format is sniffed from the bytes, so "this is not an image" is a
        // fact this route already knows.
        if (name === undefined) throw new HttpError(400, "invalid_request", "the body must be a PNG, JPEG, GIF or WebP image");
        writeJson(response, 200, { ok: true, name });
        return;
      }
      {
        const image = /^\/v2\/appearance\/home\/images\/([^/]+)$/.exec(url.pathname);
        if (image && request.method === "GET") {
          const bytes = readImage(store.paths.root, decodeURIComponent(image[1]!));
          if (bytes === undefined) throw new HttpError(404, "not_found", "no such image");
          response.writeHead(200, {
            "content-type": IMAGE_TYPES[path.extname(image[1]!).slice(1)] ?? "application/octet-stream",
            // The name IS a content hash, so the bytes behind it can never change.
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(bytes.byteLength),
          });
          response.end(Buffer.from(bytes));
          return;
        }
      }
      if (url.pathname === "/v2/appearance") {
        if (request.method === "GET") {
          const stored = store.getAppearance();
          // No look published: no ETag either. There is nothing to revalidate,
          // and a tag for "nothing" would let a client cache an empty mailbox
          // past the moment somebody fills it.
          if (!stored) {
            writeJson(response, 200, { appearance: null, updatedAt: null });
            return;
          }
          const etag = appearanceEtag(stored.updatedAt);
          if (matchesETag(request.headers["if-none-match"], etag)) {
            response.writeHead(304, { etag, "cache-control": "no-store" });
            response.end();
            return;
          }
          writeJson(response, 200, { appearance: stored.blob, updatedAt: stored.updatedAt }, { etag });
          return;
        }
        if (request.method === "PUT") {
          // THE BODY IS THE BLOB ITSELF, not a wrapper around it. A snapshot of
          // a browser's whole resolved look has no partial form worth
          // expressing, so there is nothing for an envelope to carry.
          const written = store.setAppearance(await appearanceBody(request));
          writeJson(response, 200, { ok: true, updatedAt: written.updatedAt, etag: appearanceEtag(written.updatedAt) }, { etag: appearanceEtag(written.updatedAt) });
          return;
        }
        if (request.method === "DELETE") {
          store.clearAppearance();
          writeJson(response, 200, { ok: true });
          return;
        }
        // 405, NOT 404. Falling through to the catch-all told a client that
        // POSTs here that the route does not exist — sending it looking for a
        // typo in the path rather than at the verb it chose. Written here
        // rather than thrown so `Allow` can say what would have worked, which
        // is the whole point of answering 405 instead of 404.
        writeJson(
          response,
          405,
          { error: { code: "invalid_request", message: "appearance accepts GET, PUT and DELETE" } },
          { allow: "GET, PUT, DELETE" },
        );
        return;
      }
      /**
       * THE CONNECT CARD — where the notebook's outward socket listens and its
       * dedicated secret. BEHIND THE NORMAL BEARER, deliberately: the card
       * mints and reveals the socket's credential, so only something already
       * holding engine access may read it. The composed `claude mcp add` line
       * comes from the engine so the card and the socket cannot disagree.
       */
      if (request.method === "GET" && url.pathname === "/v2/notes/mcp-info") {
        const bound = server.address();
        const port = bound && typeof bound === "object" ? bound.port : 0;
        writeJson(response, 200, {
          mcp: notesSocketConnectCard(`http://127.0.0.1:${port}/v2/notes/mcp`, notesSecret()),
        });
        return;
      }
      /**
       * A project's git state, for the composer's pinned environment.
       *
       * Under /v2/projects/:id/ rather than /v2/sessions/:id/ because it
       * describes the PROJECT — every session on it sees the same branch, and
       * hanging it off a session would invite a per-session answer the working
       * tree cannot give.
       */
      const projectGit = /^\/v2\/projects\/([^/]+)\/git$/.exec(url.pathname);
      if (request.method === "GET" && projectGit) {
        writeJson(response, 200, { git: await store.projectGitAsync(decodeURIComponent(projectGit[1])) });
        return;
      }
      const sessionSetup = /^\/v2\/sessions\/([^/]+)\/setup$/.exec(url.pathname);
      if (sessionSetup && request.method === "GET") {
        const sessionId = decodeURIComponent(sessionSetup[1]!);
        store.getSession(sessionId);
        const after = Number(url.searchParams.get("after") ?? 0);
        writeJson(response, 200, {
          setup: store.setups.status(sessionId) ?? null,
          ...store.setups.output(sessionId, Number.isFinite(after) && after > 0 ? after : 0),
        });
        return;
      }
      /**
       * THE PROJECT NOTEBOOK. Under
       * `/v2/projects/:id/` for the same reason the git route is: notes belong
       * to the PROJECT, and every session on it opens the same notebook.
       *
       * `store.getProject` FIRST ON EVERY ONE OF THESE. It is the registration
       * check (an unknown id 404s rather than minting a file) and it is also
       * what keeps a caller-supplied id from being treated as a path before
       * anything has vouched for it — `notesPath` re-checks the shape anyway,
       * which is belt and braces on the one route family where a string becomes
       * a filename.
       */
      const projectNotes = /^\/v2\/projects\/([^/]+)\/notes$/.exec(url.pathname);
      if (projectNotes && (request.method === "GET" || request.method === "POST")) {
        const projectId = decodeURIComponent(projectNotes[1]);
        store.getProject(projectId);
        if (request.method === "GET") {
          writeJson(response, 200, { notes: notebook.readNotes(store.paths, projectId) });
          return;
        }
        const input = await body(request);
        writeJson(response, 201, {
          // ABSENT `author` MEANS THE HUMAN'S. Only the tool wall declares
          // "session" — so a note that arrives with no declaration is a hand's.
          note: notebook.createNote(store.paths, projectId, {
            title: input.title as string,
            body: (input.body ?? "") as string,
            ...(input.pinned !== undefined ? { pinned: Boolean(input.pinned) } : {}),
            author: input.author === "session" ? "session" : "you",
          }),
        });
        return;
      }
      const projectNote = /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)$/.exec(url.pathname);
      if (projectNote && (request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")) {
        const projectId = decodeURIComponent(projectNote[1]);
        const noteId = decodeURIComponent(projectNote[2]);
        store.getProject(projectId);
        if (request.method === "DELETE") {
          // `deleted: false` RATHER THAN A 404 on a note that is already gone:
          // a retried delete has reached the state it asked for, and the strip's
          // optimistic removal must not be undone by an error on the retry.
          writeJson(response, 200, { deleted: notebook.deleteNote(store.paths, projectId, noteId) });
          return;
        }
        if (request.method === "GET") {
          const note = notebook.getNote(store.paths, projectId, noteId);
          if (!note) throw new HttpError(404, "not_found", "no note goes by that id in this project's notebook");
          writeJson(response, 200, { note });
          return;
        }
        const patch = await body(request);
        const note = notebook.updateNote(store.paths, projectId, noteId, patch);
        if (!note) throw new HttpError(404, "not_found", "no note goes by that id in this project's notebook");
        writeJson(response, 200, { note });
        return;
      }
      /**
       * THE PROMPT SHELF — unsent messages kept by name, either hand's.
       *
       * Under `/v2/projects/:id/` for the notebook's reason, and with the same
       * `store.getProject` FIRST on every one of them: it is the registration
       * check, and it is what keeps a caller-supplied id from becoming a
       * filename before anything has vouched for it.
       *
       * A prompt may also carry the SESSION it was prepared for. This route
       * answers the whole shelf rather than filtering by session, because the
       * caller that wants one composer's list (`promptsForComposer`) and the
       * caller that wants the project's count are both real.
       */
      const projectPrompts = /^\/v2\/projects\/([^/]+)\/prompts$/.exec(url.pathname);
      if (projectPrompts && (request.method === "GET" || request.method === "POST")) {
        const projectId = decodeURIComponent(projectPrompts[1]);
        store.getProject(projectId);
        if (request.method === "GET") {
          writeJson(response, 200, { prompts: shelf.readPrompts(store.paths, projectId) });
          return;
        }
        const input = await body(request);
        writeJson(response, 201, {
          // ABSENT `author` MEANS THE HUMAN'S, as on the notebook: only the tool
          // wall declares "session", so a prompt arriving undeclared is a hand's.
          prompt: shelf.createPrompt(store.paths, projectId, {
            title: input.title as string,
            text: (input.text ?? "") as string,
            ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
            ...(input.reason !== undefined ? { reason: String(input.reason) } : {}),
            author: input.author === "session" ? "session" : "you",
          }),
        });
        return;
      }
      const projectPrompt = /^\/v2\/projects\/([^/]+)\/prompts\/([^/]+)$/.exec(url.pathname);
      if (projectPrompt && (request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")) {
        const projectId = decodeURIComponent(projectPrompt[1]);
        const promptId = decodeURIComponent(projectPrompt[2]);
        store.getProject(projectId);
        if (request.method === "DELETE") {
          // `deleted: false` RATHER THAN A 404 on one that is already gone: the
          // ordinary way a prompt leaves this shelf is being sent, possibly from
          // the other window, and a retried delete has reached the state it asked
          // for.
          writeJson(response, 200, { deleted: shelf.deletePrompt(store.paths, projectId, promptId) });
          return;
        }
        if (request.method === "GET") {
          const prompt = shelf.getPrompt(store.paths, projectId, promptId);
          if (!prompt) throw new HttpError(404, "not_found", "no prepared prompt goes by that id on this project's shelf");
          writeJson(response, 200, { prompt });
          return;
        }
        const patch = await body(request);
        const prompt = shelf.updatePrompt(store.paths, projectId, promptId, patch);
        if (!prompt) throw new HttpError(404, "not_found", "no prepared prompt goes by that id on this project's shelf");
        writeJson(response, 200, { prompt });
        return;
      }
      /** Pin or unpin. Its own route rather than a PATCH field on the caller's
       *  side, because it is one gesture from one control and the surface should
       *  not have to compose a patch to express a toggle. */
      const projectNotePin = /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)\/pin$/.exec(url.pathname);
      if (request.method === "POST" && projectNotePin) {
        const projectId = decodeURIComponent(projectNotePin[1]);
        store.getProject(projectId);
        const input = await body(request);
        const note = notebook.updateNote(store.paths, projectId, decodeURIComponent(projectNotePin[2]), {
          pinned: input.pinned === undefined ? true : Boolean(input.pinned),
        });
        if (!note) throw new HttpError(404, "not_found", "no note goes by that id in this project's notebook");
        writeJson(response, 200, { note });
        return;
      }
      // `?v=` only busts caches; `?format=png` is for clients that cannot decode SVG.
      const projectIcon = /^\/v2\/projects\/([^/]+)\/icon$/.exec(url.pathname);
      if (request.method === "GET" && projectIcon) {
        const icon = await store.projectIconFileAsync(decodeURIComponent(projectIcon[1]));
        const served = await readProjectIconBytes(icon);
        const png = served && url.searchParams.get("format") === "png";
        const bytes = png ? await iconPng(served) : served?.bytes;
        if (!served || !bytes) throw new HttpError(404, "not_found", "this project has no icon");
        response.writeHead(200, {
          "content-type": png ? "image/png" : served.contentType,
          "content-length": bytes.byteLength,
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${served.etag}${png ? "-png" : ""}"`,
        });
        response.end(bytes);
        return;
      }
      /**
       * A project's issues and pull requests.
       *
       * `?refresh=1` IS THE ONLY WAY PAST THE CACHE, and the surface sends it
       * only from a button a human pressed. A timer must never be able to hold
       * a network read open against somebody else's rate limit.
       */
      /** The project's own uncommitted work, for a canvas with no session. */
      const projectDiff = /^\/v2\/projects\/([^/]+)\/diff$/.exec(url.pathname);
      if (request.method === "GET" && projectDiff) {
        const projectId = decodeURIComponent(projectDiff[1]);
        const target = url.searchParams.get("path");
        if (target) {
          writeJson(response, 200, {
            file: await store.projectFilePatchAsync(projectId, target, filePatchOptions(url)),
          });
          return;
        }
        writeJson(response, 200, { diff: await store.projectDiffAsync(projectId) });
        return;
      }
      /** The project's own file list, for a canvas with no session — same tree,
       *  one scope wider. */
      const projectFiles = /^\/v2\/projects\/([^/]+)\/files$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "PUT") && projectFiles) {
        const projectId = decodeURIComponent(projectFiles[1]);
        const target = url.searchParams.get("path");
        if (request.method === "PUT") {
          if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
          const input = await body(request);
          writeJson(
            response,
            200,
            store.projectFileWrite(projectId, target, stringValue(input.text, "file text")!, stringValue(input.expectedSha256, "expected hash")!),
          );
          return;
        }
        if (target) {
          writeJson(response, 200, { file: await store.projectFileAsync(projectId, target) });
          return;
        }
        writeJson(response, 200, { listing: await store.projectFilesAsync(projectId) });
        return;
      }
      /**
       * WHAT A PROJECT'S PROVIDER CAN BE ASKED TO DO — the same inventory as
       * `/v2/sessions/:id/skills`, one scope wider, for a canvas whose session
       * does not exist yet (#500).
       *
       * A FRESH SESSION IS THE WHOLE REASON THIS ROUTE EXISTS. `$` used to draw
       * nothing on a canvas because the only way to ask was per session, and a
       * session with no runtime has no answer — so the menu stayed empty until
       * after the first turn. The project's own checkout is the honest thing to
       * read there: it is what the session about to be created will copy or run
       * in, and it is where its `.claude` already is.
       *
       * THE DRIVER IS THE CANVAS'S PENDING CHOICE, because it has not been
       * recorded anywhere yet. Claude when unsaid, matching `/v2/models`.
       */
      const projectSkills = /^\/v2\/projects\/([^/]+)\/skills$/.exec(url.pathname);
      if (request.method === "GET" && projectSkills) {
        const project = store.getProject(decodeURIComponent(projectSkills[1]!));
        const asked = url.searchParams.get("driver");
        const driver = ProviderDriverKind.safeParse(asked ?? "claude");
        if (!driver.success) throw new HttpError(400, "invalid_request", `unknown provider driver ${JSON.stringify(asked)}`);
        writeJson(
          response,
          200,
          await readProviderSkillsCached({
            cacheKey: `project:${project.id}:${driver.data}`,
            driver: driver.data,
            checkout: project.root,
            ...(options.providerSkills?.env ? { env: options.providerSkills.env } : {}),
            ...(options.providerSkills?.loadProviderCommands ? { loadProviderCommands: options.providerSkills.loadProviderCommands } : {}),
          }),
        );
        return;
      }
      /** One project file's BYTES — the media viewers' read. Same fence as the
       *  text read; the answer is content and a media type instead of JSON. */
      const projectFileRaw = /^\/v2\/projects\/([^/]+)\/files\/raw$/.exec(url.pathname);
      if (request.method === "GET" && projectFileRaw) {
        const target = url.searchParams.get("path");
        if (!target) throw new HttpError(400, "invalid_request", "a file path is required");
        const raw = await store.projectFileBytesAsync(decodeURIComponent(projectFileRaw[1]), target);
        response.writeHead(200, {
          "content-type": raw.mediaType,
          "content-length": raw.data.byteLength,
          // Unlike an attachment, a workspace file changes under its own name.
          "cache-control": "no-store",
        });
        response.end(raw.data);
        return;
      }
      const projectGitHub = /^\/v2\/projects\/([^/]+)\/github$/.exec(url.pathname);
      if (request.method === "GET" && projectGitHub) {
        /**
         * PARSED BY THE CONTRACT, so the builder and the reader of this query string
         * are the same file. Two hand-written parsers is how the cockpit's own
         * adapter came to forward `refresh` and silently drop every filter.
         *
         * A bad state throws a plain Error from the parser — `gh` would fail on the
         * flag and report it as GitHub being broken — and it becomes a 400 here,
         * which is the one thing the parser cannot know how to do.
         */
        let filters;
        try {
          filters = parseForgeQuery(url.searchParams);
        } catch (cause) {
          throw new HttpError(400, "invalid_request", cause instanceof Error ? cause.message : "invalid filter");
        }
        writeJson(response, 200, {
          github: await store.projectGitHub(decodeURIComponent(projectGitHub[1]), {
            force: filters.refresh,
            issues: filters.issues,
            pulls: filters.pulls,
          }),
        });
        return;
      }
      /**
       * One failing check's log.
       *
       * `(\d+)` IN THE PATTERN, so a job id either is a number or is not this route.
       * The id came from a check this engine handed out, and it still goes into a `gh`
       * argv — which is exactly when "we produced it" stops being a reason to trust it.
       */
      const projectCheckLog = /^\/v2\/projects\/([^/]+)\/github\/checks\/(\d+)\/log$/.exec(url.pathname);
      if (request.method === "GET" && projectCheckLog) {
        writeJson(response, 200, {
          log: await store.projectCheckLog(decodeURIComponent(projectCheckLog[1]), projectCheckLog[2]),
        });
        return;
      }
      /** What there is to filter by. Its own route because it is its own cache — see
       *  `projectForgeFacets` — and because nothing asks for it until somebody opens
       *  a filter menu. */
      const projectFacets = /^\/v2\/projects\/([^/]+)\/github\/facets$/.exec(url.pathname);
      if (request.method === "GET" && projectFacets) {
        writeJson(response, 200, {
          facets: await store.projectForgeFacets(decodeURIComponent(projectFacets[1]), { force: url.searchParams.get("refresh") === "1" }),
        });
        return;
      }
      /**
       * Ignore Telar's own files in a project's repository.
       *
       * A POST WITH NO BODY, on purpose: the rules are the engine's (see
       * `gitignore.ts`) and a caller that could name them could append anything to
       * a file inside somebody's repository. The answer says what was added and
       * what was already covered, because those look identical and mean opposite
       * things.
       */
      const projectGitignore = /^\/v2\/projects\/([^/]+)\/gitignore$/.exec(url.pathname);
      if (request.method === "POST" && projectGitignore) {
        writeJson(response, 200, { gitignore: store.projectGitignore(decodeURIComponent(projectGitignore[1])) });
        return;
      }
      /**
       * And the way back out. DELETE rather than a flag on the POST, because it
       * is the inverse of that write rather than a variant of it — the Sources
       * palette ignores Telar's files without asking and reports it with an
       * Undo, so the undo is a route rather than a second switch.
       */
      if (request.method === "DELETE" && projectGitignore) {
        writeJson(response, 200, { gitignore: store.undoProjectGitignore(decodeURIComponent(projectGitignore[1])) });
        return;
      }
      /**
       * ONE issue or ONE pull request, and merging one.
       *
       * `(\d+)` IN THE PATTERN rather than a parse afterwards: the number goes
       * into a `gh` argv, and a route that matched `../../etc` and then tried to
       * make sense of it is a route that can be argued with. It either is a
       * number or it is not this route.
       *
       * THE FOUR-AND-A-FIFTH KINDS OF NOTHING COME BACK AS 200s, the same as the
       * list's. "gh is not signed in" and "there is no #999" are answers about the
       * environment and the repository; a 4xx here would collapse them into the
       * cockpit's generic error path and lose the sentence that says what to do.
       */
      const projectForge = /^\/v2\/projects\/([^/]+)\/github\/(issues|pulls)\/(\d+)$/.exec(url.pathname);
      if (request.method === "GET" && projectForge) {
        const projectId = decodeURIComponent(projectForge[1]);
        const number = Number(projectForge[3]);
        const force = url.searchParams.get("refresh") === "1";
        writeJson(
          response,
          200,
          projectForge[2] === "issues" ? await store.projectIssue(projectId, number, { force }) : await store.projectPull(projectId, number, { force }),
        );
        return;
      }
      /**
       * One reaction, added or removed — #842. The content and the subject id are
       * refused HERE when they are not shaped like GitHub's, so nothing but one of
       * the eight words and an opaque node id ever reaches a `gh` argv.
       */
      const projectReaction = /^\/v2\/projects\/([^/]+)\/github\/(issues|pulls)\/(\d+)\/reactions$/.exec(url.pathname);
      if (request.method === "POST" && projectReaction) {
        const input = await body(request);
        const content = GitHubReactionContent.safeParse(input.content);
        if (!content.success) throw new HttpError(400, "invalid_request", "content must be one of GitHub's eight reactions");
        const subject = GitHubSubjectId.safeParse(input.subjectId);
        if (!subject.success) throw new HttpError(400, "invalid_request", "subjectId must be a GitHub node id");
        if (typeof input.react !== "boolean") throw new HttpError(400, "invalid_request", "react must be true or false");
        writeJson(
          response,
          200,
          await store.projectGitHubReaction(decodeURIComponent(projectReaction[1]), {
            kind: projectReaction[2] === "issues" ? "issue" : "pull",
            number: Number(projectReaction[3]),
            subjectId: subject.data,
            content: content.data,
            react: input.react,
          }),
        );
        return;
      }
      /**
       * Reply to, resolve or unresolve one review thread — #842. The thread id is
       * matched as a GitHub node id IN THE PATTERN, for the reason the number is.
       */
      const projectThread = /^\/v2\/projects\/([^/]+)\/github\/pulls\/(\d+)\/threads\/([A-Za-z0-9_=-]{1,200})\/(replies|resolve)$/.exec(url.pathname);
      if (request.method === "POST" && projectThread) {
        const input = await body(request);
        const projectId = decodeURIComponent(projectThread[1]);
        const number = Number(projectThread[2]);
        const threadId = projectThread[3];
        if (projectThread[4] === "replies") {
          if (typeof input.body !== "string") throw new HttpError(400, "invalid_request", "body must be a string");
          writeJson(response, 200, await store.projectThreadReply(projectId, number, { threadId, body: input.body }));
        } else {
          if (typeof input.resolved !== "boolean") throw new HttpError(400, "invalid_request", "resolved must be true or false");
          writeJson(response, 200, await store.projectThreadResolve(projectId, number, { threadId, resolved: input.resolved }));
        }
        return;
      }
      const projectMerge = /^\/v2\/projects\/([^/]+)\/github\/pulls\/(\d+)\/merge$/.exec(url.pathname);
      if (request.method === "POST" && projectMerge) {
        const input = await body(request);
        const method = stringValue(input.method, "merge method")!;
        if (method !== "merge" && method !== "squash" && method !== "rebase") {
          throw new HttpError(400, "invalid_request", "merge method must be merge, squash or rebase");
        }
        writeJson(
          response,
          200,
          await store.projectPullMerge(decodeURIComponent(projectMerge[1]), Number(projectMerge[2]), {
            method,
            // Required, and named for what it is: the head the person who pressed
            // the button had reviewed. See `mergePull`.
            expectedHeadOid: stringValue(input.expectedHeadOid, "expected head commit")!,
          }),
        );
        return;
      }
      /**
       * What a project IS and what it OPTS INTO. `PATCH`, not `PUT`: the body
       * names only the fields it means to move, and the ROOT is never one of
       * them — moving a project means registering the new folder. `null` on an
       * optional field REMOVES the stored answer, which is the difference
       * between "never asked" and "off" for a plugin, and between "follows this
       * Mac" and "insists on local" for a workspace mode.
       *
       * The store re-validates every one of these against the contract's own
       * schemas; what the arms here do is refuse the WRONG SHAPE with a 400 and
       * a sentence naming the field, rather than letting a JSON array reach a
       * zod error the client reads as "project is invalid".
       */
      const projectPatch = /^\/v2\/projects\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && projectPatch) {
        const input = await body(request);
        const patch: Parameters<typeof store.updateProject>[1] = {};
        if ("name" in input) {
          if (typeof input.name !== "string" || input.name.trim() === "") {
            throw new HttpError(400, "invalid_request", "name must be a non-empty string");
          }
          patch.name = input.name;
        }
        if ("iconName" in input) {
          if (input.iconName !== null && typeof input.iconName !== "string") {
            throw new HttpError(400, "invalid_request", "iconName must be a string or null");
          }
          patch.iconName = input.iconName as string | null;
        }
        if ("iconEmoji" in input) {
          if (input.iconEmoji !== null && typeof input.iconEmoji !== "string") {
            throw new HttpError(400, "invalid_request", "iconEmoji must be a string or null");
          }
          patch.iconEmoji = input.iconEmoji as string | null;
        }
        if ("defaultModel" in input) {
          if (input.defaultModel !== null && (typeof input.defaultModel !== "object" || Array.isArray(input.defaultModel))) {
            throw new HttpError(400, "invalid_request", "defaultModel must be an object or null");
          }
          patch.defaultModel = input.defaultModel as Parameters<typeof store.updateProject>[1]["defaultModel"];
        }
        if ("envMode" in input) {
          if (input.envMode !== null && input.envMode !== "local" && input.envMode !== "worktree") {
            throw new HttpError(400, "invalid_request", "envMode must be local, worktree or null");
          }
          patch.envMode = input.envMode as Parameters<typeof store.updateProject>[1]["envMode"];
        }
        /**
         * DEPRECATED INPUT ALIASES for `plugins["data-science"]` / `plugins.latex`,
         * accepted one more release so a released cockpit keeps working. The
         * store writes them into the map; neither key is stored or returned.
         */
        if ("dataScience" in input) {
          if (input.dataScience !== null && (typeof input.dataScience !== "object" || Array.isArray(input.dataScience))) {
            throw new HttpError(400, "invalid_request", "dataScience must be an object or null");
          }
          patch.dataScience = input.dataScience as Parameters<typeof store.updateProject>[1]["dataScience"];
        }
        if ("latex" in input) {
          if (input.latex !== null && (typeof input.latex !== "object" || Array.isArray(input.latex))) {
            throw new HttpError(400, "invalid_request", "latex must be an object or null");
          }
          patch.latex = input.latex as Parameters<typeof store.updateProject>[1]["latex"];
        }
        /**
         * THE GENERIC ARM. `plugins: { "<id>": {…} | null }` — one entry per
         * plugin, `null` to turn it off, and no new arm per feature again. The
         * settings blob is validated by the PLUGIN that owns it: the protocol
         * deliberately does not know what a LaTeX toolchain is.
         */
        if ("plugins" in input) {
          if (!input.plugins || typeof input.plugins !== "object" || Array.isArray(input.plugins)) {
            throw new HttpError(400, "invalid_request", "plugins must be an object");
          }
          const entries = input.plugins as Record<string, unknown>;
          for (const [id, value] of Object.entries(entries)) {
            if (value === null) continue;
            if (typeof value !== "object" || Array.isArray(value)) {
              throw new HttpError(400, "invalid_request", `plugins.${id} must be an object or null`);
            }
            const config = value as { enabled?: unknown; settings?: unknown };
            if (typeof config.enabled !== "boolean") {
              throw new HttpError(400, "invalid_request", `plugins.${id}.enabled must be a boolean`);
            }
            const module = pluginHost.ready(id);
            if (module?.settingsSchema && config.settings !== undefined) {
              const parsed = module.settingsSchema.safeParse(config.settings);
              if (!parsed.success) {
                throw new HttpError(400, "invalid_request", `plugins.${id}.settings is not valid for ${id}`);
              }
            }
          }
          patch.plugins = entries as Parameters<typeof store.updateProject>[1]["plugins"];
        }
        const project = store.updateProject(decodeURIComponent(projectPatch[1]), patch);
        /**
         * DISABLE MEANS DRAIN. A plugin the write turned OFF stops accepting new
         * work now, finishes what is running, and gives its resources back once
         * `busy` reports false. Nothing running is cancelled — that is a
         * separate, explicit user action.
         */
        if (patch.plugins) {
          const { plugins: after } = readProjectPlugins(project);
          for (const pluginId of Object.keys(patch.plugins)) {
            if (pluginEnabled(after, pluginId)) pluginHost.cancelDrain(pluginId, project.id);
            else void pluginHost.drainProject(pluginId, project.id);
          }
        }
        writeJson(response, 200, { project });
        return;
      }
      /**
       * REMOVE. A DELETE on the registration, NOT on the project: the checkout,
       * its worktrees, its sessions' journals and their browser profiles are
       * all untouched, and the registration RECORD is kept and marked rather
       * than deleted — so restoring gives back the same id and settings.
       * `sessions` in the answer is how many session records now belong to a
       * put-away project; the surface says so rather than the engine tidying
       * them away.
       */
      if (request.method === "DELETE" && projectPatch) {
        writeJson(response, 200, store.unregisterProject(decodeURIComponent(projectPatch[1])));
        return;
      }
      /** Put a removed project back: same id, same settings, same sessions. */
      const projectRestore = /^\/v2\/projects\/([^/]+)\/restore$/.exec(url.pathname);
      if (request.method === "POST" && projectRestore) {
        writeJson(response, 200, { project: store.restoreProject(decodeURIComponent(projectRestore[1])) });
        return;
      }
      /**
       * INSTALL AND REMOVE A PLUGIN FOLDER (plugins/external/installer.ts).
       * Before the machine door below, whose pattern `/v2/plugins/<id>/<verb>`
       * would otherwise read `installed` as a plugin id — which is why no
       * plugin may take that id.
       */
      if (request.method === "POST" && url.pathname === "/v2/plugins/installed") {
        const parsed = PluginInstallInput.safeParse(await body(request));
        if (!parsed.success) throw new HttpError(400, "invalid_request", "path must be a folder and mode copy or link");
        let loaded: LoadedExternalPlugin;
        try {
          loaded = installPluginFolder(pluginsDir, parsed.data.path, parsed.data.mode, {
            ids: new Set([...BUNDLED_RESERVATIONS.ids, ...installedPlugins.keys()]),
            prefixes: new Set([...BUNDLED_RESERVATIONS.prefixes, ...installedPrefixes()]),
          });
        } catch (error) {
          if (error instanceof PluginInstallError) throw new HttpError(400, "invalid_request", error.message);
          throw error;
        }
        installedPlugins.set(loaded.manifest.id, loaded);
        syncInstalledTools();
        writeJson(response, 200, { plugin: await pluginHost.add(externalModule(loaded)) });
        return;
      }
      const uninstallPath = /^\/v2\/plugins\/installed\/([a-z][a-z0-9-]*)$/.exec(url.pathname);
      if (request.method === "DELETE" && uninstallPath) {
        const id = uninstallPath[1]!;
        const folder = installedPlugins.get(id)?.dir ?? refusedFolders.get(id);
        if (!folder) throw new HttpError(404, "not_found", `no installed plugin ${id}`);
        // Stopped first, so its process is gone before its folder is.
        await pluginHost.remove(id);
        installedPlugins.delete(id);
        refusedFolders.delete(id);
        syncInstalledTools();
        removePluginFolder(pluginsDir, path.basename(folder));
        writeJson(response, 200, { removed: true });
        return;
      }
      /**
       * A PLUGIN'S PROJECT AND MACHINE VERBS — environments, packages,
       * distributions, toolchains, installers and their jobs. They live in each
       * plugin's `projectRoutes` / `machineRoutes` table (see
       * `plugins/routes.ts`) and are served here at
       *
       *   /v2/projects/:id/plugins/<plugin>/<verb>   gated on Mac and project
       *   /v2/plugins/<plugin>/<verb>                gated on Mac
       */
      const projectPluginPath = /^\/v2\/projects\/([^/]+)\/plugins\/([a-z][a-z0-9-]*)\/([A-Za-z0-9_.%-]+(?:\/[A-Za-z0-9_.%-]+)*)$/.exec(url.pathname);
      if (projectPluginPath) {
        const [, projectId, pluginId, verb] = projectPluginPath as unknown as [string, string, string, string];
        await servePluginScoped({ pluginId, scope: "project", projectId: decodeURIComponent(projectId), verb }, request, url, response);
        return;
      }
      const machinePluginPath = /^\/v2\/plugins\/([a-z][a-z0-9-]*)\/([A-Za-z0-9_.%-]+(?:\/[A-Za-z0-9_.%-]+)*)$/.exec(url.pathname);
      if (machinePluginPath) {
        const [, pluginId, verb] = machinePluginPath as unknown as [string, string, string];
        await servePluginScoped({ pluginId, scope: "machine", verb }, request, url, response);
        return;
      }
      /**
       * THE OLD PATHS, NOW ALIASES. `/v2/projects/:id/{data-science,latex}/*`
       * and `/v2/{data-science,latex}/*` are what the web settings pages and
       * a released client call; they forward to the same tables ungated and
       * unrelabelled, so their behaviour is unchanged. A verb neither table
       * has falls through, exactly as an unmatched path always did.
       */
      const legacyProjectPlugin = /^\/v2\/projects\/([^/]+)\/(data-science|latex)\/([^/]+(?:\/[^/]+)*)$/.exec(url.pathname);
      if (
        legacyProjectPlugin &&
        (await servePluginScoped(
          { pluginId: legacyProjectPlugin[2]!, scope: "project", projectId: decodeURIComponent(legacyProjectPlugin[1]!), verb: legacyProjectPlugin[3]!, legacy: true },
          request,
          url,
          response,
        ))
      ) {
        return;
      }
      const legacyMachinePlugin = /^\/v2\/(data-science|latex)\/([^/]+(?:\/[^/]+)*)$/.exec(url.pathname);
      if (
        legacyMachinePlugin &&
        (await servePluginScoped({ pluginId: legacyMachinePlugin[1]!, scope: "machine", verb: legacyMachinePlugin[2]!, legacy: true }, request, url, response))
      ) {
        return;
      }
      /**
       * CLONE, THEN REGISTER — and it is one route because the cockpit cannot
       * name the path in between. It sends a URL and the parent folder somebody
       * picked; only the engine knows what directory `git clone` created.
       *
       * ABOVE `POST /v2/projects` in this chain purely so the literal comparison
       * below never has to think about a sub-path. No streaming progress: the
       * answer is the registered project or a sentence saying why not.
       */
      if (request.method === "POST" && url.pathname === "/v2/projects/clone") {
        const input = await body(request);
        writeJson(response, 201, {
          project: await store.cloneProject({
            url: stringValue(input.url, "repository url")!,
            parent: stringValue(input.parent, "parent folder")!,
            ...(input.name === undefined ? {} : { name: stringValue(input.name, "project name")! }),
          }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/projects") {
        const input = await body(request);
        writeJson(response, 201, {
          project: store.registerProject({
            id: stringValue(input.id, "project id", true),
            name: stringValue(input.name, "project name")!,
            root: stringValue(input.root, "project root")!,
          }),
        });
        return;
      }
      /**
       * The user's MCP servers. NOT under a project or a session, because they
       * are not scoped to one — a tool server is configured once for the
       * environment and every session on it gets the enabled ones.
       */
      /**
       * TWO SCOPES, TWO ROUTE SHAPES, and the URL says which one you are in.
       * `/v2/mcp-servers` is the machine's; `/v2/projects/:id/mcp-servers` is
       * one repository's. Hanging the project scope off a query parameter would
       * have made "all of them" and "the global ones" the same request, which is
       * how a delete ends up in the wrong scope.
       */
      if (request.method === "GET" && url.pathname === "/v2/mcp-servers") {
        writeJson(response, 200, { mcpServers: store.listMcpServers({ projectId: null }) });
        return;
      }
      const projectMcp = /^\/v2\/projects\/([^/]+)\/mcp-servers(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
      const globalMcp = /^\/v2\/mcp-servers\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (projectMcp && request.method === "GET" && projectMcp[2] === undefined) {
        const projectId = decodeURIComponent(projectMcp[1]);
        writeJson(response, 200, {
          mcpServers: store.listMcpServers({ projectId }),
          // The merge this project's sessions actually run with, answered by
          // the engine rather than re-derived by the page — so the surface that
          // EXPLAINS the shadowing cannot disagree with the one that performs it.
          effective: resolveMcpServers(store.listMcpServers(), projectId),
        });
        return;
      }
      const mcpSlot = projectMcp?.[2] !== undefined ? { id: projectMcp[2], projectId: decodeURIComponent(projectMcp[1]) } : globalMcp ? { id: globalMcp[1] } : undefined;
      if (mcpSlot && (request.method === "PUT" || request.method === "DELETE")) {
        const id = decodeURIComponent(mcpSlot.id);
        const scope = mcpSlot.projectId === undefined ? {} : { projectId: mcpSlot.projectId };
        if (request.method === "DELETE") {
          writeJson(response, 200, { removed: store.removeMcpServer(id, mcpSlot.projectId) });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          mcpServer: store.saveMcpServer({
            id,
            ...scope,
            ...(input.label === undefined ? {} : { label: stringValue(input.label, "mcp server label")! }),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            spec: input.spec,
          }),
        });
        return;
      }
      /**
       * The configured logins — the account registry.
       *
       * THE LIST AND THE PROBE ARRIVE TOGETHER because a settings page needs
       * both to render one row, and two round trips would let it paint a green
       * dot beside an instance the second call is about to call missing.
       *
       * SENSITIVE ENVIRONMENT VALUES NEVER COME BACK. `listProviderInstances`
       * is the redacting read; the store keeps the only unredacting one for the
       * worker claim, and it is not reachable from here.
       */
      if (request.method === "GET" && url.pathname === "/v2/provider-instances") {
        const providerInstances = store.listProviderInstances();
        writeJson(response, 200, {
          providerInstances,
          probes: await probeProviders(providerInstances, { force: url.searchParams.get("refresh") === "1" }),
        });
        return;
      }
      /**
       * UPDATE THE CLI BEHIND ONE LOGIN.
       *
       * KEYED ON THE INSTANCE, because a login can now pin its own binary. It
       * was keyed on the driver, on the reasoning that every login of a provider
       * runs the same executable — true until `binaryPath` existed, and the
       * failure would have been the worst kind: pressing Update on the login
       * pinned to a beta build would have updated the DEFAULT install instead,
       * reported success, and left the beta exactly where it was.
       *
       * THE COMMAND IS NOT IN THE REQUEST AND NEVER WILL BE. The body is empty;
       * the instance id is the whole input. `cli-updates.ts` derives what to
       * run from the install it detected on disk. A route that accepted a
       * command string would be a remote shell wearing a settings button — and
       * this daemon is already reachable by anything on the tailnet.
       *
       * THE FRESH PROBES COME BACK WITH IT, forced past both caches, so the
       * pane cannot spend the next minute showing the version it just replaced.
       */
      const providerUpdate = /^\/v2\/provider-updates\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(url.pathname);
      if (providerUpdate && request.method === "POST") {
        const id = decodeURIComponent(providerUpdate[1]!);
        const instance = store.listProviderInstances().find((entry) => entry.id === id);
        if (!instance) throw new HttpError(404, "not_found", `unknown provider instance ${id}`);
        const result = await updateProvider(instance.driver, instance.binaryPath);
        const providerInstances = store.listProviderInstances();
        writeJson(response, 200, { result, providerInstances, probes: await probeProviders(providerInstances, { force: true }) });
        return;
      }
      /**
       * ONE LOGIN'S CURATED MODEL LIST — starred, hidden, ordered, and the ids
       * somebody added because the installed CLI does not publish them yet.
       *
       * NOT ON `/v2/provider-instances/:id`. That PUT is the login's
       * configuration — the folder, the binary, the environment — and it is read
       * on every session claim. This is a chatty preference document where a
       * reorder is a burst of writes, and it belongs behind its own verb in its
       * own file, the same way the provider secrets do.
       *
       * DELIBERATELY DOES NOT 404 ON AN UNCONFIGURED ID, mirroring
       * `resolveProviderInstance`'s permissive stance: refusing would mean a
       * session on a since-deleted instance loses its curation, which is the
       * wrong way round.
       */
      const modelOverlay = /^\/v2\/provider-instances\/([A-Za-z][A-Za-z0-9_-]*)\/models$/.exec(url.pathname);
      if (modelOverlay && (request.method === "GET" || request.method === "PATCH")) {
        const id = decodeURIComponent(modelOverlay[1]);
        if (request.method === "GET") {
          writeJson(response, 200, { overlay: store.getModelOverlay(id) });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          overlay: store.setModelOverlay(id, {
            // Presence, not truthiness — `[]` is "I cleared this list" and is a
            // different request from "I did not touch it".
            ...("favorites" in input ? { favorites: input.favorites } : {}),
            ...("hidden" in input ? { hidden: input.hidden } : {}),
            ...("order" in input ? { order: input.order } : {}),
            ...("custom" in input ? { custom: input.custom } : {}),
            ...("default" in input ? { default: input.default } : {}),
          }),
        });
        return;
      }
      const providerInstance = /^\/v2\/provider-instances\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(url.pathname);
      if (providerInstance && (request.method === "PUT" || request.method === "DELETE")) {
        const id = decodeURIComponent(providerInstance[1]);
        if (request.method === "DELETE") {
          writeJson(response, 200, { removed: store.removeProviderInstance(id) });
          return;
        }
        const input = await body(request);
        const saved = store.saveProviderInstance({
          id,
          // Every field is forwarded VERBATIM, including an explicit `null`:
          // the store owns the three-state rule (clear / keep / set), and a
          // route that coerced null away here would make "remove the accent
          // colour" unexpressible over HTTP.
          ...(input.driver === undefined ? {} : { driver: input.driver }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName as string | null }),
          ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor as string | null }),
          ...(input.contextNoticePercent === undefined ? {} : { contextNoticePercent: input.contextNoticePercent as number | null }),
          ...(input.autoCompact === undefined ? {} : { autoCompact: input.autoCompact }),
          ...(input.configDir === undefined ? {} : { configDir: input.configDir as string | null }),
          ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath as string | null }),
          ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
          ...(input.env === undefined ? {} : { env: input.env }),
          ...(input.carryOverInherited === undefined ? {} : { carryOverInherited: input.carryOverInherited }),
        });
        /**
         * WHAT THIS SAVE STOPPED THE LOGIN INHERITING — #594, and NAMES ONLY.
         *
         * Present only when there is something to say, so a client can treat
         * its presence as the event rather than comparing an empty array. It is
         * on the SAVE rather than on the list because it is a fact about a
         * change: an instance that was already configured lost nothing here.
         *
         * NO VALUE IS IN THIS ANSWER. Three of the names it can carry are
         * credentials, and a response that showed what was about to be lost
         * would be the leak this warning exists to avoid.
         */
        writeJson(response, 200, {
          providerInstance: saved.instance,
          ...(saved.stoppedInheriting.length > 0 ? { stoppedInheriting: saved.stoppedInheriting } : {}),
        });
        return;
      }
      /**
       * EVERY LIVE SESSION, ACROSS PROJECTS, plus the project registry beside
       * it — what `sessions_list` answers with, and the only read in this file
       * that is not scoped to one project or one session.
       *
       * A LITERAL PATH UNDER `/v2/sessions/`, so it must stay ABOVE the
       * `sessionPath` block at the bottom: that regex matches `live` as
       * happily as it matches a session id, and hoisting it would turn this
       * route into "no session by that id".
       */
      /**
       * WHAT THIS MAC ALLOWS, and the machine-level settings behind it.
       *
       * SCOPED TO THIS ENGINE. A cockpit looking at a remote Mac reaches that
       * Mac's daemon, so these reads and writes land on the engine being viewed
       * and never on the one the browser happens to be running beside.
       */
      if (request.method === "GET" && url.pathname === "/v2/plugins") {
        writeJson(response, 200, { plugins: pluginHost.statuses(), machine: store.machinePlugins() });
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/v2/plugins") {
        const input = await body(request);
        if (!input.plugins || typeof input.plugins !== "object" || Array.isArray(input.plugins)) {
          throw new HttpError(400, "invalid_request", "plugins must be an object");
        }
        const entries = input.plugins as Record<string, unknown>;
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) continue;
          if (typeof value !== "object" || Array.isArray(value)) {
            throw new HttpError(400, "invalid_request", `plugins.${id} must be an object or null`);
          }
          const config = value as { enabled?: unknown; settings?: unknown };
          if (typeof config.enabled !== "boolean") {
            throw new HttpError(400, "invalid_request", `plugins.${id}.enabled must be a boolean`);
          }
          // THE PLUGIN'S OWN SCHEMA VALIDATES ITS OWN SETTINGS, here as on the
          // project arm. The protocol does not know what a TeX distribution is.
          //
          // THE MACHINE SCHEMA WHEN THERE IS ONE. This arm writes Mac-wide
          // defaults, which are a different shape from a project's — a default
          // engine belongs here and `mainFile` does not. A plugin that declares
          // no machine schema keeps the old behaviour and is checked against its
          // project one.
          const module = pluginHost.ready(id);
          const schema = module?.machineSettingsSchema ?? module?.settingsSchema;
          if (schema && config.settings !== undefined) {
            const parsed = schema.safeParse(config.settings);
            if (!parsed.success) {
              throw new HttpError(400, "invalid_request", `plugins.${id}.settings is not valid for ${id}`);
            }
          }
        }
        const machine = store.updateMachinePlugins(entries as Parameters<typeof store.updateMachinePlugins>[0]);
        /**
         * TURNING A PLUGIN OFF DRAINS IT EVERYWHERE. New work is already refused
         * by the gate; this lets what is running finish and gives resources back
         * when it does. Nothing is killed — the same rule as a project switch.
         */
        for (const [id, value] of Object.entries(entries)) {
          const off = value === null || (value as { enabled?: boolean }).enabled === false;
          for (const project of store.listProjects()) {
            if (off) void pluginHost.drainProject(id, project.id);
            else pluginHost.cancelDrain(id, project.id);
          }
        }
        writeJson(response, 200, { machine });
        return;
      }
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
