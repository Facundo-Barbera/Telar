"use client";

// Applies the user's theme preference (System / Light / Dark) to
// document.documentElement by toggling the `.dark` class — the class the
// Tailwind `dark` variant keys off (globals.css: `@custom-variant dark
// (&:is(.dark *))`). Production shipped dark hard-coded on <html>; this is the
// hand-rolled equivalent of next-themes (which is NOT a dependency), reading the
// pref from the shared ui-prefs store.
//
// Two halves keep the switch flash-free:
//   1. THEME_INIT_SCRIPT runs synchronously in <head> BEFORE first paint, so the
//      correct class is on <html> before the body renders (no light→dark flash).
//   2. This component keeps the class in sync afterwards — reacting to pref
//      changes and, in System mode, to the OS color-scheme media query.
//
// CLIENT-BUNDLE RULE: imports only the client-safe ui-prefs store; nothing here
// reaches the Agent SDK or server-only code. Renders nothing.

import { useEffect } from "react";
import { useUiPrefs } from "@/lib/ui-prefs";

// Kept in sync with lib/ui-prefs.ts (KEY + DEFAULT_PREFS.theme). Inlined as a
// plain dependency-free string so it can run in <head> before hydration. Falls
// back to dark on any error — the historical default — so a broken/empty store
// never leaves the shell unstyled.
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('telar-ui-prefs');var t='dark';if(p){var v=JSON.parse(p).theme;if(v==='light'||v==='dark'||v==='system')t=v;}var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

export function ThemeProvider() {
  const { theme } = useUiPrefs();

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };
    apply();
    // In System mode, track the OS scheme so the shell follows it live.
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  return null;
}
