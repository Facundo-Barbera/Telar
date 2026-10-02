import type { bindProviderWait } from "./provider-wait";
import type { createEmitter } from "./emitter";
import type { bindBlocks } from "./observations";
import type { bindTasks } from "./task-tracker";
import type { bindClaims } from "./background-claims";
import { type ClaudeSessionRuntime, type ClaudeRuntimeStore } from "./runtime";
import { type ClaudeTurnBindings, type SdkCanUseTool } from "./sdk";
import { type TaskSeed, type UsageSnapshot, type ItemDetail, type TurnObservation } from "@telar/engine-client";
import { type DriverSessionHooks, type ProviderTurnBinding } from "../contract";
import { type OpenBlock, type StreamingInput, userText, openThinkingOf, noteThinkingTokens, streamingToolSeed, streamingInputFor, streamedPathUpdate, withToolResult } from "./observations";
import { type LimitWarningSeen, providerWaitFrom, takeProviderWait, titleForProviderWait } from "./limits";
import { type SdkFrame } from "./frames";
import { resultFailure } from "./turn-result";
import { str, itemId, asRecord, contentBlocks, itemDetailForToolCall, oneLine, titleForToolCall } from "./mapping";
import { gateFor } from "./permission-gate";
import { usageFrom, contextUsedFrom, contextMaxFrom, turnCostFrom } from "./usage";
import { type TurnState, type Rest } from "./turn";

export type PumpCtx = {
  turn: TurnState;
  backgroundGate: SdkCanUseTool;
  closeBackgroundClaim: ReturnType<typeof bindClaims>["closeBackgroundClaim"];
  closeBlock: ReturnType<typeof bindBlocks>["closeBlock"];
  decorateUsage: ReturnType<typeof bindProviderWait>["decorateUsage"];
  emit: ReturnType<typeof createEmitter>["emit"];
  flush: ReturnType<typeof createEmitter>["flush"];
  handleTaskFrame: ReturnType<typeof bindTasks>["handleTaskFrame"];
  lingerOnceQuiet: ReturnType<typeof bindClaims>["lingerOnceQuiet"];
  reportLostBackgroundWork: ReturnType<typeof bindTasks>["reportLostBackgroundWork"];
  runtimes: ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>;
};

type IdleWake = {
  binding: ProviderTurnBinding;
  text: string;
  usage: UsageSnapshot | undefined;
  gate: SdkCanUseTool | undefined;
  blocks: Map<string, OpenBlock>;
  tools: Map<string, { id: string; detail: ItemDetail }>;
  inputs: Map<string, StreamingInput>;
  /** The open provider-wait row, exactly as a human turn keeps one. */
  waitItemId: string | undefined;
  /** And its warning memory, for the same reason (#897): this
   *  record is the wake-up's turn, so it starts with none. */
  lastLimitWarning: LimitWarningSeen | undefined;
  /** The newest main-loop envelope's raw usage, so this turn's
   *  closing `message_delta` can correct its placeholder output. */
  lastUsage: unknown;
};

type IdlePump = {
  runtime: ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed>;
  hooks: DriverSessionHooks;
  idleSink: (observations: TurnObservation[]) => Promise<void>;
  wake: IdleWake | undefined;
  parkingForTurn: boolean;
};

export function startIdlePump(ctx: PumpCtx, idleRuntime: ClaudeSessionRuntime<ClaudeTurnBindings, TaskSeed>, hooks: DriverSessionHooks): void {
  if (idleRuntime.idlePump) return;
  let stopped = false;
  idleRuntime.idlePump = { stop: () => { stopped = true; } };
  void (async () => {
    const pump: IdlePump = { runtime: idleRuntime, hooks, idleSink: (observations) => hooks.onTasks(observations), wake: undefined, parkingForTurn: false };
    ctx.turn.sink = pump.idleSink;
    try {
      for (;;) {
        if (stopped) return;
        // NOT `takeStep`: a pump told to stop while parked must leave
        // the frame on `pendingStep` for the turn that stopped it —
        // the turn may not have awaited the promise yet.
        const step = idleRuntime.pendingStep ?? (idleRuntime.pendingStep = idleRuntime.iterator.next());
        const result = await step;
        if (stopped) return;
        if (idleRuntime.pendingStep === step) idleRuntime.pendingStep = undefined;
        if (result.done) {
          idleRuntime.streamEnded = true;
          await endWake(ctx, pump, { failure: "the provider process ended" });
          ctx.turn.sink = pump.idleSink;
          ctx.reportLostBackgroundWork();
          // The work the claim was held for died with the process; a
          // claim left open would be a turn nothing will ever settle.
          await ctx.closeBackgroundClaim().catch(() => undefined);
          await ctx.flush();
          return;
        }
        const item = result.value as SdkFrame;
        if (pump.parkingForTurn) {
          idleRuntime.parked.push(item);
          continue;
        }
        const parentToolUseId = str(item.parent_tool_use_id ?? undefined);
        if (str(item.session_id)) ctx.turn.reportedSessionId = item.session_id;

        if (await ctx.handleTaskFrame(item)) {
          // The last task may just have ended, which is what a held
          // background claim was waiting for.
          if (ctx.turn.backgroundClaim) ctx.lingerOnceQuiet(ctx.turn.backgroundClaim);
          await ctx.flush();
          continue;
        }
        // Sub-agent frames between turns: a backgrounded agent still
        // working. Filed under its task like inside a turn.
        const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : undefined;

        if (!pump.wake && !(await openWake(ctx, pump, item, parentToolUseId, ownerTaskId))) continue;

        await wakeFrame(ctx, pump, item, parentToolUseId, ownerTaskId);
      }
    } catch {
      await endWake(ctx, pump, { failure: "the provider stream failed between turns" }).catch(() => undefined);
      // A stream that threw is a process that is going away, with the
      // same consequence for its shells — see `reportLostBackgroundWork`.
      ctx.turn.sink = pump.idleSink;
      ctx.reportLostBackgroundWork();
      await ctx.closeBackgroundClaim().catch(() => undefined);
      await ctx.flush().catch(() => undefined);
      ctx.runtimes.destroy(idleRuntime.sessionId);
    } finally {
      if (idleRuntime.idlePump?.stop === undefined || stopped) idleRuntime.idlePump = undefined;
      void ctx.closeBackgroundClaim().catch(() => undefined);
    }
  })();
}

async function endWake(ctx: PumpCtx, pump: IdlePump, result: { text: string } | { failure: string }): Promise<void> {
  if (!pump.wake) return;
  const current = pump.wake;
  pump.wake = undefined;
  // The wake-up is over; the process may be evicted again.
  ctx.runtimes.setWakeActive(pump.runtime.sessionId, false);
  // A wait this turn ended inside is over, whatever ended it.
  if (current.waitItemId) ctx.emit({ kind: "item.completed", itemId: current.waitItemId, status: "completed" });
  for (const [, open] of current.tools) ctx.emit({ kind: "item.completed", itemId: open.id, status: "failed" });
  for (const [, open] of current.blocks) ctx.emit(ctx.closeBlock(open));
  await ctx.flush();
  ctx.turn.sink = pump.idleSink;
  // BACK TO THE BACKGROUND GATE, not to nothing (#891): the wake-up's
  // claim is gone, and the work it leaves behind still needs one. A
  // session running with no gate at all keeps none, as above.
  pump.runtime.bindings.current = { ...pump.runtime.bindings.current, canUseTool: ctx.turn.canUseTool ? ctx.backgroundGate : undefined };
  await current.binding.close("failure" in result ? result : { text: result.text, ...(current.usage ? { usage: current.usage } : {}) }).catch(() => undefined);
}

async function openWake(ctx: PumpCtx, pump: IdlePump, item: SdkFrame, parentToolUseId: string | undefined, ownerTaskId: string | undefined): Promise<boolean> {
  const idleRuntime = pump.runtime;
  const wokenTask = idleRuntime.tasks.lastWokenTaskId;
  const requesting =
    item.type === "system" && item.subtype === "status" && str(item.status) === "requesting" && !parentToolUseId && wokenTask !== undefined;
  // Anything the main loop says with no turn open is the CLI
  // starting one of its own. Open a real turn for it.
  const opens = requesting || (item.type === "stream_event" && item.event?.type === "message_start") || item.type === "assistant" || (item.type === "user" && !parentToolUseId);
  if (!opens && !ownerTaskId) return false;
  if (ownerTaskId) {
    // Sub-agent output with no turn: stays visible on its task.
    ctx.turn.sink = pump.idleSink;
    if (await pumpFrame(ctx, item, ownerTaskId, undefined)) await ctx.flush();
    return false;
  }
  const text = item.type === "user" ? userText(item.message?.content) : undefined;
  await ctx.closeBackgroundClaim().catch(() => undefined);
  const binding = await pump.hooks.onProviderTurn({
    input: text ?? "",
    reason: wokenTask ? { kind: "task_notification", taskId: wokenTask } : { kind: "unknown" },
  });
  if (!binding) {
    // A human turn took the session first. Park this and every
    // frame after it for that turn; the pump ends when the turn
    // claims the runtime.
    pump.parkingForTurn = true;
    idleRuntime.parked.push(item);
    return false;
  }
  idleRuntime.tasks.lastWokenTaskId = undefined;
  // LIVE WORK, so the pool stops treating this process as spare.
  // The engine has opened a real turn against it; evicting it now
  // would kill a turn nobody could see start.
  ctx.runtimes.setWakeActive(idleRuntime.sessionId, true);
  const wake: IdleWake = {
    binding,
    text: "",
    usage: undefined,
    gate: binding.onRequest ? gateFor(binding.onRequest) : undefined,
    blocks: new Map(),
    tools: new Map(),
    inputs: new Map(),
    waitItemId: undefined,
    lastLimitWarning: undefined,
    lastUsage: undefined,
  };
  pump.wake = wake;
  ctx.turn.sink = (observations) => binding.onObservations(observations);
  idleRuntime.bindings.current = { ...idleRuntime.bindings.current, canUseTool: wake.gate };
  // The announcement said a request went out, and the turn just
  // opened above IS that. Nothing is left of it to render.
  if (requesting) return false;
  // The CLI's injected notification message is the turn's input
  // — already on the turn; not a row.
  if (item.type === "user" && !parentToolUseId && text !== undefined) return false;
  return true;
}

async function wakeFrame(ctx: PumpCtx, pump: IdlePump, item: SdkFrame, parentToolUseId: string | undefined, ownerTaskId: string | undefined): Promise<void> {
  const wake = pump.wake!;
  const idleRuntime = pump.runtime;
  const idleWaited = providerWaitFrom(item);
  if (idleWaited) {
    // The repeat warning is dropped here too, and for the same
    // reason: an autonomous turn makes as many requests as a
    // human's, so it collects as many identical frames (#897).
    const idleTaken = takeProviderWait(idleWaited.detail, wake.lastLimitWarning);
    wake.lastLimitWarning = idleTaken.seen;
    if (!idleTaken.emit) return;
    if (wake.waitItemId) ctx.emit({ kind: "item.completed", itemId: wake.waitItemId, status: "completed" });
    const id = itemId();
    const detail: ItemDetail = { type: "provider_wait", wait: idleWaited.detail };
    ctx.emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(idleWaited.detail) } });
    wake.waitItemId = idleWaited.blocking ? id : undefined;
    if (!idleWaited.blocking) ctx.emit({ kind: "item.completed", itemId: id, status: "completed", detail });
    await ctx.flush();
    return;
  }
  // Same ownership rule as the turn pump: only this turn's own main
  // loop speaking proves the request went through.
  if (wake.waitItemId && !parentToolUseId && (item.type === "stream_event" || item.type === "assistant" || item.type === "user" || item.type === "result")) {
    ctx.emit({ kind: "item.completed", itemId: wake.waitItemId, status: "completed" });
    wake.waitItemId = undefined;
  }

  if (item.type === "assistant" && !parentToolUseId) {
    const snapshot = usageFrom(item.message?.usage, undefined);
    if (snapshot) {
      // Kept raw so this turn's closing `message_delta` can correct
      // its placeholder output count against it.
      wake.lastUsage = item.message?.usage;
      ctx.turn.contextUsed = contextUsedFrom(item.message?.usage) ?? ctx.turn.contextUsed;
      wake.usage = ctx.decorateUsage(snapshot);
      ctx.emit({ kind: "usage", usage: wake.usage! });
    }
  }
  /** The response's REAL output count, for a wake-up too — see the
   *  turn pump's copy of this. */
  if (item.type === "stream_event" && item.event?.type === "message_delta" && !parentToolUseId && wake.lastUsage) {
    const output = asRecord(item.event.usage).output_tokens;
    if (typeof output === "number" && output >= 0) {
      wake.lastUsage = { ...asRecord(wake.lastUsage), output_tokens: output };
      ctx.turn.contextUsed = contextUsedFrom(wake.lastUsage) ?? ctx.turn.contextUsed;
      const snapshot = usageFrom(wake.lastUsage, undefined);
      if (snapshot) {
        wake.usage = ctx.decorateUsage({ ...snapshot, ...(wake.usage?.costUsd === undefined ? {} : { costUsd: wake.usage.costUsd }) });
        ctx.emit({ kind: "usage", usage: wake.usage! });
        await ctx.flush();
      }
    }
    return;
  }
  if (item.type === "result" && !parentToolUseId) {
    const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
    if (wake.tools.size > 0 && (stopReason === "tool_use" || stopReason === null)) return;
    ctx.turn.contextMax = contextMaxFrom(item.modelUsage) ?? ctx.turn.contextMax;
    // The same accounting a human turn gets: a wake-up spends
    // against the same query, so it takes the same baseline.
    wake.usage = ctx.decorateUsage(usageFrom(item.usage, turnCostFrom(item.total_cost_usd, idleRuntime)) ?? wake.usage);
    if (wake.usage) ctx.emit({ kind: "usage", usage: wake.usage });
    const failure = item.subtype !== "success" || item.is_error === true ? resultFailure(item) : undefined;
    await endWake(ctx, pump, failure ? { failure } : { text: wake.text });
    return;
  }
  const text = await pumpFrame(ctx, item, ownerTaskId, wake);
  if (text) wake.text += text;
  await ctx.flush();
}

export async function pumpFrame(ctx: PumpCtx, 
  item: SdkFrame,
  ownerTaskId: string | undefined,
  wake:
    | { blocks: Map<string, OpenBlock>; tools: Map<string, { id: string; detail: ItemDetail }>; inputs: Map<string, StreamingInput> }
    | undefined,
): Promise<string> {
  const blocks = wake?.blocks ?? new Map<string, OpenBlock>();
  const tools = wake?.tools ?? new Map<string, { id: string; detail: ItemDetail }>();
  const inputs = wake?.inputs ?? new Map<string, StreamingInput>();
  let added = "";
  // The silent thought's running size — see the turn pump's copy. The
  // idle pump flushes after every frame, so there is nothing to schedule.
  if (item.type === "system" && item.subtype === "thinking_tokens") {
    const open = openThinkingOf(blocks, ownerTaskId);
    const progress = open ? noteThinkingTokens(open, item.estimated_tokens) : undefined;
    if (progress) ctx.emit(progress);
    return added;
  }
  if (item.type === "stream_event") {
    const event = item.event ?? {};
    const index = `${ownerTaskId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;
    if (event.type === "content_block_start") {
      const blockType = event.content_block?.type;
      const useId = str(event.content_block?.id);
      const name = str(event.content_block?.name);
      if (blockType === "text" || blockType === "thinking") {
        const id = itemId();
        blocks.set(index, { id, kind: blockType, text: "", ...(ownerTaskId ? { taskId: ownerTaskId } : {}) });
        ctx.emit({ kind: "item.started", item: { id, detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) } });
      } else if (wake && blockType === "tool_use" && useId && name && name !== "TodoWrite" && !tools.has(useId)) {
        // Opened as the model starts writing the call — see the turn pump.
        // Only inside a wake-up: with no turn the map is this frame's
        // alone, so the envelope could not tell it had been opened.
        const seed = streamingToolSeed(useId, name, ownerTaskId);
        tools.set(useId, { id: seed.id, detail: seed.detail });
        const input = streamingInputFor(useId, name, ownerTaskId);
        if (input) inputs.set(index, input);
        ctx.emit({ kind: "item.started", item: seed });
      }
    } else if (event.type === "content_block_delta") {
      const pathUpdate = streamedPathUpdate(inputs, tools, index, event.delta);
      if (pathUpdate) ctx.emit(pathUpdate);
      const open = blocks.get(index);
      const progress = open ? noteThinkingTokens(open, event.delta?.estimated_tokens) : undefined;
      if (progress) ctx.emit(progress);
      const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
      if (open && typeof text === "string" && text.length > 0) {
        open.text += text;
        if (open.kind === "text" && !ownerTaskId) added += text;
        ctx.emit({ kind: "content.delta", itemId: open.id, stream: open.kind === "text" ? "assistant_text" : "reasoning_text", text });
      }
    } else if (event.type === "content_block_stop") {
      inputs.delete(index);
      const open = blocks.get(index);
      if (open) {
        blocks.delete(index);
        ctx.emit(ctx.closeBlock(open));
      }
    }
    return added;
  }
  if (item.type === "assistant") {
    for (const raw of contentBlocks(item.message?.content)) {
      const block = asRecord(raw);
      if (block.type !== "tool_use") continue;
      const name = str(block.name) ?? "tool";
      const useId = str(block.id) ?? itemId();
      const isTask = name === "Task" || name === "Agent";
      const detail: ItemDetail = isTask ? { type: "task", taskId: `task_${useId}` } : itemDetailForToolCall(name, block.input);
      const title = isTask ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name) : titleForToolCall(name, detail);
      const streamed = tools.has(useId);
      tools.set(useId, { id: `item_${useId}`, detail });
      ctx.emit({ kind: streamed ? "item.updated" : "item.started", item: { id: `item_${useId}`, detail, title, ...(ownerTaskId ? { taskId: ownerTaskId } : {}), providerRefs: { itemId: useId } } });
    }
    return added;
  }
  if (item.type === "user") {
    const results = contentBlocks(item.message?.content).map(asRecord).filter((block) => block.type === "tool_result");
    const structured = results.length === 1 ? item.tool_use_result : undefined;
    for (const block of results) {
      const useId = str(block.tool_use_id);
      const open = useId ? tools.get(useId) : undefined;
      if (!open || !useId) continue;
      tools.delete(useId);
      const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
      ctx.emit({ kind: "item.completed", itemId: open.id, status: block.is_error === true ? "failed" : "completed", detail: withToolResult(open.detail, output, structured) });
    }
  }
  return added;
}

export function bindIdlePump(ctx: PumpCtx) {
  return {
    startIdlePump: (...args: Rest<typeof startIdlePump>) => startIdlePump(ctx, ...args),
    pumpFrame: (...args: Rest<typeof pumpFrame>) => pumpFrame(ctx, ...args),
  };
}
