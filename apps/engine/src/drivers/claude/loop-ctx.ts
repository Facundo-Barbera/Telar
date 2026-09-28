import type { bindTasks } from "./task-tracker";
import type { createEmitter } from "./emitter";
import type { bindProviderWait } from "./provider-wait";
import type { bindBlocks } from "./observations";
import type { bindSteering } from "./steering";
import type { TurnState } from "./turn";

export type LoopCtx = {
  turn: TurnState;
  noteTaskOutput: ReturnType<typeof bindTasks>["noteTaskOutput"];
  emit: ReturnType<typeof createEmitter>["emit"];
  flush: ReturnType<typeof createEmitter>["flush"];
  decorateUsage: ReturnType<typeof bindProviderWait>["decorateUsage"];
  flushSoon: ReturnType<typeof createEmitter>["flushSoon"];
  closeBlock: ReturnType<typeof bindBlocks>["closeBlock"];
  sessionId: string;
  signal: AbortSignal;
  consumeSteerCut: ReturnType<typeof bindSteering>["consumeSteerCut"];
  closeCutTools: ReturnType<typeof bindSteering>["closeCutTools"];
  armProviderSilence: ReturnType<typeof bindProviderWait>["armProviderSilence"];
  disarmProviderSilence: ReturnType<typeof bindProviderWait>["disarmProviderSilence"];
  closeProviderWait: ReturnType<typeof bindProviderWait>["closeProviderWait"];
  endTurnGraceMs: number;
};
