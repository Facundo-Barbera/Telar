
import { MAX_GRADIENT_STOPS, type CustomGradientSpec } from "@telar/engine-client";

export {
  composeGradient,
  DEFAULT_GRADIENT_SPECS,
  GRADIENT_LIMITS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  parseGradientCss,
  type CustomGradientSpec,
  type GradientStop,
  type GradientType,
} from "@telar/engine-client";

export type GradientStarter = {
  id: string;
  label: string;
  light: CustomGradientSpec;
  dark: CustomGradientSpec;
};

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
