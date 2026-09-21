/**
 * A DISMISS THAT SURVIVES THE RELOAD.
 *
 * It used to be `useState` in the composer, which meant it survived nothing: a
 * reload, a switch to another conversation and back, a re-render that remounted
 * the tree — any of them and the banner was there again, on a session whose
 * owner had already answered it. Telling someone the same thing three times in
 * a morning is how a notice stops being read at all.
 *
 * KEYED PER SESSION, in localStorage, with the idiom composer-draft.ts uses for
 * the same reason: a missing `window` during the server render and a browser
 * with storage disabled are the same answer here — not dismissed, no throw.
 *
 * AND IT RE-ARMS, DELIBERATELY. A dismiss means "not this one", not "never for
 * this session". So the flag is cleared the moment the share falls back below
 * the threshold — which is what compacting does — and a session that climbs all
 * the way back up is heavy again in a way it was not when the notice was waved
 * away. Without this the first dismiss would be permanent for the life of the
 * conversation, and the one moment the banner is genuinely worth showing is the
 * second climb.
 */

const PREFIX = "telar:context-notice-dismissed:";

/** Just the shape used here, so a test can pass a Map without faking `Storage`. */
export type DismissalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The store, or nothing at all.
 *
 * Absent during the server render, and absent again when a browser has storage
 * disabled. Both are the same answer to every caller here: not dismissed.
 */
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

/** Presence IS the flag — there is nothing to record but "yes". */
export function writeContextNoticeDismissed(sessionId: string, storage?: DismissalStorage): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    store.setItem(key(sessionId), "1");
  } catch {
    // A full or disabled localStorage must never break a dismiss button: the
    // banner still goes for this render, it just comes back on the next load.
  }
}

export function clearContextNoticeDismissed(sessionId: string, storage?: DismissalStorage): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    store.removeItem(key(sessionId));
  } catch {
    // Same bargain as the write.
  }
}

/**
 * Is this session's heavy-context notice already answered?
 *
 * THE WHOLE RULE IN ONE EXPRESSION, so the composer can memoise it on the share
 * rather than chase it with an effect. An effect would run after the render
 * that had already decided whether to draw the banner, which on a compacted
 * session is a frame of a notice nobody should see.
 *
 * IT CLEARS ON THE WAY DOWN, which is the re-arm described at the top of this
 * file: `heavy` false is the only place that knows the session dropped back
 * under the threshold, and clearing there costs one `removeItem` on a key that
 * is usually already gone.
 *
 * `justDismissed` IS THE CLICK NOT YET READ BACK. The write happens after this
 * render computed its answer, so the caller hands over the id it just dismissed
 * and the banner leaves on the same commit as the press.
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
