"use client";

// Per-session right-panel UI state. This is deliberately a plain external
// store: panel tabs are browser preferences, not engine state, and this app's
// established contract is subscribe + snapshot + useSyncExternalStore rather
// than a global state dependency.

import { useCallback, useMemo, useSyncExternalStore } from "react";

export const RIGHT_PANEL_STORAGE_KEY = "telar:right-panel";
export const RIGHT_PANEL_SCHEMA_VERSION = 1;
export const RIGHT_PANEL_SESSION_CAP = 24;

export type GitPanelTab = {
  id: "git";
  kind: "git";
  title: "Git";
};

export type BrowserPanelTab = {
  id: string;
  kind: "browser";
  title: string;
  url: string;
};

export type RightPanelTab = GitPanelTab | BrowserPanelTab;

export type RightPanelSession = {
  tabs: RightPanelTab[];
  activeTabId: string | null;
  open: boolean;
  touchedAt: number;
};

export type RightPanelPayload = {
  version: typeof RIGHT_PANEL_SCHEMA_VERSION;
  sessions: Record<string, RightPanelSession>;
};

export const DEFAULT_GIT_TAB: GitPanelTab = { id: "git", kind: "git", title: "Git" };
export const DEFAULT_RIGHT_PANEL_SESSION: RightPanelSession = {
  tabs: [DEFAULT_GIT_TAB],
  activeTabId: DEFAULT_GIT_TAB.id,
  // Keep the workspace quiet until the user asks for Git or Browser. This also
  // avoids mounting a second Git reader on every session navigation.
  open: false,
  touchedAt: 0,
};
export const EMPTY_RIGHT_PANEL_PAYLOAD: RightPanelPayload = {
  version: RIGHT_PANEL_SCHEMA_VERSION,
  sessions: {},
};

function sanitizeTab(raw: unknown): RightPanelTab | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "git") return DEFAULT_GIT_TAB;
  if (
    r.kind === "browser" &&
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.title === "string" &&
    r.title.length > 0 &&
    typeof r.url === "string" &&
    r.url.length > 0
  ) {
    return { id: r.id, kind: "browser", title: r.title, url: r.url };
  }
  return null;
}

export function sanitizeRightPanelSession(raw: unknown): RightPanelSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tabs)) return null;
  const seen = new Set<string>();
  const tabs = r.tabs.flatMap((candidate) => {
    const tab = sanitizeTab(candidate);
    if (!tab || seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
  const requested = typeof r.activeTabId === "string" ? r.activeTabId : null;
  const activeTabId = requested && tabs.some((tab) => tab.id === requested)
    ? requested
    : (tabs[0]?.id ?? null);
  return {
    tabs,
    activeTabId,
    open: typeof r.open === "boolean" ? r.open : true,
    touchedAt:
      typeof r.touchedAt === "number" && Number.isFinite(r.touchedAt) && r.touchedAt >= 0
        ? r.touchedAt
        : 0,
  };
}

export function sanitizeRightPanelPayload(raw: unknown): RightPanelPayload {
  if (!raw || typeof raw !== "object") return EMPTY_RIGHT_PANEL_PAYLOAD;
  const r = raw as Record<string, unknown>;
  if (r.version !== RIGHT_PANEL_SCHEMA_VERSION || !r.sessions || typeof r.sessions !== "object") {
    return EMPTY_RIGHT_PANEL_PAYLOAD;
  }
  const sessions: Record<string, RightPanelSession> = {};
  for (const [key, value] of Object.entries(r.sessions as Record<string, unknown>)) {
    if (!key) continue;
    const session = sanitizeRightPanelSession(value);
    if (session) sessions[key] = session;
  }
  return boundRightPanelSessions({ version: RIGHT_PANEL_SCHEMA_VERSION, sessions });
}

export function parseRightPanelPayload(raw: string | null): RightPanelPayload {
  if (!raw) return EMPTY_RIGHT_PANEL_PAYLOAD;
  try {
    return sanitizeRightPanelPayload(JSON.parse(raw));
  } catch {
    return EMPTY_RIGHT_PANEL_PAYLOAD;
  }
}

export function boundRightPanelSessions(
  payload: RightPanelPayload,
  cap = RIGHT_PANEL_SESSION_CAP,
): RightPanelPayload {
  const entries = Object.entries(payload.sessions);
  if (entries.length <= cap) return payload;
  const keep = entries
    .sort(([keyA, a], [keyB, b]) => b.touchedAt - a.touchedAt || keyA.localeCompare(keyB))
    .slice(0, Math.max(0, cap));
  return { version: RIGHT_PANEL_SCHEMA_VERSION, sessions: Object.fromEntries(keep) };
}

export function setPanelSession(
  payload: RightPanelPayload,
  scopeKey: string,
  session: RightPanelSession,
  touchedAt: number,
): RightPanelPayload {
  return boundRightPanelSessions({
    version: RIGHT_PANEL_SCHEMA_VERSION,
    sessions: { ...payload.sessions, [scopeKey]: { ...session, touchedAt } },
  });
}

export function closePanelTab(session: RightPanelSession, tabId: string): RightPanelSession {
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== tabId);
  let activeTabId = session.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
  }
  return { ...session, tabs, activeTabId };
}

export function closeOtherPanelTabs(
  session: RightPanelSession,
  tabId: string,
): RightPanelSession {
  const tab = session.tabs.find((candidate) => candidate.id === tabId);
  return tab ? { ...session, tabs: [tab], activeTabId: tab.id } : session;
}

export function closePanelTabsToRight(
  session: RightPanelSession,
  tabId: string,
): RightPanelSession {
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return session;
  const tabs = session.tabs.slice(0, index + 1);
  return {
    ...session,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === session.activeTabId)
      ? session.activeTabId
      : tabId,
  };
}

let current: RightPanelPayload = EMPTY_RIGHT_PANEL_PAYLOAD;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    current = parseRightPanelPayload(window.localStorage.getItem(RIGHT_PANEL_STORAGE_KEY));
  } catch {
    current = EMPTY_RIGHT_PANEL_PAYLOAD;
  }
}

function read(scopeKey: string): RightPanelSession {
  ensureHydrated();
  return current.sessions[scopeKey] ?? DEFAULT_RIGHT_PANEL_SESSION;
}

function write(scopeKey: string, next: RightPanelSession) {
  ensureHydrated();
  current = setPanelSession(current, scopeKey, next, Date.now());
  try {
    window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode / storage blocked — panel state remains live in memory */
  }
  emit();
}

/** Imperative owner-adapter action used by workspace controls outside the
 * panel surface. Keeping it in the store means the renderer stays a pure
 * projection and does not grow a window-level event protocol. */
export function openRightPanelGit(scopeKey: string): void {
  const session = read(scopeKey);
  const tabs = session.tabs.some((tab) => tab.id === DEFAULT_GIT_TAB.id)
    ? session.tabs
    : [...session.tabs, DEFAULT_GIT_TAB];
  write(scopeKey, { ...session, tabs, activeTabId: DEFAULT_GIT_TAB.id, open: true });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== RIGHT_PANEL_STORAGE_KEY) return;
    current = parseRightPanelPayload(event.newValue);
    hydrated = true;
    emit();
  });
}

export function useRightPanelStore(scopeKey: string) {
  const getSnapshot = useCallback(() => read(scopeKey), [scopeKey]);
  const session = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_RIGHT_PANEL_SESSION);

  return useMemo(() => ({
    session,
    activate: (tabId: string) => {
      if (!session.tabs.some((tab) => tab.id === tabId)) return;
      write(scopeKey, { ...session, activeTabId: tabId, open: true });
    },
    setOpen: (open: boolean) => write(scopeKey, { ...session, open }),
    openGit: () => {
      const tabs = session.tabs.some((tab) => tab.id === DEFAULT_GIT_TAB.id)
        ? session.tabs
        : [...session.tabs, DEFAULT_GIT_TAB];
      write(scopeKey, { ...session, tabs, activeTabId: DEFAULT_GIT_TAB.id, open: true });
    },
    openBrowser: (url = "http://localhost:3000") => {
      const id = `browser:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
      const tab: BrowserPanelTab = { id, kind: "browser", title: "Browser", url };
      write(scopeKey, { ...session, tabs: [...session.tabs, tab], activeTabId: id, open: true });
    },
    close: (tabId: string) => write(scopeKey, closePanelTab(session, tabId)),
    closeOthers: (tabId: string) => write(scopeKey, closeOtherPanelTabs(session, tabId)),
    closeRight: (tabId: string) => write(scopeKey, closePanelTabsToRight(session, tabId)),
  }), [scopeKey, session]);
}
