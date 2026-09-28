// Must stay in step with the `[data-accent=x]` and `.dark[data-accent=x]` rules
// in app/globals.css; the stylesheet cannot be read for a scheme it is not wearing.

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

export function accentPrimary(accent: Accent, mode: "light" | "dark"): string {
  const colours = ACCENT_COLOURS[accent];
  return mode === "dark" ? colours.dark.primary : colours.light;
}
