import type { TelarToolSocket } from "./telar-socket";
// Provider-neutral execution boundary. Adapters report observations; only the engine writes state.
import type { McpServer, TaskSeed, TurnAttachment, RequestDecision, RequestDetail, RequestKind, TurnObservation, UsageSnapshot } from "@telar/engine-client";
import type { SessionsCapability } from "./sessions-tools/tools";
import type { NotesCapability } from "./notes-tools/tools";
import type { DsCapability } from "./ds/capability";
import type { DisplayCapability } from "./display/tools";
import type { RunCapability } from "./run/capability";
import type { LatexCapability } from "./latex/capability";
import type { SteerMailbox } from "./steering";

export type { SessionsCapability, NotesCapability, DsCapability, DisplayCapability, LatexCapability };

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
   * A PERSON TYPED THIS PROMPT — no sending agent, no engine wake.
   *
   * The provider has one input channel and everything rides it: a human's
   * words, a peer's notice, the engine's own wake. `framedTurnInput` already
   * says which in PROSE, for the model to read; this is the same fact as a
   * FLAG, for the provider's own provenance channel. The Claude CLI has one
   * (`origin`) and honours exactly one value on it — see
   * `docs/investigations/delivery-as-harness-input-2026-09-11.md` §1 — so
   * without this a real person fails the SDK's own `isHuman` gate.
   *
   * ABSENT MEANS "THE DRIVER CLAIMS NOTHING", which is what a test and an older
   * worker produce. Never defaulted to true: a wake stamped as a human decision
   * is the one mistake this whole seam exists to prevent.
   */
  promptFromHuman?: boolean;
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
   * The session's door to OTHER sessions — create, send, read, status, stop,
   * diff.
   *
   * PER-RUN, NOT PER-DRIVER, unlike `browser` — the rule every capability below
   * follows. A browser is a machine resource the deployment owns and every
   * session borrows; this one is assembled out of the worker's own client, so a
   * deployment with no client has no toolkit rather than a broken one, and
   * capturing one at construction would give every session the first session's.
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
   * The session's door to the PROJECT'S NOTEBOOK — the quick notes the person
   * keeps beside the code, which the composer's foot also draws.
   *
   * PER-RUN and SCOPED, like `sessions` and for the same reason: it carries
   * `self.projectId`, so `notes_list()` with no argument means "this project"
   * and an agent asked "what does the deploy note say?" has somewhere to look.
   *
   * ABSENT MEANS NO NOTES TOOLS — a project-less session, an older worker, a
   * test. Never an empty notebook: a model told "there are no notes" would
   * report that as the truth.
   */
  notes?: NotesCapability;
  /**
   * The session's kernel, notebooks and analysis tools — present only when
   * the project opted in (the claim carried `dataScience`). Per-run like
   * `sessions`: assembled from the worker's client, scoped to this session.
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
   * Every enabled plugin's capability, by id — the arm that does not grow when
   * a feature is added. Its walls join the `telar` socket beside the core ones,
   * under the same key, so a plugin tool has one qualified name everywhere.
   */
  plugins?: Record<string, unknown>;
  /**
   * The session's door to the human's SCREEN — `display_open`, the tool that
   * shows one workspace file in the cockpit's right panel. Per-run like
   * `sessions`: the worker assembles it around this turn's checkout, so the
   * fence is the turn's own. ABSENT MEANS THE TOOL DOES NOT EXIST, which is what a
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
   * WHAT THIS AGENT IS TOLD ABOUT WHERE IT IS — the orientation paragraph,
   * already resolved by the engine (see `orientation.ts` and
   * `AgentOrientation`). Injected once per turn through the SAME seam each
   * driver uses for `BROWSER_BRIEFING` / `RUN_BRIEFING`.
   *
   * THE TEXT, NOT A FLAG, and it arrives on the claim: the words and the
   * decision to use them are both the engine's, and a driver handed a boolean
   * would be a second place either lives. ABSENT MEANS INJECT NOTHING — the
   * person turned it off, or the worker is older than this field, or it is a
   * test. Never a default paragraph invented here.
   *
   * A WARP CHILD DOES NOT GET ONE: it is spawned outside this contract with a
   * prompt that already states what it is and what it may do. Orienting it a
   * second time would be a paragraph about a cockpit it is not sitting in.
   */
  orientation?: string;
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

