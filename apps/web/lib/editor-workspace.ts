/**
 * THE EDITOR'S OWN TABS — the files open inside one Editor surface.
 *
 * WHY THIS IS NOT `right-panel-tabs.ts`. That module answers "which SURFACES are
 * beside the conversation": Diff, Files, Issues, the browser. A file is not one
 * of those. It used to be — every click in the tree minted a top-level panel tab
 * — and the result was a strip where four files pushed Diff and Issues off the
 * edge, so opening a file cost you the surfaces you were working with. Files are
 * a different KIND of thing from surfaces, they arrive in far greater numbers,
 * and they are the only things here you can have unsaved work in. So they get
 * their own strip, inside one persistent Editor, and this is its state.
 *
 * THE PREVIEW SLOT IS THE WHOLE POINT. Browsing a tree is mostly LOOKING: you
 * open nine files to find the one you meant. Every editor worth using answers
 * this the same way — a single click borrows ONE reusable slot, and anything
 * deliberate (a double click, or typing a character) takes a slot of its own. It
 * is the rule that makes "click through the tree" and "keep these four files
 * open" the same gesture set instead of two conflicting ones.
 *
 * NOTHING UNPINNED IS EVER WORTH KEEPING, which is what makes the replacement
 * safe: the preview slot only ever holds a file nobody has edited (the first
 * keystroke pins it — see `pinEditorFile` and its caller), so replacing it
 * cannot lose work. A pinned file is never replaced, only closed on purpose.
 */

import { fileKind } from "@/lib/file-kinds";

/**
 * WHICH SURFACE DRAWS THE FILE. The same four the panel used to spend a
 * top-level tab on, and the same rules for choosing between them: notebooks and
 * tables need the project's data-science opt-in, a PDF renders wherever it was
 * opened from, everything else is the text editor (which renders markdown
 * itself).
 */
export type EditorView = "code" | "notebook" | "table" | "pdf";

export type EditorFile = {
  path: string;
  view: EditorView;
  /**
   * PINNED MEANS "I MEANT THIS ONE". An unpinned file is the preview: at most
   * one exists, and the next single click takes its slot.
   */
  pinned: boolean;
};

export type EditorState = {
  files: EditorFile[];
  activePath?: string;
  /** The tree beside the code. Collapsible because the panel can be dragged
   *  down to 384px, where a tree and a file cannot both be read. */
  explorerOpen: boolean;
};

/**
 * WHERE A FILE WAS LEFT — caret, selection and scroll.
 *
 * NOT PERSISTED, deliberately. It is worth remembering for as long as the
 * Editor is on screen (switching to another file and back must not send you to
 * line 1), and it is not worth restoring against a file the agent may have
 * rewritten twice since you closed the window — a caret at character 8,412 of a
 * file that is now 200 characters long is worse than the top of the file.
 */
export type EditorViewState = { selectionStart: number; selectionEnd: number; scrollTop: number; scrollLeft: number };

/** How a file was asked for. `preview` borrows the reusable slot; `pin` takes
 *  one of its own — a double click, a chip in the conversation, the agent
 *  putting something in front of you. */
export type OpenIntent = "preview" | "pin";

export function emptyEditor(): EditorState {
  return { files: [], explorerOpen: true };
}

/**
 * Which surface a path opens in — the editor's half of what `panelTabForPath`
 * decided when a file was a panel tab.
 *
 * A NOTEBOOK IS ALWAYS PINNED, never a preview, and that is a judgement rather
 * than a mechanism: a notebook is a thing you work IN — cells with drafts and a
 * running kernel — and its unsaved state does not live in a textarea this
 * module can see pinning itself on the first keystroke. Handing its slot to the
 * next click in the tree is the one replacement that could cost something.
 */
export function editorFileForPath(path: string, dataScience: boolean): { path: string; view: EditorView } {
  const viewer = fileKind(path).viewer;
  if (dataScience && viewer === "notebook") return { path, view: "notebook" };
  if (dataScience && viewer === "table") return { path, view: "table" };
  if (viewer === "pdf") return { path, view: "pdf" };
  return { path, view: "code" };
}

/** A notebook is never a preview — see `editorFileForPath`. */
function intentFor(view: EditorView, intent: OpenIntent): OpenIntent {
  return view === "notebook" ? "pin" : intent;
}

/**
 * Open a file, or focus the one already open.
 *
 * ALREADY OPEN WINS, AND KEEPS ITS PIN. Clicking a file you have pinned must
 * not un-pin it, and clicking the file currently previewed must not mint a
 * second tab for it.
 */
export function openInEditor(state: EditorState, file: { path: string; view: EditorView }, intent: OpenIntent = "preview"): EditorState {
  const wanted = intentFor(file.view, intent);
  const known = state.files.findIndex((entry) => entry.path === file.path);
  if (known !== -1) {
    const files = state.files.map((entry, index) =>
      // A deliberate open promotes a preview; a preview never demotes a pin.
      index === known ? { ...entry, view: file.view, pinned: entry.pinned || wanted === "pin" } : entry,
    );
    return { ...state, files, activePath: file.path };
  }
  const opened: EditorFile = { path: file.path, view: file.view, pinned: wanted === "pin" };
  /**
   * THE PREVIEW SLOT IS REPLACED IN PLACE, whichever kind of open takes it.
   * In place rather than appended-and-removed so the strip does not reshuffle
   * under the pointer while you arrow through a directory.
   */
  const preview = state.files.findIndex((entry) => !entry.pinned);
  const files =
    preview === -1
      ? [...state.files, opened]
      : state.files.map((entry, index) => (index === preview ? opened : entry));
  return { ...state, files, activePath: file.path };
}

/** Promote whatever is in the preview slot — what the first keystroke does, and
 *  what a double click does. Unknown paths are left alone. */
export function pinEditorFile(state: EditorState, path: string): EditorState {
  if (!state.files.some((entry) => entry.path === path && !entry.pinned)) return state;
  return { ...state, files: state.files.map((entry) => (entry.path === path ? { ...entry, pinned: true } : entry)) };
}

/**
 * Close a file and choose the next active one — the NEIGHBOUR to the right, or
 * the new last one, exactly as the panel's own strip does. Falling back to "the
 * first file" would jump the eye across the strip on every close.
 */
export function closeEditorFile(state: EditorState, path: string): EditorState {
  const index = state.files.findIndex((entry) => entry.path === path);
  if (index === -1) return state;
  const files = state.files.filter((entry) => entry.path !== path);
  // No file left means no active path — and `activePath` must be ABSENT rather
  // than undefined, or the next restore reads a key that names nothing.
  if (files.length === 0) return { files, explorerOpen: state.explorerOpen };
  // Closing an inactive file must not steal focus from the one you are reading.
  const activePath = state.activePath === path ? (files[index]?.path ?? files[files.length - 1]!.path) : state.activePath;
  return { ...state, files, ...(activePath ? { activePath } : {}) };
}

/**
 * WHICH FILES A "CLOSE OTHERS" OR A "CLOSE TO THE RIGHT" MEANS.
 *
 * NAMES, NOT A SECOND CLOSE. The tempting shape is a reducer per verb —
 * `closeOtherEditorFiles(state, path)` — and it is the wrong one: closing a
 * file whose save was REFUSED discards text that reached nothing but the box,
 * which is why the Editor's own `close` makes it take a second, deliberate
 * click. A reducer that filtered `state.files` would walk straight past that
 * and throw the text away, silently, for every file in the sweep. So these
 * only SAY which paths a verb is about, and the surface runs each one through
 * the same `close` its × button calls — one close path, and the confirm keeps
 * working on the one file in the sweep that needs it.
 *
 * IN STRIP ORDER, left to right, so a sweep reads the way the strip does.
 * A path that is not open yields nothing: a stale menu must not sweep the
 * strip because the file it was opened on has since gone.
 */
export function otherEditorPaths(state: EditorState, path: string): string[] {
  if (!state.files.some((entry) => entry.path === path)) return [];
  return state.files.filter((entry) => entry.path !== path).map((entry) => entry.path);
}

/** Every file to the RIGHT of this one — see `otherEditorPaths`. */
export function editorPathsAfter(state: EditorState, path: string): string[] {
  const index = state.files.findIndex((entry) => entry.path === path);
  if (index === -1) return [];
  return state.files.slice(index + 1).map((entry) => entry.path);
}

export function activateEditorFile(state: EditorState, path: string): EditorState {
  return state.files.some((entry) => entry.path === path) ? { ...state, activePath: path } : state;
}

export function setExplorerOpen(state: EditorState, explorerOpen: boolean): EditorState {
  return { ...state, explorerOpen };
}

/** The active file, or nothing — the strip may be empty, which is its own
 *  legitimate state (an Editor with the tree and no file open). */
export function activeEditorFile(state: EditorState): EditorFile | undefined {
  return state.files.find((entry) => entry.path === state.activePath);
}

export function editorPaths(state: EditorState): string[] {
  return state.files.map((entry) => entry.path);
}

// ── persistence ────────────────────────────────────────────────────────────

const STORAGE_KEY = "telar:editor";
const VERSION = 1;
/** Sessions to remember, LRU by `touchedAt` — the same cap and the same reason
 *  as the panel's own store: unbounded growth here is a quota failure months
 *  later in a place nobody will look. */
const SESSION_CAP = 24;
/**
 * Files remembered per session. A person who opened two hundred files over a
 * week does not want two hundred tabs back; the pinned ones nearest the end are
 * what they were working on.
 */
const FILE_CAP = 24;

type StoredEditor = {
  version: number;
  sessions: Record<string, { files: EditorFile[]; activePath?: string; explorerOpen: boolean; touchedAt: number }>;
};

function readStore(): StoredEditor {
  if (typeof window === "undefined") return { version: VERSION, sessions: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: VERSION, sessions: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: VERSION, sessions: {} };
    const store = parsed as StoredEditor;
    // A schema bump discards rather than migrates: what is lost is a list of
    // paths, and the files themselves are on disk where they always were.
    if (store.version !== VERSION || typeof store.sessions !== "object") return { version: VERSION, sessions: {} };
    return store;
  } catch {
    return { version: VERSION, sessions: {} };
  }
}

const VIEWS: ReadonlySet<string> = new Set<EditorView>(["code", "notebook", "table", "pdf"]);

/** Validated on the way out, like every other restore in this app: a view kind
 *  this build no longer has must not resurrect as a blank pane. */
export function readEditor(sessionId: string): EditorState {
  const stored = readStore().sessions[sessionId];
  if (!stored) return emptyEditor();
  const files = (Array.isArray(stored.files) ? stored.files : [])
    .filter((file): file is EditorFile => Boolean(file) && typeof file.path === "string" && file.path.length > 0 && VIEWS.has(file.view))
    .filter((file, index, all) => all.findIndex((other) => other.path === file.path) === index)
    .map((file) => ({ path: file.path, view: file.view, pinned: Boolean(file.pinned) }));
  const activePath = files.some((file) => file.path === stored.activePath) ? stored.activePath : files[files.length - 1]?.path;
  return {
    files,
    ...(activePath ? { activePath } : {}),
    // Absent means "never chosen", and the tree open is the useful default.
    explorerOpen: stored.explorerOpen !== false,
  };
}

/** Forget one key's files. The canvas clears its own after handing them to
 *  the session it created — see `clearPanelTabs` for why the hand-off must
 *  not also become a default for every later conversation. */
export function clearEditor(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    if (!(sessionId in store.sessions)) return;
    delete store.sessions[sessionId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage must not break the editor.
  }
}

export function writeEditor(sessionId: string, state: EditorState, now: number): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    // Trimmed from the FRONT: the newest files are the ones at the end.
    const files = state.files.slice(-FILE_CAP);
    store.sessions[sessionId] = {
      files,
      ...(state.activePath && files.some((file) => file.path === state.activePath) ? { activePath: state.activePath } : {}),
      explorerOpen: state.explorerOpen,
      touchedAt: now,
    };
    const entries = Object.entries(store.sessions);
    if (entries.length > SESSION_CAP) {
      store.sessions = Object.fromEntries(entries.sort(([, a], [, b]) => b.touchedAt - a.touchedAt).slice(0, SESSION_CAP));
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage must not break the editor.
  }
}

/**
 * WHAT A PANEL SAVED BY THE PREVIOUS BUILD MEANT.
 *
 * Before the Editor, every open file was a top-level panel tab (`file:src/a.ts`,
 * `notebook:…`, `table:…`, `pdf:…`). Those ids are still in localStorage for
 * every session anybody had open, and dropping them on upgrade would close the
 * files somebody left open — the exact thing the Editor exists to stop
 * happening. So they restore as the Editor's files, in their original order,
 * PINNED: they were deliberate opens under the old rules, and demoting them to
 * one shared preview slot would throw all but one of them away.
 */
export function editorFromLegacyTabs(tabs: readonly string[], activeTab?: string): EditorState | undefined {
  const legacy: Record<string, EditorView> = { "file:": "code", "notebook:": "notebook", "table:": "table", "pdf:": "pdf" };
  const files: EditorFile[] = [];
  let activePath: string | undefined;
  for (const tab of tabs) {
    for (const [prefix, view] of Object.entries(legacy)) {
      if (!tab.startsWith(prefix) || tab.length === prefix.length) continue;
      const path = tab.slice(prefix.length);
      if (!files.some((file) => file.path === path)) files.push({ path, view, pinned: true });
      if (tab === activeTab) activePath = path;
      break;
    }
  }
  if (files.length === 0) return undefined;
  return { files, activePath: activePath ?? files[files.length - 1]!.path, explorerOpen: true };
}
