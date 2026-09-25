/**
 * A SESSION WAS JUST MARKED READ — the hook desktop notifications take down
 * their own alert from.
 *
 * FIRED FROM THE RECEIPT ROUTE (`app/api/sessions/[sessionId]/read`), after
 * the engine accepted it. Both the cockpit and the phone send receipts through
 * that one route, so a read on either device reaches every subscriber. The
 * engine's unread pair stays the only read state; this is a nudge in-process,
 * never a record, so a listener that needs the truth re-reads the session.
 *
 * ON `globalThis`, like the mobile worker's state, so a hot reload or a second
 * copy of this module shares one set of listeners rather than splitting them.
 */
type Listener = (sessionId: string) => void;
const store = globalThis as typeof globalThis & { telarSessionReadListeners?: Set<Listener> };
const listeners = (store.telarSessionReadListeners ??= new Set());

/** Subscribe; returns the unsubscribe. */
export function onSessionRead(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One listener throwing must not stop the others, nor fail the receipt. */
export function emitSessionRead(sessionId: string): void {
  for (const listener of [...listeners]) {
    try { listener(sessionId); } catch { /* A subscriber's bug is its own. */ }
  }
}
