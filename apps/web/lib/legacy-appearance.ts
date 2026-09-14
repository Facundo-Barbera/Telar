"use client";

/**
 * THE OLD APPEARANCE, READ FORWARD ONCE.
 *
 * Before the composition (#471) what the window wore lived in five keys: a
 * THEME PAIR naming one palette for light and one for dark, a library of custom
 * palettes to resolve those names against, and a BACKDROP choice with its
 * resolved CSS and whatever payload its kind kept elsewhere. All five are
 * finished — nothing in this build writes them — and an install that predates
 * the composition still has them, wearing exactly the look their owner chose.
 *
 * SO THIS FILE IS A ONE-WAY DOOR AND IT IS THE ONLY PLACE THE OLD SHAPE IS
 * SPOKEN. It reads those keys, hands them to `compositionFromV1` — the same
 * migration every exported Look file goes through, so there is one answer to
 * "what does the old shape mean" rather than two — and removes them. The
 * composition store calls it once, on the first read that finds no composition;
 * after that write there is nothing here to run again.
 *
 * A BUILT-IN THEME MIGRATES TO ITS BUILT-IN LOOK rather than through its
 * sixteen stored tokens. Those tokens were this build's own table restated, so
 * pinning them as hand-set overrides would migrate somebody onto a composition
 * whose base decided nothing — Ember frozen as sixteen literals, and moving the
 * base would change nothing until every one was cleared. A CUSTOM theme (one
 * you built, or a VS Code import) has no such table behind it and does migrate
 * token-for-token, which is what keeps it looking exactly as it did.
 */

import {
  compositionFromV1,
  parseLookBackdrop as parseLookBackdropValue,
  parseThemeHalf,
  TELAR_DARK,
  TELAR_LIGHT,
  THEME_TOKENS,
  type Composition,
  type LookBackdrop,
  type ThemeHalf,
} from "@telar/engine-client";
import { builtInComposition } from "./built-in-looks";
import { SCENE_PRESETS } from "./scene-composer";

/** The shared parser wearing THIS build's gradient preset table — imported
 *  straight rather than through lib/looks.ts, which reads the composition this
 *  file exists to create. */
const parseLookBackdrop = (value: unknown): LookBackdrop => parseLookBackdropValue(value, SCENE_PRESETS);

/* ------------------------------------------------------------- the old keys */

const THEME_ACTIVE_KEY = "telar-theme-active";
const THEME_CUSTOM_KEY = "telar-themes-custom";
const BACKDROP_KEY = "telar-backdrop";
const BACKDROP_LAYERS_KEY = "telar-backdrop-css";
const BACKDROP_IMAGE_KEY = "telar-backdrop-image";
const SCENE_KEY = "telar-backdrop-scene";
const SCENE_IMAGES_KEY = "telar-backdrop-scene-images";

const LEGACY_KEYS = [THEME_ACTIVE_KEY, THEME_CUSTOM_KEY, BACKDROP_KEY, BACKDROP_LAYERS_KEY, BACKDROP_IMAGE_KEY, SCENE_KEY, SCENE_IMAGES_KEY];

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseJson(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- the theme */

type LegacyPair = { light: string; dark: string };

/** Which theme owned each half. Installs from before the pair existed stored a
 *  bare id, meaning that theme wore both. */
export function parseActivePair(raw: string | null): LegacyPair {
  const fallback: LegacyPair = { light: "telar", dark: "telar" };
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  if (trimmed.startsWith("{")) {
    const parsed = parseJson(trimmed);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    const half = (value: unknown) => (typeof value === "string" && value !== "" ? value : "telar");
    return { light: half(record.light), dark: half(record.dark) };
  }
  if (/^[\w-]+$/.test(trimmed)) return { light: trimmed, dark: trimmed };
  return fallback;
}

type LegacyTheme = { id: string; light: ThemeHalf; dark: ThemeHalf };

/** Total: a garbage entry is dropped, never thrown on. */
export function parseCustomThemes(raw: string | null): LegacyTheme[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const themes: LegacyTheme[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const isHalf = (value: unknown) =>
      typeof value === "object" && value !== null && THEME_TOKENS.every((token) => typeof (value as Record<string, unknown>)[token] === "string");
    if (!isHalf(record.light) || !isHalf(record.dark)) continue;
    themes.push({ id: record.id, light: parseThemeHalf(record.light, "light"), dark: parseThemeHalf(record.dark, "dark") });
  }
  return themes;
}

/* ------------------------------------------------------------- the backdrop */

/**
 * The old backdrop as the self-contained value `compositionFromV1` takes. The
 * RESOLVED layers are read straight out of their cache rather than recomposed:
 * they were written at choice time precisely so nothing downstream would need
 * the preset table, and that is as true for a migration as for a pre-paint
 * script.
 */
export function readLegacyBackdrop(): LookBackdrop {
  const choice = parseJson(readKey(BACKDROP_KEY));
  if (typeof choice !== "object" || choice === null) return { kind: "none" };
  const record = choice as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "image") {
    const image = readKey(BACKDROP_IMAGE_KEY);
    if (typeof image !== "string" || !image.startsWith("data:image/")) return { kind: "none" };
    return { kind: "image", fit: record.fit === "fill" ? "fill" : record.fit === "tile" ? "tile" : "cover", blur: 0, dim: 0, image };
  }
  const resolved = parseJson(readKey(BACKDROP_LAYERS_KEY));
  if (kind === "scene") {
    return parseLookBackdrop({ kind: "scene", scene: parseJson(readKey(SCENE_KEY)), images: parseJson(readKey(SCENE_IMAGES_KEY)), resolved });
  }
  if (kind === "gradient" || kind === "custom-gradient") {
    return parseLookBackdrop({ ...record, resolved });
  }
  return { kind: "none" };
}

/* -------------------------------------------------------------- the reading */

export type LegacyAppearance = { composition: Composition; images: Record<string, string> };

/**
 * The old stores as a composition, or undefined when there is nothing old here
 * — a fresh install, a private window, or a second run after the migration
 * already removed the keys.
 *
 * THE TWO HALVES CAN COME FROM DIFFERENT PLACES, because the old selection was
 * a PAIR and a mixed one (Ember's day over Tide's night) was a supported thing
 * to be wearing. Each half is migrated on its own and then the two are put
 * together, which is the only reading that cannot lose one of them.
 */
export function migrateLegacyAppearance(): LegacyAppearance | undefined {
  const activeRaw = readKey(THEME_ACTIVE_KEY);
  const customRaw = readKey(THEME_CUSTOM_KEY);
  const backdropRaw = readKey(BACKDROP_KEY);
  if (activeRaw === null && customRaw === null && backdropRaw === null) return undefined;

  const active = parseActivePair(activeRaw);
  const custom = parseCustomThemes(customRaw);
  const backdrop = readLegacyBackdrop();

  // The layers, and only the layers, come from the backdrop — which the old
  // model shared between both halves, so both states get the same stack.
  const fromBackdrop = compositionFromV1({ light: TELAR_LIGHT, dark: TELAR_DARK }, backdrop);

  const halfFor = (mode: "light" | "dark") => {
    const builtIn = builtInComposition(active[mode]);
    if (builtIn) return { base: builtIn[mode].base, overrides: builtIn[mode].overrides };
    const found = custom.find((theme) => theme.id === active[mode]);
    if (!found) return { base: mode === "light" ? TELAR_LIGHT.background : TELAR_DARK.background, overrides: {} };
    // A palette nobody can regenerate: every token is pinned, and the base only
    // starts deciding anything once one of them is cleared.
    return { base: found[mode].background, overrides: { ...found[mode] } };
  };

  const composition: Composition = {
    light: { ...halfFor("light"), layers: fromBackdrop.composition.light.layers },
    dark: { ...halfFor("dark"), layers: fromBackdrop.composition.dark.layers },
  };
  return { composition, images: fromBackdrop.images };
}

/** Everything the old model owned, removed. Called after the composition it
 *  produced has actually been stored — a migration that cleared first and
 *  failed to write would lose the look it was rescuing. */
export function forgetLegacyAppearance(): void {
  for (const key of LEGACY_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Private browsing: there was nothing there to remove either.
    }
  }
}
