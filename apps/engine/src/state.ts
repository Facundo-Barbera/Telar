// vNext state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/vnext` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoResolution,
  DEFAULT_ATTENDED_RUNTIME_MODE,
  DEFAULT_DETACHED_RUNTIME_MODE,
  Item as ItemSchema,
  EngineRequest as RequestSchema,
  Project as ProjectSchema,
  Session as SessionSchema,
  Turn as TurnSchema,
  TurnObservation as TurnObservationSchema,
  type EngineEvent,
  type Item,
  type Project,
  type EngineRequest,
  type RequestDecision,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type RequestResolver,
  type Session,
  type Turn,
  type TurnFailureCode,
  type TurnObservation,
  type UsageSnapshot,
  type EnvMode,
  type WorkerClaim,
  type WorkerStatus,
} from "@telar/engine-client";
import { createSessionWorktree, defaultGitRunner, removeSessionWorktree, type GitRunner } from "./worktree";

/** The human-facing one-liner for a parked request's notification. */
function requestTitle(detail: RequestDetail): string {
  switch (detail.kind) {
    case "command_execution":
      return detail.command.command;
    case "file_change":
      return `${detail.change.kind} ${detail.change.path}`;
    case "file_read":
      return detail.read.path;
    case "tool_call":
      return detail.call.name;
    case "user_input":
      return detail.prompt;
  }
}

/**
 * A journal record before the engine stamps its envelope.
 *
 * Derived from `EngineEvent` by REMOVING the four fields only the engine may
 * assign, so `appendEvent` cannot be handed an id or a sessionId and the union
 * still narrows on `type`. Writing this as a hand-maintained second union would
 * be one more shape to keep in sync with the contract.
 *
 * THE `T extends unknown` IS NOT DECORATION — it is what makes the omit
 * DISTRIBUTE. A bare `Omit<EngineEvent, …>` collapses a discriminated union
 * into a single object type whose only surviving members are the keys every
 * variant shares, which here is `type` alone. The result still compiles and
 * still looks right; it simply rejects every payload field with "does not exist
 * in type JournalEntry". Measured, not theorised: it rejected all eleven call
 * sites below before the conditional was added.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type JournalEntry = DistributiveOmit<EngineEvent, "id" | "at" | "sessionId" | "runId">;

type TurnFailure = { code: TurnFailureCode; message: string };

/**
 * WHICH FAILURES A WORKER MAY REPORT — a strict subset of `TurnFailureCode`.
 * `cancelled` is the engine's own word for a stop it already recorded, and
 * `internal_error` is the engine's; a worker claiming either would let a
 * provider crash masquerade as a control-plane decision.
 */
const TURN_FAILURE_CODES = new Set<TurnFailureCode>(["provider_unavailable", "driver_failed", "budget_exhausted"]);

/**
 * The provider instance a session gets until the account registry is wired in
 * (stage 4). Named rather than inlined so the seam is greppable: routing is by
 * instance id in the contract, and this is the one place still assuming there
 * is exactly one.
 */
const DEFAULT_PROVIDER_INSTANCE_ID = "claude:default";

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

/**
 * DOCUMENT VERSIONS TRACK THE PROTOCOL, and v2 is a HARD BREAK: a v1 document
 * is not readable and is not migrated. `storedVersion` exists only so the
 * failure names itself — a raw zod error on a v1 queue would read as
 * corruption, and an operator would reasonably suspect their disk rather than
 * the version bump. The dogfood home is throwaway state by design.
 */
const STATE_VERSION = 2 as const;

type ProjectRegistry = { version: typeof STATE_VERSION; projects: Project[] };
type SessionQueue = { version: typeof STATE_VERSION; sessionId: string; nextSequence: number; turns: Turn[] };

const emptyRegistry = (): ProjectRegistry => ({ version: STATE_VERSION, projects: [] });
const emptyQueue = (sessionId: string): SessionQueue => ({ version: STATE_VERSION, sessionId, nextSequence: 1, turns: [] });

function assertStateVersion(value: unknown, document: string): void {
  const version = (value as { version?: unknown } | null)?.version;
  if (version === STATE_VERSION) return;
  if (version === 1) {
    throw new EngineStateError(
      "invalid_request",
      `this ${document} was written by protocol v1, which vNext no longer reads. ` +
        `v2 is a deliberate hard break with no migration — clear the vNext state root (TELAR_HOME/vnext) and start fresh.`,
    );
  }
  throw new EngineStateError("invalid_request", `invalid vNext ${document}`);
}

function latestProviderSessionId(queue: SessionQueue): string | undefined {
  return queue.turns
    .filter((turn) => turn.state === "completed" && typeof turn.providerSessionId === "string" && turn.providerSessionId.trim())
    .sort((left, right) => right.sequence - left.sequence)[0]?.providerSessionId;
}

/**
 * PARSING IS THE SCHEMAS' JOB NOW. v1 hand-rolled every one of these checks and
 * each was a place the type and the validator could drift; the whole reason
 * `packages/engine-client` took a zod dependency is that there is exactly one
 * definition per shape and the TypeScript type is derived from it.
 */
function parseRegistry(value: unknown): ProjectRegistry {
  assertStateVersion(value, "project registry");
  const projects = ProjectSchema.array().safeParse((value as { projects?: unknown }).projects);
  if (!projects.success) throw new EngineStateError("invalid_request", "invalid vNext project registry");
  for (const project of projects.data) assertAbsolutePath(project.root, "project root");
  return { version: STATE_VERSION, projects: projects.data };
}

function parseSession(value: unknown): Session {
  const session = SessionSchema.safeParse(value);
  if (!session.success) throw new EngineStateError("invalid_request", "invalid vNext session metadata");
  assertId(session.data.id, "session id");
  assertId(session.data.projectId, "project id");
  return session.data;
}

function parseQueue(value: unknown, sessionId: string): SessionQueue {
  assertStateVersion(value, "session queue");
  const stored = value as { sessionId?: unknown; nextSequence?: unknown; turns?: unknown };
  if (stored.sessionId !== sessionId || !Number.isSafeInteger(stored.nextSequence)) {
    throw new EngineStateError("invalid_request", "invalid vNext session queue");
  }
  const turns = TurnSchema.array().safeParse(stored.turns);
  if (!turns.success) throw new EngineStateError("invalid_request", "invalid vNext session queue");
  const ids = new Set<string>();
  for (const turn of turns.data) {
    assertId(turn.runId, "run id");
    if (ids.has(turn.runId)) throw new EngineStateError("invalid_request", "duplicate vNext turn id");
    ids.add(turn.runId);
  }
  return { version: STATE_VERSION, sessionId, nextSequence: stored.nextSequence as number, turns: turns.data };
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

function itemsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "items.json");
}

function requestsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "requests.json");
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

/**
 * Told when a request parks with nobody watching.
 *
 * IT RETURNS WHETHER A HUMAN WAS ACTUALLY REACHED, and that boolean is stored
 * on the request. With no notifier configured the answer is `false` — which
 * records the honest state "this session is stuck and nobody was told" rather
 * than implying someone was. The contract comment on `EngineRequest.notified` exists
 * for exactly this: it must be detectable, not inferred from absence.
 */
export type EngineNotifier = (input: {
  sessionId: string;
  runId: string;
  requestId: string;
  kind: RequestKind;
  title: string;
}) => boolean;

export class EngineStore {
  readonly paths: EngineStatePaths;
  private readonly notifier?: EngineNotifier;
  private readonly git: GitRunner;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: { notifier?: EngineNotifier; git?: GitRunner } = {},
  ) {
    this.notifier = options.notifier;
    this.git = options.git ?? defaultGitRunner;
    this.paths = statePaths(root);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
  }

  listProjects(): Project[] {
    const registry = readJson(this.paths.projects);
    return registry === undefined ? [] : structuredClone(parseRegistry(registry).projects);
  }

  registerProject(input: { id?: string; name: string; root: string }): Project {
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
    const project: Project = {
      id,
      environmentId: "local",
      name: input.name.trim(),
      root: projectRoot,
      createdAt: at,
      updatedAt: at,
    };
    parsed.projects.push(project);
    atomicWrite(this.paths.projects, parsed);
    return structuredClone(project);
  }

  getProject(projectId: string): Project {
    assertId(projectId, "project id");
    const project = this.listProjects().find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    return project;
  }

  createSession(input: { id?: string; projectId: string; title?: string; detached?: boolean; envMode?: EnvMode }): Session {
    if (input.id !== undefined) assertId(input.id, "session id");
    const project = this.getProject(input.projectId);
    const id = input.id ?? `session_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = sessionMetadataFile(this.paths, id);
    const existing = readJson(metadata);
    if (existing !== undefined) {
      const session = parseSession(existing);
      if (session.projectId === input.projectId) return structuredClone(session);
      throw new EngineStateError("conflict", "session id is already owned by another project");
    }
    const at = this.now();
    // Detached is the DEFAULT POSTURE, not a mode a caller opts into: the
    // engine never requires a client to be connected. `detached` only decides
    // what happens when a request opens with nobody home, and the two defaults
    // come from the contract rather than being re-picked here.
    const detached = input.detached ?? true;
    const envMode = input.envMode ?? "local";
    // The worktree is cut BEFORE the session document is written. A session
    // whose workspace does not exist is unusable and would have to be repaired
    // on read; failing here leaves nothing behind to repair.
    const workspace: Session["workspace"] =
      envMode === "worktree"
        ? (() => {
            const cut = createSessionWorktree(this.git, {
              vnextRoot: this.paths.root,
              projectRoot: project.root,
              sessionId: id,
            });
            return { mode: "worktree" as const, path: cut.path, branch: cut.branch, baseRef: cut.baseRef };
          })()
        : { mode: "local" as const, path: project.root };
    const session: Session = {
      id,
      projectId: input.projectId,
      environmentId: "local",
      title: input.title?.trim() || "New session",
      state: "active",
      createdAt: at,
      updatedAt: at,
      providerInstanceId: DEFAULT_PROVIDER_INSTANCE_ID,
      driver: "claude",
      workspace,
      envMode,
      runtimeMode: detached ? DEFAULT_DETACHED_RUNTIME_MODE : DEFAULT_ATTENDED_RUNTIME_MODE,
      interactionMode: "default",
      detached,
    };
    atomicWrite(metadata, session);
    atomicWrite(sessionQueueFile(this.paths, id), emptyQueue(id));
    this.appendEvent(id, { type: "session.created", session });
    return structuredClone(session);
  }

  getSession(sessionId: string): Session {
    const stored = readJson(sessionMetadataFile(this.paths, sessionId));
    if (stored === undefined) throw new EngineStateError("not_found", "session does not exist");
    return structuredClone(parseSession(stored));
  }

  listSessions(projectId: string): Session[] {
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

  turns(sessionId: string): Turn[] {
    this.getSession(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  items(sessionId: string): Item[] {
    this.getSession(sessionId);
    return structuredClone([...this.readItems(sessionId).values()]);
  }

  submitTurn(sessionId: string, input: { runId: string; input: string }): { turn: Turn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.input);
    this.getSession(sessionId);
    const queue = this.readQueue(sessionId);
    const known = queue.turns.find((turn) => turn.runId === input.runId);
    if (known) {
      if (known.input !== input.input) throw new EngineStateError("conflict", "run id was already submitted with different text");
      return { turn: structuredClone(known), replayed: true };
    }
    if (queue.turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running")) {
      throw new EngineStateError("conflict", "session already has an active turn");
    }
    if (queue.turns.some((turn) => turn.state === "ambiguous")) {
      throw new EngineStateError("conflict", "session has an ambiguous turn that must be resolved first");
    }
    const at = this.now();
    const turn: Turn = {
      runId: input.runId,
      sessionId,
      sequence: queue.nextSequence++,
      input: input.input,
      state: "queued",
      acceptedAt: at,
      updatedAt: at,
    };
    queue.turns.push(turn);
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    // v1 emitted only `{ sequence }` here, which is why the client had to fetch
    // a snapshot to learn the prompt. The whole turn rides the event now.
    this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
    return { turn: structuredClone(turn), replayed: false };
  }

  claimTurn(sessionId: string, workerId: string): Turn | undefined {
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
    this.appendEvent(sessionId, { type: "turn.claimed", workerId }, turn.runId);
    return structuredClone(turn);
  }

  /** Claims exactly one queued turn. The daemon has one state lock, so two workers cannot claim it twice. */
  claimNextTurn(workerId: string): WorkerClaim | undefined {
    assertId(workerId, "worker id");
    for (const session of this.allSessions().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const turn = this.claimTurn(session.id, workerId);
      if (!turn) continue;
      const resumeCursor = this.resumeCursorFor(session);
      return {
        sessionId: session.id,
        projectRoot: session.workspace.path,
        driver: session.driver,
        providerInstanceId: session.providerInstanceId,
        ...(resumeCursor ? { resumeCursor } : {}),
        turn,
      };
    }
    return undefined;
  }

  markRunning(sessionId: string, runId: string, claimToken: string): Turn {
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "claimed" || turn.claim?.token !== claimToken) {
      throw new EngineStateError("conflict", "turn is not claimed by this worker");
    }
    const at = this.now();
    turn.state = "running";
    turn.startedAt = at;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * Journal what a worker saw.
   *
   * THE WORKER MINTS NOTHING DURABLE. It supplies item ids that are unique
   * within its turn and opaque here; this method stamps ownership, assigns the
   * monotonic event id, and is the only writer. A batch is validated in full
   * BEFORE any of it is appended, so a malformed tail cannot leave half a
   * provider message in the journal.
   */
  ingestObservations(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    const turn = this.requireRunningClaim(sessionId, runId, claimToken);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    const items = this.readItems(sessionId);
    for (const observation of parsed.data) {
      this.journalObservation(sessionId, turn, observation, items);
    }
    this.writeItems(sessionId, items);
    return { accepted: parsed.data.length };
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
  ): Turn {
    if (typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH) {
      throw new EngineStateError("invalid_request", "final text exceeds the allowed size");
    }
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const at = this.now();
    turn.state = "completed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.resultText = input.text;
    if (input.usage !== undefined) turn.usage = input.usage;
    if (input.providerSessionId !== undefined) {
      if (typeof input.providerSessionId !== "string" || !input.providerSessionId.trim() || input.providerSessionId.length > 4_000) {
        throw new EngineStateError("invalid_request", "provider session id is invalid");
      }
      turn.providerSessionId = input.providerSessionId;
    }
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at, input.providerSessionId);
    this.appendEvent(
      sessionId,
      {
        type: "turn.completed",
        resultText: input.text,
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      },
      turn.runId,
    );
    return structuredClone(turn);
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: TurnFailure["code"]; message: string },
  ): Turn {
    if (!TURN_FAILURE_CODES.has(failure.code) || typeof failure.message !== "string" || !failure.message.trim()) {
      throw new EngineStateError("invalid_request", "turn failure is invalid");
    }
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const at = this.now();
    turn.state = "failed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.failure = { code: failure.code, message: failure.message.slice(0, 4_000) };
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
    return structuredClone(turn);
  }

  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    const queue = this.readQueue(sessionId);
    const turn = requestedRunId
      ? queue.turns.find((candidate) => candidate.runId === requestedRunId)
      : queue.turns.find((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "running");
    if (!turn) return { stopped: false };
    if (turn.state === "stopped" || turn.state === "ambiguous") return { turn: structuredClone(turn), stopped: false };
    if (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running") return { turn: structuredClone(turn), stopped: false };
    const at = this.now();
    turn.state = "stopped";
    turn.completedAt = at;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
    return { turn: structuredClone(turn), stopped: true };
  }

  /**
   * An ambiguous turn may already have reached a provider, so it is never
   * replayed or deleted.  A human must make this one-way decision before the
   * session can accept fresh work.
   */
  discardAmbiguousTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "ambiguous") {
      throw new EngineStateError("conflict", "only an ambiguous turn can be discarded");
    }
    const at = this.now();
    turn.state = "discarded";
    turn.completedAt = at;
    turn.updatedAt = at;
    // The stale worker claim must not remain usable after human resolution.
    delete turn.claim;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.discarded" }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * End a session and free its checkout.
   *
   * THE BRANCH SURVIVES. Removing the worktree returns the disk and the git
   * registration; the commits on `telar/<id>` are the session's OUTPUT and
   * deleting them is a separate human decision. A detached run whose work
   * vanished when it finished would be worse than one that never ran.
   *
   * Refuses while work is in flight: archiving under a running turn would
   * pull the checkout out from under a live provider process.
   */
  archiveSession(sessionId: string): Session {
    const session = this.getSession(sessionId);
    if (session.state === "archived") return session;
    const active = this.readQueue(sessionId).turns.find(
      (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
    );
    if (active) throw new EngineStateError("conflict", "session has an active turn; stop it before archiving");

    if (session.workspace.mode === "worktree") {
      const project = this.getProject(session.projectId);
      // Best-effort. A leaked directory is bounded inside the engine's own
      // root and is reapable later; refusing to archive because git was
      // unhappy would strand the session in a state a human cannot leave.
      removeSessionWorktree(this.git, project.root, session.workspace.path);
    }
    const at = this.now();
    session.state = "archived";
    session.updatedAt = at;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), session);
    this.appendEvent(sessionId, { type: "session.archived" });
    return structuredClone(session);
  }

  requests(sessionId: string): EngineRequest[] {
    this.getSession(sessionId);
    return structuredClone([...this.readRequests(sessionId).values()]);
  }

  /**
   * A worker asking whether a tool call may proceed.
   *
   * THE ENGINE DECIDES, NOT THE WORKER, and this is the only place the session's
   * runtime mode is consulted. `autoResolution` lives in the CONTRACT rather
   * than here precisely so a client can describe a mode's behaviour before a
   * user picks it; if this method re-implemented the ladder, the settings
   * screen and the engine could disagree.
   *
   * Idempotent on `requestId`: a worker that retries after a dropped response
   * gets the same answer rather than opening a second request, which matters
   * because the provider is blocked on the first one.
   */
  openRequest(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { requestId: string; kind: RequestKind; detail: RequestDetail; itemId?: string; providerRefs?: EngineRequest["providerRefs"] },
  ): RequestOpenResult {
    assertId(input.requestId, "request id");
    const turn = this.requireRunningClaim(sessionId, runId, claimToken);
    const session = this.getSession(sessionId);
    const requests = this.readRequests(sessionId);

    const known = requests.get(input.requestId);
    if (known) {
      return known.state === "resolved"
        ? { state: "resolved", requestId: known.id, decision: known.decision!, resolvedBy: known.resolvedBy! }
        : { state: "open", requestId: known.id, notified: known.notified ?? false };
    }

    const at = this.now();
    const automatic = autoResolution(session.runtimeMode, input.kind);
    const request: EngineRequest = {
      id: input.requestId,
      runId: turn.runId,
      sessionId,
      state: automatic ? "resolved" : "open",
      detail: input.detail,
      openedAt: at,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
      ...(automatic ? { decision: automatic, resolvedBy: "policy" as const, resolvedAt: at } : {}),
    };

    if (!automatic) {
      // Parked. Tell someone, and record whether anyone was actually reached —
      // "stuck and nobody was told" has to be a detectable state.
      request.notified = this.notifier
        ? this.notifier({
            sessionId,
            runId: turn.runId,
            requestId: request.id,
            kind: input.kind,
            title: requestTitle(input.detail),
          })
        : false;
    }

    requests.set(request.id, request);
    this.writeRequests(sessionId, requests);
    this.appendEvent(sessionId, { type: "request.opened", request }, turn.runId);

    if (automatic) {
      this.appendEvent(
        sessionId,
        { type: "request.resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" },
        turn.runId,
      );
      return { state: "resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" };
    }
    this.touchSession(sessionId, at);
    return { state: "open", requestId: request.id, notified: request.notified ?? false };
  }

  /** A human (or a cancellation) answering a parked request. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; resolvedBy?: RequestResolver; reason?: string; answers?: Record<string, unknown> },
  ): EngineRequest {
    assertId(requestId, "request id");
    const requests = this.readRequests(sessionId);
    const request = requests.get(requestId);
    if (!request) throw new EngineStateError("not_found", "request does not exist");
    if (request.state === "resolved") {
      throw new EngineStateError("conflict", "request has already been resolved");
    }
    const at = this.now();
    request.state = "resolved";
    request.decision = input.decision;
    request.resolvedBy = input.resolvedBy ?? "human";
    request.resolvedAt = at;
    if (input.reason !== undefined) request.reason = input.reason;
    if (input.answers !== undefined) request.answers = input.answers;
    requests.set(request.id, request);
    this.writeRequests(sessionId, requests);
    this.touchSession(sessionId, at);
    this.appendEvent(
      sessionId,
      {
        type: "request.resolved",
        requestId: request.id,
        decision: request.decision,
        resolvedBy: request.resolvedBy,
        ...(request.reason ? { reason: request.reason } : {}),
      },
      request.runId,
    );
    return structuredClone(request);
  }

  /**
   * Answered requests a worker is still blocked on.
   *
   * Rides the heartbeat for the same reason `cancel` does: the worker is a
   * plain HTTP client with no inbound socket, so the engine cannot push. A
   * worker sitting inside `canUseTool` polls here until its answer appears.
   */
  resolutionsForWorker(workerId: string): WorkerStatus["resolved"] {
    assertId(workerId, "worker id");
    return this.allSessions().flatMap((session) => {
      const claimed = new Map(
        this.readQueue(session.id).turns
          .filter((turn) => turn.claim?.workerId === workerId && turn.state === "running")
          .map((turn) => [turn.runId, turn] as const),
      );
      if (claimed.size === 0) return [];
      return [...this.readRequests(session.id).values()]
        .filter((request) => request.state === "resolved" && request.decision && claimed.has(request.runId))
        .map((request) => ({
          requestId: request.id,
          sessionId: session.id,
          runId: request.runId,
          decision: request.decision!,
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.answers ? { answers: request.answers } : {}),
        }));
    });
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
      // new claim can decide whether to resume a provider conversation.
      let metadataChanged = false;
      if (!session.resumeCursor && recoveredProviderSessionId) {
        session.resumeCursor = recoveredProviderSessionId;
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
          this.appendEvent(session.id, { type: event.type, reason: "engine_restart" }, event.runId);
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
          this.appendEvent(session.id, { type: "turn.requeued", reason: "worker_unavailable" }, turn.runId);
          changed = true;
        } else if (turn.state === "running") {
          turn.state = "ambiguous";
          turn.updatedAt = at;
          ambiguous.push(turn.runId);
          this.appendEvent(session.id, { type: "turn.ambiguous", reason: "worker_unavailable" }, turn.runId);
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

  private allSessions(): Session[] {
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

  private requireRunningClaim(sessionId: string, runId: string, claimToken: string): Turn {
    return this.requireRunningClaimFromQueue(this.readQueue(sessionId), runId, claimToken);
  }

  private requireRunningClaimFromQueue(queue: SessionQueue, runId: string, claimToken: string): Turn {
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

  private touchSession(sessionId: string, at: number, resumeCursor?: string): void {
    const session = this.getSession(sessionId);
    session.updatedAt = at;
    if (resumeCursor !== undefined) session.resumeCursor = resumeCursor;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), session);
  }

  /** Prefer metadata, but let a completed durable turn heal an interrupted metadata write. */
  private resumeCursorFor(session: Session): string | undefined {
    if (session.resumeCursor) return session.resumeCursor;
    const recovered = latestProviderSessionId(this.readQueue(session.id));
    if (!recovered) return undefined;
    session.resumeCursor = recovered;
    session.updatedAt = this.now();
    atomicWrite(sessionMetadataFile(this.paths, session.id), session);
    return recovered;
  }

  /**
   * Items are a PROJECTION the engine maintains beside the journal, not a
   * second source of truth: `items.json` could be rebuilt by replaying
   * `item.*` events from zero. It exists so opening a long session does not
   * require that replay, which is the same reason `queue.json` exists beside
   * `turn.*`.
   */
  private readItems(sessionId: string): Map<string, Item> {
    const stored = readJson(itemsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = ItemSchema.array().safeParse((stored as { items?: unknown }).items);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid vNext item projection");
    return new Map(parsed.data.map((item) => [item.id, item]));
  }

  private writeItems(sessionId: string, items: Map<string, Item>): void {
    atomicWrite(itemsFile(this.paths, sessionId), { version: STATE_VERSION, items: [...items.values()] });
  }

  private readRequests(sessionId: string): Map<string, EngineRequest> {
    const stored = readJson(requestsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = RequestSchema.array().safeParse((stored as { requests?: unknown }).requests);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid vNext request projection");
    return new Map(parsed.data.map((request) => [request.id, request]));
  }

  private writeRequests(sessionId: string, requests: Map<string, EngineRequest>): void {
    atomicWrite(requestsFile(this.paths, sessionId), { version: STATE_VERSION, requests: [...requests.values()] });
  }

  /** One observation → at most one journal record, plus its projection edit. */
  private journalObservation(sessionId: string, turn: Turn, observation: TurnObservation, items: Map<string, Item>): void {
    const at = this.now();
    if (observation.kind === "usage") {
      this.appendEvent(sessionId, { type: "usage.updated", usage: observation.usage }, turn.runId);
      return;
    }
    if (observation.kind === "content.delta") {
      // Deltas do NOT touch the projection. An item's stored text is filled in
      // by the `item.completed` that closes it; folding every token into
      // items.json would rewrite the whole document per token.
      if (!items.has(observation.itemId)) return;
      this.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      return;
    }
    if (observation.kind === "item.completed") {
      const existing = items.get(observation.itemId);
      if (!existing) return;
      const item: Item = {
        ...existing,
        status: observation.status,
        completedAt: at,
        ...(observation.detail ? { detail: observation.detail } : {}),
      };
      items.set(item.id, item);
      this.appendEvent(sessionId, { type: "item.completed", item }, turn.runId);
      return;
    }
    const seed = observation.item;
    const started = observation.kind === "item.started";
    const item: Item = {
      id: seed.id,
      runId: turn.runId,
      sessionId,
      status: "inProgress",
      detail: seed.detail,
      startedAt: started ? at : (items.get(seed.id)?.startedAt ?? at),
      ...(seed.title ? { title: seed.title } : {}),
      ...(seed.providerRefs ? { providerRefs: seed.providerRefs } : {}),
    };
    items.set(item.id, item);
    this.appendEvent(sessionId, { type: started ? "item.started" : "item.updated", item }, turn.runId);
  }

  /**
   * The single journal writer.
   *
   * TAKES A FULLY-FORMED EVENT MINUS ITS ENVELOPE, which is the v2 change: v1
   * took `(type, data)` where `data` was `Record<string, unknown>`, so nothing
   * checked that a `turn.text` actually carried text. The parameter type is the
   * discriminated union with the engine-assigned fields removed, so a mistyped
   * payload fails at compile time here rather than at a client's call site.
   */
  private appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent {
    const file = eventsFile(this.paths, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const prior = readJournal(file);
    const record = {
      id: (prior.at(-1)?.id ?? 0) + 1,
      at: this.now(),
      sessionId,
      ...(runId ? { runId } : {}),
      ...event,
    } as EngineEvent;
    // NDJSON is an append-only stream, not a document: do not replace it with
    // tmp+rename. The daemon lock gives this one writer and each record is one append.
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return record;
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
