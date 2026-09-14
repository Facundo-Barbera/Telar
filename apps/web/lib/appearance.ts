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
import {
  ACCENTS,
  DEPTHS,
  MONO_FONTS,
  SANS_FONTS,
  DEFAULT_ACCENT,
  DEFAULT_DEPTH,
  DEFAULT_FONT_SIZE,
  DEFAULT_MONO_FONT_SIZE,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  DEFAULT_TRANSLUCENCY_LEVEL,
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  type Accent,
  type Depth,
  type MonoFont,
  type SansFont,
} from "@telar/engine-client";

/**
 * THE NAMES AND THEIR BOUNDS MOVED to @telar/engine-client, because a `Look`
 * on the wire carries an accent name, two typeface names, a text size and a
 * strength — and the parser that reads one has to know the same eight accents
 * and the same 13–18px range this store does. The MECHANISM stayed: the hues
 * live in globals.css keyed by `data-accent`, and everything below writes
 * attributes on <html>. Re-exported so no importer changed.
 */
export {
  ACCENTS,
  DEPTHS,
  DEFAULT_DEPTH,
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  MONO_FONTS,
  MONOSPACED_FONTS,
  SANS_FONTS,
  type Accent,
  type Depth,
  type MonoFont,
  type SansFont,
} from "@telar/engine-client";

/** Fallbacks appended after a custom family, so glyph coverage never regresses
 *  below what the default stacks in globals.css already guarantee. */
const CUSTOM_SANS_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const CUSTOM_MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  // Already quoted, or a single ident that CSS accepts unquoted.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/**
 * A typed family (one name, or a comma-separated list) as a CSS font-family
 * value — null when the input is effectively empty, which is the caller's
 * signal to remove the override rather than write an empty one. Embedded
 * double-quotes are stripped, so no input can close the declaration early.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

export type Appearance = {
  accent: Accent;
  fontSans: SansFont;
  fontMono: MonoFont;
  /** Only consulted when the matching choice is "custom"; kept across a switch
   *  away and back so trying System does not cost the reader their typing. */
  fontSansCustom: string;
  fontMonoCustom: string;
  fontSize: number;
  /** Mono CONTENT — code, diffs, file previews, the terminal. */
  fontMonoSize: number;
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
  /** How far the elevation ladder travels. Unlike `translucent` and `frost`
   *  below it, this is TASTE and travels in a Look — see DEPTHS. */
  depth: Depth;
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
 * frosted by the OS and never clear glass. The bounds themselves are in the
 * shared look vocabulary, re-exported above.
 */

/** Display value → the percentage the CSS actually subtracts from opacity. */
export function translucencyCss(level: number): string {
  return `${Math.round(level * 0.9)}%`;
}

/** The taste members come from the shared vocabulary so a Look parsed off the
 *  wire and a store read here fall back to the same values; `translucent` and
 *  `frost` are properties of the MACHINE and belong only to this store. */
export const DEFAULT_APPEARANCE: Appearance = {
  accent: DEFAULT_ACCENT,
  fontSans: DEFAULT_SANS_FONT,
  fontMono: DEFAULT_MONO_FONT,
  fontSansCustom: "",
  fontMonoCustom: "",
  fontSize: DEFAULT_FONT_SIZE,
  fontMonoSize: DEFAULT_MONO_FONT_SIZE,
  translucent: false,
  translucencyLevel: DEFAULT_TRANSLUCENCY_LEVEL,
  depth: DEFAULT_DEPTH,
  frost: "blur",
};

const STORAGE_KEY = "telar-appearance";

/**
 * Pre-paint application, mirrored from THEME_INIT_SCRIPT: dependency-free,
 * inlined in <head>, and failing to the defaults on ANY error. Attributes for
 * default values are OMITTED rather than written, so the base tokens in
 * globals.css stay the single source of the default look.
 */
export const APPEARANCE_INIT_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem('${STORAGE_KEY}')||'{}');var d=document.documentElement;var css=localStorage.getItem('telar-theme-css');if(css){var s=document.createElement('style');s.id='telar-theme';s.textContent=css;document.head.appendChild(s);}var set=function(n,v,ok){if(ok.indexOf(v)>=0&&v!==ok[0])d.setAttribute(n,v);else d.removeAttribute(n);};set('data-accent',a.accent,${JSON.stringify([...ACCENTS])});set('data-font-sans',a.fontSans,${JSON.stringify([...SANS_FONTS])});set('data-font-mono',a.fontMono,${JSON.stringify([...MONO_FONTS])});set('data-depth',a.depth,${JSON.stringify([...DEPTHS])});var ff=function(v){if(typeof v!=='string')return null;var o=[];v.split(',').forEach(function(n){n=n.trim();if(!n)return;if(/^['"].*['"]$/.test(n)||/^[a-zA-Z][a-zA-Z0-9-]*$/.test(n))o.push(n);else o.push('"'+n.replace(/"/g,'')+'"');});return o.length?o.join(', '):null;};var fam=function(p,mode,raw,fb){var l=mode==='custom'?ff(raw):null;if(l)d.style.setProperty(p,l+', '+fb);else d.style.removeProperty(p);};fam('--app-font-sans',a.fontSans,a.fontSansCustom,'${CUSTOM_SANS_FALLBACK}');fam('--app-font-mono',a.fontMono,a.fontMonoCustom,'${CUSTOM_MONO_FALLBACK}');var fs=typeof a.fontSize==='number'&&isFinite(a.fontSize)?Math.min(${MAX_FONT_SIZE},Math.max(${MIN_FONT_SIZE},Math.round(a.fontSize))):${DEFAULT_APPEARANCE.fontSize};if(fs!==${DEFAULT_APPEARANCE.fontSize})d.style.fontSize=fs+'px';else d.style.removeProperty('font-size');var l=typeof a.translucencyLevel==='number'&&a.translucencyLevel>=${MIN_TRANSLUCENCY}&&a.translucencyLevel<=${MAX_TRANSLUCENCY}?a.translucencyLevel:${DEFAULT_APPEARANCE.translucencyLevel};var ms=typeof a.fontMonoSize==='number'&&isFinite(a.fontMonoSize)?Math.min(${MAX_MONO_FONT_SIZE},Math.max(${MIN_MONO_FONT_SIZE},Math.round(a.fontMonoSize))):${DEFAULT_APPEARANCE.fontMonoSize};d.style.setProperty('--app-font-mono-size',ms+'px');d.style.setProperty('--translucency',Math.round(l*0.9)+'%');if(a.translucent===true)d.setAttribute('data-translucent','');else d.removeAttribute('data-translucent');}catch(e){}})();`;

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
      fontSansCustom: typeof record.fontSansCustom === "string" ? record.fontSansCustom : DEFAULT_APPEARANCE.fontSansCustom,
      fontMonoCustom: typeof record.fontMonoCustom === "string" ? record.fontMonoCustom : DEFAULT_APPEARANCE.fontMonoCustom,
      fontSize:
        typeof record.fontSize === "number" && Number.isFinite(record.fontSize)
          ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(record.fontSize)))
          : DEFAULT_APPEARANCE.fontSize,
      fontMonoSize:
        typeof record.fontMonoSize === "number" && Number.isFinite(record.fontMonoSize)
          ? Math.min(MAX_MONO_FONT_SIZE, Math.max(MIN_MONO_FONT_SIZE, Math.round(record.fontMonoSize)))
          : DEFAULT_APPEARANCE.fontMonoSize,
      translucent: record.translucent === true,
      translucencyLevel:
        typeof record.translucencyLevel === "number" && record.translucencyLevel >= MIN_TRANSLUCENCY && record.translucencyLevel <= MAX_TRANSLUCENCY
          ? Math.round(record.translucencyLevel)
          : DEFAULT_APPEARANCE.translucencyLevel,
      depth: oneOf(record.depth, DEPTHS) ?? DEFAULT_APPEARANCE.depth,
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

/** The stored appearance, read outside React. */
export function currentAppearance(): Appearance {
  return readAppearance();
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
  set("data-depth", appearance.depth, appearance.depth === DEFAULT_APPEARANCE.depth);
  // A custom family is written INLINE, which outranks the [data-font-*] blocks
  // in globals.css; removing it hands the choice back to those blocks.
  const family = (property: string, custom: boolean, raw: string, fallback: string) => {
    const list = custom ? cssFontFamilies(raw) : null;
    if (list === null) root.style.removeProperty(property);
    else root.style.setProperty(property, `${list}, ${fallback}`);
  };
  family("--app-font-sans", appearance.fontSans === "custom", appearance.fontSansCustom, CUSTOM_SANS_FALLBACK);
  family("--app-font-mono", appearance.fontMono === "custom", appearance.fontMonoCustom, CUSTOM_MONO_FALLBACK);
  // Left unset at the default so the document keeps the browser's own root
  // size — including a reader's larger minimum.
  if (appearance.fontSize === DEFAULT_APPEARANCE.fontSize) root.style.removeProperty("font-size");
  else root.style.fontSize = `${appearance.fontSize}px`;
  // Read by globals.css on the elements that actually HOLD mono content, so
  // mono chrome (a panel header) keeps the size its utility class gave it.
  root.style.setProperty("--app-font-mono-size", `${appearance.fontMonoSize}px`);
  applyWindowChrome(appearance);
  // Written UNCONDITIONALLY: the wash rules gate on data-translucent OR
  // data-backdrop (lib/backdrop.ts), and both read this one strength var.
  // With neither attribute present it is inert, so there is nothing to save
  // by removing it.
  root.style.setProperty("--translucency", translucencyCss(appearance.translucencyLevel));
}

/**
 * THE PART OF THE APPEARANCE THAT IS THE MACHINE, NOT THE LOOK.
 *
 * A Look carries taste — the palette, the accent, the type, how much shows
 * through. It pointedly does NOT carry `translucent` (lib/looks.ts says why:
 * it is macOS-only, the shell owns the authoritative copy, and turning it on
 * rebuilds the window). Split out from `applyAppearance` so that a caller
 * wearing a whole LOOK writes everything except this, and the window's own
 * property is never a side effect of trying a colour scheme.
 */
export function applyWindowChrome(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance.translucent) root.setAttribute("data-translucent", "");
  else root.removeAttribute("data-translucent");
}
