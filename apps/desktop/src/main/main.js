const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { app, BrowserWindow, dialog, nativeTheme, Notification, powerMonitor, shell } = require("electron");
const { DesktopBrowserManager, managerForScope, createExternalLinkPolicy } = require("../browser/browser-manager");
const { createLinkRouting } = require("./link-routing");
const { startBrowserControlServer } = require("../browser/browser-control-server");
const { startRunTerminalServer } = require("../terminal/run-terminal-server");
const { publishTailscaleServe, serveEnv, unpublishTailscaleServe } = require("./tailscale");
const { macWindowChrome } = require("./window-chrome");
const { backdropWindowOptions } = require("./window-material");
const { windowTargetUrl } = require("./window-target");
const { watchWindowVisibility } = require("./window-visibility");
const { ACTIVE_IDLE_SECONDS, createDesktopNotifier, createPresenceReporter, routeOf } = require("./desktop-notifications");
const { watchVolumes } = require("./volume-watch");
const { awaitStore } = require("../store/store-gate");
const { createStoreGateWindow } = require("../store/store-gate-window");
const { createBrowserSuggestions } = require("../browser/browser-suggestions");
const { readProfileRegistry } = require("../browser/browser-profiles");
const { createTabStore } = require("../browser/browser-tab-store");
const { createSitePermissionStore } = require("../browser/site-permissions");
const { bundledHelperDaemon, stopHelperDaemon } = require("./computer-use-stop");
const desktopHandoff = require("../handoff/desktop-handoff");
const { wireLoginOffer } = require("../login/login-offer-window");
const uiServer = require("./ui-server");
const { findFreePort, getStablePort, seatHostCookie, seatHostHeader, waitForServer } = uiServer;
const engineNotices = require("./engine-notices").createEngineNotices({ onMessage: (message) => desktopNotifier.handleServerMessage(message) });
const { DEV_BUILD, E2E_USER_DATA, OVERRIDE_URL, SMOKE } = require("./flags");
const { applyDevelopmentAppIcon, bundledAgentSdkEntry, bundledPlaywrightMcpCli, computerUseHelperPath, developmentIconPath, nodeExecPath, windowTitle } = require("./bundle-paths");
const { captureLoginShellEnv } = require("./login-shell-env");
const { findVolumeMount } = require("./volumes");
const { logShell, shellLogPath, startHeapLog, watchForUnpairing } = require("./shell-log");
const { processMetricsReader, startServiceWorkerWatchdog } = require("./renderer-watch");
const { engineDiscoveryFile, markMainWindowShown, postToEngine, rememberEngine, reportStartupFailure, startEngineChild, stopEngineChild, waitForEngine } = require("./engine-child");
const { readUiPrefs, supportsTranslucency, watchSchemeForVibrancy } = require("./appearance");
const { buildApplicationMenu, chords, setBrowserChordScope } = require("./app-menu");
const { startExtensionHost } = require("./cockpit-extensions");
const { adoptLegacyUpdatePrefs } = require("./update-prefs");


if (E2E_USER_DATA) {
  app.setPath("userData", E2E_USER_DATA);
} else if (SMOKE) {
  app.setPath(
    "userData",
    fs.mkdtempSync(path.join(os.tmpdir(), "telar-electron-smoke-")),
  );
} else if (DEV_BUILD) {
  app.setPath("userData", path.join(app.getPath("appData"), "Telar Dev"));
} else if (!app.isPackaged) {
  app.setName("Telar (dev)");
  app.setPath("userData", path.join(app.getPath("appData"), "Telar (dev)"));
}

let browserManager = null;
const browserManagers = new Set();
let browserSuggestions;
function requireBrowserSuggestions() {
  return browserSuggestions ||= createBrowserSuggestions(app.getPath("userData"));
}
let browserControl = null;
let browserControlConfig = null;

let runTerminalChannel = null;
let runTerminalConfig = null;
const REMOTE_DEBUGGING_PORT = process.env.TELAR_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
if (REMOTE_DEBUGGING_PORT && /^\d+$/.test(REMOTE_DEBUGGING_PORT)) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);

  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

let smokeHome = null;

let resolvedStoreHome = null;
function telarHome() {
  if (SMOKE) {
    smokeHome ??= fs.mkdtempSync(path.join(os.tmpdir(), "telar-smoke-"));
    return smokeHome;
  }
  if (resolvedStoreHome) return resolvedStoreHome;

  if (DEV_BUILD) return app.getPath("userData");
  return process.env.TELAR_HOME?.trim() || app.getPath("userData");
}

let storeGate = null;
async function openStoreGate() {
  const explicit = DEV_BUILD ? "" : process.env.TELAR_HOME?.trim();
  if (explicit) return explicit;
  storeGate = createStoreGateWindow();

  const watcher = watchVolumes({ onChanged: () => storeGate.volumesChanged(), powerMonitor });
  try {
    const settled = await awaitStore(
      { userData: app.getPath("userData"), defaultRoot: app.getPath("userData") },
      { present: (outcome) => storeGate.present(outcome), findVolumeMount },
    );
    return settled.quit ? null : settled.root;
  } finally {
    watcher.stop();
    storeGate.close();
    storeGate = null;
  }
}

function wireShellDiagnostics() {
  app.on("child-process-gone", (_event, details) => {
    logShell(
      "warn",
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.serviceName ?? ""}`,
    );

    if (lastWindowUrl) void seatHostCookie(lastWindowUrl);
  });
}

function childEnv(home) {
  const computerUseHelper = computerUseHelperPath();
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    TELAR_HOME: home,
    ...(computerUseHelper ? { TELAR_COMPUTER_USE_HELPER: computerUseHelper } : {}),
    ...(browserControlConfig
      ? {
          TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(browserControlConfig.port),
          TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: browserControlConfig.token,
        }
      : {}),

    ...(runTerminalConfig
      ? {
          TELAR_DESKTOP_RUN_TERMINAL_PORT: String(runTerminalConfig.port),
          TELAR_DESKTOP_RUN_TERMINAL_TOKEN: runTerminalConfig.token,
        }
      : {}),
  };
}

function startServer(port, home) {
  const child = uiServer.startServer(port, home, {
    execPath: nodeExecPath(),
    env: {
      ...childEnv(home),
      TELAR_PROCESS_TITLE: DEV_BUILD ? "telar-ui-dev" : "telar-ui",
      ...serveEnv(),
    },
    onExit: (code, signal) => {
      presenceReporter.stop();
      if (!SMOKE && !app.isQuitting) {
        console.error(`[telar-desktop] server exited (code=${code} signal=${signal})`);
        app.quit();
      }
    },
  });
  engineNotices.start(engineDiscoveryFile(home));
  watchPresence();
  return child;
}

function cockpitFocus() {
  const focused = BrowserWindow.getFocusedWindow();
  const cockpit = focused && [...browserManagers].some((manager) => manager.window === focused);
  return { focused: Boolean(cockpit), viewingPath: cockpit ? routeOf(focused.webContents.getURL()) : null };
}
const desktopNotifier = createDesktopNotifier({ Notification, send: engineNotices.send, context: cockpitFocus, open: openNotificationPath });

let screenLocked = false;
const presenceReporter = createPresenceReporter({
  sample: () => ({ idleState: powerMonitor.getSystemIdleState(ACTIVE_IDLE_SECONDS), locked: screenLocked, ...cockpitFocus() }),
  send: engineNotices.send,
});
let presenceWatched = false;
function watchPresence() {
  if (!presenceWatched) {
    presenceWatched = true;
    const report = () => presenceReporter.report();
    powerMonitor.on("lock-screen", () => { screenLocked = true; report(); });
    powerMonitor.on("unlock-screen", () => { screenLocked = false; report(); });
    app.on("browser-window-focus", report);
    app.on("browser-window-blur", report);
  }
  presenceReporter.start();
}

function openNotificationPath(route) {
  const win = [browserManager, ...browserManagers].map((manager) => manager?.window).find((w) => w && !w.isDestroyed());
  if (!win) {
    const target = windowTargetUrl(lastWindowUrl, route);
    if (target) createWindow(target);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("telar:notifications:open", route);
}

function openInSystemBrowser(url) {
  shell.openExternal(url).catch((err) => {
    console.error("[telar-desktop] failed to open externally:", url, err?.message || err);
  });
}

const linkRouting = createLinkRouting();

function actOnLinkDecision(decision, webContents) {
  if (decision.openExternal) linkRouting.handOff(webContents, decision.openExternal, openInSystemBrowser);

  else if (decision.duplicateOf) {
    console.log("[telar-desktop] suppressed duplicate external open:", decision.duplicateOf);
  }
}

function applyExternalLinkPolicy(webContents, createPolicy) {
  const policy = createPolicy();
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = policy.decide(url);
    actOnLinkDecision(decision, webContents);
    return decision.action === "allow" ? { action: "allow" } : { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    const decision = policy.decide(url);
    if (decision.action === "allow") return;
    event.preventDefault();
    actOnLinkDecision(decision, webContents);
  });

  webContents.on("did-create-window", (childWindow) => {
    applyExternalLinkPolicy(childWindow.webContents, createPolicy);
  });
}

function createWindow(url) {
  const title = windowTitle();
  const icon = developmentIconPath();
  lastWindowUrl = url;

  const win = new BrowserWindow({
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
  });

  watchWindowVisibility(win);

  const profiles = readProfileRegistry(app.getPath("userData"));
  const manager = new DesktopBrowserManager(win, {
    onControlChanged: reportBrowserControl,

    onLoginEntryFinished: (capture) => requireLoginOffer().entryFinished(capture),

    onVisited: (scopeKey, url) => requireBrowserSuggestions().remember(manager.activeProfile(scopeKey)?.id, url),
    profiles,

    onProfileMigrated: (from, to) => requireBrowserSuggestions().adopt(from, to),

    tabStore: createTabStore(app.getPath("userData")),

    sitePermissions: createSitePermissionStore(app.getPath("userData")),

    createExtensionHost: (partition) => startExtensionHost(win, manager, partition),

    onChordScope: (chords) => setBrowserChordScope(manager, chords),
  });
  browserManagers.add(manager);
  browserManager = manager;

  win.on("focus", () => {
    browserManager = manager;
  });

  applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }));

  win.webContents.on("did-start-loading", () => {
    manager.hideVisibleScope();

    linkRouting.set(win.webContents, false);

    if (!chords.scopes.empty || chords.capturing) {
      chords.scopes.setRenderer([]);
      chords.capturing = false;
      buildApplicationMenu();
    }
  });

  win.webContents.on("did-navigate-in-page", () => presenceReporter.report());
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;

    for (const [partition, host] of manager.extensionHosts) win.webContents.send("telar:browser:extension", { partition, ...host.status() });
  });
  win.on("closed", () => {
    manager.destroy();
    browserManagers.delete(manager);

    if (chords.scopes.forget(manager)) buildApplicationMenu();

    if (browserManager === manager) browserManager = browserManagers.values().next().value ?? null;
  });

  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(title);
  });

  watchForUnpairing(win.webContents);

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

  win.once("ready-to-show", () => win.show());
  win.setTitle(title);

  seatHostHeader(url);
  seatHostCookie(url).finally(() => {
    if (!win.isDestroyed()) win.loadURL(url);
  });
  return win;
}

function managerForEvent(event) {
  const sender = event?.sender;
  if (!sender) return null;
  for (const manager of browserManagers) {
    if (!manager.window.isDestroyed() && manager.window.webContents === sender) return manager;
  }
  return null;
}

function requireCockpitSender(event, what) {
  const manager = requireBrowserManager(event);
  const cockpit = manager.window;
  if (!cockpit || cockpit.isDestroyed() || event.sender !== cockpit.webContents || event.senderFrame !== cockpit.webContents.mainFrame) {
    throw new Error(`Only the Telar window may ${what}.`);
  }
  return manager;
}

function requireBrowserManager(event) {
  const manager = managerForEvent(event) || browserManager;
  if (!manager) throw new Error("The Telar desktop browser host is not ready.");
  return manager;
}

let loginOffer = null;
function requireLoginOffer() {
  loginOffer ??= wireLoginOffer({ stateRoot: path.join(telarHome(), "engine") });
  return loginOffer;
}

function reportBrowserControl(change) {
  postToEngine(`/v2/sessions/${encodeURIComponent(change.scopeKey)}/browser/control`, {
    controller: change.controller,
    ...(change.tabId ? { tabId: change.tabId } : {}),
    ...(change.interrupted ? { interrupted: true } : {}),
  });
}

function reportVolumesChanged() {
  postToEngine("/v2/projects/reprobe");
}

let terminalHost = null;

const { TerminalOwner } = require("../terminal/terminal-host");

const terminalReaders = new Map();

function deliverToTerminalReader(id, channel, payload) {
  const reader = terminalReaders.get(id);
  if (!reader || reader.isDestroyed()) return;
  reader.send(channel, payload);
}

function requireTerminalHost() {
  if (terminalHost) return terminalHost;
  const { TerminalHost } = require("../terminal/terminal-host");
  terminalHost = new TerminalHost({
    version: app.getVersion(),
    onData: (id, data) => {
      if (terminalHost?.ownerOf(id) !== TerminalOwner.ENGINE) deliverToTerminalReader(id, "telar:terminal:data", { id, data });
      runTerminalChannel?.onData(id, data);
    },
    onExit: (id, ending) => {
      deliverToTerminalReader(id, "telar:terminal:exit", ending);
      terminalReaders.delete(id);

      runTerminalChannel?.onExit(id, ending);
    },
  });
  return terminalHost;
}

const RENDERER = TerminalOwner.RENDERER;

let lastWindowUrl = null;

let updaterWindow = null;

function killServer() {
  uiServer.stopServer();
  stopEngineChild();
}

function stopComputerUseHelper() {
  const helperApp = computerUseHelperPath();
  if (!helperApp) return;
  try {
    stopHelperDaemon(bundledHelperDaemon(helperApp));
  } catch (error) {
    console.error("[telar-desktop] could not stop the computer-use helper:", error);
  }
}
function closeBrowserControl() {
  const control = browserControl;
  browserControl = null;
  if (control) void control.close();
}

let terminalsClosedForQuit = false;
let closingTerminalsForQuit = false;
app.on("before-quit", (event) => {
  if (terminalsClosedForQuit || !terminalHost || terminalHost.size === 0) return;
  event.preventDefault();
  if (closingTerminalsForQuit) return;
  closingTerminalsForQuit = true;
  void closeTerminalsThenQuit();
});
async function closeTerminalsThenQuit() {
  const host = terminalHost;
  try {
    const { decideQuit } = require("../terminal/terminal-host");
    const plan = decideQuit(await host.activeProcesses());
    if (plan.action === "confirm" && !SMOKE && !E2E_USER_DATA) {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const { response } = parent ? await dialog.showMessageBox(parent, plan.dialog) : await dialog.showMessageBox(plan.dialog);
      if (response !== plan.dialog.defaultId) {
        closingTerminalsForQuit = false;
        app.isQuitting = false;
        return;
      }
    }
    await host.closeAll({ final: true });

    await host.drain();
  } catch (error) {
    logShell("error", `closing terminals before quit failed: ${error?.stack || error}`);
  }
  terminalsClosedForQuit = true;
  app.quit();
}

app.on("will-quit", () => {
  for (const manager of browserManagers) { try { manager.persistSync(); } catch {} }

  if (terminalHost) { try { void terminalHost.dispose(); } catch {} }
  if (runTerminalChannel) { try { void runTerminalChannel.close(); } catch {} runTerminalChannel = null; }
  killServer();
  stopComputerUseHelper();
  closeBrowserControl();

  unpublishTailscaleServe();
});

process.on("exit", killServer);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killServer();
    stopComputerUseHelper();
    process.exit(0);
  });
}

async function recordHandoffBoot(home) {
  if (!app.isPackaged || DEV_BUILD) return;
  try {
    if (desktopHandoff.awaitingConfirmation()) await waitForEngine(home, { requireWorker: true });
    desktopHandoff.recordBoot((line) => logShell("info", line));
  } catch (err) {
    logShell("error", `hand-off boot check failed: ${err?.message || err}`);
  }
}

async function runSmoke() {
  try {
    let port;
    if (OVERRIDE_URL) {
      const u = new URL(OVERRIDE_URL);
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    } else {
      captureLoginShellEnv();
      const home = telarHome();
      startEngineChild(home);

      const discovery = await waitForEngine(home, { requireWorker: true });
      rememberEngine(discovery);
      console.log("ENGINE_OK");
      console.log(`ENGINE_WORKER_OK ${discovery.workerId}`);
      port = await findFreePort();
      startServer(port, home);
    }
    await waitForServer(port);
    console.log(`BUILD ${windowTitle()}`);
    console.log("SMOKE_OK");

    const cli = bundledPlaywrightMcpCli();
    if (fs.existsSync(cli)) {
      console.log("PLAYWRIGHT_MCP_BUNDLED_OK");
    } else {
      console.error("PLAYWRIGHT_MCP_BUNDLED_MISSING:", cli);
      if (app.isPackaged) {
        app.isQuitting = true;
        killServer();
        app.exit(1);
        return;
      }
    }

    const sdk = bundledAgentSdkEntry();
    if (fs.existsSync(sdk)) {
      console.log("AGENT_SDK_BUNDLED_OK");
    } else {
      console.error("AGENT_SDK_BUNDLED_MISSING:", sdk);
      if (app.isPackaged) {
        app.isQuitting = true;
        killServer();
        app.exit(1);
        return;
      }
    }
    app.isQuitting = true;
    killServer();
    app.exit(0);
  } catch (err) {
    console.error("SMOKE_FAIL:", err && err.message ? err.message : err);
    app.isQuitting = true;
    killServer();
    app.exit(1);
  }
}

require("./ipc-browser").registerBrowserIpc({
  requireCockpitSender,
  browserManagers,
  openInSystemBrowser,
  requireBrowserManager,
  requireBrowserSuggestions,
  requireLoginOffer,
});

require("./ipc-terminal").registerTerminalIpc({
  requireCockpitSender,
  RENDERER,
  requireTerminalHost,
  terminalReaders,
});

require("./ipc-store").registerWorkspaceAndStoreIpc({ telarHome });

require("./ipc-prefs").registerPrefsIpc();

require("./ipc-app").registerAppIpc({
  createWindow,
  linkRouting,
  get lastWindowUrl() {
    return lastWindowUrl;
  },
});

const { configureAutoUpdater } = require("./updates").registerUpdates({
  requireCockpitSender,
  telarHome,
  get updaterWindow() {
    return updaterWindow;
  },
  get terminalHost() {
    return terminalHost;
  },
  get terminalsClosedForQuit() {
    return terminalsClosedForQuit;
  },
  set terminalsClosedForQuit(value) {
    terminalsClosedForQuit = value;
  },
});

if (supportsTranslucency()) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

if (SMOKE) {
  app.on("window-all-closed", () => {});
  app.whenReady().then(runSmoke);
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.error(
      `[telar-desktop] another instance already holds the lock for ${app.getPath("userData")} — focusing it and quitting.`,
    );
    app.quit();
  } else {
    app.on("second-instance", () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    app.whenReady().then(async () => {
      try {
        wireShellDiagnostics();

        startHeapLog(() => (browserManager ? browserManager.diagnostics() : null));

        startServiceWorkerWatchdog(browserManagers);
        applyDevelopmentAppIcon();
        buildApplicationMenu();

        watchSchemeForVibrancy();

        adoptLegacyUpdatePrefs();

        const configuredControlPort = DEV_BUILD ? NaN : Number(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT);
        browserControlConfig = {
          port: Number.isInteger(configuredControlPort) && configuredControlPort > 0
            ? configuredControlPort
            : await findFreePort(),
          token: (DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim()) || randomUUID(),
        };
        browserControl = await startBrowserControlServer({
          ...browserControlConfig,

          getBrowserManager: (scopeKey) => managerForScope(browserManagers, scopeKey, browserManager),

          readProcessMetrics: () => processMetricsReader().summary(),
        });

        runTerminalConfig = { port: await findFreePort(), token: randomUUID() };
        runTerminalChannel = await startRunTerminalServer({
          ...runTerminalConfig,

          getTerminalHost: () => requireTerminalHost(),

          onMirror: (id, data, cursor) => deliverToTerminalReader(id, "telar:terminal:data", { id, data, cursor }),
        });
        let url = OVERRIDE_URL;
        if (!url) {
          captureLoginShellEnv();

          resolvedStoreHome = await openStoreGate();
          if (resolvedStoreHome === null) {
            app.quit();
            return;
          }

          const home = telarHome();
          startEngineChild(home);
          rememberEngine(await waitForEngine(home));
          await recordHandoffBoot(home);
          const port = await getStablePort();
          await publishTailscaleServe(home, port);
          startServer(port, home);
          await waitForServer(port);
          url = `http://127.0.0.1:${port}/`;
        }
        updaterWindow = createWindow(url);

        markMainWindowShown();
        configureAutoUpdater();

        watchVolumes({ onChanged: reportVolumesChanged, powerMonitor });
        app.on("activate", () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
        });
      } catch (err) {
        logShell("error", `failed to start: ${err?.stack || err}`);
        reportStartupFailure(
          "Telar could not start",
          `${err?.message || err}\n\nThere is more in ${shellLogPath()}.`,
        );
        app.quit();
      }
    });

    app.on("window-all-closed", () => {
      app.isQuitting = true;
      app.quit();
    });
  }
}
