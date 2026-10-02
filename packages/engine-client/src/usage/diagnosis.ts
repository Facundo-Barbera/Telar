import { z } from "zod";
import type { TokenUsage } from "../protocol/common";

export type UsageDigestWindow = "24h" | "7d" | "30d";

export type UsageDigestTotals = {
  tokens: TokenUsage;
  costUsd: number;
  turns: number;
  sessions: number;
  /** cacheRead ÷ (input + cacheRead + cacheCreate). */
  cacheHit: number;
};

/** A session as the digest names it: `s1…sN` by tokens, never its id or title. */
export type UsageDigestSession = {
  id: string;
  project?: string;
  driver: string;
  model: string;
  effort?: string;
  longContext: boolean;
  tokens: TokenUsage;
  costUsd: number;
  turns: number;
  avgTokensPerTurn: number;
  maxTokensPerTurn: number;
  contextUsed?: number;
  contextMax?: number;
  /** Turn counts by what started them: user, session, schedule, restart, provider. */
  origins: Record<string, number>;
  compactions: number;
  largeToolOutputs: number;
  providerWaits: { apiRetry: number; rateLimit: number; noResponse: number };
  startedBy?: string;
  ageDays: number;
};

export type UsageDigestTree = { root: string; sessions: number; depth: number; tokens: number; costUsd: number; models: Record<string, number> };

export type UsageDigestSchedule = { session?: string; periodMinutes?: number; enabled: boolean; runs: number; tokens: number };

export type UsageSignal = { id: string; value: number; threshold: number; sessions?: string[] };

export type UsageDigest = {
  version: 1;
  createdAt: number;
  windows: Record<UsageDigestWindow, { totals: UsageDigestTotals; byModel: Array<{ model: string; tokens: number; costUsd: number; turns: number }> }>;
  /** Provider logs over 30 days, Telar or not; the gap to Telar's own totals is use outside Telar. */
  providerLogs: Array<{ provider: string; tokens: number; costUsd: number; telarTokens: number }>;
  topSessions: UsageDigestSession[];
  trees: UsageDigestTree[];
  schedules: UsageDigestSchedule[];
  contextHistogram: Record<"under50k" | "50kTo200k" | "200kTo1m" | "over1m", number>;
  config: Record<string, string | number | boolean>;
  signals: UsageSignal[];
};

export const USAGE_FIX_SETTINGS = [
  "new-sessions-model",
  "new-sessions-effort",
  "continue-after-reset",
  "settle-delegated",
  "generated-text-model",
  "compaction",
  "schedules",
  "mcp-servers",
  "none",
] as const;

const short = (max: number) => z.string().max(max);

export const UsageDiagnosisReport = z.object({
  window: z.enum(["24h", "7d", "30d"]),
  summary: short(400),
  topConsumers: z.array(z.object({ id: z.string().regex(/^s\d{1,3}$/), share: z.number().min(0).max(1), reason: short(160) })).max(5),
  findings: z
    .array(
      z.object({
        signal: z.string().min(1).max(40),
        severity: z.enum(["high", "medium", "low"]),
        title: short(80),
        why: short(400),
        evidence: z.array(z.object({ metric: short(60), value: z.number() })).max(6),
        fix: z.object({ setting: z.enum(USAGE_FIX_SETTINGS), action: short(240) }),
        estSavingsPct: z.number().min(0).max(100).optional(),
      }),
    )
    .max(6),
});
export type UsageDiagnosisReport = z.infer<typeof UsageDiagnosisReport>;

export type UsageDiagnosisState = "running" | "ready" | "failed";

export type UsageDiagnosis = {
  id: string;
  sessionId: string;
  runId: string;
  state: UsageDiagnosisState;
  createdAt: number;
  finishedAt?: number;
  model?: string;
  promptVersion: number;
  /** The digest's headline numbers, shown with the report. */
  totals?: UsageDigestTotals;
  report?: UsageDiagnosisReport;
  /** True when the agent's answer failed validation and the report was built from signals alone. */
  fallback?: boolean;
  error?: string;
  /** Local display only, never sent: `s3` → its session title. */
  names?: Record<string, string>;
};
