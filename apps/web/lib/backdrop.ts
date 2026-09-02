"use client";

/**
 * THE BACKDROP — a scene of the reader's choosing UNDER the whole app.
 *
 * Layout renders one fixed, empty `#app-backdrop` div as the first child of
 * body; everything here is about what that div paints. A backdrop can be a
 * crafted gradient preset, a custom gradient, or an image the reader dropped
 * in — and choosing any of them flips `data-backdrop` on <html>, which pulls
 * the SAME see-through wash the desktop translucency mode uses (globals.css
 * gates those rules on either attribute). The app's grounds go glassy over
 * whatever the scene is: the desktop through a translucent window, or a
 * gradient in a plain browser tab. One mechanism, two windows onto it.
 *
 * STORAGE IS THREE KEYS because the payloads have three lifetimes:
 *   - BACKDROP_KEY        the choice itself (small JSON, parsed pre-paint)
 *   - BACKDROP_CSS_KEY    resolved {light, dark} background-image values —
 *                         written AT CHOICE TIME so the init script never
 *                         needs the preset table to paint frame one
 *   - BACKDROP_IMAGE_KEY  the image as a data URL (big; only read when the
 *                         choice says kind "image")
 *
 * BACKDROP_INIT_SCRIPT mirrors applyBackdrop for the same reason
 * APPEARANCE_INIT_SCRIPT exists: a scene applied one render late is a flash
 * of bare canvas on every launch. Keep the two in sync.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type BackdropFit = "cover" | "fill" | "tile";
export const BACKDROP_FITS = ["cover", "fill", "tile"] as const;

export type Backdrop =
  | { kind: "none" }
  | { kind: "gradient"; id: string }
  | { kind: "custom-gradient"; light: string; dark: string }
  | { kind: "image"; fit: BackdropFit; blur: number; dim: number };

/** Resolved CSS `background-image` values, one per colour scheme. Presets and
 *  custom gradients both resolve to this shape; the dark half falls back to
 *  the light one in CSS if a source only has one. */
export type BackdropLayers = { light: string; dark: string };

export const BACKDROP_KEY = "telar-backdrop";
export const BACKDROP_CSS_KEY = "telar-backdrop-css";
export const BACKDROP_IMAGE_KEY = "telar-backdrop-image";

export const MAX_BACKDROP_BLUR = 40; // px
export const MAX_BACKDROP_DIM = 80; // %

export const DEFAULT_BACKDROP: Backdrop = { kind: "none" };

/**
 * A custom gradient string becomes a CSS variable via CSSOM setProperty —
 * which cannot escape the declaration — but a nonsense value silently paints
 * nothing, so writes are gated on looking like an actual gradient list.
 */
export function isGradientValue(value: unknown): value is string {
  return typeof value === "string" && /gradient\(/.test(value) && !value.includes(";") && !value.includes("}") && !/url\s*\(/i.test(value);
}

function clamp(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
}

/** Total, like parseAppearance: anything unrecognised is "none", so a stale
 *  or hand-edited value can never wedge the store. */
export function parseBackdrop(raw: string | null): Backdrop {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_BACKDROP;
    const record = parsed as Record<string, unknown>;
    if (record.kind === "gradient" && typeof record.id === "string" && record.id.length > 0) {
      return { kind: "gradient", id: record.id };
    }
    if (record.kind === "custom-gradient" && isGradientValue(record.light)) {
      return { kind: "custom-gradient", light: record.light, dark: isGradientValue(record.dark) ? record.dark : record.light };
    }
    if (record.kind === "image") {
      const fit = BACKDROP_FITS.includes(record.fit as BackdropFit) ? (record.fit as BackdropFit) : "cover";
      return { kind: "image", fit, blur: clamp(record.blur, MAX_BACKDROP_BLUR), dim: clamp(record.dim, MAX_BACKDROP_DIM) };
    }
    return DEFAULT_BACKDROP;
  } catch {
    return DEFAULT_BACKDROP;
  }
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

let cache: { raw: string | null; value: Backdrop } | undefined;

function readBackdrop(): Backdrop {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BACKDROP_KEY);
  } catch {
    // Private browsing: no scene, not an error.
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseBackdrop(raw) };
  return cache.value;
}

/**
 * Gradient kinds MUST arrive with their resolved layers: the choice and the
 * CSS are written together so the init script can paint frame one without the
 * preset table. An image choice resolves through BACKDROP_IMAGE_KEY instead
 * (written by the image picker before it calls this).
 */
export function setBackdrop(next: Backdrop, resolved?: BackdropLayers): void {
  try {
    window.localStorage.setItem(BACKDROP_KEY, JSON.stringify(next));
    if (next.kind === "gradient" || next.kind === "custom-gradient") {
      if (!resolved) throw new Error("setBackdrop: gradient choices need resolved layers");
      window.localStorage.setItem(BACKDROP_CSS_KEY, JSON.stringify(resolved));
    } else {
      window.localStorage.removeItem(BACKDROP_CSS_KEY);
    }
    if (next.kind !== "image") window.localStorage.removeItem(BACKDROP_IMAGE_KEY);
  } catch {
    // Quota or private browsing: the in-memory cache below still carries the
    // choice for this session (images may simply not fit — the picker warns).
    cache = { raw: null, value: next };
  }
  cache = undefined;
  for (const listener of listeners) listener();
}

export function useBackdrop(): { backdrop: Backdrop; setBackdrop: (next: Backdrop, resolved?: BackdropLayers) => void } {
  const backdrop = useSyncExternalStore(subscribe, readBackdrop, () => DEFAULT_BACKDROP);
  const set = useCallback((next: Backdrop, resolved?: BackdropLayers) => setBackdrop(next, resolved), []);
  return useMemo(() => ({ backdrop, setBackdrop: set }), [backdrop, set]);
}

/** Re-reads the resolved layers; exported for the pickers' live previews. */
export function readBackdropLayers(): BackdropLayers | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BACKDROP_CSS_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.light !== "string") return null;
    return { light: record.light, dark: typeof record.dark === "string" ? record.dark : record.light };
  } catch {
    return null;
  }
}

/** The runtime half, mirrored by BACKDROP_INIT_SCRIPT. All writes are CSS
 *  variables + one attribute on <html>; #app-backdrop's rules in globals.css
 *  do the painting. */
export function applyBackdrop(backdrop: Backdrop): void {
  const root = document.documentElement;
  const vars = ["--backdrop-light", "--backdrop-dark", "--backdrop-size", "--backdrop-repeat", "--backdrop-blur", "--backdrop-dim"];
  const clearAll = () => {
    for (const name of vars) root.style.removeProperty(name);
  };
  if (backdrop.kind === "none") {
    root.removeAttribute("data-backdrop");
    clearAll();
    return;
  }
  clearAll();
  root.setAttribute("data-backdrop", backdrop.kind);
  if (backdrop.kind === "image") {
    let data: string | null = null;
    try {
      data = window.localStorage.getItem(BACKDROP_IMAGE_KEY);
    } catch {
      data = null;
    }
    if (!data || !data.startsWith("data:image/")) {
      // A choice without its image (cleared storage) paints nothing — and the
      // attribute comes OFF so the wash does not hover over a bare canvas.
      root.removeAttribute("data-backdrop");
      return;
    }
    const url = `url("${data}")`;
    root.style.setProperty("--backdrop-light", url);
    root.style.setProperty("--backdrop-dark", url);
    root.style.setProperty("--backdrop-size", backdrop.fit === "cover" ? "cover" : backdrop.fit === "fill" ? "100% 100%" : "auto");
    root.style.setProperty("--backdrop-repeat", backdrop.fit === "tile" ? "repeat" : "no-repeat");
    if (backdrop.blur > 0) root.style.setProperty("--backdrop-blur", `${backdrop.blur}px`);
    if (backdrop.dim > 0) root.style.setProperty("--backdrop-dim", `${backdrop.dim}%`);
    return;
  }
  const layers = readBackdropLayers();
  if (!layers) {
    root.removeAttribute("data-backdrop");
    return;
  }
  root.style.setProperty("--backdrop-light", layers.light);
  root.style.setProperty("--backdrop-dark", layers.dark);
}

/** Pre-paint application; same contract as APPEARANCE_INIT_SCRIPT (inline in
 *  <head>, dependency-free, fails to "no scene" on any error). */
export const BACKDROP_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var b=JSON.parse(localStorage.getItem('${BACKDROP_KEY}')||'null');if(!b||typeof b!=='object'||b.kind==='none'||!b.kind)return;if(b.kind==='image'){var img=localStorage.getItem('${BACKDROP_IMAGE_KEY}');if(!img||img.indexOf('data:image/')!==0)return;d.setAttribute('data-backdrop','image');var u='url("'+img+'")';d.style.setProperty('--backdrop-light',u);d.style.setProperty('--backdrop-dark',u);d.style.setProperty('--backdrop-size',b.fit==='fill'?'100% 100%':b.fit==='tile'?'auto':'cover');d.style.setProperty('--backdrop-repeat',b.fit==='tile'?'repeat':'no-repeat');if(typeof b.blur==='number'&&b.blur>0)d.style.setProperty('--backdrop-blur',Math.min(${MAX_BACKDROP_BLUR},Math.round(b.blur))+'px');if(typeof b.dim==='number'&&b.dim>0)d.style.setProperty('--backdrop-dim',Math.min(${MAX_BACKDROP_DIM},Math.round(b.dim))+'%');return;}if(b.kind!=='gradient'&&b.kind!=='custom-gradient')return;var c=JSON.parse(localStorage.getItem('${BACKDROP_CSS_KEY}')||'null');if(!c||typeof c.light!=='string')return;d.setAttribute('data-backdrop',b.kind);d.style.setProperty('--backdrop-light',c.light);d.style.setProperty('--backdrop-dark',typeof c.dark==='string'?c.dark:c.light);}catch(e){}})();`;
