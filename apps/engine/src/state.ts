// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
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
  defaultInstanceIdForDriver,
  isBackgroundWork,
  livenessOf,
  DEFAULT_INBOX_POLICY,
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_TEXT_GEN_POLICY,
  InboxPolicy as InboxPolicySchema,
  SessionDefaults as SessionDefaultsSchema,
  TextGenPolicy as TextGenPolicySchema,
  Item as ItemSchema,
  MAX_AUTO_SETTLE_HOURS,
  MIN_AUTO_SETTLE_HOURS,
  McpServer as McpServerSchema,
  McpServerSpec as McpServerSpecSchema,
  ModelSelection,
  ProviderInstance as ProviderInstanceSchema,
  ProviderInstanceEnvVar as ProviderInstanceEnvVarSchema,
  resolveMcpServers,
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
  type GitHubCheckLog,
  type GitHubFacets,
  type GitHubIssueFilter,
  type GitHubIssueRead,
  type GitHubMergeMethod,
  type GitHubMergeResult,
  type GitHubPullFilter,
  type GitHubPullRead,
  type GitHubSnapshot,
  type GitignoreResult,
  type InboxPolicy,
  type SessionDefaults,
  type TextGenPolicy,
  type ModelCatalogue,
  type ModelOverlay,
  CustomProviderModel,
  DEFAULT_MODEL_OVERLAY,
  ModelOverlay as ModelOverlaySchema,
  type SessionDiff,
  type EngineEvent,
  type Item,
  type McpServer,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
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
  type SessionOrigin,
  type Turn,
  type TurnFailureCode,
  type TurnObservation,
  type SpoolAperture,
  type SpoolArea,
  type SpoolBrief,
  type SpoolBriefing,
  type SpoolItem,
  type SpoolItemDetail,
  type SpoolLane,
  type SpoolLobby,
  type SpoolLook,
  type SpoolLookOutcome,
  type SpoolNote,
  type SpoolSearchHit,
  type SpoolTerrain,
  type SpoolNight,
  type SpoolMemoryFact,
  type SpoolSnapshot,
  type SpoolSubject,
  type SpoolSubjectColor,
  type SpoolSubjectPermits,
  type SpoolFocusDay,
  type SpoolFocusEnd,
  type SpoolFocusEntry,
  type SpoolCanvasState,
  type SpoolMap,
  type SpoolPickup,
  type SpoolSubjectThreads,
  type SpoolThread,
  type SpoolThreadWaiting,
  type SpoolWork,
  type UsageSnapshot,
  type EnvMode,
  type ModelSelection as ModelSelectionValue,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
} from "@telar/engine-client";
import { atomicWrite } from "./atomic";
import { withComputerUse, type ResolvedComputerUse } from "./computer-use";
import { findProjectIcon, type ProjectIcon } from "./project-icon";
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./files";
import {
  addSubtask as addSpoolSubtask,
  agentsAddedCount as spoolAgentsAdded,
  attachmentTally as spoolAttachmentTally,
  capturedLabel as spoolCapturedLabel,
  factsNeedingVerification,
  judgeFact,
  readExpertDigest,
  readSelfMemory,
  answerOpenQuestion as answerSpoolOpenQuestion,
  closeItem as closeSpoolItemInStore,
  createItem as createSpoolItem,
  ensureSpool as ensureSpoolStore,
  createLane as createSpoolLane,
  deskSlice as spoolDeskSlice,
  getSpoolItem,
  listItems as listSpoolItems,
  promoteSubtask as promoteSpoolSubtask,
  queueSlice as spoolQueueSlice,
  rankOf as spoolRankOf,
  readLanes as readSpoolLanes,
  readPacketAttachments as readSpoolAttachments,
  renameLane as renameSpoolLane,
  reopenItem as reopenSpoolItemInStore,
  reorderLane as reorderSpoolLane,
  retireLane as retireSpoolLane,
  setSubtaskDone as setSpoolSubtaskDone,
  spoolPaths,
  subjectSlice as spoolSubjectSlice,
  updateItem as updateSpoolItem,
  type NewSpoolItem,
  type SpoolItemPatch,
  type SpoolPaths,
} from "./spool/store";
import { floatingExpertRefusal, runExpertPass, type ExpertPassOutcome } from "./spool/expert";
import { nightDeps, readNight, runNight, type NightBudget } from "./spool/night";
import { classifySettle, createWorkRegistry } from "./spool/work";
import { SpoolCanvas, runCanvasTurn } from "./spool/canvas";
import { structuredAgent } from "./agent";
import {
  deriveSubjects,
  readSubjects,
  setSubjectIdentity,
  setSubjectPermits,
  setSubjectTerrain,
  sortSubjectsByRank,
  subjectPermits,
} from "./spool/subjects";
import { effectivePermits, readAreas, setAreaCeiling } from "./spool/areas";
import { readAperture, setAperture } from "./spool/aperture";
import { acknowledgeObservation, digestObservations, readLook, reconcileLook, storedLookOutcome } from "./spool/looks";
import { composeBriefing } from "./spool/briefing";
import { composeLobby } from "./spool/lobby";
import { composeBrief } from "./spool/brief";
import { amendFocus, closeFocus, focusDays, openFocus, pickupFrom, readFocus } from "./spool/focus";
import {
  openQuestionThread,
  readThreads,
  refileCapture,
  settleThreadsForClose,
  reviewThread,
  runThreadPass,
  setThreadWaiting,
  settleThread,
  settleThreadsMany,
  subjectThreads,
  type ThreadPassOutcome,
} from "./spool/threads";
import { createNote, listNotes, retireNote, updateNote, type NewSpoolNote, type SpoolNotePatch } from "./spool/shelf";
import { renameSpoolTag as renameSpoolTagInStore, spoolTags as spoolTagsList, type SpoolTagUsage } from "./spool/tags";
import { searchSpool } from "./spool/search";
import { needsRefresh, refreshAccessToken, type ConnectContext, type McpOAuthRecord, type OAuthClientStore } from "./mcp-oauth";
import { commitSessionWork, gitOverview, sessionDiff, sessionFilePatch, type GitOverview } from "./git";
import { ensureTelarGitignore } from "./gitignore";
import {
  DEFAULT_ISSUE_FILTER,
  DEFAULT_PULL_FILTER,
  defaultGhRunner,
  mergePull,
  readCheckLog,
  readForgeFacets,
  readGitHub,
  readIssue,
  readPull,
  type GhRunner,
} from "./github";
import { readModelCatalogue } from "./models";
import { applyModelManifest, BUNDLED_MANIFEST, type ModelManifest } from "./model-manifest";
import { applyModelOverlay } from "./model-overlay";
import { createSessionWorktree, defaultGitRunner, isGitWorkTree, removeSessionWorktree, type GitRunner } from "./worktree";

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
    case "secret_access":
      // Origin and nothing else: the notification body may land on a lock
      // screen, and even item TITLES are more than a passer-by should read.
      return `Fill login from 1Password — ${detail.secret.origin}`;
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
 * How deep a session's backlog may get.
 *
 * A RUNAWAY-CLIENT GUARD, NOT A PRODUCT LIMIT. A human queueing follow-ups will
 * never approach it; a retry loop with a fresh runId each time would otherwise
 * grow `queue.json` without bound, and the queue is rewritten whole on every
 * turn transition.
 */
const MAX_QUEUED_TURNS = 16;

/**
 * How many LIVE sessions may exist that an agent asked for.
 *
 * EIGHT, and the number is a judgement rather than a measurement: a worktree
 * session is a whole checkout, and eight of them is already more than a person
 * can read. It is deliberately generous enough that no honest use of the
 * `sessions` toolkit meets it and tight enough that a loop meets it in seconds.
 * Injectable through `EngineDaemonOptions.sessionsBudget` so a test can state
 * the ceiling it means instead of creating eight worktrees to reach one.
 */
const DEFAULT_SESSIONS_BUDGET = 8;

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
/**
 * A turn that is not yet history: waiting, running, or mid-promotion. The
 * snapshot window keeps every one of these on the first page whatever the
 * limit — the queue strip and the send path read turns, and an unsettled
 * turn hidden behind a page would be a message the composer did not know
 * it had. `steered` is terminal (its words live inside the run it joined).
 */
const ACTIVE_TURN_STATES = new Set<Turn["state"]>(["queued", "claimed", "running", "steering"]);

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

/**
 * What could not possibly be a model id.
 *
 * LOOSE ON PURPOSE. `gpt-5.6-sol`, `opus[1m]`, `claude-fable-5-1` and
 * `us.anthropic.claude-fable-5-1` are all real shapes and no provider ever
 * promised a grammar — a strict pattern here would be this module's own version
 * of the hand-written catalogue that shipped a model nobody had. What it refuses
 * is only what could not be an id at all: a blank, something longer than any
 * published id, and anything carrying whitespace, a quote or a control
 * character — the characters that turn a stored string into a second problem
 * when it reaches a CLI argument.
 */
const MODEL_ID = /^[^\s"'`\\\u0000-\u001f]{1,200}$/;

/** Enough for every model two providers have ever published at once, several
 *  times over. A bound at all, because this document is reachable over HTTP. */
const MAX_OVERLAY_IDS = 200;
const MAX_CUSTOM_MODELS = 64;

/** Milestones and labels change on the timescale of a sprint, not of a page view,
 *  so what there is to FILTER BY is held far longer than the rows themselves. */
const FACET_CACHE_MS = 5 * 60_000;

export type EngineStatePaths = {
  root: string;
  projects: string;
  sessions: string;
  /** User-configured MCP servers. ENVIRONMENT-SCOPED, beside projects.json
   *  rather than inside a session: a tool is configured once. */
  mcpServers: string;
  /** Configured provider instances — the account registry. */
  providerInstances: string;
  /**
   * Their sensitive environment values, in a file of their own at 0600.
   *
   * SPLIT SO THE REGISTRY CAN BE READ FREELY. `listProviderInstances` hands its
   * answer to a settings page over HTTP; if a secret lived on the record, every
   * open of that page would echo back every API key the user had ever typed.
   * Keeping them apart makes redaction the default rather than a step somebody
   * has to remember at each call site.
   */
  providerSecrets: string;
  /**
   * What each login's reader did to that provider's model list — starred,
   * hidden, ordered, plus the ids they typed because the installed CLI does not
   * publish them yet.
   *
   * ITS OWN FILE, NOT A FIELD ON THE INSTANCE, for a sharper version of the
   * reason the secrets are split out: `provider-instances.json` is read on every
   * session claim through `resolveProviderInstance`, and dragging a model up one
   * place in a menu must not rewrite the routing registry.
   */
  modelOverlays: string;
  /**
   * Completed MCP OAuth grants — access token, refresh token, the resolved
   * authorization server and the client they were minted for.
   *
   * ITS OWN FILE, AT 0600, FOR THE SAME REASON `providerSecrets` IS: the server
   * registry beside it is read by a settings page over HTTP, and a token stored
   * on the record would be echoed back to every browser that opened it. Here
   * only the claim reads this, and no route returns it.
   */
  mcpOAuth: string;
  /**
   * Sign-ins currently in flight, keyed by the OAuth `state`.
   *
   * ON DISK RATHER THAN IN MEMORY because a flow spans a browser round trip
   * through a third party, and an engine that restarted in that window would
   * otherwise strand it with an error the user cannot act on. Entries expire;
   * each holds a PKCE verifier, which is a secret for the length of one flow.
   */
  mcpOAuthPending: string;
  /**
   * How the reader wants their session list banded — see `InboxPolicy`.
   *
   * ENVIRONMENT-SCOPED, beside projects.json, for the same reason mcp-servers is:
   * it is configured once and read by every client. A per-browser copy would put
   * the same session in two different bands depending on which window you opened.
   */
  inbox: string;
  /** Who writes generated titles and branch names — see `TextGenPolicy`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  textGen: string;
  /** What a session is created with when nobody said — see `SessionDefaults`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  sessionDefaults: string;
  /**
   * The host cockpit's resolved look, republished for paired clients — see
   * `getAppearance`. Environment-scoped like `textGen`, but for the opposite
   * reason: appearance genuinely LIVES in one browser's localStorage, and this
   * file is the only place another device can read it from.
   */
  appearance: string;
  engine: string;
  lock: string;
};

export function engineRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim();
  if (!home) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be explicitly set for the engine");
  }
  if (!path.isAbsolute(home)) {
    throw new EngineStateError("invalid_request", "TELAR_HOME must be an absolute path for the engine");
  }
  const resolved = canonicalPath(home);
  for (const legacy of [".telar", ".telar-dev"]) {
    const legacyRoot = canonicalPath(path.join(os.homedir(), legacy));
    if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
      throw new EngineStateError("invalid_request", "TELAR_HOME must not point at legacy Telar state");
    }
  }
  return path.join(resolved, "engine");
}

/**
 * The name this subtree used to have.
 *
 * WHY THE ENGINE STILL HAS A SUBTREE AT ALL, rather than being TELAR_HOME
 * itself: the packaged shell points TELAR_HOME at Electron's own userData
 * directory, which already holds `Cache/`, `Local Storage/`, `update-prefs.json`
 * and `server-port.json`. Dropping `projects.json`, `sessions/` and `worktrees/`
 * in beside them would leave two owners of one directory, and no way to tell by
 * looking which files may be deleted.
 */
const LEGACY_ROOT_NAME = "vnext";

/**
 * Carry an existing store across the rename, once.
 *
 * A RENAME, NOT A COPY: it is atomic within a filesystem, so there is no window
 * where half the sessions exist under both names. It runs only when the new root
 * does not exist yet — a second engine, or a second launch, finds nothing to do
 * and says nothing.
 *
 * Returns whether it moved anything, so the caller can say so out loud. A silent
 * migration is indistinguishable from data loss to the person watching their
 * session list come back empty.
 */
export function migrateLegacyEngineRoot(engineRoot: string): boolean {
  const resolved = path.resolve(engineRoot);
  const legacy = path.join(path.dirname(resolved), LEGACY_ROOT_NAME);
  // A root that IS the legacy path (tests, and anyone who pinned it explicitly)
  // has nothing to migrate and must not be renamed onto itself.
  if (legacy === resolved) return false;
  if (fs.existsSync(resolved) || !fs.existsSync(legacy)) return false;
  fs.renameSync(legacy, resolved);
  return true;
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
    providerInstances: path.join(resolved, "provider-instances.json"),
    providerSecrets: path.join(resolved, "provider-secrets.json"),
    modelOverlays: path.join(resolved, "model-overlays.json"),
    mcpOAuth: path.join(resolved, "mcp-oauth.json"),
    mcpOAuthPending: path.join(resolved, "mcp-oauth-pending.json"),
    inbox: path.join(resolved, "inbox.json"),
    textGen: path.join(resolved, "text-generation.json"),
    sessionDefaults: path.join(resolved, "session-defaults.json"),
    appearance: path.join(resolved, "appearance.json"),
    engine: path.join(resolved, "engine.json"),
    lock: path.join(resolved, "engine.lock"),
  };
}

/**
 * The published appearance blob's only limit — see `setAppearance`.
 *
 * 8 MiB, AND THE WALLPAPER IS WHY. The first cut capped this at 64 KB
 * explicitly to forbid an inlined image, on the reasoning that two theme halves
 * and a handful of scalars fit in 4 KB. That reasoning was right about the
 * SIZE and wrong about the CONTENT: what the cockpit publishes now is a whole
 * `Look`, and a Look legitimately carries its backdrop's pixels — the picker
 * compresses to at most 3.5 MB, and a composed scene stacks up to six smaller
 * layers plus their un-faded originals. A cap that refused those would publish
 * a look with a hole in it, which is precisely the divergence the shared format
 * exists to end. 8 MiB is comfortably above what the cockpit's own compression
 * ladders can produce and still far below anything worth streaming.
 */
const MAX_APPEARANCE_BYTES = 8 * 1024 * 1024;

/** A JSON object and not an array — the shape a blob-shaped payload must have
 *  for additive readers to be able to key into it at all. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new EngineStateError("invalid_request", `${label} must contain only letters, numbers, underscores, or hyphens`);
  }
}

/**
 * Stricter than `assertId` by one character: an instance id must START with a
 * letter. It is a URL path segment, a settings anchor and — for the built-in
 * slots — the driver kind itself, and an id like `-force` is one careless
 * interpolation away from being read as a flag.
 */
function assertInstanceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new EngineStateError(
      "invalid_request",
      "provider instance id must start with a letter and contain only letters, numbers, underscores, or hyphens",
    );
  }
}

/**
 * A list of model ids off the wire, deduped, first occurrence winning.
 *
 * DEDUPED RATHER THAN REFUSED, because a repeated id in a favourites list is a
 * double-click, not a malformed request — and the order this preserves is the
 * one the reader can see.
 */
function readModelIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_OVERLAY_IDS) {
    throw new EngineStateError("invalid_request", `${field} must be an array of at most ${MAX_OVERLAY_IDS} model ids`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !MODEL_ID.test(entry)) {
      throw new EngineStateError("invalid_request", `${field} must contain only model ids`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * The hand-typed rows. A DUPLICATE ID IS REFUSED HERE rather than deduped: this
 * is the one list whose entries carry a label, so two entries for one id are two
 * different answers to "what should this be called" and the engine has no basis
 * for picking one.
 */
function readCustomModels(value: unknown): CustomProviderModel[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_MODELS) {
    throw new EngineStateError("invalid_request", `custom must be an array of at most ${MAX_CUSTOM_MODELS} models`);
  }
  const out: CustomProviderModel[] = [];
  for (const entry of value) {
    const parsed = CustomProviderModel.safeParse(entry);
    if (!parsed.success || !MODEL_ID.test(parsed.data.id)) {
      throw new EngineStateError("invalid_request", "each custom model needs a model id, and an optional label");
    }
    if (out.some((existing) => existing.id === parsed.data.id)) {
      throw new EngineStateError("invalid_request", `${parsed.data.id} is listed twice`);
    }
    out.push(parsed.data);
  }
  return out;
}

/**
 * The three-state patch, as one expression.
 *
 * `null` clears, `undefined` keeps, anything else is normalised and set. Written
 * once because doing it inline three times is where a form's "clear the accent
 * colour" quietly becomes "keep it".
 */
function optionalPatch<K extends string>(
  key: K,
  submitted: string | null | undefined,
  existing: string | undefined,
  normalise: (value: string) => string,
): Partial<Record<K, string>> {
  if (submitted === null) return {};
  const raw = submitted === undefined ? existing : submitted;
  if (raw === undefined || raw.trim() === "") return {};
  return { [key]: normalise(raw) } as Partial<Record<K, string>>;
}

/** A space separates the two halves because neither an instance id nor an
 *  environment variable name may contain one — so the key cannot be ambiguous. */
const SECRET_KEY_SEPARATOR = " ";

/**
 * How long a half-finished sign-in stays on disk.
 *
 * Long enough to read a consent screen and pick an account; short enough that a
 * PKCE verifier is not sitting in a file for an afternoon because somebody shut
 * the tab. The authorization code's own single-use rule is the real backstop —
 * this only bounds the window in which one could be used at all.
 */
const PENDING_MCP_OAUTH_TTL_MS = 10 * 60_000;

/** One sign-in mid-flight. `ctx` carries the state, the PKCE verifier, the
 *  resolved authorization server and the exact redirect URI it was started
 *  with — the callback needs all four and can be given none of them. */
export type PendingMcpOAuth = {
  serverId: string;
  projectId?: string;
  ctx: ConnectContext;
  createdAt: number;
};

function secretKey(instanceId: string, name: string): string {
  return instanceId + SECRET_KEY_SEPARATOR + name;
}

/**
 * The built-in slot for a driver.
 *
 * NO `configDir`, AND FOR CLAUDE THAT IS THE WHOLE POINT: setting
 * `CLAUDE_CONFIG_DIR` — even to `~/.claude` — hashes to a different, empty
 * Keychain entry and 401s. The base login is the one that must leave the
 * variable unset, which is also why this slot cannot be deleted.
 */
function seedProviderInstance(driver: ProviderDriverKind, at: number): ProviderInstance {
  return {
    id: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    env: [],
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The engine-cut branch a title implies: `telar/<title-slug>-<id6>`, or
 * undefined when the title yields no usable slug (worktree creation then falls
 * back to `telar/<sessionId>`). One function because TWO callers must agree on
 * it exactly: `createSession` names the branch from the seed title, and
 * `refreshWorktreeBranchFromTitle` may only rename a branch it can prove the
 * engine derived — which it proves by re-deriving.
 */
export function derivedBranchFor(title: string, sessionId: string): string | undefined {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `telar/${slug}-${sessionId.replace(/^session_/, "").slice(0, 6)}` : undefined;
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

// `atomicWrite` MOVED TO `./atomic` and is imported at the top of this file.
// It is unchanged; it left because `spool/store.ts` needs the same writer and
// this module imports the spool store, so a spool module reaching back here for
// it would be a cycle. See that file's header.

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
      `this ${document} was written by protocol v1, which this engine no longer reads. ` +
        `v2 is a deliberate hard break with no migration — clear the engine state root (TELAR_HOME/engine) and start fresh.`,
    );
  }
  throw new EngineStateError("invalid_request", `invalid ${document}`);
}

function latestProviderSessionId(queue: SessionQueue): string | undefined {
  // ANY state, not `completed` only: a `provider.session` observation writes
  // the id onto a RUNNING turn precisely so a stop cannot lose it, and this
  // recovery read must honour the same rule or a restart after a stopped
  // first turn would strand the session fresh again.
  return queue.turns
    .filter((turn) => typeof turn.providerSessionId === "string" && turn.providerSessionId.trim())
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
  if (!projects.success) throw new EngineStateError("invalid_request", "invalid project registry");
  for (const project of projects.data) assertAbsolutePath(project.root, "project root");
  return { version: STATE_VERSION, projects: projects.data };
}

function parseSession(value: unknown): Session {
  const session = SessionSchema.safeParse(value);
  if (!session.success) throw new EngineStateError("invalid_request", "invalid session metadata");
  assertId(session.data.id, "session id");
  /**
   * ONLY WHEN PRESENT. A project-less session — the Spool's master chat — has no
   * project id to validate, and asserting one unconditionally made it
   * unreadable the moment it was written: the mint succeeded and every
   * subsequent read of it 400'd. That is the failure mode `Session.projectId`'s
   * own comment warns about, "a reader that treats absence as an error turns the
   * front door into a bug report", reached here first because this is the first
   * reader every other one goes through.
   *
   * The check still binds when there IS an id, which is what it was for: a
   * hand-edited or corrupted metadata file must not smuggle a path fragment
   * through as a project.
   */
  if (session.data.projectId !== undefined) assertId(session.data.projectId, "project id");
  return session.data;
}

/**
 * The half of a session that BELONGS ON DISK.
 *
 * `activity` is derived from the queue and the open requests on every read, so
 * writing it would persist an answer that outlives the thing it describes: a
 * stored `working` survives the worker that was working, and the next process
 * to open the file would report a turn that nobody is running. Stripped at the
 * boundary rather than at each of the six call sites, so a seventh cannot
 * forget.
 */
function storedSession(
  session: Session,
): Omit<Session, "activity" | "activityAt" | "lastTurnEndedAt" | "lastTurnFailed"> {
  const {
    activity: _activity,
    activityAt: _activityAt,
    // Read off the queue on the same pass as `activity`, and stripped for the
    // same reason: the queue is where the answer lives, so a copy here could
    // only ever be a stale second one.
    lastTurnEndedAt: _lastTurnEndedAt,
    lastTurnFailed: _lastTurnFailed,
    ...stored
  } = session;
  return stored;
}

/**
 * The most recently FINISHED turn, whatever it finished as.
 *
 * `completedAt` is the test rather than a list of states, because the states
 * that set it are exactly the states that ended: completed, failed, stopped and
 * discarded all stamp it, and nothing else does. An enumeration here would be a
 * second copy of that fact, and the copy is the one that would fall behind.
 *
 * Chosen by MAXIMUM rather than by position. Turns run one at a time per
 * session so the array is very nearly in finish order, and "very nearly" is the
 * kind of thing that yields a wrong answer once a month.
 *
 * `>=`, NOT `>`, AND A TEST CAUGHT IT. Timestamps are milliseconds, two turns
 * can finish inside one, and with a strict comparison a tie kept the EARLIER
 * turn — so a session that failed and was then retried successfully in the same
 * millisecond would keep reporting the failure. Ties break toward queue order,
 * which is finish order.
 */
/**
 * The states `livenessOf` counts as alive, spelled once beside it.
 *
 * The contract decides WHETHER a session is live; this only has to date it, and
 * dating it off a different set of states than the one that classified it is
 * how `activityAt` ends up describing a task that already finished.
 */
function isLiveTask(task: Task): boolean {
  return task.state === "pending" || task.state === "running" || task.state === "waiting";
}

function lastEndedTurn(turns: readonly Turn[]): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of turns) {
    if (turn.completedAt === undefined) continue;
    if (latest?.completedAt === undefined || turn.completedAt >= latest.completedAt) latest = turn;
  }
  return latest;
}

function parseQueue(value: unknown, sessionId: string): SessionQueue {
  assertStateVersion(value, "session queue");
  const stored = value as { sessionId?: unknown; nextSequence?: unknown; turns?: unknown };
  if (stored.sessionId !== sessionId || !Number.isSafeInteger(stored.nextSequence)) {
    throw new EngineStateError("invalid_request", "invalid session queue");
  }
  const turns = TurnSchema.array().safeParse(stored.turns);
  if (!turns.success) throw new EngineStateError("invalid_request", "invalid session queue");
  const ids = new Set<string>();
  for (const turn of turns.data) {
    assertId(turn.runId, "run id");
    if (ids.has(turn.runId)) throw new EngineStateError("invalid_request", "duplicate Telar turn id");
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
      throw new Error("invalid event journal");
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
 * The last complete record's id without parsing the file. A 9 MB journal is
 * ordinary for a long session; reading it whole to learn one integer is the
 * cost this exists to avoid. Reads a window from the end, widening until a
 * complete line is inside it; an interrupted final record (no trailing
 * newline) is skipped, exactly as `readJournal` would repair it.
 */
function lastEventId(file: string): number {
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  try {
    const size = fs.fstatSync(handle).size;
    let window = 4096;
    while (true) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      // A trailing newline means the last element is "", and the record before
      // it is complete; otherwise the last element is an unterminated append.
      lines.pop();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!;
        if (!line) continue;
        // The first line of the window may be a partial record unless the
        // window reaches the start of the file.
        if (index === 0 && start > 0) break;
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (!Number.isSafeInteger(id) || (id as number) < 1) throw new Error("invalid event journal");
        return id as number;
      }
      if (start === 0) return 0;
      window *= 4;
    }
  } finally {
    fs.closeSync(handle);
  }
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
  /** See the constructor: daemon-injected, absent means no computer use. */
  private readonly computerUse?: (() => ResolvedComputerUse | undefined) | undefined;
  /** See the constructor: the real subprocess handshake unless a test says
   *  otherwise. */
  private readonly readModels: typeof readModelCatalogue;
  private readonly manifest: ModelManifest;
  private readonly git: GitRunner;
  private readonly gh: GhRunner;
  /**
   * HOW MANY LIVE SESSIONS AN AGENT MAY HAVE CREATED AT ONCE.
   *
   * The `sessions` toolkit has no depth rule and no parent/child link BY
   * DESIGN, so this plain count is the only thing between a session that
   * creates sessions and forty worktrees on somebody's disk. It counts LIVE
   * agent-made sessions (`origin: "session"`, `state: "active"`) across every
   * project — not a fan-out width, not a depth, and not a relationship to
   * whoever asked.
   */
  private readonly sessionsBudget: number;
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
  /** What there is to filter by, per project. In memory like every cache here: it
   *  describes somebody else's repository settings. */
  private readonly facetCache = new Map<string, GitHubFacets>();
  /** In memory, like the GitHub cache and for the same reason: it describes
   *  somebody else's installation, which changes without telling us. */
  private readonly modelCache = new Map<ProviderDriverKind, ModelCatalogue>();
  /**
   * Set by the daemon when it owns a browser. ATTACHED RATHER THAN CONSTRUCTED
   * so the store keeps no provider dependency — every test builds an
   * EngineStore directly and must not pull Chromium in to do it.
   */
  private browser?: AttachedBrowser;
  /** The last tab set journalled from a HAND-STARTED browser read, per session.
   *  In memory like the caches above: it only exists to stop repeated `start`
   *  reads writing identical `browser.state.changed` rows. */
  private readonly browserJournalSignature = new Map<string, string>();
  /** The last journalled controller per session — same dedupe job as the
   *  signature above, for `browser.control.changed`. In memory: a duplicate
   *  row after a restart is noise, not a lie. */
  private readonly browserControlLast = new Map<string, string>();

  attachBrowser(browser: AttachedBrowser): void {
    this.browser = browser;
  }

  /**
   * Record whose hands are on the session's shared browser (§6). Reported by
   * the DESKTOP SHELL — the only process that can see a human's click land in
   * the native view — over the engine's own HTTP API, and deduped here so a
   * shell that re-reports the standing state journals nothing new.
   */
  recordBrowserControl(sessionId: string, controller: "agent" | "human" | "idle"): void {
    this.getSession(sessionId);
    if (this.browserControlLast.get(sessionId) === controller) return;
    this.browserControlLast.set(sessionId, controller);
    this.appendEvent(sessionId, { type: "browser.control.changed", controller });
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
      return { scopeKey: sessionId, provider: "none", running: false, tabs: [], canStart: false };
    }
    const state = await this.browser.state(sessionId, {
      ...(options.screenshot === undefined ? {} : { screenshot: options.screenshot }),
      ...(options.start === undefined ? {} : { start: options.start }),
    });
    /**
     * A browser opened BY HAND has no worker to report it. The socket journals
     * `browser.state.changed` for agent-driven navigation; a human pressing
     * "open a browser" goes through this read with `start`, and without this
     * write the launched page would exist with no tab in the panel — the panel
     * folds the journal, not this snapshot. Deduped by signature so repeated
     * presses (or a poll that someone hands `start` to) journal nothing new.
     */
    if (options.start && !state.error && state.running) {
      const signature = `${state.provider}:${JSON.stringify(state.tabs)}`;
      if (this.browserJournalSignature.get(sessionId) !== signature) {
        this.browserJournalSignature.set(sessionId, signature);
        this.appendEvent(sessionId, { type: "browser.state.changed", provider: state.provider, tabs: state.tabs });
      }
    }
    return {
      scopeKey: sessionId,
      provider: state.provider,
      running: state.running,
      tabs: state.tabs,
      ...(state.screenshot ? { screenshot: state.screenshot } : {}),
      ...(state.error ? { error: state.error } : {}),
      canStart: true,
    };
  }

  /**
   * The user's own MCP servers.
   *
   * TWO SCOPES, IN ONE FILE, keyed by the PAIR `(projectId, id)`. A server with
   * no `projectId` is global; one with a `projectId` belongs to that repository
   * and shadows a global server of the same id when the two meet — see
   * `McpServer.projectId` in the contract for why that shadowing is a feature
   * rather than a collision.
   *
   * ONE FILE RATHER THAN ONE PER PROJECT because scope is a PROPERTY of a
   * server, not a location: the claim needs both halves on every turn, and a
   * per-project file would make the common read two reads and leave orphans
   * behind whenever a project was unregistered.
   *
   * `scope` FILTERS: absent returns everything, `null` returns only the global
   * ones, and a project id returns only that project's. The merge a session
   * actually runs with is `resolveMcpServers`, which is shared with the client
   * so the engine and the page explaining it cannot disagree.
   */
  listMcpServers(scope?: { projectId: string | null }): McpServer[] {
    const stored = readJson(this.paths.mcpServers) as { mcpServers?: unknown } | undefined;
    const parsed = McpServerSchema.array().safeParse(stored?.mcpServers ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid MCP server registry");
    const all = structuredClone(parsed.data);
    if (scope === undefined) return all;
    if (scope.projectId === null) return all.filter((server) => server.projectId === undefined);
    return all.filter((server) => server.projectId === scope.projectId);
  }

  /** Create or replace one server, in one scope. Keyed by `(projectId, id)`
   *  because the id IS the name the provider addresses its tools by —
   *  `mcp__<id>__<tool>` — and two scopes may legitimately spell it the same. */
  saveMcpServer(input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: unknown }): McpServer {
    assertId(input.id, "mcp server id");
    if (input.projectId !== undefined) this.getProject(input.projectId);
    const spec = McpServerSpecSchema.safeParse(input.spec);
    if (!spec.success) throw new EngineStateError("invalid_request", "MCP server configuration is invalid");
    const servers = this.listMcpServers();
    const at = this.now();
    const sameSlot = (server: McpServer) => server.id === input.id && server.projectId === input.projectId;
    const existing = servers.find(sameSlot);
    const server: McpServer = {
      id: input.id,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      label: (input.label ?? existing?.label ?? input.id).trim().slice(0, 120) || input.id,
      enabled: input.enabled ?? existing?.enabled ?? true,
      spec: spec.data,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const next = existing ? servers.map((entry) => (sameSlot(entry) ? server : entry)) : [...servers, server];
    atomicWrite(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
    return structuredClone(server);
  }

  removeMcpServer(id: string, projectId?: string): boolean {
    assertId(id, "mcp server id");
    const servers = this.listMcpServers();
    // Scoped, so removing a project's `linear` cannot take the global one with
    // it — which is exactly what an id-only match would have done.
    const next = servers.filter((server) => !(server.id === id && server.projectId === projectId));
    if (next.length === servers.length) return false;
    atomicWrite(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
    // A server that is gone has no grant to keep. Left behind, the record would
    // silently re-attach to whatever the next server of that id turned out to
    // be — a token minted for one audience, sent to another.
    this.deleteMcpOAuthRecord(id, projectId);
    return true;
  }

  /**
   * The inbox's standing rule, or the default when nothing has set one.
   *
   * NEVER THROWS ON A BAD DOCUMENT. Every other registry here refuses to parse
   * garbage, because a malformed MCP server is a server that must not run. A
   * malformed settling window is a preference, and the worst thing it can do is
   * band a list wrongly — so a file somebody hand-edited into nonsense costs the
   * preference, never the sidebar it configures.
   *
   * THE try/catch IS AROUND `readJson`, NOT JUST THE SCHEMA, and a test caught
   * that too: `readJson` swallows a missing file and rethrows a parse error, so
   * "the shape is wrong" was handled and "it is not JSON at all" was not.
   */
  getInboxPolicy(): InboxPolicy {
    try {
      const stored = readJson(this.paths.inbox);
      const parsed = InboxPolicySchema.safeParse(stored);
      if (parsed.success) return parsed.data;
      /**
       * THE DAYS-SHAPED DOCUMENT STILL MEANS WHAT IT SAID. The window moved
       * to hour granularity; a file written before that carries
       * `autoSettleAfterDays`, and dropping it to the default would silently
       * change which sessions somebody's sidebar shows. Converted on read,
       * rewritten in the new shape on the next save.
       */
      const days = (stored as { autoSettleAfterDays?: unknown } | undefined)?.autoSettleAfterDays;
      if (days === null) return { autoSettleAfterHours: null };
      if (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 90) {
        return { autoSettleAfterHours: days * 24 };
      }
      return { ...DEFAULT_INBOX_POLICY };
    } catch {
      return { ...DEFAULT_INBOX_POLICY };
    }
  }

  /**
   * `autoSettleAfterDays: null` is the clock OFF, and is a value rather than an
   * omission — so the patch is by presence, like every other one here.
   *
   * TAKES `unknown` AND VALIDATES HERE, as `saveMcpServer` does with its spec:
   * the bound belongs next to the schema that states it, not spelled a second
   * time in the route that happens to be the way in today.
   */
  setInboxPolicy(patch: { autoSettleAfterHours?: unknown }): InboxPolicy {
    const next: InboxPolicy = { ...this.getInboxPolicy() };
    if (patch.autoSettleAfterHours !== undefined) {
      if (patch.autoSettleAfterHours === null) {
        next.autoSettleAfterHours = null;
      } else {
        const parsed = InboxPolicySchema.shape.autoSettleAfterHours.safeParse(patch.autoSettleAfterHours);
        if (!parsed.success) {
          throw new EngineStateError(
            "invalid_request",
            `auto-settle window must be a whole number of hours between ${MIN_AUTO_SETTLE_HOURS} and ${MAX_AUTO_SETTLE_HOURS}, or null`,
          );
        }
        next.autoSettleAfterHours = parsed.data;
      }
    }
    atomicWrite(this.paths.inbox, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /**
   * What a new session is built with when the caller didn't say.
   *
   * Same never-throws rule as `getInboxPolicy`, and here it matters more than
   * anywhere: this document is read on the create path, so a file somebody
   * hand-edited into nonsense must cost the preference and not the session.
   */
  getSessionDefaults(): SessionDefaults {
    try {
      const parsed = SessionDefaultsSchema.safeParse(readJson(this.paths.sessionDefaults));
      return parsed.success ? parsed.data : { ...DEFAULT_SESSION_DEFAULTS };
    } catch {
      return { ...DEFAULT_SESSION_DEFAULTS };
    }
  }

  /** Takes `unknown` and validates here, like the two policies above: the set
   *  of legal modes belongs next to the schema, not spelled again in a route. */
  setSessionDefaults(patch: { envMode?: unknown }): SessionDefaults {
    const next: SessionDefaults = { ...this.getSessionDefaults() };
    if (patch.envMode !== undefined) {
      const parsed = SessionDefaultsSchema.shape.envMode.safeParse(patch.envMode);
      if (!parsed.success) {
        throw new EngineStateError("invalid_request", "default workspace must be local or worktree");
      }
      next.envMode = parsed.data;
    }
    atomicWrite(this.paths.sessionDefaults, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /** Same never-throws rule as `getInboxPolicy`, same reason: a malformed
   *  preference costs the preference, never the turn it decorates. */
  getTextGenPolicy(): TextGenPolicy {
    try {
      const parsed = TextGenPolicySchema.safeParse(readJson(this.paths.textGen));
      return parsed.success ? parsed.data : { ...DEFAULT_TEXT_GEN_POLICY };
    } catch {
      return { ...DEFAULT_TEXT_GEN_POLICY };
    }
  }

  setTextGenPolicy(patch: { titles?: unknown; renameBranches?: unknown; driver?: unknown; model?: unknown }): TextGenPolicy {
    const next: TextGenPolicy = { ...this.getTextGenPolicy() };
    if (patch.titles !== undefined) {
      if (typeof patch.titles !== "boolean") throw new EngineStateError("invalid_request", "titles must be a boolean");
      next.titles = patch.titles;
    }
    if (patch.renameBranches !== undefined) {
      if (typeof patch.renameBranches !== "boolean") throw new EngineStateError("invalid_request", "renameBranches must be a boolean");
      next.renameBranches = patch.renameBranches;
    }
    if (patch.driver !== undefined) {
      if (patch.driver !== "claude" && patch.driver !== "codex") {
        throw new EngineStateError("invalid_request", "text generation driver must be claude or codex");
      }
      /**
       * A DRIVER CHANGE DROPS THE MODEL rather than carrying it: model ids are
       * meaningless across harnesses, and `haiku` handed to Codex would fail
       * every generation until somebody worked out why. The new driver starts
       * on its own default; the settings page offers its catalogue from there.
       */
      if (patch.driver !== next.driver) delete next.model;
      next.driver = patch.driver;
    }
    if (patch.model !== undefined) {
      if (patch.model === null) {
        delete next.model;
      } else {
        const parsed = TextGenPolicySchema.shape.model.safeParse(patch.model);
        if (!parsed.success || parsed.data === undefined) {
          throw new EngineStateError("invalid_request", "text generation model must be a short model id, or null for the driver's default");
        }
        next.model = parsed.data;
      }
    }
    atomicWrite(this.paths.textGen, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  // ── Appearance ────────────────────────────────────────────────────────────
  //
  // AN OPAQUE BLOB, AND THE OPACITY IS THE DESIGN. The cockpit's look — accent,
  // typefaces, text size, translucency, backdrop, the two halves of the active
  // theme pair — lives in ONE browser's localStorage, because that is where a
  // person configures it. A paired client (the iOS app) has no way to read that
  // storage, so the browser republishes its RESOLVED look here and the engine
  // becomes the one place every device can ask "what does the host look like?".
  //
  // THE ENGINE DOES NOT UNDERSTAND IT and must not learn to. Every token the
  // cockpit adds — a new font slot, a new theme key — would otherwise need a
  // schema change here, an engine release, and a version handshake before it
  // could reach a phone. Storing it as JSON the engine never inspects makes the
  // whole vocabulary additive: new keys ride through untouched, and readers are
  // expected to ignore what they do not recognise (the repo's additive rule).
  // The only thing enforced is that it IS a JSON object and that it is small.

  /**
   * WHEN IT LANDED, STORED BESIDE IT — because a mailbox with no timestamp
   * cannot be cached. The blob is now megabytes rather than kilobytes (a Look
   * carries its wallpaper), and a phone that polls it on every foreground would
   * re-download the whole thing to discover nothing changed. `updatedAt` is
   * what the HTTP edge cuts an ETag from, so the second ask is a 304.
   *
   * THE ENGINE'S CLOCK, NOT THE PUBLISHER'S. The blob carries the publisher's
   * own `updatedAtHint`, and it is advisory: two browsers with disagreeing
   * clocks would make a hint-derived ETag go backwards. The stamp that matters
   * is when THIS engine accepted the write.
   */
  getAppearance(): { updatedAt: number; blob: Record<string, unknown> } | null {
    try {
      const stored = readJson(this.paths.appearance) as { appearance?: unknown; updatedAt?: unknown } | undefined;
      const blob = stored?.appearance;
      if (!isPlainJsonObject(blob)) return null;
      // A file written before the stamp existed reads as epoch 0 rather than
      // as absent: it is a real published look, and a stable ETag is better
      // than none. The next publish gives it a real time.
      return { updatedAt: typeof stored?.updatedAt === "number" && Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0, blob };
    } catch {
      return null;
    }
  }

  /**
   * Replaces the blob wholesale — this is a snapshot of a browser's resolved
   * state, not a patch, and merging two publishers' halves would produce a look
   * neither of them wears.
   *
   * THE CAP IS THE ONLY POLICY, and it is enforced HERE as well as at the
   * socket: an in-process caller must not be able to walk past a check that
   * only ever ran on an HTTP request.
   */
  setAppearance(blob: unknown): { updatedAt: number; blob: Record<string, unknown> } {
    if (!isPlainJsonObject(blob)) {
      throw new EngineStateError("invalid_request", "appearance must be a JSON object");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(blob);
    } catch {
      throw new EngineStateError("invalid_request", "appearance must be JSON-serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_APPEARANCE_BYTES) {
      throw new EngineStateError("invalid_request", `appearance must be under ${MAX_APPEARANCE_BYTES} bytes when serialized`);
    }
    const updatedAt = Date.now();
    atomicWrite(this.paths.appearance, { version: STATE_VERSION, updatedAt, appearance: blob });
    return { updatedAt, blob };
  }

  /**
   * Forget the published look. IDEMPOTENT — clearing an empty mailbox is not an
   * error, because "there is nothing published" is the state the caller asked
   * for and it is already true. Removing the FILE rather than writing an empty
   * blob keeps `getAppearance`'s null the one meaning of "nobody has published".
   */
  clearAppearance(): void {
    try {
      fs.rmSync(this.paths.appearance, { force: true });
    } catch {
      // A file we cannot delete is a look that stays published — worth no
      // failure on a route whose whole subject is decoration.
    }
  }

  // ── Spool ─────────────────────────────────────────────────────────────────
  //
  // THIN DELEGATION, AND DELIBERATELY SO. `spool/store.ts` owns the subtree and
  // every rule about it — the reconcile rule, the tolerant read, the version
  // ladder, what may and may not be patched. Nothing here re-decides any of
  // that; this block exists to do the two things a store module should not:
  // compose the projections a surface asks for in one call, and translate the
  // store's failure vocabulary into the engine's.
  //
  // THE TRANSLATION IS THE POINT. The store's contract is "a read is tolerant, a
  // write is loud": readers return `null` or `[]` for anything they cannot make
  // sense of, and writers THROW with a sentence a human can act on. The daemon
  // needs status codes. So `null` becomes a typed `not_found` and a thrown
  // sentence becomes `invalid_request` WITH ITS TEXT PRESERVED — the store's
  // messages name the file, the rule and the next step, and replacing them with
  // a generic "bad request" would throw away the only useful part.

  /** Resolved once from the state root; the store composes nothing itself. */
  get spool(): SpoolPaths {
    return spoolPaths(this.paths.root);
  }

  /**
   * Turn a store write's throw into a typed engine error, keeping its sentence.
   *
   * NOT A CATCH-ALL. Only the store's own `Error`s are translated; anything else
   * — an EACCES, a bug — rethrows untouched, because reporting a disk failure as
   * `invalid_request` would tell the user their input was wrong when it was not.
   */
  private spoolWrite<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof EngineStateError) throw error;
      if (error instanceof Error && !(error as NodeJS.ErrnoException).code) {
        throw new EngineStateError("invalid_request", error.message);
      }
      throw error;
    }
  }

  private spoolFound<T>(value: T | null, what: string): T {
    if (value === null) throw new EngineStateError("not_found", what);
    return value;
  }

  /** Everything the queue surface renders, in one read. */
  spoolSnapshot(): SpoolSnapshot {
    const lanes = readSpoolLanes(this.spool);
    const { items, unreadable } = listSpoolItems(this.spool);
    return {
      lanes,
      rows: spoolQueueSlice(lanes, items),
      // BOTH AXES OFF ONE READ of `lanes` and `items`. Two reads could catch a
      // write between them and ship a queue and a subject list that disagree
      // about what is in the store — and the surfaces would have no way to tell.
      subjects: spoolSubjectSlice(lanes, items),
      desk: spoolDeskSlice(items),
      unreadable,
      totalItems: items.length,
      agentsAdded: spoolAgentsAdded(items),
    };
  }

  spoolItem(id: string): SpoolItemDetail {
    const item = this.spoolFound(getSpoolItem(this.spool, id), "spool item not found");
    const lanes = readSpoolLanes(this.spool);
    // The AUTHORITATIVE lane — the stack that actually holds the id — with the
    // packet's own hint as the fallback the reconcile rule's orphan arm uses.
    const stacked = lanes.find((l) => l.items.includes(id));
    const rank = spoolRankOf(lanes, id);
    const lane = stacked?.key ?? (item.lane && lanes.some((l) => l.key === item.lane) ? item.lane : undefined);
    const attachments = readSpoolAttachments(this.spool, id);
    return {
      item,
      ...(lane ? { lane } : {}),
      ...(rank !== null ? { rank } : {}),
      attachments,
      tally: spoolAttachmentTally(attachments),
    };
  }

  createSpoolItem(input: NewSpoolItem): SpoolItem {
    if (typeof input?.title !== "string" || input.title.trim() === "") {
      throw new EngineStateError("invalid_request", "a spool item needs a title");
    }
    return this.spoolWrite(() => createSpoolItem(this.spool, input));
  }

  updateSpoolItem(id: string, patch: SpoolItemPatch): SpoolItem {
    return this.spoolFound(
      this.spoolWrite(() => updateSpoolItem(this.spool, id, patch)),
      "spool item not found",
    );
  }

  /**
   * THE CHECKBOX (docs/spool-loops.md §9) — HUMAN API ONLY. Called from the
   * daemon's dedicated route and from nowhere an agent can reach: no tool names
   * it, and the generic update path refuses `closed` by name. The composition
   * lives here because the cascade crosses two modules the store cannot join
   * without a cycle: the store stamps the field, and `settleThreadsForClose`
   * settles every open thread holding this capture with the human's own answer.
   *
   * A REFUSING THREAD IS REPORTED, NEVER FATAL — the close has landed by the
   * time the cascade runs, and it is not thrown away over one thread row.
   * Idempotent: closing a closed item changes nothing and says so.
   */
  closeSpoolItem(id: string): {
    item: SpoolItem;
    settledThreads: SpoolThread[];
    refused: Array<{ threadId: string; reason: string }>;
    note?: string;
  } {
    const at = new Date();
    const closed = this.spoolFound(
      this.spoolWrite(() => closeSpoolItemInStore(this.spool, id, at)),
      "spool item not found",
    );
    if (closed.alreadyClosed) {
      return {
        item: closed.item,
        settledThreads: [],
        refused: [],
        note: `Already closed ${closed.item.closed?.label ?? ""}`.trim() + " — nothing changed.",
      };
    }
    // No subject, no threads to cascade over — an ordinary state, not a fault.
    if (!closed.item.project) return { item: closed.item, settledThreads: [], refused: [] };
    const cascade = this.spoolWrite(() => settleThreadsForClose(this.spool, closed.item.project!, id, at));
    return { item: closed.item, settledThreads: cascade.settled, refused: cascade.refused };
  }

  /**
   * THE CHECKBOX UNTICKS — equally the hand's, equally unreachable from any
   * tool. Removes `closed` and nothing else; cascade-settled threads STAY
   * settled (a settled thread is never removed — the user opens a new question
   * if one is still open). Idempotent, with the honest note.
   */
  reopenSpoolItem(id: string): { item: SpoolItem; note?: string } {
    const reopened = this.spoolFound(
      this.spoolWrite(() => reopenSpoolItemInStore(this.spool, id)),
      "spool item not found",
    );
    return {
      item: reopened.item,
      ...(reopened.alreadyOpen ? { note: "Already open — nothing changed." } : {}),
    };
  }

  /**
   * MANY CHECKBOXES AT ONCE — the selection model's close, and STILL HUMAN API
   * ONLY: it is a loop over `closeSpoolItem`, so the cascade, the idempotence
   * and the moat are the single verb's, once per id. Reachable from the
   * daemon's dedicated route and from nowhere an agent can reach — not the
   * tool wall, not the socket.
   *
   * PARTIAL FAILURE IS PER ITEM, NEVER A THROW ACROSS THE BATCH: an id nothing
   * goes by comes back as `{id, error}` beside the closes that landed, because
   * un-doing nine of the user's own closes over a stale tenth id would punish
   * the hand for the surface's poll interval.
   */
  closeSpoolItems(ids: string[]): {
    results: Array<
      { id: string } & (
        | {
            item: SpoolItem;
            settledThreads: SpoolThread[];
            refused: Array<{ threadId: string; reason: string }>;
            note?: string;
          }
        | { error: string }
      )
    >;
  } {
    return {
      results: ids.map((id) => {
        try {
          return { id, ...this.closeSpoolItem(id) };
        } catch (error) {
          return { id, error: error instanceof EngineStateError ? error.message : error instanceof Error ? error.message : String(error) };
        }
      }),
    };
  }

  addSpoolSubtask(id: string, title: string): SpoolItem {
    if (typeof title !== "string" || title.trim() === "") {
      throw new EngineStateError("invalid_request", "a sub-task needs a title");
    }
    return this.spoolFound(
      this.spoolWrite(() => addSpoolSubtask(this.spool, id, title)),
      "spool item not found",
    );
  }

  setSpoolSubtaskDone(id: string, subtaskId: string, done: boolean): SpoolItem {
    return this.spoolFound(
      this.spoolWrite(() => setSpoolSubtaskDone(this.spool, id, subtaskId, done)),
      "spool item or sub-task not found",
    );
  }

  /** THE ONLY PROMOTION PATH, and it is reachable only from here — no tool
   *  surface names it. See the store's own note. */
  promoteSpoolSubtask(id: string, subtaskId: string): { parent: SpoolItem; promoted: SpoolItem } {
    return this.spoolFound(
      this.spoolWrite(() => promoteSpoolSubtask(this.spool, id, subtaskId)),
      "spool item or sub-task not found",
    );
  }

  /**
   * IS A PERSON USING THIS ACCOUNT RIGHT NOW?
   *
   * ANY turn queued, claimed or running, on ANY session — including the master
   * chat, because talking to the Spool is exactly the case where the night must
   * not be competing for the same provider.
   *
   * DELIBERATELY NOT "was there recent activity". A timestamp threshold would be
   * a clock deciding what the user gets, and it would be wrong in both
   * directions: it would stand the night down for someone who walked away
   * mid-sentence, and let it run against someone whose turn started a second
   * later. A live turn is a fact, not an inference.
   */
  humanActive(): boolean {
    for (const session of this.allSessions()) {
      const queue = this.readQueue(session.id);
      if (queue.turns.some((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running")) {
        return true;
      }
    }
    return false;
  }

  /**
   * EVERY SUBJECT, RECONCILED WITH WHAT IS ON DISK.
   *
   * DERIVES ON READ RATHER THAN MIGRATING AT BOOT, and the difference matters
   * three ways: it is idempotent, it self-heals when an item names a subject
   * nobody registered, and a store that has never been read is never left in a
   * half-migrated state by a startup path that threw. `deriveSubjects` touches
   * no packet — it reads the distinct `project` values already there.
   */
  spoolSubjects(): SpoolSubject[] {
    const projects = this.listProjects().map((p) => ({ id: p.id, name: p.name }));
    deriveSubjects(this.spool, projects);
    // RANKED-THEN-UNRANKED, WITHIN AN AREA ONLY — see `sortSubjectsByRank`.
    // Every other caller of this method (the lobby, the map, the front door)
    // reads through it, so the one sort here is the one every surface agrees
    // with, rather than each re-deriving it from the raw registry.
    return sortSubjectsByRank(readSubjects(this.spool));
  }

  /**
   * The one field a human sets on a subject: what may happen here unattended.
   *
   * THROWS `not_found` THROUGH `spoolFound` rather than returning null, which is
   * how every other missing-thing in this block reports. Hand-rolling a 404 in
   * the route instead cost the answer its CODE, and a coded error is the only
   * thing the client can classify — the web adapter turned "no subject goes by
   * that key" into "the engine adapter failed", which is a 503 for a request
   * that reached the engine and was answered.
   */
  setSpoolSubjectPermits(key: string, permits: SpoolSubjectPermits): SpoolSubject {
    this.spoolSubjects();
    return this.spoolFound(setSubjectPermits(this.spool, key, permits), `no subject goes by "${key}"`);
  }

  /**
   * The other fact a human states about a subject: where it lives. `null`
   * clears — a corrected statement, not a deletion; the subject's looks stay.
   * Validation (the repo-address guard) is the store's, through `spoolWrite`,
   * so a terrain the store must not hold refuses with its own sentence.
   */
  setSpoolSubjectTerrain(key: string, terrain: SpoolTerrain | null): SpoolSubject {
    this.spoolSubjects();
    return this.spoolFound(
      this.spoolWrite(() => setSubjectTerrain(this.spool, key, terrain)),
      `no subject goes by "${key}"`,
    );
  }

  /**
   * A subject's IDENTITY — its `area`, its `color`, and its `rank`, all the
   * user's to state and to withdraw. `null` clears a field; absent leaves it
   * untouched.
   * Validation (the closed color set, the area cap, the rank floor) is the
   * store's, through `spoolWrite`, so a value the store must not hold refuses
   * with its own sentence. Identity, never state: nothing downstream may read
   * any field here as urgency.
   */
  setSpoolSubjectIdentity(
    key: string,
    patch: { area?: string | null; color?: SpoolSubjectColor | null; rank?: number | null },
  ): SpoolSubject {
    this.spoolSubjects();
    return this.spoolFound(
      this.spoolWrite(() => setSubjectIdentity(this.spool, key, patch)),
      `no subject goes by "${key}"`,
    );
  }

  /**
   * THE AREA RECORDS — only the ones with something recorded on them.
   *
   * DELIBERATELY NOT PADDED with every area name subjects reference: the
   * subjects read already carries `area` on each subject, so the surface joins
   * this list by `name` against `SpoolSubject.area` (the join-by-key idiom
   * terrain and permits use) and an area with no record simply has no ceiling.
   * Minting a record per referenced name would stamp `created` labels for
   * statements nobody made.
   */
  spoolAreas(): SpoolArea[] {
    return readAreas(this.spool);
  }

  /**
   * State — or withdraw, with `null` — an area's permit ceiling. Validation
   * (the closed level set, the name cap) is the store's, through `spoolWrite`,
   * so a value the store must not hold refuses with its own sentence. The
   * record is created lazily here and NEVER given a ceiling anywhere else:
   * ceilings are stated, not assumed.
   */
  setSpoolAreaCeiling(name: string, ceiling: SpoolSubjectPermits | null): SpoolArea {
    return this.spoolWrite(() => setAreaCeiling(this.spool, name, ceiling));
  }

  /** The room's smart view. Never written is the ordinary wide room. */
  spoolAperture(): SpoolAperture {
    return readAperture(this.spool);
  }

  /** Point the room at a view. The closed-set guard is the store's — a view
   *  the room does not have refuses with its own sentence. */
  setSpoolAperture(view: unknown): SpoolAperture {
    return this.spoolWrite(() => setAperture(this.spool, view));
  }

  /**
   * RECONCILE-ON-LOOK — the one verb that reads the world, and it runs only
   * when called. No timer or watcher reaches this; the web calls it on arrival
   * and on focus, which is the pull-never-push law with a route on it.
   *
   * `gh` failure comes back INSIDE the outcome (`error` beside the stale look)
   * rather than as a throw — the room renders its staleness, it does not come
   * down. Only an unknown subject is an engine error.
   */
  async reconcileSpoolLook(subjectKey: string): Promise<SpoolLookOutcome> {
    const subject = this.spoolFound(
      this.spoolSubjects().find((s) => s.key === subjectKey) ?? null,
      `no subject goes by "${subjectKey}"`,
    );
    ensureSpoolStore(this.spool);
    return this.withLookDigest(
      await reconcileLook(this.spool, subject, {
        // The same injectable `gh` the GitHub panes run through, so a test
        // engine never shells out and a packaged one resolves the binary once.
        run: (args) => this.gh(this.spool.root, args),
        items: listSpoolItems(this.spool).items.filter((item) => item.project === subjectKey),
      }),
    );
  }

  /**
   * THE MOVEMENT DIGEST, attached to a look outcome at read time —
   * compress-never-multiply applied to observations. Derived from the same
   * lanes and items every other projection reads, never stored, and absent
   * when nothing is waiting; see `digestObservations` for the grouping rule.
   */
  private withLookDigest(outcome: SpoolLookOutcome): SpoolLookOutcome {
    if (!outcome.look) return outcome;
    const digest = digestObservations(
      outcome.look,
      readSpoolLanes(this.spool),
      listSpoolItems(this.spool).items.filter((item) => item.project === outcome.subject),
    );
    return digest.length > 0 ? { ...outcome, digest } : outcome;
  }

  /** Every subject's stored look, no `gh` run — the arrival read. */
  spoolLooks(): SpoolLookOutcome[] {
    return this.spoolSubjects().map((subject) => this.withLookDigest(storedLookOutcome(this.spool, subject)));
  }

  /** One subject's stored look, no `gh` run. */
  spoolLook(subjectKey: string): SpoolLookOutcome {
    const subject = this.spoolFound(
      this.spoolSubjects().find((s) => s.key === subjectKey) ?? null,
      `no subject goes by "${subjectKey}"`,
    );
    return this.withLookDigest(storedLookOutcome(this.spool, subject));
  }

  /** "Noted" — drains one observation. `not_found` when nothing goes by the
   *  id, so a stale surface learns it is stale rather than reporting success. */
  acknowledgeSpoolObservation(subjectKey: string, observationId: string): SpoolLook {
    return this.spoolFound(
      this.spoolWrite(() => acknowledgeObservation(this.spool, subjectKey, observationId)),
      `no observation goes by "${observationId}" on "${subjectKey}"`,
    );
  }

  /**
   * "NOTED", IN BULK — how a digest line's whole group drains in one gesture.
   * IDEMPOTENT PER ID: an id already acknowledged is the same state stated
   * twice, and an id nothing goes by is skipped rather than failing the rest —
   * the surface that sent it was drawn from a look that may be a poll old.
   * Only a subject with NO LOOK AT ALL is `not_found`.
   */
  acknowledgeSpoolObservations(subjectKey: string, observationIds: string[]): { look: SpoolLook; acknowledged: number } {
    let acknowledged = 0;
    for (const observationId of observationIds) {
      if (this.spoolWrite(() => acknowledgeObservation(this.spool, subjectKey, observationId))) acknowledged += 1;
    }
    const look = readLook(this.spool, subjectKey);
    if (!look) throw new EngineStateError("not_found", `"${subjectKey}" has no recorded look`);
    return { look, acknowledged };
  }

  /** The shelf, whole or one subject's slice — retired notes included, marked;
   *  a read that hid them would make retirement indistinguishable from
   *  deletion. */
  spoolNotes(subject?: string): SpoolNote[] {
    return listNotes(this.spool, subject);
  }

  spoolNote(id: string): SpoolNote {
    return this.spoolFound(listNotes(this.spool).find((note) => note.id === id) ?? null, "shelf note not found");
  }

  /** Write a note. Validation — title, body, tags, the addressable subject —
   *  is the shelf's, through `spoolWrite`, so a refusal keeps its sentence. */
  createSpoolNote(input: NewSpoolNote): SpoolNote {
    ensureSpoolStore(this.spool);
    return this.spoolWrite(() => createNote(this.spool, input));
  }

  /** Edit a note's title, body or tags. The author never changes — the shelf
   *  refuses a patch that names it, loudly. */
  updateSpoolNote(id: string, patch: SpoolNotePatch): SpoolNote {
    return this.spoolFound(this.spoolWrite(() => updateNote(this.spool, id, patch)), "shelf note not found");
  }

  /** Retire a note — drains with the reason, deletes nothing. */
  retireSpoolNote(id: string, reason: string): SpoolNote {
    return this.spoolFound(this.spoolWrite(() => retireNote(this.spool, id, reason)), "shelf note not found");
  }

  /** Every tag in use, across items and notes, with its two counts. A pure
   *  read — see `spoolTags` for why there is no tag record to keep. */
  spoolTags(): SpoolTagUsage[] {
    return spoolTagsList(this.spool);
  }

  /** Rename a tag everywhere it appears — items and notes both. A rename onto
   *  a name already in use merges the two. Validation (blank names, an
   *  identical from/to) is the store's, through `spoolWrite`, so a refusal
   *  keeps its sentence. */
  renameSpoolTag(from: string, to: string): { tag: string; items: number; notes: number } {
    return this.spoolWrite(() => renameSpoolTagInStore(this.spool, from, to));
  }

  /**
   * THE SEARCH — deterministic, lexical, model-free, over everything the
   * Spool holds. The corpus is read here in one pass and scanned by the pure
   * `searchSpool`; no index sits on disk to disagree with the store.
   */
  spoolSearch(query: string, options: { subject?: string; limit?: number } = {}): SpoolSearchHit[] {
    const subjects = this.spoolSubjects();
    return searchSpool(
      query,
      {
        items: listSpoolItems(this.spool).items,
        threads: subjects.flatMap((subject) => readThreads(this.spool, subject.key)),
        notes: listNotes(this.spool),
        observations: subjects.flatMap((subject) => {
          const look = readLook(this.spool, subject.key);
          return (look?.observations ?? []).map((observation) => ({ subject: subject.key, observation }));
        }),
      },
      options,
    );
  }

  /**
   * THE BRIEFING — loop 2's payload, composed here so the web renders it and
   * computes nothing. Deterministic: packet + threads + stored look, one read,
   * no model. `project` resolves through the subject's own link first and the
   * name match second (the same pairing `deriveSubjects` records), and its
   * ABSENCE is an ordinary answer — the honest "no registered project matches"
   * that the web already knows how to say.
   */
  spoolBriefing(itemId: string): SpoolBriefing {
    const item = this.spoolFound(getSpoolItem(this.spool, itemId), "spool item not found");
    const subject = item.project ? this.spoolSubjects().find((s) => s.key === item.project) : undefined;
    const projects = this.listProjects();
    const project = subject
      ? (subject.projectId ? projects.find((p) => p.id === subject.projectId) : undefined) ??
        projects.find((p) => p.name === subject.key)
      : undefined;
    const look = subject ? readLook(this.spool, subject.key) : null;
    return composeBriefing({
      item,
      ...(subject ? { subject, threads: readThreads(this.spool, subject.key) } : {}),
      ...(look ? { look } : {}),
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
    });
  }

  /**
   * THE SESSION-LIVENESS JOIN — one subject to "is a real Telar session
   * running for it right now". REUSES THE EXACT JOIN `spoolBriefing` ABOVE
   * ALREADY SHIPS: `subject.projectId` (a one-time link `deriveSubjects` sets
   * when a subject is first derived, never re-synced after) first, the
   * subject's key against a project's own name second — the same live
   * fallback that already resolves `spoolBriefing`'s `project` field in
   * production today.
   *
   * `null` MEANS "NO REGISTERED PROJECT TO ASK", NOT "NOT LIVE". A
   * terrain-less or checkout-less subject (school, a client engagement) has
   * no session to be live or idle — answering `false` there would assert a
   * fact this store cannot see. Only when a project DOES resolve does this
   * become a real boolean, read the same way `humanActive()` reads it: any
   * turn `queued`, `claimed` or `running` on any of that project's sessions.
   *
   * NOT `spool/work.ts`'s `WorkRegistry`. That module tracks in-flight SPOOL
   * AGENT passes (an expert pass, a thread pass) — a narrower, different
   * fact than "a human has a Telar session open on this subject's checkout".
   * The two must never be conflated: an idle session with a Spool pass
   * running is session-idle and pass-busy at once.
   */
  private sessionLiveBySubject(subjects: readonly SpoolSubject[]): Record<string, boolean | null> {
    const projects = this.listProjects();
    const result: Record<string, boolean | null> = {};
    for (const subject of subjects) {
      const project =
        (subject.projectId ? projects.find((p) => p.id === subject.projectId) : undefined) ??
        projects.find((p) => p.name === subject.key);
      result[subject.key] = project
        ? this.listSessions(project.id).some((session) =>
            this.turns(session.id).some(
              (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
            ),
          )
        : null;
    }
    return result;
  }

  /**
   * THE LOBBY — mission control, ranked. One read over subjects, areas, the
   * thread map, every subject's STORED look (no `gh` run — the arrival read,
   * same as `spoolLooks()`) and the items, plus the session-liveness join
   * above. Pure composition lives in `spool/lobby.ts`; this method only
   * gathers what it needs.
   *
   * `today` IS OPTIONAL AND NOTHING GUESSES WITHOUT IT. Per §3.2, "pinned to
   * today" and "the next pin" are both comparisons against the caller's OWN
   * stated day — omit it and those two facts simply do not appear, rather
   * than being computed against a clock this store never reads.
   */
  spoolLobby(today?: string): SpoolLobby {
    const subjects = this.spoolSubjects();
    return composeLobby({
      subjects,
      areas: this.spoolAreas(),
      map: this.spoolMap().subjects,
      looks: this.spoolLooks(),
      items: listSpoolItems(this.spool).items,
      sessionLive: this.sessionLiveBySubject(subjects),
      ...(today ? { today } : {}),
    });
  }

  /**
   * THE RE-ENTRY BRIEF — one subject's room, opened. `pickup` and `threads`
   * are the same reads `spoolPickup()`/`spoolThreads()` already serve;
   * `look` is the STORED outcome (no `gh` run); `rows` are this subject's
   * slice of `subjectSlice`'s own chain order, so "next" inherits an order
   * it did not invent. Pure composition lives in `spool/brief.ts`.
   */
  spoolSubjectBrief(key: string, today?: string): SpoolBrief {
    const subject = this.spoolFound(this.spoolSubjects().find((s) => s.key === key) ?? null, `no subject goes by "${key}"`);
    const lanes = readSpoolLanes(this.spool);
    const items = listSpoolItems(this.spool).items;
    const rows = spoolSubjectSlice(lanes, items).find((group) => group.project === subject.key)?.rows ?? [];
    return composeBrief({
      key: subject.key,
      pickup: this.spoolPickup(),
      threads: this.spoolThreads(subject.key),
      look: this.spoolLook(subject.key),
      rows,
      notes: this.spoolNotes(subject.key),
      ...(today ? { today } : {}),
    });
  }

  /**
   * EVERYTHING THE SPOOL REMEMBERS, in one read.
   *
   * ONE CALL RATHER THAN ONE PER SUBJECT, for the reason `spoolSnapshot` gives:
   * a surface that fetched these separately could show a subject's facts beside
   * a front-door memory read a tick apart, and neither the user nor a test could
   * tell a stale render from a real disagreement.
   *
   * RETIRED FACTS ARE INCLUDED. They are excluded from PROMPTS, not from the
   * human — "dismissing drains" means the record stays legible, and a surface
   * that hid them would make retirement indistinguishable from deletion.
   */
  spoolMemory(): { subjects: Array<{ key: string; facts: SpoolMemoryFact[] }>; self: SpoolMemoryFact[] } {
    return {
      subjects: this.spoolSubjects().map((subject) => ({
        key: subject.key,
        facts: readExpertDigest(this.spool, subject.key)?.facts ?? [],
      })),
      self: readSelfMemory(this.spool)?.facts ?? [],
    };
  }

  /**
   * A HUMAN'S VERDICT ON ONE FACT — retire it, or confirm it.
   *
   * THE OTHER DOOR. An agent proposes retirement through `foldFacts`, which
   * refuses to let it drain a `person` fact; this is the door a person walks
   * through, and it has no such rule because it IS the person.
   */
  judgeSpoolFact(input: {
    subject?: string;
    id: string;
    retire?: { why: string };
    reviewed?: boolean;
  }): SpoolMemoryFact {
    return this.spoolFound(
      judgeFact(this.spool, { ...input, at: spoolCapturedLabel(new Date()) }),
      `no remembered fact goes by "${input.id}"`,
    );
  }

  /**
   * ONE SUBJECT'S MAP — its open questions, their weave, and the captures no
   * thread claims yet.
   */
  spoolThreads(subject: string): SpoolSubjectThreads {
    // ASKED THROUGH `spoolSubjects` so an unregistered name self-heals the same
    // way every other read here does, rather than returning an empty map that
    // looks like "nothing to see" for a subject that simply was never derived.
    this.spoolSubjects();
    return subjectThreads(this.spool, subject);
  }

  /**
   * Every subject's map, in one read — what the front door draws.
   *
   * FLOATING CAPTURES RIDE BESIDE THE SUBJECTS. This mapped over the registry
   * alone, so a capture belonging to no subject was on no map at all — a hole in
   * a default surface. It is NOT given a subject called "floating":
   * `deriveSubjects` refuses to mint one and a test asserts it. See `SpoolMap`.
   */
  spoolMap(): SpoolMap {
    return {
      subjects: this.spoolSubjects().map((subject) => subjectThreads(this.spool, subject.key)),
      floating: listSpoolItems(this.spool)
        .items.filter((item) => !item.project)
        .map((item) => ({ id: item.id, title: item.title })),
    };
  }

  /**
   * WHERE TO PICK UP — what you are on, what moved on it, who is waiting, and a
   * proposal when you are on nothing.
   *
   * COMPOSED IN THE ENGINE, not the surface. Every string that leaves here is a
   * finished sentence in the user's own register, so the brief renders and
   * computes nothing — which is the only way it stays free of the counts and
   * jargon that made every previous surface read as a report.
   */
  spoolPickup(): SpoolPickup {
    return pickupFrom(readFocus(this.spool), this.spoolMap().subjects);
  }

  /** The Saturday / Sunday / Monday reading, already grouped and labelled. */
  spoolFocusDays(): SpoolFocusDay[] {
    return focusDays(readFocus(this.spool));
  }

  /** Start being on something. YOU set this — the system may propose, never
   *  decide, or it becomes the agenda §5 refuses. */
  openSpoolFocus(input: { subject: string; threadId?: string; note?: string }): SpoolFocusEntry {
    return openFocus(this.spool, input);
  }

  /** Stop, and say where you left it — the note is what "pick back up" means. */
  closeSpoolFocus(id: string, input: { reason: SpoolFocusEnd; note?: string }): SpoolFocusEntry {
    return this.spoolFound(closeFocus(this.spool, id, input), `no open focus goes by "${id}"`);
  }

  /** Correct it, keeping what it said before — see `amendFocus`. */
  amendSpoolFocus(
    id: string,
    patch: { subject?: string; threadId?: string | null; note?: string },
    why?: string,
  ): SpoolFocusEntry {
    return this.spoolFound(amendFocus(this.spool, id, patch, why), `no focus goes by "${id}"`);
  }

  /**
   * WRITE DOWN WHAT WAS FOUND OUT. The store's first exit that is not a
   * deletion — see `settleThread`, which refuses an empty answer rather than
   * letting this become a status flip.
   */
  settleSpoolThread(subject: string, threadId: string, answer: string): SpoolThread {
    return this.spoolFound(
      settleThread(this.spool, subject, threadId, answer),
      `no thread goes by "${threadId}" on "${subject}"`,
    );
  }

  /**
   * SETTLE MANY, each with its own required answer — per-thread failures come
   * back in `refused` with their sentences, never as a thrown batch. The
   * rules live in `settleThreadsMany`, which composes `settleThread` row by
   * row exactly as the close cascade does.
   */
  settleSpoolThreadsMany(
    subject: string,
    settles: Array<{ threadId: string; answer: string }>,
  ): { settled: SpoolThread[]; refused: Array<{ threadId: string; reason: string }> } {
    return this.spoolWrite(() => settleThreadsMany(this.spool, subject, settles));
  }

  /**
   * OPEN ONE QUESTION on a subject's map, from conversation. All of
   * `foldThreads`' laws apply — no capture no thread, dedupe, `proposed` — see
   * `openQuestionThread`, which is where they are enforced.
   */
  openSpoolThread(
    subject: string,
    input: { question: string; handle?: string; items: string[]; waiting?: SpoolThreadWaiting },
  ): SpoolThread {
    return this.spoolWrite(() => openQuestionThread(this.spool, subject, input));
  }

  /** Who a thread is stuck on, set directly — normalised and refused on a
   *  settled thread by the store, where the rule lives. */
  setSpoolThreadWaiting(subject: string, threadId: string, waiting: SpoolThreadWaiting): SpoolThread {
    return this.spoolFound(
      this.spoolWrite(() => setThreadWaiting(this.spool, subject, threadId, waiting)),
      `no thread goes by "${threadId}" on "${subject}"`,
    );
  }

  /** Record the answer to one of an item's open questions — the reduction
   *  verb. The store refuses an empty answer and an unmatched question. */
  answerSpoolQuestion(id: string, question: string, answer: string): SpoolItem {
    return this.spoolFound(
      this.spoolWrite(() => answerSpoolOpenQuestion(this.spool, id, question, answer)),
      "spool item not found",
    );
  }

  /** A human looked at an agent's grouping — the provenance law's other half. */
  reviewSpoolThread(subject: string, threadId: string): SpoolThread {
    return this.spoolFound(
      reviewThread(this.spool, subject, threadId),
      `no thread goes by "${threadId}" on "${subject}"`,
    );
  }

  /** Move a capture to another thread, or off the map with `to: null`. */
  refileSpoolCapture(subject: string, itemId: string, to: string | null): SpoolSubjectThreads {
    refileCapture(this.spool, subject, itemId, to);
    return this.spoolThreads(subject);
  }

  /**
   * MAP A SUBJECT, DETACHED — the same shape `startSpoolExpert` settled on, and
   * for the same measured reason: this awaits a model over every capture in a
   * subject, and an HTTP client gives up long before the daemon does.
   *
   * IT DEDUPES ON THE SUBJECT, not on an item. That is what `SpoolWork.subject`
   * and the registry's `addressOf` exist for: two clicks on "map this" are one
   * pass, from anywhere, including two windows.
   */
  startSpoolThreadPass(subject: string): { work: SpoolWork | null; refused?: string; alreadyRunning?: boolean } {
    const running = this.work.runningForSubject(subject);
    if (running) return { work: running, alreadyRunning: true };

    const known = this.spoolSubjects().find((s) => s.key === subject);
    if (!known) {
      return { work: null, refused: `No subject goes by "${subject}", so there is nothing to map.` };
    }

    // THE CHECKOUT IS OPTIONAL, exactly as it is for an expert pass: CAP-9's
    // claim is that the digest is enough, and a subject with no repo — school, a
    // client — is the ordinary case rather than a degraded one.
    const registered = known.projectId
      ? this.listProjects().find((p) => p.id === known.projectId)
      : undefined;

    const abort = new AbortController();
    const { handle } = this.work.begin({
      kind: "threads",
      subject,
      itemTitle: known.name,
      project: subject,
      origin: "you",
      started: spoolCapturedLabel(new Date()),
      abort,
    });

    const done = runThreadPass(this.spool, {
      subject,
      ...(registered ? { cwd: registered.root } : {}),
      abort,
      onStep: handle.step,
    }).then((outcome: ThreadPassOutcome) => {
      handle.settle(
        outcome.ok
          ? {
              state: "done",
              // NAMED, NOT SCORED. What it did to the map, in the map's own
              // words — a count of threads is a description of this pass, not a
              // number held up at the user about work elsewhere.
              note:
                outcome.created === 0 && outcome.attached === 0
                  ? `Nothing changed on ${subject}'s map — ${outcome.note}`
                  : `${outcome.note}`,
              ...(outcome.usage ? { usage: outcome.usage as never } : {}),
            }
          : { state: classifySettle(outcome.reason), note: outcome.reason },
      );
      return outcome;
    });

    // Swallowed rather than left to float: an unhandled rejection on a detached
    // promise takes the daemon down in Bun.
    void done.catch(() => undefined);
    return { work: this.work.find(handle.id) as SpoolWork, alreadyRunning: false };
  }

  /**
   * THE COMMIT A SUBJECT'S CHECKOUT IS ON, or undefined when it has none.
   *
   * `""` COLLAPSES TO UNDEFINED. A `git rev-parse` that failed returns an empty
   * string, and stamping facts as "checked at nothing" would mark them verified
   * against a commit that does not exist — which suppresses the next real check.
   * Absent is the honest answer, and it plans no verify job.
   */
  private subjectHead(key: string): string | undefined {
    const subject = this.spoolSubjects().find((s) => s.key === key);
    const root = subject?.projectId ? this.listProjects().find((p) => p.id === subject.projectId)?.root : undefined;
    if (!root) return undefined;
    const result = this.git(root, ["rev-parse", "HEAD"]);
    const head = result.status === 0 ? result.stdout.trim() : "";
    return head || undefined;
  }

  /**
   * SUBJECTS HOLDING FACTS NOT YET CHECKED AGAINST THEIR CURRENT COMMIT.
   *
   * The `verify` job's selection, resolved here because it needs a digest AND a
   * HEAD and `planNight` is pure over items. Cheap: one `rev-parse` per subject
   * with a checkout, and none for the ones without.
   */
  private verifiableSubjects(): string[] {
    return this.spoolSubjects()
      .filter((subject) => {
        const head = this.subjectHead(subject.key);
        return !!head && factsNeedingVerification(readExpertDigest(this.spool, subject.key), head).length > 0;
      })
      .map((subject) => subject.key);
  }

  /**
   * §7.6 RESOLVED FOR THE NIGHT — read once per plan rather than per item, so a
   * night over forty items is one registry read and not forty.
   *
   * THROUGH `effectivePermits`, so an area's ceiling clamps the night's plan
   * exactly as it clamps every other reading of a subject's level — "Personal
   * never gets worked without asking" gates tonight, not just the display.
   */
  private subjectGate(): (subject: string | undefined, level: "read" | "draft") => boolean {
    const subjects = this.spoolSubjects();
    const areas = readAreas(this.spool);
    return (key, level) =>
      subjectPermits(
        effectivePermits(
          subjects.find((s) => s.key === key),
          areas,
        ),
        level,
      );
  }

  /** What the night did, or null when it has never run. */
  spoolNight(): SpoolNight | null {
    return readNight(this.spool);
  }

  /**
   * Start tonight's queue, or continue the one that stopped, and RETURN
   * IMMEDIATELY.
   *
   * FIRE-AND-FORGET, AND THE LIVE RUN IS WHY. This was synchronous, on the
   * reasoning that whoever triggers a night is watching it. They cannot: the
   * first real night took over five minutes, and the caller's own HTTP client
   * gave up at three hundred seconds and reported the engine unreachable — while
   * the daemon carried on and finished every job. The work was never at risk,
   * because the record is written after each one; the RESPONSE was, which made
   * the route look broken while it was working.
   *
   * So the trigger returns the plan and the progress is read from
   * `spoolNight()`. That is also the shape the eventual scheduled trigger needs,
   * where there is no caller to answer at all.
   *
   * ONE NIGHT AT A TIME. A second trigger while one is in flight returns the
   * running record rather than starting a rival: two runners over one queue
   * would each claim the same pending jobs and pay for both.
   *
   * THE PROJECT ROOT IS RESOLVED HERE, from the registry, so a job reads the
   * checkout the item's subject actually names — and an unregistered subject
   * reasons from its digest with no tree, exactly as a hand-triggered
   * consultation does.
   */
  private nightInFlight: Promise<SpoolNight> | undefined;

  /** Live agent work, in memory. See `spool/work.ts` for why it is not a file. */
  private readonly work = createWorkRegistry();

  /** The screen the assistant is composing. In memory for the same reason: a
   *  canvas is an answer to a question, and the question does not outlive the
   *  process either. See `spool/canvas.ts`. */
  private readonly canvas = new SpoolCanvas();
  private canvasInFlight: AbortController | undefined;

  /**
   * BACKGROUND TASKS THE USER STOPPED, awaiting the actual process kill —
   * keyed by session, holding provider task ids. In memory for the same
   * reason the canvas is: the target is a live provider process, and a
   * process does not outlive this engine (an engine restart disposes every
   * runtime, so a pending kill would target something already gone). The
   * heartbeat drains this to whichever worker holds the runtime; the
   * projection is already `stopped`, so this is best-effort enforcement, not
   * the source of truth. See `stopBackgroundTasks` / `drainStopTasks`.
   */
  private readonly pendingStopTasks = new Map<string, Set<string>>();

  spoolCanvas(): SpoolCanvasState {
    return this.canvas.read();
  }

  /**
   * ASK FOR A SCREEN.
   *
   * DETACHED, like every other pass here — this awaits a model for tens of
   * seconds and an HTTP client gives up long before the daemon does. The reply
   * is immediate and the answer arrives on the canvas, which is exactly the
   * shape being tested: the surface is built while you watch rather than
   * returned when it is finished.
   *
   * ONE AT A TIME, AND A NEW ASK CANCELS THE OLD. Two composers drawing into one
   * canvas would interleave their blocks into a screen neither of them meant. A
   * person who asks a second question has withdrawn the first.
   */
  askSpoolCanvas(asked: string): { asked: string } {
    this.canvasInFlight?.abort();
    const abort = new AbortController();
    this.canvasInFlight = abort;
    void runCanvasTurn(this.canvas, { asked, state: this.spoolCanvasState(), abort }, structuredAgent).finally(() => {
      if (this.canvasInFlight === abort) this.canvasInFlight = undefined;
    });
    return { asked };
  }

  /**
   * THE WHOLE SPOOL, AS THE COMPOSER'S BRIEFING.
   *
   * PROSE AND NOT JSON. The model reads this once and then draws for the rest of
   * the pass, so it is written to be understood rather than parsed — and the ids
   * it must quote back to make a block clickable are the only machine-shaped
   * strings in it. Handing over the raw `SpoolMap` would spend most of the
   * budget on schema keys the composer has no use for.
   */
  private spoolCanvasState(): string {
    const map = this.spoolMap();
    const pickup = this.spoolPickup();
    const days = this.spoolFocusDays();
    const out: string[] = [];

    out.push(
      pickup.current.length === 0
        ? "ON RIGHT NOW: nothing."
        : `ON RIGHT NOW: ${pickup.current
            .map((e) => `${e.subject}${e.threadId ? ` (narrowed to thread ${e.threadId})` : ""}${e.note ? ` — they said: "${e.note}"` : ""}`)
            .join("; ")}`,
    );
    if (pickup.moved.length > 0) {
      out.push(`MOVED SINCE THEY LAST LOOKED: ${pickup.moved.map((m) => `${m.subject}: ${m.text}`).join(" | ")}`);
    }
    if (days.length > 0) {
      out.push(
        `RECENT DAYS: ${days
          .slice(-5)
          .map((d) => `${d.day}: ${[...new Set(d.entries.map((e) => e.subject))].join(", ")}`)
          .join(" | ")}`,
      );
    }

    for (const subject of map.subjects) {
      const lines = [`SUBJECT ${subject.subject} (permits: ${subject.permits})`];
      const busy = this.work.runningForSubject(subject.subject);
      if (busy) lines.push(`  a pass is running on it right now: ${busy.step?.label ?? "working out the questions"}`);
      if (subject.threads.length === 0) lines.push("  no questions worked out yet");
      for (const view of subject.threads) {
        const w = view.thread.waiting;
        lines.push(
          `  THREAD ${view.thread.id} · ${view.thread.handle?.trim() || view.thread.question}` +
            ` · ${view.ply.verified + view.ply.unchecked} known, ${view.ply.open} unanswered` +
            (view.thread.settled ? " · SETTLED" : "") +
            // THE COMPOSER IS TOLD ONLY ABOUT THIRD PARTIES, because that is all
            // it is allowed to draw — `waiting` on the user was on every row of
            // a real render and read as noise.
            (w?.kind === "person" && w.who ? ` · waiting on ${w.who}` : ""),
        );
        for (const item of view.items.slice(0, 4)) {
          if (item.said) lines.push(`    they wrote (item ${item.id}): "${item.said}"`);
        }
      }
      for (const loose of subject.loose.slice(0, 6)) {
        lines.push(`  UNSORTED capture ${loose.id}: "${loose.said ?? loose.title}"`);
      }
      out.push(lines.join("\n"));
    }

    if (map.floating.length > 0) {
      out.push(
        `FILED TO NO SUBJECT: ${map.floating.map((item) => `${item.id}: "${item.said ?? item.title}"`).join(" | ")}`,
      );
    }
    if (pickup.waiting.length > 0) {
      out.push(`PEOPLE WAITING: ${pickup.waiting.map((line) => `${line.derived}${line.said ? ` (they wrote: "${line.said}")` : ""}`).join(" | ")}`);
    }
    return out.join("\n\n");
  }

  startSpoolNight(budget: NightBudget = {}): { night: SpoolNight | null; alreadyRunning: boolean } {
    if (this.nightInFlight) return { night: this.spoolNight(), alreadyRunning: true };

    const projects = this.listProjects();
    const run = runNight(
      this.spool,
      nightDeps(this.spool, {
        humanActive: () => this.humanActive(),
        cwdFor: (name) => projects.find((p) => p.name === name)?.root ?? projects.find((p) => p.id === name)?.root,
        /**
         * EVERY JOB GETS A BODY, exactly as a hand-triggered pass does. One
         * record and one shape, so the morning shows what ran while you slept
         * beside what is running while you watch without translating either.
         */
        watch: (input) => {
          const { handle } = this.work.begin({
            ...input,
            origin: "night",
            started: spoolCapturedLabel(new Date()),
          });
          return { step: handle.step, settle: handle.settle };
        },
        // §7.6 — a subject at `read` is ripened and never drafted for; the
        // night's plan is subject-aware from the moment this record exists.
        permits: this.subjectGate(),
        headFor: (key) => this.subjectHead(key),
        verifiable: () => this.verifiableSubjects(),
      }),
      budget,
    );
    /**
     * THE HANDLE IS CLEARED IN A `finally`, and the rejection is swallowed
     * HERE rather than left to float: an unhandled rejection on a background
     * promise takes the daemon down in Bun, which would turn one failed job
     * into a dead engine.
     */
    this.nightInFlight = run;
    void run.catch(() => undefined).finally(() => {
      this.nightInFlight = undefined;
    });

    // The plan, as it stands the moment it was written — the caller gets what
    // tonight intends to do and reads progress from `spoolNight()`.
    return { night: this.spoolNight(), alreadyRunning: false };
  }

  /**
   * RUN THE ITEM'S PROJECT EXPERT OVER IT — the interpreter, reachable at last.
   *
   * THE ONLY ASYNC METHOD IN THE SPOOL BLOCK, because it is the only one that
   * spends money. Everything else here is a disk read or an atomic write; this
   * one awaits a model. A caller that treats it like its neighbours will hold an
   * HTTP request open for the length of a turn — see the route's own note.
   *
   * IT RETURNS AN OUTCOME AND DOES NOT THROW for anything the user can act on.
   * A floating item, a name the store cannot address, a project this machine has
   * not registered, a model that never answered — each is an ANSWER to "can the
   * expert read this?", and each already carries a sentence naming the next
   * move. Turning those into `invalid_request` would be the second time this
   * module threw away a good sentence for a status code.
   */
  async consultSpoolExpert(
    id: string,
    options: { abort?: AbortController } = {},
  ): Promise<ExpertPassOutcome> {
    const begun = this.beginExpertPass(id, options);
    return begun.refused ?? (await begun.done);
  }

  /**
   * THE SAME PASS, ANSWERED AT ONCE WITH ITS WORK RECORD.
   *
   * THE ROUTE'S OWN COMMENT PREDICTED THIS AND IT CAME TRUE. It said the
   * synchronous shape held only "once the OVERNIGHT runner exists and nobody is
   * watching — at which point the job store is the thing that reports what ran
   * while you slept, and building a second one here first would mean throwing it
   * away." That store is `spool/work.ts`, and this is the same fix
   * `startSpoolNight` already carries, for the same measured reason: a caller's
   * HTTP client gives up at five minutes while the daemon happily finishes.
   *
   * The awaiting form above stays, and `spool_consult_expert` keeps using it: a
   * MODEL that called the tool cannot do anything with a record it must poll.
   */
  startSpoolExpert(id: string): { work: SpoolWork | null; refused?: string; alreadyRunning?: boolean } {
    const running = this.work.runningFor(id);
    if (running) return { work: running, alreadyRunning: true };

    const begun = this.beginExpertPass(id);
    if (begun.refused) return { work: null, refused: begun.refused.reason };
    /**
     * SWALLOWED HERE rather than left to float, exactly as the night's handle
     * is: an unhandled rejection on a background promise takes the daemon down
     * in Bun, which would turn one failed pass into a dead engine. The outcome
     * is not lost — it is on the work record and on the item's timeline.
     */
    void begun.done.catch(() => undefined);
    return { work: begun.work, alreadyRunning: false };
  }

  /**
   * Everything both forms share: the refusals that cost nothing, the registry
   * entry, and the pass itself as an un-awaited promise.
   *
   * ONE BODY SO THE TWO CANNOT DRIFT. The alternative — a synchronous method
   * and a detached one, each with its own copy of the project resolution and
   * the settle logic — is how one of them ends up spending money the other
   * refuses to.
   */
  private beginExpertPass(
    id: string,
    options: { abort?: AbortController } = {},
  ): { refused: Extract<ExpertPassOutcome, { ok: false }>; work?: undefined; done?: undefined } | { refused?: undefined; work: SpoolWork; done: Promise<ExpertPassOutcome> } {
    const item = this.spoolFound(getSpoolItem(this.spool, id), "spool item not found");
    if (!item.project) return { refused: { ok: false, reason: floatingExpertRefusal(item.title) } };

    /**
     * ALREADY BEING READ — ANSWERED, NOT PAID FOR TWICE.
     *
     * The route's own header used to say "the surface's busy state is what
     * prevents the second", which was true only until a reload. Two clicks are
     * now one pass from anywhere, including two windows, because the guard sits
     * in the process that would spend the money rather than in a component.
     */
    const running = this.work.runningFor(id);
    if (running) {
      return {
        refused: {
          ok: false,
          reason: `The ${running.project ?? "project"} expert is already reading "${running.itemTitle}"${running.step ? ` — ${running.step.label}` : ""}. Nothing was started twice.`,
        },
      };
    }

    /**
     * A FREE-FORM LABEL RESOLVED AGAINST THE REGISTRY, name first and then id —
     * the same two-step, in the same order, that the packet page's "Start a
     * session" uses, because a human typing a project into a packet types its
     * NAME and a caller that already knew the id passes the id.
     *
     * NO MATCH IS NOT A FAILURE. CAP-9's claim is that the DIGEST is enough, so
     * an unregistered or mirrored project simply means the expert reasons from
     * the digest and the packet with no tree to read. The outcome reports which
     * it was, so a surface can say so rather than implying the expert looked at
     * files it never had.
     */
    const projects = this.listProjects();
    const registered =
      projects.find((candidate) => candidate.name === item.project) ??
      projects.find((candidate) => candidate.id === item.project);

    /**
     * THE ABORT CONTROLLER IS MINTED HERE WHEN THE CALLER BROUGHT NONE, so
     * `cancelSpoolWork` has something to pull. A pass with no controller is a
     * pass nobody can stop, which for a twenty-turn call is the same
     * powerlessness the busy boolean had.
     */
    const abort = options.abort ?? new AbortController();
    const { handle } = this.work.begin({
      kind: "expert",
      itemId: id,
      itemTitle: item.title,
      project: item.project,
      origin: "you",
      started: spoolCapturedLabel(new Date()),
      abort,
    });

    const done = runExpertPass(this.spool, {
      itemId: id,
      project: item.project,
      ...(registered ? { cwd: registered.root } : {}),
      abort,
      onStep: handle.step,
    }).then((outcome) => {
      handle.settle(
        outcome.ok
          ? {
              state: "done",
              note: outcome.cold
                ? `First pass — the ${outcome.project} expert had no memory of this project and has now written one.`
                : `The ${outcome.project} expert rewrote the brief.`,
              ...(outcome.usage ? { usage: outcome.usage } : {}),
            }
          : // A REFUSAL IS NOT A FAILURE, here as in the night — and neither is a
            // cancellation you asked for. `classifySettle` is the one place
            // that decides, so the expert and the night cannot disagree.
            { state: classifySettle(outcome.reason), note: outcome.reason },
      );
      return outcome;
    });

    // The record as it stands the moment it opened — a caller that detaches
    // gets something to render immediately and polls for the rest.
    return { work: this.work.find(handle.id) as SpoolWork, done };
  }

  /**
   * WHAT THE SPOOL IS DOING RIGHT NOW, and what it just finished.
   *
   * Read by the web on the same interval it already tails a session with, and
   * only while something is running — see `spool/work.ts` for why none of this
   * is on disk.
   */
  spoolWork(): SpoolWork[] {
    return this.work.list();
  }

  /** Stop one pass. Returns false when there is nothing running under that id —
   *  a settled entry, or one this daemon never had. */
  cancelSpoolWork(id: string): boolean {
    return this.work.cancel(id);
  }

  /**
   * THE MASTER CHAT — the Spool's project-less front door, as a session.
   *
   * A SINGLETON, and that is the contract rather than an optimisation: CAP-1
   * says "ONE project-less conversation — the module's front door", and the
   * whole calm mechanism depends on there being one place to arrive at. A `new
   * master chat` button would turn the front door into a list of front doors.
   * So this is `ensure`, not `create`: it returns the existing one or mints it,
   * and it is safe to call on every page load.
   *
   * ITS SHAPE, and why each field is what it is:
   *
   *   · NO PROJECT. Not a synthetic one, not a placeholder — the field is
   *     absent, because the master answers across projects and its per-project
   *     experts are each scoped to their own. A master carrying a project would
   *     be scoped to the one thing it must not be scoped to. Downstream this is
   *     what makes the spool toolkit report "all projects" and MCP resolution
   *     hand it the environment's global servers only.
   *   · cwd = `spool/home`, A DEDICATED EMPTY DIRECTORY. Both harnesses key
   *     history and trust PER DIRECTORY, so one stable home accrues a single
   *     continuous bucket where scratch directories fragment it. It holds no
   *     store files — `lanes.json` and `packets/` are its SIBLINGS — and the
   *     store's own header is emphatic that this layout defeats a relative-path
   *     accident and nothing more. The real boundary is still owed.
   *   · `local`, never a worktree. There is no repository to cut one from.
   *   · NEVER the user's home directory. Trust does not persist there, and a
   *     harness rooted there treats the whole machine as the working set.
   *
   * `ensureSpool` runs first so the cwd exists before a session names it: a
   * session whose working directory does not exist is unusable, and failing
   * here leaves nothing behind to repair.
   */
  ensureMasterSession(): Session {
    ensureSpoolStore(this.spool);
    const existing = this.readSessions().find((session) => session.projectId === undefined);
    if (existing) {
      /**
       * ENSURE MAY ALSO REPAIR. This session is a singleton the module owns —
       * nobody created it deliberately and nobody configures it — so its
       * defaults are this function's to move, and moving one has to reach the
       * copy already on disk or the new default is a lie for every existing
       * install: the code would say "auto" while the one master anyone actually
       * talks to kept parking on approvals forever. Same persist-plus-event
       * shape as `updateSession`, and only when the value actually differs, so
       * an ordinary page load stays the read it always was.
       */
      if (existing.runtimeMode !== "auto" || existing.model === undefined) {
        const next = structuredClone(existing);
        next.runtimeMode = "auto";
        // AN ABSENT MODEL IS NOT A NEUTRAL DEFAULT — it falls through to the
        // provider CLI's own default, which is the costliest tier. The master's
        // verbs are filing and marking; "sonnet" is the module's default, and
        // repairing only the ABSENT case leaves a deliberate choice standing.
        next.model ??= { instanceId: defaultInstanceIdForDriver("claude"), model: "sonnet" };
        next.updatedAt = this.now();
        atomicWrite(sessionMetadataFile(this.paths, next.id), storedSession(next));
        this.appendEvent(next.id, { type: "session.updated", session: next });
        return structuredClone(next);
      }
      return structuredClone(existing);
    }

    const id = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    const at = this.now();
    const session: Session = SessionSchema.parse({
      id,
      environmentId: "local",
      title: "Spool",
      state: "active",
      createdAt: at,
      updatedAt: at,
      providerInstanceId: defaultInstanceIdForDriver("claude"),
      driver: "claude",
      workspace: { mode: "local", path: this.spool.home },
      envMode: "local",
      /**
       * "auto", NOT the attended default. The attended default exists because
       * an ordinary session holds a repository and a shell — asking first is
       * what bounds them. The master holds neither: its tools are the spool
       * toolkit (list and consult — read and propose verbs), its workspace is
       * the empty spool home, and every consequential act in this module is
       * already gated by the store's own human-only verbs, so approval-required
       * here protects nothing that wall does not — it only parks the
       * conversation, which defeats a front door you talk to. And NOT
       * "full-access": "auto" resolves inside its boundary and parks what
       * escapes it, which is the right posture for the same reason it is
       * `DEFAULT_DETACHED_RUNTIME_MODE`'s — a session nobody is watching a
       * request queue for still has a blast radius worth bounding.
       */
      runtimeMode: "auto",
      // "sonnet", STATED RATHER THAN INHERITED. Left absent, the turn falls
      // through `turn.model ?? session.model` to the provider CLI's own
      // default — the costliest tier — for a session whose verbs are filing
      // and marking. The picker can still override any single turn.
      model: { instanceId: defaultInstanceIdForDriver("claude"), model: "sonnet" },
      interactionMode: "default",
      // ATTENDED, unlike an ordinary session's default. The master is a front
      // door a person arrives at; it has no business running unattended, and
      // the module's first law is that it answers when arrived at rather than
      // acting on its own.
      detached: false,
      activity: "idle",
    });
    atomicWrite(sessionMetadataFile(this.paths, id), session);
    this.appendEvent(id, { type: "session.created", session });
    return structuredClone(session);
  }

  spoolLanes(): SpoolLane[] {
    return readSpoolLanes(this.spool);
  }

  createSpoolLane(input: { label: string; window: string; note?: string }): SpoolLane {
    if (typeof input?.label !== "string" || input.label.trim() === "") {
      throw new EngineStateError("invalid_request", "a lane needs a label");
    }
    if (typeof input?.window !== "string") {
      throw new EngineStateError("invalid_request", "a lane needs a window, even a coarse one");
    }
    return this.spoolWrite(() => createSpoolLane(this.spool, input));
  }

  renameSpoolLane(key: string, label: string): SpoolLane {
    if (typeof label !== "string" || label.trim() === "") {
      throw new EngineStateError("invalid_request", "a lane needs a label");
    }
    return this.spoolFound(
      this.spoolWrite(() => renameSpoolLane(this.spool, key, label)),
      "lane not found",
    );
  }

  /**
   * Retire a lane. REFUSAL IS A RESULT, NOT AN ERROR, and that shape is carried
   * out to the caller rather than flattened into a throw: every refusal reason
   * the store produces is a sentence telling the human what to move first, and a
   * 400 with a generic body would lose it.
   */
  retireSpoolLane(key: string): { ok: true } | { ok: false; reason: string } {
    return this.spoolWrite(() => retireSpoolLane(this.spool, key));
  }

  /**
   * Split rows out of a lane into a new one.
   *
   * NOT A FIFTH LANE PRIMITIVE — it is `createLane` followed by two
   * `reorderLane` calls, and saying so matters: the store's four lane verbs are
   * the only things that change lane structure, and a split that reached past
   * them would be a second definition of what a lane is.
   *
   * THE HUMAN-APPROVAL GATE IS STRUCTURAL HERE, not a card. The master may
   * PROPOSE a split; this is only reachable from a human's own click, because no
   * tool surface names it. That is the whole of the gate.
   *
   * THE SOURCE IS READ BEFORE ANYTHING MOVES, so "what stays behind" is computed
   * against the stack as it was rather than against a stack the first reorder
   * has already emptied.
   */
  splitSpoolLane(
    sourceKey: string,
    input: { label: string; window: string; note?: string },
    moveItemIds: string[],
  ): { source: SpoolLane; created: SpoolLane } {
    return this.spoolWrite(() => {
      const before = readSpoolLanes(this.spool).find((l) => l.key === sourceKey);
      if (!before) throw new EngineStateError("not_found", `No lane named "${sourceKey}" exists.`);
      const created = reorderSpoolLane(this.spool, createSpoolLane(this.spool, input).key, moveItemIds);
      const source = reorderSpoolLane(
        this.spool,
        sourceKey,
        before.items.filter((id) => !moveItemIds.includes(id)),
      );
      return { source, created };
    });
  }

  reorderSpoolLane(key: string, orderedItemIds: string[]): SpoolLane {
    if (!Array.isArray(orderedItemIds) || orderedItemIds.some((id) => typeof id !== "string")) {
      throw new EngineStateError("invalid_request", "a reorder is a list of item ids");
    }
    return this.spoolWrite(() => reorderSpoolLane(this.spool, key, orderedItemIds));
  }

  // ── MCP OAuth ─────────────────────────────────────────────────────────────
  //
  // TELAR OWNS THIS FLOW, unlike every provider login. The rule elsewhere is
  // that Telar adopts logins and never creates them, because `claude` and
  // `codex` already have their own sign-in and their own credential store. A
  // third-party MCP server has neither: nothing else on this machine will hold
  // that grant, so if the engine does not run the flow, the server is simply
  // unusable. That is why the ONE credential this repo mints lives here.
  //
  // KEYED BY THE SAME PAIR THE SERVER IS — `(projectId, serverId)` — so a
  // project's `linear` and the machine's `linear` hold different grants, which
  // is the whole point of the shadowing they already have.

  /** A space cannot appear in either half: both are `Id`s. */
  private mcpOAuthKey(serverId: string, projectId?: string): string {
    return (projectId ?? "") + SECRET_KEY_SEPARATOR + serverId;
  }

  private readMcpOAuthRecords(): Record<string, McpOAuthRecord> {
    const stored = readJson(this.paths.mcpOAuth) as { records?: unknown } | undefined;
    const records = stored?.records;
    if (!records || typeof records !== "object") return {};
    return records as Record<string, McpOAuthRecord>;
  }

  private writeMcpOAuthRecords(records: Record<string, McpOAuthRecord>): void {
    atomicWrite(this.paths.mcpOAuth, { version: STATE_VERSION, records });
  }

  /**
   * The stored grant for one server, TOKENS AND ALL.
   *
   * NOT REACHABLE FROM A ROUTE. The daemon calls `mcpOAuthStatus` when a page
   * asks; this one exists for the claim and for the refresh, which are the two
   * places a token is actually needed.
   */
  getMcpOAuthRecord(serverId: string, projectId?: string): McpOAuthRecord | undefined {
    const record = this.readMcpOAuthRecords()[this.mcpOAuthKey(serverId, projectId)];
    return record ? structuredClone(record) : undefined;
  }

  putMcpOAuthRecord(record: McpOAuthRecord): void {
    const records = this.readMcpOAuthRecords();
    records[this.mcpOAuthKey(record.serverId, record.projectId)] = { ...record, updatedAt: this.now() };
    this.writeMcpOAuthRecords(records);
  }

  deleteMcpOAuthRecord(serverId: string, projectId?: string): boolean {
    const records = this.readMcpOAuthRecords();
    const key = this.mcpOAuthKey(serverId, projectId);
    if (!(key in records)) return false;
    delete records[key];
    this.writeMcpOAuthRecords(records);
    return true;
  }

  /**
   * The client-identity store the ladder needs, and only that.
   *
   * A DCR REGISTRATION IS AUTHORIZATION-SERVER SCOPED, not server scoped: three
   * MCP servers behind one issuer should share one registered client. Minting a
   * second is how somebody ends up with a list of identical stray OAuth apps in
   * their account — and some servers reject a freshly-minted client id outright,
   * which reads as a broken Connect button rather than as what it is.
   */
  mcpOAuthClientStore(): OAuthClientStore {
    return {
      findProvenDcrClient: (issuer, serverId, projectId) => {
        const records = this.readMcpOAuthRecords();
        const proven = (record: McpOAuthRecord | undefined): boolean =>
          record?.client?.strategy === "dcr" && Boolean(record.client.id) && Boolean(record.tokens?.accessToken);
        const own = records[this.mcpOAuthKey(serverId, projectId)];
        if (proven(own)) return structuredClone(own!.client);
        for (const record of Object.values(records)) {
          if (record.as?.issuer === issuer && proven(record)) return structuredClone(record.client);
        }
        return undefined;
      },
      findPendingDcrClient: (serverId, projectId) => {
        const record = this.readMcpOAuthRecords()[this.mcpOAuthKey(serverId, projectId)];
        return record?.client?.strategy === "dcr" && record.client.id ? structuredClone(record.client) : undefined;
      },
      rememberClient: ({ serverId, projectId, resource, as, client }) => {
        // Keeps any tokens already there: this runs BEFORE the exchange, and a
        // reconnect of a working server must not blank its own grant on the way.
        const existing = this.getMcpOAuthRecord(serverId, projectId);
        this.putMcpOAuthRecord({
          serverId,
          ...(projectId === undefined ? {} : { projectId }),
          resource,
          as,
          client,
          tokens: existing?.tokens ?? { accessToken: "" },
          updatedAt: this.now(),
        });
      },
    };
  }

  /**
   * Stash an in-flight sign-in, keyed by its own OAuth `state`.
   *
   * SWEEPS ON THE WAY IN, so an abandoned flow — the user closed the tab at the
   * consent screen — cannot accumulate. Ten minutes is the window: long enough
   * to read a consent screen, short enough that a verifier is not sitting on
   * disk for an afternoon.
   */
  putPendingMcpOAuth(flow: PendingMcpOAuth): void {
    const flows = this.prunePendingMcpOAuth(this.readPendingMcpOAuth());
    flows[flow.ctx.state] = flow;
    atomicWrite(this.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
  }

  /**
   * Take a flow by state — SINGLE USE, so a replayed callback finds nothing.
   *
   * The read-modify-write is not atomic across processes, so two simultaneous
   * callbacks for one state could both observe it. That is acceptable and not
   * papered over: the authorization code is itself single-use at the token
   * endpoint, which is the real backstop, and the second exchange fails there.
   */
  takePendingMcpOAuth(state: string): PendingMcpOAuth | undefined {
    if (!state) return undefined;
    const flows = this.prunePendingMcpOAuth(this.readPendingMcpOAuth());
    const flow = flows[state];
    delete flows[state];
    atomicWrite(this.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
    return flow;
  }

  private readPendingMcpOAuth(): Record<string, PendingMcpOAuth> {
    const stored = readJson(this.paths.mcpOAuthPending) as { flows?: unknown } | undefined;
    const flows = stored?.flows;
    if (!flows || typeof flows !== "object") return {};
    return flows as Record<string, PendingMcpOAuth>;
  }

  private prunePendingMcpOAuth(flows: Record<string, PendingMcpOAuth>): Record<string, PendingMcpOAuth> {
    const cutoff = this.now() - PENDING_MCP_OAUTH_TTL_MS;
    for (const [state, flow] of Object.entries(flows)) {
      if (!flow || typeof flow.createdAt !== "number" || flow.createdAt <= cutoff) delete flows[state];
    }
    return flows;
  }

  /**
   * The grant a server should run with, refreshed if it is about to expire.
   *
   * BEST-EFFORT BY CONSTRUCTION. A refresh that fails — revoked, offline, the
   * server rotated its client — returns the token we have rather than throwing:
   * a stale token 401s at the server, which is a legible failure inside one
   * tool call, whereas throwing here would fail the whole turn over a tool the
   * user may not even have asked for.
   */
  async resolveMcpOAuthToken(serverId: string, projectId: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
    const record = this.getMcpOAuthRecord(serverId, projectId);
    if (!record?.tokens.accessToken) return undefined;
    if (!needsRefresh(record, 120, this.now()) || !record.tokens.refreshToken) return record.tokens.accessToken;
    try {
      const tokens = await refreshAccessToken({
        as: record.as,
        client: record.client,
        refreshToken: record.tokens.refreshToken,
        resource: record.resource,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      this.putMcpOAuthRecord({ ...record, tokens });
      return tokens.accessToken;
    } catch {
      return record.tokens.accessToken;
    }
  }

  /**
   * Attach the managed bearer to every claimed server that has one.
   *
   * SEPARATE FROM `claimNextTurn`, AND ASYNC, FOR ONE REASON: refreshing a
   * token is a network call, and `claimNextTurn` runs under the daemon's single
   * state lock. A refresh to a slow authorization server inside that lock would
   * stall every other session's claim behind it. So the claim stays synchronous
   * and this runs after it, on the way out.
   *
   * KEYED ON A STORED GRANT, NEVER ON THE `oauth` BLOCK. The block is overrides;
   * having signed in is what makes a server authenticated, which is also why a
   * server the user never connected is returned untouched.
   *
   * A HAND-WRITTEN `Authorization` HEADER WINS. Someone who typed one meant it,
   * and silently replacing it with a Telar-managed token would be the harder
   * failure to diagnose of the two.
   */
  async authorizeClaimedMcpServers(claim: WorkerClaim, fetchImpl?: typeof fetch): Promise<WorkerClaim> {
    if (!claim.mcpServers?.length) return claim;
    const mcpServers = await Promise.all(
      claim.mcpServers.map(async (server) => {
        if (server.spec.transport === "stdio") return server;
        const headers = server.spec.headers ?? {};
        if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) return server;
        // The grant is keyed by the scope the SERVER came from, which for a
        // project-scoped server is that project — not the session's, which for
        // a global server would be a key nothing was ever stored under.
        const token = await this.resolveMcpOAuthToken(server.id, server.projectId, fetchImpl);
        if (!token) return server;
        return { ...server, spec: { ...server.spec, headers: { ...headers, Authorization: `Bearer ${token}` } } };
      }),
    );
    return { ...claim, mcpServers };
  }

  // ── provider instances ────────────────────────────────────────────────────
  //
  // THE ACCOUNT REGISTRY the contract has been routing at since v2. Every
  // session already stores a `providerInstanceId`; until now the engine minted
  // `<driver>:default` and nothing was behind the id.
  //
  // TELAR ADOPTS LOGINS, IT DOES NOT CREATE THEM. Nothing here signs anyone in
  // and no route below ever will. An instance names a config folder the user
  // has already authenticated, plus the environment its provider process runs
  // with; whether that folder actually holds a login is a question `probe()`
  // answers from the filesystem, never by reading a credential.

  /**
   * Every configured instance, WITH SENSITIVE VALUES WITHHELD.
   *
   * This is the read a settings page gets. `resolveProviderInstance` is the one
   * that returns real secrets, and it is not reachable from a route.
   */
  listProviderInstances(): ProviderInstance[] {
    return this.readProviderInstances().map((instance) => ({
      ...instance,
      env: instance.env.map((variable) =>
        variable.sensitive ? { ...variable, value: "", valueRedacted: true } : variable,
      ),
    }));
  }

  /**
   * Create or replace one instance.
   *
   * `null` CLEARS A FIELD AND ABSENT LEAVES IT ALONE, the same three-state rule
   * `updateSession` uses — a settings form that could not distinguish "no accent
   * colour" from "did not touch the accent colour" would erase one edit with
   * the next.
   */
  saveProviderInstance(input: {
    id: string;
    driver?: unknown;
    displayName?: string | null;
    accentColor?: string | null;
    enabled?: boolean;
    configDir?: string | null;
    binaryPath?: string | null;
    env?: unknown;
  }): ProviderInstance {
    assertInstanceId(input.id);
    const instances = this.readProviderInstances();
    const existing = instances.find((instance) => instance.id === input.id);
    const driver = input.driver === undefined ? existing?.driver : input.driver;
    if (driver !== "claude" && driver !== "codex") {
      throw new EngineStateError("invalid_request", "provider instance driver must be claude or codex");
    }
    /**
     * THE DRIVER IS FIXED FOR AN INSTANCE'S LIFETIME. Sessions, their resume
     * cursors and their whole transcripts belong to one harness; re-pointing
     * the id they route by at the other one would resume a Claude conversation
     * inside Codex.
     */
    if (existing && existing.driver !== driver) {
      throw new EngineStateError("conflict", "a provider instance cannot change driver");
    }
    const at = this.now();
    const secrets = this.readProviderSecrets();
    const env = this.applyEnvEdits(input.id, input.env, existing?.env ?? [], secrets);
    const instance: ProviderInstance = {
      id: input.id,
      driver,
      enabled: input.enabled ?? existing?.enabled ?? true,
      env: env.stored,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...optionalPatch("displayName", input.displayName, existing?.displayName, (value) => value.trim().slice(0, 120)),
      ...optionalPatch("accentColor", input.accentColor, existing?.accentColor, (value) => {
        const colour = value.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw new EngineStateError("invalid_request", "accent colour must be #rrggbb");
        return colour;
      }),
      ...optionalPatch("configDir", input.configDir, existing?.configDir, (value) => {
        const dir = value.trim();
        if (!dir.startsWith("/") && !dir.startsWith("~")) {
          throw new EngineStateError("invalid_request", "config directory must be an absolute or ~-relative path");
        }
        return dir;
      }),
      /**
       * A PATH OR A NAME, AND NOTHING IN BETWEEN. `cli-resolution.ts` reads a
       * separator as "this exact file" and its absence as "look this name up",
       * so the only shapes refused here are the ones that would be neither: a
       * relative path like `bin/claude`, which would resolve against whatever
       * the worker's cwd happened to be — a different binary per session.
       */
      ...optionalPatch("binaryPath", input.binaryPath, existing?.binaryPath, (value) => {
        const binary = value.trim();
        const looksLikePath = binary.includes("/") || binary.includes("\\");
        if (looksLikePath && !binary.startsWith("/") && !binary.startsWith("~")) {
          throw new EngineStateError("invalid_request", "binary path must be an absolute path, a ~-relative path, or a bare command name");
        }
        return binary;
      }),
    };
    const parsed = ProviderInstanceSchema.safeParse(instance);
    if (!parsed.success) throw new EngineStateError("invalid_request", "provider instance configuration is invalid");
    const next = existing
      ? instances.map((entry) => (entry.id === instance.id ? parsed.data : entry))
      : [...instances, parsed.data];
    atomicWrite(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: next });
    atomicWrite(this.paths.providerSecrets, { version: STATE_VERSION, secrets: env.secrets });
    return structuredClone(this.listProviderInstances().find((entry) => entry.id === instance.id)!);
  }

  /**
   * Remove a custom instance.
   *
   * THE BUILT-IN SLOT IS NOT DELETABLE — there would be nothing left for a
   * session on that driver to route to, and "reset it" is what the caller
   * actually wants. Sessions still naming a deleted instance are not rewritten:
   * `resolveProviderInstance` falls back to the driver's default, which is the
   * same path a session created before this registry existed takes.
   */
  removeProviderInstance(id: string): boolean {
    assertInstanceId(id);
    if (id === defaultInstanceIdForDriver("claude") || id === defaultInstanceIdForDriver("codex")) {
      throw new EngineStateError("conflict", "the built-in provider instance cannot be removed");
    }
    const instances = this.readProviderInstances();
    const next = instances.filter((instance) => instance.id !== id);
    if (next.length === instances.length) return false;
    const secrets = this.readProviderSecrets();
    for (const key of Object.keys(secrets)) {
      if (key.slice(0, key.indexOf(SECRET_KEY_SEPARATOR)) === id) delete secrets[key];
    }
    atomicWrite(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: next });
    atomicWrite(this.paths.providerSecrets, { version: STATE_VERSION, secrets });
    return true;
  }

  /**
   * The instance a session actually runs as, WITH ITS SECRETS RESOLVED.
   *
   * Falls back to the driver's built-in slot for any id the registry does not
   * know — a session created before the registry existed (`claude:default`), or
   * one whose custom instance was deleted. Falling back rather than failing is
   * t3 code's rule too: an instance that vanished is a settings change, not a
   * reason a conversation stops being resumable.
   */
  resolveProviderInstance(instanceId: string, driver: ProviderDriverKind): ProviderInstance {
    const instances = this.readProviderInstances();
    const found =
      instances.find((instance) => instance.id === instanceId) ??
      instances.find((instance) => instance.id === defaultInstanceIdForDriver(driver));
    if (!found) return seedProviderInstance(driver, this.now());
    const secrets = this.readProviderSecrets();
    return {
      ...found,
      env: found.env.map((variable) =>
        variable.sensitive ? { ...variable, value: secrets[secretKey(found.id, variable.name)] ?? "" } : variable,
      ),
    };
  }

  /** The one place a caller's instance id is checked to exist. Creating a
   *  session against an id nobody configured is a client bug worth a 400;
   *  RESUMING one whose instance was deleted is not, which is why
   *  `resolveProviderInstance` falls back instead of throwing. */
  private requireProviderInstance(id: string): ProviderInstance {
    assertInstanceId(id);
    const found = this.readProviderInstances().find((instance) => instance.id === id);
    if (!found) throw new EngineStateError("not_found", "provider instance does not exist");
    return found;
  }

  /** On disk, seeded on first read so a fresh install has the two built-in
   *  slots rather than an empty page that offers nothing to configure. */
  private readProviderInstances(): ProviderInstance[] {
    const stored = readJson(this.paths.providerInstances) as { providerInstances?: unknown } | undefined;
    if (stored === undefined) {
      const at = this.now();
      const seeded = [seedProviderInstance("claude", at), seedProviderInstance("codex", at)];
      atomicWrite(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: seeded });
      return seeded;
    }
    const parsed = ProviderInstanceSchema.array().safeParse(stored.providerInstances ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid provider instance registry");
    return parsed.data;
  }

  private readProviderSecrets(): Record<string, string> {
    const stored = readJson(this.paths.providerSecrets) as { secrets?: unknown } | undefined;
    const secrets = stored?.secrets;
    if (secrets === undefined || secrets === null) return {};
    if (typeof secrets !== "object") throw new EngineStateError("invalid_request", "invalid provider secret store");
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  /**
   * Fold a submitted env list into what is stored, moving secrets aside.
   *
   * THE REDACTED ROUND TRIP IS THE POINT. A client reads a sensitive variable
   * as `{ value: "", valueRedacted: true }` and hands that same shape back on
   * save; the stored secret must survive. Only a non-empty value replaces one,
   * and clearing a secret is done by dropping the variable — not by saving it
   * blank, which is indistinguishable from "I did not retype my key".
   */
  private applyEnvEdits(
    instanceId: string,
    submitted: unknown,
    previous: ProviderInstanceEnvVar[],
    secrets: Record<string, string>,
  ): { stored: ProviderInstanceEnvVar[]; secrets: Record<string, string> } {
    if (submitted === undefined) return { stored: previous, secrets };
    const parsed = ProviderInstanceEnvVarSchema.array().max(64).safeParse(submitted);
    if (!parsed.success) throw new EngineStateError("invalid_request", "provider instance environment is invalid");
    const next = { ...secrets };
    const stored: ProviderInstanceEnvVar[] = [];
    const seen = new Set<string>();
    for (const variable of parsed.data) {
      if (seen.has(variable.name)) throw new EngineStateError("invalid_request", `duplicate environment variable ${variable.name}`);
      seen.add(variable.name);
      const key = secretKey(instanceId, variable.name);
      if (!variable.sensitive) {
        delete next[key];
        stored.push({ name: variable.name, value: variable.value, sensitive: false });
        continue;
      }
      if (variable.value !== "") next[key] = variable.value;
      else if (!(key in next)) next[key] = "";
      stored.push({ name: variable.name, value: "", sensitive: true });
    }
    for (const variable of previous) {
      if (!seen.has(variable.name)) delete next[secretKey(instanceId, variable.name)];
    }
    return { stored, secrets: next };
  }

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: {
      notifier?: EngineNotifier;
      git?: GitRunner;
      gh?: GhRunner;
      sessionsBudget?: number;
      /** Resolves Telar's computer-use backend (cua-driver, or Sky). INJECTED
       *  BY THE DAEMON, absent by default — so tests never read the real
       *  machine's installs, and a store without it simply has no computer use. */
      computerUse?: () => ResolvedComputerUse | undefined;
      /** Asks the installed harnesses what they can run. INJECTED BY TESTS ONLY
       *  — the default is the real subprocess handshake, and a store test that
       *  wants to prove an overlay reaches a menu should not have to spawn a
       *  `codex app-server` to do it. */
      models?: typeof readModelCatalogue;
      /** The model manifest (./model-manifest.ts). INJECTED BY TESTS ONLY —
       *  the default is the bundled one, and a test about the overlay should
       *  not have to know which models the manifest declares this week. */
      manifest?: ModelManifest;
    } = {},
  ) {
    this.notifier = options.notifier;
    this.readModels = options.models ?? readModelCatalogue;
    this.manifest = options.manifest ?? BUNDLED_MANIFEST;
    this.computerUse = options.computerUse;
    this.git = options.git ?? defaultGitRunner;
    this.gh = options.gh ?? defaultGhRunner;
    this.sessionsBudget = Math.max(0, Math.floor(options.sessionsBudget ?? DEFAULT_SESSIONS_BUDGET));
    this.paths = statePaths(root);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
  }

  /**
   * The project's icon, found in its checkout and cached for a minute.
   *
   * A TTL CACHE because `listProjects` is on the sidebar's poll path and the
   * find is a dozen stats per project. In memory like the caches above: it
   * describes files in somebody's working tree, which change without telling
   * the engine — sixty seconds is the stated staleness bound.
   */
  private readonly projectIconCache = new Map<string, { icon?: ProjectIcon; at: number }>();

  private projectIcon(project: Pick<Project, "id" | "root">): ProjectIcon | undefined {
    const cached = this.projectIconCache.get(project.id);
    const at = this.now();
    if (cached && at - cached.at < 60_000) return cached.icon;
    const icon = findProjectIcon(project.root);
    this.projectIconCache.set(project.id, { ...(icon ? { icon } : {}), at });
    return icon;
  }

  /** The icon's bytes-on-disk, for the daemon's serve route. Refuses when the
   *  project has none rather than guessing. */
  projectIconFile(projectId: string): ProjectIcon {
    const project = this.getProject(projectId);
    const icon = this.projectIcon(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  listProjects(): Project[] {
    const registry = readJson(this.paths.projects);
    if (registry === undefined) return [];
    return structuredClone(parseRegistry(registry).projects).map((project) => {
      /**
       * DERIVED HERE, NOT STORED, exactly as `Session.activity` is: HEAD moves,
       * and a branch written into the registry would be wrong the first time
       * anybody switched. One `git rev-parse` per project — there are a handful
       * — is what a sidebar needs to tell a local session where its work lands.
       *
       * A DETACHED HEAD ANSWERS "HEAD", which is not a branch and is not worth
       * showing; an unversioned directory answers non-zero. Both leave the
       * field absent rather than inventing a name.
       */
      const head = this.git(project.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = head.status === 0 ? head.stdout.trim() : "";
      const icon = this.projectIcon(project);
      return {
        ...project,
        ...(branch && branch !== "HEAD" ? { branch } : {}),
        ...(icon ? { icon: icon.etag } : {}),
      };
    });
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
    // A fresh registration must not inherit a stale "no icon" answer cached
    // for a project that briefly shared this id.
    this.projectIconCache.delete(id);
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
  async modelCatalogue(
    driver: ProviderDriverKind,
    options: { force?: boolean; instanceId?: string } = {},
  ): Promise<ModelCatalogue> {
    if (driver !== "claude" && driver !== "codex") throw new EngineStateError("invalid_request", "unknown provider driver");
    const cached = this.modelCache.get(driver);
    let raw: ModelCatalogue;
    if (cached && !options.force && this.now() - cached.readAt < MODEL_CACHE_MS) {
      raw = structuredClone(cached);
    } else {
      raw = await this.readModels(driver, this.now);
      this.modelCache.set(driver, raw);
      raw = structuredClone(raw);
    }
    /**
     * THE OVERLAY IS APPLIED HERE AND CACHED NOWHERE.
     *
     * It is a local file read of the same cost class as the inbox policy, so it
     * happens on every answer — which is what makes an edit in the Models tab
     * visible on the next menu open rather than five minutes later, and what
     * means hiding a row never costs a subprocess. The cache above keeps holding
     * WHAT THE PROVIDER SAID, which is what `source` claims about it.
     */
    const instanceId = options.instanceId ?? defaultInstanceIdForDriver(driver);
    const overlay = this.getModelOverlay(instanceId);
    /**
     * MANIFEST BEFORE OVERLAY, both outside the cache. The manifest fills in
     * rows the provider left out (a `[1m]` variant the CLI does not list — see
     * ./model-manifest.ts); the overlay is the reader's curation of the
     * resulting list. Applied after the cache for the same reason the overlay
     * is: the cache holds what the provider said, and `source` promises that.
     * Claude-only today; Codex publishes no windows to fill in.
     */
    const listed = driver === "claude" ? applyModelManifest(raw.models, this.manifest) : raw.models;
    return { ...raw, instanceId, models: applyModelOverlay(listed, overlay) };
  }

  /**
   * One login's curated view of its provider's models, or an untouched one.
   *
   * NEVER THROWS, the same rule `getInboxPolicy` follows and for the same reason,
   * with one extra clause worth stating: a malformed overlay costs the menu order
   * AND a manually-added model id. That is a real loss and still the right trade —
   * refusing to answer would take the whole picker with it, on both providers, over
   * a document nobody can see in order to repair it.
   *
   * THE try/catch IS AROUND `readJson`, NOT JUST THE PARSE, for the reason the
   * inbox policy already records: `readJson` swallows a missing file and RETHROWS
   * a parse error, so "the shape is wrong" and "it is not JSON at all" are two
   * different failures and only one of them is a safeParse.
   */
  getModelOverlay(instanceId: string): ModelOverlay {
    assertInstanceId(instanceId);
    const empty = (): ModelOverlay => ({ instanceId, ...DEFAULT_MODEL_OVERLAY, updatedAt: 0 });
    try {
      const stored = readJson(this.paths.modelOverlays) as { overlays?: unknown } | undefined;
      const parsed = ModelOverlaySchema.array().safeParse(stored?.overlays ?? []);
      if (!parsed.success) return empty();
      return parsed.data.find((entry) => entry.instanceId === instanceId) ?? empty();
    } catch {
      return empty();
    }
  }

  /**
   * TAKES `unknown` AND VALIDATES HERE, like `setInboxPolicy` and `saveMcpServer`:
   * the bound belongs next to the schema that states it, not spelled a second time
   * in whichever route is the way in today.
   *
   * PRESENCE IS THE PATCH, AND A SUBMITTED ARRAY REPLACES ITS LIST WHOLE. Not
   * element-wise, because each of these is an ordered set the reader edits as a
   * whole in one pane — merging would make "remove the last favourite"
   * unexpressible, which is the same trap `optionalPatch` exists to keep out of
   * the instance form.
   */
  setModelOverlay(
    instanceId: string,
    patch: { favorites?: unknown; hidden?: unknown; order?: unknown; custom?: unknown },
  ): ModelOverlay {
    assertInstanceId(instanceId);
    const next: ModelOverlay = { ...this.getModelOverlay(instanceId), updatedAt: this.now() };
    for (const key of ["favorites", "hidden", "order"] as const) {
      if (patch[key] === undefined) continue;
      next[key] = readModelIds(patch[key], key);
    }
    if (patch.custom !== undefined) next.custom = readCustomModels(patch.custom);

    const stored = (() => {
      try {
        const raw = readJson(this.paths.modelOverlays) as { overlays?: unknown } | undefined;
        const parsed = ModelOverlaySchema.array().safeParse(raw?.overlays ?? []);
        return parsed.success ? parsed.data : [];
      } catch {
        // A document nobody can parse is replaced by this write rather than
        // blocking it — the same stance the getter takes on the way in.
        return [];
      }
    })();
    const overlays = [...stored.filter((entry) => entry.instanceId !== instanceId), next];
    atomicWrite(this.paths.modelOverlays, { version: STATE_VERSION, overlays });
    return structuredClone(next);
  }

  /**
   * WHICH ROWS, IN THE CACHE KEY.
   *
   * Without the states in the key, switching the Pull requests surface from open
   * to all would be answered instantly from a cache of open ones — a filter that
   * silently does nothing for thirty seconds, which is worse than a slow one.
   */
  private githubKey(projectId: string, issues: GitHubIssueFilter, pulls: GitHubPullFilter): string {
    /**
     * NORMALISED, so two spellings of the same question share one cache entry —
     * labels chosen in a different order are the same filter, and `gh` ANDs them
     * regardless. Without the sort, picking `bug` then `web` and `web` then `bug`
     * would spend two network reads to get the same rows.
     */
    const shape = (filter: GitHubIssueFilter | GitHubPullFilter) => ({
      state: filter.state,
      milestone: (filter as GitHubIssueFilter).milestone ?? "",
      assignee: filter.assignee ?? "",
      author: filter.author ?? "",
      labels: [...filter.labels].sort(),
    });
    return `${projectId}:${JSON.stringify([shape(issues), shape(pulls)])}`;
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
    options: { force?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {},
  ): Promise<GitHubSnapshot> {
    const project = this.getProject(projectId);
    const issues = options.issues ?? DEFAULT_ISSUE_FILTER;
    const pulls = options.pulls ?? DEFAULT_PULL_FILTER;
    const key = this.githubKey(project.id, issues, pulls);
    const cached = this.githubCache.get(key);
    if (cached && !options.force && this.now() - cached.readAt < GITHUB_CACHE_MS) return structuredClone(cached);
    // Once a token has said it has no `read:project`, stop paying two network calls
    // per read to be told again. A forced read clears the verdict, so adding the
    // scope and pressing refresh is all it takes to get boards back.
    const skipProjects = this.noProjectScope && !options.force;
    const snapshot = await readGitHub(this.gh, project.root, this.now, { issues, pulls, ...(skipProjects ? { skipProjects: true } : {}) });
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
   * What there is to filter by in a project's repository.
   *
   * CACHED FIVE TIMES LONGER THAN A LIST READ, because milestones and labels change
   * on the timescale of a sprint rather than of a page view — the same reason the
   * model catalogue gets five minutes. Only asked when a client opens a filter menu,
   * so a reader who never filters never pays for this at all.
   */
  async projectForgeFacets(projectId: string, options: { force?: boolean } = {}): Promise<GitHubFacets> {
    const project = this.getProject(projectId);
    const cached = this.facetCache.get(project.id);
    if (cached && !options.force && this.now() - cached.readAt < FACET_CACHE_MS) return structuredClone(cached);
    const facets = await readForgeFacets(this.gh, project.root, this.now);
    this.facetCache.set(project.id, facets);
    return structuredClone(facets);
  }

  /**
   * One failing check's log.
   *
   * NOT CACHED. A job's log is immutable once the job has finished, so a cache would
   * only ever save a repeat of a request nobody makes twice — and while a job is
   * still running the log is exactly the thing that must not be stale.
   *
   * The job id comes from a check this engine already handed out, so it is a number
   * we produced; it is still validated, because a client is a client.
   */
  projectCheckLog(projectId: string, jobId: string): Promise<GitHubCheckLog> {
    const project = this.getProject(projectId);
    if (!/^\d+$/.test(jobId)) throw new EngineStateError("invalid_request", "a job id is a number");
    return readCheckLog(this.gh, project.root, jobId);
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
    /**
     * WHICH CONFIGURED LOGIN runs this session, if the caller picked one.
     *
     * Naming an instance also names the driver — they cannot be chosen
     * independently without inventing the contradiction the split exists to
     * prevent — so `driver` is ignored when this is present rather than
     * cross-checked and refused.
     */
    providerInstanceId?: string;
    /**
     * Caller-proposed branch for a worktree session, e.g.
     * `loom/hito1-agosto/presupuestos`. Must live under `loom/` or `telar/`
     * (enforced in worktree.ts). Absent, the branch derives from the title —
     * `telar/<title-slug>-<id6>` — and only falls back to the session id when
     * there is no usable title. Names should come from the work, not the
     * machinery.
     */
    branchSlug?: string;
    /**
     * What the worktree is CUT FROM — any local or remote-tracking ref from
     * `GitOverview.refs`, resolved to a sha at creation. Absent means HEAD.
     * Validated conservatively here because it becomes a `git rev-parse`
     * argument: a name that starts with `-` is an option, not a ref.
     */
    baseRef?: string;
    /** A human's own name for the new branch — see `sanitizeBranchName`. */
    branchName?: string;
    workspace?: { path: string; branch: string; baseRef?: string };
    /**
     * WHO ASKED — provenance, not a link. `"session"` means this came through
     * the `sessions` toolkit or its socket, and it is the ONLY value that
     * spends the budget below. Absent (or `"human"`) is a person's own click
     * and is never capped: a human with forty worktrees chose forty worktrees.
     *
     * DECLARED BY THE CALLER'S OWN CODE, never by a model argument — no tool
     * shape on the wall carries it, exactly as `SpoolItem.source` works.
     */
    origin?: SessionOrigin;
  }): Session {
    if (input.id !== undefined) assertId(input.id, "session id");
    const project = this.getProject(input.projectId);
    /**
     * THE BUDGET, CHECKED BEFORE ANYTHING IS CUT.
     *
     * IN THE STORE AND NOT ON THE TOOL WALL, so an in-process caller hits the
     * same wall an HTTP one does — and BEFORE `createSessionWorktree`, because
     * a refusal that had already cut a checkout would leave the very thing the
     * cap exists to prevent lying on disk.
     *
     * THE SENTENCE NAMES THE CAP AND THE NEXT MOVE. A model that reads "limit
     * reached" retries; one that reads which sessions are holding the budget
     * and how to free one can actually act.
     */
    if (input.origin === "session") {
      const live = this.readSessions().filter((session) => session.origin === "session" && session.state === "active");
      if (live.length >= this.sessionsBudget) {
        throw new EngineStateError(
          "conflict",
          `${live.length} of a maximum ${this.sessionsBudget} live sessions created by a session already exist, so this one was not created. ` +
            `Archive or delete one you are finished with — sessions_list shows every live session — and try again.`,
        );
      }
    }
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
    /**
     * AN OMITTED `envMode` ASKS THE STANDING PREFERENCE, not a constant. That
     * is what makes the setting a real default rather than a pre-ticked box:
     * the composer, the MCP toolkit and any API caller that stays quiet all get
     * the same answer, and one that says `worktree` outright still gets exactly
     * that.
     *
     * THE PREFERENCE YIELDS ON AN UNVERSIONED PROJECT. `createSessionWorktree`
     * refuses a directory that is not a git repo — correct for a caller who
     * ASKED for a worktree, and wrong for one who asked for nothing and would
     * otherwise be unable to open a session in that project at all. A stated
     * `worktree` still throws; only the silent case falls back.
     */
    const envMode =
      input.envMode ??
      (this.getSessionDefaults().envMode === "worktree" && isGitWorkTree(this.git, project.root) ? "worktree" : "local");
    const chosen = input.providerInstanceId === undefined ? undefined : this.requireProviderInstance(input.providerInstanceId);
    const driver = chosen?.driver ?? input.driver ?? "claude";
    if (driver !== "claude" && driver !== "codex") throw new EngineStateError("invalid_request", "unknown provider driver");
    if (chosen && !chosen.enabled) throw new EngineStateError("conflict", "that provider instance is switched off");
    // The worktree is cut BEFORE the session document is written. A session
    // whose workspace does not exist is unusable and would have to be repaired
    // on read; failing here leaves nothing behind to repair.
    const workspace: Session["workspace"] =
      envMode === "worktree"
        ? (() => {
            const branchSlug = input.branchSlug ?? derivedBranchFor(input.title ?? "", id);
            if (input.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(input.baseRef)) {
              throw new EngineStateError("invalid_request", "base ref is not a usable git ref name");
            }
            const cut = createSessionWorktree(this.git, {
              engineRoot: this.paths.root,
              projectRoot: project.root,
              sessionId: id,
              ...(branchSlug !== undefined ? { branchSlug } : {}),
              ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
              ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
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
      // Only ever written when it is TRUE. An explicit `"human"` on every
      // session document would be a second spelling of absent, and the two
      // would drift the first time a reader forgot one of them.
      ...(input.origin === "session" ? { origin: "session" as const } : {}),
      createdAt: at,
      updatedAt: at,
      // The instance is the ROUTING key and the driver is descriptive, so the
      // two are derived together here rather than picked independently — a
      // session routed to Claude while claiming to be a Codex session is the
      // one inconsistency this split exists to make impossible.
      providerInstanceId: chosen?.id ?? defaultInstanceIdForDriver(driver),
      driver,
      workspace,
      envMode,
      runtimeMode: detached ? DEFAULT_DETACHED_RUNTIME_MODE : DEFAULT_ATTENDED_RUNTIME_MODE,
      interactionMode: "default",
      detached,
      // Derived on every read (`withActivity`) and stripped before every write
      // (`storedSession`); named here only because the wire shape requires it,
      // and a session with no queue yet is genuinely idle.
      activity: "idle",
    };
    atomicWrite(metadata, storedSession(session));
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
    patch: {
      title?: string;
      runtimeMode?: RuntimeMode;
      detached?: boolean;
      model?: ModelSelectionValue | null;
      /** `null` returns the session to the inactivity rule; the two strings pin
       *  it out of or into the list. Three answers, so not a boolean. */
      settledOverride?: "settled" | "active" | null;
      /** `null` cancels a snooze. A time in the past is accepted and simply
       *  reads as awake — a client's clock is not this engine's to police. */
      snoozedUntil?: number | null;
    },
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
    /**
     * SETTLING IS A DECISION ABOUT THE LIST, so it is stamped when it is made.
     * `settledAt` is what lets a client tell "I shelved this a minute ago" from
     * "I shelved this last week", which is the difference between a decision
     * that still stands and one the world has moved past.
     */
    if (patch.settledOverride !== undefined) {
      if (patch.settledOverride === null) {
        delete next.settledOverride;
        delete next.settledAt;
      } else if (patch.settledOverride === "settled" || patch.settledOverride === "active") {
        next.settledOverride = patch.settledOverride;
        next.settledAt = this.now();
      } else {
        throw new EngineStateError("invalid_request", "settledOverride must be 'settled', 'active' or null");
      }
    }
    if (patch.snoozedUntil !== undefined) {
      if (patch.snoozedUntil === null) {
        delete next.snoozedUntil;
        delete next.snoozedAt;
      } else {
        if (!Number.isFinite(patch.snoozedUntil)) throw new EngineStateError("invalid_request", "snoozedUntil must be a timestamp");
        next.snoozedUntil = Math.floor(patch.snoozedUntil);
        // BOTH STAMPS, ALWAYS. A wake time with no "set at" cannot answer "has
        // anything happened since?", which is the whole of the early-wake rule.
        next.snoozedAt = this.now();
      }
    }

    // Nothing changed: no write, no event. A client polling a "save" button
    // should not fill the journal with rows that say nothing happened.
    if (
      next.title === session.title &&
      next.runtimeMode === session.runtimeMode &&
      next.detached === session.detached &&
      next.settledOverride === session.settledOverride &&
      next.snoozedUntil === session.snoozedUntil &&
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
    atomicWrite(sessionMetadataFile(this.paths, sessionId), storedSession(next));
    this.appendEvent(sessionId, { type: "session.updated", session: next });
    return structuredClone(next);
  }

  /**
   * Re-derive the worktree branch from the CURRENT title, after a generated
   * title replaced the seed. Returns the new branch, or undefined for every
   * way this can decline — and it declines rather than throws, because it runs
   * behind a turn nobody should lose to a naming nicety.
   *
   * ONLY A `telar/` BRANCH IS TOUCHED. Human-named branches live outside the
   * namespace by construction (`sanitizeBranchName` refuses it), and a loom's
   * `loom/…` slugs encode the loom's own structure — both are names somebody
   * or something else owns. `git branch -m` refusing a collision is the
   * remaining guard, and its failure is a no-op here, not an error.
   *
   * The worktree DIRECTORY keeps its seed-derived name: it is an address the
   * session document already holds, and moving a directory a provider process
   * may be running in is how checkouts get corrupted.
   */
  refreshWorktreeBranchFromTitle(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    if (session.state === "archived" || session.workspace.mode !== "worktree") return undefined;
    const current = session.workspace.branch;
    if (!current.startsWith("telar/")) return undefined;
    const next = derivedBranchFor(session.title, sessionId);
    if (next === undefined || next === current) return undefined;
    const renamed = this.git(session.workspace.path, ["branch", "-m", current, next]);
    if (renamed.status !== 0) return undefined;
    const updated: Session = { ...session, workspace: { ...session.workspace, branch: next }, updatedAt: this.now() };
    atomicWrite(sessionMetadataFile(this.paths, sessionId), storedSession(updated));
    this.appendEvent(sessionId, { type: "session.updated", session: updated });
    return next;
  }

  getSession(sessionId: string): Session {
    const stored = readJson(sessionMetadataFile(this.paths, sessionId));
    if (stored === undefined) throw new EngineStateError("not_found", "session does not exist");
    return this.withActivity(structuredClone(parseSession(stored)));
  }

  /**
   * What this session is doing, read from the queue and the open requests.
   *
   * TWO EXTRA FILE READS PER SESSION, and worth them. Without this a sidebar
   * can only sort by recency — every row reads the same and "8h ago" is the
   * most it can say — while the two facts a person actually scans for, "is one
   * of these waiting on me" and "is one still going", are sitting unread on
   * disk. The alternative is a client polling each session's queue separately,
   * which is the same reads plus a round trip each.
   *
   * `blocked` OUTRANKS `working` because both are true at once and only one of
   * them is the reader's to act on. Decided here so every client agrees.
   */
  private withActivity(session: Session): Session {
    const turns = this.readQueue(session.id).turns;
    /**
     * THE QUEUE IS NOW READ ON EVERY PATH, including the blocked one that used
     * to return before reaching it. A blocked session has a history too, and
     * `lastTurnEndedAt` is read by a rule about a session that is HIDDEN — so
     * an answer that is present for three activity states and absent for the
     * fourth would be a field clients could not trust.
     */
    const ended = lastEndedTurn(turns);
    const base: Session = {
      ...session,
      ...(ended?.completedAt === undefined ? {} : { lastTurnEndedAt: ended.completedAt }),
      ...(ended?.state === "failed" ? { lastTurnFailed: true } : {}),
    };
    const open = [...this.readRequests(session.id).values()].filter((request) => request.state === "open");
    if (open.length > 0) {
      // The OLDEST open request, not the newest: it dates how long this session
      // has been waiting, which is the number that should embarrass us.
      const since = Math.min(...open.map((request) => request.openedAt));
      return { ...base, activity: "blocked", activityAt: since };
    }
    const running = turns.find((turn) => turn.state === "running");
    if (running) return { ...base, activity: "working", activityAt: running.startedAt ?? running.updatedAt };
    const waiting = turns.find((turn) => turn.state === "queued" || turn.state === "claimed");
    if (waiting) return { ...base, activity: "queued", activityAt: waiting.acceptedAt };
    /**
     * A THIRD FILE READ, AND IT CLOSES A HOLE THE CONTRACT ALREADY NAMED.
     *
     * `TaskKind` says a background task "continues after the turn that started
     * it settles. This is why a session can be 'still working' with no active
     * turn" — and until this read existed, every one of those sessions reported
     * `idle`. The queue was empty, so the row went quiet while the work went on.
     *
     * `livenessOf` IS THE CONTRACT'S OWN FOLD, not a second one written here,
     * for the reason stated on it: the sidebar pill, the session list and the
     * notification policy all need the same answer, and three independent folds
     * over task state is three answers that disagree under load.
     */
    const tasks = [...this.readTasks(session.id).values()];
    const live = livenessOf(tasks);
    if (live) {
      // Dated by the OLDEST live task, matching the blocked path above: the
      // number worth showing is how long this has been going, not when the most
      // recent thing joined it.
      const since = Math.min(...tasks.filter(isLiveTask).map((task) => task.startedAt));
      return { ...base, activity: live === "working" ? "working" : "monitoring", activityAt: since };
    }
    // `activityAt` is deliberately absent on idle: there is no event to date.
    // How long ago the session last did anything is `updatedAt`, which every
    // caller already has.
    return { ...base, activity: "idle" };
  }

  /**
   * Every readable session on this engine, newest first.
   *
   * EXTRACTED SO TWO CALLERS SHARE ONE SCAN rather than one of them growing a
   * second copy of it. `listSessions` wants a project's; `ensureMasterSession`
   * wants the one that has NO project, which the project-scoped reader cannot
   * express — it validates a project id before it looks at anything.
   *
   * AN UNREADABLE SESSION IS SKIPPED, NOT THROWN. One corrupt directory must not
   * blank a sidebar; that is the same tolerance the spool store's reader takes
   * for the same reason.
   */
  private readSessions(): Session[] {
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
          return [this.getSession(entry.name)];
        } catch (error) {
          if (error instanceof EngineStateError && error.code === "not_found") return [];
          throw error;
        }
      })
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  listSessions(projectId: string): Session[] {
    this.getProject(projectId);
    return this.readSessions().filter((session) => session.projectId === projectId);
  }

  /**
   * EVERY LIVE SESSION ON THIS ENGINE, across every project, with the project
   * registry beside it.
   *
   * ONE READ AND NOT ONE PER PROJECT, for the reason the spool's snapshot gives:
   * a caller that fetched the projects and then each project's sessions would
   * be composing one answer out of reads taken at different instants, with no
   * way to tell staleness from truth. The `sessions` toolkit needs both halves
   * on every call anyway — a project id is what `sessions_create` takes.
   *
   * LIVE MEANS `state: "active"`. An archived session is finished; listing it
   * would make the toolkit's own budget sentence unverifiable, because the
   * count the store refuses on is exactly this filter.
   *
   * NO BRANCH DERIVATION, unlike `listProjects`: that costs a `git rev-parse`
   * per project and nothing in this answer renders a branch.
   */
  liveSessions(): { sessions: Session[]; projects: Array<{ id: string; name: string }> } {
    const registry = readJson(this.paths.projects);
    const projects = registry === undefined ? [] : parseRegistry(registry).projects;
    return {
      sessions: this.readSessions().filter((session) => session.state === "active"),
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
    };
  }

  turns(sessionId: string): Turn[] {
    this.getSession(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  /**
   * THE NEWEST `limit` TURNS, and everything filed under them — t3code's
   * windowed thread snapshot. A 70-turn session is megabytes of settled
   * items a reader opening on its tail will never scroll to; the window is
   * what makes opening cost what the tail costs, and `before` is how the
   * reader asks for the page above it.
   *
   * Every UNSETTLED turn rides along regardless of the window: the queue
   * strip, "is this session working", and the send path all read turns, and
   * a queued message hidden behind a page would be a message the composer
   * did not know it had. `page.before` is the oldest settled turn in the
   * window; `null` once the page reaches the session's first turn.
   *
   * Pages are read by turn position in queue order (append order), so the
   * cursor is just a runId — no timestamp ties, no index.
   */
  snapshotWindow(sessionId: string, window: { limit: number; before?: string }): {
    turns: Turn[];
    items: Item[];
    tasks: Task[];
    page: { before: string | null; more: boolean };
  } {
    this.getSession(sessionId);
    const all = this.readQueue(sessionId).turns;
    let end = all.length;
    if (window.before !== undefined) {
      end = all.findIndex((turn) => turn.runId === window.before);
      if (end === -1) throw new EngineStateError("not_found", "page cursor names no turn in this session");
    }
    const settled = all.slice(0, end).filter((turn) => !ACTIVE_TURN_STATES.has(turn.state));
    const start = Math.max(0, settled.length - window.limit);
    const paged = settled.slice(start);
    // The active tail is never paged out — but only on the FIRST page; an
    // older page is history and must not repeat rows the client already has.
    const active = window.before === undefined ? all.filter((turn) => ACTIVE_TURN_STATES.has(turn.state)) : [];
    const chosen = new Set([...paged, ...active].map((turn) => turn.runId));
    const turns = all.filter((turn) => chosen.has(turn.runId));
    return structuredClone({
      turns,
      items: [...this.readItems(sessionId).values()].filter((item) => chosen.has(item.runId)),
      tasks: [...this.readTasks(sessionId).values()].filter((task) => chosen.has(task.runId)),
      page: { before: start > 0 ? (paged[0]?.runId ?? null) : null, more: start > 0 },
    });
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
    input: { runId: string; input: string; kind?: "message" | "compact"; model?: TurnModelSelection; attachments?: string[] },
  ): { turn: Turn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.input);
    const kind = input.kind === "compact" ? "compact" : undefined;
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
    /**
     * ONE COMPACTION AT A TIME. The gesture is idempotent in meaning — "squeeze
     * the context" — so a second press while the first is queued or running
     * has nothing to add, and letting it through is how one session ended up
     * with three "/compact" turns in a row.
     */
    if (kind === "compact" && queue.turns.some((turn) => turn.kind === "compact" && ACTIVE_TURN_STATES.has(turn.state))) {
      throw new EngineStateError("conflict", "a compaction is already queued or running on this session");
    }
    const at = this.now();
    const turn: Turn = {
      runId: input.runId,
      sessionId,
      sequence: queue.nextSequence++,
      input: input.input,
      ...(kind ? { kind } : {}),
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
    // Queueing a message is a human saying they are not done with this after
    // all, so any shelf or snooze it was under is lifted.
    this.wakeSessionForNewWork(sessionId);
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
      /**
       * THIS PROJECT'S SERVERS OVER THE GLOBAL ONES, then filtered to the
       * enabled ones. Both halves happen HERE rather than in the worker so each
       * rule lives in exactly one place: a worker trusted to skip the disabled
       * ones, or to work out which scope wins, would be a second copy of a
       * decision that has to be identical every time.
       */
      const registered = resolveMcpServers(this.listMcpServers(), session.projectId);
      /**
       * TELAR'S OWN COMPUTER USE (cua-driver, or Sky as a fallback). Injected
       * at claim time like everything else here, and re-resolved per claim so
       * installing or removing the driver applies to the next turn rather than
       * the next daemon. Goes to both providers when the backend is cua, Claude
       * only when it is Sky — see `withComputerUse`. Absent installs inject
       * nothing, silently, and the unfiltered `registered` list means a user's
       * own entry (even a DISABLED one) is a decision this must not overrule.
       */
      const mcpServers = withComputerUse(
        registered.filter((server) => server.enabled),
        registered,
        session.driver,
        this.computerUse?.(),
      );
      /**
       * Resolved at CLAIM TIME like everything else here, and never omitted:
       * a session whose instance was deleted still has to run, so this falls
       * back to the driver's built-in slot rather than handing the worker
       * nothing.
       */
      const providerInstance = this.resolveProviderInstance(session.providerInstanceId, session.driver);
      return {
        sessionId: session.id,
        projectRoot: session.workspace.path,
        driver: session.driver,
        providerInstanceId: session.providerInstanceId,
        providerInstance,
        // Resolved HERE, at claim time, so a model changed mid-session applies
        // to the next turn the worker picks up rather than to the one it is
        // already running.
        ...(model ? { model } : {}),
        // Filtered to the enabled ones in the engine, so "disabled" is decided
        // in exactly one place rather than trusted to every worker.
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        /**
         * The project's NAME, for the spool toolkit's scoping — a spool item's
         * `project` is a free-form LABEL, so a session's slice is found by
         * comparing names rather than ids.
         *
         * READ OFF THE REGISTRY HERE because the worker holds no store handle,
         * which is the same reason `projectRoot` and `model` are resolved on
         * this claim. A project that has since been deregistered leaves this
         * absent, and the toolkit then reports its scope as "all projects" — the
         * honest answer for a session whose project no longer exists, and
         * visibly different from an empty slice.
         */
        ...(() => {
          const name = this.listProjects().find((p) => p.id === session.projectId)?.name;
          return name ? { project: name } : {};
        })(),
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
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    const projection = { items: this.readItems(sessionId), tasks: this.readTasks(sessionId), tasksTouched: false, turnTouched: false };
    for (const observation of parsed.data) {
      this.journalObservation(sessionId, turn, observation, projection);
    }
    this.writeItems(sessionId, projection.items);
    // Most batches carry no task at all — a rewrite per batch would be a file
    // write per streamed provider message for nothing. Same rule for the
    // queue: only a `provider.session` observation ever mutates the turn.
    if (projection.tasksTouched) this.writeTasks(sessionId, projection.tasks);
    if (projection.turnTouched) this.writeQueue(sessionId, queue);
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
    const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
    this.writeQueue(sessionId, queue);
    this.closeOrphanedTasks(sessionId, turn.runId, at, "the turn ended before this agent reported back");
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
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
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
    const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
    this.writeQueue(sessionId, queue);
    // A failed turn means the provider process died — background shells died
    // with it, whichever turn started them.
    this.closeLiveTasks(sessionId, at, "the turn failed before this agent reported back", { includeBackground: true });
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    return structuredClone(turn);
  }

  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    const queue = this.readQueue(sessionId);
    const turn = requestedRunId
      ? queue.turns.find((candidate) => candidate.runId === requestedRunId)
      : queue.turns.find((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "running");
    if (!turn || turn.state === "stopped" || turn.state === "ambiguous" || (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running")) {
      // NOTHING RUNNING, but Stop was pressed: the only thing left to stop is
      // lingering background work. Settle it — this is also the retroactive
      // cure for tasks orphaned before the sweeps below existed, which
      // otherwise report "monitoring" forever with a Stop that no-ops.
      const swept = this.stopBackgroundTasks(sessionId);
      return { ...(turn ? { turn: structuredClone(turn) } : {}), stopped: swept > 0 };
    }
    const at = this.now();
    turn.state = "stopped";
    turn.completedAt = at;
    turn.updatedAt = at;
    const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
    this.writeQueue(sessionId, queue);
    // STOPPING A TURN SPARES BACKGROUND WORK. Since the session runtime
    // landed (#126) a turn Stop is the provider's own `interrupt()`, declared
    // with `perTaskStopAffordance` so the live process — and every background
    // shell inside it — survives the interrupt. So only the turn's own agents
    // are closed here, whether or not it was live; a background task keeps
    // running and is stopped through its own path (`stopBackgroundTasks`). The
    // pre-runtime code closed background tasks here because the stop killed the
    // process; that assumption no longer holds.
    this.closeOrphanedTasks(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    return { turn: structuredClone(turn), stopped: true };
  }

  /**
   * SEND NOW: promote a queued turn into the RUNNING one.
   *
   * `promoteTurn` is a promise of NOT-LOSING, never of delivery: the turn goes
   * `steering`, the worker hears about it on its next heartbeat, and if the
   * running turn settles first the sweep in the terminal transitions puts the
   * message back to `queued`, where it runs as an ordinary next turn.
   *
   * REFUSED WHILE THE PROVIDER COMPACTS. Codex rejects a steer during
   * compaction at the protocol level ("cannot steer a compact turn"), so the
   * engine refuses up front rather than discovering it as a failed delivery —
   * and the client disables the button for the same reason, so all three tell
   * one story.
   */
  promoteTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be sent now");
    const running = queue.turns.find((candidate) => candidate.state === "running" && candidate.claim);
    if (!running) throw new EngineStateError("conflict", "no turn is running to send this into");
    const compacting = [...this.readItems(sessionId).values()].some(
      (item) => item.runId === running.runId && item.detail.type === "context_compaction" && item.status === "inProgress",
    );
    if (compacting) {
      throw new EngineStateError("conflict", "the provider is compacting its context and cannot take a message right now");
    }
    const at = this.now();
    turn.state = "steering";
    turn.steer = { intoRunId: running.runId, requestedAt: at };
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.steering", intoRunId: running.runId }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * The worker's half of delivery: the text is in the driver's mailbox.
   * IDEMPOTENT — a retried ack after a dropped response returns the already-
   * steered turn rather than a conflict, because the provider has the words
   * either way and the record must not lie about that.
   */
  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Turn {
    assertId(steerRunId, "run id");
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === steerRunId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state === "steered") return structuredClone(turn);
    if (turn.state !== "steering" || !turn.steer) {
      throw new EngineStateError("conflict", "turn is not being steered");
    }
    const running = queue.turns.find((candidate) => candidate.runId === turn.steer!.intoRunId);
    if (!running || running.state !== "running" || running.claim?.token !== claimToken) {
      throw new EngineStateError("conflict", "the running turn is not held by this claim");
    }
    const at = this.now();
    turn.state = "steered";
    turn.steer.deliveredAt = at;
    turn.completedAt = at;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.steered", intoRunId: turn.steer.intoRunId }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * THE NOT-LOSING GUARANTEE. Every terminal transition of a running turn
   * calls this: any `steering` turn still pointing at it was never delivered,
   * and goes back to `queued` to run as its own turn. Mutates the queue the
   * caller is about to write; the caller appends the events after its own, so
   * the journal reads settlement-then-requeue.
   */
  private requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    const reverted: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.state !== "steering" || turn.steer?.intoRunId !== runId) continue;
      turn.state = "queued";
      delete turn.steer;
      turn.updatedAt = at;
      reverted.push(turn);
    }
    return reverted;
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
    this.closeOrphanedTasks(sessionId, turn.runId, at, "the turn was discarded before this agent reported back");
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

    // A WORKTREE IMPLIES A PROJECT, and checking both is how that stays true
    // rather than assumed: a project-less session (the Spool's master) is always
    // `local`, because a worktree is cut from a project's repository and it has
    // none. Reading the pair together means a future project-less session that
    // somehow carried a worktree degrades to "leave the directory" instead of
    // throwing on a lookup that cannot succeed.
    if (session.workspace.mode === "worktree" && session.projectId) {
      const project = this.getProject(session.projectId);
      // Best-effort. A leaked directory is bounded inside the engine's own
      // root and is reapable later; refusing to archive because git was
      // unhappy would strand the session in a state a human cannot leave.
      removeSessionWorktree(this.git, project.root, session.workspace.path);
    }
    const at = this.now();
    session.state = "archived";
    session.updatedAt = at;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.archived" });
    return structuredClone(session);
  }

  /**
   * REMOVE A SESSION AND EVERYTHING IT OWNS. There is no undo.
   *
   * WHY THIS EXISTS AT ALL, given `archiveSession` beside it: archiving and
   * settling were two names for "off my list", and a cockpit that offers both
   * spends a chip, a menu item and a lifecycle field insisting they differ.
   * Settling is now the only way to put a session down. So the other end of the
   * lifecycle has to be real — you cannot retire a concept whose only exit was
   * the thing you removed — and "delete" that leaves the record behind is the
   * dishonest version of exactly that.
   *
   * WHAT IT TAKES WITH IT: the browser (or Chromium instances accumulate until
   * the pool's LRU evicts them, hundreds of megabytes on a machine running
   * detached work), the worktree, and the session's own directory — metadata,
   * queue, journal, items, requests, attachments.
   *
   * WHAT IT REFUSES: a session with a turn in flight, for `archiveSession`'s
   * reason and more sharply. Archiving under a running turn pulls the checkout
   * out from under a live provider process; deleting under one also removes the
   * journal that process is still appending to. Stop it first.
   *
   * THE WORKTREE REMOVAL IS BEST-EFFORT AND THE DIRECTORY REMOVAL IS NOT. A
   * leaked worktree is bounded inside the engine's root and reapable later, so
   * git being unhappy must not strand a session nobody can delete. A partly
   * removed session directory is the opposite: it would parse as corruption on
   * the next read, so it either goes or the call fails with it intact.
   */
  deleteSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    const active = this.readQueue(sessionId).turns.find(
      (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
    );
    if (active) throw new EngineStateError("conflict", "session has an active turn; stop it before deleting");

    void this.browser?.release(sessionId, "session deleted");

    // See `archiveSession` for why the project is checked beside the mode.
    if (session.workspace.mode === "worktree" && session.projectId) {
      const project = this.getProject(session.projectId);
      removeSessionWorktree(this.git, project.root, session.workspace.path);
    }

    // The event is appended BEFORE the directory goes, so a subscriber watching
    // this session is told why its stream ended rather than simply losing it.
    this.appendEvent(sessionId, { type: "session.archived" });
    fs.rmSync(sessionDir(this.paths, sessionId), { recursive: true, force: true });
    return true;
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

  /**
   * Promoted turns waiting for this worker's running turns, the same shape of
   * query as `resolutionsForWorker` and riding the same heartbeat: the worker
   * pushes the text into the driver's mailbox, THEN acks — duplication over
   * loss, see the worker's mailbox note.
   */
  steerForWorker(workerId: string): WorkerStatus["steer"] {
    assertId(workerId, "worker id");
    return this.allSessions().flatMap((session) => {
      const queue = this.readQueue(session.id);
      const claimed = new Map(
        queue.turns
          .filter((turn) => turn.claim?.workerId === workerId && turn.state === "running")
          .map((turn) => [turn.runId, turn.claim!.token] as const),
      );
      if (claimed.size === 0) return [];
      return queue.turns.flatMap((turn) => {
        if (turn.state !== "steering" || !turn.steer) return [];
        const claimToken = claimed.get(turn.steer.intoRunId);
        if (!claimToken) return [];
        return [
          {
            sessionId: session.id,
            runId: turn.steer.intoRunId,
            claimToken,
            steerRunId: turn.runId,
            text: turn.input,
            // The attachments ride with the words — a steered image used to be
            // stored here and never delivered.
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          },
        ];
      });
    });
  }

  readEvents(sessionId: string, after = 0): EngineEvent[] {
    this.getSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    return readJournal(eventsFile(this.paths, sessionId)).filter((event) => event.id > after);
  }

  /**
   * The id of the last event on the journal — "now", for a client that wants
   * to tail from the snapshot it just read rather than replay from zero.
   * Journals are append-only with strictly increasing ids, so the last complete
   * line is the answer; only its tail is read.
   */
  eventCursor(sessionId: string): number {
    this.getSession(sessionId);
    return lastEventId(eventsFile(this.paths, sessionId));
  }

  recover(): { requeued: string[]; ambiguous: string[] } {
    const requeued: string[] = [];
    const ambiguous: string[] = [];
    for (const session of this.allSessions()) {
      const queue = this.readQueue(session.id);
      /**
       * FIRST, THE TASKS THAT WERE ALREADY STRANDED.
       *
       * `closeOrphanedTasks` runs at each terminal turn transition from here
       * on, but a session whose turn ended before that existed still holds an
       * `agent` at `running` — one dogfood session had one weeks old. Nothing
       * revisits a terminal turn, so without this those never close, and a
       * session's activity (which now reads task state) would report `working`
       * for the rest of its life.
       *
       * Keyed on the TURN being terminal rather than on a timestamp: an agent
       * whose turn is still queued or running is not stranded, it is waiting.
       */
      for (const turn of queue.turns) {
        if (turn.state === "queued" || turn.state === "claimed" || turn.state === "running") continue;
        this.closeOrphanedTasks(session.id, turn.runId, this.now(), "the turn ended before this agent reported back");
      }
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
          // Same reasoning as `recoverInactiveWorker`: the process that was
          // running these agents did not survive the restart, whatever we
          // eventually decide about the turn itself.
          this.closeOrphanedTasks(session.id, turn.runId, at, "the engine restarted while this agent was running");
          // BACKGROUND WORK DIES WITH ITS PROCESS TOO — the same position
          // `failTurn` and a live stop already take: outliving its TURN is the
          // definition of background, outliving its PROCESS is impossible.
          // Unfiltered by runId for the same reason theirs is ("whichever turn
          // started them"): the dead CLI hosted every shell of the session. A
          // session that was idle-with-monitoring at the restart is left
          // alone — no turn was running, so no process of ours died.
          this.closeLiveTasks(session.id, at, "the process that owned this task is gone", { includeBackground: true, onlyBackground: true, state: "stopped" });
          changed = true;
        } else if (turn.state === "steering") {
          // Delivery is unknowable across a restart; requeue is the side the
          // channel is built to err on (duplication over loss).
          turn.state = "queued";
          delete turn.steer;
          turn.updatedAt = at;
          requeued.push(turn.runId);
          recoveryEvents.push({ type: "turn.requeued", runId: turn.runId });
          changed = true;
        }
      }
      if (changed) {
        this.writeQueue(session.id, queue);
      }
      if (changed || metadataChanged) {
        if (changed && !metadataChanged) this.touchSession(session.id, at);
        else atomicWrite(sessionMetadataFile(this.paths, session.id), storedSession(session));
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
          // The WORKER is what was running these, and it is gone. Whether the
          // turn reached the provider is still undecided; whether its agents
          // are still running is not.
          this.closeOrphanedTasks(session.id, turn.runId, at, "the worker running this agent disappeared");
          // And the CLI process was the worker's child, so the session's
          // background work is gone with it — process-death, not turn-end,
          // which is why `completeTurn` still leaves background alone.
          this.closeLiveTasks(session.id, at, "the process that owned this task is gone", { includeBackground: true, onlyBackground: true, state: "stopped" });
          // A promoted message aimed at this turn was never delivered by the
          // vanished worker; back to the queue rather than gone.
          for (const reverted of this.requeueUndeliveredSteers(queue, turn.runId, at)) {
            requeued.push(reverted.runId);
            this.appendEvent(session.id, { type: "turn.requeued", reason: "worker_unavailable" }, reverted.runId);
          }
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
      /**
       * NAME THE ACTUAL SITUATION. The right claim token against a settled
       * turn is not a foreign worker — it is THIS turn's provider reporting
       * late (a tool call still running when the turn completed). The code
       * stays `conflict` deliberately: the worker's settle paths key off that
       * code to drop late reports instead of failing the turn, and a new code
       * would turn every late report into a spurious `turn.failed`. The
       * message is what changes, so a daemon log reads as "late", not as a
       * claim mix-up. Late observations are REFUSED rather than accepted
       * within a grace window: a terminal turn is immutable — recovery,
       * projections and tailing clients all rely on nothing landing after
       * `turn.completed` — and the driver now holds the turn open until its
       * tool calls settle, which removes the systematic case. What remains is
       * a true race measured in milliseconds, not worth weakening the
       * invariant for.
       */
      const settled = turn.state === "completed" || turn.state === "failed";
      if (settled && turn.claim?.token === claimToken) {
        throw new EngineStateError("conflict", `turn has already settled (${turn.state}); this report arrived after the turn ended`);
      }
      throw new EngineStateError("conflict", "turn is not running under this worker claim");
    }
    return turn;
  }

  private touchSession(sessionId: string, at: number, resumeCursor?: string): void {
    const session = this.getSession(sessionId);
    session.updatedAt = at;
    if (resumeCursor !== undefined) session.resumeCursor = resumeCursor;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), storedSession(session));
  }

  /**
   * A SHELVED SESSION THAT GETS NEW WORK COMES BACK ON ITS OWN.
   *
   * The one rule that keeps settling from becoming a place things get lost. A
   * user settles a session meaning "I am done with this for now"; queueing a
   * message to it means they are not, and leaving it shelved would hide a
   * conversation that is actively running. The snooze goes with it for the same
   * reason — you cannot both be ignoring something until tomorrow and be typing
   * at it.
   *
   * NOT THE SAME AS "THE AGENT DID SOMETHING". Only work a HUMAN queued clears
   * these; a sub-agent finishing, or a background shell exiting, is exactly the
   * kind of noise a person settled the row to stop hearing about. Clients still
   * raise a snoozed row's hand for things that outrank a snooze — that is a
   * question about presentation and it is answered on their side.
   */
  private wakeSessionForNewWork(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.settledOverride === undefined && session.snoozedUntil === undefined) return;
    delete session.settledOverride;
    delete session.settledAt;
    delete session.snoozedUntil;
    delete session.snoozedAt;
    atomicWrite(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.updated", session });
  }

  /** Prefer metadata, but let a completed durable turn heal an interrupted metadata write. */
  private resumeCursorFor(session: Session): string | undefined {
    if (session.resumeCursor) return session.resumeCursor;
    const recovered = latestProviderSessionId(this.readQueue(session.id));
    if (!recovered) return undefined;
    session.resumeCursor = recovered;
    session.updatedAt = this.now();
    atomicWrite(sessionMetadataFile(this.paths, session.id), storedSession(session));
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
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
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
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid task projection");
    return new Map(parsed.data.map((task) => [task.id, task]));
  }

  private writeTasks(sessionId: string, tasks: Map<string, Task>): void {
    atomicWrite(tasksFile(this.paths, sessionId), { version: STATE_VERSION, tasks: [...tasks.values()] });
  }

  /**
   * A TURN THAT ENDED TAKES ITS SUB-AGENTS WITH IT.
   *
   * The driver already does this on its own happy path, and its comment says
   * exactly why: "a sub-agent stuck at `running` makes a finished detached
   * session claim it is still busy — forever, with no live stream to correct it
   * and nothing for a human to stop." What it could not cover is every OTHER
   * way a turn ends. A turn adjudicated by a human after recovery has no driver
   * attached; neither has one stopped from the cockpit, or one the engine
   * declared ambiguous when a worker vanished.
   *
   * FOUND BY AUDIT, IN REAL DATA: one dogfood session had an `agent` task
   * sitting at `running` weeks after its turn was discarded — the roster showed
   * a live sub-agent that no process anywhere was running.
   *
   * A BACKGROUND TASK IS LEFT ALONE. Outliving its turn is the definition of
   * background, and the contract says so on `TaskKind`.
   *
   * Idempotent, so calling it on a path the driver already swept is a no-op
   * rather than a second event.
   */
  private closeOrphanedTasks(sessionId: string, runId: string, at: number, failure: string): void {
    this.closeLiveTasks(sessionId, at, failure, { runId, includeBackground: false });
  }

  /**
   * A BACKGROUND TASK CANNOT OUTLIVE THE PROVIDER PROCESS. Outliving its TURN
   * is the definition of background — but when the process that hosts it dies
   * (a stop, a failure, a vanished worker), there is nothing left running,
   * and a task left at `running` makes the session claim "monitoring" forever
   * with nothing for a human to stop. Found in real data: a stopped turn's
   * background shell sat live for two days, and the Stop button no-opped
   * because no turn was running.
   *
   * Returns how many tasks it closed, so a stop with no stoppable turn can
   * still report that it did something.
   */
  private closeLiveTasks(
    sessionId: string,
    at: number,
    failure: string,
    options: { runId?: string; includeBackground: boolean; onlyBackground?: boolean; state?: "failed" | "stopped" },
  ): Task[] {
    const tasks = this.readTasks(sessionId);
    const closedTasks: Task[] = [];
    for (const [id, task] of tasks) {
      if (options.runId !== undefined && task.runId !== options.runId) continue;
      // `isBackgroundWork`, not `kind`: an agent launched detached outlives
      // its turn exactly as a shell does, and was being swept here as failed
      // while it was still reporting.
      if (!options.includeBackground && isBackgroundWork(task)) continue;
      if (options.onlyBackground && !isBackgroundWork(task)) continue;
      if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
      // `failed` RATHER THAN `stopped` by default, matching the driver's own
      // choice for the same situation: two spellings for one cause would
      // render as two different colours in the roster depending on which
      // path got there. A human-initiated sweep passes `stopped` — there the
      // cause IS a stop.
      const closed: Task = { ...task, state: options.state ?? "failed", failure, updatedAt: at, completedAt: at };
      tasks.set(id, closed);
      this.appendEvent(sessionId, { type: "task.completed", task: closed }, task.runId);
      closedTasks.push(closed);
    }
    if (closedTasks.length > 0) this.writeTasks(sessionId, tasks);
    return closedTasks;
  }

  /**
   * STOP THE SESSION'S LINGERING BACKGROUND TASKS — the "N tasks still
   * working" chip's Stop. Distinct from `stopTurn`: a background task outlives
   * its turn, so there may be no turn to stop, and stopping the turn would be
   * the wrong verb even if there were one. Marks each task `stopped` in the
   * projection (so the roster is right at once) AND queues the actual process
   * kill for the worker holding the runtime. Returns how many it stopped.
   */
  stopBackgroundTasks(sessionId: string): number {
    const at = this.now();
    const closed = this.closeLiveTasks(sessionId, at, "stopped from the cockpit", {
      includeBackground: true,
      onlyBackground: true,
      state: "stopped",
    });
    if (closed.length === 0) return 0;
    const pending = this.pendingStopTasks.get(sessionId) ?? new Set<string>();
    for (const task of closed) if (task.providerTaskId) pending.add(task.providerTaskId);
    if (pending.size > 0) this.pendingStopTasks.set(sessionId, pending);
    this.touchSession(sessionId, at);
    return closed.length;
  }

  /**
   * The pending background-task kills, drained. Rides the heartbeat like
   * `cancel` — but drain-on-read rather than derived-from-state, because once
   * the projection is `stopped` there is nothing left in the durable state to
   * re-derive the intent from. A single embedded worker holds every runtime,
   * so this broadcasts to the caller rather than routing by worker; the worker
   * whose runtime lacks the session simply no-ops.
   */
  drainStopTasks(): WorkerStatus["stopTask"] {
    const drained: WorkerStatus["stopTask"] = [];
    for (const [sessionId, providerTaskIds] of this.pendingStopTasks) {
      for (const providerTaskId of providerTaskIds) drained.push({ sessionId, providerTaskId });
    }
    this.pendingStopTasks.clear();
    return drained;
  }

  private readRequests(sessionId: string): Map<string, EngineRequest> {
    const stored = readJson(requestsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = RequestSchema.array().safeParse((stored as { requests?: unknown }).requests);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid request projection");
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
    projection: { items: Map<string, Item>; tasks: Map<string, Task>; tasksTouched: boolean; turnTouched: boolean },
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
    if (observation.kind === "provider.session") {
      /**
       * PERSISTED WHILE THE TURN STILL RUNS, which is the whole point: a turn
       * that is later STOPPED never reaches `completeTurn`, and before this
       * observation existed that stop erased the session's continuity — the
       * next turn started a fresh provider session. `completeTurn`'s own
       * write remains the authoritative end-of-turn value; this is the early
       * copy that survives an abort. No journal event: the id is metadata,
       * not something a transcript reader scrolls past.
       */
      turn.providerSessionId = observation.providerSessionId;
      projection.turnTouched = true;
      this.touchSession(sessionId, at, observation.providerSessionId);
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
      /**
       * BY CONTRACT ID, THEN BY PROVIDER ID. A task announced in one turn
       * under `task_<tool_use_id>` is reported on in a LATER turn by the
       * CLI's `task_notification`, which carries `task_id` and no
       * `tool_use_id` — so that turn's driver mints `task_<task_id>` for the
       * same shell. Measured on session_7657b2ef…: monitor b7ohaj89n ended as
       * `task_toolu_01FD…` (background, stopped) and was then re-created as
       * `task_b7ohaj89n` (agent, completed) — a second row, on the Agents
       * surface, for a shell that was already closed. The provider id is the
       * one handle both turns share.
       */
      const known =
        projection.tasks.get(seed.id) ??
        (seed.providerTaskId ? [...projection.tasks.values()].find((task) => task.providerTaskId === seed.providerTaskId) : undefined);
      /**
       * THE FIRST ENDING IS THE ENDING — the driver's own rule (`emitTask`),
       * restated at the store because the store outlives the driver's
       * turn-scoped memory. A task this store already closed (a sweep, a
       * stop) can be reported on again by a LATER turn's driver, which never
       * heard of the closing: a backgrounded agent's progress lines arrive
       * through the next turn's pump. Without this the fold spread the closed
       * record under a `running` seed and produced a row that was running
       * AND carried a failure — red, spinning, and wrong twice.
       */
      const settled = known !== undefined && (known.state === "completed" || known.state === "failed" || known.state === "stopped");
      const state = settled ? known.state : seed.state;
      const terminal = state === "completed" || state === "failed" || state === "stopped";
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
        // The row's own id, when a provider-id match found one: the later
        // turn's minted id names the same shell and must not open a second row.
        id: known?.id ?? seed.id,
        /**
         * THE FIRST CLASSIFICATION IS THE CLASSIFICATION, for the same reason
         * `runId` and `startedAt` below take the stored value: kind is a fact
         * about what a task IS, and nothing that happens later changes it.
         *
         * It cannot be `?? `-ed against an absent field, because `TaskSeed.kind`
         * is required — a provider seam with nothing to say still has to say
         * something, and the contract's denylist posture makes that "agent"
         * (protocol/tasks.ts). The Claude seam's `knownTasks` is TURN-SCOPED, so
         * a backgrounded shell reaped at teardown is reported in the FOLLOWING
         * turn by a `task_notification` carrying no `task_type`, against a map
         * that has never heard of it. Taking the seed there moved every such
         * shell onto the Agents surface — a delegate that never reported, next
         * to a killed process reading as a clean "Done".
         */
        kind: known?.kind ?? seed.kind,
        state,
        sessionId,
        // A background task belongs to the turn that STARTED it even after that
        // turn settles, which is the whole meaning of background.
        runId: known?.runId ?? turn.runId,
        startedAt: known?.startedAt ?? at,
        updatedAt: at,
        ...(settled ? { completedAt: known.completedAt ?? at } : terminal ? { completedAt: at } : {}),
      };
      projection.tasks.set(task.id, task);
      projection.tasksTouched = true;
      // The EVENT follows the state, not the message that carried it (the
      // driver's rule again): a late progress line about a settled task is
      // announced as its completion, not as a resumption.
      const announced = observation.kind === "task.started" ? "task.started" : terminal ? "task.completed" : "task.progress";
      this.appendEvent(
        sessionId,
        announced === "task.progress"
          ? { type: "task.progress", task, ...(observation.kind === "task.progress" && observation.message ? { message: observation.message } : {}) }
          : { type: announced, task },
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
      if (processExists(owner.pid ?? -1)) throw new EngineStateError("conflict", "engine state root is already locked");
      const breakerToken = crypto.randomUUID();
      try {
        const descriptor = fs.openSync(breaker, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: breakerToken }));
        fs.closeSync(descriptor);
      } catch (breakError) {
        if ((breakError as NodeJS.ErrnoException).code === "EEXIST") {
          // Another stale-lock breaker owns the compare-and-delete window;
          // never race it by unlinking its freshly acquired daemon lock.
          throw new EngineStateError("conflict", "engine state root is already being recovered");
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
  throw new EngineStateError("conflict", "engine state root is already locked");
}
