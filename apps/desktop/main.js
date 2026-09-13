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
const { randomBytes, randomUUID } = require("node:crypto");
const { fork, execFileSync } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } = require("electron");
const { autoUpdater, CancellationToken } = require("electron-updater");
const { DesktopBrowserManager, managerForScope, createExternalLinkPolicy, externalOpenTarget } = require("./browser-manager");
const { attachHostHeader } = require("./host-header");
const { startBrowserControlServer } = require("./browser-control-server");
const tailscale = require("./tailscale");
const { COMMAND_KEY_BINDINGS } = require("./command-keys");
const { macWindowChrome } = require("./window-chrome");
const { windowTargetUrl } = require("./window-target");
const { ExtensionHost, extensionsEnabled } = require("./extension-host");
const { createBrowserSuggestions } = require("./browser-suggestions");
const { readProfileRegistry } = require("./browser-profiles");
const { createTabStore } = require("./browser-tab-store");
const { resolveHelperExec } = require("./helper-exec");
const devUpdate = require("./dev-update");
const updateWatchdog = require("./update-watchdog");
const { wireLoginOffer } = require("./login-offer-window");
const { discoverOpeners, openWith } = require("./workspace-openers");

const SMOKE = process.argv.includes("--smoke");

/**
 * A DEV-PACKAGED BUILD IS A SEPARATE APP, NOT A FLAVOUR OF THE INSTALLED ONE.
 *
 * `scripts/package-desktop.sh --dev` bakes `telarDev: true` into the packaged
 * package.json (electron-builder's extraMetadata) beside a distinct productName
 * and appId. Reading it HERE, before anything else, is what keeps that build
 * from colliding with the installed Telar when launched from inside it: a shell
 * an agent session opens carries the live app's TELAR_HOME and
 * TELAR_DESKTOP_URL, and honouring either would point the dev build at the
 * live store — or at the live server, so the window would show the installed
 * app's cockpit wearing the dev build's name. So in this mode both are IGNORED
 * (not merely defaulted), the home is always appData/<productName>, and the
 * updater is off outright. Nothing else about the build changes.
 */
const DEV_BUILD = (() => {
  try {
    return require("./package.json").telarDev === true;
  } catch {
    return false;
  }
})();
const OVERRIDE_URL = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_URL;
// Dropped in a dev build for the same reason: an inherited E2E directory would
// move the dedicated home — and the lock — somewhere else. Smoke is unaffected.
const E2E_USER_DATA = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_E2E_USER_DATA?.trim();

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
} else if (DEV_BUILD) {
  // Explicit rather than trusting productName alone: the directory is the
  // single-instance lock's scope AND (below) TELAR_HOME, so it must be the dev
  // build's own whatever the bundle happens to be called.
  app.setPath("userData", path.join(app.getPath("appData"), "Telar Dev"));
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
/**
 * THE BROWSER HOST BELONGS TO A WINDOW, NOT TO THE APP.
 *
 * One global was true while the app had one window. "Open in a new window"
 * (telar:app:open-window) makes it false: a second `createWindow` builds a
 * second manager with its own native views, and every panel request — bounds,
 * visibility, a new tab — would have landed on whichever window was created
 * LAST, moving one window's pages around inside another.
 *
 * The set is the lookup: a request arriving from a window's own renderer is
 * answered by that window's manager (`requireBrowserManager(event)`), and the
 * agent-facing control server — which has no sender, only a scope — walks the
 * same set for the window that session's browser lives in (`managerForScope`,
 * issue #311). The variable stays as the fallback for both, and follows focus,
 * so "the app's browser" means the window the human is actually in.
 */
let browserManager = null;
const browserManagers = new Set();
let browserSuggestions;
function requireBrowserSuggestions() {
  return browserSuggestions ||= createBrowserSuggestions(app.getPath("userData"));
}
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
  // A dev-packaged build says so in the title, and says when its sources were
  // dirty: two of them on one machine are otherwise told apart by nothing.
  const name = DEV_BUILD ? "Telar Dev" : "Telar";
  if (!info || !info.shortSha) return name;
  return `${name} ${info.shortSha}${DEV_BUILD && info.dirty ? "+dirty" : ""}`;
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
  // A dev-packaged build never follows an inherited TELAR_HOME — see DEV_BUILD.
  if (DEV_BUILD) return app.getPath("userData");
  return process.env.TELAR_HOME?.trim() || app.getPath("userData");
}

/**
 * In packaged Electron there is no separate node binary — run an Electron binary
 * as node via ELECTRON_RUN_AS_NODE. On macOS the MAIN binary still registers
 * with LaunchServices as a Foreground app even under RUN_AS_NODE, putting a
 * second, dead "Telar" in the Dock per child. The Helper binary is LSUIElement
 * in its Info.plist — same runtime, no Dock entry — so prefer it when packaged.
 * The helper is named after the PRODUCT ("Telar Dev Helper" in a --dev
 * package), so resolution derives from app.getName() — see helper-exec.js.
 */
function nodeExecPath() {
  if (app.isPackaged && process.platform === "darwin") {
    const frameworks = path.join(path.dirname(process.execPath), "..", "Frameworks");
    const helper = resolveHelperExec(frameworks, app.getName());
    if (helper) return helper;
  }
  return process.execPath;
}

/** What both children need to reach the tools this app does not bundle. */
/**
 * WHERE THE COCKPIT'S SOCKET LISTENS — the fix for a pairing link that pointed
 * at an address nothing was bound to.
 *
 * This was `"127.0.0.1"`, hardcoded. The Remote access panel meanwhile builds
 * its QR from the machine's tailnet address, because that is the whole point
 * of remote access — so the code was correct, the token was valid, and the
 * browser could not open a TCP connection to it. Pairing appeared broken on
 * every build at once, which is exactly what one shared constant does.
 *
 * TWO MODES, NOT A BOOLEAN, and the second one is opt-in from Settings →
 * Remote access. `local-only` is unchanged behaviour. `network-accessible`
 * binds every interface, which is what makes a tailnet URL resolve.
 *
 * THE STORE REFUSES TO WIDEN WITHOUT PAIRING ON (apps/web/lib/remote/store.ts),
 * and this reader re-checks rather than trusting the file: an edited
 * remote.json must not be able to publish an unauthenticated cockpit onto a
 * café's wifi. Two checks for one rule, because the cost of the file winning
 * is the whole machine.
 */
/**
 * THE SHELL DOES NOT PAIR WITH ITSELF.
 *
 * Pairing answers "may this OTHER device reach my cockpit". This process
 * launched the server and owns the state directory; it already has everything
 * pairing would grant. Treating it as a guest failed in the two ways that hurt
 * most — the host's own window asking to be paired, and any change of origin
 * (a bind address, a tailnet URL) silently unpairing the app on the very
 * machine running it.
 *
 * So it carries a per-launch secret: minted here, handed to the web child in
 * its environment, and set as a cookie on this window's session before the
 * page loads. Nothing is persisted and nothing is written into remote.json, so
 * quitting ends it and the next launch mints another.
 */
// MINTED HERE ONLY WHEN NOBODY ELSE DID. In dev the web child is spawned by
// scripts/dev.mjs, not by this file, so the launcher mints the secret and
// hands it to both halves; minting a second one here would have the shell
// present a cookie the server had never heard of.
const HOST_TOKEN = process.env.TELAR_HOST_TOKEN || "tlr_" + randomBytes(32).toString("base64url");

/**
 * AND THE SAME SECRET ON EVERY REQUEST, AS A HEADER — the carrier that has
 * neither of the cookie's failure modes (host-header.js explains both). Only
 * `session.defaultSession`, which is this window's; the integrated browser's
 * tabs live in their own partitions and must never carry it.
 */
function seatHostHeader(url) {
  if (!attachHostHeader(session.defaultSession, { appUrl: url, token: HOST_TOKEN })) {
    console.error(`[telar-desktop] could not attach the host header for ${url}; the window falls back to its cookie.`);
  }
}

/**
 * Set BEFORE the first load, on the session that will make the request — an
 * Electron cookie is per-origin, so this is scoped to the URL the shell is
 * about to open and travels nowhere else. KEPT AS A BELT beside the header:
 * this is what a request made before the listener is attached carries.
 */
async function seatHostCookie(url) {
  try {
    const { protocol, host } = new URL(url);
    await session.defaultSession.cookies.set({
      url: `${protocol}//${host}`,
      name: "telar_device",
      value: HOST_TOKEN,
      httpOnly: true,
      sameSite: "lax",
    });
  } catch {
    // A cookie we cannot seat means the window pairs the old way rather than
    // failing to open — degraded, not broken.
  }
}

/**
 * A CRASHED CHILD IS THE FIRST OF THE TWO WAYS THE HOST STOPPED PROVING ITSELF.
 *
 * Chromium's network service holds every session cookie in its own memory; when
 * that utility process is restarted the jar comes back with the persistent
 * cookies reloaded from disk and the session ones simply gone. The shell had no
 * handler at all, so the event that emptied the jar left no trace and the
 * window's sudden "pair this device" looked spontaneous.
 *
 * BOTH HALVES OF THE ANSWER ARE HERE: the line that names it, and the re-seat
 * that repairs it. The header (host-header.js) is what makes the repair
 * unnecessary in the first place — the listener lives in this process and
 * cannot be dropped by a child restarting — but the cookie is still the belt,
 * and a belt that is never re-fastened is not one.
 */
function wireShellDiagnostics() {
  app.on("child-process-gone", (_event, details) => {
    logShell(
      "warn",
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.serviceName ?? ""}`,
    );
    // Whatever died, re-seating costs one IPC and is only meaningful for the
    // network service — which is precisely the one whose name we cannot rely on
    // matching across Electron versions.
    if (lastWindowUrl) void seatHostCookie(lastWindowUrl);
  });
}

/**
 * AND THE SYMPTOM, FROM THE WINDOW'S SIDE. A 401 on a main-frame request, or a
 * redirect to the pairing page, IS the bug as the user meets it — so the next
 * occurrence writes a line instead of needing a story.
 *
 * THE ORIGIN ONLY, never the path or the query: this log is read by whoever is
 * debugging, and a cockpit URL carries session and project ids. The origin is
 * also the entire diagnostic — it says whether the window had wandered onto the
 * other spelling of its own server.
 */
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

function readRemoteFile(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "remote", "remote.json"), "utf8"));
  } catch {
    // No file, unreadable, or not JSON — every reader below takes the safe
    // answer, which is what every install had before the setting existed.
    return null;
  }
}

function serverBindHost(home) {
  const remote = readRemoteFile(home);
  if (remote?.exposure === "network-accessible" && remote?.requireAuth === true) return "0.0.0.0";
  return "127.0.0.1";
}

/**
 * TAILSCALE SERVE, WHEN SETTINGS ASKED FOR IT. Same gate as the bind host —
 * pairing must be on — re-checked here so a hand-edited file cannot publish
 * an open cockpit onto the tailnet. Runs BEFORE the web child spawns, because
 * the child's env has to carry the ts.net URL for the Remote access panel to
 * list it. Returns the HTTPS base URL, or null when nothing was published;
 * the reason is logged as a label only (stderr may hold auth keys).
 */
let tailscaleServeUrl = null;
async function publishTailscaleServe(home, port) {
  const remote = readRemoteFile(home);
  if (remote?.tailscaleServe !== true || remote?.requireAuth !== true) return null;
  const domain = await tailscale.certDomain();
  if (!domain) {
    console.error("[telar-desktop] tailscale serve requested but tailscale is missing, not running, or has HTTPS certificates disabled; skipped.");
    return null;
  }
  const outcome = await tailscale.startServe(port);
  if (outcome !== "none") {
    console.error(`[telar-desktop] tailscale serve failed (${outcome}); the ts.net endpoint is down.`);
    return null;
  }
  tailscaleServeUrl = `https://${domain}`;
  console.log(`[telar-desktop] tailnet: ${tailscaleServeUrl}/`);
  return tailscaleServeUrl;
}

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
/**
 * The engine's discovery document. The subdirectory `engineRootFromEnv`
 * composes in apps/engine/src/state.ts, and the same one the cockpit reads.
 * Three places know this name; a test in this app pins that they agree — and
 * THIS is the shell's only spelling of it (AD-5: one composition per file).
 */
function engineDiscoveryFile(home) {
  return path.join(home, "engine", "engine.json");
}

/**
 * `requireWorker` waits for `/v2/health` to report a REGISTERED worker, not
 * just a 200: a daemon whose embedded worker never came up answers every
 * health check and refuses every turn. Smoke asks for it; the normal boot
 * does not block the window on it (the supervisor re-registers on its own).
 */
function waitForEngine(home, { timeoutMs = 30_000, intervalMs = 150, requireWorker = false } = {}) {
  const discoveryFile = engineDiscoveryFile(home);
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
                /* half-written body — retry */
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
      HOSTNAME: serverBindHost(home),
      // The ts.net endpoint the Remote access panel lists — present only when
      // `publishTailscaleServe` ran first and succeeded.
      ...(tailscaleServeUrl ? { TELAR_TAILSCALE_URL: tailscaleServeUrl } : {}),
      // What the gate compares this shell's cookie against (lib/remote/host-token.ts).
      TELAR_HOST_TOKEN: HOST_TOKEN,
      // And what the Remote access panel calls the host row. The shell holds a
      // secret rather than a device record, so this name is the only way the
      // app hosting the server appears in the list of what is connected.
      TELAR_HOST_CLIENT: app.getName(),
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
      // The cockpit's right panel embeds PDFs in an <iframe>; Chromium's PDF
      // viewer counts as a plugin, and without this the frame stays blank.
      plugins: true,
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
  // NAMED BROWSER PROFILES (browser-profiles.js): the registry is read once
  // from userData; a bad file is a startup error, not a silent fallback to the
  // shared jar. Reused across a translucency rebuild through the manager.
  const profiles = readProfileRegistry(app.getPath("userData"));
  const manager = new DesktopBrowserManager(win, {
    onControlChanged: reportBrowserControl,
    // A credential entry FINISHED in some tab (metadata only — the capture is
    // an address, an identity and a moment). The offer flow decides whether to
    // ask "may agents use this login here?" — login-offer-window.js.
    onCredentialEntryFinished: (capture) => requireLoginOffer().entryFinished(capture),
    // Recent sites are PER PROFILE, not per project: two projects sharing an
    // identity share its history, which is what sharing an identity means.
    onVisited: (scopeKey, url) => requireBrowserSuggestions().remember(manager.activeProfile(scopeKey)?.id, url),
    profiles,
    // A project whose pre-profile cookie jar was adopted keeps its recent
    // sites: the entries move to the new key, nothing on disk is touched.
    onProfileMigrated: (from, to) => requireBrowserSuggestions().adopt(from, to),
    // Each session's open pages, order and active tab survive a reload, a
    // window rebuild and a restart (browser-tab-store.js). A rebuilt window's
    // manager reads what the old one wrote in destroy(); the smoke run keeps
    // its temp userData so nothing leaks between runs.
    tabStore: createTabStore(app.getPath("userData")),
    // ONE EXTENSION HOST PER PARTITION, created when a partition first gets a
    // tab. chrome.tabs of one project's 1Password sees that project only.
    createExtensionHost: (partition) => startExtensionHost(win, manager, partition),
  });
  browserManagers.add(manager);
  browserManager = manager;
  // "The app's browser" is the window the human is in — see `browserManagers`.
  win.on("focus", () => {
    browserManager = manager;
  });
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
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    // Re-announce every live partition's host to the reloaded renderer.
    for (const [partition, host] of manager.extensionHosts) win.webContents.send("telar:browser:extension", { partition, ...host.status() });
  });
  win.on("closed", () => {
    manager.destroy();
    browserManagers.delete(manager);
    // Another window's host, not null, while one is still open: closing the
    // second window must not leave the first without a fallback manager.
    if (browserManager === manager) browserManager = browserManagers.values().next().value ?? null;
  });
  // Keep the build stamp in the title bar — don't let the loaded page's <title>
  // overwrite it (that's how you answer "which build am I running?").
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(title);
  });
  // Issue #259's symptom, recorded from the window's own side.
  watchForUnpairing(win.webContents);
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
  // SEATED BEFORE THE FIRST REQUEST, not after: the gate reads these on the
  // opening navigation, so loading first would send the shell's own window in
  // as an unpaired stranger. The header is attached synchronously — there is no
  // await to lose the race on — and `finally` because a cookie we could not set
  // is a window that pairs the old way, not a window that never opens.
  seatHostHeader(url);
  seatHostCookie(url).finally(() => {
    if (!win.isDestroyed()) win.loadURL(url);
  });
  return win;
}

/**
 * THE 1PASSWORD EXTENSION, ONE HOST PER PARTITION (per project profile). The
 * manager calls this the first time a partition gets a tab; the host loads
 * lazily and the tab-wake path waits for it before the first navigation.
 * Enabled in Dev and personal nightly builds; TELAR_EXTENSIONS=0 disables it
 * for troubleshooting, and =1 opts other builds in. Failures land in `status()` and the
 * panel shows them — never a silent blank. Returns null when extensions are
 * off, so the manager simply proceeds without one.
 */
function startExtensionHost(win, manager, partition) {
  const wanted = extensionsEnabled({ dev: DEV_BUILD, packaged: app.isPackaged, version: app.getVersion(), override: process.env.TELAR_EXTENSIONS });
  if (!wanted || SMOKE) return null;
  const ses = session.fromPartition(partition);
  const host = new ExtensionHost(ses, {
    privacy: manager.privacy,
    window: win,
    tabs: {
      // chrome.tabs.create from THIS partition's extension: a human tab in a
      // scope of this partition. The extension's own pages open in a
      // human-only window (openExtensionPage), never as an integrated tab.
      createTab: async (details) => {
        const url = details.url || "about:blank";
        if (/^chrome-extension:/.test(url)) {
          const page = host.openExtensionPage(url, win);
          return [page.webContents, page];
        }
        // A visible scope on THIS partition, else any scope on it.
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
        if (tab) { manager.closeTabRef(tab, "human"); return; }
        for (const page of host.extensionWindows) if (!page.isDestroyed() && page.webContents === wc) page.close();
      },
    },
  });
  host.onHealthChange = (status) => { if (!win.isDestroyed()) win.webContents.send("telar:browser:extension", { partition, ...status }); };
  // Track extension chrome independently of credential entry on web pages.
  // Opening or closing 1Password does not pause the browser.
  host.onHoldOpen = (id, reason) => manager.addUiHold(id, reason);
  host.onHoldClose = (id) => manager.removeUiHold(id);
  host.startOnce().then((status) => {
    if (status.phase === "failed") console.error(`[telar-desktop] 1Password extension (${partition}): ${status.error}`);
    if (!win.isDestroyed()) win.webContents.send("telar:browser:extension", { partition, ...status });
  });
  return host;
}

/** The manager of the window this request came from, or null when the sender is
 *  not a window's own top-level renderer (a native tab view, a popup). */
function managerForEvent(event) {
  const sender = event?.sender;
  if (!sender) return null;
  for (const manager of browserManagers) {
    if (!manager.window.isDestroyed() && manager.window.webContents === sender) return manager;
  }
  return null;
}

/**
 * THE SENDER'S OWN WINDOW FIRST. Every handler that has an `event` passes it,
 * so a panel in window A can never act on window B's views. The fallback is for
 * the callers that genuinely have no window — see `browserManagers`.
 */
function requireBrowserManager(event) {
  const manager = managerForEvent(event) || browserManager;
  if (!manager) throw new Error("The Telar desktop browser host is not ready.");
  return manager;
}

/**
 * THE LOGIN OFFER (AUTH-001, #195), wired once for the app's lifetime — a
 * translucency rebuild replaces the manager, not this (its ipcMain handlers
 * may only register once). Grants land in the ENGINE's state root, the same
 * file the daemon lists (`/v2/browser/logins`) and the worker's
 * `browser_fill_secret` matches — see login-grant-writer.js for why the write
 * happens here and not over the daemon's agent-readable HTTP surface.
 */
let loginOffer = null;
function requireLoginOffer() {
  // The engine's state root. The shell is a declared co-tenant of this
  // subtree — see `engine` in packages/core/test/invariants.test.ts
  // (AD-5 / INV-3) for why, and why the write cannot go over the daemon's
  // agent-readable HTTP surface.
  loginOffer ??= wireLoginOffer({ stateRoot: path.join(telarHome(), "engine") });
  return loginOffer;
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
        // The Dev self-update entry (DEV-005) — only a --dev package carries
        // it. The shipping app keeps electron-updater; this is the local twin.
        ...(DEV_BUILD
          ? [
              { type: "separator" },
              { label: "Update from Local Checkout…", click: () => devUpdate.openWindow() },
            ]
          : []),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("telar:browser:suggestions", async (event, scopeKey) => {
  const manager = requireBrowserManager(event);
  manager.partitionOf(scopeKey); // Validate the binding before reading a project's history.
  const ownPort = Number(new URL(manager.window.webContents.getURL()).port);
  return requireBrowserSuggestions().list(manager.activeProfile(scopeKey)?.id, [
    ownPort,
    Number(process.env.TELAR_DESKTOP_REMOTE_DEBUGGING_PORT),
    Number(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT),
  ]);
});
ipcMain.handle("telar:browser:remove-suggestion", (event, input) => {
  const manager = requireBrowserManager(event);
  manager.partitionOf(input?.scopeKey);
  requireBrowserSuggestions().remove(manager.activeProfile(input.scopeKey)?.id, input.url);
});
ipcMain.handle("telar:browser:state", (event, scopeKey) => requireBrowserManager(event).state(scopeKey));
// The password manager's toolbar button. Opening its popup BEGINS a private
// interaction; only a human's Resume ends it.
// Status is PER SCOPE now: each project's session has its own partition and
// its own 1Password host. Creating the host on the first status poll lets the
// extension preload while the human looks, before any tab navigates.
ipcMain.handle("telar:browser:extension-status", (event, scopeKey) => {
  const manager = requireBrowserManager(event);
  const host = manager.hostForScope(scopeKey);
  if (!host) return { phase: "unavailable", error: "Extensions are not enabled, or this session has no project profile yet.", privacy: manager.privacy.state() };
  // Carry the partition so the renderer can keep only this scope's status and
  // ignore another project's host pushes.
  let partition; try { partition = manager.partitionOf(scopeKey); } catch { partition = undefined; }
  return { ...(partition ? { partition } : {}), ...host.status() };
});
ipcMain.handle("telar:browser:extension-popup", async (event, input) => {
  const manager = requireBrowserManager(event);
  const host = manager.hostForScope(input?.scopeKey);
  if (!host) throw new Error("Extensions are not enabled, or this session has no project profile yet.");
  const tab = manager.activeTab(input?.scopeKey);
  await manager.wakeTab(tab);
  const win = BrowserWindow.fromWebContents(event.sender);
  return host.openPopup(win, tab.view.webContents, input?.anchorRect || { x: 0, y: 0, width: 24, height: 24 }, input?.scopeKey);
});
ipcMain.handle("telar:browser:bind-profile", (event, input) =>
  requireBrowserManager(event).declareProfile(input?.scopeKey, input?.profileKey),
);
/**
 * NAMED PROFILES, MANAGED FROM SETTINGS → INTEGRATIONS AND FROM THE BROWSER
 * PANEL. Create and rename identities, name the account one is MEANT to be
 * signed into (intent — nothing here verifies a login), choose the global
 * default, assign this session's project, switch which identity this session's
 * next tab opens in, and forget one nothing points at.
 *
 * DELETING FORGETS A RECORD, NEVER A COOKIE JAR. The registry refuses a profile
 * that is the default or that any project is assigned to, and the partition
 * directory is left on disk either way — so the worst a mistaken delete costs is
 * making the profile again, and no live identity is ever stranded mid-session.
 */
ipcMain.handle("telar:browser:profiles", (event, scopeKey) => {
  const manager = requireBrowserManager(event);
  return {
    profiles: manager.listProfiles(),
    active: scopeKey ? manager.activeProfile(scopeKey) : null,
    projectKey: scopeKey ? manager.profileOf(scopeKey) : null,
  };
});
ipcMain.handle("telar:browser:create-profile", (event, input) => {
  const manager = requireBrowserManager(event);
  const profile = manager.profiles.create({ label: input?.label, account: input?.account, icon: input?.icon, color: input?.color });
  // Creating from a session's panel is nearly always "and use it here".
  if (input?.scopeKey) manager.setScopeProfile(input.scopeKey, profile.id);
  if (input?.scopeKey && input?.assignProject) {
    const projectKey = manager.profileOf(input.scopeKey);
    if (projectKey) manager.profiles.assign(projectKey, profile.id);
  }
  // A profile made in Settings has to appear in every open panel's picker, and
  // one made from a panel has to appear in the others'.
  manager.emitAllStates();
  return { profiles: manager.listProfiles(), active: profile };
});
ipcMain.handle("telar:browser:update-profile", (event, input) => {
  const manager = requireBrowserManager(event);
  // Only the keys the caller actually sent — `update` patches, so forwarding an
  // absent field as undefined would be indistinguishable from "leave it", while
  // forwarding it as null would clear a mark nobody touched.
  const profile = manager.profiles.update(input?.profileId, {
    ...(input?.label !== undefined ? { label: input.label } : {}),
    ...(input?.account !== undefined ? { account: input.account } : {}),
    ...(input?.icon !== undefined ? { icon: input.icon } : {}),
    ...(input?.color !== undefined ? { color: input.color } : {}),
  });
  manager.emitAllStates();
  return { profiles: manager.listProfiles(), active: profile };
});
ipcMain.handle("telar:browser:delete-profile", (event, input) => {
  const manager = requireBrowserManager(event);
  /**
   * A SESSION CURRENTLY POINTED AT IT IS A REFUSAL, not a silent re-bind. The
   * registry only knows about project assignments; a scope switched to this
   * profile by hand is live state only the manager has, and deleting under it
   * would leave that panel naming a profile that no longer exists.
   */
  if ([...manager.scopeProfiles.values()].includes(input?.profileId)) {
    throw new Error("A session is browsing in that profile right now. Switch that session to another profile first.");
  }
  const removed = manager.profiles.remove(input?.profileId);
  manager.emitAllStates();
  return { profiles: manager.listProfiles(), removed };
});
ipcMain.handle("telar:browser:set-default-profile", (event, input) => {
  const manager = requireBrowserManager(event);
  manager.profiles.setDefault(input?.profileId);
  manager.emitAllStates();
  return { profiles: manager.listProfiles() };
});
ipcMain.handle("telar:browser:assign-project-profile", (event, input) => {
  const manager = requireBrowserManager(event);
  const projectKey = input?.projectKey || manager.profileOf(input?.scopeKey);
  if (!projectKey) throw new Error("This session has no project to assign a browser profile to.");
  manager.profiles.assign(projectKey, input?.profileId ?? null);
  manager.emitAllStates();
  return { profiles: manager.listProfiles() };
});
ipcMain.handle("telar:browser:set-scope-profile", (event, input) =>
  requireBrowserManager(event).setScopeProfile(input?.scopeKey, input?.profileId),
);
ipcMain.handle("telar:browser:private-resume", (event) => requireBrowserManager(event).resumeFromPrivate());
ipcMain.handle("telar:browser:action", (event, input) =>
  requireBrowserManager(event).action(input?.scopeKey, input?.action),
);
/**
 * "OPEN IN SYSTEM BROWSER", from the integrated browser's tab menu.
 *
 * A USER GESTURE, AND ONLY THE COCKPIT'S. The guard is the login-offer
 * handler's, for the same reason: a browser tab's preload, a subframe, or
 * anything an agent can reach must not be able to make the shell launch the
 * default browser. An agent that wants a page open has `browser_navigate` and
 * a tab to put it in.
 *
 * http AND https ONLY — `externalOpenTarget` is the same allowlist the clicked
 * link policy applies, and it answers with the PARSED href so the OS receives
 * exactly what was validated.
 */
ipcMain.handle("telar:browser:open-external", (event, input) => {
  const manager = requireBrowserManager(event);
  const cockpit = manager.window;
  if (!cockpit || cockpit.isDestroyed() || event.sender !== cockpit.webContents || event.senderFrame !== cockpit.webContents.mainFrame) {
    throw new Error("Only the Telar window may open a page in the system browser.");
  }
  const target = externalOpenTarget(input?.url);
  if (!target) return { ok: false, error: "Only http and https pages open in the system browser." };
  openInSystemBrowser(target);
  return { ok: true };
});
ipcMain.handle("telar:browser:tool", (event, input) =>
  requireBrowserManager(event).callTool(input?.scopeKey, input?.name, input?.args || {}),
);
ipcMain.handle("telar:browser:set-bounds", (event, input) => {
  requireBrowserManager(event).setBounds(input?.scopeKey, input?.bounds);
});
ipcMain.handle("telar:browser:set-visible", (event, input) =>
  requireBrowserManager(event).setVisible(input?.scopeKey, input?.visible),
);
ipcMain.handle("telar:browser:release-scope", (event, input) =>
  requireBrowserManager(event).releaseScope(input?.scopeKey, Boolean(input?.destroy)),
);
ipcMain.handle("telar:browser:adopt-scope", (event, input) =>
  requireBrowserManager(event).adoptScope(input?.fromScopeKey, input?.toScopeKey),
);
/**
 * THE EXPLICIT FALLBACK (AUTH-001): "remember the login on this page", asked
 * from the cockpit — for the person who dismissed the automatic offer, or
 * whose sign-in Telar never saw. ONLY the cockpit window's own top frame may
 * ask: a browser tab's preload, a subframe, or anything an agent can reach
 * gets a refusal. And asking only OPENS the question in the trusted offer
 * window — nothing here (and no API anywhere) can answer it.
 */
ipcMain.handle("telar:login-offer:open", (event, scopeKey) => {
  const manager = requireBrowserManager(event);
  const cockpit = manager.window;
  if (!cockpit || cockpit.isDestroyed() || event.sender !== cockpit.webContents || event.senderFrame !== cockpit.webContents.mainFrame) {
    throw new Error("Only the Telar window may open the login offer.");
  }
  const capture = manager.loginCaptureForScope(scopeKey);
  if (!capture) return { ok: false, error: "This page cannot carry a remembered login (open an http(s) page first)." };
  return requireLoginOffer().explicitOffer(capture);
});

// A tab preload heard a human's hands in the page; all we hold is the sender.
ipcMain.on("telar:browser:credential-field", (event, detail) => {
  try {
    // EVERY WINDOW'S HOST IS ASKED, because the sender is a native TAB — it is
    // not any window's own renderer, so there is nothing to resolve it by. Both
    // methods look the webContents up in their own tabs and no-op on a stranger,
    // so asking the wrong one costs a lookup and never a false report.
    for (const manager of browserManagers) manager.noteCredentialFieldFromWebContents(event.sender, detail || {});
  } catch {
    // A report from a view mid-teardown must not crash the shell.
  }
});
ipcMain.on("telar:browser:human-input", (event) => {
  try {
    for (const manager of browserManagers) manager.noteHumanInputFromWebContents(event.sender);
  } catch {
    // A report from a view mid-teardown must not crash the shell.
  }
});

/**
 * FORWARD CONTROL CHANGES INTO THE ENGINE JOURNAL. The shell is the only
 * process that can see a human's click land in the native view; the engine is
 * where the transcript lives. Best-effort by design — a change the engine
 * missed (it was restarting) costs a journal row, not correctness: the
 * manager's own state is what gates agent calls.
 */
let engineDiscovery = null;
let discoveryReadAt = 0;
function reportBrowserControl(change) {
  // In dev mode (TELAR_DESKTOP_URL) the shell never booted the engine itself,
  // so discovery is read off disk lazily — same file waitForEngine proves.
  if (!engineDiscovery && Date.now() - discoveryReadAt > 5_000) {
    discoveryReadAt = Date.now();
    try {
      engineDiscovery = JSON.parse(fs.readFileSync(engineDiscoveryFile(telarHome()), "utf8"));
    } catch {
      /* no engine on this machine right now */
    }
  }
  const discovery = engineDiscovery;
  if (!discovery?.port || !discovery?.token) return;
  const payload = JSON.stringify({
    controller: change.controller,
    ...(change.tabId ? { tabId: change.tabId } : {}),
    ...(change.interrupted ? { interrupted: true } : {}),
  });
  const request = http.request({
    host: discovery.host || "127.0.0.1",
    port: discovery.port,
    path: `/v2/sessions/${encodeURIComponent(change.scopeKey)}/browser/control`,
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
/**
 * Open a session's workspace folder — in a named app, in the system default,
 * or revealed in Finder.
 *
 * Absolute paths and real things on disk only: a relative path would resolve
 * against this process's cwd. The app must be one `discoverOpeners` actually
 * found, so a renderer cannot name an arbitrary binary. Nothing is ever
 * interpolated into a command line — see workspace-openers.js.
 *
 * AND ONE FILE, WHEN THE CALLER SAYS SO. `input.kind` is `"directory"` unless
 * it is exactly `"file"`, so the header's Open button — which sends no kind —
 * is refused a non-directory exactly as before. A file is allowed because the
 * file tree's own menu reveals and opens one, and both shell calls already
 * take either: `showItemInFolder` selects a file in its folder, and `openWith`
 * hands any target to the app. The absolute-path and stat guards are the same
 * two guards; only what `stat` is allowed to BE widens.
 */
ipcMain.handle("telar:workspace:openers", () => ({ openers: discoverOpeners() }));

ipcMain.handle("telar:workspace:open", async (_event, input) => {
  const target = typeof input?.path === "string" ? input.path : "";
  if (!target || !path.isAbsolute(target)) return { ok: false, error: "A workspace can only be opened from an absolute path." };
  const file = input?.kind === "file";
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: file ? "That file is no longer on this machine." : "That folder is no longer on this machine." };
  }
  if (file ? !stat.isFile() : !stat.isDirectory()) return { ok: false, error: file ? "That path is not a file." : "That path is not a folder." };
  if (input?.reveal === true) {
    shell.showItemInFolder(target);
    return { ok: true };
  }
  if (typeof input?.openerId === "string" && input.openerId) {
    // Matched against what is installed rather than trusted: the renderer
    // names an id, never a path.
    const opener = discoverOpeners().find((candidate) => candidate.id === input.openerId);
    if (!opener) return { ok: false, error: "That app is not installed on this machine." };
    return openWith({ target, appPath: opener.path });
  }
  // openPath answers with an error STRING, never a throw; empty means success.
  const failure = await shell.openPath(target);
  return failure ? { ok: false, error: failure } : { ok: true };
});

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
  // A dev build has no updater to hand a channel to, and the legacy directory
  // is the INSTALLED app's — nothing of it belongs in the dev build's home.
  if (DEV_BUILD) return;
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
/**
 * The last status broadcast, held so a renderer that mounted AFTER the event
 * can ask. The push alone lost the one state that matters most: an update
 * downloads while the user is elsewhere, they reload or the window rebuilds,
 * and the "restart to install" affordance never reappears because
 * electron-updater does not re-emit `update-downloaded`.
 */
let lastUpdateStatus = null;
function broadcastUpdateStatus(status, extra = {}) {
  lastUpdateStatus = { status, ...extra };
  const win = updaterWindow || BrowserWindow.getAllWindows()[0];
  win?.webContents.send("telar:updates:status", lastUpdateStatus);
}

// A packaged build only has a real feed to talk to when --publish-r2 baked both
// the proxy URL and its key in together; without the key the publish.url is
// still the package.json placeholder, so checking would only ever produce a
// DNS error. That makes the key the honest test for "updates are available
// here at all" — both for the automatic checks and for the Settings button.
function updatesConfigured() {
  // A dev-packaged build has no feed and must never replace itself — or, worse,
  // be replaced by a nightly of the installed app it exists to sit beside.
  if (DEV_BUILD) return false;
  return app.isPackaged && Boolean(updateProxyKey());
}

// --- A DEAD DOWNLOAD MUST NOT WEDGE EVERY LATER CHECK (issue #317) ----------
//
// Observed on 0.1.0-nightly.20260911.3: a full download stopped at 11 MB of
// 145 and neither finished nor errored, and every "Check for updates" after it
// sat on "Checking for a newer build…" until the app was quit. Nothing in
// electron-updater times a transfer out, and its `checkForUpdates()` hands back
// the in-flight check's promise — so one stalled socket poisoned the feature
// for the rest of the session.
//
// TWO CHANGES MAKE THAT SHAPE UNREACHABLE.
//
//   · THE DOWNLOAD IS OURS. `autoDownload` mints the CancellationToken inside
//     checkForUpdates and starts the transfer there, which puts the token out
//     of reach and entangles the check with the download. Starting it here, on
//     `update-available`, keeps downloading just as automatic and makes the
//     transfer killable.
//
//   · EVERY WAIT HAS A CLOCK. No progress for STALL_MS cancels the transfer,
//     deletes its part-file and says so in the pane; a check that has not
//     answered in CHECK_TIMEOUT_MS reports a timeout and drops the cached
//     promise so the next press starts clean.
//
// The decisions live in update-watchdog.js, where they are testable without an
// Electron to run in; the consequences live here.
const downloadWatch = updateWatchdog.createDownloadWatch({
  stallMs: updateWatchdog.STALL_MS,
  onStall: (stalled) => abandonDownload(stalled, "stalled"),
});

/** Delete the part-file a cancelled transfer leaves behind, wherever this
 *  build's updater happens to keep it. */
function discardPendingDownload() {
  try {
    return updateWatchdog.removeStaleTempFiles(updateWatchdog.pendingUpdateDir(autoUpdater));
  } catch {
    return [];
  }
}

/**
 * Kill a transfer and account for it. `reason` distinguishes the watchdog
 * firing on its own from a person pressing Check and finding a corpse — the
 * user is only told about the first, because the second is about to be replaced
 * by a fresh check's own status within the second.
 */
function abandonDownload(download, reason) {
  if (!download) return;
  try {
    download.token?.cancel();
  } catch {
    /* a token that will not cancel is still a download we are done with */
  }
  const removed = discardPendingDownload();
  const percent = Math.round(download.percent ?? 0);
  const label = download.version ? `v${download.version}` : "the update";
  autoUpdater.logger?.warn?.(
    `download of ${label} ${reason} at ${percent}% — cancelled${removed.length ? `, removed ${removed.join(", ")}` : ""}`,
  );
  if (reason !== "stalled") return;
  broadcastUpdateStatus("error", {
    version: download.version,
    message: `Download stalled at ${percent}% — nothing arrived for ${Math.round(updateWatchdog.STALL_MS / 1000)}s, so it was cancelled. Check again to retry.`,
  });
}

/**
 * Start the download for an update the feed just offered.
 *
 * GUARDED AGAINST A SECOND START: two checks can race (the six-hourly timer and
 * a channel switch), and two `downloadUpdate` calls write the same temp file.
 */
function startUpdateDownload(info) {
  if (downloadWatch.inFlight()) return;
  const token = new CancellationToken();
  downloadWatch.begin({ token, version: info?.version });
  autoUpdater.downloadUpdate(token).catch((err) => {
    // A real failure has already reached the UI through the `error` event, and
    // a cancellation was this process's own decision. Either way the transfer
    // is over and the watchdog must stop counting.
    downloadWatch.settle();
    if (updateWatchdog.isCancellationError(err)) return;
    autoUpdater.logger?.error?.(`download failed: ${err?.message || err}`);
  });
}

async function checkForUpdates() {
  // The 'error' event already reports failures to the UI; settleWithin's own
  // catch only stops a background check's rejection from surfacing as an
  // unhandled rejection.
  const outcome = await updateWatchdog.settleWithin(autoUpdater.checkForUpdates(), updateWatchdog.CHECK_TIMEOUT_MS);
  if (!outcome.timedOut) return outcome.value ?? null;
  // The wedge itself. Saying so beats a spinner that never stops, and dropping
  // the cached promise is what stops the NEXT press inheriting this one's hang.
  updateWatchdog.clearCachedCheckPromise(autoUpdater);
  autoUpdater.logger?.warn?.(`update check did not answer within ${updateWatchdog.CHECK_TIMEOUT_MS / 1000}s — giving up on it`);
  broadcastUpdateStatus("error", {
    message: `Update check timed out after ${Math.round(updateWatchdog.CHECK_TIMEOUT_MS / 1000)}s. Check again to retry.`,
  });
  return null;
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

/**
 * THE SHELL'S OWN LOG, BESIDE update.log AND FOR THE SAME REASON.
 *
 * The un-pairing bug (issue #259) was reported several times over months and
 * every report was a person describing a screen, because the app recorded
 * nothing when its own window was refused: no crashed-child event, no 401, no
 * redirect. The mechanism had to be reasoned out from a cookie's semantics
 * rather than read off a line. So the two events that would have named it
 * immediately are written here.
 *
 * Same shape as updateLogger: appended, in userData, never rotated — this is a
 * handful of lines per launch, and it must never be the reason anything fails.
 */
function shellLogPath() {
  return path.join(app.getPath("userData"), "shell.log");
}

function logShell(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
  try {
    fs.appendFileSync(shellLogPath(), line);
  } catch {
    /* logging must never be the reason the shell fails */
  }
  console.log(`[telar-shell] ${level} ${message}`);
}

/**
 * THE MAIN PROCESS'S OWN HEAP, ONE LINE A MINUTE — issue #296.
 *
 * The shell's main process climbed to 100% CPU and multi-gigabyte memory over
 * an evening and died with a V8 SIGTRAP, and there was nothing to read
 * afterwards: a `sample` names the shape of the stack but not which JS
 * structure grew. So the process writes its own series.
 *
 * TWO LEVELS, DELIBERATELY.
 *
 *   · THE GUARD IS ALWAYS ON. One `v8.getHeapStatistics()` a minute costs
 *     nothing, and the single line it writes when the heap first passes 1 GB
 *     is the difference between "it died" and "it had been over a gigabyte
 *     since 21:40". It warns ONCE — a warning that repeats every minute for
 *     three hours is a log nobody reads.
 *
 *   · THE SERIES IS OPT-IN, behind `--telar-heap-log` or
 *     `TELAR_SHELL_HEAP_LOG=1`. It writes the whole picture every minute —
 *     RSS, heap, the OS's own footprint, the window and view counts, and the
 *     manager's growing collections — and, the first time the heap passes
 *     1 GB, a `v8.writeHeapSnapshot` into <userData>/diagnostics so the
 *     retaining path can be named rather than guessed. The snapshot is
 *     gigabytes and is written at most once per launch, which is why it is
 *     not part of the always-on guard.
 *
 * NOTHING IDENTIFYING IS WRITTEN. The manager hands back counts only (see
 * DesktopBrowserManager.diagnostics) — no URL, no title, no scope key.
 */
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

/** The heap snapshot, once per launch. Returns the path, or null. */
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
    // Electron's own figure: on macOS this is the private footprint the OS
    // reports, which the #296 sample showed at 16.7 GB while RSS read 2.5 GB.
    let footprint = null;
    try {
      footprint = typeof process.getProcessMemoryInfo === "function" ? await process.getProcessMemoryInfo() : null;
    } catch {
      // A figure the platform will not give is not a reason to lose the line.
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
  // A diagnostic must never be the reason the app stays alive.
  timer.unref?.();
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
  // OFF, AND STILL AUTOMATIC. The download starts on `update-available` below,
  // with a CancellationToken this process holds — see the issue-#317 block
  // above for why owning the token is the difference between a stalled
  // transfer that can be killed and one that outlives the feature.
  autoUpdater.autoDownload = false;
  applyUpdatePrefs(readUpdatePrefs());
  const key = updateProxyKey();
  if (key) autoUpdater.requestHeaders = { "X-Telar-Update-Key": key };

  // electron-updater's download-progress payload carries only transfer figures
  // (percent/bytesPerSecond/transferred/total) — never a version. The preceding
  // update-available event is the only place the version is known, so the watch
  // holds it and it is threaded onto every downloading broadcast.
  autoUpdater.on("checking-for-update", () => broadcastUpdateStatus("checking"));
  autoUpdater.on("update-available", (info) => {
    broadcastUpdateStatus("available", { version: info.version });
    startUpdateDownload(info);
  });
  autoUpdater.on("update-not-available", (info) => broadcastUpdateStatus("not-available", { version: info.version }));
  autoUpdater.on("download-progress", (progress) => {
    const live = downloadWatch.progress(progress.percent);
    broadcastUpdateStatus("downloading", { percent: progress.percent, version: live?.version ?? undefined });
  });
  autoUpdater.on("update-downloaded", (info) => {
    downloadWatch.settle();
    broadcastUpdateStatus("downloaded", { version: info.version });
  });
  autoUpdater.on("error", (err) => {
    downloadWatch.settle();
    // A cancellation is this process's own doing and has already been explained
    // as a stall; re-reporting it would replace that sentence with "cancelled".
    if (updateWatchdog.isCancellationError(err)) return;
    broadcastUpdateStatus("error", { message: err && err.message ? err.message : String(err) });
  });

  if (!updatesConfigured()) return;
  void checkForUpdates();
  const timer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  timer.unref?.(); // a pending check must never be the reason the app stays alive
}

ipcMain.handle("telar:updates:check", async () => {
  if (!updatesConfigured()) return { status: "unsupported" };
  const plan = downloadWatch.plan();
  if (plan === "report") {
    // A DOWNLOAD THAT IS MOVING IS ALREADY THE ANSWER to "is there an update?".
    // Re-broadcasting where it has got to also clears the renderer's spinner,
    // which is the whole reason the button was pressed.
    const live = downloadWatch.inFlight();
    broadcastUpdateStatus("downloading", { percent: live.percent, version: live.version });
    return { status: "downloading", version: live.version, percent: live.percent };
  }
  // `restart`: a transfer whose deadline passed while the watchdog's timer was
  // suspended — the machine slept. The press is the wake-up; bury it and go.
  if (plan === "restart") abandonDownload(downloadWatch.settle(), "went quiet while the machine slept");
  await checkForUpdates();
  return { status: "checking" };
});
ipcMain.handle("telar:updates:install", () => {
  if (!app.isPackaged || DEV_BUILD) return;
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

// The pull half of the status contract — see `lastUpdateStatus`.
ipcMain.handle("telar:updates:status", () => lastUpdateStatus);

/**
 * THE DEV BUILD'S UPDATE PATH, reachable from the cockpit. A dev-packaged
 * build has no feed (`updatesConfigured` refuses it, deliberately) — its
 * updates come from the local checkout through the explicit window in
 * dev-update.js, which until now only the menu could open. Opening the window
 * changes nothing by itself; building and swapping stay behind that window's
 * own confirmation.
 */
ipcMain.handle("telar:updates:openLocalUpdater", () => {
  if (!DEV_BUILD) return { ok: false, error: "This build updates from its published channel, not a local checkout." };
  devUpdate.openWindow();
  return { ok: true };
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
  // The Dev build's separate path: update from the local checkout, through
  // its own explicit window. Never true alongside a configured feed.
  localUpdater: DEV_BUILD,
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
  // The tab inventory's last word, before the windows go: what each session
  // had open is what it will have open on the next launch.
  // EVERY window's inventory, not the focused one's: a second window's tabs are
  // as much "what that session had open" as the first window's are.
  for (const manager of browserManagers) { try { manager.persistSync(); } catch {} }
  killServer();
  closeBrowserControl();
  // The serve mapping outlives the process otherwise, pointing at a port
  // nobody answers. Best-effort and unawaited: quitting must not wait on
  // `tailscale`.
  if (tailscaleServeUrl) void tailscale.stopServe();
});

/**
 * RESTART, FROM SETTINGS. A remote-access change (bind address, Tailscale
 * serve) is read at launch, so the panel offers a restart rather than
 * pretending it took. `relaunch` schedules a fresh instance; `quit` runs the
 * teardown above, engine included.
 */
ipcMain.handle("telar:app:relaunch", () => {
  app.relaunch();
  app.quit();
});

/**
 * A SECOND WINDOW ON A PAGE OF THE APP — "Open in a new window", from the
 * session menu (#287). The only thing the web build cannot do for itself, which
 * is why the menu item is absent without this bridge rather than disabled.
 *
 * ONLY A WINDOW'S OWN TOP FRAME MAY ASK. The guard is the open-external
 * handler's, for the same reason and matched the same way: a native browser
 * tab's preload, a subframe, or anything an agent can reach is not a person
 * choosing a menu item, and a window it opened would carry Telar's preload.
 *
 * AND IT RESOLVES THE PATH ITSELF — see window-target.js. The asking window's
 * own address is the base, so a second window can only ever be the same app on
 * the same origin.
 */
ipcMain.handle("telar:app:open-window", (event, input) => {
  const asking = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents === event.sender);
  if (!asking || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Only a Telar window may open another one.");
  }
  const target = windowTargetUrl(asking.webContents.getURL() || lastWindowUrl, input?.path);
  if (!target) return { ok: false, error: "A new window only opens on a page inside Telar." };
  createWindow(target);
  return { ok: true };
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
      // shipped" and "the app has a back end" — and a REGISTERED WORKER is
      // the difference between a back end and one that accepts a turn.
      engineDiscovery = await waitForEngine(home, { requireWorker: true });
      console.log("ENGINE_OK");
      console.log(`ENGINE_WORKER_OK ${engineDiscovery.workerId}`);
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
        // First, so a child that dies during startup is still named.
        wireShellDiagnostics();
        // And the heap guard with it: #296 died five hours in, so the series
        // has to start at launch, not at the first window.
        startHeapLog();
        applyDevelopmentAppIcon();
        buildApplicationMenu();
        // Before anything reads the update preferences, and before the updater
        // is configured with a channel.
        adoptLegacyUpdatePrefs();
        // THE INSTALLED APP EXPORTS THESE INTO EVERY SHELL IT OPENS (they are
        // how its agent sessions reach its browser). A dev build launched from
        // such a shell would bind the live app's control port — measured:
        // EADDRINUSE on 127.0.0.1:<live port>, no window — so it takes neither.
        const configuredControlPort = DEV_BUILD ? NaN : Number(process.env.TELAR_DESKTOP_BROWSER_CONTROL_PORT);
        browserControlConfig = {
          port: Number.isInteger(configuredControlPort) && configuredControlPort > 0
            ? configuredControlPort
            : await findFreePort(),
          token: (DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_BROWSER_CONTROL_TOKEN?.trim()) || randomUUID(),
        };
        browserControl = await startBrowserControlServer({
          ...browserControlConfig,
          // BY SCOPE, ACROSS THE WINDOWS (issue #311). An agent has no window
          // to be recognised by, so the scope it names is what picks the host;
          // the focused window is the fallback when no window claims it.
          getBrowserManager: (scopeKey) => managerForScope(browserManagers, scopeKey, browserManager),
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
          engineDiscovery = await waitForEngine(home);
          const port = await getStablePort();
          await publishTailscaleServe(home, port);
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
