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
  RequestOpenInput,
  type EngineDiscovery,
  type EngineErrorCode,
  type EngineHealth,
  type TurnSubmissionResult,
  type WorkerStatus,
} from "@telar/engine-client";
import type { TurnDriver } from "./driver";
import { acquireDaemonLock, EngineStateError, EngineStore, statePaths, vnextRootFromEnv, type EngineNotifier } from "./state";

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
  embeddedWorker?: boolean | { workerId?: string; pollMs?: number; createDriver?: () => Promise<TurnDriver> | TurnDriver };
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
      if (request.method === "GET" && url.pathname === "/v2/projects") {
        writeJson(response, 200, { projects: store.listProjects() });
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
          writeJson(response, 200, { claim: store.claimNextTurn(workerId) });
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
        if (request.method === "POST" && session.tail === "/turns") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no vNext worker is registered");
          const input = await body(request);
          const accepted = store.submitTurn(session.sessionId, {
            runId: stringValue(input.runId, "run id")!,
            input: stringValue(input.input, "turn input")!,
          });
          const result: TurnSubmissionResult = accepted;
          writeJson(response, accepted.replayed ? 200 : 202, result);
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
      const { BrowserRuntime, BROWSER_TOOLS } = await import("./browser");
      browser = new BrowserRuntime();
      store.attachBrowser(browser);
      // The capability is ASSEMBLED HERE rather than being the runtime itself:
      // the driver must not import ./browser, or every driver would drag
      // Chromium's transport in whether or not a session ever browses.
      const capability = {
        call: (scopeKey: string, name: string, args?: Record<string, unknown>) => browser!.call(scopeKey, name, args),
        isReadOnly: (name: string, args?: Record<string, unknown>) => browser!.isReadOnly(name, args),
        tools: BROWSER_TOOLS,
      };
      const createDriver =
        config.createDriver ?? (async () => (await import("./driver")).createClaudeDriver(undefined, { browser: capability }));
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
