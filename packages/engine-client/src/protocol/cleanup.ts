/**
 * engine protocol v2 — AUTOMATIC CLEANUP, Settings → Storage.
 *
 * Four switches, global to this engine, all off by default. A worktree is
 * never deleted outright: it is RELEASED (`SessionWorkspace.released`) — the
 * directory goes, the branch and conversation stay, and reopening the session
 * brings the checkout back. Nothing is touched that has uncommitted changes,
 * unpushed commits, a turn in flight or a live process, or that Telar did not
 * create.
 */
import { z } from "zod";

export const CLEANUP_INACTIVE_DAYS = [3, 7, 14, 30] as const;
export const CLEANUP_LOG_DAYS = [7, 30] as const;

export const CleanupPolicy = z.object({
  /** Release the checkout of a session inactive this many days. `null` is off. */
  inactiveDays: z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).nullable(),
  /**
   * Release the checkout of an idle session whose branch has no commits
   * beyond the default branch — nothing in it that is not already there.
   */
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
  /** Measured with `du` before each release, so it is an apparent figure. */
  freedBytes: z.number().min(0),
  released: z.number().int().min(0),
  logs: z.number().int().min(0),
  /** Candidates left alone because one of the fixed rules refused them. */
  skipped: z.number().int().min(0),
});
export type CleanupReport = z.infer<typeof CleanupReport>;

export const CleanupState = z.object({
  policy: CleanupPolicy,
  last: CleanupReport.optional(),
  /** A sweep is going right now. */
  running: z.boolean(),
});
export type CleanupState = z.infer<typeof CleanupState>;
