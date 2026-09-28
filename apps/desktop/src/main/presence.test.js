const { afterEach, expect, test } = require("bun:test");
const { electron, FakeBrowserWindow, resetElectron } = require("../../test/fake-electron");
const hosts = require("./browser-hosts");
const { createPresence } = require("./presence");

afterEach(resetElectron);

test("a lock, an unlock and a focus change each report at once, and a locked screen is not active", () => {
  const sent = [];
  const presence = createPresence({ send: (message) => sent.push(message) });
  presence.watch();
  const started = sent.length;

  electron.powerMonitor.emit("lock-screen");
  expect(sent.at(-1)).toMatchObject({ active: false });
  electron.powerMonitor.emit("unlock-screen");
  expect(sent.at(-1)).toMatchObject({ active: true });
  electron.app.emit("browser-window-blur");
  electron.app.emit("browser-window-focus");
  expect(sent.length - started).toBe(4);
  presence.stop();
});

test("focus on a cockpit window reports the route it shows; focus elsewhere reports none", () => {
  const sent = [];
  const presence = createPresence({ send: (message) => sent.push(message) });
  const cockpit = new FakeBrowserWindow();
  cockpit.webContents.url = "http://127.0.0.1:42731/projects/p1/sessions/s1";
  const manager = { window: cockpit };
  hosts.addHost(cockpit, manager);

  cockpit.focus();
  presence.report();
  expect(sent.at(-1)).toMatchObject({ active: true, viewingPath: "/projects/p1/sessions/s1" });

  new FakeBrowserWindow().focus();
  presence.report();
  expect(sent.at(-1)).toMatchObject({ active: true, viewingPath: null });
  hosts.removeHost(manager);
});

test("watching twice starts one beat and one set of listeners", () => {
  const sent = [];
  const presence = createPresence({ send: (message) => sent.push(message) });
  presence.watch();
  presence.watch();
  const before = sent.length;
  electron.powerMonitor.emit("lock-screen");
  expect(sent.length - before).toBe(1);
  presence.stop();
});
