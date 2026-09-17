// The engine owns its loopback listener and the only writable engine state root.
// It intentionally has no provider imports: Phase 1 proves ownership and crash
// semantics before a driver is allowed to execute an agent turn.
import crypto from "node:crypto";
import { createExecutionPort, withDirectExecution } from "./execution-port";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineClientError,
  DataScienceBootstrap,
  DataScienceCreateEnvironment,
  LatexBootstrap,
  parseForgeQuery,
  RequestOpenInput,
  AgentTurnInput,
  ProviderDriverKind,
  ProviderTurnOpenInput,
  SessionTaskReport,
  resolveMcpServers,
  TurnModelSelection,
  WakeKind as WakeKindSchema,
  WorkerTurnFailure,
  WorkerTurnFailureCode,
  type WakeKind,
  type EngineDiscovery,
  type EngineErrorCode,
  type EngineHealth,
  type McpOAuthStatus,
  type McpServer,
  type ModelSelection,
  type RuntimeMode,
  type TurnSubmissionResult,
  type UsageLimits,
  type WorkerClaim,
  type WorkerStatus,
  pluginEnabled,
  machineAllows,
  readProjectPlugins,
  workspacePath,
} from "@telar/engine-client";
import { runCliUpdate, type CliUpdateRun } from "./cli-updates";
import { computerUseStatus, grantComputerUseAccess, launchComputerUseHost, openComputerUseHost, resolveComputerUse } from "./computer-use";
import { bearerIsValid } from "./http-auth";
import { beginConnect, checkMcpHealth, completeConnect, NO_CLIENT_STRATEGY, probeMcpAuth } from "./mcp-oauth";
import { readProjectIconBytes } from "./project-icon";
import { createProviderProber, type VersionProbe } from "./provider-instances";
import { readProviderSkillsCached, type LoadProviderCommands } from "./provider-skills";
import { syncTelarSkill, TELAR_ORIENTATION } from "./orientation";
import { createLoginGrantStore } from "./secrets/login-grants";
import { sessionBootstrap, sessionSnapshot, type SessionBootstrapWindow } from "./session-bootstrap";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, statePaths, engineRootFromEnv, type EngineNotifier, type StoppedClaim } from "./state";
import { KernelHost } from "./ds/kernel-host";
import { bundledPlugins } from "./plugins/bundled";
import { PluginHost } from "./plugins/host";
import { setPluginReadTools } from "./driver";
import { createRunMount } from "./run/mount";
import { RunError } from "./run/types";
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
import { readUsageLimitSource } from "./usage-limits";
import type { SocketTool } from "./mcp-socket";
import {
  collectSessionsWallTools,
  ensureSessionsSocketSecret,
  handleSessionsSocketMessage,
  sessionsSocketConnectCard,
} from "./sessions-tools/socket";
import type { SessionsCapability } from "./sessions-tools/tools";
import {
  collectNotesWallTools,
  ensureNotesSocketSecret,
  handleNotesSocketMessage,
  notesSocketConnectCard,
} from "./notes-tools/socket";
import type { NotesCapability } from "./notes-tools/tools";
import { AGENT_SELF_ID, collectAgentTools } from "./agent/tools";
import { isAgentSelf } from "./agent/identity";
import { AgentRuntime, type AgentRuntimeOptions } from "./agent/runtime";
import { agentChatModel } from "./agent/model";
import { readAgentModels } from "./models";
import { DICTATION_OFF, DictationError } from "./dictation/token";
import { dictationProvider } from "./dictation/provider";
import { THREAD_PAGE_DEFAULT, THREAD_PAGE_MAX } from "./agent/thread-log";
import { INBOX_PAGE_DEFAULT, INBOX_PAGE_MAX } from "./agent/inbox";
import * as notebook from "./notes";
import { ProjectNotesError } from "./notes";
import type { GhRunner } from "./github";
import { sweepReport, sweepSpoolAndLooms } from "./decommission-sweep";
import { mainSweepReport, sweepMainSession } from "./agent/main-sweep";
import type { AsyncGitRunner, GitRunner } from "./worktree";
import type { VolumeDeps } from "./volumes";
import type { DriverSelector } from "./worker";

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
  executionStorage?: "json" | "sqlite";
  engineRoot?: string;
  port?: number;
  now?: () => number;
  /**
   * THE AGENT'S MODEL, INJECTED — the same seam `models` is, and for a sharper
   * reason (#531). The key ladder's third rung reads the OpenCode CLI's own
   * credential, so on a developer's machine the default factory finds a real
   * key and a route test would quietly spend real calls against a real API.
   * A test passes a scripted model; nothing in production passes anything.
   */
  agentModel?: AgentRuntimeOptions["model"];
  /**
   * HOW THE ENGINE REACHES DEEPGRAM'S GRANT ENDPOINT — injected for `gh`'s
   * reason and `agentModel`'s (#544). A route test that mints a dictation token
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
  // The notebook's own refusals, carried out whole: they are sentences written
  // for a person, and a 500 would replace each one with "internal error".
  if (error instanceof ProjectNotesError) {
    return new HttpError(error.code === "not_found" ? 404 : 400, error.code, error.message);
  }
  return new HttpError(500, "internal_error", "engine encountered an internal error");
}

function writeJson(response: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

/**
 * THE LIVE LIST'S ETAG — the revision cursor (#462) spelled the way HTTP spells
 * it, so a client that knows nothing about `?since=` still gets the cheap tick.
 *
 * THE MODE IS IN THE TAG, and that is what the query cursor could not do. A
 * `?since=` earned against the unsettled list and spent against `?all=1` would
 * be answered "unchanged" and leave a shelf empty, because the revision counts
 * WRITES and does not move when a reader opens one — which is why the wide read
 * refuses to be conditional on it. Two modes, two tags, and the wide read can
 * be conditional too.
 *
 * WEAK, because the claim is semantic. Two answers at one revision carry the
 * same rows; nothing here promises the same bytes, and `W/` is how that is said.
 */
function liveSessionsETag(revision: number, all: boolean): string {
  return `W/"live-${revision}-${all ? "all" : "lean"}"`;
}

/**
 * Does `If-None-Match` name this tag?
 *
 * WEAK COMPARISON, which is what RFC 9110 requires of `If-None-Match`: `W/"x"`
 * and `"x"` match, and a client that stripped the prefix somewhere along the
 * way is not punished for it. A list is a list — a browser may send back
 * several — and `*` means "if you have anything at all", which here is always.
 */
function matchesETag(header: string | string[] | undefined, tag: string): boolean {
  if (header === undefined) return false;
  const bare = (value: string): string => value.trim().replace(/^W\//, "");
  const wanted = bare(tag);
  for (const entry of (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(","))) {
    const candidate = bare(entry);
    if (candidate === "*" || candidate === wanted) return true;
  }
  return false;
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

/** How long a hub's quota answer is served without going back for another —
 *  five minutes, t3's provider-health cadence. Windows this gates move on the
 *  scale of hours; a shorter TTL would spend requests to redraw the same bar. */
const USAGE_LIMITS_TTL_MS = 5 * 60_000;

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

function sessionPath(pathname: string): { sessionId: string; tail: string } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), tail: match[2] ?? "" };
}

/**
 * `?turns=N[&before=runId]` — the newest N settled turns plus everything
 * unsettled, or the whole session when absent (the read a client older than the
 * window still makes). Shared by the snapshot route and `/bootstrap`, so the
 * two cannot disagree about what a window means or which inputs are rejected.
 */
function snapshotWindowParam(url: URL): SessionBootstrapWindow | undefined {
  const raw = url.searchParams.get("turns");
  const before = url.searchParams.get("before") ?? undefined;
  if (raw === null) {
    if (before !== undefined) throw new HttpError(400, "invalid_request", "before needs turns");
    return undefined;
  }
  const turns = Number(raw);
  if (!Number.isSafeInteger(turns) || turns < 1) throw new HttpError(400, "invalid_request", "turns must be a positive integer");
  return { turns, ...(before === undefined ? {} : { before }) };
}

/**
 * HOW MANY JOURNAL ROWS ONE `GET /v2/sessions/:id/events` MAY ANSWER WITH.
 *
 * 200 is the tail a cockpit actually folds per tick, and the size the #490
 * audit measured at 185 KB / 106 ms against 36.5 MB / 2.48 s for the same
 * session unpaged. A client that wants fewer says so; one that wants more is
 * capped, because the cap is what stops a caller from asking for the run back
 * in one piece and reinstating the cost this page size exists to remove.
 *
 * A LIMIT THAT IS NOT A NUMBER IS A BUG IN THE CALLER, not a reason to serve
 * the whole journal — it is refused rather than defaulted, the same way an
 * unparseable `turns` is.
 */
const EVENT_PAGE_DEFAULT = 200;
const EVENT_PAGE_MAX = 1000;

function eventPageLimit(raw: string | null): number {
  if (raw === null) return EVENT_PAGE_DEFAULT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new HttpError(400, "invalid_request", "limit must be a positive integer");
  return Math.min(limit, EVENT_PAGE_MAX);
}

/**
 * WHAT THE QUERY ROUTES MAY ANSWER WITH — issue #516.
 *
 * Every one of these is a CEILING, not a suggestion. The routes exist because a
 * tool answer lands in a model's context window (#515), so a caller that asks
 * for more than the ceiling is clamped rather than served: the point of the
 * bound is that it cannot be argued out of. A caller that wants the rest pages
 * for it, and every answer says whether there is a rest.
 *
 * THE DEFAULTS ARE WHAT THE ISSUE ASKED FOR: an outline page of 20 turns, a
 * grep page of 20 matches, ten sessions from `find`, 8,000 characters of one
 * step. The maxima are where one answer stops being something a model can hold
 * beside the rest of its work.
 */
const OUTLINE_PAGE_DEFAULT = 20;
const OUTLINE_PAGE_MAX = 100;
const GREP_PAGE_DEFAULT = 20;
const GREP_PAGE_MAX = 100;
const FIND_LIMIT_DEFAULT = 10;
const FIND_LIMIT_MAX = 50;
const ITEM_CHARS_DEFAULT = 8_000;
const ITEM_CHARS_MAX = 64_000;
const ANSWER_SLICE_DEFAULT = 8_000;
const ANSWER_SLICE_MAX = 64_000;

/**
 * A NON-NEGATIVE INTEGER QUERY PARAMETER, clamped — or refused.
 *
 * REFUSED RATHER THAN DEFAULTED when it is not a number, on `eventPageLimit`'s
 * argument: `?limit=all` is a bug in the caller, and quietly serving it the
 * default would hide the bug behind an answer that looks right.
 */
function positiveParam(raw: string | null, fallback: number, ceiling: number, label: string): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "invalid_request", `${label} must be a non-negative integer`);
  return Math.min(value, ceiling);
}

/**
 * `/runs/:runId/items` and `/runs/:runId/items/:step` — one shape, because the
 * list and the step are the same address at two depths and parsing them apart
 * would let the two disagree about what a run id may contain.
 *
 * `step` IS A NUMBER WHEN IT LOOKS LIKE ONE and an item id otherwise: a caller
 * that has just read the list names a position, and one that found the item in a
 * journal page names its id. See `runItem`.
 */
function runItemsPath(tail: string): { runId: string; step?: number | string } | undefined {
  const match = /^\/runs\/([A-Za-z0-9_-]+)\/items(?:\/([A-Za-z0-9_-]+))?$/.exec(tail);
  if (!match) return undefined;
  const raw = match[2];
  if (raw === undefined) return { runId: decodeURIComponent(match[1]) };
  const index = Number(raw);
  return { runId: decodeURIComponent(match[1]), step: Number.isSafeInteger(index) && index >= 0 ? index : decodeURIComponent(raw) };
}

type TurnAction = "running" | "observe" | "request" | "complete" | "fail" | "discard" | "release" | "resume" | "promote" | "steer-ack";

function turnPath(pathname: string): { sessionId: string; runId: string; action: TurnAction } | undefined {
  const match = /^\/v2\/sessions\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\/(running|observe|request|complete|fail|discard|release|resume|promote|steer-ack)$/.exec(pathname);
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
  let store: EngineStore;
  try {
  store = new EngineStore(root, options.now, {
    onQueueChanged: () => wakeEmbeddedWorker?.(),
    onTurnsStopped: (cancellations) => cancelEmbeddedClaims?.(cancellations),
    executionStorage: options.executionStorage ?? (process.env.TELAR_EXECUTION_STORE === "sqlite" ? "sqlite" : undefined),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.asyncGit ? { asyncGit: options.asyncGit } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.volumes ? { volumes: options.volumes } : {}),
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
   * AND WHAT THE MAIN SESSION LEFT — issue #531.
   *
   * THE KEY IS CARRIED FIRST, then the document goes. The order is the rule: the
   * carry reads the `telar` login's secret, and a sweep that deleted before
   * reading would lose the one thing the owner asked to keep. Both are
   * best-effort and silent unless something actually went — see
   * `agent/main-sweep.ts`.
   */
  // THREE STATEMENTS, NOT ONE ARGUMENT LITERAL. The carry must read the `telar`
  // login's secret before anything drops it, and an ordering rule that survives
  // only as long as nobody reorders the keys of an object literal is not a rule.
  const carriedKey = store.carryOverAgentKey();
  const droppedSecrets = store.removeRetiredProviderSecrets();
  const mainSwept = mainSweepReport({ carriedKey, droppedSecrets, removed: sweepMainSession(store.paths.root) });
  if (mainSwept) process.stdout.write(`${mainSwept}\n`);
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
   * THE `telar` SKILL, PUT WHERE EACH PROVIDER READS SKILLS FROM — or taken
   * away. Run once on start and again on every PATCH of the toggle.
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
    skillRoots.length ? syncTelarSkill({ install: policy.skill, roots: skillRoots }).catch(() => []) : Promise.resolve([]);
  void syncOrientationSkill();
  /** The per-transcript parse cache behind /v2/usage — beside the rates
   *  snapshot it prices with. See usage.ts. */
  const usageScanCachePath = path.join(store.paths.root, "usage-scan-cache.json");
  /**
   * THE LAST THING THE HUBS SAID, and when.
   *
   * IN MEMORY, NEVER ON DISK. A quota figure is true for minutes; one restored
   * from a file after a restart would be wrong by exactly as long as the engine
   * was down, and would look identical to a fresh one.
   *
   * STALE-WHILE-REVALIDATE RATHER THAN A TIMER. A background sweep would poll
   * hubs every five minutes for a page nobody has open; this refreshes on the
   * read that finds the snapshot old, serving the cached answer immediately and
   * fetching behind it. A cold read waits, `?refresh=1` waits, and a settings
   * change clears the cache so the next read is a fresh one — which is what
   * "refreshed on a settings change" has to mean when the alternative is
   * blocking the PUT on a hub round trip.
   */
  const usageLimitsCache: { snapshot?: UsageLimits; inFlight?: Promise<UsageLimits> } = {};
  const readUsageLimits = async (): Promise<UsageLimits> => {
    const sources = store.resolveUsageLimitSources();
    const snapshots = await Promise.all(sources.map((source) => readUsageLimitSource(source)));
    const snapshot: UsageLimits = { sources: snapshots, readAt: Date.now() };
    usageLimitsCache.snapshot = snapshot;
    return snapshot;
  };
  /** One read at a time: two page loads a second apart must not become two
   *  rounds of outbound requests to every configured hub. */
  const refreshUsageLimits = (): Promise<UsageLimits> => {
    usageLimitsCache.inFlight ??= readUsageLimits().finally(() => {
      usageLimitsCache.inFlight = undefined;
    });
    return usageLimitsCache.inFlight;
  };
  const daemonId = crypto.randomUUID();
  /**
   * The kernel host is built much later than the plugin host — it needs the
   * bound port's environment — so data science reads it through this ref rather
   * than capturing an undefined. Read at CALL time, when a kernel either exists
   * or honestly does not.
   */
  const kernelsRef: { current: KernelHost | undefined } = { current: undefined };
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
  const pluginHost = new PluginHost(
    bundledPlugins({
      resolveHello: (sessionId) => resolvePluginProject("hello", sessionId),
      // The SAME capabilities the aliases and the tool walls already use —
      // migrating a door must not change what is behind it. Each gate is the
      // store's own, which reads the plugin map.
      latex: { resolve: (sessionId) => store.latex(sessionId), jobs: store.latexJobs },
      dataScience: {
        resolve: (sessionId) => store.dataScience(sessionId),
        kernels: {
          list: () => (kernelsRef.current?.list() ?? []).map((info) => ({ sessionId: info.sessionId, state: info.state })),
          dispose: (sessionId, reason) => kernelsRef.current?.dispose(sessionId, reason),
          disposeAll: (reason) => kernelsRef.current?.disposeAll(reason),
        },
        projectOf: (sessionId) => {
          try { return store.getSession(sessionId).projectId; } catch { return undefined; }
        },
      },
    }),
    {
      daemonId,
      stateDir: store.paths.root,
      log: (message, detail) => console.warn(`[telar] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
    },
  );
  /**
   * RUN CONFIGURATIONS. The daemon owns the process group — a dev server
   * spawned by a worker would die with its conversation — and `createRunMount`
   * recovers its journal BEFORE returning, so the port is never bound in front
   * of a manager that has not read it.
   */
  const runMount = createRunMount({ root: store.paths.root });
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
      return runCliUpdate(driver, { ...(binaryPath ? { binaryPath } : {}) });
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
  /**
   * THE IN-PROCESS SESSIONS CAPABILITY, WITH OR WITHOUT A `self`.
   *
   * ONE BUILD, TWO CALLERS (#531). The outward MCP socket takes it with no
   * `self` — a chat client is not a session and has nowhere to be woken, so the
   * subscription tools refuse in words. The built-in Agent takes the same build
   * with `self: { sessionId: "agent" }`, which is the only difference between
   * them: it has somewhere to be woken and something to be attributed to.
   *
   * Written as a parameter rather than as a second object so a verb added to
   * one is added to both — the drift this seam exists to prevent is exactly the
   * kind nobody notices until an agent's tool answers differently from a chat
   * client's.
   */
  const buildSessionsCapability = (self?: { sessionId: string }): SessionsCapability => {
    /**
     * EVERY MEMBER DELEGATES TO A `store.*` METHOD THAT ALREADY EXISTS. There
     * is no validation here and
     * there must not be: `createSession` owns the env-mode rule and the
     * driver check; `submitTurn` owns the backlog cap; `readEvents` owns the
     * cursor check. A check written at this seam would protect the socket
     * and nothing else.
     *
     * `origin: "session"` IS DECLARED BY THIS CODE, never by a caller: no tool
     * shape on the wall carries it — provenance a list can show, nothing more.
     */
    return {
      // ABSENT for the socket: a chat client on it is not a session and has
      // nowhere to be woken, so the subscription tools refuse in words. PRESENT
      // for the Agent, which has both.
      ...(self ? { self } : {}),
      /**
       * THE SHELF IS THE STORE'S RULE, ASKED FOR RATHER THAN RE-IMPLEMENTED
       * (#515). This used to be `store.liveSessions()` — every session the
       * store calls live, settled included, 334 rows and 142 KB in one tool
       * answer. `liveSessionRows` is the same fold the rail's own route serves,
       * with the clients' `isShelved` deciding, so the toolkit's default list
       * and the person's sidebar agree by construction rather than by two
       * copies of one rule. `settled: true` is `?all=1`, the old answer.
       */
      list: async (options) => store.liveSessionRows({ all: options?.settled === true }),
      create: async (input) => store.createSession({ ...input, origin: "session" }),
      /**
       * An agent's words, with no session to attribute them to: the caller is
       * the user's own chat client, outside any turn. Never the person's.
       *
       * THE AGENT'S BUILD PASSES ITS OWN NAME AS PROOF (#539), and that is the
       * whole of the difference. It buys one thing — a human Stop on the
       * recipient latches out peer sessions and not the Agent, which the person
       * is typing at right now — and the store says in its answer when that
       * latch was stepped over. The socket's build has no `self` and so sends
       * unproven, exactly as before: a chat client is not the Agent.
       */
      send: async (sessionId, input) =>
        store.submitAgentTurn(sessionId, input, self && isAgentSelf(self.sessionId) ? { sessionId: AGENT_SELF_ID } : undefined),
      read: async (sessionId, after, options) => store.readEvents(sessionId, after, options?.limit),
      // The last event id, so the wall can serve "what happened lately" from
      // one page rather than by walking a journal to reach its end (#515).
      cursor: async (sessionId) => store.eventCursor(sessionId),
      status: async (sessionId) => ({
        session: store.getSession(sessionId),
        turns: store.turns(sessionId),
        // The held mail, so the cap's "stays pending and pollable" has a poll.
        pendingNotifications: store.pendingNotifications(sessionId),
      }),
      // STOP IS STOP, whoever presses it. An agent stopping a peer ends the
      // same work a person's Stop ends, and leaves the session idle rather
      // than latched — see `stopSession`.
      stop: async (sessionId) => store.stopSession(sessionId, "agent"),
      settle: async (sessionId, settled) => store.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" }),
      diff: async (sessionId) => await store.sessionDiffAsync(sessionId),
      subscribe: async (subscriber, input) => store.subscribe(subscriber, input),
      unsubscribe: async (id, subscriber) => store.unsubscribe(id, subscriber),
      subscriptions: async (subscriber) => store.subscriptionsFor(subscriber),
      requests: async (sessionId) => store.requests(sessionId),
      resolveRequest: async (sessionId, requestId, input) => store.resolveRequest(sessionId, requestId, { ...input, resolvedBy: "session" }),
    };
  };
  const sessionsSocketTools = (): SocketTool[] => (sessionsToolsCache ??= collectSessionsWallTools(buildSessionsCapability()));

  /**
   * THE NOTES SOCKET'S SECRET AND TOOLS — the third door, lazy like the other
   * two and minted separately from both: three doors, three keys.
   */
  let notesSecretCache: string | undefined;
  const notesSecret = () => (notesSecretCache ??= ensureNotesSocketSecret(store.paths));
  let notesToolsCache: SocketTool[] | undefined;
  /**
   * THE NOTEBOOK CAPABILITY, shared by the outward socket and the Agent for
   * `buildSessionsCapability`'s reason — one build, so a rule added to one door
   * is added to both. Neither has a `self`: a chat client has no project to
   * default to, and neither has the Agent, which owns no checkout at all.
   */
  const buildNotesCapability = (): NotesCapability => {
    /**
     * NO `self`: a chat client on this socket is not in a session and has no
     * project to default to, so `notes_list` asks it for one by name — exactly
     * as the sessions socket's absent `self` makes the subscription tools
     * refuse. Every member lands on `notes.ts`, the same functions the HTTP
     * routes below call, so there is one implementation of every rule.
     *
     * `getProject` IS THE GATE ON EVERY WRITE, here as on the routes: an id
     * nobody registered must not be able to mint a notebook file.
     */
    return {
      projects: async () => store.listProjects().map((project) => ({ id: project.id, name: project.name })),
      list: async (projectId) => {
        store.getProject(projectId);
        return notebook.readNotes(store.paths, projectId);
      },
      read: async (noteId) => notebook.findNote(store.paths, noteId),
      create: async (projectId, input) => {
        store.getProject(projectId);
        // THE WALL DECLARES `author: "session"`, never a caller: no tool shape
        // carries it.
        return notebook.createNote(store.paths, projectId, { ...input, author: "session" });
      },
      update: async (projectId, noteId, patch) => {
        store.getProject(projectId);
        return notebook.updateNote(store.paths, projectId, noteId, patch);
      },
      remove: async (projectId, noteId) => notebook.deleteNote(store.paths, projectId, noteId),
    };
  };
  const notesSocketTools = (): SocketTool[] => (notesToolsCache ??= collectNotesWallTools(buildNotesCapability()));

  /** Every live `GET /v2/agent/stream`, so shutdown can end them — see the
   *  route. A `Set` of teardown functions rather than of responses: the route
   *  owns what ending one means. */
  const openStreams = new Set<(() => void) & { end?: () => void }>();

  /**
   * THE BUILT-IN AGENT — one per machine, in this process (#531).
   *
   * BUILT EAGERLY AND OPENED LAZILY. Constructing it costs nothing: the runtime
   * reads `agent.json` per call and opens `threads.sqlite` on the first turn,
   * thread read or stream, so an engine whose Agent has never been switched on
   * never grows a database. What being built early buys is the wake sink below,
   * which has to be in place before any turn can end.
   *
   * ITS WALL IS REBUILT PER TURN, through the same two builders the outward
   * socket uses, with a `self` of `agent`. See `agent/tools.ts` for why the
   * daemon's capability is the right one and why neither build carries the
   * request gate.
   */
  const agentRuntime = new AgentRuntime({
    engineRoot: root,
    tools: () =>
      collectAgentTools({
        sessions: buildSessionsCapability({ sessionId: AGENT_SELF_ID }),
        notes: buildNotesCapability(),
        query: {
          find: async (query) => store.findSessions(query),
          outline: async (sessionId, window) => store.turnOutline(sessionId, window),
          answer: async (sessionId, options) => store.turnAnswer(sessionId, options),
        },
      }),
    model:
      options.agentModel ??
      ((input) =>
        agentChatModel({
          threadId: input.threadId,
          ...(input.model ? { model: input.model } : {}),
          // `reasoning_effort` on the wire, and only when somebody set it —
          // see `agent/model.ts` for why it is omitted rather than defaulted.
          ...(input.effort ? { effort: input.effort } : {}),
          agentDir: path.join(root, "agent"),
        })),
    ...(options.now ? { now: options.now } : {}),
    // THE SAME PARAGRAPH EVERY OTHER TURN ON THIS MACHINE GETS, under the same
    // switch — `AgentOrientation.preamble`. A coordinator that did not know
    // what Telar is would be the one conversation on the machine that did not.
    orientation: () => (store.getAgentOrientation().preamble ? TELAR_ORIENTATION : undefined),
  });
  /**
   * A COMPLETION OR A PARKED REQUEST ON A SUBSCRIBED SESSION BECOMES AN INBOX
   * ROW — and no turn at all (#541 A).
   *
   * The store fans subscriptions out and finds one subscriber that is not a
   * session; this is where that one goes. Registered here rather than inside
   * the runtime because the direction matters: the runtime knows about the
   * store, and the store must not know about a graph.
   *
   * IT HANDS OVER THE NOTIFICATION WHOLE, the one `notification.ts` minted for
   * every subscriber to this transition (#550), so the Agent's row and a
   * session's notification item say the same sentence about the same fact.
   */
  store.setAgentWakeSink((wake) => {
    agentRuntime.wake({ notification: wake.notification });
  });
  /**
   * AN APPROVAL THIS MACHINE PARKED BEFORE IT LAST STOPPED, FOUND AGAIN.
   *
   * AWAITED, so `GET /v2/agent` cannot answer "nothing pending" to a cockpit
   * that is holding the very question. One bounded read of a thread that in the
   * ordinary case does not exist — see `AgentRuntime.restore`.
   */
  await agentRuntime.restore();

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

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      /**
       * THE SESSIONS SOCKET — an OUTWARD MCP socket, before the bearer check,
       * because its auth is DELIBERATELY NOT the management token: it answers
       * to its OWN dedicated secret and to nothing else, in both directions.
       * The engine token does not open it, and a leaked socket secret opens no
       * other route (every other path still demands the bearer above) —
       * including, deliberately, the archive and delete verbs, which stay a
       * person's: a chat client that could archive a session could erase
       * another agent's work.
       *
       * Streamable HTTP, stateless, tools only: POST carries one JSON-RPC
       * message; GET (the server-initiated stream) is declined 405, which the
       * protocol permits; DELETE has no session to end and says so with a 200.
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
      /**
       * THE NOTES SOCKET — the user's "other app" door, beside the two above and
       * before the bearer check for the identical reason: it answers to its OWN
       * secret in both directions. The engine token does not open it, and its
       * secret opens nothing else — a client holding it can read and write this
       * machine's project notebooks and cannot touch a session, a file or a turn.
       */
      if (url.pathname === "/v2/notes/mcp") {
        if (!bearerIsValid(request.headers.authorization, notesSecret())) {
          writeJson(response, 401, {
            error: { code: "engine_unauthorized", message: "the notes socket answers to its own secret — see /v2/notes/mcp-info" },
          });
          return;
        }
        if (request.method === "POST") {
          const message = await body(request);
          const answer = await handleNotesSocketMessage(notesSocketTools(), message);
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
        writeJson(response, 405, { error: { code: "invalid_request", message: "the notes socket is POST-only — it keeps no stream open" } });
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
            // The delegation grace, by the same present-but-null rule — see
            // `InboxPolicy`. Its own key because it is its own question: one
            // window guesses from silence, the other counts from a delivery.
            ...("settleDelegatedAfterHours" in input ? { settleDelegatedAfterHours: input.settleDelegatedAfterHours } : {}),
          }),
        });
        return;
      }
      /**
       * WHETHER TELAR MAY TELL AN AGENT WHERE IT IS — see `AgentOrientation`.
       * A document of the environment, like the inbox rule above and for the
       * sharper version of its reason: this decides what every session on the
       * machine is told, so it cannot live in one client's storage.
       *
       * THE PATCH RE-SYNCS THE SKILL BEFORE IT ANSWERS. "Off" has to mean the
       * file is GONE, not that it stops being refreshed — someone switching
       * this off is saying they want nothing of Telar's in their agent's
       * context, and a stale `SKILL.md` would still be read.
       */
      if (url.pathname === "/v2/orientation" && (request.method === "GET" || request.method === "PATCH")) {
        // THE WORDS RIDE THE ANSWER. "Show the text" in Settings has to show
        // what THIS engine injects, not a second copy of the paragraph kept in
        // the cockpit — a paired Mac may be running a different release, and a
        // disclosure that could disagree with the injection is worse than none.
        if (request.method === "GET") {
          writeJson(response, 200, { orientation: store.getAgentOrientation(), text: TELAR_ORIENTATION });
          return;
        }
        const input = await body(request);
        const orientation = store.setAgentOrientation({
          ...("preamble" in input ? { preamble: input.preamble } : {}),
          ...("skill" in input ? { skill: input.skill } : {}),
        });
        await syncOrientationSkill(orientation);
        writeJson(response, 200, { orientation, text: TELAR_ORIENTATION });
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
       * ══ THE BUILT-IN AGENT — issue #531 ══
       *
       * Eight routes, and they are deliberately NOT under `/v2/sessions/`: the
       * Agent is not a session, it has no id in that namespace, and a client
       * that reached it through a session route would be told a conversation
       * exists that `sessions_read` cannot open.
       *
       * THE RAIL DOES NOT READ ANY OF THESE. It gets `agent: { enabled }` off
       * `/v2/sessions/live`, which it already polls — one flag, because a row
       * that only shows a label needs nothing else. These are the pane's reads
       * and the composer's writes.
       */
      if (url.pathname === "/v2/agent" && (request.method === "GET" || request.method === "PATCH")) {
        if (request.method === "PATCH") {
          const input = await body(request);
          // FORWARDED BY PRESENCE, unvalidated, like every other settings patch
          // here: the shape lives beside the schema in `agent/store.ts`, and a
          // second copy at this seam could disagree with it.
          agentRuntime.patch({
            ...("enabled" in input ? { enabled: input.enabled } : {}),
            ...("model" in input ? { model: input.model } : {}),
            // The composer's other two pills (#539). Same forwarding rule as the
            // model beside them: presence, unvalidated, because the shape lives
            // once beside the schema.
            ...("effort" in input ? { effort: input.effort } : {}),
            ...("access" in input ? { access: input.access } : {}),
            ...("reset" in input ? { reset: input.reset } : {}),
          });
          /**
           * THE KEY IS WRITE-ONLY, AND IS NOT PART OF THE SETTINGS DOCUMENT.
           *
           * Stored 0600 beside the thread rather than on `agent.json`, for
           * `providerSecrets`' own reason: the settings document is handed to
           * every client that opens the pane, and a key on it would be one
           * redaction away from being echoed back to a browser. There is no
           * redacted round trip to preserve either — the only field is one a
           * person retypes, and an empty string clears it.
           */
          if ("apiKey" in input) store.setAgentKey(input.apiKey);
        }
        // THE CREDENTIAL RIDES ALONG, because the pane that reads this is the
        // pane that decides whether to show a setup field, and asking in a
        // second request would let the two disagree about one instant. Which
        // RUNG answered, never the key.
        writeJson(response, 200, { agent: agentRuntime.state(), credential: store.agentCredential() });
        return;
      }
      /**
       * WHAT THE AGENT MAY RUN, DESCRIBED.
       *
       * ITS OWN ROUTE because `/v2/models/:driver` is keyed by
       * `ProviderDriverKind` and answers "what can this SESSION run" — and the
       * Agent is not a session. Go's public endpoint, no credential (the docs
       * publish it as open), merged with models.dev's descriptions and the
       * transcribed route table — see `agent/catalogue.ts`.
       *
       * THE AGENT DIRECTORY IS PASSED BECAUSE THE DESCRIPTIONS ARE CACHED IN
       * IT: models.dev's `api.json` is 4.6 MB, so it is read at most once a day
       * into `<engineRoot>/agent/catalogue.json`. It still fails soft with the
       * service's own words — an empty picker carrying the reason beats one
       * full of ids that 404.
       */
      if (request.method === "GET" && url.pathname === "/v2/agent/models") {
        writeJson(response, 200, await readAgentModels(path.join(root, "agent")));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/agent/turns") {
        const input = await body(request);
        const text = stringValue(input.text, "text") ?? "";
        try {
          writeJson(response, 201, { ...agentRuntime.submit({ text }), agent: agentRuntime.state() });
        } catch (error) {
          // A switched-off Agent and an empty message are both the caller's
          // mistake, said in the sentence the runtime wrote for them.
          throw new HttpError(409, "conflict", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/v2/agent/turns/") && url.pathname.endsWith("/cancel")) {
        const runId = url.pathname.slice("/v2/agent/turns/".length, -"/cancel".length);
        // STOPPED IS A FACT, NOT A 404. A run that already finished answers
        // `false` rather than an error: a Stop pressed a beat late is not a
        // client bug, and it must not paint a failure over a turn that worked.
        writeJson(response, 200, { stopped: agentRuntime.cancel(runId || undefined), agent: agentRuntime.state() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/agent/thread") {
        writeJson(response, 200, agentRuntime.thread({
          after: positiveParam(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, "after"),
          limit: positiveParam(url.searchParams.get("limit"), THREAD_PAGE_DEFAULT, THREAD_PAGE_MAX, "limit"),
        }));
        return;
      }
      /**
       * ══ THE WAKE INBOX — issue #541, section A ══
       *
       * WHAT REPLACED THE WAKE TURN. A completion on a subscribed session writes
       * a row here and starts nothing; the next turn a person begins opens with
       * a digest of what is unread. These two routes are what a client needs to
       * draw the same thing the model was shown, and to clear it.
       *
       * BOUNDED LIKE EVERY OTHER READ IN THIS ENGINE (#515): `after` is an
       * exclusive cursor, `limit` is clamped by the store, and `more` says
       * whether the page stopped early. `unread=1` is the section above the
       * composer; without it the route pages the whole inbox, which is what a
       * "show everything" disclosure would ask for.
       */
      if (request.method === "GET" && url.pathname === "/v2/agent/inbox") {
        const unreadOnly = url.searchParams.get("unread");
        writeJson(response, 200, agentRuntime.inbox({
          after: positiveParam(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, "after"),
          limit: positiveParam(url.searchParams.get("limit"), INBOX_PAGE_DEFAULT, INBOX_PAGE_MAX, "limit"),
          ...(unreadOnly === "1" || unreadOnly === "true" ? { unreadOnly: true } : {}),
        }));
        return;
      }
      /**
       * MARK ROWS READ, BY ID.
       *
       * BY ID AND NEVER "EVERYTHING", for `resolveAgentRequest`'s reason: a
       * client holding a stale list must not be able to clear rows that landed
       * after it last looked. `read` is how many actually MOVED, so a second
       * press of the same button answers `0` rather than claiming a write that
       * did nothing.
       */
      if (request.method === "POST" && url.pathname === "/v2/agent/inbox/read") {
        const input = await body(request);
        const ids = Array.isArray(input.ids) ? input.ids.filter((id: unknown): id is number => typeof id === "number") : undefined;
        if (!ids) throw new HttpError(400, "invalid_request", "ids must be a list of row ids");
        if (ids.length > INBOX_PAGE_MAX) throw new HttpError(400, "invalid_request", `mark at most ${INBOX_PAGE_MAX} rows read at a time`);
        writeJson(response, 200, agentRuntime.markInboxRead(ids));
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/v2/agent/requests/")) {
        const requestId = url.pathname.slice("/v2/agent/requests/".length);
        const input = await body(request);
        const decision = input.decision === "accept" ? "accept" : input.decision === "decline" ? "decline" : undefined;
        if (!decision) throw new HttpError(400, "invalid_request", 'decision must be "accept" or "decline"');
        // ANSWERED BY ID, so a client holding a stale question cannot approve
        // the one that replaced it. `false` means it was already answered.
        writeJson(response, 200, { resolved: agentRuntime.resolveRequest(requestId, decision), agent: agentRuntime.state() });
        return;
      }
      /**
       * THE ENGINE'S FIRST PUSH ROUTE, AND IT IS KEPT SMALL ON PURPOSE.
       *
       * Server-sent events over the same bearer auth as everything else: no
       * second protocol, no upgrade, no library. `after` is a transcript cursor,
       * so the contract is the one every other read here has — page what you
       * missed, then watch.
       *
       * THE BACKLOG IS SENT FIRST, INSIDE THE SAME RESPONSE. A client that
       * paged and then subscribed would have a gap between the two calls; this
       * closes it by replaying from the caller's cursor before the live feed
       * starts, on one connection.
       *
       * A DELTA IS NOT REPLAYABLE and is not replayed: it is live-only, and the
       * assistant row that follows carries the whole text. A client joining
       * mid-sentence sees the finished message a moment later rather than half
       * of one for ever.
       */
      if (request.method === "GET" && url.pathname === "/v2/agent/stream") {
        const after = positiveParam(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, "after");
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        const send = (event: unknown) => {
          try {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // The socket has gone; the close handler below unsubscribes.
          }
        };
        /**
         * ONE FRAME BEFORE ANYTHING ELSE, AND IT IS NOT POLITENESS.
         *
         * Measured: `writeHead` alone does not put the headers on the wire, so a
         * client subscribing to a QUIET thread — one with no backlog to replay —
         * sat in `await fetch(...)` until something happened to be said. Which is
         * exactly backwards: the emptier the conversation, the longer the client
         * hung waiting to be told it had connected. A comment frame flushes them
         * and is ignored by every SSE reader.
         */
        response.write(": open\n\n");
        for (const row of agentRuntime.thread({ after, limit: THREAD_PAGE_MAX }).rows) send({ type: "row", row });
        const stop = agentRuntime.watch(send);
        // A COMMENT FRAME ON A TIMER, because a stream that says nothing for
        // twenty minutes is one a proxy closes. It is not an event and no
        // client has to know about it.
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
        /**
         * THE SHUTDOWN HAS TO BE ABLE TO END THIS.
         *
         * `server.close()` stops accepting and then WAITS for open connections,
         * and an SSE stream is a connection that by design never ends — so a
         * daemon with a cockpit watching the Agent would hang on close for ever.
         * Registered here and ended in `close()` below, before the server is
         * asked to shut: the client sees a clean end of stream and reconnects to
         * whatever comes back up.
         */
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
      /**
       * ══ DICTATION — issue #544, first step ══
       *
       * TWO ROUTES, AND NEITHER OF THEM CARRIES AUDIO. The microphone is in the
       * client on every surface Telar has, so the engine does the one thing only
       * it can: it holds the long-lived Deepgram key, and mints a token that
       * expires in minutes for a client to open its own socket with. Relaying
       * frames through a Mac that has no reason to see them is the second step's
       * problem, and may never be one — see `dictation/token.ts`.
       *
       * MACHINE-SCOPED, like the session defaults and the Agent beside it: the
       * desktop shell, a browser tab and a paired phone read one engine, and a
       * per-client key would be a key pasted once per device.
       */
      if (url.pathname === "/v2/dictation" && (request.method === "GET" || request.method === "PATCH")) {
        /**
         * THE KEY IS WRITE-ONLY AND THERE IS NO SETTINGS DOCUMENT FOR IT TO
         * RIDE ON. Stored 0600 under `dictation/`, for `agentKeyFile`'s reason:
         * anything handed to every client that opens the pane is one redaction
         * away from being echoed back to a browser. There is no redacted round
         * trip to preserve either — the only field is one a person retypes, and
         * an empty string clears it.
         */
        if (request.method === "PATCH") {
          const input = await body(request);
          // BY PRESENCE, both of them. A client that sent no key must not be
          // read as clearing one, and a client that sent no provider must not
          // be read as switching dictation off.
          if ("provider" in input) store.setDictationProvider(input.provider);
          if ("language" in input) store.setDictationLanguage(input.language);
          if ("apiKey" in input) store.setDictationKey(input.apiKey);
        }
        // `provider` IS A SETTING NOW, not a constant riding the answer. `off`
        // is the default and means there is no mic button anywhere — see
        // `dictation/provider.ts` for why that is the honest default rather
        // than a feature switched off. `configured` is still the whole of what
        // may be said about the key, and it is answered even when the provider
        // is off so the pane can say a key is already there.
        //
        // `language` AND `languages` TRAVEL TOGETHER (#560): the code that is
        // stored, and the vocabulary it is written in, so a picker can be drawn
        // from one answer without a second route and without a client holding a
        // copy of a vendor's language table.
        writeJson(response, 200, { dictation: store.dictationState() });
        return;
      }
      /**
       * A TOKEN, SPENT ONCE, WORTH LITTLE IF CAUGHT.
       *
       * POST rather than GET because it MINTS something: it is a call to
       * Deepgram that costs a round trip and produces a new credential every
       * time, and a GET that did that would be cached by something eventually.
       *
       * THE REFUSALS ARE THREE DIFFERENT FACTS. Dictation being off is a
       * `conflict` naming the pane that turns it on — and it is the ordinary
       * default rather than a misconfiguration; no key is a `conflict` naming
       * the pane to paste one on; Deepgram refusing is `provider_unavailable`
       * carrying Deepgram's own words, because "401" alone cannot tell a person
       * whether the key is wrong or the account is out of credit. All three are
       * sentences — a client's only move is to show one to a person.
       *
       * THE PROVIDER DECIDES, AND IT DECIDES BY NOT HAVING A `mintToken`. That
       * is what keeps "off spends nothing" true for the next provider too,
       * rather than being an `if` somebody has to remember to write again.
       */
      if (request.method === "POST" && url.pathname === "/v2/dictation/token") {
        try {
          const state = store.dictationState();
          const chosen = dictationProvider(state.provider);
          if (!chosen.mintToken) throw new DictationError("off", DICTATION_OFF);
          // THE LANGUAGE GOES DOWN WITH THE TOKEN (#560). Both clients ask for
          // one on every press of the mic button and neither reads the settings
          // route on that path, so putting it here is what makes a single round
          // trip answer "with what credential" and "in which language" at once.
          writeJson(
            response,
            200,
            await chosen.mintToken({
              key: store.dictationKey(),
              language: state.language,
              ...(options.dictationFetch ? { fetchImpl: options.dictationFetch } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof DictationError) {
            const conflict = error.kind === "off" || error.kind === "unconfigured";
            throw new HttpError(conflict ? 409 : 502, conflict ? "conflict" : "provider_unavailable", error.message);
          }
          throw error;
        }
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
            // Present-key rather than defined-value, so each of the three
            // arrangements is patched only by a client that meant to patch it.
            ...("projectOrder" in input ? { projectOrder: input.projectOrder } : {}),
            ...("sessionOrder" in input ? { sessionOrder: input.sessionOrder } : {}),
            ...("pinnedOrder" in input ? { pinnedOrder: input.pinnedOrder } : {}),
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
       * REMEMBERED LOGINS — what a person allowed agents to fill without being
       * asked again, and the one place to take it back. READ AND DELETE ONLY:
       * a grant can be created in exactly one way, by ticking an unchecked box
       * on an approval card the person was already answering, so there is no
       * route here that could mint one.
       */
      if (request.method === "GET" && url.pathname === "/v2/browser/logins") {
        writeJson(response, 200, { logins: createLoginGrantStore(store.paths.root).list() });
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/v2/browser/logins/")) {
        const id = decodeURIComponent(url.pathname.slice("/v2/browser/logins/".length));
        if (!createLoginGrantStore(store.paths.root).revoke(id)) throw new HttpError(404, "not_found", "no such remembered login");
        writeJson(response, 200, { ok: true });
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
      /**
       * THE HUBS QUOTA IS READ FROM — configuration, not the quota itself.
       *
       * MANAGEMENT KEYS NEVER COME BACK. `listUsageLimitSources` is the
       * redacting read; the store keeps the only unredacting one and it is not
       * reachable from here. A key arrives on the PUT and is never echoed.
       */
      if (request.method === "GET" && url.pathname === "/v2/usage/sources") {
        writeJson(response, 200, { sources: store.listUsageLimitSources() });
        return;
      }
      const usageLimitSource = /^\/v2\/usage\/sources\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(url.pathname);
      if (usageLimitSource && (request.method === "PUT" || request.method === "DELETE")) {
        const id = decodeURIComponent(usageLimitSource[1]!);
        // Either edit invalidates the snapshot: the next read contacts what is
        // configured NOW rather than serving a row for a hub just removed.
        usageLimitsCache.snapshot = undefined;
        if (request.method === "DELETE") {
          writeJson(response, 200, { removed: store.removeUsageLimitSource(id) });
          return;
        }
        const input = await body(request);
        writeJson(response, 200, {
          source: store.saveUsageLimitSource({
            id,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            // `null` clears the label, absent leaves it — the three-state rule
            // the provider-instance PUT above follows, for the same reason.
            ...(input.label === undefined ? {} : { label: input.label as string | null }),
            ...(input.url === undefined ? {} : { url: input.url }),
            // Empty KEEPS the stored key; the store owns that rule so a client
            // can save a row it read back redacted.
            ...(input.managementKey === undefined ? {} : { managementKey: input.managementKey }),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
          }),
        });
        return;
      }
      /**
       * WHAT THE HUBS CURRENTLY REPORT. Cached in memory and served stale while
       * it refreshes behind the answer; `?refresh=1` waits for a fresh read.
       * A source that failed keeps its row with `error` set — see usage-limits.ts.
       */
      if (request.method === "GET" && url.pathname === "/v2/usage/limits") {
        const cached = usageLimitsCache.snapshot;
        if (url.searchParams.get("refresh") === "1" || !cached) {
          writeJson(response, 200, { limits: await refreshUsageLimits() });
          return;
        }
        if (Date.now() - cached.readAt >= USAGE_LIMITS_TTL_MS) void refreshUsageLimits().catch(() => undefined);
        writeJson(response, 200, { limits: cached });
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
      /**
       * THE PROJECT NOTEBOOK — `docs/design/project-notes.md`. Under
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
        // REVALIDATED AT THE READ, not trusted from the record. The file can
        // change or go between the resolve and the read — a `git checkout`
        // mid-request is enough — and this is where the bytes leave the
        // machine, so confinement, the size bound and the content type are all
        // re-established against what is being sent. A file that no longer
        // qualifies is the same answer as "this project has no icon", which
        // the avatar already falls back on; a 500 would make an ordinary race
        // look like a broken engine.
        const served = await readProjectIconBytes(icon);
        if (!served) throw new HttpError(404, "not_found", "this project has no icon");
        response.writeHead(200, {
          "content-type": served.contentType,
          "content-length": served.bytes.byteLength,
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${served.etag}"`,
        });
        response.end(served.bytes);
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
      /**
       * TELAR'S OWN TECTONIC — the one distribution the engine can promise on a
       * machine it has never seen. GET is cheap enough to poll while an install
       * runs; POST starts one and is IDEMPOTENT, so a second press while the
       * first is still downloading joins it rather than starting a second.
       *
       * NOT A JOB. The other bootstraps shell out to curl and an installer
       * script, so they are steps a JobRunner can stream; this one is an
       * in-process fetch whose whole contract is "verify the digest before
       * anything is published". There is no subprocess to stream, and the state
       * a pane needs is the four fields GET already answers.
       */
      if (request.method === "GET" && url.pathname === "/v2/latex/managed") {
        writeJson(response, 200, { managed: store.managedTectonic() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/latex/managed") {
        writeJson(response, 202, { managed: await store.installManagedTectonic() });
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
          project: store.cloneProject({
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
      /**
       * THE RAIL'S ONE READ — and it answers ROWS, not whole sessions (#459).
       *
       * This is the most-served route on the engine: every cockpit polls it on a
       * timer, for every paired host, for as long as it is open. On the owner's
       * store it was 318 KB and 200 ms for 267 sessions, which is why the engine
       * sat at 70% CPU with two devices attached. `liveSessionRows` serializes
       * only what a row draws; `LiveSessionRow` argues it field by field.
       *
       * IT IS ALSO THE WHOLE OF WHAT A RAIL ASKS PER PASS. The sidebar used to
       * fan out three ways here — this list, `/v2/health` for the engine's id
       * and `/v2/inbox` for the settling window — three concurrent reads, per
       * paired host, per tick, of which two answered one field each and changed
       * only when somebody opened Settings. `daemonId` is stamped on here rather
       * than in the store because it belongs to the running daemon, not to the
       * documents: two reads that reached ONE engine (a Mac paired with itself,
       * or under two addresses) are folded on it.
       *
       * `?full=1` IS THE ONE-RELEASE ESCAPE HATCH, for a client built against
       * the old shape — a paired Mac on last week's nightly, a script. It is not
       * a mode anything of ours asks for, and it is meant to be deleted.
       *
       * AND THE DEFAULT IS NOW THE UNSETTLED ROWS ALONE (#457). Re-measured on
       * the owner's store after #459: 276 KB and 2.33 s per read, three seconds
       * apart, per connected cockpit — for 291 sessions of which SEVEN were not
       * settled. `?all=1` is the whole list and is what the cockpit's shelf
       * sends when a reader opens it; `settledCount` rides the default answer so
       * the shelf header that asks for them is drawn without them. The rule is
       * the clients' own (`isShelved`), so the engine cannot drop a row a rail
       * would have shown. `?full=1` is unfiltered, because its entire contract
       * is "the old answer, verbatim".
       */
      if (request.method === "GET" && url.pathname === "/v2/sessions/live") {
        if (url.searchParams.get("full") === "1") {
          writeJson(response, 200, store.liveSessions());
          return;
        }
        const all = url.searchParams.get("all") === "1";
        /**
         * `If-None-Match` — THE SAME CONDITIONAL READ, SPELLED IN HEADERS.
         *
         * `?since=` (#462) is this in the body, and it stays: two proxy hops sit
         * between this engine and a browser, and the cockpit's own route
         * RE-COMPOSES the answer rather than streaming it, so a cursor a route
         * handler can read is the thing that works everywhere. What the header
         * adds is three things the body cursor cannot:
         *
         *   - A 304 HAS NO BODY AT ALL, against the cursor's sixty-odd bytes.
         *   - THE WIDE READ CAN BE CONDITIONAL. The mode is inside the tag, so a
         *     tag earned against the unsettled list simply does not match an
         *     `?all=1` ask — where a `?since=` would have matched and answered
         *     the shelf with "unchanged". See `liveSessionsETag`.
         *   - IT IS THE STANDARD SPELLING, so a script, a cache or a client that
         *     has never heard of `?since=` gets the cheap tick for free.
         *
         * BEFORE THE CURSOR, because it is the cheaper of the two and because a
         * client sending both means both.
         */
        /**
         * THE CURSOR IS PER SHAPE OF ANSWER NOW (#493). A write to a session on
         * the shelf moves the wide answer and not the default one, so the two
         * ask for different numbers — see `sessionsRevision`. The tag already
         * carried the mode for the same reason; the number behind it now does
         * too, which is what stops a settled conversation's background task from
         * invalidating every rail on the machine.
         */
        const etag = liveSessionsETag(store.sessionsRevision({ all }), all);
        if (matchesETag(request.headers["if-none-match"], etag)) {
          response.writeHead(304, { etag, "cache-control": "no-store" });
          response.end();
          return;
        }
        /**
         * `?since=<revision>` — THE CONDITIONAL READ, and the reason this route
         * stopped being the engine's largest cost (#459).
         *
         * A rail cannot be pushed to: there is no global event feed here, and a
         * new long-lived connection is what #82 exists to avoid. So it still
         * asks on a timer, and this makes the ask nearly free — a cursor that
         * matches means nothing has been written since, and the answer is one
         * integer instead of a fold over every session's queue, requests and
         * tasks followed by 318 KB of rows.
         *
         * `daemonId` RIDES THE UNCHANGED ANSWER TOO. A rail that had not cached
         * it (a fresh tab whose first read happened to be conditional) would
         * otherwise have to go back to `/v2/health` for it — which is the
         * request this route just absorbed.
         *
         * An unparseable cursor is not an error: it is a client that has no
         * useful cursor, which is exactly the full answer's case.
         *
         * `?all=1` IS NEVER CONDITIONAL, and that is a correctness rule rather
         * than an oversight (#457). The revision counts WRITES, so it does not
         * move when a reader opens the Settled shelf — a cursor earned against
         * the default list, spent against `all=1`, would be answered "unchanged"
         * and the shelf would stay empty for as long as nothing else happened on
         * the machine. Making the wide ask always pay for itself is the version
         * of this that cannot be got wrong: the shelf is opened by hand and for
         * a moment, and the state this issue is about is the other one.
         */
        const since = Number(url.searchParams.get("since"));
        if (!all && Number.isSafeInteger(since) && since === store.sessionsRevision()) {
          // The default shape, which is the only one this cursor serves.
          writeJson(response, 200, { revision: since, unchanged: true, daemonId }, { etag });
          return;
        }
        writeJson(response, 200, { ...store.liveSessionRows({ all }), daemonId }, { etag });
        return;
      }
      /**
       * THE SESSIONS SOCKET'S CONNECT CARD — where it listens and its dedicated
       * secret. BEHIND THE NORMAL BEARER, exactly as the notebook's is: the card
       * mints and reveals the socket's credential, so only something already
       * holding engine access may read it.
       */
      /**
       * WHICH CONVERSATION WAS THIS — issue #516.
       *
       * A LITERAL PATH UNDER `/v2/sessions/`, so it lives up here with `/live`
       * and for the identical reason: `sessionPath` matches `find` as happily as
       * it matches a session id, and below the block this route would be "no
       * session by that id".
       *
       * READ-ONLY AND BOUNDED: ten rows by default, each one id, title, project,
       * activity, `updatedAt` and a quoted `why`. `index` says whether this
       * engine's sqlite answered from FTS5 or from the scan, because a caller
       * comparing two engines' results deserves to know which they got.
       */
      if (request.method === "GET" && url.pathname === "/v2/sessions/find") {
        const q = url.searchParams.get("q");
        if (!q || !q.trim()) throw new HttpError(400, "invalid_request", "q is required");
        const settled = url.searchParams.get("settled");
        writeJson(response, 200, store.findSessions({
          q,
          ...(url.searchParams.get("projectId") ? { projectId: url.searchParams.get("projectId")! } : {}),
          ...(settled === null ? {} : { settled: settled === "1" || settled === "true" }),
          ...(url.searchParams.get("since") ? { since: positiveParam(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER, "since") } : {}),
          limit: positiveParam(url.searchParams.get("limit"), FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX, "limit"),
        }));
        return;
      }
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
             * `create`: the capability is assembled out of client calls in one
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
        writeJson(response, 200, await execution.registerWorker(stringValue(input.workerId, "worker id")!));
        return;
      }
      const workerMatch = /^\/v2\/workers\/([A-Za-z0-9_-]+)\/(heartbeat|claim)$/.exec(url.pathname);
      if (workerMatch && request.method === "POST") {
        const workerId = decodeURIComponent(workerMatch[1]);
        if (workerMatch[2] === "heartbeat") {
          const input = await body(request);
          const ack = input.acknowledgedTaskStops;
          if (ack !== undefined && (!Array.isArray(ack) || ack.some((id) => typeof id !== "string")))
            throw new HttpError(400, "invalid_request", "task stop acknowledgments must be strings");
          writeJson(response, 200, await execution.workerHeartbeat(workerId, undefined, ack as string[] | undefined));
        } else {
          const input = await body(request);
          writeJson(response, 200, await execution.claimTurn(workerId, input.claimSeq as number));
        }
        return;
      }

      const turn = turnPath(url.pathname);
      if (turn && request.method === "POST") {
        if (turn.action === "release") {
          // A HUMAN gesture, like discard: no claim token, because the person
          // re-reading a held message is not a worker reporting on a run.
          writeJson(response, 200, { turn: store.releaseHeldTurn(turn.sessionId, turn.runId) });
          return;
        }
        if (turn.action === "resume") {
          // A HUMAN gesture like release: no claim token, and no clock check —
          // the person pressing this knows something the reset time does not.
          writeJson(response, 200, { turn: store.resumeRateLimitedTurn(turn.sessionId, turn.runId) });
          return;
        }
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
          writeJson(response, 200, await execution.markTurnRunning(turn.sessionId, turn.runId, claimToken));
        } else if (turn.action === "steer-ack") {
          // The runId in the path is the PROMOTED turn; the claim token proves
          // the worker holds the running turn it was steered into.
          writeJson(response, 200, await execution.ackSteer(turn.sessionId, turn.runId, claimToken));
        } else if (turn.action === "request") {
          const parsed = RequestOpenInput.safeParse(input);
          if (!parsed.success) throw new HttpError(400, "invalid_request", "request payload is invalid");
          writeJson(
            response,
            200,
            await execution.openRequest(turn.sessionId, turn.runId, parsed.data.claimToken, {
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
          writeJson(response, 200, await execution.reportObservations(turn.sessionId, turn.runId, claimToken, input.observations));
        } else if (turn.action === "complete") {
          writeJson(response, 200, await execution.completeTurn(turn.sessionId, turn.runId, claimToken, {
              text: stringValue(input.text, "text")!,
              providerSessionId: stringValue(input.providerSessionId, "provider session id", true),
              usage: input.usage as never,
            }));
        } else {
          // FROM THE CONTRACT'S LIST, not a hand-written copy of it. This was
          // one of three places spelling the same codes out, and adding
          // `interrupted` found them by watching two accept it while the third
          // still refused. `WorkerTurnFailureCode` is the single definition.
          const parsedCode = WorkerTurnFailureCode.safeParse(stringValue(input.code, "failure code"));
          if (!parsedCode.success) {
            throw new HttpError(400, "invalid_request", "failure code is invalid");
          }
          const code = parsedCode.data;
          // `rate_limited` carries the two facts the sweep schedules from. Read
          // through the contract's own schema rather than cast: `resumeAt`
          // arrives over HTTP as whatever the body held, and a NaN reaching the
          // store would be a turn that never resumes and never says why.
          const parsedFailure = WorkerTurnFailure.safeParse({
            code,
            message: stringValue(input.message, "failure message")!,
            ...(input.resumeAt === undefined ? {} : { resumeAt: input.resumeAt }),
            ...(input.limitType === undefined ? {} : { limitType: input.limitType }),
          });
          if (!parsedFailure.success) throw new HttpError(400, "invalid_request", "turn failure is invalid");
          writeJson(response, 200, await execution.failTurn(turn.sessionId, turn.runId, claimToken, parsedFailure.data));
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
          writeJson(response, 200, sessionSnapshot(store, session.sessionId, snapshotWindowParam(url)));
          return;
        }
        /**
         * ONE READ TO OPEN A CONVERSATION (#407) — the snapshot, the journal
         * from its cursor, and this session's subscriptions.
         *
         * The two reads it replaces were strictly SERIAL: the journal's `after`
         * is the snapshot's own cursor, so the second request could not be sent
         * until the first had come back, and a cockpit paid the full
         * browser → cockpit route → engine round trip twice before it could
         * paint a transcript. The engine holds both halves at one instant, so
         * it can answer both at once. The fold is `session-bootstrap.ts`;
         * `GET /v2/sessions/:id` above goes through the same one, so the two
         * cannot drift.
         */
        if (request.method === "GET" && session.tail === "/bootstrap") {
          writeJson(response, 200, sessionBootstrap(store, session.sessionId, snapshotWindowParam(url)));
          return;
        }
        /**
         * THE JOURNAL, A PAGE AT A TIME — issue #494.
         *
         * This route used to answer with the whole tail above `after`, which on
         * the biggest dogfood session was 36.5 MB serialised in 2.48 s — one
         * response the engine builds entirely in memory, the cockpit route
         * relays entirely in memory, and the client parses entirely in memory
         * before it can fold a single row. A 200-row page of the same journal
         * is 185 KB.
         *
         * KEYSET, NEVER OFFSET. `after` is an event id, so the window does not
         * shift under a journal that is being appended to while a client pages
         * it: `LIMIT ... OFFSET` would drop or repeat rows the moment a turn
         * streamed a delta mid-walk, which on a live session is always.
         *
         * `more` IS EXACT, not "the page came back full". One row beyond the
         * limit is read and dropped, so a client that pages until `more` is
         * false never pays a final round trip to be told there was nothing —
         * and `next` carries the `after` for the following page, present
         * exactly when `more` is true so the two cannot disagree.
         */
        if (request.method === "GET" && session.tail === "/events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          const limit = eventPageLimit(url.searchParams.get("limit"));
          // One over, to tell a full page from a full page with more behind it.
          const read = store.readEvents(session.sessionId, after, limit + 1);
          const events = read.length > limit ? read.slice(0, limit) : read;
          const cursor = events.at(-1)?.id ?? (Number.isSafeInteger(after) ? after : 0);
          writeJson(response, 200, {
            events,
            cursor,
            more: read.length > limit,
            ...(read.length > limit ? { next: cursor } : {}),
          });
          return;
        }
        /**
         * ══ SCROLLING A CONVERSATION RATHER THAN PAGING IT — issue #516 ══
         *
         * `/events` above is the journal: every row, in order, from a cursor. It
         * is the right read for a transcript and the wrong one for an agent,
         * which wants to ask a question — which turn, what did it conclude, what
         * did step twelve do — and gets there today only by paging 38 MB.
         *
         * The four routes below answer those questions from the `turn_summary`
         * projection and from indexed document spans. NONE OF THEM FOLDS EVENTS
         * (except `/grep`, which is a question about event text and says so),
         * and every one states `more` with the cursor for the next page, so a
         * caller never has to fetch everything to learn there was nothing.
         *
         * ONE TURN PER ROW, NEWEST FIRST. `before` is a sequence rather than an
         * offset, for the reason `/events` gives about `after`: a session being
         * appended to under a paging caller must not shift its window.
         */
        if (request.method === "GET" && session.tail === "/outline") {
          writeJson(response, 200, store.turnOutline(session.sessionId, {
            limit: positiveParam(url.searchParams.get("limit"), OUTLINE_PAGE_DEFAULT, OUTLINE_PAGE_MAX, "limit"),
            ...(url.searchParams.get("before") === null ? {} : { before: positiveParam(url.searchParams.get("before"), 0, Number.MAX_SAFE_INTEGER, "before") }),
          }));
          return;
        }
        /**
         * WHAT ONE RUN DID — the list, then one step of it.
         *
         * TWO ROUTES RATHER THAN ONE FAT ANSWER, because the list exists so a
         * caller can choose before it pays: `{index, id, title, status, bytes}`
         * is under a kilobyte for a long run, and `bytes` is what tells an agent
         * which step it can afford. The step itself is clamped to `maxChars`
         * with the marker that says how much was left behind.
         */
        const run = runItemsPath(session.tail);
        if (request.method === "GET" && run) {
          if (run.step === undefined) {
            writeJson(response, 200, { items: store.runItems(session.sessionId, run.runId) });
            return;
          }
          writeJson(response, 200, store.runItem(
            session.sessionId,
            run.runId,
            run.step,
            positiveParam(url.searchParams.get("maxChars"), ITEM_CHARS_DEFAULT, ITEM_CHARS_MAX, "maxChars"),
          ));
          return;
        }
        /**
         * THE ANSWER ALONE, SLICED — the most common orchestrator read, as its
         * own verb. `totalChars` rides every slice so a caller knows what it is
         * choosing not to read; the default run is the latest turn that actually
         * left text.
         */
        if (request.method === "GET" && session.tail === "/answer") {
          writeJson(response, 200, store.turnAnswer(session.sessionId, {
            ...(url.searchParams.get("runId") ? { runId: url.searchParams.get("runId")! } : {}),
            from: positiveParam(url.searchParams.get("from"), 0, Number.MAX_SAFE_INTEGER, "from"),
            limit: positiveParam(url.searchParams.get("limit"), ANSWER_SLICE_DEFAULT, ANSWER_SLICE_MAX, "limit"),
          }));
          return;
        }
        /**
         * WHERE A PHRASE APPEARS IN THIS JOURNAL — the one route here that does
         * read events, because no projection worth keeping could answer it. The
         * scan runs inside sqlite and only the matching page is materialised;
         * see `grepEvents`.
         */
        if (request.method === "GET" && session.tail === "/grep") {
          const pattern = url.searchParams.get("pattern");
          if (!pattern) throw new HttpError(400, "invalid_request", "pattern is required");
          writeJson(response, 200, store.grepSession(session.sessionId, pattern, {
            limit: positiveParam(url.searchParams.get("limit"), GREP_PAGE_DEFAULT, GREP_PAGE_MAX, "limit"),
            ...(url.searchParams.get("before") === null ? {} : { before: positiveParam(url.searchParams.get("before"), 0, Number.MAX_SAFE_INTEGER, "before") }),
          }));
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
              // A CLOSED SET, read off the body rather than trusted from it:
              // anything else is absent, which the store reads as the default.
              ...(input.completionWake === "always" || input.completionWake === "settled_only"
                ? { completionWake: input.completionWake }
                : {}),
            }),
          });
          return;
        }
        if (request.method === "GET" && session.tail === "/subscriptions") {
          writeJson(response, 200, { subscriptions: store.subscriptionsFor(session.sessionId) });
          return;
        }
        /**
         * A MESSAGE FROM AN AGENT — the worker's `sessions_send`. Separate
         * route rather than a body flag on `/turns`, because the difference is
         * WHO IS SPEAKING and that must not be a field a cockpit can set.
         * `proof` is the sending turn's own claim; the store checks it is live
         * and stamps the sender from it, so a model cannot name a session it is
         * not. Without proof the turn is still an agent's, unattributed.
         */
        if (request.method === "POST" && session.tail === "/turns/agent") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
          const parsed = AgentTurnInput.safeParse(await body(request));
          if (!parsed.success) throw new HttpError(400, "invalid_request", "agent turn payload is invalid");
          const { proof, ...message } = parsed.data;
          const result: TurnSubmissionResult = store.submitAgentTurn(session.sessionId, message, proof);
          writeJson(response, result.replayed ? 200 : 202, result);
          return;
        }
        if (request.method === "POST" && session.tail === "/turns") {
          pruneWorkers();
          if (workers.size === 0) throw new HttpError(503, "worker_unavailable", "no worker is registered");
          // `origin`, `wakeReason` and `sender` are DELIBERATELY NOT READ from
          // the body: a wake is the engine's own, queued by `fireSubscriptions`,
          // an agent's message has its own route above, and a cockpit body that
          // could forge either could impersonate a peer.
          const input = await body(request);
          const model = TurnModelSelection.safeParse(input.model);
          if (input.model !== undefined && !model.success) {
            throw new HttpError(400, "invalid_request", "turn model selection is invalid");
          }
          /**
           * THE CLAUDE DEFAULT, REFRESHED OFF THE CRITICAL PATH.
           *
           * Never awaited: reading a model list spawns the provider's CLI, and
           * neither this request nor the claim behind it may wait on that — the
           * claim runs against a worker lease and would lose the turn. The
           * remembered default (see `rememberedClaudeDefault`) is what the
           * synchronous claim reads; this only keeps it current, and only when a
           * turn would actually need it, so a Codex-only machine never probes a
           * Claude CLI it may not have installed.
           */
          if (store.claudeAdmissionNeedsCatalogue(session.sessionId, model.success ? model.data : undefined)) {
            void store.prepareClaudeCatalogue();
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
              ...(input.resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimit: input.resumeAfterRateLimit as boolean | null }),
            }),
          });
          return;
        }
        /**
         * A HUMAN SAW A RESULT. Its own verb rather than a PATCH field: the
         * receipt names the turn that was on screen and the store decides
         * whether that moves the mark, so there is nothing here for a client
         * to get wrong by sending a timestamp of its own. See
         * `EngineStore.markSessionRead`.
         */
        if (request.method === "POST" && session.tail === "/read") {
          const input = await body(request);
          writeJson(response, 200, { session: store.markSessionRead(session.sessionId, stringValue(input.runId, "run id")!) });
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
          /**
           * TWO VERBS, NAMED. `scope: "session"` is the Stop button — end what
           * is running and settle what was waiting; absent is the historical
           * one-turn stop. VALIDATED RATHER THAN DEFAULTED: an unrecognised
           * scope is refused, because the one thing worse than rejecting a
           * typo is silently stopping something other than what was asked for.
           */
          const scope = input.scope === undefined ? undefined : stringValue(input.scope, "scope");
          if (scope !== undefined && scope !== "session") throw new HttpError(400, "invalid_request", 'scope must be "session" when given');
          const runId = stringValue(input.runId, "run id", true);
          // Contradictory: one names a turn, the other says every turn.
          if (scope === "session" && runId) throw new HttpError(400, "invalid_request", 'a session-scope stop names no run id');
          // WHO PRESSED IT, validated like the scope. Only the record differs
          // — a person's stop and an agent's do the same thing.
          const by = input.by === undefined ? "user" : stringValue(input.by, "by");
          if (by !== "user" && by !== "agent") throw new HttpError(400, "invalid_request", 'by must be "user" or "agent" when given');
          const commandId = stringValue(input.commandId, "command id", true);
          writeJson(response, 200, scope === "session"
            ? store.executeCommand(JSON.stringify({ operation: "stopSession", sessionId: session.sessionId, by }), () => store.stopSession(session.sessionId, by), commandId)
            : store.stopTurn(session.sessionId, runId));
          return;
        }
        // A turn the PROVIDER started (a wake-up between turns). Worker-only,
        // like claim: the worker is the party holding the process that spoke.
        if (request.method === "POST" && session.tail === "/turns/provider") {
          const parsed = ProviderTurnOpenInput.safeParse(await body(request));
          if (!parsed.success) throw new HttpError(400, "invalid_request", "provider turn payload is invalid");
          activeWorker(parsed.data.workerId);
          writeJson(response, 200, await execution.openProviderTurn(session.sessionId, parsed.data));
          return;
        }
        // Task reports between turns — no claim, worker-authenticated.
        if (request.method === "POST" && session.tail === "/tasks") {
          const parsed = SessionTaskReport.safeParse(await body(request));
          if (!parsed.success) throw new HttpError(400, "invalid_request", "task report payload is invalid");
          activeWorker(parsed.data.workerId);
          writeJson(response, 200, await execution.reportSessionTasks(session.sessionId, parsed.data.workerId, parsed.data.observations));
          return;
        }
        // The "N tasks still working" chip's Stop. Names no turn — a background
        // task outlives its turn, so this is a different verb from /stop.
        if (request.method === "POST" && session.tail === "/stop-background") {
          writeJson(response, 200, { stopped: store.stopBackgroundTasks(session.sessionId) });
          return;
        }
        /**
         * PAUSE AND RESUME — the session-level stop. `/stop` ends one run and
         * the worker takes the next; `/pause` stops the run AND holds the
         * session until `/resume`. `by` is the only body field, and only
         * `"session"` is honoured (the worker's `sessions_stop`); anything
         * else is a human. Resume takes no body and has no agent caller.
         */
        if (request.method === "POST" && session.tail === "/pause") {
          const input = await body(request);
          writeJson(response, 200, store.pauseSession(session.sessionId, input.by === "session" ? "session" : "human"));
          return;
        }
        if (request.method === "POST" && session.tail === "/resume") {
          await body(request);
          writeJson(response, 200, store.resumeSession(session.sessionId));
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

    // Lifecycle operations use the same execution port as HTTP handlers,
    // directly in process. Tool capability calls retain the authenticated API.
    let embedded: { workerId: string; stop(): Promise<void> } | undefined;
    let browser: import("./browser").BrowserRuntime | undefined;
    let browserSocket: import("./browser/socket").BrowserToolSocket | undefined;
    let sessionsRunSocket: import("./sessions-tools/run-socket").SessionsToolSocket | undefined;
    let telarRunSocket: import("./telar-socket").TelarToolSocket | undefined;
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
              ...(input.title ? { title: input.title } : {}),
            }).id,
        },
      });
      store.attachKernels(kernels);
      kernelsRef.current = kernels;
      // The browser reaches sessions over the worker-hosted MCP socket, for
      // BOTH providers — see `./browser/socket.ts`. The daemon owns the socket
      // the way it owns the browser: it outlives any turn and is closed once.
      browserSocket = (await import("./drivers")).createBrowserToolSocket(routed);
      // The sessions wall for Codex turns — worker-hosted like the browser's,
      // per-session tokens, no persisted secret. Distinct from the daemon's
      // outward `/v2/sessions/mcp` door below, deliberately: two doors, two
      // credentials, and only this one carries a `self` to be woken in.
      sessionsRunSocket = new (await import("./sessions-tools/run-socket")).SessionsToolSocket();
      telarRunSocket = new (await import("./telar-socket")).TelarToolSocket();
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
      const sessionsSocket = sessionsRunSocket;
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
            ...(sessionsSocket ? { sessionsSocket } : {}),
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
        await telarRunSocket?.close();
        // Kernels beside the browser: both are processes a turn borrowed and
        // the daemon owns, and both leak past a daemon that does not stop them.
        // Kernels and compile jobs come back through their plugins' own
        // `onDispose`, bounded per cleanup, rather than a line per feature here.
        await pluginHost.disposeAll("shutdown");
        // Runs are the one subprocess nothing else reaps: a dev server is
        // deliberately not a child of any turn.
        await runMount.shutdown();
        // Compile and tlmgr jobs are subprocesses of the same kind.
        // After the worker, before the lock: a live Chromium holding a profile
        // lock outlives the process that spawned it otherwise.
        await browser?.close("engine shutting down");
        // THE AGENT'S STREAMS FIRST, and before the server: `server.close()`
        // waits for open connections, and an SSE stream never closes itself.
        for (const stream of [...openStreams]) (stream.end ?? stream)();
        openStreams.clear();
        await closeServer(server);
        // AFTER THE SERVER, so no stream route is still holding a watcher, and
        // before the execution store: the Agent's thread is a database handle
        // this process owns, and a daemon that left it open would leave the
        // next reset unable to move the file.
        store.setAgentWakeSink(undefined);
        // AWAITED, and that is the whole of #539's item 5 in one line: the
        // Agent's turn is a promise in THIS event loop, so stopping the engine
        // ends it — there is nothing to outlive the daemon. `shutdown` aborts
        // the live turn, waits for its `turn_done` to be written, and only then
        // closes the thread file.
        await agentRuntime.shutdown();
        clearInterval(workerPruner);
        clearInterval(delegationSweeper);
        removeOwnDiscovery(store, daemonId);
        store.closeExecutionStore();
        lock.release();
      },
    };
  } catch (error) {
    clearInterval(workerPruner);
    clearInterval(delegationSweeper);
    server.close();
    store.closeExecutionStore();
    lock.release();
    throw error;
  }
}
