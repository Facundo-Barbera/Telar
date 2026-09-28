import crypto from "node:crypto";
import type { ScheduleRow } from "../../platform/db/tables";
import { EngineStateError, type Kernel } from "../../platform/kernel";
import { decideSchedule, nextOccurrence, usableZone, type ScheduleRule } from "./rules";

export type ScheduleHost = {
  requireSession(sessionId: string): void;
  submitTurn(sessionId: string, input: { runId: string; input: string; origin: "schedule"; scheduleOrigin: { scheduleId: string; dueAt: number } }): unknown;
  /** A session's `scheduled` state and wake are read off these rows, which live outside `writeDocument`. */
  bumpList(): void;
};

export type ScheduleInput = { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean };

export class ScheduleBook {
  constructor(
    private readonly kernel: Kernel<unknown>,
    private readonly host: ScheduleHost,
  ) {}

  /** Deadline-driven, never catch-up: five seconds of lag and five days of sleep take the same path. */
  sweep(): string[] {
    const now = this.kernel.now();
    const acted: string[] = [];
    for (const row of this.kernel.executionStore.dueSchedules(now)) {
      try {
        const decision = decideSchedule(row.rule, row.zone, row.nextRunAt, now);
        if (!decision.fire) {
          this.write({ ...row, nextRunAt: decision.nextRunAt, lastRunStatus: "skipped", lastSkippedAt: decision.skipped ?? row.nextRunAt });
          acted.push(row.id);
          continue;
        }
        const runId = `run_sched_${row.id}_${row.nextRunAt}`;
        this.host.submitTurn(row.sessionId, { runId, input: row.prompt, origin: "schedule", scheduleOrigin: { scheduleId: row.id, dueAt: row.nextRunAt } });
        this.write({ ...row, nextRunAt: decision.nextRunAt, lastRunAt: now, lastRunId: runId, lastRunStatus: "fired" });
        acted.push(row.id);
      } catch {
        // The session is gone or refused the turn: disable, parked past now so re-enabling does not refire it.
        try {
          this.write({ ...row, enabled: false, nextRunAt: Math.max(row.nextRunAt, now) + 1 });
        } catch {
          /* the store itself is unhappy; the next sweep tries again */
        }
      }
    }
    return acted;
  }

  nextWake(sessionId: string): number | undefined {
    return this.list(sessionId).filter((schedule) => schedule.enabled).reduce<number | undefined>((soonest, schedule) => (soonest === undefined || schedule.nextRunAt < soonest ? schedule.nextRunAt : soonest), undefined);
  }

  list(sessionId?: string): ScheduleRow[] {
    return this.kernel.executionStore.listSchedules(sessionId);
  }

  read(id: string): ScheduleRow | undefined {
    return this.kernel.executionStore.readSchedule(id);
  }

  /** The first `nextRunAt` is computed here: a caller that could name it could aim a row at the past. */
  put(input: ScheduleInput): ScheduleRow {
    if (!input.prompt.trim()) throw new EngineStateError("invalid_request", "a schedule needs a prompt");
    this.host.requireSession(input.sessionId);
    const now = this.kernel.now();
    const existing = input.id ? this.read(input.id) : undefined;
    const row: ScheduleRow = {
      id: input.id ?? `sched_${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      prompt: input.prompt,
      rule: input.rule,
      zone: usableZone(input.zone),
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      nextRunAt: nextOccurrence(input.rule, input.zone, now),
      ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
      ...(existing?.lastRunId === undefined ? {} : { lastRunId: existing.lastRunId }),
      ...(existing?.lastRunStatus === undefined ? {} : { lastRunStatus: existing.lastRunStatus }),
      ...(existing?.lastSkippedAt === undefined ? {} : { lastSkippedAt: existing.lastSkippedAt }),
    };
    this.write(row);
    return row;
  }

  delete(id: string): boolean {
    const deleted = this.kernel.executionStore.deleteSchedule(id);
    if (deleted) this.host.bumpList();
    return deleted;
  }

  private write(row: ScheduleRow): void {
    this.kernel.executionStore.writeSchedule(row);
    this.host.bumpList();
  }
}
