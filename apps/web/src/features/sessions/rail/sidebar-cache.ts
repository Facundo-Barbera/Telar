"use client";

import type { SidebarSession } from "../session-list";

const SIDEBAR_CACHE_KEY = "telar-sidebar-cache";
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

export function rememberRows(cache: SidebarCache, hostId: string, sessions: readonly SidebarSession[], now = Date.now()): SidebarCache {
  return { ...cache, [hostId]: { savedAt: now, sessions: sessions.slice(0, ROWS_PER_HOST) } };
}

export function forgetRows(cache: SidebarCache, hostId: string): SidebarCache {
  return Object.fromEntries(Object.entries(cache).filter(([key]) => key !== hostId));
}

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
  }
}
