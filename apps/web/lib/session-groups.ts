/**
 * The Work surface rail's arrangement of the live list: attention first,
 * pinned next, then the remaining active rows grouped by project.
 *
 * Pure. Takes `deriveSessionList`'s output so paging, search, scope, the
 * survivor rule and the shelves stay exactly the classic rail's. Every session
 * appears once: a blocked row lives in `attention` and nowhere else, a pinned
 * one in `pinned`, everything else under its project.
 *
 * WHERE A GROUP SITS IS A DECISION, NOT A SIDE EFFECT. The groups used to come
 * out in the order their newest conversation was created, so starting one
 * hoisted its project to the top and every other group shifted under the
 * pointer — the one thing a list you navigate by position must not do. Now a
 * group sits where the reader dragged it (`SidebarLayout.projectOrder`, on the
 * engine), and a group nobody has placed falls in after the placed ones,
 * alphabetically. Nothing about a conversation moves its project.
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

/** The drag's own type, so a file or a reference dropped on a group header is
 *  not mistaken for a group. Vendor-prefixed per RFC 6839, like `REFERENCE_MIME`. */
export const PROJECT_GROUP_MIME = "application/x-telar-project-group";

/**
 * Place the groups: the ones the reader has arranged first, in that order,
 * then the rest alphabetically. Two groups with one name — the same project
 * registered on this Mac and a paired one — put this Mac's first, so the copy
 * that says where it lives is the one wearing the badge.
 */
export function orderProjectGroups(groups: readonly ProjectGroup[], order: readonly string[] = []): ProjectGroup[] {
  const rank = new Map(order.map((key, index) => [key, index] as const));
  return [...groups].sort((left, right) => {
    const leftRank = rank.get(left.key);
    const rightRank = rank.get(right.key);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      Number(Boolean(left.hostId)) - Number(Boolean(right.hostId)) ||
      (left.hostName ?? "").localeCompare(right.hostName ?? "") ||
      left.key.localeCompare(right.key)
    );
  });
}

/**
 * The order after a drop: `dragged` lands above or below `target` in the list
 * as DRAWN, and the whole drawn list is what gets written — so every group on
 * screen keeps the place it had, not only the one that moved. A group drawn
 * for the first time is thereby placed too, which is what stops it drifting
 * once somebody has arranged anything.
 *
 * KEYS THE RAIL IS NOT DRAWING RIGHT NOW — a paired Mac that is away, a project
 * with nothing live — keep their slot relative to the ones it is, rather than
 * being pruned by a drag that had nothing to do with them.
 */
export function moveProjectGroup(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  const without = drawn.filter((key) => key !== dragged);
  const anchor = without.indexOf(target);
  if (dragged === target || anchor < 0 || !drawn.includes(dragged)) return [...drawn];
  const at = anchor + (position === "below" ? 1 : 0);
  const next = [...without.slice(0, at), dragged, ...without.slice(at)];
  let after = -1;
  for (const key of stored) {
    const index = next.indexOf(key);
    if (index >= 0) {
      after = index;
      continue;
    }
    next.splice(after + 1, 0, key);
    after += 1;
  }
  return next;
}

export function groupSessions(list: Pick<SessionListResult, "pinned" | "sessions">, order: readonly string[] = []): GroupedSessions {
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

  return { attention, pinned, groups: orderProjectGroups([...groups.values()], order) };
}
