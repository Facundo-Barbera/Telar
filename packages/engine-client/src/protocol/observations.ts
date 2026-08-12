/**
 * vNext engine protocol v2 — worker → engine observations.
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
import { Id, ProviderDriverKind, ProviderInstanceId, ProviderRefs, Timestamp, UsageSnapshot } from "./common";
import { Turn } from "./entities";
import { ContentStream, ItemDetail, ItemStatus } from "./items";

/** An item as the worker knows it, before the engine stamps ownership on it. */
export const ItemSeed = z.object({
  /** Worker-minted, unique within the turn, opaque to the engine. */
  id: Id,
  detail: ItemDetail,
  /** The collapsed one-line label. Produced by the worker because it is the
   *  only party that has seen the provider payload, then stored so three
   *  clients do not derive three different labels for one row. */
  title: z.string().optional(),
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
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  /** Provider continuity from the last completed turn, if any. */
  resumeCursor: z.string().min(1).optional(),
  turn: Turn,
});
export type WorkerClaim = z.infer<typeof WorkerClaim>;

/**
 * The heartbeat reply. `cancel` is how a stop reaches a worker: the engine
 * cannot interrupt a running provider call directly, so a stopped turn is
 * reported here and the worker aborts its own controller.
 */
export const WorkerStatus = z.object({
  workerId: Id,
  heartbeatAt: Timestamp,
  cancel: z.array(z.object({ sessionId: Id, runId: Id, claimToken: Id })),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;
