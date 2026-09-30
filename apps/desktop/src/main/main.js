const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { app, BrowserWindow, dialog, Notification, powerMonitor } = require("electron");
const { DesktopBrowserManager, managerForScope } = require("../browser/browser-manager");
const { startBrowserControlServer } = require("../browser/browser-control-server");
const { startRunTerminalServer } = require("../terminal/run-terminal-server");
const { publishTailscaleServe, serveEnv, unpublishTailscaleServe } = require("./tailscale");
const { windowTargetUrl } = require("./window-target");
const { createDesktopNotifier } = require("./desktop-notifications");
const { createChime } = require("./notification-sound");
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
const { findFreePort, getStablePort, seatHostCookie, waitForServer } = uiServer;
const engineNotices = require("./engine-notices").createEngineNotices({ onMessage: (message) => desktopNotifier.handleServerMessage(message) });
const { DEV_BUILD, E2E_USER_DATA, OVERRIDE_URL, SMOKE } = require("./flags");
const { applyDevelopmentAppIcon, bundledAgentSdkEntry, bundledPlaywrightMcpCli, computerUseHelperPath, nodeExecPath, windowTitle } = require("./bundle-paths");
const { captureLoginShellEnv } = require("./login-shell-env");
const { findVolumeMount } = require("./volumes");
const { logShell, shellLogPath, startHeapLog } = require("./shell-log");
const { processMetricsReader, startServiceWorkerWatchdog } = require("./renderer-watch");
const { engineDiscoveryFile, markMainWindowShown, postToEngine, rememberEngine, reportStartupFailure, startEngineChild, stopEngineChild, waitForEngine } = require("./engine-child");
const { keepOccludedWindowsPainting, watchSchemeForVibrancy } = require("./appearance");
const { buildApplicationMenu } = require("./app-menu");
const { startExtensionHost } = require("./cockpit-extensions");
const { adoptLegacyUpdatePrefs } = require("./update-prefs");
const { browserManagers, currentHost, lastWindowUrl, persistAllHosts } = require("./browser-hosts");
const { createCockpitWindow } = require("./cockpit-window");
const { cockpitFocus, createPresence } = require("./presence");
const { pinUserData } = require("./user-data");

pinUserData();

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

    if (lastWindowUrl()) void seatHostCookie(lastWindowUrl());
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
      presence.stop();
      if (!SMOKE && !app.isQuitting) {
        console.error(`[telar-desktop] server exited (code=${code} signal=${signal})`);
        app.quit();
      }
    },
  });
  engineNotices.start(engineDiscoveryFile(home));
  presence.watch();
  return child;
}

const desktopNotifier = createDesktopNotifier({
  Notification, send: engineNotices.send, context: cockpitFocus, open: openNotificationPath, chime: createChime({ packaged: app.isPackaged }),
});
const presence = createPresence({ send: engineNotices.send });

function openNotificationPath(route) {
  const win = [currentHost(), ...browserManagers].map((manager) => manager?.window).find((w) => w && !w.isDestroyed());
  if (!win) {
    const target = windowTargetUrl(lastWindowUrl(), route);
    if (target) createWindow(target);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("telar:notifications:open", route);
}

function createWindow(url) {
  return createCockpitWindow(url, {
    createManager: (win, { onChordScope }) => {
      const manager = new DesktopBrowserManager(win, {
        onControlChanged: reportBrowserControl,

        onLoginEntryFinished: (capture) => requireLoginOffer().entryFinished(capture),

        onVisited: (scopeKey, url) => requireBrowserSuggestions().remember(manager.activeProfile(scopeKey)?.id, url),
        profiles: readProfileRegistry(app.getPath("userData")),

        onProfileMigrated: (from, to) => requireBrowserSuggestions().adopt(from, to),

        tabStore: createTabStore(app.getPath("userData")),

        sitePermissions: createSitePermissionStore(app.getPath("userData")),

        createExtensionHost: (partition) => startExtensionHost(win, manager, partition),

        onChordScope,
      });
      return manager;
    },
    onInPageNavigation: () => presence.report(),
  });
}

let loginOffer = null;
function requireLoginOffer() {
  loginOffer ??= wireLoginOffer({ stateRoot: path.join(telarHome(), "engine") });
  return loginOffer;
}

function reportBrowserControl(change) {
  postToEngine(telarHome(), `/v2/sessions/${encodeURIComponent(change.scopeKey)}/browser/control`, {
    controller: change.controller,
    ...(change.tabId ? { tabId: change.tabId } : {}),
    ...(change.interrupted ? { interrupted: true } : {}),
  });
}

function reportVolumesChanged() {
  postToEngine(telarHome(), "/v2/projects/reprobe");
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
  persistAllHosts();

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
      startEngineChild(home, childEnv(home));

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

require("./ipc-browser").registerBrowserIpc({ requireBrowserSuggestions, requireLoginOffer });

require("./ipc-terminal").registerTerminalIpc({
  RENDERER,
  requireTerminalHost,
  terminalReaders,
});

require("./ipc-store").registerWorkspaceAndStoreIpc({ telarHome });

require("./ipc-prefs").registerPrefsIpc();

require("./ipc-app").registerAppIpc({ createWindow });

const { configureAutoUpdater } = require("./updates").registerUpdates({
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

keepOccludedWindowsPainting();

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

        startHeapLog(() => currentHost()?.diagnostics() ?? null);

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

          getBrowserManager: (scopeKey) => managerForScope(browserManagers, scopeKey, currentHost()),

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
          startEngineChild(home, childEnv(home));
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
