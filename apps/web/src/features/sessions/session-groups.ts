import { useCallback, useEffect, useState } from "react";
import type { ProjectAvailability } from "@telar/engine-client";
import { sessionKey, type SidebarSession, type SessionListResult } from "./session-list";

const COLLAPSED_KEY = "telar:sidebar-collapsed-groups";

export function foldedAfter(
  current: ReadonlySet<string>,
  drawn: readonly string[],
  move: { kind: "toggle" | "others"; key: string } | { kind: "all" | "none" },
): Set<string> {
  const next = new Set(current);
  if (move.kind === "toggle") {
    if (next.has(move.key)) next.delete(move.key);
    else next.add(move.key);
    return next;
  }
  if (move.kind === "others") {
    for (const key of drawn) if (key !== move.key) next.add(key);
    next.delete(move.key);
    return next;
  }
  for (const key of drawn) {
    if (move.kind === "all") next.add(key);
    else next.delete(key);
  }
  return next;
}

export type CollapsedGroups = {
  collapsed: Set<string>;
  toggle: (key: string) => void;
  collapseOthers: (key: string, drawn: readonly string[]) => void;
  collapseAll: (drawn: readonly string[]) => void;
  expandAll: (drawn: readonly string[]) => void;
};

export function useCollapsedGroups(): CollapsedGroups {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setCollapsed(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const apply = useCallback((move: Parameters<typeof foldedAfter>[2], drawn: readonly string[] = []) => {
    setCollapsed((current) => {
      const next = foldedAfter(current, drawn, move);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
      }
      return next;
    });
  }, []);
  return {
    collapsed,
    toggle: useCallback((key: string) => apply({ kind: "toggle", key }), [apply]),
    collapseOthers: useCallback((key: string, drawn: readonly string[]) => apply({ kind: "others", key }, drawn), [apply]),
    collapseAll: useCallback((drawn: readonly string[]) => apply({ kind: "all" }, drawn), [apply]),
    expandAll: useCallback((drawn: readonly string[]) => apply({ kind: "none" }, drawn), [apply]),
  };
}

export type ProjectGroup = {
  key: string;
  projectId: string;
  hostId?: string;
  name: string;
  icon?: string;
  iconName?: string;
  hostName?: string;
  availability?: Exclude<ProjectAvailability, "available">;
  sessions: SidebarSession[];
};

function groupAvailability(sessions: readonly SidebarSession[]): Exclude<ProjectAvailability, "available"> | undefined {
  let agreed: Exclude<ProjectAvailability, "available"> | undefined;
  for (const session of sessions) {
    const state = session.projectAvailability;
    if (state === undefined || state === "available") return undefined;
    if (agreed !== undefined && agreed !== state) return undefined;
    agreed = state;
  }
  return agreed;
}

export type GroupedSessions = {
  attention: SidebarSession[];
  pinned: SidebarSession[];
  groups: ProjectGroup[];
};

export function projectGroupKey(session: Pick<SidebarSession, "projectId" | "hostId" | "projectRemote">): string {
  if (session.projectRemote) return `repo:${session.projectRemote}`;
  return session.hostId ? `${session.hostId}:${session.projectId ?? ""}` : (session.projectId ?? "");
}

export function dedupeAcrossHosts<T extends Pick<SidebarSession, "id" | "hostId">>(
  reads: readonly { daemonId?: string; sessions: readonly T[] }[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const read of reads) {
    for (const session of read.sessions) {
      if (read.daemonId) {
        const key = `${read.daemonId}:${session.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(session);
    }
  }
  return out;
}

function needsAttention(session: SidebarSession): boolean {
  return session.activity === "blocked";
}

export const PROJECT_GROUP_MIME = "application/x-telar-project-group";

export const SESSION_ROW_MIME = "application/x-telar-session-row";

export const PINNED_ROW_SCOPE = "pinned";

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

export function moveProjectGroup(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  return movedOrder(stored, drawn, dragged, target, position);
}

function movedOrder(
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

export function moveSessionRow(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  return movedOrder(stored, drawn, dragged, target, position);
}

export function orderSessions<T extends Pick<SidebarSession, "id" | "hostId">>(
  sessions: readonly T[],
  order: readonly string[] = [],
): T[] {
  if (order.length === 0) return [...sessions];
  const rank = new Map(order.map((key, index) => [key, index] as const));
  const placed: { at: number; session: T }[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    const at = rank.get(sessionKey(session));
    if (at === undefined) rest.push(session);
    else placed.push({ at, session });
  }
  placed.sort((left, right) => left.at - right.at);
  return [...placed.map((entry) => entry.session), ...rest];
}

export function moveProjectGroupStep(
  stored: readonly string[],
  drawn: readonly string[],
  key: string,
  direction: "up" | "down",
): string[] | undefined {
  const at = drawn.indexOf(key);
  if (at < 0) return undefined;
  const neighbour = drawn[direction === "up" ? at - 1 : at + 1];
  if (neighbour === undefined) return undefined;
  return moveProjectGroup(stored, drawn, key, neighbour, direction === "up" ? "above" : "below");
}

export type SessionOrders = {
  sessions?: Readonly<Record<string, readonly string[]>>;
  pinned?: readonly string[];
};

export function groupSessions(
  list: Pick<SessionListResult, "pinned" | "sessions">,
  order: readonly string[] = [],
  rows: SessionOrders = {},
): GroupedSessions {
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
      ...(session.projectIconName ? { iconName: session.projectIconName } : {}),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  };

  for (const session of list.pinned) place(session, true);
  for (const session of list.sessions) place(session, false);

  return {
    attention,
    pinned: orderSessions(pinned, rows.pinned),
    groups: orderProjectGroups([...groups.values()], order).map((group) => {
      const availability = groupAvailability(group.sessions);
      return {
        ...group,
        ...(availability ? { availability } : {}),
        sessions: orderSessions(group.sessions, rows.sessions?.[group.key]),
      };
    }),
  };
}

export function railRowsForCommandKeys(grouped: GroupedSessions, collapsed?: ReadonlySet<string>): SidebarSession[] {
  const rows = [...grouped.attention, ...grouped.pinned];
  for (const group of grouped.groups) {
    if (!collapsed?.has(group.key)) rows.push(...group.sessions);
  }
  return rows.slice(0, RAIL_JUMP_SLOTS.length);
}

export const RAIL_JUMP_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type RailJumpSlot = (typeof RAIL_JUMP_SLOTS)[number];

export function railJumpSlots(rows: readonly SidebarSession[]): Map<string, RailJumpSlot> {
  const slots = new Map<string, RailJumpSlot>();
  rows.forEach((session, index) => {
    const slot = RAIL_JUMP_SLOTS[index];
    if (slot !== undefined) slots.set(sessionKey(session), slot);
  });
  return slots;
}
