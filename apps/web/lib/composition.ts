"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  DEFAULT_BASE_DARK,
  DEFAULT_BASE_LIGHT,
  parseComposition,
  parseSceneImages,
  TELAR_DARK,
  TELAR_LIGHT,
  THEME_TOKENS,
  type Composition,
  type CompositionState,
  type SceneLayer,
  type ThemeHalf,
  type ThemeToken,
} from "@telar/engine-client";
import { setBackdropCss, type BackdropCss } from "./backdrop";
import { halfFor } from "./palette-from-image";
import { composeState, SCENE_PRESETS } from "./scene-composer";
import { repairInk, STATE_INK, TINT_FLOOR, TINT_TONES, tintCost, type TintTone } from "./tint-separation";

const COMPOSITION_KEY = "telar-composition";
const COMPOSITION_IMAGES_KEY = "telar-composition-images";

/** The compiled stylesheet, cached for the pre-paint init script, which must not need the compiler. */
export const THEME_CSS_KEY = "telar-theme-css";

export type CompositionMode = "light" | "dark";

export const MODES: readonly CompositionMode[] = ["light", "dark"];

export const DEFAULT_COMPOSITION: Composition = {
  light: { base: DEFAULT_BASE_LIGHT, layers: [], overrides: {} },
  dark: { base: DEFAULT_BASE_DARK, layers: [], overrides: {} },
};

/**
 * A token that moved in either state is emitted in both. `html:root` outranks
 * globals.css's `.dark`, so a token declared only for light would leak into dark.
 */
function movedTokens(light: ThemeHalf, dark: ThemeHalf): ThemeToken[] {
  return THEME_TOKENS.filter(
    (token) => light[token] && dark[token] && (light[token] !== TELAR_LIGHT[token] || dark[token] !== TELAR_DARK[token]),
  );
}

function declarations(half: ThemeHalf, tokens: readonly ThemeToken[]): string {
  return tokens.map((token) => `--${token}: ${half[token]};`).join(" ");
}

function inkDeclarations(half: ThemeHalf, mode: CompositionMode): string {
  const shipped = STATE_INK[mode];
  const moved: string[] = [];
  for (const tone of TINT_TONES) {
    const repair = repairInk(shipped[tone], half.card, TINT_FLOOR);
    if (repair.outcome === "repaired") moved.push(`--${tone}: ${repair.ink};`);
  }
  return moved.join(" ");
}

/** `html:root` outranks globals.css's `:root` by one type selector, so the composition wins by construction. */
export function compileComposition(composition: Composition): string {
  const blocks: string[] = [];
  const lightHalf = halfFor(composition.light, "light");
  const darkHalf = halfFor(composition.dark, "dark");
  const moved = movedTokens(lightHalf, darkHalf);
  const light = [declarations(lightHalf, moved), inkDeclarations(lightHalf, "light")].filter(Boolean).join(" ");
  if (light) blocks.push(`html:root { ${light} }`);
  const dark = [declarations(darkHalf, moved), inkDeclarations(darkHalf, "dark")].filter(Boolean).join(" ");
  if (dark) blocks.push(`html:root.dark { ${dark} }`);
  return blocks.join(" ");
}

/** Tones whose card fails elevation in either state; `repairInk` cannot fix these, so they must be reported. */
export function strandedTones(composition: Composition): TintTone[] {
  const found = new Set<TintTone>();
  for (const mode of MODES) {
    for (const tone of tintCost(compositionHalf(composition, mode).card, STATE_INK[mode], TINT_FLOOR).stranded) found.add(tone);
  }
  return TINT_TONES.filter((tone) => found.has(tone));
}

/**
 * Per-state backdrop lists, or null when neither state has layers (which removes `data-backdrop`).
 * A state that composes to nothing gets an empty list and falls through to its base colour.
 */
export function composeComposition(composition: Composition, images: Record<string, string>): BackdropCss | null {
  const light = composeState(composition.light.layers, images);
  const dark = composeState(composition.dark.layers, images);
  if (!light && !dark) return null;
  return {
    light: light?.image ?? "none",
    dark: dark?.image ?? "none",
    ...(light ? { sizeLight: light.size, positionLight: light.position, repeatLight: light.repeat } : {}),
    ...(dark ? { sizeDark: dark.size, positionDark: dark.position, repeatDark: dark.repeat } : {}),
  };
}

export function patchState(composition: Composition, mode: CompositionMode, patch: Partial<CompositionState>): Composition {
  return { ...composition, [mode]: { ...composition[mode], ...patch } };
}

/** Set or clear one hand-set token; an absent token follows the base. */
export function patchOverride(composition: Composition, mode: CompositionMode, token: ThemeToken, value: string | undefined): Composition {
  const overrides = { ...composition[mode].overrides };
  if (value === undefined) delete overrides[token];
  else overrides[token] = value;
  return patchState(composition, mode, { overrides });
}

/** Both stacks share one image map, so pruning checks both states. */
export function pruneCompositionImages(composition: Composition, images: Record<string, string>): Record<string, string> {
  const live = new Set(
    MODES.flatMap((mode) => composition[mode].layers.flatMap((layer) => (layer.type === "image" ? [layer.id] : []))),
  );
  const next: Record<string, string> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(images)) {
    const id = key.startsWith("orig:") ? key.slice(5) : key;
    if (live.has(id)) next[key] = value;
    else dropped = true;
  }
  // Same object when nothing was dropped: `persist` relies on identity to skip re-serialising images.
  return dropped ? next : images;
}

/** Copies layers only; bases and overrides stay per state. */
export function copyLayersAcross(composition: Composition, from: CompositionMode): Composition {
  const to: CompositionMode = from === "light" ? "dark" : "light";
  return patchState(composition, to, { layers: composition[from].layers.map((layer) => ({ ...layer }) as SceneLayer) });
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export type StoredComposition = { composition: Composition; images: Record<string, string> };

const SERVER_STATE: StoredComposition = { composition: DEFAULT_COMPOSITION, images: {} };

/** Cached by raw string: useSyncExternalStore compares snapshots by identity. */
let cache: { raw: string; value: StoredComposition } | undefined;

/** One object for the module's lifetime, since useSyncExternalStore compares snapshots by identity. */
const DEFAULT_STORED: StoredComposition = { composition: DEFAULT_COMPOSITION, images: {} };

function readStored(): StoredComposition {
  const raw = readKey(COMPOSITION_KEY);
  if (raw === null) return DEFAULT_STORED;
  const imagesRaw = readKey(COMPOSITION_IMAGES_KEY);
  const key = `${raw}\n${imagesRaw ?? ""}`;
  if (!cache || cache.raw !== key) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Total: a hand-edited value falls back to the default.
    }
    cache = {
      raw: key,
      value: { composition: parseComposition(parsed, SCENE_PRESETS), images: parseSceneImages(imagesRaw) },
    };
  }
  return cache.value;
}

export function currentComposition(): StoredComposition {
  return readStored();
}

/**
 * Returns false when the images exceed the quota; the previous images are restored so
 * what is on screen is still what is stored.
 */
function persist(composition: Composition, images: Record<string, string>): boolean {
  const kept = pruneCompositionImages(composition, images);
  // Skip re-serialising an unchanged image map; every path that changes it builds a new object.
  const unchanged = cache !== undefined && cache.value.images === kept;
  let previousImages: string | null = null;
  let imagesJson: string;
  const compositionJson = JSON.stringify(composition);
  try {
    previousImages = window.localStorage.getItem(COMPOSITION_IMAGES_KEY);
    imagesJson = unchanged && previousImages !== null ? previousImages : JSON.stringify(kept);
    // Images first, so a quota refusal stops before the composition names unstored pictures.
    if (imagesJson !== previousImages) window.localStorage.setItem(COMPOSITION_IMAGES_KEY, imagesJson);
    window.localStorage.setItem(COMPOSITION_KEY, compositionJson);
  } catch {
    try {
      if (previousImages === null) window.localStorage.removeItem(COMPOSITION_IMAGES_KEY);
      else window.localStorage.setItem(COMPOSITION_IMAGES_KEY, previousImages);
    } catch {
      // Parsers are total, so the worst case is a missing picture.
    }
    cache = undefined;
    return false;
  }
  // Primed rather than cleared, so the next frame's identity check can skip the image write.
  cache = { raw: `${compositionJson}\n${imagesJson}`, value: { composition, images: kept } };
  return true;
}

/** The only writer of the derived caches. False means the layer images would not fit. */
export function writeComposition(composition: Composition, images: Record<string, string>): boolean {
  const stored = persist(composition, images);
  if (stored) writeDerived(composition, cache!.value.images);
  notify();
  return stored;
}

/** The two pre-paint caches; callable alone to recompile without a store write. */
export function writeDerived(composition: Composition, images: Record<string, string>): void {
  try {
    window.localStorage.setItem(THEME_CSS_KEY, compileComposition(composition));
  } catch {
    // Derived: one repaint after hydration, never a wrong colour.
  }
  setBackdropCss(composeComposition(composition, images));
}

/**
 * The cached CSS outlives the compiler, so recompile on load when it no longer matches.
 * Compared rather than version-stamped, which also skips the costly backdrop write when unchanged.
 */
export function recompileStaleCss(): void {
  const stored = readStored();
  let cached: string | null = null;
  try {
    cached = window.localStorage.getItem(THEME_CSS_KEY);
  } catch {
    // Private browsing: nothing cached, nothing stale.
    return;
  }
  // An absent key equals the empty sheet a default composition compiles to.
  if ((cached ?? "") === compileComposition(stored.composition)) return;
  writeDerived(stored.composition, stored.images);
}

export function useComposition(): {
  composition: Composition;
  images: Record<string, string>;
  /** False when the images would not fit; see `writeComposition`. */
  setComposition: (next: Composition, images?: Record<string, string>) => boolean;
  setState: (mode: CompositionMode, patch: Partial<CompositionState>) => boolean;
  setLayers: (mode: CompositionMode, layers: SceneLayer[], images: Record<string, string>) => boolean;
  setBase: (mode: CompositionMode, base: string) => boolean;
  setOverride: (mode: CompositionMode, token: ThemeToken, value: string | undefined) => boolean;
} {
  const stored = useSyncExternalStore(subscribe, readStored, () => SERVER_STATE);

  const setComposition = useCallback(
    (next: Composition, images?: Record<string, string>) => writeComposition(next, images ?? readStored().images),
    [],
  );
  const setState = useCallback((mode: CompositionMode, patch: Partial<CompositionState>) => {
    const current = readStored();
    return writeComposition(patchState(current.composition, mode, patch), current.images);
  }, []);
  const setLayers = useCallback(
    (mode: CompositionMode, layers: SceneLayer[], images: Record<string, string>) =>
      writeComposition(patchState(readStored().composition, mode, { layers }), images),
    [],
  );
  const setBase = useCallback((mode: CompositionMode, base: string) => {
    const current = readStored();
    return writeComposition(patchState(current.composition, mode, { base }), current.images);
  }, []);
  const setOverride = useCallback((mode: CompositionMode, token: ThemeToken, value: string | undefined) => {
    const current = readStored();
    return writeComposition(patchOverride(current.composition, mode, token, value), current.images);
  }, []);

  return useMemo(
    () => ({
      composition: stored.composition,
      images: stored.images,
      setComposition,
      setState,
      setLayers,
      setBase,
      setOverride,
    }),
    [stored, setComposition, setState, setLayers, setBase, setOverride],
  );
}

/** Keeps `<style id="telar-theme">` tracking the store after the init script's one shot. */
export function applyThemeCss(): void {
  let css = "";
  try {
    css = window.localStorage.getItem(THEME_CSS_KEY) ?? "";
  } catch {
    // The default look.
  }
  let style = document.getElementById("telar-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "telar-theme";
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

export function compositionHalf(composition: Composition, mode: CompositionMode): ThemeHalf {
  return halfFor(composition[mode], mode);
}
