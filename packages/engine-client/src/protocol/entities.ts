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
  z.object({ mode: z.literal("local"), path: z.string().min(1) }),
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
