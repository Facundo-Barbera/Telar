// ── streaming text and reasoning ───────────────────────────────
import { str, itemId, asRecord } from "./mapping";
import type { SdkFrame } from "./frames";
import type { LoopCtx } from "./loop-ctx";
import { openThinkingOf, noteThinkingTokens, streamingToolSeed, streamingInputFor, streamedPathUpdate } from "./observations";
import { contextUsedFrom, usageFrom } from "./usage";

export async function onStreamFrame(ctx: LoopCtx, item: SdkFrame, parentToolUseId: string | undefined, ownerTaskId: string | undefined, ours: boolean): Promise<"continue" | undefined> {
  if (item.type === "stream_event") {
      const event = item.event ?? {};
      const index = `${parentToolUseId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;

      if (event.type === "content_block_start") {
        const blockType = event.content_block?.type;
        if (blockType === "text" || blockType === "thinking") {
          const id = itemId();
          ctx.turn.openBlocks.set(index, { id, kind: blockType, text: "", ...(ownerTaskId ? { taskId: ownerTaskId } : {}) });
          ctx.emit({
            kind: "item.started",
            item: {
              id,
              detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
              ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
            },
          });
          // FLUSHED NOW, not with the first delta. A thought whose text
          // the CLI omits has no text deltas at all, and waiting for one
          // left minutes of a turn with nothing but `turn.started`.
          await ctx.flush();
          return "continue";
        }
        const useId = str(event.content_block?.id);
        const name = str(event.content_block?.name);
        if (blockType === "tool_use" && useId && name && name !== "TodoWrite" && !ctx.turn.openTools.has(useId)) {
          const seed = streamingToolSeed(useId, name, ownerTaskId);
          ctx.turn.openTools.set(useId, { id: seed.id, detail: seed.detail });
          const input = streamingInputFor(useId, name, ownerTaskId);
          if (input) ctx.turn.streamingInputs.set(index, input);
          if (ours) ctx.turn.openTopLevelTools.add(useId);
          ctx.emit({ kind: "item.started", item: seed });
          await ctx.flush();
        }
        return "continue";
      }

      if (event.type === "content_block_delta") {
        const pathUpdate = streamedPathUpdate(ctx.turn.streamingInputs, ctx.turn.openTools, index, event.delta);
        if (pathUpdate) {
          ctx.emit(pathUpdate);
          await ctx.flush();
          return "continue";
        }
        const open = ctx.turn.openBlocks.get(index);
        if (!open) return "continue";
        const progress = noteThinkingTokens(open, event.delta?.estimated_tokens);
        if (progress) {
          ctx.emit(progress);
          ctx.flushSoon();
        }
        const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
        if (typeof text !== "string" || text.length === 0) return "continue";
        open.text += text;
        // The producer streams, whoever the text belongs to: the
        // envelope's own text is a repeat and must not become a row.
        if (open.kind === "text") ctx.turn.receivedPartialText = true;
        if (open.kind === "text" && ours) ctx.turn.finalText += text;
        ctx.emit({
          kind: "content.delta",
          itemId: open.id,
          stream: open.kind === "text" ? "assistant_text" : "reasoning_text",
          text,
        });
        // Coalesced for a frame rather than flushed per chunk — see
        // `flushSoon`. Every terminal frame below still flushes at once.
        ctx.flushSoon();
        return "continue";
      }

      if (event.type === "content_block_stop") {
        ctx.turn.streamingInputs.delete(index);
        const open = ctx.turn.openBlocks.get(index);
        if (!open) return "continue";
        ctx.turn.openBlocks.delete(index);
        ctx.emit(ctx.closeBlock(open));
        await ctx.flush();
        return "continue";
      }

      if (
        event.type === "message_delta" &&
        ours &&
        str(asRecord(event.delta).stop_reason) === "end_turn" &&
        ctx.turn.openTopLevelTools.size === 0
      ) {
        ctx.turn.endTurnSeenAt = Date.now();
      }
      if (event.type === "message_delta" && ours && ctx.turn.lastEnvelopeUsage) {
        const output = asRecord(event.usage).output_tokens;
        if (typeof output !== "number" || output < 0) return "continue";
        ctx.turn.lastEnvelopeUsage = { ...asRecord(ctx.turn.lastEnvelopeUsage), output_tokens: output };
        ctx.turn.contextUsed = contextUsedFrom(ctx.turn.lastEnvelopeUsage) ?? ctx.turn.contextUsed;
        const snapshot = usageFrom(ctx.turn.lastEnvelopeUsage, undefined);
        if (!snapshot) return "continue";
        // The cost already recorded for this turn is kept: this frame
        // says nothing about price, and dropping it would read as free.
        ctx.turn.usage = ctx.decorateUsage({ ...snapshot, ...(ctx.turn.usage?.costUsd === undefined ? {} : { costUsd: ctx.turn.usage.costUsd }) });
        ctx.emit({ kind: "usage", usage: ctx.turn.usage! });
        await ctx.flush();
      }
      return "continue";
    }
  return undefined;
}

export function onThinkingTokens(ctx: LoopCtx, item: SdkFrame, parentToolUseId: string | undefined): "continue" | undefined {
  if (item.type === "system" && item.subtype === "thinking_tokens") {
      const open = openThinkingOf(ctx.turn.openBlocks, parentToolUseId);
      const progress = open ? noteThinkingTokens(open, item.estimated_tokens) : undefined;
      if (progress) {
        ctx.emit(progress);
        ctx.flushSoon();
      }
      return "continue";
    }
  return undefined;
}

export function onMessageStart(ctx: LoopCtx, item: SdkFrame, parentToolUseId: string | undefined): void {
  if (item.type === "stream_event" && item.event?.type === "message_start" && !parentToolUseId) {
      const sender = str(item.user_message_uuid);
      if (sender !== undefined && ctx.turn.ownSends.has(sender)) {
        // Our reply has begun. Later message_starts INSIDE it (the
        // continuation after a tool round) carry no uuid — measured —
        // and are ours by position.
        ctx.turn.ownTurnOpen = true;
        ctx.turn.foreignTurn = undefined;
        ctx.turn.runtime.echoesUserMessageUuid = true;
      } else if (sender !== undefined || (ctx.turn.runtime.echoesUserMessageUuid && !ctx.turn.ownTurnOpen && !ctx.turn.steerSent)) {
        ctx.turn.foreignTurn = { taskId: ctx.turn.runtime.tasks.lastWokenTaskId };
      }
    }
}
