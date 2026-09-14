// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import { ExecutionStore } from "./execution-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoResolution,
  PROVIDER_CAPABILITIES,
  DEFAULT_ATTENDED_RUNTIME_MODE,
  DEFAULT_DETACHED_RUNTIME_MODE,
  defaultInstanceIdForDriver,
  isBackgroundWork,
  livenessOf,
  AgentOrientation as AgentOrientationSchema,
  DEFAULT_AGENT_ORIENTATION,
  DEFAULT_INBOX_POLICY,
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_TEXT_GEN_POLICY,
  InboxPolicy as InboxPolicySchema,
  MAX_SIDEBAR_PROJECT_ORDER,
  MAX_SIDEBAR_SESSION_ORDER,
  SessionDefaults as SessionDefaultsSchema,
  SidebarLayout as SidebarLayoutSchema,
  TextGenPolicy as TextGenPolicySchema,
  Item as ItemSchema,
  MAX_AUTO_SETTLE_HOURS,
  MIN_AUTO_SETTLE_HOURS,
  McpServer as McpServerSchema,
  McpServerSpec as McpServerSpecSchema,
  ModelSelection,
  ProviderInstance as ProviderInstanceSchema,
  ProviderInstanceEnvVar as ProviderInstanceEnvVarSchema,
  UsageLimitSource as UsageLimitSourceSchema,
  type UsageLimitSource,
  resolveMcpServers,
  EngineRequest as RequestSchema,
  Project as ProjectSchema,
  DataScienceConfig as DataScienceConfigSchema,
  type DataScienceConfig,
  LatexConfig as LatexConfigSchema,
  applyPluginPatch,
  machineAllows,
  machineSettings,
  pluginEffectivelyEnabled,
  PROJECT_PLUGINS_VERSION,
  ProjectPlugins as ProjectPluginsSchema,
  type ProjectPlugins,
  legacyMirrors,
  MIRRORED_PLUGINS,
  type MirroredPlugin,
  pluginConfigFromLegacy,
  readProjectPlugins,
  assignmentsOf,
  type AssignmentTurn,
  type SessionAssignment,
  type SessionSettledBy,
  type PluginPatch,
  type LatexConfig,
  Session as SessionSchema,
  Subscription as SubscriptionSchema,
  Task as TaskSchema,
  Turn as TurnSchema,
  TurnAttachment as TurnAttachmentSchema,
  TurnObservation as TurnObservationSchema,
  WorkerTurnFailureCode as WorkerTurnFailureCodeSchema,
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
  type GitignoreRemoval,
  type GitignoreResult,
  type AgentOrientation,
  type InboxPolicy,
  type SessionDefaults,
  type SidebarLayout,
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
  type TaskSeed,
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
  type Subscription,
  type Turn,
  type TurnFailure as TurnFailureShape,
  type TurnFailureCode,
  type TurnObservation,
  type WakeKind,
  type WakeReason,
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
import { TELAR_ORIENTATION } from "./orientation";
import { delegationSettle, newestAssignment, type DeliveryTurn } from "./delegation-settling";
import { withComputerUse, type ResolvedComputerUse } from "./computer-use";
import { confirmProjectIcon, confirmProjectIconSync, findProjectIcon, findProjectIconAsync, type ProjectIcon } from "./project-icon";
import { listWorkspaceFiles, listWorkspaceFilesAsync, readWorkspaceFile, readWorkspaceFileAsync, readWorkspaceFileBytes, writeWorkspaceFile } from "./files";
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
import { commitSessionWork, gitOverview, gitOverviewAsync, projectRemoteAsync, sessionDiff, sessionDiffAsync, sessionFilePatch, sessionFilePatchAsync, type GitOverview } from "./git";
import { ensureTelarGitignore, removeTelarGitignore } from "./gitignore";
import { cloneRepository, isCloneFailure } from "./clone";
import { agentNotice } from "./agent-notice";
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
import { applyModelManifest, BUNDLED_MANIFEST, longDefaultOf, normalizeClaudeModel, type ModelManifest } from "./model-manifest";
import { applyModelOverlay } from "./model-overlay";
import { LatexMachineSettings as LatexMachineSettingsSchema } from "./plugins/latex";
import { DataScienceMachineSettings as DataScienceMachineSettingsSchema } from "./plugins/data-science";
import { createSessionWorktree, defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, isGitWorkTree, removeSessionWorktree, type GitRunner } from "./worktree";
import { preflightPython, relativisePythonPath, resolvePythonPath, type PythonPreflight } from "./ds/python-env";
import { planBootstrap, planEnvironment, removeTelarVenv, telarVenvDir, telarVenvPython, type BootstrapRequest, type CreateEnvironmentRequest } from "./ds/telar-venv";
import { discoverEnvironments, environmentId, environmentRootOf, type EnvManager, type PythonEnvironment } from "./ds/environments";
import { adoptBinaryDir, findBinary, toolchainStatus, type Toolchain } from "./ds/toolchain";
import { JobRunner, type JobRead } from "./ds/jobs";
import { canonicalName, declaredDependencies, installCommandFor, installSteps, listPackages, projectRequirements, removeSteps, requirementsStep, type InstallCommand, type PackageInfo, type RequirementsSource } from "./ds/packages";
import type { KernelHost } from "./ds/kernel-host";
import type { DsCapability, EnvironmentRow } from "./ds/capability";
import { DsFiles } from "./ds/state-files";
import { NOTEBOOK_MAX_BYTES, storeDsCapability } from "./ds/store-capability";
import { windowCsv, type TableWindow } from "./ds/table";
import { findLatexBinary, latexToolchainStatus, type LatexToolchain } from "./latex/toolchain";
import { ManagedTectonic, type ManagedTectonicStatus } from "./latex/managed";
import { planLatexBootstrap, type LatexBootstrapRequest } from "./latex/bootstrap";
import { listTexPackages, TECTONIC_PACKAGES_NOTE, texInstallSteps, texRemoveSteps, type LatexPackagesAnswer } from "./latex/packages";
import type { LatexCapability, CompileStatus as LatexCompileMemory } from "./latex/capability";
import { storeLatexCapability } from "./latex/store-capability";
import type { ResolvedLatex } from "./latex/compile";

/** The human-facing one-liner for a parked request's notification. */
/**
 * THE WAKE TEXT — A PING, NOT A REPORT.
 *
 * It begins with `[wake: …]` so a model can tell it from a person, names the
 * peer, the turn and what happened, and then names the ONE call that fetches
 * the detail. It deliberately carries no result body: a wake is injected into
 * the subscriber's context whether or not it needs the answer, and a child that
 * wrote fifty kilobytes used to spend that on every coordinator subscribed to
 * it. The outcome is one `sessions_read(sessionId, runId)` away, and the
 * recipient decides whether it is worth reading.
 *
 * A PARKED REQUEST IS NO EXCEPTION. It names the request, its kind and a short
 * title, and then the two calls: read it, answer it. The fields used to ride
 * the notice so an answer could be composed without a second read — but that
 * made the one notice whose size followed its payload, and a coordinator that
 * is going to answer a question can afford the read it needs to answer it
 * properly. A secret pick is never described beyond its origin: the wall
 * refuses to resolve those, and naming candidates would offer the model
 * something it may not touch.
 */
function wakeMessage(
  kind: WakeKind,
  target: Session,
  turn: Turn,
  context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest },
): string {
  /**
   * THE KIND LEADS. A queue strip truncates a wake to its first few words, and
   * four wakes that all began `[wake] Session session_… "title"` read as four
   * copies of one message — which is what a person saw when a child parked an
   * approval and then finished: two rows, apparently identical, actually two
   * different facts. The verb up front makes them tell apart at a glance.
   */
  const who = `Session ${target.id} "${target.title}"`;
  const lines: string[] = [];
  switch (kind) {
    case "turn_completed": {
      const text = (context.resultText ?? "").trim();
      lines.push(
        `[wake: completed] ${who} — turn ${turn.runId} completed.`,
        // The SIZE, not the text: enough for the recipient to judge whether
        // fetching it is worth the context, and honest about there being
        // nothing to fetch.
        text ? `It answered with ${text.length} characters. The text is not in this notice.` : "It ended with no answer text.",
      );
      break;
    }
    case "turn_failed":
      lines.push(
        `[wake: failed] ${who} — turn ${turn.runId} FAILED${context.failure ? ` (${context.failure.code})` : "."}`,
        ...(context.failure ? [clampWake(context.failure.message)] : []),
      );
      break;
    case "turn_stopped":
      lines.push(`[wake: stopped] ${who} — turn ${turn.runId} was stopped.`);
      break;
    case "request_opened": {
      const request = context.request!;
      lines.push(
        `[wake: waiting] ${who} — is WAITING on a request (request ${request.id}, kind ${request.detail.kind}): ${clampWake(requestTitle(request.detail))}`,
        "—",
        `Read it with sessions_read(sessionId: "${target.id}", runId: "${turn.runId}") — the request's own fields are there. Answer with sessions_resolve_request(sessionId: "${target.id}", requestId: "${request.id}", decision, answers?). Only answer what you actually know; decline or leave it for the user otherwise.`,
      );
      return lines.join("\n");
    }
  }
  lines.push(
    "—",
    // THE RETRIEVAL IS DIRECTLY USABLE, and scoped to this run: a coordinator
    // that wants the outcome should not have to page a journal to find it.
    `Fetch it with sessions_read(sessionId: "${target.id}", runId: "${turn.runId}") — that run's events and its final answer, bounded. Its diff with sessions_diff.`,
  );
  return lines.join("\n");
}

/** One clamped line for a wake. A wake is a ping; nothing in it is a payload. */
function clampWake(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_WAKE_LINE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_WAKE_LINE_CHARS)}… [${trimmed.length - MAX_WAKE_LINE_CHARS} more characters — sessions_read has the rest]`;
}

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

type TurnFailure = TurnFailureShape;

/**
 * WHICH FAILURES A WORKER MAY REPORT — a strict subset of `TurnFailureCode`.
 * `cancelled` is the engine's own word for a stop it already recorded, and
 * `internal_error` is the engine's; a worker claiming either would let a
 * provider crash masquerade as a control-plane decision.
 */
/** The codes a WORKER may report, from the contract's own list rather than a
 *  fourth copy of it — see `WorkerTurnFailureCode`. */
const TURN_FAILURE_CODES = new Set<TurnFailureCode>(WorkerTurnFailureCodeSchema.options);

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
 * How many sessions one session may be subscribed to at once. The file is
 * rewritten whole on every change, and a loop that subscribed forever would
 * make every terminal transition on the engine slower — the same reasoning as
 * `MAX_QUEUED_TURNS`. Sixty-four is far past any honest orchestration.
 */
const MAX_SUBSCRIPTIONS_PER_SESSION = 64;

/** How much of a finished turn's answer rides in the wake that announces it.
 *  The whole answer is one `sessions_read` away; the wake is a summons. */
/**
 * The clamp on any single line a wake carries — a failure message, a request's
 * prompt, a field label. Not a budget for a result: a wake carries no result at
 * all (see `wakeMessage`), and this only keeps a pathological one-liner from
 * becoming the notice.
 */
const MAX_WAKE_LINE_CHARS = 240;

const ALL_WAKE_KINDS: readonly WakeKind[] = ["turn_completed", "turn_failed", "turn_stopped", "request_opened"];

/**
 * THE EVENTS THAT END A TURN — and so the only ones that may consume a
 * one-shot subscription (#240).
 *
 * A `once` subscription means "wake me when the thing I am waiting for is
 * OVER". A `request_opened` is not over: the target parked an approval and is
 * still working, and a subscription spent on it left the coordinator to wait
 * forever for a completion that had nowhere to land. An interim `result` is not
 * over either — see `submitAgentTurn`, which no longer spends the subscription
 * on one.
 */
const TERMINAL_WAKE_KINDS: readonly WakeKind[] = ["turn_completed", "turn_failed", "turn_stopped"];

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
  /** Plugin facts true of this Mac. See `machinePlugins()`. */
  machinePlugins: string;
  /** The Claude default this machine last read from the provider — what a
   *  synchronous claim uses when the in-memory catalogue is cold. */
  claudeDefault: string;
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
  /**
   * Whether Telar may tell an agent where it is — see `AgentOrientation`.
   *
   * ENVIRONMENT-SCOPED, beside inbox.json and for the sharper version of its
   * reason: this decides what every session on the machine is told, so a
   * per-browser copy would mean one engine injecting a paragraph some of its
   * own clients had switched off.
   */
  orientation: string;
  /**
   * The CLIProxyAPI hubs quota is read from — see `listUsageLimitSources`.
   *
   * ENVIRONMENT-SCOPED, beside mcp-servers.json and for the same reason: a hub
   * is configured once and every client reads the same list.
   */
  usageLimitSources: string;
  /**
   * Their management keys, in a file of their own at 0600.
   *
   * SPLIT FOR EXACTLY THE REASON `providerSecrets` IS: the list beside it is
   * handed to a settings page over HTTP, and a key stored on the record would
   * be echoed back to every browser that opened Providers. Keeping them apart
   * makes redaction the default rather than a step somebody has to remember.
   */
  usageLimitSecrets: string;
  /** Which sessions want to be woken by which — engine-wide, because a
   *  subscription spans two sessions and belongs to neither's directory. */
  subscriptions: string;
  /** Who writes generated titles and branch names — see `TextGenPolicy`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  textGen: string;
  /** What a session is created with when nobody said — see `SessionDefaults`.
   *  Environment-scoped like `inbox`, and for the same reason. */
  sessionDefaults: string;
  /** Where each project group sits in the rail — see `SidebarLayout`.
   *  Environment-scoped like `inbox`: one arrangement per engine, not per window. */
  sidebarLayout: string;
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
    /** Plugin facts true of THIS Mac — see `MachinePlugins`. */
    machinePlugins: path.join(resolved, "machine-plugins.json"),
    claudeDefault: path.join(resolved, "claude-default-model.json"),
    sessions: path.join(resolved, "sessions"),
    mcpServers: path.join(resolved, "mcp-servers.json"),
    providerInstances: path.join(resolved, "provider-instances.json"),
    providerSecrets: path.join(resolved, "provider-secrets.json"),
    modelOverlays: path.join(resolved, "model-overlays.json"),
    mcpOAuth: path.join(resolved, "mcp-oauth.json"),
    mcpOAuthPending: path.join(resolved, "mcp-oauth-pending.json"),
    inbox: path.join(resolved, "inbox.json"),
    orientation: path.join(resolved, "orientation.json"),
    usageLimitSources: path.join(resolved, "usage-limit-sources.json"),
    usageLimitSecrets: path.join(resolved, "usage-limit-secrets.json"),
    subscriptions: path.join(resolved, "subscriptions.json"),
    textGen: path.join(resolved, "text-generation.json"),
    sessionDefaults: path.join(resolved, "session-defaults.json"),
    sidebarLayout: path.join(resolved, "sidebar-layout.json"),
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

/** A person configures one or two hubs; the cap is here so a scripted client
 *  cannot turn one usage read into a hundred outbound requests. */
const MAX_USAGE_LIMIT_SOURCES = 16;

/** The shape a route may see: no key, and a flag saying one is held. A free
 *  function so the one place that builds it is the one place that can forget. */
function redactUsageLimitSource(source: UsageLimitSource, secrets: Record<string, string>): UsageLimitSource {
  return { ...source, managementKey: "", ...(secrets[source.id] ? { keyRedacted: true } : {}) };
}

/** The same shape as an instance id, and for the same reason: it rides in a
 *  URL path and is the permanent key a stored key is filed under. */
function assertUsageLimitSourceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new EngineStateError(
      "invalid_request",
      "usage limit source id must start with a letter and contain only letters, numbers, underscores, or hyphens",
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
    enabled: driver !== "opencode",
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

/** "Nobody has arranged anything" — what an unreadable layout document costs.
 *  Spelled once so the three arrangements cannot fall back to different things. */
const blankSidebarLayout = (): SidebarLayout => ({ ...DEFAULT_SIDEBAR_LAYOUT, projectOrder: [], sessionOrder: {}, pinnedOrder: [] });

/** Copied out, never handed out: the caller gets the arrangement, not a
 *  reference into the document this store will write to next. */
const cloneSidebarLayout = (layout: SidebarLayout): SidebarLayout => ({
  projectOrder: [...layout.projectOrder],
  sessionOrder: Object.fromEntries(Object.entries(layout.sessionOrder).map(([key, ids]) => [key, [...ids]])),
  pinnedOrder: [...layout.pinnedOrder],
});

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
): Omit<Session, "activity" | "activityAt" | "lastTurnEndedAt" | "lastTurnFailed" | "lastTurnSequence"> {
  const {
    activity: _activity,
    activityAt: _activityAt,
    // Read off the queue on the same pass as `activity`, and stripped for the
    // same reason: the queue is where the answer lives, so a copy here could
    // only ever be a stale second one.
    lastTurnEndedAt: _lastTurnEndedAt,
    lastTurnFailed: _lastTurnFailed,
    lastTurnSequence: _lastTurnSequence,
    ...stored
  } = session;
  return stored;
}

/** How many errands one row remembers being pulled back off the shelf. The
 *  schema's own bound, so a runaway loop cannot grow the record without end. */
const MAX_UNSETTLED_ASSIGNMENTS = 64;

/**
 * TAKE A DELEGATION SETTLE BACK, AND REMEMBER THAT IT WAS TAKEN — issue #378.
 *
 * The facts an auto-settle is derived from are permanent: the assignment
 * finished, and the coordinator took delivery. So the next evaluation would
 * reach the same conclusion, and a person who un-settled the row would watch it
 * shelve itself again — a control that appears to do nothing. Recording the
 * errand is what makes the un-settle stick, and it is scoped to that errand: a
 * NEW task on the same session settles on its own terms.
 *
 * A NO-OP ON A ROW THE ENGINE NEVER SETTLED, which is almost every row. Nothing
 * is recorded for a person un-settling their own decision — there is no errand
 * in it to disagree about.
 */
function releaseDelegationSettle(session: Session): void {
  const stamp = session.settledBy;
  if (!stamp) return;
  delete session.settledBy;
  const released = session.unsettledAssignments ?? [];
  if (released.includes(stamp.runId)) return;
  // Oldest out first: the errands somebody argued about most recently are the
  // ones a re-settle would be most surprising on.
  session.unsettledAssignments = [...released, stamp.runId].slice(-MAX_UNSETTLED_ASSIGNMENTS);
}

/**
 * The most recently FINISHED turn, whatever it finished as.
 *
 * `completedAt` is the test rather than a list of states, because the states
 * that set it are exactly the states that ended: completed, failed, stopped,
 * discarded and steered all stamp it, and nothing else does. An enumeration
 * here would be a second copy of that fact, and the copy is the one that would
 * fall behind.
 *
 * WHICH IS ALSO WHY THIS IS NOT THE FUNCTION UNREAD IS BUILT ON. "Something
 * ended" and "there is an answer to read" are different questions: a steered
 * turn ends when the human's own words reach the provider, and a discarded one
 * ends because a human dismissed it. See `lastResultTurn`.
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

/** A stored row as the seed a worker may hold: the five engine-minted fields
 *  (`TaskSeed`'s omissions) stripped, so a claim never hands a worker something
 *  it must not mint back. */
function taskSeedOf(task: Task): TaskSeed {
  const { sessionId: _sessionId, runId: _runId, startedAt: _startedAt, updatedAt: _updatedAt, completedAt: _completedAt, ...seed } = task;
  return seed;
}

function lastEndedTurn(turns: readonly Turn[]): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of turns) {
    if (turn.completedAt === undefined) continue;
    if (latest?.completedAt === undefined || turn.completedAt >= latest.completedAt) latest = turn;
  }
  return latest;
}

/**
 * The states that leave A RESULT A HUMAN CAN READ, spelled out on purpose.
 *
 * This one IS an enumeration rather than a `completedAt` test, and the two
 * functions below are why: unread is a claim about what is ON SCREEN, so the
 * set has to be exactly the set the transcript draws as a finished turn. The
 * cockpit filters `steering` and `steered` out of the conversation entirely
 * (a steered message renders inside the turn it was sent into), and neither a
 * steered nor a discarded turn carries an answer.
 *
 * `ambiguous` is excluded too, and deliberately: it is not finished — it is a
 * turn asking a human to decide whether it ever ran — and the recovery card
 * the transcript draws for it is not a result.
 */
function isResultTurn(turn: Turn): boolean {
  return turn.state === "completed" || turn.state === "failed" || turn.state === "stopped";
}

/**
 * The newest turn that left an answer — the one a read receipt may name.
 *
 * CHOSEN BY SEQUENCE, NOT BY `completedAt`, which is the difference that makes
 * the receipt monotonic. Sequence is minted when a turn is accepted and never
 * changes, so "the highest sequence read" can only move forward and a receipt
 * that arrives late (a tab that was scrolled to an old answer, a retry after a
 * dropped response) can never consume a turn that finished after it. Clocks
 * can tie, go backwards over an NTP step, and say nothing about ordering; the
 * one guarantee unread needs is exactly the one the sequence gives.
 */
function lastResultTurn(turns: readonly Turn[]): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of turns) {
    if (!isResultTurn(turn)) continue;
    if (latest === undefined || turn.sequence > latest.sequence) latest = turn;
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

/**
 * Whether a worker could have any business with this queue — see
 * `liveQueueIndex`, whose membership this decides.
 *
 * THE UNION OF FIVE QUERIES, deliberately, so that one index serves all of
 * them and no query can be narrowed without someone noticing here. The first
 * four states are the unsettled ones a claim or a heartbeat acts on. The fifth
 * is the one that is easy to miss: a STOPPED turn keeps its claim (only a
 * discard or a recovery sweep clears it), and reading exactly those is how a
 * worker learns that a human pressed Stop.
 *
 * THE SIXTH IS A FAILED TURN, WHICH IS THE SURPRISING ONE. A turn that failed
 * `rate_limited` is terminal in every other sense, but the sweep has to find it
 * again once its `resumeAt` passes — and this predicate is what decides which
 * sessions the sweep ever looks at. Without it the requeue silently never fires:
 * the session drops out of the index the moment the turn fails, and nothing
 * walks it again until a human types.
 *
 * BOUNDED BY `resumeDecidedAt`. The sweep stamps every rate-limited failure it
 * considers, whether it requeued the turn or left it alone, so a session whose
 * setting is off falls out of the index on the next claim instead of being
 * re-examined for the life of the daemon.
 */
function queueConcernsAWorker(queue: SessionQueue): boolean {
  return queue.turns.some(
    (turn) =>
      turn.state === "queued" ||
      turn.state === "claimed" ||
      turn.state === "running" ||
      turn.state === "steering" ||
      (turn.state === "stopped" && turn.claim !== undefined) ||
      awaitsRateLimitSweep(turn),
  );
}

/** A failed turn the sweep has not yet decided about — see above, and
 *  `sweepRateLimited`, which is the only thing that clears the condition. */
function awaitsRateLimitSweep(turn: Turn): boolean {
  return (
    turn.state === "failed" &&
    turn.failure?.code === "rate_limited" &&
    turn.failure.resumeAt !== undefined &&
    turn.failure.resumeDecidedAt === undefined
  );
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

/**
 * How many open items keep their streamed text in memory at once.
 *
 * Generous for the live case — a turn streams into one or two items at a time,
 * across a handful of concurrently running sessions — and small enough that a
 * long-lived daemon full of stopped turns cannot grow without limit. Evicting
 * costs a journal read, never text.
 */
const OPEN_PREFIX_LIMIT = 64;

/** Item ids are unique within a session, not across them. */
function prefixKey(sessionId: string, itemId: string): string {
  return `${sessionId}\n${itemId}`;
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
  /** Bind a scope to its project's browser profile before a human-started
   *  read opens a tab (the desktop host refuses an unbound scope). */
  bindProfile?(scopeKey: string, profileKey: string): Promise<void>;
  /** One browser tool call on a scope — what `browserOpen` uses to open a tab. */
  call?(scopeKey: string, name: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
};

/**
 * One claim a Stop just killed — the same triple `cancellationsForWorker`
 * returns, plus the worker it belongs to, because this is PUSHED rather than
 * asked for and the receiver has to check the claim is its own.
 */
export type StoppedClaim = { sessionId: string; runId: string; claimToken: string; workerId: string };

export type EngineNotifier = (input: {
  sessionId: string;
  runId: string;
  requestId: string;
  kind: RequestKind;
  title: string;
}) => boolean;

export class EngineStore {
  private executionStore?: ExecutionStore;
  private commandDepth = 0;
  private afterCommit: Array<() => void> = [];
  private readDocument(file: string): unknown | undefined {
    return this.executionStore?.owns(file) ? this.executionStore.read(file) : readJson(file);
  }
  private writeDocument(file: string, value: unknown, mode?: number): void {
    if (this.executionStore?.owns(file)) this.executionStore.write(file, value);
    else atomicWrite(file, value, mode);
  }
  closeExecutionStore(): void { this.executionStore?.close(); }
  executeCommand<T>(command: string, action: () => T, commandId?: string): T {
    if (!this.executionStore) return action();
    this.commandDepth += 1;
    let result: T;
    try { result = this.executionStore.transaction(command, action, commandId); }
    catch (error) {
      this.journalHead.clear(); this.openPrefixes.clear(); this.liveQueueIndex = undefined;
      // Rolled back under this store's feet: anything read or written inside
      // the transaction describes a queue sqlite no longer has.
      this.queueCache.clear(); this.itemsCache.clear(); this.queueChangeAnnounced = false;
      this.pendingStopTasks.clear(); this.afterCommit = [];
      throw error;
    } finally { this.commandDepth -= 1; }
    if (this.commandDepth === 0) {
      const effects = this.afterCommit.splice(0);
      for (const effect of effects) effect();
    }
    return result;
  }

  readonly paths: EngineStatePaths;
  private readonly notifier?: EngineNotifier;
  /** See the constructor: the daemon's in-process nudge to its embedded worker,
   *  absent unless the daemon injected it. */
  private readonly onQueueChanged?: () => void;
  /** See the constructor option: the claims a Stop just killed, handed to the
   *  in-process worker so the abort does not ride a poll. */
  private readonly onTurnsStopped?: (cancellations: StoppedClaim[]) => void;
  /** One announcement per command, not one per `writeQueue` inside it. */
  private queueChangeAnnounced = false;
  /** See the constructor: daemon-injected, absent means no computer use. */
  private readonly computerUse?: (() => ResolvedComputerUse | undefined) | undefined;
  /** See the constructor: the real subprocess handshake unless a test says
   *  otherwise. */
  private readonly readModels: typeof readModelCatalogue;
  private readonly manifest: ModelManifest;
  private readonly git: GitRunner;
  private readonly asyncGit: AsyncGitRunner;
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
  /** What there is to filter by, per project. In memory like every cache here: it
   *  describes somebody else's repository settings. */
  private readonly facetCache = new Map<string, GitHubFacets>();
  /** In memory, like the GitHub cache and for the same reason: it describes
   *  somebody else's installation, which changes without telling us. */
  private readonly modelCache = new Map<ProviderDriverKind, ModelCatalogue>();
  /** In-flight `prepareClaudeCatalogue`, so concurrent claims share one probe. */
  private claudeCataloguePrepare: Promise<void> | undefined;
  /** When the probe last failed — see `prepareClaudeCatalogue`. */
  private claudeCatalogueFailedAt: number | undefined;
  /** The remembered default, cached in memory. `""` means "read, and absent". */
  private claudeDefaultMemo: string | undefined;
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

  /**
   * The last event id this store wrote to each session's journal. Seeded from
   * disk on the first append after construction (see `appendEvent`) and then
   * advanced in memory, which is sound only because the daemon lock makes one
   * process the journal's sole writer. Dropped when the journal is deleted or
   * a write fails, so the next append re-reads and repairs.
   */
  private readonly journalHead = new Map<string, number>();
  /** Text streamed into still-open items, by `session\nitem`. A cache over the
   *  journal's deltas — see `openItemPrefix`. */
  private readonly openPrefixes = new Map<string, { text: string; through: number; sealed: boolean }>();

  attachBrowser(browser: AttachedBrowser): void {
    this.browser = browser;
  }

  /**
   * The daemon's kernel host, attached like the browser and for the same
   * reason: the store must build in a test without spawning Python. Absent
   * means every kernel verb refuses with "no kernel host".
   */
  private kernels?: KernelHost;

  attachKernels(host: KernelHost): void {
    this.kernels = host;
  }

  /** Environment builds and package installs, as jobs the settings page polls. */
  readonly dsJobs = new JobRunner(() => this.now());

  /**
   * THE DATA-SCIENCE DOOR FOR ONE SESSION. Resolves the project's interpreter
   * with the worktree rule, builds the capability over the daemon's kernel
   * host and this store's files, and refuses when the project has not opted
   * in. Every route and every toolkit reaches the kernel through this.
   */
  dataScience(sessionId: string): DsCapability {
    const session = this.getSession(sessionId);
    const resolved = this.resolveDataScience(session);
    if (!resolved) {
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.machinePlugins(), "data-science")
          ? "data science is not enabled for this session's project"
          : "data science is turned off for this Mac",
      );
    }
    if (!this.kernels) throw new EngineStateError("invalid_request", "this engine has no kernel host");
    return storeDsCapability({
      sessionId,
      cwd: session.workspace.path,
      python: resolved.pythonPath,
      telarVenv: telarVenvDir(this.paths.root, session.projectId!, session.workspace.mode === "worktree" ? path.basename(session.workspace.path) : undefined),
      host: this.kernels,
      files: new DsFiles(path.join(sessionDir(this.paths, sessionId), "ds")),
      // A notebook with plots in it passes the editor's 512 KB ceiling in one
      // cell; both fences take the notebook-sized cap instead.
      readFile: (target) => this.readFenced(session.workspace.path, target, "session workspace", NOTEBOOK_MAX_BYTES),
      writeFile: (target, text, expected) => this.writeFenced(session.workspace.path, target, text, expected, "session workspace", NOTEBOOK_MAX_BYTES),
      putAttachment: (input) => this.putAttachment(sessionId, input),
      attachmentBytes: (id) => this.attachmentBytes(sessionId, id).data,
      appendEvent: (event) => { this.appendEvent(sessionId, event); },
      now: () => this.now(),
      // Package operations resolve the environment against THIS session's
      // workspace — the worktree rule again — and run as the store's jobs.
      packages: () => this.dataSciencePackages(session.projectId!, session.workspace.path),
      startInstall: (input) => this.dataScienceInstall(session.projectId!, input as Parameters<EngineStore["dataScienceInstall"]>[1], session.workspace.path),
      waitJob: (jobId, timeoutMs) => this.dsJobs.wait(jobId, timeoutMs),
      environments: async () => ({ environments: await this.dsEnvironmentRows(session.projectId!, session.workspace.path) }),
      useEnvironment: (target) => this.dataScienceUseEnvironment(sessionId, target),
    });
  }

  /**
   * Which interpreter a session runs on, or nothing. THE WORKTREE RULE LIVES
   * HERE AND NOWHERE ELSE: a relative path resolves against the session's own
   * tree, and a worktree missing it gets nothing — never the project root's.
   */
  resolveDataScience(session: Session): { pythonPath: string } | undefined {
    if (!session.projectId) return undefined;
    let project: Project;
    try { project = this.getProject(session.projectId); } catch { return undefined; }
    const config = project.dataScience;
    if (!config?.enabled) return undefined;
    // The machine ceiling, same rule as LaTeX's: off here means unavailable
    // everywhere, and every project keeps what it chose.
    if (!machineAllows(this.machinePlugins(), "data-science")) return undefined;
    /**
     * THE MAC'S DEFAULT INTERPRETER IS A REAL FALLBACK, exactly as its TeX
     * install is — a project that has not chosen one runs on it rather than
     * having no kernel at all.
     *
     * THE MACHINE DEFAULT IS NEVER RESOLVED AGAINST THE WORKTREE. A project's
     * own `python.path` may be relative so a worktree session runs ITS `.venv`;
     * a Mac-wide default is absolute by schema, because "the same interpreter
     * wherever you are" is the only thing it could honestly mean. Passing it
     * through `resolvePythonPath` anyway is harmless for an absolute path and
     * keeps one code path.
     */
    const machineDefault = DataScienceMachineSettingsSchema.safeParse(machineSettings(this.machinePlugins(), "data-science"));
    const chosen = config.python?.path ?? (machineDefault.success ? machineDefault.data.python : undefined);
    if (!chosen) return undefined;
    const pythonPath = resolvePythonPath(session.workspace.path, chosen);
    if (!fs.existsSync(pythonPath)) return undefined;
    return { pythonPath };
  }

  /** Compile and tlmgr jobs — a SIBLING runner, not `dsJobs`, so a thesis
   *  compile never queues behind three pip installs and the job-id namespaces
   *  stay apart. Same class, own concurrency budget. */
  readonly latexJobs = new JobRunner(() => this.now());

  /** The last compile per session, for `latex_status` and the surface. */
  private readonly latexCompiles = new Map<string, LatexCompileMemory>();

  /**
   * THE LATEX DOOR FOR ONE SESSION, shaped like `dataScience()` above:
   * resolves the project's toolchain with the worktree rule for `mainFile`,
   * builds the capability over this store's jobs, and refuses when the
   * project has not opted in.
   */
  latex(sessionId: string): LatexCapability {
    const session = this.getSession(sessionId);
    const resolved = this.resolveLatex(session);
    if (!resolved) {
      // WHICH SWITCH, so a person knows where to go. The ceiling and the
      // project's own setting produce the same refusal but not the same fix.
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.machinePlugins(), "latex")
          ? "LaTeX is not enabled for this session's project"
          : "LaTeX is turned off for this Mac",
      );
    }
    return storeLatexCapability({
      sessionId,
      cwd: session.workspace.path,
      resolved,
      toolchain: () => this.latexToolchain(),
      jobs: this.latexJobs,
      appendEvent: (event) => { this.appendEvent(sessionId, event); },
      now: () => this.now(),
      lastCompile: {
        get: () => this.latexCompiles.get(sessionId),
        set: (status) => { this.latexCompiles.set(sessionId, status); },
      },
    });
  }

  /**
   * Which TeX toolchain a session compiles with, or nothing. The binary is a
   * MACHINE-level fact (absolute path, checked on disk); `mainFile` is the
   * per-tree fact and follows the worktree rule — it resolves against the
   * session's own tree when the capability compiles, never the project root's.
   */
  resolveLatex(session: Session): ResolvedLatex | undefined {
    if (!session.projectId) return undefined;
    let project: Project;
    try { project = this.getProject(session.projectId); } catch { return undefined; }
    const config = project.latex;
    if (!config?.enabled) return undefined;
    // THE MACHINE CEILING. Turning LaTeX off for this Mac makes it unavailable
    // everywhere without touching what any project chose.
    if (!machineAllows(this.machinePlugins(), "latex")) return undefined;
    /**
     * ── THE FALLBACK CHAIN, MOST SPECIFIC FIRST ──────────────────────────────
     *
     *   1. the project's own distribution — a per-checkout choice is the most
     *      specific thing anyone said, and it always wins;
     *   2. this Mac's default, from the Plugins pane;
     *   3. TELAR'S OWN TECTONIC, when it has been fetched.
     *
     * STEP 3 IS THE POINT OF THE MANAGED INSTALL. Before it, a project moved to
     * a Mac with no TeX on it did not compile and had no way to, short of the
     * person installing MacTeX; now the same checkout compiles anywhere Telar
     * has downloaded its Tectonic. It is LAST because it is the weakest signal:
     * nobody chose it, it is what is left when nobody has.
     *
     * Each step still has to EXIST on disk. A machine default naming a TeX Live
     * that was deleted falls through to the managed copy rather than resolving
     * onto a path that is not there — which is the difference between "your
     * document compiled" and "latexmk: command not found".
     */
    const machine = LatexMachineSettingsSchema.safeParse(machineSettings(this.machinePlugins(), "latex"));
    const machineDefaults = machine.success ? machine.data : {};
    for (const choice of [config.toolchain, machineDefaults.toolchain]) {
      if (!choice) continue;
      // `managed` names an INTENT, not a place — resolve it to today's binary.
      const binPath = choice.kind === "managed" ? this.managed().found()?.path : choice.path;
      if (!binPath || !fs.existsSync(binPath)) continue;
      const engine = choice.engine ?? machineDefaults.engine;
      return {
        kind: choice.kind === "managed" ? "tectonic" : (choice.kind as ResolvedLatex["kind"]),
        binPath,
        ...(engine ? { engine: engine as ResolvedLatex["engine"] } : {}),
        ...(config.mainFile ? { mainFile: config.mainFile } : {}),
        ...(machineDefaults.autoInstallPackages ? { autoInstallPackages: true } : {}),
      };
    }
    const managed = this.managed().found();
    if (!managed) return undefined;
    return {
      kind: "tectonic",
      binPath: managed.path,
      ...(config.mainFile ? { mainFile: config.mainFile } : {}),
    };
  }

  /**
   * TELAR'S OWN TECTONIC, for this engine root. One instance, because the
   * single-flight install and the last error are state two HTTP requests have
   * to share — see `latex/managed.ts`.
   */
  private managedTectonicInstall?: ManagedTectonic;

  private managed(): ManagedTectonic {
    this.managedTectonicInstall ??= new ManagedTectonic({ root: this.paths.root });
    return this.managedTectonicInstall;
  }

  /** What `GET /v2/latex/managed` answers, and what the toolchain carries. */
  managedTectonic(): ManagedTectonicStatus {
    return this.managed().status();
  }

  /**
   * Fetch it, or answer immediately when it is already here. Idempotent and
   * serialised in the installer; the toolchain cache is dropped afterwards so
   * the next probe reports the binary rather than a five-second-old absence.
   */
  async installManagedTectonic(): Promise<ManagedTectonicStatus> {
    const status = await this.managed().install();
    this.latexToolchainCache = undefined;
    return status;
  }

  /** The kernel host reporting a state change; journaled so the panel's pill follows it. */
  recordKernelState(sessionId: string, state: "starting" | "idle" | "busy" | "restarting" | "dead", reason?: string): void {
    try {
      this.getSession(sessionId);
    } catch {
      return; // a kernel outliving its session has nowhere to report
    }
    this.appendEvent(sessionId, { type: "kernel.state.changed", state, ...(reason ? { reason } : {}) });
  }

  /**
   * A WINDOW OF ROWS from a CSV, TSV or Parquet file in the session's tree.
   * CSV is parsed here; Parquet goes through the kernel (pyarrow), so it needs
   * data science on. The fence is `sessionFile`'s.
   */
  async sessionTable(sessionId: string, target: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }): Promise<TableWindow> {
    const session = this.getSession(sessionId);
    if (/\.parquet$/i.test(target)) {
      const ds = this.dataScience(sessionId);
      const sort = options.sort ? `.sort_values(${JSON.stringify(options.sort)}, ascending=${options.desc ? "False" : "True"})` : "";
      const code = `import pandas as _pd, json as _j\n_df = _pd.read_parquet(${JSON.stringify(path.resolve(session.workspace.path, target))})${sort}\n_w = _df.iloc[${options.offset}:${options.offset + options.limit}]\nprint("__TELAR_TABLE__" + _j.dumps({"columns": list(map(str, _df.columns)), "dtypes": [str(_df.dtypes[c]) for c in _df.columns], "total": int(len(_df)), "rows": _j.loads(_w.to_json(orient="values", date_format="iso"))}, default=str))`;
      const result = await ds.execute({ code, producer: "table" });
      const line = result.outputs.find((o) => o.kind === "text" && o.text.includes("__TELAR_TABLE__"));
      if (!result.ok || !line || line.kind !== "text") throw new EngineStateError("invalid_request", result.error ? `${result.error.ename}: ${result.error.evalue}` : "could not read the parquet file");
      const parsed = JSON.parse(line.text.slice(line.text.indexOf("__TELAR_TABLE__") + 15)) as Omit<TableWindow, "offset" | "path">;
      return { path: target, offset: options.offset, ...parsed };
    }
    const file = this.sessionFile(sessionId, target);
    if (file.binary) throw new EngineStateError("invalid_request", "that file is not text");
    return { path: target, ...windowCsv(file.text, /\.tsv$/i.test(target) ? "\t" : ",", options), ...(file.truncated ? { truncated: true } : {}) };
  }

  /** The attachment index, for the plots gallery. Newest first. */
  listAttachments(sessionId: string, options: { tag?: string } = {}): TurnAttachment[] {
    this.getSession(sessionId);
    const all = [...this.readAttachments(sessionId).values()];
    const filtered = options.tag ? all.filter((a) => a.tags?.includes(options.tag!)) : all;
    return structuredClone(filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
  }

  attachmentBytes(sessionId: string, attachmentId: string): { attachment: TurnAttachment; data: Uint8Array } {
    this.getSession(sessionId);
    const attachment = this.readAttachments(sessionId).get(attachmentId);
    if (!attachment) throw new EngineStateError("not_found", "attachment does not exist");
    return { attachment: structuredClone(attachment), data: new Uint8Array(fs.readFileSync(attachment.path)) };
  }

  /** Replace an attachment's tags — how a plot is pinned and unpinned. */
  tagAttachment(sessionId: string, attachmentId: string, tags: string[]): TurnAttachment {
    this.getSession(sessionId);
    const index = this.readAttachments(sessionId);
    const attachment = index.get(attachmentId);
    if (!attachment) throw new EngineStateError("not_found", "attachment does not exist");
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 16);
    const next = { ...attachment, ...(cleaned.length ? { tags: cleaned } : {}) };
    if (!cleaned.length) delete next.tags;
    index.set(attachmentId, next);
    this.writeDocument(attachmentsFile(this.paths, sessionId), { version: STATE_VERSION, attachments: [...index.values()] });
    return structuredClone(next);
  }

  /**
   * Record whose hands are on the session's shared browser (§6). Reported by
   * the DESKTOP SHELL — the only process that can see a human's click land in
   * the native view — over the engine's own HTTP API, and deduped here so a
   * shell that re-reports the standing state journals nothing new.
   */
  recordBrowserControl(sessionId: string, controller: "agent" | "human" | "idle", tabId?: string, interrupted = false): void {
    this.getSession(sessionId);
    // Control is PER TAB (§6): the dedupe key carries the tab so tab 1
    // changing hands is never mistaken for a re-report about tab 0.
    const key = `${sessionId}:${tabId ?? ""}`;
    if (this.browserControlLast.get(key) === controller) return;
    this.browserControlLast.set(key, controller);
    // Stamped with the RUNNING turn when there is one, so the transcript can
    // put "You interacted with the browser" inside the turn whose action it explains.
    // Between turns the row is session-level — the panel badge is live state.
    const running = this.readQueue(sessionId).turns.find((turn) => turn.state === "running");
    this.appendEvent(
      sessionId,
      { type: "browser.control.changed", controller, ...(tabId ? { tabId } : {}), ...(interrupted ? { interrupted: true } : {}) },
      running?.runId,
    );
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
    const session = this.getSession(sessionId);
    if (!this.browser?.state) {
      return { scopeKey: sessionId, provider: "none", running: false, tabs: [], canStart: false };
    }
    // BIND THE PROJECT PROFILE ON THE HUMAN ENTRY PATH. "Open a browser" from
    // the cockpit reaches here with `start:true` BEFORE the browser surface
    // mounts, so its own bind effect cannot run first; a fresh human-only
    // session after a restart would otherwise hit an unbound scope and the
    // host would refuse to open. Idempotent with the worker's per-turn bind.
    // Projectless sessions bind the explicit `none`.
    if (options.start && this.browser.bindProfile) {
      await this.browser.bindProfile(sessionId, session.projectId ?? "none");
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
   * OPEN A URL IN THE SESSION'S BROWSER, AS THE HUMAN — the engine-side twin
   * of the desktop shell's "new tab" action, for the clients that have no
   * shell: a phone, or this cockpit reading a paired Mac. The tab opens on
   * whichever browser that engine routes to (the desktop's when its shell is
   * up, headless otherwise), and the resulting tab set is journalled exactly
   * as a hand-started browser's is, so the panel learns of it.
   *
   * http(s) only: a browser tool is not a way to hand `file:` or a custom
   * scheme to whatever handles it on that machine.
   */
  async browserOpen(sessionId: string, url: string): Promise<BrowserSnapshot> {
    const session = this.getSession(sessionId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new EngineStateError("invalid_request", "that is not a URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new EngineStateError("invalid_request", "only http and https pages can be opened");
    if (!this.browser?.call || !this.browser.state) throw new EngineStateError("invalid_request", "this engine has no browser to open pages in");
    if (this.browser.bindProfile) await this.browser.bindProfile(sessionId, session.projectId ?? "none");
    const result = await this.browser.call(sessionId, "browser_tabs", { action: "new", url: parsed.href });
    if (result.isError) {
      const text = result.content.find((part) => part.type === "text")?.text;
      throw new EngineStateError("invalid_request", text || "the browser could not open that page");
    }
    // The same dedupe-by-signature journal write as a hand-started browser:
    // the panel folds the journal, not this snapshot.
    return this.browserState(sessionId, { start: true });
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
    const stored = this.readDocument(this.paths.mcpServers) as { mcpServers?: unknown } | undefined;
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
    this.writeDocument(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
    return structuredClone(server);
  }

  removeMcpServer(id: string, projectId?: string): boolean {
    assertId(id, "mcp server id");
    const servers = this.listMcpServers();
    // Scoped, so removing a project's `linear` cannot take the global one with
    // it — which is exactly what an id-only match would have done.
    const next = servers.filter((server) => !(server.id === id && server.projectId === projectId));
    if (next.length === servers.length) return false;
    this.writeDocument(this.paths.mcpServers, { version: STATE_VERSION, mcpServers: next });
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
      const stored = this.readDocument(this.paths.inbox);
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
      if (days === null) return { ...DEFAULT_INBOX_POLICY, autoSettleAfterHours: null };
      if (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 90) {
        return { ...DEFAULT_INBOX_POLICY, autoSettleAfterHours: days * 24 };
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
  setInboxPolicy(patch: { autoSettleAfterHours?: unknown; settleDelegatedAfterHours?: unknown }): InboxPolicy {
    const next: InboxPolicy = { ...this.getInboxPolicy() };
    /** The same bound twice, stated once: both windows are hours in 1..90 days. */
    const window = (value: unknown, what: string): number | null => {
      if (value === null) return null;
      const parsed = InboxPolicySchema.shape.autoSettleAfterHours.safeParse(value);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `${what} must be a whole number of hours between ${MIN_AUTO_SETTLE_HOURS} and ${MAX_AUTO_SETTLE_HOURS}, or null`,
        );
      }
      return parsed.data;
    };
    if (patch.autoSettleAfterHours !== undefined) {
      next.autoSettleAfterHours = window(patch.autoSettleAfterHours, "auto-settle window");
    }
    if (patch.settleDelegatedAfterHours !== undefined) {
      next.settleDelegatedAfterHours = window(patch.settleDelegatedAfterHours, "delegation grace");
    }
    this.writeDocument(this.paths.inbox, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /**
   * Whether Telar may tell an agent where it is — see `AgentOrientation`.
   *
   * Same never-throws rule as `getInboxPolicy`, and here it decides what every
   * turn on the machine is told: a file somebody hand-edited into nonsense must
   * cost the preference and fall back to the shipped default, never the turn.
   * The default is BOTH ON, because the orientation exists to fix a bug rather
   * than to add a feature somebody opts into.
   */
  getAgentOrientation(): AgentOrientation {
    try {
      const parsed = AgentOrientationSchema.safeParse(this.readDocument(this.paths.orientation));
      return parsed.success ? parsed.data : { ...DEFAULT_AGENT_ORIENTATION };
    } catch {
      return { ...DEFAULT_AGENT_ORIENTATION };
    }
  }

  /** By presence, like every other patch here: turning the skill off must not
   *  re-decide the preamble. Takes `unknown` and validates against the schema
   *  for the reason `setInboxPolicy` states — the rule lives next to the shape,
   *  not spelled a second time in whichever route is the way in today. */
  setAgentOrientation(patch: { preamble?: unknown; skill?: unknown }): AgentOrientation {
    const next: AgentOrientation = { ...this.getAgentOrientation() };
    for (const key of ["preamble", "skill"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        throw new EngineStateError("invalid_request", `${key} must be true or false`);
      }
      next[key] = value;
    }
    this.writeDocument(this.paths.orientation, { version: STATE_VERSION, ...next });
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
      const parsed = SessionDefaultsSchema.safeParse(this.readDocument(this.paths.sessionDefaults));
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
    this.writeDocument(this.paths.sessionDefaults, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /**
   * Where each project group sits in the rail — see `SidebarLayout`.
   *
   * Same never-throws rule as `getInboxPolicy`: a malformed arrangement costs
   * the arrangement, never the list it arranges. The default is the empty
   * order, which the rail reads as "alphabetical, nobody has moved anything".
   */
  getSidebarLayout(): SidebarLayout {
    try {
      const parsed = SidebarLayoutSchema.safeParse(this.readDocument(this.paths.sidebarLayout));
      return parsed.success ? parsed.data : blankSidebarLayout();
    } catch {
      return blankSidebarLayout();
    }
  }

  /**
   * Takes `unknown` and validates here, like the policies above. A key listed
   * twice is kept once, at its first position — the rail reads the first
   * mention anyway, and a document that said two things would be one that
   * meant neither. The same rule applies inside every `sessionOrder` list.
   *
   * EACH FIELD IS ITS OWN PATCH. A drop in the pinned band writes `pinnedOrder`
   * and nothing else; a drop inside a group writes `sessionOrder` and nothing
   * else. Absent means "unchanged", never "empty" — otherwise one rail's write
   * would erase an arrangement another rail had just made.
   */
  setSidebarLayout(patch: { projectOrder?: unknown; sessionOrder?: unknown; pinnedOrder?: unknown }): SidebarLayout {
    const next: SidebarLayout = { ...this.getSidebarLayout() };
    if (patch.projectOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.projectOrder.safeParse(patch.projectOrder);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `projectOrder must be a list of up to ${MAX_SIDEBAR_PROJECT_ORDER} non-empty project group keys`,
        );
      }
      next.projectOrder = [...new Set(parsed.data)];
    }
    if (patch.sessionOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.sessionOrder.safeParse(patch.sessionOrder);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `sessionOrder must map a project group key to a list of up to ${MAX_SIDEBAR_SESSION_ORDER} non-empty session keys`,
        );
      }
      next.sessionOrder = Object.fromEntries(Object.entries(parsed.data).map(([key, ids]) => [key, [...new Set(ids)]]));
    }
    if (patch.pinnedOrder !== undefined) {
      const parsed = SidebarLayoutSchema.shape.pinnedOrder.safeParse(patch.pinnedOrder);
      if (!parsed.success) {
        throw new EngineStateError(
          "invalid_request",
          `pinnedOrder must be a list of up to ${MAX_SIDEBAR_SESSION_ORDER} non-empty session keys`,
        );
      }
      next.pinnedOrder = [...new Set(parsed.data)];
    }
    this.writeDocument(this.paths.sidebarLayout, { version: STATE_VERSION, ...next });
    return cloneSidebarLayout(next);
  }

  /** Same never-throws rule as `getInboxPolicy`, same reason: a malformed
   *  preference costs the preference, never the turn it decorates. */
  getTextGenPolicy(): TextGenPolicy {
    try {
      const parsed = TextGenPolicySchema.safeParse(this.readDocument(this.paths.textGen));
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
    this.writeDocument(this.paths.textGen, { version: STATE_VERSION, ...next });
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
      const stored = this.readDocument(this.paths.appearance) as { appearance?: unknown; updatedAt?: unknown } | undefined;
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
    this.writeDocument(this.paths.appearance, { version: STATE_VERSION, updatedAt, appearance: blob });
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
    // Only the live index can hold such a turn, and it never reads the
    // metadata of a session that cannot: this used to open every session on
    // disk to answer a yes/no question about a handful of them.
    for (const sessionId of this.liveQueueSessionIds()) {
      const queue = this.readQueue(sessionId);
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
        this.writeDocument(sessionMetadataFile(this.paths, next.id), storedSession(next));
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
    this.writeDocument(sessionMetadataFile(this.paths, id), session);
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
    const stored = this.readDocument(this.paths.mcpOAuth) as { records?: unknown } | undefined;
    const records = stored?.records;
    if (!records || typeof records !== "object") return {};
    return records as Record<string, McpOAuthRecord>;
  }

  private writeMcpOAuthRecords(records: Record<string, McpOAuthRecord>): void {
    this.writeDocument(this.paths.mcpOAuth, { version: STATE_VERSION, records });
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
    this.writeDocument(this.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
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
    this.writeDocument(this.paths.mcpOAuthPending, { version: STATE_VERSION, flows });
    return flow;
  }

  private readPendingMcpOAuth(): Record<string, PendingMcpOAuth> {
    const stored = this.readDocument(this.paths.mcpOAuthPending) as { flows?: unknown } | undefined;
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
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
      throw new EngineStateError("invalid_request", "provider instance driver must be claude, codex or opencode");
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
    this.writeDocument(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: next });
    this.writeDocument(this.paths.providerSecrets, { version: STATE_VERSION, secrets: env.secrets });
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
    if (id === defaultInstanceIdForDriver("claude") || id === defaultInstanceIdForDriver("codex") || id === defaultInstanceIdForDriver("opencode")) {
      throw new EngineStateError("conflict", "the built-in provider instance cannot be removed");
    }
    const instances = this.readProviderInstances();
    const next = instances.filter((instance) => instance.id !== id);
    if (next.length === instances.length) return false;
    const secrets = this.readProviderSecrets();
    for (const key of Object.keys(secrets)) {
      if (key.slice(0, key.indexOf(SECRET_KEY_SEPARATOR)) === id) delete secrets[key];
    }
    this.writeDocument(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: next });
    this.writeDocument(this.paths.providerSecrets, { version: STATE_VERSION, secrets });
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
    const stored = this.readDocument(this.paths.providerInstances) as { providerInstances?: unknown } | undefined;
    if (stored === undefined) {
      const at = this.now();
      const seeded = [seedProviderInstance("claude", at), seedProviderInstance("codex", at), seedProviderInstance("opencode", at)];
      this.writeDocument(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: seeded });
      return seeded;
    }
    const parsed = ProviderInstanceSchema.array().safeParse(stored.providerInstances ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid provider instance registry");
    if (!parsed.data.some((instance) => instance.id === "opencode")) {
      parsed.data.push(seedProviderInstance("opencode", this.now()));
      this.writeDocument(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: parsed.data });
    }
    return parsed.data;
  }

  private readProviderSecrets(): Record<string, string> {
    const stored = this.readDocument(this.paths.providerSecrets) as { secrets?: unknown } | undefined;
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

  // ── usage limit sources ───────────────────────────────────────────────────
  //
  // THE HUBS QUOTA IS READ FROM. A CLIProxyAPI hub pools several subscription
  // logins and routes turns across them, so the windows that gate that work sit
  // on accounts this Mac never signs in as — the usage page's transcript scan
  // cannot see them and never will.
  //
  // CONFIGURATION ONLY LIVES HERE. What the hub currently reports is live state
  // that `usage-limits.ts` fetches and `daemon.ts` caches; persisting a quota
  // figure would mean serving one that is stale by exactly as long as the
  // engine was down.

  /**
   * Every configured hub, WITH MANAGEMENT KEYS WITHHELD.
   *
   * This is the read a settings page gets, and it is the only one reachable
   * from a route. `resolveUsageLimitSources` is the one that returns real keys.
   */
  listUsageLimitSources(): UsageLimitSource[] {
    // Secrets read ONCE for the whole list rather than per row: this is a
    // settings-page read, and a file open per configured hub to decide a
    // boolean is a cost that grows with the thing it describes.
    const secrets = this.readUsageLimitSecrets();
    return this.readUsageLimitSources().map((source) => redactUsageLimitSource(source, secrets));
  }

  /**
   * Create or replace one hub.
   *
   * THE REDACTED ROUND TRIP IS THE POINT, the same rule `applyEnvEdits` follows:
   * a client reads `{ managementKey: "", keyRedacted: true }` and hands that
   * back on the next save, so only a NON-EMPTY key replaces a stored one.
   * Clearing a key is done by removing the hub — saving it blank is
   * indistinguishable from "I did not retype it".
   */
  saveUsageLimitSource(input: {
    id: string;
    kind?: unknown;
    label?: string | null;
    url?: unknown;
    managementKey?: unknown;
    enabled?: boolean;
  }): UsageLimitSource {
    assertUsageLimitSourceId(input.id);
    const sources = this.readUsageLimitSources();
    const existing = sources.find((source) => source.id === input.id);
    const at = this.now();
    const url = input.url === undefined ? existing?.url : input.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new EngineStateError("invalid_request", "a usage limit source needs a hub URL");
    }
    let origin: URL;
    try {
      origin = new URL(url.trim());
    } catch {
      throw new EngineStateError("invalid_request", "the hub URL is not a valid URL");
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new EngineStateError("invalid_request", "the hub URL must be http or https");
    }
    const kind = input.kind === undefined ? (existing?.kind ?? "cliproxy") : input.kind;
    if (kind !== "cliproxy") throw new EngineStateError("invalid_request", "usage limit source kind must be cliproxy");
    const secrets = this.readUsageLimitSecrets();
    if (input.managementKey !== undefined) {
      if (typeof input.managementKey !== "string") {
        throw new EngineStateError("invalid_request", "the management key must be a string");
      }
      // Non-empty replaces; empty leaves whatever is stored, which is what makes
      // saving a redacted row safe. NEVER logged, here or anywhere.
      if (input.managementKey !== "") secrets[input.id] = input.managementKey;
      else if (!(input.id in secrets)) secrets[input.id] = "";
    } else if (!(input.id in secrets)) {
      secrets[input.id] = "";
    }
    const label = input.label === undefined ? existing?.label : input.label === null ? undefined : input.label.trim() || undefined;
    const source = {
      id: input.id,
      kind,
      ...(label ? { label } : {}),
      url: origin.toString(),
      // The stored record carries no key: redaction is the shape, not a step.
      managementKey: "",
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const parsed = UsageLimitSourceSchema.safeParse(source);
    if (!parsed.success) throw new EngineStateError("invalid_request", "usage limit source configuration is invalid");
    const next = existing
      ? sources.map((entry) => (entry.id === source.id ? parsed.data : entry))
      : [...sources, parsed.data];
    if (next.length > MAX_USAGE_LIMIT_SOURCES) {
      throw new EngineStateError("invalid_request", `at most ${MAX_USAGE_LIMIT_SOURCES} usage limit sources can be configured`);
    }
    this.writeDocument(this.paths.usageLimitSources, { version: STATE_VERSION, usageLimitSources: next });
    this.writeDocument(this.paths.usageLimitSecrets, { version: STATE_VERSION, secrets });
    return redactUsageLimitSource(parsed.data, secrets);
  }

  /** Forget a hub and its key together. Returns false for an id nobody
   *  configured, so a double-press is not an error. */
  removeUsageLimitSource(id: string): boolean {
    assertUsageLimitSourceId(id);
    const sources = this.readUsageLimitSources();
    const next = sources.filter((source) => source.id !== id);
    if (next.length === sources.length) return false;
    const secrets = this.readUsageLimitSecrets();
    delete secrets[id];
    this.writeDocument(this.paths.usageLimitSources, { version: STATE_VERSION, usageLimitSources: next });
    this.writeDocument(this.paths.usageLimitSecrets, { version: STATE_VERSION, secrets });
    return true;
  }

  /**
   * The ENABLED hubs with their keys resolved — what actually reads a hub.
   *
   * NOT REACHABLE FROM A ROUTE, the same rule `resolveProviderInstance` lives
   * by. A disabled hub is dropped here rather than filtered by each caller:
   * "enabled" means "may be contacted", and one caller forgetting that would
   * be a request to a service the user switched off.
   */
  resolveUsageLimitSources(): { id: string; kind: "cliproxy"; label?: string; url: string; managementKey: string }[] {
    const secrets = this.readUsageLimitSecrets();
    return this.readUsageLimitSources()
      .filter((source) => source.enabled)
      .map((source) => ({
        id: source.id,
        kind: source.kind,
        ...(source.label ? { label: source.label } : {}),
        url: source.url,
        managementKey: secrets[source.id] ?? "",
      }));
  }


  /**
   * NEVER THROWS ON A BAD DOCUMENT, the rule `getInboxPolicy` set and for the
   * same reason sharpened: a malformed hub list is a preference, and the worst
   * it can cost is a section of the usage page. Refusing would take the whole
   * engine's settings read down with it.
   */
  private readUsageLimitSources(): UsageLimitSource[] {
    try {
      const stored = this.readDocument(this.paths.usageLimitSources) as { usageLimitSources?: unknown } | undefined;
      const parsed = UsageLimitSourceSchema.array().safeParse(stored?.usageLimitSources ?? []);
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private readUsageLimitSecrets(): Record<string, string> {
    try {
      const stored = this.readDocument(this.paths.usageLimitSecrets) as { secrets?: unknown } | undefined;
      const secrets = stored?.secrets;
      if (typeof secrets !== "object" || secrets === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: {
      executionStorage?: "json" | "sqlite";
      notifier?: EngineNotifier;
      /**
       * SOMETHING IN SOME SESSION'S QUEUE CHANGED — a message accepted, a turn
       * claimed or stopped, a steer promoted. Fired from `writeQueue`, which is
       * the only writer, so no transition can forget it, and only AFTER the
       * transaction commits so a rolled-back write announces nothing.
       *
       * INJECTED BY THE DAEMON, for the worker it hosts in-process: it is what
       * lets that worker poll slowly while nothing is happening without putting
       * the backoff's latency on the next thing the person types. Absent by
       * default, so a store on its own announces nothing to anybody.
       */
      onQueueChanged?: () => void;
      /**
       * A STOP'S CANCELLATIONS, HANDED STRAIGHT TO THE WORKER HOLDING THEM.
       *
       * `onQueueChanged` is not enough for this, and #409 is why. It only ever
       * puts a BACKED-OFF worker back on its fast interval — a worker already
       * beating fast (which is every worker with a turn running, i.e. every
       * worker a Stop concerns) does nothing with the nudge and goes on
       * DISCOVERING the stop by polling. The abort therefore waits for the next
       * heartbeat, and for the one in flight to answer first: an unbounded wait
       * on a busy daemon, measured at up to five seconds.
       *
       * So a stop tells the worker WHICH CLAIMS DIED rather than that something
       * moved, and the worker aborts them in-process, in the same tick as the
       * HTTP request. The heartbeat's `cancellationsForWorker` is unchanged and
       * still the backstop: it is the only path an OUT-OF-PROCESS worker has,
       * and re-aborting an already-aborted controller is a no-op.
       *
       * INJECTED BY THE DAEMON for the worker it hosts, like `onQueueChanged`;
       * absent by default, so a store on its own tells nobody anything.
       */
      onTurnsStopped?: (cancellations: StoppedClaim[]) => void;
      git?: GitRunner;
      asyncGit?: AsyncGitRunner;
      gh?: GhRunner;
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
    this.onQueueChanged = options.onQueueChanged;
    this.onTurnsStopped = options.onTurnsStopped;
    this.readModels = options.models ?? readModelCatalogue;
    this.manifest = options.manifest ?? BUNDLED_MANIFEST;
    this.computerUse = options.computerUse;
    this.git = options.git ?? defaultGitRunner;
    this.asyncGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultAsyncGitRunner);
    this.gh = options.gh ?? defaultGhRunner;
    this.paths = statePaths(root);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
    const migrated = fs.existsSync(path.join(root, "execution-store.json")) || fs.existsSync(path.join(root, "execution.sqlite"));
    if (migrated && options.executionStorage === "json") throw new Error("this engine home has migrated to SQLite; restore a backup to downgrade");
    if (migrated || options.executionStorage === "sqlite") {
      this.executionStore = new ExecutionStore(root);
      const commands = ["createSession", "updateSession", "settleSession", "markSessionRead", "submitTurn", "submitAgentTurn",
        "claimTurn", "claimNextTurn", "markRunning", "ingestObservations", "openRequest", "resolveRequest", "completeTurn", "failTurn",
        "stopSession", "stopTurn", "pauseSession", "resumeSession", "stopBackgroundTasks", "taskStopsForWorker", "openProviderTurn",
        "reportSessionTasks", "ackSteer", "promoteTurn", "releaseHeldTurn", "discardAmbiguousTurn", "recover", "retireWorkerRegistration",
        "subscribe", "unsubscribe"] as const;
      for (const name of commands) {
        const operation = Reflect.get(this, name) as (...args: unknown[]) => unknown;
        Object.defineProperty(this, name, { value: (...args: unknown[]) =>
          this.executeCommand(name, () => Reflect.apply(operation, this, args)) });
      }
    }
  }

  /**
   * The project's icon, found in its checkout and cached.
   *
   * A CACHE, BECAUSE THE FIND IS NOT FREE. `listProjects` is on the sidebar's
   * poll path and the metadata refresh below runs every ten seconds per
   * project; resolving from scratch each time meant a hundred-odd `stat`s per
   * project per poll, forever, to re-learn an answer that almost never
   * changes.
   *
   * TWO TTLs, BECAUSE THE TWO ANSWERS AGE DIFFERENTLY. "This file is the
   * icon" stays true for as long as the file does, and a HIT IS CONFIRMED
   * WITH ONE `stat` rather than trusted — which is what makes a REPLACED icon
   * visible on the very next poll (the etag is derived from mtime and size, so
   * the confirmation re-derives it) and a DELETED one fall back at once
   * instead of leaving the serve route reading a path that is gone. "This
   * project has no icon" is the answer a person is most likely to be in the
   * middle of falsifying — they just added `public/favicon.ico` and are
   * waiting to see it — so it is held for seconds, not minutes.
   *
   * `resolvedAt` IS NOT `at`, AND CONFIRMING NEVER MOVES IT. A confirmation
   * proves the file it already knows about is still there; it cannot see a
   * NEW file that now outranks it — a `.telar/icon.svg` added beside the
   * `favicon.ico` currently winning, or an `index.html` whose href moved to a
   * different file. If a confirmed hit refreshed the discovery clock, the
   * sidebar's ten-second poll would keep resetting a five-minute TTL and the
   * full search would never run again: the higher-priority icon would stay
   * invisible for as long as the old one existed. So the discovery deadline is
   * measured from the last FULL resolution and nothing else touches it.
   *
   * Bounded, because it is keyed by project id and nothing evicts on
   * unregistration alone; oldest-first, which for a poll-driven map is close
   * enough to least-recently-used and costs no bookkeeping.
   */
  private readonly projectIconCache = new Map<string, { icon?: ProjectIcon; resolvedAt: number }>();
  private static readonly ICON_TTL_FOUND = 300_000;
  private static readonly ICON_TTL_MISSING = 15_000;
  private static readonly ICON_CACHE_CAPACITY = 512;

  /** Record a FULL resolution. Starts the discovery clock. */
  private rememberProjectIcon(projectId: string, icon: ProjectIcon | undefined): ProjectIcon | undefined {
    this.projectIconCache.delete(projectId);
    this.projectIconCache.set(projectId, { ...(icon ? { icon } : {}), resolvedAt: this.now() });
    while (this.projectIconCache.size > EngineStore.ICON_CACHE_CAPACITY) {
      const oldest = this.projectIconCache.keys().next();
      if (oldest.done) break;
      this.projectIconCache.delete(oldest.value);
    }
    return icon;
  }

  /** Record a CONFIRMATION of the icon already known. Deliberately leaves
   *  `resolvedAt` alone — see the note above. */
  private refreshProjectIcon(projectId: string, icon: ProjectIcon): ProjectIcon {
    const cached = this.projectIconCache.get(projectId);
    if (cached) cached.icon = icon;
    return icon;
  }

  /** The cached answer, or `undefined` when the cache cannot speak — which is
   *  NOT the same as "no icon" and is why this returns a wrapper. */
  private cachedProjectIcon(projectId: string): { icon?: ProjectIcon } | undefined {
    const cached = this.projectIconCache.get(projectId);
    if (!cached) return undefined;
    const age = this.now() - cached.resolvedAt;
    if (cached.icon) return age < EngineStore.ICON_TTL_FOUND ? { icon: cached.icon } : undefined;
    return age < EngineStore.ICON_TTL_MISSING ? {} : undefined;
  }

  private projectIcon(project: Pick<Project, "id" | "root">): ProjectIcon | undefined {
    const cached = this.cachedProjectIcon(project.id);
    if (cached) {
      if (!cached.icon) return undefined;
      const confirmed = confirmProjectIconSync(cached.icon);
      if (confirmed) return this.refreshProjectIcon(project.id, confirmed);
    }
    return this.rememberProjectIcon(project.id, findProjectIcon(project.root));
  }

  private async projectIconAsync(project: Pick<Project, "id" | "root">): Promise<ProjectIcon | undefined> {
    const cached = this.cachedProjectIcon(project.id);
    if (cached) {
      if (!cached.icon) return undefined;
      const confirmed = await confirmProjectIcon(cached.icon);
      if (confirmed) return this.refreshProjectIcon(project.id, confirmed);
    }
    return this.rememberProjectIcon(project.id, await findProjectIconAsync(project.root));
  }

  /** Forget what was found for a project, so the next read resolves afresh.
   *  Called wherever the engine's own idea of the project changes under it. */
  private forgetProjectIcon(projectId: string): void {
    this.projectIconCache.delete(projectId);
  }

  /** The icon's bytes-on-disk, for the daemon's serve route. Refuses when the
   *  project has none rather than guessing. */
  projectIconFile(projectId: string): ProjectIcon {
    const project = this.getProject(projectId);
    const icon = this.projectIcon(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  async projectIconFileAsync(projectId: string): Promise<ProjectIcon> {
    const project = this.getProject(projectId);
    const icon = await this.projectIconAsync(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  /**
   * The registered projects.
   *
   * REMOVED ONES ARE NOT REGISTERED. Their records stay in the file so a
   * restore can give back the same id and settings, but they are absent from
   * this list — which is the list every picker, the sidebar and the
   * new-session surfaces read, so removal is complete without a single one of
   * them learning a new concept. `includeRemoved` exists for the one screen
   * that has to name a removed project in order to offer to put it back.
   */
  listProjects(options: { includeRemoved?: boolean } = {}): Project[] {
    const registry = this.readDocument(this.paths.projects);
    if (registry === undefined) return [];
    return structuredClone(parseRegistry(registry).projects)
      .filter((project) => options.includeRemoved || project.removedAt === undefined)
      .map((project) => {
        // A removed project's checkout is not polled: it is not on any surface
        // that shows a branch or an icon, and a removed row must not keep a
        // `git rev-parse` running against somebody's disk every ten seconds.
        return project.removedAt === undefined ? { ...project, ...this.projectMetadata(project) } : project;
      });
  }

  /** Sidebar metadata refreshes off the request path. Cold rows appear immediately;
   * branch/icon labels arrive on the next poll without blocking worker heartbeats. */
  private readonly projectMetadataCache = new Map<string, {
    root: string; at: number; value: Pick<Project, "branch" | "icon" | "remoteUrl">; pending?: Promise<void>;
  }>();

  private projectMetadata(project: Project): Pick<Project, "branch" | "icon" | "remoteUrl"> {
    let entry = this.projectMetadataCache.get(project.id);
    if (!entry || entry.root !== project.root) {
      entry = { root: project.root, at: -Infinity, value: {} };
      this.projectMetadataCache.set(project.id, entry);
    }
    if (!entry.pending && this.now() - entry.at >= 10_000) {
      const current = entry;
      current.pending = Promise.all([
        this.asyncGit(project.root, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5_000 }),
        // THROUGH THE CACHE, not around it. This runs every ten seconds per
        // project; resolving from scratch here made the cache above dead
        // weight and re-walked every checkout on the poll path.
        this.projectIconAsync(project),
        // WHICH REPOSITORY THIS CHECKOUT IS OF, on the same refresh as the
        // branch — a `git config` read of a file git has already cached, beside
        // a `rev-parse` that costs strictly more. Derived rather than stored so
        // adding an origin, or moving the repository, is visible on the next
        // poll instead of at the next re-registration.
        projectRemoteAsync(this.asyncGit, project.root),
      ]).then(([head, icon, remoteUrl]) => {
        if (this.projectMetadataCache.get(project.id) !== current) return;
        const branch = head.status === 0 ? head.stdout.trim() : "";
        current.value = {
          ...(branch && branch !== "HEAD" ? { branch } : {}),
          ...(icon ? { icon: icon.etag } : {}),
          ...(remoteUrl ? { remoteUrl } : {}),
        };
      }).catch(() => {
        // A stalled checkout must not hold up the registry or lose its row.
      }).finally(() => {
        current.at = this.now();
        current.pending = undefined;
      });
    }
    return entry.value;
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
    const registry = (this.readDocument(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registry);
    const id = input.id ?? `project_${crypto.randomUUID().replaceAll("-", "")}`;
    /**
     * REGISTERING A REMOVED PROJECT'S CHECKOUT RESTORES IT, rather than minting
     * a stranger with the same path.
     *
     * The match is on the canonical root, because that is what the person is
     * actually doing: pointing Telar at this folder again. Giving them a new id
     * would leave every session that ran here bound to an id nothing resolves,
     * their MCP servers scoped to it, and their browser profile keyed to it —
     * three silent losses from an action that reads like an undo. So the record
     * comes back whole: same id, same name unless a new one was typed, same
     * data-science and LaTeX blocks.
     */
    const tombstone = parsed.projects.find((project) => project.root === projectRoot && project.removedAt !== undefined);
    if (tombstone && (input.id === undefined || input.id === tombstone.id)) {
      delete tombstone.removedAt;
      tombstone.name = input.name.trim();
      tombstone.updatedAt = this.now();
      this.writeDocument(this.paths.projects, parsed);
      this.forgetProjectIcon(tombstone.id);
      this.projectMetadataCache.delete(tombstone.id);
      return structuredClone(tombstone);
    }
    const existing = parsed.projects.find((project) => project.id === id || project.root === projectRoot);
    if (existing) {
      if (existing.id === id && existing.root === projectRoot && existing.removedAt === undefined) return structuredClone(existing);
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
    this.writeDocument(this.paths.projects, parsed);
    // A fresh registration must not inherit a stale "no icon" answer cached
    // for a project that briefly shared this id.
    this.forgetProjectIcon(id);
    this.projectMetadataCache.delete(id);
    return structuredClone(project);
  }

  /**
   * PUT A PROJECT AWAY. Nothing on disk is touched, and nothing is thrown out.
   *
   * WHAT THIS IS: the reversible inverse of `registerProject`. The repository,
   * its git metadata, every worktree cut from it, the journal of every session
   * that ran on it and the browser profiles those sessions used all stay
   * exactly where they are — and so does the REGISTRATION RECORD, marked with
   * `removedAt`. Telar stops offering the project; it does not forget it.
   *
   * WHY A TOMBSTONE RATHER THAN A SPLICE. Three things in this engine are
   * keyed by a project id and outlive any one registration: a session's
   * `projectId`, an MCP server's scope, and a browser profile's binding.
   * Deleting the row and minting a new id on the way back in would silently
   * strand all three — the person would point at the same folder, get a different
   * project, and find their logged-in browser profile and their servers gone.
   * Keeping the record makes restoring an actual undo.
   *
   * WHY IT REFUSES WITH WORK IN FLIGHT. A worker resolves its project by id on
   * every step, so putting the registration away under a running turn turns a
   * live conversation into a stream of refusals — silently, in a surface the
   * person is not looking at. The ONLY alternatives are stopping their work or
   * letting it break, and neither is something a settings row should do
   * without being asked.
   *
   * WHAT COUNTS AS IN FLIGHT, stated rather than guessed at: every turn state
   * that is not terminal (`queued`, `claimed`, `running`, `steering`), plus
   * `ambiguous` — whose whole meaning is that the engine does not know whether
   * a provider run is still out there, and a "maybe" is not a green light —
   * plus any live backgrounded task, which by contract OUTLIVES the turn that
   * started it and would otherwise walk straight past a turns-only check.
   *
   * Idle sessions keep working as READS while the project is away: their
   * history, diffs and files all still resolve. What they cannot do is start
   * new work — see `assertProjectAvailable`.
   */
  unregisterProject(projectId: string): { project: Project; sessions: number } {
    assertId(projectId, "project id");
    const registry = (this.readDocument(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registry);
    const project = parsed.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    if (project.removedAt !== undefined) throw new EngineStateError("conflict", "this project is already removed");
    const sessions = this.readSessions().filter((session) => session.projectId === projectId);
    const busy = sessions.filter((session) => this.sessionHasWorkInFlight(session.id));
    if (busy.length > 0) {
      throw new EngineStateError(
        "conflict",
        `this project has ${busy.length === 1 ? "a session with work in flight" : `${busy.length} sessions with work in flight`} — let them finish or stop them first`,
      );
    }
    project.removedAt = this.now();
    project.updatedAt = project.removedAt;
    this.writeDocument(this.paths.projects, parsed);
    this.forgetProjectIcon(projectId);
    this.projectMetadataCache.delete(projectId);
    return { project: structuredClone(project), sessions: sessions.length };
  }

  /** Put a removed project back without needing its path — the settings page's
   *  Restore. Registering its checkout again does the same thing. */
  restoreProject(projectId: string): Project {
    assertId(projectId, "project id");
    const registry = (this.readDocument(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registry);
    const project = parsed.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    if (project.removedAt === undefined) return structuredClone(project);
    delete project.removedAt;
    project.updatedAt = this.now();
    this.writeDocument(this.paths.projects, parsed);
    this.forgetProjectIcon(projectId);
    this.projectMetadataCache.delete(projectId);
    return structuredClone(project);
  }

  /**
   * Whether a session still has something running, or something that might be.
   *
   * The turn states here are the NON-TERMINAL ones plus `ambiguous`; see
   * `unregisterProject` for why "we do not know" is counted as busy. Live
   * backgrounded tasks are checked separately because they are exactly the
   * work a turn-state check misses: `TaskKind` says a backgrounded task
   * continues after the turn that started it settles.
   */
  private sessionHasWorkInFlight(sessionId: string): boolean {
    const unsettled: ReadonlySet<Turn["state"]> = new Set<Turn["state"]>(["queued", "claimed", "running", "steering", "ambiguous"]);
    if (this.turns(sessionId).some((turn) => unsettled.has(turn.state))) return true;
    return [...this.readTasks(sessionId).values()].some(isLiveTask);
  }

  /**
   * REFUSE TO START NEW WORK ON A PUT-AWAY PROJECT.
   *
   * Reading stays open — history, diffs, files and the session's own record all
   * still answer, which is what keeps a removed project's past coherent instead
   * of blank. This guards the three places where new work BEGINS: a new
   * session, a new turn (which is also how a peer's wake arrives, so a
   * subscription firing later cannot quietly resume a provider on a project
   * the person put away), and a settings change (frozen, so what comes back on
   * restore is what was put away).
   */
  private assertProjectAvailable(projectId: string): void {
    if (this.getProject(projectId).removedAt === undefined) return;
    throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
  }

  getProject(projectId: string): Project {
    assertId(projectId, "project id");
    const registry = this.readDocument(this.paths.projects);
    const project = registry === undefined ? undefined : parseRegistry(registry).projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    return structuredClone(project);
  }

  /**
   * Change what a project IS CALLED, what it OPENS ON, and what it OPTS INTO.
   *
   * THE ROOT IS STILL NOT PATCHABLE, and that is the line this method keeps:
   * moving a project means registering the new folder, because the root is what
   * every session, worktree and browser profile on it resolves against. A NAME
   * IS NOT THAT. It was refused here only because nothing had asked yet, and a
   * registry whose only rename was "register the same folder again, typing the
   * name differently" made a rename look like a re-registration in every log
   * that watched one.
   *
   * `null` REMOVES A STORED ANSWER rather than storing a neutral one — for
   * `dataScience` and `latex` that is how "off" is spelled, so the registry
   * does not grow a `{enabled: false}` for every project that tried a feature
   * once; for `iconName`, `iconEmoji`, `defaultModel` and `envMode` it is how
   * "go back to following this Mac" is spelled, which is a different sentence
   * from any value they could hold.
   *
   * This method still refuses any key it does not know rather than storing it.
   */
  updateProject(
    projectId: string,
    patch: {
      name?: string;
      iconName?: string | null;
      iconEmoji?: string | null;
      defaultModel?: ModelSelectionValue | null;
      envMode?: EnvMode | null;
      dataScience?: DataScienceConfig | null;
      latex?: LatexConfig | null;
      plugins?: PluginPatch;
    },
  ): Project {
    assertId(projectId, "project id");
    const registry = (this.readDocument(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registry);
    const index = parsed.projects.findIndex((candidate) => candidate.id === projectId);
    if (index < 0) throw new EngineStateError("not_found", "project does not exist");
    const current = parsed.projects[index]!;
    // A removed project's settings are FROZEN, so what comes back on restore is
    // exactly what was put away.
    if (current.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to change its settings");
    }
    const next: Project = { ...current, updatedAt: this.now() };
    /**
     * IDENTITY FIRST, AND BEFORE THE PLUGIN MAP BELOW — these four are plain
     * scalars on the record and none of them participates in the mirroring
     * dance, so they are applied and then forgotten about.
     *
     * EVERY ONE OF THEM IS VALIDATED AGAINST THE CONTRACT'S OWN SCHEMA rather
     * than against a rule re-typed here. A second spelling of "what a model
     * selection is" would be a second thing to forget when the contract moves.
     */
    if (patch.name !== undefined) {
      const name = typeof patch.name === "string" ? patch.name.trim() : "";
      if (name === "") throw new EngineStateError("invalid_request", "project name must be non-empty");
      if (name.length > 200) throw new EngineStateError("invalid_request", "project name is too long");
      next.name = name;
    }
    /**
     * ONE PICKED ANSWER, NOT TWO. `iconName` and `iconEmoji` answer the same
     * question — "what did somebody choose for this project" — and a record
     * carrying both would leave the rail's preference order deciding which of
     * two deliberate picks wins. So naming either CLEARS the other, which also
     * makes the picker's Auto-detect one write rather than two.
     */
    if (patch.iconName === null) {
      delete next.iconName;
    } else if (patch.iconName !== undefined) {
      const glyph = ProjectSchema.shape.iconName.safeParse(
        typeof patch.iconName === "string" ? patch.iconName.trim() : patch.iconName,
      );
      if (!glyph.success || glyph.data === undefined) throw new EngineStateError("invalid_request", "project icon must be an icon name");
      next.iconName = glyph.data;
      delete next.iconEmoji;
    }
    if (patch.iconEmoji === null) {
      delete next.iconEmoji;
    } else if (patch.iconEmoji !== undefined) {
      const mark = ProjectSchema.shape.iconEmoji.safeParse(
        typeof patch.iconEmoji === "string" ? patch.iconEmoji.trim() : patch.iconEmoji,
      );
      if (!mark.success || mark.data === undefined) throw new EngineStateError("invalid_request", "project icon must be a short mark");
      next.iconEmoji = mark.data;
      delete next.iconName;
    }
    if (patch.defaultModel === null) {
      delete next.defaultModel;
    } else if (patch.defaultModel !== undefined) {
      const model = ProjectSchema.shape.defaultModel.safeParse(patch.defaultModel);
      if (!model.success || model.data === undefined) throw new EngineStateError("invalid_request", "default model selection is invalid");
      next.defaultModel = model.data;
    }
    if (patch.envMode === null) {
      delete next.envMode;
    } else if (patch.envMode !== undefined) {
      const mode = ProjectSchema.shape.envMode.safeParse(patch.envMode);
      if (!mode.success || mode.data === undefined) throw new EngineStateError("invalid_request", "workspace mode must be local or worktree");
      next.envMode = mode.data;
    }
    if (patch.dataScience === null) {
      delete next.dataScience;
    } else if (patch.dataScience !== undefined) {
      const config = DataScienceConfigSchema.safeParse(patch.dataScience);
      if (!config.success) throw new EngineStateError("invalid_request", "data science configuration is invalid");
      next.dataScience = config.data;
    }
    if (patch.latex === null) {
      delete next.latex;
    } else if (patch.latex !== undefined) {
      const config = LatexConfigSchema.safeParse(patch.latex);
      if (!config.success) throw new EngineStateError("invalid_request", "LaTeX configuration is invalid");
      next.latex = config.data;
      if (config.data.enabled) {
        try {
          ensureTelarGitignore(next.root, [{ rule: ".telar/latex/", alreadyCovered: [".telar/", ".telar", "/.telar/", ".telar/latex/"], why: "LaTeX aux files from Telar's compiles" }]);
        } catch { /* not a repo, or unwritable — compiles still work */ }
      }
    }
    /**
     * THE MAP, AND ITS MIRRORS, IN THE SAME WRITE.
     *
     * Both legacy arms above still work — they are what a released cockpit
     * sends — and each is translated into the map here rather than being a
     * second source of truth. The map then writes BACK the legacy blocks,
     * INCLUDING THEIR ABSENCES: a mirror that is only ever added is the
     * resurrection bug with extra steps.
     *
     * `version`'s presence is the durable migration marker. Once it is there
     * the map is the whole truth and the legacy fields are never read again —
     * see `PROJECT_PLUGINS_VERSION` for why a per-key fallback resurrects a
     * feature the user just turned off.
     */
    const before = readProjectPlugins(next).plugins;
    const fromLegacy: PluginPatch = {};
    if (patch.dataScience !== undefined) {
      fromLegacy["data-science"] =
        patch.dataScience === null ? null : pluginConfigFromLegacy(patch.dataScience as Record<string, unknown>);
    }
    if (patch.latex !== undefined) {
      fromLegacy.latex = patch.latex === null ? null : pluginConfigFromLegacy(patch.latex as Record<string, unknown>);
    }
    const merged = applyPluginPatch(before, { ...fromLegacy, ...(patch.plugins ?? {}) });
    const changed = patch.dataScience !== undefined || patch.latex !== undefined || patch.plugins !== undefined;
    // HAS-MAP GUARD: a project nobody has configured keeps no `plugins` key at
    // all, so an untouched registry is never rewritten with an empty map.
    if (changed || next.plugins !== undefined) {
      next.plugins = merged;
      const mirrors = legacyMirrors(merged);
      for (const [key, value] of Object.entries(mirrors)) {
        if (value === undefined) delete (next as Record<string, unknown>)[key];
        else (next as Record<string, unknown>)[key] = value;
      }
    }
    parsed.projects[index] = next;
    this.writeDocument(this.paths.projects, parsed);
    return structuredClone(next);
  }

  /**
   * WHICH PLUGINS A SESSION'S PROJECT HAS TURNED ON, as ids.
   *
   * `data-science` and `latex` are excluded even when the map names them,
   * because their own claim fields already carry them and a worker that saw
   * them twice would build their walls twice. That exclusion is temporary in
   * the same sense the two dedicated claim fields are, and it lives HERE, in
   * one line, rather than in the worker where it would be a second place to
   * forget.
   */
  /**
   * Where a departure is announced. One subscriber — the plugin host — so a
   * plugin with per-session state gives it back without the store naming it.
   */
  private pluginRelease: ((sessionId: string, reason: string) => void) | undefined;

  /**
   * Every assignment this session holds, folded over its WHOLE queue.
   *
   * Authoritative over what the engine STILL HOLDS: a client's transcript may be
   * a page, and a fold over a page cannot tell "the joined run finished" from
   * "the joined run is not in this window". The engine has every turn it has
   * kept, so it answers once and the answer rides the snapshot.
   *
   * `unresolved` can still occur here, and saying otherwise would be a lie:
   * journal retention or a deleted turn can remove a carrier the engine no
   * longer has. That is genuinely unknown, and reporting it as unknown is the
   * honest answer — not "running", and not a guess at an outcome.
   */
  sessionAssignments(sessionId: string): SessionAssignment[] {
    // A PLAIN cast, not `as unknown as`: the structural type names fields a
    // `Turn` really has, so a rename that breaks the fold is a type error here
    // rather than an `undefined` on every assignment (issue #380).
    return assignmentsOf(this.readQueue(sessionId).turns as AssignmentTurn[]);
  }

  /**
   * CONTINUE INDEPENDENTLY. Stops PRESENTING an assignment as active without
   * deleting anything: the task turn, its outcome and the session's
   * `startedFrom` all remain, and nothing running is stopped.
   *
   * Marks every outstanding task turn rather than taking a run id, because
   * "continue independently" is a statement about the session's relationship to
   * its coordinators, not about one message.
   */
  detachAssignments(sessionId: string, runId?: string): Turn[] {
    const session = this.getSession(sessionId);
    const at = this.now();
    const queue = this.readQueue(session.id);
    const detached: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.origin !== "session" || turn.agentIntent !== "task") continue;
      if (runId && turn.runId !== runId) continue;
      if (turn.assignmentDetachedAt !== undefined) continue;
      turn.assignmentDetachedAt = at;
      turn.updatedAt = at;
      detached.push(structuredClone(turn));
    }
    if (detached.length > 0) {
      this.writeQueue(session.id, queue);
      // No `turn.updated` kind exists; the cockpit refolds from the snapshot on
      // `session.updated`, which is what a detach changes for a reader.
      this.appendEvent(sessionId, { type: "session.updated", session });
    }
    return detached;
  }

  /**
   * WHAT THIS MACHINE ALLOWS. Absent file means everything is allowed — a Mac
   * that predates this must not have its working plugins silently switched off.
   */
  machinePlugins(): ProjectPlugins {
    const parsed = ProjectPluginsSchema.safeParse(this.readDocument(this.paths.machinePlugins));
    return parsed.success ? parsed.data : { version: PROJECT_PLUGINS_VERSION, entries: {} };
  }

  /**
   * Turn a plugin on or off for this Mac, or change its machine settings.
   *
   * PROJECT CONFIGURATION IS NEVER TOUCHED. Disabling globally is a ceiling: a
   * project that had the plugin on still has it on, and re-enabling here
   * restores exactly what each project had rather than a blank slate.
   */
  updateMachinePlugins(patch: PluginPatch): ProjectPlugins {
    const next = applyPluginPatch(this.machinePlugins(), patch);
    this.writeDocument(this.paths.machinePlugins, next);
    return structuredClone(next);
  }

  /** Does this plugin actually run for this project: machine AND project. */
  pluginRuns(project: Project, id: string): boolean {
    return pluginEffectivelyEnabled(this.machinePlugins(), readProjectPlugins(project).plugins, id);
  }

  attachPluginRelease(release: (sessionId: string, reason: string) => void): void {
    this.pluginRelease = release;
  }

  enabledPluginIds(session: Session): string[] {
    if (!session.projectId) return [];
    let project: Project;
    try { project = this.getProject(session.projectId); } catch { return []; }
    const { plugins } = readProjectPlugins(project);
    const machine = this.machinePlugins();
    return Object.entries(plugins.entries)
      // THE MACHINE CEILING APPLIES TO THE CLAIM TOO. A worker builds walls from
      // this list, so a globally disabled plugin must not reach a turn — the
      // frontend hiding it would not be enforcement.
      .filter(([id, config]) => config.enabled && machineAllows(machine, id) && !MIRRORED_PLUGINS.includes(id as MirroredPlugin))
      .map(([id]) => id)
      .sort();
  }

  /**
   * THE TOOLCHAIN, MEASURED. uv, conda and Homebrew where they are, and the
   * Pythons uv can see or fetch. Cached for a few seconds because the page
   * asks for it beside every environment list and each answer is four spawns.
   */
  private toolchainCache?: { until: number; value: Promise<Toolchain> };

  dataScienceToolchain(fresh = false): Promise<Toolchain> {
    if (!fresh && this.toolchainCache && this.now() < this.toolchainCache.until) return this.toolchainCache.value;
    const value = toolchainStatus();
    this.toolchainCache = { until: this.now() + 5_000, value };
    void value.catch(() => { this.toolchainCache = undefined; });
    return value;
  }

  /**
   * Every environment a project could run on, each probed, plus the toolchain
   * and which dependency manifests the checkout carries. A LIST for a person
   * to choose from — see `ds/environments.ts`. Paths are stored RELATIVE when
   * inside the checkout, so a worktree session resolves `.venv/bin/python`
   * against its own tree.
   */
  async dataScienceEnvironments(projectId: string, workspace?: string): Promise<{ toolchain: Toolchain; environments: (PythonEnvironment & { path: string })[]; requirements: RequirementsSource[]; declared?: string[]; currentId?: string }> {
    const project = this.getProject(projectId);
    const base = workspace ?? project.root;
    const toolchain = await this.dataScienceToolchain(true);
    const telarVenv = telarVenvDir(this.paths.root, projectId);
    // The project's own declared dependencies, asked of every interpreter — so
    // the page shows "is what this project needs actually here", not Telar's
    // helper stack presented as the person's problem.
    const declared = declaredDependencies(base);
    const found = await discoverEnvironments(base, { toolchain, ...(telarVenvPython(telarVenv) ? { telarVenv } : {}), ...(declared.length ? { dists: declared } : {}) });
    const environments = found.map((env) => ({ ...env, path: relativisePythonPath(base, env.python) }));
    const current = project.dataScience?.python ? this.currentEnvironment(project, base) : undefined;
    return { toolchain, environments, requirements: projectRequirements(base), ...(declared.length ? { declared } : {}), ...(current ? { currentId: current.id } : {}) };
  }

  /** The environments as `ds_env` lists them: small rows, the one in use flagged. */
  private async dsEnvironmentRows(projectId: string, workspace: string): Promise<EnvironmentRow[]> {
    const { environments, currentId } = await this.dataScienceEnvironments(projectId, workspace);
    return environments.map((env) => ({
      id: env.id,
      name: env.name,
      manager: env.manager,
      root: env.root,
      python: env.python,
      ...(env.preflight.version ? { version: env.preflight.version } : {}),
      inUse: env.id === currentId,
    }));
  }

  /**
   * WHAT THE SETTINGS PAGE'S USE BUTTON DOES, FOR THE AGENT: persist the
   * choice on the project, then restart the session's kernel into it. The
   * fresh capability resolves the new interpreter; its ensure() disposes a
   * kernel running elsewhere. `target` matches an environment's id, name,
   * root or interpreter path from the list.
   */
  async dataScienceUseEnvironment(sessionId: string, target: string): Promise<{ environments: EnvironmentRow[]; switched: string }> {
    const session = this.getSession(sessionId);
    if (!session.projectId) throw new EngineStateError("invalid_request", "this session has no project");
    const workspace = session.workspace.path;
    const { environments } = await this.dataScienceEnvironments(session.projectId, workspace);
    const match = environments.find((env) => env.id === target || env.name === target || env.root === target || env.python === target || env.path === target);
    if (!match) throw new EngineStateError("invalid_request", `no environment matches "${target}" — the choices are ${environments.map((env) => `${env.name} (${env.id})`).join(", ") || "none"}`);
    if (!match.preflight.ok) throw new EngineStateError("invalid_request", `${match.name} is unusable: ${match.preflight.reason}`);
    this.updateProject(session.projectId, {
      dataScience: {
        enabled: true,
        python: {
          source: match.manager === "telar" ? "telar" : "chosen",
          path: match.path,
          resolvedAt: this.now(),
          manager: match.manager,
          root: relativisePythonPath(workspace, match.root),
        },
      },
    });
    await this.dataScience(sessionId).restart();
    return {
      environments: environments.map((env) => ({
        id: env.id,
        name: env.name,
        manager: env.manager,
        root: env.root,
        python: env.python,
        ...(env.preflight.version ? { version: env.preflight.version } : {}),
        inUse: env.id === match.id,
      })),
      switched: match.name,
    };
  }

  /**
   * The environment a project is configured on, as `packages.ts` needs it:
   * manager, root, interpreter. Older configs stored only the path; the
   * manager is read off the directory then (`pyvenv.cfg`, `conda-meta/`).
   */
  private currentEnvironment(project: Project, workspace = project.root): { id: string; manager: EnvManager; root: string; python: string } | undefined {
    const config = project.dataScience?.python;
    if (!config) return undefined;
    const python = resolvePythonPath(workspace, config.path);
    if (!fs.existsSync(python)) return undefined;
    const detected = environmentRootOf(python);
    const root = config.root ? resolvePythonPath(workspace, config.root) : detected?.root ?? path.dirname(python);
    const manager: EnvManager = config.manager ?? (root.startsWith(telarVenvDir(this.paths.root, project.id)) ? "telar" : detected?.manager ?? "system");
    return { id: environmentId(root), manager, root, python };
  }

  /**
   * MAKE AN ENVIRONMENT, as a job. `uv venv` or `conda create` on a Python
   * version the tool fetches if it must, then the stack if asked. A `.venv`
   * in the project is gitignored the way Telar's own files are. The job's
   * result is what to store: path, root, manager, source.
   */
  async dataScienceCreateEnvironment(projectId: string, request: CreateEnvironmentRequest): Promise<{ jobId: string }> {
    const project = this.getProject(projectId);
    const toolchain = await this.dataScienceToolchain(true);
    let plan;
    try {
      // THE MAC'S DEFAULT PACKAGES, applied where they were promised: to an
      // environment TELAR CREATES. Never to one that already exists — a
      // settings field that reached back into somebody's configured venv would
      // be a text box that spends four minutes and several hundred megabytes.
      const defaults = DataScienceMachineSettingsSchema.safeParse(machineSettings(this.machinePlugins(), "data-science"));
      plan = planEnvironment(request, toolchain, {
        projectRoot: project.root,
        telarVenv: telarVenvDir(this.paths.root, projectId),
        ...(defaults.success && defaults.data.packages ? { defaultPackages: defaults.data.packages } : {}),
      });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
    const { root, python } = plan;
    return this.dsJobs.start({
      kind: "create",
      lock: `${projectId}:env`,
      steps: plan.steps,
      onDone: async () => {
        if (!fs.existsSync(python)) throw new Error("the environment was created but has no python executable");
        if (request.manager === "venv" && request.location === "project") {
          try {
            ensureTelarGitignore(project.root, [{ rule: ".venv/", alreadyCovered: [".venv", "/.venv", "/.venv/", ".venv/"], why: "the Python environment uv created for this project" }]);
          } catch { /* not a repo, or unwritable — the venv still works */ }
        }
        const manager: EnvManager = request.manager === "venv" && request.location === "telar" ? "telar" : request.manager;
        return { path: relativisePythonPath(project.root, python), root: relativisePythonPath(project.root, root), manager, source: manager === "telar" ? "telar" : "detected" };
      },
    });
  }

  /** The packages in the project's configured environment. `direct` marks the ones the project declares, when it declares any. */
  async dataSciencePackages(projectId: string, workspace?: string): Promise<{ packages: (PackageInfo & { direct?: boolean })[]; environment: { manager: EnvManager; root: string; python: string; command: InstallCommand } }> {
    const project = this.getProject(projectId);
    const root = workspace ?? project.root;
    const env = this.currentEnvironment(project, workspace);
    if (!env) throw new EngineStateError("invalid_request", "this project has no Python environment configured");
    const toolchain = await this.dataScienceToolchain();
    const declared = new Set(declaredDependencies(root, 500));
    try {
      const packages = (await listPackages(env, toolchain)).map((pkg) => (declared.size ? { ...pkg, direct: declared.has(canonicalName(pkg.name)) } : pkg));
      return { packages, environment: { manager: env.manager, root: env.root, python: env.python, command: installCommandFor(env, toolchain, { root }) } };
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * INSTALL INTO, OR REMOVE FROM, THE PROJECT'S ENVIRONMENT — the one write
   * this feature makes into an environment Telar did not build, and only
   * because a person pressed the button or approved the agent asking. The
   * manager's own tool does the work so a conda env stays solvable.
   */
  async dataScienceInstall(projectId: string, input: { add?: string[]; remove?: string[]; requirements?: RequirementsSource }, workspace?: string): Promise<{ jobId: string }> {
    const project = this.getProject(projectId);
    const env = this.currentEnvironment(project, workspace);
    if (!env) throw new EngineStateError("invalid_request", "this project has no Python environment configured");
    const toolchain = await this.dataScienceToolchain();
    const context = { root: workspace ?? project.root };
    try {
      const steps = [
        ...(input.remove?.length ? removeSteps(env, input.remove, toolchain, context) : []),
        ...(input.add?.length ? installSteps(env, input.add, toolchain, context) : []),
        ...(input.requirements ? [requirementsStep(env, context.root, input.requirements, toolchain)] : []),
      ];
      if (!steps.length) throw new Error("nothing to install or remove");
      return this.dsJobs.start({ kind: "install", lock: `${env.id}:packages`, steps });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * INSTALL A TOOL: uv, a Python version, Miniforge. Homebrew when present,
   * the vendor's installer otherwise. When it lands somewhere PATH does not
   * yet look, that directory is adopted for this process so the next probe
   * and the next kernel find it without a restart.
   */
  async dataScienceBootstrap(request: BootstrapRequest): Promise<{ jobId: string }> {
    const toolchain = await this.dataScienceToolchain(true);
    let plan;
    try {
      plan = planBootstrap(request, toolchain);
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
    const expect = plan.expectBinary;
    return this.dsJobs.start({
      kind: `bootstrap:${request.what}`,
      lock: `bootstrap:${request.what}`,
      steps: plan.steps,
      onDone: () => {
        this.toolchainCache = undefined;
        if (!expect) return {};
        const found = findBinary(expect);
        if (!found) throw new Error(`${expect} was installed but cannot be found — open a new terminal, check your PATH, then detect again`);
        adoptBinaryDir(found);
        return { binary: found };
      },
    });
  }

  dataScienceJob(jobId: string, after?: number): JobRead {
    try {
      return this.dsJobs.read(jobId, after);
    } catch (error) {
      throw new EngineStateError("not_found", error instanceof Error ? error.message : String(error));
    }
  }

  dataScienceCancelJob(jobId: string): void {
    this.dsJobs.cancel(jobId);
  }

  /** Probe ONE interpreter a person typed or picked — the "add an existing
   *  environment" door. Accepts a python binary, a venv or a conda env dir. */
  async dataScienceProbe(projectId: string, target: string): Promise<PythonPreflight & { relativePath?: string; root?: string; manager?: EnvManager }> {
    const project = this.getProject(projectId);
    const resolved = resolvePythonPath(project.root, target.trim());
    const python = telarVenvPython(resolved) ?? resolved;
    const probe = await preflightPython(python, undefined, undefined, declaredDependencies(project.root));
    if (!probe.ok) return probe;
    const env = environmentRootOf(python);
    return {
      ...probe,
      relativePath: relativisePythonPath(project.root, python),
      root: relativisePythonPath(project.root, env?.root ?? path.dirname(python)),
      manager: env?.manager ?? "system",
    };
  }

  /**
   * THE TEX TOOLCHAIN, MEASURED — Tectonic and every TeX Live root. Cached
   * like the Python one and for the same reason: the settings page asks
   * beside every list, and each answer is a fistful of `--version` spawns.
   */
  private latexToolchainCache?: { until: number; value: Promise<LatexToolchain> };

  /**
   * THE MANAGED COPY IS ADDED HERE, NOT DISCOVERED IN THE PROBE.
   * `latexToolchainStatus` looks at PATH and the places installers use; Telar's
   * own Tectonic lives under the engine's state root, which that function has no
   * business knowing about.
   *
   * IT IS OUTSIDE THE CACHE, deliberately, and the cached branch goes through
   * this too. The probe is cached for five seconds because each answer is a
   * fistful of `--version` spawns; the managed status is one `stat`. Letting it
   * ride the cache would leave a pane showing "not installed" for five seconds
   * beside a binary that had just finished downloading — which is exactly the
   * window a person is looking at the pane.
   */
  private withManagedTectonic(probe: Promise<LatexToolchain>): Promise<LatexToolchain> {
    return probe.then((toolchain) => ({ ...toolchain, managed: this.managedTectonic() }));
  }

  latexToolchain(fresh = false): Promise<LatexToolchain> {
    if (!fresh && this.latexToolchainCache && this.now() < this.latexToolchainCache.until) {
      return this.withManagedTectonic(this.latexToolchainCache.value);
    }
    const value = latexToolchainStatus();
    this.latexToolchainCache = { until: this.now() + 5_000, value };
    void value.catch(() => { this.latexToolchainCache = undefined; });
    return this.withManagedTectonic(value);
  }

  /**
   * Every TeX distribution the machine carries, plus the checkout's main-file
   * candidates — `.tex` files carrying `\documentclass`, scanned two directory
   * levels deep and capped, because a thesis has one main file and a monorepo
   * has thousands of files that are not it.
   */
  async latexDistributions(projectId: string): Promise<{ toolchain: LatexToolchain; mainCandidates: string[]; current?: LatexConfig["toolchain"] }> {
    const project = this.getProject(projectId);
    const toolchain = await this.latexToolchain(true);
    const candidates: string[] = [];
    const scan = (dir: string, depth: number) => {
      if (candidates.length >= 50) return;
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (candidates.length >= 50) return;
        if (name.startsWith(".") || name === "node_modules") continue;
        const file = path.join(dir, name);
        let stat: fs.Stats;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.isDirectory()) {
          if (depth > 0) scan(file, depth - 1);
          continue;
        }
        if (!/\.tex$/i.test(name) || stat.size > 2 * 1024 * 1024) continue;
        try {
          if (fs.readFileSync(file, "utf8").includes("\\documentclass")) candidates.push(path.relative(project.root, file));
        } catch { /* unreadable is not a candidate */ }
      }
    };
    scan(project.root, 2);
    return { toolchain, mainCandidates: candidates.sort(), ...(project.latex?.toolchain ? { current: project.latex.toolchain } : {}) };
  }

  /** Install Tectonic or TinyTeX, as a job. Adopts the binary's directory on
   *  success so the next compile finds it without a restart. */
  async latexBootstrap(request: LatexBootstrapRequest): Promise<{ jobId: string }> {
    const toolchain = await this.latexToolchain(true);
    let plan;
    try {
      plan = planLatexBootstrap(request, toolchain);
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
    if (request.what === "tectonic" && !toolchain.brew) {
      try { fs.mkdirSync(path.join(os.homedir(), ".local", "bin"), { recursive: true }); } catch { /* the installer will say so */ }
    }
    const expect = plan.expectBinary;
    return this.latexJobs.start({
      kind: `bootstrap:${request.what}`,
      lock: `bootstrap:${request.what}`,
      steps: plan.steps,
      onDone: () => {
        this.latexToolchainCache = undefined;
        const found = findLatexBinary(expect);
        if (!found) throw new Error(`${expect} was installed but cannot be found — open a new terminal, check your PATH, then detect again`);
        adoptBinaryDir(found);
        return { binary: found };
      },
    });
  }

  /** What the project's distribution has installed — or the honest sentence
   *  about why there is nothing to list. */
  async latexPackages(projectId: string): Promise<LatexPackagesAnswer> {
    const project = this.getProject(projectId);
    const config = project.latex;
    if (!config?.enabled || !config.toolchain) throw new EngineStateError("invalid_request", "this project has no TeX toolchain configured");
    if (config.toolchain.kind === "tectonic") return { mode: "automatic", note: TECTONIC_PACKAGES_NOTE };
    const toolchain = await this.latexToolchain();
    const dist = toolchain.texlive.find((candidate) => candidate.binDir === config.toolchain!.path) ?? toolchain.texlive[0];
    if (!dist) return { mode: "unavailable", reason: "the configured TeX Live was not found on this machine" };
    return listTexPackages(dist);
  }

  /** tlmgr install/remove, as a job. Tectonic projects are refused here — the
   *  settings page never shows the form, and the agent's tool says why. */
  async latexInstall(projectId: string, input: { add?: string[]; remove?: string[] }): Promise<{ jobId: string }> {
    const project = this.getProject(projectId);
    const config = project.latex;
    if (!config?.enabled || !config.toolchain) throw new EngineStateError("invalid_request", "this project has no TeX toolchain configured");
    if (config.toolchain.kind === "tectonic") throw new EngineStateError("invalid_request", TECTONIC_PACKAGES_NOTE);
    const toolchain = await this.latexToolchain();
    const dist = toolchain.texlive.find((candidate) => candidate.binDir === config.toolchain!.path) ?? toolchain.texlive[0];
    if (!dist) throw new EngineStateError("invalid_request", "the configured TeX Live was not found on this machine");
    try {
      const steps = [
        ...(input.remove?.length ? texRemoveSteps(dist, input.remove) : []),
        ...(input.add?.length ? texInstallSteps(dist, input.add) : []),
      ];
      if (!steps.length) throw new Error("nothing to install or remove");
      return this.latexJobs.start({ kind: "tex-packages", lock: `${dist.binDir}:tex-packages`, steps });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
  }

  latexJob(jobId: string, after?: number): JobRead {
    try {
      return this.latexJobs.read(jobId, after);
    } catch (error) {
      throw new EngineStateError("not_found", error instanceof Error ? error.message : String(error));
    }
  }

  latexCancelJob(jobId: string): void {
    this.latexJobs.cancel(jobId);
  }

  /** Coalesce polling reads and keep results briefly. Bounded so browsing patches
   * cannot retain every file's contents for the lifetime of the engine. */
  private readonly gitReadCache = new Map<string, { until: number; value: Promise<unknown> }>();

  private cachedGitRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    for (const [oldKey, entry] of this.gitReadCache) {
      if (this.now() >= entry.until) this.gitReadCache.delete(oldKey);
    }
    const cached = this.gitReadCache.get(key);
    if (cached && this.now() < cached.until) return cached.value as Promise<T>;
    const entry = { until: Infinity, value: Promise.resolve().then(read) as Promise<unknown> };
    while (this.gitReadCache.size >= 64) this.gitReadCache.delete(this.gitReadCache.keys().next().value!);
    this.gitReadCache.set(key, entry);
    void entry.value.then(() => { entry.until = this.now() + 2_000; }, () => { if (this.gitReadCache.get(key) === entry) this.gitReadCache.delete(key); });
    return entry.value as Promise<T>;
  }

  projectGitAsync(projectId: string): Promise<GitOverview> {
    const project = this.getProject(projectId);
    return this.cachedGitRead(`git:${project.root}`, () => gitOverviewAsync(this.asyncGit, project.root));
  }

  projectDiffAsync(projectId: string): Promise<SessionDiff> {
    const project = this.getProject(projectId);
    return this.cachedGitRead(`diff:${project.root}`, () => sessionDiffAsync(this.asyncGit, { cwd: project.root }));
  }

  sessionDiffAsync(sessionId: string): Promise<SessionDiff> {
    const session = this.getSession(sessionId);
    return this.cachedGitRead(`diff:${session.workspace.path}:${session.workspace.baseRef ?? ""}`, () => sessionDiffAsync(this.asyncGit, {
      cwd: session.workspace.path,
      ...(session.workspace.baseRef ? { baseRef: session.workspace.baseRef } : {}),
    }));
  }

  projectFilePatchAsync(projectId: string, target: string, options: { untracked?: boolean } = {}): Promise<{ patch: string; binary: boolean }> {
    const project = this.getProject(projectId);
    return this.readFilePatchAsync(project.root, target, options);
  }

  sessionFilePatchAsync(sessionId: string, target: string, options: { untracked?: boolean } = {}): Promise<{ patch: string; binary: boolean }> {
    const session = this.getSession(sessionId);
    return this.readFilePatchAsync(session.workspace.path, target, options, session.workspace.baseRef);
  }

  private readFilePatchAsync(cwd: string, target: string, options: { untracked?: boolean }, baseRef?: string): Promise<{ patch: string; binary: boolean }> {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(cwd, target);
    const prefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the workspace");
    return this.cachedGitRead(`patch:${cwd}:${baseRef ?? ""}:${resolved}:${!!options.untracked}`, () => sessionFilePatchAsync(this.asyncGit, {
      cwd,
      path: path.relative(cwd, resolved),
      ...(baseRef ? { baseRef } : {}),
      ...(options.untracked ? { untracked: true } : {}),
    }));
  }

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
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") throw new EngineStateError("invalid_request", "unknown provider driver");
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
    // Remembered from the PROVIDER's list, before the reader's overlay: hiding
    // a row in the picker is curation, not a statement about what the CLI runs.
    if (driver === "claude") this.rememberClaudeDefault(raw.models);
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
      const stored = this.readDocument(this.paths.modelOverlays) as { overlays?: unknown } | undefined;
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
        const raw = this.readDocument(this.paths.modelOverlays) as { overlays?: unknown } | undefined;
        const parsed = ModelOverlaySchema.array().safeParse(raw?.overlays ?? []);
        return parsed.success ? parsed.data : [];
      } catch {
        // A document nobody can parse is replaced by this write rather than
        // blocking it — the same stance the getter takes on the way in.
        return [];
      }
    })();
    const overlays = [...stored.filter((entry) => entry.instanceId !== instanceId), next];
    this.writeDocument(this.paths.modelOverlays, { version: STATE_VERSION, overlays });
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

  /**
   * Take those rules back out — the Undo behind the toast that reports them.
   *
   * IT EXISTS BECAUSE THE WRITE STOPPED ASKING. Registering a project now ignores
   * Telar's files by default (the switch in the old Register dialog became a
   * default), and a write into somebody's repository that nobody opted into needs
   * a way back that is as cheap as the way in.
   */
  undoProjectGitignore(projectId: string): GitignoreRemoval {
    return removeTelarGitignore(this.getProject(projectId).root);
  }

  /**
   * CLONE A REPOSITORY AND REGISTER WHAT LANDED — the Sources palette's "Git URL"
   * and "GitHub repository" rows, in one request.
   *
   * ONE CALL RATHER THAN TWO, because the cockpit cannot name the path in between:
   * it hands over a URL and a parent folder, and only the engine knows which
   * directory `git clone` created. Splitting it would mean answering a path to a
   * client whose next call would be "now register this path I did not choose".
   *
   * THE CLONE IS NOT UNDONE WHEN THE REGISTRATION FAILS. The checkout on disk is
   * the expensive half and it is perfectly good; `registerProject` refuses for
   * reasons a person can act on (a root already registered under another name),
   * and deleting somebody's fresh clone to tidy up after that would be the worst
   * possible reading of the error.
   */
  cloneProject(input: { url: string; parent: string; name?: string }): Project {
    const outcome = cloneRepository(this.git, { url: input.url, parent: input.parent });
    if (isCloneFailure(outcome)) {
      throw new EngineStateError(outcome.code === "failed" ? "invalid_request" : outcome.code, outcome.message);
    }
    const folder = outcome.root.split("/").pop() ?? outcome.root;
    return this.registerProject({ name: input.name?.trim() || folder, root: outcome.root });
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
  projectFilesAsync(projectId: string): Promise<WorkspaceListing> {
    const cwd = this.getProject(projectId).root;
    return this.cachedGitRead(`files:${cwd}`, () => listWorkspaceFilesAsync(this.asyncGit, { cwd, now: this.now() }));
  }

  sessionFilesAsync(sessionId: string): Promise<WorkspaceListing> {
    const cwd = this.getSession(sessionId).workspace.path;
    return this.cachedGitRead(`files:${cwd}`, () => listWorkspaceFilesAsync(this.asyncGit, { cwd, now: this.now() }));
  }

  projectFileAsync(projectId: string, target: string): Promise<WorkspaceFile> {
    return this.readFencedAsync(this.getProject(projectId).root, target, "project");
  }

  sessionFileAsync(sessionId: string, target: string): Promise<WorkspaceFile> {
    return this.readFencedAsync(this.getSession(sessionId).workspace.path, target, "session workspace");
  }

  /**
   * One file's BYTES — what the cockpit's media viewers (image, PDF, video)
   * render. The same fence as the text read, because the same client can name
   * the same paths; only the answer differs: content and a media type instead
   * of decoded text. Refused past `MAX_RAW_FILE_BYTES` — see files.ts.
   */
  projectFileBytesAsync(projectId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return this.readFencedBytes(this.getProject(projectId).root, target, "project");
  }

  sessionFileBytesAsync(sessionId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return this.readFencedBytes(this.getSession(sessionId).workspace.path, target, "session workspace");
  }

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
  private readFenced(root: string, target: string, label: string, maxBytes?: number): WorkspaceFile {
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
    return readWorkspaceFile({ cwd: root, path: path.relative(root, resolved), ...(maxBytes ? { maxBytes } : {}) });
  }

  private async readFencedAsync(root: string, target: string, label: string): Promise<WorkspaceFile> {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(root, target);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolved);
    } catch {
      throw new EngineStateError("not_found", "no such file in this workspace");
    }
    if (stats.isDirectory()) throw new EngineStateError("invalid_request", "that path is a directory");
    if (!stats.isFile()) throw new EngineStateError("invalid_request", "that path is not a regular file");
    return readWorkspaceFileAsync({ cwd: root, path: path.relative(root, resolved) });
  }

  /** The bytes twin of `readFencedAsync` — same fence, same refusals, whole
   *  content instead of decoded text. Size errors become `invalid_request` so
   *  the route answers with the sentence rather than a 500. */
  private async readFencedBytes(root: string, target: string, label: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(root, target);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolved);
    } catch {
      throw new EngineStateError("not_found", "no such file in this workspace");
    }
    if (stats.isDirectory()) throw new EngineStateError("invalid_request", "that path is a directory");
    if (!stats.isFile()) throw new EngineStateError("invalid_request", "that path is not a regular file");
    try {
      return await readWorkspaceFileBytes({ cwd: root, path: path.relative(root, resolved) });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : "the file could not be read");
    }
  }

  /**
   * The same fence, for the one write.
   *
   * DELIBERATELY NOT SHARED WITH `readFenced` beyond the check itself: a read that
   * cannot find a file is a 404, while a write that cannot is a REFUSAL the editor
   * renders inline (`not_found`), so the two disagree about what a missing file
   * means and merging them would have to invent a third answer.
   */
  private writeFenced(root: string, target: string, text: string, expected: string, label: string, maxBytes?: number): WorkspaceWriteResult {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    if (!expected.trim()) throw new EngineStateError("invalid_request", "a write must carry the hash it expects on disk");
    if (text.length > (maxBytes ?? MAX_TEXT_LENGTH * 10)) throw new EngineStateError("invalid_request", "that file is too large to save");
    const resolved = path.resolve(root, target);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", `that path is outside the ${label}`);
    return writeWorkspaceFile({ cwd: root, path: path.relative(root, resolved), text, expected, ...(maxBytes ? { maxBytes } : {}) });
  }

  createSession(input: {
    draft?: boolean;
    id?: string;
    projectId: string;
    /**
     * WHO STARTED THIS SESSION. Supplied by the daemon from the creating turn's
     * CLAIM TOKEN, never from a tool argument — see `Session.startedFrom`.
     * Permanent, and no lifetime or permission travels with it.
     */
    startedFrom?: { sessionId: string; runId?: string };
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
     * WHO ASKED — provenance, not a link and not a count. `"session"` means
     * this came through the `sessions` toolkit or its socket, so a list can
     * say an agent asked for it; absent (or `"human"`) is a person's own
     * click. NOTHING IS CAPPED ON IT: there used to be a live-session budget
     * here, and it was removed when a session was allowed to orchestrate
     * many — how many sessions an agent may hold open is a rule for the
     * agent's own instructions, not a number in the store.
     *
     * DECLARED BY THE CALLER'S OWN CODE, never by a model argument — no tool
     * shape on the wall carries it, exactly as `SpoolItem.source` works.
     */
    origin?: SessionOrigin;
  }): Session {
    if (input.id !== undefined) assertId(input.id, "session id");
    const project = this.getProject(input.projectId);
    this.assertProjectAvailable(input.projectId);
    const id = input.id ?? `session_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = sessionMetadataFile(this.paths, id);
    const existing = this.readDocument(metadata);
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
     * THE PROJECT IS ASKED BEFORE THE MACHINE, and that order is the whole of
     * what a per-project answer means. It is the same ladder every setting in
     * this engine uses — the most specific thing that has an opinion wins — and
     * absence at each rung is a real answer rather than a missing one: a project
     * with no `envMode` is not saying "local", it is saying "whatever this Mac
     * says", which is why a stored `"local"` and no stored value at all are
     * different states and the record keeps them apart.
     *
     * THE PREFERENCE YIELDS ON AN UNVERSIONED PROJECT — and so does the
     * project's own answer, for the same reason. `createSessionWorktree` refuses
     * a directory that is not a git repo: correct for a caller who ASKED for a
     * worktree, and wrong for one who asked for nothing and would otherwise be
     * unable to open a session in that project at all. A project that pinned
     * `worktree` is still expressing a PREFERENCE rather than an instruction —
     * nobody typed it for this session — so it falls back like the machine's.
     * A stated `worktree` on the call still throws.
     */
    const preferred = project.envMode ?? this.getSessionDefaults().envMode;
    const envMode = input.envMode ?? (preferred === "worktree" && isGitWorkTree(this.git, project.root) ? "worktree" : "local");
    if (input.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(input.baseRef)) {
      throw new EngineStateError("invalid_request", "base ref is not a usable git ref name");
    }
    const chosen = input.providerInstanceId === undefined ? undefined : this.requireProviderInstance(input.providerInstanceId);
    const driver = chosen?.driver ?? input.driver ?? "claude";
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") throw new EngineStateError("invalid_request", "unknown provider driver");
    if (chosen && !chosen.enabled) throw new EngineStateError("conflict", "that provider instance is switched off");
    // The worktree is cut BEFORE the session document is written. A session
    // whose workspace does not exist is unusable and would have to be repaired
    // on read; failing here leaves nothing behind to repair.
    const workspace: Session["workspace"] =
      envMode === "worktree" && !input.draft
        ? (() => {
            const branchSlug = input.branchSlug ?? derivedBranchFor(input.title ?? "", id);
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
      ...(input.startedFrom
        ? { startedFrom: { sessionId: input.startedFrom.sessionId, ...(input.startedFrom.runId ? { runId: input.startedFrom.runId } : {}) } }
        : {}),
      createdAt: at,
      updatedAt: at,
      // The instance is the ROUTING key and the driver is descriptive, so the
      // two are derived together here rather than picked independently — a
      // session routed to Claude while claiming to be a Codex session is the
      // one inconsistency this split exists to make impossible.
      providerInstanceId: chosen?.id ?? defaultInstanceIdForDriver(driver),
      driver,
      /**
       * THE PROJECT'S DEFAULT MODEL, when it names one this session can run.
       *
       * GUARDED ON THE INSTANCE rather than applied blind: a selection is a
       * MODEL ON A LOGIN, so a Claude default carried onto a session the caller
       * routed to Codex would name a model that login has never heard of. The
       * project's answer therefore applies when this session lands on the login
       * it was stored against, and is silently not applied otherwise — which is
       * the honest outcome, because the reader's sentence was "conversations in
       * this project open on THIS", and this is not that conversation.
       */
      ...(project.defaultModel && project.defaultModel.instanceId === (chosen?.id ?? defaultInstanceIdForDriver(driver))
        ? { model: project.defaultModel }
        : {}),
      workspace,
      envMode,
      ...(input.draft ? { draft: {
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.branchSlug ? { branchSlug: input.branchSlug } : {}),
      } } : {}),
      runtimeMode: detached ? DEFAULT_DETACHED_RUNTIME_MODE : DEFAULT_ATTENDED_RUNTIME_MODE,
      interactionMode: "default",
      detached,
      // Derived on every read (`withActivity`) and stripped before every write
      // (`storedSession`); named here only because the wire shape requires it,
      // and a session with no queue yet is genuinely idle.
      activity: "idle",
    };
    this.writeDocument(metadata, storedSession(session));
    // Through `writeQueue` like every other queue write: an id reused after a
    // delete must not find the old session's cached queue waiting for it.
    this.writeQueue(id, emptyQueue(id));
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
      /** `null` returns the session to the driver's default rather than storing
       *  one — see `Session.resumeAfterRateLimit`. Three answers, so not a
       *  boolean: "on", "off", and "whatever this provider does". */
      resumeAfterRateLimit?: boolean | null;
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
        next.model = this.normalizeModelSelection(session.driver, parsed.data);
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
        releaseDelegationSettle(next);
      } else if (patch.settledOverride === "settled" || patch.settledOverride === "active") {
        /**
         * A DECISION IN EITHER DIRECTION IS NOW THE PERSON'S — issue #378.
         *
         * `settledBy` describes an engine settle, and both of these replace it:
         * "active" contradicts it outright, and "settled" relabels the same
         * shelf as somebody's own choice. Leaving the stamp would have the row
         * explaining a decision nobody made.
         *
         * "settled" DOES NOT RECORD THE ERRAND, and the asymmetry is the point:
         * `releaseDelegationSettle` exists to stop the engine re-shelving a row
         * a person pulled back, and a person who settled it is not asking for
         * that protection.
         */
        if (patch.settledOverride === "settled") delete next.settledBy;
        else releaseDelegationSettle(next);
        next.settledOverride = patch.settledOverride;
        next.settledAt = this.now();
      } else {
        throw new EngineStateError("invalid_request", "settledOverride must be 'settled', 'active' or null");
      }
    }
    if (patch.resumeAfterRateLimit !== undefined) {
      if (patch.resumeAfterRateLimit === null) delete next.resumeAfterRateLimit;
      else if (typeof patch.resumeAfterRateLimit === "boolean") next.resumeAfterRateLimit = patch.resumeAfterRateLimit;
      else throw new EngineStateError("invalid_request", "resumeAfterRateLimit must be a boolean or null");
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
      next.resumeAfterRateLimit === session.resumeAfterRateLimit &&
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
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(next));
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
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(updated));
    this.appendEvent(sessionId, { type: "session.updated", session: updated });
    return next;
  }

  /**
   * A HUMAN SAW THIS ANSWER — recorded here rather than in a browser, for the
   * same reason the settling overrides are: the same session is read from the
   * desktop shell, a phone and a browser tab, and an inbox that disagrees with
   * itself per client is not an inbox.
   *
   * THE RECEIPT NAMES A TURN, NEVER A CLOCK. A client that sent "read as of
   * now" would consume whatever finished between the render it was reporting
   * on and the request landing — precisely the answer nobody has seen. Naming
   * the turn makes that unrepresentable: the receipt can only ever be about
   * the turn that was on screen.
   *
   * MONOTONIC BY SEQUENCE, so a late receipt is a no-op rather than a
   * regression. Two tabs, a retry after a dropped response and a slow request
   * that lands after the next turn finished all reduce to "the highest
   * sequence anybody has confirmed", which only moves forward.
   *
   * THE SET OF ELIGIBLE TURNS IS `isResultTurn`'S — the same set
   * `lastTurnSequence` is derived from, so every sequence a client is told is
   * unread is a sequence it can also mark read. A receipt for a turn that is
   * still running, was steered, discarded or belongs to another session is
   * refused rather than quietly accepted.
   */
  markSessionRead(sessionId: string, runId: string): Session {
    assertId(runId, "run id");
    const session = this.getSession(sessionId);
    const turn = this.readQueue(sessionId).turns.find((entry) => entry.runId === runId);
    if (!turn || !isResultTurn(turn)) {
      throw new EngineStateError("invalid_request", "read receipt must name a completed, failed or stopped turn in this session");
    }
    if (turn.sequence <= (session.lastReadTurnSequence ?? 0)) return session;
    session.lastReadTurnSequence = turn.sequence;
    session.readAt = this.now();
    /**
     * `updatedAt` IS DELIBERATELY NOT TOUCHED. It dates the session's work,
     * and the inactivity clock is measured from it — so stamping it here would
     * mean opening a settled session pushed it back into the list, and reading
     * a row would restart the very clock that is supposed to shelve it. Being
     * read is a fact about the reader, not about the session; `readAt` is
     * where the inactivity rule picks it up instead.
     */
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.updated", session });
    return structuredClone(session);
  }

  getSession(sessionId: string): Session {
    const stored = this.readDocument(sessionMetadataFile(this.paths, sessionId));
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
    /**
     * READ OFF A DIFFERENT QUESTION THAN `lastTurnEndedAt`, and the split is
     * the fix rather than an accident. `lastTurnEndedAt` dates the last thing
     * that ENDED, which is what the early-wake rule wants. `lastTurnSequence`
     * names the last thing that left an ANSWER, which is what unread wants —
     * and a session whose newest ended turn was a steered message or a
     * discarded recovery would otherwise report a sequence no client can ever
     * mark read, so it would sit unread forever and never settle.
     */
    const result = lastResultTurn(turns);
    const base: Session = {
      ...session,
      ...(ended?.completedAt === undefined ? {} : { lastTurnEndedAt: ended.completedAt }),
      ...(result === undefined ? {} : { lastTurnSequence: result.sequence }),
      ...(ended?.state === "failed" ? { lastTurnFailed: true } : {}),
    };
    // Only a request whose turn can still take the answer blocks the session;
    // one left on an ended turn is retired at the next boot sweep meanwhile.
    const settledRuns = new Set(turns.filter((turn) => turn.state === "completed" || turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded").map((turn) => turn.runId));
    const open = [...this.readRequests(session.id).values()].filter((request) => request.state === "open" && !settledRuns.has(request.runId));
    if (open.length > 0) {
      // The OLDEST open request, not the newest: it dates how long this session
      // has been waiting, which is the number that should embarrass us.
      const since = Math.min(...open.map((request) => request.openedAt));
      return { ...base, activity: "blocked", activityAt: since };
    }
    const running = turns.find((turn) => turn.state === "running");
    if (running) return { ...base, activity: "working", activityAt: running.startedAt ?? running.updatedAt };
    // A HELD MESSAGE IS NOT "QUEUED": nothing is about to pick it up. A
    // paused session with a backlog reads as idle to the activity fold; the
    // pause itself is on the record (`paused`), and clients say so from it.
    const waiting = turns.find((turn) => (turn.state === "queued" && !turn.held) || turn.state === "claimed");
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
    if (this.executionStore) return this.executionStore.sessionIds().map((id) => this.getSession(id))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
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
   * LIVE MEANS `state: "active"`. An archived session is finished, and a
   * toolkit that listed it would offer a model something it cannot drive.
   *
   * NO BRANCH DERIVATION, unlike `listProjects`: that costs a `git rev-parse`
   * per project and nothing in this answer renders a branch.
   *
   * THE ARRANGEMENT RIDES ALONG, and that is what makes a drag on one device
   * reach the others. `sidebar-layout.json` is one document per Mac, but until
   * now nothing told a second device it had changed — a phone kept its copy
   * until its rail reloaded, and then wrote that stale copy back on its next
   * drop. This route is the one read EVERY rail already makes on its own
   * cadence (3s live, 10s idle on both clients), so carrying the layout here
   * costs no request, no timer and no connection anywhere, and every device
   * converges within one polling pass. See `SidebarLayout`.
   */
  liveSessions(): {
    sessions: Session[];
    projects: Array<{ id: string; name: string }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
  } {
    const registry = this.readDocument(this.paths.projects);
    const projects = registry === undefined ? [] : parseRegistry(registry).projects;
    const sessions = this.readSessions().filter((session) => session.state === "active");
    /**
     * ASSIGNMENTS RIDE THE LIST, not a fetch per row.
     *
     * The sidebar reads this one route each polling pass. Asking it to fetch
     * every session's full history to learn who each is working for would be an
     * N+1 over whole transcripts — the most expensive read in the engine,
     * repeated per session, per poll. One pass over the queues answers it here.
     */
    const assignments: Record<string, SessionAssignment[]> = {};
    for (const session of sessions) {
      const held = this.sessionAssignments(session.id);
      if (held.length > 0) assignments[session.id] = held;
    }
    return {
      sessions,
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      assignments,
      layout: this.getSidebarLayout(),
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
   *
   * REQUESTS FOLLOW THEIR TURNS TOO, plus every OPEN one wherever it sits.
   * They were the one key that ignored the window: on the dogfood store the
   * largest session's snapshot carried 549 requests / 315 KB, of which 44
   * belonged to the window and zero were unresolved — 292 KB, re-read every
   * second per open cockpit, that nothing could render. An open request rides
   * along regardless of the page because an unanswered question on a paged-out
   * turn must still reach the composer, and it rides along on EVERY page
   * because a client replaces the key rather than merging it
   * (`SessionSyncEngine.swift`).
   */
  snapshotWindow(sessionId: string, window: { limit: number; before?: string }): {
    turns: Turn[];
    items: Item[];
    tasks: Task[];
    requests: EngineRequest[];
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
      requests: [...this.readRequests(sessionId).values()].filter((request) => chosen.has(request.runId) || request.state === "open"),
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
  putAttachment(sessionId: string, input: { name: string; mediaType: string; data: Uint8Array; tags?: string[]; producer?: string; title?: string }): TurnAttachment {
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
    const attachment: TurnAttachment = {
      id, name, mediaType, bytes: input.data.byteLength, path: file, createdAt: this.now(),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.producer ? { producer: input.producer } : {}),
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
    };
    const index = this.readAttachments(sessionId);
    index.set(id, attachment);
    this.writeDocument(attachmentsFile(this.paths, sessionId), { version: STATE_VERSION, attachments: [...index.values()] });
    return structuredClone(attachment);
  }

  private readAttachments(sessionId: string): Map<string, TurnAttachment> {
    const stored = this.readDocument(attachmentsFile(this.paths, sessionId)) as { attachments?: unknown } | undefined;
    const parsed = TurnAttachmentSchema.array().safeParse(stored?.attachments ?? []);
    // A corrupt index costs the ABILITY TO REFERENCE old attachments, not the
    // session. Throwing here would make one bad record unopenable forever.
    return new Map((parsed.success ? parsed.data : []).map((attachment) => [attachment.id, attachment]));
  }

  submitTurn(
    sessionId: string,
    input: {
      runId: string;
      input: string;
      kind?: "message" | "compact";
      model?: TurnModelSelection;
      attachments?: string[];
      /**
       * NOT THE PERSON'S WORDS. `origin: "session"` comes two ways and needs
       * exactly one companion:
       *   - `wakeReason`: a WAKE, set by `fireSubscriptions` and nobody else.
       *   - `sender`: a DIRECT MESSAGE from an agent (`sessions_send`), set
       *     by `submitAgentTurn` after checking the sender's claim.
       * The HTTP route never reads `origin` or `wakeReason` from a body, so a
       * cockpit cannot forge a wake; `sender` it accepts only with proof.
       */
      agentIntent?: Turn["agentIntent"];
      agentDelivery?: Turn["agentDelivery"];
      agentSourceRunId?: string;
      /** The short line the MODEL reads in place of `input` — minted by
       *  `submitAgentTurn` and by nothing else. See `Turn.agentNotice`. */
      agentNotice?: string;
      assignmentScope?: string;
      origin?: "session";
      wakeReason?: WakeReason;
      sender?: { sessionId?: string };
    },
  ): { turn: Turn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.input);
    const companions = Number(input.wakeReason !== undefined) + Number(input.sender !== undefined);
    if (input.origin === "session" ? companions !== 1 : companions !== 0) {
      throw new EngineStateError("invalid_request", "a session-origin turn carries exactly one of a wake reason or a sender, and only such a turn does");
    }
    const kind = input.kind === "compact" ? "compact" : undefined;
    const session = this.getSession(sessionId);
    if (kind === "compact" && !PROVIDER_CAPABILITIES[session.driver].compaction)
      throw new EngineStateError("conflict", "this provider does not support manual compaction");
    const queue = this.readQueue(sessionId);
    const known = queue.turns.find((turn) => turn.runId === input.runId);
    if (known) {
      if (known.input !== input.input) throw new EngineStateError("conflict", "run id was already submitted with different text");
      return { turn: structuredClone(known), replayed: true };
    }
    if (input.origin === "session" && session.agentMessagesBlocked) {
      throw new EngineStateError("conflict", "this session was stopped by its user; agent messages cannot restart it. Wait for a new human message.");
    }
    /**
     * NO NEW WORK ON A PUT-AWAY PROJECT — and this is the line that makes that
     * true for the turns nobody typed. A peer's subscription firing an hour
     * from now arrives here as an `origin: "session"` wake, and without this it
     * would start a provider on a project the person removed. `fireSubscriptions`
     * already treats a `conflict` as "the subscriber cannot take this" and
     * writes the reason to that session's own journal, so the wake is dropped
     * visibly rather than lost.
     */
    if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
    /**
     * A MESSAGE WHILE A TURN RUNS IS A STEER, not a queued follow-up. This
     * went through three shapes: a conflict (the human waited), then a queue
     * with a "Send now" button (the human chose), and now what T3 Code does
     * and what every running CLI does when you type at it — the words go
     * into the live turn the moment they arrive, and the same turn continues.
     * The steer is attempted at the bottom of this method; the cases where it
     * cannot happen (nothing running, the provider compacting, a claim not yet
     * marked running) leave the turn `queued`, where the worker picks it up as
     * the next turn. So `queued` is the fallback, never the plan.
     *
     * Only ONE turn executes at a time and that has not changed: `claimTurn`
     * refuses while any turn is claimed or running, and picks the OLDEST queued
     * one. The cap below counts everything waiting — queued or mid-steer — so
     * a runaway client cannot grow the queue file without bound.
     */
    const passive = input.origin === "session" && input.agentDelivery === "passive";
    const queued = queue.turns.filter((turn) => turn.state === "queued" || turn.state === "steering").length;
    if (!passive && queued >= MAX_QUEUED_TURNS) {
      throw new EngineStateError("conflict", "session already has the maximum number of queued turns");
    }
    /**
     * AN AMBIGUOUS TURN NO LONGER REFUSES THE HUMAN'S NEXT MESSAGE, and the
     * refusal that used to live here was the whole of the reported bug.
     *
     * It read "session has an ambiguous turn that must be resolved first" and
     * it was on the wrong verb. Measured before the change: a session that lost
     * a turn to a restart accepted NO new message, so the only way forward was
     * the recovery card's "Retry", which resubmits the ORIGINAL prompt — and
     * the thing a person actually wanted, "carry on from what you have", was
     * the one thing the engine would not take. Meanwhile the same ambiguity did
     * not stop `claimTurn` from dispatching work queued BEFORE the crash, so
     * un-reviewed pre-crash messages resumed the provider conversation with
     * nobody's decision behind them. Exactly backwards.
     *
     * The invariant the refusal was reaching for is real, and it now lives on
     * `claimTurn` where it belongs: nothing EXECUTES in this session until a
     * human has decided about the ambiguous turn. Accepting a message costs
     * nothing and settles nothing; running one is the act that can duplicate a
     * side effect.
     */

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
      ...(input.origin === "session" && input.wakeReason ? { origin: "session" as const, wakeReason: input.wakeReason } : {}),
      ...(input.origin === "session" && input.sender
        ? { origin: "session" as const, sender: input.sender.sessionId ? { sessionId: input.sender.sessionId } : {} }
        : {}),
      ...(input.agentIntent ? { agentIntent: input.agentIntent } : {}),
      ...(input.agentDelivery ? { agentDelivery: input.agentDelivery } : {}),
      ...(input.agentSourceRunId ? { agentSourceRunId: input.agentSourceRunId } : {}),
      ...(input.agentNotice ? { agentNotice: input.agentNotice } : {}),
      ...(input.assignmentScope ? { assignmentScope: input.assignmentScope } : {}),
      ...(passive ? { completedAt: at, resultText: "" } : {}),
      state: passive ? "completed" : "queued",
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
            model: this.normalizeModelSelection(session.driver, {
              instanceId: session.providerInstanceId,
              // EITHER MAY BE ABSENT. "The provider's default model, at maximum
              // effort" is an ordinary thing to ask for, and spreading rather
              // than assigning is what keeps it from being stored as an
              // explicit `undefined` the engine would then hand to a driver.
              ...(input.model.model ? { model: input.model.model } : {}),
              ...(input.model.effort ? { effort: input.model.effort } : {}),
              ...(input.model.fastMode === undefined ? {} : { fastMode: input.model.fastMode }),
            }),
          }
        : {}),
    };
    if (session.draft) {
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
      if (kind === "compact") throw new EngineStateError("conflict", "a browser draft has no conversation to compact");
      if (session.envMode === "worktree") {
        if (!session.projectId) throw new EngineStateError("conflict", "a worktree draft requires a project");
        const project = this.getProject(session.projectId);
        const cut = createSessionWorktree(this.git, {
          engineRoot: this.paths.root, projectRoot: project.root, sessionId,
          branchSlug: session.draft.branchSlug ?? derivedBranchFor(input.input, sessionId),
          ...(session.draft.baseRef ? { baseRef: session.draft.baseRef } : {}),
          ...(session.draft.branchName ? { branchName: session.draft.branchName } : {}),
        });
        session.workspace = { mode: "worktree", path: cut.path, branch: cut.branch, baseRef: cut.baseRef };
      }
      if (session.title === "Browser draft") session.title = input.input.replace(/\s+/g, " ").slice(0, 80);
      delete session.draft;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    }
    /**
     * PAUSED MEANS PAUSED. Every message that arrives while a human has the
     * session paused — theirs, an agent's, a wake — is accepted and HELD, in
     * order, behind whatever was already waiting. It is not steered into a
     * running turn (there is none the pause allows) and it is not dispatched
     * ahead of the backlog: a fresh message that jumped the queue would be
     * the pause silently releasing itself. Resume, or release it by hand.
     */
    if (session.paused && !passive) turn.held = { at, reason: "session_paused" };
    if (input.origin !== "session" && kind !== "compact" && session.agentMessagesBlocked) {
      delete session.agentMessagesBlocked;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    }
    queue.turns.push(turn);
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    // Queueing a message is a human saying they are not done with this after
    // all, so any shelf or snooze it was under is lifted.
    if (!passive) this.wakeSessionForNewWork(sessionId);
    // v1 emitted only `{ sequence }` here, which is why the client had to fetch
    // a snapshot to learn the prompt. The whole turn rides the event now.
    this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
    if (passive) {
      // Delivery completed, not a model turn: never claim, steer, or notify
      // subscribers about a routine report. The payload remains inspectable.
      this.appendEvent(sessionId, { type: "turn.completed", resultText: "" }, turn.runId);
      return { turn: structuredClone(turn), replayed: false };
    }
    // A compaction is a gesture on the session, not words for the running
    // model; it always waits its turn.
    if (kind !== "compact" && !session.paused && PROVIDER_CAPABILITIES[session.driver].liveSteering) {
      const steered = this.steerIfRunning(sessionId, turn.runId);
      if (steered) return { turn: steered, replayed: false };
    }
    return { turn: structuredClone(turn), replayed: false };
  }

  /**
   * DEPRECATED — A COMPATIBILITY ALIAS FOR `stopSession`.
   *
   * There is no persistent pause any more. It meant "stop, and stay stopped
   * until a human presses Resume", and the person it was built for said the
   * plainest possible thing about it: hitting stop should stop a session, not
   * put it in a pause for them to resume. Stop is stop, from every origin —
   * the button, this route, `sessions_stop`, a crash, an update.
   *
   * KEPT AS A NAME so an older client (a phone that has not updated, a script)
   * calling `/pause` gets the behaviour the app now has rather than a 404 or,
   * far worse, a latch nothing in the product knows how to lift. It returns
   * the old shape: `held` is always 0, because nothing is held any more, and
   * `already` is always false, because there is no latch to be already in.
   *
   * `by` is ignored. It distinguished a human's pause from an agent's, and the
   * two are now the same verb with the same result — which is the whole point
   * of the change.
   */
  pauseSession(sessionId: string, _by: "human" | "session" = "human"): { session: Session; stopped?: Turn; held: number; already: boolean } {
    const session = this.getSession(sessionId);
    if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
    const { live } = this.stopSession(sessionId);
    return { session: this.withActivity(structuredClone(this.getSession(sessionId))), ...(live ? { stopped: live } : {}), held: 0, already: false };
  }

  /**
   * DEPRECATED, AND INERT IN PRACTICE. Nothing sets `paused` any more and boot
   * clears any latch left on disk, so there is no pause left to lift and no
   * held message left to release. Kept so an older client's `/resume` answers
   * instead of erroring, and so a latch written by a build older than this one
   * still has a way off in the window before the next restart.
   *
   * IT RELEASES ONLY WHAT AN OLD PAUSE HELD (`held.reason === "session_paused"`),
   * which is the one case where running the messages IS what the person asked
   * for: they pressed Resume. Nothing else here starts work.
   *
   * Historically: a human resumes; the pause comes off and every message it
   * held is released, in its original order — the worker's next heartbeat
   * claims the oldest.
   *
   * WHAT "HUMAN ONLY" ACTUALLY MEANS HERE, stated exactly: the sessions tool
   * wall has no resume, and the worker's client (`WorkerClient`) cannot call
   * this, so no session — Claude in-process, Codex over the socket, a chat
   * client on the outward sessions socket — can lift a pause through Telar's
   * agent surfaces. It is NOT a security boundary: `/resume` answers to the
   * engine's ordinary bearer, and an agent with a shell and the engine's
   * `engine.json` could POST it, exactly as it could POST anything else on
   * this API. Telar has no separate trusted-UI credential to gate it on, and
   * inventing one is not this fix.
   */
  resumeSession(sessionId: string): { session: Session; released: number; already: boolean } {
    const session = this.getSession(sessionId);
    if (!session.paused) return { session: this.withActivity(structuredClone(session)), released: 0, already: true };
    if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
    const at = this.now();
    const queue = this.readQueue(sessionId);
    const released: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.state !== "queued" || turn.held?.reason !== "session_paused") continue;
      delete turn.held;
      turn.updatedAt = at;
      released.push(turn);
    }
    if (released.length > 0) this.writeQueue(sessionId, queue);
    delete session.paused;
    session.updatedAt = at;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    for (const turn of released) this.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
    this.appendEvent(sessionId, { type: "session.resumed", released: released.length });
    this.appendEvent(sessionId, { type: "session.updated", session });
    return { session: this.withActivity(structuredClone(session)), released: released.length, already: false };
  }

  /**
   * A DIRECT MESSAGE FROM AN AGENT — `sessions_send`, from inside a turn or
   * from a chat client on the sessions socket.
   *
   * THE SENDER IS PROVEN, NOT DECLARED. A turn's `sessions_send` arrives with
   * the claim token of the turn doing the sending; it names the sender only if
   * that claim is live. Without proof the message is still an agent's — it
   * simply has no session to be attributed to (the outward socket's case) —
   * and it is NEVER recorded as the person's. Measured before this existed:
   * an orchestrator's `sessions_send` landed on the worker as an ordinary
   * `submitTurn`, was stored with no origin at all, drew as the human's own
   * bubble and reached the provider as the user speaking — a peer's report
   * dressed as an instruction from the person, with nobody having decided
   * anything.
   */
  submitAgentTurn(
    sessionId: string,
    input: { runId: string; input: string; attachments?: string[]; intent?: Turn["agentIntent"]; scope?: string },
    proof?: { sessionId: string; runId: string; claimToken: string },
  ): { turn: Turn; replayed: boolean } {
    let sender: { sessionId?: string } = {};
    if (proof) {
      assertId(proof.sessionId, "sender session id");
      const claimed = this.requireSenderClaim(proof);
      sender = { sessionId: claimed.sessionId };
    }
    const intent = input.intent ?? "report";
    /**
     * IS ANYONE AWAITING THIS SENDER'S END? That question decides the DELIVERY
     * of a `result` — awaited, it wakes; unawaited, it is passive activity.
     *
     * IT DOES NOT SPEND THE SUBSCRIPTION (#240). A worker routinely sends a
     * result MID-TASK and keeps going; consuming the one-shot here meant the
     * `turn_completed` that actually ended the errand had no subscription left
     * to fire on, and the coordinator waited for an end that never came — twice
     * in one day before this was found. Only a TERMINAL event removes a `once`
     * now, in `fireSubscriptions`, which is the one place that knows a turn
     * ended.
     */
    const waiting = intent === "result" && sender.sessionId
      ? this.readSubscriptions().find((sub) => sub.subscriberSessionId === sessionId && sub.targetSessionId === sender.sessionId && sub.events.includes("turn_completed"))
      : undefined;
    const delivery = intent === "task" || intent === "blocker" || waiting ? "wake" : "passive";
    /**
     * THE NOTICE IS MINTED HERE, ONCE, AND STORED — see `agent-notice.ts`.
     *
     * Here rather than in a driver or a client because this is the only place
     * that knows all of it at once: the recipient (so the fetch call can name
     * the session whose turn holds the body), the run id being created, the
     * proven sender, and the intent the delivery was decided from. And STORED
     * rather than derived on read because a turn's presentation must not depend
     * on which reader computed it — the provider prompt, the desktop row, the
     * phone and a later `sessions_read` all quote this same string.
     *
     * MINTED FOR EVERY INTENT, including the passive ones that never reach a
     * model: the transcript row collapses to this line whatever the delivery
     * was, and a report whose row had to invent its own summary would be the
     * per-reader drift this field exists to prevent.
     */
    const scope = intent === "task" ? input.scope : undefined;
    const result = this.submitTurn(sessionId, {
      runId: input.runId, input: input.input,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      origin: "session", sender, agentIntent: intent, agentDelivery: delivery,
      ...(proof ? { agentSourceRunId: proof.runId } : {}),
      agentNotice: agentNotice({
        recipientSessionId: sessionId, runId: input.runId, body: input.input, intent,
        ...(sender.sessionId ? { sender } : {}),
        ...(scope ? { scope } : {}),
      }),
      // Only a TASK carries a scope. A report that named one would read as an
      // assignment in every surface that folds these turns.
      ...(scope ? { assignmentScope: scope } : {}),
    });
    return result;
  }

  /**
   * The steer half of `submitTurn`: when a turn is RUNNING, the just-accepted
   * turn goes straight into it. `promoteTurn` holds the rules (a claim that
   * is running, no compaction in flight) and its refusals are exactly the
   * cases that should fall back to `queued`, so they are swallowed here and
   * nothing else is.
   */
  private steerIfRunning(sessionId: string, runId: string): Turn | undefined {
    const running = this.readQueue(sessionId).turns.some((candidate) => candidate.state === "running" && candidate.claim);
    if (!running) return undefined;
    try {
      return this.promoteTurn(sessionId, runId);
    } catch (error) {
      if (error instanceof EngineStateError && error.code === "conflict") return undefined;
      throw error;
    }
  }

  claimTurn(sessionId: string, workerId: string): Turn | undefined {
    assertId(workerId, "worker id");
    // A PAUSED SESSION DISPATCHES NOTHING — checked on the record, not
    // inferred from held flags, so a message that slipped into `queued`
    // unheld by any path still cannot run. See `pauseSession`.
    if (this.getSession(sessionId).paused) return undefined;
    const queue = this.readQueue(sessionId);
    if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) return undefined;
    /**
     * AN UNDECIDED AMBIGUOUS TURN HOLDS THIS SESSION'S DISPATCH.
     *
     * This is where the recovery gate belongs — `submitTurn` used to carry it,
     * which refused the human and let the machine through. A backlog written
     * BEFORE the crash was claimed and run against the resumed provider
     * conversation while the ambiguity was still undecided: measured, a
     * `steering` follow-up requeued by `recover()` was handed the lost run's
     * `resumeCursor` and dispatched with no human anywhere near it.
     *
     * Held rather than dropped. The messages keep their place and their order,
     * and they run the moment the human resolves the ambiguous turn — which is
     * also the moment somebody has decided whether the work they assumed had
     * happened actually did. A queued turn is not lost by waiting; a turn that
     * runs against a conversation nobody vouched for cannot be un-run.
     */
    if (queue.turns.some((turn) => turn.state === "ambiguous")) return undefined;
    /**
     * A HELD MESSAGE IS SKIPPED, NOT WAITED ON. It was written before the turn
     * this session lost, so it waits for a human to re-read it — but it must
     * not stand in front of a message written AFTER, which is the whole
     * substance of continuing a recovered conversation. Order is preserved
     * among the turns that may actually run.
     */
    const turn = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
    if (!turn) return undefined;
    const at = this.now();
    turn.state = "claimed";
    // The watermark rides the claim: everything submitted from here on was
    // written against a session the person had reason to think was live.
    turn.claim = { workerId, token: crypto.randomUUID(), at, sequence: queue.nextSequence };
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.claimed", workerId }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * A TURN THE PROVIDER STARTED, opened as a real turn.
   *
   * The CLI process lives between turns and can run a model turn of its own
   * there — a monitor fired, the CLI woke the model on the notification, the
   * model spoke and called tools. This is what T3 Code calls a synthetic
   * turn. It is born `running` under a fresh claim: the process is already
   * talking, so there is nothing to queue and nothing for a worker to pick
   * up; the claim exists so the turn's requests, observations and completion
   * ride the very routes a human turn's do, gate included. Refused while any
   * turn of the session is live — one turn per session is the invariant every
   * sweep relies on, and a wake-up arriving mid-turn is the running turn's
   * own stream, not a second one.
   */
  openProviderTurn(sessionId: string, input: { workerId: string; input: string; reason: NonNullable<Turn["providerReason"]> }): Turn {
    assertId(input.workerId, "worker id");
    // The CLI woke itself on a background task, but the human paused the
    // session: no turn opens. The driver parks the frames; a `conflict` is
    // what it already reads as "not now".
    if (this.getSession(sessionId).paused) throw new EngineStateError("conflict", "session is paused");
    const queue = this.readQueue(sessionId);
    if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) {
      throw new EngineStateError("conflict", "session already has a live turn");
    }
    const at = this.now();
    const turn: Turn = {
      runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
      sessionId,
      sequence: queue.nextSequence++,
      input: input.input.slice(0, MAX_TEXT_LENGTH),
      origin: "provider",
      providerReason: input.reason,
      state: "running",
      acceptedAt: at,
      startedAt: at,
      updatedAt: at,
      claim: { workerId: input.workerId, token: crypto.randomUUID(), at },
    };
    queue.turns.push(turn);
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    // The same three events a human turn produces, in one breath: tailing
    // clients fold a provider turn with the code they already have.
    this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
    this.appendEvent(sessionId, { type: "turn.claimed", workerId: input.workerId }, turn.runId);
    this.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * TASK REPORTS WITH NO TURN TO CLAIM. Between turns the CLI still speaks
   * about its background work — the level signal, a notification for a shell
   * that fired, a Ctrl+B — and until the pump read between turns those frames
   * waited for the next human message (a monitor's ending sat unheard for ten
   * hours, measured). They fold onto the rows they name exactly as a turn's
   * would; the `runId` is the stored row's, since a task belongs to the turn
   * that started it. A report for a row the store has never seen is dropped
   * rather than minted under no turn at all — the driver's own `task_started`
   * inside a turn is the only thing that opens a row.
   */
  reportSessionTasks(sessionId: string, workerId: string, observations: unknown[]): { accepted: number } {
    assertId(workerId, "worker id");
    this.getSession(sessionId);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "task observations are invalid");
    const tasks = this.readTasks(sessionId);
    const projection = { items: this.readItems(sessionId), tasks, itemsTouched: false, tasksTouched: false, turnTouched: false };
    let accepted = 0;
    for (const observation of parsed.data) {
      if (observation.kind !== "task.started" && observation.kind !== "task.progress" && observation.kind !== "task.completed") continue;
      const seed = observation.task;
      const known =
        tasks.get(seed.id) ?? (seed.providerTaskId ? [...tasks.values()].find((task) => task.providerTaskId === seed.providerTaskId) : undefined);
      if (!known) continue;
      // `journalObservation` takes the owning turn only for its runId.
      this.journalObservation(sessionId, { runId: known.runId } as Turn, observation, projection);
      accepted += 1;
    }
    if (projection.tasksTouched) {
      this.writeTasks(sessionId, projection.tasks);
      this.touchSession(sessionId, this.now());
    }
    return { accepted };
  }

  /** Claims exactly one queued turn. The daemon has one state lock, so two workers cannot claim it twice. */
  /**
   * Would THIS turn run Claude with no model of its own, on a cold catalogue?
   * Asked at admission so `prepareClaudeCatalogue` runs only when it is needed:
   * a Codex session, or a turn that names a model, never makes the machine read
   * a Claude CLI it may not have installed.
   */
  claudeAdmissionNeedsCatalogue(sessionId: string, turnModel?: { model?: string }): boolean {
    if (turnModel?.model) return false;
    const session = this.getSession(sessionId);
    return session.driver === "claude" && !session.model?.model && this.defaultClaudeModelId() === undefined;
  }

  /**
   * WHAT TO DO WITH A CLAUDE TURN THAT NAMED NO MODEL.
   *
   * Telar publishes only long-window rows, so running one of these on the CLI's
   * own default means a window the person removed from their picker. That is
   * not a fallback, so there are only three answers:
   *
   *  - `"ready"`     the default is known; claim it and run.
   *  - `"pending"`   not known yet. NOT CLAIMABLE — skipped in the scan, so no
   *                  lease is taken and nothing waits inside one. Other
   *                  sessions and other providers are untouched.
   *  - `"failed"`    the list could not be read. The turn fails with something
   *                  actionable rather than running at the wrong window or
   *                  waiting for ever; no provider is ever started for it.
   */
  private claudeSelectionState(driver: ProviderDriverKind, selection: ModelSelection | undefined): "ready" | "pending" | "failed" {
    if (driver !== "claude" || selection?.model) return "ready";
    if (this.defaultClaudeModelId() !== undefined) return "ready";
    // A failure is only current for as long as the probe stays refused; after
    // that this is pending again and `prepareClaudeCatalogue` tries afresh, so
    // a transient outage is not a permanent verdict.
    const failedFor = this.claudeCatalogueFailedAt === undefined ? undefined : this.now() - this.claudeCatalogueFailedAt;
    return failedFor !== undefined && failedFor < MODEL_CACHE_MS ? "failed" : "pending";
  }

  /** Settle a never-claimed turn as failed. Mirrors `failTurn`'s shape without
   *  a claim, because there is deliberately no worker involved. */
  private failQueuedTurn(sessionId: string, queue: SessionQueue, turn: Turn, message: string): void {
    const at = this.now();
    turn.state = "failed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.failure = { code: "provider_unavailable", message };
    const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
    this.writeQueue(sessionId, queue);
    // This turn's own bookkeeping only: no worker ran, so there are no items or
    // tasks of its own, and background work belongs to whatever else is running.
    this.closeOpenRequests(sessionId, turn.runId, at);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    // A coordinator waiting on this session hears the failure like any other.
    this.fireSubscriptions(sessionId, "turn_failed", turn, { failure: turn.failure });
  }

  /**
   * Learn the long-window default this machine will run.
   *
   * ONE PROBE IN FLIGHT, and an unusable answer is remembered rather than
   * retried on every poll. Nothing here lets a turn run on a window Telar does
   * not publish: until this succeeds the turn is withheld, and if it cannot
   * succeed the turn fails saying so.
   */
  async prepareClaudeCatalogue(timeoutMs = 2_000): Promise<void> {
    // USABLE, not merely read: a list that parses but publishes no long row
    // (Haiku-only, or empty) is as unusable as no list, and returning early on
    // a populated cache would leave those turns pending with nothing left to
    // try. One marker covers every way this can fail.
    if (this.defaultClaudeModelId() !== undefined) return;
    if (this.claudeCatalogueFailedAt !== undefined && this.now() - this.claudeCatalogueFailedAt < MODEL_CACHE_MS) return;
    const unusable = (reason: string) => {
      this.claudeCatalogueFailedAt = this.now();
      console.error(`[engine] no long-window Claude model could be resolved, so a session that named no model cannot run: ${reason}`);
    };
    this.claudeCataloguePrepare ??= this.modelCatalogue("claude").then(
      () => {
        // Late or on time, one question decides it: did this produce a row
        // Telar can run? A late success clears a timeout's verdict.
        if (this.defaultClaudeModelId() !== undefined) this.claudeCatalogueFailedAt = undefined;
        else unusable("the provider listed no long-window model");
      },
      (error) => unusable(error instanceof Error ? error.message : String(error)),
    );
    const probe = this.claudeCataloguePrepare;
    void probe.finally(() => {
      if (this.claudeCataloguePrepare === probe) this.claudeCataloguePrepare = undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await Promise.race([
      probe,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    // A probe that never answers must not leave turns pending for ever: the
    // verdict is bounded and retried like any other, and the probe is left
    // running so its late answer still counts.
    if (timedOut && this.defaultClaudeModelId() === undefined) unusable(`the provider did not answer within ${timeoutMs}ms`);
  }

  /**
   * DOES THIS SESSION WANT ITS RATE-LIMITED TURNS RESUMED?
   *
   * Absent means yes for Claude and no for anything else — the default is not
   * written into the record, so a session created before the setting existed
   * behaves like one created after it, and a provider that starts reporting
   * limits the same way later begins resuming without a migration. Only an
   * explicit choice is stored.
   */
  private resumesAfterRateLimit(session: Session): boolean {
    return session.resumeAfterRateLimit ?? session.driver === "claude";
  }

  /**
   * REQUEUE A TURN WHOSE USAGE LIMIT HAS LIFTED, or record that we decided not
   * to. Called for every live session on every claim poll — see `claimNextTurn`.
   *
   * CHEAP ON THE COMMON PATH: the shared scan copy answers "is anything due
   * here", and only a session that actually has one takes a queue of its own to
   * write. The overwhelming majority of sessions have no rate-limited failure at
   * all and cost one `some()` over their turns.
   */
  private sweepRateLimited(sessionId: string): void {
    const at = this.now();
    const due = (turn: Turn): boolean => awaitsRateLimitSweep(turn) && turn.failure!.resumeAt! <= at;
    if (!this.scanQueue(sessionId).turns.some(due)) return;

    const session = this.getSession(sessionId);
    /**
     * A PAUSED OR ARCHIVED SESSION IS NOT SWEPT, AND IS NOT STAMPED EITHER.
     *
     * Leaving the decision unmade is the point: the person comes back, lifts the
     * pause, and the turn resumes on the next poll. Stamping it here would mean
     * a session paused across its own reset time silently lost the resume it was
     * promised, with nothing on the row to say so.
     */
    if (session.paused || session.state === "archived") return;

    const queue = this.readQueue(sessionId);
    const resuming = this.resumesAfterRateLimit(session);
    const requeued: Turn[] = [];
    for (const turn of queue.turns) {
      if (!due(turn)) continue;
      turn.failure = { ...turn.failure!, resumeDecidedAt: at };
      turn.updatedAt = at;
      if (!resuming) continue;
      /**
       * BACK TO `queued`, KEEPING ITS PLACE. `acceptedAt` and `sequence` are
       * untouched, so a backlog that built up behind the limit still runs in the
       * order it was typed rather than the resumed turn jumping to the front.
       *
       * THE FAILURE IS KEPT, not deleted, and `resumedAfterRateLimit` is what
       * makes that safe: the transcript needs it to draw the row saying the turn
       * came back, and `awaitsRateLimitSweep` no longer matches it because the
       * state is no longer `failed`. Deleting it would erase the only record
       * that the session ever hit a limit.
       */
      turn.state = "queued";
      turn.resumedAfterRateLimit = at;
      delete turn.completedAt;
      delete turn.claim;
      requeued.push(turn);
    }
    this.writeQueue(sessionId, queue);
    for (const turn of requeued) {
      this.appendEvent(sessionId, { type: "turn.requeued", reason: "rate_limit_reset" }, turn.runId);
    }
    // THE SESSION COMES BACK TO THE LIST when its own work restarts, the same
    // way a wake does: a limit that lifted at 3am should not leave the session
    // shelved with a turn quietly running inside it.
    if (requeued.length > 0) {
      this.wakeSessionForNewWork(sessionId);
      this.touchSession(sessionId, at);
    }
  }

  claimNextTurn(workerId: string): WorkerClaim | undefined {
    assertId(workerId, "worker id");
    /**
     * ONLY THE SESSIONS THAT COULD BE CLAIMED, and only their queues.
     *
     * This walked every session on disk and read each one's metadata purely to
     * sort by `createdAt` — a cost that grew with the number of conversations
     * ever created and was paid on every claim. The candidates are now drawn
     * from the live index, and the ONE session that wins is the only one whose
     * metadata is read.
     *
     * ORDERED BY WHEN THE MESSAGE WAS ACCEPTED rather than by when its session
     * was created. That is what "oldest first, so a backlog runs in the order
     * it was typed" always meant; sorting by session age merely approximated it
     * and let an old session's brand-new message jump ahead of a new session's
     * older one.
     */
    const candidates: Array<{ sessionId: string; acceptedAt: number }> = [];
    for (const sessionId of [...this.liveQueueSessionIds()]) {
      /**
       * THE RATE-LIMIT SWEEP RUNS FIRST, so a turn whose limit has just lifted
       * is `queued` by the time this scan looks for claimable work — otherwise
       * it would wait a whole extra poll for no reason.
       *
       * HERE RATHER THAN ON A TIMER OF ITS OWN because this is already the
       * engine's only periodic pass over live queues, and a second scheduler
       * would be a second thing to start, stop and get wrong at shutdown.
       * `liveQueueSessionIds()` is copied above because this may write, and
       * writing maintains the very index being iterated.
       */
      this.sweepRateLimited(sessionId);
      // A SCAN, so the shared copy: the one session that wins is claimed
      // through `claimTurn`, which reads a queue of its own to write.
      const queue = this.scanQueue(sessionId);
      // One turn per session at a time — the engine's own invariant, checked
      // here so a busy session costs nothing further.
      if (queue.turns.some((candidate) => candidate.state === "claimed" || candidate.state === "running")) continue;
      // Held for a human decision — `claimTurn` is authoritative about this and
      // would refuse anyway; skipping here keeps a held session from being the
      // candidate that wins the sort and then claims nothing, which would stall
      // every OTHER session's queued work behind it for a poll interval.
      if (queue.turns.some((candidate) => candidate.state === "ambiguous")) continue;
      // `!held` matches `claimTurn`'s own choice — a session whose only queued
      // work is held has nothing to offer, and listing it as a candidate would
      // win the sort and then claim nothing.
      const next = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
      if (!next) continue;
      // `claimTurn` refuses a paused session; skipping it here keeps it from
      // winning the sort and stalling every other session for a poll.
      const session = this.getSession(sessionId);
      if (session.paused) continue;
      /**
       * A CLAUDE TURN WITH NO MODEL IS NOT CLAIMABLE UNTIL ITS WINDOW IS KNOWN.
       * Decided here, before a candidate exists, so no lease is taken and
       * nothing is awaited inside one. Every other session keeps moving.
       */
      const selection = this.claudeSelectionState(session.driver, next.model ?? session.model);
      if (selection === "pending") {
        // One probe in flight for the whole engine, never one per tick.
        void this.prepareClaudeCatalogue();
        continue;
      }
      if (selection === "failed") {
        // The one branch of this scan that WRITES, so it takes a queue of its
        // own rather than editing the copy every other reader is sharing.
        const own = this.readQueue(sessionId);
        const failing = own.turns.find((candidate) => candidate.runId === next.runId);
        if (failing) {
          this.failQueuedTurn(
            sessionId,
            own,
            failing,
            "Telar could not resolve a long-context Claude model, so it cannot tell which context window this session would run. Nothing was sent to the provider. Pick a model for this session from the composer's model picker, or send again to retry.",
          );
        }
        continue;
      }
      candidates.push({ sessionId, acceptedAt: next.acceptedAt });
    }
    candidates.sort((left, right) => left.acceptedAt - right.acceptedAt || left.sessionId.localeCompare(right.sessionId));
    for (const candidate of candidates) {
      const turn = this.claimTurn(candidate.sessionId, workerId);
      if (!turn) continue;
      const session = this.getSession(candidate.sessionId);
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
      // Normalised HERE TOO, because a record saved before the window became a
      // control is read here without ever passing through a patch — and the
      // claim is the one place that decides what actually runs.
      const model = this.claimModelSelection(session.driver, turn.model ?? session.model, session.providerInstanceId ?? defaultInstanceIdForDriver(session.driver));
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
       * the next daemon. Goes to the providers that arrive without a desktop of
       * their own — Claude and OpenCode, never Codex — see `withComputerUse`.
       * Absent installs inject nothing, silently, and the unfiltered
       * `registered` list means a user's own entry (even a DISABLED one) is a
       * decision this must not overrule.
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
        ...(session.projectId ? { projectId: session.projectId } : {}),
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
        // The project's opt-in, resolved with the worktree rule. Absent means
        // the toolkits do not register for this turn.
        ...(() => {
          const ds = this.resolveDataScience(session);
          return ds ? { dataScience: ds } : {};
        })(),
        // The LaTeX opt-in, resolved the same way. Only the kind travels: the
        // worker needs presence to register the toolkit, and the kind keeps
        // the tools honest about how packages behave.
        ...(() => {
          const latex = this.resolveLatex(session);
          return latex ? { latex: { kind: latex.kind } } : {};
        })(),
        // Every other plugin the project turned on, as ids — the arm that does
        // not grow when a third feature arrives.
        ...(() => {
          const ids = this.enabledPluginIds(session);
          return ids.length > 0 ? { plugins: ids } : {};
        })(),
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
        // The session's LIVE task rows, so a provider process built cold
        // files a still-running shell's report on the row that exists rather
        // than minting a second one. Settled rows have nothing to report on.
        ...(() => {
          const live = [...this.readTasks(session.id).values()].filter(isLiveTask).map(taskSeedOf);
          return live.length > 0 ? { tasks: live } : {};
        })(),
        /**
         * THE ORIENTATION PARAGRAPH, RESOLVED HERE. The decision ("is this
         * machine's preamble on") and the words are both the engine's, and the
         * claim carries the OUTCOME — the same rule `mcpServers` follows, for
         * the same reason: a worker trusted to apply a flag would be a second
         * place the rule lives. Absent means off, and the drivers inject
         * nothing.
         */
        ...(this.getAgentOrientation().preamble ? { orientation: TELAR_ORIENTATION } : {}),
        turn,
      };
    }
    return undefined;
  }

  /**
   * The default Claude row Telar publishes, read synchronously or not at all.
   *
   * The CLI's own default put through the manifest the picker uses, so it is
   * the `[1m]` spelling of the family the provider would have chosen anyway.
   * WINDOW ONLY: never a different family, never an invented id.
   *
   * `claimNextTurn` is synchronous on purpose (see `refreshProviderToken`), so
   * this reads the in-memory catalogue and nothing else. Cold yields
   * `undefined` — `prepareClaudeCatalogue` is what makes it warm in time.
   */
  private defaultClaudeModelId(): string | undefined {
    const cached = this.modelCache.get("claude");
    if (cached) return longDefaultOf(applyModelManifest(cached.models, this.manifest));
    // COLD MEMORY, WARM DISK. Reading the list spawns the provider's CLI, which
    // a synchronous claim cannot do and a user's first message must not wait
    // for. The last list this machine actually read is remembered instead, so a
    // restart is covered from its very first turn; the background refresh on
    // admission keeps it current.
    return this.rememberedClaudeDefault();
  }

  /** The remembered default, or nothing. Never throws: a damaged record costs
   *  the long window on one turn, not the ability to work. */
  private rememberedClaudeDefault(): string | undefined {
    if (this.claudeDefaultMemo !== undefined) return this.claudeDefaultMemo || undefined;
    let remembered: string | undefined;
    try {
      const stored = this.readDocument(this.paths.claudeDefault) as { model?: unknown } | undefined;
      if (typeof stored?.model === "string" && /\[1m\]$/i.test(stored.model)) remembered = stored.model;
    } catch {
      remembered = undefined;
    }
    this.claudeDefaultMemo = remembered ?? "";
    return remembered;
  }

  /** Remember what the provider just said its default was, when it is a row
   *  Telar would publish. Written only on change. */
  private rememberClaudeDefault(models: ModelCatalogue["models"]): void {
    const model = longDefaultOf(applyModelManifest(models, this.manifest));
    if (!model || model === this.rememberedClaudeDefault()) return;
    this.claudeDefaultMemo = model;
    try {
      this.writeDocument(this.paths.claudeDefault, { model, at: this.now() });
    } catch {
      // A machine that cannot write this still runs; it just re-learns the
      // default after each restart instead of remembering it.
    }
  }

  /**
   * A Claude selection in the spelling Telar offers — see `normalizeClaudeModel`.
   * Other drivers are never touched; there is no window to spell. Absent stays
   * absent here: filling one in is the CLAIM's job, not a patch's.
   */
  private normalizeModelSelection<T extends ModelSelection | undefined>(driver: ProviderDriverKind, selection: T): T {
    if (!selection || driver !== "claude" || !selection.model) return selection;
    const model = normalizeClaudeModel(selection.model, this.manifest);
    return model === selection.model ? selection : { ...selection, model };
  }

  /**
   * WHAT THE WORKER IS ACTUALLY HANDED, model-wise.
   *
   * An absent Claude model reaches the SDK as no `model` option at all, so the
   * CLI picks its own default — measured in a Dev store as a 200k window on
   * every absent-model session, while every `[1m]` one ran 1M. The driver's
   * `CLAUDE_CODE_DISABLE_1M_CONTEXT=0` only PERMITS the long window; the id
   * selects it.
   *
   * An effort-only or fastMode-only selection keeps what it named and gains the
   * model, so "the default model at maximum effort" still means that.
   */
  private claimModelSelection(
    driver: ProviderDriverKind,
    selection: ModelSelection | undefined,
    instanceId: string,
  ): ModelSelection | undefined {
    const normalized = this.normalizeModelSelection(driver, selection);
    if (driver !== "claude" || normalized?.model) return normalized;
    const model = this.defaultClaudeModelId();
    // Nothing known: unchanged. A guess here would be the 200k bug wearing a
    // different hat.
    if (!model) return normalized;
    // `instanceId` is required on a selection, so it comes from the session
    // rather than being conjured — an absent selection has none of its own.
    return { ...(normalized ?? {}), instanceId: normalized?.instanceId ?? instanceId, model };
  }

  /**
   * INVARIANT: a message submitted after a turn was claimed is steered into
   * THAT turn, at the first moment there is a provider to steer into.
   *
   * `steerIfRunning` needs a turn that is `running` with a claim, because that
   * is what proves a provider exists — `claimed` proves the opposite, by
   * design (`worker.ts` marks the turn running before it builds the driver, so
   * recovery may requeue a merely-claimed turn). A message arriving in that
   * window therefore could not steer and nothing reconsidered it; it ran later
   * as a turn of its own, though the person had typed it into a live session.
   *
   * The boundary is `claim.sequence`, the queue's own submission order — not a
   * clock, which cannot separate two messages in one millisecond and can run
   * backwards. Turns below the watermark are the pre-claim backlog and stay
   * queued. A re-claim takes a new watermark, so a target that was requeued
   * and claimed again does not inherit the old window's messages.
   *
   * Eligibility is `promoteInQueue`'s, not a second opinion: held, compaction
   * and compacting-target refusals are skipped here rather than reimplemented.
   */
  private promoteClaimWindow(sessionId: string, queue: SessionQueue, running: Turn, at: number): Turn[] {
    const watermark = running.claim?.sequence;
    if (watermark === undefined) return [];
    const promoted: Turn[] = [];
    for (const turn of queue.turns) {
      if (turn.state !== "queued" || turn.sequence < watermark) continue;
      try {
        this.promoteInQueue(sessionId, queue, turn, running, at);
      } catch (error) {
        // A refusal is "this one waits", never a failure to start the turn:
        // the message keeps its place in the queue and runs in its own right.
        if (error instanceof EngineStateError && error.code === "conflict") continue;
        throw error;
      }
      promoted.push(turn);
    }
    return promoted;
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
    // A pause needs no check of its own: `pauseSession` holds every queued
    // turn AND stops the live one under this same lock, so a pause before this
    // call has already made the guard above refuse, and one after it sweeps an
    // ordinary running turn. Held turns are refused by `promoteInQueue`.
    const promoted = this.promoteClaimWindow(sessionId, queue, turn, at);
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
    // AFTER `turn.started`, so a client reading the journal in order never sees
    // a message steered into a turn it has not yet been told began.
    for (const late of promoted) this.appendEvent(sessionId, { type: "turn.steering", intoRunId: turn.runId }, late.runId);
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
    const projection = { items: this.readItems(sessionId), tasks: this.readTasks(sessionId), itemsTouched: false, tasksTouched: false, turnTouched: false };
    for (const observation of parsed.data) {
      this.journalObservation(sessionId, turn, observation, projection);
    }
    /**
     * THE SAME RULE ITEMS WERE THE EXCEPTION TO.
     *
     * A `content.delta` deliberately does not touch this projection — that is
     * why the deltas are journalled and the text folded in at `item.completed`
     * — and yet every batch rewrote the whole document anyway. On a session
     * holding 327 items that is 750 KB re-serialised and re-stored per streamed
     * token-chunk, which measured as the largest single cost of a streaming
     * turn: 2.09 ms per delta, against 0.11 ms for the journal insert it was
     * wrapped around.
     */
    if (projection.itemsTouched) this.writeItems(sessionId, projection.items);
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
    this.fireSubscriptions(sessionId, "turn_completed", turn, { resultText: input.text });
    // AFTER THE WAKE, NOT BEFORE. A coordinator's turn completing is what makes
    // its wake "consumed", and this session may be that coordinator — see
    // `evaluateDelegationSettling`.
    this.evaluateDelegationSettling(sessionId);
    return structuredClone(turn);
  }

  /**
   * RESUME NOW — a person deciding not to wait for the limit.
   *
   * THE CLOCK IS DELIBERATELY NOT CHECKED. "I know something you don't" is the
   * whole reason the button exists: another credential came free, the proxy
   * moved account, the provider lifted it early. Refusing until `resumeAt`
   * would make the control a decoration on the only occasions it is wanted.
   *
   * `resumedAfterRateLimit` IS NOT SET. That field means the engine brought the
   * turn back on its own; a person pressing a button is already visible as the
   * press, and claiming otherwise would put a small lie in the record.
   *
   * A HUMAN GESTURE like release and discard, so no claim token — and like
   * `releaseHeldTurn` it answers to the project gate, because resuming is
   * starting work and a project the person removed from Telar must not be
   * resumed into.
   */
  resumeRateLimitedTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const session = this.getSession(sessionId);
    if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    if (turn.state !== "failed" || turn.failure?.code !== "rate_limited") {
      throw new EngineStateError("conflict", "turn is not waiting for a usage limit");
    }
    // One turn at a time is the engine's own invariant; a resume that produced
    // a second live turn would be the one place it could be broken by a click.
    if (queue.turns.some((candidate) => candidate.state === "claimed" || candidate.state === "running")) {
      throw new EngineStateError("conflict", "the session is already running a turn");
    }
    const at = this.now();
    turn.state = "queued";
    turn.updatedAt = at;
    // Stamped decided, so the sweep does not consider it again and the session
    // leaves the live index by the ordinary route once this turn settles.
    turn.failure = { ...turn.failure, resumeDecidedAt: at };
    delete turn.completedAt;
    delete turn.claim;
    this.writeQueue(sessionId, queue);
    this.appendEvent(sessionId, { type: "turn.requeued", reason: "rate_limit_resumed" }, turn.runId);
    this.wakeSessionForNewWork(sessionId);
    this.touchSession(sessionId, at);
    return structuredClone(turn);
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: TurnFailure["code"]; message: string; resumeAt?: number; limitType?: TurnFailure["limitType"] },
  ): Turn {
    if (!TURN_FAILURE_CODES.has(failure.code) || typeof failure.message !== "string" || !failure.message.trim()) {
      throw new EngineStateError("invalid_request", "turn failure is invalid");
    }
    /**
     * `rate_limited` WITHOUT A RESUME TIME IS REFUSED, rather than stored as a
     * wait nobody can schedule. The whole of the code's meaning is "come back
     * at this instant"; a row saying "waiting for the limit to reset" with no
     * instant would sit failed for ever while claiming to be temporary, and the
     * sweep's own predicate would skip it silently. The driver only throws with
     * a reset time, so reaching this is a contract violation, not a user error.
     */
    const resumeAt =
      typeof failure.resumeAt === "number" && Number.isFinite(failure.resumeAt) && failure.resumeAt >= 0
        ? Math.trunc(failure.resumeAt)
        : undefined;
    if (failure.code === "rate_limited" && resumeAt === undefined) {
      throw new EngineStateError("invalid_request", "a rate-limited failure must say when the limit resets");
    }
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const at = this.now();
    turn.state = "failed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.failure = {
      code: failure.code,
      message: failure.message.slice(0, 4_000),
      // Only on the code that means them: a `driver_failed` carrying a reset
      // time would be a row inviting a resume that nothing will ever perform.
      ...(failure.code === "rate_limited" && resumeAt !== undefined ? { resumeAt } : {}),
      ...(failure.code === "rate_limited" && failure.limitType ? { limitType: failure.limitType } : {}),
    };
    const requeued = this.requeueUndeliveredSteers(queue, turn.runId, at);
    /**
     * A SHUTDOWN'S UNDELIVERED MESSAGES ARE HELD, like any other pre-crash
     * backlog — and they were the one route around that rule.
     *
     * `recover()` marks the hold when it finds an AMBIGUOUS turn, which is what
     * a lost run becomes when nobody settled it. But a clean quit now settles
     * its run here, as `interrupted`, so the next boot sees a terminal turn,
     * marks nothing, and claims the requeued steer immediately. Measured: a
     * message typed while the lost turn was running was dispatched on the next
     * launch with nobody having re-read it — exactly the thing the hold exists
     * to prevent, reached by the path that was supposed to be the safe one.
     *
     * ONLY FOR `interrupted`. An ordinary failure happens with the person
     * there, watching, and the session left idle: their in-flight message
     * running next is what they are expecting. A shutdown means they walked
     * away, and what they come back to should wait for them.
     */
    if (failure.code === "interrupted") {
      for (const reverted of requeued) reverted.held = { at, reason: "engine_restart" };
    }
    this.writeQueue(sessionId, queue);
    // A failed turn means the provider process died — background shells died
    // with it, whichever turn started them.
    this.closeLiveTasks(sessionId, at, "the turn failed before this agent reported back", { includeBackground: true });
    this.closeOpenItems(sessionId, turn.runId, at);
    this.closeOpenRequests(sessionId, turn.runId, at);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    this.fireSubscriptions(sessionId, "turn_failed", turn, { failure: turn.failure });
    // A FAILED TURN STILL ENDS ONE. It never makes this session settleable —
    // clause 1 refuses a failed assignment — but the session may be the
    // COORDINATOR whose delegate is now waiting on nothing.
    this.evaluateDelegationSettling(sessionId);
    return structuredClone(turn);
  }

  /**
   * End session-owned work at this command boundary, including legacy held
   * messages and background tasks. Delivered steering stays in history.
   * Queue terminal states fence late claims, observations and completions
   * before cancellation is delivered to the provider. No Resume is required.
   * Detached project services are owned outside this session task store.
   */
  stopSession(sessionId: string, by: "user" | "agent" = "user"): { stopped: Turn[]; live?: Turn } {
    const session = this.getSession(sessionId);
    const queue = this.readQueue(sessionId);
    const at = this.now();
    const live = queue.turns.find((turn) => turn.state === "claimed" || turn.state === "running");
    const stopped = queue.turns.filter((turn) =>
      turn.state === "queued" || turn.state === "claimed" || turn.state === "running" ||
      turn.state === "steering" || turn.state === "ambiguous",
    );
    for (const turn of stopped) {
      turn.state = "stopped";
      turn.stopReason = by;
      turn.completedAt = at;
      turn.updatedAt = at;
      delete turn.steer;
      delete turn.held;
    }
    if (stopped.length > 0) this.writeQueue(sessionId, queue);
    // A peer must not undo a human Stop by immediately sending another turn.
    // A fresh human message clears this gate; no discarded work is replayed.
    if (by === "user") {
      session.agentMessagesBlocked = true;
      session.updatedAt = at;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    }
    // Clear a legacy latch only after its backlog has been terminalized.
    if (session.paused) {
      delete session.paused;
      session.updatedAt = at;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    }
    for (const turn of stopped) {
      this.closeOrphanedTasks(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
      this.closeOpenItems(sessionId, turn.runId, at);
      this.closeOpenRequests(sessionId, turn.runId, at);
    }
    // Also runs when no foreground turn exists: a background task outlives
    // its turn, but belongs to the session the user just stopped.
    const backgroundStopped = this.stopBackgroundTasks(sessionId);
    if (stopped.length > 0 || backgroundStopped > 0) this.touchSession(sessionId, at);
    for (const turn of stopped) this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
    /**
     * AND THE WORKER IS TOLD, rather than left to find out on a poll. See the
     * `onTurnsStopped` option: the claim stays ON the turn here (that is how a
     * heartbeat still delivers it to an out-of-process worker), so this is a
     * shortcut and never the only path.
     */
    this.announceStoppedClaims(
      stopped.flatMap((turn) =>
        turn.claim ? [{ sessionId, runId: turn.runId, claimToken: turn.claim.token, workerId: turn.claim.workerId }] : [],
      ),
    );
    // One wake for the live turn, not one per cancelled backlog message.
    if (live) this.fireSubscriptions(sessionId, "turn_stopped", live, {});
    this.evaluateDelegationSettling(sessionId);
    return { stopped: stopped.map((turn) => structuredClone(turn)), ...(live ? { live: structuredClone(live) } : {}) };
  }

  /**
   * STOP ONE TURN. The worker claims the next queued message within a
   * heartbeat, an undelivered steer is requeued and claimed, and subscribers
   * are woken — this is a stop of a RUN, not of the session. For the Stop
   * button's "end this session's work" see `stopSession`; for "stop and stay
   * stopped until a human resumes" see `pauseSession`.
   */
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
    this.closeOpenItems(sessionId, turn.runId, at);
    this.closeOpenRequests(sessionId, turn.runId, at);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
    for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
    this.fireSubscriptions(sessionId, "turn_stopped", turn, {});
    // A stopped assignment IS finished (clause 1 takes it), so a Stop is one of
    // the moments a delegate can become settleable.
    this.evaluateDelegationSettling(sessionId);
    return { turn: structuredClone(turn), stopped: true };
  }

  /**
   * Promote a queued turn into the RUNNING one. `submitTurn` calls this for
   * every message that arrives mid-turn; the HTTP route still exposes it for
   * a turn that fell back to `queued` (compaction, a claim not yet running)
   * and can be sent now that the moment has passed.
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
  /**
   * THE ELIGIBILITY RULES, in one place, over an in-memory queue.
   *
   * `promoteTurn` and `markRunning` both promote, and a second copy of these
   * checks is how the two would come to disagree about what may be steered.
   * Throws exactly what `promoteTurn` documents; the caller writes the queue.
   */
  private promoteInQueue(sessionId: string, queue: SessionQueue, turn: Turn, running: Turn, at: number): void {
    if (!PROVIDER_CAPABILITIES[this.getSession(sessionId).driver].liveSteering)
      throw new EngineStateError("conflict", "this provider queues follow-up messages until the active turn ends");
    if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be sent now");
    // A HOLD IS SOMEBODY'S DECISION about this message — a pause, or a
    // restart's re-read. Releasing it by steering it would be that decision
    // undoing itself.
    if (turn.held) throw new EngineStateError("conflict", "a held message is not sent until it is released");
    // A compaction is a gesture on the session, not words for the model.
    if (turn.kind === "compact") throw new EngineStateError("conflict", "a compaction always waits its turn");
    if (running.state !== "running" || !running.claim) throw new EngineStateError("conflict", "no turn is running to send this into");
    // AND NOT INTO A COMPACTION EITHER. The target being a compaction turn is
    // the same refusal from the other side: there is no conversation to
    // interrupt, only a context being squeezed.
    if (running.kind === "compact") throw new EngineStateError("conflict", "the provider is compacting its context and cannot take a message right now");
    const compacting = [...this.readItems(sessionId).values()].some(
      (item) => item.runId === running.runId && item.detail.type === "context_compaction" && item.status === "inProgress",
    );
    if (compacting) {
      throw new EngineStateError("conflict", "the provider is compacting its context and cannot take a message right now");
    }
    turn.state = "steering";
    turn.steer = { intoRunId: running.runId, requestedAt: at };
    turn.updatedAt = at;
  }

  promoteTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    // Checked here as well as inside, to keep the refusals in the order this
    // route has always reported them: what you asked for, then what is live.
    if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be sent now");
    const running = queue.turns.find((candidate) => candidate.state === "running" && candidate.claim);
    if (!running) throw new EngineStateError("conflict", "no turn is running to send this into");
    const at = this.now();
    this.promoteInQueue(sessionId, queue, turn, running, at);
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
   * RUN A MESSAGE THAT WAS HELD — the human has re-read it and still means it.
   *
   * The other two exits from a hold already exist and are not duplicated here:
   * `stopTurn` drops it (it is `queued`, which that already handles), and
   * simply reading it in the transcript is the review. This one only clears the
   * flag; the ordinary claim path takes it from there, in its original place in
   * the queue.
   */
  releaseHeldTurn(sessionId: string, runId: string): Turn {
    assertId(runId, "run id");
    const session = this.getSession(sessionId);
    /**
     * RELEASING IS STARTING WORK, so it answers to the same gate as submitting.
     * Without this a message held since before the project was put away could
     * be released into it — resuming a provider on a project the person removed
     * from Telar, which is exactly what `assertProjectAvailable` exists to stop
     * at the other two doors (a new session, a new turn).
     */
    if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === runId);
    if (!turn) throw new EngineStateError("not_found", "turn does not exist");
    /**
     * THE STATE IS CHECKED FIRST AND UNCONDITIONALLY.
     *
     * It used to live inside the `!turn.held` branch, so a turn that had since
     * been stopped or run but still carried a stale `held` flag skipped the
     * check entirely and was cheerfully "released" — reporting success about a
     * terminal turn, and clearing a flag on it as if that meant something.
     */
    if (turn.state !== "queued") throw new EngineStateError("conflict", "only a queued turn can be released");
    // Already runnable: nothing to do, and saying so is kinder than a conflict
    // for a button pressed twice.
    if (!turn.held) return structuredClone(turn);
    // Releasing ONE message does not un-pause the session — `claimTurn` would
    // still refuse it. The honest answer is to say so: resume is the verb.
    if (turn.held.reason === "session_paused" && session.paused) {
      throw new EngineStateError("conflict", "the session is paused; resume it to run this message");
    }
    const at = this.now();
    delete turn.held;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.touchSession(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
    return structuredClone(turn);
  }

  /**
   * An ambiguous turn may already have reached a provider, so it is never
   * replayed or deleted.  A human must make this one-way decision before the
   * session can accept fresh work.
   *
   * DISCARDING IT DOES NOT RELEASE THE BACKLOG. Messages `recover()` marked
   * `held` stay held: this decision is about THIS turn, and the pre-crash
   * messages behind it each need their own. Before `held` existed the hold was
   * inferred from the presence of an ambiguous turn, so this call — which is
   * exactly what "Continue" performs — released every one of them at once.
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
    this.closeOpenRequests(sessionId, turn.runId, at);
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
    this.releaseDataScience(session, "session archived");

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
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.archived" });
    this.dropSubscriptionsOf(sessionId);
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
  /** Kill the session's kernel, and for a worktree, its own Telar venv. Best-effort. */
  /**
   * A SESSION IS GOING AWAY. The store ANNOUNCES it and the host decides who
   * cares — `attachPluginRelease` is what stops this method growing a line per
   * feature. The venv removal stays here because it is the store's own file
   * layout, not any plugin's.
   */
  private releaseDataScience(session: Session, reason: string): void {
    this.pluginRelease?.(session.id, reason);
    void this.kernels?.dispose(session.id, reason);
    if (session.workspace.mode === "worktree" && session.projectId) {
      removeTelarVenv(telarVenvDir(this.paths.root, session.projectId, path.basename(session.workspace.path)));
    }
  }

  deleteSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    const active = this.readQueue(sessionId).turns.find(
      (turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running",
    );
    if (active) throw new EngineStateError("conflict", "session has an active turn; stop it before deleting");

    void this.browser?.release(sessionId, "session deleted");
    this.releaseDataScience(session, "session deleted");

    // See `archiveSession` for why the project is checked beside the mode.
    if (session.workspace.mode === "worktree" && session.projectId) {
      const project = this.getProject(session.projectId);
      removeSessionWorktree(this.git, project.root, session.workspace.path);
    }

    // The event is appended BEFORE the directory goes, so a subscriber watching
    // this session is told why its stream ended rather than simply losing it.
    this.appendEvent(sessionId, { type: "session.archived" });
    this.executionStore?.deleteSession(sessionId);
    fs.rmSync(sessionDir(this.paths, sessionId), { recursive: true, force: true });
    // The queue went with the directory, so no `writeQueue` will ever retire
    // this id from the live index. Drop it here or a worker keeps asking about
    // a session that no longer exists.
    this.liveQueueIndex?.delete(sessionId);
    this.queueCache.delete(sessionId);
    this.itemsCache.delete(sessionId);
    // The journal is gone with the directory; a session recreated under this
    // id starts a new one from 1, not from where the old one stopped.
    this.journalHead.delete(sessionId);
    this.dropSubscriptionsOf(sessionId);
    return true;
  }

  // ── Subscriptions — one session asking to be woken by another ─────────────

  /**
   * SUBSCRIBE. Both sessions must be live: an archived subscriber has nowhere
   * to be woken, and an archived target has nothing left to do. IDEMPOTENT ON
   * THE PAIR — a retried tool call returns the one subscription, with the
   * events merged, rather than minting a second that would wake twice.
   */
  subscribe(subscriberSessionId: string, input: { targetSessionId: string; events?: WakeKind[]; once?: boolean }): Subscription {
    assertId(input.targetSessionId, "target session id");
    if (subscriberSessionId === input.targetSessionId) {
      throw new EngineStateError("invalid_request", "a session cannot subscribe to itself");
    }
    const subscriber = this.getSession(subscriberSessionId);
    const target = this.getSession(input.targetSessionId);
    if (subscriber.state !== "active") throw new EngineStateError("conflict", "an archived session cannot be woken");
    if (target.state !== "active") throw new EngineStateError("conflict", "an archived session will do nothing worth waking for");
    const events = input.events && input.events.length > 0 ? [...new Set(input.events)] : [...ALL_WAKE_KINDS];
    const all = this.readSubscriptions();
    const existing = all.find((each) => each.subscriberSessionId === subscriberSessionId && each.targetSessionId === input.targetSessionId);
    if (existing) {
      existing.events = [...new Set([...existing.events, ...events])];
      if (input.once !== undefined) {
        if (input.once) existing.once = true;
        else delete existing.once;
      }
      this.writeSubscriptions(all);
      return structuredClone(existing);
    }
    const mine = all.filter((each) => each.subscriberSessionId === subscriberSessionId).length;
    if (mine >= MAX_SUBSCRIPTIONS_PER_SESSION) {
      throw new EngineStateError(
        "conflict",
        `this session is already subscribed to ${mine} sessions, the most it may be. Unsubscribe from ones you are finished with — sessions_subscriptions lists them.`,
      );
    }
    const subscription: Subscription = {
      id: `sub_${crypto.randomUUID().replaceAll("-", "")}`,
      subscriberSessionId,
      targetSessionId: input.targetSessionId,
      events,
      ...(input.once ? { once: true } : {}),
      createdAt: this.now(),
    };
    all.push(subscription);
    this.writeSubscriptions(all);
    return structuredClone(subscription);
  }

  /** With `subscriberSessionId`, another session's subscription reads as
   *  absent — a session may not remove what it did not ask for. */
  unsubscribe(subscriptionId: string, subscriberSessionId?: string): boolean {
    assertId(subscriptionId, "subscription id");
    const all = this.readSubscriptions();
    const index = all.findIndex(
      (each) => each.id === subscriptionId && (subscriberSessionId === undefined || each.subscriberSessionId === subscriberSessionId),
    );
    if (index < 0) return false;
    const [removed] = all.splice(index, 1);
    this.writeSubscriptions(all);
    // "Stop waking me" includes the wakes already waiting: an unsubscribe that
    // left fourteen queued wakes to run one by one stopped nothing a person
    // could see. Only QUEUED ones go; a running wake is the worker's.
    this.discardQueuedWakes(removed!.subscriberSessionId, removed!.targetSessionId);
    return true;
  }

  /** What this session has asked to be woken by. */
  subscriptionsFor(subscriberSessionId: string): Subscription[] {
    this.getSession(subscriberSessionId);
    return structuredClone(this.readSubscriptions().filter((each) => each.subscriberSessionId === subscriberSessionId));
  }

  private readSubscriptions(): Subscription[] {
    const stored = this.readDocument(this.paths.subscriptions) as { subscriptions?: unknown } | undefined;
    const parsed = SubscriptionSchema.array().safeParse(stored?.subscriptions ?? []);
    // A corrupt file costs the subscriptions, not the engine — same rule as
    // the attachments index.
    return parsed.success ? parsed.data : [];
  }

  private writeSubscriptions(subscriptions: Subscription[]): void {
    this.writeDocument(this.paths.subscriptions, { version: STATE_VERSION, subscriptions });
  }

  /** A session that is gone can neither wake nor be woken: both directions go. */
  private dropSubscriptionsOf(sessionId: string): void {
    const all = this.readSubscriptions();
    const kept = all.filter((each) => each.subscriberSessionId !== sessionId && each.targetSessionId !== sessionId);
    if (kept.length !== all.length) this.writeSubscriptions(kept);
  }

  /**
   * THE WAKE. Called at the end of every terminal turn transition and when a
   * request parks — after the target's own queue and events are written, so
   * a wake that fails can never fail the transition that caused it.
   *
   * A WAKE IS A TURN ON THE SUBSCRIBER, through `submitTurn` and no other
   * path — which means it follows the same rule as a typed message: STEERED
   * into a running turn the moment it arrives, or claimed as the next turn
   * when the subscriber is idle. An orchestrator mid-thought hears that its
   * child finished while it is still thinking about that child, rather than
   * fourteen turns later. There is
   * no event bus in this engine to ride instead, and `openProviderTurn` is
   * for a process that is already talking — a subscriber sitting idle has no
   * such process to inject into.
   *
   * A WAKE'S OWN ENDING WAKES NOBODY. Two sessions subscribed to each other
   * would otherwise ping-pong forever: A finishes → B is woken → B's wake
   * turn finishes → A is woken → … The turn whose ending is being announced
   * is checked for a `wakeReason` and skipped. A DIRECT agent message's turn
   * does wake: the sender asked for work and, if subscribed, wants its end.
   *
   * ONE FILE READ PER TRANSITION, returning at once when nothing matches —
   * the common case on an engine with no orchestrator.
   */
  private fireSubscriptions(
    targetSessionId: string,
    kind: WakeKind,
    turn: Turn,
    context: { resultText?: string; failure?: Turn["failure"]; request?: EngineRequest },
  ): void {
    if (turn.origin === "session" && turn.wakeReason) return;
    const all = this.readSubscriptions();
    const hits = all.filter((each) => each.targetSessionId === targetSessionId && each.events.includes(kind));
    if (hits.length === 0) return;
    let target: Session;
    try {
      target = this.getSession(targetSessionId);
    } catch {
      return;
    }
    let changed = false;
    const remove = (subscription: Subscription) => {
      const index = all.indexOf(subscription);
      if (index >= 0) all.splice(index, 1);
      changed = true;
    };
    for (const subscription of hits) {
      const subscriberId = subscription.subscriberSessionId;
      if (subscriberId === targetSessionId) continue;
      let subscriber: Session | undefined;
      try {
        subscriber = this.getSession(subscriberId);
      } catch {
        subscriber = undefined;
      }
      if (!subscriber || subscriber.state !== "active") {
        // The subscriber is gone; its wish goes with it.
        remove(subscription);
        continue;
      }
      if (subscriber.agentMessagesBlocked) continue;
      /**
       * A RESULT AND A COMPLETION ARE TWO DIFFERENT FACTS (#240).
       *
       * This used to swallow the `turn_completed` of any run whose worker had
       * already sent an awaited `result`, on the reading that the result WAS
       * the run's outcome. It is not, and the engine cannot tell: a worker
       * sends a result for the part it finished and keeps working, and the
       * coordinator that was told "here is the analysis" still needs to hear
       * "and the run has ended" before it acts. Suppressed, the errand simply
       * never closed. The result says what was produced; the completion says
       * the turn is over, and a coordinator gets both.
       */
      const wakeReason: WakeReason = {
        kind,
        sessionId: targetSessionId,
        runId: turn.runId,
        ...(context.request ? { requestId: context.request.id } : {}),
      };
      const input = wakeMessage(kind, target, turn, context);
      try {
        /**
         * ONE QUEUED WAKE PER CHILD TURN. A child that parks an approval,
         * then gets it, then finishes, produced two queued turns on the
         * parent about the same run — and both would have run as full turns,
         * the first announcing a state already superseded. The newest fact
         * about THAT RUN wins: a wake still waiting for it is REWRITTEN in
         * place, keeping its position in the queue. Different runs keep
         * separate wakes — a failure on one turn is not erased by the next
         * turn finishing. A wake already claimed or running is not touched;
         * it is the worker's now.
         */
        const coalesced = this.coalesceQueuedWake(subscriberId, targetSessionId, input, wakeReason);
        if (!coalesced) {
          this.submitTurn(subscriberId, {
            runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
            input,
            origin: "session",
            wakeReason,
          });
        }
        // ONLY AN ENDING SPENDS A ONE-SHOT — see `TERMINAL_WAKE_KINDS`. A
        // `request_opened` says the target is waiting on someone, not that it
        // is finished, and a subscription spent there never fired again.
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
      } catch (error) {
        // A full backlog or an ambiguous turn on the subscriber is that
        // session's own state, and a wake is not worth breaking it for. Said
        // on the subscriber's journal, where the person reading it will look.
        if (error instanceof EngineStateError && error.code === "conflict") {
          this.appendEvent(subscriberId, {
            type: "runtime.warning",
            message: `a wake from session ${targetSessionId} (${kind}) was dropped: ${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
    if (changed) this.writeSubscriptions(all);
  }

  /* ---------------------------------------------------------------- *
   * DELEGATION SETTLING — issue #378. The rule is in
   * `./delegation-settling.ts`; this is where the engine reads the facts and
   * writes the answer.
   *
   * BESIDE `fireSubscriptions` BECAUSE IT READS THE SAME SIGNAL —
   * `agentIntent === "result"` plus `agentSourceRunId`, "the coordinator
   * already has this run's outcome", which is clause 2 of the settle. The wake
   * above no longer folds that fact (#240: a result and a completion are two
   * different facts to a coordinator); the settle still does, because "has this
   * errand been reported on" is exactly the question it asks.
   * ---------------------------------------------------------------- */

  /**
   * A TERMINAL TURN IS THE MOMENT TO ASK, on both sides of a delegation.
   *
   * The session that just ended a turn may be the DELEGATE whose errand this
   * finished, and it may be the COORDINATOR whose turn just consumed a wake —
   * an orchestrator is routinely both at once. Asking both questions here is
   * what makes the two evaluation points the issue names one call site rather
   * than a rule spelled twice.
   *
   * NEVER THROWS INTO THE TRANSITION. Same contract as the wake above it: the
   * turn has already been written and journalled, and a shelf is not worth
   * failing a completion for.
   */
  private evaluateDelegationSettling(sessionId: string): void {
    try {
      this.settleDelegateIfDue(sessionId);
      /**
       * WHOSE DELEGATES, WITHOUT A SCAN. A coordinator's OWN queue names every
       * session that could have just become delivered: a wake carries the
       * child in `wakeReason.sessionId`, and a result carries it as the
       * sender. Walking those is one queue read; the alternative — asking
       * every session on disk who it works for — is the N+1 over whole
       * transcripts that `liveSessions` exists to avoid, on every turn.
       */
      const delegates = new Set<string>();
      for (const turn of this.scanQueue(sessionId).turns) {
        if (turn.wakeReason?.sessionId) delegates.add(turn.wakeReason.sessionId);
        if (turn.origin === "session" && turn.agentIntent === "result" && turn.sender?.sessionId) {
          delegates.add(turn.sender.sessionId);
        }
      }
      delegates.delete(sessionId);
      for (const delegate of delegates) this.settleDelegateIfDue(delegate);
    } catch (error) {
      this.appendEvent(sessionId, {
        type: "runtime.warning",
        message: `delegation settling was skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * EVERY ROW THE GRACE HAS COME DUE ON — the slow half of the rule.
   *
   * The two turn-completion points above catch the moment the FACTS change;
   * neither of them fires when nothing more happens, which is precisely the
   * common case: a coordinator takes delivery and then everybody goes quiet.
   * So the grace needs something that ticks. Returns the sessions it settled,
   * so a caller (and a test) can see the sweep's work without a timer.
   *
   * A WHOLE-STORE PASS, ON A SLOW TIMER, and the cost is bounded by the cheap
   * refusals first: no grace configured is one document read for the entire
   * sweep, and a session with no task turn costs one queue scan. There is no
   * engine-side settling clock to ride — the quiet window is folded by each
   * client — so this is the tick, and it is the daemon's only one besides the
   * worker pruner.
   */
  sweepDelegatedSettling(): string[] {
    if (this.getInboxPolicy().settleDelegatedAfterHours === null) return [];
    const settled: string[] = [];
    for (const sessionId of this.sessionIds()) {
      try {
        if (this.settleDelegateIfDue(sessionId)) settled.push(sessionId);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return settled;
  }

  /** The whole rule for one session: gather, fold, and write if it says so. */
  private settleDelegateIfDue(sessionId: string): boolean {
    let session: Session;
    try {
      session = this.getSession(sessionId);
    } catch {
      return false;
    }
    // Cheap refusals before the policy read: an archived row is off every list
    // already, and a standing human decision is not the engine's to revisit.
    if (session.state === "archived" || session.settledOverride !== undefined) return false;
    const assignments = assignmentsOf(this.scanQueue(sessionId).turns as unknown as AssignmentTurn[]);
    const newest = newestAssignment(assignments);
    // Not a delegate. The overwhelming majority of sessions stop here.
    if (!newest) return false;

    const outcome = delegationSettle({
      now: this.now(),
      graceHours: this.getInboxPolicy().settleDelegatedAfterHours,
      delegateSessionId: sessionId,
      assignments,
      // A coordinator that no longer exists reads as an empty queue, which is
      // "no delivery" — the honest answer, not a settle on an absence.
      coordinatorTurns: this.scanQueue(newest.fromSessionId).turns as unknown as DeliveryTurn[],
      activity: session.activity,
      archived: false,
      unsettledAssignments: session.unsettledAssignments ?? [],
    });
    if (!outcome.settle) return false;
    this.applyDelegationSettle(sessionId, outcome.settle);
    return true;
  }

  /**
   * WRITE THE SHELF AND SAY WHY.
   *
   * `updatedAt` IS DELIBERATELY NOT TOUCHED, for `markSessionRead`'s reason:
   * it dates the session's WORK, and the quiet clock is measured from it.
   * Stamping it here would make an engine settle look like fresh activity to
   * every rule downstream — including the one a person would meet if they
   * pulled the row back off the shelf.
   *
   * TWO EVENTS, AND THEY ARE NOT THE SAME ROW. `session.updated` is how a
   * client's fold learns the new record; `session.settled` is the one moment
   * something acting on the settling (worktree removal, later) can subscribe to
   * without diffing snapshots.
   */
  private applyDelegationSettle(sessionId: string, settledBy: SessionSettledBy): void {
    const session = this.getSession(sessionId);
    const next: Session = { ...session, settledOverride: "settled", settledAt: this.now(), settledBy };
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(next));
    this.appendEvent(sessionId, { type: "session.settled", settledBy });
    this.appendEvent(sessionId, { type: "session.updated", session: next });
  }

  /** Rewrite a still-queued wake about the same child run with newer words. True when one was found. */
  private coalesceQueuedWake(subscriberId: string, targetSessionId: string, input: string, wakeReason: WakeReason): boolean {
    const queue = this.readQueue(subscriberId);
    const waiting = queue.turns.find(
      (turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason?.sessionId === targetSessionId && turn.wakeReason.runId === wakeReason.runId,
    );
    if (!waiting) return false;
    const at = this.now();
    waiting.input = input;
    waiting.wakeReason = wakeReason;
    waiting.updatedAt = at;
    this.writeQueue(subscriberId, queue);
    this.touchSession(subscriberId, at);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  /**
   * Withdraw every QUEUED wake from `targetSessionId` on `subscriberId` — what
   * an unsubscribe means when wakes have already piled up. Turns already
   * claimed or running stay; they are the worker's. Returns how many went.
   */
  private discardQueuedWakes(subscriberId: string, targetSessionId: string): number {
    const queue = this.readQueue(subscriberId);
    const at = this.now();
    const dropped = queue.turns.filter((turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason?.sessionId === targetSessionId);
    if (dropped.length === 0) return 0;
    for (const turn of dropped) {
      turn.state = "discarded";
      turn.completedAt = at;
      turn.updatedAt = at;
    }
    this.writeQueue(subscriberId, queue);
    this.touchSession(subscriberId, at);
    for (const turn of dropped) this.appendEvent(subscriberId, { type: "turn.discarded" }, turn.runId);
    return dropped.length;
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
      const notify = () => this.notifier?.({ sessionId, runId: turn.runId, requestId: request.id,
        kind: input.kind, title: requestTitle(input.detail) }) ?? false;
      if (this.executionStore) {
        request.notified = false;
        this.afterCommit.push(() => {
          // Best-effort notification is outside the execution transaction. A
          // crash here leaves an explicitly unnotified, durable open request.
          try {
            const latest = this.readRequests(sessionId);
            const pending = latest.get(request.id);
            if (pending?.state !== "open") return;
            pending.notified = notify();
            this.writeRequests(sessionId, latest);
          } catch { /* retain the unnotified request for the next reader */ }
        });
      } else request.notified = notify();
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
    this.fireSubscriptions(sessionId, "request_opened", turn, { request });
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
    return [...this.liveQueueSessionIds()].flatMap((sessionId) => {
      const claimed = new Map(
        this.scanQueue(sessionId).turns
          .filter((turn) => turn.claim?.workerId === workerId && turn.state === "running")
          .map((turn) => [turn.runId, turn] as const),
      );
      if (claimed.size === 0) return [];
      return [...this.readRequests(sessionId).values()]
        .filter((request) => request.state === "resolved" && request.decision && claimed.has(request.runId))
        .map((request) => ({
          requestId: request.id,
          sessionId,
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
    return [...this.liveQueueSessionIds()].flatMap((sessionId) => {
      const queue = this.scanQueue(sessionId);
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
        /**
         * CLONED, because `queue` here is the SHARED scan copy. Everything
         * else this heartbeat returns is strings the engine built; a delivery
         * is the one thing that would otherwise hand an embedded worker live
         * references into the cache — its attachments array, its sender — and
         * anything downstream that edited one would be editing the store's
         * idea of the queue. Steers are rare; a copy of one costs nothing.
         */
        return [
          structuredClone({
            sessionId,
            runId: turn.steer.intoRunId,
            claimToken,
            steerRunId: turn.runId,
            text: turn.input,
            // The attachments ride with the words — a steered image used to be
            // stored here and never delivered.
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
            // And so does WHO SAID THEM: an agent's message steered into a
            // running turn used to reach the provider as the person's own.
            ...(turn.origin === "session" && turn.sender ? { sender: turn.sender } : {}),
            // AND THE NOTICE RIDES WITH THE SENDER. Without it a peer's message
            // would be short when the recipient was idle and full-size when it
            // was mid-turn — the same message costing different amounts by an
            // accident of timing.
            ...(turn.origin === "session" && turn.sender && turn.agentNotice ? { notice: turn.agentNotice } : {}),
            // A WAKE KEEPS ITS IDENTITY THROUGH THE PROMOTION. `submitTurn`
            // steers whatever it accepts when a turn is running, and a wake is
            // accepted the same way — so the engine's own announcement about a
            // peer used to arrive here stripped of `wakeReason` and reach both
            // the provider and the transcript as a person's typed message. The
            // stamp is the turn's; it rides the delivery.
            ...(turn.origin === "session" && turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
          }),
        ];
      });
    });
  }

  readEvents(sessionId: string, after = 0): EngineEvent[] {
    this.getSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    return this.executionStore ? this.executionStore.events(sessionId, after) : readJournal(eventsFile(this.paths, sessionId)).filter((event) => event.id > after);
  }

  /**
   * The id of the last event on the journal — "now", for a client that wants
   * to tail from the snapshot it just read rather than replay from zero.
   * Journals are append-only with strictly increasing ids, so the last complete
   * line is the answer; only its tail is read.
   */
  eventCursor(sessionId: string): number {
    this.getSession(sessionId);
    return this.executionStore ? this.executionStore.cursor(sessionId) : lastEventId(eventsFile(this.paths, sessionId));
  }

  /**
   * The text streamed into an open item so far, and the delta id it runs
   * through — the two halves of `Item.streamed` / `Item.streamedThrough`.
   *
   * COMPLETE THROUGH `through`, WHICH IS THE CONTRACT THE CLIENT RELIES ON: it
   * appends only the deltas above that id, so anything missing below it is
   * missing forever. A prefix that merely stopped somewhere is not enough.
   *
   * A MISS IS REBUILT FROM THE JOURNAL, not reported as nothing: the map is
   * empty after a restart, and "your half-written reply vanished because the
   * engine bounced" is the bug this field exists to prevent.
   */
  openItemPrefix(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined {
    const key = prefixKey(sessionId, itemId);
    const cached = this.openPrefixes.get(key);
    /**
     * SEALED MEANS "STARTED FROM THE ITEM'S BEGINNING". An entry that grew from
     * an empty map — a restart, an eviction — holds only the deltas since, and
     * trusting its text would report a tail as if it were the whole reply. That
     * is the same truncation this field exists to prevent, moved into the
     * engine. Only a sealed entry is trusted; anything else is rebuilt.
     *
     * `through <= cutoff` then means COMPLETE through the cutoff, because every
     * delta extends the entry synchronously as it is appended: if none arrived
     * between, there is nothing to be missing.
     */
    if (cached?.sealed && cached.through <= through) return { streamed: cached.text, streamedThrough: cached.through };
    let streamed = "";
    let streamedThrough = 0;
    for (const event of this.readEvents(sessionId)) {
      if (event.id > through) break;
      if (event.type !== "content.delta" || event.itemId !== itemId) continue;
      streamed += event.text;
      streamedThrough = event.id;
    }
    if (!streamedThrough) return undefined;
    // NOT WRITTEN BACK. The rebuild is bounded by the cutoff while the entry
    // may hold deltas above it, and there is no way to tell the two apart from
    // here. Re-reading on the next snapshot of a restarted turn is the cold
    // path; guessing would put the truncation back.
    return { streamed, streamedThrough };
  }

  /** Extend an open item's cached prefix. Keyed by SESSION AND ITEM: item ids
   *  are unique within a session, not across them. An entry with no `sealed`
   *  predecessor stays unsealed — see `openItemPrefix`. */
  private extendOpenPrefix(sessionId: string, itemId: string, text: string, through: number): void {
    const held = this.openPrefixes.get(prefixKey(sessionId, itemId));
    this.rememberOpenPrefix(sessionId, itemId, { text: (held?.text ?? "") + text, through, sealed: held?.sealed === true });
  }

  /**
   * Write a cached prefix and hold the map to its bound.
   *
   * EVERY INSERTION GOES THROUGH HERE, opening an item included: a bound the
   * write path can sidestep is not a bound, and an agent that opens many items
   * before streaming into any of them would have walked straight past it.
   *
   * "ONE ENTRY PER OPEN ITEM" IS NOT A BOUND EITHER — Stop deliberately leaves
   * items open forever, so stopped turns would keep their partial replies
   * resident for the life of the process. Evicting the least recently written
   * costs a journal read on the next snapshot of a long-quiet item, and never
   * costs text: `openItemPrefix` rebuilds what it does not find.
   */
  private rememberOpenPrefix(sessionId: string, itemId: string, entry: { text: string; through: number; sealed: boolean }): void {
    const key = prefixKey(sessionId, itemId);
    // Re-inserted rather than mutated, so insertion order IS the eviction order.
    this.openPrefixes.delete(key);
    this.openPrefixes.set(key, entry);
    while (this.openPrefixes.size > OPEN_PREFIX_LIMIT) {
      const oldest = this.openPrefixes.keys().next();
      if (oldest.done) break;
      this.openPrefixes.delete(oldest.value);
    }
  }

  /** Drop every cached prefix, as a restart would. The rebuild path is the
   *  thing worth testing and it is unreachable while the cache is warm. */
  forgetOpenPrefixesForTest(): void {
    this.openPrefixes.clear();
  }

  /** How many prefixes are resident. Asserted against the bound, because the
   *  TEXT stays correct whether or not eviction runs — so nothing else can
   *  tell the difference between a bound that holds and one that does not. */
  openPrefixCountForTest(): number {
    return this.openPrefixes.size;
  }

  /** An item that closed carries its text in `detail` from then on, so the
   *  accumulator's copy is dead weight — and this is what bounds the map. */
  private dropOpenPrefix(sessionId: string, itemId: string): void {
    this.openPrefixes.delete(prefixKey(sessionId, itemId));
  }

  /**
   * BOOT: SETTLE WHAT THE LAST PROCESS LEFT IN FLIGHT.
   *
   * Returns the runIds it stopped. `requeued`/`ambiguous` are gone with the
   * states they named — nothing is requeued (that would be automatic work the
   * user did not ask for) and nothing is ambiguous (that would be a decision
   * the user is now spared).
   *
   * IT DELIVERS NOTHING. No subscription is fired for any turn settled here:
   * a boot that woke every subscriber would open fresh agent turns for exactly
   * the work that was just declared over, which is the automatic restart this
   * whole change exists to remove. The journal records the truth; nobody is
   * summoned by it.
   */
  recover(): { stopped: string[] } {
    const stopped: string[] = [];
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
      /**
       * EVERY TERMINAL TURN AT ONCE, because this is a boot and there are
       * hundreds of them. Collected first, then swept in three reads per
       * session rather than three per turn — see `closeOpenItemsForRuns` for
       * the measurement that made this the difference between a 21 s engine
       * start and a fast one.
       */
      const settledRuns = new Set<string>();
      for (const turn of queue.turns) {
        if (turn.state === "queued" || turn.state === "claimed" || turn.state === "running") continue;
        settledRuns.add(turn.runId);
      }
      {
        const sweptAt = this.now();
        this.closeLiveTasks(session.id, sweptAt, "the turn ended before this agent reported back", { runIds: settledRuns, includeBackground: false });
        // Same retroactive cure for items: a stopped turn from before this
        // sweep existed still holds the tool row it was inside.
        this.closeOpenItemsForRuns(session.id, settledRuns, sweptAt);
        // And for requests: a question parked on a turn that already ended
        // kept a persisted session `blocked` with nothing left to answer it.
        //
        // AN AMBIGUOUS TURN'S REQUEST IS RETIRED TOO, and it used to be the one
        // exception. The reasoning for keeping it — "its decision is still
        // pending" — confused two different decisions. The TURN's fate is
        // pending and stays so; the REQUEST is a question a worker asked and
        // then died waiting on, and no answer can ever reach it. Measured:
        // across every subsequent boot it stayed `open`, holding the session
        // `blocked` — sidebar "Waiting on you", composer in answer mode — over
        // a tool call nothing was going to run. The web client already worked
        // around this client-side (`actionableRequests`); the engine should not
        // have needed the workaround.
        //
        // The row stays in the transcript, resolved, as part of the record of
        // what the lost turn was doing when it died.
        this.closeOpenRequestsForRuns(session.id, settledRuns, sweptAt);
      }
      let changed = false;
      /** Housekeeping, kept apart from `changed`: retiring a dead claim must
       *  rewrite the queue but must NOT touch the session — nothing happened
       *  to it, and a bumped `updatedAt` would reorder somebody's sidebar. */
      let claimsRetired = false;
      const recoveryEvents: Array<{ type: "turn.stopped"; runId: string }> = [];
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
      /**
       * STOP IS STOP, AND A RESTART IS A STOP. Whatever was in flight when the
       * process went away is over: the live turn, the claim that never
       * started, the steer that may or may not have arrived, and the backlog
       * that was waiting behind all of it. Every one of them lands `stopped`,
       * which is terminal, visible, and asks nobody for a decision.
       *
       * WHAT THIS REPLACES. A running turn used to become `ambiguous` and a
       * backlog `held`, so the next boot met the person with a recovery card
       * and a row of Resume buttons before they could say anything — and
       * resolving one released a pre-crash backlog nobody had re-read. The
       * person's answer to all of it is the same: the next message continues
       * the conversation from the provider cursor, which `resumeCursor` above
       * has already recovered. Nothing is replayed and nothing is resumed.
       *
       * THE TEXT AND THE ITEMS SURVIVE — only `state` moves. A stopped turn
       * keeps its prompt, its attachments, its tool rows and its answer, so
       * the transcript still says exactly what happened; `stopReason` says why
       * it ended, and it never claims the work was undone or finished.
       *
       * AND NOTHING IS DELIVERED FROM HERE. No subscription fires (see the
       * caller's note): a boot that woke every subscriber would start fresh
       * agent turns for work the user just said should not restart.
       */
      for (const turn of queue.turns) {
        if (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running" && turn.state !== "steering") continue;
        const wasLive = turn.state === "running";
        turn.state = "stopped";
        turn.stopReason = "engine_restart";
        turn.completedAt = at;
        turn.updatedAt = at;
        delete turn.steer;
        delete turn.claim;
        // A hold was a question waiting to be asked. There is no question now,
        // so the flag goes with it rather than lingering on a terminal row.
        delete turn.held;
        stopped.push(turn.runId);
        recoveryEvents.push({ type: "turn.stopped", runId: turn.runId });
        if (wasLive) {
          // The process that was running these did not survive the restart.
          this.closeOrphanedTasks(session.id, turn.runId, at, "the engine restarted while this agent was running");
          this.closeOpenItems(session.id, turn.runId, at);
          // A question the lost worker parked can never be answered; leaving
          // it open held the session `blocked` over a tool call nothing would
          // run.
          this.closeOpenRequests(session.id, turn.runId, at);
        }
        changed = true;
      }
      /**
       * AN OLD `ambiguous` TURN IS SETTLED THE SAME WAY. Nothing produces the
       * state any more, but journals on disk still hold it, and a person whose
       * session has one would otherwise be stuck at a recovery card that no
       * longer exists anywhere in the app. Same treatment, same honesty: the
       * turn ended, what it had done is above, whether it finished anything
       * elsewhere is unknown.
       */
      for (const turn of queue.turns) {
        if (turn.state !== "ambiguous") continue;
        turn.state = "stopped";
        turn.stopReason = "engine_restart";
        turn.completedAt ??= at;
        turn.updatedAt = at;
        delete turn.held;
        stopped.push(turn.runId);
        recoveryEvents.push({ type: "turn.stopped", runId: turn.runId });
        changed = true;
      }
      /**
       * AND A STOPPED TURN LETS GO OF ITS CLAIM.
       *
       * `stopSession` leaves the claim ON a turn it stops, deliberately: that
       * is how the worker holding it learns over its heartbeat that the work
       * ended. But the claim names a worker registration, and no registration
       * survives a restart — so after this boot the token identifies nobody,
       * can be delivered to nobody, and has nothing left to say.
       *
       * IT IS NOT INERT WHILE IT SITS THERE. `queueConcernsAWorker` counts a
       * stopped turn that still carries a claim, which is what puts a session
       * in `liveQueueSessionIds` — so every Stop anybody had ever pressed left
       * a session in the set the heartbeat walks, permanently and across every
       * restart. Measured on the machine that prompted this: 155 such turns
       * held 45 of 129 sessions in an index that existed to describe the 2
       * that were running.
       *
       * The turn itself is untouched. Its state, its text, its items and its
       * `stopReason` all stay exactly as they were; only a token nobody can
       * use goes.
       */
      for (const turn of queue.turns) {
        if (turn.state !== "stopped" || !turn.claim) continue;
        delete turn.claim;
        claimsRetired = true;
      }
      /**
       * AND THE PAUSE LATCH COMES OFF. It is the same trap from the session's
       * side: a session paused by the old Stop button would open with a banner
       * and a Resume for a backlog this sweep has just settled. Pause is not a
       * behaviour any more (see `pauseSession`), so the flag is cleared rather
       * than left to mean something no code implements.
       */
      if (session.paused) {
        delete session.paused;
        session.updatedAt = at;
        metadataChanged = true;
      }
      /**
       * BACKGROUND WORK DIES WITH ITS PROCESS — the same position `failTurn`
       * and a live stop already take: outliving its TURN is the definition of
       * background, outliving its PROCESS is impossible. And EVERY session's
       * process is gone: since #126 the CLI lives in the worker for the whole
       * session, turn or no turn, and the worker restarted with the engine.
       * The earlier shape swept only under a `running` turn and "left an
       * idle-with-monitoring session alone — no process of ours died", which
       * was false: measured, session_9b43ceec… reported `monitoring` for five
       * days over a shell whose process ended at a restart. Unfiltered by
       * runId for the same reason `failTurn`'s is: the dead CLI hosted every
       * shell of the session, whichever turn started them.
       */
      const swept = this.closeLiveTasks(session.id, at, "the process that owned this task is gone", { includeBackground: true, onlyBackground: true, state: "stopped" });
      if (changed || claimsRetired) {
        this.writeQueue(session.id, queue);
      }
      if (changed || metadataChanged || swept.length > 0) {
        if (!metadataChanged) this.touchSession(session.id, at);
        else this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(session));
      }
      if (changed) {
        for (const event of recoveryEvents) {
          this.appendEvent(session.id, { type: event.type, reason: "engine_restart" }, event.runId);
        }
      }
    }
    return { stopped };
  }

  /**
   * A WORKER REGISTRATION RETIRES — its lease expired, or it shut down — and
   * the work it was holding ends with it.
   *
   * THE NAMED HOOK for that moment, called from wherever a registration is
   * dropped, so there is no window in which a claim is held by a worker that
   * no longer exists: an abandoned claim that stayed `claimed` would block the
   * session's dispatch for ever, and one that went back to `queued` would be
   * replayed by the next worker — automatic work nobody asked for. Both are
   * closed by ending it.
   *
   * SCOPED TO THIS WORKER'S OWN CLAIMS. `turn.claim.workerId` is the filter and
   * there is no second one: a healthy worker's turns are untouched, whichever
   * session they are in. Nothing here reaches for a process, and no task of a
   * session this worker was not running is swept — a broad kill on one
   * worker's death is how independently launched project services died with it.
   *
   * CANCELLATION IS NOT CLAIMED. The engine knows the registration is gone; it
   * does NOT know whether the provider process, or a command it had already
   * started, is still alive. The turn is recorded as stopped for that reason
   * and nothing asserts the work was undone.
   */
  retireWorkerRegistration(workerId: string): { stopped: string[] } {
    assertId(workerId, "worker id");
    const stopped: string[] = [];
    for (const session of this.allSessions()) {
      const queue = this.readQueue(session.id);
      // Only sessions this worker actually held work in.
      const mine = queue.turns.filter((turn) => turn.claim?.workerId === workerId && (turn.state === "claimed" || turn.state === "running"));
      if (mine.length === 0) continue;
      const at = this.now();
      const live = new Set(mine.map((turn) => turn.runId));
      // A steer aimed at one of those turns was never delivered by a worker
      // that is gone. It ends where it stands rather than going back to the
      // queue — requeueing is what made a lost worker restart the work.
      const orphanedSteers = queue.turns.filter((turn) => turn.state === "steering" && turn.steer && live.has(turn.steer.intoRunId));
      // PER SESSION, NOT THE ACCUMULATOR. Journalling from the cross-session
      // list would write this session's events again onto the next one — the
      // same trap `recover()`'s hold sweep documented, one loop lower down.
      const settled: string[] = [];
      for (const turn of [...mine, ...orphanedSteers]) {
        const wasRunning = turn.state === "running";
        turn.state = "stopped";
        turn.stopReason = "worker_unavailable";
        turn.completedAt = at;
        turn.updatedAt = at;
        delete turn.steer;
        delete turn.claim;
        settled.push(turn.runId);
        if (wasRunning) {
          // The worker was what ran these agents, rows and questions; no
          // answer can reach a request it died waiting on.
          this.closeOrphanedTasks(session.id, turn.runId, at, "the worker running this agent disappeared");
          this.closeOpenItems(session.id, turn.runId, at);
          this.closeOpenRequests(session.id, turn.runId, at);
        }
      }
      this.writeQueue(session.id, queue);
      this.touchSession(session.id, at);
      for (const runId of settled) this.appendEvent(session.id, { type: "turn.stopped", reason: "worker_unavailable" }, runId);
      stopped.push(...settled);
    }
    const deliveries = this.readTaskStopDeliveries();
    const remaining = deliveries.filter((delivery) => delivery.workerId !== workerId);
    if (remaining.length !== deliveries.length) this.writeDocument(path.join(this.paths.root, "task-stops.json"), remaining);
    return { stopped };
  }

  cancellationsForWorker(workerId: string): Array<{ sessionId: string; runId: string; claimToken: string }> {
    assertId(workerId, "worker id");
    return [...this.liveQueueSessionIds()].flatMap((sessionId) =>
      this.scanQueue(sessionId).turns.flatMap((turn) =>
        turn.state === "stopped" && turn.claim?.workerId === workerId
          ? [{ sessionId, runId: turn.runId, claimToken: turn.claim.token }]
          : [],
      ),
    );
  }

  private allSessions(): Session[] {
    return this.sessionIds().map((sessionId) => this.getSession(sessionId));
  }

  /**
   * Every session's id, and NOTHING ELSE READ.
   *
   * `allSessions` costs four file reads per session — `session.json`, and then
   * `withActivity`'s queue plus requests — which is the right price for a
   * sidebar and the wrong one for a scan that only wants to know which
   * sessions have work in them. This is one `readdir`.
   */
  private sessionIds(): string[] {
    if (this.executionStore) return this.executionStore.sessionIds();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.paths.sessions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => entry.name);
  }

  /**
   * THE SESSIONS A WORKER COULD POSSIBLY HAVE BUSINESS WITH — the index that
   * makes the number of IDLE conversations cost nothing.
   *
   * Every worker heartbeat asks three questions (what was cancelled, what was
   * answered, what was steered) and a claim asks a fourth, and each of them
   * used to walk EVERY session on disk: at ten beats a second and fifty
   * sessions that is thousands of file reads a second to discover, almost
   * always, that nothing has changed. The daemon burned most of a core doing
   * it, and the cost grew with every conversation ever started — so the
   * machine got slower the longer it was used, which is the shape of the
   * complaint that produced this index.
   *
   * MAINTAINED IN `writeQueue`, WHICH IS THE ONLY WRITER. Every turn
   * transition in this store rewrites the whole queue through that one method,
   * so there is exactly one place that can put a session in or out of this set
   * — no transition can forget to. Built lazily on first use by the same scan
   * it replaces, so a cold daemon pays it once instead of ten times a second.
   *
   * The membership test is deliberately the UNION of what the four queries
   * need, so one index serves all of them: anything not yet settled, plus a
   * stopped turn that still carries a claim (the worker learns of a stop by
   * reading exactly those).
   */
  private liveQueueIndex: Set<string> | undefined;

  /**
   * THE INDEX SAYS WHICH QUEUES TO LOOK AT; THIS SAYS WHAT IS IN THEM.
   *
   * Narrowing the scan to the live sessions was only half the problem. Each of
   * those queues was still fetched from sqlite, JSON-parsed and validated
   * through zod on EVERY question — three per heartbeat, ten heartbeats a
   * second — and a real conversation's queue is not small: on the machine that
   * produced this, 45 live sessions held 3.3 MB over 1233 turns, so the daemon
   * re-parsed about ten megabytes a second to conclude, every time, that
   * nothing had changed. `readQueue` alone was 43.9% of a profile taken at
   * rest, split between sqlite, `JSON.parse` and `TurnSchema`.
   *
   * VALID UNTIL `writeQueue` DROPS IT, which is sound for exactly the reason
   * `liveQueueIndex` above is: one writer, in this process, and the store is
   * the daemon's alone. Dropped rather than replaced on write — a caller
   * mutates its queue in place and writes when it is done, and seeding the
   * cache from that object would hand the next reader something the caller may
   * still be editing. Re-reading once after a write is the cheap half.
   */
  private readonly queueCache = new Map<string, SessionQueue>();

  /**
   * A queue for READING ONLY — the shared parsed copy, not a caller's to edit.
   *
   * Every use is a scan that asks a question and keeps nothing: which sessions
   * concern a worker, what was cancelled, answered or steered, which turn could
   * be claimed next. Anything that intends to CHANGE a queue calls `readQueue`
   * and gets an object of its own, so the two uses cannot be confused.
   */
  private scanQueue(sessionId: string): SessionQueue {
    const cached = this.queueCache.get(sessionId);
    if (cached) return cached;
    const queue = this.readQueue(sessionId);
    this.queueCache.set(sessionId, queue);
    return queue;
  }

  private liveQueueSessionIds(): Set<string> {
    if (this.liveQueueIndex) return this.liveQueueIndex;
    const index = new Set<string>();
    for (const sessionId of this.sessionIds()) {
      if (queueConcernsAWorker(this.scanQueue(sessionId))) index.add(sessionId);
    }
    this.liveQueueIndex = index;
    /**
     * AND THE COLD BUILD LETS GO OF WHAT IT READ TO GET HERE.
     *
     * This is the one scan that touches every session on disk, so without
     * this the cache would hold every conversation ever started, in parsed
     * form, for the life of the daemon — the same unbounded growth with age
     * that the index itself was written to stop. Everything still in the
     * cache afterwards is in the index, and `writeQueue` drops the two
     * together from then on.
     */
    for (const sessionId of this.queueCache.keys()) {
      if (!index.has(sessionId)) this.queueCache.delete(sessionId);
    }
    return index;
  }

  private readQueue(sessionId: string): SessionQueue {
    const stored = this.readDocument(sessionQueueFile(this.paths, sessionId));
    if (stored === undefined) return emptyQueue(sessionId);
    return parseQueue(stored, sessionId);
  }

  /** THE ONLY WRITER, which is what lets `liveQueueIndex` and `queueCache` be
   *  maintained in one place rather than at each of the thirteen transitions
   *  that call this. */
  private writeQueue(sessionId: string, queue: SessionQueue): void {
    this.writeDocument(sessionQueueFile(this.paths, sessionId), queue);
    this.queueCache.delete(sessionId);
    this.announceQueueChange();
    if (!this.liveQueueIndex) return;
    if (queueConcernsAWorker(queue)) this.liveQueueIndex.add(sessionId);
    else this.liveQueueIndex.delete(sessionId);
  }

  /**
   * ONCE PER COMMAND, AND ONLY IF IT COMMITS.
   *
   * A single command rewrites several queues — a stop settles a turn and
   * requeues the steers aimed at it — and the listener only needs to be told
   * that SOMETHING moved, so the flag collapses them into one call. Deferred
   * to `afterCommit` for the same reason the request notifier is: announcing a
   * write the transaction then rolled back would wake a worker to look for
   * work that does not exist.
   */
  private announceQueueChange(): void {
    if (!this.onQueueChanged) return;
    if (!this.executionStore || this.commandDepth === 0) {
      this.onQueueChanged();
      return;
    }
    if (this.queueChangeAnnounced) return;
    this.queueChangeAnnounced = true;
    this.afterCommit.push(() => {
      this.queueChangeAnnounced = false;
      this.onQueueChanged?.();
    });
  }

  /**
   * AFTER THE COMMIT, FOR THE SAME REASON `announceQueueChange` DEFERS: telling
   * a worker to abort a claim a rollback then resurrects would kill a turn the
   * store still believes is running. Outside a transaction there is nothing to
   * wait for and the call is direct.
   */
  private announceStoppedClaims(cancellations: StoppedClaim[]): void {
    if (!this.onTurnsStopped || cancellations.length === 0) return;
    if (!this.executionStore || this.commandDepth === 0) {
      this.onTurnsStopped(cancellations);
      return;
    }
    this.afterCommit.push(() => this.onTurnsStopped?.(cancellations));
  }

  private requireRunningClaim(sessionId: string, runId: string, claimToken: string): Turn {
    return this.requireRunningClaimFromQueue(this.readQueue(sessionId), runId, claimToken);
  }

  /**
   * THE SENDER'S CLAIM — `requireRunningClaim` with somewhere to go when it
   * refuses.
   *
   * A REFUSAL HERE IS DIFFERENT IN KIND from a late observation's. An
   * observation would MUTATE a terminal turn, so "no" is the whole answer and
   * the turn's immutability is the reason. A `sessions_send` mutates nothing on
   * the sender's turn — the claim is read only to say WHO is speaking — and the
   * work it was carrying is a message to somebody else that now simply does not
   * arrive. Measured: an orchestrator mid-restart lost every send it made for
   * the rest of its turn, and the only workaround anybody found was to wait for
   * its next turn, because the refusal said the turn had ended and nothing
   * about what to do instead.
   *
   * SO IT STILL REFUSES — a settled claim does not prove a live sender, and
   * accepting one would attribute a peer's message to a turn that is over — but
   * it NAMES THE TURN THIS SESSION IS ACTUALLY RUNNING. The worker proves each
   * send with the claim that is live when the call arrives (see `liveClaims` in
   * worker.ts), so "retry" is a real instruction: the retry carries the turn
   * named here. When there is no live turn, it says that instead, because
   * retrying would be the same refusal again.
   *
   * ONLY FOR A CLAIM THAT REALLY IS THIS SESSION'S. A token that never matched
   * the named turn is a foreign or forged claim and keeps the flat answer — the
   * longer one would be a hint offered to whoever guessed wrong. A turn whose
   * claim a RESTART retired (`recover()` deletes it) has no token left to match,
   * so it is recognised by being terminal with no claim at all.
   */
  private requireSenderClaim(proof: { sessionId: string; runId: string; claimToken: string }): Turn {
    const queue = this.readQueue(proof.sessionId);
    try {
      return this.requireRunningClaimFromQueue(queue, proof.runId, proof.claimToken);
    } catch (error) {
      if (!(error instanceof EngineStateError) || error.code !== "conflict") throw error;
      const named = queue.turns.find((turn) => turn.runId === proof.runId);
      // ONLY A TURN THAT ENDED. A claim against one that has not started yet,
      // or is being steered, is early rather than stale, and the flat refusal
      // is the true thing to say about it.
      if (!named || (named.state !== "completed" && named.state !== "failed" && named.state !== "stopped")) throw error;
      if (named.claim && named.claim.token !== proof.claimToken) throw error;
      const live = queue.turns.find((turn) => turn.state === "running" && turn.claim);
      const ending = named.state === "stopped" ? `was stopped (${named.stopReason ?? "stopped"})` : `has already settled (${named.state})`;
      throw new EngineStateError(
        "conflict",
        live
          ? `The turn this message was sent from (${proof.runId}) ${ending}, so it cannot be named as the sender. This session's live turn is ${live.runId} — send it again and it goes from that turn.`
          : `The turn this message was sent from (${proof.runId}) ${ending}, and this session has no live turn to send from. Nothing was delivered; say it again on your next turn.`,
      );
    }
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
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
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
   *
   * A WAKE COUNTS AS THE SESSION'S OWN WORK. An orchestrator asked to be told
   * when its peers finish; the telling is work it queued, one step removed,
   * and a snooze that silenced it would silence the whole point.
   *
   * ONLY THE SHELF IS LIFTED — THE PIN SURVIVES, and getting that wrong is
   * what made pinning look broken. `settledOverride` is one field holding two
   * opposite decisions ("settled" hides, "active" keeps), so clearing it
   * unconditionally read as "new work un-shelves a session" and acted as "the
   * next turn quietly throws away the pin you set". A pin is a standing
   * instruction about the LIST; nothing the session goes on to do contradicts
   * it, and only unpinning or settling should take it away.
   */
  private wakeSessionForNewWork(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.settledOverride !== "settled" && session.snoozedUntil === undefined) return;
    if (session.settledOverride === "settled") {
      delete session.settledOverride;
      delete session.settledAt;
      /**
       * AND THE ERRAND IS REMEMBERED AS TAKEN BACK — issue #378. Work arriving
       * on a row the ENGINE shelved is the shelf being lifted, and the facts
       * behind that shelving do not expire: without the record, the next
       * evaluation would put the row straight back and the message somebody
       * just typed would land in a settled conversation.
       */
      releaseDelegationSettle(session);
    }
    delete session.snoozedUntil;
    delete session.snoozedAt;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.updated", session });
  }

  /** Prefer metadata, but let a completed durable turn heal an interrupted metadata write. */
  private resumeCursorFor(session: Session): string | undefined {
    if (session.resumeCursor) return session.resumeCursor;
    const recovered = latestProviderSessionId(this.readQueue(session.id));
    if (!recovered) return undefined;
    session.resumeCursor = recovered;
    session.updatedAt = this.now();
    this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(session));
    return recovered;
  }

  /**
   * Items are a PROJECTION the engine maintains beside the journal, not a
   * second source of truth: `items.json` could be rebuilt by replaying
   * `item.*` events from zero. It exists so opening a long session does not
   * require that replay, which is the same reason `queue.json` exists beside
   * `turn.*`.
   */
  /**
   * THE PARSED PROJECTION, KEPT UNTIL SOMETHING WRITES IT — `queueCache`'s
   * bargain, for the document that is bigger than the queue.
   *
   * Reading items is a sqlite row, a `JSON.parse` and a zod validation of every
   * row in it, and the streaming path asks for it once per `reportObservations`
   * to answer one question: does this delta's item exist. On a session holding
   * 327 items that read was most of the 1.57 ms a streamed chunk cost.
   *
   * Sound for the same reason the queue's is: one writer, in this process,
   * dropped by `writeItems` rather than replaced. The entries are SHARED — a
   * caller gets a Map of its own over the same `Item` objects — which every
   * caller already respects by replacing an item (`items.set(id, {...old})`)
   * rather than editing one in place. Nothing here may edit an `Item` in place.
   *
   * BOUNDED, unlike the queue's, which prunes itself against the live index:
   * there is no equivalent index for items, and one entry per session ever read
   * would be ~98 MB on the dogfood store. The cap is the number of sessions
   * that can plausibly be streaming at once; past it the oldest goes.
   */
  private readonly itemsCache = new Map<string, Item[]>();
  private static readonly ITEMS_CACHE_LIMIT = 8;

  private readItems(sessionId: string): Map<string, Item> {
    const cached = this.itemsCache.get(sessionId);
    if (cached) return new Map(cached.map((item) => [item.id, item]));
    const stored = this.readDocument(itemsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = ItemSchema.array().safeParse((stored as { items?: unknown }).items);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    if (this.itemsCache.size >= EngineStore.ITEMS_CACHE_LIMIT) {
      const oldest = this.itemsCache.keys().next();
      if (!oldest.done) this.itemsCache.delete(oldest.value);
    }
    this.itemsCache.set(sessionId, parsed.data);
    return new Map(parsed.data.map((item) => [item.id, item]));
  }

  private writeItems(sessionId: string, items: Map<string, Item>): void {
    this.writeDocument(itemsFile(this.paths, sessionId), { version: STATE_VERSION, items: [...items.values()] });
    this.itemsCache.delete(sessionId);
  }

  /**
   * Tasks are a projection for the same reason items are — and they matter
   * MORE after a restart, not less. A background task outlives the turn that
   * started it, so a client reopening a cold session has no live stream to
   * learn about it from; `tasks.json` is the only thing that can still say the
   * session is working.
   */
  private readTasks(sessionId: string): Map<string, Task> {
    const stored = this.readDocument(tasksFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = TaskSchema.array().safeParse((stored as { tasks?: unknown }).tasks);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid task projection");
    return new Map(parsed.data.map((task) => [task.id, task]));
  }

  private writeTasks(sessionId: string, tasks: Map<string, Task>): void {
    this.writeDocument(tasksFile(this.paths, sessionId), { version: STATE_VERSION, tasks: [...tasks.values()] });
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
   * A TURN THAT ENDED WITHOUT ITS ITEMS ENDING. The driver closes what it
   * still holds open when a turn finishes on its own; a turn that is STOPPED
   * from the cockpit, that fails, or that the engine finds running after a
   * restart never reaches that code, and the tool row the model was inside
   * stayed `inProgress` — measured: seven `command_execution` rows across
   * prod sessions, each spinning under a turn marked stopped, one of them a
   * shell the human had cancelled a minute earlier. An item is the turn's
   * own: unlike a background task it cannot outlive the turn, so every
   * terminal transition closes what the turn left open. Closed as `failed`
   * — the vocabulary has no "stopped" for an item, and "did not finish" is
   * what the row should read as.
   */
  /**
   * A turn that ended can no longer be answered: the worker parked on these
   * requests is gone with it. Left open, they keep the session `blocked` and
   * the composer in answer mode over a turn nothing will resume. Retired as
   * `cancelled` — the audit trail says nobody chose. Never called for an
   * ambiguous turn: that one is still undecided.
   */
  private closeOpenRequests(sessionId: string, runId: string, at: number): number {
    const requests = this.readRequests(sessionId);
    let closed = 0;
    for (const request of requests.values()) {
      if (request.runId !== runId || request.state !== "open") continue;
      request.state = "resolved";
      request.decision = "cancel";
      request.resolvedBy = "cancelled";
      request.resolvedAt = at;
      request.reason = "the turn ended before this request was answered";
      requests.set(request.id, request);
      this.appendEvent(sessionId, { type: "request.resolved", requestId: request.id, decision: "cancel", resolvedBy: "cancelled", reason: request.reason }, runId);
      closed += 1;
    }
    if (closed > 0) this.writeRequests(sessionId, requests);
    return closed;
  }

  /**
   * THE SAME SWEEP FOR MANY RUNS, IN ONE READ — what `recover()` needs.
   *
   * The per-turn closers below are right for a live transition, where one turn
   * has just ended. At boot there are hundreds of them: measured on a real
   * store, 114 sessions held 1471 terminal turns, and reading each session's
   * items (577 KB average), requests and tasks once PER TURN made
   * `readDocument` 15.7 s of a 21 s engine start — which is the whole cold
   * launch, because the desktop shell does not show its window until the engine
   * answers `/v2/health` (apps/desktop/main.js:1895).
   *
   * Identical outcome: the per-turn versions only ever match rows whose `runId`
   * is that turn's, so matching against the SET of terminal run ids closes
   * exactly the same rows and appends the same events.
   */
  private closeOpenItemsForRuns(sessionId: string, runIds: ReadonlySet<string>, at: number): number {
    if (runIds.size === 0) return 0;
    const items = this.readItems(sessionId);
    let closed = 0;
    for (const item of items.values()) {
      if (!runIds.has(item.runId) || item.status !== "inProgress") continue;
      const settled: Item = { ...item, status: "failed", completedAt: at };
      items.set(item.id, settled);
      this.appendEvent(sessionId, { type: "item.completed", item: settled }, item.runId);
      closed += 1;
    }
    if (closed > 0) this.writeItems(sessionId, items);
    return closed;
  }

  private closeOpenRequestsForRuns(sessionId: string, runIds: ReadonlySet<string>, at: number): number {
    if (runIds.size === 0) return 0;
    const requests = this.readRequests(sessionId);
    let closed = 0;
    for (const request of requests.values()) {
      if (!runIds.has(request.runId) || request.state !== "open") continue;
      request.state = "resolved";
      request.decision = "cancel";
      request.resolvedBy = "cancelled";
      request.resolvedAt = at;
      request.reason = "the turn ended before this request was answered";
      requests.set(request.id, request);
      this.appendEvent(sessionId, { type: "request.resolved", requestId: request.id, decision: "cancel", resolvedBy: "cancelled", reason: request.reason }, request.runId);
      closed += 1;
    }
    if (closed > 0) this.writeRequests(sessionId, requests);
    return closed;
  }

  private closeOpenItems(sessionId: string, runId: string, at: number): number {
    const items = this.readItems(sessionId);
    let closed = 0;
    for (const item of items.values()) {
      if (item.runId !== runId || item.status !== "inProgress") continue;
      const settled: Item = { ...item, status: "failed", completedAt: at };
      items.set(item.id, settled);
      this.appendEvent(sessionId, { type: "item.completed", item: settled }, runId);
      closed += 1;
    }
    if (closed > 0) this.writeItems(sessionId, items);
    return closed;
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
    options: { runId?: string; runIds?: ReadonlySet<string>; includeBackground: boolean; onlyBackground?: boolean; state?: "failed" | "stopped" },
  ): Task[] {
    const tasks = this.readTasks(sessionId);
    const closedTasks: Task[] = [];
    for (const [id, task] of tasks) {
      if (options.runId !== undefined && task.runId !== options.runId) continue;
      // MANY RUNS, ONE READ. `recover()` sweeps every terminal turn of a
      // session; asking per turn re-read this whole document once per turn.
      if (options.runIds !== undefined && !options.runIds.has(task.runId)) continue;
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
    const deliveries = this.readTaskStopDeliveries();
    const turns = this.readQueue(sessionId).turns;
    const driver = this.getSession(sessionId).driver;
    for (const task of closed) {
      if (!task.providerTaskId) continue;
      pending.add(task.providerTaskId);
      const workerId = turns.find((turn) => turn.runId === task.runId)?.claim?.workerId;
      if (workerId) deliveries.push({ deliveryId: `stop_${crypto.randomUUID().replaceAll("-", "")}`, sessionId,
        providerTaskId: task.providerTaskId, workerId, driver });
    }
    this.writeDocument(path.join(this.paths.root, "task-stops.json"), deliveries);
    if (pending.size > 0) this.pendingStopTasks.set(sessionId, pending);
    this.touchSession(sessionId, at);
    return closed.length;
  }

  private readTaskStopDeliveries(): Array<{ deliveryId: string; sessionId: string; providerTaskId: string; workerId: string; driver: ProviderDriverKind }> {
    const value = this.readDocument(path.join(this.paths.root, "task-stops.json")) ?? [];
    if (!Array.isArray(value) || value.some((row) => !row || typeof row.deliveryId !== "string" || typeof row.sessionId !== "string" ||
      typeof row.providerTaskId !== "string" || typeof row.workerId !== "string" || !["claude", "codex", "opencode"].includes(row.driver)))
      throw new EngineStateError("invalid_request", "invalid task-stop delivery store");
    return value;
  }

  taskStopsForWorker(workerId: string, acknowledged: string[] = []): WorkerStatus["stopTask"] {
    const pending = this.readTaskStopDeliveries();
    const ack = new Set(acknowledged);
    const remaining = pending.filter((delivery) => delivery.workerId !== workerId || !ack.has(delivery.deliveryId));
    if (remaining.length !== pending.length) this.writeDocument(path.join(this.paths.root, "task-stops.json"), remaining);
    return remaining.filter((delivery) => delivery.workerId === workerId).map(({ workerId: _owner, ...delivery }) => delivery);
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
    const stored = this.readDocument(requestsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = RequestSchema.array().safeParse((stored as { requests?: unknown }).requests);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid request projection");
    return new Map(parsed.data.map((request) => [request.id, request]));
  }

  private writeRequests(sessionId: string, requests: Map<string, EngineRequest>): void {
    this.writeDocument(requestsFile(this.paths, sessionId), { version: STATE_VERSION, requests: [...requests.values()] });
  }

  /** One observation → at most one journal record, plus its projection edit. */
  private journalObservation(
    sessionId: string,
    turn: Turn,
    observation: TurnObservation,
    projection: { items: Map<string, Item>; tasks: Map<string, Task>; itemsTouched: boolean; tasksTouched: boolean; turnTouched: boolean },
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
      const written = this.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      /**
       * …BUT A READER ARRIVING MID-REPLY STILL HAS TO SEE THE PREFIX (#214).
       *
       * So the text accumulates in memory, watermarked with the id of the
       * delta that last extended it, and `openItemPrefix` hands it to a
       * snapshot. A CACHE, NOT THE RECORD: the deltas above are durable, so an
       * empty map after a restart is rebuilt by re-reading them. That is what
       * makes it safe to drop this at any time — including when Stop leaves an
       * item open forever, where the prefix is the only account of what the
       * reader was shown.
       */
      this.extendOpenPrefix(sessionId, observation.itemId, observation.text, written.id);
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
      projection.itemsTouched = true;
      this.appendEvent(sessionId, { type: "item.completed", item }, turn.runId);
      // The text lives in `detail` from here on, so the accumulator's copy is
      // dead weight. This is what bounds the map: one entry per OPEN item.
      this.dropOpenPrefix(sessionId, observation.itemId);
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
    if (observation.kind === "display.opened") {
      // A gesture, not state: the agent asked the cockpit to show one file.
      // No projection for the same reason browser.state has none — a client
      // replaying last week's journal must not have last week's panel opened
      // at it, and the cockpit's own fold guards against exactly that.
      this.appendEvent(
        sessionId,
        { type: "display.opened", path: observation.path, ...(observation.title ? { title: observation.title } : {}) },
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
       * A SETTLED TASK THAT LEARNS NOTHING NEW IS NOT RE-ANNOUNCED. The fold
       * above keeps the stored state, but it still appended a `task.completed`
       * per report — measured: 58 tasks in one session with two or more
       * closes, and one closed a third time under a turn that had started
       * zero seconds earlier, because the new turn's pump replayed the CLI's
       * buffered frames about it. A tailing client folds those as fresh
       * completions. Only a report that ADDS something (the notification's
       * summary arriving after a sweep already closed the row) is worth a
       * row; a bare restatement of the ending is dropped here.
       */
      if (settled) {
        const additions = definedOnly(seed);
        const changed = Object.entries(additions)
          .filter(([key, value]) => !(key === "id" || key === "state" || key === "kind" || key === "providerTaskId") && JSON.stringify(known[key as keyof Task]) !== JSON.stringify(value))
          .map(([key]) => key);
        if (changed.length === 0) return;
        /**
         * THE SUMMARY ARRIVING A FRAME AFTER THE CLOSE IS NOT A SECOND CLOSE.
         * Measured on the dogfood session: `background_tasks_changed` closes
         * a shell with no summary, then its `task_notification` carries one —
         * two `task.completed` events for one ending. The summary is folded
         * into the row (the projection is right) but not re-announced. Judged
         * on what CHANGED, not on the seed's key set: the driver repeats the
         * whole row (title, kind, backgrounded) on every report.
         */
        const onlySummary = changed.every((key) => key === "resultText" || key === "usage");
        if (onlySummary) {
          projection.tasks.set(known.id, { ...known, ...definedOnly(seed), id: known.id, kind: known.kind, state: known.state, runId: known.runId, startedAt: known.startedAt, updatedAt: at });
          projection.tasksTouched = true;
          return;
        }
      }
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
    projection.itemsTouched = true;
    const written = this.appendEvent(sessionId, { type: started ? "item.started" : "item.updated", item }, turn.runId);
    // AN ITEM THAT JUST OPENED HAS NO EARLIER DELTAS, which is the only moment
    // the accumulator can know it holds the whole prefix. Every later extend
    // inherits that; an entry born any other way is rebuilt on read.
    if (started) this.rememberOpenPrefix(sessionId, item.id, { text: "", through: written.id, sealed: true });
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
    // The head is read from disk ONCE per session per store, through the same
    // parse that validates every record and repairs a torn tail — so a restart
    // still recovers exactly as before. After that the daemon lock makes this
    // process the only writer, and the head is whatever it last wrote. Parsing
    // a 9 MB journal to learn one integer on every append was the cost that
    // made long sessions sluggish.
    const head = this.executionStore ? this.executionStore.cursor(sessionId) : this.journalHead.get(sessionId) ?? readJournal(file).at(-1)?.id ?? 0;
    const record = {
      id: head + 1,
      at: this.now(),
      sessionId,
      ...(runId ? { runId } : {}),
      ...event,
    } as EngineEvent;
    if (this.executionStore) {
      this.executionStore.append(record);
      return record;
    }
    // NDJSON is an append-only stream, not a document: do not replace it with
    // tmp+rename. The daemon lock gives this one writer and each record is one append.
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      // A failed write may have left a partial record. Forget the head so the
      // next append goes back through `readJournal`, which repairs the tail
      // before anything is concatenated onto it.
      this.journalHead.delete(sessionId);
      throw error;
    }
    this.journalHead.set(sessionId, record.id);
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
