const fs = require("node:fs");
const path = require("node:path");

const MAIN_PROCESS = ["main.js", "ipc-app.js", "ipc-browser.js", "ipc-prefs.js", "ipc-store.js", "ipc-terminal.js", "prefs.js", "ui-server.js", "updates.js"];

/** main.js and the modules it registers IPC and the UI server through, as one string, for source-contract tests. */
function mainSource() {
  return MAIN_PROCESS.map((f) => fs.readFileSync(path.join(__dirname, "..", "src", "main", f), "utf8")).join("\n");
}

module.exports = { mainSource };
