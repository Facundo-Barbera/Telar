/**
 * The right panel's open tabs, per session.
 *
 * THE PANEL STARTS EMPTY. The donor's panel does too — `DEFAULT_RIGHT_PANEL_SESSION`
 * has `tabs: []` — because a surface that pre-opens four tabs has decided for you
 * what you were about to look at, and you pay for that decision every time it is
 * wrong. Opening a tab is the gesture; the empty state is what offers it.
 *
 * A TAB IS AN INSTANCE, NOT A KIND (#322). It used to be a bare id — one
 * "Editor", one "Diff", one "Browser" — on the reasoning that every surface here
 * is a view of one session record, so a second copy would show what the first
 * one shows. That stopped being true when the Editor grew open files and the
 * Browser grew its own pages: you cannot read two files side by side, or keep a
 * docs page beside the app you are testing, if the strip can only hold one of
 * each. So a tab is `{ id, kind, params }`: `kind` is the surface, `params` is
 * the per-kind state that makes two instances different, and `id` is what every
 * reducer here addresses. Surfaces with no params (Agents, Processes, Issues,
 * Pull requests, Run) are still one each — the caller decides, by choosing
 * `openPanelTab` (focus what is open) over `openNewPanelTab` (always mint).
 */

const STORAGE_KEY = "telar:right-panel";
const VERSION = 1;
/** Sessions to remember, LRU by `touchedAt`. Unbounded growth here is a
 *  localStorage quota failure months later, in a place nobody will look. */
const SESSION_CAP = 24;

/**
 * What makes two instances of one kind different — the Editor's open file, the
 * Browser's scope, the Diff's filter.
 *
 * FLAT STRINGS, deliberately. Everything here is persisted, compared and shown
 * in a tab label, and a nested value would be none of those things cheaply. A
 * surface that needs more than a string per key has state of its own to keep it
 * in; what belongs HERE is only the part that identifies the instance.
 */
export type PanelTabParams = Readonly<Record<string, string>>;

export type PanelTabInstance<Kind extends string = string> = {
  /**
   * UNIQUE, STABLE AND PERSISTED. The first instance of a kind takes the kind
   * itself as its id, which is what makes the migration from the old string
   * list a no-op and lets everything keyed on "the Editor" (its stored files,
   * the browser's native scope) keep the key it already had.
   */
  id: string;
  kind: Kind;
  params: PanelTabParams;
};

export type PanelTabState<Kind extends string> = {
  tabs: PanelTabInstance<Kind>[];
  /** An instance ID, not a kind — two Editors are two tabs. */
  activeTab?: string;
  open: boolean;
};

export function emptyPanelTabs<Kind extends string>(): PanelTabState<Kind> {
  return { tabs: [], open: false };
}

/**
 * The id a new instance of this kind would take.
 *
 * THE FIRST ONE IS THE KIND. `editor`, then `editor#2`, `editor#3`. Exposed
 * rather than kept private because a caller sometimes needs the id BEFORE the
 * tab exists — the Editor seeds that instance's files under it, and the Browser
 * derives its native scope key from it — and minting it here is what stops two
 * call sites inventing two different answers.
 */
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

/** The instance the panel is showing, or nothing — an open panel with no tab is
 *  its own legitimate state (the "choose a surface" screen). */
export function activePanelTab<Kind extends string>(state: PanelTabState<Kind>): PanelTabInstance<Kind> | undefined {
  return state.activeTab === undefined ? undefined : findPanelTab(state, state.activeTab);
}

/** Every open instance of one kind, in strip order. */
export function panelTabsOfKind<Kind extends string>(state: PanelTabState<Kind>, kind: Kind): PanelTabInstance<Kind>[] {
  return state.tabs.filter((tab) => tab.kind === kind);
}

/** Put an instance the caller has already minted into the strip, focused. */
export function addPanelTab<Kind extends string>(state: PanelTabState<Kind>, tab: PanelTabInstance<Kind>): PanelTabState<Kind> {
  return {
    tabs: state.tabs.some((entry) => entry.id === tab.id) ? state.tabs : [...state.tabs, tab],
    activeTab: tab.id,
    open: true,
  };
}

/**
 * Open a tab, or focus one of this kind that is already open.
 *
 * MATCHED BY KIND, NOT BY PARAMS, and the asymmetry is the point. "Show me the
 * Editor" means the Editor you are already using — the one whose files you have
 * open — not a fresh one because its params happen to differ from the empty set
 * this call passes. THE ACTIVE TAB WINS when it is of the right kind, so
 * clicking a file while reading the second Editor opens it in that Editor
 * rather than jumping the strip back to the first.
 *
 * Deliberately opening a SECOND instance is a different gesture with a
 * different verb — see `openNewPanelTab`.
 */
export function openPanelTab<Kind extends string>(state: PanelTabState<Kind>, kind: Kind, params: PanelTabParams = {}): PanelTabState<Kind> {
  const active = activePanelTab(state);
  const existing = active?.kind === kind ? active : state.tabs.find((tab) => tab.kind === kind);
  if (existing) return { ...state, activeTab: existing.id, open: true };
  return addPanelTab(state, { id: nextPanelTabId(state, kind), kind, params });
}

/** Open a NEW instance, whatever is already open — the "+" chooser's verb for a
 *  multi-instance kind, and what "Open in a new panel tab" does. */
export function openNewPanelTab<Kind extends string>(state: PanelTabState<Kind>, kind: Kind, params: PanelTabParams = {}): PanelTabState<Kind> {
  return addPanelTab(state, { id: nextPanelTabId(state, kind), kind, params });
}

/**
 * Rewrite one instance's params — what keeps a tab's label true as the surface
 * under it moves (the Editor's active file becomes "Editor · README.md").
 *
 * A REPLACE, NOT A MERGE: params are the whole of what identifies an instance,
 * and a merge would leave a key nobody can clear.
 */
export function setPanelTabParams<Kind extends string>(state: PanelTabState<Kind>, id: string, params: PanelTabParams): PanelTabState<Kind> {
  const current = findPanelTab(state, id);
  if (!current || sameParams(current.params, params)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, params } : tab)) };
}

function sameParams(a: PanelTabParams, b: PanelTabParams): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Close a tab and choose the next active one.
 *
 * The NEIGHBOUR takes focus — the tab to the right, or the last one when the
 * closed tab was rightmost. Falling back to "the first tab" instead would jump
 * the eye across the strip on every close.
 */
export function closePanelTab<Kind extends string>(state: PanelTabState<Kind>, id: string): PanelTabState<Kind> {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return { tabs, open: state.open };
  // Closing an inactive tab must not steal focus from the one you are reading.
  const activeTab = state.activeTab === id ? (tabs[index]?.id ?? tabs[tabs.length - 1]!.id) : state.activeTab;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
}

/** The strip's own drag type, so a file or a reference dropped on a tab is not
 *  mistaken for a tab. Vendor-prefixed per RFC 6839, like `PROJECT_GROUP_MIME`. */
export const PANEL_TAB_MIME = "application/x-telar-panel-tab";

/**
 * Move a tab to a position in the strip.
 *
 * `toIndex` IS AN INDEX IN THE RESULT, i.e. in the strip as it will read once
 * the tab has left its old place. Saying "the index it had before" instead
 * would make every rightward move off by one at the call site, which is the
 * arithmetic a drop handler is worst at and this reducer exists to own.
 * Out-of-range is clamped rather than refused: a drop past the last tab means
 * "last", which is what the pointer was saying.
 *
 * NEITHER THE ACTIVE TAB NOR THE PANEL'S OPENNESS MOVES WITH IT. Reordering is
 * about where a tab sits, and a strip that also switched what you were reading
 * would be answering a question nobody asked.
 */
export function movePanelTab<Kind extends string>(state: PanelTabState<Kind>, id: string, toIndex: number): PanelTabState<Kind> {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from === -1) return state;
  const moved = state.tabs[from]!;
  const rest = state.tabs.filter((tab) => tab.id !== id);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  if (to === from) return state;
  return { ...state, tabs: [...rest.slice(0, to), moved, ...rest.slice(to)] };
}

export function closeOtherPanelTabs<Kind extends string>(state: PanelTabState<Kind>, id: string): PanelTabState<Kind> {
  const kept = findPanelTab(state, id);
  if (!kept) return state;
  return { tabs: [kept], activeTab: id, open: state.open };
}

/**
 * Collapse every per-page browser tab into ONE, in place, preserving the order
 * of the other tabs and the active selection. Used on the desktop shell, where
 * the native WebContentsView owns the per-page strip — a session persisted
 * before this change would otherwise still show the old per-page outer tabs
 * after upgrade. `isBrowser` identifies a browser page tab by KIND; `single` is
 * the kind of the one collapsed tab that replaces them (at the position of the
 * first), which also becomes its instance id.
 */
export function collapseBrowserTabs<Kind extends string>(
  state: PanelTabState<Kind>,
  isBrowser: (kind: Kind) => boolean,
  single: Kind,
): PanelTabState<Kind> {
  if (!state.tabs.some((tab) => isBrowser(tab.kind))) return state;
  const collapsed: PanelTabInstance<Kind> = { id: single, kind: single, params: {} };
  const tabs: PanelTabInstance<Kind>[] = [];
  for (const tab of state.tabs) {
    if (isBrowser(tab.kind)) {
      if (!tabs.some((entry) => entry.id === collapsed.id)) tabs.push(collapsed);
    } else {
      tabs.push(tab);
    }
  }
  const previous = activePanelTab(state);
  const activeTab = previous && isBrowser(previous.kind) ? collapsed.id : state.activeTab;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
}

/**
 * Collapse every outer TERMINAL tab into ONE — `collapseBrowserTabs`'s shape,
 * for the change that turned a shell from a panel tab into an inner tab of one
 * Terminal (lib/terminal-workspace.ts).
 *
 * `fold` IS WHAT KEEPS SOMEBODY'S SHELLS ALIVE. Each old tab carries its PTY's
 * id in its own params, and a collapse that only kept the FIRST tab's params
 * would orphan every shell but one — still running in the Electron host, with
 * nothing on screen attached to it, until the app quits. So the folded tabs'
 * params are handed over together and the caller says what one tab's params
 * are that means all of them.
 *
 * A CALLBACK RATHER THAN AN IMPORT because this module knows about panel tabs
 * and nothing else: a terminal's params are the terminal's vocabulary, and
 * teaching the strip to read them would put a surface's private format in the
 * one place every surface shares.
 */
export function collapseTerminalTabs<Kind extends string>(
  state: PanelTabState<Kind>,
  isTerminal: (kind: Kind) => boolean,
  single: Kind,
  fold: (each: readonly PanelTabParams[]) => PanelTabParams,
): PanelTabState<Kind> {
  const folded = state.tabs.filter((tab) => isTerminal(tab.kind));
  if (folded.length === 0) return state;
  const collapsed: PanelTabInstance<Kind> = { id: single, kind: single, params: fold(folded.map((tab) => tab.params)) };
  const tabs: PanelTabInstance<Kind>[] = [];
  for (const tab of state.tabs) {
    if (isTerminal(tab.kind)) {
      if (!tabs.some((entry) => entry.id === collapsed.id)) tabs.push(collapsed);
    } else {
      tabs.push(tab);
    }
  }
  const previous = activePanelTab(state);
  const activeTab = previous && isTerminal(previous.kind) ? collapsed.id : state.activeTab;
  const next = { tabs, ...(activeTab ? { activeTab } : {}), open: state.open };
  /* IDEMPOTENT BY IDENTITY, because this runs on every restore and not only on
     the one after the upgrade: a session already migrated must not be handed a
     new object on every mount, which would write its panel back to storage for
     no reason. */
  return sameTabs(state.tabs, next.tabs) && next.activeTab === state.activeTab ? state : next;
}

function sameTabs<Kind extends string>(a: readonly PanelTabInstance<Kind>[], b: readonly PanelTabInstance<Kind>[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab.id === b[index]!.id && tab.kind === b[index]!.kind && sameParams(tab.params, b[index]!.params));
}

type StoredInstance = { id: string; kind: string; params?: Record<string, string> };
/** A tab as some build wrote it: a bare kind (before #322) or an instance. */
type StoredTab = string | StoredInstance;
type StoredPanel = { version: number; sessions: Record<string, { tabs: StoredTab[]; activeTab?: string; open: boolean; touchedAt: number }> };

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
 * ONE STORED ENTRY, IN THIS BUILD'S SHAPE — and the whole of the #322 migration.
 *
 * A build before instances wrote `"editor"`; this one writes
 * `{ id: "editor", kind: "editor", params: {} }`. A bare string is wrapped as
 * one instance with empty params, which is exactly what it meant. `legacy` says
 * which it was, because the two are deduped differently on the way out: two old
 * `file:` strings both migrate to the Editor and must collapse into one tab,
 * while two deliberate Editor instances must not.
 */
function storedTab(entry: StoredTab): { id?: string; kind: string; params: PanelTabParams; legacy: boolean } | undefined {
  if (typeof entry === "string") return entry ? { kind: entry, params: {}, legacy: true } : undefined;
  if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || !entry.kind) return undefined;
  const params: Record<string, string> = {};
  if (entry.params && typeof entry.params === "object") {
    for (const [key, value] of Object.entries(entry.params)) {
      if (typeof value === "string") params[key] = value;
    }
  }
  return { ...(typeof entry.id === "string" && entry.id ? { id: entry.id } : {}), kind: entry.kind, params, legacy: false };
}

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

/**
 * The stored KINDS, exactly as they were written — before validation, before
 * migration.
 *
 * FOR MIGRATIONS THAT NEED MORE THAN A RENAME. `readPanelTabs` maps an old id
 * to a new one and drops what it cannot place, which is the right answer when a
 * tab became another tab. It is not enough when a tab became CONTENT: every
 * open file used to be its own panel tab, and those ids are the only record of
 * which files somebody had open. The Editor reads them here and restores the
 * files (lib/editor-workspace.ts `editorFromLegacyTabs`), then the ordinary
 * restore collapses the ids themselves into the one Editor tab.
 *
 * KINDS RATHER THAN INSTANCES because that is the question this answers: the
 * ids it is looking for (`file:src/a.ts`) were written by a build that had no
 * instances at all, so an instance's `id` would tell its caller nothing.
 */
export function readPanelTabIds(sessionId: string): { tabs: string[]; activeTab?: string } {
  const stored = readStore().sessions[sessionId];
  if (!stored) return { tabs: [] };
  const tabs = (Array.isArray(stored.tabs) ? stored.tabs : []).map(storedTab).filter((entry) => entry !== undefined);
  const active = tabs.find((entry) => (entry.id ?? entry.kind) === stored.activeTab);
  return {
    tabs: tabs.map((entry) => entry.kind),
    ...(active ? { activeTab: active.kind } : {}),
  };
}

/**
 * Restore a session's panel, validating each KIND against what this build
 * understands — a tab kind that has since been renamed or removed must not
 * resurrect as a blank pane.
 *
 * A PREDICATE rather than a list, because tab kinds are not a closed set: a
 * browser page, a file and an issue each carry their subject in the kind, so
 * "is this a tab" is a question about SHAPE and cannot be answered by
 * membership.
 */
export function readPanelTabs<Kind extends string>(
  sessionId: string,
  isKnown: (kind: string) => kind is Kind,
  migrate: (kind: string) => string = (kind) => kind,
): PanelTabState<Kind> {
  const stored = readStore().sessions[sessionId];
  if (!stored) return emptyPanelTabs<Kind>();
  const tabs: PanelTabInstance<Kind>[] = [];
  /**
   * Which kinds a RENAMED entry has already claimed — a renamed tab restores
   * under its new name once, so a layout that held both of two merged tabs
   * holds one of the merger. Instances written by this build are deduped by
   * their own id instead: two Editors are two Editors.
   *
   * RENAMED, NOT MERELY OLD. This used to key off the stored SHAPE — a bare
   * string was written before instances existed (#322), an object after — which
   * was enough while every merge was also a format change. It stopped being
   * enough at #693: `issue:675` and `issue:666` were written by THIS build, as
   * instances, and both now name `issues`, so shape-based dedupe restored two
   * tabs both labelled Issues. The precise question was never "how old is this
   * entry" but "did `migrate` move it", which is what is asked here.
   */
  const collapsed = new Set<string>();
  /** Which stored id each restored instance came from, so `activeTab` can be
   *  resolved whichever vocabulary it was written in. */
  const from = new Map<string, string>();
  for (const entry of Array.isArray(stored.tabs) ? stored.tabs : []) {
    const parsed = storedTab(entry);
    if (!parsed) continue;
    const kind = migrate(parsed.kind);
    if (!isKnown(kind)) continue;
    if (parsed.legacy || kind !== parsed.kind) {
      if (collapsed.has(kind)) {
        // Still remembered — under BOTH vocabularies, since a renamed entry may
        // have been stored as a bare kind or as an instance with its own id — so
        // an `activeTab` naming the SECOND of two merged ids selects the merger
        // rather than falling back to the first tab.
        const existing = tabs.find((tab) => tab.kind === kind);
        if (existing) {
          from.set(parsed.kind, existing.id);
          if (parsed.id !== undefined) from.set(parsed.id, existing.id);
        }
        continue;
      }
      collapsed.add(kind);
    }
    /** A RENAMED ENTRY DOES NOT KEEP ITS STORED ID. `issue:675` is the id of a
     *  tab kind that no longer exists; carrying it onto the `issues` tab would
     *  break the rule that the first instance of a kind IS the kind (which is
     *  what everything keyed on "the first Editor" and "the first Browser"
     *  depends on) and would read as an id nothing can explain. */
    const keep = parsed.id !== undefined && kind === parsed.kind && !tabs.some((tab) => tab.id === parsed.id);
    const id = keep ? parsed.id! : nextPanelTabId({ tabs, open: false }, kind);
    tabs.push({ id, kind, params: parsed.params });
    from.set(parsed.id ?? parsed.kind, id);
  }
  const activeTab = (stored.activeTab === undefined ? undefined : from.get(stored.activeTab) ?? from.get(migrate(stored.activeTab))) ?? tabs[0]?.id;
  return { tabs, ...(activeTab ? { activeTab } : {}), open: Boolean(stored.open) && tabs.length > 0 };
}

/**
 * Forget one key's panel entirely, so the next reader gets `emptyPanelTabs`.
 *
 * THE CANVAS IS THE ONLY CALLER, AND THAT IS THE BUG IT FIXES. A canvas keys
 * its arrangement on `new:<projectId>` — ONE key shared by every new
 * conversation in that project — and hands it to the session it creates. Left
 * behind, that hand-off became a default: open Run once on a canvas and every
 * later conversation in the project started with Run open, each inheriting it
 * into its own record. Clearing it at the hand-off keeps the deliberate part
 * (the surfaces you arranged while writing the first message follow it) and
 * drops the accidental part (they follow every message after that, forever).
 */
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
