/**
 * The context notice is due once a session has used `percent` of its model's window. A share,
 * not a token count, so it means the same on any window size. It only informs; it compacts nothing.
 */

export const CONTEXT_NOTICE_DEFAULT_PERCENT = 70;

export type ContextUsage = { contextUsed?: number | null; contextMax?: number | null };

/** The share of the window in use, or 0 (never NaN) when unreported. */
export function contextShareOf(usage: ContextUsage | undefined): number {
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  if (!used || !max || max <= 0) return 0;
  return used / max;
}

/** An unknown reading never fires: `contextShareOf` returns 0 for it. */
export function contextNoticeDue(usage: ContextUsage | undefined, percent = CONTEXT_NOTICE_DEFAULT_PERCENT): boolean {
  return contextShareOf(usage) >= percent / 100;
}

/** A stored percentage clamped to 1–100, or the default; the one normaliser for composer and settings. */
export function normaliseContextNoticePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONTEXT_NOTICE_DEFAULT_PERCENT;
  return Math.min(100, Math.max(1, Math.round(value)));
}
