"use client";

import { useCallback, useEffect, useState } from "react";

const FILTER_KEY = "telar:sidebar-project-filter";

export function projectFilterKey(projectId: string | undefined, hostId?: string): string {
  return `${hostId ?? "local"}:${projectId ?? ""}`;
}

export function appliedProjectFilter(selected: ReadonlySet<string>, known: readonly string[]): Set<string> {
  return new Set(known.filter((key) => selected.has(key)));
}

export function filterSessionsToProjects<T extends { projectId?: string; hostId?: string }>(
  sessions: readonly T[],
  applied: ReadonlySet<string>,
): T[] {
  if (applied.size === 0) return [...sessions];
  return sessions.filter((session) => applied.has(projectFilterKey(session.projectId, session.hostId)));
}

export function toggledProjectFilter(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export type ProjectFilter = {
  selected: Set<string>;
  toggle: (key: string) => void;
  clear: () => void;
};

export function useProjectFilter(): ProjectFilter {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(FILTER_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setSelected(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const write = useCallback((next: Set<string>) => {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify([...next]));
    } catch {
    }
    return next;
  }, []);
  return {
    selected,
    toggle: useCallback((key: string) => setSelected((current) => write(toggledProjectFilter(current, key))), [write]),
    clear: useCallback(() => setSelected(() => write(new Set())), [write]),
  };
}
