/**
 * engine protocol v2 — worker → engine observations.
 *
 * THE INVARIANT THIS SHAPE PROTECTS: a worker is an EXECUTOR ONLY. It never
 * writes state and never assigns an event id; it reports what it saw and the
 * engine decides what that means for the durable journal. That rule predates v2
 * (`apps/engine/src/worker.ts` states it) and is what keeps crash recovery
 * coherent — the engine holds one lock, one clock, and one monotonic sequence,
 * so a worker that dies mid-turn cannot leave a half-written journal behind.
 *
 * So observations are deliberately NOT `EngineEvent`s. They carry no `id`, no
 * `at`, no `sessionId` and no `runId`: the engine stamps all four. A worker that
 * could mint an event id could also mint a conflicting one.
 *
 * The item ids a worker DOES mint are its own business — they only have to be
 * unique within the turn, and the engine treats them as opaque. Keying them off
 * the provider's `tool_use_id` is what lets a `tool_result` arriving several
 * messages later close the row its call opened.
 */
import { z } from "zod";
import {
  BrowserProvider,
  BrowserTab,
  Id,
  McpServer,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceId,
  ProviderRefs,
  Timestamp,
  TurnAttachment,
  UsageSnapshot,
} from "./common";
import { AgentMessageIntent, Turn, WakeReason } from "./entities";
import { ContentStream, ItemDetail, ItemStatus } from "./items";
import { RequestDecision, RequestDetail, RequestKind, RequestResolver } from "./requests";
import { TaskSeed } from "./tasks";

/** An item as the worker knows it, before the engine stamps ownership on it. */
export const ItemSeed = z.object({
  /** Worker-minted, unique within the turn, opaque to the engine. */
  id: Id,
  detail: ItemDetail,
  /** The collapsed one-line label. Produced by the worker because it is the
   *  only party that has seen the provider payload, then stored so three
   *  clients do not derive three different labels for one row. */
  title: z.string().optional(),
  /**
   * The sub-agent this row belongs to, when it was not produced by the main
   * loop.
   *
   * THE WORKER SETS THIS, NOT THE ENGINE, because the worker is the only party
   * that sees the provider's parent linkage — Claude's `parent_tool_use_id`,
   * Codex's child thread id. Without it a fan-out's tool calls arrive
   * interleaved with the parent's and nothing can tell them apart, which is the
   * state stage 4 shipped in and this closes.
   */
  taskId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
});
export type ItemSeed = z.infer<typeof ItemSeed>;

export const TurnObservation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item.started"), item: ItemSeed }),
  z.object({ kind: z.literal("item.updated"), item: ItemSeed }),
  z.object({
    kind: z.literal("item.completed"),
    itemId: Id,
    status: ItemStatus,
    /** Present when finishing changes the payload — a tool_result filling in
     *  the output half of a call that opened with only its input. */
    detail: ItemDetail.optional(),
  }),
  z.object({
    kind: z.literal("content.delta"),
    itemId: Id,
    stream: ContentStream,
    /** Non-empty, but a single space or newline is legitimate — v1 learned
     *  this the hard way and split its prompt check from its stream check. */
    text: z.string().min(1),
  }),
  z.object({ kind: z.literal("usage"), usage: UsageSnapshot }),

  /**
   * Sub-agents and background work.
   *
   * THE WHOLE SEED RIDES EVERY ONE OF THE THREE, not just `task.started`, and
   * ./tasks.ts explains why: a client that had to join a late progress row back
   * to its start row could not do so once the start row aged out of retention,
   * and the agent silently vanished from the roster. The engine folds each seed
   * over the stored task, so a progress observation that repeats what it already
   * knew is a no-op rather than a conflict.
   */
  z.object({ kind: z.literal("task.started"), task: TaskSeed }),
  z.object({ kind: z.literal("task.progress"), task: TaskSeed, message: z.string().optional() }),
  z.object({ kind: z.literal("task.completed"), task: TaskSeed }),

  /**
   * What the session's browser is looking at now.
   *
   * REPORTED BY THE WORKER RATHER THAN READ BY THE ENGINE, even though the
   * daemon owns a browser of its own. There are two worker deployments and the
   * out-of-process one has its OWN `BrowserRuntime` that the daemon cannot
   * reach — so the only party that can see a given session's tabs is whoever
   * drove them. The engine journals what it is told, as with every other
   * observation.
   */
  z.object({ kind: z.literal("browser.state"), provider: BrowserProvider, tabs: z.array(BrowserTab) }),

  /**
   * The agent asked the cockpit to SHOW the human one workspace file — the
   * `display_open` tool. The path was fenced inside the turn's checkout by the
   * worker before it was reported; the engine journals it as `display.opened`
   * and the panel does the opening. No bytes travel here, ever: the file is
   * on disk and the cockpit reads it through the file routes.
   */
  z.object({ kind: z.literal("display.opened"), path: z.string().min(1), title: z.string().optional() }),

  /**
   * The provider's own session id, THE MOMENT THE DRIVER LEARNS IT.
   *
   * It used to travel only in the driver's RESULT, which `completeTurn` alone
   * persisted — so a turn that was STOPPED left the session with no resume
   * cursor and the next turn started a fresh provider session, all context
   * silently gone. Both drivers know the id within milliseconds of starting
   * (Claude's first message carries `session_id`; Codex's `thread/start`
   * answers with the thread id), so it is reported as an observation and the
   * engine persists it while the turn is still running. `completeTurn`'s
   * write remains the authoritative end-of-turn value.
   */
  z.object({ kind: z.literal("provider.session"), providerSessionId: z.string().min(1).max(512) }),
]);
export type TurnObservation = z.infer<typeof TurnObservation>;

/** A batch, because one provider message can produce several observations and
 *  a round trip per delta would dominate the cost of streaming. */
export const TurnObservationBatch = z.object({
  claimToken: Id,
  observations: z.array(TurnObservation).min(1).max(500),
});
export type TurnObservationBatch = z.infer<typeof TurnObservationBatch>;

/**
 * What a worker receives when it claims work.
 *
 * `projectRoot` and `resumeCursor` are RESOLVED BY THE ENGINE and handed over,
 * rather than looked up by the worker. The worker holds no store handle at all,
 * which is what stops it reading a session's state and acting on a stale view
 * of it between claim and execution.
 */
export const WorkerClaim = z.object({
  sessionId: Id,
  projectRoot: z.string().min(1),
  /**
   * The session's project, for the browser's PER-PROJECT profile: the worker
   * binds the session's browser scope to this before the turn's first tool
   * runs, so cookies of one project never appear in another. Absent for a
   * projectless session (the worker then binds the explicit `none` profile);
   * an older engine sends nothing here and the worker does the same.
   */
  projectId: Id.optional(),
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  /**
   * Which model runs this turn, resolved by the engine from the session at
   * CLAIM TIME.
   *
   * Carried on the claim for the same reason `projectRoot` and `resumeCursor`
   * are: the worker holds no store handle, so anything it needs to execute must
   * arrive with the work. Absent means the session named none and the driver
   * uses its provider's own default — which is not the same as an invented one.
   */
  model: ModelSelection.optional(),
  /**
   * The user's MCP servers, resolved and filtered to the enabled ones.
   *
   * Carried for the same reason `model` is — the worker holds no store handle —
   * and filtered HERE rather than in the worker so "disabled" means one thing.
   * A worker that received the disabled ones and was trusted to skip them would
   * be a second place the rule lives.
   */
  mcpServers: z.array(McpServer).optional(),
  /**
   * THE PROJECT OPTED INTO DATA SCIENCE, resolved at claim time like the
   * rest: present means the `notebook_*` and `ds_*` toolkits register for this
   * turn, absent means they do not exist. A worktree session whose configured
   * interpreter is not in ITS tree gets nothing here — no fallback to the
   * project root, so a worktree stays the isolated thing it was cut to be.
   */
  dataScience: z.object({ pythonPath: z.string().min(1) }).optional(),
  /**
   * THE PROJECT OPTED INTO LATEX, resolved at claim time like `dataScience`
   * above: present means the `latex_*` toolkit registers for this turn. The
   * kind rides along so tool descriptions can be honest about how packages
   * behave (tectonic fetches automatically; TeX Live wants tlmgr).
   */
  latex: z.object({ kind: z.enum(["tectonic", "texlive"]) }).optional(),
  /**
   * EVERY OTHER PLUGIN THE PROJECT TURNED ON, as ids. The two fields above are
   * the two features that predate the host; this is the one that does not grow
   * when a third arrives.
   *
   * IDS ONLY. A plugin's settings are its own business and stay in the daemon
   * behind its capability — the worker needs to know only WHICH walls to build,
   * and every call one of those walls makes comes back over
   * `EngineClient.plugin()`. Absent means no plugin walls, which is also what an
   * older worker does anyway.
   */
  plugins: z.array(z.string().min(1)).optional(),
  /**
   * The configured login this session runs as, RESOLVED — sensitive environment
   * values included, unlike every other read of the registry.
   *
   * They are here because the worker is the process that spawns the provider,
   * and the alternative is worse in both directions: a worker that looked the
   * instance up would need a store handle (the one thing this claim exists to
   * avoid), and a worker that received the redacted shape would launch the
   * provider without the credential the user configured and fail confusingly.
   * The claim already travels the same loopback socket with the same bearer
   * token as the MCP server specs beside it, which carry their own secrets.
   */
  providerInstance: ProviderInstance.optional(),
  /**
   * The project's NAME, as opposed to its id or its root.
   *
   * IT IS HERE FOR THE SAME REASON `projectRoot` AND `model` ARE — the worker
   * holds no store handle, so anything it needs to execute arrives with the
   * work. What needs it is the spool toolkit: a spool item's `project` is a
   * free-form LABEL, not an id, so scoping a session to its own slice means
   * comparing names, and the worker has no registry to look one up in.
   *
   * ABSENT MEANS UNSCOPED, which is the project-less master's case — it sees
   * every project's items, because having no project is the whole point of it.
   * An older engine that sends nothing therefore degrades to the master's view
   * rather than to an empty one, and the toolkit says which scope it resolved.
   */
  project: z.string().min(1).optional(),
  /** Provider continuity from the last completed turn, if any. */
  resumeCursor: z.string().min(1).optional(),
  /**
   * The session's task rows that are NOT settled, as the engine has them.
   *
   * A provider process remembers the tasks it launched; one built cold (after
   * a restart, an eviction, a config change) does not, and the first report a
   * still-running task sends it would open a second row for a task the store
   * already holds. Carried for the same reason `resumeCursor` is: continuity
   * the worker cannot look up itself. Only live rows — a settled one has
   * nothing left to report on.
   */
  tasks: z.array(TaskSeed).optional(),
  turn: Turn,
});
export type WorkerClaim = z.infer<typeof WorkerClaim>;

/**
 * What a worker sends to open a turn the PROVIDER started.
 *
 * The CLI process outlives its turns, and between them it can run a whole
 * model turn of its own — a background shell or monitor fired, the CLI woke
 * the model on the notification, and the model spoke and called tools. Before
 * this existed those frames sat buffered until the next human message, were
 * then read as a stranger's, and their tool calls were refused against a
 * settled claim. This opens a REAL turn for them: it is `running` from birth
 * (the process is already talking), carries a claim like any other so its
 * requests, observations and completion ride the same routes, and it is
 * closed by the same `completeTurn`.
 */
export const ProviderTurnOpenInput = z.object({
  workerId: Id,
  /** The provider's own notification text — what the model was woken with. */
  input: z.string(),
  reason: z.object({ kind: z.enum(["task_notification", "unknown"]), taskId: Id.optional() }),
});
export type ProviderTurnOpenInput = z.infer<typeof ProviderTurnOpenInput>;

/**
 * A message ONE AGENT SENDS ANOTHER SESSION — the `sessions_send` wire shape.
 *
 * `proof` is the SENDING turn's claim (session, run, token): the engine checks
 * it is live and stamps `Turn.sender` from it. It is the worker's to supply,
 * never a model's — the tool wall has no such argument. Absent proof (the
 * outward sessions socket, whose caller is the user's own chat client) still
 * yields an `origin: "session"` turn, with no session to attribute it to.
 */
export const AgentTurnInput = z.object({
  intent: AgentMessageIntent.optional(),
  runId: Id,
  input: z.string().min(1),
  attachments: z.array(Id).optional(),
  proof: z.object({ sessionId: Id, runId: Id, claimToken: z.string().min(16) }).optional(),
});
export type AgentTurnInput = z.infer<typeof AgentTurnInput>;

/**
 * Task reports that arrive BETWEEN turns — the level signal, a notification
 * for a shell that fired, a Ctrl+B — carried without a claim, because there is
 * no turn to claim. Worker-authenticated like a heartbeat; the store folds
 * them onto the rows they name and never opens a turn for them.
 */
export const SessionTaskReport = z.object({
  workerId: Id,
  observations: z.array(TurnObservation),
});
export type SessionTaskReport = z.infer<typeof SessionTaskReport>;

/**
 * The heartbeat reply.
 *
 * IT IS THE ONLY CHANNEL FROM ENGINE TO WORKER, and both fields exist because
 * the engine cannot reach into a running provider call:
 *   - `cancel` carries a stop. The worker aborts its own controller.
 *   - `resolved` carries an answered approval. A worker blocked inside
 *     `canUseTool` is waiting for exactly this.
 * Polling rather than pushing keeps the worker a plain HTTP client with no
 * inbound socket, which is what lets it be restarted independently.
 */
export const WorkerStatus = z.object({
  workerId: Id,
  heartbeatAt: Timestamp,
  cancel: z.array(z.object({ sessionId: Id, runId: Id, claimToken: Id })),
  resolved: z.array(
    z.object({
      requestId: Id,
      sessionId: Id,
      runId: Id,
      decision: RequestDecision,
      reason: z.string().optional(),
      answers: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  /**
   * Send-now deliveries: a queued turn promoted into the RUNNING turn this
   * worker holds. `runId`/`claimToken` name the running turn; `steerRunId` is
   * the promoted turn, which the worker acks once the text is in the driver's
   * mailbox. `.default([])` so a worker built against this schema parses an
   * OLDER engine's heartbeat — the same forward courtesy the claim's optional
   * fields extend.
   */
  steer: z
    .array(
      z.object({
        sessionId: Id,
        runId: Id,
        claimToken: Id,
        steerRunId: Id,
        text: z.string().min(1),
        /**
         * The files the human attached to the steered message. The engine wrote
         * them and owns the paths, exactly as for a queued turn's attachments;
         * this channel used to carry text alone, so an image sent mid-turn was
         * stored and never delivered — measured on the dogfood app.
         */
        attachments: z.array(TurnAttachment).optional(),
        /** Present when an AGENT sent this (`sessions_send`), so the driver
         *  can deliver it as a peer's report rather than as the person. */
        sender: z.object({ sessionId: Id.optional() }).optional(),
        /**
         * The engine's short announcement of that message — what the PROVIDER
         * is handed instead of `text`, which stays the body so the transcript
         * row can still expand to it. See `Turn.agentNotice`.
         *
         * IT TRAVELS FOR THE SAME REASON `sender` DOES: this seam is where a
         * queued turn becomes a mid-turn delivery, and a notice left behind
         * here would mean a peer's whole report reaches the model whenever the
         * recipient happened to be busy — the one case where it costs most.
         */
        notice: z.string().optional(),
        /**
         * Present when this is a WAKE the engine queued and then promoted into
         * the running turn — a session this one subscribed to did something.
         *
         * IT TRAVELS BECAUSE IDENTITY DIES AT THIS SEAM OTHERWISE. A wake that
         * arrives while the recipient is IDLE runs as its own `origin:
         * "session"` turn and the cockpit draws it as a wake row; the same wake
         * arriving while the recipient is RUNNING was steered as bare text, so
         * the provider read the engine's announcement as the person's
         * instruction and the transcript drew it as the person's bubble. The
         * only difference was whether a turn happened to be in flight.
         */
        wakeReason: WakeReason.optional(),
      }),
    )
    .default([]),
  /**
   * STOP ONE LINGERING BACKGROUND TASK. Unlike `cancel`, this names no turn:
   * the task outlives its turn (that is what background means), so the worker
   * reaches into the session's live provider process and stops the task by its
   * provider id. Drain-on-read — the engine has already marked the projection
   * `stopped`, so a delivery that never lands only leaves a zombie the
   * process's own death will reap. `.default([])` for the same forward
   * courtesy the other channels extend to an older worker.
   */
  stopTask: z
    .array(z.object({ sessionId: Id, providerTaskId: z.string().min(1), deliveryId: Id.optional(), driver: ProviderDriverKind.optional() }))
    .default([]),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;

/**
 * A worker asking the engine whether a tool call may proceed.
 *
 * THE WORKER DOES NOT DECIDE, and does not even know the session's runtime
 * mode. It describes what the provider wants to do; the engine applies
 * `autoResolution` and either answers immediately or parks the request and
 * tells the worker to wait. Putting the policy anywhere else would mean two
 * parties could disagree about whether a session is allowed to do something.
 */
export const RequestOpenInput = z.object({
  claimToken: Id,
  /** Worker-minted, unique within the turn. */
  requestId: Id,
  kind: RequestKind,
  detail: RequestDetail,
  /** The timeline row this is about, when the worker already opened one. */
  itemId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
});
export type RequestOpenInput = z.infer<typeof RequestOpenInput>;

/** The engine's answer. `state: "open"` means park and watch the heartbeat. */
export const RequestOpenResult = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("resolved"),
    requestId: Id,
    decision: RequestDecision,
    resolvedBy: RequestResolver,
  }),
  z.object({ state: z.literal("open"), requestId: Id, notified: z.boolean() }),
]);
export type RequestOpenResult = z.infer<typeof RequestOpenResult>;
