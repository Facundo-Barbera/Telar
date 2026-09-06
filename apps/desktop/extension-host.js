/**
 * THE OFFICIAL 1PASSWORD EXTENSION IN THE INTEGRATED BROWSER — the product
 * wiring over extension-compat.js.
 *
 *   · install: download the CRX from the Chrome Web Store update endpoint
 *     (Google only — every redirect host is checked), VERIFY it against the
 *     pinned store id (every signature proof, over Chromium's signed
 *     payload), unpack with the verified publisher key so the runtime id IS
 *     the store id, into <userData>/extensions/<id>/<version>/;
 *   · load: electron-chrome-extensions on the integrated partition
 *     (persistent, so the extension's storage persists), the origin-scoped
 *     main-world shims registered first, then `loadExtension` — every boot,
 *     as Electron requires;
 *   · popup: opened by the library anchored to the toolbar button's rect in
 *     the app window, for the ACTIVE integrated tab;
 *   · privacy: opening the popup BEGINS a private interaction (see
 *     private-interaction.js); the human ends it explicitly.
 *
 * Every failure is a sentence in `status()`, never a silent blank. No
 * message payloads are logged; the library's `debug` namespace is left off.
 */
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { app } = require("electron");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");

const ONE_PASSWORD = {
  id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  name: "1Password",
  updateUrl: (id) => `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`,
};

/** Worker lines that are noise in this host, not failures: Electron's
 *  missing webRequest bindings (shimmed) and a wasm loader deprecation. */
const KNOWN_NOISE = /No source for require\(webRequest|deprecated parameters for the initialization function|is not yet implemented\./;

/**
 * THE NATIVE HELPER IS APP-LEVEL, NOT PER-PROFILE. `1Password-BrowserSupport`
 * is the desktop app's browser helper; more than one can run at once (one per
 * connected partition), and each has its own lifetime. Reporting one process's
 * exit as everyone's disconnect — or "B is connected" because A spawned a
 * helper — would be a lie. So we track the SET of live helper PIDs: a spawn
 * adds one, that PID's own exit removes that one, and the reported state is
 * honestly "helper(s) available to this browser app" with a count. Whether a
 * given PROFILE is actually paired is read from the official extension UI, not
 * inferred here. Worker errors stay per profile.
 */
/**
 * Clamp `rect` to sit inside `region`, shrinking it if it is larger than the
 * region and then moving it so no edge spills out. Pure geometry — the popup
 * clamp and its test both use this. Returns a new rect; never negative size.
 */
function clampRect(rect, region) {
  const width = Math.max(0, Math.min(rect.width, region.width));
  const height = Math.max(0, Math.min(rect.height, region.height));
  const x = Math.min(Math.max(rect.x, region.x), region.x + region.width - width);
  const y = Math.min(Math.max(rect.y, region.y), region.y + region.height - height);
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
}

/** The region a popup may occupy: the parent window's content bounds
 *  intersected with the display work area the window is on. */
function popupRegion(parentWindow) {
  const { screen } = require("electron");
  const content = parentWindow.getContentBounds();
  const work = screen.getDisplayMatching(parentWindow.getBounds()).workArea;
  const x = Math.max(content.x, work.x);
  const y = Math.max(content.y, work.y);
  const right = Math.min(content.x + content.width, work.x + work.width);
  const bottom = Math.min(content.y + content.height, work.y + work.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Move/resize the popup window so it stays inside the parent window's
 *  content and the display work area. No-op when it already fits. */
function clampPopupWithin(popupWindow, parentWindow) {
  if (!popupWindow || popupWindow.isDestroyed() || !parentWindow || parentWindow.isDestroyed()) return;
  const current = popupWindow.getBounds();
  const clamped = clampRect(current, popupRegion(parentWindow));
  if (clamped.x !== current.x || clamped.y !== current.y || clamped.width !== current.width || clamped.height !== current.height) {
    popupWindow.setBounds(clamped);
  }
}

/**
 * The official 1Password toolbar icon, as a data URL, read from the VERIFIED
 * unpacked extension (its manifest's own `icons` map) — a safe narrow bridge:
 * only a path the manifest itself names, only inside the installed dir, only
 * a PNG. Null if anything is off; the UI then keeps its fallback glyph.
 */
function readIconDataUrl(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const icons = manifest.icons || {};
    const rel = icons["128"] || icons["48"] || icons["32"] || icons["16"];
    if (typeof rel !== "string" || !rel) return null;
    const resolved = path.resolve(dir, rel);
    const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!resolved.startsWith(root) || path.extname(resolved).toLowerCase() !== ".png") return null;
    const data = fs.readFileSync(resolved);
    if (data.length > 512 * 1024) return null; // an icon, not a payload
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Install is memoized per rootDir so concurrent partition hosts share one
 *  download.crx and staging dir instead of racing them. */
const installPromises = new Map(); // rootDir/<id> base → Promise<record>
const liveHelpers = new Map(); // pid → { startedAt }
let lastHelperExit = null; // { code, livedMs, hint } — the most recent immediate failure, for the hint
const healthListeners = new Set(); // ExtensionHost instances wanting native-change pushes
let nativeObserverInstalled = false;

/** App-level helper availability — never a per-profile "connected" claim. */
function nativeHealth() {
  if (liveHelpers.size > 0) return { state: "available", helpers: liveHelpers.size };
  if (lastHelperExit) return { state: "unavailable", helpers: 0, lastExitCode: lastHelperExit.code, ...(lastHelperExit.hint ? { hint: lastHelperExit.hint } : {}) };
  return { state: "not attempted", helpers: 0 };
}

function notifyNative() {
  for (const host of healthListeners) { try { host.onHealthChange?.(host.status()); } catch { /* a listener must not break the boundary */ } }
}

function installNativeObserver() {
  if (nativeObserverInstalled) return;
  nativeObserverInstalled = true;
  const cp = require("node:child_process");
  const realSpawn = cp.spawn;
  cp.spawn = function (file, args, opts) {
    const child = realSpawn.call(this, file, args, opts);
    if (/1Password-BrowserSupport$/.test(String(file)) && typeof child.pid === "number") {
      const pid = child.pid;
      const startedAt = Date.now();
      liveHelpers.set(pid, { startedAt });
      notifyNative();
      child.on("exit", (code) => {
        liveHelpers.delete(pid); // only THIS pid leaves; others stay
        const livedMs = Date.now() - startedAt;
        lastHelperExit = { code, livedMs, hint: code === 1 && livedMs < 2000 ? "A 1Password app browser helper exited immediately. This browser app may not be accepted yet — check that it is added under 1Password → Settings → Browser and that its code signature is one 1Password trusts." : undefined };
        notifyNative();
      });
      child.on("error", () => { liveHelpers.delete(pid); notifyNative(); });
    }
    return child;
  };
}

/**
 * WORKER ERRORS ARE CLASSIFIED, NEVER FORWARDED. The extension's console is
 * its own; a line there may carry anything. Only the fact of a known
 * startup failure crosses into status(), as a fixed code, and everything
 * else is counted. Truncation is not a boundary; a closed vocabulary is.
 */
const WORKER_ERROR_CLASSES = [
  { code: "null-window-at-boot", test: /Cannot read properties of null \(reading 'id'\)/ },
  { code: "native-messaging-stub", test: /native messaging host was disabled by the system administrator/ },
  { code: "desktop-app-not-connected", test: /\[AppIntegration\] \[DesktopApp\]|B5X is not connected to desktop app/ },
  { code: "core-not-initialized", test: /WASM is not initialized/ },
  { code: "no-receiver", test: /Receiving end does not exist/ },
];
function classifyWorkerError(message) {
  const text = String(message);
  const hit = WORKER_ERROR_CLASSES.find((entry) => entry.test.test(text));
  return hit ? hit.code : "other";
}

/** The CRX is ~18 MB today; anything past this is not the package we want. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;

/**
 * HTTPS only, Google hosts only (every redirect re-checked), a finite
 * timeout, a byte cap, and a partial file removed on any failure.
 */
function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    const fail = (error, request) => {
      try { request?.destroy(); } catch {}
      fs.rmSync(dest, { force: true });
      reject(error);
    };
    if (hops > 5) return fail(new Error("download: too many redirects"));
    let parsed;
    try { parsed = new URL(url); } catch { return fail(new Error("download: bad URL")); }
    if (parsed.protocol !== "https:") return fail(new Error(`download: refusing ${parsed.protocol} (HTTPS only)`));
    if (!/(^|\.)google(usercontent)?\.com$/.test(parsed.host)) return fail(new Error(`download: refusing host ${parsed.host}`));
    const request = https.get(url, { headers: { "user-agent": "telar-desktop" }, timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return download(next, dest, hops + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) { response.resume(); return fail(new Error(`download: HTTP ${response.statusCode}`), request); }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > MAX_DOWNLOAD_BYTES) { response.resume(); return fail(new Error(`download: ${declared} bytes exceeds the ${MAX_DOWNLOAD_BYTES} cap`), request); }
      let received = 0;
      const file = fs.createWriteStream(dest);
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) { file.destroy(); fail(new Error(`download: exceeded the ${MAX_DOWNLOAD_BYTES} byte cap`), request); }
      });
      response.on("error", (error) => fail(error, request));
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
      file.on("error", (error) => fail(error, request));
    });
    request.on("timeout", () => fail(new Error(`download: no response within ${DOWNLOAD_TIMEOUT_MS} ms`), request));
    request.on("error", (error) => fail(error, request));
  });
}

class ExtensionHost {
  /**
   * @param session the integrated browser's session (the persistent partition)
   * @param deps { privacy: PrivateInteraction, tabs: host tab callbacks for the
   *   library, rootDir?: where extensions live, fetch?: download override }
   */
  constructor(session, deps) {
    this.session = session;
    this.privacy = deps.privacy;
    this.tabs = deps.tabs;
    /** The app window, registered with the library BEFORE the extension
     *  loads so a zero-tab boot still has a current window. */
    this.window = deps.window || null;
    /** Human-only windows showing the extension's own pages. */
    this.extensionWindows = new Set();
    this.rootDir = deps.rootDir || path.join(app.getPath("userData"), "extensions");
    this.download = deps.download || download;
    this.extensions = null;
    this.loaded = null; // Electron.Extension
    this.error = null;
    this.phase = "idle"; // idle | installing | loading | ready | failed
    this.installedPath = null;
    this.verification = null;
    /**
     * HEALTH, observed not assumed. `ready` means loaded; whether the
     * extension actually works is read from its own worker's error lines
     * (uncaught errors, never payloads) and from the native host's lifecycle
     * (spawned? still alive? exited how?). The panel shows both.
     */
    // Worker errors are PER HOST (per partition). The native host's state is
    // a fact about the 1Password DESKTOP APP and this browser app's trust —
    // the same for every partition — so it lives in a module-level singleton
    // (sharedNative) rather than being captured by whichever host happened to
    // install the spawn observer first.
    this.health = { workerErrors: {} }; // { [code]: count }
    this.icon = null; // official 1Password icon data URL, set on ready
    this._startPromise = null;
    /**
     * Popup and extension-window lifetimes are tracked by identity. In the app,
     * the manager tracks visibility without pausing browser tools. A standalone
     * harness without callbacks falls back to its PrivateInteraction boundary.
     */
    this.onHoldOpen = null;
    this.onHoldClose = null;
    this.holdPrefix = require("node:crypto").randomBytes(4).toString("hex");
    this._holdSeq = 0;
  }

  /** Track an extension surface by id, or use the standalone harness boundary. */
  openHold(id, reason) {
    if (this.onHoldOpen) this.onHoldOpen(id, reason);
    else this.privacy.begin(reason, null);
  }

  /** Close one hold by id. With no manager the shared boundary has no
   *  per-id holds, so nothing to do — its own lifecycle ends it. */
  closeHold(id) {
    if (this.onHoldClose) this.onHoldClose(id);
  }

  /** Kick off start() once; repeated calls return the same promise. */
  startOnce() {
    if (!this._startPromise) this._startPromise = this.start();
    return this._startPromise;
  }

  /** Resolves when start() has SETTLED — ready or failed. A caller (the tab
   *  wake path) awaits this before the first navigation so content scripts
   *  are registered; a failed host resolves too, so it never blocks a page. */
  async whenReady() {
    if (this._startPromise) { try { await this._startPromise; } catch { /* settled either way */ } }
    return this.status();
  }

  status() {
    return {
      id: ONE_PASSWORD.id,
      name: ONE_PASSWORD.name,
      phase: this.phase,
      ...(this.loaded ? { version: this.loaded.version, runtimeId: this.loaded.id } : {}),
      ...(this.verification ? { verifiedId: this.verification.id, proofs: this.verification.proofs } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.icon ? { icon: this.icon } : {}),
      health: { workerErrors: { ...this.health.workerErrors }, native: nativeHealth() },
      privacy: this.privacy.state(),
    };
  }

  /** Watch the extension's own worker for uncaught errors, and the native
   *  host process for whether it stays alive. Worker text is classified
   *  into fixed codes and counted; no message string leaves this method. */
  observeHealth() {
    // Per-partition worker errors: this session's own worker only.
    this.session.serviceWorkers.on("console-message", (_event, details) => {
      if (details.level < 2) return;
      if (!String(details.sourceId || "").startsWith(`chrome-extension://${ONE_PASSWORD.id}/`)) return;
      if (KNOWN_NOISE.test(String(details.message))) return;
      this.noteWorkerError(details.message);
    });
    // Register for shared native-host notifications, and install the ONE
    // global spawn observer (idempotent). Whichever host installs it, ALL
    // registered hosts hear the result — the native state is global.
    healthListeners.add(this);
    installNativeObserver();
  }

  /**
   * The verified unpacked directory for the pinned id, installing if absent.
   * CONCURRENT HOSTS SHARE ONE INSTALL: every partition's host installs from
   * and into the SAME rootDir, so two hosts booting at once would race the
   * one `download.crx` and staging dir. The download+verify+place is memoized
   * per rootDir (module-level `installPromises`); the first host does the
   * work, the rest await its result and read the same marker.
   */
  async ensureInstalled() {
    const base = path.join(this.rootDir, ONE_PASSWORD.id);
    const cached = this.readInstalledMarker(base);
    if (cached) { this.verification = { id: cached.id, proofs: cached.proofs }; return cached.dir; }
    this.phase = "installing";
    let promise = installPromises.get(base);
    if (!promise) {
      promise = this.performInstall(base).finally(() => installPromises.delete(base));
      installPromises.set(base, promise);
    }
    const result = await promise;
    this.verification = { id: result.id, proofs: result.proofs };
    return result.dir;
  }

  /** The cached install if the marker is valid, else null. */
  readInstalledMarker(base) {
    const marker = path.join(base, "installed.json");
    if (!fs.existsSync(marker)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (record.id === ONE_PASSWORD.id && record.dir && fs.existsSync(path.join(record.dir, "manifest.json"))) return record;
    } catch {
      // Corrupt marker: reinstall.
    }
    return null;
  }

  /** Download, verify, place, and write the marker. Runs at most once per
   *  rootDir across concurrent hosts (see ensureInstalled). */
  async performInstall(base) {
    fs.mkdirSync(base, { recursive: true });
    const cached = this.readInstalledMarker(base);
    if (cached) return cached;
    const crx = path.join(base, "download.crx");
    const staging = path.join(base, `unpacked-${Date.now()}`);
    let result;
    try {
      await this.download(ONE_PASSWORD.updateUrl(ONE_PASSWORD.id), crx);
      result = unpackVerified(crx, staging, ONE_PASSWORD.id);
    } catch (error) {
      fs.rmSync(crx, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(`${staging}.zip`, { force: true });
      throw error;
    }
    const dir = path.join(base, result.manifest.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    fs.rmSync(crx, { force: true });
    fs.rmSync(`${staging}.zip`, { force: true });
    const record = { id: result.id, version: result.manifest.version, proofs: result.proofs, dir, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(base, "installed.json"), JSON.stringify(record, null, 2));
    return record;
  }

  async start() {
    try {
      const dir = await this.ensureInstalled();
      this.phase = "loading";
      registerShimPreload(this.session, this.rootDir, [ONE_PASSWORD.id]);
      this.extensions = attachExtensionSupport(this.session, this.tabs, { preloadDir: this.rootDir, window: this.window });
      this.observeHealth();
      this.loaded = await this.session.extensions.loadExtension(dir, { allowFileAccess: false });
      if (this.loaded.id !== ONE_PASSWORD.id) {
        throw new Error(`loaded extension id ${this.loaded.id} does not match the pinned ${ONE_PASSWORD.id}`);
      }
      this.installedPath = dir;
      this.icon = readIconDataUrl(dir);
      this.phase = "ready";
      this.error = null;
    } catch (error) {
      this.phase = "failed";
      this.error = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  /**
   * Open the toolbar popup for the given tab, anchored to `anchorRect`
   * (window-relative, from the renderer's button). Begins a private
   * interaction FIRST, so no agent tool can observe the popup or the page.
   */
  async openPopup(window, tabWebContents, anchorRect, scopeKey) {
    if (this.phase !== "ready" || !this.extensions) throw new Error(this.error || "The 1Password extension is not ready.");
    // A UNIQUE hold id PER INVOCATION: a shared ":popup" id would let the old
    // popup's close event release the NEW popup's hold on a rapid re-open.
    const popupHold = `${this.holdPrefix}:popup:${(this._holdSeq += 1)}`;
    this.openHold(popupHold, "1Password");
    let created;
    try {
      // The library resolves the popup for the active tab of the current window.
      this.extensions.selectTab(tabWebContents);
      // The library's handler only acts for an event whose `type` is "frame"
      // (its own toolbar UI's IPC); any other type returns silently with no
      // popup — which is exactly what the first signed test saw. `sender` is
      // only logged.
      created = this.extensions.api.browserAction.activate(
        { type: "frame", sender: null, extension: this.loaded },
        // NO "right" alignment. The library's default anchors the popup's RIGHT
        // edge to the button and extends it LEFT — inward, into the window.
        // Passing "right" would put the popup's LEFT edge at the button and
        // extend it RIGHT, off the window's right edge (the overflow bug).
        { eventType: "click", extensionId: ONE_PASSWORD.id, tabId: tabWebContents.id, anchorRect: { x: Math.round(anchorRect.x), y: Math.round(anchorRect.y), width: Math.round(anchorRect.width), height: Math.round(anchorRect.height) } },
      );
      await created;
    } catch (error) {
      // Activation failed: never leave the hold dangling.
      this.closeHold(popupHold);
      throw error;
    }
    // 1Password sets NO popup URL until it is connected to the desktop app
    // (action.popup stays ""); the click then dispatches onClicked and the
    // extension opens its welcome/pairing page in a NEW TAB instead. Both
    // are real outcomes; report which one happened rather than "opened".
    const popup = this.extensions.api.browserAction.popup;
    const popupWindow = popup && popup.browserWindow && !popup.browserWindow.isDestroyed() ? popup.browserWindow : null;
    if (popupWindow) {
      // The library never clamps to the screen or the window. Keep the popup
      // inside the app window's content AND the display work area, resizing it
      // down if need be — on first placement and after every reposition/resize
      // (1Password resizes the popup to its preferred size after load).
      const clamp = () => { try { clampPopupWithin(popupWindow, window); } catch { /* window gone mid-clamp */ } };
      // PopupView emits moved/resized; it does NOT emit "closed" (its destroy()
      // force-destroys the BrowserWindow without re-emitting). So the hold is
      // released on the CAPTURED BrowserWindow's own `closed`, before the
      // library nulls its reference — dismiss, re-click, and blur all reach it.
      popup.on("moved", clamp);
      popup.on("resized", clamp);
      clamp();
      popupWindow.once("closed", () => this.closeHold(popupHold));
    } else {
      // No popup window (1Password opened its page in a window instead): the
      // popup hold has nothing to track, so release it — the extension-window
      // and credential holds cover the rest.
      this.closeHold(popupHold);
    }
    const popupUrl = this.extensions.api.browserAction.getPopupUrl(ONE_PASSWORD.id, tabWebContents.id);
    return { ...this.status(), popup: popup && !popup.isDestroyed() ? "open" : popupUrl ? "closed" : "none-configured (the extension opened its page in a tab instead)" };
  }

  /** Count one worker error under its fixed classification. */
  noteWorkerError(message) {
    const code = classifyWorkerError(message);
    this.health.workerErrors[code] = (this.health.workerErrors[code] || 0) + 1;
    this.onHealthChange?.(this.status());
  }

  /**
   * THE EXTENSION'S OWN PAGES — its welcome/pairing/settings pages, opened
   * by chrome.tabs.create with a chrome-extension:// URL — live in a
   * separate HUMAN-ONLY window, never in the integrated browser's tab list:
   * browser tools cannot address a tab that is not a manager tab, and the
   * manager's URL policy (http/https only) is untouched. The window is
   * parented to the app window, tracked with the library as a tab (so
   * chrome.tabs/runtime messaging work), and opening it begins a private
   * interaction; it stays private until the human resumes.
   */
  openExtensionPage(url, parent) {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:" || parsed.host !== ONE_PASSWORD.id) throw new Error("Only the pinned extension's own pages open here.");
    const holdId = `${this.holdPrefix}:extwin:${(this._holdSeq += 1)}`;
    this.openHold(holdId, "1Password");
    const { BrowserWindow } = require("electron");
    const win = new BrowserWindow({
      width: 960, height: 720, parent, show: false, title: ONE_PASSWORD.name, autoHideMenuBar: true,
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.once("ready-to-show", () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Leaving the extension's origin is not what this window is for: an
    // external link goes to the default browser, nothing else navigates.
    win.webContents.on("will-navigate", (event, target) => {
      let next; try { next = new URL(target); } catch { event.preventDefault(); return; }
      if (next.protocol === "chrome-extension:" && next.host === ONE_PASSWORD.id) return;
      event.preventDefault();
      if (next.protocol === "https:" || next.protocol === "http:") require("electron").shell.openExternal(target).catch(() => undefined);
    });
    this.extensionWindows.add(win);
    win.on("closed", () => { this.extensionWindows.delete(win); this.closeHold(holdId); });
    win.loadURL(url).catch(() => undefined);
    return win;
  }

  /** Track/untrack the integrated tabs so chrome.tabs sees them. */
  addTab(webContents, window) {
    if (this.extensions) this.extensions.addTab(webContents, window);
  }
  removeTab(webContents) {
    if (this.extensions) {
      try {
        this.extensions.removeTab(webContents);
      } catch {
        // Already gone.
      }
    }
  }
  selectTab(webContents) {
    if (this.extensions) this.extensions.selectTab(webContents);
  }
}

module.exports = { ExtensionHost, ONE_PASSWORD, download, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS, classifyWorkerError, WORKER_ERROR_CLASSES, clampRect, popupRegion, readIconDataUrl };
