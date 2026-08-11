// vNext state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/vnext` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineEvent, EngineProject, EngineSession, EngineTurn, TurnState } from "@telar/engine-client";

const ID = /^[A-Za-z0-9_-]+$/;
const MAX_TEXT_LENGTH = 200_000;

export class EngineStateError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "EngineStateError";
  }
}

export type EngineStatePaths = {
  root: string;
  projects: string;
  sessions: string;
  engine: string;
  lock: string;
};

export function vnextRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim();
  if (!home) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be explicitly set for the vNext engine");
  }
  if (!path.isAbsolute(home)) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be an absolute path for the vNext engine");
  }
  const resolved = canonicalPath(home);
  for (const legacy of [".telar", ".telar-dev"]) {
    const legacyRoot = canonicalPath(path.join(os.homedir(), legacy));
    if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
      throw new EngineStateError("invalid_request", "TELAR_HOME must not point at legacy Telar state");
    }
  }
  return path.join(resolved, "vnext");
}

/** Resolve existing symlinks while also handling a not-yet-created state root. */
function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = fs.realpathSync.native(existing);
  for (const segment of missing) canonical = path.join(canonical, segment);
  return canonical;
}

export function statePaths(root: string): EngineStatePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    projects: path.join(resolved, "projects.json"),
    sessions: path.join(resolved, "sessions"),
    engine: path.join(resolved, "engine.json"),
    lock: path.join(resolved, "engine.lock"),
  };
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new EngineStateError("invalid_request", `${label} must contain only letters, numbers, underscores, or hyphens`);
  }
}

function assertText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new EngineStateError("invalid_request", "turn text must be non-empty and within the allowed size");
  }
}

/** Stream deltas may legitimately be a space or newline; only user prompts must be non-blank. */
function assertStreamText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new EngineStateError("invalid_request", "stream text must be non-empty and within the allowed size");
  }
}

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new EngineStateError("invalid_request", `${label} must be an absolute path`);
  }
}

/** Document writes use a unique temp file + rename; journals are the explicit O_APPEND exception. */
function atomicWrite(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type ProjectRegistry = { version: 1; projects: EngineProject[] };
type SessionQueue = { version: 1; sessionId: string; nextSequence: number; turns: EngineTurn[] };

const emptyRegistry = (): ProjectRegistry => ({ version: 1, projects: [] });
const emptyQueue = (sessionId: string): SessionQueue => ({ version: 1, sessionId, nextSequence: 1, turns: [] });

function latestProviderSessionId(queue: SessionQueue): string | undefined {
  return queue.turns
    .filter((turn) => turn.state === "completed" && typeof turn.providerSessionId === "string" && turn.providerSessionId.trim())
    .sort((left, right) => right.sequence - left.sequence)[0]?.providerSessionId;
}

function parseRegistry(value: unknown): ProjectRegistry {
  const registry = value as Partial<ProjectRegistry> | null;
  if (!registry || registry.version !== 1 || !Array.isArray(registry.projects)) {
    throw new Error("invalid vNext project registry");
  }
  for (const project of registry.projects) {
    assertId(project.id, "project id");
    assertAbsolutePath(project.root, "project root");
    if (typeof project.name !== "string" || project.name.trim() === "") throw new Error("invalid project name");
    if (!Number.isFinite(project.createdAt) || !Number.isFinite(project.updatedAt)) throw new Error("invalid project timestamp");
  }
  return registry as ProjectRegistry;
}

function parseSession(value: unknown): EngineSession {
  const session = value as Partial<EngineSession> | null;
  if (
    !session ||
    typeof session.id !== "string" ||
    typeof session.projectId !== "string" ||
    typeof session.title !== "string" ||
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.updatedAt) ||
    !session.provider ||
    session.provider.kind !== "claude" ||
    (session.provider.sessionId !== undefined && (typeof session.provider.sessionId !== "string" || !session.provider.sessionId.trim()))
  ) {
    throw new Error("invalid vNext session metadata");
  }
  assertId(session.id, "session id");
  assertId(session.projectId, "project id");
  return session as EngineSession;
}

function isTurnState(value: unknown): value is TurnState {
  return (
    value === "queued" ||
    value === "claimed" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "ambiguous" ||
    value === "discarded"
  );
}

function parseQueue(value: unknown, sessionId: string): SessionQueue {
  const queue = value as Partial<SessionQueue> | null;
  if (
    !queue ||
    queue.version !== 1 ||
    queue.sessionId !== sessionId ||
    !Number.isSafeInteger(queue.nextSequence) ||
    !Array.isArray(queue.turns)
  ) {
    throw new Error("invalid vNext session queue");
  }
  const ids = new Set<string>();
  for (const turn of queue.turns) {
    assertId(turn.runId, "run id");
    if (ids.has(turn.runId)) throw new Error("duplicate vNext turn id");
    ids.add(turn.runId);
    assertText(turn.text);
    if (!isTurnState(turn.state) || !Number.isSafeInteger(turn.sequence)) throw new Error("invalid vNext turn state");
    if (!Number.isFinite(turn.acceptedAt) || !Number.isFinite(turn.updatedAt)) throw new Error("invalid vNext turn timestamp");
  }
  return queue as SessionQueue;
}

function sessionDir(paths: EngineStatePaths, sessionId: string): string {
  assertId(sessionId, "session id");
  const directory = path.join(paths.sessions, sessionId);
  const prefix = paths.sessions.endsWith(path.sep) ? paths.sessions : `${paths.sessions}${path.sep}`;
  if (!directory.startsWith(prefix)) throw new EngineStateError("invalid_request", "unsafe session path");
  return directory;
}

function sessionMetadataFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "session.json");
}

function sessionQueueFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "queue.json");
}

function eventsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "events.ndjson");
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readJournal(file: string): EngineEvent[] {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const complete = raw.at(-1) === 0x0a;
  const lines = raw.toString("utf8").split("\n");
  if (complete) lines.pop();
  const events: EngineEvent[] = [];
  let repairedInterruptedRecord = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    let event: EngineEvent;
    try {
      event = JSON.parse(line) as EngineEvent;
    } catch (error) {
      // Only an unterminated final record can be an interrupted append. A
      // malformed complete record is durable corruption and must be surfaced.
      if (!complete && index === lines.length - 1) {
        const lastNewline = raw.lastIndexOf(0x0a);
        fs.truncateSync(file, lastNewline < 0 ? 0 : lastNewline + 1);
        repairedInterruptedRecord = true;
        break;
      }
      throw error;
    }
    if (!Number.isSafeInteger(event.id) || event.id < 1 || !Number.isFinite(event.at) || typeof event.type !== "string") {
      throw new Error("invalid vNext event journal");
    }
    events.push(event);
  }
  // A crash can happen after the JSON bytes reached disk but before the
  // newline. Preserve that valid final observation and restore the NDJSON
  // delimiter before a subsequent append can concatenate two records.
  if (!complete && !repairedInterruptedRecord && lines.at(-1)) fs.appendFileSync(file, "\n", { mode: 0o600 });
  return events;
}

export class EngineStore {
  readonly paths: EngineStatePaths;

  constructor(root: string, private readonly now: () => number = Date.now) {
    this.paths = statePaths(root);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
  }

  listProjects(): EngineProject[] {
    const registry = readJson(this.paths.projects);
    return registry === undefined ? [] : structuredClone(parseRegistry(registry).projects);
  }

  registerProject(input: { id?: string; name: string; root: string }): EngineProject {
    if (input.id !== undefined) assertId(input.id, "project id");
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new EngineStateError("invalid_request", "project name must be non-empty");
    }
    assertAbsolutePath(input.root, "project root");
    let projectRoot: string;
    try {
      projectRoot = fs.realpathSync.native(input.root);
    } catch {
      throw new EngineStateError("invalid_request", "project root must be an existing directory");
    }
    if (!fs.statSync(projectRoot).isDirectory()) throw new EngineStateError("invalid_request", "project root must be an existing directory");
    const registry = (readJson(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registry);
    const id = input.id ?? `project_${crypto.randomUUID().replaceAll("-", "")}`;
    const existing = parsed.projects.find((project) => project.id === id || project.root === projectRoot);
    if (existing) {
      if (existing.id === id && existing.root === projectRoot) return structuredClone(existing);
      throw new EngineStateError("conflict", "project id or root is already registered");
    }
    const at = this.now();
    const project: EngineProject = { id, name: input.name.trim(), root: projectRoot, createdAt: at, updatedAt: at };
    parsed.projects.push(project);
    atomicWrite(this.paths.projects, parsed);
    return structuredClone(project);
  }

  getProject(projectId: string): EngineProject {
    assertId(projectId, "project id");
    const project = this.listProjects().find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    return project;
  }

  createSession(input: { id?: string; projectId: string; title?: string }): EngineSession {
    if (input.id !== undefined) assertId(input.id, "session id");
    this.getProject(input.projectId);
    const id = input.id ?? `session_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = sessionMetadataFile(this.paths, id);
    const existing = readJson(metadata);
    if (existing !== undefined) {
      const session = parseSession(existing);
      if (session.projectId === input.projectId) return structuredClone(session);
      throw new EngineStateError("conflict", "session id is already owned by another project");
    }
    const at = this.now();
    const session: EngineSession = {
      id,
      projectId: input.projectId,
      title: input.title?.trim() || "New session",
      createdAt: at,
      updatedAt: at,
      provider: { kind: "claude" },
    };
    atomicWrite(metadata, session);
    atomicWrite(sessionQueueFile(this.paths, id), emptyQueue(id));
    this.appendEvent(id, "session.created", { projectId: session.projectId });
    return structuredClone(session);
  }

  getSession(sessionId: string): EngineSession {
    const stored = readJson(sessionMetadataFile(this.paths, sessionId));
    if (stored === undefined) throw new EngineStateError("not_found", "session does not exist");
    return structuredClone(parseSession(stored));
  }

  listSessions(projectId: string): EngineSession[] {
    this.getProject(projectId);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.paths.sessions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && ID.test(entry.name))
      .flatMap((entry) => {
        try {
          const session = this.getSession(entry.name);
          return session.projectId === projectId ? [session] : [];
        } catch (error) {
          if (error instanceof EngineStateError && error.code === "not_found") return [];
          throw error;
        }
      })
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  turns(sessionId: string): EngineTurn[] {
    this.getSession(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  submitTurn(sessionId: string, input: { runId: string; text: string }): { turn: EngineTurn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.text);
    this.getSession(sessionId);
    const queue = this.readQueue(sessionId);
    const known = queue.turns.find((turn) => turn.runId === input.runId);
    if (known) {
      if (known.text !== input.text) throw new EngineStateError("conflict", "run id was already submitted with different text");
      return { turn: structuredClone(known), replayed: true };
    }
    if (queue.turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running")) {
      throw new EngineStateError("conflict", "session already has an active turn");
    }
    if (queue.turns.some((turn) => turn.state === "ambiguous")) {
      throw new EngineStateError("conflict", "session has an ambiguous turn that must be resolved first");
    }
    const at = this.now();
    const turn: EngineTurn = {
      runId: input.runId,
      sequence: queue.nextSequence++,
      text: input.text,
      state: "queued",
      acceptedAt: at,
      updatedAt: at,
    };
    queue.turns.push(turn);
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.accepted", { sequence: turn.sequence }, turn.runId);
    return { turn: structuredClone(turn), replayed: false };
  }

  claimTurn(sessionId: string, workerId: string): EngineTurn | undefined {
    assertId(workerId, "worker id");
    const queue = this.readQueue(sessionId);
    if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) return undefined;
    const turn = queue.turns.find((candidate) => candidate.state === "queued");
    if (!turn) return undefined;
    const at = this.now();
    turn.state = "claimed";
    turn.claim = { workerId, token: crypto.randomUUID(), at };
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.claimed", { workerId }, turn.runId);
    return structuredClone(turn);
  }

  /** Claims exactly one queued turn. The daemon has one state lock, so two workers cannot claim it twice. */
  claimNextTurn(workerId: string): { sessionId: string; projectRoot: string; provider: EngineSession["provider"]; turn: EngineTurn } | undefined {
    assertId(workerId, "worker id");
    for (const session of this.allSessions().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const turn = this.claimTurn(session.id, workerId);
      if (turn) return { sessionId: session.id, projectRoot: this.getProject(session.projectId).root, provider: this.providerForSession(session), turn };
    }
    return undefined;
  }

  markRunning(sessionId: string, runId: string, claimToken: string): EngineTurn {
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "claimed" || turn.claim?.token !== claimToken) {
      throw new EngineStateError("conflict", "turn is not claimed by this worker");
    }
    const at = this.now();
    turn.state = "running";
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.running", {}, turn.runId);
    return structuredClone(turn);
  }

  appendText(sessionId: string, runId: string, claimToken: string, text: string): void {
    assertStreamText(text);
    const turn = this.requireRunningClaim(sessionId, runId, claimToken);
    this.appendEvent(sessionId, "turn.text", { text }, turn.runId);
  }

  completeTurn(sessionId: string, runId: string, claimToken: string, text: string, providerSessionId?: string): EngineTurn {
    if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
      throw new EngineStateError("invalid_request", "final text exceeds the allowed size");
    }
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const at = this.now();
    turn.state = "completed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.result = { text };
    if (providerSessionId !== undefined) {
      if (typeof providerSessionId !== "string" || !providerSessionId.trim() || providerSessionId.length > 4_000) {
        throw new EngineStateError("invalid_request", "provider session id is invalid");
      }
      turn.providerSessionId = providerSessionId;
    }
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at, providerSessionId);
    this.appendEvent(sessionId, "turn.final", { text }, turn.runId);
    return structuredClone(turn);
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: "provider_unavailable" | "driver_failed"; message: string },
  ): EngineTurn {
    if ((failure.code !== "provider_unavailable" && failure.code !== "driver_failed") || typeof failure.message !== "string" || !failure.message.trim()) {
      throw new EngineStateError("invalid_request", "turn failure is invalid");
    }
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const at = this.now();
    turn.state = "failed";
    turn.failedAt = at;
    turn.updatedAt = at;
    turn.failure = { code: failure.code, message: failure.message.slice(0, 4_000) };
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.error", turn.failure, turn.runId);
    return structuredClone(turn);
  }

  stopTurn(sessionId: string, requestedRunId?: string): { turn?: EngineTurn; stopped: boolean } {
    const queue = this.readQueue(sessionId);
    const turn = requestedRunId
      ? queue.turns.find((candidate) => candidate.runId === requestedRunId)
      : queue.turns.find((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "running");
    if (!turn) return { stopped: false };
    if (turn.state === "stopped" || turn.state === "ambiguous") return { turn: structuredClone(turn), stopped: false };
    if (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running") return { turn: structuredClone(turn), stopped: false };
    const at = this.now();
    turn.state = "stopped";
    turn.stoppedAt = at;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.stopped", {}, turn.runId);
    return { turn: structuredClone(turn), stopped: true };
  }

  /**
   * An ambiguous turn may already have reached a provider, so it is never
   * replayed or deleted.  A human must make this one-way decision before the
   * session can accept fresh work.
   */
  discardAmbiguousTurn(sessionId: string, runId: string): EngineTurn {
    assertId(runId, "run id");
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "ambiguous") {
      throw new EngineStateError("conflict", "only an ambiguous turn can be discarded");
    }
    const at = this.now();
    turn.state = "discarded";
    turn.discardedAt = at;
    turn.updatedAt = at;
    // The stale worker claim must not remain usable after human resolution.
    delete turn.claim;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, "turn.discarded", { decision: "discarded" }, turn.runId);
    return structuredClone(turn);
  }

  readEvents(sessionId: string, after = 0): EngineEvent[] {
    this.getSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    return readJournal(eventsFile(this.paths, sessionId)).filter((event) => event.id > after);
  }

  recover(): { requeued: string[]; ambiguous: string[] } {
    const requeued: string[] = [];
    const ambiguous: string[] = [];
    for (const session of this.allSessions()) {
      const queue = this.readQueue(session.id);
      let changed = false;
      const recoveryEvents: Array<{ type: "turn.requeued" | "turn.ambiguous"; runId: string }> = [];
      const at = this.now();
      const recoveredProviderSessionId = latestProviderSessionId(queue);
      // `queue.json` is written before `session.json` when a turn completes.
      // If the process dies in that tiny interval, the terminal turn remains
      // the durable source of truth. Repair metadata on startup before any
      // new claim can decide whether to resume a Claude conversation.
      let metadataChanged = false;
      if (!session.provider.sessionId && recoveredProviderSessionId) {
        session.provider.sessionId = recoveredProviderSessionId;
        session.updatedAt = at;
        metadataChanged = true;
      }
      for (const turn of queue.turns) {
        if (turn.state === "claimed") {
          turn.state = "queued";
          delete turn.claim;
          turn.updatedAt = at;
          requeued.push(turn.runId);
          recoveryEvents.push({ type: "turn.requeued", runId: turn.runId });
          changed = true;
        } else if (turn.state === "running") {
          turn.state = "ambiguous";
          turn.ambiguousAt = at;
          turn.updatedAt = at;
          ambiguous.push(turn.runId);
          recoveryEvents.push({ type: "turn.ambiguous", runId: turn.runId });
          changed = true;
        }
      }
      if (changed) {
        this.writeQueue(session.id, queue);
      }
      if (changed || metadataChanged) {
        if (changed && !metadataChanged) this.touchSession(session.id, at);
        else atomicWrite(sessionMetadataFile(this.paths, session.id), session);
      }
      if (changed) {
        for (const event of recoveryEvents) {
          this.appendEvent(session.id, event.type, { reason: "engine_restart" }, event.runId);
        }
      }
    }
    return { requeued, ambiguous };
  }

  /** A missing worker might have already called a provider: only a merely claimed turn is safe to requeue. */
  recoverInactiveWorker(workerId: string): { requeued: string[]; ambiguous: string[] } {
    assertId(workerId, "worker id");
    const requeued: string[] = [];
    const ambiguous: string[] = [];
    for (const session of this.allSessions()) {
      const queue = this.readQueue(session.id);
      const at = this.now();
      let changed = false;
      for (const turn of queue.turns) {
        if (turn.claim?.workerId !== workerId) continue;
        if (turn.state === "claimed") {
          turn.state = "queued";
          delete turn.claim;
          turn.updatedAt = at;
          requeued.push(turn.runId);
          this.appendEvent(session.id, "turn.requeued", { reason: "worker_unavailable" }, turn.runId);
          changed = true;
        } else if (turn.state === "running") {
          turn.state = "ambiguous";
          turn.ambiguousAt = at;
          turn.updatedAt = at;
          ambiguous.push(turn.runId);
          this.appendEvent(session.id, "turn.ambiguous", { reason: "worker_unavailable" }, turn.runId);
          changed = true;
        }
      }
      if (changed) {
        this.writeQueue(session.id, queue);
        this.touchSession(session.id, at);
      }
    }
    return { requeued, ambiguous };
  }

  cancellationsForWorker(workerId: string): Array<{ sessionId: string; runId: string; claimToken: string }> {
    assertId(workerId, "worker id");
    return this.allSessions().flatMap((session) =>
      this.readQueue(session.id).turns.flatMap((turn) =>
        turn.state === "stopped" && turn.claim?.workerId === workerId
          ? [{ sessionId: session.id, runId: turn.runId, claimToken: turn.claim.token }]
          : [],
      ),
    );
  }

  private allSessions(): EngineSession[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.paths.sessions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && ID.test(entry.name))
      .map((entry) => this.getSession(entry.name));
  }

  private readQueue(sessionId: string): SessionQueue {
    const stored = readJson(sessionQueueFile(this.paths, sessionId));
    if (stored === undefined) return emptyQueue(sessionId);
    return parseQueue(stored, sessionId);
  }

  private writeQueue(sessionId: string, queue: SessionQueue): void {
    atomicWrite(sessionQueueFile(this.paths, sessionId), queue);
  }

  private requireRunningClaim(sessionId: string, runId: string, claimToken: string): EngineTurn {
    return this.requireRunningClaimFromQueue(this.readQueue(sessionId), runId, claimToken);
  }

  private requireRunningClaimFromQueue(queue: SessionQueue, runId: string, claimToken: string): EngineTurn {
    assertId(runId, "run id");
    if (typeof claimToken !== "string" || claimToken.length < 16) {
      throw new EngineStateError("invalid_request", "claim token is invalid");
    }
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "running" || turn.claim?.token !== claimToken) {
      throw new EngineStateError("conflict", "turn is not running under this worker claim");
    }
    return turn;
  }

  private touchSession(sessionId: string, at: number, providerSessionId?: string): void {
    const session = this.getSession(sessionId);
    session.updatedAt = at;
    if (providerSessionId !== undefined) session.provider.sessionId = providerSessionId;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), session);
  }

  /** Prefer metadata, but let a completed durable turn heal an interrupted metadata write. */
  private providerForSession(session: EngineSession): EngineSession["provider"] {
    if (session.provider.sessionId) return session.provider;
    const providerSessionId = latestProviderSessionId(this.readQueue(session.id));
    if (!providerSessionId) return session.provider;
    const provider = { ...session.provider, sessionId: providerSessionId };
    session.provider = provider;
    session.updatedAt = this.now();
    atomicWrite(sessionMetadataFile(this.paths, session.id), session);
    return provider;
  }

  private appendEvent(sessionId: string, type: EngineEvent["type"], data: Record<string, unknown>, runId?: string): EngineEvent {
    const file = eventsFile(this.paths, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const prior = readJournal(file);
    const event: EngineEvent = { id: (prior.at(-1)?.id ?? 0) + 1, at: this.now(), type, data, ...(runId ? { runId } : {}) };
    // NDJSON is an append-only stream, not a document: do not replace it with
    // tmp+rename. The daemon lock gives this one writer and each record is one append.
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return event;
  }
}

export type DaemonLock = { token: string; release(): void };

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive state-root ownership. A dead owner's lock is reclaimed, never a live one. */
export function acquireDaemonLock(paths: EngineStatePaths): DaemonLock {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const breaker = `${paths.lock}.break`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const descriptor = fs.openSync(paths.lock, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, hostname: os.hostname(), startedAt: Date.now() }));
      fs.closeSync(descriptor);
      return {
        token,
        release() {
          try {
            const lock = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { token?: string };
            if (lock.token === token) fs.unlinkSync(paths.lock);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number } = {};
      let fingerprint: string | undefined;
      try {
        const stat = fs.statSync(paths.lock);
        fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        owner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number };
      } catch {
        // A torn stale lock cannot establish a live owner. The retry below is
        // still guarded by unlink + O_EXCL and never replaces an active lock.
      }
      if (processExists(owner.pid ?? -1)) throw new EngineStateError("conflict", "vNext engine state root is already locked");
      const breakerToken = crypto.randomUUID();
      try {
        const descriptor = fs.openSync(breaker, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: breakerToken }));
        fs.closeSync(descriptor);
      } catch (breakError) {
        if ((breakError as NodeJS.ErrnoException).code === "EEXIST") {
          // Another stale-lock breaker owns the compare-and-delete window;
          // never race it by unlinking its freshly acquired daemon lock.
          throw new EngineStateError("conflict", "vNext engine state root is already being recovered");
        }
        throw breakError;
      }
      try {
        try {
          const stat = fs.statSync(paths.lock);
          const current = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
          const currentOwner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number };
          if (current !== fingerprint || processExists(currentOwner.pid ?? -1)) continue;
          fs.unlinkSync(paths.lock);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      } finally {
        try {
          const value = JSON.parse(fs.readFileSync(breaker, "utf8")) as { token?: string };
          if (value.token === breakerToken) fs.unlinkSync(breaker);
        } catch (breakCleanupError) {
          if ((breakCleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw breakCleanupError;
        }
      }
    }
  }
  throw new EngineStateError("conflict", "vNext engine state root is already locked");
}
