"use client";

/**
 * THE BACKDROP — the composition's layers, as pixels under the whole app.
 *
 * Layout renders one fixed, empty `#app-backdrop` div as the first child of
 * body; everything here is about what that div paints. Anything painted there
 * flips `data-backdrop` on <html>, which pulls the SAME see-through wash the
 * desktop translucency mode uses (globals.css gates those rules on either
 * attribute). The app's grounds go glassy over whatever the scene is: the
 * desktop through a translucent window, or a gradient in a plain browser tab.
 * One mechanism, two windows onto it.
 *
 * ONE KEY, AND IT IS DERIVED (#471). This file used to be a STORE — a choice
 * with four kinds, its own resolved-CSS cache, and an image payload beside it —
 * because a backdrop was a thing you picked. It is not: the composition
 * (lib/composition.ts) holds the layers, and this holds the COMPILED result so
 * the pre-paint script can paint frame one without the compiler, the preset
 * table, or a line of React. Nothing here decides anything; losing the key
 * costs one repaint after hydration.
 *
 * PER-STATE LISTS, AND CSS PICKS BETWEEN THEM. Light and dark are two states of
 * one composition with genuinely separate stacks, so entry n of one can be an
 * image where the other's is a gradient and a single shared
 * `background-size/position/repeat` list cannot serve both. Each state
 * therefore has its own four variables (`--backdrop-light`,
 * `--backdrop-size-light`, …, and the `-dark` four), and the CHOICE between
 * them is made in globals.css by the `.dark` selector rather than here — which
 * is what makes first paint correct with no flash and keeps it correct when the
 * OS flips scheme under a window set to `system`, with no script running at all.
 *
 * BACKDROP_INIT_SCRIPT mirrors applyBackdrop for the reason
 * APPEARANCE_INIT_SCRIPT exists: a scene applied one render late is a flash of
 * bare canvas on every launch. Keep the two in sync.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * THE VOCABULARY MOVED; THE PAINTING DID NOT. The resolved-layer shape and the
 * two value gates are pure string logic that a `Look` on the wire needs as much
 * as this does, so they live in @telar/engine-client and are re-exported here —
 * every importer keeps its path, and there is one definition of what counts as
 * a paintable gradient.
 */
export {
  isGradientValue,
  isSceneValue,
  MAX_BACKDROP_BLUR,
  MAX_BACKDROP_DIM,
  type BackdropLayers,
} from "@telar/engine-client";

/**
 * A NEW KEY, BECAUSE THE VALUE'S MEANING CHANGED. `telar-backdrop-css` held one
 * shared set of lists for both colour schemes; this holds a set per state. An
 * old value read as a new one would paint a scene with the wrong sizing for one
 * frame — so the old key keeps its old meaning until the composition migration
 * has read it and removed it (lib/legacy-appearance.ts).
 */
export const BACKDROP_CSS_KEY = "telar-backdrop-compiled";

/**
 * THE COMPILED BACKDROP — four lists per state, flat rather than nested.
 *
 * Flat because BACKDROP_INIT_SCRIPT is dependency-free and walks these by name:
 * a key here is `--backdrop-` plus the same name hyphenated, so the script is a
 * table rather than a branch per property. `light` and `dark` are the
 * `background-image` lists and are the only two members that are always
 * present; a state with nothing over its base carries `"none"` and no lists,
 * and the CSS falls through to that state's own canvas.
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

/** A value CSS will accept in a declaration — the same shape the shared gates
 *  hold a Look's resolved layers to, restated for a list rather than an image. */
function listValue(candidate: unknown): string | undefined {
  return typeof candidate === "string" && candidate.length > 0 && !candidate.includes(";") && !candidate.includes("}") ? candidate : undefined;
}

/** Total, like every parser this pane touches: anything unrecognised is "no
 *  scene", so a stale or hand-edited value can never wedge the window. */
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

/**
 * Write the compiled backdrop, or clear it. Called by the composition's apply
 * and by nothing else — this cache has exactly one author.
 *
 * `quiet` stores without telling anybody, for the one caller that runs inside a
 * snapshot READ: the composition's one-shot migration. Notifying from there
 * would be a store update during another component's render. It queues
 * `notifyBackdropCss` for after the render instead.
 */
export function setBackdropCss(css: BackdropCss | null, quiet = false): void {
  try {
    if (css === null) window.localStorage.removeItem(BACKDROP_CSS_KEY);
    else window.localStorage.setItem(BACKDROP_CSS_KEY, JSON.stringify(css));
  } catch {
    // Quota or private browsing: the in-page listeners still repaint, and the
    // next launch simply starts from the composition rather than the cache.
  }
  cache = undefined;
  if (!quiet) notifyBackdropCss();
}

export function notifyBackdropCss(): void {
  for (const listener of listeners) listener();
}

export function useBackdropCss(): { backdrop: BackdropCss | null; setBackdrop: (next: BackdropCss | null) => void } {
  const backdrop = useSyncExternalStore(subscribeBackdropCss, readBackdropCss, () => null);
  const set = useCallback((next: BackdropCss | null) => setBackdropCss(next), []);
  return useMemo(() => ({ backdrop, setBackdrop: set }), [backdrop, set]);
}

/** The runtime half, mirrored by BACKDROP_INIT_SCRIPT. All writes are CSS
 *  variables plus one attribute on <html>; #app-backdrop's rules in globals.css
 *  do the painting, including which state's lists win. */
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

/** Pre-paint application; same contract as APPEARANCE_INIT_SCRIPT (inline in
 *  <head>, dependency-free, fails to "no scene" on any error). */
export const BACKDROP_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var c=JSON.parse(localStorage.getItem('${BACKDROP_CSS_KEY}')||'null');if(!c||typeof c!=='object'||typeof c.light!=='string')return;d.setAttribute('data-backdrop','scene');${JSON.stringify(
  BACKDROP_VARS.map(([member, name]) => [member, name]),
)}.forEach(function(p){var v=c[p[0]];if(typeof v==='string'&&v)d.style.setProperty(p[1],v);});}catch(e){}})();`;
