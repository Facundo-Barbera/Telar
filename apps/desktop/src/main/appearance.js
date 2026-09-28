const { BrowserWindow, nativeTheme } = require("electron");
const { jsonPrefs } = require("./prefs");
const { vibrancyMaterial, windowBackgroundColor } = require("./window-material");

const DEFAULT_UI_PREFS = { translucent: false, frost: "blur" };

const { read: readUiPrefs, write: writeUiPrefs } = jsonPrefs(
  "ui-prefs.json",
  DEFAULT_UI_PREFS,

  (raw) => ({ translucent: raw.translucent === true, frost: raw.frost === "clear" ? "clear" : "blur" }),
  "ui prefs",
);

function supportsTranslucency() {
  return process.platform === "darwin";
}

function applyTranslucency(on, frost) {
  const dark = nativeTheme.shouldUseDarkColors;

  const material = vibrancyMaterial({ translucent: on, frost, dark });

  const backgroundColor = windowBackgroundColor({ translucent: on, dark });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setVibrancy(material);
      win.setBackgroundColor(backgroundColor);
    } catch (err) {
      console.error("[telar-desktop] failed to retint a window:", err.message);
    }
  }
}

function reapplyVibrancy() {
  if (!supportsTranslucency()) return;
  const { translucent, frost } = readUiPrefs();
  applyTranslucency(translucent, frost);
}

function watchSchemeForVibrancy() {
  if (!supportsTranslucency()) return;
  nativeTheme.on("updated", reapplyVibrancy);
}

module.exports = { applyTranslucency, readUiPrefs, supportsTranslucency, watchSchemeForVibrancy, writeUiPrefs };
