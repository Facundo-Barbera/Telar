"use client";

/**
 * THE BRIEF STRIP'S DISMISS STATE — §13.8 (2026-08-19), "the map is content,
 * not chrome": a subject room's brief shrinks to a dismissible strip, and
 * "dismiss" remembers per subject rather than resetting every visit. Keyed
 * by the subject's own key, the same `lib/spool-area-collapse.ts` shape:
 * a UI preference, never a fact the store owns, so it lives in `localStorage`
 * and is read after mount — the key does not exist during the server render,
 * so seeding `useState` from it would desync hydration.
 *
 * READ THROUGH `useSyncExternalStore`, NOT A MOUNT EFFECT. The earlier shape
 * was `useState(false)` plus an effect that called `setDismissed` — a second
 * render pass on every mount, which the React compiler flags as a cascading
 * render. `useSyncExternalStore` is the hook built for exactly this: a value
 * that lives outside React, with a SEPARATE server snapshot, so the hydration
 * mismatch the header warns about is handled by React rather than by us
 * deferring the read. `localStorage` fires no event for same-document writes,
 * so the module keeps its own subscriber list and `dismiss` notifies it —
 * which also means two strips for one subject now agree, where before each
 * held its own copy.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY_PREFIX = "telar:spool-brief-dismissed:";

const listeners = new Set<() => void>();

/** THE GESTURE STILL WORKS WITHOUT STORAGE. A disabled or full `localStorage`
 *  must not turn "dismiss" into a no-op — it only costs the memory of it after
 *  a reload, which is what the write's own catch says. */
const dismissedThisSession = new Set<string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(subjectKey: string): boolean {
  if (dismissedThisSession.has(subjectKey)) return true;
  try {
    return window.localStorage.getItem(KEY_PREFIX + subjectKey) === "1";
  } catch {
    // An unreadable localStorage leaves the brief showing — the safer default.
    return false;
  }
}

export function useBriefDismiss(subjectKey: string): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => read(subjectKey),
    // The server has no localStorage, and a brief that starts open is the
    // safe half of the mismatch: it shows, then folds on the client's read.
    () => false,
  );

  const dismiss = useCallback(() => {
    dismissedThisSession.add(subjectKey);
    try {
      window.localStorage.setItem(KEY_PREFIX + subjectKey, "1");
    } catch {
      // A full or disabled localStorage must not break the dismiss gesture —
      // it just will not survive the next visit.
    }
    for (const listener of listeners) listener();
  }, [subjectKey]);

  return { dismissed, dismiss };
}
