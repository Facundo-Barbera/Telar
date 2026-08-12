"use client";

import { useCallback, useSyncExternalStore } from "react";
import type {
  BrowserAgentPresence,
  BrowserRuntimeEvent,
} from "@/lib/browser-runtime-contract";

const PRESENCE_LINGER_MS = 2_200;

const presenceByScope = new Map<string, BrowserAgentPresence>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const presenceListeners = new Set<() => void>();
const runtimeListeners = new Set<(event: BrowserRuntimeEvent) => void>();

function emitPresence() {
  for (const listener of presenceListeners) listener();
}

export function publishBrowserRuntimeEvent(event: BrowserRuntimeEvent) {
  for (const listener of runtimeListeners) listener(event);
  if (!event.presence) return;

  const scopeKey = event.presence.scopeKey;
  if (!scopeKey) return;
  const clearTimer = clearTimers.get(scopeKey);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimers.delete(scopeKey);
  presenceByScope.set(scopeKey, event.presence);
  emitPresence();
  if (event.presence.status === "settling") {
    clearTimers.set(scopeKey, setTimeout(() => {
      presenceByScope.delete(scopeKey);
      clearTimers.delete(scopeKey);
      emitPresence();
    }, PRESENCE_LINGER_MS));
  }
}

export function publishDesktopBrowserPointer(event: {
  scopeKey: string;
  tabId: string;
  phase: "move" | "click";
  createdAt: string;
}) {
  const scopeKey = event.scopeKey;
  const currentPresence = presenceByScope.get(scopeKey);
  if (!currentPresence) return;
  const clearTimer = clearTimers.get(scopeKey);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimers.delete(scopeKey);
  presenceByScope.set(scopeKey, {
    ...currentPresence,
    status: "acting",
    tabId: event.tabId,
    phase: event.phase,
    lastActionAt: event.createdAt,
  });
  emitPresence();
}

export function subscribeBrowserRuntimeEvents(
  listener: (event: BrowserRuntimeEvent) => void,
) {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

function subscribePresence(listener: () => void) {
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

export function getBrowserAgentPresence(scopeKey: string) {
  return presenceByScope.get(scopeKey) ?? null;
}

export function useBrowserAgentPresence(scopeKey: string) {
  const getSnapshot = useCallback(
    () => getBrowserAgentPresence(scopeKey),
    [scopeKey],
  );
  return useSyncExternalStore(subscribePresence, getSnapshot, () => null);
}
