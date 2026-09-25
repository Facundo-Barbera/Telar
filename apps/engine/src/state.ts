// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import { ExecutionStore, type ExecutionHousekeeping, type SessionIndexRow } from "./execution-store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoResolution,
  deadlineResolution,
  defaultAllowed,
  narrowerRuntimeMode,
  PROVIDER_CAPABILITIES,
  DEFAULT_ATTENDED_RUNTIME_MODE,
  DEFAULT_DETACHED_RUNTIME_MODE,
  defaultInstanceIdForDriver,
  isBackgroundWork,
  livenessOf,
  AgentOrientation as AgentOrientationSchema,
  DEFAULT_AGENT_ORIENTATION,
  DEFAULT_INBOX_POLICY,
  DEFAULT_RETENTION_POLICY,
  RetentionPolicy as RetentionPolicySchema,
  type RetentionPolicy,
  type RetentionBucket,
  type JournalRetirement,
  RETENTION_BUCKET_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_TEXT_GEN_POLICY,
  InboxPolicy as InboxPolicySchema,
  MAX_SIDEBAR_PROJECT_ORDER,
  MAX_SIDEBAR_SESSION_ORDER,
  SessionDefaults as SessionDefaultsSchema,
  SidebarLayout as SidebarLayoutSchema,
  workspaceBaseRef,
  workspacePath,
  TextGenPolicy as TextGenPolicySchema,
  Item as ItemSchema,
  HOLD_REPORTS,
  MAX_AUTO_SETTLE_HOURS,
  MAX_REPORT_WINDOW_MINUTES,
  STALLED_AFTER_MS,
  MIN_AUTO_SETTLE_HOURS,
  MIN_REPORT_WINDOW_MINUTES,
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
  // THE CLIENTS' OWN SETTLING RULE, imported rather than re-implemented: the
  // live list drops the rows a rail would shelve (#457), so an engine that
  // disagreed with a cockpit here would produce a conversation neither of them
  // shows. See `protocol/settling.ts`.
  isShelved,
  settlingActivityOf,
  // AND THE WAKE MOMENT, from the same file and for the same reason. It already
  // decides the scheduled expiry and the early wake together; `sweepSnoozeWakes`
  // records what it answers rather than deciding again (#490, #586).
  wokeAt,
  type AssignmentTurn,
  type SessionAssignment,
  type LiveSessionRow,
  type SessionSettledBy,
  type PluginPatch,
  type LatexConfig,
  Session as SessionSchema,
  NotificationDetail as NotificationDetailSchema,
  Subscription as SubscriptionSchema,
  Task as TaskSchema,
  Turn as TurnSchema,
  TurnAttachment as TurnAttachmentSchema,
  TurnObservation as TurnObservationSchema,
  TurnState as TurnStateSchema,
  WorkerTurnFailureCode as WorkerTurnFailureCodeSchema,
  type BrowserProvider,
  type BrowserSnapshot,
  type BrowserTab,
  type GitCommitEntry,
  type GitHubCheckLog,
  type GitHubCommentResult,
  type GitHubFacets,
  type GitHubIssueFilter,
  type GitHubIssueRead,
  type GitHubMergeMethod,
  type GitHubMergeResult,
  type GitHubPullCreateResult,
  type GitPushResult,
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
  type GitFilePatch,
  type GitReadFailure,
  type SessionDiff,
  type EngineEvent,
  type ConversationImportDetail,
  type Item,
  type McpServer,
  type NotificationDetail,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
  type TurnAttachment,
  type TurnModelSelection,
  type ProviderDriverKind,
  // The runtime enum too, not just the type: `readProviderInstances` asks it
  // whether a row on disk names a driver this build still has.
  ProviderDriverKind as ProviderDriverKindSchema,
  type Task,
  type TaskSeed,
  type Project,
  type EngineRequest,
  type RequestDecision,
  type RequestDefault,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type ReportCadence,
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
  type UsageSnapshot,
  type EnvMode,
  type ModelSelection as ModelSelectionValue,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
  type WorktreeInventory,
  type WorktreeReclaimItem,
  type WorktreeReclaimResult,
} from "@telar/engine-client";
import { atomicWrite, atomicWriteText } from "./atomic";
import { arrayElementRanges, parseSpan, type DocumentIndex } from "./document-window";
import {
  boundedOutline,
  context,
  firstLine,
  outlineRow,
  summariseTurn,
  FIND_SCAN,
  GREP_CONTEXT_CHARS,
  ITEM_TITLE_CHARS,
  TURN_ANSWER_NONE,
  TURN_ANSWER_NO_SUCH_RUN,
  WHY_CHARS,
  type OutlineRow,
} from "./turn-summary";
import { TELAR_ORIENTATION } from "./orientation";
import { dictationCredential, readDictationKey, writeDictationKey } from "./dictation/credentials";
import { lastKeytermFit, type KeytermFit } from "./dictation/fit";
import { dictationLanguages, isDictationLanguage, isDictationProviderId, type DictationLanguage, type DictationProviderId } from "./dictation/provider";
import { cleanDictationVocabulary, readDictationSettings, writeDictationSettings } from "./dictation/settings";
import type { DictationContext } from "./dictation/keyterms";
import { delegationSettle, newestAssignment, type DeliveryTurn } from "./delegation-settling";
import { withComputerUse, type ResolvedComputerUse } from "./computer-use";
import { confirmProjectIcon, confirmProjectIconSync, findProjectIcon, findProjectIconAsync, type ProjectIcon } from "./project-icon";
import { listWorkspaceFilesAsync, readWorkspaceFile, readWorkspaceFileAsync, readWorkspaceFileBytes, writeWorkspaceFile } from "./files";
import { needsRefresh, refreshAccessToken, type ConnectContext, type McpOAuthRecord, type OAuthClientStore } from "./mcp-oauth";
import {
  commitSessionWork,
  defaultRemoteBaseAsync,
  gitOverviewAsync,
  listGitRefsAsync,
  projectRemoteAsync,
  pullRequestBlockedBy,
  pushSessionBranch,
  sessionBranchFacts,
  sessionDiffAsync,
  sessionFilePatchAsync,
  type GitOverview,
} from "./git";
import { ensureTelarGitignore, removeTelarGitignore } from "./gitignore";
import { cloneRepository, isCloneFailure } from "./clone";
import { heldDelivery, MAX_COHORT_ENTRIES, MAX_DELIVERIES, mergeNotifications, mergeRunOutcome, notificationLabel, peerNotification, wakeNotification } from "./notification";
import {
  commentOn,
  DEFAULT_ISSUE_FILTER,
  DEFAULT_PULL_FILTER,
  defaultGhRunner,
  mergePull,
  openPullRequest,
  readCheckLog,
  readForgeFacets,
  readGitHub,
  readIssue,
  readPull,
  type GhRunner,
} from "./github";
import { readModelCatalogue } from "./models";
import { inheritedOwnedEnv, providerEnvIsCredential, providerOwnsEnv, providerProcessEnv, stoppedInheriting } from "./provider-instances";
import { adoptClaudeConversation, describeAdoption, listAdoptableConversations, type Adoption } from "./claude-adopt";
import type { ClaudeConversation, ForkCut } from "./claude-fork";
import { describeImport } from "./claude-transcript";
import { applyModelManifest, BUNDLED_MANIFEST, longDefaultOf, normalizeClaudeModel, type ModelManifest } from "./model-manifest";
import { applyModelOverlay, chosenDefault } from "./model-overlay";
import { LatexMachineSettings as LatexMachineSettingsSchema } from "./plugins/latex";
import { DataScienceMachineSettings as DataScienceMachineSettingsSchema } from "./plugins/data-science";
import { decideSchedule, nextOccurrence, usableZone, type ScheduleRule } from "./schedules";
import type { ScheduleRow } from "./execution-store";
import { createSessionWorktreeAsync, createWorktreeQueue, defaultGitRunner, defaultAsyncGitRunner, defaultWorktreeGitRunner, type AsyncGitRunner, type GitResult, isGitWorkTree, lockSessionWorktree, prepareSessionWorktree, removeSessionWorktreeAsync, removeUnregisteredCheckout, type GitRunner, type WorktreePlan, type WorktreeQueue } from "./worktree";
import { buildInventory, type InventoryProject, type InventorySession } from "./worktree-inventory";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf, worktreesRootBlocker } from "./worktrees-location";
import { measureDirectory } from "./storage";
import { moveCheckouts, type Checkout, type MoveOutcome } from "./worktrees-move";
import { findVolumeMount, mountSignature, probeAvailability, volumeForRoot, type ProjectAvailability, type VolumeDeps } from "./volumes";
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

/**
 * WHAT A TIMED-OUT REQUEST TELLS THE MODEL THAT ASKED — issue #541 D.
 *
 * Rides `EngineRequest.reason`, which `resolutionsForWorker` hands back to the
 * worker and the drivers turn into the tool's own answer. Without it a declined
 * default reads to the model exactly like a person saying no, and it adapts to a
 * judgement nobody made; an accepted one reads like approval that was given.
 *
 * AND IT SAYS NOT TO ASK AGAIN THE SAME WAY, for `DECLINED_ANSWER`'s reason one
 * file over: a model that reads a timeout as "that attempt failed" re-opens the
 * identical request, which parks, which times out, which is a loop nobody is
 * watching by construction.
 */
const TIMEOUT_REASON =
  "Nobody answered before this request's deadline, so the default stated when it was opened was taken. A person did not decide this. Do not re-open the same request — say what happened and carry on, or ask something the person can answer later.";

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
 * How long a turn's anchor probe may take — issue #741.
 *
 * MUCH SHORTER THAN `DEFAULT_GIT_TIMEOUT_MS`, and the difference is the point.
 * `rev-parse --verify HEAD` reads one file; thirty seconds of a shared pool
 * slot for it would be thirty seconds every other read waits behind, on a
 * command that runs at the start and end of every turn of every session. A
 * probe that does not answer in five seconds is a machine under load, and the
 * honest record of that is `read`, not a longer wait.
 *
 * The same five seconds `projectGitAsync`'s own HEAD read already uses.
 */
const ANCHOR_PROBE_MS = 5_000;
/**
 * A turn that is not yet history: waiting, running, or mid-promotion. The
 * snapshot window keeps every one of these on the first page whatever the
 * limit — the queue strip and the send path read turns, and an unsettled
 * turn hidden behind a page would be a message the composer did not know
 * it had. `steered` is terminal (its words live inside the run it joined).
 */
const ACTIVE_TURN_STATES = new Set<Turn["state"]>(["queued", "claimed", "running", "steering"]);

/**
 * HOW MANY SETTLED REQUESTS A SNAPSHOT CARRIES (#245).
 *
 * Windowing the key by turn was most of the fix, but it left the shape that
 * produced the complaint reachable: one long agentic turn can open thousands of
 * approvals, and every one of them rode a window that turn was in — 1,066,437
 * bytes per read on the dogfood store, re-read once a second by every open
 * cockpit. Nothing renders a settled request beyond the handful above the
 * composer, so the tail is the answer and the rest is the history that
 * `requests()` still serves in full.
 *
 * AN OPEN REQUEST IS NEVER DROPPED, whatever this number is: an unanswered
 * question is the one thing on this key a client must act on, and a snapshot
 * that omitted it would be a question nobody could answer.
 */
const SNAPSHOT_SETTLED_REQUESTS = 50;

/**
 * HOW MANY RESOLVED REQUESTS THE DOCUMENT ITSELF KEEPS (#545).
 *
 * `SNAPSHOT_SETTLED_REQUESTS` above bounded what a snapshot CARRIES; nothing
 * bounded what the store HOLDS. `requests.json` was append-only for the life of
 * a session — one orchestrator conversation had 4,902 rows, every one resolved,
 * and the store 43,280 across 345 documents, 33 MB that every heartbeat and
 * every activity fold re-read to find the handful that were open.
 *
 * SO THE DOCUMENT IS A WINDOW, NOT A LEDGER, and the ledger is the journal:
 * `request.opened` and `request.resolved` are appended for every one of these
 * and are never trimmed, so a resolved request that falls out of this window is
 * still answerable from `readEvents`. What the window has to keep is what a
 * client RENDERS — which is the same tail `boundedRequests` already chose, so
 * it is the same number.
 *
 * AN OPEN REQUEST IS NEVER DROPPED, whatever this number is: it is the one row
 * a session's `blocked` state and a worker's answer both depend on.
 */
const RESOLVED_REQUEST_HISTORY = 50;

/**
 * Drop all but the newest `RESOLVED_REQUEST_HISTORY` resolved rows, in place.
 *
 * IN PLACE, so the caller's map is exactly what was written: `writeRequests` is
 * the only writer and every mutation path hands it a map it has just edited.
 *
 * NEWEST BY WHEN IT WAS ANSWERED, NOT BY WHERE IT SITS, and the difference is a
 * bug rather than a nicety. The document is in OPEN order, and a question a
 * human left parked for an hour is answered long after the ones opened behind
 * it — so dropping from the front would drop the row that had just resolved,
 * which is precisely the row a blocked worker is polling the heartbeat for. The
 * sort is stable, so rows answered in the same tick keep document order.
 *
 * Returns how many rows went, so the boot sweep can report one line.
 */
function pruneResolvedRequests(requests: Map<string, EngineRequest>): number {
  const resolved = [...requests.values()].filter((request) => request.state !== "open");
  if (resolved.length <= RESOLVED_REQUEST_HISTORY) return 0;
  const oldestFirst = resolved.sort((left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0));
  const dropped = oldestFirst.slice(0, oldestFirst.length - RESOLVED_REQUEST_HISTORY);
  for (const request of dropped) requests.delete(request.id);
  return dropped.length;
}

/**
 * Every open request, plus the newest settled ones — see above.
 *
 * `chosen` narrows to a window's turns first when there is one; without it this
 * is the unwindowed snapshot, where the tail is the only bound.
 */
/**
 * IS THIS A ROW THIS STORE WROTE? — the cheap half of "validate on write, trust
 * on read" (#545). See `readRequests`: the schema walk that used to run per row
 * per read is now run ONCE, on the row `openRequest` creates. This is what is
 * left, and it exists so a foreign or hand-edited document still fails loudly.
 */
function isRequestRow(row: unknown): row is EngineRequest {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<EngineRequest>;
  return typeof candidate.id === "string" && typeof candidate.runId === "string" &&
    (candidate.state === "open" || candidate.state === "resolved");
}

function boundedRequests(all: EngineRequest[], chosen?: Set<string>): EngineRequest[] {
  const carried = chosen === undefined ? all : all.filter((request) => chosen.has(request.runId) || request.state === "open");
  const settled = carried.filter((request) => request.state !== "open");
  if (settled.length <= SNAPSHOT_SETTLED_REQUESTS) return carried;
  const dropped = new Set(settled.slice(0, settled.length - SNAPSHOT_SETTLED_REQUESTS));
  return carried.filter((request) => !dropped.has(request));
}

/**
 * ONE INDEX ROW PER TURN, NOT PER ELEMENT.
 *
 * `items.json` holds eight or more rows per turn, and an index with one entry
 * each would grow with the conversation — which is the thing being fixed. The
 * window chooses TURNS, so a turn's items only ever need one span between them,
 * and on a 500-turn session that is the difference between an index of a few
 * kilobytes and one of a hundred and sixty.
 *
 * A span may swallow rows belonging to other turns — nothing promises a turn's
 * items are contiguous, only that they are written in creation order and
 * usually are. The caller filters what it reads by `runId` regardless, so a
 * generous span costs bytes and never correctness.
 */
function coalesceByKey(rows: Array<{ key: string; tag?: string }>, ranges: Array<{ start: number; end: number }>): DocumentIndex["rows"] {
  const merged = new Map<string, DocumentIndex["rows"][number]>();
  for (const [at, row] of rows.entries()) {
    const range = ranges[at]!;
    const known = merged.get(row.key);
    if (!known) merged.set(row.key, { ...row, ...range });
    else {
      known.start = Math.min(known.start, range.start);
      known.end = Math.max(known.end, range.end);
    }
  }
  return [...merged.values()];
}

/**
 * WHICH ROWS A WINDOW HOLDS, decided from ids and states alone.
 *
 * Shared by the indexed read and the whole-document fallback so the two cannot
 * answer differently — the index exists to make the read cheap, not to change
 * what a page contains.
 */
function planWindow(
  rows: Array<{ key: string; tag?: string }>,
  window: { limit: number; before?: string },
): { chosen: Set<string>; page: { before: string | null; more: boolean } } {
  let end = rows.length;
  if (window.before !== undefined) {
    end = rows.findIndex((row) => row.key === window.before);
    if (end === -1) throw new EngineStateError("not_found", "page cursor names no turn in this session");
  }
  const active = (row: { tag?: string }): boolean => ACTIVE_TURN_STATES.has(row.tag as Turn["state"]);
  const settled = rows.slice(0, end).filter((row) => !active(row));
  const start = Math.max(0, settled.length - window.limit);
  const paged = settled.slice(start);
  // The active tail is never paged out — but only on the FIRST page; an older
  // page is history and must not repeat rows the client already has.
  const unsettled = window.before === undefined ? rows.filter(active) : [];
  return {
    chosen: new Set([...paged, ...unsettled].map((row) => row.key)),
    page: { before: start > 0 ? (paged[0]?.key ?? null) : null, more: start > 0 },
  };
}

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
 * A SECOND TELAR MEETING A LIVE LOCK IS NOT A CRASH — issue #894.
 *
 * `main.ts` exits with this instead of 1 when `acquireDaemonLock` refuses,
 * because the desktop shell has to tell those two apart and an exit code is the
 * only channel it has: the engine is forked with `stdio: "inherit"`, so a
 * packaged app's stderr goes somewhere nobody reads. On 1 the shell quits — an
 * engine that died is a cockpit full of errors. On this it puts a dialog up
 * first, which is the difference between "Telar refuses to open" and "a Telar
 * is already running".
 *
 * 3 RATHER THAN 2: node exits 1 on an uncaught throw and reserves 2 for a
 * shell's own misuse, so the lowest number that cannot be produced by either is
 * the first one that means something.
 *
 * THE SHELL KEEPS ITS OWN COPY of this number, because `apps/desktop/main.js`
 * is plain CommonJS that imports nothing from this app. `engine-exit.test.js`
 * reads both files and fails if they disagree.
 */
export const ENGINE_EXIT_LOCK_HELD = 3;

/**
 * THE TWO WAYS `turnAnswer` MISSES — declared in `turn-summary.ts` and
 * re-exported here, where they are thrown (#592, then #516's wall).
 *
 * The move is about what a module DRAGS: the query wall that pairs a sentence
 * with each of these is bound inside the out-of-process worker, which holds no
 * store, and importing them from this file would have put the whole
 * `EngineStore` in that process to reach two string literals. Every existing
 * importer of `TURN_ANSWER_NONE` from `./state` is untouched.
 */
export { TURN_ANSWER_NONE, TURN_ANSWER_NO_SUCH_RUN } from "./turn-summary";

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
 * How far the DURABLE `Turn.lastProgressAt` may drift behind the in-memory
 * ledger before the sweep folds it in.
 *
 * A BUDGET ON WRITES, not a property anyone reads. Stamping the turn at every
 * journal append would be one atomic queue write per streamed token-chunk; this
 * makes it one a minute for a busy session. It is a twentieth of
 * `STALLED_AFTER_MS`, so the lag can never be what decides a verdict.
 */
const PROGRESS_STAMP_MS = 60_000;

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


/**
 * THE STORE ROOT'S FILE LIST, RE-EXPORTED — it moved to `./state-paths` in #665
 * so that `execution-store.ts` and `worktrees-location.ts` can import it too;
 * `state.ts` importing either of them made the old home a cycle. Re-exported
 * rather than moved-and-updated at every call site, because the list did not
 * change and 40 imports rewritten is 40 chances to rewrite one wrongly.
 */
import { statePaths, type EngineStatePaths } from "./state-paths";
import type { ReapCandidate } from "./node-modules-reap";
export { statePaths, type EngineStatePaths };

/** Every regular file's size under `root`, one at a time. Iterative for the
 *  reason `storage.ts`'s walk is: a store holds a checkout per session and a
 *  `node_modules` inside several of them, and a recursive walk over that is a
 *  stack as deep as the worst dependency chain somebody installed. */
function* walkFiles(root: string): Generator<number> {
  const frontier = [root];
  while (frontier.length > 0) {
    const at = frontier.pop()!;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(at); } catch { continue; }
    if (stat.isDirectory()) {
      try { for (const name of fs.readdirSync(at)) frontier.push(path.join(at, name)); } catch { /* unreadable: counted as nothing */ }
      continue;
    }
    yield stat.size;
  }
}

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

/**
 * The same three-state rule for a NUMBER.
 *
 * Separate from `optionalPatch` rather than generic over it because of the one
 * line that does not carry over: an empty string is a third way of saying
 * "clear this", and a number has no such shape. Folding the two together would
 * mean a `trim` guard that only one caller can reach.
 */
function optionalNumberPatch<K extends string>(
  key: K,
  submitted: number | null | undefined,
  existing: number | undefined,
  normalise: (value: number) => number,
): Partial<Record<K, number>> {
  if (submitted === null) return {};
  const raw = submitted === undefined ? existing : submitted;
  if (raw === undefined) return {};
  return { [key]: normalise(raw) } as Partial<Record<K, number>>;
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
// It is unchanged; it left so a module this one imports can share the same
// writer without reaching back here for it, which would be a cycle. See that
// file's header.

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

/** The order every session list is in: newest work first, ties broken by id so
 *  two passes over the same store never disagree. Named because two readers
 *  share it (#464) and a sort written twice is a sort that drifts once. */
const newestFirst = (left: Session, right: Session): number =>
  right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);

/**
 * THE SESSION'S DIRECTORY, OR A REFUSAL — every store call that needs a real
 * folder on disk (#526).
 *
 * A `none` workspace is not a missing path, it is a session that HAS no path:
 * the Main conversation reads and delegates and owns no checkout. So the honest
 * answer to "read this session's files" is a refusal naming the reason, not a
 * `git` command run against `undefined` or against the engine's own cwd — which
 * is what every one of these call sites would have done had the path merely
 * gone optional.
 *
 * `invalid_request` RATHER THAN `not_found`: the session exists and the caller
 * is fine; what was asked of it does not apply to this kind of session.
 */
/**
 * A branch name this engine is willing to put in an argv — issue #670.
 *
 * NOT A VALIDATION OF GIT'S RULES, which are longer than this and are git's to
 * enforce. This is the narrower question: can this string be mistaken for
 * something other than a ref by the program it is handed to. A leading `-`
 * makes it a flag, and the charset has no space, no `$` and no quote, so a value
 * that passes cannot be a second argument or a shell fragment. `gh` is spawned
 * without a shell, so this is belt and braces — and the braces are what keep a
 * text field from becoming a command the day somebody adds one.
 */
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

function workspaceRootOf(session: Pick<Session, "workspace">): string {
  const root = workspacePath(session.workspace);
  if (root === undefined) throw new EngineStateError("invalid_request", "this session has no working directory");
  return root;
}

/**
 * One session record, narrowed to the row a rail draws — see `LiveSessionRow`.
 *
 * SPELLED AS A PICK RATHER THAN A DELETE-LIST, so a field added to `Session`
 * tomorrow does not silently join every polling answer: growing the wire has to
 * be a decision somebody writes down here. Absent keys are left absent rather
 * than set to `undefined`, because `JSON.stringify` drops the one and the point
 * of this function is the bytes.
 */
const liveRow = (session: Session): LiveSessionRow => ({
  id: session.id,
  ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  title: session.title,
  state: session.state,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  driver: session.driver,
  ...(session.model === undefined ? {} : { model: session.model }),
  // Not a rail's field — the `sessions` toolkit's, which lists off this route
  // from the out-of-process worker and names each row's workspace mode.
  envMode: session.envMode,
  // `baseRef` is the commit a checkout was cut from: one review surface's
  // question, and 40 bytes on every row of every poll otherwise.
  workspace:
    session.workspace.mode === "worktree"
      ? { mode: "worktree", path: session.workspace.path, branch: session.workspace.branch }
      : session.workspace.mode === "none"
        ? // A session with no directory says so on the row, rather than sending a
          // path-shaped answer a rail would draw an "open in Finder" button from.
          { mode: "none" }
        : { mode: "local", path: session.workspace.path },
  // ON THE ROW because it is a row's question: the rail is where a person
  // watches a session they just opened, and "the checkout is still being made"
  // is the only thing worth saying about it in those seconds. Absent on every
  // ready session, which is almost all of them — see `SessionPreparation`.
  ...(session.preparation === undefined ? {} : { preparation: session.preparation }),
  ...(session.draft === undefined ? {} : { draft: session.draft }),
  ...(session.usage === undefined ? {} : { usage: session.usage }),
  activity: session.activity,
  ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
  ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
  ...(session.lastTurnFailed === undefined ? {} : { lastTurnFailed: session.lastTurnFailed }),
  ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
  ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
  ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  ...(session.settledOverride === undefined ? {} : { settledOverride: session.settledOverride }),
  ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
  ...(session.settledBy === undefined ? {} : { settledBy: session.settledBy }),
  ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
  ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
  // ON THE WIRE DELIBERATELY, unlike `title`/`branch` on the index row: this is
  // the one field a rail needs in order to draw the thing #490 asked for. A dot
  // that says "this woke while you were away" cannot be derived from the other
  // three — deriving it is what made every cockpit decide it separately.
  ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
  ...(session.startedFrom === undefined ? {} : { startedFrom: session.startedFrom }),
});

/**
 * The same session, narrowed to the scalars the rail DECIDES on — issue #493.
 *
 * The input is a session with its activity already folded (`withActivityFrom`),
 * because `activity` is three documents' worth of question and the whole point
 * of the row is that asking it again costs nothing. See `SessionIndexRow` for
 * the argument about which fields belong here and which stay in the document.
 *
 * SPELLED AS A PICK, like `liveRow` and for the same reason: a field added to
 * `Session` tomorrow does not silently join the index, and one the settling rule
 * starts reading has to be added here deliberately — with a backfill, because
 * every stored row predates it.
 */
const indexRow = (session: Session): SessionIndexRow => ({
  id: session.id,
  ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  state: session.state,
  updatedAt: session.updatedAt,
  createdAt: session.createdAt,
  archived: session.state === "archived",
  draft: session.draft !== undefined,
  ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  ...(session.settledOverride === undefined ? {} : { settledOverride: session.settledOverride }),
  ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
  ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
  ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
  // Half of `dueSnoozeWakes`'s predicate — see `SessionIndexRow.wokeAt`.
  ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
  ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
  ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
  ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
  ...(session.lastTurnFailed === undefined ? {} : { lastTurnFailed: session.lastTurnFailed }),
  activity: session.activity ?? "idle",
  ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
  // The two `find` decides on — see `SessionIndexRow`. A worktree session is the
  // only one whose branch belongs to the conversation rather than to whatever
  // the checkout happens to be on, so it is the only one that carries one here.
  ...(session.title === undefined ? {} : { title: session.title }),
  ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
});

/**
 * IS THIS ROW ON THE SHELF? — the same call `liveSessionRows` makes on a whole
 * `Session`, made on the row instead.
 *
 * ONE FUNCTION, TAKING THE FIELDS BOTH SHAPES HAVE. `SettleableSession` was
 * written to name the fields the rule reads rather than any caller's shape
 * (see its comment), and the index row was chosen to carry exactly those — so
 * this is a call, not a second fold. A row and a record must never disagree
 * here: that is a conversation the engine drops from the list.
 */
function rowIsShelved(row: SessionIndexRow, at: { now: number; autoSettleAfterHours: number | null }): boolean {
  return isShelved({ ...row, archived: row.archived, draft: row.draft }, settlingActivityOf(row), at);
}

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
   * ONLY WHEN PRESENT. A project-less session has no project id to validate,
   * and asserting one unconditionally made it
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

/**
 * THE FOUR FIELDS EVERY READER OF A TURN KEYS ON — the queue's `isRequestRow`.
 *
 * A property test per row rather than a schema walk, and it is what stands
 * between a document written outside this process and an `undefined` surfacing
 * somewhere downstream as a blank rail pill or a turn nothing can claim. It
 * checks identity (`runId`, `sessionId`), order (`sequence`) and the state
 * machine's own alphabet — the four the fold, the window, the claim and the
 * index all read without asking whether they are there.
 *
 * `TurnState` RATHER THAN A LIST WRITTEN OUT HERE, so a tenth state added to
 * the protocol is accepted by this guard the moment it exists. `safeParse` on a
 * z.enum is a set lookup, not a walk of the turn.
 */
function isTurnRow(row: unknown): row is Turn {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<Turn>;
  return typeof candidate.runId === "string" && typeof candidate.sessionId === "string"
    && Number.isSafeInteger(candidate.sequence) && TurnStateSchema.safeParse(candidate.state).success;
}

/**
 * The document, and how much of it is re-checked — issue #547.
 *
 * `trusted` says this came out of the execution store, which is the daemon's
 * own database under the daemon's own lock and is written by `writeQueue`
 * alone — and `writeQueue` now runs `TurnSchema.array()` over every turn before
 * it stores one. Re-running that walk per read re-checks a shape that cannot
 * have changed since, and it was 24.9% of a turn's write path on #547's
 * 400-turn fixture, because the queue is read nineteen times per turn and
 * written four.
 *
 * THE JSON BACKEND IS NOT TRUSTED, and the split is deliberate rather than
 * timid. `queue.json` is an ordinary file: a test rewrites it, an older engine
 * wrote it, a person can open it. It is also the reference implementation the
 * suite runs both ways against, so keeping the full walk there means every
 * behaviour the schema enforces still has a backend that enforces it.
 *
 * THE STRUCTURAL GUARD RUNS ON BOTH, because "trusted" is an argument about
 * which process wrote the bytes, not a promise that the bytes are there. A
 * sqlite document that predates a migration, or one a downgrade wrote, still
 * has to fail as "invalid session queue" rather than downstream.
 */
function parseQueue(value: unknown, sessionId: string, trusted = false): SessionQueue {
  assertStateVersion(value, "session queue");
  const stored = value as { sessionId?: unknown; nextSequence?: unknown; turns?: unknown };
  if (stored.sessionId !== sessionId || !Number.isSafeInteger(stored.nextSequence)) {
    throw new EngineStateError("invalid_request", "invalid session queue");
  }
  let rows: Turn[];
  if (trusted) {
    if (!Array.isArray(stored.turns) || stored.turns.some((row) => !isTurnRow(row))) {
      throw new EngineStateError("invalid_request", "invalid session queue");
    }
    rows = stored.turns as Turn[];
  } else {
    const turns = TurnSchema.array().safeParse(stored.turns);
    if (!turns.success) throw new EngineStateError("invalid_request", "invalid session queue");
    rows = turns.data;
  }
  const ids = new Set<string>();
  for (const turn of rows) {
    assertId(turn.runId, "run id");
    if (ids.has(turn.runId)) throw new EngineStateError("invalid_request", "duplicate Telar turn id");
    ids.add(turn.runId);
  }
  return { version: STATE_VERSION, sessionId, nextSequence: stored.nextSequence as number, turns: rows };
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

/** Where each turn and each item sits in its document — see `document-window.ts`. */
function sessionQueueIndexFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "queue.index.json");
}

function itemsIndexFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "items.index.json");
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

/**
 * THE NOTIFICATION MAILBOX — what arrived while this session was working.
 *
 * PER SESSION, beside its queue, because that is whose context is being spent:
 * a subscription is engine-wide (`subscriptions.json`) but a HELD notification
 * belongs to the recipient, and a session that is archived or deleted should
 * take its unread mail with it rather than leave it in a shared file.
 */
function notificationsFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "notifications.json");
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

/** `[start, end)` of a document file, read at an offset rather than whole —
 *  the file store's half of the windowed read (`document-window.ts`). */
function readFileSlice(file: string, start: number, end: number): Buffer | undefined {
  if (end <= start) return Buffer.alloc(0);
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const span = Buffer.alloc(end - start);
    const read = fs.readSync(handle, span, 0, span.length, start);
    return read === span.length ? span : span.subarray(0, read);
  } finally {
    fs.closeSync(handle);
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

/**
 * IS THIS BATCH NOTHING BUT STREAMED TEXT? — the route selector for
 * `ingestObservations`, read off the RAW input before anything validates it.
 *
 * Only ever a route: both paths validate the whole batch with the same schema
 * and refuse the same things, so the worst a lie here can do is send a malformed
 * batch down the path that rejects it slightly sooner. It reads one property per
 * observation and allocates nothing, because it runs per streamed token-chunk.
 */
function isDeltaOnlyBatch(observations: unknown[]): boolean {
  if (!Array.isArray(observations) || observations.length === 0) return false;
  for (const observation of observations) {
    if ((observation as { kind?: unknown } | null)?.kind !== "content.delta") return false;
  }
  return true;
}

/** WHO IS SENDING A `sessions_send`, PROVEN: the sending turn's own live claim.
 *  The store reads the sender off the claim, never off the caller's word. */
export type SenderProof = { sessionId: string; runId: string; claimToken: string };

/**
 * How to read ONE file's patch — the two questions that change what git prints
 * rather than which file it prints it for.
 *
 * Named rather than inlined at four call sites because the session read, the
 * project read and their two synchronous twins have to agree: a flag one of
 * them accepted and another silently dropped would be a toolbar toggle that
 * worked on a session and did nothing on a canvas.
 */
/**
 * `DiffBaseOption` AND `FilePatchOptions` COME FROM THE CONTRACT, not from
 * here — `protocol/diff-query.ts` owns the shape, its query builder and its
 * parser together, because a fourth hand-written copy of this is precisely
 * what dropped the ignore-whitespace flag in silence. Re-exported so the
 * engine's own callers need not reach past their own module boundary.
 */
export type { DiffBaseOption, FilePatchOptions } from "@telar/engine-client";
import type { DiffBaseOption, FilePatchOptions } from "@telar/engine-client";

/** Absent keeps the recorded base; `null` drops it; a string replaces it. */
function resolveRequestedBase(options: DiffBaseOption, recorded: string | undefined): string | undefined {
  if (options.base === undefined) return recorded;
  return options.base === null ? undefined : options.base;
}

/** One git question, as `EngineStore.prefetchedGit` keys it. */
const prefetchKey = (cwd: string, args: string[]): string => JSON.stringify([cwd, args]);

/** What `resolveWorktreeBase` would pass to `rev-parse` — and only a ref the
 *  store's own validation would let through, so a prefetch never puts an
 *  unvalidated argument on a git command line. */
const prefetchableRef = (ref: string | undefined): string | undefined =>
  ref === undefined ? "HEAD" : /^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(ref) ? ref : undefined;

export class EngineStore {
  private executionStore?: ExecutionStore;
  private commandDepth = 0;
  private afterCommit: Array<() => void> = [];
  private readDocument(file: string): unknown | undefined {
    return this.executionStore?.owns(file) ? this.executionStore.read(file) : readJson(file);
  }
  private writeDocument(file: string, value: unknown, mode?: number): void {
    const owner = this.indexedSessionOf(file);
    this.inRowTransaction(owner, () => {
      if (this.executionStore?.owns(file)) this.executionStore.write(file, value);
      else atomicWrite(file, value, mode);
    });
    // See `sessionsRevision`. After the write, so a revision a reader observes
    // is never newer than the state it would read.
    this.bumpRevisionFor(file, owner);
  }

  /**
   * WHOSE INDEX ROW DOES THIS DOCUMENT DECIDE? — issue #493, and the whole of
   * the "written in the same transaction" rule.
   *
   * Four documents per session feed the row: the metadata itself, and the three
   * the activity fold reads. `items.json` is deliberately not one of them — it
   * is rewritten as an assistant streams, and nothing the rail decides on is
   * derived from it, which is the same carve-out `liveRevision` makes one line
   * above and for the same reason.
   *
   * MATCHED ON THE PATH, not on the caller, because there are sixteen call
   * sites that write `session.json` and adding a seventeenth must not be able to
   * forget this.
   */
  private indexedSessionOf(file: string): { id: string; movesActivity: boolean } | undefined {
    if (!this.executionStore) return undefined;
    const name = path.basename(file);
    if (name !== "session.json" && name !== "queue.json" && name !== "requests.json" && name !== "tasks.json") return undefined;
    const relative = path.relative(this.paths.sessions, path.dirname(file));
    if (!relative || relative.startsWith("..") || !ID.test(relative)) return undefined;
    /**
     * WHICH HALF OF THE ROW THIS WRITE CAN MOVE.
     *
     * `activity`, `activityAt` and the three last-turn fields are a fold over
     * the queue, the open requests and the live tasks — and `storedSession`
     * strips all five from the metadata document precisely because the queue is
     * where they live. So a write to `session.json` ALONE cannot have moved any
     * of them, and the row can be rebuilt by carrying them over from the row
     * already on file.
     *
     * THAT SAVES THE EXPENSIVE READ. Folding the activity costs a whole
     * `queue.json` parse, which on a long conversation is megabytes; commands
     * that only touch the metadata — a read receipt, a rename, a settle, a
     * snooze — are common, and making each of them parse a history they did not
     * change would be a write-path regression paid to recompute an answer that
     * cannot have changed.
     */
    return { id: relative, movesActivity: name !== "session.json" };
  }

  /**
   * Write the document, and make sure its row goes with it.
   *
   * INSIDE A COMMAND, THE ROW IS DEFERRED TO THE END OF IT — see
   * `flushSessionRows`. One command rewrites several of a session's documents
   * (a completed turn moves the queue, the tasks and the metadata), and the row
   * is a fold over all of them; recomputing it after each would be three folds
   * to store the third one's answer. The deferral is still INSIDE the
   * transaction, which is the part that matters.
   *
   * OUTSIDE ONE, THE PAIR IS ITS OWN TRANSACTION. A handful of writes — boot
   * sweeps, the odd direct update — do not run under `executeCommand`, and a row
   * that reached the disk without its document (or the other way round) is a
   * sidebar that disagrees with the conversation behind it.
   */
  private inRowTransaction(owner: { id: string; movesActivity: boolean } | undefined, write: () => void, written?: SessionQueue): void {
    if (owner === undefined || !this.executionStore) return write();
    if (this.commandDepth > 0) {
      write();
      const owed = this.dirtySessionRows.get(owner.id);
      this.dirtySessionRows.set(owner.id, {
        // OR, never overwrite: a command that moved the queue and then the
        // metadata owes the full fold, whichever of the two it wrote last.
        movesActivity: (owed?.movesActivity ?? false) || owner.movesActivity,
        /**
         * AND THE LATEST QUEUE WINS, WHICH IS THE WHOLE RISK HERE (#547).
         *
         * `dirtySessionRows` coalesces every write one command makes to a
         * session, and a queue carried from the FIRST of two queue writes would
         * fold a history the second one has already replaced. So a queue write
         * replaces what is carried and any other write leaves it alone — the
         * metadata, requests and tasks writes that also mark a row dirty cannot
         * have moved the turns, so the queue in hand is still the one on disk.
         */
        queue: written ?? owed?.queue,
      });
      return;
    }
    this.executionStore.atomically(() => {
      write();
      this.storeSessionRow(owner.id, owner.movesActivity, undefined, written);
    });
  }

  /**
   * THE ROWS THIS COMMAND MADE STALE, still owed to the transaction it is in.
   *
   * Emptied by `flushSessionRows` before the commit, and by `executeCommand`'s
   * rollback path — a row owed on behalf of a write that did not happen is a row
   * that would describe a document sqlite no longer has.
   *
   * `queue` IS THE DOCUMENT THE COMMAND JUST WROTE, kept so the fold at the end
   * of it does not fetch and re-parse what is already in memory — see
   * `storeSessionRow`. Absent when nothing in this command wrote the queue.
   */
  private dirtySessionRows = new Map<string, { movesActivity: boolean; queue?: SessionQueue }>();

  /** Fold one session's four documents into its row and store it. The read is
   *  the same one the live fold used to make per session per poll; it is made
   *  here instead, once per command that could have moved the answer.
   *
   *  `written` is the queue this command already wrote, when it wrote one — see
   *  `dirtySessionRows`. */
  private storeSessionRow(sessionId: string, movesActivity = true, at = this.settlingClock(), written?: SessionQueue): void {
    if (!this.executionStore) return;
    const stored = this.readDocument(sessionMetadataFile(this.paths, sessionId));
    const before = this.executionStore.sessionRow(sessionId);
    // The metadata is gone: the session was deleted inside this command, and
    // `deleteSession` has already taken the row with it. A row that leaves is a
    // change of membership, so every reader is told.
    if (stored === undefined) {
      this.executionStore.deleteSessionRow(sessionId);
      if (before) this.listRevision = this.nextRevision();
      return;
    }
    let record: Session;
    try {
      record = parseSession(stored);
    } catch {
      // Unreadable is SKIPPED, not thrown, exactly as in the fold this feeds:
      // one corrupt directory must not fail every command that touches it.
      return;
    }
    /**
     * THE QUEUE IS ONLY READ WHEN THIS WRITE COULD HAVE MOVED IT — see
     * `indexedSessionOf`. Carrying the five folded fields over from the row on
     * file is not a cache: they are a function of three documents this command
     * did not touch, so the stored answer IS the current answer.
     *
     * Without a row on file there is nothing to carry, so the fold runs — which
     * is what the backfill and a session's first write both take.
     *
     * AND WHEN THE QUEUE IS THE THING THAT MOVED, IT IS ALREADY IN HAND (#547).
     * `writeQueue` holds the parsed document it has just serialised, and this
     * fold used to fetch it back out of sqlite and re-parse it — a second whole
     * parse of a megabyte the same command wrote, measured at 19 whole-queue
     * parses per turn on a 400-turn fixture. `writeQueue` carries it through
     * `dirtySessionRows` instead; the fall back to the read stays for the
     * commands that moved `requests.json` or `tasks.json` and never touched the
     * turns, and for the backfill, which has no write to carry anything from.
     *
     * THE ONE THING THIS TRUSTS is that a command does not edit its queue after
     * writing it and then not write again — which would already be a lost
     * write, on disk, before this line could be wrong about it.
     */
    const folded = movesActivity || before === undefined
      ? this.withActivityFrom(record, (written ?? this.readQueue(sessionId)).turns)
      : {
          ...record,
          activity: before.activity,
          ...(before.activityAt === undefined ? {} : { activityAt: before.activityAt }),
          ...(before.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: before.lastTurnEndedAt }),
          ...(before.lastTurnFailed === undefined ? {} : { lastTurnFailed: before.lastTurnFailed }),
          ...(before.lastTurnSequence === undefined ? {} : { lastTurnSequence: before.lastTurnSequence }),
        };
    const row = indexRow(folded);
    this.executionStore.writeSessionRow(row);
    this.noteSessionRevision(before, row, at);
  }

  /** The clock and the window every shelving question in one pass is asked
   *  against — the STORE'S clock, never a wall clock; see `liveSessionRows`. */
  private settlingClock(): { now: number; autoSettleAfterHours: number | null } {
    return { now: this.now(), autoSettleAfterHours: this.getInboxPolicy().autoSettleAfterHours };
  }

  /** Store every row this command owes, inside the command's own transaction.
   *  ONE CLOCK AND ONE POLICY READ FOR THE WHOLE FLUSH: the rows are being
   *  compared against each other's `before`, and a window that moved between
   *  two of them would attribute a write to the wrong counter. */
  private flushSessionRows(): void {
    if (this.dirtySessionRows.size === 0) return;
    const owed = [...this.dirtySessionRows];
    this.dirtySessionRows.clear();
    const at = this.settlingClock();
    for (const [sessionId, row] of owed) this.storeSessionRow(sessionId, row.movesActivity, at, row.queue);
  }

  /**
   * A NUMBER THAT CHANGES WHEN THE LIVE LIST WOULD — issue #459.
   *
   * The rail cannot be pushed to. There is no global event feed on this engine
   * (journals are per session, and their ids are per session too), no SSE and no
   * socket — and #82/#450 decided against adding the cockpit's FIRST long-lived
   * connection, because six is all a browser has per origin. So the rail still
   * asks on a timer, and the only thing left to fix is what the ask COSTS.
   *
   * This is that: a conditional read. `GET /v2/sessions/live?since=<revision>`
   * answers `{ revision, unchanged: true }` — about sixty bytes and no fold at
   * all — when nothing has been written since. On the owner's store that turns
   * an idle cockpit's tick from 318 KB and a fold over 267 sessions' queues,
   * requests and tasks into one integer comparison, several times a second,
   * forever. An ETag by another name, spelled in the body because two proxy hops
   * sit between this and a browser and neither forwards conditional headers.
   *
   * IN MEMORY, AND SEEDED FROM THE CLOCK. One writer, in this process, the same
   * ground `queueCache` stands on. A restart starts from a new, larger number,
   * so a client holding a cursor from the last daemon is told "changed" rather
   * than being handed a false "unchanged" — the one failure mode that would show
   * as a frozen rail.
   *
   * ══ AND IT IS THREE NUMBERS NOW, NOT ONE — issue #493 ══
   *
   * It used to be bumped by EVERY document write but `items.json`, on the
   * argument that over-bumping costs a re-read nobody needed. On the owner's
   * machine that turned out to cost rather more than that: an OAuth poll, a
   * usage-limit refresh, a provider secret, an attachment index — none of which
   * appear anywhere in this answer — each made every connected rail re-read all
   * 291 sessions. The audit caught the #462 cursor hitting once in five attempts
   * while the owner worked.
   *
   * So the bump is now per SESSION, and the number a reader is given is the
   * newest one among the things that reader's answer is actually made of:
   *
   *   - `listRevision` — the three documents the answer reads beside the rows
   *     (the project registry, the sidebar arrangement, the settling policy),
   *     AND every change of MEMBERSHIP: a session created, deleted, archived, or
   *     crossing between the list and the shelf. `settledCount` moves with this.
   *   - `unshelvedRevision` — a write to a session that is on the list.
   *   - `shelvedRevision` — a write to a session that is on the shelf. It is in
   *     the `?all=1` answer and not in the default one, which is the whole point
   *     of keeping it apart.
   *
   * WHY THREE COUNTERS AND NOT A MAP KEYED BY SESSION. The conditional read has
   * to answer BEFORE the fold — that is what makes it cheap — so the revision
   * must be available without reading anything. Three numbers maintained at
   * write time are O(1) to serve; a max over a map would be O(sessions) on every
   * idle tick, several times a second, forever.
   *
   * WHAT THIS STILL DOES NOT CATCH, unchanged from before: a row that crosses
   * onto the shelf because TIME PASSED and nothing was written. No counter can
   * move on an event that does not happen. A rail polls anyway, and the next
   * write anywhere in the answer corrects it.
   */
  private revisionClock = Date.now();
  private listRevision = this.revisionClock;
  private unshelvedRevision = this.revisionClock;
  private shelvedRevision = this.revisionClock;
  private nextRevision(): number {
    this.revisionClock += 1;
    return this.revisionClock;
  }

  /**
   * The cursor for one shape of the answer — see the counters above.
   *
   * `all` IS PART OF THE QUESTION. The wide answer carries the shelved rows, so
   * a write to one of them changes it; the default answer does not carry them,
   * so the same write changes nothing a rail would draw. Handing both readers
   * one number would mean either lying to the shelf or re-reading the list.
   */
  sessionsRevision(options: { all?: boolean } = {}): number {
    const base = Math.max(this.listRevision, this.unshelvedRevision);
    return options.all === true ? Math.max(base, this.shelvedRevision) : base;
  }

  /**
   * MOVE THE COUNTER THIS WRITE BELONGS TO, and only that one.
   *
   * A document that is neither a session's nor one of the three the answer
   * reads moves NOTHING. That is the narrowing this exists for, and it is the
   * one direction that can be wrong — an answer built from a document not on
   * this list would go stale silently — so the list is spelled out here beside
   * the reader that consumes it rather than inferred from a path shape.
   *
   * A SESSION'S WRITE IS ATTRIBUTED BY ITS ROW, in `noteSessionRevision`: which
   * of the two session counters moves depends on which list the session is on,
   * which is not known until the row has been folded.
   */
  private bumpRevisionFor(file: string, owner: { id: string } | undefined): void {
    if (owner !== undefined) return;
    /**
     * NO INDEX, NO NARROWING. A store on the JSON backend has no `sessions`
     * table, so no write can be attributed to a session and the allowlist below
     * would silently stop the rail: every conversation's documents would move
     * nothing. That store keeps the behaviour it has always had — bump on every
     * write but the hot one — which is the safe direction and the one the
     * narrowing above is measured against.
     */
    if (!this.executionStore) {
      if (path.basename(file) !== "items.json") this.listRevision = this.nextRevision();
      return;
    }
    if (file === this.paths.projects || file === this.paths.sidebarLayout || file === this.paths.inbox) {
      this.listRevision = this.nextRevision();
    }
  }

  /**
   * Attribute one session's write, now that its row says which list it is on.
   *
   * MEMBERSHIP OUTRANKS CONTENT. A session that crossed between the list and the
   * shelf — or was created, or archived — changes WHICH rows the default answer
   * holds and the `settledCount` beside them, so it moves `listRevision` and
   * every reader is told. A session that merely changed while staying where it
   * was moves its own side's counter, and the reader who cannot see it is not
   * woken for it.
   */
  private noteSessionRevision(before: SessionIndexRow | undefined, after: SessionIndexRow, at: { now: number; autoSettleAfterHours: number | null }): void {
    const shelved = after.state !== "active" || rowIsShelved(after, at);
    const wasShelved = before === undefined ? undefined : before.state !== "active" || rowIsShelved(before, at);
    if (before === undefined || wasShelved !== shelved) {
      this.listRevision = this.nextRevision();
      return;
    }
    if (shelved) this.shelvedRevision = this.nextRevision();
    else this.unshelvedRevision = this.nextRevision();
  }

  /**
   * WHAT THE EXECUTION STORE SWEPT WHEN IT OPENED — issue #457, step 4.
   *
   * Command receipts past their retention, and the JSON the sqlite import
   * replaced once sqlite has owned the store a week. Surfaced so the daemon can
   * SAY it: both sweeps delete things nothing can reach, so without a line in
   * the log the only evidence a person has that a quarter of a gigabyte went
   * away is that it is gone. Absent on a store that never migrated.
   */
  executionHousekeeping(): ExecutionHousekeeping | undefined {
    return this.executionStore?.housekeeping;
  }

  /**
   * COMPACT THE JOURNAL AND GIVE THE PAGES BACK — issue #646, and only on ask.
   *
   * The sweep runs itself; the VACUUM behind this does not, because it rewrites
   * the database under an exclusive lock (7 s on the owner's gigabyte) to
   * return space that accrues over a month. See `ExecutionStore.reclaim`.
   *
   * Absent on a store still running on JSON: there is no database to vacuum,
   * and saying so is better than reporting a reclamation that did not happen.
   */
  reclaimExecutionStore(): { before: number; after: number; deltas: number; starts: number; sessions: number; usage: number } | undefined {
    return this.executionStore?.reclaim();
  }

  /**
   * WHAT A READ ACTUALLY TOUCHED, so a test can hold the engine to it (#419).
   *
   * `documentBytes` is the span of `queue.json` / `items.json` that reached
   * `JSON.parse` — the whole document on the fallback path, the window's own
   * rows on the indexed one. Public because that difference is the fix, and a
   * claim that a 120-turn session now costs its tail is only worth making if
   * something can fail when it stops being true.
   *
   * AND IT NOW SEES `readQueue`, WHICH IT DID NOT — issue #547. `accountWholeRead`
   * was called from the two windowed reads alone, so every whole-queue read the
   * activity fold and the thirteen transitions make counted nothing: the
   * counters read 0 before and 0 after a change that doubled the wall time, and
   * anyone proving a fold improvement with them would have read 0 = 0 as
   * success. The accounting lives in `readQueue` itself now, so all forty-odd
   * call sites are covered by construction rather than by remembering.
   *
   * `queueParses` COUNTS WHOLE-DOCUMENT QUEUE PARSES, which is the number #547
   * is about rather than the bytes — the parse this issue removed is one of
   * several a transition makes, and it is invisible in a byte total that a
   * cache hit also moves. The counts themselves live in
   * `test/queue-write-path.test.ts`, where they are a ratchet: fifteen per turn
   * survive this issue, and #547 is the argument that fifteen is too many.
   *
   * `itemParses` IS THE SAME NUMBER FOR `items.json` — issue #658, and the same
   * argument one document over. The write path read the whole projection once
   * per batch and that read was counted nowhere, so the instrument reported the
   * same total for an engine that rebuilt the projection per item event as for
   * one that read it once. Bytes alone cannot say it either: they move when a
   * WINDOW reads a span, and the thing under test is whole-document parses.
   */
  readonly readAccounting = { documentBytes: 0, documentReads: 0, queueParses: 0, itemParses: 0 };

  /**
   * Write a document and the offset index that lets its tail be read alone.
   *
   * ONE SERIALISATION, SHARED. The index is byte ranges into the exact text
   * stored, so the text has to be built here rather than inside each backend:
   * the JSON store pretty-prints and SQLite does not, and an index measured
   * against the wrong one of those would point into the middle of a row.
   *
   * An unindexable document simply loses its index — the read falls back to
   * parsing the whole thing, which is what every document written before this
   * existed already does.
   */
  private writeIndexedDocument(file: string, indexFile: string, value: unknown, property: string, rows: Array<{ key: string; tag?: string }>, written?: SessionQueue): void {
    const sqlite = this.executionStore?.owns(file);
    const text = sqlite ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
    // The queue is one of the four the row folds over, so it takes the same
    // route `writeDocument` does — document and row, one transaction. `written`
    // is that queue when this IS the queue write, so the row's fold can use it
    // rather than read it back (#547); the item projection passes nothing.
    this.inRowTransaction(this.indexedSessionOf(file), () => {
      if (sqlite) this.executionStore!.writeText(file, text);
      else atomicWriteText(file, text);
    }, written);
    const bytes = Buffer.from(text, "utf8");
    const ranges = arrayElementRanges(bytes, property);
    const index: DocumentIndex = ranges && ranges.length === rows.length
      ? { version: STATE_VERSION, length: bytes.length, rows: coalesceByKey(rows, ranges) }
      // An absent index reads as a stale one — both mean "parse it whole" — so
      // a document that could not be indexed writes the unmatchable marker
      // rather than leaving the PREVIOUS document's index in place to be
      // trusted. No document has a negative length.
      : { version: STATE_VERSION, length: -1, rows: [] };
    // COMPACT WHATEVER THE BACKEND DOES. This is read on the way to every
    // windowed snapshot, so it is on the path it exists to shorten; indenting
    // it would roughly triple the only document a tail read still parses whole.
    if (this.executionStore?.owns(indexFile)) this.executionStore.write(indexFile, index);
    else atomicWriteText(indexFile, `${JSON.stringify(index)}\n`);
  }

  /** The index beside `file`, or `undefined` when there is none that still
   *  describes it. See `DocumentIndex.length` for why that is a size check. */
  private documentIndex(file: string, indexFile: string): DocumentIndex | undefined {
    const stored = this.readDocument(indexFile) as DocumentIndex | undefined;
    // Counted against the read, because it IS the read's cost: the index is the
    // one document a windowed snapshot still parses whole, and a measurement
    // that left it out would flatter the thing it is measuring.
    this.readAccounting.documentBytes += this.documentBytes(indexFile) ?? 0;
    if (!stored || stored.version !== STATE_VERSION || !Array.isArray(stored.rows)) return undefined;
    return this.documentBytes(file) === stored.length ? stored : undefined;
  }

  private documentBytes(file: string): number | undefined {
    if (this.executionStore?.owns(file)) return this.executionStore.byteLength(file);
    try {
      return fs.statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * The rows `wanted` names, parsed from one span of the document.
   *
   * ONE READ, NOT ONE PER ROW. The window is a tail, so its rows are adjacent
   * in the document and the span between the first and the last is mostly the
   * answer; anything else caught inside it — an older settled turn sitting
   * between an unsettled one and the tail — is dropped by the caller's filter.
   * A row-at-a-time read would be a query per turn to save bytes that are
   * already in the page sqlite had to fetch.
   */
  private readIndexedRows(file: string, wanted: DocumentIndex["rows"]): unknown[] {
    if (wanted.length === 0) return [];
    const from = Math.min(...wanted.map((row) => row.start));
    const to = Math.max(...wanted.map((row) => row.end));
    const span = this.executionStore?.owns(file) ? this.executionStore.slice(file, from, to) : readFileSlice(file, from, to);
    if (!span || span.length !== to - from) throw new EngineStateError("invalid_request", "document index does not describe this document");
    this.readAccounting.documentBytes += span.length;
    this.readAccounting.documentReads += 1;
    return parseSpan(span);
  }

  /** What a whole-document read of `file` cost, for the accounting above. */
  private accountWholeRead(file: string): void {
    this.readAccounting.documentBytes += this.documentBytes(file) ?? 0;
    this.readAccounting.documentReads += 1;
  }

  closeExecutionStore(): void { this.executionStore?.close(); }
  executeCommand<T>(command: string, action: () => T, commandId?: string): T {
    if (!this.executionStore) return action();
    this.commandDepth += 1;
    let result: T;
    try {
      result = this.executionStore.transaction(command, () => {
        const value = action();
        /**
         * THE INDEX ROWS, INSIDE THE TRANSACTION THAT EARNED THEM — issue #493.
         *
         * At the END of the outermost command rather than after each document,
         * because the row is a fold over four of them and one command commonly
         * moves three; and INSIDE it rather than in `afterCommit`, because a row
         * that commits separately from its document is a rail that can disagree
         * with the conversation behind it. A command that throws never gets
         * here, and its owed rows are dropped below with everything else the
         * rollback took.
         */
        if (this.commandDepth === 1) this.flushSessionRows();
        return value;
      }, commandId);
    }
    catch (error) {
      this.journalHead.clear(); this.openPrefixes.clear(); this.liveQueueIndex = undefined;
      // And the liveness ledger (#813): its stamps came from appends inside the
      // transaction sqlite has just thrown away, so they name records that do
      // not exist. Dropped rather than repaired — `lastProgressOf` falls back
      // to the turn's own durable stamp, which is exactly what a restart uses.
      this.runProgress.clear();
      // Same argument for the open-request index (#545): rows it names were
      // written inside the transaction sqlite has just thrown away. Dropped
      // rather than repaired — the next reader rebuilds it from the documents.
      this.liveRequestIndex = undefined;
      // Rolled back under this store's feet: anything read or written inside
      // the transaction describes a queue sqlite no longer has.
      this.queueCache.clear(); this.itemsCache.clear(); this.queueChangeAnnounced = false;
      this.pendingStopTasks.clear(); this.afterCommit = [];
      this.dirtySessionRows.clear();
      // Same argument, for the projection's memo: it records which turn rows
      // this process has folded, and a rollback took some of those rows with it.
      // Emptying it costs one SELECT on the next write and cannot be wrong.
      this.foldedTurnStates.clear();
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
  /** The injected SYNCHRONOUS runner. Reached only through `git` below. */
  private readonly syncGit: GitRunner;
  /**
   * ANSWERS ALREADY READ OFF THE POOL, for the one synchronous call in flight.
   *
   * `createSession` and a draft's promotion in `submitTurn` stay synchronous —
   * they are sqlite commands, and a command cannot span an await — but the few
   * `rev-parse`s they ask are refusals the caller must hear, so they cannot move
   * behind the response either. `withPrefetchedGit` reads them through the pool
   * FIRST and sets this for exactly the synchronous call that follows; only a
   * question nobody prefetched falls through to the blocking runner.
   */
  private prefetchedGit: Map<string, GitResult> | undefined;
  private readonly git: GitRunner = (cwd, args, options) =>
    this.prefetchedGit?.get(prefetchKey(cwd, args)) ?? this.syncGit(cwd, args, options);
  private readonly asyncGit: AsyncGitRunner;
  /** The cuts and removals, on a pool the rail's polls do not share — see
   *  `defaultWorktreeGitRunner`. The same runner when a caller injected one. */
  private readonly worktreeGit: AsyncGitRunner;
  /**
   * One worktree mutation at a time per project — the ordering the synchronous
   * runner used to buy by blocking the daemon (#496). In memory, like
   * `liveRevision`: one writer, in this process, and a restart has nothing in
   * flight to order.
   */
  private readonly worktreeQueue: WorktreeQueue = createWorktreeQueue();
  /**
   * HOW THIS STORE ASKS THE MACHINE ABOUT DISKS — see `volumes.ts`.
   *
   * INJECTED BY TESTS ONLY, and the seam this whole feature is testable on: a
   * fake mount is a temp directory with a stable uuid, so unplug, remount at a
   * new path and the recreated-empty-mountpoint case are unit tests rather than
   * a drawer of USB sticks.
   */
  private readonly volumes: VolumeDeps;
  private readonly gh: GhRunner;
  /** What a provider process would inherit from this engine — read to say what
   *  a newly-configured login is about to stop inheriting (#594). */
  private readonly ambientEnv: Record<string, string | undefined>;
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
  /**
   * WHEN THIS SESSION'S RUNNING TURN LAST PRODUCED EVIDENCE — issue #813.
   *
   * ═══ WHY THIS EXISTS AND WHY IT IS NOT THE HEARTBEAT ═══
   *
   * Nothing in this engine could tell a wedged turn from a working one. Both
   * attempts to judge one by hand got it wrong, in opposite directions: a
   * session whose cut had died read `working` for 45 minutes, and a healthy
   * 80-minute turn was read as stalled and stopped 837 ms after a successful
   * `git push`. The second mistake is the instructive one — it was made by
   * reading `updatedAt`, and `updatedAt` cannot support it: `touchSession` is
   * its only writer and the streaming path never calls it, so a healthy turn
   * of any length has an `updatedAt` frozen at its first second, by design.
   *
   * THE HEARTBEAT CANNOT BE THE EVIDENCE EITHER, and `worker.ts` says why in
   * its own words: the heartbeat must keep running while a turn is BLOCKED, so
   * it is a `setInterval` deliberately decoupled from turn progress. A wedged
   * turn on a live worker heartbeats forever. And `pruneWorkers` exempts the
   * embedded registration — which is what runs almost every session here.
   *
   * SO THE EVIDENCE IS THE JOURNAL, which the engine writes ITSELF as a side
   * effect of the worker doing work, and which no worker can claim on its own
   * behalf. `appendEvent` stamps this on every record that names a run.
   *
   * KEYED BY SESSION, NOT BY RUN, and that is what bounds it: one turn per
   * session is the engine's own invariant, so one entry per session is exact —
   * and the entry carries its `runId` so a stamp left by an earlier run can
   * never be read as this one's. Bounded exactly as `journalHead` above is, by
   * the number of sessions this process has touched rather than by their age.
   *
   * IN MEMORY, AND THE DURABLE COPY IS `Turn.lastProgressAt`. Writing the queue
   * on every journal append would be a full atomic queue write per streamed
   * token-chunk; `sweepStalledTurns` folds this into the turn at most once a
   * minute instead. A restart loses at most that minute, and `recover()`
   * already decides what happens to a turn that was running when the process
   * went away.
   */
  private readonly runProgress = new Map<string, { runId: string; at: number }>();
  /** Everyone listening to `appendEvent` — see `watch`. Empty on a daemon
   *  nobody is streaming from, which is what makes `publish` free there. */
  private readonly watchers = new Set<(event: EngineEvent) => void>();
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
      cwd: workspaceRootOf(session),
      python: resolved.pythonPath,
      telarVenv: telarVenvDir(this.paths.root, session.projectId!, session.workspace.mode === "worktree" ? path.basename(session.workspace.path) : undefined),
      host: this.kernels,
      files: new DsFiles(path.join(sessionDir(this.paths, sessionId), "ds")),
      // A notebook with plots in it passes the editor's 512 KB ceiling in one
      // cell; both fences take the notebook-sized cap instead.
      readFile: (target) => this.readFenced(workspaceRootOf(session), target, "session workspace", NOTEBOOK_MAX_BYTES),
      writeFile: (target, text, expected) => this.writeFenced(workspaceRootOf(session), target, text, expected, "session workspace", NOTEBOOK_MAX_BYTES),
      putAttachment: (input) => this.putAttachment(sessionId, input),
      attachmentBytes: (id) => this.attachmentBytes(sessionId, id).data,
      appendEvent: (event) => { this.appendEvent(sessionId, event); },
      now: () => this.now(),
      // Package operations resolve the environment against THIS session's
      // workspace — the worktree rule again — and run as the store's jobs.
      packages: () => this.dataSciencePackages(session.projectId!, workspaceRootOf(session)),
      startInstall: (input) => this.dataScienceInstall(session.projectId!, input as Parameters<EngineStore["dataScienceInstall"]>[1], workspaceRootOf(session)),
      waitJob: (jobId, timeoutMs) => this.dsJobs.wait(jobId, timeoutMs),
      environments: async () => ({ environments: await this.dsEnvironmentRows(session.projectId!, workspaceRootOf(session)) }),
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
    const pythonPath = resolvePythonPath(workspaceRootOf(session), chosen);
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
      cwd: workspaceRootOf(session),
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
      this.requireSession(sessionId);
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
      const code = `import pandas as _pd, json as _j\n_df = _pd.read_parquet(${JSON.stringify(path.resolve(workspaceRootOf(session), target))})${sort}\n_w = _df.iloc[${options.offset}:${options.offset + options.limit}]\nprint("__TELAR_TABLE__" + _j.dumps({"columns": list(map(str, _df.columns)), "dtypes": [str(_df.dtypes[c]) for c in _df.columns], "total": int(len(_df)), "rows": _j.loads(_w.to_json(orient="values", date_format="iso"))}, default=str))`;
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
    this.requireSession(sessionId);
    const all = [...this.readAttachments(sessionId).values()];
    const filtered = options.tag ? all.filter((a) => a.tags?.includes(options.tag!)) : all;
    return structuredClone(filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
  }

  attachmentBytes(sessionId: string, attachmentId: string): { attachment: TurnAttachment; data: Uint8Array } {
    this.requireSession(sessionId);
    const attachment = this.readAttachments(sessionId).get(attachmentId);
    if (!attachment) throw new EngineStateError("not_found", "attachment does not exist");
    return { attachment: structuredClone(attachment), data: new Uint8Array(fs.readFileSync(attachment.path)) };
  }

  /** Replace an attachment's tags — how a plot is pinned and unpinned. */
  tagAttachment(sessionId: string, attachmentId: string, tags: string[]): TurnAttachment {
    this.requireSession(sessionId);
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
    this.requireSession(sessionId);
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
   * A SAFE COPY OF THIS STORE — issue #665, and the thing whose absence made
   * "do not touch the live store" a rule with no alternative behind it.
   *
   * Every question of the form "what is actually in there" used to become
   * either a hand-run query against the one irreplaceable artifact or an
   * estimate. #646's figures had to be corrected twice for exactly that reason.
   * This is the sanctioned answer: a store a person — or an agent — can open,
   * grep, query and throw away.
   *
   * ══ WHAT IT CARRIES, AND WHAT IT DELIBERATELY DOES NOT ══
   *
   * Tier 1 and tier 1′ (see `docs/storage-shape.md`): the database, through
   * `VACUUM INTO` so it is consistent rather than a `cp` of pages from
   * different moments, and every other file and directory at the store root.
   *
   * NOT THE REPRODUCIBLE TIER. `worktrees/`, `python/` and `tools/` are
   * re-makeable from a recorded sha or a re-install, and on this machine the
   * first of them is 59 checkouts and tens of gigabytes — a "safe copy" that
   * took minutes and filled a disk would be a button nobody presses. Named
   * here rather than guessed at by size.
   *
   * NOT `engine.lock` EITHER, which names a live daemon on a live host: copying
   * it would hand a second engine a lock record that looks like a crash.
   *
   * AND NOT THE `-wal`/`-shm`. `VACUUM INTO` produces a self-contained
   * database; carrying the log beside it would be carrying a log that describes
   * a different file.
   *
   * THE DESTINATION MUST NOT EXIST. The one operation here that could destroy
   * something is writing over a directory somebody named by mistake, and a
   * refusal costs them one retry.
   */
  copyStoreTo(destination: string): { root: string; files: number; bytes: number } {
    if (!path.isAbsolute(destination)) throw new EngineStateError("invalid_request", "a copy destination must be an absolute path");
    if (fs.existsSync(destination)) throw new EngineStateError("invalid_request", "that folder already exists — choose one Telar can create");
    if (!this.executionStore) throw new EngineStateError("invalid_request", "this engine is not running on SQLite, so there is nothing to copy");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    this.executionStore.vacuumInto(path.join(destination, "execution.sqlite"));
    let files = 1;
    let bytes = fs.statSync(path.join(destination, "execution.sqlite")).size;
    /** Reproducible (tier 3), the live daemon's lock, and the database's own
     *  files — each skipped for the reason the header gives. */
    const skip = new Set(["worktrees", "python", "tools", "engine.lock", "execution.sqlite", "execution.sqlite-wal", "execution.sqlite-shm"]);
    for (const entry of fs.readdirSync(this.paths.root, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const from = path.join(this.paths.root, entry.name);
      const to = path.join(destination, entry.name);
      try {
        fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, dereference: false });
      } catch {
        // ONE UNREADABLE SUBTREE IS NOT A FAILED COPY. A permission, a socket,
        // a file that vanished under the walk: the copy is worth having
        // without it, and refusing the whole thing would put somebody back on
        // the live store, which is what this exists to keep them off.
        continue;
      }
      for (const measured of walkFiles(to)) { files += 1; bytes += measured; }
    }
    return { root: destination, files, bytes };
  }

  /**
   * HOW LONG THE RAW TURN JOURNAL IS KEPT — issues #542, #646.
   *
   * Same never-throws rule as `getInboxPolicy`, and here it is the difference
   * between a preference and a deletion: a document somebody hand-edited into
   * nonsense must fall back to the shipped default, and the shipped default is
   * `never`. There is no reading of a broken file that starts removing history.
   */
  getRetentionPolicy(): RetentionPolicy {
    try {
      const parsed = RetentionPolicySchema.safeParse(this.readDocument(this.paths.retention));
      return parsed.success ? parsed.data : { ...DEFAULT_RETENTION_POLICY };
    } catch {
      return { ...DEFAULT_RETENTION_POLICY };
    }
  }

  /**
   * TAKES `unknown` AND VALIDATES HERE, like `setInboxPolicy`: the bound belongs
   * next to the schema that states it, not spelled again in whatever route
   * happens to be the way in today.
   *
   * A WINDOW WITHOUT A DESTINATION IS REFUSED, rather than accepted and then
   * quietly never swept. Export before delete is the approved design; a setting
   * that looked enabled and did nothing would be the worst version of it.
   */
  setRetentionPolicy(patch: { idleAfterDays?: unknown; exportTo?: unknown }): RetentionPolicy {
    const next: RetentionPolicy = { ...this.getRetentionPolicy() };
    if (patch.idleAfterDays !== undefined) {
      if (patch.idleAfterDays === null) next.idleAfterDays = null;
      else {
        const parsed = RetentionPolicySchema.shape.idleAfterDays.safeParse(patch.idleAfterDays);
        if (!parsed.success)
          throw new EngineStateError(
            "invalid_request",
            `a retention window must be a whole number of days between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, or null`,
          );
        next.idleAfterDays = parsed.data;
      }
    }
    if (patch.exportTo !== undefined) {
      if (patch.exportTo === null) next.exportTo = null;
      else {
        if (typeof patch.exportTo !== "string" || !patch.exportTo.trim() || !path.isAbsolute(patch.exportTo.trim()))
          throw new EngineStateError("invalid_request", "an export destination must be an absolute path");
        next.exportTo = patch.exportTo.trim();
      }
    }
    if (next.idleAfterDays !== null && !next.exportTo)
      throw new EngineStateError("invalid_request", "choose where the journal is exported before setting a retention window");
    this.writeDocument(this.paths.retention, { version: STATE_VERSION, ...next });
    return { ...next };
  }

  /**
   * WHAT EACH WINDOW WOULD TAKE, ON THIS STORE — issue #542, step 1.
   *
   * THE NUMBERS ARE THE PERSON'S OWN, which is the entire point: a fixed
   * default window is what destroys the store whose oldest session is a week
   * old, and "1 session, 340 events, 2.1 MiB" in front of them is the defence
   * no cleverer default provides.
   *
   * `bytes` IS AN EXPLICIT ASK. Counts are index ranges; the byte sum reads the
   * rows. Never put either on a timer (#629).
   */
  retentionPreview(options: { bytes?: boolean } = {}): RetentionBucket[] {
    const store = this.executionStore;
    if (!store) return [];
    const now = this.now();
    return RETENTION_BUCKET_DAYS.map((days) => ({
      days,
      ...store.retentionPreview({ idleBefore: now - days * 24 * 60 * 60 * 1000, now }, options),
    }));
  }

  /**
   * RUN THE SWEEP THE POLICY ASKS FOR — the timer's call and the button's.
   *
   * NOTHING HAPPENS WITHOUT BOTH HALVES. No window, or no export destination,
   * and this returns zeroes without reading a session: on a fresh install that
   * is one document read that finds nothing, which is the cost of shipping this
   * to somebody who will never use it.
   *
   * IT RETURNS COUNTS AND WRITES NO LOG LINE. See `retireSession` — a retired
   * session and a skipped one are indistinguishable in a log and distinct in
   * these three numbers.
   */
  sweepRetention(): JournalRetirement {
    const store = this.executionStore;
    const policy = this.getRetentionPolicy();
    if (!store || policy.idleAfterDays === null || !policy.exportTo) return { retired: 0, skipped: 0, events: 0 };
    const now = this.now();
    return store.retireJournal(
      { idleBefore: now - policy.idleAfterDays * 24 * 60 * 60 * 1000, now },
      { exportTo: policy.exportTo },
    );
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

  /* ---------------------------------------------------------------- *
   * THE DICTATION KEY — issue #544.
   *
   * A 0600, write-only key in its own directory. See
   * `dictation/credentials.ts`.
   * ---------------------------------------------------------------- */

  /** `<engineRoot>/dictation` — the key lives in it, and nothing else does
   *  yet. */
  private get dictationDir(): string {
    return path.join(this.paths.root, "dictation");
  }

  /** WHETHER THERE IS A KEY, which is the whole of what a client may know. No
   *  source ladder here: there is exactly one rung, so "configured" says it
   *  all. */
  dictationCredential(): { configured: boolean } {
    return dictationCredential(this.dictationDir);
  }

  /**
   * WHO TRANSCRIBES ON THIS MAC, AND WHETHER IT COULD — the whole of what any
   * client is told about dictation.
   *
   * `configured` IS ANSWERED EVEN WHEN THE PROVIDER IS OFF, on purpose: a key
   * pasted before dictation was switched off is still there, and a pane that
   * claimed otherwise would have somebody paste it a second time. Switching a
   * provider off does not throw a credential away.
   */
  dictationState(): {
    provider: DictationProviderId;
    configured: boolean;
    language: string;
    languages: readonly DictationLanguage[];
    vocabulary: string[];
    keyterms?: KeytermFit;
  } {
    // `languages` RIDES THE SAME ANSWER rather than getting a route of its own
    // (#560). It is the vocabulary the `language` beside it is written in, and
    // a client that had to fetch the two separately could draw a picker with
    // nothing in it, or with the stored code missing from the list. One
    // document, one moment.
    //
    // AND SO DOES WHAT THE LAST MINT ACTUALLY SENT (#712), for a different
    // reason: it is not a setting, it is what HAPPENED to the setting. The
    // provider may shorten the glossary to fit its own budget, and the pane
    // that holds the vocabulary box is the one place a person would go about
    // it. NOT STORED — see `lastKeytermFit`: it describes this engine's current
    // glossary, and a value that outlived a restart would be a claim about a
    // list nobody has checked.
    const fit = lastKeytermFit();
    return {
      ...readDictationSettings(this.dictationDir),
      ...this.dictationCredential(),
      languages: dictationLanguages(),
      ...(fit ? { keyterms: fit } : {}),
    };
  }

  /** Choose a provider, or switch dictation off. The only writer, so `off` is
   *  a value somebody chose rather than a state derived from an empty key. */
  setDictationProvider(provider: unknown): void {
    if (!isDictationProviderId(provider)) throw new EngineStateError("invalid_request", "that is not a dictation provider this engine knows");
    writeDictationSettings(this.dictationDir, { ...readDictationSettings(this.dictationDir), provider });
  }

  /**
   * Which language to transcribe, or `multi` for all of them at once.
   *
   * REFUSED BY NAME rather than stored and discovered at the socket: an
   * unsupported code would come back from the provider as a failed handshake
   * with nothing on screen saying which setting caused it, and the person who
   * typed it would be three panes away by then.
   */
  setDictationLanguage(language: unknown): void {
    if (!isDictationLanguage(language)) {
      throw new EngineStateError("invalid_request", "that is not a language this engine's transcription provider can transcribe");
    }
    writeDictationSettings(this.dictationDir, { ...readDictationSettings(this.dictationDir), language });
  }

  /**
   * THE PERSON'S OWN GLOSSARY — the words nothing on this Mac could have
   * guessed (#581).
   *
   * TIDIED RATHER THAN REFUSED, which is the opposite of the language above and
   * deliberately so: a code the provider cannot transcribe is a setting that
   * will fail at a handshake three panes away, whereas a blank line in a list of
   * words is a person pressing return. `cleanDictationVocabulary` drops the
   * blanks and the repeats and stores the rest.
   */
  setDictationVocabulary(vocabulary: unknown): void {
    if (!Array.isArray(vocabulary)) throw new EngineStateError("invalid_request", "the dictation vocabulary must be a list of terms");
    writeDictationSettings(this.dictationDir, {
      ...readDictationSettings(this.dictationDir),
      vocabulary: cleanDictationVocabulary(vocabulary),
    });
  }

  /**
   * WHAT THIS MAC IS CURRENTLY ABOUT, for whoever is about to transcribe it
   * (#581).
   *
   * IT IS THE RAIL'S OWN LIST, `liveSessionRows`, and not a second fold written
   * here. The question is the same one a sidebar asks — which conversations are
   * unsettled, newest first — so asking it the same way means the words the
   * recogniser is primed with are exactly the rows a person can see, on both
   * storage backends, forever. A private walk over the sqlite index would have
   * been cheaper and would have answered NOTHING on a JSON-backed store, which
   * is every test that does not ask for sqlite.
   *
   * UNSETTLED ONLY, which is that method's default: a conversation the rail has
   * shelved is one nobody has looked at in days, and forty of them would crowd
   * out the seven that are on screen.
   *
   * ONCE PER PRESS OF A MIC BUTTON, against a read every connected cockpit
   * already makes every three seconds. The cost is the settled rows it does not
   * open, which is the whole of #493.
   */
  dictationContext(): DictationContext {
    const { sessions } = this.liveSessionRows();
    // THE RAW REGISTRY, not `listProjects`: that probes every checkout for a
    // branch and an icon, and this wants a name. Several `git` calls per project
    // to prime a recogniser would be the cost of the feature.
    const registry = this.readDocument(this.paths.projects);
    const projects = registry === undefined ? [] : parseRegistry(registry).projects;
    return {
      sessionTitles: sessions.flatMap((session) => (session.title ? [session.title] : [])),
      // A REMOVED PROJECT IS NOT ONE ANYBODY IS TALKING ABOUT — the same filter
      // every picker and the rail apply, and the reason `listProjects` exists.
      projectNames: projects.flatMap((project) => (project.removedAt === undefined ? [project.name] : [])),
      // ONLY A WORKTREE SESSION HAS A BRANCH OF ITS OWN. A `local` one is
      // working on whatever branch the checkout happens to be on, which belongs
      // to the project rather than to the conversation.
      branches: sessions.flatMap((session) => (session.workspace.mode === "worktree" ? [session.workspace.branch] : [])),
    };
  }

  /** Store the pasted key, or clear it with an empty string. The one write, so
   *  the 0600 file has exactly one author. */
  setDictationKey(key: unknown): { configured: boolean } {
    if (typeof key !== "string") throw new EngineStateError("invalid_request", "the dictation key must be text");
    if (key.length > 4096) throw new EngineStateError("invalid_request", "that key is too long");
    writeDictationKey(this.dictationDir, key);
    return this.dictationCredential();
  }

  /**
   * THE KEY ITSELF, FOR THE ONE CALLER THAT SPENDS IT.
   *
   * Read at call time and handed straight to `grantDictationToken`, which puts
   * it in an `Authorization` header and nowhere else. It is never returned to a
   * client, never logged and never cached — the route that calls this answers
   * with the short-lived token Deepgram mints, not with this.
   */
  dictationKey(): string | undefined {
    return readDictationKey(this.dictationDir);
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

  /**
   * BACKGROUND TASKS THE USER STOPPED, awaiting the actual process kill —
   * keyed by session, holding provider task ids. IN MEMORY, NOT A FILE: the
   * target is a live provider process, and a process does not outlive this
   * engine (an engine restart disposes every runtime, so a pending kill would
   * target something already gone). The
   * heartbeat drains this to whichever worker holds the runtime; the
   * projection is already `stopped`, so this is best-effort enforcement, not
   * the source of truth. See `stopBackgroundTasks` / `drainStopTasks`.
   */
  private readonly pendingStopTasks = new Map<string, Set<string>>();

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
   *
   * IT ALSO REPORTS WHAT THE SAVE COST, which is #594. The first variable on an
   * instance makes it CONFIGURED, and a configured instance stops inheriting the
   * fourteen variables its driver owns — correctly, but until now in silence,
   * and since #593 that first variable can be written by a control about
   * compaction. `stoppedInheriting` comes back with the answer so the change
   * cannot be invisible; `carryOverInherited` is how a caller keeps them.
   */
  saveProviderInstance(input: {
    id: string;
    driver?: unknown;
    displayName?: string | null;
    accentColor?: string | null;
    /** A whole percentage of the model's window, or `null` to fall back to the
     *  cockpit's default. Never a token count — see the contract's field. */
    contextNoticePercent?: number | null;
    enabled?: boolean;
    configDir?: string | null;
    binaryPath?: string | null;
    env?: unknown;
    /**
     * NAMES OF INHERITED VARIABLES TO KEEP, as explicit declarations of this
     * login's own.
     *
     * THE VALUES ARE NEVER IN THE REQUEST and never leave this process: the
     * engine reads them from its OWN environment. A route that carried the value
     * would put `ANTHROPIC_AUTH_TOKEN` on the wire in both directions to achieve
     * nothing the engine could not do on its own.
     */
    carryOverInherited?: unknown;
  }): { instance: ProviderInstance; stoppedInheriting: string[] } {
    assertInstanceId(input.id);
    const instances = this.readProviderInstances();
    const existing = instances.find((instance) => instance.id === input.id);
    const driver = input.driver === undefined ? existing?.driver : input.driver;
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
      throw new EngineStateError("invalid_request", "provider instance driver must be claude, codex, opencode or telar");
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
    const env = this.applyEnvEdits(input.id, this.withCarriedInheritance(input, driver, existing), existing?.env ?? [], secrets);
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
      /**
       * REFUSES RATHER THAN CLAMPS, the same rule the compaction threshold
       * follows: a share this cannot express is one the person has to see
       * refused, because silently moving their number is worse than a 400.
       */
      ...optionalNumberPatch("contextNoticePercent", input.contextNoticePercent, existing?.contextNoticePercent, (value) => {
        if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
          throw new EngineStateError("invalid_request", "context notice must be a whole percentage from 1 to 100");
        }
        return value;
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
    return {
      instance: structuredClone(this.listProviderInstances().find((entry) => entry.id === instance.id)!),
      // Computed against the instance as SAVED, so a carry-over in the same
      // breath reports nothing lost — which is the truth, and the difference
      // between an advisory and an alarm that fires after you have acted on it.
      stoppedInheriting: stoppedInheriting({ before: existing, after: parsed.data, ambient: this.ambientEnv }),
    };
  }

  /**
   * The submitted environment with any carried-over inheritance appended.
   *
   * REFUSES RATHER THAN GUESSES, on every arm. A name this driver does not own
   * would be a declaration that protects nothing from a scrub that never
   * touches it; a name the engine is not actually carrying would be written as
   * an EMPTY value, which is a variable the CLI reads rather than the absence
   * the caller asked to preserve; and a name the save already declares is a
   * caller that has lost track of its own request. The owner's rule for #594 is
   * that a loud refusal beats a quiet guess, and this is where that is spent.
   *
   * ABSENT CARRY-OVER RETURNS `input.env` UNTOUCHED, `undefined` included, so
   * the "absent leaves it alone" rule survives this function existing.
   */
  private withCarriedInheritance(
    input: { id: string; env?: unknown; carryOverInherited?: unknown },
    driver: ProviderDriverKind,
    existing: ProviderInstance | undefined,
  ): unknown {
    if (input.carryOverInherited === undefined) return input.env;
    if (!Array.isArray(input.carryOverInherited) || input.carryOverInherited.some((name) => typeof name !== "string")) {
      throw new EngineStateError("invalid_request", "carryOverInherited must be an array of variable names");
    }
    const names = input.carryOverInherited as string[];
    // The list this save would otherwise store: the submitted one when there is
    // one, and what the instance already holds when the caller only asked to
    // carry variables over.
    const base = (input.env === undefined ? (existing?.env ?? []) : input.env) as ProviderInstanceEnvVar[];
    if (!Array.isArray(base)) throw new EngineStateError("invalid_request", "provider instance environment is invalid");
    const declared = new Set(base.map((variable) => variable?.name));
    const inherited = new Set(inheritedOwnedEnv(driver, this.ambientEnv));
    const carried: ProviderInstanceEnvVar[] = [];
    for (const name of names) {
      if (!providerOwnsEnv(driver, name)) {
        throw new EngineStateError("invalid_request", `${name} is not a variable a ${driver} login owns`);
      }
      if (!inherited.has(name)) {
        throw new EngineStateError("invalid_request", `Telar is not inheriting ${name}, so there is nothing to carry over`);
      }
      if (declared.has(name)) throw new EngineStateError("invalid_request", `${name} is already declared by this login`);
      declared.add(name);
      carried.push({
        name,
        value: this.ambientEnv[name] ?? "",
        // A credential goes to the 0600 store and never comes back on a read;
        // a routing fact stays readable by the person who set it.
        sensitive: providerEnvIsCredential(name),
      });
    }
    return [...base, ...carried];
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
    if (
      id === defaultInstanceIdForDriver("claude") ||
      id === defaultInstanceIdForDriver("codex") ||
      id === defaultInstanceIdForDriver("opencode")
    ) {
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
    /**
     * A RETIRED DRIVER IS A MIGRATION, NOT A CORRUPT FILE.
     *
     * `telar` was a driver kind for one day (#526, reverted by #531) and anyone
     * who ran that build has a row naming it. Strict-parsing the array as a
     * whole turned that one stale row into a throw from THE read behind every
     * provider lookup — so the settings page 400'd, and, because
     * `resolveProviderInstance` sits on the session claim, so did starting a
     * session. A registry that outlives a driver is an ordinary consequence of
     * shipping, and it must cost the user nothing but the row.
     *
     * THE ROW GOES; THE SECRET IS LEFT EXACTLY WHERE IT IS. This is the opposite
     * of `removeProviderInstance`, which takes both: this read runs from
     * anywhere — a worker, a test, any route — and a lazy read that deleted
     * credentials is not one a person would expect. (The built-in Agent that
     * used to carry the #526 key across and then drop it is gone, #908.)
     *
     * THE PRUNE IS NARROW ON PURPOSE. Only an unknown `driver` is forgiven here;
     * every other malformed row still throws below, because that is corruption
     * rather than a word we retired, and silently dropping a login somebody
     * configured would be the worse failure.
     */
    const rows = Array.isArray(stored.providerInstances) ? stored.providerInstances : [];
    const kept = rows.filter(
      (row) =>
        !(
          typeof row === "object" &&
          row !== null &&
          !ProviderDriverKindSchema.safeParse((row as { driver?: unknown }).driver).success
        ),
    );
    if (kept.length !== rows.length) {
      this.writeDocument(this.paths.providerInstances, { version: STATE_VERSION, providerInstances: kept });
      stored.providerInstances = kept;
    }
    const parsed = ProviderInstanceSchema.array().safeParse(stored.providerInstances ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid provider instance registry");
    /**
     * BACKFILL, NOT A MIGRATION. A registry written before a driver existed has
     * no slot for it, and a session that routes to one would fall through to
     * `seedProviderInstance` on every claim rather than to a row a person can
     * switch off. One pass, written back once, for each slot that is missing.
     */
    const missing = (["opencode"] as const).filter((driver) => !parsed.data.some((instance) => instance.id === driver));
    if (missing.length > 0) {
      for (const driver of missing) parsed.data.push(seedProviderInstance(driver, this.now()));
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
      /**
       * WHAT THE JOURNAL SWEEP REMOVED, once it has — issue #646.
       *
       * The receipts and backup sweeps report through `executionHousekeeping`
       * because they finish inside the constructor. The journal sweep does not:
       * its first pass is a minute's work on a large store, so it runs on a
       * timer after the open and tells whoever is listening when it is done.
       * Absent by default — a store on its own announces nothing.
       */
      onExecutionHousekeeping?: (swept: { journal: { deltas: number; starts: number; sessions: number } }) => void;
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
      /** The daemon's computer-use gate: resolves cua-driver only while the
       *  last probe answered `granted`. INJECTED BY THE DAEMON, absent by
       *  default — so tests never read the real machine's installs, and a
       *  store without it simply has no computer use. */
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
      /** How disks are asked about (`volumes.ts`). INJECTED BY TESTS ONLY — the
       *  default reads the real machine's mounts and `diskutil`, and a test
       *  about an unplugged drive should not need a drive. */
      volumes?: VolumeDeps;
      /**
       * THE ENGINE'S OWN ENVIRONMENT — what a provider process would inherit
       * from this one if nothing scrubbed it (#594).
       *
       * INJECTED BY TESTS ONLY. The default is `process.env`, which is the only
       * correct answer in a running engine: the question "what is this login
       * about to stop inheriting" is a question about THIS process, and a test
       * that had to mutate the real environment to ask it would be a test that
       * leaks into every other test in the file.
       */
      ambientEnv?: Record<string, string | undefined>;
    } = {},
  ) {
    this.notifier = options.notifier;
    this.onQueueChanged = options.onQueueChanged;
    this.onTurnsStopped = options.onTurnsStopped;
    this.readModels = options.models ?? readModelCatalogue;
    this.manifest = options.manifest ?? BUNDLED_MANIFEST;
    this.computerUse = options.computerUse;
    this.syncGit = options.git ?? defaultGitRunner;
    this.asyncGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultAsyncGitRunner);
    // A POOL OF ITS OWN FOR THE CUTS, so the slowest git child cannot hold a
    // slot the rail's polls need — see `defaultWorktreeGitRunner`. An INJECTED
    // runner still wins, and wins for both: a test that fakes git is faking the
    // whole of git, and two seams would let a fake apply to half of it.
    this.worktreeGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultWorktreeGitRunner);
    this.gh = options.gh ?? defaultGhRunner;
    this.volumes = options.volumes ?? {};
    this.ambientEnv = options.ambientEnv ?? process.env;
    this.paths = statePaths(root);
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
    const migrated = fs.existsSync(this.paths.executionStore) || fs.existsSync(path.join(root, "execution.sqlite"));
    if (migrated && options.executionStorage === "json") throw new Error("this engine home has migrated to SQLite; restore a backup to downgrade");
    if (migrated || options.executionStorage === "sqlite") {
      // The journal sweep says what it removed when it removes it, which is
      // seconds AFTER the open rather than during it — the first pass on a
      // large store is a minute's work and belongs nowhere near the startup
      // path (#646). `onExecutionHousekeeping` is the daemon's line.
      this.executionStore = new ExecutionStore(root, {
        onJournalCompacted: (swept) => options.onExecutionHousekeeping?.({ journal: swept }),
        // RETENTION RIDES THE SAME CADENCE AND NEVER THE OPEN PATH (#542). The
        // store owns the mechanism and this owns the policy document, so the
        // sweep is a call rather than a second implementation of "settled".
        onRetentionSweep: () => { this.sweepRetention(); },
      });
      // `ingestObservations` is NOT here: it wraps itself, because a batch of
      // nothing but deltas writes no document at all and must not open a
      // transaction. See the method.
      const commands = ["createSession", "updateSession", "settleSession", "markSessionRead", "submitTurn", "submitAgentTurn",
        "claimTurn", "claimNextTurn", "markRunning", "openRequest", "resolveRequest", "completeTurn", "failTurn",
        "stopSession", "stopTurn", "pauseSession", "resumeSession", "stopBackgroundTasks", "taskStopsForWorker", "openProviderTurn",
        "reportSessionTasks", "ackSteer", "promoteTurn", "releaseHeldTurn", "discardAmbiguousTurn", "recover", "retireWorkerRegistration",
        "subscribe", "unsubscribe"] as const;
      for (const name of commands) {
        const operation = Reflect.get(this, name) as (...args: unknown[]) => unknown;
        Object.defineProperty(this, name, { value: (...args: unknown[]) =>
          this.executeCommand(name, () => Reflect.apply(operation, this, args)) });
      }
      // AFTER the commands are wrapped, so the backfill's own writes go through
      // one transaction rather than one per row.
      this.sessionIndexBackfill = this.backfillSessionRows();
      this.turnSummaryBackfill = this.backfillTurnSummaries();
    }
  }

  /**
   * WHAT THE INDEX BACKFILL BUILT ON OPEN — issue #493. See `backfillSessionRows`.
   *
   * Surfaced so the daemon can say it, on the same argument the housekeeping
   * sweep makes one screen up: a first open after this shipped folds every
   * session on the machine, and a person watching a slow start deserves to know
   * what it was doing. Absent on a store with no execution database; zero on
   * every open after the first, which the daemon says nothing about.
   */
  readonly sessionIndexBackfill?: { built: number; removed: number };

  /**
   * EVERY SESSION HAS A ROW BY THE TIME THIS RETURNS — the one-time backfill,
   * which is idempotent and therefore runs on every open.
   *
   * IT RECONCILES RATHER THAN REBUILDS. `sessionRowGaps` compares two sets of
   * keys — no document text on either side — and the answer is empty on every
   * open but the first, so the ordinary cost is one covering seek and one
   * primary-key scan. A store that has only ever been written by a binary with
   * this change never has a gap at all.
   *
   * WHY NOT A `metadata` MARKER, LIKE THE IMPORT'S. The table is additive and
   * `user_version` stays at 1 (see the schema), so an older binary can open this
   * store, write documents it does not know to index, and hand it back. A marker
   * would say "done" over rows that had gone stale underneath it. Keys are cheap
   * enough that asking honestly beats trusting a flag that a downgrade
   * invalidates.
   *
   * IT DOES NOT CATCH A STALE ROW — only a missing or an orphaned one. A row
   * whose document was rewritten by a binary that did not maintain it stays
   * wrong until that session is next written to. That is the trade the additive
   * schema buys, and it is bounded: the rows a downgrade can touch are the
   * sessions it was used to work in, and working in one writes it again.
   */
  private backfillSessionRows(): { built: number; removed: number } {
    const store = this.executionStore;
    if (!store) return { built: 0, removed: 0 };
    const { missing, orphaned } = store.sessionRowGaps();
    if (missing.length === 0 && orphaned.length === 0) return { built: 0, removed: 0 };
    this.executeCommand("backfillSessionIndex", () => {
      for (const id of orphaned) store.deleteSessionRow(id);
      for (const id of missing) this.storeSessionRow(id);
    });
    return { built: missing.length, removed: orphaned.length };
  }

  /**
   * WHAT THE TURN PROJECTION BUILT ON OPEN — issue #516. See
   * `backfillTurnSummaries`. Reported in one line by the daemon, like #493's,
   * and for its reason: a first open after this shipped folds every conversation
   * on the machine, and a person watching a slow start deserves to know why.
   */
  readonly turnSummaryBackfill?: { sessions: number; turns: number };

  /**
   * EVERY TURN HAS A ROW BY THE TIME THIS RETURNS — the one-time backfill.
   *
   * WHOLE SESSIONS AT A TIME, not turn by turn. `turnSummaryGaps` asks which
   * sessions have NO rows at all, which is a `DISTINCT` over a primary key on
   * one side and a covering key seek on the other — no document text on either.
   * A session already summarised is skipped entirely; one that is not is folded
   * from its queue and its items, both parsed once.
   *
   * IT PARSES `items.json` WHOLE, DELIBERATELY. The indexed span read that the
   * steady state uses is the right shape for ONE run and the wrong one for all
   * of them: reading four hundred spans out of one document is four hundred
   * queries to avoid a parse the backfill was always going to pay in full.
   *
   * NOT A REBUILD OF ROWS THAT EXIST. A session whose rows went stale under a
   * binary that did not maintain them is corrected by `reconcileTurnSummaries`
   * the next time it is written to — the same trade the session index makes, and
   * bounded the same way: the conversations a downgrade can touch are the ones
   * it was used to work in.
   *
   * NEVER THROWS FOR ONE BAD SESSION. A corrupt queue is skipped, exactly as the
   * live fold skips an unreadable directory: one conversation must not be able to
   * stop an engine from starting.
   */
  private backfillTurnSummaries(): { sessions: number; turns: number } {
    const store = this.executionStore;
    if (!store) return { sessions: 0, turns: 0 };
    const missing = store.turnSummaryGaps();
    if (missing.length === 0) return { sessions: 0, turns: 0 };
    let turns = 0;
    let sessions = 0;
    /**
     * AND IT MIGRATES NOTHING — issue #658, and #646's lesson kept.
     *
     * This pass reads every `items.json` on the machine, which makes it the
     * most tempting place in the codebase to move them all to rows: the text is
     * already parsed and the loop is already written. It is also the OPEN PATH,
     * and #646's compaction sweep looked exactly this free in the constructor
     * and cost 54 s on the first launch after it shipped.
     *
     * So the per-session migration stays lazy and stays where a person is
     * already waiting for that one session. A store opened and never used
     * migrates nothing at all.
     */
    this.suppressItemsMigration = true;
    try {
      for (const sessionId of missing) {
        try {
          this.executeCommand("backfillTurnSummaries", () => {
            const queue = this.readQueue(sessionId);
            if (queue.turns.length === 0) return;
            const items = [...this.itemsById(sessionId).values()];
            const byRun = new Map<string, Item[]>();
            for (const item of items) {
              const filed = byRun.get(item.runId);
              if (filed) filed.push(item);
              else byRun.set(item.runId, [item]);
            }
            for (const turn of queue.turns) store.writeTurnSummary(summariseTurn(turn, byRun.get(turn.runId) ?? []));
            turns += queue.turns.length;
            sessions += 1;
          });
        } catch {
          // Unreadable is skipped, not thrown — see the note above.
        }
      }
    } finally {
      this.suppressItemsMigration = false;
    }
    /**
     * AND THE BACKFILL LETS GO OF EVERYTHING IT READ TO GET HERE — the argument
     * `liveQueueSessionIds` makes about its own cold build, for the same reason
     * and with a sharper edge: this is the one pass that parses every
     * conversation's `items.json` on the machine, and leaving those maps in the
     * caches would hand the first read after a start a projection it did not
     * pay for. A store that looks cheaper than it is cannot be measured, and
     * `readAccounting` exists precisely to measure it.
     *
     * The memo goes with them: it names rows this wrote from outside the
     * ordinary write path, so the first reconcile per session re-reads them.
     */
    this.itemsCache.clear();
    this.queueCache.clear();
    this.foldedTurnStates.clear();
    return { sessions, turns };
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
        // Its availability is absent for the same reason — nothing probed it,
        // so there is no answer to publish.
        if (project.removedAt !== undefined) return project;
        // THE METADATA READ IS WHAT PROBES (see `projectMetadata`), so the
        // availability is asked for AFTER it rather than beside it: two probes
        // in one listing would be two `stat`s per project for one answer.
        const metadata = this.projectMetadata(project);
        return { ...project, ...metadata, availability: this.projectAvailability(project) };
      });
  }

  /**
   * WHAT EACH PROJECT'S AVAILABILITY WAS THE LAST TIME ANYBODY LOOKED.
   *
   * NOT A TTL CACHE, and that distinction is the whole design. The value is
   * never served in place of a probe — `projectAvailability` probes every time,
   * because three `stat`s are cheaper than any bookkeeping that would avoid
   * them. What this remembers is the PREVIOUS answer, so a CHANGE can be
   * noticed: a drive coming back is the moment the branch, the icon, the diff
   * and the file tree cached while it was away all became lies, and they are
   * dropped then rather than at the end of somebody's TTL.
   *
   * In memory, like every other cache here: it is a fact about a cable, and a
   * stale one surviving a restart would be worse than probing once on open.
   */
  private readonly projectAvailabilityCache = new Map<string, ProjectAvailability>();

  /**
   * WHICH MOUNT CONFIGURATION EACH AWAY PROJECT HAS ALREADY BEEN SEARCHED FOR.
   *
   * The remount search is the expensive one — a `diskutil` child per mounted
   * volume — and it can only succeed if a disk has arrived. Keyed by project and
   * valued by `mountSignature`, so an unplugged drive that stays unplugged is
   * searched for exactly once no matter how long the poll runs.
   */
  private readonly remountAttempts = new Map<string, string>();

  /**
   * IS THIS PROJECT'S DISK HERE — the one answer every surface reads.
   *
   * ONE OWNER, on purpose. A rail deciding for itself whether a folder is
   * readable, a composer deciding again, and `assertProjectAvailable` deciding a
   * third time is three chances to disagree about a cable, in three places a
   * person would have to reconcile by hand. See `probeAvailability` for what it
   * costs and why the mount is asked before the root.
   *
   * ALWAYS FRESH. The tick in `projectMetadata` decides how often anyone ASKS;
   * it does not make this answer older than the question.
   */
  projectAvailability(project: Pick<Project, "id" | "root"> & { volume?: Project["volume"] }): ProjectAvailability {
    const availability = probeAvailability(project, this.volumes);
    const previous = this.projectAvailabilityCache.get(project.id);
    if (previous === availability) return availability;
    this.projectAvailabilityCache.set(project.id, availability);
    /**
     * THE FIRST ANSWER IS NOT A TRANSITION. On a cold store every project moves
     * from "nobody has looked" to something, and dropping every cache for each
     * of them would make the first read of every surface the slow one.
     */
    if (previous !== undefined) this.forgetProjectReads(project);
    return availability;
  }

  /**
   * DROP WHAT WAS READ OFF A DISK THAT HAS SINCE CHANGED UNDER US.
   *
   * Called on an availability TRANSITION in either direction. Going away, the
   * branch and icon in hand were read from a disk nobody can see any more;
   * coming back, they are whatever the failing reads left behind — a blank
   * branch, a "no icon", a diff that said `repository: false`. Neither is worth
   * the ten seconds a TTL would keep it.
   */
  private forgetProjectReads(project: Pick<Project, "id" | "root">): void {
    this.projectMetadataCache.delete(project.id);
    this.forgetProjectIcon(project.id);
    // `gitReadCache` is keyed by PATH rather than by project — the overview, the
    // diff and every file patch under this root — so the root is what identifies
    // the entries to drop.
    this.forgetGitReadsUnder(project.root);
  }

  /** Every cached git read that names `root` — see `forgetProjectReads`. */
  private forgetGitReadsUnder(root: string): void {
    for (const key of [...this.gitReadCache.keys()]) {
      if (key.includes(root)) this.gitReadCache.delete(key);
    }
  }

  /** Sidebar metadata refreshes off the request path. Cold rows appear immediately;
   * branch/icon labels arrive on the next poll without blocking worker heartbeats. */
  private readonly projectMetadataCache = new Map<string, {
    root: string; at: number; value: Pick<Project, "branch" | "icon" | "remoteUrl">; pending?: Promise<void>;
  }>();

  private projectMetadata(project: Project): Pick<Project, "branch" | "icon" | "remoteUrl"> {
    /**
     * THE DISK IS ASKED ABOUT FIRST, AND BEFORE THE CACHE IS READ — issue #534.
     *
     * NO NEW TIMER. This is the call every listing already makes, so the probe
     * rides it rather than earning a ticker of its own; `reprobeProjects` and
     * the sweep at daemon start are the same probe at other moments, never a
     * second opinion.
     *
     * ON EVERY CALL RATHER THAN ON THE TEN-SECOND TICK BELOW, because the two
     * costs are not comparable: the tick exists to bound three `git` children
     * and a directory walk, and this is three `stat`s. Putting it on the tick
     * would have made "how long after I plug the drive back in does the rail
     * say so" up to ten seconds for no saving worth having.
     *
     * BEFORE THE LOOKUP, not after, and that ordering is load-bearing: a
     * transition DELETES this very entry, so an `entry` read first would be
     * written back over the invalidation and keep the branch that was read off a
     * disk nobody can see.
     */
    const availability = this.projectAvailability(project);
    let entry = this.projectMetadataCache.get(project.id);
    if (!entry || entry.root !== project.root) {
      entry = { root: project.root, at: -Infinity, value: {} };
      this.projectMetadataCache.set(project.id, entry);
    }
    /**
     * NOTHING IS SPAWNED AGAINST A DISK THAT IS NOT THERE.
     *
     * This is the churn #534 is named for: three `git` children per project
     * every ten seconds, each failing into an unplugged drive, each turning
     * ENOENT into a status 1 that nothing reported — about 18 children a minute
     * for one away project, forever. The icon read is skipped for the same
     * reason and a worse one: it WALKS the checkout.
     *
     * AND THE LABELS GO WITH THEM. A branch name left over from before the
     * unplug is a claim about a disk nobody can read; the row says the drive is
     * away instead, which is the true thing and a shorter sentence.
     */
    if (availability !== "available") {
      entry.value = {};
      /**
       * AND THE POLL IS ALSO WHERE A DRIVE COMES BACK UNDER A NEW NAME — step 7.
       *
       * `POST /v2/projects/reprobe` is the fast path and does this within a
       * quarter-second of a mount; this is the floor under it, for a cockpit
       * running without the desktop shell, a shell whose watcher died, and a
       * drive swapped while the Mac was off. Bounded twice over: only for a
       * project that cannot be read, and only once per distinct mount
       * configuration — see `recoverRemountedProject`.
       *
       * `at` IS STAMPED FIRST because the recovery DELETES this entry on
       * success, and writing to it afterwards would resurrect a detached one.
       */
      entry.at = this.now();
      this.recoverRemountedProject(project);
      return entry.value;
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

  /**
   * ASK EVERY PROJECT'S DISK NOW, rather than waiting for somebody to look.
   *
   * TWO CALLERS, ONE PROBE. The daemon runs this once at start, so an engine
   * that came up with a drive already unplugged knows it before the first
   * listing rather than on it; and `POST /v2/projects/reprobe` runs it when the
   * desktop shell notices a mount or an unmount, which is what turns "within ten
   * seconds" into "immediately". Neither is a second opinion — both go through
   * `projectAvailability`, and the poll stays the floor under both.
   *
   * REMOVED PROJECTS ARE SKIPPED. A put-away project is on no surface that could
   * show a drive badge, and probing it would be three `stat`s for a row nobody
   * is drawing.
   */
  reprobeProjects(): { projects: number; changed: number; recovered: number } {
    const registry = this.readDocument(this.paths.projects);
    const projects = registry === undefined ? [] : parseRegistry(registry).projects.filter((project) => project.removedAt === undefined);
    let changed = 0;
    let recovered = 0;
    for (const project of projects) {
      const before = this.projectAvailabilityCache.get(project.id);
      let availability = this.projectAvailability(project);
      /**
       * A DRIVE MOUNTED SOMEWHERE ELSE IS STILL THIS DRIVE — see
       * `recoverRemountedProject`. Attempted only when the project cannot be
       * read, which is what keeps the `diskutil` it costs off the poll path, and
       * HERE rather than inside the probe because this is the call that happens
       * when a disk has just appeared.
       */
      if (availability !== "available" && this.recoverRemountedProject(project) !== undefined) {
        recovered += 1;
        availability = this.projectAvailability(this.getProject(project.id));
      }
      if (availability !== before) changed += 1;
    }
    return { projects: projects.length, changed, recovered };
  }

  /**
   * THE DRIVE IS BACK, UNDER A DIFFERENT NAME — issue #534, step 7.
   *
   * WHAT MACOS ACTUALLY DOES. A volume whose name is already taken in `/Volumes`
   * — by the empty folder its own unmount left behind, or by another disk — is
   * mounted at `<name> 1`. So replugging the drive a project was registered from
   * routinely changes its PATH while changing nothing about the disk.
   *
   * WHY THE PATH CANNOT BE THE ANSWER. Before this, the only way back was to
   * register the new folder, and `registerProject` mints a NEW id for a root it
   * has not seen. Three things outlive a registration and are keyed by that id —
   * a session's `projectId`, an MCP server's scope, a browser profile's binding
   * — so the person would point Telar at the same disk and lose all three, from
   * an action that reads like plugging a cable back in.
   *
   * THIS IS THE ONE SANCTIONED WRITE OF `Project.root`, and `updateProject`'s
   * refusal still stands for every other caller: moving a project means
   * registering the new folder. This is not a move. It is the same folder, on
   * the same disk, and the uuid is what proves it — which is why the match is on
   * the uuid and never on a name, a size or a label.
   *
   * IT REFUSES TO GUESS. The new root has to EXIST on the remounted volume; a
   * drive that came back without the project's folder on it is a `missing`
   * project, not a rename, and rewriting the record would point every session at
   * a path that is not there either.
   *
   * Returns the updated project, or nothing when there was nothing to recover.
   */
  private recoverRemountedProject(project: Project): Project | undefined {
    if (project.volume === undefined) return undefined;
    /**
     * THE CHEAP PRECONDITION FIRST — see `mountSignature`.
     *
     * The search below costs a `diskutil` child per mounted volume, and this
     * runs on the ten-second poll for every away project. Paying that every tick
     * would be a worse version of the git churn this issue exists to remove. A
     * drive can only have come back if the set of mount points changed, and that
     * question is a `readdir` and a `stat` each — so one attempt per project per
     * distinct mount configuration, and nothing at all while a drive sits in
     * somebody's bag.
     */
    const signature = mountSignature(this.volumes);
    if (this.remountAttempts.get(project.id) === signature) return undefined;
    this.remountAttempts.set(project.id, signature);
    const mount = findVolumeMount(project.volume.uuid, this.volumes);
    if (mount === undefined || mount === project.volume.mount) return undefined;
    const within = path.relative(project.volume.mount, project.root);
    // A root that is not under its own recorded mount is a record this cannot
    // reason about; leave it alone rather than composing a path from a guess.
    if (within.startsWith("..") || path.isAbsolute(within)) return undefined;
    const root = within === "" ? mount : path.join(mount, within);
    try {
      if (!fs.statSync(root).isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    const registryDocument = (this.readDocument(this.paths.projects) ?? emptyRegistry()) as unknown;
    const parsed = parseRegistry(registryDocument);
    const stored = parsed.projects.find((candidate) => candidate.id === project.id);
    if (stored === undefined) return undefined;
    const previousRoot = stored.root;
    stored.root = root;
    stored.volume = { mount, uuid: project.volume.uuid };
    stored.updatedAt = this.now();
    this.writeDocument(this.paths.projects, parsed);

    /**
     * AND EVERY SESSION THAT WORKS IN IT. A `local` session's workspace IS the
     * project root, so a record left pointing at the old path would send a
     * provider to a folder that no longer exists — the project would be back and
     * its conversations would not.
     *
     * A WORKTREE SESSION IS DELIBERATELY UNTOUCHED. Its checkout lives under the
     * engine root on the internal disk (see `worktree.ts`) and never moved; what
     * was broken while the drive was away was the `.git` it points AT, and that
     * is fixed by the drive being back.
     */
    const moved: string[] = [];
    const prefix = previousRoot.endsWith(path.sep) ? previousRoot : `${previousRoot}${path.sep}`;
    for (const session of this.readSessions()) {
      if (session.projectId !== project.id) continue;
      const current = workspacePath(session.workspace);
      if (current === undefined) continue;
      if (current !== previousRoot && !current.startsWith(prefix)) continue;
      const next = current === previousRoot ? root : path.join(root, current.slice(prefix.length));
      const updated: Session = {
        ...session,
        workspace: { ...session.workspace, path: next } as Session["workspace"],
        updatedAt: this.now(),
      };
      this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(updated));
      this.appendEvent(session.id, { type: "session.updated", session: updated });
      moved.push(session.id);
    }

    // The reads in hand were taken off a disk that has since come back at
    // another address; none of them describes anything that exists now.
    this.forgetProjectReads({ id: project.id, root: previousRoot });
    this.forgetProjectReads({ id: project.id, root });
    this.projectAvailabilityCache.delete(project.id);

    /**
     * ONE LINE, because a record the engine rewrote on its own is exactly the
     * kind of thing a person needs to be able to find afterwards — and because
     * the alternative reading of a project that silently changed its path is
     * that something is wrong with the store.
     */
    process.stdout.write(
      `Telar engine: ${project.name} came back on its own drive at a new path — ${previousRoot} → ${root}` +
        `${moved.length > 0 ? ` (${moved.length} session${moved.length === 1 ? "" : "s"} moved with it)` : ""}\n`,
    );

    this.retryWorktreesFailedWhileAway(project.id, root);
    return structuredClone(stored);
  }

  /**
   * ONE AUTOMATIC RETRY FOR A CUT THAT FAILED WHILE THE DISK WAS GONE.
   *
   * A worktree session created while the drive was away has a row saying so
   * forever: `git worktree add` could not read the repository, the failure was
   * recorded on the session (`SessionPreparation`), and nothing ever tried
   * again. The reason it failed has just stopped being true, so this is the one
   * moment a retry is not a guess.
   *
   * ONCE, AND ONLY HERE. Nothing retries on a timer and nothing retries a cut
   * that failed for its own reasons — a branch that already exists, a bad base —
   * because those failures are still failures with the drive plugged in. The
   * gate is the RECOVERY, not the error text: a retry that fails again simply
   * records the new failure, and the row says what git said this time.
   */
  private retryWorktreesFailedWhileAway(projectId: string, projectRoot: string): void {
    for (const session of this.readSessions()) {
      if (session.projectId !== projectId) continue;
      if (session.preparation?.state !== "failed") continue;
      if (session.workspace.mode !== "worktree") continue;
      const plan: WorktreePlan = { path: session.workspace.path, branch: session.workspace.branch, named: false };
      const baseSha = workspaceBaseRef(session.workspace);
      // No recorded base is no commit to cut from, and inventing one would put
      // the session on a checkout nobody chose. The row keeps its failure.
      if (baseSha === undefined) continue;
      this.prepareWorktree(session.id, projectRoot, plan, baseSha);
    }
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
    /**
     * WHICH DISK THIS IS ON, asked once, here — see `volumes.ts`.
     *
     * REGISTRATION IS THE ONLY AFFORDABLE MOMENT for the `diskutil` child this
     * costs: it is a request somebody is waiting on, it happens once per
     * project, and every later question about the drive is answered by three
     * `stat`s against what it records. A project on this Mac's own disk gets
     * nothing and is unchanged in every respect.
     */
    const volume = volumeForRoot(projectRoot, this.volumes);
    const tombstone = parsed.projects.find((project) => project.root === projectRoot && project.removedAt !== undefined);
    if (tombstone && (input.id === undefined || input.id === tombstone.id)) {
      delete tombstone.removedAt;
      tombstone.name = input.name.trim();
      tombstone.updatedAt = this.now();
      // RE-READ ON THE WAY BACK IN, because a project put away before this
      // existed carries no volume at all, and one put away on a drive that has
      // since been reformatted carries the wrong uuid. Restoring is the person
      // pointing at this folder again, so what the disk says now wins.
      if (volume === undefined) delete tombstone.volume;
      else tombstone.volume = volume;
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
      ...(volume === undefined ? {} : { volume }),
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
    const project = this.getProject(projectId);
    if (project.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
    }
    /**
     * AND THE DISK HAS TO BE THERE — issue #534.
     *
     * The same three places, and the same argument: reading stays open, starting
     * work does not. What differs is WHY it is refused and therefore what the
     * sentence has to say. A removed project needs a decision (restore it); an
     * unplugged drive needs a cable, and telling somebody to re-register would
     * be actively harmful — re-registering a different path mints a new project
     * id and strands the sessions they are trying to get back to.
     *
     * PROBED FRESH RATHER THAN READ OFF THE LAST LISTING. This is the moment a
     * provider would be spawned in the folder, and a ten-second-old answer about
     * a cable is exactly old enough to be wrong.
     *
     * `unmounted` ONLY, AND `missing` DELIBERATELY NOT. A deleted folder already
     * has a good answer and it is a BETTER-PLACED one: the turn is accepted, the
     * worker's `assertProjectRoot` refuses to spawn, and the sentence naming the
     * folder lands in the conversation the person is looking at rather than as a
     * dialog on a button. Nothing about an external drive changes that, and
     * moving the refusal earlier would only make it harder to read.
     */
    if (this.projectAvailability(project) === "unmounted") {
      throw new EngineStateError("conflict", `The drive holding ${project.name} is not connected. Plug it back in and this will work again.`);
    }
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
    const workspace = workspaceRootOf(session);
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

  /**
   * WHAT THE DISK WAS DOING, STAMPED ON A READ TAKEN OFF IT — issue #534.
   *
   * WHY THE REVIEW SURFACES NEED IT. `git` reports `repository: false` for a
   * path it cannot read and a file walk of a path that is not there returns no
   * files, so an unplugged drive produced a diff that said "not a repository, no
   * changes" and a tree that said "no files" — both of which read as CLEAN when
   * the truth is that nobody looked. The fields already there cannot tell those
   * apart; this one can.
   *
   * OUTSIDE THE CACHE, DELIBERATELY. `cachedGitRead` holds the answer for two
   * seconds, and a cable can move inside two seconds — stamping within the
   * cached read would preserve an availability from before the unplug on a diff
   * served after it. The expensive half is cached; this is three `stat`s and is
   * taken fresh every time.
   *
   * ABSENT WHEN THERE IS NO PROJECT TO ASK ABOUT — a session with no checkout —
   * rather than guessed at from the workspace path.
   */
  private async withAvailability<T extends object>(answer: Promise<T>, project: Project | undefined): Promise<T> {
    const value = await answer;
    return project === undefined ? value : { ...value, availability: this.projectAvailability(project) };
  }

  /**
   * WHOSE CHECKOUT THIS DIFF DESCRIBES — issue #690.
   *
   * A `local` session shares the project checkout with the editor and with every
   * other local session, so `base…worktree` there is the checkout's difference
   * and not the session's work. Only the session record knows which kind it is;
   * `git.ts` is handed a directory and cannot tell a worktree from a project
   * root. See `SessionDiff.shared` for what the flag licenses.
   *
   * STAMPED, NOT COMPUTED FROM THE PATH: a `local` session's checkout IS the
   * project root, and guessing from the directory would make this a heuristic
   * about a fact the store already holds.
   */
  private static sharedCheckout<T extends object>(value: T, session: Pick<Session, "workspace">): T {
    return session.workspace.mode === "local" ? { ...value, shared: true } : value;
  }

  /** The project a session's work belongs to, when it has one. */
  private projectOfSession(session: Session): Project | undefined {
    if (session.projectId === undefined) return undefined;
    try {
      return this.getProject(session.projectId);
    } catch {
      // A session whose project id resolves to nothing is not this method's
      // problem to report — the read it is decorating still answers.
      return undefined;
    }
  }

  /**
   * WHERE A TURN'S ANCHOR IS READ — issue #741.
   *
   * THE SESSION'S OWN CHECKOUT, OR THE PROJECT ROOT WHEN IT IS GONE. A commit
   * made inside a worktree stays readable from the project root after
   * `git worktree remove --force` and even after `git branch -D` — worktrees
   * share one object database — so an anchored turn OUTLIVES its checkout,
   * which the working-tree comparison it replaces never could. The one thing
   * that has to be true is that the read runs somewhere that still exists.
   *
   * Absent when there is neither: a session with no workspace and no project
   * has nothing to anchor to, which is a fact rather than a failure.
   */
  private anchorReadRoot(session: Session): string | undefined {
    const workspace = workspacePath(session.workspace);
    if (workspace !== undefined && fs.existsSync(workspace)) return workspace;
    return this.projectOfSession(session)?.root;
  }

  /**
   * Stamp where the repository stands, OFF THE LOCK — issue #741.
   *
   * ────────────────────────────────────────────────────────────────────────
   * NEVER THE SYNCHRONOUS RUNNER, AND NEVER INLINE. `worktree.ts`'s header
   * records what that costs: `listProjects` calling sync git in the daemon loop
   * froze every request, and a `rev-parse --abbrev-ref HEAD` on a project under
   * `~/Documents` blocked FOR MINUTES in the kernel. `markRunning` runs for
   * every turn of every session, under the store lock. So the probe is
   * dispatched and the answer written back when it arrives; a turn is never
   * held waiting for git, and the worst case is an anchor that lands a moment
   * after the event that named it.
   * ────────────────────────────────────────────────────────────────────────
   *
   * A PROBE THAT DID NOT ANSWER SETS `read` RATHER THAN LEAVING A PLAUSIBLE
   * ABSENT. Absent with no `read` means "there was nothing to see" — a
   * repository with no commits yet, which `rev-parse --verify` reports by
   * exiting non-zero. The two are different claims and #654 is the precedent
   * for keeping them apart.
   */
  private anchorTurn(sessionId: string, runId: string, side: "before" | "after"): void {
    let cwd: string | undefined;
    try {
      /**
       * `requireSession`, NOT `getSession` — #545's lesson, and this method is
       * exactly the caller it was written about.
       *
       * `getSession` folds the session's ACTIVITY, which parses `queue.json`,
       * `requests.json` and `tasks.json` to derive a pill nothing here looks
       * at. This runs INSIDE `markRunning` and the three terminal transitions,
       * which `queue-write-path.test.ts` pins at a fixed number of whole-queue
       * parses each — so the fold turned `markRunning`'s 2 into 3. All this
       * wants is the workspace and the project id.
       */
      cwd = this.anchorReadRoot(this.requireSession(sessionId));
    } catch {
      // A session that vanished between the transition and this line has
      // nothing to anchor; the turn's own record is already written.
      return;
    }
    if (cwd === undefined) return;
    // A TURN THAT ENDED HAS JUST WRITTEN TO THIS CHECKOUT. Every terminal
    // transition passes here, so the review surfaces' cached reads of it are
    // dropped rather than served for up to another two seconds.
    if (side === "after") this.forgetGitReadsUnder(cwd);
    void this.asyncGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: ANCHOR_PROBE_MS })
      .then((result) => this.stampAnchor(sessionId, runId, side, result))
      .catch(() => {
        // The runner reports every failure as a result; a throw here would be
        // the store itself, and it must not take the daemon with it.
      });
  }

  /**
   * Write one side of an anchor onto whatever the turn says NOW.
   *
   * RE-READ RATHER THAN CLOSED OVER, exactly as `settleWorktree` is: git ran
   * while the world moved, and writing a turn captured before the probe would
   * silently undo whatever happened during it. A turn that no longer exists is
   * not an error — there is simply nothing left to stamp.
   *
   * THROUGH `executeCommand`, because this arrives on a promise rather than
   * through the wrapped command surface, and a queue write outside the
   * transaction is a queue write nothing serialises.
   */
  private stampAnchor(sessionId: string, runId: string, side: "before" | "after", result: GitResult): void {
    /**
     * FOUR ANSWERS FROM ONE COMMAND, and the third is the one worth naming.
     *
     *   status 0   a sha. Write it.
     *   timedOut   nobody looked. `read: "timeout"`, and the sha stays absent
     *              rather than becoming a plausible wrong one.
     *   status 1   `--verify --quiet` reporting that HEAD does not resolve — a
     *              repository with NO COMMITS YET. Nothing to write, and
     *              nothing wrong: absent with no `read` is the honest record,
     *              and the empty-tree sha would be a sentinel a reader could
     *              also have named deliberately.
     *   anything   git did not answer at all (128 on a path that is not a
     *   else       repository). `read: "failed"`.
     */
    if (result.timedOut) return this.writeAnchor(sessionId, runId, { read: "timeout" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      return this.writeAnchor(sessionId, runId, sha ? { [side]: sha } : { read: "failed" });
    }
    if (result.status === 1) return;
    this.writeAnchor(sessionId, runId, { read: "failed" });
  }

  private writeAnchor(sessionId: string, runId: string, patch: { before?: string; after?: string; read?: GitReadFailure }): void {
    if (Object.keys(patch).length === 0) return;
    try {
      this.executeCommand("stampTurnAnchor", () => {
        const queue = this.readQueue(sessionId);
        const turn = queue.turns.find((candidate) => candidate.runId === runId);
        if (!turn) return;
        const merged = { ...(turn.anchor ?? {}), ...patch };
        // A LATER GOOD READ CLEARS AN EARLIER DOUBT, but a doubt never erases a
        // sha somebody already observed: `before` and `after` are separate
        // observations and only the failing one is in doubt.
        if (patch.read === undefined) delete merged.read;
        turn.anchor = merged;
        turn.updatedAt = this.now();
        this.writeQueue(sessionId, queue);
      });
    } catch {
      // A session deleted while the probe ran leaves nothing to write to.
    }
  }

  projectGitAsync(projectId: string): Promise<GitOverview> {
    const project = this.getProject(projectId);
    return this.withAvailability(this.cachedGitRead(`git:${project.root}`, () => gitOverviewAsync(this.asyncGit, project.root)), project);
  }

  projectDiffAsync(projectId: string): Promise<SessionDiff> {
    const project = this.getProject(projectId);
    return this.withAvailability(this.cachedGitRead(`diff:${project.root}`, () => sessionDiffAsync(this.asyncGit, { cwd: project.root })), project);
  }

  /** NOT `async`, so a session with no directory is refused BEFORE the first
   *  await — see the projectless-session test, which asserts exactly that. */
  sessionDiffAsync(sessionId: string, options: DiffBaseOption = {}): Promise<SessionDiff> {
    const session = this.getSession(sessionId);
    const base = resolveRequestedBase(options, workspaceBaseRef(session.workspace));
    /**
     * A WORKTREE SESSION'S CHECKOUT IS ON THE INTERNAL DISK AND ITS `.git` IS
     * NOT — see `worktree.ts`'s header. So the availability that matters to this
     * read is the PROJECT's, not the workspace path's: the worktree directory is
     * perfectly readable while every git command inside it fails.
     */
    /**
     * A RANGE IS READ WHERE IT STILL RESOLVES — issue #741.
     *
     * An anchored turn outlives its checkout, because worktrees share one
     * object database. So a comparison of two commits runs in the session's
     * directory when it is there and in the PROJECT ROOT when it is not,
     * rather than failing on a `.git` pointer into a worktree somebody removed.
     * The working-tree reads keep the checkout: there is no working tree to
     * read anywhere else.
     */
    const cwd = options.to ? this.anchorReadRoot(session) ?? workspaceRootOf(session) : workspaceRootOf(session);
    return this.withAvailability(
      this.cachedGitRead(`diff:${cwd}:${base ?? ""}:${options.to ?? ""}`, () => sessionDiffAsync(this.asyncGit, {
        cwd,
        ...(base ? { baseRef: base } : {}),
        ...(options.to ? { to: options.to } : {}),
      })),
      this.projectOfSession(session),
      // Outside the cached read, like the availability above it: two local
      // sessions on one checkout share that entry, and this is a fact about the
      // session rather than about the read.
    ).then((value) => EngineStore.sharedCheckout(value, session));
  }

  projectFilePatchAsync(projectId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    const project = this.getProject(projectId);
    return this.readFilePatchAsync(project.root, target, options);
  }

  sessionFilePatchAsync(sessionId: string, target: string, options: FilePatchOptions = {}): Promise<GitFilePatch> {
    const session = this.getSession(sessionId);
    /**
     * THE ROW'S PATCH IS READ AGAINST THE SAME BASE THE LIST WAS (#694).
     *
     * They are one answer shown at two depths: a list built from `unstaged`
     * over a row's patch built from the session's base would put hunks under a
     * row whose ± counts came from a different comparison, and neither figure
     * would be wrong on its own.
     */
    const cwd = options.to ? this.anchorReadRoot(session) ?? workspaceRootOf(session) : workspaceRootOf(session);
    return this.readFilePatchAsync(cwd, target, options, resolveRequestedBase(options, workspaceBaseRef(session.workspace)));
  }

  private readFilePatchAsync(cwd: string, target: string, options: FilePatchOptions, baseRef?: string): Promise<GitFilePatch> {
    if (!target.trim()) throw new EngineStateError("invalid_request", "a file path is required");
    const resolved = path.resolve(cwd, target);
    const prefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the workspace");
    /**
     * THE OLD PATH IS FENCED EXACTLY AS THE NEW ONE IS (#694). It reaches the
     * same pathspec on the same command line, so a `renamedFrom` of `../../`
     * would be the same escape by a second door — and a door that was added
     * later is exactly the one a fence written for one parameter misses.
     */
    const renamedFrom = EngineStore.insideWorkspace(cwd, prefix, options.renamedFrom);
    // `ignoreWhitespace` IS PART OF THE KEY, not a variation on one answer: the
    // two reads run different git commands and return different hunks for the
    // same path, so sharing a cache entry would serve whichever the reader
    // happened to ask for first and go on serving it after they flipped the
    // toggle — a toolbar control that works once per file per cache window.
    // `renamedFrom` IS PART OF THE KEY for the reason `ignoreWhitespace` is: it
    // changes the git command, so the two reads return different patches for
    // the same path — one of them saying the file is new.
    // `to` IS PART OF THE KEY for the reason every other option here is: it
    // changes the git command, so one path answers two different comparisons.
    const key = `patch:${cwd}:${baseRef ?? ""}:${options.to ?? ""}:${resolved}:${!!options.untracked}:${!!options.ignoreWhitespace}:${renamedFrom ?? ""}`;
    return this.cachedGitRead(key, () => sessionFilePatchAsync(this.asyncGit, {
      cwd,
      path: path.relative(cwd, resolved),
      ...(baseRef ? { baseRef } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(options.untracked ? { untracked: true } : {}),
      ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      ...(renamedFrom ? { renamedFrom } : {}),
    }));
  }

  /**
   * A second path on the same command line, fenced inside the same checkout —
   * or nothing. Refuses rather than dropping: a rename read with the old path
   * silently discarded is the very answer #694 is about, and it would then look
   * like the engine had simply not fixed it.
   */
  private static insideWorkspace(cwd: string, prefix: string, candidate?: string): string | undefined {
    if (!candidate?.trim()) return undefined;
    const resolved = path.resolve(cwd, candidate);
    if (!resolved.startsWith(prefix)) throw new EngineStateError("invalid_request", "that path is outside the workspace");
    return path.relative(cwd, resolved);
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
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
      throw new EngineStateError("invalid_request", "unknown provider driver");
    }
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
    const listed = driver === "claude" ? applyModelManifest(raw.models, this.manifest, raw.cliVersion) : raw.models;
    // Remembered from the PROVIDER's list, before the reader's overlay: hiding
    // a row in the picker is curation, not a statement about what the CLI runs.
    if (driver === "claude") this.rememberClaudeDefault(raw.models, raw.cliVersion);
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
    patch: { favorites?: unknown; hidden?: unknown; order?: unknown; custom?: unknown; default?: unknown },
  ): ModelOverlay {
    assertInstanceId(instanceId);
    const next: ModelOverlay = { ...this.getModelOverlay(instanceId), updatedAt: this.now() };
    for (const key of ["favorites", "hidden", "order"] as const) {
      if (patch[key] === undefined) continue;
      next[key] = readModelIds(patch[key], key);
    }
    if (patch.custom !== undefined) next.custom = readCustomModels(patch.custom);
    // `null` returns to Telar's own pick; a string must be a model id.
    if (patch.default === null) delete next.default;
    else if (patch.default !== undefined) next.default = readModelIds([patch.default], "default")[0]!;

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
  async cloneProject(input: { url: string; parent: string; name?: string }): Promise<Project> {
    // The MUTATION pool: a clone is minutes at worst, and it must neither hold
    // the thread nor a slot the rail's reads need.
    const outcome = await cloneRepository(this.worktreeGit, { url: input.url, parent: input.parent });
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
   * Post one comment, attributed to the session that wrote it — issue #791.
   *
   * ── THE SESSION ID IS READ OFF A CLAIM, NEVER OFF AN ARGUMENT ───────────────
   * This is the whole reason the write lives here rather than in a tool. `proof`
   * is the CLAIM of the turn doing the commenting — a session id, a run id and
   * the token this engine minted for that claim — and `requireSenderClaim` looks
   * it up and refuses unless it is live. The id that reaches the comment body is
   * the one the STORE found, not the one the caller named, so a model cannot
   * attribute its words to a session it is not. Identical in mechanism to
   * `submitAgentTurn`'s sender and to `Session.startedFrom`, deliberately: a
   * second way to prove who is speaking would be a second way to get it wrong.
   *
   * ── AND WHAT THIS DOES NOT PROVE ────────────────────────────────────────────
   * It binds the marker on comments that come through HERE. It cannot bind a
   * comment an agent posts by running `gh issue comment` in its own worktree,
   * which is how every agent comment in this repository is written today: that
   * body is typed by the model, and a model can type any marker, including one
   * it read off a public comment belonging to another session. The attribution
   * is therefore a CLAIM that is ordinarily true rather than a signature, and
   * `GitHubComment.attribution` says so to every reader. Nothing authorises on it.
   *
   * ── NO CACHE TO DROP, AND ONE TO ─────────────────────────────────────────────
   * The detail read carries the thread, so a comment that posted while the panel
   * holds a thirty-second-old copy would be invisible for the rest of that
   * window — the same staleness `projectPullMerge` refuses. The LIST is left
   * alone: a comment changes `updatedAt` and nothing a row renders.
   */
  async projectGitHubComment(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; body: string },
    proof: { sessionId: string; runId: string; claimToken: string },
  ): Promise<GitHubCommentResult> {
    const project = this.getProject(projectId);
    const target = this.forgeNumber(input.number);
    assertId(proof.sessionId, "sender session id");
    // Throws unless the claim is live and really is this session's. The id below
    // is the store's finding, not the caller's claim.
    const claimed = this.requireSenderClaim(proof);
    const result = await commentOn(this.gh, project.root, {
      kind: input.kind,
      number: target,
      body: input.body,
      sessionId: claimed.sessionId,
    });
    if (result.posted) this.githubDetailCache.delete(`${project.id}:${input.kind}:${target}`);
    return structuredClone(result);
  }

  /**
   * Snapshot the session's work as one commit.
   *
   * THE ONE GIT MUTATION THE ENGINE OFFERS. It is additive and reversible, a
   * human pressed it, and it runs in the session's own checkout — see
   * `commitSessionWork` for why staging, branch switching and discarding are
   * deliberately absent rather than pending.
   *
   * NOT `async`, so a bad message is refused before the first await. On the
   * MUTATION pool, like a cut: `add -A` and a pre-commit hook are seconds, and
   * the rail's reads must not queue behind them. What the commit changed is
   * dropped from the read cache — this is a write the store KNOWS about, and a
   * two-second-old "3 changed" beside a fresh commit is the badge lying.
   */
  commitSessionWork(sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    const session = this.getSession(sessionId);
    const text = message.trim();
    if (!text) throw new EngineStateError("invalid_request", "a commit message is required");
    if (text.length > 2_000) throw new EngineStateError("invalid_request", "commit message is too long");
    const cwd = workspaceRootOf(session);
    return commitSessionWork(this.worktreeGit, { cwd, message: text }).finally(() => this.forgetGitReadsUnder(cwd));
  }

  /**
   * Publish this session's branch — issue #670.
   *
   * ── THE BINDING IS THE STORE'S, NEVER THE CALLER'S ──────────────────────────
   * The checkout, the mode and the branch all come off the session record. A
   * request body that could name a branch could ask this engine to push any ref
   * in any repository on the machine, which is the same reason `sessionDiff`
   * takes no directory and `projectGitHubComment` takes no session id.
   *
   * ── ON THE MUTATION POOL, NOT THE READ POOL ─────────────────────────────────
   * `worktreeGit` has two slots against the read pool's four and is already the
   * home of the engine's other slow git children. A push is the slowest of them
   * and the only one whose clock is somebody's upload; putting it in the read
   * pool would let one person's first push of a large branch hold a quarter of
   * the capacity every rail poll draws from. It is bounded at
   * `PUSH_TIMEOUT_MS` so a slot cannot be held indefinitely.
   */
  async pushSessionBranch(sessionId: string): Promise<GitPushResult> {
    const session = this.getSession(sessionId);
    const workspace = session.workspace;
    if (workspace.mode === "none") throw new EngineStateError("invalid_request", "this session has no working directory");
    const cwd = workspaceRootOf(session);
    try {
      return structuredClone(
        await pushSessionBranch(this.worktreeGit, {
          cwd,
          mode: workspace.mode,
          ...(workspace.mode === "worktree" ? { branch: workspace.branch } : {}),
        }),
      );
    } finally {
      // Ahead/behind in the overview moved with the push.
      this.forgetGitReadsUnder(cwd);
    }
  }

  /**
   * Open a pull request for this session's branch — issue #670.
   *
   * ── IT REFUSES BEFORE `gh` IS ASKED, AND THAT IS THE POINT ──────────────────
   * The same local reads the push arm uses answer every question that can make
   * this impossible: not a repository, no origin, the wrong branch checked out,
   * and — the one only this arm cares about — a branch the remote has never
   * seen. Every one of those is a fact, so `gh` is not asked at all, which is
   * what makes a refusal here free and certain rather than a round trip and a
   * guess. `mergePull` decides four of its seven the same way.
   *
   * ── THE BASE IS A CHOICE AND THE HEAD IS NOT ────────────────────────────────
   * The head branch is the session's, read off the record. The base is genuinely
   * the reader's — "which branch should this merge into" has no answer the
   * engine can derive — so it is accepted, defaulted to the remote's own default
   * branch, and validated as a ref name. The validation is not decoration: this
   * value becomes an argv element, and a `--flag` arriving where `gh` expects a
   * branch is how a text field turns into a command.
   */
  async openSessionPullRequest(
    sessionId: string,
    input: { title: string; body?: string; base?: string },
  ): Promise<GitHubPullCreateResult> {
    const session = this.getSession(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") {
      return {
        opened: false,
        refusal: "not_pushed",
        message: "This session works in the project's own checkout, so it has no branch of its own to open a pull request for.",
      };
    }
    if (session.projectId === undefined) throw new EngineStateError("invalid_request", "this session has no project");
    const project = this.getProject(session.projectId);
    const cwd = workspaceRootOf(session);
    const branch = workspace.branch;

    const facts = await sessionBranchFacts(this.worktreeGit, cwd);
    const blocked = pullRequestBlockedBy(facts, branch);
    if (blocked) return { opened: false, refusal: "failed", message: blocked.message };
    if (facts.upstream !== true) {
      return {
        opened: false,
        refusal: "not_pushed",
        message: `origin has never seen ${branch}. Push it first, and this becomes available.`,
      };
    }

    const base = input.base?.trim() || (await this.defaultPullBase(project.root));
    if (!base) {
      return { opened: false, refusal: "failed", message: "This engine could not work out which branch to open the pull request against." };
    }
    if (!REF_NAME.test(base)) throw new EngineStateError("invalid_request", "that is not a branch name");

    const result = await openPullRequest(this.gh, cwd, {
      head: branch,
      base,
      title: input.title,
      body: input.body ?? "",
      sessionId: session.id,
    });
    // A new pull request belongs in the project's next forge read; the cached
    // list would otherwise not have it for the rest of its window — the same
    // staleness `projectPullMerge` refuses.
    if (result.opened) this.forgetGitHub(project.id);
    return structuredClone(result);
  }

  /** The remote's own default branch, unqualified — `origin/main` is what a
   *  worktree is cut from and `main` is what `gh pr create --base` takes. */
  private async defaultPullBase(projectRoot: string): Promise<string | undefined> {
    const listing = await listGitRefsAsync(this.worktreeGit, projectRoot);
    const qualified = await defaultRemoteBaseAsync(this.worktreeGit, projectRoot, listing);
    return qualified?.replace(/^origin\//, "");
  }

  /**
   * Every file in a project's own checkout, for the Files tree.
   *
   * PROJECT-SCOPED because a tree is a view of a place: the new-conversation
   * canvas has a project and no session, and the tree there is the same tree.
   */
  projectFilesAsync(projectId: string): Promise<WorkspaceListing> {
    const project = this.getProject(projectId);
    const cwd = project.root;
    return this.withAvailability(this.cachedGitRead(`files:${cwd}`, () => listWorkspaceFilesAsync(this.asyncGit, { cwd, now: this.now() })), project);
  }

  sessionFilesAsync(sessionId: string): Promise<WorkspaceListing> {
    const session = this.getSession(sessionId);
    const cwd = workspaceRootOf(session);
    return this.withAvailability(
      this.cachedGitRead(`files:${cwd}`, () => listWorkspaceFilesAsync(this.asyncGit, { cwd, now: this.now() })),
      this.projectOfSession(session),
    );
  }

  projectFileAsync(projectId: string, target: string): Promise<WorkspaceFile> {
    return this.readFencedAsync(this.getProject(projectId).root, target, "project");
  }

  sessionFileAsync(sessionId: string, target: string): Promise<WorkspaceFile> {
    return this.readFencedAsync(workspaceRootOf(this.getSession(sessionId)), target, "session workspace");
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
    return this.readFencedBytes(workspaceRootOf(this.getSession(sessionId)), target, "session workspace");
  }

  projectFile(projectId: string, target: string): WorkspaceFile {
    const project = this.getProject(projectId);
    return this.readFenced(project.root, target, "project");
  }

  sessionFile(sessionId: string, target: string): WorkspaceFile {
    const session = this.getSession(sessionId);
    return this.readFenced(workspaceRootOf(session), target, "session workspace");
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
    return this.writeFenced(workspaceRootOf(session), target, text, expected, "session workspace");
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

  /**
   * Run a synchronous store command with its git questions already answered
   * off the pool — see `prefetchedGit`. The answers live for exactly `work`:
   * it is synchronous, so nothing else can run while they are set.
   */
  private async withPrefetchedGit<T>(cwd: string, questions: string[][], work: () => T): Promise<T> {
    // De-duplicated BEFORE spawning: a default base is `rev-parse HEAD`, which a
    // local session's own base asks too.
    const unique = new Map(questions.map((args) => [prefetchKey(cwd, args), args]));
    const answers = new Map<string, GitResult>(
      await Promise.all([...unique].map(async ([key, args]) => [key, await this.asyncGit(cwd, args)] as const)),
    );
    this.prefetchedGit = answers;
    try {
      return work();
    } finally {
      this.prefetchedGit = undefined;
    }
  }

  /** The `rev-parse`s a worktree cut's refusals ask (`prepareSessionWorktree`). */
  private static cutQuestions(baseRef: string | undefined): string[][] {
    const base = prefetchableRef(baseRef);
    return [["rev-parse", "--is-inside-work-tree"], ...(base ? [["rev-parse", base]] : [])];
  }

  /**
   * `createSession` FOR THE REQUEST PATH — the same command, with its git
   * questions (`isGitWorkTree`, the cut's base, a local session's HEAD) read
   * through the pool first instead of on the engine's only thread. Measured on
   * an external disk: 2.4 s of a frozen daemon per new session, before this.
   *
   * A project that is not there skips the prefetch: `createSession` refuses it
   * before asking git anything, and asking git about an unplugged drive is the
   * thing #534 took out.
   */
  async createSessionAsync(input: Parameters<EngineStore["createSession"]>[0]): Promise<Session> {
    let project: Project | undefined;
    try {
      project = input.projectId === undefined ? undefined : this.getProject(input.projectId);
    } catch {
      // `createSession` refuses this itself, in its own order and words.
      return this.createSession(input);
    }
    if (project === undefined || this.projectAvailability(project) !== "available") return this.createSession(input);
    const questions = [...EngineStore.cutQuestions(input.baseRef), ["rev-parse", "HEAD"]];
    return this.withPrefetchedGit(project.root, questions, () => this.createSession(input));
  }

  /**
   * `submitTurn` FOR THE REQUEST PATH. Only the first send to a WORKTREE DRAFT
   * asks git anything — it promotes the draft and plans its cut — so every
   * other send is the synchronous command exactly as it was.
   */
  async submitTurnAsync(...args: Parameters<EngineStore["submitTurn"]>): Promise<ReturnType<EngineStore["submitTurn"]>> {
    return this.promotingDraft(args[0], () => this.submitTurn(...args));
  }

  /** `submitAgentTurn` for the request path and the `sessions` tools — an
   *  agent's message to a worktree draft promotes it exactly as a person's does. */
  async submitAgentTurnAsync(...args: Parameters<EngineStore["submitAgentTurn"]>): Promise<ReturnType<EngineStore["submitAgentTurn"]>> {
    return this.promotingDraft(args[0], () => this.submitAgentTurn(...args));
  }

  /**
   * Prefetch a worktree draft's cut questions, then run `work`. Anything that
   * is not a promotable draft — including a session that does not resolve — is
   * handed straight to `work`, so every refusal keeps its original order.
   */
  private async promotingDraft<T>(sessionId: string, work: () => T): Promise<T> {
    let root: string | undefined;
    let baseRef: string | undefined;
    try {
      const session = this.requireSession(sessionId);
      if (session.draft && session.envMode === "worktree" && session.projectId) {
        const project = this.getProject(session.projectId);
        if (this.projectAvailability(project) === "available") {
          root = project.root;
          baseRef = session.draft.baseRef;
        }
      }
    } catch {
      // Refused by `work` below, in its own words.
    }
    return root === undefined ? work() : this.withPrefetchedGit(root, EngineStore.cutQuestions(baseRef), work);
  }

  createSession(input: {
    draft?: boolean;
    id?: string;
    /**
     * WHICH PROJECT — and OPTIONAL since #526, which is the whole of what makes
     * a project-less session creatable rather than merely expressible.
     *
     * ABSENT IS A POSITIVE STATEMENT, the rule `Session.projectId` already
     * carries: this session belongs to no project, has no checkout, no branch
     * and no working directory. It is not "the caller forgot" and it is not
     * "the default project" — there is no such thing here.
     *
     * ONE THING FOLLOWS THAT CANNOT BE ASKED FOR: a worktree. A checkout is cut
     * FROM a repository, so a stated `envMode: "worktree"` with no project is
     * refused rather than quietly downgraded — the caller asked for something
     * this session cannot have, and silently giving it something else is how a
     * session ends up working in a directory nobody chose.
     */
    projectId?: string;
    /**
     * WHO STARTED THIS SESSION. Supplied by the daemon from the creating turn's
     * CLAIM TOKEN, never from a tool argument — see `Session.startedFrom`.
     * Permanent, and no lifetime or permission travels with it.
     */
    startedFrom?: { sessionId: string; runId?: string };
    /**
     * THE PRIVILEGE CEILING — a session id whose runtime mode this one may not
     * exceed (#541 G1). The owner's decision, in his words: a session created by
     * an agent must never have more permissions than its creator; if the creator
     * has to ask, the child asks too.
     *
     * A SESSION ID AND NOT A MODE, so nothing on the wire can WIDEN anything.
     * The engine reads the mode off the named session itself, and the ceiling is
     * a minimum against the posture below — so the worst a caller naming the
     * wrong session can do is give its new session LESS access than it meant to.
     * A mode on the wire would have been a number a caller could raise.
     *
     * READ ONCE, STORED NOWHERE. This is not `startedFrom`, whose note says no
     * permission travels with it, and that note stays true: there is no live
     * link here to widen later, and the creator changing its own mode afterwards
     * does nothing to a session already made.
     *
     * REFUSED RATHER THAN IGNORED when it names nothing readable. It is supplied
     * by engine code from a verified claim, never by a model, so an id that does
     * not resolve means something is wrong — and the failure mode of ignoring it
     * is the widest possible session, which is the one outcome this exists to
     * prevent.
     */
    ceilingFrom?: string;
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
     * shape on the wall carries it.
     */
    origin?: SessionOrigin;
  }): Session {
    if (input.id !== undefined) assertId(input.id, "session id");
    // Both reads are about a project, so both are skipped when there is none —
    // never replaced by a guess at which project was meant.
    const project = input.projectId === undefined ? undefined : this.getProject(input.projectId);
    if (input.projectId !== undefined) this.assertProjectAvailable(input.projectId);
    if (project === undefined && input.envMode === "worktree") {
      throw new EngineStateError("invalid_request", "a worktree is cut from a project, and this session has none");
    }
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
     * THE CEILING, RESOLVED BEFORE ANYTHING IS WRITTEN — issue #541 G1.
     *
     * THIS HONOURS THE COMMENT ABOVE RATHER THAN REPLACING IT. `detached` still
     * picks the POSTURE and is still not a mode a caller opts into; the ceiling
     * is a separate fact that can only narrow what that posture chose. Deriving
     * permissions from `detached` alone was what tied two unrelated concerns
     * together — "is anybody watching" and "what may this do" — and the fix is
     * to add the second rather than to overload the first.
     *
     * REFUSED, NOT IGNORED. See `ceilingFrom`: the failure mode of a silently
     * dropped ceiling is the widest session the engine can make.
     */
    const ceiling = input.ceilingFrom === undefined ? undefined : this.getSession(input.ceilingFrom).runtimeMode;
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
    /**
     * A PROJECT-LESS SESSION IS `local`, and the ladder is not consulted.
     *
     * `EnvMode` says where work LANDS, and its two answers are "the project's
     * own checkout" and "a checkout of this session's own". Neither is true
     * here, and the workspace below says so properly (`mode: "none"`); this
     * field takes the one value that claims nothing extra. Asking the standing
     * preference would let a machine-wide `worktree` turn into a refusal for a
     * session that never had a repository to cut from.
     */
    /**
     * THE LADDER NEVER ASKS GIT ABOUT A DISK THAT IS NOT THERE — issue #534.
     *
     * `assertProjectAvailable` above has already refused an unavailable project,
     * so by here the answer is `"available"` and this is the value the cut below
     * is handed rather than a second probe: one reading, one refusal, no chance
     * of the ladder and the guard disagreeing about a cable between two lines.
     *
     * AND THAT IS ALSO WHY THERE IS NO SILENT DOWNGRADE LEFT HERE. The fallback
     * to `local` exists for an UNVERSIONED project — a real directory with no
     * `.git` — and it was reachable by an unplugged one too, because
     * `isGitWorkTree` answers "not a repository" for a path it cannot read. That
     * turned a cable into a session quietly pointed at a dead path in a mode
     * nobody asked for. An unreadable project now never reaches this line.
     */
    const availability = project === undefined ? undefined : this.projectAvailability(project);
    const preferred = project === undefined ? "local" : (project.envMode ?? this.getSessionDefaults().envMode);
    const envMode =
      project === undefined ? "local" : (input.envMode ?? (preferred === "worktree" && isGitWorkTree(this.git, project.root) ? "worktree" : "local"));
    if (input.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@{}-]{0,200}$/.test(input.baseRef)) {
      throw new EngineStateError("invalid_request", "base ref is not a usable git ref name");
    }
    const chosen = input.providerInstanceId === undefined ? undefined : this.requireProviderInstance(input.providerInstanceId);
    const driver = chosen?.driver ?? input.driver ?? "claude";
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
      throw new EngineStateError("invalid_request", "unknown provider driver");
    }
    if (chosen && !chosen.enabled) throw new EngineStateError("conflict", "that provider instance is switched off");
    /**
     * THE WORKTREE IS PLANNED HERE AND CUT IN THE BACKGROUND — issue #496.
     *
     * It used to be cut right here, synchronously, "BEFORE the session document
     * is written" so that no session could exist without its workspace. That
     * ordering was right and its cost was the whole daemon: `git worktree add`
     * on a large checkout is seconds of a blocked event loop, and for those
     * seconds every cockpit's poll and every agent's stream stopped.
     *
     * WHAT SPLITS, AND WHERE THE LINE IS. Everything whose answer is a REFUSAL
     * stays on this call — a directory that is not a repository, a base ref that
     * does not resolve, a branch name the engine will not create. Those are bad
     * requests and the caller is still here to be told. What moves is the one
     * expensive step, `worktree add` itself, and its failures land on the row
     * (`SessionPreparation`) because by then there is nobody left to answer.
     *
     * THE ROW IS COMPLETE FROM THE FIRST INSTANT even so: the path and the
     * branch are decided by `planSessionWorktree` without touching git, so the
     * rail's most stable identifier is never the field that flickers. What is
     * missing for those seconds is the directory, and the row says so.
     */
    const cut =
      envMode === "worktree" && !input.draft && project !== undefined
        ? (() => {
            const branchSlug = input.branchSlug ?? derivedBranchFor(input.title ?? "", id);
            // The repository probe inside this is the same one the
            // omitted-`envMode` ladder above makes, and it has to be made
            // again: that one only runs when nobody stated a mode, and a
            // STATED `worktree` on an unversioned project must still refuse
            // rather than open a session with nowhere to work.
            return prepareSessionWorktree(this.git, {
              engineRoot: this.paths.root,
              projectRoot: project.root,
              projectName: project.name,
              sessionId: id,
              ...(availability !== undefined ? { availability } : {}),
              ...(branchSlug !== undefined ? { branchSlug } : {}),
              ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
              ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
            });
          })()
        : undefined;
    const workspace: Session["workspace"] =
      cut !== undefined
        ? // `baseRef` is stored NOW rather than when the cut lands: it is the
          // commit the checkout will start from, so a reader asking "what has
          // this session done" has its anchor from the first instant.
          { mode: "worktree" as const, path: cut.plan.path, branch: cut.plan.branch, baseRef: cut.baseSha }
        : project === undefined
          ? // NO PROJECT MEANS NO DIRECTORY — see `SessionWorkspace`'s `none`
            // variant. There is nothing to resolve a base against either: a
            // base is a commit, and there is no repository here.
            { mode: "none" as const }
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
      // Written only when there IS one. An explicit `undefined` would be a
      // second spelling of absent on a field whose absence is the statement.
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
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
      ...(project?.defaultModel && project.defaultModel.instanceId === (chosen?.id ?? defaultInstanceIdForDriver(driver))
        ? { model: project.defaultModel }
        : {}),
      workspace,
      // The directory is not there yet; `prepareWorktree` below clears this or
      // flips it to `failed`. Absent means ready, which is every other session.
      ...(cut !== undefined ? { preparation: { state: "preparing" as const, at } } : {}),
      envMode,
      ...(input.draft ? { draft: {
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.branchSlug ? { branchSlug: input.branchSlug } : {}),
      } } : {}),
      /**
       * THE POSTURE'S DEFAULT, CAPPED BY THE CREATOR'S OWN MODE — #541 G1.
       *
       * `sessions_create` parks for a person, so the gate was never bypassed.
       * What the approval SAID was the problem: a person approved "create a
       * session" and got "a session that will not ask again", because every
       * session an agent made landed in `auto` — file changes and commands
       * auto-accepted — regardless of what its creator was allowed to do.
       *
       * WITH NO CEILING THIS IS EXACTLY THE LINE IT WAS. A human's own click
       * has no creator to inherit from.
       */
      runtimeMode: (() => {
        const posture = detached ? DEFAULT_DETACHED_RUNTIME_MODE : DEFAULT_ATTENDED_RUNTIME_MODE;
        return ceiling === undefined ? posture : narrowerRuntimeMode(posture, ceiling);
      })(),
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
    // AFTER the document, never before: the flip this schedules writes the same
    // record, and a cut that finished first would be overwritten by the row that
    // said it had not started.
    if (cut !== undefined && project !== undefined) this.prepareWorktree(id, project.root, cut.plan, cut.baseSha);
    return structuredClone(session);
  }

  /**
   * Cut the checkout a `preparing` session is waiting for, then flip its row.
   *
   * NOT AWAITED BY ITS CALLER, which is the entire point of #496: `createSession`
   * returns the moment the row exists, and this runs on the queue behind it.
   * Every exit writes the row — there is no path that leaves a session
   * `preparing` forever except the daemon dying mid-cut, and a restart re-reads
   * a stale `preparing` it can see and act on.
   *
   * SERIALISED PER PROJECT by `worktreeQueue`, not by blocking. Two cuts at once
   * on one repository fight over the same index lock, which is why the
   * synchronous version was kept as long as it was; see `createWorktreeQueue`.
   */
  private prepareWorktree(sessionId: string, projectRoot: string, plan: WorktreePlan, baseSha: string): void {
    void this.worktreeQueue(projectRoot, async () => {
      try {
        await createSessionWorktreeAsync(this.worktreeGit, { engineRoot: this.paths.root, projectRoot, plan, baseSha });
        this.settleWorktree(sessionId, undefined);
      } catch (error) {
        // Git's own words, not ours — see `SessionPreparation.error`.
        this.settleWorktree(sessionId, error instanceof Error ? error.message : String(error));
      } finally {
        // A cut adds a branch and a worktree the project's overview lists.
        this.forgetGitReadsUnder(projectRoot);
        this.forgetGitReadsUnder(plan.path);
      }
    });
  }

  /**
   * Record how a cut ended, on whatever the row says NOW.
   *
   * RE-READ RATHER THAN CLOSED OVER. Seconds passed while git ran, and the
   * session may have been renamed, settled or paused in them; writing a record
   * captured before the cut would silently undo whatever happened during it.
   * A session deleted while its cut ran is not an error — there is simply
   * nothing left to flip, and the worktree the cut made is reaped like any
   * other orphan.
   */
  private settleWorktree(sessionId: string, failure: string | undefined): void {
    const existing = this.readDocument(sessionMetadataFile(this.paths, sessionId));
    if (existing === undefined) return;
    const session = parseSession(existing);
    const updated: Session = {
      ...session,
      // Absent is READY. A success clears the key rather than writing a third
      // state, so every reader's "is this ready" is one question.
      ...(failure === undefined ? {} : { preparation: { state: "failed" as const, error: failure, at: this.now() } }),
      updatedAt: this.now(),
    };
    if (failure === undefined) delete updated.preparation;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(updated));
    this.appendEvent(sessionId, { type: "session.updated", session: updated });
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
      /**
       * HOW OFTEN ROUTINE PEER REPORTS ARE DELIVERED — issue #723. `null` turns
       * the window off and returns the session to arrival delivery; a number of
       * minutes turns it on. Two answers plus "leave it alone", so not a
       * boolean and not a bare number.
       */
      reportWindowMinutes?: ReportCadence | null;
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
    /**
     * EITHER WAY, THE RECORDED WAKE GOES — issues #490, #586.
     *
     * `wokeAt` belongs to the snooze that produced it. Cancelling clears the
     * snooze, so there is nothing left for a wake to be about; setting a new one
     * starts a new sleep, and a stale wake sitting on the record would mean
     * `dueSnoozeWakes` never asks about this session again — the NEXT wake would
     * be the one that goes unannounced, which is precisely the defect.
     */
    if (patch.snoozedUntil !== undefined) {
      delete next.wokeAt;
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
    /**
     * THE REPORT WINDOW — issue #723.
     *
     * TURNING IT OFF DOES NOT DELIVER WHAT IS HELD, and that is deliberate
     * rather than an omission. The mailbox already has four drains and a sweep;
     * flushing here would mean a person adjusting a cadence setting hands the
     * session a turn it did not ask for, at the moment they were configuring it.
     * What was held stays held and goes out at the next drain — which, with the
     * window off, is the very next turn boundary.
     */
    if (patch.reportWindowMinutes !== undefined) {
      if (patch.reportWindowMinutes === null) {
        delete next.reportWindowMinutes;
      } else if (patch.reportWindowMinutes === HOLD_REPORTS) {
        /**
         * THE WINDOW THAT NEVER CLOSES — issue #784, step 2. Taken by value
         * rather than by a flag beside the number, so the three cadences stay
         * three answers to one question. See `ReportCadence` in the contract.
         */
        next.reportWindowMinutes = HOLD_REPORTS;
      } else {
        const minutes = Number(patch.reportWindowMinutes);
        if (!Number.isInteger(minutes) || minutes < MIN_REPORT_WINDOW_MINUTES || minutes > MAX_REPORT_WINDOW_MINUTES) {
          throw new EngineStateError(
            "invalid_request",
            `reportWindowMinutes must be "${HOLD_REPORTS}", or a whole number of minutes between ${MIN_REPORT_WINDOW_MINUTES} and ${MAX_REPORT_WINDOW_MINUTES}`,
          );
        }
        next.reportWindowMinutes = minutes;
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
      // Or a cancel on an already-woken row would clear the recorded wake in
      // `next` and then be dropped here as "nothing changed", leaving the stale
      // stamp on disk with no event to say it went.
      next.wokeAt === session.wokeAt &&
      next.resumeAfterRateLimit === session.resumeAfterRateLimit &&
      next.reportWindowMinutes === session.reportWindowMinutes &&
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
  async refreshWorktreeBranchFromTitle(sessionId: string): Promise<string | undefined> {
    const session = this.getSession(sessionId);
    if (session.state === "archived" || session.workspace.mode !== "worktree") return undefined;
    const current = session.workspace.branch;
    if (!current.startsWith("telar/")) return undefined;
    const next = derivedBranchFor(session.title, sessionId);
    if (next === undefined || next === current) return undefined;
    // On the mutation pool, never the thread: this runs behind every first turn.
    const renamed = await this.worktreeGit(session.workspace.path, ["branch", "-m", current, next]);
    if (renamed.status !== 0) return undefined;
    this.forgetGitReadsUnder(session.workspace.path);
    const projectRoot = this.projectOfSession(session)?.root;
    if (projectRoot) this.forgetGitReadsUnder(projectRoot);
    // RE-READ after the await: the record moved on while git ran, and writing
    // the copy from before it would undo whatever happened in between.
    const latest = this.getSession(sessionId);
    if (latest.workspace.mode !== "worktree" || latest.workspace.branch !== current) return undefined;
    const updated: Session = { ...latest, workspace: { ...latest.workspace, branch: next }, updatedAt: this.now() };
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
    return this.withActivity(structuredClone(this.requireSession(sessionId)));
  }

  /**
   * "DOES THIS SESSION EXIST" — WITHOUT FOLDING ITS ACTIVITY (#545).
   *
   * Fifteen methods called `getSession` and threw the answer away: `readEvents`,
   * `eventCursor`, `turns`, `items`, `tasks`, `requests`, `snapshotRequests`,
   * `snapshotWindow` and the attachment readers all wanted one thing from it —
   * a `not_found` when the id names nothing. Each was paying `withActivity` for
   * it, which is three more documents parsed (`queue.json`, `requests.json`,
   * `tasks.json`) to derive a pill the caller does not look at.
   *
   * IT ADDS UP ON THE PATH THAT MATTERS. `sessionSnapshot` makes SEVEN of those
   * calls for one cockpit read — the cursor, the turns, the items, the tasks,
   * the requests, the assignments and then the session itself — so a session
   * being opened folded its activity seven times and its queue was parsed once
   * per fold on top of the window read it actually wanted. On the running
   * daemon `readQueue` under `getSession` under `readEvents` alone was 1.5% of
   * an 8 s profile, beside 3.2% for `readRequests` on the same path.
   *
   * THE FAILURE IS IDENTICAL, which is what makes this safe to substitute: the
   * missing-document check and the metadata parse are both still here, so a
   * session that is absent or unreadable fails exactly as it did. Only the fold
   * is gone, and only where its result was discarded.
   */
  private requireSession(sessionId: string): Session {
    const stored = this.readDocument(sessionMetadataFile(this.paths, sessionId));
    if (stored === undefined) throw new EngineStateError("not_found", "session does not exist");
    return parseSession(stored);
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
    return this.withActivityFrom(session, this.readQueue(session.id).turns);
  }

  /**
   * THE SAME FOLD, OVER TURNS THE CALLER ALREADY HAS — issue #464.
   *
   * The live list read every session's queue TWICE in one pass: once here, for
   * the activity, and once in `sessionAssignments`, for who the session is
   * working for. Two sqlite reads, two `JSON.parse`s and two `TurnSchema`
   * validations of the same document, 291 times, every three seconds per
   * connected cockpit — and `readQueue` was already 43.9% of a profile taken at
   * rest for exactly this kind of repetition.
   *
   * SPLIT RATHER THAN CACHED, deliberately. `scanQueue`'s cache is bounded by
   * `liveQueueIndex` — the sessions that concern a worker — and routing this
   * fold through it would put EVERY conversation's parsed queue in memory for
   * the life of the daemon, which is the unbounded growth that cache was pruned
   * to avoid (the engine is already 563 MB resident). Sharing one read within
   * the pass costs nothing and keeps nothing.
   */
  private withActivityFrom(session: Session, turns: Turn[]): Session {
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
    // FROM THE INDEX, NOT THE DOCUMENT (#545): this fold runs per live session
    // per live-list read and per `getSession`, and the whole-history parse it
    // used to make was 3.7% + 3.2% of an idle daemon's profile.
    const open = [...this.liveRequests(session.id).values()].filter((request) => request.state === "open" && !settledRuns.has(request.runId));
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
   * blank a sidebar.
   */
  private readSessions(only?: Set<string>): Session[] {
    return (only ? [...only] : this.storedSessionIds())
      .flatMap((id) => {
        try {
          return [this.getSession(id)];
        } catch (error) {
          if (error instanceof EngineStateError && error.code === "not_found") return [];
          throw error;
        }
      })
      .sort(newestFirst);
  }

  /**
   * EVERY SESSION ID ON THIS ENGINE, whichever backend holds them.
   *
   * EXTRACTED so the enumeration is not written twice (#464): `readSessions`
   * above wants a whole record each, and `foldLiveSessions` wants to look at a
   * session's METADATA before deciding whether to pay for its queue. Both
   * agreed on the directory rules already; one of them agreeing by accident is
   * how they drift.
   */
  private storedSessionIds(): string[] {
    if (this.executionStore) return this.executionStore.sessionIds();
    try {
      return fs.readdirSync(this.paths.sessions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ID.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * THE LIVE LIST'S OWN PASS, WHICH READS EACH QUEUE ONCE — issue #464.
   *
   * It used to read every queue TWICE: `getSession` folded the activity out of
   * one read, and `sessionAssignments` folded the assignments out of a second
   * read of the same document, moments later. Two sqlite reads, two
   * `JSON.parse`s and two `TurnSchema` validations per session per pass, 291
   * times, every three seconds per connected cockpit.
   *
   * AND AN ARCHIVED SESSION COSTS NO QUEUE READ AT ALL. The old path folded the
   * activity of every session on the machine and then threw away everything not
   * `active` — which is an activity fold, over a whole queue, for a
   * conversation the answer does not contain. The state is in the metadata
   * document, so it is answerable before the expensive read rather than after.
   *
   * AN UNREADABLE SESSION IS SKIPPED, NOT THROWN, exactly as in `readSessions`:
   * one corrupt directory must not blank a sidebar.
   *
   * AND `only` NARROWS IT TO THE ROWS THE ANSWER WILL CONTAIN — issue #493. The
   * caller that has an index to decide from (`liveSessionRows`) knows which
   * sessions survive shelving before it reads a single document, so it names
   * them and this pays for those alone. On the owner's store that is seven of
   * 291. Absent, this is the pass over everything it has always been, which is
   * what the in-process `liveSessions` toolkit still wants.
   */
  private foldLiveSessions(only?: Set<string>): { sessions: Session[]; assignments: Record<string, SessionAssignment[]> } {
    const sessions: Session[] = [];
    const assignments: Record<string, SessionAssignment[]> = {};
    for (const id of only ?? this.storedSessionIds()) {
      const stored = this.readDocument(sessionMetadataFile(this.paths, id));
      if (stored === undefined) continue;
      let record: Session;
      try {
        record = parseSession(stored);
      } catch {
        continue;
      }
      if (record.state !== "active") continue;
      const turns = this.readQueue(id).turns;
      sessions.push(this.withActivityFrom(structuredClone(record), turns));
      // A PLAIN cast, for the reason `sessionAssignments` gives: the structural
      // type names fields a `Turn` really has, so a rename that breaks the fold
      // is a type error rather than an `undefined` on every assignment (#380).
      const held = assignmentsOf(turns as AssignmentTurn[]);
      if (held.length > 0) assignments[id] = held;
    }
    sessions.sort(newestFirst);
    return { sessions, assignments };
  }

  /**
   * WHICH ROWS THE RAIL WOULD DRAW, DECIDED WITHOUT READING A CONVERSATION —
   * issue #493.
   *
   * `undefined` when there is no index to decide from: a store on the JSON
   * backend has no `sessions` table, and the caller falls back to the fold over
   * everything that this replaces. That fallback is not dead code — it is the
   * reference the indexed path is measured against, and every test that
   * constructs a store without `executionStorage: "sqlite"` runs it.
   *
   * THE RULE IS THE SAME CALL, ON A NARROWER SHAPE. `rowIsShelved` hands the row
   * to `isShelved` — the clients' own function, imported — exactly as the
   * document path hands it a `Session`. If those two could disagree, the
   * disagreement would be a conversation that is on one device's list and on
   * another's shelf; they cannot, because there is one function and the row
   * carries the fields it reads.
   */
  private shelfFromIndex(inbox: InboxPolicy, all: boolean, keep?: string): { chosen: Set<string>; settledCount: number } | undefined {
    if (!this.executionStore) return undefined;
    // ONE CLOCK FOR THE WHOLE FOLD, and it is the STORE'S — see the document
    // path below for why a test's counting clock must not meet a wall clock here.
    const at = { now: this.now(), autoSettleAfterHours: inbox.autoSettleAfterHours };
    const chosen = new Set<string>();
    let settledCount = 0;
    // `liveSessions` carries the ACTIVE sessions and nothing else, so the read
    // seeks past the archived rows rather than folding and dropping them.
    for (const row of this.executionStore.liveSessionRows()) {
      if (row.id !== keep && rowIsShelved(row, at)) {
        settledCount += 1;
        if (!all) continue;
      }
      chosen.add(row.id);
    }
    return { chosen, settledCount };
  }

  listSessions(projectId: string): Session[] {
    this.getProject(projectId);
    /**
     * THE PROJECT'S OWN ROWS, BY THE INDEX THAT EXISTS FOR THEM — issue #493.
     *
     * This used to read EVERY session on the engine and throw away the ones
     * belonging to other projects: on the owner's store, 291 documents parsed to
     * answer a question about a handful. `(project_id, updated_at)` names them
     * without touching a document, and `readSessions` then pays for those alone.
     */
    const rows = this.executionStore?.projectSessionRows(projectId);
    if (rows) return this.readSessions(new Set(rows.map((row) => row.id)));
    return this.readSessions().filter((session) => session.projectId === projectId);
  }

  /**
   * WHEN EACH PROJECT WAS LAST WORKED IN — one integer per project, and not one
   * session (#490).
   *
   * THE FRONT DOOR'S WHOLE QUESTION. It was reading `liveSessions({ all: true })`
   * on every launch — 101.6 KB and 21.8 ms on the owner's store, 291 sessions —
   * to hand `composerProject` a list it immediately folded into
   * `Map<projectId, max(updatedAt)>` and read the top of. It renders NOTHING
   * from those rows: it is a blank frame and a redirect. This is that fold,
   * answered off the index rather than off the documents — see
   * `ExecutionStore.projectActivity` for which index the planner actually picks,
   * which is not the one you would guess.
   *
   * SAME POPULATION AS THE LIST IT REPLACES, which is the part that must not
   * drift: ACTIVE sessions only, so a project whose conversations are all
   * archived still scores nothing and falls through to most-recently-registered
   * (see `composerProject`); and no projectless session, which that fold skips
   * anyway.
   *
   * THE DOCUMENT FALLBACK IS THE REFERENCE, not dead code — a store on the JSON
   * backend has no `sessions` table, and every test that builds one without
   * `executionStorage: "sqlite"` runs it. It is the same fold, spelled over
   * records, and `session-index.test.ts` holds the two against each other.
   */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    const indexed = this.executionStore?.projectActivity();
    if (indexed) return indexed;
    const newest = new Map<string, number>();
    for (const session of this.readSessions()) {
      if (session.state !== "active" || !session.projectId) continue;
      if (session.updatedAt > (newest.get(session.projectId) ?? 0)) newest.set(session.projectId, session.updatedAt);
    }
    return [...newest].map(([projectId, updatedAt]) => ({ projectId, updatedAt }));
  }

  /**
   * EVERY LIVE SESSION ON THIS ENGINE, across every project, with the project
   * registry beside it.
   *
   * ONE READ AND NOT ONE PER PROJECT:
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
  liveSessions(only?: Set<string>): {
    sessions: Session[];
    /**
     * `availability` RIDES THE ROW — issue #534, and for `layout`'s reason. The
     * rail draws its "drive not connected" badge in the project group of THIS
     * list; without it here the sidebar would have to fetch `/v2/projects`
     * beside this on every pass, per paired host, for one enum per project.
     *
     * Absent on a removed project, which this list does not carry anyway.
     */
    projects: Array<{ id: string; name: string; availability?: ProjectAvailability }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
  } {
    const registry = this.readDocument(this.paths.projects);
    const projects = registry === undefined ? [] : parseRegistry(registry).projects;
    /**
     * ASSIGNMENTS RIDE THE LIST, not a fetch per row.
     *
     * The sidebar reads this one route each polling pass. Asking it to fetch
     * every session's full history to learn who each is working for would be an
     * N+1 over whole transcripts — the most expensive read in the engine,
     * repeated per session, per poll. One pass over the queues answers it here.
     *
     * AND IT IS ONE PASS NOW, rather than one for the activity and a second for
     * the assignments over the same documents (#464). See `foldLiveSessions`.
     */
    const { sessions, assignments } = this.foldLiveSessions(only);
    return {
      sessions,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        // Removed projects are in `projects` here (it is the raw registry), and
        // a put-away checkout is never probed — see `listProjects`.
        ...(project.removedAt === undefined ? { availability: this.projectAvailability(project) } : {}),
      })),
      assignments,
      layout: this.getSidebarLayout(),
    };
  }

  /**
   * THE SAME ANSWER, WITH ONLY WHAT A RAIL DRAWS ON EACH ROW — issue #459, and
   * the shape `GET /v2/sessions/live` serves.
   *
   * `liveSessions` above hands back whole `Session` records, which is right for
   * the in-process `sessions` toolkit: a model that lists conversations may then
   * ask any question about one. It is wrong for the wire. Measured on the
   * owner's store, that route answered 318 KB in 200 ms for 267 sessions, and
   * every cockpit asks for it on a timer, per paired host — so the engine was
   * serializing a session's provider instance, resume cursor, runtime mode and
   * un-settle ledger several times a second to clients that render none of them.
   * See `LiveSessionRow` for the field-by-field argument.
   *
   * THE PROJECTION IS THE ONLY DIFFERENCE to the rows. Same filter, same
   * ordering, same assignments, same layout — a caller that wants the old rows
   * asks the route with `?full=1` and gets `liveSessions()` verbatim.
   *
   * AND THE SETTLING WINDOW RIDES ALONG, for the reason `layout` does. A rail
   * bands every row by the policy of the engine those rows live on, so it was
   * fetching `/v2/inbox` beside this on every pass — a second request, per host,
   * per tick, for one number that changes when somebody opens Settings. It is
   * the same argument the arrangement makes: this is the read a rail is already
   * making, so anything the rail needs on every pass belongs on it.
   *
   * ══ AND BY DEFAULT IT IS ONLY THE UNSETTLED ROWS — issue #457 ══
   *
   * The lean row and the conditional cursor (#459) took this route off the
   * engine's floor for an IDLE cockpit. They did nothing for a cockpit that is
   * being used: every write bumps the revision, so a person typing in one
   * conversation makes every connected rail re-read all of them. Re-measured on
   * the owner's store at 276 KB and 2.33 s per full read, polled every three
   * seconds by each connected cockpit, with 291 sessions in the body — AND SEVEN
   * OF THEM NOT SETTLED. The other 284 were folded, projected and serialised so
   * that each rail could decide, again, to draw them on a shelf nobody had open.
   *
   * SO THE SHELF ASKS FOR ITSELF. `?all=1` is the whole list, and it is what the
   * cockpit sends when a reader opens Settled; the default is the rows a rail
   * actually draws. `settledCount` rides both answers because the shelf's HEADER
   * is drawn from the default one — a count is one integer, and without it the
   * affordance that asks for the rest would not be there to click.
   *
   * THE RULE IS THE CLIENTS' OWN, IMPORTED (`isShelved`), never a second fold
   * written here. A row this dropped and a rail would have drawn is a
   * conversation that is simply not in the list, with nothing on either side to
   * notice — which is the one failure this change could have, and the reason the
   * rule sits in the protocol package rather than in each of us.
   */
  liveSessionRows(options: { all?: boolean } = {}): {
    sessions: LiveSessionRow[];
    projects: Array<{ id: string; name: string }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
    inbox: InboxPolicy;
    revision: number;
    settledCount: number;
  } {
    /**
     * THE REVISION IS READ FIRST, so a write that lands mid-fold is reported by
     * the NEXT read rather than swallowed by this one. Taken after would name a
     * state this answer does not contain, and the client would hold a cursor
     * that says it is up to date with rows it never received.
     */
    const revision = this.sessionsRevision({ all: options.all === true });
    const inbox = this.getInboxPolicy();
    /**
     * NOTHING IS EXEMPTED FROM THE SHELF ANY MORE (#531).
     *
     * #522 kept the designated conversation on this list whatever the settling
     * clock said, because the rail drew its Main entry from a ROW here and a
     * time rule would have made that entry vanish on a Tuesday. The exemption
     * went with the designation, and every conversation now settles by the same
     * rule.
     */
    const indexed = this.shelfFromIndex(inbox, options.all === true);
    if (indexed) {
      /**
       * ══ THE INDEXED PATH — issue #493 ══
       *
       * The partition was decided above off `sessions` rows, so this reads
       * documents for the rows that SURVIVED it and for nothing else. On the
       * owner's store that is seven sessions rather than 291, and the 284 it
       * skips are the ones whose whole contribution to the old answer was
       * `settledCount += 1`.
       *
       * WHICH DOCUMENTS A SURVIVING ROW STILL COSTS: `session.json`, for the
       * payload the row deliberately does not carry (title, driver, model,
       * workspace, usage, `startedFrom`), and `queue.json`, for the assignments
       * — plus `requests.json` and `tasks.json`, which `withActivityFrom` reads
       * to re-derive the activity. The row's own activity is not trusted to
       * serve the wire: it is what the DECISION is made on, and a row a
       * downgrade left stale must not be able to put a wrong pill on a rail. It
       * can only put a row on the list that the fold then describes correctly.
       */
      const full = this.liveSessions(indexed.chosen);
      return {
        ...full,
        sessions: full.sessions.map(liveRow),
        inbox,
        revision,
        settledCount: indexed.settledCount,
      };
    }
    const full = this.liveSessions();
    /**
     * ONE CLOCK FOR THE WHOLE FOLD, and it is the STORE'S — `this.now()`, the
     * same clock that stamped every `updatedAt` this compares against. A test
     * driving a counting clock would otherwise measure its fixtures' staleness
     * against a wall clock and shelve all of them.
     */
    const at = { now: this.now(), autoSettleAfterHours: inbox.autoSettleAfterHours };
    const shelved = new Set<string>();
    for (const session of full.sessions) {
      /**
       * TWO FIELDS SPELLED THE RAIL'S WAY, and both are the projection
       * `toSidebarSession` already makes: `archived` is the `state` enum as the
       * boolean the rule reads, and `draft` is the PRESENCE of the draft record
       * (the engine stores a base-ref/branch object; the rail stores whether
       * there is one). Converting here is what lets the rule be one function.
       */
      const settleable = { ...session, archived: session.state === "archived", draft: session.draft !== undefined };
      if (isShelved(settleable, settlingActivityOf(session), at)) shelved.add(session.id);
    }
    const sessions = options.all === true ? full.sessions : full.sessions.filter((session) => !shelved.has(session.id));
    return {
      ...full,
      sessions: sessions.map(liveRow),
      // THE MAP FOLLOWS THE ROWS. An assignment is keyed by the session that
      // holds it, so an entry for a row this answer does not carry is bytes
      // describing a conversation the reader cannot see — and on the owner's
      // store the dropped 284 are most of them.
      assignments: options.all === true
        ? full.assignments
        : Object.fromEntries(Object.entries(full.assignments).filter(([id]) => !shelved.has(id))),
      inbox,
      revision,
      settledCount: shelved.size,
    };
  }

  turns(sessionId: string): Turn[] {
    this.requireSession(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  /**
   * ══ THE QUERY READS — issue #516 ══
   *
   * Five questions an orchestrator actually asks a conversation, each answered
   * from the projection or from one indexed span, none of them by folding the
   * journal. The bounds are stated in every answer rather than applied silently:
   * a caller that cannot tell what it did not get has to fetch everything to be
   * sure, which is the behaviour #515 exists to stop.
   *
   * SCROLL A CONVERSATION — the newest `limit` turns, keyset by sequence.
   *
   * `before` IS A SEQUENCE, so a live session being appended to underneath a
   * caller cannot shift the window; `more` is exact because one row past the
   * limit is read and dropped. A session with no rows yet (an engine that has
   * not run the backfill, a conversation written by an older binary) answers
   * with an empty page rather than folding events to fake one — see
   * `turnSummaryBackfill`.
   */
  turnOutline(sessionId: string, window: { limit: number; before?: number }): {
    turns: OutlineRow[];
    total: number;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.executionStore;
    /**
     * NO INDEX TO PAGE: fold the QUEUE, never the journal — `shelfFromIndex`'s
     * fallback, one projection over. A store on the JSON backend has no
     * `turn_summaries` table, and answering an empty outline for a conversation
     * that plainly has turns would be a wrong answer dressed as a cheap one. The
     * fold is over `queue.json`, which is the document the projection is derived
     * from anyway, so this route's one promise — that it does not replay events
     * — holds on both backends.
     */
    if (!store) {
      const all = this.readQueue(sessionId).turns;
      const above = window.before === undefined ? all : all.filter((turn) => turn.sequence < window.before!);
      const window_ = above.slice(-(window.limit + 1)).reverse();
      const rows = window_.map((turn) => outlineRow(summariseTurn(turn, this.itemsForRuns(sessionId, new Set([turn.runId])))));
      const turns = boundedOutline(rows, window.limit);
      const more = turns.length < rows.length;
      return { turns, total: all.length, more, ...(more ? { next: turns.at(-1)!.sequence } : {}) };
    }
    const read = store.outlineRows(sessionId, window.before, window.limit + 1);
    const page = boundedOutline(read.map(outlineRow), window.limit);
    const more = page.length < read.length;
    return {
      turns: page,
      total: store.turnSummaryCount(sessionId),
      more,
      ...(more ? { next: page.at(-1)!.sequence } : {}),
    };
  }

  /**
   * WHAT ONE RUN DID, AS A LIST TO CHOOSE FROM — `{index, id, title, status,
   * bytes}` per item, and nothing else.
   *
   * `bytes` IS THE POINT OF THE ROUTE. An agent picking a step to read should
   * know what it is about to spend before it spends it; without the number the
   * only way to find the big item is to fetch all of them, which is the cost
   * this is here to avoid.
   *
   * ONE INDEXED SPAN, not the session's timeline: the items index is keyed by
   * run, so this reads the bytes belonging to this turn and parses those.
   */
  runItems(sessionId: string, runId: string): Array<{ index: number; id: string; title: string; status: Item["status"]; bytes: number }> {
    this.assertSessionExists(sessionId);
    return this.runItemsInOrder(sessionId, runId).map((item, index) => ({
      index,
      id: item.id,
      title: firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS),
      status: item.status,
      bytes: Buffer.byteLength(JSON.stringify(item.detail), "utf8"),
    }));
  }

  /**
   * ONE STEP, WHOLE — up to `maxChars` of it, with the marker that says how much
   * was left.
   *
   * ADDRESSED BY POSITION, not by id alone, because the list above is what a
   * caller has just read and "the twelfth thing it did" is how an agent refers to
   * a step. An id is accepted too: an item named in a journal page is a thing a
   * caller already holds, and making it look up an index first would be a round
   * trip to translate a name into a number.
   *
   * THE DETAIL IS THE `text` AND IS NOT ALSO THE ITEM. Returning the whole `Item`
   * beside the clamped text carried `detail` twice, once bounded and once not —
   * which made this the one route here whose answer a caller could not predict.
   * The envelope is the scalars a reader identifies the step by; everything the
   * step actually SAID is in `text`, under `maxChars`, with its marker.
   */
  runItem(sessionId: string, runId: string, step: number | string, maxChars: number): {
    index: number;
    id: string;
    title: string;
    status: Item["status"];
    startedAt: number;
    completedAt?: number;
    taskId?: string;
    text: string;
    totalChars: number;
    more: boolean;
  } {
    this.assertSessionExists(sessionId);
    const items = this.runItemsInOrder(sessionId, runId);
    const index = typeof step === "number" ? step : items.findIndex((item) => item.id === step);
    const item = index >= 0 ? items[index] : undefined;
    if (!item) throw new EngineStateError("not_found", "that run has no such step");
    const text = JSON.stringify(item.detail, null, 2);
    return {
      index,
      id: item.id,
      title: firstLine(item.title ?? item.detail.type, ITEM_TITLE_CHARS),
      status: item.status,
      startedAt: item.startedAt,
      ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      text: text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters]`,
      totalChars: text.length,
      more: text.length > maxChars,
    };
  }

  /**
   * DOES THIS SESSION EXIST — without folding it to find out.
   *
   * `getSession` is the usual answer and it is the wrong one here: it calls
   * `withActivity`, which parses `queue.json` WHOLE to derive an activity none
   * of these routes report. On the dogfood store's largest session that is
   * 1.66 MB and 24 ms — a hundred times the read it was guarding, paid to
   * produce a 404 that never comes. The index row answers the same question by
   * primary key.
   *
   * THE DOCUMENT PATH IS STILL THE FALLBACK, for a store with no index (the
   * JSON backend), where there is nothing cheaper to ask.
   */
  private assertSessionExists(sessionId: string): void {
    if (!this.executionStore) { this.getSession(sessionId); return; }
    if (!this.executionStore.sessionRow(sessionId)) throw new EngineStateError("not_found", "session does not exist");
  }

  /**
   * ONE TURN, BY THE QUEUE'S OWN INDEX — `windowedTurns`' read, narrowed to a
   * single run.
   *
   * `/answer` needs `resultText`, which lives on the turn and nowhere else; it
   * must not cost the whole queue to reach. Without an index (a queue written
   * before #419, or edited behind the store's back) this is the parse it has
   * always been — slower, never wrong.
   */
  private turnByIndex(sessionId: string, runId: string): Turn | undefined {
    const file = sessionQueueFile(this.paths, sessionId);
    const index = this.documentIndex(file, sessionQueueIndexFile(this.paths, sessionId));
    if (!index) return this.readQueue(sessionId).turns.find((turn) => turn.runId === runId);
    const wanted = index.rows.filter((row) => row.key === runId);
    if (wanted.length === 0) return undefined;
    const parsed = TurnSchema.array().safeParse(this.readIndexedRows(file, wanted));
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return parsed.data.find((turn) => turn.runId === runId);
  }

  /** A run's items in the order they started — the order `index` counts in, and
   *  the only one stable enough for a caller to name a step by. */
  private runItemsInOrder(sessionId: string, runId: string): Item[] {
    return this.itemsForRuns(sessionId, new Set([runId])).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * THE ANSWER, AND ONLY THE ANSWER — sliced, with its true length beside it.
   *
   * The most common read an orchestrator makes, which is why it is its own verb
   * rather than a field of something larger: "what did it conclude" should not
   * cost a transcript. The text is on the turn already (`resultText`), so this is
   * one indexed span of `queue.json` and no journal at all.
   *
   * THE DEFAULT RUN IS THE LATEST TURN THAT LEFT TEXT, chosen from the
   * projection. Not simply the latest completed one: a turn can complete having
   * said nothing, and defaulting to it would answer an empty string to a caller
   * who asked what the session had concluded.
   */
  turnAnswer(sessionId: string, options: { runId?: string; from: number; limit: number }): {
    runId: string;
    sequence: number;
    text: string;
    from: number;
    totalChars: number;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.executionStore;
    const summary = options.runId === undefined
      ? store?.latestAnsweredTurn(sessionId)
      : store?.turnSummary(sessionId, options.runId);
    /**
     * NO INDEX TO ASK: fold the QUEUE, never the journal — `turnOutline`'s own
     * fallback, one projection over, and it is a CORRECTNESS fix rather than a
     * completeness one.
     *
     * Without this a JSON-backed store answered `TURN_ANSWER_NONE` for every
     * bare call, because the only thing that can name "the latest turn that
     * left text" is the projection and there is none. The sentence that miss
     * produces is "this session has never left an answer… do not ask it again"
     * — a closed door (#592, deliberately) in front of a session whose answer
     * is sitting in `queue.json`. A refusal that tells a model to stop asking
     * has to be true on every backend or it is worse than a slow answer.
     */
    const folded = options.runId === undefined && !store
      ? this.readQueue(sessionId).turns.filter((turn) => (turn.resultText ?? "").length > 0).at(-1)?.runId
      : undefined;
    const runId = options.runId ?? summary?.runId ?? folded;
    if (runId === undefined) throw new EngineStateError("not_found", TURN_ANSWER_NONE);
    const turn = this.turnByIndex(sessionId, runId);
    if (!turn) throw new EngineStateError("not_found", TURN_ANSWER_NO_SUCH_RUN);
    const answer = turn.resultText ?? "";
    const from = Math.min(Math.max(0, options.from), answer.length);
    const text = answer.slice(from, from + options.limit);
    const more = from + text.length < answer.length;
    return {
      runId,
      sequence: turn.sequence,
      text,
      from,
      totalChars: answer.length,
      more,
      ...(more ? { next: from + text.length } : {}),
    };
  }

  /**
   * WHERE A PHRASE APPEARS IN ONE CONVERSATION — the journal, newest first.
   *
   * THE ONE READ HERE THAT TOUCHES EVENTS, and the only one that could: a
   * projection small enough to be worth keeping cannot answer "where did it
   * mention index.lock". What makes it affordable is that the scan happens in
   * sqlite and only the matching page reaches JavaScript — see `grepEvents`.
   *
   * SUBSTRING, NOT A REGULAR EXPRESSION. `LIKE` is what sqlite can scan without
   * a user-defined function, a pattern compiled from a caller's text is a way to
   * hand the daemon an exponential backtrack, and "the phrase I remember seeing"
   * is what the verb is for.
   */
  grepSession(sessionId: string, pattern: string, window: { limit: number; before?: number }): {
    matches: Array<{ id: number; at: number; type: string; runId?: string; context: string }>;
    more: boolean;
    next?: number;
  } {
    this.assertSessionExists(sessionId);
    const store = this.executionStore;
    // REFUSED, NOT ANSWERED EMPTY. The JSON backend keeps its journal as a file
    // nothing can scan without reading it whole, which is the cost this route
    // exists to avoid — and "no matches" would be a lie a caller acts on.
    if (!store) throw new EngineStateError("conflict", "this engine's store cannot search a journal");
    const read = store.grepEvents(sessionId, pattern, window.before, window.limit + 1);
    const rows = read.length > window.limit ? read.slice(0, window.limit) : read;
    const more = read.length > window.limit;
    const needle = pattern.toLowerCase();
    const matches = rows.map((row) => {
      const at = row.value.toLowerCase().indexOf(needle);
      let event: { at?: number; type?: string; runId?: string } = {};
      try { event = JSON.parse(row.value) as typeof event; } catch {}
      return {
        id: row.id,
        at: Number(event.at ?? 0),
        type: String(event.type ?? "unknown"),
        ...(event.runId === undefined ? {} : { runId: String(event.runId) }),
        context: context(row.value, at < 0 ? 0 : at, GREP_CONTEXT_CHARS),
      };
    });
    return { matches, more, ...(more ? { next: rows.at(-1)!.id } : {}) };
  }

  /**
   * WHICH CONVERSATION WAS THIS — lexical, across every session on the engine.
   *
   * LEXICAL AND NOTHING ELSE. The issue is explicit that semantic ranking waits
   * for an embedding provider that is already configured, and there is none: a
   * new dependency to answer "which session was about the appearance rework"
   * would cost more than the question is worth. FTS5 when this sqlite has it,
   * a bounded `LIKE` over the same rows when it does not — `searchIndex` says
   * which, and the route reports it so a reader is never guessing.
   *
   * THE FILTERS ARE APPLIED TO ROWS, NEVER TO DOCUMENTS. `projectId`, `settled`
   * and `since` all read the #493 index, so narrowing a search costs nothing —
   * which is what lets the scan cap be generous enough to survive them.
   *
   * EVERY HIT QUOTES ITSELF. A `why` line is the difference between a list an
   * agent can choose from and one it has to open to evaluate.
   */
  findSessions(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit: number }): {
    sessions: Array<{ id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>;
    index: "fts5" | "like";
    more: boolean;
  } {
    const store = this.executionStore;
    // Refused for `grepSession`'s reason: a search across every conversation on
    // the machine is exactly the fold the index exists to replace.
    if (!store) throw new EngineStateError("conflict", "this engine's store cannot search across sessions");
    const terms = query.q.split(/\s+/).map((term) => term.trim()).filter(Boolean);
    const hits = store.searchTurnText(terms, FIND_SCAN);
    const at = { now: this.now(), autoSettleAfterHours: this.getInboxPolicy().autoSettleAfterHours };
    const chosen = new Map<string, { id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>();
    let more = false;
    for (const hit of hits) {
      if (chosen.has(hit.sessionId)) continue;
      const row = store.sessionRow(hit.sessionId);
      if (!row) continue;
      if (query.projectId !== undefined && row.projectId !== query.projectId) continue;
      if (query.since !== undefined && row.updatedAt < query.since) continue;
      if (query.settled !== undefined) {
        const shelved = row.state !== "active" || rowIsShelved(row, at);
        if (shelved !== query.settled) continue;
      }
      if (chosen.size >= query.limit) { more = true; break; }
      const line = hit.text.split("\n").find((candidate) => terms.some((term) => candidate.toLowerCase().includes(term.toLowerCase()))) ?? hit.text;
      chosen.set(hit.sessionId, {
        id: row.id,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
        activity: row.activity,
        updatedAt: row.updatedAt,
        ...(hit.runId ? { runId: hit.runId } : {}),
        why: firstLine(line, WHY_CHARS),
      });
    }
    return { sessions: [...chosen.values()], index: store.searchIndex, more };
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
   * (`SessionSyncEngine.swift`). The settled ones are bounded on top of the
   * window — see `SNAPSHOT_SETTLED_REQUESTS`, which is the half of #245 the
   * window alone did not reach.
   *
   * AND IT IS READ FROM THE TAIL, not filtered out of the whole history: see
   * `windowedTurns` and `windowedItems` (#419).
   */
  snapshotWindow(sessionId: string, window: { limit: number; before?: string }): {
    turns: Turn[];
    items: Item[];
    tasks: Task[];
    requests: EngineRequest[];
    page: { before: string | null; more: boolean };
  } {
    this.requireSession(sessionId);
    const plan = this.windowedTurns(sessionId, window);
    const chosen = new Set(plan.turns.map((turn) => turn.runId));
    return structuredClone({
      turns: plan.turns,
      items: this.windowedItems(sessionId, chosen),
      tasks: [...this.readTasks(sessionId).values()].filter((task) => chosen.has(task.runId)),
      requests: boundedRequests([...this.readRequests(sessionId).values()], chosen),
      page: plan.page,
    });
  }

  /**
   * The window's turns, from the tail of the queue rather than the whole of it.
   *
   * THE INDEX DECIDES WITHOUT READING. Which turns a window holds needs only
   * each turn's id and state, in order, and `queue.index.json` carries exactly
   * those — so the choosing is free and the reading is one span. Without an
   * index (a queue written by an older engine, or edited behind the store's
   * back) this is the fold it has always been, over a document parsed whole.
   */
  private windowedTurns(sessionId: string, window: { limit: number; before?: string }): { turns: Turn[]; page: { before: string | null; more: boolean } } {
    const file = sessionQueueFile(this.paths, sessionId);
    const index = this.documentIndex(file, sessionQueueIndexFile(this.paths, sessionId));
    if (!index) {
      // `readQueue` accounts for itself now (#547), so the explicit call that
      // used to be here would double this read.
      const all = this.readQueue(sessionId).turns;
      const plan = planWindow(all.map((turn) => ({ key: turn.runId, tag: turn.state })), window);
      return { turns: all.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
    }
    const plan = planWindow(index.rows, window);
    const span = this.readIndexedRows(file, index.rows.filter((row) => plan.chosen.has(row.key)));
    const parsed = TurnSchema.array().safeParse(span);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return { turns: parsed.data.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
  }

  /** The window's items, by the same route and for the same reason — and this
   *  is the big document: 753 KB of the dogfood store's 1.07 MB snapshot. */
  private windowedItems(sessionId: string, chosen: Set<string>): Item[] {
    // Already parsed and in hand: a streaming session is read once a second and
    // the cache is what that repetition is for. Nothing to save by seeking.
    if (this.itemsCache.has(sessionId)) return [...this.readItems(sessionId).values()].filter((item) => chosen.has(item.runId));
    // ON ROWS THE DATABASE CHOOSES (#658). `items_run` is `(session_id, run_id,
    // ord)`, so this is the window and only the window — no offset index, no
    // span, and nothing to keep in step with the document it describes.
    if (this.itemsOnRows(sessionId)) return this.itemRowsOf(sessionId, [...chosen]);
    const file = itemsFile(this.paths, sessionId);
    const index = this.documentIndex(file, itemsIndexFile(this.paths, sessionId));
    if (!index) {
      // `itemsById` counts this read itself now — see the note there.
      const all = [...this.readItems(sessionId).values()];
      return all.filter((item) => chosen.has(item.runId));
    }
    const span = this.readIndexedRows(file, index.rows.filter((row) => chosen.has(row.key)));
    const parsed = ItemSchema.array().safeParse(span);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return parsed.data.filter((item) => chosen.has(item.runId));
  }

  /**
   * The requests a snapshot carries when the caller asked for no window.
   *
   * Bounded for the same reason the windowed key is (#245) — see
   * `boundedRequests`. `requests()` stays whole: a tool asking what a session
   * has ever been asked is a different question from what a transcript renders.
   */
  snapshotRequests(sessionId: string): EngineRequest[] {
    this.requireSession(sessionId);
    return structuredClone(boundedRequests([...this.readRequests(sessionId).values()]));
  }

  items(sessionId: string): Item[] {
    this.requireSession(sessionId);
    return structuredClone([...this.readItems(sessionId).values()]);
  }

  tasks(sessionId: string): Task[] {
    this.requireSession(sessionId);
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
    this.requireSession(sessionId);
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
      /**
       * THIS TURN IS A NOTIFICATION, NOT WORDS — minted by `notification.ts`
       * for `submitAgentTurn` (a peer's message) and `fireSubscriptions` (a
       * wake, a parked request), and by nothing else.
       *
       * Its presence is what makes the engine write a `notification` item
       * instead of leaving the turn to be drawn as a bubble, and what tells the
       * drivers to deliver it off the user channel. See `Turn.notification`.
       */
      notification?: NotificationDetail;
      assignmentScope?: string;
      origin?: "session" | "schedule";
      wakeReason?: WakeReason;
      sender?: { sessionId?: string };
      /** A CLOCK started this turn — issue #543. See the origin enum. */
      scheduleOrigin?: { scheduleId: string; dueAt: number };
    },
  ): { turn: Turn; replayed: boolean } {
    assertId(input.runId, "run id");
    assertText(input.input);
    /**
     * EXACTLY ONE COMPANION, AND NOW THERE ARE THREE OF THEM — issue #543.
     *
     * A `session`-origin turn carries a wake reason or a sender; a `schedule`
     * one carries `scheduleOrigin`. WIDENED RATHER THAN BORROWED: a schedule is
     * not a session, so passing a fake `sender` to satisfy the old shape would
     * put every scheduled turn into the "who sent this" surfaces as a peer
     * message — a lie told to an invariant rather than a change to it.
     */
    const companions =
      Number(input.wakeReason !== undefined) + Number(input.sender !== undefined) + Number(input.scheduleOrigin !== undefined);
    const wants = input.origin === "session" || input.origin === "schedule" ? 1 : 0;
    if (companions !== wants) {
      throw new EngineStateError("invalid_request", "a session- or schedule-origin turn carries exactly one companion, and only such a turn does");
    }
    if (input.origin === "schedule" && input.scheduleOrigin === undefined) {
      throw new EngineStateError("invalid_request", "a schedule-origin turn names the schedule that started it");
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
    /**
     * A HUMAN STOP LATCHES OUT PEERS. The latch was written for a runaway
     * orchestrator: a person presses Stop, a coordinator two rooms away has not
     * noticed, and its next `sessions_send` restarts exactly the work that was
     * just ended. Nobody decided that, which is why it refuses — wake included.
     * Only a human message on the session itself clears it, below.
     */
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
      // A CLOCK STARTED THIS ONE (#543), named so a transcript can say why it
      // ran rather than drawing it as something a person typed.
      ...(input.origin === "schedule" && input.scheduleOrigin ? { origin: "schedule" as const, scheduleOrigin: input.scheduleOrigin } : {}),
      ...(input.agentIntent ? { agentIntent: input.agentIntent } : {}),
      ...(input.agentDelivery ? { agentDelivery: input.agentDelivery } : {}),
      ...(input.agentSourceRunId ? { agentSourceRunId: input.agentSourceRunId } : {}),
      ...(input.agentNotice ? { agentNotice: input.agentNotice } : {}),
      ...(input.notification ? { notification: input.notification } : {}),
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
    /** Scheduled after the document is written, never before — see `createSession`. */
    let cut: { projectRoot: string; plan: WorktreePlan; baseSha: string } | undefined;
    if (session.draft) {
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
      if (kind === "compact") throw new EngineStateError("conflict", "a browser draft has no conversation to compact");
      if (session.envMode === "worktree") {
        if (!session.projectId) throw new EngineStateError("conflict", "a worktree draft requires a project");
        const project = this.getProject(session.projectId);
        // Planned and refused here, cut in the background — `createSession`'s
        // split, for `createSession`'s reason. The turn this promotion belongs
        // to waits in the queue until the checkout lands; `claimTurn` is what
        // holds it, and the row says why.
        const planned = prepareSessionWorktree(this.git, {
          engineRoot: this.paths.root, projectRoot: project.root, projectName: project.name, sessionId,
          // The send that promotes a draft already went through
          // `assertProjectAvailable`, so this is that reading rather than a
          // second one — see the ladder in `createSession`.
          availability: this.projectAvailability(project),
          branchSlug: session.draft.branchSlug ?? derivedBranchFor(input.input, sessionId),
          ...(session.draft.baseRef ? { baseRef: session.draft.baseRef } : {}),
          ...(session.draft.branchName ? { branchName: session.draft.branchName } : {}),
        });
        session.workspace = { mode: "worktree", path: planned.plan.path, branch: planned.plan.branch, baseRef: planned.baseSha };
        session.preparation = { state: "preparing", at };
        cut = { projectRoot: project.root, ...planned };
      }
      if (session.title === "Browser draft") session.title = input.input.replace(/\s+/g, " ").slice(0, 80);
      delete session.draft;
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
      if (cut) this.prepareWorktree(sessionId, cut.projectRoot, cut.plan, cut.baseSha);
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
      delete session.agentMessagesBlockedAt;
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
      // The ROW is still written — a passive report reaches no model but it
      // does reach the transcript, and it is a notification there too.
      if (turn.notification) this.writeNotificationItem(sessionId, turn);
      /**
       * AND IT GOES IN THE MAILBOX, SO IT IS NOT LOST — issue #631 part 2.
       *
       * Passive is now only chosen when the recipient is BUSY or put away (see
       * `submitAgentTurn`), and a busy session's next idle moment is exactly
       * when held mail is meant to arrive. Holding it here puts a peer message
       * on the same path a `settled_only` wake has taken since #550: merged
       * with whatever else piled up, delivered as ONE turn by
       * `flushPendingNotifications` on the next `completeTurn`, `failTurn`,
       * `stopTurn` or `stopSession`.
       *
       * A SHELVED SESSION HOLDS IT INDEFINITELY, on purpose. The flush is
       * guarded on a live turn, not on a shelf, so the mail simply waits — and
       * `pendingNotifications` reports it to `sessions_status` meanwhile, which
       * is the poll a coordinator that cares already has.
       */
      if (turn.notification) this.holdNotification(sessionId, turn.notification);
      this.appendEvent(sessionId, { type: "turn.completed", resultText: "" }, turn.runId);
      return { turn: structuredClone(turn), replayed: false };
    }
    // A compaction is a gesture on the session, not words for the running
    // model; it always waits its turn.
    if (kind !== "compact" && !session.paused && PROVIDER_CAPABILITIES[session.driver].liveSteering) {
      const steered = this.steerIfRunning(sessionId, turn.runId);
      // A STEERED NOTIFICATION'S ROW IS THE DRIVER'S, not this one's. The turn
      // is being folded into a RUNNING one, so its row belongs on that turn's
      // timeline in the order the provider actually received it — which only
      // the seam that hands it over knows. See `onSteered` in the drivers.
      if (steered) return { turn: steered, replayed: false };
    }
    if (turn.notification) this.writeNotificationItem(sessionId, turn);
    return { turn: structuredClone(turn), replayed: false };
  }

  /**
   * THE NOTIFICATION'S ROW, WRITTEN AT ACCEPT — issue #550.
   *
   * WRITTEN BY THE ENGINE RATHER THAN A DRIVER, which is the difference between
   * this and every other item in the projection. A driver's rows are what a
   * provider did; this one is what ARRIVED, and it is true the moment the turn
   * is accepted — before any worker claims it, and whether or not one ever does.
   * A notification that only appeared once a provider got round to it would
   * leave a queued wake invisible in the transcript for as long as the session
   * was busy, which is exactly when a person is looking.
   *
   * OPENED AND CLOSED IN ONE BREATH. Nothing about an arrival is in progress.
   */
  private writeNotificationItem(sessionId: string, turn: Turn): void {
    const detail = turn.notification;
    if (!detail) return;
    const at = this.now();
    const items = this.readItems(sessionId);
    const item: Item = {
      // DERIVED FROM THE RUN, not random: `submitTurn` is idempotent on the run
      // id, and a replay that minted a second row would put two notifications
      // on one arrival.
      id: `notification_${turn.runId}`,
      runId: turn.runId,
      sessionId,
      status: "completed",
      title: detail.summary,
      detail: { type: "notification", notification: detail },
      startedAt: at,
      completedAt: at,
    };
    if (items.has(item.id)) return;
    items.set(item.id, item);
    this.writeItems(sessionId, items, new Set([item.id]));
    this.appendEvent(sessionId, { type: "item.started", item }, turn.runId);
    this.appendEvent(sessionId, { type: "item.completed", item }, turn.runId);
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
    proof?: SenderProof,
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
    /**
     * A PASSIVE MESSAGE TO AN IDLE SESSION IS A LOST MESSAGE — issue #631 part 2.
     *
     * `report` and an unawaited `result` wait for the recipient's next turn.
     * That is right while it is WORKING: a report is a peer talking, and
     * interrupting a coordinator mid-reasoning is the cost `passive` exists to
     * refuse. But a session that is idle and that nobody gives a turn to waits
     * FOREVER, and the wait is silent. It cost a real finding: a session had
     * measured that `git worktree lock` is mandatory for worktrees on removable
     * media — without it, unmounting makes git prune the registration and
     * destroy sessions — reported it, and the orchestrator never saw it while
     * another session built the feature without it. The sender could see the
     * message was going nowhere and sent it anyway, because passive was the
     * documented default.
     *
     * SO THE WAKE IS PAID ONLY WHERE THE MESSAGE WOULD OTHERWISE BE LOST. A
     * BUSY recipient is not woken and not steered — unchanged, and that is the
     * expensive case this whole mechanism exists for. An IDLE one takes the
     * message as a turn, which is the cheapest moment a turn can be paid: there
     * is no context in flight to interrupt, and since #631 the notice it opens
     * on is ~345 characters.
     *
     * AND NOT ON ARRIVAL ALONE, which is the version of this that fixes the
     * incident and not the class. Report #1 wakes an idle coordinator; report #2
     * lands while that turn runs, stays passive, and is dropped exactly as
     * before. So the held ones are delivered at the IDLE TRANSITION too — see
     * the passive branch of `submitTurn`, which hands them to the mailbox
     * `flushPendingNotifications` already drains on every `completeTurn`,
     * `failTurn`, `stopTurn` and `stopSession`. N messages arriving during one
     * long turn cost ONE wake carrying one merged notice, not N.
     *
     * A SHELVED OR SNOOZED SESSION IS NOT WOKEN, and that exclusion is
     * deliberate rather than an oversight. `wakeSessionForNewWork` treats new
     * work as the shelf lifting itself; a peer's routine report is not a person
     * changing their mind about a row they put away. Those sessions keep
     * today's behaviour — the message is recorded, the row is written, and the
     * session's own row carries it whenever the person comes back.
     */
    const shelved = this.getSession(sessionId);
    const wouldBeLost = !this.hasLiveTurn(sessionId) && shelved.settledOverride !== "settled" && shelved.snoozedUntil === undefined;
    /**
     * AND A RECIPIENT MAY ASK TO BE TOLD ON A CLOCK INSTEAD — issue #723.
     *
     * `wouldBeLost` above is what makes an idle recipient take a routine report
     * the moment it lands. That is right for one sender and unreadable for five:
     * a coordinator with five workers is woken five times, and the interleaving
     * is what made hand-run orchestration illegible rather than the per-message
     * cost. A window says "hold them and tell me together".
     *
     * IT ONLY WITHDRAWS THE `wouldBeLost` WAKE, and that is the whole change.
     * The message is not lost — it goes to the same mailbox a busy recipient's
     * does, and `sweepReportWindows` delivers the cohort when the window closes.
     * The other three clauses are untouched, so a `task`, a `blocker` and an
     * AWAITED `result` still wake a session that set a window: one is work
     * arriving, one is a peer asking for intervention now, and one is the event
     * this session called `sessions_subscribe` to be woken for.
     */
    const windowed = shelved.reportWindowMinutes !== undefined;
    const delivery = intent === "task" || intent === "blocker" || waiting || (wouldBeLost && !windowed) ? "wake" : "passive";
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
    /**
     * THE NOTICE AND THE NOTIFICATION ARE ONE STRING NOW (#550).
     *
     * `agentNotice` used to be minted here and the row, the prompt and a later
     * `sessions_read` all quoted it. The notification carries the same text on
     * `body` — so it is minted ONCE, in `notification.ts`, and `agentNotice` is
     * DERIVED from it rather than computed a second time from the same inputs.
     * Two mints of one sentence is two sentences waiting to disagree, and the
     * contract's whole claim about this field is that they cannot.
     */
    const notification = peerNotification({
      recipientSessionId: sessionId, runId: input.runId, body: input.input, intent,
      ...(sender.sessionId ? { sender } : {}),
      ...(scope ? { scope } : {}),
    });
    const result = this.submitTurn(sessionId, {
      runId: input.runId,
      /**
       * THE BODY STAYS ON THE TURN, EXACTLY AS SENT. A wake's and a request's
       * prose is the engine's and moves onto the notification, but this is the
       * only copy of what the peer actually wrote: `sessions_read` hands it back
       * whole and the transcript expands to it. What CHANGED is that nothing
       * draws it as the person's words or hands it to a model as one.
       */
      input: input.input,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      origin: "session", sender, agentIntent: intent, agentDelivery: delivery,
      ...(proof ? { agentSourceRunId: proof.runId } : {}),
      notification,
      agentNotice: notification.body,
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
    /**
     * NEITHER DOES ONE WHOSE CHECKOUT IS NOT THERE — #496.
     *
     * The cut runs in the background now, so an agent that creates a session
     * and sends to it in the same breath can have a turn queued before the
     * directory exists. Dispatching it would spawn a provider process with its
     * cwd set to a path nothing has made yet.
     *
     * BOTH STATES REFUSE THE CLAIM, AND THEY MEAN DIFFERENT THINGS — #813.
     *
     * `preparing` is a wait: the cut is running and the turn keeps its place.
     * `failed` is not, and treating it as one is the defect this issue is
     * about. A failed session has no checkout and is not going to grow one, so
     * its turn waited forever while the row carried git's reason — for 45
     * minutes, with every surface an agent could read still saying `running`.
     *
     * THE ACTING SPLIT IS IN `claimNextTurn`, not here, and deliberately: this
     * method may not write a queue it was not given, and the scan is already
     * the one place that fails a turn nothing can claim (see the Claude-model
     * branch beside it). This stays a refusal for both, as the backstop for a
     * direct caller that never went through the scan.
     */
    if (this.getSession(sessionId).preparation) return undefined;
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
   * THE CLAUDE CONFIG DIRECTORY A SESSION'S TURNS ACTUALLY RUN WITH.
   *
   * Resolved the way the CHILD resolves it, not the way the engine does: the
   * instance's patch is applied over this process's environment, and a patch
   * that DELETES `CLAUDE_CONFIG_DIR` (every configured login scrubs it before
   * setting its own) means the default location even when the engine itself
   * inherited one. Anything less is the near-miss #616 records — an adoption
   * cut from the wrong person's history, or from a store the resumed turn will
   * never look in.
   */
  private claudeConfigDirFor(session: Session): string | undefined {
    return this.claudeConfigDirForInstance(this.resolveProviderInstance(session.providerInstanceId, session.driver));
  }

  private claudeConfigDirForInstance(instance: ProviderInstance): string | undefined {
    const patch = providerProcessEnv(instance);
    if (Object.hasOwn(patch, "CLAUDE_CONFIG_DIR")) return patch.CLAUDE_CONFIG_DIR?.trim() || undefined;
    return process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;
  }

  /**
   * WHERE ADOPTED FORKS LIVE — under the engine root, because the engine owns
   * that directory and knows where it is. Derived HERE and passed to both the
   * fork and the listing, so "we relocated it there" and "a fork there is ours
   * already" can never be two different answers.
   */
  private adoptedForkHome(): string {
    return path.join(this.paths.root, "adopted");
  }

  /**
   * The conversations a LOGIN could adopt.
   *
   * SCOPED TO AN INSTANCE RATHER THAN A SESSION, which is the same shape
   * `projectSkills` takes and for the same reason: the picker runs on a canvas,
   * before the session it would adopt into exists (#500's lesson, #616's
   * picker). Scoping it to a session would have made "show me my
   * conversations" require first creating a session to throw away if the person
   * picked none.
   *
   * IT IS STILL A LOGIN'S QUESTION, not the machine's. A configured instance
   * keeps its own config directory with its own history in it, so the answer
   * differs per login, and an absent id means the built-in slot — Claude's own
   * default location, which is where a terminal `claude` writes.
   */
  async listAdoptableClaudeConversations(
    options: { instanceId?: string; cwd?: string; limit?: number } = {},
  ): Promise<ClaudeConversation[]> {
    const instance = this.resolveProviderInstance(options.instanceId ?? defaultInstanceIdForDriver("claude"), "claude");
    if (instance.driver !== "claude") {
      throw new EngineStateError("invalid_request", "only a Claude login has Claude Code conversations");
    }
    const configDir = this.claudeConfigDirForInstance(instance);
    return listAdoptableConversations({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(configDir ? { configDir } : {}),
      forkHome: this.adoptedForkHome(),
    });
  }

  /**
   * ADOPT A CLAUDE CODE CONVERSATION INTO THIS SESSION — `/resume`, #616.
   *
   * Three writes, in one breath, and each is load-bearing:
   *
   *   1. `resumeCursor` becomes the FORK's id, so the session's next turn
   *      continues that conversation. This is the half that makes the feature a
   *      continuation rather than a rendering of somebody's old text.
   *   2. One turn of `kind: "import"`, holding the imported history as its
   *      items. A turn, because the cockpit's fold drops any item whose runId
   *      names no turn — silently — and `import`, because nobody typed it.
   *   3. The provenance row FIRST among those items, because the CLI records
   *      nothing about a fork's origin and this is the only chance to write it.
   *
   * REFUSED ON A SESSION THAT HAS ALREADY SPOKEN. Adopting into a conversation
   * that is already under way would splice two histories that never met: the
   * cursor would jump to the fork mid-thread, so the model would stop
   * remembering everything this session had actually done, while the transcript
   * went on showing it. `/resume` is for a NEW session, and this is where that
   * is enforced rather than hoped for.
   */
  async adoptClaudeConversation(
    sessionId: string,
    input: { sourceSessionId: string; cut?: ForkCut; sourceCwd?: string; maxRows?: number },
  ): Promise<{ session: Session; turn: Turn; provenance: ConversationImportDetail }> {
    const session = this.getSession(sessionId);
    if (session.driver !== "claude") {
      throw new EngineStateError("invalid_request", "only a Claude session can adopt a Claude Code conversation");
    }
    const queue = this.readQueue(sessionId);
    if (queue.turns.length > 0 || session.resumeCursor) {
      throw new EngineStateError(
        "conflict",
        "this session has already started a conversation — adopt into a new session instead",
      );
    }
    let adoption: Adoption;
    try {
      adoption = await adoptClaudeConversation({
        sourceSessionId: input.sourceSessionId,
        // The fork's title, and the one thing that keeps it apart from its
        // parent in any list that shows both.
        title: session.title,
        ...(input.cut ? { cut: input.cut } : {}),
        ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
        ...((dir) => (dir ? { configDir: dir } : {}))(this.claudeConfigDirFor(session)),
        forkHome: this.adoptedForkHome(),
      });
    } catch (error) {
      // The module's own sentences — "No conversation found with session ID",
      // and the untouched-original refusal — are what #616 asks be forwarded
      // rather than turned into a stack trace.
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }

    const at = this.now();
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    const turn: Turn = {
      runId,
      sessionId,
      sequence: queue.nextSequence++,
      // NOT the person's words, and `kind` is what says so structurally. This
      // is the line `sessions_read`'s fold and every list view show.
      input: describeAdoption(adoption.provenance).slice(0, MAX_TEXT_LENGTH),
      kind: "import",
      state: "completed",
      acceptedAt: at,
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      // The continuity this adoption produced, on the turn that produced it —
      // the same field a real turn writes, so recovery heals from either.
      providerSessionId: adoption.fork.sessionId,
      resultText: describeImport(adoption.read),
    };
    queue.turns.push(turn);
    this.writeQueue(sessionId, queue);

    const items = this.readItems(sessionId);
    const stamp: Item = {
      id: `import_${runId}`,
      runId,
      sessionId,
      status: "completed",
      title: describeAdoption(adoption.provenance),
      detail: { type: "conversation_import", import: adoption.provenance },
      startedAt: at,
      completedAt: at,
    };
    items.set(stamp.id, stamp);
    const written: Item[] = [stamp];
    /**
     * THE HISTORY, IN ORDER, ON ONE TURN. Ids are derived from the run and the
     * row's index rather than minted at random, so an adoption retried after a
     * crash between the queue write and the item write replaces its own rows
     * instead of doubling them.
     */
    adoption.rows.forEach((row, index) => {
      const item: Item = {
        id: `imported_${runId}_${index}`,
        runId,
        sessionId,
        status: row.status,
        ...(row.title ? { title: row.title } : {}),
        detail: row.detail,
        startedAt: row.startedAt,
        ...(row.completedAt !== undefined ? { completedAt: row.completedAt } : {}),
        providerRefs: row.providerRefs,
        imported: true,
      };
      items.set(item.id, item);
      written.push(item);
    });
    this.writeItems(sessionId, items, new Set(written.map((row) => row.id)));

    this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, runId);
    for (const item of written) {
      this.appendEvent(sessionId, { type: "item.started", item }, runId);
      this.appendEvent(sessionId, { type: "item.completed", item }, runId);
    }
    this.appendEvent(sessionId, { type: "turn.completed", resultText: turn.resultText ?? "" }, runId);

    // LAST, and through the same door a completed turn uses: the cursor is what
    // makes the next turn a continuation, and writing it before the rows would
    // leave a crash in between with a session that resumes a history it does
    // not show.
    this.touchSession(sessionId, at, adoption.fork.sessionId);
    return { session: this.getSession(sessionId), turn: structuredClone(turn), provenance: adoption.provenance };
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
    this.requireSession(sessionId);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "task observations are invalid");
    const tasks = this.readTasks(sessionId);
    const projection = { items: this.readItems(sessionId), tasks, itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
    let accepted = 0;
    for (const observation of parsed.data) {
      /**
       * THE ONE OBSERVATION THAT NEEDS NO ROW TO LAND ON. A task report folds
       * onto a stored row and is dropped when there is none; a runtime warning
       * is about the PROCESS, and the case that produces it between turns
       * (#465: the CLI died with background shells inside it) is precisely the
       * one where those rows are about to stop meaning anything. Journalled at
       * the session level — there is no live run out here to stamp it with.
       */
      if (observation.kind === "runtime.warning") {
        this.appendEvent(sessionId, { type: "runtime.warning", message: observation.message });
        accepted += 1;
        continue;
      }
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
   *  a claim, because there is deliberately no worker involved.
   *
   *  THE CODE IS THE CALLER'S, defaulting to the one this method was written
   *  for. #813 added a second caller whose failure has nothing to do with a
   *  provider, and a shared `provider_unavailable` would have told a reader to
   *  wait out an outage that is not happening. */
  private failQueuedTurn(
    sessionId: string,
    queue: SessionQueue,
    turn: Turn,
    message: string,
    code: TurnFailureCode = "provider_unavailable",
  ): void {
    const at = this.now();
    turn.state = "failed";
    turn.completedAt = at;
    turn.updatedAt = at;
    turn.failure = { code, message };
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
    /**
     * AND ANYTHING HELD FOR THIS SESSION IS NOW DELIVERABLE — #550.
     *
     * The turn that just ended was the reason a wake was held; ending it is the
     * moment "not now" becomes "now". Placed AFTER `fireSubscriptions` so the
     * flush sees a settled queue, and it is a no-op when the box is empty or a
     * follow-up turn is already live.
     */
    this.flushPendingNotifications(sessionId);
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

  /** What the newest journal record naming this run said, falling back through
   *  the durable copy to the turn's own start. The ledger is keyed by session
   *  and carries its run, so an earlier run's stamp is never read as this
   *  one's — see `runProgress`. */
  private lastProgressOf(sessionId: string, turn: Turn): number {
    const seen = this.runProgress.get(sessionId);
    if (seen?.runId === turn.runId) return seen.at;
    return turn.lastProgressAt ?? turn.startedAt ?? turn.claim?.at ?? turn.acceptedAt;
  }

  /**
   * SAY WHEN A RUNNING TURN HAS GONE QUIET — issue #813, and the read half of
   * `runProgress`.
   *
   * IT KILLS NOTHING. The verdict is `Turn.stalled`, an advisory on a turn that
   * stays `running`, and it is withdrawn the moment evidence arrives again.
   * Every mechanism that could ACT on a guess about liveness has been wrong at
   * least once in this repository's history (see `runProgress`), so this one
   * reports and stops there.
   *
   * HERE, BESIDE `sweepRateLimited`, FOR THE REASON THAT ONE GIVES: this is
   * already the engine's only periodic pass over live queues, and a second
   * scheduler would be a second thing to start, stop and get wrong at shutdown.
   *
   * CHEAP ON THE COMMON PATH, and it has two cheap paths rather than one. A
   * session with nothing running costs one `some()`. A session that IS running
   * costs a subtraction, and writes only when the verdict changes or when the
   * durable stamp has drifted more than `PROGRESS_STAMP_MS` behind the ledger —
   * so a busy session pays one queue write a minute rather than one per
   * streamed token-chunk, which is what folding this in at the append would be.
   *
   * NOTHING IS JOURNALLED HERE, deliberately, and not only for the bytes: an
   * event naming this run would be evidence of the run's own progress by this
   * very method's definition, and the flag would clear itself on the next tick.
   * `writeQueue` announces the change, which is how every client already hears
   * about a queue.
   */
  private sweepStalledTurns(sessionId: string): void {
    const scan = this.scanQueue(sessionId);
    if (!scan.turns.some((turn) => turn.state === "running")) return;
    const at = this.now();
    const verdicts = scan.turns
      .filter((turn) => turn.state === "running")
      .map((turn) => {
        const since = this.lastProgressOf(sessionId, turn);
        return {
          runId: turn.runId,
          since,
          stalled: at - since >= STALLED_AFTER_MS,
          was: turn.stalled !== undefined,
          drifted: since - (turn.lastProgressAt ?? 0) >= PROGRESS_STAMP_MS,
        };
      });
    if (!verdicts.some((verdict) => verdict.stalled !== verdict.was || verdict.drifted)) return;
    // Writes, so a queue of its own rather than the copy every other reader is
    // sharing — `sweepRateLimited` immediately above does the same.
    const own = this.readQueue(sessionId);
    for (const verdict of verdicts) {
      const turn = own.turns.find((candidate) => candidate.runId === verdict.runId);
      // Re-read rather than trusted: the scan copy was taken before this call
      // and a turn that has settled since must not be marked stalled on its way
      // out. The same argument `settleWorktree`'s header makes.
      if (!turn || turn.state !== "running") continue;
      turn.lastProgressAt = verdict.since;
      if (verdict.stalled) turn.stalled = { since: verdict.since, noticedAt: turn.stalled?.noticedAt ?? at };
      else delete turn.stalled;
    }
    this.writeQueue(sessionId, own);
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
      /**
       * AND THE LIVENESS SWEEP, for the same reason and in the same place
       * (#813). It is the only pass that visits every live queue on a clock,
       * and a turn that has gone quiet is exactly what nothing else here would
       * ever notice — a running turn is `continue`d a few lines below, so
       * BEFORE that skip rather than after it.
       */
      this.sweepStalledTurns(sessionId);
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
       * A CUT STILL RUNNING IS A WAIT; A CUT THAT FAILED IS NOT — #813.
       *
       * `preparing` keeps #496's behaviour exactly: the turn holds its place
       * in order while the checkout is made, because a message is not lost by
       * waiting and a turn dispatched into a directory nothing has made yet
       * is. It is seconds, and it ends.
       *
       * `failed` never ends. The session has no checkout and nothing is going
       * to give it one, so the turn sat `queued` — and `sessions_status` read
       * `running: true` over the top of it, which is how #813's coordinator
       * spent 45 minutes believing work was in flight. It fails here, the same
       * way and in the same place as a Claude turn whose window cannot be
       * resolved, carrying git's own sentence about what went wrong.
       */
      if (session.preparation?.state === "preparing") continue;
      if (session.preparation?.state === "failed") {
        // Writes, so it takes a queue of its own rather than editing the copy
        // every other reader is sharing — see the `selection === "failed"`
        // branch below, which is the same shape for the same reason.
        const own = this.readQueue(sessionId);
        const failing = own.turns.find((candidate) => candidate.runId === next.runId);
        if (failing) {
          this.failQueuedTurn(
            sessionId,
            own,
            failing,
            // GIT'S OWN WORDS FIRST. `preparation.error` is what the cut said
            // and it is the only part of this a person can act on; the rest
            // says what the engine did and did not do with it.
            `This session's checkout could not be created, so nothing can run in it. Git said: ${
              session.preparation.error ?? "no reason was recorded"
            }. Nothing was sent to a provider. Fix the checkout — or make a new session — and send again.`,
            "workspace_unavailable",
          );
        }
        continue;
      }
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
      /**
       * A SESSION ON THE DRIVER THAT NO LONGER EXISTS IS REFUSED, ONCE (#531).
       *
       * The owner confirmed no `telar`-driver session exists on any store, so
       * there is no migration and this is not one — it is the refusal that
       * makes that confirmation safe to have acted on. Checked BEFORE the claim
       * so nothing is marked running, and the turn is left queued rather than
       * failed: if such a session somehow exists, the person still has their
       * conversation and a later Telar can decide what to do with it.
       *
       * ONE LOG LINE, and not per scan — `warnedLegacyDriver` is what keeps a
       * refused session from writing a line every time a worker polls.
       */
      const candidateSession = this.getSession(candidate.sessionId);
      if ((candidateSession.driver as string) === "telar") {
        if (!this.warnedLegacyDriver.has(candidate.sessionId)) {
          this.warnedLegacyDriver.add(candidate.sessionId);
          console.error(`[telar] session ${candidate.sessionId} runs on the removed "telar" driver and will not be claimed (#531).`);
        }
        continue;
      }
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
       * TELAR'S OWN COMPUTER USE (cua-driver). A claim asks the daemon's gate,
       * but the answer comes from the LAST PROBE, never one run here: only a
       * measured `granted` resolves. Removing the driver applies to the next
       * turn; a newly installed one is not injected until it is measured (the
       * settings pane, or Test access). Goes to every provider Telar drives — Codex included
       * since #521, where withholding it turned out to leave those sessions
       * with no desktop at all rather than with their own — see
       * `withComputerUse`.
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
        // Emitted only when the session HAS one — see `WorkerClaim.projectRoot`.
        // A `none` workspace sends nothing rather than a path nobody chose.
        ...(workspacePath(session.workspace) ? { projectRoot: workspacePath(session.workspace)! } : {}),
        ...(session.projectId ? { projectId: session.projectId } : {}),
        /**
         * WHAT MAKES `projectRoot` ABOVE A WORKTREE — issue #641, and resolved
         * here for the reason everything else on this claim is: the worker holds
         * no store handle, and "is that path a worktree, and whose" is a store
         * question. Both facts or neither: a branch with no repository root
         * still cannot tell the worker that the PROJECT is fine.
         */
        ...(() => {
          if (session.workspace.mode !== "worktree" || !session.projectId) return {};
          try {
            const project = this.getProject(session.projectId);
            return { worktree: { branch: session.workspace.branch, repoRoot: project.root } };
          } catch {
            // A session whose project record went. Nothing to say about it that
            // would be true, so it says nothing and the worker keeps the
            // path-only wording.
            return {};
          }
        })(),
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
   * The catalogue put through the manifest the picker uses, so it is the row
   * the picker opens on: the manifest's `defaults.chat` (Fable 5.1 today) on
   * its long window, or the CLI's own default where the manifest's is not
   * offered. Only a long row qualifies; never an invented id.
   *
   * `claimNextTurn` is synchronous on purpose (see `refreshProviderToken`), so
   * this reads the in-memory catalogue and nothing else. Cold yields
   * `undefined` — `prepareClaudeCatalogue` is what makes it warm in time.
   */
  private defaultClaudeModelId(instanceId: string = defaultInstanceIdForDriver("claude")): string | undefined {
    // THE READER'S CHOICE FIRST (Settings → Providers → Models). Checked against
    // the list when there is one, so a withdrawn model falls back to Telar's
    // pick; trusted as stored when cold, because it was picked off that list.
    const chosen = (() => {
      try {
        return this.getModelOverlay(instanceId).default;
      } catch {
        return undefined;
      }
    })();
    const cached = this.modelCache.get("claude");
    if (cached) {
      const listed = applyModelManifest(cached.models, this.manifest, cached.cliVersion);
      return chosenDefault(listed, chosen)?.id ?? longDefaultOf(listed);
    }
    // COLD MEMORY, WARM DISK. Reading the list spawns the provider's CLI, which
    // a synchronous claim cannot do and a user's first message must not wait
    // for. The last list this machine actually read is remembered instead, so a
    // restart is covered from its very first turn; the background refresh on
    // admission keeps it current.
    return chosen ?? this.rememberedClaudeDefault();
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
  private rememberClaudeDefault(models: ModelCatalogue["models"], cliVersion: string | undefined): void {
    const model = longDefaultOf(applyModelManifest(models, this.manifest, cliVersion));
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
    const model = this.defaultClaudeModelId(normalized?.instanceId ?? instanceId);
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
    // WHERE THE REPOSITORY STANDS AS THIS TURN BEGINS (#741). Dispatched, never
    // awaited — see `anchorTurn` for why this one line may not be a git call.
    this.anchorTurn(sessionId, turn.runId, "before");
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
    if (isDeltaOnlyBatch(observations)) return this.ingestDeltas(sessionId, runId, claimToken, observations);
    return this.executeCommand("ingestObservations", () => this.ingestBatch(sessionId, runId, claimToken, observations));
  }

  /**
   * A STREAM COSTS ONE TRANSACTION PER FLUSH, NOT ONE PER TOKEN-CHUNK.
   *
   * #246 stopped a delta reaching the disk where it was appended; what it could
   * not touch was the machinery each `ingestObservations` CALL ran around the
   * append, and the driver makes one call per delta. Measured (`bench:append`,
   * a 327-item session): 0.078 ms for `ingest, 1 per call` against 0.006 ms for
   * the append itself — so twelve of every thirteen microseconds a streamed
   * chunk cost were spent on the call, not the write.
   *
   * ALL OF IT IS WORK A DELTA DOES NOT NEED:
   *
   *   the transaction   a delta-only batch writes NO row. Every delta goes into
   *                     the execution store's buffer and reaches sqlite on a
   *                     later flush, so the BEGIN/COMMIT wrapped around nothing
   *                     at all — and, with it, the two `total_changes()` probes
   *                     that decide whether a receipt is owed.
   *   the task read     a delta cannot touch a task. The document was parsed and
   *                     validated per chunk to be handed to nobody.
   *   the items copy    `readItems` hands out a Map of its own over the cached
   *                     items, which on a 327-item session is 327 entries
   *                     rebuilt per chunk to answer `items.has(itemId)` once.
   *   the queue parse   `readQueue` re-parses and re-validates `queue.json` per
   *                     chunk. Nothing here MUTATES the turn, so the shared
   *                     read-only copy `scanQueue` already keeps is the right
   *                     one — the same bargain every other reader makes.
   *
   * WHAT IS NOT SKIPPED: the claim check, the schema validation, the ordering.
   * A caller cannot tell these two paths apart — the journal gets the same
   * events, with the same ids, in the same order, and `readEvents` answers with
   * held deltas exactly as it did before.
   *
   * ATOMICITY IS THE ONE REAL DIFFERENCE, and it is the trade #246 already made
   * one layer down. Without a transaction around the batch, a failure PART WAY
   * through it — which after validation means sqlite failing on a flush — leaves
   * the deltas before it journalled. That is already true between calls, and a
   * flush that cannot write is a daemon in trouble either way.
   */
  private ingestDeltas(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    // First, and against the shared copy: the claim is checked before the batch
    // is validated, exactly as the command path checks it before parsing.
    const turn = this.requireRunningClaimFromQueue(this.scanQueue(sessionId), runId, claimToken);
    // THE SAME SCHEMA THE COMMAND PATH USES, not a narrower copy of the delta
    // member: one definition, so the two paths cannot drift on what they accept.
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    for (const observation of parsed.data) {
      // `isDeltaOnlyBatch` is what chose this path; this is what tells the compiler.
      if (observation.kind !== "content.delta") continue;
      // The one thing the projection was read for. `journalObservation` drops a
      // delta whose item never opened, and so does this.
      if (!this.hasItem(sessionId, observation.itemId)) continue;
      const written = this.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      // #214: a reader arriving mid-reply still has to see the prefix.
      this.extendOpenPrefix(sessionId, observation.itemId, observation.text, written.id);
    }
    return { accepted: parsed.data.length };
  }

  private ingestBatch(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    const projection = { items: this.readItems(sessionId), tasks: this.readTasks(sessionId), itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
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
    if (projection.itemsTouched.size > 0) this.writeItems(sessionId, projection.items, projection.itemsTouched);
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
    // ...and where it stands now it has ended (#741). The pair is what makes
    // `before..after` a range git can be asked about.
    this.anchorTurn(sessionId, turn.runId, "after");
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
    /**
     * AND ANYTHING HELD FOR THIS SESSION IS NOW DELIVERABLE — #550.
     *
     * The turn that just ended was the reason a wake was held; ending it is the
     * moment "not now" becomes "now". Placed AFTER `fireSubscriptions` so the
     * flush sees a settled queue, and it is a no-op when the box is empty or a
     * follow-up turn is already live.
     */
    this.flushPendingNotifications(sessionId);
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
    // Where the repository stands now this turn has ended (#741). A FAILED turn
    // is anchored like a completed one: it may well have committed before it
    // failed, and "what did this turn do" is asked of a failure more often than
    // of a success.
    this.anchorTurn(sessionId, turn.runId, "after");
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
    /**
     * AND ANYTHING HELD FOR THIS SESSION IS NOW DELIVERABLE — #550.
     *
     * The turn that just ended was the reason a wake was held; ending it is the
     * moment "not now" becomes "now". Placed AFTER `fireSubscriptions` so the
     * flush sees a settled queue, and it is a no-op when the box is empty or a
     * follow-up turn is already live.
     */
    this.flushPendingNotifications(sessionId);
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
      session.agentMessagesBlockedAt = at;
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
    /**
     * AND ANYTHING HELD FOR THIS SESSION IS NOW DELIVERABLE — #550.
     *
     * The turn that just ended was the reason a wake was held; ending it is the
     * moment "not now" becomes "now". Placed AFTER `fireSubscriptions` so the
     * flush sees a settled queue, and it is a no-op when the box is empty or a
     * follow-up turn is already live.
     */
    this.flushPendingNotifications(sessionId);
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
    // Where the repository stands now this turn has ended (#741). A STOPPED
    // turn is the case the anchor is worth most for: the work ended where it
    // stood, and the range is the only account of it that is not the agent's.
    this.anchorTurn(sessionId, turn.runId, "after");
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
    /**
     * AND ANYTHING HELD FOR THIS SESSION IS NOW DELIVERABLE — #550.
     *
     * The turn that just ended was the reason a wake was held; ending it is the
     * moment "not now" becomes "now". Placed AFTER `fireSubscriptions` so the
     * flush sees a settled queue, and it is a no-op when the box is empty or a
     * follow-up turn is already live.
     */
    this.flushPendingNotifications(sessionId);
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
    // rather than assumed: a project-less session is always
    // `local`, because a worktree is cut from a project's repository and it has
    // none. Reading the pair together means a future project-less session that
    // somehow carried a worktree degrades to "leave the directory" instead of
    // throwing on a lookup that cannot succeed.
    if (session.workspace.mode === "worktree" && session.projectId) {
      const project = this.getProject(session.projectId);
      // Best-effort. A leaked directory is bounded inside the engine's own
      // root and is reapable later; refusing to archive because git was
      // unhappy would strand the session in a state a human cannot leave.
      this.releaseWorktree(project, session.workspace.path);
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
  /**
   * Give a checkout back, on the queue, without waiting for it — #496's other
   * half.
   *
   * NOT AWAITED, AND THAT LOSES NOTHING A CALLER HAD. `removeSessionWorktree`
   * always returned whether the directory was actually gone, and neither caller
   * ever read it: both are best-effort by their own comments, because a leaked
   * worktree is bounded inside the engine's root and reapable later, while an
   * archive that refused because git was unhappy would strand a session nobody
   * can leave. What blocking bought here was not a decision — it was the wait.
   *
   * IT STILL GOES THROUGH THE QUEUE, so a removal and the next session's cut on
   * the same project do not race on the index lock.
   */
  private releaseWorktree(project: Project, worktreePath: string): void {
    /**
     * READ ON THE QUEUE, NOT BEFORE IT — issue #534. The removal may wait behind
     * another project's cut, and a cable can move while it waits; the question
     * "is this repository readable" has to be asked at the moment git would
     * actually be run. See `removeSessionWorktreeAsync` and `worktree.ts`'s
     * header for why `prune` in particular must not run on a stale answer.
     */
    void this.worktreeQueue(project.root, () =>
      removeSessionWorktreeAsync(this.worktreeGit, project.root, worktreePath, this.projectAvailability(project)).finally(() => {
        this.forgetGitReadsUnder(project.root);
        this.forgetGitReadsUnder(worktreePath);
      }),
    );
  }

  /**
   * LOCK THE WORKTREES THAT ALREADY EXIST — issue #641.
   *
   * `createSessionWorktreeAsync` locks at the cut, which covers everything made
   * from now on and nothing made before. That is the entire installed base on
   * the day this ships, including the sessions the bug was reported against, so
   * without this the fix arrives for the worktrees nobody has yet.
   *
   * ON THE WAY UP, LIKE THE OTHER SWEEPS, and for the sharper version of their
   * reason: the window this closes is between a daemon starting and a PR being
   * merged, and the orchestrator merges as soon as CI passes. A lock that waited
   * for the session's next turn would routinely lose that race.
   *
   * NOT ARCHIVED, which is the whole policy in one predicate. An archived
   * session has already been put down and its worktree released; locking that
   * one would be locking a corpse, and `removeSessionWorktreeAsync`'s unlock is
   * what any survivor needs rather than a fresh lock. Everything else is live by
   * definition — settled is a shelf, not an ending, and a settled session's
   * checkout is still the thing it would resume into.
   *
   * IDEMPOTENT AND BEST-EFFORT. `git worktree lock` on an already-locked tree
   * answers non-zero and that is not a failure; a project on an absent drive
   * cannot be asked at all and is skipped rather than waited for. Nothing here
   * may fail a boot — an unlocked worktree is the status quo, not a regression.
   */
  /**
   * EVERY SESSION CHECKOUT THE REAP MIGHT TAKE — issue #633.
   *
   * It hands out the four facts `reapNodeModules` decides on and nothing else,
   * so the rule lives in one testable function with no database behind it. The
   * ARCHIVE FLAG IS NOT FILTERED HERE: the sweep counts what it refused, and a
   * list pre-filtered to the qualifying rows would make "refused 12 live
   * sessions" unreportable and the do-nothing direction untestable.
   *
   * `live` IS THE SAME QUESTION `settlingActivityOf` ASKS, rather than a second
   * opinion about it — a turn queued, claimed or running is a turn holding that
   * directory right now.
   *
   * A PROJECT WHOSE DRIVE IS OUT IS DROPPED ENTIRELY, on `releaseWorktree`'s
   * argument: a filesystem question asked of a disk nobody can read answers
   * about a disk nobody can read, and on the recreated-empty-mountpoint case it
   * answers "there is no node_modules here" about a tree that is sitting on the
   * drive in somebody's bag.
   */
  reapableWorktrees(): ReapCandidate[] {
    const candidates: ReapCandidate[] = [];
    for (const session of this.allSessions()) {
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      let project: Project;
      try { project = this.getProject(session.projectId); } catch { continue; }
      if (this.projectAvailability(project) !== "available") continue;
      if (!fs.existsSync(session.workspace.path)) continue;
      const activity = settlingActivityOf(this.executionStore?.sessionRow(session.id) ?? { activity: session.activity });
      candidates.push({
        sessionId: session.id,
        worktree: session.workspace.path,
        archived: session.state === "archived",
        live: activity.working === true || activity.waitingOnYou === true,
      });
    }
    return candidates;
  }

  lockLiveWorktrees(): { locked: number } {
    let locked = 0;
    for (const session of this.allSessions()) {
      if (session.state === "archived") continue;
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      let project: Project;
      try {
        project = this.getProject(session.projectId);
      } catch {
        continue;
      }
      // The same question `releaseWorktree` asks, and for the same reason: git
      // run against a repository nobody can read answers about a repository
      // nobody can read. See `worktree.ts`'s header.
      if (this.projectAvailability(project) !== "available") continue;
      if (!fs.existsSync(session.workspace.path)) continue;
      locked++;
      const worktreePath = session.workspace.path;
      // ON THE QUEUE so a lock cannot race a cut or a removal on the same
      // repository, and NOT AWAITED so a machine with forty worktrees does not
      // hold the boot open while git walks every one of them.
      void this.worktreeQueue(project.root, () => lockSessionWorktree(this.worktreeGit, project.root, worktreePath));
    }
    return { locked };
  }

  /**
   * MOVE EVERY CHECKOUT THIS ENGINE HOLDS TO A NEW ROOT — issue #642 part 2.
   *
   * RE-CUT, NOT COPIED. See `worktrees-move.ts` for why copy-and-repair is the
   * wrong design; the short version is that a worktree has one admin entry and
   * `repair` moves it, leaving two directories sharing an index.
   *
   * ONLY WHAT IS ACTUALLY ON DISK. A session whose checkout was already
   * released has a recorded path that names nothing, and asking git to remove
   * it would report a failure about a checkout nobody has.
   *
   * BUSY MEANS ANYTHING BUT `idle`, AND ONE OF THEM REFUSES THE WHOLE RUN. An
   * archived session's checkout has already been released, so "refuse while
   * anything is unsettled" would refuse every time and the operation could
   * never run at all; what actually matters is whether a turn is in flight in
   * that directory, which is what `activity` answers.
   *
   * THE GIT WORK GOES THROUGH THE PER-PROJECT QUEUE, so a move and a cut on
   * the same project never race on the index lock — the same discipline
   * `releaseWorktree` and `lockLiveWorktrees` follow.
   */
  async moveWorktrees(destination: string): Promise<MoveOutcome> {
    const checkouts: Checkout[] = [];
    for (const session of this.readSessions()) {
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      if (!fs.existsSync(session.workspace.path)) continue;
      let project: Project;
      try {
        project = this.getProject(session.projectId);
      } catch {
        continue; // A removed project is not one to re-cut against.
      }
      checkouts.push({
        sessionId: session.id,
        path: session.workspace.path,
        branch: session.workspace.branch ?? "",
        projectRoot: project.root,
        busy: session.activity !== "idle",
      });
    }
    const roots = [...new Set(checkouts.map((checkout) => checkout.projectRoot))];
    const run = () =>
      moveCheckouts(this.worktreeGit, {
        checkouts,
        destination,
        onMoved: (sessionId, to) => this.recordWorktreeMove(sessionId, to),
      });
    // One queue is enough to serialise against cuts; with several projects the
    // queues nest, which is the same ordering guarantee one at a time.
    return roots.reduce<() => Promise<MoveOutcome>>((next, root) => () => this.worktreeQueue(root, next), run)();
  }

  /**
   * WHAT IS BEING KEPT, AND WHICH OF IT CAN GO — issue #671.
   *
   * THE STORE'S PART IS THE FACTS, NOT THE PROOF. Everything that decides
   * whether a checkout is safe to reclaim lives in `worktree-inventory.ts`,
   * where it is a pure function over stated facts and can be tested without a
   * fixture capable of losing data. What this method owns is the three things
   * only the store knows: which sessions there are and what they are doing,
   * which projects' disks are actually there, and where the checkouts live.
   *
   * SETTLED IS THE CLIENTS' OWN QUESTION, IMPORTED (`isShelved`), for the
   * reason every other caller of it here states: a pane that folded the shelf
   * rule a second time would disagree with the rail about which sessions are
   * finished, and this pane offers to end the ones it thinks are.
   *
   * ARCHIVED SESSIONS ARE INCLUDED, and they are not noise. `releaseWorktree`
   * is best-effort and skips a project whose disk is not there, so an archive
   * performed while the drive was out leaves a directory with a record that
   * has already been put down — bytes nothing will ever use again, and
   * invisible to every surface until this one.
   */
  async worktreeInventory(): Promise<WorktreeInventory> {
    const location = readWorktreesRoot(this.paths.root);
    const configured = rootOf(location);
    const fallback = defaultWorktreesRoot(this.paths.root);
    const at = { now: this.now(), autoSettleAfterHours: this.getInboxPolicy().autoSettleAfterHours };

    const projects: InventoryProject[] = this.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      available: this.projectAvailability(project) === "available",
    }));

    const sessions: InventorySession[] = [];
    for (const session of this.readSessions()) {
      if (session.workspace.mode !== "worktree" || !session.projectId) continue;
      const settleable = { ...session, archived: session.state === "archived", draft: session.draft !== undefined };
      const lifecycle =
        session.state === "archived" ? "archived" : isShelved(settleable, settlingActivityOf(session), at) ? "settled" : "live";
      sessions.push({
        id: session.id,
        ...(session.title ? { title: session.title } : {}),
        path: session.workspace.path,
        ...(session.workspace.branch ? { branch: session.workspace.branch } : {}),
        projectId: session.projectId,
        lifecycle,
        // `moveWorktrees`' predicate, and #671's rung 1. See
        // `worktree-inventory.ts` for why this is a policy asserted up front
        // rather than a git lock waiting to refuse.
        busy: session.activity !== "idle",
      });
    }

    return buildInventory(
      {
        git: this.worktreeGit,
        // The storage pane's own walker, so a row and the "Session checkouts"
        // figure that sent somebody here can never disagree by a gigabyte.
        measure: (target) => measureDirectory(target),
      },
      {
        // Both roots while a #642 move is half-done — `readStorage`'s reason,
        // and the same pair it passes.
        roots: configured && configured !== fallback ? [configured, fallback] : [fallback],
        rootsReadable: location.kind !== "absent" && location.kind !== "unreadable",
        ...(worktreesRootBlocker(location) ? { blocker: worktreesRootBlocker(location)! } : {}),
        sessions,
        projects,
        // The tree this daemon is executing from, when it is executing from
        // one. On the machine Telar is developed on that is a worktree of
        // Telar, and it must never be offered for reclamation.
        engineRoot: process.cwd(),
        now: at.now,
      },
    );
  }

  /**
   * GIVE CHECKOUTS BACK — the other half of #671, and the only thing in this
   * feature that removes anything.
   *
   * TWO ACTS, NEVER MERGED INTO "CLEAN UP". A checkout held by a SETTLED
   * session is given back by ARCHIVING THAT SESSION, because that is the only
   * supported way: settling deliberately does not release a checkout, and
   * nothing re-cuts a missing worktree — so deleting the directory under a live
   * record would trade invisible orphans for invisible broken sessions, which
   * is not progress. A checkout nothing claims (no session, or an archived one
   * whose release never happened) has no session to end, so the directory goes.
   * The caller renders which, and the confirm says "archive the session" rather
   * than naming the gigabytes.
   *
   * EVERY REFUSAL IS RE-PROVED HERE, not trusted from the listing the press
   * came from. That inventory may be seconds old and a session can start
   * working in that window — the prediction on the row is the courtesy, this is
   * the guarantee.
   *
   * PARTIAL IS SUCCESS. Each item is independent, and one refused for a typed
   * confirmation that did not match changes nothing about the others.
   */
  async reclaimWorktrees(items: readonly WorktreeReclaimItem[]): Promise<WorktreeReclaimResult[]> {
    const inventory = await this.worktreeInventory();
    const byPath = new Map(inventory.rows.map((row) => [path.resolve(row.path), row]));
    const results: WorktreeReclaimResult[] = [];

    for (const item of items) {
      const row = byPath.get(path.resolve(item.path));
      if (!row) {
        results.push({ path: item.path, ok: false, refusal: "not-found" });
        continue;
      }
      if (row.verdict.kind === "locked") {
        results.push({ path: row.path, ok: false, refusal: row.verdict.reason });
        continue;
      }
      if (row.verdict.kind === "needs-force") {
        // THE BASENAME, TYPED. Not ceremony: these are the rows where Telar
        // could NOT prove the work is safe, so the person is being asked to say
        // they looked — which a checkbox cannot express.
        if (item.confirm === undefined) {
          results.push({ path: row.path, ok: false, refusal: "needs-confirm" });
          continue;
        }
        if (item.confirm.trim() !== row.basename) {
          results.push({ path: row.path, ok: false, refusal: "confirm-mismatch" });
          continue;
        }
      }

      const bytes = row.bytes;
      try {
        if (row.owner.kind === "session" && row.owner.lifecycle === "settled") {
          // The supported path, which releases the checkout on the project
          // queue as part of putting the session down.
          this.archiveSession(row.owner.sessionId);
          results.push({
            path: row.path,
            ok: true,
            action: "archived",
            sessionId: row.owner.sessionId,
            ...(bytes === undefined ? {} : { bytes }),
          });
          continue;
        }
        // Nothing claims it. `removeSessionWorktreeAsync` already unlocks
        // first, already refuses to prune against a disk that is not there, and
        // already runs on the per-project queue through `releaseWorktree`'s
        // discipline — which is why this reuses it rather than inventing a
        // second teardown.
        const project = row.projectId ? this.getProject(row.projectId) : undefined;
        // REGISTERED OR NOT IS THE FORK, NOT WHETHER A PROJECT IS KNOWN. A
        // directory git has already pruned is not a worktree — `worktree
        // remove` answers "is not a working tree" and leaves every byte — so it
        // takes the fenced `rm` even when we know exactly which project it was
        // cut from.
        const removed =
          row.registered && project
            ? await this.worktreeQueue(project.root, () =>
                removeSessionWorktreeAsync(this.worktreeGit, project.root, row.path, this.projectAvailability(project)),
              )
            : removeUnregisteredCheckout(row.path, inventory.roots);
        if (!removed) {
          results.push({ path: row.path, ok: false, refusal: "failed", detail: "the checkout is still there" });
          continue;
        }
        results.push({ path: row.path, ok: true, action: "removed", ...(bytes === undefined ? {} : { bytes }) });
      } catch (cause) {
        results.push({
          path: row.path,
          ok: false,
          refusal: "failed",
          detail: cause instanceof Error ? cause.message : "the checkout could not be given back",
        });
      }
    }
    return results;
  }

  /** The commit point for one moved checkout: the recorded path, and the event
   *  that tells every open cockpit its session moved. */
  private recordWorktreeMove(sessionId: string, to: string): void {
    const session = this.getSession(sessionId);
    const updated: Session = {
      ...session,
      workspace: { ...session.workspace, path: to } as Session["workspace"],
      updatedAt: this.now(),
    };
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(updated));
    this.appendEvent(sessionId, { type: "session.updated", session: updated });
  }

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
      this.releaseWorktree(project, session.workspace.path);
    }

    // The event is appended BEFORE the directory goes, so a subscriber watching
    // this session is told why its stream ended rather than simply losing it.
    this.appendEvent(sessionId, { type: "session.archived" });
    this.executionStore?.deleteSession(sessionId);
    fs.rmSync(sessionDir(this.paths, sessionId), { recursive: true, force: true });
    // A row that left is a change of MEMBERSHIP — the list is shorter, or the
    // shelf's count is — so every reader is told rather than only the side this
    // session happened to be on. See `sessionsRevision`. Also drop whatever this
    // command owed for it: there is no document left to fold.
    this.dirtySessionRows.delete(sessionId);
    this.listRevision = this.nextRevision();
    // The queue went with the directory, so no `writeQueue` will ever retire
    // this id from the live index. Drop it here or a worker keeps asking about
    // a session that no longer exists.
    this.liveQueueIndex?.delete(sessionId);
    this.queueCache.delete(sessionId);
    this.itemsCache.delete(sessionId);
    // And the requests went with it: nothing is open on a session that no
    // longer exists, and `writeRequests` will never be called for it again.
    this.liveRequestIndex?.delete(sessionId);
    // The journal is gone with the directory; a session recreated under this
    // id starts a new one from 1, not from where the old one stopped.
    this.journalHead.delete(sessionId);
    // Same argument, for the liveness ledger: a session recreated under this id
    // must not inherit a stamp from the one that was deleted (#813).
    this.runProgress.delete(sessionId);
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
  subscribe(
    subscriberSessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Subscription {
    assertId(input.targetSessionId, "target session id");
    if (subscriberSessionId === input.targetSessionId) {
      throw new EngineStateError("invalid_request", "a session cannot subscribe to itself");
    }
    const subscriber = this.getSession(subscriberSessionId);
    if (subscriber.state !== "active") throw new EngineStateError("conflict", "an archived session cannot be woken");
    const target = this.getSession(input.targetSessionId);
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
      // Re-subscribing MERGES, so naming a policy changes it and omitting one
      // leaves whatever was chosen before — the same rule `events` follows.
      if (input.completionWake !== undefined) existing.completionWake = input.completionWake;
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
      // ABSENT MEANS `settled_only`. Stored only when explicitly asked for, so
      // the default stays a reading of the contract rather than a value written
      // into every subscription ever made.
      ...(input.completionWake ? { completionWake: input.completionWake } : {}),
      createdAt: this.now(),
    };
    all.push(subscription);
    this.writeSubscriptions(all);
    return structuredClone(subscription);
  }

  /** Sessions already refused for running on the removed `telar` driver, so the
   *  refusal is one log line rather than one per worker poll (#531). */
  private readonly warnedLegacyDriver = new Set<string>();

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
   * ONE DIRECTION ONLY: what this session asked to be woken BY.
   *
   * The narrow twin of `dropSubscriptionsOf`, and the difference is the whole
   * reason it exists (#522). That one runs when a session is gone, so both ends
   * are meaningless. This runs when the main session is merely switched off: it
   * is still there, still resumable, and a subscription somebody else holds ON
   * it is that session's own business — dropping those would stop work nobody
   * asked to stop.
   *
   * The queued wakes go too, for `unsubscribe`'s reason: "stop waking me" that
   * left fourteen already-queued wakes to run one by one has stopped nothing a
   * person could see.
   */
  private dropSubscriptionsBy(subscriberSessionId: string): void {
    const all = this.readSubscriptions();
    const removed = all.filter((each) => each.subscriberSessionId === subscriberSessionId);
    if (removed.length === 0) return;
    this.writeSubscriptions(all.filter((each) => each.subscriberSessionId !== subscriberSessionId));
    for (const each of removed) this.discardQueuedWakes(each.subscriberSessionId, each.targetSessionId);
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
    /**
     * ONE NOTIFICATION FOR EVERY SUBSCRIBER — minted here rather than per hit.
     *
     * Nothing in it is about WHO is being woken: it names the session that acted,
     * its run, and the sentence the engine wrote about the transition. Two
     * subscribers to one completion were being told the same fact in two objects
     * built from the same inputs, which is the drift `notification.ts` exists to
     * prevent, one level up. It is read and never written (`holdNotification`
     * stores it, `mergeNotifications` builds new ones), so sharing it is safe.
     *
     * THE WAKE TEXT IS ITS BODY, NOT A TURN'S INPUT (#550). Same sentence, same
     * author — what changed is where it sits. On `input` it was engine prose in
     * the slot a person's words occupy, and every reader downstream had to be
     * told in prose not to believe it. Here it is labelled as what it is, and
     * `input` says only that a notification arrived. See `notificationLabel`.
     */
    const notification = wakeNotification({
      wakeKind: kind,
      targetSessionId,
      runId: turn.runId,
      ...(context.request ? { requestId: context.request.id } : {}),
      body: wakeMessage(kind, target, turn, context),
    });
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
       *
       * STILL TRUE AFTER #590. What that issue folds is the second ROW, by
       * merging the ending into the result still waiting in the queue — the
       * fact is carried, listed and spoken, never dropped. If you are here
       * because two notices about one run look redundant, read
       * `mergeIntoWaitingResult` below; suppression has been tried.
       */
      const wakeReason: WakeReason = {
        kind,
        sessionId: targetSessionId,
        runId: turn.runId,
        ...(context.request ? { requestId: context.request.id } : {}),
      };
      /**
       * ONE ERRAND CLOSING, NOT TWO ANNOUNCEMENTS — issue #590 half 2.
       *
       * The result this run already sent is still WAITING in this subscriber's
       * queue, unread. Announcing its ending beside it is a second row and a
       * second notice about one errand, which is the complaint — so the ending
       * is merged into the notification that is already waiting. Both facts
       * survive (see `mergeRunOutcome`); what does not is the second row.
       *
       * NOT WHEN THE WAKE WOULD INTERRUPT. `completionWake: always` on a busy
       * subscriber is an opt-in to hearing this NOW, and folding it into a turn
       * still waiting in the queue would quietly take that back.
       */
      const interrupting = (subscription.completionWake ?? "settled_only") === "always" && this.hasLiveTurn(subscriberId);
      if (!interrupting && this.mergeIntoWaitingResult(subscriberId, targetSessionId, notification, kind)) {
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      /**
       * SETTLED ONLY, BY DEFAULT — #550 clause 3.
       *
       * A wake arriving while the subscriber has a live turn used to be STEERED
       * into it (`submitTurn` steers whatever it accepts when a turn is
       * running), so a coordinator with four workers took four interruptions in
       * the middle of its own reasoning. Held instead, they arrive together, as
       * ONE notification, when it next comes up for air.
       *
       * `always` IS STILL THERE and still means what it did, for a subscriber
       * whose whole job is to react. It has to be asked for, which is the
       * change: the loud behaviour is no longer what you get by not choosing.
       */
      if ((subscription.completionWake ?? "settled_only") === "settled_only" && this.hasLiveTurn(subscriberId)) {
        this.holdNotification(subscriberId, notification);
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
      /**
       * A COHORT ALREADY WAITING TAKES THIS ONE WITH IT.
       *
       * Otherwise a wake landing in the window between a session going idle and
       * its held mail being delivered would queue a turn of its own and the
       * cohort would arrive as two — which is the merge failing at exactly the
       * moment it matters, since that window is when a busy session drains.
       */
      if (this.readPendingNotifications(subscriberId).length > 0) {
        this.holdNotification(subscriberId, notification);
        this.flushPendingNotifications(subscriberId);
        if (subscription.once && TERMINAL_WAKE_KINDS.includes(kind)) remove(subscription);
        continue;
      }
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
        const coalesced = this.coalesceQueuedWake(subscriberId, targetSessionId, notification, wakeReason);
        if (!coalesced) {
          const delivered: NotificationDetail = { ...notification, deliveries: 1 };
          this.submitTurn(subscriberId, {
            runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
            input: notificationLabel(delivered),
            origin: "session",
            wakeReason,
            notification: delivered,
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

  /**
   * EVERY REPORT WINDOW THAT HAS CLOSED — the cadence tick, issue #723.
   *
   * The mailbox's four existing drains all hang off a turn ENDING, which is
   * exactly what does not happen to the session this feature is for: a
   * coordinator that set a window and then went quiet has nothing to end. So the
   * window needs something that ticks, and this is it — the same shape, and the
   * same argument, as `sweepDelegatedSettling` above.
   *
   * A CLOSED WINDOW WITH AN EMPTY BOX DELIVERS NOTHING. No turn, no event, no
   * row: a turn that says "no reports this window" is a model invocation paid
   * for silence, and #199's rule is that passive traffic costs none. Absence of
   * a delivery IS the report, and `sessions_status` reports the box meanwhile.
   *
   * CHEAP REFUSALS FIRST, in the order that costs least: a session with no
   * window is one document read, and a window with an empty box is one more.
   * Only a box that is both non-empty and due reaches the flush.
   *
   * Returns the sessions it delivered to, so a caller — and a test — can see the
   * tick's work without waiting on a timer.
   */
  sweepReportWindows(): string[] {
    const now = this.now();
    const delivered: string[] = [];
    for (const sessionId of this.sessionIds()) {
      try {
        const session = this.getSession(sessionId);
        const minutes = session.reportWindowMinutes;
        if (minutes === undefined) continue;
        /**
         * A SHELVED OR SNOOZED SESSION IS NOT DELIVERED TO, and this is the one
         * place that has to say so out loud. `flushPendingNotifications` submits
         * a turn, and `submitTurn` treats new work as the shelf lifting itself —
         * so a tick that flushed here would un-shelve a row a person put away,
         * which is precisely the exclusion #631 part 2 made deliberate for a
         * peer's routine report. The mail keeps waiting, as that comment
         * promises, and `sessions_status` reports it meanwhile.
         *
         * IT IS NOT A CONDITION ON THE FLUSH ITSELF: a session that ENDS A TURN
         * is awake by demonstration, whatever its pin says, and the four
         * turn-boundary drains are unchanged.
         */
        if (session.settledOverride === "settled" || session.snoozedUntil !== undefined) continue;
        /**
         * AND A SESSION SET TO HOLD IS NEVER DELIVERED TO BY THIS TICK — issue
         * #784, step 2.
         *
         * THE SAME SHAPE AS THE SHELF ABOVE, deliberately: a `continue` in the
         * sweep, not a condition on the flush. A session that ENDS A TURN is
         * awake by demonstration whatever its cadence says, and the four
         * turn-boundary drains stay exactly as they are — so a person who
         * actually speaks to this session still gets their mail, merged, at the
         * moment they were already paying for a turn.
         *
         * WHAT THIS REMOVES IS THE DELIVERY NOBODY ASKED FOR. Every other
         * cadence ends in a flush, and a flush is a turn: a row in a
         * conversation, a provider call, the thing the person was reading
         * moving under them, and — because it moves `lastTurnEndedAt` —
         * `push.ts`'s "A session finished" on their phone. At 3am that is
         * quieter than forty wakes and no better. Held, the mailbox IS the
         * delivery, and the count beside the cadence in the Agents panel is how
         * they see it.
         *
         * BEFORE THE BOX IS READ, on this sweep's own "cheap refusals first"
         * rule: this is a comparison on a document already in hand, and the
         * read below is another file.
         */
        if (minutes === HOLD_REPORTS) continue;
        if (this.readPendingNotifications(sessionId).length === 0) continue;
        /**
         * A BOX WITH NO STAMP IS DUE NOW. It was filled before this field
         * existed, so its mail has already waited at least as long as any window
         * — inventing `now` as its start would make the oldest mail in the store
         * the last to be delivered.
         */
        const since = this.heldSince(sessionId);
        if (since !== undefined && now - since < minutes * 60_000) continue;
        // A live turn is not interrupted. `flushPendingNotifications` refuses on
        // its own, and the turn's own end is the drain — so the cohort goes out
        // one turn boundary later rather than into the middle of a thought.
        const before = this.readPendingNotifications(sessionId).length;
        this.flushPendingNotifications(sessionId);
        if (this.readPendingNotifications(sessionId).length < before) delivered.push(sessionId);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return delivered;
  }

  /**
   * ══ EVERY SNOOZE THAT HAS ENDED — issues #490, #586 ══
   *
   * THE THIRD OF THESE, AND THE ONE WITH THE STRONGEST CASE. `snoozedUntil` is a
   * stored timestamp and nothing else: "is this snoozed?" is COMPUTED against
   * `now`, and every reference to it across the engine stores it, reads it, or
   * deletes it. Nothing scheduled anything at expiry, so there was no moment at
   * which a conversation woke and nothing could announce one — the row simply
   * reappeared whenever something happened to render after the deadline. The
   * owner reported it as "nos faltó añadir un punto de notificación para mostrar
   * que una conversación se despertó"; this is the point of notification.
   *
   * A DEADLINE PASSING IS NOT AN EVENT, which is the same thing
   * `sessionsRevision` says about the same class of bug: *"no counter can move
   * on an event that does not happen."* So the wake needs something that ticks,
   * exactly as the grace above it did (#378) and the report window before it
   * (#723).
   *
   * ══ WHY THE ENGINE AND NOT EACH COCKPIT ══
   *
   * A per-row client timer would light the dot. It would also fire
   * INDEPENDENTLY IN EVERY COCKPIT, so two devices would disagree about when a
   * conversation woke — the same class of bug as two disagreeing about whether a
   * turn ended. "When did this conversation wake" is a server-side fact with
   * exactly one correct answer, and computing it per device IS the defect rather
   * than an implementation detail of it. `lastReadTurnSequence` is the precedent
   * and it is in the same file as the rule: both numbers are the engine's, so
   * they answer the same on every device and survive a reload.
   *
   * SO THIS IS ONE TIMER REPLACING N, not a timer added. #490 is removing
   * timers, and the arithmetic runs the right way: one process-level tick
   * instead of one per row per connected cockpit.
   *
   * ══ WHAT IT COSTS, AND WHY IT IS NOT A WHOLE-STORE PASS ══
   *
   * `dueSnoozeWakes` SEEKS: a session with no snooze, or with its wake already
   * recorded, is not a row it returns. The two sweeps above walk `sessionIds()`
   * because their predicates live in documents SQL cannot see; this one's are
   * two columns, so copying their loop would reinstate the fold #493 removed.
   *
   * ══ AND THE DECISION IS NOT MADE HERE ══
   *
   * `wokeAt()` is the one implementation, shared with every client, and it
   * already handles both branches — the scheduled expiry and the early wake a
   * raised hand causes. This records what it answers. Writing a second rule here
   * is how the engine and the cockpit come to disagree about the very thing this
   * exists to make them agree on.
   *
   * Returns the sessions it woke, so a caller — and a test — can see the tick's
   * work without waiting on a timer.
   */
  /* ── schedules (#543) ─────────────────────────────────────────────────── */

  /**
   * ══ EVERY SCHEDULE WHOSE APPOINTMENT HAS PASSED — issue #543 ══
   *
   * THE FIFTH SWEEP, AND THE SAME SHAPE AS THE OTHER FOUR because a deadline
   * passing is still not an event. `sweepSnoozeWakes` is the direct precedent —
   * a stored future timestamp with nobody to notice it — and `sweepRateLimited`
   * is the stronger one, because it already REQUEUES A TURN from a deadline,
   * unattended, on the argument that "a limit that lifted at 3am should not
   * leave the session shelved".
   *
   * DEADLINE-DRIVEN, NEVER CATCH-UP. It asks which rows are due, not how many
   * ticks it missed — so five seconds of lag and five days of sleep take the
   * same path, and nothing here depends on whether `setInterval` is
   * suspend-aware. The decision itself is `decideSchedule`, which is pure.
   *
   * ONE BAD ROW MUST NOT STOP THE PASS, the per-row `try` every sweep here has.
   * A row whose session was deleted is the ordinary case rather than an error:
   * it is disabled, so the sweep stops reconsidering it every thirty seconds
   * for ever, and stays visible on the settings surface.
   */
  sweepSchedules(): string[] {
    const store = this.executionStore;
    if (!store) return [];
    const now = this.now();
    const acted: string[] = [];
    for (const row of store.dueSchedules(now)) {
      try {
        const decision = decideSchedule(row.rule, row.zone, row.nextRunAt, now);
        if (!decision.fire) {
          // SKIPPED, AND SAID SO. Without the recorded instant the boundary —
          // "Telar was not running at 09:00" — is invisible, and an invisible
          // boundary is indistinguishable from a broken scheduler.
          store.writeSchedule({ ...row, nextRunAt: decision.nextRunAt, lastRunStatus: "skipped", lastSkippedAt: decision.skipped ?? row.nextRunAt });
          acted.push(row.id);
          continue;
        }
        const runId = `run_sched_${row.id}_${row.nextRunAt}`;
        this.submitTurn(row.sessionId, {
          runId,
          input: row.prompt,
          origin: "schedule",
          scheduleOrigin: { scheduleId: row.id, dueAt: row.nextRunAt },
        });
        store.writeSchedule({ ...row, nextRunAt: decision.nextRunAt, lastRunAt: now, lastRunId: runId, lastRunStatus: "fired" });
        acted.push(row.id);
      } catch {
        /**
         * The session is gone, or refused the turn. Disable rather than retry:
         * a row that cannot fire is not made more likely to fire by being
         * reconsidered every thirty seconds, and leaving it enabled would turn
         * one deleted session into a permanent tick.
         */
        try {
          store.writeSchedule({ ...row, enabled: false, nextRunAt: this.scheduleParkedAt(row.nextRunAt, now) });
        } catch {
          /* the store itself is unhappy; the next sweep tries again */
        }
      }
    }
    return acted;
  }

  /** Where a row that could not fire is parked: past `now`, so a re-enabled row
   *  does not immediately fire the appointment it already failed. */
  private scheduleParkedAt(dueAt: number, now: number): number {
    return Math.max(dueAt, now) + 1;
  }

  listSchedules(sessionId?: string): ScheduleRow[] {
    return this.executionStore?.listSchedules(sessionId) ?? [];
  }

  readSchedule(id: string): ScheduleRow | undefined {
    return this.executionStore?.readSchedule(id);
  }

  /** Create or replace one schedule. The FIRST `nextRunAt` is computed here
   *  rather than taken from the caller: a client that could name it could aim a
   *  row at the past and make the grace rule meaningless. */
  putSchedule(input: { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean }): ScheduleRow {
    const store = this.executionStore;
    if (!store) throw new EngineStateError("conflict", "schedules need the sqlite execution store");
    if (!input.prompt.trim()) throw new EngineStateError("invalid_request", "a schedule needs a prompt");
    this.requireSession(input.sessionId);
    const now = this.now();
    const existing = input.id ? store.readSchedule(input.id) : undefined;
    const row: ScheduleRow = {
      id: input.id ?? `sched_${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      prompt: input.prompt,
      rule: input.rule,
      zone: usableZone(input.zone),
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      nextRunAt: nextOccurrence(input.rule, input.zone, now),
      ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
      ...(existing?.lastRunId === undefined ? {} : { lastRunId: existing.lastRunId }),
      ...(existing?.lastRunStatus === undefined ? {} : { lastRunStatus: existing.lastRunStatus }),
      ...(existing?.lastSkippedAt === undefined ? {} : { lastSkippedAt: existing.lastSkippedAt }),
    };
    store.writeSchedule(row);
    return row;
  }

  deleteSchedule(id: string): boolean {
    return this.executionStore?.deleteSchedule(id) ?? false;
  }

  sweepSnoozeWakes(): string[] {
    const now = this.now();
    const woken: string[] = [];
    for (const row of this.snoozeWakeCandidates()) {
      try {
        const at = wokeAt({ ...row }, settlingActivityOf(row), { now });
        if (at === undefined) continue;
        if (this.recordSnoozeWake(row.id, at)) woken.push(row.id);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return woken;
  }

  /**
   * ══ EVERY REQUEST THAT RAN OUT ITS DEADLINE — issue #541 D ══
   *
   * THE FOURTH OF THESE, AND IT EXISTS FOR THE SAME REASON AS THE THIRD: a
   * deadline passing is not an event, so nothing writes at one. `requests.ts`
   * has said since it was written that a detached run which parks at minute
   * three and sits until morning "is not autonomous; it is stuck" — this is the
   * clock that makes the sentence enforceable rather than aspirational.
   *
   * ══ A DEADLINE ALONE RESOLVES NOTHING ══
   *
   * The whole of that rule is `deadlineResolution`, in the contract, which
   * answers `null` for a request with no `default`. There is deliberately no
   * second copy of it here — a reader asking "what stops this from answering a
   * question nobody left an answer for" should find one function and be done.
   * The engine never invents an answer; it takes the one the ASKER wrote down.
   *
   * ══ WHY THE LIVE QUEUE SET IS THE WHOLE CANDIDATE SET ══
   *
   * `openRequest` requires a RUNNING CLAIM, and every path that ends a turn
   * cancels the requests it left behind (`closeOpenRequests`). So an open
   * request implies a live queue, and walking `sessionIds()` the way the two
   * sweeps above do would read every conversation ever started to find the
   * nought-to-two a worker is actually blocked on — the fold #545 removed from
   * this exact data.
   *
   * ══ THE WORKER HEARS ABOUT IT FOR FREE ══
   *
   * Nothing extra pushes the answer to the blocked provider: `reindexRequests`
   * keeps a resolved row indexed while its turn is still running, which is
   * precisely what `resolutionsForWorker` polls on the heartbeat. The worker
   * sitting inside `canUseTool` unblocks on the next beat exactly as it would
   * for a human's answer.
   *
   * Returns the request ids it resolved, so a caller — and a test — can see the
   * tick's work without waiting on a timer.
   */
  sweepRequestDeadlines(): string[] {
    const now = this.now();
    const resolved: string[] = [];
    for (const sessionId of [...this.liveQueueSessionIds()]) {
      /**
       * SNAPSHOT FIRST, RESOLVE SECOND. Each resolution rewrites the very index
       * being read — `resolveRequest` is a wrapped command and `writeRequests`
       * reindexes inside it — so resolving mid-iteration would be walking a map
       * that moves underneath.
       */
      let due: Array<{ request: EngineRequest; answer: RequestDefault }>;
      try {
        due = [...this.liveRequests(sessionId).values()].flatMap((request) => {
          /**
           * `=== null` RATHER THAN A TRUTHINESS TEST, and that is not a style
           * note. A falsy check here would be a SECOND COPY of the no-default
           * rule — it would filter out an `undefined` the contract should never
           * have returned, and in doing so hide a broken `deadlineResolution`
           * from every test in this file. Measured: with the contract's own
           * `default === undefined` guard deleted, the truthy version of this
           * line kept the sweep correct and only the unit test went red.
           */
          const answer = deadlineResolution(request, now);
          if (answer === null || request.deadlineMs === undefined) return [];
          return [{ request, answer }];
        });
      } catch {
        // One unreadable session must not stop the sweep for the rest.
        continue;
      }
      for (const { request, answer } of due) {
        try {
          this.resolveRequest(sessionId, request.id, {
            decision: answer.decision,
            resolvedBy: "timeout",
            /**
             * SAID IN WORDS TO THE MODEL THAT ASKED, not only to the person.
             * `reason` is fed back through `resolutionsForWorker`, and a worker
             * told only "declined" reads it as a human's judgement and adapts to
             * a decision nobody made. This is the one sentence that keeps that
             * honest.
             */
            reason: TIMEOUT_REASON,
            ...(answer.answers ? { answers: answer.answers } : {}),
          });
        } catch {
          // Resolved, cancelled or gone between the snapshot and here. The
          // request is settled either way, which is the outcome this wanted.
          continue;
        }
        resolved.push(request.id);
      }
    }
    return resolved;
  }

  /**
   * The rows a wake could still be owed on.
   *
   * THE INDEXED STORE ANSWERS THIS IN ONE QUERY. The JSON backend has no
   * `sessions` table to seek, so it pays the walk — the same trade
   * `bumpRevisionFor` makes, and the same direction: the fallback is slower and
   * never wrong.
   */
  private snoozeWakeCandidates(): SessionIndexRow[] {
    if (this.executionStore) return this.executionStore.dueSnoozeWakes();
    const rows: SessionIndexRow[] = [];
    for (const sessionId of this.sessionIds()) {
      try {
        const row = indexRow(this.getSession(sessionId));
        if (row.snoozedUntil !== undefined && row.wokeAt === undefined && !row.archived) rows.push(row);
      } catch {
        // Same as the sweep: one unreadable session is not the rest's problem.
      }
    }
    return rows;
  }

  /**
   * Stamp one wake, once.
   *
   * RE-READ BEFORE WRITING, because the row that produced the candidate is a
   * projection and the document is the truth — a snooze cancelled between the
   * query and here must not be woken, and a wake already recorded must not be
   * recorded twice. That second guard is what makes "exactly one signal" a
   * property of the code rather than of the tick's timing.
   *
   * `updatedAt` IS DELIBERATELY NOT TOUCHED, for `applyDelegationSettle`'s
   * reason and one of its own: `idleSince` (`settling.ts`) already counts a
   * snooze's wake as the start of the inactivity window, so stamping here would
   * both make an engine wake look like fresh work AND move the row to the top of
   * a list the house rule says must not reorder itself while it is being read.
   *
   * TWO EVENTS, as the settle makes: `session.updated` is how a client's fold
   * learns the new record, `session.woke` is the edge — the one thing anything
   * acting on the wake can subscribe to without diffing two snapshots. It is
   * #586's fifth frame, waiting for #586's feed.
   */
  private recordSnoozeWake(sessionId: string, at: number): boolean {
    const session = this.getSession(sessionId);
    if (session.wokeAt !== undefined || session.snoozedUntil === undefined) return false;
    session.wokeAt = at;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    this.appendEvent(sessionId, { type: "session.woke", wokeAt: at });
    this.appendEvent(sessionId, { type: "session.updated", session });
    return true;
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
  private coalesceQueuedWake(subscriberId: string, targetSessionId: string, notification: NotificationDetail, wakeReason: WakeReason): boolean {
    const queue = this.readQueue(subscriberId);
    const waiting = queue.turns.find(
      (turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason?.sessionId === targetSessionId && turn.wakeReason.runId === wakeReason.runId,
    );
    if (!waiting) return false;
    /**
     * A REWRITE IS A DELIVERY TOO, AND THERE ARE TWO OF THEM — #550 clause 3.
     *
     * The waiting turn has already been put in front of nobody yet, but it HAS
     * been announced, and every rewrite spends the recipient's attention again
     * on an errand it has not got to. Past `MAX_DELIVERIES` the turn keeps
     * whatever it last said and the newer fact goes to the mailbox, where it
     * stays PENDING and `sessions_status` reports it. That is what stops a
     * chatty child from re-announcing itself at a busy coordinator for ever.
     */
    const deliveries = (waiting.notification?.deliveries ?? 1) + 1;
    if (deliveries > MAX_DELIVERIES) {
      this.holdNotification(subscriberId, notification);
      return true;
    }
    const at = this.now();
    notification = { ...notification, deliveries };
    waiting.input = notificationLabel(notification);
    waiting.notification = notification;
    waiting.wakeReason = wakeReason;
    waiting.updatedAt = at;
    this.writeQueue(subscriberId, queue);
    this.touchSession(subscriberId, at);
    // The ROW is rewritten with the turn: the transcript's notification says
    // what the turn says, or a person reads a superseded line beside a turn that
    // will announce something else.
    this.rewriteNotificationItem(subscriberId, waiting);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  /**
   * FOLD A RUN'S ENDING INTO THE RESULT IT ALREADY SENT — issue #590 half 2.
   * True when one was found and the wake is spoken for.
   *
   * THE SAME KEY AS EVERYWHERE ELSE: the session that acted and the run it
   * acted in. A peer's message names its sender's run on `agentSourceRunId`,
   * which is precisely the run the wake is about — so this is "the errand this
   * ending belongs to", not a guess from matching words.
   *
   * ONLY A TURN NOBODY HAS READ. `queued` is the whole condition: a turn that
   * has been claimed is in front of a model already, and one that ran is
   * history. Rewriting either would be editing something the recipient has
   * been told, which is a worse failure than a second row.
   *
   * `input` IS NOT TOUCHED, unlike `coalesceQueuedWake`'s rewrite. A wake's
   * prose is the engine's own and replaceable; a peer's message body is the
   * only copy there is, and `sessions_read` hands it back whole. The
   * notification is rewritten, the message is not, and no `wakeReason` is
   * stamped on — a peer's turn that started reading as a wake would be
   * coalescible, and the next coalesce would overwrite that body.
   */
  private mergeIntoWaitingResult(subscriberId: string, targetSessionId: string, notification: NotificationDetail, kind: WakeKind): boolean {
    // AN ENDING, NOT A PARKED REQUEST. "Someone is waiting on you" is a thing
    // to act on rather than an outcome, and folding it under a result would
    // hide the one notification a person is meant to answer.
    if (!TERMINAL_WAKE_KINDS.includes(kind)) return false;
    const queue = this.readQueue(subscriberId);
    const waiting = queue.turns.find(
      (candidate) =>
        candidate.state === "queued" &&
        candidate.origin === "session" &&
        !candidate.wakeReason &&
        candidate.notification?.kind === "peer_message" &&
        candidate.sender?.sessionId === targetSessionId &&
        candidate.agentSourceRunId === notification.runId,
    );
    if (!waiting?.notification) return false;
    /**
     * A MERGE IS A DELIVERY TOO — `coalesceQueuedWake`'s rule, for the same
     * reason: the waiting turn has already been announced, and past the cap the
     * newer fact goes to the mailbox rather than rewriting a row nobody has
     * read for a third time. The completion is not lost there — it stays
     * PENDING and `sessions_status` reports it.
     */
    const deliveries = (waiting.notification.deliveries ?? 1) + 1;
    if (deliveries > MAX_DELIVERIES) {
      this.holdNotification(subscriberId, notification);
      return true;
    }
    const at = this.now();
    const merged: NotificationDetail = { ...mergeRunOutcome(waiting.notification, notification), deliveries };
    waiting.notification = merged;
    // THE NOTICE AND THE NOTIFICATION ARE ONE STRING (#550). `agentNotice` is
    // derived from the body and nothing else, so a merge that moved one and
    // left the other is the drift that field exists to prevent.
    waiting.agentNotice = merged.body;
    waiting.updatedAt = at;
    this.writeQueue(subscriberId, queue);
    this.touchSession(subscriberId, at);
    this.rewriteNotificationItem(subscriberId, waiting);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  /* ---------------------------------------------------------------- *
   * THE NOTIFICATION MAILBOX — issue #550 clause 3.
   *
   * A wake used to be delivered the instant it was fired, whatever the
   * recipient was doing: a coordinator with four workers took four mid-turn
   * interruptions, each landing in a context already full of the work it
   * interrupted. `Subscription.completionWake` defaults to `settled_only`
   * because interrupting is the expensive choice and should be the asked-for
   * one, and this is where "not now" is kept until "now".
   * ---------------------------------------------------------------- */

  /** What this session has not been told yet. Absent file means an empty box —
   *  no migration, and a session that never held one costs nothing. */
  private readPendingNotifications(sessionId: string): NotificationDetail[] {
    const stored = this.readDocument(notificationsFile(this.paths, sessionId));
    if (stored === undefined) return [];
    const parsed = NotificationDetailSchema.array().safeParse((stored as { pending?: unknown }).pending);
    // A torn or older mailbox is DROPPED rather than thrown on. Unread mail is
    // worth less than the session it is attached to, and every fact in here is
    // still one `sessions_read` away from its source.
    return parsed.success ? parsed.data : [];
  }

  private writePendingNotifications(sessionId: string, pending: NotificationDetail[], heldSince?: number): void {
    this.writeDocument(notificationsFile(this.paths, sessionId), {
      version: STATE_VERSION,
      pending,
      ...(heldSince === undefined ? {} : { heldSince }),
    });
  }

  /**
   * WHEN THIS BOX STARTED WAITING — the report window's clock, issue #723.
   *
   * ON THE MAILBOX RATHER THAN THE SESSION, because it is a fact about the box:
   * stamped when a hold makes it non-empty, gone when a flush empties it, and
   * written by the same two functions that write `pending`. A copy on the
   * session record would be a second truth about one thing, drifting on the one
   * path that matters — a crash between the two writes.
   *
   * SO THE WINDOW OPENS ON THE FIRST HELD REPORT, not on a timer the engine
   * keeps running. A session with nothing waiting has no clock to be wrong
   * about, and "the next window is measured from the delivery" needs no code:
   * the flush clears the box, and the next report stamps a fresh one.
   *
   * ABSENT ON A BOX FILLED BEFORE THIS EXISTED, which `windowDueAt` reads as
   * "due now" rather than inventing a stamp — mail that has already been
   * waiting is not made fresher by the field arriving.
   */
  private heldSince(sessionId: string): number | undefined {
    const stored = this.readDocument(notificationsFile(this.paths, sessionId));
    if (stored === undefined) return undefined;
    const held = (stored as { heldSince?: unknown }).heldSince;
    return typeof held === "number" && Number.isFinite(held) ? held : undefined;
  }

  /** Is a turn of this session's actually in front of a provider right now? The
   *  question `settled_only` turns on — and `queued` is deliberately NOT busy:
   *  a queued wake is already waiting its turn, which is what holding is for. */
  private hasLiveTurn(sessionId: string): boolean {
    return this.scanQueue(sessionId).turns.some((turn) => turn.state === "claimed" || turn.state === "running" || turn.state === "steering");
  }

  /**
   * HOLD ONE, MERGING IT ONTO WHAT IS ALREADY WAITING.
   *
   * THE NEWEST FACT ABOUT ONE RUN WINS, which is `coalesceQueuedWake`'s rule
   * applied to the box rather than to the queue: a child that parks an approval,
   * gets it, then finishes has produced three facts about one run and only the
   * last is worth a recipient's attention. Different runs stay separate — a
   * failure on one turn is not erased by another turn finishing.
   *
   * BOUNDED, because a fan-out is exactly the shape that fills this. Past the
   * cap the OLDEST goes: a coordinator coming up for air after an hour wants
   * what happened recently, and the rest is still readable at its source.
   */
  private holdNotification(sessionId: string, detail: NotificationDetail): void {
    const pending = this.readPendingNotifications(sessionId);
    const index = pending.findIndex(
      (each) => each.kind === detail.kind && each.sessionId === detail.sessionId && each.runId === detail.runId,
    );
    if (index >= 0) pending[index] = detail;
    else pending.push(detail);
    // THE OLDEST WAIT IS WHAT THE WINDOW MEASURES, so an existing stamp is kept:
    // a newer report joining the cohort must not push the delivery back, or a
    // steady trickle of them would hold the box open for ever (#723).
    const heldSince = this.heldSince(sessionId) ?? this.now();
    this.writePendingNotifications(sessionId, pending.slice(-MAX_COHORT_ENTRIES), heldSince);
  }

  /**
   * DELIVER EVERYTHING HELD, AS ONE NOTIFICATION — the cohort merge.
   *
   * Called when a session settles, and when a wake arrives on one that is
   * already idle. ONE turn and ONE item for the whole cohort: four wakes that
   * arrived during a long turn are four lines in one notice, not four turns.
   *
   * SILENT WHEN THERE IS NOTHING TO SAY, and silent while the session is still
   * working — a flush that raced a claim would put a turn behind the very turn
   * it was waiting for, which is holding with extra steps.
   */
  private flushPendingNotifications(sessionId: string): void {
    const pending = this.readPendingNotifications(sessionId);
    if (pending.length === 0) return;
    if (this.hasLiveTurn(sessionId)) return;
    const merged = heldDelivery(mergeNotifications(pending));
    // CLEARED BEFORE THE SUBMIT, so a submit that throws cannot be retried into
    // a duplicate — and after it, the facts live on the turn, which is durable.
    this.writePendingNotifications(sessionId, []);
    const delivered: NotificationDetail = { ...merged, deliveries: 1 };
    try {
      this.submitTurn(sessionId, {
        runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
        input: notificationLabel(delivered),
        origin: "session",
        /**
         * The COHORT'S newest happening is what stamps the turn — the same one
         * whose fields lead the merged detail. A turn needs exactly one wake
         * reason and this is the honest choice of one.
         *
         * AND A PEER-LED COHORT CARRIES A SENDER INSTEAD (#631 part 2). A held
         * peer message is not a wake: nothing this session subscribed to did
         * anything, and the old `?? "turn_completed"` fallback would have told
         * the transcript, the phone and the inbox that some run finished. What
         * it IS is a message from the session that sent it, so that is what
         * stamps the turn — which is also the shape `submitTurn` insists on,
         * exactly one of a wake reason or a sender on a session-origin turn.
         */
        ...(merged.wakeKind
          ? {
              wakeReason: {
                kind: merged.wakeKind,
                sessionId: merged.sessionId ?? sessionId,
                ...(merged.runId ? { runId: merged.runId } : {}),
                ...(merged.requestId ? { requestId: merged.requestId } : {}),
              },
            }
          : { sender: merged.sessionId ? { sessionId: merged.sessionId } : {} }),
        notification: delivered,
      });
    } catch (error) {
      // Same contract as `fireSubscriptions`: the recipient's own state is not
      // worth breaking a delivery for, and the reason goes where a person looks.
      if (error instanceof EngineStateError && error.code === "conflict") {
        this.appendEvent(sessionId, { type: "runtime.warning", message: `held notifications could not be delivered: ${error.message}` });
        return;
      }
      throw error;
    }
  }

  /**
   * WHAT THIS SESSION HAS NOT BEEN TOLD — the "pollable" half of the cap.
   *
   * A notification the cap refused to queue a third time stays here, and this is
   * how `sessions_status` reports it: the result is not lost, it is simply not
   * being pushed at a session that has not read the last two.
   */
  pendingNotifications(sessionId: string): NotificationDetail[] {
    this.requireSession(sessionId);
    return structuredClone(this.readPendingNotifications(sessionId));
  }

  /** The other half of `writeNotificationItem`: the row a coalesce superseded. */
  private rewriteNotificationItem(sessionId: string, turn: Turn): void {
    const detail = turn.notification;
    if (!detail) return;
    const items = this.readItems(sessionId);
    const existing = items.get(`notification_${turn.runId}`);
    if (!existing) {
      this.writeNotificationItem(sessionId, turn);
      return;
    }
    const item: Item = { ...existing, title: detail.summary, detail: { type: "notification", notification: detail } };
    items.set(item.id, item);
    this.writeItems(sessionId, items, new Set([item.id]));
    this.appendEvent(sessionId, { type: "item.updated", item }, turn.runId);
  }

  /**
   * Withdraw every QUEUED wake from `targetSessionId` on `subscriberId` — what
   * an unsubscribe means when wakes have already piled up. Turns already
   * claimed or running stay; they are the worker's. Returns how many went.
   */
  private discardQueuedWakes(subscriberId: string, targetSessionId?: string): number {
    const queue = this.readQueue(subscriberId);
    const at = this.now();
    /**
     * `targetSessionId` NARROWS IT TO ONE SOURCE; omitting it means every wake
     * this session is still holding, whoever it was about — which is what a
     * session being decommissioned asks for, and what an unsubscribe must NOT
     * do.
     *
     * `wakeReason` IS THE WHOLE TEST OF "AUTOMATED", and it is exact rather than
     * convenient: a turn is `origin: "session"` for two different reasons, and
     * carries `wakeReason` for one of them and `sender` for the other (see
     * `Turn.origin`). A peer's task or report is somebody asking for work, and
     * it survives here for the same reason a human's queued message does.
     */
    const dropped = queue.turns.filter(
      (turn) =>
        turn.state === "queued" &&
        turn.origin === "session" &&
        turn.wakeReason !== undefined &&
        (targetSessionId === undefined || turn.wakeReason.sessionId === targetSessionId),
    );
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
    this.requireSession(sessionId);
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
   *
   * `deadlineMs` AND `default` ARE THE ASKER'S OWN TERMS — #541 D. They are
   * refused here rather than silently dropped, because a caller that believed it
   * had set a safe fallback and did not is worse off than one that was told no.
   * See `RequestDefault` and `defaultAllowed` in the contract for what may carry
   * one; `sweepRequestDeadlines` is what acts on them.
   */
  openRequest(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: {
      requestId: string;
      kind: RequestKind;
      detail: RequestDetail;
      itemId?: string;
      providerRefs?: EngineRequest["providerRefs"];
      deadlineMs?: number;
      default?: RequestDefault;
    },
  ): RequestOpenResult {
    assertId(input.requestId, "request id");
    if (input.deadlineMs !== undefined && (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0)) {
      throw new EngineStateError("invalid_request", "a request deadline is a positive whole number of milliseconds");
    }
    if (input.default !== undefined && !defaultAllowed(input.kind)) {
      throw new EngineStateError("invalid_request", `a ${input.kind} request may not carry a default — a deadline may not release a secret`);
    }
    /**
     * A DEFAULT WITH NO DEADLINE IS AN ANSWER NOTHING WILL EVER TAKE. Refused
     * rather than stored, on the same argument as the refusals above: it reads
     * as a safety net and is not one, and the caller is still here to be told.
     * The other direction is NOT an error — a deadline with no default is the
     * issue's own "requests with no default wait", and a caller may legitimately
     * state one so a client can show how long this has been sitting.
     */
    if (input.default !== undefined && input.deadlineMs === undefined) {
      throw new EngineStateError("invalid_request", "a request default needs a deadline for anything to take it");
    }
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
      /**
       * ONLY ON A REQUEST THAT ACTUALLY PARKED. One the mode resolved on the
       * spot was never waiting on anybody, so a clock on it would be a field
       * that measured nothing and a row the sweeper had to skip for ever.
       */
      ...(!automatic && input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      ...(!automatic && input.default !== undefined ? { default: input.default } : {}),
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

    /**
     * VALIDATE ON WRITE, TRUST ON READ — the other half of #545.
     *
     * This is the only place a request row is created, so this is the one
     * schema walk the row ever needs: `readRequests` used to re-run it over
     * every element of the whole history on every read, ten times a second.
     * ONCE PER ROW rather than once per row per read, and it still covers the
     * one field that is not built from a typed constant here — `detail`, which
     * an in-process caller hands over without passing a route's own parse.
     */
    const written = RequestSchema.safeParse(request);
    if (!written.success) throw new EngineStateError("invalid_request", "invalid request");
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
   *
   * AND IT IS AN INDEX LOOKUP PER CLAIMED SESSION, NOT A 33 MB PARSE — #545.
   * This was the single hottest path on an idle daemon: `readDocument` under
   * `readRequests` under here was 12.1% of an 8 s profile, because every beat
   * re-read and re-validated every request every session had ever opened to
   * find the nought-to-two a worker was actually blocked on.
   */
  resolutionsForWorker(workerId: string): WorkerStatus["resolved"] {
    assertId(workerId, "worker id");
    return [...this.liveQueueSessionIds()].flatMap((sessionId) => {
      const turns = this.scanQueue(sessionId).turns;
      const claimed = new Map(
        turns
          .filter((turn) => turn.claim?.workerId === workerId && turn.state === "running")
          .map((turn) => [turn.runId, turn] as const),
      );
      if (claimed.size === 0) return [];
      /**
       * AND THE INDEX IS TRIMMED HERE, where the liveness test is already in
       * hand. A resolved row stays indexed only while its run can still take
       * the answer; once the turn is no longer running under a claim, nothing
       * will ever poll for it again. Without this the map would keep every
       * resolution of a long-lived daemon — the unbounded growth the whole
       * change exists to remove. See `reindexRequests`.
       */
      this.trimResolvedRequests(sessionId, turns);
      return [...this.liveRequests(sessionId).values()]
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
            // AND SO DOES WHAT IT IS. The two stamps above say who; this says
            // the delivery is a notification, which is what lets the driver put
            // it on a channel that is not the person's. A promotion that
            // dropped it would make the SAME message honest when the recipient
            // was idle and a fake user message when it was busy — the asymmetry
            // #550 is closing.
            ...(turn.notification ? { notification: turn.notification } : {}),
          }),
        ];
      });
    });
  }

  /**
   * The journal above `after`, at most `limit` rows of it — issue #494.
   *
   * `limit` IS THE CALLER'S PAGE SIZE, and absent means the whole tail: the
   * route bounds what it serialises over HTTP, while an in-process fold that
   * genuinely needs the run (the export, `openItemPrefix`) asks without one and
   * is unchanged. The cursor check stays here rather than at any caller's seam
   * because this method owns it — see the sessions socket's capability.
   *
   * NO OFFSET, EVER. The window is keyed on the event id, so a page is the same
   * page whether or not rows were appended while the caller was reading, and a
   * client that resumes from the last id it saw can neither skip nor repeat.
   */
  readEvents(sessionId: string, after = 0, limit?: number): EngineEvent[] {
    this.requireSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new EngineStateError("invalid_request", "event limit is invalid");
    if (this.executionStore) return this.executionStore.events(sessionId, after, limit);
    const tail = readJournal(eventsFile(this.paths, sessionId)).filter((event) => event.id > after);
    return limit === undefined ? tail : tail.slice(0, limit);
  }

  /**
   * The id of the last event on the journal — "now", for a client that wants
   * to tail from the snapshot it just read rather than replay from zero.
   * Journals are append-only with strictly increasing ids, so the last complete
   * line is the answer; only its tail is read.
   */
  eventCursor(sessionId: string): number {
    this.requireSession(sessionId);
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
    /**
     * AND THE REQUESTS WRITTEN BEFORE THE WINDOW EXISTED ARE BROUGHT INSIDE IT.
     *
     * Last, after the sweeps above have resolved whatever the lost process left
     * open, so a request retired a moment ago is counted with the rest rather
     * than surviving this boot to be trimmed by the next one. Silent once the
     * store has been swept — see `pruneResolvedRequestHistory`.
     */
    const pruned = this.pruneResolvedRequestHistory();
    if (pruned.dropped > 0) {
      const freed = pruned.bytes >= 1e6 ? `${(pruned.bytes / 1e6).toFixed(1)} MB` : `${Math.round(pruned.bytes / 1e3)} KB`;
      console.log(`[engine] trimmed ${pruned.dropped} resolved requests out of ${pruned.sessions} session${pruned.sessions === 1 ? "" : "s"} (${freed}); the journal still holds every one of them.`);
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
    if (remaining.length !== deliveries.length) this.writeDocument(this.paths.taskStops, remaining);
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

  /**
   * THE WHOLE QUEUE, PARSED — and accounted for, which it was not (#547).
   *
   * `accountWholeRead` here rather than at the forty-odd call sites: this is
   * the one door every whole-queue read goes through, and an instrument a new
   * caller can forget to reach for is the instrument that read 0 = 0 while the
   * wall time doubled. `windowedTurns`' fallback used to account for itself and
   * no longer does, because this would then count it twice.
   */
  private readQueue(sessionId: string): SessionQueue {
    const file = sessionQueueFile(this.paths, sessionId);
    const stored = this.readDocument(file);
    // An absent document is an empty queue, not a read: nothing was fetched and
    // nothing parsed, and counting it would put a floor under every measurement
    // taken on a session that has never been written to.
    if (stored === undefined) return emptyQueue(sessionId);
    this.accountWholeRead(file);
    this.readAccounting.queueParses += 1;
    return parseQueue(stored, sessionId, this.executionStore?.owns(file) === true);
  }

  /** THE ONLY WRITER, which is what lets `liveQueueIndex` and `queueCache` be
   *  maintained in one place rather than at each of the thirteen transitions
   *  that call this. */
  private writeQueue(sessionId: string, queue: SessionQueue): void {
    /**
     * VALIDATE ON WRITE, SO THE READ CAN TRUST — issue #547, and #545's clause
     * for the queue at last.
     *
     * The schema walk runs HERE, once per write, instead of in `parseQueue`
     * once per read. A turn is written four times a turn and read nineteen on
     * the fixture #547's bench measures, so this moves zod off the hot side of
     * a 5:1 ratio — and it moves the failure to the moment a bad turn is built,
     * where the stack still names the transition that built it, rather than to
     * whichever unlucky read finds it later.
     *
     * THE WHOLE ARRAY, not the turns that moved. Knowing which turn a
     * transition touched means asking every transition to say so — thirteen
     * places to keep right, and the one that forgets is a corrupt row that
     * nothing catches. `parseQueue` keeps the structural guard for both
     * backends regardless; see there for what a document written outside this
     * process still has to satisfy.
     */
    if (!TurnSchema.array().safeParse(queue.turns).success) {
      throw new EngineStateError("invalid_request", "invalid session queue");
    }
    this.writeIndexedDocument(
      sessionQueueFile(this.paths, sessionId),
      sessionQueueIndexFile(this.paths, sessionId),
      queue,
      "turns",
      queue.turns.map((turn) => ({ key: turn.runId, tag: turn.state })),
      // CARRIED TO THE ROW'S FOLD (#547): this is the document, parsed, and the
      // fold at the end of this command would otherwise read it straight back.
      queue,
    );
    // INSIDE `writeQueue` BECAUSE IT IS THE ONLY WRITER — the same reason the
    // live index and the queue cache are maintained here rather than at each of
    // the thirteen transitions. A projection maintained at the call sites would
    // be a fourteenth thing to remember. See `reconcileTurnSummaries`.
    this.reconcileTurnSummaries(sessionId, queue);
    this.queueCache.delete(sessionId);
    this.announceQueueChange();
    /**
     * AND THE INDEXED RESOLUTIONS FOLLOW THE QUEUE (#545). `resolutionsForWorker`
     * trims them against the claims it holds, but it only ever visits sessions
     * in the live index — so a session that leaves it would keep whatever was
     * indexed at that moment for the life of the daemon. This is the same
     * liveness test against the queue that has just been written; OPEN rows are
     * deliberately untouched, because retiring one is `closeOpenRequests`'
     * decision and a session that quietly stopped reporting `blocked` is the
     * worse failure.
     */
    this.trimResolvedRequests(sessionId, queue.turns);
    if (!this.liveQueueIndex) return;
    if (queueConcernsAWorker(queue)) this.liveQueueIndex.add(sessionId);
    else this.liveQueueIndex.delete(sessionId);
  }

  /**
   * WHICH TURN ROWS THIS PROCESS HAS ALREADY FOLDED — the reconcile's memo.
   *
   * Sound for exactly the reason `queueCache` and `liveQueueIndex` are: one
   * writer, in this process, holding the daemon lock. Warmed from sqlite the
   * first time a session is written to, and emptied by the rollback path, where
   * the rows it names may no longer exist.
   *
   * WITHOUT IT THE RECONCILE IS A SELECT PER QUEUE WRITE, and a queue is written
   * several times per turn — on the dogfood store's largest session that is 686
   * rows read to discover that one of them moved. BOUNDED like `itemsCache` and
   * for its reason: an entry per session ever written would grow with the age of
   * the daemon. An evicted session simply pays the SELECT again.
   */
  private readonly foldedTurnStates = new Map<string, Map<string, Turn["state"]>>();
  private static readonly FOLDED_TURNS_LIMIT = 8;

  private knownTurnStates(sessionId: string): Map<string, Turn["state"]> {
    const cached = this.foldedTurnStates.get(sessionId);
    if (cached) return cached;
    const known = new Map<string, Turn["state"]>(
      (this.executionStore?.turnSummaryStates(sessionId) ?? []).map((row) => [row.runId, row.state as Turn["state"]]),
    );
    if (this.foldedTurnStates.size >= EngineStore.FOLDED_TURNS_LIMIT) {
      const oldest = this.foldedTurnStates.keys().next();
      if (!oldest.done) this.foldedTurnStates.delete(oldest.value);
    }
    this.foldedTurnStates.set(sessionId, known);
    return known;
  }

  /**
   * THE TURN PROJECTION, BROUGHT LEVEL WITH THE QUEUE JUST WRITTEN — issue #516.
   *
   * IT COMPARES STATES, IT DOES NOT REBUILD. A turn's row is a function of the
   * turn and its items, and both are settled by the transition that moved the
   * turn's state — so a row whose stored state matches the queue's is a row that
   * is already right. On an ordinary write that is zero rows re-folded; on the
   * write that ends a turn it is one.
   *
   * WHICH IS ALSO WHY A TURN GETS A ROW WHEN IT IS ACCEPTED. `queued` is a state
   * like any other, so the first write after a submit folds the turn and the
   * input line is searchable from that instant — no second hook, and no turn
   * that is invisible to `find` until it finishes.
   *
   * A ROW WHOSE TURN LEFT THE QUEUE GOES WITH IT. Nothing in the engine removes
   * a settled turn today, but a projection that could outlive its subject would
   * put a conversation in `find`'s answer that `outline` then cannot show.
   */
  private reconcileTurnSummaries(sessionId: string, queue: SessionQueue): void {
    const store = this.executionStore;
    if (!store) return;
    const known = this.knownTurnStates(sessionId);
    const stale = queue.turns.filter((turn) => known.get(turn.runId) !== turn.state);
    const live = new Set(queue.turns.map((turn) => turn.runId));
    const gone = [...known.keys()].filter((runId) => !live.has(runId));
    if (stale.length === 0 && gone.length === 0) return;
    // ONE ITEMS READ FOR THE WHOLE BATCH, by the index's own per-run spans —
    // `windowedItems`' route, for `windowedItems`' reason.
    const items = stale.length > 0 ? this.itemsForRuns(sessionId, new Set(stale.map((turn) => turn.runId))) : [];
    for (const turn of stale) {
      store.writeTurnSummary(summariseTurn(turn, items));
      known.set(turn.runId, turn.state);
    }
    for (const runId of gone) {
      store.deleteTurnSummary(sessionId, runId);
      known.delete(runId);
    }
  }

  /**
   * The items filed under `runs`, read as spans rather than as a document.
   *
   * `windowedItems` is the same read for the same reason; it is not reused
   * because it takes the caller's whole chosen set and this one is called from
   * inside a write, where the cached projection is the common case and the
   * indexed span is the fallback rather than the other way round.
   */
  private itemsForRuns(sessionId: string, runs: Set<string>): Item[] {
    if (this.itemsCache.has(sessionId)) return [...this.itemsById(sessionId).values()].filter((item) => runs.has(item.runId));
    if (this.itemsOnRows(sessionId)) return this.itemRowsOf(sessionId, [...runs]);
    const file = itemsFile(this.paths, sessionId);
    const index = this.documentIndex(file, itemsIndexFile(this.paths, sessionId));
    if (!index) return [...this.itemsById(sessionId).values()].filter((item) => runs.has(item.runId));
    const wanted = index.rows.filter((row) => runs.has(row.key));
    if (wanted.length === 0) return [];
    const parsed = ItemSchema.array().safeParse(this.readIndexedRows(file, wanted));
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return parsed.data.filter((item) => runs.has(item.runId));
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
    /**
     * AND THIS IS A WAKE, SO IT IS RECORDED AS ONE — issues #490, #586.
     *
     * The sweep cannot reach this case: it deletes the snooze outright, so a
     * pass arriving afterwards sees a session that never slept and `wokeAt()`
     * has nothing to answer from. Stamped BEFORE the deletes for that reason.
     *
     * THE MOMENT IS NOW, not `snoozedUntil`. Nothing expired here — work landed
     * on a sleeping conversation and that is what woke it, earlier than asked.
     * Reporting the scheduled time would date the wake to an hour that has not
     * happened yet.
     */
    const woken = session.snoozedUntil !== undefined;
    if (woken) session.wokeAt = this.now();
    delete session.snoozedUntil;
    delete session.snoozedAt;
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
    if (woken) this.appendEvent(sessionId, { type: "session.woke", wokeAt: session.wokeAt! });
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
   * Sound for the same reason the queue's is: one writer, in this process, and
   * REPLACED by `writeItems` rather than dropped — see the note there. The
   * entries are SHARED — a caller gets a Map of its own over the same `Item`
   * objects — which every caller already respects by replacing an item
   * (`items.set(id, {...old})`) rather than editing one in place. Nothing here
   * may edit an `Item` in place.
   *
   * BOUNDED, unlike the queue's, which prunes itself against the live index:
   * there is no equivalent index for items, and one entry per session ever read
   * would be ~98 MB on the dogfood store. The cap is the number of sessions
   * that can plausibly be streaming at once; past it the oldest goes.
   */
  private readonly itemsCache = new Map<string, Map<string, Item>>();
  private static readonly ITEMS_CACHE_LIMIT = 8;

  /** Hold a projection, evicting the oldest entry when the cap is reached.
   *  Both doors into the cache come through here — the read that parsed it and
   *  the write that produced it — so the bound holds whichever filled it.
   *  A session already held is REPLACED, never counted as a new entry: that
   *  would evict a streaming neighbour to make room for a row already there. */
  private cacheItems(sessionId: string, items: Map<string, Item>): void {
    if (!this.itemsCache.has(sessionId) && this.itemsCache.size >= EngineStore.ITEMS_CACHE_LIMIT) {
      const oldest = this.itemsCache.keys().next();
      if (!oldest.done) this.itemsCache.delete(oldest.value);
    }
    this.itemsCache.set(sessionId, items);
  }

  /**
   * IS THIS SESSION ON ROWS? — issue #658, and the one question the whole read
   * path turns on.
   *
   * The marker, never the presence of a document: after a migration there is no
   * `items.json`, and "no document" is also what a session that has never
   * opened an item looks like. Those two want opposite answers, and only the
   * marker can tell them apart. A store on JSON has no rows at all and is
   * always false here.
   */
  private itemsOnRows(sessionId: string): boolean {
    return this.executionStore?.itemsAreRows(sessionId) === true;
  }

  /** Set only while the open-path backfill runs — see `backfillTurnSummaries`.
   *  Migrating a session is right when somebody asked for it and wrong when a
   *  whole-store pass merely walked past it. */
  private suppressItemsMigration = false;

  /**
   * MOVE ONE SESSION TO ROWS, LAZILY AND ONCE — issue #658.
   *
   * WHEN IT IS FIRST READ, never on the open path. #646's own correction is the
   * precedent: its compaction sweep looked free in the constructor and cost 54 s
   * on the first launch after the update. This is per session and bounded by
   * that session's own size — 228 ms for the worst session on the dogfood store,
   * and the store's whole 194 MiB of `items.json` is ~2.7 s spread over 446
   * sessions, never paid at once.
   *
   * ONE TRANSACTION, MARKER INCLUDED — see `ExecutionStore.migrateItemsToRows`,
   * which is where that property lives. A kill part-way through leaves the blob
   * and no marker, which is a correct unmigrated session, and the next read
   * tries again.
   *
   * Takes the map the caller already has rather than reading one: both callers
   * reached this holding the whole projection, and fetching it again to store
   * it would be a second parse of the text they just parsed.
   */
  private migrateItemsToRows(sessionId: string, items: Map<string, Item>): void {
    this.executionStore!.migrateItemsToRows(
      sessionId,
      [...items.values()].map((item) => ({ id: item.id, runId: item.runId, value: JSON.stringify(item) })),
      // THE OFFSET INDEX GOES WITH THE DOCUMENT IT DESCRIBES. An index left
      // behind describes bytes that are not there, and `documentIndex` trusts
      // one whose recorded length matches — against an absent document that
      // comparison is `undefined === n`, false, so it would merely be dead
      // weight; deleted because dead weight in a store #646 is shrinking is
      // still weight.
      [itemsFile(this.paths, sessionId), itemsIndexFile(this.paths, sessionId)],
    );
  }

  /** THE CACHED PROJECTION ITSELF — read-only, and never handed to a caller.
   *  Keyed rather than listed so the one question the streaming path asks can be
   *  answered without building anything: see `hasItem`. */
  private itemsById(sessionId: string): Map<string, Item> {
    const cached = this.itemsCache.get(sessionId);
    if (cached) return cached;
    if (this.itemsOnRows(sessionId)) {
      const items = this.parseItemRows(this.executionStore!.itemRows(sessionId));
      this.cacheItems(sessionId, items);
      return items;
    }
    const file = itemsFile(this.paths, sessionId);
    const stored = this.readDocument(file);
    // An absent document is an empty projection, not a read — `readQueue`'s
    // rule, for the same reason: counting it would put a floor under every
    // measurement taken on a session that has never written an item.
    if (stored === undefined) return new Map();
    /**
     * COUNTED HERE, WHERE THE WHOLE DOCUMENT IS ACTUALLY PARSED — issue #658,
     * and #547's argument one document over.
     *
     * `readAccounting` says it measures "the span of `queue.json` /
     * `items.json` that reached `JSON.parse`", and this is the largest such
     * span there is: the ingest path reads items once per batch and parses
     * every row through `ItemSchema`. It was counted only from `windowedItems`,
     * so the read this cache exists to spare was invisible to the one
     * instrument built to price reads — which is how the projection could be
     * thrown away once per item event without any measurement noticing.
     *
     * Here rather than at the call sites, for the reason `readQueue` gives:
     * this is the one door every whole-projection read goes through, and an
     * instrument a new caller can forget to reach for is the instrument that
     * reads 0 = 0. `windowedItems`' own `accountWholeRead` went when this
     * arrived: its fallback reaches this read through `readItems`, and counting
     * it in both places would charge one parse twice.
     */
    this.accountWholeRead(file);
    this.readAccounting.itemParses += 1;
    const parsed = ItemSchema.array().safeParse((stored as { items?: unknown }).items);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    const items = new Map(parsed.data.map((item) => [item.id, item]));
    /**
     * THE FIRST READ IS THE MIGRATION — see `migrateItemsToRows`.
     *
     * Here as well as in `writeItems` because a session can be read for a long
     * time before it is next written — an archived conversation somebody opens
     * — and the blob is the thing being paid for. The map in hand is the map
     * the rows get, so the migration re-reads nothing it has not already
     * parsed, and after it the marker decides for every reader after this one.
     *
     * Only when there WAS a document: a session that has never opened an item
     * has nothing to move, and marking it here would write a metadata row on
     * every read of an empty projection. Its first `writeItems` marks it.
     */
    if (this.executionStore && !this.suppressItemsMigration) this.migrateItemsToRows(sessionId, items);
    this.cacheItems(sessionId, items);
    return items;
  }

  /** The stored rows, validated — the row shape's half of `itemsById`. One
   *  small parse per row instead of one large one over the whole document;
   *  measured the same or faster at 800 items, and zod is unchanged. */
  private parseItemRows(rows: string[]): Map<string, Item> {
    this.readAccounting.itemParses += 1;
    let bytes = 0;
    const seen: unknown[] = [];
    for (const row of rows) { bytes += Buffer.byteLength(row, "utf8"); seen.push(JSON.parse(row)); }
    // Counted like a whole-document read because that is what it is — the whole
    // projection, reaching `JSON.parse`. The shape changed; the price a reader
    // pays for asking for all of it did not, and an instrument that stopped
    // counting when the storage changed is #658's own trap (2).
    this.readAccounting.documentBytes += bytes;
    this.readAccounting.documentReads += 1;
    const parsed = ItemSchema.array().safeParse(seen);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return new Map(parsed.data.map((item) => [item.id, item]));
  }

  /**
   * The rows filed under `runs`, parsed — a WINDOW of the projection, which on
   * rows is a query rather than a byte range.
   *
   * Counted in `documentBytes` and NOT in `itemParses`: a window is not a whole
   * read, and conflating the two would let a regression that reads everything
   * hide inside a counter that says "one". Same split `readIndexedRows` makes
   * for the span it fetches.
   */
  private itemRowsOf(sessionId: string, runs: readonly string[]): Item[] {
    const rows = this.executionStore!.itemRowsForRuns(sessionId, runs);
    if (rows.length === 0) return [];
    let bytes = 0;
    const seen: unknown[] = [];
    for (const row of rows) { bytes += Buffer.byteLength(row, "utf8"); seen.push(JSON.parse(row)); }
    this.readAccounting.documentBytes += bytes;
    this.readAccounting.documentReads += 1;
    const parsed = ItemSchema.array().safeParse(seen);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid item projection");
    return parsed.data;
  }

  /**
   * DOES THIS ITEM EXIST — without building a caller's copy of the projection.
   *
   * `readItems` hands out a Map of its own, which is right for anything that
   * MUTATES items and wrong for the streaming path: a delta asks this one
   * question and changes nothing, and on a 327-item session the copy was 327
   * entries rebuilt per token-chunk to answer it. See `ingestDeltas`.
   *
   * ON ROWS AND COLD, IT IS ONE INDEXED SELECT (#658) — the primary key answers
   * it in microseconds without materialising anything. The cache still wins
   * when it is warm, which on a streaming turn it is; this is what a delta
   * arriving into a session nobody has read costs, and it used to be the whole
   * document.
   */
  private hasItem(sessionId: string, itemId: string): boolean {
    const cached = this.itemsCache.get(sessionId);
    if (cached) return cached.has(itemId);
    if (this.itemsOnRows(sessionId)) return this.executionStore!.hasItemRow(sessionId, itemId);
    return this.itemsById(sessionId).has(itemId);
  }

  private readItems(sessionId: string): Map<string, Item> {
    return new Map(this.itemsById(sessionId));
  }

  /**
   * THE SINGLE WRITER — one row per touched item on a migrated session, the
   * whole document everywhere else.
   *
   * `touched` is WHICH items moved, not whether any did. Its callers always
   * knew; they simply had nowhere to say it, because the blob had to be
   * rewritten whole regardless. On rows that set is the write: one `INSERT …
   * ON CONFLICT` per item, rather than the session's entire projection.
   *
   * Absent `touched` means "all of them" — what a caller that rebuilt the map
   * from somewhere other than a batch wants.
   *
   * NOTHING IN THIS FILE REMOVES AN ITEM, and the row path depends on it: an
   * item dropped from the map would leave its row behind, because an upsert of
   * what is present cannot notice what is missing. Every writer replaces
   * (`items.set(id, {...old})`) or adds. A future caller that needs to delete
   * one needs a delete here to go with it.
   */
  private writeItems(sessionId: string, items: Map<string, Item>, touched?: ReadonlySet<string>): void {
    if (this.executionStore) {
      // NOT ON ROWS YET — so this write is the migration. The map in hand is
      // the post-edit projection, which is exactly what the rows should hold,
      // and the blob it replaces goes in the same transaction. A session that
      // never had a blob takes this path once too: the DELETE finds nothing and
      // the marker is the whole of the work.
      if (!this.itemsOnRows(sessionId)) this.migrateItemsToRows(sessionId, items);
      else {
        const moved = touched ? [...touched].map((id) => items.get(id)).filter((item): item is Item => item !== undefined) : [...items.values()];
        this.executionStore.upsertItems(sessionId, moved.map((item) => ({ id: item.id, runId: item.runId, value: JSON.stringify(item) })));
      }
      this.cacheItems(sessionId, new Map(items));
      return;
    }
    const rows = [...items.values()];
    this.writeIndexedDocument(
      itemsFile(this.paths, sessionId),
      itemsIndexFile(this.paths, sessionId),
      { version: STATE_VERSION, items: rows },
      "items",
      // Keyed by the TURN, not the item: the window chooses turns, and an item
      // is wanted exactly when its turn is.
      rows.map((item) => ({ key: item.runId })),
    );
    /**
     * AND THE PROJECTION STAYS, instead of being thrown away — issue #658.
     *
     * This line used to be `itemsCache.delete`, which meant every item event
     * discarded the map this process had just finished writing. The next touch
     * — on a streaming turn, the next delta — re-read the document, re-parsed
     * it and re-validated every row through `ItemSchema.array()`: 0.21 ms per
     * item event on a 100-item session, 11.75 ms on a 7000-item one, on the
     * thread streaming tokens. The cache exists to spare exactly that read, and
     * dropping it here put the cost back once per item event.
     *
     * Safe to KEEP rather than only safe to drop, because the one way the entry
     * could come to disagree with sqlite is a rollback, and `executeCommand`
     * already clears the whole cache when a command throws. The store is the
     * single writer; nothing else can move the document underneath this.
     *
     * A COPY of the caller's map, not the map itself: `readItems` handed that
     * one out to be mutated, and aliasing it here would let the next caller's
     * edits reach the cache before a write agreed to them.
     */
    this.cacheItems(sessionId, new Map(items));
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
    // WHICH rows were settled, not how many — #658. The count is the caller's
    // answer; the set is the write.
    const closed = new Set<string>();
    for (const item of items.values()) {
      if (!runIds.has(item.runId) || item.status !== "inProgress") continue;
      const settled: Item = { ...item, status: "failed", completedAt: at };
      items.set(item.id, settled);
      this.appendEvent(sessionId, { type: "item.completed", item: settled }, item.runId);
      closed.add(item.id);
    }
    if (closed.size > 0) this.writeItems(sessionId, items, closed);
    return closed.size;
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
    const closed = new Set<string>();
    for (const item of items.values()) {
      if (item.runId !== runId || item.status !== "inProgress") continue;
      const settled: Item = { ...item, status: "failed", completedAt: at };
      items.set(item.id, settled);
      this.appendEvent(sessionId, { type: "item.completed", item: settled }, runId);
      closed.add(item.id);
    }
    if (closed.size > 0) this.writeItems(sessionId, items, closed);
    return closed.size;
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
    this.writeDocument(this.paths.taskStops, deliveries);
    if (pending.size > 0) this.pendingStopTasks.set(sessionId, pending);
    this.touchSession(sessionId, at);
    return closed.length;
  }

  private readTaskStopDeliveries(): Array<{ deliveryId: string; sessionId: string; providerTaskId: string; workerId: string; driver: ProviderDriverKind }> {
    const value = this.readDocument(this.paths.taskStops) ?? [];
    if (!Array.isArray(value) || value.some((row) => !row || typeof row.deliveryId !== "string" || typeof row.sessionId !== "string" ||
      typeof row.providerTaskId !== "string" || typeof row.workerId !== "string" || !["claude", "codex", "opencode"].includes(row.driver)))
      throw new EngineStateError("invalid_request", "invalid task-stop delivery store");
    return value;
  }

  taskStopsForWorker(workerId: string, acknowledged: string[] = []): WorkerStatus["stopTask"] {
    const pending = this.readTaskStopDeliveries();
    const ack = new Set(acknowledged);
    const remaining = pending.filter((delivery) => delivery.workerId !== workerId || !ack.has(delivery.deliveryId));
    if (remaining.length !== pending.length) this.writeDocument(this.paths.taskStops, remaining);
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

  /**
   * WHICH REQUESTS A LIVE RUN COULD STILL BE ABOUT — issue #545.
   *
   * The two hot readers each wanted a handful of rows and paid for the whole
   * history to get them. `requests.json` is the record of everything a session
   * has EVER been asked, and nothing pruned it: on the owner's store that was
   * 43,280 rows across 345 documents, 33 MB, of which exactly ZERO were open.
   * `readRequests` `JSON.parse`d one of those documents and then ran
   * `EngineRequest.array().safeParse` over every element — per claimed session
   * per 1 s heartbeat (`resolutionsForWorker`), and per live session per
   * live-list read and per `getSession` (`withActivityFrom`). Measured on the
   * running daemon: 12.1% + 3.7% + 3.2% of an 8 s profile, on an engine whose
   * answer to all of it was "nothing has changed".
   *
   * SO THE ANSWER IS HELD IN MEMORY AND THE DOCUMENT STAYS THE RECORD. The map
   * carries, per session, the requests a run that is still going could still be
   * about: every OPEN one, and every one this process has seen go open →
   * resolved. `withActivityFrom` wants the first set, `resolutionsForWorker` the
   * second, and both are single-digit sizes rather than five-figure ones.
   *
   * A RESTART NEEDS ONLY THE OPEN ONES, which is what makes the cold build
   * cheap and correct. A resolution is only ever deliverable to a run that is
   * `running` with a claim, and `recover()` stops every one of those at boot —
   * so nothing resolved before this process started can be pending for it.
   *
   * BUILT LAZILY, LIKE `liveQueueIndex`, and for its reason: a cold daemon pays
   * the scan once instead of on every question, and a store that is never asked
   * (most tests) pays nothing. `undefined` means "not built"; an empty map means
   * "built, and nothing is live".
   */
  private liveRequestIndex: Map<string, Map<string, EngineRequest>> | undefined;

  private static readonly NO_LIVE_REQUESTS: ReadonlyMap<string, EngineRequest> = new Map();

  private liveRequests(sessionId: string): ReadonlyMap<string, EngineRequest> {
    if (!this.liveRequestIndex) {
      const index = new Map<string, Map<string, EngineRequest>>();
      for (const id of this.storedSessionIds()) {
        const open = new Map<string, EngineRequest>();
        // An unreadable document must not stop the daemon booting: a session
        // whose requests cannot be parsed simply holds nothing open, exactly as
        // `readSessions` skips a session it cannot read.
        try {
          for (const request of this.readRequests(id).values()) {
            if (request.state === "open") open.set(request.id, structuredClone(request));
          }
        } catch { continue; }
        if (open.size > 0) index.set(id, open);
      }
      this.liveRequestIndex = index;
    }
    return this.liveRequestIndex.get(sessionId) ?? EngineStore.NO_LIVE_REQUESTS;
  }

  /**
   * THE INDEX IS MAINTAINED WHERE THE DOCUMENT IS WRITTEN, which is here and
   * nowhere else — the same argument `writeQueue` makes for `liveQueueIndex`.
   * Five call sites open, resolve and retire requests; a projection maintained
   * at each of them is a sixth thing to remember.
   *
   * A row already in the index STAYS while it is resolved, because that is the
   * resolution a blocked worker is polling for. It leaves when the run it
   * belongs to can no longer take one — see `resolutionsForWorker`, which has
   * the session's claims in hand, and `writeQueue`, which sees a session stop
   * concerning any worker at all.
   *
   * CLONED IN, so a caller that keeps editing the map it wrote cannot edit the
   * store's idea of what is open behind its own back.
   */
  private reindexRequests(sessionId: string, requests: Map<string, EngineRequest>): void {
    const index = this.liveRequestIndex;
    if (!index) return;
    const known = index.get(sessionId);
    const live = new Map<string, EngineRequest>();
    for (const request of requests.values()) {
      if (request.state === "open" || known?.has(request.id)) live.set(request.id, structuredClone(request));
    }
    if (live.size > 0) index.set(sessionId, live);
    else index.delete(sessionId);
  }

  /**
   * DROP THE RESOLUTIONS NOBODY CAN STILL BE WAITING FOR.
   *
   * A resolved row is in the index for one reason: a worker parked inside
   * `canUseTool` polls the heartbeat for it. The poll is only ever answered for
   * a turn that is `running` under a claim, so once the turn is anything else
   * the row is history and belongs in the document alone. Open rows are never
   * touched here — an open request outlives its turn until something retires it,
   * and that is `closeOpenRequests`' decision rather than this one's.
   */
  private trimResolvedRequests(sessionId: string, turns: Turn[]): void {
    const live = this.liveRequestIndex?.get(sessionId);
    if (!live) return;
    const answerable = new Set(turns.filter((turn) => turn.state === "running" && turn.claim).map((turn) => turn.runId));
    for (const [id, request] of live) {
      if (request.state !== "open" && !answerable.has(request.runId)) live.delete(id);
    }
    if (live.size === 0) this.liveRequestIndex?.delete(sessionId);
  }

  /**
   * The document, parsed and NOT re-validated — issue #545.
   *
   * Every row in here was written by `writeRequests` below from a value this
   * file built and `openRequest` validated once, at the moment it was created.
   * Re-running `EngineRequest.array().safeParse` over the history on every read
   * re-checks a shape that cannot have changed since — and it was the expensive
   * half of the hot path, because zod walks a discriminated union per row.
   *
   * THE STRUCTURAL GUARD STAYS, because a document edited behind the store's
   * back or written by an older engine must still fail as "invalid request
   * projection" rather than as an `undefined` somewhere downstream. It checks
   * the three fields every reader keys on, which is a property test per row
   * rather than a schema walk.
   */
  private readRequests(sessionId: string): Map<string, EngineRequest> {
    const stored = this.readDocument(requestsFile(this.paths, sessionId));
    if (stored === undefined) return new Map();
    const rows = (stored as { requests?: unknown }).requests;
    if (!Array.isArray(rows) || rows.some((row) => !isRequestRow(row))) {
      throw new EngineStateError("invalid_request", "invalid request projection");
    }
    return new Map((rows as EngineRequest[]).map((request) => [request.id, request]));
  }

  /**
   * AND THE ONLY WRITER IS WHERE THE WINDOW IS APPLIED (#545).
   *
   * Here rather than in `resolveRequest` because five call sites resolve a
   * request — a human answering, a policy, and three retire paths that cancel
   * in bulk when a turn ends — and a bound applied at four of them is a
   * document that grows through the fifth. See `pruneResolvedRequests`.
   */
  private writeRequests(sessionId: string, requests: Map<string, EngineRequest>): void {
    pruneResolvedRequests(requests);
    this.writeDocument(requestsFile(this.paths, sessionId), { version: STATE_VERSION, requests: [...requests.values()] });
    this.reindexRequests(sessionId, requests);
  }

  /**
   * THE BOOT SWEEP: bring documents written before the window existed inside it.
   *
   * `writeRequests` bounds every document it touches from now on, but a session
   * nobody writes to again keeps whatever it had — and the store this was
   * written for holds 345 of them. One pass, at boot, beside `recover()`'s other
   * retroactive cures; silent when there is nothing to do, so an engine that has
   * already been swept says nothing on every subsequent start.
   *
   * IT WRITES THROUGH THE ORDINARY PATH, so each trimmed document goes out with
   * its index row and its revision exactly as any other request write would.
   */
  private pruneResolvedRequestHistory(): { sessions: number; dropped: number; bytes: number } {
    let sessions = 0;
    let dropped = 0;
    let bytes = 0;
    for (const sessionId of this.storedSessionIds()) {
      let requests: Map<string, EngineRequest>;
      const file = requestsFile(this.paths, sessionId);
      try {
        requests = this.readRequests(sessionId);
      } catch {
        // One unreadable document must not stop the engine booting — the same
        // rule `readSessions` follows for a session it cannot parse.
        continue;
      }
      const before = this.documentBytes(file) ?? 0;
      const went = pruneResolvedRequests(requests);
      if (went === 0) continue;
      this.writeRequests(sessionId, requests);
      sessions += 1;
      dropped += went;
      bytes += before - (this.documentBytes(file) ?? 0);
    }
    return { sessions, dropped, bytes };
  }

  /** One observation → at most one journal record, plus its projection edit. */
  private journalObservation(
    sessionId: string,
    turn: Turn,
    observation: TurnObservation,
    projection: { items: Map<string, Item>; tasks: Map<string, Task>; itemsTouched: Set<string>; tasksTouched: boolean; turnTouched: boolean },
  ): void {
    const at = this.now();
    const items = projection.items;
    if (observation.kind === "usage") {
      this.appendEvent(sessionId, { type: "usage.updated", usage: observation.usage }, turn.runId);
      return;
    }
    if (observation.kind === "runtime.warning") {
      // Touches no projection: it is a line in the journal about the runtime,
      // not a row, a task or a turn field. Stamped with the run so the
      // transcript shows it where it happened.
      this.appendEvent(sessionId, { type: "runtime.warning", message: observation.message }, turn.runId);
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
      projection.itemsTouched.add(item.id);
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
    if (observation.kind === "prompt.drafted") {
      // A gesture, not state — the same judgement `display.opened` gets. The
      // prompt itself is already on the shelf, written through the engine's own
      // routes; this is the nudge that tells a composer to re-read it, and a
      // client replaying last week's journal must not be told to go looking for
      // a prompt that was sent six days ago.
      this.appendEvent(
        sessionId,
        {
          type: "prompt.drafted",
          promptId: observation.promptId,
          title: observation.title,
          ...(observation.forSessionId ? { forSessionId: observation.forSessionId } : {}),
        },
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
    projection.itemsTouched.add(item.id);
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
    /**
     * EVERY RECORD THAT NAMES A RUN IS THAT RUN'S LIVENESS — issue #813, and
     * this is the whole of the writing half. It costs a Map set on the engine's
     * hottest path and no I/O at all; `sweepStalledTurns` does the reading, and
     * `Turn.lastProgressAt` is where it lands durably. See `runProgress`.
     *
     * STAMPED FROM `this.now()` ONCE, below, so the ledger and the record it
     * came from carry the same instant rather than two readings of the clock.
     */
    const at = this.now();
    if (runId) this.runProgress.set(sessionId, { runId, at });
    // The head is read from disk ONCE per session per store, through the same
    // parse that validates every record and repairs a torn tail — so a restart
    // still recovers exactly as before. After that the daemon lock makes this
    // process the only writer, and the head is whatever it last wrote. Parsing
    // a 9 MB journal to learn one integer on every append was the cost that
    // made long sessions sluggish.
    if (this.executionStore) {
      const stored = {
        id: this.executionStore.cursor(sessionId) + 1,
        at,
        sessionId,
        ...(runId ? { runId } : {}),
        ...event,
      } as EngineEvent;
      // NO DIRECTORY, AND NO `eventsFile`. There is no journal file on this
      // backend — every other writer to `sessions/<id>/` goes through
      // `atomicWrite`, which makes its own — so the `mkdir` below was a syscall
      // per streamed token-chunk to guarantee a directory nothing would use.
      this.executionStore.append(stored);
      this.publish(stored);
      return stored;
    }
    const file = eventsFile(this.paths, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const head = this.journalHead.get(sessionId) ?? readJournal(file).at(-1)?.id ?? 0;
    const record = {
      id: head + 1,
      at,
      sessionId,
      ...(runId ? { runId } : {}),
      ...event,
    } as EngineEvent;
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
    this.publish(record);
    return record;
  }

  /**
   * TELL WHOEVER IS WATCHING — issue #586.
   *
   * AFTER THE WRITE, ON BOTH BACKENDS, AND NEVER BEFORE IT. A listener that
   * learned of an event the store had not yet durably appended could ask for it
   * and be told it does not exist — a feed that is AHEAD of the record is worse
   * than one that is behind, because a reader cannot recover from it by asking
   * again.
   *
   * A THROWING WATCHER MUST NOT TAKE DOWN THE TURN THAT WAS TALKING TO IT. The
   * socket on the other end is allowed to have gone, and its own route is what
   * tidies up when it notices.
   */
  private publish(event: EngineEvent): void {
    if (this.watchers.size === 0) return;
    for (const watcher of [...this.watchers]) {
      try {
        watcher(event);
      } catch {
        /* see above — the watcher's own route unsubscribes it */
      }
    }
  }

  /**
   * WATCH EVERY SESSION EVENT THIS PROCESS WRITES — issue #586.
   *
   * ONE EMITTER AT `appendEvent`, which is the single chokepoint every session
   * event already passes through on a process the daemon lock makes the only
   * writer. That is what makes this feed COMPLETE and TOTALLY ORDERED without
   * anybody having to remember to emit: a second call site would be a frame
   * that exists for some writes and not others, which is worse than no feed.
   *
   * A FRAME IS NEVER THE RECORD. Every frame here names a fact the reader can
   * re-derive from a cursor'd read of `/events` — which is what makes the feed
   * a latency optimisation over a poll rather than a second source of truth. A
   * phone that was asleep when a frame went out loses nothing by asking.
   */
  watch(listener: (event: EngineEvent) => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
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

/**
 * A LOCK WRITTEN BY ANOTHER MACHINE IS NEVER STALE — issue #630.
 *
 * `processExists` asks THIS kernel about a pid. That is a sound test for a
 * stale lock exactly as long as the state root can only ever have been locked
 * from here, which was true while it lived on the machine's own disk.
 *
 * A store on a removable volume can be carried to a second Mac, and pids are
 * small integers that every machine hands out from the same low range. So the
 * recorded pid being "alive" over there says nothing about here, and — the
 * dangerous direction — the recorded pid being dead HERE says nothing about a
 * daemon that is very much alive THERE. Without this check, plugging a drive
 * into a second machine while the first is still running breaks a live lock and
 * puts two daemons on one store, which is data loss with no warning.
 *
 * The hostname was already being written and never read. Reading it is the fix.
 * An unrecorded hostname (a lock from before this) is treated as ours, because
 * that is what it was.
 */
function lockHeldElsewhere(owner: { hostname?: string }): boolean {
  return typeof owner.hostname === "string" && owner.hostname !== "" && owner.hostname !== os.hostname();
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
      let owner: { pid?: number; hostname?: string } = {};
      let fingerprint: string | undefined;
      try {
        const stat = fs.statSync(paths.lock);
        fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        owner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number; hostname?: string };
      } catch {
        // A torn stale lock cannot establish a live owner. The retry below is
        // still guarded by unlink + O_EXCL and never replaces an active lock.
      }
      if (lockHeldElsewhere(owner)) {
        throw new EngineStateError("conflict", `engine state root is locked by ${owner.hostname}`);
      }
      /**
       * THE PID IS IN THE MESSAGE — issue #894, and it is the only copy anyone
       * downstream gets. `main.ts` prints this line beside the lock's path, and
       * the shell puts the pid in front of a person who now has to decide
       * whether the Telar already running is one they want.
       *
       * `(pid N)` rather than `by pid N`: `state.test.ts` distinguishes this
       * refusal from the cross-host one above by matching `/locked by/`, and a
       * message satisfying both regexes would make that assertion vacuous.
       */
      if (processExists(owner.pid ?? -1))
        throw new EngineStateError("conflict", `engine state root is already locked (pid ${owner.pid})`);
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
          const currentOwner = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: number; hostname?: string };
          // Re-checked inside the breaker window for the same reason the pid is:
          // the lock may have been replaced between the read above and here.
          if (current !== fingerprint || lockHeldElsewhere(currentOwner) || processExists(currentOwner.pid ?? -1)) continue;
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
