// What goes under the page: which vibrancy material, and which colour.
//
// WHAT THIS IS ACTUALLY GUARDING is two bugs that share a file.
//
// #399: one material for both halves. "hud" tints toward black, so choosing it
// under a light canvas put the page on grey and translucent light read muddy no
// matter where the slider was. The regression is a one-word change away —
// anyone collapsing this back to a constant gets a failing test naming the half
// they broke.
//
// #243: translucency as a KIND OF WINDOW rather than a tint. When the two
// states asked for differently-built windows, the toggle had to rebuild the
// BrowserWindow and the cockpit flashed and lost its scroll position. The
// parity test below is the whole fix in one assertion: on and off differ in the
// material and the colour, and in NOTHING that needs a new window.
//
// THE LAST SECTION READS main.js, because the decision only counts if the
// window is actually built from it. `main.js` is not requirable — it calls
// `app.whenReady()` on its first lines and expects an Electron main process
// around it — so that half is held the way browser-host-window.test.js and
// external-links.test.js hold theirs: by reading the file. It lives here rather
// than in a file of its own so it runs: the desktop unit suite is an explicit
// list of test files in package.json, and an unlisted one is never run.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  DARK_MATERIAL,
  LIGHT_MATERIAL,
  OPAQUE_DARK,
  OPAQUE_LIGHT,
  TRANSLUCENT_BACKGROUND,
  backdropWindowOptions,
  vibrancyMaterial,
  vibrancyWindowOptions,
  windowBackgroundColor,
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
    // "sidebar" was the first pick and read near-solid beside dark (2026-09-13 nightly pass).
    expect(LIGHT_MATERIAL).not.toBe("sidebar");
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

describe("windowBackgroundColor", () => {
  test("the opaque colour is the SCHEME's canvas — a light cockpit is not painted dark", () => {
    expect(windowBackgroundColor({ translucent: false, dark: true })).toBe(OPAQUE_DARK);
    expect(windowBackgroundColor({ translucent: false, dark: false })).toBe(OPAQUE_LIGHT);
    expect(OPAQUE_DARK).not.toBe(OPAQUE_LIGHT);
  });

  test("the two colours are the cockpit's own --background tokens", () => {
    // apps/web/app/globals.css: oklch(0.145 0 0) and oklch(0.975 0.002 286),
    // converted to sRGB. Named rather than inferred, because the window wears
    // this colour before any renderer exists to be asked for it — and the
    // wrong one is a flash of the other scheme on every resize.
    expect(OPAQUE_DARK).toBe("#0a0a0a");
    expect(OPAQUE_LIGHT).toBe("#f6f6f8");
  });

  test("translucent is fully clear, in both schemes", () => {
    expect(TRANSLUCENT_BACKGROUND).toBe("#00000000");
    for (const dark of [true, false]) {
      expect(windowBackgroundColor({ translucent: true, dark })).toBe(TRANSLUCENT_BACKGROUND);
    }
  });

  test("an absent or half-built state is a colour, never undefined", () => {
    expect(windowBackgroundColor()).toBe(OPAQUE_LIGHT);
    expect(windowBackgroundColor({})).toBe(OPAQUE_LIGHT);
  });
});

describe("backdropWindowOptions", () => {
  /** Everything a window is built with that is NOT the tint. */
  const shape = ({ backgroundColor, vibrancy, visualEffectState, ...rest }) => rest;

  test("#243: on and off build the SAME window, apart from vibrancy and background", () => {
    for (const dark of [true, false]) {
      const on = backdropWindowOptions({ translucent: true, frost: "blur", dark, supported: true });
      const off = backdropWindowOptions({ translucent: false, frost: "blur", dark, supported: true });
      // The assertion that keeps the toggle live: if anything else ever differs
      // between the two states, that difference can only be applied by building
      // a new window — which is the bug.
      expect(shape(on)).toEqual(shape(off));
      // And the tint is what actually moves, or the parity above is vacuous.
      expect(on.vibrancy).toBe(dark ? DARK_MATERIAL : LIGHT_MATERIAL);
      expect(off.vibrancy).toBeUndefined();
      expect(on.backgroundColor).toBe(TRANSLUCENT_BACKGROUND);
      expect(off.backgroundColor).toBe(dark ? OPAQUE_DARK : OPAQUE_LIGHT);
    }
  });

  test('"clear" frost differs from "blur" by the material alone, and rebuilds nothing either', () => {
    const blur = backdropWindowOptions({ translucent: true, frost: "blur", dark: true, supported: true });
    const clear = backdropWindowOptions({ translucent: true, frost: "clear", dark: true, supported: true });
    expect(shape(blur)).toEqual(shape(clear));
    expect(clear.vibrancy).toBeUndefined();
    expect(clear.backgroundColor).toBe(TRANSLUCENT_BACKGROUND);
  });

  test("every window is born non-opaque, whichever way the preference sits", () => {
    for (const translucent of [true, false]) {
      const options = backdropWindowOptions({ translucent, frost: "blur", dark: true, supported: true });
      // The one flag that cannot be changed after construction.
      expect(options.transparent).toBe(true);
      // Off for BOTH, because a flag that differed would be a rebuild again.
      // macOS draws no native shadow on a non-opaque window anyway, and
      // recomputing one from its alpha is what blinked on every alt-tab back.
      expect(options.hasShadow).toBe(false);
    }
  });

  test("`roundedCorners` is left at Electron's default — never set here", () => {
    // The window keeps its frame (titleBarStyle: hiddenInset) so macOS masks
    // the corners itself, and `false` would square them AND make the window
    // unfullscreenable. An explicit value here is a regression, either way.
    expect(backdropWindowOptions({ translucent: true, dark: true, supported: true })).not.toHaveProperty("roundedCorners");
  });

  test("an unsupported platform gets an ordinary opaque window", () => {
    // Vibrancy is NSVisualEffectView, and a transparent window costs real
    // things elsewhere for a feature that platform cannot show.
    const options = backdropWindowOptions({ translucent: true, frost: "blur", dark: true });
    expect(options).toEqual({ backgroundColor: OPAQUE_DARK });
  });

  test("a preference carried over from a Mac cannot leave another platform with no ground", () => {
    // `translucent: true` with no vibrancy and no `transparent` would be an
    // opaque window told to paint nothing.
    expect(backdropWindowOptions({ translucent: true, dark: false, supported: false })).toEqual({
      backgroundColor: OPAQUE_LIGHT,
    });
  });
});

// --- And the window main.js actually builds ------------------------------------

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

/** `createWindow`'s options object, as source. */
const creation = main.slice(main.indexOf("function createWindow(url) {"), main.indexOf("browserManagers.add(manager);"));

/** The live retint, as source. */
const toggle = main.slice(main.indexOf("function applyTranslucency(on, frost) {"), main.indexOf("function reapplyVibrancy() {"));

describe("the window is born translucent-capable", () => {
  test("this test is reading the two functions", () => {
    expect(creation).toContain("new BrowserWindow({");
    expect(toggle).toContain("win.setVibrancy(material);");
  });

  test("the backdrop is the one decision, spread from window-material.js", () => {
    expect(creation).toContain("...backdropWindowOptions({");
    // The three inputs: the stored preference, the resolved scheme, the
    // platform. A missing `supported` would mark a Linux window transparent.
    expect(creation).toContain("...readUiPrefs()");
    expect(creation).toContain("dark: nativeTheme.shouldUseDarkColors");
    expect(creation).toContain("supported: supportsTranslucency()");
  });

  test("NO creation option branches on the preference — that branch was the bug", () => {
    // The ternaries that used to be here (`translucent ? { transparent: true,
    // hasShadow: false } : {}` and the background colour) are exactly what made
    // the two states different KINDS of window.
    expect(creation).not.toMatch(/\btranslucent\s*\?/);
    expect(creation).not.toContain("transparent: true");
    expect(creation).not.toContain("hasShadow");
    expect(creation).not.toContain("backgroundColor:");
  });

  test("the renderer half of the anti-flicker pair is unconditional too", () => {
    // A window that is non-opaque the whole time needs the unthrottled renderer
    // the whole time, not from the next launch after somebody flips the toggle.
    expect(creation).toContain("backgroundThrottling: false,");
    expect(creation).not.toMatch(/backgroundThrottling[^,\n]*\?/);
  });

  test("and so is the occlusion switch, which can only be appended before ready", () => {
    const gpu = main.indexOf("TRANSLUCENCY STAYS ON THE GPU");
    const startup = main.slice(gpu, main.indexOf("if (SMOKE) {", gpu));
    expect(startup).toContain('app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");');
    expect(startup).toContain("if (supportsTranslucency()) {");
    expect(startup).not.toContain("readUiPrefs().translucent");
  });
});

describe("the toggle only retints", () => {
  test("no rebuild path survives, by name or by capability flag", () => {
    expect(main).not.toContain("recreateWindowTranslucent");
    // The flag existed only to record which windows were born able to blend
    // alpha. Every window is, so anything reading it is asking a dead question.
    expect(main).not.toContain("telarTranslucentCapable");
  });

  test("the retint builds no window and destroys none", () => {
    expect(toggle).not.toMatch(/createWindow\(/);
    expect(toggle).not.toMatch(/\.destroy\(\)/);
    // Both setters, on every live window: the material AND the colour.
    expect(toggle).toContain("win.setVibrancy(material);");
    expect(toggle).toContain("win.setBackgroundColor(backgroundColor);");
    expect(toggle).toContain("if (win.isDestroyed()) continue;");
  });

  test("the opaque colour comes from window-material.js, not from a hex in here", () => {
    // A second copy of the colour is how the light scheme ended up wearing the
    // dark one: the constant moved in one place and not the other.
    expect(toggle).toContain("windowBackgroundColor({ translucent: on, dark })");
    // No literal anywhere that paints a window — in this function or the one
    // that builds it. (Prose about the old bug is free to name the hex.)
    expect(toggle).not.toMatch(/setBackgroundColor\(\s*"/);
    expect(creation).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test("a scheme change is the SAME retint, so the opaque colour follows it", () => {
    const scheme = main.slice(main.indexOf("function reapplyVibrancy() {"), main.indexOf("function watchSchemeForVibrancy() {"));
    expect(scheme).toContain("applyTranslucency(translucent, frost)");
    // Not a vibrancy-only pass: off, the window wears the scheme's canvas, and
    // an evening switch that left the other hex on would flash it at the next
    // resize.
    expect(scheme).not.toContain("setVibrancy");
  });
});

describe("what the rebuild path left behind", () => {
  test("lastWindowUrl stays, because two live callers still need it", () => {
    // It was introduced for the rebuild, but it is not the rebuild's: deleting
    // it with the recreate path would have taken the cookie re-seat after a
    // network-service death, and `telar:app:open-window` from a renderer whose
    // webContents has already gone, with it.
    expect(main).toContain("if (lastWindowUrl) void seatHostCookie(lastWindowUrl);");
    expect(main).toContain("windowTargetUrl(asking.webContents.getURL() || lastWindowUrl, input?.path)");
  });
});
