/**
 * engine protocol v2 — the durable entities.
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
  /**
   * WHAT THIS CHECKOUT IS ON RIGHT NOW — for the sessions that share it.
   *
   * A worktree session carries its own branch on `SessionWorkspace`; a LOCAL
   * session has none, because it runs on the project's own checkout and the
   * branch is a property of that checkout rather than of the conversation. So
   * the sidebar could say where a worktree session's work lands and not where
   * a local one's does, which is the more common case.
   *
   * DERIVED ON LIST, LIKE `Session.activity`, and for the same reason: HEAD
   * moves, and a stored answer would be wrong the first time somebody switched
   * branches. One `git rev-parse` per PROJECT rather than per session is what
   * makes it affordable.
   *
   * Absent on an unversioned directory, which `envMode: "local"` exists to
   * support — not every project is a git repository.
   */
  branch: z.string().min(1).optional(),
});
export type Project = z.infer<typeof Project>;

/** Lifecycle of the conversation itself, independent of whether a process is
 *  currently attached to it. */
export const SessionState = z.enum(["active", "archived"]);
export type SessionState = z.infer<typeof SessionState>;

/**
 * WHAT A SESSION IS DOING, ordered by what it wants from the reader.
 *
 *   blocked     a request is open and nobody has answered it — it wants YOU
 *   working     a turn is running, or a sub-agent is; it wants nothing, it is busy
 *   queued      a turn is waiting for a worker to pick it up
 *   monitoring  no turn, no agent — but a watch loop or long shell is alive
 *   idle        nothing in flight
 *
 * THE ORDER IS THE POINT and it is not the order of severity — `blocked` is not
 * worse than `working`, it is more ACTIONABLE, and a sidebar exists to answer
 * "what needs me" before "what is happening". A session that is both blocked
 * and working reports blocked.
 *
 * `monitoring` EXISTS BECAUSE A SESSION CAN BE ALIVE WITH NO TURN. `TaskKind`
 * says so in as many words — a background task "continues after the turn that
 * started it settles. This is why a session can be 'still working' with no
 * active turn" — and until it was added, every such session reported `idle`. The
 * row went quiet while the work went on, which is the one thing an inbox may not
 * do. `livenessOf` in ./tasks.ts is the fold, and the engine applies it.
 *
 * IT IS BELOW `queued` AND ABOVE `idle` on purpose: background watching is real
 * work and deserves a badge, but it is nobody's turn and it can run for hours,
 * so it must not outrank a turn that is actually about to answer you.
 */
export const SessionActivity = z.enum(["blocked", "working", "queued", "monitoring", "idle"]);
export type SessionActivity = z.infer<typeof SessionActivity>;

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
  /**
   * WHICH PROJECT THIS SESSION BELONGS TO — and OPTIONAL, which is new and is
   * the whole of what makes a project-less session expressible.
   *
   * Every ordinary session has one. The exception is the Spool's master chat:
   * `SPEC-organization-workspace` CAP-1 makes it "one project-less
   * conversation — the module's front door", and the reason is structural
   * rather than cosmetic. The master answers "where did I stop" ACROSS
   * projects, and its per-project experts are each scoped to their own — so a
   * master that carried a project would be scoped to the one thing it must not
   * be scoped to.
   *
   * ABSENT IS NOT "UNKNOWN". It is a positive statement that this session has
   * no project, and readers must treat it as one: the spool toolkit reads it as
   * "every project's items", MCP resolution reads it as "the environment's
   * global servers and no project's", and a project-scoped list simply does not
   * contain it. A reader that treats absence as an error turns the front door
   * into a bug report.
   */
  projectId: Id.optional(),
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

  /**
   * WHAT THIS SESSION IS DOING RIGHT NOW — the field that makes a list an inbox.
   *
   * A sidebar without this can only sort by recency, so every row reads the
   * same and "8h ago" is the most it can say. What a person actually scans for
   * is the opposite: which of these is asking me something, which is still
   * going, which is finished. `updatedAt` cannot answer any of the three.
   *
   * `blocked` OUTRANKS `working` DELIBERATELY. A session with a parked request
   * IS still running a turn, so both are true at once — and only one of them is
   * the reader's to act on. Sorting the union by "what does this want from me"
   * is the whole design, and it is decided here rather than in each client.
   *
   * DERIVED, NEVER STORED. It is a read over the queue and the open requests,
   * so it cannot drift from them the way a cached flag would when a worker dies
   * mid-turn.
   */
  activity: SessionActivity.default("idle"),
  /**
   * When the current activity began — for "Working 3m", not for sorting.
   *
   * Absent on `idle`, because there is no event to date: a session that is
   * doing nothing has been doing nothing since its last turn ended, which
   * `updatedAt` already says.
   */
  activityAt: Timestamp.optional(),

  /**
   * WHEN THE LAST TURN ENDED, AND WHETHER IT ENDED BADLY.
   *
   * Derived beside `activity`, off the same queue read, and here for exactly
   * one rule: A SNOOZE IS "NOT NOW", NOT "NEVER". A session may be snoozed
   * while a turn is running — that is the whole difference between snoozing and
   * settling — so the work you deferred can finish while the row is hidden, and
   * a client with no way to notice keeps it hidden until a wake time chosen
   * before the answer existed.
   *
   * `lastTurnFailed` is the second half of the same rule and is not a duplicate
   * of `activity`: a failure is not a state a session is IN, it is something
   * that happened to it, and by the time anyone reads this the session is idle
   * again. Both are absent until a turn has ended, which is not the same as
   * zero.
   */
  lastTurnEndedAt: Timestamp.optional(),
  lastTurnFailed: z.boolean().optional(),

  /**
   * THE INBOX'S OWN STATE, WHICH IS NOT THE SESSION'S LIFECYCLE.
   *
   * `state` answers "is this conversation over"; these answer "do I want to see
   * it right now". A settled session is still live and still resumable — it has
   * simply been moved off the top of the list — where an archived one is
   * finished. Conflating the two is what makes people archive things they only
   * wanted out of the way, and then go looking for them.
   *
   * MODELLED ON t3 code's thread settling. Its three-way shape is the part
   * worth copying exactly:
   *
   *   - `settledOverride` is a PIN IN EITHER DIRECTION, not a boolean. "settled"
   *     shelves a session the inactivity rule would have kept; "active" keeps
   *     one the inactivity rule would have shelved. Absent means "let the rule
   *     decide", which is a third answer neither boolean can express.
   *   - AN OVERRIDE NEVER GOES STALE SILENTLY: the engine clears it when real
   *     activity happens (a turn is queued), so a settled session that gets a
   *     new message comes back on its own rather than staying hidden while it
   *     works.
   *   - A SNOOZE IS AN OVERLAY, NOT A STATE. The session stays exactly as
   *     active as it was; it is only suppressed from the list until its wake
   *     time — and clients raise its hand early when something outranks the
   *     snooze. That rule lives on the client because it is a question about
   *     presentation, and the two stamps here are everything it needs.
   *
   * WHY THE ENGINE HOLDS THEM AT ALL, rather than a browser's local storage:
   * the same sessions are read from the desktop shell, a browser tab and
   * whatever else attaches, and an inbox that disagrees with itself per client
   * is not an inbox. `readAt` is deliberately still absent — see
   * `apps/web/lib/session-list.ts` for what unread would need.
   */
  settledOverride: z.enum(["settled", "active"]).optional(),
  /** When the override was set. Its age is what lets a client tell an old
   *  decision from a fresh one. */
  settledAt: Timestamp.optional(),
  /** Hidden from the list until this passes. */
  snoozedUntil: Timestamp.optional(),
  /** When the snooze was set — the baseline "what has happened SINCE" is
   *  measured from, which is what makes an early wake possible. */
  snoozedAt: Timestamp.optional(),

  /** Provider continuity for the NEXT runtime. Opaque; the engine owns it. */
  resumeCursor: z.string().min(1).optional(),
});
export type Session = z.infer<typeof Session>;

/** Ported verbatim from t3 code's `MIN/MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS`. */
export const MIN_AUTO_SETTLE_DAYS = 1;
export const MAX_AUTO_SETTLE_DAYS = 90;
export const DEFAULT_AUTO_SETTLE_DAYS = 3;

/**
 * HOW THE READER WANTS THEIR LIST BANDED — the POLICY half of settling.
 *
 * The per-session half (`settledOverride`, `snoozedUntil`) is a decision about
 * one conversation; this is a standing rule about all of them, and the two are
 * different kinds of thing. It is here rather than in a browser's local storage
 * for the reason stated on those fields: the same sessions are read from the
 * desktop shell and from a browser tab, and a window that differed between them
 * would put the same row in two different bands on one machine. Theme can
 * differ per window because it is about the window. This is about the work.
 *
 * `null` TURNS THE CLOCK OFF — nothing settles by neglect, only by decision.
 * Distinct from a very large number, and the reason this is nullable rather
 * than a number with a sentinel: "never" is an answer, not a duration.
 *
 * ONE FIELD, AND DELIBERATELY NOT A SETTINGS BAG. An engine document called
 * `preferences` invites everything anyone ever wants to remember; this one is
 * named for the surface it governs, and a second field belongs here only if it
 * also decides what the inbox shows.
 */
export const InboxPolicy = z.object({
  autoSettleAfterDays: z.number().int().min(MIN_AUTO_SETTLE_DAYS).max(MAX_AUTO_SETTLE_DAYS).nullable(),
});
export type InboxPolicy = z.infer<typeof InboxPolicy>;

export const DEFAULT_INBOX_POLICY: InboxPolicy = { autoSettleAfterDays: DEFAULT_AUTO_SETTLE_DAYS };

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
  /**
   * SHA-256 OF THE WHOLE FILE ON DISK, and the thing that makes editing safe.
   *
   * An editor sends it back with a write and the engine refuses if disk has moved
   * since — which it may well have, because an agent could be writing this file
   * mid-turn while somebody types in the panel. Of the WHOLE file even when
   * `truncated` is set, because a precondition computed over a prefix would
   * authorise a save that discards everything after it.
   */
  sha256: z.string().min(1),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

/**
 * WHY A WRITE WAS REFUSED. Four reasons, because a reader needs four different
 * responses: re-read and re-apply (`conflict`), nothing to save (`binary`), this
 * file is too big for the panel to hold safely (`too_large`), and this endpoint
 * replaces rather than creates (`not_found`).
 */
export const WorkspaceWriteRefusal = z.enum(["not_found", "binary", "too_large", "conflict"]);
export type WorkspaceWriteRefusal = z.infer<typeof WorkspaceWriteRefusal>;

/**
 * The answer to a write.
 *
 * A REFUSAL IS AN ANSWER, NOT AN ERROR — the same shape `commitSessionWork` uses,
 * and for the same reason: "the file changed under you" is a fact about the
 * repository that the surface must render, not an exception it should catch. The
 * current `sha256` rides along so an editor can offer to re-read without a second
 * round trip.
 */
export const WorkspaceWriteResult = z.union([
  z.object({ written: z.literal(true), file: WorkspaceFile }),
  z.object({ written: z.literal(false), refusal: WorkspaceWriteRefusal, sha256: z.string().min(1).optional() }),
]);
export type WorkspaceWriteResult = z.infer<typeof WorkspaceWriteResult>;

/**
 * What ignoring Telar's own files in a repository did.
 *
 * BOTH HALVES ARE REPORTED, because "added nothing" and "did nothing" look the
 * same to a reader and mean the opposite: a repository that already ignores every
 * rule is the success case, and reporting it as an empty result makes the control
 * look broken to anyone who presses it twice.
 *
 * THE RULES ARE THE ENGINE'S, NOT THE CALLER'S, and that is a boundary rather
 * than a convenience. A client that could name the lines to append could append
 * anything to a file inside somebody's repository — this is the only write in the
 * whole contract that touches a file the user did not name.
 */
export const GitignoreResult = z.object({
  /** Rules written just now, in the order they were appended. */
  added: z.array(z.string()),
  /** Rules an existing pattern already covered, so nothing was written for them. */
  present: z.array(z.string()),
  /** Absolute path of the file that was created or appended to. */
  path: z.string().min(1),
  /** True when there was no `.gitignore` and this call created one. Worth its own
   *  field: creating a file in a repository that had none is a bigger thing than
   *  adding two lines to one that did. */
  created: z.boolean(),
});
export type GitignoreResult = z.infer<typeof GitignoreResult>;
