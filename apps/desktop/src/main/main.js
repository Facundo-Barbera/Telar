const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { fork, execFileSync } = require("node:child_process");
const { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, powerMonitor, session, shell, webContents } = require("electron");
const { DesktopBrowserManager, managerForScope, createExternalLinkPolicy } = require("../browser/browser-manager");
const { createLinkRouting } = require("./link-routing");
const { startBrowserControlServer } = require("../browser/browser-control-server");
const { startRunTerminalServer } = require("../terminal/run-terminal-server");
const tailscale = require("./tailscale");
const remoteFile = require("./remote-file");
const { claimedCommandIds, keymapOverrides, menuCommands, mergeKeymap } = require("./command-keys");
const { ChordScopes } = require("./chord-scope");
const { macWindowChrome } = require("./window-chrome");
const { backdropWindowOptions, vibrancyMaterial, windowBackgroundColor } = require("./window-material");
const { windowTargetUrl } = require("./window-target");
const { watchWindowVisibility } = require("./window-visibility");
const { ACTIVE_IDLE_SECONDS, createDesktopNotifier, createPresenceReporter, routeOf } = require("./desktop-notifications");
const { watchVolumes } = require("./volume-watch");
const { awaitStore } = require("../store/store-gate");
const { createStoreGateWindow } = require("../store/store-gate-window");
const { ExtensionHost, extensionsEnabled } = require("../browser/extension-host");
const { createBrowserSuggestions } = require("../browser/browser-suggestions");
const { readProfileRegistry } = require("../browser/browser-profiles");
const { createTabStore } = require("../browser/browser-tab-store");
const { createSitePermissionStore } = require("../browser/site-permissions");
const { resolveHelperExec } = require("./helper-exec");
const { bundledHelperDaemon, stopHelperDaemon } = require("./computer-use-stop");
const devUpdate = require("../dev/dev-update");
const desktopHandoff = require("../handoff/desktop-handoff");
const serviceWorkerWatchdog = require("./service-worker-watchdog");
const { createProcessMetricsReader } = require("./process-metrics");
const { wireLoginOffer } = require("../login/login-offer-window");
const uiServer = require("./ui-server");
const { findFreePort, getStablePort, seatHostCookie, seatHostHeader, waitForServer } = uiServer;
const engineNotices = require("./engine-notices").createEngineNotices({ onMessage: (message) => desktopNotifier.handleServerMessage(message) });
const { jsonPrefs } = require("./prefs");

const SMOKE = process.argv.includes("--smoke");

const DEV_BUILD = (() => {
  try {
    return require("../../package.json").telarDev === true;
  } catch {
    return false;
  }
})();
const OVERRIDE_URL = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_URL;

const E2E_USER_DATA = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_E2E_USER_DATA?.trim();

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

let engineChild = null;

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

function captureLoginShellEnv() {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", "env"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      if (key === "PATH") {
        const seen = new Set();
        const merged = [];
        for (const p of [...val.split(":"), ...(process.env.PATH || "").split(":")]) {
          if (p && !seen.has(p)) {
            seen.add(p);
            merged.push(p);
          }
        }
        process.env.PATH = merged.join(":");
      } else if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.error("[telar-desktop] login-shell env capture failed:", err.message);
  }
}

function readBuildInfo() {
  const fs = require("node:fs");
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "standalone", "build-info.json")]
    : [path.join(__dirname, "..", "..", "..", "web", ".next-desktop", "standalone", "build-info.json")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
    } catch {
    }
  }
  return null;
}

function windowTitle() {
  if (!app.isPackaged) return "Telar Dev";
  const info = readBuildInfo();

  const name = DEV_BUILD ? "Telar Dev" : "Telar";
  if (!info || !info.shortSha) return name;
  return `${name} ${info.shortSha}${DEV_BUILD && info.dirty ? "+dirty" : ""}`;
}

function developmentIconPath() {
  if (app.isPackaged) return undefined;

  for (const name of ["icon-dev.png", "icon.png"]) {
    const icon = path.join(__dirname, "..", "..", "assets", name);
    if (fs.existsSync(icon)) return icon;
  }
  return undefined;
}

function applyDevelopmentAppIcon() {
  const icon = developmentIconPath();
  if (icon && process.platform === "darwin" && app.dock) app.dock.setIcon(icon);
  return icon;
}

function bundledPlaywrightMcpCli() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js")
    : path.join(__dirname, "..", "..", "..", "engine", "dist", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js");
}

function bundledAgentSdkEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")
    : path.join(__dirname, "..", "..", "..", "engine", "dist", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
}

function resolveEngineJs() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "engine", "engine.mjs")]
    : [path.join(__dirname, "..", "..", "..", "engine", "dist", "engine.mjs")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `engine bundle not found (looked in: ${candidates.join(", ")}). Run \`bun run build:app\` first.`,
  );
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

function findVolumeMount(uuid) {
  if (process.platform !== "darwin") return undefined;
  for (const root of ["/Volumes"]) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const mount = path.join(root, name);
      try {
        if (fs.statSync(mount).dev === fs.statSync(root).dev) continue;
        const plist = execFileSync("diskutil", ["info", "-plist", mount], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],

          timeout: 5_000,
        });
        if (/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() === uuid) return mount;
      } catch {
      }
    }
  }
  return undefined;
}

function nodeExecPath() {
  if (app.isPackaged && process.platform === "darwin") {
    const frameworks = path.join(path.dirname(process.execPath), "..", "Frameworks");
    const helper = resolveHelperExec(frameworks, app.getName());
    if (helper) return helper;
  }
  return process.execPath;
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

function watchForUnpairing(webContents) {
  const originOf = (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return "an unparseable URL";
    }
  };
  webContents.on("did-navigate", (_event, url, httpResponseCode) => {
    if (httpResponseCode === 401) logShell("warn", `the host window was refused (401) by ${originOf(url)}`);
  });
  webContents.on("did-redirect-navigation", (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.pathname === "/pair" || parsed.pathname.startsWith("/pair/")) {
      logShell("warn", `the host window was sent to the pairing page by ${parsed.origin}`);
    }
  });
}

let tailscaleServeUrl = null;

const TAILSCALE_SERVE_ERROR_ENV = "TELAR_TAILSCALE_SERVE_ERROR";
let tailscaleServeError = null;
async function publishTailscaleServe(home, port) {
  tailscaleServeError = null;
  if (!remoteFile.tailscaleServeRequested(home)) return null;
  const domain = await tailscale.certDomain();
  if (!domain) {
    tailscaleServeError = "no-cert-domain";
    console.error("[telar-desktop] tailscale serve requested but tailscale is missing, not running, or has HTTPS certificates disabled; skipped.");
    return null;
  }
  const outcome = await tailscale.startServe(port);
  if (outcome !== "none") {
    tailscaleServeError = outcome;
    console.error(`[telar-desktop] tailscale serve failed (${outcome}); the ts.net endpoint is down.`);
    return null;
  }
  tailscaleServeUrl = `https://${domain}`;
  console.log(`[telar-desktop] tailnet: ${tailscaleServeUrl}/`);
  return tailscaleServeUrl;
}

function computerUseHelperPath() {
  if (!app.isPackaged) return null;
  const { appName } = require("./computer-use-helper.json");
  const helper = path.join(path.dirname(process.resourcesPath), "Helpers", `${appName}.app`);
  return fs.existsSync(helper) ? helper : null;
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

const ENGINE_EXIT_LOCK_HELD = 3;

let mainWindowShown = false;

let startupFailureReported = false;

function reportStartupFailure(title, detail) {
  if (mainWindowShown || startupFailureReported) return;
  startupFailureReported = true;
  dialog.showErrorBox(title, detail);
}

function engineLockFile(home) {
  return path.join(home, "engine", "engine.lock");
}

function engineLockOwnerPid(home) {
  try {
    const pid = JSON.parse(fs.readFileSync(engineLockFile(home), "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function startEngineChild(home) {
  const engineJs = resolveEngineJs();
  engineChild = fork(engineJs, [], {
    cwd: path.dirname(engineJs),
    execPath: nodeExecPath(),

    execArgv: ["--require", path.join(__dirname, "..", "preload", "server-preload.js")],
    env: {
      ...childEnv(home),
      TELAR_HOST_TOKEN: uiServer.HOST_TOKEN,
      TELAR_PROCESS_TITLE: DEV_BUILD ? "telar-engine-dev" : "telar-engine",
      NODE_ENV: "production",

      ...(app.isPackaged && !process.env.TELAR_PLAYWRIGHT_MCP_BIN
        ? { TELAR_PLAYWRIGHT_MCP_BIN: bundledPlaywrightMcpCli() }
        : {}),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  engineChild.on("exit", (code, signal) => {
    engineChild = null;

    if (SMOKE || app.isQuitting) return;
    logShell("error", `engine exited (code=${code} signal=${signal})`);

    if (code === ENGINE_EXIT_LOCK_HELD && !mainWindowShown && !startupFailureReported) {
      startupFailureReported = true;
      const pid = engineLockOwnerPid(home);
      dialog.showMessageBoxSync({
        type: "warning",
        title: "Telar is already running",
        message: "Another Telar is using this store.",
        detail:
          `A Telar daemon${pid === null ? "" : ` (pid ${pid})`} already holds ${home}.\n\n` +
          "Switch to the Telar that is already open, or quit it before launching this one.",
        buttons: ["Quit"],
      });
      app.quit();
      return;
    }

    reportStartupFailure(
      "Telar's engine stopped",
      `The engine exited (code=${code} signal=${signal}) before Telar could open.\n\n` +
        `There is more in ${shellLogPath()}.`,
    );
    app.quit();
  });
  return engineChild;
}

function engineDiscoveryFile(home) {
  return path.join(home, "engine", "engine.json");
}

function waitForEngine(home, { timeoutMs = 30_000, intervalMs = 150, requireWorker = false } = {}) {
  const discoveryFile = engineDiscoveryFile(home);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let discovery = null;
      try {
        discovery = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      } catch {
      }
      if (discovery?.port && discovery?.token) {
        const request = http.request(
          {
            host: discovery.host || "127.0.0.1",
            port: discovery.port,
            path: "/v2/health",
            headers: { authorization: `Bearer ${discovery.token}` },
            timeout: 2_000,
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              return retry();
            }
            if (!requireWorker) {
              response.resume();
              return resolve(discovery);
            }
            let raw = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (raw += chunk));
            response.on("end", () => {
              let health = null;
              try {
                health = JSON.parse(raw);
              } catch {
              }
              if (health?.worker?.registered === true) return resolve({ ...discovery, workerId: health.worker.workerId });
              retry();
            });
          },
        );
        request.on("error", retry);
        request.on("timeout", () => {
          request.destroy();
          retry();
        });
        request.end();
        return;
      }
      retry();
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`engine did not become ${requireWorker ? "healthy with a registered worker" : "healthy"} within ${timeoutMs}ms`));
      } else setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function startServer(port, home) {
  const child = uiServer.startServer(port, home, {
    execPath: nodeExecPath(),
    env: {
      ...childEnv(home),
      TELAR_PROCESS_TITLE: DEV_BUILD ? "telar-ui-dev" : "telar-ui",
      ...(tailscaleServeUrl ? { TELAR_TAILSCALE_URL: tailscaleServeUrl } : {}),
      ...(tailscaleServeError ? { [TAILSCALE_SERVE_ERROR_ENV]: tailscaleServeError } : {}),
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

    if (!chordScopes.empty || chordCapture) {
      chordScopes.setRenderer([]);
      chordCapture = false;
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

    if (chordScopes.forget(manager)) buildApplicationMenu();

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

function startExtensionHost(win, manager, partition) {
  const wanted = extensionsEnabled({ dev: DEV_BUILD, packaged: app.isPackaged, version: app.getVersion(), override: process.env.TELAR_EXTENSIONS });
  if (!wanted || SMOKE) return null;
  const ses = session.fromPartition(partition);
  const host = new ExtensionHost(ses, {
    window: win,
    tabs: {
      createTab: async (details) => {
        const url = details.url || "about:blank";
        if (url.startsWith('chrome-extension:')) {
          const page = host.openExtensionPage(url, win);
          return [page.webContents, page];
        }

        const onPartition = (scope) => { try { return manager.partitionOf(scope) === partition; } catch { return false; } };
        const scope = (manager.visibleScopeKey && onPartition(manager.visibleScopeKey))
          ? manager.visibleScopeKey
          : [...new Set(manager.tabs.map((t) => t.scopeKey))].find(onPartition);
        if (!scope) throw new Error("No browser session for this profile is open to receive a tab.");
        const tab = await manager.createTab(scope, url, "human");
        return [tab.view.webContents, win];
      },
      selectTab: (wc) => {
        const tab = manager.tabs.find((t) => t.view && t.view.webContents === wc);
        if (tab) manager.selectTab(tab.scopeKey, manager.scopeTabs(tab.scopeKey).indexOf(tab)).catch(() => undefined);
      },
      removeTab: (wc) => {
        const tab = manager.tabs.find((t) => t.view && t.view.webContents === wc);
        if (tab) { manager.closeTabRef(tab); return; }
        for (const page of host.extensionWindows) if (!page.isDestroyed() && page.webContents === wc) page.close();
      },
    },
  });
  host.onHealthChange = (status) => { if (!win.isDestroyed()) win.webContents.send("telar:browser:extension", { partition, ...status }); };

  host.onHoldOpen = (id, reason) => manager.addUiHold(id, reason);
  host.onHoldClose = (id) => manager.removeUiHold(id);
  host.startOnce().then((status) => {
    if (status.phase === "failed") console.error(`[telar-desktop] 1Password extension (${partition}): ${status.error}`);
    if (!win.isDestroyed()) win.webContents.send("telar:browser:extension", { partition, ...status });
  });
  return host;
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

let chordCapture = false;

const chordScopes = new ChordScopes();

function setBrowserChordScope(manager, chords) {
  if (chordScopes.setOwner(manager, chords)) buildApplicationMenu();
}

function sendCommandKey(browserWindow, id) {
  const win = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  win?.webContents.send("telar:command-keys:invoke", id);
}

function buildApplicationMenu(keymap = readKeymap()) {
  const claimed = new Set(claimedCommandIds(keymap, chordScopes.all()));
  const toMenuItem = (command) => ({
    label: command.label,

    ...(command.accelerator && !chordCapture && !claimed.has(command.id) ? { accelerator: command.accelerator } : {}),
    enabled: !chordCapture,
    click: (_menuItem, browserWindow) => sendCommandKey(browserWindow, command.id),
  });
  const fileCommands = menuCommands(keymap, "file");
  const panelCommands = menuCommands(keymap, "panel");
  const viewCommands = menuCommands(keymap, "view");

  const jumpBindings = fileCommands.filter((command) => command.jump);
  const otherBindings = fileCommands.filter((command) => !command.jump);
  const isMac = process.platform === "darwin";
  const template = [

    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        ...otherBindings.map(toMenuItem),
        { type: "separator" },

        { label: "Jump to", submenu: jumpBindings.map(toMenuItem) },

        ...(DEV_BUILD
          ? [
              { type: "separator" },
              { label: "Update from Local Checkout…", click: () => devUpdate.openWindow() },
            ]
          : []),
      ],
    },
    { role: "editMenu" },

    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        ...viewCommands.map(toMenuItem),
        { role: "toggleDevTools", label: "Cockpit Developer Tools", accelerator: "CommandOrControl+Alt+Shift+I" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    ...(panelCommands.length > 0 ? [{ label: "Panel", submenu: panelCommands.map(toMenuItem) }] : []),
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let engineDiscovery = null;
let discoveryReadAt = 0;

function currentEngineDiscovery() {
  if (!engineDiscovery && Date.now() - discoveryReadAt > 5_000) {
    discoveryReadAt = Date.now();
    try {
      engineDiscovery = JSON.parse(fs.readFileSync(engineDiscoveryFile(telarHome()), "utf8"));
    } catch {
    }
  }
  return engineDiscovery;
}

function postToEngine(routePath, body) {
  const discovery = currentEngineDiscovery();
  if (!discovery?.port || !discovery?.token) return;
  const payload = JSON.stringify(body ?? {});
  const request = http.request({
    host: discovery.host || "127.0.0.1",
    port: discovery.port,
    path: routePath,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${discovery.token}`,
      "content-length": Buffer.byteLength(payload),
    },
    timeout: 2_000,
  });
  request.on("error", () => {});
  request.on("timeout", () => request.destroy());
  request.end(payload);
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

function volumeIdentityFor(target) {
  if (process.platform !== "darwin") return undefined;
  const prefix = "/Volumes/";
  if (!target.startsWith(prefix)) return undefined;
  const [name] = target.slice(prefix.length).split(path.sep);
  if (!name) return undefined;
  const mount = path.join("/Volumes", name);
  try {
    if (fs.statSync(mount).dev === fs.statSync("/Volumes").dev) return undefined;
    const plist = execFileSync("diskutil", ["info", "-plist", mount], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const uuid = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
    return { mount, label: name, ...(uuid ? { uuid } : {}) };
  } catch {
    return { mount, label: name };
  }
}

function updateProxyKey() {
  try {
    return require("../../package.json").updateProxyKey || null;
  } catch {
    return null;
  }
}

const UPDATE_CHANNELS = ["beta", "nightly"];
const DEFAULT_UPDATE_PREFS = { channel: "beta", installOnQuit: false };

const validUpdatePrefs = (raw) => ({
  channel: UPDATE_CHANNELS.includes(raw.channel) ? raw.channel : DEFAULT_UPDATE_PREFS.channel,
  installOnQuit: raw.installOnQuit === true,
});

const updatePrefs = jsonPrefs("update-prefs.json", DEFAULT_UPDATE_PREFS, validUpdatePrefs, "update prefs");
const readUpdatePrefs = updatePrefs.read;
const writeUpdatePrefs = updatePrefs.write;

const LEGACY_USER_DATA_NAME = "telar-desktop";

function adoptLegacyUpdatePrefs() {
  const fs = require("node:fs");

  if (DEV_BUILD) return;
  try {
    if (fs.existsSync(updatePrefs.path())) return;
    const legacy = path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME, "update-prefs.json");
    if (!fs.existsSync(legacy)) return;

    const prefs = validUpdatePrefs(JSON.parse(fs.readFileSync(legacy, "utf8")));
    writeUpdatePrefs(prefs);
    console.log(`[telar-desktop] adopted update preferences from the previous install (channel ${prefs.channel})`);
  } catch (err) {
    console.error("[telar-desktop] could not adopt previous update preferences:", err.message);
  }
}

const DEFAULT_UI_PREFS = { translucent: false, frost: "blur" };

const { read: readUiPrefs, write: writeUiPrefs } = jsonPrefs(
  "ui-prefs.json",
  DEFAULT_UI_PREFS,

  (raw) => ({ translucent: raw.translucent === true, frost: raw.frost === "clear" ? "clear" : "blur" }),
  "ui prefs",
);

function supportsTranslucency() {
  return process.platform === "darwin";
}

const { read: readKeybindingOverrides, write: writeKeybindingOverrides } = jsonPrefs(
  "keybindings.json",
  {},
  (raw) => keymapOverrides(mergeKeymap(raw)),
  "keybindings",
);

function readKeymap() {
  return mergeKeymap(readKeybindingOverrides());
}

function applyTranslucency(on, frost) {
  const dark = nativeTheme.shouldUseDarkColors;

  const material = vibrancyMaterial({ translucent: on, frost, dark });

  const backgroundColor = windowBackgroundColor({ translucent: on, dark });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setVibrancy(material);
      win.setBackgroundColor(backgroundColor);
    } catch (err) {
      console.error("[telar-desktop] failed to retint a window:", err.message);
    }
  }
}

function reapplyVibrancy() {
  if (!supportsTranslucency()) return;
  const { translucent, frost } = readUiPrefs();
  applyTranslucency(translucent, frost);
}

function watchSchemeForVibrancy() {
  if (!supportsTranslucency()) return;
  nativeTheme.on("updated", reapplyVibrancy);
}

let lastWindowUrl = null;

let updaterWindow = null;

function updateLogPath() {
  return path.join(app.getPath("userData"), "update.log");
}

function shellLogPath() {
  return path.join(app.getPath("userData"), "shell.log");
}

function logShell(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
  try {
    fs.appendFileSync(shellLogPath(), line);
  } catch {
  }
  console.log(`[telar-shell] ${level} ${message}`);
}

const HEAP_LOG_INTERVAL_MS = 60_000;
const HEAP_WARN_BYTES = 1_024 * 1_024 * 1_024;

function heapLogRequested() {
  return process.argv.includes("--telar-heap-log") || process.env.TELAR_SHELL_HEAP_LOG === "1";
}

function diagnosticsDir() {
  return path.join(app.getPath("userData"), "diagnostics");
}

const mb = (bytes) => Math.round(Number(bytes || 0) / (1024 * 1024));

let heapWarned = false;
let heapSnapshotWritten = false;

function writeHeapSnapshotOnce() {
  if (heapSnapshotWritten) return null;
  heapSnapshotWritten = true;
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true });
    const file = path.join(diagnosticsDir(), `main-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`);
    require("node:v8").writeHeapSnapshot(file);
    return file;
  } catch (error) {
    logShell("warn", `could not write a heap snapshot: ${error && error.message ? error.message : error}`);
    return null;
  }
}

async function heapLogTick(detailed) {
  const heap = require("node:v8").getHeapStatistics();
  if (detailed) {
    const memory = process.memoryUsage();

    let footprint = null;
    try {
      footprint = typeof process.getProcessMemoryInfo === "function" ? await process.getProcessMemoryInfo() : null;
    } catch {
    }
    const views = browserManager ? browserManager.diagnostics() : null;
    logShell(
      "info",
      [
        `heap rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB heapTotal=${mb(memory.heapTotal)}MB`,
        `external=${mb(memory.external)}MB arrayBuffers=${mb(memory.arrayBuffers)}MB`,
        `usedHeapSize=${mb(heap.used_heap_size)}MB heapLimit=${mb(heap.heap_size_limit)}MB`,
        footprint ? `private=${Math.round(Number(footprint.private || 0) / 1024)}MB residentSet=${Math.round(Number(footprint.residentSet || 0) / 1024)}MB` : "private=?",
        `windows=${BrowserWindow.getAllWindows().length}`,
        views
          ? `scopes=${views.scopes} tabs=${views.tabs} liveViews=${views.liveViews} wcListeners=${views.wcListeners} extensionHosts=${views.extensionHosts} console=${views.consoleEntries} network=${views.networkEntries} expectedReports=${views.expectedReports} refs=${views.refs} scopeEntries=${views.scopeEntries} pendingPopups=${views.pendingPopups} uiHolds=${views.uiHolds}`
          : "manager=none",
      ].join(" "),
    );
  }
  if (heap.used_heap_size < HEAP_WARN_BYTES || heapWarned) return;
  heapWarned = true;
  const snapshot = detailed ? writeHeapSnapshotOnce() : null;
  logShell(
    "warn",
    `the main process V8 heap passed ${mb(HEAP_WARN_BYTES)}MB (used=${mb(heap.used_heap_size)}MB of a ${mb(heap.heap_size_limit)}MB limit) — see issue #296. This warns once per launch.` +
      (snapshot ? ` Heap snapshot: ${snapshot}` : heapLogRequested() ? "" : " Relaunch with TELAR_SHELL_HEAP_LOG=1 for a per-minute series and a heap snapshot."),
  );
}

function startHeapLog() {
  const detailed = heapLogRequested();
  if (detailed) void heapLogTick(true);
  const timer = setInterval(() => void heapLogTick(detailed), HEAP_LOG_INTERVAL_MS);

  timer.unref?.();
}

function liveRendererProcessIds() {
  const pids = [];
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      const pid = contents.getOSProcessId();
      if (pid) pids.push(pid);
    } catch {
    }
  }
  return pids;
}

let processMetrics = null;
function processMetricsReader() {
  if (!processMetrics) {
    processMetrics = createProcessMetricsReader({
      readMetrics: () => app.getAppMetrics(),
      readLiveProcessIds: liveRendererProcessIds,
    });
  }
  return processMetrics;
}

let lastRunawayNotice = { at: 0, renderers: [] };
function broadcastRunawayNotice(notices) {
  lastRunawayNotice = {
    at: Date.now(),

    renderers: (notices || []).map((notice) => ({
      pid: notice.pid,
      percent: notice.percent,
      polls: notice.polls,
      killed: Boolean(notice.killed),
      origins: notice.origins || [],
    })),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("telar:metrics:runaway", lastRunawayNotice);
    } catch {
    }
  }
}

function startServiceWorkerWatchdog() {
  const watchdog = serviceWorkerWatchdog.createServiceWorkerWatchdog({
    readMetrics: () => processMetricsReader().metricsForWatchdog({ minWindowMs: 25_000 }),
    readLiveProcessIds: liveRendererProcessIds,

    readWorkers: () => {
      const workers = [];
      const partitions = new Set();
      const liveOrigins = new Map();
      for (const manager of browserManagers) {
        for (const partition of manager.activePartitions()) partitions.add(partition);
        for (const [partition, origins] of manager.liveOriginsByPartition()) {
          if (!liveOrigins.has(partition)) liveOrigins.set(partition, new Set());
          for (const origin of origins) liveOrigins.get(partition).add(origin);
        }
      }
      for (const partition of partitions) {
        let running;
        try {
          running = session.fromPartition(partition).serviceWorkers.getAllRunning();
        } catch {
          continue;
        }
        for (const info of Object.values(running || {})) {
          const origin = serviceWorkerWatchdog.originOfScope(info?.scope);
          workers.push({
            partition,
            scope: info?.scope,
            scriptUrl: info?.scriptUrl,
            versionId: info?.versionId,
            hasLiveTab: Boolean(origin && liveOrigins.get(partition)?.has(origin)),
          });
        }
      }
      return workers;
    },
    terminate: (pid) => process.kill(pid, "SIGKILL"),
    log: logShell,
    onNotice: broadcastRunawayNotice,
  });
  watchdog.start();
  return watchdog;
}

function killServer() {
  uiServer.stopServer();
  if (!engineChild || engineChild.killed) return;
  try {
    engineChild.kill("SIGTERM");
  } catch {
  }
  engineChild = null;
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

  if (tailscaleServeUrl) void tailscale.stopServe();
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

      engineDiscovery = await waitForEngine(home, { requireWorker: true });
      console.log("ENGINE_OK");
      console.log(`ENGINE_WORKER_OK ${engineDiscovery.workerId}`);
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

require("./ipc-store").registerWorkspaceAndStoreIpc({
  DEV_BUILD,
  telarHome,
  volumeIdentityFor,
});

require("./ipc-prefs").registerPrefsIpc({
  applyTranslucency,
  buildApplicationMenu,
  chordScopes,
  readKeybindingOverrides,
  readUiPrefs,
  supportsTranslucency,
  writeKeybindingOverrides,
  writeUiPrefs,
  get chordCapture() {
    return chordCapture;
  },
  set chordCapture(value) {
    chordCapture = value;
  },
});

require("./ipc-app").registerAppIpc({
  createWindow,
  linkRouting,
  processMetricsReader,
  get lastRunawayNotice() {
    return lastRunawayNotice;
  },
  get lastWindowUrl() {
    return lastWindowUrl;
  },
});

const { configureAutoUpdater } = require("./updates").registerUpdates({
  DEV_BUILD,
  UPDATE_CHANNELS,
  logShell,
  readUpdatePrefs,
  requireCockpitSender,
  telarHome,
  updateLogPath,
  updateProxyKey,
  writeUpdatePrefs,
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

        startHeapLog();

        startServiceWorkerWatchdog();
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
          engineDiscovery = await waitForEngine(home);
          await recordHandoffBoot(home);
          const port = await getStablePort();
          await publishTailscaleServe(home, port);
          startServer(port, home);
          await waitForServer(port);
          url = `http://127.0.0.1:${port}/`;
        }
        updaterWindow = createWindow(url);

        mainWindowShown = true;
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
