// ── tool results ──────────────────────────────────────────────
import crypto from "node:crypto";
import { takeProviderWait, titleForProviderWait } from "./limits";
import { itemId, contentBlocks, asRecord, str, itemDetailForToolCall, oneLine, titleForToolCall } from "./mapping";
import type { ItemDetail, ItemSeed } from "@telar/engine-client";
import type { LoopCtx } from "./loop-ctx";
import { usageFrom, contextUsedFrom } from "./usage";
import { planDetailForTodos } from "./tasks";
import type { SdkFrame } from "./frames";
import { withToolResult } from "./observations";

export async function onUserFrame(ctx: LoopCtx, item: SdkFrame): Promise<void> {
  if (item.type === "user") {
      const results = contentBlocks(item.message?.content).map(asRecord).filter((block) => block.type === "tool_result");
      const structured = results.length === 1 ? item.tool_use_result : undefined;
      for (const block of results) {
        const useId = str(block.tool_use_id);
        const open = useId ? ctx.turn.openTools.get(useId) : undefined;
        if (!open || !useId) continue;
        ctx.turn.openTools.delete(useId);
        ctx.turn.openTopLevelTools.delete(useId);
        const failed = block.is_error === true;
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
        if (!failed && structured) ctx.noteTaskOutput(structured, output);
        ctx.emit({
          kind: "item.completed",
          itemId: open.id,
          status: failed ? "failed" : "completed",
          detail: withToolResult(open.detail, output, structured),
        });
      }
      await ctx.flush();
    }
}

// ── tool calls, from the complete envelope ─────────────────────
export async function onAssistantFrame(ctx: LoopCtx, item: SdkFrame, ours: boolean, ownerTaskId: string | undefined): Promise<"continue" | undefined> {
  if (item.type === "assistant") {
      // A sub-agent's usage is reported on its own task, not folded into
      // the parent's running total, or the turn would double-count it
      // against the `result` message's authoritative figure.
      if (ours) {
        const snapshot = usageFrom(item.message?.usage, undefined);
        if (snapshot) {
          // Kept raw so the response's closing `message_delta` can
          // correct its placeholder output count against it.
          ctx.turn.lastEnvelopeUsage = item.message?.usage;
          ctx.turn.contextUsed = contextUsedFrom(item.message?.usage) ?? ctx.turn.contextUsed;
          ctx.turn.usage = ctx.decorateUsage(snapshot);
          ctx.emit({ kind: "usage", usage: ctx.turn.usage! });
        }
      }
      for (const raw of contentBlocks(item.message?.content)) {
        const block = asRecord(raw);
        if (block.type === "tool_use") {
          const name = str(block.name) ?? "tool";
          const useId = str(block.id) ?? itemId();
          const plan = name === "TodoWrite" ? planDetailForTodos(block.input) : undefined;
          if (plan) {
            const detail: ItemDetail = { type: "plan", plan };
            if (ctx.turn.planItemId) ctx.emit({ kind: "item.updated", item: { id: ctx.turn.planItemId, detail, title: "Plan" } });
            else {
              ctx.turn.planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
              ctx.emit({ kind: "item.started", item: { id: ctx.turn.planItemId, detail, title: "Plan" } });
            }
            continue;
          }
          const isTask = name === "Task" || name === "Agent";
          const detail: ItemDetail = isTask
            ? { type: "task", taskId: `task_${useId}` }
            : itemDetailForToolCall(name, block.input);
          const title = isTask
            ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name)
            : titleForToolCall(name, detail);
          const seed: ItemSeed = {
            id: `item_${useId}`,
            detail,
            title,
            ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
            providerRefs: { itemId: useId },
          };
          // Already opened by its `content_block_start`: this is the
          // same row, now with its input — an update, never a second row.
          const streamed = ctx.turn.openTools.has(useId);
          ctx.turn.openTools.set(useId, { id: seed.id, detail });
          if (ours) ctx.turn.openTopLevelTools.add(useId);
          ctx.emit({ kind: streamed ? "item.updated" : "item.started", item: seed });
          continue;
        }
        if (block.type === "text" && !ctx.turn.receivedPartialText) {
          const text = str(block.text);
          if (!text) continue;
          if (ours) ctx.turn.finalText += text;
          const id = itemId();
          ctx.emit({
            kind: "item.started",
            item: { id, detail: { type: "assistant_message", text }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) },
          });
          ctx.emit({ kind: "item.completed", itemId: id, status: "completed" });
        }
      }
      if (ours && item.message?.stop_reason === "end_turn" && ctx.turn.openTopLevelTools.size === 0) ctx.turn.endTurnSeenAt = Date.now();
      await ctx.flush();
      return "continue";
    }
  return undefined;
}

export async function onProviderWait(ctx: LoopCtx, waited: { detail: { kind: "api_retry" | "rate_limit" | "no_response"; attempt?: number | undefined; maxAttempts?: number | undefined; delayMs?: number | undefined; status?: number | undefined; waitedMs?: number | undefined; limitStatus?: "allowed" | "allowed_warning" | "rejected" | undefined; limitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage" | "other" | undefined; resetsAt?: number | undefined; utilization?: number | undefined; }; blocking: boolean; } | undefined): Promise<"continue" | undefined> {
  if (waited) {
      const taken = takeProviderWait(waited.detail, ctx.turn.lastLimitWarning);
      ctx.turn.lastLimitWarning = taken.seen;
      // DROPPED BEFORE `closeProviderWait`: a frame that says nothing new
      // is not an event, so it must not close a standing wait row either.
      if (!taken.emit) return "continue";
      ctx.closeProviderWait();
      const id = itemId();
      const detail: ItemDetail = { type: "provider_wait", wait: waited.detail };
      ctx.emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(waited.detail) } });
      if (waited.blocking) ctx.turn.waitItemId = id;
      else ctx.emit({ kind: "item.completed", itemId: id, status: "completed", detail });
      // SECONDS TO MILLISECONDS, the one place it happens: the row above
      // keeps the provider's own units, and everything downstream of here
      // is a time the engine schedules against. See `TurnFailure.resumeAt`.
      if (waited.blocking && waited.detail.kind === "rate_limit" && waited.detail.resetsAt !== undefined) {
        ctx.turn.standingLimit = {
          resumeAt: waited.detail.resetsAt * 1_000,
          ...(waited.detail.limitType === undefined ? {} : { limitType: waited.detail.limitType }),
        };
      }
      await ctx.flush();
      return "continue";
    }
  return undefined;
}
