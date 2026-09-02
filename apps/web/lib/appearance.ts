"use client";

/**
 * APPEARANCE BEYOND LIGHT/DARK — accent, typefaces, window translucency.
 *
 * The colour scheme keeps its own store (components/theme-provider.tsx): it
 * predates this file, its key is in the wild, and folding it in would buy one
 * fewer file at the cost of a migration. Everything ELSE the reader can retint
 * lives here, as one JSON value under one key.
 *
 * THE MECHANISM IS ATTRIBUTES ON <html>, exactly like `.dark`: CSS in
 * globals.css keys accent off `data-accent`, typefaces off `data-font-sans` /
 * `data-font-mono`, and translucency off `data-translucent` (which is inert
 * outside the desktop shell — the rule also requires `data-telar-shell`).
 * Components never read this store to colour themselves; the tokens move and
 * everything wearing them follows.
 *
 * APPEARANCE_INIT_SCRIPT mirrors THEME_INIT_SCRIPT for the same reason it
 * exists: an accent applied one render late is a violet app that flashes
 * indigo on every launch. Keep the script in sync with the parsing here.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Accent names double as `data-accent` values; the hues live in globals.css
 *  (one block per name) and in the swatch spans the settings pane renders —
 *  which reuse the same attribute, so there is no second copy of any value. */
export const ACCENTS = ["indigo", "sky", "sea", "moss", "amber", "rose", "plum", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];

export const SANS_FONTS = ["geist", "inter", "system"] as const;
export type SansFont = (typeof SANS_FONTS)[number];

export const MONO_FONTS = ["geist", "jetbrains", "system"] as const;
export type MonoFont = (typeof MONO_FONTS)[number];

export type Appearance = {
  accent: Accent;
  fontSans: SansFont;
  fontMono: MonoFont;
  /** Only means anything inside the desktop shell, but it is stored here —
   *  with the rest of appearance — rather than in the shell, so the same
   *  toggle round-trips through the same store as everything on the pane.
   *  The shell keeps its own copy too (ui-prefs.json) because the WINDOW is
   *  created before this page runs. */
  translucent: boolean;
  /** How much desktop shows through, on the slider's 0–100 display scale —
   *  translucencyCss maps it onto the real alpha range before the CSS sees
   *  it, so 100 means "as transparent as stays legible", not alpha zero. */
  translucencyLevel: number;
  /** What the see-through part looks like. "blur" is macOS vibrancy — frosted,
   *  and it BRIGHTENS what it blurs, which buries the wallpaper's colour.
   *  "clear" drops the effect view entirely: the desktop shows crisp through
   *  the wash, and only the wash's own alpha tints it. */
  frost: Frost;
};

export const FROSTS = ["blur", "clear"] as const;
export type Frost = (typeof FROSTS)[number];

/**
 * THE SLIDER'S SCALE IS THE FEELING, NOT THE ALPHA. It reads 0–100 because
 * "100%" is what a person means by "as transparent as it goes"; the stored
 * number is that display value, and translucencyCss maps it onto the real
 * range — 100 lands at 90% canvas transparency, a floor that keeps text
 * legible, and what remains at the top is macOS's own vibrancy material,
 * frosted by the OS and never clear glass.
 */
export const MIN_TRANSLUCENCY = 0;
export const MAX_TRANSLUCENCY = 100;

/** Display value → the percentage the CSS actually subtracts from opacity. */
export function translucencyCss(level: number): string {
  return `${Math.round(level * 0.9)}%`;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: "indigo", fontSans: "geist", fontMono: "geist", translucent: false, translucencyLevel: 50, frost: "blur" };

const STORAGE_KEY = "telar-appearance";

/**
 * Pre-paint application, mirrored from THEME_INIT_SCRIPT: dependency-free,
 * inlined in <head>, and failing to the defaults on ANY error. Attributes for
 * default values are OMITTED rather than written, so the base tokens in
 * globals.css stay the single source of the default look.
 */
export const APPEARANCE_INIT_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem('${STORAGE_KEY}')||'{}');var d=document.documentElement;var set=function(n,v,ok){if(ok.indexOf(v)>=0&&v!==ok[0])d.setAttribute(n,v);else d.removeAttribute(n);};set('data-accent',a.accent,${JSON.stringify([...ACCENTS])});set('data-font-sans',a.fontSans,${JSON.stringify([...SANS_FONTS])});set('data-font-mono',a.fontMono,${JSON.stringify([...MONO_FONTS])});if(a.translucent===true){d.setAttribute('data-translucent','');var l=typeof a.translucencyLevel==='number'&&a.translucencyLevel>=${MIN_TRANSLUCENCY}&&a.translucencyLevel<=${MAX_TRANSLUCENCY}?a.translucencyLevel:${DEFAULT_APPEARANCE.translucencyLevel};d.style.setProperty('--translucency',Math.round(l*0.9)+'%');}else{d.removeAttribute('data-translucent');d.style.removeProperty('--translucency');}}catch(e){}})();`;

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** Parsing is total: any missing or unrecognised member falls to the default,
 *  so an old value (or a hand-edited one) can never wedge the store. */
export function parseAppearance(raw: string | null): Appearance {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      accent: oneOf(record.accent, ACCENTS) ?? DEFAULT_APPEARANCE.accent,
      fontSans: oneOf(record.fontSans, SANS_FONTS) ?? DEFAULT_APPEARANCE.fontSans,
      fontMono: oneOf(record.fontMono, MONO_FONTS) ?? DEFAULT_APPEARANCE.fontMono,
      translucent: record.translucent === true,
      translucencyLevel:
        typeof record.translucencyLevel === "number" && record.translucencyLevel >= MIN_TRANSLUCENCY && record.translucencyLevel <= MAX_TRANSLUCENCY
          ? Math.round(record.translucencyLevel)
          : DEFAULT_APPEARANCE.translucencyLevel,
      frost: oneOf(record.frost, FROSTS) ?? DEFAULT_APPEARANCE.frost,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * The snapshot is CACHED BY RAW STRING, because useSyncExternalStore compares
 * snapshots by identity and a fresh object every read is an infinite render
 * loop — the exact failure the hook's docs warn about.
 */
let cache: { raw: string | null; value: Appearance } | undefined;

function readAppearance(): Appearance {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing: the default look, not an error.
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseAppearance(raw) };
  return cache.value;
}

function writeAppearance(patch: Partial<Appearance>): void {
  const next = { ...readAppearance(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence lost, this session keeps the choice via the listeners.
    cache = { raw: null, value: next };
  }
  for (const listener of listeners) listener();
}

export function useAppearance(): { appearance: Appearance; setAppearance: (patch: Partial<Appearance>) => void } {
  const appearance = useSyncExternalStore(subscribe, readAppearance, () => DEFAULT_APPEARANCE);
  const setAppearance = useCallback((patch: Partial<Appearance>) => writeAppearance(patch), []);
  return useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
}

/** Keeps <html>'s attributes tracking the store after the init script's one
 *  shot — the same division of labour as ThemeProvider. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const set = (name: string, value: string, isDefault: boolean) => {
    if (isDefault) root.removeAttribute(name);
    else root.setAttribute(name, value);
  };
  set("data-accent", appearance.accent, appearance.accent === DEFAULT_APPEARANCE.accent);
  set("data-font-sans", appearance.fontSans, appearance.fontSans === DEFAULT_APPEARANCE.fontSans);
  set("data-font-mono", appearance.fontMono, appearance.fontMono === DEFAULT_APPEARANCE.fontMono);
  set("data-translucent", "", !appearance.translucent);
  if (appearance.translucent) root.style.setProperty("--translucency", translucencyCss(appearance.translucencyLevel));
  else root.style.removeProperty("--translucency");
}
