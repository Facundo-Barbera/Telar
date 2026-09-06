/**
 * The Work surface rail's arrangement of the live list: attention first,
 * pinned next, then the remaining active rows grouped by project.
 *
 * Pure. Takes `deriveSessionList`'s output so paging, search, scope, the
 * survivor rule and the shelves stay exactly the classic rail's. Every session
 * appears once: a blocked row lives in `attention` and nowhere else, a pinned
 * one in `pinned`, everything else under its project.
 */
import { useCallback, useEffect, useState } from "react";
import { sessionKey, type SidebarSession, type SessionListResult } from "./session-list";

const COLLAPSED_KEY = "telar:sidebar-collapsed-groups";

/** Which project groups are folded, by host-qualified key, persisted per client. */
export function useCollapsedGroups(): { collapsed: Set<string>; toggle: (key: string) => void } {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setCollapsed(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
        // Unreadable store: every group starts open.
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Quota or private mode: the fold lives for this page only.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

export type ProjectGroup = {
  /** Host-qualified, because two Macs can register the same project id. */
  key: string;
  projectId: string;
  hostId?: string;
  name: string;
  icon?: string;
  hostName?: string;
  sessions: SidebarSession[];
};

export type GroupedSessions = {
  attention: SidebarSession[];
  pinned: SidebarSession[];
  groups: ProjectGroup[];
};

export function projectGroupKey(session: Pick<SidebarSession, "projectId" | "hostId">): string {
  return session.hostId ? `${session.hostId}:${session.projectId ?? ""}` : (session.projectId ?? "");
}

/** Blocked is the engine's own "waiting on you" — the only attention state the rail can honestly claim. */
export function needsAttention(session: SidebarSession): boolean {
  return session.activity === "blocked";
}

export function groupSessions(list: Pick<SessionListResult, "pinned" | "sessions">): GroupedSessions {
  const attention: SidebarSession[] = [];
  const pinned: SidebarSession[] = [];
  const groups = new Map<string, ProjectGroup>();
  const seen = new Set<string>();

  const place = (session: SidebarSession, isPinned: boolean) => {
    const id = sessionKey(session);
    if (seen.has(id)) return;
    seen.add(id);
    if (needsAttention(session)) return attention.push(session);
    if (isPinned) return pinned.push(session);
    if (!session.projectId) return; // A project-less row is not one of these groups.
    const key = projectGroupKey(session);
    const group = groups.get(key) ?? {
      key,
      projectId: session.projectId,
      ...(session.hostId ? { hostId: session.hostId } : {}),
      ...(session.hostName ? { hostName: session.hostName } : {}),
      name: session.projectName ?? session.projectId,
      ...(session.projectIcon ? { icon: session.projectIcon } : {}),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  };

  for (const session of list.pinned) place(session, true);
  for (const session of list.sessions) place(session, false);

  return { attention, pinned, groups: [...groups.values()] };
}
