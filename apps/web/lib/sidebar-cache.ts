"use client";

/**
 * THE RAIL'S LAST READ, per Mac — so a host that stops answering keeps its
 * rows on screen, dimmed under a line that says so, instead of vanishing.
 *
 * localStorage rather than IndexedDB: a rail is a few hundred rows of titles
 * and timestamps, a handful of kilobytes, and it is read synchronously on
 * the first client render — the same reason drafts live there. Capped per
 * host so a long history cannot grow it past what that store is for.
 */

import type { SidebarSession } from "./session-list";

export const SIDEBAR_CACHE_KEY = "telar-sidebar-cache";
export const ROWS_PER_HOST = 200;

export type SidebarCache = Record<string, { savedAt: number; sessions: SidebarSession[] }>;

export function parseSidebarCache(raw: string | null): SidebarCache {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SidebarCache = {};
    for (const [hostId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { savedAt, sessions } = entry as { savedAt?: unknown; sessions?: unknown };
      if (typeof savedAt !== "number" || !Array.isArray(sessions)) continue;
      out[hostId] = { savedAt, sessions: sessions as SidebarSession[] };
    }
    return out;
  } catch {
    return {};
  }
}

/** One host's rows replaced whole; the others untouched. */
export function rememberRows(cache: SidebarCache, hostId: string, sessions: readonly SidebarSession[], now = Date.now()): SidebarCache {
  return { ...cache, [hostId]: { savedAt: now, sessions: sessions.slice(0, ROWS_PER_HOST) } };
}

export function forgetRows(cache: SidebarCache, hostId: string): SidebarCache {
  return Object.fromEntries(Object.entries(cache).filter(([key]) => key !== hostId));
}

/** The rows to show for a host that did not answer: its last read, each
 *  stamped `stale` so the row can dim itself. Nothing when never read. */
export function staleRows(cache: SidebarCache, hostId: string): SidebarSession[] {
  const entry = cache[hostId];
  if (!entry) return [];
  return entry.sessions.map((session) => ({ ...session, stale: entry.savedAt }));
}

export function readSidebarCache(): SidebarCache {
  try {
    return parseSidebarCache(window.localStorage.getItem(SIDEBAR_CACHE_KEY));
  } catch {
    return {};
  }
}

export function writeSidebarCache(cache: SidebarCache): void {
  try {
    window.localStorage.setItem(SIDEBAR_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Full or disabled storage loses the cache, never the rail.
  }
}
