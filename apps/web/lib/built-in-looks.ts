/**
 * THE BUILT-IN LOOKS — the default settings for the composer.
 *
 * "Themes should not exist, there should be default settings for the composer,
 * and the composer can work for different things." So this file replaces two
 * that used to sit either side of a distinction the model no longer has: a
 * library of built-in THEMES (a palette, pickable on its own) and a shelf of
 * STARTER LOOKS (one of those themes plus a gradient and an accent). A palette
 * with nothing over it is simply a composition with no layers, so there is one
 * list now and every entry is the same kind of thing.
 *
 * FIVE FLAT AND FIVE SCENIC, and the flat five are the old built-in themes read
 * forward: a base colour per state instead of sixteen stored tokens, deriving
 * the same hue and the same tint strength through `halfFromBase`. The bases are
 * chosen so that derivation lands on the hue the old table named — they are
 * ordinary swatches, so the colour you see in the composer's base control is the
 * colour the app takes.
 *
 * THEY ARE NOT STORED. Built here from the same gradient presets the composer
 * offers, so they cost no quota, cannot be deleted into a state where the
 * gallery is bare, and stay in step with the presets they name. Wearing one
 * copies its composition into the live store; SAVING mints a card of your own,
 * which is the moment a default stops being a default.
 */

import {
  DEFAULT_BASE_DARK,
  DEFAULT_BASE_LIGHT,
  SCENE_LIMITS,
  type Accent,
  type Composition,
  type CompositionState,
  type Look,
  type SceneLayer,
} from "@telar/engine-client";
import { DEFAULT_APPEARANCE } from "./appearance";
import { backdropPresetById } from "./backdrop-presets";

export const BUILT_IN_PREFIX = "built-in-";

/**
 * One default: a base per state, optionally one gradient preset over both, and
 * the accent that agrees with them. Nothing else varies — a default is a
 * starting point, not a demonstration of every control.
 */
type Recipe = {
  id: string;
  label: string;
  /** What this look is, in the one line the gallery shows. */
  note: string;
  light: string;
  dark: string;
  preset?: string;
  accent: Accent;
};

/**
 * THE FLAT FIVE FIRST, IDENTITY AT THE HEAD. A gallery that opened on a
 * wallpaper would teach that a look is a wallpaper; the first row is Telar
 * itself, which is what the app looks like with nothing chosen at all.
 */
const RECIPES: readonly Recipe[] = [
  { id: "telar", label: "Telar", note: "The app's own colours", light: DEFAULT_BASE_LIGHT, dark: DEFAULT_BASE_DARK, accent: "indigo" },
  { id: "ember", label: "Ember", note: "Warm, flat", light: "#c88337", dark: "#b67649", accent: "amber" },
  { id: "grove", label: "Grove", note: "Green, flat", light: "#49b668", dark: "#49b677", accent: "moss" },
  { id: "tide", label: "Tide", note: "Cool blue, flat", light: "#4999b6", dark: "#24a1db", accent: "sky" },
  { id: "iris", label: "Iris", note: "Violet, flat", light: "#7749b6", dark: "#6f37c8", accent: "violet" },
  { id: "dusk", label: "Dusk", note: "Tide, under a dusk gradient", light: "#4999b6", dark: "#24a1db", preset: "dusk", accent: "violet" },
  { id: "deep-sea", label: "Deep Sea", note: "Tide, under deep water", light: "#4999b6", dark: "#24a1db", preset: "deep-sea", accent: "sea" },
  { id: "meadow", label: "Meadow", note: "Grove, under a meadow", light: "#49b668", dark: "#49b677", preset: "meadow", accent: "moss" },
  { id: "orchid", label: "Orchid", note: "Iris, under an orchid wash", light: "#7749b6", dark: "#6f37c8", preset: "orchid", accent: "plum" },
  { id: "emberglow", label: "Emberglow", note: "Ember, under a burning sky", light: "#c88337", dark: "#b67649", preset: "ember", accent: "amber" },
];

/** What a recipe's note says, so the gallery does not have to rebuild it. */
export const BUILT_IN_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
  RECIPES.map((recipe) => [`${BUILT_IN_PREFIX}${recipe.id}`, recipe.note]),
);

function build(recipe: Recipe): Look | undefined {
  // A recipe naming a preset this build dropped is skipped rather than shipped
  // with a layer that composes to nothing.
  if (recipe.preset !== undefined && !backdropPresetById(recipe.preset)) return undefined;
  const layers: SceneLayer[] = recipe.preset
    ? [{ type: "gradient", presetId: recipe.preset, opacity: SCENE_LIMITS.opacity.max }]
    : [];
  // BOTH STATES CARRY THE SAME STACK. A gradient preset already has a light and
  // a dark half of its own (the compiler takes the one the state needs), so
  // giving the two states different stacks here would be inventing a difference
  // the preset already expresses.
  const state = (base: string): CompositionState => ({ base, layers: layers.map((layer) => ({ ...layer })), overrides: {} });
  const composition: Composition = { light: state(recipe.light), dark: state(recipe.dark) };
  return {
    version: 2,
    id: `${BUILT_IN_PREFIX}${recipe.id}`,
    label: recipe.label,
    composition,
    images: {},
    accent: recipe.accent,
    fontSans: DEFAULT_APPEARANCE.fontSans,
    fontMono: DEFAULT_APPEARANCE.fontMono,
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: DEFAULT_APPEARANCE.fontSize,
    fontMonoSize: DEFAULT_APPEARANCE.fontMonoSize,
    translucencyLevel: DEFAULT_APPEARANCE.translucencyLevel,
    depth: DEFAULT_APPEARANCE.depth,
  };
}

/** Built once at module load — every input is a frozen table, so there is
 *  nothing to recompute and nothing that could differ between server and
 *  client. */
export const BUILT_IN_LOOKS: readonly Look[] = RECIPES.map(build).filter((look): look is Look => look !== undefined);

export function isBuiltInLook(look: Look): boolean {
  return look.id.startsWith(BUILT_IN_PREFIX);
}

/** The composition a built-in wears, by the id the OLD theme library used —
 *  the one thing the live migration needs from this table (see
 *  lib/legacy-appearance.ts). Undefined for a custom theme, which migrates
 *  through its own stored halves instead. */
export function builtInComposition(themeId: string): Composition | undefined {
  return BUILT_IN_LOOKS.find((look) => look.id === `${BUILT_IN_PREFIX}${themeId}`)?.composition;
}
