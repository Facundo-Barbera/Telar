/**
 * THE ACCENT HUES, RESOLVED — the one restatement of app/globals.css's
 * `[data-accent="…"]` blocks.
 *
 * They cannot be READ from the stylesheet: `getComputedStyle` would only ever
 * report the accent this window is wearing and the scheme it is wearing it in,
 * which is not enough for either reader below. And they cannot be REFERENCED: a
 * client that never loaded globals.css has no `--primary` to look up. So they
 * are copied, once, here.
 *
 * TWO READERS NOW, WHICH IS WHY THIS IS A MODULE (#471). The appearance
 * publisher names both schemes of the chosen accent for a paired window; the
 * composer's colour chips offer the accent as a stop colour, in the state being
 * edited. Beside the publisher was the right place while it was the only
 * consumer, and a second copy in the composer would be the kind of second
 * opinion that goes stale the next time an accent is retuned.
 *
 * KEEP IN STEP WITH globals.css §ACCENTS. The `light` half is that file's
 * `[data-accent=x]` rule and the `dark` half its `.dark[data-accent=x]` rule.
 * Light needs no `--primary-foreground` of its own (the base token is already
 * correct against every accent at L 0.488), so light's foreground is the base
 * palette's value, restated once below.
 */

import type { Accent } from "./appearance";

export const LIGHT_PRIMARY_FOREGROUND = "oklch(1 0 0)";

export const ACCENT_COLOURS: Record<Accent, { light: string; dark: { primary: string; primaryForeground: string } }> = {
  indigo: { light: "oklch(0.488 0.16 264)", dark: { primary: "oklch(0.68 0.16 264)", primaryForeground: "oklch(0.17 0.04 264)" } },
  sky: { light: "oklch(0.488 0.15 240)", dark: { primary: "oklch(0.68 0.15 240)", primaryForeground: "oklch(0.17 0.04 240)" } },
  sea: { light: "oklch(0.488 0.1 205)", dark: { primary: "oklch(0.68 0.11 205)", primaryForeground: "oklch(0.17 0.04 205)" } },
  moss: { light: "oklch(0.488 0.11 140)", dark: { primary: "oklch(0.68 0.13 140)", primaryForeground: "oklch(0.17 0.04 140)" } },
  amber: { light: "oklch(0.488 0.12 70)", dark: { primary: "oklch(0.68 0.14 70)", primaryForeground: "oklch(0.17 0.04 70)" } },
  rose: { light: "oklch(0.488 0.17 15)", dark: { primary: "oklch(0.68 0.17 15)", primaryForeground: "oklch(0.17 0.04 15)" } },
  plum: { light: "oklch(0.488 0.16 325)", dark: { primary: "oklch(0.68 0.15 325)", primaryForeground: "oklch(0.17 0.04 325)" } },
  violet: { light: "oklch(0.488 0.17 293)", dark: { primary: "oklch(0.68 0.16 293)", primaryForeground: "oklch(0.17 0.04 293)" } },
};

/** What `--primary` actually is in one colour scheme — the accent as a COLOUR,
 *  for the places that offer it as one rather than publishing the pair. */
export function accentPrimary(accent: Accent, mode: "light" | "dark"): string {
  const colours = ACCENT_COLOURS[accent];
  return mode === "dark" ? colours.dark.primary : colours.light;
}
