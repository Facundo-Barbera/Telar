export type ScheduleRule =
  | { kind: "interval"; everyMs: number }
  | { kind: "fixed"; hour: number; minute: number; weekdays: number[] };

export type Schedule = {
  id: string;
  /** The session whose composer the prompt is submitted to. */
  sessionId: string;
  prompt: string;
  rule: ScheduleRule;
  zone: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  lastRunStatus?: "fired" | "skipped";
  lastSkippedAt?: number;
};
