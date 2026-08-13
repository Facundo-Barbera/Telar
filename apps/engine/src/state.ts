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
  McpServer as McpServerSchema,
  McpServerSpec as McpServerSpecSchema,
  ModelSelection,
  EngineRequest as RequestSchema,
  Project as ProjectSchema,
  Session as SessionSchema,
  Task as TaskSchema,
  Turn as TurnSchema,
  TurnAttachment as TurnAttachmentSchema,
  TurnObservation as TurnObservationSchema,
  type BrowserProvider,
  type BrowserSnapshot,
  type BrowserTab,
  type GitCommitEntry,
  type GitHubIssueListState,
  type GitHubIssueRead,
  type GitHubMergeMethod,
  type GitHubMergeResult,
  type GitHubPullListState,
  type GitHubPullRead,
  type GitHubSnapshot,
  type GitignoreResult,
  type ModelCatalogue,
  type SessionDiff,
  type EngineEvent,
  type Item,
  type McpServer,
  type TurnAttachment,
  type TurnModelSelection,
  type ProviderDriverKind,
  type Task,
  type Project,
  type EngineRequest,
  type RequestDecision,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type RequestResolver,
  type RuntimeMode,
  type Session,
  type Turn,
  type TurnFailureCode,
  type TurnObservation,
  type UsageSnapshot,
  type EnvMode,
  type ModelSelection as ModelSelectionValue,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
} from "@telar/engine-client";
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./files";
import { commitSessionWork, gitOverview, sessionDiff, sessionFilePatch, type GitOverview } from "./git";
import { ensureTelarGitignore } from "./gitignore";
import { defaultGhRunner, mergePull, readGitHub, readIssue, readPull, type GhRunner } from "./github";
import { readModelCatalogue } from "./models";
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
 * The provider instance a session gets until the account registry exists.
 *
 * ONE INSTANCE PER DRIVER, derived as `<driver>:default` where the session is
 * created. That is still an assumption — the contract routes by instance id
 * precisely so one Telar can hold two Claude accounts — but it is now an
 * assumption about ACCOUNTS rather than about providers, which is what stage 4
 * had to remove before a session could be a Codex session at all.
 */
const PROVIDER_INSTANCE_SUFFIX = "default";

/**
 * How deep a session's backlog may get.
 *
 * A RUNAWAY-CLIENT GUARD, NOT A PRODUCT LIMIT. A human queueing follow-ups will
 * never approach it; a retry loop with a fresh runId each time would otherwise
 * grow `queue.json` without bound, and the queue is rewritten whole on every
 * turn transition.
 */
const MAX_QUEUED_TURNS = 16;

/** The contract's own list, as a set, so an unknown mode is refused at the edge
 *  rather than written to disk and failing later inside `autoResolution`. */
const RUNTIME_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits", "auto", "full-access"]);

/**
 * Drop explicitly-undefined keys so a spread PATCHES rather than erases.
 *
 * `{ ...known, ...seed }` looks equivalent and is not: a key present with the
 * value `undefined` wins the spread and blanks whatever the earlier object had.
 * Providers send exactly that shape — Claude's `task_updated` patch names only
 * what changed — so without this a progress report would erase the title its
 * start report carried.
 */
function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T];
  }
  return out;
}

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

/**
 * How large one attached file may be.
 *
 * 20 MB is above every screenshot and design mock and below the point where
 * holding the bytes in memory to write them matters. It is a guard on the HTTP
 * edge rather than a product limit: the cost of a too-large attachment lands on
 * the provider's context, and refusing it here with a clear message beats
 * discovering it three layers down as a token overflow.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Per turn, so one message cannot smuggle 16 × 20 MB past the per-file cap. */
const MAX_TURN_ATTACHMENTS = 16;

/** How long a GitHub read stays fresh. Longer than a glance, shorter than the
 *  time it takes to file an issue and come back for it. */
const GITHUB_CACHE_MS = 30_000;

/** Longer than the GitHub cache because the read is heavier — a whole
 *  subprocess — and the answer changes far less often. */
const MODEL_CACHE_MS = 5 * 60_000;

export type EngineStatePaths = {
  root: string;
  projects: string;
  sessions: string;
  /** User-configured MCP servers. ENVIRONMENT-SCOPED, beside projects.json
   *  rather than inside a session: a tool is configured once. */
  mcpServers: string;
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
    mcpServers: path.join(resolved, "mcp-servers.json"),
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

function tasksFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "tasks.json");
}

/** The id → metadata index for a session's uploaded files. */
function attachmentsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "attachments.json");
}

/**
 * Where an attachment's bytes land.
 *
 * THE FILENAME IS MINTED HERE AND IS NOT THE HUMAN'S. `attachment.name` is
 * whatever the client sent — `../../.ssh/id_rsa`, a newline, 4 KB of unicode —
 * and it is kept only for display. The path is `<id><ext>` where the id is one
 * the engine generated, so no user-supplied byte reaches the filesystem. The
 * extension is the one part that follows the name, sanitised down to a short
 * alphanumeric run, because a provider and a human both read files by suffix.
 */
function attachmentFile(paths: EngineStatePaths, sessionId: string, attachmentId: string, name: string): string {
  assertId(attachmentId, "attachment id");
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase();
  return path.join(sessionDir(paths, sessionId), "attachments", `${attachmentId}${extension ? `.${extension}` : ""}`);
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
/**
 * The browser as the STORE is allowed to see it.
 *
 * Narrow on purpose, and `state` is optional: every test constructs an
 * `EngineStore` directly, and requiring the full runtime here would drag
 * Chromium's transport into all of them. A store with no browser answers
 * `provider: "none"`, which is the same thing a session that never browsed
 * answers — one code path, not two.
 */
export type AttachedBrowser = {
  release(scopeKey: string, reason?: string): Promise<boolean>;
  state?(
    scopeKey: string,
    options: { screenshot?: boolean; start?: boolean },
  ): Promise<{ provider: BrowserProvider; running: boolean; tabs: BrowserTab[]; screenshot?: string | null; error?: string | null }>;
};

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
  private readonly gh: GhRunner;
  /** In memory and never persisted: it is a cache of somebody else's state, and
   *  a stale one surviving a restart would be worse than a slow first read. */
  private readonly githubCache = new Map<string, GitHubSnapshot>();
  /**
   * One issue or one pull request, keyed `<projectId>:issue:<number>`.
   *
   * SEPARATE FROM THE SNAPSHOT CACHE rather than folded into it, because the two
   * expire independently: reopening a detail tab must not have to re-read the
   * whole list, and a list refresh must not silently answer a detail read with
   * rows that have no body. Only successful reads are cached — caching "gh is not
   * signed in" for thirty seconds would outlive the `gh auth login` that fixes it.
   */
  private readonly githubDetailCache = new Map<string, GitHubIssueRead | GitHubPullRead>();
  /**
   * Whether this machine's `gh` token has told us it cannot read Projects.
   *
   * IN MEMORY AND NOT PERSISTED, like the caches beside it: it describes a token
   * that the user can re-scope at any moment, and a "no" that survived a restart
   * would outlive the `gh auth refresh` that fixed it. Cleared by any forced read,
   * so the refresh button is the way back.
   */
  private noProjectScope = false;
  /** In memory, like the GitHub cache and for the same reason: it describes
   *  somebody else's installation, which changes without telling us. */
  private readonly modelCache = new Map<ProviderDriverKind, ModelCatalogue>();
  /**
   * Set by the daemon when it owns a browser. ATTACHED RATHER THAN CONSTRUCTED
   * so the store keeps no provider dependency — every test builds an
   * EngineStore directly and must not pull Chromium in to do it.
   */
  private browser?: AttachedBrowser;

  attachBrowser(browser: AttachedBrowser): void {
    this.browser = browser;
  }

  /**
   * What the session's browser is looking at, for a human.
   *
   * ANSWERED FROM THE DAEMON'S OWN RUNTIME, which is a real limitation and is
   * stated rather than hidden: the out-of-process worker owns a DIFFERENT
   * `BrowserRuntime` that this process cannot reach (see worker-main.ts), so a
   * deployment running its worker separately reports `provider: "none"` here
   * even while that worker is driving a page. The journalled
   * `browser.state.changed` observation still shows the tabs in that case,
   * because the party that drove them reported them. Only the pixels are
   * daemon-local.
   *
   * `provider: "none"` with no error is also the ordinary answer for a session
   * that has never browsed, and asking must never be what starts a browser.
   */
  async browserState(sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}): Promise<BrowserSnapshot> {
    this.getSession(sessionId);
    if (!this.browser?.state) {
      return { scopeKey: sessionId, provider: "none", running: false, tabs: [] };
    }
    const state = await this.browser.state(sessionId, {
      ...(options.screenshot === undefined ? {} : { screenshot: options.screenshot }),
      ...(options.start === undefined ? {} : { start: options.start }),
    });
    return {
      scopeKey: sessionId,
      provider: state.provider,
      running: state.running,
      tabs: state.tabs,
      ...(state.screenshot ? { screenshot: state.screenshot } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  /**
   * The user's own MCP servers.
   *
   * ENVIRONMENT-SCOPED, not per session or per project. A user configures a tool
   * server once and expects every session to have it; per-session copies would
   * mean re-entering credentials for each conversation and would leave no answer
   * to "which of these forty copies is the real one".
   */
  listMcpServers(): McpServer[] {
    const stored = readJson(this.paths.mcpServers) as { mcpServers?: unknown } | undefined;
    const parsed = McpServerSchema.array().safeParse(stored?.mcpServers ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid vNext MCP server registry");
    return structuredClone(parsed.data);
  }

  /** Create or replace one server. Keyed by id because the id IS the name the
   *  provider addresses its tools by — `mcp__<id>__<tool>`. */
  saveMcpServer(input: { id: string; label?: string; enabled?: boolean; spec: unknown }): McpServer {
    assertId(input.id, "mcp server id");
    const spec = McpServerSpecSchema.safeParse(input.spec);
    if (!spec.success) throw new EngineStateError("invalid_request", "MCP server configuration is invalid");
    const servers = this.listMcpServers();
    const at = this.now();
    const existing = servers.find((server) => server.id === input.id);
    const server: McpServer = {
      id: input.id,
      label: (input.label ?? existing?.label ?? input.id).trim().slice(0, 120) || input.id,
      enabled: input.enabled ?? existing?.enabled ?? true,
      spec: spec.data,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const next = existing ? servers.map((entry) => (entry.id === server.id ? server : entry)) : [...servers, server];
    atomicWrite(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
    return structuredClone(server);
  }

  removeMcpServer(id: string): boolean {
    assertId(id, "mcp server id");
    const servers = this.listMcpServers();
    const next = servers.filter((server) => server.id !== id);
    if (next.length === servers.length) return false;
    atomicWrite(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
    return true;
  }

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: { notifier?: EngineNotifier; git?: GitRunner; gh?: GhRunner } = {},
  ) {
    this.notifier = options.notifier;
    this.git = options.git ?? defaultGitRunner;
    this.gh = options.gh ?? defaultGhRunner;
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

  /**
   * The project's git state, read fresh.
   *
   * NOT CACHED and not journalled: it describes the working tree, which changes
   * underneath the engine constantly — an agent writing files, a human on the
   * same checkout, a rebase in another terminal. A stale branch name in the
   * composer's foot is worse than a slow one, because that line is what tells a
   * person where their next message lands.
   *
   * Uses the store's injected runner, so a test never needs a real repository.
   */
  projectGit(projectId: string): GitOverview {
    return gitOverview(this.git, this.getProject(projectId).root);
  }

  /**
   * A project's issues and pull requests.
   *
   * CACHED, WHICH NOTHING ELSE IN THIS STORE IS. Every other read here is a
   * local file or a local git command and costs nothing to repeat; this one is
   * a network round trip against somebody else's rate limit. A panel that a
   * reader opens, closes and reopens would otherwise spend three API calls per
   * glance. Thirty seconds is longer than a glance and shorter than the time it
   * takes to file an issue and come back for it.
   *
   * `force` is what the refresh button sends, and it is the only way past the
   * cache — a timer must never be able to hold this open.
   */
  /**
   * Which models a provider says it has.
   *
   * CACHED FOR THE SAME REASON THE GITHUB READ IS, and harder: answering means
   * spawning a `codex app-server`, initialising it and killing it. Five minutes
   * is far longer than a person spends in a menu and far shorter than the time
   * between a provider shipping a model and somebody wanting it.
   */
  async modelCatalogue(driver: ProviderDriverKind, options: { force?: boolean } = {}): Promise<ModelCatalogue> {
    if (driver !== "claude" && driver !== "codex") throw new EngineStateError("invalid_request", "unknown provider driver");
    const cached = this.modelCache.get(driver);
    if (cached && !options.force && this.now() - cached.readAt < MODEL_CACHE_MS) return structuredClone(cached);
    const catalogue = await readModelCatalogue(driver, this.now);
    this.modelCache.set(driver, catalogue);
    return structuredClone(catalogue);
  }

  /**
   * WHICH ROWS, IN THE CACHE KEY.
   *
   * Without the states in the key, switching the Pull requests surface from open
   * to all would be answered instantly from a cache of open ones — a filter that
   * silently does nothing for thirty seconds, which is worse than a slow one.
   */
  private githubKey(projectId: string, issueState: GitHubIssueListState, pullState: GitHubPullListState): string {
    return `${projectId}:${issueState}:${pullState}`;
  }

  /**
   * Drop EVERY cached list for a project, whichever filter it was read under.
   *
   * A project id cannot contain a colon (`ID` above), so the prefix is unambiguous.
   * Deleting one key would leave the others stale, which is precisely the bug the
   * merge invalidation exists to prevent — and precisely the bug that appeared the
   * moment the filter joined the key, because the old invalidation deleted a key
   * shape that no longer existed. Caught by the merge test, not by reasoning.
   */
  private forgetGitHub(projectId: string): void {
    for (const key of [...this.githubCache.keys()]) {
      if (key === projectId || key.startsWith(`${projectId}:`)) this.githubCache.delete(key);
    }
  }

  async projectGitHub(
    projectId: string,
    options: { force?: boolean; issueState?: GitHubIssueListState; pullState?: GitHubPullListState } = {},
  ): Promise<GitHubSnapshot> {
    const project = this.getProject(projectId);
    const issueState = options.issueState ?? "open";
    const pullState = options.pullState ?? "open";
    const key = this.githubKey(project.id, issueState, pullState);
    const cached = this.githubCache.get(key);
    if (cached && !options.force && this.now() - cached.readAt < GITHUB_CACHE_MS) return structuredClone(cached);
    // Once a token has said it has no `read:project`, stop paying two network calls
    // per read to be told again. A forced read clears the verdict, so adding the
    // scope and pressing refresh is all it takes to get boards back.
    const skipProjects = this.noProjectScope && !options.force;
    const snapshot = await readGitHub(this.gh, project.root, this.now, { issueState, pullState, ...(skipProjects ? { skipProjects: true } : {}) });
    if (snapshot.projectsUnavailable === "scope") this.noProjectScope = true;
    else if (snapshot.projectsUnavailable === undefined && options.force) this.noProjectScope = false;
    /**
     * THE REASON SURVIVES THE SKIP.
     *
     * Found by driving it: the cockpit's own first read consumed the scope failure,
     * so every read after it reported no reason at all — and a panel opened a minute
     * later showed every row on no boards with nothing to explain it. "Nothing was
     * attempted so there is nothing to report" sounded principled and produced a
     * surface that cannot account for itself. What is true is that boards ARE
     * unavailable, for a reason we already know; not re-asking does not unlearn it.
     */
    const answer = skipProjects && this.noProjectScope ? { ...snapshot, projectsUnavailable: "scope" as const } : snapshot;
    this.githubCache.set(key, answer);
    return structuredClone(answer);
  }

  /**
   * Ignore Telar's own files in a project's repository.
   *
   * THE ONLY WRITE IN THIS STORE THAT TOUCHES A FILE THE USER DID NOT NAME, which
   * is why the rules live in the engine (`gitignore.ts`) and this method takes a
   * project id and nothing else. A caller that could pass the lines could append
   * anything to a file inside somebody's repository.
   */
  projectGitignore(projectId: string): GitignoreResult {
    return ensureTelarGitignore(this.getProject(projectId).root);
  }

  /** A positive whole number, because it is going into an argv and a URL. */
  private forgeNumber(value: number): number {
    if (!Number.isInteger(value) || value <= 0) throw new EngineStateError("invalid_request", "an issue or pull request number is required");
    return value;
  }

  /**
   * One issue or one pull request, opened.
   *
   * CACHED LIKE THE LIST AND FOR THE SAME THIRTY SECONDS — it is the same rate
   * limit — but only when the read WORKED. A failure is not cached: the four
   * reasons a detail read fails are all things a person fixes in less than thirty
   * seconds, and a cached "not signed in" would tell them their fix did not work.
   */
  private async forgeDetail<T extends GitHubIssueRead | GitHubPullRead>(
    projectId: string,
    kind: "issue" | "pull",
    number: number,
    read: (root: string) => Promise<T>,
    options: { force?: boolean },
  ): Promise<T> {
    const project = this.getProject(projectId);
    const key = `${project.id}:${kind}:${this.forgeNumber(number)}`;
    const cached = this.githubDetailCache.get(key) as T | undefined;
    const readAt = cached && "issue" in cached ? cached.issue.readAt : cached && "pull" in cached ? cached.pull.readAt : undefined;
    if (readAt !== undefined && !options.force && this.now() - readAt < GITHUB_CACHE_MS) return structuredClone(cached!);
    const answer = await read(project.root);
    if ("issue" in answer || "pull" in answer) this.githubDetailCache.set(key, answer);
    return structuredClone(answer);
  }

  projectIssue(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubIssueRead> {
    return this.forgeDetail(projectId, "issue", number, (root) => readIssue(this.gh, root, number, this.now), options);
  }

  projectPull(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubPullRead> {
    return this.forgeDetail(projectId, "pull", number, (root) => readPull(this.gh, root, number, this.now), options);
  }

  /**
   * Merge a pull request.
   *
   * NOT CACHED — obviously — AND IT DROPS TWO CACHES ON THE WAY OUT. A merged
   * pull request that goes on reporting itself as open for the next thirty
   * seconds, in the panel that just merged it, is the worst possible moment for
   * this cache to be right about a stale answer. The LIST goes too: the row this
   * merge just closed is in it.
   *
   * `expectedHeadOid` is the reader's precondition and is required. There is no
   * "merge whatever is there now" path, because that is the merge nobody meant.
   */
  async projectPullMerge(
    projectId: string,
    number: number,
    input: { method: GitHubMergeMethod; expectedHeadOid: string },
  ): Promise<GitHubMergeResult> {
    const project = this.getProject(projectId);
    const target = this.forgeNumber(number);
    if (!input.expectedHeadOid.trim()) throw new EngineStateError("invalid_request", "the head commit this merge was reviewed against is required");
    const result = await mergePull(this.gh, project.root, { number: target, method: input.method, expectedHeadOid: input.expectedHeadOid }, this.now);
    this.githubDetailCache.delete(`${project.id}:pull:${target}`);
    if (result.merged) {
      this.forgetGitHub(project.id);
      // The merge's own re-read is fresher than anything a cache could hold, so
      // it becomes the cached answer rather than being thrown away.
      this.githubDetailCache.set(`${project.id}:pull:${target}`, { pull: result.pull });
    }
    return structuredClone(result);
  }

  /**
   * What is uncommitted in a PROJECT right now.
   *
   * FOR A CONVERSATION THAT DOES NOT EXIST YET. The new-conversation canvas is
   * scoped to a project and to nothing else, and "the tree already has twelve
   * uncommitted files" is exactly the thing worth knowing BEFORE you point an
   * agent at it. Same reader as `sessionDiff` with no base, so it answers
   * `HEAD…worktree` and the surface says which question it answered.
   */
  projectDiff(projectId: string): SessionDiff {
    return sessionDiff(this.git, { cwd: this.getProject(projectId).root });
  }

  /** One file's patch in a project's own checkout, for the same surface. */
  projectFilePatch(projectId: string, target: string, options: { untracked?: boolean } = {}): { patch: string; binary: boolean } {
    const project = this.getProject(projectId);
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    // Fenced exactly as the session read is: a pathspec is a file read, and a
    // client that could name the directory could name anything on the machine.
    const resolved = path.resolve(project.root, target);
    const prefix = project.root.endsWith(path.sep) ? project.root : `${project.root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the project");
    return sessionFilePatch(this.git, {
      cwd: project.root,
      path: path.relative(project.root, resolved),
      ...(options.untracked ? { untracked: true } : {}),
    });
  }

  /**
   * What this session has done to the repository, from where it started.
   *
   * READ AGAINST THE SESSION'S OWN CHECKOUT and its own recorded base, both of
   * which come from the session record rather than from the caller — a client
   * that could name the directory could ask the engine to diff anything on the
   * machine.
   */
  sessionDiff(sessionId: string): SessionDiff {
    const session = this.getSession(sessionId);
    return sessionDiff(this.git, {
      cwd: session.workspace.path,
      ...(session.workspace.baseRef ? { baseRef: session.workspace.baseRef } : {}),
    });
  }

  /** One file's patch, on demand — see `sessionFilePatch` for why it is not
   *  carried on the review itself. */
  sessionFilePatch(sessionId: string, target: string, options: { untracked?: boolean } = {}): { patch: string; binary: boolean } {
    const session = this.getSession(sessionId);
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    /**
     * THE PATH IS RESOLVED AND FENCED INSIDE THE WORKSPACE.
     *
     * `git diff -- <path>` treats its argument as a pathspec relative to the
     * repository, and `../../` in one is how a client asks to read a file it was
     * never offered. The fence is here rather than at the route because an
     * in-process caller must not be able to walk past a check that only ran on
     * the socket.
     */
    const resolved = path.resolve(session.workspace.path, target);
    const prefix = session.workspace.path.endsWith(path.sep) ? session.workspace.path : `${session.workspace.path}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the session workspace");
    return sessionFilePatch(this.git, {
      cwd: session.workspace.path,
      ...(session.workspace.baseRef ? { baseRef: session.workspace.baseRef } : {}),
      path: path.relative(session.workspace.path, resolved),
      ...(options.untracked ? { untracked: true } : {}),
    });
  }

  /**
   * Snapshot the session's work as one commit.
   *
   * THE ONE GIT MUTATION THE ENGINE OFFERS. It is additive and reversible, a
   * human pressed it, and it runs in the session's own checkout — see
   * `commitSessionWork` for why staging, branch switching and discarding are
   * deliberately absent rather than pending.
   */
  commitSessionWork(sessionId: string, message: string): { committed: boolean; commit?: GitCommitEntry; reason?: string } {
    const session = this.getSession(sessionId);
    const text = message.trim();
    if (!text) throw new EngineStateError("invalid_request", "a commit message is required");
    if (text.length > 2_000) throw new EngineStateError("invalid_request", "commit message is too long");
    return commitSessionWork(this.git, { cwd: session.workspace.path, message: text });
  }

  /**
   * Every file in a project's own checkout, for the Files tree.
   *
   * PROJECT-SCOPED because a tree is a view of a place: the new-conversation
   * canvas has a project and no session, and the tree there is the same tree.
   */
  projectFiles(projectId: string): WorkspaceListing {
    return listWorkspaceFiles(this.git, { cwd: this.getProject(projectId).root, now: this.now() });
  }

  /** Every file in a session's own checkout — its worktree, when it cut one. */
  sessionFiles(sessionId: string): WorkspaceListing {
    return listWorkspaceFiles(this.git, { cwd: this.getSession(sessionId).workspace.path, now: this.now() });
  }

  projectFile(projectId: string, target: string): WorkspaceFile {
    const project = this.getProject(projectId);
    return this.readFenced(project.root, target, "project");
  }

  sessionFile(sessionId: string, target: string): WorkspaceFile {
    const session = this.getSession(sessionId);
    return this.readFenced(session.workspace.path, target, "session workspace");
  }

  /**
   * SAVE A FILE A HUMAN EDITED IN THE COCKPIT.
   *
   * `expected` is the hash the editor read. Everything about why this endpoint
   * takes one — and what it refuses — is in `writeWorkspaceFile`; the store's job
   * is the fence, which is the same fence as the read and for the same reason.
   */
  projectFileWrite(projectId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const project = this.getProject(projectId);
    return this.writeFenced(project.root, target, text, expected, "project");
  }

  sessionFileWrite(sessionId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const session = this.getSession(sessionId);
    return this.writeFenced(session.workspace.path, target, text, expected, "session workspace");
  }

  /**
   * READ A FILE, INSIDE ONE DIRECTORY AND NOWHERE ELSE.
   *
   * The fence is the whole method. A client that can name a path can name
   * `../../../.ssh/id_ed25519`, and this engine listens on a port with no login
   * — so the check is here, at the store boundary, rather than at the route: an
   * in-process caller must not be able to walk past a check that only ran on the
   * socket. Same rule, same shape, as the patch reads above.
   *
   * A DIRECTORY IS NOT A FILE, and saying so beats letting `readFileSync` throw
   * EISDIR at a surface that would render the errno.
   */
  private readFenced(root: string, target: string, label: string): WorkspaceFile {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(root, target);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      throw new EngineStateError("not_found", "no such file in this workspace");
    }
    if (stats.isDirectory()) throw new EngineStateError("invalid_request", "that path is a directory");
    if (!stats.isFile()) throw new EngineStateError("invalid_request", "that path is not a regular file");
    return readWorkspaceFile({ cwd: root, path: path.relative(root, resolved) });
  }

  /**
   * The same fence, for the one write.
   *
   * DELIBERATELY NOT SHARED WITH `readFenced` beyond the check itself: a read that
   * cannot find a file is a 404, while a write that cannot is a REFUSAL the editor
   * renders inline (`not_found`), so the two disagree about what a missing file
   * means and merging them would have to invent a third answer.
   */
  private writeFenced(root: string, target: string, text: string, expected: string, label: string): WorkspaceWriteResult {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    if (!expected.trim()) throw new EngineStateError("invalid_request", "a write must carry the hash it expects on disk");
    if (text.length > MAX_TEXT_LENGTH * 10) throw new EngineStateError("invalid_request", "that file is too large to save");
    const resolved = path.resolve(root, target);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
    return writeWorkspaceFile({ cwd: root, path: path.relative(root, resolved), text, expected });
  }

  createSession(input: {
    id?: string;
    projectId: string;
    title?: string;
    detached?: boolean;
    envMode?: EnvMode;
    driver?: ProviderDriverKind;
  }): Session {
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
    const driver = input.driver ?? "claude";
    if (driver !== "claude" && driver !== "codex") throw new EngineStateError("invalid_request", "unknown provider driver");
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
        : (() => {
            /**
             * A LOCAL SESSION GETS A BASE TOO, which it never used to.
             *
             * Without it "what has this session done to the repository" was only
             * answerable for worktree sessions: `git status` forgets a change the
             * instant the agent commits it, so a session that committed its work
             * reviewed as having done nothing. Resolved at creation and stored,
             * because HEAD moves — reading it later would answer a different
             * question every time.
             *
             * An unversioned directory is a supported configuration (`envMode:
             * "local"` exists for exactly that), so a failure here leaves the
             * base absent rather than refusing the session.
             */
            const head = this.git(project.root, ["rev-parse", "HEAD"]);
            const baseRef = head.status === 0 ? head.stdout.trim() : "";
            return { mode: "local" as const, path: project.root, ...(baseRef ? { baseRef } : {}) };
          })();
    const session: Session = {
      id,
      projectId: input.projectId,
      environmentId: "local",
      title: input.title?.trim() || "New session",
      state: "active",
      createdAt: at,
      updatedAt: at,
      // The instance is the ROUTING key and the driver is descriptive, so the
      // two are derived together here rather than picked independently — a
      // session routed to `claude:default` while claiming to be a Codex session
      // is the one inconsistency this split exists to make impossible.
      providerInstanceId: `${driver}:${PROVIDER_INSTANCE_SUFFIX}`,
      driver,
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

  /**
   * Change what a session is and what it may do, mid-flight.
   *
   * `runtimeMode` IS THE ONE THAT MATTERS AND IT APPLIES IMMEDIATELY, including
   * to a turn that is already running: `openRequest` reads the session document
   * at the moment a tool asks, so tightening the mode stops the very next tool
   * call rather than the next turn. That is the property that makes this usable
   * as a brake — a human watching a detached session do something they did not
   * expect can take the rope back without stopping the work.
   *
   * Loosening mid-turn does NOT retroactively resolve requests already parked.
   * Those were opened under the old policy and a human answering them is the
   * only thing that should settle them; auto-accepting a question somebody is
   * already looking at would be a surprise in the dangerous direction.
   */
  updateSession(
    sessionId: string,
    /** `model: null` CLEARS the selection; absent leaves it alone. The two are
     *  different requests and JSON cannot express the difference any other way. */
    patch: { title?: string; runtimeMode?: RuntimeMode; detached?: boolean; model?: ModelSelectionValue | null },
  ): Session {
    const session = this.getSession(sessionId);
    if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");

    const next: Session = { ...session };
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new EngineStateError("invalid_request", "session title cannot be empty");
      next.title = title.slice(0, 200);
    }
    if (patch.runtimeMode !== undefined) {
      if (!RUNTIME_MODES.has(patch.runtimeMode)) throw new EngineStateError("invalid_request", "unknown runtime mode");
      next.runtimeMode = patch.runtimeMode;
    }
    if (patch.detached !== undefined) {
      if (typeof patch.detached !== "boolean") throw new EngineStateError("invalid_request", "detached must be a boolean");
      next.detached = patch.detached;
    }
    /**
     * THE MODEL IS CHANGEABLE MID-SESSION; the PROVIDER is not.
     *
     * A turn is routed by `providerInstanceId`, and the provider owns the
     * resume cursor that makes a session continuous — so swapping providers
     * mid-conversation would strand the history. Swapping models within the
     * session's own provider does not: the next claimed turn simply runs on the
     * new one. Validated against the session's instance for exactly that
     * reason.
     */
    if (patch.model !== undefined) {
      /**
       * `null` CLEARS IT, AND WITHOUT THIS THERE WAS NO WAY TO.
       *
       * A client wanting "back to the provider's own defaults" has to send
       * something, and `undefined` is not a thing you can send: `JSON.stringify`
       * drops the key, so the engine saw no patch at all and left the old
       * selection in place. The cockpit's "Provider default" row did exactly
       * that — the pill said one thing, the session record said another, and
       * the next reload snapped it back.
       */
      if (patch.model === null) {
        delete next.model;
      } else {
        const parsed = ModelSelection.safeParse(patch.model);
        if (!parsed.success) throw new EngineStateError("invalid_request", "model selection is malformed");
        if (parsed.data.instanceId !== session.providerInstanceId) {
          throw new EngineStateError("invalid_request", "model must belong to the session's provider instance");
        }
        next.model = parsed.data;
      }
    }
    // Nothing changed: no write, no event. A client polling a "save" button
    // should not fill the journal with rows that say nothing happened.
    if (
      next.title === session.title &&
      next.runtimeMode === session.runtimeMode &&
      next.detached === session.detached &&
      // COMPARED WHOLE, not field by field. The hand-written version listed
      // `model` and `effort`, so when the selection grew a context window and a
      // fast-mode switch, a patch that changed only those looked like a no-op
      // and was silently dropped — the write never happened and the event never
      // fired. Serialising cannot fall behind the shape it is comparing.
      JSON.stringify(next.model ?? null) === JSON.stringify(session.model ?? null)
    ) {
      return structuredClone(session);
    }
    next.updatedAt = this.now();
    atomicWrite(sessionMetadataFile(this.paths, sessionId), next);
    this.appendEvent(sessionId, { type: "session.updated", session: next });
    return structuredClone(next);
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

  tasks(sessionId: string): Task[] {
    this.getSession(sessionId);
    return structuredClone([...this.readTasks(sessionId).values()]);
  }

  /**
   * Store one attached file and hand back its handle.
   *
   * WRITTEN BEFORE THE MESSAGE THAT REFERS TO IT, and independent of any turn:
   * a human picks three files, changes their mind about one, then types. Binding
   * bytes to a turn at upload time would mean either inventing a turn that does
   * not exist yet or holding megabytes in memory until they send.
   *
   * The index is what makes an id resolvable. Without it `submitTurn` would have
   * to take the whole attachment from the client — including its PATH — and a
   * client-supplied path is a client-supplied file read.
   */
  putAttachment(sessionId: string, input: { name: string; mediaType: string; data: Uint8Array }): TurnAttachment {
    this.getSession(sessionId);
    if (input.data.byteLength === 0) throw new EngineStateError("invalid_request", "attachment is empty");
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new EngineStateError("invalid_request", "attachment is larger than the engine accepts");
    }
    const name = input.name.trim().slice(0, 200) || "attachment";
    const mediaType = input.mediaType.trim().slice(0, 120) || "application/octet-stream";
    const id = `att_${crypto.randomUUID().replaceAll("-", "")}`;
    const file = attachmentFile(this.paths, sessionId, id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input.data, { mode: 0o600 });
    const attachment: TurnAttachment = { id, name, mediaType, bytes: input.data.byteLength, path: file };
    const index = this.readAttachments(sessionId);
    index.set(id, attachment);
    atomicWrite(attachmentsFile(this.paths, sessionId), { version: STATE_VERSION, attachments: [...index.values()] });
    return structuredClone(attachment);
  }

  private readAttachments(sessionId: string): Map<string, TurnAttachment> {
    const stored = readJson(attachmentsFile(this.paths, sessionId)) as { attachments?: unknown } | undefined;
    const parsed = TurnAttachmentSchema.array().safeParse(stored?.attachments ?? []);
    // A corrupt index costs the ABILITY TO REFERENCE old attachments, not the
    // session. Throwing here would make one bad record unopenable forever.
    return new Map((parsed.success ? parsed.data : []).map((attachment) => [attachment.id, attachment]));
  }

  submitTurn(
    sessionId: string,
    input: { runId: string; input: string; model?: TurnModelSelection; attachments?: string[] },
  ): { turn: Turn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.input);
    const session = this.getSession(sessionId);
    const queue = this.readQueue(sessionId);
    const known = queue.turns.find((turn) => turn.runId === input.runId);
    if (known) {
      if (known.input !== input.input) throw new EngineStateError("conflict", "run id was already submitted with different text");
      return { turn: structuredClone(known), replayed: true };
    }
    /**
     * A FOLLOW-UP MAY BE QUEUED WHILE A TURN RUNS. This used to be a conflict,
     * which meant a human had to sit and wait for a long turn before they could
     * say the next thing — the single most common way to lose a thought.
     *
     * Only ONE turn executes at a time and that has not changed: `claimTurn`
     * refuses while any turn is claimed or running, and picks the OLDEST queued
     * one, so a backlog drains in the order it was typed. Provider continuity
     * still works because `resumeCursorFor` reads the last COMPLETED turn, and
     * the next claim happens after the previous turn settles.
     */
    const queued = queue.turns.filter((turn) => turn.state === "queued").length;
    if (queued >= MAX_QUEUED_TURNS) {
      throw new EngineStateError("conflict", "session already has the maximum number of queued turns");
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
      ...(() => {
        const ids = input.attachments ?? [];
        if (ids.length === 0) return {};
        if (ids.length > MAX_TURN_ATTACHMENTS) throw new EngineStateError("invalid_request", "too many attachments on one turn");
        const index = this.readAttachments(sessionId);
        const attachments = ids.map((id) => {
          const found = index.get(id);
          // Loud rather than silent: a message that says "look at this" and
          // arrives with nothing attached is worse than one that fails to send.
          if (!found) throw new EngineStateError("not_found", "attachment does not exist on this session");
          return found;
        });
        return { attachments };
      })(),
      /**
       * PER-TURN MODEL, STAMPED WITH THE SESSION'S INSTANCE.
       *
       * The client sends only `model`/`effort` — `TurnModelSelection` has no
       * instance field — and the instance comes from the session here. That is
       * what makes "the provider cannot change mid-conversation" true by
       * construction: there is no wire shape that could ask for it.
       */
      ...(input.model
        ? {
            model: {
              instanceId: session.providerInstanceId,
              // EITHER MAY BE ABSENT. "The provider's default model, at maximum
              // effort" is an ordinary thing to ask for, and spreading rather
              // than assigning is what keeps it from being stored as an
              // explicit `undefined` the engine would then hand to a driver.
              ...(input.model.model ? { model: input.model.model } : {}),
              ...(input.model.effort ? { effort: input.model.effort } : {}),
              ...(input.model.fastMode === undefined ? {} : { fastMode: input.model.fastMode }),
            },
          }
        : {}),
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
      /**
       * THE TURN'S OWN CHOICE BEATS THE SESSION'S, and that ordering is the
       * whole of "per-turn model".
       *
       * It matters most where it is least visible: queue three messages, change
       * the pill between them, and each one has to run on what was chosen when
       * it was written — not on whatever the session happens to say by the time
       * a worker gets to it. The session default is what a turn falls back to,
       * not what overrides it.
       */
      const model = turn.model ?? session.model;
      const mcpServers = this.listMcpServers().filter((server) => server.enabled);
      return {
        sessionId: session.id,
        projectRoot: session.workspace.path,
        driver: session.driver,
        providerInstanceId: session.providerInstanceId,
        // Resolved HERE, at claim time, so a model changed mid-session applies
        // to the next turn the worker picks up rather than to the one it is
        // already running.
        ...(model ? { model } : {}),
        // Filtered to the enabled ones in the engine, so "disabled" is decided
        // in exactly one place rather than trusted to every worker.
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
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
    const projection = { items: this.readItems(sessionId), tasks: this.readTasks(sessionId), tasksTouched: false };
    for (const observation of parsed.data) {
      this.journalObservation(sessionId, turn, observation, projection);
    }
    this.writeItems(sessionId, projection.items);
    // Most batches carry no task at all — a rewrite per batch would be a file
    // write per streamed provider message for nothing.
    if (projection.tasksTouched) this.writeTasks(sessionId, projection.tasks);
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

    // Free the session's browser. WITHOUT THIS, Chromium instances accumulate
    // until the pool's LRU evicts them six sessions later — which is a leak
    // measured in hundreds of megabytes on a machine running detached work.
    void this.browser?.release(sessionId, "session archived");

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

  /**
   * Tasks are a projection for the same reason items are — and they matter
   * MORE after a restart, not less. A background task outlives the turn that
   * started it, so a client reopening a cold session has no live stream to
   * learn about it from; `tasks.json` is the only thing that can still say the
   * session is working.
   */
  private readTasks(sessionId: string): Map<string, Task> {
    const stored = readJson(tasksFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = TaskSchema.array().safeParse((stored as { tasks?: unknown }).tasks);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid vNext task projection");
    return new Map(parsed.data.map((task) => [task.id, task]));
  }

  private writeTasks(sessionId: string, tasks: Map<string, Task>): void {
    atomicWrite(tasksFile(this.paths, sessionId), { version: STATE_VERSION, tasks: [...tasks.values()] });
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
  private journalObservation(
    sessionId: string,
    turn: Turn,
    observation: TurnObservation,
    projection: { items: Map<string, Item>; tasks: Map<string, Task>; tasksTouched: boolean },
  ): void {
    const at = this.now();
    const items = projection.items;
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
    if (observation.kind === "browser.state") {
      // No projection: a browser's tabs are LIVE state, not durable history.
      // Replaying them from a week-old journal would describe pages that are
      // long gone, so this rides the stream and nothing else.
      this.appendEvent(
        sessionId,
        { type: "browser.state.changed", provider: observation.provider, tabs: observation.tabs },
        turn.runId,
      );
      return;
    }
    if (observation.kind === "task.started" || observation.kind === "task.progress" || observation.kind === "task.completed") {
      const seed = observation.task;
      const known = projection.tasks.get(seed.id);
      const terminal = seed.state === "completed" || seed.state === "failed" || seed.state === "stopped";
      /**
       * THE SEED IS FOLDED OVER WHAT IS ALREADY STORED, not swapped for it.
       * Providers report tasks incrementally — Claude's `task_updated` carries
       * a PATCH with only the changed fields, so a straight replace would erase
       * the `title` and `subagent_type` that only `task_started` ever sent. The
       * `?? known?.x` chain is what makes a partial report additive.
       */
      const task: Task = {
        ...known,
        ...definedOnly(seed),
        id: seed.id,
        kind: seed.kind,
        state: seed.state,
        sessionId,
        // A background task belongs to the turn that STARTED it even after that
        // turn settles, which is the whole meaning of background.
        runId: known?.runId ?? turn.runId,
        startedAt: known?.startedAt ?? at,
        updatedAt: at,
        ...(terminal ? { completedAt: at } : known?.completedAt ? { completedAt: known.completedAt } : {}),
      };
      projection.tasks.set(task.id, task);
      projection.tasksTouched = true;
      this.appendEvent(
        sessionId,
        observation.kind === "task.progress"
          ? { type: "task.progress", task, ...(observation.message ? { message: observation.message } : {}) }
          : { type: observation.kind === "task.started" ? "task.started" : "task.completed", task },
        turn.runId,
      );
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
      // A row filed under a task the engine has never heard of is kept filed
      // anyway: the task event may simply not have arrived yet, and dropping
      // the link would silently move a sub-agent's work into the parent
      // timeline — the exact confusion this field exists to prevent.
      ...(seed.taskId ? { taskId: seed.taskId } : {}),
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
