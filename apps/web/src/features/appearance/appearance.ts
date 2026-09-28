"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  ACCENTS,
  DEPTHS,
  APP_FONTS,
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
  type AppFont,
} from "@telar/engine-client";

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
  APP_FONTS,
  MONOSPACED_FONTS,
  type Accent,
  type Depth,
  type AppFont,
} from "@telar/engine-client";

const CUSTOM_SANS_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const CUSTOM_MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

export type Appearance = {
  accent: Accent;
  fontSans: AppFont;
  fontMono: AppFont;
  fontSansCustom: string;
  fontMonoCustom: string;
  fontSize: number;
  fontMonoSize: number;
  translucent: boolean;
  translucencyLevel: number;
  depth: Depth;
  frost: Frost;
};

const FROSTS = ["blur", "clear"] as const;
export type Frost = (typeof FROSTS)[number];

function translucencyCss(level: number): string {
  return `${Math.round(level * 0.9)}%`;
}

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

export const APPEARANCE_INIT_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem('${STORAGE_KEY}')||'{}');var d=document.documentElement;var css=localStorage.getItem('telar-theme-css');if(css){var s=document.createElement('style');s.id='telar-theme';s.textContent=css;document.head.appendChild(s);}var set=function(n,v,ok){if(ok.indexOf(v)>=0&&v!==ok[0])d.setAttribute(n,v);else d.removeAttribute(n);};set('data-accent',a.accent,${JSON.stringify([...ACCENTS])});set('data-font-sans',a.fontSans,${JSON.stringify([...APP_FONTS])});set('data-font-mono',a.fontMono,${JSON.stringify([...APP_FONTS])});set('data-depth',a.depth,${JSON.stringify([...DEPTHS])});var ff=function(v){if(typeof v!=='string')return null;var o=[];v.split(',').forEach(function(n){n=n.trim();if(!n)return;if(/^['"].*['"]$/.test(n)||/^[a-zA-Z][a-zA-Z0-9-]*$/.test(n))o.push(n);else o.push('"'+n.replace(/"/g,'')+'"');});return o.length?o.join(', '):null;};var fam=function(p,mode,raw,fb){var l=mode==='custom'?ff(raw):null;if(l)d.style.setProperty(p,l+', '+fb);else d.style.removeProperty(p);};fam('--app-font-sans',a.fontSans,a.fontSansCustom,'${CUSTOM_SANS_FALLBACK}');fam('--app-font-mono',a.fontMono,a.fontMonoCustom,'${CUSTOM_MONO_FALLBACK}');var fs=typeof a.fontSize==='number'&&isFinite(a.fontSize)?Math.min(${MAX_FONT_SIZE},Math.max(${MIN_FONT_SIZE},Math.round(a.fontSize))):${DEFAULT_APPEARANCE.fontSize};if(fs!==${DEFAULT_APPEARANCE.fontSize})d.style.fontSize=fs+'px';else d.style.removeProperty('font-size');var l=typeof a.translucencyLevel==='number'&&a.translucencyLevel>=${MIN_TRANSLUCENCY}&&a.translucencyLevel<=${MAX_TRANSLUCENCY}?a.translucencyLevel:${DEFAULT_APPEARANCE.translucencyLevel};var ms=typeof a.fontMonoSize==='number'&&isFinite(a.fontMonoSize)?Math.min(${MAX_MONO_FONT_SIZE},Math.max(${MIN_MONO_FONT_SIZE},Math.round(a.fontMonoSize))):${DEFAULT_APPEARANCE.fontMonoSize};d.style.setProperty('--app-font-mono-size',ms+'px');d.style.setProperty('--translucency',Math.round(l*0.9)+'%');if(a.translucent===true)d.setAttribute('data-translucent','');else d.removeAttribute('data-translucent');}catch(e){}})();`;

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

export function parseAppearance(raw: string | null): Appearance {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      accent: oneOf(record.accent, ACCENTS) ?? DEFAULT_APPEARANCE.accent,
      fontSans: oneOf(record.fontSans, APP_FONTS) ?? DEFAULT_APPEARANCE.fontSans,
      fontMono: oneOf(record.fontMono, APP_FONTS) ?? DEFAULT_APPEARANCE.fontMono,
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

let cache: { raw: string | null; value: Appearance } | undefined;

function readAppearance(): Appearance {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseAppearance(raw) };
  return cache.value;
}

function writeAppearance(patch: Partial<Appearance>): void {
  const next = { ...readAppearance(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    cache = { raw: null, value: next };
  }
  for (const listener of listeners) listener();
}

export function useAppearance(): { appearance: Appearance; setAppearance: (patch: Partial<Appearance>) => void } {
  const appearance = useSyncExternalStore(subscribe, readAppearance, () => DEFAULT_APPEARANCE);
  const setAppearance = useCallback((patch: Partial<Appearance>) => writeAppearance(patch), []);
  return useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
}

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
  const family = (property: string, custom: boolean, raw: string, fallback: string) => {
    const list = custom ? cssFontFamilies(raw) : null;
    if (list === null) root.style.removeProperty(property);
    else root.style.setProperty(property, `${list}, ${fallback}`);
  };
  family("--app-font-sans", appearance.fontSans === "custom", appearance.fontSansCustom, CUSTOM_SANS_FALLBACK);
  family("--app-font-mono", appearance.fontMono === "custom", appearance.fontMonoCustom, CUSTOM_MONO_FALLBACK);
  if (appearance.fontSize === DEFAULT_APPEARANCE.fontSize) root.style.removeProperty("font-size");
  else root.style.fontSize = `${appearance.fontSize}px`;
  root.style.setProperty("--app-font-mono-size", `${appearance.fontMonoSize}px`);
  applyWindowChrome(appearance);
  root.style.setProperty("--translucency", translucencyCss(appearance.translucencyLevel));
}

function applyWindowChrome(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance.translucent) root.setAttribute("data-translucent", "");
  else root.removeAttribute("data-translucent");
}
