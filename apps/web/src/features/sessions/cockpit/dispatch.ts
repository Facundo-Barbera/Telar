import type { JournalItem, JournalTurn } from "@/platform/engine";
import { bareNotificationTurn } from "@/features/transcript";

export type WorkerState = "working" | "result" | "blocker" | "failed" | "stopped";

export type DispatchWorker = { sessionId: string; state: WorkerState; message?: string };

export type DispatchBlock = { dispatchRunId: string; workers: DispatchWorker[] };

/** A `sessions_send` this turn made, as `{ to, intent }`. */
export function sends(items: readonly JournalItem[]): { to?: string; intent?: string }[] {
  return items.flatMap((item) => {
    const call = "call" in item.detail ? item.detail.call : undefined;
    if (!call || !/(^|__)sessions_send$/.test(call.name)) return [];
    const input = (call.input ?? {}) as { sessionId?: unknown; intent?: unknown };
    return [{ ...(typeof input.sessionId === "string" ? { to: input.sessionId } : {}), ...(typeof input.intent === "string" ? { intent: input.intent } : {}) }];
  });
}

function taskedFrom(items: readonly JournalItem[]): string[] {
  return [...new Set(sends(items).flatMap((send) => (send.intent === "task" && send.to ? [send.to] : [])))];
}

/** The sessions one turn tasked, when it tasked more than one. */
export function dispatchedFrom(items: readonly JournalItem[]): string[] {
  const tasked = taskedFrom(items);
  return tasked.length > 1 ? tasked : [];
}

function arrival(turn: JournalTurn): { from: string; state: WorkerState; message?: string } | undefined {
  const detail = turn.notification;
  if (!detail?.sessionId || detail.entries?.length) return undefined;
  if (detail.kind === "peer_message" && turn.origin === "session" && turn.sender?.sessionId === detail.sessionId) {
    const message = turn.prompt.trim() || undefined;
    if (turn.agentIntent === "result") return { from: detail.sessionId, state: "result", ...(message ? { message } : {}) };
    if (turn.agentIntent === "blocker") return { from: detail.sessionId, state: "blocker", ...(message ? { message } : {}) };
    if (turn.agentIntent === "report") return { from: detail.sessionId, state: "working", ...(message ? { message } : {}) };
    return undefined;
  }
  if (detail.kind === "wake" && detail.wakeKind === "turn_failed") return { from: detail.sessionId, state: "failed" };
  if (detail.kind === "wake" && detail.wakeKind === "turn_stopped") return { from: detail.sessionId, state: "stopped" };
  return undefined;
}

/**
 * Workers tasked from one turn become one block, drawn where the first of their arrivals lands.
 * A bare arrival folds into its line; a blocker, or an arrival the session answered, keeps its row.
 */
export function planDispatches(turns: readonly JournalTurn[], activeRunId?: string): { blocks: Map<string, DispatchBlock>; absorbed: Set<string> } {
  const blocks = new Map<string, DispatchBlock>();
  const absorbed = new Set<string>();
  const dispatchOf = new Map<string, { runId: string; to: string[] }>();
  const byDispatch = new Map<string, DispatchBlock>();
  for (const turn of turns) {
    const tasked = taskedFrom(turn.items);
    for (const to of tasked) {
      if (tasked.length > 1) dispatchOf.set(to, { runId: turn.runId, to: tasked });
      else dispatchOf.delete(to);
    }
    const came = arrival(turn);
    const dispatch = came ? dispatchOf.get(came.from) : undefined;
    if (!came || !dispatch) continue;
    let block = byDispatch.get(dispatch.runId);
    if (!block) {
      block = { dispatchRunId: dispatch.runId, workers: dispatch.to.map((sessionId) => ({ sessionId, state: "working" })) };
      byDispatch.set(dispatch.runId, block);
      blocks.set(turn.runId, block);
    }
    const worker = block.workers.find((each) => each.sessionId === came.from)!;
    const settled = worker.state === "result" || worker.state === "failed" || worker.state === "stopped";
    if (!(settled && came.state === "working")) {
      worker.state = came.state;
      if (came.message) worker.message = came.message;
    }
    if (came.state !== "blocker" && turn.runId !== activeRunId && turn.state === "completed" && bareNotificationTurn(turn)) absorbed.add(turn.runId);
  }
  return { blocks, absorbed };
}

export function dispatchSummary(workers: readonly DispatchWorker[]): string {
  const count = (state: WorkerState) => workers.filter((worker) => worker.state === state).length;
  const parts = [
    `${workers.length} sessions`,
    count("result") ? `${count("result")} done` : "",
    count("working") ? `${count("working")} working` : "",
    count("blocker") ? `${count("blocker")} blocked` : "",
    count("failed") ? `${count("failed")} failed` : "",
    count("stopped") ? `${count("stopped")} stopped` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}
