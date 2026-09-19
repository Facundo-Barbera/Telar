/**
 * GRADIENT STARTERS — somewhere to begin, not somewhere to stay (#471).
 *
 * WHAT THIS FILE USED TO BE. Eleven authored mesh compositions, each a flat
 * linear wash under three soft radial blobs, stored as finished CSS strings and
 * referenced by ID. A gradient layer named one of them and that was the whole
 * vocabulary: you could have any gradient you liked as long as it was one of
 * these eleven. "It needs gradient customization. We give a lot of options;
 * what if instead we let the user create them."
 *
 * SO THE TABLE IS SPECS NOW, and a starter is a CHIP THAT FILLS THE EDITOR
 * rather than a kind a layer is locked into. Picking one writes its stops into
 * the layer; the next thing you do is move them. Nothing downstream resolves an
 * id at paint time any more — `composeState` composes from the layer's own spec
 * — so this table is consulted in exactly two places: the chips, and reading an
 * older layer forward (`SCENE_PRESETS` in lib/scene-composer.ts).
 *
 * WHAT THE COLOURS ARE. Each starter's stops are the SAME COLOURS its mesh was
 * built from — the wash's two ends with the three blobs between them, converted
 * out of oklch into the hex a colour input can show — laid along one ramp at the
 * mesh's own angle. So a stored look that named `dusk` still opens in Dusk's
 * palette; what it loses is the mesh's softness, which is the price of a
 * gradient a person can actually take apart.
 *
 * THE CHROMA CEILING SURVIVES, and it is still the whole design constraint: the
 * app's canvas frosts over these at 30-70% opacity, and a gradient with
 * saturated midtones turns body text into a legibility problem. Light halves
 * sit near white with a tint; dark halves near black with one.
 */

import { MAX_GRADIENT_STOPS, type CustomGradientSpec } from "@telar/engine-client";

/**
 * The spec vocabulary is the FORMAT's, not this app's — a gradient layer
 * carries one, so any client reading a published Look needs the same parser and
 * the same composer. Re-exported here so the editor and the starters are one
 * import, the way scene-composer.ts re-exports the moved scene model.
 */
export {
  composeGradient,
  DEFAULT_GRADIENT_SPECS,
  GRADIENT_LIMITS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  parseGradientCss,
  parseGradientSpec,
  type CustomGradientSpec,
  type GradientStop,
  type GradientType,
} from "@telar/engine-client";

export type GradientStarter = {
  id: string;
  label: string;
  /** What the chip fills the editor with, in each colour state. A starter has
   *  two halves because the mesh it came from did: a wash tuned for daylight is
   *  not the one that reads at night. */
  light: CustomGradientSpec;
  dark: CustomGradientSpec;
};

/** Five colours along one ramp, evenly spaced and fully opaque — the shape
 *  every starter has, so the table below is colours and an angle and nothing
 *  else. Per-stop positions and alphas are what EDITING adds. */
function ramp(angle: number, colors: readonly string[]): CustomGradientSpec {
  const last = colors.length - 1;
  return {
    type: "linear",
    angle,
    centerX: 50,
    centerY: 50,
    stops: colors.slice(0, MAX_GRADIENT_STOPS).map((color, index) => ({ color, position: Math.round((index / last) * 100), opacity: 100 })),
  };
}

export const GRADIENT_STARTERS: readonly GradientStarter[] = [
  {
    id: "aurora",
    label: "Aurora",
    light: ramp(165, ["#f0fbfe", "#bdf7dc", "#cae7ff", "#f0e4ff", "#e5efff"]),
    dark: ramp(165, ["#0d151c", "#005c41", "#183d6b", "#3f2d5b", "#070b14"]),
  },
  {
    id: "dusk",
    label: "Dusk",
    light: ramp(180, ["#f3f4ff", "#e7d9ff", "#ffe4f2", "#ffdad0", "#ffe4e3"]),
    dark: ramp(180, ["#0e0e1a", "#3c2a58", "#442032", "#663028", "#100606"]),
  },
  {
    id: "deep-sea",
    label: "Deep Sea",
    light: ramp(175, ["#eaf8fb", "#b7f0fb", "#c3f3ef", "#d7f3ff", "#d4edf7"]),
    dark: ramp(175, ["#010d13", "#004151", "#003b38", "#002b49", "#01050a"]),
  },
  {
    id: "nebula",
    label: "Nebula",
    light: ramp(150, ["#f7f2ff", "#fad6ff", "#d1e5ff", "#ffdbed", "#e3ebff"]),
    dark: ramp(150, ["#0f0a18", "#512b5a", "#1c3060", "#441b30", "#04050f"]),
  },
  {
    id: "sunrise",
    label: "Sunrise",
    light: ramp(0, ["#fff1e1", "#ffe7bc", "#ffdcd7", "#ede1ff", "#ebedff"]),
    dark: ramp(0, ["#211208", "#72480b", "#5a2522", "#33244b", "#07060f"]),
  },
  {
    id: "meadow",
    label: "Meadow",
    light: ramp(200, ["#eefbff", "#d0f4c8", "#edefc1", "#d4f4ff", "#e6f3df"]),
    dark: ramp(200, ["#030d11", "#294c22", "#3a3b05", "#003346", "#030902"]),
  },
  {
    id: "glacier",
    label: "Glacier",
    light: ramp(155, ["#f6fdff", "#d5f9ff", "#d5f6f6", "#e6f3ff", "#e3f6f9"]),
    dark: ramp(155, ["#0a1316", "#1a434f", "#0c3d3d", "#202e44", "#030b0d"]),
  },
  {
    id: "sandstone",
    label: "Sandstone",
    light: ramp(170, ["#fff7ee", "#ffe4ca", "#ffddd2", "#f8eed5", "#fee5db"]),
    dark: ramp(170, ["#150e06", "#583b23", "#522c22", "#392f14", "#0e0503"]),
  },
  {
    id: "orchid",
    label: "Orchid",
    light: ramp(145, ["#fdf5ff", "#ffd9f5", "#e4e4ff", "#ffe3e2", "#f1eaff"]),
    dark: ramp(145, ["#130913", "#582b4a", "#302c57", "#451e1f", "#08060e"]),
  },
  {
    id: "ember",
    label: "Ember",
    light: ramp(0, ["#ffe7df", "#ffd9c5", "#ffdddf", "#ffe8e3", "#fef7f2"]),
    dark: ramp(0, ["#1f0f0a", "#753a24", "#5f252c", "#391a15", "#080302"]),
  },
  {
    id: "moonlit",
    label: "Moonlit",
    light: ramp(190, ["#f5f9ff", "#e3f4ff", "#e4eaff", "#def2fc", "#e2ecf9"]),
    dark: ramp(190, ["#06090f", "#263a4e", "#222741", "#092531", "#020306"]),
  },
] as const;

export function gradientStarterById(id: string): GradientStarter | undefined {
  return GRADIENT_STARTERS.find((starter) => starter.id === id);
}
