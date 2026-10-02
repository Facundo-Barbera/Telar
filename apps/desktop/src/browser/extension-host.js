const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { attachExtensionSupport, registerShimPreload, unpackVerified } = require("./extension-compat");

function userDataDir() {
  return require("electron").app.getPath("userData");
}

const ONE_PASSWORD = {
  id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  name: "1Password",
  appPath: "/Applications/1Password.app",
  updateUrl: (id) => `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`,
};

const KNOWN_NOISE = /No source for require\(webRequest|deprecated parameters for the initialization function|is not yet implemented\./;

function clampRect(rect, region) {
  const width = Math.max(0, Math.min(rect.width, region.width));
  const height = Math.max(0, Math.min(rect.height, region.height));
  const x = Math.min(Math.max(rect.x, region.x), region.x + region.width - width);
  const y = Math.min(Math.max(rect.y, region.y), region.y + region.height - height);
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
}

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

function clampPopupWithin(popupWindow, parentWindow) {
  if (!popupWindow || popupWindow.isDestroyed() || !parentWindow || parentWindow.isDestroyed()) return;
  const current = popupWindow.getBounds();
  const clamped = clampRect(current, popupRegion(parentWindow));
  if (clamped.x !== current.x || clamped.y !== current.y || clamped.width !== current.width || clamped.height !== current.height) {
    popupWindow.setBounds(clamped);
  }
}

const POPUP_CORNER_RADIUS = 10;
const POPUP_CORNER_CSS = `html,body{border-radius:${POPUP_CORNER_RADIUS}px;overflow:hidden;}`;

function roundPopupCorners(popupWindow) {
  try {
    popupWindow.setBackgroundColor("#00000000");
  } catch {
  }
  const contents = popupWindow.webContents;
  const apply = () => {
    if (popupWindow.isDestroyed()) return;
    contents.insertCSS(POPUP_CORNER_CSS).catch(() => undefined);
  };
  contents.on("did-finish-load", apply);
  apply();
}

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
    if (data.length > 512 * 1024) return null;
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

const installPromises = new Map();
const liveHelpers = new Map();
let lastHelperExit = null;
const healthListeners = new Set();
let nativeObserverInstalled = false;

function nativeHealth() {
  if (liveHelpers.size > 0) return { state: "available", helpers: liveHelpers.size };
  if (lastHelperExit) return { state: "unavailable", helpers: 0, lastExitCode: lastHelperExit.code };
  return { state: "not attempted", helpers: 0 };
}

function notifyNative() {
  for (const host of healthListeners) { try { host.onHealthChange?.(host.status()); } catch {  } }
}

function installNativeObserver() {
  if (nativeObserverInstalled) return;
  nativeObserverInstalled = true;
  const cp = require("node:child_process");
  const realSpawn = cp.spawn;
  cp.spawn = function (file, args, opts) {
    const child = realSpawn.call(this, file, args, opts);
    if (String(file).endsWith('1Password-BrowserSupport') && typeof child.pid === "number") {
      const pid = child.pid;
      const startedAt = Date.now();
      liveHelpers.set(pid, { startedAt });
      notifyNative();
      child.on("exit", (code) => {
        liveHelpers.delete(pid);
        const livedMs = Date.now() - startedAt;
        lastHelperExit = { code, livedMs };
        notifyNative();
      });
      child.on("error", () => { liveHelpers.delete(pid); notifyNative(); });
    }
    return child;
  };
}

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

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;

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
  constructor(session, deps) {
    this.session = session;
    this.tabs = deps.tabs;

    this.window = deps.window || null;

    this.extensionWindows = new Set();
    this.rootDir = deps.rootDir || path.join(userDataDir(), "extensions");
    this.download = deps.download || download;
    this.extensions = null;
    this.loaded = null;
    this.error = null;
    this.phase = "idle";
    this.installedPath = null;
    this.verification = null;

    this.health = { workerErrors: {} };
    this.icon = null;
    this._startPromise = null;

    this.onHoldOpen = null;
    this.onHoldClose = null;

    this.onWorkerConsole = null;
    this.holdPrefix = require("node:crypto").randomBytes(4).toString("hex");
    this._holdSeq = 0;
  }

  openHold(id, reason) {
    if (this.onHoldOpen) this.onHoldOpen(id, reason);
  }

  closeHold(id) {
    if (this.onHoldClose) this.onHoldClose(id);
  }

  startOnce() {
    if (!this._startPromise) this._startPromise = this.start();
    return this._startPromise;
  }

  async whenReady() {
    if (this._startPromise) { try { await this._startPromise; } catch {  } }
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
    };
  }

  observeHealth() {
    this.onWorkerConsole = (_event, details) => {
      if (details.level < 2) return;
      if (!String(details.sourceId || "").startsWith(`chrome-extension://${ONE_PASSWORD.id}/`)) return;
      if (KNOWN_NOISE.test(String(details.message))) return;
      this.noteWorkerError(details.message);
    };
    this.session.serviceWorkers.on("console-message", this.onWorkerConsole);

    // global spawn observer (idempotent). Whichever host installs it, ALL

    healthListeners.add(this);
    installNativeObserver();
  }

  dispose() {
    if (this.onWorkerConsole) {
      try {
        this.session.serviceWorkers.off("console-message", this.onWorkerConsole);
      } catch {
      }
      this.onWorkerConsole = null;
    }
    healthListeners.delete(this);
  }

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

  readInstalledMarker(base) {
    const marker = path.join(base, "installed.json");
    if (!fs.existsSync(marker)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (record.id === ONE_PASSWORD.id && record.dir && fs.existsSync(path.join(record.dir, "manifest.json"))) return record;
    } catch {
    }
    return null;
  }

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

  async openPopup(window, tabWebContents, anchorRect) {
    if (this.phase !== "ready" || !this.extensions) throw new Error(this.error || "The 1Password extension is not ready.");

    const popupHold = `${this.holdPrefix}:popup:${(this._holdSeq += 1)}`;
    this.openHold(popupHold, "1Password");
    let created;
    try {
      this.extensions.selectTab(tabWebContents);

      created = this.extensions.api.browserAction.activate(
        { type: "frame", sender: null, extension: this.loaded },

        { eventType: "click", extensionId: ONE_PASSWORD.id, tabId: tabWebContents.id, anchorRect: { x: Math.round(anchorRect.x), y: Math.round(anchorRect.y), width: Math.round(anchorRect.width), height: Math.round(anchorRect.height) } },
      );
      await created;
    } catch (error) {
      this.closeHold(popupHold);
      throw error;
    }

    const popup = this.extensions.api.browserAction.popup;
    const popupWindow = popup && popup.browserWindow && !popup.browserWindow.isDestroyed() ? popup.browserWindow : null;
    if (popupWindow) {
      const clamp = () => { try { clampPopupWithin(popupWindow, window); } catch {  } };

      popup.on("moved", clamp);
      popup.on("resized", clamp);
      clamp();

      try { roundPopupCorners(popupWindow); } catch {  }
      popupWindow.once("closed", () => this.closeHold(popupHold));
    } else {
      this.closeHold(popupHold);
    }
    const popupUrl = this.extensions.api.browserAction.getPopupUrl(ONE_PASSWORD.id, tabWebContents.id);
    return { ...this.status(), popup: popup && !popup.isDestroyed() ? "open" : popupUrl ? "closed" : "none-configured (the extension opened its page in a tab instead)" };
  }

  noteWorkerError(message) {
    const code = classifyWorkerError(message);
    this.health.workerErrors[code] = (this.health.workerErrors[code] || 0) + 1;
    this.onHealthChange?.(this.status());
  }

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

  addTab(webContents, window) {
    if (this.extensions) this.extensions.addTab(webContents, window);
  }
  removeTab(webContents) {
    if (this.extensions) {
      try {
        this.extensions.removeTab(webContents);
      } catch {
      }
    }
  }
  selectTab(webContents) {
    if (this.extensions) this.extensions.selectTab(webContents);
  }
}

function extensionsEnabled({ dev, packaged, version, override }) {
  if (override === "0") return false;
  return override === "1" || dev || !packaged || /^\d+\.\d+\.\d+-nightly\./.test(version);
}

module.exports = { extensionsEnabled, ExtensionHost, ONE_PASSWORD, download, MAX_DOWNLOAD_BYTES, classifyWorkerError, clampRect, popupRegion, readIconDataUrl, roundPopupCorners, POPUP_CORNER_RADIUS };
