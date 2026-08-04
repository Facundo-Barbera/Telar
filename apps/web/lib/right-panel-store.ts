"use client";

// Per-session right-panel UI state. This is deliberately a plain external
// store: panel tabs are browser preferences, not engine state, and this app's
// established contract is subscribe + snapshot + useSyncExternalStore rather
// than a global state dependency.

import { useCallback, useMemo, useSyncExternalStore } from "react";

export const RIGHT_PANEL_STORAGE_KEY = "telar:right-panel";
export const RIGHT_PANEL_SCHEMA_VERSION = 5;
export const RIGHT_PANEL_SESSION_CAP = 24;

export type GitPanelTab = {
  id: "git";
  kind: "git";
  title: "Git";
};

export type ActivityPanelTab = {
  id: "activity";
  kind: "activity";
  title: "Activity";
};

export type BrowserPanelTab = {
  id: string;
  kind: "browser";
  title: string;
  url: string;
};

export type RightPanelTab = ActivityPanelTab | GitPanelTab | BrowserPanelTab;

export type RightPanelSession = {
  tabs: RightPanelTab[];
  activeTabId: string | null;
  open: boolean;
  fullscreen: boolean;
  touchedAt: number;
};

export type RightPanelPayload = {
  version: typeof RIGHT_PANEL_SCHEMA_VERSION;
  sessions: Record<string, RightPanelSession>;
};

export const DEFAULT_ACTIVITY_TAB: ActivityPanelTab = {
  id: "activity",
  kind: "activity",
  title: "Activity",
};
export const DEFAULT_GIT_TAB: GitPanelTab = { id: "git", kind: "git", title: "Git" };
export const DEFAULT_RIGHT_PANEL_SESSION: RightPanelSession = {
  tabs: [],
  activeTabId: null,
  open: false,
  fullscreen: false,
  touchedAt: 0,
};
export const EMPTY_RIGHT_PANEL_PAYLOAD: RightPanelPayload = {
  version: RIGHT_PANEL_SCHEMA_VERSION,
  sessions: {},
};

function sanitizeTab(raw: unknown): RightPanelTab | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "activity") return DEFAULT_ACTIVITY_TAB;
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
    : null;
  return {
    tabs,
    activeTabId,
    open: typeof r.open === "boolean" ? r.open : false,
    fullscreen: typeof r.fullscreen === "boolean" ? r.fullscreen : false,
    touchedAt:
      typeof r.touchedAt === "number" && Number.isFinite(r.touchedAt) && r.touchedAt >= 0
        ? r.touchedAt
        : 0,
  };
}

export function sanitizeRightPanelPayload(raw: unknown): RightPanelPayload {
  if (!raw || typeof raw !== "object") return EMPTY_RIGHT_PANEL_PAYLOAD;
  const r = raw as Record<string, unknown>;
  const legacyClosedVersion = r.version === 1 || r.version === 2;
  const legacyActivityVersion =
    r.version === 1 || r.version === 2 || r.version === 3 || r.version === 4;
  const recognizedVersion = legacyActivityVersion || r.version === RIGHT_PANEL_SCHEMA_VERSION;
  if (!recognizedVersion || !r.sessions || typeof r.sessions !== "object") {
    return EMPTY_RIGHT_PANEL_PAYLOAD;
  }
  const sessions: Record<string, RightPanelSession> = {};
  for (const [key, value] of Object.entries(r.sessions as Record<string, unknown>)) {
    // `project:new` is a disposable owner used only until the first turn
    // supplies a real session id. Never hydrate it into a later blank session.
    if (!key || key.endsWith(":new")) continue;
    const session = sanitizeRightPanelSession(value);
    // Versions 1 and 2 predate the closed-by-default dock contract. Versions
    // through 4 also injected Activity as a permanent first tab. In v5 it is an
    // explicit surface, so legacy Activity selection migrates to the chooser.
    if (session) {
      const migrated = legacyActivityVersion
        ? {
            ...session,
            tabs: session.tabs.filter((tab) => tab.kind !== "activity"),
            activeTabId:
              session.activeTabId === DEFAULT_ACTIVITY_TAB.id
                ? null
                : session.activeTabId,
          }
        : session;
      sessions[key] = legacyClosedVersion
        ? { ...migrated, open: false, fullscreen: false }
        : migrated;
    }
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

export function movePanelSession(
  payload: RightPanelPayload,
  fromScopeKey: string,
  toScopeKey: string,
  touchedAt: number,
): RightPanelPayload {
  const provisional = payload.sessions[fromScopeKey];
  if (fromScopeKey === toScopeKey || !provisional) return payload;
  const sessions = { ...payload.sessions };
  delete sessions[fromScopeKey];
  if (!sessions[toScopeKey]) {
    sessions[toScopeKey] = { ...provisional, touchedAt };
  }
  return boundRightPanelSessions({ version: RIGHT_PANEL_SCHEMA_VERSION, sessions });
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
  if (!tab) return session;
  return { ...session, tabs: [tab], activeTabId: tab.id };
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

/** Move the disposable `project:new` surface onto the durable session minted
 * by the first turn. The placeholder must be cleared so the next new-session
 * page never inherits a Browser tab or an open dock from the previous chat. */
export function adoptRightPanelSession(
  fromScopeKey: string,
  toScopeKey: string,
): void {
  ensureHydrated();
  const next = movePanelSession(current, fromScopeKey, toScopeKey, Date.now());
  if (next === current) return;
  current = next;
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

/** Reveal the controlled browser owned by the currently mounted session. */
export function openRightPanelBrowser(
  scopeKey: string,
  url = "about:blank",
): void {
  const session = read(scopeKey);
  const existing = session.tabs.find((candidate): candidate is BrowserPanelTab =>
    candidate.kind === "browser",
  );
  if (existing) {
    write(scopeKey, {
      ...session,
      activeTabId: existing.id,
      open: true,
    });
    return;
  }
  const id = `browser:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const tab: BrowserPanelTab = { id, kind: "browser", title: "Browser", url };
  write(scopeKey, {
    ...session,
    tabs: [...session.tabs, tab],
    activeTabId: id,
    open: true,
  });
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
    setOpen: (open: boolean) => write(scopeKey, {
      ...session,
      open,
      fullscreen: open ? session.fullscreen : false,
    }),
    setFullscreen: (fullscreen: boolean) => write(scopeKey, {
      ...session,
      open: fullscreen ? true : session.open,
      fullscreen,
    }),
    openGit: () => {
      const tabs = session.tabs.some((tab) => tab.id === DEFAULT_GIT_TAB.id)
        ? session.tabs
        : [...session.tabs, DEFAULT_GIT_TAB];
      write(scopeKey, { ...session, tabs, activeTabId: DEFAULT_GIT_TAB.id, open: true });
    },
    openActivity: () => {
      const tabs = session.tabs.some((tab) => tab.id === DEFAULT_ACTIVITY_TAB.id)
        ? session.tabs
        : [DEFAULT_ACTIVITY_TAB, ...session.tabs];
      write(scopeKey, {
        ...session,
        tabs,
        activeTabId: DEFAULT_ACTIVITY_TAB.id,
        open: true,
      });
    },
    // The controlled browser owns its own tab strip. Reuse one Browser surface
    // instead of nesting duplicate surfaces around the shared runtime.
    openBrowser: (url = "about:blank") => openRightPanelBrowser(scopeKey, url),
    navigateBrowser: (tabId: string, url: string) => {
      const tabs = session.tabs.map((tab) =>
        tab.kind === "browser" && tab.id === tabId ? { ...tab, url } : tab,
      );
      write(scopeKey, { ...session, tabs, activeTabId: tabId, open: true });
    },
    close: (tabId: string) => write(scopeKey, closePanelTab(session, tabId)),
    closeOthers: (tabId: string) => write(scopeKey, closeOtherPanelTabs(session, tabId)),
    closeRight: (tabId: string) => write(scopeKey, closePanelTabsToRight(session, tabId)),
  }), [scopeKey, session]);
}
