const { spawn } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const child = spawn(electronPath, [path.join(__dirname, "desktop-e2e.js")], {
  cwd: __dirname,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    TELAR_BUN_BINARY: process.execPath,
    TELAR_ELECTRON_BINARY: electronPath,
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error("DESKTOP_E2E_LAUNCH_FAIL", error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`DESKTOP_E2E_LAUNCH_FAIL Electron Node exited with ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code || 0;
  }
});
