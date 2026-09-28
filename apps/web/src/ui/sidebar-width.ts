"use client";

import { useCallback, useSyncExternalStore } from "react";

export const SIDEBAR_RESIZE_MIN_WIDTH = 16 * 16;
export const APP_SIDEBAR_MAIN_MIN_WIDTH = 640;
export const APP_SIDEBAR_STORAGE_KEY = "app";

const KEY_PREFIX = "telar-sidebar:";

export type SidebarPrefs = {
  width: number | null;
  collapsed: boolean | null;
};

const NO_SIDEBAR_PREFS: SidebarPrefs = { width: null, collapsed: null };

export function clampSidebarWidth(width: number, minWidth: number, maxWidth: number): number {
  if (Number.isNaN(width)) return minWidth;
  return Math.max(minWidth, Math.min(width, maxWidth));
}

function resolveDragWidth(
  currentWidth: number,
  proposedWidth: number,
  minWidth: number,
  maxWidth: number,
  accept?: (nextWidth: number) => boolean,
): number {
  const nextWidth = clampSidebarWidth(proposedWidth, minWidth, maxWidth);
  if (accept && !accept(nextWidth)) return currentWidth;
  return nextWidth;
}

export function flushPendingSidebarWidth(
  currentWidth: number,
  pendingWidth: number,
  minWidth: number,
  maxWidth: number,
  accept?: (nextWidth: number) => boolean,
): number {
  return resolveDragWidth(currentWidth, pendingWidth, minWidth, maxWidth, accept);
}

export function keepsRoomForMain(
  currentWidth: number,
  nextWidth: number,
  availableWidth: number,
  mainMinWidth: number,
): boolean {
  return nextWidth <= currentWidth || availableWidth - nextWidth >= mainMinWidth;
}

function sanitizeSidebarPrefs(raw: unknown): SidebarPrefs {
  if (!raw || typeof raw !== "object") return NO_SIDEBAR_PREFS;
  const r = raw as Record<string, unknown>;
  const width =
    typeof r.width === "number" && Number.isFinite(r.width) && r.width > 0 ? r.width : null;
  const collapsed = typeof r.collapsed === "boolean" ? r.collapsed : null;
  if (width === null && collapsed === null) return NO_SIDEBAR_PREFS;
  return { width, collapsed };
}

function parseSidebarPrefs(raw: string | null): SidebarPrefs {
  if (!raw) return NO_SIDEBAR_PREFS;
  try {
    return sanitizeSidebarPrefs(JSON.parse(raw));
  } catch {
    return NO_SIDEBAR_PREFS;
  }
}

const cache = new Map<string, SidebarPrefs>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function getSidebarPrefs(key: string | null): SidebarPrefs {
  if (!key || typeof window === "undefined") return NO_SIDEBAR_PREFS;
  const hit = cache.get(key);
  if (hit) return hit;
  let parsed: SidebarPrefs;
  try {
    parsed = parseSidebarPrefs(window.localStorage.getItem(KEY_PREFIX + key));
  } catch {
    parsed = NO_SIDEBAR_PREFS;
  }
  cache.set(key, parsed);
  return parsed;
}

function write(key: string, next: SidebarPrefs) {
  cache.set(key, next);
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(next));
  } catch {
  }
  emit();
}

export function setSidebarWidth(key: string, width: number) {
  write(key, { ...getSidebarPrefs(key), width });
}

export function setSidebarCollapsed(key: string, collapsed: boolean) {
  write(key, { ...getSidebarPrefs(key), collapsed });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(KEY_PREFIX)) return;
    cache.set(e.key.slice(KEY_PREFIX.length), parseSidebarPrefs(e.newValue));
    emit();
  });
}

const getServerPrefs = () => NO_SIDEBAR_PREFS;

export function useSidebarPrefs(key: string | null): SidebarPrefs {
  const getSnapshot = useCallback(() => getSidebarPrefs(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerPrefs);
}
