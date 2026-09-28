const { afterAll, beforeAll, beforeEach, describe, expect, mock, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electron, eventFrom, FakeBrowserWindow, resetElectron } = require("../../test/fake-electron");

const autoUpdater = Object.assign(new (require("node:events"))(), {
  installs: 0,
  quitAndInstall() {
    this.installs += 1;
    if (this.failInstall) throw new Error("stage failed");
  },
});
mock.module("electron-updater", () => ({ autoUpdater, CancellationToken: class {} }));

const { registerUpdates } = require("./updates");
const hosts = require("./browser-hosts");
const { PLANNED_RESTART_FILE } = require("./update-install");

let home;
let main;
let terminals;
let cockpit;
const marker = () => path.join(home, "engine", PLANNED_RESTART_FILE);

beforeAll(() => {
  resetElectron();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-updates-"));
  terminals = { size: 0, closed: 0, async closeAll() { this.closed += 1; }, async drain() {}, async activeProcesses() { return []; } };
  main = { telarHome: () => home, updaterWindow: null, terminalHost: terminals, terminalsClosedForQuit: false };
  cockpit = { window: new FakeBrowserWindow() };
  hosts.addHost(cockpit.window, cockpit);
});

beforeEach(() => {
  electron.app.isPackaged = true;
  electron.app.isQuitting = false;
  electron.dialog.shown = [];
  autoUpdater.failInstall = false;
  main.terminalsClosedForQuit = false;
  terminals.size = 0;
  fs.rmSync(path.join(home, "engine"), { recursive: true, force: true });
  registerUpdates(main);
});

afterAll(() => {
  hosts.removeHost(cockpit);
  electron.app.isPackaged = false;
  fs.rmSync(home, { recursive: true, force: true });
  resetElectron();
});

describe("telar:updates:install", () => {
  test("it marks the restart as planned, closes the terminals and installs without asking", async () => {
    terminals.size = 2;
    expect(await electron.ipcMain.invoke("telar:updates:install", {})).toEqual({ status: "restarting" });
    expect(JSON.parse(fs.readFileSync(marker(), "utf8"))).toMatchObject({ reason: "update" });
    expect(terminals.closed).toBe(1);
    expect(main.terminalsClosedForQuit).toBe(true);
    expect(autoUpdater.installs).toBeGreaterThan(0);
    expect(electron.dialog.shown).toEqual([]);
  });

  test("a failed stage takes the marker back and lets the next quit ask again", async () => {
    autoUpdater.failInstall = true;
    const result = await electron.ipcMain.invoke("telar:updates:install", {});
    expect(result).toEqual({ status: "error", message: "stage failed" });
    expect(fs.existsSync(marker())).toBe(false);
    expect(main.terminalsClosedForQuit).toBe(false);
    expect(electron.app.isQuitting).toBe(false);
  });

  test("an unpackaged build does not install at all", async () => {
    electron.app.isPackaged = false;
    expect(await electron.ipcMain.invoke("telar:updates:install", {})).toEqual({ status: "unsupported" });
    expect(fs.existsSync(marker())).toBe(false);
  });
});

test("only the cockpit may ask what a restart would end", async () => {
  expect(await electron.ipcMain.invoke("telar:updates:busy", eventFrom(cockpit.window))).toEqual({ terminals: { count: 0, commands: [] } });
  expect(() => electron.ipcMain.invoke("telar:updates:busy", eventFrom(cockpit.window, { frame: { name: "sub" } }))).toThrow("Only the Telar window");
});
