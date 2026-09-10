import type { TelarToolSocket } from "./telar-socket";
// Provider-neutral execution boundary. Adapters report observations; only the engine writes state.
import type { McpServer, TaskSeed, TurnAttachment, RequestDecision, RequestDetail, RequestKind, TurnObservation, UsageSnapshot } from "@telar/engine-client";
import type { SpoolCapability } from "./spool/tools";
import type { SessionsCapability } from "./sessions-tools/tools";
import type { DsCapability } from "./ds/capability";
import type { DisplayCapability } from "./display/tools";
import type { RunCapability } from "./run/capability";
import type { LatexCapability } from "./latex/capability";
import type { SteerMailbox } from "./steering";

export type { SpoolCapability, SessionsCapability, DsCapability, DisplayCapability, LatexCapability };

/** What the provider wants to do, in the contract's vocabulary. */
export type DriverRequest = {
  kind: RequestKind;
  detail: RequestDetail;
  /** The provider's own tool-use id, so the row and the request correlate. */
  toolUseId: string;
};

/**
 * The engine's answer — and, for a `user_input` request, what the human
 * actually typed. A bare `RequestDecision` remains a legal answer (it is what
 * every test and every approval-shaped caller returns); `normalizeOutcome`
 * is how a consumer that cares about answers reads both shapes.
 */
export type DriverRequestOutcome = { decision: RequestDecision; answers?: Record<string, unknown> };

export function normalizeOutcome(value: RequestDecision | DriverRequestOutcome): DriverRequestOutcome {
  return typeof value === "string" ? { decision: value } : value;
}

export type DriverRun = {
  runId?: string;
  prompt: string;
  /**
   * WHICH SESSION THIS TURN BELONGS TO — the key the Claude driver holds its
   * live runtime under (see ./claude-runtime.ts). Without it every turn is an
   * island and nothing a turn leaves running can survive the turn's end,
   * which was precisely the bug: one SDK query per turn meant one CLI process
   * per turn, and backgrounded shells, monitors and sub-agents all died with
   * their parent at every turn boundary.
   */
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /**
   * SEND NOW: text a human pushed into this running turn. The worker fills
   * it from the heartbeat; how a driver injects it is the driver's own
   * affair — Claude yields it at the next turn boundary of its streaming
   * prompt, Codex sends `turn/steer` the moment it lands. Absent means the
   * deployment (or test) has no send-now channel, and the driver behaves
   * exactly as before it existed.
   */
  steer?: SteerMailbox;
  /**
   * The session's door to the user's item store.
   *
   * PER-RUN, NOT PER-DRIVER, unlike `browser`. A browser is a machine resource
   * the deployment owns and every session borrows; the spool arrives already
   * SCOPED to the project this turn belongs to, and that scope is a fact about
   * the turn. Capturing one at construction would give every session the first
   * session's slice.
   *
   * ABSENT MEANS NO SPOOL TOOLS, which is what a test gets and what an older
   * worker produces — not an empty spool. The difference matters: a model told
   * "no items" would report that as the truth.
   */
  spool?: SpoolCapability;
  /**
   * The session's door to OTHER sessions — create, send, read, status, stop,
   * diff.
   *
   * PER-RUN, like the spool and for a related reason: it is assembled out of
   * the worker's own client, so a deployment with no client has no toolkit
   * rather than a broken one.
   *
   * ABSENT MEANS NO SESSIONS TOOLS, which is what a test gets and what an older
   * worker produces — never an empty engine. A model told "no sessions exist"
   * would report that as the truth.
   *
   * IT CARRIES NO IDENTITY. There is nothing on this capability that says which
   * session is holding it, because nothing downstream records one: a session
   * created through here is a PEER, not a child, and the absence of a link is
   * the design rather than a gap in it.
   */
  sessions?: SessionsCapability;
  /**
   * The session's kernel, notebooks and analysis tools — present only when
   * the project opted in (the claim carried `dataScience`). Per-run like the
   * spool: assembled from the worker's client, scoped to this session.
   * ABSENT MEANS THE TOOLKITS DO NOT EXIST, never an empty kernel.
   */
  ds?: DsCapability;
  /**
   * The session's TeX compiles and packages — present only when the project
   * opted in (the claim carried `latex`). Same rules as `ds` above.
   * ABSENT MEANS THE TOOLKIT DOES NOT EXIST, never an empty toolchain.
   */
  latex?: LatexCapability;
  /**
   * THE PROJECT'S RUNS. A core capability, not a plugin: the daemon owns the
   * process group so a dev server outlives the conversation that started it.
   */
  run?: RunCapability;
  /**
   * The session's door to the human's SCREEN — `display_open`, the tool that
   * shows one workspace file in the cockpit's right panel. Per-run like the
   * spool: the worker assembles it around this turn's checkout, so the fence
   * is the turn's own. ABSENT MEANS THE TOOL DOES NOT EXIST, which is what a
   * test gets and what an older worker produces.
   */
  display?: DisplayCapability;
  /**
   * Which model to run, resolved by the engine from the session.
   *
   * ABSENT MEANS "the provider's own default", and that is a distinct state
   * from any string this code could invent. A driver that substituted a name
   * here would silently override whatever the installed harness is configured
   * to use, and the session would report a model it is not running.
   */
  model?: string;
  /** Reasoning effort, where the provider has the concept. Same absent rule. */
  effort?: string;
  /** Latency over quality, where the provider offers it. Claude-only. */
  fastMode?: boolean;
  /**
   * Files the human attached to THIS message, already on disk.
   *
   * The engine wrote them and owns the paths; a driver reads them and decides
   * how its provider wants them. That split is deliberate — a driver that
   * accepted bytes would have to be trusted with where they came from.
   */
  attachments?: TurnAttachment[];
  /** The user's own MCP servers, already filtered to the enabled ones by the
   *  engine. Telar's in-process servers are added by the driver on top. */
  mcpServers?: McpServer[];
  /**
   * WHICH LOGIN THIS TURN RUNS AS, expressed as an environment patch over the
   * worker's own — the config dir, whatever the instance declares, and (for a
   * configured instance) `undefined` for each ambient variable that would
   * otherwise silently replace its identity.
   *
   * A PATCH RATHER THAN A WHOLE ENVIRONMENT because the child still needs PATH
   * and HOME like any other process, and a driver handed a complete environment
   * would be the one deciding which of the worker's variables survive.
   */
  env?: Record<string, string | undefined>;
  /**
   * The binary THIS LOGIN runs, when it pinned one — an absolute path, or a
   * bare name to look up the way a terminal would.
   *
   * SEPARATE FROM `env` because it is not one: it decides which executable is
   * spawned, not what that executable inherits. Absent means the driver's own
   * default name, which is what every login had before this existed.
   */
  binaryPath?: string;
  /**
   * WHICH CONFIGURED LOGIN this turn runs as, by id.
   *
   * The driver does not spend it — `env` and `binaryPath` are what actually
   * shape the child process. It is here because a WARP agent's task row carries
   * a `ModelSelection`, and the contract defines that as "which login, and which
   * model on it": a row that named a model without naming whose account ran it
   * would be unattributable. Absent means no selection is recorded, which is
   * what every task did before warps existed.
   */
  providerInstanceId?: string;
  /**
   * Telar's browser, as an HTTP MCP server the WORKER hosts — see
   * `browser/socket.ts`. PER-RUN because the token is: it binds this turn's
   * scope, gate and observation sink, and dies with the turn. The driver only
   * registers the endpoint with its provider; scoping and approval are already
   * bound behind it.
   */
  browserSocket?: { url: string; token: string };
  /**
   * The `sessions_*` wall as an HTTP MCP server the WORKER hosts — see
   * `sessions-tools/run-socket.ts`. FOR PROVIDERS THAT TAKE SERVERS AS CONFIG
   * (Codex): the Claude driver ignores it and keeps its in-process
   * registration under `telar`, because renaming a shipped tool would split
   * its identity. The token is per-session — the bound capability closes over
   * `self`, so a subscription made through it wakes the right session.
   */
  sessionsSocket?: { url: string; token: string };
  /**
   * THE `telar` WALL'S HOST, for the provider whose driver holds per-turn
   * bindings. The DRIVER binds it, because the capabilities it serves are that
   * turn's bindings and the worker cannot reach them.
   */
  telarSocket?: TelarToolSocket;
  /**
   * THE SAME WALL, ALREADY LEASED — the shape a provider that cannot hold
   * in-process state consumes. Codex and OpenCode take MCP servers as config
   * and hold no per-turn capability bindings, so for them the WORKER binds the
   * wall against its own per-session client capabilities and passes the lease
   * down. Same key, same tool names, same approvals.
   */
  telarSocketLease?: { url: string; token: string; generation: string };
  /** Engine-owned provider continuity from the preceding completed turn. */
  providerSessionId?: string;
  /**
   * THE SESSION'S TASK ROWS AS THE ENGINE HAS THEM, for a runtime that has to
   * be built cold. A live runtime remembers every task its process launched
   * (`TaskMemory`); a runtime rebuilt after a restart or an eviction knows
   * nothing, and the first `task_notification` a still-running shell sends it
   * would mint a ghost row for a task the store already has. Carried on the
   * claim like `resumeCursor`, and for the same reason: the worker holds no
   * store handle. Absent (an older engine, a test) means an empty memory.
   */
  tasks?: TaskSeed[];
  /**
   * THE SESSION'S DOOR FOR WHAT HAPPENS BETWEEN TURNS. The Claude process
   * outlives the turn and keeps talking after it: a monitor reports, a shell
   * ends, and — the important case — the CLI wakes the model on that ending
   * and runs a whole turn of its own. With this present the driver keeps
   * reading the stream after `run()` returns, files task frames through
   * `onTasks`, and opens a real turn through `onProviderTurn` for the
   * CLI's own — with a gate and an observation sink of that turn's own, so
   * its tool calls are decided rather than refused against a settled claim.
   * Absent (an older worker, a test) means the stream is read only while a
   * turn pumps it, exactly as before.
   */
  session?: DriverSessionHooks;
  /** Batched back to the engine. Never called after the run settles. */
  onObservations(observations: TurnObservation[]): Promise<void>;
  /**
   * Ask whether a tool call may proceed. Resolves with the engine's answer,
   * which may take an arbitrarily long time — a parked approval waits for a
   * human. ABSENT means the driver runs with no gate at all, which is the
   * `full-access` shape and is what the tests use.
   */
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
};

export type DriverResult = {
  text: string;
  providerSessionId?: string;
  usage?: UsageSnapshot;
};

/**
 * What a turn the PROVIDER started needs from the engine: the same three
 * things a human turn's claim carries. Returned by `onProviderTurn.open`,
 * handed back whole at `close`.
 */
export type ProviderTurnBinding = {
  runId: string;
  onObservations(observations: TurnObservation[]): Promise<void>;
  onRequest?(request: DriverRequest): Promise<RequestDecision | DriverRequestOutcome>;
  /** Settle the turn. `text` is the model's final prose; a failure ends it failed. */
  close(result: DriverResult | { failure: string }): Promise<void>;
};

export type DriverSessionHooks = {
  /** Task frames read between turns — the level signal, a notification, a Ctrl+B. */
  onTasks(observations: TurnObservation[]): Promise<void>;
  /**
   * The CLI began a turn of its own. Resolves with the binding the driver
   * pumps that turn through, or `undefined` if the engine refused (a human
   * turn claimed the session first — the frames are then that turn's).
   */
  onProviderTurn(input: { input: string; reason: { kind: "task_notification" | "unknown"; taskId?: string } }): Promise<ProviderTurnBinding | undefined>;
};

export type TurnDriver = {
  run(input: DriverRun): Promise<DriverResult>;
  /**
   * Close every live provider process this driver holds. OPTIONAL because
   * only the Claude driver keeps any (its session runtimes); the worker calls
   * it on stop so a shutdown does not orphan a CLI per open session.
   */
  dispose?(): void;
  /**
   * Stop ONE lingering background task inside a session's live process, by its
   * provider task id — the id the task's `task.started` carried as
   * `providerTaskId`. OPTIONAL for the same reason as `dispose`: only the
   * Claude driver holds a live process a task can linger inside. Resolves
   * `true` when a live runtime took the request, `false` when there is none
   * (the process is already gone, so the task is too).
   */
  stopTask?(sessionId: string, providerTaskId: string): Promise<boolean>;
};

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

