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
  type EngineDiscovery,
  type EngineErrorCode,
  type EngineHealth,
  type TurnSubmissionResult,
  type WorkerStatus,
} from "@telar/engine-client";
import { acquireDaemonLock, EngineStateError, EngineStore, statePaths, vnextRootFromEnv } from "./state";

type RegisteredWorker = { workerId: string; registeredAt: number; heartbeatAt: number };

export type EngineDaemonOptions = {
  vnextRoot?: string;
  port?: number;
  now?: () => number;
  /** Worker liveness is deliberately short, but a lost running process remains ambiguous rather than replayed. */
  workerLeaseMs?: number;
  /** Testable cadence for pruning workers that can no longer heartbeat. */
  workerPruneIntervalMs?: number;
};

export type EngineDaemon = {
  discovery: EngineDiscovery;
  store: EngineStore;
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
  const match = /^\/v1\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), tail: match[2] ?? "" };
}

function turnPath(pathname: string): { sessionId: string; runId: string; action: "running" | "text" | "complete" | "fail" | "discard" } | undefined {
  const match = /^\/v1\/sessions\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\/(running|text|complete|fail|discard)$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]), action: match[3] as "running" | "text" | "complete" | "fail" | "discard" };
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
  const store = new EngineStore(root, options.now);
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
      if (request.method === "GET" && url.pathname === "/v1/health") {
        writeJson(response, 200, health());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/projects") {
        writeJson(response, 200, { projects: store.listProjects() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/projects") {
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
      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) throw new HttpError(400, "invalid_request", "projectId is required");
        writeJson(response, 200, { sessions: store.listSessions(projectId) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const input = await body(request);
        writeJson(response, 201, {
          session: store.createSession({
            id: stringValue(input.id, "session id", true),
            projectId: stringValue(input.projectId, "project id")!,
            title: stringValue(input.title, "session title", true),
          }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/workers/register") {
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

      const workerMatch = /^\/v1\/workers\/([A-Za-z0-9_-]+)\/(heartbeat|claim)$/.exec(url.pathname);
      if (workerMatch && request.method === "POST") {
        const workerId = decodeURIComponent(workerMatch[1]);
        const worker = activeWorker(workerId);
        worker.heartbeatAt = now();
        if (workerMatch[2] === "heartbeat") {
          const status: WorkerStatus = { workerId, heartbeatAt: worker.heartbeatAt, cancel: store.cancellationsForWorker(workerId) };
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
        } else if (turn.action === "text") {
          store.appendText(turn.sessionId, turn.runId, claimToken, stringValue(input.text, "text")!);
          writeJson(response, 200, {});
        } else if (turn.action === "complete") {
          writeJson(response, 200, {
            turn: store.completeTurn(
              turn.sessionId,
              turn.runId,
              claimToken,
              stringValue(input.text, "text")!,
              stringValue(input.providerSessionId, "provider session id", true),
            ),
          });
        } else {
          const code = stringValue(input.code, "failure code")!;
          if (code !== "provider_unavailable" && code !== "driver_failed") {
            throw new HttpError(400, "invalid_request", "failure code is invalid");
          }
          writeJson(response, 200, {
            turn: store.failTurn(turn.sessionId, turn.runId, claimToken, { code, message: stringValue(input.message, "failure message")! }),
          });
        }
        return;
      }

      const session = sessionPath(url.pathname);
      if (session) {
        if (request.method === "GET" && session.tail === "") {
          writeJson(response, 200, { session: store.getSession(session.sessionId), turns: store.turns(session.sessionId) });
          return;
        }
        if (request.method === "GET" && session.tail === "/events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          writeJson(response, 200, { events: store.readEvents(session.sessionId, after) });
          return;
        }
        if (request.method === "POST" && session.tail === "/turns") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no vNext worker is registered");
          const input = await body(request);
          const accepted = store.submitTurn(session.sessionId, {
            runId: stringValue(input.runId, "run id")!,
            text: stringValue(input.text, "turn text")!,
          });
          const result: TurnSubmissionResult = {
            ...accepted,
            execution: { status: "scheduled", code: "scheduled" },
          };
          writeJson(response, accepted.replayed ? 200 : 202, result);
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
    let closed = false;
    return {
      discovery,
      store,
      async close() {
        if (closed) return;
        closed = true;
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
