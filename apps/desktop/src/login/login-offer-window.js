"use strict";
const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { createLoginOfferFlow, isTrustedOfferSender } = require("./login-offer-flow");
const { listLoginCandidates } = require("./vault-metadata");
const { rememberLoginGrant } = require("./login-grant-writer");

function wireLoginOffer({ stateRoot, listCandidates = listLoginCandidates, remember = rememberLoginGrant }) {
  let offerWindow = null;

  const openWindow = () => {
    if (offerWindow && !offerWindow.isDestroyed()) {
      offerWindow.focus();
      return;
    }
    offerWindow = new BrowserWindow({
      width: 420,
      height: 480,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Allow a login for agents",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "login-offer-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    offerWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    offerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    offerWindow.loadFile(path.join(__dirname, "..", "windows", "login-offer.html"));
    offerWindow.once("closed", () => {
      offerWindow = null;
      flow.windowClosed();
    });
  };

  const closeWindow = () => {
    const window = offerWindow;
    offerWindow = null;

    if (window && !window.isDestroyed()) window.close();
  };

  const flow = createLoginOfferFlow({
    listCandidates: (origin) => listCandidates(origin),
    rememberGrant: (grant) => remember(stateRoot, grant),
    now: Date.now,
    ui: {
      open: openWindow,
      close: closeWindow,
      refresh: () => {
        if (offerWindow && !offerWindow.isDestroyed()) offerWindow.webContents.send("telar:login-offer:refresh");
      },
    },
  });

  const trusted = (event, run) => {
    if (!isTrustedOfferSender(event, offerWindow)) throw new Error("Only the login offer window may use this channel.");
    return run();
  };

  ipcMain.handle("telar:login-offer:state", (event) => trusted(event, () => flow.state()));
  ipcMain.handle("telar:login-offer:confirm", (event, input) => trusted(event, () => flow.confirm(input || {})));
  ipcMain.handle("telar:login-offer:dismiss", (event) => trusted(event, () => flow.dismiss()));

  return {
    entryFinished: (capture) => flow.entryFinished(capture),

    explicitOffer: (capture) => flow.explicitOffer(capture),
  };
}

module.exports = { wireLoginOffer };
