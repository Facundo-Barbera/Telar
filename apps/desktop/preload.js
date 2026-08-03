const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("telarDesktop", {
  isDesktop: true,
  browser: {
    getState: () => ipcRenderer.invoke("telar:browser:state"),
    action: (action) => ipcRenderer.invoke("telar:browser:action", action),
    callTool: (name, args) => ipcRenderer.invoke("telar:browser:tool", { name, args }),
    setBounds: (bounds) => ipcRenderer.invoke("telar:browser:set-bounds", bounds),
    setVisible: (visible) => ipcRenderer.invoke("telar:browser:set-visible", visible),
    onState: (listener) => on("telar:browser:state", listener),
    onPointer: (listener) => on("telar:browser:pointer", listener),
  },
});
