// Telar desktop shell (viable tier). Boots the standalone Next server as a
// child process and points a BrowserWindow at it. No tray, and no custom
// menu beyond the one issue #16 needs for command-key accelerators —
// deliberately small.
//
// Modes:
//   (default)              single-instance app window
//   TELAR_DESKTOP_URL=...   skip the server, point the window at an existing
//                           server (dev convenience); overrides everything
//   --smoke                 boot the server, curl /, print SMOKE_OK / error,
//                           exit 0/1, and NEVER create a window

const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { fork, execFileSync } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { DesktopBrowserManager, createExternalLinkPolicy } = require("./browser-manager");
const { startBrowserControlServer } = require("./browser-control-server");
const { COMMAND_KEY_BINDINGS } = require("./command-keys");

const SMOKE = process.argv.includes("--smoke");
const OVERRIDE_URL = process.env.TELAR_DESKTOP_URL;
const E2E_USER_DATA = process.env.TELAR_DESKTOP_E2E_USER_DATA?.trim();

// Keep automated Electron runs in their own application identity. Electron's
// single-instance lock is scoped through userData, so this lets the E2E shell
// coexist with a developer's real Telar window without weakening the normal
// one-instance contract.
if (E2E_USER_DATA) {
  app.setPath("userData", E2E_USER_DATA);
} else if (SMOKE) {
  app.setPath(
    "userData",
    fs.mkdtempSync(path.join(os.tmpdir(), "telar-electron-smoke-")),
  );
}

let serverChild = null;
let browserManager = null;
let browserControl = null;
let browserControlConfig = null;

const REMOTE_DEBUGGING_PORT = process.env.TELAR_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
if (REMOTE_DEBUGGING_PORT && /^\d+$/.test(REMOTE_DEBUGGING_PORT)) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);
  // Bound to loopback by Chromium; allow the local Playwright/CDP test client
  // to attach regardless of the ephemeral websocket origin it chooses.
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

// --- (a) Login-shell env -----------------------------------------------------
// Finder-launched apps inherit a bare PATH; Telar shells out to git/gh/claude/
// bun, so we capture the interactive login shell's environment once and merge
// it in. PATH is unioned (login-shell entries first) so those binaries resolve;
// other vars fill in only where Electron didn't already set them.
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

// --- (b) Free port -----------------------------------------------------------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Probe whether a specific port is free by binding a throwaway server to it.
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

// --- Stable port (localStorage origin stability) ----------------------------
// The window loads http://127.0.0.1:<port>/, and everything the renderer keeps
// in localStorage (sidebar pins, wheel order, dock state, ui prefs, theme) is
// scoped to that origin. Picking a fresh port every launch silently resets all
// of it, so we persist the chosen port in userData and reuse it as long as it's
// still free; only fall back to a new one (and persist that) on first run, a
// busy port, or a corrupt/unreadable file. Smoke mode never reads or writes
// this — it's isolated by design.
function portFilePath() {
  return path.join(app.getPath("userData"), "server-port.json");
}

function readPersistedPort() {
  const fs = require("node:fs");
  try {
    const data = JSON.parse(fs.readFileSync(portFilePath(), "utf8"));
    const port = Number(data.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    // Missing / corrupt / unreadable — treat as first run, never a crash.
    return null;
  }
}

function persistPort(port) {
  const fs = require("node:fs");
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(portFilePath(), JSON.stringify({ port }), "utf8");
  } catch (err) {
    console.error("[telar-desktop] failed to persist port:", err.message);
  }
}

async function getStablePort() {
  const stored = readPersistedPort();
  if (stored !== null && (await isPortFree(stored))) return stored;
  const fresh = await findFreePort();
  persistPort(fresh);
  return fresh;
}

// --- Build stamp -------------------------------------------------------------
// build-desktop.sh writes build-info.json into the standalone tree, which
// electron-builder copies to <Resources>/standalone/build-info.json. When it is
// present (a packaged, stamped build) the window title becomes "Telar <sha>" so
// you can always tell which build you're running. Absent (dev-repo mode) = plain
// "Telar".
function readBuildInfo() {
  const fs = require("node:fs");
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "standalone", "build-info.json")]
    : [path.join(__dirname, "..", "web_old", ".next-desktop", "standalone", "build-info.json")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
    } catch {
      /* malformed / unreadable — fall through to the plain title */
    }
  }
  return null;
}

function windowTitle() {
  const info = readBuildInfo();
  return info && info.shortSha ? `Telar ${info.shortSha}` : "Telar";
}

function developmentIconPath() {
  if (app.isPackaged) return undefined;
  const icon = path.join(__dirname, "build", "icon.png");
  return fs.existsSync(icon) ? icon : undefined;
}

function applyDevelopmentAppIcon() {
  const icon = developmentIconPath();
  if (icon && process.platform === "darwin" && app.dock) app.dock.setIcon(icon);
  return icon;
}

// --- Bundled @playwright/mcp CLI --------------------------------------------
// build-web.sh materializes a self-contained, symlink-dereferenced @playwright/
// mcp closure (cli.js + playwright/playwright-core) that electron-builder copies
// to <Resources>/playwright-mcp. Packaged: point at that. Dev-repo: the same
// closure lives under .next-desktop (build:web writes it there too) — used only
// by --smoke's existence check; the running dev-repo Verifier resolves via the
// core resolver's walk-up, so we never force the env there.
function bundledPlaywrightMcpCli() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js")
    : path.join(__dirname, "..", "web_old", ".next-desktop", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js");
}

// --- Bundled claude-agent-sdk native CLI binary -----------------------------
// The SDK loads its platform binary (@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude) via
// createRequire(sdk.mjs).resolve at runtime — never a static import — so build-web.sh
// materializes a dereferenced real copy into the standalone .bun store, the exact slot that
// resolution checks. This resolves it the SAME way the SDK will, so --smoke proves the bundle
// from the SDK's own vantage point. Returns null if the SDK entry can't be located.
function resolveBundledClaudeBinary() {
  const fs = require("node:fs");
  const { createRequire } = require("node:module");
  let sdkMjs = null;
  if (app.isPackaged) {
    // The traced SDK lives under one version-hash dir in the standalone .bun store.
    const bun = path.join(process.resourcesPath, "standalone", "node_modules", ".bun");
    try {
      for (const d of fs.readdirSync(bun)) {
        if (!d.startsWith("@anthropic-ai+claude-agent-sdk@")) continue;
        const cand = path.join(bun, d, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
        if (fs.existsSync(cand)) {
          sdkMjs = cand;
          break;
        }
      }
    } catch {
      /* .bun missing — treated as unresolved below */
    }
  } else {
    // Dev-repo: resolve the SDK from the web app's install, exactly as the server does.
    try {
      sdkMjs = require.resolve("@anthropic-ai/claude-agent-sdk", {
        paths: [path.join(__dirname, "..", "web_old")],
      });
    } catch {
      /* not installed — unresolved */
    }
  }
  if (!sdkMjs) return null;
  try {
    return createRequire(sdkMjs).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
    );
  } catch {
    return null;
  }
}

// --- Resolve the standalone server.js ---------------------------------------
// Dev-repo layout:  apps/web_old/.next-desktop/standalone/apps/web_old/server.js
// Packaged layout:  <Resources>/standalone/apps/web_old/server.js  (extraResources)
function resolveServerJs() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "standalone", "apps", "web_old", "server.js")]
    : [path.join(__dirname, "..", "web_old", ".next-desktop", "standalone", "apps", "web_old", "server.js")];
  const fs = require("node:fs");
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `standalone server.js not found (looked in: ${candidates.join(", ")}). ` +
      `Run \`bun run build:web\` first.`,
  );
}

// --- (c) Boot the standalone server as a child ------------------------------
function startServer(port) {
  const serverJs = resolveServerJs();
  // A smoke boot is a REAL server, and the engine's boot reconciliation marks
  // any in-flight loom it doesn't own as failed — so a verification boot
  // against the user's ~/.telar kills their live looms. Smoke always gets a
  // throwaway store: it proves the bundle, never touches real state.
  const smokeHome = SMOKE
    ? require("node:fs").mkdtempSync(
        path.join(require("node:os").tmpdir(), "telar-smoke-"),
      )
    : null;
  // In packaged Electron there is no separate node binary — run an Electron
  // binary as node via ELECTRON_RUN_AS_NODE. On macOS the MAIN binary still
  // registers with LaunchServices as a Foreground app even under RUN_AS_NODE,
  // putting a second, dead "Telar" (the next-server child) in the Dock. The
  // Helper binary is LSUIElement in its Info.plist — same runtime, no Dock
  // entry — so prefer it when packaged.
  let nodeExecPath = process.execPath;
  if (app.isPackaged && process.platform === "darwin") {
    const helper = path.join(
      path.dirname(process.execPath),
      "..",
      "Frameworks",
      "Telar Helper.app",
      "Contents",
      "MacOS",
      "Telar Helper",
    );
    if (require("node:fs").existsSync(helper)) nodeExecPath = helper;
  }
  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    execPath: nodeExecPath,
    // Tie the child's lifetime to ours: the preload self-exits when our IPC
    // channel closes, so a SIGKILL / native crash of this main process (which
    // runs none of the cleanup handlers below) can't orphan the Next server.
    execArgv: ["--require", path.join(__dirname, "server-preload.js")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      ...(browserControlConfig ? {
        TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(browserControlConfig.port),
        TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: browserControlConfig.token,
      } : {}),
      // Packaged only: @playwright/mcp isn't traced into the standalone bundle
      // nor on PATH, so the core resolver (explicit -> ENV -> walk-up -> PATH)
      // would find nothing. Point it at the bundled cli.js unless the user
      // already set the env (their choice wins). Dev-repo mode is left untouched
      // — the walk-up resolves the repo's install there.
      ...(app.isPackaged && !process.env.TELAR_PLAYWRIGHT_MCP_BIN
        ? { TELAR_PLAYWRIGHT_MCP_BIN: bundledPlaywrightMcpCli() }
        : {}),
      ...(smokeHome ? { TELAR_HOME: smokeHome } : {}),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  serverChild.on("exit", (code, signal) => {
    serverChild = null;
    // If the server dies unexpectedly while the app is up, don't leave a
    // half-dead window — quit so nothing is orphaned.
    if (!SMOKE && !app.isQuitting) {
      console.error(`[telar-desktop] server exited (code=${code} signal=${signal})`);
      app.quit();
    }
  });
  return serverChild;
}

// --- (d) Poll the port until it answers 200 ---------------------------------
function waitForServer(port, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(port);
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(2_000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`server did not answer on :${port} within ${timeoutMs}ms`));
      } else {
        setTimeout(tick, intervalMs);
      }
    };
    tick();
  });
}

// --- External links (issue #35) ----------------------------------------------
// Anything that is not Telar's own UI leaves for the user's default browser.
// Authentication is the reason: an OAuth flow in an in-app window has no
// password manager, no session the user is already signed into and no address
// bar, and MCP servers make that a flow users repeat rather than survive once.
//
// APPLIED TO THE APP WINDOW'S webContents AND NOTHING ELSE — deliberately not
// through app.on("web-contents-created"), which would also catch the browser
// manager's WebContentsView tabs. Those are the integrated browser: agents
// drive them and they must keep rendering in-app.
function openInSystemBrowser(url) {
  // A refused hand-off to the OS must not become an unhandled rejection in the
  // main process — there is nothing to retry, and the log is the only place
  // this can be reported from.
  shell.openExternal(url).catch((err) => {
    console.error("[telar-desktop] failed to open externally:", url, err?.message || err);
  });
}

function actOnLinkDecision(decision) {
  if (decision.openExternal) openInSystemBrowser(decision.openExternal);
  // The dedupe below deliberately drops the second arrival of one click, but a
  // dropped hand-off and a broken link look identical from the outside, so say
  // which one happened.
  else if (decision.duplicateOf) {
    console.log("[telar-desktop] suppressed duplicate external open:", decision.duplicateOf);
  }
}

// createPolicy, not a policy: each webContents gets its own instance, because
// the dedupe inside it is a per-surface burst window closing over one click's
// window.open -> location.href fallback. Shared, a second window's first
// hand-off would be swallowed by a first window's recent one.
function applyExternalLinkPolicy(webContents, createPolicy) {
  const policy = createPolicy();
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = policy.decide(url);
    actOnLinkDecision(decision);
    return decision.action === "allow" ? { action: "allow" } : { action: "deny" };
  });
  // setWindowOpenHandler never sees a same-window navigation, and that is the
  // path a blocked popup takes: window.open returns null when denied, and the
  // usual fallback (Telar's own MCP OAuth connect included) assigns
  // location.href instead.
  webContents.on("will-navigate", (event, url) => {
    const decision = policy.decide(url);
    if (decision.action === "allow") return;
    event.preventDefault();
    actOnLinkDecision(decision);
  });
  // A window the app was allowed to open is still the app, so it gets the same
  // policy; otherwise every link inside it is one un-policed hop.
  webContents.on("did-create-window", (childWindow) => {
    applyExternalLinkPolicy(childWindow.webContents, createPolicy);
  });
}

// --- (e) Window --------------------------------------------------------------
function createWindow(url) {
  const title = windowTitle();
  const icon = developmentIconPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0a0a",
    show: false,
    title,
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  browserManager = new DesktopBrowserManager(win);
  // The window's own URL is what "the app's own UI" means — it is the same
  // origin in dev-repo, packaged and TELAR_DESKTOP_URL modes, so nothing here
  // has to guess a port or a hostname. An unusable one throws, and createWindow
  // runs inside whenReady's try/catch, which logs and quits.
  applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }));
  // A native WebContentsView outlives a renderer reload and React never gets a
  // cleanup pass in that path. Hide it before the document is replaced; the
  // remounted Browser surface will publish fresh bounds and make it visible.
  win.webContents.on("did-start-loading", () => {
    browserManager?.hideVisibleScope();
  });
  win.on("closed", () => {
    browserManager?.destroy();
    browserManager = null;
  });
  // Keep the build stamp in the title bar — don't let the loaded page's <title>
  // overwrite it (that's how you answer "which build am I running?").
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(title);
  });
  win.once("ready-to-show", () => win.show());
  win.setTitle(title);
  win.loadURL(url);
  return win;
}

function requireBrowserManager() {
  if (!browserManager) throw new Error("The Telar desktop browser host is not ready.");
  return browserManager;
}

// --- Application menu (issue #16 — command keys) -----------------------------
// The ONE place accelerators are wired to Electron's native menu. Every
// binding (id, label, accelerator) comes from ./command-keys.js — the single
// source of truth apps/web_old/lib/command-keys.ts also reads, by relative
// import, since this process runs under real Node with no TypeScript (see
// the long comment there). This file never repeats a key combination; it
// only turns the shared table into a Menu template and forwards clicks to
// the renderer as a bare action id, over the same telar:* contextBridge
// pattern every other IPC channel here uses. The renderer (lib/use-command-
// keys.ts) owns the focus rule and what each action actually does — this
// process has no DOM, so it could not apply either even if it wanted to.
function sendCommandKey(browserWindow, id) {
  const win = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  win?.webContents.send("telar:command-keys:invoke", id);
}

function buildApplicationMenu() {
  const toMenuItem = (binding) => ({
    label: binding.label,
    accelerator: binding.accelerator,
    click: (_menuItem, browserWindow) => sendCommandKey(browserWindow, binding.id),
  });
  // jump-1..jump-9 nest under their own submenu so the top-level File menu
  // reads as four commands, not thirteen — cosmetic only, `id`/`accelerator`
  // for every one of them still comes straight from the shared table.
  const jumpBindings = COMMAND_KEY_BINDINGS.filter((binding) => binding.jump);
  const otherBindings = COMMAND_KEY_BINDINGS.filter((binding) => !binding.jump);
  const isMac = process.platform === "darwin";
  const template = [
    // role: "appMenu" (macOS's app-name menu: About/Hide/Quit) and the
    // role-based Edit/View/Window menus below are what keep native behavior
    // — Quit, Cmd+C/V/X/Z, fullscreen, Minimize — working at all: replacing
    // the whole application menu without them, rather than adding to it,
    // would otherwise silently drop those OS-level accelerators.
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        ...otherBindings.map(toMenuItem),
        { type: "separator" },
        { label: "Jump to Conversation", submenu: jumpBindings.map(toMenuItem) },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("telar:browser:state", (_event, scopeKey) => requireBrowserManager().state(scopeKey));
ipcMain.handle("telar:browser:action", (_event, input) =>
  requireBrowserManager().action(input?.scopeKey, input?.action),
);
ipcMain.handle("telar:browser:tool", (_event, input) =>
  requireBrowserManager().callTool(input?.scopeKey, input?.name, input?.args || {}),
);
ipcMain.handle("telar:browser:set-bounds", (_event, input) => {
  requireBrowserManager().setBounds(input?.scopeKey, input?.bounds);
});
ipcMain.handle("telar:browser:set-visible", (_event, input) =>
  requireBrowserManager().setVisible(input?.scopeKey, input?.visible),
);
ipcMain.handle("telar:browser:release-scope", (_event, input) =>
  requireBrowserManager().releaseScope(input?.scopeKey, Boolean(input?.destroy)),
);
ipcMain.handle("telar:browser:adopt-scope", (_event, input) =>
  requireBrowserManager().adoptScope(input?.fromScopeKey, input?.toScopeKey),
);

// --- Native folder picker -----------------------------------------------------
//
// The one thing a browser sandbox genuinely cannot do: hand back an absolute
// path. Registering a project needs one, and typing `/Users/you/code/thing` by
// hand is how you find out about typos after the engine has already refused.
//
// PARENTED TO THE WINDOW THAT ASKED, which is what makes this a sheet attached to
// the app on macOS rather than a free-floating dialog that can end up behind it.
// `dialog` handles every platform, so nothing here is macOS-specific — unlike the
// osascript fallback the web adapter keeps for people running the cockpit in a
// plain browser.
//
// CANCELLING IS AN ANSWER, not an error: `{ cancelled: true }`, so the caller does
// not have to tell "the user changed their mind" apart from "the dialog broke".
ipcMain.handle("telar:dialog:choose-directory", async (event, input) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: input?.title || "Choose a project folder",
    // `createDirectory` lets somebody make the folder while they are in there;
    // `treatPackageAsDirectory` matters on macOS, where a repository that happens
    // to be named `something.app` is otherwise unselectable.
    properties: ["openDirectory", "createDirectory", "treatPackageAsDirectory"],
    ...(input?.buttonLabel ? { buttonLabel: input.buttonLabel } : {}),
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const [directory] = result.filePaths || [];
  return result.canceled || !directory ? { cancelled: true } : { path: directory };
});

// --- Auto-update (electron-updater) ------------------------------------------
// electron-updater has no way to bake a custom request header into the
// generated app-update.yml itself, so the shared secret that the R2 update
// proxy requires travels as extraMetadata (set via
// -c.extraMetadata.updateProxyKey at build time, in scripts/build-desktop.sh)
// and gets read back out of the packaged package.json here, at runtime.
function updateProxyKey() {
  try {
    return require("./package.json").updateProxyKey || null;
  } catch {
    return null;
  }
}

// --- Update preferences (userData, same idiom as the persisted port) ---------
//
// TWO THINGS THE USER OWNS, and neither was expressible before: WHICH stream of
// builds this install follows, and WHETHER a downloaded update installs itself
// on quit. Both were hardcoded — the channel came from whatever the build was
// published as, and installing always waited for an explicit click.
//
// Stored beside server-port.json rather than in telar.yaml or ~/.telar: this is
// a property of THIS INSTALLATION on THIS MACHINE, not of a project and not of
// the engine. A second checkout must not inherit it, and syncing it would be
// wrong.
const UPDATE_CHANNELS = ["beta", "nightly"];
const DEFAULT_UPDATE_PREFS = { channel: "beta", installOnQuit: false };

function updatePrefsPath() {
  return path.join(app.getPath("userData"), "update-prefs.json");
}

function readUpdatePrefs() {
  const fs = require("node:fs");
  try {
    const raw = JSON.parse(fs.readFileSync(updatePrefsPath(), "utf8"));
    return {
      // Validated, not trusted: this file is user-editable and a bad channel
      // name would point electron-updater at a feed that does not exist, which
      // surfaces as a permanent, mystifying update error rather than a default.
      channel: UPDATE_CHANNELS.includes(raw.channel) ? raw.channel : DEFAULT_UPDATE_PREFS.channel,
      installOnQuit: raw.installOnQuit === true,
    };
  } catch {
    // Missing / corrupt / unreadable — first run, never a crash.
    return { ...DEFAULT_UPDATE_PREFS };
  }
}

function writeUpdatePrefs(prefs) {
  const fs = require("node:fs");
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(updatePrefsPath(), JSON.stringify(prefs), "utf8");
  } catch (err) {
    console.error("[telar-desktop] failed to persist update prefs:", err.message);
  }
}

let updaterWindow = null;
function broadcastUpdateStatus(status, extra = {}) {
  const win = updaterWindow || BrowserWindow.getAllWindows()[0];
  win?.webContents.send("telar:updates:status", { status, ...extra });
}

// A packaged build only has a real feed to talk to when --publish-r2 baked both
// the proxy URL and its key in together; without the key the publish.url is
// still the package.json placeholder, so checking would only ever produce a
// DNS error. That makes the key the honest test for "updates are available
// here at all" — both for the automatic checks and for the Settings button.
function updatesConfigured() {
  return app.isPackaged && Boolean(updateProxyKey());
}

function checkForUpdates() {
  // The 'error' event already reports failures to the UI; this catch only stops
  // a background check's rejection from surfacing as an unhandled rejection.
  return autoUpdater.checkForUpdates().catch(() => null);
}

// Long enough to be invisible on a working day, short enough that a nightly
// lands the same day it is published.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// WHY THERE IS A LOG AT ALL. The install race above produced no error, no
// dialog and no console output — the app simply relaunched on the same version,
// and the only way it got diagnosed was a user toggling a setting and noticing
// the difference. electron-updater reports its whole lifecycle to a logger and
// had none attached, so all of it was being discarded.
//
// A file rather than console: a packaged mac app's stdout goes nowhere anyone
// can read. Kept in userData beside the other per-install state, appended, and
// deliberately not rotated — the volume is a handful of lines per check.
function updateLogPath() {
  return path.join(app.getPath("userData"), "update.log");
}

function updateLogger() {
  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
    try {
      require("node:fs").appendFileSync(updateLogPath(), line);
    } catch {
      /* logging must never be the reason an update fails */
    }
    console.log(`[telar-updates] ${level} ${message}`);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    debug: () => {}, // electron-updater's debug is very chatty; not useful here
  };
}

function applyUpdatePrefs(prefs) {
  // `channel` is electron-updater's own switch for WHICH feed file it fetches
  // (beta-mac.yml vs nightly-mac.yml) from the same publish URL, which is
  // exactly how build-desktop.sh publishes them — one bucket, one proxy, a feed
  // per channel. So switching streams is a client-side choice and needs no
  // reinstall and no second build.
  autoUpdater.channel = prefs.channel;
  // The user's answer to "install it for me when I quit, or wait for my click".
  // Downloading stays automatic either way; what this decides is whether
  // quitting is also consent to install.
  autoUpdater.autoInstallOnAppQuit = prefs.installOnQuit;
}

function configureAutoUpdater() {
  autoUpdater.logger = updateLogger();
  autoUpdater.autoDownload = true;
  applyUpdatePrefs(readUpdatePrefs());
  const key = updateProxyKey();
  if (key) autoUpdater.requestHeaders = { "X-Telar-Update-Key": key };

  // electron-updater's download-progress payload carries only transfer figures
  // (percent/bytesPerSecond/transferred/total) — never a version. The preceding
  // update-available event is the only place the version is known, so it's held
  // here and threaded onto every downloading broadcast rather than left absent.
  let pendingVersion = null;
  autoUpdater.on("checking-for-update", () => broadcastUpdateStatus("checking"));
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    broadcastUpdateStatus("available", { version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => broadcastUpdateStatus("not-available", { version: info.version }));
  autoUpdater.on("download-progress", (progress) =>
    broadcastUpdateStatus("downloading", { percent: progress.percent, version: pendingVersion ?? undefined }),
  );
  autoUpdater.on("update-downloaded", (info) => broadcastUpdateStatus("downloaded", { version: info.version }));
  autoUpdater.on("error", (err) =>
    broadcastUpdateStatus("error", { message: err && err.message ? err.message : String(err) }),
  );

  if (!updatesConfigured()) return;
  void checkForUpdates();
  const timer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  timer.unref?.(); // a pending check must never be the reason the app stays alive
}

ipcMain.handle("telar:updates:check", async () => {
  if (!updatesConfigured()) return { status: "unsupported" };
  await checkForUpdates();
  return { status: "checking" };
});
ipcMain.handle("telar:updates:install", () => {
  if (!app.isPackaged) return;
  // AN EXPLICIT INSTALL MUST NOT RACE THE ON-QUIT INSTALLER.
  //
  // `quitAndInstall()` stages the update and then quits. With
  // autoInstallOnAppQuit ON, electron-updater has ALSO registered an installer
  // on the app's own quit event — so that quit fires a second install while
  // Squirrel is mid-swap. Observed symptom, reported 2026-08-06: pressing
  // "Install & restart" relaunched the app on the SAME version, over and over,
  // with no error anywhere; turning the setting off made the identical button
  // work first time. That is the two paths colliding, not a broken download.
  //
  // Turning the flag off here is in-memory only and lasts exactly as long as
  // this process, which is about to end. The stored preference is untouched and
  // is re-applied from disk on the next launch, so a user who wants unattended
  // installs keeps them — they simply do not also get one when they asked for
  // an attended one.
  autoUpdater.autoInstallOnAppQuit = false;
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
});

ipcMain.handle("telar:updates:getPrefs", () => ({
  ...readUpdatePrefs(),
  channels: UPDATE_CHANNELS,
  // Surfaced so the log is findable without knowing where userData lives — the
  // point of writing it is that someone can read it when an update misbehaves.
  logPath: updateLogPath(),
  // So the settings surface can explain itself rather than offering controls
  // that silently do nothing on an unpublished local build.
  configured: updatesConfigured(),
}));

ipcMain.handle("telar:updates:setPrefs", (_event, patch) => {
  const current = readUpdatePrefs();
  const next = {
    channel:
      typeof patch?.channel === "string" && UPDATE_CHANNELS.includes(patch.channel)
        ? patch.channel
        : current.channel,
    installOnQuit: typeof patch?.installOnQuit === "boolean" ? patch.installOnQuit : current.installOnQuit,
  };
  writeUpdatePrefs(next);
  applyUpdatePrefs(next);
  // A CHANNEL CHANGE RE-CHECKS IMMEDIATELY, because the alternative is a
  // control that appears to do nothing for up to six hours. Switching from
  // nightly to beta is a request to find out what is on beta, now — and the
  // check is what turns the choice into a visible answer.
  if (next.channel !== current.channel && updatesConfigured()) void checkForUpdates();
  return next;
});

// --- (f) Teardown ------------------------------------------------------------
function killServer() {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    serverChild = null;
  }
}
function closeBrowserControl() {
  const control = browserControl;
  browserControl = null;
  if (control) void control.close();
}
app.on("will-quit", () => {
  killServer();
  closeBrowserControl();
});
process.on("exit", killServer);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killServer();
    process.exit(0);
  });
}

// --- Smoke mode (no window, ever) -------------------------------------------
async function runSmoke() {
  try {
    let port;
    if (OVERRIDE_URL) {
      const u = new URL(OVERRIDE_URL);
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    } else {
      captureLoginShellEnv();
      port = await findFreePort();
      startServer(port);
    }
    await waitForServer(port);
    console.log(`BUILD ${windowTitle()}`);
    console.log("SMOKE_OK");
    // Verify the bundled @playwright/mcp cli.js the packaged Verifier depends on
    // actually shipped. Packaged: a hard failure (the Verifier can't drive a
    // browser without it). Dev-repo: best-effort — the walk-up resolver, not the
    // bundle, is the real path there.
    const fs = require("node:fs");
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
    // Verify the claude-agent-sdk native CLI binary shipped and actually runs. Resolve it the
    // same way the SDK will (createRequire(sdk.mjs)) and execute --version (zero-quota, no agent
    // turn). Packaged: fail-closed — a Claude session can't start without it. Dev-repo:
    // best-effort, the repo install is the real path there.
    const claudeBin = resolveBundledClaudeBinary();
    let claudeOk = false;
    if (claudeBin && fs.existsSync(claudeBin)) {
      try {
        execFileSync(claudeBin, ["--version"], { stdio: "ignore", timeout: 20_000 });
        claudeOk = true;
      } catch (e) {
        console.error("CLAUDE_BIN_EXEC_FAIL:", claudeBin, e && e.message ? e.message : e);
      }
    } else {
      console.error("CLAUDE_BIN_MISSING:", claudeBin || "(unresolved)");
    }
    if (claudeOk) {
      console.log("CLAUDE_BIN_OK");
    } else if (app.isPackaged) {
      app.isQuitting = true;
      killServer();
      app.exit(1);
      return;
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

// --- Main --------------------------------------------------------------------
if (SMOKE) {
  // Never take the single-instance lock or create a window in smoke mode.
  app.on("window-all-closed", () => {}); // no-op; there are no windows
  app.whenReady().then(runSmoke);
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
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
        applyDevelopmentAppIcon();
        buildApplicationMenu();
        const configuredControlPort = Number(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT);
        browserControlConfig = {
          port: Number.isInteger(configuredControlPort) && configuredControlPort > 0
            ? configuredControlPort
            : await findFreePort(),
          token: process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim() || randomUUID(),
        };
        browserControl = await startBrowserControlServer({
          ...browserControlConfig,
          getBrowserManager: () => browserManager,
        });
        let url = OVERRIDE_URL;
        if (!url) {
          captureLoginShellEnv();
          const port = await getStablePort();
          startServer(port);
          await waitForServer(port);
          url = `http://127.0.0.1:${port}/`;
        }
        updaterWindow = createWindow(url);
        configureAutoUpdater();
        app.on("activate", () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
        });
      } catch (err) {
        console.error("[telar-desktop] failed to start:", err);
        app.quit();
      }
    });

    app.on("window-all-closed", () => {
      app.isQuitting = true;
      app.quit(); // macOS convention would keep the app; viable tier quits.
    });
  }
}
