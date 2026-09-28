const STORAGE_KEY = "telar:right-panel";
const VERSION = 1;
/** Sessions to remember, LRU by `touchedAt`, so localStorage never fills. */
const SESSION_CAP = 24;

/** What makes two instances of one kind different: flat strings, persisted and shown in a tab label. */
export type PanelTabParams = Readonly<Record<string, string>>;

/** An open tab. The first instance of a kind takes the kind as its id, so everything keyed on "the Editor" keeps one key. */
export type PanelTabInstance<Kind extends string = string> = {
  id: string;
  kind: Kind;
  params: PanelTabParams;
};

export type PanelTabState<Kind extends string> = {
  tabs: PanelTabInstance<Kind>[];
  /** An instance id, not a kind. */
  activeTab?: string;
  open: boolean;
};

export function emptyPanelTabs<Kind extends string>(): PanelTabState<Kind> {
  return { tabs: [], open: false };
}

/** The id a new instance would take: `editor`, then `editor#2`. Callers mint it before the tab exists to seed its state. */
export function nextPanelTabId<Kind extends string>(state: PanelTabState<Kind>, kind: Kind): string {
  const taken = (id: string) => state.tabs.some((tab) => tab.id === id);
  if (!taken(kind)) return kind;
  for (let n = 2; ; n += 1) {
    const id = `${kind}#${n}`;
    if (!taken(id)) return id;
  }
}

export function findPanelTab<Kind extends string>(state: PanelTabState<Kind>, id: string): PanelTabInstance<Kind> | undefined {
  return state.tabs.find((tab) => tab.id === id);
}

export function activePanelTab<Kind extends string>(state: PanelTabState<Kind>): PanelTabInstance<Kind> | undefined {
  return state.activeTab === undefined ? undefined : findPanelTab(state, state.activeTab);
}

/** Put an instance the caller has already minted into the strip, focused. */
export function addPanelTab<Kind extends string>(state: PanelTabState<Kind>, tab: PanelTabInstance<Kind>): PanelTabState<Kind> {
  return {
    tabs: state.tabs.some((entry) => entry.id === tab.id) ? state.tabs : [...state.tabs, tab],
    activeTab: tab.id,
    open: true,
  };
}

/** Focus a tab of this kind, the active one first, or open one. Matched by kind, not params; `openNewPanelTab` always mints. */
export function openPanelTab<Kind extends string>(state: PanelTabState<Kind>, kind: Kind, params: PanelTabParams = {}): PanelTabState<Kind> {
  const active = activePanelTab(state);
  const existing = active?.kind === kind ? active : state.tabs.find((tab) => tab.kind === kind);
  if (existing) return { ...state, activeTab: existing.id, open: true };
  return addPanelTab(state, { id: nextPanelTabId(state, kind), kind, params });
}

export function openNewPanelTab<Kind extends string>(state: PanelTabState<Kind>, kind: Kind, params: PanelTabParams = {}): PanelTabState<Kind> {
  return addPanelTab(state, { id: nextPanelTabId(state, kind), kind, params });
}

/**
 * Add a tab for something the agent opened. Never opens the panel and never selects the tab: both belong to the person.
 * Returns the same object when nothing changes, since callers run it on every browser event.
 */
export function revealPanelTab<Kind extends string>(state: PanelTabState<Kind>, tab: PanelTabInstance<Kind>): PanelTabState<Kind> {
  if (state.tabs.some((entry) => entry.id === tab.id)) return state;
  return { ...state, tabs: [...state.tabs, tab] };
}

/** Replace, not merge, one instance's params: a merge would leave a key nobody can clear. */
export function setPanelTabParams<Kind extends string>(state: PanelTabState<Kind>, id: string, params: PanelTabParams): PanelTabState<Kind> {
  const current = findPanelTab(state, id);
  if (!current || sameParams(current.params, params)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, params } : tab)) };
}

function sameParams(a: PanelTabParams, b: PanelTabParams): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Close a tab; the neighbour to the right (or the new last) takes focus, and an inactive close keeps it. */
export function closePanelTab<Kind extends string>(state: PanelTabState<Kind>, id: string): PanelTabState<Kind> {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return { tabs, open: state.open };
  const activeTab = state.activeTab === id ? (tabs[index]?.id ?? tabs[tabs.length - 1]!.id) : state.activeTab;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
}

/** The strip's own drag type, so a file or reference dropped on a tab is not mistaken for one. */
export const PANEL_TAB_MIME = "application/x-telar-panel-tab";

/** Move a tab to `toIndex` in the strip as it reads without it, clamped. Neither focus nor openness moves. */
export function movePanelTab<Kind extends string>(state: PanelTabState<Kind>, id: string, toIndex: number): PanelTabState<Kind> {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from === -1) return state;
  const moved = state.tabs[from]!;
  const rest = state.tabs.filter((tab) => tab.id !== id);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  if (to === from) return state;
  return { ...state, tabs: [...rest.slice(0, to), moved, ...rest.slice(to)] };
}

/**
 * Collapse every tab of a kind into ONE at the first one's position, for layouts saved before that kind grew an inner
 * strip. `fold` merges their params so no running shell is orphaned. Idempotent by identity: it runs on every restore.
 */
export function collapsePanelTabs<Kind extends string>(
  state: PanelTabState<Kind>,
  isCollapsed: (kind: Kind) => boolean,
  single: Kind,
  fold: (each: readonly PanelTabParams[]) => PanelTabParams = () => ({}),
): PanelTabState<Kind> {
  const folded = state.tabs.filter((tab) => isCollapsed(tab.kind));
  if (folded.length === 0) return state;
  const collapsed: PanelTabInstance<Kind> = { id: single, kind: single, params: fold(folded.map((tab) => tab.params)) };
  const tabs: PanelTabInstance<Kind>[] = [];
  for (const tab of state.tabs) {
    if (!isCollapsed(tab.kind)) tabs.push(tab);
    else if (!tabs.some((entry) => entry.id === collapsed.id)) tabs.push(collapsed);
  }
  const previous = activePanelTab(state);
  const activeTab = previous && isCollapsed(previous.kind) ? collapsed.id : state.activeTab;
  const next = { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
  return sameTabs(state.tabs, next.tabs) && next.activeTab === state.activeTab ? state : next;
}

function sameTabs<Kind extends string>(a: readonly PanelTabInstance<Kind>[], b: readonly PanelTabInstance<Kind>[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab.id === b[index]!.id && tab.kind === b[index]!.kind && sameParams(tab.params, b[index]!.params));
}

type StoredInstance = { id: string; kind: string; params?: Record<string, string> };
type StoredPanel = { version: number; sessions: Record<string, { tabs: StoredInstance[]; activeTab?: string; open: boolean; touchedAt: number }> };

function readStore(): StoredPanel {
  if (typeof window === "undefined") return { version: VERSION, sessions: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: VERSION, sessions: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: VERSION, sessions: {} };
    const store = parsed as StoredPanel;
    // A schema bump discards rather than migrates: re-opening a tab costs one click.
    if (store.version !== VERSION || typeof store.sessions !== "object") return { version: VERSION, sessions: {} };
    return store;
  } catch {
    return { version: VERSION, sessions: {} };
  }
}

function storedTab(entry: StoredInstance): { id?: string; kind: string; params: PanelTabParams } | undefined {
  if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || !entry.kind) return undefined;
  const params: Record<string, string> = {};
  if (entry.params && typeof entry.params === "object") {
    for (const [key, value] of Object.entries(entry.params)) {
      if (typeof value === "string") params[key] = value;
    }
  }
  return { ...(typeof entry.id === "string" && entry.id ? { id: entry.id } : {}), kind: entry.kind, params };
}

/** The key a new-conversation canvas uses before it has a session, like the draft store's. */
export function canvasPanelKey(projectId: string): string {
  return `new:${projectId}`;
}

/** Restore a session's panel. `isKnown` is a predicate because kinds like `browser:<id>` carry their subject. */
export function readPanelTabs<Kind extends string>(sessionId: string, isKnown: (kind: string) => kind is Kind): PanelTabState<Kind> {
  const stored = readStore().sessions[sessionId];
  if (!stored) return emptyPanelTabs<Kind>();
  const tabs: PanelTabInstance<Kind>[] = [];
  for (const entry of Array.isArray(stored.tabs) ? stored.tabs : []) {
    const parsed = storedTab(entry);
    if (!parsed || !isKnown(parsed.kind)) continue;
    const kind = parsed.kind;
    const keep = parsed.id !== undefined && !tabs.some((tab) => tab.id === parsed.id);
    tabs.push({ id: keep ? parsed.id! : nextPanelTabId({ tabs, open: false }, kind), kind, params: parsed.params });
  }
  const activeTab = tabs.some((tab) => tab.id === stored.activeTab) ? stored.activeTab : tabs[0]?.id;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: Boolean(stored.open) && tabs.length > 0 };
}

/** Forget one key's panel. The canvas clears its shared `new:<projectId>` key when it hands the layout to a session. */
export function clearPanelTabs(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    if (!(sessionId in store.sessions)) return;
    delete store.sessions[sessionId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage must not break the panel.
  }
}

export function writePanelTabs<Kind extends string>(sessionId: string, state: PanelTabState<Kind>, now: number): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    store.sessions[sessionId] = {
      tabs: state.tabs.map((tab) => ({ id: tab.id, kind: tab.kind, params: { ...tab.params } })),
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
