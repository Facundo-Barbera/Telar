import type { PlanDetail, TaskKind, TaskState } from "@telar/engine-client";
import { asRecord, str } from "./mapping";

const BACKGROUND_TASK_TYPES = new Set(["background_shell", "background_bash", "local_bash", "monitor", "watch"]);

export function taskKindForType(taskType: string | undefined): TaskKind {
  return taskType && BACKGROUND_TASK_TYPES.has(taskType) ? "background" : "agent";
}

/** The same classification, but SILENT about a type nobody stated — so an
 *  absent `task_type` reads as "unknown", never as "agent". */
export function taskKindForTypeOrUndefined(taskType: string | undefined): TaskKind | undefined {
  return taskType ? taskKindForType(taskType) : undefined;
}

export function isForegroundShell(taskType: string | undefined, backgrounded: boolean | undefined): boolean {
  return taskKindForType(taskType) === "background" && backgrounded !== true;
}

export function taskStateForStatus(status: string | undefined, fallback: TaskState = "running"): TaskState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    case "paused":
      return "waiting";
    case "pending":
      return "pending";
    case "running":
      return "running";
    default:
      return fallback;
  }
}

const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "stopped"]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function planDetailForTodos(input: unknown): PlanDetail | undefined {
  const todos = asRecord(input).todos;
  if (!Array.isArray(todos)) return undefined;
  const steps = todos.flatMap((raw) => {
    const todo = asRecord(raw);
    // `content` is the imperative form; `activeForm` is the present-continuous
    // one the SDK shows while a step runs. The imperative reads correctly in a
    // list whatever the step's state, so it is the one stored.
    const step = str(todo.content) ?? str(todo.activeForm);
    if (!step) return [];
    const status = todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "inProgress" : "pending";
    return [{ step, status } as const];
  });
  return steps.length > 0 ? { steps } : undefined;
}
