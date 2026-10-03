const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { fork } = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");
const { DEV_BUILD, SMOKE } = require("./flags");
const { bundledPlaywrightMcpCli, nodeExecPath, resolveEngineJs } = require("./bundle-paths");
const { logShell, shellLogPath } = require("./shell-log");
const { HOST_TOKEN } = require("./ui-server");

const ENGINE_EXIT_LOCK_HELD = 3;

let mainWindowShown = false;
let startupFailureReported = false;

function reportStartupFailure(title, detail) {
  if (mainWindowShown || startupFailureReported) return;
  startupFailureReported = true;
  dialog.showErrorBox(title, detail);
}

function markMainWindowShown() {
  mainWindowShown = true;
}

let engineChild = null;
let engineDiscovery = null;
let discoveryReadAt = 0;

function engineLockOwnerPid(home) {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(home, "engine", "engine.lock"), "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const RESTART_DELAYS_MS = [0, 1_000, 5_000, 15_000, 30_000];
const STABLE_AFTER_MS = 60_000;
const STDERR_TAIL_CHARS = 8_192;
const STOPPED_PREFIX = "Telar engine stopped: ";
const ENGINE_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

let respawn = null;
let restartTimer = null;
let rapidExits = 0;
let startedAt = 0;
let lastRestart = null;

function exitReason(code, signal, stderr) {
  const lines = stderr.split("\n").map((line) => line.trim());
  const said = lines.findLast((line) => line.startsWith(STOPPED_PREFIX))?.slice(STOPPED_PREFIX.length)
    ?? lines.findLast((line) => line.includes("FATAL ERROR:"));
  if (said) return said.slice(0, 300);
  return signal ? `killed by ${signal}` : `exit code ${code}`;
}

function announceRestart(notice) {
  lastRestart = notice;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("telar:engine:restart", notice);
    } catch {
    }
  }
}

function lastEngineRestart() {
  return lastRestart;
}

function scheduleRestart(reason) {
  if (!respawn) return;
  rapidExits = Date.now() - startedAt >= STABLE_AFTER_MS ? 1 : rapidExits + 1;
  if (rapidExits > RESTART_DELAYS_MS.length) {
    logShell("error", `engine stopped ${rapidExits - 1} times in a row; not restarting it again`);
    announceRestart({ at: Date.now(), reason, restarted: false });
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (app.isQuitting || !respawn) return;
    try {
      respawn();
      logShell("info", "engine restarted");
      announceRestart({ at: Date.now(), reason, restarted: true });
    } catch (error) {
      logShell("error", `engine restart failed: ${error?.stack || error}`);
      announceRestart({ at: Date.now(), reason, restarted: false });
    }
  }, RESTART_DELAYS_MS[rapidExits - 1]);
}

function onEngineExit(home, code, signal, stderr = "") {
  engineChild = null;
  engineDiscovery = null;
  discoveryReadAt = 0;

  if (SMOKE || app.isQuitting) return;
  const reason = exitReason(code, signal, stderr);
  logShell("error", `engine exited (code=${code} signal=${signal}): ${reason}`);
  if (stderr.trim()) logShell("error", `engine stderr before it exited:\n${stderr.trimEnd()}`);

  if (mainWindowShown) {
    scheduleRestart(reason);
    return;
  }

  if (code === ENGINE_EXIT_LOCK_HELD && !startupFailureReported) {
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
    `The engine exited (${reason}) before Telar could open.\n\n` +
      `There is more in ${shellLogPath()}.`,
  );
  app.quit();
}

function engineLogPath() {
  return path.join(app.getPath("userData"), "engine.log");
}

function openEngineLog() {
  const file = engineLogPath();
  try {
    if (fs.statSync(file).size > ENGINE_LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
  }
  const log = fs.createWriteStream(file, { flags: "a" });
  log.on("error", () => {});
  log.write(`[${new Date().toISOString()}] engine starting\n`);
  return log;
}

function superviseEngine(home, spawn) {
  respawn = () => {
    const child = spawn();
    engineChild = child;
    startedAt = Date.now();
    let stderr = "";
    const log = openEngineLog();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    let settled = false;
    child.on("exit", (code, signal) => {
      const settle = () => {
        if (settled) return;
        settled = true;
        log.end(`[${new Date().toISOString()}] engine exited (code=${code} signal=${signal})\n`);
        onEngineExit(home, code, signal, stderr);
      };
      if (!child.stderr || child.stderr.readableEnded) return settle();
      setTimeout(settle, 250).unref?.();
      child.stderr.once("end", settle);
    });
    return child;
  };
  return respawn();
}

function startEngineChild(home, env) {
  if (env?.TELAR_HOME !== home) throw new Error("the engine child needs the env that names its store");
  const engineJs = resolveEngineJs();
  return superviseEngine(home, () => fork(engineJs, [], {
    cwd: path.dirname(engineJs),
    execPath: nodeExecPath(),

    execArgv: ["--require", path.join(__dirname, "..", "preload", "server-preload.js")],
    env: {
      ...env,
      TELAR_HOST_TOKEN: HOST_TOKEN,
      TELAR_PROCESS_TITLE: DEV_BUILD ? "telar-engine-dev" : "telar-engine",
      NODE_ENV: "production",

      ...(app.isPackaged && !process.env.TELAR_PLAYWRIGHT_MCP_BIN
        ? { TELAR_PLAYWRIGHT_MCP_BIN: bundledPlaywrightMcpCli() }
        : {}),
    },
    stdio: ["ignore", "inherit", "pipe", "ipc"],
  }));
}

const ENGINE_STOP_GRACE_MS = 5_000;

function stopChild(child, graceMs = ENGINE_STOP_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
    }
  });
}

function stopEngineChild() {
  respawn = null;
  clearTimeout(restartTimer);
  restartTimer = null;
  const child = engineChild;
  engineChild = null;
  return stopChild(child);
}

function engineDiscoveryFile(home) {
  return path.join(home, "engine", "engine.json");
}

function readDiscovery(discoveryFile) {
  try {
    return JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
  } catch {
    return null;
  }
}

function probeHealth(discovery, requireWorker, { resolve, retry }) {
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
}

function waitForEngine(home, { timeoutMs = 30_000, intervalMs = 150, requireWorker = false } = {}) {
  const discoveryFile = engineDiscoveryFile(home);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const discovery = readDiscovery(discoveryFile);
      if (discovery?.port && discovery?.token) probeHealth(discovery, requireWorker, { resolve, retry });
      else retry();
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`engine did not become ${requireWorker ? "healthy with a registered worker" : "healthy"} within ${timeoutMs}ms`));
      } else setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function rememberEngine(discovery) {
  engineDiscovery = discovery;
}

function currentEngineDiscovery(home) {
  if (!engineDiscovery && Date.now() - discoveryReadAt > 5_000) {
    discoveryReadAt = Date.now();
    engineDiscovery = readDiscovery(engineDiscoveryFile(home));
  }
  return engineDiscovery;
}

function postToEngine(home, routePath, body) {
  const discovery = currentEngineDiscovery(home);
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
  request.on("error", () => {
    if (engineDiscovery === discovery) engineDiscovery = null;
  });
  request.on("timeout", () => request.destroy());
  request.end(payload);
}

module.exports = {
  engineDiscoveryFile,
  lastEngineRestart,
  markMainWindowShown,
  onEngineExit,
  postToEngine,
  rememberEngine,
  reportStartupFailure,
  startEngineChild,
  stopChild,
  superviseEngine,
  stopEngineChild,
  waitForEngine,
};
