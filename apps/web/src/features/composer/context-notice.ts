
export const CONTEXT_NOTICE_DEFAULT_PERCENT = 70;

export type ContextUsage = { contextUsed?: number | null; contextMax?: number | null };

export function contextShareOf(usage: ContextUsage | undefined): number {
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  if (!used || !max || max <= 0) return 0;
  return used / max;
}

export function contextNoticeDue(usage: ContextUsage | undefined, percent = CONTEXT_NOTICE_DEFAULT_PERCENT): boolean {
  return contextShareOf(usage) >= percent / 100;
}

export function normaliseContextNoticePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONTEXT_NOTICE_DEFAULT_PERCENT;
  return Math.min(100, Math.max(1, Math.round(value)));
}
