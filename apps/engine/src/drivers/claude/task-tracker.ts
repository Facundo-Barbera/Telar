import type { createEmitter } from "./emitter";
import crypto from "node:crypto";
import { type TaskSeed, isBackgroundWork, type TaskState, isUnstatedEnding, type UsageSnapshot } from "@telar/engine-client";
import { isTerminalTaskState, taskKindForTypeOrUndefined, isForegroundShell, taskKindForType, taskStateForStatus } from "./tasks";
import { str, asRecord, oneLine } from "./mapping";
import { taskOutputFileFrom } from "./task-output";
import { type SdkFrame } from "./frames";
import { type TurnState, type Rest } from "./turn";

export type TaskCtx = {
  turn: TurnState;
  emit: ReturnType<typeof createEmitter>["emit"];
};

export const liveBackgroundTasks = (ctx: TaskCtx): Array<TaskSeed & { id: string }> =>
  [...ctx.turn.knownTasks.entries()].flatMap(([id, task]) =>
    isBackgroundWork(task) && !isTerminalTaskState(task.state) ? [{ ...task, id }] : [],
  );

export const reportLostBackgroundWork = (ctx: TaskCtx): void => {
  const lost = liveBackgroundTasks(ctx);
  if (lost.length === 0) return;
  for (const task of lost) {
    const ended: TaskSeed = { ...task, state: "stopped", failure: "the provider process ended before this background task reported back" };
    ctx.turn.knownTasks.set(task.id, ended);
    ctx.emit({ kind: "task.completed", task: ended });
  }
  ctx.emit({
    kind: "runtime.warning",
    message: `the Claude process ended with ${lost.length} background task${lost.length === 1 ? "" : "s"} still running; ${lost.length === 1 ? "it was" : "they were"} lost with it`,
  });
};

export const taskIdFor = (ctx: TaskCtx, sdkTaskId: string | undefined, toolUseId: string | undefined): string => {
  if (toolUseId) return `task_${toolUseId}`;
  if (sdkTaskId && ctx.turn.taskIdsBySdkId.has(sdkTaskId)) return ctx.turn.taskIdsBySdkId.get(sdkTaskId)!;
  // A task this process never launched and the store never told it
  // about: the SDK id is the only handle, and the row it mints is
  // anonymous. Named so the journal says which case produced it.
  return `task_${sdkTaskId ?? crypto.randomUUID().replaceAll("-", "")}`;
};

/** Fold a partial report onto what this task was last known to be, then
 *  emit it whole — the repetition ./tasks.ts requires of every event. */
export const emitTask = (ctx: TaskCtx, 
  kind: "task.started" | "task.progress" | "task.completed",
  sdkTaskId: string | undefined,
  patch: Partial<TaskSeed> & { state: TaskState },
  toolUseId?: string,
  message?: string,
): void => {
  const id = taskIdFor(ctx, sdkTaskId, toolUseId);
  if (sdkTaskId) ctx.turn.taskIdsBySdkId.set(sdkTaskId, id);
  const known = ctx.turn.knownTasks.get(id);
  const statedKind = sdkTaskId ? taskKindForTypeOrUndefined(ctx.turn.taskTypesBySdkId.get(sdkTaskId)) : undefined;
  // …except an ending nobody stated, which a stated worse one corrects —
  // see `isUnstatedEnding`, and the store's copy of this rule.
  const corrected = known !== undefined && isUnstatedEnding(known) && (patch.state === "failed" || patch.state === "stopped");
  const state = known && isTerminalTaskState(known.state) && !corrected ? known.state : patch.state;
  const pendingOutput = sdkTaskId ? ctx.turn.pendingOutputFiles.get(sdkTaskId) : undefined;
  if (sdkTaskId) ctx.turn.pendingOutputFiles.delete(sdkTaskId);
  const task: TaskSeed = {
    ...known,
    ...(pendingOutput ? { outputFile: pendingOutput } : {}),
    ...patch,
    id,
    kind: patch.kind ?? statedKind ?? known?.kind ?? "agent",
    state,
    ...(sdkTaskId ? { providerTaskId: sdkTaskId } : {}),
  };
  ctx.turn.knownTasks.set(id, task);
  const settled = isTerminalTaskState(state);
  const announced = kind === "task.started" ? kind : settled ? "task.completed" : "task.progress";
  ctx.emit(announced === "task.progress" ? { kind: announced, task, ...(message ? { message } : {}) } : { kind: announced, task });
};

export const noteTaskOutput = (ctx: TaskCtx, structured: unknown, output: string): void => {
  const sdkId = str(asRecord(structured).backgroundTaskId);
  const file = sdkId ? taskOutputFileFrom(output) : undefined;
  if (!sdkId || !file || ctx.turn.suppressedTasks.has(sdkId)) return;
  const rowId = ctx.turn.taskIdsBySdkId.get(sdkId);
  const known = rowId ? ctx.turn.knownTasks.get(rowId) : undefined;
  if (!known) {
    ctx.turn.pendingOutputFiles.set(sdkId, file);
    return;
  }
  if (known.outputFile === file) return;
  emitTask(ctx, "task.progress", sdkId, { state: known.state, outputFile: file });
};

export const taskUsage = (ctx: TaskCtx, value: unknown): UsageSnapshot | undefined => {
  const usage = asRecord(value);
  if (typeof usage.total_tokens !== "number") return undefined;
  return { tokens: { input: 0, output: usage.total_tokens, cacheRead: 0, cacheCreate: 0 } };
};

export const handleTaskFrame = async (ctx: TaskCtx, item: SdkFrame): Promise<boolean> => {
  if (item.type !== "system") return false;
  const spokeFor = str(item.task_id) && !ctx.turn.suppressedTasks.has(item.task_id!) && item.ambient !== true
    ? taskIdFor(ctx, str(item.task_id), str(item.tool_use_id))
    : undefined;
  if (spokeFor && ctx.turn.runtimeRef && item.subtype !== "background_tasks_changed" && !isForegroundShell(str(item.task_type), item.is_backgrounded)) {
    ctx.turn.runtimeRef.tasks.lastWokenTaskId = spokeFor;
  }
  if (item.subtype === "task_started") {
    // Before the suppression branch: a blocking shell announces
    // `local_bash` and then earns no row, so this is the only place its
    // type is stated before Ctrl+B gives it one.
    if (str(item.task_id) && str(item.task_type)) ctx.turn.taskTypesBySdkId.set(item.task_id!, item.task_type!);
    if (item.ambient === true || isForegroundShell(str(item.task_type), item.is_backgrounded)) {
      if (str(item.task_id)) ctx.turn.suppressedTasks.add(item.task_id!);
      return true;
    }
    emitTask(ctx, 
      "task.started",
      str(item.task_id),
      {
        state: "running",
        kind: taskKindForType(str(item.task_type)),
        // Launched detached: it outlives this turn, whatever it is.
        ...(item.is_backgrounded === true ? { backgrounded: true } : {}),
        ...(str(item.description) ? { title: oneLine(item.description!) } : {}),
        ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
      },
      str(item.tool_use_id),
    );
    return true;
  }
  if (item.subtype === "task_progress") {
    if (str(item.task_id) && ctx.turn.suppressedTasks.has(item.task_id!)) return true;
    const known = ctx.turn.knownTasks.get(taskIdFor(ctx, str(item.task_id), str(item.tool_use_id)));
    emitTask(ctx, 
      "task.progress",
      str(item.task_id),
      {
        state: "running",
        ...(!known?.title && str(item.description) ? { title: oneLine(item.description!) } : {}),
        ...(str(item.subagent_type) ? { role: item.subagent_type! } : {}),
        ...(taskUsage(ctx, item.usage) ? { usage: taskUsage(ctx, item.usage)! } : {}),
      },
      str(item.tool_use_id),
      str(item.summary),
    );
    return true;
  }
  if (item.subtype === "task_updated") {
    if (str(item.task_id) && ctx.turn.suppressedTasks.has(item.task_id!)) {
      // Ctrl+B on a blocking shell: from here on it IS background work
      // and earns the row the never-announced branch below mints.
      if (item.patch?.is_backgrounded !== true) return true;
      ctx.turn.suppressedTasks.delete(item.task_id!);
    }
    const status = str(item.patch?.status);
    const state = taskStateForStatus(status);
    const terminal = state === "completed" || state === "failed" || state === "stopped";
    const backgrounded = item.patch?.is_backgrounded === true;
    // `task_updated` states no `task_type`, and `is_backgrounded` is set
    // for `local_agent` AND `local_bash` — so it cannot name a kind. The
    // fold reads the type the SDK stated elsewhere.
    emitTask(ctx, 
      terminal ? "task.completed" : "task.progress",
      str(item.task_id),
      {
        state,
        ...(str(item.patch?.description) ? { title: oneLine(item.patch!.description!) } : {}),
        ...(str(item.patch?.error) ? { failure: item.patch!.error! } : {}),
        ...(backgrounded ? { backgrounded: true } : {}),
      },
      undefined,
    );
    return true;
  }
  if (item.subtype === "task_notification") {
    if (str(item.task_id) && ctx.turn.suppressedTasks.has(item.task_id!)) return true;
    const id = taskIdFor(ctx, str(item.task_id), str(item.tool_use_id));
    // Only a shell's file is a log; an agent's is its transcript, which
    // the Agents tab already draws as steps.
    const logged = ctx.turn.knownTasks.get(id)?.kind === "background" && str(item.output_file);
    // Remembered on the PROCESS: the wake-up this notification triggers
    // may be read by the idle pump, or by the next turn's pump, and
    // either has to name the shell that spoke.
    emitTask(ctx, 
      "task.completed",
      str(item.task_id),
      {
        state: taskStateForStatus(str(item.status), "completed"),
        ...(str(item.summary) ? { resultText: item.summary! } : {}),
        ...(logged ? { outputFile: logged } : {}),
        ...(taskUsage(ctx, item.usage) ? { usage: taskUsage(ctx, item.usage)! } : {}),
      },
      str(item.tool_use_id),
    );
    return true;
  }
  if (item.subtype === "background_tasks_changed") {
    const entries = (Array.isArray(item.tasks) ? item.tasks : []).flatMap((raw) => {
      const entry = asRecord(raw);
      const id = str(entry.task_id);
      if (!id) return [];
      // The one frame that states `task_type` for a task this process
      // never announced. Remembered so the kind is read, not inferred
      // from `is_backgrounded` — set for sub-agents and shells alike.
      const taskType = str(entry.task_type);
      if (taskType) ctx.turn.taskTypesBySdkId.set(id, taskType);
      return [{ id, ambient: entry.ambient === true }];
    });
    const live = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      const rowId = ctx.turn.taskIdsBySdkId.get(entry.id);
      const row = rowId ? ctx.turn.knownTasks.get(rowId) : undefined;
      if (!row) {
        if (entry.ambient) ctx.turn.suppressedTasks.add(entry.id);
        continue;
      }
      if (isTerminalTaskState(row.state)) continue;
      const stated = taskKindForTypeOrUndefined(ctx.turn.taskTypesBySdkId.get(entry.id));
      const kind = stated && stated !== row.kind ? { kind: stated } : {};
      const backgrounded = isBackgroundWork(row) ? {} : { backgrounded: true };
      const ambient = (row.ambient === true) === entry.ambient ? {} : { ambient: entry.ambient };
      if (Object.keys({ ...kind, ...backgrounded, ...ambient }).length === 0) continue;
      emitTask(ctx, "task.progress", entry.id, { state: row.state, ...kind, ...backgrounded, ...ambient });
    }
    for (const task of ctx.turn.knownTasks.values()) {
      if (!isBackgroundWork(task) || isTerminalTaskState(task.state)) continue;
      const sdkId = task.providerTaskId;
      if (!sdkId || !ctx.turn.taskIdsBySdkId.has(sdkId) || live.has(sdkId)) continue;
      emitTask(ctx, "task.completed", sdkId, { state: "completed" });
    }
    return true;
  }
  return false;
};

export function bindTasks(ctx: TaskCtx) {
  return {
    liveBackgroundTasks: (...args: Rest<typeof liveBackgroundTasks>) => liveBackgroundTasks(ctx, ...args),
    reportLostBackgroundWork: (...args: Rest<typeof reportLostBackgroundWork>) => reportLostBackgroundWork(ctx, ...args),
    taskIdFor: (...args: Rest<typeof taskIdFor>) => taskIdFor(ctx, ...args),
    emitTask: (...args: Rest<typeof emitTask>) => emitTask(ctx, ...args),
    noteTaskOutput: (...args: Rest<typeof noteTaskOutput>) => noteTaskOutput(ctx, ...args),
    taskUsage: (...args: Rest<typeof taskUsage>) => taskUsage(ctx, ...args),
    handleTaskFrame: (...args: Rest<typeof handleTaskFrame>) => handleTaskFrame(ctx, ...args),
  };
}
