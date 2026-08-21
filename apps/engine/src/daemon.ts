// The engine owns its loopback listener and the only writable engine state root.
// It intentionally has no provider imports: Phase 1 proves ownership and crash
// semantics before a driver is allowed to execute an agent turn.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import {
  ENGINE_PROTOCOL_VERSION,
  parseForgeQuery,
  RequestOpenInput,
  resolveMcpServers,
  TurnModelSelection,
  type EngineDiscovery,
  type EngineErrorCode,
  type EngineHealth,
  type LoomProgram,
  type McpOAuthStatus,
  type McpServer,
  type ModelSelection,
  type ProviderDriverKind,
  type RuntimeMode,
  type TurnSubmissionResult,
  type WorkerStatus,
} from "@telar/engine-client";
import { runCliUpdate, type CliUpdateRun } from "./cli-updates";
import { beginConnect, checkMcpHealth, completeConnect, NO_CLIENT_STRATEGY, probeMcpAuth } from "./mcp-oauth";
import { createProviderProber, type VersionProbe } from "./provider-instances";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, statePaths, engineRootFromEnv, type EngineNotifier } from "./state";
import { collectWallTools, ensureSocketSecret, handleSocketMessage, socketConnectCard, type SocketTool } from "./spool/socket";
import type { SpoolCapability } from "./spool/tools";
import type { GhRunner } from "./github";
import { createLoomRuntime, type LoomAgent, type LoomSessionPort } from "./loom/dispatch";
import { createLoomAgent } from "./loom/agent";
import { createLoomSessionPort } from "./loom/session";
import { defaultLoomExec, type LoomExec } from "./loom/exec";
import { loomPaths, type LoomRuntime } from "./loom/store";
import { defaultGitRunner } from "./worktree";
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
  /**
   * ── THE LOOM'S FOUR INJECTION POINTS ──────────────────────────────────────
   *
   * Same promise as `gh` and `probeProviderVersion`, and the loom is where it
   * costs the most: a tick spawns the Program's own shell commands, cuts git
   * worktrees, starts sessions and spends a model call. A route test that drives
   * `POST /v2/looms/tick` must do none of those, so all four defaults are
   * replaceable and every test in this repo replaces them.
   *
   * The whole runtime, pre-composed. Short-circuits the other three and the
   * worktree machinery behind them — what a ROUTE test wants, where the seam
   * under test is the arms rather than the orchestrator.
   */
  loomRuntime?: LoomRuntime;
  /** The one place a Program's shell command runs. The default spawns for real
   *  (`loom/exec.ts`); a test hands back canned stdout instead. */
  loomExec?: LoomExec;
  /**
   * How a tick reaches a model — prompt in, `TickDecision` out.
   *
   * NO REAL DEFAULT EXISTS YET, and the placeholder REFUSES rather than
   * pretending: a run that failed saying "no orchestrator agent is wired into
   * this daemon" sends a person to the wiring, while one that quietly decided
   * nothing sends them to re-read their Program.
   */
  loomAgent?: LoomAgent;
  /**
   * How the runtime reaches Telar sessions — `start` for a worker in its own
   * worktree, `create` for the conversational orchestrator pinned to the
   * project's own root. Same placeholder rule as `loomAgent`.
   */
  loomSession?: LoomSessionPort;
  /** The sentinel's recurring timer, in `daemon.ts:343`'s shape, so a test can
   *  fire the supervisor's passes by hand instead of waiting on a clock. */
  loomInterval?: (fn: () => void, ms: number) => { clear(): void };
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
  /** Present only when `embeddedWorker` was requested. */
  worker?: { workerId: string };
  close(): Promise<void>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: EngineErrorCode,
    message: string,
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

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function bearerIsValid(value: string | undefined, token: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
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

/**
 * `?project=` — required on every project-scoped loom read.
 *
 * ONE OF THE TWO THINGS THE LOOM ROUTES REJECT THEMSELVES. Validation otherwise
 * lives in the store, so an in-process caller meets the same wall; but a param
 * that never arrived is invisible from there — the store would simply be handed
 * `undefined` and refuse in the vocabulary of ids rather than of query strings.
 */
function loomProject(url: URL): string {
  const raw = url.searchParams.get("project");
  if (raw === null || raw.trim() === "") {
    throw new HttpError(400, "invalid_request", "project is required — name the project whose loom you mean, as ?project=<id>.");
  }
  return raw;
}

/** `?limit=` — the newest N ledger entries. Absent is "as many as the store
 *  keeps". The other thing the store cannot see: a non-number would reach it as
 *  `NaN` and quietly return nothing, which reads as an empty ledger. */
function loomLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_request", `limit must be a positive whole number — got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

function sessionPath(pathname: string): { sessionId: string; tail: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), tail: match[2] ?? "" };
}

type TurnAction = "running" | "observe" | "request" | "complete" | "fail" | "discard";

function turnPath(pathname: string): { sessionId: string; runId: string; action: TurnAction } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\/(running|observe|request|complete|fail|discard)$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]), action: match[3] as TurnAction };
}

/** `POST /v2/sessions/:id/requests/:requestId` — a human answering. */
function requestPath(pathname: string): { sessionId: string; requestId: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/requests\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), requestId: decodeURIComponent(match[2]) };
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

/**
 * The Program document, or `undefined` for a project this engine does not know.
 *
 * The runtime asks per tick and must not be handed a throw for the ordinary
 * case: `loomProgram` refuses an unregistered project (correctly — that is the
 * id guard), but "this project is not registered" is a state the sentinel walks
 * past rather than an error it reports.
 */
function readLoomProgramFor(store: EngineStore, projectId: string): { program: LoomProgram | null; markdown: string } | undefined {
  try {
    const doc = store.loomProgram(projectId);
    return { program: doc.program, markdown: doc.markdown };
  } catch {
    return undefined;
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
  });
  const lock = acquireDaemonLock(statePaths(root));
  const daemonId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const startedAt = (options.now ?? Date.now)();
  const workers = new Map<string, RegisteredWorker>();
  const now = options.now ?? Date.now;
  const workerLeaseMs = options.workerLeaseMs ?? 15_000;
  /**
   * THE LOOM'S RUNTIME, COMPOSED AND ATTACHED — the one call that turns the
   * `/v2/looms/**` arms from "wired but refusing" into a working orchestrator.
   *
   * ATTACHED RATHER THAN CONSTRUCTED BY THE STORE, matching `attachBrowser`:
   * the store keeps no dependency on worktrees, shells or model calls, so every
   * test that builds an `EngineStore` directly still builds one that cannot
   * spawn anything.
   *
   * CONSTRUCTION ARMS NO TIMER. The supervisor starts its interval on the first
   * `startLoomWatch` and stops it when the last watch does, so a first-run
   * daemon with no project and no Program on disk starts clean and probes
   * nothing — which is the property that lets this run unconditionally.
   *
   * `loomRuntime` short-circuits the whole composition, which is what a route
   * test wants: the seam under test is the arms, not the worktree machinery.
   */
  const loomRuntime: LoomRuntime & { resume?: () => void } =
    options.loomRuntime ??
      createLoomRuntime({
        paths: loomPaths(root),
        engineRoot: root,
        now: () => new Date((options.now ?? Date.now)()),
        exec: options.loomExec ?? defaultLoomExec,
        /**
         * THE TWO EXPENSIVE PORTS, REAL — and both INERT AT CONSTRUCTION, which
         * is what lets them be wired unconditionally here.
         *
         * `createLoomAgent` allocates a closure: no Claude SDK is imported and
         * no CLI is resolved until a tick actually asks, so a daemon that never
         * ticks never touches a provider. `createLoomSessionPort` closes over
         * the store it was handed and creates nothing until a loom is
         * dispatched. Every existing test starts a daemon that reaches neither.
         *
         * Still overridable, and every loom test in this repo overrides them:
         * the seam under test is usually the arms or the machinery, not the
         * model call.
         */
        agent:
          options.loomAgent ??
          createLoomAgent({
            // The SAME registry-anchored resolver the runtime uses, so the
            // orchestrator's `Read`/`Grep` can only ever see a checkout the
            // user registered.
            projectRoot: (projectId) => store.listProjects().find((project) => project.id === projectId)?.root ?? null,
          }),
        session: options.loomSession ?? createLoomSessionPort({ store }),
        git: defaultGitRunner,
        // The project's root comes from the REGISTRY, never from a caller: it is
        // the same rule `loomProgram` states, and it is what keeps every path
        // the runtime composes anchored to something the user registered.
        projectRoot: (projectId) => store.listProjects().find((project) => project.id === projectId)?.root ?? null,
        readProgram: (projectId) => readLoomProgramFor(store, projectId)?.program ?? null,
        readProgramMarkdown: (projectId) => readLoomProgramFor(store, projectId)?.markdown ?? null,
        ...(options.loomInterval ? { interval: options.loomInterval } : {}),
      });
  store.attachLoomRuntime(loomRuntime);
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
    const expired = [...workers.values()].filter((worker) => now() - worker.heartbeatAt > workerLeaseMs);
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

  const health = (): EngineHealth => ({
    version: ENGINE_PROTOCOL_VERSION,
    daemonId,
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
      if (!bearerIsValid(request.headers.authorization, token)) {
        throw new HttpError(401, "engine_unauthorized", "engine authentication failed");
      }
      /**
       * ── THE LOOM ───────────────────────────────────────────────────────────
       *
       * Fourteen arms, grouped, with the LITERAL PATHS FIRST. `/v2/looms/program`
       * matches `^/v2/looms/([^/]+)$` exactly as well as a loom id does, so the
       * regex arms sit at the BOTTOM of this block and nowhere else. Hoisting one
       * of them turns the Program editor into "no loom by that id", which is a
       * confusing enough failure to be worth stating here rather than rediscovering.
       *
       * NO SCHEMA PARSE AT THIS EDGE. Validation lives in the store (build spec
       * §14), so an in-process caller hits the same wall an HTTP one does. What
       * these arms reject is only what the store CANNOT see: a query param that
       * never arrived, and a `limit` that is not a number. Everything else comes
       * back as the store's own sentence, carried by `errorFor`.
       *
       * Every store call here is awaited. Several of them read the filesystem and
       * one of them starts a run; awaiting a synchronous answer costs a microtask,
       * while forgetting to await an asynchronous one serialises `{}` to the wire.
       */
      if (request.method === "GET" && url.pathname === "/v2/looms") {
        // BARE, like `GET /v2/spool`: the deck's one-call snapshot IS the body
        // rather than a key inside one. Two surfaces fetched on separate cadences
        // disagree with no way to tell which is stale — the reason §15.6 makes
        // this one read in the first place.
        writeJson(response, 200, await store.loomOverview());
        return;
      }
      if (url.pathname === "/v2/looms/program") {
        /**
         * THE PROGRAM ARTIFACT — the file the user writes and the orchestrator
         * obeys. A project that has never written one answers `exists: false`
         * carrying the path it WOULD live at, never a 404: "there is no Program
         * yet" is the ordinary first-run state, and the editor has to render it
         * to be the thing that fixes it.
         */
        if (request.method === "GET") {
          writeJson(response, 200, await store.loomProgram(loomProject(url)));
          return;
        }
        /**
         * PUT because a save replaces the one whole document — idempotent, last
         * writer wins. The parse warnings ride back on the same answer, so a save
         * and a lint are never two round trips that can disagree.
         */
        if (request.method === "PUT") {
          const input = await body(request);
          const projectId = stringValue(input.projectId, "projectId", true);
          if (projectId === undefined) {
            throw new HttpError(400, "invalid_request", "projectId is required — name the project this Program belongs to.");
          }
          const markdown = stringValue(input.markdown, "markdown", true);
          if (markdown === undefined) {
            throw new HttpError(400, "invalid_request", "markdown is required — a save replaces the whole document, so send all of it.");
          }
          writeJson(response, 200, await store.saveLoomProgram(projectId, markdown));
          return;
        }
      }
      if (request.method === "POST" && url.pathname === "/v2/looms/program/suggest") {
        /**
         * READS THE REPOSITORY AND PROPOSES A DRAFT — it never saves one. The
         * answer is markdown the user still has to accept through the `PUT`
         * above, plus the findings that produced it, so nothing a model guessed
         * becomes the standing instruction without a hand on it.
         */
        const input = await body(request);
        const projectId = stringValue(input.projectId, "projectId", true);
        if (projectId === undefined) {
          throw new HttpError(400, "invalid_request", "projectId is required — name the project to read before drafting a Program.");
        }
        writeJson(response, 200, await store.suggestLoomProgram(projectId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/looms/ledger") {
        // WHAT THE LOOM DID, in its own words. `?limit=` is the newest N; absent
        // is as many as the store keeps.
        writeJson(response, 200, await store.loomLedger(loomProject(url), loomLimit(url)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/looms/triage") {
        writeJson(response, 200, await store.loomTriage(loomProject(url)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/looms/work") {
        /**
         * WHAT IS RUNNING RIGHT NOW — in memory, across every project, which is
         * why it takes no `?project=`. This is the other half of the 202 below:
         * a tick answers immediately with its run and progress is read HERE. No
         * stream, no poll on the POST.
         */
        writeJson(response, 200, await store.loomWork());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/looms/watch") {
        /**
         * ONE ARM FOR BOTH DIRECTIONS. "Watch this project" and "stop watching
         * it" are one slot with two values, and a `running` flag says which —
         * two routes would let a surface believe it last called the other one.
         */
        const input = await body(request);
        const projectId = stringValue(input.projectId, "projectId", true);
        if (projectId === undefined) throw new HttpError(400, "invalid_request", "projectId is required — name the project to watch.");
        if (typeof input.running !== "boolean") {
          throw new HttpError(
            400,
            "invalid_request",
            `running must be true to start the watch or false to stop it — got ${JSON.stringify(input.running)}.`,
          );
        }
        writeJson(response, 200, input.running ? await store.startLoomWatch(projectId) : await store.stopLoomWatch(projectId));
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v2/looms/tick" || url.pathname === "/v2/looms/dry-run")) {
        /**
         * 202, AND THE RUN COMES BACK AT ONCE.
         *
         * A tick spends a model call and can run for minutes. Awaiting it here is
         * the mistake `/v2/spool/night` made and paid for inside one live run:
         * the caller's HTTP client gave up and reported the engine unreachable
         * while the daemon happily finished every job. The run record is the
         * receipt; `GET /v2/looms/work` is where the progress is.
         *
         * `dry-run` SHARES THIS ARM because it is the same request with the
         * publishing hands tied — two bodies differing by one word drift.
         */
        const input = await body(request);
        const projectId = stringValue(input.projectId, "projectId", true);
        if (projectId === undefined) throw new HttpError(400, "invalid_request", "projectId is required — name the project to tick.");
        writeJson(
          response,
          202,
          url.pathname === "/v2/looms/dry-run" ? await store.dryRunLoom(projectId) : await store.tickLoom(projectId),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/looms/dispatch") {
        /**
         * THE HAND'S OWN DISPATCH — the same verb a tick's decision reaches,
         * taken deliberately instead of derived. `title` and `brief` are optional
         * and absent means "the store reads them off the item", so they ride as
         * spreads: `JSON.stringify` erases an explicit `undefined`, which would
         * make "leave it to you" and a bug indistinguishable on the wire.
         */
        const input = await body(request);
        const projectId = stringValue(input.projectId, "projectId", true);
        if (projectId === undefined) throw new HttpError(400, "invalid_request", "projectId is required — name the project to dispatch into.");
        const item = stringValue(input.item, "item", true);
        if (item === undefined) {
          throw new HttpError(400, "invalid_request", "item is required — the work item to dispatch, in the vocabulary the Program's list command emits.");
        }
        const title = stringValue(input.title, "title", true);
        const brief = stringValue(input.brief, "brief", true);
        writeJson(
          response,
          200,
          await store.dispatchLoom(projectId, {
            item,
            ...(title === undefined ? {} : { title }),
            ...(brief === undefined ? {} : { brief }),
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/looms/session") {
        /**
         * THE CONVERSATION, ENSURED — create-or-return, the same singleton front
         * door `/v2/spool/master` is and for the same reason: "open this
         * project's orchestrator" and "make one if there has never been one" are
         * one request from the caller's side, and splitting them makes every
         * surface do the two-step. `created` says which happened, so the cockpit
         * can tell "resumed" from "started" without a second read.
         *
         * NOT THE TICK. A tick is headless, has no session and keeps no
         * transcript — that is the design's whole answer to context growth. This
         * is the room a HUMAN talks to, against the project's own root rather
         * than a worktree.
         */
        const input = await body(request);
        const projectId = stringValue(input.projectId, "projectId", true);
        if (projectId === undefined) {
          throw new HttpError(400, "invalid_request", "projectId is required — name the project whose orchestrator you want to talk to.");
        }
        writeJson(response, 200, await store.ensureLoomSession(projectId));
        return;
      }
      /**
       * ONE LOOM, BY ID. LAST IN THE BLOCK on purpose — see the header: this
       * regex matches `/v2/looms/program` too, so every literal path above has
       * already had its turn by the time control arrives here. An id nothing
       * goes by is the store's `not_found`, which `errorFor` turns into a 404
       * WITH the sentence rather than a bare status.
       */
      const loomById = /^\/v2\/looms\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && loomById) {
        writeJson(response, 200, { loom: await store.loom(decodeURIComponent(loomById[1])) });
        return;
      }
      const loomCancel = /^\/v2\/looms\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && loomCancel) {
        // NO BODY. Cancelling is not a decision with options — a reason field
        // here would be a second way to say what the ledger already records.
        writeJson(response, 200, await store.cancelLoom(decodeURIComponent(loomCancel[1])));
        return;
      }
      const loomAnswer = /^\/v2\/looms\/([^/]+)\/answer$/.exec(url.pathname);
      if (request.method === "POST" && loomAnswer) {
        const input = await body(request);
        const answer = stringValue(input.answer, "answer", true);
        if (answer === undefined) {
          throw new HttpError(
            400,
            "invalid_request",
            "answer is required — the loom is parked on a question, and it stays parked until somebody says something.",
          );
        }
        writeJson(response, 200, await store.answerLoom(decodeURIComponent(loomAnswer[1]), answer));
        return;
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
        writeJson(response, 200, {
          catalogue: await store.modelCatalogue(driver as "claude" | "codex", { force: url.searchParams.get("refresh") === "1" }),
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
            ...("autoSettleAfterDays" in input ? { autoSettleAfterDays: input.autoSettleAfterDays } : {}),
          }),
        });
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
        writeJson(response, 200, { git: store.projectGit(decodeURIComponent(projectGit[1])) });
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
            file: store.projectFilePatch(projectId, target, { untracked: url.searchParams.get("untracked") === "1" }),
          });
          return;
        }
        writeJson(response, 200, { diff: store.projectDiff(projectId) });
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
          writeJson(response, 200, { file: store.projectFile(projectId, target) });
          return;
        }
        writeJson(response, 200, { listing: store.projectFiles(projectId) });
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
      if (request.method === "POST" && url.pathname === "/v2/sessions") {
        const input = await body(request);
        writeJson(response, 201, {
          session: store.createSession({
            id: stringValue(input.id, "session id", true),
            projectId: stringValue(input.projectId, "project id")!,
            title: stringValue(input.title, "session title", true),
            ...(typeof input.detached === "boolean" ? { detached: input.detached } : {}),
            ...(input.envMode === "worktree" || input.envMode === "local" ? { envMode: input.envMode } : {}),
            // Validated in the store rather than here, so the HTTP surface and
            // any in-process caller reject the same set of drivers.
            ...(typeof input.driver === "string" ? { driver: input.driver as "claude" | "codex" } : {}),
            // Naming an instance also names the driver, so the store ignores
            // `driver` when this is present rather than refusing the pair.
            ...(typeof input.providerInstanceId === "string" ? { providerInstanceId: input.providerInstanceId } : {}),
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
        const input = await body(request);
        const claimToken = stringValue(input.claimToken, "claim token")!;
        if (turn.action === "running") {
          writeJson(response, 200, { turn: store.markRunning(turn.sessionId, turn.runId, claimToken) });
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
          }),
        });
        return;
      }

      const session = sessionPath(url.pathname);
      if (session) {
        if (request.method === "GET" && session.tail === "") {
          writeJson(response, 200, {
            session: store.getSession(session.sessionId),
            turns: store.turns(session.sessionId),
            items: store.items(session.sessionId),
            requests: store.requests(session.sessionId),
            // On the snapshot rather than behind its own route: a background
            // task outlives its turn, so "is this session still working" must
            // be answerable from the FIRST fetch of a cold session, before any
            // event has streamed.
            tasks: store.tasks(session.sessionId),
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
              file: store.sessionFilePatch(session.sessionId, target, { untracked: url.searchParams.get("untracked") === "1" }),
            });
            return;
          }
          writeJson(response, 200, { diff: store.sessionDiff(session.sessionId) });
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
            writeJson(response, 200, { file: store.sessionFile(session.sessionId, target) });
            return;
          }
          writeJson(response, 200, { listing: store.sessionFiles(session.sessionId) });
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
        if (request.method === "POST" && session.tail === "/turns") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
          const input = await body(request);
          const model = TurnModelSelection.safeParse(input.model);
          if (input.model !== undefined && !model.success) {
            throw new HttpError(400, "invalid_request", "turn model selection is invalid");
          }
          const accepted = store.submitTurn(session.sessionId, {
            runId: stringValue(input.runId, "run id")!,
            input: stringValue(input.input, "turn input")!,
            ...(model.success ? { model: model.data } : {}),
            ...(Array.isArray(input.attachments) ? { attachments: input.attachments.map((id) => stringValue(id, "attachment id")!) } : {}),
          });
          const result: TurnSubmissionResult = accepted;
          writeJson(response, accepted.replayed ? 200 : 202, result);
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
      }
      throw new HttpError(404, "not_found", "engine endpoint does not exist");
    } catch (error) {
      const normalized = errorFor(error);
      writeJson(response, normalized.status, { error: { code: normalized.code, message: normalized.message } });
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

    /**
     * THE WATCHES A HUMAN ALREADY TURNED ON, PICKED BACK UP — after recovery
     * and after discovery, the same rule the embedded worker below follows, so
     * nothing probes against a pre-recovery store.
     *
     * WITHOUT THIS THE SEAM TELLS A LIE rather than merely going quiet:
     * `running` is persisted, so `loomOverview` keeps reporting
     * `watch.running: true` and the deck keeps drawing "watching" while no
     * probe ever fires again until someone toggles the switch off and on.
     * Measured, not assumed — a second daemon over the same engine root probed
     * zero times. A first-run engine has no watch record saying `running`, so
     * the guard inside `resume` makes this a no-op there.
     *
     * OPTIONAL BECAUSE AN INJECTED `loomRuntime` IS A BARE `LoomRuntime`: a
     * route test that swaps the orchestrator out has no supervisor to resume,
     * and must not be made to grow one.
     */
    loomRuntime.resume?.();

    // The embedded worker starts AFTER discovery is published, because it
    // connects through the same discovery document every other client uses
    // rather than through a private in-process shortcut. That keeps one code
    // path for claim/heartbeat/observe instead of two that can diverge.
    let embedded: { workerId: string; stop(): Promise<void> } | undefined;
    let browser: import("./browser").BrowserRuntime | undefined;
    if (options.embeddedWorker) {
      const config = options.embeddedWorker === true ? {} : options.embeddedWorker;
      const [{ EngineClient }, { EngineWorker }] = await Promise.all([
        import("@telar/engine-client"),
        import("./worker"),
      ]);
      // The daemon owns the browser, not the driver: it outlives any turn and
      // has to be closed exactly once. `release(sessionId)` on archive is what
      // keeps Chromium instances from accumulating until the pool evicts them.
      const { BrowserRuntime } = await import("./browser");
      browser = new BrowserRuntime();
      store.attachBrowser(browser);
      const capability = (await import("./drivers")).browserCapability(browser);
      const createDriver =
        config.createDriver ?? (async () => (await import("./drivers")).createDefaultDrivers({ browser: capability }));
      const workerId = config.workerId ?? `worker_embedded_${crypto.randomUUID().replaceAll("-", "")}`;
      const worker = new EngineWorker({
        client: new EngineClient(discovery),
        workerId,
        driver: await createDriver(),
        ...(config.pollMs === undefined ? {} : { pollMs: config.pollMs }),
      });
      await worker.start();
      embedded = { workerId, stop: () => worker.stop() };
    }

    let closed = false;
    return {
      discovery,
      store,
      ...(embedded ? { worker: { workerId: embedded.workerId } } : {}),
      async close() {
        if (closed) return;
        closed = true;
        // The worker stops FIRST: it holds claims, and a claim outliving the
        // server it reports to becomes an ambiguous turn on the next start.
        await embedded?.stop();
        // After the worker, before the lock: a live Chromium holding a profile
        // lock outlives the process that spawned it otherwise.
        await browser?.close("engine shutting down");
        await closeServer(server);
        clearInterval(workerPruner);
        // The supervisor's interval, beside the other one and for the same
        // reason: a timer that outlives `close()` hangs a suite instead of
        // failing it. A no-op when nothing was ever attached.
        store.closeLoomRuntime();
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
