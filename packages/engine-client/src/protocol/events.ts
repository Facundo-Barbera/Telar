import { PluginStatus } from "./plugins";
/**
 * engine protocol v2 — the event journal.
 *
 * ONE append-only, monotonically-numbered stream per session. Every client
 * state is a fold over it and there is no second source of truth; the entity
 * shapes in ./entities.ts are snapshots the engine derives from this same
 * stream, offered so a client does not have to replay from zero to render a
 * list.
 *
 * Cursor replay (`?since=<id>`) carries over from v1 unchanged — it is the
 * mechanism that lets a client disconnect for an hour and catch up, which is
 * the whole premise of a detached engine.
 *
 * WHY A DISCRIMINATED UNION AND NOT v1's `{ type, data: Record<string,
 * unknown> }`: narrowing on `type` in a `switch` gives the exact payload that
 * event carries. v1's shape pushed that work to every call site, which is
 * visible in `apps/web/lib/engine/journal.ts` hand-checking `typeof
 * event.data.text === "string"` before it dares use a field.
 */
import { z } from "zod";
import { BrowserProvider, BrowserTab, Effort, Id, ProviderRefs, RawProviderEvent, Timestamp, UsageSnapshot } from "./common";
import { Item, ContentStream } from "./items";
import { Project, Runtime, RuntimeState, Session, Turn, TurnFailure } from "./entities";
import { EngineRequest, RequestDecision, RequestResolver } from "./requests";
import { Task } from "./tasks";

/**
 * Envelope fields on every event.
 *
 * `id` is engine-assigned, strictly increasing per session, and is the replay
 * cursor. `at` is when the engine recorded it — NOT when the provider produced
 * it, which may differ and which only `raw` can answer.
 */
export const EventEnvelope = z.object({
  id: z.number().int().positive(),
  at: Timestamp,
  sessionId: Id,
  runId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
  raw: RawProviderEvent.optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

const envelope = EventEnvelope.shape;

/** Helper: an event is the envelope plus a literal `type` plus its payload. */
const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...envelope, type: z.literal(type), ...shape });

// ── session ────────────────────────────────────────────────────────────────
const SessionCreated = event("session.created", { session: Session });
const SessionUpdated = event("session.updated", { session: Session });
const SessionArchived = event("session.archived", {});

// ── runtime: the process, not the conversation ─────────────────────────────
const RuntimeStarted = event("runtime.started", { runtime: Runtime });
const RuntimeStateChanged = event("runtime.state.changed", {
  state: RuntimeState,
  reason: z.string().optional(),
});
/** `graceful` distinguishes "the session ended" from "the process died", which
 *  is the difference between showing nothing and showing a crash. */
const RuntimeExited = event("runtime.exited", {
  graceful: z.boolean(),
  reason: z.string().optional(),
});

// ── turn ───────────────────────────────────────────────────────────────────
const TurnAccepted = event("turn.accepted", { turn: Turn, replayed: z.boolean() });
const TurnClaimed = event("turn.claimed", { workerId: Id });
const TurnStarted = event("turn.started", {});
const TurnCompleted = event("turn.completed", {
  resultText: z.string(),
  usage: UsageSnapshot.optional(),
  providerSessionId: z.string().min(1).optional(),
});
/** The whole failure, not just its two original fields: a client that learns of
 *  a `rate_limited` turn from the event tail alone still knows when the limit
 *  lifts, and so can draw the waiting row without re-reading the snapshot. */
const TurnFailed = event("turn.failed", TurnFailure.shape);
const TurnStopped = event("turn.stopped", { reason: z.string().optional() });
/**
 * The crash-mid-call case, kept from v1: the engine cannot tell whether the
 * provider invocation actually happened. NOT auto-retried — replaying a turn
 * that already ran can duplicate side effects. A human chooses.
 */
const TurnAmbiguous = event("turn.ambiguous", { reason: z.string().optional() });
const TurnDiscarded = event("turn.discarded", {});
const TurnRequeued = event("turn.requeued", { reason: z.string().optional() });
/**
 * A message held by recovery was re-read by a human and allowed to run. The
 * hold is on the turn (`Turn.held`), so this is the moment it comes off — not
 * a state change: the turn was `queued` before and after.
 */
const TurnReleased = event("turn.released", {});
/** A human paused or resumed the SESSION — see `Session.paused`. `held` is
 *  how many queued messages the pause put on hold (or the resume let go). */
const SessionPaused = event("session.paused", { by: z.enum(["human", "session"]), held: z.number().int().nonnegative() });
const SessionResumed = event("session.resumed", { released: z.number().int().nonnegative() });
/** A queued turn was promoted into the running one (send now). */
const TurnSteering = event("turn.steering", { intoRunId: Id });
/** ...and its text reached the provider inside that run. Terminal. */
const TurnSteered = event("turn.steered", { intoRunId: Id });
/** The agent's plan changed. Carried on the turn rather than as an item update
 *  because the plan is turn-scoped and replaces itself wholesale. */
const TurnPlanUpdated = event("turn.plan.updated", { item: Item });

// ── items: the timeline ────────────────────────────────────────────────────
const ItemStarted = event("item.started", { item: Item });
const ItemUpdated = event("item.updated", { item: Item });
const ItemCompleted = event("item.completed", { item: Item });

/**
 * Streaming text against an open item.
 *
 * DELTAS ARE NOT ITEM UPDATES. An `item.updated` carries the whole item and is
 * idempotent; a delta is an append and is ORDER-DEPENDENT. Conflating them
 * means either re-sending the full text on every token or losing the ability to
 * resend an item safely. The `id` ordering in the envelope is what makes
 * appends reconstructible after a reconnect.
 */
const ContentDelta = event("content.delta", {
  itemId: Id,
  stream: ContentStream,
  text: z.string(),
});

// ── requests: the human gate ───────────────────────────────────────────────
const RequestOpened = event("request.opened", { request: EngineRequest });
const RequestResolved = event("request.resolved", {
  requestId: Id,
  decision: RequestDecision,
  resolvedBy: RequestResolver,
  reason: z.string().optional(),
});

// ── tasks: sub-agents, background work, Warp ───────────────────────────────
const TaskStarted = event("task.started", { task: Task });
const TaskProgress = event("task.progress", { task: Task, message: z.string().optional() });
const TaskCompleted = event("task.completed", { task: Task });

// ── browser ────────────────────────────────────────────────────────────────
const BrowserStateChanged = event("browser.state.changed", {
  provider: BrowserProvider,
  tabs: z.array(BrowserTab),
});
/** Whose hands were on the shared browser most recently — advisory. "human"
 *  means a person interacted with the tab; the agent's mutations defer while
 *  that is fresh and must re-observe the page before acting on it. There is
 *  no handback: the state decays on its own. Journalled so the transcript can
 *  say "You interacted with the browser" where it happened. */
const BrowserControlChanged = event("browser.control.changed", {
  controller: z.enum(["agent", "human", "idle"]),
  /** WHICH tab changed hands. Control is per tab; absent means an engine (or
   *  a transition, like scope teardown) that speaks scope-level control. */
  tabId: z.string().optional(),
  /**
   * The person's input landed WHILE THE AGENT WAS ACTING on that tab, so it
   * stopped or invalidated something — which is the only case where saying so
   * explains anything.
   *
   * Every human touch used to draw a transcript row, and most of them explain
   * nothing: scrolling a page the agent is not working in is not an event in
   * the conversation. Absent (an older shell) reads as "not known to have
   * interrupted", which renders nothing — the quiet side, deliberately.
   */
  interrupted: z.boolean().optional(),
});

// ── display: the agent showing the human something ─────────────────────────
/**
 * The agent asked the cockpit to open one workspace file for the HUMAN — a
 * guide it wrote, a plot it rendered, a PDF it fetched. Carries the path and
 * never the bytes: the file is already on disk in the session's checkout, and
 * the panel reads it through the same file routes every other surface uses.
 * Unlike a browser page, this MAY open the panel — showing you something is
 * the tool's entire purpose, so arriving quietly would be failure.
 */
const DisplayOpened = event("display.opened", {
  /** Workspace-relative, fenced by the worker before it was reported. */
  path: z.string().min(1),
  /** What the agent calls it — "Setup guide" — for the toast/row, not the tab. */
  title: z.string().optional(),
});

// ── diagnostics ────────────────────────────────────────────────────────────
const UsageUpdated = event("usage.updated", { usage: UsageSnapshot });
const McpStatusUpdated = event("mcp.status.updated", {
  server: z.string().min(1),
  status: z.enum(["connecting", "ready", "failed", "disabled"]),
  message: z.string().optional(),
});
// ── data science: the session's kernel ─────────────────────────────────────
/** The kernel process changed state. `dead` with a reason is how a crash is told. */
const KernelStateChanged = event("kernel.state.changed", {
  state: z.enum(["starting", "idle", "busy", "restarting", "dead"]),
  reason: z.string().optional(),
});
/**
 * One output from one execution, as it happens. IMAGES CARRY AN ATTACHMENT ID,
 * never bytes: the plot is already on disk beside the session by the time this
 * is written, and the journal stays a journal rather than a picture store.
 */
const NotebookCellOutput = event("notebook.cell.output", {
  execId: z.string(),
  cellId: z.string().optional(),
  /** What produced it: a notebook path, `ds_scratch`, `ds_plot`… */
  producer: z.string().optional(),
  output: z.unknown(),
});
/** A registered watch evaluated false after an execution. */
const DsWatchViolated = event("ds.watch.violated", {
  watch: z.string(),
  assert: z.string(),
  detail: z.string().optional(),
});

// ── latex: the session's compiles ──────────────────────────────────────────
const LatexCompileStarted = event("latex.compile.started", { path: z.string() });
/**
 * COUNTS AND ONE SENTENCE, never the log and never the diagnostics array: the
 * journal stays a journal. The surface reads full diagnostics through the
 * session's latex door.
 */
const LatexCompileFinished = event("latex.compile.finished", {
  path: z.string(),
  ok: z.boolean(),
  pdfPath: z.string().optional(),
  errors: z.number().int(),
  warnings: z.number().int(),
  firstError: z.string().optional(),
});

/** Recoverable. The turn continues. */
const RuntimeWarning = event("runtime.warning", { message: z.string() });
/** Not recoverable by the engine, but not necessarily fatal to the session. */
const RuntimeError = event("runtime.error", { message: z.string() });

/**
 * Every event the engine emits.
 *
 * A CLIENT MUST TOLERATE AN UNRECOGNISED `type`. This union will grow, a cached
 * client will meet an engine newer than itself, and the correct behaviour is to
 * skip the row and keep folding — never to throw and lose the stream. Use
 * `safeParseEvent` below rather than `.parse` at the client boundary.
 */
export const EngineEvent = z.discriminatedUnion("type", [
  SessionCreated,
  SessionUpdated,
  SessionArchived,
  SessionPaused,
  SessionResumed,
  RuntimeStarted,
  RuntimeStateChanged,
  RuntimeExited,
  TurnAccepted,
  TurnClaimed,
  TurnStarted,
  TurnCompleted,
  TurnFailed,
  TurnStopped,
  TurnAmbiguous,
  TurnDiscarded,
  TurnRequeued,
  TurnReleased,
  TurnSteering,
  TurnSteered,
  TurnPlanUpdated,
  ItemStarted,
  ItemUpdated,
  ItemCompleted,
  ContentDelta,
  RequestOpened,
  RequestResolved,
  TaskStarted,
  TaskProgress,
  TaskCompleted,
  BrowserStateChanged,
  BrowserControlChanged,
  DisplayOpened,
  UsageUpdated,
  McpStatusUpdated,
  KernelStateChanged,
  NotebookCellOutput,
  DsWatchViolated,
  LatexCompileStarted,
  LatexCompileFinished,
  RuntimeWarning,
  RuntimeError,
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

export type EngineEventType = EngineEvent["type"];

/**
 * Parse one event off the wire, tolerating shapes this build does not know.
 *
 * Returns `null` for an unrecognised or malformed row INSTEAD OF THROWING,
 * because the alternative — one bad row killing the stream — turns a cosmetic
 * forward-compatibility problem into a dead session. The caller decides whether
 * to count and report skips; the stream keeps moving either way.
 */
export function safeParseEvent(value: unknown): EngineEvent | null {
  const parsed = EngineEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── transport ──────────────────────────────────────────────────────────────

export const EngineDiscovery = z.object({
  version: z.literal(2),
  daemonId: Id,
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  startedAt: Timestamp,
});
export type EngineDiscovery = z.infer<typeof EngineDiscovery>;

export const EngineHealth = z.object({
  version: z.literal(2),
  daemonId: Id,
  /**
   * THE MACHINE'S OWN NAME — what another cockpit calls this one before a
   * person renames it. `daemonId` is minted fresh every start, so it can say
   * "same engine as before" but never "which Mac". Optional because an engine
   * from before this field never sends it and a client must not fail on it.
   */
  hostname: z.string().min(1).optional(),
  startedAt: Timestamp,
  worker: z.object({
    registered: z.boolean(),
    workerId: Id.optional(),
    activeWorkers: z.number().int().nonnegative().optional(),
  }),
  browser: z.object({ provider: BrowserProvider }).optional(),
  /**
   * Every registered plugin and what its startup did. ADDITIVE on every client:
   * a cockpit or a phone that predates the host decodes the keys it knows and
   * ignores this one, which is the tolerance we want while there is no mobile
   * plugin surface.
   */
  plugins: z.array(PluginStatus).optional(),
});
export type EngineHealth = z.infer<typeof EngineHealth>;

/** A page of journal rows plus the cursor to resume from. `cursor` is the
 *  highest id in `events`, repeated so a caller need not scan for it. */
export const EventPage = z.object({
  events: z.array(EngineEvent),
  cursor: z.number().int().nonnegative(),
  /** True when more rows are immediately available — a client should keep
   *  paging before it starts tailing. */
  more: z.boolean(),
});
export type EventPage = z.infer<typeof EventPage>;

export const EngineErrorCode = z.enum([
  "engine_unavailable",
  "engine_unauthorized",
  "engine_locked",
  "protocol_mismatch",
  "invalid_request",
  "not_found",
  "conflict",
  "worker_unavailable",
  "provider_unavailable",
  "driver_failed",
  /** A one-shot text generation produced no answer — the harness was missing,
   *  timed out, refused, or printed something unparseable. Distinct from
   *  `driver_failed`, which is about a SESSION's provider: nothing is broken
   *  here and nothing is lost, the completion simply did not arrive. */
  "textgen_failed",
  /**
   * A PLUGIN FAILED, and its id is on the message. A broken plugin reads as ITS
   * failure rather than as "the engine did something" — the difference between
   * a person knowing which switch to turn off and filing a bug.
   */
  "plugin_error",
  "internal_error",
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;

export const EngineErrorBody = z.object({
  error: z.object({ code: EngineErrorCode, message: z.string() }),
});
export type EngineErrorBody = z.infer<typeof EngineErrorBody>;

/**
 * What a client may choose for ONE message, as opposed to for the session.
 *
 * THERE IS NO `instanceId` HERE, and its absence is the rule rather than an
 * omission: a turn is routed by the session's `providerInstanceId`, which owns
 * the resume cursor that makes the conversation continuous. A turn that could
 * name a different instance could strand the history mid-conversation. So the
 * engine stamps the instance from the session and a client can only ever change
 * the model and the effort — the provider is not a per-turn question, and this
 * shape is what makes that true by construction instead of by validation.
 */
export const TurnModelSelection = z
  .object({
    /** Absent means "the provider's own default model", which is a real choice
     *  and not the same as naming one. Everything below still applies to it —
     *  see `ModelSelection`. */
    model: z.string().min(1).optional(),
    effort: Effort.optional(),
    fastMode: z.boolean().optional(),
  })
  .refine((value) => value.model !== undefined || value.effort !== undefined || value.fastMode !== undefined, {
    message: "a turn's model selection must name at least one of model, effort or fast mode",
  });
export type TurnModelSelection = z.infer<typeof TurnModelSelection>;

/** Submitting a turn. `runId` is the client's idempotency key — resubmitting
 *  the same one returns the original turn with `replayed: true`. */
export const TurnSubmission = z.object({
  runId: Id,
  input: z.string(),
  /** `compact` for the compaction gesture — see `Turn.kind`. The engine
   *  refuses a second one while one is queued or running. */
  kind: z.enum(["message", "compact"]).optional(),
  model: TurnModelSelection.optional(),
  /** Ids from `POST /v2/sessions/:id/attachments`. The bytes are already on
   *  disk by the time this is sent — see `TurnAttachment`. */
  attachments: z.array(Id).max(16).optional(),
});
export type TurnSubmission = z.infer<typeof TurnSubmission>;

export const TurnSubmissionResult = z.object({
  turn: Turn,
  replayed: z.boolean(),
});
export type TurnSubmissionResult = z.infer<typeof TurnSubmissionResult>;

// NO CONVENIENCE RE-EXPORT OF Project/Session/Turn/Item/Request/Task HERE.
// This module imports them to build event payloads, and re-exporting them
// would make ./index.ts's `export *` see the SAME NAME from two modules —
// which ES module semantics resolve by silently omitting it from the barrel,
// not by erroring. The names would simply vanish from `@telar/engine-client`
// with a green typecheck. They are exported from ./entities, ./items,
// ./requests and ./tasks, which is where they are defined.
