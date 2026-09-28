import { COALESCE_MS, type TurnState } from "./turn";
import { type TurnObservation } from "@telar/engine-client";

export function createEmitter(turn: TurnState) {
  const flush = (): Promise<void> => {
    if (turn.coalescing !== undefined) {
      clearTimeout(turn.coalescing);
      turn.coalescing = undefined;
    }
    const target = turn.pendingSink ?? turn.sink;
    const batch = turn.pending.splice(0, turn.pending.length);
    turn.pendingSink = undefined;
    const next = turn.flushQueue.then(async () => {
      if (batch.length === 0) return;
      await target(batch);
    });
    // The CHAIN must survive a rejection or every later flush inherits it;
    // the caller still sees the failure on the promise it was handed.
    turn.flushQueue = next.catch(() => undefined);
    return next;
  };
  const flushSoon = (): void => {
    if (turn.coalescing !== undefined) return;
    turn.coalescing = setTimeout(() => {
      turn.coalescing = undefined;
      void flush().catch(() => undefined);
    }, COALESCE_MS);
    turn.coalescing.unref?.();
  };
  const emit = (observation: TurnObservation): void => {
    // The pump swapped sinks with frames still buffered: they belong to the
    // sink that produced them, so they go now rather than to the new one.
    if (turn.pending.length > 0 && turn.pendingSink !== turn.sink) void flush().catch(() => undefined);
    const last = turn.pending.at(-1);
    if (
      observation.kind === "content.delta" &&
      last?.kind === "content.delta" &&
      last.itemId === observation.itemId &&
      last.stream === observation.stream
    ) {
      turn.pending[turn.pending.length - 1] = { ...last, text: last.text + observation.text };
      return;
    }
    turn.pending.push(observation);
    turn.pendingSink ??= turn.sink;
  };
  return { flush, flushSoon, emit };
}
