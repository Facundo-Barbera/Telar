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
  countsAsActivity,
  isBackgroundWork,
  type RetentionPolicy,
  type RetentionBucket,
  type JournalRetirement,
  workspaceBaseRef,
  workspacePath,
  type UsageLimitSource,
  machineAllows,
  type ProjectPlugins,
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
  type Item,
  type McpServer,
  type NotificationDetail,
  type ProviderInstance,
  type TurnAttachment,
  type ProviderDriverKind,
  // The runtime enum too, not just the type: `readProviderInstances` asks it
  // whether a row on disk names a driver this build still has.
  type Task,
  type Project,
  type EngineRequest,
  type RequestKind,
  type RequestOpenResult,
  type Session,
  type SessionSettleEnded,
  type Subscription,
  type Cohort,
  type SubscribedCohort,
  type Turn,
  type WakeKind,
  type WakeReason,
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
  type WorktreeInventory,
  type WorktreeReclaimItem,
  type WorktreeReclaimResult,
} from "@telar/engine-client";
import { type ProjectPatch, ProjectProbes, ProjectRegistry, ProjectRemounts, WorkspaceConfigStore } from "./domains/projects";
import { assertId, EngineStateError, Kernel, type JournalEntry } from "./platform/kernel";
import { SettingsStore } from "./domains/settings";
import { AppearanceStore } from "./domains/appearance";
import { type McpOAuthRecord, McpOAuthStore, McpServers, type OAuthClientStore, type PendingMcpOAuth } from "./domains/agent-tools";
import { installedCli, ModelCatalogues, ProviderRegistry, type InstalledCli, type ProviderInstanceInput } from "./domains/providers";
import { DataScienceOps, LatexOps, PluginToolchains } from "./domains/plugins";
import { UsageLimitSources, type ResolvedUsageLimitSource, type UsageLimitSourceInput } from "./domains/usage";
import { type AttachmentInput, type OpenRequestInput, RequestGate, requestTitle, type ResolveRequestInput, SessionQueries, createSessionModules, SessionAttachments, workspaceRootOf, delegationSettle, type DeliveryTurn, isPeerMail, newestAssignment, OpenPrefixes, SessionActivity, sessionDir, SessionIndex, SessionItems, SessionMailbox, sessionMetadataFile, type SessionQueue, SessionQueues, SessionRecords, SessionRequests, SessionLifecycle, SessionSubscriptions, SessionTasks, storedSession, TERMINAL_WAKE_KINDS } from "./domains/sessions";
import { FOLDING_INTENTS, heldDelivery, TurnRecovery, isLiveTask, TurnClaims, TurnIngest, type StoppedClaim, TurnLifecycle, TurnIntake, type TurnSubmission, MAX_DELIVERIES, mergeNotifications, mergeRunOutcome, notificationLabel, quotedExcerpt, RELAY_RULE, wakeNotification, withoutWakesFrom } from "./domains/turns";
import { Dictation } from "./domains/dictation";
import { type ResolvedComputerUse } from "./domains/computer-use";
import { type ProjectIcon } from "./domains/appearance";
import { listWorkspaceFilesAsync, readFenced, readFencedAsync, readFencedBytes, writeFenced } from "./domains/files";
import { cloneRepository, commitSessionWork, ensureTelarGitignore, gitOverviewAsync, isCloneFailure, pushSessionBranch, removeTelarGitignore, sessionDiffAsync, sessionFilePatchAsync, type GitOverview } from "./domains/git";
import {  } from "./platform/git/parse";
import { type AttachedBrowser, SessionBrowser } from "./domains/browser";
import { GitHubStore, defaultGhRunner, SessionPulls, type GhRunner } from "./domains/github";
import {  } from "zod";
import { type AdoptionInput, ConversationAdoption } from "./domains/providers";
import { type ClaudeConversation } from "./drivers/claude";
import { BUNDLED_MANIFEST, type ModelManifest, readModelCatalogue } from "./domains/providers";
import { type BootstrapRequest, type CompileStatus as LatexCompileMemory, type CreateEnvironmentRequest, type DsCapability, DsFiles, type JobRead, JobRunner, type KernelHost, type LatexBootstrapRequest, type LatexCapability, type LatexPackagesAnswer, type LatexToolchain, type ManagedTectonicStatus, NOTEBOOK_MAX_BYTES, type RequirementsSource, type ResolvedLatex, storeDsCapability, storeLatexCapability, type TableWindow, telarVenvDir, type Toolchain, windowCsv } from "./domains/plugins";
import { ScheduleBook, type ScheduleInput } from "./domains/schedules";
import { WorktreeMaintenance, createWorktreeQueue, defaultWorktreeGitRunner, type WorktreeQueue, type ReleaseRefusal, SETUP_STOP_GRACE_MS, WorktreeSetups, type MoveOutcome } from "./domains/worktrees";
import { defaultGitRunner, defaultAsyncGitRunner, type AsyncGitRunner, type GitResult, type GitRunner } from "./platform/git/runner";
import { backfillTurnSummaries, CheckoutSizes, CleanupStore, copyStore, migrateBareClaudeIds, migrateClaudeCompactionToLimits, migrateLegacyPluginFieldsOnOpen, type CheckoutSizesOptions } from "./domains/storage";
import { type AttachedTerminals, pipeLauncher, processGroupFor, SessionTerminals } from "./domains/terminal";
import { type ProjectAvailability, type VolumeDeps } from "./platform/fs/volumes";

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

/** One clamped line for a wake. A wake is a ping; nothing in it is a payload. */
function clampWake(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_WAKE_LINE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_WAKE_LINE_CHARS)}… [${trimmed.length - MAX_WAKE_LINE_CHARS} more characters — sessions_read has the rest]`;
}




/** How much of a finished turn's answer rides in the wake that announces it.
 *  The whole answer is one `sessions_read` away; the wake is a summons. */
/**
 * The clamp on any single line a wake carries — a failure message, a request's
 * prompt, a field label. Not a budget for a result: a wake carries no result at
 * all (see `wakeMessage`), and this only keeps a pathological one-liner from
 * becoming the notice.
 */
const MAX_WAKE_LINE_CHARS = 240;


const RESULT_DELIVERED_STATES: ReadonlySet<Turn["state"]> = new Set(["claimed", "running", "steering", "steered", "completed"]);




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
 * The session's terminals as the STORE is allowed to see them — the run
 * manager, narrowed. `openCount` knows only the terminals the engine opened
 * (runs and the agent's); `closeSession` reaches the person's shells too,
 * because the desktop host closes by session.
 */
/**
 * One claim a Stop just killed — the same triple `cancellationsForWorker`
 * returns, plus the worker it belongs to, because this is PUSHED rather than
 * asked for and the receiver has to check the claim is its own.
 */

export type EngineNotifier = (input: {
  sessionId: string;
  runId: string;
  requestId: string;
  kind: RequestKind;
  title: string;
}) => boolean;



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
  private readonly remounts: ProjectRemounts;
  private readonly attachments: SessionAttachments;
  private readonly queries: SessionQueries;
  private readonly intake: TurnIntake;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly ingest: TurnIngest;
  private readonly claims: TurnClaims;
  private readonly recovery: TurnRecovery;
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
  private readonly schedules: ScheduleBook;
  private readonly requestGate: RequestGate;
  private readonly sessionTerminals: SessionTerminals;
  private readonly sessionPulls: SessionPulls;
  private readonly adoption: ConversationAdoption;
  readonly dictation: Dictation;
  private readonly dataScienceOps: DataScienceOps;
  private readonly latexOps: LatexOps;

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

  attachTerminals(terminals: AttachedTerminals): void {
    this.sessionTerminals.attach(terminals);
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
      openTerminals: (id) => this.sessionTerminals.openCount(id),
      hasLiveBackgroundWork: (id) => this.hasLiveBackgroundWork(id),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      archiveSession: (id, options) => this.archiveSession(id, options),
    });
  }

  refreshTerminalCensus(): Promise<void> {
    return this.sessionTerminals.refresh();
  }

  sessionTerminalCount(sessionId: string): Promise<number> {
    return this.sessionTerminals.countNow(sessionId);
  }

  closeSessionTerminals(sessionId: string): Promise<number> {
    return this.sessionTerminals.closeForPerson(sessionId);
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
      environments: async () => ({ environments: await this.dataScienceOps.environmentRows(session.projectId!, workspaceRootOf(session)) }),
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
    if (patch.settledTerminalLimit !== undefined && this.sessionTerminals.attached) {
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
      projectProbes: this.projectProbes, projectRegistry: this.projectRegistry, catalogues: this.catalogues, providers: this.providers, toolchains: this.toolchains, github: this.github, browser: this.browser, remounts: this.remounts,
    } = this.leafStores(options));
    ({
      records: this.records, items: this.sessionItems, requests: this.sessionRequests, tasks: this.sessionTasks, mailbox: this.mailbox,
      activity: this.activity, index: this.sessionIndex, queues: this.sessionQueues, prefixes: this.prefixes, attachments: this.attachments, queries: this.queries,
    } = createSessionModules(this.kernel, {
      readQueue: (sessionId) => this.readQueue(sessionId),
      readEvents: (sessionId) => this.readEvents(sessionId),
      subscriptionsOf: (sessionId) => this.subscriptions.subscriptionsOf(sessionId),
      nextWake: (sessionId) => this.schedules.nextWake(sessionId),
      autoSettleAfterHours: () => this.getInboxPolicy().autoSettleAfterHours,
      ...(options.onQueueChanged ? { onQueueChanged: options.onQueueChanged } : {}),
    }));
    this.subscriptions = this.createSubscriptions();
    this.lifecycle = this.createLifecycle();
    this.intake = this.createIntake();
    this.turnLifecycle = this.createTurnLifecycle();
    this.claims = this.createClaims();
    this.recovery = new TurnRecovery(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      getSessionDefaults: () => this.getSessionDefaults(),
      submitTurn: (id, input) => this.submitTurn(id, input),
    });
    this.ingest = new TurnIngest(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      prefixes: this.prefixes,
      readQueue: (id) => this.readQueue(id),
      scanQueue: (id) => this.scanQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      requireRunningClaimFromQueue: (queue, runId, token) => this.requireRunningClaimFromQueue(queue, runId, token),
    });
    this.worktrees = this.worktreeMaintenance();
    ({ dataScienceOps: this.dataScienceOps, latexOps: this.latexOps } = this.createPluginOps());
    this.dictation = new Dictation(this.paths.root, {
      liveSessions: () => this.liveSessionRows().sessions,
      projects: () => this.projectRegistry.read().projects,
    });
    this.adoption = new ConversationAdoption(this.records, this.sessionItems, {
      engineRoot: this.paths.root,
      now: () => this.now(),
      resolveInstance: (instanceId, driver) => this.resolveProviderInstance(instanceId, driver),
      readQueue: (sessionId) => this.readQueue(sessionId),
      writeQueue: (sessionId, queue) => this.writeQueue(sessionId, queue),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
    });
    this.sessionPulls = new SessionPulls(this.github, {
      getSession: (sessionId) => this.records.get(sessionId),
      getProject: (projectId) => this.getProject(projectId),
      worktreeGit: this.worktreeGit,
      asyncGit: this.asyncGit,
      gh: this.gh,
    });
    this.sessionTerminals = new SessionTerminals(this.records, this.sessionIndex, {
      now: () => this.now(),
      inboxPolicy: () => this.getInboxPolicy(),
      recordSession: (session) => {
        this.writeDocument(sessionMetadataFile(this.paths, session.id), storedSession(session));
        this.appendEvent(session.id, { type: "session.updated", session });
      },
    });
    this.requestGate = new RequestGate(this.kernel, this.records, this.sessionRequests, {
      requireRunningClaim: (sessionId, runId, claimToken) => this.requireRunningClaim(sessionId, runId, claimToken),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      scanQueue: (sessionId) => this.scanQueue(sessionId),
      appendEvent: (sessionId, event, runId) => this.appendEvent(sessionId, event, runId),
      requestOpened: (sessionId, turn, request) => this.fireSubscriptions(sessionId, "request_opened", turn, { request }),
    });
    this.schedules = new ScheduleBook(this.kernel, {
      requireSession: (sessionId) => void this.records.require(sessionId),
      submitTurn: (sessionId, input) => this.submitTurn(sessionId, input),
      bumpList: () => this.sessionIndex.bumpList(),
    });
    this.registerCacheHooks();
    // The backfill's writes go through one transaction rather than one per row.
    this.sessionIndexBackfill = this.sessionIndex.backfill();
    this.turnSummaryBackfill = backfillTurnSummaries(this.kernel, this.sessionItems, this.sessionQueues);
    // Before anything can claim a turn — see the method.
    this.claudeLongWindowMigration = migrateBareClaudeIds(this.kernel, () => this.records.ids(), this.catalogues.manifest);
    this.claudeCompactionMigration = migrateClaudeCompactionToLimits(this.kernel);
    this.pluginFieldMigration = migrateLegacyPluginFieldsOnOpen(this.kernel);
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
      onUnavailable: (project) => void this.remounts.recover(project),
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
    const remounts = new ProjectRemounts(this.kernel, {
      registry: projectRegistry,
      probes: projectProbes,
      volumes: this.volumes,
      sessions: () => this.records.read(),
      prepareWorktree: (sessionId, root, plan, baseSha) => this.lifecycle.prepareWorktree(sessionId, root, plan, baseSha),
    });
    const browser = new SessionBrowser(this.kernel, {
      require: (id) => void this.records.require(id),
      getSession: (id) => this.records.get(id),
      runningRunId: (id) => this.readQueue(id).turns.find((turn) => turn.state === "running")?.runId,
    });
    return { settings, appearance, mcpOAuth, mcpServers, usageSources, projectProbes, projectRegistry, catalogues, providers, toolchains, github, browser, remounts };
  }

  /** How many projects the legacy-field fold changed on this open (0 on most). */
  readonly pluginFieldMigration: number;
  /** How many logins the one-time compaction rewrite changed on this open, or nothing when it had already run. */
  readonly claudeCompactionMigration?: number;
  /** What the one-time `[1m]` rewrite changed on this open, or nothing when it had already run. */
  readonly claudeLongWindowMigration?: { sessions: number; projects: number };
  /** What the index backfill built on open, for the daemon to report; zero on every open after the first. */
  readonly sessionIndexBackfill?: { built: number; removed: number };
  /** What the turn projection built on open, reported like the index backfill. */
  readonly turnSummaryBackfill?: { sessions: number; turns: number };

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
       * `ProjectRemounts.recover`. Attempted only when the project cannot be
       * read, which is what keeps the `diskutil` it costs off the poll path, and
       * HERE rather than inside the probe because this is the call that happens
       * when a disk has just appeared.
       */
      if (availability !== "available" && this.remounts.recover(project) !== undefined) {
        recovered += 1;
        availability = this.projectAvailability(this.getProject(project.id));
      }
      if (availability !== before) changed += 1;
    }
    return { projects: projects.length, changed, recovered };
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
    return this.dataScienceOps.toolchain(fresh);
  }

  dataScienceEnvironments(projectId: string, workspace?: string) {
    return this.dataScienceOps.environments(projectId, workspace);
  }

  dataScienceUseEnvironment(sessionId: string, target: string) {
    return this.dataScienceOps.useEnvironment(sessionId, target);
  }

  dataScienceCreateEnvironment(projectId: string, request: CreateEnvironmentRequest): Promise<{ jobId: string }> {
    return this.dataScienceOps.createEnvironment(projectId, request);
  }

  dataSciencePackages(projectId: string, workspace?: string) {
    return this.dataScienceOps.packages(projectId, workspace);
  }

  dataScienceInstall(projectId: string, input: { add?: string[]; remove?: string[]; requirements?: RequirementsSource }, workspace?: string): Promise<{ jobId: string }> {
    return this.dataScienceOps.install(projectId, input, workspace);
  }

  dataScienceBootstrap(request: BootstrapRequest): Promise<{ jobId: string }> {
    return this.dataScienceOps.bootstrap(request);
  }

  dataScienceJob(jobId: string, after?: number): JobRead {
    return this.dataScienceOps.job(jobId, after);
  }

  dataScienceCancelJob(jobId: string): void {
    this.dataScienceOps.cancelJob(jobId);
  }

  dataScienceProbe(projectId: string, target: string) {
    return this.dataScienceOps.probe(projectId, target);
  }

  latexToolchain(fresh = false): Promise<LatexToolchain> {
    return this.latexOps.toolchain(fresh);
  }

  latexDistributions(projectId: string) {
    return this.latexOps.distributions(projectId);
  }

  latexBootstrap(request: LatexBootstrapRequest): Promise<{ jobId: string }> {
    return this.latexOps.bootstrap(request);
  }

  latexPackages(projectId: string): Promise<LatexPackagesAnswer> {
    return this.latexOps.packages(projectId);
  }

  latexInstall(projectId: string, input: { add?: string[]; remove?: string[] }): Promise<{ jobId: string }> {
    return this.latexOps.install(projectId, input);
  }

  latexJob(jobId: string, after?: number): JobRead {
    return this.latexOps.job(jobId, after);
  }

  latexCancelJob(jobId: string): void {
    this.latexOps.cancelJob(jobId);
  }

  private createPluginOps(): { dataScienceOps: DataScienceOps; latexOps: LatexOps } {
    return {
      dataScienceOps: new DataScienceOps(this.toolchains, this.dsJobs, {
        root: this.paths.root,
        now: () => this.now(),
        getProject: (projectId) => this.getProject(projectId),
        updateProject: (projectId, patch) => this.updateProject(projectId, patch),
        getSession: (sessionId) => this.records.get(sessionId),
        restartKernel: (sessionId) => this.dataScience(sessionId).restart(),
        machinePlugins: () => this.machinePlugins(),
      }),
      latexOps: new LatexOps(this.toolchains, this.latexJobs, (projectId) => this.getProject(projectId)),
    };
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

  openSessionPullRequest(sessionId: string, input: { title: string; body?: string; base?: string }): Promise<GitHubPullCreateResult> {
    return this.sessionPulls.open(sessionId, input);
  }

  sessionPullAnchor(sessionId: string): Promise<GitHubPullAnchor> {
    return this.sessionPulls.anchor(sessionId);
  }

  sessionPullLineComment(sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    return this.sessionPulls.lineComment(sessionId, input);
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
    // By the (project_id, updated_at) index, so only this project's documents are parsed.
    const rows = this.kernel.executionStore.projectSessionRows(projectId);
    return this.records.read(new Set(rows.map((row) => row.id)));
  }

  /** Each project's latest activity, folded off the index rather than the documents. Active sessions only,
   *  matching the list it replaced, so a project whose sessions are all archived scores nothing. */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    return this.kernel.executionStore.projectActivity();
  }

  /**
   * Every active session across projects in one read, with the registry and the sidebar
   * layout beside it: every rail polls this, so a drag on one device reaches the others.
   */
  liveSessions(only?: Set<string>): {
    sessions: Session[];
    // The rail's "drive not connected" badge, so it needs no second fetch per pass.
    projects: Array<{ id: string; name: string; availability?: ProjectAvailability }>;
    assignments: Record<string, SessionAssignment[]>;
    layout: SidebarLayout;
  } {
    const projects = this.projectRegistry.read().projects;
    // One pass over the queues answers activity and assignments, not a history fetch per row.
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
   * `liveSessions` projected to what a rail draws (`LiveSessionRow`), with the settling window.
   * Unsettled rows only unless `all`; the shelf rule is the clients' own `isShelved`.
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
    // Read first, so a write that lands mid-fold is reported by the next read rather than swallowed.
    const revision = this.sessionsRevision({ all: options.all === true });
    const inbox = this.getInboxPolicy();
    // Every conversation settles by the same rule; nothing is exempted.
    const indexed = this.activity.shelf(inbox, options.all === true);
    // Documents are read only for rows that survived the partition; activity is re-derived
    // from them rather than trusted from a possibly stale row.
    const full = this.liveSessions(indexed.chosen);
    return {
      ...full,
      sessions: full.sessions.map(liveRow),
      inbox,
      revision,
      settledCount: indexed.settledCount,
      terminals: this.sessionTerminals.countsFor(full.sessions.map((session) => session.id)),
    };
  }

  turns(sessionId: string): Turn[] {
    this.records.require(sessionId);
    return structuredClone(this.readQueue(sessionId).turns);
  }

  turnOutline(...args: Parameters<SessionQueries["turnOutline"]>): ReturnType<SessionQueries["turnOutline"]> {
    return this.queries.turnOutline(...args);
  }

  runItems(...args: Parameters<SessionQueries["runItems"]>): ReturnType<SessionQueries["runItems"]> {
    return this.queries.runItems(...args);
  }

  runItem(...args: Parameters<SessionQueries["runItem"]>): ReturnType<SessionQueries["runItem"]> {
    return this.queries.runItem(...args);
  }

  turnAnswer(...args: Parameters<SessionQueries["turnAnswer"]>): ReturnType<SessionQueries["turnAnswer"]> {
    return this.queries.turnAnswer(...args);
  }

  grepSession(...args: Parameters<SessionQueries["grepSession"]>): ReturnType<SessionQueries["grepSession"]> {
    return this.queries.grepSession(...args);
  }

  findSessions(...args: Parameters<SessionQueries["findSessions"]>): ReturnType<SessionQueries["findSessions"]> {
    return this.queries.findSessions(...args);
  }

  snapshotWindow(...args: Parameters<SessionQueries["snapshotWindow"]>): ReturnType<SessionQueries["snapshotWindow"]> {
    return this.queries.snapshotWindow(...args);
  }

  snapshotRequests(sessionId: string): EngineRequest[] {
    return this.queries.snapshotRequests(sessionId);
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


  private createClaims(): TurnClaims {
    return new TurnClaims(this.kernel, {
      records: this.records,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      mailbox: this.mailbox,
      catalogues: this.catalogues,
      computerUse: () => this.computerUse?.(),
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      scanQueue: (id) => this.scanQueue(id),
      liveQueueSessionIds: () => this.liveQueueSessionIds(),
      requeueUndeliveredSteers: (queue, runId, at) => this.requeueUndeliveredSteers(queue, runId, at),
      fireSubscriptions: (id, kind, turn, context) => this.fireSubscriptions(id, kind, turn, context),
      flushPendingNotifications: (id) => this.flushPendingNotifications(id),
      getSessionDefaults: () => this.getSessionDefaults(),
      listMcpServers: () => this.listMcpServers(),
      resolveProviderInstance: (instanceId, driver) => this.resolveProviderInstance(instanceId, driver),
      getProject: (id) => this.getProject(id),
      resolveDataScience: (session) => this.resolveDataScience(session),
      resolveLatex: (session) => this.resolveLatex(session),
      enabledPluginIds: (session) => this.enabledPluginIds(session),
      getAgentOrientation: () => this.getAgentOrientation(),
    });
  }

  private createTurnLifecycle(): TurnLifecycle {
    return new TurnLifecycle(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      tasks: this.sessionTasks,
      requests: this.sessionRequests,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      requireRunningClaimFromQueue: (queue, runId, token) => this.requireRunningClaimFromQueue(queue, runId, token),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      anchorTurn: (id, runId, side) => this.anchorTurn(id, runId, side),
      fireSubscriptions: (id, kind, turn, context) => this.fireSubscriptions(id, kind, turn, context),
      flushPendingNotifications: (id) => this.flushPendingNotifications(id),
      evaluateDelegationSettling: (id) => this.evaluateDelegationSettling(id),
      stopBackgroundTasks: (id) => this.stopBackgroundTasks(id),
      announceStoppedClaims: (cancellations) => this.announceStoppedClaims(cancellations),
    });
  }

  private createIntake(): TurnIntake {
    return new TurnIntake(this.kernel, {
      records: this.records,
      items: this.sessionItems,
      mailbox: this.mailbox,
      attachments: this.attachments,
      git: this.git,
      readQueue: (id) => this.readQueue(id),
      writeQueue: (id, queue) => this.writeQueue(id, queue),
      getProject: (id) => this.getProject(id),
      availability: (project) => this.projectAvailability(project),
      assertProjectAvailable: (id) => this.assertProjectAvailable(id),
      restoreWorktree: (id) => void this.restoreSessionWorktree(id),
      prepareWorktree: (id, root, plan, baseSha) => this.lifecycle.prepareWorktree(id, root, plan, baseSha),
      promoteTurn: (id, runId) => this.promoteTurn(id, runId),
      requireSenderClaim: (proof) => this.requireSenderClaim(proof),
      hasLiveTurn: (id) => this.hasLiveTurn(id),
      waitingNotificationTurn: (id) => this.waitingNotificationTurn(id),
      joinWaitingNotification: (id, waitingRunId, notification) => this.joinWaitingNotification(id, waitingRunId, notification),
      rewriteNotificationItem: (id, turn) => this.rewriteNotificationItem(id, turn),
      waitingSubscription: (subscriber, target) =>
        this.subscriptions.readSubscriptions().some((sub) => sub.subscriberSessionId === subscriber && sub.targetSessionId === target && sub.events.includes("turn_completed")),
      cohortHolds: (id, sender) => this.subscriptions.cohortHolds(id, sender),
      recordCohortMessage: (id, sender, intent, runId, text) => this.subscriptions.recordCohortMessage(id, sender, intent, runId, text),
    });
  }

  submitTurn(sessionId: string, input: TurnSubmission): { turn: Turn; replayed: boolean } {
    return this.intake.submitTurn(sessionId, input);
  }

  submitAgentTurn(...args: Parameters<TurnIntake["submitAgentTurn"]>): { turn: Turn; replayed: boolean } {
    return this.intake.submitAgentTurn(...args);
  }

  private writeNotificationItem(sessionId: string, turn: Turn): void {
    this.intake.writeNotificationItem(sessionId, turn);
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







  claimTurn(sessionId: string, workerId: string): Turn | undefined {
    return this.claims.claimTurn(sessionId, workerId);
  }


  openProviderTurn(...args: Parameters<TurnClaims["openProviderTurn"]>): Turn {
    return this.claims.openProviderTurn(...args);
  }


  listAdoptableClaudeConversations(options: { instanceId?: string; cwd?: string; limit?: number } = {}): Promise<ClaudeConversation[]> {
    return this.adoption.list(options);
  }

  adoptClaudeConversation(sessionId: string, input: AdoptionInput) {
    return this.adoption.adopt(sessionId, input);
  }

  reportSessionTasks(sessionId: string, workerId: string, observations: unknown[]): { accepted: number } {
    return this.ingest.reportSessionTasks(sessionId, workerId, observations);
  }

  claudeAdmissionNeedsCatalogue(sessionId: string, turnModel?: { model?: string }): boolean {
    return this.claims.claudeAdmissionNeedsCatalogue(sessionId, turnModel);
  }




  prepareClaudeCatalogue(timeoutMs?: number): Promise<void> {
    return this.catalogues.prepareClaude(timeoutMs);
  }





  claimNextTurn(workerId: string): WorkerClaim | undefined {
    return this.claims.claimNextTurn(workerId);
  }




  markRunning(sessionId: string, runId: string, claimToken: string): Turn {
    return this.turnLifecycle.markRunning(sessionId, runId, claimToken);
  }


  ingestObservations(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    return this.ingest.ingestObservations(sessionId, runId, claimToken, observations);
  }




  completeTurn(...args: Parameters<TurnLifecycle["completeTurn"]>): Turn {
    return this.turnLifecycle.completeTurn(...args);
  }


  resumeRateLimitedTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.resumeRateLimitedTurn(sessionId, runId);
  }


  failTurn(...args: Parameters<TurnLifecycle["failTurn"]>): Turn {
    return this.turnLifecycle.failTurn(...args);
  }


  stopSession(sessionId: string, by: "user" | "agent" = "user"): { stopped: Turn[]; live?: Turn } {
    return this.turnLifecycle.stopSession(sessionId, by);
  }


  stopTurn(sessionId: string, requestedRunId?: string): { turn?: Turn; stopped: boolean } {
    return this.turnLifecycle.stopTurn(sessionId, requestedRunId);
  }



  promoteTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.promoteTurn(sessionId, runId);
  }


  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Turn {
    return this.turnLifecycle.ackSteer(sessionId, steerRunId, claimToken);
  }


  private requeueUndeliveredSteers(queue: { turns: Turn[] }, runId: string, at: number): Turn[] {
    return this.turnLifecycle.requeueUndeliveredSteers(queue, runId, at);
  }


  releaseHeldTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.releaseHeldTurn(sessionId, runId);
  }


  discardAmbiguousTurn(sessionId: string, runId: string): Turn {
    return this.turnLifecycle.discardAmbiguousTurn(sessionId, runId);
  }


  archiveSession(sessionId: string, options: { releaseCheckout?: boolean } = {}): Session {
    return this.lifecycle.archiveSession(sessionId, options);
  }







  deleteSession(sessionId: string): boolean {
    return this.lifecycle.deleteSession(sessionId);
  }


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
    const terminals = await this.sessionTerminals.closeForSettle(sessionId);
    return { terminals, backgroundTasks };
  }

  sweepSettledTerminals(): Promise<string[]> {
    return this.sessionTerminals.sweepSettled();
  }

  enforceSettledTerminalLimit(): Promise<string[]> {
    return this.sessionTerminals.enforceLimit();
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
  sweepSchedules(): string[] {
    return this.schedules.sweep();
  }

  listSchedules(sessionId?: string): ScheduleRow[] {
    return this.schedules.list(sessionId);
  }

  readSchedule(id: string): ScheduleRow | undefined {
    return this.schedules.read(id);
  }

  putSchedule(input: ScheduleInput): ScheduleRow {
    return this.schedules.put(input);
  }

  deleteSchedule(id: string): boolean {
    return this.schedules.delete(id);
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

  sweepRequestDeadlines(): string[] {
    return this.requestGate.sweepDeadlines();
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
    if (this.sessionTerminals.attached) void Promise.resolve().then(() => this.enforceSettledTerminalLimit()).catch(() => undefined);
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
    return this.requestGate.list(sessionId);
  }

  openRequest(sessionId: string, runId: string, claimToken: string, input: OpenRequestInput): RequestOpenResult {
    return this.requestGate.open(sessionId, runId, claimToken, input);
  }

  resolveRequest(sessionId: string, requestId: string, input: ResolveRequestInput): EngineRequest {
    return this.requestGate.resolve(sessionId, requestId, input);
  }

  resolutionsForWorker(workerId: string): WorkerStatus["resolved"] {
    return this.requestGate.resolutionsForWorker(workerId);
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

  recover(): { stopped: string[] } {
    return this.recovery.recover();
  }



  retireWorkerRegistration(workerId: string): { stopped: string[] } {
    return this.recovery.retireWorkerRegistration(workerId);
  }


  cancellationsForWorker(workerId: string): Array<{ sessionId: string; runId: string; claimToken: string }> {
    return this.recovery.cancellationsForWorker(workerId);
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
