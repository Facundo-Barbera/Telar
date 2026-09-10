/**
 * "Wrap lines" — whether the file editor soft-wraps.
 *
 * Presentation only: no newline is ever inserted and the saved bytes are
 * identical either way. One preference for the reader, stored under a
 * `telar:` key like the composer's drafts; a browser with no storage gets the
 * default rather than an error.
 */
import { fileKind, type FileKind } from "@/lib/file-kinds";

const STORAGE_KEY = "telar:editor-wrap";

/**
 * Prose — the kind the toggle is offered for. Read off the existing
 * classification rather than a second extension list. `doc` alone is not
 * enough: a PDF is a `doc` too, and it is bytes opened by its own viewer.
 * Code keeps its horizontal scroll, where a wrapped line hides indentation.
 */
export function isProseFile(kind: FileKind): boolean {
  if (kind.binary || kind.viewer) return false;
  return kind.glyph === "doc" || kind.glyph === "text";
}

export function isProsePath(path: string): boolean {
  return isProseFile(fileKind(path));
}

/** Absent means off — the option adds a behaviour, it does not change one. */
export function readWrapLines(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeWrapLines(wrap: boolean, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, wrap ? "1" : "0");
  } catch {
    // A full or disabled localStorage must not break the editor.
  }
  cached = wrap;
  for (const listener of listeners) listener();
}

/**
 * Read through `useSyncExternalStore`: the preference lives outside React, so
 * an effect would paint one frame of the wrong layout. The snapshot is cached
 * because the hook requires a stable value, and every open editor shares it.
 */
const listeners = new Set<() => void>();
let cached: boolean | undefined;

export function subscribeWrapLines(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function wrapLinesSnapshot(): boolean {
  if (cached === undefined) cached = readWrapLines();
  return cached;
}

/** The server has no storage, so it renders the default and hydration agrees. */
export function serverWrapLinesSnapshot(): boolean {
  return false;
}

function safeStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Must be IDENTICAL on the highlighted layer and the textarea above it, or
 *  the caret drifts. `break-words` stops one unbroken token from restoring the
 *  overflow the toggle exists to remove. */
export const WRAP_CLASS = "whitespace-pre-wrap break-words";
export const NOWRAP_CLASS = "whitespace-pre";
