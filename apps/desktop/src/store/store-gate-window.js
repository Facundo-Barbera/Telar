"use strict";

const { BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");

const { describeOutcome } = require("./store-gate");

function createStoreGateWindow() {
  let gateWindow = null;
  let shown = null;
  let answer = null;

  const isOurs = (event) =>
    gateWindow !== null && !gateWindow.isDestroyed() && event.sender === gateWindow.webContents && event.senderFrame === event.sender.mainFrame;

  const trusted = (event, run) => {
    if (!isOurs(event)) throw new Error("Only the store window may use this channel.");
    return run();
  };

  ipcMain.handle("telar:store-gate:state", (event) => trusted(event, () => shown));
  ipcMain.handle("telar:store-gate:answer", (event, action) =>
    trusted(event, () => {
      const settle = answer;
      answer = null;
      settle?.(action === "quit" || action === "new-store" ? action : "retry");
    }),
  );

  ipcMain.handle("telar:store-gate:confirm-new-store", (event) =>
    trusted(event, async () => {
      const { response } = await dialog.showMessageBox(gateWindow, {
        type: "warning",
        buttons: ["Cancel", "Start a new store"],
        defaultId: 0,
        cancelId: 0,
        message: "Start a new, empty Telar store?",
        detail:
          "Your existing store is not deleted and its location is kept on record, but Telar will stop opening it and will start again with nothing in it.\n\nIf the drive it is on might come back, choose Cancel and plug it in instead.",
      });
      return response === 1;
    }),
  );

  const open = () => {
    if (gateWindow && !gateWindow.isDestroyed()) return;
    gateWindow = new BrowserWindow({
      width: 460,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Telar's store",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "store-gate-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    gateWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    gateWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    gateWindow.loadFile(path.join(__dirname, "..", "windows", "store-gate.html"));

    gateWindow.once("closed", () => {
      gateWindow = null;
      const settle = answer;
      answer = null;
      settle?.("quit");
    });
  };

  return {
    present(outcome) {
      shown = describeOutcome(outcome);
      open();
      if (gateWindow.webContents.isLoading()) gateWindow.webContents.once("did-finish-load", () => gateWindow?.webContents.send("telar:store-gate:state", shown));
      else gateWindow.webContents.send("telar:store-gate:state", shown);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },

    volumesChanged() {
      if (gateWindow && !gateWindow.isDestroyed()) gateWindow.webContents.send("telar:store-gate:resolve");
    },
    close() {
      const window = gateWindow;
      gateWindow = null;
      answer = null;
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}

module.exports = { createStoreGateWindow };
