import type { LoopCtx } from "./loop-ctx";
import { str } from "./mapping";
import type { SdkFrame } from "./frames";
import { contextMaxFrom, usageFrom, turnCostFrom } from "./usage";
import { RateLimitedError } from "./limits";

const MAX_FAILURE_DETAIL = 500;

export function resultFailure(item: SdkFrame): string {
  const said = [item.is_error === true ? item.result : undefined, ...(item.errors ?? [])]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .join("; ")
    .slice(0, MAX_FAILURE_DETAIL);
  if (said) return `Claude did not complete successfully: ${said}`;
  if (item.subtype !== "success") return `Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`;
  return "Claude did not complete successfully (the result was flagged as an error)";
}

export async function onResultFrame(ctx: LoopCtx, item: SdkFrame, parentToolUseId: string | undefined): Promise<"continue" | "break" | undefined> {
  if (item.type === "result") {
      if (parentToolUseId) {
        await ctx.flush();
        return "continue";
      }
      const reportedContextMax = contextMaxFrom(item.modelUsage);
      ctx.turn.contextMax = reportedContextMax ?? ctx.turn.contextMax;
      if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
        const scalar = (candidate: unknown): number | undefined => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined);
        console.error(
          `[claude-timing] session=${ctx.sessionId} ` +
            JSON.stringify({
              durationMs: scalar(item.duration_ms),
              apiMs: scalar(item.duration_api_ms),
              ttftMs: scalar(item.ttft_ms),
              turns: scalar(item.num_turns),
              stopReason: str(item.stop_reason ?? undefined) ?? null,
              subtype: item.subtype ?? null,
            }),
        );
      }
      // THIS TURN'S SPEND, not the query's running total — see `turnCostFrom`.
      ctx.turn.usage = ctx.decorateUsage(usageFrom(item.usage, turnCostFrom(item.total_cost_usd, ctx.turn.runtime)) ?? ctx.turn.usage);
      if (ctx.turn.usage) ctx.emit({ kind: "usage", usage: ctx.turn.usage });
      if (item.subtype !== "success") {
        // An interrupt surfaces as a non-success result; the human's
        // stop must read as a stop, never as a provider failure.
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("driver cancelled");
        // OUR OWN CUT, ANSWERING A STEER: not a failure and not the turn's
        // end. The words that caused it are already in the feed, so keep
        // pumping; the text streamed before the cut stays journalled.
        if (ctx.consumeSteerCut()) {
          // …but the calls the interrupt killed ARE over, and leaving
          // them open is what wedged every steered turn — see
          // `closeCutTools`.
          ctx.closeCutTools();
          await ctx.flush();
          return "continue";
        }
        if (ctx.turn.standingLimit) throw new RateLimitedError(ctx.turn.standingLimit.resumeAt, ctx.turn.standingLimit.limitType);
        throw new Error(resultFailure(item));
      }
      if (item.is_error === true) {
        // Same rule as above: the human's stop reads as a stop.
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("driver cancelled");
        throw new Error(resultFailure(item));
      }
      const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
      const toolsStillRunning = ctx.turn.openTopLevelTools.size > 0 && (stopReason === "tool_use" || stopReason === null);
      if (ctx.turn.persistent && toolsStillRunning) {
        await ctx.flush();
        return "continue";
      }
      if (ctx.consumeSteerCut()) {
        const queuedTurns = "queued_turn_count" in item ? item.queued_turn_count : undefined;
        if (typeof queuedTurns === "number" && queuedTurns > 0) {
          await ctx.flush();
          return "continue";
        }
      }
      if (ctx.turn.persistent && ctx.turn.runtime.reportsSessionState) {
        ctx.turn.ownResultRead = true;
        // Steering stops here, as it did when the result ended the turn:
        // a message arriving after it is the engine's to requeue.
        ctx.turn.turnDone = true;
        ctx.turn.endTurnSeenAt = Date.now();
        await ctx.flush();
        return "continue";
      }
      ctx.turn.completed = true;
      await ctx.flush();
      if (ctx.turn.persistent) return "break";
      return "continue";
    }
  return undefined;
}

export async function onOwnResult(ctx: LoopCtx, item: SdkFrame, parentToolUseId: string | undefined): Promise<"continue" | undefined> {
  if (item.type === "result" && !parentToolUseId) {
      const sender = str(item.user_message_uuid);
      const foreignResult =
        ctx.turn.foreignTurn !== undefined ||
        (sender !== undefined && !ctx.turn.ownSends.has(sender)) ||
        (str(item.origin?.kind) !== undefined && item.origin?.kind !== "human");
      if (foreignResult) {
        ctx.turn.foreignTurn = undefined;
        ctx.turn.runtime.tasks.lastWokenTaskId = undefined;
        await ctx.flush();
        return "continue";
      }
    }
  return undefined;
}

export async function onEndTurnGrace(ctx: LoopCtx): Promise<"continue" | "break"> {
  if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
    console.error(`[claude-runtime] session=${ctx.sessionId} settled on the end-turn grace after ${ctx.endTurnGraceMs}ms; no result frame arrived`);
  }
  ctx.turn.completed = true;
  await ctx.flush();
  if (ctx.turn.persistent) return "break";
  return "continue";
}
