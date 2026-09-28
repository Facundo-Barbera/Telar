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
