const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("telarDesktop", {
  isDesktop: true,
  browser: {
    getState: (scopeKey) => ipcRenderer.invoke("telar:browser:state", scopeKey),
    action: (scopeKey, action) => ipcRenderer.invoke("telar:browser:action", { scopeKey, action }),
    callTool: (scopeKey, name, args) => ipcRenderer.invoke("telar:browser:tool", { scopeKey, name, args }),
    setBounds: (scopeKey, bounds) => ipcRenderer.invoke("telar:browser:set-bounds", { scopeKey, bounds }),
    setVisible: (scopeKey, visible) => ipcRenderer.invoke("telar:browser:set-visible", { scopeKey, visible }),
    releaseScope: (scopeKey, destroy = false) => ipcRenderer.invoke("telar:browser:release-scope", { scopeKey, destroy }),
    adoptScope: (fromScopeKey, toScopeKey) => ipcRenderer.invoke("telar:browser:adopt-scope", { fromScopeKey, toScopeKey }),
    onState: (listener) => on("telar:browser:state", listener),
    onPointer: (listener) => on("telar:browser:pointer", listener),
  },
});
