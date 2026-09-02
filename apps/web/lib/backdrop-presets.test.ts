// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isGradientValue } from "./backdrop";
import {
  BACKDROP_PRESETS,
  backdropPresetById,
  composeGradient,
  DEFAULT_CUSTOM_GRADIENT,
  MAX_GRADIENT_STOPS,
  parseGradient,
  type CustomGradientSpec,
} from "./backdrop-presets";

describe("BACKDROP_PRESETS", () => {
  // The store's gate is SILENT: a value that fails isGradientValue is dropped
  // rather than rejected, so a typo in a preset would ship as "clicking this
  // one does nothing". This is the test that makes it loud.
  test.each(BACKDROP_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s passes the store's gate on both halves",
    (_id: string, preset: (typeof BACKDROP_PRESETS)[number]) => {
      expect(isGradientValue(preset.light)).toBe(true);
      expect(isGradientValue(preset.dark)).toBe(true);
    },
  );

  test("ids are unique and labels are present", () => {
    const ids = BACKDROP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of BACKDROP_PRESETS) {
      expect(preset.id).toMatch(/^[a-z][a-z-]*$/);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  test("every scene is a layered mesh, not one flat wash", () => {
    for (const preset of BACKDROP_PRESETS) {
      for (const half of [preset.light, preset.dark]) {
        expect(half.split("gradient(").length - 1).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("backdropPresetById finds them and misses cleanly", () => {
    expect(backdropPresetById("aurora")?.label).toBe("Aurora");
    expect(backdropPresetById("no-such-scene")).toBeUndefined();
  });
});

describe("composeGradient", () => {
  test("emits evenly spaced explicit stops", () => {
    expect(composeGradient({ type: "linear", angle: 90, stops: ["#000000", "#ffffff"] })).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)",
    );
    expect(composeGradient({ type: "linear", angle: 0, stops: ["#000000", "#888888", "#ffffff"] })).toBe(
      "linear-gradient(0deg, #000000 0%, #888888 50%, #ffffff 100%)",
    );
  });

  test("radial ignores the angle and pins the centre", () => {
    expect(composeGradient({ type: "radial", angle: 45, stops: ["#112233", "#445566"] })).toBe(
      "radial-gradient(circle at 50% 50%, #112233 0%, #445566 100%)",
    );
  });

  test("angles wrap rather than clamp", () => {
    expect(composeGradient({ type: "linear", angle: 370, stops: ["#000000", "#ffffff"] })).toContain("10deg");
    expect(composeGradient({ type: "linear", angle: -30, stops: ["#000000", "#ffffff"] })).toContain("330deg");
  });

  test("what it composes always passes the store's gate", () => {
    for (const spec of [
      DEFAULT_CUSTOM_GRADIENT.light,
      DEFAULT_CUSTOM_GRADIENT.dark,
      { type: "radial", angle: 0, stops: ["#ff0000", "#00ff00", "#0000ff", "#ffffff"] } as CustomGradientSpec,
    ]) {
      expect(isGradientValue(composeGradient(spec))).toBe(true);
    }
  });
});

describe("parseGradient round-trips composeGradient", () => {
  const specs: CustomGradientSpec[] = [
    { type: "linear", angle: 160, stops: ["#eef2ff", "#fce7f3"] },
    { type: "linear", angle: 0, stops: ["#123456", "#abcdef", "#000000"] },
    { type: "linear", angle: 359, stops: ["#111111", "#222222", "#333333", "#444444"] },
    { type: "radial", angle: DEFAULT_CUSTOM_GRADIENT.light.angle, stops: ["#ffffff", "#0f0f0f"] },
    DEFAULT_CUSTOM_GRADIENT.light,
    DEFAULT_CUSTOM_GRADIENT.dark,
  ];

  test.each(specs.map((spec) => [composeGradient(spec), spec] as const))("%s", (css: string, spec: CustomGradientSpec) => {
    expect(parseGradient(css)).toEqual(spec);
  });

  test("the composed CSS survives a second lap unchanged", () => {
    for (const spec of specs) {
      const once = composeGradient(spec);
      const parsed = parseGradient(once);
      expect(parsed).not.toBeNull();
      expect(composeGradient(parsed as CustomGradientSpec)).toBe(once);
    }
  });

  test("more stops than the editor allows are dropped, not smuggled", () => {
    const css = composeGradient({ type: "linear", angle: 90, stops: ["#000000", "#111111", "#222222", "#333333", "#444444"] });
    expect(parseGradient(css)?.stops.length).toBe(MAX_GRADIENT_STOPS);
  });
});

describe("parseGradient refuses what it did not write", () => {
  // The editor opens on its default rather than on a half-understood parse,
  // so every one of these must be null and none may throw.
  test.each([
    ["a preset", BACKDROP_PRESETS[0].light],
    ["a bare colour", "#ff0000"],
    ["stops without positions", "linear-gradient(90deg, #000000, #ffffff)"],
    ["an off-centre radial", "radial-gradient(circle at 20% 30%, #000000 0%, #ffffff 100%)"],
    ["a conic gradient", "conic-gradient(from 0deg, #000000 0%, #ffffff 100%)"],
    ["a single stop", "linear-gradient(90deg, #000000 0%)"],
    ["a comma-bearing colour function", "linear-gradient(90deg, rgb(0, 0, 0) 0%, #ffffff 100%)"],
    ["empty", ""],
    ["a trailing declaration", "linear-gradient(90deg, #000000 0%, #ffffff 100%); color: red"],
  ])("%s", (_label: string, value: string) => {
    expect(parseGradient(value)).toBeNull();
  });

  test("surrounding whitespace is forgiven", () => {
    expect(parseGradient("  linear-gradient(90deg, #000000 0%, #ffffff 100%)  ")).toEqual({
      type: "linear",
      angle: 90,
      stops: ["#000000", "#ffffff"],
    });
  });
});
