"use client";

/**
 * THE BRIEF STRIP'S DISMISS STATE — §13.8 (2026-08-19), "the map is content,
 * not chrome": a subject room's brief shrinks to a dismissible strip, and
 * "dismiss" remembers per subject rather than resetting every visit. Keyed
 * by the subject's own key, the same `lib/spool-area-collapse.ts` shape:
 * a UI preference, never a fact the store owns, so it lives in `localStorage`
 * and is read after mount — the key does not exist during the server render,
 * so seeding `useState` from it would desync hydration.
 */
import { useCallback, useEffect, useState } from "react";

const KEY_PREFIX = "telar:spool-brief-dismissed:";

export function useBriefDismiss(subjectKey: string): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setDismissed(window.localStorage.getItem(KEY_PREFIX + subjectKey) === "1");
    } catch {
      // An unreadable localStorage leaves the brief showing — the safer default.
    }
  }, [subjectKey]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY_PREFIX + subjectKey, "1");
    } catch {
      // A full or disabled localStorage must not break the dismiss gesture —
      // it just will not survive the next visit.
    }
  }, [subjectKey]);

  return { dismissed, dismiss };
}
