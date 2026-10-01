import { ProjectPlugins } from "../plugins/schema";
import { DataScienceConfig, LatexConfig } from "../plugins/toolchains";
import { z } from "zod";
import type { ItemDetail } from "./items";
import { parseToolName } from "./tools";
import {
  EnvMode,
  EnvironmentId,
  Id,
  InteractionMode,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RateLimitType,
  RuntimeMode,
  Timestamp,
  TurnAttachment,
  UsageSnapshot,
} from "./common";

export const ProjectAvailability = z.enum(["available", "unmounted", "missing"]);
export type ProjectAvailability = z.infer<typeof ProjectAvailability>;

export const Project = z.object({
  id: Id,
  environmentId: EnvironmentId,
  name: z.string().min(1),
  root: z.string().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  branch: z.string().min(1).optional(),
  icon: z.string().min(1).max(64).optional(),
  iconName: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  iconEmoji: z.string().min(1).max(16).optional(),
  defaultModel: ModelSelection.optional(),
  envMode: EnvMode.optional(),
  remoteUrl: z.string().min(1).optional(),
  removedAt: Timestamp.optional(),
  volume: z
    .object({
      mount: z.string().min(1),
      uuid: z.string().min(1),
    })
    .optional(),
  availability: ProjectAvailability.optional(),
  dataScience: DataScienceConfig.optional(),
  latex: LatexConfig.optional(),
  plugins: ProjectPlugins.optional(),
});
export type Project = z.infer<typeof Project>;

/** Lifecycle of the conversation itself, independent of whether a process is
 *  currently attached to it. */
export const SessionState = z.enum(["active", "archived"]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionOrigin = z.enum(["human", "session"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

const TurnOrigin = z.enum(["user", "provider", "session", "schedule", "restart"]);

export const SessionActivity = z.enum(["blocked", "working", "queued", "monitoring", "idle", "waiting", "scheduled"]);
export type SessionActivity = z.infer<typeof SessionActivity>;

export const WaitingOn = z.enum(["run", "timer", "task"]);
export type WaitingOn = z.infer<typeof WaitingOn>;

export const SessionActivityDetail = z.discriminatedUnion("kind", [
  /** `monitoring`: how much is running, and how much of it is sub-agents —
   *  the rest are shells and monitors. */
  z.object({ kind: z.literal("background"), tasks: z.number().int().min(1), agents: z.number().int().min(0) }),
  /** `waiting`: the session whose answer this one is waiting for — the one
   *  that has been going longest when there are several — and how many. */
  z.object({ kind: z.literal("session"), sessionId: Id, title: z.string().optional(), sessions: z.number().int().min(1) }),
  /** `scheduled`: the soonest wake. */
  z.object({ kind: z.literal("schedule"), at: Timestamp }),
  /** `working`, but the turn's only open call is a wait — see `waitingToolOf`. */
  z.object({ kind: z.literal("tool"), waitingOn: WaitingOn }),
]);
export type SessionActivityDetail = z.infer<typeof SessionActivityDetail>;

export function waitingToolOf(detail: ItemDetail): WaitingOn | undefined {
  if (detail.type === "command_execution") {
    return /^\s*sleep\s+\d+(\.\d+)?[smhd]?\s*;?\s*$/.test(detail.command.command) ? "timer" : undefined;
  }
  if (detail.type === "mcp_tool_call" || detail.type === "dynamic_tool_call") {
    const { tool } = parseToolName(detail.call.name);
    if (tool === "run_wait" || tool === "terminal_wait") return "run";
    if (tool === "TaskOutput" || tool === "BashOutput") {
      const input = detail.call.input as { block?: unknown } | undefined;
      return input?.block === true ? "task" : undefined;
    }
  }
  return undefined;
}

export const SessionWorkspace = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local"),
    path: z.string().min(1),
    baseRef: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("worktree"),
    path: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1).optional(),
    released: z
      .object({ at: Timestamp, reason: z.enum(["manual", "inactive", "settled", "unchanged", "archived"]) })
      .optional(),
  }),
  z.object({ mode: z.literal("none") }),
]);
export type SessionWorkspace = z.infer<typeof SessionWorkspace>;

export function workspacePath(workspace: SessionWorkspace): string | undefined {
  return workspace.mode === "none" ? undefined : workspace.path;
}

export function workspaceBaseRef(workspace: SessionWorkspace): string | undefined {
  return workspace.mode === "none" ? undefined : workspace.baseRef;
}

export const SessionPreparation = z.object({
  state: z.enum(["preparing", "failed"]),
  /** Only ever on `failed`, and only what git said. */
  error: z.string().optional(),
  at: Timestamp,
});
export type SessionPreparation = z.infer<typeof SessionPreparation>;

export const SessionSettledBy = z.object({
  kind: z.literal("delegation"),
  coordinatorSessionId: Id,
  runId: Id,
  at: Timestamp,
});
export type SessionSettledBy = z.infer<typeof SessionSettledBy>;

export const ClaudeConversation = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
  /** The first real user prompt, when the CLI extracted one. */
  firstPrompt: z.string().optional(),
  customTitle: z.string().optional(),
  lastActivityAt: Timestamp,
  createdAt: Timestamp.optional(),
  /** The working directory the conversation happened in. */
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  /** Transcript size on disk: tells a long thread from a one-line question. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ClaudeConversation = z.infer<typeof ClaudeConversation>;

export const Session = z.object({
  id: Id,
  projectId: Id.optional(),
  environmentId: EnvironmentId,
  title: z.string(),
  /** Present while the title is the engine's own: `first` from the opening message, `second` once retitled with
   *  more context. Any other title change clears it, so absent means a person or a creator chose the title. */
  autoTitle: z.enum(["first", "second"]).optional(),
  state: SessionState,
  /** Provenance, never a link — see `SessionOrigin`. Absent is "human". */
  origin: SessionOrigin.optional(),
  startedFrom: z
    .object({ sessionId: Id, runId: Id.optional() })
    .optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,

  /** Routing is by instance; the driver is descriptive. See ./common.ts. */
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: ModelSelection.optional(),

  workspace: SessionWorkspace,
  /** Absent means the workspace is ready. See `SessionPreparation`. */
  preparation: SessionPreparation.optional(),
  envMode: EnvMode,
  /** Browser-only conversation. Workspace creation is deferred until first send. */
  draft: z.object({ baseRef: z.string().optional(), branchName: z.string().optional(), branchSlug: z.string().optional() }).optional(),

  /** What this session may do without asking; changeable mid-session. */
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,

  detached: z.boolean(),

  /** Cumulative across every turn. Per-turn figures live on the turn. */
  usage: UsageSnapshot.optional(),

  activity: SessionActivity.default("idle"),
  activityAt: Timestamp.optional(),
  /** The facts behind `activity` that a label needs — see `SessionActivityDetail`. */
  activityDetail: SessionActivityDetail.optional(),

  lastTurnEndedAt: Timestamp.optional(),
  lastTurnSequence: z.number().int().positive().optional(),
  lastReadTurnSequence: z.number().int().positive().optional(),
  /** When the newest read receipt landed. Never bumps `updatedAt`: reading a
   *  session is a fact about the reader, not work the session did. */
  readAt: Timestamp.optional(),
  lastTurnFailed: z.boolean().optional(),
  lastTurnOrigin: TurnOrigin.optional(),

  settledOverride: z.enum(["settled", "active"]).optional(),
  settledAt: Timestamp.optional(),
  settledBy: SessionSettledBy.optional(),
  terminalsClosed: z
    .object({ at: Timestamp, terminals: z.number().int().positive(), reason: z.enum(["grace", "limit"]) })
    .optional(),
  unsettledAssignments: z.array(Id).max(64).optional(),
  /** Hidden from the list until this passes. */
  snoozedUntil: Timestamp.optional(),
  snoozedAt: Timestamp.optional(),
  wokeAt: Timestamp.optional(),

  resumeCursor: z.string().min(1).optional(),

  resumeAfterRateLimit: z.boolean().optional(),

  /** A human Stop rejects new agent messages/wakes until a new human message.
   * It never holds or replays an old backlog. */
  agentMessagesBlocked: z.boolean().optional(),

  agentMessagesBlockedAt: Timestamp.optional(),

  paused: z
    .object({
      at: Timestamp,
      /** Who paused it: a person, or an agent through `sessions_stop`. */
      by: z.enum(["human", "session"]),
    })
    .optional(),
});
export type Session = z.infer<typeof Session>;

export const LiveSessionRow = Session.omit({
  environmentId: true,
  origin: true,
  providerInstanceId: true,
  runtimeMode: true,
  interactionMode: true,
  detached: true,
  resumeCursor: true,
  resumeAfterRateLimit: true,
  agentMessagesBlocked: true,
  agentMessagesBlockedAt: true,
  paused: true,
  unsettledAssignments: true,
});
export type LiveSessionRow = z.infer<typeof LiveSessionRow>;

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

export const TurnState = z.enum([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "stopped",
  "ambiguous",
  "discarded",
  "steering",
  "steered",
]);
export type TurnState = z.infer<typeof TurnState>;

/** Why a turn stopped short of completing. */
export const TurnFailureCode = z.enum([
  "provider_unavailable",
  "driver_failed",
  "cancelled",
  "budget_exhausted",
  "internal_error",
  "interrupted",
  "rate_limited",
  "workspace_unavailable",
]);
export type TurnFailureCode = z.infer<typeof TurnFailureCode>;

export const STALLED_AFTER_MS = 20 * 60_000;

/** What `Turn.stalled` carries. Named so the engine and the tools that report
 *  it cannot describe the same advisory two different ways. */
export const TurnStall = z.object({
  since: Timestamp,
  noticedAt: Timestamp,
});
export type TurnStall = z.infer<typeof TurnStall>;

export const TurnFailure = z.object({
  code: TurnFailureCode,
  message: z.string(),
  resumeAt: Timestamp.optional(),
  /** `rate_limited`: which limit, so a row can say "five hour" rather than "a
   *  limit". Narrowed to the closed set — see `RateLimitType`. */
  limitType: RateLimitType.optional(),
  resumeDecidedAt: Timestamp.optional(),
});
export type TurnFailure = z.infer<typeof TurnFailure>;

export const WorkerTurnFailureCode = TurnFailureCode.exclude(["cancelled", "internal_error"]);
export type WorkerTurnFailureCode = z.infer<typeof WorkerTurnFailureCode>;

export const WorkerTurnFailure = TurnFailure.omit({ resumeDecidedAt: true }).extend({ code: WorkerTurnFailureCode });
export type WorkerTurnFailure = z.infer<typeof WorkerTurnFailure>;

/** A worker's exclusive lease on a queued turn. The token is what stops two
 *  workers running the same turn after a partition. */
export const TurnClaim = z.object({
  workerId: Id,
  token: Id,
  at: Timestamp,
  sequence: z.number().int().nonnegative().optional(),
});
export type TurnClaim = z.infer<typeof TurnClaim>;

export const WakeKind = z.enum(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]);
export type WakeKind = z.infer<typeof WakeKind>;

export const WakeReason = z.object({
  kind: WakeKind,
  /** The session that did the thing. */
  sessionId: Id,
  /** Its turn, for the three turn kinds — and for `request_opened`, the turn
   *  the request belongs to. */
  runId: Id.optional(),
  requestId: Id.optional(),
});
export type WakeReason = z.infer<typeof WakeReason>;

export const Subscription = z.object({
  id: Id,
  subscriberSessionId: Id,
  targetSessionId: Id,
  events: z.array(WakeKind).min(1),
  /** Removed after it fires once. */
  once: z.boolean().optional(),
  completionWake: z.enum(["settled_only", "always"]).optional(),
  createdAt: Timestamp,
});
export type Subscription = z.infer<typeof Subscription>;

export const CohortMember = z.object({
  sessionId: Id,
  title: z.string().max(200).optional(),
  outcome: z.enum(["result", "completed", "failed", "stopped", "settled", "archived", "deleted"]).optional(),
  /** It sent a `blocker` and has not been answered: it stays pending whatever its turns do. */
  blocked: z.boolean().optional(),
  fetch: z.object({ sessionId: Id, runId: Id }).optional(),
  /** The first line of its result or answer, clamped. */
  firstLine: z.string().max(400).optional(),
  excerpt: z.string().max(1_600).optional(),
  chars: z.number().int().nonnegative().optional(),
  spent: z.string().max(300).optional(),
  at: Timestamp.optional(),
});
export type CohortMember = z.infer<typeof CohortMember>;

export const Cohort = z.object({
  id: Id,
  subscriberSessionId: Id,
  members: z.array(CohortMember).min(1).max(20),
  completionWake: z.enum(["settled_only", "always"]).optional(),
  createdAt: Timestamp,
  /** Past this the cohort delivers what it has, naming who is still pending. */
  expiresAt: Timestamp,
  ready: z.enum(["all", "expired"]).optional(),
});
export type Cohort = z.infer<typeof Cohort>;

export type SubscribedCohort = Cohort & { alreadySubscribed?: true; movedFrom?: string[] };

export const AgentMessageIntent = z.enum(["task", "report", "result", "blocker"]);
export type AgentMessageIntent = z.infer<typeof AgentMessageIntent>;

export const NotificationKind = z.enum(["wake", "peer_message", "request"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationEntry = z.object({
  kind: NotificationKind,
  sessionId: Id.optional(),
  /** That session's run: the one holding a peer's body, or the one that ended. */
  runId: Id.optional(),
  requestId: Id.optional(),
  /** For a wake: which of the four transitions. */
  wakeKind: WakeKind.optional(),
  intent: AgentMessageIntent.optional(),
  /** One line. What a collapsed row and an outline page show. */
  summary: z.string().max(1_000),
  title: z.string().max(200).optional(),
  spent: z.string().max(300).optional(),
});
export type NotificationEntry = z.infer<typeof NotificationEntry>;

export const NotificationDetail = z.object({
  kind: NotificationKind,
  sessionId: Id.optional(),
  runId: Id.optional(),
  requestId: Id.optional(),
  wakeKind: WakeKind.optional(),
  intent: AgentMessageIntent.optional(),
  /** One line, the row's label and the outline's `input`. */
  summary: z.string().max(1_000),
  fetch: z.object({ sessionId: Id, runId: Id }),
  body: z.string().max(8_000),
  entries: z.array(NotificationEntry).max(50).optional(),
  spent: z.string().max(300).optional(),
  deliveries: z.number().int().positive().optional(),
  /** Set on a cohort's one notification (see `Cohort`). */
  cohortId: Id.optional(),
  cohortOpenedAt: Timestamp.optional(),
});
export type NotificationDetail = z.infer<typeof NotificationDetail>;

export const GitReadFailure = z.enum(["timeout", "failed"]);
export type GitReadFailure = z.infer<typeof GitReadFailure>;

export const Turn = z.object({
  runId: Id,
  sessionId: Id,
  sequence: z.number().int().nonnegative(),
  state: TurnState,

  /** What the human asked for. */
  input: z.string(),
  kind: z.enum(["message", "compact", "import"]).optional(),
  origin: TurnOrigin.optional(),
  scheduleOrigin: z.object({ scheduleId: Id, dueAt: Timestamp }).optional(),
  restartOrigin: z
    .object({
      /** Why Telar restarted. Only `update` resumes today; a crash never does. */
      reason: z.enum(["update"]),
      plannedAt: Timestamp,
      /** The turn the restart cut off, which this one continues. */
      interruptedRunId: Id,
    })
    .optional(),
  sender: z.object({ sessionId: Id.optional() }).optional(),
  agentIntent: AgentMessageIntent.optional(),
  agentDelivery: z.enum(["passive", "wake"]).optional(),
  agentSourceRunId: Id.optional(),
  corrects: Id.optional(),
  agentNotice: z.string().max(4_000).optional(),
  notification: NotificationDetail.optional(),
  assignmentScope: z.string().max(2_000).optional(),
  assignmentDetachedAt: Timestamp.optional(),
  providerReason: z
    .object({
      kind: z.enum(["task_notification", "background_task", "unknown"]),
      /** The row (`task_<tool_use_id>`) whose ending woke the model, or whose
       *  request this turn exists to decide, when known. */
      taskId: Id.optional(),
    })
    .optional(),
  /** For an `origin: "session"` turn: what happened, and where. */
  wakeReason: WakeReason.optional(),
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
  lastProgressAt: Timestamp.optional(),
  stalled: TurnStall.optional(),

  claim: TurnClaim.optional(),
  usage: UsageSnapshot.optional(),

  /** The assistant's final text. The full timeline is in the journal; this is
   *  the summary a list view renders without replaying events. */
  resultText: z.string().optional(),
  failure: TurnFailure.optional(),
  resumedAfterRateLimit: Timestamp.optional(),
  stopReason: z.enum(["user", "agent", "engine_restart", "worker_unavailable"]).optional(),

  /** Provider continuity produced BY this turn, and the input to the next. */
  providerSessionId: z.string().min(1).optional(),

  steer: z
    .object({
      intoRunId: Id,
      requestedAt: Timestamp,
      deliveredAt: Timestamp.optional(),
    })
    .optional(),

  held: z
    .object({
      at: Timestamp,
      reason: z.enum(["engine_restart", "worker_unavailable", "session_paused"]),
    })
    .optional(),

  anchor: z
    .object({
      before: z.string().min(1).optional(),
      after: z.string().min(1).optional(),
      read: GitReadFailure.optional(),
    })
    .optional(),
});
export type Turn = z.infer<typeof Turn>;

export const ProviderSkillSource = z.enum(["user", "project", "plugin", "provider"]);
export type ProviderSkillSource = z.infer<typeof ProviderSkillSource>;

export const ProviderSkill = z.object({
  name: z.string().min(1),
  /** One line about what it does. Empty when neither the front matter nor the
   *  file's first heading said, which is commoner than it should be. */
  description: z.string(),
  source: ProviderSkillSource,
});
export type ProviderSkill = z.infer<typeof ProviderSkill>;

export const ProviderSkills = z.object({
  skills: z.array(ProviderSkill),
  commands: z.array(ProviderSkill),
});
export type ProviderSkills = z.infer<typeof ProviderSkills>;


