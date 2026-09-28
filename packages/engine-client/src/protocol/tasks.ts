import { z } from "zod";
import { Id, Effort, ModelSelection, Timestamp, UsageSnapshot } from "./common";

export const TaskKind = z.enum([
  /** A real sub-agent: its own context, its own turns. */
  "agent",
  /** A watch loop or long-running shell — work that continues after the turn
   *  that started it settles. This is why a session can be "still working"
   *  with no active turn. */
  "background",
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskState = z.enum([
  "pending",
  "running",
  /** Blocked on a request of its own. */
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export type TaskState = z.infer<typeof TaskState>;

export const Task = z.object({
  id: Id,
  sessionId: Id,
  runId: Id,
  kind: TaskKind,
  state: TaskState,
  backgrounded: z.boolean().optional(),
  ambient: z.boolean().optional(),

  title: z.string().optional(),
  /** The agent's role/persona when the launcher named one. */
  role: z.string().optional(),
  model: ModelSelection.optional(),
  effort: Effort.optional(),

  startedAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),

  parentTaskId: Id.optional(),

  /** The provider's own task/tool-use handle, for correlation. */
  providerTaskId: z.string().min(1).optional(),

  /** Per-task usage, so a fan-out's cost can be attributed rather than only
   *  summed at the turn. */
  usage: UsageSnapshot.optional(),

  /** Terminal text the task returned — a sub-agent's report to its caller. */
  resultText: z.string().optional(),
  failure: z.string().optional(),
  outputFile: z.string().min(1).max(4096).optional(),
});
export type Task = z.infer<typeof Task>;

/** One page of a background task's log (`GET …/tasks/:taskId/output`). */
export type TaskOutputPage = {
  text: string;
  /** Byte offset to pass as `after` next time. */
  cursor: number;
  size: number;
  /** The read began past the start of the file (the tail of a long log). */
  truncated: boolean;
  /** More bytes are already there past `cursor`. */
  more: boolean;
  /** The file does not exist — never written yet, or the OS cleaned it up. */
  missing: boolean;
};

export const TaskSeed = Task.omit({
  sessionId: true,
  runId: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
});
export type TaskSeed = z.infer<typeof TaskSeed>;

export function isBackgroundWork(task: Pick<Task, "kind" | "backgrounded">): boolean {
  return task.kind === "background" || task.backgrounded === true;
}

export function countsAsActivity(task: Pick<Task, "state" | "ambient">): boolean {
  return (task.state === "pending" || task.state === "running") && task.ambient !== true;
}

export function isUnstatedEnding(task: Pick<Task, "state" | "resultText" | "failure">): boolean {
  return task.state === "completed" && task.resultText === undefined && task.failure === undefined;
}

export function livenessOf(tasks: readonly Task[]): "working" | "monitoring" | null {
  let monitoring = false;
  for (const task of tasks) {
    if (!countsAsActivity(task)) continue;
    if (!isBackgroundWork(task)) return "working";
    monitoring = true;
  }
  return monitoring ? "monitoring" : null;
}
