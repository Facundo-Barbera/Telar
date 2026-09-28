"use strict";

/**
 * The store gate window's bridge (#630) — the same shape as the login offer's:
 * a handful of named channels, nothing else exposed, and the main process
 * checks the sender on every one of them.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telarStoreGate", {
  state: () => ipcRenderer.invoke("telar:store-gate:state"),
  answer: (action) => ipcRenderer.invoke("telar:store-gate:answer", action),
  confirmNewStore: () => ipcRenderer.invoke("telar:store-gate:confirm-new-store"),
  onState: (listener) => ipcRenderer.on("telar:store-gate:state", (_event, state) => listener(state)),
  /** The mount roots changed — re-resolve without waiting for a click. */
  onResolve: (listener) => ipcRenderer.on("telar:store-gate:resolve", () => listener()),
});
