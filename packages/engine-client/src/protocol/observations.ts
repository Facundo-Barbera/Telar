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
import { AgentMessageIntent, NotificationDetail, Turn, WakeReason } from "./entities";
import { ContentStream, ItemDetail, ItemStatus } from "./items";
import { RequestDecision, RequestDefault, RequestDetail, RequestKind, RequestResolver } from "./requests";
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

  z.object({ kind: z.literal("task.started"), task: TaskSeed }),
  z.object({ kind: z.literal("task.progress"), task: TaskSeed, message: z.string().optional() }),
  z.object({ kind: z.literal("task.completed"), task: TaskSeed }),

  z.object({ kind: z.literal("browser.state"), provider: BrowserProvider, tabs: z.array(BrowserTab) }),

  z.object({ kind: z.literal("display.opened"), path: z.string().min(1), title: z.string().optional() }),

  z.object({
    kind: z.literal("prompt.drafted"),
    promptId: Id,
    title: z.string().min(1),
    forSessionId: Id.optional(),
  }),

  z.object({ kind: z.literal("provider.session"), providerSessionId: z.string().min(1).max(512) }),

  z.object({ kind: z.literal("runtime.warning"), message: z.string().min(1).max(2000) }),
]);
export type TurnObservation = z.infer<typeof TurnObservation>;

/** A batch, because one provider message can produce several observations and
 *  a round trip per delta would dominate the cost of streaming. */
export const TurnObservationBatch = z.object({
  claimToken: Id,
  observations: z.array(TurnObservation).min(1).max(500),
});
export type TurnObservationBatch = z.infer<typeof TurnObservationBatch>;

export const WorkerClaim = z.object({
  sessionId: Id,
  projectRoot: z.string().min(1).optional(),
  projectId: Id.optional(),
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  model: ModelSelection.optional(),
  mcpServers: z.array(McpServer).optional(),
  plugins: z.array(z.string().min(1)).optional(),
  providerInstance: ProviderInstance.optional(),
  project: z.string().min(1).optional(),
  worktree: z
    .object({
      branch: z.string().min(1),
      repoRoot: z.string().min(1),
    })
    .optional(),
  /** Provider continuity from the last completed turn, if any. */
  resumeCursor: z.string().min(1).optional(),
  tasks: z.array(TaskSeed).optional(),
  orientation: z.string().min(1).optional(),
  notes: z.array(z.string().min(1)).optional(),
  turn: Turn,
});
export type WorkerClaim = z.infer<typeof WorkerClaim>;

export const ProviderTurnOpenInput = z.object({
  workerId: Id,
  input: z.string(),
  reason: z.object({ kind: z.enum(["task_notification", "background_task", "unknown"]), taskId: Id.optional() }),
});
export type ProviderTurnOpenInput = z.infer<typeof ProviderTurnOpenInput>;

export const AgentTurnInput = z.object({
  intent: AgentMessageIntent.optional(),
  runId: Id,
  input: z.string().min(1),
  attachments: z.array(Id).optional(),
  corrects: Id.optional(),
  proof: z.object({ sessionId: Id, runId: Id, claimToken: z.string().min(16) }).optional(),
});
export type AgentTurnInput = z.infer<typeof AgentTurnInput>;

export const SessionTaskReport = z.object({
  workerId: Id,
  observations: z.array(TurnObservation),
});
export type SessionTaskReport = z.infer<typeof SessionTaskReport>;

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
  steer: z
    .array(
      z.object({
        sessionId: Id,
        runId: Id,
        claimToken: Id,
        steerRunId: Id,
        text: z.string().min(1),
        attachments: z.array(TurnAttachment).optional(),
        sender: z.object({ sessionId: Id.optional() }).optional(),
        notice: z.string().optional(),
        wakeReason: WakeReason.optional(),
        notification: NotificationDetail.optional(),
      }),
    )
    .default([]),
  stopTask: z
    .array(z.object({ sessionId: Id, providerTaskId: z.string().min(1), deliveryId: Id.optional(), driver: ProviderDriverKind.optional() }))
    .default([]),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const RequestOpenInput = z.object({
  claimToken: Id,
  /** Worker-minted, unique within the turn. */
  requestId: Id,
  kind: RequestKind,
  detail: RequestDetail,
  /** The timeline row this is about, when the worker already opened one. */
  itemId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
  deadlineMs: z.number().int().positive().optional(),
  default: RequestDefault.optional(),
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
