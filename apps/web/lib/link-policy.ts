"use client";

/**
 * WHERE A LINK IN A CONVERSATION OPENS — the system browser, or this session's.
 *
 * Off, a click behaves the way the web behaves: a new tab in whatever browser
 * the machine defaults to. On, the cockpit keeps the reading in the cockpit:
 * an issue or pull request the session mentions opens as its own right-panel
 * tab, and any other link opens as a tab in the session's integrated browser —
 * the same tabs the agent's `browser_*` tools drive, so what you opened is
 * what it can act on.
 *
 * LOCAL STORAGE, NOT ENGINE STATE, and deliberately so: `session-defaults.ts`
 * lives on the engine because the ENGINE reads that document on the create
 * path. Nothing engine-side ever reads this — it decides what a click in THIS
 * window does, and the desktop shell (which has a native browser to open into)
 * and a phone (which does not) are right to answer differently.
 *
 * Same-window CustomEvent for cross-component sync, the `useSessionDefaults`
 * pattern: the settings row flips it, the transcript reads it, neither polls.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "telar:open-links-in-session-browser";
const CHANGED = "telar:link-policy";

/** The live answer, for handlers that are not hooks. */
export function openLinksInSessionBrowser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useLinkPolicy(): { openInSessionBrowser: boolean; setOpenInSessionBrowser: (next: boolean) => void } {
  const [openInSessionBrowser, setState] = useState(false);

  useEffect(() => {
    // Deferred a tick, like every loader here: setting state from an effect
    // BODY is the cascade the lint rule forbids — and the read is client-only,
    // so the first render must agree with the server's anyway.
    const task = window.setTimeout(() => setState(openLinksInSessionBrowser()), 0);
    const onChanged = (event: Event) => setState(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(CHANGED, onChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(CHANGED, onChanged);
    };
  }, []);

  const setOpenInSessionBrowser = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // Storage denied costs persistence, not the flip in front of you.
    }
    window.dispatchEvent(new CustomEvent<boolean>(CHANGED, { detail: next }));
  }, []);

  return { openInSessionBrowser, setOpenInSessionBrowser };
}
