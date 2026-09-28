"use client";

/**
 * Writes the compiled composition as CSS variables under #app-backdrop. The
 * light/dark choice is made in globals.css so an OS scheme flip needs no script.
 * Keep BACKDROP_INIT_SCRIPT in sync with applyBackdrop.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export {
  isGradientValue,
  isSceneValue,
} from "@telar/engine-client";

export const BACKDROP_CSS_KEY = "telar-backdrop-compiled";

/**
 * Flat so BACKDROP_INIT_SCRIPT can walk it by name. Only `light` and `dark` are
 * always present; a bare state carries "none" and the CSS falls through to its canvas.
 */
export type BackdropCss = {
  light: string;
  dark: string;
  sizeLight?: string;
  positionLight?: string;
  repeatLight?: string;
  sizeDark?: string;
  positionDark?: string;
  repeatDark?: string;
};

/** The CSS variable each member writes. The init script inlines this table. */
const BACKDROP_VARS: ReadonlyArray<readonly [keyof BackdropCss, string]> = [
  ["light", "--backdrop-light"],
  ["dark", "--backdrop-dark"],
  ["sizeLight", "--backdrop-size-light"],
  ["positionLight", "--backdrop-position-light"],
  ["repeatLight", "--backdrop-repeat-light"],
  ["sizeDark", "--backdrop-size-dark"],
  ["positionDark", "--backdrop-position-dark"],
  ["repeatDark", "--backdrop-repeat-dark"],
];

const listeners = new Set<() => void>();

export function subscribeBackdropCss(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function listValue(candidate: unknown): string | undefined {
  return typeof candidate === "string" && candidate.length > 0 && !candidate.includes(";") && !candidate.includes("}") ? candidate : undefined;
}

/** Total: anything unrecognised is "no scene", so a stale value can never wedge the window. */
export function parseBackdropCss(raw: string | null): BackdropCss | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const light = listValue(record.light);
    if (!light) return null;
    const css: BackdropCss = { light, dark: listValue(record.dark) ?? light };
    for (const [member] of BACKDROP_VARS) {
      if (member === "light" || member === "dark") continue;
      const value = listValue(record[member]);
      if (value) css[member] = value;
    }
    return css;
  } catch {
    return null;
  }
}

let cache: { raw: string | null; value: BackdropCss | null } | undefined;

function readBackdropCss(): BackdropCss | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BACKDROP_CSS_KEY);
  } catch {
    // Private browsing: no scene, not an error.
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseBackdropCss(raw) };
  return cache.value;
}

/** Write the compiled backdrop, or clear it. Only the composition's apply calls this. */
export function setBackdropCss(css: BackdropCss | null): void {
  try {
    if (css === null) window.localStorage.removeItem(BACKDROP_CSS_KEY);
    else window.localStorage.setItem(BACKDROP_CSS_KEY, JSON.stringify(css));
  } catch {
    // Quota or private browsing: in-page listeners still repaint.
  }
  cache = undefined;
  for (const listener of listeners) listener();
}

export function useBackdropCss(): { backdrop: BackdropCss | null; setBackdrop: (next: BackdropCss | null) => void } {
  const backdrop = useSyncExternalStore(subscribeBackdropCss, readBackdropCss, () => null);
  const set = useCallback((next: BackdropCss | null) => setBackdropCss(next), []);
  return useMemo(() => ({ backdrop, setBackdrop: set }), [backdrop, set]);
}

/** Mirrored by BACKDROP_INIT_SCRIPT; globals.css does the painting. */
export function applyBackdrop(css: BackdropCss | null): void {
  const root = document.documentElement;
  for (const [, name] of BACKDROP_VARS) root.style.removeProperty(name);
  if (css === null) {
    root.removeAttribute("data-backdrop");
    return;
  }
  root.setAttribute("data-backdrop", "scene");
  for (const [member, name] of BACKDROP_VARS) {
    const value = css[member];
    if (value) root.style.setProperty(name, value);
  }
}

/** Pre-paint application: inline in <head>, dependency-free, fails to "no scene". */
export const BACKDROP_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var c=JSON.parse(localStorage.getItem('${BACKDROP_CSS_KEY}')||'null');if(!c||typeof c!=='object'||typeof c.light!=='string')return;d.setAttribute('data-backdrop','scene');${JSON.stringify(
  BACKDROP_VARS.map(([member, name]) => [member, name]),
)}.forEach(function(p){var v=c[p[0]];if(typeof v==='string'&&v)d.style.setProperty(p[1],v);});}catch(e){}})();`;
