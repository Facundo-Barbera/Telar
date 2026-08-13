// The engine owns its loopback listener and the only writable vNext state root.
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
  type McpOAuthStatus,
  type McpServer,
  type ModelSelection,
  type ProviderDriverKind,
  type RuntimeMode,
  type TurnSubmissionResult,
  type WorkerStatus,
} from "@telar/engine-client";
import { beginConnect, checkMcpHealth, completeConnect, NO_CLIENT_STRATEGY, probeMcpAuth } from "./mcp-oauth";
import { createProviderProber, type VersionProbe } from "./provider-instances";
import { acquireDaemonLock, EngineStateError, EngineStore, statePaths, vnextRootFromEnv, type EngineNotifier } from "./state";
import type { DriverSelector } from "./worker";

type RegisteredWorker = { workerId: string; registeredAt: number; heartbeatAt: number };

export type EngineDaemonOptions = {
  vnextRoot?: string;
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
   * Run a worker inside the daemon process.
   *
   * WHY THIS EXISTS: without it, `startEngine()` produces a control plane that
   * accepts turns and then refuses them — `POST /turns` 503s with
   * `worker_unavailable` until a SEPARATE `bun run worker` process registers.
   * "The engine runs on its own" was therefore false in the most literal sense:
   * one process was never enough. `scripts/vnext-dev.mjs` papered over it by
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
  probeProviderVersion?: (driver: ProviderDriverKind) => Promise<VersionProbe>;
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
  return new HttpError(500, "internal_error", "vNext engine encountered an internal error");
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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function startEngine(options: EngineDaemonOptions = {}): Promise<EngineDaemon> {
  const root = options.vnextRoot ?? vnextRootFromEnv();
  const store = new EngineStore(root, options.now, { ...(options.notifier ? { notifier: options.notifier } : {}) });
  const lock = acquireDaemonLock(statePaths(root));
  const daemonId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const startedAt = (options.now ?? Date.now)();
  const workers = new Map<string, RegisteredWorker>();
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
    if (!worker) throw new HttpError(503, "worker_unavailable", "vNext worker is not registered or its lease expired");
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

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!bearerIsValid(request.headers.authorization, token)) {
        throw new HttpError(401, "engine_unauthorized", "vNext engine authentication failed");
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
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no vNext worker is registered");
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
        if (request.method === "POST" && session.tail === "/stop") {
          const input = await body(request);
          writeJson(response, 200, store.stopTurn(session.sessionId, stringValue(input.runId, "run id", true)));
          return;
        }
      }
      throw new HttpError(404, "not_found", "vNext engine endpoint does not exist");
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
    if (!address || typeof address === "string") throw new Error("vNext engine did not bind a TCP port");
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
