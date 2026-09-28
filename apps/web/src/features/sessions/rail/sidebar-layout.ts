"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayout, type SidebarMode } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";

const api = createEngineApi(hostFetcher(LOCAL_HOST_ID));

const CHANGED = "telar:sidebar-layout";

function announce(layout: SidebarLayout): void {
  window.dispatchEvent(new CustomEvent<SidebarLayout>(CHANGED, { detail: layout }));
}

export function sameSidebarLayout(left: SidebarLayout, right: SidebarLayout): boolean {
  const same = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((key, at) => key === b[at]);
  if (!same(left.projectOrder, right.projectOrder) || !same(left.pinnedOrder, right.pinnedOrder)) return false;
  if ((left.mode ?? "grouped") !== (right.mode ?? "grouped")) return false;
  const groups = left.sessionOrder ?? {};
  const others = right.sessionOrder ?? {};
  const keys = new Set([...Object.keys(groups), ...Object.keys(others)]);
  for (const key of keys) if (!same(groups[key], others[key])) return false;
  return true;
}

let writing = 0;

export function observeSidebarLayout(layout: SidebarLayout | undefined): void {
  if (!layout || writing > 0 || typeof window === "undefined") return;
  announce(layout);
}

export type SidebarLayoutHandle = {
  order: readonly string[];
  sessionOrder: Readonly<Record<string, readonly string[]>>;
  pinnedOrder: readonly string[];
  loading: boolean;
  setOrder: (next: string[]) => Promise<void>;
  setSessionOrder: (groupKey: string, next: string[]) => Promise<void>;
  setPinnedOrder: (next: string[]) => Promise<void>;
  mode: SidebarMode;
  setMode: (next: SidebarMode) => Promise<void>;
};

export function useSidebarLayout(): SidebarLayoutHandle {
  const [layout, setLayout] = useState<SidebarLayout>(DEFAULT_SIDEBAR_LAYOUT);
  const [loading, setLoading] = useState(true);
  const latest = useRef<SidebarLayout>(DEFAULT_SIDEBAR_LAYOUT);
  useEffect(() => {
    latest.current = layout;
  });

  useEffect(() => {
    const task = window.setTimeout(() => {
      void api
        .sidebarLayout()
        .then((result) => setLayout(result.layout))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<SidebarLayout>).detail;
      if (next && !sameSidebarLayout(next, latest.current)) setLayout(next);
    };
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const patch = useCallback(async (change: Partial<SidebarLayout>) => {
    const previous = latest.current;
    setLayout({ ...previous, ...change });
    writing += 1;
    try {
      const result = await api.setSidebarLayout(change as Parameters<typeof api.setSidebarLayout>[0]);
      setLayout(result.layout);
      announce(result.layout);
    } catch {
      setLayout(previous);
    } finally {
      writing -= 1;
    }
  }, []);

  const setOrder = useCallback((next: string[]) => patch({ projectOrder: next }), [patch]);
  const setPinnedOrder = useCallback((next: string[]) => patch({ pinnedOrder: next }), [patch]);
  const setMode = useCallback((next: SidebarMode) => patch({ mode: next }), [patch]);
  const setSessionOrder = useCallback(
    (groupKey: string, next: string[]) => patch({ sessionOrder: { ...(latest.current.sessionOrder ?? {}), [groupKey]: next } }),
    [patch],
  );

  return {
    order: layout.projectOrder ?? [],
    sessionOrder: layout.sessionOrder ?? {},
    pinnedOrder: layout.pinnedOrder ?? [],
    loading,
    setOrder,
    setSessionOrder,
    setPinnedOrder,
    mode: layout.mode ?? "grouped",
    setMode,
  };
}
