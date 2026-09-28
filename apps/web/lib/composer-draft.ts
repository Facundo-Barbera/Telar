/**
 * Unsent composer text per session (a fresh canvas keyed by project), kept in localStorage.
 * Canvas drafts are also listed in the rail; session drafts are not, as that session already has a row.
 */

const PREFIX = "telar:draft:";
/** The canvas half of the namespace: no session yet, so keyed by project. */
const CANVAS = `${PREFIX}new:`;
/** Long enough for a real message, short of filling the quota with one key. */
const MAX_DRAFT = 20_000;

/** Same-window change event, since `storage` does not fire in the tab that wrote. No payload: listeners re-read storage. */
export const DRAFTS_CHANGED_EVENT = "telar:drafts";

function announceDraftsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DRAFTS_CHANGED_EVENT));
}

/** Just the shape used here, so a test can pass a Map without faking `Storage`. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;

/** Undefined during the server render or when the browser has storage disabled. */
function resolve(storage?: DraftStorage): DraftStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** No session is a fresh canvas, keyed by project; a project-less session always has a session id. */
function key(sessionId: string | undefined, projectId: string | undefined): string {
  return `${PREFIX}${sessionId ?? `new:${projectId ?? "none"}`}`;
}

/** `updatedAt` orders the rail's draft rows. */
type Stored = { text: string; updatedAt: number };

/**
 * Also reads the legacy bare-string shape, as text with no known age: it sorts
 * last until the next keystroke re-dates it.
 */
function parse(raw: string | null): Stored | undefined {
  if (raw === null) return undefined;
  if (!raw.startsWith("{")) return raw.trim() ? { text: raw, updatedAt: 0 } : undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { text, updatedAt } = value as { text?: unknown; updatedAt?: unknown };
    if (typeof text !== "string" || !text.trim()) return undefined;
    return { text, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
  } catch {
    return undefined;
  }
}

export function readDraft(
  sessionId: string | undefined,
  projectId: string | undefined,
  storage?: DraftStorage,
): string {
  const store = resolve(storage);
  if (!store) return "";
  try {
    return parse(store.getItem(key(sessionId, projectId)))?.text ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(
  sessionId: string | undefined,
  projectId: string | undefined,
  draft: string,
  storage?: DraftStorage,
): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    // An empty draft removes the key rather than leaving an empty entry behind.
    if (!draft.trim()) store.removeItem(key(sessionId, projectId));
    else
      store.setItem(
        key(sessionId, projectId),
        JSON.stringify({ text: draft.slice(0, MAX_DRAFT), updatedAt: Date.now() } satisfies Stored),
      );
  } catch {
    // A full or disabled localStorage must never break typing.
  }
  // Announced even when the write threw: listeners re-read storage, and staying
  // quiet after a failed write can leave a deleted draft on screen.
  announceDraftsChanged();
}

/** A started conversation that has no session yet. One per project, at most. */
export type CanvasDraft = { projectId: string; text: string; updatedAt: number };

/** Every canvas draft, newest first. Scans storage rather than keeping an index that could go stale. */
export function listCanvasDrafts(storage?: DraftStorage): CanvasDraft[] {
  const store = resolve(storage);
  if (!store) return [];
  const drafts: CanvasDraft[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (!name?.startsWith(CANVAS)) continue;
      const projectId = name.slice(CANVAS.length);
      const stored = parse(store.getItem(name));
      if (projectId && stored) drafts.push({ projectId, text: stored.text, updatedAt: stored.updatedAt });
    }
  } catch {
    return drafts;
  }
  return drafts.sort((left, right) => right.updatedAt - left.updatedAt || left.projectId.localeCompare(right.projectId));
}
