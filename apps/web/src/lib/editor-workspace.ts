/**
 * Files open inside one Editor surface, separate from the panel's surface tabs.
 * A single click borrows one reusable preview slot; a double click or first
 * keystroke pins. The preview never holds edited work, so replacing it is safe.
 */

import { fileKind } from "@/lib/file-kinds";
import { viewerAvailable } from "@/features/plugins";

/** Notebooks and tables need the project's data-science plugin; markdown is `code`. */
export type EditorView = "code" | "notebook" | "table" | "pdf";

export type EditorFile = {
  path: string;
  view: EditorView;
  /** Unpinned is the preview; at most one exists. */
  pinned: boolean;
};

export type EditorState = {
  files: EditorFile[];
  activePath?: string;
  /** Collapsible: at 384px a tree and a file can't both be read. */
  explorerOpen: boolean;
};

/** Kept while the Editor is mounted, never persisted: the file may have been rewritten since. */
export type EditorViewState = { selectionStart: number; selectionEnd: number; scrollTop: number; scrollLeft: number };

export type OpenIntent = "preview" | "pin";

export function emptyEditor(): EditorState {
  return { files: [], explorerOpen: true };
}

/** A notebook always pins: its unsaved state lives outside the textarea that pins on keystroke. */
export function editorFileForPath(path: string, enabledPlugins: readonly string[]): { path: string; view: EditorView } {
  const viewer = fileKind(path).viewer;
  return { path, view: viewer && viewerAvailable(viewer, enabledPlugins) ? viewer : "code" };
}

function intentFor(view: EditorView, intent: OpenIntent): OpenIntent {
  return view === "notebook" ? "pin" : intent;
}

/** Already open wins and keeps its pin. */
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
  // Replaced in place so the strip doesn't reshuffle under the pointer.
  const preview = state.files.findIndex((entry) => !entry.pinned);
  const files =
    preview === -1
      ? [...state.files, opened]
      : state.files.map((entry, index) => (index === preview ? opened : entry));
  return { ...state, files, activePath: file.path };
}

/** Promotes the preview; what the first keystroke and a double click do. */
export function pinEditorFile(state: EditorState, path: string): EditorState {
  if (!state.files.some((entry) => entry.path === path && !entry.pinned)) return state;
  return { ...state, files: state.files.map((entry) => (entry.path === path ? { ...entry, pinned: true } : entry)) };
}

/** Next active is the right-hand neighbour, else the new last file. */
export function closeEditorFile(state: EditorState, path: string): EditorState {
  const index = state.files.findIndex((entry) => entry.path === path);
  if (index === -1) return state;
  const files = state.files.filter((entry) => entry.path !== path);
  // `activePath` must be absent, not undefined, or a restore reads a key naming nothing.
  if (files.length === 0) return { files, explorerOpen: state.explorerOpen };
  const activePath = state.activePath === path ? (files[index]?.path ?? files[files.length - 1]!.path) : state.activePath;
  return { ...state, files, ...(activePath ? { activePath } : {}) };
}

/**
 * Names the paths "Close others" sweeps, in strip order, instead of closing them:
 * each goes through the surface's own close so a refused save still confirms.
 * A path not open yields nothing.
 */
export function otherEditorPaths(state: EditorState, path: string): string[] {
  if (!state.files.some((entry) => entry.path === path)) return [];
  return state.files.filter((entry) => entry.path !== path).map((entry) => entry.path);
}

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

export function activeEditorFile(state: EditorState): EditorFile | undefined {
  return state.files.find((entry) => entry.path === state.activePath);
}

export function editorPaths(state: EditorState): string[] {
  return state.files.map((entry) => entry.path);
}

const STORAGE_KEY = "telar:editor";
const VERSION = 1;
/** LRU by `touchedAt`; unbounded growth becomes a quota failure. */
const SESSION_CAP = 24;
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
    // A schema bump discards rather than migrates; it's only a list of paths.
    if (store.version !== VERSION || typeof store.sessions !== "object") return { version: VERSION, sessions: {} };
    return store;
  } catch {
    return { version: VERSION, sessions: {} };
  }
}

const VIEWS: ReadonlySet<string> = new Set<EditorView>(["code", "notebook", "table", "pdf"]);

/** Validated so a view kind this build dropped doesn't restore as a blank pane. */
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
    explorerOpen: stored.explorerOpen !== false,
  };
}

/** The canvas clears its own after handing them off; see `clearPanelTabs`. */
export function clearEditor(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    if (!(sessionId in store.sessions)) return;
    delete store.sessions[sessionId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Full or disabled storage must not break the editor.
  }
}

export function writeEditor(sessionId: string, state: EditorState, now: number): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    // Trimmed from the front: the newest files are at the end.
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
    // Full or disabled storage must not break the editor.
  }
}
