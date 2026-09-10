// The update window's whole world: read state, start an update, hear log and
// status lines. Same contextBridge pattern as preload.js, scoped to this
// window only.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telarDevUpdate", {
  state: () => ipcRenderer.invoke("telar:dev-update:state"),
  start: () => ipcRenderer.invoke("telar:dev-update:start"),
  onLog: (handler) => ipcRenderer.on("telar:dev-update:log", (_event, line) => handler(line)),
  onStatus: (handler) => ipcRenderer.on("telar:dev-update:status", (_event, payload) => handler(payload)),
});
