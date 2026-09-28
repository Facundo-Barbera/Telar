const { describe, expect, test } = require("bun:test");
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
    expect(DARK_MATERIAL).toBe("hud");
    expect(LIGHT_MATERIAL).not.toBe("hud");

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
    expect(vibrancyMaterial()).toBeNull();
    expect(vibrancyMaterial({})).toBeNull();

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
  const shape = ({ backgroundColor: _b, vibrancy: _v, visualEffectState: _s, ...rest }) => rest;

  test("#243: on and off build the SAME window, apart from vibrancy and background", () => {
    for (const dark of [true, false]) {
      const on = backdropWindowOptions({ translucent: true, frost: "blur", dark, supported: true });
      const off = backdropWindowOptions({ translucent: false, frost: "blur", dark, supported: true });

      expect(shape(on)).toEqual(shape(off));

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

      expect(options.transparent).toBe(true);

      expect(options.hasShadow).toBe(false);
    }
  });

  test("`roundedCorners` is left at Electron's default — never set here", () => {
    expect(backdropWindowOptions({ translucent: true, dark: true, supported: true })).not.toHaveProperty("roundedCorners");
  });

  test("an unsupported platform gets an ordinary opaque window", () => {
    const options = backdropWindowOptions({ translucent: true, frost: "blur", dark: true });
    expect(options).toEqual({ backgroundColor: OPAQUE_DARK });
  });

  test("a preference carried over from a Mac cannot leave another platform with no ground", () => {
    expect(backdropWindowOptions({ translucent: true, dark: false, supported: false })).toEqual({
      backgroundColor: OPAQUE_LIGHT,
    });
  });
});

const main = require("../../test/main-source").mainSource();

const creation = main.slice(main.indexOf("function createWindow(url) {"), main.indexOf("browserManagers.add(manager);"));

const toggle = main.slice(main.indexOf("function applyTranslucency(on, frost) {"), main.indexOf("function reapplyVibrancy() {"));

describe("the window is born translucent-capable", () => {
  test("this test is reading the two functions", () => {
    expect(creation).toContain("new BrowserWindow({");
    expect(toggle).toContain("win.setVibrancy(material);");
  });

  test("the backdrop is the one decision, spread from window-material.js", () => {
    expect(creation).toContain("...backdropWindowOptions({");

    expect(creation).toContain("...readUiPrefs()");
    expect(creation).toContain("dark: nativeTheme.shouldUseDarkColors");
    expect(creation).toContain("supported: supportsTranslucency()");
  });

  test("NO creation option branches on the preference — that branch was the bug", () => {
    expect(creation).not.toMatch(/\btranslucent\s*\?/);
    expect(creation).not.toContain("transparent: true");
    expect(creation).not.toContain("hasShadow");
    expect(creation).not.toContain("backgroundColor:");
  });

  test("the renderer half of the anti-flicker pair is unconditional too", () => {
    expect(creation).toContain("backgroundThrottling: false,");
    expect(creation).not.toMatch(/backgroundThrottling[^,\n]*\?/);
  });

  test("and so is the occlusion switch, which can only be appended before ready", () => {
    const gpu = main.indexOf("\nif (supportsTranslucency()) {");
    const startup = main.slice(gpu, main.indexOf("if (SMOKE) {", gpu));
    expect(startup).toContain('app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");');
    expect(startup).toContain("if (supportsTranslucency()) {");
    expect(startup).not.toContain("readUiPrefs().translucent");
  });
});

describe("the toggle only retints", () => {
  test("no rebuild path survives, by name or by capability flag", () => {
    expect(main).not.toContain("recreateWindowTranslucent");

    expect(main).not.toContain("telarTranslucentCapable");
  });

  test("the retint builds no window and destroys none", () => {
    expect(toggle).not.toMatch(/createWindow\(/);
    expect(toggle).not.toMatch(/\.destroy\(\)/);

    expect(toggle).toContain("win.setVibrancy(material);");
    expect(toggle).toContain("win.setBackgroundColor(backgroundColor);");
    expect(toggle).toContain("if (win.isDestroyed()) continue;");
  });

  test("the opaque colour comes from window-material.js, not from a hex in here", () => {
    expect(toggle).toContain("windowBackgroundColor({ translucent: on, dark })");

    expect(toggle).not.toMatch(/setBackgroundColor\(\s*"/);
    expect(creation).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test("a scheme change is the SAME retint, so the opaque colour follows it", () => {
    const scheme = main.slice(main.indexOf("function reapplyVibrancy() {"), main.indexOf("function watchSchemeForVibrancy() {"));
    expect(scheme).toContain("applyTranslucency(translucent, frost)");

    expect(scheme).not.toContain("setVibrancy");
  });
});

describe("what the rebuild path left behind", () => {
  test("lastWindowUrl stays, because two live callers still need it", () => {
    expect(main).toContain("if (lastWindowUrl) void seatHostCookie(lastWindowUrl);");
    expect(main).toContain("windowTargetUrl(asking.webContents.getURL() || main.lastWindowUrl, input?.path)");
  });
});
