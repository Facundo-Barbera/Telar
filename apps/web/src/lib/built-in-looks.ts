/**
 * Default compositions built from the gradient starters. Not stored, so they cost no quota
 * and cannot be deleted; saving one mints a card of your own.
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
import { gradientStarterById } from "./gradient-starters";

export const BUILT_IN_PREFIX = "built-in-";

type Recipe = {
  id: string;
  label: string;
  /** What this look is, in the one line the gallery shows. */
  note: string;
  light: string;
  dark: string;
  /** A gradient starter's id, resolved to its two specs at build time. */
  starter?: string;
  accent: Accent;
};

/** Flat looks first, with Telar itself at the head. */
const RECIPES: readonly Recipe[] = [
  { id: "telar", label: "Telar", note: "The app's own colours", light: DEFAULT_BASE_LIGHT, dark: DEFAULT_BASE_DARK, accent: "indigo" },
  { id: "ember", label: "Ember", note: "Warm, flat", light: "#c88337", dark: "#b67649", accent: "amber" },
  { id: "grove", label: "Grove", note: "Green, flat", light: "#49b668", dark: "#49b677", accent: "moss" },
  { id: "tide", label: "Tide", note: "Cool blue, flat", light: "#4999b6", dark: "#24a1db", accent: "sky" },
  { id: "iris", label: "Iris", note: "Violet, flat", light: "#7749b6", dark: "#6f37c8", accent: "violet" },
  { id: "dusk", label: "Dusk", note: "Tide, under a dusk gradient", light: "#4999b6", dark: "#24a1db", starter: "dusk", accent: "violet" },
  { id: "deep-sea", label: "Deep Sea", note: "Tide, under deep water", light: "#4999b6", dark: "#24a1db", starter: "deep-sea", accent: "sea" },
  { id: "meadow", label: "Meadow", note: "Grove, under a meadow", light: "#49b668", dark: "#49b677", starter: "meadow", accent: "moss" },
  { id: "orchid", label: "Orchid", note: "Iris, under an orchid wash", light: "#7749b6", dark: "#6f37c8", starter: "orchid", accent: "plum" },
  { id: "emberglow", label: "Emberglow", note: "Ember, under a burning sky", light: "#c88337", dark: "#b67649", starter: "ember", accent: "amber" },
];

export const BUILT_IN_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
  RECIPES.map((recipe) => [`${BUILT_IN_PREFIX}${recipe.id}`, recipe.note]),
);

function build(recipe: Recipe): Look | undefined {
  // A recipe naming a starter this build dropped is skipped.
  const starter = recipe.starter === undefined ? undefined : gradientStarterById(recipe.starter);
  if (recipe.starter !== undefined && !starter) return undefined;
  // Each state carries its own stops, so the starter's per-mode spec is written in here.
  const state = (base: string, mode: "light" | "dark"): CompositionState => ({
    base,
    layers: starter ? [{ type: "gradient", spec: starter[mode], opacity: SCENE_LIMITS.opacity.max } satisfies SceneLayer] : [],
    overrides: {},
  });
  const composition: Composition = { light: state(recipe.light, "light"), dark: state(recipe.dark, "dark") };
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

export const BUILT_IN_LOOKS: readonly Look[] = RECIPES.map(build).filter((look): look is Look => look !== undefined);

export function isBuiltInLook(look: Look): boolean {
  return look.id.startsWith(BUILT_IN_PREFIX);
}
