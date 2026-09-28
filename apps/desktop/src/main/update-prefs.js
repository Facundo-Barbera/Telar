const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { DEV_BUILD } = require("./flags");
const { jsonPrefs } = require("./prefs");

function updateProxyKey() {
  try {
    return require("../../package.json").updateProxyKey || null;
  } catch {
    return null;
  }
}

function updateLogPath() {
  return path.join(app.getPath("userData"), "update.log");
}

const UPDATE_CHANNELS = ["beta", "nightly"];
const DEFAULT_UPDATE_PREFS = { channel: "beta", installOnQuit: false };

const validUpdatePrefs = (raw) => ({
  channel: UPDATE_CHANNELS.includes(raw.channel) ? raw.channel : DEFAULT_UPDATE_PREFS.channel,
  installOnQuit: raw.installOnQuit === true,
});

const updatePrefs = jsonPrefs("update-prefs.json", DEFAULT_UPDATE_PREFS, validUpdatePrefs, "update prefs");
const readUpdatePrefs = updatePrefs.read;
const writeUpdatePrefs = updatePrefs.write;

const LEGACY_USER_DATA_NAME = "telar-desktop";

function adoptLegacyUpdatePrefs() {
  if (DEV_BUILD) return;
  try {
    if (fs.existsSync(updatePrefs.path())) return;
    const legacy = path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME, "update-prefs.json");
    if (!fs.existsSync(legacy)) return;

    const prefs = validUpdatePrefs(JSON.parse(fs.readFileSync(legacy, "utf8")));
    writeUpdatePrefs(prefs);
    console.log(`[telar-desktop] adopted update preferences from the previous install (channel ${prefs.channel})`);
  } catch (err) {
    console.error("[telar-desktop] could not adopt previous update preferences:", err.message);
  }
}

module.exports = { adoptLegacyUpdatePrefs, readUpdatePrefs, UPDATE_CHANNELS, updateLogPath, updateProxyKey, writeUpdatePrefs };
