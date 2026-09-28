import path from "node:path";
import { isBackgroundWork, Task, type ProviderDriverKind } from "@telar/engine-client";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../platform/fs/state-paths";
import { sessionDir } from "./metadata";

export type TaskStopDelivery = { deliveryId: string; sessionId: string; providerTaskId: string; workerId: string; driver: ProviderDriverKind };

type CloseOptions = {
  runId?: string;
  runIds?: ReadonlySet<string>;
  includeBackground: boolean;
  onlyBackground?: boolean;
  state?: "failed" | "stopped";
};

function tasksFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "tasks.json");
}

/**
 * Each session's `tasks.json`, the only record that a cold session still has
 * background work running, plus the engine-wide queue of task stops owed to workers.
 */
export class SessionTasks {
  constructor(private readonly kernel: Kernel) {}

  read(sessionId: string): Map<string, Task> {
    const stored = this.kernel.readDocument(tasksFile(this.kernel.paths, sessionId));
    if (stored === undefined) return new Map();
    const parsed = Task.array().safeParse((stored as { tasks?: unknown }).tasks);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid task projection");
    return new Map(parsed.data.map((task) => [task.id, task]));
  }

  write(sessionId: string, tasks: Map<string, Task>): void {
    this.kernel.writeDocument(tasksFile(this.kernel.paths, sessionId), { version: STATE_VERSION, tasks: [...tasks.values()] });
  }

  /** A turn that ended takes its sub-agents with it; background work outlives its turn and is left alone. */
  closeOrphaned(sessionId: string, runId: string, at: number, failure: string): void {
    this.closeLive(sessionId, at, failure, { runId, includeBackground: false });
  }

  /**
   * Closes the live tasks the options select, as `failed` unless a person stopped
   * them. Idempotent: a task already settled is skipped.
   */
  closeLive(sessionId: string, at: number, failure: string, options: CloseOptions): Task[] {
    const tasks = this.read(sessionId);
    const closedTasks: Task[] = [];
    for (const [id, task] of tasks) {
      if (options.runId !== undefined && task.runId !== options.runId) continue;
      if (options.runIds !== undefined && !options.runIds.has(task.runId)) continue;
      if (!options.includeBackground && isBackgroundWork(task)) continue;
      if (options.onlyBackground && !isBackgroundWork(task)) continue;
      if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
      const closed: Task = { ...task, state: options.state ?? "failed", failure, updatedAt: at, completedAt: at };
      tasks.set(id, closed);
      this.kernel.appendEvent(sessionId, { type: "task.completed", task: closed }, task.runId);
      closedTasks.push(closed);
    }
    if (closedTasks.length > 0) this.write(sessionId, tasks);
    return closedTasks;
  }

  readStops(): TaskStopDelivery[] {
    const value = this.kernel.readDocument(this.kernel.paths.taskStops) ?? [];
    if (!Array.isArray(value) || value.some((row) => !row || typeof row.deliveryId !== "string" || typeof row.sessionId !== "string" ||
      typeof row.providerTaskId !== "string" || typeof row.workerId !== "string" || !["claude", "codex", "opencode"].includes(row.driver)))
      throw new EngineStateError("invalid_request", "invalid task-stop delivery store");
    return value;
  }

  writeStops(deliveries: TaskStopDelivery[]): void {
    this.kernel.writeDocument(this.kernel.paths.taskStops, deliveries);
  }

  /** Drops the stops `workerId` acknowledged and returns the ones it still owes. */
  stopsForWorker(workerId: string, acknowledged: string[]): Array<Omit<TaskStopDelivery, "workerId">> {
    return this.kernel.command("taskStopsForWorker", () => {
      const pending = this.readStops();
      const ack = new Set(acknowledged);
      const remaining = pending.filter((delivery) => delivery.workerId !== workerId || !ack.has(delivery.deliveryId));
      if (remaining.length !== pending.length) this.writeStops(remaining);
      return remaining.filter((delivery) => delivery.workerId === workerId).map(({ workerId: _owner, ...delivery }) => delivery);
    });
  }
}
