const fs = require("node:fs");
const { jsonPrefs } = require("../main/prefs");

const APP_PATH = "/Applications/1Password.app";

const stored = jsonPrefs(
  "password-manager-prefs.json",
  { enabled: null },
  (raw) => ({ enabled: typeof raw.enabled === "boolean" ? raw.enabled : null }),
  "password manager prefs",
);

function createPasswordManagerPrefs(store, appInstalled) {
  return {
    enabled: () => store.read().enabled ?? appInstalled(),
    set: (enabled) => store.write({ enabled }),
  };
}

const live = createPasswordManagerPrefs(stored, () => fs.existsSync(APP_PATH));

module.exports = {
  createPasswordManagerPrefs,
  passwordManagerEnabled: live.enabled,
  setPasswordManagerEnabled: live.set,
};
