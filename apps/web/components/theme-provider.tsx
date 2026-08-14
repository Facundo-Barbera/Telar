"use client";

/**
 * Appearance, in two halves.
 *
 * Tailwind's `dark` variant keys off a class on <html> (globals.css:
 * `@custom-variant dark (&:is(.dark *))`), so something has to put it there.
 *
 *   1. THEME_INIT_SCRIPT runs SYNCHRONOUSLY in <head>, before first paint, so
 *      the correct class is on <html> before the body renders. Without it a
 *      dark-mode user gets a full white frame on every navigation — the classic
 *      theme flash — because React cannot run before the document paints.
 *   2. This component keeps the class in sync afterwards: it reacts to the
 *      user's choice and, in `system` mode, to the OS preference changing while
 *      the app is open.
 *
 * Hand-rolled rather than next-themes: this is the whole of what that library
 * would be used for here, and the cockpit's dependency list is worth defending.
 *
 * THE PREFERENCE IS AN EXTERNAL STORE, not mirrored state. It lives in
 * localStorage, which React does not own, so it is read with
 * `useSyncExternalStore` — that gives the right value during the FIRST render
 * (no effect-driven catch-up, no cascading render) and a distinct server
 * snapshot, which is what keeps hydration honest.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useEffect } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "telar-theme";
/**
 * The key this preference used while the app was called vNext.
 *
 * READ, NEVER WRITTEN. localStorage is keyed by ORIGIN, so an existing install
 * keeps its old entry across the rename and would otherwise silently revert to
 * the default — a light-theme reader gets a dark window at their next launch and
 * has no way to know why. One fallback read is the whole migration.
 */
const PREVIOUS_STORAGE_KEY = "telar-vnext-theme";
const DEFAULT_THEME: Theme = "dark";

/**
 * Kept in sync with STORAGE_KEY and DEFAULT_THEME. Inlined as a plain
 * dependency-free string because it has to run before any bundle loads. Falls
 * back to dark on ANY error, so a corrupt or empty store never leaves the shell
 * unstyled.
 *
 * It reads the old key too, because THIS is the code that decides what the very
 * first paint looks like: a fallback only in `readTheme` would still flash the
 * default before React ever ran.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}')||localStorage.getItem('${PREVIOUS_STORAGE_KEY}')||'${DEFAULT_THEME}';if(t!=='light'&&t!=='dark'&&t!=='system')t='${DEFAULT_THEME}';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

/** Local writes do not fire `storage` (that event is for OTHER tabs), so the
 *  store keeps its own listener set and notifies on every write. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // A second tab changing the preference should follow here too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(PREVIOUS_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function writeTheme(next: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private browsing or a full quota. The choice still applies for this
    // session; only its persistence is lost, and that is not worth an error.
  }
  for (const listener of listeners) listener();
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);
  const setTheme = useCallback((next: Theme) => writeTheme(next), []);
  return useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };
    apply();
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);

  return children;
}
