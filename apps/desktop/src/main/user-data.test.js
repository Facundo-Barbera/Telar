const { afterEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { electron, resetElectron, userData } = require("../../test/fake-electron");
const { pinUserData } = require("./user-data");

afterEach(resetElectron);

const launch = (flags) => pinUserData({ DEV_BUILD: false, E2E_USER_DATA: undefined, SMOKE: false, ...flags });

test("an E2E run keeps its state where the harness says, and nowhere else", () => {
  launch({ E2E_USER_DATA: "/tmp/e2e-state", SMOKE: true, DEV_BUILD: true });
  expect(electron.app.paths).toEqual({ userData: "/tmp/e2e-state" });
});

test("a smoke run gets a fresh directory of its own", () => {
  launch({ SMOKE: true });
  const smoke = electron.app.paths.userData;
  expect(path.basename(smoke)).toStartWith("telar-electron-smoke-");
  expect(fs.existsSync(smoke)).toBe(true);
  fs.rmSync(smoke, { recursive: true, force: true });
});

test("a dev build and an unpackaged run each keep apart from the installed app", () => {
  launch({ DEV_BUILD: true });
  expect(electron.app.paths).toEqual({ userData: path.join(userData, "Telar Dev") });
  resetElectron();
  launch({});
  expect(electron.app.paths).toEqual({ userData: path.join(userData, "Telar (dev)") });
  expect(electron.app.name).toBe("Telar (dev)");
});

test("the packaged app keeps Electron's default", () => {
  electron.app.isPackaged = true;
  launch({});
  expect(electron.app.paths).toEqual({});
});
