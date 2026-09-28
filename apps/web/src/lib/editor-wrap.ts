/** Soft-wrap preference for the file editor; presentation only, saved bytes are unchanged. */
import { fileKind, type FileKind } from "@/lib/file-kinds";

const STORAGE_KEY = "telar:editor-wrap";

/** Prose files get the toggle. `doc` alone is not enough: a PDF is a `doc` with its own viewer. */
export function isProseFile(kind: FileKind): boolean {
  if (kind.binary || kind.viewer) return false;
  return kind.glyph === "doc" || kind.glyph === "text";
}

export function isProsePath(path: string): boolean {
  return isProseFile(fileKind(path));
}

/** Absent means off. */
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

/** Cached for `useSyncExternalStore`, which needs a stable snapshot; shared by every editor. */
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

/** Must be identical on the highlighted layer and the textarea above it, or the caret drifts. */
export const WRAP_CLASS = "whitespace-pre-wrap break-words";
export const NOWRAP_CLASS = "whitespace-pre";
