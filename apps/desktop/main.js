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
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { DesktopBrowserManager, createExternalLinkPolicy } = require("./browser-manager");
const { startBrowserControlServer } = require("./browser-control-server");
const { COMMAND_KEY_BINDINGS } = require("./command-keys");
const { macWindowChrome } = require("./window-chrome");

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
} else if (!app.isPackaged) {
  /**
   * A DEV SHELL AND AN INSTALLED TELAR MUST BOTH BE ABLE TO RUN.
   *
   * The rule above was already written for the E2E shell and is the same rule:
   * the lock is scoped through userData. The dev shell simply never got it, and
   * once `productName` made both resolve `app.getName()` to "Telar", they
   * shared a directory and therefore a lock. Whichever started first won, and
   * the loser called `app.quit()` — no window, no output, no crash report. It
   * looked exactly like a broken build, and cost an afternoon proving it was
   * not one.
   *
   * The engine store is NOT affected: `scripts/dev.mjs` always exports
   * TELAR_HOME (~/.telar-dogfood by default) and `telarHome()` prefers it, so
   * dogfood sessions stay where they are. What moves is this shell's own
   * Chromium state and its two small JSON files — a one-time reset of dev
   * localStorage, which is the price of the two coexisting.
   *
   * THE NAME MOVES TOO, but expect less of it than it sounds: on macOS the
   * process and menu-bar name come from the BUNDLE, so a dev shell still shows
   * as "Electron" — measured, not assumed. What this changes is
   * `app.getName()` and the places derived from it, which is enough to keep the
   * userData default consistent with the explicit path set below.
   */
  app.setName("Telar (dev)");
  app.setPath("userData", path.join(app.getPath("appData"), "Telar (dev)"));
}

let serverChild = null;
let engineChild = null;
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
    : [path.join(__dirname, "..", "web", ".next-desktop", "standalone", "build-info.json")];
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
  if (!app.isPackaged) return "Telar Dev";
  const info = readBuildInfo();
  return info && info.shortSha ? `Telar ${info.shortSha}` : "Telar";
}

function developmentIconPath() {
  if (app.isPackaged) return undefined;
  // The AMBER loom, not the blue one: a dev shell wearing the production
  // icon is indistinguishable in the dock from the installed app — the same
  // rule as iOS's AppIconDev.
  for (const name of ["icon-dev.png", "icon.png"]) {
    const icon = path.join(__dirname, "build", name);
    if (fs.existsSync(icon)) return icon;
  }
  return undefined;
}

function applyDevelopmentAppIcon() {
  const icon = developmentIconPath();
  if (icon && process.platform === "darwin" && app.dock) app.dock.setIcon(icon);
  return icon;
}

// --- Bundled @playwright/mcp CLI --------------------------------------------
// build-app.sh materializes a self-contained, symlink-dereferenced @playwright/
// mcp closure (cli.js + playwright/playwright-core) beside the engine bundle,
// which electron-builder copies to <Resources>/engine/playwright-mcp. The ENGINE
// is what spawns it (src/browser/transport.ts), so it ships with the engine.
function bundledPlaywrightMcpCli() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js")
    : path.join(__dirname, "..", "engine", "dist", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js");
}

// --- Bundled Agent SDK ------------------------------------------------------
// The engine bundle keeps `@anthropic-ai/claude-agent-sdk` EXTERNAL and resolves
// it from disk beside itself, so a missing copy is a Claude session that cannot
// start. --smoke proves it is there.
//
// WHAT IS DELIBERATELY NOT HERE ANY MORE: a check for the SDK's ~272MB native
// CLI binary. This app used to ship it and fail --smoke without it. It does not
// ship it now — the engine resolves the USER's Claude Code and refuses the turn
// with an actionable message when there is none (apps/engine/src/cli-resolution.ts).
// Whether a given machine has Claude Code installed is not a property of the
// bundle, and asserting it here would fail every release build on a CI runner
// that has no reason to have one.
function bundledAgentSdkEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")
    : path.join(__dirname, "..", "engine", "dist", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
}

// --- Resolve the engine bundle ----------------------------------------------
// Dev-repo layout:  apps/engine/dist/engine.mjs
// Packaged layout:  <Resources>/engine/engine.mjs   (extraResources)
function resolveEngineJs() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "engine", "engine.mjs")]
    : [path.join(__dirname, "..", "engine", "dist", "engine.mjs")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `engine bundle not found (looked in: ${candidates.join(", ")}). Run \`bun run build:app\` first.`,
  );
}

// --- Resolve the standalone server.js ---------------------------------------
// Dev-repo layout:  apps/web/.next-desktop/standalone/apps/web/server.js
// Packaged layout:  <Resources>/standalone/apps/web/server.js  (extraResources)
function resolveServerJs() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "standalone", "apps", "web", "server.js")]
    : [path.join(__dirname, "..", "web", ".next-desktop", "standalone", "apps", "web", "server.js")];
  const fs = require("node:fs");
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `standalone server.js not found (looked in: ${candidates.join(", ")}). ` +
      `Run \`bun run build:app\` first.`,
  );
}

// --- Where this install keeps its state -------------------------------------
/**
 * TELAR_HOME FOR A PACKAGED APP, decided once and shared by both children.
 *
 * `app.getPath("userData")` — ~/Library/Application Support/Telar on macOS — is
 * chosen over `~/.telar` because that dotdir belongs to the LEGACY product and
 * has a completely different layout inside it. The engine refuses to open it at
 * all (apps/engine/src/state.ts), which is the guard that stops a canon build
 * from writing `sessions/` on top of somebody's old install. The engine takes an
 * `engine/` subtree inside this directory rather than the directory itself,
 * because Electron already owns files here (Cache/, Local Storage/,
 * update-prefs.json, server-port.json).
 *
 * AN EXPLICIT TELAR_HOME STILL WINS — it is how the dev stack points a packaged
 * build at a dogfood store, and overruling it would make that untestable.
 *
 * SMOKE ALWAYS GETS A THROWAWAY. A smoke boot is a REAL engine, and its boot
 * reconciliation marks any in-flight turn it does not own as failed — so
 * verifying a build against the user's own store would kill their live sessions.
 */
let smokeHome = null;
function telarHome() {
  if (SMOKE) {
    smokeHome ??= fs.mkdtempSync(path.join(os.tmpdir(), "telar-smoke-"));
    return smokeHome;
  }
  return process.env.TELAR_HOME?.trim() || app.getPath("userData");
}

/**
 * In packaged Electron there is no separate node binary — run an Electron binary
 * as node via ELECTRON_RUN_AS_NODE. On macOS the MAIN binary still registers
 * with LaunchServices as a Foreground app even under RUN_AS_NODE, putting a
 * second, dead "Telar" in the Dock per child. The Helper binary is LSUIElement
 * in its Info.plist — same runtime, no Dock entry — so prefer it when packaged.
 */
function nodeExecPath() {
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
    if (fs.existsSync(helper)) return helper;
  }
  return process.execPath;
}

/** What both children need to reach the tools this app does not bundle. */
function childEnv(home) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    TELAR_HOME: home,
    ...(browserControlConfig
      ? {
          TELAR_DESKTOP_BROWSER_CONTROL_PORT: String(browserControlConfig.port),
          TELAR_DESKTOP_BROWSER_CONTROL_TOKEN: browserControlConfig.token,
        }
      : {}),
  };
}

// --- (c0) Boot the engine daemon as a child ---------------------------------
/**
 * THE APP HAS A BACK END NOW, and this is it.
 *
 * The cockpit is only an authenticated engine client: every route handler it
 * serves proxies to this daemon, discovered through a document the daemon writes
 * under TELAR_HOME. Shipping the web tier alone produces an app where every page
 * loads and every action answers `engine_unavailable`.
 *
 * ONE PROCESS, DAEMON AND WORKER. `TELAR_EMBEDDED_WORKER` defaults on, so this
 * child both accepts turns and executes them. The out-of-process worker still
 * exists for the deployment that wants provider crashes kept out of the control
 * plane; a desktop app is not that deployment.
 */
function startEngineChild(home) {
  const engineJs = resolveEngineJs();
  engineChild = fork(engineJs, [], {
    cwd: path.dirname(engineJs),
    execPath: nodeExecPath(),
    // Same lifetime tie as the Next server: the preload self-exits when our IPC
    // channel closes, so a SIGKILL or native crash of this process cannot orphan
    // a daemon holding a LISTEN socket and the store's lock.
    execArgv: ["--require", path.join(__dirname, "server-preload.js")],
    env: {
      ...childEnv(home),
      NODE_ENV: "production",
      // @playwright/mcp is neither traced into the bundle nor on a
      // Finder-launched app's PATH, so the engine's walk-up resolver would find
      // nothing. Point it at the bundled cli.js unless the user already named
      // one — their choice wins. Dev-repo runs are left alone: the walk-up
      // resolves the repo's own install there.
      ...(app.isPackaged && !process.env.TELAR_PLAYWRIGHT_MCP_BIN
        ? { TELAR_PLAYWRIGHT_MCP_BIN: bundledPlaywrightMcpCli() }
        : {}),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  engineChild.on("exit", (code, signal) => {
    engineChild = null;
    // The cockpit without the engine is a window full of errors. Quit rather
    // than leave one standing.
    if (!SMOKE && !app.isQuitting) {
      console.error(`[telar-desktop] engine exited (code=${code} signal=${signal})`);
      app.quit();
    }
  });
  return engineChild;
}

/**
 * Wait until the engine is actually answering, not merely spawned.
 *
 * TWO STEPS, because there are two ways to be not-ready and they need different
 * waits: the discovery document does not exist yet (the daemon is still
 * starting), and it exists but names a port nothing is listening on yet. Reading
 * the token and asking `/v2/health` covers both, and proves the SAME thing the
 * cockpit will need a moment later — a stale document from a previous run is
 * caught here rather than as a mystifying 503 on the first page load.
 */
function waitForEngine(home, { timeoutMs = 30_000, intervalMs = 150 } = {}) {
  // The subdirectory `engineRootFromEnv` composes in apps/engine/src/state.ts,
  // and the same one the cockpit reads. Three places know this name; a test in
  // this app pins that they agree.
  const discoveryFile = path.join(home, "engine", "engine.json");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let discovery = null;
      try {
        discovery = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      } catch {
        /* not written yet, or half-written — retry */
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
            response.resume();
            if (response.statusCode === 200) return resolve(discovery);
            retry();
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
      if (Date.now() >= deadline) reject(new Error(`engine did not become healthy within ${timeoutMs}ms`));
      else setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// --- (c) Boot the standalone server as a child ------------------------------
function startServer(port, home) {
  const serverJs = resolveServerJs();
  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    execPath: nodeExecPath(),
    // Tie the child's lifetime to ours: the preload self-exits when our IPC
    // channel closes, so a SIGKILL / native crash of this main process (which
    // runs none of the cleanup handlers below) can't orphan the Next server.
    execArgv: ["--require", path.join(__dirname, "server-preload.js")],
    env: {
      ...childEnv(home),
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // THE LAUNCHER MARKER. The cockpit's server-side engine discovery refuses
      // to resolve a state root unless it is set (apps/web/lib/engine/
      // engine-server.ts), which is what keeps a stray `next start` from
      // pointing at somebody's store. The shell IS a launcher, so it says so.
      TELAR_COCKPIT: "1",
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

/**
 * TELAR OWNS THE TOP OF ITS OWN WINDOW, on macOS only.
 *
 * `hiddenInset` removes the titlebar and keeps the traffic lights, which is the
 * only combination that lets the app's own header BE the titlebar — the rail's
 * wordmark and collapse trigger move up into the row the system was spending on
 * an empty grey strip and a title nobody reads. The renderer marks its headers
 * as drag regions (`app-drag`, in globals.css) so the window still moves, zooms
 * on double-click and snaps exactly as before.
 *
 * The offsets and the platform rule live in ./window-chrome.js, next to the
 * header height they are derived from.
 */
function createWindow(url) {
  const title = windowTitle();
  const icon = developmentIconPath();
  // Vibrancy at construction when the preference asks for it — see the
  // appearance-preference block above. `followWindow` keeps the blur honest
  // when the app is in the background instead of freezing a stale frame.
  lastWindowUrl = url;
  const uiPrefs = readUiPrefs();
  const translucent = supportsTranslucency() && uiPrefs.translucent;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: translucent ? "#00000000" : "#0a0a0a",
    // `transparent: true` is what actually marks the NSWindow non-opaque. An
    // alpha backgroundColor alone leaves the window server believing the layer
    // is opaque, so it skips clearing it — and every resize or navigation
    // leaves the previous frame composited under the new one.
    //
    // `hasShadow: false` because ACTIVATION REGENERATES THE SHADOW — key and
    // inactive windows wear different ones — and recomputing a shadow from a
    // transparent window's alpha is the one native repaint that visibly
    // blinks on every alt-tab back in. A CDP screencast proved the renderer
    // paints nothing during the flicker, so it had to be a native layer, and
    // the shadow is the only one that changes with key status. Translucent
    // windows barely show a shadow anyway.
    ...(translucent ? { transparent: true, hasShadow: false } : {}),
    // "hud" is the most TRANSPARENT of macOS's vibrancy materials —
    // "under-window" (the obvious choice) is also the milkiest, and buried the
    // desktop no matter how far the strength slider went.
    // `active`, NOT `followWindow`: followWindow deactivates the material when
    // the window loses focus — alt-tab away and the glass turns opaque, come
    // back and it flickers through the state transition. A window whose look
    // changes with focus reads as a bug, so the material stays active.
    ...(translucent && uiPrefs.frost !== "clear" ? { vibrancy: "hud", visualEffectState: "active" } : {}),
    show: false,
    title,
    ...macWindowChrome(),
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      // The renderer half of the anti-flicker pair (see Main): a throttled
      // renderer hands the compositor nothing to show at refocus.
      ...(translucent ? { backgroundThrottling: false } : {}),
    },
  });
  // Whether THIS window's compositor can blend alpha — decided above, at
  // construction, which is why applyTranslucency has a rebuild path at all.
  win.telarTranslucentCapable = translucent;
  // Captured, not read from the global at close time: during a translucency
  // rebuild the OLD window closes after the NEW one exists, and destroying
  // whatever the global points to then would kill the replacement's manager.
  const manager = new DesktopBrowserManager(win);
  browserManager = manager;
  // The window's own URL is what "the app's own UI" means — it is the same
  // origin in dev-repo, packaged and TELAR_DESKTOP_URL modes, so nothing here
  // has to guess a port or a hostname. An unusable one throws, and createWindow
  // runs inside whenReady's try/catch, which logs and quits.
  applyExternalLinkPolicy(win.webContents, () => createExternalLinkPolicy({ appUrl: url }));
  // A native WebContentsView outlives a renderer reload and React never gets a
  // cleanup pass in that path. Hide it before the document is replaced; the
  // remounted Browser surface will publish fresh bounds and make it visible.
  win.webContents.on("did-start-loading", () => {
    manager.hideVisibleScope();
  });
  win.on("closed", () => {
    manager.destroy();
    if (browserManager === manager) browserManager = null;
  });
  // Keep the build stamp in the title bar — don't let the loaded page's <title>
  // overwrite it (that's how you answer "which build am I running?").
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(title);
  });
  /**
   * A DEAD LOAD RETRIES INSTEAD OF STRANDING ON THE ERROR PAGE.
   *
   * In dev the cockpit is a Next server that restarts whenever a file it
   * watches changes, and a reload landing in that window fails outright. The
   * shell had no `did-fail-load` handler, so the app sat on Chromium's "This
   * page couldn't load" until someone restarted it by hand — while the server
   * it was waiting for came back a second later.
   *
   * ONLY THE MAIN FRAME AND ONLY OUR OWN URL. A subframe failing is the page's
   * business, and reloading the window for it would fight the page. `-3` is
   * ERR_ABORTED, which is what a navigation cancelled ON PURPOSE reports —
   * including one the external-link policy just declined — so retrying it would
   * undo that decision in a loop.
   */
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
// source of truth apps/web/lib/command-keys.ts also reads, by relative
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

// The userData directory this app used before `productName` was set in
// package.json. `build.productName` already named the BUNDLE "Telar", but
// `app.getName()` falls back to package.json `name` — so the data directory was
// "telar-desktop" while the app in /Applications was Telar.app.
const LEGACY_USER_DATA_NAME = "telar-desktop";

/**
 * ADOPT THE PREVIOUS INSTALL'S UPDATE PREFERENCES, ONCE.
 *
 * WITHOUT THIS, SHIPPING THE RENAME SILENTLY MOVES EVERY EXISTING INSTALL TO
 * THE DEFAULT CHANNEL. The app on this machine is on `nightly`;
 * `DEFAULT_UPDATE_PREFS.channel` is `beta`. The new build reads a different
 * directory, finds nothing, and defaults — so a nightly user takes exactly one
 * more update and then goes quiet on a stream they never chose. Nothing errors,
 * and the only visible symptom is updates that stop arriving.
 *
 * ONLY THIS FILE. The rest of the old directory is Chromium's — caches, Local
 * Storage, cookies — and copying a leveldb between profiles to preserve a theme
 * choice is a bad trade. localStorage resets once; that is a fresh origin doing
 * what a fresh origin does, and it is cosmetic.
 *
 * NEVER OVERWRITES, so it is a no-op on every run after the first and on a
 * genuinely new install.
 */
function adoptLegacyUpdatePrefs() {
  const fs = require("node:fs");
  try {
    if (fs.existsSync(updatePrefsPath())) return;
    const legacy = path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME, "update-prefs.json");
    if (!fs.existsSync(legacy)) return;
    // Read through the validating reader rather than copying bytes: the old
    // file is as user-editable as the new one, and a bad channel name adopted
    // verbatim would point electron-updater at a feed that does not exist.
    const raw = JSON.parse(fs.readFileSync(legacy, "utf8"));
    const prefs = {
      channel: UPDATE_CHANNELS.includes(raw.channel) ? raw.channel : DEFAULT_UPDATE_PREFS.channel,
      installOnQuit: raw.installOnQuit === true,
    };
    writeUpdatePrefs(prefs);
    console.log(`[telar-desktop] adopted update preferences from the previous install (channel ${prefs.channel})`);
  } catch (err) {
    // A first run that cannot read the old directory is a first run, not a
    // crash. The default channel is a survivable wrong answer; failing to start
    // is not.
    console.error("[telar-desktop] could not adopt previous update preferences:", err.message);
  }
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

// --- Window appearance preference (userData, same idiom as updates) ----------
//
// TRANSLUCENCY IS A WINDOW-CREATION FACT. The renderer owns the look —
// globals.css keys alpha surfaces off `data-translucent`, and the settings
// pane owns the toggle — but a vibrancy layer has to exist UNDER the page for
// that alpha to reveal anything, and Electron attaches it most reliably at
// construction. So the preference is persisted here, read when the window is
// built, and applied live to open windows when it changes.
//
// macOS only: vibrancy is NSVisualEffectView. Everywhere else `supported` is
// false and the cockpit hides the control.
const DEFAULT_UI_PREFS = { translucent: false, frost: "blur" };

function uiPrefsPath() {
  return path.join(app.getPath("userData"), "ui-prefs.json");
}

function readUiPrefs() {
  const fs = require("node:fs");
  try {
    const raw = JSON.parse(fs.readFileSync(uiPrefsPath(), "utf8"));
    // "clear" drops the vibrancy layer: crisp desktop, tinted only by the
    // page's own wash. "blur" is the frosted NSVisualEffectView.
    return { translucent: raw.translucent === true, frost: raw.frost === "clear" ? "clear" : "blur" };
  } catch {
    // Missing / corrupt / unreadable — first run, never a crash.
    return { ...DEFAULT_UI_PREFS };
  }
}

function writeUiPrefs(prefs) {
  const fs = require("node:fs");
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(uiPrefsPath(), JSON.stringify(prefs), "utf8");
  } catch (err) {
    console.error("[telar-desktop] failed to persist ui prefs:", err.message);
  }
}

function supportsTranslucency() {
  return process.platform === "darwin";
}

/**
 * TRANSPARENCY IS A CREATION-TIME FACT IN CHROMIUM. `setBackgroundColor
 * ("#00000000")` on a window born opaque does not re-plumb the compositor: the
 * page starts painting alpha into a buffer that is never cleared, and every
 * previously-shown frame ghosts through — navigate Settings → session and the
 * settings pane stays visible behind the transcript. So turning translucency ON
 * over an opaque window REBUILDS the window (same URL, same bounds; the new one
 * is shown before the old is destroyed, or `window-all-closed` would quit the
 * app in the gap). Turning it OFF is safe live — an opaque page repaints every
 * pixel — and a window BUILT translucent can toggle both ways live.
 */
function applyTranslucency(on, frost) {
  const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (on && wins.some((win) => !win.telarTranslucentCapable)) {
    recreateWindowTranslucent(wins[0]);
    return;
  }
  for (const win of wins) {
    try {
      // Frost changes are safe live in BOTH directions — attaching or removing
      // the effect view does not re-plumb the compositor the way opacity does.
      // "hud" over "under-window": the clearest material macOS offers.
      win.setVibrancy(on && frost !== "clear" ? "hud" : null);
      // The opaque colour is the app's darkest canvas, matching createWindow's
      // — a translucent window turned opaque again must not flash white first.
      win.setBackgroundColor(on ? "#00000000" : "#0a0a0a");
    } catch (err) {
      console.error("[telar-desktop] failed to retint a window:", err.message);
    }
  }
}

function recreateWindowTranslucent(old) {
  const target = old?.webContents.getURL() || lastWindowUrl;
  if (!target) return;
  const bounds = old?.getBounds();
  // createWindow reads the just-written pref, so the replacement is BORN
  // translucent — the one thing the live path cannot do.
  const win = createWindow(target);
  if (bounds) win.setBounds(bounds);
  updaterWindow = win;
  win.once("ready-to-show", () => {
    if (old && !old.isDestroyed()) old.destroy();
  });
}

// So a rebuilt window knows where to point itself if the old one's webContents
// is already gone.
let lastWindowUrl = null;

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

/**
 * THE VIBRANCY MATERIAL FOLLOWS TELAR'S THEME, NOT THE OS'S. The blur layer's
 * tint comes from the window's effective appearance, which Electron takes from
 * nativeTheme — by default the OS setting. Telar dark on a light Mac (or the
 * reverse) then composites a dark wash over a bright frost and reads as milk.
 * The cockpit reports its scheme here (theme-provider.tsx) and the shell keeps
 * nativeTheme in agreement.
 */
ipcMain.handle("telar:appearance:setTheme", (_event, theme) => {
  if (theme === "light" || theme === "dark" || theme === "system") nativeTheme.themeSource = theme;
});

// The window-appearance half of Settings → Appearance. `get` answers whether
// this platform can do it at all, so the cockpit hides rather than disables
// the control where it would be a lie.
ipcMain.handle("telar:appearance:get", () => ({ ...readUiPrefs(), supported: supportsTranslucency() }));

ipcMain.handle("telar:appearance:set", (_event, patch) => {
  const current = readUiPrefs();
  const next = {
    translucent: typeof patch?.translucent === "boolean" ? patch.translucent : current.translucent,
    frost: patch?.frost === "clear" || patch?.frost === "blur" ? patch.frost : current.frost,
  };
  writeUiPrefs(next);
  // Applied to the OPEN windows too: a preference that only takes effect on
  // the next launch reads as a broken toggle.
  if (supportsTranslucency()) applyTranslucency(next.translucent, next.frost);
  return { ...next, supported: supportsTranslucency() };
});

// --- (f) Teardown ------------------------------------------------------------
/**
 * BOTH CHILDREN, and the engine LAST.
 *
 * The cockpit proxies to the engine, so killing the engine first leaves a live
 * server answering `engine_unavailable` for however long the shutdown takes. The
 * engine also holds the store's lock and reconciles in-flight turns on the way
 * out; giving it the later signal means it is not doing that while a request is
 * still arriving.
 */
function killServer() {
  for (const [name, child] of [["server", serverChild], ["engine", engineChild]]) {
    if (!child || child.killed) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (name === "server") serverChild = null;
    else engineChild = null;
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
      const home = telarHome();
      startEngineChild(home);
      // PROVES THE ENGINE, NOT JUST ITS FILE. A bundle can be present and still
      // fail to boot — a bad import in the bundled graph, a store it cannot
      // open. `/v2/health` answering is the difference between "the file
      // shipped" and "the app has a back end".
      await waitForEngine(home);
      console.log("ENGINE_OK");
      port = await findFreePort();
      startServer(port, home);
    }
    await waitForServer(port);
    console.log(`BUILD ${windowTitle()}`);
    console.log("SMOKE_OK");
    // Verify the bundled @playwright/mcp cli.js the engine's browser depends on
    // actually shipped. Packaged: a hard failure (no browser tools without it).
    // Dev-repo: best-effort — the walk-up resolver, not the bundle, is the real
    // path there.
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
    // The Agent SDK is kept EXTERNAL to the engine bundle, so a Claude session
    // cannot start without this file beside it. Packaged: fail-closed.
    //
    // WHAT THIS DELIBERATELY NO LONGER CHECKS is the SDK's ~272MB native CLI
    // binary. The app does not ship one; the engine resolves the USER's Claude
    // Code install and refuses the turn with an actionable message when there is
    // none. Asserting an install here would fail every release build on a CI
    // runner that has no reason to have one — and would be asserting a property
    // of the machine, not of the artefact this command exists to verify.
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

// --- Main --------------------------------------------------------------------

/**
 * TRANSLUCENCY STAYS ON THE GPU. An earlier cut ran it on software
 * compositing to beat ghosting — but the ghosting's real cause was the window
 * never being MARKED transparent (`transparent: true` in createWindow), and
 * once that landed the CPU path only bought a new bug: a large transparent
 * window redisplaying on focus takes long enough in software that macOS shows
 * a bad frame first — the activation flicker. What survives of that era is
 * the occlusion switch: Chromium stops drawing a fully-covered window and
 * evicts its frame, and a transparent window shows the eviction on refocus.
 */
if (supportsTranslucency() && readUiPrefs().translucent) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

if (SMOKE) {
  // Never take the single-instance lock or create a window in smoke mode.
  app.on("window-all-closed", () => {}); // no-op; there are no windows
  app.whenReady().then(runSmoke);
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // SAY WHOSE LOCK IT WAS. Quitting silently here is correct behaviour and
    // was also completely unreadable: an app that exits with no window, no
    // output and no crash report is indistinguishable from one that crashed on
    // its first line. Naming the directory the lock is scoped to is enough to
    // find the other instance — and to notice when it is a DIFFERENT build of
    // Telar rather than a second copy of this one.
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
        applyDevelopmentAppIcon();
        buildApplicationMenu();
        // Before anything reads the update preferences, and before the updater
        // is configured with a channel.
        adoptLegacyUpdatePrefs();
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
          // THE ENGINE FIRST, AND WAITED FOR. The cockpit's server components
          // ask the engine for the session list while rendering the first page;
          // starting them together means that first paint races a daemon that
          // may not be listening yet, and loses often enough to be the thing
          // people report as "it opens empty sometimes".
          const home = telarHome();
          startEngineChild(home);
          await waitForEngine(home);
          const port = await getStablePort();
          startServer(port, home);
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
