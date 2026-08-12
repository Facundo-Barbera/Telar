/**
 * The right panel's open tabs, per session.
 *
 * THE PANEL STARTS EMPTY. The donor's panel does too — `DEFAULT_RIGHT_PANEL_SESSION`
 * has `tabs: []` — because a surface that pre-opens four tabs has decided for you
 * what you were about to look at, and you pay for that decision every time it is
 * wrong. Opening a tab is the gesture; the empty state is what offers it.
 *
 * The state is deliberately tiny — which tabs are open, which one is active, and
 * whether the panel itself is showing. Everything a tab RENDERS is a fold over
 * the session record, so there is nothing per-tab to persist beyond its
 * existence.
 */

const STORAGE_KEY = "telar:right-panel";
const VERSION = 1;
/** Sessions to remember, LRU by `touchedAt`. Unbounded growth here is a
 *  localStorage quota failure months later, in a place nobody will look. */
const SESSION_CAP = 24;

export type PanelTabState<Tab extends string> = {
  tabs: Tab[];
  activeTab?: Tab;
  open: boolean;
};

export function emptyPanelTabs<Tab extends string>(): PanelTabState<Tab> {
  return { tabs: [], open: false };
}

/** Open a tab, or focus it when it is already open. Tabs are SINGLETONS by
 *  kind: every surface here is a view of one session record, so a second copy
 *  of "Changes" would show exactly what the first one shows. */
export function openPanelTab<Tab extends string>(state: PanelTabState<Tab>, tab: Tab): PanelTabState<Tab> {
  return {
    tabs: state.tabs.includes(tab) ? state.tabs : [...state.tabs, tab],
    activeTab: tab,
    open: true,
  };
}

/**
 * Close a tab and choose the next active one.
 *
 * The NEIGHBOUR takes focus — the tab to the right, or the last one when the
 * closed tab was rightmost. Falling back to "the first tab" instead would jump
 * the eye across the strip on every close.
 */
export function closePanelTab<Tab extends string>(state: PanelTabState<Tab>, tab: Tab): PanelTabState<Tab> {
  const index = state.tabs.indexOf(tab);
  if (index === -1) return state;
  const tabs = state.tabs.filter((entry) => entry !== tab);
  if (tabs.length === 0) return { tabs, open: state.open };
  // Closing an inactive tab must not steal focus from the one you are reading.
  const activeTab = state.activeTab === tab ? (tabs[index] ?? tabs[tabs.length - 1]) : state.activeTab;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
}

export function closeOtherPanelTabs<Tab extends string>(state: PanelTabState<Tab>, tab: Tab): PanelTabState<Tab> {
  if (!state.tabs.includes(tab)) return state;
  return { tabs: [tab], activeTab: tab, open: state.open };
}

type StoredPanel = { version: number; sessions: Record<string, { tabs: string[]; activeTab?: string; open: boolean; touchedAt: number }> };

function readStore(): StoredPanel {
  if (typeof window === "undefined") return { version: VERSION, sessions: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: VERSION, sessions: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: VERSION, sessions: {} };
    const store = parsed as StoredPanel;
    // A schema bump discards rather than migrates: the state is one panel's
    // open tabs, and re-opening a tab costs one click.
    if (store.version !== VERSION || typeof store.sessions !== "object") return { version: VERSION, sessions: {} };
    return store;
  } catch {
    return { version: VERSION, sessions: {} };
  }
}

/**
 * Restore a session's panel, validating each id against what this build
 * understands — a tab kind that has since been renamed or removed must not
 * resurrect as a blank pane.
 *
 * A PREDICATE rather than a list, because tab ids are no longer a closed set:
 * every browser page is its own tab, keyed by the engine's id for it, so
 * "is this a tab id" is a question about SHAPE and cannot be answered by
 * membership.
 */
/**
 * THE KEY A CANVAS USES BEFORE IT HAS A SESSION.
 *
 * The same shape the draft store uses (`new:<projectId>`), and for the same
 * reason: a new-conversation canvas is a real place a person arranges — opening
 * Issues, resizing the panel — and it forgot all of it on every visit because
 * the only key it could offer was a session id that did not exist yet. Scoped
 * per PROJECT because that is what the canvas is scoped to.
 */
export function canvasPanelKey(projectId: string): string {
  return `new:${projectId}`;
}

export function readPanelTabs<Tab extends string>(sessionId: string, isKnown: (tab: string) => tab is Tab): PanelTabState<Tab> {
  const stored = readStore().sessions[sessionId];
  if (!stored) return emptyPanelTabs<Tab>();
  const tabs = (Array.isArray(stored.tabs) ? stored.tabs : []).filter(isKnown);
  const activeTab = tabs.find((tab) => tab === stored.activeTab) ?? tabs[0];
  return { tabs, ...(activeTab ? { activeTab } : {}), open: Boolean(stored.open) && tabs.length > 0 };
}

export function writePanelTabs<Tab extends string>(sessionId: string, state: PanelTabState<Tab>, now: number): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    store.sessions[sessionId] = {
      tabs: state.tabs,
      ...(state.activeTab ? { activeTab: state.activeTab } : {}),
      open: state.open,
      touchedAt: now,
    };
    const entries = Object.entries(store.sessions);
    if (entries.length > SESSION_CAP) {
      store.sessions = Object.fromEntries(entries.sort(([, a], [, b]) => b.touchedAt - a.touchedAt).slice(0, SESSION_CAP));
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage must not break the panel.
  }
}
