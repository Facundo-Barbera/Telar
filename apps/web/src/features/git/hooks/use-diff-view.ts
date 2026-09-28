"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { DiffLayout } from "../components/diff-code-view";

const STORAGE_KEY = "telar:diff-view";

export type DiffView = {
  layout: DiffLayout;
  wrap: boolean;
  ignoreWhitespace: boolean;
  tree: boolean;
};

export const DEFAULT_DIFF_VIEW: DiffView = { layout: "stacked", wrap: false, ignoreWhitespace: false, tree: true };

export function parseDiffView(raw: string | null): DiffView {
  if (!raw) return DEFAULT_DIFF_VIEW;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DIFF_VIEW;
    const record = parsed as Record<string, unknown>;
    return {
      layout: record.layout === "split" ? "split" : "stacked",
      wrap: record.wrap === true,
      ignoreWhitespace: record.ignoreWhitespace === true,
      tree: record.tree !== false,
    };
  } catch {
    return DEFAULT_DIFF_VIEW;
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let cache: { raw: string | null; value: DiffView } | undefined;

function read(): DiffView {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the defaults stand in.
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseDiffView(raw) };
  return cache.value;
}

function write(patch: Partial<DiffView>): void {
  const next = { ...read(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    cache = { raw: null, value: next };
  }
  for (const listener of listeners) listener();
}

export function useDiffView(): { view: DiffView; setView: (patch: Partial<DiffView>) => void } {
  const view = useSyncExternalStore(subscribe, read, () => DEFAULT_DIFF_VIEW);
  const setView = useCallback((patch: Partial<DiffView>) => write(patch), []);
  return useMemo(() => ({ view, setView }), [view, setView]);
}
