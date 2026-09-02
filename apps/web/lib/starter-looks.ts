/**
 * STARTER LOOKS — the shelf is never empty.
 *
 * A theme editor that opens on "Nothing saved yet" has told the reader nothing
 * about what a look IS. These six say it in one glance: a palette, a scene and
 * an accent, chosen together, so the first act available is TRY ONE rather than
 * "read the paragraph explaining what a Look would be if you had one".
 *
 * THEY ARE NOT STORED. Built here from the same built-in themes and gradient
 * presets the rest of the pane offers, so they cost no quota, cannot be deleted
 * into a state where the shelf is bare again, and stay in step with the presets
 * they name. Opening one MINTS A NEW ID (see looks-section) — a starter is
 * somewhere to begin, so saving it shelves a card of your own rather than
 * pretending to update a card that was never yours.
 */

import { DEFAULT_APPEARANCE, type Accent } from "./appearance";
import type { Look, LookBackdrop } from "./looks";
import { presetBackdrop } from "./studio-draft";
import { BUILT_IN_THEMES, concreteHalf } from "./theme-palettes";

export const STARTER_PREFIX = "starter-";

/** A starter is one built-in theme, one gradient preset and one accent, picked
 *  to agree with each other. Nothing else varies — the point is the pairing. */
type Recipe = { id: string; label: string; theme: string; preset?: string; accent: Accent };

const RECIPES: readonly Recipe[] = [
  { id: "dusk", label: "Dusk", theme: "tide", preset: "dusk", accent: "violet" },
  { id: "ember", label: "Ember", theme: "ember", preset: "ember", accent: "amber" },
  { id: "deep-sea", label: "Deep Sea", theme: "tide", preset: "deep-sea", accent: "sea" },
  { id: "meadow", label: "Meadow", theme: "grove", preset: "meadow", accent: "moss" },
  { id: "orchid", label: "Orchid", theme: "iris", preset: "orchid", accent: "plum" },
  // The flat one on purpose: proof that a look need not carry a wallpaper.
  { id: "paper", label: "Paper", theme: "telar", accent: "indigo" },
];

function build(recipe: Recipe): Look | undefined {
  const theme = BUILT_IN_THEMES.find((entry) => entry.id === recipe.theme);
  if (!theme) return undefined;
  const backdrop: LookBackdrop | undefined = recipe.preset ? presetBackdrop(recipe.preset) : { kind: "none" };
  if (!backdrop) return undefined;
  return {
    version: 1,
    id: `${STARTER_PREFIX}${recipe.id}`,
    label: recipe.label,
    theme: { light: concreteHalf(theme, "light"), dark: concreteHalf(theme, "dark") },
    backdrop,
    accent: recipe.accent,
    fontSans: DEFAULT_APPEARANCE.fontSans,
    fontMono: DEFAULT_APPEARANCE.fontMono,
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: DEFAULT_APPEARANCE.fontSize,
    translucencyLevel: DEFAULT_APPEARANCE.translucencyLevel,
  };
}

/** Built once at module load — every input is a frozen table, so there is
 *  nothing to recompute and nothing that could differ between server and
 *  client. A recipe naming a preset this build dropped is skipped, not thrown. */
export const STARTER_LOOKS: readonly Look[] = RECIPES.map(build).filter((look): look is Look => look !== undefined);

export function isStarterLook(look: Look): boolean {
  return look.id.startsWith(STARTER_PREFIX);
}
