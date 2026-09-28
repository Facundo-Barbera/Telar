const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

function pinUserData({ DEV_BUILD, E2E_USER_DATA, SMOKE } = require("./flags")) {
  if (E2E_USER_DATA) {
    app.setPath("userData", E2E_USER_DATA);
  } else if (SMOKE) {
    app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-electron-smoke-")));
  } else if (DEV_BUILD) {
    app.setPath("userData", path.join(app.getPath("appData"), "Telar Dev"));
  } else if (!app.isPackaged) {
    app.setName("Telar (dev)");
    app.setPath("userData", path.join(app.getPath("appData"), "Telar (dev)"));
  }
}

module.exports = { pinUserData };
