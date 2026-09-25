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
    // The tab strip's "Open in system browser". http/https only, decided in
    // the main process — see the handler there.
    openExternal: (url) => ipcRenderer.invoke("telar:browser:open-external", { url }),
    // The options menu's "Clear cookies" / "Clear cache" (#473). Destructive
    // and PROFILE-WIDE, so the main process refuses anyone but the cockpit's
    // own top frame — see the handler there.
    clearBrowsingData: (scopeKey, kind) => ipcRenderer.invoke("telar:browser:clear-data", { scopeKey, kind }),
    // The camera button, and the frozen frame annotate mode draws on (#474).
    // The human's ACTIVE tab at its own scale — not the agent's tab, and not
    // the panel's fit scale. Cockpit-only, refused in the main process.
    capture: (scopeKey, options) => ipcRenderer.invoke("telar:browser:capture", { scopeKey, ...(options || {}) }),
    callTool: (scopeKey, name, args) => ipcRenderer.invoke("telar:browser:tool", { scopeKey, name, args }),
    // FIRE-AND-FORGET, alone among these calls. Bounds are published from a
    // drag's animation frame, and the renderer awaiting a main-process round
    // trip per frame is what made the native view trail the panel's edge.
    // Nothing reads an answer — the next frame's rect supersedes this one —
    // so the send returns an already-settled promise and the caller's `await`
    // costs a microtask instead of an IPC hop. Every other browser call stays
    // `invoke`, because every other one answers something.
    setBounds: (scopeKey, bounds) => {
      ipcRenderer.send("telar:browser:set-bounds", { scopeKey, bounds });
      return Promise.resolve();
    },
    setVisible: (scopeKey, visible) => ipcRenderer.invoke("telar:browser:set-visible", { scopeKey, visible }),
    // A menu is opening over the panel (#475): take the page's last frame,
    // THEN put the view down, so the panel can keep showing the page while
    // the menu is up. One call because that order is the whole point.
    freezeView: (scopeKey) => ipcRenderer.invoke("telar:browser:freeze-view", { scopeKey }),
    releaseScope: (scopeKey, destroy = false) => ipcRenderer.invoke("telar:browser:release-scope", { scopeKey, destroy }),
    adoptScope: (fromScopeKey, toScopeKey) => ipcRenderer.invoke("telar:browser:adopt-scope", { fromScopeKey, toScopeKey }),
    onState: (listener) => on("telar:browser:state", listener),
    onPointer: (listener) => on("telar:browser:pointer", listener),
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
    onExtension: (listener) => on("telar:browser:extension", listener),
    // SITE PERMISSIONS (#422): camera, microphone, notifications, location,
    // clipboard and screen share, asked with Telar's own prompt over the address
    // bar and remembered per profile and origin.
    //
    // THE ANSWER GOES BACK OVER ITS OWN CHANNEL and the main process refuses it
    // from anything but this window's main frame — the question is drawn here,
    // so this is the only place an answer can honestly come from.
    onPermissionRequest: (listener) => on("telar:browser:permission-request", listener),
    // macOS refused the device AFTER the human allowed the site. The page will
    // only ever report NotAllowedError; this is the sentence that names the
    // System Settings pane to open.
    onPermissionDenied: (listener) => on("telar:browser:permission-denied", listener),
    answerPermission: (input) => ipcRenderer.invoke("telar:browser:permission-answer", input),
    // What is still being asked, so a panel that remounted does not leave a page
    // waiting on a prompt nobody can see.
    permissionPrompts: (scopeKey) => ipcRenderer.invoke("telar:browser:permission-prompts", scopeKey),
    // DOWNLOADS go straight to the Downloads folder with no dialog; this is
    // where the panel hears one started or finished, and where it lands.
    // Revealing it is the workspace handler's file reveal — the same guards.
    onDownload: (listener) => on("telar:browser:download", listener),
    revealDownload: (path) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", reveal: true }),
    // Read: this session's profile, one origin or all of them (the lock popover),
    // or — with no scope — every decision this install holds, by profile, for
    // Settings ▸ Browser. Revoking takes one kind, or an origin's whole row.
    sitePermissions: (input) => ipcRenderer.invoke("telar:browser:site-permissions", input ?? {}),
    forgetSitePermission: (input) => ipcRenderer.invoke("telar:browser:forget-site-permission", input),
    // The EXPLICIT login-offer fallback (AUTH-001): ask, about this session's
    // current page, "may agents use the login I signed in with here?". Opens
    // the trusted offer window; the answer only ever happens inside it.
    offerLoginMemory: (scopeKey) => ipcRenderer.invoke("telar:login-offer:open", scopeKey),
  },
  /**
   * A REAL TERMINAL (#198). The PTY lives in the main process — see
   * terminal-host.js for why there and not in the engine — and the emulator
   * (xterm.js) lives in the cockpit's own DOM, so these are the bytes between
   * them. No loopback port and no new thing to authenticate: the main process
   * already refuses anyone but this window's top frame.
   *
   * `exit` IS NOT ALWAYS AN EXIT, and a caller must not read it as one. Its
   * `fate` is `exited` (observed, with a code), `failed` (never started) or
   * `unknown` — the last meaning Telar stopped being able to vouch for the
   * process, which is NOT permission to treat it as gone. The engine's
   * `RunStatus` has the same three-way split for the same reason.
   */
  terminal: {
    open: (options) => ipcRenderer.invoke("telar:terminal:open", options ?? {}),
    write: (id, data) => ipcRenderer.invoke("telar:terminal:write", { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke("telar:terminal:resize", { id, cols, rows }),
    kill: (id, signal) => ipcRenderer.invoke("telar:terminal:kill", { id, signal }),
    // How a remounted panel finds the terminals its previous render left running.
    list: () => ipcRenderer.invoke("telar:terminal:list"),
    /**
     * READ A RUN'S TERMINAL (#890) — a chip in the strip, beside the shells.
     *
     * The only id this accepts is one the ENGINE opened, and the only thing it
     * grants is being sent that terminal's frames. Typing into a run, resizing
     * it and stopping it all still go through the engine's own routes, where
     * the project's singleton and its journal live. The frames that arrive are
     * the engine's REDACTED mirror of the output, never the raw PTY bytes.
     */
    adopt: (id) => ipcRenderer.invoke("telar:terminal:adopt", { id }),
    /** Put those frames down. Does not stop the run — the engine owns it. */
    abandon: (id) => ipcRenderer.invoke("telar:terminal:abandon", { id }),
    onData: (listener) => on("telar:terminal:data", listener),
    onExit: (listener) => on("telar:terminal:exit", listener),
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
   * WHERE THIS INSTALL KEEPS ITS STORE, and moving it (#630).
   *
   * The shell's, not the engine's — the root is decided before the engine
   * exists and read once at launch, so a move reports `restartRequired` rather
   * than pretending it already took. `preflight` exists so a folder can be
   * refused with a reason while somebody is still choosing it, instead of after
   * they have committed to a copy.
   */
  store: {
    status: () => ipcRenderer.invoke("telar:store:status"),
    preflight: (path) => ipcRenderer.invoke("telar:store:preflight", { path }),
    move: (path) => ipcRenderer.invoke("telar:store:move", { path }),
    removeOld: () => ipcRenderer.invoke("telar:store:remove-old"),
    keepOld: () => ipcRenderer.invoke("telar:store:keep-old"),
    onProgress: (listener) => on("telar:store:progress", listener),
  },
  /**
   * Open a workspace folder in the system's own handler, or reveal it in the
   * file manager. The path is passed as an ARGUMENT the whole way down — see
   * the main-process handler; nothing is ever interpolated into a command.
   */
  workspace: {
    // `{ openers: [{ id, label, path, icon?, iconDataUrl? }], revealIconDataUrl? }`.
    // `iconDataUrl` is the app's OWN icon, read from its `.app` bundle by the
    // main process (#398); `icon` is the vendored vector mark the renderer
    // falls back to when macOS produced no bitmap. Both are optional and the
    // renderer handles either being absent — see components/session/opener-icon.tsx.
    openers: () => ipcRenderer.invoke("telar:workspace:openers"),
    open: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, ...(openerId ? { openerId } : {}) }),
    reveal: (path) => ipcRenderer.invoke("telar:workspace:open", { path, reveal: true }),
    // ONE FILE, not the checkout — the file tree's own Reveal and Open in
    // <app>. The SAME handler and the same two guards; `kind: "file"` is only
    // what lets its stat be a file. Named separately here rather than given an
    // options bag, so a caller cannot pass a folder the kind it is not.
    revealFile: (path) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", reveal: true }),
    openFile: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", ...(openerId ? { openerId } : {}) }),
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
    // The session menu's "Open in a new window". A PATH inside the app, never
    // a URL: the shell resolves it against the asking window's own address and
    // refuses anything that leaves that origin — see window-target.js.
    openWindow: (path) => ipcRenderer.invoke("telar:app:open-window", { path }),
  },
  /**
   * Settings → Remote access → Push notifications (#579). Writes the relay
   * credential into the login Keychain, which the cockpit's server reads on
   * every push and must never be able to write itself.
   *
   * Answers `{ ok: true }` or `{ ok: false, error }`. The error is a sentence
   * about what to do and never quotes what was pasted; the value goes to
   * `security` on stdin rather than into argv. See main.js and push-relay.js.
   */
  push: {
    provisionRelay: (config) => ipcRenderer.invoke("telar:push:provision-relay", config),
  },
  /**
   * WHAT THIS APP'S PROCESSES ARE DOING RIGHT NOW — issue #488.
   *
   * `app.getAppMetrics()` lives in the main process and nowhere else; the
   * cockpit's own server is a forked sibling and can no more reach it than any
   * other program on the machine. So a window inside the shell asks over this
   * bridge, and everything else (a phone, a second browser, the remote cockpit)
   * goes the long way round through `/api/desktop/metrics`.
   *
   * ONE SAMPLE FOR THE WHOLE SHELL. The main process throttles and shares it,
   * because `percentCPUUsage` averages over the gap since the last call to the
   * API rather than since the last call by this caller — two windows polling
   * freely must not become two windows stealing each other's baseline, nor the
   * runaway-renderer watchdog's. See `process-metrics.js`.
   */
  metrics: {
    read: () => ipcRenderer.invoke("telar:metrics:read"),
    /**
     * A RUNAWAY RENDERER WITHOUT THE USAGE PAGE OPEN — issue #787.
     *
     * PUSHED FROM THE WATCHDOG'S OWN DECISION, so the cockpit adds no timer and
     * no second caller of `app.getAppMetrics()` (which would be a correctness
     * problem, not a cost — see the note above). The shell speaks every thirty
     * seconds whether or not anything is wrong, because "nothing is hot" is what
     * takes an indicator back down.
     *
     * `runaway()` is the last thing it said, for a window that mounted between
     * polls — the same pairing as `updates.status()` beside `updates.onStatus`,
     * and for the same reason: a push alone loses the one state that matters to
     * a renderer that was not there to hear it.
     */
    runaway: () => ipcRenderer.invoke("telar:metrics:runaway"),
    onRunaway: (listener) => on("telar:metrics:runaway", listener),
  },
  updates: {
    check: () => ipcRenderer.invoke("telar:updates:check"),
    // ANSWERS WHAT IT DID WITH THE PRESS — `{ status: "restarting" }` for the
    // press that stages, the SAME for one that arrives while that is still
    // going (the shell refuses to stage twice, issue #389), `unsupported` for a
    // build that installs nothing, `error` for a stage that threw. The renderer
    // does not wait on it for the happy path: the process is quitting, and the
    // `restarting` broadcast has already arrived.
    install: () => ipcRenderer.invoke("telar:updates:install"),
    onStatus: (listener) => on("telar:updates:status", listener),
    // The last status the shell broadcast — how a renderer that mounted after
    // `update-downloaded` (or during the restart) still learns where the
    // updater got to.
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
  // Issue #367: the chords are the cockpit's to edit, and the shell's to mirror.
  // `set` is what makes the application menu rebuild its accelerators — the
  // blocker the old settings copy named. `get` is the recovery path for a
  // renderer whose own storage was cleared inside a shell that still remembers.
  keybindings: {
    get: () => ipcRenderer.invoke("telar:keybindings:get"),
    set: (overrides) => ipcRenderer.invoke("telar:keybindings:set", overrides),
    // While a row is recording, the menu drops its accelerators — macOS matches
    // a key equivalent before the page ever sees the keydown, so without this
    // the pane could not record any chord the menu already carries.
    capture: (capturing) => ipcRenderer.invoke("telar:keybindings:capture", capturing),
    // A surface on screen has claimed these chords (#656) — the menu drops the
    // accelerators that collide with them, for exactly as long as the claim
    // lasts. Same reason as `capture` above: macOS matches a key equivalent
    // before the page sees the keydown, so a palette that numbers its rows ⌘1..⌘9
    // could not answer any of them while the File menu carried those chords.
    scope: (chords) => ipcRenderer.invoke("telar:keybindings:scope", chords),
  },
});
