const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * TELL THE PAGE IT IS INSIDE THE SHELL, BEFORE THE PAGE CAN PAINT.
 *
 * The window has no system titlebar on macOS (see window-chrome.js), so the
 * renderer has to reserve room for the traffic lights and mark its headers as
 * drag regions — both of which are LAYOUT, and layout discovered one render
 * late is a header that visibly jumps on every launch. A preload runs before
 * any of the page's own scripts, which is the earliest this can be known.
 *
 * AN ATTRIBUTE, NOT A BRIDGE CALL, because the consumer is CSS: globals.css
 * keys `--titlebar-inset` and the drag classes off `[data-telar-shell]`, so no
 * component has to ask, re-render, or exist yet.
 *
 * Called twice on purpose. At document-start `documentElement` usually exists,
 * but "usually" is doing real work in that sentence — the second call is the
 * guarantee, and setting the same attribute twice costs nothing.
 */
function markShell() {
  const shell = process.platform === "darwin" ? "macos" : "desktop";
  document.documentElement?.setAttribute("data-telar-shell", shell);
}
markShell();
document.addEventListener("DOMContentLoaded", markShell, { once: true });

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
  /**
   * The native folder picker.
   *
   * The renderer cannot open one — a browser sandbox will never hand back an
   * absolute path — and the engine needs exactly that to register a project.
   * Answers `{ path }` or `{ cancelled: true }`; changing your mind is not an
   * error and the caller should not have to guess which happened.
   */
  dialog: {
    chooseDirectory: (options) => ipcRenderer.invoke("telar:dialog:choose-directory", options ?? {}),
  },
  // Window translucency — the one piece of appearance the renderer cannot do
  // alone, because the vibrancy layer lives under the page (main.js).
  appearance: {
    get: () => ipcRenderer.invoke("telar:appearance:get"),
    set: (patch) => ipcRenderer.invoke("telar:appearance:set", patch),
    // Keeps the vibrancy material's light/dark in step with the cockpit's own
    // scheme — see main.js.
    setTheme: (theme) => ipcRenderer.invoke("telar:appearance:setTheme", theme),
  },
  updates: {
    check: () => ipcRenderer.invoke("telar:updates:check"),
    install: () => ipcRenderer.invoke("telar:updates:install"),
    onStatus: (listener) => on("telar:updates:status", listener),
    getPrefs: () => ipcRenderer.invoke("telar:updates:getPrefs"),
    setPrefs: (patch) => ipcRenderer.invoke("telar:updates:setPrefs", patch),
  },
  // Issue #16: the app menu's native accelerators fire in the main process,
  // which has no DOM and so cannot apply the focus rule itself — it just
  // forwards which binding fired, and the renderer (lib/use-command-keys.ts)
  // decides what that means and whether focus allows it to happen.
  commandKeys: {
    onInvoke: (listener) => on("telar:command-keys:invoke", listener),
  },
});
