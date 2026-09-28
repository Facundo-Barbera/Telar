import { z } from "zod";
import { Timestamp, type ProviderDriverKind, type TokenUsage } from "../protocol/common";

export type UsageResolution = "day" | "hour";

export type UsageBucket = {
  /** `YYYY-MM-DD` in the requested zone for days; the hour-start epoch ms as a decimal string for hours. */
  period: string;
  driver: ProviderDriverKind;
  model: string;
  tokens: TokenUsage;
  costUsd: number;
  /** Whether every record here has a cost, provider-reported or rate-priced. */
  priced: boolean;
  /** Records, not turns: one Claude assistant message or one Codex token count. */
  turns: number;
};

export type UsageSource = {
  provider: ProviderDriverKind;
  status: "ok" | "missing" | "failed";
  path: string;
  files: number;
  sessions: number;
};

export type UsageReport = {
  sinceMs: number;
  untilMs: number;
  resolution: UsageResolution;
  timeZone: string;
  buckets: UsageBucket[];
  sources: UsageSource[];
  /** When `unavailable`, costs the provider did not report are absent, not guessed. */
  pricing: "fresh" | "cached" | "unavailable";
  sessions: number;
  readAt: number;
};

export const UsageLimitSourceKind = z.enum(["cliproxy"]);
export type UsageLimitSourceKind = z.infer<typeof UsageLimitSourceKind>;

export const UsageLimitSource = z.object({
  id: z.string().min(1).max(64),
  kind: UsageLimitSourceKind,
  label: z.string().max(120).optional(),
  url: z.string().min(1).max(2048),
  /** Always `""` from a read. Send a non-empty value to replace the stored key. */
  managementKey: z.string().max(4096),
  keyRedacted: z.boolean().optional(),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UsageLimitSource = z.infer<typeof UsageLimitSource>;

export type UsageLimitWindow = {
  /** Stable within a driver: `five_hour`, `seven_day`, `primary`, `secondary`, or `model:<display name>`. */
  key: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
};

export type UsageLimitAccount = {
  id: string;
  driver: ProviderDriverKind;
  email?: string;
  plan?: string;
  windows: UsageLimitWindow[];
  error?: string;
};

export type UsageLimitSourceSnapshot = {
  id: string;
  kind: UsageLimitSourceKind;
  label: string;
  checkedAt: number;
  accounts: UsageLimitAccount[];
  error?: string;
};

export type UsageLimits = { sources: UsageLimitSourceSnapshot[]; readAt: number };
