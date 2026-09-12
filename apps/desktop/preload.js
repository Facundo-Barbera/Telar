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
  // Guarded, not unconditional: the observer below watches this attribute,
  // and setAttribute fires it even when the value is unchanged — writing
  // blindly from the callback would be a mutation loop.
  if (document.documentElement?.getAttribute("data-telar-shell") !== shell) {
    document.documentElement?.setAttribute("data-telar-shell", shell);
  }
}
markShell();
document.addEventListener("DOMContentLoaded", () => {
  markShell();
  // AND KEEP IT SET. React owns <html> in the app router, and its recovery
  // from a hydration error re-renders the element and strips attributes it
  // did not put there — seen live: the traffic lights lost their inset until
  // a manual reload. Every attribute the PAGE sets is re-applied by its own
  // effects after such a re-render; this is the one attribute only the shell
  // knows, so the shell is the one who has to put it back.
  new MutationObserver(markShell).observe(document.documentElement, { attributes: true, attributeFilter: ["data-telar-shell"] });
}, { once: true });

contextBridge.exposeInMainWorld("telarDesktop", {
  isDesktop: true,
  browser: {
    suggestions: (scopeKey) => ipcRenderer.invoke("telar:browser:suggestions", scopeKey),
    removeSuggestion: (scopeKey, url) => ipcRenderer.invoke("telar:browser:remove-suggestion", { scopeKey, url }),
    getState: (scopeKey) => ipcRenderer.invoke("telar:browser:state", scopeKey),
    action: (scopeKey, action) => ipcRenderer.invoke("telar:browser:action", { scopeKey, action }),
    callTool: (scopeKey, name, args) => ipcRenderer.invoke("telar:browser:tool", { scopeKey, name, args }),
    setBounds: (scopeKey, bounds) => ipcRenderer.invoke("telar:browser:set-bounds", { scopeKey, bounds }),
    setVisible: (scopeKey, visible) => ipcRenderer.invoke("telar:browser:set-visible", { scopeKey, visible }),
    releaseScope: (scopeKey, destroy = false) => ipcRenderer.invoke("telar:browser:release-scope", { scopeKey, destroy }),
    adoptScope: (fromScopeKey, toScopeKey) => ipcRenderer.invoke("telar:browser:adopt-scope", { fromScopeKey, toScopeKey }),
    onState: (listener) => on("telar:browser:state", listener),
    onPointer: (listener) => on("telar:browser:pointer", listener),
    // The password manager: its status, its toolbar popup, and the human's
    // explicit resume from a private interaction.
    // Per-project browser profile: the cockpit binds a session's scope to its
    // project before showing the panel, so a human-opened tab lands in the
    // right cookie jar even before the first agent turn.
    bindProfile: (scopeKey, profileKey) => ipcRenderer.invoke("telar:browser:bind-profile", { scopeKey, profileKey }),
    // NAMED, REUSABLE PROFILES: several projects may share one identity, and a
    // person switches which one a session's next tab opens in from the panel.
    // Managed in full from Settings → Integrations; deleting forgets the record
    // and is refused while anything — a project, a session, the default — still
    // points at it. The cookie jar on disk is never removed.
    profiles: (scopeKey) => ipcRenderer.invoke("telar:browser:profiles", scopeKey),
    createProfile: (input) => ipcRenderer.invoke("telar:browser:create-profile", input),
    updateProfile: (input) => ipcRenderer.invoke("telar:browser:update-profile", input),
    deleteProfile: (profileId) => ipcRenderer.invoke("telar:browser:delete-profile", { profileId }),
    setDefaultProfile: (profileId) => ipcRenderer.invoke("telar:browser:set-default-profile", { profileId }),
    assignProjectProfile: (input) => ipcRenderer.invoke("telar:browser:assign-project-profile", input),
    setScopeProfile: (scopeKey, profileId) => ipcRenderer.invoke("telar:browser:set-scope-profile", { scopeKey, profileId }),
    extensionStatus: (scopeKey) => ipcRenderer.invoke("telar:browser:extension-status", scopeKey),
    openExtensionPopup: (scopeKey, anchorRect) => ipcRenderer.invoke("telar:browser:extension-popup", { scopeKey, anchorRect }),
    resumeFromPrivate: () => ipcRenderer.invoke("telar:browser:private-resume"),
    onExtension: (listener) => on("telar:browser:extension", listener),
    // The EXPLICIT login-offer fallback (AUTH-001): ask, about this session's
    // current page, "may agents use the login I signed in with here?". Opens
    // the trusted offer window; the answer only ever happens inside it.
    offerLoginMemory: (scopeKey) => ipcRenderer.invoke("telar:login-offer:open", scopeKey),
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
  /**
   * Open a workspace folder in the system's own handler, or reveal it in the
   * file manager. The path is passed as an ARGUMENT the whole way down — see
   * the main-process handler; nothing is ever interpolated into a command.
   */
  workspace: {
    openers: () => ipcRenderer.invoke("telar:workspace:openers"),
    open: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, ...(openerId ? { openerId } : {}) }),
    reveal: (path) => ipcRenderer.invoke("telar:workspace:open", { path, reveal: true }),
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
  app: {
    // Settings → Remote access offers this after a change the shell only
    // reads at launch.
    relaunch: () => ipcRenderer.invoke("telar:app:relaunch"),
  },
  updates: {
    check: () => ipcRenderer.invoke("telar:updates:check"),
    install: () => ipcRenderer.invoke("telar:updates:install"),
    onStatus: (listener) => on("telar:updates:status", listener),
    // The last status the shell broadcast — how a renderer that mounted after
    // `update-downloaded` still learns an install is waiting.
    status: () => ipcRenderer.invoke("telar:updates:status"),
    getPrefs: () => ipcRenderer.invoke("telar:updates:getPrefs"),
    setPrefs: (patch) => ipcRenderer.invoke("telar:updates:setPrefs", patch),
    // Dev builds only: the local-checkout update window (dev-update.js).
    openLocalUpdater: () => ipcRenderer.invoke("telar:updates:openLocalUpdater"),
  },
  // Issue #16: the app menu's native accelerators fire in the main process,
  // which has no DOM and so cannot apply the focus rule itself — it just
  // forwards which binding fired, and the renderer (lib/use-command-keys.ts)
  // decides what that means and whether focus allows it to happen.
  commandKeys: {
    onInvoke: (listener) => on("telar:command-keys:invoke", listener),
  },
});
