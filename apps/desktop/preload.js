const { contextBridge, ipcRenderer } = require("electron");

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function markShell() {
  const shell = process.platform === "darwin" ? "macos" : "desktop";

  if (document.documentElement?.getAttribute("data-telar-shell") !== shell) {
    document.documentElement?.setAttribute("data-telar-shell", shell);
  }
}
markShell();
document.addEventListener("DOMContentLoaded", () => {
  markShell();

  new MutationObserver(markShell).observe(document.documentElement, { attributes: true, attributeFilter: ["data-telar-shell"] });
}, { once: true });

contextBridge.exposeInMainWorld("telarDesktop", {
  isDesktop: true,

  links: {
    setRouting: (on) => ipcRenderer.invoke("telar:links:set-routing", { on }),
    onOpen: (listener) => on("telar:links:open", listener),
  },
  browser: {
    suggestions: (scopeKey) => ipcRenderer.invoke("telar:browser:suggestions", scopeKey),
    removeSuggestion: (scopeKey, url) => ipcRenderer.invoke("telar:browser:remove-suggestion", { scopeKey, url }),
    getState: (scopeKey) => ipcRenderer.invoke("telar:browser:state", scopeKey),
    action: (scopeKey, action) => ipcRenderer.invoke("telar:browser:action", { scopeKey, action }),

    openExternal: (url) => ipcRenderer.invoke("telar:browser:open-external", { url }),

    clearBrowsingData: (scopeKey, kind) => ipcRenderer.invoke("telar:browser:clear-data", { scopeKey, kind }),

    capture: (scopeKey, options) => ipcRenderer.invoke("telar:browser:capture", { scopeKey, ...(options || {}) }),
    callTool: (scopeKey, name, args) => ipcRenderer.invoke("telar:browser:tool", { scopeKey, name, args }),

    setBounds: (scopeKey, bounds) => {
      ipcRenderer.send("telar:browser:set-bounds", { scopeKey, bounds });
      return Promise.resolve();
    },
    setVisible: (scopeKey, visible) => ipcRenderer.invoke("telar:browser:set-visible", { scopeKey, visible }),

    freezeView: (scopeKey) => ipcRenderer.invoke("telar:browser:freeze-view", { scopeKey }),

    releaseScope: (scopeKey, destroy = false, { closedByPerson = false } = {}) =>
      ipcRenderer.invoke("telar:browser:release-scope", { scopeKey, destroy, closedByPerson }),
    adoptScope: (fromScopeKey, toScopeKey) => ipcRenderer.invoke("telar:browser:adopt-scope", { fromScopeKey, toScopeKey }),
    onState: (listener) => on("telar:browser:state", listener),
    onPointer: (listener) => on("telar:browser:pointer", listener),

    bindProfile: (scopeKey, profileKey) => ipcRenderer.invoke("telar:browser:bind-profile", { scopeKey, profileKey }),

    profiles: (scopeKey) => ipcRenderer.invoke("telar:browser:profiles", scopeKey),
    createProfile: (input) => ipcRenderer.invoke("telar:browser:create-profile", input),
    updateProfile: (input) => ipcRenderer.invoke("telar:browser:update-profile", input),
    deleteProfile: (profileId) => ipcRenderer.invoke("telar:browser:delete-profile", { profileId }),
    setDefaultProfile: (profileId) => ipcRenderer.invoke("telar:browser:set-default-profile", { profileId }),
    assignProjectProfile: (input) => ipcRenderer.invoke("telar:browser:assign-project-profile", input),
    setScopeProfile: (scopeKey, profileId) => ipcRenderer.invoke("telar:browser:set-scope-profile", { scopeKey, profileId }),
    extensionStatus: (scopeKey) => ipcRenderer.invoke("telar:browser:extension-status", scopeKey),
    openExtensionPopup: (scopeKey, anchorRect) => ipcRenderer.invoke("telar:browser:extension-popup", { scopeKey, anchorRect }),
    onExtension: (listener) => on("telar:browser:extension", listener),

    onPermissionRequest: (listener) => on("telar:browser:permission-request", listener),

    onPermissionDenied: (listener) => on("telar:browser:permission-denied", listener),
    answerPermission: (input) => ipcRenderer.invoke("telar:browser:permission-answer", input),

    permissionPrompts: (scopeKey) => ipcRenderer.invoke("telar:browser:permission-prompts", scopeKey),

    onDownload: (listener) => on("telar:browser:download", listener),
    revealDownload: (path) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", reveal: true }),

    sitePermissions: (input) => ipcRenderer.invoke("telar:browser:site-permissions", input ?? {}),
    forgetSitePermission: (input) => ipcRenderer.invoke("telar:browser:forget-site-permission", input),

    offerLoginMemory: (scopeKey) => ipcRenderer.invoke("telar:login-offer:open", scopeKey),
  },

  terminal: {
    open: (options) => ipcRenderer.invoke("telar:terminal:open", options ?? {}),
    write: (id, data) => ipcRenderer.invoke("telar:terminal:write", { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke("telar:terminal:resize", { id, cols, rows }),
    kill: (id, signal) => ipcRenderer.invoke("telar:terminal:kill", { id, signal }),

    close: (id) => ipcRenderer.invoke("telar:terminal:close", { id }),

    active: (ids) => ipcRenderer.invoke("telar:terminal:active", ids ? { ids } : {}),

    list: () => ipcRenderer.invoke("telar:terminal:list"),

    adopt: (id) => ipcRenderer.invoke("telar:terminal:adopt", { id }),

    abandon: (id) => ipcRenderer.invoke("telar:terminal:abandon", { id }),

    readImageFile: (path) => ipcRenderer.invoke("telar:terminal:read-image-file", { path }),
    onData: (listener) => on("telar:terminal:data", listener),
    onExit: (listener) => on("telar:terminal:exit", listener),
  },

  dialog: {
    chooseDirectory: (options) => ipcRenderer.invoke("telar:dialog:choose-directory", options ?? {}),
  },

  store: {
    status: () => ipcRenderer.invoke("telar:store:status"),
    preflight: (path) => ipcRenderer.invoke("telar:store:preflight", { path }),
    move: (path) => ipcRenderer.invoke("telar:store:move", { path }),
    removeOld: () => ipcRenderer.invoke("telar:store:remove-old"),
    keepOld: () => ipcRenderer.invoke("telar:store:keep-old"),
    onProgress: (listener) => on("telar:store:progress", listener),
  },

  workspace: {
    openers: () => ipcRenderer.invoke("telar:workspace:openers"),
    open: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, ...(openerId ? { openerId } : {}) }),
    reveal: (path) => ipcRenderer.invoke("telar:workspace:open", { path, reveal: true }),

    revealFile: (path) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", reveal: true }),
    openFile: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", ...(openerId ? { openerId } : {}) }),
  },

  appearance: {
    get: () => ipcRenderer.invoke("telar:appearance:get"),
    set: (patch) => ipcRenderer.invoke("telar:appearance:set", patch),

    setTheme: (theme) => ipcRenderer.invoke("telar:appearance:setTheme", theme),
  },
  app: {
    relaunch: () => ipcRenderer.invoke("telar:app:relaunch"),

    openWindow: (path) => ipcRenderer.invoke("telar:app:open-window", { path }),
  },

  metrics: {
    read: () => ipcRenderer.invoke("telar:metrics:read"),

    runaway: () => ipcRenderer.invoke("telar:metrics:runaway"),
    onRunaway: (listener) => on("telar:metrics:runaway", listener),
  },

  visibility: {
    get: () => ipcRenderer.invoke("telar:window:visibility"),
    onChange: (listener) => on("telar:window:visibility", listener),
  },
  updates: {
    check: () => ipcRenderer.invoke("telar:updates:check"),

    install: () => ipcRenderer.invoke("telar:updates:install"),

    busy: () => ipcRenderer.invoke("telar:updates:busy"),
    onStatus: (listener) => on("telar:updates:status", listener),

    status: () => ipcRenderer.invoke("telar:updates:status"),
    getPrefs: () => ipcRenderer.invoke("telar:updates:getPrefs"),
    setPrefs: (patch) => ipcRenderer.invoke("telar:updates:setPrefs", patch),

    openLocalUpdater: () => ipcRenderer.invoke("telar:updates:openLocalUpdater"),
  },

  commandKeys: {
    onInvoke: (listener) => on("telar:command-keys:invoke", listener),
  },

  notifications: {
    onOpen: (listener) => on("telar:notifications:open", listener),
  },

  keybindings: {
    get: () => ipcRenderer.invoke("telar:keybindings:get"),
    set: (overrides) => ipcRenderer.invoke("telar:keybindings:set", overrides),

    capture: (capturing) => ipcRenderer.invoke("telar:keybindings:capture", capturing),

    scope: (chords) => ipcRenderer.invoke("telar:keybindings:scope", chords),
  },
});
