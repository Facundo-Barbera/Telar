// THE WIRED HALF OF THE DEV SELF-UPDATE (DEV-005) — see dev-update-core.js for
// the decisions. This file owns the window, the IPC surface, the ONE build at
// a time, and the handoff to the detached swap helper. Nothing here runs
// unless the user opens the window and confirms; there is no watcher and no
// timer — an agent editing the checkout changes NOTHING until the user asks.
"use strict";
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./dev-update-core");

const packaged = require("./package.json");
let updateWindow = null;
/** Serialization: the single in-flight build, or null. A second Start while
 *  this is set is refused rather than queued — queueing rebuilds of a moving
 *  checkout answers a question nobody asked. */
let inFlight = null;

function devHome() {
  return app.getPath("userData");
}

function updatesDir() {
  const dir = path.join(devHome(), "updates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logFilePath() {
  return path.join(updatesDir(), "update.log");
}

function appendLog(line) {
  try {
    fs.appendFileSync(logFilePath(), line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    /* the log is best-effort; the window still gets the line */
  }
}

function send(channel, payload) {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send(channel, payload);
}

function emitLog(line) {
  appendLog(line);
  send("telar:dev-update:log", line);
}

function emitStatus(status, detail = "") {
  send("telar:dev-update:status", { status, detail });
}

function repoConfig() {
  return core.configuredRepo({ packagedRepo: packaged.telarDevRepo, devHome: devHome() });
}

/** Everything the window needs to render: where updates would come from, what
 *  is running now, and whether a build is already going. */
function currentState() {
  const config = repoConfig();
  const source = config.ok ? core.readSourceInfo(config.repo) : { ok: false, error: config.error };
  let running = null;
  try {
    running = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "standalone", "build-info.json"), "utf8"));
  } catch {
    /* unpackaged checkout run — the window says so via swappable below */
  }
  const swap = config.ok
    ? core.planSwap({ execPath: process.execPath, stagedApp: stagedAppPath(config.repo) })
    : { ok: false, error: config.error };
  return {
    source,
    running,
    building: inFlight !== null,
    swappable: swap.ok,
    swapError: swap.ok ? null : swap.error,
    logFile: logFilePath(),
  };
}

function stagedAppPath(repo) {
  return path.join(repo, "apps", "desktop", "release", "dev", "mac-arm64", "Telar Dev.app");
}

/**
 * Build → validate → confirm handoff → spawn the swap helper → quit. Every
 * early return leaves the running app exactly as it was; the helper is the
 * only thing that ever touches the installed bundle, and it restores
 * last-good on its own failures.
 */
async function startUpdate() {
  if (inFlight) return { ok: false, error: "An update is already building." };
  const config = repoConfig();
  if (!config.ok) return { ok: false, error: config.error };
  const repo = config.repo;
  const source = core.readSourceInfo(repo);
  if (!source.ok) return { ok: false, error: source.error };
  const swap = core.planSwap({ execPath: process.execPath, stagedApp: stagedAppPath(repo) });
  if (!swap.ok) return { ok: false, error: swap.error };

  // The deliberate moment: relaunching interrupts anything the app is doing.
  const choice = await dialog.showMessageBox(updateWindow, {
    type: "warning",
    buttons: ["Build && Update", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Update Telar Dev from ${source.branch} @ ${source.sha}${source.dirty ? " (includes uncommitted edits)" : ""}?`,
    detail:
      "The app keeps running while the update builds (typically a few minutes). " +
      "When the build is validated, Telar Dev quits and relaunches on the new build — " +
      "running agent turns are interrupted and unsaved edits in sessions may be lost. " +
      "If anything fails, the current build stays in place.",
  });
  if (choice.response !== 0) return { ok: false, error: "cancelled" };

  const env = core.cleanBuildEnv(process.env);
  const bunDir = core.resolveBunDir(env);
  if (!bunDir) return { ok: false, error: "bun was not found (looked in PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin)." };
  env.PATH = env.PATH ? `${bunDir}:${env.PATH}` : bunDir;

  emitStatus("building", `${source.branch} @ ${source.sha}${source.dirty ? "+dirty" : ""}`);
  emitLog(`[update ${new Date().toISOString()}] building from ${repo} (${source.branch} @ ${source.sha}${source.dirty ? ", dirty" : ""})`);

  const child = spawn("bash", [path.join(repo, "scripts", "package-desktop.sh"), "--dev"], { cwd: repo, env });
  inFlight = child;
  let buffered = "";
  const onData = (chunk) => {
    buffered += chunk.toString();
    let index;
    while ((index = buffered.indexOf("\n")) !== -1) {
      emitLog(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const code = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1)));
  inFlight = null;
  if (buffered) emitLog(buffered);
  if (code !== 0) {
    emitStatus("error", `build failed (exit ${code}) — the running app is untouched; see the log.`);
    emitLog(`[update] build failed with exit ${code}`);
    return { ok: false, error: `build failed (exit ${code})` };
  }

  const candidate = core.validateCandidate(swap.stagedApp);
  if (!candidate.ok) {
    emitStatus("error", candidate.error);
    emitLog(`[update] ${candidate.error}`);
    return { ok: false, error: candidate.error };
  }

  emitStatus("installing", `validated ${candidate.info.shortSha ?? ""} — quitting to swap; Telar Dev relaunches itself.`);
  emitLog(`[update] candidate validated; handing off to the swap helper and quitting`);
  const scriptPath = path.join(updatesDir(), "swap.sh");
  fs.writeFileSync(scriptPath, core.helperScript(), { mode: 0o755 });
  const helper = spawn(
    "bash",
    [scriptPath, String(process.pid), swap.stagedApp, swap.target, updatesDir(), logFilePath(), "open"],
    { env, detached: true, stdio: "ignore" },
  );
  helper.unref();
  // A short beat so the renderer paints the installing status before quit.
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

function openWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 760,
    height: 560,
    title: "Update Telar Dev",
    webPreferences: {
      preload: path.join(__dirname, "dev-update-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  updateWindow.loadFile(path.join(__dirname, "dev-update.html"));
  updateWindow.once("closed", () => {
    updateWindow = null;
  });
}

ipcMain.handle("telar:dev-update:state", () => currentState());
ipcMain.handle("telar:dev-update:start", () => startUpdate());

// Quit while a build is running: the build is OURS to stop — nothing else.
// The partially written staging dir is rebuilt from scratch next time.
app.on("before-quit", () => {
  if (inFlight) inFlight.kill("SIGTERM");
});

module.exports = { openWindow };
