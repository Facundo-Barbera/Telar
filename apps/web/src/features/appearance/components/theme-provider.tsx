"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "telar-theme";
const PREVIOUS_STORAGE_KEY = "telar-vnext-theme";
const DEFAULT_THEME: Theme = "dark";

/** Runs in <head> before first paint; falls back to dark on any error. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}')||localStorage.getItem('${PREVIOUS_STORAGE_KEY}')||'${DEFAULT_THEME}';if(t!=='light'&&t!=='dark'&&t!=='system')t='${DEFAULT_THEME}';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function readTheme(): Theme {
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
    (window as { telarDesktop?: { appearance?: { setTheme?: (t: Theme) => void } } }).telarDesktop?.appearance?.setTheme?.(theme);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);

  return children;
}
