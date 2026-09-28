const { ipcMain, app, BrowserWindow } = require("electron");
const { windowVisible } = require("../window-visibility");
const { windowTargetUrl } = require("../window-target");

function registerAppIpc(main) {
  const { createWindow, linkRouting, processMetricsReader } = main;
  ipcMain.handle("telar:app:relaunch", () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("telar:metrics:read", () => processMetricsReader().summary());

  ipcMain.handle("telar:metrics:runaway", () => main.lastRunawayNotice);

  ipcMain.handle("telar:window:visibility", (event) => windowVisible(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle("telar:links:set-routing", (event, input) => {
    const asking = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents === event.sender);
    if (!asking || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Only a Telar window may route its own links.");
    }
    linkRouting.set(event.sender, input?.on === true);
    return { ok: true };
  });

  ipcMain.handle("telar:app:open-window", (event, input) => {
    const asking = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents === event.sender);
    if (!asking || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Only a Telar window may open another one.");
    }
    const target = windowTargetUrl(asking.webContents.getURL() || main.lastWindowUrl, input?.path);
    if (!target) return { ok: false, error: "A new window only opens on a page inside Telar." };
    createWindow(target);
    return { ok: true };
  });
}

module.exports = { registerAppIpc };
