/**
 * vNext engine protocol v2 — the durable entities.
 *
 *   Environment
 *     └── Project      a registered repo
 *           └── Session    a durable conversation; survives restart and disconnect
 *                 ├── Runtime  the live provider process, if any (0..1)
 *                 └── Turn     one user input and everything it caused
 *
 * SESSION AND RUNTIME ARE SPLIT; SESSION AND "THREAD" ARE NOT. t3 code carries
 * both a `Thread` (the conversation) and a `ProviderSession` (the process) and
 * the overload is a visible source of confusion in its own code. Here the
 * durable, user-facing thing is a Session and the process attached to it is a
 * Runtime — one session, zero or one live runtime. A session with no runtime is
 * COLD, and reopening it starts a runtime that resumes from the stored cursor.
 */
import { z } from "zod";
import {
  EnvMode,
  EnvironmentId,
  Id,
  InteractionMode,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  Timestamp,
  TurnAttachment,
  UsageSnapshot,
} from "./common";

export const Project = z.object({
  id: Id,
  environmentId: EnvironmentId,
  name: z.string().min(1),
  root: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

/** Lifecycle of the conversation itself, independent of whether a process is
 *  currently attached to it. */
export const SessionState = z.enum(["active", "archived"]);
export type SessionState = z.infer<typeof SessionState>;

/**
 * Where a session's work lands on disk. `worktree` sessions get a checkout of
 * their own, created through `packages/core/src/vcs.ts`, so N detached sessions
 * on one project do not collide.
 */
export const SessionWorkspace = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local"),
    path: z.string().min(1),
    /**
     * The commit HEAD pointed at when this session was created.
     *
     * A WORKTREE SESSION HAS ALWAYS HAD ONE and a local session never did, which
     * made "what has this session done to the repository" answerable for half of
     * them. It is the only anchor that survives the agent committing: `git
     * status` forgets a commit the moment it lands, and a branch comparison
     * forgets everything still uncommitted. Optional because sessions created
     * before this existed have no base — the review surface falls back to HEAD
     * and says which question it is answering.
     */
    baseRef: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("worktree"),
    path: z.string().min(1),
    branch: z.string().min(1),
    /** The commit the worktree was cut from, so a stale one is detectable. */
    baseRef: z.string().min(1).optional(),
  }),
]);
export type SessionWorkspace = z.infer<typeof SessionWorkspace>;

export const Session = z.object({
  id: Id,
  projectId: Id,
  environmentId: EnvironmentId,
  title: z.string(),
  state: SessionState,
  createdAt: Timestamp,
  updatedAt: Timestamp,

  /** Routing is by instance; the driver is descriptive. See ./common.ts. */
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: ModelSelection.optional(),

  workspace: SessionWorkspace,
  envMode: EnvMode,

  /** What this session may do without asking. Set at creation, changeable
   *  mid-session — a human can hand a running session more rope, or take it. */
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,

  /**
   * Whether a human is expected to be watching.
   *
   * IT IS A DECLARATION, NOT AN OBSERVATION. The engine never requires a client
   * to be connected — detached is the default posture, not a mode you switch
   * into. This field says what the session should DO when a request opens with
   * nobody home, and it is what a notification policy reads.
   */
  detached: z.boolean(),

  /** Cumulative across every turn. Per-turn figures live on the turn. */
  usage: UsageSnapshot.optional(),

  /** Provider continuity for the NEXT runtime. Opaque; the engine owns it. */
  resumeCursor: z.string().min(1).optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * The live process. Not user-owned state — the engine's handle on something it
 * supervises, and safe to lose: everything durable is on the session and the
 * journal.
 */
export const RuntimeState = z.enum(["starting", "ready", "running", "waiting", "stopped", "error"]);
export type RuntimeState = z.infer<typeof RuntimeState>;

/** `waiting` is the one that matters for detached runs: it means an open
 *  request is parked and no further work will happen until someone answers. */
export const Runtime = z.object({
  sessionId: Id,
  state: RuntimeState,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  startedAt: Timestamp,
  updatedAt: Timestamp,
  /** Set while `state` is "running". */
  activeRunId: Id.optional(),
  lastError: z.string().min(1).optional(),
});
export type Runtime = z.infer<typeof Runtime>;

/**
 * Turn lifecycle. THE V1 STATES ARE KEPT VERBATIM, deliberately — they are the
 * best-designed part of protocol v1 and they are what makes a detached turn
 * safe to recover after a crash:
 *
 *   queued → claimed → running → completed | failed | stopped
 *                              ↘ ambiguous → discarded | (replayed)
 *
 * `ambiguous` is the state a turn lands in when the engine cannot tell whether
 * a provider invocation actually happened — the crash-mid-call case. It is NOT
 * auto-retried, because replaying a turn that already ran can duplicate side
 * effects; a human chooses, and `discarded` records that they chose not to.
 * Losing this would make crash recovery guesswork.
 */
export const TurnState = z.enum([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "stopped",
  "ambiguous",
  "discarded",
]);
export type TurnState = z.infer<typeof TurnState>;

/** Why a turn stopped short of completing. */
export const TurnFailureCode = z.enum([
  "provider_unavailable",
  "driver_failed",
  "cancelled",
  "budget_exhausted",
  "internal_error",
]);
export type TurnFailureCode = z.infer<typeof TurnFailureCode>;

/** A worker's exclusive lease on a queued turn. The token is what stops two
 *  workers running the same turn after a partition. */
export const TurnClaim = z.object({
  workerId: Id,
  token: Id,
  at: Timestamp,
});
export type TurnClaim = z.infer<typeof TurnClaim>;

export const Turn = z.object({
  /**
   * CLIENT-SUPPLIED IDEMPOTENCY KEY, kept from v1. Submitting the same runId
   * twice returns the first turn rather than queueing a second — which is what
   * makes a retry after a dropped response safe.
   */
  runId: Id,
  sessionId: Id,
  sequence: z.number().int().nonnegative(),
  state: TurnState,

  /** What the human asked for. */
  input: z.string(),
  /**
   * Files sent WITH this message.
   *
   * ON THE TURN RATHER THAN THE SESSION, because that is what they are: an
   * attachment answers "look at this" about one message, and a session-level
   * list would have no answer to which message it belonged to. Stored resolved
   * (name, media type, path) rather than as ids, so replaying a turn from the
   * queue does not require a second lookup that could have gone stale.
   */
  attachments: z.array(TurnAttachment).optional(),
  /** Model actually used, which may differ from the session default if the
   *  turn overrode it or the provider rerouted. The instance is always the
   *  session's — see `TurnModelSelection`. */
  model: ModelSelection.optional(),
  interactionMode: InteractionMode.optional(),

  acceptedAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Timestamp.optional(),
  completedAt: Timestamp.optional(),

  claim: TurnClaim.optional(),
  usage: UsageSnapshot.optional(),

  /** The assistant's final text. The full timeline is in the journal; this is
   *  the summary a list view renders without replaying events. */
  resultText: z.string().optional(),
  failure: z.object({ code: TurnFailureCode, message: z.string() }).optional(),

  /** Provider continuity produced BY this turn, and the input to the next. */
  providerSessionId: z.string().min(1).optional(),
});
export type Turn = z.infer<typeof Turn>;

/**
 * A project's git state, as the engine last read it.
 *
 * READ-ONLY BY CONSTRUCTION. It exists so a client can say WHERE work lands —
 * the composer's foot names the project and branch the next message will act on
 * — and nothing here implies a mutation. A project that is not a repository
 * reports `repository: false` rather than failing, because `envMode: "local"`
 * supports exactly that case on purpose.
 */
export const GitWorktreeEntry = z.object({
  path: z.string(),
  basename: z.string(),
  /** Absent on a detached checkout, which is a real state and not a name. */
  branch: z.string().optional(),
  isMainCheckout: z.boolean(),
});
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntry>;

/**
 * ONE FILE, AS GIT SEES IT — which is a different witness from the journal.
 *
 * `Item`'s `file_change` says what the agent REPORTED writing, with the patch
 * its own tool produced. This says what is actually different on disk. They
 * disagree constantly and usefully: a `bun install` touches a lockfile no
 * transcript mentions, a build writes artefacts, and a file the agent edited
 * twice can end up byte-identical to where it started. The cockpit's review
 * surface exists to show exactly that disagreement.
 */
export const GitChangeStatus = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);
export type GitChangeStatus = z.infer<typeof GitChangeStatus>;

export const GitFileChange = z.object({
  path: z.string().min(1),
  status: GitChangeStatus,
  renamedFrom: z.string().min(1).optional(),
  /** Absent rather than zero for a binary file and for an untracked one — git
   *  counts neither, and a confident `+0` would be a fabrication. */
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
});
export type GitFileChange = z.infer<typeof GitFileChange>;

/** A commit the session itself made. Agents commit; a review that showed only
 *  the working tree would report a finished session as having done nothing. */
export const GitCommitEntry = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  subject: z.string(),
  /** Author date, epoch milliseconds — the same unit as every other timestamp
   *  in this contract, converted at the seam rather than by three clients. */
  at: Timestamp,
  author: z.string(),
});
export type GitCommitEntry = z.infer<typeof GitCommitEntry>;

/**
 * WHAT THIS SESSION HAS DONE TO THE REPOSITORY, committed and uncommitted
 * together, measured from where it started.
 *
 * The frozen cockpit answered two narrower questions and neither was the one a
 * reviewer asks. `git status` forgets a change the moment the agent commits it;
 * a branch comparison forgets everything still uncommitted. `base…worktree`
 * covers both, and it is the only framing under which "is this session's work
 * good" has a single answer.
 *
 * SCOPED TO THE SESSION'S OWN CHECKOUT. A worktree session has a branch and a
 * working tree of its own, so running this against the project root would
 * describe somebody else's changes — which is what the donor's pane did.
 */
export const SessionDiff = z.object({
  repository: z.boolean(),
  /** The session's own checkout: its worktree, or the project root. */
  workspacePath: z.string().min(1),
  branch: z.string().optional(),
  /**
   * Absent means the session has no recorded base and this diff is against
   * HEAD instead — so committed work is NOT included and the surface has to say
   * so. Present is the full answer.
   */
  base: z.string().min(1).optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  files: z.array(GitFileChange),
  commits: z.array(GitCommitEntry),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  /** The file list is capped. Reported so a truncated review cannot read as a
   *  complete one. */
  truncated: z.boolean(),
});
export type SessionDiff = z.infer<typeof SessionDiff>;

export const GitOverview = z.object({
  repository: z.boolean(),
  branch: z.string().optional(),
  dirtyFiles: z.number().int().nonnegative(),
  /** Both absent when the branch has no upstream — which is NOT zero/zero. */
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  worktrees: z.array(GitWorktreeEntry),
});
export type GitOverview = z.infer<typeof GitOverview>;

/**
 * WHAT IS IN A CHECKOUT — the flat list a file tree is built from.
 *
 * FLAT PATHS, NOT A TREE. A nested payload would encode one client's idea of how
 * to group and sort, and every consumer would have to walk it anyway to search.
 * A list of repo-relative paths is the smallest true thing, and the shape is
 * `a/b/c.ts` on every platform because a backslash is a legal character in a
 * POSIX filename and a client cannot tell the two apart afterwards.
 *
 * DIRECTORIES ARE IMPLIED BY THEIR CONTENTS, which means an EMPTY directory does
 * not appear. That is git's own view — it tracks files, not folders — and
 * inventing folder entries the versioning system cannot see would make the tree
 * disagree with `git status` for no gain.
 *
 * `source` IS THE HONEST BIT. In a repository this is git's index plus untracked
 * files, so `.gitignore` decides what a person sees and `node_modules` never
 * appears. In an unversioned directory — which `envMode: "local"` supports on
 * purpose — there is no ignore file to obey, so the engine walks the directory
 * with its own small deny list and says that is what it did.
 */
export const WorkspaceListingSource = z.enum(["git", "walk"]);
export type WorkspaceListingSource = z.infer<typeof WorkspaceListingSource>;

export const WorkspaceListing = z.object({
  /** The checkout these paths are relative to: a session's worktree, or a
   *  project root. Named in full because the next thing a reader does is `cd`. */
  workspacePath: z.string().min(1),
  repository: z.boolean(),
  files: z.array(z.string().min(1)),
  source: WorkspaceListingSource,
  /** The list is capped. Reported so a partial tree cannot read as a whole
   *  repository — a tree that silently stops is worse than one that says it did. */
  truncated: z.boolean(),
  readAt: Timestamp,
});
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

/**
 * ONE FILE'S TEXT, as it is on disk right now.
 *
 * NOT A PATCH. `sessionFilePatch` answers "what changed"; this answers "what
 * does this file say", which is the question a file tree raises and the diff
 * cannot answer for the majority of files that did not change.
 *
 * BINARY AND TRUNCATED ARE BOTH STATED rather than approximated. A viewer handed
 * the first half of a file with no flag would show a syntax error that is not in
 * the source, and one handed a PNG's bytes as UTF-8 would show line noise.
 */
export const WorkspaceFile = z.object({
  path: z.string().min(1),
  /** Empty for a binary file — there is no text to send, and sending mojibake
   *  would be worse than sending nothing. */
  text: z.string(),
  /** The file's real size, even when the text above was cut short. */
  bytes: z.number().int().nonnegative(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
