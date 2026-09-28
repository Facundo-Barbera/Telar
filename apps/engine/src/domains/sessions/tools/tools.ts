import { z } from "zod";
import { err, failure, json, type ToolFactory } from "../../agent-tools";
import { controlTools } from "./control";
import { messagingTools } from "./messaging";
import { readTools, statusTools } from "./read";
import { NO_SESSION_TO_SCHEDULE, type SessionsCapability } from "./shared";
import { wakeTools } from "./wakes";

export function sessionsTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    ...messagingTools(tool, capability),
    ...readTools(tool, capability),
    ...statusTools(tool, capability),
    ...controlTools(tool, capability),
    ...wakeTools(tool, capability),
    tool(
      "sessions_schedule",
      "Run a prompt in THIS session on a clock — every N minutes, or at a fixed local time on chosen weekdays. A missed run is re-aimed rather than fired late, and nothing fires while Telar is closed.",
      {
        prompt: z.string().min(1).describe("What to send to this session when the schedule comes due."),
        everyMinutes: z.number().int().min(1).optional().describe("Run every N minutes. Use this OR hour/minute, not both."),
        hour: z.number().int().min(0).max(23).optional().describe("Local hour for a fixed-time schedule."),
        minute: z.number().int().min(0).max(59).optional().describe("Local minute for a fixed-time schedule."),
        weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("0 is Sunday. Omit for every day."),
        zone: z.string().optional().describe("IANA zone name, e.g. Europe/Madrid. Defaults to this machine's."),
      },
      async (args) => {
        if (!capability.self) return err(NO_SESSION_TO_SCHEDULE);
        if (!capability.putSchedule) return err("This engine cannot schedule.");
        const fixed = args.hour !== undefined;
        if (fixed && args.everyMinutes !== undefined) return err("A schedule is either every N minutes or at a fixed time, never both.");
        if (!fixed && args.everyMinutes === undefined) return err("A schedule needs either everyMinutes or an hour.");
        const rule = fixed
          ? ({ kind: "fixed" as const, hour: Number(args.hour), minute: Number(args.minute ?? 0), weekdays: args.weekdays ?? [] })
          : ({ kind: "interval" as const, everyMs: Number(args.everyMinutes) * 60_000 });
        try {
          const row = await capability.putSchedule({
            sessionId: capability.self.sessionId,
            prompt: String(args.prompt),
            rule,
            zone: String(args.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
          });
          return json({
            scheduleId: row.id,
            nextRunAt: row.nextRunAt,
            zone: row.zone,
            note: "Nothing fires while Telar is closed. A run missed by more than five minutes is skipped and re-aimed at the next occurrence rather than fired late, and the row says so.",
          });
        } catch (error) {
          return err(`Could not schedule that: ${failure(error)}`);
        }
      },
    ),
  ];
}
