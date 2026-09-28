const fs = require("node:fs");
const path = require("node:path");

const MAIN_PROCESS = [
  "main.js", "app-menu.js", "appearance.js", "bundle-paths.js", "cockpit-extensions.js", "engine-child.js", "flags.js", "ipc-app.js", "ipc-browser.js",
  "ipc-prefs.js", "ipc-store.js", "ipc-terminal.js", "login-shell-env.js", "prefs.js", "renderer-watch.js", "shell-log.js", "tailscale.js", "ui-server.js",
  "update-prefs.js", "updates.js", "volumes.js",
];

/** main.js and the main-process modules it is split into, as one string, for source-contract tests. */
function mainSource() {
  return MAIN_PROCESS.map((f) => fs.readFileSync(path.join(__dirname, "..", "src", "main", f), "utf8")).join("\n");
}

module.exports = { mainSource };
