// Telar desktop shell (viable tier). Boots the standalone Next server as a
// child process and points a BrowserWindow at it. No auto-update, no tray, no
// custom menus — deliberately small.
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
const { fork, execFileSync } = require("node:child_process");
const { app, BrowserWindow } = require("electron");

const SMOKE = process.argv.includes("--smoke");
const OVERRIDE_URL = process.env.TELAR_DESKTOP_URL;

let serverChild = null;

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
  const info = readBuildInfo();
  return info && info.shortSha ? `Telar ${info.shortSha}` : "Telar";
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
    : path.join(__dirname, "..", "web", ".next-desktop", "playwright-mcp", "node_modules", "@playwright", "mcp", "cli.js");
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
        paths: [path.join(__dirname, "..", "web")],
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
  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    // In packaged Electron there is no separate node binary — run the Electron
    // binary as node via ELECTRON_RUN_AS_NODE.
    execPath: process.execPath,
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

// --- (e) Window --------------------------------------------------------------
function createWindow(url) {
  const title = windowTitle();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0a0a",
    show: false,
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
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
app.on("will-quit", killServer);
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
        let url = OVERRIDE_URL;
        if (!url) {
          captureLoginShellEnv();
          const port = await findFreePort();
          startServer(port);
          await waitForServer(port);
          url = `http://127.0.0.1:${port}/`;
        }
        createWindow(url);
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
