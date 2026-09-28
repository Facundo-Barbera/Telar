// ── the CLI's own word on whether the turn is over ────────────
import { str, itemId, asRecord } from "./mapping";
import type { SdkFrame } from "./frames";
import type { LoopCtx } from "./loop-ctx";
import type { ItemDetail } from "@telar/engine-client";

export async function onSessionState(ctx: LoopCtx, item: SdkFrame): Promise<"continue" | "break" | undefined> {
  if (item.type === "system" && item.subtype === "session_state_changed") {
      ctx.turn.runtime.reportsSessionState = true;
      if (str(item.state) === "idle" && ctx.turn.foreignTurn === undefined && ctx.turn.outstandingSteerCuts.size === 0 && (ctx.turn.ownResultRead || (ctx.turn.ownTurnOpen && !ctx.turn.steerSent))) {
        ctx.turn.completed = true;
        await ctx.flush();
        if (ctx.turn.persistent) return "break";
      }
      return "continue";
    }
  return undefined;
}

export async function onCompactBoundary(ctx: LoopCtx, item: SdkFrame): Promise<"continue" | undefined> {
  if (item.type === "system" && item.subtype === "compact_boundary") {
      const metadata = asRecord(item.compact_metadata);
      const detail: ItemDetail = {
        type: "context_compaction",
        ...(str(metadata.trigger) ? { reason: str(metadata.trigger)! } : {}),
        ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
        ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {}),
      };
      if (ctx.turn.compactionItemId) {
        ctx.emit({ kind: "item.updated", item: { id: ctx.turn.compactionItemId, detail, title: "Compacting context" } });
        ctx.turn.compactionMeasured = true;
        if (ctx.turn.compactionSucceeded) {
          ctx.emit({ kind: "item.completed", itemId: ctx.turn.compactionItemId, status: "completed", detail });
          ctx.turn.compactionItemId = undefined;
        }
      } else {
        const id = itemId();
        ctx.emit({ kind: "item.started", item: { id, detail, title: "Compacted context" } });
        ctx.emit({ kind: "item.completed", itemId: id, status: "completed", detail });
      }
      await ctx.flush();
      return "continue";
    }
  return undefined;
}

// ── compaction, announced then bounded ────────────────────────
export async function onStatusFrame(ctx: LoopCtx, item: SdkFrame): Promise<"continue" | undefined> {
  if (item.type === "system" && item.subtype === "status") {
      if (str(item.status) === "requesting") ctx.armProviderSilence();
      if (str(item.status) === "compacting" && !ctx.turn.compactionItemId) {
        // The silence watch belongs to a request; a compaction is not one.
        ctx.disarmProviderSilence();
        ctx.turn.compactionItemId = itemId();
        ctx.turn.compactionSucceeded = false;
        ctx.turn.compactionMeasured = false;
        ctx.emit({
          kind: "item.started",
          item: { id: ctx.turn.compactionItemId, detail: { type: "context_compaction" }, title: "Compacting context" },
        });
        await ctx.flush();
      } else if (item.compact_result !== undefined && ctx.turn.compactionItemId) {
        if (item.compact_result === "success") {
          ctx.turn.compactionSucceeded = true;
          if (ctx.turn.compactionMeasured) {
            ctx.emit({ kind: "item.completed", itemId: ctx.turn.compactionItemId, status: "completed" });
            ctx.turn.compactionItemId = undefined;
          }
        } else {
          ctx.emit({ kind: "item.completed", itemId: ctx.turn.compactionItemId, status: "failed" });
          ctx.turn.compactionItemId = undefined;
        }
        await ctx.flush();
      }
      return "continue";
    }
  return undefined;
}
