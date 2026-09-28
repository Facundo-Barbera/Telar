const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { electron, FakeBrowserWindow, resetElectron, userData } = require("../../test/fake-electron");
const { applyTranslucency, keepOccludedWindowsPainting, watchSchemeForVibrancy } = require("./appearance");
const { vibrancyMaterial, windowBackgroundColor } = require("./window-material");

const darwin = process.platform === "darwin";

afterEach(() => {
  fs.rmSync(path.join(userData, "ui-prefs.json"), { force: true });
  resetElectron();
});

describe("the toggle only retints", () => {
  test("every live window takes window-material's material and colour", () => {
    const windows = [new FakeBrowserWindow(), new FakeBrowserWindow()];
    applyTranslucency(true, "blur");
    for (const win of windows) {
      expect(win.vibrancy).toBe(vibrancyMaterial({ translucent: true, frost: "blur", dark: false }));
      expect(win.backgroundColor).toBe(windowBackgroundColor({ translucent: true, dark: false }));
    }
  });

  test("it builds no window, destroys none, and skips a destroyed one", () => {
    const live = new FakeBrowserWindow();
    const gone = new FakeBrowserWindow();
    gone.destroyed = true;
    applyTranslucency(false, "blur");
    expect(FakeBrowserWindow.all).toEqual([live, gone]);
    expect(live.destroyed).toBe(false);
    expect(live.backgroundColor).toBe(windowBackgroundColor({ translucent: false, dark: false }));
    expect(gone.backgroundColor).toBeUndefined();
  });

  test("one window that refuses does not stop the rest", () => {
    const stubborn = new FakeBrowserWindow();
    stubborn.setVibrancy = () => { throw new Error("no"); };
    const next = new FakeBrowserWindow();
    applyTranslucency(true, "blur");
    expect(next.vibrancy).toBe(vibrancyMaterial({ translucent: true, frost: "blur", dark: false }));
  });

  test("a scheme change is the same retint, so the opaque colour follows the system", () => {
    if (!darwin) return;
    fs.writeFileSync(path.join(userData, "ui-prefs.json"), JSON.stringify({ translucent: false, frost: "blur" }));
    const win = new FakeBrowserWindow();
    watchSchemeForVibrancy();
    electron.nativeTheme.shouldUseDarkColors = true;
    electron.nativeTheme.emit("updated");
    expect(win.backgroundColor).toBe(windowBackgroundColor({ translucent: false, dark: true }));
  });
});

test("occluded windows keep painting wherever translucency is possible", () => {
  keepOccludedWindowsPainting();
  expect(electron.app.switches).toEqual(darwin ? [["disable-backgrounding-occluded-windows"]] : []);
});
