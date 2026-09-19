"use strict";

/**
 * The Electron half of the store gate (#630) — the window a person meets when
 * their store is not reachable.
 *
 * DECISIONS LIVE IN `store-gate.js`, which is pure and tested. This file owns
 * only what the main process can: the window, the IPC surface (every handler
 * checks the sender is this window's own top frame, the same gate
 * `login-offer-window.js` applies), the typed confirmation, and the wiring from
 * `volume-watch.js` so a drive arriving ends the wait without a click.
 *
 * IT LOADS A LOCAL FILE AND NOTHING ELSE, and refuses every navigation and
 * popup. The same reasoning as the login offer's: this window asks a question
 * whose wrong answer is destructive, so no remote content may ever sit behind
 * its buttons.
 */

const { BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");

const { describeOutcome } = require("./store-gate");

/**
 * A presenter for `awaitStore`. Returns `{ present, close, volumesChanged }`:
 * `present` is what the loop awaits, `volumesChanged` is what the mount watcher
 * calls, and `close` tears the window down once a store has been settled on.
 */
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
      // Anything but the three known actions is a retry, which is the only
      // answer that can never do harm.
      const settle = answer;
      answer = null;
      settle?.(action === "quit" || action === "new-store" ? action : "retry");
    }),
  );

  /**
   * THE TYPED CONFIRMATION. Starting a new store is the one control here that
   * changes which store this install belongs to, and a misclick must not be
   * able to reach it. `store-location.js` archives rather than overwrites, so
   * even this is reversible by hand — but it should still take a deliberate
   * act, not a keystroke aimed at the default button.
   */
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
        preload: path.join(__dirname, "store-gate-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    gateWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    gateWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    gateWindow.loadFile(path.join(__dirname, "store-gate.html"));
    /**
     * CLOSING THE WINDOW IS QUITTING, and saying so is the honest reading: the
     * app has no store, so there is nothing behind this to go back to. It must
     * not resolve as "retry" — that would spin the loop against a window that
     * no longer exists.
     */
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
    /** A drive arrived or left: ask the window to re-resolve. Best-effort, as
     *  every path through `volume-watch.js` is — a missed nudge costs a click. */
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
