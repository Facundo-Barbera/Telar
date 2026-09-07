// The engine owns its loopback listener and the only writable engine state root.
// It intentionally has no provider imports: Phase 1 proves ownership and crash
// semantics before a driver is allowed to execute an agent turn.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  ENGINE_PROTOCOL_VERSION,
  DataScienceBootstrap,
  DataScienceCreateEnvironment,
  LatexBootstrap,
  parseForgeQuery,
  RequestOpenInput,
  ProviderTurnOpenInput,
  SessionTaskReport,
  resolveMcpServers,
  TurnModelSelection,
  WakeKind as WakeKindSchema,
  type WakeKind,
  type EngineDiscovery,
  type EngineErrorCode,
  type EngineHealth,
  type McpOAuthStatus,
  type McpServer,
  type ModelSelection,
  type ProviderDriverKind,
  type RuntimeMode,
  type TurnSubmissionResult,
  type WorkerStatus,
} from "@telar/engine-client";
import { runCliUpdate, type CliUpdateRun } from "./cli-updates";
import { computerUseStatus, grantComputerUseAccess, launchComputerUseHost, openComputerUseHost, resolveComputerUse } from "./computer-use";
import { bearerIsValid } from "./http-auth";
import { beginConnect, checkMcpHealth, completeConnect, NO_CLIENT_STRATEGY, probeMcpAuth } from "./mcp-oauth";
import { createProviderProber, type VersionProbe } from "./provider-instances";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, statePaths, engineRootFromEnv, type EngineNotifier } from "./state";
import { KernelHost } from "./ds/kernel-host";
import { maybeRetitleSession, runStructuredForPolicy } from "./textgen";
import {
  isAppearanceId,
  listImages,
  putImage,
  readImage,
  readLooks,
  readSettings,
  readThemes,
  removeEntry,
  writeLook,
  writeSettings,
  writeTheme,
} from "./appearance-home";
import { readUsageReport, warmUsageScanCache } from "./usage";
import { collectWallTools, ensureSocketSecret, handleSocketMessage, socketConnectCard } from "./spool/socket";
import type { SocketTool } from "./mcp-socket";
import type { SpoolCapability } from "./spool/tools";
import {
  collectSessionsWallTools,
  ensureSessionsSocketSecret,
  handleSessionsSocketMessage,
  sessionsSocketConnectCard,
} from "./sessions-tools/socket";
import type { SessionsCapability } from "./sessions-tools/tools";
import type { GhRunner } from "./github";
import type { AsyncGitRunner } from "./worktree";
import type { DriverSelector } from "./worker";

type RegisteredWorker = { workerId: string; registeredAt: number; heartbeatAt: number };

export type EngineDaemonOptions = {
  engineRoot?: string;
  port?: number;
  now?: () => number;
  /** Worker liveness is deliberately short, but a lost running process remains ambiguous rather than replayed. */
  workerLeaseMs?: number;
  /** Testable cadence for pruning workers that can no longer heartbeat. */
  workerPruneIntervalMs?: number;
  /**
   * Told when an approval parks with nobody watching. ABSENT MEANS NOBODY IS
   * TOLD, and the request records that honestly rather than claiming otherwise.
   */
  notifier?: EngineNotifier;
  /**
   * How the engine reaches GitHub. INJECTED for the reason every other
   * subprocess here is: a route test that drives `/v2/spool/look` must never
   * actually spend somebody's rate limit. The default shells to the real `gh`.
   */
  gh?: GhRunner;
  asyncGit?: AsyncGitRunner;
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
  embeddedWorker?: boolean | { workerId?: string; pollMs?: number; createDriver?: () => Promise<DriverSelector> | DriverSelector };
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
};

export type EngineDaemon = {
  discovery: EngineDiscovery;
  store: EngineStore;
  /** Present only when `embeddedWorker` was requested. The id is the CURRENT
   *  registration's — it changes when the worker re-registers after lease loss. */
  worker?: { readonly workerId: string };
  close(): Promise<void>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: EngineErrorCode,
    message: string,
    /**
     * ANSWER, THEN HANG UP. Set by a refusal that did NOT read the request
     * body — the oversize guard, which is the whole point of refusing early.
     * Keep-alive assumes the socket is clean between messages; one still
     * carrying megabytes the server never drained is not, and the client's
     * NEXT request on it waits for a reply that can never arrive. So the
     * refusal that skipped the body also ends the connection that held it.
     */
    readonly endConnection = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function errorFor(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof EngineStateError) {
    return new HttpError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400, error.code, error.message);
  }
  return new HttpError(500, "internal_error", "engine encountered an internal error");
}

function writeJson(response: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new HttpError(400, "invalid_request", "request body is too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new HttpError(400, "invalid_request", "request body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request", "request body is invalid JSON");
  }
}

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

/** `If-None-Match` as clients actually send it: a list, possibly weak-tagged,
 *  possibly `*`. Only equality against our own strong tag matters here. */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  return raw
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

function stringValue(value: unknown, label: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", `${label} must be a string`);
  return value;
}

/**
 * THE ONE PLACE A ROUTE READS "TODAY" — and it never reads a clock to get it.
 * §3.2-as-amended: a comparison against today requires the CALLER to state
 * one; `?today=YYYY-MM-DD` is that statement, freshly introduced by the lobby
 * and the brief (no earlier spool route took a query param at all). Absent is
 * the honest "the caller sent none" — the composition degrades rather than
 * substituting `new Date()`.
 */
function todayParam(url: URL): string | undefined {
  const raw = url.searchParams.get("today");
  if (raw === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, "invalid_request", `today must be YYYY-MM-DD — got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

function sessionPath(pathname: string): { sessionId: string; tail: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), tail: match[2] ?? "" };
}

type TurnAction = "running" | "observe" | "request" | "complete" | "fail" | "discard" | "promote" | "steer-ack";

function turnPath(pathname: string): { sessionId: string; runId: string; action: TurnAction } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\/(running|observe|request|complete|fail|discard|promote|steer-ack)$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]), action: match[3] as TurnAction };
}

/** `POST /v2/sessions/:id/requests/:requestId` — a human answering. */
function requestPath(pathname: string): { sessionId: string; requestId: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/requests\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), requestId: decodeURIComponent(match[2]) };
}

/** `DELETE /v2/subscriptions/:id` — top-level, because a subscription spans
 *  two sessions and belongs to neither path. */
function subscriptionPath(pathname: string): { subscriptionId: string } | undefined {
  const match = /^\/v2\/subscriptions\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return undefined;
  return { subscriptionId: decodeURIComponent(match[1]) };
}

/**
 * What each http server's sign-in looks like right now.
 *
 * TWO PROBES PER SERVER, CONCURRENTLY, and neither can fail the request. The
 * first asks whether the server WANTS OAuth; the second asks whether the
 * credential we hold actually WORKS. They are separate because their answers
 * demand different things of the reader — "sign in" versus "the server is
 * down" — and a row that collapsed them would send people to fix the wrong one.
 *
 * `stdio` SERVERS ARE OMITTED, not reported as unauthenticated: a local
 * subprocess has no sign-in and never will, so a row for it would be a
 * permanently empty state.
 *
 * NEVER THROWS. A settings page must render when the network is down.
 */
async function mcpOAuthStatuses(store: EngineStore, servers: McpServer[]): Promise<McpOAuthStatus[]> {
  return Promise.all(
    servers
      .filter((server) => server.spec.transport !== "stdio")
      .map(async (server): Promise<McpOAuthStatus> => {
        const url = server.spec.transport === "stdio" ? "" : server.spec.url;
        const record = store.getMcpOAuthRecord(server.id, server.projectId);
        // Probe AS US when we hold a grant, anonymously otherwise — an
        // anonymous probe of a connected server would report `needs-auth` and
        // offer to fix something that is not broken.
        const token = record?.tokens.accessToken || undefined;
        const [requiresOAuth, health] = await Promise.all([
          probeMcpAuth(url).then((result) => result.requiresOAuth),
          checkMcpHealth(url, {
            ...(token ? { token } : {}),
            ...(server.spec.transport === "stdio" || !server.spec.headers ? {} : { headers: server.spec.headers }),
          }),
        ]);
        return {
          serverId: server.id,
          ...(server.projectId === undefined ? {} : { projectId: server.projectId }),
          requiresOAuth,
          connected: Boolean(token),
          ...(record?.tokens.expiresAt === undefined ? {} : { expiresAt: record.tokens.expiresAt }),
          ...(record?.tokens.scope ? { scope: record.tokens.scope } : {}),
          ...(record?.as.issuer ? { issuer: record.as.issuer } : {}),
          health,
        };
      }),
  );
}

function writeDiscovery(store: EngineStore, discovery: EngineDiscovery): void {
  // This capability document includes the bearer token and must remain private
  // even on a single-user laptop. `writeFileSync` via atomic state storage is
  // intentionally duplicated here only because engine.json is not a user data
  // document and is created after the socket is known.
  const file = store.paths.engine;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(discovery, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  const store = new EngineStore(root, options.now, {
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.asyncGit ? { asyncGit: options.asyncGit } : {}),
    // Telar's computer-use backend (cua-driver, or Sky), resolved per claim so
    // installing or removing a driver applies to the next turn. Injected here,
    // not defaulted in the store, so tests never read the real machine. The
    // first claim that resolves also wakes the Sky host app if that is the
    // backend — cua self-launches — once per daemon, in the background.
    computerUse: () => {
      const resolved = resolveComputerUse();
      if (resolved) launchComputerUseHost();
      return resolved;
    },
  });
  const lock = acquireDaemonLock(statePaths(root));
  /** The per-transcript parse cache behind /v2/usage — beside the rates
   *  snapshot it prices with. See usage.ts. */
  const usageScanCachePath = path.join(store.paths.root, "usage-scan-cache.json");
  const daemonId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const startedAt = (options.now ?? Date.now)();
  const workers = new Map<string, RegisteredWorker>();
  // Only the registration established by our own supervisor gets process-lifetime
  // ownership. An HTTP client cannot opt into this by choosing a worker id.
  let embeddedRegistration: RegisteredWorker | undefined;
  const now = options.now ?? Date.now;
  const workerLeaseMs = options.workerLeaseMs ?? 15_000;
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
    ((driver: ProviderDriverKind, binaryPath: string | undefined) => runCliUpdate(driver, { ...(binaryPath ? { binaryPath } : {}) }));
  const pruneWorkers = (): void => {
    const expired = [...workers.values()].filter((worker) => worker !== embeddedRegistration && now() - worker.heartbeatAt > workerLeaseMs);
    for (const worker of expired) {
      workers.delete(worker.workerId);
      store.recoverInactiveWorker(worker.workerId);
    }
  };
  const activeWorker = (workerId: string): RegisteredWorker => {
    pruneWorkers();
    const worker = workers.get(workerId);
    if (!worker) throw new HttpError(503, "worker_unavailable", "worker is not registered or its lease expired");
    return worker;
  };
  const workerPruner = setInterval(pruneWorkers, options.workerPruneIntervalMs ?? Math.max(10, Math.floor(workerLeaseMs / 3)));
  workerPruner.unref();

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
  });

  /**
   * THE SOCKET'S SECRET AND TOOLS, both lazy: nothing is minted or assembled
   * until something asks — the connect card or a client's first request — so a
   * daemon nothing connects to writes nothing extra to disk.
   */
  let socketSecretCache: string | undefined;
  const socketSecret = () => (socketSecretCache ??= ensureSocketSecret(store.spool));
  let socketToolsCache: SocketTool[] | undefined;
  const socketTools = (): SocketTool[] => {
    if (socketToolsCache) return socketToolsCache;
    /**
     * THE WALL AT MASTER SCOPE — every capability lands on the store's own
     * facade, the same methods the HTTP routes call, so there is exactly one
     * implementation of every rule about an item. No `project` key: the
     * socket is the user's own outward door and sees every subject, like the
     * master chat. The wall's absences ride along whole: close, reopen,
     * accept, delete and lane structure are not on the wall, so no client of
     * this socket can reach them — asserted in `spool-socket.test.ts`.
     */
    const capability: SpoolCapability = {
      snapshot: async () => store.spoolSnapshot(),
      item: async (id) => {
        try {
          return store.spoolItem(id);
        } catch {
          return null;
        }
      },
      create: async (input) => store.createSpoolItem(input),
      update: async (id, patch) => store.updateSpoolItem(id, patch),
      consult: (id) => store.consultSpoolExpert(id),
      map: async () => store.spoolMap(),
      openThread: async (subject, input) => store.openSpoolThread(subject, input),
      setWaiting: async (subject, threadId, waiting) => store.setSpoolThreadWaiting(subject, threadId, waiting),
      settle: async (subject, threadId, answer) => store.settleSpoolThread(subject, threadId, answer),
      answer: async (itemId, question, answer) => store.answerSpoolQuestion(itemId, question, answer),
      focus: async () => ({ pickup: store.spoolPickup(), days: store.spoolFocusDays() }),
      setFocus: async (input) => store.openSpoolFocus(input),
      endFocus: async (id, end) => store.closeSpoolFocus(id, end),
      look: (subjectKey) => store.reconcileSpoolLook(subjectKey),
      setTerrain: async (subjectKey, terrain) => store.setSpoolSubjectTerrain(subjectKey, terrain),
      setIdentity: async (subjectKey, patch) => store.setSpoolSubjectIdentity(subjectKey, patch),
      setAperture: async (view) => store.setSpoolAperture(view),
      setAreaPermits: async (name, ceiling) => store.setSpoolAreaCeiling(name, ceiling),
      notes: async () => store.spoolNotes(),
      // The wall's handler declares `author: "session"`; the arm below is the
      // same default the human route keeps, so an absent declaration is a hand.
      createNote: async (input) => store.createSpoolNote({ ...input, author: input.author === "session" ? "session" : "you" }),
      updateNote: async (id, patch) => store.updateSpoolNote(id, patch),
      search: async (query, subject) => store.spoolSearch(query, subject ? { subject } : {}),
    };
    socketToolsCache = collectWallTools(capability);
    return socketToolsCache;
  };

  /**
   * THE SESSIONS SOCKET'S SECRET AND TOOLS, lazy for the same reason and minted
   * SEPARATELY from the spool's: two doors, two keys.
   */
  let sessionsSecretCache: string | undefined;
  const sessionsSecret = () => (sessionsSecretCache ??= ensureSessionsSocketSecret(store.paths));
  let sessionsToolsCache: SocketTool[] | undefined;
  const sessionsSocketTools = (): SocketTool[] => {
    if (sessionsToolsCache) return sessionsToolsCache;
    /**
     * EVERY MEMBER DELEGATES TO A `store.*` METHOD THAT ALREADY EXISTS, exactly
     * as the spool socket's capability does. There is no validation here and
     * there must not be: `createSession` owns the env-mode rule and the
     * driver check; `submitTurn` owns the backlog cap; `readEvents` owns the
     * cursor check. A check written at this seam would protect the socket
     * and nothing else.
     *
     * `origin: "session"` IS DECLARED BY THIS CODE, never by a caller: no tool
     * shape on the wall carries it. It is the same construction the spool's
     * `source: "session"` uses — provenance a list can show, nothing more.
     */
    const capability: SessionsCapability = {
      // NO `self`: a chat client on this socket is not a session and has
      // nowhere to be woken. The subscription tools refuse, in words.
      list: async () => store.liveSessions(),
      create: async (input) => store.createSession({ ...input, origin: "session" }),
      send: async (sessionId, input) => store.submitTurn(sessionId, input),
      read: async (sessionId, after) => store.readEvents(sessionId, after),
      status: async (sessionId) => ({ session: store.getSession(sessionId), turns: store.turns(sessionId) }),
      stop: async (sessionId) => store.stopTurn(sessionId),
      settle: async (sessionId, settled) => store.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" }),
      diff: async (sessionId) => await store.sessionDiffAsync(sessionId),
      subscribe: async (subscriber, input) => store.subscribe(subscriber, input),
      unsubscribe: async (id, subscriber) => store.unsubscribe(id, subscriber),
      subscriptions: async (subscriber) => store.subscriptionsFor(subscriber),
      requests: async (sessionId) => store.requests(sessionId),
      resolveRequest: async (sessionId, requestId, input) => store.resolveRequest(sessionId, requestId, { ...input, resolvedBy: "session" }),
    };
    sessionsToolsCache = collectSessionsWallTools(capability);
    return sessionsToolsCache;
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      /**
       * THE OUTWARD MCP SOCKET — before the bearer check, because its auth is
       * DELIBERATELY NOT the management token: this endpoint answers to its
       * own dedicated secret and to nothing else, in both directions — the
       * engine token does not open the socket, and a leaked socket secret
       * opens no other route (every other path still demands the bearer
       * above). Streamable HTTP, stateless, tools only: POST carries one
       * JSON-RPC message; GET (the server-initiated stream) is declined 405,
       * which the protocol permits; DELETE has no session to end and says so
       * with a 200.
       */
      if (url.pathname === "/v2/spool/mcp") {
        if (!bearerIsValid(request.headers.authorization, socketSecret())) {
          writeJson(response, 401, { error: { code: "engine_unauthorized", message: "the spool socket answers to its own secret — see /v2/spool/mcp-info" } });
          return;
        }
        if (request.method === "POST") {
          const message = await body(request);
          const answer = await handleSocketMessage(socketTools(), message);
          if (answer === undefined) {
            response.writeHead(202).end();
            return;
          }
          writeJson(response, 200, answer);
          return;
        }
        if (request.method === "DELETE") {
          writeJson(response, 200, {});
          return;
        }
        writeJson(response, 405, { error: { code: "invalid_request", message: "the spool socket is POST-only — it keeps no stream open" } });
        return;
      }
      /**
       * THE SESSIONS SOCKET — beside the spool's, and before the bearer check
       * for the identical reason: it answers to its OWN secret in both
       * directions. The engine token does not open it, and its secret opens no
       * other route — including, deliberately, the archive and delete verbs,
       * which stay a person's: a chat client that could archive a session
       * could erase another agent's work.
       *
       * IT MUST STAY ABOVE `sessionPath`, which would otherwise read
       * `/v2/sessions/mcp` as a session whose id is "mcp" and answer 404. That
       * is only true because the literal arms sit here; hoisting `sessionPath`
       * breaks this and the two routes below it.
       */
      if (url.pathname === "/v2/sessions/mcp") {
        if (!bearerIsValid(request.headers.authorization, sessionsSecret())) {
          writeJson(response, 401, {
            error: { code: "engine_unauthorized", message: "the sessions socket answers to its own secret — see /v2/sessions/mcp-info" },
          });
          return;
        }
        if (request.method === "POST") {
          const message = await body(request);
          const answer = await handleSessionsSocketMessage(sessionsSocketTools(), message);
          if (answer === undefined) {
            response.writeHead(202).end();
            return;
          }
          writeJson(response, 200, answer);
          return;
        }
        if (request.method === "DELETE") {
          writeJson(response, 200, {});
          return;
        }
        writeJson(response, 405, { error: { code: "invalid_request", message: "the sessions socket is POST-only — it keeps no stream open" } });
        return;
      }
      if (!bearerIsValid(request.headers.authorization, token)) {
        throw new HttpError(401, "engine_unauthorized", "engine authentication failed");
      }
      if (request.method === "GET" && url.pathname === "/v2/health") {
        writeJson(response, 200, health());
        return;
      }
      /**
       * A provider's models. NOT project-scoped: a catalogue describes an
       * installed harness, and every project on this machine sees the same one.
       */
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
      if (request.method === "GET" && url.pathname === "/v2/projects") {
        writeJson(response, 200, { projects: store.listProjects() });
        return;
      }
      /**
       * The inbox's standing rule. Not under a session, because it is not about
       * one: it decides how EVERY session bands, which is why it is a document
       * of the environment rather than a field on each record.
       */
      if (url.pathname === "/v2/inbox" && (request.method === "GET" || request.method === "PATCH")) {
        if (request.method === "GET") {
          writeJson(response, 200, { inbox: store.getInboxPolicy() });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          inbox: store.setInboxPolicy({
            // PRESENT-BUT-NULL IS THE OFF SWITCH, so `in` rather than a
            // truthiness test: `null` and "not mentioned" are different
            // requests and JSON can only tell them apart by the key.
            ...("autoSettleAfterHours" in input ? { autoSettleAfterHours: input.autoSettleAfterHours } : {}),
          }),
        });
        return;
      }
      /**
       * What a session is created with when the caller didn't say. A document
       * of the environment, like the inbox rule above — and read on the create
       * path, so every client that stays quiet builds the same thing.
       */
      if (url.pathname === "/v2/session-defaults" && (request.method === "GET" || request.method === "PATCH")) {
        if (request.method === "GET") {
          writeJson(response, 200, { sessionDefaults: store.getSessionDefaults() });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          sessionDefaults: store.setSessionDefaults({
            ...("envMode" in input ? { envMode: input.envMode } : {}),
          }),
        });
        return;
      }
      /**
       * Where each project group sits in the rail. A document of the
       * environment, like the two above: one arrangement for every client that
       * reads this engine, so a drag on the desktop is where the phone finds
       * the group too.
       */
      if (url.pathname === "/v2/sidebar-layout" && (request.method === "GET" || request.method === "PATCH")) {
        if (request.method === "GET") {
          writeJson(response, 200, { layout: store.getSidebarLayout() });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          layout: store.setSidebarLayout({
            ...("projectOrder" in input ? { projectOrder: input.projectOrder } : {}),
          }),
        });
        return;
      }
      /**
       * COMPUTER USE, MEASURED. The GET runs one real read-only call through
       * the Sky client, because that is the only honest answer to "is the
       * Automation grant in place" — and when the grant is still undecided,
       * that same call is what makes macOS show its own prompt, which names
       * the responsible app better than this daemon can from the inside.
       * The POST wakes the host app the client drives.
       */
      if (request.method === "GET" && url.pathname === "/v2/computer-use") {
        writeJson(response, 200, { computerUse: await computerUseStatus() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/computer-use/host") {
        openComputerUseHost();
        writeJson(response, 200, { ok: true });
        return;
      }
      // cua's native granting flow — CuaDriver.app requests Accessibility +
      // Screen Recording, attributed to itself. Sky has no such command (its
      // probe is the grant), so this reports what it did.
      if (request.method === "POST" && url.pathname === "/v2/computer-use/grant") {
        writeJson(response, 200, grantComputerUseAccess());
        return;
      }
      /**
       * Spend over time, folded from the journals on demand. The window is the
       * client's (epoch ms), the zone names how days are cut; both validated
       * here because a NaN window would silently bucket nothing.
       */
      if (request.method === "GET" && url.pathname === "/v2/usage") {
        const sinceMs = Number(url.searchParams.get("since"));
        const untilMs = Number(url.searchParams.get("until"));
        if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) {
          throw new HttpError(400, "invalid_request", "usage needs a since/until window in epoch milliseconds");
        }
        const resolution = url.searchParams.get("resolution") === "hour" ? "hour" : "day";
        const timeZone = url.searchParams.get("tz")?.trim() || "UTC";
        writeJson(response, 200, {
          usage: await readUsageReport(
            { sinceMs, untilMs, resolution, timeZone },
            { ratesCachePath: path.join(store.paths.root, "usage-model-rates.json"), scanCachePath: usageScanCachePath },
          ),
        });
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
          if (matchesEtag(request.headers["if-none-match"], etag)) {
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
       * THE SPOOL — the item store behind SPEC-organization-workspace.
       *
       * NOT UNDER A PROJECT, and that is the module's premise rather than a
       * routing convenience: an item's project is an OPTIONAL field on it, and
       * absent means floating, which is a valid resting state. A
       * `/v2/projects/:id/spool` shape would make the one thing the store is for
       * — holding work that has not been placed yet — unaddressable. A
       * project-scoped view is a filter over `rows`, not a different endpoint.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool") {
        writeJson(response, 200, store.spoolSnapshot());
        return;
      }
      /**
       * The Spool's master chat, ensured.
       *
       * A GET THAT MAY CREATE, which is unusual enough to justify: the master is
       * a SINGLETON front door, so "get me the master" and "make one if there
       * has never been one" are the same request from the caller's side, and
       * splitting them would make every client do the two-step. It is
       * idempotent — a second call returns the first one's session — which is
       * the property that actually matters here.
       */
      if (url.pathname === "/v2/spool/night") {
        if (request.method === "GET") {
          writeJson(response, 200, { night: store.spoolNight() });
          return;
        }
        if (request.method === "POST") {
          /**
           * STARTS THE NIGHT AND ANSWERS AT ONCE, with the plan it intends to
           * work. It used to await the whole run, and a live night proved that
           * wrong inside one attempt: five minutes in, the caller's HTTP client
           * gave up and reported the engine unreachable while the daemon
           * happily finished every job. Progress is read from `GET` — the record
           * is on disk after each job, so that read is always current.
           *
           * IT REFUSES WHILE A PERSON IS WORKING rather than standing down one
           * job in. Starting a run that immediately halts would burn the plan
           * and write a stopped record for no reason.
           */
          if (store.humanActive()) {
            writeJson(response, 200, {
              night: null,
              refused: "A turn is running, so the night stood down rather than competing for the account.",
            });
            return;
          }
          const input = await body(request).catch(() => ({}) as Record<string, unknown>);
          writeJson(
            response,
            200,
            store.startSpoolNight({
              ...(typeof input.maxJobs === "number" ? { maxJobs: input.maxJobs } : {}),
              ...(typeof input.maxCostUsd === "number" ? { maxCostUsd: input.maxCostUsd } : {}),
            }),
          );
          return;
        }
      }
      /**
       * WHAT THE SPOOL IS DOING RIGHT NOW. `GET` is the whole surface; `DELETE`
       * on one id stops that pass. There is no `POST` — work is begun by the
       * verb that spends the money (a consultation, a night), never by asking
       * for a record of it.
       */
      /**
       * THE SUBJECTS, RECONCILED ON READ. `GET` derives any that items name and
       * nothing has registered, so this is also how the migration runs — no boot
       * hook, nothing to leave half-done, and it self-heals.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/subjects") {
        writeJson(response, 200, { subjects: store.spoolSubjects() });
        return;
      }
      /**
       * THE LOBBY — mission control, ranked, never enumerated (§13.2). A pure
       * composition over what the routes above already serve: no store write,
       * no `gh` run, no model call. `?today=YYYY-MM-DD` is optional — see
       * `todayParam` — and every today-relative fact simply does not appear
       * without it.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/lobby") {
        writeJson(response, 200, { lobby: store.spoolLobby(todayParam(url)) });
        return;
      }
      /**
       * THE RE-ENTRY BRIEF — a subject's room, opened. Same pull-only,
       * model-free composition as the lobby above, widened to one subject's
       * pickup, threads, stored look, queue rows and notes. `not_found` for a
       * key nothing goes by, the same shape `PATCH .../subjects/:key` uses.
       */
      const spoolSubjectBrief = /^\/v2\/spool\/subjects\/([^/]+)\/brief$/.exec(url.pathname);
      if (request.method === "GET" && spoolSubjectBrief) {
        writeJson(response, 200, {
          brief: store.spoolSubjectBrief(decodeURIComponent(spoolSubjectBrief[1]), todayParam(url)),
        });
        return;
      }
      const spoolSubject = /^\/v2\/spool\/subjects\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolSubject) {
        const input = await body(request);
        /**
         * TERRAIN IS ITS OWN ARM. `null` clears and an object sets — two
         * different requests JSON can only tell apart by the key being present,
         * the same `in` rule the inbox route states. The shape and the
         * repo-address guard live in the store (the wall); a refusal comes back
         * with the store's own sentence.
         */
        if ("terrain" in input) {
          writeJson(response, 200, {
            subject: store.setSpoolSubjectTerrain(
              decodeURIComponent(spoolSubject[1]),
              input.terrain as Parameters<typeof store.setSpoolSubjectTerrain>[1],
            ),
          });
          return;
        }
        /**
         * IDENTITY IS ITS OWN ARM, on the same `in` rule as terrain: `null`
         * clears a field, a value sets it, an absent key leaves it alone —
         * which is what lets one request set `area`, `color` and `rank`
         * together, the way a user states them ("pon casa en Personal, de
         * color mar"), or the way a drag surface states just `rank` alone.
         * The closed color set, the area cap and the rank floor live in the
         * store (the wall); a refusal comes back with the store's own
         * sentence.
         */
        if ("area" in input || "color" in input || "rank" in input) {
          writeJson(response, 200, {
            subject: store.setSpoolSubjectIdentity(decodeURIComponent(spoolSubject[1]), {
              ...("area" in input ? { area: input.area as string | null } : {}),
              ...("color" in input ? { color: input.color as Parameters<typeof store.setSpoolSubjectIdentity>[1]["color"] } : {}),
              ...("rank" in input ? { rank: input.rank as number | null } : {}),
            }),
          });
          return;
        }
        const permits = input.permits;
        if (permits !== "read" && permits !== "draft" && permits !== "propose") {
          writeJson(response, 400, {
            error: `permits must be "read", "draft" or "propose" — got ${JSON.stringify(permits)}.`,
          });
          return;
        }
        // A key nothing goes by throws `not_found` from the store — see
        // `setSpoolSubjectPermits`. Written as a bare `writeJson(404)` first,
        // which dropped the error CODE and made the web adapter report a
        // reachable, answered request as "the engine is unreachable".
        writeJson(response, 200, {
          subject: store.setSpoolSubjectPermits(decodeURIComponent(spoolSubject[1]), permits),
        });
        return;
      }
      /**
       * THE AREAS — the group-level permit ceilings. `GET` lists only the
       * records something was stated on; the area NAMES live on the subjects
       * read, and the web joins the two by `name` (the join-by-key idiom).
       * `PATCH` states a ceiling or withdraws one with `null` — there is no
       * create route (records are minted lazily by the first statement) and no
       * delete route (a cleared, unreferenced area sits harmlessly).
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/areas") {
        writeJson(response, 200, { areas: store.spoolAreas() });
        return;
      }
      const spoolArea = /^\/v2\/spool\/areas\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolArea) {
        const input = await body(request);
        const ceiling = input.ceiling;
        if (ceiling !== null && ceiling !== "read" && ceiling !== "draft" && ceiling !== "propose") {
          throw new HttpError(
            400,
            "invalid_request",
            `ceiling must be "read", "draft", "propose" or null to withdraw it — got ${JSON.stringify(ceiling)}.`,
          );
        }
        writeJson(response, 200, { area: store.setSpoolAreaCeiling(decodeURIComponent(spoolArea[1]), ceiling) });
        return;
      }
      /**
       * THE TAGS — the free-text labels items and notes already carry, given
       * exactly two hand verbs. `GET` is a projection (no tag record on
       * disk); `PATCH .../tags/:from` with `{to}` renames it everywhere,
       * merging onto `to` when that name is already in use. There is no
       * create route (a tag exists the moment something carries it) and no
       * delete route (retagging to `[]` on the row itself is how one goes
       * away).
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/tags") {
        writeJson(response, 200, { tags: store.spoolTags() });
        return;
      }
      const spoolTag = /^\/v2\/spool\/tags\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolTag) {
        const input = await body(request);
        const to = stringValue(input.to, "to");
        if (!to) throw new HttpError(400, "invalid_request", "to is required — the name the tag should read after the rename.");
        writeJson(response, 200, store.renameSpoolTag(decodeURIComponent(spoolTag[1]), to));
        return;
      }
      /**
       * THE APERTURE SLOT — which smart view the wide room is showing. `PUT`
       * because the request replaces the one whole value: idempotent, last
       * writer wins, and the chat's tool and the hand's click share this slot
       * so neither can drift from the other. No history behind it — see
       * `spool/aperture.ts` for why a log of glances is refused.
       */
      if (url.pathname === "/v2/spool/aperture") {
        if (request.method === "GET") {
          writeJson(response, 200, { aperture: store.spoolAperture() });
          return;
        }
        if (request.method === "PUT") {
          const input = await body(request);
          writeJson(response, 200, { aperture: store.setSpoolAperture(input.view) });
          return;
        }
      }
      /**
       * RECONCILE-ON-LOOK — the only route in the engine that reads the world,
       * and it is PULL ONLY: a human's arrival or focus calls it, no timer or
       * webhook exists to. `gh` failing is a 200 whose outcome carries the
       * stale look and an `error` naming why — the room renders its staleness
       * rather than coming down. A subject with no terrain answers with a
       * `note`, because that is an ordinary state and not a fault.
       */
      if (request.method === "POST" && url.pathname === "/v2/spool/look") {
        const input = await body(request);
        const subjectKey = stringValue(input.subjectKey, "subjectKey");
        if (!subjectKey) throw new HttpError(400, "invalid_request", "subjectKey is required — name the subject to look at.");
        writeJson(response, 200, { look: await store.reconcileSpoolLook(subjectKey) });
        return;
      }
      /** The stored looks — what the Spool last saw, honestly stale
       *  (`fresh: false`), with no network read. */
      if (request.method === "GET" && url.pathname === "/v2/spool/looks") {
        writeJson(response, 200, { looks: store.spoolLooks() });
        return;
      }
      /** "Noted" — drains ONE observation. Never deletes; the row stays with
       *  its mark, which is the store's no-delete discipline on the one record
       *  the Spool authors about the world. */
      const spoolLookAck = /^\/v2\/spool\/looks\/([^/]+)\/ack$/.exec(url.pathname);
      if (request.method === "POST" && spoolLookAck) {
        const input = await body(request);
        const observationId = stringValue(input.observationId, "observationId");
        if (!observationId) throw new HttpError(400, "invalid_request", "observationId is required — name the observation being noted.");
        writeJson(response, 200, {
          look: store.acknowledgeSpoolObservation(decodeURIComponent(spoolLookAck[1]), observationId),
        });
        return;
      }
      /** "Noted", in bulk — one digest line's whole group drained in one
       *  gesture. Idempotent per id; the rules live in the store. */
      const spoolLookAckAll = /^\/v2\/spool\/looks\/([^/]+)\/ack-all$/.exec(url.pathname);
      if (request.method === "POST" && spoolLookAckAll) {
        const input = await body(request);
        if (!Array.isArray(input.observationIds) || input.observationIds.some((id) => typeof id !== "string")) {
          throw new HttpError(400, "invalid_request", "observationIds must be an array of observation ids.");
        }
        const { look, acknowledged } = store.acknowledgeSpoolObservations(
          decodeURIComponent(spoolLookAckAll[1]),
          input.observationIds as string[],
        );
        writeJson(response, 200, { look, acknowledged });
        return;
      }
      const spoolLookOne = /^\/v2\/spool\/looks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && spoolLookOne) {
        writeJson(response, 200, { look: store.spoolLook(decodeURIComponent(spoolLookOne[1])) });
        return;
      }
      /** Everything remembered, in one read — retired facts included, because
       *  "dismissing drains" means the record stays legible to the human. */
      if (request.method === "GET" && url.pathname === "/v2/spool/memory") {
        writeJson(response, 200, store.spoolMemory());
        return;
      }
      const spoolFact = /^\/v2\/spool\/memory\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolFact) {
        const input = await body(request);
        const subject = typeof input.subject === "string" ? input.subject : undefined;
        const why = (input.retire as { why?: unknown } | undefined)?.why;
        // A RETIREMENT WITHOUT A REASON IS REFUSED. The reason is the durable
        // half — a drained fact keeps it forever, and a blank one turns the
        // record of why something stopped being true into a shrug.
        if (input.retire !== undefined && (typeof why !== "string" || why.trim() === "")) {
          throw new HttpError(400, "invalid_request", "retire.why is required — say what stopped being true.");
        }
        writeJson(response, 200, {
          fact: store.judgeSpoolFact({
            id: decodeURIComponent(spoolFact[1]),
            ...(subject ? { subject } : {}),
            ...(typeof why === "string" ? { retire: { why } } : {}),
            ...(typeof input.reviewed === "boolean" ? { reviewed: input.reviewed } : {}),
          }),
        });
        return;
      }
      /**
       * THE SHELF — notes beside the items (`docs/spool-loops.md` §10.1).
       * The human API: create defaults the author to "you" exactly as the
       * items route defaults `source`, and only the tool wall's own code ever
       * declares "session". Retire is POST-as-verb like close — a drain with
       * a required reason, never a DELETE.
       */
      if (url.pathname === "/v2/spool/notes" && (request.method === "GET" || request.method === "POST")) {
        if (request.method === "GET") {
          const subject = url.searchParams.get("subject")?.trim() || undefined;
          writeJson(response, 200, { notes: store.spoolNotes(subject) });
          return;
        }
        const input = await body(request);
        writeJson(response, 201, {
          note: store.createSpoolNote({
            title: String(input.title ?? ""),
            body: String(input.body ?? ""),
            ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
            ...(typeof input.subjectKey === "string" && input.subjectKey ? { subjectKey: input.subjectKey } : {}),
            author: input.author === "session" ? "session" : "you",
          }),
        });
        return;
      }
      const spoolNoteRetire = /^\/v2\/spool\/notes\/([^/]+)\/retire$/.exec(url.pathname);
      if (request.method === "POST" && spoolNoteRetire) {
        const input = await body(request);
        writeJson(response, 200, {
          note: store.retireSpoolNote(decodeURIComponent(spoolNoteRetire[1]), String(input.reason ?? "")),
        });
        return;
      }
      const spoolNote = /^\/v2\/spool\/notes\/([^/]+)$/.exec(url.pathname);
      if (spoolNote && (request.method === "GET" || request.method === "PATCH")) {
        const id = decodeURIComponent(spoolNote[1]);
        if (request.method === "GET") {
          writeJson(response, 200, { note: store.spoolNote(id) });
          return;
        }
        // FORWARDED WHOLE, the same rule the item PATCH states: the shelf
        // refuses a forbidden key — `author` above all — by NAME with its
        // sentence, and filtering here would turn that refusal into silence.
        writeJson(response, 200, { note: store.updateSpoolNote(id, await body(request)) });
        return;
      }
      /** THE SEARCH — deterministic and lexical (§10.2). A read; an empty `q`
       *  answers no hits rather than an error, because an empty query is a
       *  search for nothing, honestly answered. */
      if (request.method === "GET" && url.pathname === "/v2/spool/search") {
        const limit = Number(url.searchParams.get("limit") ?? "");
        writeJson(response, 200, {
          hits: store.spoolSearch(url.searchParams.get("q") ?? "", {
            ...(url.searchParams.get("subject") ? { subject: url.searchParams.get("subject")! } : {}),
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          }),
        });
        return;
      }
      /**
       * THE CONNECT CARD — where the outward socket listens and its dedicated
       * secret. BEHIND THE NORMAL BEARER, deliberately: the card mints and
       * reveals the socket's credential, so only something already holding
       * engine access may read it. The composed `claude mcp add` line comes
       * from the engine so the card and the socket cannot disagree.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/mcp-info") {
        const bound = server.address();
        const port = bound && typeof bound === "object" ? bound.port : 0;
        writeJson(response, 200, {
          mcp: socketConnectCard(`http://127.0.0.1:${port}/v2/spool/mcp`, socketSecret()),
        });
        return;
      }
      /**
       * THE MAP — every subject's open questions, in one read.
       *
       * ONE CALL AND NOT ONE PER SUBJECT, the rule `/v2/spool` already states:
       * these are projections of the same items and the same digests, and a
       * client that fetched them separately could draw one subject's weave a
       * tick apart from another's with no way to tell staleness from
       * disagreement.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/threads") {
        writeJson(response, 200, store.spoolMap());
        return;
      }
      const spoolMapSubject = /^\/v2\/spool\/threads\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && spoolMapSubject) {
        writeJson(response, 200, store.spoolThreads(decodeURIComponent(spoolMapSubject[1])));
        return;
      }
      /**
       * MAP THIS SUBJECT — detached, and it answers with the work record rather
       * than the result. The expert route learned this the expensive way: a pass
       * that runs for minutes behind a synchronous POST is a request the client
       * abandons while the daemon keeps spending.
       */
      if (request.method === "POST" && spoolMapSubject) {
        const started = store.startSpoolThreadPass(decodeURIComponent(spoolMapSubject[1]));
        writeJson(response, started.refused ? 200 : 202, started);
        return;
      }
      const spoolThread = /^\/v2\/spool\/threads\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolThread) {
        const subject = decodeURIComponent(spoolThread[1]);
        const threadId = decodeURIComponent(spoolThread[2]);
        const input = await body(request);
        /**
         * A SETTLE WITHOUT AN ANSWER IS REFUSED HERE TOO, the same shape the
         * fact retirement above takes. `settleThread` also refuses it — the
         * store is the wall — but a 400 naming the field is a better answer than
         * a 500 carrying a thrown sentence.
         */
        if (input.settle !== undefined) {
          const answer = (input.settle as { answer?: unknown } | undefined)?.answer;
          if (typeof answer !== "string" || answer.trim() === "") {
            throw new HttpError(
              400,
              "invalid_request",
              "settle.answer is required — settling a thread records what was found out, not that it is over.",
            );
          }
          writeJson(response, 200, { thread: store.settleSpoolThread(subject, threadId, answer) });
          return;
        }
        if (input.reviewed === true) {
          writeJson(response, 200, { thread: store.reviewSpoolThread(subject, threadId) });
          return;
        }
        /** Who the thread is stuck on. Normalisation and the settled refusal
         *  live in the store — the wall — this only shapes the arm. */
        if (input.waiting !== undefined) {
          const waiting = input.waiting as { kind?: unknown; who?: unknown; note?: unknown };
          if (waiting?.kind !== "you" && waiting?.kind !== "agent" && waiting?.kind !== "person") {
            throw new HttpError(400, "invalid_request", 'waiting.kind must be "you", "agent" or "person".');
          }
          writeJson(response, 200, {
            thread: store.setSpoolThreadWaiting(subject, threadId, {
              kind: waiting.kind,
              ...(typeof waiting.who === "string" ? { who: waiting.who } : {}),
              ...(typeof waiting.note === "string" ? { note: waiting.note } : {}),
            }),
          });
          return;
        }
        throw new HttpError(400, "invalid_request", "Send `settle: {answer}`, `reviewed: true` or `waiting: {kind}`.");
      }
      /**
       * OPEN ONE QUESTION from conversation. POST-as-create on the subject's
       * own collection; the pass trigger keeps the parent path, because a pass
       * and a deliberate open are different acts with different costs.
       */
      const spoolThreadOpen = /^\/v2\/spool\/threads\/([^/]+)\/open$/.exec(url.pathname);
      if (request.method === "POST" && spoolThreadOpen) {
        const input = await body(request);
        const question = typeof input.question === "string" ? input.question : "";
        const items = Array.isArray(input.items) ? input.items.filter((i): i is string => typeof i === "string") : [];
        if (!question.trim()) throw new HttpError(400, "invalid_request", "question is required.");
        writeJson(response, 200, {
          thread: store.openSpoolThread(decodeURIComponent(spoolThreadOpen[1]), {
            question,
            items,
            ...(typeof input.handle === "string" ? { handle: input.handle } : {}),
            ...(input.waiting && typeof input.waiting === "object"
              ? { waiting: input.waiting as { kind: "you" | "agent" | "person"; who?: string; note?: string } }
              : {}),
          }),
        });
        return;
      }
      /**
       * SETTLE MANY, each with its own REQUIRED answer — the selection model's
       * settle. A row that cannot take its settle comes back in `refused` with
       * its sentence; only a body that is not even the right shape is a 400.
       */
      const spoolSettleMany = /^\/v2\/spool\/threads\/([^/]+)\/settle-many$/.exec(url.pathname);
      if (request.method === "POST" && spoolSettleMany) {
        const input = await body(request);
        if (
          !Array.isArray(input.settles) ||
          input.settles.some(
            (row) => !row || typeof row !== "object" || typeof (row as { threadId?: unknown }).threadId !== "string",
          )
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            "settles must be an array of {threadId, answer} — every settle records what was found out, per thread.",
          );
        }
        writeJson(
          response,
          200,
          store.settleSpoolThreadsMany(
            decodeURIComponent(spoolSettleMany[1]),
            (input.settles as Array<{ threadId: string; answer?: unknown }>).map((row) => ({
              threadId: row.threadId,
              answer: typeof row.answer === "string" ? row.answer : "",
            })),
          ),
        );
        return;
      }
      /** Move one capture between threads. `to: null` takes it off the map, which
       *  is a resting state the surface draws rather than a hole. */
      if (request.method === "POST" && url.pathname === "/v2/spool/threads-refile") {
        const input = await body(request);
        const subject = typeof input.subject === "string" ? input.subject : "";
        const itemId = typeof input.itemId === "string" ? input.itemId : "";
        if (!subject || !itemId) {
          throw new HttpError(400, "invalid_request", "subject and itemId are required.");
        }
        writeJson(response, 200, {
          map: store.refileSpoolCapture(subject, itemId, typeof input.to === "string" ? input.to : null),
        });
        return;
      }
      /**
       * WHERE TO PICK UP, plus the day reading — in one call.
       *
       * The rule `/v2/spool` states: these are two views of the same focus log
       * and the same map, and a client that fetched them separately could draw a
       * brief that disagrees with the history under it.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/focus") {
        writeJson(response, 200, { pickup: store.spoolPickup(), days: store.spoolFocusDays() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/spool/focus") {
        const input = await body(request);
        const subject = stringValue(input.subject, "subject");
        if (!subject) throw new HttpError(400, "invalid_request", "subject is required.");
        writeJson(response, 201, {
          focus: store.openSpoolFocus({
            subject,
            ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
            ...(typeof input.note === "string" ? { note: input.note } : {}),
          }),
        });
        return;
      }
      const spoolFocusEntry = /^\/v2\/spool\/focus\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolFocusEntry) {
        const id = decodeURIComponent(spoolFocusEntry[1]);
        const input = await body(request);
        /**
         * CLOSING AND CORRECTING ARE DIFFERENT VERBS ON ONE ROUTE, and the body
         * says which. They are not merged: closing records where you LEFT it and
         * correcting records what it SHOULD HAVE SAID, and one endpoint that did
         * both by inference would eventually do the wrong one silently.
         */
        if (input.end !== undefined) {
          const end = input.end as { reason?: unknown; note?: unknown };
          if (end.reason !== "done" && end.reason !== "switched" && end.reason !== "paused") {
            throw new HttpError(400, "invalid_request", 'end.reason must be "done", "switched" or "paused".');
          }
          writeJson(response, 200, {
            focus: store.closeSpoolFocus(id, {
              reason: end.reason,
              ...(typeof end.note === "string" ? { note: end.note } : {}),
            }),
          });
          return;
        }
        if (input.amend !== undefined) {
          const amend = input.amend as { subject?: unknown; threadId?: unknown; note?: unknown; why?: unknown };
          writeJson(response, 200, {
            focus: store.amendSpoolFocus(
              id,
              {
                ...(typeof amend.subject === "string" ? { subject: amend.subject } : {}),
                // `null` CLEARS the thread and `undefined` leaves it — the
                // distinction `amendFocus` depends on, preserved across HTTP.
                ...(amend.threadId === null || typeof amend.threadId === "string" ? { threadId: amend.threadId } : {}),
                ...(typeof amend.note === "string" ? { note: amend.note } : {}),
              },
              typeof amend.why === "string" ? amend.why : undefined,
            ),
          });
          return;
        }
        throw new HttpError(400, "invalid_request", "Send either `end: {reason}` or `amend: {...}`.");
      }
      if (request.method === "GET" && url.pathname === "/v2/spool/work") {
        writeJson(response, 200, { work: store.spoolWork() });
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/v2/spool/work/")) {
        const id = decodeURIComponent(url.pathname.slice("/v2/spool/work/".length));
        /**
         * `stopped: false` IS A 200, not a 404. "There is nothing running under
         * that id" is the honest answer to "stop this" from a surface whose
         * record is a poll or two old — and it is the state the caller wanted.
         */
        writeJson(response, 200, { stopped: store.cancelSpoolWork(id) });
        return;
      }
      /**
       * THE COMPOSED SCREEN. GET is a poll on `rev`; POST asks for a new one and
       * answers immediately, because the composition arrives on the canvas
       * rather than in this response — see `askSpoolCanvas`.
       */
      if (request.method === "GET" && url.pathname === "/v2/spool/canvas") {
        writeJson(response, 200, store.spoolCanvas());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/spool/canvas") {
        const input = await body(request);
        const asked = stringValue(input.asked, "asked")?.trim() ?? "";
        if (!asked) throw new HttpError(400, "invalid_request", "Send `asked` — the question to compose an answer to.");
        writeJson(response, 202, store.askSpoolCanvas(asked));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/spool/master") {
        writeJson(response, 200, { session: store.ensureMasterSession() });
        return;
      }
      if (url.pathname === "/v2/spool/lanes" && (request.method === "GET" || request.method === "POST")) {
        if (request.method === "GET") {
          writeJson(response, 200, { lanes: store.spoolLanes() });
          return;
        }
        const input = await body(request);
        writeJson(response, 201, {
          lane: store.createSpoolLane({
            label: String(input.label ?? ""),
            window: String(input.window ?? ""),
            ...(typeof input.note === "string" ? { note: input.note } : {}),
          }),
        });
        return;
      }
      /**
       * Split rows out of a lane into a new one. A COMPOSITION of the lane verbs
       * beside it, never a fifth primitive — and human-only, like all of them.
       */
      if (request.method === "POST" && url.pathname === "/v2/spool/lanes/split") {
        const input = await body(request);
        writeJson(
          response,
          200,
          store.splitSpoolLane(
            String(input.sourceKey ?? ""),
            {
              label: String(input.label ?? ""),
              window: String(input.window ?? ""),
              ...(typeof input.note === "string" ? { note: input.note } : {}),
            },
            (input.items ?? []) as string[],
          ),
        );
        return;
      }
      const spoolLaneReorder = /^\/v2\/spool\/lanes\/([^/]+)\/reorder$/.exec(url.pathname);
      if (request.method === "POST" && spoolLaneReorder) {
        const input = await body(request);
        writeJson(response, 200, {
          lane: store.reorderSpoolLane(decodeURIComponent(spoolLaneReorder[1]), (input.items ?? []) as string[]),
        });
        return;
      }
      const spoolLane = /^\/v2\/spool\/lanes\/([^/]+)$/.exec(url.pathname);
      if (spoolLane && (request.method === "PATCH" || request.method === "DELETE")) {
        const key = decodeURIComponent(spoolLane[1]);
        if (request.method === "PATCH") {
          const input = await body(request);
          writeJson(response, 200, { lane: store.renameSpoolLane(key, String(input.label ?? "")) });
          return;
        }
        /**
         * A REFUSAL IS 200 WITH `ok: false`, not a 4xx, and the distinction is
         * not pedantry. Every refusal the store produces is a sentence naming
         * what the human must move first — it is the ANSWER to "can I retire
         * this?", not a malformed request. A 400 would let a client render it as
         * an error toast and drop the sentence that made it actionable.
         */
        writeJson(response, 200, store.retireSpoolLane(key));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/spool/items") {
        const input = await body(request);
        writeJson(response, 201, {
          item: store.createSpoolItem({
            title: String(input.title ?? ""),
            /**
             * WHOSE HAND, defaulted to the HUMAN's. This is the human API — the
             * workbench form posts here with no agent anywhere near it, and a
             * bare create must therefore stamp "you", or the footer's "agents
             * added N" counts a hand-made item (the live-drive lie this fixes).
             * The tool wall is the one caller that declares `source: "session"`
             * — its own code, never a model argument — and anything that is not
             * that exact declaration is a hand.
             */
            source: input.source === "session" ? "session" : "you",
            ...(typeof input.project === "string" ? { project: input.project } : {}),
            ...(typeof input.lane === "string" ? { lane: input.lane } : {}),
            ...(typeof input.raw === "string" ? { raw: input.raw } : {}),
            ...(typeof input.rawSource === "string" ? { rawSource: input.rawSource } : {}),
            ...(typeof input.creationNote === "string" ? { creationNote: input.creationNote } : {}),
            // A quoted pair, validated by the store's schema — see
            // `NewSpoolItem.deadline` for the quoting law it rides under.
            ...(input.deadline && typeof input.deadline === "object"
              ? { deadline: input.deadline as { label: string; kind: "external" | "self" } }
              : {}),
            // Forwarded raw so the STORE's gate speaks: a malformed pin gets
            // its plain sentence back as a 400 rather than being dropped here.
            ...(input.pinned !== undefined && input.pinned !== null ? { pinned: input.pinned as { day: string } } : {}),
            // Same rule for tags: the store's one gate speaks, not this route.
            ...(input.tags !== undefined ? { tags: input.tags as string[] } : {}),
          }),
        });
        return;
      }
      const spoolExpert = /^\/v2\/spool\/items\/([^/]+)\/expert$/.exec(url.pathname);
      if (request.method === "POST" && spoolExpert) {
        /**
         * TWO SHAPES, AND WHICH ONE YOU GET DEPENDS ON WHO IS ASKING.
         *
         * `{detach: true}` starts the pass and answers at once with its work
         * record. This route's previous comment said the synchronous form held
         * only "once the OVERNIGHT runner exists and nobody is watching — at
         * which point the job store is the thing that reports what ran while you
         * slept". That store now exists (`spool/work.ts`), and the assumption
         * behind waiting — "a human who clicked consult is, by definition,
         * watching" — was wrong in the way that matters: they are watching a
         * SCREEN, not an HTTP socket, and the socket gives up first.
         *
         * WITHOUT THE FLAG IT STILL AWAITS, because `spool_consult_expert` is
         * called by a MODEL mid-turn and a model cannot do anything with a
         * record it would have to poll for.
         *
         * A REFUSAL IS A 200 WITH ITS SENTENCE, in both shapes. Same reasoning
         * as the lane retire above: "the expert cannot read this because the
         * item is floating" is the ANSWER, not a malformed request.
         */
        const id = decodeURIComponent(spoolExpert[1]);
        const input = await body(request).catch(() => ({}) as Record<string, unknown>);
        if (input.detach === true) {
          writeJson(response, 200, store.startSpoolExpert(id));
          return;
        }
        writeJson(response, 200, await store.consultSpoolExpert(id));
        return;
      }
      /**
       * BRIEFED ARRIVAL — loop 2. A READ, deliberately: it composes the full
       * briefing (packet, raw words, thread state, and the delta from the
       * subject's stored look) from what is already on disk, with no model
       * call, no session created and no turn queued. The web writes it into a
       * composer draft and the HUMAN sends it — the moat stays where it is.
       * An item whose subject maps to no registered project answers with
       * `project` absent, which is an ordinary state the surface renders
       * honestly, never an invented project.
       */
      const spoolBriefing = /^\/v2\/spool\/items\/([^/]+)\/briefing$/.exec(url.pathname);
      if (request.method === "GET" && spoolBriefing) {
        writeJson(response, 200, { briefing: store.spoolBriefing(decodeURIComponent(spoolBriefing[1])) });
        return;
      }
      const spoolPromote = /^\/v2\/spool\/items\/([^/]+)\/subtasks\/([^/]+)\/promote$/.exec(url.pathname);
      if (request.method === "POST" && spoolPromote) {
        writeJson(
          response,
          200,
          store.promoteSpoolSubtask(decodeURIComponent(spoolPromote[1]), decodeURIComponent(spoolPromote[2])),
        );
        return;
      }
      const spoolSubtask = /^\/v2\/spool\/items\/([^/]+)\/subtasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && spoolSubtask) {
        const input = await body(request);
        writeJson(response, 200, {
          item: store.setSpoolSubtaskDone(
            decodeURIComponent(spoolSubtask[1]),
            decodeURIComponent(spoolSubtask[2]),
            input.done === true,
          ),
        });
        return;
      }
      const spoolSubtasks = /^\/v2\/spool\/items\/([^/]+)\/subtasks$/.exec(url.pathname);
      if (request.method === "POST" && spoolSubtasks) {
        const input = await body(request);
        writeJson(response, 201, {
          item: store.addSpoolSubtask(decodeURIComponent(spoolSubtasks[1]), String(input.title ?? "")),
        });
        return;
      }
      /**
       * ANSWER ONE OF AN ITEM'S OPEN QUESTIONS — the reduction verb. The match
       * rule, the empty-answer refusal and the timeline write all live in the
       * store; this route only guards the two required strings by name.
       */
      const spoolAnswer = /^\/v2\/spool\/items\/([^/]+)\/answer$/.exec(url.pathname);
      if (request.method === "POST" && spoolAnswer) {
        const input = await body(request);
        const question = typeof input.question === "string" ? input.question : "";
        const answer = typeof input.answer === "string" ? input.answer : "";
        if (!question.trim() || !answer.trim()) {
          throw new HttpError(
            400,
            "invalid_request",
            "question and answer are both required — an answer with no question is an orphan, and a question with no answer stays open.",
          );
        }
        writeJson(response, 200, {
          item: store.answerSpoolQuestion(decodeURIComponent(spoolAnswer[1]), question, answer),
        });
        return;
      }
      /**
       * THE CHECKBOX — docs/spool-loops.md §9. DEDICATED ROUTES, DELIBERATELY:
       * the generic item PATCH below is reachable from the tool wall's update
       * capability, so close and reopen must not travel through it — the store
       * refuses `closed` on that path by name, and these two verbs exist ONLY
       * here, on the human API, where no tool and no capability can spell them.
       * Closing cascades (open threads on the item settle with the user's own
       * close as the answer); reopening unticks and resurrects nothing.
       */
      const spoolClose = /^\/v2\/spool\/items\/([^/]+)\/close$/.exec(url.pathname);
      if (request.method === "POST" && spoolClose) {
        writeJson(response, 200, store.closeSpoolItem(decodeURIComponent(spoolClose[1])));
        return;
      }
      const spoolReopen = /^\/v2\/spool\/items\/([^/]+)\/reopen$/.exec(url.pathname);
      if (request.method === "POST" && spoolReopen) {
        writeJson(response, 200, store.reopenSpoolItem(decodeURIComponent(spoolReopen[1])));
        return;
      }
      /**
       * MANY CHECKBOXES — the selection model's close, and HUMAN API ONLY
       * exactly like the single verb: this route is the only caller of
       * `closeSpoolItems`, no tool names it, and the socket's wall cannot
       * reach it (asserted in `spool-socket.test.ts`). Per-item results carry
       * the single close's own shape; an id nothing goes by is `{id, error}`
       * beside the closes that landed, never a thrown batch.
       */
      if (request.method === "POST" && url.pathname === "/v2/spool/items/close-many") {
        const input = await body(request);
        if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== "string")) {
          throw new HttpError(400, "invalid_request", "ids must be an array of item ids.");
        }
        writeJson(response, 200, store.closeSpoolItems(input.ids as string[]));
        return;
      }
      const spoolItem = /^\/v2\/spool\/items\/([^/]+)$/.exec(url.pathname);
      if (spoolItem && (request.method === "GET" || request.method === "PATCH")) {
        const id = decodeURIComponent(spoolItem[1]);
        if (request.method === "GET") {
          writeJson(response, 200, store.spoolItem(id));
          return;
        }
        /**
         * FORWARDED WHOLE, deliberately. The store refuses a forbidden key by
         * NAME and throws a sentence saying which one and why — filtering the
         * body here would turn "you cannot rewrite the user's own words" into a
         * silent no-op, which is the exact failure that refusal exists to
         * prevent. The engine's error translation carries the sentence out.
         */
        writeJson(response, 200, { item: store.updateSpoolItem(id, await body(request)) });
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
      /**
       * The project's icon, as bytes. The ONE binary GET this daemon serves:
       * `Project.icon` on the list is the cache key, this is the image behind
       * it. Immutable because the key changes whenever the file does — the
       * `?v=` a client appends is never read here, it exists to bust the
       * browser cache.
       */
      const projectIcon = /^\/v2\/projects\/([^/]+)\/icon$/.exec(url.pathname);
      if (request.method === "GET" && projectIcon) {
        const icon = await store.projectIconFileAsync(decodeURIComponent(projectIcon[1]));
        const bytes = await fs.promises.readFile(icon.path);
        response.writeHead(200, {
          "content-type": icon.contentType,
          "content-length": bytes.byteLength,
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${icon.etag}"`,
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
            file: await store.projectFilePatchAsync(projectId, target, { untracked: url.searchParams.get("untracked") === "1" }),
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
       * What a project OPTS INTO. `PATCH`, not `PUT`: identity stays where
       * `registerProject` put it, and the body names only the switches it
       * means to move. `dataScience: null` turns the feature off and removes
       * the block, which is the difference between "never asked" and "off".
       */
      const projectPatch = /^\/v2\/projects\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && projectPatch) {
        const input = await body(request);
        const patch: Parameters<typeof store.updateProject>[1] = {};
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
        writeJson(response, 200, { project: store.updateProject(decodeURIComponent(projectPatch[1]), patch) });
        return;
      }
      /**
       * THE ENVIRONMENT MANAGER'S READ: every environment a project could run
       * on, each probed, plus the toolchain and the checkout's dependency
       * manifests. A LIST, so the settings page can ask rather than the engine
       * guessing — see `ds/environments.ts`. Slow by nature (it spawns each
       * interpreter); only a human opening the page calls it.
       */
      const projectDsEnvs = /^\/v2\/projects\/([^/]+)\/data-science\/environments$/.exec(url.pathname);
      if (request.method === "GET" && projectDsEnvs) {
        writeJson(response, 200, await store.dataScienceEnvironments(decodeURIComponent(projectDsEnvs[1])));
        return;
      }
      /** Make an environment — `uv venv` or `conda create` — as a job. Body is a `DataScienceCreateEnvironment`. */
      const projectDsCreate = /^\/v2\/projects\/([^/]+)\/data-science\/environments$/.exec(url.pathname);
      if (request.method === "POST" && projectDsCreate) {
        const input = await body(request);
        const parsed = DataScienceCreateEnvironment.safeParse(input);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "not a valid environment request");
        writeJson(response, 202, await store.dataScienceCreateEnvironment(decodeURIComponent(projectDsCreate[1]), parsed.data));
        return;
      }
      /** What is installed in the project's configured environment. */
      const projectDsPackages = /^\/v2\/projects\/([^/]+)\/data-science\/packages$/.exec(url.pathname);
      if (request.method === "GET" && projectDsPackages) {
        writeJson(response, 200, await store.dataSciencePackages(decodeURIComponent(projectDsPackages[1])));
        return;
      }
      /** Install into / remove from the project's environment, as a job. */
      if (request.method === "POST" && projectDsPackages) {
        const input = await body(request);
        const list = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : undefined);
        writeJson(response, 202, await store.dataScienceInstall(decodeURIComponent(projectDsPackages[1]), {
          ...(list("add") ? { add: list("add")! } : {}),
          ...(list("remove") ? { remove: list("remove")! } : {}),
          ...(typeof input.requirements === "string" ? { requirements: input.requirements as Parameters<typeof store.dataScienceInstall>[1]["requirements"] } : {}),
        }));
        return;
      }
      /** Install a tool: uv, a Python version, Miniforge. Machine-wide, so no project in the path. */
      if (request.method === "POST" && url.pathname === "/v2/data-science/bootstrap") {
        const input = await body(request);
        const parsed = DataScienceBootstrap.safeParse(input);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "not a valid bootstrap request");
        writeJson(response, 202, await store.dataScienceBootstrap(parsed.data));
        return;
      }
      /** The toolchain alone, for pages that do not need the environment list. */
      if (request.method === "GET" && url.pathname === "/v2/data-science/toolchain") {
        writeJson(response, 200, { toolchain: await store.dataScienceToolchain(url.searchParams.get("fresh") === "1") });
        return;
      }
      /** Read a job by cursor; DELETE cancels it. */
      const dsJob = /^\/v2\/data-science\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && dsJob) {
        const after = Number(url.searchParams.get("after") ?? "0");
        writeJson(response, 200, { job: store.dataScienceJob(decodeURIComponent(dsJob[1]), Number.isFinite(after) ? after : 0) });
        return;
      }
      if (request.method === "DELETE" && dsJob) {
        store.dataScienceCancelJob(decodeURIComponent(dsJob[1]));
        writeJson(response, 200, {});
        return;
      }
      /** Probe one interpreter or venv directory a person named. */
      const projectDsProbe = /^\/v2\/projects\/([^/]+)\/data-science\/probe$/.exec(url.pathname);
      if (request.method === "POST" && projectDsProbe) {
        const input = await body(request);
        writeJson(response, 200, { probe: await store.dataScienceProbe(decodeURIComponent(projectDsProbe[1]), stringValue(input.path, "python path")!) });
        return;
      }
      /** Every TeX distribution the machine carries, plus main-file candidates.
       *  A LIST for a person to choose from, like the environments route. */
      const projectLatexDists = /^\/v2\/projects\/([^/]+)\/latex\/distributions$/.exec(url.pathname);
      if (request.method === "GET" && projectLatexDists) {
        writeJson(response, 200, await store.latexDistributions(decodeURIComponent(projectLatexDists[1])));
        return;
      }
      /** What the project's TeX distribution has installed — or why nothing lists. */
      const projectLatexPackages = /^\/v2\/projects\/([^/]+)\/latex\/packages$/.exec(url.pathname);
      if (request.method === "GET" && projectLatexPackages) {
        writeJson(response, 200, await store.latexPackages(decodeURIComponent(projectLatexPackages[1])));
        return;
      }
      /** tlmgr install / remove, as a job. */
      if (request.method === "POST" && projectLatexPackages) {
        const input = await body(request);
        const list = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).map(String) : undefined);
        writeJson(response, 202, await store.latexInstall(decodeURIComponent(projectLatexPackages[1]), {
          ...(list("add") ? { add: list("add")! } : {}),
          ...(list("remove") ? { remove: list("remove")! } : {}),
        }));
        return;
      }
      /** Install Tectonic or TinyTeX. Machine-wide, so no project in the path. */
      if (request.method === "POST" && url.pathname === "/v2/latex/bootstrap") {
        const input = await body(request);
        const parsed = LatexBootstrap.safeParse(input);
        if (!parsed.success) throw new HttpError(400, "invalid_request", "not a valid bootstrap request");
        writeJson(response, 202, await store.latexBootstrap(parsed.data));
        return;
      }
      /** The TeX toolchain alone, for pages that do not need the candidates. */
      if (request.method === "GET" && url.pathname === "/v2/latex/toolchain") {
        writeJson(response, 200, { toolchain: await store.latexToolchain(url.searchParams.get("fresh") === "1") });
        return;
      }
      /** Read a latex job by cursor; DELETE cancels it. */
      const latexJob = /^\/v2\/latex\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && latexJob) {
        const after = Number(url.searchParams.get("after") ?? "0");
        writeJson(response, 200, { job: store.latexJob(decodeURIComponent(latexJob[1]), Number.isFinite(after) ? after : 0) });
        return;
      }
      if (request.method === "DELETE" && latexJob) {
        store.latexCancelJob(decodeURIComponent(latexJob[1]));
        writeJson(response, 200, {});
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
       * SIGNING IN TO AN MCP SERVER — the one credential Telar mints.
       *
       * EVERYWHERE ELSE THE RULE IS THAT TELAR ADOPTS LOGINS AND NEVER CREATES
       * THEM: `claude` and `codex` each have their own sign-in and their own
       * credential store, and reaching into either would be Telar holding
       * something it has no business holding. A third-party MCP server has
       * neither. Nothing else on this machine will ever hold that grant, so an
       * engine that declines to run the flow is an engine on which the server
       * simply does not work. That is the whole of the exception.
       *
       * THE FLOW IS SPLIT ACROSS TWO PROCESSES ON PURPOSE. The PKCE verifier and
       * the state stay HERE, in the engine, keyed by the state the authorization
       * server will echo; the browser lands on the cockpit, which forwards the
       * `code` back. So the cockpit never holds a verifier, and a `code`
       * intercepted on its way through is useless without the half it never saw.
       */
      if (request.method === "GET" && url.pathname === "/v2/mcp-oauth") {
        const projectId = url.searchParams.get("projectId")?.trim() || undefined;
        const servers = projectId ? resolveMcpServers(store.listMcpServers(), projectId) : store.listMcpServers({ projectId: null });
        writeJson(response, 200, { statuses: await mcpOAuthStatuses(store, servers) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/mcp-oauth/connect") {
        const input = await body(request);
        const serverId = stringValue(input.serverId, "mcp server id")!;
        const projectId = stringValue(input.projectId, "project id", true);
        const redirectOrigin = stringValue(input.redirectOrigin, "redirect origin")!;
        const server = store
          .listMcpServers()
          .find((candidate) => candidate.id === serverId && candidate.projectId === projectId);
        if (!server) throw new HttpError(404, "not_found", `no MCP server "${serverId}" in this scope`);
        if (server.spec.transport === "stdio") {
          throw new HttpError(400, "invalid_request", `"${serverId}" runs as a local command, so there is nothing to sign in to`);
        }
        try {
          const ctx = await beginConnect({
            serverId,
            ...(projectId === undefined ? {} : { projectId }),
            serverUrl: server.spec.url,
            ...(server.spec.oauth ? { overrides: server.spec.oauth } : {}),
            redirectOrigin,
            store: store.mcpOAuthClientStore(),
            clientName: `Telar — ${server.label}`,
          });
          store.putPendingMcpOAuth({
            serverId,
            ...(projectId === undefined ? {} : { projectId }),
            ctx,
            createdAt: now(),
          });
          writeJson(response, 200, { authorizationUrl: ctx.authorizationUrl });
        } catch (error) {
          const message = error instanceof Error ? error.message : "could not start the sign-in";
          // The one failure with an action behind it: the authorization server
          // will not register a client on its own, so the user has to paste one
          // from its dashboard. Answered as a 400 naming that, rather than a 502
          // that reads as "the server is broken".
          if (message.includes(NO_CLIENT_STRATEGY)) {
            throw new HttpError(
              400,
              "invalid_request",
              `"${server.label}" cannot register Telar automatically — add a client ID from the server's own dashboard, save, then sign in again`,
            );
          }
          throw new HttpError(502, "provider_unavailable", message);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/mcp-oauth/callback") {
        const input = await body(request);
        const state = stringValue(input.state, "oauth state")!;
        const code = stringValue(input.code, "authorization code")!;
        // Single use: a replayed callback finds nothing, and an expired one is
        // indistinguishable from an unknown one on purpose — neither tells the
        // caller anything about a flow it did not start.
        const pending = store.takePendingMcpOAuth(state);
        if (!pending) throw new HttpError(400, "invalid_request", "this sign-in link has expired or was already used");
        try {
          const tokens = await completeConnect({ ctx: pending.ctx, code, returnedState: state });
          store.putMcpOAuthRecord({
            serverId: pending.serverId,
            ...(pending.projectId === undefined ? {} : { projectId: pending.projectId }),
            resource: pending.ctx.resource,
            as: pending.ctx.as,
            client: pending.ctx.client,
            tokens,
            updatedAt: now(),
          });
          writeJson(response, 200, {
            serverId: pending.serverId,
            ...(pending.projectId === undefined ? {} : { projectId: pending.projectId }),
          });
        } catch (error) {
          throw new HttpError(502, "provider_unavailable", error instanceof Error ? error.message : "the token exchange failed");
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/mcp-oauth/disconnect") {
        const input = await body(request);
        const serverId = stringValue(input.serverId, "mcp server id")!;
        const projectId = stringValue(input.projectId, "project id", true);
        writeJson(response, 200, { removed: store.deleteMcpOAuthRecord(serverId, projectId) });
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
        writeJson(response, 200, {
          providerInstance: store.saveProviderInstance({
            id,
            // Every field is forwarded VERBATIM, including an explicit `null`:
            // the store owns the three-state rule (clear / keep / set), and a
            // route that coerced null away here would make "remove the accent
            // colour" unexpressible over HTTP.
            ...(input.driver === undefined ? {} : { driver: input.driver }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName as string | null }),
            ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor as string | null }),
            ...(input.configDir === undefined ? {} : { configDir: input.configDir as string | null }),
            ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath as string | null }),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/sessions") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) throw new HttpError(400, "invalid_request", "projectId is required");
        writeJson(response, 200, { sessions: store.listSessions(projectId) });
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
      if (request.method === "GET" && url.pathname === "/v2/sessions/live") {
        writeJson(response, 200, store.liveSessions());
        return;
      }
      /**
       * THE SESSIONS SOCKET'S CONNECT CARD — where it listens and its dedicated
       * secret. BEHIND THE NORMAL BEARER, exactly as the spool's is: the card
       * mints and reveals the socket's credential, so only something already
       * holding engine access may read it.
       */
      if (request.method === "GET" && url.pathname === "/v2/sessions/mcp-info") {
        const bound = server.address();
        const port = bound && typeof bound === "object" ? bound.port : 0;
        writeJson(response, 200, {
          mcp: sessionsSocketConnectCard(`http://127.0.0.1:${port}/v2/sessions/mcp`, sessionsSecret()),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/sessions") {
        const input = await body(request);
        writeJson(response, 201, {
          session: store.createSession({
            ...(input.draft === true ? { draft: true } : {}),
            id: stringValue(input.id, "session id", true),
            projectId: stringValue(input.projectId, "project id")!,
            title: stringValue(input.title, "session title", true),
            ...(typeof input.detached === "boolean" ? { detached: input.detached } : {}),
            ...(input.envMode === "worktree" || input.envMode === "local" ? { envMode: input.envMode } : {}),
            ...(typeof input.branchSlug === "string" ? { branchSlug: input.branchSlug } : {}),
            // The base-ref picker's two knobs. Validated in the store and in
            // worktree.ts, for the same one-wall reason as `driver` below.
            ...(typeof input.baseRef === "string" ? { baseRef: input.baseRef } : {}),
            ...(typeof input.branchName === "string" ? { branchName: input.branchName } : {}),
            // Validated in the store rather than here, so the HTTP surface and
            // any in-process caller reject the same set of drivers.
            ...(typeof input.driver === "string" ? { driver: input.driver as "claude" | "codex" } : {}),
            // Naming an instance also names the driver, so the store ignores
            // `driver` when this is present rather than refusing the pair.
            ...(typeof input.providerInstanceId === "string" ? { providerInstanceId: input.providerInstanceId } : {}),
            /**
             * WHO ASKED — provenance. Forwarded rather than ignored because the
             * OUT-OF-PROCESS worker reaches this route to build the toolkit's
             * `create`, exactly as it reaches `/v2/spool/items` to build the
             * spool's: the capability is assembled out of client calls in one
             * deployment and out of `store.*` calls in the other, and both must
             * stamp the same provenance.
             *
             * ONLY `"session"` IS HONOURED. Anything else — including a literal
             * "human" — falls through to absent, which IS human; two spellings
             * of the same state is how the two drift.
             */
            ...(input.origin === "session" ? { origin: "session" as const } : {}),
          }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/workers/register") {
        const input = await body(request);
        const workerId = stringValue(input.workerId, "worker id")!;
        if (!/^[A-Za-z0-9_-]+$/.test(workerId)) throw new HttpError(400, "invalid_request", "worker id is unsafe");
        pruneWorkers();
        if (workers.has(workerId)) throw new HttpError(409, "conflict", "worker id is already registered");
        const at = now();
        workers.set(workerId, { workerId, registeredAt: at, heartbeatAt: at });
        writeJson(response, 200, { worker: { workerId }, heartbeatIntervalMs: Math.max(50, Math.floor(workerLeaseMs / 3)) });
        return;
      }

      const workerMatch = /^\/v2\/workers\/([A-Za-z0-9_-]+)\/(heartbeat|claim)$/.exec(url.pathname);
      if (workerMatch && request.method === "POST") {
        const workerId = decodeURIComponent(workerMatch[1]);
        const worker = activeWorker(workerId);
        worker.heartbeatAt = now();
        if (workerMatch[2] === "heartbeat") {
          const status: WorkerStatus = {
            workerId,
            heartbeatAt: worker.heartbeatAt,
            cancel: store.cancellationsForWorker(workerId),
            resolved: store.resolutionsForWorker(workerId),
            steer: store.steerForWorker(workerId),
            stopTask: store.drainStopTasks(),
          };
          writeJson(response, 200, status);
        } else {
          // The claim itself is synchronous and under the state lock; attaching
          // managed OAuth bearers is a network call, so it happens out here
          // rather than stalling every other session's claim behind one slow
          // authorization server.
          const claimed = store.claimNextTurn(workerId);
          writeJson(response, 200, { claim: claimed ? await store.authorizeClaimedMcpServers(claimed) : undefined });
        }
        return;
      }

      const turn = turnPath(url.pathname);
      if (turn && request.method === "POST") {
        if (turn.action === "discard") {
          await body(request);
          writeJson(response, 200, { turn: store.discardAmbiguousTurn(turn.sessionId, turn.runId) });
          return;
        }
        // A HUMAN gesture like discard, so no claim token: send this queued
        // message into the running turn.
        if (turn.action === "promote") {
          await body(request);
          writeJson(response, 200, { turn: store.promoteTurn(turn.sessionId, turn.runId) });
          return;
        }
        const input = await body(request);
        const claimToken = stringValue(input.claimToken, "claim token")!;
        if (turn.action === "running") {
          writeJson(response, 200, { turn: store.markRunning(turn.sessionId, turn.runId, claimToken) });
        } else if (turn.action === "steer-ack") {
          // The runId in the path is the PROMOTED turn; the claim token proves
          // the worker holds the running turn it was steered into.
          writeJson(response, 200, { turn: store.ackSteer(turn.sessionId, turn.runId, claimToken) });
        } else if (turn.action === "request") {
          const parsed = RequestOpenInput.safeParse(input);
          if (!parsed.success) throw new HttpError(400, "invalid_request", "request payload is invalid");
          writeJson(
            response,
            200,
            store.openRequest(turn.sessionId, turn.runId, parsed.data.claimToken, {
              requestId: parsed.data.requestId,
              kind: parsed.data.kind,
              detail: parsed.data.detail,
              ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}),
              ...(parsed.data.providerRefs ? { providerRefs: parsed.data.providerRefs } : {}),
            }),
          );
        } else if (turn.action === "observe") {
          if (!Array.isArray(input.observations)) {
            throw new HttpError(400, "invalid_request", "observations must be an array");
          }
          // The store re-validates against the contract schema. This only
          // rejects a shape that is not even an array, so the error names the
          // request rather than the first malformed element inside it.
          writeJson(response, 200, store.ingestObservations(turn.sessionId, turn.runId, claimToken, input.observations));
        } else if (turn.action === "complete") {
          writeJson(response, 200, {
            turn: store.completeTurn(turn.sessionId, turn.runId, claimToken, {
              text: stringValue(input.text, "text")!,
              providerSessionId: stringValue(input.providerSessionId, "provider session id", true),
              usage: input.usage as never,
            }),
          });
        } else {
          const code = stringValue(input.code, "failure code")!;
          if (code !== "provider_unavailable" && code !== "driver_failed" && code !== "budget_exhausted") {
            throw new HttpError(400, "invalid_request", "failure code is invalid");
          }
          writeJson(response, 200, {
            turn: store.failTurn(turn.sessionId, turn.runId, claimToken, { code, message: stringValue(input.message, "failure message")! }),
          });
        }
        return;
      }

      const humanRequest = requestPath(url.pathname);
      if (humanRequest && request.method === "POST") {
        const input = await body(request);
        const decision = stringValue(input.decision, "decision")!;
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
          throw new HttpError(400, "invalid_request", "decision is invalid");
        }
        writeJson(response, 200, {
          request: store.resolveRequest(humanRequest.sessionId, humanRequest.requestId, {
            decision: decision as "accept" | "acceptForSession" | "decline" | "cancel",
            reason: stringValue(input.reason, "reason", true),
            ...(input.answers && typeof input.answers === "object" ? { answers: input.answers as Record<string, unknown> } : {}),
            // ONLY `"session"` IS HONOURED — the out-of-process worker names
            // it when the `sessions` toolkit answers on a peer's behalf.
            // Anything else falls through to absent, which IS human; the
            // same construction as `origin` on session creation.
            ...(input.resolvedBy === "session" ? { resolvedBy: "session" as const } : {}),
          }),
        });
        return;
      }

      const subscription = subscriptionPath(url.pathname);
      if (subscription && request.method === "DELETE") {
        const input = await body(request);
        const subscriber = stringValue(input.subscriberSessionId, "subscriber session id", true);
        writeJson(response, 200, { removed: store.unsubscribe(subscription.subscriptionId, subscriber) });
        return;
      }

      const session = sessionPath(url.pathname);
      if (session) {
        if (request.method === "GET" && session.tail === "") {
          // `?turns=N[&before=runId]` windows the snapshot to the newest N
          // settled turns (plus everything unsettled). Absent, the whole
          // session — the read a client older than the window still makes.
          const turnsParam = url.searchParams.get("turns");
          const limit = turnsParam === null ? undefined : Number(turnsParam);
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
            throw new HttpError(400, "invalid_request", "turns must be a positive integer");
          }
          const before = url.searchParams.get("before") ?? undefined;
          if (before !== undefined && limit === undefined) {
            throw new HttpError(400, "invalid_request", "before needs turns");
          }
          // READ FIRST. The snapshot below is what the client renders; the
          // cursor says which events it already reflects. A cursor read
          // after the snapshot could name an event whose effect the
          // snapshot does not carry, and the client would skip it forever.
          // Read before, the worst case is one event replayed onto a
          // snapshot that already has it — which the fold is built for.
          const cursor = store.eventCursor(session.sessionId);
          const window =
            limit === undefined
              ? {
                  turns: store.turns(session.sessionId),
                  items: store.items(session.sessionId),
                  // On the snapshot rather than behind its own route: a
                  // background task outlives its turn, so "is this session
                  // still working" must be answerable from the FIRST fetch of
                  // a cold session, before any event has streamed.
                  tasks: store.tasks(session.sessionId),
                }
              : store.snapshotWindow(session.sessionId, { limit, ...(before === undefined ? {} : { before }) });
          writeJson(response, 200, {
            cursor,
            session: store.getSession(session.sessionId),
            ...window,
            requests: store.requests(session.sessionId),
          });
          return;
        }
        if (request.method === "GET" && session.tail === "/events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          const events = store.readEvents(session.sessionId, after);
          writeJson(response, 200, {
            events,
            cursor: events.at(-1)?.id ?? (Number.isSafeInteger(after) ? after : 0),
            // The store returns the whole tail in one read, so a caller never
            // has to page. Reported anyway because the field is contract and a
            // future chunked read must not silently look like a complete one.
            more: false,
          });
          return;
        }
        /**
         * The session's review: what it has done to the repository since it
         * started. `?path=` narrows it to ONE file's patch, because a review of
         * two hundred files carrying every patch is a megabyte on a poll.
         */
        if (request.method === "GET" && session.tail === "/diff") {
          const target = url.searchParams.get("path");
          if (target) {
            writeJson(response, 200, {
              file: await store.sessionFilePatchAsync(session.sessionId, target, { untracked: url.searchParams.get("untracked") === "1" }),
            });
            return;
          }
          writeJson(response, 200, { diff: await store.sessionDiffAsync(session.sessionId) });
          return;
        }
        /**
         * The session's checkout, as a file list. `?path=` reads ONE file's
         * text — the same split as `/diff`, and for the same reason: a tree asks
         * for every path once and a viewer asks for one file at a time.
         */
        if (request.method === "GET" && session.tail === "/files") {
          const target = url.searchParams.get("path");
          if (target) {
            writeJson(response, 200, { file: await store.sessionFileAsync(session.sessionId, target) });
            return;
          }
          writeJson(response, 200, { listing: await store.sessionFilesAsync(session.sessionId) });
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
          writeJson(response, 200, store.commitSessionWork(session.sessionId, stringValue(input.message, "commit message")!));
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
         * THE KERNEL'S DOOR. Every data-science verb is a POST under
         * `/ds/<method>`, dispatched to the store's capability — the same object
         * the worker's toolkit reaches through `EngineClient.ds`. A project that
         * has not opted in gets `invalid_request` here, which is the whole gate.
         */
        const dsMethod = /^\/ds\/([a-z]+(?:\/[a-z]+)?)$/.exec(session.tail)?.[1];
        if (request.method === "POST" && dsMethod) {
          const input = await body(request);
          const ds = store.dataScience(session.sessionId);
          /**
           * A KERNEL'S REFUSAL IS AN ANSWER, NOT A CRASH. "The notebook is
           * 2 MB, larger than the engine reads" and "could not build the
           * kernel's environment" are sentences a person can act on; folded
           * into a generic 500 they read as the engine being broken, which is
           * what the first nightly showed. Everything the capability throws is
           * about the request, so it maps to 400 with its own words.
           */
          const dsAnswer = async <T,>(work: () => Promise<T>): Promise<T> => {
            try {
              return await work();
            } catch (error) {
              if (error instanceof HttpError || error instanceof EngineStateError) throw error;
              throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error));
            }
          };
          const str = (key: string, optional = false) => stringValue(input[key], key, optional);
          const num = (key: string): number | undefined => (typeof input[key] === "number" ? (input[key] as number) : undefined);
          let result: unknown;
          switch (dsMethod) {
            case "kernel": result = await dsAnswer(() => ds.kernel()); break;
            case "execute": result = await dsAnswer(() => ds.execute({ code: str("code")!, ...(str("cellId", true) ? { cellId: str("cellId", true)! } : {}), ...(num("timeoutMs") ? { timeoutMs: num("timeoutMs")! } : {}), ...(str("producer", true) ? { producer: str("producer", true)! } : {}) })); break;
            case "interrupt": await dsAnswer(() => ds.interrupt()); result = {}; break;
            case "restart": await dsAnswer(() => ds.restart()); result = {}; break;
            case "vars": result = await dsAnswer(() => ds.vars(num("limit"))); break;
            case "inspect": result = await dsAnswer(() => ds.inspect(str("name")!, num("depth"))); break;
            case "notebook/read": result = await dsAnswer(() => ds.notebookRead(str("path")!, { ...(num("from") !== undefined ? { from: num("from")! } : {}), ...(num("to") !== undefined ? { to: num("to")! } : {}), ...(input.withOutputs === true ? { withOutputs: true } : {}) })); break;
            case "notebook/edit": result = await dsAnswer(() => ds.notebookEdit(str("path")!, input.edit as Parameters<typeof ds.notebookEdit>[1])); break;
            case "notebook/run": result = await dsAnswer(() => ds.notebookRun(str("path")!, { ...(str("cellId", true) ? { cellId: str("cellId", true)! } : {}), ...(input.all === true ? { all: true } : {}), ...(typeof input.stopOnError === "boolean" ? { stopOnError: input.stopOnError } : {}) })); break;
            case "plot": result = await dsAnswer(() => ds.plot({ code: str("code")!, ...(str("title", true) ? { title: str("title", true)! } : {}) })); break;
            case "snapshot": result = await dsAnswer(() => ds.snapshot(str("name")!, Array.isArray(input.vars) ? input.vars.map(String) : undefined)); break;
            case "snapshots": result = await dsAnswer(() => ds.snapshots()); break;
            case "diff": result = await dsAnswer(() => ds.diff(str("from")!, str("to")!)); break;
            case "checkpoint": result = await dsAnswer(() => ds.checkpoint({ action: str("action")! as "save" | "restore" | "list", ...(str("name", true) ? { name: str("name", true)! } : {}) })); break;
            case "lineage": result = await dsAnswer(() => ds.lineage(str("of", true))); break;
            case "watches": result = await dsAnswer(() => ds.watches()); break;
            case "watch": result = await dsAnswer(() => ds.watch({ name: str("name")!, ...(str("assert", true) ? { assert: str("assert", true)! } : {}), ...(input.remove === true ? { remove: true } : {}) })); break;
            case "env": result = await dsAnswer(() => ds.environment({ ...(str("use", true) ? { use: str("use", true)! } : {}) })); break;
            case "packages": result = await dsAnswer(() => ds.packages()); break;
            case "install": result = await dsAnswer(() => ds.install({ ...(Array.isArray(input.add) ? { add: input.add.map(String) } : {}), ...(Array.isArray(input.remove) ? { remove: input.remove.map(String) } : {}), ...(str("requirements", true) ? { requirements: str("requirements", true)! } : {}) })); break;
            case "experiment": result = await dsAnswer(() => ds.experiment({ action: str("action")! as "start" | "log" | "end" | "list", ...(str("name", true) ? { name: str("name", true)! } : {}), ...(input.params && typeof input.params === "object" ? { params: input.params as Record<string, unknown> } : {}), ...(input.metrics && typeof input.metrics === "object" ? { metrics: input.metrics as Record<string, number> } : {}) })); break;
            default: throw new HttpError(404, "not_found", `no data-science method ${dsMethod}`);
          }
          writeJson(response, 200, result ?? {});
          return;
        }
        /**
         * THE LATEX DOOR, shaped like the kernel's above: every verb is a
         * POST under `/latex/<method>`, dispatched to the store's capability
         * — the same object the worker's toolkit reaches through
         * `EngineClient.latex`. Not opted in → `invalid_request`, the gate.
         */
        const latexMethod = /^\/latex\/([a-z]+)$/.exec(session.tail)?.[1];
        if (request.method === "POST" && latexMethod) {
          const input = await body(request);
          const latex = store.latex(session.sessionId);
          // Same rule as dsAnswer: a compile's refusal is an answer, not a crash.
          const latexAnswer = async <T,>(work: () => Promise<T>): Promise<T> => {
            try {
              return await work();
            } catch (error) {
              if (error instanceof HttpError || error instanceof EngineStateError) throw error;
              throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error));
            }
          };
          const str = (key: string, optional = false) => stringValue(input[key], key, optional);
          const num = (key: string): number | undefined => (typeof input[key] === "number" ? (input[key] as number) : undefined);
          let result: unknown;
          switch (latexMethod) {
            case "toolchain": result = await latexAnswer(() => latex.toolchain()); break;
            case "compile": result = await latexAnswer(() => latex.compile({ ...(str("path", true) ? { path: str("path", true)! } : {}), ...(num("timeoutMs") ? { timeoutMs: num("timeoutMs")! } : {}) })); break;
            case "status": result = await latexAnswer(() => latex.status()); break;
            case "log": result = await latexAnswer(() => latex.log({ ...(num("tail") !== undefined ? { tail: num("tail")! } : {}), ...(num("around") !== undefined ? { around: num("around")! } : {}), ...(str("find", true) ? { find: str("find", true)! } : {}) })); break;
            case "packages": result = await latexAnswer(() => latex.packages()); break;
            case "install": result = await latexAnswer(() => latex.install({ ...(Array.isArray(input.add) ? { add: input.add.map(String) } : {}), ...(Array.isArray(input.remove) ? { remove: input.remove.map(String) } : {}) })); break;
            case "clean": result = await latexAnswer(() => latex.clean({ ...(input.pdf === true ? { pdf: true } : {}) })); break;
            default: throw new HttpError(404, "not_found", `no latex method ${latexMethod}`);
          }
          writeJson(response, 200, result ?? {});
          return;
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
        if (request.method === "POST" && session.tail === "/subscriptions") {
          const input = await body(request);
          const events = Array.isArray(input.events) ? input.events.filter((each): each is WakeKind => WakeKindSchema.safeParse(each).success) : undefined;
          writeJson(response, 201, {
            subscription: store.subscribe(session.sessionId, {
              targetSessionId: stringValue(input.targetSessionId, "target session id")!,
              ...(events && events.length > 0 ? { events } : {}),
              ...(input.once === true ? { once: true } : {}),
            }),
          });
          return;
        }
        if (request.method === "GET" && session.tail === "/subscriptions") {
          writeJson(response, 200, { subscriptions: store.subscriptionsFor(session.sessionId) });
          return;
        }
        if (request.method === "POST" && session.tail === "/turns") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
          // `origin` and `wakeReason` are DELIBERATELY NOT READ from the body:
          // a wake is the engine's own, queued by `fireSubscriptions`, and a
          // cockpit body that could forge one could impersonate a peer.
          const input = await body(request);
          const model = TurnModelSelection.safeParse(input.model);
          if (input.model !== undefined && !model.success) {
            throw new HttpError(400, "invalid_request", "turn model selection is invalid");
          }
          const accepted = store.submitTurn(session.sessionId, {
            runId: stringValue(input.runId, "run id")!,
            input: stringValue(input.input, "turn input")!,
            ...(input.kind === "compact" ? { kind: "compact" as const } : {}),
            ...(model.success ? { model: model.data } : {}),
            ...(Array.isArray(input.attachments) ? { attachments: input.attachments.map((id) => stringValue(id, "attachment id")!) } : {}),
          });
          const result: TurnSubmissionResult = accepted;
          writeJson(response, accepted.replayed ? 200 : 202, result);
          /**
           * THE FIRST TURN ALSO NAMES THE SESSION. Sequence 1 is the moment
           * both placeholders exist — the truncated-message title and the
           * branch slugged from it — and the only moment worth a model call:
           * a session that already has a real name keeps it (`titleIsSeed`).
           * After the response and unawaited, because a title is never worth
           * a millisecond of turn latency, let alone a failure.
           */
          if (!accepted.replayed && accepted.turn.sequence === 1) {
            void maybeRetitleSession(store, session.sessionId, accepted.turn.input);
          }
          return;
        }
        if (request.method === "PATCH" && session.tail === "") {
          const input = await body(request);
          writeJson(response, 200, {
            session: store.updateSession(session.sessionId, {
              ...(input.title === undefined ? {} : { title: stringValue(input.title, "session title")! }),
              // Validated in the store against the contract's own list, so the
              // HTTP surface and an in-process caller refuse the same set.
              ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode as RuntimeMode }),
              ...(typeof input.detached === "boolean" ? { detached: input.detached } : {}),
              // Parsed in the store against `ModelSelection`, same reasoning.
              // `null` is forwarded rather than dropped: it is how a client says
              // "clear it", which `undefined` cannot express over JSON.
              ...(input.model === undefined ? {} : { model: input.model as ModelSelection | null }),
              // Both forwarded verbatim, `null` included, and both validated in
              // the store — same reasoning as the two above: a check that only
              // ran on this hop would not protect an in-process caller.
              ...(input.settledOverride === undefined ? {} : { settledOverride: input.settledOverride as "settled" | "active" | null }),
              ...(input.snoozedUntil === undefined ? {} : { snoozedUntil: input.snoozedUntil as number | null }),
            }),
          });
          return;
        }
        if (request.method === "POST" && session.tail === "/archive") {
          await body(request);
          writeJson(response, 200, { session: store.archiveSession(session.sessionId) });
          return;
        }
        /**
         * DELETE ON THE SESSION ITSELF, not a `/delete` verb hanging off it.
         * The method IS the operation here, and a POST that destroys a resource
         * is the shape that makes a stray retry expensive.
         */
        if (request.method === "DELETE" && session.tail === "") {
          writeJson(response, 200, { deleted: store.deleteSession(session.sessionId) });
          return;
        }
        if (request.method === "POST" && session.tail === "/stop") {
          const input = await body(request);
          writeJson(response, 200, store.stopTurn(session.sessionId, stringValue(input.runId, "run id", true)));
          return;
        }
        // A turn the PROVIDER started (a wake-up between turns). Worker-only,
        // like claim: the worker is the party holding the process that spoke.
        if (request.method === "POST" && session.tail === "/turns/provider") {
          const parsed = ProviderTurnOpenInput.safeParse(await body(request));
          if (!parsed.success) throw new HttpError(400, "invalid_request", "provider turn payload is invalid");
          activeWorker(parsed.data.workerId);
          writeJson(response, 200, { turn: store.openProviderTurn(session.sessionId, parsed.data) });
          return;
        }
        // Task reports between turns — no claim, worker-authenticated.
        if (request.method === "POST" && session.tail === "/tasks") {
          const parsed = SessionTaskReport.safeParse(await body(request));
          if (!parsed.success) throw new HttpError(400, "invalid_request", "task report payload is invalid");
          activeWorker(parsed.data.workerId);
          writeJson(response, 200, store.reportSessionTasks(session.sessionId, parsed.data.workerId, parsed.data.observations));
          return;
        }
        // The "N tasks still working" chip's Stop. Names no turn — a background
        // task outlives its turn, so this is a different verb from /stop.
        if (request.method === "POST" && session.tail === "/stop-background") {
          writeJson(response, 200, { stopped: store.stopBackgroundTasks(session.sessionId) });
          return;
        }
      }
      throw new HttpError(404, "not_found", "engine endpoint does not exist");
    } catch (error) {
      const normalized = errorFor(error);
      writeJson(
        response,
        normalized.status,
        { error: { code: normalized.code, message: normalized.message } },
        normalized.endConnection ? { connection: "close" } : {},
      );
    }
  });

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

    // The embedded worker starts AFTER discovery is published, because it
    // connects through the same discovery document every other client uses
    // rather than through a private in-process shortcut. That keeps one code
    // path for claim/heartbeat/observe instead of two that can diverge.
    let embedded: { workerId: string; stop(): Promise<void> } | undefined;
    let browser: import("./browser").BrowserRuntime | undefined;
    let browserSocket: import("./browser/socket").BrowserToolSocket | undefined;
    let sessionsRunSocket: import("./sessions-tools/run-socket").SessionsToolSocket | undefined;
    let kernels: KernelHost | undefined;
    if (options.embeddedWorker) {
      const config = options.embeddedWorker === true ? {} : options.embeddedWorker;
      const [{ EngineClient }, { EngineWorker }] = await Promise.all([
        import("@telar/engine-client"),
        import("./worker"),
      ]);
      // The daemon owns the browser, not the driver: it outlives any turn and
      // has to be closed exactly once. `release(sessionId)` on archive is what
      // keeps Chromium instances from accumulating until the pool evicts them.
      const { BrowserRuntime, BrowserRouter, desktopBrowserFromEnv } = await import("./browser");
      // Persistent per-session profiles, under the engine's own state root:
      // a login the human helped with on Tuesday still holds on Thursday.
      browser = new BrowserRuntime({ profileRoot: path.join(store.paths.root, "browser-profiles") });
      /**
       * THE SHARED BROWSER (§6 of the plan): when the desktop shell exported
       * its control server, calls route to the Electron-hosted tabs the human
       * can see and click; otherwise — detached machine, app quit — the same
       * calls run on the headless runtime. One capability either way, so the
       * store, the socket and both providers never learn which one answered.
       */
      const routed = new BrowserRouter(browser, desktopBrowserFromEnv());
      store.attachBrowser(routed);
      /**
       * THE KERNEL HOST, beside the browser and for the same reason: a
       * kernel outlives any turn, so the daemon owns it. Outputs are
       * journaled by the store's capability; the host only persists images.
       */
      kernels = new KernelHost({
        engineRoot: store.paths.root,
        sessionDir: (sessionId) => path.join(store.paths.sessions, sessionId),
        events: {
          onState: (sessionId, state, reason) => store.recordKernelState(sessionId, state, reason),
          persistImage: (sessionId, input) =>
            store.putAttachment(sessionId, {
              name: `${input.producer}.${input.mediaType === "image/svg+xml" ? "svg" : "png"}`,
              mediaType: input.mediaType,
              data: input.data,
              tags: ["plot"],
              producer: input.producer,
            }).id,
        },
      });
      store.attachKernels(kernels);
      // The browser reaches sessions over the worker-hosted MCP socket, for
      // BOTH providers — see `./browser/socket.ts`. The daemon owns the socket
      // the way it owns the browser: it outlives any turn and is closed once.
      browserSocket = (await import("./drivers")).createBrowserToolSocket(routed);
      // The sessions wall for Codex turns — worker-hosted like the browser's,
      // per-session tokens, no persisted secret. Distinct from the daemon's
      // outward `/v2/sessions/mcp` door below, deliberately: two doors, two
      // credentials, and only this one carries a `self` to be woken in.
      sessionsRunSocket = new (await import("./sessions-tools/run-socket")).SessionsToolSocket();
      const createDriver = config.createDriver ?? (async () => (await import("./drivers")).createDefaultDrivers());
      const concurrency = (await import("./worker")).workerConcurrencyFromEnv();
      const { WorkerReconnectController } = await import("./worker-supervisor");
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
      const sessionsSocket = sessionsRunSocket;
      const supervisor = new WorkerReconnectController<InstanceType<typeof EngineClient>, InstanceType<typeof EngineWorker>>({
        connect: async () => {
          const client = new EngineClient(discovery);
          const register = client.registerWorker.bind(client);
          client.registerWorker = async (id) => {
            const result = await register(id);
            embeddedRegistration = workers.get(id);
            return result;
          };
          return client;
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
            ...(sessionsSocket ? { sessionsSocket } : {}),
            ...(concurrency === undefined ? {} : { concurrency }),
            ...(config.pollMs === undefined ? {} : { pollMs: config.pollMs }),
            onConnectionLost,
          });
          const stop = worker.stop.bind(worker);
          const ownedWorkerId = workerId;
          worker.stop = async () => {
            // A stopped/replaced generation must not leave an immortal entry,
            // nor clear the ownership of a later generation.
            if (embeddedRegistration?.workerId === ownedWorkerId) embeddedRegistration = undefined;
            await stop();
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
        void warmUsageScanCache({ scanCachePath: usageScanCachePath }).catch(() => undefined);
      }, options.warmUsageCacheAfterMs);
      warmUp.unref();
    }

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
        // The worker stops FIRST: it holds claims, and a claim outliving the
        // server it reports to becomes an ambiguous turn on the next start.
        await embedded?.stop();
        // The socket before the browser it fronts: a listener that outlived
        // its browser would answer tool calls with a runtime already closing.
        await browserSocket?.close();
        await sessionsRunSocket?.close();
        // Kernels beside the browser: both are processes a turn borrowed and
        // the daemon owns, and both leak past a daemon that does not stop them.
        await kernels?.disposeAll("engine shutting down");
        // Compile and tlmgr jobs are subprocesses of the same kind.
        store.latexJobs.disposeAll();
        // After the worker, before the lock: a live Chromium holding a profile
        // lock outlives the process that spawned it otherwise.
        await browser?.close("engine shutting down");
        await closeServer(server);
        clearInterval(workerPruner);
        removeOwnDiscovery(store, daemonId);
        lock.release();
      },
    };
  } catch (error) {
    clearInterval(workerPruner);
    server.close();
    lock.release();
    throw error;
  }
}
