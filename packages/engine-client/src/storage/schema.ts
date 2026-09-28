import { z } from "zod";

export type StorageCategory =
  | "worktrees"
  | "journal"
  | "sessions"
  | "python"
  | "browser-profiles"
  | "usage"
  | "notes"
  | "dictation"
  | "run"
  | "diagnostics"
  | "settings"
  /** Attributed to nothing above, so the rows still sum to the total. */
  | "other";

export type StorageEntry = {
  category: StorageCategory;
  bytes: number;
  path: string;
  kind: "directory" | "file";
  status?: "measuring" | "partial";
  /** While `measuring`: how many of the row's parts have settled. */
  progress?: { measured: number; of: number };
};

export type StoreCopy = { root: string; files: number; bytes: number };

type PackageCacheStatus = { name: string; path: string; dedup: "different-device" | "unreachable" };

export type StorageReport = {
  root: string;
  total: number;
  entries: StorageEntry[];
  measuredAt: number;
  tookMs: number;
  partial: boolean;
  caches?: PackageCacheStatus[];
};

export type JournalReclaim = { before: number; after: number; deltas: number; starts: number; sessions: number; usage?: number };

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

export const RetentionPolicy = z.object({
  /** Days idle before a settled session's journal may go; `null` never sweeps. */
  idleAfterDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).nullable(),
  /** Where the journal is written before it is dropped; with none, nothing is deleted. */
  exportTo: z.string().min(1).nullable().default(null),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { idleAfterDays: null, exportTo: null };

export const RETENTION_BUCKET_DAYS = [7, 14, 30, 60] as const;

export type RetentionBucket = { days: number; sessions: number; events: number; bytes?: number };

export type JournalRetirement = { retired: number; skipped: number; events: number };

export const CLEANUP_INACTIVE_DAYS = [3, 7, 14, 30] as const;
export const CLEANUP_LOG_DAYS = [7, 30] as const;

export const CleanupPolicy = z.object({
  /** Release the checkout of a session inactive this many days. `null` is off. */
  inactiveDays: z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).nullable(),
  /** Release an idle session's checkout whose branch has nothing beyond the default branch. */
  unchanged: z.boolean(),
  /** Release the checkout of an archived session. */
  archived: z.boolean(),
  /** Delete rotated logs older than this many days. `null` is off. */
  logsDays: z.union([z.literal(7), z.literal(30)]).nullable(),
});
export type CleanupPolicy = z.infer<typeof CleanupPolicy>;

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = { inactiveDays: null, unchanged: false, archived: false, logsDays: null };

export const CleanupReport = z.object({
  at: z.number(),
  freedBytes: z.number().min(0),
  released: z.number().int().min(0),
  logs: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type CleanupReport = z.infer<typeof CleanupReport>;

export const CleanupState = z.object({
  policy: CleanupPolicy,
  last: CleanupReport.optional(),
  running: z.boolean(),
});
export type CleanupState = z.infer<typeof CleanupState>;
