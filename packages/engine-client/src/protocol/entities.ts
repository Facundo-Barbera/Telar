import { ProjectPlugins } from "./plugins";
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

export const DataScienceManager = z.enum(["venv", "conda", "system", "telar"]);
export type DataScienceManager = z.infer<typeof DataScienceManager>;

export const DataSciencePython = z.object({
  source: z.enum(["detected", "chosen", "telar"]),
  path: z.string().min(1),
  resolvedAt: Timestamp,
  /** Which package manager writes to this environment. Derived from the
   *  path when absent (older configs). */
  manager: DataScienceManager.optional(),
  /** The environment's directory, relative like `path` when in the checkout. */
  root: z.string().min(1).optional(),
});
export type DataSciencePython = z.infer<typeof DataSciencePython>;

export const DataScienceConfig = z.object({
  enabled: z.boolean(),
  python: DataSciencePython.optional(),
  stack: z.array(z.string().min(1)).optional(),
});
export type DataScienceConfig = z.infer<typeof DataScienceConfig>;

/** One interpreter the engine found, and what it proved about it. */
export const DataSciencePreflight = z.object({
  ok: z.boolean(),
  path: z.string(),
  version: z.string().optional(),
  versionInfo: z.tuple([z.number(), z.number()]).optional(),
  sitePackages: z.array(z.string()).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  /** The project's declared dependencies: distribution name → installed version, null when absent. */
  dists: z.record(z.string(), z.string().nullable()).optional(),
  reason: z.string().optional(),
});
export type DataSciencePreflight = z.infer<typeof DataSciencePreflight>;

export const DataScienceEnvironment = z.object({
  id: z.string().min(1),
  manager: DataScienceManager,
  name: z.string(),
  root: z.string(),
  python: z.string(),
  path: z.string(),
  location: z.enum(["project", "user", "telar"]),
  reason: z.string(),
  preflight: DataSciencePreflight,
});
export type DataScienceEnvironment = z.infer<typeof DataScienceEnvironment>;

export const DataScienceTool = z.object({ path: z.string(), version: z.string() });
export const DataSciencePythonVersion = z.object({
  version: z.string(),
  minor: z.string(),
  path: z.string().optional(),
  installed: z.boolean(),
  prerelease: z.boolean(),
});
export type DataSciencePythonVersion = z.infer<typeof DataSciencePythonVersion>;

/** The tools environments are made with, and the Pythons uv can see or fetch. */
export const DataScienceToolchain = z.object({
  uv: DataScienceTool.optional(),
  conda: DataScienceTool.extend({ flavour: z.enum(["conda", "mamba", "micromamba"]) }).optional(),
  brew: DataScienceTool.optional(),
  pythons: z.array(DataSciencePythonVersion),
});
export type DataScienceToolchain = z.infer<typeof DataScienceToolchain>;

export const DataScienceRequirementsSource = z.enum(["requirements.txt", "pyproject.toml", "uv.lock", "environment.yml", "Pipfile"]);
export type DataScienceRequirementsSource = z.infer<typeof DataScienceRequirementsSource>;

/** `GET /v2/projects/:id/data-science/environments`. */
export const DataScienceEnvironments = z.object({
  toolchain: DataScienceToolchain,
  environments: z.array(DataScienceEnvironment),
  /** Dependency manifests the checkout carries. */
  requirements: z.array(DataScienceRequirementsSource),
  /** What the project declares (canonical distribution names); each environment's preflight `dists` answers for these. */
  declared: z.array(z.string()).optional(),
  currentId: z.string().optional(),
});
export type DataScienceEnvironments = z.infer<typeof DataScienceEnvironments>;

/** A toolchain job — an install, a build — read by cursor. */
export const DataScienceJob = z.object({
  jobId: z.string(),
  kind: z.string(),
  status: z.enum(["running", "ok", "failed", "cancelled"]),
  lines: z.array(z.string()),
  cursor: z.number().int().min(0),
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
});
export type DataScienceJob = z.infer<typeof DataScienceJob>;

/** `direct` is set only when the project declares dependencies: true for a declared one, false for what came along with them. */
export const DataSciencePackage = z.object({ name: z.string(), version: z.string(), channel: z.string().optional(), direct: z.boolean().optional() });
export type DataSciencePackage = z.infer<typeof DataSciencePackage>;

/** Which command package installs run, so the page can say so up front. */
export const DataScienceInstallCommand = z.enum(["uv add", "uv pip", "conda", "pip"]);
export type DataScienceInstallCommand = z.infer<typeof DataScienceInstallCommand>;

export const DataScienceCreateEnvironment = z.discriminatedUnion("manager", [
  z.object({ manager: z.literal("venv"), location: z.enum(["project", "telar"]), python: z.string().min(1), stack: z.boolean().optional() }),
  z.object({ manager: z.literal("conda"), name: z.string().min(1), python: z.string().min(1), stack: z.boolean().optional() }),
]);
export type DataScienceCreateEnvironment = z.infer<typeof DataScienceCreateEnvironment>;

export const DataScienceBootstrap = z.discriminatedUnion("what", [
  z.object({ what: z.literal("uv") }),
  z.object({ what: z.literal("python"), version: z.string().min(1) }),
  z.object({ what: z.literal("conda") }),
]);
export type DataScienceBootstrap = z.infer<typeof DataScienceBootstrap>;

/** What a finished create-environment job carries in `result`. */
export const DataScienceCreatedEnvironment = z.object({
  path: z.string(),
  root: z.string(),
  manager: DataScienceManager,
  source: z.enum(["detected", "chosen", "telar"]),
});
export type DataScienceCreatedEnvironment = z.infer<typeof DataScienceCreatedEnvironment>;

export const LatexToolchainKind = z.enum(["tectonic", "texlive", "managed"]);
export type LatexToolchainKind = z.infer<typeof LatexToolchainKind>;

/** Telar's own Tectonic, as the settings pane sees it. See `latex/managed.ts`. */
export const ManagedTectonic = z.object({
  version: z.string(),
  /** False on a platform Telar has no release table entry for. */
  supported: z.boolean(),
  installed: z.boolean(),
  path: z.string().optional(),
  installing: z.boolean(),
  error: z.string().optional(),
});
export type ManagedTectonic = z.infer<typeof ManagedTectonic>;

/** What latexmk drives. Tectonic ignores it — it is XeTeX inside. */
export const LatexEngine = z.enum(["pdflatex", "lualatex", "xelatex"]);
export type LatexEngine = z.infer<typeof LatexEngine>;

export const LatexToolchainChoice = z.object({
  kind: LatexToolchainKind,
  path: z.string().min(1).optional(),
  engine: LatexEngine.optional(),
});
export type LatexToolchainChoice = z.infer<typeof LatexToolchainChoice>;

export const LatexConfig = z.object({
  enabled: z.boolean(),
  toolchain: LatexToolchainChoice.optional(),
  mainFile: z.string().min(1).optional(),
});
export type LatexConfig = z.infer<typeof LatexConfig>;

export const LatexTool = z.object({ path: z.string(), version: z.string() });
export type LatexTool = z.infer<typeof LatexTool>;

/** One TeX Live root the engine found, and which programs it actually holds. */
export const LatexTexliveDistribution = z.object({
  binDir: z.string(),
  flavour: z.enum(["mactex", "tinytex", "texlive"]),
  year: z.string().optional(),
  latexmk: LatexTool.optional(),
  pdflatex: LatexTool.optional(),
  lualatex: LatexTool.optional(),
  xelatex: LatexTool.optional(),
  tlmgr: LatexTool.optional(),
  kpsewhich: LatexTool.optional(),
});
export type LatexTexliveDistribution = z.infer<typeof LatexTexliveDistribution>;

export const LatexToolchain = z.object({
  tectonic: LatexTool.optional(),
  texlive: z.array(LatexTexliveDistribution),
  brew: LatexTool.optional(),
  /** Telar's own Tectonic — present even when not yet fetched, so a pane has
   *  something to offer rather than an absence to explain. */
  managed: ManagedTectonic.optional(),
});
export type LatexToolchain = z.infer<typeof LatexToolchain>;

/** `GET /v2/projects/:id/latex/distributions`. */
export const LatexDistributions = z.object({
  toolchain: LatexToolchain,
  /** `.tex` files carrying `\documentclass`, candidates for `mainFile`. */
  mainCandidates: z.array(z.string()),
  /** The configured choice, echoed so the UI can mark the current card. */
  current: LatexToolchainChoice.optional(),
});
export type LatexDistributions = z.infer<typeof LatexDistributions>;

export const LatexBootstrap = z.discriminatedUnion("what", [
  z.object({ what: z.literal("tectonic") }),
  z.object({ what: z.literal("tinytex") }),
]);
export type LatexBootstrap = z.infer<typeof LatexBootstrap>;

/** One thing the log parser understood, phrased for a person or an agent. */
export const LatexDiagnostic = z.object({
  severity: z.enum(["error", "warning"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  message: z.string(),
  code: z
    .enum([
      "missing-package",
      "missing-file",
      "undefined-control-sequence",
      "undefined-reference",
      "citation-undefined",
      "overfull",
      "other",
    ])
    .optional(),
  detail: z.string().optional(),
  suggestion: z.string().optional(),
});
export type LatexDiagnostic = z.infer<typeof LatexDiagnostic>;

/** The last compile a session ran, kept whole for the surface and the tools. */
export const LatexCompileStatus = z.object({
  status: z.enum(["running", "ok", "failed", "cancelled"]),
  path: z.string(),
  pdfPath: z.string().optional(),
  diagnostics: z.array(LatexDiagnostic),
  logTail: z.array(z.string()),
  jobId: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
});
export type LatexCompileStatus = z.infer<typeof LatexCompileStatus>;

export const LatexPackagesAnswer = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic"), note: z.string() }),
  z.object({
    mode: z.literal("managed"),
    packages: z.array(
      z.object({ name: z.string(), revision: z.string().optional(), description: z.string().optional() }),
    ),
  }),
  z.object({ mode: z.literal("unavailable"), reason: z.string() }),
]);
export type LatexPackagesAnswer = z.infer<typeof LatexPackagesAnswer>;

/** Same wire shape as a data-science job — one JobRunner, one job format. */
export const LatexJob = DataScienceJob;
export type LatexJob = z.infer<typeof LatexJob>;

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
      .object({ at: Timestamp, reason: z.enum(["manual", "inactive", "unchanged", "archived"]) })
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
  /** Transcript size on disk. The rough measure of how much conversation there
   *  is, and the one that tells a long thread from a one-line question. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ClaudeConversation = z.infer<typeof ClaudeConversation>;

export const Session = z.object({
  id: Id,
  projectId: Id.optional(),
  environmentId: EnvironmentId,
  title: z.string(),
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

  /** What this session may do without asking. Set at creation, changeable
   *  mid-session — a human can hand a running session more rope, or take it. */
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

export const ComputerUsePermission = z.enum(["granted", "denied", "unauthenticated", "host-not-running", "unknown"]);
export type ComputerUsePermission = z.infer<typeof ComputerUsePermission>;

export const ComputerUseBackend = z.enum(["cua"]);
export type ComputerUseBackend = z.infer<typeof ComputerUseBackend>;

export const COMPUTER_USE_DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

/** Whether Telar supplies this provider's desktop. See `COMPUTER_USE_DRIVERS`. */
export function driverTakesComputerUse(driver: ProviderDriverKind): boolean {
  return COMPUTER_USE_DRIVERS.includes(driver);
}

/** The System Settings → Privacy & Security lists a grant is finished in. */
export const ComputerUsePane = z.enum(["accessibility", "screen-recording"]);
export type ComputerUsePane = z.infer<typeof ComputerUsePane>;

export const ComputerUseStatus = z.object({
  installed: z.boolean(),
  hostRunning: z.boolean(),
  /** True when the helper bundled inside Telar.app is what's in use — its
   *  grants are its own, and only then can the pane remove them. */
  bundled: z.boolean().optional(),
  /** Absent when not installed. */
  backend: ComputerUseBackend.optional(),
  /** Absent when not installed: there is nothing to measure. */
  permission: ComputerUsePermission.optional(),
  message: z.string().optional(),
  missing: z.array(ComputerUsePane).optional(),
});
export type ComputerUseStatus = z.infer<typeof ComputerUseStatus>;

export const ComputerUseGrant = z.object({
  started: z.boolean(),
  backend: ComputerUseBackend.optional(),
  daemon: z.boolean().optional(),
  prompted: z.boolean().optional(),
  permission: ComputerUsePermission.optional(),
  opened: ComputerUsePane.optional(),
  message: z.string().optional(),
});
export type ComputerUseGrant = z.infer<typeof ComputerUseGrant>;

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
  origin: z.enum(["user", "provider", "session", "schedule", "restart"]).optional(),
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

export const GitWorktreeEntry = z.object({
  path: z.string(),
  basename: z.string(),
  /** Absent on a detached checkout, which is a real state and not a name. */
  branch: z.string().optional(),
  isMainCheckout: z.boolean(),
});
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntry>;

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

export const GitPushRefusal = z.enum([
  /** The session's checkout is not a git repository. */
  "not_repository",
  "local_checkout",
  /** The checkout has no `origin`. Nothing to push to — and plenty of
   *  repositories are like this on purpose. */
  "no_remote",
  "not_session_branch",
  "nothing_to_push",
  /** The remote refused: this account cannot write to that repository. */
  "not_permitted",
  /** Non-fast-forward. Somebody else pushed to this branch, and the fix is a
   *  pull or a rebase — never a force, which this engine does not offer. */
  "rejected",
  "auth",
  "timeout",
  /** Anything else. `message` is git's own words, never invented. */
  "failed",
]);
export type GitPushRefusal = z.infer<typeof GitPushRefusal>;

export const GitPushResult = z.union([
  z.object({
    pushed: z.literal(true),
    branch: z.string().min(1),
    commits: z.number().int().nonnegative().optional(),
    /** This branch had never been on the remote before. */
    created: z.boolean().optional(),
  }),
  z.object({ pushed: z.literal(false), refusal: GitPushRefusal, message: z.string().min(1).optional() }),
]);
export type GitPushResult = z.infer<typeof GitPushResult>;

export const SessionDiff = z.object({
  repository: z.boolean(),
  /** The session's own checkout: its worktree, or the project root. */
  workspacePath: z.string().min(1),
  branch: z.string().optional(),
  base: z.string().min(1).optional(),
  baseUnverified: GitReadFailure.optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  files: z.array(GitFileChange),
  filesIncomplete: GitReadFailure.optional(),
  commits: z.array(GitCommitEntry),
  commitsIncomplete: GitReadFailure.optional(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  /** The file list is capped. Reported so a truncated review cannot read as a
   *  complete one. */
  truncated: z.boolean(),
  shared: z.boolean().optional(),
  availability: ProjectAvailability.optional(),
});
export type SessionDiff = z.infer<typeof SessionDiff>;

export const GitPatchIncomplete = z.enum(["timeout", "failed", "truncated"]);
export type GitPatchIncomplete = z.infer<typeof GitPatchIncomplete>;

export const GitFilePatch = z.object({
  patch: z.string(),
  binary: z.boolean(),
  incomplete: GitPatchIncomplete.optional(),
});
export type GitFilePatch = z.infer<typeof GitFilePatch>;

export const GitRefEntry = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  /** The checkout's current branch, so a picker can mark it. Local only. */
  head: z.boolean().optional(),
});
export type GitRefEntry = z.infer<typeof GitRefEntry>;

export const GitOverview = z.object({
  repository: z.boolean(),
  branch: z.string().optional(),
  dirtyFiles: z.number().int().nonnegative().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  /** Absent when `git worktree list` did not answer; `[]` only when there
   *  genuinely are none. */
  worktrees: z.array(GitWorktreeEntry).optional(),
  refs: z.array(GitRefEntry).optional(),
  refsIncomplete: GitReadFailure.optional(),
  defaultBase: z.string().min(1).optional(),
  availability: ProjectAvailability.optional(),
});
export type GitOverview = z.infer<typeof GitOverview>;

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
  availability: ProjectAvailability.optional(),
});
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

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

export const WorkspaceFile = z.object({
  path: z.string().min(1),
  /** Empty for a binary file — there is no text to send, and sending mojibake
   *  would be worse than sending nothing. */
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export const WorkspaceWriteRefusal = z.enum(["not_found", "binary", "too_large", "conflict"]);
export type WorkspaceWriteRefusal = z.infer<typeof WorkspaceWriteRefusal>;

export const WorkspaceWriteResult = z.union([
  z.object({ written: z.literal(true), file: WorkspaceFile }),
  z.object({ written: z.literal(false), refusal: WorkspaceWriteRefusal, sha256: z.string().min(1).optional() }),
]);
export type WorkspaceWriteResult = z.infer<typeof WorkspaceWriteResult>;

export const GitignoreResult = z.object({
  added: z.array(z.string()),
  present: z.array(z.string()),
  path: z.string().min(1),
  created: z.boolean(),
});
export type GitignoreResult = z.infer<typeof GitignoreResult>;

export const GitignoreRemoval = z.object({
  /** Rules taken back out, in the order they appeared in the file. */
  removed: z.array(z.string()),
  path: z.string().min(1),
});
export type GitignoreRemoval = z.infer<typeof GitignoreRemoval>;
