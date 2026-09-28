import type { createEmitter } from "./emitter";
import { type UsageSnapshot, type ProviderWaitDetail, type ItemDetail } from "@telar/engine-client";
import { itemId } from "./mapping";
import { titleForProviderWait } from "./limits";
import { type TurnState, type Rest } from "./turn";

export type WaitCtx = {
  turn: TurnState;
  emit: ReturnType<typeof createEmitter>["emit"];
  flush: ReturnType<typeof createEmitter>["flush"];
  providerSilenceMs: number;
};

/** The newest main-loop assistant envelope's raw `usage`, kept so the
 *  response's closing `message_delta` can correct its placeholder
 *  output count rather than replace the whole record. */

export const decorateUsage = (ctx: WaitCtx, snapshot: UsageSnapshot | undefined): UsageSnapshot | undefined =>
  snapshot === undefined
    ? undefined
    : {
        ...snapshot,
        ...(ctx.turn.contextUsed === undefined ? {} : { contextUsed: ctx.turn.contextUsed }),
        ...(ctx.turn.contextMax === undefined ? {} : { contextMax: ctx.turn.contextMax }),
      };

/** The open "Retrying…" / "Rate limit reached" row, while the provider
 *  has the turn standing still. Closed by the next frame of any kind. */

/** The last rate-limit WARNING this turn journalled, so the CLI's
 *  per-request repeat of it is dropped (#897). Turn-scoped like every
 *  binding here, which is what "reset at turn start" amounts to. */

export const closeProviderWait = (ctx: WaitCtx): void => {
  if (!ctx.turn.waitItemId) return;
  ctx.emit({ kind: "item.completed", itemId: ctx.turn.waitItemId, status: "completed" });
  ctx.turn.waitItemId = undefined;
};

export const disarmProviderSilence = (ctx: WaitCtx): void => {
  if (ctx.turn.silenceTimer === undefined) return;
  clearTimeout(ctx.turn.silenceTimer);
  ctx.turn.silenceTimer = undefined;
};

export const armProviderSilence = (ctx: WaitCtx): void => {
  disarmProviderSilence(ctx);
  const sentAt = Date.now();
  ctx.turn.silenceTimer = setTimeout(() => {
    ctx.turn.silenceTimer = undefined;
    if (ctx.turn.waitItemId || ctx.turn.compactionItemId) return;
    const id = itemId();
    // The timer firing IS the proof the threshold passed; `Date.now()`
    // truncates to whole ms and can read one short of it.
    const wait: ProviderWaitDetail = { kind: "no_response", waitedMs: Math.max(ctx.providerSilenceMs, Date.now() - sentAt) };
    const detail: ItemDetail = { type: "provider_wait", wait };
    ctx.emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(wait) } });
    ctx.turn.waitItemId = id;
    void ctx.flush().catch(() => undefined);
  }, ctx.providerSilenceMs);
  ctx.turn.silenceTimer.unref?.();
};

export function bindProviderWait(ctx: WaitCtx) {
  return {
    decorateUsage: (...args: Rest<typeof decorateUsage>) => decorateUsage(ctx, ...args),
    closeProviderWait: (...args: Rest<typeof closeProviderWait>) => closeProviderWait(ctx, ...args),
    disarmProviderSilence: (...args: Rest<typeof disarmProviderSilence>) => disarmProviderSilence(ctx, ...args),
    armProviderSilence: (...args: Rest<typeof armProviderSilence>) => armProviderSilence(ctx, ...args),
  };
}
