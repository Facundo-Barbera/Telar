import type { EngineTransport } from "../platform/transport";
import type { Schedule, ScheduleRule } from "./schema";

export const schedulesClient = {
  schedules(this: EngineTransport, sessionId?: string): Promise<{ schedules: Schedule[] }> {
    return this.request("GET", `/v2/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
  },

  putSchedule(
    this: EngineTransport,
    input: { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean },
  ): Promise<{ schedule: Schedule }> {
    return this.request("POST", "/v2/schedules", input);
  },

  deleteSchedule(this: EngineTransport, id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/schedules/${encodeURIComponent(id)}`);
  },
};
