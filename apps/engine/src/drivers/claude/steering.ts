import type { createEmitter } from "./emitter";
import { type SteerMessage, steerRowTitle } from "../../domains/turns";
import { itemId } from "./mapping";
import { withToolResult } from "./observations";
import { type TurnState, type Rest } from "./turn";

export type SteerCtx = {
  turn: TurnState;
  emit: ReturnType<typeof createEmitter>["emit"];
};

export const onSteered = (ctx: SteerCtx, message: SteerMessage) => {
  const id = itemId();
  const attachments = message.attachments ?? [];
  ctx.emit({
    kind: "item.started",
    item: {
      id,
      detail: message.notification
        ? { type: "notification", notification: message.notification }
        : {
            type: "user_message",
            text: message.text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(message.sender ? { sender: message.sender } : {}),
            // The row keeps the BODY in `text` and the engine's notice beside
            // it, so the transcript can collapse to the one line the model
            // was handed and still expand to everything the peer sent.
            ...(message.notice ? { notice: message.notice } : {}),
            // WHO SAID IT SURVIVES THE ROW. A wake steered into a running
            // turn used to land here bare and draw as the person's bubble.
            ...(message.wakeReason ? { wakeReason: message.wakeReason } : {}),
          },
      title: steerRowTitle(message),
    },
  });
  ctx.emit({ kind: "item.completed", itemId: id, status: "completed" });
};

export const consumeSteerCut = (ctx: SteerCtx): boolean => {
  const [first] = ctx.turn.outstandingSteerCuts;
  if (first === undefined) return false;
  ctx.turn.outstandingSteerCuts.delete(first);
  return true;
};

export const closeCutTools = (ctx: SteerCtx): void => {
  for (const useId of ctx.turn.openTopLevelTools) {
    ctx.turn.openTopLevelTools.delete(useId);
    const open = ctx.turn.openTools.get(useId);
    if (!open) continue;
    ctx.turn.openTools.delete(useId);
    ctx.emit({ kind: "item.completed", itemId: open.id, status: "failed", detail: withToolResult(open.detail, "cut by a steer") });
  }
};

export function bindSteering(ctx: SteerCtx) {
  return {
    onSteered: (...args: Rest<typeof onSteered>) => onSteered(ctx, ...args),
    consumeSteerCut: (...args: Rest<typeof consumeSteerCut>) => consumeSteerCut(ctx, ...args),
    closeCutTools: (...args: Rest<typeof closeCutTools>) => closeCutTools(ctx, ...args),
  };
}
