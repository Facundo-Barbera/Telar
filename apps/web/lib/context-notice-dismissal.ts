const PREFIX = "telar:context-notice-dismissed:";

export type DismissalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Undefined during the server render and when the browser has storage disabled. */
function resolve(storage?: DismissalStorage): DismissalStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function readContextNoticeDismissed(sessionId: string, storage?: DismissalStorage): boolean {
  const store = resolve(storage);
  if (!store) return false;
  try {
    return store.getItem(key(sessionId)) !== null;
  } catch {
    return false;
  }
}

export function writeContextNoticeDismissed(sessionId: string, storage?: DismissalStorage): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    store.setItem(key(sessionId), "1");
  } catch {
    // A full or disabled localStorage must not break the dismiss button.
  }
}

export function clearContextNoticeDismissed(sessionId: string, storage?: DismissalStorage): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    store.removeItem(key(sessionId));
  } catch {
    // Ignored for the same reason as the write.
  }
}

/**
 * Clears the stored dismissal when `heavy` is false, so the notice re-arms after compaction.
 * Pass the id just dismissed as `justDismissed`; the storage write lands after this render.
 */
export function contextNoticeDismissal(
  input: { sessionId: string | undefined; heavy: boolean; justDismissed?: string },
  storage?: DismissalStorage,
): boolean {
  const { sessionId, heavy, justDismissed } = input;
  if (!sessionId) return false;
  if (!heavy) {
    clearContextNoticeDismissed(sessionId, storage);
    return false;
  }
  return justDismissed === sessionId || readContextNoticeDismissed(sessionId, storage);
}
