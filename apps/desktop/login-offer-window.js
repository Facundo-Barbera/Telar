/**
 * The trusted offer window — the Electron half of the login offer (AUTH-001,
 * #195). Decisions live in login-offer.js and login-offer-flow.js; this file
 * owns what only the main process can: the window itself (loads only the
 * local login-offer.html; every navigation and popup refused, so no remote
 * content can sit behind the Allow button), the IPC surface (every handler
 * first checks the sender is that window's own top frame — any other
 * renderer, including a browser tab or the cockpit, is refused), and the
 * wiring from browser-manager's "entry finished" callback and the cockpit's
 * explicit request into the flow. Captures and candidates are metadata; no
 * API grants; no page event is treated as confirmation.
 */
"use strict";
const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { createLoginOfferFlow, isTrustedOfferSender } = require("./login-offer-flow");
const { listLoginCandidates } = require("./vault-metadata");
const { rememberLoginGrant } = require("./login-grant-writer");

/**
 * Wire the whole feature once. `stateRoot` is the ENGINE state directory
 * (<TELAR_HOME>/engine) — the same one the daemon and worker read grants from.
 * Returns the two entry points main.js forwards into. `listCandidates` and
 * `remember` are injectable so tests can run the REAL window wiring against
 * fake vault metadata and a temp grant root; production passes nothing.
 */
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
        preload: path.join(__dirname, "login-offer-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // The confirmation surface never shows remote content: the local file is
    // the first and last thing this window loads.
    offerWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    offerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    offerWindow.loadFile(path.join(__dirname, "login-offer.html"));
    offerWindow.once("closed", () => {
      offerWindow = null;
      flow.windowClosed();
    });
  };

  const closeWindow = () => {
    const window = offerWindow;
    offerWindow = null;
    // The closed handler still fires and calls flow.windowClosed(), which is a
    // no-op by then: the flow only closes the window AFTER clearing its offer.
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

  /** The gate every offer channel passes: the trusted window's top frame, or
   *  a refusal. Registered once for the app's lifetime, like dev-update's. */
  const trusted = (event, run) => {
    if (!isTrustedOfferSender(event, offerWindow)) throw new Error("Only the login offer window may use this channel.");
    return run();
  };

  ipcMain.handle("telar:login-offer:state", (event) => trusted(event, () => flow.state()));
  ipcMain.handle("telar:login-offer:confirm", (event, input) => trusted(event, () => flow.confirm(input || {})));
  ipcMain.handle("telar:login-offer:dismiss", (event) => trusted(event, () => flow.dismiss()));

  return {
    /** browser-manager's automatic lifecycle: a credential entry finished. */
    entryFinished: (capture) => flow.entryFinished(capture),
    /** The cockpit's explicit fallback: offer about a scope's active page. */
    explicitOffer: (capture) => flow.explicitOffer(capture),
  };
}

module.exports = { wireLoginOffer };
