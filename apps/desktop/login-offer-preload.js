// The trusted offer window's whole vocabulary: read the offer, confirm it,
// wave it away. Nothing here can name an origin, a profile or a tab — the
// main process holds those (login-offer-flow.js) and ignores anything else.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telarLoginOffer", {
  state: () => ipcRenderer.invoke("telar:login-offer:state"),
  confirm: (input) => ipcRenderer.invoke("telar:login-offer:confirm", input),
  dismiss: () => ipcRenderer.invoke("telar:login-offer:dismiss"),
  onRefresh: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("telar:login-offer:refresh", handler);
    return () => ipcRenderer.removeListener("telar:login-offer:refresh", handler);
  },
});
