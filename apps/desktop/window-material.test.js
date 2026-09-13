// Which vibrancy material goes under the page, per scheme.
//
// WHAT THIS IS ACTUALLY GUARDING is issue #399's bug: one material for both
// halves. "hud" tints toward black, so choosing it under a light canvas put the
// page on grey and translucent light read muddy no matter where the slider was.
// The regression is a one-word change away — anyone collapsing this back to a
// constant gets a failing test naming the half they broke.

const { describe, expect, test } = require("bun:test");
const {
  DARK_MATERIAL,
  LIGHT_MATERIAL,
  vibrancyMaterial,
  vibrancyWindowOptions,
} = require("./window-material.js");

describe("vibrancyMaterial", () => {
  test("the scheme picks the material — the two halves do NOT share one", () => {
    expect(vibrancyMaterial({ translucent: true, frost: "blur", dark: true })).toBe(DARK_MATERIAL);
    expect(vibrancyMaterial({ translucent: true, frost: "blur", dark: false })).toBe(LIGHT_MATERIAL);
    expect(DARK_MATERIAL).not.toBe(LIGHT_MATERIAL);
  });

  test("the dark material is the clearest one, and the light one is not it", () => {
    // Named rather than inferred: "hud" is a DARK material, which is the whole
    // of #399. If it ever becomes the light answer again this fails.
    expect(DARK_MATERIAL).toBe("hud");
    expect(LIGHT_MATERIAL).not.toBe("hud");
  });

  test("no vibrancy layer at all when translucency is off", () => {
    for (const dark of [true, false]) {
      expect(vibrancyMaterial({ translucent: false, frost: "blur", dark })).toBeNull();
    }
  });

  test('"clear" frost drops the layer in both halves — a crisp desktop, the page\'s own wash only', () => {
    expect(vibrancyMaterial({ translucent: true, frost: "clear", dark: true })).toBeNull();
    expect(vibrancyMaterial({ translucent: true, frost: "clear", dark: false })).toBeNull();
  });

  test("an absent or half-built state is the safe answer, never a crash", () => {
    // `readUiPrefs` can only ever hand over the two keys, but the scheme comes
    // from Electron and a smoke run has no window at all.
    expect(vibrancyMaterial()).toBeNull();
    expect(vibrancyMaterial({})).toBeNull();
    // A missing `dark` is LIGHT rather than dark: the muddy half is the one
    // worth defaulting away from.
    expect(vibrancyMaterial({ translucent: true, frost: "blur" })).toBe(LIGHT_MATERIAL);
  });
});

describe("vibrancyWindowOptions", () => {
  test("spreadable options that never hand Electron a null material", () => {
    expect(vibrancyWindowOptions({ translucent: true, frost: "blur", dark: true })).toEqual({
      vibrancy: DARK_MATERIAL,
      visualEffectState: "active",
    });
    expect(vibrancyWindowOptions({ translucent: true, frost: "blur", dark: false })).toEqual({
      vibrancy: LIGHT_MATERIAL,
      visualEffectState: "active",
    });
  });

  test("nothing to spread when there is no material", () => {
    expect(vibrancyWindowOptions({ translucent: false })).toEqual({});
    expect(vibrancyWindowOptions({ translucent: true, frost: "clear" })).toEqual({});
  });

  test('"active", never "followWindow" — glass that changes with focus reads as a bug', () => {
    expect(vibrancyWindowOptions({ translucent: true, frost: "blur", dark: true }).visualEffectState).toBe("active");
  });
});
