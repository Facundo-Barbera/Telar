import { PluginStatus } from "../plugins/schema";
import { z } from "zod";
import { BrowserProvider, BrowserTab, Effort, Id, ProviderRefs, RawProviderEvent, Timestamp, UsageSnapshot } from "./common";
import { Item, ContentStream } from "./items";
import { Runtime, RuntimeState, Session, SessionSettledBy, Turn, TurnFailure } from "./entities";
import { EngineRequest, RequestDecision, RequestResolver } from "./requests";
import { Task } from "./tasks";

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
const SessionSettled = event("session.settled", { settledBy: SessionSettledBy });
const SessionWoke = event("session.woke", { wokeAt: Timestamp });

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
const TurnAmbiguous = event("turn.ambiguous", { reason: z.string().optional() });
const TurnDiscarded = event("turn.discarded", {});
const TurnRequeued = event("turn.requeued", { reason: z.string().optional() });
const TurnReleased = event("turn.released", {});
const SessionPaused = event("session.paused", { by: z.enum(["human", "session"]), held: z.number().int().nonnegative() });
const SessionResumed = event("session.resumed", { released: z.number().int().nonnegative() });
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

// ── tasks: sub-agents and background work ──────────────────────────────────
const TaskStarted = event("task.started", { task: Task });
const TaskProgress = event("task.progress", { task: Task, message: z.string().optional() });
const TaskCompleted = event("task.completed", { task: Task });

// ── browser ────────────────────────────────────────────────────────────────
const BrowserStateChanged = event("browser.state.changed", {
  provider: BrowserProvider,
  tabs: z.array(BrowserTab),
});
const BrowserControlChanged = event("browser.control.changed", {
  controller: z.enum(["agent", "human", "idle"]),
  tabId: z.string().optional(),
  interrupted: z.boolean().optional(),
});

const DisplayOpened = event("display.opened", {
  path: z.string().min(1),
  /** What the agent calls it — "Setup guide" — for the toast/row, not the tab. */
  title: z.string().optional(),
});

const PromptDrafted = event("prompt.drafted", {
  promptId: Id,
  title: z.string().min(1),
  /** Present when it belongs to one conversation — the handoff case. */
  forSessionId: Id.optional(),
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

export const EngineEvent = z.discriminatedUnion("type", [
  SessionCreated,
  SessionUpdated,
  SessionArchived,
  SessionSettled,
  SessionWoke,
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
  PromptDrafted,
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

export const EventLoopStall = z.object({
  at: Timestamp,
  lagMs: z.number().int().nonnegative(),
  operation: z.string(),
});
export type EventLoopStall = z.infer<typeof EventLoopStall>;

export const EventLoopHealth = z.object({
  thresholdMs: z.number().int().positive(),
  maxLagMs: z.number().int().nonnegative(),
  stalls: z.array(EventLoopStall),
});
export type EventLoopHealth = z.infer<typeof EventLoopHealth>;

export const EngineHealth = z.object({
  version: z.literal(2),
  daemonId: Id,
  hostname: z.string().min(1).optional(),
  startedAt: Timestamp,
  worker: z.object({
    registered: z.boolean(),
    workerId: Id.optional(),
    activeWorkers: z.number().int().nonnegative().optional(),
  }),
  browser: z.object({ provider: BrowserProvider }).optional(),
  plugins: z.array(PluginStatus).optional(),
  git: z.object({ liveChildren: z.number().int().nonnegative(), cap: z.number().int().positive() }).optional(),
  eventLoop: EventLoopHealth.optional(),
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
  next: z.number().int().nonnegative().optional(),
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
  "textgen_failed",
  "plugin_error",
  "internal_error",
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;

export const EngineErrorBody = z.object({
  error: z.object({ code: EngineErrorCode, message: z.string() }),
});
export type EngineErrorBody = z.infer<typeof EngineErrorBody>;

export const TurnModelSelection = z
  .object({
    /** Absent means "the provider's own default model", which is a real choice
     *  and not the same as naming one. Everything below still applies to it —
     *  see `ModelSelection`. */
    model: z.string().min(1).optional(),
    effort: Effort.optional(),
    fastMode: z.boolean().optional(),
    serviceTier: z.string().min(1).optional(),
    ultracode: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.model !== undefined || value.effort !== undefined || value.fastMode !== undefined || value.serviceTier !== undefined || value.ultracode !== undefined,
    { message: "a turn's model selection must name at least one of model, effort, fast mode, service tier or ultracode" },
  );
export type TurnModelSelection = z.infer<typeof TurnModelSelection>;

/** Submitting a turn. `runId` is the client's idempotency key — resubmitting
 *  the same one returns the original turn with `replayed: true`. */
export const TurnSubmission = z.object({
  runId: Id,
  /** May be empty when an image rides along — see `turnHasContent`. */
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

export function turnHasContent(text: string, mediaTypes: readonly string[]): boolean {
  return text.trim() !== "" || mediaTypes.some((type) => type.startsWith("image/"));
}

/**
 * The placeholder title a first message seeds, before a generated one lands.
 * An image-only message names its picture rather than leaving the title blank.
 */
export function seedSessionTitle(text: string, imageNames: readonly string[] = []): string {
  const words = text.replace(/\s+/g, " ").trim().slice(0, 80).trim();
  if (words) return words;
  if (imageNames.length === 1) return imageNames[0]!.slice(0, 80);
  return imageNames.length > 1 ? `${imageNames.length} images` : "";
}

export const TurnSubmissionResult = z.object({
  turn: Turn,
  replayed: z.boolean(),
});
export type TurnSubmissionResult = z.infer<typeof TurnSubmissionResult>;

