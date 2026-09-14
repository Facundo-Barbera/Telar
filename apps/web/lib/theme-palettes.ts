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
 * THE HALVES ARE INDEPENDENTLY WEARABLE, as in t3 code: the active selection
 * is a PAIR — one theme owns light, another owns dark — so you can take
 * Ember's day and Tide's night. Clicking a card wears both halves; clicking
 * one of its orbs wears only that half.
 *
 * HOW IT REACHES PIXELS: the active pair compiles to a tiny stylesheet
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
import { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeHalf, type ThemeToken } from "@telar/engine-client";

/**
 * THE TOKENS AND THE BASE HALVES MOVED to @telar/engine-client: a `Look` on the
 * wire embeds two concrete halves, and the parser that reads one fills the gaps
 * from exactly these values. They are plain data — the COMPILER, the cache and
 * the library store all stayed here. Re-exported so no importer changed.
 */
export { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type ThemeHalf, type ThemeToken } from "@telar/engine-client";

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
    /**
     * THE HAIRLINE IS TINTED TOO, and it was the one token in this half that
     * was not.
     *
     * `oklch(1 0 0 / 10%)` is the base palette's dark border, and copying it
     * verbatim into a tinted theme put pure achromatic white on every edge in
     * the app — the most repeated mark there is, and the only one still
     * insisting the theme was grey. Alpha is what makes --border work on all
     * four rungs of the elevation ladder from one value (see globals.css), so
     * that part stays; only the ink it lays down moves.
     *
     * L 0.92 RATHER THAN 1, and it buys the hue rather than costing contrast.
     * sRGB has almost no chroma left at L 1, so a tinted white clamps straight
     * back to white; at 0.92 the chroma actually lands. The composite over a
     * 0.16 canvas is within a thousandth of a lightness step of the old value
     * once the alpha is nudged 10% → 11% to pay for the darker ink, so the
     * hairline reads exactly as heavy as it did — just warm on Ember and cool
     * on Tide. Chroma is 3× the theme's base because a 11% veil dilutes it by
     * an order of magnitude; the surfaces above can afford subtlety, an edge
     * this thin cannot.
     */
    border: `oklch(0.92 ${c(3)} ${hue} / 11%)`,
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

/** Which theme owns each half. Both halves are usually the same theme. */
export type ActivePair = { light: string; dark: string };

export const DEFAULT_PAIR: ActivePair = { light: "telar", dark: "telar" };

function declarations(half: ThemeHalf): string {
  return THEME_TOKENS.filter((token) => half[token])
    .map((token) => `--${token}: ${half[token]};`)
    .join(" ");
}

/**
 * The two halves of the active pair, each from its own theme. "telar" is
 * identity, so its half contributes no block at all — the absent rule IS the
 * default look, and emitting an empty one would only be noise in the cache.
 *
 * `html:root` outranks globals.css's `:root` by one type selector; the
 * translucency overrides at two attributes still outrank both.
 */
export function compilePair(light: ThemeDefinition, dark: ThemeDefinition): string {
  const blocks: string[] = [];
  const lightRules = light.id === "telar" ? "" : declarations(light.light);
  if (lightRules) blocks.push(`html:root { ${lightRules} }`);
  const darkRules = dark.id === "telar" ? "" : declarations(dark.dark);
  if (darkRules) blocks.push(`html:root.dark { ${darkRules} }`);
  return blocks.join(" ");
}

/** One theme wearing both halves. */
export function compileTheme(theme: ThemeDefinition): string {
  return compilePair(theme, theme);
}

/**
 * Total, and deliberately forgiving of history: installs from before the pair
 * existed stored a bare id ("tide"), which means that theme wore both halves.
 * Anything else unreadable falls back to the default rather than throwing on
 * a path that runs before first paint.
 */
export function parseActivePair(raw: string | null): ActivePair {
  if (typeof raw !== "string") return DEFAULT_PAIR;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_PAIR;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const half = (value: unknown) => (typeof value === "string" && value !== "" ? value : "telar");
      return { light: half(parsed.light), dark: half(parsed.dark) };
    } catch {
      return DEFAULT_PAIR;
    }
  }
  // LEGACY: a bare theme id, and only that — anything else stored here is not
  // a selection this build ever wrote.
  if (/^[\w-]+$/.test(trimmed)) return { light: trimmed, dark: trimmed };
  return DEFAULT_PAIR;
}

/** Deleting a theme you are wearing sends that half home rather than leaving
 *  a dangling id pointing at nothing. */
export function dropTheme(active: ActivePair, removedId: string): ActivePair {
  return {
    light: active.light === removedId ? "telar" : active.light,
    dark: active.dark === removedId ? "telar" : active.dark,
  };
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

/** A half with every token filled — the editor and preview need concrete
 *  values, and the identity theme's halves are deliberately empty. */
/**
 * WHICH THEME THIS HALF CAME FROM — or nothing, if it came from your hands.
 *
 * The studio could never say what you were editing. Loading Ember put its
 * halves in the draft and renamed the LOOK; the palette itself stayed
 * anonymous, and the library's rings went on marking the theme you were
 * WEARING, which after a load is a different theme entirely. So the grid
 * pointed at Telar while you edited Ember.
 *
 * Comparison is by resolved hex rather than by the stored string, so a half
 * loaded from a theme still matches after a round trip through the colour
 * input — `oklch(0.16 0.018 235)` and `#0a0e12` are the same decision, and a
 * reader who has changed nothing should not be told they have.
 *
 * Ambiguity resolves to the FIRST match, built-ins before customs, because the
 * only way two themes tie is that they are the same palette under two names —
 * and then either answer is true.
 */
export function matchThemeHalf(half: ThemeHalf, themes: readonly ThemeDefinition[], mode: "light" | "dark"): ThemeDefinition | undefined {
  return themes.find((theme) => {
    const candidate = concreteHalf(theme, mode);
    return THEME_TOKENS.every((token) => cssColorToHex(candidate[token]) === cssColorToHex(half[token]));
  });
}

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

type ThemeState = { active: ActivePair; custom: ThemeDefinition[] };

let cache: { raw: string; value: ThemeState } | undefined;

function readState(): ThemeState {
  let activeRaw: string | null = null;
  let customRaw: string | null = null;
  try {
    activeRaw = window.localStorage.getItem(ACTIVE_KEY);
    customRaw = window.localStorage.getItem(CUSTOM_KEY);
  } catch {
    // Private browsing — the default theme.
  }
  const raw = `${activeRaw ?? ""}\n${customRaw ?? ""}`;
  if (!cache || cache.raw !== raw) cache = { raw, value: { active: parseActivePair(activeRaw), custom: parseCustomThemes(customRaw) } };
  return cache.value;
}

const SERVER_STATE: ThemeState = { active: DEFAULT_PAIR, custom: [] };

function findTheme(state: ThemeState, id: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? state.custom.find((theme) => theme.id === id);
}

/** A random suffix beside the timestamp: two ids minted in the same
 *  millisecond (duplicate, duplicate) must not collide and overwrite. */
function newCustomThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Every write funnels here so the COMPILED cache can never go stale against
 *  the choice it caches. */
function write(next: Partial<{ active: ActivePair; custom: ThemeDefinition[] }>): void {
  const current = readState();
  const state: ThemeState = { active: next.active ?? current.active, custom: next.custom ?? current.custom };
  // Resolve before persisting: a half pointing at a theme that no longer
  // exists is stored as the default, never as a dangling id.
  const light = findTheme(state, state.active.light) ?? BUILT_IN_THEMES[0];
  const dark = findTheme(state, state.active.dark) ?? BUILT_IN_THEMES[0];
  try {
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify({ light: light.id, dark: dark.id }));
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.custom));
    window.localStorage.setItem(THEME_CSS_KEY, compilePair(light, dark));
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
  /** The theme worn WHOLE, or undefined while the halves disagree. */
  activeId: string | undefined;
  active: ActivePair;
  themes: ThemeDefinition[];
  setActive: (id: string) => void;
  setHalf: (mode: "light" | "dark", id: string) => void;
  saveCustom: (theme: ThemeDefinition) => void;
  /** A theme the caller built (from a picture, from a file) into the library,
   *  with an id minted here. Returns it so the caller can wear it. */
  addCustom: (theme: Omit<ThemeDefinition, "id">) => ThemeDefinition;
  /**
   * EDIT THE PALETTE YOU ARE WEARING, with nothing in between (#471).
   *
   * The sixteen token rows used to write a studio draft and wait on Apply.
   * There is no draft now, so an edit has to land on a real library theme —
   * and which one is decided by the half you are editing, because the active
   * selection is a PAIR.
   *
   * A BUILT-IN FORKS. The five built-ins are this build's own table, restated
   * identically in every install; writing to one would make "Ember" mean
   * something different on each machine and would have nowhere to be stored.
   * So the first edit to a built-in half copies BOTH halves into a custom
   * theme, wears it on that half, and lands the edit there — after which the
   * half is wearing a custom theme and every later edit updates it in place,
   * which is what keeps a colour-picker drag from breeding a theme per frame.
   */
  editActiveHalf: (mode: "light" | "dark", patch: Partial<ThemeHalf>) => void;
  removeCustom: (id: string) => void;
  /** Returns the copy so the caller can load it straight into the draft. */
  duplicate: (id: string) => ThemeDefinition | undefined;
  /** Adds to the library WITHOUT wearing it — the studio decides what happens
   *  next. Returns the added theme, or undefined for an unreadable file. */
  importTheme: (raw: string) => ThemeDefinition | undefined;
} {
  const state = useSyncExternalStore(subscribe, readState, () => SERVER_STATE);

  const setActive = useCallback((id: string) => write({ active: { light: id, dark: id } }), []);

  const setHalf = useCallback((mode: "light" | "dark", id: string) => write({ active: { ...readState().active, [mode]: id } }), []);

  const saveCustom = useCallback((theme: ThemeDefinition) => {
    const { custom } = readState();
    const next = custom.some((entry) => entry.id === theme.id) ? custom.map((entry) => (entry.id === theme.id ? theme : entry)) : [...custom, theme];
    write({ custom: next });
  }, []);

  const addCustom = useCallback((theme: Omit<ThemeDefinition, "id">) => {
    const made: ThemeDefinition = { id: newCustomThemeId(), ...theme };
    write({ custom: [...readState().custom, made] });
    return made;
  }, []);

  const editActiveHalf = useCallback((mode: "light" | "dark", patch: Partial<ThemeHalf>) => {
    const current = readState();
    const source = findTheme(current, current.active[mode]) ?? BUILT_IN_THEMES[0]!;
    const edited: ThemeHalf = { ...concreteHalf(source, mode), ...patch };
    if (!source.builtIn) {
      write({ custom: current.custom.map((entry) => (entry.id === source.id ? { ...entry, [mode]: edited } : entry)) });
      return;
    }
    // The fork — see the contract on `editActiveHalf` above. The OTHER half is
    // copied concrete rather than left empty, so a copy of the identity theme
    // ("telar", whose halves are deliberately blank) still paints a whole app.
    const copy: ThemeDefinition = {
      id: newCustomThemeId(),
      label: `${source.label} edited`,
      light: mode === "light" ? edited : concreteHalf(source, "light"),
      dark: mode === "dark" ? edited : concreteHalf(source, "dark"),
    };
    write({ custom: [...current.custom, copy], active: { ...current.active, [mode]: copy.id } });
  }, []);

  const removeCustom = useCallback((id: string) => {
    const current = readState();
    write({ custom: current.custom.filter((entry) => entry.id !== id), active: dropTheme(current.active, id) });
  }, []);

  const duplicate = useCallback((id: string) => {
    const current = readState();
    const source = findTheme(current, id);
    if (!source) return undefined;
    const copy: ThemeDefinition = {
      id: newCustomThemeId(),
      label: `${source.label} copy`,
      light: concreteHalf(source, "light"),
      dark: concreteHalf(source, "dark"),
    };
    write({ custom: [...current.custom, copy] });
    return copy;
  }, []);

  const importTheme = useCallback((raw: string) => {
    const parsed = parseThemeFile(raw);
    if (!parsed) return undefined;
    const theme: ThemeDefinition = { id: newCustomThemeId(), ...parsed };
    write({ custom: [...readState().custom, theme] });
    return theme;
  }, []);

  return useMemo(
    () => ({
      activeId: state.active.light === state.active.dark ? state.active.light : undefined,
      active: state.active,
      themes: [...BUILT_IN_THEMES, ...state.custom],
      setActive,
      setHalf,
      saveCustom,
      addCustom,
      editActiveHalf,
      removeCustom,
      duplicate,
      importTheme,
    }),
    [state, setActive, setHalf, saveCustom, addCustom, editActiveHalf, removeCustom, duplicate, importTheme],
  );
}

// ── Colour conversion for the editor's pickers ──────────────────────────────
// <input type="color"> speaks hex only; the built-ins speak oklch. Ported from
// the standard OKLab matrices (the same maths t3 code's preview uses).

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One oklch component. Each may be a number, a percentage against its own
 * basis, or `none` — all three are valid CSS and only the first was read, so
 * `oklch(96% 0 0)` (a perfectly ordinary way to write a canvas) fell through
 * to the grey below.
 */
function oklchComponent(raw: string, percentBasis: number): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  return raw.endsWith("%") ? (number / 100) * percentBasis : number;
}

/** Degrees, from any of the four angle units CSS allows. */
function hueDegrees(raw: string): number {
  if (raw === "none") return 0;
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return Number.NaN;
  if (raw.endsWith("turn")) return number * 360;
  if (raw.endsWith("grad")) return number * 0.9;
  if (raw.endsWith("rad")) return (number * 180) / Math.PI;
  return number;
}

/**
 * ANYTHING CSS CAN PARSE, RESOLVED BY THE THING THAT PARSES CSS.
 *
 * A canvas context's `fillStyle` is a colour parser with a serialiser attached:
 * assigning an invalid value is a no-op by spec, so a sentinel tells "did not
 * parse" apart from "parsed to something". This is what catches named colours,
 * `hsl()`, `lab()`, `color()` and every syntax added after this file was
 * written, without any of them needing a branch here.
 *
 * Undefined outside a browser (the tests, and any pre-paint path) — the
 * caller's own branches cover everything this palette actually stores.
 */
function resolveThroughCss(value: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return undefined;
    const sentinel = "#010203";
    context.fillStyle = sentinel;
    context.fillStyle = value;
    const resolved = context.fillStyle;
    if (typeof resolved !== "string" || resolved === sentinel) return undefined;
    if (/^#[\da-f]{6}$/i.test(resolved)) return resolved.toLowerCase();
    // Translucent values serialise as `rgba(r, g, b, a)`; the alpha is dropped
    // for the same reason it is everywhere else here — see below.
    const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(resolved);
    if (!rgba) return undefined;
    return toHex([1, 2, 3].map((index) => Math.min(255, Math.max(0, Math.round(Number(rgba[index]))))));
  } catch {
    return undefined;
  }
}

/**
 * A CSS colour as the six-digit hex `<input type="color">` insists on.
 *
 * IT MUST ALWAYS RETURN `#rrggbb`. Both callers put the result straight into an
 * `<input type="color">`, whose value sanitiser rejects anything else and shows
 * black — so "return the original when it is exotic" would trade a wrong colour
 * for a wrong colour AND a broken swatch. Everything below exists to make the
 * last-resort grey unreachable in practice instead.
 *
 * It used to be two branches — a strict oklch shape, and literal `#rrggbb` —
 * and everything else became `#808080`. That grey is not a display artefact:
 * lib/studio-draft.ts fingerprints a draft through this function and
 * lib/vscode-theme-import.ts reads imported colours through it, so a value it
 * could not parse became a real grey downstream. `oklch(96% 0 0)`, `#abc`,
 * `rgb(20 20 20)` and every named colour all took that path.
 *
 * ALPHA IS DROPPED, AND THAT IS A PROPERTY OF THE WIDGET, NOT A BUG HERE. There
 * is no way to show 10% white in a colour input. `oklch(1 0 0 / 10%)` reports
 * as `#ffffff`, which is the honest answer to "what colour is this"; the alpha
 * survives in the stored value and is only lost if the reader actually picks a
 * new colour through that swatch, which is an edit.
 */
export function cssColorToHex(value: string): string {
  const trimmed = value.trim();

  const oklch = /^oklch\(\s*(none|[\d.]+%?)\s+(none|[\d.]+%?)\s+(none|-?[\d.]+(?:deg|rad|grad|turn)?)/i.exec(trimmed);
  if (oklch) {
    const l = oklchComponent(oklch[1], 1);
    const chroma = oklchComponent(oklch[2], 0.4);
    const degrees = hueDegrees(oklch[3]);
    if (Number.isFinite(l) && Number.isFinite(chroma) && Number.isFinite(degrees)) {
      const hue = (degrees * Math.PI) / 180;
      const a = chroma * Math.cos(hue);
      const b = chroma * Math.sin(hue);
      const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return toHex([
        linearToSrgb(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
        linearToSrgb(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
        linearToSrgb(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
      ]);
    }
  }

  // `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — the shorthands expand, the alpha
  // halves are cut off.
  const hex = /^#([\da-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return `#${[...digits.slice(0, 3)].map((digit) => digit + digit).join("")}`.toLowerCase();
    }
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`.toLowerCase();
  }

  // `rgb()` / `rgba()`, in either the comma or the space form, with numbers or
  // percentages — the syntax the VS Code theme importer meets most often.
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/i.exec(trimmed);
  if (rgb) {
    const channels = [1, 2, 3].map((index) => {
      const raw = rgb[index];
      const number = Number.parseFloat(raw);
      const scaled = raw.endsWith("%") ? (number / 100) * 255 : number;
      return Math.min(255, Math.max(0, Math.round(scaled)));
    });
    if (channels.every(Number.isFinite)) return toHex(channels);
  }

  return resolveThroughCss(trimmed) ?? "#808080";
}

/** Hex straight through — CSS accepts it, and round-tripping user picks
 *  through oklch would drift them. */
export function hexToCssColor(hex: string): string {
  return hex;
}
