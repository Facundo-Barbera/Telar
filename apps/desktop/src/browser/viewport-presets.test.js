"use strict";

// The shared viewport table, from the shell's side. The web's test pins the
// same table from the cockpit's side (apps/web/src/features/browser/viewport.test.ts).

const { describe, expect, test } = require("bun:test");
const {
  VIEWPORT_PRESETS,
  VIEWPORT_PRESET_GROUPS,
  VIEWPORT_PRESET_KEYS,
  viewportPreset,
  presetOf,
  orientationOf,
  orient,
} = require("./viewport-presets");

describe("the viewport preset table", () => {
  test("every entry sits in a known group, and keys and sizes are unique", () => {
    const groups = new Set(VIEWPORT_PRESET_GROUPS.map((group) => group.key));
    for (const preset of VIEWPORT_PRESETS) expect(groups.has(preset.group)).toBe(true);
    expect(new Set(VIEWPORT_PRESETS.map((preset) => preset.key)).size).toBe(VIEWPORT_PRESETS.length);
    // One row per size, or `presetOf` would pick between two by array order.
    expect(new Set(VIEWPORT_PRESETS.map((preset) => `${preset.width}x${preset.height}`)).size).toBe(VIEWPORT_PRESETS.length);
    for (const preset of VIEWPORT_PRESETS) expect(preset.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("the older names still resolve to their sizes", () => {
    expect(viewportPreset("default")).toMatchObject({ width: 1280, height: 800 });
    expect(viewportPreset("laptop")).toMatchObject({ width: 1440, height: 900 });
    expect(viewportPreset("tablet")).toMatchObject({ key: "ipad-mini", width: 768, height: 1024 });
    expect(viewportPreset("phone")).toMatchObject({ key: "iphone-12-pro", width: 390, height: 844 });
    expect(viewportPreset("galaxy-s20-ultra")).toMatchObject({ key: "pixel-7" });
    expect(viewportPreset("watch")).toBeUndefined();
    expect(viewportPreset("toString")).toBeUndefined();
    expect(VIEWPORT_PRESET_KEYS).toContain("phone");
    expect(VIEWPORT_PRESET_KEYS).toContain("surface-duo");
  });

  test("presetOf names the entry, never an alias, and a rotated size is custom", () => {
    expect(presetOf({ width: 390, height: 844 })).toBe("iphone-12-pro");
    expect(presetOf({ width: 412, height: 915 })).toBe("pixel-7");
    expect(presetOf({ width: 844, height: 390 })).toBeNull();
    expect(presetOf(null)).toBeNull();
  });

  test("orient swaps the two numbers only when the size faces the other way", () => {
    expect(orientationOf({ width: 390, height: 844 })).toBe("portrait");
    expect(orientationOf({ width: 500, height: 500 })).toBe("portrait");
    expect(orient({ width: 390, height: 844 }, "landscape")).toEqual({ width: 844, height: 390 });
    expect(orient({ width: 390, height: 844 }, "portrait")).toEqual({ width: 390, height: 844 });
    expect(orient({ width: 1280, height: 800 }, "portrait")).toEqual({ width: 800, height: 1280 });
    expect(() => orient({ width: 1, height: 2 }, "sideways")).toThrow(/Unknown orientation/);
  });
});
