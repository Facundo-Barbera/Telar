const path = require("node:path");
const { BrowserWindow, nativeTheme } = require("electron");
const { createExternalLinkPolicy } = require("../browser/browser-manager");
const { macWindowChrome } = require("./window-chrome");
const { backdropWindowOptions } = require("./window-material");
const { watchWindowVisibility } = require("./window-visibility");
const { seatHostCookie, seatHostHeader } = require("./ui-server");
const { developmentIconPath, windowTitle } = require("./bundle-paths");
const { watchForUnpairing } = require("./shell-log");
const { readUiPrefs, supportsTranslucency } = require("./appearance");
const { buildApplicationMenu, chords, setBrowserChordScope } = require("./app-menu");
const { applyExternalLinkPolicy, linkRouting } = require("./window-links");
const { addHost, rememberWindowUrl, removeHost } = require("./browser-hosts");

function cockpitWindowOptions(title) {
  const icon = developmentIconPath();
  return {
    width: 1280,
    height: 800,
    ...backdropWindowOptions({ ...readUiPrefs(), dark: nativeTheme.shouldUseDarkColors, supported: supportsTranslucency() }),
    show: false,
    title,
    ...macWindowChrome(),
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "preload", "preload.js"),

      plugins: true,

      backgroundThrottling: false,
    },
  };
}

function onCockpitReload(win, manager) {
  manager.hideVisibleScope();

  linkRouting.set(win.webContents, false);

  if (!chords.scopes.empty || chords.capturing) {
    chords.scopes.setRenderer([]);
    chords.capturing = false;
    buildApplicationMenu();
  }
}

function retryFailedLoads(win, url) {
  let retryTimer = null;
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || win.isDestroyed()) return;
    console.error(`[telar-desktop] load failed (${errorCode} ${errorDescription}): ${failedUrl} — retrying`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(url);
    }, 1_000);
  });
  win.on("closed", () => clearTimeout(retryTimer));
}

function createCockpitWindow(url, { createManager, onInPageNavigation }) {
  const title = windowTitle();
  rememberWindowUrl(url);

  const win = new BrowserWindow(cockpitWindowOptions(title));
  watchWindowVisibility(win);

  const manager = createManager(win, { onChordScope: (owned) => setBrowserChordScope(manager, owned) });
  addHost(win, manager);

  applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }));
  win.webContents.on("did-start-loading", () => onCockpitReload(win, manager));
  win.webContents.on("did-navigate-in-page", () => onInPageNavigation());
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;

    for (const [partition, host] of manager.extensionHosts) win.webContents.send("telar:browser:extension", { partition, ...host.status() });
  });
  win.on("closed", () => {
    manager.destroy();
    removeHost(manager);

    if (chords.scopes.forget(manager)) buildApplicationMenu();
  });

  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(title);
  });

  watchForUnpairing(win.webContents);
  retryFailedLoads(win, url);

  win.once("ready-to-show", () => win.show());
  win.setTitle(title);

  seatHostHeader(url);
  seatHostCookie(url).finally(() => {
    if (!win.isDestroyed()) win.loadURL(url);
  });
  return win;
}

module.exports = { createCockpitWindow };
