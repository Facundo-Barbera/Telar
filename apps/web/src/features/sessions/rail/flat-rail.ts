import { useCallback, useEffect, useState } from "react";
import { foldedAfter, orderSessions } from "../session-groups";
import { sessionKey, type SessionListResult, type SidebarSession } from "../session-list";

export type FlatEntry = {
  session: SidebarSession;
  pinned: boolean;
  children: SidebarSession[];
};

export function parentKeyOf(session: Pick<SidebarSession, "id" | "hostId" | "startedFrom" | "assignments">): string | undefined {
  const first = [...(session.assignments ?? [])].sort((left, right) => left.receivedAt - right.receivedAt)[0];
  const parentId = session.startedFrom?.sessionId ?? first?.fromSessionId;
  if (!parentId || parentId === session.id) return undefined;
  return session.hostId ? `${session.hostId}:${parentId}` : parentId;
}

export function flattenSessions(list: Pick<SessionListResult, "pinned" | "sessions">, pinnedOrder: readonly string[] = []): FlatEntry[] {
  const pinned = orderSessions(list.pinned, pinnedOrder);
  const pinnedKeys = new Set(pinned.map(sessionKey));
  const rows: SidebarSession[] = [];
  const byKey = new Map<string, SidebarSession>();
  for (const session of [...pinned, ...list.sessions]) {
    const key = sessionKey(session);
    if (byKey.has(key)) continue;
    byKey.set(key, session);
    rows.push(session);
  }

  const rootOf = (session: SidebarSession): SidebarSession => {
    const start = sessionKey(session);
    const seen = new Set([start]);
    let current = session;
    for (;;) {
      if (pinnedKeys.has(sessionKey(current))) return current;
      const parentKey = parentKeyOf(current);
      const parent = parentKey ? byKey.get(parentKey) : undefined;
      if (!parent) return current;
      if (seen.has(sessionKey(parent))) return session;
      seen.add(sessionKey(parent));
      current = parent;
    }
  };

  const entries = new Map<string, FlatEntry>();
  const nested: { root: string; child: SidebarSession }[] = [];
  for (const session of rows) {
    const root = rootOf(session);
    const key = sessionKey(session);
    if (root === session) entries.set(key, { session, pinned: pinnedKeys.has(key), children: [] });
    else nested.push({ root: sessionKey(root), child: session });
  }
  for (const { root, child } of nested) entries.get(root)?.children.push(child);
  return [...entries.values()];
}

function childNeedsYou(session: Pick<SidebarSession, "activity">): boolean {
  return session.activity === "blocked" || session.activity === "waiting";
}

const isWorking = (session: Pick<SidebarSession, "activity">) =>
  session.activity === "working" || session.activity === "queued" || session.activity === "monitoring";

export type ChildSummary = {
  label: string;
  needsYou: number;
  surfaced: SidebarSession[];
};

export function summarizeChildren(children: readonly SidebarSession[], activeSessionId?: string): ChildSummary {
  const working = children.filter(isWorking).length;
  const needsYou = children.filter(childNeedsYou).length;
  const parts = [`${children.length} ${children.length === 1 ? "session" : "sessions"}`];
  if (working > 0) parts.push(`${working} working`);
  if (needsYou > 0) parts.push(`${needsYou} ${needsYou === 1 ? "needs" : "need"} you`);
  return {
    label: parts.join(" · "),
    needsYou,
    surfaced: children.filter((child) => childNeedsYou(child) || sessionKey(child) === activeSessionId),
  };
}

export function flatRailRows(entries: readonly FlatEntry[], expanded: ReadonlySet<string>, activeSessionId?: string): SidebarSession[] {
  const rows: SidebarSession[] = [];
  for (const entry of entries) {
    rows.push(entry.session);
    if (entry.children.length === 0) continue;
    rows.push(...(expanded.has(sessionKey(entry.session)) ? entry.children : summarizeChildren(entry.children, activeSessionId).surfaced));
  }
  return rows;
}

const EXPANDED_KEY = "telar:sidebar-expanded-parents";

export function useExpandedParents(): { expanded: Set<string>; toggle: (key: string) => void } {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
        if (Array.isArray(parsed)) setExpanded(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = foldedAfter(current, [], { kind: "toggle", key });
      try {
        window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
      }
      return next;
    });
  }, []);
  return { expanded, toggle };
}
