"use client";

/**
 * THE COMPOSITION — what the app looks like, as one value.
 *
 * THE COMPOSER IS THE THEME (#471). There used to be three stores answering
 * overlapping questions: a THEME LIBRARY holding palettes as sixteen stored
 * tokens per half, a BACKDROP holding a scene under the app, and a pair of
 * active theme ids pointing into the first. "Gradient and theme are different
 * things here. We inject the gradients over the theme, where I always thought
 * that a gradient would be part of a theme." So they are one thing now: a
 * COMPOSITION, which per colour state is a BASE colour and a stack of LAYERS
 * over it, with the sixteen surface tokens DERIVED from the base
 * (`halfFor`, lib/palette-from-image.ts) rather than stored.
 *
 * LIGHT AND DARK ARE TWO STATES OF ONE THING, not two themes. The window's
 * colour scheme picks which is showing; each carries its own base and its own
 * stack, so a scene tuned for daylight is not forced to be the one that shows
 * at night.
 *
 * TWO KEYS, BECAUSE THE PAYLOADS HAVE TWO LIFETIMES. The composition itself is
 * a few hundred bytes of JSON; its layer IMAGES are megabytes and are only read
 * when something recompiles. They are also SHARED by both states — a layer id
 * is unique across the composition, so a dark stack that began as a copy of
 * light does not carry a second copy of the same picture.
 *
 * AND TWO COMPILED CACHES, WRITTEN ON EVERY CHANGE. Neither pre-paint script
 * may run a line of this file:
 *
 *   telar-theme-css      the sixteen tokens as a stylesheet, injected by
 *                        APPEARANCE_INIT_SCRIPT (lib/appearance.ts)
 *   telar-backdrop-css   the per-state `background-*` lists, replayed by
 *                        BACKDROP_INIT_SCRIPT (lib/backdrop.ts)
 *
 * Both are DERIVED: nothing reads them to decide anything, and losing them
 * costs one repaint after hydration rather than a wrong-coloured app.
 *
 * WHAT IT DOES NOT HOLD. The accent, the typefaces, the sizes and the depth are
 * taste too, but they are scalar choices with their own store (lib/appearance.ts)
 * and their own attributes on <html>; folding them in would buy nothing and
 * cost a migration. A LOOK is what binds the two together (lib/looks.ts).
 */

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
import { notifyBackdropCss, setBackdropCss, type BackdropCss } from "./backdrop";
import { halfFor } from "./palette-from-image";
import { forgetLegacyAppearance, migrateLegacyAppearance } from "./legacy-appearance";
import { composeState, SCENE_PRESETS } from "./scene-composer";
import { repairInk, STATE_INK, TINT_FLOOR, TINT_TONES, tintCost, type TintTone } from "./tint-separation";

export const COMPOSITION_KEY = "telar-composition";
export const COMPOSITION_IMAGES_KEY = "telar-composition-images";

/** The COMPILED stylesheet, cached for the pre-paint init script — which must
 *  not need the compiler. Rewritten on every composition change. */
export const THEME_CSS_KEY = "telar-theme-css";

export type CompositionMode = "light" | "dark";

export const MODES: readonly CompositionMode[] = ["light", "dark"];

/** Telar itself: its own two base colours, nothing over them, nothing set by
 *  hand. It compiles to NO stylesheet at all — see `compileComposition`. */
export const DEFAULT_COMPOSITION: Composition = {
  light: { base: DEFAULT_BASE_LIGHT, layers: [], overrides: {} },
  dark: { base: DEFAULT_BASE_DARK, layers: [], overrides: {} },
};

export function neutralHalf(mode: CompositionMode): ThemeHalf {
  return mode === "light" ? TELAR_LIGHT : TELAR_DARK;
}

/* ------------------------------------------------------------ the compiler */

/**
 * ONLY WHAT DIFFERS FROM THE BASE PALETTE IS EMITTED, which is what keeps
 * globals.css the single source of the default look: Telar's own composition
 * derives Telar's own values, every token matches, and the block is empty — so
 * no stylesheet is injected and the authored tokens stand. A tinted
 * composition emits only the tokens it actually moved, which is also the
 * smallest thing the pre-paint cache can hold.
 */
function declarations(half: ThemeHalf, neutral: ThemeHalf): string {
  return THEME_TOKENS.filter((token) => half[token] && half[token] !== neutral[token])
    .map((token) => `--${token}: ${half[token]};`)
    .join(" ");
}

/**
 * THE STATE VOCABULARY, REPAIRED FOR THIS CARD — and USUALLY NOTHING (#705).
 *
 * `.tint-success` is `color-mix(in oklab, var(--success) 12%, var(--card))`, and
 * `text-success` stands on it. Both ends of that mix are the same token, so a
 * card that lands near the state ink strands the ink on its own fill. The card
 * is the term somebody CHOSE; `--success` and friends are not in THEME_TOKENS
 * and so cannot be chosen at all — which is why the repair moves the ink and
 * leaves the card exactly as it was authored (lib/tint-separation.ts argues it
 * at length).
 *
 * HERE RATHER THAN AT EACH ARRIVAL, because every path that can reach an
 * arbitrary `--card` — a VS Code import, a hand override, a Look file somebody
 * else made, the legacy read-forward — funnels through `halfFor` and this
 * compiler. One rule instead of four, DERIVED on every compile and never
 * stored, so it cannot go stale, cannot be exported into a Look file, and
 * disappears the instant the card goes back.
 *
 * AND IT EMITS NOTHING FOR A LOOK THAT MERELY READS. `repairInk` is a fixed
 * point on an ink that already clears both separations, which is every card
 * this build can derive from a base — so the compiled stylesheet for Telar's
 * own composition, and for every built-in Look, is byte-for-byte what it was.
 */
function inkDeclarations(half: ThemeHalf, mode: CompositionMode): string {
  const shipped = STATE_INK[mode];
  const moved: string[] = [];
  for (const tone of TINT_TONES) {
    const repair = repairInk(shipped[tone], half.card, TINT_FLOOR);
    if (repair.outcome === "repaired") moved.push(`--${tone}: ${repair.ink};`);
  }
  return moved.join(" ");
}

/**
 * The composition's palette as a stylesheet. `html:root` outranks globals.css's
 * `:root` by one type selector, which is how the composition wins by
 * construction; the translucency overrides at two attributes still outrank both.
 */
export function compileComposition(composition: Composition): string {
  const blocks: string[] = [];
  const lightHalf = halfFor(composition.light, "light");
  const light = [declarations(lightHalf, TELAR_LIGHT), inkDeclarations(lightHalf, "light")].filter(Boolean).join(" ");
  if (light) blocks.push(`html:root { ${light} }`);
  const darkHalf = halfFor(composition.dark, "dark");
  const dark = [declarations(darkHalf, TELAR_DARK), inkDeclarations(darkHalf, "dark")].filter(Boolean).join(" ");
  if (dark) blocks.push(`html:root.dark { ${dark} }`);
  return blocks.join(" ");
}

/**
 * THE TONES THIS COMPOSITION STRANDS — the repair's report arm, as a value.
 *
 * A card sitting on the ink's own lightness fails ELEVATION, and no ink
 * lightness can answer that: the fill has nowhere to go. `repairInk` changes
 * nothing in that case, so somebody has to be told instead — which is what this
 * is for. Both states are asked, because a Look carries two cards and only one
 * of them may be in trouble.
 */
export function strandedTones(composition: Composition): TintTone[] {
  const found = new Set<TintTone>();
  for (const mode of MODES) {
    for (const tone of tintCost(compositionHalf(composition, mode).card, STATE_INK[mode], TINT_FLOOR).stranded) found.add(tone);
  }
  return TINT_TONES.filter((tone) => found.has(tone));
}

/**
 * The two states' stacks as the per-state lists #app-backdrop paints from, or
 * null when NEITHER state has anything over its base — which is what "None" is
 * now, and what takes `data-backdrop` off entirely.
 *
 * A state whose stack composes to nothing contributes an empty list rather than
 * failing the pair: light may carry a scene while dark is bare, and the CSS
 * falls through to that state's own base colour where a list is absent.
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

/* ------------------------------------------------------------- pure editing */

/** One state, with a patch applied — the shape every editor writes through. */
export function patchState(composition: Composition, mode: CompositionMode, patch: Partial<CompositionState>): Composition {
  return { ...composition, [mode]: { ...composition[mode], ...patch } };
}

/**
 * Set or CLEAR one hand-set token. Clearing is the whole reason overrides are
 * sparse: a token that is absent follows the base, and there is no way to say
 * "follow the base" with a value.
 */
export function patchOverride(composition: Composition, mode: CompositionMode, token: ThemeToken, value: string | undefined): Composition {
  const overrides = { ...composition[mode].overrides };
  if (value === undefined) delete overrides[token];
  else overrides[token] = value;
  return patchState(composition, mode, { overrides });
}

/** Every layer image either state still refers to. Both stacks share one map,
 *  so pruning has to ask both before it drops a picture. */
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
  // THE SAME OBJECT WHEN NOTHING WENT, and that identity is load-bearing: the
  // write below skips re-serialising megabytes of base64 when the map has not
  // moved, which is what makes dragging an opacity slider cost a few hundred
  // bytes per frame rather than the whole image map.
  return dropped ? next : images;
}

/**
 * THE DARK STATE STARTS AS THE LIGHT ONE UNTIL IT IS TOUCHED — the model's own
 * words. This is that copy, and it is a copy of the LAYERS only: the base is
 * the one thing the two states are never the same about, and the overrides are
 * hand-set values for a half that does not exist on the other side.
 */
export function copyLayersAcross(composition: Composition, from: CompositionMode): Composition {
  const to: CompositionMode = from === "light" ? "dark" : "light";
  return patchState(composition, to, { layers: composition[from].layers.map((layer) => ({ ...layer }) as SceneLayer) });
}

/* --------------------------------------------------------------- the store */

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

/**
 * The snapshot is CACHED BY RAW STRING, because useSyncExternalStore compares
 * snapshots by identity and a fresh object every read is an infinite render
 * loop — the exact failure the hook's docs warn about. The IMAGES string is in
 * the cache key too, so a bake lands without a second store.
 */
let cache: { raw: string; value: StoredComposition } | undefined;

/**
 * Telar itself, as ONE object for the lifetime of the module.
 *
 * useSyncExternalStore compares snapshots by identity, so a fresh
 * `{ composition: DEFAULT_COMPOSITION, images: {} }` per read is an infinite
 * render loop — the exact failure the hook's docs warn about, and the one a
 * fresh install hits before anything has been stored.
 */
const DEFAULT_STORED: StoredComposition = { composition: DEFAULT_COMPOSITION, images: {} };

/**
 * THE ONE-SHOT MIGRATION, and why it lives on the read rather than on a boot
 * step. Every install that predates the composition has a theme pair and a
 * backdrop in five other keys, and the composition key is simply absent. An
 * absent key is therefore not "the default composition" — it is "nobody has
 * read the old one forward yet", and the first read is where it happens.
 *
 * IT PERSISTS BUT DOES NOT NOTIFY. This runs inside a snapshot read, and a
 * snapshot read that told React the store had changed would re-enter itself
 * forever. Persisting primes the cache, so the very next read takes the
 * ordinary path and hands back the same object — which is all the subscribers
 * need. `migrated` guards the attempt so a machine with nothing to migrate
 * pays one look at localStorage and never tries again.
 */
let migrated = false;

function migrateIn(): StoredComposition {
  if (migrated) return DEFAULT_STORED;
  migrated = true;
  const legacy = migrateLegacyAppearance();
  if (!legacy) return DEFAULT_STORED;
  // The old keys are dropped only once the new value is actually stored — a
  // migration that cleared first and then failed the quota would lose the look
  // it was rescuing.
  if (!persist(legacy.composition, legacy.images)) return DEFAULT_STORED;
  forgetLegacyAppearance();
  // QUIETLY, THEN LOUDLY. The caches have to be on disk before the effects that
  // replay them run, so they are written here; the SUBSCRIBERS are told after
  // the render, because telling them from inside a snapshot read is a store
  // update during another component's render. Everything reading this store
  // already gets the migrated value from the return below — the notification is
  // for the backdrop store, which was read before this one and answered from a
  // key that did not exist yet.
  writeDerived(legacy.composition, cache!.value.images, true);
  queueMicrotask(() => {
    notifyBackdropCss();
    notify();
  });
  return cache!.value;
}

function readStored(): StoredComposition {
  const raw = readKey(COMPOSITION_KEY);
  if (raw === null) return migrateIn();
  const imagesRaw = readKey(COMPOSITION_IMAGES_KEY);
  const key = `${raw}\n${imagesRaw ?? ""}`;
  if (!cache || cache.raw !== key) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Total, like every parser this pane touches: a hand-edited value falls
      // to Telar's own rather than wedging the window.
    }
    cache = {
      raw: key,
      value: { composition: parseComposition(parsed, SCENE_PRESETS), images: parseSceneImages(imagesRaw) },
    };
  }
  return cache.value;
}

/** The stored composition, read outside React. */
export function currentComposition(): StoredComposition {
  return readStored();
}

/**
 * STORE IT AND PRIME THE CACHE — the half of a write that touches no
 * subscriber, so the migration above can use it from inside a snapshot read.
 *
 * Returns false when the write did not fit: the layer images are the only thing
 * here big enough to meet the quota, and a half-saved composition is worse than
 * a refusal the composer can show a line about. On a refusal the PREVIOUS value
 * is put back, so what is on screen is still what is stored.
 */
function persist(composition: Composition, images: Record<string, string>): boolean {
  const kept = pruneCompositionImages(composition, images);
  // Dragging a slider writes the composition on every frame; re-serialising an
  // unchanged image map would make each of those frames cost a megabyte of
  // base64. Reference equality with what is already cached is the whole test —
  // every path that CHANGES the map builds a new object.
  const unchanged = cache !== undefined && cache.value.images === kept;
  let previousImages: string | null = null;
  let imagesJson: string;
  const compositionJson = JSON.stringify(composition);
  try {
    previousImages = window.localStorage.getItem(COMPOSITION_IMAGES_KEY);
    imagesJson = unchanged && previousImages !== null ? previousImages : JSON.stringify(kept);
    // The big write first: a quota refusal must stop BEFORE the composition
    // starts naming layers whose pictures were not stored.
    if (imagesJson !== previousImages) window.localStorage.setItem(COMPOSITION_IMAGES_KEY, imagesJson);
    window.localStorage.setItem(COMPOSITION_KEY, compositionJson);
  } catch {
    try {
      if (previousImages === null) window.localStorage.removeItem(COMPOSITION_IMAGES_KEY);
      else window.localStorage.setItem(COMPOSITION_IMAGES_KEY, previousImages);
    } catch {
      // The restore can fail too; every parser here is total, so the worst
      // case is a composition with a missing picture rather than a wedge.
    }
    cache = undefined;
    return false;
  }
  // PRIMED RATHER THAN CLEARED, so the next read hands back these exact
  // objects: the identity above is what lets the following frame skip the
  // image write, and a re-parse would hand out a fresh map every time.
  cache = { raw: `${compositionJson}\n${imagesJson}`, value: { composition, images: kept } };
  return true;
}

/**
 * APPLY, WHICH IS THE ONLY WAY PIXELS MOVE. The derived caches are written here
 * and nowhere else, so they can never disagree with the composition they cache.
 * Returns what `persist` returned — false means the layer images would not fit.
 */
export function writeComposition(composition: Composition, images: Record<string, string>): boolean {
  const stored = persist(composition, images);
  if (stored) writeDerived(composition, cache!.value.images);
  notify();
  return stored;
}

/** The two pre-paint caches. Separate from the write above so a caller that
 *  only needs to REcompile — the preset table changed, say — can. `quiet` is
 *  the migration's, and only the migration's: see `migrateIn`. */
export function writeDerived(composition: Composition, images: Record<string, string>, quiet = false): void {
  try {
    window.localStorage.setItem(THEME_CSS_KEY, compileComposition(composition));
  } catch {
    // Derived: one repaint after hydration, never a wrong colour.
  }
  setBackdropCss(composeComposition(composition, images), quiet);
}

export function useComposition(): {
  composition: Composition;
  images: Record<string, string>;
  /** Write a whole composition (and optionally new images). False when the
   *  images would not fit — see `writeComposition`. */
  setComposition: (next: Composition, images?: Record<string, string>) => boolean;
  /** Patch one state, keeping the images as they are. */
  setState: (mode: CompositionMode, patch: Partial<CompositionState>) => boolean;
  /** Patch one state's layers, with the image map they refer to. */
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

/** Keeps the injected `<style id="telar-theme">` tracking the store after the
 *  init script's one shot — the same division of labour ThemeProvider has. */
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

/** The composition's palette for one state, concrete — what the token rows
 *  show and what a preview paints from. */
export function compositionHalf(composition: Composition, mode: CompositionMode): ThemeHalf {
  return halfFor(composition[mode], mode);
}
