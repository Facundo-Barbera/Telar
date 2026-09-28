// engine state is intentionally a new island: every document lives below the
// explicit `<TELAR_HOME>/engine` root.  This module never imports legacy Telar
// storage, so starting the daemon cannot create a `chats.json`, cutover marker,
// or any other legacy mutation by accident.
import crypto from "node:crypto";
import { ExecutionStore, type ExecutionHousekeeping } from "./platform/db/execution-store";
import type { ScheduleRow, SessionIndexRow } from "./platform/db/tables";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoResolution,
  deadlineResolution,
  defaultAllowed,
  PROVIDER_CAPABILITIES,
  defaultInstanceIdForDriver,
  countsAsActivity,
  isBackgroundWork,
  isUnstatedEnding,
  type RetentionPolicy,
  type RetentionBucket,
  type JournalRetirement,
  workspaceBaseRef,
  workspacePath,
  STALLED_AFTER_MS,
  ModelSelection,
  type UsageLimitSource,
  resolveMcpServers,
  EngineRequest as RequestSchema,
  machineAllows,
  machineSettings,
  type ProjectPlugins,
  migrateLegacyPluginFields,
  assignmentsOf,
  // THE CLIENTS' OWN SETTLING RULE, imported rather than re-implemented: the
  // live list drops the rows a rail would shelve (#457), so an engine that
  // disagreed with a cockpit here would produce a conversation neither of them
  // shows. See `protocol/settling.ts`.
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
  Turn as TurnSchema,
  TurnObservation as TurnObservationSchema,
  WorkerTurnFailureCode as WorkerTurnFailureCodeSchema,
  type BrowserSnapshot,
  type GitCommitEntry,
  type GitHubCheckLog,
  type GitHubCommentResult,
  type GitHubReactionContent,
  type GitHubReactionResult,
  type GitHubThreadReplyResult,
  type GitHubThreadResolveResult,
  type GitHubLineCommentInput,
  type GitHubLineCommentResult,
  type GitHubPullAnchor,
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
  type Task,
  type TaskSeed,
  type Project,
  type EngineRequest,
  type RequestDecision,
  type RequestDefault,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type RequestResolver,
  type Session,
  type SessionSettleEnded,
  type Subscription,
  type Cohort,
  type SubscribedCohort,
  type Turn,
  type TurnFailure as TurnFailureShape,
  type TurnFailureCode,
  type TurnObservation,
  type WakeKind,
  type WakeReason,
  type UsageSnapshot,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
  type WorktreeInventory,
  type WorktreeReclaimItem,
  type WorktreeReclaimResult,
  seedSessionTitle,
  turnHasContent,
  CLAUDE_COMPACTION_ENV_NAMES,
  migrateClaudeCompaction,
  type DictationLanguage,
  type DictationProviderId,
} from "@telar/engine-client";
import { type ProjectPatch, ProjectProbes, ProjectRegistry, WorkspaceConfigStore } from "./domains/projects";
import { assertId, EngineStateError, Kernel, type JournalEntry } from "./platform/kernel";
import { SettingsStore } from "./domains/settings";
import { AppearanceStore } from "./domains/appearance";
import { type McpOAuthRecord, McpOAuthStore, McpServers, type OAuthClientStore, type PendingMcpOAuth } from "./domains/agent-tools";
import { installedCli, ModelCatalogues, ProviderRegistry, type InstalledCli, type ProviderInstanceInput } from "./domains/providers";
import { dataScienceBlock, latexBlock, PluginToolchains } from "./domains/plugins";
import { UsageLimitSources, type ResolvedUsageLimitSource, type UsageLimitSourceInput } from "./domains/usage";
import { type AttachmentInput, awaitsRateLimitSweep, createSessionModules, SessionAttachments, workspaceRootOf, delegationSettle, type DeliveryTurn, indexRow, isPeerMail, latestProviderSessionId, newestAssignment, OpenPrefixes, rowIsShelved, SessionActivity, sessionDir, SessionIndex, SessionItems, SessionMailbox, sessionMetadataFile, type SessionQueue, sessionQueueFile, sessionQueueIndexFile, SessionQueues, SessionRecords, SessionRequests, SessionLifecycle, SessionSubscriptions, SessionTasks, storedSession, TELAR_ORIENTATION, TERMINAL_WAKE_KINDS } from "./domains/sessions";
import { boundedOutline, context, FIND_SCAN, firstLine, GREP_CONTEXT_CHARS, heldDelivery, ITEM_TITLE_CHARS, MAX_DELIVERIES, mergeNotifications, mergeRunOutcome, notificationLabel, type OutlineRow, outlineRow, peerNotification, quotedExcerpt, RELAY_RULE, summariseTurn, TURN_ANSWER_NO_SUCH_RUN, TURN_ANSWER_NONE, wakeNotification, WHY_CHARS, withoutWakesFrom } from "./domains/turns";
import { cleanDictationVocabulary, dictationCredential, dictationLanguages, isDictationLanguage, isDictationProviderId, lastKeytermFit, readDictationKey, readDictationSettings, writeDictationKey, writeDictationSettings, type DictationContext, type KeytermFit } from "./domains/dictation";
import { withComputerUse, type ResolvedComputerUse } from "./domains/computer-use";
import { type ProjectIcon } from "./domains/appearance";
import { listWorkspaceFilesAsync, readFenced, readFencedAsync, readFencedBytes, writeFenced } from "./domains/files";
import { cloneRepository, commitSessionWork, defaultRemoteBaseAsync, ensureTelarGitignore, gitOverviewAsync, isCloneFailure, listGitRefsAsync, pullRequestBlockedBy, pushSessionBranch, removeTelarGitignore, sessionBranchFacts, sessionDiffAsync, sessionFilePatchAsync, type GitOverview } from "./domains/git";
import { porcelainPaths } from "./platform/git/parse";
import { type AttachedBrowser, SessionBrowser } from "./domains/browser";
import { GitHubStore, commentOnPullLine, defaultGhRunner, openPullRequest, readPullFiles, readPullForBranch, type GhRunner } from "./domains/github";
import {  } from "zod";
import { providerProcessEnv } from "./domains/providers";
import { adoptClaudeConversation, type Adoption, type ClaudeConversation, describeAdoption, describeImport, type ForkCut, listAdoptableConversations } from "./drivers/claude";
import { BUNDLED_MANIFEST, legacyLongSpelling, type ModelManifest, readModelCatalogue } from "./domains/providers";
import { adoptBinaryDir, type BootstrapRequest, canonicalName, type CompileStatus as LatexCompileMemory, type CreateEnvironmentRequest, DataScienceMachineSettings as DataScienceMachineSettingsSchema, declaredDependencies, discoverEnvironments, type DsCapability, DsFiles, environmentId, environmentRootOf, type EnvironmentRow, type EnvManager, findBinary, findLatexBinary, type InstallCommand, installCommandFor, installSteps, type JobRead, JobRunner, type KernelHost, type LatexBootstrapRequest, type LatexCapability, type LatexPackagesAnswer, type LatexToolchain, listPackages, listTexPackages, type ManagedTectonicStatus, NOTEBOOK_MAX_BYTES, type PackageInfo, planBootstrap, planEnvironment, planLatexBootstrap, preflightPython, projectRequirements, type PythonEnvironment, type PythonPreflight, relativisePythonPath, removeSteps, type RequirementsSource, requirementsStep, type ResolvedLatex, resolvePythonPath, storeDsCapability, storeLatexCapability, type TableWindow, TECTONIC_PACKAGES_NOTE, telarVenvDir, telarVenvPython, texInstallSteps, texRemoveSteps, type Toolchain, windowCsv } from "./domains/plugins";
import { decideSchedule, nextOccurrence, usableZone, type ScheduleRule } from "./domains/schedules";
import { WorktreeMaintenance, createWorktreeQueue, defaultWorktreeGitRunner, prepareSessionWorktree, derivedBranchFor, type WorktreePlan, type WorktreeQueue, type ReleaseRefusal, SETUP_STOP_GRACE_MS, WorktreeSetups, type MoveOutcome } from "./domains/worktrees";
import { defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, type GitResult, type GitRunner } from "./platform/git/runner";
import { CheckoutSizes, CleanupStore, copyStore, type CheckoutSizesOptions } from "./domains/storage";
import { pipeLauncher, processGroupFor } from "./domains/terminal";
import { findVolumeMount, mountSignature, type ProjectAvailability, type VolumeDeps } from "./platform/fs/volumes";

/** The human-facing one-liner for a parked request's notification. */
/**
 * THE WAKE TEXT — A PING, NOT A REPORT.
 *
 * It begins with `[wake: …]` so a model can tell it from a person, names the
 * peer, the turn and what happened, and then names the ONE call that fetches
 * the detail. It carries at most a bounded excerpt of a completed turn's answer
 * (`INLINE_CHARS`): a wake is injected into the subscriber's context whether or
 * not it needs the answer, and a child that wrote fifty kilobytes used to spend
 * that on every coordinator subscribed to it. The rest is one
 * `sessions_read(sessionId, runId)` away.
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
      lines.push(`[wake: completed] ${who} — turn ${turn.runId} completed.`);
      if (!text) {
        lines.push("It ended with no answer text.");
        break;
      }
      // A BOUNDED EXCERPT, not the whole answer (see `INLINE_CHARS`): enough
      // that the common case needs no read, and a large answer still costs
      // every subscriber little. The quoted words are a session's, so the relay
      // rule comes with them.
      const where = `sessions_read(sessionId: "${target.id}", runId: "${turn.runId}")`;
      lines.push(`It answered with ${text.length} characters.`, ...quotedExcerpt(text, where), RELAY_RULE, "—", "The same read has that run's events; its diff is sessions_diff.");
      return lines.join("\n");
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
 * How old the shell's `planned-restart.json` may be and still mean "this
 * restart". Ten minutes covers a slow update install and relaunch; past it the
 * marker describes some earlier restart — an update that never came back up,
 * found by a boot much later — and continuing work then would surprise
 * everybody. See `resumeAfterPlannedRestart`.
 */
const PLANNED_RESTART_WINDOW_MS = 10 * 60_000;

/** What the model is told on the turn that continues after an update restart.
 *  The engine's words, not the person's — see `Turn.origin`'s `restart`. */
const PLANNED_RESTART_CONTINUATION =
  "Telar restarted to install an update in the middle of your last turn. Check the current state before redoing anything that may already have happened, then continue.";


/** How much of a finished turn's answer rides in the wake that announces it.
 *  The whole answer is one `sessions_read` away; the wake is a summons. */
/**
 * The clamp on any single line a wake carries — a failure message, a request's
 * prompt, a field label. Not a budget for a result: a wake carries no result at
 * all (see `wakeMessage`), and this only keeps a pathological one-liner from
 * becoming the notice.
 */
const MAX_WAKE_LINE_CHARS = 240;

/**
 * ENDED BY A WORKER GOING AWAY, as a quit ends it — `cutOffByTelar` minus
 * `engine_restart`, which a boot also stamps on backlog that never ran.
 */
function endedByShutdown(turn: Turn): boolean {
  if (turn.state === "stopped") return turn.stopReason === "worker_unavailable";
  return turn.state === "failed" && turn.failure?.code === "interrupted";
}

/**
 * THE STATES IN WHICH A RESULT HAS REACHED THE MODEL — issue #919.
 *
 * `queued` is deliberately absent: a result nobody has read is what
 * `mergeIntoWaitingResult` folds the completion into. Every state here means
 * the result's turn was handed to a worker (`claimed`, `running`), has already
 * run (`completed`), or was folded into a turn the model was in the middle of
 * (`steering`, `steered`). A `failed`, `stopped`, `ambiguous` or `discarded`
 * result is one the coordinator did NOT get to read, so its run's completion
 * still wakes.
 */
/** The intents that speak for the run that sent them — see `messageDeliveredTo`. */
const FOLDING_INTENTS: ReadonlySet<NonNullable<Turn["agentIntent"]>> = new Set(["report", "result", "blocker"]);
const RESULT_DELIVERED_STATES: ReadonlySet<Turn["state"]> = new Set(["claimed", "running", "steering", "steered", "completed"]);


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

function boundedRequests(all: EngineRequest[], chosen?: Set<string>): EngineRequest[] {
  const carried = chosen === undefined ? all : all.filter((request) => chosen.has(request.runId) || request.state === "open");
  const settled = carried.filter((request) => request.state !== "open");
  if (settled.length <= SNAPSHOT_SETTLED_REQUESTS) return carried;
  const dropped = new Set(settled.slice(0, settled.length - SNAPSHOT_SETTLED_REQUESTS));
  return carried.filter((request) => !dropped.has(request));
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
): { chosen: Set<string>; page: { before: string | null; more: boolean; total: number } } {
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
    page: { before: start > 0 ? (paged[0]?.key ?? null) : null, more: start > 0, total: rows.length },
  };
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


/** Per turn, so one message cannot smuggle 16 × 20 MB past the per-file cap. */
const MAX_TURN_ATTACHMENTS = 16;

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

import { statePaths, type EngineStatePaths } from "./platform/fs/state-paths";
import type { ReapCandidate } from "./domains/storage";
export { EngineStateError };


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

function assertText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new EngineStateError("invalid_request", "turn text must be non-empty and within the allowed size");
  }
}

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
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;


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
  // A settled row's hover says why its terminals are gone (#883).
  ...(session.terminalsClosed === undefined ? {} : { terminalsClosed: session.terminalsClosed }),
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
 * A task that has not ended — still inside the process, whether or not it is
 * moving. Wider than the contract's `countsAsActivity`, on purpose: a paused
 * task is not activity, but it is still work in flight and still a row a cold
 * provider process must be seeded with.
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

/**
 * The session's terminals as the STORE is allowed to see them — the run
 * manager, narrowed. `openCount` knows only the terminals the engine opened
 * (runs and the agent's); `closeSession` reaches the person's shells too,
 * because the desktop host closes by session.
 */
export type AttachedTerminals = {
  openCount(sessionId: string): number;
  openSessions(): string[];
  /** `by` is "person" only when the person asked; Telar otherwise. */
  closeSession(sessionId: string, by?: "telar" | "person"): Promise<number>;
  /**
   * The HOST's count per session, the person's shells included (#883). Absent
   * means this engine's own terminals are all there are.
   */
  sessionCounts?(): Promise<Record<string, number>>;
};

/**
 * HOW LONG A CLOCK-SETTLED SESSION KEEPS ITS TERMINALS — issue #883. The same
 * 30 minutes #807 gives unattended background work: long enough that a
 * conversation which merely aged out does not lose its dev server under
 * somebody who was still using it, short enough that a day of settled
 * conversations does not become the machine.
 */
export const SETTLED_TERMINAL_GRACE_MS = 30 * 60_000;

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
  private readonly kernel: Kernel<EngineNotifier>;
  private readonly settings: SettingsStore;
  private readonly appearance: AppearanceStore;
  private readonly mcpOAuth: McpOAuthStore;
  private readonly mcpServers: McpServers;
  private readonly providers: ProviderRegistry;
  private readonly usageSources: UsageLimitSources;
  private readonly projectProbes: ProjectProbes;
  private readonly projectRegistry: ProjectRegistry;
  private readonly toolchains: PluginToolchains;
  private readonly github: GitHubStore;
  private readonly browser: SessionBrowser;
  private readonly worktrees: WorktreeMaintenance;
  private readonly attachments: SessionAttachments;
  private readonly catalogues: ModelCatalogues;
  private readonly records: SessionRecords;
  private readonly sessionItems: SessionItems;
  private readonly prefixes: OpenPrefixes;
  private readonly sessionRequests: SessionRequests;
  private readonly sessionTasks: SessionTasks;
  private readonly sessionQueues: SessionQueues;
  private readonly mailbox: SessionMailbox;
  private readonly sessionIndex: SessionIndex;
  private readonly activity: SessionActivity;
  private readonly subscriptions: SessionSubscriptions;
  private readonly lifecycle: SessionLifecycle;

  private registerCacheHooks(): void {
    this.kernel.onRollback(() => this.kernel.runProgress.clear());
    this.kernel.onSessionDeleted((id) => this.kernel.runProgress.delete(id));
    this.kernel.onSessionDeleted((id) => this.subscriptions.dropSubscriptionsOf(id));
  }
  private readDocument(file: string): unknown | undefined {
    return this.kernel.readDocument(file);
  }
  private writeDocument(file: string, value: unknown, mode?: number): void {
    this.kernel.writeDocument(file, value, mode);
  }

  sessionsRevision(options: { all?: boolean } = {}): number {
    return this.sessionIndex.revision(options.all === true);
  }

  /**
   * WHAT THE EXECUTION STORE SWEPT WHEN IT OPENED — issue #457, step 4.
   *
   * Command receipts past their retention, and the JSON the sqlite import
   * replaced once sqlite has owned the store a week. Surfaced so the daemon can
   * SAY it: both sweeps delete things nothing can reach, so without a line in
   * the log the only evidence a person has that a quarter of a gigabyte went
   * away is that it is gone.
   */
  executionHousekeeping(): ExecutionHousekeeping | undefined {
    return this.kernel.executionStore.housekeeping;
  }

  /**
   * COMPACT THE JOURNAL AND GIVE THE PAGES BACK — issue #646, and only on ask.
   *
   * The sweep runs itself; the VACUUM behind this does not, because it rewrites
   * the database under an exclusive lock (7 s on the owner's gigabyte) to
   * return space that accrues over a month. See `ExecutionStore.reclaim`.
   */
  reclaimExecutionStore(): { before: number; after: number; deltas: number; starts: number; sessions: number; usage: number } {
    return this.kernel.executionStore.reclaim();
  }

  get readAccounting(): Kernel["readAccounting"] {
    return this.kernel.readAccounting;
  }

  private writeIndexedDocument(file: string, indexFile: string, value: unknown, property: string, rows: Array<{ key: string; tag?: string }>, written?: SessionQueue): void {
    this.kernel.writeIndexedDocument(file, indexFile, value, property, rows, written);
  }

  closeExecutionStore(): void { this.kernel.executionStore.close(); }
  executeCommand<T>(command: string, action: () => T, commandId?: string): T {
    return this.kernel.command(command, action, commandId);
  }

  readonly paths: EngineStatePaths;
  /** How each project's worktrees are prepared — see `workspace-config.ts`. */
  readonly workspace: WorkspaceConfigStore;
  /** Each worktree's `setup.command`, run in the background after a cut. */
  readonly setups: WorktreeSetups;
  /** Settings → Storage's automatic cleanup — see `cleanup.ts`. */
  readonly cleanup: CleanupStore;
  /** See the constructor option: the claims a Stop just killed, handed to the
   *  in-process worker so the abort does not ride a poll. */
  private readonly onTurnsStopped?: (cancellations: StoppedClaim[]) => void;
  /** See the constructor: daemon-injected, absent means no computer use. */
  private readonly computerUse?: (() => ResolvedComputerUse | undefined) | undefined;
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
   * EVERY CHECKOUT'S SIZE, MEASURED IN THE BACKGROUND and shared by the two
   * surfaces that show one — the storage row and the inventory's rows — so they
   * cannot disagree and a checkout is never walked twice.
   */
  readonly checkoutSizes: CheckoutSizes;
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


  noteForNextTurn(sessionId: string, note: string): void {
    this.mailbox.noteForNextTurn(sessionId, note);
  }

  attachBrowser(browser: AttachedBrowser): void {
    this.browser.attach(browser);
  }

  /**
   * The daemon's run manager, attached like the browser and for the same
   * reason. Absent means this store knows of no terminals: settling closes
   * none, and nothing is held busy by one.
   */
  private terminals?: AttachedTerminals;

  attachTerminals(terminals: AttachedTerminals): void {
    this.terminals = terminals;
  }

  releaseSessionWorktree(
    sessionId: string,
    reason: "manual" | "inactive" | "unchanged" | "archived",
    options: { strict?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; refusal: ReleaseRefusal | "in-use" | "not-worktree"; detail?: string }> {
    return this.worktrees.release(sessionId, reason, options);
  }

  runCleanup(): Promise<void> {
    return this.worktrees.runCleanup();
  }

  isCleanupRunning(): boolean {
    return this.worktrees.isCleanupRunning();
  }

  restoreSessionWorktree(sessionId: string): Session {
    return this.worktrees.restore(sessionId);
  }

  private settleWorktree(sessionId: string, failure: string | undefined): void {
    this.worktrees.settle(sessionId, failure);
  }

  reapableWorktrees(): ReapCandidate[] {
    return this.worktrees.reapable();
  }

  lockLiveWorktrees(): { locked: number } {
    return this.worktrees.lockLive();
  }

  moveWorktrees(destination: string): Promise<MoveOutcome> {
    return this.worktrees.move(destination);
  }

  worktreeInventory(): Promise<WorktreeInventory> {
    return this.worktrees.inventory();
  }

  reclaimWorktrees(items: readonly WorktreeReclaimItem[]): Promise<WorktreeReclaimResult[]> {
    return this.worktrees.reclaim(items);
  }

  private worktreeMaintenance(): WorktreeMaintenance {
    return new WorktreeMaintenance(this.kernel, {
      records: this.records,
      git: this.worktreeGit,
      queue: this.worktreeQueue,
      cleanup: this.cleanup,
      checkoutSizes: this.checkoutSizes,
      getProject: (id) => this.getProject(id),
      listProjects: () => this.listProjects(),
      availability: (project) => this.projectAvailability(project),
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      setupRunning: (id) => this.setups.isRunning(id),
      startSetup: (id, worktree) => this.startWorktreeSetup(id, worktree),
      openTerminals: (id) => this.terminals?.openCount(id) ?? 0,
      hasLiveBackgroundWork: (id) => this.hasLiveBackgroundWork(id),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      archiveSession: (id, options) => this.archiveSession(id, options),
    });
  }

  /**
   * WHAT THE TERMINAL HOST LAST SAID EACH SESSION HOLDS — issue #883.
   *
   * The rail draws it, Settle counts it, and the settled limit sums it, so it
   * is asked for when something changes rather than per row or on a timer: a
   * settle or close, one of the engine's own terminals opening or ending (the
   * daemon wires `RunManager.watch`), and the five-minute settled sweep. A
   * shell the person opens is seen at the next of those; `terminalCount` also
   * takes the engine's own live records, so a run is never under-counted.
   */
  private terminalCensus = new Map<string, number>();
  private censusTask?: Promise<void>;
  private censusAgain = false;

  /** Ask the host again. Callers in flight share one read, and one more if they arrived during it. */
  refreshTerminalCensus(): Promise<void> {
    if (!this.terminals) return Promise.resolve();
    if (this.censusTask) {
      this.censusAgain = true;
      return this.censusTask;
    }
    this.censusTask = (async () => {
      do {
        this.censusAgain = false;
        const terminals = this.terminals!;
        let counts: Record<string, number>;
        try {
          counts = terminals.sessionCounts
            ? await terminals.sessionCounts()
            : Object.fromEntries(terminals.openSessions().map((sessionId) => [sessionId, terminals.openCount(sessionId)]));
        } catch {
          // The host is out of reach: what it last said stands.
          return;
        }
        this.applyTerminalCensus(counts);
      } while (this.censusAgain);
    })().finally(() => {
      this.censusTask = undefined;
    });
    return this.censusTask;
  }

  private applyTerminalCensus(counts: Record<string, number>): void {
    const changed = new Set<string>();
    for (const [sessionId, count] of this.terminalCensus) if ((counts[sessionId] ?? 0) !== count) changed.add(sessionId);
    for (const [sessionId, count] of Object.entries(counts)) if ((this.terminalCensus.get(sessionId) ?? 0) !== count) changed.add(sessionId);
    this.terminalCensus = new Map(Object.entries(counts).filter(([, count]) => count > 0));
    // A count is on the row's answer, so a change must move the cursor of the
    // list that row is on, or a conditional read would call it unchanged.
    const at = this.sessionIndex.settlingClock();
    for (const sessionId of changed) {
      try {
        this.sessionIndex.bumpRow(indexRow(this.records.get(sessionId)), at);
      } catch {
        // A session the host knows and this store does not is not on any list.
      }
    }
  }

  /** Every session the host or the engine says has a terminal open. */
  private censusSessions(): string[] {
    return [...new Set([...this.terminalCensus.keys(), ...(this.terminals?.openSessions() ?? [])])];
  }

  /** How many terminals this session holds, whoever opened them, as last known. */
  terminalCount(sessionId: string): number {
    return Math.max(this.terminalCensus.get(sessionId) ?? 0, this.terminals?.openCount(sessionId) ?? 0);
  }

  /** The census for the rows of one answer: sessions with one or more, only. */
  private terminalsFor(sessionIds: Iterable<string>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const sessionId of sessionIds) {
      const count = this.terminalCount(sessionId);
      if (count > 0) counts[sessionId] = count;
    }
    return counts;
  }

  /**
   * WHAT SETTLE WOULD CLOSE, ASKED NOW — the cockpit's menu, as it opens (#883).
   * One read of the host; the answer also refreshes what the rail is told.
   */
  async sessionTerminalCount(sessionId: string): Promise<number> {
    this.records.get(sessionId);
    await this.refreshTerminalCensus();
    return this.terminalCount(sessionId);
  }

  /**
   * THE PERSON CLOSES A SESSION'S TERMINALS — a settled row's "close them"
   * (#883). The host's `/close-session`, as a settle makes it, but recorded as
   * the person's: they pressed it, and an agent that was watching one of them
   * is told so on its next turn, as for any close of theirs.
   */
  async closeSessionTerminals(sessionId: string): Promise<number> {
    this.records.get(sessionId);
    if (!this.terminals) return 0;
    let closed: number;
    try {
      closed = await this.terminals.closeSession(sessionId, "person");
    } catch (error) {
      throw new EngineStateError("conflict", `Telar could not close this session's terminals: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refreshTerminalCensus();
    return closed;
  }

  /**
   * SAY THAT TELAR CLOSED THEM, ON THE SESSION ITSELF — `Session.terminalsClosed`.
   * Written like `applyDelegationSettle` writes its reason: `updatedAt` is not
   * touched, because closing a settled session's terminals is not work it did
   * and must not pull it off the shelf.
   */
  private recordTerminalsClosed(sessionId: string, terminals: number, reason: "grace" | "limit"): void {
    if (terminals <= 0) return;
    try {
      const next: Session = { ...this.records.get(sessionId), terminalsClosed: { at: this.now(), terminals, reason } };
      this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(next));
      this.appendEvent(sessionId, { type: "session.updated", session: next });
    } catch {
      // The terminals are closed either way; a record that could not be kept
      // costs the explanation, not the close.
    }
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
    const session = this.records.get(sessionId);
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
      readFile: (target) => readFenced(workspaceRootOf(session), target, "session workspace", NOTEBOOK_MAX_BYTES),
      writeFile: (target, text, expected) => writeFenced(workspaceRootOf(session), target, text, expected, "session workspace", NOTEBOOK_MAX_BYTES),
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

  resolveDataScience(session: Session): { pythonPath: string } | undefined {
    return this.toolchains.resolveDataScience(session);
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
    const session = this.records.get(sessionId);
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

  resolveLatex(session: Session): ResolvedLatex | undefined {
    return this.toolchains.resolveLatex(session);
  }

  managedTectonic(): ManagedTectonicStatus {
    return this.toolchains.managedStatus();
  }

  installManagedTectonic(): Promise<ManagedTectonicStatus> {
    return this.toolchains.installManaged();
  }

  /** The kernel host reporting a state change; journaled so the panel's pill follows it. */
  recordKernelState(sessionId: string, state: "starting" | "idle" | "busy" | "restarting" | "dead", reason?: string): void {
    try {
      this.records.require(sessionId);
    } catch {
      return; // a kernel outliving its session has nowhere to report
    }
    this.appendEvent(sessionId, { type: "kernel.state.changed", state, ...(reason ? { reason } : {}) });
  }

  /**
   * A WINDOW OF ROWS from a CSV, TSV or Parquet file in the session's tree.
   * CSV is parsed here; Parquet goes through the kernel (pyarrow), so it needs
   * data science on. The fence is `readFenced`'s.
   */
  async sessionTable(sessionId: string, target: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }): Promise<TableWindow> {
    const session = this.records.get(sessionId);
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
    const file = readFenced(workspaceRootOf(session), target, "session workspace");
    if (file.binary) throw new EngineStateError("invalid_request", "that file is not text");
    return { path: target, ...windowCsv(file.text, /\.tsv$/i.test(target) ? "\t" : ",", options), ...(file.truncated ? { truncated: true } : {}) };
  }

  listAttachments(sessionId: string, options: { tag?: string } = {}): TurnAttachment[] {
    return this.attachments.list(sessionId, options);
  }

  attachmentBytes(sessionId: string, attachmentId: string): { attachment: TurnAttachment; data: Uint8Array } {
    return this.attachments.bytes(sessionId, attachmentId);
  }

  tagAttachment(sessionId: string, attachmentId: string, tags: string[]): TurnAttachment {
    return this.attachments.tag(sessionId, attachmentId, tags);
  }

  recordBrowserControl(sessionId: string, controller: "agent" | "human" | "idle", tabId?: string, interrupted = false): void {
    this.browser.recordControl(sessionId, controller, tabId, interrupted);
  }

  browserState(sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}): Promise<BrowserSnapshot> {
    return this.browser.state(sessionId, options);
  }

  browserOpen(sessionId: string, url: string): Promise<BrowserSnapshot> {
    return this.browser.open(sessionId, url);
  }

  listMcpServers(scope?: { projectId: string | null }): McpServer[] {
    return this.mcpServers.list(scope);
  }

  saveMcpServer(input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: unknown }): McpServer {
    return this.mcpServers.save(input);
  }

  removeMcpServer(id: string, projectId?: string): boolean {
    return this.mcpServers.remove(id, projectId);
  }

  getInboxPolicy(): InboxPolicy {
    return this.settings.inbox();
  }

  setInboxPolicy(patch: { autoSettleAfterHours?: unknown; settleDelegatedAfterHours?: unknown; settledTerminalLimit?: unknown }): InboxPolicy {
    const next = this.settings.setInbox(patch);
    // A lower limit applies now rather than at the next sweep.
    if (patch.settledTerminalLimit !== undefined && this.terminals) {
      void Promise.resolve().then(() => this.enforceSettledTerminalLimit()).catch(() => undefined);
    }
    return next;
  }

  /** A consistent copy of this store, without the reproducible tier, to open instead of the live one. */
  copyStoreTo(destination: string): { root: string; files: number; bytes: number } {
    return copyStore(this.paths.root, this.kernel.executionStore, destination);
  }

  getRetentionPolicy(): RetentionPolicy {
    return this.settings.retention();
  }

  setRetentionPolicy(patch: { idleAfterDays?: unknown; exportTo?: unknown }): RetentionPolicy {
    return this.settings.setRetention(patch);
  }

  retentionPreview(options: { bytes?: boolean } = {}): RetentionBucket[] {
    return this.settings.retentionPreview(options);
  }

  sweepRetention(): JournalRetirement {
    return this.settings.sweepRetention();
  }

  getAgentOrientation(): AgentOrientation {
    return this.settings.orientation();
  }

  setAgentOrientation(patch: { preamble?: unknown; skill?: unknown }): AgentOrientation {
    return this.settings.setOrientation(patch);
  }

  getSessionDefaults(): SessionDefaults {
    return this.settings.sessionDefaults();
  }

  setSessionDefaults(patch: { envMode?: unknown; resumeAfterRestart?: unknown; runtimeMode?: unknown; resumeAfterRateLimit?: unknown }): SessionDefaults {
    return this.settings.setSessionDefaults(patch);
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
    const projects = this.projectRegistry.read().projects;
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

  getSidebarLayout(): SidebarLayout {
    return this.settings.sidebarLayout();
  }

  setSidebarLayout(patch: { projectOrder?: unknown; sessionOrder?: unknown; pinnedOrder?: unknown; mode?: unknown }): SidebarLayout {
    return this.settings.setSidebarLayout(patch);
  }

  getTextGenPolicy(): TextGenPolicy {
    return this.settings.textGen();
  }

  setTextGenPolicy(patch: { titles?: unknown; renameBranches?: unknown; driver?: unknown; model?: unknown }): TextGenPolicy {
    return this.settings.setTextGen(patch);
  }


  getAppearance(): { updatedAt: number; blob: Record<string, unknown> } | null {
    return this.appearance.get();
  }

  setAppearance(blob: unknown): { updatedAt: number; blob: Record<string, unknown> } {
    return this.appearance.set(blob);
  }

  clearAppearance(): void {
    this.appearance.clear();
  }

  getMcpOAuthRecord(serverId: string, projectId?: string): McpOAuthRecord | undefined {
    return this.mcpOAuth.get(serverId, projectId);
  }

  putMcpOAuthRecord(record: McpOAuthRecord): void {
    this.mcpOAuth.put(record);
  }

  deleteMcpOAuthRecord(serverId: string, projectId?: string): boolean {
    return this.mcpOAuth.delete(serverId, projectId);
  }

  mcpOAuthClientStore(): OAuthClientStore {
    return this.mcpOAuth.clientStore();
  }

  putPendingMcpOAuth(flow: PendingMcpOAuth): void {
    this.mcpOAuth.putPending(flow);
  }

  takePendingMcpOAuth(state: string): PendingMcpOAuth | undefined {
    return this.mcpOAuth.takePending(state);
  }

  async resolveMcpOAuthToken(serverId: string, projectId: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
    return this.mcpOAuth.resolveToken(serverId, projectId, fetchImpl);
  }

  /**
   * Attaches the managed bearer to each claimed server with a stored grant, after the claim so a slow
   * token refresh never runs under the state lock. A hand-written `Authorization` header wins.
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

  listProviderInstances(): ProviderInstance[] {
    return this.providers.list();
  }

  saveProviderInstance(input: ProviderInstanceInput): { instance: ProviderInstance; stoppedInheriting: string[] } {
    return this.providers.save(input);
  }


  removeProviderInstance(id: string): boolean {
    return this.providers.remove(id);
  }

  resolveProviderInstance(instanceId: string, driver: ProviderDriverKind): ProviderInstance {
    return this.providers.resolve(instanceId, driver);
  }

  listUsageLimitSources(): UsageLimitSource[] {
    return this.usageSources.list();
  }

  saveUsageLimitSource(input: UsageLimitSourceInput): UsageLimitSource {
    return this.usageSources.save(input);
  }

  removeUsageLimitSource(id: string): boolean {
    return this.usageSources.remove(id);
  }

  resolveUsageLimitSources(): ResolvedUsageLimitSource[] {
    return this.usageSources.resolve();
  }

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    options: {
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
      /** The background checkout sizer's seams — see `checkout-sizes.ts`.
       *  INJECTED BY TESTS ONLY; the default walks the real disk. */
      checkoutSizing?: CheckoutSizesOptions;
      git?: GitRunner;
      asyncGit?: AsyncGitRunner;
      gh?: GhRunner;
      /** The daemon's computer-use gate: resolves cua-driver only while the
       *  last probe answered `granted`. INJECTED BY THE DAEMON, absent by
       *  default — so tests never read the real machine's installs, and a
       *  store without it simply has no computer use. */
      computerUse?: () => ResolvedComputerUse | undefined;
      /** Test seam for the provider model handshake. */
      models?: typeof readModelCatalogue;
      /** Test seam for the installed-CLI version probe. */
      cliVersion?: (driver: ProviderDriverKind) => Promise<InstalledCli>;
      /** Test seam for the bundled model manifest. */
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
    this.onTurnsStopped = options.onTurnsStopped;
    this.computerUse = options.computerUse;
    this.syncGit = options.git ?? defaultGitRunner;
    this.asyncGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultAsyncGitRunner);
    // A POOL OF ITS OWN FOR THE CUTS, so the slowest git child cannot hold a
    // slot the rail's polls need — see `defaultWorktreeGitRunner`. An INJECTED
    // runner still wins, and wins for both: a test that fakes git is faking the
    // whole of git, and two seams would let a fake apply to half of it.
    this.worktreeGit = options.asyncGit ?? (options.git ? async (cwd, args, opts) => options.git!(cwd, args, opts) : defaultWorktreeGitRunner);
    this.checkoutSizes = new CheckoutSizes(options.checkoutSizing);
    this.gh = options.gh ?? defaultGhRunner;
    this.volumes = options.volumes ?? {};
    this.ambientEnv = options.ambientEnv ?? process.env;
    this.paths = statePaths(root);
    this.workspace = new WorkspaceConfigStore(this.paths.workspace);
    this.cleanup = new CleanupStore(this.paths.cleanup);
    this.setups = new WorktreeSetups({
      directoryOf: (sessionId) => sessionDir(this.paths, sessionId),
      launcher: pipeLauncher(processGroupFor(process.platform, (pid, signal) => process.kill(pid, signal)), { graceMs: SETUP_STOP_GRACE_MS }),
      now: () => this.now(),
    });
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
    // The journal sweep says what it removed when it removes it, which is
    // seconds AFTER the open rather than during it — the first pass on a
    // large store is a minute's work and belongs nowhere near the startup
    // path (#646). `onExecutionHousekeeping` is the daemon's line.
    const executionStore = new ExecutionStore(root, {
      onJournalCompacted: (swept) => options.onExecutionHousekeeping?.({ journal: swept }),
      onRetentionSweep: () => { this.sweepRetention(); },
    });
    this.kernel = new Kernel({ paths: this.paths, now, executionStore, notifier: options.notifier });
    ({
      settings: this.settings, appearance: this.appearance, mcpOAuth: this.mcpOAuth, mcpServers: this.mcpServers, usageSources: this.usageSources,
      projectProbes: this.projectProbes, projectRegistry: this.projectRegistry, catalogues: this.catalogues, providers: this.providers, toolchains: this.toolchains, github: this.github, browser: this.browser,
    } = this.leafStores(options));
    ({
      records: this.records, items: this.sessionItems, requests: this.sessionRequests, tasks: this.sessionTasks, mailbox: this.mailbox,
      activity: this.activity, index: this.sessionIndex, queues: this.sessionQueues, prefixes: this.prefixes, attachments: this.attachments,
    } = createSessionModules(this.kernel, {
      readQueue: (sessionId) => this.readQueue(sessionId),
      readEvents: (sessionId) => this.readEvents(sessionId),
      subscriptionsOf: (sessionId) => this.subscriptions.subscriptionsOf(sessionId),
      nextWake: (sessionId) => this.nextScheduledWake(sessionId),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      ...(options.onQueueChanged ? { onQueueChanged: options.onQueueChanged } : {}),
    }));
    this.subscriptions = this.createSubscriptions();
    this.lifecycle = this.createLifecycle();
    this.worktrees = this.worktreeMaintenance();
    this.registerCacheHooks();
    // The backfill's writes go through one transaction rather than one per row.
    this.sessionIndexBackfill = this.sessionIndex.backfill();
    this.turnSummaryBackfill = this.backfillTurnSummaries();
    // Before anything can claim a turn — see the method.
    this.claudeLongWindowMigration = this.migrateBareClaudeIds();
    this.claudeCompactionMigration = this.migrateClaudeCompactionToLimits();
    this.pluginFieldMigration = this.migrateLegacyPluginFieldsOnOpen();
  }

  /**
   * THE PROJECT'S `setup.command`, IN THE BACKGROUND — never inside the
   * per-project queue, which would hold every other cut for as long as an
   * install takes. Best-effort: a setup that cannot start is in its own log.
   */
  private async startWorktreeSetup(sessionId: string, worktree: string): Promise<void> {
    try {
      const session = this.records.get(sessionId);
      if (!session.projectId) return;
      const project = this.getProject(session.projectId);
      const { effective } = await this.workspace.view(project);
      await this.setups.start(sessionId, { worktree, config: effective, env: { TELAR_WORKTREE: worktree } });
    } catch {
      // A session deleted in the meantime has nothing to set up.
    }
  }

  private createLifecycle(): SessionLifecycle {
    return new SessionLifecycle(this.kernel, this.records, this.subscriptions, {
      git: this.git,
      worktreeGit: this.worktreeGit,
      worktreeQueue: this.worktreeQueue,
      getProject: (projectId) => this.getProject(projectId),
      assertProjectAvailable: (projectId) => this.assertProjectAvailable(projectId),
      projectAvailability: (project) => this.projectAvailability(project),
      projectOfSession: (session) => this.projectOfSession(session),
      sessionDefaults: () => this.getSessionDefaults(),
      requireInstance: (instanceId) => this.providers.require(instanceId),
      cachedModels: (driver) => this.catalogues.cachedRows(driver),
      readQueue: (sessionId) => this.readQueue(sessionId),
      writeQueue: (sessionId, queue) => this.writeQueue(sessionId, queue),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
      settleWorktree: (sessionId, error) => this.settleWorktree(sessionId, error),
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      startSetup: (sessionId, worktree) => this.startWorktreeSetup(sessionId, worktree),
      releaseBrowser: (sessionId, reason) => this.browser.release(sessionId, reason),
      releasePlugins: (sessionId, reason) => {
        this.pluginRelease?.(sessionId, reason);
        void this.kernels?.dispose(sessionId, reason);
      },
      releasesArchivedCheckouts: () => this.cleanup.policy().archived,
    });
  }

  private createSubscriptions(): SessionSubscriptions {
    return new SessionSubscriptions(this.kernel, {
      require: (sessionId) => this.records.get(sessionId),
      find: (sessionId) => {
        try {
          return this.records.get(sessionId);
        } catch {
          return undefined;
        }
      },
      turnsOf: (sessionId) => this.scanQueue(sessionId).turns,
      hasLiveTurn: (sessionId) => this.hasLiveTurn(sessionId),
      discardQueuedWakes: (subscriberId, targetSessionId) => void this.discardQueuedWakes(subscriberId, targetSessionId),
      submitTurn: (sessionId, input) => this.submitTurn(sessionId, input),
      warn: (sessionId, message) => void this.appendEvent(sessionId, { type: "runtime.warning", message }),
    });
  }

  /** The per-document stores that sit beside the sessions modules, built on the kernel. */
  private leafStores(options: { models?: typeof readModelCatalogue; cliVersion?: (driver: ProviderDriverKind) => Promise<InstalledCli>; manifest?: ModelManifest }) {
    const settings = new SettingsStore(this.kernel);
    const appearance = new AppearanceStore(this.kernel);
    const mcpOAuth = new McpOAuthStore(this.kernel);
    const mcpServers = new McpServers(this.kernel, { requireProject: (id) => void this.getProject(id), forgetGrant: (id, projectId) => mcpOAuth.delete(id, projectId) });
    const usageSources = new UsageLimitSources(this.kernel);
    const projectProbes = new ProjectProbes(this.kernel, {
      asyncGit: this.asyncGit,
      volumes: this.volumes,
      forgetGitReadsUnder: (root) => this.forgetGitReadsUnder(root),
      onUnavailable: (project) => void this.recoverRemountedProject(project),
    });
    const projectRegistry = new ProjectRegistry(this.kernel, {
      probes: projectProbes,
      volumes: this.volumes,
      sessionsOf: (projectId) => this.records.read().filter((session) => session.projectId === projectId).map((session) => session.id),
      hasWorkInFlight: (sessionId) => this.sessionHasWorkInFlight(sessionId),
    });
    const catalogues = new ModelCatalogues(this.kernel, {
      readModels: options.models ?? readModelCatalogue,
      cliVersion: options.cliVersion ?? installedCli,
      manifest: options.manifest ?? BUNDLED_MANIFEST,
    });
    const providers = new ProviderRegistry(this.kernel, this.ambientEnv);
    const toolchains = new PluginToolchains(this.kernel, { getProject: (id) => projectRegistry.get(id) });
    const github = new GitHubStore(this.kernel, { gh: this.gh, getProject: (id) => projectRegistry.get(id), requireSenderClaim: (proof) => this.requireSenderClaim(proof) });
    const browser = new SessionBrowser(this.kernel, {
      require: (id) => void this.records.require(id),
      getSession: (id) => this.records.get(id),
      runningRunId: (id) => this.readQueue(id).turns.find((turn) => turn.state === "running")?.runId,
    });
    return { settings, appearance, mcpOAuth, mcpServers, usageSources, projectProbes, projectRegistry, catalogues, providers, toolchains, github, browser };
  }

  /** How many projects the legacy-field fold changed on this open (0 on most). */
  readonly pluginFieldMigration: number;

  /**
   * THE LEGACY `dataScience` / `latex` BLOCKS FOLD INTO THE PLUGIN MAP — on
   * every open, not once.
   *
   * EVERY OPEN because the input can come back: an older engine (one rolled
   * back to) writes those keys again, and the next open of this one must fold
   * them rather than ignore them. That is affordable because the pass is
   * IDEMPOTENT AND NON-DESTRUCTIVE (`migrateLegacyPluginFields`): an existing
   * map entry always wins, settings come across whole, and a registry with no
   * legacy keys is not written at all.
   *
   * The raw registry, before the schema, so nothing the schema would strip is
   * lost on the way. A registry that will not parse is left for every other
   * reader of it to report.
   */
  private migrateLegacyPluginFieldsOnOpen(): number {
    return this.kernel.command("migrateLegacyPluginFields", () => {
      let projects = 0;
      try {
        const stored = this.readDocument(this.paths.projects) as { projects?: Record<string, unknown>[] } | undefined;
        const next = (stored?.projects ?? []).map((project) => {
          const migrated = migrateLegacyPluginFields(project);
          if (migrated.changed) projects += 1;
          return migrated.project;
        });
        if (projects > 0) this.writeDocument(this.paths.projects, { ...stored, projects: next });
      } catch {
        // Reported by every other reader of the registry.
      }
      return projects;
    });
  }

  /** How many logins the one-time #587 rewrite changed on this open, or nothing
   *  when it had already run. */
  readonly claudeCompactionMigration?: number;

  /**
   * CLAUDE'S COMPACTION ROWS BECOME THE PER-CLASS SETTING — once, marked (#587).
   *
   * Before #587 the Claude login's compaction was a token count written as
   * environment rows. `migrateClaudeCompaction` reads them back as the setting
   * they meant — T becomes the 200k-class limit, 1M takes the default — and the
   * rows leave the list, so the setting and a stale row cannot disagree.
   *
   * The raw registry, not `readProviderInstances`, which seeds one on first
   * read. A login whose compaction rows are sensitive keeps them: their values
   * live in the secrets file and are not this pass's to read.
   */
  private migrateClaudeCompactionToLimits(): number | undefined {
    if (this.readDocument(this.paths.claudeCompactionMigration) !== undefined) return undefined;
    return this.kernel.command("migrateClaudeCompactionToLimits", () => {
      let logins = 0;
      try {
        const stored = this.readDocument(this.paths.providerInstances) as { providerInstances?: Record<string, unknown>[] } | undefined;
        const next = (stored?.providerInstances ?? []).map((instance) => {
          const env = instance.env as ProviderInstanceEnvVar[] | undefined;
          if (instance.driver !== "claude" || !Array.isArray(env) || instance.autoCompact !== undefined) return instance;
          if (env.some((variable) => CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name) && variable.sensitive)) return instance;
          const migrated = migrateClaudeCompaction(env);
          if (!migrated) return instance;
          logins += 1;
          return { ...instance, env: migrated.env, ...(migrated.autoCompact ? { autoCompact: migrated.autoCompact } : {}) };
        });
        if (logins > 0) this.writeDocument(this.paths.providerInstances, { ...stored, providerInstances: next });
      } catch {
        // A registry that will not parse is reported by every other reader of it.
      }
      this.writeDocument(this.paths.claudeCompactionMigration, { version: 1, at: this.now(), logins });
      return logins;
    });
  }

  /** What the one-time `[1m]` rewrite changed on this open, or nothing when it
   *  had already run. See `migrateBareClaudeIds`. */
  readonly claudeLongWindowMigration?: { sessions: number; projects: number };

  /**
   * RECORDS SAVED BEFORE 200k WAS A CHOICE KEEP RUNNING AT 1M — once, marked.
   *
   * Until #986 a bare Claude id whose model defaults to 1M (`opus`,
   * `claude-opus-5-5`, Fable) was rewritten to its `[1m]` row at every door, so
   * a session or project default saved bare ran 1M. From #986 a bare id is a pick
   * of the 200k window. Without this, those older records would silently halve
   * their window on the next turn; with it, their stored model is rewritten to
   * the explicit `[1m]` id it always ran as, and only picks made from now on can
   * mean 200k.
   *
   * ONCE, AND BEFORE THE FIRST CLAIM. The marker document is written in the same
   * transaction as the rewrites, and its presence skips the pass on every later
   * open. It runs in the constructor rather than lazily because a claim that
   * reached an old record first would run it at 200k. It reads only session
   * METADATA documents — no queue, items or journal — which is the part of a
   * session #646's startup lesson says is cheap.
   *
   * IDEMPOTENT ANYWAY: a `[1m]` id is never rewritten, so running it twice
   * changes nothing. Queued turns are left alone — the old `submitTurn` already
   * stored them in the `[1m]` spelling.
   */
  private migrateBareClaudeIds(): { sessions: number; projects: number } | undefined {
    if (this.readDocument(this.paths.claudeLongWindowMigration) !== undefined) return undefined;
    const rewrite = (selection: unknown): string | undefined => {
      const model = (selection as { model?: unknown } | undefined)?.model;
      if (typeof model !== "string") return undefined;
      const long = legacyLongSpelling(model, this.catalogues.manifest);
      return long === model ? undefined : long;
    };
    return this.kernel.command("migrateBareClaudeIds", () => {
      let sessions = 0;
      for (const id of this.records.ids()) {
        try {
          const file = sessionMetadataFile(this.paths, id);
          const raw = this.readDocument(file) as { driver?: unknown; model?: Record<string, unknown> } | undefined;
          if (!raw || raw.driver !== "claude") continue;
          const long = rewrite(raw.model);
          if (!long) continue;
          this.writeDocument(file, { ...raw, model: { ...raw.model, model: long } });
          sessions += 1;
        } catch {
          // One unreadable session must not stop an engine from starting.
        }
      }
      let projects = 0;
      try {
        const stored = this.readDocument(this.paths.projects) as { projects?: Record<string, unknown>[] } | undefined;
        // The raw registry, not `readProviderInstances`, which seeds one on
        // first read and would make this pass write a file nobody asked for.
        const registry = this.readDocument(this.paths.providerInstances) as { providerInstances?: { id?: unknown; driver?: unknown }[] } | undefined;
        const claudeInstances = new Set(
          (registry?.providerInstances ?? []).flatMap((instance) => (instance.driver === "claude" && typeof instance.id === "string" ? [instance.id] : [])),
        );
        claudeInstances.add(defaultInstanceIdForDriver("claude"));
        const next = (stored?.projects ?? []).map((project) => {
          const selection = project.defaultModel as { instanceId?: unknown } | undefined;
          if (typeof selection?.instanceId !== "string" || !claudeInstances.has(selection.instanceId)) return project;
          const long = rewrite(selection);
          if (!long) return project;
          projects += 1;
          return { ...project, defaultModel: { ...selection, model: long } };
        });
        if (projects > 0) this.writeDocument(this.paths.projects, { ...stored, projects: next });
      } catch {
        // A registry that will not parse is reported by every other reader of it.
      }
      this.writeDocument(this.paths.claudeLongWindowMigration, { version: 1, at: this.now(), sessions, projects });
      return { sessions, projects };
    });
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
    const store = this.kernel.executionStore;
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
    this.sessionItems.withoutMigration(() => {
      for (const sessionId of missing) {
        try {
          this.kernel.command("backfillTurnSummaries", () => {
            const queue = this.readQueue(sessionId);
            if (queue.turns.length === 0) return;
            const items = this.sessionItems.values(sessionId);
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
    });
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
    this.sessionItems.clear();
    this.sessionQueues.clear();
    return { sessions, turns };
  }

  /** The icon's bytes-on-disk, for the daemon's serve route. Refuses when the
   *  project has none rather than guessing. */
  async projectIconFileAsync(projectId: string): Promise<ProjectIcon> {
    const project = this.getProject(projectId);
    const icon = await this.projectProbes.icon(project);
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  listProjects(options: { includeRemoved?: boolean } = {}): Project[] {
    return this.projectRegistry.list(options);
  }


  /**
   * WHICH MOUNT CONFIGURATION EACH AWAY PROJECT HAS ALREADY BEEN SEARCHED FOR.
   *
   * The remount search is the expensive one — a `diskutil` child per mounted
   * volume — and it can only succeed if a disk has arrived. Keyed by project and
   * valued by `mountSignature`, so an unplugged drive that stays unplugged is
   * searched for exactly once no matter how long the poll runs.
   */
  private readonly remountAttempts = new Map<string, string>();

  projectAvailability(project: Pick<Project, "id" | "root"> & { volume?: Project["volume"] }): ProjectAvailability {
    return this.projectProbes.availability(project);
  }


  /** Every cached git read that names `root` — see `forgetProjectReads`. */
  private forgetGitReadsUnder(root: string): void {
    for (const key of this.gitReadCache.keys()) {
      if (key.includes(root)) this.gitReadCache.delete(key);
    }
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
    const projects = this.projectRegistry.read().projects.filter((project) => project.removedAt === undefined);
    let changed = 0;
    let recovered = 0;
    for (const project of projects) {
      const before = this.projectProbes.lastAvailability(project.id);
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

    const parsed = this.projectRegistry.read();
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
    for (const session of this.records.read()) {
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
    this.projectProbes.forgetReads({ id: project.id, root: previousRoot });
    this.projectProbes.forgetReads({ id: project.id, root });
    this.projectProbes.forgetAvailability(project.id);

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
    for (const session of this.records.read()) {
      if (session.projectId !== projectId) continue;
      if (session.preparation?.state !== "failed") continue;
      if (session.workspace.mode !== "worktree") continue;
      const plan: WorktreePlan = { path: session.workspace.path, branch: session.workspace.branch, named: false };
      const baseSha = workspaceBaseRef(session.workspace);
      // No recorded base is no commit to cut from, and inventing one would put
      // the session on a checkout nobody chose. The row keeps its failure.
      if (baseSha === undefined) continue;
      this.lifecycle.prepareWorktree(session.id, projectRoot, plan, baseSha);
    }
  }

  registerProject(input: { id?: string; name: string; root: string }): Project {
    return this.projectRegistry.register(input);
  }

  unregisterProject(projectId: string): { project: Project; sessions: number } {
    return this.projectRegistry.unregister(projectId);
  }

  restoreProject(projectId: string): Project {
    return this.projectRegistry.restore(projectId);
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
    return [...this.sessionTasks.read(sessionId).values()].some(isLiveTask);
  }

  /** Background work still moving: `livenessOf`'s "monitoring" half, asked of
   *  the tasks directly by callers that must not trust a stale index row. */
  private hasLiveBackgroundWork(sessionId: string): boolean {
    return [...this.sessionTasks.read(sessionId).values()].some((task) => countsAsActivity(task) && isBackgroundWork(task));
  }

  /**
   * Refuses new work (a session, a turn or wake, a settings change) on a removed project or an unplugged
   * drive. Reads stay open, so a removed project's history still answers.
   */
  private assertProjectAvailable(projectId: string): void {
    const project = this.getProject(projectId);
    if (project.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
    }
    // Probed fresh, and `unmounted` only: a missing folder is refused by the worker, in the conversation,
    // and an unplugged drive needs a cable rather than a re-registration that would mint a new project id.
    if (this.projectAvailability(project) === "unmounted") {
      throw new EngineStateError("conflict", `The drive holding ${project.name} is not connected. Plug it back in and this will work again.`);
    }
  }

  getProject(projectId: string): Project {
    return this.projectRegistry.get(projectId);
  }

  updateProject(projectId: string, patch: ProjectPatch): Project {
    return this.projectRegistry.update(projectId, patch);
  }

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
    const session = this.records.get(sessionId);
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

  machinePlugins(): ProjectPlugins {
    return this.toolchains.machine();
  }

  updateMachinePlugins(patch: PluginPatch): ProjectPlugins {
    return this.toolchains.updateMachine(patch);
  }

  pluginRuns(project: Project, id: string): boolean {
    return this.toolchains.runs(project, id);
  }

  attachPluginRelease(release: (sessionId: string, reason: string) => void): void {
    this.pluginRelease = release;
  }

  enabledPluginIds(session: Session): string[] {
    return this.toolchains.enabledIds(session);
  }


  dataScienceToolchain(fresh = false): Promise<Toolchain> {
    return this.toolchains.dataScienceToolchain(fresh);
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
    const current = dataScienceBlock(project)?.python ? this.currentEnvironment(project, base) : undefined;
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
    const session = this.records.get(sessionId);
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
    const config = dataScienceBlock(project)?.python;
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
        this.toolchains.forgetDataScienceToolchain();
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

  latexToolchain(fresh = false): Promise<LatexToolchain> {
    return this.toolchains.latexToolchain(fresh);
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
    return { toolchain, mainCandidates: candidates.sort(), ...(latexBlock(project)?.toolchain ? { current: latexBlock(project)!.toolchain } : {}) };
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
        this.toolchains.forgetLatexToolchain();
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
    const config = latexBlock(this.getProject(projectId));
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
    const config = latexBlock(this.getProject(projectId));
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
      cwd = this.anchorReadRoot(this.records.require(sessionId));
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
      this.kernel.command("stampTurnAnchor", () => {
        const queue = this.readQueue(sessionId);
        const turn = queue.turns.find((candidate) => candidate.runId === runId);
        if (!turn) return;
        const merged = { ...turn.anchor, ...patch };
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
    const session = this.records.get(sessionId);
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
    const session = this.records.get(sessionId);
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

  modelCatalogue(driver: ProviderDriverKind, options: { force?: boolean; instanceId?: string } = {}): Promise<ModelCatalogue> {
    return this.catalogues.catalogue(driver, options);
  }

  prefetchModelCatalogues(drivers?: readonly ProviderDriverKind[]): Promise<void> {
    return this.catalogues.prefetch(drivers);
  }

  getModelOverlay(instanceId: string): ModelOverlay {
    return this.catalogues.overlay(instanceId);
  }

  setModelOverlay(instanceId: string, patch: { favorites?: unknown; hidden?: unknown; order?: unknown; custom?: unknown; default?: unknown }): ModelOverlay {
    return this.catalogues.setOverlay(instanceId, patch);
  }

  projectGitHub(projectId: string, options: { force?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {}): Promise<GitHubSnapshot> {
    return this.github.list(projectId, options);
  }

  projectForgeFacets(projectId: string, options: { force?: boolean } = {}): Promise<GitHubFacets> {
    return this.github.facetsOf(projectId, options);
  }

  projectCheckLog(projectId: string, jobId: string): Promise<GitHubCheckLog> {
    return this.github.checkLog(projectId, jobId);
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

  projectIssue(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubIssueRead> {
    return this.github.issue(projectId, number, options);
  }

  projectPull(projectId: string, number: number, options: { force?: boolean } = {}): Promise<GitHubPullRead> {
    return this.github.pull(projectId, number, options);
  }

  projectPullMerge(projectId: string, number: number, input: { method: GitHubMergeMethod; expectedHeadOid: string }): Promise<GitHubMergeResult> {
    return this.github.merge(projectId, number, input);
  }

  projectGitHubComment(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; body: string },
    proof: { sessionId: string; runId: string; claimToken: string },
  ): Promise<GitHubCommentResult> {
    return this.github.comment(projectId, input, proof);
  }

  projectGitHubReaction(
    projectId: string,
    input: { kind: "issue" | "pull"; number: number; subjectId: string; content: GitHubReactionContent; react: boolean },
  ): Promise<GitHubReactionResult> {
    return this.github.react(projectId, input);
  }

  projectThreadReply(projectId: string, number: number, input: { threadId: string; body: string }): Promise<GitHubThreadReplyResult> {
    return this.github.threadReply(projectId, number, input);
  }

  projectThreadResolve(projectId: string, number: number, input: { threadId: string; resolved: boolean }): Promise<GitHubThreadResolveResult> {
    return this.github.threadResolve(projectId, number, input);
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
    const session = this.records.get(sessionId);
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
    const session = this.records.get(sessionId);
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
    const session = this.records.get(sessionId);
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
    if (result.opened) this.github.forgetLists(project.id);
    return structuredClone(result);
  }

  /**
   * What placing a Diff line on this session branch's pull request needs — #1014.
   *
   * Read when asked, never cached: the surface asks once per branch-scope view,
   * and the whole point is that HEAD, the dirty paths and the pull request's head
   * are compared as they are NOW. A session with no branch of its own has no pull
   * request, and says so by leaving `pull` out.
   */
  async sessionPullAnchor(sessionId: string): Promise<GitHubPullAnchor> {
    const session = this.records.get(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") return { dirty: [], files: [] };
    const cwd = workspaceRootOf(session);
    const [pull, local] = await Promise.all([readPullForBranch(this.gh, cwd, workspace.branch), this.checkoutHeadAndDirty(cwd)]);
    if (!pull) return { ...local, files: [] };
    return { pull, ...local, files: await readPullFiles(this.gh, cwd, pull.number) };
  }

  /**
   * Start a review thread on the session branch's pull request — #1014.
   *
   * THE PULL REQUEST IS THE BRANCH'S, NEVER THE CALLER'S: it is looked up again
   * from the session record, so this route cannot comment anywhere else. And the
   * commit the surface anchored to must still be both the checkout's HEAD and the
   * pull request's head — otherwise the line numbers it chose describe a
   * different file, and the answer is `stale` rather than a misplaced comment.
   */
  async sessionPullLineComment(sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    const session = this.records.get(sessionId);
    const workspace = session.workspace;
    if (workspace.mode !== "worktree") {
      return { commented: false, refusal: "not_found", message: "This session has no branch of its own, so it has no pull request." };
    }
    const cwd = workspaceRootOf(session);
    const [pull, local] = await Promise.all([readPullForBranch(this.gh, cwd, workspace.branch), this.checkoutHeadAndDirty(cwd)]);
    if (!pull) return { commented: false, refusal: "not_found", message: `${workspace.branch} has no open pull request.` };
    if (pull.headRefOid !== input.commitId || local.head !== input.commitId || local.dirty.includes(input.path)) {
      return { commented: false, refusal: "stale", message: "The branch moved after this diff was read. Refresh and select the lines again." };
    }
    const result = await commentOnPullLine(this.gh, cwd, pull.number, input);
    if (result.commented && session.projectId !== undefined) this.github.forgetDetail(session.projectId, "pull", pull.number);
    return structuredClone(result);
  }

  private async checkoutHeadAndDirty(cwd: string): Promise<{ head?: string; dirty: string[] }> {
    const [head, status] = await Promise.all([this.asyncGit(cwd, ["rev-parse", "HEAD"]), this.asyncGit(cwd, ["status", "--porcelain=v1", "-z"])]);
    // A status that did not answer leaves HEAD out too: without the dirty list
    // no line can be called safe, and no HEAD is what says so.
    const sha = head.status === 0 && status.status === 0 ? head.stdout.trim() : "";
    return { ...(sha ? { head: sha } : {}), dirty: status.status === 0 ? porcelainPaths(status.stdout) : [] };
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
    const session = this.records.get(sessionId);
    const cwd = workspaceRootOf(session);
    return this.withAvailability(
      this.cachedGitRead(`files:${cwd}`, () => listWorkspaceFilesAsync(this.asyncGit, { cwd, now: this.now() })),
      this.projectOfSession(session),
    );
  }

  projectFileAsync(projectId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(this.getProject(projectId).root, target, "project");
  }

  sessionFileAsync(sessionId: string, target: string): Promise<WorkspaceFile> {
    return readFencedAsync(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  projectFileBytesAsync(projectId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(this.getProject(projectId).root, target, "project");
  }

  sessionFileBytesAsync(sessionId: string, target: string): Promise<{ data: Buffer; mediaType: string; bytes: number }> {
    return readFencedBytes(workspaceRootOf(this.records.get(sessionId)), target, "session workspace");
  }

  /** `expected` is the hash the editor read; a stale one is refused rather than overwritten. */
  projectFileWrite(projectId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const project = this.getProject(projectId);
    return writeFenced(project.root, target, text, expected, "project");
  }

  sessionFileWrite(sessionId: string, target: string, text: string, expected: string): WorkspaceWriteResult {
    const session = this.records.get(sessionId);
    return writeFenced(workspaceRootOf(session), target, text, expected, "session workspace");
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
      const session = this.records.require(sessionId);
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

  createSession(input: Parameters<SessionLifecycle["createSession"]>[0]): Session {
    return this.lifecycle.createSession(input);
  }







  updateSession(sessionId: string, patch: Parameters<SessionLifecycle["updateSession"]>[1]): Session {
    return this.lifecycle.updateSession(sessionId, patch);
  }

  refreshWorktreeBranchFromTitle(sessionId: string): Promise<string | undefined> {
    return this.lifecycle.refreshWorktreeBranchFromTitle(sessionId);
  }

  getSession(sessionId: string): Session {
    return this.records.get(sessionId);
  }

  markSessionRead(sessionId: string, runId: string): Session {
    return this.records.markRead(sessionId, runId);
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
    const rows = this.kernel.executionStore.projectSessionRows(projectId);
    return this.records.read(new Set(rows.map((row) => row.id)));
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
   */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    return this.kernel.executionStore.projectActivity();
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
    const projects = this.projectRegistry.read().projects;
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
    const { sessions, assignments } = this.activity.foldLive(only);
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
    /** Open terminals per session in this answer, whoever opened them (#883). */
    terminals: Record<string, number>;
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
    const indexed = this.activity.shelf(inbox, options.all === true);
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
      terminals: this.terminalsFor(full.sessions.map((session) => session.id)),
    };
  }

  turns(sessionId: string): Turn[] {
    this.records.require(sessionId);
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
    const store = this.kernel.executionStore;
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
   */
  private assertSessionExists(sessionId: string): void {
    if (!this.kernel.executionStore.sessionRow(sessionId)) throw new EngineStateError("not_found", "session does not exist");
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
    const index = this.kernel.documentIndex(file, sessionQueueIndexFile(this.paths, sessionId));
    if (!index) return this.readQueue(sessionId).turns.find((turn) => turn.runId === runId);
    const wanted = index.rows.filter((row) => row.key === runId);
    if (wanted.length === 0) return undefined;
    const parsed = TurnSchema.array().safeParse(this.kernel.readIndexedRows(file, wanted));
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return parsed.data.find((turn) => turn.runId === runId);
  }

  /** A run's items in the order they started — the order `index` counts in, and
   *  the only one stable enough for a caller to name a step by. */
  private runItemsInOrder(sessionId: string, runId: string): Item[] {
    return this.sessionItems.forRuns(sessionId, new Set([runId])).sort((a, b) => a.startedAt - b.startedAt);
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
    const store = this.kernel.executionStore;
    const summary = options.runId === undefined
      ? store.latestAnsweredTurn(sessionId)
      : store.turnSummary(sessionId, options.runId);
    const runId = options.runId ?? summary?.runId;
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
    const store = this.kernel.executionStore;
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
    const store = this.kernel.executionStore;
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
    page: { before: string | null; more: boolean; total: number };
  } {
    this.records.require(sessionId);
    const plan = this.windowedTurns(sessionId, window);
    const chosen = new Set(plan.turns.map((turn) => turn.runId));
    return structuredClone({
      turns: plan.turns,
      items: this.sessionItems.forRuns(sessionId, chosen),
      tasks: [...this.sessionTasks.read(sessionId).values()].filter((task) => chosen.has(task.runId)),
      requests: boundedRequests([...this.sessionRequests.read(sessionId).values()], chosen),
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
  private windowedTurns(sessionId: string, window: { limit: number; before?: string }): { turns: Turn[]; page: { before: string | null; more: boolean; total: number } } {
    const file = sessionQueueFile(this.paths, sessionId);
    const index = this.kernel.documentIndex(file, sessionQueueIndexFile(this.paths, sessionId));
    if (!index) {
      // `readQueue` accounts for itself now (#547), so the explicit call that
      // used to be here would double this read.
      const all = this.readQueue(sessionId).turns;
      const plan = planWindow(all.map((turn) => ({ key: turn.runId, tag: turn.state })), window);
      return { turns: all.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
    }
    const plan = planWindow(index.rows, window);
    const span = this.kernel.readIndexedRows(file, index.rows.filter((row) => plan.chosen.has(row.key)));
    const parsed = TurnSchema.array().safeParse(span);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid session queue");
    return { turns: parsed.data.filter((turn) => plan.chosen.has(turn.runId)), page: plan.page };
  }

  /**
   * The requests a snapshot carries when the caller asked for no window.
   *
   * Bounded for the same reason the windowed key is (#245) — see
   * `boundedRequests`. `requests()` stays whole: a tool asking what a session
   * has ever been asked is a different question from what a transcript renders.
   */
  snapshotRequests(sessionId: string): EngineRequest[] {
    this.records.require(sessionId);
    return structuredClone(boundedRequests([...this.sessionRequests.read(sessionId).values()]));
  }

  items(sessionId: string): Item[] {
    this.records.require(sessionId);
    return structuredClone([...this.sessionItems.read(sessionId).values()]);
  }

  tasks(sessionId: string): Task[] {
    this.records.require(sessionId);
    return structuredClone([...this.sessionTasks.read(sessionId).values()]);
  }

  putAttachment(sessionId: string, input: AttachmentInput): TurnAttachment {
    return this.attachments.put(sessionId, input);
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
      /** A passive message whose notification was folded into a wake still
       *  waiting in the queue — see `foldIntoWaitingMessage`. Not mail. */
      foldedIntoWaitingWake?: boolean;
      agentSourceRunId?: string;
      /** See `Turn.corrects`. Set by `submitAgentTurn` only. */
      corrects?: string;
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
      origin?: "session" | "schedule" | "restart";
      wakeReason?: WakeReason;
      sender?: { sessionId?: string };
      /** A CLOCK started this turn — issue #543. See the origin enum. */
      scheduleOrigin?: { scheduleId: string; dueAt: number };
      /** A PLANNED RESTART cut the last turn off — see `resumeAfterPlannedRestart`. */
      restartOrigin?: NonNullable<Turn["restartOrigin"]>;
    },
  ): { turn: Turn; replayed: boolean } {
    return this.kernel.command("submitTurn", () => {
      assertId(input.runId, "run id");
      // A BLANK MESSAGE WITH SOMETHING ATTACHED is judged below, once the
      // attachments are resolved and their types known — see `turnHasContent`.
      const blankWithFiles =
        typeof input.input === "string" && input.input.trim() === "" && input.kind !== "compact" && (input.attachments?.length ?? 0) > 0;
      if (!blankWithFiles) assertText(input.input);
      const companions =
        Number(input.wakeReason !== undefined) +
        Number(input.sender !== undefined) +
        Number(input.scheduleOrigin !== undefined) +
        Number(input.restartOrigin !== undefined);
      const wants = input.origin === "session" || input.origin === "schedule" || input.origin === "restart" ? 1 : 0;
      if (companions !== wants) {
        throw new EngineStateError("invalid_request", "a session- or schedule-origin turn carries exactly one companion, and only such a turn does");
      }
      if (input.origin === "schedule" && input.scheduleOrigin === undefined) {
        throw new EngineStateError("invalid_request", "a schedule-origin turn names the schedule that started it");
      }
      if (input.origin === "restart" && input.restartOrigin === undefined) {
        throw new EngineStateError("invalid_request", "a restart-origin turn names the restart that started it");
      }
      const kind = input.kind === "compact" ? "compact" : undefined;
      const session = this.records.get(sessionId);
      // A MESSAGE TO A RELEASED SESSION BRINGS ITS CHECKOUT BACK; the turn waits
      // on `preparing` like it does for a first cut. Checked on the read already
      // made, so an ordinary message costs no extra parse of the queue.
      if (session.workspace.mode === "worktree" && session.workspace.released) this.restoreSessionWorktree(sessionId);
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
      if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
      const passive = input.origin === "session" && input.agentDelivery === "passive";
      const queued = queue.turns.filter((turn) => turn.state === "queued" || turn.state === "steering").length;
      if (!passive && queued >= MAX_QUEUED_TURNS) {
        throw new EngineStateError("conflict", "session already has the maximum number of queued turns");
      }

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
        ...(input.origin === "restart" && input.restartOrigin ? { origin: "restart" as const, restartOrigin: input.restartOrigin } : {}),
        ...(input.agentIntent ? { agentIntent: input.agentIntent } : {}),
        ...(input.agentDelivery ? { agentDelivery: input.agentDelivery } : {}),
        ...(input.agentSourceRunId ? { agentSourceRunId: input.agentSourceRunId } : {}),
        ...(input.corrects ? { corrects: input.corrects } : {}),
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
          const index = this.attachments.index(sessionId);
          const attachments = ids.map((id) => {
            const found = index.get(id);
            // Loud rather than silent: a message that says "look at this" and
            // arrives with nothing attached is worse than one that fails to send.
            if (!found) throw new EngineStateError("not_found", "attachment does not exist on this session");
            return found;
          });
          return { attachments };
        })(),
        ...(input.model
          ? {
              model: {
                instanceId: session.providerInstanceId,
                ...(input.model.model ? { model: input.model.model } : {}),
                ...(input.model.effort ? { effort: input.model.effort } : {}),
                ...(input.model.fastMode === undefined ? {} : { fastMode: input.model.fastMode }),
                ...(input.model.serviceTier ? { serviceTier: input.model.serviceTier } : {}),
                ...(input.model.ultracode === undefined ? {} : { ultracode: input.model.ultracode }),
              },
            }
          : {}),
      };
      if (!turnHasContent(turn.input, (turn.attachments ?? []).map((attachment) => attachment.mediaType))) {
        throw new EngineStateError("invalid_request", "a message needs text or an image");
      }
      /** Scheduled after the document is written, never before — see `createSession`. */
      let cut: { projectRoot: string; plan: WorktreePlan; baseSha: string } | undefined;
      if (session.draft) {
        if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
        if (kind === "compact") throw new EngineStateError("conflict", "a browser draft has no conversation to compact");
        if (session.envMode === "worktree") {
          if (!session.projectId) throw new EngineStateError("conflict", "a worktree draft requires a project");
          const project = this.getProject(session.projectId);
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
        if (session.title === "Browser draft") {
          const images = (turn.attachments ?? []).filter((attachment) => attachment.mediaType.startsWith("image/"));
          session.title = seedSessionTitle(input.input, images.map((attachment) => attachment.name)) || session.title;
        }
        delete session.draft;
        this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
        if (cut) this.lifecycle.prepareWorktree(sessionId, cut.projectRoot, cut.plan, cut.baseSha);
      }
      if (session.paused && !passive) turn.held = { at, reason: "session_paused" };
      if (input.origin !== "session" && input.origin !== "restart" && kind !== "compact" && session.agentMessagesBlocked) {
        delete session.agentMessagesBlocked;
        delete session.agentMessagesBlockedAt;
        this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(session));
      }
      queue.turns.push(turn);
      this.writeQueue(sessionId, queue);
      this.records.touch(sessionId, at);
      // Queueing a message is a human saying they are not done with this after
      // all, so any shelf or snooze it was under is lifted.
      if (!passive) this.records.wakeForNewWork(sessionId);
      // v1 emitted only `{ sequence }` here, which is why the client had to fetch
      // a snapshot to learn the prompt. The whole turn rides the event now.
      this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
      if (passive) {
        if (turn.notification) this.writeNotificationItem(sessionId, turn);
        if (turn.notification && !turn.wakeReason && !input.foldedIntoWaitingWake) this.mailbox.hold(sessionId, turn.notification);
        this.appendEvent(sessionId, { type: "turn.completed", resultText: "" }, turn.runId);
        return { turn: structuredClone(turn), replayed: false };
      }
      // A compaction is a gesture on the session, not words for the running
      // model; it always waits its turn.
      const interrupts = turn.origin !== "session" || turn.agentIntent === "task" || turn.agentIntent === "blocker";
      if (kind !== "compact" && interrupts && !session.paused && PROVIDER_CAPABILITIES[session.driver].liveSteering) {
        const steered = this.steerIfRunning(sessionId, turn.runId);
        if (steered) return { turn: steered, replayed: false };
      }
      if (turn.notification) this.writeNotificationItem(sessionId, turn);
      return { turn: structuredClone(turn), replayed: false };
    });
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
    const items = this.sessionItems.read(sessionId);
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
    this.sessionItems.write(sessionId, items, new Set([item.id]));
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
    return this.kernel.command("pauseSession", () => {
      const session = this.records.get(sessionId);
      if (session.state === "archived") throw new EngineStateError("conflict", "session is archived");
      const { live } = this.stopSession(sessionId);
      return { session: this.activity.of(structuredClone(this.records.get(sessionId))), ...(live ? { stopped: live } : {}), held: 0, already: false };
    });
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
    return this.kernel.command("resumeSession", () => {
      const session = this.records.get(sessionId);
      if (!session.paused) return { session: this.activity.of(structuredClone(session)), released: 0, already: true };
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
      return { session: this.activity.of(structuredClone(session)), released: released.length, already: false };
    });
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
    input: { runId: string; input: string; attachments?: string[]; intent?: Turn["agentIntent"]; scope?: string; corrects?: string },
    proof?: SenderProof,
  ): { turn: Turn; replayed: boolean } {
    return this.kernel.command("submitAgentTurn", () => {
      let sender: { sessionId?: string } = {};
      if (proof) {
        assertId(proof.sessionId, "sender session id");
        const claimed = this.requireSenderClaim(proof);
        sender = { sessionId: claimed.sessionId };
      }
      const intent = input.intent ?? "report";
      const waiting = intent === "result" && sender.sessionId
        ? this.subscriptions.readSubscriptions().find((sub) => sub.subscriberSessionId === sessionId && sub.targetSessionId === sender.sessionId && sub.events.includes("turn_completed"))
        : undefined;
      const correction = input.corrects && !this.readQueue(sessionId).turns.some((turn) => turn.runId === input.runId)
        ? this.correctionOf(sessionId, input.corrects, sender.sessionId)
        : undefined;
      const cohortHeld = intent === "result" && sender.sessionId !== undefined && this.subscriptions.cohortHolds(sessionId, sender.sessionId);
      const delivery = !cohortHeld && (intent === "task" || intent === "blocker" || waiting || correction === "read" || correction === "queued")
        ? "wake"
        : "passive";
      const scope = intent === "task" ? input.scope : undefined;
      const notification = peerNotification({
        recipientSessionId: sessionId, runId: input.runId, body: input.input, intent,
        ...(input.corrects ? { corrects: input.corrects } : {}),
        ...(sender.sessionId ? { sender } : {}),
        ...(scope ? { scope } : {}),
      });
      // Not for a correction: it replaces an earlier message rather than joining it.
      const folds = !correction && delivery === "wake" && proof && sender.sessionId && FOLDING_INTENTS.has(intent)
        ? this.waitingMessageFrom(sessionId, sender.sessionId, proof.runId, input.runId)
        : undefined;
      const joins = !folds && !correction && delivery === "wake" && FOLDING_INTENTS.has(intent) && !this.hasLiveTurn(sessionId) &&
        !this.readQueue(sessionId).turns.some((turn) => turn.runId === input.runId)
        ? this.waitingNotificationTurn(sessionId)
        : undefined;
      const result = this.submitTurn(sessionId, {
        ...(folds || joins || cohortHeld ? { foldedIntoWaitingWake: true } : {}),
        runId: input.runId,
        input: input.input,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        origin: "session", sender, agentIntent: intent, agentDelivery: folds || joins ? "passive" : delivery,
        ...(proof ? { agentSourceRunId: proof.runId } : {}),
        ...(input.corrects ? { corrects: input.corrects } : {}),
        notification,
        agentNotice: notification.body,
        // Only a TASK carries a scope. A report that named one would read as an
        // assignment in every surface that folds these turns.
        ...(scope ? { assignmentScope: scope } : {}),
      });
      // A replay of a message already accepted changes nothing, folded or not.
      if (folds && !result.replayed) this.foldIntoWaitingMessage(sessionId, folds, notification);
      if (joins && !result.replayed) this.joinWaitingNotification(sessionId, joins, notification);
      if (!result.replayed && sender.sessionId) this.subscriptions.recordCohortMessage(sessionId, sender.sessionId, intent, input.runId, input.input);
      // The unread version goes only once its replacement is safely accepted.
      if (correction === "queued" || correction === "held") this.withdrawCorrected(sessionId, input.corrects!, correction);
      return result;
    });
  }

  /**
   * WHERE THE MESSAGE BEING CORRECTED STANDS, for this recipient.
   *
   *   queued  still waiting as a wake nobody has claimed — unread
   *   held    passive, and still in the mailbox — unread
   *   read    anything else: claimed, steered, delivered in a merged notice
   *
   * REFUSED, not guessed at, when it names nothing this sender sent here: a
   * correction that could reach another sender's message would be a way to
   * withdraw it.
   */
  private correctionOf(sessionId: string, correctedRunId: string, senderSessionId: string | undefined): "queued" | "held" | "read" {
    const corrected = this.readQueue(sessionId).turns.find((turn) => turn.runId === correctedRunId);
    if (!corrected || corrected.origin !== "session" || !senderSessionId || corrected.sender?.sessionId !== senderSessionId || corrected.notification?.kind !== "peer_message") {
      throw new EngineStateError("invalid_request", `corrects must name an earlier message you sent to this session; ${correctedRunId} is not one`);
    }
    if (corrected.state === "queued") return "queued";
    const held = this.mailbox.pending(sessionId).some((each) => each.kind === "peer_message" && each.runId === correctedRunId);
    return corrected.agentDelivery === "passive" && held ? "held" : "read";
  }

  /** Take an unread corrected message out of the reader's way: a queued wake is
   *  discarded (its body stays readable on the turn), a held one leaves the
   *  mailbox. Either way the correction is now the one the reader will meet. */
  private withdrawCorrected(sessionId: string, correctedRunId: string, where: "queued" | "held"): void {
    if (where === "held") {
      this.mailbox.withdrawPeer(sessionId, correctedRunId);
      return;
    }
    const queue = this.readQueue(sessionId);
    const turn = queue.turns.find((candidate) => candidate.runId === correctedRunId && candidate.state === "queued");
    if (!turn) return;
    const at = this.now();
    turn.state = "discarded";
    turn.completedAt = at;
    turn.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.records.touch(sessionId, at);
    this.appendEvent(sessionId, { type: "turn.discarded" }, turn.runId);
  }

  /**
   * The wake a peer's earlier message from THIS run is still waiting in, if
   * any: queued, unread, a report/result/blocker, from the same sender and run.
   * Past the delivery cap it is not offered, and the new message takes its own
   * turn — a row rewritten a third time is one nobody can follow.
   */
  private waitingMessageFrom(sessionId: string, senderSessionId: string, sourceRunId: string, runId: string): string | undefined {
    const turns = this.readQueue(sessionId).turns;
    // The same run id again is a retried call, not a second message.
    if (turns.some((candidate) => candidate.runId === runId)) return undefined;
    const waiting = turns.find(
      (candidate) =>
        candidate.state === "queued" &&
        !candidate.held &&
        candidate.origin === "session" &&
        !candidate.wakeReason &&
        candidate.notification?.kind === "peer_message" &&
        candidate.agentIntent !== undefined &&
        FOLDING_INTENTS.has(candidate.agentIntent) &&
        candidate.sender?.sessionId === senderSessionId &&
        candidate.agentSourceRunId === sourceRunId,
    );
    if (!waiting?.notification) return undefined;
    return (waiting.notification.deliveries ?? 1) + 1 > MAX_DELIVERIES ? undefined : waiting.runId;
  }

  /** Merge a peer message's notification into the wake `waitingMessageFrom`
   *  found — `mergeIntoWaitingResult`'s rewrite, with `mergeNotifications`
   *  because these are two messages rather than a message and its ending. */
  private foldIntoWaitingMessage(sessionId: string, waitingRunId: string, notification: NotificationDetail): void {
    const queue = this.readQueue(sessionId);
    const waiting = queue.turns.find((candidate) => candidate.runId === waitingRunId);
    if (!waiting?.notification || waiting.state !== "queued") return;
    const at = this.now();
    const merged: NotificationDetail = { ...mergeNotifications([waiting.notification, notification]), deliveries: (waiting.notification.deliveries ?? 1) + 1 };
    waiting.notification = merged;
    waiting.agentNotice = merged.body;
    waiting.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.records.touch(sessionId, at);
    this.rewriteNotificationItem(sessionId, waiting);
    this.appendEvent(sessionId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
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
    return this.kernel.command("claimTurn", () => {
      assertId(workerId, "worker id");
      // A PAUSED SESSION DISPATCHES NOTHING — checked on the record, not
      // inferred from held flags, so a message that slipped into `queued`
      // unheld by any path still cannot run. See `pauseSession`.
      if (this.records.get(sessionId).paused) return undefined;
      if (this.records.get(sessionId).preparation) return undefined;
      const queue = this.readQueue(sessionId);
      if (queue.turns.some((turn) => turn.state === "claimed" || turn.state === "running")) return undefined;
      if (queue.turns.some((turn) => turn.state === "ambiguous")) return undefined;
      const turn = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
      if (!turn) return undefined;
      const at = this.now();
      turn.state = "claimed";
      // The watermark rides the claim: everything submitted from here on was
      // written against a session the person had reason to think was live.
      turn.claim = { workerId, token: crypto.randomUUID(), at, sequence: queue.nextSequence };
      turn.updatedAt = at;
      this.writeQueue(sessionId, queue);
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.claimed", workerId }, turn.runId);
      return structuredClone(turn);
    });
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
    return this.kernel.command("openProviderTurn", () => {
      assertId(input.workerId, "worker id");
      // The CLI woke itself on a background task, but the human paused the
      // session: no turn opens. The driver parks the frames; a `conflict` is
      // what it already reads as "not now".
      if (this.records.get(sessionId).paused) throw new EngineStateError("conflict", "session is paused");
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
      this.records.touch(sessionId, at);
      // The same three events a human turn produces, in one breath: tailing
      // clients fold a provider turn with the code they already have.
      this.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, turn.runId);
      this.appendEvent(sessionId, { type: "turn.claimed", workerId: input.workerId }, turn.runId);
      this.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
      return structuredClone(turn);
    });
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
    const session = this.records.get(sessionId);
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

    const items = this.sessionItems.read(sessionId);
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
    this.sessionItems.write(sessionId, items, new Set(written.map((row) => row.id)));

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
    this.records.touch(sessionId, at, adoption.fork.sessionId);
    return { session: this.records.get(sessionId), turn: structuredClone(turn), provenance: adoption.provenance };
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
    return this.kernel.command("reportSessionTasks", () => {
      assertId(workerId, "worker id");
      this.records.require(sessionId);
      const parsed = TurnObservationSchema.array().safeParse(observations);
      if (!parsed.success) throw new EngineStateError("invalid_request", "task observations are invalid");
      const tasks = this.sessionTasks.read(sessionId);
      const projection = { items: this.sessionItems.read(sessionId), tasks, itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
      let accepted = 0;
      for (const observation of parsed.data) {
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
        this.sessionTasks.write(sessionId, projection.tasks);
        this.records.touch(sessionId, this.now());
      }
      return { accepted };
    });
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
    const session = this.records.get(sessionId);
    return session.driver === "claude" && !session.model?.model && this.catalogues.defaultClaudeModelId() === undefined;
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
    this.sessionRequests.closeOpen(sessionId, new Set([turn.runId]), at);
    this.records.touch(sessionId, at);
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

  prepareClaudeCatalogue(timeoutMs?: number): Promise<void> {
    return this.catalogues.prepareClaude(timeoutMs);
  }

  /**
   * DOES THIS SESSION WANT ITS RATE-LIMITED TURNS RESUMED?
   *
   * Absent means yes for Claude and no for anything else — the default is not
   * written into the record, so a session created before the setting existed
   * behaves like one created after it, and a provider that starts reporting
   * limits the same way later begins resuming without a migration. Only an
   * explicit choice is stored. For Claude, "absent" asks `SessionDefaults`.
   */
  private resumesAfterRateLimit(session: Session): boolean {
    // Resolved at read time, so changing the standing default reaches every
    // session that never chose for itself.
    return session.resumeAfterRateLimit ?? (session.driver === "claude" && this.getSessionDefaults().resumeAfterRateLimit !== false);
  }

  /** What the newest journal record naming this run said, falling back through
   *  the durable copy to the turn's own start. The ledger is keyed by session
   *  and carries its run, so an earlier run's stamp is never read as this
   *  one's — see `runProgress`. */
  private lastProgressOf(sessionId: string, turn: Turn): number {
    const seen = this.kernel.runProgress.get(sessionId);
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

    const session = this.records.get(sessionId);
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
      this.records.wakeForNewWork(sessionId);
      this.records.touch(sessionId, at);
    }
  }

  claimNextTurn(workerId: string): WorkerClaim | undefined {
    return this.kernel.command("claimNextTurn", () => {
      assertId(workerId, "worker id");
      const candidates: Array<{ sessionId: string; acceptedAt: number }> = [];
      for (const sessionId of [...this.liveQueueSessionIds()]) {
        this.sweepRateLimited(sessionId);
        this.sweepStalledTurns(sessionId);
        // A SCAN, so the shared copy: the one session that wins is claimed
        // through `claimTurn`, which reads a queue of its own to write.
        const queue = this.scanQueue(sessionId);
        // One turn per session at a time — the engine's own invariant, checked
        // here so a busy session costs nothing further.
        if (queue.turns.some((candidate) => candidate.state === "claimed" || candidate.state === "running")) continue;
        if (queue.turns.some((candidate) => candidate.state === "ambiguous")) continue;
        // `!held` matches `claimTurn`'s own choice — a session whose only queued
        // work is held has nothing to offer, and listing it as a candidate would
        // win the sort and then claim nothing.
        const next = queue.turns.find((candidate) => candidate.state === "queued" && !candidate.held);
        if (!next) continue;
        // `claimTurn` refuses a paused session; skipping it here keeps it from
        // winning the sort and stalling every other session for a poll.
        const session = this.records.get(sessionId);
        if (session.paused) continue;
        if (session.preparation?.state === "preparing") continue;
        // Released with a turn queued: the restore `submitTurn` started is on its
        // way, and a turn must never run in a directory that is not there.
        if (session.workspace.mode === "worktree" && session.workspace.released) continue;
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
        const selection = this.catalogues.claudeSelectionState(session.driver, next.model ?? session.model);
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
        const candidateSession = this.records.get(candidate.sessionId);
        if ((candidateSession.driver as string) === "telar") {
          if (!this.warnedLegacyDriver.has(candidate.sessionId)) {
            this.warnedLegacyDriver.add(candidate.sessionId);
            console.error(`[telar] session ${candidate.sessionId} runs on the removed "telar" driver and will not be claimed (#531).`);
          }
          continue;
        }
        const turn = this.claimTurn(candidate.sessionId, workerId);
        if (!turn) continue;
        const session = this.records.get(candidate.sessionId);
        const resumeCursor = this.records.resumeCursorFor(session);
        // Normalised HERE TOO, because a record saved before the window became a
        // control is read here without ever passing through a patch — and the
        // claim is the one place that decides what actually runs.
        const model = this.claimModelSelection(session.driver, turn.model ?? session.model, session.providerInstanceId ?? defaultInstanceIdForDriver(session.driver));
        const registered = resolveMcpServers(this.listMcpServers(), session.projectId);
        const mcpServers = withComputerUse(
          registered.filter((server) => server.enabled),
          registered,
          session.driver,
          this.computerUse?.(),
        );
        const providerInstance = this.resolveProviderInstance(session.providerInstanceId, session.driver);
        return {
          sessionId: session.id,
          // Emitted only when the session HAS one — see `WorkerClaim.projectRoot`.
          // A `none` workspace sends nothing rather than a path nobody chose.
          ...(workspacePath(session.workspace) ? { projectRoot: workspacePath(session.workspace)! } : {}),
          ...(session.projectId ? { projectId: session.projectId } : {}),
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
          ...(() => {
            const resolves: Record<string, () => unknown> = {
              "data-science": () => this.resolveDataScience(session),
              latex: () => this.resolveLatex(session),
            };
            const ids = this.enabledPluginIds(session).filter((id) => (id in resolves ? resolves[id]!() !== undefined : true));
            return ids.length > 0 ? { plugins: ids } : {};
          })(),
          ...(resumeCursor ? { resumeCursor } : {}),
          // The session's LIVE task rows, so a provider process built cold
          // files a still-running shell's report on the row that exists rather
          // than minting a second one. Settled rows have nothing to report on.
          ...(() => {
            const live = [...this.sessionTasks.read(session.id).values()].filter(isLiveTask).map(taskSeedOf);
            return live.length > 0 ? { tasks: live } : {};
          })(),
          ...(this.getAgentOrientation().preamble ? { orientation: TELAR_ORIENTATION } : {}),
          ...(() => {
            const notes = [...this.mailbox.takeNextTurnNotes(session.id), ...this.mailbox.takeHeldMail(session.id)];
            return notes.length > 0 ? { notes } : {};
          })(),
          turn,
        };
      }
      return undefined;
    });
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
   *
   * A NAMED MODEL RUNS AS NAMED. A bare Claude id used to be rewritten to its
   * `[1m]` spelling here and at every patch, because the picker offered no 200k
   * row and a bare id could only be an old record. Both windows are rows again,
   * so a bare id is a pick of the standard window and is honoured.
   */
  private claimModelSelection(
    driver: ProviderDriverKind,
    normalized: ModelSelection | undefined,
    instanceId: string,
  ): ModelSelection | undefined {
    if (driver !== "claude" || normalized?.model) return normalized;
    const model = this.catalogues.defaultClaudeModelId(normalized?.instanceId ?? instanceId);
    // Nothing known: unchanged. A guess here would be the 200k bug wearing a
    // different hat.
    if (!model) return normalized;
    // `instanceId` is required on a selection, so it comes from the session
    // rather than being conjured — an absent selection has none of its own.
    return { ...normalized, instanceId: normalized?.instanceId ?? instanceId, model };
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
    return this.kernel.command("markRunning", () => {
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
      const promoted = this.promoteClaimWindow(sessionId, queue, turn, at);
      this.writeQueue(sessionId, queue);
      this.records.touch(sessionId, at);
      // WHERE THE REPOSITORY STANDS AS THIS TURN BEGINS (#741). Dispatched, never
      // awaited — see `anchorTurn` for why this one line may not be a git call.
      this.anchorTurn(sessionId, turn.runId, "before");
      this.appendEvent(sessionId, { type: "turn.started" }, turn.runId);
      // AFTER `turn.started`, so a client reading the journal in order never sees
      // a message steered into a turn it has not yet been told began.
      for (const late of promoted) this.appendEvent(sessionId, { type: "turn.steering", intoRunId: turn.runId }, late.runId);
      return structuredClone(turn);
    });
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
    return this.kernel.command("ingestObservations", () => this.ingestBatch(sessionId, runId, claimToken, observations));
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
      if (!this.sessionItems.has(sessionId, observation.itemId)) continue;
      const written = this.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      // #214: a reader arriving mid-reply still has to see the prefix.
      this.prefixes.extend(sessionId, observation.itemId, observation.text, written.id);
    }
    return { accepted: parsed.data.length };
  }

  private ingestBatch(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    const queue = this.readQueue(sessionId);
    const turn = this.requireRunningClaimFromQueue(queue, runId, claimToken);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    const projection = { items: this.sessionItems.read(sessionId), tasks: this.sessionTasks.read(sessionId), itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
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
    if (projection.itemsTouched.size > 0) this.sessionItems.write(sessionId, projection.items, projection.itemsTouched);
    // Most batches carry no task at all — a rewrite per batch would be a file
    // write per streamed provider message for nothing. Same rule for the
    // queue: only a `provider.session` observation ever mutates the turn.
    if (projection.tasksTouched) this.sessionTasks.write(sessionId, projection.tasks);
    if (projection.turnTouched) this.writeQueue(sessionId, queue);
    return { accepted: parsed.data.length };
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
  ): Turn {
    return this.kernel.command("completeTurn", () => {
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
      this.sessionTasks.closeOrphaned(sessionId, turn.runId, at, "the turn ended before this agent reported back");
      this.records.touch(sessionId, at, input.providerSessionId);
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
      this.flushPendingNotifications(sessionId);
      // AFTER THE WAKE, NOT BEFORE. A coordinator's turn completing is what makes
      // its wake "consumed", and this session may be that coordinator — see
      // `evaluateDelegationSettling`.
      this.evaluateDelegationSettling(sessionId);
      return structuredClone(turn);
    });
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
    const session = this.records.get(sessionId);
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
    this.records.wakeForNewWork(sessionId);
    this.records.touch(sessionId, at);
    return structuredClone(turn);
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: TurnFailure["code"]; message: string; resumeAt?: number; limitType?: TurnFailure["limitType"] },
  ): Turn {
    return this.kernel.command("failTurn", () => {
      if (!TURN_FAILURE_CODES.has(failure.code) || typeof failure.message !== "string" || !failure.message.trim()) {
        throw new EngineStateError("invalid_request", "turn failure is invalid");
      }
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
      this.anchorTurn(sessionId, turn.runId, "after");
      if (failure.code === "interrupted") {
        for (const reverted of requeued) reverted.held = { at, reason: "engine_restart" };
      }
      this.writeQueue(sessionId, queue);
      // A failed turn means the provider process died — background shells died
      // with it, whichever turn started them.
      this.sessionTasks.closeLive(sessionId, at, "the turn failed before this agent reported back", { includeBackground: true });
      this.sessionItems.closeOpen(sessionId, new Set([turn.runId]), at);
      this.sessionRequests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.failed", ...turn.failure }, turn.runId);
      for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
      this.fireSubscriptions(sessionId, "turn_failed", turn, { failure: turn.failure });
      this.flushPendingNotifications(sessionId);
      // A FAILED TURN STILL ENDS ONE. It never makes this session settleable —
      // clause 1 refuses a failed assignment — but the session may be the
      // COORDINATOR whose delegate is now waiting on nothing.
      this.evaluateDelegationSettling(sessionId);
      return structuredClone(turn);
    });
  }

  /**
   * End session-owned work at this command boundary, including legacy held
   * messages and background tasks. Delivered steering stays in history.
   * Queue terminal states fence late claims, observations and completions
   * before cancellation is delivered to the provider. No Resume is required.
   * Detached project services are owned outside this session task store.
   */
  stopSession(sessionId: string, by: "user" | "agent" = "user"): { stopped: Turn[]; live?: Turn } {
    return this.kernel.command("stopSession", () => {
      const session = this.records.get(sessionId);
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
        this.sessionTasks.closeOrphaned(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
        this.sessionItems.closeOpen(sessionId, new Set([turn.runId]), at);
        this.sessionRequests.closeOpen(sessionId, new Set([turn.runId]), at);
      }
      // Also runs when no foreground turn exists: a background task outlives
      // its turn, but belongs to the session the user just stopped.
      const backgroundStopped = this.stopBackgroundTasks(sessionId);
      if (stopped.length > 0 || backgroundStopped > 0) this.records.touch(sessionId, at);
      for (const turn of stopped) this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
      this.announceStoppedClaims(
        stopped.flatMap((turn) =>
          turn.claim ? [{ sessionId, runId: turn.runId, claimToken: turn.claim.token, workerId: turn.claim.workerId }] : [],
        ),
      );
      // One wake for the live turn, not one per cancelled backlog message.
      if (live) this.fireSubscriptions(sessionId, "turn_stopped", live, {});
      this.flushPendingNotifications(sessionId);
      this.evaluateDelegationSettling(sessionId);
      return { stopped: stopped.map((turn) => structuredClone(turn)), ...(live ? { live: structuredClone(live) } : {}) };
    });
  }

  /**
   * STOP ONE TURN. The worker claims the next queued message within a
   * heartbeat, an undelivered steer is requeued and claimed, and subscribers
   * are woken — this is a stop of a RUN, not of the session. For the Stop
   * button's "end this session's work" see `stopSession`; for "stop and stay
   * stopped until a human resumes" see `pauseSession`.
   */
  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    return this.kernel.command("stopTurn", () => {
      const queue = this.readQueue(sessionId);
      const turn = requestedRunId
        ? queue.turns.find((candidate) => candidate.runId === requestedRunId)
        : queue.turns.find((candidate) => candidate.state === "queued" || candidate.state === "claimed" || candidate.state === "running");
      if (!turn || turn.state === "stopped" || turn.state === "ambiguous" || (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running")) {
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
      this.sessionTasks.closeOrphaned(sessionId, turn.runId, at, "the turn was stopped before this agent reported back");
      this.sessionItems.closeOpen(sessionId, new Set([turn.runId]), at);
      this.sessionRequests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.stopped" }, turn.runId);
      for (const reverted of requeued) this.appendEvent(sessionId, { type: "turn.requeued", reason: "steer_undelivered" }, reverted.runId);
      this.fireSubscriptions(sessionId, "turn_stopped", turn, {});
      this.flushPendingNotifications(sessionId);
      // A stopped assignment IS finished (clause 1 takes it), so a Stop is one of
      // the moments a delegate can become settleable.
      this.evaluateDelegationSettling(sessionId);
      return { turn: structuredClone(turn), stopped: true };
    });
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
    if (!PROVIDER_CAPABILITIES[this.records.get(sessionId).driver].liveSteering)
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
    const compacting = [...this.sessionItems.read(sessionId).values()].some(
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
    return this.kernel.command("promoteTurn", () => {
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
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.steering", intoRunId: running.runId }, turn.runId);
      return structuredClone(turn);
    });
  }

  /**
   * The worker's half of delivery: the text is in the driver's mailbox.
   * IDEMPOTENT — a retried ack after a dropped response returns the already-
   * steered turn rather than a conflict, because the provider has the words
   * either way and the record must not lie about that.
   */
  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Turn {
    return this.kernel.command("ackSteer", () => {
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
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.steered", intoRunId: turn.steer.intoRunId }, turn.runId);
      return structuredClone(turn);
    });
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
    return this.kernel.command("releaseHeldTurn", () => {
      assertId(runId, "run id");
      const session = this.records.get(sessionId);
      if (session.projectId !== undefined) this.assertProjectAvailable(session.projectId);
      const queue = this.readQueue(sessionId);
      const turn = queue.turns.find((candidate) => candidate.runId === runId);
      if (!turn) throw new EngineStateError("not_found", "turn does not exist");
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
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.released" }, turn.runId);
      return structuredClone(turn);
    });
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
    return this.kernel.command("discardAmbiguousTurn", () => {
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
      this.sessionTasks.closeOrphaned(sessionId, turn.runId, at, "the turn was discarded before this agent reported back");
      this.sessionRequests.closeOpen(sessionId, new Set([turn.runId]), at);
      this.records.touch(sessionId, at);
      this.appendEvent(sessionId, { type: "turn.discarded" }, turn.runId);
      return structuredClone(turn);
    });
  }

  archiveSession(sessionId: string, options: { releaseCheckout?: boolean } = {}): Session {
    return this.lifecycle.archiveSession(sessionId, options);
  }







  deleteSession(sessionId: string): boolean {
    return this.lifecycle.deleteSession(sessionId);
  }

  /** Sessions already refused for running on the removed `telar` driver, so the
   *  refusal is one log line rather than one per worker poll (#531). */
  private readonly warnedLegacyDriver = new Set<string>();

  subscribe(...args: Parameters<SessionSubscriptions["subscribe"]>): Subscription {
    return this.subscriptions.subscribe(...args);
  }
  unsubscribe(subscriptionId: string, subscriberSessionId?: string): boolean {
    return this.subscriptions.unsubscribe(subscriptionId, subscriberSessionId);
  }
  subscriptionsFor(subscriberSessionId: string): Subscription[] {
    return this.subscriptions.subscriptionsFor(subscriberSessionId);
  }
  sweepSubscriptions(): string[] {
    return this.subscriptions.sweepSubscriptions();
  }
  subscribeCohort(...args: Parameters<SessionSubscriptions["subscribeCohort"]>): SubscribedCohort {
    return this.subscriptions.subscribeCohort(...args);
  }
  cohortsFor(subscriberSessionId: string): Cohort[] {
    return this.subscriptions.cohortsFor(subscriberSessionId);
  }
  sweepCohorts(): string[] {
    return this.subscriptions.sweepCohorts();
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
    this.subscriptions.advanceCohortMember(targetSessionId, kind, turn, context);
    const all = this.subscriptions.readSubscriptions();
    const hits = all.filter((each) => each.targetSessionId === targetSessionId && each.events.includes(kind));
    /**
     * A COHORT PASSES A PARKED REQUEST THROUGH AT ONCE — the barrier holds
     * endings, not someone waiting on an answer. As a subscription for this one
     * wake, unless the subscriber already has a real one that fires on it.
     */
    if (kind === "request_opened") {
      for (const cohort of this.subscriptions.readCohorts()) {
        if (!cohort.members.some((member) => member.sessionId === targetSessionId && !member.outcome)) continue;
        if (hits.some((each) => each.subscriberSessionId === cohort.subscriberSessionId)) continue;
        hits.push({
          id: cohort.id,
          subscriberSessionId: cohort.subscriberSessionId,
          targetSessionId,
          events: ["request_opened"],
          ...(cohort.completionWake ? { completionWake: cohort.completionWake } : {}),
          createdAt: cohort.createdAt,
        });
      }
    }
    if (hits.length === 0) return;
    let target: Session;
    try {
      target = this.records.get(targetSessionId);
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
    // Asked once, not per subscriber: it is a fact about the run.
    const silentTurn = kind === "turn_completed" && this.saidNothing(targetSessionId, turn);
    for (const subscription of hits) {
      const subscriberId = subscription.subscriberSessionId;
      if (subscriberId === targetSessionId) continue;
      let subscriber: Session | undefined;
      try {
        subscriber = this.records.get(subscriberId);
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
       * A RESULT AND A COMPLETION ARE TWO DIFFERENT FACTS (#240) — AND SINCE
       * #919 THE SECOND IS RECORDED, NOT DELIVERED, ONCE THE FIRST IS READ.
       *
       * #240 reverted a suppression: this used to swallow the `turn_completed`
       * of any run whose worker had already sent an awaited `result`, and a
       * worker that sent a result for the part it finished and kept working
       * left its coordinator waiting for an end that never arrived. #590 then
       * folded the second ROW into the result still waiting in the queue
       * (`mergeIntoWaitingResult`), which covers the completion that lands
       * before the result is read.
       *
       * THE CASE NEITHER COVERED is the measured one (#919): the coordinator
       * has CLAIMED the result — or it was steered into the turn it was in —
       * and the worker's run ends seconds later. The merge misses (the turn is
       * not `queued`), the completion is held, and the coordinator spends a
       * whole turn after the result turn saying "that session finished;
       * already integrated". Seven times in one day's transcripts, every one
       * the same shape.
       *
       * THE RESOLUTION IS THE CONTRACT, NOT A GUESS BY THE ENGINE. `result`
       * now means "my final answer — send it last" and mid-task progress is a
       * `report` (see `sessions_send` and the `telar` skill). Under that
       * contract a completion arriving after its result is in front of the
       * model is news the model already has, so `messageDeliveredTo` records
       * it as a passive row and wakes nobody. A `turn_failed` or
       * `turn_stopped` still wakes — a run that fell over after reporting is
       * something to act on — as does an `always` subscriber, who asked to be
       * interrupted, and any completion whose run sent no result.
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
       * A COMPLETION WHOSE RESULT IS ALREADY IN FRONT OF THE MODEL — issue #919.
       *
       * The sibling of the merge above, for the result the subscriber has
       * already taken: no hold, no turn. It still spends a one-shot exactly as
       * the other terminal branches do — the run ended, and this subscriber
       * has been told everything it will hear about it.
       *
       * A ROW IS STILL WRITTEN, as a passive turn (the shape `submitTurn` gives
       * a routine report, minus the mailbox), so the transcript and
       * `sessions_status` say "and the run has ended" where a person looks for
       * it. Nothing claims it and nothing is woken by it.
       *
       * ONLY A CLEAN ENDING. A failure or a stop after a result is a run that
       * fell over having already reported, and that is actionable: it takes
       * the ordinary path.
       *
       * A RESULT OR BLOCKER COUNTS FROM THE MOMENT IT IS SENT, however it was
       * delivered — woken, held for a cohort, left in the mailbox, or joined to
       * another waiting notice — and whatever `completionWake` says. Keying
       * this on delivery state left gaps where the ending woke the coordinator
       * a second time, just to acknowledge (`reportedTo`).
       */
      /**
       * AND A COMPLETION THAT SAYS NOTHING. A turn that journalled no answer and
       * sent no message has no news in it — the measured case is the turn the
       * driver opens to decide a tool call for background work (#891), whose
       * whole answer is one engine sentence. Waking a coordinator on it cost a
       * turn to read "Decided a tool call…". Recorded the same way, for the
       * same reason: the row is history, not something to act on.
       */
      if (
        kind === "turn_completed" &&
        (this.reportedTo(subscriberId, targetSessionId, turn.runId) ||
          ((subscription.completionWake ?? "settled_only") === "settled_only" && (this.messageDeliveredTo(subscriberId, targetSessionId, turn.runId) || silentTurn)))
      ) {
        const recorded: NotificationDetail = { ...notification, deliveries: 1 };
        try {
          this.submitTurn(subscriberId, {
            runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
            input: notificationLabel(recorded),
            origin: "session",
            wakeReason,
            notification: recorded,
            agentDelivery: "passive",
          });
        } catch (error) {
          // The same contract as the wake path below: a subscriber that cannot
          // take a row (its project put away, say) keeps its own state, and the
          // reason goes on its journal.
          if (!(error instanceof EngineStateError && error.code === "conflict")) throw error;
          this.appendEvent(subscriberId, {
            type: "runtime.warning",
            message: `a completion from session ${targetSessionId} could not be recorded: ${error.message}`,
          });
        }
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
        this.mailbox.hold(subscriberId, notification);
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
      if (this.mailbox.pending(subscriberId).length > 0) {
        this.mailbox.hold(subscriberId, notification);
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
        /**
         * AND ONE QUEUED NOTIFICATION TURN PER SESSION. A queued turn is not a
         * live one, so two children finishing a moment apart on an idle
         * subscriber used to queue two turns about two runs. The second joins
         * the first instead — unless this wake was asked to interrupt a live
         * turn, which a queued turn behind it would quietly take back.
         */
        const waiting = coalesced || interrupting ? undefined : this.waitingNotificationTurn(subscriberId);
        if (waiting) this.joinWaitingNotification(subscriberId, waiting, notification, wakeReason);
        else if (!coalesced) {
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
    if (changed) this.subscriptions.writeSubscriptions(all);
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
   * A PERSON SETTLED THIS SESSION: END WHAT IT LEFT RUNNING — issue #883.
   *
   * Called for an EXPLICIT settle only — the person's Settle, or an agent's
   * `sessions_settle` — and never for the clock's, which waits
   * `SETTLED_TERMINAL_GRACE_MS` (see `sweepSettledTerminals`). The settle itself
   * is already written; nothing here can refuse it, and each part is
   * best-effort so a host out of reach does not stop the rest.
   *
   * - Every terminal the session owns, whoever opened it, recorded as closed
   *   by Telar — so its agent is not told the person closed them.
   * - Its background tasks, the chip's own Stop.
   * - Its browser pages.
   *
   * Un-settling brings none of it back. Answers the counts, which is what the
   * settle reports.
   */
  async endSessionLeftovers(sessionId: string): Promise<SessionSettleEnded> {
    let backgroundTasks = 0;
    try {
      backgroundTasks = this.stopBackgroundTasks(sessionId, "stopped when the session was settled");
    } catch {
      // A session that cannot be read has no tasks this can stop.
    }
    void this.browser.release(sessionId, "The session was settled.")?.catch(() => undefined);
    let terminals = 0;
    try {
      terminals = (await this.terminals?.closeSession(sessionId)) ?? 0;
    } catch {
      // The desktop's terminal host is out of reach. Quitting Telar closes
      // every terminal it holds, so nothing is left for ever.
    }
    // The row's count goes to nothing. The settled limit is not checked here:
    // this settle only lowered the total it sums.
    await this.refreshTerminalCensus();
    return { terminals, backgroundTasks };
  }

  /**
   * THE CLOCK'S SETTLE ENDS TERMINALS TOO, LATER — issue #883.
   *
   * A session the inactivity clock shelved, or the delegation rule settled,
   * was not put down by anybody, so its terminals get `SETTLED_TERMINAL_GRACE_MS`
   * before they close: a dev server a person was still using is not taken the
   * moment the list reshuffles. Past that, they close as an explicit settle's
   * do. An explicit settle past the grace is covered too, for a terminal opened
   * after it.
   *
   * #965'S RULE STANDS AND DOES THE REST: live background work keeps the clock
   * from shelving a session at all, so such a session is never "settled" here
   * and keeps its terminals for as long as that work runs.
   *
   * THE HOST IS ASKED WHICH SESSIONS HOLD TERMINALS, not only the engine's own
   * records: a session whose only open terminal is a shell the person opened
   * is closed at the end of its grace too, which the engine alone cannot see.
   * Then the settled limit is checked (`enforceSettledTerminalLimit`). Answers
   * the sessions whose grace closed them.
   */
  async sweepSettledTerminals(): Promise<string[]> {
    if (!this.terminals) return [];
    await this.refreshTerminalCensus();
    const now = this.now();
    const window = this.getInboxPolicy().autoSettleAfterHours;
    const due: string[] = [];
    for (const sessionId of this.censusSessions()) {
      try {
        const row = indexRow(this.records.get(sessionId));
        if (!rowIsShelved(row, { now, autoSettleAfterHours: window })) continue;
        const since = now - SETTLED_TERMINAL_GRACE_MS;
        const longEnough = row.settledOverride === "settled"
          ? (row.settledAt ?? 0) <= since
          // Shelved by the clock: it was already shelved a grace ago.
          : rowIsShelved(row, { now: since, autoSettleAfterHours: window });
        if (longEnough) due.push(sessionId);
      } catch {
        // A session that cannot be read is not closed on a guess.
      }
    }
    for (const sessionId of due) {
      try {
        const closed = await this.terminals.closeSession(sessionId);
        this.recordTerminalsClosed(sessionId, closed, "grace");
      } catch {
        // The next tick tries again.
      }
    }
    if (due.length > 0) await this.refreshTerminalCensus();
    await this.enforceSettledTerminalLimit();
    return due;
  }

  /**
   * NO MORE THAN `settledTerminalLimit` TERMINALS ACROSS SETTLED SESSIONS — the
   * machine-wide half of #883. Past it, the session settled longest ago has its
   * terminals closed first, as Telar, and says so (`terminalsClosed`), until the
   * rest fit.
   *
   * CHECKED ON THE FIVE-MINUTE SWEEP AND RIGHT AFTER A DELEGATION SETTLE, and on
   * no clock of its own. Those are the moments the settled total can grow that
   * the engine hears of: the inactivity clock shelves a session by time passing,
   * which only the sweep notices, and the delegation rule shelves one by a write.
   * A person's or an agent's settle closes that session's terminals, so it only
   * ever lowers the total. A shell opened in a settled session waits for the
   * next sweep.
   *
   * "SETTLED LONGEST AGO" is `settledAt` for a decision, and for the clock the
   * moment its window ran out: last activity plus the window. Answers the
   * sessions it closed.
   */
  enforceSettledTerminalLimit(): Promise<string[]> {
    // One check at a time: two overlapping would both close the same oldest session.
    this.limitTask ??= this.checkSettledTerminalLimit().finally(() => {
      this.limitTask = undefined;
    });
    return this.limitTask;
  }

  private limitTask?: Promise<string[]>;

  private async checkSettledTerminalLimit(): Promise<string[]> {
    if (!this.terminals) return [];
    const limit = this.getInboxPolicy().settledTerminalLimit;
    const at = this.sessionIndex.settlingClock();
    const windowMs = (at.autoSettleAfterHours ?? 0) * 60 * 60_000;
    const settled: Array<{ sessionId: string; count: number; since: number }> = [];
    for (const sessionId of this.censusSessions()) {
      const count = this.terminalCount(sessionId);
      if (count === 0) continue;
      try {
        const row = indexRow(this.records.get(sessionId));
        if (row.state === "active" && !rowIsShelved(row, at)) continue;
        const since = row.settledOverride === "settled" ? (row.settledAt ?? row.updatedAt) : row.updatedAt + windowMs;
        settled.push({ sessionId, count, since });
      } catch {
        // A session that cannot be read is not closed on a guess.
      }
    }
    let total = settled.reduce((sum, entry) => sum + entry.count, 0);
    const closed: string[] = [];
    for (const entry of settled.sort((a, b) => a.since - b.since)) {
      if (total <= limit) break;
      try {
        const ended = await this.terminals.closeSession(entry.sessionId);
        this.recordTerminalsClosed(entry.sessionId, Math.max(ended, entry.count), "limit");
        total -= entry.count;
        closed.push(entry.sessionId);
      } catch {
        // The host is out of reach; the next check tries again.
        break;
      }
    }
    if (closed.length > 0) await this.refreshTerminalCensus();
    return closed;
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
    for (const sessionId of this.records.ids()) {
      try {
        if (this.settleDelegateIfDue(sessionId)) settled.push(sessionId);
      } catch {
        // One unreadable session must not stop the sweep for the rest.
      }
    }
    return settled;
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
    const store = this.kernel.executionStore;
    const now = this.now();
    const acted: string[] = [];
    for (const row of store.dueSchedules(now)) {
      try {
        const decision = decideSchedule(row.rule, row.zone, row.nextRunAt, now);
        if (!decision.fire) {
          // SKIPPED, AND SAID SO. Without the recorded instant the boundary —
          // "Telar was not running at 09:00" — is invisible, and an invisible
          // boundary is indistinguishable from a broken scheduler.
          this.writeScheduleRow(store, { ...row, nextRunAt: decision.nextRunAt, lastRunStatus: "skipped", lastSkippedAt: decision.skipped ?? row.nextRunAt });
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
        this.writeScheduleRow(store, { ...row, nextRunAt: decision.nextRunAt, lastRunAt: now, lastRunId: runId, lastRunStatus: "fired" });
        acted.push(row.id);
      } catch {
        /**
         * The session is gone, or refused the turn. Disable rather than retry:
         * a row that cannot fire is not made more likely to fire by being
         * reconsidered every thirty seconds, and leaving it enabled would turn
         * one deleted session into a permanent tick.
         */
        try {
          this.writeScheduleRow(store, { ...row, enabled: false, nextRunAt: this.scheduleParkedAt(row.nextRunAt, now) });
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

  private nextScheduledWake(sessionId: string): number | undefined {
    return this.listSchedules(sessionId).filter((schedule) => schedule.enabled).reduce<number | undefined>((soonest, schedule) => (soonest === undefined || schedule.nextRunAt < soonest ? schedule.nextRunAt : soonest), undefined);
  }

  listSchedules(sessionId?: string): ScheduleRow[] {
    return this.kernel.executionStore.listSchedules(sessionId);
  }

  readSchedule(id: string): ScheduleRow | undefined {
    return this.kernel.executionStore.readSchedule(id);
  }

  /** Create or replace one schedule. The FIRST `nextRunAt` is computed here
   *  rather than taken from the caller: a client that could name it could aim a
   *  row at the past and make the grace rule meaningless. */
  putSchedule(input: { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean }): ScheduleRow {
    const store = this.kernel.executionStore;
    if (!input.prompt.trim()) throw new EngineStateError("invalid_request", "a schedule needs a prompt");
    this.records.require(input.sessionId);
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
    this.writeScheduleRow(store, row);
    return row;
  }

  deleteSchedule(id: string): boolean {
    const deleted = this.kernel.executionStore.deleteSchedule(id);
    if (deleted) this.sessionIndex.bumpList();
    return deleted;
  }

  /**
   * A SCHEDULE ROW IS PART OF THE ANSWER NOW — a session's `scheduled` state
   * and its wake time are read off these rows — so a write to one moves the
   * list's revision. The rows live in their own table, outside `writeDocument`,
   * so nothing else would: a rail would keep showing a wake that was deleted.
   */
  private writeScheduleRow(store: ExecutionStore, row: ScheduleRow): void {
    store.writeSchedule(row);
    this.sessionIndex.bumpList();
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
   * cancels the requests it left behind (`SessionRequests.closeOpen`). So an open
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
        due = [...this.sessionRequests.live(sessionId).values()].flatMap((request) => {
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
   * One indexed query.
   */
  private snoozeWakeCandidates(): SessionIndexRow[] {
    return this.kernel.executionStore.dueSnoozeWakes();
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
    const session = this.records.get(sessionId);
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
      session = this.records.get(sessionId);
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
    const session = this.records.get(sessionId);
    const next: Session = { ...session, settledOverride: "settled", settledAt: this.now(), settledBy };
    this.writeDocument(sessionMetadataFile(this.paths, sessionId), storedSession(next));
    this.appendEvent(sessionId, { type: "session.settled", settledBy });
    this.appendEvent(sessionId, { type: "session.updated", session: next });
    this.subscriptions.reviewCohorts();
    // A shelf that just grew by a session keeping its terminals (#883). After
    // the command that settled it, never inside it.
    if (this.terminals) void Promise.resolve().then(() => this.enforceSettledTerminalLimit()).catch(() => undefined);
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
      this.mailbox.hold(subscriberId, notification);
      return true;
    }
    const at = this.now();
    // A turn that carries a cohort keeps it: only this run's lines are replaced.
    const others = waiting.notification?.entries?.filter((entry) => !(entry.sessionId === targetSessionId && entry.runId === wakeReason.runId));
    notification = { ...(others?.length ? mergeNotifications([{ ...waiting.notification!, entries: others }, notification]) : notification), deliveries };
    waiting.input = notificationLabel(notification);
    waiting.notification = notification;
    waiting.wakeReason = wakeReason;
    waiting.updatedAt = at;
    this.writeQueue(subscriberId, queue);
    this.records.touch(subscriberId, at);
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
   * THE NOTIFICATION TURN STILL WAITING TO BE READ, if this session has one: a
   * wake, or a peer's report, result or blocker, queued and not yet claimed. A
   * `task` is not one — it hands work over and keeps a turn of its own — and a
   * passive row reached no model to join.
   */
  private waitingNotificationTurn(sessionId: string): string | undefined {
    return this.readQueue(sessionId).turns.find(
      (turn) =>
        turn.state === "queued" &&
        turn.origin === "session" &&
        turn.notification !== undefined &&
        turn.agentDelivery !== "passive" &&
        (turn.wakeReason !== undefined || (turn.agentIntent !== undefined && FOLDING_INTENTS.has(turn.agentIntent))),
    )?.runId;
  }

  /**
   * JOIN A NOTIFICATION TO THE TURN `waitingNotificationTurn` FOUND — the
   * queued-turn half of the cohort merge.
   *
   * NOT A DELIVERY SPENT. `MAX_DELIVERIES` bounds how often ONE errand is
   * re-announced; a different run joining the list is news the turn has not
   * carried yet, and capping it would push every third finisher of a fan-out
   * back into a turn of its own.
   *
   * A PEER'S TURN KEEPS ITS BODY AND TAKES NO `wakeReason`, for
   * `mergeIntoWaitingResult`'s reason: a wake's words are the engine's and
   * replaceable, a peer's are the only copy.
   */
  private joinWaitingNotification(sessionId: string, waitingRunId: string, notification: NotificationDetail, wakeReason?: WakeReason): void {
    const queue = this.readQueue(sessionId);
    const waiting = queue.turns.find((candidate) => candidate.runId === waitingRunId);
    if (!waiting?.notification || waiting.state !== "queued") return;
    const at = this.now();
    const merged: NotificationDetail = { ...mergeNotifications([waiting.notification, notification]), deliveries: waiting.notification.deliveries ?? 1 };
    waiting.notification = merged;
    if (waiting.wakeReason) {
      waiting.input = notificationLabel(merged);
      if (wakeReason) waiting.wakeReason = wakeReason;
    } else {
      waiting.agentNotice = merged.body;
    }
    waiting.updatedAt = at;
    this.writeQueue(sessionId, queue);
    this.records.touch(sessionId, at);
    this.rewriteNotificationItem(sessionId, waiting);
    this.appendEvent(sessionId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
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
      this.mailbox.hold(subscriberId, notification);
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
    this.records.touch(subscriberId, at);
    this.rewriteNotificationItem(subscriberId, waiting);
    // The strip redraws from `turn.accepted`; re-announcing the same run id
    // with `replayed: true` is how a client learns the words changed.
    this.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(waiting), replayed: true }, waiting.runId);
    return true;
  }

  /**
   * HAS A MESSAGE FROM THIS RUN REACHED THE SUBSCRIBER'S MODEL — issue #919,
   * widened from `result` to any report, result or blocker.
   *
   * WIDENED BECAUSE THE CONTRACT MADE REPORTS THE COMMON CASE. Since #919 a
   * mid-task update is a `report` and `result` is a run's last word, so most
   * workers send a report, finish, and the completion woke the coordinator a
   * second time about the run it had just heard from — two turns for one
   * event, all day. A message from the run is in front of the model; the run
   * ending cleanly after it is news that does not need a turn. A `task` is
   * not in the set: it hands work over rather than saying how this run went.
   *
   * THE SAME KEY AS `mergeIntoWaitingResult`: a `result` from the session
   * that acted, naming the run it acted in on `agentSourceRunId`. Where the
   * merge wants the one turn nobody has read (`queued`), this wants any turn
   * somebody has — see `RESULT_DELIVERED_STATES`.
   *
   * AND ONLY A RESULT THAT WAS DELIVERED AS A WAKE. A passive result (nobody
   * was awaiting it when it was sent, and the recipient was busy or put away)
   * is `completed` on the queue but reached no model: it sits in the mailbox,
   * and the completion is what carries it out on the flush. Treating that as
   * "already read" would leave a shelved coordinator's result waiting for a
   * wake that never comes — the lost-message class #631 closed.
   */
  /**
   * A RUN THAT LEFT NOTHING FOR ANYONE TO READ.
   *
   * The driver's background-claim turn (`providerReason: background_task`)
   * always qualifies: it exists to decide one tool call for work that outlived
   * its turn, and its "answer" is the engine's own sentence. Any other turn
   * qualifies when it ended with no answer text and journalled none on the way.
   *
   * A MESSAGE IT SENT DOES NOT NEED CHECKING HERE. It either woke the
   * subscriber already (`messageDeliveredTo`, or folded into the waiting wake)
   * or sits in its mailbox, which delivers it at the next idle whether or not
   * this completion wakes anyone.
   *
   * Only the run's own rows are read — the warm cache or its indexed rows —
   * and never the session's whole history. Without either, the answer text
   * alone decides.
   */
  private saidNothing(sessionId: string, turn: Turn): boolean {
    if (turn.origin === "provider" && turn.providerReason?.kind === "background_task") return true;
    if (turn.resultText?.trim()) return false;
    const items = this.sessionItems.peekRun(sessionId, turn.runId);
    return !items.some((item) => item.detail.type === "assistant_message" && item.detail.text.trim().length > 0);
  }

  /**
   * HAS THE TARGET ALREADY GIVEN THIS SUBSCRIBER ITS ANSWER — a `result` or a
   * `blocker` from `runId`, or a `result` since the subscriber's latest errand
   * to it. Either way its turn ending is not news: the result IS the
   * completion, and a blocker already woke the subscriber.
   *
   * Counted from when it was SENT: any delivery (woken, cohort-held, mailbox,
   * joined) and any state but discarded.
   */
  private reportedTo(subscriberId: string, targetSessionId: string, runId: string): boolean {
    const errandAt = this.scanQueue(targetSessionId).turns
      .filter((turn) => turn.agentDelivery !== "passive" && turn.sender?.sessionId === subscriberId)
      .at(-1)?.acceptedAt;
    return this.scanQueue(subscriberId).turns.some(
      (candidate) =>
        candidate.origin === "session" &&
        candidate.state !== "discarded" &&
        candidate.sender?.sessionId === targetSessionId &&
        (((candidate.agentIntent === "result" || candidate.agentIntent === "blocker") && candidate.agentSourceRunId === runId) ||
          (candidate.agentIntent === "result" && errandAt !== undefined && candidate.acceptedAt >= errandAt)),
    );
  }

  private messageDeliveredTo(subscriberId: string, targetSessionId: string, runId: string): boolean {
    return this.scanQueue(subscriberId).turns.some(
      (candidate) =>
        RESULT_DELIVERED_STATES.has(candidate.state) &&
        candidate.origin === "session" &&
        candidate.agentIntent !== undefined &&
        FOLDING_INTENTS.has(candidate.agentIntent) &&
        candidate.agentDelivery !== "passive" &&
        candidate.sender?.sessionId === targetSessionId &&
        candidate.agentSourceRunId === runId,
    );
  }

  /** Is a turn of this session's actually in front of a provider right now? The
   *  question `settled_only` turns on — and `queued` is deliberately NOT busy:
   *  a queued wake is already waiting its turn, which is what holding is for. */
  private hasLiveTurn(sessionId: string): boolean {
    return this.scanQueue(sessionId).turns.some((turn) => turn.state === "claimed" || turn.state === "running" || turn.state === "steering");
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
    if (!this.hasLiveTurn(sessionId)) this.subscriptions.deliverReadyCohorts(sessionId);
    const pending = this.mailbox.pending(sessionId);
    if (pending.length === 0) return;
    if (this.hasLiveTurn(sessionId)) return;
    // Peer mail alone is not a reason for a turn: it rides with the next one.
    if (pending.every(isPeerMail)) return;
    const merged = heldDelivery(mergeNotifications(pending));
    // CLEARED BEFORE THE SUBMIT, so a submit that throws cannot be retried into
    // a duplicate — and after it, the facts live on the turn, which is durable.
    this.mailbox.setPending(sessionId, []);
    // A notification turn already queued takes the held mail with it.
    const waiting = this.waitingNotificationTurn(sessionId);
    if (waiting) {
      this.joinWaitingNotification(sessionId, waiting, merged);
      return;
    }
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
    this.records.require(sessionId);
    return structuredClone(this.mailbox.pending(sessionId));
  }

  /** The other half of `writeNotificationItem`: the row a coalesce superseded. */
  private rewriteNotificationItem(sessionId: string, turn: Turn): void {
    const detail = turn.notification;
    if (!detail) return;
    const items = this.sessionItems.read(sessionId);
    const existing = items.get(`notification_${turn.runId}`);
    if (!existing) {
      this.writeNotificationItem(sessionId, turn);
      return;
    }
    const item: Item = { ...existing, title: detail.summary, detail: { type: "notification", notification: detail } };
    items.set(item.id, item);
    this.sessionItems.write(sessionId, items, new Set([item.id]));
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
    const candidates = queue.turns.filter((turn) => turn.state === "queued" && turn.origin === "session" && turn.wakeReason !== undefined);
    /**
     * A TURN OTHER SESSIONS' NEWS JOINED IS KEPT, minus this one's lines — see
     * `joinWaitingNotification`. Only a turn with nothing else in it goes.
     */
    const dropped: Turn[] = [];
    const trimmed: Turn[] = [];
    for (const turn of candidates) {
      // A cohort's notification is about all its members, not the one that led it.
      if (targetSessionId !== undefined && turn.notification?.cohortId) continue;
      if (targetSessionId === undefined || !turn.notification?.entries) {
        if (targetSessionId === undefined || turn.wakeReason!.sessionId === targetSessionId) dropped.push(turn);
        continue;
      }
      const kept = withoutWakesFrom(turn.notification, targetSessionId, subscriberId);
      if (!kept) dropped.push(turn);
      else if (kept !== turn.notification) {
        turn.notification = { ...kept, deliveries: turn.notification.deliveries ?? 1 };
        turn.input = notificationLabel(turn.notification);
        const wake = kept.entries?.filter((entry) => entry.kind !== "peer_message" && entry.wakeKind).at(-1);
        if (wake) turn.wakeReason = { kind: wake.wakeKind!, sessionId: wake.sessionId!, runId: wake.runId!, ...(wake.requestId ? { requestId: wake.requestId } : {}) };
        turn.updatedAt = at;
        trimmed.push(turn);
      }
    }
    if (dropped.length === 0 && trimmed.length === 0) return 0;
    for (const turn of dropped) {
      turn.state = "discarded";
      turn.completedAt = at;
      turn.updatedAt = at;
    }
    this.writeQueue(subscriberId, queue);
    this.records.touch(subscriberId, at);
    for (const turn of trimmed) {
      this.rewriteNotificationItem(subscriberId, turn);
      this.appendEvent(subscriberId, { type: "turn.accepted", turn: structuredClone(turn), replayed: true }, turn.runId);
    }
    for (const turn of dropped) this.appendEvent(subscriberId, { type: "turn.discarded" }, turn.runId);
    return dropped.length + trimmed.length;
  }

  requests(sessionId: string): EngineRequest[] {
    this.records.require(sessionId);
    return structuredClone([...this.sessionRequests.read(sessionId).values()]);
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
    return this.kernel.command("openRequest", () => {
      assertId(input.requestId, "request id");
      if (input.deadlineMs !== undefined && (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0)) {
        throw new EngineStateError("invalid_request", "a request deadline is a positive whole number of milliseconds");
      }
      if (input.default !== undefined && !defaultAllowed(input.kind)) {
        throw new EngineStateError("invalid_request", `a ${input.kind} request may not carry a default — a deadline may not release a secret`);
      }
      if (input.default !== undefined && input.deadlineMs === undefined) {
        throw new EngineStateError("invalid_request", "a request default needs a deadline for anything to take it");
      }
      const turn = this.requireRunningClaim(sessionId, runId, claimToken);
      const session = this.records.get(sessionId);
      const requests = this.sessionRequests.read(sessionId);

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
        ...(!automatic && input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        ...(!automatic && input.default !== undefined ? { default: input.default } : {}),
      };

      if (!automatic) {
        // Parked. Tell someone, and record whether anyone was actually reached —
        // "stuck and nobody was told" has to be a detectable state.
        const notify = () => this.kernel.notifier?.({ sessionId, runId: turn.runId, requestId: request.id,
          kind: input.kind, title: requestTitle(input.detail) }) ?? false;
        request.notified = false;
        this.kernel.afterCommit(() => {
          // Best-effort notification is outside the execution transaction. A
          // crash here leaves an explicitly unnotified, durable open request.
          try {
            const latest = this.sessionRequests.read(sessionId);
            const pending = latest.get(request.id);
            if (pending?.state !== "open") return;
            pending.notified = notify();
            this.sessionRequests.write(sessionId, latest);
          } catch { /* retain the unnotified request for the next reader */ }
        });
      }

      const written = RequestSchema.safeParse(request);
      if (!written.success) throw new EngineStateError("invalid_request", "invalid request");
      requests.set(request.id, request);
      this.sessionRequests.write(sessionId, requests);
      this.appendEvent(sessionId, { type: "request.opened", request }, turn.runId);

      if (automatic) {
        this.appendEvent(
          sessionId,
          { type: "request.resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" },
          turn.runId,
        );
        return { state: "resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" };
      }
      this.records.touch(sessionId, at);
      this.fireSubscriptions(sessionId, "request_opened", turn, { request });
      return { state: "open", requestId: request.id, notified: request.notified ?? false };
    });
  }

  /** A human (or a cancellation) answering a parked request. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; resolvedBy?: RequestResolver; reason?: string; answers?: Record<string, unknown> },
  ): EngineRequest {
    return this.kernel.command("resolveRequest", () => {
      assertId(requestId, "request id");
      const requests = this.sessionRequests.read(sessionId);
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
      this.sessionRequests.write(sessionId, requests);
      this.records.touch(sessionId, at);
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
    });
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
      this.sessionRequests.trim(sessionId, turns);
      return [...this.sessionRequests.live(sessionId).values()]
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
    this.records.require(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) throw new EngineStateError("invalid_request", "event cursor is invalid");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new EngineStateError("invalid_request", "event limit is invalid");
    return this.kernel.executionStore.events(sessionId, after, limit);
  }

  /**
   * The id of the last event on the journal — "now", for a client that wants
   * to tail from the snapshot it just read rather than replay from zero.
   */
  eventCursor(sessionId: string): number {
    this.records.require(sessionId);
    return this.kernel.executionStore.cursor(sessionId);
  }

  openItemPrefix(sessionId: string, itemId: string, through: number): { streamed: string; streamedThrough: number } | undefined {
    return this.prefixes.get(sessionId, itemId, through);
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
    return this.kernel.command("recover", () => {
      const stopped: string[] = [];
      /** The turns this boot cut off mid-flight, per session — what a planned
       *  restart may continue. Backlog that was merely queued is not here. */
      const cutOff = new Map<string, string[]>();
      for (const session of this.records.all()) {
        const queue = this.readQueue(session.id);
        const settledRuns = new Set<string>();
        for (const turn of queue.turns) {
          if (turn.state === "queued" || turn.state === "claimed" || turn.state === "running") continue;
          settledRuns.add(turn.runId);
        }
        {
          const sweptAt = this.now();
          this.sessionTasks.closeLive(session.id, sweptAt, "the turn ended before this agent reported back", { runIds: settledRuns, includeBackground: false });
          // Same retroactive cure for items: a stopped turn from before this
          // sweep existed still holds the tool row it was inside.
          this.sessionItems.closeOpen(session.id, settledRuns, sweptAt);
          this.sessionRequests.closeOpen(session.id, settledRuns, sweptAt);
        }
        let changed = false;
        /** Housekeeping, kept apart from `changed`: retiring a dead claim must
         *  rewrite the queue but must NOT touch the session — nothing happened
         *  to it, and a bumped `updatedAt` would reorder somebody's sidebar. */
        let claimsRetired = false;
        const recoveryEvents: Array<{ type: "turn.stopped"; runId: string }> = [];
        const at = this.now();
        const recoveredProviderSessionId = latestProviderSessionId(queue.turns);
        let metadataChanged = false;
        if (!session.resumeCursor && recoveredProviderSessionId) {
          session.resumeCursor = recoveredProviderSessionId;
          session.updatedAt = at;
          metadataChanged = true;
        }
        for (const turn of queue.turns) {
          if (turn.state !== "queued" && turn.state !== "claimed" && turn.state !== "running" && turn.state !== "steering") continue;
          const wasLive = turn.state === "running";
          if ((wasLive || turn.state === "claimed") && turn.kind !== "compact") {
            cutOff.set(session.id, [...(cutOff.get(session.id) ?? []), turn.runId]);
          }
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
            this.sessionTasks.closeOrphaned(session.id, turn.runId, at, "the engine restarted while this agent was running");
            this.sessionItems.closeOpen(session.id, new Set([turn.runId]), at);
            // A question the lost worker parked can never be answered; leaving
            // it open held the session `blocked` over a tool call nothing would
            // run.
            this.sessionRequests.closeOpen(session.id, new Set([turn.runId]), at);
          }
          changed = true;
        }
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
        for (const turn of queue.turns) {
          if (turn.state !== "stopped" || !turn.claim) continue;
          delete turn.claim;
          claimsRetired = true;
        }
        if (session.paused) {
          delete session.paused;
          session.updatedAt = at;
          metadataChanged = true;
        }
        const swept = this.sessionTasks.closeLive(session.id, at, "the process that owned this task is gone", { includeBackground: true, onlyBackground: true, state: "stopped" });
        if (changed || claimsRetired) {
          this.writeQueue(session.id, queue);
        }
        if (changed || metadataChanged || swept.length > 0) {
          if (!metadataChanged) this.records.touch(session.id, at);
          else this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(session));
        }
        if (changed) {
          for (const event of recoveryEvents) {
            this.appendEvent(session.id, { type: event.type, reason: "engine_restart" }, event.runId);
          }
        }
      }
      const pruned = this.sessionRequests.pruneHistory();
      if (pruned.dropped > 0) {
        const freed = pruned.bytes >= 1e6 ? `${(pruned.bytes / 1e6).toFixed(1)} MB` : `${Math.round(pruned.bytes / 1e3)} KB`;
        console.log(`[engine] trimmed ${pruned.dropped} resolved requests out of ${pruned.sessions} session${pruned.sessions === 1 ? "" : "s"} (${freed}); the journal still holds them, except policy-resolved pairs of settled turns.`);
      }
      // LAST, once every queue is terminal: nothing above may see the turn this
      // opens, and nothing claims before the caller publishes discovery.
      try {
        this.resumeAfterPlannedRestart(cutOff);
      } catch (error) {
        console.warn("[engine] could not continue sessions after the restart:", error);
      }
      return { stopped };
    });
  }

  /**
   * CONTINUE WHAT A PLANNED RESTART CUT OFF — and only a planned one.
   *
   * THE MARKER IS THE WHOLE PERMISSION. The desktop shell writes
   * `planned-restart.json` immediately before it restarts to install an
   * update; a crash writes nothing, so a crash resumes nothing, whatever the
   * setting says. The marker must also be fresh (`PLANNED_RESTART_WINDOW_MS`):
   * an update that failed to relaunch and a boot days later must not act on a
   * restart nobody remembers. It is deleted on every path — used, refused,
   * stale or unreadable — so it is read by exactly one boot.
   *
   * THREE WAYS A TURN IS CUT OFF, because a quit has more than one ending. If
   * the engine went away under the worker, the turn was still `running` and
   * `recover()` just stopped it (`cutOff`). If the worker got to say so first,
   * the turn is already `failed` with `interrupted`. And on a clean quit the
   * daemon retires the embedded worker's registration BEFORE stopping it, so
   * the turn is `stopped` with `worker_unavailable` and the worker's own
   * `interrupted` is refused — that is the ending every real update took, and
   * missing it is why this never fired (#999). The last two count when they
   * ended at or after the shell announced the restart.
   *
   * ONE CONTINUATION PER SESSION, never a replay. The interrupted prompt is not
   * sent again: whatever it had already done is in the world, and the text
   * tells the model to look before redoing anything. The run id is derived
   * from the marker, so a boot that dies before the marker is gone cannot
   * open a second one — `submitTurn` replays a known run id.
   *
   * WHERE IT SITS: at the back of the queue, which after `recover()` means
   * alone — a restart stops pre-restart backlog too, and that is unchanged.
   * Anything the person sends after this boot queues behind it.
   */
  private resumeAfterPlannedRestart(cutOff: Map<string, string[]>): string[] {
    const file = this.paths.plannedRestart;
    if (!fs.existsSync(file)) return [];
    const resumed: string[] = [];
    try {
      let marker: unknown;
      try {
        marker = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return resumed;
      }
      const now = this.now();
      if (
        typeof marker !== "object" || marker === null ||
        (marker as { version?: unknown }).version !== 1 ||
        (marker as { reason?: unknown }).reason !== "update"
      ) return resumed;
      const plannedAt = (marker as { at?: unknown }).at;
      if (typeof plannedAt !== "number" || !Number.isFinite(plannedAt) || plannedAt > now || now - plannedAt > PLANNED_RESTART_WINDOW_MS) {
        return resumed;
      }
      if (this.getSessionDefaults().resumeAfterRestart !== true) return resumed;

      const candidates = new Map(cutOff);
      for (const session of this.records.all()) {
        if (candidates.has(session.id)) continue;
        const interrupted = this.readQueue(session.id).turns.filter(
          (turn) => endedByShutdown(turn) && turn.kind !== "compact" && (turn.completedAt ?? 0) >= plannedAt,
        );
        if (interrupted.length > 0) candidates.set(session.id, interrupted.map((turn) => turn.runId));
      }
      for (const [sessionId, runIds] of candidates) {
        // One bad session is skipped, never the boot.
        try {
          const session = this.records.get(sessionId);
          // Put away, or stopped by the person (their Stop latch is still up):
          // either way somebody decided this session is done for now.
          if (session.state === "archived" || session.settledOverride === "settled" || session.agentMessagesBlocked || session.draft) continue;
          const turns = this.readQueue(sessionId).turns;
          // A turn the person stopped is theirs to restart, not ours.
          const last = turns.filter((turn) => runIds.includes(turn.runId)).sort((a, b) => b.sequence - a.sequence)[0];
          if (!last || last.stopReason === "user" || last.stopReason === "agent") continue;
          const { turn } = this.submitTurn(sessionId, {
            runId: `run_restart_${plannedAt}_${sessionId}`.slice(0, 200),
            input: PLANNED_RESTART_CONTINUATION,
            origin: "restart",
            restartOrigin: { reason: "update", plannedAt, interruptedRunId: last.runId },
            // The same model and effort the cut-off turn was running on.
            ...(last.model ? { model: (({ instanceId: _instanceId, ...selection }) => selection)(last.model) } : {}),
          });
          resumed.push(turn.runId);
        } catch (error) {
          console.warn(`[engine] could not continue ${sessionId} after the restart:`, error);
        }
      }
      if (resumed.length > 0) console.log(`[engine] continued ${resumed.length} session${resumed.length === 1 ? "" : "s"} cut off by the update restart.`);
      return resumed;
    } finally {
      fs.rmSync(file, { force: true });
    }
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
    return this.kernel.command("retireWorkerRegistration", () => {
      assertId(workerId, "worker id");
      const stopped: string[] = [];
      for (const session of this.records.all()) {
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
            this.sessionTasks.closeOrphaned(session.id, turn.runId, at, "the worker running this agent disappeared");
            this.sessionItems.closeOpen(session.id, new Set([turn.runId]), at);
            this.sessionRequests.closeOpen(session.id, new Set([turn.runId]), at);
          }
        }
        this.writeQueue(session.id, queue);
        this.records.touch(session.id, at);
        for (const runId of settled) this.appendEvent(session.id, { type: "turn.stopped", reason: "worker_unavailable" }, runId);
        stopped.push(...settled);
      }
      const deliveries = this.sessionTasks.readStops();
      const remaining = deliveries.filter((delivery) => delivery.workerId !== workerId);
      if (remaining.length !== deliveries.length) this.writeDocument(this.paths.taskStops, remaining);
      return { stopped };
    });
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

  private scanQueue(sessionId: string): SessionQueue {
    return this.sessionQueues.scan(sessionId);
  }

  private liveQueueSessionIds(): Set<string> {
    return this.sessionQueues.liveSessionIds();
  }

  private readQueue(sessionId: string): SessionQueue {
    return this.sessionQueues.read(sessionId);
  }

  private writeQueue(sessionId: string, queue: SessionQueue): void {
    this.sessionQueues.write(sessionId, queue);
  }

  /**
   * AFTER THE COMMIT, FOR THE SAME REASON `announceQueueChange` DEFERS: telling
   * a worker to abort a claim a rollback then resurrects would kill a turn the
   * store still believes is running. Outside a transaction there is nothing to
   * wait for and the call is direct.
   */
  private announceStoppedClaims(cancellations: StoppedClaim[]): void {
    if (!this.onTurnsStopped || cancellations.length === 0) return;
    if (!this.kernel.inCommand) {
      this.onTurnsStopped(cancellations);
      return;
    }
    this.kernel.afterCommit(() => this.onTurnsStopped?.(cancellations));
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

  /**
   * STOP THE SESSION'S LINGERING BACKGROUND TASKS — the "N tasks still
   * working" chip's Stop. Distinct from `stopTurn`: a background task outlives
   * its turn, so there may be no turn to stop, and stopping the turn would be
   * the wrong verb even if there were one. Marks each task `stopped` in the
   * projection (so the roster is right at once) AND queues the actual process
   * kill for the worker holding the runtime. Returns how many it stopped.
   */
  stopBackgroundTasks(sessionId: string, reason = "stopped from the cockpit"): number {
    return this.kernel.command("stopBackgroundTasks", () => {
      const at = this.now();
      const closed = this.sessionTasks.closeLive(sessionId, at, reason, {
        includeBackground: true,
        onlyBackground: true,
        state: "stopped",
      });
      if (closed.length === 0) return 0;
      const deliveries = this.sessionTasks.readStops();
      const turns = this.readQueue(sessionId).turns;
      const driver = this.records.get(sessionId).driver;
      for (const task of closed) {
        if (!task.providerTaskId) continue;
        const workerId = turns.find((turn) => turn.runId === task.runId)?.claim?.workerId;
        if (workerId) deliveries.push({ deliveryId: `stop_${crypto.randomUUID().replaceAll("-", "")}`, sessionId,
          providerTaskId: task.providerTaskId, workerId, driver });
      }
      this.sessionTasks.writeStops(deliveries);
      this.records.touch(sessionId, at);
      return closed.length;
    });
  }

  taskStopsForWorker(workerId: string, acknowledged: string[] = []): WorkerStatus["stopTask"] {
    return this.sessionTasks.stopsForWorker(workerId, acknowledged);
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
      this.prefixes.extend(sessionId, observation.itemId, observation.text, written.id);
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
      this.prefixes.drop(sessionId, observation.itemId);
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
      this.records.touch(sessionId, at, observation.providerSessionId);
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
      // …except an ending nobody stated (`isUnstatedEnding`): the level signal
      // closed it, and the notification behind it saying how it went is the
      // better account. Only a worse outcome may replace it.
      const corrected = settled && isUnstatedEnding(known) && (seed.state === "failed" || seed.state === "stopped");
      const kept = settled && !corrected;
      const state = kept ? known.state : seed.state;
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
      if (kept) {
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
        const onlySummary = changed.every((key) => key === "resultText" || key === "usage" || key === "outputFile");
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
    if (started) this.prefixes.remember(sessionId, item.id, { text: "", through: written.id, sealed: true });
  }

  private appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent {
    return this.kernel.appendEvent(sessionId, event, runId);
  }

  watch(listener: (event: EngineEvent) => void): () => void {
    return this.kernel.watch(listener);
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
