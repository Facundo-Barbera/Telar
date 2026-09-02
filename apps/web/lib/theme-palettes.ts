"use client";

/**
 * THEMES — the surface palette as a library, modelled on t3 code's.
 *
 * A theme is TWO HALVES, light and dark, each a complete set of SURFACE
 * tokens over the vocabulary globals.css defines. The division of labour with
 * the rest of Appearance is deliberate:
 *
 *   - THEMES own the neutral spine — canvas, cards, chips, borders, the rail.
 *   - THE ACCENT ROW keeps owning --primary (and the state ramps are never
 *     themed at all: --success meaning "good" is not a matter of taste).
 *
 * So switching themes never silently changes what buttons look like, and an
 * accent choice survives every theme change.
 *
 * HOW IT REACHES PIXELS: the active theme compiles to a tiny stylesheet
 * (`html:root { … } html:root.dark { … }` — one level of specificity above
 * globals.css's `:root`/`.dark`, so it wins by construction, while the
 * translucency rules at (0,2,0) still win above IT). The compiled CSS is
 * cached in localStorage so the pre-paint init script can inject it without
 * knowing how to compile — the same trick THEME_INIT_SCRIPT uses for the
 * scheme class.
 *
 * "telar" is the default theme and compiles to NOTHING: the base tokens in
 * globals.css are the single source of the default look.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

/** The themable surface tokens, in the order the editor shows them. */
export const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "sidebar",
  "sidebar-accent",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export const THEME_TOKEN_LABELS: Record<ThemeToken, string> = {
  background: "Canvas",
  foreground: "Text",
  card: "Card",
  "card-foreground": "Card text",
  popover: "Popover",
  "popover-foreground": "Popover text",
  secondary: "Chip",
  "secondary-foreground": "Chip text",
  muted: "Muted",
  "muted-foreground": "Muted text",
  accent: "Hover",
  "accent-foreground": "Hover text",
  border: "Border",
  input: "Field border",
  sidebar: "Rail",
  "sidebar-accent": "Rail hover",
};

export type ThemeHalf = Record<ThemeToken, string>;
export type ThemeDefinition = {
  id: string;
  label: string;
  builtIn?: boolean;
  light: ThemeHalf;
  dark: ThemeHalf;
};

/**
 * A tinted half, derived the way the base palette was tuned: Telar's exact
 * lightness spine (every contrast claim in globals.css is a claim about L),
 * with the neutral's chroma and hue swapped for the theme's. Chroma stays
 * small — these are TINTS; a theme whose canvas is saturated is a poster, not
 * a workspace.
 */
function tintedLight(hue: number, chroma: number): ThemeHalf {
  const c = (factor: number) => (chroma * factor).toFixed(4);
  return {
    background: `oklch(0.988 ${c(0.5)} ${hue})`,
    foreground: `oklch(0.28 ${c(0.8)} ${hue})`,
    card: `oklch(0.999 ${c(0.25)} ${hue})`,
    "card-foreground": `oklch(0.28 ${c(0.8)} ${hue})`,
    popover: `oklch(0.999 ${c(0.25)} ${hue})`,
    "popover-foreground": `oklch(0.28 ${c(0.8)} ${hue})`,
    secondary: `oklch(0.955 ${c(1)} ${hue})`,
    "secondary-foreground": `oklch(0.28 ${c(0.8)} ${hue})`,
    muted: `oklch(0.962 ${c(0.9)} ${hue})`,
    "muted-foreground": `oklch(0.52 ${c(1.2)} ${hue})`,
    accent: `oklch(0.948 ${c(1)} ${hue})`,
    "accent-foreground": `oklch(0.22 ${c(0.8)} ${hue})`,
    border: `oklch(0.91 ${c(1.1)} ${hue})`,
    input: `oklch(0.65 ${c(1.2)} ${hue})`,
    sidebar: `oklch(0.968 ${c(0.9)} ${hue})`,
    "sidebar-accent": `oklch(0.94 ${c(1.1)} ${hue})`,
  };
}

function tintedDark(hue: number, chroma: number): ThemeHalf {
  const c = (factor: number) => (chroma * factor).toFixed(4);
  return {
    background: `oklch(0.16 ${c(1)} ${hue})`,
    foreground: `oklch(0.965 ${c(0.35)} ${hue})`,
    card: `oklch(0.21 ${c(1.1)} ${hue})`,
    "card-foreground": `oklch(0.965 ${c(0.35)} ${hue})`,
    popover: `oklch(0.235 ${c(1.1)} ${hue})`,
    "popover-foreground": `oklch(0.965 ${c(0.35)} ${hue})`,
    secondary: `oklch(0.275 ${c(1.2)} ${hue})`,
    "secondary-foreground": `oklch(0.965 ${c(0.35)} ${hue})`,
    muted: `oklch(0.275 ${c(1.2)} ${hue})`,
    "muted-foreground": `oklch(0.72 ${c(0.8)} ${hue})`,
    accent: `oklch(0.315 ${c(1.3)} ${hue})`,
    "accent-foreground": `oklch(0.965 ${c(0.35)} ${hue})`,
    border: `oklch(1 0 0 / 10%)`,
    input: `oklch(0.53 ${c(0.8)} ${hue})`,
    sidebar: `oklch(0.19 ${c(1)} ${hue})`,
    "sidebar-accent": `oklch(0.275 ${c(1.2)} ${hue})`,
  };
}

/**
 * The library's built-ins. "telar" is identity — no overrides, globals.css IS
 * that theme. The rest tint the spine toward a family: warm sand, forest,
 * deep sea, violet dusk. Hues chosen off the accent wheel's stops so a theme
 * plus any accent still reads deliberate.
 */
export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [
  { id: "telar", label: "Telar", builtIn: true, light: {} as ThemeHalf, dark: {} as ThemeHalf },
  { id: "ember", label: "Ember", builtIn: true, light: tintedLight(65, 0.016), dark: tintedDark(55, 0.014) },
  { id: "grove", label: "Grove", builtIn: true, light: tintedLight(150, 0.014), dark: tintedDark(155, 0.014) },
  { id: "tide", label: "Tide", builtIn: true, light: tintedLight(225, 0.014), dark: tintedDark(235, 0.018) },
  { id: "iris", label: "Iris", builtIn: true, light: tintedLight(300, 0.014), dark: tintedDark(295, 0.016) },
];

const ACTIVE_KEY = "telar-theme-active";
const CUSTOM_KEY = "telar-themes-custom";
/** The COMPILED stylesheet, cached for the pre-paint init script — which must
 *  not need the compiler. Rewritten on every theme change. */
export const THEME_CSS_KEY = "telar-theme-css";

export function compileTheme(theme: ThemeDefinition): string {
  if (theme.id === "telar") return "";
  const declarations = (half: ThemeHalf) =>
    THEME_TOKENS.filter((token) => half[token])
      .map((token) => `--${token}: ${half[token]};`)
      .join(" ");
  // `html:root` outranks globals.css's `:root` by one type selector; the
  // translucency overrides at two attributes still outrank both.
  return `html:root { ${declarations(theme.light)} } html:root.dark { ${declarations(theme.dark)} }`;
}

function isHalf(value: unknown): value is ThemeHalf {
  return typeof value === "object" && value !== null && THEME_TOKENS.every((token) => typeof (value as Record<string, unknown>)[token] === "string");
}

/** Total: a garbage entry is dropped, never thrown on. */
export function parseCustomThemes(raw: string | null): ThemeDefinition[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const candidate = entry as Partial<ThemeDefinition>;
      if (typeof candidate.id !== "string" || typeof candidate.label !== "string") return [];
      if (!isHalf(candidate.light) || !isHalf(candidate.dark)) return [];
      return [{ id: candidate.id, label: candidate.label, light: candidate.light, dark: candidate.dark }];
    });
  } catch {
    return [];
  }
}

/** One custom theme as a shareable file — the import dialog reads the same
 *  shape back, so export → import round-trips. */
export function serializeTheme(theme: ThemeDefinition): string {
  return JSON.stringify({ label: theme.label, light: theme.light, dark: theme.dark }, null, 2);
}

export function parseThemeFile(raw: string): Omit<ThemeDefinition, "id"> | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ThemeDefinition>;
    if (typeof parsed.label !== "string" || !isHalf(parsed.light) || !isHalf(parsed.dark)) return undefined;
    return { label: parsed.label, light: parsed.light, dark: parsed.dark };
  } catch {
    return undefined;
  }
}

/** What the "telar" identity theme's cards and editor seeds show: the real
 *  base values from globals.css, restated once. */
export const TELAR_LIGHT: ThemeHalf = {
  background: "oklch(0.992 0 0)",
  foreground: "oklch(0.274 0.006 286)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.274 0.006 286)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.274 0.006 286)",
  secondary: "oklch(0.96 0.002 286)",
  "secondary-foreground": "oklch(0.274 0.006 286)",
  muted: "oklch(0.967 0.001 286)",
  "muted-foreground": "oklch(0.525 0.016 286)",
  accent: "oklch(0.955 0.002 286)",
  "accent-foreground": "oklch(0.21 0.006 286)",
  border: "oklch(0.92 0.004 286)",
  input: "oklch(0.66 0.008 286)",
  sidebar: "oklch(0.972 0.001 286)",
  "sidebar-accent": "oklch(0.945 0.003 286)",
};

export const TELAR_DARK: ThemeHalf = {
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.97 0 0)",
  card: "oklch(0.2 0 0)",
  "card-foreground": "oklch(0.97 0 0)",
  popover: "oklch(0.225 0 0)",
  "popover-foreground": "oklch(0.97 0 0)",
  secondary: "oklch(0.265 0 0)",
  "secondary-foreground": "oklch(0.97 0 0)",
  muted: "oklch(0.265 0 0)",
  "muted-foreground": "oklch(0.708 0 0)",
  accent: "oklch(0.305 0 0)",
  "accent-foreground": "oklch(0.97 0 0)",
  border: "oklch(1 0 0 / 10%)",
  input: "oklch(0.53 0 0)",
  sidebar: "oklch(0.175 0 0)",
  "sidebar-accent": "oklch(0.265 0 0)",
};

/** A half with every token filled — the editor and preview need concrete
 *  values, and the identity theme's halves are deliberately empty. */
export function concreteHalf(theme: ThemeDefinition, mode: "light" | "dark"): ThemeHalf {
  const base = mode === "light" ? TELAR_LIGHT : TELAR_DARK;
  return { ...base, ...(theme[mode] ?? {}) };
}

// ── The store ────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

type ThemeState = { activeId: string; custom: ThemeDefinition[] };

let cache: { raw: string; value: ThemeState } | undefined;

function readState(): ThemeState {
  let activeId = "telar";
  let customRaw: string | null = null;
  try {
    activeId = window.localStorage.getItem(ACTIVE_KEY) ?? "telar";
    customRaw = window.localStorage.getItem(CUSTOM_KEY);
  } catch {
    // Private browsing — the default theme.
  }
  const raw = `${activeId}\n${customRaw ?? ""}`;
  if (!cache || cache.raw !== raw) cache = { raw, value: { activeId, custom: parseCustomThemes(customRaw) } };
  return cache.value;
}

const SERVER_STATE: ThemeState = { activeId: "telar", custom: [] };

function findTheme(state: ThemeState, id: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? state.custom.find((theme) => theme.id === id);
}

/** Every write funnels here so the COMPILED cache can never go stale against
 *  the choice it caches. */
function write(next: Partial<{ activeId: string; custom: ThemeDefinition[] }>): void {
  const current = readState();
  const state: ThemeState = { activeId: next.activeId ?? current.activeId, custom: next.custom ?? current.custom };
  const active = findTheme(state, state.activeId) ?? BUILT_IN_THEMES[0];
  try {
    window.localStorage.setItem(ACTIVE_KEY, active.id);
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.custom));
    window.localStorage.setItem(THEME_CSS_KEY, compileTheme(active));
  } catch {
    // The in-page listeners still fire; only persistence is lost.
  }
  notify();
}

export function applyThemeCss(): void {
  let css = "";
  try {
    css = window.localStorage.getItem(THEME_CSS_KEY) ?? "";
  } catch {
    // Default theme.
  }
  let style = document.getElementById("telar-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "telar-theme";
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

export function useThemeLibrary(): {
  activeId: string;
  themes: ThemeDefinition[];
  setActive: (id: string) => void;
  saveCustom: (theme: ThemeDefinition) => void;
  removeCustom: (id: string) => void;
  duplicate: (id: string) => string | undefined;
  importTheme: (raw: string) => string | undefined;
} {
  const state = useSyncExternalStore(subscribe, readState, () => SERVER_STATE);

  const setActive = useCallback((id: string) => write({ activeId: id }), []);

  const saveCustom = useCallback((theme: ThemeDefinition) => {
    const { custom } = readState();
    const next = custom.some((entry) => entry.id === theme.id) ? custom.map((entry) => (entry.id === theme.id ? theme : entry)) : [...custom, theme];
    write({ custom: next });
  }, []);

  const removeCustom = useCallback((id: string) => {
    const current = readState();
    write({
      custom: current.custom.filter((entry) => entry.id !== id),
      // Deleting the theme you are wearing falls back to the default rather
      // than leaving a dangling id pointing at nothing.
      ...(current.activeId === id ? { activeId: "telar" } : {}),
    });
  }, []);

  const duplicate = useCallback((id: string) => {
    const current = readState();
    const source = findTheme(current, id);
    if (!source) return undefined;
    const copy: ThemeDefinition = {
      id: `custom-${Date.now().toString(36)}`,
      label: `${source.label} copy`,
      light: concreteHalf(source, "light"),
      dark: concreteHalf(source, "dark"),
    };
    write({ custom: [...current.custom, copy] });
    return copy.id;
  }, []);

  const importTheme = useCallback((raw: string) => {
    const parsed = parseThemeFile(raw);
    if (!parsed) return undefined;
    const theme: ThemeDefinition = { id: `custom-${Date.now().toString(36)}`, ...parsed };
    write({ custom: [...readState().custom, theme], activeId: theme.id });
    return theme.id;
  }, []);

  return useMemo(
    () => ({ activeId: state.activeId, themes: [...BUILT_IN_THEMES, ...state.custom], setActive, saveCustom, removeCustom, duplicate, importTheme }),
    [state, setActive, saveCustom, removeCustom, duplicate, importTheme],
  );
}

// ── Colour conversion for the editor's pickers ──────────────────────────────
// <input type="color"> speaks hex only; the built-ins speak oklch. Ported from
// the standard OKLab matrices (the same maths t3 code's preview uses).

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

export function cssColorToHex(value: string): string {
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/.exec(value);
  if (oklch) {
    const l = Number(oklch[1]);
    const chroma = Number(oklch[2]);
    const hue = (Number(oklch[3]) * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const channels = [
      linearToSrgb(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
      linearToSrgb(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
      linearToSrgb(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
    ];
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  // A translucent border ("oklch(1 0 0 / 10%)") or anything else exotic: the
  // picker shows an approximation and writing through it replaces the value.
  return "#808080";
}

/** Hex straight through — CSS accepts it, and round-tripping user picks
 *  through oklch would drift them. */
export function hexToCssColor(hex: string): string {
  return hex;
}
